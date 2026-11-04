import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

const portId = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const calendarDate = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(value => {
 const date = new Date(`${value}T00:00:00+08:00`);
 return !Number.isNaN(date.getTime()) && new Date(+date + 8 * 3600000).toISOString().slice(0, 10) === value;
}, 'Use a valid calendar date (YYYY-MM-DD)');
const searchQuery = z.object({
 origin: portId,
 destination: portId,
 date: calendarDate,
 passengers: z.coerce.number().int().min(1).max(10).default(1),
}).strict().refine(v => v.origin !== v.destination, { path: ['destination'], message: 'Choose a different destination' });

// Use one repeatable-read snapshot for fares and inventory. No Redis cache is authoritative.
const sailingInclude = {
 vessel: { select: { id: true, name: true, operator: true, registration: true } },
 fares: { where: { category: 'REGULAR_ADULT' as const }, orderBy: { className: 'asc' as const } },
 inventory: { select: { state: true, seat: { select: { layout: { select: { className: true, vesselId: true } } } } } },
} satisfies Prisma.SailingInclude;
type InventorySailing = Prisma.SailingGetPayload<{ include: typeof sailingInclude }>;
export type Availability = 'AVAILABLE' | 'SOLD_OUT' | 'INSUFFICIENT_SEATS' | 'BOOKING_CLOSED' | 'FARE_UNAVAILABLE';
const openStatuses = new Set(['SCHEDULED', 'BOARDING', 'DELAYED']);
const portSelect = { id: true, name: true } as const;
function summarize(sailing: InventorySailing, passengers: number, now: Date, cutoffMinutes: number) {
 const open = openStatuses.has(sailing.status) && +sailing.departure > +now + cutoffMinutes * 60000;
 const counts = new Map<string, number>();
 for (const row of sailing.inventory) {
  if (row.seat.layout.vesselId !== sailing.vesselId) continue;
  const name = row.seat.layout.className;
  counts.set(name, (counts.get(name) ?? 0) + (row.state === 'AVAILABLE' ? 1 : 0));
 }
 // Include classes without fares: do not turn missing pricing into an invented free ticket.
 const names = [...new Set([...counts.keys(), ...sailing.fares.map(f => f.className)])].sort();
 const classes = names.map(name => {
  const seatsLeft = counts.get(name) ?? 0;
  const fare = sailing.fares.find(f => f.className === name);
  const availability: Availability = !open ? 'BOOKING_CLOSED' : seatsLeft === 0 ? 'SOLD_OUT' : !fare ? 'FARE_UNAVAILABLE' : seatsLeft < passengers ? 'INSUFFICIENT_SEATS' : 'AVAILABLE';
  return { name, seatsLeft, baseFareCentavos: fare?.baseCentavos ?? null, terminalFeeCentavos: fare?.terminalFeeCentavos ?? null,
   totalFareCentavos: fare ? fare.baseCentavos + fare.terminalFeeCentavos : null, availability, bookable: availability === 'AVAILABLE' };
 });
 const seatsLeft = [...counts.values()].reduce((sum, n) => sum + n, 0);
 const bookable = classes.some(c => c.bookable);
 const priced = classes.filter(c => c.totalFareCentavos !== null);
 const fareCandidates = bookable ? priced.filter(c => c.bookable) : priced;
 const fareFromCentavos = fareCandidates.length ? Math.min(...fareCandidates.map(c => c.totalFareCentavos!)) : null;
 const availability: Availability = !open ? 'BOOKING_CLOSED' : !seatsLeft ? 'SOLD_OUT' : bookable ? 'AVAILABLE' : priced.some(c => c.seatsLeft > 0) ? 'INSUFFICIENT_SEATS' : 'FARE_UNAVAILABLE';
 return { id: sailing.id, vessel: sailing.vessel, departure: sailing.departure.toISOString(), arrival: sailing.arrival.toISOString(),
  durationMinutes: Math.round((+sailing.arrival - +sailing.departure) / 60000), status: sailing.status, gate: sailing.gate, terminal: sailing.terminal,
  seatsLeft, urgency: seatsLeft > 0 && seatsLeft <= 12, fareFromCentavos, availability, bookable, classes };
}

export function registerSailingRoutes(app: FastifyInstance, db: PrismaClient, options: { now: () => Date; cutoffMinutes: number }) {
 app.get('/routes', async () => ({ routes: await db.route.findMany({
  select: { id: true, origin: { select: portSelect }, destination: { select: portSelect }, durationMinutes: true },
  orderBy: [{ origin: { name: 'asc' } }, { destination: { name: 'asc' } }],
 }) }));
 app.get('/sailings/search', async req => {
  const query = searchQuery.parse(req.query);
  const start = new Date(`${query.date}T00:00:00+08:00`);
  const end = new Date(+start + 86400000);
  return db.$transaction(async tx => {
   const ports = await tx.port.findMany({ where: { id: { in: [query.origin, query.destination] } }, select: portSelect });
   const origin = ports.find(p => p.id === query.origin), destination = ports.find(p => p.id === query.destination);
   if (!origin || !destination) throw Object.assign(new Error('Unknown origin or destination port'), { statusCode: 404 });
   const now = options.now();
   const sailings = await tx.sailing.findMany({
    where: { published: true, route: { originId: query.origin, destinationId: query.destination }, departure: { gte: start, lt: end } },
    include: sailingInclude, orderBy: [{ departure: 'asc' }, { id: 'asc' }],
   });
   return { origin, destination, date: query.date, passengers: query.passengers, timeZone: 'Asia/Manila',
    serverTime: now.toISOString(), bookingCutoffMinutes: options.cutoffMinutes,
    state: sailings.length ? 'SAILINGS' : 'NO_SAILINGS', sailings: sailings.map(s => summarize(s, query.passengers, now, options.cutoffMinutes)) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
 });
 app.get('/routes/popular', async () => {
  return db.$transaction(async tx => {
   const now = options.now();
   const routes = await tx.route.findMany({
    select: { id: true, origin: { select: portSelect }, destination: { select: portSelect }, durationMinutes: true },
    orderBy: { id: 'asc' },
   });
   // Pick one actual offer per route in PostgreSQL, instead of transferring a
   // year's worth of seat rows to the home-page process. EXISTS uses the
   // (sailingId, state) inventory index and needs just one available seat.
   const offers = await tx.$queryRaw<{ routeId: string; vesselName: string; departure: Date; arrival: Date; fare: number }[]>(Prisma.sql`
    SELECT DISTINCT ON (s."routeId") s."routeId", v.name AS "vesselName", s.departure, s.arrival,
      (f."baseCentavos"::bigint + f."terminalFeeCentavos"::bigint)::float8 AS fare
    FROM "Sailing" s
    JOIN "Vessel" v ON v.id = s."vesselId"
    JOIN "Fare" f ON f."sailingId" = s.id AND f.category = 'REGULAR_ADULT'
    WHERE s.published = true AND s.status IN ('SCHEDULED', 'BOARDING', 'DELAYED')
      AND s.departure > ${new Date(+now + options.cutoffMinutes * 60000)}
      AND s.departure < ${new Date(+now + 366 * 86400000)}
      AND EXISTS (
        SELECT 1 FROM "SailingSeat" inventory
        JOIN "Seat" seat ON seat.id = inventory."seatId"
        JOIN "VesselSeatLayout" layout ON layout.id = seat."layoutId"
        WHERE inventory."sailingId" = s.id AND inventory.state = 'AVAILABLE'
          AND layout."vesselId" = s."vesselId" AND layout."className" = f."className"
      )
    ORDER BY s."routeId", fare, s.departure, s.id, f."className"
   `);
   const byRoute = new Map(offers.map(offer => [offer.routeId, offer]));
   return { routes: routes.map(route => {
    const offer = byRoute.get(route.id);
    return { ...route, durationMinutes: offer ? Math.round((+offer.arrival - +offer.departure) / 60000) : route.durationMinutes,
     vesselName: offer?.vesselName ?? null, fareFromCentavos: offer?.fare ?? null, nextDeparture: offer?.departure.toISOString() ?? null };
   }) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
 });
}

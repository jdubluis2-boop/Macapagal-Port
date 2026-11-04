import type { FastifyInstance } from 'fastify';
import { Prisma, PassengerCategory, type User, type BookingStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { config } from './config.js';

const uuid = z.uuid();
const mobile = z.string().transform(v => v.replace(/[\s()-]/g, '')).pipe(z.string().regex(/^\+639\d{9}$/, 'Use +63 9XX XXX XXXX'));
const passengerSchema = z.object({
 fullName: z.string().trim().min(2).max(160), mobile,
 category: z.enum(PassengerCategory), age: z.number().int().min(0).max(120),
 gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']),
 emergencyContactName: z.string().trim().min(2).max(160), emergencyContactMobile: mobile,
});
const passengersSchema = z.array(passengerSchema).min(1).max(10);
const seatIdsSchema = z.array(z.string().min(1).max(200)).min(1).max(10).refine(ids => new Set(ids).size === ids.length, 'Choose distinct seats');
const createSchema = z.object({ sailingId: uuid, seatIds: seatIdsSchema, passengers: passengersSchema }).refine(v => v.seatIds.length === v.passengers.length, 'Choose exactly one seat per passenger');
type PassengerInput = z.infer<typeof passengerSchema>;
const editable: BookingStatus[] = ['DRAFT', 'SEAT_HELD', 'PAYMENT_FAILED', 'HOLD_EXPIRED'];
const activeStatuses: BookingStatus[] = ['SEAT_HELD', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'COUNTER_PENDING'];
const fail = (code: number, message: string) => Object.assign(new Error(message), { statusCode: code });
export const seatKey = (sailingId: string, seatId: string) => `seat:${sailingId}:${seatId}`;
// Check every key before writing any key. Existing keys of this booking are retained.
const acquireLua = `
for i,key in ipairs(KEYS) do
 local owner = redis.call('GET', key)
 if owner and owner ~= ARGV[1] then return 0 end
end
for i,key in ipairs(KEYS) do redis.call('SET', key, ARGV[1], 'EX', ARGV[2]) end
return 1`;
const releaseLua = `for i,key in ipairs(KEYS) do if redis.call('GET',key) == ARGV[1] then redis.call('DEL',key) end end return 1`;
export async function releaseSeatKeys(ctx: AppContext, sailingId: string, seatIds: string[], bookingId: string) {
 if (seatIds.length) await ctx.redis.eval(releaseLua, seatIds.length, ...seatIds.map(id => seatKey(sailingId, id)), bookingId);
}
async function acquire(ctx: AppContext, sailingId: string, seatIds: string[], bookingId: string, expiresAt: Date) {
 const ttl = Math.max(1, Math.ceil((+expiresAt - +ctx.now()) / 1000));
 const result = await ctx.redis.eval(acquireLua, seatIds.length, ...seatIds.map(id => seatKey(sailingId, id)), bookingId, ttl);
 if (Number(result) !== 1) throw fail(409, 'One or more seats are no longer available. Refresh the seat map.');
}
async function rateLimit(ctx: AppContext, userId: string) {
 const key = `hold-rate:${userId}:${Math.floor(+ctx.now() / 60000)}`;
 const count = await ctx.redis.eval("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],120) end;return n", 1, key);
 if (Number(count) > 10) throw fail(429, 'Too many hold requests. Please wait a minute.');
}
export async function broadcastSeatChanges(ctx: AppContext, sailingId: string) {
 const inventory = await ctx.db.sailingSeat.findMany({ where: { sailingId }, select: { seatId: true, state: true, version: true } });
 for (const seat of inventory) ctx.emit(`sailing:${sailingId}`, 'seat.updated', seat);
 const sailing = await ctx.db.sailing.findUnique({ where: { id: sailingId }, include: { route: true } });
 if (sailing) {
  const date = new Date(+sailing.departure + 8 * 3600000).toISOString().slice(0, 10);
  ctx.emit(`route:${sailing.route.originId}:${sailing.route.destinationId}:${date}`, 'sailing.updated', { sailingId, seatsLeft: inventory.filter(s => s.state === 'AVAILABLE').length, status: sailing.status });
 }
}
const detailInclude = {
 sailing: { include: { vessel: true, route: { include: { origin: true, destination: true } } } },
 passengers: { orderBy: { position: 'asc' as const } },
 holds: { include: { seat: { include: { layout: true } } }, orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
 attempts: { orderBy: { attemptNumber: 'desc' as const } }, payments: true,
 tickets: { include: { scan: true } }, refunds: { orderBy: { refundNumber: 'desc' as const } },
} satisfies Prisma.BookingInclude;
export async function getBookingDetail(ctx: AppContext, id: string, user?: User) {
 const booking = await ctx.db.booking.findUnique({ where: { id }, include: detailInclude });
 if (!booking || (user && booking.userId !== user.id)) throw fail(404, 'Booking not found');
 return { ...booking, passengers: booking.passengers.map(({ detailsCiphertext, ...passenger }) => ({ ...passenger, ...ctx.decrypt(detailsCiphertext) })) };
}
async function lockBooking(tx: Prisma.TransactionClient, id: string) {
 const existing = await tx.booking.findUnique({ where: { id }, select: { sailingId: true } });
 if (!existing) throw fail(404, 'Booking not found');
 // Every business writer locks sailing -> booking -> inventory in this order.
 await tx.$queryRaw`SELECT id FROM "Sailing" WHERE id=${existing.sailingId}::uuid FOR UPDATE`;
 const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Booking" WHERE id=${id}::uuid FOR UPDATE`;
 if (!rows.length) throw fail(404, 'Booking not found');
 const booking = await tx.booking.findUniqueOrThrow({ where: { id }, include: { payments: { select: { id: true } } } });
 if (booking.sailingId !== existing.sailingId) throw fail(409, 'Sailing changed. Refresh your booking and retry.');
 return booking;
}
async function checkCap(tx: Prisma.TransactionClient, userId: string, ip: string, except?: string) {
 await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId}::uuid FOR UPDATE`;
 await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hold-ip:${ip}`}))`;
 const where = { status: { in: activeStatuses }, holds: { some: { releasedAt: null } }, ...(except ? { id: { not: except } } : {}) };
 if (await tx.booking.count({ where: { ...where, userId } }) >= config.MAX_ACTIVE_HOLDS_PER_USER) throw fail(429, 'You already have the maximum number of active bookings. Release a hold first.');
 if (await tx.booking.count({ where: { ...where, holdIp: ip } }) >= config.MAX_ACTIVE_HOLDS_PER_IP) throw fail(429, 'Too many active bookings from this connection. Release a hold first.');
}
async function quote(tx: Prisma.TransactionClient, sailingId: string, seatIds: string[], passengers: PassengerInput[], now: Date) {
 await tx.$queryRaw`SELECT id FROM "Sailing" WHERE id=${sailingId}::uuid FOR UPDATE`;
 const sailing = await tx.sailing.findUnique({ where: { id: sailingId }, include: { fares: true } });
 if (!sailing || !sailing.published) throw fail(404, 'Sailing not found');
 if (!['SCHEDULED', 'BOARDING', 'DELAYED'].includes(sailing.status) || +sailing.departure <= +now + config.BOOKING_CUTOFF_MINUTES * 60000) throw fail(409, 'Online booking is closed for this sailing');
 const seats = await tx.seat.findMany({ where: { id: { in: seatIds }, layout: { vesselId: sailing.vesselId } }, include: { layout: true } });
 if (seats.length !== seatIds.length) throw fail(400, 'Choose seats from this vessel');
 const classes = new Set(seats.map(s => s.layout.className));
 if (classes.size !== 1) throw fail(400, 'All passengers in one booking must use the same class');
 let totalCentavos = 0, terminalFeeCentavos = 0;
 for (const passenger of passengers) {
  const fare = sailing.fares.find(f => f.className === seats[0].layout.className && f.category === passenger.category);
  if (!fare) throw fail(409, `No fare is published for ${passenger.category} in this class`);
  totalCentavos += fare.baseCentavos + fare.terminalFeeCentavos;
  terminalFeeCentavos += fare.terminalFeeCentavos;
 }
 return { sailing, seats, totalCentavos, terminalFeeCentavos };
}
function passengerData(ctx: AppContext, bookingId: string, seatIds: string[], passengers: PassengerInput[]) {
 return passengers.map((p, position) => ({ bookingId, seatId: seatIds[position], position, category: p.category, age: p.age, gender: p.gender, detailsCiphertext: ctx.encrypt({ fullName: p.fullName, mobile: p.mobile, emergencyContactName: p.emergencyContactName, emergencyContactMobile: p.emergencyContactMobile }) }));
}
async function scheduleExpiry(ctx: AppContext, bookingId: string, expiresAt: Date) {
 await ctx.jobs.add('hold.expire', { bookingId }, { delay: Math.max(0, +expiresAt - +ctx.now()), removeOnComplete: true, attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
}
async function markExpired(ctx: AppContext, id: string) {
 const changed = await ctx.db.$transaction(async tx => {
  const booking = await lockBooking(tx, id);
  const deadline = booking.status === 'COUNTER_PENDING' ? booking.counterDeadline : booking.holdExpiresAt;
  if (!deadline || +deadline > +ctx.now() || !['SEAT_HELD', 'PAYMENT_FAILED', 'COUNTER_PENDING'].includes(booking.status)) return null;
  const holds = await tx.seatHold.findMany({ where: { bookingId: id, releasedAt: null } });
  const now = ctx.now();
  await tx.seatHold.updateMany({ where: { bookingId: id, releasedAt: null }, data: { releasedAt: now } });
  await tx.sailingSeat.updateMany({ where: { sailingId: booking.sailingId, seatId: { in: holds.map(h => h.seatId) }, state: { in: ['HELD', 'PENDING_PAYMENT'] } }, data: { state: 'AVAILABLE', version: { increment: 1 } } });
  await tx.booking.update({ where: { id }, data: { status: booking.status === 'COUNTER_PENDING' ? 'EXPIRED_UNPAID' : 'HOLD_EXPIRED' } });
  if (booking.status === 'COUNTER_PENDING') await tx.paymentAttempt.updateMany({ where: { bookingId: id, method: 'COUNTER', status: 'PENDING' }, data: { status: 'FAILED', finalizedAt: now } });
  await tx.auditLog.create({ data: { actorId: booking.userId, action: 'HOLD_EXPIRED', entityId: id, metadata: {} } });
  const inventory = await tx.sailingSeat.findMany({ where: { sailingId: booking.sailingId, seatId: { in: holds.map(h => h.seatId) } }, select: { seatId: true, state: true, version: true } });
  return { ...booking, seatIds: holds.map(h => h.seatId), inventory };
 }).catch(error => { if ((error as { statusCode?: number }).statusCode === 404) return null;throw error; });
 if (changed) {
  await releaseSeatKeys(ctx, changed.sailingId, changed.seatIds, id).catch(() => {});
  await broadcastSeatChanges(ctx, changed.sailingId);
  for (const seat of changed.inventory) ctx.emit(`sailing:${changed.sailingId}`, 'seat.released', seat);
  ctx.emit(`user:${changed.userId}`, 'hold.expired', { bookingId: id, serverTime: ctx.now().toISOString() });
 }
 return changed;
}
export async function sweepBookings(ctx: AppContext, userId?: string) {
 const rows = await ctx.db.booking.findMany({ where: { ...(userId ? { userId } : {}), OR: [
  { status: { in: ['SEAT_HELD', 'PAYMENT_FAILED'] }, holdExpiresAt: { lte: ctx.now() } },
  { status: 'COUNTER_PENDING', counterDeadline: { lte: ctx.now() } },
 ] }, select: { id: true }, take: 200 });
 for (const row of rows) await markExpired(ctx, row.id);
 const expiring = await ctx.db.booking.findMany({ where: { ...(userId ? { userId } : {}), status: 'SEAT_HELD', holdExpiresAt: { gt: ctx.now(), lte: new Date(+ctx.now() + 120000) } }, select: { id: true, userId: true, holdExpiresAt: true } });
 for (const booking of expiring) ctx.emit(`user:${booking.userId}`, 'hold.expiring', { bookingId: booking.id, holdExpiresAt: booking.holdExpiresAt, serverTime: ctx.now().toISOString() });
}
export async function processBookingJob(ctx: AppContext, job: { name: string; data: { bookingId?: string } }) {
 if (job.name === 'hold.expire' && job.data.bookingId) await markExpired(ctx, job.data.bookingId);
 if (job.name === 'hold.sweep') await sweepBookings(ctx);
}

export function registerBookingRoutes(app: FastifyInstance, ctx: AppContext) {
 app.get('/sailings/:id/seats', async req => {
  const id = uuid.parse((req.params as { id: string }).id);
  const sailing = await ctx.db.sailing.findUnique({ where: { id }, include: { vessel: true, route: { include: { origin: true, destination: true } }, fares: true } });
  if (!sailing?.published) throw fail(404, 'Sailing not found');
  const rows = await ctx.db.sailingSeat.findMany({ where: { sailingId: id, seat: { layout: { vesselId: sailing.vesselId } } }, include: { seat: { include: { layout: true } } }, orderBy: { seatId: 'asc' } });
  return { sailing, serverTime: ctx.now().toISOString(), seats: rows.map(row => ({ id: row.seatId, label: row.seat.label, className: row.seat.layout.className, deck: row.seat.layout.deck, row: row.seat.row, column: row.seat.column, state: row.state, version: row.version })), fares: sailing.fares };
 });
 app.post('/bookings', async req => {
  const user = await ctx.verified(req);
  const input = createSchema.parse(req.body);
  await rateLimit(ctx, user.id);
  await sweepBookings(ctx, user.id);
  const id = randomUUID();
  const expiresAt = new Date(+ctx.now() + config.SEAT_HOLD_TTL_SECONDS * 1000);
  let acquired = false;
  try {
   await ctx.db.$transaction(async tx => {
    await checkCap(tx, user.id, req.ip);
    const pricing = await quote(tx, input.sailingId, input.seatIds, input.passengers, ctx.now());
    const locked = await tx.$queryRaw<{ seatId: string; state: string }[]>(Prisma.sql`SELECT "seatId",state FROM "SailingSeat" WHERE "sailingId"=${input.sailingId}::uuid AND "seatId" IN (${Prisma.join(input.seatIds)}) ORDER BY "seatId" FOR UPDATE SKIP LOCKED`);
    if (locked.length !== input.seatIds.length || locked.some(s => s.state !== 'AVAILABLE')) throw fail(409, 'One or more seats are no longer available. Refresh the seat map.');
    await acquire(ctx, input.sailingId, input.seatIds, id, expiresAt); acquired = true;
    await tx.booking.create({ data: { id, userId: user.id, sailingId: input.sailingId, status: 'SEAT_HELD', totalCentavos: pricing.totalCentavos, terminalFeeCentavos: pricing.terminalFeeCentavos, holdExpiresAt: expiresAt, holdIp: req.ip } });
    await tx.bookingPassenger.createMany({ data: passengerData(ctx, id, input.seatIds, input.passengers) });
    await tx.seatHold.createMany({ data: input.seatIds.map((seatId, n) => ({ bookingId: id, sailingId: input.sailingId, seatId, expiresAt, createdAt: new Date(+ctx.now() + n) })) });
    await tx.sailingSeat.updateMany({ where: { sailingId: input.sailingId, seatId: { in: input.seatIds } }, data: { state: 'HELD', version: { increment: 1 } } });
    await tx.auditLog.create({ data: { actorId: user.id, action: 'SEATS_HELD', entityId: id, metadata: { seatIds: input.seatIds } } });
   }, { timeout: 15000 });
  } catch (error) {
   if (acquired) await releaseSeatKeys(ctx, input.sailingId, input.seatIds, id).catch(() => {});
   if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw fail(409, 'Seat ownership changed. Refresh the seat map and choose again.');
   throw error;
  }
  await scheduleExpiry(ctx, id, expiresAt).catch(() => {}); // The database sweeper remains the expiry safety net.
  await broadcastSeatChanges(ctx, input.sailingId);
  ctx.emit(`user:${user.id}`, 'hold.tick', { bookingId: id, holdExpiresAt: expiresAt, serverTime: ctx.now().toISOString() });
  return { booking: await getBookingDetail(ctx, id, user), serverTime: ctx.now().toISOString() };
 });
 app.get('/bookings', async req => {
  const user = await ctx.auth(req);
  const rows = await ctx.db.booking.findMany({ where: { userId: user.id }, select: { id: true }, orderBy: { createdAt: 'desc' } });
  for (const row of rows) await markExpired(ctx, row.id);
  return { bookings: await Promise.all(rows.map(row => getBookingDetail(ctx, row.id, user))), serverTime: ctx.now().toISOString() };
 });
 app.get('/bookings/:id', async req => {
  const user = await ctx.auth(req), id = uuid.parse((req.params as { id: string }).id);
  await getBookingDetail(ctx, id, user);
  await markExpired(ctx, id);
  return { booking: await getBookingDetail(ctx, id, user), serverTime: ctx.now().toISOString() };
 });
 app.post('/bookings/:id/release', async req => {
  const user = await ctx.verified(req), id = uuid.parse((req.params as { id: string }).id);
  const released = await ctx.db.$transaction(async tx => {
   const booking = await lockBooking(tx, id);
   if (booking.userId !== user.id) throw fail(404, 'Booking not found');
   if (booking.payments.length) throw fail(409, 'This booking has settled money. Resolve its payment or refund exception before changing it.');
   if (!editable.includes(booking.status)) throw fail(409, 'This booking cannot release its seats');
   const holds = await tx.seatHold.findMany({ where: { bookingId: id, releasedAt: null } });
   await tx.seatHold.updateMany({ where: { bookingId: id, releasedAt: null }, data: { releasedAt: ctx.now() } });
   await tx.sailingSeat.updateMany({ where: { sailingId: booking.sailingId, seatId: { in: holds.map(h => h.seatId) }, state: 'HELD' }, data: { state: 'AVAILABLE', version: { increment: 1 } } });
   await tx.booking.update({ where: { id }, data: { status: 'DRAFT', holdExpiresAt: null } });
   const inventory = await tx.sailingSeat.findMany({ where: { sailingId: booking.sailingId, seatId: { in: holds.map(h => h.seatId) } }, select: { seatId: true, state: true, version: true } });
   return { sailingId: booking.sailingId, seatIds: holds.map(h => h.seatId), inventory };
  });
  await releaseSeatKeys(ctx, released.sailingId, released.seatIds, id).catch(() => {});
  await broadcastSeatChanges(ctx, released.sailingId);
  for (const seat of released.inventory) ctx.emit(`sailing:${released.sailingId}`, 'seat.released', seat);
  return { booking: await getBookingDetail(ctx, id, user), serverTime: ctx.now().toISOString() };
 });
 app.post('/bookings/:id/extend', async req => {
  const user = await ctx.verified(req), id = uuid.parse((req.params as { id: string }).id);
  await getBookingDetail(ctx, id, user); await markExpired(ctx, id);
  const expiry = await ctx.db.$transaction(async tx => {
   const booking = await lockBooking(tx, id);
   if (booking.userId !== user.id) throw fail(404, 'Booking not found');
   if (booking.payments.length) throw fail(409, 'This booking has settled money. Resolve its payment or refund exception before changing it.');
   if (booking.status !== 'SEAT_HELD' || !booking.holdExpiresAt || +booking.holdExpiresAt <= +ctx.now()) throw fail(409, 'Your seat hold has expired or payment has started');
   if (booking.extensionUsed) throw fail(409, 'This booking has already used its one extension');
   const expiresAt = new Date(+booking.holdExpiresAt + config.SEAT_HOLD_EXTENSION_SECONDS * 1000);
   const holds = await tx.seatHold.findMany({ where: { bookingId: id, releasedAt: null } });
   if (!holds.length) throw fail(409, 'Your seat hold has expired');
   await acquire(ctx, booking.sailingId, holds.map(h => h.seatId), id, expiresAt);
   await tx.booking.update({ where: { id }, data: { extensionUsed: true, holdExpiresAt: expiresAt } });
   await tx.seatHold.updateMany({ where: { bookingId: id, releasedAt: null }, data: { expiresAt } });
   return expiresAt;
  });
  await scheduleExpiry(ctx, id, expiry).catch(() => {});
  return { booking: await getBookingDetail(ctx, id, user), serverTime: ctx.now().toISOString() };
 });
 app.post('/bookings/:id/seats', async req => {
  const user = await ctx.verified(req), id = uuid.parse((req.params as { id: string }).id);
  const { seatIds } = z.object({ seatIds: seatIdsSchema }).parse(req.body);
  await rateLimit(ctx, user.id);
  await getBookingDetail(ctx, id, user); await markExpired(ctx, id);
  let rollbackNew: string[] = [], sailingId = '';
  let released: string[] = [], expiresAt = ctx.now();
  try {
   await ctx.db.$transaction(async tx => {
    await checkCap(tx, user.id, req.ip, id);
    const booking = await lockBooking(tx, id);
    if (booking.userId !== user.id) throw fail(404, 'Booking not found');
   if (booking.payments.length) throw fail(409, 'This booking has settled money. Resolve its payment or refund exception before changing it.');
    if (!editable.includes(booking.status)) throw fail(409, 'Seats cannot be changed after payment starts');
    const passengers = await tx.bookingPassenger.findMany({ where: { bookingId: id }, orderBy: { position: 'asc' } });
    if (passengers.length !== seatIds.length) throw fail(400, 'Choose exactly one seat per passenger');
    const values = passengers.map(p => passengerSchema.parse({ ...p, ...ctx.decrypt(p.detailsCiphertext) }));
    const pricing = await quote(tx, booking.sailingId, seatIds, values, ctx.now());
    const current = await tx.seatHold.findMany({ where: { bookingId: id, releasedAt: null } });
    const currentIds = current.map(h => h.seatId);
    const locked = await tx.$queryRaw<{ seatId: string; state: string }[]>(Prisma.sql`SELECT "seatId",state FROM "SailingSeat" WHERE "sailingId"=${booking.sailingId}::uuid AND "seatId" IN (${Prisma.join([...new Set([...seatIds, ...currentIds])])}) ORDER BY "seatId" FOR UPDATE SKIP LOCKED`);
    if (locked.length !== new Set([...seatIds, ...currentIds]).size || locked.some(row => seatIds.includes(row.seatId) && row.state !== 'AVAILABLE' && !(row.state === 'HELD' && currentIds.includes(row.seatId)))) throw fail(409, 'Your new seat selection is no longer available');
    expiresAt = booking.holdExpiresAt && +booking.holdExpiresAt > +ctx.now() && booking.status !== 'HOLD_EXPIRED' ? booking.holdExpiresAt : new Date(+ctx.now() + config.SEAT_HOLD_TTL_SECONDS * 1000);
    sailingId = booking.sailingId; rollbackNew = seatIds.filter(seatId => !currentIds.includes(seatId));
    await acquire(ctx, sailingId, seatIds, id, expiresAt);
    released = currentIds.filter(seatId => !seatIds.includes(seatId));
    await tx.seatHold.updateMany({ where: { bookingId: id, releasedAt: null, seatId: { in: released } }, data: { releasedAt: ctx.now() } });
    await tx.sailingSeat.updateMany({ where: { sailingId, seatId: { in: released } }, data: { state: 'AVAILABLE', version: { increment: 1 } } });
    for (let n = 0; n < seatIds.length; n++) if (!currentIds.includes(seatIds[n])) await tx.seatHold.create({ data: { bookingId: id, sailingId, seatId: seatIds[n], expiresAt, createdAt: new Date(+ctx.now() + n) } });
    await tx.sailingSeat.updateMany({ where: { sailingId, seatId: { in: seatIds } }, data: { state: 'HELD', version: { increment: 1 } } });
    for (let n = 0; n < passengers.length; n++) await tx.bookingPassenger.update({ where: { id: passengers[n].id }, data: { seatId: seatIds[n], position: n } });
    await tx.booking.update({ where: { id }, data: { status: 'SEAT_HELD', holdExpiresAt: expiresAt, holdIp: req.ip, totalCentavos: pricing.totalCentavos, terminalFeeCentavos: pricing.terminalFeeCentavos } });
   }, { timeout: 15000 });
  } catch (error) {
   if (rollbackNew.length && sailingId) await releaseSeatKeys(ctx, sailingId, rollbackNew, id).catch(() => {});
   if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw fail(409, 'Seat ownership changed. Refresh the seat map and choose again.');
   throw error;
  }
  await releaseSeatKeys(ctx, sailingId, released, id).catch(() => {});
  await scheduleExpiry(ctx, id, expiresAt).catch(() => {});
  await broadcastSeatChanges(ctx, sailingId);
  return { booking: await getBookingDetail(ctx, id, user), serverTime: ctx.now().toISOString() };
 });
 app.post('/bookings/:id/passengers', async req => {
  const user = await ctx.verified(req), id = uuid.parse((req.params as { id: string }).id);
  const { passengers } = z.object({ passengers: passengersSchema }).parse(req.body);
  await getBookingDetail(ctx, id, user); await markExpired(ctx, id);
  await ctx.db.$transaction(async tx => {
   const booking = await lockBooking(tx, id);
   if (booking.userId !== user.id) throw fail(404, 'Booking not found');
   if (booking.payments.length) throw fail(409, 'This booking has settled money. Resolve its payment or refund exception before changing it.');
   if (!editable.includes(booking.status)) throw fail(409, 'Passenger details cannot be changed after payment starts');
   const existing = await tx.bookingPassenger.findMany({ where: { bookingId: id }, orderBy: { position: 'asc' } });
   if (existing.length !== passengers.length || existing.some(p => !p.seatId)) throw fail(400, 'Keep one passenger per selected seat');
   const seatIds = existing.map(p => p.seatId!);
   // Expired bookings retain edited details; they must reacquire seats and re-quote before paying.
   const seats = await tx.seat.findMany({ where: { id: { in: seatIds } }, include: { layout: true } });
   const fares = await tx.fare.findMany({ where: { sailingId: booking.sailingId } });
   let totalCentavos = 0, terminalFeeCentavos = 0;
   for (let n = 0; n < passengers.length; n++) {
    const fare = fares.find(f => f.category === passengers[n].category && f.className === seats.find(s => s.id === seatIds[n])?.layout.className);
    if (!fare) throw fail(409, 'No fare is published for this passenger category');
    totalCentavos += fare.baseCentavos + fare.terminalFeeCentavos; terminalFeeCentavos += fare.terminalFeeCentavos;
    const data = passengerData(ctx, id, seatIds, passengers)[n];
    await tx.bookingPassenger.update({ where: { id: existing[n].id }, data: { category: data.category, age: data.age, gender: data.gender, detailsCiphertext: data.detailsCiphertext } });
   }
   await tx.booking.update({ where: { id }, data: { totalCentavos, terminalFeeCentavos } });
  });
  const booking = await getBookingDetail(ctx, id, user);
  return { booking, holdExpired: booking.status === 'HOLD_EXPIRED', serverTime: ctx.now().toISOString() };
 });
}

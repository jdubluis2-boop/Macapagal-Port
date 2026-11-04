import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { SignJWT, jwtVerify } from 'jose';
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { config } from './config.js';

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const idParams = z.object({ id: z.uuid() });
const detailInclude = {
 passenger: true,
 scan: true,
 booking: { include: { holds: { include: { seat: { include: { layout: true } } } }, sailing: { include: { vessel: true, route: { include: { origin: true, destination: true } } } }, payments: { orderBy: { paidAt: 'asc' as const } } } },
} satisfies Prisma.TicketInclude;
type TicketDetail = Prisma.TicketGetPayload<{ include: typeof detailInclude }>;

/** Called only in the verified-payment transaction. The passenger unique index makes retries harmless. */
export async function issueTickets(tx: Prisma.TransactionClient, bookingId: string): Promise<void> {
 const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { passengers: true, holds: { where: { releasedAt: null }, include: { seat: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
 if (!['PAID', 'TICKET_ISSUED'].includes(booking.status)) throw fail(409, 'A ticket requires a verified payment');
 const passengers = [...booking.passengers].sort((a, b) => ((a as typeof a & { position?: number }).position ?? 0) - ((b as typeof b & { position?: number }).position ?? 0) || a.id.localeCompare(b.id));
 if (booking.holds.length !== passengers.length) throw fail(409, 'Paid booking does not own all passenger seats');
 for (let i = 0; i < passengers.length; i++) {
  const passenger = passengers[i];
  const explicitSeat = (passenger as typeof passenger & { seatId?: string | null }).seatId;
  const hold = explicitSeat ? booking.holds.find(h => h.seatId === explicitSeat) : booking.holds[i];
  if (!hold) throw fail(409, 'Passenger seat assignment is missing');
  await tx.ticket.upsert({ where: { passengerId: passenger.id }, create: { bookingId, passengerId: passenger.id, seatLabel: hold.seat.label }, update: {} });
 }
 await tx.booking.update({ where: { id: bookingId }, data: { status: 'TICKET_ISSUED' } });
}

export async function ticketQrToken(ticket: { id: string; version: number; seatLabel: string; booking: { reference: string; sailingId: string; sailing: { arrival: Date } } }) {
 return new SignJWT({ ticketId: ticket.id, bookingRef: ticket.booking.reference, sailingId: ticket.booking.sailingId, seat: ticket.seatLabel, version: ticket.version })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('macapagal-boarding').setAudience('macapagal-gate')
  .setIssuedAt().setExpirationTime(Math.floor((+ticket.booking.sailing.arrival + 86400000) / 1000))
  .sign(new TextEncoder().encode(config.JWT_SECRET));
}
export async function ticketResponse(ctx: AppContext, ticket: TicketDetail) {
 const passenger = { ...ctx.decrypt(ticket.passenger.detailsCiphertext), id: ticket.passenger.id, category: ticket.passenger.category, age: ticket.passenger.age, gender: ticket.passenger.gender };
 const qrToken = ticket.status === 'TICKET_ISSUED' && ticket.booking.status === 'TICKET_ISSUED' ? await ticketQrToken(ticket) : null;
 const assignment=ticket.booking.holds.find(hold=>hold.seatId===ticket.passenger.seatId)??ticket.booking.holds.find(hold=>hold.seat.label===ticket.seatLabel);
 return { className:assignment?.seat.layout.className??null, id: ticket.id, status: ticket.status, seatLabel: ticket.seatLabel, version: ticket.version, issuedAt: ticket.issuedAt, scan: ticket.scan,
  passenger, sailing: ticket.booking.sailing,
  booking: { id: ticket.booking.id, reference: ticket.booking.reference, status: ticket.booking.status, totalCentavos: ticket.booking.totalCentavos, terminalFeeCentavos: ticket.booking.terminalFeeCentavos },
  qrToken, qrDataUrl: qrToken ? await QRCode.toDataURL(qrToken, { errorCorrectionLevel: 'M', margin: 2, width: 320 }) : null };
}
async function ownedTicket(ctx: AppContext, id: string, userId: string) {
 const ticket = await ctx.db.ticket.findFirst({ where: { id, booking: { userId } }, include: detailInclude });
 if (!ticket) throw fail(404, 'Ticket not found');
 return ticket;
}
export function createPdf(render: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
 return new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', margin: 44 });
  const chunks: Buffer[] = [];
  doc.on('data', chunk => chunks.push(Buffer.from(chunk)));
  doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks)));
  try { render(doc); doc.end(); } catch (error) { reject(error); doc.end(); }
 });
}
const money = (value: number) => `PHP ${(value / 100).toFixed(2)}`;
export function registerTicketRoutes(app: FastifyInstance, ctx: AppContext) {
 app.get('/tickets', async req => {
  const user = await ctx.auth(req);
  const tickets = await ctx.db.ticket.findMany({ where: { booking: { userId: user.id } }, include: detailInclude, orderBy: { issuedAt: 'desc' } });
  return { tickets: await Promise.all(tickets.map(t => ticketResponse(ctx, t))), serverTime: ctx.now().toISOString() };
 });
 app.get('/tickets/:id', async req => {
  const user = await ctx.auth(req), { id } = idParams.parse(req.params);
  return { ticket: await ticketResponse(ctx, await ownedTicket(ctx, id, user.id)), serverTime: ctx.now().toISOString() };
 });
 app.get('/tickets/:id/pdf', async (req, reply) => {
  const user = await ctx.auth(req), { id } = idParams.parse(req.params);
  const ticket = await ownedTicket(ctx, id, user.id);
  const passenger = ctx.decrypt(ticket.passenger.detailsCiphertext);
  const assignment=ticket.booking.holds.find(hold=>hold.seatId===ticket.passenger.seatId)??ticket.booking.holds.find(hold=>hold.seat.label===ticket.seatLabel);
  const token = ticket.status === 'TICKET_ISSUED' && ticket.booking.status === 'TICKET_ISSUED' ? await ticketQrToken(ticket) : null;
  const qr = token ? await QRCode.toBuffer(token, { margin: 2, width: 280 }) : null;
  const pdf = await createPdf(doc => {
   doc.fontSize(20).text('MACAPAGAL PORT').fontSize(14).text('Passenger boarding pass').moveDown();
   doc.fontSize(11).text(`Reference: ${ticket.booking.reference}`).text(`Status: ${ticket.status}`).text(`Passenger: ${passenger.fullName ?? passenger.name ?? 'Passenger'}`)
    .text(`Vessel: ${ticket.booking.sailing.vessel.name}`).text(`Route: ${ticket.booking.sailing.route.origin.name} to ${ticket.booking.sailing.route.destination.name}`)
    .text(`Departure: ${ticket.booking.sailing.departure.toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} (Philippine time)`)
    .text(`Seat: ${ticket.seatLabel}; Class: ${assignment?.seat.layout.className??'See booking'}`).text(`${ticket.booking.sailing.gate}, ${ticket.booking.sailing.terminal}`)
    .text(`Booking total: ${money(ticket.booking.totalCentavos)}; terminal fee ${money(ticket.booking.terminalFeeCentavos)} already included.`)
    .text(`Emergency contact: ${passenger.emergencyContactName ?? ''} ${passenger.emergencyContactMobile ?? ''}`).moveDown();
   if (qr) doc.image(qr, { width: 200 }); else doc.fontSize(18).text('INVALID FOR BOARDING');
   doc.moveDown().fontSize(10).text('Arrive 2 hours before departure. Bring valid government ID. Baggage allowance: 20 kg. Helpdesk daily 5:00 AM-11:00 PM.');
  });
  return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${ticket.booking.reference}-${ticket.seatLabel}.pdf"`).send(pdf);
 });
 app.get('/bookings/:id/invoice.pdf', async (req, reply) => {
  const user = await ctx.auth(req), { id } = idParams.parse(req.params);
  const booking = await ctx.db.booking.findFirst({ where: { id, userId: user.id }, include: { payments: true, refunds: true, sailing: { include: { vessel: true, route: { include: { origin: true, destination: true } } } } } });
  if (!booking) throw fail(404, 'Booking not found');
  if (!booking.payments.length) throw fail(409, 'A receipt is available only after confirmed payment');
  const pdf = await createPdf(doc => {
   doc.fontSize(20).text('MACAPAGAL PORT').fontSize(14).text('Payment receipt').moveDown().fontSize(11)
    .text(`Booking: ${booking.reference}`).text(`Vessel: ${booking.sailing.vessel.name}`)
    .text(`Route: ${booking.sailing.route.origin.name} to ${booking.sailing.route.destination.name}`)
    .text(`Base fare: ${money(booking.totalCentavos - booking.terminalFeeCentavos)}`).text(`Terminal fee (included): ${money(booking.terminalFeeCentavos)}`)
    .text(`Total paid: ${money(booking.payments.reduce((sum, p) => sum + p.amountCentavos, 0))}`)
    .text(`Refunded: ${money(booking.refunds.filter(r => r.status === 'COMPLETED').reduce((sum, r) => sum + r.amountCentavos, 0))}`)
    .text(`Status: ${booking.status}`).moveDown().text('This receipt is not a boarding pass.');
  });
  return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${booking.reference}-receipt.pdf"`).send(pdf);
 });
 app.get('/bookings/:id/counter-slip', async (req, reply) => {
  const user = await ctx.auth(req), { id } = idParams.parse(req.params);
  const booking = await ctx.db.booking.findFirst({ where: { id, userId: user.id } });
  if (!booking) throw fail(404, 'Booking not found');
  if (booking.status !== 'COUNTER_PENDING') throw fail(409, 'Counter payment is not pending');
  const pdf = await createPdf(doc => {
   doc.fontSize(20).text('MACAPAGAL PORT').fontSize(14).text('Counter payment slip').moveDown().fontSize(12)
    .text(booking.reference).text(`Total due: ${money(booking.totalCentavos)}`).text(`Terminal fee ${money(booking.terminalFeeCentavos)} is already included; do not add it again.`)
    .text(`Pay before: ${booking.counterDeadline?.toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) ?? 'Contact the counter'} (Philippine time)`)
    .text('Location: Passenger ticketing counter').moveDown().fontSize(18).text('THIS IS NOT A BOARDING PASS');
  });
  return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${booking.reference}-counter-slip.pdf"`).send(pdf);
 });
 app.post('/staff/boarding/scan', async (req, reply) => {
  const staff = await ctx.staff(req, ['GATE_STAFF', 'PORT_ADMIN']);
  const data = z.object({ token: z.string().min(1).max(4096), gate: z.string().trim().min(1).max(80) }).parse(req.body);
  let payload;
  try {
   payload = (await jwtVerify(data.token, new TextEncoder().encode(config.JWT_SECRET), { algorithms: ['HS256'], issuer: 'macapagal-boarding', audience: 'macapagal-gate', currentDate: ctx.now() })).payload;
  } catch { throw fail(400, 'Invalid or expired boarding token'); }
  const parsed = z.object({ ticketId: z.uuid(), bookingRef: z.string(), sailingId: z.uuid(), seat: z.string(), version: z.number().int().positive() }).safeParse(payload);
  if (!parsed.success) throw fail(400, 'Invalid boarding token');
  const token = parsed.data;
  const initial = await ctx.db.ticket.findUnique({ where: { id: token.ticketId }, select: { bookingId: true, booking: { select: { sailingId: true, userId: true } } } });
  if (!initial) throw fail(404, 'Ticket not found');
  const outcome = await ctx.db.$transaction(async tx => {
   await tx.$queryRaw`SELECT id FROM "Sailing" WHERE id = ${initial.booking.sailingId}::uuid FOR UPDATE`;
   await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${initial.bookingId}::uuid FOR UPDATE`;
   const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: token.ticketId }, include: detailInclude });
   if (ticket.booking.sailingId !== initial.booking.sailingId) throw fail(409, 'Sailing changed; scan the latest boarding pass');
   if (ticket.scan) return { duplicate: true, scannedAt: ticket.scan.scannedAt, gate: ticket.scan.gate };
   if (ticket.status !== 'TICKET_ISSUED' || ticket.booking.status !== 'TICKET_ISSUED' || ticket.version !== token.version || ticket.booking.reference !== token.bookingRef || ticket.booking.sailingId !== token.sailingId || ticket.seatLabel !== token.seat) throw fail(409, 'Ticket is invalid for boarding');
   if (ticket.booking.sailing.status !== 'BOARDING') throw fail(409, 'This sailing is not boarding');
   if (data.gate !== ticket.booking.sailing.gate) throw fail(409, 'Use the current sailing gate');
   const scan = await tx.boardingScan.create({ data: { ticketId: ticket.id, staffId: staff.id, gate: data.gate, scannedAt: ctx.now() } });
   await tx.ticket.update({ where: { id: ticket.id }, data: { status: 'BOARDED' } });
   await tx.auditLog.create({ data: { actorId: staff.id, action: 'TICKET_BOARDED', entityId: ticket.id, metadata: { gate: data.gate } } });
   return { duplicate: false, scannedAt: scan.scannedAt, gate: scan.gate };
  });
  if (outcome.duplicate) return reply.code(409).send({ message: 'Ticket already used', firstScan: { scannedAt: outcome.scannedAt, gate: outcome.gate } });
  ctx.emit(`user:${initial.booking.userId}`, 'ticket.boarded', { ticketId: token.ticketId });
  return { message: 'Boarding accepted', scan: outcome, ticket: { id: token.ticketId, seatLabel: token.seat, bookingRef: token.bookingRef } };
 });
}

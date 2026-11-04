import type { FastifyInstance } from 'fastify';
import { Prisma, type Payment, type RefundPolicy } from '@prisma/client';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { config } from './config.js';
import { broadcastSeatChanges } from './bookings.js';
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const params = z.object({ id: z.uuid() });
const reasonInput = z.enum(['VOLUNTARY', 'PORT_CANCELLED', 'PORT_DELAYED']);
const refundInclude = { payment: { select: { method: true, amountCentavos: true } }, booking: { select: { id: true, userId: true, reference: true, status: true } } } satisfies Prisma.RefundInclude;
const bookingInclude = { tickets: { include: { scan: true } }, sailing: { include: { route: true } }, payments: { orderBy: { paidAt: 'asc' as const } }, refunds: true, holds: { where: { releasedAt: null }, include: { seat: true } }, passengers: { orderBy: { id: 'asc' as const } } } satisfies Prisma.BookingInclude;
type RefundBooking = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;
export function refundMath(totalCentavos: number, deductionBasisPoints: number) {
 const deductionCentavos = Math.floor((totalCentavos * deductionBasisPoints + 5000) / 10000);
 return { totalCentavos, deductionCentavos, refundCentavos: totalCentavos - deductionCentavos };
}
export function selectRefundPolicy(policies: RefundPolicy[], minutesBefore: number, reason: string) {
 const effective = reason === 'PORT_DELAYED' ? 'PORT_CANCELLED' : reason;
 return policies.filter(p => {
  const afterMinimum = p.id === 'voluntary-early' ? minutesBefore > p.minMinutesBefore : minutesBefore >= p.minMinutesBefore;
  const beforeMaximum = p.maxMinutesBefore === null || (p.id === 'voluntary-standard' ? minutesBefore <= p.maxMinutesBefore : minutesBefore < p.maxMinutesBefore);
  return p.reason === effective && afterMinimum && beforeMaximum;
 }).sort((a, b) => b.minMinutesBefore - a.minMinutesBefore)[0];
}
function effectiveReason(booking: RefundBooking, reason: string) {
 if (booking.sailing.status === 'CANCELLED') return 'PORT_CANCELLED';
 if (reason === 'PORT_CANCELLED') throw fail(409, 'This sailing has not been cancelled by the port');
 if (reason === 'PORT_DELAYED' && booking.sailing.status !== 'DELAYED') throw fail(409, 'This sailing has not been delayed by the port');
 return reason;
}
async function estimate(tx: Prisma.TransactionClient, booking: RefundBooking, now: Date, requestedReason: string) {
 const reason = effectiveReason(booking, requestedReason);
 const paid = booking.payments[0]?.amountCentavos ?? 0;
 const minutes = (+booking.sailing.departure - +now) / 60000;
 const policies = await tx.refundPolicy.findMany();
 // Voluntary early/standard boundaries are respectively >24h and <=24h;
 // all other configured tiers use inclusive minima and exclusive maxima.
 const policyMinutes = reason === 'PORT_CANCELLED' || reason === 'PORT_DELAYED' ? Math.max(0, minutes) : minutes;
 const policy = selectRefundPolicy(policies, policyMinutes, reason);
 const invalid = booking.status !== 'TICKET_ISSUED' ? 'Only issued tickets can be refunded' : booking.tickets.some(t => t.scan || t.status === 'BOARDED') ? 'A boarded booking cannot be refunded' : ['DEPARTED', 'ARRIVED'].includes(booking.sailing.status) || (minutes <= 0 && !['PORT_CANCELLED', 'PORT_DELAYED'].includes(reason)) ? 'The sailing has already departed' : !paid ? 'No confirmed payment exists' : booking.refunds.some(r => r.status !== 'FAILED' && r.reason !== 'PAYMENT_EXCEPTION') ? 'A refund has already been requested' : !policy || !policy.refundable ? 'This booking is outside the refundable period' : null;
 const amounts = refundMath(paid || booking.totalCentavos, policy?.deductionBasisPoints ?? 10000);
 return { ...amounts, eligible: !invalid, reason: invalid ?? reason, policyId: policy?.id ?? null, scope: 'BOOKING' as const, warning: 'Estimate only, not a guaranteed refund amount. This request cancels every passenger ticket in this booking.' };
}
async function lockBooking(tx: Prisma.TransactionClient, bookingId: string) {
 const initial = await tx.booking.findUnique({ where: { id: bookingId }, select: { sailingId: true } });
 if (!initial) throw fail(404, 'Booking not found');
 await tx.$queryRaw`SELECT id FROM "Sailing" WHERE id = ${initial.sailingId}::uuid FOR UPDATE`;
 await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${bookingId}::uuid FOR UPDATE`;
 const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: bookingInclude });
 if (booking.sailingId !== initial.sailingId) throw fail(409, 'Sailing changed. Please refresh and retry');
 return booking;
}
async function releaseKeys(ctx: AppContext, released: { sailingId: string; seatId: string; bookingId: string; version: number }[]) {
 for (const seat of released) {
  await ctx.redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, `seat:${seat.sailingId}:${seat.seatId}`, seat.bookingId).catch(() => {});
  ctx.emit(`sailing:${seat.sailingId}`, 'seat.released', { seatId: seat.seatId, state: 'AVAILABLE', version: seat.version });
 }
 for (const sailingId of new Set(released.map(seat => seat.sailingId))) await broadcastSeatChanges(ctx, sailingId);
}
async function createRefund(tx: Prisma.TransactionClient, booking: RefundBooking, payment: Payment, amountCentavos: number, reason: string, now: Date, actorId: string, exception = false) {
 const totalReserved = booking.refunds.filter(r => r.status !== 'FAILED').reduce((sum, r) => sum + r.amountCentavos, 0);
 const paid = booking.payments.reduce((sum, p) => sum + p.amountCentavos, 0);
 const paymentReserved = booking.refunds.filter(r => r.paymentId === payment.id && r.status !== 'FAILED').reduce((sum, r) => sum + r.amountCentavos, 0);
 if (amountCentavos > paid - totalReserved || amountCentavos > payment.amountCentavos - paymentReserved) throw fail(409, 'Refund exceeds the remaining paid amount');
 const paymentOnly = exception && booking.tickets.some(t => t.status === 'TICKET_ISSUED' || t.status === 'BOARDED');
 const refundNumber = booking.refunds.reduce((max, r) => Math.max(max, r.refundNumber), 0) + 1;
 const reference = `RF-${booking.reference.replace('-', '')}-${String(refundNumber).padStart(2, '0')}`;
 const refund = await tx.refund.create({ data: { bookingId: booking.id, paymentId: payment.id, reference, refundNumber, amountCentavos, reason, requestedAt: now } });
 if (!paymentOnly) await tx.ticket.updateMany({ where: { bookingId: booking.id }, data: { status: 'REFUNDED', version: { increment: 1 } } });
 const released = [];
 for (const hold of (paymentOnly ? [] : [...booking.holds]).sort((a, b) => a.seatId.localeCompare(b.seatId))) {
  const inventory = await tx.sailingSeat.update({ where: { sailingId_seatId: { sailingId: hold.sailingId, seatId: hold.seatId } }, data: { state: 'AVAILABLE', version: { increment: 1 } } });
  released.push({ sailingId: hold.sailingId, seatId: hold.seatId, bookingId: booking.id, version: inventory.version });
 }
 if (!paymentOnly) {
  await tx.seatHold.updateMany({ where: { bookingId: booking.id, releasedAt: null }, data: { releasedAt: now } });
  await tx.booking.update({ where: { id: booking.id }, data: { status: 'REFUND_REQUESTED' } });
 }
 await tx.auditLog.create({ data: { actorId, action: exception ? 'PAYMENT_EXCEPTION_REFUND_REQUESTED' : 'REFUND_REQUESTED', entityId: refund.id, metadata: { bookingId: booking.id, amountCentavos, reason, scope: paymentOnly ? 'PAYMENT' : 'BOOKING' } } });
 await tx.notification.create({ data: { userId: booking.userId, kind: 'REFUND_REQUESTED', payload: { refundId: refund.id, reference, amountCentavos, scope: paymentOnly ? 'PAYMENT' : 'BOOKING' } } });
 return { refund, released };
}
async function queueRefund(ctx: AppContext, refundId: string) {
 await ctx.jobs.add('refund.process', { refundId }, { jobId: `refund-${refundId}`, attempts: 5, backoff: { type: 'exponential', delay: 1000 } });
}
export async function processRefundJob(ctx: AppContext, job: { name: string; data: { refundId?: string } }) {
 if (!job.data.refundId) return;
 const outcome = await ctx.db.$transaction(async tx => {
  const initial = await tx.refund.findUnique({ where: { id: job.data.refundId }, select: { bookingId: true } });
  if (!initial) return null;
  const booking = await lockBooking(tx, initial.bookingId);
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: job.data.refundId }, include: { payment: true } });
  if (refund.status === 'COMPLETED' || refund.status === 'FAILED') return null;
  const paymentOnly = refund.reason === 'PAYMENT_EXCEPTION' && booking.tickets.some(t => t.status === 'TICKET_ISSUED' || t.status === 'BOARDED');
  if (refund.status === 'REQUESTED') {
   await tx.refund.update({ where: { id: refund.id }, data: { status: 'PROCESSING', processingAt: ctx.now() } });
   if (!paymentOnly) await tx.booking.update({ where: { id: booking.id }, data: { status: 'REFUND_PROCESSING' } });
   await tx.auditLog.create({ data: { action: 'REFUND_PROCESSING', entityId: refund.id, metadata: {} } });
   return { userId: booking.userId, refundId: refund.id, status: 'PROCESSING', settle: refund.payment.method !== 'COUNTER' };
  }
  if (refund.payment.method === 'COUNTER') return null;
  const provider = (config as typeof config & { PAYMENT_PROVIDER?: string }).PAYMENT_PROVIDER ?? 'mock';
  if (provider !== 'mock' || config.NODE_ENV === 'production') throw fail(503, 'A production refund provider must confirm settlement');
  await tx.refund.update({ where: { id: refund.id }, data: { status: 'COMPLETED', completedAt: ctx.now() } });
  if (!paymentOnly) await tx.booking.update({ where: { id: booking.id }, data: { status: 'REFUNDED' } });
  await tx.auditLog.create({ data: { action: 'REFUND_SETTLED', entityId: refund.id, metadata: { provider: 'mock', amountCentavos: refund.amountCentavos } } });
  await tx.notification.create({ data: { userId: booking.userId, kind: 'REFUND_COMPLETED', payload: { refundId: refund.id, reference: refund.reference, amountCentavos: refund.amountCentavos } } });
  return { userId: booking.userId, refundId: refund.id, status: 'COMPLETED', settle: false };
 });
 if (!outcome) return;
 ctx.emit(`user:${outcome.userId}`, 'refund.updated', { refundId: outcome.refundId, status: outcome.status });
 if (outcome.settle) await ctx.jobs.add('refund.process', { refundId: outcome.refundId }, { jobId: `refund-settle-${outcome.refundId}`, delay: 1500, attempts: 5, backoff: { type: 'exponential', delay: 1000 } });
}
export async function sweepRefunds(ctx: AppContext) {
 const refunds = await ctx.db.refund.findMany({ where: { status: { in: ['REQUESTED', 'PROCESSING'] } }, select: { id: true }, take: 100, orderBy: { requestedAt: 'asc' } });
 for (const refund of refunds) await processRefundJob(ctx, { name: 'refund.process', data: { refundId: refund.id } });
}
export function registerRefundRoutes(app: FastifyInstance, ctx: AppContext) {
 app.get('/tickets/:id/refund-estimate', async req => {
  const user = await ctx.auth(req), { id } = params.parse(req.params);
  const reason = z.object({ reason: reasonInput.default('VOLUNTARY') }).parse(req.query).reason;
  return ctx.db.$transaction(async tx => {
   const ticket = await tx.ticket.findFirst({ where: { id, booking: { userId: user.id } }, include: { booking: { include: bookingInclude } } });
   if (!ticket) throw fail(404, 'Ticket not found');
   return { estimate: await estimate(tx, ticket.booking, ctx.now(), reason), serverTime: ctx.now().toISOString() };
  });
 });
 app.post('/tickets/:id/refund', async req => {
  const user = await ctx.verified(req), { id } = params.parse(req.params);
  const data = z.object({ reason: reasonInput.default('VOLUNTARY') }).parse(req.body ?? {});
  const initial = await ctx.db.ticket.findFirst({ where: { id, booking: { userId: user.id } }, select: { bookingId: true } });
  if (!initial) throw fail(404, 'Ticket not found');
  const outcome = await ctx.db.$transaction(async tx => {
   const booking = await lockBooking(tx, initial.bookingId);
   const quote = await estimate(tx, booking, ctx.now(), data.reason);
   if (!quote.eligible) throw fail(409, quote.reason);
   const reason = effectiveReason(booking, data.reason);
   return createRefund(tx, booking, booking.payments[0], quote.refundCentavos, reason, ctx.now(), user.id);
  });
  await releaseKeys(ctx, outcome.released);
  await queueRefund(ctx, outcome.refund.id);
  ctx.emit(`user:${user.id}`, 'refund.updated', { refundId: outcome.refund.id, status: outcome.refund.status });
  return { refund: { ...outcome.refund, scope: 'BOOKING' }, message: 'Every ticket in this booking is now invalid for boarding.' };
 });
 app.get('/refunds/:id', async req => {
  const user = await ctx.auth(req), { id } = params.parse(req.params);
  const refund = await ctx.db.refund.findFirst({ where: { id, booking: { userId: user.id } }, include: refundInclude });
  if (!refund) throw fail(404, 'Refund not found');
  return { refund: { ...refund, scope: refund.reason === 'PAYMENT_EXCEPTION' ? 'PAYMENT' : 'BOOKING', timeline: [{ status: 'REQUESTED', at: refund.requestedAt }, { status: 'PROCESSING', at: refund.processingAt }, { status: 'COMPLETED', at: refund.completedAt }], settlement: refund.payment.method === 'COUNTER' ? 'Cash refund at counter' : `Original payment method: ${refund.payment.method}` }, serverTime: ctx.now().toISOString() };
 });
 app.post('/staff/refunds/:id/complete', async req => {
  const staff = await ctx.staff(req, ['COUNTER_STAFF', 'PORT_ADMIN']), { id } = params.parse(req.params);
  z.object({ idChecked: z.literal(true) }).parse(req.body);
  const initial = await ctx.db.refund.findUnique({ where: { id }, select: { bookingId: true } });
  if (!initial) throw fail(404, 'Refund not found');
  const outcome = await ctx.db.$transaction(async tx => {
   const booking = await lockBooking(tx, initial.bookingId);
   const refund = await tx.refund.findUniqueOrThrow({ where: { id }, include: { payment: true } });
   if (refund.status === 'COMPLETED') return { refund, userId: booking.userId };
   if (refund.payment.method !== 'COUNTER') throw fail(409, 'Electronic refunds require provider confirmation');
   if (refund.status === 'FAILED') throw fail(409, 'This refund failed');
   const updated = await tx.refund.update({ where: { id }, data: { status: 'COMPLETED', processingAt: refund.processingAt ?? ctx.now(), completedAt: ctx.now() } });
   const paymentOnly = refund.reason === 'PAYMENT_EXCEPTION' && booking.tickets.some(t => t.status === 'TICKET_ISSUED' || t.status === 'BOARDED');
   if (!paymentOnly) await tx.booking.update({ where: { id: booking.id }, data: { status: 'REFUNDED' } });
   await tx.auditLog.create({ data: { actorId: staff.id, action: 'CASH_REFUND_SETTLED', entityId: id, metadata: { idChecked: true, amountCentavos: refund.amountCentavos } } });
   return { refund: updated, userId: booking.userId };
  });
  ctx.emit(`user:${outcome.userId}`, 'refund.updated', { refundId: id, status: 'COMPLETED' });
  return { refund: outcome.refund };
 });
 app.post('/staff/payments/:id/refund', async req => {
  const staff = await ctx.staff(req, ['PORT_ADMIN']), { id } = params.parse(req.params);
  const initial = await ctx.db.payment.findUnique({ where: { id }, select: { bookingId: true } });
  if (!initial) throw fail(404, 'Payment not found');
  const outcome = await ctx.db.$transaction(async tx => {
   const booking = await lockBooking(tx, initial.bookingId);
   const payment = booking.payments.find(p => p.id === id)!;
   const refunded = booking.refunds.filter(r => r.paymentId === id && r.status !== 'FAILED').reduce((sum, r) => sum + r.amountCentavos, 0);
   if (refunded >= payment.amountCentavos) throw fail(409, 'This payment is already refunded or reserved for refund');
   const exception = await tx.notification.findFirst({ where: { userId: booking.userId, kind: 'PAYMENT_EXCEPTION', AND: [{ payload: { path: ['bookingId'], equals: booking.id } }, { payload: { path: ['attemptId'], equals: payment.attemptId } }] } });
   if (!exception) throw fail(409, 'This payment has no matching payment exception');
   const result = await createRefund(tx, booking, payment, payment.amountCentavos - refunded, 'PAYMENT_EXCEPTION', ctx.now(), staff.id, true);
   await tx.notification.update({ where: { id: exception.id }, data: { readAt: ctx.now() } });
   return result;
  });
  await releaseKeys(ctx, outcome.released); await queueRefund(ctx, outcome.refund.id);
  return { refund: outcome.refund };
 });
 registerRescheduleRoute(app, ctx);
}
function registerRescheduleRoute(app: FastifyInstance, ctx: AppContext) {
 app.post('/bookings/:id/reschedule', async req => {
  const user = await ctx.verified(req), { id } = params.parse(req.params);
  const data = z.object({ sailingId: z.uuid(), seatIds: z.array(z.string().min(1).max(160)).min(1).max(10) }).refine(d => new Set(d.seatIds).size === d.seatIds.length, 'Select distinct seats').parse(req.body);
  const initial = await ctx.db.booking.findFirst({ where: { id, userId: user.id }, select: { sailingId: true } });
  if (!initial) throw fail(404, 'Booking not found');
  if (data.sailingId === initial.sailingId) throw fail(409, 'Choose a different sailing');
  const keys = data.seatIds.map(seatId => `seat:${data.sailingId}:${seatId}`);
  let acquired = false;
  try {
   const outcome = await ctx.db.$transaction(async tx => {
    // Lock both sailing records in deterministic order before locking the booking.
    for (const sailingId of [initial.sailingId, data.sailingId].sort()) await tx.$queryRaw`SELECT id FROM "Sailing" WHERE id = ${sailingId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${id}::uuid FOR UPDATE`;
    const booking = await tx.booking.findUniqueOrThrow({ where: { id }, include: bookingInclude });
    if (booking.sailingId !== initial.sailingId || booking.status !== 'TICKET_ISSUED' || !['CANCELLED', 'DELAYED'].includes(booking.sailing.status)) throw fail(409, 'A free reschedule is available only for an issued booking affected by a port cancellation or delay');
    if (booking.tickets.some(t => t.scan || t.status === 'BOARDED')) throw fail(409, 'A boarded booking cannot be rescheduled');
    if (data.seatIds.length !== booking.passengers.length) throw fail(400, 'Select one seat per passenger');
    const target = await tx.sailing.findUnique({ where: { id: data.sailingId }, include: { route: true } });
    if (!target || !target.published || !['SCHEDULED', 'BOARDING', 'DELAYED'].includes(target.status) || +target.departure <= +ctx.now() + config.BOOKING_CUTOFF_MINUTES * 60000) throw fail(409, 'The selected sailing is closed');
    if (target.route.originId !== booking.sailing.route.originId || target.route.destinationId !== booking.sailing.route.destinationId) throw fail(409, 'Choose a sailing on the same route');
    const locked = await tx.$queryRaw<{ seatId: string }[]>(Prisma.sql`SELECT "seatId" FROM "SailingSeat" WHERE "sailingId" = ${data.sailingId}::uuid AND "seatId" IN (${Prisma.join([...data.seatIds].sort())}) AND state = 'AVAILABLE' ORDER BY "seatId" FOR UPDATE SKIP LOCKED`);
    if (locked.length !== data.seatIds.length) throw fail(409, 'The selected seats are no longer available');
    const seats = await tx.seat.findMany({ where: { id: { in: data.seatIds }, layout: { vesselId: target.vesselId } }, include: { layout: true } });
    if (seats.length !== data.seatIds.length || new Set(seats.map(s => s.layout.className)).size !== 1) throw fail(400, 'Select seats in one class on the target vessel');
    const ttl = Math.max(60, Math.ceil((+target.arrival - +ctx.now()) / 1000));
    const success = await ctx.redis.eval("for i,key in ipairs(KEYS) do if redis.call('EXISTS',key)==1 then return 0 end end for i,key in ipairs(KEYS) do redis.call('SET',key,ARGV[1],'EX',ARGV[2]) end return 1", keys.length, ...keys, id, String(ttl));
    if (success !== 1) throw fail(409, 'The selected seats are being acquired by another passenger');
    acquired = true;
    const released = [];
    for (const hold of [...booking.holds].sort((a, b) => a.seatId.localeCompare(b.seatId))) {
     const inventory = await tx.sailingSeat.update({ where: { sailingId_seatId: { sailingId: hold.sailingId, seatId: hold.seatId } }, data: { state: 'AVAILABLE', version: { increment: 1 } } });
     released.push({ sailingId: hold.sailingId, seatId: hold.seatId, bookingId: id, version: inventory.version });
    }
    await tx.seatHold.updateMany({ where: { bookingId: id, releasedAt: null }, data: { releasedAt: ctx.now() } });
    const passengers = [...booking.passengers].sort((a, b) => ((a as typeof a & { position?: number }).position ?? 0) - ((b as typeof b & { position?: number }).position ?? 0) || a.id.localeCompare(b.id));
    const changed = [];
    for (let i = 0; i < data.seatIds.length; i++) {
     const seat = seats.find(s => s.id === data.seatIds[i])!;
     await tx.seatHold.create({ data: { bookingId: id, sailingId: target.id, seatId: seat.id, expiresAt: target.arrival } });
     const inventory = await tx.sailingSeat.update({ where: { sailingId_seatId: { sailingId: target.id, seatId: seat.id } }, data: { state: 'SOLD', version: { increment: 1 } } });
     await tx.ticket.updateMany({ where: { bookingId: id, passengerId: passengers[i].id }, data: { seatLabel: seat.label, version: { increment: 1 }, status: 'TICKET_ISSUED' } });
     // seatId is optional for historical passengers; new Phase 3 records carry it.
     await tx.bookingPassenger.update({ where: { id: passengers[i].id }, data: { seatId: seat.id } });
     changed.push({ seatId: seat.id, state: 'SOLD', version: inventory.version });
    }
    await tx.booking.update({ where: { id }, data: { sailingId: target.id } });
    await tx.auditLog.create({ data: { actorId: user.id, action: 'BOOKING_RESCHEDULED', entityId: id, metadata: { fromSailingId: initial.sailingId, toSailingId: target.id, extraChargeCentavos: 0 } } });
    await tx.notification.create({ data: { userId: user.id, kind: 'BOOKING_RESCHEDULED', payload: { bookingId: id, sailingId: target.id } } });
    return { released, changed, sailingId: target.id };
   }, { timeout: 15000 });
   await releaseKeys(ctx, outcome.released);
   await broadcastSeatChanges(ctx, outcome.sailingId);
   ctx.emit(`user:${user.id}`, 'ticket.issued', { bookingId: id, rescheduled: true });
   return { booking: { id, sailingId: outcome.sailingId, status: 'TICKET_ISSUED' }, message: 'Rescheduled at no extra charge. Download the updated boarding passes.' };
  } catch (error) {
   if (acquired) for (const key of keys) await ctx.redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, key, id).catch(() => {});
   throw error;
  }
 });
}

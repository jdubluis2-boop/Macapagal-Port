import PDFDocument from 'pdfkit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type PaymentAttempt } from '@prisma/client';
import { z } from 'zod';
import type { Job } from 'bullmq';
import type { AppContext } from './context.js';
import { config } from './config.js';
import { issueTickets } from './tickets.js';
import { assertBookingTransition } from './state-machine.js';
import { broadcastSeatChanges, releaseSeatKeys } from './bookings.js';

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const id = z.string().uuid();
const paymentRequest = z.object({ method: z.enum(['GCASH', 'MAYA', 'CARD', 'COUNTER']), idempotencyKey: id }).strict();
export const paymentEventSchema = z.object({ eventId: z.string().min(1).max(128), attemptId: id, status: z.enum(['SUCCEEDED','FAILED']), amountCentavos: z.number().int().positive(), currency: z.literal('PHP'), providerReference: z.string().min(1).max(200) }).strict();
export type PaymentEvent = z.infer<typeof paymentEventSchema>;
const pendingSeconds = () => config.PAYMENT_PENDING_MAX_SECONDS;
const secret = () => config.PAYMENT_WEBHOOK_SECRET ?? createHmac('sha256',config.TOKEN_PEPPER).update('macapagal:mock-payment-webhook:v1').digest('hex');
const mockEnabled = () => config.NODE_ENV !== 'production' && config.PAYMENT_PROVIDER === 'mock';
/** Mock adapter contract: HMAC over epoch-seconds + '.' + schema-ordered JSON. */
export function signPaymentEvent(event: PaymentEvent, timestamp: string, key = secret()) {
 return createHmac('sha256',key).update(`${timestamp}.${JSON.stringify(paymentEventSchema.parse(event))}`).digest('hex');
}
export function verifyPaymentSignature(event: PaymentEvent, timestamp: unknown, signature: unknown, now: Date, key = secret()) {
 if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) || Math.abs(+now / 1000 - Number(timestamp)) > 300) return false;
 if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
 const expected = Buffer.from(signPaymentEvent(event,timestamp,key),'hex');
 return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
async function lockedBooking(tx: Prisma.TransactionClient, bookingId: string) {
 const initial = await tx.booking.findUnique({ where: { id: bookingId }, select: { sailingId: true } });
 if (!initial) throw fail(404,'Booking not found');
 await tx.$queryRaw`SELECT id FROM "Sailing" WHERE id=${initial.sailingId}::uuid FOR UPDATE`;
 await tx.$queryRaw`SELECT id FROM "Booking" WHERE id=${bookingId}::uuid FOR UPDATE`;
 const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { sailing: true, passengers: { orderBy: { id: 'asc' } }, holds: { where: { releasedAt: null }, include: { seat: { include: { layout: true } } }, orderBy: { seatId: 'asc' } }, payments: true } });
 if(booking.sailingId!==initial.sailingId)throw fail(409,'Sailing changed. Refresh the booking and try again.');
 if (booking.holds.length) await tx.$queryRaw`SELECT "seatId" FROM "SailingSeat" WHERE "sailingId"=${booking.sailingId}::uuid AND "seatId" IN (${Prisma.join(booking.holds.map(h=>h.seatId))}) ORDER BY "seatId" FOR UPDATE`;
 return booking;
}
type LockedBooking = Awaited<ReturnType<typeof lockedBooking>>;
async function ownsSeats(tx: Prisma.TransactionClient, booking: LockedBooking) {
 if (!booking.passengers.length || booking.holds.length !== booking.passengers.length) return false;
 const rows = await tx.sailingSeat.findMany({ where: { sailingId: booking.sailingId, seatId: { in: booking.holds.map(h=>h.seatId) } } });
 return rows.length === booking.holds.length && rows.every(r=>r.state === 'HELD' || r.state === 'PENDING_PAYMENT');
}
async function release(tx: Prisma.TransactionClient, booking: LockedBooking, now: Date) {
 const seatIds = booking.holds.map(h=>h.seatId);
 await tx.seatHold.updateMany({ where: { bookingId: booking.id, releasedAt: null }, data: { releasedAt: now } });
 if (seatIds.length) await tx.sailingSeat.updateMany({ where: { sailingId: booking.sailingId, seatId: { in: seatIds }, state: { in: ['HELD','PENDING_PAYMENT'] } }, data: { state: 'AVAILABLE', version: { increment: 1 } } });
}
async function emitInventory(ctx: AppContext, bookingId: string, released = false) {
 const booking = await ctx.db.booking.findUnique({ where: { id: bookingId }, include: { holds: true } });
 if (!booking) return;
 await broadcastSeatChanges(ctx,booking.sailingId);
 if (released) {
  await releaseSeatKeys(ctx,booking.sailingId,booking.holds.map(h=>h.seatId),booking.id).catch(()=>{});
  const seats=await ctx.db.sailingSeat.findMany({where:{sailingId:booking.sailingId,seatId:{in:booking.holds.map(h=>h.seatId)}}});
  for(const seat of seats)ctx.emit(`sailing:${booking.sailingId}`,'seat.released',{seatId:seat.seatId,state:seat.state,version:seat.version});
 }
}
async function fareTotal(tx: Prisma.TransactionClient, booking: LockedBooking) {
 const fares = await tx.fare.findMany({ where: { sailingId: booking.sailingId } });
 let total = 0, terminal = 0;
 for (let n=0;n<booking.passengers.length;n++) {
  const passenger = booking.passengers[n];
  const hold = passenger.seatId ? booking.holds.find(h=>h.seatId === passenger.seatId) : booking.holds[n];
  if (!hold || hold.seat.layout.vesselId !== booking.sailing.vesselId) throw fail(409,'Seat assignment is unavailable. Reselect seats.');
  const fare = fares.find(f=>f.className === hold.seat.layout.className && f.category === passenger.category);
  if (!fare) throw fail(409,'A fare is not available for this passenger and class');
  total += fare.baseCentavos + fare.terminalFeeCentavos; terminal += fare.terminalFeeCentavos;
 }
 if (total <= 0) throw fail(409,'Payment amount must be positive');
 return { total, terminal };
}

/** Verified success is serialized with all other writes for the sailing/booking. */
async function complete(tx: Prisma.TransactionClient, booking: LockedBooking, attempt: PaymentAttempt, now: Date) {
 if (attempt.status === 'SUCCEEDED') return { changed: false, exception: false, released: false };
 const previousPayment = booking.payments.length > 0;
 const seatsOurs = await ownsSeats(tx,booking);
 await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'SUCCEEDED', providerState: 'SUCCEEDED', finalizedAt: now } });
 await tx.payment.upsert({ where: { attemptId: attempt.id }, create: { bookingId: booking.id, attemptId: attempt.id, amountCentavos: attempt.amountCentavos, method: attempt.method, paidAt: now }, update: {} });
 const cancelled = ['CANCELLED','DEPARTED','ARRIVED'].includes(booking.sailing.status) || +booking.sailing.departure <= +now;
 if (previousPayment || !seatsOurs || cancelled || ['REFUND_REQUESTED','REFUND_PROCESSING','REFUNDED','CANCELLED','COMPLETED'].includes(booking.status)) {
  await tx.notification.create({ data: { userId: booking.userId, kind: 'PAYMENT_EXCEPTION', payload: { bookingId: booking.id, attemptId: attempt.id, amountCentavos: attempt.amountCentavos, reason: previousPayment ? 'DUPLICATE_PAYMENT' : cancelled ? 'SAILING_UNAVAILABLE' : 'SEAT_LOST', requiresRefund: true } } });
  await tx.auditLog.create({ data: { action: 'PAYMENT_EXCEPTION', entityId: attempt.id, metadata: { bookingId: booking.id, amountCentavos: attempt.amountCentavos, requiresRefund: true } } });
  let released=false;
  if(booking.status==='PAYMENT_PENDING'){
   await release(tx,booking,now);released=true;
   await tx.booking.update({where:{id:booking.id},data:{status:cancelled?'CANCELLED':'HOLD_EXPIRED',holdExpiresAt:null,paymentStartedAt:null,paymentHoldExpiresAt:null}});
  }
  await tx.paymentAttempt.updateMany({where:{bookingId:booking.id,id:{not:attempt.id},status:'PENDING'},data:{status:'FAILED',finalizedAt:now}});
  return { changed: true, exception: true, released };
 }
 // A late-paid failed attempt may win before a replacement attempt; prevent a second new payment.
 await tx.paymentAttempt.updateMany({ where: { bookingId: booking.id, id: { not: attempt.id }, status: 'PENDING' }, data: { status: 'FAILED', finalizedAt: now } });
 await tx.booking.update({ where: { id: booking.id }, data: { status: 'PAID', holdExpiresAt: null, paymentStartedAt: null, paymentHoldExpiresAt: null } });
 await tx.sailingSeat.updateMany({ where: { sailingId: booking.sailingId, seatId: { in: booking.holds.map(h=>h.seatId) } }, data: { state: 'SOLD', version: { increment: 1 } } });
 await issueTickets(tx,booking.id);
 await tx.notification.create({data:{userId:booking.userId,kind:'TICKET_ISSUED',payload:{bookingId:booking.id,reference:booking.reference,message:`Payment confirmed for ${booking.reference}. Your Macapagal Port e-tickets are ready. Sign in to view your boarding passes.`}}});
 await tx.auditLog.create({ data: { action: 'PAYMENT_SUCCEEDED', entityId: attempt.id, metadata: { bookingId: booking.id, amountCentavos: attempt.amountCentavos } } });
 return { changed: true, exception: false, released: false };
}
async function failed(tx: Prisma.TransactionClient, booking: LockedBooking, attempt: PaymentAttempt, now: Date) {
 if (attempt.status !== 'PENDING') return { changed: false, released: false };
 const originalExpiry = booking.paymentHoldExpiresAt ?? booking.holdExpiresAt;
 const stillOurs = await ownsSeats(tx,booking);
 const retain = !!originalExpiry && +originalExpiry > +now && stillOurs && !['CANCELLED','DEPARTED','ARRIVED'].includes(booking.sailing.status);
 await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED', finalizedAt: now } });
 if (booking.payments.length || ['TICKET_ISSUED','COMPLETED','REFUNDED','REFUND_PROCESSING'].includes(booking.status)) return { changed: true, released: false };
 await tx.booking.update({ where: { id: booking.id }, data: { status: retain ? 'PAYMENT_FAILED' : 'HOLD_EXPIRED', holdExpiresAt: retain ? originalExpiry : null, paymentStartedAt: null, paymentHoldExpiresAt: null } });
 if (retain) {
  await tx.seatHold.updateMany({ where: { bookingId: booking.id, releasedAt: null }, data: { expiresAt: originalExpiry! } });
  await tx.sailingSeat.updateMany({ where: { sailingId: booking.sailingId, seatId: { in: booking.holds.map(h=>h.seatId) }, state: 'PENDING_PAYMENT' }, data: { state: 'HELD', version: { increment: 1 } } });
 } else await release(tx,booking,now);
 await tx.auditLog.create({ data: { action: 'PAYMENT_FAILED', entityId: attempt.id, metadata: { bookingId: booking.id, holdReleased: !retain } } });
 return { changed: true, released: !retain };
}
export async function applyPaymentEvent(ctx: AppContext, event: PaymentEvent, provider = 'mock') {
 const now = ctx.now();
 const result = await ctx.db.$transaction(async tx => {
  const initial = await tx.paymentAttempt.findUnique({ where: { id: event.attemptId } });
  if (!initial) throw fail(404,'Payment attempt not found');
  const booking = await lockedBooking(tx,initial.bookingId);
  const attempt = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: initial.id } });
  if (attempt.providerReference !== event.providerReference || attempt.amountCentavos !== event.amountCentavos) throw fail(400,'Provider payment details do not match the attempt');
  const inserted = await tx.webhookEvent.createMany({ data: { provider, eventId: event.eventId, receivedAt: now, processedAt: now }, skipDuplicates: true });
  if (!inserted.count) return { duplicate: true, bookingId: booking.id, userId: booking.userId, exception: false, released: false, changed: false };
  // Success is monotonic. Out-of-order failure events cannot downgrade settled funds.
  await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { providerState: attempt.providerState === 'SUCCEEDED' ? 'SUCCEEDED' : event.status } });
  const state = event.status === 'SUCCEEDED' ? { ...await complete(tx,booking,attempt,now) } : { ...await failed(tx,booking,attempt,now), exception: false };
  return { duplicate: false, bookingId: booking.id, userId: booking.userId, ...state };
 },{timeout:15000});
 if (result.changed) {
  await emitInventory(ctx,result.bookingId,result.released);
  ctx.emit(`user:${result.userId}`,result.exception ? 'payment.exception' : event.status === 'SUCCEEDED' ? 'payment.succeeded' : 'payment.failed',{bookingId:result.bookingId,attemptId:event.attemptId,requiresRefund:result.exception});
  if (event.status === 'SUCCEEDED' && !result.exception) ctx.emit(`user:${result.userId}`,'ticket.issued',{bookingId:result.bookingId});
 }
 return result;
}

function bookingView(booking: {id:string;reference:string;status:string;totalCentavos:number;terminalFeeCentavos:number;holdExpiresAt:Date|null;counterDeadline:Date|null;sailingId:string}) {
 return {id:booking.id,reference:booking.reference,status:booking.status,totalCentavos:booking.totalCentavos,terminalFeeCentavos:booking.terminalFeeCentavos,holdExpiresAt:booking.holdExpiresAt,counterDeadline:booking.counterDeadline,sailingId:booking.sailingId};
}

export function registerPaymentRoutes(app: FastifyInstance, ctx: AppContext) {
 app.get('/payments/config',async()=>({mockEnabled:mockEnabled()}));
 const pay = async (req: FastifyRequest) => {
  const user = await ctx.verified(req);
  const bookingId = id.parse((req.params as {id:string}).id);
  const data = paymentRequest.parse(req.body);
  if (data.method !== 'COUNTER' && !mockEnabled()) throw fail(503,'Online payment provider is not configured. Choose the terminal counter.');
  const now = ctx.now();
  const result = await ctx.db.$transaction(async tx => {
   const booking = await lockedBooking(tx,bookingId);
   if (booking.userId !== user.id) throw fail(404,'Booking not found');
   const old = await tx.paymentAttempt.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
   if (old) {
    if (old.bookingId !== booking.id || old.method !== data.method) throw fail(409,'Idempotency key was used for a different payment');
    return { booking, attempt: old, repeated: true, priceChanged: false };
   }
   if (booking.status === 'COUNTER_PENDING' && data.method === 'COUNTER') return {booking,attempt:await tx.paymentAttempt.findFirst({where:{bookingId:booking.id,method:'COUNTER',status:'PENDING'}}),repeated:true,priceChanged:false};
   if (await tx.paymentAttempt.count({ where: { bookingId: booking.id, status: 'PENDING' } })) throw fail(409,'Payment is processing. Do not pay twice or switch methods.');
   if (booking.payments.length) throw fail(409,'This booking already has a settled payment. Resolve its payment exception before paying again.');
   if (!['SEAT_HELD','PAYMENT_FAILED'].includes(booking.status)) throw fail(409,'Booking is not in a payable state');
   if (!booking.holdExpiresAt || +booking.holdExpiresAt <= +now || !await ownsSeats(tx,booking)) throw fail(409,'Seat hold has expired. Reselect your seats before paying.');
   if (!['SCHEDULED','BOARDING','DELAYED'].includes(booking.sailing.status) || +booking.sailing.departure <= +now + config.BOOKING_CUTOFF_MINUTES*60000) throw fail(409,'Online booking is closed for this sailing');
   const computed = await fareTotal(tx,booking);
   if (computed.total !== booking.totalCentavos || computed.terminal !== booking.terminalFeeCentavos) {
    const updated = await tx.booking.update({where:{id:booking.id},data:{totalCentavos:computed.total,terminalFeeCentavos:computed.terminal}});
    return {booking:updated,attempt:null,repeated:false,priceChanged:true};
   }
   assertBookingTransition(booking.status, data.method === 'COUNTER' ? 'COUNTER_PENDING' : 'PAYMENT_PENDING');
   if (data.method === 'COUNTER') {
    const counterDeadline = new Date(+booking.sailing.departure - config.COUNTER_DEADLINE_MINUTES*60000);
    if (+counterDeadline <= +now) throw fail(409,'The terminal-counter payment deadline has passed');
    const updated = await tx.booking.update({where:{id:booking.id},data:{status:'COUNTER_PENDING',counterDeadline,holdExpiresAt:counterDeadline}});
    await tx.seatHold.updateMany({where:{bookingId:booking.id,releasedAt:null},data:{expiresAt:counterDeadline}});
    await tx.auditLog.create({data:{actorId:user.id,action:'COUNTER_PAYMENT_SELECTED',entityId:booking.id,metadata:{counterDeadline:counterDeadline.toISOString(),totalCentavos:computed.total}}});
    const last = await tx.paymentAttempt.aggregate({where:{bookingId:booking.id},_max:{attemptNumber:true}});
    const attemptNumber=(last._max.attemptNumber??0)+1;
    const attempt=await tx.paymentAttempt.create({data:{bookingId:booking.id,reference:`PAY-${booking.reference.replace('-','')}-${String(attemptNumber).padStart(2,'0')}`,attemptNumber,idempotencyKey:data.idempotencyKey,method:'COUNTER',amountCentavos:computed.total,createdAt:now}});
    return {booking:updated,attempt,repeated:false,priceChanged:false};
   }
   const last = await tx.paymentAttempt.aggregate({where:{bookingId:booking.id},_max:{attemptNumber:true}});
   const attemptNumber = (last._max.attemptNumber ?? 0)+1;
   const attemptId = randomUUID();
   const attempt = await tx.paymentAttempt.create({data:{id:attemptId,bookingId:booking.id,reference:`PAY-${booking.reference.replace('-','')}-${String(attemptNumber).padStart(2,'0')}`,attemptNumber,idempotencyKey:data.idempotencyKey,method:data.method,amountCentavos:computed.total,providerReference:`mock:${attemptId}`,createdAt:now}});
   const expiresAt = new Date(+now+pendingSeconds()*1000);
   const updated = await tx.booking.update({where:{id:booking.id},data:{status:'PAYMENT_PENDING',paymentStartedAt:now,paymentHoldExpiresAt:booking.holdExpiresAt,holdExpiresAt:expiresAt}});
   await tx.seatHold.updateMany({where:{bookingId:booking.id,releasedAt:null},data:{expiresAt}});
   await tx.sailingSeat.updateMany({where:{sailingId:booking.sailingId,seatId:{in:booking.holds.map(h=>h.seatId)}},data:{state:'PENDING_PAYMENT',version:{increment:1}}});
   await tx.auditLog.create({data:{actorId:user.id,action:'PAYMENT_STARTED',entityId:attempt.id,metadata:{bookingId:booking.id,method:data.method,amountCentavos:computed.total}}});
   return {booking:updated,attempt,repeated:false,priceChanged:false};
  },{timeout:15000}).catch(e=>{if(e instanceof Prisma.PrismaClientKnownRequestError&&e.code==='P2002')throw fail(409,'Idempotency key already belongs to another payment');throw e;});
  if (result.priceChanged) throw fail(409,'Fare changed. Refresh the booking summary and confirm the updated total.');
  if (!result.repeated) {
   if(result.booking.holdExpiresAt){
    const held=await ctx.db.seatHold.findMany({where:{bookingId,releasedAt:null}});
    const ttl=Math.max(1,Math.ceil((+result.booking.holdExpiresAt-+ctx.now())/1000));
    for(const hold of held)await ctx.redis.eval("local v=redis.call('GET',KEYS[1]);if not v or v==ARGV[1] then return redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]) end;return 0",1,`seat:${hold.sailingId}:${hold.seatId}`,bookingId,ttl).catch(()=>{});
   }
   if(result.attempt && result.attempt.method!=='COUNTER') {
    await ctx.jobs.add('payment.timeout',{attemptId:result.attempt.id},{delay:pendingSeconds()*1000,jobId:`payment-timeout-${result.attempt.id}`,removeOnComplete:1000,removeOnFail:1000}).catch(()=>{});
    ctx.emit(`user:${user.id}`,'payment.processing',{bookingId,attemptId:result.attempt.id,holdExpiresAt:result.booking.holdExpiresAt});
   } else if (result.booking.counterDeadline) await ctx.jobs.add('hold.expire',{bookingId},{delay:Math.max(0,+result.booking.counterDeadline-+now),removeOnComplete:1000,removeOnFail:1000}).catch(()=>{});
   await emitInventory(ctx,bookingId);
  }
  return {booking:bookingView(result.booking),attempt:result.attempt,mockEnabled:mockEnabled()};
 };
 app.post('/bookings/:id/pay',pay);
 app.post('/bookings/:id/retry',pay);
 app.post('/payments/webhook/:provider',async req => {
  const provider = z.literal('mock').parse((req.params as {provider:string}).provider);
  if (!mockEnabled()) throw fail(503,'Mock payment processing is disabled');
  const event = paymentEventSchema.parse(req.body);
  if (!verifyPaymentSignature(event,req.headers['x-payment-timestamp'],req.headers['x-payment-signature'],ctx.now())) throw fail(401,'Invalid or expired payment signature');
  return applyPaymentEvent(ctx,event,provider);
 });
 app.post('/payments/mock/settle',async req => {
  if (!mockEnabled()) throw fail(404,'Not found');
  const user = await ctx.auth(req);
  const data = z.object({attemptId:id,outcome:z.enum(['SUCCEEDED','FAILED'])}).strict().parse(req.body);
  const attempt = await ctx.db.paymentAttempt.findUnique({where:{id:data.attemptId},include:{booking:true}});
  if (!attempt || (attempt.booking.userId !== user.id && !['COUNTER_STAFF','PORT_ADMIN'].includes(user.role))) throw fail(404,'Payment attempt not found');
  if (attempt.method === 'COUNTER') throw fail(409,'Counter payments require staff confirmation and an ID check');
  if (attempt.providerState === 'SUCCEEDED' && data.outcome === 'FAILED') throw fail(409,'A settled payment cannot be reversed by a failure');
  await ctx.db.paymentAttempt.update({where:{id:attempt.id},data:{providerState:data.outcome}});
  const event:PaymentEvent={eventId:randomUUID(),attemptId:attempt.id,status:data.outcome,amountCentavos:attempt.amountCentavos,currency:'PHP',providerReference:attempt.providerReference!};
  const timestamp=String(Math.floor(+ctx.now()/1000));
  if (!verifyPaymentSignature(event,timestamp,signPaymentEvent(event,timestamp),ctx.now())) throw fail(500,'Simulator signature verification failed');
  return applyPaymentEvent(ctx,event);
 });

 app.get('/bookings/:id/slip.pdf',async(req,reply)=>{
  const user=await ctx.auth(req);
  const bookingId=id.parse((req.params as {id:string}).id);
  const booking=await ctx.db.booking.findUnique({where:{id:bookingId},include:{sailing:{include:{route:{include:{origin:true,destination:true}}}}}});
  if(!booking||booking.userId!==user.id)throw fail(404,'Booking not found');
  if(!booking.counterDeadline)throw fail(409,'This booking has no terminal-counter slip');
  const doc=new PDFDocument({size:'A5',margin:35});
  const chunks:Buffer[]=[];
  const output=new Promise<Buffer>((resolve,reject)=>{doc.on('data',(chunk:Buffer)=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const money=(amount:number)=>`P${(amount/100).toFixed(2)}`;
  doc.fontSize(18).text('Macapagal Port');doc.fontSize(14).text('Terminal counter payment slip').moveDown();
  doc.fontSize(11).text(`Reference: ${booking.reference}`).text(`Status: ${booking.status}`).text(`${booking.sailing.route.origin.name} to ${booking.sailing.route.destination.name}`).moveDown();
  doc.text(`Total due: ${money(booking.totalCentavos)}`).text(`Terminal fee included: ${money(booking.terminalFeeCentavos)}`).text('Do not add the terminal fee again.').moveDown();
  doc.text('Location: Passenger ticketing counter').text(`Pay before: ${booking.counterDeadline.toLocaleString('en-PH',{timeZone:'Asia/Manila'})} Philippine time`).text('Bring valid government-issued ID.').moveDown();
  doc.fontSize(14).text('THIS IS NOT A BOARDING PASS');
  if(booking.status!=='COUNTER_PENDING'||+booking.counterDeadline<=+ctx.now())doc.fontSize(11).text('This slip is no longer payable. Confirm current booking status with staff.');
  doc.end();
  return reply.type('application/pdf').header('Content-Disposition',`attachment; filename="${booking.reference}-counter-slip.pdf"`).send(await output);
 });
 app.post('/staff/bookings/:id/counter-payment',async req => {
  const staff = await ctx.staff(req,['COUNTER_STAFF','PORT_ADMIN']);
  z.object({idChecked:z.literal(true)}).strict().parse(req.body);
  const bookingId=id.parse((req.params as {id:string}).id);
  const now=ctx.now();
  const result=await ctx.db.$transaction(async tx=>{
   const booking=await lockedBooking(tx,bookingId);
   const paid=booking.payments.find(p=>p.method==='COUNTER');
   if(paid)return{booking,attemptId:paid.attemptId,repeated:true};
   if(booking.status!=='COUNTER_PENDING'||!booking.counterDeadline||Math.min(+booking.counterDeadline,+booking.sailing.departure-config.COUNTER_DEADLINE_MINUTES*60000)<=+now||!await ownsSeats(tx,booking))throw fail(409,'Counter slip expired or is not payable');
   const existing=await tx.paymentAttempt.findFirst({where:{bookingId,method:'COUNTER',status:'PENDING'}});
   if(!existing)throw fail(409,'Counter payment attempt is missing');
   const attempt=await tx.paymentAttempt.update({where:{id:existing.id},data:{providerState:'SUCCEEDED'}});
   const outcome=await complete(tx,booking,attempt,now);
   if(outcome.exception)throw fail(409,'Counter payment cannot be accepted for this sailing');
   await tx.auditLog.create({data:{actorId:staff.id,action:'COUNTER_ID_CHECK_AND_PAYMENT',entityId:booking.id,metadata:{idChecked:true,amountCentavos:booking.totalCentavos}}});
   return{booking:await tx.booking.findUniqueOrThrow({where:{id:bookingId}}),attemptId:attempt.id,repeated:false};
  },{timeout:15000});
  if(!result.repeated){await emitInventory(ctx,bookingId);ctx.emit(`user:${result.booking.userId}`,'payment.succeeded',{bookingId,attemptId:result.attemptId});ctx.emit(`user:${result.booking.userId}`,'ticket.issued',{bookingId});}
  return {...result,booking:bookingView(result.booking)};
 });
}

export async function reconcilePayments(ctx: AppContext) {
 if (!mockEnabled()) return;
 const now=ctx.now();
 const attempts=await ctx.db.paymentAttempt.findMany({where:{method:{not:'COUNTER'},status:{in:['PENDING','FAILED']},createdAt:{gte:new Date(+now-86400000)}},orderBy:{createdAt:'asc'}});
 for(const attempt of attempts){
  if(attempt.providerState==='SUCCEEDED'||attempt.providerState==='FAILED'){
   await applyPaymentEvent(ctx,{eventId:`reconcile-${attempt.id}-${attempt.providerState}`,attemptId:attempt.id,status:attempt.providerState as 'SUCCEEDED'|'FAILED',amountCentavos:attempt.amountCentavos,currency:'PHP',providerReference:attempt.providerReference!});
  }else if(attempt.status==='PENDING'&&+attempt.createdAt+pendingSeconds()*1000<=+now){
   const result=await ctx.db.$transaction(async tx=>{const booking=await lockedBooking(tx,attempt.bookingId);const current=await tx.paymentAttempt.findUniqueOrThrow({where:{id:attempt.id}});return{...await failed(tx,booking,current,now),userId:booking.userId};});
   if(result.changed){await emitInventory(ctx,attempt.bookingId,result.released);ctx.emit(`user:${result.userId}`,'payment.failed',{bookingId:attempt.bookingId,attemptId:attempt.id,reason:'PROVIDER_TIMEOUT'});}
  }
 }
}
export async function processPaymentJob(ctx: AppContext, job: Pick<Job,'name'|'data'>) {
 if(job.name==='payment.timeout'||job.name==='payment.reconcile')await reconcilePayments(ctx);
}

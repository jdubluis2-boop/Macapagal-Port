import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import { PrismaClient, type User, type PaymentMethod, type SailingStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import { decodeJwt } from 'jose';
import type { AppContext } from '../src/context.js';
import type { Queue } from 'bullmq';
dotenv.config({ path: new URL('../../../.env', import.meta.url), quiet: true });
if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')) throw new Error('Set TEST_DATABASE_URL to an isolated *_test database');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
const { encrypt, decrypt } = await import('../src/encryption.js');
const { issueTickets, registerTicketRoutes } = await import('../src/tickets.js');
const { registerRefundRoutes, processRefundJob, refundMath } = await import('../src/refunds.js');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
const redis = new Redis('redis://127.0.0.1:6379/15');
const prefix = `ticket-test-${randomUUID()}`, ownerId = randomUUID(), strangerId = randomUUID(), gateId = randomUUID(), counterId = randomUUID(), adminId = randomUUID();
const routeId = `${prefix}-route`, vesselId = `${prefix}-vessel`, layoutId = `${prefix}-layout`;
const now = new Date('2030-06-01T00:00:00Z');
const bookingIds: string[] = [], sailingIds: string[] = [];
const users = new Map<string, User>();
const queued: { name: string; data: any }[] = [];
const events: { room: string; event: string; payload: unknown }[] = [];
const actor = async (req: any) => { const user = users.get(String(req.headers['x-test-actor'] ?? ownerId));if (!user) throw Object.assign(new Error('Unauthorized'),{statusCode:401});return user; };
const ctx: AppContext = { db, redis, now: () => now, auth: actor, verified: actor, staff: async (req, roles) => {const u=await actor(req);if(!roles.includes(u.role))throw Object.assign(new Error('Forbidden'),{statusCode:403});return u;}, encrypt, decrypt,
 emit:(room,event,payload)=>events.push({room,event,payload}), jobs:{add:async(name:string,data:any)=>{queued.push({name,data});return {};}} as unknown as Queue };
const app=Fastify();
app.setErrorHandler((error,_,reply)=>reply.code((error as {statusCode?:number}).statusCode??400).send({message:(error as Error).message}));
registerTicketRoutes(app,ctx);registerRefundRoutes(app,ctx);
const request=(method:'GET'|'POST',url:string,payload?:unknown,actorId=ownerId)=>app.inject({method,url,payload:payload===undefined?undefined:JSON.stringify(payload),headers:{'content-type':'application/json','x-test-actor':actorId}});
async function makeSailing(minutes=1800,status:SailingStatus='SCHEDULED') {
 const departure=new Date(+now+minutes*60000);
 const sailing=await db.sailing.create({data:{vesselId,routeId,departure,arrival:new Date(+departure+90*60000),status,published:true,gate:'Gate 04',terminal:'Terminal 1'}});
 sailingIds.push(sailing.id);
 await db.sailingSeat.createMany({data:[1,2,3].map(i=>({sailingId:sailing.id,seatId:`${layoutId}-${i}`}))});
 return sailing;
}
async function paidBooking(options:{minutes?:number;status?:SailingStatus;method?:PaymentMethod;passengers?:number}={}) {
 const sailing=await makeSailing(options.minutes,options.status);
 const count=options.passengers??1;
 const booking=await db.booking.create({data:{sailingId:sailing.id,userId:ownerId,status:'PAID',totalCentavos:48000*count,terminalFeeCentavos:3000*count}});
 bookingIds.push(booking.id);
 for(let i=0;i<count;i++) {
  const seatId=`${layoutId}-${i+1}`;
  await db.bookingPassenger.create({data:{bookingId:booking.id,position:i,seatId,detailsCiphertext:encrypt({fullName:`Maria Private ${i}`,mobile:'+639123456789',emergencyContactName:'Jose Private',emergencyContactMobile:'+639987654321'}),category:'REGULAR_ADULT',age:30,gender:'FEMALE'}});
  await db.seatHold.create({data:{bookingId:booking.id,sailingId:sailing.id,seatId,expiresAt:sailing.arrival}});
  await db.sailingSeat.update({where:{sailingId_seatId:{sailingId:sailing.id,seatId}},data:{state:'SOLD'}});
 }
 const attempt=await db.paymentAttempt.create({data:{bookingId:booking.id,reference:`PAY-${booking.reference.replace('-','')}-01`,attemptNumber:1,idempotencyKey:randomUUID(),method:options.method??'GCASH',status:'SUCCEEDED',amountCentavos:booking.totalCentavos}});
 await db.payment.create({data:{bookingId:booking.id,attemptId:attempt.id,amountCentavos:booking.totalCentavos,method:options.method??'GCASH'}});
 await db.$transaction(tx=>issueTickets(tx,booking.id));
 const tickets=await db.ticket.findMany({where:{bookingId:booking.id},orderBy:{seatLabel:'asc'}});
 return {booking,sailing,tickets};
}
test('tickets, atomic boarding, booking-wide refunds and free rescheduling',async t=>{
 try {
  for(const [id,role] of [[ownerId,'PASSENGER'],[strangerId,'PASSENGER'],[gateId,'GATE_STAFF'],[counterId,'COUNTER_STAFF'],[adminId,'PORT_ADMIN']] as const){const u=await db.user.create({data:{id,email:`${id}@ticket-test.invalid`,fullName:'Test User',mobile:'+639123456789',passwordHash:'not-a-login-fixture',role,verifiedAt:now,consentAt:now}});users.set(id,u);}
  await db.port.createMany({data:[{id:`${prefix}-origin`,name:'Ticket Test Origin'},{id:`${prefix}-destination`,name:'Ticket Test Destination'}]});
  await db.route.create({data:{id:routeId,originId:`${prefix}-origin`,destinationId:`${prefix}-destination`,durationMinutes:90}});
  await db.vessel.create({data:{id:vesselId,name:'Ticket Test Ferry',operator:'Test Operator'}});
  await db.vesselSeatLayout.create({data:{id:layoutId,vesselId,className:'Business',deck:1}});
  await db.seat.createMany({data:[1,2,3].map(i=>({id:`${layoutId}-${i}`,layoutId,label:`B-${i}`,row:1,column:i}))});
  await t.test('fare/refund math uses integer centavos and includes the terminal fee once',()=>{assert.deepEqual(refundMath(48000,2000),{totalCentavos:48000,deductionCentavos:9600,refundCentavos:38400});});
  await t.test('issuance is payment-only, idempotent and maps passengers to their actual seats',async()=>{
   const fixture=await paidBooking({passengers:2});
   await db.$transaction(tx=>issueTickets(tx,fixture.booking.id));
   assert.equal(await db.ticket.count({where:{bookingId:fixture.booking.id}}),2);
   const first=await db.bookingPassenger.findFirstOrThrow({where:{bookingId:fixture.booking.id,position:0}});
   const ticket=await db.ticket.findUniqueOrThrow({where:{passengerId:first.id}});assert.equal(ticket.seatLabel,'B-1');
   const unpaid=await db.booking.create({data:{sailingId:fixture.sailing.id,userId:ownerId,status:'SEAT_HELD',totalCentavos:48000,terminalFeeCentavos:3000}});bookingIds.push(unpaid.id);
   await assert.rejects(db.$transaction(tx=>issueTickets(tx,unpaid.id)),/verified payment/);
   assert.equal(await db.ticket.count({where:{bookingId:unpaid.id}}),0);
  });
  await t.test('ticket detail is owner-only, QR has no passenger PII, and PDF is a real PDF',async()=>{
   const fixture=await paidBooking();const id=fixture.tickets[0].id;
   assert.equal((await request('GET',`/tickets/${id}`,undefined,strangerId)).statusCode,404);
   const response=await request('GET',`/tickets/${id}`);assert.equal(response.statusCode,200,response.body);
   const ticket=response.json().ticket;assert.match(ticket.qrDataUrl,/^data:image\/png;base64,/);
   const payload=decodeJwt(ticket.qrToken);assert.equal(payload.ticketId,id);assert.equal(payload.seat,'B-1');assert.equal(JSON.stringify(payload).includes('Maria'),false);assert.equal(JSON.stringify(payload).includes('639'),false);
   const pdf=await request('GET',`/tickets/${id}/pdf`);assert.equal(pdf.statusCode,200,pdf.body);assert.equal(pdf.rawPayload.subarray(0,4).toString(),'%PDF');
   const invoice=await request('GET',`/bookings/${fixture.booking.id}/invoice.pdf`);assert.equal(invoice.statusCode,200);assert.equal(invoice.rawPayload.subarray(0,4).toString(),'%PDF');
  });
  await t.test('boarding requires staff and BOARDING status; two simultaneous scans accept exactly once',async()=>{
   const fixture=await paidBooking();const token=(await request('GET',`/tickets/${fixture.tickets[0].id}`)).json().ticket.qrToken;
   assert.equal((await request('POST','/staff/boarding/scan',{token,gate:'Gate 04'})).statusCode,403);
   assert.equal((await request('POST','/staff/boarding/scan',{token,gate:'Gate 04'},gateId)).statusCode,409);
   await db.sailing.update({where:{id:fixture.sailing.id},data:{status:'BOARDING'}});
   assert.equal((await request('POST','/staff/boarding/scan',{token,gate:'Wrong gate'},gateId)).statusCode,409);
   const scans=await Promise.all([request('POST','/staff/boarding/scan',{token,gate:'Gate 04'},gateId),request('POST','/staff/boarding/scan',{token,gate:'Gate 04'},gateId)]);
   assert.deepEqual(scans.map(r=>r.statusCode).sort(),[200,409]);assert.ok(scans.find(r=>r.statusCode===409)!.json().firstScan.scannedAt);
   assert.equal(await db.boardingScan.count({where:{ticketId:fixture.tickets[0].id}}),1);
   assert.equal((await request('POST',`/tickets/${fixture.tickets[0].id}/refund`,{reason:'VOLUNTARY'})).statusCode,409);
  });
  await t.test('refund tier boundaries and exceptions match the configured policy',async()=>{
   for(const [minutes,deduction,eligible] of [[1440.1,4800,true],[1440,9600,true],[120,9600,true],[119.9,48000,false]] as const){const fixture=await paidBooking({minutes});const result=await request('GET',`/tickets/${fixture.tickets[0].id}/refund-estimate`);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().estimate.deductionCentavos,deduction,String(minutes));assert.equal(result.json().estimate.eligible,eligible,String(minutes));}
   const departed=await paidBooking({minutes:-60,status:'DEPARTED'});assert.equal((await request('POST',`/tickets/${departed.tickets[0].id}/refund`,{reason:'VOLUNTARY'})).statusCode,409);
   const cancelled=await paidBooking({minutes:-60,status:'CANCELLED'});const quote=(await request('GET',`/tickets/${cancelled.tickets[0].id}/refund-estimate`)).json().estimate;assert.equal(quote.eligible,true);assert.equal(quote.refundCentavos,48000);
   const scheduled=await paidBooking();assert.equal((await request('POST',`/tickets/${scheduled.tickets[0].id}/refund`,{reason:'PORT_CANCELLED'})).statusCode,409);
  });
  await t.test('duplicate refund requests create one refund, invalidate every QR and release all seats immediately',async()=>{
   const fixture=await paidBooking({passengers:2});const token=(await request('GET',`/tickets/${fixture.tickets[0].id}`)).json().ticket.qrToken;
   const requests=await Promise.all(fixture.tickets.map(ticket=>request('POST',`/tickets/${ticket.id}/refund`,{reason:'VOLUNTARY'})));
   assert.deepEqual(requests.map(r=>r.statusCode).sort(),[200,409]);
   const refund=requests.find(r=>r.statusCode===200)!.json().refund;assert.match(refund.reference,/^RF-MP\d{5}-01$/);assert.equal(refund.scope,'BOOKING');
   assert.equal(await db.refund.count({where:{bookingId:fixture.booking.id}}),1);assert.equal(await db.ticket.count({where:{bookingId:fixture.booking.id,status:'REFUNDED'}}),2);assert.equal(await db.seatHold.count({where:{bookingId:fixture.booking.id,releasedAt:null}}),0);
   assert.equal(await db.sailingSeat.count({where:{sailingId:fixture.sailing.id,state:'AVAILABLE'}}),3);
   assert.equal((await request('GET',`/tickets/${fixture.tickets[0].id}`)).json().ticket.qrToken,null);
   await db.sailing.update({where:{id:fixture.sailing.id},data:{status:'BOARDING'}});
   assert.equal((await request('POST','/staff/boarding/scan',{token,gate:'Gate 04'},gateId)).statusCode,409);
   await processRefundJob(ctx,{name:'refund.process',data:{refundId:refund.id}});assert.equal((await db.refund.findUniqueOrThrow({where:{id:refund.id}})).status,'PROCESSING');
   await processRefundJob(ctx,{name:'refund.process',data:{refundId:refund.id}});const settled=await db.refund.findUniqueOrThrow({where:{id:refund.id}});assert.equal(settled.status,'COMPLETED');
   await processRefundJob(ctx,{name:'refund.process',data:{refundId:refund.id}});assert.equal((await db.refund.findUniqueOrThrow({where:{id:refund.id}})).completedAt!.toISOString(),settled.completedAt!.toISOString());
   const tracked=await request('GET',`/refunds/${refund.id}`);assert.equal(tracked.statusCode,200);assert.equal(tracked.json().refund.payment.method,'GCASH');assert.equal(tracked.json().refund.timeline.length,3);assert.equal((await request('GET',`/refunds/${refund.id}`,undefined,strangerId)).statusCode,404);
  });
  await t.test('cash refund waits for a counter identity check and never auto-settles',async()=>{
   const fixture=await paidBooking({method:'COUNTER'});const refund=(await request('POST',`/tickets/${fixture.tickets[0].id}/refund`,{reason:'VOLUNTARY'})).json().refund;
   await processRefundJob(ctx,{name:'refund.process',data:{refundId:refund.id}});await processRefundJob(ctx,{name:'refund.process',data:{refundId:refund.id}});assert.equal((await db.refund.findUniqueOrThrow({where:{id:refund.id}})).status,'PROCESSING');
   assert.equal((await request('POST',`/staff/refunds/${refund.id}/complete`,{idChecked:true})).statusCode,403);
   assert.equal((await request('POST',`/staff/refunds/${refund.id}/complete`,{idChecked:false},counterId)).statusCode,400);
   assert.equal((await request('POST',`/staff/refunds/${refund.id}/complete`,{idChecked:true},counterId)).statusCode,200);
   assert.equal((await db.refund.findUniqueOrThrow({where:{id:refund.id}})).status,'COMPLETED');
  });
  await t.test('refunding an extra payment preserves the original paid ticket and checks the exact exception payment',async()=>{
   const fixture=await paidBooking();
   const original=await db.payment.findFirstOrThrow({where:{bookingId:fixture.booking.id}});
   const extraAttempt=await db.paymentAttempt.create({data:{bookingId:fixture.booking.id,reference:`PAY-${fixture.booking.reference.replace('-','')}-02`,attemptNumber:2,idempotencyKey:randomUUID(),method:'GCASH',status:'SUCCEEDED',amountCentavos:48000}});
   const extra=await db.payment.create({data:{bookingId:fixture.booking.id,attemptId:extraAttempt.id,method:'GCASH',amountCentavos:48000}});
   await db.notification.create({data:{userId:ownerId,kind:'PAYMENT_EXCEPTION',payload:{bookingId:fixture.booking.id,attemptId:extraAttempt.id,reason:'DUPLICATE_PAYMENT'}}});
   assert.equal((await request('POST',`/staff/payments/${original.id}/refund`,{},adminId)).statusCode,409);
   const response=await request('POST',`/staff/payments/${extra.id}/refund`,{},adminId);assert.equal(response.statusCode,200,response.body);
   const refund=response.json().refund;
   assert.equal((await db.booking.findUniqueOrThrow({where:{id:fixture.booking.id}})).status,'TICKET_ISSUED');
   assert.equal((await db.ticket.findUniqueOrThrow({where:{id:fixture.tickets[0].id}})).status,'TICKET_ISSUED');
   assert.equal(await db.seatHold.count({where:{bookingId:fixture.booking.id,releasedAt:null}}),1);
   await processRefundJob(ctx,{name:'refund.process',data:{refundId:refund.id}});await processRefundJob(ctx,{name:'refund.process',data:{refundId:refund.id}});
   assert.equal((await db.booking.findUniqueOrThrow({where:{id:fixture.booking.id}})).status,'TICKET_ISSUED');
   assert.equal((await db.refund.findUniqueOrThrow({where:{id:refund.id}})).status,'COMPLETED');
   const quote=(await request('GET',`/tickets/${fixture.tickets[0].id}/refund-estimate`)).json().estimate;assert.equal(quote.totalCentavos,48000);assert.equal(quote.eligible,true);
  });
  await t.test('free reschedule moves paid seats atomically and invalidates the previous QR',async()=>{
   const fixture=await paidBooking({status:'CANCELLED',passengers:2});const oldToken=(await request('GET',`/tickets/${fixture.tickets[0].id}`)).json().ticket.qrToken;
   const target=await makeSailing(2400);const selected=[`${layoutId}-2`,`${layoutId}-3`];
   const response=await request('POST',`/bookings/${fixture.booking.id}/reschedule`,{sailingId:target.id,seatIds:selected});assert.equal(response.statusCode,200,response.body);
   const moved=await db.booking.findUniqueOrThrow({where:{id:fixture.booking.id}});assert.equal(moved.sailingId,target.id);assert.equal(moved.totalCentavos,fixture.booking.totalCentavos);
   assert.equal(await db.sailingSeat.count({where:{sailingId:fixture.sailing.id,state:'AVAILABLE'}}),3);assert.equal(await db.sailingSeat.count({where:{sailingId:target.id,state:'SOLD'}}),2);
   await db.sailing.update({where:{id:target.id},data:{status:'BOARDING'}});
   assert.equal((await request('POST','/staff/boarding/scan',{token:oldToken,gate:'Gate 04'},gateId)).statusCode,409);
   const updated=(await request('GET',`/tickets/${fixture.tickets[0].id}`)).json().ticket;assert.equal(updated.seatLabel,'B-2');assert.equal(updated.version,2);
   assert.equal((await request('POST','/staff/boarding/scan',{token:updated.qrToken,gate:'Gate 04'},gateId)).statusCode,200);
  });
 } finally {
  for(const sailingId of sailingIds)for(let i=1;i<=3;i++)await redis.del(`seat:${sailingId}:${layoutId}-${i}`);
  await db.boardingScan.deleteMany({where:{ticket:{bookingId:{in:bookingIds}}}});await db.ticket.deleteMany({where:{bookingId:{in:bookingIds}}});await db.refund.deleteMany({where:{bookingId:{in:bookingIds}}});await db.payment.deleteMany({where:{bookingId:{in:bookingIds}}});await db.paymentAttempt.deleteMany({where:{bookingId:{in:bookingIds}}});await db.seatHold.deleteMany({where:{bookingId:{in:bookingIds}}});await db.bookingPassenger.deleteMany({where:{bookingId:{in:bookingIds}}});await db.booking.deleteMany({where:{id:{in:bookingIds}}});await db.sailingSeat.deleteMany({where:{sailingId:{in:sailingIds}}});await db.sailing.deleteMany({where:{id:{in:sailingIds}}});await db.seat.deleteMany({where:{layoutId}});await db.vesselSeatLayout.deleteMany({where:{id:layoutId}});await db.vessel.deleteMany({where:{id:vesselId}});await db.route.deleteMany({where:{id:routeId}});await db.port.deleteMany({where:{id:{in:[`${prefix}-origin`,`${prefix}-destination`]}}});await db.auditLog.deleteMany({where:{actorId:{in:[...users.keys()]}}});await db.notification.deleteMany({where:{userId:{in:[...users.keys()]}}});await db.user.deleteMany({where:{id:{in:[...users.keys()]}}});
  await app.close();await redis.quit();await db.$disconnect();
 }
});

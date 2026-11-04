import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import { PrismaClient, type User } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import type { AppContext } from '../src/context.js';

dotenv.config({path:new URL('../../../.env',import.meta.url),quiet:true});
if(!process.env.TEST_DATABASE_URL||!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'))throw new Error('Set TEST_DATABASE_URL to an isolated *_test database');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;process.env.NODE_ENV='test';process.env.PAYMENT_PROVIDER='mock';
const {registerPaymentRoutes,applyPaymentEvent,reconcilePayments,signPaymentEvent,verifyPaymentSignature}=await import('../src/payments.js');
const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.TEST_DATABASE_URL})});
const redis=new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:null});
const queue=new Queue(`payments-test-${randomUUID()}`,{connection:redis});
const namespace=`paytest-${randomUUID()}`,vesselId=`${namespace}-vessel`,layoutId=`${namespace}-layout`,originId=`${namespace}-origin`,destinationId=`${namespace}-destination`,routeId=`${namespace}-route`;
let now=new Date('2031-05-03T00:00:00Z'),actor:User;
const events:{room:string;event:string;payload:unknown}[]=[];
const app=Fastify();
app.setErrorHandler((error,_req,reply)=>reply.code((error as Error & {statusCode?:number}).statusCode??500).send({message:(error as Error).message}));
const ctx:AppContext={db,redis,jobs:queue,now:()=>now,auth:async()=>actor,verified:async()=>{if(!actor.verifiedAt)throw Object.assign(new Error('Verify email'),{statusCode:403});return actor;},staff:async(_req,roles)=>{if(!roles.includes(actor.role))throw Object.assign(new Error('Forbidden'),{statusCode:403});return actor;},emit:(room,event,payload)=>events.push({room,event,payload}),encrypt:value=>JSON.stringify(value),decrypt:value=>JSON.parse(value)};
registerPaymentRoutes(app,ctx);
let sailingId='';
const bookingIds:string[]=[];
const eventIds:string[]=[];
async function booking(holdSeconds=600,seatNumber=1){
 const booking=await db.booking.create({data:{userId:actor.id,sailingId,status:'SEAT_HELD',totalCentavos:48000,terminalFeeCentavos:3000,holdExpiresAt:new Date(+now+holdSeconds*1000)}});bookingIds.push(booking.id);
 await db.bookingPassenger.create({data:{bookingId:booking.id,position:0,seatId:`${layoutId}-${seatNumber}`,detailsCiphertext:ctx.encrypt({fullName:'Test Passenger',mobile:'+639123456789',emergencyContactName:'Test Contact',emergencyContactMobile:'+639123456789'}),category:'REGULAR_ADULT',age:30,gender:'MALE'}});
 await db.seatHold.create({data:{bookingId:booking.id,sailingId,seatId:`${layoutId}-${seatNumber}`,expiresAt:booking.holdExpiresAt!}});
 await db.sailingSeat.update({where:{sailingId_seatId:{sailingId,seatId:`${layoutId}-${seatNumber}`}},data:{state:'HELD',version:{increment:1}}});return booking;
}
const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,payload:JSON.stringify(payload),headers:{'content-type':'application/json'}});
async function pay(bookingId:string,method='GCASH',key=randomUUID()){
 const response=await post(`/bookings/${bookingId}/pay`,{method,idempotencyKey:key});assert.equal(response.statusCode,200,response.body);return response.json<{attempt:{id:string;reference:string;amountCentavos:number;providerReference:string;status:string};booking:{status:string}}>();
}
async function settle(attemptId:string,status:'SUCCEEDED'|'FAILED',eventId=randomUUID()){
 const attempt=await db.paymentAttempt.findUniqueOrThrow({where:{id:attemptId}});
 eventIds.push(eventId);
 const event={eventId,attemptId,status,amountCentavos:attempt.amountCentavos,currency:'PHP' as const,providerReference:attempt.providerReference!};
 const timestamp=String(Math.floor(+now/1000));
 return app.inject({method:'POST',url:'/payments/webhook/mock',payload:JSON.stringify(event),headers:{'content-type':'application/json','x-payment-timestamp':timestamp,'x-payment-signature':signPaymentEvent(event,timestamp)}});
}
async function cleanBookings(){
 for(const id of bookingIds){
  const attempts=await db.paymentAttempt.findMany({where:{bookingId:id},select:{id:true}});
  await db.webhookEvent.deleteMany({where:{eventId:{in:[...eventIds,...attempts.flatMap(a=>[`reconcile-${a.id}-SUCCEEDED`,`reconcile-${a.id}-FAILED`])]}}});
  await db.auditLog.deleteMany({where:{entityId:{in:[id,...attempts.map(a=>a.id)]}}});
  for(const hold of await db.seatHold.findMany({where:{bookingId:id}}))await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end;return 0",1,`seat:${hold.sailingId}:${hold.seatId}`,id);
  await db.ticket.deleteMany({where:{bookingId:id}});await db.refund.deleteMany({where:{bookingId:id}});await db.payment.deleteMany({where:{bookingId:id}});await db.paymentAttempt.deleteMany({where:{bookingId:id}});await db.seatHold.deleteMany({where:{bookingId:id}});await db.bookingPassenger.deleteMany({where:{bookingId:id}});await db.booking.delete({where:{id}});
 }
 bookingIds.length=0;events.length=0;
 await db.sailingSeat.updateMany({where:{sailingId},data:{state:'AVAILABLE'}});
}
test('payment state, signatures and reconciliation against PostgreSQL',async t=>{
 let userId='';
 try{
  actor=await db.user.create({data:{email:`${namespace}@example.test`,fullName:'Payment Test',mobile:'+639123456789',passwordHash:'test-only-no-login',consentAt:now,verifiedAt:now}});userId=actor.id;
  await db.port.createMany({data:[{id:originId,name:'Payment Test Origin'},{id:destinationId,name:'Payment Test Destination'}]});
  await db.route.create({data:{id:routeId,originId,destinationId,durationMinutes:90}});await db.vessel.create({data:{id:vesselId,name:'Payment Test Vessel',operator:'Test Operator'}});await db.vesselSeatLayout.create({data:{id:layoutId,vesselId,className:'Business',deck:1}});
  await db.seat.createMany({data:[1,2,3].map(n=>({id:`${layoutId}-${n}`,layoutId,label:`B-${n}`,row:1,column:n}))});
  const sailing=await db.sailing.create({data:{vesselId,routeId,departure:new Date(+now+8*3600000),arrival:new Date(+now+10*3600000),published:true,gate:'Gate 04',terminal:'Terminal 1'}});sailingId=sailing.id;
  await db.sailingSeat.createMany({data:[1,2,3].map(n=>({sailingId,seatId:`${layoutId}-${n}`}))});await db.fare.create({data:{sailingId,className:'Business',category:'REGULAR_ADULT',baseCentavos:45000,terminalFeeCentavos:3000}});
  await t.test('concurrent repeated pay creates one attempt and prevents switching methods',async()=>{
   const b=await booking();const key=randomUUID();const responses=await Promise.all([post(`/bookings/${b.id}/pay`,{method:'GCASH',idempotencyKey:key}),post(`/bookings/${b.id}/pay`,{method:'GCASH',idempotencyKey:key})]);
   assert.deepEqual(responses.map(r=>r.statusCode),[200,200]);assert.equal(responses[0].json().attempt.id,responses[1].json().attempt.id);assert.equal(await db.paymentAttempt.count({where:{bookingId:b.id}}),1);assert.match(responses[0].json().attempt.reference,/^PAY-MP\d{5}-01$/);
   assert.equal((await post(`/bookings/${b.id}/retry`,{method:'MAYA',idempotencyKey:randomUUID()})).statusCode,409);
   const attempt=responses[0].json().attempt;assert.equal((await settle(attempt.id,'SUCCEEDED')).statusCode,200);await cleanBookings();
  });
  await t.test('webhook validates signature and amount, deduplicates events and ignores late failure',async()=>{
   const b=await booking();const {attempt}=await pay(b.id);const eventId=randomUUID();
   assert.equal((await post('/payments/webhook/mock',{eventId,attemptId:attempt.id,status:'SUCCEEDED',amountCentavos:48000,currency:'PHP',providerReference:attempt.providerReference})).statusCode,401);
   const mismatch={eventId:randomUUID(),attemptId:attempt.id,status:'SUCCEEDED' as const,amountCentavos:1,currency:'PHP' as const,providerReference:attempt.providerReference};
   const stamp=String(Math.floor(+now/1000));
   assert.equal((await app.inject({method:'POST',url:'/payments/webhook/mock',payload:JSON.stringify(mismatch),headers:{'content-type':'application/json','x-payment-timestamp':stamp,'x-payment-signature':signPaymentEvent(mismatch,stamp)}})).statusCode,400);
   assert.equal((await settle(attempt.id,'SUCCEEDED',eventId)).statusCode,200);assert.equal((await settle(attempt.id,'SUCCEEDED',eventId)).json().duplicate,true);assert.equal((await settle(attempt.id,'FAILED')).statusCode,200);
   assert.equal(await db.ticket.count({where:{bookingId:b.id}}),1);assert.equal(await db.payment.count({where:{bookingId:b.id}}),1);assert.equal((await db.booking.findUniqueOrThrow({where:{id:b.id}})).status,'TICKET_ISSUED');
   const valid={eventId:randomUUID(),attemptId:attempt.id,status:'SUCCEEDED' as const,amountCentavos:48000,currency:'PHP' as const,providerReference:attempt.providerReference};const timestamp=String(Math.floor(+now/1000)-301);assert.equal(verifyPaymentSignature(valid,timestamp,signPaymentEvent(valid,timestamp),now),false);
   await cleanBookings();
  });
  await t.test('pending payment freezes seats beyond the original hold and issues only on provider proof',async()=>{
   const b=await booking(30);const {attempt}=await pay(b.id);const frozen=await db.booking.findUniqueOrThrow({where:{id:b.id}});assert.equal(+frozen.holdExpiresAt!,+now+900000);assert.equal(await db.ticket.count({where:{bookingId:b.id}}),0);
   now=new Date(+now+60000);assert.equal((await db.sailingSeat.findUniqueOrThrow({where:{sailingId_seatId:{sailingId,seatId:`${layoutId}-1`}}})).state,'PENDING_PAYMENT');assert.equal((await settle(attempt.id,'SUCCEEDED')).statusCode,200);assert.equal(await db.ticket.count({where:{bookingId:b.id}}),1);await cleanBookings();
  });
  await t.test('failure restores original expiry; retry has a sequential reference',async()=>{
   const b=await booking();const original=+b.holdExpiresAt!;const first=await pay(b.id);assert.equal((await settle(first.attempt.id,'FAILED')).statusCode,200);const failed=await db.booking.findUniqueOrThrow({where:{id:b.id}});assert.equal(failed.status,'PAYMENT_FAILED');assert.equal(+failed.holdExpiresAt!,original);
   const second=await pay(b.id,'MAYA');assert.match(second.attempt.reference,/-02$/);assert.equal((await settle(second.attempt.id,'SUCCEEDED')).statusCode,200);await cleanBookings();
  });
  await t.test('a paid provider result without webhook is reconciled exactly once',async()=>{
   const b=await booking();const {attempt}=await pay(b.id);await db.paymentAttempt.update({where:{id:attempt.id},data:{providerState:'SUCCEEDED'}});await reconcilePayments(ctx);await reconcilePayments(ctx);assert.equal(await db.ticket.count({where:{bookingId:b.id}}),1);assert.equal(await db.payment.count({where:{bookingId:b.id}}),1);await cleanBookings();
  });
  await t.test('late paid failure recovers while seats remain ours',async()=>{
   const b=await booking();const {attempt}=await pay(b.id);await settle(attempt.id,'FAILED');await db.paymentAttempt.update({where:{id:attempt.id},data:{providerState:'SUCCEEDED'}});await reconcilePayments(ctx);assert.equal((await db.booking.findUniqueOrThrow({where:{id:b.id}})).status,'TICKET_ISSUED');await cleanBookings();
  });
  await t.test('late paid result after seat loss records money and opens a refund exception',async()=>{
   const b=await booking(10);const {attempt}=await pay(b.id);now=new Date(+now+20000);await settle(attempt.id,'FAILED');assert.equal((await db.booking.findUniqueOrThrow({where:{id:b.id}})).status,'HOLD_EXPIRED');
   await booking(600,1);await db.paymentAttempt.update({where:{id:attempt.id},data:{providerState:'SUCCEEDED'}});await reconcilePayments(ctx);assert.equal(await db.ticket.count({where:{bookingId:b.id}}),0);assert.equal(await db.payment.count({where:{bookingId:b.id}}),1);assert.equal(await db.notification.count({where:{userId,kind:'PAYMENT_EXCEPTION'}}),1);await cleanBookings();
  });
  await t.test('hard pending timeout releases the seat and blocks a new pay without reselection',async()=>{
   const b=await booking(10);await pay(b.id);now=new Date(+now+901000);await reconcilePayments(ctx);assert.equal((await db.booking.findUniqueOrThrow({where:{id:b.id}})).status,'HOLD_EXPIRED');assert.equal((await post(`/bookings/${b.id}/retry`,{method:'GCASH',idempotencyKey:randomUUID()})).statusCode,409);await cleanBookings();
  });
  await t.test('counter slip keeps fee included and staff payment reuses the one counter attempt',async()=>{
   const b=await booking();const response=await pay(b.id,'COUNTER');assert.equal(response.booking.status,'COUNTER_PENDING');assert.equal(response.attempt.amountCentavos,48000);
   assert.equal((await post('/payments/mock/settle',{attemptId:response.attempt.id,outcome:'SUCCEEDED'})).statusCode,409);
   const slip=await app.inject(`/bookings/${b.id}/slip.pdf`);assert.equal(slip.statusCode,200);assert.match(slip.headers['content-type'] as string,/application\/pdf/);assert.equal(slip.rawPayload.subarray(0,4).toString(),'%PDF');
   assert.equal((await post(`/staff/bookings/${b.id}/counter-payment`,{idChecked:true})).statusCode,403);actor={...actor,role:'COUNTER_STAFF'};assert.equal((await post(`/staff/bookings/${b.id}/counter-payment`,{idChecked:true})).statusCode,200);assert.equal((await post(`/staff/bookings/${b.id}/counter-payment`,{idChecked:true})).statusCode,200);assert.equal(await db.paymentAttempt.count({where:{bookingId:b.id}}),1);assert.equal(await db.ticket.count({where:{bookingId:b.id}}),1);actor={...actor,role:'PASSENGER'};await cleanBookings();
  });
 }finally{
  if(sailingId){await cleanBookings();await db.fare.deleteMany({where:{sailingId}});await db.sailingSeat.deleteMany({where:{sailingId}});await db.sailing.delete({where:{id:sailingId}});}
  await db.seat.deleteMany({where:{layoutId}});await db.vesselSeatLayout.deleteMany({where:{id:layoutId}});await db.vessel.deleteMany({where:{id:vesselId}});await db.route.deleteMany({where:{id:routeId}});await db.port.deleteMany({where:{id:{in:[originId,destinationId]}}});
  if(userId){await db.notification.deleteMany({where:{userId}});await db.auditLog.deleteMany({where:{OR:[{actorId:userId},{entityId:{in:bookingIds}}]}});await db.user.deleteMany({where:{id:userId}});}
  await queue.obliterate({force:true});await queue.close();await redis.quit();await db.$disconnect();await app.close();
 }
});

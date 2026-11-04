import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role, User } from '@prisma/client';
import { z } from 'zod';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';

dotenv.config({ path: new URL('../../../.env',import.meta.url),quiet:true });
if(!process.env.TEST_DATABASE_URL||!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'))throw new Error('Set TEST_DATABASE_URL to an isolated *_test database');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;process.env.NODE_ENV='test';
const {registerStaffRoutes}=await import('../src/staff.js');
const {registerNotificationRoutes,processNotificationJob}=await import('../src/notifications.js');
const {encrypt,decrypt}=await import('../src/encryption.js');
const {config}=await import('../src/config.js');
const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.TEST_DATABASE_URL})});
const redis=new Redis('redis://127.0.0.1:6379/15');
const key=`staff-test-${randomUUID()}`;
const app=Fastify();await app.register(cookie);
const now=new Date('2031-01-12T00:00:00Z');
const userIds:string[]=[],portIds:string[]=[],routeIds:string[]=[],vesselIds:string[]=[],layoutIds:string[]=[],sailingIds:string[]=[],bookingIds:string[]=[];
const users=new Map<string,User>();
const events:{room:string;event:string;payload:unknown}[]=[];
const auth=async(req:{cookies:Record<string,string|undefined>})=>{const user=users.get(req.cookies.test_user??'');if(!user)throw Object.assign(new Error('Sign in'),{statusCode:401});return user;};
const ctx={db,redis,now:()=>now,auth,verified:auth,staff:async(req:{cookies:Record<string,string|undefined>},roles:Role[])=>{const user=await auth(req);if(!roles.includes(user.role))throw Object.assign(new Error('Forbidden'),{statusCode:403});return user;},emit:(room:string,event:string,payload:unknown)=>events.push({room,event,payload}),jobs:{add:async()=>({id:'test-job'})} as unknown as Queue,encrypt,decrypt};
registerStaffRoutes(app,ctx);registerNotificationRoutes(app,ctx);
app.setErrorHandler((error,req,reply)=>{if(error instanceof z.ZodError)return reply.code(400).send({message:'Invalid request'});const status=(error as {statusCode?:number;code?:string}).statusCode??((error as {code?:string}).code==='P2025'?404:500);return reply.code(status).send({message:(error as Error).message});});
let admin:User,counter:User,passenger:User;
const request=(method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,user?:User)=>app.inject({method,url,...(payload===undefined?{}:{payload:JSON.stringify(payload)}),headers:{'content-type':'application/json',...(user?{cookie:`test_user=${user.id}`}:{})}});
const expectStatus=async(response:ReturnType<typeof request>,status=200)=>{const r=await response;assert.equal(r.statusCode,status,r.body);return r.json();};
let originId='',destinationId='',routeId='',vesselId='',layoutId='',sailingId='',bookingId='';
test('staff operations, manifests and notification outbox',async t=>{
 try {
  for(const role of ['PORT_ADMIN','COUNTER_STAFF','PASSENGER'] as const){const u=await db.user.create({data:{email:`${role.toLowerCase()}-${key}@example.test`,fullName:'Staff Test',mobile:'+639123456789',passwordHash:'not-a-login-password',role,verifiedAt:now,consentAt:now}});users.set(u.id,u);userIds.push(u.id);if(role==='PORT_ADMIN')admin=u;else if(role==='COUNTER_STAFF')counter=u;else passenger=u;}
  await t.test('every staff action is role guarded',async()=>{await expectStatus(request('GET','/staff/dashboard'),401);await expectStatus(request('GET','/staff/dashboard',undefined,passenger),403);await expectStatus(request('GET','/staff/dashboard',undefined,counter));await expectStatus(request('POST','/staff/vessels',{name:'Forbidden',operator:'None'},counter),403);});
  await t.test('admin creates ports, route, vessel and data-driven layout',async()=>{
   for(const suffix of ['origin','destination']){const r=await expectStatus(request('POST','/staff/ports',{id:`${key}-${suffix}`,name:`Test ${suffix}`,northernPalawan:false},admin));portIds.push(r.port.id);if(suffix==='origin')originId=r.port.id;else destinationId=r.port.id;}
   let r=await expectStatus(request('POST','/staff/routes',{id:`${key}-route`,originId,destinationId,durationMinutes:90},admin));routeId=r.route.id;routeIds.push(routeId);
   r=await expectStatus(request('POST','/staff/vessels',{id:`${key}-vessel`,name:'Staff Test Ferry',operator:'Test Operator'},admin));vesselId=r.vessel.id;vesselIds.push(vesselId);
   r=await expectStatus(request('POST',`/staff/vessels/${vesselId}/layouts`,{id:`${key}-layout`,className:'Business',deck:1,seats:Array.from({length:4},(_,i)=>({id:`${key}-seat-${i+1}`,label:`B-${i+1}`,row:1,column:i+1}))},admin));layoutId=r.layout.id;layoutIds.push(layoutId);assert.equal(r.layout.seats.length,4);
  });
  await t.test('invalid routes and duplicate seat labels do not persist',async()=>{
   await expectStatus(request('POST','/staff/routes',{originId,destinationId:originId,durationMinutes:90},admin),400);
   await expectStatus(request('POST',`/staff/vessels/${vesselId}/layouts`,{className:'Bad',deck:2,seats:[{label:'X',row:1,column:1},{label:'X',row:1,column:2}]},admin),400);
   assert.equal(await db.vesselSeatLayout.count({where:{vesselId}}),1);
  });
  await t.test('publishing requires pricing and creates all inventory atomically',async()=>{
   const base={routeId,vesselId,departure:new Date(+now+8*3600000).toISOString(),arrival:new Date(+now+9.5*3600000).toISOString(),gate:'Gate 04',terminal:'Terminal 1',published:true};
   await expectStatus(request('POST','/staff/sailings',base,admin),400);assert.equal(await db.sailing.count({where:{routeId}}),0);
   const r=await expectStatus(request('POST','/staff/sailings',{...base,fares:[{className:'Business',category:'REGULAR_ADULT',baseCentavos:45000,terminalFeeCentavos:3000}]},admin));sailingId=r.sailing.id;sailingIds.push(sailingId);assert.equal(await db.sailingSeat.count({where:{sailingId}}),4);
  });
  await t.test('seat overrides update inventory version and broadcast only after commit',async()=>{
   const r=await expectStatus(request('PATCH',`/staff/sailings/${sailingId}/seats/${key}-seat-1`,{state:'BLOCKED'},admin));assert.equal(r.seat.state,'BLOCKED');assert.equal(r.seat.version,1);assert.ok(events.some(e=>e.room===`sailing:${sailingId}`&&e.event==='seat.updated'));
   const dashboard=await expectStatus(request('GET','/staff/dashboard',undefined,counter));const row=dashboard.sailings.find((s:{id:string})=>s.id===sailingId);assert.equal(row.inventoryCounts.BLOCKED,1);assert.equal(row.totalSeats,4);
  });
  await t.test('held or assigned seats cannot be overridden',async()=>{
   const b=await db.booking.create({data:{userId:passenger.id,sailingId,status:'TICKET_ISSUED',totalCentavos:48000,terminalFeeCentavos:3000}});bookingId=b.id;bookingIds.push(b.id);
   await db.seatHold.create({data:{bookingId:b.id,sailingId,seatId:`${key}-seat-2`,expiresAt:new Date(+now+3600000)}});
   await db.sailingSeat.update({where:{sailingId_seatId:{sailingId,seatId:`${key}-seat-2`}},data:{state:'SOLD'}});
   await expectStatus(request('PATCH',`/staff/sailings/${sailingId}/seats/${key}-seat-2`,{state:'BLOCKED'},admin),409);
   const p=await db.bookingPassenger.create({data:{bookingId:b.id,seatId:`${key}-seat-2`,position:0,detailsCiphertext:encrypt({fullName:'=1+1',mobile:'+639123456789',emergencyContactName:'Emergency Test',emergencyContactMobile:'+639987654321'}),category:'REGULAR_ADULT',age:30,gender:'FEMALE'}});
   await db.ticket.create({data:{bookingId:b.id,passengerId:p.id,seatLabel:'B-2'}});
  });
  await t.test('manifest exports contain decrypted staff-only details and escape spreadsheet formulas',async()=>{
   await expectStatus(request('GET',`/staff/sailings/${sailingId}/manifest`,undefined,passenger),403);
   const data=await expectStatus(request('GET',`/staff/sailings/${sailingId}/manifest`,undefined,counter));assert.equal(data.passengers[0].fullName,'=1+1');assert.equal(data.passengers[0].className,'Business');assert.equal(data.boardedCount,0);
   const csv=await request('GET',`/staff/sailings/${sailingId}/manifest.csv`,undefined,counter);assert.equal(csv.statusCode,200);assert.match(csv.body,/"'=1\+1"/);
   const pdf=await request('GET',`/staff/sailings/${sailingId}/manifest.pdf`,undefined,counter);assert.equal(pdf.statusCode,200);assert.equal(pdf.rawPayload.subarray(0,4).toString(),'%PDF');
  });
  await t.test('staff finder exposes only expected booking reference and passenger details',async()=>{
   const booking=await db.booking.findUniqueOrThrow({where:{id:bookingId}});
   await expectStatus(request('GET',`/staff/bookings?reference=${booking.reference}`,undefined,passenger),403);
   const r=await expectStatus(request('GET',`/staff/bookings?reference=${booking.reference}`,undefined,counter));assert.equal(r.bookings.length,1);assert.equal(r.bookings[0].passengers[0].fullName,'=1+1');assert.equal(r.bookings[0].user.passwordHash,undefined);
  });
  await t.test('illegal status transitions fail and delay notifies affected users with recovery options',async()=>{
   await expectStatus(request('POST',`/staff/sailings/${sailingId}/status`,{status:'DEPARTED'},admin),409);
   await expectStatus(request('POST',`/staff/sailings/${sailingId}/status`,{status:'DELAYED'},admin));
   const notifications=await db.notification.findMany({where:{userId:passenger.id}});assert.ok(notifications.some(n=>(n.payload as {freeRescheduleAvailable?:boolean}).freeRescheduleAvailable));
   assert.ok(events.some(e=>e.room===`user:${passenger.id}`&&e.event==='sailing.updated'));
  });
  await t.test('Northern Palawan boarding requires manifest cleared at least four hours before departure',async()=>{
   await expectStatus(request('PATCH',`/staff/ports/${destinationId}`,{northernPalawan:true},admin));
   await expectStatus(request('POST',`/staff/sailings/${sailingId}/status`,{status:'BOARDING'},admin),409);
   await expectStatus(request('POST',`/staff/sailings/${sailingId}/manifest-clear`,{confirmed:true},admin));
   await expectStatus(request('POST',`/staff/sailings/${sailingId}/status`,{status:'BOARDING'},admin));
   const clearance=await db.sailing.findUniqueOrThrow({where:{id:sailingId}});assert.equal(clearance.manifestClearedBy,admin.id);
   const second=await expectStatus(request('POST','/staff/sailings',{routeId,vesselId,departure:new Date(+now+3*3600000).toISOString(),arrival:new Date(+now+4.5*3600000).toISOString(),gate:'Gate 04',terminal:'Terminal 1',fares:[{className:'Business',category:'REGULAR_ADULT',baseCentavos:45000,terminalFeeCentavos:3000}]},admin));sailingIds.push(second.sailing.id);
   await expectStatus(request('POST',`/staff/sailings/${second.sailing.id}/manifest-clear`,{confirmed:true},admin),409);
  });
  await t.test('departure completes only bookings whose every passenger has boarded',async()=>{
   const first=await db.ticket.findFirstOrThrow({where:{bookingId}});
   await db.ticket.update({where:{id:first.id},data:{status:'BOARDED'}});
   await db.boardingScan.create({data:{ticketId:first.id,staffId:admin.id,gate:'Gate 04',scannedAt:now}});
   const mixed=await db.booking.create({data:{userId:passenger.id,sailingId,status:'TICKET_ISSUED',totalCentavos:96000,terminalFeeCentavos:6000}});bookingIds.push(mixed.id);
   for(let n=0;n<2;n++){
    const seatId=`${key}-seat-${n+3}`;
    const person=await db.bookingPassenger.create({data:{bookingId:mixed.id,seatId,position:n,detailsCiphertext:encrypt({fullName:`Mixed passenger ${n+1}`,mobile:'+639123456789'}),category:'REGULAR_ADULT',age:30,gender:'OTHER'}});
    await db.seatHold.create({data:{bookingId:mixed.id,sailingId,seatId,expiresAt:new Date(+now+9*3600000)}});
    await db.sailingSeat.update({where:{sailingId_seatId:{sailingId,seatId}},data:{state:'SOLD'}});
    const ticket=await db.ticket.create({data:{bookingId:mixed.id,passengerId:person.id,seatLabel:`B-${n+3}`,status:n===0?'BOARDED':'TICKET_ISSUED'}});
    if(n===0)await db.boardingScan.create({data:{ticketId:ticket.id,staffId:admin.id,gate:'Gate 04',scannedAt:now}});
   }
   await expectStatus(request('POST',`/staff/sailings/${sailingId}/status`,{status:'DEPARTED'},admin));
   assert.equal((await db.booking.findUniqueOrThrow({where:{id:bookingId}})).status,'COMPLETED');
   assert.equal((await db.booking.findUniqueOrThrow({where:{id:mixed.id}})).status,'TICKET_ISSUED');
   await expectStatus(request('POST',`/staff/sailings/${sailingId}/status`,{status:'ARRIVED'},admin));
   assert.equal((await db.booking.findUniqueOrThrow({where:{id:mixed.id}})).status,'TICKET_ISSUED');
  });
  await t.test('notification inbox is owner-scoped and reading another user notification fails',async()=>{
   const notification=await db.notification.create({data:{userId:passenger.id,kind:'TEST_MESSAGE',payload:{message:'Your ferry test update.'}}});
   await expectStatus(request('POST',`/notifications/${notification.id}/read`,{},admin),404);
   const inbox=await expectStatus(request('GET','/notifications',undefined,passenger));assert.ok(inbox.notifications.some((n:{id:string})=>n.id===notification.id));
   await expectStatus(request('POST',`/notifications/${notification.id}/read`,{},passenger));assert.ok((await db.notification.findUniqueOrThrow({where:{id:notification.id}})).readAt);
  });
  await t.test('durable email delivery is idempotent and makes no false SMS delivery claim',async()=>{
   const notification=await db.notification.create({data:{userId:passenger.id,kind:'DELIVERY_TEST',payload:{message:'Your sailing delivery check.'}}});
   await processNotificationJob(ctx,{name:'notification.deliver',data:{notificationId:notification.id}});
   await processNotificationJob(ctx,{name:'notification.deliver',data:{notificationId:notification.id}});
   const record=await db.notification.findUniqueOrThrow({where:{id:notification.id}});assert.equal(record.attempts,1);assert.ok(record.deliveredAt);
   const inbox=await(await fetch('http://127.0.0.1:8025/api/v1/messages')).json() as {messages:{ID:string;To:{Address:string}[]}[]};const sent=inbox.messages.filter(m=>m.To.some(t=>t.Address===passenger.email));assert.equal(sent.length,1);
   const content=await(await fetch(`http://127.0.0.1:8025/api/v1/message/${sent[0].ID}`)).json() as {Text:string};assert.match(content.Text,/SMS delivery is not configured/);
  });
 } finally {
  await db.boardingScan.deleteMany({where:{ticket:{bookingId:{in:bookingIds}}}});await db.ticket.deleteMany({where:{bookingId:{in:bookingIds}}});await db.refund.deleteMany({where:{bookingId:{in:bookingIds}}});await db.payment.deleteMany({where:{bookingId:{in:bookingIds}}});await db.paymentAttempt.deleteMany({where:{bookingId:{in:bookingIds}}});await db.seatHold.deleteMany({where:{bookingId:{in:bookingIds}}});await db.bookingPassenger.deleteMany({where:{bookingId:{in:bookingIds}}});await db.booking.deleteMany({where:{id:{in:bookingIds}}});await db.fare.deleteMany({where:{sailingId:{in:sailingIds}}});await db.sailingSeat.deleteMany({where:{sailingId:{in:sailingIds}}});await db.sailing.deleteMany({where:{id:{in:sailingIds}}});await db.seat.deleteMany({where:{layoutId:{in:layoutIds}}});await db.vesselSeatLayout.deleteMany({where:{id:{in:layoutIds}}});await db.vessel.deleteMany({where:{id:{in:vesselIds}}});await db.route.deleteMany({where:{id:{in:routeIds}}});await db.port.deleteMany({where:{id:{in:portIds}}});await db.notification.deleteMany({where:{userId:{in:userIds}}});await db.auditLog.deleteMany({where:{actorId:{in:userIds}}});await db.user.deleteMany({where:{id:{in:userIds}}});await app.close();await redis.quit();await db.$disconnect();
 }
});

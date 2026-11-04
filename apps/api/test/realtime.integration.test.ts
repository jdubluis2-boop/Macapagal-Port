import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { SignJWT } from 'jose';
import { io, type Socket } from 'socket.io-client';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

dotenv.config({path:new URL('../../../.env',import.meta.url),quiet:true});
if(!process.env.TEST_DATABASE_URL||!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'))throw new Error('Set TEST_DATABASE_URL to an isolated *_test database');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
process.env.REDIS_URL='redis://127.0.0.1:6379/15';
process.env.NODE_ENV='test';
process.env.ENABLE_WORKERS='false';
const {buildApp,db}=await import('../src/app.js');
const {config}=await import('../src/config.js');
const app=await buildApp({workers:false});
const namespace=`realtime-${randomUUID()}`,originId=`${namespace}-origin`,destinationId=`${namespace}-destination`,routeId=`${namespace}-route`,vesselId=`${namespace}-vessel`,layoutId=`${namespace}-layout`;
const seatId=`${layoutId}-1`;
const connections:Socket[]=[];
const bookingIds:string[]=[];
const userIds:string[]=[];
let sailingId='';
type Snapshot={sailingId:string;serverTime:string;seats:{seatId:string;state:string;version:number}[]};
type Delta={seatId:string;state:string;version:number};
function event<T>(socket:Socket,name:string,predicate:(data:T)=>boolean=()=>true):Promise<T>{
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{socket.off(name,listener);reject(new Error(`Timed out waiting for ${name}`));},8000);
  const listener=(data:T)=>{if(!predicate(data))return;clearTimeout(timer);socket.off(name,listener);resolve(data);};
  socket.on(name,listener);
 });
}
async function connect(address:string,cookie?:string){
 const socket=io(address,{transports:['websocket'],autoConnect:false,reconnection:false,extraHeaders:{Origin:config.WEB_ORIGIN,...(cookie?{Cookie:cookie}:{})}});
 connections.push(socket);
 const ready=event<{serverTime:string;serverTimeMs:number}>(socket,'server.time');
 const connected=new Promise<void>((resolve,reject)=>{socket.once('connect',()=>resolve());socket.once('connect_error',reject);});
 socket.connect();await connected;
 const serverTime=await ready;assert.ok(Number.isFinite(serverTime.serverTimeMs));assert.ok(Math.abs(new Date(serverTime.serverTime).getTime()-serverTime.serverTimeMs)<=100);
 return socket;
}
async function snapshot(socket:Socket){const pending=event<Snapshot>(socket,'seats.snapshot',data=>data.sailingId===sailingId);socket.emit('subscribe',{sailingId});return pending;}
function assertPublicSnapshot(data:Snapshot){
 assert.deepEqual(Object.keys(data).sort(),['sailingId','serverTime','seats'].sort());
 for(const seat of data.seats)assert.deepEqual(Object.keys(seat).sort(),['seatId','state','version'].sort());
 assert.ok(!JSON.stringify(data).includes('@example.test'));
 assert.ok(!JSON.stringify(data).includes('Passenger Private Name'));
}
async function userSession(label:string){
 const user=await db.user.create({data:{email:`${namespace}-${label}@example.test`,fullName:`Private ${label}`,mobile:'+639123456789',passwordHash:'test-only-no-password-login',verifiedAt:new Date(),consentAt:new Date()}});userIds.push(user.id);
 const session=await db.session.create({data:{userId:user.id,expiresAt:new Date(Date.now()+3600000)}});
 const token=await new SignJWT({sid:session.id}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuer('macapagal-api').setAudience('macapagal-web').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(config.JWT_SECRET));
 return{user,cookie:`mp_session=${token}`};
}
const request=(url:string,cookie:string,payload:unknown={})=>app.inject({method:'POST',url,remoteAddress:'198.51.100.254',headers:{origin:config.WEB_ORIGIN,cookie,'content-type':'application/json'},payload:JSON.stringify(payload)});

test('Socket.IO snapshots, versioned deltas and private rooms',async t=>{
 try{
  await db.port.createMany({data:[{id:originId,name:'Realtime Test Origin'},{id:destinationId,name:'Realtime Test Destination'}]});await db.route.create({data:{id:routeId,originId,destinationId,durationMinutes:90}});await db.vessel.create({data:{id:vesselId,name:'Realtime Test Ferry',operator:'Test Operator'}});await db.vesselSeatLayout.create({data:{id:layoutId,vesselId,className:'Business',deck:1}});await db.seat.create({data:{id:seatId,layoutId,label:'B-1',row:1,column:1}});
  const departure=new Date(Date.now()+2*86400000);
  const sailing=await db.sailing.create({data:{vesselId,routeId,departure,arrival:new Date(+departure+90*60000),published:true,gate:'Gate 04',terminal:'Terminal 1'}});sailingId=sailing.id;
  await db.sailingSeat.create({data:{sailingId,seatId}});await db.fare.create({data:{sailingId,className:'Business',category:'REGULAR_ADULT',baseCentavos:45000,terminalFeeCentavos:3000}});
  const owner=await userSession('owner'),other=await userSession('other');
  const address=await app.listen({host:'127.0.0.1',port:0});
  const ownerSocket=await connect(address,owner.cookie),otherSocket=await connect(address,other.cookie),anonymous=await connect(address);
  let first:Snapshot;
  await t.test('anonymous published-sailing snapshot contains only public inventory',async()=>{
   first=await snapshot(anonymous);assertPublicSnapshot(first);assert.equal(first.seats.length,1);assert.equal(first.seats[0].state,'AVAILABLE');assert.equal(first.seats[0].version,0);
  });
  const ownerTicks:unknown[]=[],otherTicks:unknown[]=[],anonymousTicks:unknown[]=[];
  ownerSocket.on('hold.tick',data=>ownerTicks.push(data));otherSocket.on('hold.tick',data=>otherTicks.push(data));anonymous.on('hold.tick',data=>anonymousTicks.push(data));
  otherSocket.emit('subscribe',{room:`user:${owner.user.id}`});
  anonymous.emit('subscribe',{room:`user:${owner.user.id}`});
  await snapshot(otherSocket);await snapshot(ownerSocket);
  let bookingId='',heldVersion=0;
  await t.test('booking mutation broadcasts versioned seat delta and owner-only hold metadata',async()=>{
   const ownTick=event<{bookingId:string;holdExpiresAt:string}>(ownerSocket,'hold.tick');
   const publicDelta=event<Delta>(anonymous,'seat.updated',data=>data.seatId===seatId&&data.state==='HELD');
   const response=await request('/bookings',owner.cookie,{sailingId,seatIds:[seatId],passengers:[{fullName:'Passenger Private Name',mobile:'+639123456789',category:'REGULAR_ADULT',age:30,gender:'FEMALE',emergencyContactName:'Private Emergency Contact',emergencyContactMobile:'+639987654321'}]});
   assert.equal(response.statusCode,200,response.body);bookingId=response.json().booking.id;bookingIds.push(bookingId);
   const [tick,delta]=await Promise.all([ownTick,publicDelta]);assert.equal(tick.bookingId,bookingId);assert.ok(new Date(tick.holdExpiresAt)>new Date());assert.ok(delta.version>first!.seats[0].version);heldVersion=delta.version;
   assert.deepEqual(Object.keys(delta).sort(),['seatId','state','version'].sort());
   // Ordered websocket snapshot barriers follow all events emitted by the HTTP mutation.
   // An unauthorized private event would arrive before these snapshots on the same connection.
   assertPublicSnapshot(await snapshot(otherSocket));assertPublicSnapshot(await snapshot(anonymous));
   assert.equal(ownerTicks.length,1);assert.equal(otherTicks.length,0);assert.equal(anonymousTicks.length,0);
  });
  let reconnected:Socket;
  await t.test('reconnect obtains full current snapshot before subsequent newer deltas',async()=>{
   anonymous.disconnect();reconnected=await connect(address);
   const current=await snapshot(reconnected);assertPublicSnapshot(current);assert.equal(current.seats[0].state,'HELD');assert.ok(current.seats[0].version>=heldVersion);
   const released=event<Delta>(reconnected,'seat.updated',data=>data.seatId===seatId&&data.state==='AVAILABLE');
   const response=await request(`/bookings/${bookingId}/release`,owner.cookie);assert.equal(response.statusCode,200,response.body);
   const delta=await released;assert.ok(delta.version>current.seats[0].version);
   assert.equal((await snapshot(reconnected)).seats[0].state,'AVAILABLE');
  });
  await t.test('logout revokes the database session and disconnects its authenticated socket',async()=>{
   const disconnected=event<string>(ownerSocket,'disconnect');
   const response=await request('/auth/logout',owner.cookie);assert.equal(response.statusCode,200,response.body);assert.equal(await disconnected,'io server disconnect');assert.equal(ownerSocket.connected,false);assert.equal(otherSocket.connected,true);
   const guest=await connect(address,owner.cookie);const leaked:unknown[]=[];guest.on('hold.tick',value=>leaked.push(value));await snapshot(guest);assert.equal(leaked.length,0);
  });
 }finally{
  for(const socket of connections)socket.disconnect();
  const redis=new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:null});
  const queue=new Queue('macapagal',{connection:redis});
  for(const job of await queue.getJobs(['delayed','waiting','failed','completed']))if(bookingIds.includes(job.data.bookingId))await job.remove().catch(()=>{});
  for(const bookingId of bookingIds){
   await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end;return 0",1,`seat:${sailingId}:${seatId}`,bookingId);
   await db.auditLog.deleteMany({where:{entityId:bookingId}});await db.seatHold.deleteMany({where:{bookingId}});await db.bookingPassenger.deleteMany({where:{bookingId}});await db.booking.deleteMany({where:{id:bookingId}});
  }
  if(sailingId){await db.fare.deleteMany({where:{sailingId}});await db.sailingSeat.deleteMany({where:{sailingId}});await db.sailing.deleteMany({where:{id:sailingId}});}
  await db.seat.deleteMany({where:{layoutId}});await db.vesselSeatLayout.deleteMany({where:{id:layoutId}});await db.vessel.deleteMany({where:{id:vesselId}});await db.route.deleteMany({where:{id:routeId}});await db.port.deleteMany({where:{id:{in:[originId,destinationId]}}});
  await db.user.deleteMany({where:{id:{in:userIds}}});
  await queue.close();await redis.quit();await app.close();
 }
});

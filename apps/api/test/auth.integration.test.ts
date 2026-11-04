import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../../../.env', import.meta.url), quiet: true });
// Integration tests refuse the development database. Supply an isolated database explicitly.
if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')) throw new Error('Set TEST_DATABASE_URL to an isolated *_test database');
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.REDIS_URL = 'redis://127.0.0.1:6379/15';
const { buildApp, db } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const digest = (s:string) => createHmac('sha256',config.TOKEN_PEPPER).update(s).digest('hex');
const app = await buildApp();
const origin = config.WEB_ORIGIN;
const account = { email:`test-${Date.now()}@example.test`, fullName:'Maria Test', mobile:'+63 912 345 6789', password:'Password123', confirmPassword:'Password123', consent:true };
const post = (url:string,payload:unknown,cookie?:string) => app.inject({method:'POST',url,payload: JSON.stringify(payload),headers:{'content-type':'application/json',origin,...(cookie?{cookie}:{})}});
async function inboxText(subject:string) {
 const list=await (await fetch('http://127.0.0.1:8025/api/v1/messages')).json() as {messages:{ID:string;Subject:string;To:{Address:string}[]}[]};
 const found=list.messages.find(m=>m.Subject===subject&&m.To.some(t=>t.Address===account.email));assert.ok(found,'email was delivered');
 const message=await (await fetch(`http://127.0.0.1:8025/api/v1/message/${found.ID}`)).json() as {Text:string};return message.Text;
}
test('authentication and database integration', async t => {
 try {
 await t.test('health checks PostgreSQL and Redis',async()=>assert.equal((await app.inject('/health')).statusCode,200));
 await t.test('origin guard rejects cross-site registration',async()=>assert.equal((await app.inject({method:'POST',url:'/auth/register',payload:account})).statusCode,403));
 await t.test('register stores an Argon2 hash, consent, and an unverified account',async()=>{
  assert.equal((await post('/auth/register',account)).statusCode,202);
  const user=await db.user.findUniqueOrThrow({where:{email:account.email}});assert.equal(user.verifiedAt,null);assert.match(user.passwordHash,/^\$argon2id\$/);assert.ok(user.consentAt);
 });
 let session='';
 await t.test('login sets an HTTP-only cookie; unverified user cannot book',async()=>{
  const r=await post('/auth/login',{email:account.email,password:account.password});assert.equal(r.statusCode,200);
  const cookie=r.headers['set-cookie'] as string;assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Lax/);session=cookie.split(';')[0];
  assert.equal((await app.inject({url:'/auth/booking-access',headers:{cookie:session}})).statusCode,403);
 });
 await t.test('email correction requires password and replaces the pending code',async()=>{
  assert.equal((await post('/auth/change-email',{email:'corrected-'+account.email,password:'wrong'},session)).statusCode,401);
  const oldEmail=account.email;
  const user=await db.user.findUniqueOrThrow({where:{email:oldEmail}});
  const before=await db.emailVerification.findUniqueOrThrow({where:{userId:user.id}});
  const corrected='corrected-'+oldEmail;
  assert.equal((await post('/auth/change-email',{email:corrected,password:account.password},session)).statusCode,200);
  account.email=corrected;
  assert.equal(await db.user.findUnique({where:{email:oldEmail}}),null);
  const after=await db.emailVerification.findUniqueOrThrow({where:{userId:user.id}});
  assert.notEqual(before.codeHash,after.codeHash);
 });
 await t.test('wrong verification codes consume attempts without verifying',async()=>{
  const r=await post('/auth/verify',{email:account.email,code:'bad'});assert.equal(r.statusCode,400);
  const user=await db.user.findUniqueOrThrow({where:{email:account.email}});
  await db.emailVerification.update({where:{userId:user.id},data:{codeHash:digest(`${user.id}:123456`)}});
  for(let i=0;i<5;i++)assert.equal((await post('/auth/verify',{email:account.email,code:'000000'})).statusCode,400);
  assert.equal((await post('/auth/verify',{email:account.email,code:'123456'})).statusCode,400);
  assert.equal((await db.user.findUniqueOrThrow({where:{id:user.id}})).verifiedAt,null);
 });
 await t.test('resend replaces the code and never verifies automatically',async()=>{
  const user=await db.user.findUniqueOrThrow({where:{email:account.email}});
  await db.emailVerification.update({where:{userId:user.id},data:{sentAt:new Date(Date.now()-61000)}});
  assert.equal((await post('/auth/resend',{email:account.email})).statusCode,200);
  const v=await db.emailVerification.findUniqueOrThrow({where:{userId:user.id}});assert.equal(v.attempts,0);assert.notEqual(v.codeHash,digest(`${user.id}:123456`));assert.equal((await db.user.findUniqueOrThrow({where:{id:user.id}})).verifiedAt,null);
 });
 await t.test('expired code cannot verify; fresh emailed code is single use',async()=>{
  const user=await db.user.findUniqueOrThrow({where:{email:account.email}});
  await db.emailVerification.update({where:{userId:user.id},data:{expiresAt:new Date(Date.now()-1000)}});
  const code=(await inboxText('Verify your Macapagal Port email')).match(/\b\d{6}\b/)![0];
  assert.equal((await post('/auth/verify',{email:account.email,code})).statusCode,400);
  await db.emailVerification.update({where:{userId:user.id},data:{expiresAt:new Date(Date.now()+600000)}});
  assert.equal((await post('/auth/verify',{email:account.email,code})).statusCode,200);
  assert.equal((await post('/auth/verify',{email:account.email,code})).statusCode,400);
  assert.equal((await app.inject({url:'/auth/booking-access',headers:{cookie:session}})).statusCode,200);
 });
 await t.test('forgot password response does not enumerate accounts',async()=>{
  const exists=await post('/auth/forgot-password',{email:account.email});const absent=await post('/auth/forgot-password',{email:'absent@example.test'});
  assert.equal(exists.statusCode,200);assert.equal(exists.body,absent.body);
 });
 await t.test('reset is single-use, expiry checked, and revokes sessions',async()=>{
  const token=new URL((await inboxText('Reset your Macapagal Port password')).match(/http\S+/)![0]).searchParams.get('token');
  const payload={token,password:'Changed123',confirmPassword:'Changed123'};
  const reset=await db.passwordReset.findUniqueOrThrow({where:{tokenHash:digest(token!)}});
  await db.passwordReset.update({where:{id:reset.id},data:{expiresAt:new Date(Date.now()-1000)}});
  assert.equal((await post('/auth/reset-password',payload)).statusCode,400);
  await db.passwordReset.update({where:{id:reset.id},data:{expiresAt:new Date(Date.now()+600000)}});
  const attempts=await Promise.all([post('/auth/reset-password',payload),post('/auth/reset-password',payload)]);
  assert.deepEqual(attempts.map(r=>r.statusCode).sort(),[200,400]);
  assert.equal((await app.inject({url:'/auth/me',headers:{cookie:session}})).statusCode,401);
  assert.equal((await post('/auth/login',{email:account.email,password:account.password})).statusCode,401);
  assert.equal((await post('/auth/login',{email:account.email,password:'Changed123'})).statusCode,200);
 });
 await t.test('database rejects conflicting active seat assignments and pending attempts', async()=>{
  const user=await db.user.findUniqueOrThrow({where:{email:account.email}});
  const sailingId='00000000-0000-4000-8000-000000000001';
  const seatId='vessel-1-B-1';
  const a=await db.booking.create({data:{userId:user.id,sailingId,totalCentavos:48000,terminalFeeCentavos:3000}});
  const b=await db.booking.create({data:{userId:user.id,sailingId,totalCentavos:48000,terminalFeeCentavos:3000}});
  assert.match(a.reference,/^MP-\d{5}$/);assert.notEqual(a.reference,b.reference);
  try {
   const holds=await Promise.allSettled([a,b].map(booking=>db.seatHold.create({data:{bookingId:booking.id,sailingId,seatId,expiresAt:new Date(Date.now()+600000)}})));
   assert.equal(holds.filter(r=>r.status==='fulfilled').length,1);
   assert.equal(holds.filter(r=>r.status==='rejected').length,1);
   const payments=await Promise.allSettled([1,2].map(attemptNumber=>db.paymentAttempt.create({data:{bookingId:a.id,reference:`PAY-${a.reference.replace('-','')}-${String(attemptNumber).padStart(2,'0')}`,attemptNumber,idempotencyKey:`${a.id}-${attemptNumber}`,method:'GCASH',amountCentavos:48000}})));
   assert.equal(payments.filter(r=>r.status==='fulfilled').length,1);
   await db.seatHold.updateMany({where:{bookingId:{in:[a.id,b.id]}},data:{releasedAt:new Date()}});
   await db.seatHold.create({data:{bookingId:b.id,sailingId,seatId,expiresAt:new Date(Date.now()+600000)}});
  } finally {
   await db.seatHold.deleteMany({where:{bookingId:{in:[a.id,b.id]}}});
   await db.paymentAttempt.deleteMany({where:{bookingId:{in:[a.id,b.id]}}});
   await db.booking.deleteMany({where:{id:{in:[a.id,b.id]}}});
  }
 });
 await t.test('five login failures lock the account; logout revokes a session',async()=>{
  const user=await db.user.findUniqueOrThrow({where:{email:account.email}});
  await db.user.update({where:{id:user.id},data:{failedLogins:0}});
  for(let i=0;i<5;i++)assert.equal((await post('/auth/login',{email:account.email,password:'wrong'})).statusCode,401);
  assert.equal((await post('/auth/login',{email:account.email,password:'Changed123'})).statusCode,401);
  await db.user.update({where:{id:user.id},data:{lockedUntil:null,failedLogins:0}});
  const response=await post('/auth/login',{email:account.email,password:'Changed123'});
  const cookie=(response.headers['set-cookie'] as string).split(';')[0];
  assert.equal((await post('/auth/logout',{},cookie)).statusCode,200);
  assert.equal((await app.inject({url:'/auth/me',headers:{cookie}})).statusCode,401);
 });
 await t.test('Redis rejects excessive resend requests', async()=>{
  let status=200;
  for(let i=0;i<11;i++)status=(await post('/auth/resend',{email:'absent@example.test'})).statusCode;
  assert.equal(status,429);
 });
 } finally {
  const user=await db.user.findUnique({where:{email:account.email}});
  if(user){await db.auditLog.deleteMany({where:{actorId:user.id}});await db.user.delete({where:{id:user.id}});}
  await app.close();
 }
});

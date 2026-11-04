import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!new URL(databaseUrl).pathname.endsWith('_test'))throw new Error('Staff browser tests require TEST_DATABASE_URL pointing to the same isolated *_test database as the running API');
const db=new PrismaClient({adapter:new PrismaPg({connectionString:databaseUrl})});
const suffix=randomUUID();
const password=`StaffBrowser-${randomUUID()}-1`;
const emails={admin:`staff-admin-${suffix}@example.test`,passenger:`staff-passenger-${suffix}@example.test`};
const ids:string[]=[];

test.describe('staff console access and real operations data',()=>{
 test.beforeAll(async()=>{
  const passwordHash=await argon2.hash(password,{type:argon2.argon2id});
  for(const [name,role] of [['admin','PORT_ADMIN'],['passenger','PASSENGER']] as const){
   const user=await db.user.create({data:{email:emails[name],fullName:name==='admin'?'Browser Port Administrator':'Browser Passenger',mobile:'+639123456789',passwordHash,role,verifiedAt:new Date(),consentAt:new Date()}});ids.push(user.id);
  }
 });
 test.afterAll(async()=>{
  await db.auditLog.deleteMany({where:{actorId:{in:ids}}});
  await db.notification.deleteMany({where:{userId:{in:ids}}});
  await db.user.deleteMany({where:{id:{in:ids}}});
  await db.$disconnect();
 });
 async function signIn(page:import('@playwright/test').Page,email:string){
  await page.goto('/sign-in');
  await page.getByLabel('Email address',{exact:true}).fill(email);
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page).toHaveURL(/\/account$/);
 }
 test('unsigned and passenger users cannot use staff operations',async({page})=>{
  await page.goto('/staff');
  await expect(page.getByRole('heading',{name:'Staff sign in',exact:true})).toBeVisible();
  await signIn(page,emails.passenger);
  await page.goto('/staff');
  await expect(page.getByRole('heading',{name:'Staff access required',exact:true})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'Staff sections'})).toHaveCount(0);
 });
 test('administrator views real dashboard, catalogue, counter and scanner states',async({page})=>{
  const failures:string[]=[];page.on('pageerror',error=>failures.push(error.message));
  // Exercise the documented unsupported-camera fallback deterministically; boarding requests still use the real API.
  await page.addInitScript(()=>{Object.defineProperty(window,'BarcodeDetector',{value:undefined,configurable:true});});
  await signIn(page,emails.admin);
  await page.goto('/staff');
  await expect(page.getByRole('heading',{name:'Staff workspace',exact:true})).toBeVisible();
  await expect(page.getByText('Browser Port Administrator',{exact:false})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Sailing occupancy',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Routes & vessels',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Ports',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Seat layouts',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Counter payments',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Counter payment desk',exact:true})).toBeVisible();
  await page.getByLabel('Booking reference',{exact:true}).fill('MP-99999');
  await page.getByRole('button',{name:'Find booking',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Booking lookup complete.'})).toBeVisible();
  await page.getByRole('button',{name:'Boarding scanner',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Boarding scanner',exact:true})).toBeVisible();
  await expect(page.getByLabel('Boarding QR token',{exact:true})).toBeVisible();
  // A browser without QR detection must leave manual entry usable.
  await page.getByRole('button',{name:'Start camera scanner',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:/not supported|not granted|not available|No camera|Unable|camera could not|cannot detect/i})).toBeVisible();
  await page.getByLabel('Boarding QR token',{exact:true}).fill('not-a-valid-boarding-token');
  await page.getByRole('button',{name:'Validate and board passenger',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Passenger boarded',{exact:true})).toHaveCount(0);
  await page.screenshot({path:'/tmp/macapagal-staff-console.png',fullPage:true});
  expect(failures).toEqual([]);
 });
});

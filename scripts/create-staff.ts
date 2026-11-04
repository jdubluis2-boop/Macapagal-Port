import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { z } from 'zod';
const args=Object.fromEntries(process.argv.slice(2).map(part=>{const [key,...value]=part.replace(/^--/,'').split('=');return[key,value.join('=')];}));
const email=z.email().parse(args.email??process.env.STAFF_EMAIL).toLowerCase();
const role=z.enum(Role).parse(args.role??'PORT_ADMIN');
const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})});
try {
 const existing=await db.user.findUnique({where:{email}});
 if(existing){
  if(!existing.verifiedAt)throw new Error('Verify this account email before granting staff access');
  await db.$transaction(async tx=>{await tx.user.update({where:{id:existing.id},data:{role}});await tx.session.updateMany({where:{userId:existing.id,revokedAt:null},data:{revokedAt:new Date()}});await tx.auditLog.create({data:{actorId:existing.id,action:'OFFLINE_ROLE_ASSIGNMENT',entityId:existing.id,metadata:{role}}});});
 } else {
  if(process.env.NODE_ENV==='production')throw new Error('In production, register and verify the account before using offline role assignment');
  const password=z.string().min(12).max(128).regex(/\d/).parse(process.env.STAFF_PASSWORD);
  const fullName=z.string().min(2).max(160).parse(process.env.STAFF_NAME);
  const mobile=z.string().regex(/^\+639\d{9}$/).parse(process.env.STAFF_MOBILE);
  const user=await db.user.create({data:{email,role,fullName,mobile,passwordHash:await argon2.hash(password),verifiedAt:new Date(),consentAt:new Date()}});
  await db.auditLog.create({data:{actorId:user.id,action:'OFFLINE_DEVELOPMENT_STAFF_CREATED',entityId:user.id,metadata:{role}}});
 }
 console.log(`Staff role ${role} assigned. Sign in again to use it. No credential values were saved to source.`);
} finally {await db.$disconnect();}

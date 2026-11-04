import type {AppContext} from './context.js';
import {config} from './config.js';
export async function applyRetention(ctx:AppContext){
 const now=ctx.now(),before=new Date(+now-config.DATA_RETENTION_DAYS*86400000);
 await ctx.db.$transaction(async tx=>{
  const people=await tx.bookingPassenger.findMany({where:{redactedAt:null,booking:{createdAt:{lt:before},sailing:{arrival:{lt:before}},status:{in:['COMPLETED','REFUNDED','CANCELLED','EXPIRED_UNPAID','HOLD_EXPIRED']}}},select:{id:true},take:1000});
  if(people.length){
   await tx.bookingPassenger.updateMany({where:{id:{in:people.map(p=>p.id)},redactedAt:null},data:{redactedAt:now,detailsCiphertext:ctx.encrypt({fullName:'Removed under data retention policy',mobile:'',emergencyContactName:'',emergencyContactMobile:''})}});
   await tx.auditLog.create({data:{action:'RETENTION_APPLIED',entityId:'passenger-details',metadata:{count:people.length,retentionDays:config.DATA_RETENTION_DAYS}}});
  }
  await tx.session.deleteMany({where:{expiresAt:{lt:new Date(+now-7*86400000)}}});
  await tx.passwordReset.deleteMany({where:{expiresAt:{lt:new Date(+now-7*86400000)}}});
  await tx.emailVerification.deleteMany({where:{expiresAt:{lt:new Date(+now-7*86400000)}}});
  await tx.notification.deleteMany({where:{createdAt:{lt:before},readAt:{not:null},deliveredAt:{not:null},kind:{not:'PAYMENT_EXCEPTION'}}});
 });
}

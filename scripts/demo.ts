import 'dotenv/config';
import { PrismaClient, PassengerCategory } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createHash } from 'node:crypto';
if(process.env.NODE_ENV==='production')throw new Error('Demo seeding is disabled in production');
const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})});
const date=process.env.DEMO_DATE??new Date(Date.now()+8*3600000+86400000).toISOString().slice(0,10);
if(!/^20\d{2}-\d{2}-\d{2}$/.test(date)||new Date(`${date}T12:00:00Z`).toISOString().slice(0,10)!==date)throw new Error('Set DEMO_DATE to a valid YYYY-MM-DD');
const uuid=(key:string)=>{const h=createHash('sha256').update(key).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
try {
 await db.$transaction(async tx=>{
 const vesselId='demo-fortune-angel';
 await tx.vessel.upsert({where:{id:vesselId},create:{id:vesselId,name:'MV Fortune Angel 2 · DEMO',operator:'Demonstration only — not a live travel schedule',registration:'DEMO-224'},update:{}});
 for(const [prefix,className,deck]of[['B','Business',1],['E','Economy',2]]as const){
  const layoutId=`${vesselId}-${prefix}`;
  await tx.vesselSeatLayout.upsert({where:{id:layoutId},create:{id:layoutId,vesselId,className,deck},update:{}});
  await tx.seat.createMany({data:Array.from({length:40},(_,i)=>({id:`${layoutId}-${i+1}`,layoutId,label:`${prefix}-${i+1}`,row:Math.floor(i/4)+1,column:i%4+1})),skipDuplicates:true});
 }
 const seats=await tx.seat.findMany({where:{layout:{vesselId}}});
 for(const route of await tx.route.findMany({where:{originId:'surigao'}}))for(const hour of[8,12,16]){
  const id=uuid(`demo:${date}:${route.id}:${hour}`),departure=new Date(`${date}T${hour.toString().padStart(2,'0')}:00:00+08:00`);
  await tx.sailing.upsert({where:{id},create:{id,vesselId,routeId:route.id,departure,arrival:new Date(+departure+route.durationMinutes*60000),published:true,gate:'Gate 04',terminal:'Terminal 1'},update:{}});
  await tx.sailingSeat.createMany({data:seats.map(seat=>({sailingId:id,seatId:seat.id})),skipDuplicates:true});
  await tx.fare.createMany({data:['Business','Economy'].flatMap(className=>Object.values(PassengerCategory).map(category=>({sailingId:id,className,category,baseCentavos:route.destinationId==='cebu'?65000:45000,terminalFeeCentavos:3000}))),skipDuplicates:true});
 }
 },{timeout:30000});
 console.log(`Clearly labelled DEMO sailings prepared for ${date} (Asia/Manila). They are not an official timetable. Existing records were preserved.`);
} finally {await db.$disconnect();}

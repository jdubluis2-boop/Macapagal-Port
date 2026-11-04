import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, PassengerCategory } from '@prisma/client';
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
async function seed() {
 await db.$transaction(async tx => {
  for (const [id, name] of [['surigao','Macapagal Port, Surigao City'],['dapa','Dapa, Siargao'],['cebu','Cebu'],['dinagat','Dinagat']]) await tx.port.upsert({ where: { id }, create: { id, name }, update: { name } });
  for (const [id, destinationId, durationMinutes] of [['surigao-dapa','dapa',90],['surigao-cebu','cebu',600],['surigao-dinagat','dinagat',120]] as const) await tx.route.upsert({ where: { id }, create: { id, originId: 'surigao', destinationId, durationMinutes }, update: {} });
  const names = ['MV Fortune Angel 2','MV Reina Veronica','MV Reina Magdalena','MV Sean Ferry 2','MV Nathan Ferry 2','MV Claire Edith 3B','MV Vince Gabriel 3','MV Pilar Tuna Passion','MV Romans Road 5','MV Precious Ferry','SuperCat Fastcraft','OceanJet','Cokaliong'];
  for (let n=0; n<names.length; n++) {
   const id = `vessel-${n+1}`;
   await tx.vessel.upsert({ where: { id }, create: { id, name: names[n], operator: n === 0 ? 'Montenegro Shipping Lines' : 'DEMO — confirm operator before publishing', registration: n === 0 ? 'MSL-224' : null }, update: {} });
   for (const [prefix, className, deck] of [['B','Business',1],['E','Economy',2]] as const) {
    const layoutId = `${id}-${prefix}`;
    await tx.vesselSeatLayout.upsert({ where: { id: layoutId }, create: { id: layoutId, vesselId: id, className, deck }, update: {} });
    for (let i=1;i<=40;i++) await tx.seat.upsert({ where: { id: `${layoutId}-${i}` }, create: { id: `${layoutId}-${i}`, layoutId, label: `${prefix}-${i}`, row: Math.floor((i-1)/4)+1, column: (i-1)%4+1 }, update: {} });
   }
  }
  // The design's fixed historical date is intentional; do not silently move fixtures.
  for (let i=0;i<9;i++) {
   const id = `00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
   const routeId = i%3 === 0 ? 'surigao-dapa' : i%3 === 1 ? 'surigao-cebu' : 'surigao-dinagat';
   const departure = new Date(`2026-10-18T${String(6+i).padStart(2,'0')}:00:00+08:00`);
   const minutes = i%3 === 0 ? 90 : i%3 === 1 ? 600 : 120;
   await tx.sailing.upsert({ where: { id }, create: { id, vesselId: `vessel-${i+1}`, routeId, departure, arrival: new Date(+departure + minutes*60000), published: false, gate: 'Gate 04', terminal: 'Terminal 1' }, update: {} });
   const seats = await tx.seat.findMany({ where: { layout: { vesselId: `vessel-${i+1}` } } });
   await tx.sailingSeat.createMany({ data: seats.map(s => ({ sailingId: id, seatId: s.id })), skipDuplicates: true });
   for (const className of ['Business','Economy']) for (const category of Object.values(PassengerCategory)) {
    await tx.fare.upsert({ where: { sailingId_className_category: { sailingId: id, className, category } }, create: { sailingId: id, className, category, baseCentavos: i%3 === 1 ? 65000 : 45000, terminalFeeCentavos: 3000 }, update: {} });
   }
  }
  for (const rule of [
   { id:'voluntary-early', reason:'VOLUNTARY', minMinutesBefore:1441, maxMinutesBefore:null, deductionBasisPoints:1000, refundable:true },
   { id:'voluntary-standard', reason:'VOLUNTARY', minMinutesBefore:120, maxMinutesBefore:1441, deductionBasisPoints:2000, refundable:true },
   { id:'voluntary-late', reason:'VOLUNTARY', minMinutesBefore:0, maxMinutesBefore:120, deductionBasisPoints:10000, refundable:false },
   { id:'port-cancelled', reason:'PORT_CANCELLED', minMinutesBefore:0, maxMinutesBefore:null, deductionBasisPoints:0, refundable:true }
  ]) await tx.refundPolicy.upsert({ where: { id:rule.id }, create:rule, update:{} });
 }, { timeout:60000 });
}
seed().finally(() => db.$disconnect());

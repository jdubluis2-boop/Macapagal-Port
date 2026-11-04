import type { FastifyInstance } from 'fastify';
import { Prisma, Role, SailingStatus, PassengerCategory } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import type { AppContext } from './context.js';
import { config } from './config.js';

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const uuid = z.string().uuid();
const text = z.string().trim().min(1).max(200);
const admin: Role[] = ['PORT_ADMIN'];
const readers: Role[] = ['PORT_ADMIN', 'COUNTER_STAFF', 'GATE_STAFF'];
const counter: Role[] = ['PORT_ADMIN', 'COUNTER_STAFF'];
const failure = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const routeInclude = { origin: true, destination: true } satisfies Prisma.RouteInclude;
const sailingInclude = { vessel: true, route: { include: routeInclude }, fares: true } satisfies Prisma.SailingInclude;
const fareInput = z.object({ className: text, category: z.nativeEnum(PassengerCategory), baseCentavos: z.number().int().min(0).max(100000000), terminalFeeCentavos: z.number().int().min(0).max(1000000) });
const fareList = z.array(fareInput).min(1).max(100).refine(items => new Set(items.map(item => `${item.className}:${item.category}`)).size === items.length, 'Duplicate class/category fare');
const routeInput = z.object({ originId: id, destinationId: id, durationMinutes: z.number().int().min(1).max(10080) }).refine(v => v.originId !== v.destinationId, 'Origin and destination must differ');
const vesselInput = z.object({ name: text, operator: text, registration: z.string().trim().max(100).nullable().optional() });
const sailingInput = z.object({ routeId: id, vesselId: id, departure: z.iso.datetime({ offset: true }), arrival: z.iso.datetime({ offset: true }), gate: text, terminal: text, published: z.boolean().default(false), status: z.nativeEnum(SailingStatus).default('SCHEDULED'), fares: fareList.optional() }).refine(v => +new Date(v.arrival) > +new Date(v.departure), 'Arrival must follow departure');
const statusTransitions: Record<SailingStatus, SailingStatus[]> = { SCHEDULED: ['BOARDING', 'DELAYED', 'CANCELLED'], BOARDING: ['DEPARTED', 'DELAYED', 'CANCELLED'], DELAYED: ['SCHEDULED', 'BOARDING', 'CANCELLED'], DEPARTED: ['ARRIVED'], CANCELLED: [], ARRIVED: [] };
const publicUser = { id: true, fullName: true, email: true, mobile: true } as const;
async function lockSailing(tx: Prisma.TransactionClient, sailingId: string) { await tx.$queryRaw`SELECT id FROM "Sailing" WHERE id = ${sailingId}::uuid FOR UPDATE`; }
async function audit(tx: Prisma.TransactionClient, actorId: string, action: string, entityId: string, metadata: Prisma.InputJsonValue = {}) { await tx.auditLog.create({ data: { actorId, action, entityId, metadata } }); }
function manifestRule(sailing: { departure: Date; manifestClearedAt: Date | null; route: { origin: { northernPalawan: boolean }; destination: { northernPalawan: boolean } } }) {
 const required = sailing.route.origin.northernPalawan || sailing.route.destination.northernPalawan;
 const deadline = new Date(+sailing.departure - 4 * 3600000);
 return { required, deadline: deadline.toISOString(), clearedAt: sailing.manifestClearedAt, valid: !required || !!sailing.manifestClearedAt && +sailing.manifestClearedAt <= +deadline };
}
async function faresValid(tx: Prisma.TransactionClient, sailing: { id: string; vesselId: string; departure: Date; published: boolean }, now: Date) {
 if (!sailing.published) return;
 if (+sailing.departure <= +now) throw failure('Cannot publish a sailing whose departure is in the past');
 const seats = await tx.sailingSeat.count({ where: { sailingId: sailing.id } });
 const fares = await tx.fare.count({ where: { sailingId: sailing.id, category: 'REGULAR_ADULT' } });
 if (!seats || !fares) throw failure('Add a seat layout and regular-adult fares before publishing');
}
async function notifyUsers(tx: Prisma.TransactionClient, sailingId: string, status: SailingStatus, now: Date, message: string) {
 const holders = await tx.booking.findMany({ where: { sailingId, status: { in: ['SEAT_HELD', 'PAYMENT_PENDING', 'COUNTER_PENDING', 'PAID', 'TICKET_ISSUED'] } }, select: { userId: true, status: true } });
 const users = [...new Set(holders.map(b => b.userId))];
 for (const userId of users) {
  const paid = holders.some(b => b.userId === userId && ['PAID', 'TICKET_ISSUED'].includes(b.status));
  const disrupted = status === 'CANCELLED' || status === 'DELAYED';
  await tx.notification.create({ data: { userId, kind: 'SAILING_UPDATED', payload: { sailingId, status, message: disrupted && !paid ? `Your sailing is ${status.toLowerCase()}. No new payment can be made for a cancelled sailing. Check your booking for current options.` : message, fullRefundAvailable: disrupted && paid, freeRescheduleAvailable: disrupted && paid }, createdAt: now } });
 }
 return users;
}
export function registerStaffRoutes(app: FastifyInstance, ctx: AppContext) {
 app.get('/staff/ports', async req => { await ctx.staff(req, readers); return { ports: await ctx.db.port.findMany({ orderBy: { name: 'asc' } }) }; });
 app.post('/staff/ports', async req => {
  const user = await ctx.staff(req, admin); const input = z.object({ id: id.optional(), name: text, northernPalawan: z.boolean().default(false) }).parse(req.body);
  const port = await ctx.db.$transaction(async tx => { const row = await tx.port.create({ data: { ...input, id: input.id ?? randomUUID() } }); await audit(tx, user.id, 'PORT_CREATED', row.id); return row; });
  return { port };
 });
 app.patch('/staff/ports/:id', async req => {
  const user = await ctx.staff(req, admin); const portId = id.parse((req.params as {id:string}).id); const input = z.object({ name: text.optional(), northernPalawan: z.boolean().optional() }).parse(req.body);
  const port = await ctx.db.$transaction(async tx => { const row = await tx.port.update({ where: { id: portId }, data: input }); await audit(tx, user.id, 'PORT_UPDATED', row.id); return row; });return { port };
 });
 app.get('/staff/routes', async req => { await ctx.staff(req, readers); return { routes: await ctx.db.route.findMany({ include: routeInclude, orderBy: { id: 'asc' } }), ports: await ctx.db.port.findMany({ orderBy: { name: 'asc' } }) }; });
 app.post('/staff/routes', async req => {
  const user = await ctx.staff(req, admin); const raw = req.body as Record<string, unknown>; const input = routeInput.parse(raw); const routeId = raw.id === undefined ? randomUUID() : id.parse(raw.id);
  const route = await ctx.db.$transaction(async tx => { const row = await tx.route.create({ data: { id: routeId, ...input }, include: routeInclude }); await audit(tx, user.id, 'ROUTE_CREATED', row.id); return row; }); return { route };
 });
 app.patch('/staff/routes/:id', async req => {
  const user = await ctx.staff(req, admin); const routeId = id.parse((req.params as {id:string}).id); const input = routeInput.parse(req.body);
  const route = await ctx.db.$transaction(async tx => { if (await tx.sailing.count({ where: { routeId } })) throw failure('Create a new route rather than changing the ports of existing sailings',409);const row = await tx.route.update({ where: { id: routeId }, data: input, include: routeInclude });await audit(tx,user.id,'ROUTE_UPDATED',row.id);return row; });return {route};
 });
 app.delete('/staff/routes/:id', async req => { const user=await ctx.staff(req,admin);const routeId=id.parse((req.params as {id:string}).id);await ctx.db.$transaction(async tx=>{if(await tx.sailing.count({where:{routeId}}))throw failure('Route has sailings and cannot be deleted',409);await tx.route.delete({where:{id:routeId}});await audit(tx,user.id,'ROUTE_DELETED',routeId);});return {message:'Route deleted'}; });
 app.get('/staff/vessels', async req => { await ctx.staff(req, readers); return { vessels: await ctx.db.vessel.findMany({ include: { layouts: { include: { seats: { orderBy: [{row:'asc'},{column:'asc'}] } } } }, orderBy: { name: 'asc' } }) }; });
 app.post('/staff/vessels', async req => {const user=await ctx.staff(req,admin);const raw=req.body as Record<string,unknown>;const input=vesselInput.parse(raw);const vesselId=raw.id===undefined?randomUUID():id.parse(raw.id);const vessel=await ctx.db.$transaction(async tx=>{const row=await tx.vessel.create({data:{id:vesselId,...input}});await audit(tx,user.id,'VESSEL_CREATED',row.id);return row;});return {vessel};});
 app.patch('/staff/vessels/:id',async req=>{const user=await ctx.staff(req,admin);const vesselId=id.parse((req.params as {id:string}).id);const input=vesselInput.partial().parse(req.body);const vessel=await ctx.db.$transaction(async tx=>{const row=await tx.vessel.update({where:{id:vesselId},data:input});await audit(tx,user.id,'VESSEL_UPDATED',row.id);return row;});return {vessel};});
 app.delete('/staff/vessels/:id',async req=>{const user=await ctx.staff(req,admin);const vesselId=id.parse((req.params as {id:string}).id);await ctx.db.$transaction(async tx=>{if(await tx.sailing.count({where:{vesselId}}))throw failure('Vessel has sailings and cannot be deleted',409);await tx.seat.deleteMany({where:{layout:{vesselId}}});await tx.vesselSeatLayout.deleteMany({where:{vesselId}});await tx.vessel.delete({where:{id:vesselId}});await audit(tx,user.id,'VESSEL_DELETED',vesselId);});return {message:'Vessel deleted'};});
 app.post('/staff/vessels/:id/layouts',async req=>{
  const user=await ctx.staff(req,admin);const vesselId=id.parse((req.params as {id:string}).id);
  const input=z.object({id:id.optional(),className:text,deck:z.number().int().min(1).max(20),seats:z.array(z.object({id:id.optional(),label:text,row:z.number().int().min(1).max(1000),column:z.number().int().min(1).max(100)})).min(1).max(2000)}).refine(v=>new Set(v.seats.map(s=>s.label)).size===v.seats.length,'Seat labels must be unique').refine(v=>new Set(v.seats.map(s=>`${s.row}:${s.column}`)).size===v.seats.length,'Seat coordinates must be unique').parse(req.body);
  const layout=await ctx.db.$transaction(async tx=>{const row=await tx.vesselSeatLayout.create({data:{id:input.id??randomUUID(),vesselId,className:input.className,deck:input.deck,seats:{create:input.seats.map(seat=>({...seat,id:seat.id??randomUUID()}))}},include:{seats:true}});await audit(tx,user.id,'LAYOUT_CREATED',row.id);return row;});return {layout};
 });
 app.patch('/staff/layouts/:id',async req=>{const user=await ctx.staff(req,admin);const layoutId=id.parse((req.params as {id:string}).id);const input=z.object({className:text.optional(),deck:z.number().int().min(1).max(20).optional()}).parse(req.body);const layout=await ctx.db.$transaction(async tx=>{if(await tx.sailingSeat.count({where:{seat:{layoutId}}}))throw failure('This layout is used by a sailing; create a new layout instead',409);const row=await tx.vesselSeatLayout.update({where:{id:layoutId},data:input});await audit(tx,user.id,'LAYOUT_UPDATED',row.id);return row;});return {layout};});
 app.get('/staff/sailings',async req=>{await ctx.staff(req,readers);return {sailings:await ctx.db.sailing.findMany({include:sailingInclude,orderBy:{departure:'desc'},take:500})};});
 app.post('/staff/sailings',async req=>{
  const user=await ctx.staff(req,admin);const raw=req.body as Record<string,unknown>;const input=sailingInput.parse(raw);const sailingId=raw.id===undefined?randomUUID():uuid.parse(raw.id);
  if(input.status!=='SCHEDULED')throw failure('New sailings must start as SCHEDULED');
  const sailing=await ctx.db.$transaction(async tx=>{
   const row=await tx.sailing.create({data:{id:sailingId,routeId:input.routeId,vesselId:input.vesselId,departure:new Date(input.departure),arrival:new Date(input.arrival),gate:input.gate,terminal:input.terminal,published:input.published,status:input.status}});
   const seats=await tx.seat.findMany({where:{layout:{vesselId:input.vesselId}},select:{id:true}});if(!seats.length)throw failure('Create a vessel seat layout first');
   await tx.sailingSeat.createMany({data:seats.map(s=>({sailingId:row.id,seatId:s.id}))});
   if(input.fares){const layouts=await tx.vesselSeatLayout.findMany({where:{vesselId:input.vesselId},select:{className:true}});if(input.fares.some(f=>!layouts.some(l=>l.className===f.className)))throw failure('Fare class is not present on this vessel');await tx.fare.createMany({data:input.fares.map(f=>({...f,sailingId:row.id}))});}
   await faresValid(tx,row,ctx.now());await audit(tx,user.id,'SAILING_CREATED',row.id);return tx.sailing.findUniqueOrThrow({where:{id:row.id},include:sailingInclude});
  });return {sailing};
 });
 app.patch('/staff/sailings/:id',async req=>{
  const user=await ctx.staff(req,admin);const sailingId=uuid.parse((req.params as {id:string}).id);const input=z.object({routeId:id.optional(),vesselId:id.optional(),departure:z.iso.datetime({offset:true}).optional(),arrival:z.iso.datetime({offset:true}).optional(),gate:text.optional(),terminal:text.optional(),published:z.boolean().optional()}).strict().parse(req.body);
  const result=await ctx.db.$transaction(async tx=>{
   await lockSailing(tx,sailingId);const old=await tx.sailing.findUniqueOrThrow({where:{id:sailingId}});
   if(['DEPARTED','ARRIVED','CANCELLED'].includes(old.status))throw failure('A completed or cancelled sailing cannot be edited',409);
   if(input.vesselId&&input.vesselId!==old.vesselId)throw failure('Create a replacement sailing to change its vessel',409);
   if(input.routeId&&input.routeId!==old.routeId)throw failure('Create a replacement sailing to change its route',409);
   const departure=input.departure?new Date(input.departure):old.departure;const arrival=input.arrival?new Date(input.arrival):old.arrival;if(+arrival<=+departure)throw failure('Arrival must follow departure');
   const timeChanged=+departure!==+old.departure;
   if(timeChanged&&old.status!=='DELAYED'&&await tx.booking.count({where:{sailingId,status:{in:['PAID','TICKET_ISSUED']}}}))throw failure('Mark a booked sailing DELAYED before changing its departure so ticket holders receive recovery options',409);
   const row=await tx.sailing.update({where:{id:sailingId},data:{...input,departure,arrival,...(input.departure?{manifestClearedAt:null,manifestClearedBy:null}:{})},include:sailingInclude});await faresValid(tx,row,ctx.now());await audit(tx,user.id,'SAILING_UPDATED',sailingId);
   const counterExpiries:{id:string;deadline:Date}[]=[];
   if(timeChanged){
    const newDeadline=new Date(+departure-config.COUNTER_DEADLINE_MINUTES*60000);
    const pending=await tx.booking.findMany({where:{sailingId,status:'COUNTER_PENDING'},select:{id:true,counterDeadline:true}});
    for(const booking of pending){const deadline=booking.counterDeadline&&+booking.counterDeadline<+newDeadline?booking.counterDeadline:newDeadline;await tx.booking.update({where:{id:booking.id},data:{counterDeadline:deadline,holdExpiresAt:deadline}});await tx.seatHold.updateMany({where:{bookingId:booking.id,releasedAt:null},data:{expiresAt:deadline}});counterExpiries.push({id:booking.id,deadline});}
   }
   const users=await notifyUsers(tx,sailingId,row.status,ctx.now(),`Your sailing schedule or terminal information has changed. Check your booking for the latest departure, gate and terminal.`);return {row,users,counterExpiries};
  });for(const booking of result.counterExpiries)await ctx.jobs.add('hold.expire',{bookingId:booking.id},{delay:Math.max(0,+booking.deadline-+ctx.now()),removeOnComplete:true}).catch(()=>{});ctx.emit(`sailing:${sailingId}`,'sailing.updated',result.row);for(const userId of result.users)ctx.emit(`user:${userId}`,'sailing.updated',result.row);return {sailing:result.row};
 });
 app.post('/staff/sailings/:id/fares',async req=>{
  const user=await ctx.staff(req,admin);const sailingId=uuid.parse((req.params as {id:string}).id);const input=z.object({fares:fareList}).parse(req.body);
  const fares=await ctx.db.$transaction(async tx=>{await lockSailing(tx,sailingId);const sailing=await tx.sailing.findUniqueOrThrow({where:{id:sailingId}});const layouts=await tx.vesselSeatLayout.findMany({where:{vesselId:sailing.vesselId},select:{className:true}});for(const f of input.fares){if(!layouts.some(l=>l.className===f.className))throw failure('Fare class is not present on this vessel');await tx.fare.upsert({where:{sailingId_className_category:{sailingId,className:f.className,category:f.category}},create:{...f,sailingId},update:f});}await audit(tx,user.id,'FARES_UPDATED',sailingId);return tx.fare.findMany({where:{sailingId}});});return {fares};
 });
 app.post('/staff/sailings/:id/status',async req=>{
  const user=await ctx.staff(req,admin);const sailingId=uuid.parse((req.params as {id:string}).id);const input=z.object({status:z.nativeEnum(SailingStatus),gate:text.optional(),terminal:text.optional()}).parse(req.body);
  const result=await ctx.db.$transaction(async tx=>{
   await lockSailing(tx,sailingId);const sailing=await tx.sailing.findUniqueOrThrow({where:{id:sailingId},include:{route:{include:routeInclude}}});
   if(input.status!==sailing.status&&!statusTransitions[sailing.status].includes(input.status))throw failure(`Cannot change ${sailing.status} to ${input.status}`,409);
   if(['BOARDING','DEPARTED'].includes(input.status)&&!manifestRule(sailing).valid)throw failure('Northern Palawan manifest must be cleared at least four hours before departure',409);
   const row=await tx.sailing.update({where:{id:sailingId},data:input,include:sailingInclude});
   if(['DEPARTED','ARRIVED'].includes(input.status))await tx.booking.updateMany({where:{sailingId,status:'TICKET_ISSUED',tickets:{some:{},every:{status:'BOARDED'}}},data:{status:'COMPLETED'}});
   await audit(tx,user.id,'SAILING_STATUS_CHANGED',sailingId,{from:sailing.status,to:input.status});
   const message=['CANCELLED','DELAYED'].includes(input.status)?`Your sailing is ${input.status.toLowerCase()}. You may request a full refund or a free reschedule from your booking.`:`Your sailing status is now ${input.status.toLowerCase()}. Check your booking for the latest gate and terminal.`;
   const users=await notifyUsers(tx,sailingId,input.status,ctx.now(),message);return {row,users};
  });ctx.emit(`sailing:${sailingId}`,'sailing.updated',result.row);for(const userId of result.users)ctx.emit(`user:${userId}`,'sailing.updated',result.row);return {sailing:result.row};
 });
 app.patch('/staff/sailings/:id/seats/:seatId',async req=>{
  const user=await ctx.staff(req,admin);const params=z.object({id:uuid,seatId:id}).parse(req.params);const input=z.object({state:z.enum(['AVAILABLE','BLOCKED'])}).parse(req.body);
  const seat=await ctx.db.$transaction(async tx=>{
   await lockSailing(tx,params.id);const sailing=await tx.sailing.findUniqueOrThrow({where:{id:params.id}});if(['DEPARTED','ARRIVED','CANCELLED'].includes(sailing.status))throw failure('Seat overrides are closed for this sailing',409);
   const rows=await tx.$queryRaw<{seatId:string}[]>`SELECT "seatId" FROM "SailingSeat" WHERE "sailingId"=${params.id}::uuid AND "seatId"=${params.seatId} FOR UPDATE`;
   if(!rows.length)throw failure('Seat not found',404);
   if(await tx.seatHold.count({where:{sailingId:params.id,seatId:params.seatId,releasedAt:null}}))throw failure('An assigned or held seat cannot be overridden',409);
   const old=await tx.sailingSeat.findUniqueOrThrow({where:{sailingId_seatId:{sailingId:params.id,seatId:params.seatId}}});if(!['AVAILABLE','BLOCKED'].includes(old.state))throw failure('Seat is occupied and cannot be overridden',409);
   const updated=await tx.sailingSeat.update({where:{sailingId_seatId:{sailingId:params.id,seatId:params.seatId}},data:{state:input.state,version:{increment:1}}});await audit(tx,user.id,'SEAT_OVERRIDE',params.seatId,{sailingId:params.id,from:old.state,to:input.state});return updated;
  });ctx.emit(`sailing:${params.id}`,'seat.updated',{seatId:seat.seatId,state:seat.state,version:seat.version});return {seat};
 });
 app.get('/staff/dashboard',async req=>{
  await ctx.staff(req,readers);const rows=await ctx.db.sailing.findMany({where:{departure:{gte:new Date(+ctx.now()-86400000)},status:{notIn:['ARRIVED']}},include:{...sailingInclude,inventory:{select:{state:true}},bookings:{select:{tickets:{select:{status:true}}}}},orderBy:{departure:'asc'},take:100});
  const sailings=rows.map(({inventory,bookings,...row})=>{const inventoryCounts={AVAILABLE:0,HELD:0,PENDING_PAYMENT:0,SOLD:0,BLOCKED:0};for(const seat of inventory)inventoryCounts[seat.state]++;return {...row,inventoryCounts,totalSeats:inventory.length,boardedCount:bookings.reduce((n,b)=>n+b.tickets.filter(t=>t.status==='BOARDED').length,0)};});
  const [counterPending,refundsPending,paymentExceptions]=await Promise.all([ctx.db.booking.count({where:{status:'COUNTER_PENDING'}}),ctx.db.refund.count({where:{status:{in:['REQUESTED','PROCESSING']}}}),ctx.db.notification.count({where:{kind:'PAYMENT_EXCEPTION',readAt:null}})]);
  return {sailings,counts:{counterPending,refundsPending,paymentExceptions},totals:{sailings:sailings.length,available:sailings.reduce((n,s)=>n+s.inventoryCounts.AVAILABLE,0),sold:sailings.reduce((n,s)=>n+s.inventoryCounts.SOLD,0),boarded:sailings.reduce((n,s)=>n+s.boardedCount,0)}};
 });
 async function manifest(sailingId:string){
  const sailing=await ctx.db.sailing.findUnique({where:{id:sailingId},include:sailingInclude});if(!sailing)throw failure('Sailing not found',404);
  const tickets=await ctx.db.ticket.findMany({where:{booking:{sailingId}},include:{passenger:true,scan:true,booking:{select:{reference:true,status:true}}},orderBy:{seatLabel:'asc'}});
  const activeSeats=await ctx.db.seatHold.findMany({where:{sailingId,releasedAt:null},include:{seat:{include:{layout:true}}}});const seatClasses=new Map(activeSeats.map(h=>[`${h.bookingId}:${h.seat.label}`,h.seat.layout.className]));
  const passengers=tickets.filter(t=>['TICKET_ISSUED','BOARDED'].includes(t.status)).map(ticket=>{const details=ctx.decrypt(ticket.passenger.detailsCiphertext) as Record<string,unknown>;return {bookingReference:ticket.booking.reference,ticketId:ticket.id,seatLabel:ticket.seatLabel,className:seatClasses.get(`${ticket.passenger.bookingId}:${ticket.seatLabel}`)??'',status:ticket.status,boardedAt:ticket.scan?.scannedAt??null,fullName:String(details.fullName??''),mobile:String(details.mobile??''),category:ticket.passenger.category,age:ticket.passenger.age,gender:ticket.passenger.gender,emergencyContactName:String(details.emergencyContactName??''),emergencyContactMobile:String(details.emergencyContactMobile??'')};});
  return {sailing,passengers,boardedCount:passengers.filter(p=>p.status==='BOARDED').length,noShowCount:passengers.filter(p=>p.status==='TICKET_ISSUED').length,manifestClearing:manifestRule(sailing)};
 }
 app.get('/staff/sailings/:id/manifest',async req=>{await ctx.staff(req,readers);return manifest(uuid.parse((req.params as {id:string}).id));});
 app.get('/staff/sailings/:id/manifest.csv',async(req,reply)=>{const user=await ctx.staff(req,readers);const sailingId=uuid.parse((req.params as {id:string}).id);const data=await manifest(sailingId);const columns=['bookingReference','ticketId','fullName','seatLabel','category','age','gender','mobile','emergencyContactName','emergencyContactMobile','status','boardedAt'] as const;const escape=(value:unknown)=>{const text=String(value??'');return '"'+(/^[\t\r\n]|^\s*[=+@-]/.test(text)?"'":'')+text.replaceAll('"','""')+'"';};await ctx.db.auditLog.create({data:{actorId:user.id,action:'MANIFEST_EXPORTED',entityId:sailingId,metadata:{format:'CSV'}}});return reply.header('Content-Type','text/csv; charset=utf-8').header('Content-Disposition',`attachment; filename="manifest-${sailingId}.csv"`).send([columns.map(escape).join(','),...data.passengers.map(p=>columns.map(c=>escape(p[c])).join(','))].join('\r\n'));});
 app.get('/staff/sailings/:id/manifest.pdf',async(req,reply)=>{const user=await ctx.staff(req,readers);const sailingId=uuid.parse((req.params as {id:string}).id);const data=await manifest(sailingId);const doc=new PDFDocument({margin:40,size:'A4'});const chunks:Buffer[]=[];const finished=new Promise<Buffer>((resolve,reject)=>{doc.on('data',chunk=>chunks.push(Buffer.from(chunk)));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});doc.fontSize(18).text('Macapagal Port passenger manifest');doc.moveDown().fontSize(10).text(`${data.sailing.vessel.name} | ${data.sailing.route.origin.name} to ${data.sailing.route.destination.name}`).text(`Departure: ${data.sailing.departure.toISOString()}`).text(`Boarded: ${data.boardedCount} | Not boarded: ${data.noShowCount}`).text(`Manifest clearance required: ${data.manifestClearing.required?'Yes':'No'}`);for(const passenger of data.passengers){doc.moveDown().text(`${passenger.seatLabel} | ${passenger.fullName} | ${passenger.category} | ${passenger.age} | ${passenger.gender}`).text(`Booking ${passenger.bookingReference} | ${passenger.status}`).text(`Mobile ${passenger.mobile}; emergency ${passenger.emergencyContactName} ${passenger.emergencyContactMobile}`);}doc.end();await ctx.db.auditLog.create({data:{actorId:user.id,action:'MANIFEST_EXPORTED',entityId:sailingId,metadata:{format:'PDF'}}});return reply.header('Content-Type','application/pdf').header('Content-Disposition',`attachment; filename="manifest-${sailingId}.pdf"`).send(await finished);});
 app.post('/staff/sailings/:id/manifest-clear',async req=>{const user=await ctx.staff(req,admin);const sailingId=uuid.parse((req.params as {id:string}).id);z.object({confirmed:z.literal(true)}).parse(req.body);const sailing=await ctx.db.$transaction(async tx=>{await lockSailing(tx,sailingId);const row=await tx.sailing.findUniqueOrThrow({where:{id:sailingId},include:sailingInclude});const rule=manifestRule(row);if(['DEPARTED','ARRIVED','CANCELLED'].includes(row.status))throw failure('Manifest clearing is closed for this sailing',409);if(rule.required&&+ctx.now()>+new Date(rule.deadline))throw failure('Northern Palawan manifest clearing deadline has passed; departure requires port review',409);const updated=await tx.sailing.update({where:{id:sailingId},data:{manifestClearedAt:ctx.now(),manifestClearedBy:user.id},include:sailingInclude});await audit(tx,user.id,'MANIFEST_CLEARED',sailingId,{confirmed:true});return updated;});return {sailing,manifestClearing:manifestRule(sailing)};});
 app.get('/staff/bookings',async req=>{await ctx.staff(req,counter);const input=z.object({reference:z.string().regex(/^MP-\d{5}$/)}).parse(req.query);const rows=await ctx.db.booking.findMany({where:{reference:input.reference},include:{user:{select:publicUser},sailing:{include:sailingInclude},passengers:true,attempts:true,payments:true,tickets:true,refunds:true,holds:{where:{releasedAt:null},include:{seat:true}}}});return {bookings:rows.map(row=>({...row,passengers:row.passengers.map(({detailsCiphertext,...passenger})=>({...passenger,...ctx.decrypt(detailsCiphertext)}))}))};});
 app.get('/staff/refunds',async req=>{await ctx.staff(req,counter);return {refunds:await ctx.db.refund.findMany({where:{status:{in:['REQUESTED','PROCESSING','FAILED']}},include:{booking:{include:{user:{select:publicUser},sailing:{include:sailingInclude}}},payment:true},orderBy:{requestedAt:'asc'},take:200})};});
 app.post('/staff/refunds/:id/review',async req=>{const user=await ctx.staff(req,counter);const refundId=uuid.parse((req.params as {id:string}).id);const refund=await ctx.db.$transaction(async tx=>{const before=await tx.refund.findUniqueOrThrow({where:{id:refundId},include:{booking:{select:{id:true,sailingId:true}}}});await lockSailing(tx,before.booking.sailingId);await tx.$queryRaw`SELECT id FROM "Booking" WHERE id=${before.booking.id}::uuid FOR UPDATE`;await tx.$queryRaw`SELECT id FROM "Refund" WHERE id=${refundId}::uuid FOR UPDATE`;const row=await tx.refund.findUniqueOrThrow({where:{id:refundId}});if(row.status!=='REQUESTED'&&row.status!=='PROCESSING')throw failure('Refund cannot be reviewed in this state',409);const updated=await tx.refund.update({where:{id:refundId},data:{status:'PROCESSING',processingAt:row.processingAt??ctx.now()}});await tx.booking.updateMany({where:{id:row.bookingId,status:'REFUND_REQUESTED'},data:{status:'REFUND_PROCESSING'}});await audit(tx,user.id,'REFUND_REVIEW_STARTED',refundId);return updated;});return {refund};});
 app.get('/staff/payment-exceptions',async req=>{await ctx.staff(req,counter);return {exceptions:await ctx.db.notification.findMany({where:{kind:'PAYMENT_EXCEPTION'},include:{user:{select:publicUser}},orderBy:{createdAt:'desc'},take:200})};});
 app.post('/staff/payment-exceptions/:id/resolve',async req=>{const user=await ctx.staff(req,counter);const notificationId=uuid.parse((req.params as {id:string}).id);const input=z.object({resolution:z.string().trim().min(10).max(2000)}).parse(req.body);const exception=await ctx.db.$transaction(async tx=>{const row=await tx.notification.findUnique({where:{id:notificationId}});if(!row||row.kind!=='PAYMENT_EXCEPTION')throw failure('Payment exception not found',404);const updated=await tx.notification.update({where:{id:notificationId},data:{readAt:ctx.now()}});await audit(tx,user.id,'PAYMENT_EXCEPTION_REVIEWED',notificationId,{resolution:input.resolution});return updated;});return {exception,message:'Review recorded. This records staff action; it does not itself move or refund money.'};});
}

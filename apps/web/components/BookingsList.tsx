'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRealtimeRefresh } from '../lib/realtime';
import { Booking,downloadDocument,humanStatus,usePassengerResource,travelDate } from '../lib/passenger-api';
import { peso } from '../lib/sailings';
import { PassengerPageHeading,ResourceState } from './PassengerShared';
export default function BookingsList(){
 const {data,error,loading,reload}=usePassengerResource<{bookings:Booking[];serverTime:string}>('/bookings',15000);useRealtimeRefresh(reload);
 const [tab,setTab]=useState('All'),[documentBusy,setDocumentBusy]=useState<string|null>(null),[documentError,setDocumentError]=useState('');
 const serverTime=data?.serverTime?Date.parse(data.serverTime):null;
 const bookings=(data?.bookings??[]).filter(b=>tab==='All'||tab==='Upcoming'&&b.status==='TICKET_ISSUED'&&serverTime!==null&&Date.parse(b.sailing.departure)>serverTime||tab==='Completed'&&b.status==='COMPLETED'||tab==='Cancelled'&&['REFUNDED','CANCELLED'].includes(b.status));
 async function invoice(booking:Booking){setDocumentBusy(booking.id);setDocumentError('');try{await downloadDocument(`/bookings/${encodeURIComponent(booking.id)}/invoice.pdf`,`${booking.reference}-invoice.pdf`);}catch(e){setDocumentError(e instanceof Error?e.message:'Invoice unavailable. Please try again.');}finally{setDocumentBusy(null);}}
 return <div className="passenger-page"><PassengerPageHeading title="My bookings" description="Your trips, payment status, receipts and refunds."/><ResourceState loading={loading} error={error} reload={reload}/>{documentError&&<p className="status error" role="alert">{documentError}</p>}<div className="booking-tabs" role="tablist" aria-label="Booking status">{['All','Upcoming','Completed','Cancelled'].map(name=><button key={name} type="button" role="tab" aria-selected={tab===name} onClick={()=>setTab(name)} className={tab===name?'active':''}>{name}</button>)}</div>{!loading&&!error&&bookings.length===0&&<div className="empty-sailings" role="status"><h2>No {tab==='All'?'':tab.toLowerCase()} bookings yet</h2><p>When you book a trip, it will appear here.</p><Link className="button" href="/sailings">Find a sailing</Link></div>}<div className="booking-list">{bookings.map(booking=>{
 const paid=(booking.payments??[]).reduce((sum,payment)=>sum+payment.amountCentavos,0);
 const refunded=(booking.refunds??[]).filter(refund=>refund.status==='COMPLETED').reduce((sum,refund)=>sum+refund.amountCentavos,0);
 return <article key={booking.id} className="passenger-panel"><div className="section-heading"><h2>{booking.reference}</h2><span className="status-pill">{humanStatus(booking.status)}</span></div><h3>{booking.sailing.route.origin.name} → {booking.sailing.route.destination.name}</h3><p>{booking.sailing.vessel.name} · {travelDate(booking.sailing.departure)} (Philippine time)</p><p>{booking.passengers.length} {booking.passengers.length===1?'passenger':'passengers'}</p><div className="booking-money"><span>{paid>0?`Total paid: ${peso(paid)}`:`Total due: ${peso(booking.totalCentavos)}`}</span>{(refunded>0||booking.status==='REFUNDED')&&<span>Refunded: {peso(refunded)}</span>}{booking.refunds?.some(refund=>['REQUESTED','PROCESSING'].includes(refund.status))&&<span>Refund settlement in progress</span>}</div><div className="button-row"><Link className="button" href={`/bookings/${booking.id}`}>View booking</Link>{paid>0&&<button type="button" className="secondary-button" disabled={documentBusy===booking.id} onClick={()=>invoice(booking)}>{documentBusy===booking.id?'Preparing invoice…':'Print / download invoice'}</button>}</div></article>;
 })}</div></div>;
}

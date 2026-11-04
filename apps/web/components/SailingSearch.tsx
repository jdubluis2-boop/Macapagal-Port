'use client';
import Link from 'next/link';
import { useCallback,useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import SearchForm from './SearchForm';
import { useRealtimeRefresh } from '../lib/realtime';
import { availabilityLabel, duration, fullDate, getApi, offsetDate, peso, Sailing, SailingClass, SailingResults, sailingTime, SearchFilters, searchLink, validDate } from '../lib/sailings';
function dateLabel(date: string) { return new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',weekday:'short',month:'short',day:'numeric'}).format(new Date(`${date}T12:00:00+08:00`)); }
function arrivalLabel(sailing: Sailing) {
 const day = (value:string) => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
 const days = Math.round((+new Date(`${day(sailing.arrival)}T00:00:00Z`) - +new Date(`${day(sailing.departure)}T00:00:00Z`))/86400000);
 return days > 0 ? ` +${days} day${days === 1 ? '' : 's'}` : '';
}
export default function SailingSearch() {
 const params = useSearchParams();
 const filters: SearchFilters = {origin:params.get('origin')??'',destination:params.get('destination')??'',date:params.get('date')??'',passengers:params.get('passengers')??'1'};
 const queryKey = new URLSearchParams(filters).toString();
 const hasSearch = !!(filters.origin && filters.destination && filters.date);
 const [results,setResults] = useState<SailingResults|null>(null);
 const [loading,setLoading] = useState(false), [refreshing,setRefreshing] = useState(false), [error,setError] = useState(''), [refresh,setRefresh] = useState(0);
 const [selected,setSelected] = useState<{id:string;className:string}|null>(null);
 const summaryRef = useRef<HTMLDivElement>(null);
 const selectionTriggerRef = useRef<HTMLButtonElement|null>(null);
 const activeKey = useRef('');
 const realtimeRefresh=useCallback(()=>setRefresh(n=>n+1),[]);
 useRealtimeRefresh(realtimeRefresh,{route:hasSearch&&validDate(filters.date)?filters:undefined});
 useEffect(() => {
  setSelected(null);
 },[queryKey]);
 useEffect(() => {
  if (!hasSearch) {setResults(null);setError('');setLoading(false);return;}
  const controller = new AbortController();
  let inFlight = false;
  if (activeKey.current !== queryKey) {setResults(null);setLoading(true);activeKey.current=queryKey;}
  async function load() {
   if (inFlight || controller.signal.aborted) return;
   inFlight=true;setRefreshing(true);
   try {
    const response = await getApi<SailingResults>(`/sailings/search?${queryKey}`,controller.signal);
    if (!controller.signal.aborted) {setResults(response);setError('');}
   } catch (e) {if(!controller.signal.aborted)setError(e instanceof Error ? e.message : 'Unable to load sailings. Please try again.');}
   finally {inFlight=false;if(!controller.signal.aborted){setLoading(false);setRefreshing(false);}}
  }
  void load();
  const interval = window.setInterval(() => {if(!document.hidden)void load();},15000);
  const resume = () => {if(!document.hidden)void load();};
  document.addEventListener('visibilitychange',resume);
  return () => {controller.abort();window.clearInterval(interval);document.removeEventListener('visibilitychange',resume);};
 },[queryKey,hasSearch,refresh]);
 useEffect(() => { if(selected){summaryRef.current?.focus();summaryRef.current?.scrollIntoView({behavior:'smooth',block:'center'});} },[selected]);
 const selectedSailing=results?.sailings.find(s=>s.id===selected?.id);
 const selectedClass=selectedSailing?.classes.find(c=>c.name===selected?.className);
 function choose(sailing: Sailing, sailingClass: SailingClass, trigger: HTMLButtonElement) {selectionTriggerRef.current=trigger;setSelected({id:sailing.id,className:sailingClass.name});}
 return <div className="sailings-page"><div className="results-heading"><div><span className="eyebrow">Plan your journey</span><h1>Sailing schedules</h1><p>Compare crossings and available seats. All times are Philippine time (UTC+8).</p></div><Link href="/">← Back to home</Link></div><SearchForm compact initial={filters}/>
  {hasSearch && validDate(filters.date) && <nav className="date-tabs" aria-label="Departure dates">{[-1,0,1].map(offset => {const date=offsetDate(filters.date,offset);if(!validDate(date))return null;return <Link key={date} href={searchLink({...filters,date})} className={offset === 0 ? 'date-tab active' : 'date-tab'} aria-current={offset === 0 ? 'date' : undefined}>{dateLabel(date)}{offset===0&&<small>Selected date</small>}</Link>;})}</nav>}
  {!hasSearch && <div className="empty-sailings"><span className="empty-icon" aria-hidden="true">⛴</span><h2>Where will you sail?</h2><p>Choose your origin, destination, departure date, and passenger count to see the latest crossings.</p></div>}
  {loading && <div className="loading-sailings" role="status"><span className="loading-dot"/>Finding your crossings…</div>}
  {error && <div className="status error results-error" role="alert"><strong>We couldn’t refresh the schedule.</strong><p>{error}</p>{results&&<p>The previous results are shown below. Refresh before choosing a crossing.</p>}<button type="button" onClick={()=>setRefresh(n=>n+1)} disabled={refreshing}>Try again</button></div>}
  {results && <><div className="results-toolbar"><div><h2>{results.origin.name} <span aria-hidden="true">→</span> {results.destination.name}</h2><p>{fullDate(results.date)} · {results.passengers} {results.passengers===1?'passenger':'passengers'} · {results.sailings.length} {results.sailings.length===1?'sailing':'sailings'}</p></div><div className="refresh-controls"><button type="button" className="secondary-button" onClick={()=>setRefresh(n=>n+1)} disabled={refreshing}>{refreshing?'Refreshing…':'Refresh availability'}</button><small>Updates every 15 seconds while this page is visible.</small></div></div>
   {results.state === 'NO_SAILINGS' ? <div className="empty-sailings" role="status"><span className="empty-icon" aria-hidden="true">⛴</span><h2>No sailings found</h2><p>No published sailings are scheduled for this route and date. Try another date above or choose a different destination.</p></div> : <div className="sailing-list" aria-label="Sailing results">{results.sailings.map(sailing => <article key={sailing.id} className="sailing-card" aria-labelledby={`vessel-${sailing.id}`}><div className="sailing-card-heading"><div className="vessel-heading"><span className="vessel-icon" aria-hidden="true">⛴</span><div><h3 id={`vessel-${sailing.id}`}>{sailing.vessel.name}</h3><p>{sailing.vessel.operator}{sailing.vessel.registration?` · ${sailing.vessel.registration}`:''}</p></div></div><span className={`sailing-badge ${sailing.status==='CANCELLED'?'badge-alert':''}`}>{sailing.status.replaceAll('_',' ')}</span></div>
    <div className="sailing-overview"><div className="voyage-times"><div><strong>{sailingTime(sailing.departure)}</strong><small>Departure</small></div><div className="voyage-line"><span>{duration(sailing.durationMinutes)}</span><i aria-hidden="true">───────── →</i></div><div><strong>{sailingTime(sailing.arrival)}<sup>{arrivalLabel(sailing)}</sup></strong><small>Arrival</small></div></div><div className="sailing-inventory" aria-live="polite" aria-atomic="true"><span className={sailing.availability==='SOLD_OUT'?'seats sold-out':sailing.urgency?'seats urgent':'seats'}>{sailing.seatsLeft === 0 ? 'Sold out' : `${sailing.seatsLeft} seats left`}</span>{!sailing.bookable&&sailing.availability!=='SOLD_OUT'&&<small>{availabilityLabel[sailing.availability]}</small>}</div><div className="fare-from"><small>Adult fare from · per person</small><strong>{sailing.fareFromCentavos!==null?peso(sailing.fareFromCentavos):'Not available'}</strong><small>Terminal fee included</small></div></div>
    <div className="class-options">{sailing.classes.length ? sailing.classes.map(sailingClass => <div className="class-option" key={sailingClass.name}><div><h4>{sailingClass.name}</h4><p>{sailingClass.seatsLeft} {sailingClass.seatsLeft===1?'seat':'seats'} available{sailingClass.availability==='INSUFFICIENT_SEATS'?` · You need ${results.passengers}`:''}</p></div><div className="class-price">{sailingClass.totalFareCentavos!==null?<><strong>{peso(sailingClass.totalFareCentavos)}</strong><small>Regular adult · per person</small><small>Includes {peso(sailingClass.terminalFeeCentavos ?? 0)} terminal fee</small></>:<span>Fare not available</span>}</div><button type="button" disabled={!sailingClass.bookable || !!error || loading} aria-label={`Select ${sailingClass.name} on ${sailing.vessel.name}`} onClick={event=>choose(sailing,sailingClass,event.currentTarget)}>{sailingClass.bookable?'Select':availabilityLabel[sailingClass.availability]}</button></div>) : <p className="no-class-fares">Class fares are not available for this sailing.</p>}</div>
    <div className="sailing-card-note">{sailing.gate} · {sailing.terminal}<span>Online booking closes {results.bookingCutoffMinutes} minutes before departure.</span></div>
   </article>)}</div>}
   {selectedSailing && selectedClass && <div ref={summaryRef} tabIndex={-1} className="selection-summary" role="region" aria-labelledby="selection-title"><div className="section-heading"><h2 id="selection-title">Your selected crossing</h2><button type="button" className="text-button" onClick={()=>{setSelected(null);selectionTriggerRef.current?.focus();}}>Close selection</button></div><p>{selectedSailing.vessel.name} · {selectedClass.name} · {sailingTime(selectedSailing.departure)} on {fullDate(results.date)}</p><p>{results.passengers} {results.passengers===1?'passenger':'passengers'} · {selectedClass.totalFareCentavos!==null?`${peso(selectedClass.totalFareCentavos*results.passengers)} total based on regular adult fares`:'Fare unavailable'}</p><p>Terminal fees are included. Passenger categories and final fares will be confirmed before payment.</p>{(!selectedClass.bookable || !!error) && <p className="status error" role="alert">Availability has changed or could not be refreshed. Refresh the schedule and choose an available crossing.</p>}<div className="status" role="status"><strong>No seats reserved yet. Continue to choose your seats.</strong><p>Your selection does not hold a seat or create a booking.</p><Link className="button" href={`/book?sailingId=${selectedSailing.id}&className=${encodeURIComponent(selectedClass.name)}&passengers=${results.passengers}`}>Continue to seat selection</Link></div></div>}
  </>}
 </div>;
}

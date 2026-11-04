'use client';
import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getApi, manilaDate, Route, SearchFilters, searchLink } from '../lib/sailings';
export default function SearchForm({ initial, compact = false }: { initial?: Partial<SearchFilters>; compact?: boolean }) {
 const router = useRouter();
 const id = useId();
 const [routes,setRoutes] = useState<Route[]>([]);
 const [loading,setLoading] = useState(true);
 const [error,setError] = useState('');
 const [retry,setRetry] = useState(0);
 const [origin,setOrigin] = useState(initial?.origin ?? 'surigao');
 const [destination,setDestination] = useState(initial?.destination ?? '');
 const [date,setDate] = useState(initial?.date ?? '');
 const [passengers,setPassengers] = useState(initial?.passengers ?? '1');
 useEffect(() => { setOrigin(initial?.origin ?? 'surigao'); setDestination(initial?.destination ?? ''); setDate(initial?.date ?? manilaDate()); setPassengers(initial?.passengers ?? '1'); },[initial?.origin,initial?.destination,initial?.date,initial?.passengers]);
 useEffect(() => {
  const controller = new AbortController();
  setLoading(true); setError('');
  getApi<{ routes: Route[] }>('/routes',controller.signal).then(data => setRoutes(data.routes)).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load routes'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  return () => controller.abort();
 },[retry]);
 const origins = [...new Map(routes.map(route => [route.origin.id,route.origin])).values()];
 const destinations = routes.filter(route => route.origin.id === origin).map(route => route.destination);
 function submit(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); router.push(searchLink({origin,destination,date,passengers})); }
 return <section className={`trip-search ${compact ? 'compact-search' : ''}`} aria-labelledby={`${id}-title`}>
  <div className="search-heading"><span className="eyebrow">Plan your crossing</span><h2 id={`${id}-title`}>{compact ? 'Find another sailing' : 'Find available ferries'}</h2></div>
  {error && <div className="status error" role="alert">{error} <button type="button" className="text-button" onClick={() => setRetry(n=>n+1)}>Retry loading routes</button></div>}
  {loading && <p role="status">Loading routes…</p>}
  {!loading && !error && routes.length === 0 && <p role="status">No routes are available yet. Please check again later.</p>}
  <form className="search-fields" onSubmit={submit}>
   <div className="search-field"><label htmlFor={`${id}-origin`}>Origin terminal</label><select id={`${id}-origin`} name="origin" value={origin} disabled={loading || !!error} onChange={e => {setOrigin(e.target.value);setDestination('');}} required><option value="">Choose origin</option>{origins.map(port => <option key={port.id} value={port.id}>{port.name}</option>)}</select></div>
   <div className="search-field"><label htmlFor={`${id}-destination`}>Destination</label><select id={`${id}-destination`} name="destination" value={destination} disabled={loading || !!error || !origin} onChange={e => setDestination(e.target.value)} required><option value="">Choose destination</option>{destinations.map(port => <option key={port.id} value={port.id}>{port.name}</option>)}</select></div>
   <div className="search-field"><label htmlFor={`${id}-date`}>Departure date</label><input id={`${id}-date`} name="date" type="date" min="2000-01-01" max="2099-12-31" value={date} onChange={e => setDate(e.target.value)} required/><small>Philippine time (UTC+8)</small></div>
   <div className="search-field"><label htmlFor={`${id}-passengers`}>Passenger count</label><select id={`${id}-passengers`} name="passengers" value={passengers} onChange={e => setPassengers(e.target.value)} required>{Array.from({length:10},(_,i)=><option key={i+1} value={i+1}>{i+1} {i ? 'passengers' : 'passenger'}</option>)}</select><small>Maximum 10 per booking</small></div>
   <button type="submit" disabled={loading || !!error || routes.length === 0}>Search trips <span aria-hidden="true">→</span></button>
  </form>
 </section>;
}

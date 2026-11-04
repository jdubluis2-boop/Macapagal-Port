'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { duration, getApi, manilaDate, peso, PopularRoute, searchLink } from '../lib/sailings';
export default function PopularRoutes() {
 const [routes,setRoutes] = useState<PopularRoute[]>([]), [error,setError] = useState(''), [loading,setLoading] = useState(true), [retry,setRetry] = useState(0);
 useEffect(() => {
  const controller = new AbortController(); setError(''); setLoading(true);
  getApi<{routes:PopularRoute[]}>('/routes/popular',controller.signal).then(data => setRoutes(data.routes)).catch(e => {if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load routes');}).finally(() => {if (!controller.signal.aborted) setLoading(false);});
  return () => controller.abort();
 },[retry]);
 return <section className="popular-routes" aria-labelledby="popular-title"><div className="section-heading"><div><span className="eyebrow">Explore the islands</span><h2 id="popular-title">Popular sea routes</h2></div><p>Fares shown include the terminal fee.</p></div>
  {loading && <p role="status">Finding the next crossings…</p>}
  {error && <div className="status error" role="alert">{error} <button className="text-button" onClick={()=>setRetry(n=>n+1)}>Retry popular routes</button></div>}
  {!loading && !error && routes.length === 0 && <p>No routes are available yet. Please check again later.</p>}
  <div className="route-grid">{routes.map((route,index) => <article key={route.id} className="route-card"><div className={`route-art route-art-${index%3}`} aria-hidden="true"><span className="island island-one"/><span className="island island-two"/><span className="boat-mark">⛴</span><span className="route-art-label">{route.destination.name}</span></div><div className="route-card-content"><h3>{route.origin.name} <span aria-hidden="true">→</span> {route.destination.name}</h3><p>{route.vesselName ?? 'Check the latest sailing schedule'} · {duration(route.durationMinutes)} voyage</p><div className="route-card-bottom"><div>{route.fareFromCentavos !== null ? <><small>Adult fare from · per person</small><strong>{peso(route.fareFromCentavos)}</strong></> : <small>No bookable fare available</small>}</div><Link href={searchLink({origin:route.origin.id,destination:route.destination.id,date:route.nextDeparture ? manilaDate(new Date(route.nextDeparture)) : manilaDate(),passengers:'1'})}>View trips <span aria-hidden="true">↗</span></Link></div></div></article>)}</div>
 </section>;
}

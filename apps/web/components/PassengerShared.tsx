'use client';
import Link from 'next/link';
import { Voyage,travelDate,humanStatus } from '../lib/passenger-api';
export function ResourceState({loading,error,reload}:{loading:boolean;error:string;reload:()=>void}) {return <>{loading&&<p role="status">Loading your journey…</p>}{error&&<div className="status error" role="alert"><p>{error}</p><div className="button-row"><button type="button" onClick={reload}>Try again</button><Link href="/sign-in">Sign in</Link></div></div>}</>;}
export function VoyageSummary({sailing}:{sailing:Voyage}) {return <div className="voyage-summary"><h2>{sailing.route.origin.name} → {sailing.route.destination.name}</h2><p><strong>{sailing.vessel.name}</strong> · {travelDate(sailing.departure)} (Philippine time)</p><p>{sailing.gate} · {sailing.terminal} · {humanStatus(sailing.status)}</p></div>;}
export function PassengerPageHeading({title,description}:{title:string;description?:string}){return <div className="passenger-page-heading"><span className="eyebrow">Passenger services</span><h1>{title}</h1>{description&&<p>{description}</p>}</div>;}

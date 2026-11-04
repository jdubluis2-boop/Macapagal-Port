'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from './sailings';
export type Passenger = {id?:string;fullName:string;mobile:string;category:string;age:number;gender:string;emergencyContactName:string;emergencyContactMobile:string};
export type Voyage = {id:string;vessel:{id?:string;name:string};route:{origin:{id:string;name:string};destination:{id:string;name:string}};departure:string;arrival:string;gate:string;terminal:string;status:string};
export type Attempt = {id:string;reference:string;status:string;method:string;createdAt?:string};
export type Refund = {scope?:'BOOKING'|'PAYMENT';id:string;reference:string;status:string;amountCentavos:number;reason:string;requestedAt:string;processingAt?:string|null;completedAt?:string|null;booking?:Booking;payment?:{method:string}};
export type Ticket = {className?:string|null;id:string;status:string;seatLabel:string;passenger?:Passenger;sailing?:Voyage;booking?:Booking;qrToken?:string;qrDataUrl?:string;scan?:{scannedAt:string;gate:string}|null};
export type Booking = {id:string;reference:string;status:string;totalCentavos:number;terminalFeeCentavos:number;holdExpiresAt:string|null;counterDeadline?:string|null;extensionUsed?:boolean;sailing:Voyage;passengers:Passenger[];holds?:{seatId:string;seat?:{label:string};releasedAt?:string|null}[];attempts?:Attempt[];tickets?:Ticket[];refunds?:Refund[];payments?:{method:string;amountCentavos:number}[];createdAt?:string};
export class ApiError extends Error { constructor(message:string, public status:number){super(message);} }
export async function passengerApi<T>(path:string, body?:unknown, signal?:AbortSignal):Promise<T> {
 const response=await fetch(`${apiUrl}${path}`,{method:body===undefined?'GET':'POST',credentials:'include',cache:'no-store',signal,headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const result=await response.json();
 if(!response.ok) throw new ApiError(result.issues?.map((i:{field?:string;message:string})=>`${i.field?`${i.field}: `:''}${i.message}`).join('. ')||result.message||'Please try again.',response.status);
 return result;
}
export async function downloadDocument(path:string, filename:string) {
 const response=await fetch(`${apiUrl}${path}`,{credentials:'include',cache:'no-store'});
 if(!response.ok)throw new Error('Document is unavailable. Please refresh and try again.');
 const url=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function usePassengerResource<T>(path:string|null, interval=0, merge?:(previous:T|null,next:T)=>T) {
 const [data,setData]=useState<T|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
 const reload=useCallback(()=>setRevision(n=>n+1),[]);
 const previousPath=useRef<string|null>(null);
 useEffect(()=>{
  if(!path){setLoading(false);return;}
  const controller=new AbortController();let inFlight=false;
  if(previousPath.current!==path){setData(null);setLoading(true);previousPath.current=path;}
  async function load(){if(inFlight||controller.signal.aborted)return;inFlight=true;try{const response=await passengerApi<T>(path!,undefined,controller.signal);if(!controller.signal.aborted){setData(previous=>merge?merge(previous,response):response);setError('');}}catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Unable to connect. Please try again.');}finally{inFlight=false;if(!controller.signal.aborted)setLoading(false);}}
  void load();const timer=interval?window.setInterval(()=>{if(!document.hidden)void load();},interval):null;
  const resume=()=>{if(!document.hidden)void load();};document.addEventListener('visibilitychange',resume);
  return()=>{controller.abort();if(timer)window.clearInterval(timer);document.removeEventListener('visibilitychange',resume);};
 },[path,interval,revision,merge]);
 return {data,error,loading,reload,setData};
}
export function useHoldCountdown(expiresAt:string|null|undefined,serverTime:string|undefined) {
 const [seconds,setSeconds]=useState<number|null>(null);
 useEffect(()=>{
  if(!expiresAt||!serverTime){setSeconds(null);return;}
  const base=(Date.parse(expiresAt)-Date.parse(serverTime))/1000;const start=performance.now();
  const tick=()=>setSeconds(Math.max(0,Math.ceil(base-(performance.now()-start)/1000)));tick();const timer=window.setInterval(tick,1000);return()=>window.clearInterval(timer);
 },[expiresAt,serverTime]);
 return seconds;
}
export const humanStatus=(status:string)=>status.replaceAll('_',' ').toLowerCase().replace(/^./,s=>s.toUpperCase());
export const travelDate=(iso:string)=>new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(iso));
export const emptyPassenger=():Passenger=>({fullName:'',mobile:'',category:'REGULAR_ADULT',age:18,gender:'FEMALE',emergencyContactName:'',emergencyContactMobile:''});

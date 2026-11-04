'use client';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { apiUrl,SearchFilters } from './sailings';
export function useRealtimeRefresh(refresh:()=>void,options?:{sailingId?:string;route?:SearchFilters}){
 const sailingId=options?.sailingId,origin=options?.route?.origin,destination=options?.route?.destination,date=options?.route?.date;
 useEffect(()=>{
  const socket=io(apiUrl,{withCredentials:true,reconnection:true});let timer:ReturnType<typeof setTimeout>|null=null;
  const schedule=()=>{if(!timer)timer=setTimeout(()=>{timer=null;refresh();},100);};
  socket.on('connect',()=>{refresh();if(sailingId)socket.emit('subscribe',{sailingId});if(origin&&destination&&date)socket.emit('subscribe',{origin,destination,date});});
  for(const event of ['sailing.updated','seat.updated','seat.released','payment.processing','payment.succeeded','payment.failed','ticket.issued','hold.expired','hold.expiring','refund.updated','booking.updated','notification.updated'])socket.on(event,schedule);
  return()=>{if(timer)clearTimeout(timer);socket.disconnect();};
 },[refresh,sailingId,origin,destination,date]);
}

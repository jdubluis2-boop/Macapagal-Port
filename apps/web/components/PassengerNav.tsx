'use client';
import Link from 'next/link';
import { useEffect,useState } from 'react';
import { usePathname } from 'next/navigation';
import { passengerApi } from '../lib/passenger-api';
export default function PassengerNav(){const [user,setUser]=useState<{role:string}|null>(null);const path=usePathname();useEffect(()=>{const controller=new AbortController();passengerApi<{user:{role:string}}>('/auth/me',undefined,controller.signal).then(data=>setUser(data.user)).catch(()=>{if(!controller.signal.aborted)setUser(null);});return()=>controller.abort();},[path]);const active=(href:string)=>href==='/'?path==='/':path===href||path.startsWith(`${href}/`);const item=(href:string,label:string,account=false)=><Link key={href} href={href} aria-current={active(href)?'page':undefined} className={account?'nav-account':undefined}>{label}</Link>;return <nav aria-label="Main navigation">{item('/','Home')}{item('/bookings','Bookings')}{item('/sailings','Schedules')}{item('/tickets','My Tickets')}{user&&item('/notifications','Updates')}{user&&user.role!=='PASSENGER'&&item('/staff','Staff')}{item(user?'/account':'/sign-in',user?'My account':'Sign in',true)}</nav>;}

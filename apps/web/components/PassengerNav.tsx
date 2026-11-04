'use client';
import Link from 'next/link';
import { useEffect,useState } from 'react';
import { usePathname } from 'next/navigation';
import { passengerApi } from '../lib/passenger-api';
export default function PassengerNav(){const [user,setUser]=useState<{role:string}|null>(null);const path=usePathname();useEffect(()=>{const controller=new AbortController();passengerApi<{user:{role:string}}>('/auth/me',undefined,controller.signal).then(data=>setUser(data.user)).catch(()=>{if(!controller.signal.aborted)setUser(null);});return()=>controller.abort();},[path]);return <nav aria-label="Main navigation"><Link href="/">Home</Link><Link href="/bookings">Bookings</Link><Link href="/sailings">Schedules</Link><Link href="/tickets">My Tickets</Link>{user&&<Link href="/notifications">Updates</Link>}{user&&user.role!=='PASSENGER'&&<Link href="/staff">Staff</Link>}<Link href={user?'/account':'/sign-in'}>{user?'My account':'Sign in'}</Link></nav>;}

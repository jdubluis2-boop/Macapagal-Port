import { Suspense } from 'react';
import SeatBooking from '../../components/SeatBooking';
export default function BookPage(){return <Suspense fallback={<p role="status">Loading seat selection…</p>}><SeatBooking/></Suspense>;}

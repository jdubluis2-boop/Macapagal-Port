import { Suspense } from 'react';
import SailingSearch from '../../components/SailingSearch';
export default function SailingsPage() { return <Suspense fallback={<div className="sailings-page"><p role="status">Loading sailing search…</p></div>}><SailingSearch/></Suspense>; }

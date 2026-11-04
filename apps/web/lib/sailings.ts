export type Port = { id: string; name: string };
export type Route = { id: string; origin: Port; destination: Port; durationMinutes: number };
export type PopularRoute = Route & { vesselName: string | null; fareFromCentavos: number | null; nextDeparture: string | null };
export type Availability = 'AVAILABLE' | 'SOLD_OUT' | 'INSUFFICIENT_SEATS' | 'BOOKING_CLOSED' | 'FARE_UNAVAILABLE';
export type SailingClass = { name: string; seatsLeft: number; baseFareCentavos: number | null; terminalFeeCentavos: number | null; totalFareCentavos: number | null; availability: Availability; bookable: boolean };
export type Sailing = { id: string; vessel: { id: string; name: string; operator: string; registration: string | null }; departure: string; arrival: string; durationMinutes: number; status: string; gate: string; terminal: string; seatsLeft: number; urgency: boolean; fareFromCentavos: number | null; availability: Availability; bookable: boolean; classes: SailingClass[] };
export type SailingResults = { origin: Port; destination: Port; date: string; passengers: number; timeZone: string; serverTime: string; bookingCutoffMinutes: number; state: 'NO_SAILINGS' | 'SAILINGS'; sailings: Sailing[] };
export type SearchFilters = { origin: string; destination: string; date: string; passengers: string };
export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export async function getApi<T>(path: string, signal?: AbortSignal): Promise<T> {
 const response = await fetch(`${apiUrl}${path}`, { signal, cache: 'no-store' });
 const data = await response.json();
 if (!response.ok) throw new Error(data.issues?.map((issue: { field: string; message: string }) => `${issue.field}: ${issue.message}`).join('. ') || data.message || 'Unable to load sailings. Please try again.');
 return data as T;
}
export const peso = (centavos: number) => `P${(centavos / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const duration = (minutes: number) => `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
export const manilaDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
export const sailingTime = (iso: string) => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
export const fullDate = (iso: string) => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${iso}T12:00:00+08:00`));
export function validDate(value: string) {
 if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
 const date = new Date(`${value}T00:00:00Z`);
 return !Number.isNaN(+date) && date.toISOString().slice(0,10) === value;
}
export function offsetDate(date: string, days: number) {
 const next = new Date(`${date}T00:00:00Z`);
 next.setUTCDate(next.getUTCDate() + days);
 return next.toISOString().slice(0,10);
}
export const searchLink = (filters: SearchFilters) => `/sailings?${new URLSearchParams(filters).toString()}`;
export const availabilityLabel: Record<Availability, string> = { AVAILABLE: 'Available', SOLD_OUT: 'Sold out', INSUFFICIENT_SEATS: 'Not enough seats', BOOKING_CLOSED: 'Online booking closed', FARE_UNAVAILABLE: 'Fare unavailable' };

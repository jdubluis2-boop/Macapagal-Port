import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import type { SailingStatus } from '@prisma/client';

dotenv.config({ path: new URL('../../../.env', import.meta.url), quiet: true });
if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Set TEST_DATABASE_URL to an isolated *_test database');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = 'redis://127.0.0.1:6379/15';
process.env.BOOKING_CUTOFF_MINUTES = '60';
const { buildApp, db } = await import('../src/app.js');
const initialNow = new Date('2030-04-14T15:00:00.000Z');
let clock = initialNow;
const app = await buildApp({ now: () => clock });
const namespace = `search-test-${randomUUID()}`;
const originId = `${namespace}-origin`;
const destinationId = `${namespace}-destination`;
const otherPortId = `${namespace}-other`;
const routeId = `${namespace}-route`;
const vesselId = `${namespace}-vessel`;
const foreignVesselId = `${namespace}-foreign-vessel`;
const businessLayout = `${namespace}-business`;
const economyLayout = `${namespace}-economy`;
const foreignLayout = `${namespace}-foreign-layout`;
const date = '2030-04-15';

type SearchClass = { name: string; seatsLeft: number; baseFareCentavos: number | null; terminalFeeCentavos: number | null; totalFareCentavos: number | null; availability: string; bookable: boolean };
type SearchSailing = { id: string; vessel: { id: string; name: string; operator: string; registration: string | null }; departure: string; arrival: string; durationMinutes: number; status: string; seatsLeft: number; urgency: boolean; fareFromCentavos: number | null; availability: string; bookable: boolean; classes: SearchClass[] };
type SearchResult = { state: string; timeZone: string; serverTime: string; date: string; passengers: number; bookingCutoffMinutes: number; sailings: SearchSailing[] };
const ids: string[] = [];
async function clearSailings() {
  if (!ids.length) return;
  await db.fare.deleteMany({ where: { sailingId: { in: ids } } });
  await db.sailingSeat.deleteMany({ where: { sailingId: { in: ids } } });
  await db.sailing.deleteMany({ where: { id: { in: ids } } });
  ids.length = 0;
  clock = initialNow;
}
async function sailing(options: { departure?: string; status?: SailingStatus; published?: boolean; business?: number; economy?: number; fares?: boolean; foreignSeat?: boolean; durationMinutes?: number } = {}) {
  const departure = new Date(options.departure ?? '2030-04-15T02:00:00.000Z');
  const result = await db.sailing.create({ data: { vesselId, routeId, departure, arrival: new Date(+departure + (options.durationMinutes ?? 90) * 60000), status: options.status ?? 'SCHEDULED', published: options.published ?? true, gate: 'Gate 04', terminal: 'Terminal 1' } });
  ids.push(result.id);
  for (const [layoutId, available] of [[businessLayout, options.business ?? 10], [economyLayout, options.economy ?? 10]] as const) {
    await db.sailingSeat.createMany({ data: Array.from({ length: 10 }, (_, i) => ({ sailingId: result.id, seatId: `${layoutId}-${i + 1}`, state: i < available ? 'AVAILABLE' as const : 'SOLD' as const })) });
  }
  if (options.foreignSeat) await db.sailingSeat.create({ data: { sailingId: result.id, seatId: `${foreignLayout}-1`, state: 'AVAILABLE' } });
  if (options.fares !== false) {
    await db.fare.createMany({ data: [
      { sailingId: result.id, className: 'Business', category: 'REGULAR_ADULT', baseCentavos: 45000, terminalFeeCentavos: 3000 },
      { sailingId: result.id, className: 'Economy', category: 'REGULAR_ADULT', baseCentavos: 35000, terminalFeeCentavos: 3000 },
      // A discounted fare must not become the unqualified adult "fare from".
      { sailingId: result.id, className: 'Economy', category: 'CHILD', baseCentavos: 10000, terminalFeeCentavos: 3000 },
    ] });
  }
  return result;
}
async function search(overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({ origin: originId, destination: destinationId, date, passengers: '1', ...overrides });
  return app.inject({ method: 'GET', url: `/sailings/search?${params}` });
}
async function result(overrides: Record<string, string> = {}): Promise<SearchResult> {
  const response = await search(overrides);
  assert.equal(response.statusCode, 200, response.body);
  return response.json<SearchResult>();
}

test('sailing search against PostgreSQL inventory', async t => {
  try {
    await db.port.createMany({ data: [{ id: originId, name: 'Test Macapagal Port' }, { id: destinationId, name: 'Test Dapa' }, { id: otherPortId, name: 'Test Unserved Port' }] });
    await db.route.create({ data: { id: routeId, originId, destinationId, durationMinutes: 90 } });
    await db.vessel.createMany({ data: [{ id: vesselId, name: 'Test Ferry', operator: 'Test Operator', registration: 'TEST-224' }, { id: foreignVesselId, name: 'Other Ferry', operator: 'Other Operator' }] });
    await db.vesselSeatLayout.createMany({ data: [{ id: businessLayout, vesselId, className: 'Business', deck: 1 }, { id: economyLayout, vesselId, className: 'Economy', deck: 2 }, { id: foreignLayout, vesselId: foreignVesselId, className: 'Business', deck: 1 }] });
    await db.seat.createMany({ data: [businessLayout, economyLayout].flatMap(layoutId => Array.from({ length: 10 }, (_, i) => ({ id: `${layoutId}-${i + 1}`, layoutId, label: `${layoutId === businessLayout ? 'B' : 'E'}-${i + 1}`, row: Math.floor(i / 4) + 1, column: i % 4 + 1 }))).concat([{ id: `${foreignLayout}-1`, layoutId: foreignLayout, label: 'B-1', row: 1, column: 1 }]) });

    await t.test('route metadata comes from stored ports and route', async () => {
      const response = await app.inject('/routes');
      assert.equal(response.statusCode, 200);
      const route = response.json<{ routes: { id: string; origin: { id: string; name: string }; destination: { id: string; name: string }; durationMinutes: number }[] }>().routes.find(r => r.id === routeId);
      assert.ok(route);
      assert.deepEqual(route.origin, { id: originId, name: 'Test Macapagal Port' });
      assert.equal(route.destination.id, destinationId);
      assert.equal(route.durationMinutes, 90);
    });
    await t.test('invalid calendar dates, passenger counts and identical endpoints are rejected', async () => {
      const invalidQueries: Record<string, string>[] = [{ date: '2030-02-30' }, { date: '2030-4-15' }, { passengers: '0' }, { passengers: '11' }, { passengers: '1.5' }, { passengers: 'abc' }, { destination: originId }];
      for (const overrides of invalidQueries) {
        assert.equal((await search(overrides)).statusCode, 400, JSON.stringify(overrides));
      }
      assert.equal((await app.inject('/sailings/search')).statusCode, 400);
      assert.equal((await search({ origin: 'does-not-exist' })).statusCode, 404);
    });
    await t.test('no published sailing and an unserved pair produce no-sailings, not sold-out', async () => {
      await clearSailings();
      await sailing({ published: false });
      const empty = await result();
      assert.equal(empty.state, 'NO_SAILINGS');
      assert.equal(empty.sailings.length, 0);
      assert.equal((await result({ destination: otherPortId })).state, 'NO_SAILINGS');
    });
    await t.test('sailing card includes vessel, elapsed duration, timezone and adult fare with one terminal fee', async () => {
      await clearSailings();
      await sailing();
      const response = await result();
      assert.equal(response.state, 'SAILINGS');
      assert.equal(response.timeZone, 'Asia/Manila');
      assert.equal(response.serverTime, initialNow.toISOString());
      assert.equal(response.bookingCutoffMinutes, 60);
      const card = response.sailings[0];
      assert.equal(card.vessel.registration, 'TEST-224');
      assert.equal(card.durationMinutes, 90);
      assert.equal(card.seatsLeft, 20);
      assert.equal(card.urgency, false);
      assert.equal(card.bookable, true);
      assert.equal(card.fareFromCentavos, 38000);
      const business = card.classes.find(c => c.name === 'Business')!;
      assert.deepEqual([business.baseFareCentavos, business.terminalFeeCentavos, business.totalFareCentavos], [45000, 3000, 48000]);
    });
    await t.test('only AVAILABLE seats on the sailing vessel count and 12-or-fewer triggers urgency', async () => {
      await clearSailings();
      const row = await sailing({ business: 10, economy: 2, foreignSeat: true });
      let card = (await result()).sailings[0];
      assert.equal(card.seatsLeft, 12);
      assert.equal(card.urgency, true);
      await db.sailingSeat.update({ where: { sailingId_seatId: { sailingId: row.id, seatId: `${businessLayout}-1` } }, data: { state: 'HELD', version: { increment: 1 } } });
      await db.sailingSeat.update({ where: { sailingId_seatId: { sailingId: row.id, seatId: `${businessLayout}-2` } }, data: { state: 'PENDING_PAYMENT', version: { increment: 1 } } });
      await db.sailingSeat.update({ where: { sailingId_seatId: { sailingId: row.id, seatId: `${businessLayout}-3` } }, data: { state: 'BLOCKED', version: { increment: 1 } } });
      card = (await result()).sailings[0];
      assert.equal(card.seatsLeft, 9);
      assert.equal(card.classes.find(c => c.name === 'Business')!.seatsLeft, 7);
    });
    await t.test('sold-out is distinct from no-sailings and inventory changes are visible on refresh', async () => {
      await clearSailings();
      const row = await sailing({ business: 0, economy: 0 });
      let response = await result();
      assert.equal(response.state, 'SAILINGS');
      assert.equal(response.sailings[0].availability, 'SOLD_OUT');
      assert.equal(response.sailings[0].bookable, false);
      await db.sailingSeat.update({ where: { sailingId_seatId: { sailingId: row.id, seatId: `${businessLayout}-1` } }, data: { state: 'AVAILABLE', version: { increment: 1 } } });
      response = await result();
      assert.equal(response.sailings[0].availability, 'AVAILABLE');
      assert.equal(response.sailings[0].seatsLeft, 1);
    });
    await t.test('a party must fit one class and quoted fare comes from a bookable class', async () => {
      await clearSailings();
      await sailing({ business: 7, economy: 3 });
      const ten = (await result({ passengers: '10' })).sailings[0];
      assert.equal(ten.seatsLeft, 10);
      assert.equal(ten.availability, 'INSUFFICIENT_SEATS');
      assert.equal(ten.bookable, false);
      const five = (await result({ passengers: '5' })).sailings[0];
      assert.equal(five.bookable, true);
      assert.equal(five.fareFromCentavos, 48000);
      assert.equal(five.classes.find(c => c.name === 'Economy')!.availability, 'INSUFFICIENT_SEATS');
    });
    await t.test('missing adult fares prevent selection without inventing a price', async () => {
      await clearSailings();
      await sailing({ fares: false });
      const card = (await result()).sailings[0];
      assert.equal(card.availability, 'FARE_UNAVAILABLE');
      assert.equal(card.fareFromCentavos, null);
      assert.equal(card.bookable, false);
    });
    await t.test('Manila midnight boundaries are inclusive at start and exclusive at next day', async () => {
      await clearSailings();
      const before = await sailing({ departure: '2030-04-14T15:59:59.999Z' });
      const start = await sailing({ departure: '2030-04-14T16:00:00.000Z' });
      const last = await sailing({ departure: '2030-04-15T15:59:59.999Z' });
      const next = await sailing({ departure: '2030-04-15T16:00:00.000Z' });
      const found = (await result()).sailings.map(s => s.id);
      assert.deepEqual(found, [start.id, last.id]);
      assert.ok(!found.includes(before.id) && !found.includes(next.id));
    });
    await t.test('cutoff is enforced exactly and recomputed from server time', async () => {
      await clearSailings();
      await sailing({ departure: '2030-04-14T16:00:00.000Z' });
      assert.equal((await result()).sailings[0].availability, 'BOOKING_CLOSED');
      clock = new Date(+initialNow - 1);
      assert.equal((await result()).sailings[0].bookable, true);
      clock = new Date(+initialNow + 1);
      assert.equal((await result()).sailings[0].bookable, false);
    });
    await t.test('only scheduled, boarding and delayed statuses are eligible for online selection', async () => {
      await clearSailings();
      for (const status of ['SCHEDULED', 'BOARDING', 'DELAYED', 'DEPARTED', 'CANCELLED', 'ARRIVED'] as const) await sailing({ status });
      const rows = (await result()).sailings;
      assert.equal(rows.length, 6);
      for (const row of rows) {
        const eligible = ['SCHEDULED', 'BOARDING', 'DELAYED'].includes(row.status);
        assert.equal(row.bookable, eligible, row.status);
        if (!eligible) assert.equal(row.availability, 'BOOKING_CLOSED');
      }
    });
    await t.test('past departures cannot be selected even when status was not updated', async () => {
      await clearSailings();
      await sailing({ departure: '2030-04-15T02:00:00.000Z' });
      clock = new Date('2030-04-15T03:00:00.000Z');
      assert.equal((await result()).sailings[0].availability, 'BOOKING_CLOSED');
    });
    await t.test('popular-route price is derived from a bookable adult fare and excludes sold-out bargains', async () => {
      await clearSailings();
      await sailing({ economy: 0, business: 5, durationMinutes: 120 });
      const soldOut = await sailing({ economy: 0, business: 0, departure: '2030-04-15T01:00:00.000Z' });
      await db.fare.updateMany({ where: { sailingId: soldOut.id }, data: { baseCentavos: 1000 } });
      const response = await app.inject('/routes/popular');
      assert.equal(response.statusCode, 200);
      const route = response.json<{ routes: { id: string; fareFromCentavos: number | null; vesselName: string | null; nextDeparture: string | null; durationMinutes: number }[] }>().routes.find(r => r.id === routeId);
      assert.ok(route);
      assert.equal(route.fareFromCentavos, 48000);
      assert.equal(route.vesselName, 'Test Ferry');
      assert.equal(route.durationMinutes, 120);
      assert.equal(route.nextDeparture, '2030-04-15T02:00:00.000Z');
    });
  } finally {
    await clearSailings();
    await db.seat.deleteMany({ where: { layoutId: { in: [businessLayout, economyLayout, foreignLayout] } } });
    await db.vesselSeatLayout.deleteMany({ where: { id: { in: [businessLayout, economyLayout, foreignLayout] } } });
    await db.vessel.deleteMany({ where: { id: { in: [vesselId, foreignVesselId] } } });
    await db.route.deleteMany({ where: { id: routeId } });
    await db.port.deleteMany({ where: { id: { in: [originId, destinationId, otherPortId] } } });
    await app.close();
  }
});

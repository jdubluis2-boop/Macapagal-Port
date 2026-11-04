import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: new URL('../../../.env', import.meta.url), quiet: true });
if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')) throw new Error('Set TEST_DATABASE_URL to an isolated *_test database');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
const { registerBookingRoutes, sweepBookings, seatKey } = await import('../src/bookings.js');
const { encrypt, decrypt } = await import('../src/encryption.js');
const { config } = await import('../src/config.js');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
const redis = new Redis('redis://127.0.0.1:6379/15');
const prefix = `booking-test-${randomUUID()}`;
const originId = `${prefix}-origin`, destinationId = `${prefix}-destination`, routeId = `${prefix}-route`, vesselId = `${prefix}-vessel`;
const layoutId = `${prefix}-business`, economyId = `${prefix}-economy`;
const sailingId = randomUUID();
const userIds = Array.from({ length: 6 }, () => randomUUID());
const seatIds = Array.from({ length: 10 }, (_, i) => `${layoutId}-${i + 1}`);
const economySeat = `${economyId}-1`;
const initialNow = new Date('2030-04-15T00:00:00.000Z');
let now = initialNow;
const emitted: { room: string; event: string; payload: unknown }[] = [];
const jobs: { name: string; data: unknown }[] = [];
const app = Fastify({ logger: false });
await app.register(cookie);
app.setErrorHandler((error, _req, reply) => {
 const status = error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500;
 reply.code(status).send({ message: (error as Error).message });
});
const auth = async (req: { cookies: Record<string, string | undefined> }) => {
 const user = req.cookies.test_user ? await db.user.findUnique({ where: { id: req.cookies.test_user } }) : null;
 if (!user) throw Object.assign(new Error('Sign in'), { statusCode: 401 });
 return user;
};
const ctx = { db, redis, now: () => now, auth,
 verified: async (req: { cookies: Record<string, string | undefined> }) => { const user = await auth(req); if (!user.verifiedAt) throw Object.assign(new Error('Verify email'), { statusCode: 403 });return user; },
 staff: async (req: { cookies: Record<string, string | undefined> }) => auth(req),
 emit: (room: string, event: string, payload: unknown) => emitted.push({ room, event, payload }),
 jobs: { add: async (name: string, data: unknown) => { jobs.push({ name, data });return {}; } } as unknown as Queue,
 encrypt, decrypt,
};
registerBookingRoutes(app, ctx);
const person = (n = 1) => ({ fullName: `Passenger Test ${n}`, mobile: '+63 912 345 6789', category: 'REGULAR_ADULT', age: 30, gender: 'MALE', emergencyContactName: 'Emergency Contact', emergencyContactMobile: '+63 912 345 6789' });
const post = (path: string, body: unknown, user = 0, ip = '127.0.0.1') => app.inject({ method: 'POST', url: path, payload: JSON.stringify(body), remoteAddress: ip, headers: { 'content-type': 'application/json', cookie: `test_user=${userIds[user]}` } });
const hold = (seats: string[], user = 0, ip = '127.0.0.1') => post('/bookings', { sailingId, seatIds: seats, passengers: seats.map((_s, i) => person(i + 1)) }, user, ip);
async function clear() {
 const rows = await db.booking.findMany({ where: { sailingId }, select: { id: true } });
 const ids = rows.map(b => b.id);
 await db.payment.deleteMany({ where: { bookingId: { in: ids } } });
 await db.paymentAttempt.deleteMany({ where: { bookingId: { in: ids } } });
 await db.seatHold.deleteMany({ where: { bookingId: { in: ids } } });
 await db.bookingPassenger.deleteMany({ where: { bookingId: { in: ids } } });
 await db.booking.deleteMany({ where: { id: { in: ids } } });
 await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
 await db.sailingSeat.updateMany({ where: { sailingId }, data: { state: 'AVAILABLE', version: 0 } });
 await redis.del(...[...seatIds, economySeat].map(id => seatKey(sailingId, id)));
 for (const userId of userIds) {
  let cursor = '0';
  do { const result = await redis.scan(cursor, 'MATCH', `hold-rate:${userId}:*`, 'COUNT', 100);cursor = result[0];if (result[1].length) await redis.del(...result[1]); } while (cursor !== '0');
 }
 now = initialNow; emitted.length = 0;jobs.length = 0;
}

test('atomic seat holds and authoritative expiry', async t => {
 try {
  await db.port.createMany({ data: [{ id: originId, name: 'Booking test origin' }, { id: destinationId, name: 'Booking test destination' }] });
  await db.route.create({ data: { id: routeId, originId, destinationId, durationMinutes: 90 } });
  await db.vessel.create({ data: { id: vesselId, name: 'Booking test vessel', operator: 'Test Operator' } });
  await db.vesselSeatLayout.createMany({ data: [{ id: layoutId, vesselId, className: 'Business', deck: 1 }, { id: economyId, vesselId, className: 'Economy', deck: 2 }] });
  await db.seat.createMany({ data: [...seatIds.map((id, i) => ({ id, layoutId, label: `B-${i + 1}`, row: Math.floor(i / 4) + 1, column: i % 4 + 1 })), { id: economySeat, layoutId: economyId, label: 'E-1', row: 1, column: 1 }] });
  await db.sailing.create({ data: { id: sailingId, vesselId, routeId, departure: new Date(+initialNow + 86400000), arrival: new Date(+initialNow + 91800000), published: true, gate: 'Gate 04', terminal: 'Terminal 1' } });
  await db.sailingSeat.createMany({ data: [...seatIds, economySeat].map(seatId => ({ sailingId, seatId })) });
  await db.fare.createMany({ data: [{ sailingId, className: 'Business', category: 'REGULAR_ADULT', baseCentavos: 45000, terminalFeeCentavos: 3000 }, { sailingId, className: 'Economy', category: 'REGULAR_ADULT', baseCentavos: 35000, terminalFeeCentavos: 3000 }] });
  await db.user.createMany({ data: userIds.map((id, i) => ({ id, email: `${prefix}-${i}@example.test`, fullName: 'Test User', mobile: '+639123456789', passwordHash: 'test-only-not-used-for-login', consentAt: initialNow, verifiedAt: i === 5 ? null : initialNow })) });

  await t.test('two simultaneous users requesting one seat produce exactly one winner', async () => {
   await clear();
   const attempts = await Promise.all([hold([seatIds[0]], 0), hold([seatIds[0]], 1)]);
   assert.deepEqual(attempts.map(r => r.statusCode).sort(), [200, 409], attempts.map(r => r.body).join('\n'));
   assert.equal(await db.seatHold.count({ where: { sailingId, releasedAt: null } }), 1);
   const booking = attempts.find(r => r.statusCode === 200)!.json().booking;
   assert.equal(await redis.get(seatKey(sailingId, seatIds[0])), booking.id);
  });
  await t.test('10 passengers with only 7 free seats leave no partial booking or Redis hold', async () => {
   await clear();
   await db.sailingSeat.updateMany({ where: { sailingId, seatId: { in: seatIds.slice(7) } }, data: { state: 'BLOCKED' } });
   assert.equal((await hold(seatIds)).statusCode, 409);
   assert.equal(await db.booking.count({ where: { sailingId } }), 0);
   assert.equal(await db.seatHold.count({ where: { sailingId, releasedAt: null } }), 0);
   for (const id of seatIds) assert.equal(await redis.get(seatKey(sailingId, id)), null);
  });
  await t.test('Redis conflict acquires none of the other requested keys', async () => {
   await clear();
   await redis.set(seatKey(sailingId, seatIds[1]), 'another-booking', 'EX', 60);
   assert.equal((await hold([seatIds[0], seatIds[1]])).statusCode, 409);
   assert.equal(await redis.get(seatKey(sailingId, seatIds[0])), null);
   assert.equal(await redis.get(seatKey(sailingId, seatIds[1])), 'another-booking');
  });
  await t.test('PostgreSQL prevents a second assignment after Redis loses its key', async () => {
   await clear();
   assert.equal((await hold([seatIds[0]])).statusCode, 200);
   await redis.del(seatKey(sailingId, seatIds[0]));
   assert.equal((await hold([seatIds[0]], 1)).statusCode, 409);
   assert.equal(await db.seatHold.count({ where: { sailingId, seatId: seatIds[0], releasedAt: null } }), 1);
  });
  await t.test('active-assignment database uniqueness survives missing Redis and a stale inventory mirror', async () => {
   await clear();
   const first = (await hold([seatIds[0]])).json().booking;
   await redis.del(seatKey(sailingId, seatIds[0]));
   await db.sailingSeat.update({ where: { sailingId_seatId: { sailingId, seatId: seatIds[0] } }, data: { state: 'AVAILABLE' } });
   const conflict = await hold([seatIds[0]], 1);
   assert.equal(conflict.statusCode, 409, conflict.body);
   assert.equal(await db.booking.count({ where: { sailingId } }), 1);
   assert.equal(await db.seatHold.count({ where: { sailingId, seatId: seatIds[0], releasedAt: null, bookingId: first.id } }), 1);
   assert.equal(await redis.get(seatKey(sailingId, seatIds[0])), null);
  });
  await t.test('hold creation is limited to ten attempts per user per minute', async () => {
   await clear();
   await db.sailingSeat.update({ where: { sailingId_seatId: { sailingId, seatId: seatIds[0] } }, data: { state: 'BLOCKED' } });
   for (let i = 0; i < 10; i++) assert.equal((await hold([seatIds[0]])).statusCode, 409);
   assert.equal((await hold([seatIds[0]])).statusCode, 429);
  });
  await t.test('hold stores encrypted passenger details and server-computed fare including fee once', async () => {
   await clear();
   const response = await hold([seatIds[0], seatIds[1]]);
   assert.equal(response.statusCode, 200, response.body);
   const body = response.json();
   assert.equal(body.serverTime, initialNow.toISOString());
   assert.equal(body.booking.totalCentavos, 96000);
   assert.equal(body.booking.terminalFeeCentavos, 6000);
   assert.equal(body.booking.passengers[0].seatId, seatIds[0]);
   assert.equal(body.booking.passengers[0].fullName, 'Passenger Test 1');
   assert.ok(!('detailsCiphertext' in body.booking.passengers[0]));
   const stored = await db.bookingPassenger.findFirstOrThrow({ where: { bookingId: body.booking.id } });
   assert.ok(stored.detailsCiphertext.startsWith('v1.'));
   assert.ok(!stored.detailsCiphertext.includes('Passenger'));
   assert.equal(jobs[0].name, 'hold.expire');
   assert.ok(emitted.some(e => e.event === 'seat.updated' && (e.payload as { version: number }).version === 1));
  });
  await t.test('exchange is atomic and a failed exchange preserves the original seat', async () => {
   await clear();
   const first = (await hold([seatIds[0]])).json().booking;
   assert.equal((await hold([seatIds[1]], 1)).statusCode, 200);
   assert.equal((await post(`/bookings/${first.id}/seats`, { seatIds: [seatIds[1]] })).statusCode, 409);
   assert.equal(await redis.get(seatKey(sailingId, seatIds[0])), first.id);
   assert.equal((await db.sailingSeat.findUniqueOrThrow({ where: { sailingId_seatId: { sailingId, seatId: seatIds[0] } } })).state, 'HELD');
   const swapped = await post(`/bookings/${first.id}/seats`, { seatIds: [seatIds[2]] });
   assert.equal(swapped.statusCode, 200, swapped.body);
   assert.equal(await redis.get(seatKey(sailingId, seatIds[0])), null);
   assert.equal(await redis.get(seatKey(sailingId, seatIds[2])), first.id);
   assert.equal(swapped.json().booking.passengers[0].seatId, seatIds[2]);
   assert.equal(swapped.json().booking.holdExpiresAt, first.holdExpiresAt);
  });
  await t.test('one extension is server-authoritative and original delayed expiry cannot release it early', async () => {
   await clear();
   const booking = (await hold([seatIds[0]])).json().booking;
   const extension = await post(`/bookings/${booking.id}/extend`, {});
   assert.equal(extension.statusCode, 200, extension.body);
   assert.equal(+new Date(extension.json().booking.holdExpiresAt), +initialNow + (config.SEAT_HOLD_TTL_SECONDS + config.SEAT_HOLD_EXTENSION_SECONDS) * 1000);
   assert.equal((await post(`/bookings/${booking.id}/extend`, {})).statusCode, 409);
   now = new Date(+initialNow + config.SEAT_HOLD_TTL_SECONDS * 1000 + 1);
   await sweepBookings(ctx, userIds[0]);
   assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'SEAT_HELD');
   now = new Date(+initialNow + (config.SEAT_HOLD_TTL_SECONDS + config.SEAT_HOLD_EXTENSION_SECONDS) * 1000 + 1);
   await sweepBookings(ctx, userIds[0]);
   assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'HOLD_EXPIRED');
  });
  await t.test('expiry preserves edited passenger data; reselection requotes and does not guarantee the old seat', async () => {
   await clear();
   const booking = (await hold([seatIds[0]])).json().booking;
   now = new Date(+initialNow + config.SEAT_HOLD_TTL_SECONDS * 1000 + 1);
   const saved = await post(`/bookings/${booking.id}/passengers`, { passengers: [{ ...person(), fullName: 'Updated after expiry' }] });
   assert.equal(saved.statusCode, 200, saved.body);
   assert.equal(saved.json().holdExpired, true);
   assert.equal(saved.json().booking.passengers[0].fullName, 'Updated after expiry');
   assert.equal((await hold([seatIds[0]], 1)).statusCode, 200);
   assert.equal((await post(`/bookings/${booking.id}/seats`, { seatIds: [seatIds[0]] })).statusCode, 409);
   const recovered = await post(`/bookings/${booking.id}/seats`, { seatIds: [seatIds[1]] });
   assert.equal(recovered.statusCode, 200, recovered.body);
   assert.equal(recovered.json().booking.status, 'SEAT_HELD');
   assert.equal(recovered.json().booking.passengers[0].fullName, 'Updated after expiry');
  });
  await t.test('pending payment is never released by hold expiry and cannot mutate seats/details', async () => {
   await clear();
   const booking = (await hold([seatIds[0]])).json().booking;
   await db.booking.update({ where: { id: booking.id }, data: { status: 'PAYMENT_PENDING' } });
   await db.sailingSeat.update({ where: { sailingId_seatId: { sailingId, seatId: seatIds[0] } }, data: { state: 'PENDING_PAYMENT' } });
   now = new Date(+initialNow + (config.SEAT_HOLD_TTL_SECONDS + 1) * 1000);
   await sweepBookings(ctx, userIds[0]);
   assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'PAYMENT_PENDING');
   assert.equal(await db.seatHold.count({ where: { bookingId: booking.id, releasedAt: null } }), 1);
   for (const [action, body] of [['release', {}], ['extend', {}], ['seats', { seatIds: [seatIds[1]] }], ['passengers', { passengers: [person()] }]] as const) {
    assert.equal((await post(`/bookings/${booking.id}/${action}`, body)).statusCode, 409, action);
   }
  });
  await t.test('expired counter slips finalize the pending attempt as failed', async () => {
   await clear();
   const booking = (await hold([seatIds[0]])).json().booking;
   await db.booking.update({ where: { id: booking.id }, data: { status: 'COUNTER_PENDING', counterDeadline: new Date(+now - 1) } });
   const attempt = await db.paymentAttempt.create({ data: { bookingId: booking.id, reference: `PAY-${booking.reference.replace('-', '')}-01`, attemptNumber: 1, idempotencyKey: randomUUID(), method: 'COUNTER', amountCentavos: 48000 } });
   await sweepBookings(ctx, userIds[0]);
   assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'EXPIRED_UNPAID');
   const finished = await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
   assert.equal(finished.status, 'FAILED');
   assert.ok(finished.finalizedAt);
  });
  await t.test('a settled-money exception cannot reacquire seats or mutate passenger details', async () => {
   await clear();
   const booking = (await hold([seatIds[0]])).json().booking;
   const attempt = await db.paymentAttempt.create({ data: { bookingId: booking.id, reference: `PAY-${booking.reference.replace('-', '')}-01`, attemptNumber: 1, idempotencyKey: randomUUID(), method: 'GCASH', status: 'SUCCEEDED', amountCentavos: 48000 } });
   await db.payment.create({ data: { bookingId: booking.id, attemptId: attempt.id, method: 'GCASH', amountCentavos: 48000 } });
   await db.booking.update({ where: { id: booking.id }, data: { status: 'HOLD_EXPIRED' } });
   for (const [action, body] of [['release', {}], ['extend', {}], ['seats', { seatIds: [seatIds[1]] }], ['passengers', { passengers: [person()] }]] as const) assert.equal((await post(`/bookings/${booking.id}/${action}`, body)).statusCode, 409, action);
  });
  await t.test('user and IP hold caps apply while release frees capacity', async () => {
   await clear();
   assert.equal((await hold([seatIds[0]])).statusCode, 200);
   const second = await hold([seatIds[1]]);
   assert.equal(second.statusCode, 200);
   assert.equal((await hold([seatIds[2]])).statusCode, 429);
   assert.equal((await post(`/bookings/${second.json().booking.id}/release`, {})).statusCode, 200);
   assert.equal((await hold([seatIds[2]])).statusCode, 200);
   await clear();
   for (let i = 0; i < config.MAX_ACTIVE_HOLDS_PER_IP; i++) assert.equal((await hold([seatIds[i]], i)).statusCode, 200);
   assert.equal((await hold([seatIds[config.MAX_ACTIVE_HOLDS_PER_IP]], config.MAX_ACTIVE_HOLDS_PER_IP)).statusCode, 429);
  });
  await t.test('bookings are owner-only and unverified users cannot hold seats', async () => {
   await clear();
   const booking = (await hold([seatIds[0]])).json().booking;
   assert.equal((await app.inject({ url: `/bookings/${booking.id}`, headers: { cookie: `test_user=${userIds[1]}` } })).statusCode, 404);
   assert.equal((await app.inject({ url: '/bookings', headers: { cookie: `test_user=${userIds[1]}` } })).json().bookings.length, 0);
   assert.equal((await hold([seatIds[1]], 5)).statusCode, 403);
  });
  await t.test('validation rejects duplicate seats, mixed classes, missing passengers and excess party size', async () => {
   await clear();
   assert.equal((await hold([seatIds[0], seatIds[0]])).statusCode, 400);
   assert.equal((await hold([seatIds[0], economySeat])).statusCode, 400);
   assert.equal((await post('/bookings', { sailingId, seatIds: [seatIds[0]], passengers: [] })).statusCode, 400);
   assert.equal((await post('/bookings', { sailingId, seatIds, passengers: Array.from({ length: 11 }, () => person()) })).statusCode, 400);
  });
  await t.test('seat snapshots contain layout and monotonically increasing versions without private passenger data', async () => {
   await clear();
   const before = await app.inject(`/sailings/${sailingId}/seats`);
   assert.equal(before.statusCode, 200);
   assert.equal(before.json().seats.length, 11);
   assert.equal(before.json().seats.find((s: { id: string }) => s.id === seatIds[0]).version, 0);
   const booking = (await hold([seatIds[0]])).json().booking;
   await post(`/bookings/${booking.id}/release`, {});
   const after = (await app.inject(`/sailings/${sailingId}/seats`)).json();
   assert.equal(after.seats.find((s: { id: string }) => s.id === seatIds[0]).version, 2);
   assert.ok(!JSON.stringify(after).includes('Passenger Test'));
  });
 } finally {
  await clear();
  await db.fare.deleteMany({ where: { sailingId } });
  await db.sailingSeat.deleteMany({ where: { sailingId } });
  await db.sailing.deleteMany({ where: { id: sailingId } });
  await db.seat.deleteMany({ where: { layoutId: { in: [layoutId, economyId] } } });
  await db.vesselSeatLayout.deleteMany({ where: { id: { in: [layoutId, economyId] } } });
  await db.vessel.deleteMany({ where: { id: vesselId } });
  await db.route.deleteMany({ where: { id: routeId } });
  await db.port.deleteMany({ where: { id: { in: [originId, destinationId] } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();await db.$disconnect();await redis.quit();
 }
});

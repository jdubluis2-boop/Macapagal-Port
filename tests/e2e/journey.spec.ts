import { test, expect, type Page, type Download } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('Journey browser tests require TEST_DATABASE_URL pointing to the same isolated *_test database as the running API');
}
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const origin = 'http://localhost:3000';
const key = `browser-journey-${randomUUID()}`;
const password = `Journey-${randomUUID()}-1`;
const ids = { origin: `${key}-origin`, destination: `${key}-destination`, route: `${key}-route`, vessel: `${key}-vessel`, layout: `${key}-layout` };
const sailingIds = [randomUUID(), randomUUID()];
const userIds: string[] = [], bookingIds: string[] = [], webhookIds: string[] = [];
const users = {
  online: { id: randomUUID(), email: `${key}-online@example.test`, role: 'PASSENGER' },
  counterPassenger: { id: randomUUID(), email: `${key}-counter-passenger@example.test`, role: 'PASSENGER' },
  counter: { id: randomUUID(), email: `${key}-counter@example.test`, role: 'COUNTER_STAFF' },
  gate: { id: randomUUID(), email: `${key}-gate@example.test`, role: 'GATE_STAFF' },
  admin: { id: randomUUID(), email: `${key}-admin@example.test`, role: 'PORT_ADMIN' },
} as const;
const passenger = (name: string) => ({ fullName: name, mobile: '+639123456789', category: 'REGULAR_ADULT', age: 30, gender: 'FEMALE', emergencyContactName: 'Jose Journey', emergencyContactMobile: '+639987654321' });

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByText('Email verified. Your account is ready for booking.', { exact: true })).toBeVisible();
}

async function expectPdf(download: Download) {
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect((await readFile(path!)).subarray(0, 4).toString()).toBe('%PDF');
}

test.describe('complete passenger and port journeys with actual payments and workers', () => {
  test.beforeAll(async () => {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    for (const [name, user] of Object.entries(users)) {
      await db.user.create({ data: { ...user, fullName: `Journey ${name}`, mobile: '+639123456789', passwordHash, verifiedAt: new Date(), consentAt: new Date() } });
      userIds.push(user.id);
    }
    await db.port.createMany({ data: [{ id: ids.origin, name: 'Journey Macapagal Terminal' }, { id: ids.destination, name: 'Journey Island Terminal' }] });
    await db.route.create({ data: { id: ids.route, originId: ids.origin, destinationId: ids.destination, durationMinutes: 90 } });
    await db.vessel.create({ data: { id: ids.vessel, name: 'Journey Verification Ferry', operator: 'Journey Browser Operator' } });
    await db.vesselSeatLayout.create({ data: { id: ids.layout, vesselId: ids.vessel, className: 'Business', deck: 1 } });
    await db.seat.createMany({ data: [1, 2, 3].map(n => ({ id: `${ids.layout}-${n}`, layoutId: ids.layout, label: `J-${n}`, row: 1, column: n })) });
    for (const [index, id] of sailingIds.entries()) {
      const departure = new Date(Date.now() + (72 + index * 24) * 3600000);
      await db.sailing.create({ data: { id, routeId: ids.route, vesselId: ids.vessel, departure, arrival: new Date(+departure + 90 * 60000), published: true, gate: 'Gate 04', terminal: 'Terminal 1' } });
      await db.sailingSeat.createMany({ data: [1, 2, 3].map(n => ({ sailingId: id, seatId: `${ids.layout}-${n}` })) });
      await db.fare.create({ data: { sailingId: id, className: 'Business', category: 'REGULAR_ADULT', baseCentavos: 45000, terminalFeeCentavos: 3000 } });
    }
    expect(await db.refundPolicy.findUnique({ where: { id: 'voluntary-early' } }), 'Run the database seed before journey tests').toBeTruthy();
  });

  test.afterAll(async () => {
    // Every deletion is restricted to records created by this suite, including worker audits.
    const bookings = await db.booking.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const ownedBookingIds = [...new Set([...bookingIds, ...bookings.map(row => row.id)])];
    const [attempts, tickets, refunds] = await Promise.all([
      db.paymentAttempt.findMany({ where: { bookingId: { in: ownedBookingIds } }, select: { id: true } }),
      db.ticket.findMany({ where: { bookingId: { in: ownedBookingIds } }, select: { id: true } }),
      db.refund.findMany({ where: { bookingId: { in: ownedBookingIds } }, select: { id: true } }),
    ]);
    const entityIds = [...userIds, ...sailingIds, ...ownedBookingIds, ...attempts.map(row => row.id), ...tickets.map(row => row.id), ...refunds.map(row => row.id)];
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { entityId: { in: entityIds } }] } });
    await db.notification.deleteMany({ where: { userId: { in: userIds } } });
    await db.webhookEvent.deleteMany({ where: { id: { in: webhookIds } } });
    await db.boardingScan.deleteMany({ where: { ticketId: { in: tickets.map(row => row.id) } } });
    await db.refund.deleteMany({ where: { bookingId: { in: ownedBookingIds } } });
    await db.ticket.deleteMany({ where: { bookingId: { in: ownedBookingIds } } });
    await db.payment.deleteMany({ where: { bookingId: { in: ownedBookingIds } } });
    await db.paymentAttempt.deleteMany({ where: { bookingId: { in: ownedBookingIds } } });
    await db.seatHold.deleteMany({ where: { bookingId: { in: ownedBookingIds } } });
    await db.bookingPassenger.deleteMany({ where: { bookingId: { in: ownedBookingIds } } });
    await db.booking.deleteMany({ where: { id: { in: ownedBookingIds } } });
    await db.fare.deleteMany({ where: { sailingId: { in: sailingIds } } });
    await db.sailingSeat.deleteMany({ where: { sailingId: { in: sailingIds } } });
    await db.sailing.deleteMany({ where: { id: { in: sailingIds } } });
    await db.seat.deleteMany({ where: { layoutId: ids.layout } });
    await db.vesselSeatLayout.deleteMany({ where: { id: ids.layout } });
    await db.vessel.deleteMany({ where: { id: ids.vessel } });
    await db.route.deleteMany({ where: { id: ids.route } });
    await db.port.deleteMany({ where: { id: { in: [ids.origin, ids.destination] } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  });

  test('passenger books seats, pays online, downloads a signed ticket and completes a booking-wide refund', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await signIn(page, users.online.email);
    await page.goto(`/book?sailingId=${sailingIds[0]}&passengers=2&className=Business`);
    await expect(page.getByRole('heading', { name: 'Choose your seats', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Seat J-1, available', exact: true }).click();
    await page.getByRole('button', { name: 'Seat J-2, available', exact: true }).click();
    for (const [index, name] of ['Maria Journey', 'Ana Journey'].entries()) {
      await page.getByLabel('Full name as on ID', { exact: true }).nth(index).fill(name);
      await page.getByLabel('Mobile for e-ticket SMS', { exact: true }).nth(index).fill('+639123456789');
      await page.getByLabel('Age', { exact: true }).nth(index).fill('30');
      await page.getByLabel('Emergency contact name', { exact: true }).nth(index).fill('Jose Journey');
      await page.getByLabel('Emergency contact mobile', { exact: true }).nth(index).fill('+639987654321');
    }
    const createResponse = page.waitForResponse(response => response.url() === `${api}/bookings` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Confirm seats & passenger details', exact: true }).click();
    const created = await createResponse;
    expect(created.ok()).toBe(true);
    const booking = (await created.json()).booking;
    bookingIds.push(booking.id);
    await expect(page).toHaveURL(new RegExp(`/bookings/${booking.id}$`));
    await expect(page.getByText(/Seat hold: (09|10):/)).toBeVisible();
    expect(booking.totalCentavos).toBe(96000);
    expect(booking.terminalFeeCentavos).toBe(6000);
    expect(await db.sailingSeat.count({ where: { sailingId: sailingIds[0], state: 'HELD' } })).toBe(2);
    await page.getByLabel('GCash', { exact: true }).check();
    await page.getByRole('button', { name: /^Pay P960\.00$/, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Payment processing', exact: true })).toBeVisible();
    await expect(page.getByText('Payment is locked. Do not pay twice.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Simulate successful payment', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Payment confirmed', exact: true })).toBeVisible();
    const payment = await db.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
    // The signed simulator event and payment share the exact server timestamp.
    // Only capture an unambiguous event; never delete another suite's events.
    const events = await db.webhookEvent.findMany({ where: { provider: 'mock', receivedAt: payment.paidAt }, select: { id: true } });
    if (events.length === 1) webhookIds.push(events[0].id);
    expect(payment.method).toBe('GCASH');
    const tickets = await db.ticket.findMany({ where: { bookingId: booking.id }, orderBy: { seatLabel: 'asc' } });
    expect(tickets.map(ticket => ticket.seatLabel)).toEqual(['J-1', 'J-2']);
    const invoice = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download invoice', exact: true }).click();
    await expectPdf(await invoice);
    await page.getByRole('link', { name: 'View active e-tickets', exact: true }).click();
    await expect(page.getByRole('link', { name: 'View boarding pass', exact: true })).toHaveCount(2);
    await page.getByRole('link', { name: 'View boarding pass', exact: true }).first().click();
    await expect(page).toHaveURL(/\/tickets\/[a-f\d-]+$/);
    const ticketId = page.url().split('/').pop()!;
    await page.getByRole('button', { name: 'View boarding pass QR', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('img', { name: 'Signed boarding-pass QR code', exact: true })).toBeVisible();
    await page.screenshot({ path: '/tmp/macapagal-journey.png', fullPage: true });
    await page.getByRole('button', { name: 'Close boarding pass', exact: true }).click();
    const ticketPdf = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download ticket PDF', exact: true }).click();
    await expectPdf(await ticketPdf);
    await page.getByRole('link', { name: 'Request refund', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'This booking is eligible for a refund estimate.' })).toBeVisible();
    await expect(page.getByText('P864.00', { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: 'I understand that every ticket in this booking will be cancelled.', exact: true }).check();
    await page.getByRole('button', { name: 'Confirm refund for entire booking', exact: true }).click();
    await expect(page).toHaveURL(/\/refunds\/[a-f\d-]+$/);
    const refundId = page.url().split('/').pop()!;
    await expect.poll(async () => (await db.refund.findUnique({ where: { id: refundId } }))?.status, { timeout: 20000 }).toBe('COMPLETED');
    await expect(page.getByRole('heading', { name: 'Refund completed', exact: true })).toBeVisible({ timeout: 15000 });
    const refund = await db.refund.findUniqueOrThrow({ where: { id: refundId } });
    expect(refund.amountCentavos).toBe(86400);
    expect(refund.processingAt).toBeTruthy();
    expect(refund.completedAt).toBeTruthy();
    expect(await db.ticket.count({ where: { bookingId: booking.id, status: 'REFUNDED' } })).toBe(2);
    expect(await db.sailingSeat.count({ where: { sailingId: sailingIds[0], state: 'AVAILABLE' } })).toBe(3);
    expect(await db.seatHold.count({ where: { bookingId: booking.id, releasedAt: null } })).toBe(0);
    await page.goto(`/tickets/${ticketId}`);
    await expect(page.getByRole('status').filter({ hasText: 'REFUNDED, invalid for boarding.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'View boarding pass QR', exact: true })).toBeDisabled();
    const invalidTicket = await page.request.get(`${api}/tickets/${ticketId}`);
    expect((await invalidTicket.json()).ticket.qrToken).toBeNull();
    await page.goto('/tickets');
    await expect(page.getByRole('heading', { name: '0 active e-tickets', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Ticket history', exact: true }).click();
    await expect(page.getByText('REFUNDED, invalid for boarding', { exact: true })).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test('counter payment requires an ID check and concurrent boarding scans accept a ticket exactly once', async ({ page, browser }) => {
    const contexts = await Promise.all([browser.newContext({ baseURL: origin }), browser.newContext({ baseURL: origin }), browser.newContext({ baseURL: origin })]);
    const [counterPage, adminPage, gatePage] = await Promise.all(contexts.map(context => context.newPage()));
    try {
      await signIn(page, users.counterPassenger.email);
      const response = await page.request.post(`${api}/bookings`, { headers: { Origin: origin }, data: { sailingId: sailingIds[1], seatIds: [`${ids.layout}-1`], passengers: [passenger('Lina Counter Journey')] } });
      expect(response.ok(), await response.text()).toBe(true);
      const booking = (await response.json()).booking;
      bookingIds.push(booking.id);
      await page.goto(`/bookings/${booking.id}`);
      await page.getByLabel('Pay at the terminal counter', { exact: true }).check();
      await page.getByRole('button', { name: 'Generate counter payment slip', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Pay at the ticketing counter', exact: true })).toBeVisible();
      await expect(page.getByText('This is not a boarding pass.', { exact: true })).toBeVisible();
      expect(await db.ticket.count({ where: { bookingId: booking.id } })).toBe(0);
      const slip = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download payment slip', exact: true }).click();
      await expectPdf(await slip);
      await signIn(counterPage, users.counter.email);
      await counterPage.goto('/staff');
      await counterPage.getByRole('button', { name: 'Counter payments', exact: true }).click();
      await counterPage.getByLabel('Booking reference', { exact: true }).fill(booking.reference);
      await counterPage.getByRole('button', { name: 'Find booking', exact: true }).click();
      await expect(counterPage.getByRole('button', { name: 'Record counter payment', exact: true })).toBeVisible();
      const unchecked = await counterPage.request.post(`${api}/staff/bookings/${booking.id}/counter-payment`, { headers: { Origin: origin }, data: { idChecked: false } });
      expect(unchecked.status()).toBe(400);
      expect(await db.ticket.count({ where: { bookingId: booking.id } })).toBe(0);
      await counterPage.getByRole('checkbox', { name: /I checked the passenger's ID and collected/ }).check();
      await counterPage.getByRole('button', { name: 'Record counter payment', exact: true }).click();
      await expect(counterPage.getByRole('status').filter({ hasText: 'Counter payment recorded.' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Payment confirmed', exact: true })).toBeVisible();
      const ticket = await db.ticket.findFirstOrThrow({ where: { bookingId: booking.id } });
      const ticketResponse = await page.request.get(`${api}/tickets/${ticket.id}`);
      const token = (await ticketResponse.json()).ticket.qrToken;
      expect(token).toBeTruthy();
      await signIn(adminPage, users.admin.email);
      const boarding = await adminPage.request.post(`${api}/staff/sailings/${sailingIds[1]}/status`, { headers: { Origin: origin }, data: { status: 'BOARDING' } });
      expect(boarding.ok(), await boarding.text()).toBe(true);
      await signIn(gatePage, users.gate.email);
      await gatePage.goto('/staff');
      await gatePage.getByRole('button', { name: 'Boarding scanner', exact: true }).click();
      await gatePage.getByLabel('Boarding QR token', { exact: true }).fill(token);
      const uiScan = gatePage.waitForResponse(value => value.url() === `${api}/staff/boarding/scan` && value.request().method() === 'POST');
      const [, duplicate] = await Promise.all([
        gatePage.getByRole('button', { name: 'Validate and board passenger', exact: true }).click(),
        gatePage.request.post(`${api}/staff/boarding/scan`, { headers: { Origin: origin }, data: { token, gate: 'Gate 04' } }),
      ]);
      expect([(await uiScan).status(), duplicate.status()].sort()).toEqual([200, 409]);
      expect(await db.boardingScan.count({ where: { ticketId: ticket.id } })).toBe(1);
      expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('BOARDED');
      await expect(gatePage.getByRole('button', { name: 'Validate and board passenger', exact: true })).toBeEnabled();
      await gatePage.getByRole('button', { name: 'Validate and board passenger', exact: true }).click();
      await expect(gatePage.getByRole('alert').filter({ hasText: 'Ticket already used' })).toBeVisible();
      const rejectedRefund = await page.request.post(`${api}/tickets/${ticket.id}/refund`, { headers: { Origin: origin }, data: { reason: 'VOLUNTARY' } });
      expect(rejectedRefund.status()).toBe(409);
      expect((await rejectedRefund.json()).message).toMatch(/boarded booking cannot be refunded/i);
      expect(await db.refund.count({ where: { bookingId: booking.id } })).toBe(0);
      await page.goto(`/tickets/${ticket.id}`);
      await expect(page.getByRole('status').filter({ hasText: 'Already boarded at Gate 04.' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'View boarding pass QR', exact: true })).toBeDisabled();
    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  });
});

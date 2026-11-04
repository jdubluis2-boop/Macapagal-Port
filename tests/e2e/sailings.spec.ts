import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('Sailing browser tests require TEST_DATABASE_URL pointing to the same isolated *_test database as the running API');
}
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const key = `browser-search-${randomUUID()}`;
const originId = `${key}-origin`, destinationId = `${key}-destination`, routeId = `${key}-route`, vesselId = `${key}-vessel`;
const businessId = `${key}-business`, economyId = `${key}-economy`;
const sailingIds = [randomUUID(), randomUUID()];
const localDate = (offset: number) => new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
const availableDate = localDate(3), soldOutDate = localDate(4), emptyDate = localDate(5);
const urlFor = (date: string, passengers = 1) => `/sailings?${new URLSearchParams({ origin: originId, destination: destinationId, date, passengers: String(passengers) })}`;

test.describe('sailing search with actual database inventory', () => {
  test.beforeAll(async () => {
    await db.port.createMany({ data: [{ id: originId, name: 'Browser Macapagal Port' }, { id: destinationId, name: 'Browser Dapa' }] });
    await db.route.create({ data: { id: routeId, originId, destinationId, durationMinutes: 90 } });
    await db.vessel.create({ data: { id: vesselId, name: 'Browser Search Ferry', operator: 'Browser Test Operator', registration: 'TEST-224' } });
    await db.vesselSeatLayout.createMany({ data: [{ id: businessId, vesselId, className: 'Business', deck: 1 }, { id: economyId, vesselId, className: 'Economy', deck: 2 }] });
    await db.seat.createMany({ data: [businessId, economyId].flatMap(layoutId => Array.from({ length: 5 }, (_, i) => ({ id: `${layoutId}-${i + 1}`, layoutId, label: `${layoutId === businessId ? 'B' : 'E'}-${i + 1}`, row: 1, column: i + 1 }))) });
    for (let i = 0; i < sailingIds.length; i++) {
      const departure = new Date(`${i ? soldOutDate : availableDate}T10:00:00+08:00`);
      await db.sailing.create({ data: { id: sailingIds[i], routeId, vesselId, published: true, departure, arrival: new Date(+departure + 90 * 60000), gate: 'Gate 04', terminal: 'Terminal 1' } });
      await db.sailingSeat.createMany({ data: [businessId, economyId].flatMap(layoutId => Array.from({ length: 5 }, (_, n) => ({ sailingId: sailingIds[i], seatId: `${layoutId}-${n + 1}`, state: i ? 'SOLD' as const : 'AVAILABLE' as const }))) });
      await db.fare.createMany({ data: [{ sailingId: sailingIds[i], className: 'Business', category: 'REGULAR_ADULT', baseCentavos: 45000, terminalFeeCentavos: 3000 }, { sailingId: sailingIds[i], className: 'Economy', category: 'REGULAR_ADULT', baseCentavos: 35000, terminalFeeCentavos: 3000 }] });
    }
  });
  test.afterAll(async () => {
    await db.fare.deleteMany({ where: { sailingId: { in: sailingIds } } });
    await db.sailingSeat.deleteMany({ where: { sailingId: { in: sailingIds } } });
    await db.sailing.deleteMany({ where: { id: { in: sailingIds } } });
    await db.seat.deleteMany({ where: { layoutId: { in: [businessId, economyId] } } });
    await db.vesselSeatLayout.deleteMany({ where: { id: { in: [businessId, economyId] } } });
    await db.vessel.deleteMany({ where: { id: vesselId } });
    await db.route.deleteMany({ where: { id: routeId } });
    await db.port.deleteMany({ where: { id: { in: [originId, destinationId] } } });
    await db.$disconnect();
  });

  test('home search reaches responsive results with terminal-inclusive fare and selection summary', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByLabel('Origin terminal', { exact: true }).selectOption(originId);
    await page.getByLabel('Destination', { exact: true }).selectOption(destinationId);
    await page.getByLabel('Departure date', { exact: true }).fill(availableDate);
    await page.getByLabel('Passenger count', { exact: true }).selectOption('4');
    await page.getByRole('button', { name: /search trips/i }).click();
    await expect(page).toHaveURL(/\/sailings\?/);
    await expect(page.getByText('Browser Search Ferry', { exact: true })).toBeVisible();
    await expect(page.getByText(/P380\.00/).first()).toBeVisible();
    await expect(page.getByText(/terminal fee included/i).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: /^select/i }).first().click();
    await expect(page.getByText(/no seats reserved/i)).toBeVisible();
    await page.screenshot({ path: '/tmp/macapagal-sailings-mobile.png', fullPage: true });
  });

  test('sold-out sailing and no-sailing date have distinct messages', async ({ page }) => {
    await page.goto(urlFor(soldOutDate));
    await expect(page.getByText('Browser Search Ferry', { exact: true })).toBeVisible();
    await expect(page.getByText('Sold out', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^select/i }).first()).toBeDisabled();
    await page.getByRole('navigation', { name: 'Departure dates' }).getByRole('link').last().click();
    await expect(page).toHaveURL(new RegExp(emptyDate));
    await expect(page.getByRole('heading', { name: /no sailings found/i })).toBeVisible();
    await expect(page.getByText('Browser Search Ferry', { exact: true })).toHaveCount(0);
  });

  test('failed refresh disables stale selection and recovers from the real API', async ({ page }) => {
    await page.goto(urlFor(availableDate));
    const select = page.getByRole('button', { name: /^select/i }).first();
    await expect(select).toBeEnabled();
    await select.click();
    await expect(page.getByRole('heading', { name: 'Your selected crossing' })).toBeVisible();
    // Only the failure response is simulated; initial results and recovery use PostgreSQL.
    const pattern = '**/sailings/search?**';
    await page.route(pattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary schedule service outage' }) }));
    await page.getByRole('button', { name: 'Refresh availability', exact: true }).click();
    const refreshError = page.getByRole('alert').filter({ hasText: 'We couldn’t refresh the schedule.' });
    await expect(refreshError).toBeVisible();
    await expect(refreshError).toContainText('Temporary schedule service outage');
    await expect(page.getByText('Browser Search Ferry', { exact: true })).toBeVisible();
    for (const button of await page.getByRole('button', { name: /^select/i }).all()) await expect(button).toBeDisabled();
    await expect(page.getByRole('alert').filter({ hasText: 'Availability has changed or could not be refreshed.' })).toBeVisible();
    await page.unroute(pattern);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(refreshError).toHaveCount(0);
    await expect(select).toBeEnabled();
  });

  test('invalid date query shows API validation without a client crash', async ({ page }) => {
    const clientErrors: string[] = [];
    page.on('pageerror', error => clientErrors.push(error.message));
    const response = page.waitForResponse(value => value.url().includes('/sailings/search?'));
    await page.goto(urlFor('9999-12-31'));
    expect((await response).status()).toBe(400);
    await expect(page.getByRole('heading', { name: 'Sailing schedules', exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'We couldn’t refresh the schedule.' })).toContainText('date:');
    await expect(page.getByRole('navigation', { name: 'Departure dates' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^select/i })).toHaveCount(0);
    expect(clientErrors).toEqual([]);
  });

  test('party capacity and refreshed inventory prevent unavailable selection', async ({ page }) => {
    await page.goto(urlFor(availableDate, 10));
    await expect(page.getByText('Not enough seats', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^select/i }).first()).toBeDisabled();
    await page.goto(urlFor(availableDate));
    await expect(page.getByRole('button', { name: /^select/i }).first()).toBeEnabled();
    await db.sailingSeat.updateMany({ where: { sailingId: sailingIds[0] }, data: { state: 'SOLD', version: { increment: 1 } } });
    try {
      await page.getByRole('button', { name: /refresh/i }).click();
      await expect(page.getByText('Sold out', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: /^select/i }).first()).toBeDisabled();
    } finally {
      await db.sailingSeat.updateMany({ where: { sailingId: sailingIds[0] }, data: { state: 'AVAILABLE', version: { increment: 1 } } });
    }
  });
});

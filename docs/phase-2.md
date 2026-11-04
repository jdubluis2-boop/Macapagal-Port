# Phase 2: sailing search and results

The home search and `/sailings` results read routes, vessel information, class fares and inventory from PostgreSQL. Search is public; accounts remain required for future booking. Existing authentication behavior is preserved. No published environment settings or snapshots are changed by this phase.

## API

- `GET /routes`: stored route pairs and named ports, for search choices.
- `GET /routes/popular`: route cards, with an adult fare and vessel from the cheapest bookable sailing in the next 366 days. When no eligible offer exists, price, vessel and offer departure are null. This is a route showcase, not a claim of measured popularity.
- `GET /sailings/search?origin=surigao&destination=dapa&date=2026-11-04&passengers=1`: public date-based inventory snapshot. Dates are interpreted in **Asia/Manila**, with inclusive local midnight and exclusive next midnight; arrival may fall on the next day. Passenger count defaults to 1 and must be an integer 1–10. Dates must be real calendar dates in 2000–2099; unknown ports return 404, malformed queries return 400, and a valid unserved pair has no sailings.

Each result includes server time, cutoff minutes, vessel/operator, departure/arrival, elapsed duration, status, gate/terminal, AVAILABLE seat counts and class fares. Fare components and totals use integer PHP centavos. The per-person adult fare includes the terminal fee **once**. Discount category fares never become the unqualified adult “fare from.” The provisional group total is not a booked or discounted quote.

Search uses a repeatable-read database snapshot for consistency between fares and seat inventory. Only seats on the sailing's own vessel count. HELD, PENDING_PAYMENT, SOLD and BLOCKED seats are excluded. Inventory is fetched again on every request; Redis does not cache an authoritative count.

## Availability rules

`NO_SAILINGS` means there are no **published** sailings on the requested pair/date. An existing sailing with zero available seats is `SOLD_OUT`, never no-sailings. Closed sailings remain visible for schedule context and cannot be selected. Only SCHEDULED, BOARDING or DELAYED sailings departing strictly later than server time plus `BOOKING_CUTOFF_MINUTES` are eligible. CANCELLED, DEPARTED, ARRIVED, past and cutoff-closed sailings are disabled.

A party must fit in one class with an adult fare. Ten available seats split seven/three across classes cannot accommodate a ten-passenger selection. A class without a configured adult fare is not selectable, and no zero price is invented. The overall “fare from” uses the cheapest class that can accommodate the searched party; when no class is bookable, a known adult fare may still be displayed as schedule information. Counts of 12 or fewer trigger urgency styling.

The UI refreshes results periodically and allows a manual refresh. These are snapshots: a search or selection never reserves a seat. Socket.IO subscriptions, versioned deltas and atomic holds are Phase 3. Selecting a class in Phase 2 opens a review summary with the current fare and passenger count; it cannot create a booking or charge a payment.

## Data and development

The Phase 1 seed remains unchanged: nine **unpublished historical** October 18, 2026 sailings. Ordinary setup therefore shows genuine no-sailings states until published future sailing data exists. No sample voyage is silently turned into a live timetable. Automated tests create their own future fixtures in an isolated `_test` database, leaving the existing seed and user data intact.

Runtime startup and installation commands are unchanged; see the README. `npm run test:sailings -w apps/api` runs the focused search database tests with `TEST_DATABASE_URL` set as documented. `npm run test:integration -w apps/api` includes auth and search suites. Browser tests use the same isolated database as their running API. Build/test evidence is recorded after validation below.

Next: Phase 3 seat map, all-or-nothing inventory holds, realtime updates, expiry/reconnect handling and hold-abuse limits.

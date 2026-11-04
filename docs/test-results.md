# Validation results — November 4, 2026

Completed in the cloud development instance with Node.js 24, PostgreSQL 17, Redis 7, Mailpit and system Chromium.

| Check | Result |
| --- | --- |
| API TypeScript check and Next.js production build | Passed |
| Input/domain/encryption unit suite | 7 passed, 0 failed/skipped |
| PostgreSQL/Redis/SMTP/Socket.IO integration runner | 85 passed, 0 failed/skipped (includes parent tests) |
| Chromium browser suite | 10 passed, 0 failed/skipped |
| Frozen-lockfile installation from a clean extracted source archive | Passed |
| Prisma client generation and both builds in extracted archive | Passed |
| Original seed and optional future demo seed repeatability | Passed |
| Source archive integrity and secret/cache exclusion | Passed |

Integration coverage includes registration/verification/reset/lockout, auth and owner/role guards, Manila calendar boundaries, fares/terminal fees, capacity, simultaneous seat claims, all-or-nothing acquisition, exchanges/expiry/caps, Redis loss, idempotent payments and signed/replayed/out-of-order webhooks, pending freezes and late-money exceptions, actual websocket snapshots/privacy/reconnect/logout, QR/PDF issuance, simultaneous boarding, refund tiers/cancellation/settlement, extra-payment refunds preserving valid original tickets, rescheduling, staff CRUD/manifests/Palawan clearance and durable SMTP notification leases.

Browser coverage includes account verification, mobile search/class selection, sold-out and empty results, stale-refresh rejection/recovery, invalid dates, inventory changes, complete two-passenger online payment → signed mock settlement → QR and real PDF downloads → actual BullMQ-completed refund, counter payment → staff ID check → concurrent boarding/duplicate rejection/refund denial, staff access controls/dashboard/catalogue/counter/scanner and camera fallback. Test fixtures use a dedicated `_test` database and only their own records are removed.

Observed non-failing warning: Prisma's PostgreSQL adapter emits a pg 8 deprecation notice for queued queries in some transactional reads. Tests pass with the pinned lockfile; review the adapter before upgrading pg to a future major version.

Not exercised: real payment or SMS settlement, external Google/Facebook applications, physical camera capture/gate hardware, production load/security certification, production deployment, or restoration in a new published environment. The mock provider and Mailpit are development services; no real money moved. Source archive validation does not constitute a bank/provider or regulatory approval.

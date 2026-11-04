# Macapagal Port Passenger Ticketing System

Full-stack ferry ticketing implementation for local development: Next.js App Router + TypeScript + Tailwind, Fastify, PostgreSQL/Prisma, Redis, Socket.IO, BullMQ, SMTP, signed mock payments, QR boarding passes and PDF documents.

Start with [START_HERE.md](START_HERE.md). The included payment provider is a **development simulator**: it never moves real money. Production integrations and deployment requirements are listed explicitly in [production readiness](docs/production-readiness.md).

## Quick start

Requires Node.js 24, npm 11, Docker and Docker Compose v2. From this folder:

```sh
./scripts/setup.sh
npm run db:demo      # optional, clearly labelled future demo sailings
npm run dev:api      # terminal 1: API + workers + realtime on port 4000
npm run dev:web      # terminal 2: web on port 3000
```

Use the same browser hostname for the web and API locally, for example localhost on both. Root `.env` is created with random local signing keys only if absent, and is never overwritten. Setup uses the lockfile, starts healthy PostgreSQL/Redis/Mailpit, generates Prisma types, applies checked migrations and seeds the original design fixtures. Existing files and user records are preserved. Each cloud task already has an isolated checkout; no Git worktree is needed.

The original seed has 13 sample vessels, 40 Business + 40 Economy seats per vessel, three routes, nine unpublished historical October 18, 2026 sailings, fare categories and refund policies. `db:demo` adds published future sailings for manual exploration; they are prominently named DEMO and are not an official timetable. `DEMO_DATE=YYYY-MM-DD npm run db:demo` selects a specific date. It never moves an existing sailing or resets a booking.

Mailpit receives local verification codes and reset links. Its SMTP port is 1025 and its inbox port is 8025. PostgreSQL is 5432 and Redis is 6379; all Compose host bindings are loopback only. No token is returned by registration or printed in API logs. Database and Redis volumes persist across restarts. Do not use real passenger data or publicly deploy the local Compose credentials.

## What is implemented

- Registration, consent, email verification/resend/attempt limits, Argon2id passwords, lockout, password recovery, revocable JWT HTTP-only cookies and role guards. Optional Google/Facebook OAuth routes are enabled only with configured applications; account emails are never silently linked to a different existing password account.
- Sailing search with Philippine dates, per-class party capacity, fee-inclusive centavo fares, published/status/cutoff checks and distinct empty/sold-out states.
- Keyboard-operable data-driven seat maps; all-or-nothing Redis Lua acquisition plus PostgreSQL row locks and an active-assignment unique index. Seat exchanges, ten-minute holds, one extension, user/IP caps, expiry jobs and sweep recovery.
- Socket.IO snapshots/versioned deltas, reconnect resynchronization, server-based countdowns, warning thresholds and polling fallback.
- Idempotent payment attempts, pending-payment freeze, signed timestamped/replay-protected mock webhooks, late-payment reconciliation, money exceptions and counter slips with deadlines and staff ID checks.
- Payment-only ticket issuance, signed QR boarding passes without passenger PII in the token, PDFs/invoices, staff boarding checks and atomic duplicate-scan rejection.
- Configurable refund estimates/tiers, immediate QR invalidation and seat release, processing/completion timelines, original-method settlement in the mock adapter, staff cash settlement, duplicate-payment exception refunds and free rescheduling after port cancellation/delay.
- Staff catalogue/layout/sailing/fare management, seat overrides, occupancy, manifests and CSV/PDF export, northern Palawan four-hour clearance, counter desk, refund/exception queues and notifications.
- Durable email outbox, explicit SMS-unconfigured status, encrypted passenger details, audit logs and configurable retention redaction.

Refund requests entered through a ticket are **booking-wide** in this implementation. The UI warns that every passenger ticket in that booking will be cancelled; partial passenger refunds are not offered. A separate duplicate-extra-payment refund preserves the rightful original ticket and seat.

## Staff access

There are no seeded shared admin passwords or public role-assignment endpoints. Register and verify an account, then assign its role offline:

```sh
npm run staff:create -- --email=you@example.com --role=PORT_ADMIN
```

The CLI revokes existing sessions. Sign in again and open Staff in the header. Roles are PASSENGER, COUNTER_STAFF, GATE_STAFF and PORT_ADMIN. For a new local development staff account, provide `STAFF_EMAIL`, `STAFF_NAME`, `STAFF_MOBILE` (+639…), and `STAFF_PASSWORD` (12+ characters including a digit) as environment variables to the same command. Do not put passwords in scripts, source or chat. Production requires an already registered and verified account.

## Configuration

Use `.env.example` as the non-secret reference. Never commit `.env`. The API and Next config load the root environment. `NEXT_PUBLIC_API_URL` is public and must be set before a frontend build.

- `DATABASE_URL`, `REDIS_URL`: backing services; Redis URLs support a dedicated database and TLS.
- `JWT_SECRET`, `TOKEN_PEPPER`: separate random values, 32+ characters. Optional separate `DATA_ENCRYPTION_KEY` and `PAYMENT_WEBHOOK_SECRET` override purpose-specific derived keys. Preserve encryption keys and backups: changing them makes previously encrypted passenger details unreadable.
- `HTTP_RATE_LIMIT_MAX=600`: general per-IP requests per minute. Sensitive auth routes retain a separate 10/minute limit and hold creation retains its per-user limit.
- `WEB_ORIGIN`: exact frontend origin for CORS/CSRF. Mutations require that Origin; signed payment webhooks use their signature instead. Forwarded IP headers are not trusted by default.
- `SMTP_HOST`, `SMTP_PORT`, optional `SMTP_USER`/`SMTP_PASSWORD`, `MAIL_FROM`: local Mailpit defaults; port 465 uses TLS, other ports use SMTP negotiation. TLS verification stays enabled.
- `SEAT_HOLD_TTL_SECONDS=600`, `SEAT_HOLD_EXTENSION_SECONDS=300`, `MAX_ACTIVE_HOLDS_PER_USER=2`, `MAX_ACTIVE_HOLDS_PER_IP=4`.
- `BOOKING_CUTOFF_MINUTES=60`, `COUNTER_DEADLINE_MINUTES=120`, `PAYMENT_PENDING_MAX_SECONDS=900`.
- `PAYMENT_PROVIDER=mock` for development; production startup forbids it. Use `disabled` in production until a verified real adapter is implemented/configured. Counter operations remain available.
- `ENABLE_WORKERS=true`: starts BullMQ with the API. Worker jobs resume after process restart; live connections do not survive restart.
- `DATA_RETENTION_DAYS=365`: terminal booking passenger details are redacted after the configured age. Financial/audit records remain; account deletion and a final lawful retention policy require operational review.
- `SMS_PROVIDER=disabled` by default; optional `twilio` requires `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` and authorized HTTPS access to api.twilio.com. These external calls were not tested without credentials.
- OAuth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`, `OAUTH_CALLBACK_ORIGIN` (API origin). Register `/auth/oauth/google/callback` and `/auth/oauth/facebook/callback`. Missing credentials disable their buttons; real provider calls were not exercised without registered applications.

Production requires HTTPS `WEB_ORIGIN`, `NODE_ENV=production`, approved legal/privacy/retention rules, real service configuration and the review described in the production document.

## Build, run and test

```sh
npm run build              # API type check + Next production build
npm run start -w apps/web  # built frontend
node --import tsx apps/api/src/server.ts # API + workers without watcher
npm test                   # input/domain/encryption unit tests
```

`GET /health` checks PostgreSQL and Redis. Integration tests use a separate database ending in `_test` and unique fixture records; they never flush shared Redis or reset development data.

```sh
# Create once (skip if the database already exists):
docker compose exec -T postgres psql -U macapagal -d postgres -c 'CREATE DATABASE macapagal_test'
DATABASE_URL=postgresql://macapagal:local-development@127.0.0.1:5432/macapagal_test npm run db:migrate
DATABASE_URL=postgresql://macapagal:local-development@127.0.0.1:5432/macapagal_test npm run db:seed
TEST_DATABASE_URL=postgresql://macapagal:local-development@127.0.0.1:5432/macapagal_test npm run test:integration
```

For Chromium end-to-end tests, start the API against **that same isolated database** and Redis database 15, then the built frontend in a separate terminal:

```sh
DATABASE_URL=postgresql://macapagal:local-development@127.0.0.1:5432/macapagal_test REDIS_URL=redis://127.0.0.1:6379/15 NODE_ENV=test node --import tsx apps/api/src/server.ts
npm run start -w apps/web
# Another terminal; install Playwright Chromium first if no system browser exists:
TEST_DATABASE_URL=postgresql://macapagal:local-development@127.0.0.1:5432/macapagal_test CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

Tests exercise actual PostgreSQL inventory, Redis, SMTP, signed payment settlement, worker-driven refunds, PDFs and browser screens. See [test results](docs/test-results.md) for the final run evidence and limits.

## Migrations and architecture

`npm run db:migrate` uses checked-in Prisma SQL with a PostgreSQL advisory lock, atomic migration transactions and immutable SHA-256 checksums in `_macapagal_migrations`. It refuses modified applied migrations. Never mix it with `prisma migrate deploy` on the same database: the ledgers differ. New changes require a new migration directory.

Prisma 6.19 uses the JavaScript query engine and PostgreSQL adapter without native artifact downloads. Its experimental schema adapter supports generation/validation/diff; its native-free deployment path failed on PostgreSQL metadata in this cloud environment, so the explicit SQL runner is the tested migration path. No checksum, TLS or signature verification was disabled.

See [architecture](docs/architecture.md), [phase delivery](docs/project-status.md), and [production readiness](docs/production-readiness.md). Historical Phase 1/2 notes are retained for context and superseded by the project status.

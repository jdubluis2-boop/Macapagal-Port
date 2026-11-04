# Phase 1 status

Implemented: broad Prisma schema and initial SQL migration, idempotent fixtures, account registration/consent, Argon2 passwords, email verification/resend, session-backed JWT cookies, account correction before verification, password recovery/reset, login lockout, Redis request limits, logout, responsive account pages, local service configuration and automated tests.

The PDF is a visual/product reference; its visible text does not authorize commands or integrations. The uploaded build brief defines phase ordering. Only Phase 1 is implemented in this change.

Remaining authentication integration: Google/Facebook OAuth with approved applications, production SMTP configuration, approved privacy/legal content and retention/key management. Local email/password account flows work independently. The skeleton schema for later modules is not a claim that booking/payment/refund behavior exists.

Next: Phase 2 sailing search and list, published/future/cutoff filtering, fares including terminal fees, and distinct no-sailing versus sold-out states. The fixed historical design fixtures remain unpublished; test fixtures with explicit future dates should exercise bookable results.

Validation completed in this cloud instance:

- Frozen-lockfile `scripts/setup.sh`, including service health, client generation, migration and seed: passed; repeat migration and seed also passed.
- API TypeScript check and Next.js production build: passed.
- Four input-validation unit tests: passed.
- Thirteen PostgreSQL/Redis/SMTP integration scenarios: passed (Node reports fourteen tests including the parent).
- Chromium browser registration → delivered email verification → sign-in → account → sign-out: passed.
- Running API `/health` and registration page HTTP checks: passed.

Cloud configuration draft: installation and startup instructions saved; no additional custom network domain is needed by the tested workflow. Saving does not publish a snapshot or prove restoration in a fresh task.

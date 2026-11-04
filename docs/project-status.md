# Delivery across all eight phases

1. Schema/seed/auth/verification: implemented, including optional credential-gated social sign-in routes.
2. Search/list: implemented with Manila dates, fee-inclusive fares, class-aware capacity, cutoff and empty/sold-out states.
3. Seats/holds/realtime/expiry: implemented with Lua + authoritative DB locks/constraints, swaps, caps, countdowns, extension, jobs, sweeper and reconnect behavior.
4. Payments/webhooks/reconciliation/counter: implemented with a signed development mock adapter, pending freeze, sequential attempts, idempotency, late-money exceptions, counter deadlines and receipts.
5. Tickets/QR/boarding: implemented with payment-only issuance, signed/versioned tokens, PDFs, role checks and atomic repeated-scan protection.
6. Refunds/tracking: implemented with policy tiers, booking-wide cancellation, immediate token invalidation/seat release, mock original-method settlement, staff cash refund and free port-disruption rescheduling.
7. Staff/notifications: implemented with catalogue/sailing/fare/seat management, manifests/exports/clearance, counter/refund/exception queues, occupancy, notification inbox and durable email outbox.
8. Hardening/tests/docs/package: implemented with encryption, validation, audit, origin/role checks, retention, automated tests and the downloadable source package.

The default runnable mode uses mock payments and local SMTP. Real banking, SMS, OAuth applications, official timetable/legal policies and production operations require the prerequisites in production-readiness.md. The download excludes all secrets and runtime data.

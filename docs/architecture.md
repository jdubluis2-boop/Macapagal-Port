# Architecture and recovery

Next.js serves passenger and staff pages; Fastify owns authentication, authorization, inventory, prices and all business mutations. PostgreSQL is the source of truth. Redis supplies short-lived locks, abuse limits, Socket.IO support and BullMQ transport. The API process starts workers unless explicitly disabled. PostgreSQL notification records and periodic sweeps recover work that was committed while Redis was unavailable.

## Seat ownership

The inventory row is `(sailingId, seatId)` with state and monotonically increasing version. A partial unique index on unreleased SeatHold assignments prevents duplicate authoritative ownership even if Redis is lost. Seat acquisition locks the user/IP cap, sailing and ordered inventory rows, acquires every Redis key through one Lua call, then writes the booking/assignments transactionally. Any failure rolls back all DB writes and removes only the newly acquired Redis keys belonging to that booking. Seat exchange releases old and acquires new assignments in one transaction; old Redis keys are removed after commit. Sold assignments stay unreleased until refund/cancellation.

All cross-module writes use sailing → booking → ordered seat locks. PostgreSQL row locks and constraints decide the winner. Redis never makes a sold seat available by itself. A delayed hold job, key-expiry acceleration and thirty-second database sweep release expired holds. Pending payments are excluded from ordinary expiry and are reconciled by their own bounded provider timeout. A failed payment restores only the original unexpired hold, so clicking Pay cannot extend ownership indefinitely.

## Realtime and clock behavior

Socket.IO joins authenticated users only to their own server-assigned user room. Public observers may subscribe to published sailing or route rooms; arbitrary personal-room requests are ignored. Origin checks, bounded message sizes and subscription limits restrict access. Logout/reset revokes database sessions and disconnects their sockets. Every connection sends server time and every sailing subscription emits a full inventory snapshot.

The client fetches a full HTTP snapshot on reconnect and then applies only newer per-seat versioned deltas. Polling remains a fallback. Countdown display uses the server expiry timestamp and monotonic elapsed time, so a wrong local wall clock cannot extend a hold. The server rechecks expiry/capacity/price on every protected next action.

## Payments and money recovery

One pending PaymentAttempt per booking is enforced by a partial unique index. Idempotency keys bind to booking/method. Attempts have sequential per-parent references; a locked pending attempt blocks retries and method switches. Amounts come from fare tables and use integer centavos with the terminal fee included once. Provider redirects never establish payment success.

The mock adapter signs schema-canonical JSON with a timestamped HMAC. Webhooks check signature freshness and provider event uniqueness. Success atomically records the attempt/payment, sells inventory, issues unique passenger tickets and writes audit events, then publishes user events. Out-of-order failures cannot downgrade success. A two-minute reconciler queries persisted mock provider state for pending/failed attempts from the last 24 hours. A late success either issues the rightful ticket or opens an audited money exception. Staff can refund an extra settled payment without invalidating a valid original ticket. Pending freezes have a hard maximum; a later success after seat loss still becomes an explicit refund exception.

The terminal counter has a separate deadline and printed slip that is never a boarding pass. Staff identity confirmation triggers the same paid/ticket transaction. Real wallet/card/refund adapters are production prerequisites, not simulated bank integrations.

## Tickets, refunds and staff

QR payloads contain ticket/booking/sailing/seat/version identifiers and no passenger contact details. Tokens use an issuer/audience distinct from session cookies. Gate scanning locks the booking, checks live boarding status/version and inserts one unique scan. A repeated scan reports its first gate/time. Refund requests invalidate every ticket in the booking immediately, release inventory and create a sequential reference before asynchronous settlement. Counter refunds need an audited staff ID check. Refund estimates use configured time/reason tiers and never promise settlement timing.

Free rescheduling after cancellation/delay locks both sailings, validates the new route/capacity, moves assignments and increments QR versions. Staff catalogue/status/seat actions are role-guarded and audited. Manifests expose decrypted passenger details only to authorized staff; CSV cells are escaped against spreadsheet formulas. Northern Palawan boarding/departure requires clearance recorded at least four hours before departure.

## Privacy and operations

Passenger details use AES-256-GCM with random nonces and authenticated tags. Passwords use Argon2id; verification/reset secrets are stored as keyed hashes. HTTP-only cookies refer to revocable database sessions. Origin checks, input validation, request limits, user/IP hold caps and role/owner checks apply server-side. Logs avoid credentials and passenger bodies.

Notifications are durable DB outbox records. Workers claim a lease, send SMTP, record delivery and back off after failures. Duplicate concurrent jobs cannot claim the same live lease. SMTP does not provide exactly-once delivery across a process crash after sending but before acknowledgement; an occasional duplicate email remains possible. SMS is explicitly unconfigured. Retention redacts old terminal-booking passenger details and cleans expired auth material according to configuration while retaining financial/audit records.

Migration SQL is immutable after application and protected by a checksum ledger and advisory lock. Worker schedules are recreated idempotently after restart. Backups, real-provider testing, key management, monitoring, legal approval and production load/security review remain operational prerequisites documented separately.

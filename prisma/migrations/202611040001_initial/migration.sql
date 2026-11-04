-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PASSENGER', 'COUNTER_STAFF', 'GATE_STAFF', 'PORT_ADMIN');

-- CreateEnum
CREATE TYPE "SailingStatus" AS ENUM ('SCHEDULED', 'BOARDING', 'DEPARTED', 'DELAYED', 'CANCELLED', 'ARRIVED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('DRAFT', 'SEAT_HELD', 'PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED', 'HOLD_EXPIRED', 'COUNTER_PENDING', 'EXPIRED_UNPAID', 'TICKET_ISSUED', 'COMPLETED', 'REFUND_REQUESTED', 'REFUND_PROCESSING', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SeatState" AS ENUM ('AVAILABLE', 'HELD', 'PENDING_PAYMENT', 'SOLD', 'BLOCKED');

-- CreateEnum
CREATE TYPE "PassengerCategory" AS ENUM ('REGULAR_ADULT', 'STUDENT', 'SENIOR', 'PWD', 'CHILD', 'INFANT');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('GCASH', 'MAYA', 'CARD', 'COUNTER');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('TICKET_ISSUED', 'BOARDED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'PASSENGER',
    "verifiedAt" TIMESTAMP(3),
    "consentAt" TIMESTAMP(3) NOT NULL,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerification" (
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "PasswordReset" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Port" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "northernPalawan" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Port_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Route" (
    "id" TEXT NOT NULL,
    "originId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,

    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vessel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "registration" TEXT,

    CONSTRAINT "Vessel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VesselSeatLayout" (
    "id" TEXT NOT NULL,
    "vesselId" TEXT NOT NULL,
    "className" TEXT NOT NULL,
    "deck" INTEGER NOT NULL,

    CONSTRAINT "VesselSeatLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "layoutId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "row" INTEGER NOT NULL,
    "column" INTEGER NOT NULL,

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sailing" (
    "id" UUID NOT NULL,
    "vesselId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "departure" TIMESTAMP(3) NOT NULL,
    "arrival" TIMESTAMP(3) NOT NULL,
    "status" "SailingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "gate" TEXT NOT NULL,
    "terminal" TEXT NOT NULL,

    CONSTRAINT "Sailing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SailingSeat" (
    "sailingId" UUID NOT NULL,
    "seatId" TEXT NOT NULL,
    "state" "SeatState" NOT NULL DEFAULT 'AVAILABLE',
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SailingSeat_pkey" PRIMARY KEY ("sailingId","seatId")
);

-- CreateTable
CREATE TABLE "Fare" (
    "id" UUID NOT NULL,
    "sailingId" UUID NOT NULL,
    "className" TEXT NOT NULL,
    "category" "PassengerCategory" NOT NULL,
    "baseCentavos" INTEGER NOT NULL,
    "terminalFeeCentavos" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',

    CONSTRAINT "Fare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" UUID NOT NULL,
    "sequence" SERIAL NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "sailingId" UUID NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'DRAFT',
    "totalCentavos" INTEGER NOT NULL,
    "terminalFeeCentavos" INTEGER NOT NULL,
    "holdExpiresAt" TIMESTAMP(3),
    "extensionUsed" BOOLEAN NOT NULL DEFAULT false,
    "counterDeadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingPassenger" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "detailsCiphertext" TEXT NOT NULL,
    "category" "PassengerCategory" NOT NULL,
    "age" INTEGER NOT NULL,
    "gender" TEXT NOT NULL,

    CONSTRAINT "BookingPassenger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatHold" (
    "id" UUID NOT NULL,
    "sailingId" UUID NOT NULL,
    "seatId" TEXT NOT NULL,
    "bookingId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeatHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'PENDING',
    "providerReference" TEXT,
    "amountCentavos" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "amountCentavos" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "passengerId" UUID NOT NULL,
    "seatLabel" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'TICKET_ISSUED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoardingScan" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "gate" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoardingScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "refundNumber" INTEGER NOT NULL,
    "amountCentavos" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundPolicy" (
    "id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "minMinutesBefore" INTEGER NOT NULL,
    "maxMinutesBefore" INTEGER,
    "deductionBasisPoints" INTEGER NOT NULL,
    "refundable" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RefundPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordReset_userId_idx" ON "PasswordReset"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Route_originId_destinationId_key" ON "Route"("originId", "destinationId");

-- CreateIndex
CREATE UNIQUE INDEX "VesselSeatLayout_vesselId_className_deck_key" ON "VesselSeatLayout"("vesselId", "className", "deck");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_layoutId_label_key" ON "Seat"("layoutId", "label");

-- CreateIndex
CREATE INDEX "Sailing_routeId_departure_published_idx" ON "Sailing"("routeId", "departure", "published");

-- CreateIndex
CREATE INDEX "SailingSeat_sailingId_state_idx" ON "SailingSeat"("sailingId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Fare_sailingId_className_category_key" ON "Fare"("sailingId", "className", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_sequence_key" ON "Booking"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_reference_key" ON "Booking"("reference");

-- CreateIndex
CREATE INDEX "Booking_userId_status_idx" ON "Booking"("userId", "status");

-- CreateIndex
CREATE INDEX "SeatHold_expiresAt_releasedAt_idx" ON "SeatHold"("expiresAt", "releasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_reference_key" ON "PaymentAttempt"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_idempotencyKey_key" ON "PaymentAttempt"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_providerReference_key" ON "PaymentAttempt"("providerReference");

-- CreateIndex
CREATE INDEX "PaymentAttempt_status_createdAt_idx" ON "PaymentAttempt"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_bookingId_attemptNumber_key" ON "PaymentAttempt"("bookingId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_attemptId_key" ON "Payment"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_passengerId_key" ON "Ticket"("passengerId");

-- CreateIndex
CREATE UNIQUE INDEX "BoardingScan_ticketId_key" ON "BoardingScan"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_reference_key" ON "Refund"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_bookingId_refundNumber_key" ON "Refund"("bookingId", "refundNumber");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityId_createdAt_idx" ON "AuditLog"("entityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_originId_fkey" FOREIGN KEY ("originId") REFERENCES "Port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "Port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VesselSeatLayout" ADD CONSTRAINT "VesselSeatLayout_vesselId_fkey" FOREIGN KEY ("vesselId") REFERENCES "Vessel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "VesselSeatLayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sailing" ADD CONSTRAINT "Sailing_vesselId_fkey" FOREIGN KEY ("vesselId") REFERENCES "Vessel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sailing" ADD CONSTRAINT "Sailing_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SailingSeat" ADD CONSTRAINT "SailingSeat_sailingId_fkey" FOREIGN KEY ("sailingId") REFERENCES "Sailing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SailingSeat" ADD CONSTRAINT "SailingSeat_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fare" ADD CONSTRAINT "Fare_sailingId_fkey" FOREIGN KEY ("sailingId") REFERENCES "Sailing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_sailingId_fkey" FOREIGN KEY ("sailingId") REFERENCES "Sailing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPassenger" ADD CONSTRAINT "BookingPassenger_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatHold" ADD CONSTRAINT "SeatHold_sailingId_fkey" FOREIGN KEY ("sailingId") REFERENCES "Sailing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatHold" ADD CONSTRAINT "SeatHold_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatHold" ADD CONSTRAINT "SeatHold_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_passengerId_fkey" FOREIGN KEY ("passengerId") REFERENCES "BookingPassenger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardingScan" ADD CONSTRAINT "BoardingScan_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Prisma cannot express partial unique indexes. These are final-authority guards.
CREATE UNIQUE INDEX "SeatHold_one_active_assignment" ON "SeatHold" ("sailingId", "seatId") WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "PaymentAttempt_one_pending" ON "PaymentAttempt" ("bookingId") WHERE "status" = 'PENDING';
ALTER TABLE "SeatHold" ADD CONSTRAINT "SeatHold_inventory_fk" FOREIGN KEY ("sailingId", "seatId") REFERENCES "SailingSeat" ("sailingId", "seatId");
ALTER TABLE "Fare" ADD CONSTRAINT "Fare_nonnegative" CHECK ("baseCentavos" >= 0 AND "terminalFeeCentavos" >= 0 AND "currency" = 'PHP');
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_amounts" CHECK ("totalCentavos" >= 0 AND "terminalFeeCentavos" BETWEEN 0 AND "totalCentavos");
ALTER TABLE "BookingPassenger" ADD CONSTRAINT "Passenger_age" CHECK (age BETWEEN 0 AND 120);
ALTER TABLE "Sailing" ADD CONSTRAINT "Sailing_times" CHECK (arrival > departure);
ALTER TABLE "Route" ADD CONSTRAINT "Route_distinct_ports" CHECK ("originId" <> "destinationId" AND "durationMinutes" > 0);
ALTER TABLE "RefundPolicy" ADD CONSTRAINT "RefundPolicy_bounds" CHECK ("deductionBasisPoints" BETWEEN 0 AND 10000 AND "minMinutesBefore" >= 0 AND ("maxMinutesBefore" IS NULL OR "maxMinutesBefore" > "minMinutesBefore"));
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "Attempt_positive" CHECK ("amountCentavos" > 0 AND "attemptNumber" > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_positive" CHECK ("amountCentavos" > 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_positive" CHECK ("amountCentavos" >= 0 AND "refundNumber" > 0);
ALTER TABLE "User" ADD CONSTRAINT "User_email_normalized" CHECK (email = lower(email));

-- Use nextval (never MAX + 1). Exhaustion fails rather than wrapping references.
CREATE SEQUENCE booking_reference_seq MINVALUE 1 MAXVALUE 99999 NO CYCLE;
ALTER TABLE "Booking" ALTER COLUMN reference SET DEFAULT ('MP-' || lpad(nextval('booking_reference_seq')::text, 5, '0'));
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_reference_format" CHECK (reference ~ '^MP-[0-9]{5}$');

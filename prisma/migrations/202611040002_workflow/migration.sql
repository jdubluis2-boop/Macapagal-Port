ALTER TABLE "Booking" ADD COLUMN "holdIp" TEXT, ADD COLUMN "paymentStartedAt" TIMESTAMP(3), ADD COLUMN "paymentHoldExpiresAt" TIMESTAMP(3);
ALTER TABLE "BookingPassenger" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "seatId" TEXT;
ALTER TABLE "PaymentAttempt" ADD COLUMN "providerState" TEXT NOT NULL DEFAULT 'PENDING', ADD COLUMN "finalizedAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "deliveredAt" TIMESTAMP(3), ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "Sailing" ADD COLUMN "manifestClearedAt" TIMESTAMP(3), ADD COLUMN "manifestClearedBy" TEXT;
CREATE INDEX "Booking_holdIp_status" ON "Booking" ("holdIp", status);
CREATE INDEX "Notification_delivery" ON "Notification" ("deliveredAt", "nextAttemptAt");
UPDATE "RefundPolicy" SET "minMinutesBefore"=1440 WHERE id='voluntary-early' AND "minMinutesBefore"=1441;
UPDATE "RefundPolicy" SET "maxMinutesBefore"=1440 WHERE id='voluntary-standard' AND "maxMinutesBefore"=1441;

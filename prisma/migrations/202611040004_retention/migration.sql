ALTER TABLE "BookingPassenger" ADD COLUMN "redactedAt" TIMESTAMP(3);
CREATE INDEX "Passenger_redaction" ON "BookingPassenger" ("redactedAt");

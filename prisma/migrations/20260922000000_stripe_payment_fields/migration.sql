-- Stripe payment linkage (additive, all nullable — pre-Stripe rows stay NULL).
-- Booking.stripeSessionId = latest Checkout Session id for idempotent reuse;
-- paymentIntentId/paidAt/amountPaid are stamped by checkout.session.completed.
-- Invoice carries the same four columns so PAID stays scoped to the invoiced
-- session when a tenant later holds several DUE invoices (recurring billing).
ALTER TABLE "Booking" ADD COLUMN "stripeSessionId" TEXT;
ALTER TABLE "Booking" ADD COLUMN "paymentIntentId" TEXT;
ALTER TABLE "Booking" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "amountPaid" DECIMAL(10,2);

ALTER TABLE "Invoice" ADD COLUMN "stripeSessionId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "paymentIntentId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "amountPaid" DECIMAL(10,2);

CREATE INDEX "Booking_stripeSessionId_idx" ON "Booking"("stripeSessionId");
CREATE INDEX "Invoice_stripeSessionId_idx" ON "Invoice"("stripeSessionId");

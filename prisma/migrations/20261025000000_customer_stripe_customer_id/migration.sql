-- Saved payment cards (docs/SAVED_CARDS_PLAN.md): additive, nullable, no backfill.
ALTER TABLE "Customer" ADD COLUMN "stripeCustomerId" TEXT;

CREATE UNIQUE INDEX "Customer_stripeCustomerId_key" ON "Customer"("stripeCustomerId");

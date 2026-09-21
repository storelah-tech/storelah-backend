-- v2 booking-intent field-sync: store every booking-steps datum as first-class
-- Lead columns (additive, ALL NULLABLE — pre-v2 rows stay NULL, no data loss,
-- no NOT NULL). Legacy note-packed `key: value` lines keep working via the
-- parser fallback in serializeLead (src/core/leads.ts); new rows write these
-- columns directly and keep `note` for the message head only.
-- idempotencyKey is stored as a column (not packed into note) so the 24h
-- double-submit dedupe keeps working for new rows.
ALTER TABLE "Lead" ADD COLUMN "unitCode" TEXT;
ALTER TABLE "Lead" ADD COLUMN "moveInDate" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "durationMonths" INTEGER;
ALTER TABLE "Lead" ADD COLUMN "companyName" TEXT;
ALTER TABLE "Lead" ADD COLUMN "uen" TEXT;
ALTER TABLE "Lead" ADD COLUMN "consentPdpa" BOOLEAN;
ALTER TABLE "Lead" ADD COLUMN "consentMarketing" BOOLEAN;
ALTER TABLE "Lead" ADD COLUMN "protectionTier" TEXT;
ALTER TABLE "Lead" ADD COLUMN "protectionCost" DECIMAL(10,2);
ALTER TABLE "Lead" ADD COLUMN "addons" JSONB;
ALTER TABLE "Lead" ADD COLUMN "promoCode" TEXT;
ALTER TABLE "Lead" ADD COLUMN "promoDiscountAmt" DECIMAL(10,2);
ALTER TABLE "Lead" ADD COLUMN "movingService" BOOLEAN;
ALTER TABLE "Lead" ADD COLUMN "totalDueToday" DECIMAL(10,2);
ALTER TABLE "Lead" ADD COLUMN "idempotencyKey" TEXT;

CREATE INDEX "Lead_idempotencyKey_idx" ON "Lead"("idempotencyKey");

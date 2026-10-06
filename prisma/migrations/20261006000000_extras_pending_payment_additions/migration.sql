-- Additive batch: slashed-price + addon description + pending-payment lead stage.
-- All statements are additive; no column drops, no data rewrites.

-- (12) Promo slashed-price: nullable struck-through original price on extras catalog.
ALTER TABLE "ProtectionPlan" ADD COLUMN IF NOT EXISTS "wasPrice" DECIMAL(10,2);
ALTER TABLE "Addon" ADD COLUMN IF NOT EXISTS "wasPrice" DECIMAL(10,2);

-- (13) Addon description (ProtectionPlan keeps `coverage`; Addon gets `description`).
ALTER TABLE "Addon" ADD COLUMN IF NOT EXISTS "description" TEXT;

-- (14) Leads Pending Payment: new LeadStage value (same bare ALTER TYPE pattern
-- as the BLOCKED / GUEST enum migrations in this repo).
ALTER TYPE "LeadStage" ADD VALUE 'PENDING_PAYMENT';

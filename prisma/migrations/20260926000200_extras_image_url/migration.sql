-- Booking-extras image support (CMS-editable checkout artwork).
-- Additive only: one nullable TEXT column per catalog table. No backfill
-- (NULL = no image), no index, no changes to existing columns or pricing.
ALTER TABLE "ProtectionPlan" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "Addon" ADD COLUMN "imageUrl" TEXT;

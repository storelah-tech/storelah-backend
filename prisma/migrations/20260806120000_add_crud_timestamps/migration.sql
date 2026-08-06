-- Add createdAt/updatedAt to the CRUD models that lacked them:
--   Unit, RateChange, Invoice, Floor, UnitSize.
-- Columns are added NULLABLE, backfilled, then constrained — safe on non-empty tables.

-- AlterTable Unit
ALTER TABLE "Unit" ADD COLUMN "createdAt" TIMESTAMP(3);
ALTER TABLE "Unit" ADD COLUMN "updatedAt" TIMESTAMP(3);

-- AlterTable RateChange
ALTER TABLE "RateChange" ADD COLUMN "createdAt" TIMESTAMP(3);
ALTER TABLE "RateChange" ADD COLUMN "updatedAt" TIMESTAMP(3);

-- AlterTable Invoice
ALTER TABLE "Invoice" ADD COLUMN "createdAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "updatedAt" TIMESTAMP(3);

-- AlterTable Floor
ALTER TABLE "Floor" ADD COLUMN "createdAt" TIMESTAMP(3);
ALTER TABLE "Floor" ADD COLUMN "updatedAt" TIMESTAMP(3);

-- AlterTable UnitSize
ALTER TABLE "UnitSize" ADD COLUMN "createdAt" TIMESTAMP(3);
ALTER TABLE "UnitSize" ADD COLUMN "updatedAt" TIMESTAMP(3);

-- Backfill:
--   Unit.createdAt <- earliest related rate-change date, else the tenant move-in date, else now().
--   Unit.updatedAt  = createdAt (so backfilled rows never emit spurious "unit_updated" activity).
--   RateChange.createdAt/updatedAt <- the change's own date (natural creation timestamp).
--   Invoice.createdAt/updatedAt    <- billedMonth (natural creation timestamp).
--   Floor / UnitSize keep CURRENT_TIMESTAMP (pure reference data, no natural anchor).
UPDATE "Unit" u SET "createdAt" = COALESCE(
  (SELECT MIN(rc."date") FROM "RateChange" rc WHERE rc."unitId" = u."id"),
  (SELECT t."moveInDate" FROM "Tenant" t WHERE t."unitId" = u."id"),
  CURRENT_TIMESTAMP
);
UPDATE "Unit" SET "updatedAt" = "createdAt";
UPDATE "RateChange" SET "createdAt" = "date", "updatedAt" = "date";
UPDATE "Invoice" SET "createdAt" = "billedMonth", "updatedAt" = "billedMonth";
-- Reference rows: no natural anchor, so pin to the migration timestamp.
UPDATE "Floor" SET "createdAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP;
UPDATE "UnitSize" SET "createdAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP;

-- Enforce the schema.prisma contract (NOT NULL + defaults for createdAt).
ALTER TABLE "Unit" ALTER COLUMN "createdAt" SET NOT NULL, ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Unit" ALTER COLUMN "updatedAt" SET NOT NULL;
ALTER TABLE "RateChange" ALTER COLUMN "createdAt" SET NOT NULL, ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "RateChange" ALTER COLUMN "updatedAt" SET NOT NULL;
ALTER TABLE "Invoice" ALTER COLUMN "createdAt" SET NOT NULL, ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Invoice" ALTER COLUMN "updatedAt" SET NOT NULL;
ALTER TABLE "Floor" ALTER COLUMN "createdAt" SET NOT NULL, ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Floor" ALTER COLUMN "updatedAt" SET NOT NULL;
ALTER TABLE "UnitSize" ALTER COLUMN "createdAt" SET NOT NULL, ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "UnitSize" ALTER COLUMN "updatedAt" SET NOT NULL;

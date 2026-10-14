-- Decimal unit sizes (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md "Decimal sqft"):
-- Unit.sqft and the size-history columns widen from INTEGER to DOUBLE
-- PRECISION; the app quantizes to 0.01 sqft on every write. Widening is
-- lossless for existing rows.
--
-- DEPLOY HAZARD (same as 20261013000000_floor_plan_decimal_feet): a client
-- generated against the old INTEGER schema WRITES corrupt values into a
-- DOUBLE column (3 → 1.5e-323). Freeze CMS unit create/edit/CSV import,
-- run this migration, update the Lambda immediately, then run the corruption
-- check in the plan doc before lifting the freeze.

-- AlterTable
ALTER TABLE "Unit" ALTER COLUMN "sqft" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "UnitAreaChange" ALTER COLUMN "previous" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "current" SET DATA TYPE DOUBLE PRECISION;

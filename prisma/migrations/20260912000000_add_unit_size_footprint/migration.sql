-- AlterTable: blueprint-accurate footprints (P1). Adds the per-size footprint in
-- FEET (1 grid unit = 1 ft) and backfills the four known catalogue sizes so
-- existing databases gain true dimensions without a re-seed:
--   LOCKER 12 sqft → 3×4 ft · SMALL 30 sqft → 5×6 ft ·
--   MEDIUM 60 sqft → 6×10 ft · LARGE 120 sqft → 10×12 ft
-- Columns stay NULLABLE: a size added without dims (or any pre-existing custom
-- size this UPDATE does not match) keeps NULL and the server/client fall back
-- to the documented aspect formula (sqftFootprint). Existing UnitPlacement rows
-- are NOT touched by this migration — seeded uniform 2×3 geometry is
-- grandfathered and clamped, never wiped; ops migrate it via
-- `pnpm db:backfill-footprints` (scripts/backfill-placement-footprints.ts).
ALTER TABLE "UnitSize" ADD COLUMN "widthFt" INTEGER;
ALTER TABLE "UnitSize" ADD COLUMN "heightFt" INTEGER;

UPDATE "UnitSize" SET "widthFt" = 3, "heightFt" = 4 WHERE "code" = 'LOCKER';
UPDATE "UnitSize" SET "widthFt" = 5, "heightFt" = 6 WHERE "code" = 'SMALL';
UPDATE "UnitSize" SET "widthFt" = 6, "heightFt" = 10 WHERE "code" = 'MEDIUM';
UPDATE "UnitSize" SET "widthFt" = 10, "heightFt" = 12 WHERE "code" = 'LARGE';

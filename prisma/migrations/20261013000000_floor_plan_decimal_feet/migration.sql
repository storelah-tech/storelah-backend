-- Floor-plan precision Phase 1: integer feet -> decimal feet.
--
-- Widens every plan geometry column from INTEGER to DOUBLE PRECISION. The cast
-- is lossless (every existing integer is exactly representable), so all
-- existing plans keep identical values. New writes are quantized to 0.001 ft
-- by the application (src/core/planGeometry.ts). JSON geometry
-- (FloorPlanBoundary.points, FloorPlanDraft snapshots) needs no DDL.
-- See docs/FLOOR_PLAN_PRECISION_PLAN.md.

ALTER TABLE "FloorPlan"
  ALTER COLUMN "width" SET DATA TYPE DOUBLE PRECISION,
  ALTER COLUMN "height" SET DATA TYPE DOUBLE PRECISION;

ALTER TABLE "FloorPlanDraft"
  ALTER COLUMN "width" SET DATA TYPE DOUBLE PRECISION,
  ALTER COLUMN "height" SET DATA TYPE DOUBLE PRECISION;

ALTER TABLE "UnitPlacement"
  ALTER COLUMN "x" SET DATA TYPE DOUBLE PRECISION,
  ALTER COLUMN "y" SET DATA TYPE DOUBLE PRECISION,
  ALTER COLUMN "width" SET DATA TYPE DOUBLE PRECISION,
  ALTER COLUMN "height" SET DATA TYPE DOUBLE PRECISION;

ALTER TABLE "FloorPlanBlock"
  ALTER COLUMN "x" SET DATA TYPE DOUBLE PRECISION,
  ALTER COLUMN "y" SET DATA TYPE DOUBLE PRECISION,
  ALTER COLUMN "width" SET DATA TYPE DOUBLE PRECISION,
  ALTER COLUMN "height" SET DATA TYPE DOUBLE PRECISION;

ALTER TABLE "FloorPlanMarker"
  ALTER COLUMN "x" SET DATA TYPE DOUBLE PRECISION,
  ALTER COLUMN "y" SET DATA TYPE DOUBLE PRECISION;

ALTER TABLE "UnitSize"
  ALTER COLUMN "widthFt" SET DATA TYPE DOUBLE PRECISION,
  ALTER COLUMN "heightFt" SET DATA TYPE DOUBLE PRECISION;

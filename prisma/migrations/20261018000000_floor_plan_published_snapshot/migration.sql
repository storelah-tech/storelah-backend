-- R-FP1: keep serving the last-published floor plan while it is edited.
-- Additive, nullable, no backfill here (scripts/backfill-floorplan-snapshots.ts
-- captures ACTIVE plans; public reads also capture lazily).
ALTER TABLE "FloorPlan" ADD COLUMN "publishedSnapshot" JSONB;
ALTER TABLE "FloorPlan" ADD COLUMN "publishedAt" TIMESTAMP(3);

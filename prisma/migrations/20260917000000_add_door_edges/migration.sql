-- Phase 3 (Floor Plan Area Metrics): authored door compass edges per region.
-- Adds NULLABLE "doorEdges" (canonical CSV subset of N/S/E/W, e.g. "N,S")
-- to UnitPlacement and FloorPlanBlock for the editor door-side toggles.
-- Additive only: NULL means unauthored (metrics bridge falls back to
-- AUTO_ALL_EDGES), so no existing row changes meaning and no backfill is needed.
ALTER TABLE "UnitPlacement" ADD COLUMN "doorEdges" TEXT;
ALTER TABLE "FloorPlanBlock" ADD COLUMN "doorEdges" TEXT;

-- Floor-plan precision Phase 3: wall thickness for WALL line items.
-- Additive + nullable: existing rows keep NULL, and code that does not know
-- the column never writes it (safe to apply before the Lambda update).
ALTER TABLE "FloorPlanBoundary" ADD COLUMN "thickness" DOUBLE PRECISION;

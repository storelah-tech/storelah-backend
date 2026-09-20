-- Operator-entered gross floor area per floor plan.
-- Adds NULLABLE "gfaSqft" (sqft, Float) to FloorPlan. Additive only: NULL means
-- unset (the metrics report falls back to the canvas-derived rect and flags it
-- in basis_notes), so no existing row changes meaning and no backfill of fake
-- values is needed.
ALTER TABLE "FloorPlan" ADD COLUMN "gfaSqft" DOUBLE PRECISION;

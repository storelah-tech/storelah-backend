-- Floor-plan layout persistence (operator "facility setup" floor-plan editor).
--
-- FloorPlan: THE editable canvas for a Floor (single plan per floor, enforced by
-- the UNIQUE index on "floorId"). width/height are canvas dimensions in logical
-- grid units; "structure" is a free-form JSONB decoration document drawn by the
-- operator (walls / corridors / entrance / lift / stairs / fire exit).
--
-- UnitPlacement: one-to-one geometry row per unit on its floor's plan — x/y
-- top-left position and width/height bounding box, all in the same grid units.
-- "@@unique([unitId])" means a unit is placed at most once (upsert key for the
-- editor's save). Unit linkage is via the cascading-cuid Unit.id, never unitCode.
--
-- Delete semantics (respecting the soft-delete lifecycle):
--   - deleting a FloorPlan cascades its placements; Unit rows are untouched
--     (the FK points placement -> unit, never back);
--   - deleting a Floor cascades its plan (a floor with units can't be deleted
--     anyway — Unit.floorId has no cascade);
--   - "ON DELETE RESTRICT" on UnitPlacement.unitId guards a future HARD unit
--     delete while a placement exists (purge must clear placements first);
--     app-level unit deletion is soft (Unit.deletedAt, an UPDATE) so it never
--     fires — placement rows persist and reads filter on deletedAt.
--
-- Additive and non-destructive: only new tables/constraints; no existing column
-- or table is altered.

-- CreateTable
CREATE TABLE "FloorPlan" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "structure" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitPlacement" (
    "id" TEXT NOT NULL,
    "floorPlanId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnitPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FloorPlan_floorId_key" ON "FloorPlan"("floorId");

-- CreateIndex
CREATE UNIQUE INDEX "UnitPlacement_unitId_key" ON "UnitPlacement"("unitId");

-- CreateIndex
CREATE INDEX "UnitPlacement_floorPlanId_idx" ON "UnitPlacement"("floorPlanId");

-- AddForeignKey
ALTER TABLE "FloorPlan" ADD CONSTRAINT "FloorPlan_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitPlacement" ADD CONSTRAINT "UnitPlacement_floorPlanId_fkey" FOREIGN KEY ("floorPlanId") REFERENCES "FloorPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitPlacement" ADD CONSTRAINT "UnitPlacement_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

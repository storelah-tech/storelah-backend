-- Floor-plan precision Phase 5: CMS-only tracing underlay (one per plan).
-- Additive: a new table nothing else reads, safe to apply before the Lambda update.
CREATE TABLE "FloorPlanUnderlay" (
    "id" TEXT NOT NULL,
    "floorPlanId" TEXT NOT NULL,
    "name" TEXT,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "widthPx" INTEGER NOT NULL,
    "heightPx" INTEGER NOT NULL,
    "ftPerPx" DOUBLE PRECISION NOT NULL,
    "offsetX" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "offsetY" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "opacity" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorPlanUnderlay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FloorPlanUnderlay_floorPlanId_key" ON "FloorPlanUnderlay"("floorPlanId");

ALTER TABLE "FloorPlanUnderlay" ADD CONSTRAINT "FloorPlanUnderlay_floorPlanId_fkey" FOREIGN KEY ("floorPlanId") REFERENCES "FloorPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

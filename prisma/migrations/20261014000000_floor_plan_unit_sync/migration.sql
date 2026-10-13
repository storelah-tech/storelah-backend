-- Floor-plan unit sync Phase 1 (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md). Additive only.

-- AlterEnum: DRAFT units are drawn on the plan but unpublished. No row uses the
-- value until the new code ships, so the previously deployed client stays safe.
ALTER TYPE "UnitStatus" ADD VALUE 'DRAFT';

-- AlterTable: area changed since last publish (default false = never auto-sync
-- grandfathered placements).
ALTER TABLE "UnitPlacement" ADD COLUMN "areaDirty" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "UnitAreaChange" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "previous" INTEGER NOT NULL,
    "current" INTEGER NOT NULL,
    "prevSizeId" TEXT NOT NULL,
    "newSizeId" TEXT NOT NULL,
    "widthFt" DOUBLE PRECISION,
    "heightFt" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "floorPlanId" TEXT,
    "appliedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitAreaChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnitAreaChange_unitId_idx" ON "UnitAreaChange"("unitId");

-- AddForeignKey
ALTER TABLE "UnitAreaChange" ADD CONSTRAINT "UnitAreaChange_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

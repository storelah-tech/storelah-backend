-- CreateTable
CREATE TABLE "FloorPlanMarker" (
    "id" TEXT NOT NULL,
    "floorPlanId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorPlanMarker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FloorPlanMarker_floorPlanId_idx" ON "FloorPlanMarker"("floorPlanId");

-- AddForeignKey
ALTER TABLE "FloorPlanMarker" ADD CONSTRAINT "FloorPlanMarker_floorPlanId_fkey" FOREIGN KEY ("floorPlanId") REFERENCES "FloorPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

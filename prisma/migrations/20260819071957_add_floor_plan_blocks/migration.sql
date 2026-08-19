-- CreateTable
CREATE TABLE "FloorPlanBlock" (
    "id" TEXT NOT NULL,
    "floorPlanId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorPlanBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FloorPlanBlock_floorPlanId_idx" ON "FloorPlanBlock"("floorPlanId");

-- AddForeignKey
ALTER TABLE "FloorPlanBlock" ADD CONSTRAINT "FloorPlanBlock_floorPlanId_fkey" FOREIGN KEY ("floorPlanId") REFERENCES "FloorPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

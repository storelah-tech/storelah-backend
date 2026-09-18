-- CreateTable
CREATE TABLE "FloorPlanBoundary" (
    "id" TEXT NOT NULL,
    "floorPlanId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Boundary',
    "kind" TEXT NOT NULL DEFAULT 'BOUNDARY',
    "points" JSONB NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorPlanBoundary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FloorPlanBoundary_floorPlanId_idx" ON "FloorPlanBoundary"("floorPlanId");

-- AddForeignKey
ALTER TABLE "FloorPlanBoundary" ADD CONSTRAINT "FloorPlanBoundary_floorPlanId_fkey" FOREIGN KEY ("floorPlanId") REFERENCES "FloorPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

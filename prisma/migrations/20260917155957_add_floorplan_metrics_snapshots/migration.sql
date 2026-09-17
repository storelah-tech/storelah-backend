-- CreateTable
CREATE TABLE "FloorplanMetricsSnapshot" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "geometryHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FloorplanMetricsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FloorplanMetricsSnapshot_branchId_floorId_effectiveDate_idx" ON "FloorplanMetricsSnapshot"("branchId", "floorId", "effectiveDate");

-- CreateIndex
CREATE INDEX "FloorplanMetricsSnapshot_floorId_idx" ON "FloorplanMetricsSnapshot"("floorId");

-- AddForeignKey
ALTER TABLE "FloorplanMetricsSnapshot" ADD CONSTRAINT "FloorplanMetricsSnapshot_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorplanMetricsSnapshot" ADD CONSTRAINT "FloorplanMetricsSnapshot_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

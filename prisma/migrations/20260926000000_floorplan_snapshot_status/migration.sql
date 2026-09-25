-- Promotions-mirrored draft workflow for floor-plan metrics snapshots (additive).
-- Adds status (+ approverRole / validatedAt / publishedAt audit columns) to
-- FloorplanMetricsSnapshot. The column default backfills every pre-workflow
-- row to ACTIVE (published equivalent), so existing published history keeps
-- resolving as authoritative with no data rewrite and no seed wipe.
ALTER TABLE "FloorplanMetricsSnapshot" ADD COLUMN "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "FloorplanMetricsSnapshot" ADD COLUMN "approverRole" TEXT;
ALTER TABLE "FloorplanMetricsSnapshot" ADD COLUMN "validatedAt" TIMESTAMP(3);
ALTER TABLE "FloorplanMetricsSnapshot" ADD COLUMN "publishedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "FloorplanMetricsSnapshot_floorId_status_idx" ON "FloorplanMetricsSnapshot"("floorId", "status");

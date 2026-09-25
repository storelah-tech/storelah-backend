-- FloorPlan draft vs published (additive, cross-app contract with the booking frontend).
-- Adds status (PlanStatus vocabulary shared with promotion plans) to FloorPlan:
-- CMS writes always persist DRAFT, POST /floor-plans/:floorId/publish walks
-- DRAFT -> ACTIVE, and public reads resolve ONLY ACTIVE plans (draft-only
-- floors read as plan: null — the exact shape booking already handles).
-- The column default backfills every pre-workflow row to ACTIVE (published
-- equivalent), so live plans stay visible with no silent unpublish and no seed wipe.
ALTER TABLE "FloorPlan" ADD COLUMN "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE';

-- New rows are CMS-authored drafts: flip the default to DRAFT after the backfill.
ALTER TABLE "FloorPlan" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- CreateIndex
CREATE INDEX "FloorPlan_status_idx" ON "FloorPlan"("status");

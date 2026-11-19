-- Master Rate Strategy schema (Track B, B2 — brief §5 Track B part).
--
-- Additive only: 4 new tables + 5 new enums + 2 new Unit columns. No drops,
-- no renames, no changes to existing rows except the R16 backfill below.
-- The backfill and the seeded-role grants are idempotent (re-runnable).

-- CreateEnum
CREATE TYPE "RateStrategyStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RateStrategyMethod" AS ENUM ('SMOOTH', 'STEP');

-- CreateEnum
CREATE TYPE "RateBatchStatus" AS ENUM ('SCHEDULED', 'APPLYING', 'APPLIED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RateBatchConflictRule" AS ENUM ('PRESERVE_MANUAL', 'REPLACE_MANUAL', 'CANCEL_IF_MANUAL');

-- CreateEnum
CREATE TYPE "RateBatchLineOutcome" AS ENUM ('PENDING', 'APPLIED', 'PRESERVED_MANUAL', 'SKIPPED_OCCUPIED', 'FAILED');

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "rateSource" TEXT NOT NULL DEFAULT 'LEGACY',
ADD COLUMN     "restrictedAccess" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "RateStrategy" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateStrategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateStrategyVersion" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "status" "RateStrategyStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" DATE NOT NULL,
    "referenceSize" INTEGER NOT NULL,
    "startingRate" DECIMAL(10,2) NOT NULL,
    "method" "RateStrategyMethod" NOT NULL DEFAULT 'SMOOTH',
    "curveStrength" DECIMAL(10,4) NOT NULL,
    "stepEvery" INTEGER NOT NULL,
    "stepPsf" DECIMAL(10,4) NOT NULL,
    "psfFloor" DECIMAL(10,4) NOT NULL,
    "minMonthly" DECIMAL(10,2) NOT NULL,
    "lockerAdj" DECIMAL(10,4) NOT NULL,
    "groundFloorAdj" DECIMAL(10,4) NOT NULL,
    "restrictedAdj" DECIMAL(10,4) NOT NULL,
    "facilityAdj" DECIMAL(10,4) NOT NULL,
    "rounding" INTEGER NOT NULL,
    "categoryFloors" JSONB NOT NULL,
    "sizeOverrides" JSONB NOT NULL,
    "previewSelection" JSONB NOT NULL,
    "financialModelId" TEXT,
    "financialModelVersion" INTEGER,
    "targetPsf" DECIMAL(10,4),
    "validation" JSONB,
    "warningOverride" JSONB,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "originVersionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateStrategyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitRateBatch" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "conflictRule" "RateBatchConflictRule" NOT NULL DEFAULT 'PRESERVE_MANUAL',
    "status" "RateBatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "unitCount" INTEGER NOT NULL DEFAULT 0,
    "sizeCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "appliedBy" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnitRateBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitRateBatchLine" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "sizePoint" INTEGER NOT NULL,
    "previousRack" DECIMAL(10,2) NOT NULL,
    "proposedRack" DECIMAL(10,2) NOT NULL,
    "outcome" "RateBatchLineOutcome" NOT NULL DEFAULT 'PENDING',
    "conflictReason" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitRateBatchLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateStrategy_branchId_idx" ON "RateStrategy"("branchId");

-- CreateIndex
CREATE INDEX "RateStrategyVersion_strategyId_idx" ON "RateStrategyVersion"("strategyId");

-- CreateIndex
CREATE UNIQUE INDEX "RateStrategyVersion_strategyId_versionNo_key" ON "RateStrategyVersion"("strategyId", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "UnitRateBatch_ref_key" ON "UnitRateBatch"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "UnitRateBatch_idempotencyKey_key" ON "UnitRateBatch"("idempotencyKey");

-- CreateIndex
CREATE INDEX "UnitRateBatch_branchId_idx" ON "UnitRateBatch"("branchId");

-- CreateIndex
CREATE INDEX "UnitRateBatch_versionId_idx" ON "UnitRateBatch"("versionId");

-- CreateIndex
CREATE INDEX "UnitRateBatchLine_batchId_idx" ON "UnitRateBatchLine"("batchId");

-- CreateIndex
CREATE INDEX "UnitRateBatchLine_unitId_idx" ON "UnitRateBatchLine"("unitId");

-- AddForeignKey
ALTER TABLE "RateStrategy" ADD CONSTRAINT "RateStrategy_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateStrategyVersion" ADD CONSTRAINT "RateStrategyVersion_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "RateStrategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitRateBatch" ADD CONSTRAINT "UnitRateBatch_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "RateStrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitRateBatch" ADD CONSTRAINT "UnitRateBatch_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitRateBatchLine" ADD CONSTRAINT "UnitRateBatchLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "UnitRateBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitRateBatchLine" ADD CONSTRAINT "UnitRateBatchLine_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- R16 backfill (UPDATE-only, idempotent): a unit whose rate was ever changed
-- by anyone other than 'System' is operator-manual. Re-running sets the same
-- rows again (a no-op for rows already 'MANUAL'); with zero RateChange rows
-- (fresh DB) it updates zero rows.
UPDATE "Unit" SET "rateSource" = 'MANUAL'
WHERE EXISTS (
  SELECT 1 FROM "RateChange" rc
  WHERE rc."unitId" = "Unit"."id" AND rc."appliedBy" <> 'System'
);

-- Seeded-role grants for the new `facility-rate-strategy` resource (P0 §5
-- proposal): Owner holds everything (belt-and-braces — ensureSystemRoles
-- rebuilds the Owner matrix from ALL_PERMISSIONS on boot/seed anyway);
-- Manager edits but never approves (maker-checker); Finance roles and
-- Auditor read; Viewer is hidden by default (no grant here). Permission rows
-- only; ON CONFLICT DO NOTHING makes the migration re-runnable.
INSERT INTO "AdminRolePermission" ("id", "roleId", "permission") VALUES
  ('role_owner_facility_rate_strategy_view', 'role_owner', 'facility-rate-strategy:view'),
  ('role_owner_facility_rate_strategy_create', 'role_owner', 'facility-rate-strategy:create'),
  ('role_owner_facility_rate_strategy_update', 'role_owner', 'facility-rate-strategy:update'),
  ('role_owner_facility_rate_strategy_approve', 'role_owner', 'facility-rate-strategy:approve'),
  ('role_manager_facility_rate_strategy_view', 'role_manager', 'facility-rate-strategy:view'),
  ('role_manager_facility_rate_strategy_create', 'role_manager', 'facility-rate-strategy:create'),
  ('role_manager_facility_rate_strategy_update', 'role_manager', 'facility-rate-strategy:update'),
  ('role_finance_operator_facility_rate_strategy_view', 'role_finance_operator', 'facility-rate-strategy:view'),
  ('role_finance_approver_facility_rate_strategy_view', 'role_finance_approver', 'facility-rate-strategy:view'),
  ('role_finance_auditor_facility_rate_strategy_view', 'role_finance_auditor', 'facility-rate-strategy:view')
ON CONFLICT ("roleId", "permission") DO NOTHING;

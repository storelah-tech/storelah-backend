-- Track A phase A2 (move-outs, refunds, unit transfers) — schema + settings.
-- ADDITIVE ONLY: one new TenantStatus enum value, brand-new tables, new
-- nullable/defaulted CustomerSettlement columns, one new unique idempotency
-- column. No drops, no renames, no changes to existing column types.
-- The legacy CustomerSettlement status remap + seeded-role grants below are
-- UPDATE/INSERT-only and idempotent (safe to apply twice — re-running matches
-- zero status rows and hits ON CONFLICT DO NOTHING on every grant).

-- AlterEnum
ALTER TYPE "TenantStatus" ADD VALUE 'SUSPENDED';

-- AlterTable
ALTER TABLE "CustomerSettlement" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "calcSnapshot" JSONB,
ADD COLUMN     "calcVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "moveOutCaseId" TEXT,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "postingRef" TEXT,
ADD COLUMN     "processedAt" TIMESTAMP(3),
ADD COLUMN     "processedBy" TEXT,
ADD COLUMN     "processingError" TEXT,
ADD COLUMN     "processorRef" TEXT,
ADD COLUMN     "reasonCode" TEXT,
ADD COLUMN     "returnMethod" TEXT,
ADD COLUMN     "sourceRef" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MoveOutCase" (
    "id" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "branchId" TEXT,
    "requestReceivedAt" TIMESTAMP(3) NOT NULL,
    "requestChannel" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "requestNotes" TEXT,
    "finalAccessDate" DATE NOT NULL,
    "noticeDays" INTEGER NOT NULL,
    "noticeRequiredDays" INTEGER NOT NULL,
    "noticeCompliant" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "policySnapshot" JSONB NOT NULL,
    "noticeId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedBy" TEXT,
    "reversalReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoveOutCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoveOutDateChange" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "previousDate" DATE NOT NULL,
    "newDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "byCustomer" BOOLEAN NOT NULL DEFAULT false,
    "actor" TEXT NOT NULL,
    "beforeCalc" JSONB,
    "afterCalc" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoveOutDateChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoveOutInspection" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "unitEmpty" BOOLEAN NOT NULL,
    "doorLockWallsFloorChecked" BOOLEAN NOT NULL,
    "accessRevoked" BOOLEAN NOT NULL,
    "releaseConfirmed" BOOLEAN NOT NULL,
    "releaseStatus" TEXT NOT NULL,
    "damageCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "cleaningCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "disposalCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "otherCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "arrearsAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "specialCredit" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL,
    "evidenceRefs" JSONB,
    "inspector" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoveOutInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementChangeRequest" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "assignTeam" TEXT,
    "assigneeId" TEXT,
    "dueDate" TIMESTAMP(3),
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "response" TEXT,
    "respondedBy" TEXT,
    "respondedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessorAttempt" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "rawEventRef" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "reconciliation" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessorAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerLedgerEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT,
    "settlementId" TEXT,
    "invoiceId" TEXT,
    "entryType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "debit" DECIMAL(10,2),
    "credit" DECIMAL(10,2),
    "currency" TEXT NOT NULL DEFAULT 'SGD',
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversalOfId" TEXT,
    "processorRef" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalUnitHistory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "startedAt" DATE NOT NULL,
    "endedAt" DATE NOT NULL,
    "endReason" TEXT NOT NULL,
    "replacementUnitId" TEXT,
    "pricingSnapshot" JSONB NOT NULL,
    "billedTotals" JSONB NOT NULL,
    "transferCredit" DECIMAL(10,2),
    "sourceSettlementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentalUnitHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalStatusChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "accessRestricted" BOOLEAN,
    "reason" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentalStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MoveOutCase_caseNumber_key" ON "MoveOutCase"("caseNumber");

-- CreateIndex
CREATE INDEX "MoveOutCase_tenantId_idx" ON "MoveOutCase"("tenantId");

-- CreateIndex
CREATE INDEX "MoveOutCase_unitId_idx" ON "MoveOutCase"("unitId");

-- CreateIndex
CREATE INDEX "MoveOutCase_branchId_idx" ON "MoveOutCase"("branchId");

-- CreateIndex
CREATE INDEX "MoveOutCase_status_idx" ON "MoveOutCase"("status");

-- CreateIndex
CREATE INDEX "MoveOutDateChange_caseId_idx" ON "MoveOutDateChange"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "MoveOutInspection_caseId_key" ON "MoveOutInspection"("caseId");

-- CreateIndex
CREATE INDEX "SettlementChangeRequest_settlementId_idx" ON "SettlementChangeRequest"("settlementId");

-- CreateIndex
CREATE INDEX "SettlementChangeRequest_status_idx" ON "SettlementChangeRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessorAttempt_idempotencyKey_key" ON "ProcessorAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ProcessorAttempt_settlementId_idx" ON "ProcessorAttempt"("settlementId");

-- CreateIndex
CREATE INDEX "ProcessorAttempt_status_idx" ON "ProcessorAttempt"("status");

-- CreateIndex
CREATE INDEX "CustomerLedgerEntry_tenantId_idx" ON "CustomerLedgerEntry"("tenantId");

-- CreateIndex
CREATE INDEX "CustomerLedgerEntry_settlementId_idx" ON "CustomerLedgerEntry"("settlementId");

-- CreateIndex
CREATE INDEX "CustomerLedgerEntry_invoiceId_idx" ON "CustomerLedgerEntry"("invoiceId");

-- CreateIndex
CREATE INDEX "CustomerLedgerEntry_status_idx" ON "CustomerLedgerEntry"("status");

-- CreateIndex
CREATE INDEX "RentalUnitHistory_tenantId_idx" ON "RentalUnitHistory"("tenantId");

-- CreateIndex
CREATE INDEX "RentalUnitHistory_unitId_idx" ON "RentalUnitHistory"("unitId");

-- CreateIndex
CREATE INDEX "RentalStatusChange_tenantId_idx" ON "RentalStatusChange"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSettlement_moveOutCaseId_key" ON "CustomerSettlement"("moveOutCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSettlement_idempotencyKey_key" ON "CustomerSettlement"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "CustomerSettlement" ADD CONSTRAINT "CustomerSettlement_moveOutCaseId_fkey" FOREIGN KEY ("moveOutCaseId") REFERENCES "MoveOutCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoveOutCase" ADD CONSTRAINT "MoveOutCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoveOutCase" ADD CONSTRAINT "MoveOutCase_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoveOutCase" ADD CONSTRAINT "MoveOutCase_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoveOutCase" ADD CONSTRAINT "MoveOutCase_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "Notice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoveOutDateChange" ADD CONSTRAINT "MoveOutDateChange_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "MoveOutCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoveOutInspection" ADD CONSTRAINT "MoveOutInspection_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "MoveOutCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementChangeRequest" ADD CONSTRAINT "SettlementChangeRequest_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "CustomerSettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessorAttempt" ADD CONSTRAINT "ProcessorAttempt_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "CustomerSettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLedgerEntry" ADD CONSTRAINT "CustomerLedgerEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLedgerEntry" ADD CONSTRAINT "CustomerLedgerEntry_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLedgerEntry" ADD CONSTRAINT "CustomerLedgerEntry_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "CustomerSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLedgerEntry" ADD CONSTRAINT "CustomerLedgerEntry_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalUnitHistory" ADD CONSTRAINT "RentalUnitHistory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalUnitHistory" ADD CONSTRAINT "RentalUnitHistory_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalUnitHistory" ADD CONSTRAINT "RentalUnitHistory_sourceSettlementId_fkey" FOREIGN KEY ("sourceSettlementId") REFERENCES "CustomerSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalStatusChange" ADD CONSTRAINT "RentalStatusChange_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data step 1/2: remap legacy CustomerSettlement statuses to the Track A
-- lifecycle (P0 §3b proposal). UPDATE-only; a re-run matches zero rows, so it
-- is idempotent. APPROVED is intentionally untouched: legacy APPROVED was
-- terminal with nothing ever posted, so it must not become POSTED — it flows
-- through approval → processing in A3/A4 instead.
UPDATE "CustomerSettlement" SET "status" = 'PENDING_APPROVAL' WHERE "status" = 'PENDING';
UPDATE "CustomerSettlement" SET "status" = 'CHANGES_REQUESTED' WHERE "status" = 'REJECTED';
-- Legacy Refund rows need no remap: Phase 4 statuses
-- (REQUESTED/APPROVED/REJECTED/PAID) stay displayable read-only in the
-- register (D3); new manual refunds are created on CustomerSettlement (A4).

-- Data step 2/2: seeded-role grants for the new Track A permissions (P0 §4
-- proposal). INSERT-only with ON CONFLICT DO NOTHING — idempotent. Owner gets
-- every new grant; Finance Operator runs the workflow; Finance Approver adds
-- settlement approval + policy edits. Manager keeps its pre-existing
-- move-outs view/update (new grants denied in code via MANAGER_DENY);
-- Viewer keeps its pre-existing move-outs view (transfers/policy hidden in
-- code via VIEWER_HIDDEN); Finance Auditor is unchanged.
INSERT INTO "AdminRolePermission" ("id", "roleId", "permission") VALUES
  ('role_owner_customer_moveouts_create', 'role_owner', 'customer-moveouts:create'),
  ('role_owner_customer_moveouts_approve', 'role_owner', 'customer-moveouts:approve'),
  ('role_owner_customer_transfers_view', 'role_owner', 'customer-transfers:view'),
  ('role_owner_customer_transfers_create', 'role_owner', 'customer-transfers:create'),
  ('role_owner_customer_transfers_update', 'role_owner', 'customer-transfers:update'),
  ('role_owner_settings_moveouts_view', 'role_owner', 'settings-moveouts:view'),
  ('role_owner_settings_moveouts_update', 'role_owner', 'settings-moveouts:update'),
  ('role_finance_operator_customer_moveouts_view', 'role_finance_operator', 'customer-moveouts:view'),
  ('role_finance_operator_customer_moveouts_update', 'role_finance_operator', 'customer-moveouts:update'),
  ('role_finance_operator_customer_transfers_view', 'role_finance_operator', 'customer-transfers:view'),
  ('role_finance_operator_customer_transfers_create', 'role_finance_operator', 'customer-transfers:create'),
  ('role_finance_operator_customer_transfers_update', 'role_finance_operator', 'customer-transfers:update'),
  ('role_finance_operator_settings_moveouts_view', 'role_finance_operator', 'settings-moveouts:view'),
  ('role_finance_approver_customer_moveouts_view', 'role_finance_approver', 'customer-moveouts:view'),
  ('role_finance_approver_customer_moveouts_update', 'role_finance_approver', 'customer-moveouts:update'),
  ('role_finance_approver_customer_moveouts_approve', 'role_finance_approver', 'customer-moveouts:approve'),
  ('role_finance_approver_customer_transfers_view', 'role_finance_approver', 'customer-transfers:view'),
  ('role_finance_approver_customer_transfers_create', 'role_finance_approver', 'customer-transfers:create'),
  ('role_finance_approver_customer_transfers_update', 'role_finance_approver', 'customer-transfers:update'),
  ('role_finance_approver_settings_moveouts_view', 'role_finance_approver', 'settings-moveouts:view'),
  ('role_finance_approver_settings_moveouts_update', 'role_finance_approver', 'settings-moveouts:update')
ON CONFLICT ("roleId", "permission") DO NOTHING;


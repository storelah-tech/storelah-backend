-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "accessRestricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "accessRestrictedAt" TIMESTAMP(3),
ADD COLUMN     "accessRestrictedReason" TEXT;

-- CreateTable
CREATE TABLE "CreditWallet" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "refId" TEXT,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "invoiceId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "computation" JSONB,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "bankVerified" BOOLEAN NOT NULL DEFAULT false,
    "bankRef" TEXT,
    "gatewayRef" TEXT,
    "bypassed" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArrearsCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "branchId" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'OPEN',
    "assignee" TEXT,
    "note" TEXT,
    "policyGated" JSONB,
    "daysOverdue" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArrearsCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LateFeeWaiver" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "branchId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LateFeeWaiver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementImport" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "sourceRef" TEXT NOT NULL,
    "externalRef" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SGD',
    "receivedAt" TIMESTAMP(3),
    "raw" JSONB,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "matchedInvoiceId" TEXT,
    "matchedAmount" DECIMAL(10,2),
    "suspenseReason" TEXT,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationBatch" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "fiscalMonth" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "checklist" JSONB,
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthClose" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "fiscalMonth" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "calcHash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthClose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActualMetric" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "fiscalMonth" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActualMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthCloseAdjustment" (
    "id" TEXT NOT NULL,
    "monthCloseId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthCloseAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VarianceNote" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "fiscalMonth" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VarianceNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditWallet_tenantId_key" ON "CreditWallet"("tenantId");

-- CreateIndex
CREATE INDEX "CreditWallet_branchId_idx" ON "CreditWallet"("branchId");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_walletId_idx" ON "CreditLedgerEntry"("walletId");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_kind_idx" ON "CreditLedgerEntry"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Refund_tenantId_idx" ON "Refund"("tenantId");

-- CreateIndex
CREATE INDEX "Refund_status_idx" ON "Refund"("status");

-- CreateIndex
CREATE INDEX "Refund_branchId_idx" ON "Refund"("branchId");

-- CreateIndex
CREATE INDEX "ArrearsCase_tenantId_idx" ON "ArrearsCase"("tenantId");

-- CreateIndex
CREATE INDEX "ArrearsCase_stage_idx" ON "ArrearsCase"("stage");

-- CreateIndex
CREATE INDEX "ArrearsCase_branchId_idx" ON "ArrearsCase"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "LateFeeWaiver_idempotencyKey_key" ON "LateFeeWaiver"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LateFeeWaiver_tenantId_idx" ON "LateFeeWaiver"("tenantId");

-- CreateIndex
CREATE INDEX "LateFeeWaiver_status_idx" ON "LateFeeWaiver"("status");

-- CreateIndex
CREATE INDEX "LateFeeWaiver_branchId_idx" ON "LateFeeWaiver"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementImport_sourceRef_key" ON "SettlementImport"("sourceRef");

-- CreateIndex
CREATE INDEX "SettlementImport_status_idx" ON "SettlementImport"("status");

-- CreateIndex
CREATE INDEX "SettlementImport_branchId_idx" ON "SettlementImport"("branchId");

-- CreateIndex
CREATE INDEX "ReconciliationBatch_branchId_idx" ON "ReconciliationBatch"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationBatch_branchId_fiscalMonth_key" ON "ReconciliationBatch"("branchId", "fiscalMonth");

-- CreateIndex
CREATE UNIQUE INDEX "MonthClose_branchId_fiscalMonth_key" ON "MonthClose"("branchId", "fiscalMonth");

-- CreateIndex
CREATE INDEX "ActualMetric_branchId_fiscalMonth_idx" ON "ActualMetric"("branchId", "fiscalMonth");

-- CreateIndex
CREATE UNIQUE INDEX "ActualMetric_branchId_fiscalMonth_metric_key" ON "ActualMetric"("branchId", "fiscalMonth", "metric");

-- CreateIndex
CREATE INDEX "MonthCloseAdjustment_monthCloseId_idx" ON "MonthCloseAdjustment"("monthCloseId");

-- CreateIndex
CREATE INDEX "VarianceNote_branchId_fiscalMonth_idx" ON "VarianceNote"("branchId", "fiscalMonth");

-- AddForeignKey
ALTER TABLE "CreditWallet" ADD CONSTRAINT "CreditWallet_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditWallet" ADD CONSTRAINT "CreditWallet_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "CreditWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArrearsCase" ADD CONSTRAINT "ArrearsCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArrearsCase" ADD CONSTRAINT "ArrearsCase_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LateFeeWaiver" ADD CONSTRAINT "LateFeeWaiver_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LateFeeWaiver" ADD CONSTRAINT "LateFeeWaiver_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementImport" ADD CONSTRAINT "SettlementImport_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationBatch" ADD CONSTRAINT "ReconciliationBatch_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthClose" ADD CONSTRAINT "MonthClose_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActualMetric" ADD CONSTRAINT "ActualMetric_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthCloseAdjustment" ADD CONSTRAINT "MonthCloseAdjustment_monthCloseId_fkey" FOREIGN KEY ("monthCloseId") REFERENCES "MonthClose"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VarianceNote" ADD CONSTRAINT "VarianceNote_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

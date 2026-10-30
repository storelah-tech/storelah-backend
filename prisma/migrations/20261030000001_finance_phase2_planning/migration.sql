-- Finance module Phase 2 — Planning workspace (FINANCE_MODULE_SPEC §§11–16).
--
-- Additive only: four brand-new tables (FinancialModel, FinancialModelVersion,
-- Budget, Expense, SizePriceRule — five tables). No drops, no renames, no
-- changes to any existing table. Safe to apply on any branch state.

-- CreateTable
CREATE TABLE "FinancialModel" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "inputs" JSONB NOT NULL,
    "engineVersion" TEXT NOT NULL DEFAULT 'finance-projection/1',
    "inputHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialModelVersion" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changeSummary" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "fiscalMonth" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "budgetId" TEXT,
    "incurredAt" TIMESTAMP(3) NOT NULL,
    "vendor" TEXT,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "receiptRef" TEXT,
    "postedMonth" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizePriceRule" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "targetPsf" DECIMAL(10,4),
    "targetRate" DECIMAL(10,2),
    "authority" TEXT NOT NULL DEFAULT 'SYSTEM',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SizePriceRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialModelVersion_modelId_version_key" ON "FinancialModelVersion"("modelId", "version");
-- CreateIndex
CREATE INDEX "FinancialModelVersion_modelId_status_idx" ON "FinancialModelVersion"("modelId", "status");
-- CreateIndex
CREATE INDEX "FinancialModel_branchId_idx" ON "FinancialModel"("branchId");
-- CreateIndex
CREATE INDEX "FinancialModel_status_idx" ON "FinancialModel"("status");
-- CreateIndex
CREATE UNIQUE INDEX "Budget_branchId_fiscalMonth_category_key" ON "Budget"("branchId", "fiscalMonth", "category");
-- CreateIndex
CREATE INDEX "Budget_branchId_fiscalMonth_idx" ON "Budget"("branchId", "fiscalMonth");
-- CreateIndex
CREATE INDEX "Expense_branchId_incurredAt_idx" ON "Expense"("branchId", "incurredAt");
-- CreateIndex
CREATE INDEX "Expense_branchId_category_idx" ON "Expense"("branchId", "category");
-- CreateIndex
CREATE INDEX "SizePriceRule_branchId_sizeId_idx" ON "SizePriceRule"("branchId", "sizeId");

-- AddForeignKey
ALTER TABLE "FinancialModel" ADD CONSTRAINT "FinancialModel_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialModelVersion" ADD CONSTRAINT "FinancialModelVersion_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "FinancialModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SizePriceRule" ADD CONSTRAINT "SizePriceRule_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SizePriceRule" ADD CONSTRAINT "SizePriceRule_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "UnitSize"("id") ON DELETE CASCADE ON UPDATE CASCADE;

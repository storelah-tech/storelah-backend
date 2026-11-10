-- Lease horizon P4 (additive only): recalculation state on FinancialModel +
-- per-revision calculation rows (FinancialModelVersion snapshots immutable,
-- never rewritten — a stale valuation result is discarded, never applied).

-- AlterTable
ALTER TABLE "FinancialModel" ADD COLUMN "calculationStatus" TEXT NOT NULL DEFAULT 'CURRENT';

-- CreateTable
CREATE TABLE "FinancialModelCalculation" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "modelVersion" INTEGER NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "error" TEXT,
    "idempotencyKey" TEXT,
    "actor" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FinancialModelCalculation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialModelCalculation_modelId_modelVersion_key" ON "FinancialModelCalculation"("modelId", "modelVersion");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialModelCalculation_modelId_idempotencyKey_key" ON "FinancialModelCalculation"("modelId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "FinancialModelCalculation_modelId_status_idx" ON "FinancialModelCalculation"("modelId", "status");

-- AddForeignKey
ALTER TABLE "FinancialModelCalculation" ADD CONSTRAINT "FinancialModelCalculation_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "FinancialModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

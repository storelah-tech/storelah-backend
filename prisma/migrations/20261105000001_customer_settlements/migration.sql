-- Customer settlements (prototype 2026-11-04): transfer / move-out / refund awaiting Finance approval. Additive.
-- CreateTable
CREATE TABLE "CustomerSettlement" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "toUnitId" TEXT,
    "effectiveDate" DATE NOT NULL,
    "channel" TEXT,
    "reason" TEXT,
    "note" TEXT,
    "lines" JSONB NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "adjustment" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSettlement_ref_key" ON "CustomerSettlement"("ref");

-- CreateIndex
CREATE INDEX "CustomerSettlement_tenantId_idx" ON "CustomerSettlement"("tenantId");

-- CreateIndex
CREATE INDEX "CustomerSettlement_status_idx" ON "CustomerSettlement"("status");

-- AddForeignKey
ALTER TABLE "CustomerSettlement" ADD CONSTRAINT "CustomerSettlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "FeeScope" AS ENUM ('GLOBAL', 'FACILITY', 'PRODUCT', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "FeeKind" AS ENUM ('FEE', 'DEPOSIT');

-- CreateTable
CREATE TABLE "FacilityFee" (
    "id" TEXT NOT NULL,
    "kind" "FeeKind" NOT NULL DEFAULT 'FEE',
    "key" TEXT NOT NULL,
    "scope" "FeeScope" NOT NULL DEFAULT 'GLOBAL',
    "branchId" TEXT,
    "sizeId" TEXT,
    "tenantId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "amountKind" TEXT NOT NULL DEFAULT 'FLAT',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacilityFee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessRule" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorFacilityAccess" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "branchId" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'FACILITY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorFacilityAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FacilityFee_kind_key_active_idx" ON "FacilityFee"("kind", "key", "active");

-- CreateIndex
CREATE INDEX "FacilityFee_branchId_idx" ON "FacilityFee"("branchId");

-- CreateIndex
CREATE INDEX "FacilityFee_sizeId_idx" ON "FacilityFee"("sizeId");

-- CreateIndex
CREATE INDEX "FacilityFee_tenantId_idx" ON "FacilityFee"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessRule_key_key" ON "BusinessRule"("key");

-- CreateIndex
CREATE INDEX "BusinessRule_category_idx" ON "BusinessRule"("category");

-- CreateIndex
CREATE INDEX "OperatorFacilityAccess_adminUserId_idx" ON "OperatorFacilityAccess"("adminUserId");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorFacilityAccess_adminUserId_branchId_key" ON "OperatorFacilityAccess"("adminUserId", "branchId");

-- CreateIndex
CREATE INDEX "Permission_adminUserId_idx" ON "Permission"("adminUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_adminUserId_permission_key" ON "Permission"("adminUserId", "permission");

-- AddForeignKey
ALTER TABLE "FacilityFee" ADD CONSTRAINT "FacilityFee_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityFee" ADD CONSTRAINT "FacilityFee_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "UnitSize"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityFee" ADD CONSTRAINT "FacilityFee_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorFacilityAccess" ADD CONSTRAINT "OperatorFacilityAccess_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorFacilityAccess" ADD CONSTRAINT "OperatorFacilityAccess_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

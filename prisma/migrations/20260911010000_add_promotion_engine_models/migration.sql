-- CreateEnum: new enums for promotion engine
CREATE TYPE "PlanKind" AS ENUM ('DISCOUNT_MATRIX', 'FREE_MONTHS', 'PROMO_CODE', 'CREDITS');
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'VALIDATED', 'SCHEDULED', 'ACTIVE', 'ENDED');
CREATE TYPE "PromoStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SCHEDULED', 'ENDED', 'USED');
CREATE TYPE "PromotionBenefitType" AS ENUM ('PERCENTAGE', 'DOLLAR', 'FREE_MONTHS', 'CREDITS');

-- CreateTable: PromotionPlan
CREATE TABLE "PromotionPlan" (
    "id" TEXT NOT NULL,
    "kind" "PlanKind" NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "facilityScope" JSONB NOT NULL DEFAULT '["ALL"]',
    "storageType" TEXT,
    "sizeScope" JSONB NOT NULL DEFAULT '["ALL"]',
    "appliesTo" TEXT,
    "usagePerCustomer" INTEGER,
    "redemptionCap" INTEGER,
    "perUnitApplication" BOOLEAN,
    "stackingRule" TEXT,
    "budgetCap" DECIMAL(12,2),
    "freeMonthCount" INTEGER,
    "commitmentMonths" INTEGER,
    "earlyExitTreatment" TEXT,
    "minStayPct" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PromotionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromotionPlan_code_key" ON "PromotionPlan"("code");
CREATE INDEX "PromotionPlan_kind_idx" ON "PromotionPlan"("kind");
CREATE INDEX "PromotionPlan_status_idx" ON "PromotionPlan"("status");
CREATE INDEX "PromotionPlan_code_idx" ON "PromotionPlan"("code");

-- CreateTable: DiscountMatrixCell
CREATE TABLE "DiscountMatrixCell" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sizeCategory" TEXT NOT NULL,
    "accessType" TEXT NOT NULL,
    "commitmentMonths" INTEGER NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL,
    CONSTRAINT "DiscountMatrixCell_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscountMatrixCell_planId_sizeCategory_accessType_commitmen_key" ON "DiscountMatrixCell"("planId", "sizeCategory", "accessType", "commitmentMonths");
CREATE INDEX "DiscountMatrixCell_planId_idx" ON "DiscountMatrixCell"("planId");

-- AddForeignKey
ALTER TABLE "DiscountMatrixCell" ADD CONSTRAINT "DiscountMatrixCell_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PromotionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: FreeMonthAllocation
CREATE TABLE "FreeMonthAllocation" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "monthIndex" INTEGER NOT NULL,
    "free" BOOLEAN NOT NULL DEFAULT true,
    "discountPct" DECIMAL(5,2),
    CONSTRAINT "FreeMonthAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FreeMonthAllocation_planId_monthIndex_key" ON "FreeMonthAllocation"("planId", "monthIndex");
CREATE INDEX "FreeMonthAllocation_planId_idx" ON "FreeMonthAllocation"("planId");

-- AddForeignKey
ALTER TABLE "FreeMonthAllocation" ADD CONSTRAINT "FreeMonthAllocation_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PromotionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: PromotionRule
CREATE TABLE "PromotionRule" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "groupId" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "PromotionRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromotionRule_planId_idx" ON "PromotionRule"("planId");

-- AddForeignKey
ALTER TABLE "PromotionRule" ADD CONSTRAINT "PromotionRule_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PromotionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: PromotionVersion
CREATE TABLE "PromotionVersion" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedBy" TEXT NOT NULL,
    "changeSummary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromotionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromotionVersion_planId_version_key" ON "PromotionVersion"("planId", "version");
CREATE INDEX "PromotionVersion_planId_idx" ON "PromotionVersion"("planId");

-- AddForeignKey
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PromotionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: SafeguardRule
CREATE TABLE "SafeguardRule" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT,
    "sizeId" TEXT,
    "minEffectiveRate" DECIMAL(10,2) NOT NULL,
    "requiresApprovalAbove" DECIMAL(5,2),
    "approverRole" TEXT,
    CONSTRAINT "SafeguardRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SafeguardRule_facilityId_idx" ON "SafeguardRule"("facilityId");
CREATE INDEX "SafeguardRule_sizeId_idx" ON "SafeguardRule"("sizeId");

-- AddForeignKey
ALTER TABLE "SafeguardRule" ADD CONSTRAINT "SafeguardRule_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SafeguardRule" ADD CONSTRAINT "SafeguardRule_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "UnitSize"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Promotion — add enhanced fields (additive, backward compatible)
ALTER TABLE "Promotion"
    ADD COLUMN "planId" TEXT,
    ADD COLUMN "status" "PromoStatus" DEFAULT 'DRAFT',
    ADD COLUMN "benefitType" "PromotionBenefitType",
    ADD COLUMN "applyTo" TEXT,
    ADD COLUMN "usagePerCustomer" INTEGER,
    ADD COLUMN "redemptionCap" INTEGER,
    ADD COLUMN "perUnitApplication" BOOLEAN,
    ADD COLUMN "stackingRule" TEXT,
    ADD COLUMN "budgetCap" DECIMAL(12,2);

-- CreateIndex (Promotion)
CREATE INDEX "Promotion_planId_idx" ON "Promotion"("planId");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PromotionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
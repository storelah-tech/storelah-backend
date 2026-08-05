-- CreateEnum
CREATE TYPE "PromotionDiscountType" AS ENUM ('PERCENTAGE', 'FLAT');

-- AlterEnum
ALTER TYPE "TenantStatus" ADD VALUE 'INACTIVE';

-- AlterEnum
ALTER TYPE "UnitStatus" ADD VALUE 'INACTIVE';

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "discountType" "PromotionDiscountType" NOT NULL DEFAULT 'PERCENTAGE',
    "discountValue" DECIMAL(10,2) NOT NULL,
    "minMonths" INTEGER,
    "applicableSizeId" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_code_key" ON "Promotion"("code");

-- CreateIndex
CREATE INDEX "Promotion_active_idx" ON "Promotion"("active");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_applicableSizeId_fkey" FOREIGN KEY ("applicableSizeId") REFERENCES "UnitSize"("id") ON DELETE SET NULL ON UPDATE CASCADE;

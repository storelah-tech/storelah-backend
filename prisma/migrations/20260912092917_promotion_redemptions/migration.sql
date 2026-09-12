-- CreateTable
CREATE TABLE "PromotionRedemption" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "bookingId" TEXT,
    "code" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromotionRedemption_planId_idx" ON "PromotionRedemption"("planId");

-- CreateIndex
CREATE INDEX "PromotionRedemption_bookingId_idx" ON "PromotionRedemption"("bookingId");

-- AddForeignKey
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PromotionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

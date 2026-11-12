-- Free-months snapshot on each redemption (billing run skips these months).
ALTER TABLE "PromotionRedemption" ADD COLUMN "freeMonths" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

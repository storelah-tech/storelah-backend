-- Term % snapshot on each DISCOUNT_MATRIX redemption: the billing run applies
-- it to non-free months within the booked term only (owner 2026-11-12).
ALTER TABLE "PromotionRedemption" ADD COLUMN "discountPct" DECIMAL(5,2);

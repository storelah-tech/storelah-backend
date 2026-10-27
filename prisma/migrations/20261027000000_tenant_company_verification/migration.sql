-- Hirer company on Tenant (Business bookings) + Myinfo Business verification
-- stamp. Additive, all nullable — existing rows are untouched.
ALTER TABLE "Tenant" ADD COLUMN "companyName" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "uen" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "companyAddress" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "companyVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "companyVerificationId" TEXT;

-- CMS staff-validation layer on the mock Verification rows (additive-only).
-- Provider `status` (VERIFIED/FAILED) is untouched; `reviewStatus` defaults
-- every row (including all pre-existing mock rows) to PENDING_VALIDATION.
ALTER TABLE "Verification" ADD COLUMN "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING_VALIDATION';

ALTER TABLE "Verification" ADD COLUMN "reviewedAt" TIMESTAMP(3);

ALTER TABLE "Verification" ADD COLUMN "reviewedBy" TEXT;

CREATE INDEX "Verification_reviewStatus_idx" ON "Verification"("reviewStatus");

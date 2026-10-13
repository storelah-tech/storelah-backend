-- Lead identity: canonical columns + normalization backfill (Phases 1-2).
--
-- Adds emailNorm / mobileNorm / leadGroupKey to Lead (all nullable, no
-- UNIQUE — many-rows-per-email history is preserved by design; rows link,
-- never merge). Same-email rows across branches share one identity (global
-- email identity, no branch leg). No row is deleted or rewritten: only the
-- new columns are filled.
--
-- Backfill rules (mirroring normalizeLeadIdentity in src/core/leads.ts):
--   emailNorm  = NULLIF(LOWER(TRIM(email)), '')
--   mobileNorm = digits-only; 8 digits starting 3/6/8/9 get a 65 prefix;
--     65+8 digits kept as-is; fewer than 6 digits -> NULL.
--   leadGroupKey = emailNorm ?? ('phone:' || mobileNorm) ?? NULL, so
--     NULL-email phone-only rows form phone-only groups that never merge
--     into email groups.
ALTER TABLE "Lead" ADD COLUMN "emailNorm" TEXT;

ALTER TABLE "Lead" ADD COLUMN "mobileNorm" TEXT;

ALTER TABLE "Lead" ADD COLUMN "leadGroupKey" TEXT;

-- Canonical email: trim + lowercase; empty/whitespace-only -> NULL.
UPDATE "Lead"
SET "emailNorm" = NULLIF(LOWER(TRIM("email")), '')
WHERE "email" IS NOT NULL;

-- Canonical phone: digits-only with the SG rule; <6 digits -> NULL.
UPDATE "Lead"
SET "mobileNorm" = CASE
  WHEN digits.d IS NULL OR digits.d = '' OR LENGTH(digits.d) < 6 THEN NULL
  WHEN LENGTH(digits.d) = 8 AND digits.d ~ '^[3689]' THEN '65' || digits.d
  ELSE digits.d
END
FROM (SELECT "id", regexp_replace("mobile", '\D', '', 'g') AS d FROM "Lead") AS digits
WHERE "Lead"."id" = digits."id"
  AND "Lead"."mobile" IS NOT NULL;

-- Group key: email wins; phone-only rows key off their normalized phone.
UPDATE "Lead"
SET "leadGroupKey" = CASE
  WHEN "emailNorm" IS NOT NULL THEN "emailNorm"
  WHEN "mobileNorm" IS NOT NULL THEN 'phone:' || "mobileNorm"
  ELSE NULL
END
WHERE "emailNorm" IS NOT NULL OR "mobileNorm" IS NOT NULL;

CREATE INDEX "Lead_emailNorm_idx" ON "Lead"("emailNorm");

CREATE INDEX "Lead_mobileNorm_idx" ON "Lead"("mobileNorm");

CREATE INDEX "Lead_leadGroupKey_idx" ON "Lead"("leadGroupKey");

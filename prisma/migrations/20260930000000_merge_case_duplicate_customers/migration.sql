-- Email-normalization merge (prod fix for case-split duplicate Customers,
-- e.g. agwinthant@gmail.com holding a REGISTERED row plus a mixed-case dup
-- GUEST row that re-asked the user to set up the portal).
--
-- Customer has NO inbound FKs (Booking/Invoice link via Tenant, which keys
-- off its own email column), so deleting the duplicate Customer rows
-- re-points nothing — the merge is: delete the non-canonical GUEST dups,
-- then lowercase the survivors so future writes (now normalized in code —
-- see normalizeEmail in src/core/customers.ts) can never fork again.
-- Tenant.email (no unique constraint) is lowercased in full so the
-- email-keyed reads keep matching.
--
-- Canonical survivor per lowercased email: any non-GUEST row beats GUEST
-- rows; among equals the earliest createdAt (then id) wins. Only GUEST rows
-- are ever deleted — two conflicting non-GUEST rows are left for the
-- operator to resolve, and the final UPDATE skips any row that would collide
-- so this migration can never fail on a unique violation.
DELETE FROM "Customer" AS dup
USING "Customer" AS keep
WHERE LOWER(TRIM(dup."email")) = LOWER(TRIM(keep."email"))
  AND dup."id" <> keep."id"
  AND dup."type" = 'GUEST'
  AND (
    keep."type" <> 'GUEST'
    OR keep."createdAt" < dup."createdAt"
    OR (keep."createdAt" = dup."createdAt" AND keep."id" < dup."id")
  );

-- Lowercase surviving Customer emails, skipping rows that would collide with
-- another row's normalized address (operator resolves those manually).
UPDATE "Customer" AS c
SET "email" = LOWER(TRIM(c."email"))
WHERE c."email" <> LOWER(TRIM(c."email"))
  AND NOT EXISTS (
    SELECT 1 FROM "Customer" AS other
    WHERE other."id" <> c."id"
      AND LOWER(TRIM(other."email")) = LOWER(TRIM(c."email"))
  );

-- Tenant.email carries no unique constraint: normalize every row.
UPDATE "Tenant"
SET "email" = LOWER(TRIM("email"))
WHERE "email" IS NOT NULL
  AND "email" <> LOWER(TRIM("email"));

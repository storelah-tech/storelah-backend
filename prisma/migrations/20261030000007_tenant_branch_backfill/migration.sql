-- F-3: backfill Tenant.branchId from the linked unit's facility.
-- Additive only: no schema change (Tenant.branchId already exists, nullable);
-- fills NULL caches so facility-scoped reads stay fast. The billing run keys
-- off unit.branchId and never depends on this cache alone. Idempotent.
UPDATE "Tenant" t
SET "branchId" = u."branchId"
FROM "Unit" u
WHERE t."unitId" = u."id"
  AND t."branchId" IS NULL
  AND u."branchId" IS NOT NULL;

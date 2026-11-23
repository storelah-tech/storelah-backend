-- Unit size is whole square feet everywhere (owner 2026-11-23). New writes
-- have been rounded since 2026-11-16 (wholeSqft); this rounds legacy decimal
-- rows half-up (numeric round = ties away from zero, same as Math.round for
-- positive areas) so PSF = rate / whole sqft, matching Master Rate Strategy.

-- 1. Re-derive the snapshot PSF of tenants on an affected unit first, while
--    the old decimal sqft is still visible to the WHERE clause.
UPDATE "Tenant" t
SET psf = ROUND(t."monthlyRate" / ROUND(u.sqft::numeric), 2)
FROM "Unit" u
WHERE t."unitId" = u.id
  AND u.sqft::numeric <> ROUND(u.sqft::numeric)
  AND ROUND(u.sqft::numeric) > 0;

-- 2. Round the unit areas.
UPDATE "Unit"
SET sqft = ROUND(sqft::numeric)::double precision
WHERE sqft::numeric <> ROUND(sqft::numeric);

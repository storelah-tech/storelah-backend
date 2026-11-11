-- Data-only: the client's final size list (2026-11-11), in this order:
--   LOCKER "Locker" 8–15 (NEW) · XS "XS" 10–19 · SMALL "S" 20–39 ·
--   MEDIUM "M" 40–69 · LARGE "L" 70–99 · XLBIZ "XL" 100–150 sq ft
-- (codes unchanged; display names per owner "Short: S/M/L/XL")
-- XS..XL follow booking Step 1 (storelah-booking SizeSelector SIZE_TABS).
--
-- Code move: the existing LOCKER row IS booking's XS (10–19), so it is
-- re-coded LOCKER → XS in place — every unit, price rule, fee, safeguard and
-- promotion FK on that row (by id) moves with it, unchanged. A new LOCKER row
-- is then created for the 8–15 Locker. Booking moves its XS tab to code XS.
-- Bands may overlap (LOCKER/XS at 10–15) — tier resolution picks the NEAREST
-- band and ties keep the unit's current size (resolveSizeTier). Existing
-- units are NOT re-tiered here.
UPDATE "UnitSize" SET "code" = 'XS', "name" = 'XS', "updatedAt" = NOW()
WHERE "code" = 'LOCKER' AND NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'XS');

-- String copies of the size code that meant today's LOCKER (= XS) — rewritten
-- in the same migration, only when the re-code above happened (no XS-coded
-- row existed before it ran, i.e. LOCKER-coded copies predate the new Locker).
-- Guarded by the absence of the new LOCKER row, which is created just below.
-- 1) Lead.preferredSize: booking / CMS sent the code 'LOCKER' for its XS tab.
UPDATE "Lead" SET "preferredSize" = 'XS'
WHERE upper("preferredSize") = 'LOCKER'
  AND NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'LOCKER');
-- 2) Floor-plan draft snapshots: placements[].sizeCode / sizeName (display
--    copies; draft restore re-reads live units by id).
UPDATE "FloorPlanDraft" d SET "placements" = (
  SELECT jsonb_agg(CASE WHEN e->>'sizeCode' = 'LOCKER'
                        THEN e || '{"sizeCode":"XS","sizeName":"XS"}'::jsonb ELSE e END ORDER BY i)
  FROM jsonb_array_elements(d."placements") WITH ORDINALITY AS t(e, i)
)
WHERE jsonb_typeof(d."placements") = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(d."placements") e WHERE e->>'sizeCode' = 'LOCKER')
  AND NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'LOCKER');
-- 3) Published public snapshots: placements[].unit.size {code,name} (public
--    reads also refresh units from live rows; kept consistent anyway).
UPDATE "FloorPlan" f SET "publishedSnapshot" = jsonb_set(f."publishedSnapshot", '{placements}', (
  SELECT jsonb_agg(CASE WHEN e #>> '{unit,size,code}' = 'LOCKER'
                        THEN jsonb_set(e, '{unit,size}', '{"code":"XS","name":"XS"}'::jsonb) ELSE e END ORDER BY i)
  FROM jsonb_array_elements(f."publishedSnapshot"->'placements') WITH ORDINALITY AS t(e, i)
))
WHERE jsonb_typeof(f."publishedSnapshot"->'placements') = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(f."publishedSnapshot"->'placements') e WHERE e #>> '{unit,size,code}' = 'LOCKER')
  AND NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'LOCKER');

-- 4) Promotions — Locker and XS are SEPARATE discount rows (owner
--    "Separate row"). Existing LOCKER cells priced today's LOCKER units, i.e.
--    the new XS, so they become XS unchanged; the new LOCKER row starts as a
--    copy of XS (owner edits it later). Same guard as above (runs once, before
--    the new LOCKER size exists).
--    a) legacy XS-variant cells that already have a LOCKER twin are the losing
--       duplicate under the old XS→LOCKER read rule — drop them;
DELETE FROM "DiscountMatrixCell" x
WHERE upper(x."sizeCategory") = 'XS'
  AND EXISTS (SELECT 1 FROM "DiscountMatrixCell" l WHERE l."planId" = x."planId" AND upper(l."sizeCategory") = 'LOCKER'
              AND l."accessType" = x."accessType" AND l."commitmentMonths" = x."commitmentMonths")
  AND NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'LOCKER');
--    b) remaining XS-variant cells → canonical 'XS';
UPDATE "DiscountMatrixCell" SET "sizeCategory" = 'XS'
WHERE upper("sizeCategory") = 'XS' AND "sizeCategory" <> 'XS'
  AND NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'LOCKER');
--    c) LOCKER cells → XS (their meaning: the 10–19 units);
UPDATE "DiscountMatrixCell" SET "sizeCategory" = 'XS'
WHERE upper("sizeCategory") = 'LOCKER'
  AND NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'LOCKER');
--    d) seed the new LOCKER row as a copy of every XS cell;
INSERT INTO "DiscountMatrixCell" ("id", "planId", "sizeCategory", "accessType", "commitmentMonths", "discountPct")
SELECT 'dmc_lk_' || md5(c."id"), c."planId", 'LOCKER', c."accessType", c."commitmentMonths", c."discountPct"
FROM "DiscountMatrixCell" c
WHERE c."sizeCategory" = 'XS'
  AND NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'LOCKER')
ON CONFLICT DO NOTHING;
--    e) plan size scopes naming LOCKER (or XS) cover both rows: same units as
--       before (XS) plus the new Locker that copies XS.
UPDATE "PromotionPlan" p SET "sizeScope" = (
  SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) || '["LOCKER","XS"]'::jsonb
  FROM jsonb_array_elements(p."sizeScope") e
  WHERE upper(e #>> '{}') NOT IN ('LOCKER', 'XS')
)
WHERE jsonb_typeof(p."sizeScope") = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(p."sizeScope") e WHERE upper(e #>> '{}') IN ('LOCKER', 'XS'))
  AND NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'LOCKER');
-- PromotionVersion snapshots are audit history and are left as written.

INSERT INTO "UnitSize" ("id", "code", "name", "sqftFrom", "sqftTo", "widthFt", "heightFt", "sortOrder", "createdAt", "updatedAt")
SELECT 'unitsize_locker_8_15', 'LOCKER', 'Locker', 8, 15, 3, 4, 1, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'LOCKER');

INSERT INTO "UnitSize" ("id", "code", "name", "sqftFrom", "sqftTo", "widthFt", "heightFt", "sortOrder", "createdAt", "updatedAt")
SELECT 'unitsize_xlbiz', 'XLBIZ', 'XL', 100, 150, 10, 12, 6, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'XLBIZ');

UPDATE "UnitSize" SET "name" = 'Locker',      "sqftFrom" = 8,   "sqftTo" = 15,  "sortOrder" = 1, "updatedAt" = NOW() WHERE "code" = 'LOCKER';
UPDATE "UnitSize" SET "name" = 'XS', "sqftFrom" = 10,  "sqftTo" = 19,  "sortOrder" = 2, "updatedAt" = NOW() WHERE "code" = 'XS';
UPDATE "UnitSize" SET "name" = 'S',           "sqftFrom" = 20,  "sqftTo" = 39,  "sortOrder" = 3, "updatedAt" = NOW() WHERE "code" = 'SMALL';
UPDATE "UnitSize" SET "name" = 'M',           "sqftFrom" = 40,  "sqftTo" = 69,  "sortOrder" = 4, "updatedAt" = NOW() WHERE "code" = 'MEDIUM';
UPDATE "UnitSize" SET "name" = 'L',           "sqftFrom" = 70,  "sqftTo" = 99,  "sortOrder" = 5, "updatedAt" = NOW() WHERE "code" = 'LARGE';
UPDATE "UnitSize" SET "name" = 'XL',          "sqftFrom" = 100, "sqftTo" = 150, "sortOrder" = 6, "updatedAt" = NOW() WHERE "code" = 'XLBIZ';

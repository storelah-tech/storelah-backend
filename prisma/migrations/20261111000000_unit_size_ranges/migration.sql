-- Data-only: size-category ranges aligned with booking Step 1 (owner
-- 2026-11-11: "sizes should be the same across booking, cms and everything.
-- Booking has correct data" — storelah-booking SizeSelector.tsx SIZE_TABS).
--   LOCKER (booking tab XS) 10–19 · SMALL 20–39 · MEDIUM 40–69 ·
--   LARGE 70–99 · XLBIZ (booking tab XL) 100–150 sq ft
-- Codes and names are unchanged (booking keys on the codes and shows
-- size.name). Bands may overlap or leave gaps — tier resolution picks the
-- NEAREST band (resolveSizeTier). Existing units are NOT re-tiered here.
UPDATE "UnitSize" SET "sqftFrom" = 10, "sqftTo" = 19,  "updatedAt" = NOW() WHERE "code" = 'LOCKER';
UPDATE "UnitSize" SET "sqftFrom" = 20, "sqftTo" = 39,  "updatedAt" = NOW() WHERE "code" = 'SMALL';
UPDATE "UnitSize" SET "sqftFrom" = 40, "sqftTo" = 69,  "updatedAt" = NOW() WHERE "code" = 'MEDIUM';
UPDATE "UnitSize" SET "sqftFrom" = 70, "sqftTo" = 99,  "updatedAt" = NOW() WHERE "code" = 'LARGE';

-- XLBIZ already exists in booking (tab XL, "Extra large"); create the row where
-- missing so the CMS can assign it. Footprint 10×12 ft (120 sq ft, in band).
INSERT INTO "UnitSize" ("id", "code", "name", "sqftFrom", "sqftTo", "widthFt", "heightFt", "sortOrder", "createdAt", "updatedAt")
SELECT 'unitsize_xlbiz', 'XLBIZ', 'Extra large', 100, 150, 10, 12, 5, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'XLBIZ');
UPDATE "UnitSize" SET "sqftFrom" = 100, "sqftTo" = 150, "updatedAt" = NOW() WHERE "code" = 'XLBIZ';

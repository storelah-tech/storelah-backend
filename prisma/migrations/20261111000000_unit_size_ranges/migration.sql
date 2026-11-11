-- Data-only: owner-defined size-category ranges (2026-11-11). Ranges may
-- overlap or leave gaps (owner: "Locker can overlap, its fine") — tier
-- resolution picks the NEAREST band (resolveSizeTier), so neither blocks.
--   LOCKER 8–15 · SMALL 20–40 · MEDIUM 50–80 · LARGE 100–150 sq ft
-- Codes are unchanged (booking/landing key on them). Footprint dims
-- (widthFt/heightFt) are untouched and already fall inside the new bands.
UPDATE "UnitSize" SET "sqftFrom" = 8,   "sqftTo" = 15,  "updatedAt" = NOW() WHERE "code" = 'LOCKER';
UPDATE "UnitSize" SET "sqftFrom" = 20,  "sqftTo" = 40,  "updatedAt" = NOW() WHERE "code" = 'SMALL';
UPDATE "UnitSize" SET "sqftFrom" = 50,  "sqftTo" = 80,  "updatedAt" = NOW() WHERE "code" = 'MEDIUM';
UPDATE "UnitSize" SET "sqftFrom" = 100, "sqftTo" = 150, "updatedAt" = NOW() WHERE "code" = 'LARGE';

-- Locker category: create it where a database never had one.
INSERT INTO "UnitSize" ("id", "code", "name", "sqftFrom", "sqftTo", "widthFt", "heightFt", "sortOrder", "createdAt", "updatedAt")
SELECT 'unitsize_locker', 'LOCKER', 'Locker', 8, 15, 3, 4, 1, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "UnitSize" WHERE "code" = 'LOCKER');

-- Site type: single-level (default) vs multi-level facility.
ALTER TABLE "Branch" ADD COLUMN "multiLevel" BOOLEAN NOT NULL DEFAULT false;

-- Facilities that already run more than one active floor stay multi-level,
-- so nothing changes for them in booking.
UPDATE "Branch" b
SET "multiLevel" = true
WHERE (SELECT COUNT(*) FROM "Floor" f WHERE f."branchId" = b."id" AND f."isActive") > 1;

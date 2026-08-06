-- Soft-delete lifecycle marker for Unit.
--
-- deletedAt is THE deletion marker: null = active, set = hidden from every read
-- path (lists, map, public, detail) and 404 on direct access. status is a pure
-- business state and is never touched by deletion; INACTIVE remains a valid
-- business status (e.g. a unit taken out of service).
--
-- Backfill: every unit that was previously "deleted" via the old
-- delete = set status INACTIVE convention becomes a properly soft-deleted row.
-- Their status is left as-is (moot once deletedAt filters apply), and updatedAt
-- is a natural "when it was taken out" timestamp.

ALTER TABLE "Unit" ADD COLUMN "deletedAt" TIMESTAMP(3);

UPDATE "Unit" SET "deletedAt" = "updatedAt" WHERE status = 'INACTIVE';

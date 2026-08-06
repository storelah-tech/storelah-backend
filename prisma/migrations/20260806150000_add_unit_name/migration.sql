-- AlterTable: add an optional human-friendly display label to Unit.
-- Nullable on purpose: null/empty means the display name falls back to unitCode
-- (the immutable, auto-generated unique key). No backfill required.
ALTER TABLE "Unit" ADD COLUMN "name" TEXT;

-- Units overhaul: AC / pillar flags + 4-digit code era.
-- Additive only: two NOT NULL WITH DEFAULT columns (no backfill needed —
-- pre-existing rows read false until an operator sets them via PUT /units/:code
-- or the import endpoint). climateControl is KEPT (legacy accept-but-map).
-- unitCode itself is unchanged (TEXT unique) — the 4-digit format is a codegen
-- convention enforced in src/core/units.ts, plus the opt-in rename script
-- scripts/backfill-unit-codes-4digit.ts. No data is renamed by this migration.
ALTER TABLE "Unit" ADD COLUMN "hasAC" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Unit" ADD COLUMN "hasPillar" BOOLEAN NOT NULL DEFAULT false;

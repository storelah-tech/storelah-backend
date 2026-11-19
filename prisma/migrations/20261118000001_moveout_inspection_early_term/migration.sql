-- Track A phase A3 — inspection early-termination charge (D7: entered at
-- inspection; commitment end is shown for reference only and never drives the
-- maths). ADDITIVE ONLY: one new nullable-defaulted Decimal column. No drops,
-- renames, or type changes. Idempotent: a re-run is a plain ADD COLUMN on a
-- migrated DB only when the column is missing — Prisma tracks this migration
-- in _prisma_migrations, so it applies exactly once per database.
ALTER TABLE "MoveOutInspection" ADD COLUMN "earlyTerminationCharge" DECIMAL(10,2) NOT NULL DEFAULT 0;

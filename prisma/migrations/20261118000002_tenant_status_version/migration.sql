-- Track A phase A6 — rental status editor (R5) optimistic locking.
-- ADDITIVE ONLY: one new defaulted Int column on Tenant. No drops, renames,
-- or type changes. Prisma tracks this migration in _prisma_migrations, so it
-- applies exactly once per database.
ALTER TABLE "Tenant" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

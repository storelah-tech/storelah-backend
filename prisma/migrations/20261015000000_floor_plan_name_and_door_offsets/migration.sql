-- Floor-plan names + door offsets (CMS Floor Plan Designer):
-- FloorPlan.name (optional operator label, CMS-only) and
-- UnitPlacement.doorOffsets (JSON door-centre fractions per authored edge,
-- NULL = centred). Both additive + nullable — no backfill, existing rows read
-- NULL.
--
-- *** UNAPPLIED — DO NOT DEPLOY WITHOUT RUNNING `prisma migrate deploy` ***
-- The generated Prisma client already references these columns, so until this
-- migration is applied EVERY plan read/write fails at the database layer
-- (undefined column). Apply with `pnpm db:deploy` (prod, direct URL first)
-- or `pnpm db:migrate` (dev), then redeploy the Lambda. Never db:seed prod
-- (destructive — wipes all tables).

-- AlterTable
ALTER TABLE "FloorPlan" ADD COLUMN "name" TEXT;

-- AlterTable
ALTER TABLE "UnitPlacement" ADD COLUMN "doorOffsets" JSONB;

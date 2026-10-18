/**
 * One-off after migration 20261018000000_floor_plan_published_snapshot (R-FP1):
 * freeze the public view of every ACTIVE floor plan that has no snapshot yet,
 * so the first edit after deploy keeps the plan visible to customers.
 * Idempotent — plans that already have a snapshot are skipped. Public reads
 * also capture lazily, this just closes the window before the first read.
 *
 *   npx tsx scripts/backfill-floorplan-snapshots.ts
 *
 * Runs against DATABASE_URL (local dev .env on :5433; prod needs explicit
 * owner authorization like any prod data change).
 */
import 'dotenv/config';
import { backfillPublishedSnapshots } from '../src/core/floorPlans';
import { prisma } from '../src/lib/prisma';

backfillPublishedSnapshots()
  .then((floors) => {
    console.log(`Captured published snapshots for ${floors.length} ACTIVE floor plan(s).`);
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

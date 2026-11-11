/**
 * RETIRED 2026-11-11 — DO NOT RUN. XS is now its own discount row (Locker
 * 8–15 = LOCKER, XS 10–19 = XS; migration 20261111000000_unit_size_ranges).
 * Merging XS cells into LOCKER would erase the separate row, so main() exits
 * without writing unless --i-know-this-is-retired is passed (kept for history).
 *
 * Backfill XS → LOCKER size references — idempotent, NO re-seed, NO wipes.
 *
 * Context: the discount-matrix builder used XS/S/M/L/XL/XXL size categories
 * while UnitSize codes (and the booking frontend) use LOCKER/SMALL/MEDIUM/
 * LARGE. Canonical write path is now LOCKER (see toCanonicalSizeCategory in
 * src/core/promotionPlans.ts), which also reads legacy XS rows as LOCKER —
 * but stored rows should be migrated so no orphan XS remains.
 *
 * What it does (per database, safe to re-run — re-runs are a no-op):
 *   1. DiscountMatrixCell rows with sizeCategory XS (any case): re-point to
 *      LOCKER. If a LOCKER counterpart already exists for the same
 *      (planId, accessType, commitmentMonths) unique key, the XS duplicate is
 *      deleted (canonical LOCKER wins); otherwise the row is updated.
 *   2. (Removed 2026-11-11 — UnitSize code XS is now a real size, see
 *      migration 20261111000000_unit_size_ranges. UnitSize rows are never
 *      touched.)
 *   3. Asserts zero XS discount-matrix cells remain and exits non-zero
 *      otherwise.
 *
 * PromotionVersion snapshots are audit history and are intentionally left
 * untouched — restore paths re-canonicalize on write.
 *
 * Run against the intended DB (local dev uses .env's DATABASE_URL on :5433):
 *
 *   pnpm db:backfill-matrix-sizes
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();

const XS_VARIANTS = ['XS', 'xs', 'Xs', 'xS'];

async function main() {
  if (!process.argv.includes('--i-know-this-is-retired')) {
    console.log('backfill-matrix-size-categories is retired (XS is a real discount row since 2026-11-11) — nothing written.');
    return;
  }
  // --- 1. DiscountMatrixCell XS → LOCKER ---
  const xsCells = await prisma.discountMatrixCell.findMany({
    where: { sizeCategory: { in: XS_VARIANTS } },
    select: { id: true, planId: true, sizeCategory: true, accessType: true, commitmentMonths: true },
  });
  let updated = 0;
  let deduped = 0;
  for (const cell of xsCells) {
    const counterpart = await prisma.discountMatrixCell.findUnique({
      where: {
        planId_sizeCategory_accessType_commitmentMonths: {
          planId: cell.planId,
          sizeCategory: 'LOCKER',
          accessType: cell.accessType,
          commitmentMonths: cell.commitmentMonths,
        },
      },
      select: { id: true },
    });
    if (counterpart) {
      await prisma.discountMatrixCell.delete({ where: { id: cell.id } });
      deduped++;
    } else {
      await prisma.discountMatrixCell.update({
        where: { id: cell.id },
        data: { sizeCategory: 'LOCKER' },
      });
      updated++;
    }
  }

  // --- 2. (removed 2026-11-11) UnitSize XS is now a REAL size code — the
  // former LOCKER row re-coded by migration 20261111000000_unit_size_ranges
  // (XS 10–19; LOCKER = the new 8–15 Locker). This script must never rename
  // UnitSize rows; only discount-matrix cells are canonicalized (XS → LOCKER
  // discount row, which still covers XS units).
  const sizesRenamed = 0;

  // --- 3. Orphan assertion ---
  const orphanCells = await prisma.discountMatrixCell.count({
    where: { sizeCategory: { in: XS_VARIANTS } },
  });
  const orphanSizes = 0; // UnitSize XS is legitimate since 2026-11-11
  console.log(
    `matrix-size backfill: cells updated=${updated} deduped=${deduped} sizes renamed=${sizesRenamed} orphanXS(cells=${orphanCells}, sizes=${orphanSizes})`,
  );
  if (orphanCells > 0 || orphanSizes > 0) {
    throw new Error(`Orphan XS size references remain (cells=${orphanCells}, sizes=${orphanSizes})`);
  }
}

main()
  .catch((e) => {
    console.error('matrix-size backfill failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

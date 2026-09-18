/**
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
 *   2. UnitSize rows with code XS (any case): renamed to LOCKER (expected to
 *      be zero rows — catalogue seeds are already LOCKER/SMALL/MEDIUM/LARGE;
 *      a collision with an existing LOCKER row aborts with a manual note).
 *   3. Asserts zero XS size references remain (case-insensitive) and exits
 *      non-zero otherwise.
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

  // --- 2. UnitSize code XS → LOCKER (expected: none) ---
  const xsSizes = await prisma.unitSize.findMany({
    where: { code: { in: XS_VARIANTS } },
    select: { id: true, code: true },
  });
  let sizesRenamed = 0;
  for (const s of xsSizes) {
    const locker = await prisma.unitSize.findUnique({ where: { code: 'LOCKER' } });
    if (locker) {
      throw new Error(
        `UnitSize ${s.id} still uses code "${s.code}" and a LOCKER row already exists — repoint its units manually, then re-run.`,
      );
    }
    await prisma.unitSize.update({ where: { id: s.id }, data: { code: 'LOCKER' } });
    sizesRenamed++;
  }

  // --- 3. Orphan assertion ---
  const orphanCells = await prisma.discountMatrixCell.count({
    where: { sizeCategory: { in: XS_VARIANTS } },
  });
  const orphanSizes = await prisma.unitSize.count({
    where: { code: { in: XS_VARIANTS } },
  });
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

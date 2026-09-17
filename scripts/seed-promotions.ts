// Seed the live promo demo code (NOT db:seed — additive and idempotent).
// Upserts a single ACTIVE 10%-off promo with an open date window so
// GET /api/v1/public/promotions lists ≥1 row and
// POST /api/v1/public/promotions/validate validates true in dev.
// Existing rows are never wiped; re-runs only refresh the window/flags.
// Usage: pnpm db:seed-promotions
import { prisma } from '../src/lib/prisma';

async function main() {
  const promo = await prisma.promotion.upsert({
    where: { code: 'STORELAH10' },
    update: {
      name: 'StoreLah launch — 10% off',
      description: 'Demo promo: 10% off the first invoice.',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      active: true,
      status: 'ACTIVE',
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: new Date('2027-12-31T23:59:59Z'),
      applyTo: 'First invoice only',
    },
    create: {
      code: 'STORELAH10',
      name: 'StoreLah launch — 10% off',
      description: 'Demo promo: 10% off the first invoice.',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      active: true,
      status: 'ACTIVE',
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: new Date('2027-12-31T23:59:59Z'),
      applyTo: 'First invoice only',
    },
  });
  console.log(
    `promotions: STORELAH10 ready (id=${promo.id}, active=${promo.active}, status=${promo.status})`,
  );
}

main()
  .catch((e) => {
    console.error('promotions seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

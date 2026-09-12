// Seed 2–3 sensible default safeguard rules (NOT db:seed — additive only).
// Inserts defaults only when the table is empty; never touches other tables.
// Usage: pnpm tsx scripts/seed-safeguards.ts
import { prisma } from '../src/lib/prisma';

async function main() {
  const existing = await prisma.safeguardRule.count();
  if (existing > 0) {
    console.log(`safeguards: ${existing} rule(s) already present — nothing to do`);
    return;
  }
  // 1. Global effective-rate floor: discounts may never push the effective
  //    rate below $80/mo on the representative base.
  await prisma.safeguardRule.create({
    data: {
      facilityId: null,
      sizeId: null,
      minEffectiveRate: 80,
      requiresApprovalAbove: 25,
      approverRole: 'MANAGER',
    },
  });
  // 2. Global high-discount gate: anything above 40% needs Commercial/Finance.
  await prisma.safeguardRule.create({
    data: {
      facilityId: null,
      sizeId: null,
      minEffectiveRate: 0,
      requiresApprovalAbove: 40,
      approverRole: 'COMMERCIAL',
    },
  });
  // 3. Facility-scoped floor for the first branch (if any): a backstop just
  // below the cheapest unit rate (live min is ~$61/mo), so it only trips on
  // giveaway-grade discounts — deliberately NOT above typical discounted
  // medians, otherwise the default would invalidate realistic plans.
  // Falls back to a second global rule when no branches exist (keeps the
  // script runnable on an empty DB).
  const firstBranch = await prisma.branch.findFirst({ orderBy: { code: 'asc' } });
  await prisma.safeguardRule.create({
    data: {
      facilityId: firstBranch ? firstBranch.id : null,
      sizeId: null,
      minEffectiveRate: firstBranch ? 50 : 50,
      requiresApprovalAbove: 30,
      approverRole: firstBranch ? `MANAGER (${firstBranch.code})` : 'MANAGER',
    },
  });
  const count = await prisma.safeguardRule.count();
  console.log(`safeguards: seeded 3 default rules (total ${count})`);
}

main()
  .catch((e) => {
    console.error('safeguards seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

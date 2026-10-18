// Promotion plans: live plans are locked against content edits (R-PR1) and the
// rate-floor safeguard prices the cheapest unit a plan actually discounts
// (PRM-05) — see docs/CMS_FULL_FUNCTIONAL_TEST_PLAN.md §1C.

import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDb, seedMoveInWorld, type MoveInWorld } from './fixtures';
import { createPlan, setPlanStatus, updatePlan, validatePlan } from '../../src/core/promotionPlans';

const today = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
const cell = (discountPct: number, sizeCategory = 'SMALL') => ({ sizeCategory, accessType: 'Standard', commitmentMonths: 6, discountPct });

async function expectAppError(p: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ status, code });
}

async function matrixPlan(pct: number, extra: Record<string, unknown> = {}) {
  return createPlan({ kind: 'DISCOUNT_MATRIX', name: `E2E ${pct}%`, effectiveFrom: today, facilityScope: ['ALL'], matrixCells: [cell(pct)], ...extra } as any);
}

describe('promotion plans — live plans are locked (R-PR1)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('DRAFT and VALIDATED plans accept edits', async () => {
    const p = await matrixPlan(5);
    const v2 = await updatePlan(p.id, { matrixCells: [cell(6)] });
    expect(v2.version).toBe(p.version + 1);
    await setPlanStatus(p.id, 'VALIDATED');
    const v3 = await updatePlan(p.id, { matrixCells: [cell(7)] });
    expect(v3.status).toBe('VALIDATED');
  });

  it('SCHEDULED, ACTIVE and ENDED plans refuse edits with 409 PLAN_LOCKED and stay unchanged', async () => {
    const p = await matrixPlan(5);
    await setPlanStatus(p.id, 'VALIDATED');
    await setPlanStatus(p.id, 'SCHEDULED');
    await expectAppError(updatePlan(p.id, { matrixCells: [cell(35)] }), 409, 'PLAN_LOCKED');
    await setPlanStatus(p.id, 'ACTIVE');
    await expectAppError(updatePlan(p.id, { matrixCells: [cell(35)] }), 409, 'PLAN_LOCKED');
    const cells = await prisma.discountMatrixCell.findMany({ where: { planId: p.id } });
    expect(cells.map((c) => Number(c.discountPct))).toEqual([5]);
    await setPlanStatus(p.id, 'ENDED');
    await expectAppError(updatePlan(p.id, { name: 'renamed' }), 409, 'PLAN_LOCKED');
  });

  it('a SCHEDULED plan moved back to DRAFT is editable again', async () => {
    const p = await matrixPlan(5);
    await setPlanStatus(p.id, 'VALIDATED');
    await setPlanStatus(p.id, 'SCHEDULED');
    await setPlanStatus(p.id, 'DRAFT');
    const edited = await updatePlan(p.id, { matrixCells: [cell(8)] });
    expect(edited.status).toBe('DRAFT');
  });
});

describe('promotion plans — rate floor uses the cheapest discounted unit (PRM-05)', () => {
  let world: MoveInWorld;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
  });

  const floorChecks = async (planId: string) =>
    (await validatePlan(planId)).checks.filter((c) => /Rate floor/.test(c.message));

  it('a discount that keeps the cheapest SMALL unit above the floor passes', async () => {
    // Cheapest AVAILABLE SMALL unit in the world is $120/mo.
    await prisma.safeguardRule.create({ data: { minEffectiveRate: 100 } });
    const p = await matrixPlan(15); // 120 × 0.85 = 102
    const checks = await floorChecks(p.id);
    expect(checks).toMatchObject([{ status: 'pass' }]);
    expect(checks[0].message).toContain('$120/mo');
  });

  it('a discount that takes the cheapest SMALL unit below the floor blocks', async () => {
    await prisma.safeguardRule.create({ data: { minEffectiveRate: 100 } });
    const p = await matrixPlan(20); // 120 × 0.80 = 96 < 100
    const checks = await floorChecks(p.id);
    expect(checks).toMatchObject([{ status: 'blocker' }]);
    expect(checks[0].message).toContain('$96.00');
    expect((await validatePlan(p.id)).valid).toBe(false);
  });

  it('a facility safeguard applies to a plan scoped to that facility by id', async () => {
    const branch = await prisma.branch.findUnique({ where: { id: world.branchId } });
    await prisma.safeguardRule.create({ data: { facilityId: branch!.id, minEffectiveRate: 105 } });
    const p = await matrixPlan(15, { facilityScope: [branch!.id] }); // 102 < 105
    const checks = await floorChecks(p.id);
    expect(checks).toMatchObject([{ status: 'blocker' }]);
    expect(checks[0].message).toContain(`facility ${branch!.code}`);
  });

  it('cells for sizes with no available units skip the floor check', async () => {
    await prisma.safeguardRule.create({ data: { minEffectiveRate: 100 } });
    const p = await createPlan({ kind: 'DISCOUNT_MATRIX', name: 'E2E large', effectiveFrom: today, facilityScope: ['ALL'], matrixCells: [cell(50, 'LARGE')] } as any);
    const checks = await floorChecks(p.id);
    expect(checks).toMatchObject([{ status: 'pass' }]);
    expect(checks[0].message).toContain('no available units');
  });
});

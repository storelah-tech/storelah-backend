// Promotion plans: live plans are locked against content edits (R-PR1) and the
// rate-floor safeguard prices the cheapest unit a plan actually discounts
// (PRM-05) — see docs/CMS_FULL_FUNCTIONAL_TEST_PLAN.md §1C.

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, futureMoveInISO, prisma, resetDb, seedMoveInWorld, uniqueEmail, type MoveInWorld } from './fixtures';
import { createPlan, restoreVersion, setPlanStatus, syncPlanSchedule, updatePlan, validatePlan } from '../../src/core/promotionPlans';

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

// ---------------------------------------------------------------------------
// Owner decisions 2026-10-18: Disable → edit → republish; plans start/end on
// their dates; checkout honours scope + dates; CMS codes and free months
// price real bookings.
// ---------------------------------------------------------------------------

const dayOff = (k: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + k); return d; };

async function walkActive(id: string) {
  await setPlanStatus(id, 'VALIDATED');
  await setPlanStatus(id, 'SCHEDULED');
  return setPlanStatus(id, 'ACTIVE');
}

async function book(unitCode: string, months: number, promoCode?: string) {
  const res = await api.post('/api/v1/customer/bookings').send({
    unitCode, moveInDate: futureMoveInISO(), durationMonths: months,
    email: uniqueEmail(), name: 'E2E Promo', mobile: '81234567', ...(promoCode ? { promoCode } : {}),
  });
  expect(res.status).toBe(201);
  return res.body.data as { bookingRef: string; dueToday: number; breakdown: { base: number; discountPct: number; firstMonthDiscount: number; prorated: number; appliedPromotion: null | { planId: string; kind: string; freeMonths?: number[] } } };
}

describe('promotion plans — Disable → edit → republish', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('an ACTIVE plan is disabled to DRAFT, edited, and published again', async () => {
    const p = await matrixPlan(5);
    await walkActive(p.id);
    await expect(updatePlan(p.id, { matrixCells: [cell(9)] })).rejects.toMatchObject({ status: 409, code: 'PLAN_LOCKED', message: expect.stringContaining('disable it first') });
    const disabled = await setPlanStatus(p.id, 'DRAFT');
    expect(disabled.status).toBe('DRAFT');
    expect(disabled.versions[0].changeSummary).toContain('Disabled');
    await updatePlan(p.id, { matrixCells: [cell(9)] });
    const live = await walkActive(p.id);
    expect(live.status).toBe('ACTIVE');
    expect(live.matrixCells.map((c: { discountPct: number }) => c.discountPct)).toEqual([9]);
  });

  it('restore is refused on a live plan and a same-status PATCH writes no version', async () => {
    const p = await matrixPlan(5);
    const active = await walkActive(p.id);
    await expect(restoreVersion(p.id, 1)).rejects.toMatchObject({ status: 409, code: 'PLAN_LOCKED' });
    const again = await setPlanStatus(p.id, 'ACTIVE');
    expect(again.version).toBe(active.version);
  });
});

describe('promotion plans — schedule sync', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('a future-dated plan cannot go ACTIVE early and activates on its start date', async () => {
    const p = await matrixPlan(5, { effectiveFrom: dayOff(3).toISOString() });
    await setPlanStatus(p.id, 'VALIDATED');
    await setPlanStatus(p.id, 'SCHEDULED');
    await expect(setPlanStatus(p.id, 'ACTIVE')).rejects.toMatchObject({ status: 409, code: 'NOT_YET_EFFECTIVE' });
    expect((await syncPlanSchedule()).activated).toEqual([]);
    expect((await syncPlanSchedule(dayOff(4))).activated).toEqual([p.id]);
    const row = await prisma.promotionPlan.findUnique({ where: { id: p.id }, include: { versions: true } });
    expect(row!.status).toBe('ACTIVE');
    expect(row!.versions.some((v) => v.changedBy === 'Scheduler')).toBe(true);
  });

  it('plans past their end date are ended', async () => {
    const p = await matrixPlan(5, { effectiveTo: dayOff(2).toISOString() });
    await walkActive(p.id);
    expect((await syncPlanSchedule(dayOff(3))).ended).toEqual([p.id]);
    expect((await prisma.promotionPlan.findUnique({ where: { id: p.id } }))!.status).toBe('ENDED');
  });
});

describe('checkout — plan eligibility (scope, dates, floor)', () => {
  let world: MoveInWorld;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
  });

  it('a facility-scoped plan prices only its own facility', async () => {
    const other = await prisma.branch.create({ data: { code: 'XX', name: 'Other', address: 'x', operatingHours: 'x' } });
    const p = await matrixPlan(15, { facilityScope: [other.id] });
    await walkActive(p.id);
    expect((await book(PIN.rentableUnit, 6)).breakdown.discountPct).toBe(0);
    await setPlanStatus(p.id, 'DRAFT');
    await updatePlan(p.id, { facilityScope: [world.branchId] });
    await walkActive(p.id);
    const b = await book(PIN.guestUnit, 6);
    expect(b.breakdown.discountPct).toBe(15);
    expect(b.breakdown.appliedPromotion).toMatchObject({ planId: p.id, kind: 'DISCOUNT_MATRIX' });
  });

  it('a plan outside its dates does not price (even if ACTIVE in the DB)', async () => {
    const p = await matrixPlan(15, { effectiveFrom: dayOff(-10).toISOString(), effectiveTo: dayOff(-1).toISOString() });
    await prisma.promotionPlan.update({ where: { id: p.id }, data: { status: 'ACTIVE' } });
    expect((await book(PIN.rentableUnit, 6)).breakdown.discountPct).toBe(0);
    // …and the lazy sync ended it.
    expect((await prisma.promotionPlan.findUnique({ where: { id: p.id } }))!.status).toBe('ENDED');
  });

  it('a floor-scoped plan prices only units on that floor', async () => {
    const p = await matrixPlan(15, { rules: [{ groupId: 0, field: 'floor', operator: 'equals', value: world.planlessFloorId }] });
    await walkActive(p.id);
    expect((await book(PIN.rentableUnit, 6)).breakdown.discountPct).toBe(0);
  });

  it('the public feed only lists live plans and carries scope', async () => {
    const live = await matrixPlan(15, { facilityScope: [world.branchId] });
    await walkActive(live.id);
    const future = await matrixPlan(20, { effectiveFrom: dayOff(5).toISOString() });
    await setPlanStatus(future.id, 'VALIDATED');
    await setPlanStatus(future.id, 'SCHEDULED');
    const res = await api.get('/api/v1/public/promotion-plans');
    expect(res.body.data.map((x: { id: string }) => x.id)).toEqual([live.id]);
    expect(res.body.data[0]).toMatchObject({ facilities: [PIN.branchCode], floors: null, kind: 'DISCOUNT_MATRIX' });
  });
});

describe('checkout — free months and CMS promo codes', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  async function freePlan(free: number[], extra: Record<string, unknown> = {}) {
    const p = await createPlan({
      kind: 'FREE_MONTHS', name: 'E2E free', effectiveFrom: today, facilityScope: ['ALL'], sizeScope: ['SMALL'],
      freeMonthCount: free.length, commitmentMonths: 12, freeMonths: free.map((i) => ({ monthIndex: i, free: true })), ...extra,
    } as any);
    await walkActive(p.id);
    return p;
  }

  it('month 1 free waives today\'s rent and the free months are recorded', async () => {
    const p = await freePlan([0, 11]);
    const b = await book(PIN.rentableUnit, 12);
    expect(b.breakdown.prorated).toBe(0);
    expect(b.breakdown.appliedPromotion).toMatchObject({ planId: p.id, kind: 'FREE_MONTHS', freeMonths: [1, 12] });
    const red = await prisma.promotionRedemption.findMany({ where: { planId: p.id } });
    expect(red).toHaveLength(1);
    expect(Number(red[0].amount)).toBe(240); // 2 free months × $120
  });

  it('a booking shorter than the commitment gets no free months', async () => {
    await freePlan([0]);
    expect((await book(PIN.rentableUnit, 6)).breakdown.appliedPromotion).toBeNull();
  });

  it('free months vs matrix: the larger total saving wins, never both', async () => {
    const m = await createPlan({ kind: 'DISCOUNT_MATRIX', name: 'E2E 12m', effectiveFrom: today, facilityScope: ['ALL'], matrixCells: [{ sizeCategory: 'SMALL', accessType: 'Standard', commitmentMonths: 12, discountPct: 10 }] } as any);
    await walkActive(m.id); // 10% × 12 months = 1.2 months of rent
    const f = await freePlan([5, 11]); // 2 months of rent → wins
    const b = await book(PIN.rentableUnit, 12);
    expect(b.breakdown.appliedPromotion).toMatchObject({ planId: f.id, kind: 'FREE_MONTHS' });
    expect(b.breakdown.discountPct).toBe(0);
  });

  it('a CMS promo code is redeemable once its plan is ACTIVE, honours caps, and records redemptions', async () => {
    const p = await createPlan({ kind: 'PROMO_CODE', name: 'E2E code', code: 'E2E10', effectiveFrom: today, facilityScope: ['ALL'], sizeScope: ['ALL'], benefitType: 'PERCENTAGE', benefitValue: 10, redemptionCap: 1 } as any);
    expect(p.benefit).toEqual({ type: 'PERCENTAGE', value: 10 });
    const draftCheck = await api.post('/api/v1/public/promotions/validate').send({ code: 'E2E10', rate: 120, months: 6 });
    expect(draftCheck.body.data.valid).toBe(false);
    await walkActive(p.id);
    const ok = await api.post('/api/v1/public/promotions/validate').send({ code: 'E2E10', rate: 120, months: 6, unitCode: PIN.rentableUnit });
    expect(ok.body.data.valid).toBe(true);
    const b1 = await book(PIN.rentableUnit, 6, 'E2E10');
    expect(b1.breakdown.firstMonthDiscount + (b1.breakdown.discountPct > 0 ? 1 : 0)).toBeGreaterThan(0);
    expect(b1.breakdown.appliedPromotion).toMatchObject({ planId: p.id, kind: 'PROMO_CODE' });
    // Cap of 1 reached → second booking pays full price.
    const b2 = await book(PIN.guestUnit, 6, 'E2E10');
    expect(b2.breakdown.appliedPromotion).toBeNull();
    expect(b2.breakdown.firstMonthDiscount).toBe(0);
    expect(await prisma.promotionRedemption.count({ where: { planId: p.id } })).toBe(1);
  });

  it('code plans need a checkout-supported benefit to validate', async () => {
    const p = await createPlan({ kind: 'PROMO_CODE', name: 'E2E credits', code: 'E2ECR', effectiveFrom: today, benefitType: 'CREDITS', benefitValue: 20 } as any);
    const v = await validatePlan(p.id);
    expect(v.checks.some((c) => c.status === 'blocker' && /can't be applied at checkout/.test(c.message))).toBe(true);
  });

  it('a plan code that clashes with a legacy promotion code is refused before saving', async () => {
    await prisma.promotion.create({ data: { code: 'LEGACY1', name: 'Legacy', discountValue: 5 } });
    await expect(createPlan({ kind: 'PROMO_CODE', name: 'Clash', code: 'LEGACY1', effectiveFrom: today, benefitType: 'PERCENTAGE', benefitValue: 5 } as any))
      .rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(await prisma.promotionPlan.count({ where: { name: 'Clash' } })).toBe(0);
  });
});

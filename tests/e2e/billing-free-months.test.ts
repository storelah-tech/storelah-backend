// Billing run × free months (owner 2026-11-12: "free month means $0 for the
// selected months — it supersedes the % discount"; "Fix billing first").
//
// A FREE_MONTHS booking snapshots its free agreement months on the
// redemption; the CMS billing run skips those months (no $0 draft — a zero
// balance can never be issued) and bills every other month at the rate.
// Agreement month 1 (the move-in month) is charged at checkout, so the run
// never bills it again.
import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, futureMoveInISO, prisma, resetDb, seedMoveInWorld, uniqueEmail, type MoveInWorld } from './fixtures';
import { createPlan, setPlanStatus } from '../../src/core/promotionPlans';
import { runBilling } from '../../src/core/finance/billing';
import { previewSettlement } from '../../src/core/customerProfile';

const today = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';

async function walkActive(id: string) {
  await setPlanStatus(id, 'VALIDATED');
  await setPlanStatus(id, 'SCHEDULED');
  return setPlanStatus(id, 'ACTIVE');
}

/** SGT (year, month) of an instant, as the booking app and billing use it. */
function sgtYearMonth(iso: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit' }).formatToParts(new Date(iso));
  return { year: Number(parts.find((p) => p.type === 'year')!.value), month: Number(parts.find((p) => p.type === 'month')!.value) };
}

/** 'YYYY-MM' of agreement month n (1 = the move-in month). */
function agreementMonth(moveIn: { year: number; month: number }, n: number): string {
  const d = new Date(Date.UTC(moveIn.year, moveIn.month - 1 + n - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Guest checkout, then the payment-confirmation effects billing relies on. */
async function bookAndActivate(months: number) {
  const moveInDate = futureMoveInISO();
  const res = await api.post('/api/v1/customer/bookings').send({
    unitCode: PIN.rentableUnit, moveInDate, durationMonths: months,
    email: uniqueEmail(), name: 'E2E Billing', mobile: '81234567',
  });
  expect(res.status).toBe(201);
  const booking = await prisma.booking.findUniqueOrThrow({ where: { bookingRef: res.body.data.bookingRef } });
  await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED' } });
  const tenant = await prisma.tenant.update({ where: { id: booking.tenantId }, data: { status: 'ACTIVE', unitId: booking.unitId } });
  return { booking, tenant, moveIn: sgtYearMonth(moveInDate), breakdown: res.body.data.breakdown };
}

async function runFor(world: MoveInWorld, billingMonth: string) {
  return runBilling({ branchId: world.branchId, billingMonth, actor: 'e2e-finance' });
}

describe('billing run — free months', () => {
  let world: MoveInWorld;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
  });

  it('12-month booking with months 6 & 11 free: those months get no invoice, the rest bill at the rate', async () => {
    const p = await createPlan({
      kind: 'FREE_MONTHS', name: 'Stay 12, Pay 10', effectiveFrom: today, facilityScope: ['ALL'], sizeScope: ['ALL'],
      freeMonthCount: 2, commitmentMonths: 12, freeMonths: [5, 10].map((i) => ({ monthIndex: i, free: true })),
    } as any);
    await walkActive(p.id);
    const { booking, tenant, moveIn, breakdown } = await bookAndActivate(12);
    expect(breakdown.appliedPromotion).toMatchObject({ kind: 'FREE_MONTHS', freeMonths: [6, 11] });
    // Snapshot written at booking time.
    const red = await prisma.promotionRedemption.findFirstOrThrow({ where: { bookingId: booking.id } });
    expect(red.freeMonths).toEqual([6, 11]);
    const rate = Number(tenant.monthlyRate);

    for (let n = 1; n <= 12; n++) {
      const run = await runFor(world, agreementMonth(moveIn, n));
      const mine = run.invoices.filter((i) => i.tenant === tenant.name);
      const skip = run.skipped.find((s) => s.tenant === tenant.name);
      if (n === 1) {
        expect(mine).toHaveLength(0);
        expect(skip?.reason).toMatch(/Move-in month/);
      } else if (n === 6 || n === 11) {
        expect(mine).toHaveLength(0);
        expect(skip?.reason).toBe(`Free month ${n} of 12 (Stay 12, Pay 10) — rent waived, no invoice`);
      } else {
        expect(skip).toBeUndefined();
        expect(mine).toHaveLength(1);
        expect(mine[0].amount).toBe(rate);
        expect(mine[0].lines).toMatchObject([{ kind: 'RENT', amount: rate }]);
      }
    }
    const invoices = await prisma.invoice.findMany({ where: { tenantId: tenant.id, serviceStart: { not: null } } });
    expect(invoices).toHaveLength(9); // months 2–5, 7–10, 12
    expect(invoices.reduce((s, i) => s + Number(i.amount), 0)).toBe(rate * 9);
  });

  it('a booking with no free months bills every month after move-in at the rate (unchanged)', async () => {
    const { tenant, moveIn, breakdown } = await bookAndActivate(6);
    expect(breakdown.appliedPromotion).toBeNull();
    const rate = Number(tenant.monthlyRate);
    for (let n = 2; n <= 6; n++) {
      const run = await runFor(world, agreementMonth(moveIn, n));
      const mine = run.invoices.filter((i) => i.tenant === tenant.name);
      expect(mine).toHaveLength(1);
      expect(mine[0].amount).toBe(rate);
    }
  });

  it('legacy redemptions without the snapshot fall back to the plan months within the booked term', async () => {
    const p = await createPlan({
      kind: 'FREE_MONTHS', name: 'Legacy free', effectiveFrom: today, facilityScope: ['ALL'], sizeScope: ['ALL'],
      freeMonthCount: 1, commitmentMonths: 12, freeMonths: [{ monthIndex: 2, free: true }],
    } as any);
    await walkActive(p.id);
    const { booking, tenant, moveIn } = await bookAndActivate(12);
    await prisma.promotionRedemption.updateMany({ where: { bookingId: booking.id }, data: { freeMonths: [] } });
    const run = await runFor(world, agreementMonth(moveIn, 3));
    expect(run.invoices.filter((i) => i.tenant === tenant.name)).toHaveLength(0);
    expect(run.skipped.find((s) => s.tenant === tenant.name)?.reason).toMatch(/^Free month 3 of 12/);
  });

  it('a manual tenant with no booking still bills as before', async () => {
    const unit = await prisma.unit.findUniqueOrThrow({ where: { unitCode: PIN.guestUnit } });
    const tenant = await prisma.tenant.create({
      data: { name: 'Manual Tenant', unitId: unit.id, monthlyRate: 150, psf: 3, status: 'ACTIVE', branchId: world.branchId, moveInDate: new Date() },
    });
    const run = await runFor(world, agreementMonth(sgtYearMonth(new Date().toISOString()), 1));
    const mine = run.invoices.filter((i) => i.tenant === tenant.name);
    expect(mine).toHaveLength(1);
    expect(mine[0].amount).toBe(150);
  });

  it('moving out during a free month refunds no unused rent (it was never charged); a paid month still refunds', async () => {
    const p = await createPlan({
      kind: 'FREE_MONTHS', name: 'Stay 12, Pay 10', effectiveFrom: today, facilityScope: ['ALL'], sizeScope: ['ALL'],
      freeMonthCount: 2, commitmentMonths: 12, freeMonths: [5, 10].map((i) => ({ monthIndex: i, free: true })),
    } as any);
    await walkActive(p.id);
    const { tenant, moveIn } = await bookAndActivate(12);
    const credit = async (n: number) => {
      const out = await previewSettlement(tenant.id, { kind: 'MOVE_OUT', lastDay: `${agreementMonth(moveIn, n)}-10` });
      return out.lines.find((l) => /Unused rent/.test(l.label))!.amount;
    };
    expect(Math.abs(await credit(6))).toBe(0); // -0 from the credit sign
    expect(await credit(7)).toBeLessThan(0); // refund of the paid month's unused days
  });
});

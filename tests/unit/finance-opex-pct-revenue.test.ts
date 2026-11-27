// Variable (% of revenue) operating-expense categories (e.g. Stripe fees) in
// Budgets & Expenses + Financial Model projections (v1 & v2).

import { describe, expect, it } from 'vitest';
import {
  computeMonthlyNonLeaseOpex,
  hashInput,
  project,
  type ProjectionInput,
} from '../../src/core/finance/projection';
import { defaultModelInputs, normaliseInputs } from '../../src/core/finance/models';
import { upcastInputs } from '../../src/core/finance/leaseTerm';

function makeV1Input(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return normaliseInputs({
    ...defaultModelInputs(),
    ...overrides,
  });
}

function makeV2Input(overrides: Partial<ProjectionInput> = {}, leaseStartDate = '2026-12-01'): ProjectionInput {
  const { startDate: opsStart, ...rest } = overrides;
  const v1 = normaliseInputs({
    ...defaultModelInputs(),
    startDate: leaseStartDate,
    horizonMonths: 12,
    lease: { monthlyByYear: [5000], rentFreeMonths: 0, ufaSqft: 3068 },
    ...rest,
  });
  const v2 = upcastInputs(v1 as unknown as Parameters<typeof upcastInputs>[0]) as unknown as ProjectionInput;
  if (opsStart) v2.startDate = opsStart;
  return normaliseInputs(v2);
}

describe('opex % of revenue — normaliseInputs', () => {
  it('computes baseMonthly from fixed lines only and revenuePctTotal from pct lines', () => {
    const inp = makeV1Input({
      opex: {
        baseMonthly: 9999,
        annualGrowthPct: 0,
        categories: [
          { name: 'Marketing', budget: 500, owner: 'Commercial', note: '' },
          { name: 'Utilities', budget: 300, owner: 'Operations', note: '' },
          { name: 'Stripe transaction fees', budget: 999, basis: 'pct_of_revenue', pctOfRevenue: 3.4, owner: 'Finance', note: 'Card fees' },
        ],
      },
    });
    expect(inp.opex.baseMonthly).toBe(800);
    expect(inp.opex.revenuePctTotal).toBe(3.4);
    const stripe = inp.opex.categories!.find((c) => c.name === 'Stripe transaction fees')!;
    expect(stripe.basis).toBe('pct_of_revenue');
    expect(stripe.pctOfRevenue).toBe(3.4);
    expect(stripe.budget).toBe(0);
  });

  it('omits revenuePctTotal and keeps hash identical when all categories are fixed', () => {
    const a = makeV1Input();
    const b = makeV1Input({
      opex: {
        ...defaultModelInputs().opex,
        categories: defaultModelInputs().opex.categories!.map((c) => ({ ...c, basis: 'fixed' as const })),
      },
    });
    expect(a.opex.revenuePctTotal).toBeUndefined();
    expect(b.opex.revenuePctTotal).toBeUndefined();
    expect(hashInput(a)).toBe(hashInput(b));
  });

  it('rejects out-of-range pctOfRevenue and protected lease names', () => {
    expect(() =>
      makeV1Input({
        opex: {
          baseMonthly: 0,
          annualGrowthPct: 0,
          categories: [{ name: 'Stripe', budget: 0, basis: 'pct_of_revenue', pctOfRevenue: -1 }],
        },
      }),
    ).toThrow(/0 and 100/);

    expect(() =>
      makeV1Input({
        opex: {
          baseMonthly: 0,
          annualGrowthPct: 0,
          categories: [{ name: 'Stripe', budget: 0, basis: 'pct_of_revenue', pctOfRevenue: 105 }],
        },
      }),
    ).toThrow(/0 and 100/);

    expect(() =>
      makeV1Input({
        opex: {
          baseMonthly: 0,
          annualGrowthPct: 0,
          categories: [{ name: 'Landlord rent', budget: 0, basis: 'pct_of_revenue', pctOfRevenue: 5 }],
        },
      }),
    ).toThrow(/reserved for the landlord lease/);
  });
});

describe('opex % of revenue — projection engine (v1 & v2)', () => {
  it('scales Stripe fee with each month revenue in v1 (different cost every month)', () => {
    const fixedOnly = makeV1Input({
      opex: {
        baseMonthly: 1000,
        annualGrowthPct: 0,
        categories: [{ name: 'Utilities', budget: 1000 }],
      },
    });
    const withStripe = makeV1Input({
      opex: {
        baseMonthly: 1000,
        annualGrowthPct: 0,
        categories: [
          { name: 'Utilities', budget: 1000 },
          { name: 'Stripe transaction fees', budget: 0, basis: 'pct_of_revenue', pctOfRevenue: 3.4 },
        ],
      },
    });

    const rFixed = project(fixedOnly);
    const rStripe = project(withStripe);

    expect(rStripe.checks.leaseCountedOnce.pass).toBe(true);
    // Month 1 has low revenue, Month 12 has much higher revenue → Stripe fee increases accordingly.
    const m1 = rStripe.months[0];
    const m12 = rStripe.months[11];
    const expectedM1Fee = Math.round(m1.revenue * 0.034 * 100) / 100;
    const expectedM12Fee = Math.round(m12.revenue * 0.034 * 100) / 100;
    expect(m1.opexNonLease).toBeCloseTo(1000 + expectedM1Fee, 2);
    expect(m12.opexNonLease).toBeCloseTo(1000 + expectedM12Fee, 2);
    expect(m12.opexNonLease).toBeGreaterThan(m1.opexNonLease);
    expect(m12.noi).toBeCloseTo(rFixed.months[11].noi - expectedM12Fee, 2);
  });

  it('does not inflate % of revenue fee by fixed opex annualGrowthPct', () => {
    const inp = makeV1Input({
      opex: {
        baseMonthly: 1000,
        annualGrowthPct: 10,
        categories: [
          { name: 'Utilities', budget: 1000 },
          { name: 'Stripe', budget: 0, basis: 'pct_of_revenue', pctOfRevenue: 3.4 },
        ],
      },
    });
    const r = project(inp);
    const y2Month = r.months[12]; // modelYear = 1 → fixed grows 10% to 1100; Stripe stays 3.4% of revenue
    const expectedVar = Math.round(y2Month.revenue * 0.034 * 100) / 100;
    expect(y2Month.opexNonLease).toBeCloseTo(1100 + expectedVar, 2);
  });

  it('applies prorated revenue naturally in v2 mid-month operational opening and zero pre-opening', () => {
    const inp = makeV2Input({
      startDate: '2027-01-01', // Dec 2026 is full pre-opening (revenue = 0)
      opex: {
        baseMonthly: 1000,
        annualGrowthPct: 0,
        categories: [
          { name: 'Utilities', budget: 1000 },
          { name: 'Stripe transaction fees', budget: 0, basis: 'pct_of_revenue', pctOfRevenue: 3.4 },
        ],
      },
    });
    const r = project(inp);
    const dec = r.months[0]; // pre-opening: revenue = 0 → Stripe fee = 0
    const jan = r.months[1]; // first operational month: revenue > 0 → Stripe fee > 0
    expect(dec.revenue).toBe(0);
    expect(dec.opexNonLease).toBe(1000);
    expect(jan.revenue).toBeGreaterThan(0);
    expect(jan.opexNonLease).toBeCloseTo(1000 + Math.round(jan.revenue * 0.034 * 100) / 100, 2);
    expect(r.checks.leaseCountedOnce.pass).toBe(true);
  });

  it('supports monthly overrideLines containing % of revenue lines', () => {
    const opex = {
      baseMonthly: 1000,
      annualGrowthPct: 0,
      categories: [
        { name: 'Utilities', budget: 1000 },
        { name: 'Stripe', budget: 0, basis: 'pct_of_revenue' as const, pctOfRevenue: 3.4 },
      ],
      overrides: { '2027-03': 1500 },
      overrideLines: {
        '2027-03': [
          { name: 'Utilities', budget: 1500 },
          { name: 'Stripe', budget: 0, basis: 'pct_of_revenue' as const, pctOfRevenue: 2.9 },
        ],
      },
    };
    // 1500 fixed + 2.9% of 10000 = 1790
    expect(computeMonthlyNonLeaseOpex(opex, '2027-03', 0, 1, 1, 10000)).toBe(1790);
    // Non-overridden month uses base 1000 + 3.4% of 10000 = 1340
    expect(computeMonthlyNonLeaseOpex(opex, '2027-04', 0, 1, 1, 10000)).toBe(1340);
  });
});

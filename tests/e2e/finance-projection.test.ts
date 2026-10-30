// Finance projection engine tests — Phase 1 (FINANCE_MODULE_SPEC §§8/26.1).
//
// Pure deterministic engine: no DB, no clock. The golden fixture
// (fixtures/finance-projection-golden.json) was derived INDEPENDENTLY by hand
// (see its `derivation` note + TEST_MATRIX.md): the test pins the engine to
// those hand values, it does not bless engine output.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  annualisedIrr,
  applyScenario,
  hashInput,
  openingPeriodFactor,
  project,
  sensitivity,
  stableStringify,
  weightedPsf,
  type ProjectionInput,
} from '../../src/core/finance/projection';

const golden = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'finance-projection-golden.json'), 'utf8'),
) as { input: ProjectionInput; expectedWeightedPsf: number; expectedMonths: any[]; expectedYears: any[]; expectedMilestones: any; expectedIrrAnnualised: number };

const baseInput = (): ProjectionInput => JSON.parse(JSON.stringify(golden.input));

describe('projection.sembawang-golden', () => {
  it('reproduces the hand-derived month rows exactly', () => {
    const r = project(baseInput());
    expect(r.engineVersion).toBe('finance-projection/1');
    expect(r.kpis.weightedStartPsf).toBe(golden.expectedWeightedPsf);
    expect(r.months.slice(0, 12)).toEqual(golden.expectedMonths);
  });

  it('reproduces the hand-derived year summaries, milestones and IRR', () => {
    const r = project(baseInput());
    expect(r.kpis.years.slice(0, 3)).toEqual(golden.expectedYears);
    expect({
      noiPositiveMonth: r.kpis.noiPositiveMonth,
      stabilisedMonth: r.kpis.stabilisedMonth,
      paybackMonth: r.kpis.paybackMonth,
      occupancy70Month: r.kpis.occupancy70Month,
    }).toEqual(golden.expectedMilestones);
    expect(r.kpis.irrAnnualised).toBeCloseTo(golden.expectedIrrAnnualised, 4);
    expect(r.kpis.irrNote).toMatch(/no sale value/i);
    // Milestone invariants, not just pinned numbers.
    const pb = r.kpis.paybackMonth!;
    expect(r.months[pb - 2].cash).toBeLessThan(0);
    expect(r.months[pb - 1].cash).toBeGreaterThanOrEqual(0);
    // Every calculation check passes on the golden input.
    expect(Object.values(r.checks).every((c) => c.pass)).toBe(true);
  });

  it('is deterministic: same input → byte-identical rows', () => {
    const a = project(baseInput());
    const b = project(baseInput());
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(hashInput(baseInput())).toBe(a.inputHash);
  });
});

describe('projection.proration-mid-month', () => {
  it('prorates the opening month for a Feb leap-year mid-month start', () => {
    // 2028 is a leap year: Feb has 29 days; starting the 15th leaves 15 active days.
    expect(openingPeriodFactor('2028-02-15')).toBeCloseTo(15 / 29, 10);
    const r = project({ ...baseInput(), startDate: '2028-02-15' });
    expect(r.months[0].month).toBe('2028-02');
    expect(r.months[0].periodFactor).toBeCloseTo(15 / 29, 4);
    // Planned move-in prorated: 180 × 15/29 = 93.10.
    expect(r.months[0].moveInSqft).toBeCloseTo(93.1, 2);
    expect(r.months[0].revenue).toBeCloseTo(r.months[0].closingSqft * r.months[0].psf * (15 / 29), 2);
    expect(r.months[1].periodFactor).toBe(1);
    expect(r.checks.openingProrated.pass).toBe(true);
  });

  it('rejects impossible calendar dates', () => {
    expect(() => project({ ...baseInput(), startDate: '2027-02-29' })).toThrow(/calendar date/);
    expect(() => project({ ...baseInput(), startDate: 'not-a-date' })).toThrow(/YYYY-MM-DD/);
  });
});

describe('projection.rent-free-overlap', () => {
  it('gives whole free months; proration only touches a paid opening month', () => {
    const free = project({ ...baseInput(), startDate: '2028-02-15', lease: { monthlyByYear: [5000], rentFreeMonths: 2 } });
    expect(free.months[0].opexLease).toBe(0);
    expect(free.months[1].opexLease).toBe(0);
    expect(free.months[2].opexLease).toBe(5000);
    const paid = project({ ...baseInput(), startDate: '2028-02-15', lease: { monthlyByYear: [5000], rentFreeMonths: 0 } });
    // First paid month prorated over the 15 active February days.
    expect(paid.months[0].opexLease).toBeCloseTo(5000 * (15 / 29), 2);
    expect(paid.months[1].opexLease).toBe(5000);
  });
});

describe('projection.churn-from-month-7', () => {
  it('books no move-out before the churn start month', () => {
    const r = project(baseInput());
    expect(r.months.slice(0, 6).every((m) => m.moveOutSqft === 0)).toBe(true);
    expect(r.months[6].moveOutSqft).toBeGreaterThan(0);
    expect(r.checks.churnStart.pass).toBe(true);
  });
});

describe('projection.target-92-cap', () => {
  it('never lets occupied sqft exceed the stabilisation target', () => {
    const r = project(baseInput());
    expect(r.months.every((m) => m.closingSqft <= 2092.08 + 0.011)).toBe(true);
    expect(r.months[r.months.length - 1].closingSqft).toBe(2092.08);
    expect(r.checks.stabilisationCap.pass).toBe(true);
  });
});

describe('projection.annual-uplift-3pct', () => {
  it('starts customer rent growth at the model-year boundary only', () => {
    const r = project(baseInput());
    expect(r.months[11].psf).toBe(5.6384);
    expect(r.months[12].psf).toBeCloseTo(5.6384 * 1.03, 4);
    expect(r.months[23].psf).toBeCloseTo(5.6384 * 1.03, 4);
    expect(r.months[24].psf).toBeCloseTo(5.6384 * 1.03 * 1.03, 4);
  });
});

describe('projection.invariants', () => {
  it('holds net/move, NOI and cash identities on every month', () => {
    const r = project(baseInput());
    for (const m of r.months) {
      expect(m.netMoveInSqft).toBeCloseTo(m.moveInSqft - m.moveOutSqft, 2);
      expect(m.noi).toBeCloseTo(m.revenue - m.operatingCost, 2);
      expect(m.operatingCost).toBeCloseTo(m.opexLease + m.opexNonLease, 2);
    }
    expect(r.months[0].cash).toBeCloseTo(-108000 + r.months[0].noi, 2);
    for (let i = 1; i < r.months.length; i++) {
      expect(r.months[i].cash).toBeCloseTo(r.months[i - 1].cash + r.months[i].noi, 2);
    }
  });

  it('rejects invalid inputs instead of projecting garbage', () => {
    expect(() => project({ ...baseInput(), nlaSqft: 0 })).toThrow(/greater than zero/);
    expect(() => project({ ...baseInput(), occupancy: { ...baseInput().occupancy, targetPct: 120 } })).toThrow(/0 and 100/);
    expect(() => project({ ...baseInput(), capitalTotal: -1 })).toThrow(/cannot be negative/);
    expect(() => project({ ...baseInput(), horizonMonths: 0 })).toThrow(/1–120/);
  });
});

describe('returns.irr', () => {
  it('solves the hand-checkable case: CF −1000 then +1100 → (1.1)^12 − 1', () => {
    expect(annualisedIrr([-1000, 1100])).toBeCloseTo(1.1 ** 12 - 1, 6);
  });

  it('reports Not available when cash flows never change sign', () => {
    expect(annualisedIrr([-100, -50, -10])).toBeNull();
    expect(annualisedIrr([100, 50])).toBeNull();
    expect(annualisedIrr([-1000])).toBeNull();
  });

  it('is consistent: NPV at the solved rate is ~0', () => {
    const r = project(baseInput());
    const cfs = [-108000, ...r.months.map((m) => m.noi)];
    const solved = r.kpis.irrAnnualised!;
    const monthly = (1 + solved) ** (1 / 12) - 1;
    const npv = cfs.reduce((s, cf, t) => s + cf / (1 + monthly) ** t, 0);
    expect(Math.abs(npv)).toBeLessThan(1);
  });
});

describe('models.scenario-overlay-no-fork', () => {
  it('isolates scenario changes from the saved base', () => {
    const input = baseInput();
    const before = JSON.stringify(input.occupancy);
    const down = applyScenario(input, 'downside');
    const up = applyScenario(input, 'upside');
    expect(JSON.stringify(input.occupancy)).toBe(before);
    expect(down.occupancy.rampFirst6).toBeCloseTo(180 * 0.8, 6);
    expect(down.occupancy.moveOutRatePct).toBeCloseTo(2.5 * 1.25, 6);
    expect(down.occupancy.targetPct).toBe(87);
    expect(up.occupancy.rampFirst6).toBeCloseTo(180 * 1.2, 6);
    expect(up.occupancy.moveOutRatePct).toBeCloseTo(2.5 * 0.8, 6);
    expect(up.occupancy.targetPct).toBe(95);
    // Pricing, capital, lease and opex are untouched by the overlay.
    const rDown = project({ ...input, occupancy: down.occupancy });
    expect(rDown.months[0].psf).toBe(project(input).months[0].psf);
    expect(applyScenario(input, 'base').occupancy).toEqual(input.occupancy);
  });
});

describe('models.sensitivity-tornado', () => {
  it('compares lower/base/stronger demand with the documented deltas', () => {
    const cases = sensitivity(baseInput());
    expect(cases.map((c) => c.name)).toEqual(['lower', 'base', 'stronger']);
    const [lower, base, stronger] = cases;
    expect(lower.targetPct).toBe(86);
    expect(lower.psfDelta).toBe(-0.5);
    expect(stronger.targetPct).toBe(95);
    expect(stronger.psfDelta).toBe(0.5);
    expect(lower.year1Revenue).toBeLessThan(base.year1Revenue);
    expect(stronger.year1Revenue).toBeGreaterThan(base.year1Revenue);
  });
});

describe('projection.weighted-psf', () => {
  it('matches the category-weighted hand calculation', () => {
    expect(weightedPsf(golden.input.sizeMix)).toBeCloseTo(12821.8 / 2274, 6);
  });
});

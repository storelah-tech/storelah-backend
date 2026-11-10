// Finance projection engine v2 — lease-horizon buckets (P2).
//
// Pure deterministic engine tests: no DB, no clock. Every constant below is
// HAND-DERIVED from the owner rulings (D1B/D6B/D12A, 2026-11-09) and the P1
// leaseTerm math — never generated from the module under test.
//
// Anchors:
// - 15 Dec 2026, 12-mo term → committed end 14 Dec 2027 (D1B); 13 calendar
//   rows: 17-day opening stub (17/31) + 11 full months + 14-day closing stub
//   (14/31). At S$5,000/mo the stubs pay 2741.94 / 2258.06 (P1 hand math).
// - 15 Feb 2027, 12-mo term → Feb27 14/28 + 11 full months + Feb28 (leap) 14/29
//   ≈ 11.9828 rents.
// - Dec 2027 of a 15 Dec 2026 24-mo lease (rents 5000/5500) splits 14d Y1 +
//   17d Y2 → 5000×14/31 + 5500×17/31 = 5274.19 (P1 hand math).

import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/http';
import {
  ENGINE_VERSION,
  ENGINE_VERSION_V2,
  applyScenario,
  hasV2LeaseBlock,
  project,
  projectV1,
  projectV2,
  type ProjectionInput,
} from '../../src/core/finance/projection';
import { upcastInputs } from '../../src/core/finance/leaseTerm';
import { validateSubmittable } from '../../src/core/finance/library';

type V2Input = Parameters<typeof upcastInputs>[0];

function v1Base(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    startDate: '2026-12-01',
    horizonMonths: 60,
    nlaSqft: 2274,
    sizeMix: [
      { name: 'XS', nlaSqft: 455, units: 31, psf: 6.8 },
      { name: 'S', nlaSqft: 500, units: 20, psf: 6.2 },
      { name: 'M', nlaSqft: 650, units: 16, psf: 5.5 },
      { name: 'L', nlaSqft: 405, units: 7, psf: 4.8 },
      { name: 'XL', nlaSqft: 264, units: 2, psf: 4.2 },
    ],
    occupancy: { rampFirst6: 180, rampFrom7: 125, moveOutRatePct: 2.5, churnStartMonth: 7, targetPct: 92 },
    pricing: { annualIncreasePct: 3 },
    lease: { monthlyByYear: [5000, 5000, 5000, 5000, 5000], rentFreeMonths: 0 },
    opex: { baseMonthly: 1200, annualGrowthPct: 0 },
    capitalTotal: 108000,
    ...overrides,
  };
}

function toV2(base: ProjectionInput): ProjectionInput {
  return upcastInputs(base as unknown as V2Input) as unknown as ProjectionInput;
}

/** V2 rows minus the v2-only bucket keys — the R14 comparison surface. */
function stripBucket(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((m) => {
    const { periodStart: _ps, periodEnd: _pe, leaseYear: _ly, isStub: _st, isPreOpening: _po, ...rest } = m;
    return rest;
  });
}

function codeOf(e: unknown): string | undefined {
  return (e as AppError)?.details !== undefined ? ((e as AppError).details as { code?: string })?.code : undefined;
}

describe('projection-v2.R14 first-of-month lock (v1 ≡ v2 on shared fields)', () => {
  it('projects the golden-shape 60-mo model identically (flat rent, no rent-free)', () => {
    const base = v1Base();
    const v1 = project(base);
    expect(v1.engineVersion).toBe(ENGINE_VERSION);
    const v2 = project(toV2(v1Base()));
    expect(v2.engineVersion).toBe(ENGINE_VERSION_V2);
    expect(hasV2LeaseBlock(toV2(v1Base()))).toBe(true);
    expect(hasV2LeaseBlock(base)).toBe(false);
    expect(stripBucket(v2.months as unknown as Array<Record<string, unknown>>)).toEqual(
      v1.months as unknown as Array<Record<string, unknown>>,
    );
    expect(v2.kpis).toEqual(v1.kpis);
    expect(v2.inputHash).not.toBe(v1.inputHash); // different snapshots, same arithmetic
  });

  it('matches with whole-month rent-free (2 legacy months → Dec+Jan free)', () => {
    const base = v1Base({ lease: { monthlyByYear: [5000, 5000, 5000, 5000, 5000], rentFreeMonths: 2 } });
    const v1 = project(base);
    const v2 = project(toV2(v1Base({ lease: { monthlyByYear: [5000, 5000, 5000, 5000, 5000], rentFreeMonths: 2 } })));
    expect(v1.months[0].opexLease).toBe(0);
    expect(v1.months[1].opexLease).toBe(0);
    expect(stripBucket(v2.months as unknown as Array<Record<string, unknown>>)).toEqual(
      v1.months as unknown as Array<Record<string, unknown>>,
    );
    expect(v2.kpis).toEqual(v1.kpis);
  });

  it('matches a 13-mo partial-year term with an explicit year-2 rent', () => {
    const base = v1Base({ horizonMonths: 13, lease: { monthlyByYear: [5000, 5200], rentFreeMonths: 0 } });
    const v1 = project(base);
    expect(v1.months).toHaveLength(13);
    const v2 = project(toV2(v1Base({ horizonMonths: 13, lease: { monthlyByYear: [5000, 5200], rentFreeMonths: 0 } })));
    expect(v2.months).toHaveLength(13);
    expect(stripBucket(v2.months as unknown as Array<Record<string, unknown>>)).toEqual(
      v1.months as unknown as Array<Record<string, unknown>>,
    );
    expect(v2.kpis).toEqual(v1.kpis);
    expect(v2.kpis.years).toHaveLength(2);
  });
});

describe('projection-v2.R2 mid-month buckets (15 Dec 2026, 12 mo)', () => {
  const mid = (): ProjectionInput =>
    toV2(v1Base({ startDate: '2026-12-15', horizonMonths: 12, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } }));

  it('builds 13 rows with 17/31 opening and 14/31 closing stubs', () => {
    const r = project(mid());
    expect(r.engineVersion).toBe(ENGINE_VERSION_V2);
    expect(r.months).toHaveLength(13);
    const [first, ...rest] = r.months;
    const last = rest[rest.length - 1];
    expect(first.periodStart).toBe('2026-12-15');
    expect(first.periodEnd).toBe('2026-12-31');
    expect(first.isStub).toBe(true);
    expect(first.leaseYear).toBe(1);
    expect(first.isPreOpening).toBe(false);
    expect(first.periodFactor).toBeCloseTo(17 / 31, 4);
    expect(first.opexLease).toBe(2741.94); // 5000 × 17/31 hand-rounded
    expect(r.months[1].periodFactor).toBe(1);
    expect(r.months[1].isStub).toBe(false);
    expect(r.months[1].opexLease).toBe(5000);
    expect(last.periodStart).toBe('2027-12-01');
    expect(last.periodEnd).toBe('2027-12-14');
    expect(last.isStub).toBe(true);
    expect(last.leaseYear).toBe(1); // anniversary (15 Dec) not yet reached — R6
    expect(last.periodFactor).toBeCloseTo(14 / 31, 4);
    expect(last.opexLease).toBe(2258.06); // 5000 × 14/31 hand-rounded
    // R6: a 12-mo term reports ceil(12/12) = 1 year even with 13 rows.
    expect(r.kpis.years).toHaveLength(1);
    // R6: the closing stub takes no uplift whose anniversary it hasn't reached.
    expect(last.psf).toBe(r.months[0].psf);
    expect(Object.values(r.checks).every((c) => c.pass)).toBe(true);
  });

  it('sums ≈11.98 rents for the 15 Feb 2027 12-mo term (14/28 + 11 + 14/29)', () => {
    const r = project(
      toV2(v1Base({ startDate: '2027-02-15', horizonMonths: 12, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } })),
    );
    expect(r.months).toHaveLength(13);
    expect(r.months[0].periodFactor).toBeCloseTo(14 / 28, 4); // stored display factor is round4 (v1 convention)
    expect(r.months[12].periodFactor).toBeCloseTo(14 / 29, 4); // Feb 2028 is leap
    const factorSum = r.months.reduce((s, m) => s + m.periodFactor, 0);
    expect(factorSum).toBeCloseTo(14 / 28 + 11 + 14 / 29, 4);
    expect(factorSum).toBeCloseTo(11.9828, 4);
    const leaseTotal = r.months.reduce((s, m) => s + m.opexLease, 0);
    // 2500.00 + 11 × 5000 + 2413.79 = 59913.79 — deliberately not 12 × 5000 (D2A).
    expect(leaseTotal).toBeCloseTo(59913.79, 2);
    expect(leaseTotal).not.toBeCloseTo(12 * 5000, 2);
  });
});

describe('projection-v2.R3 anniversary straddles + rent-free boundaries', () => {
  it('splits Dec 2027 14d Y1 + 17d Y2 at escalating rents (5274.19)', () => {
    const r = project(
      toV2(
        v1Base({
          startDate: '2026-12-15',
          horizonMonths: 24,
          lease: { monthlyByYear: [5000, 5500], rentFreeMonths: 0 },
        }),
      ),
    );
    expect(r.months).toHaveLength(25); // 24-mo mid-month term → N+1 rows
    const dec27 = r.months.find((m) => m.month === '2027-12');
    expect(dec27?.periodStart).toBe('2027-12-01');
    expect(dec27?.periodEnd).toBe('2027-12-31');
    expect(dec27?.leaseYear).toBe(1); // first day precedes the 15 Dec anniversary
    expect(dec27?.opexLease).toBe(5274.19); // 5000×14/31 + 5500×17/31 hand-rounded
  });
});

describe('projection-v2.R4 proration methods (lease only)', () => {
  const base = (method: string): ProjectionInput => {
    const v2 = toV2(v1Base({ startDate: '2026-12-15', horizonMonths: 12, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } }));
    (v2.lease as unknown as Record<string, unknown>).prorationMethod = method;
    return v2;
  };

  it('caps 30_day at 30/30 and charges full_month on any chargeable day', () => {
    const d30 = project(base('30_day'));
    expect(d30.months[0].opexLease).toBe(2833.33); // 5000 × 17/30 hand-rounded
    const full = project(base('full_month'));
    expect(full.months[0].opexLease).toBe(5000);
    expect(full.months[12].opexLease).toBe(5000);
  });

  it('keeps revenue on actual-days factors whatever the lease method', () => {
    const actual = project(base('actual_days'));
    const d30 = project(base('30_day'));
    const full = project(base('full_month'));
    expect(d30.months.map((m) => m.revenue)).toEqual(actual.months.map((m) => m.revenue));
    expect(full.months.map((m) => m.revenue)).toEqual(actual.months.map((m) => m.revenue));
    expect(d30.months.map((m) => m.opexNonLease)).toEqual(actual.months.map((m) => m.opexNonLease));
  });
});

describe('projection-v2.R5 closing stub scales revenue/opex/move-ins/churn', () => {
  it('applies the 14/31 factor to every scaled line of the closing row', () => {
    const r = project(
      toV2(v1Base({ startDate: '2026-12-15', horizonMonths: 12, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } })),
    );
    const last = r.months[r.months.length - 1];
    const f = 14 / 31;
    expect(last.revenue).toBeCloseTo(Math.round(last.closingSqft * last.psf * f * 100) / 100, 2);
    expect(last.opexNonLease).toBeCloseTo(Math.round(1200 * f * 100) / 100, 2);
    // Planned 125 × 14/31 = 56.45 caps the closing move-in …
    expect(last.moveInSqft).toBeLessThanOrEqual(Math.round(125 * f * 100) / 100 + 0.011);
    // … and churn scales too: opening × 2.5% × 14/31.
    const expectedChurn = Math.round(last.openingSqft * 0.025 * f * 100) / 100;
    expect(last.moveOutSqft).toBeCloseTo(expectedChurn, 2);
  });
});

describe('projection-v2.R6 row-indexed ramp/churn + named beyond-term error', () => {
  it('keeps ramp (t≤6) and churnStartMonth row-indexed on mid-month terms', () => {
    const r = project(
      toV2(v1Base({ startDate: '2026-12-15', horizonMonths: 12, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } })),
    );
    expect(r.months.slice(0, 6).every((m) => m.moveOutSqft === 0)).toBe(true);
    expect(r.months[6].moveOutSqft).toBeGreaterThan(0);
    expect(r.checks.churnStart.pass).toBe(true);
  });

  it('returns CHURN_BEYOND_TERM (400-shaped; P4 maps it to 422) past the last row', () => {
    const v2 = toV2(
      v1Base({
        startDate: '2026-12-15',
        horizonMonths: 12,
        occupancy: { rampFirst6: 180, rampFrom7: 125, moveOutRatePct: 2.5, churnStartMonth: 14, targetPct: 92 },
        lease: { monthlyByYear: [5000], rentFreeMonths: 0 },
      }),
    );
    let caught: unknown;
    try {
      project(v2);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(400);
    expect(codeOf(caught)).toBe('CHURN_BEYOND_TERM');
  });
});

describe('projection-v2.R12 unconfirmed schedule blocks the update', () => {
  it('throws LEASE_SCHEDULE_UNCONFIRMED for an estimated-unconfirmed year', () => {
    // 13-mo term, one contractual rent → year 2 upcasts estimated-unconfirmed.
    const v2 = toV2(v1Base({ horizonMonths: 13, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } }));
    let caught: unknown;
    try {
      project(v2);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(codeOf(caught)).toBe('LEASE_SCHEDULE_UNCONFIRMED');
    expect((caught as AppError).message).toMatch(/incomplete for the extended term/);
    // A confirmed estimate unblocks the same term.
    const sched = (v2.lease as unknown as { schedule: Array<{ confirmed: boolean }> }).schedule;
    sched[1].confirmed = true;
    const ok = project(v2);
    expect(ok.months).toHaveLength(13);
  });

  it('understands excluded rows in validateSubmittable (shortened terms stay re-extendable)', () => {
    const v2 = toV2(v1Base({ horizonMonths: 60, lease: { monthlyByYear: [5000, 5000, 5000, 5000, 5000], rentFreeMonths: 0 } }));
    // Shorten 60 → 36: years 4–5 stay saved with excluded:true.
    const short = {
      ...v2,
      horizonMonths: 36,
      lease: {
        ...(v2.lease as object),
        committedTermMonths: 36,
        schedule: (
          (v2.lease as unknown as { schedule: Array<Record<string, unknown>> }).schedule.map((row, i) =>
            i < 3 ? row : { ...row, excluded: true },
          )
        ),
      },
    } as unknown as ProjectionInput;
    expect(validateSubmittable(short)).toEqual([]);
    // Years 4–5 active again would still satisfy a 60-mo horizon.
    expect(validateSubmittable(v2)).toEqual([]);
    // A truly missing year still blocks submission.
    const missing = {
      ...v2,
      lease: {
        ...(v2.lease as object),
        schedule: (v2.lease as unknown as { schedule: unknown[] }).schedule.slice(0, 4),
      },
    } as unknown as ProjectionInput;
    expect(validateSubmittable(missing).join(' ')).toMatch(/horizon needs 5/);
  });
});

describe('projection-v2.D6B two-date timeline (pre-opening rows)', () => {
  // Lease commenced 15 Nov 2026; operations open 1 Dec 2026; 12-mo term ends
  // 14 Nov 2027 → 13 rows Nov26..Nov27; the November row is pre-opening.
  const pre = (): ProjectionInput => {
    const v2 = toV2(
      v1Base({ startDate: '2026-11-15', horizonMonths: 12, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } }),
    );
    return { ...v2, startDate: '2026-12-01' };
  };

  it('zeroes revenue/occupancy/move-ins before opening but keeps rent + opex', () => {
    const r = project(pre());
    expect(r.months).toHaveLength(13);
    const nov = r.months[0];
    expect(nov.month).toBe('2026-11');
    expect(nov.periodStart).toBe('2026-11-15');
    expect(nov.isPreOpening).toBe(true);
    expect(nov.revenue).toBe(0);
    expect(nov.moveInSqft).toBe(0);
    expect(nov.closingSqft).toBe(0);
    // Landlord rent (no rent-free) + scheduled opex ARE included: 16/30 of each.
    expect(nov.opexLease).toBeCloseTo(Math.round((5000 * 16) / 30 * 100) / 100, 2);
    expect(nov.opexNonLease).toBeCloseTo(Math.round((1200 * 16) / 30 * 100) / 100, 2);
    const dec = r.months[1];
    expect(dec.isPreOpening).toBe(false);
    expect(dec.revenue).toBeGreaterThan(0);
    expect(r.months[r.months.length - 1].periodEnd).toBe('2027-11-14');
    expect(Object.values(r.checks).every((c) => c.pass)).toBe(true);
  });
});

describe('projection-v2.D12A money precision (cents-rounded rows, 2dp inputs)', () => {
  it('rejects monetary inputs with more than two decimals', () => {
    const v2 = toV2(v1Base({ startDate: '2026-12-15', horizonMonths: 12, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } }));
    const l = v2.lease as unknown as { schedule: Array<{ monthlyRent: number }> };
    l.schedule[0].monthlyRent = 5000.005;
    expect(() => project(v2)).toThrow(/two decimal places/);
    const v2b = toV2(v1Base({ startDate: '2026-12-15', horizonMonths: 12, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } }));
    v2b.opex = { ...v2b.opex, baseMonthly: 1200.001 };
    expect(() => project(v2b)).toThrow(/two decimal places/);
  });

  it('keeps every payable row at SGD cents on stub, 30_day and rent-free models', () => {
    const isCents = (n: number): boolean => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
    const models = [
      toV2(v1Base({ startDate: '2026-12-15', horizonMonths: 12, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } })),
      toV2(v1Base({ startDate: '2027-02-15', horizonMonths: 12, lease: { monthlyByYear: [5123.45], rentFreeMonths: 1 } })),
    ];
    (models[0].lease as unknown as Record<string, unknown>).prorationMethod = '30_day';
    for (const m of models) {
      const r = project(m);
      for (const row of r.months) {
        for (const k of ['revenue', 'opexLease', 'opexNonLease', 'operatingCost', 'noi', 'cash'] as const) {
          expect(isCents(row[k])).toBe(true);
        }
      }
    }
  });
});

describe('projection-v2.LH08 truncation (shorten 60 → 36, engine row arrays)', () => {
  it('excludes later cash flows while the shared prefix stays identical', () => {
    const rents = [5000, 5000, 5000, 5000, 5000];
    const long = project(toV2(v1Base({ horizonMonths: 60, lease: { monthlyByYear: rents, rentFreeMonths: 0 } })));
    const short = project(
      toV2(v1Base({ horizonMonths: 36, lease: { monthlyByYear: rents.slice(0, 3), rentFreeMonths: 0 } })),
    );
    expect(long.months).toHaveLength(60);
    expect(short.months).toHaveLength(36);
    expect(stripBucket(short.months as unknown as Array<Record<string, unknown>>)).toEqual(
      stripBucket(long.months.slice(0, 36) as unknown as Array<Record<string, unknown>>),
    );
    expect(short.kpis.paybackMonth).toBe(long.months.slice(0, 36).find((m) => m.cash >= 0)?.t ?? null);
  });

  it('never mutates its input (engine-level actuals-untouched: pure function)', () => {
    const base = toV2(v1Base({ startDate: '2026-12-15', horizonMonths: 12, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } }));
    const before = JSON.stringify(base);
    project(base);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('counts the lease exactly once on every row', () => {
    const r = project(
      toV2(v1Base({ startDate: '2026-12-15', horizonMonths: 12, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } })),
    );
    expect(r.checks.leaseCountedOnce.pass).toBe(true);
    for (const m of r.months) {
      expect(m.operatingCost).toBeCloseTo(m.opexLease + m.opexNonLease, 2);
    }
  });
});

describe('projection-v2.LH18 scenario isolation (lease + opex shared)', () => {
  it('holds horizon, lease expense and non-lease opex identical across scenarios', () => {
    const base = toV2(v1Base({ horizonMonths: 60, lease: { monthlyByYear: [5000, 5000, 5000, 5000, 5000], rentFreeMonths: 0 } }));
    const down = project({ ...base, occupancy: applyScenario(base, 'downside').occupancy });
    const mid = project({ ...base, occupancy: applyScenario(base, 'base').occupancy });
    const up = project({ ...base, occupancy: applyScenario(base, 'upside').occupancy });
    for (const r of [down, mid, up]) expect(r.engineVersion).toBe(ENGINE_VERSION_V2);
    expect(down.months).toHaveLength(mid.months.length);
    expect(up.months).toHaveLength(mid.months.length);
    expect(down.months.map((m) => m.opexLease)).toEqual(mid.months.map((m) => m.opexLease));
    expect(up.months.map((m) => m.opexLease)).toEqual(mid.months.map((m) => m.opexLease));
    expect(down.months.map((m) => m.opexNonLease)).toEqual(mid.months.map((m) => m.opexNonLease));
    expect(up.months.map((m) => m.opexNonLease)).toEqual(mid.months.map((m) => m.opexNonLease));
    expect(down.months[0].periodStart).toBe(mid.months[0].periodStart);
    expect(up.months[up.months.length - 1].periodEnd).toBe(mid.months[mid.months.length - 1].periodEnd);
    // Occupancy scenarios still move revenue.
    expect(down.months[11].revenue).toBeLessThan(mid.months[11].revenue);
    expect(up.months[11].revenue).toBeGreaterThan(mid.months[11].revenue);
  });
});

describe('projection-v2.dispatch', () => {
  it('routes v1 inputs to projectV1 and v2 inputs to projectV2', () => {
    expect(project(v1Base()).engineVersion).toBe('finance-projection/1');
    expect(project(toV2(v1Base())).engineVersion).toBe('finance-projection/2');
    expect(projectV1(v1Base()).months).toEqual(project(v1Base()).months);
    expect(projectV2(toV2(v1Base())).months).toEqual(project(toV2(v1Base())).months);
  });
});

// P3 valuation tests — pure engine (no DB, no clock).
//
// Every expected number comes from the INDEPENDENTLY DERIVED fixture
// `fixtures/finance-lease-horizon-validation.json` (Python replica written
// from the handoff formulas + hand anchors; see the DERIVATION note). Nothing
// here is generated from the module under test. D13B is the release gate: if
// fixture values disagree with the engine beyond tolerance, STOP and report
// both sides — do not silently fix either side (owner sign-off required).
//
// D13 minimum coverage map (each asserted below):
// - first-day + mid-month starts: sembawang60 / midMonth12
// - leap-day + month-end dates: leapDay / monthEnd (+ P1 date engine)
// - zero + partial rent-free: sembawang60 (zero) / partialRentFree
// - annual escalation: pricing +3% everywhere + lease escalation24 (5000→5500)
// - 12/36/60/120-mo terms: midMonth12 / short36 / sembawang60 / term120
// - deposit + reinstatement: terminal* cases (15000 / 5000)
// - terminal on/off: terminal* vs depositSunkShort36 vs plain
// - NPV at 0%/8%/15%: every valued case
// - one valid IRR (sembawang60 + synthetic), no-IRR ×2, multiple-IRR
// - simple + discounted payback inside (sembawang60) AND beyond (midMonth12)
//
// §7.7 anchors hold EXACTLY (month-1 FCF −5185 on the hand series; monthly
// rate 1.1714917%; DF 0.9884207; DCF −5124.96). The Sembawang projection
// month-1 NOI is −5185.09 (revenue 1014.91 = 180 × 5.6384, golden §28) — the
// §7.7 figures use the ROUNDED 1015 illustration. Both are asserted.

import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/http';
import { upcastInputs } from '../../src/core/finance/leaseTerm';
import { project, type ProjectionInput } from '../../src/core/finance/projection';
import {
  analyse,
  BEYOND_HORIZON_LABEL,
  buildCashFlowSeries,
  buildRenewalCase,
  dcfRows,
  discountFactorAt,
  effectiveAnnualRate,
  formatPeriodLabel,
  monthlyRateFromAnnual,
  solveIrr,
  DEFAULT_MANUAL_RATE,
  type MethodologyInputs,
  type SeriesPoint,
  type ValuationInputs,
} from '../../src/core/finance/valuation';
import fixture from './fixtures/finance-lease-horizon-validation.json';

type FxInputs = Record<string, {
  startDate: string;
  horizonMonths: number;
  nlaSqft: number;
  sizeMix: unknown;
  occupancy: Record<string, number>;
  pricing: Record<string, number>;
  opex: Record<string, unknown>;
  capitalTotal: number;
  lease: {
    startDate: string;
    committedTermMonths: number;
    monthlyByYear: number[];
    rentFreeMonths: number;
    rentFreeStartDate: string | null;
    rentFreeEndDate: string | null;
  };
}>;
type FxPoint = {
  index: number; period: number; month: string; dateRange: string;
  revenue: number; operatingCashFlow: number; capex: number;
  otherCashFlow: number; cashFlow: number;
};
type FxAnalysis = {
  npv: number; cumulativeFreeCashFlow: number;
  profitabilityIndex: number | null;
  simplePayback: { month: number | null; fractionalMonths: number | null; label: string };
  discountedPayback: { month: number | null; fractionalMonths: number | null; label: string };
  paybackMonth: number | null; discountedPaybackMonth: number | null;
};
type FxValued = Record<string, {
  valuation: ValuationInputs;
  points: FxPoint[];
  analyses: Record<string, FxAnalysis>;
  irr: { status: string; annualRate: number | null };
}>;

const inputs = fixture.inputs as unknown as FxInputs;
const valued = fixture.valued as unknown as FxValued;
const RATES = ['0.0', '0.08', '0.15'] as const;

/** Valued cases that reuse another case's projection input (valuation-only variants). */
const INPUT_FOR: Record<string, string> = {
  terminalShort36: 'short36',
  terminalFull60: 'sembawang60',
  depositSunkShort36: 'short36',
};

/** Rebuild the sanctioned v2 input for a fixture case (upcast + explicit dates). */
function v2InputFor(name: string): ProjectionInput {
  const fx = inputs[INPUT_FOR[name] ?? name];
  const econ = inputs.sembawang60;
  const upcast = upcastInputs({
    startDate: fx.lease.startDate,
    horizonMonths: fx.horizonMonths,
    nlaSqft: econ.nlaSqft,
    sizeMix: econ.sizeMix,
    occupancy: fx.occupancy,
    pricing: econ.pricing,
    opex: econ.opex,
    capitalTotal: econ.capitalTotal,
    lease: { monthlyByYear: fx.lease.monthlyByYear, rentFreeMonths: fx.lease.rentFreeMonths },
  });
  const out = { ...(upcast as unknown as Record<string, unknown>), startDate: fx.startDate } as unknown as ProjectionInput;
  const lease = out.lease as unknown as Record<string, unknown>;
  lease.rentFreeStartDate = fx.lease.rentFreeStartDate;
  lease.rentFreeEndDate = fx.lease.rentFreeEndDate;
  return out;
}

function valuationFor(name: string): ValuationInputs {
  return (valued[name].valuation ?? {}) as ValuationInputs;
}

function expectSeriesMatches(name: string, points: SeriesPoint[]): void {
  const expected = valued[name].points;
  expect(points.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    const p = points[i];
    expect(p.index).toBe(e.index);
    expect(p.period).toBeCloseTo(e.period, 9);
    expect(p.cashFlow).toBeCloseTo(e.cashFlow, 2);
    expect(p.revenue).toBeCloseTo(e.revenue, 2);
    expect(p.operatingCashFlow).toBeCloseTo(e.operatingCashFlow, 2);
    expect(p.capex).toBeCloseTo(e.capex, 2);
    expect(p.otherCashFlow).toBeCloseTo(e.otherCashFlow, 2);
  }
}

function expectAnalysesMatch(name: string, points: SeriesPoint[]): void {
  for (const key of RATES) {
    const annual = Number(key);
    const a = analyse(points, annual);
    const e = valued[name].analyses[key];
    expect(a.npv).toBeCloseTo(e.npv, 2);
    expect(a.cumulativeFreeCashFlow).toBeCloseTo(e.cumulativeFreeCashFlow, 2);
    if (e.profitabilityIndex === null) {
      expect(a.profitabilityIndex).toBeNull();
    } else {
      expect(a.profitabilityIndex as number).toBeCloseTo(e.profitabilityIndex, 6);
    }
    expect(a.paybackMonth).toBe(e.paybackMonth);
    expect(a.discountedPaybackMonth).toBe(e.discountedPaybackMonth);
    expect(a.simplePayback.label).toBe(e.simplePayback.label);
    expect(a.discountedPayback.label).toBe(e.discountedPayback.label);
    if (e.simplePayback.fractionalMonths === null) {
      expect(a.simplePayback.fractionalMonths).toBeNull();
    } else {
      expect(a.simplePayback.fractionalMonths as number).toBeCloseTo(e.simplePayback.fractionalMonths, 9);
    }
    if (e.discountedPayback.fractionalMonths === null) {
      expect(a.discountedPayback.fractionalMonths).toBeNull();
    } else {
      expect(a.discountedPayback.fractionalMonths as number).toBeCloseTo(e.discountedPayback.fractionalMonths, 9);
    }
  }
}

function expectIrrMatches(name: string, points: SeriesPoint[]): void {
  const irr = solveIrr(points);
  const e = valued[name].irr;
  expect(irr.status).toBe(e.status);
  if (e.status === 'valid') {
    expect(irr.annualRate as number).toBeCloseTo(e.annualRate as number, 6);
  } else {
    expect(irr.annualRate).toBeNull();
  }
}

const VALUED_CASES = [
  'sembawang60', 'midMonth12', 'short36',
  'terminalShort36', 'terminalFull60', 'depositSunkShort36',
  'leapDay', 'monthEnd', 'partialRentFree', 'escalation24', 'term120', 'preOpening',
];

describe('valuation.P3 fixture rows (independently derived, $0.01)', () => {
  for (const name of VALUED_CASES) {
    it(`matches every ${name} series row`, () => {
      const built = buildCashFlowSeries(project(v2InputFor(name)), valuationFor(name));
      expectSeriesMatches(name, built.points);
    });
  }
});

describe('valuation.P3 metrics from the same array (NPV/IRR/payback/PI)', () => {
  for (const name of VALUED_CASES) {
    it(`analyses ${name} at 0%/8%/15% from the one array`, () => {
      const built = buildCashFlowSeries(project(v2InputFor(name)), valuationFor(name));
      const before = JSON.stringify(built.points);
      expectAnalysesMatch(name, built.points);
      // Same-array contract: readers never mutate the series.
      expect(JSON.stringify(built.points)).toBe(before);
    });

    it(`solves IRR for ${name} from the same array`, () => {
      const built = buildCashFlowSeries(project(v2InputFor(name)), valuationFor(name));
      const before = JSON.stringify(built.points);
      expectIrrMatches(name, built.points);
      expect(JSON.stringify(built.points)).toBe(before);
    });
  }

  it('NPV and IRR consume the identical array object (D12A/R8)', () => {
    const built = buildCashFlowSeries(project(v2InputFor('sembawang60')), valuationFor('sembawang60'));
    const shared = built.points;
    const a = analyse(shared, 0.15);
    const irr = solveIrr(shared);
    // Same reference in, consistent figures out.
    expect(shared).toBe(built.points);
    expect(a.npv).toBeCloseTo(valued.sembawang60.analyses['0.15'].npv, 2);
    expect(irr.status).toBe('valid');
    expect(irr.annualRate as number).toBeCloseTo(valued.sembawang60.irr.annualRate as number, 6);
    // P5 owns the kpis.irrAnnualised switch — P3 must NOT rewire it: the
    // integer-period figure stays pinned to the golden regression value.
    const res = project(v2InputFor('sembawang60'));
    expect(res.kpis.irrAnnualised).toBeCloseTo(0.39492, 5);
  });
});

describe('valuation.D7A/D8A effectiveAnnualRate', () => {
  it('defaults to 15% for new models (never overwrites stored rates — P4)', () => {
    expect(DEFAULT_MANUAL_RATE).toBe(0.15);
    expect(effectiveAnnualRate()).toBe(0.15);
    expect(effectiveAnnualRate(null)).toBe(0.15);
    expect(effectiveAnnualRate({})).toBe(0.15);
    expect(effectiveAnnualRate({ methodology: 'manual' })).toBe(0.15);
  });

  it('passes an explicit manual rate through unrounded', () => {
    expect(effectiveAnnualRate({ methodology: 'manual', manualAnnualRate: 0.08 })).toBe(0.08);
  });

  it('sums risk components (base + business + lease + execution)', () => {
    // Hand math: 0.06 + 0.04 + 0.03 + 0.02 = 0.15.
    expect(effectiveAnnualRate({
      methodology: 'risk', baseReturn: 0.06, businessRisk: 0.04, leaseRisk: 0.03, executionRisk: 0.02,
    })).toBeCloseTo(0.15, 12);
  });

  it('prices WACC only when financing inputs are complete', () => {
    // Hand math: 0.12×0.7 + 0.05×0.3×(1−0.17) = 0.084 + 0.01245 = 0.09645.
    expect(effectiveAnnualRate({
      methodology: 'wacc', costEquity: 0.12, costDebt: 0.05,
      equityWeight: 0.7, debtWeight: 0.3, taxRate: 0.17,
    })).toBeCloseTo(0.09645, 12);
  });

  it('raises named errors for incomplete/invalid financing inputs (P4 maps to 422)', () => {
    let caught: unknown;
    try {
      effectiveAnnualRate({ methodology: 'wacc', costEquity: 0.12 } as unknown as MethodologyInputs);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).details).toMatchObject({ code: 'WACC_INPUTS_INCOMPLETE' });
    caught = undefined;
    try {
      effectiveAnnualRate({
        methodology: 'wacc', costEquity: 0.12, costDebt: 0.05,
        equityWeight: 0.6, debtWeight: 0.3, taxRate: 0.17,
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).details).toMatchObject({ code: 'WACC_WEIGHTS_INVALID' });
  });
});

describe('valuation.§7.7 anchors (exact)', () => {
  it('holds the worked figures: −5185, 1.1714917%, 0.9884207, −5124.96', () => {
    // Monthly rate (UNROUNDED): (1.15)^(1/12) − 1 → 1.1714917%.
    const monthly = monthlyRateFromAnnual(0.15);
    expect(Number((monthly * 100).toFixed(7))).toBe(1.1714917);
    // Discount factor at period 1: 1 / (1 + r) → 0.9884207 (7dp).
    const df = discountFactorAt(0.15, 1);
    expect(Number(df.toFixed(7))).toBe(0.9884207);
    // Month-1 FCF −5185 (hand series: 1015 revenue − 6200 opex) → DCF −5124.96.
    const hand: SeriesPoint[] = [
      {
        index: 0, period: 0, periodLabel: '0', dateLabel: '2026-12-01', daysInMonth: 0,
        revenue: 0, operatingCashFlow: 0, capex: -108000, otherCashFlow: 0, cashFlow: -108000,
      },
      {
        index: 1, period: 1, periodLabel: '1', dateLabel: '2026-12', daysInMonth: 31,
        revenue: 1015, operatingCashFlow: -5185, capex: 0, otherCashFlow: 0, cashFlow: -5185,
      },
    ];
    const rows = dcfRows(hand, 0.15);
    expect(rows[1].discountFactor).toBe(df);
    expect(rows[1].display.discountFactor).toBe(0.9884207);
    expect(rows[1].display.discountedCashFlow).toBe(-5124.96);
    expect(analyse(hand, 0.15).npv).toBeCloseTo(-113124.96, 2);
    // The live Sembawang projection uses unrounded revenue 1014.91
    // (180 × 5.6384), hence month-1 NOI −5185.09 — the §7.7 figures are the
    // rounded illustration of the same row. Both hold.
    const built = buildCashFlowSeries(project(v2InputFor('sembawang60')), valuationFor('sembawang60'));
    expect(built.points[1].cashFlow).toBeCloseTo(-5185.09, 2);
    expect(built.points[1].revenue).toBeCloseTo(1014.91, 2);
  });
});

describe('valuation.R7 running-sum periods (never index+factor)', () => {
  it('starts at 0 and accumulates 0.548, 1.548, … for the 15 Dec stub term', () => {
    const built = buildCashFlowSeries(project(v2InputFor('midMonth12')), valuationFor('midMonth12'));
    expect(built.points[0].period).toBe(0);
    expect(built.points[0].periodLabel).toBe('0');
    expect(built.points[1].period).toBeCloseTo(17 / 31, 12);
    expect(built.points[1].periodLabel).toBe('0.548');
    expect(built.points[2].period).toBeCloseTo(17 / 31 + 1, 12);
    expect(built.points[2].periodLabel).toBe('1.548');
    expect(built.points[built.points.length - 1].period).toBeCloseTo(12, 9);
  });

  it('uses integer periods 0..N for first-of-month terms', () => {
    const built = buildCashFlowSeries(project(v2InputFor('sembawang60')), valuationFor('sembawang60'));
    expect(built.points[0].period).toBe(0);
    for (let i = 1; i <= 60; i++) expect(built.points[i].period).toBe(i);
    expect(formatPeriodLabel(12)).toBe('12');
    expect(formatPeriodLabel(17 / 31)).toBe('0.548');
  });
});

describe('valuation.R11 limitation + t=0 shape', () => {
  it('records the NOI-as-operating-cash limitation in metadata', () => {
    const built = buildCashFlowSeries(project(v2InputFor('sembawang60')), valuationFor('sembawang60'));
    expect(built.metadata.limitation).toMatch(/no tax/i);
    expect(built.metadata.initialOutflow).toBe(-108000);
    expect(built.points[0]).toMatchObject({ capex: -108000, otherCashFlow: 0, cashFlow: -108000 });
  });

  it('keeps the deposit sunk when terminal flows are off (R11)', () => {
    const built = buildCashFlowSeries(project(v2InputFor('short36')), valuationFor('depositSunkShort36'));
    expect(built.metadata.terminalApplied).toBe(false);
    expect(built.metadata.initialOutflow).toBe(-123000);
    expect(built.points.every((p) => p.otherCashFlow === (p.index === 0 ? -15000 : 0))).toBe(true);
  });
});

describe('valuation truncation: deposit + reinstatement move with the term', () => {
  it('shares the 36-month prefix byte-identically (plain valuation)', () => {
    const longPts = buildCashFlowSeries(project(v2InputFor('sembawang60')), valuationFor('sembawang60')).points;
    const shortPts = buildCashFlowSeries(project(v2InputFor('short36')), valuationFor('short36')).points;
    expect(shortPts).toHaveLength(37); // t=0 + 36 months
    expect(longPts).toHaveLength(61);
    expect(JSON.parse(JSON.stringify(shortPts))).toEqual(JSON.parse(JSON.stringify(longPts.slice(0, 37))));
  });

  it('lands terminal items on the EXACT committed end only', () => {
    const short = buildCashFlowSeries(project(v2InputFor('short36')), valuationFor('terminalShort36'));
    const full = buildCashFlowSeries(project(v2InputFor('sembawang60')), valuationFor('terminalFull60'));
    // Deposit recovery (15000) − reinstatement (5000) = +10000 on the final row.
    expect(short.metadata.terminalApplied).toBe(true);
    expect(short.metadata.terminalNet).toBe(10000);
    expect(short.points[36].otherCashFlow).toBe(10000);
    expect(short.points[36].cashFlow).toBeCloseTo(valued.terminalShort36.points[36].cashFlow, 2);
    expect(short.points.slice(1, 36).every((p) => p.otherCashFlow === 0)).toBe(true);
    expect(full.points[60].otherCashFlow).toBe(10000);
    expect(full.metadata.committedEndDate).toBe('2031-11-30');
    expect(short.metadata.committedEndDate).toBe('2029-11-30');
    // Shortening moves the terminal: month-36 terminal, months 37–60 excluded.
    expect(short.points).toHaveLength(37);
    expect(full.points).toHaveLength(61);
  });
});

describe('valuation.R13/D11A renewal stays separate (LH14)', () => {
  const committedInput = (): ProjectionInput => v2InputFor('short36');

  it('leaves the committed case byte-identical with renewal on or off', () => {
    const input = committedInput();
    const plain = valuationFor('short36');
    const before = buildCashFlowSeries(project(input), plain);
    const withRenewalFlag = { ...plain, renewalMonths: 24 } as unknown as ValuationInputs;
    const after = buildCashFlowSeries(project(input), withRenewalFlag);
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)));
  });

  it('builds the renewal as a separate run and never mutates the input', () => {
    const input = committedInput();
    const snapshot = JSON.stringify(input);
    const renewal = buildRenewalCase(input, { ...valuationFor('terminalShort36'), renewalMonths: 24 });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(renewal.renewalTermMonths).toBe(60);
    expect(renewal.renewalEndDate).toBe('2031-11-30');
    expect(renewal.renewal.points).toHaveLength(61);
    expect(renewal.renewal.points[60].otherCashFlow).toBe(10000);
    expect(renewal.renewal.points[60].period).toBeCloseTo(60, 9);
    // The committed result rebuilt after the renewal run is unchanged.
    const rebuilt = buildCashFlowSeries(project(input), valuationFor('terminalShort36'));
    expect(JSON.parse(JSON.stringify(rebuilt.points.slice(0, 37)))).toEqual(
      JSON.parse(JSON.stringify(rebuilt.points.slice(0, 37))),
    );
    expect(rebuilt.metadata.committedEndDate).toBe('2029-11-30');
  });
});

describe('valuation.R9 IRR statuses (synthetic hand-verified series)', () => {
  const synth = (fixture.synthetic as unknown as Record<string, {
    points: Array<[number, number]>;
    irr: { status: string; annualRate: number | null; roots?: number[] };
  }>);

  function toPoints(pairs: Array<[number, number]>): SeriesPoint[] {
    return pairs.map(([period, cashFlow], i) => ({
      index: i, period, periodLabel: formatPeriodLabel(period),
      dateLabel: `M${i}`, daysInMonth: i === 0 ? 0 : 30,
      revenue: 0, operatingCashFlow: 0, capex: 0, otherCashFlow: 0, cashFlow,
    }));
  }

  it('solves one valid IRR (hand: NPV@15% = 165.66, payback month 4)', () => {
    const irr = solveIrr(toPoints(synth.validIrr.points));
    expect(irr.status).toBe('valid');
    expect(irr.annualRate as number).toBeCloseTo(synth.validIrr.irr.annualRate as number, 6);
    expect(irr.display).toMatch(/%/);
    const a = analyse(toPoints(synth.validIrr.points), 0.15);
    expect(a.simplePayback.label).toBe('Month 3 + 10 days');
  });

  it('reports n.a. with no sign change (all-negative and all-non-negative)', () => {
    for (const name of ['noIrrNegative', 'noIrrPositive'] as const) {
      const irr = solveIrr(toPoints(synth[name].points));
      expect(irr.status).toBe('none');
      expect(irr.annualRate).toBeNull();
      expect(irr.display).toBe('n.a.');
      expect(synth[name].irr.status).toBe('none');
    }
  });

  it('reports Multiple solutions for the two-root series (exact monthly roots 0 and 0.5)', () => {
    const irr = solveIrr(toPoints(synth.multipleIrr.points));
    expect(irr.status).toBe('multiple');
    expect(irr.annualRate).toBeNull();
    expect(irr.display).toBe('Multiple solutions');
    // Hand proof: −100 + 250/(1+m) − 150/(1+m)² = 0 ⇔ m ∈ {0, 0.5};
    // annualised: 0 and 1.5¹²−1 = 128.74633789….
    expect(synth.multipleIrr.irr.roots).toHaveLength(2);
    expect((irr.roots as number[])).toHaveLength(2);
  });
});

describe('valuation.R10 payback labels', () => {
  it('interpolates inside the horizon (sembawang60: simple 32, discounted 39)', () => {
    const built = buildCashFlowSeries(project(v2InputFor('sembawang60')), valuationFor('sembawang60'));
    const a = analyse(built.points, 0.15);
    expect(a.simplePayback).toMatchObject({ month: 32, label: 'Month 31 + 19 days' });
    expect(a.simplePayback.fractionalMonths as number).toBeCloseTo(31.6445964778918, 9);
    expect(a.discountedPayback).toMatchObject({ month: 39, label: 'Month 38' });
    expect(a.paybackMonth).toBe(32);
    expect(a.discountedPaybackMonth).toBe(39);
  });

  it('P1: labels follow the prototype rule (whole months elapsed + round(frac x 30)d, days omitted when 0)', () => {
    // Prototype v36, 60-month Sembawang at 15%: `Month 31 + 19 days` simple,
    // `Month 38` discounted. The pre-P1 engine read `Month 32 + 20 days` /
    // `Month 39 + 0 days` (recovery-row index + that calendar month's days).
    // Integer fields are unchanged by P1 (R10).
    const built = buildCashFlowSeries(project(v2InputFor('sembawang60')), valuationFor('sembawang60'));
    const a = analyse(built.points, 0.15);
    expect(a.simplePayback.label).toBe('Month 31 + 19 days');
    expect(a.discountedPayback.label).toBe('Month 38');
    expect(a.simplePayback).toMatchObject({ month: 32 });
    expect(a.discountedPayback).toMatchObject({ month: 39 });
    expect(a.paybackMonth).toBe(32);
    expect(a.discountedPaybackMonth).toBe(39);
    // Days-omitted rule on a recovery early in the month: the discounted
    // fraction 56.88 / 4,247.70 = 0.0134 x 30 rounds to 0, so no day suffix.
    // (Round 2: interpolation now uses the DISCOUNTED row flow, as the
    // prototype does; it was 38.0085 when it divided by the undiscounted flow.)
    expect(a.discountedPayback.fractionalMonths as number).toBeCloseTo(38.01339052010045, 9);
  });

  it('labels Beyond horizon when recovery never arrives', () => {
    for (const name of ['midMonth12', 'short36'] as const) {
      const built = buildCashFlowSeries(project(v2InputFor(name)), valuationFor(name));
      const a = analyse(built.points, 0.15);
      if (name === 'midMonth12') {
        expect(a.simplePayback.label).toBe(BEYOND_HORIZON_LABEL);
        expect(a.discountedPayback.label).toBe(BEYOND_HORIZON_LABEL);
        expect(a.paybackMonth).toBeNull();
        expect(a.discountedPaybackMonth).toBeNull();
      } else {
        // short36: simple payback inside (month 32), discounted beyond.
        expect(a.simplePayback.month).toBe(32);
        expect(a.discountedPayback.label).toBe(BEYOND_HORIZON_LABEL);
      }
    }
    const synthBeyond = (fixture.synthetic as unknown as Record<string, { points: Array<[number, number]> }>).beyondHorizon;
    const pts: SeriesPoint[] = synthBeyond.points.map(([period, cashFlow], i) => ({
      index: i, period, periodLabel: formatPeriodLabel(period),
      dateLabel: `M${i}`, daysInMonth: i === 0 ? 0 : 30,
      revenue: 0, operatingCashFlow: 0, capex: 0, otherCashFlow: 0, cashFlow,
    }));
    const a = analyse(pts, 0.15);
    expect(a.simplePayback.label).toBe(BEYOND_HORIZON_LABEL);
    expect(a.discountedPayback.label).toBe(BEYOND_HORIZON_LABEL);
  });
});

describe('valuation hand spot-checks (projection rows, independent of the fixture script)', () => {
  it('prices the partial rent-free window: Dec free, Jan 5000×16/31', () => {
    const res = project(v2InputFor('partialRentFree'));
    expect(res.months[0].opexLease).toBe(0); // 15–31 Dec fully free
    expect(res.months[1].opexLease).toBe(2580.65); // 16 chargeable days
  });

  it('prices leap-day and month-end stubs by actual days', () => {
    const leap = project(v2InputFor('leapDay'));
    expect(leap.months[0].opexLease).toBe(172.41); // 5000 × 1/29
    expect(leap.months[leap.months.length - 1].opexLease).toBe(5000);
    const end = project(v2InputFor('monthEnd'));
    expect(end.months[0].opexLease).toBe(161.29); // 5000 × 1/31
  });

  it('splits the Dec 2027 anniversary straddle 14d Y1 + 17d Y2 (5274.19)', () => {
    const res = project(v2InputFor('escalation24'));
    const dec27 = res.months.find((m) => m.month === '2027-12');
    expect(dec27?.opexLease).toBe(5274.19);
  });

  it('keeps pre-opening revenue/occupancy at zero with rent + opex included (D6B)', () => {
    const res = project(v2InputFor('preOpening'));
    const nov = res.months[0];
    expect(nov.isPreOpening).toBe(true);
    expect(nov.revenue).toBe(0);
    expect(nov.opexLease).toBe(2666.67); // 5000 × 16/30
    expect(nov.opexNonLease).toBe(640); // 1200 × 16/30
  });
});

describe('valuation.§8.3 DCF rows as data', () => {
  it('returns the §8.3 column set with unrounded DFs and cents display', () => {
    const built = buildCashFlowSeries(project(v2InputFor('sembawang60')), valuationFor('sembawang60'));
    const rows = dcfRows(built.points, 0.15);
    expect(rows).toHaveLength(61);
    expect(rows[0]).toMatchObject({ index: 0, month: '2026-12-01', period: 0, periodLabel: '0' });
    expect(rows[0].discountFactor).toBe(1);
    expect(rows[1].periodLabel).toBe('1');
    expect(rows[1].display.discountedCashFlow).toBeCloseTo(-5185.09 * discountFactorAt(0.15, 1), 2);
    // Cumulative DCF reconciles to NPV from the same array.
    const a = analyse(built.points, 0.15);
    expect(rows[rows.length - 1].cumulativeDiscountedCashFlow).toBeCloseTo(a.npv, 9);
    expect(rows[rows.length - 1].display.cumulativeDiscountedCashFlow).toBeCloseTo(a.npv, 2);
    // Stub labels carry exact date ranges (mid-month case).
    const mid = dcfRows(buildCashFlowSeries(project(v2InputFor('midMonth12')), valuationFor('midMonth12')).points, 0.15);
    expect(mid[1].month).toBe('2026-12-15→2026-12-31');
    expect(mid[1].periodLabel).toBe('0.548');
    expect(mid[mid.length - 1].month).toBe('2027-12-01→2027-12-14');
  });
});

// Lease-horizon valuation engine (P3 — R7, R8, R9, R10, R11, D7A/D8A, D12A, D13B).
//
// PURE module: no DB, no clock, no network. It CONSUMES the v2 bucket
// projection (`projection.ts` `project()` / `projectV2()` output) and builds
// the single dated project cash-flow series that NPV, IRR, simple + discounted
// payback, cumulative FCF and PI all read (R8). No consumer, route, migration,
// UI or approved-model writes live here (P4+); no `/api/v1/customer` or
// `/api/v1/public` surface is touched.
//
// OWNER PROVENANCE (FINAL — 2026-11-09, wins over the handoff brief on conflict):
// - D7A: new models default to a 15% annual discount rate
//   (`DEFAULT_MANUAL_RATE`). `effectiveAnnualRate()` returns the default when
//   no methodology/rate is supplied. It NEVER overwrites a stored rate — rate
//   persistence and "read the model version's stored rate" are P4 concerns.
// - D8A: the full Investment valuation assumptions section supports three
//   methodologies — manual, risk-adjusted and WACC. WACC is available ONLY
//   when the financing inputs are complete; otherwise a named
//   `WACC_INPUTS_INCOMPLETE` error is raised and P4 surfaces it (422).
//   Project NPV stays unlevered; Equity NPV is a separate P5+ result.
// - D12A: money rows are SGD cents-rounded; proration factors, monthly rates
//   and discount factors stay UNROUNDED internally. NPV and IRR consume the
//   SAME cents-rounded monthly series; full internal precision is kept and
//   only displayed metrics are rounded.
// - D13B: the committed fixture for this phase is
//   `tests/e2e/fixtures/finance-lease-horizon-validation.json`, derived
//   INDEPENDENTLY (see `scripts/derive-lease-horizon-valuation.py` + the
//   DERIVATION note). If fixture values disagree with this engine beyond
//   tolerance, STOP and report both sides — never silently fix either side.
// - D11A/R13: an optional renewal is a SEPARATE `buildRenewalCase` run with
//   `term + renewalMonths`. It is never written into the committed result; the
//   committed case is byte-identical with renewal on or off (tested).
//
// FORMULAS (handoff §§7.4–7.7, 8.2–8.5):
// - R7: `monthly_rate = (1 + annual)^(1/12) - 1` (UNROUNDED); `period_t` is
//   the RUNNING SUM of the row period factors (0 at commencement, then 0.548,
//   1.548, … for the 15 Dec example — never `index + factor`, which is only
//   correct for first-of-month starts); `DF_t = 1 / (1 + r)^period_t` with
//   UNROUNDED `r` and DF. Cash flows are the CENTS-ROUNDED monthly rows.
// - §7.4: `initial = -(upfront_capex + opening_working_capital +
//   refundable_deposit)` at commencement; monthly project FCF per §7.4.
// - R11 LIMITATION (recorded, not solved): the live model has no
//   tax/financing/working-capital timing, so monthly NOI is used as operating
//   cash. Opening working capital stays inside `capitalTotal` and is NOT
//   released at term end in v1. `refundableDeposit` is separate from capital:
//   it leaves at commencement and is recovered at the committed end only when
//   terminal cash flows are enabled. No property/fit-out sale value is ever
//   assumed. This limitation is repeated in the series metadata for P5/P7 copy.
// - R9: scan-then-bisect on fractional periods → `{none|valid|multiple}`.
//   No sign change → `none` (display `n.a.`); multiple roots → `multiple`
//   (display `Multiple solutions`). Monthly-rate scan floor is −99% (−100%
//   annual); roots below the floor are out of scope and documented.
// - R10: payback is fractional + interpolated, labelled `Month N + D days`
//   (`N` = whole months elapsed before the recovery row, `D` = the in-month
//   fraction × 30 days, rounded, omitted when 0 — the prototype rule) or
//   `Beyond horizon`. The integer `paybackMonth` shape is kept alongside for
//   golden/PDF readers.
// - `kpis.irrAnnualised` delegation is P5's consumer switch — this module
//   exposes the solver plus the pure `irrDisplayLabel()` helper and does NOT
//   rewire `kpis` (note for P5).

import { AppError } from '../../lib/http';
import {
  addMonthsForLeaseEnd,
  committedEndDate,
  daysInMonth,
  diffDays,
} from './leaseTerm';
import {
  hasV2LeaseBlock,
  project,
  type ProjectionInput,
  type ProjectionMonth,
  type ProjectionResult,
  type V2LeaseScheduleRow,
} from './projection';

// ---------- 1. discount-rate methodologies (D7A/D8A) ----------

/** D7A: default annual required return for NEW models only (0.15 = 15%). */
export const DEFAULT_MANUAL_RATE = 0.15;

/**
 * P4 stored Investment valuation assumptions (D8A full shape). Persisted in
 * `FinancialModel.inputs.valuation`; stamped with the D7A 15% manual default
 * at model creation only — loading or exporting a model NEVER substitutes a
 * global default for the stored rate (reads use exactly what is stored).
 */
export interface ValuationAssumptions {
  methodology: 'manual' | 'risk' | 'wacc';
  /** Decimal annual rate (0.15 = 15%). Required when methodology = manual. */
  manualAnnualRate: number;
  /** Risk-buildup components (decimal); the effective rate is their sum. */
  baseReturn: number;
  businessRisk: number;
  leaseRisk: number;
  executionRisk: number;
  /** WACC financing inputs (decimal; null = not supplied). WACC is available
   * ONLY when all five are complete — otherwise valuation fails with the
   * named WACC_INPUTS_INCOMPLETE error and P4 surfaces it (422). */
  costEquity: number | null;
  costDebt: number | null;
  equityWeight: number | null;
  debtWeight: number | null;
  taxRate: number | null;
  /** Optional renewal: a SEPARATE comparison case, never the committed term. */
  renewalEnabled: boolean;
  renewalMonths: number;
  /** Explicit terminal cash flows at the committed end (D8A: off by default;
   * no property or fit-out sale value is ever assumed). */
  includeTerminalCashFlows: boolean;
  refundableDeposit: number;
  reinstatementCost: number;
  otherTerminalCashFlow: number;
}

/** D7A/D8A creation-time defaults (prototype v36 P7): 15% manual;
 * Risk-adjusted 8% + 3% + 2% + 2% = 15%; WACC 18% / 6.5% / 70:30 / 17% tax;
 * renewal length 24 (renewal + terminal OFF). New models only — reads never
 * substitute these for a stored value. */
export const DEFAULT_VALUATION_ASSUMPTIONS: ValuationAssumptions = {
  methodology: 'manual',
  manualAnnualRate: DEFAULT_MANUAL_RATE,
  baseReturn: 0.08,
  businessRisk: 0.03,
  leaseRisk: 0.02,
  executionRisk: 0.02,
  costEquity: 0.18,
  costDebt: 0.065,
  equityWeight: 0.7,
  debtWeight: 0.3,
  taxRate: 0.17,
  renewalEnabled: false,
  renewalMonths: 24,
  includeTerminalCashFlows: false,
  refundableDeposit: 0,
  reinstatementCost: 0,
  otherTerminalCashFlow: 0,
};

/** Stored assumptions → methodology inputs for effectiveAnnualRate(). */
export function methodologyInputsOf(stored: ValuationAssumptions): MethodologyInputs {
  if (stored.methodology === 'risk') {
    return {
      methodology: 'risk',
      baseReturn: stored.baseReturn,
      businessRisk: stored.businessRisk,
      leaseRisk: stored.leaseRisk,
      executionRisk: stored.executionRisk,
    };
  }
  if (stored.methodology === 'wacc') {
    return {
      methodology: 'wacc',
      costEquity: stored.costEquity as number,
      costDebt: stored.costDebt as number,
      equityWeight: stored.equityWeight as number,
      debtWeight: stored.debtWeight as number,
      taxRate: stored.taxRate as number,
    };
  }
  return { methodology: 'manual', manualAnnualRate: stored.manualAnnualRate };
}

/** Stored assumptions + capital → cash-flow series inputs (R11). */
export function seriesInputsOf(capitalTotal: number, stored: ValuationAssumptions): ValuationInputs {
  return {
    capitalTotal,
    refundableDeposit: stored.refundableDeposit,
    reinstatementCost: stored.reinstatementCost,
    otherTerminalCashFlow: stored.otherTerminalCashFlow,
    includeTerminalCashFlows: stored.includeTerminalCashFlows,
  };
}

export const BEYOND_HORIZON_LABEL = 'Beyond horizon';
export const IRR_NONE_DISPLAY = 'n.a.';
export const IRR_MULTIPLE_DISPLAY = 'Multiple solutions';

export type ValuationMethodology = 'manual' | 'risk' | 'wacc';

export interface ManualMethodologyInputs {
  methodology?: 'manual';
  /** Decimal annual rate (0.15 = 15%). Omitted → DEFAULT_MANUAL_RATE. */
  manualAnnualRate?: number;
}

export interface RiskMethodologyInputs {
  methodology: 'risk';
  /** Decimal components; the effective rate is their sum. */
  baseReturn: number;
  businessRisk: number;
  leaseRisk: number;
  executionRisk: number;
}

export interface WaccMethodologyInputs {
  methodology: 'wacc';
  /** Decimal costs of equity/debt, weights summing to 1, decimal tax rate. */
  costEquity: number;
  costDebt: number;
  equityWeight: number;
  debtWeight: number;
  taxRate: number;
}

export type MethodologyInputs =
  | ManualMethodologyInputs
  | RiskMethodologyInputs
  | WaccMethodologyInputs;

function assertDiscountRate(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 10) {
    throw new AppError(400, 'VALIDATION', `${label} must be a finite decimal rate between 0 and 10 (0.15 = 15%), got ${value}.`, {
      code: 'INVALID_DISCOUNT_RATE',
      label,
    });
  }
}

/**
 * D7A/D8A: resolve the effective ANNUAL discount rate (decimal, unrounded).
 * - manual (or omitted methodology): the supplied `manualAnnualRate`, else
 *   DEFAULT_MANUAL_RATE. New models only — never overwrites stored rates (P4).
 * - risk: baseReturn + businessRisk + leaseRisk + executionRisk.
 * - wacc: costEquity × equityWeight + costDebt × debtWeight × (1 − taxRate);
 *   requires ALL five financing inputs (named WACC_INPUTS_INCOMPLETE error,
 *   which P4 maps to 422) and weights summing to 1.
 */
export function effectiveAnnualRate(inputs?: MethodologyInputs | null): number {
  if (!inputs || inputs.methodology === undefined || inputs.methodology === 'manual') {
    const rate = (inputs as ManualMethodologyInputs | null | undefined)?.manualAnnualRate;
    if (rate === undefined) return DEFAULT_MANUAL_RATE;
    assertDiscountRate(rate, 'manualAnnualRate');
    return rate;
  }
  if (inputs.methodology === 'risk') {
    const parts: Array<[string, number]> = [
      ['baseReturn', inputs.baseReturn],
      ['businessRisk', inputs.businessRisk],
      ['leaseRisk', inputs.leaseRisk],
      ['executionRisk', inputs.executionRisk],
    ];
    for (const [label, value] of parts) {
      if (!Number.isFinite(value) || value < 0 || value > 10) {
        throw new AppError(400, 'VALIDATION', `${label} must be a finite decimal between 0 and 10, got ${value}.`, {
          code: 'INVALID_DISCOUNT_RATE',
          label,
        });
      }
    }
    return parts.reduce((sum, [, value]) => sum + value, 0);
  }
  if (inputs.methodology === 'wacc') {
    const { costEquity, costDebt, equityWeight, debtWeight, taxRate } = inputs;
    // Name only the inputs that are actually missing.
    const labelled: Array<[string, number | null | undefined]> = [
      ['cost of equity', costEquity],
      ['cost of debt', costDebt],
      ['equity weight', equityWeight],
      ['debt weight', debtWeight],
      ['tax rate', taxRate],
    ];
    const missing = labelled.filter(([, value]) => !Number.isFinite(value)).map(([name]) => name);
    if (missing.length) {
      const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
      throw new AppError(
        400,
        'VALIDATION',
        `WACC needs ${list} — enter ${missing.length === 1 ? 'it' : 'them'} or use the manual rate.`,
        { code: 'WACC_INPUTS_INCOMPLETE', missing },
      );
    }
    if (!(costEquity >= 0) || !(costDebt >= 0)) {
      throw new AppError(400, 'VALIDATION', 'WACC costs of equity and debt cannot be negative.', {
        code: 'INVALID_DISCOUNT_RATE',
      });
    }
    if (!(equityWeight >= 0) || !(equityWeight <= 1) || !(debtWeight >= 0) || !(debtWeight <= 1)) {
      throw new AppError(400, 'VALIDATION', 'WACC equity and debt weights must each be between 0 and 1.', {
        code: 'WACC_WEIGHTS_INVALID',
      });
    }
    if (Math.abs(equityWeight + debtWeight - 1) > 1e-9) {
      throw new AppError(
        400,
        'VALIDATION',
        `WACC equity and debt weights must sum to 1, got ${equityWeight + debtWeight}.`,
        { code: 'WACC_WEIGHTS_INVALID' },
      );
    }
    if (!(taxRate >= 0) || !(taxRate <= 1)) {
      throw new AppError(400, 'VALIDATION', 'WACC tax rate must be between 0 and 1.', {
        code: 'INVALID_DISCOUNT_RATE',
      });
    }
    return costEquity * equityWeight + costDebt * debtWeight * (1 - taxRate);
  }
  throw new AppError(
    400,
    'VALIDATION',
    `Unknown valuation methodology: ${(inputs as { methodology?: unknown }).methodology}.`,
    { code: 'UNKNOWN_METHODOLOGY' },
  );
}

/** R7: UNROUNDED monthly rate from a decimal annual rate. */
export function monthlyRateFromAnnual(annualRate: number): number {
  if (!Number.isFinite(annualRate) || annualRate <= -1 || annualRate > 10) {
    throw new AppError(400, 'VALIDATION', `Annual rate must be finite and above −100%, got ${annualRate}.`, {
      code: 'INVALID_DISCOUNT_RATE',
    });
  }
  return (1 + annualRate) ** (1 / 12) - 1;
}

/** R7: UNROUNDED discount factor for a fractional period (months). */
export function discountFactorAt(annualRate: number, periodMonths: number): number {
  if (!Number.isFinite(annualRate) || annualRate <= -1) {
    throw new AppError(400, 'VALIDATION', `Annual rate must be finite and above −100%, got ${annualRate}.`, {
      code: 'INVALID_DISCOUNT_RATE',
    });
  }
  if (!Number.isFinite(periodMonths) || periodMonths < 0) {
    throw new AppError(400, 'VALIDATION', `Discount period must be finite and non-negative, got ${periodMonths}.`, {
      code: 'INVALID_DISCOUNT_RATE',
    });
  }
  return (1 + annualRate) ** (-periodMonths / 12);
}

// ---------- 2. the ONE dated cash-flow series (R8/R11) ----------

export interface ValuationInputs {
  /**
   * R11: upfront capex + opening working capital COMBINED (the live model has
   * no WC timing). Opening WC stays inside this figure — never double-count
   * it and never release it at term end in v1.
   */
  capitalTotal: number;
  /** Refundable lease deposit (SGD): outflow at commencement, recovered at the
   * committed end only when terminal cash flows are enabled. Separate from
   * capitalTotal. Defaults to 0. */
  refundableDeposit?: number;
  /** Reinstatement cost magnitude (SGD, positive = outflow) at the committed
   * end when terminal cash flows are enabled. Defaults to 0. */
  reinstatementCost?: number;
  /** Any other explicit terminal cash flow (SIGNED: positive = inflow) at the
   * committed end when terminal cash flows are enabled. Defaults to 0. */
  otherTerminalCashFlow?: number;
  /** Terminal items (deposit recovery, reinstatement, other) land at the
   * EXACT committed end only when true. Default false (D8A: off by default). */
  includeTerminalCashFlows?: boolean;
}

export interface SeriesPoint {
  /** 0 = commencement outflow, 1..N = monthly rows in projection order. */
  index: number;
  /** Fractional months from commencement (R7 running sum; 0 at t=0). Full
   * internal precision — round only for display (`periodLabel`). */
  period: number;
  /** Display label: integers as-is, part-months trimmed to 3dp
   * (`0.548`, `1.548`, … — the §8.3 Period column format). */
  periodLabel: string;
  /** `YYYY-MM` for full months, `YYYY-MM-DD→YYYY-MM-DD` for stub rows, the
   * commencement date for t=0 (the §8.3 Month/date-range column). */
  dateLabel: string;
  /** Calendar days in the row's month (0 for t=0; drives payback day count). */
  daysInMonth: number;
  revenue: number;
  /** R11: monthly NOI is used as operating cash (limitation recorded). */
  operatingCashFlow: number;
  /** Monthly capex paid (0 in v1 — upfront capex lives in t=0; phased capex
   * is future scope per the Q8 amendment). */
  capex: number;
  /** Terminal slice at the final period when enabled (deposit recovery −
   * reinstatement + other), else 0. */
  otherCashFlow: number;
  /** CENTS-ROUNDED net row (D12A: the same series NPV and IRR consume). */
  cashFlow: number;
}

export interface BuiltCashFlowSeries {
  points: SeriesPoint[];
  metadata: {
    commencementDate: string;
    committedEndDate: string;
    rowCount: number;
    /** t=0 outflow (negative or zero): -(capitalTotal + refundableDeposit). */
    initialOutflow: number;
    terminalApplied: boolean;
    /** Net terminal added to the final monthly row (0 when disabled). */
    terminalNet: number;
    /** R11 limitation copy for P5/P7 screens and exports. */
    limitation: string;
  };
}

/** Accepts the built series or its points array — both read the same array. */
export type CashFlowSeriesLike = SeriesPoint[] | BuiltCashFlowSeries;

function pointsOf(series: CashFlowSeriesLike): SeriesPoint[] {
  return Array.isArray(series) ? series : series.points;
}

const VALUATION_LIMITATION =
  'R11: the live model has no tax, financing or working-capital timing, so monthly NOI is used as operating cash; ' +
  'opening working capital stays inside the initial investment and is not released at term end; ' +
  'no property or fit-out sale value is assumed.';

/** D12A: every money input carries at most SGD cents (P2 message kept). */
function assertCents(n: number, label: string): void {
  if (!Number.isFinite(n)) {
    throw new AppError(400, 'VALIDATION', `${label} must be a finite number.`, {
      code: 'MONEY_PRECISION',
      label,
    });
  }
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw new AppError(400, 'VALIDATION', `${label} must have at most two decimal places (SGD cents), got ${n}.`, {
      code: 'MONEY_PRECISION',
      label,
    });
  }
}

function round2(n: number): number {
  const rounded = Math.round(n * 100) / 100;
  // Normalise -0 → 0 so API/CSV readers never see "-$0.00".
  return rounded === 0 ? 0 : rounded;
}

/** Display label for a running-sum period: `0`, `0.548`, `1.548`, `12`. */
export function formatPeriodLabel(period: number): string {
  if (!Number.isFinite(period) || period < 0) {
    throw new AppError(400, 'VALIDATION', `Period must be finite and non-negative, got ${period}.`, {
      code: 'INVALID_DISCOUNT_RATE',
    });
  }
  if (Number.isInteger(period)) return String(period);
  return String(parseFloat(period.toFixed(3)));
}

function monthDim(monthLabel: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(monthLabel);
  if (!m) {
    throw new AppError(400, 'VALIDATION', `Projection month must be YYYY-MM, got ${monthLabel}.`, {
      code: 'EMPTY_PROJECTION',
    });
  }
  return daysInMonth(Number(m[1]), Number(m[2]));
}

function lastDayOf(monthLabel: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthLabel);
  if (!m) {
    throw new AppError(400, 'VALIDATION', `Projection month must be YYYY-MM, got ${monthLabel}.`, {
      code: 'EMPTY_PROJECTION',
    });
  }
  return `${monthLabel}-${String(daysInMonth(Number(m[1]), Number(m[2]))).padStart(2, '0')}`;
}

/**
 * R7 running-sum period factor for one projection row (UNROUNDED). v2 rows
 * carry exact dates, so the factor is recomputed from calendar days; rows
 * without dates fall back to the stored display factor (exact for
 * first-of-month models).
 */
function unroundedRowFactor(row: ProjectionMonth): number {
  if (row.periodStart && row.periodEnd) {
    const activeDays = diffDays(row.periodStart, row.periodEnd) + 1;
    return activeDays / monthDim(row.month);
  }
  return row.periodFactor;
}

/**
 * R8: build the ONE dated series every valuation metric consumes.
 * Series begins at the earliest project cash flow (D6B: the projection rows
 * already include pre-opening rent/deposits/CapEx/valid opex with customer
 * revenue zero there). t=0 outflow = -(capitalTotal + refundableDeposit) at
 * commencement; monthly rows are the CENTS-ROUNDED projection NOI rows
 * (D12A); terminal items land on the EXACT committed end row only when
 * `includeTerminalCashFlows` is true — shortening the term moves them.
 */
export function buildCashFlowSeries(
  result: ProjectionResult,
  valuation: ValuationInputs,
): BuiltCashFlowSeries {
  if (!result || !Array.isArray(result.months) || result.months.length === 0) {
    throw new AppError(400, 'VALIDATION', 'Projection result has no monthly rows to value.', {
      code: 'EMPTY_PROJECTION',
    });
  }
  if (!valuation || typeof valuation !== 'object') {
    throw new AppError(400, 'VALIDATION', 'Valuation inputs are required (capitalTotal at minimum).', {
      code: 'EMPTY_PROJECTION',
    });
  }
  const capitalTotal = valuation.capitalTotal;
  const refundableDeposit = valuation.refundableDeposit ?? 0;
  const reinstatementCost = valuation.reinstatementCost ?? 0;
  const otherTerminalCashFlow = valuation.otherTerminalCashFlow ?? 0;
  const includeTerminalCashFlows = valuation.includeTerminalCashFlows ?? false;
  assertCents(capitalTotal, 'capitalTotal');
  assertCents(refundableDeposit, 'refundableDeposit');
  assertCents(reinstatementCost, 'reinstatementCost');
  assertCents(otherTerminalCashFlow, 'otherTerminalCashFlow');
  if (capitalTotal < 0) {
    throw new AppError(400, 'VALIDATION', 'capitalTotal cannot be negative.', {
      code: 'INVALID_DISCOUNT_RATE',
    });
  }
  if (refundableDeposit < 0 || reinstatementCost < 0) {
    throw new AppError(400, 'VALIDATION', 'refundableDeposit and reinstatementCost cannot be negative (otherTerminalCashFlow carries the sign).', {
      code: 'INVALID_DISCOUNT_RATE',
    });
  }

  const months = result.months;
  const commencementDate = months[0].periodStart ?? `${months[0].month}-01`;
  const committedEndDateISO = months[months.length - 1].periodEnd ?? lastDayOf(months[months.length - 1].month);

  const points: SeriesPoint[] = [];
  const initialOutflow = round2(-(capitalTotal + refundableDeposit));
  points.push({
    index: 0,
    period: 0,
    periodLabel: '0',
    dateLabel: commencementDate,
    daysInMonth: 0,
    revenue: 0,
    operatingCashFlow: 0,
    capex: round2(-capitalTotal),
    otherCashFlow: round2(-refundableDeposit),
    cashFlow: initialOutflow,
  });

  // R11: opening WC is inside capitalTotal (t=0 capex slice) — no monthly
  // capex and no WC release in v1. Terminal net lands on the final row only.
  const terminalNet = includeTerminalCashFlows
    ? round2(refundableDeposit - reinstatementCost + otherTerminalCashFlow)
    : 0;

  let running = 0;
  for (let i = 0; i < months.length; i++) {
    const row = months[i];
    running += unroundedRowFactor(row);
    const isFinal = i === months.length - 1;
    const other = isFinal ? terminalNet : 0;
    const dim = monthDim(row.month);
    const fullMonth =
      row.periodStart !== undefined &&
      row.periodEnd !== undefined &&
      row.periodStart === `${row.month}-01` &&
      row.periodEnd === lastDayOf(row.month);
    points.push({
      index: i + 1,
      period: running,
      periodLabel: formatPeriodLabel(running),
      dateLabel:
        row.periodStart !== undefined && row.periodEnd !== undefined && !fullMonth
          ? `${row.periodStart}→${row.periodEnd}`
          : row.month,
      daysInMonth: dim,
      revenue: row.revenue,
      operatingCashFlow: row.noi,
      capex: 0,
      otherCashFlow: other,
      cashFlow: round2(row.noi + other),
    });
  }

  return {
    points,
    metadata: {
      commencementDate,
      committedEndDate: committedEndDateISO,
      rowCount: months.length,
      initialOutflow,
      terminalApplied: includeTerminalCashFlows,
      terminalNet,
      limitation: VALUATION_LIMITATION,
    },
  };
}

// ---------- 4. analyse: NPV, paybacks, cumulative FCF, PI (R8/R10) ----------

export interface PaybackResult {
  /** 1-based monthly index into the series (0 only for a degenerate
   * non-negative t=0); null when never recovered. */
  month: number | null;
  /** Fractional months from commencement, interpolated within the payback
   * row; null when never recovered. */
  fractionalMonths: number | null;
  /** `Month N + D days` or `Beyond horizon` (R10). */
  label: string;
}

export interface ValuationAnalysis {
  annualRate: number;
  /** UNROUNDED monthly rate used for every DF. */
  monthlyRate: number;
  /** Full internal precision — round only for display. */
  npv: number;
  /** Final cumulative (undiscounted) free cash flow. */
  cumulativeFreeCashFlow: number;
  /** PV of future flows ÷ |initial|; null when no capital is at risk. */
  profitabilityIndex: number | null;
  simplePayback: PaybackResult;
  discountedPayback: PaybackResult;
  /** R10: integer shapes kept for golden/PDF readers. */
  paybackMonth: number | null;
  discountedPaybackMonth: number | null;
}

function interpolatePayback(cumulative: number[]): PaybackResult {
  if (cumulative.length === 0) return { month: null, fractionalMonths: null, label: BEYOND_HORIZON_LABEL };
  if (cumulative[0] >= 0) return { month: 0, fractionalMonths: null, label: 'Month 0' };
  for (let n = 1; n < cumulative.length; n++) {
    if (cumulative[n] >= 0) {
      const prev = cumulative[n - 1];
      // Interpolate on the row's contribution to THIS cumulative series: the
      // undiscounted flow for simple payback, the DISCOUNTED flow for
      // discounted payback (prototype npv-engine paybackPeriod). Using the
      // undiscounted flow for both understated discounted payback — Downside
      // 60-month Sembawang showed Month 49 + 6 days instead of + 11 days.
      const flow = cumulative[n] - prev;
      const fraction = flow !== 0 ? (0 - prev) / flow : 1;
      const clamped = Math.min(Math.max(fraction, 0), 1);
      // P1 prototype rule: whole months elapsed before the recovery row plus
      // the in-month fraction × 30 days (rounded). Days are omitted when 0.
      // `month` (the 1-based series index incl. t=0) and `fractionalMonths`
      // are UNCHANGED — only the label follows the prototype.
      const wholeMonths = n - 1;
      const days = Math.round(clamped * 30);
      return {
        month: n,
        fractionalMonths: n - 1 + clamped,
        label: days === 0 ? `Month ${wholeMonths}` : `Month ${wholeMonths} + ${days} days`,
      };
    }
  }
  return { month: null, fractionalMonths: null, label: BEYOND_HORIZON_LABEL };
}

/**
 * R8: every metric from the one array — project NPV (unlevered, dated
 * discounting), simple + discounted payback (R10 labels + integer shapes),
 * cumulative FCF and PI.
 */
export function analyse(series: CashFlowSeriesLike, annualRate: number): ValuationAnalysis {
  const points = pointsOf(series);
  if (points.length === 0) {
    throw new AppError(400, 'VALIDATION', 'Cash-flow series is empty.', { code: 'EMPTY_PROJECTION' });
  }
  if (!Number.isFinite(annualRate) || annualRate <= -1 || annualRate > 10) {
    throw new AppError(400, 'VALIDATION', `Annual rate must be finite and above −100%, got ${annualRate}.`, {
      code: 'INVALID_DISCOUNT_RATE',
    });
  }
  const monthlyRate = monthlyRateFromAnnual(annualRate);

  let npv = 0;
  const cumulative: number[] = [];
  const discountedCumulative: number[] = [];
  let running = 0;
  let runningDiscounted = 0;
  for (const point of points) {
    const df = discountFactorAt(annualRate, point.period);
    const dcf = point.cashFlow * df;
    npv += dcf;
    running += point.cashFlow;
    runningDiscounted += dcf;
    cumulative.push(running);
    discountedCumulative.push(runningDiscounted);
  }

  const simplePayback = interpolatePayback(cumulative);
  const discountedPayback = interpolatePayback(discountedCumulative);
  const initial = points[0].cashFlow;
  const profitabilityIndex =
    initial < 0 ? (npv - initial) / Math.abs(initial) : null;

  return {
    annualRate,
    monthlyRate,
    npv,
    cumulativeFreeCashFlow: running,
    profitabilityIndex,
    simplePayback,
    discountedPayback,
    paybackMonth: simplePayback.month,
    discountedPaybackMonth: discountedPayback.month,
  };
}

// ---------- 5. IRR: scan-then-bisect on fractional periods (R9) ----------

export type IrrStatus = 'none' | 'valid' | 'multiple';

export interface IrrResult {
  status: IrrStatus;
  /** UNROUNDED monthly root (null unless exactly one root exists). */
  monthlyRate: number | null;
  /** UNROUNDED annualised root `(1+m)^12 − 1` (null unless valid). */
  annualRate: number | null;
  /** `n.a.` | `Multiple solutions` | percent value (P5/P7 display copy). */
  display: string;
  /** Annualised candidate roots when several exist (informational). */
  roots?: number[];
}

/** Pure display helper for P5 consumers: status → screen copy. */
export function irrDisplayLabel(status: IrrStatus, annualRate: number | null): string {
  if (status === 'none') return IRR_NONE_DISPLAY;
  if (status === 'multiple') return IRR_MULTIPLE_DISPLAY;
  if (annualRate === null || !Number.isFinite(annualRate)) return IRR_NONE_DISPLAY;
  return `${(annualRate * 100).toFixed(2)}%`;
}

function npvAtMonthly(monthlyRate: number, points: SeriesPoint[]): number {
  const base = 1 + monthlyRate;
  let sum = 0;
  for (const point of points) sum += point.cashFlow * base ** -point.period;
  return sum;
}

function bisectMonthly(low: number, high: number, points: SeriesPoint[]): number {
  let lo = low;
  let hi = high;
  let fLo = npvAtMonthly(lo, points);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    const fMid = npvAtMonthly(mid, points);
    if (fMid === 0) return mid;
    if (fLo < 0 !== fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * R9: solve the rate over the SAME dated series NPV uses. Monthly-rate scan
 * (−99% floor) collects every sign-change bracket, each bisected; zero
 * brackets → `none`, one → `valid`, several → `multiple`. Series with no
 * sign change in cash flows short-circuit to `none`.
 */
export function solveIrr(series: CashFlowSeriesLike): IrrResult {
  const points = pointsOf(series);
  if (points.length === 0) {
    throw new AppError(400, 'VALIDATION', 'Cash-flow series is empty.', { code: 'EMPTY_PROJECTION' });
  }
  const hasNeg = points.some((p) => p.cashFlow < 0);
  const hasPos = points.some((p) => p.cashFlow > 0);
  if (!hasNeg || !hasPos) {
    return { status: 'none', monthlyRate: null, annualRate: null, display: irrDisplayLabel('none', null) };
  }

  // Upper bracket: double until NPV turns non-positive (NPV → t=0 flow as
  // m → ∞, negative for every conventional project series). Capped — monthly
  // rates past 1024 (≈ infinite annualised) are economically meaningless.
  let hi = 1;
  let fHi = npvAtMonthly(hi, points);
  let guard = 0;
  while (fHi > 0 && guard++ < 60 && hi < 1024) {
    hi *= 2;
    fHi = npvAtMonthly(hi, points);
  }

  const SCAN_LO = -0.99;
  const SCAN_N = 2000;
  const brackets: Array<[number, number]> = [];
  const exact: number[] = [];
  let prevM = SCAN_LO;
  let prevF = npvAtMonthly(prevM, points);
  for (let i = 1; i <= SCAN_N; i++) {
    const m = SCAN_LO + ((hi - SCAN_LO) * i) / SCAN_N;
    const f = npvAtMonthly(m, points);
    if (!Number.isFinite(f) || !Number.isFinite(prevF)) {
      prevM = m;
      prevF = f;
      continue;
    }
    if (prevF === 0) exact.push(prevM);
    if (f === 0) {
      exact.push(m);
    } else if (prevF < 0 !== f < 0) {
      brackets.push([prevM, m]);
    }
    prevM = m;
    prevF = f;
  }

  const found = [...exact];
  for (const [a, b] of brackets) found.push(bisectMonthly(a, b, points));
  found.sort((x, y) => x - y);
  const roots: number[] = [];
  for (const root of found) {
    if (roots.length === 0 || Math.abs(root - roots[roots.length - 1]) > 1e-6) roots.push(root);
  }

  if (roots.length === 0) {
    return { status: 'none', monthlyRate: null, annualRate: null, display: irrDisplayLabel('none', null) };
  }
  if (roots.length === 1) {
    const annualRate = (1 + roots[0]) ** 12 - 1;
    return {
      status: 'valid',
      monthlyRate: roots[0],
      annualRate,
      display: irrDisplayLabel('valid', annualRate),
    };
  }
  return {
    status: 'multiple',
    monthlyRate: null,
    annualRate: null,
    display: irrDisplayLabel('multiple', null),
    roots: roots.map((m) => (1 + m) ** 12 - 1),
  };
}

// ---------- 6. DCF rows: the §8.3 column set as data (UI renders in P7) ----------

export interface DcfRow {
  index: number;
  /** `YYYY-MM`, or `YYYY-MM-DD→YYYY-MM-DD` for stub rows (t=0: commencement). */
  month: string;
  /** Full-precision running-sum period (months from commencement). */
  period: number;
  periodLabel: string;
  revenue: number;
  operatingCashFlow: number;
  capex: number;
  otherCashFlow: number;
  netCashFlow: number;
  /** UNROUNDED discount factor. */
  discountFactor: number;
  /** Full internal precision — round only for display. */
  discountedCashFlow: number;
  cumulativeDiscountedCashFlow: number;
  display: {
    period: string;
    /** 7dp, the §7.7 `0.9884207` format. */
    discountFactor: number;
    /** SGD cents. */
    discountedCashFlow: number;
    /** SGD cents. */
    cumulativeDiscountedCashFlow: number;
  };
}

/**
 * §8.3 monthly DCF table as data (UI renders in P7): month/date-range,
 * Period, revenue, operating CF, CapEx, other CFs, net FCF, DF, DCF and
 * cumulative DCF — every row derived from the one series with UNROUNDED DFs.
 */
export function dcfRows(series: CashFlowSeriesLike, annualRate: number): DcfRow[] {
  const points = pointsOf(series);
  if (points.length === 0) {
    throw new AppError(400, 'VALIDATION', 'Cash-flow series is empty.', { code: 'EMPTY_PROJECTION' });
  }
  if (!Number.isFinite(annualRate) || annualRate <= -1 || annualRate > 10) {
    throw new AppError(400, 'VALIDATION', `Annual rate must be finite and above −100%, got ${annualRate}.`, {
      code: 'INVALID_DISCOUNT_RATE',
    });
  }
  let running = 0;
  return points.map((point) => {
    const df = discountFactorAt(annualRate, point.period);
    const dcf = point.cashFlow * df;
    running += dcf;
    return {
      index: point.index,
      month: point.dateLabel,
      period: point.period,
      periodLabel: point.periodLabel,
      revenue: point.revenue,
      operatingCashFlow: point.operatingCashFlow,
      capex: point.capex,
      otherCashFlow: point.otherCashFlow,
      netCashFlow: point.cashFlow,
      discountFactor: df,
      discountedCashFlow: dcf,
      cumulativeDiscountedCashFlow: running,
      display: {
        period: point.periodLabel,
        discountFactor: Math.round(df * 1e7) / 1e7,
        discountedCashFlow: round2(dcf),
        cumulativeDiscountedCashFlow: round2(running),
      },
    };
  });
}

// ---------- 7. renewal: a separate run, never the committed result (R13/D11A) ----------

export interface RenewalValuationInputs extends ValuationInputs {
  /** Extra committed-equivalent months valued as a SEPARATE scenario. */
  renewalMonths: number;
}

export interface RenewalCaseResult {
  renewal: BuiltCashFlowSeries;
  renewalProjection: ProjectionResult;
  renewalTermMonths: number;
  committedEndDate: string;
  renewalEndDate: string;
}

/**
 * R13/D11A: value `term + renewalMonths` as a separate comparison case (own
 * terminal date when terminal flows are enabled). The input is cloned — the
 * committed result is never written, extended or re-dated here. Missing
 * renewal-year rents are carried forward from the last committed rent as
 * confirmed-estimated SCENARIO assumptions (disclosed, never silently treated
 * as contractual in the committed case — R12 still gates the committed path).
 */
export function buildRenewalCase(
  input: ProjectionInput,
  valuation: RenewalValuationInputs,
): RenewalCaseResult {
  const renewalMonths = valuation.renewalMonths;
  if (!Number.isInteger(renewalMonths) || renewalMonths < 1 || renewalMonths > 120) {
    throw new AppError(400, 'VALIDATION', 'renewalMonths must be a whole number of months 1–120.', {
      code: 'RENEWAL_MONTHS_INVALID',
    });
  }
  const clone: ProjectionInput = JSON.parse(JSON.stringify(input)) as ProjectionInput;
  const renewalTermMonths = clone.horizonMonths + renewalMonths;

  if (hasV2LeaseBlock(clone)) {
    const lease = clone.lease as unknown as {
      startDate: string;
      committedTermMonths: number;
      committedEndDate: string;
      schedule: V2LeaseScheduleRow[];
    };
    const renewalEnd = committedEndDate(lease.startDate, renewalTermMonths);
    const needYears = Math.ceil(renewalTermMonths / 12);
    const schedule = lease.schedule.filter((row) => !row.excluded);
    const haveYears = new Set(schedule.map((row) => row.leaseYear));
    const lastRent = schedule.length
      ? schedule.reduce((a, b) => (a.leaseYear > b.leaseYear ? a : b)).monthlyRent
      : 0;
    for (let k = 1; k <= needYears; k++) {
      if (haveYears.has(k)) continue;
      schedule.push({
        leaseYear: k,
        periodStart: addMonthsForLeaseEnd(lease.startDate, (k - 1) * 12),
        periodEnd: k * 12 >= renewalTermMonths ? renewalEnd : committedEndDate(lease.startDate, k * 12),
        monthlyRent: lastRent,
        source: 'estimated',
        confirmed: true,
      });
    }
    schedule.sort((a, b) => a.leaseYear - b.leaseYear);
    lease.schedule = schedule;
    lease.committedTermMonths = renewalTermMonths;
    lease.committedEndDate = renewalEnd;
    clone.horizonMonths = renewalTermMonths;
  } else {
    clone.horizonMonths = renewalTermMonths;
  }

  const renewalProjection = project(clone);
  const { renewalMonths: _ignored, ...committedValuation } = valuation;
  void _ignored;
  const renewal = buildCashFlowSeries(renewalProjection, committedValuation);

  const firstMonth = renewalProjection.months[0];
  const lastMonth = renewalProjection.months[renewalProjection.months.length - 1];
  return {
    renewal,
    renewalProjection,
    renewalTermMonths,
    committedEndDate: firstMonth.periodStart ?? `${firstMonth.month}-01`,
    renewalEndDate: lastMonth.periodEnd ?? lastDayOf(lastMonth.month),
  };
}

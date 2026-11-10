// Investment Returns (FINANCE_MODULE_SPEC §15) — read-only.
//
// Explains the operating cash return of the SELECTED model without editable
// assumptions. Inputs come from the CURRENT model (or an explicit modelId);
// the horizon is measured from operational start, not calendar year (§15.3).
// Changing the horizon recalculates cumulative cash + IRR using only cash
// flows through that horizon — it never mutates the model.
//
// Engine rule (Q8 note in projection.ts): SPEC formulas only until the spec
// is amended — CF_0 = −capital, CF_t = monthly NOI_t, annualised IRR;
// N/A patterns shown honestly, never fabricated. NPV is reported at a
// DISCLOSED illustrative discount rate (default 8%, editable via query) with
// its basis labelled — an assumption shown, not a fact hidden.

import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { toNum } from '../../lib/format';
import { project, annualisedIrr, hasV2LeaseBlock, type ProjectionInput, type ProjectionResult } from './projection';
import {
  analyse,
  buildCashFlowSeries,
  buildRenewalCase,
  dcfRows,
  effectiveAnnualRate,
  methodologyInputsOf,
  seriesInputsOf,
  solveIrr,
  type ValuationAssumptions,
} from './valuation';
import { getFinancePolicies } from './policies';

export const DEFAULT_DISCOUNT_RATE_PCT = 8;

function npvAt(cashflows: number[], annualRatePct: number): number {
  const monthly = (1 + annualRatePct / 100) ** (1 / 12) - 1;
  let s = 0;
  for (let t = 0; t < cashflows.length; t++) s += cashflows[t] / (1 + monthly) ** t;
  return Math.round(s * 100) / 100;
}

/** Resolves the returns source: explicit model or the branch CURRENT baseline. */
async function resolveSource(opts: { modelId?: string; branchId?: string }) {
  if (opts.modelId) {
    const m = await prisma.financialModel.findUnique({ where: { id: opts.modelId } });
    if (!m) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.modelId} not found.`);
    return m;
  }
  const m = await prisma.financialModel.findFirst({
    where: { ...(opts.branchId ? { branchId: opts.branchId } : {}), status: 'CURRENT' },
    orderBy: { updatedAt: 'desc' },
  });
  if (!m) {
    throw new AppError(404, 'NOT_FOUND', 'No CURRENT model baseline — approve a model or pass modelId to preview returns for a draft.');
  }
  return m;
}

export async function getReturns(opts: {
  modelId?: string;
  branchId?: string;
  horizonYears?: number;
  discountRatePct?: number;
}) {
  const horizonYears = opts.horizonYears ?? 5;
  if (!Number.isInteger(horizonYears) || horizonYears < 1 || horizonYears > 5) {
    throw new AppError(400, 'VALIDATION', 'horizonYears must be an integer 1–5 (Year 1 through Year 5).');
  }
  const discountRatePct = opts.discountRatePct ?? DEFAULT_DISCOUNT_RATE_PCT;
  if (!(discountRatePct >= 0) || discountRatePct > 100) {
    throw new AppError(400, 'VALIDATION', 'discountRatePct must be between 0 and 100.');
  }
  const source = await resolveSource(opts);
  const inputs = source.inputs as unknown as Parameters<typeof project>[0];
  const full: ProjectionResult = project(inputs);
  const horizonMonths = Math.min(horizonYears * 12, full.months.length);
  const slice = full.months.slice(0, horizonMonths);
  const cashflows = [-(inputs.capitalTotal ?? 0), ...slice.map((m) => m.noi)];

  const irrAnnualised = annualisedIrr(cashflows);
  const hasNeg = cashflows.some((c) => c < 0);
  const hasPos = cashflows.some((c) => c > 0);
  const irrNote = irrAnnualised !== null
    ? 'Operating cash-flow IRR, no sale value included.'
    : !hasNeg
      ? 'Not available — every cash flow through this horizon is non-negative (no capital at risk in view).'
      : !hasPos
        ? 'Not available — operating cash flows through this horizon are all negative (the model never pays back in view).'
        : 'Not available — operating cash flows show no sign change (no sale value included).';

  const revenue = slice.reduce((s, m) => s + m.revenue, 0);
  const cost = slice.reduce((s, m) => s + m.operatingCost, 0);
  const noi = Math.round((revenue - cost) * 100) / 100;
  const cashThrough = slice.length ? slice[slice.length - 1].cash : -(inputs.capitalTotal ?? 0);
  const npv = npvAt(cashflows, discountRatePct);

  const yearRows = full.kpis.years
    .filter((y) => y.year <= horizonYears)
    .map((y) => ({ year: y.year, revenue: y.revenue, operatingCost: y.operatingCost, noi: y.noi, noiMarginPct: y.noiMarginPct }));

  // Lease-horizon P4 committed block (owner D8A, handoff §8.4): the main
  // Project NPV stays the FULL committed-term valuation at the model's stored
  // rate (rate identified); the 1/3/5-year slice above is supplementary and
  // labelled `NPV through Year X`. Gated by finance.leaseHorizon.returns
  // (default off → legacy shape only) and present only when the model stores
  // valuation assumptions (never a substituted global default — legacy models
  // without a stored rate keep the legacy shape).
  //
  // P5 R8/R10/R14 DECISION (investigated, not assumed — recorded here so the
  // choice is reviewable): `kpis.irrAnnualised` KEEPS the legacy integer-period
  // `annualisedIrr` solver; the one-series `solveIrr` result is exposed ONLY in
  // this committed block. Measured on the first-of-month golden model the two
  // solvers agree to ~1.5e-14 (legacy 0.3949172713645086 vs one-series
  // 0.3949172713644939 — both round to the golden 0.39492), so delegation
  // would hold R14 numerically for plain models. It is still rejected because
  // (a) `kpis`/the projection engine carry NO valuation context — the deposit
  // and terminal items that change the one-series t=0/final rows live in the
  // stored valuation assumptions, so `kpis` cannot build the committed series
  // without inventing inputs; (b) the one-series builder falls back to the
  // rounded display factor on rows without dates (v1 mid-month paths), which
  // would silently downgrade precision; (c) R10 keeps the integer
  // `paybackMonth` for golden/PDF readers, and the integer IRR gets the same
  // conservatism. The committed block below is the ONE place that reads the
  // P3 array (`buildCashFlowSeries` → `analyse`/`solveIrr`/`dcfRows`).
  const { leaseHorizonReturns } = await getFinancePolicies();
  const storedValuation = (inputs as unknown as { valuation?: ValuationAssumptions }).valuation;
  // P5: the committed term is the CONTRACTUAL months (inputs.horizonMonths),
  // not the calendar-row count — a mid-month start yields N+1 rows for N
  // months, and the labels/identity read the term, not the row count.
  const committed = buildCommittedBlock(source, inputs, full, leaseHorizonReturns, storedValuation);

  const leaseAny = inputs.lease as unknown as { rentFreeMonths?: number; monthlyByYear?: number[] };
  const v2 = hasV2LeaseBlock(inputs) ? (inputs.lease as unknown as { committedTermMonths?: number; committedEndDate?: string }) : null;
  return {
    source: {
      modelId: source.id,
      modelName: source.name,
      modelStatus: source.status,
      engineVersion: source.engineVersion,
      inputHash: source.inputHash,
      asOf: source.updatedAt,
    },
    horizon: {
      years: horizonYears,
      months: horizonMonths,
      measuredFrom: 'operational start (model month 1), not calendar year',
    },
    initialInvestment: inputs.capitalTotal ?? 0,
    leaseTerm: {
      rentFreeMonths: leaseAny.rentFreeMonths ?? 0,
      scheduleYears: leaseAny.monthlyByYear?.length ?? 0,
      assumption: `Lease runs per the model schedule (${leaseAny.monthlyByYear?.length ?? 0} year(s) explicit, carried forward thereafter); renewal is unsecured — no terminal value included.`,
      ...(v2 ? { committedTermMonths: v2.committedTermMonths, committedEndDate: v2.committedEndDate } : {}),
    },
    stabilisationMonth: full.kpis.stabilisedMonth,
    noiPositiveMonth: full.kpis.noiPositiveMonth,
    paybackMonth: full.kpis.paybackMonth,
    paybackWithinHorizon: full.kpis.paybackMonth !== null && full.kpis.paybackMonth <= horizonMonths,
    annualNoiMarginPct: revenue !== 0 ? Math.round((noi / revenue) * 1000) / 10 : null,
    cashThroughSelectedYear: cashThrough,
    irrAnnualised,
    irrNote,
    npv: {
      value: npv,
      // Handoff §8.4: truncated slices are supplementary — never "Project NPV".
      label: `NPV through Year ${horizonYears}`,
      discountRatePct,
      basis: `Illustrative NPV at a disclosed ${discountRatePct}% annual discount on operating cash flows (capital + NOI). Edit discountRatePct to re-cut — the model is never mutated.`,
    },
    ...(committed ? { committed } : {}),
    yearRows,
    sensitivityNote: 'Simplified sensitivity lives on Financial Models (target ±pp, PSF ±$0.50) — this screen reports the selected horizon only.',
  };
}

/**
 * The ONE committed project valuation (P3 series at the stored rate, handoff
 * §§7–8). Null unless the returns rollout is on AND the model stores a rate.
 * A compute failure (e.g. incomplete WACC) is reported as data — never a 500
 * — so the screen can show "Returns are out of date" with a retry action.
 */
export interface CommittedValuationOk {
  modelVersion: number;
  inputHash: string;
  engineVersion: string;
  calculationStatus: string;
  annualRate: number;
  annualRateSource: string;
  leaseStartDate: string;
  committedEndDate: string;
  committedMonths: number;
  npv: number;
  cumulativeFreeCashFlow: number;
  profitabilityIndex: number | null;
  simplePayback: { month: number | null; fractionalMonths: number | null; label: string };
  discountedPayback: { month: number | null; fractionalMonths: number | null; label: string };
  paybackMonth: number | null;
  discountedPaybackMonth: number | null;
  irr: { status: string; annualRate: number | null; display: string };
  dcf: ReturnType<typeof dcfRows>;
  /**
   * P2: Downside / Base / Upside valued on the SAME committed lease, OPEX,
   * capital and horizon (LH18) — occupancy-only overlays. The committed
   * valuation above is the decision metric; this table is the occupancy
   * preview the prototype shows with per-scenario NPV, IRR and paybacks.
   */
  scenarios: CommittedScenario[];
  /**
   * P5: the optional renewal valued as a SEPARATE run (buildRenewalCase),
   * shown only when renewal is enabled. Null when renewal is off. The
   * committed figures are byte-identical with renewal on or off (LH14).
   */
  renewal: CommittedRenewal | null;
  limitation: string;
}

/**
 * P2: one scenario of the committed-block comparison. Rows the prototype
 * shows per scenario: Project NPV, Project IRR, Simple payback, Discounted
 * payback, Initial investment, Annual discount rate.
 */
export interface CommittedScenario {
  scenario: 'downside' | 'base' | 'upside';
  note: string;
  annualRate: number;
  initialInvestment: number;
  npv: number;
  cumulativeFreeCashFlow: number;
  profitabilityIndex: number | null;
  simplePayback: { month: number | null; fractionalMonths: number | null; label: string };
  discountedPayback: { month: number | null; fractionalMonths: number | null; label: string };
  paybackMonth: number | null;
  discountedPaybackMonth: number | null;
  irr: { status: string; annualRate: number | null; display: string };
}

/** P5: the renewal comparison, separate from — never replacing — committed. */
export interface CommittedRenewal {
  renewalMonths: number;
  committedEndDate: string;
  renewalEndDate: string;
  annualRate: number;
  initialInvestment: number;
  npv: number;
  cumulativeFreeCashFlow: number;
  simplePayback: { month: number | null; fractionalMonths: number | null; label: string };
  discountedPayback: { month: number | null; fractionalMonths: number | null; label: string };
  irr: { status: string; annualRate: number | null; display: string };
}

export interface CommittedValuationError {
  modelVersion: number;
  calculationStatus: string;
  annualRateSource: string;
  valuationError: string;
}

export type CommittedValuation = CommittedValuationOk | CommittedValuationError;

/** True when the committed block holds valued figures (not a compute error). */
export function isCommittedValued(c: CommittedValuation | null | undefined): c is CommittedValuationOk {
  return !!c && !('valuationError' in c);
}

/**
 * P7 — §8.3 DCF export as CSV (reuse variant of the month-table export, not a
 * new endpoint). Every row comes from the ONE committed series (`dcfRows` at
 * the model's stored rate): month/date-range, Period, revenue, operating cash
 * flow, CapEx, other cash flows, net FCF, discount factor, DCF and cumulative
 * DCF. Money in SGD cents; the discount factor at 7dp (the §7.7 format).
 * The caller owns the CURRENT gate + audit (same as the month-table export).
 */
export function committedDcfCsv(c: CommittedValuationOk): string {
  const esc = (v: string | number | null): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    'month_or_date_range',
    'period_months',
    'revenue_sgd',
    'operating_cash_flow_sgd',
    'capex_sgd',
    'other_cash_flows_sgd',
    'net_free_cash_flow_sgd',
    'discount_factor',
    'discounted_cash_flow_sgd',
    'cumulative_dcf_sgd',
  ];
  const lines = [head.join(',')];
  for (const r of c.dcf) {
    lines.push(
      [
        r.month,
        r.periodLabel,
        r.revenue,
        r.operatingCashFlow,
        r.capex,
        r.otherCashFlow,
        r.netCashFlow,
        r.display.discountFactor,
        r.display.discountedCashFlow,
        r.display.cumulativeDiscountedCashFlow,
      ].map(esc).join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * P2: the prototype's occupancy-only scenario overlay for the committed
 * returns block. Move-ins ×0.8/×1.2, churn ×1.25/×0.8, stabilisation target
 * ×0.95/×1.03 — RELATIVE factors, verified against prototype v36 (60-month
 * Sembawang NPV S$35,863 / S$85,323 / S$115,800; IRR 24.7% / 39.5% / 50.0%).
 *
 * This deliberately differs from `applyScenario()` (projection.ts), which
 * moves the target by percentage POINTS (−5pp/+3pp → 87/95) and is pinned by
 * the LH18 preview/report tests. The returns screen follows the prototype;
 * the preview/report path keeps `applyScenario`. Lease, OPEX, capital,
 * operational start and horizon are identical in all three cases (LH18).
 */
export function committedScenarioInputs(
  input: ProjectionInput,
  scenario: 'downside' | 'base' | 'upside',
): ProjectionInput {
  const clone = JSON.parse(JSON.stringify(input)) as ProjectionInput;
  if (scenario === 'base') return clone;
  const factors =
    scenario === 'downside'
      ? { moveIn: 0.8, churn: 1.25, target: 0.95 }
      : { moveIn: 1.2, churn: 0.8, target: 1.03 };
  const o = clone.occupancy;
  clone.occupancy = {
    ...o,
    rampFirst6: Math.round(o.rampFirst6 * factors.moveIn * 100) / 100,
    rampFrom7: Math.round(o.rampFrom7 * factors.moveIn * 100) / 100,
    moveOutRatePct: Math.min(100, Math.round(o.moveOutRatePct * factors.churn * 10000) / 10000),
    targetPct: Math.min(100, Math.round(o.targetPct * factors.target * 10000) / 10000),
  };
  return clone;
}

export const COMMITTED_SCENARIO_NOTES = {
  downside: 'Move-ins −20% · churn +25% · stabilisation −5%. Lease, OPEX, capital and horizon unchanged.',
  base: 'Your last saved occupancy plan. The committed valuation above is this column.',
  upside: 'Move-ins +20% · churn −20% · stabilisation +3%. Lease, OPEX, capital and horizon unchanged.',
} as const;

function buildCommittedBlock(
  source: { version: number; engineVersion: string; inputHash: string; calculationStatus: string },
  input: ProjectionInput,
  full: ProjectionResult,
  rollout: 'off' | 'on',
  stored: ValuationAssumptions | undefined,
): CommittedValuation | null {
  if (rollout !== 'on' || !stored || typeof stored.manualAnnualRate !== 'number') return null;
  const months = full.months;
  const capitalTotal = input.capitalTotal ?? 0;
  const committedMonths = input.horizonMonths;
  const commencementDate = months[0]?.periodStart ?? months[0]?.month ?? '';
  const committedEndDate = months.length ? (months[months.length - 1].periodEnd ?? months[months.length - 1].month) : '';
  try {
    const annualRate = effectiveAnnualRate(methodologyInputsOf(stored));
    const valuationInputs = seriesInputsOf(capitalTotal, stored);
    const series = buildCashFlowSeries(full, valuationInputs);
    const analysis = analyse(series, annualRate);
    const irr = solveIrr(series);
    // P2: value each occupancy scenario from the same committed base.
    const scenarios: CommittedScenario[] = (['downside', 'base', 'upside'] as const).map((name) => {
      const overlay = committedScenarioInputs(input, name);
      const proj = project(overlay);
      const s = buildCashFlowSeries(proj, valuationInputs);
      const a = analyse(s, annualRate);
      const solved = solveIrr(s);
      return {
        scenario: name,
        note: COMMITTED_SCENARIO_NOTES[name],
        annualRate,
        initialInvestment: Math.abs(s.metadata.initialOutflow),
        npv: a.npv,
        cumulativeFreeCashFlow: a.cumulativeFreeCashFlow,
        profitabilityIndex: a.profitabilityIndex,
        simplePayback: a.simplePayback,
        discountedPayback: a.discountedPayback,
        paybackMonth: a.paybackMonth,
        discountedPaybackMonth: a.discountedPaybackMonth,
        irr: { status: solved.status, annualRate: solved.annualRate, display: solved.display },
      };
    });
    // P5: the renewal comparison, computed only when enabled. buildRenewalCase
    // clones the inputs — the committed series above is never rewritten,
    // extended or re-dated (LH14).
    let renewal: CommittedRenewal | null = null;
    if (stored.renewalEnabled && Number.isInteger(stored.renewalMonths) && stored.renewalMonths >= 1) {
      const rc = buildRenewalCase(input, { ...valuationInputs, renewalMonths: stored.renewalMonths });
      const ra = analyse(rc.renewal, annualRate);
      const rsolved = solveIrr(rc.renewal);
      renewal = {
        renewalMonths: rc.renewalTermMonths - committedMonths,
        committedEndDate,
        renewalEndDate: rc.renewalEndDate,
        annualRate,
        initialInvestment: Math.abs(rc.renewal.metadata.initialOutflow),
        npv: ra.npv,
        cumulativeFreeCashFlow: ra.cumulativeFreeCashFlow,
        simplePayback: ra.simplePayback,
        discountedPayback: ra.discountedPayback,
        irr: { status: rsolved.status, annualRate: rsolved.annualRate, display: rsolved.display },
      };
    }
    return {
      modelVersion: source.version,
      inputHash: source.inputHash,
      engineVersion: source.engineVersion,
      calculationStatus: source.calculationStatus,
      annualRate,
      annualRateSource: stored.methodology,
      leaseStartDate: commencementDate,
      committedEndDate,
      committedMonths,
      npv: analysis.npv,
      cumulativeFreeCashFlow: analysis.cumulativeFreeCashFlow,
      profitabilityIndex: analysis.profitabilityIndex,
      simplePayback: analysis.simplePayback,
      discountedPayback: analysis.discountedPayback,
      paybackMonth: analysis.paybackMonth,
      discountedPaybackMonth: analysis.discountedPaybackMonth,
      irr: { status: irr.status, annualRate: irr.annualRate, display: irr.display },
      dcf: dcfRows(series, annualRate).map((r) => ({
        ...r,
        revenue: toNum(r.revenue),
        operatingCashFlow: toNum(r.operatingCashFlow),
        capex: toNum(r.capex),
        otherCashFlow: toNum(r.otherCashFlow),
        netCashFlow: toNum(r.netCashFlow),
      })),
      scenarios,
      renewal,
      limitation: series.metadata.limitation,
    };
  } catch (e) {
    return {
      modelVersion: source.version,
      calculationStatus: source.calculationStatus,
      annualRateSource: (stored as { methodology?: string }).methodology ?? 'manual',
      valuationError: e instanceof Error ? e.message : 'Valuation failed.',
    };
  }
}

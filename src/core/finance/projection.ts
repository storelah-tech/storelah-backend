// Finance projection engine (FINANCE_MODULE_SPEC §8) — PURE deterministic TS.
//
// No database, no clock, no network: same input snapshot + engineVersion +
// inputHash → byte-identical rows. Server results are authoritative; the UI
// may mirror these formulas for preview but must never persist its own math.
//
// Money: plain numbers rounded to cents at each monthly line (revenue, NOI,
// cash). Prisma.Decimal math happens at the API boundary (toNum); this engine
// is pre-persistence arithmetic. Percentages are fractions internally
// (0.92 = 92%) and rounded only in display fields.
//
// Formula refs: §8.1 size mix & pricing, §8.2 occupancy movement, §8.3 pricing
// over time, §8.4 landlord lease, §8.5 opex, §8.6 NOI/margin/cash, §8.7
// milestones, §8.8 IRR (SPEC formula — see Q8 note below), §8.9 scenarios,
// §8.10 sensitivity.
//
// Q8 CONFLICT NOTE (IMPLEMENTATION_PLAN §§9–10 Q8): the owner has decided a
// wider IRR scope (unlevered project IRR incl. working-capital movements,
// phased capex, conditional taxes, dated XIRR for varying-date flows; plus a
// separately-labelled Equity IRR and an optional renewal/exit scenario).
// That scope goes BEYOND spec §§5.1/8.8/15, and per spec §1 priority the SPEC
// wins until it is amended. So this engine implements the SPEC formulas only
// (CF_0 = −total capital, CF_t = monthly NOI_t, monthly-rate solve annualised
// as (1+r)^12 − 1, no terminal value, no financing/tax/depreciation). The Q8
// scope is RECORDED, not implemented — TODO: amend spec §§5.1/8.8/15, bump
// ENGINE_VERSION to /2, add phased-capex/working-capital/XIRR inputs then.

import { createHash } from 'node:crypto';
import { AppError } from '../../lib/http';

export const ENGINE_VERSION = 'finance-projection/1';

export interface SizeCategoryInput {
  name: string;
  range?: string; // display only, e.g. 10–20 sq ft
  nlaSqft: number;
  units: number;
  psf: number; // net monthly PSF for this size
}

export interface OccupancyPlanInput {
  rampFirst6: number; // gross move-in sqft/month, model months 1–6
  rampFrom7: number; // gross move-in sqft/month, month 7 onward
  moveOutRatePct: number; // monthly move-out rate, percent (user-entered %)
  churnStartMonth: number; // churn applies when t >= this month
  targetPct: number; // stabilisation target occupancy, percent
}

export interface PricingInput {
  annualIncreasePct: number; // customer rent increase, applied at model-year boundary
  weightedStartPsf?: number; // override; default = derived from sizeMix (§8.1)
}

export interface LeaseInput {
  monthlyByYear: number[]; // contractual monthly rent per model year (1-based)
  rentFreeMonths: number; // model months 1..k are free (§8.4)
  ufaSqft?: number; // display only
}

export interface OpexCategoryInput {
  name: string;
  budget: number; // monthly non-lease budget for this category
  owner?: string;
  note?: string;
}

export interface OpexInput {
  baseMonthly: number; // base non-lease opex (Σ active category budgets)
  annualGrowthPct: number;
  categories?: OpexCategoryInput[]; // when present, baseMonthly = Σ budget
  // Approved monthly budget overrides (§13.3 scoped Update): YYYY-MM → that
  // month's total non-lease budget, used as-is (no growth, no proration).
  overrides?: Record<string, number>;
  overrideLines?: Record<string, OpexCategoryInput[]>; // display detail per month
}

export interface CapitalItemInput {
  name: string;
  amount: number;
}

export interface ProjectionInput {
  startDate: string; // YYYY-MM-DD (may be mid-month → month 1 prorated, §7.3)
  horizonMonths: number; // 1–120
  nlaSqft: number;
  sizeMix: SizeCategoryInput[];
  occupancy: OccupancyPlanInput;
  pricing: PricingInput;
  lease: LeaseInput;
  opex: OpexInput;
  capitalTotal: number; // total capital investment (cash starts at −capital, §8.6)
  capitalItems?: CapitalItemInput[]; // when present, capitalTotal = Σ amount
}

export interface ProjectionMonth {
  t: number; // 1-based model month
  month: string; // calendar label YYYY-MM
  periodFactor: number; // 1 except a prorated opening month
  openingSqft: number;
  moveInSqft: number;
  moveOutSqft: number;
  netMoveInSqft: number;
  closingSqft: number;
  occupancyPct: number; // 1dp
  psf: number; // monthly PSF applied, 4dp internally rounded to 4
  revenue: number; // cents
  opexLease: number; // paid landlord lease, cents
  opexNonLease: number; // cents
  operatingCost: number; // cents (lease counted EXACTLY once, §8.5)
  noi: number; // cents
  noiMarginPct: number | null; // null when revenue is 0
  cash: number; // cumulative cash, cents
}

export interface YearSummary {
  year: number;
  revenue: number;
  operatingCost: number;
  noi: number;
  noiMarginPct: number | null;
  cashAtYearEnd: number;
  closingSqft: number;
}

export interface ProjectionKpis {
  weightedStartPsf: number;
  year1OccupiedSqft: number;
  year1NetMoveInSqft: number;
  years: YearSummary[];
  noiPositiveMonth: number | null;
  stabilisedMonth: number | null;
  paybackMonth: number | null;
  occupancy70Month: number | null;
  irrAnnualised: number | null; // null = "Not available" (no sign change)
  irrNote: string;
}

export interface ProjectionResult {
  engineVersion: string;
  inputHash: string;
  months: ProjectionMonth[];
  kpis: ProjectionKpis;
  checks: Record<string, { pass: boolean; detail: string }>;
}

// ---------- small deterministic helpers ----------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Deterministic JSON with sorted object keys (arrays keep order). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function hashInput(input: ProjectionInput): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

function daysInMonthUTC(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function parseStartDate(s: string): { y: number; m1: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new AppError(400, 'VALIDATION', `startDate must be YYYY-MM-DD, got ${s}`);
  const y = Number(m[1]);
  const m1 = Number(m[2]);
  const d = Number(m[3]);
  if (m1 < 1 || m1 > 12 || d < 1 || d > daysInMonthUTC(y, m1)) {
    throw new AppError(400, 'VALIDATION', `startDate is not a calendar date: ${s}`);
  }
  return { y, m1, d };
}

/** Month-1 proration: active days from start through month end ÷ days in month (§7.3). */
export function openingPeriodFactor(startDate: string): number {
  const { y, m1, d } = parseStartDate(startDate);
  const dim = daysInMonthUTC(y, m1);
  return (dim - d + 1) / dim;
}

function validateInput(input: ProjectionInput): void {
  const fail = (msg: string): never => {
    throw new AppError(400, 'VALIDATION', msg);
  };
  if (!input || typeof input !== 'object') fail('Projection input is required.');
  if (!Number.isInteger(input.horizonMonths) || input.horizonMonths < 1 || input.horizonMonths > 120) {
    fail('horizonMonths must be an integer 1–120.');
  }
  if (!(input.nlaSqft > 0)) fail('nlaSqft must be greater than zero.');
  parseStartDate(input.startDate);
  const o = input.occupancy;
  if (o.rampFirst6 < 0 || o.rampFrom7 < 0) fail('Occupancy ramp values cannot be negative.');
  if (!(o.moveOutRatePct >= 0) || o.moveOutRatePct > 100) fail('moveOutRatePct must be between 0 and 100.');
  if (!Number.isInteger(o.churnStartMonth) || o.churnStartMonth < 1 || o.churnStartMonth > input.horizonMonths) {
    fail('churnStartMonth must be within the horizon.');
  }
  if (!(o.targetPct > 0) || o.targetPct > 100) fail('targetPct must be between 0 and 100.');
  if (input.capitalTotal < 0) fail('Capital values cannot be negative.');
  if (input.opex.baseMonthly < 0) fail('Opex values cannot be negative.');
  if (Object.values(input.opex.overrides ?? {}).some((v) => !(v >= 0))) fail('Monthly budget overrides cannot be negative.');
  if ((input.capitalItems ?? []).some((c) => !(c.amount >= 0))) fail('Capital item amounts cannot be negative.');
  if (input.lease.rentFreeMonths < 0 || !Number.isInteger(input.lease.rentFreeMonths)) {
    fail('rentFreeMonths cannot be negative.');
  }
  if (!input.lease.monthlyByYear.length) fail('Lease schedule must cover at least model year 1.');
  if (input.lease.monthlyByYear.some((r) => r < 0)) fail('Lease rent values cannot be negative.');
  for (const c of input.sizeMix) {
    if (c.nlaSqft < 0 || c.psf < 0 || c.units < 0) fail(`Size category ${c.name}: values cannot be negative.`);
  }
}

/** §8.1 — weighted monthly PSF from the size mix. */
export function weightedPsf(sizeMix: SizeCategoryInput[]): number {
  const total = sizeMix.reduce((s, c) => s + c.nlaSqft, 0);
  if (total <= 0) throw new AppError(400, 'VALIDATION', 'Size mix NLA must reconcile to a positive total.');
  return sizeMix.reduce((s, c) => s + c.nlaSqft * c.psf, 0) / total;
}

function monthLabel(y: number, m1: number): string {
  return `${y}-${String(m1).padStart(2, '0')}`;
}

// ---------- IRR (§8.8, SPEC formula) ----------

function npv(monthlyRate: number, cashflows: number[]): number {
  let s = 0;
  for (let t = 0; t < cashflows.length; t++) s += cashflows[t] / (1 + monthlyRate) ** t;
  return s;
}

/**
 * Annualised operating cash-flow IRR from CF_0..CF_H (no terminal value,
 * §5.1/§8.8). Returns null ("Not available") when the flows do not contain
 * at least one negative and one positive value.
 */
export function annualisedIrr(cashflows: number[]): number | null {
  const hasNeg = cashflows.some((c) => c < 0);
  const hasPos = cashflows.some((c) => c > 0);
  if (!hasNeg || !hasPos) return null;
  let lo = -0.9999;
  let hi = 1;
  let fHi = npv(hi, cashflows);
  let guard = 0;
  while (fHi > 0 && guard++ < 200) {
    hi *= 2;
    fHi = npv(hi, cashflows);
  }
  let fLo = npv(lo, cashflows);
  if (!(fLo > 0) || !(fHi < 0)) return null; // no bracket — not meaningful
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const f = npv(mid, cashflows);
    if (Math.abs(f) < 1e-9) {
      lo = mid;
      break;
    }
    if (f > 0) lo = mid;
    else hi = mid;
  }
  const r = (lo + hi) / 2;
  return (1 + r) ** 12 - 1;
}

// ---------- main projection (§§8.2–8.7) ----------

export function project(input: ProjectionInput): ProjectionResult {
  validateInput(input);
  const H = input.horizonMonths;
  const cap = input.nlaSqft * (input.occupancy.targetPct / 100);
  const basePsf = input.pricing.weightedStartPsf ?? weightedPsf(input.sizeMix);
  const factor1 = openingPeriodFactor(input.startDate);
  const proratedStart = factor1 < 1;
  const { y: y0, m1: m0 } = parseStartDate(input.startDate);
  const churnRate = input.occupancy.moveOutRatePct / 100;
  const growth = 1 + input.opex.annualGrowthPct / 100;
  const rentGrowth = 1 + input.pricing.annualIncreasePct / 100;

  const months: ProjectionMonth[] = [];
  let opening = 0;
  let cash = round2(-input.capitalTotal);

  for (let t = 1; t <= H; t++) {
    const factor = t === 1 ? factor1 : 1;
    // Calendar label.
    const idx = m0 - 1 + (t - 1);
    const label = monthLabel(y0 + Math.floor(idx / 12), (idx % 12) + 1);
    const modelYear = Math.floor((t - 1) / 12); // 0-based

    // §8.2 movement. All sqft state is quantized to 2dp each month so the
    // stored rows are self-consistent (net === in − out, closing(t) is the
    // next opening) and deterministic across runtimes.
    const planned = (t <= 6 ? input.occupancy.rampFirst6 : input.occupancy.rampFrom7) * (t === 1 ? factor : 1);
    const moveOutRaw = t >= input.occupancy.churnStartMonth ? opening * churnRate : 0;
    const available = Math.max(0, cap - opening + moveOutRaw);
    const moveIn = round2(Math.min(planned, available));
    const moveOut = round2(moveOutRaw);
    const net = round2(moveIn - moveOut);
    const closing = Math.min(Math.max(round2(opening + net), 0), round2(cap));
    const occupancy = closing / input.nlaSqft;

    // §8.3 pricing over time — uplift starts at the model-year boundary.
    const psf = round4(basePsf * rentGrowth ** modelYear);
    const revenue = round2(closing * psf * factor);

    // §8.4 landlord lease — explicit schedule, free months are whole model months.
    const contractual = input.lease.monthlyByYear[Math.min(modelYear, input.lease.monthlyByYear.length - 1)] ?? 0;
    const paidLease = t <= input.lease.rentFreeMonths ? 0 : round2(contractual * (t === 1 ? factor : 1));

    // §8.5 opex — an approved monthly override replaces the base for that
    // month only; otherwise base × growth^modelYear × period factor.
    const override = input.opex.overrides?.[label];
    const opexNonLease = Number.isFinite(override)
      ? round2(override as number)
      : round2(input.opex.baseMonthly * growth ** modelYear * factor);
    const operatingCost = round2(paidLease + opexNonLease);

    // §8.6 NOI / margin / cash.
    const noi = round2(revenue - operatingCost);
    const margin = revenue !== 0 ? Math.round((noi / revenue) * 1000) / 10 : null;
    cash = round2(cash + noi);

    months.push({
      t,
      month: label,
      periodFactor: round4(factor),
      openingSqft: round2(opening),
      moveInSqft: moveIn,
      moveOutSqft: moveOut,
      netMoveInSqft: net,
      closingSqft: closing,
      occupancyPct: Math.round(occupancy * 1000) / 10,
      psf,
      revenue,
      opexLease: paidLease,
      opexNonLease,
      operatingCost,
      noi,
      noiMarginPct: margin,
      cash,
    });
    opening = closing;
  }

  const kpis = buildKpis(months, basePsf, input.capitalTotal, H);
  const checks = buildChecks(months, input, basePsf, proratedStart, cap);
  return { engineVersion: ENGINE_VERSION, inputHash: hashInput(input), months, kpis, checks };
}

function yearSlice(months: ProjectionMonth[], year: number): ProjectionMonth[] {
  return months.filter((m) => m.t >= (year - 1) * 12 + 1 && m.t <= year * 12);
}

function buildKpis(months: ProjectionMonth[], basePsf: number, capital: number, horizon: number): ProjectionKpis {
  const years: YearSummary[] = [];
  const yearCount = Math.ceil(months.length / 12);
  for (let y = 1; y <= yearCount; y++) {
    const rows = yearSlice(months, y);
    const revenue = round2(rows.reduce((s, m) => s + m.revenue, 0));
    const cost = round2(rows.reduce((s, m) => s + m.operatingCost, 0));
    const noi = round2(revenue - cost);
    years.push({
      year: y,
      revenue,
      operatingCost: cost,
      noi,
      noiMarginPct: revenue !== 0 ? Math.round((noi / revenue) * 1000) / 10 : null,
      cashAtYearEnd: rows.length ? rows[rows.length - 1].cash : round2(-capital),
      closingSqft: rows.length ? rows[rows.length - 1].closingSqft : 0,
    });
  }
  const firstWhere = (p: (m: ProjectionMonth) => boolean): number | null => {
    const f = months.find(p);
    return f ? f.t : null;
  };
  // Stabilisation: first month at ≥99% of the configured target (§8.7). The
  // target fraction is recovered from the cap via peak occupancy, so this
  // stays honest even when the cap binds: occupancy is monotone here.
  const cashflows = [-capital, ...months.map((m) => m.noi)];
  const irr = annualisedIrr(cashflows.slice(0, horizon + 1));
  return {
    weightedStartPsf: round4(basePsf),
    year1OccupiedSqft: months.length >= 12 ? months[11].closingSqft : months[months.length - 1].closingSqft,
    year1NetMoveInSqft: round2(months.slice(0, 12).reduce((s, m) => s + m.netMoveInSqft, 0)),
    years,
    noiPositiveMonth: firstWhere((m) => m.noi >= 0),
    stabilisedMonth: stabilised(months),
    paybackMonth: firstWhere((m) => m.cash >= 0),
    occupancy70Month: firstWhere((m) => m.occupancyPct >= 70),
    irrAnnualised: irr,
    irrNote: irr === null ? 'Not available — operating cash flows show no sign change (no sale value included).' : 'Operating cash-flow IRR, no sale value.',
  };
}

/** First month at ≥99% of the stabilisation target (§8.7). */
function stabilised(months: ProjectionMonth[]): number | null {
  if (!months.length) return null;
  // The target is the cap the engine clamped to: recover it as the max
  // closing sqft the model ever reaches (clamp binds at/after stabilisation).
  const cap = Math.max(...months.map((m) => m.closingSqft));
  if (cap <= 0) return null;
  const f = months.find((m) => m.closingSqft >= cap * 0.99);
  return f ? f.t : null;
}

function buildChecks(
  months: ProjectionMonth[],
  input: ProjectionInput,
  basePsf: number,
  proratedStart: boolean,
  cap: number,
): Record<string, { pass: boolean; detail: string }> {
  const eps = 0.011; // cents-level tolerance on rounded rows
  const netOk = months.every((m) => Math.abs(m.netMoveInSqft - (m.moveInSqft - m.moveOutSqft)) < eps);
  const churnOk = months.every((m) =>
    m.t < input.occupancy.churnStartMonth ? m.moveOutSqft === 0 : true,
  );
  const revenueOk = months.every((m) => Math.abs(m.revenue - round2(m.closingSqft * m.psf * m.periodFactor)) < eps);
  const mixTotal = input.sizeMix.reduce((s, c) => s + c.nlaSqft, 0);
  const mixOk = Math.abs(mixTotal - input.nlaSqft) < 0.01;
  const leaseOnce = months.every((m) => Math.abs(m.operatingCost - (m.opexLease + m.opexNonLease)) < eps);
  const capOk = months.every((m) => m.closingSqft <= cap + eps);
  const cashStart = months.length ? Math.abs(months[0].cash - round2(-input.capitalTotal + months[0].noi)) < eps : true;
  return {
    netMoveIn: { pass: netOk, detail: 'net move-in equals move-in minus move-out every month' },
    churnStart: { pass: churnOk, detail: `no move-out before model month ${input.occupancy.churnStartMonth}` },
    revenueUsesOccupiedPsf: { pass: revenueOk, detail: 'revenue equals closing occupied sqft × month PSF × period factor' },
    sizeMixReconciles: { pass: mixOk, detail: `size-mix NLA ${mixTotal} vs facility NLA ${input.nlaSqft}` },
    leaseCountedOnce: { pass: leaseOnce, detail: 'operating cost equals paid lease + non-lease opex, single lease line' },
    stabilisationCap: { pass: capOk, detail: `occupied never exceeds target cap ${round2(cap)} sqft` },
    openingProrated: {
      pass: proratedStart ? months[0].periodFactor < 1 : months[0].periodFactor === 1,
      detail: proratedStart ? `opening month prorated (factor ${months[0].periodFactor})` : 'full opening month (factor 1)',
    },
    cashStartsAtCapital: { pass: cashStart, detail: `cash opens at −capital (${input.capitalTotal}) plus month-1 NOI` },
    weightedPsf: { pass: true, detail: `weighted starting PSF ${round4(basePsf)} from size mix` },
  };
}

// ---------- scenarios (§8.9) ----------

export type ScenarioName = 'downside' | 'base' | 'upside';

export interface ScenarioOverlay {
  scenario: ScenarioName;
  occupancy: OccupancyPlanInput; // isolated copy — base inputs never mutated
  note: string;
}

/**
 * Applies a scenario as an isolated overlay: occupancy-only changes, returned
 * as a fresh object. The saved base is untouched until the user deliberately
 * saves a named version (spec §8.9).
 */
export function applyScenario(input: ProjectionInput, scenario: ScenarioName): ScenarioOverlay {
  const o = input.occupancy;
  if (scenario === 'base') {
    return { scenario, occupancy: { ...o }, note: 'Saved plan, unchanged.' };
  }
  if (scenario === 'downside') {
    return {
      scenario,
      occupancy: {
        ...o,
        rampFirst6: round2(o.rampFirst6 * 0.8),
        rampFrom7: round2(o.rampFrom7 * 0.8),
        moveOutRatePct: round4(o.moveOutRatePct * 1.25),
        targetPct: round4(Math.max(0, o.targetPct - 5)),
      },
      note: 'Gross move-in −20%, churn +25%, stabilisation target −5pp. Pricing, capital, lease and opex unchanged.',
    };
  }
  return {
    scenario,
    occupancy: {
      ...o,
      rampFirst6: round2(o.rampFirst6 * 1.2),
      rampFrom7: round2(o.rampFrom7 * 1.2),
      moveOutRatePct: round4(o.moveOutRatePct * 0.8),
      targetPct: round4(o.targetPct + 3),
    },
    note: 'Gross move-in +20%, churn −20%, stabilisation target +3pp. Pricing, capital, lease and opex unchanged.',
  };
}

// ---------- sensitivity (§8.10) ----------

export interface SensitivityCase {
  name: 'lower' | 'base' | 'stronger';
  targetPct: number;
  psfDelta: number;
  year1Revenue: number;
  year1Noi: number;
  year1NoiMarginPct: number | null;
  paybackMonth: number | null;
  irrAnnualised: number | null;
}

/** Simplified sensitivity display: target occupancy × weighted PSF. */
export function sensitivity(input: ProjectionInput): SensitivityCase[] {
  const basePsf = input.pricing.weightedStartPsf ?? weightedPsf(input.sizeMix);
  const cases: Array<{ name: SensitivityCase['name']; targetPct: number; psf: number }> = [
    { name: 'lower', targetPct: input.occupancy.targetPct - 6, psf: round4(basePsf - 0.5) },
    { name: 'base', targetPct: input.occupancy.targetPct, psf: round4(basePsf) },
    { name: 'stronger', targetPct: Math.min(98, input.occupancy.targetPct + 3), psf: round4(basePsf + 0.5) },
  ];
  return cases.map((c) => {
    const res = project({
      ...input,
      occupancy: { ...input.occupancy, targetPct: c.targetPct },
      pricing: { ...input.pricing, weightedStartPsf: c.psf },
    });
    const y1 = res.kpis.years[0];
    return {
      name: c.name,
      targetPct: c.targetPct,
      psfDelta: round4(c.psf - basePsf),
      year1Revenue: y1.revenue,
      year1Noi: y1.noi,
      year1NoiMarginPct: y1.noiMarginPct,
      paybackMonth: res.kpis.paybackMonth,
      irrAnnualised: res.kpis.irrAnnualised,
    };
  });
}

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
import { project, annualisedIrr, type ProjectionResult } from './projection';

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
      rentFreeMonths: inputs.lease.rentFreeMonths ?? 0,
      scheduleYears: inputs.lease.monthlyByYear.length,
      assumption: `Lease runs per the model schedule (${inputs.lease.monthlyByYear.length} year(s) explicit, carried forward thereafter); renewal is unsecured — no terminal value included.`,
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
      discountRatePct,
      basis: `Illustrative NPV at a disclosed ${discountRatePct}% annual discount on operating cash flows (capital + NOI). Edit discountRatePct to re-cut — the model is never mutated.`,
    },
    yearRows,
    sensitivityNote: 'Simplified sensitivity lives on Financial Models (target ±pp, PSF ±$0.50) — this screen reports the selected horizon only.',
  };
}

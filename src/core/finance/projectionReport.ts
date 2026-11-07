// Model projection report (PDF) — data assembly.
//
// Investor-facing "if we follow this model" report for ONE financial model,
// exported from the Financial Models page. Calculations only: everything here
// comes from the model's saved inputs run through the pure projection engine
// (base case + downside/upside scenarios) plus the Investment Returns read model
// (IRR / NPV). No actuals, no customer data, nothing written — the route
// records the export in the finance audit log.
//
// Breakdown windows (owner, 2026-11-06): monthly detail for up to the first
// 24 model months; yearly roll-up for up to 5 model years, each labelled with
// its calendar months (model year 1 = the 12 months from the opening date).

import { prisma } from '../../lib/prisma';
import { getModel } from './models';
import { getReturns, DEFAULT_DISCOUNT_RATE_PCT } from './returns';
import {
  applyScenario,
  project,
  type ProjectionInput,
  type ProjectionKpis,
  type ProjectionMonth,
  type ScenarioName,
} from './projection';

export const PROJECTION_REPORT_MONTHS = 24;
export const PROJECTION_REPORT_YEARS = 5;

export interface ProjectionReportYear {
  year: number;
  firstMonth: string; // YYYY-MM
  lastMonth: string; // YYYY-MM
  months: number; // 12 except a short final year
  revenue: number;
  lease: number;
  otherCosts: number;
  operatingCost: number;
  noi: number;
  noiMarginPct: number | null;
  closingOccupancyPct: number;
  closingSqft: number;
  cashAtYearEnd: number;
}

export interface ProjectionReportScenario {
  scenario: ScenarioName;
  note: string;
  occupancy: ProjectionInput['occupancy'];
  years: Array<{ year: number; revenue: number; noi: number; noiMarginPct: number | null }>;
  stabilisedMonth: number | null;
  paybackMonth: number | null;
  irrAnnualised: number | null;
}

export interface ProjectionReport {
  meta: {
    generatedAt: string;
    generatedBy: string;
    modelId: string;
    modelName: string;
    status: string;
    approved: boolean;
    version: number;
    facility: string;
    updatedAt: string;
    updatedBy: string;
    engineVersion: string;
    inputHash: string;
  };
  inputs: ProjectionInput;
  kpis: ProjectionKpis;
  months: ProjectionMonth[];
  years: ProjectionReportYear[];
  scenarios: ProjectionReportScenario[];
  returns: {
    horizonYears: number;
    initialInvestment: number;
    irrAnnualised: number | null;
    irrNote: string;
    npv: number;
    discountRatePct: number;
    paybackMonth: number | null;
    annualNoiMarginPct: number | null;
    cashThroughHorizon: number;
  };
  failedChecks: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Model-year roll-up with calendar labels, lease split out (first `limit` years). */
export function yearRows(months: ProjectionMonth[], limit = PROJECTION_REPORT_YEARS): ProjectionReportYear[] {
  const out: ProjectionReportYear[] = [];
  for (let y = 1; y <= limit; y++) {
    const rows = months.filter((m) => m.t > (y - 1) * 12 && m.t <= y * 12);
    if (!rows.length) break;
    const revenue = round2(rows.reduce((s, m) => s + m.revenue, 0));
    const lease = round2(rows.reduce((s, m) => s + m.opexLease, 0));
    const otherCosts = round2(rows.reduce((s, m) => s + m.opexNonLease, 0));
    const operatingCost = round2(rows.reduce((s, m) => s + m.operatingCost, 0));
    const noi = round2(revenue - operatingCost);
    const last = rows[rows.length - 1];
    out.push({
      year: y,
      firstMonth: rows[0].month,
      lastMonth: last.month,
      months: rows.length,
      revenue,
      lease,
      otherCosts,
      operatingCost,
      noi,
      noiMarginPct: revenue !== 0 ? Math.round((noi / revenue) * 1000) / 10 : null,
      closingOccupancyPct: last.occupancyPct,
      closingSqft: last.closingSqft,
      cashAtYearEnd: last.cash,
    });
  }
  return out;
}

export async function buildProjectionReport(opts: { modelId: string; generatedBy: string; now?: Date }): Promise<ProjectionReport> {
  const now = opts.now ?? new Date();
  const detail = await getModel(opts.modelId);
  const { inputs, projection } = detail;
  const branch = detail.branchId
    ? await prisma.branch.findUnique({ where: { id: detail.branchId }, select: { name: true } })
    : null;

  const horizonYears = Math.max(1, Math.min(PROJECTION_REPORT_YEARS, Math.ceil(projection.months.length / 12)));
  const r = await getReturns({ modelId: detail.id, horizonYears, discountRatePct: DEFAULT_DISCOUNT_RATE_PCT });

  const scenarios: ProjectionReportScenario[] = (['downside', 'base', 'upside'] as ScenarioName[]).map((s) => {
    const overlay = applyScenario(inputs, s);
    const res = s === 'base' ? projection : project({ ...inputs, occupancy: overlay.occupancy });
    return {
      scenario: s,
      note: overlay.note,
      occupancy: overlay.occupancy,
      years: res.kpis.years.slice(0, PROJECTION_REPORT_YEARS).map((y) => ({ year: y.year, revenue: y.revenue, noi: y.noi, noiMarginPct: y.noiMarginPct })),
      stabilisedMonth: res.kpis.stabilisedMonth,
      paybackMonth: res.kpis.paybackMonth,
      irrAnnualised: res.kpis.irrAnnualised,
    };
  });

  return {
    meta: {
      generatedAt: now.toISOString(),
      generatedBy: opts.generatedBy,
      modelId: detail.id,
      modelName: detail.name,
      status: detail.status,
      approved: detail.status === 'CURRENT',
      version: detail.version,
      facility: branch ? branch.name : 'Portfolio model',
      updatedAt: detail.updatedAt.toISOString(),
      updatedBy: detail.updatedBy ?? detail.createdBy,
      engineVersion: detail.engineVersion,
      inputHash: detail.inputHash,
    },
    inputs,
    kpis: projection.kpis,
    months: projection.months.slice(0, PROJECTION_REPORT_MONTHS),
    years: yearRows(projection.months),
    scenarios,
    returns: {
      horizonYears,
      initialInvestment: r.initialInvestment,
      irrAnnualised: r.irrAnnualised,
      irrNote: r.irrNote,
      npv: r.npv.value,
      discountRatePct: r.npv.discountRatePct,
      paybackMonth: r.paybackMonth,
      annualNoiMarginPct: r.annualNoiMarginPct,
      cashThroughHorizon: r.cashThroughSelectedYear,
    },
    failedChecks: Object.entries(projection.checks).filter(([, c]) => !c.pass).map(([k, c]) => `${k}: ${c.detail}`),
  };
}

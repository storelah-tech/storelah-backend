// Financial report (PDF) — data assembly.
//
// One management report for a period, a facility (or every facility the
// operator may see) and an accounting basis. It only composes the read models
// the Finance screens already use — overview KPIs, forecast vs actuals,
// budgets & expenses, arrears, the transactions register, reconciliation and
// (optionally) investment returns — so every figure matches what the screens
// show. Nothing here writes; the route records the export in the audit log.
//
// Months that are not closed have no posted actuals. Their actuals are
// computed live and labelled provisional, never presented as final.

import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { getFinanceOverview, type OverviewBasis } from './overview';
import { computeActuals, getPerformance, ACTUAL_METRICS } from './monthClose';
import { listBudgets } from './budgets';
import { listArrearsCases } from './arrears';
import { listRegister } from './register';
import { getReconciliation } from './reconciliation';
import { getReturns, isCommittedValued } from './returns';
import { getModel } from './models';
import { committedScheduleOf, type CommittedScheduleRow } from './leaseExpense';
import { getFinancePolicies } from './policies';
import { effectiveAnnualRate, methodologyInputsOf, type ValuationAssumptions } from './valuation';
import type { ProjectionInput, ProjectionKpis } from './projection';

export const REPORT_SECTIONS = ['summary', 'performance', 'budgets', 'arrears', 'transactions', 'reconciliation', 'model', 'returns'] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];
export const DEFAULT_REPORT_SECTIONS: ReportSection[] = ['summary', 'performance', 'budgets', 'arrears', 'transactions', 'reconciliation', 'model'];

/** Per-month sections cover at most this many months (the latest ones). */
export const MAX_REPORT_MONTHS = 12;

export interface FinanceReportOpts {
  from?: Date;
  to?: Date;
  branchId?: string;
  basis?: OverviewBasis;
  sections?: ReportSection[];
  /** Facility scope of the requesting operator (null = every facility). */
  branchIds?: string[] | null;
  generatedBy: string;
  now?: Date;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Fiscal months (YYYY-MM) touched by [from, to], newest last. */
export function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  const endY = to.getUTCFullYear();
  const endM = to.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  return out;
}

export async function buildFinanceReport(opts: FinanceReportOpts) {
  const now = opts.now ?? new Date();
  // Default period: month to date (Singapore month of `now`).
  const from = opts.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = opts.to ?? now;
  if (from.getTime() > to.getTime()) throw new AppError(400, 'VALIDATION', 'The report start date must be on or before the end date.');
  const basis = opts.basis ?? 'accrual';
  const sections = new Set<ReportSection>(opts.sections?.length ? opts.sections : DEFAULT_REPORT_SECTIONS);

  // Facilities in the report: the chosen one, else every facility in scope
  // (Branch reads are facility-scoped by the Prisma extension).
  const branches = await prisma.branch.findMany({
    where: opts.branchId ? { id: opts.branchId } : {},
    select: { id: true, code: true, name: true },
    orderBy: { name: 'asc' },
  });
  if (opts.branchId && !branches.length) throw new AppError(404, 'NOT_FOUND', 'Facility not found');

  const allMonths = monthsBetween(from, to);
  const months = allMonths.slice(-MAX_REPORT_MONTHS);
  const monthsTruncated = allMonths.length > months.length;

  const report: {
    meta: {
      title: string; from: string; to: string; basis: OverviewBasis; facility: string; facilities: string[];
      generatedAt: string; generatedBy: string; months: string[]; monthsTruncated: boolean; sections: ReportSection[];
    };
    summary?: Awaited<ReturnType<typeof getFinanceOverview>>;
    performance?: Array<{ branch: string; fiscalMonth: string; closed: boolean; rows: Array<{ metric: string; budget: number | null; forecast: number | null; actual: number | null; variance: number | null }> }>;
    budgets?: Array<{ branch: string; fiscalMonth: string; lines: Array<{ category: string; budget: number; actual: number; variance: number }>; lease: number | null; totalBudget: number; totalActual: number }>;
    arrears?: { openCount: number; openBalance: number; byStage: Array<{ stage: string; count: number; balance: number }>; cases: Array<{ tenant: string; branch: string | null; invoiceNo: string | null; balance: number | null; daysOverdue: number | null; stage: string }> };
    transactions?: { total: number; pending: number; failed: number; byType: Array<{ docType: string; count: number; amount: number }>; pendingRows: Array<{ date: string; recordId: string; customer: string; docType: string; amount: number; status: string }> };
    reconciliation?: Array<{ branch: string; fiscalMonth: string; settled: number; allocated: number; variance: number; unmatched: number; suspense: number; status: string }>;
    model?: Array<ReportModel>;
    returns?: Array<{
      branch: string; model: string; initialInvestment: number;
      paybackMonth: number | null; paybackLabel: string;
      irr: number | null; irrDisplay: string;
      npv: number; npvLabel: string; noiMarginPct: number | null;
      // Committed valuation identity (D7A: the rate is identified on every
      // output). Legacy rows carry the illustrative query rate instead.
      valuationRate: number; valuationRateSource: string;
      committedMonths: number | null; committedEndDate: string | null;
    }>;
  } = {
    meta: {
      title: 'Financial report',
      from: ymd(from),
      to: ymd(to),
      basis,
      facility: opts.branchId ? branches[0].name : 'All facilities',
      facilities: branches.map((b) => b.name),
      generatedAt: now.toISOString(),
      generatedBy: opts.generatedBy,
      months,
      monthsTruncated,
      sections: REPORT_SECTIONS.filter((s) => sections.has(s)),
    },
  };

  if (sections.has('summary')) {
    report.summary = await getFinanceOverview({ from, to, branchId: opts.branchId, basis });
  }

  if (sections.has('performance')) {
    report.performance = [];
    for (const b of branches) {
      for (const fm of months) {
        const view = await getPerformance(b.id, fm);
        let provisional: Record<string, number> = {};
        if (!view.closed) {
          const live = await computeActuals(b.id, fm);
          provisional = Object.fromEntries(live.lines.map((l) => [l.metric, l.value]));
        }
        report.performance.push({
          branch: b.name,
          fiscalMonth: fm,
          closed: view.closed,
          rows: ACTUAL_METRICS.map((metric) => {
            const r = view.rows.find((x) => x.metric === metric);
            const actual = view.closed ? (r?.actual ?? null) : (provisional[metric] ?? null);
            const forecast = r?.forecast ?? null;
            return { metric, budget: r?.budget ?? null, forecast, actual, variance: actual !== null && forecast !== null ? round2(actual - forecast) : null };
          }),
        });
      }
    }
  }

  if (sections.has('budgets')) {
    report.budgets = [];
    for (const b of branches) {
      for (const fm of months) {
        const m = (await listBudgets({ branchId: b.id, fiscalMonth: fm })) as {
          lines: Array<{ category: string; budget: number; actual: number; variance: number }>;
          summary: { lease: number | null };
        };
        const lines = m.lines.map((l) => ({ category: l.category, budget: l.budget, actual: l.actual, variance: l.variance }));
        report.budgets.push({
          branch: b.name,
          fiscalMonth: fm,
          lines,
          lease: m.summary.lease,
          totalBudget: round2(lines.reduce((s, l) => s + l.budget, 0) + (m.summary.lease ?? 0)),
          totalActual: round2(lines.reduce((s, l) => s + l.actual, 0)),
        });
      }
    }
  }

  if (sections.has('arrears')) {
    const cases = (await listArrearsCases({ branchId: opts.branchId })).filter((c) => !c.closedAt && c.stage !== 'RESOLVED');
    const stages = new Map<string, { count: number; balance: number }>();
    for (const c of cases) {
      const s = stages.get(c.stage) ?? { count: 0, balance: 0 };
      s.count += 1;
      s.balance = round2(s.balance + (c.balanceDue ?? 0));
      stages.set(c.stage, s);
    }
    report.arrears = {
      openCount: cases.length,
      openBalance: round2(cases.reduce((s, c) => s + (c.balanceDue ?? 0), 0)),
      byStage: [...stages.entries()].map(([stage, v]) => ({ stage, ...v })),
      cases: cases
        .sort((a, b) => (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0))
        .map((c) => ({ tenant: c.tenant, branch: c.branch, invoiceNo: c.invoiceNo, balance: c.balanceDue, daysOverdue: c.daysOverdue, stage: c.stage })),
    };
  }

  if (sections.has('transactions')) {
    const reg = await listRegister({
      from: ymd(from),
      to: ymd(to),
      branchIds: opts.branchId ? [opts.branchId] : (opts.branchIds ?? null),
    });
    const byType = new Map<string, { count: number; amount: number }>();
    for (const r of reg.rows) {
      const t = byType.get(r.docType) ?? { count: 0, amount: 0 };
      t.count += 1;
      t.amount = round2(t.amount + r.amount);
      byType.set(r.docType, t);
    }
    report.transactions = {
      total: reg.rows.length,
      pending: reg.rows.filter((r) => r.pending).length,
      failed: reg.rows.filter((r) => r.status === 'Failed').length,
      byType: [...byType.entries()].map(([docType, v]) => ({ docType, ...v })),
      pendingRows: reg.rows.filter((r) => r.pending).map((r) => ({ date: r.date, recordId: r.recordId, customer: r.customer, docType: r.docType, amount: r.amount, status: r.status })),
    };
  }

  if (sections.has('reconciliation')) {
    report.reconciliation = [];
    for (const b of branches) {
      for (const fm of months) {
        const r = await getReconciliation({ branchId: b.id, fiscalMonth: fm });
        report.reconciliation.push({
          branch: b.name,
          fiscalMonth: fm,
          settled: r.settled,
          allocated: r.allocated,
          variance: r.variance,
          unmatched: r.unmatchedCount + r.partialCount,
          suspense: r.suspenseCount,
          status: r.batch?.status === 'CLOSED' ? 'Closed' : r.settled || r.unmatchedCount || r.matchedCount ? 'Open' : 'No settlements',
        });
      }
    }
  }

  if (sections.has('model')) {
    report.model = [];
    const { leaseHorizonReturns } = await getFinancePolicies();
    for (const b of branches) {
      const m = await prisma.financialModel.findFirst({ where: { branchId: b.id, status: 'CURRENT' }, orderBy: { updatedAt: 'desc' } });
      if (!m) {
        report.model.push({ branch: b.name, model: null });
        continue;
      }
      const { inputs, projection } = await getModel(m.id);
      // Committed valuation identity for the model section (D7A): present
      // only when the returns rollout is on AND the model stores a rate —
      // legacy models keep the legacy shape (never a substituted default).
      const storedValuation = (inputs as unknown as { valuation?: ValuationAssumptions }).valuation;
      let valuationBlock: {
        annualRate: number; annualRateSource: string; committedMonths: number; committedEndDate: string;
      } | null = null;
      if (leaseHorizonReturns === 'on' && storedValuation && typeof storedValuation.manualAnnualRate === 'number') {
        try {
          valuationBlock = {
            annualRate: effectiveAnnualRate(methodologyInputsOf(storedValuation)),
            annualRateSource: storedValuation.methodology ?? 'manual',
            committedMonths: inputs.horizonMonths,
            committedEndDate: projection.months.length
              ? (projection.months[projection.months.length - 1].periodEnd ?? projection.months[projection.months.length - 1].month)
              : '',
          };
        } catch {
          valuationBlock = null;
        }
      }
      report.model.push({
        branch: b.name,
        model: {
          name: m.name,
          version: m.version,
          updatedAt: m.updatedAt.toISOString(),
          updatedBy: m.updatedBy ?? m.createdBy,
          inputs,
          kpis: projection.kpis,
          failedChecks: Object.entries(projection.checks).filter(([, c]) => !c.pass).map(([k, c]) => `${k}: ${c.detail}`),
          valuation: valuationBlock,
          leaseSchedule: valuationBlock ? committedScheduleOf(inputs) : null,
        },
      });
    }
  }

  if (sections.has('returns')) {
    report.returns = [];
    for (const b of branches) {
      const model = await prisma.financialModel.findFirst({ where: { branchId: b.id, status: 'CURRENT' }, orderBy: { updatedAt: 'desc' } });
      if (!model) continue;
      const r = await getReturns({ modelId: model.id, horizonYears: 5 });
      // P5: the committed valuation (P3 series at the stored rate) is the
      // reported Project NPV/IRR/payback when present; legacy models without
      // a stored rate keep the legacy slice (never a substituted default).
      const c = isCommittedValued(r.committed) ? r.committed : null;
      report.returns.push({
        branch: b.name,
        model: r.source.modelName,
        initialInvestment: r.initialInvestment,
        paybackMonth: c?.paybackMonth ?? r.paybackMonth,
        paybackLabel: c
          ? c.simplePayback.label
          : (r.paybackMonth == null ? 'Beyond 5y' : `Month ${r.paybackMonth}`),
        irr: c?.irr.annualRate ?? r.irrAnnualised,
        irrDisplay: c
          ? c.irr.display
          : (r.irrAnnualised == null ? 'Not available' : `${(r.irrAnnualised * 100).toFixed(1)}%`),
        npv: c?.npv ?? r.npv.value,
        npvLabel: c
          ? `Project NPV (${c.committedMonths}-month committed term)`
          : r.npv.label,
        noiMarginPct: r.annualNoiMarginPct,
        valuationRate: c?.annualRate ?? r.npv.discountRatePct / 100,
        valuationRateSource: c?.annualRateSource ?? 'illustrative query rate',
        committedMonths: c?.committedMonths ?? null,
        committedEndDate: c?.committedEndDate ?? null,
      });
    }
  }

  return report;
}

export type FinanceReport = Awaited<ReturnType<typeof buildFinanceReport>>;

/** A facility's current approved financial model (null = none approved). */
export interface ReportModel {
  branch: string;
  model: {
    name: string;
    version: number;
    updatedAt: string;
    updatedBy: string;
    inputs: ProjectionInput;
    kpis: ProjectionKpis;
    failedChecks: string[];
    // Committed valuation identity (D7A) + committed schedule for the Year-N
    // lease table. Null for legacy models / rollout off (legacy shape kept).
    valuation: {
      annualRate: number; annualRateSource: string; committedMonths: number; committedEndDate: string;
    } | null;
    leaseSchedule: CommittedScheduleRow[] | null;
  } | null;
}

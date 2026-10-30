// Month close + posted actuals + Forecast vs Actuals (spec §12, Q6 DECIDED).
//
// Accrual basis (Q6): expenses recognised when incurred; ActualMetric rows
// are posted at close from source transactions. Posted months are IMMUTABLE —
// writes into a closed month are BLOCKED with a clear message; corrections
// arrive as NEW MonthCloseAdjustment events (the posted row is never edited).
// Until a month is posted the variance view carries nulls (the UI renders an
// em dash — never a fabricated zero).

import { prisma } from '../../lib/prisma';
import { toNum } from '../../lib/format';
import { AppError } from '../../lib/http';
import { writeAuditEvent } from './audit';
import { publishFinanceEvent } from './events';
import { assertFreshVersion, nextVersion, newCorrelationId } from './idempotency';
import { lineMonthWhere } from './reconciliation';
import { project } from './projection';

export const ACTUAL_METRICS = ['REVENUE', 'CASH', 'OPEX', 'LEASE', 'NOI', 'OCCUPIED_SQFT'] as const;
export type ActualMetricKey = (typeof ACTUAL_METRICS)[number];

const RECEIVABLE_FOR_REVENUE = ['ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID', 'PAID'] as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function parseFiscalMonth(s: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec((s ?? '').trim());
  if (!m) throw new AppError(400, 'VALIDATION', 'fiscalMonth must be YYYY-MM.');
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  return { start, end };
}

type Db = Pick<typeof prisma,
  'branch' | 'invoice' | 'expense' | 'financialModel' | 'unit' | 'monthClose' | 'actualMetric'
  | 'monthCloseAdjustment' | 'varianceNote' | 'settlementImport' | 'reconciliationBatch'
  | 'financeAuditEvent' | 'financeEvent'>;

/** True when the branch+month is CLOSED (posted actuals frozen). */
export async function isMonthClosed(branchId: string, fiscalMonth: string): Promise<boolean> {
  const row = await prisma.monthClose.findUnique({ where: { branchId_fiscalMonth: { branchId, fiscalMonth } } });
  return row?.status === 'CLOSED';
}

export interface ActualLine {
  metric: string;
  value: number;
  source: string;
}

/**
 * Proposed actuals from posted source records (spec §12.4). Accrual basis:
 * revenue over serviceStart, cash on paidAt, opex on incurredAt, lease from
 * the CURRENT model's approved schedule. A missing CURRENT model posts lease
 * 0 with source 'no-current-model' and raises a readiness warning (never a
 * silent fabrication — the source is stamped on the row).
 */
export async function computeActuals(branchId: string, fiscalMonth: string): Promise<{ lines: ActualLine[]; warnings: string[] }> {
  const { start, end } = parseFiscalMonth(fiscalMonth);
  const warnings: string[] = [];

  const invoices = await prisma.invoice.findMany({
    where: { unit: { branchId }, serviceStart: { gte: start, lt: end }, status: { in: [...RECEIVABLE_FOR_REVENUE] } },
    select: { amount: true, subtotal: true, creditApplied: true },
  });
  const revenue = round2(invoices.reduce((s, i) => s + (i.subtotal != null ? toNum(i.subtotal) : toNum(i.amount)) - toNum(i.creditApplied ?? 0), 0));

  const paid = await prisma.invoice.findMany({
    where: { unit: { branchId }, paidAt: { gte: start, lt: end } },
    select: { amountPaid: true },
  });
  const cash = round2(paid.reduce((s, i) => s + toNum(i.amountPaid ?? 0), 0));

  const expenses = await prisma.expense.findMany({
    where: { branchId, incurredAt: { gte: start, lt: end } },
    select: { amount: true },
  });
  const opex = round2(expenses.reduce((s, e) => s + toNum(e.amount), 0));

  let lease = 0;
  let leaseSource = 'approved-schedule';
  const current = await prisma.financialModel.findFirst({ where: { branchId, status: 'CURRENT' } });
  if (!current) {
    leaseSource = 'no-current-model';
    warnings.push('No CURRENT model for this facility — LEASE posts 0. Set a current model before closing.');
  } else {
    try {
      const inputs = current.inputs as unknown as { startDate?: string; lease?: { monthlyByYear?: number[]; rentFreeMonths?: number } };
      const { start: perfStart } = parseFiscalMonth(fiscalMonth);
      const modelStart = new Date(`${inputs.startDate ?? '2026-12-01'}T00:00:00Z`);
      const idx = (perfStart.getUTCFullYear() - modelStart.getUTCFullYear()) * 12 + (perfStart.getUTCMonth() - modelStart.getUTCMonth());
      if (idx < 0) {
        leaseSource = 'pre-model-start';
        warnings.push('Fiscal month predates the CURRENT model start — LEASE posts 0.');
      } else {
        const sched = inputs.lease?.monthlyByYear ?? [];
        const year = Math.floor(idx / 12);
        const contractual = sched.length ? (sched[Math.min(year, sched.length - 1)] ?? 0) : 0;
        const free = inputs.lease?.rentFreeMonths ?? 0;
        lease = round2(idx < free ? 0 : contractual);
      }
    } catch {
      leaseSource = 'schedule-unreadable';
      warnings.push('CURRENT model lease schedule is unreadable — LEASE posts 0.');
    }
  }

  const units = await prisma.unit.findMany({
    where: { branchId, status: 'OCCUPIED', deletedAt: null },
    select: { sqft: true },
  });
  const occupied = round2(units.reduce((s, u) => s + (u.sqft ?? 0), 0));

  const noi = round2(revenue - opex - lease);
  return {
    lines: [
      { metric: 'REVENUE', value: revenue, source: 'invoices:service-period' },
      { metric: 'CASH', value: cash, source: 'payments:paid-at' },
      { metric: 'OPEX', value: opex, source: 'expenses:incurred-at' },
      { metric: 'LEASE', value: lease, source: leaseSource },
      { metric: 'NOI', value: noi, source: 'derived:revenue-opex-lease' },
      { metric: 'OCCUPIED_SQFT', value: occupied, source: 'units:occupied-snapshot' },
    ],
    warnings,
  };
}

export interface CloseCheck {
  key: string;
  label: string;
  pass: boolean;
  detail: string;
}

/** Readiness checklist (spec §§12.3/20.5): every check must pass to close. */
export async function closeChecklist(branchId: string, fiscalMonth: string): Promise<CloseCheck[]> {
  const { start, end } = parseFiscalMonth(fiscalMonth);
  const drafts = await prisma.invoice.count({
    where: {
      unit: { branchId },
      status: 'DRAFT',
      OR: [{ billedMonth: { gte: start, lt: end } }, { serviceStart: { gte: start, lt: end } }],
    },
  });
  const unmatched = await prisma.settlementImport.count({
    where: { branchId, status: 'UNMATCHED', ...lineMonthWhere(fiscalMonth) },
  });
  const suspense = await prisma.settlementImport.count({
    where: { branchId, status: 'SUSPENSE', ...lineMonthWhere(fiscalMonth) },
  });
  const recon = await prisma.reconciliationBatch.findUnique({ where: { branchId_fiscalMonth: { branchId, fiscalMonth } } });
  return [
    {
      key: 'drafts',
      label: 'No draft invoices for the month',
      pass: drafts === 0,
      detail: drafts === 0 ? 'No DRAFT invoices reference this month.' : `${drafts} DRAFT invoice(s) still reference this month — approve/issue or void them first.`,
    },
    {
      key: 'unmatched',
      label: 'No unmatched settlement lines',
      pass: unmatched === 0,
      detail: unmatched === 0 ? 'Every imported settlement line is matched or partial.' : `${unmatched} settlement line(s) still UNMATCHED — match or suspend them first.`,
    },
    {
      key: 'suspense',
      label: 'No open suspense items',
      pass: suspense === 0,
      detail: suspense === 0 ? 'No suspense items open.' : `${suspense} suspense item(s) open — resolve them before closing.`,
    },
    {
      key: 'recon-batch',
      label: 'Reconciliation batch closed for the month',
      pass: recon?.status === 'CLOSED',
      detail: recon?.status === 'CLOSED' ? 'Batch closed.' : 'The reconciliation batch for this month is not CLOSED — close it first.',
    },
  ];
}

export interface MonthCloseRow {
  id: string;
  branchId: string;
  fiscalMonth: string;
  status: string;
  closedBy: string | null;
  closedAt: Date | null;
  version: number;
  actuals: ActualLine[];
  adjustments: Array<{ id: string; metric: string; amount: number; reason: string; author: string; createdAt: Date }>;
}

export async function getMonthClose(branchId: string, fiscalMonth: string): Promise<MonthCloseRow | null> {
  parseFiscalMonth(fiscalMonth);
  const row = await prisma.monthClose.findUnique({
    where: { branchId_fiscalMonth: { branchId, fiscalMonth } },
    include: { adjustments: { orderBy: { createdAt: 'asc' } } },
  });
  if (!row) return null;
  const metrics = await prisma.actualMetric.findMany({ where: { branchId, fiscalMonth } });
  return {
    id: row.id,
    branchId: row.branchId,
    fiscalMonth: row.fiscalMonth,
    status: row.status,
    closedBy: row.closedBy,
    closedAt: row.closedAt,
    version: row.version,
    actuals: metrics.map((m) => {
      const adj = row.adjustments.filter((a) => a.metric === m.metric).reduce((s, a) => s + toNum(a.amount), 0);
      return { metric: m.metric, value: round2(toNum(m.value) + adj), source: `${m.source ?? 'close'}${adj !== 0 ? '+adjustments' : ''}` };
    }),
    adjustments: row.adjustments.map((a) => ({ id: a.id, metric: a.metric, amount: toNum(a.amount), reason: a.reason, author: a.author, createdAt: a.createdAt })),
  };
}

export async function closeMonth(input: { branchId: string; fiscalMonth: string; actor: string; expectedVersion?: number }) {
  const { start } = parseFiscalMonth(input.fiscalMonth);
  const now = new Date();
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (start >= currentMonthStart) {
    throw new AppError(409, 'BLOCKED', `Month ${input.fiscalMonth} has not ended — close runs after calendar month end.`);
  }
  const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
  if (!branch) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
  const checks = await closeChecklist(input.branchId, input.fiscalMonth);
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    throw new AppError(409, 'BLOCKED', `Month close is blocked: ${failed.map((c) => c.detail).join(' ')}`, { checks });
  }
  const { lines, warnings } = await computeActuals(input.branchId, input.fiscalMonth);
  const correlationId = newCorrelationId();
  const calcHash = `${input.branchId}:${input.fiscalMonth}:${lines.map((l) => `${l.metric}=${l.value}`).join(',')}`;
  const row = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    let close = await db.monthClose.findUnique({ where: { branchId_fiscalMonth: { branchId: input.branchId, fiscalMonth: input.fiscalMonth } } });
    if (!close) {
      close = await db.monthClose.create({
        data: { branchId: input.branchId, fiscalMonth: input.fiscalMonth, status: 'OPEN', version: 0 },
      });
    }
    if (close.status === 'CLOSED') {
      throw new AppError(409, 'CONFLICT', 'This month is already CLOSED — post an adjustment instead of editing it.');
    }
    assertFreshVersion(close.version, input.expectedVersion, 'month-close');
    // Post immutable actuals (one row per metric — the unique anchor).
    for (const l of lines) {
      await db.actualMetric.upsert({
        where: { branchId_fiscalMonth_metric: { branchId: input.branchId, fiscalMonth: input.fiscalMonth, metric: l.metric } },
        create: { branchId: input.branchId, fiscalMonth: input.fiscalMonth, metric: l.metric, value: l.value, source: l.source },
        // OPEN months may re-compute on retry; CLOSED months never reach here.
        update: { value: l.value, source: l.source },
      });
    }
    // Anchor open expenses to this close (postedMonth immutability).
    const { start, end } = parseFiscalMonth(input.fiscalMonth);
    await prisma.expense.updateMany({
      where: { branchId: input.branchId, incurredAt: { gte: start, lt: end }, postedMonth: null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { postedMonth: input.fiscalMonth } as any,
    });
    const updated = await db.monthClose.update({
      where: { id: close.id, version: close.version },
      data: { status: 'CLOSED', closedBy: input.actor, closedAt: new Date(), calcHash, version: nextVersion(close.version) },
      include: { adjustments: true },
    });
    await writeAuditEvent(db, {
      actor: input.actor,
      action: 'MONTH_CLOSED',
      entityType: 'month-close',
      entityId: close.id,
      after: { fiscalMonth: input.fiscalMonth, calcHash, warnings },
      source: 'cms',
      correlationId,
      branchId: input.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'actuals.posted',
      payload: { branchId: input.branchId, fiscalMonth: input.fiscalMonth, lines, warnings },
      branchId: input.branchId,
      correlationId,
    });
    await publishFinanceEvent(db, {
      type: 'month.close.started',
      payload: { branchId: input.branchId, fiscalMonth: input.fiscalMonth, closedBy: input.actor },
      branchId: input.branchId,
      correlationId,
    });
    return updated;
  });
  const metrics = await prisma.actualMetric.findMany({ where: { branchId: input.branchId, fiscalMonth: input.fiscalMonth } });
  return {
    id: row.id,
    branchId: row.branchId,
    fiscalMonth: row.fiscalMonth,
    status: row.status,
    closedBy: row.closedBy,
    closedAt: row.closedAt,
    version: row.version,
    warnings,
    actuals: metrics.map((m) => ({ metric: m.metric, value: toNum(m.value), source: m.source })),
  };
}

/**
 * Post-close correction (spec §12.3 step 11): a NEW event. The posted
 * ActualMetric row is never edited — the adjustment folds into the variance
 * view with source 'adjustment'.
 */
export async function postCloseAdjustment(input: { branchId: string; fiscalMonth: string; metric: string; amount: number; reason: string; author: string }) {
  parseFiscalMonth(input.fiscalMonth);
  const metric = (input.metric ?? '').trim().toUpperCase();
  if (!ACTUAL_METRICS.includes(metric as ActualMetricKey)) {
    throw new AppError(400, 'VALIDATION', `Unknown metric ${input.metric} (expected one of ${ACTUAL_METRICS.join(', ')}).`);
  }
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount === 0) {
    throw new AppError(400, 'VALIDATION', 'Adjustment amount must be a non-zero finite number.');
  }
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new AppError(400, 'VALIDATION', 'An adjustment reason is required.');
  const close = await prisma.monthClose.findUnique({ where: { branchId_fiscalMonth: { branchId: input.branchId, fiscalMonth: input.fiscalMonth } } });
  if (!close || close.status !== 'CLOSED') {
    throw new AppError(409, 'CONFLICT', 'Adjustments apply to CLOSED months only — this month is still open (edit the sources instead).');
  }
  const correlationId = newCorrelationId();
  const adj = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const row = await db.monthCloseAdjustment.create({
      data: { monthCloseId: close.id, metric, amount: round2(input.amount), reason, author: input.author },
    });
    await writeAuditEvent(db, {
      actor: input.author,
      action: 'CLOSE_ADJUSTMENT_POSTED',
      entityType: 'month-close',
      entityId: close.id,
      after: { metric, amount: round2(input.amount), reason },
      reason,
      source: 'cms',
      correlationId,
      branchId: input.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'close.adjustment.posted',
      payload: { branchId: input.branchId, fiscalMonth: input.fiscalMonth, metric, amount: round2(input.amount), reason },
      branchId: input.branchId,
      correlationId,
    });
    return row;
  });
  return { id: adj.id, metric: adj.metric, amount: toNum(adj.amount), reason: adj.reason, author: adj.author, createdAt: adj.createdAt };
}

// ---------------------------------------------------------------------------
// Forecast vs Actuals view (spec §12)
// ---------------------------------------------------------------------------

export interface PerformanceRow {
  metric: string;
  budget: number | null;
  forecast: number | null;
  actual: number | null;
  variance: number | null;
  variancePct: number | null;
}

export interface PerformanceView {
  branchId: string;
  fiscalMonth: string;
  closed: boolean;
  rows: PerformanceRow[];
  notes: Array<{ id: string; metric: string; note: string; author: string; createdAt: Date }>;
  sources: { budget: string; forecast: string; actual: string };
}

export async function getPerformance(branchId: string, fiscalMonth: string): Promise<PerformanceView> {
  parseFiscalMonth(fiscalMonth);
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw new AppError(404, 'NOT_FOUND', 'Branch not found');

  // Budget: stored category rows for the month + the read-only lease line
  // from the CURRENT model (same derivation as the budgets screen).
  const budgets = await prisma.budget.findMany({ where: { branchId, fiscalMonth } });
  const budgetOpex = round2(budgets.reduce((s, b) => s + toNum(b.amount), 0));
  const current = await prisma.financialModel.findFirst({ where: { branchId, status: 'CURRENT' } });
  let budgetLease: number | null = null;
  if (current) {
    try {
      const inputs = current.inputs as unknown as { startDate?: string; lease?: { monthlyByYear?: number[]; rentFreeMonths?: number } };
      const { start } = parseFiscalMonth(fiscalMonth);
      const modelStart = new Date(`${inputs.startDate ?? '2026-12-01'}T00:00:00Z`);
      const idx = (start.getUTCFullYear() - modelStart.getUTCFullYear()) * 12 + (start.getUTCMonth() - modelStart.getUTCMonth());
      if (idx >= 0) {
        const sched = inputs.lease?.monthlyByYear ?? [];
        const contractual = sched.length ? (sched[Math.min(Math.floor(idx / 12), sched.length - 1)] ?? 0) : 0;
        budgetLease = round2(idx < (inputs.lease?.rentFreeMonths ?? 0) ? 0 : contractual);
      }
    } catch { budgetLease = null; }
  }
  const hasBudget = budgets.length > 0 || budgetLease !== null;
  const budgetByMetric: Record<string, number | null> = {
    REVENUE: null, // approved-baseline revenue lives in the model version, not Budget rows
    CASH: null,
    OPEX: hasBudget ? round2(budgetOpex) : null,
    LEASE: budgetLease,
    NOI: hasBudget && budgetLease !== null ? round2(0 - budgetOpex - budgetLease) : null,
    OCCUPIED_SQFT: null,
  };

  // Forecast: latest CURRENT model projection for the month (null outside the horizon).
  let forecastByMetric: Record<string, number | null> = { REVENUE: null, CASH: null, OPEX: null, LEASE: null, NOI: null, OCCUPIED_SQFT: null };
  let forecastSource = 'no-current-model';
  if (current) {
    try {
      const result = project(current.inputs as unknown as Parameters<typeof project>[0]);
      const m = result.months.find((x) => x.month === fiscalMonth);
      if (m) {
        forecastByMetric = {
          REVENUE: round2(m.revenue / 100),
          CASH: null,
          OPEX: round2(m.opexNonLease / 100),
          LEASE: round2(m.opexLease / 100),
          NOI: round2(m.noi / 100),
          OCCUPIED_SQFT: round2(m.closingSqft),
        };
        forecastSource = `model:${current.name}`;
      } else {
        forecastSource = 'month-outside-horizon';
      }
    } catch { forecastSource = 'model-unreadable'; }
  }

  // Actual: posted metrics + post-close adjustments; null until posted (em dash).
  const closed = await isMonthClosed(branchId, fiscalMonth);
  let actualByMetric: Record<string, number | null> = { REVENUE: null, CASH: null, OPEX: null, LEASE: null, NOI: null, OCCUPIED_SQFT: null };
  let actualSource = 'not-posted';
  if (closed) {
    const metrics = await prisma.actualMetric.findMany({ where: { branchId, fiscalMonth } });
    const close = await prisma.monthClose.findUnique({
      where: { branchId_fiscalMonth: { branchId, fiscalMonth } },
      include: { adjustments: true },
    });
    for (const m of metrics) {
      const adj = (close?.adjustments ?? []).filter((a) => a.metric === m.metric).reduce((s, a) => s + toNum(a.amount), 0);
      actualByMetric[m.metric] = round2(toNum(m.value) + adj);
    }
    actualSource = 'posted-actuals';
  }

  const rows: PerformanceRow[] = ACTUAL_METRICS.map((metric) => {
    const budget = budgetByMetric[metric] ?? null;
    const forecast = forecastByMetric[metric] ?? null;
    const actual = actualByMetric[metric] ?? null;
    // Variance compares actuals against forecast (forecast is the live plan);
    // never fabricate — null when either side is missing.
    const variance = actual !== null && forecast !== null ? round2(actual - forecast) : null;
    const variancePct = variance !== null && forecast !== null && forecast !== 0 ? round2((variance / forecast) * 100) : null;
    return { metric, budget, forecast, actual, variance, variancePct };
  });

  const notes = await prisma.varianceNote.findMany({
    where: { branchId, fiscalMonth },
    orderBy: { createdAt: 'asc' },
  });

  return {
    branchId,
    fiscalMonth,
    closed,
    rows,
    notes: notes.map((n) => ({ id: n.id, metric: n.metric, note: n.note, author: n.author, createdAt: n.createdAt })),
    sources: {
      budget: hasBudget ? 'budgets+current-model-lease' : 'no-budget',
      forecast: forecastSource,
      actual: actualSource,
    },
  };
}

export async function addVarianceNote(input: { branchId: string; fiscalMonth: string; metric: string; note: string; author: string }) {
  parseFiscalMonth(input.fiscalMonth);
  const metric = (input.metric ?? '').trim().toUpperCase();
  if (!ACTUAL_METRICS.includes(metric as ActualMetricKey)) {
    throw new AppError(400, 'VALIDATION', `Unknown metric ${input.metric} (expected one of ${ACTUAL_METRICS.join(', ')}).`);
  }
  const note = (input.note ?? '').trim();
  if (!note) throw new AppError(400, 'VALIDATION', 'A note is required.');
  if (note.length > 2000) throw new AppError(400, 'VALIDATION', 'Notes are capped at 2000 chars.');
  const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
  if (!branch) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
  const row = await prisma.varianceNote.create({
    data: { branchId: input.branchId, fiscalMonth: input.fiscalMonth, metric, note, author: input.author },
  });
  const correlationId = newCorrelationId();
  await writeAuditEvent(prisma, {
    actor: input.author,
    action: 'VARIANCE_NOTE_ADDED',
    entityType: 'variance-note',
    entityId: row.id,
    after: { fiscalMonth: input.fiscalMonth, metric, note },
    source: 'cms',
    correlationId,
    branchId: input.branchId,
  });
  return { id: row.id, metric: row.metric, note: row.note, author: row.author, createdAt: row.createdAt };
}

/**
 * Posted-actuals series for the Forecast vs Actuals bridge (spec §12.2). One
 * entry per CLOSED month with its immutable ActualMetric values (plus any
 * post-close adjustments folded in); open and future months are simply absent,
 * so the UI shows an em dash — never a fabricated actual. Also names the
 * facility's CURRENT model, which is the Budget baseline (§12.1).
 */
export async function getPerformanceSeries(branchId: string) {
  if (!branchId) throw new AppError(400, 'VALIDATION', 'branchId is required.');
  const [closes, metrics, current] = await Promise.all([
    prisma.monthClose.findMany({ where: { branchId, status: 'CLOSED' }, include: { adjustments: true }, orderBy: { fiscalMonth: 'asc' } }),
    prisma.actualMetric.findMany({ where: { branchId }, orderBy: { fiscalMonth: 'asc' } }),
    prisma.financialModel.findFirst({ where: { branchId, status: 'CURRENT' }, orderBy: { updatedAt: 'desc' }, select: { id: true, name: true, version: true } }),
  ]);
  const months = closes.map((c) => {
    const values: Record<string, number> = {};
    for (const m of metrics) if (m.fiscalMonth === c.fiscalMonth) values[m.metric] = toNum(m.value);
    for (const a of c.adjustments) values[a.metric] = round2((values[a.metric] ?? 0) + toNum(a.amount));
    return { fiscalMonth: c.fiscalMonth, closedAt: c.closedAt, closedBy: c.closedBy, values };
  });
  return { branchId, currentModel: current, months };
}

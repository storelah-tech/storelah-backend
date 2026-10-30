// Budgets & Expenses (FINANCE_MODULE_SPEC §13).
//
// Monthly non-lease Opex plans + the individual expenditure ledger. The
// landlord lease line is DERIVED read-only from the CURRENT model (§13.2:
// "Linked from Financial Model → Landlord Lease") — it is never a stored
// row, so it can never be edited here. Stored rows whose category matches
// the protected pattern (§13.5) are lease-line protected: PUT is denied
// unless the protected-override path is used (explicit flag + approver
// permission, every override writes an audit event).
//
// Scope of an update (§13.3): `month` only, or `month+future` open months.
// The scope never alters posted actual months — any write touching a CLOSED
// month is BLOCKED with a clear message; post-close changes arrive as new
// MonthCloseAdjustment events (Phase 4).

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { toNum } from '../../lib/format';
import { writeAuditEvent } from './audit';
import { publishFinanceEvent } from './events';
import { assertFreshVersion, nextVersion, newCorrelationId } from './idempotency';
import { isMonthClosed } from './monthClose';
import { getModel } from './models';

/** Categories reserved for the landlord lease line (§13.5). */
const PROTECTED_CATEGORY = /(lease|landlord\s*rent|premises\s*rent|property\s*rent)/i;

export function isProtectedCategory(category: string): boolean {
  return PROTECTED_CATEGORY.test(category.trim());
}

export function fiscalMonthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(fiscalMonth: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(fiscalMonth);
  if (!m) throw new AppError(400, 'VALIDATION', `fiscalMonth must be YYYY-MM, got ${fiscalMonth}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The CURRENT baseline model for a branch (lease source + forecast source). */
async function currentModelFor(branchId: string | null) {
  if (!branchId) return null;
  const m = await prisma.financialModel.findFirst({
    where: { branchId, status: 'CURRENT' },
    orderBy: { updatedAt: 'desc' },
  });
  return m;
}

/** Derived read-only lease line for a fiscal month (§13.2). */
function leaseLineFor(model: { name: string; inputs: unknown } | null, fiscalMonth: string) {
  if (!model) {
    return {
      id: `lease:${fiscalMonth}`,
      category: 'Landlord lease',
      amount: null as number | null,
      protected: true,
      linked: false,
      note: 'Not yet connected — no CURRENT model. Set a model as Current to link the lease line.',
    };
  }
  const inputs = model.inputs as {
    startDate: string; lease: { monthlyByYear: number[] };
  };
  const [sy, sm] = fiscalMonth.split('-').map(Number);
  const [y0, m0] = inputs.startDate.split('-').map(Number);
  const monthIndex = (sy - y0) * 12 + (sm - m0);
  if (monthIndex < 0) {
    return {
      id: `lease:${fiscalMonth}`, category: 'Landlord lease', amount: null,
      protected: true, linked: true, note: 'Month precedes the model start — no lease applies.',
    };
  }
  const year = Math.floor(monthIndex / 12);
  const schedule = inputs.lease.monthlyByYear;
  const amount = schedule[Math.min(year, schedule.length - 1)] ?? 0;
  return {
    id: `lease:${fiscalMonth}`, category: 'Landlord lease', amount, protected: true,
    linked: true, sourceModel: model.name,
    note: 'Linked from Financial Model → Landlord Lease. Edit the lease in Financial Models.',
  };
}

export async function listBudgets(opts: { branchId: string; fiscalMonth?: string }) {
  if (!opts.branchId) throw new AppError(400, 'VALIDATION', 'branchId is required for budgets.');
  const months = opts.fiscalMonth ? [opts.fiscalMonth] : [fiscalMonthOf(new Date())];
  if (opts.fiscalMonth && !/^\d{4}-\d{2}$/.test(opts.fiscalMonth)) {
    throw new AppError(400, 'VALIDATION', `fiscalMonth must be YYYY-MM, got ${opts.fiscalMonth}`);
  }
  const model = await currentModelFor(opts.branchId);
  const out = [];
  for (const fiscalMonth of months) {
    const rows = await prisma.budget.findMany({
      where: { branchId: opts.branchId, fiscalMonth },
      orderBy: { category: 'asc' },
    });
    const withActuals = await Promise.all(
      rows.map(async (b) => {
        const expenses = await prisma.expense.findMany({ where: { budgetId: b.id } });
        const actual = expenses.reduce((s, e) => s + toNum(e.amount), 0);
        return {
          id: b.id,
          category: b.category,
          budget: toNum(b.amount),
          actual,
          committed: 0,
          forecast: toNum(b.amount),
          variance: actual - toNum(b.amount),
          protected: b.protected,
          version: b.version,
          note: b.protected ? 'Protected lease-category line — updates require the protected override.' : undefined,
        };
      }),
    );
    const lease = leaseLineFor(model, fiscalMonth);
    const leaseAmount = lease.amount ?? 0;
    const other = withActuals.reduce((s, r) => s + r.budget, 0);
    out.push({
      fiscalMonth,
      lease,
      lines: withActuals,
      summary: {
        lease: lease.amount,
        otherOpex: other,
        totalOperating: lease.amount === null ? null : leaseAmount + other,
      },
    });
  }
  return opts.fiscalMonth ? out[0] : out;
}

export async function createBudget(opts: {
  branchId: string; fiscalMonth: string; category: string; amount: number; actor: string;
}) {
  const category = opts.category.trim();
  if (!category) throw new AppError(400, 'VALIDATION', 'Budget category is required.');
  if (!/^\d{4}-\d{2}$/.test(opts.fiscalMonth)) {
    throw new AppError(400, 'VALIDATION', `fiscalMonth must be YYYY-MM, got ${opts.fiscalMonth}`);
  }
  if (!(opts.amount >= 0)) throw new AppError(400, 'VALIDATION', 'Budget amount cannot be negative.');
  if (isProtectedCategory(category)) {
    throw new AppError(400, 'VALIDATION', `Category "${category}" is reserved for the landlord lease line — the lease is linked from the Financial Model, not stored here. Use a distinct configured category with finance approval.`);
  }
  const branch = await prisma.branch.findUnique({ where: { id: opts.branchId } });
  if (!branch) throw new AppError(404, 'NOT_FOUND', `Branch ${opts.branchId} not found.`);
  if (await isMonthClosed(opts.branchId, opts.fiscalMonth)) {
    throw new AppError(409, 'BLOCKED', `Budget month ${opts.fiscalMonth} is CLOSED — posted months are immutable. Record a variance note instead.`);
  }
  const correlationId = newCorrelationId();
  try {
    const created = await prisma.$transaction(async (tx) => {
      const b = await tx.budget.create({
        data: {
          branchId: opts.branchId, fiscalMonth: opts.fiscalMonth, category,
          amount: new Prisma.Decimal(opts.amount), protected: false, createdBy: opts.actor, version: 0,
        },
      });
      await writeAuditEvent(tx, {
        branchId: opts.branchId, actor: opts.actor, action: 'BUDGET_CREATED',
        entityType: 'budget', entityId: b.id,
        after: { fiscalMonth: b.fiscalMonth, category, amount: opts.amount },
        reason: 'Budget line created', source: 'cms', correlationId,
      });
      await publishFinanceEvent(tx, {
        type: 'budget.updated', payload: { budgetId: b.id, scope: 'month' },
        branchId: opts.branchId, correlationId,
      });
      return b;
    });
    return { id: created.id, branchId: created.branchId, fiscalMonth: created.fiscalMonth, category: created.category, amount: toNum(created.amount), protected: created.protected, version: created.version };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(409, 'CONFLICT', `A budget line for "${category}" in ${opts.fiscalMonth} already exists — update it instead.`);
    }
    throw e;
  }
}

/**
 * Scoped budget update (§13.3). `scope: 'month'` rewrites the selected month
 * only; `scope: 'month+future'` upserts the same category for the selected
 * month and the next 11 open months. Protected rows deny unless
 * `protectedOverride: true` AND the caller holds bill-budgets:approve (the
 * route checks the permission and passes `canOverride` in).
 */
export async function updateBudget(opts: {
  id: string;
  amount: number;
  scope?: 'month' | 'month+future';
  expectedVersion?: number;
  protectedOverride?: boolean;
  canOverride?: boolean;
  actor: string;
}) {
  const stored = await prisma.budget.findUnique({ where: { id: opts.id } });
  if (!stored) {
    if (opts.id.startsWith('lease:')) {
      throw new AppError(403, 'FORBIDDEN', 'The landlord lease line is linked from the Financial Model — edit it in Financial Models → Landlord Lease. It can never be edited here.');
    }
    throw new AppError(404, 'NOT_FOUND', `Budget ${opts.id} not found.`);
  }
  if (!(opts.amount >= 0)) throw new AppError(400, 'VALIDATION', 'Budget amount cannot be negative.');
  assertFreshVersion(stored.version, opts.expectedVersion, 'Budget');
  if (stored.protected && !(opts.protectedOverride === true && opts.canOverride === true)) {
    throw new AppError(403, 'PROTECTED', `Budget line "${stored.category}" is lease-line protected — updates need the protected override (an approver confirms the lease change it represents).`, {
      protected: true,
    });
  }
  const scope = opts.scope ?? 'month';
  const months = scope === 'month+future'
    ? Array.from({ length: 12 }, (_, i) => shiftMonth(stored.fiscalMonth, i))
    : [stored.fiscalMonth];
  // Posted months are immutable — block before touching anything.
  const closed = [];
  for (const fiscalMonth of months) {
    if (await isMonthClosed(stored.branchId, fiscalMonth)) closed.push(fiscalMonth);
  }
  if (closed.length > 0) {
    throw new AppError(409, 'BLOCKED', `Budget month(s) ${closed.join(', ')} are CLOSED — posted months are immutable. Pick an open scope instead.`);
  }
  const correlationId = newCorrelationId();
  const affected: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (const fiscalMonth of months) {
      const row = await tx.budget.findUnique({
        where: { branchId_fiscalMonth_category: { branchId: stored.branchId, fiscalMonth, category: stored.category } },
      });
      if (row) {
        if (row.protected && !(opts.protectedOverride === true && opts.canOverride === true)) continue; // never widen a protected line silently
        await tx.budget.update({
          where: { id: row.id },
          data: { amount: new Prisma.Decimal(opts.amount), version: nextVersion(row.version) },
        });
        affected.push(fiscalMonth);
      } else if (fiscalMonth === stored.fiscalMonth || scope === 'month+future') {
        await tx.budget.create({
          data: {
            branchId: stored.branchId, fiscalMonth, category: stored.category,
            amount: new Prisma.Decimal(opts.amount), protected: stored.protected, createdBy: opts.actor, version: 0,
          },
        });
        affected.push(fiscalMonth);
      }
    }
    await writeAuditEvent(tx, {
      branchId: stored.branchId, actor: opts.actor, action: 'BUDGET_UPDATED',
      entityType: 'budget', entityId: stored.id,
      before: { amount: toNum(stored.amount), version: stored.version },
      after: { amount: opts.amount, scope, affectedMonths: affected, protectedOverride: opts.protectedOverride === true },
      reason: `Budget ${scope === 'month' ? 'month updated' : 'updated for month + future months'}`,
      source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'budget.updated', payload: { budgetId: stored.id, scope, affectedMonths: affected },
      branchId: stored.branchId, correlationId,
    });
  });
  return { id: stored.id, scope, affectedMonths: affected, amount: opts.amount };
}

export async function listExpenses(opts: { branchId: string; from?: Date; to?: Date; category?: string }) {
  if (!opts.branchId) throw new AppError(400, 'VALIDATION', 'branchId is required for expenses.');
  const rows = await prisma.expense.findMany({
    where: {
      branchId: opts.branchId,
      ...(opts.category ? { category: opts.category } : {}),
      ...((opts.from || opts.to) ? { incurredAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } : {}),
    },
    orderBy: { incurredAt: 'desc' },
    take: 500,
  });
  return rows.map((e) => ({
    id: e.id, branchId: e.branchId, budgetId: e.budgetId, vendor: e.vendor,
    category: e.category, amount: toNum(e.amount), incurredAt: e.incurredAt,
    receiptRef: e.receiptRef, description: e.description, status: e.status, note: e.note,
    postedMonth: e.postedMonth, createdBy: e.createdBy, createdAt: e.createdAt,
  }));
}

/** Records an expenditure immediately (ledger write, §13.4). */
export async function recordExpense(opts: {
  branchId: string; category: string; amount: number; incurredAt: Date;
  vendor?: string; receiptRef?: string; budgetId?: string; actor: string;
  description?: string; status?: ExpenseStatus; note?: string;
}) {
  const category = opts.category.trim();
  if (isProtectedCategory(category)) throw new AppError(400, 'VALIDATION', `Category "${category}" is reserved for the model-linked landlord lease.`);
  if (!category) throw new AppError(400, 'VALIDATION', 'Expense category is required.');
  if (!(opts.amount > 0)) throw new AppError(400, 'VALIDATION', 'Expense amount must be greater than zero.');
  if (Number.isNaN(opts.incurredAt.getTime())) throw new AppError(400, 'VALIDATION', 'incurredAt must be a valid date.');
  const branch = await prisma.branch.findUnique({ where: { id: opts.branchId } });
  if (!branch) throw new AppError(404, 'NOT_FOUND', `Branch ${opts.branchId} not found.`);
  if (await isMonthClosed(opts.branchId, fiscalMonthOf(opts.incurredAt))) {
    throw new AppError(409, 'BLOCKED', `Expense month ${fiscalMonthOf(opts.incurredAt)} is CLOSED — post a close adjustment instead of a back-dated expense.`);
  }
  if (opts.budgetId) {
    const b = await prisma.budget.findUnique({ where: { id: opts.budgetId } });
    if (!b || b.branchId !== opts.branchId) throw new AppError(404, 'NOT_FOUND', `Budget ${opts.budgetId} not found in this facility.`);
  }
  const correlationId = newCorrelationId();
  const created = await prisma.$transaction(async (tx) => {
    const e = await tx.expense.create({
      data: {
        branchId: opts.branchId, budgetId: opts.budgetId ?? null,
        incurredAt: opts.incurredAt, vendor: opts.vendor?.trim() || null,
        category, amount: new Prisma.Decimal(opts.amount),
        receiptRef: opts.receiptRef?.trim() || null, createdBy: opts.actor,
        description: opts.description?.trim() || null, note: opts.note?.trim() || null,
        status: opts.status ?? 'PAID',
      },
    });
    await writeAuditEvent(tx, {
      branchId: opts.branchId, actor: opts.actor, action: 'EXPENSE_RECORDED',
      entityType: 'expense', entityId: e.id,
      after: { category, amount: opts.amount, incurredAt: opts.incurredAt },
      reason: 'Expenditure recorded', source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'expense.recorded', payload: { expenseId: e.id, category, amount: opts.amount },
      branchId: opts.branchId, correlationId,
    });
    return e;
  });
  return {
    id: created.id, branchId: created.branchId, budgetId: created.budgetId,
    category: created.category, amount: toNum(created.amount), incurredAt: created.incurredAt,
    vendor: created.vendor, receiptRef: created.receiptRef,
    description: created.description, status: created.status, note: created.note,
  };
}

export const EXPENSE_STATUSES = ['DRAFT', 'COMMITTED', 'PAID'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/**
 * Edits an open expenditure line (§13.4). A line in a CLOSED month is
 * immutable — corrections go through a close adjustment.
 */
export async function updateExpense(opts: {
  id: string; actor: string;
  patch: Partial<{ category: string; amount: number; incurredAt: Date; vendor: string; receiptRef: string; description: string; status: ExpenseStatus; note: string }>;
}) {
  const e = await prisma.expense.findUnique({ where: { id: opts.id } });
  if (!e) throw new AppError(404, 'NOT_FOUND', `Expense ${opts.id} not found.`);
  const months = [fiscalMonthOf(e.incurredAt), ...(opts.patch.incurredAt ? [fiscalMonthOf(opts.patch.incurredAt)] : [])];
  for (const m of months) {
    if (e.postedMonth || await isMonthClosed(e.branchId, m)) {
      throw new AppError(409, 'BLOCKED', `Expense month ${m} is CLOSED — post a close adjustment instead.`);
    }
  }
  if (opts.patch.category !== undefined && isProtectedCategory(opts.patch.category)) {
    throw new AppError(400, 'VALIDATION', `Category "${opts.patch.category}" is reserved for the model-linked landlord lease.`);
  }
  if (opts.patch.amount !== undefined && !(opts.patch.amount > 0)) throw new AppError(400, 'VALIDATION', 'Expense amount must be greater than zero.');
  const data: Prisma.ExpenseUpdateInput = {};
  if (opts.patch.category !== undefined) data.category = opts.patch.category.trim();
  if (opts.patch.amount !== undefined) data.amount = new Prisma.Decimal(opts.patch.amount);
  if (opts.patch.incurredAt !== undefined) data.incurredAt = opts.patch.incurredAt;
  for (const k of ['vendor', 'receiptRef', 'description', 'note'] as const) {
    if (opts.patch[k] !== undefined) data[k] = opts.patch[k]?.trim() || null;
  }
  if (opts.patch.status !== undefined) data.status = opts.patch.status;
  const correlationId = newCorrelationId();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.expense.update({ where: { id: e.id }, data });
    await writeAuditEvent(tx, {
      branchId: e.branchId, actor: opts.actor, action: 'EXPENSE_UPDATED',
      entityType: 'expense', entityId: e.id,
      before: { category: e.category, amount: toNum(e.amount), status: e.status },
      after: { category: u.category, amount: toNum(u.amount), status: u.status },
      reason: 'Expenditure updated', source: 'cms', correlationId,
    });
    return u;
  });
  return {
    id: updated.id, branchId: updated.branchId, category: updated.category, amount: toNum(updated.amount),
    incurredAt: updated.incurredAt, vendor: updated.vendor, receiptRef: updated.receiptRef,
    description: updated.description, status: updated.status, note: updated.note,
  };
}

/** Expense-ledger CSV export (audited at the route layer). */
export function expensesExportCsv(rows: Awaited<ReturnType<typeof listExpenses>>): string {
  const esc = (v: string | number | null): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ['id,incurred_at,category,vendor,amount,receipt_ref,created_by'];
  for (const e of rows) {
    lines.push([e.id, e.incurredAt.toISOString(), e.category, e.vendor ?? '', e.amount, e.receiptRef ?? '', e.createdBy].map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

// Re-exported for the lease sync note in Financial Models views.
export { getModel };

// Arrears + recovery workflow (spec §18, owner Q5 v1.2 DECIDED timings).
//
// Stages: OPEN → REMINDER → FORMAL_NOTICE → LATE_FEE_POSTED → RESTRICTED →
// RESOLVED. Every advance is POLICY-GATED by editable Global Settings timings
// (graceDays default 0 = overdue the day after due date; late fees from +7d;
// access restriction at +14d) — `policyGated` records which settings gated
// each action. Termination steps are UNDECIDED: never built, the terminate
// path answers BLOCKED naming the missing decision (documented stub).
//
// Late-fee amount/formula is UNDECIDED: read from editable FacilityFee
// (kind FEE, key lateFee) or a finance.lateFeeAmount BusinessRule; when unset
// → posting BLOCKED with a clear message (requireDecided — never guess).
// Posting appends a FEE line to the receivable invoice (one receivable per
// service period); waiving appends a CREDIT line. Access restriction is a
// restriction state on the account + CMS workflow + cleared on resolve;
// physical-gate integration is explicitly OUT of scope.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { toNum } from '../../lib/format';
import { AppError } from '../../lib/http';
import { writeAuditEvent } from './audit';
import { publishFinanceEvent } from './events';
import { assertFreshVersion, nextVersion, newCorrelationId } from './idempotency';
import { getFinancePolicies, requireDecided } from './policies';
import { resolveFee } from '../fees';
import { isMonthClosed } from './monthClose';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const ARREARS_STAGES = ['OPEN', 'REMINDER', 'FORMAL_NOTICE', 'LATE_FEE_POSTED', 'RESTRICTED', 'RESOLVED'] as const;
const NEXT: Record<string, string> = {
  OPEN: 'REMINDER',
  REMINDER: 'FORMAL_NOTICE',
  FORMAL_NOTICE: 'LATE_FEE_POSTED',
  LATE_FEE_POSTED: 'RESTRICTED',
};
const RECEIVABLE = ['ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID'] as const;

type Db = Pick<typeof prisma,
  'tenant' | 'invoice' | 'invoiceLine' | 'arrearsCase' | 'lateFeeWaiver'
  | 'financeAuditEvent' | 'financeEvent'>;

function startOfTodayUtc(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

export function daysOverdueAsOf(dueDate: Date, graceDays: number, asOf: Date = startOfTodayUtc()): number {
  const ms = asOf.getTime() - new Date(Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate())).getTime();
  return Math.floor(ms / 86400000) - graceDays;
}

// ---------------------------------------------------------------------------
// Late-fee amount (UNDECIDED — FacilityFee or BusinessRule, else BLOCKED)
// ---------------------------------------------------------------------------

export interface LateFeeConfig {
  amount: number;
  source: string;
}

export async function resolveLateFee(opts: { branchId?: string | null; tenantId?: string; monthlyRate: number }): Promise<LateFeeConfig> {
  const fee = await resolveFee({ kind: 'FEE', key: 'lateFee', branchId: opts.branchId ?? undefined, tenantId: opts.tenantId });
  if (fee) {
    const raw = toNum(fee.amount);
    const kind = (fee.amountKind ?? 'FLAT').toUpperCase();
    const amount = kind === 'PCT' ? round2((opts.monthlyRate * raw) / 100) : kind === 'MONTHS' ? round2(opts.monthlyRate * raw) : round2(raw);
    if (!(amount > 0)) {
      throw new AppError(409, 'BLOCKED', 'The configured late fee resolves to zero — set a positive FacilityFee lateFee before posting.');
    }
    return { amount, source: `FacilityFee lateFee (${fee.matchedScope}, ${kind})` };
  }
  const rule = await prisma.businessRule.findUnique({ where: { key: 'finance.lateFeeAmount' } });
  const flat = rule && rule.active ? Number(rule.value as unknown as number) : NaN;
  if (Number.isFinite(flat) && flat > 0) {
    return { amount: round2(flat), source: 'BusinessRule finance.lateFeeAmount' };
  }
  requireDecided(null, 'FacilityFee lateFee / BusinessRule finance.lateFeeAmount',
    'Configure a late-fee amount (FacilityFee kind FEE key lateFee, or a finance.lateFeeAmount BusinessRule) before posting late fees.');
  throw new AppError(500, 'INTERNAL', 'Unreachable');
}

// ---------------------------------------------------------------------------
// Serializers + reads
// ---------------------------------------------------------------------------

export interface ArrearsCaseRow {
  id: string;
  tenantId: string;
  tenant: string;
  tenantEmail: string | null;
  branchId: string | null;
  branch: string | null;
  invoiceId: string | null;
  invoiceNo: string | null;
  invoiceStatus: string | null;
  balanceDue: number | null;
  dueDate: Date | null;
  stage: string;
  assignee: string | null;
  note: string | null;
  policyGated: unknown;
  daysOverdue: number;
  accessRestricted: boolean;
  openedAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  version: number;
}

type CaseWithJoins = Prisma.ArrearsCaseGetPayload<{
  include: { tenant: { include: { unit: { include: { branch: true } } } } };
}>;

function serializeCase(c: CaseWithJoins, graceDays: number): ArrearsCaseRow {
  const inv = (c as unknown as { invoice?: { id: string; invoiceNo: string; status: string; balanceDue: unknown; amount: unknown; amountPaid: unknown; dueDate: Date } | null }).invoice ?? null;
  const unit = c.tenant.unit;
  const due = inv?.dueDate ?? null;
  return {
    id: c.id,
    tenantId: c.tenantId,
    tenant: c.tenant.name,
    tenantEmail: c.tenant.email,
    branchId: c.branchId,
    branch: unit?.branch?.name ?? null,
    invoiceId: inv?.id ?? (c.invoiceId as string | null) ?? null,
    invoiceNo: inv?.invoiceNo ?? null,
    invoiceStatus: inv?.status ?? null,
    balanceDue: inv ? (inv.balanceDue != null ? toNum(inv.balanceDue as never) : round2(toNum(inv.amount as never) - toNum(inv.amountPaid as never))) : null,
    dueDate: due,
    stage: c.stage,
    assignee: c.assignee,
    note: c.note,
    policyGated: c.policyGated,
    daysOverdue: due ? Math.max(0, daysOverdueAsOf(due, graceDays)) : c.daysOverdue,
    accessRestricted: c.tenant.accessRestricted,
    openedAt: c.openedAt,
    closedAt: c.closedAt,
    closeReason: c.closeReason,
    version: c.version,
  };
}

async function loadCase(id: string): Promise<CaseWithJoins> {
  const row = (await prisma.arrearsCase.findUnique({
    where: { id },
    include: { tenant: { include: { unit: { include: { branch: true } } } } },
  })) as CaseWithJoins | null;
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Arrears case not found');
  return row;
}
export async function listArrearsCases(opts: { branchId?: string; stage?: string; tenantId?: string }) {
  const policies = await getFinancePolicies();

  if (opts.stage && !(ARREARS_STAGES as readonly string[]).includes(opts.stage)) {
    throw new AppError(400, 'VALIDATION', `Unknown arrears stage ${opts.stage}.`);
  }
  const rows = (await prisma.arrearsCase.findMany({
    where: {
      ...(opts.stage ? { stage: opts.stage } : {}),
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(opts.branchId ? { branchId: opts.branchId } : {}),
    },
    include: { tenant: { include: { unit: { include: { branch: true } } } } },
    orderBy: { openedAt: 'desc' },
  })) as CaseWithJoins[];
  // Attach the case invoice for the balance/due derivation.
  const out: ArrearsCaseRow[] = [];
  for (const r of rows) {
    let invoice = null;
    if (r.invoiceId) {
      invoice = await prisma.invoice.findUnique({ where: { id: r.invoiceId as string } });
    }
    out.push(serializeCase({ ...r, invoice } as unknown as CaseWithJoins, policies.graceDays));
  }
  return out;
}

export async function getArrearsCase(id: string) {
  const policies = await getFinancePolicies();
  const row = await loadCase(id);
  const invoice = row.invoiceId
    ? await prisma.invoice.findUnique({ where: { id: row.invoiceId as string } })
    : null;
  return serializeCase({ ...row, invoice } as unknown as CaseWithJoins, policies.graceDays);
}

/** Overdue receivables without (or with) an open case — the work queue. */
export async function listArrearsCandidates(branchId?: string) {
  const policies = await getFinancePolicies();
  const cutoff = new Date(startOfTodayUtc().getTime() - policies.graceDays * 86400000);
  const invoices = await prisma.invoice.findMany({
    where: {
      status: { in: [...RECEIVABLE] },
      dueDate: { lt: cutoff },
      ...(branchId ? { unit: { branchId } } : {}),
    },
    include: { tenant: true, unit: { include: { branch: true } } },
    orderBy: { dueDate: 'asc' },
    take: 200,
  });
  const openCases = await prisma.arrearsCase.findMany({
    where: { stage: { not: 'RESOLVED' }, ...(branchId ? { branchId } : {}) },
    select: { tenantId: true, invoiceId: true },
  });
  const openKeys = new Set(openCases.map((c) => `${c.tenantId}:${c.invoiceId ?? ''}`));
  return invoices.map((i) => {
    const total = toNum(i.amount);
    const paid = toNum(i.amountPaid ?? 0);
    return {
      tenantId: i.tenantId,
      tenant: i.tenant.name,
      tenantEmail: i.tenant.email,
      branchId: i.unit.branchId,
      branch: i.unit.branch.name,
      unit: i.unit.unitCode,
      invoiceId: i.id,
      invoiceNo: i.invoiceNo,
      invoiceStatus: i.status,
      balanceDue: i.balanceDue != null ? toNum(i.balanceDue) : round2(total - paid),
      dueDate: i.dueDate,
      daysOverdue: Math.max(0, daysOverdueAsOf(i.dueDate, policies.graceDays)),
      hasOpenCase: openKeys.has(`${i.tenantId}:${i.id}`) || openKeys.has(`${i.tenantId}:`),
      accessRestricted: i.tenant.accessRestricted,
    };
  });
}

// ---------------------------------------------------------------------------
// Open / advance / close
// ---------------------------------------------------------------------------

export async function openArrearsCase(input: { tenantId: string; invoiceId?: string; assignee?: string; note?: string; actor: string }) {
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, include: { unit: true } });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', 'Tenant not found');
  let invoice = null;
  if (input.invoiceId) {
    invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
    if (!invoice || invoice.tenantId !== input.tenantId) {
      throw new AppError(404, 'NOT_FOUND', 'Invoice not found for this tenant');
    }
  }
  const dup = await prisma.arrearsCase.findFirst({
    where: {
      tenantId: input.tenantId,
      ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}),
      stage: { not: 'RESOLVED' },
    },
    select: { id: true },
  });
  if (dup) throw new AppError(409, 'CONFLICT', 'An open arrears case already exists for this tenant/invoice.');
  const correlationId = newCorrelationId();
  const policies = await getFinancePolicies();
  const row = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const created = (await db.arrearsCase.create({
      data: {
        tenantId: tenant.id,
        invoiceId: input.invoiceId ?? null,
        branchId: tenant.branchId,
        stage: 'OPEN',
        assignee: input.assignee?.trim() || null,
        note: input.note?.trim() || null,
        policyGated: { graceDays: policies.graceDays },
        daysOverdue: invoice ? Math.max(0, daysOverdueAsOf(invoice.dueDate, policies.graceDays)) : 0,
        version: 0,
      },
      include: { tenant: { include: { unit: { include: { branch: true } } } } },
    })) as CaseWithJoins;
    await writeAuditEvent(db, {
      actor: input.actor,
      action: 'ARREARS_CASE_OPENED',
      entityType: 'arrears-case',
      entityId: created.id,
      after: { tenantId: tenant.id, invoiceId: input.invoiceId ?? null, stage: 'OPEN' },
      reason: input.note?.trim() || undefined,
      source: 'cms',
      correlationId,
      branchId: tenant.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'arrears.case.opened',
      payload: { caseId: created.id, tenantId: tenant.id, invoiceId: input.invoiceId ?? null },
      branchId: tenant.branchId,
      correlationId,
    });
    return created;
  });
  const withInv = invoice ? { ...row, invoice } : row;
  return serializeCase(withInv as unknown as CaseWithJoins, policies.graceDays);
}

export async function advanceArrearsCase(id: string, opts: { expectedVersion?: number; actor: string; note?: string }) {
  const policies = await getFinancePolicies();
  const row = await loadCase(id);
  if (row.stage === 'RESOLVED') throw new AppError(409, 'CONFLICT', 'This case is RESOLVED — reopen it by opening a new case.');
  const next = NEXT[row.stage];
  if (!next) throw new AppError(409, 'CONFLICT', `No further advance from ${row.stage} (resolve the case or use the recovery actions).`);
  const invoice = row.invoiceId
    ? await prisma.invoice.findUnique({ where: { id: row.invoiceId as string } })
    : null;
  const daysOverdue = invoice ? Math.max(0, daysOverdueAsOf(invoice.dueDate, policies.graceDays)) : row.daysOverdue;
  assertFreshVersion(row.version, opts.expectedVersion, 'arrears-case');
  const correlationId = newCorrelationId();
  const gated: Record<string, unknown> = {
    graceDays: policies.graceDays,
    lateFeeAfterDays: policies.lateFeeAfterDays,
    accessRestrictAfterDays: policies.accessRestrictAfterDays,
  };

  // Stage gates (all timings editable in Global Settings).
  if (next === 'REMINDER' && daysOverdue < 1) {
    throw new AppError(409, 'BLOCKED', `Reminders go to accounts at least 1 day overdue (graceDays = ${policies.graceDays}).`);
  }
  if ((next === 'FORMAL_NOTICE' || next === 'LATE_FEE_POSTED') && daysOverdue < policies.lateFeeAfterDays) {
    throw new AppError(409, 'BLOCKED',
      `Formal notices and late fees start ${policies.lateFeeAfterDays} day(s) after the due date (finance.lateFeeAfterDays) — this account is ${daysOverdue} day(s) overdue.`);
  }
  if (next === 'RESTRICTED' && daysOverdue < policies.accessRestrictAfterDays) {
    throw new AppError(409, 'BLOCKED',
      `Access restriction starts ${policies.accessRestrictAfterDays} day(s) after the due date (finance.accessRestrictAfterDays) — this account is ${daysOverdue} day(s) overdue.`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    if (!invoice && (next === 'LATE_FEE_POSTED' || next === 'RESTRICTED')) {
      throw new AppError(409, 'CONFLICT', `Advancing to ${next} needs a case invoice (open the case against one first).`);
    }
    if (invoice && !(RECEIVABLE as readonly string[]).includes(invoice.status) && next !== 'RESTRICTED') {
      throw new AppError(409, 'CONFLICT', `The case invoice is ${invoice.status} — resolve the case instead of advancing it.`);
    }
    // LATE_FEE_POSTED appends the configured fee to the receivable invoice.
    let feePosted: { amount: number; source: string } | null = null;
    if (next === 'LATE_FEE_POSTED' && invoice) {
      if (invoice.serviceStart && row.branchId && (await isMonthClosed(row.branchId, fiscalMonthOf(invoice.serviceStart)))) {
        throw new AppError(409, 'BLOCKED', 'This invoice sits in a closed month — post an adjustment document instead of editing it.');
      }
      const tenant = await prisma.tenant.findUnique({ where: { id: row.tenantId } });
      const cfg = await resolveLateFee({ branchId: row.branchId, tenantId: row.tenantId, monthlyRate: toNum(tenant?.monthlyRate ?? 0) });
      const fee = cfg.amount;
      const total = round2(toNum(invoice.amount) + fee);
      const due = round2((invoice.balanceDue != null ? toNum(invoice.balanceDue) : total - fee) + fee);
      await db.invoiceLine.create({
        data: { invoiceId: invoice.id, kind: 'FEE', label: 'Late fee', amount: fee, refId: row.id },
      });
      await db.invoice.update({ where: { id: invoice.id }, data: { amount: total, balanceDue: due } });
      feePosted = { amount: fee, source: cfg.source };
    }
    // RESTRICTED flips the account-level restriction (physical gates out of scope).
    if (next === 'RESTRICTED') {
      await prisma.tenant.update({
        where: { id: row.tenantId },
        data: { accessRestricted: true, accessRestrictedAt: new Date(), accessRestrictedReason: `Arrears case ${row.id} — ${daysOverdue} days overdue` },
      });
    }
    const after = (await db.arrearsCase.update({
      where: { id, version: row.version },
      data: {
        stage: next,
        note: opts.note?.trim() ? opts.note.trim() : row.note,
        policyGated: { ...((row.policyGated as unknown as Record<string, unknown> | null) ?? {}), [next]: gated } as unknown as Prisma.InputJsonValue,
        daysOverdue,
        version: nextVersion(row.version),
      },
      include: { tenant: { include: { unit: { include: { branch: true } } } } },
    })) as CaseWithJoins;
    await writeAuditEvent(db, {
      actor: opts.actor,
      action: next === 'RESTRICTED' ? 'ARREARS_ACCESS_RESTRICTED' : 'ARREARS_CASE_ADVANCED',
      entityType: 'arrears-case',
      entityId: id,
      before: { stage: row.stage, version: row.version },
      after: { stage: next, daysOverdue, feePosted },
      reason: opts.note?.trim() || undefined,
      source: 'cms',
      correlationId,
      branchId: row.branchId,
    });
    await publishFinanceEvent(db, {
      type: next === 'RESTRICTED' ? 'arrears.access.restricted' : 'arrears.case.advanced',
      payload: { caseId: id, from: row.stage, to: next, daysOverdue, feePosted },
      branchId: row.branchId,
      correlationId,
    });
    if (feePosted) {
      await publishFinanceEvent(db, {
        type: 'late.fee.posted',
        payload: { caseId: id, invoiceId: invoice!.id, ...feePosted },
        branchId: row.branchId,
        correlationId,
      });
    }
    return after;
  });
  const withInv = invoice ? { ...updated, invoice: await prisma.invoice.findUnique({ where: { id: invoice.id } }) } : updated;
  return serializeCase(withInv as unknown as CaseWithJoins, policies.graceDays);
}

/** Termination steps are UNDECIDED — documented stub, always BLOCKED. */
export function requestTerminationHelp(): never {
  throw new AppError(409, 'BLOCKED',
    'Termination steps are undecided — configure the termination policy (notice period, lockout procedure, legal review) before building this action. This stub exists so the UI can name the missing decision instead of guessing.');
}

export async function closeArrearsCase(id: string, opts: { expectedVersion?: number; actor: string; reason: 'payment' | 'write-off' | 'other'; note?: string }) {
  const policies = await getFinancePolicies();
  const row = await loadCase(id);
  if (row.stage === 'RESOLVED') throw new AppError(409, 'CONFLICT', 'This case is already RESOLVED.');
  if (!['payment', 'write-off', 'other'].includes(opts.reason)) {
    throw new AppError(400, 'VALIDATION', 'Close reason must be payment, write-off or other.');
  }
  assertFreshVersion(row.version, opts.expectedVersion, 'arrears-case');
  const correlationId = newCorrelationId();
  const updated = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    // Resolving restores account access (restriction was case-scoped).
    if (row.tenant.accessRestricted) {
      await prisma.tenant.update({
        where: { id: row.tenantId },
        data: { accessRestricted: false, accessRestrictedAt: null, accessRestrictedReason: null },
      });
    }
    const after = (await db.arrearsCase.update({
      where: { id, version: row.version },
      data: {
        stage: 'RESOLVED',
        closedAt: new Date(),
        closeReason: opts.reason,
        note: opts.note?.trim() ? opts.note.trim() : row.note,
        version: nextVersion(row.version),
      },
      include: { tenant: { include: { unit: { include: { branch: true } } } } },
    })) as CaseWithJoins;
    await writeAuditEvent(db, {
      actor: opts.actor,
      action: 'ARREARS_CASE_RESOLVED',
      entityType: 'arrears-case',
      entityId: id,
      before: { stage: row.stage, version: row.version },
      after: { stage: 'RESOLVED', closeReason: opts.reason },
      reason: opts.note?.trim() || undefined,
      source: 'cms',
      correlationId,
      branchId: row.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'arrears.case.resolved',
      payload: { caseId: id, from: row.stage, to: 'RESOLVED', closeReason: opts.reason },
      branchId: row.branchId,
      correlationId,
    });
    return after;
  });
  return serializeCase(updated, policies.graceDays);
}

// ---------------------------------------------------------------------------
// Waive late fee (Q5 REQUIRED): operator request + approver gate. Approval
// appends a CREDIT line to the invoice — never edits history.
// ---------------------------------------------------------------------------

export interface WaiverRow {
  id: string;
  tenantId: string;
  tenant: string;
  branchId: string | null;
  invoiceId: string | null;
  amount: number;
  reason: string;
  status: string;
  requestedBy: string;
  approvedBy: string | null;
  version: number;
  createdAt: Date;
}

type WaiverWithTenant = Prisma.LateFeeWaiverGetPayload<{ include: { tenant: true } }>;

export function serializeWaiver(w: WaiverWithTenant): WaiverRow {
  return {
    id: w.id,
    tenantId: w.tenantId,
    tenant: w.tenant.name,
    branchId: w.branchId,
    invoiceId: w.invoiceId,
    amount: toNum(w.amount),
    reason: w.reason,
    status: w.status,
    requestedBy: w.requestedBy,
    approvedBy: w.approvedBy,
    version: w.version,
    createdAt: w.createdAt,
  };
}

export async function listWaivers(opts: { tenantId?: string; branchId?: string; status?: string }) {
  const waiverStatuses = ['REQUESTED', 'APPROVED', 'REJECTED'] as const;
  if (opts.status && !(waiverStatuses as readonly string[]).includes(opts.status)) {
    throw new AppError(400, 'VALIDATION', `Unknown waiver status ${opts.status}.`);
  }
  const rows = (await prisma.lateFeeWaiver.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(opts.branchId ? { branchId: opts.branchId } : {}),
    },
    include: { tenant: true },
    orderBy: { createdAt: 'desc' },
  })) as WaiverWithTenant[];
  return rows.map(serializeWaiver);
}

export async function requestWaiver(input: { tenantId: string; invoiceId: string; amount: number; reason: string; actor: string; idempotencyKey?: string | null }) {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new AppError(400, 'VALIDATION', 'A waiver reason is required.');
  if (!(input.amount > 0)) throw new AppError(400, 'VALIDATION', 'Waiver amount must be positive.');
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', 'Tenant not found');
  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice || invoice.tenantId !== input.tenantId) {
    throw new AppError(404, 'NOT_FOUND', 'Invoice not found for this tenant');
  }
  if (!(RECEIVABLE as readonly string[]).includes(invoice.status)) {
    throw new AppError(409, 'CONFLICT', `Only a receivable invoice carries waivable fees (this one is ${invoice.status}).`);
  }
  const open = invoice.balanceDue != null ? toNum(invoice.balanceDue) : round2(toNum(invoice.amount) - toNum(invoice.amountPaid ?? 0));
  if (input.amount - open > 0.005) {
    throw new AppError(409, 'CONFLICT', `Waiver amount ${input.amount} exceeds the invoice balance ${open}.`);
  }
  const correlationId = newCorrelationId();
  const row = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    if (input.idempotencyKey) {
      const prior = (await db.lateFeeWaiver.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: { tenant: true },
      })) as WaiverWithTenant | null;
      if (prior) return { row: prior, deduplicated: true };
    }
    const created = (await db.lateFeeWaiver.create({
      data: {
        tenantId: tenant.id,
        invoiceId: invoice.id,
        branchId: tenant.branchId,
        amount: round2(input.amount),
        reason,
        status: 'REQUESTED',
        requestedBy: input.actor,
        idempotencyKey: input.idempotencyKey ?? `waiver-${correlationId}`,
        version: 0,
      },
      include: { tenant: true },
    })) as WaiverWithTenant;
    await writeAuditEvent(db, {
      actor: input.actor,
      action: 'LATE_FEE_WAIVER_REQUESTED',
      entityType: 'late-fee-waiver',
      entityId: created.id,
      after: { invoiceId: invoice.id, amount: round2(input.amount), reason },
      reason,
      source: 'cms',
      correlationId,
      branchId: tenant.branchId,
    });
    return { row: created, deduplicated: false };
  });
  return { waiver: serializeWaiver(row.row), deduplicated: row.deduplicated };
}

export async function decideWaiver(id: string, opts: { approve: boolean; expectedVersion?: number; actor: string; isOwner: boolean; reason?: string }) {
  const now = await prisma.lateFeeWaiver.findUnique({ where: { id } });
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Waiver not found');
  if (now.status !== 'REQUESTED') throw new AppError(409, 'CONFLICT', `Only REQUESTED waivers can be decided (this one is ${now.status}).`);
  let bypassed = false;
  if (opts.actor === now.requestedBy && !opts.isOwner) {
    throw new AppError(403, 'MAKER_CHECKER', 'The requestor cannot approve their own waiver — a different approver is required.');
  }
  if (opts.actor === now.requestedBy && opts.isOwner) {
    if (!(opts.reason ?? '').trim()) throw new AppError(400, 'VALIDATION', 'A reason is required for a super-admin single-step.');
    bypassed = true;
  }
  assertFreshVersion(now.version, opts.expectedVersion, 'late-fee-waiver');
  const decisionReason = (opts.reason ?? '').trim() || null;
  const correlationId = newCorrelationId();
  const row = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    if (!opts.approve) {
      if (!decisionReason) throw new AppError(400, 'VALIDATION', 'A rejection reason is required.');
      const rejected = (await db.lateFeeWaiver.update({
        where: { id, version: now.version },
        data: { status: 'REJECTED', approvedBy: opts.actor, decidedAt: new Date(), version: nextVersion(now.version) },
        include: { tenant: true },
      })) as WaiverWithTenant;
      await writeAuditEvent(db, {
        actor: opts.actor,
        action: 'LATE_FEE_WAIVER_REJECTED',
        entityType: 'late-fee-waiver',
        entityId: id,
        after: { status: 'REJECTED' },
        reason: decisionReason,
        source: 'cms',
        correlationId,
        branchId: rejected.branchId,
      });
      return rejected;
    }
    const invoice = await prisma.invoice.findUnique({ where: { id: now.invoiceId as string } });
    if (!invoice || !(RECEIVABLE as readonly string[]).includes(invoice.status)) {
      throw new AppError(409, 'CONFLICT', 'The invoice is no longer receivable — the waiver cannot be applied.');
    }
    if (invoice.serviceStart && now.branchId && (await isMonthClosed(now.branchId, fiscalMonthOf(invoice.serviceStart)))) {
      throw new AppError(409, 'BLOCKED', 'This invoice sits in a closed month — post an adjustment document instead of editing it.');
    }
    const open = invoice.balanceDue != null ? toNum(invoice.balanceDue) : round2(toNum(invoice.amount) - toNum(invoice.amountPaid ?? 0));
    const amount = Math.min(toNum(now.amount), open);
    const newCredit = round2(toNum(invoice.creditApplied ?? 0) + amount);
    const newDue = round2(open - amount);
    const paidInFull = newDue <= 0.005;
    await db.invoiceLine.create({
      data: { invoiceId: invoice.id, kind: 'CREDIT', label: 'Late fee waived', amount: -amount, refId: id },
    });
    await db.invoice.update({
      where: { id: invoice.id },
      data: {
        creditApplied: newCredit,
        balanceDue: paidInFull ? 0 : newDue,
        ...(paidInFull ? { status: 'PAID', paidAt: new Date(), method: 'Credit' } : {}),
      },
    });
    const approved = (await db.lateFeeWaiver.update({
      where: { id, version: now.version },
      data: { status: 'APPROVED', approvedBy: opts.actor, decidedAt: new Date(), version: nextVersion(now.version) },
      include: { tenant: true },
    })) as WaiverWithTenant;
    await writeAuditEvent(db, {
      actor: opts.actor,
      action: 'LATE_FEE_WAIVED',
      entityType: 'invoice',
      entityId: invoice.id,
      before: { balanceDue: open },
      after: { waived: amount, balanceDue: paidInFull ? 0 : newDue, waiverId: id, bypassed },
      reason: decisionReason ?? undefined,
      source: 'cms',
      correlationId,
      branchId: approved.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'late.fee.waived',
      payload: { waiverId: id, invoiceId: invoice.id, amount, bypassed },
      branchId: approved.branchId,
      correlationId,
    });
    return approved;
  });
  return serializeWaiver(row);
}

function fiscalMonthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

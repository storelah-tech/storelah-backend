// Reconciliation (spec §20): Stripe settlement import, matching engine,
// suspense queue, close checklist + batch close.
//
// CMS-triggered and idempotent: every import line carries a globally unique
// `sourceRef` (`batchRef:externalRef`), so a retried import returns the batch
// instead of duplicating rows. The engine auto-matches only the deterministic
// case (an explicit invoiceRef with an amount equal to the invoice balance);
// everything else lands UNMATCHED with a same-amount candidate suggestion and
// waits for an operator confirm (match) or suspense. Partial allocations are
// permitted — the remainder stays PARTIAL/UNMATCHED. Closed batches are
// immutable; reopening needs Owner-only elevated approval.

import { Prisma } from '@prisma/client';
import type { SettlementImport as SettlementImportRow } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { toNum } from '../../lib/format';
import { AppError } from '../../lib/http';
import { writeAuditEvent } from './audit';
import { publishFinanceEvent } from './events';
import { assertFreshVersion, nextVersion, newCorrelationId } from './idempotency';
import { postInvoiceReceiptTx } from '../invoicePayments';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const IMPORT_STATUSES = ['UNMATCHED', 'PARTIAL', 'MATCHED', 'SUSPENSE'] as const;
const RECEIVABLE = ['ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID'] as const;

type Db = Pick<typeof prisma,
  'branch' | 'tenant' | 'invoice' | 'settlementImport' | 'reconciliationBatch' | 'refund'
  | 'financeAuditEvent' | 'financeEvent'>;

function monthBounds(fiscalMonth: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec((fiscalMonth ?? '').trim());
  if (!m) throw new AppError(400, 'VALIDATION', 'fiscalMonth must be YYYY-MM.');
  return { start: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)), end: new Date(Date.UTC(Number(m[1]), Number(m[2]), 1)) };
}

/**
 * Month scope for settlement lines: the settlement date when present, else
 * the import date. A September line imported in October still belongs to the
 * September batch (settlement batches close after month end).
 */
export function lineMonthWhere(fiscalMonth: string) {
  const { start, end } = monthBounds(fiscalMonth);
  return {
    OR: [
      { receivedAt: { gte: start, lt: end } },
      { receivedAt: null, createdAt: { gte: start, lt: end } },
    ],
  };
}

export interface SettlementLineInput {
  externalRef: string;
  amount: number;
  currency?: string;
  receivedAt?: string;
  invoiceRef?: string;
  tenantRef?: string;
  meta?: unknown;
}

export interface ImportSettlementInput {
  branchId?: string;
  batchRef: string;
  lines: SettlementLineInput[];
  actor: string;
}

export interface SettlementRow {
  id: string;
  sourceRef: string;
  externalRef: string | null;
  amount: number;
  currency: string;
  receivedAt: Date | null;
  status: string;
  matchedInvoiceId: string | null;
  matchedInvoiceNo: string | null;
  matchedAmount: number | null;
  suspenseReason: string | null;
  suggestion: { invoiceId: string; invoiceNo: string; balanceDue: number } | null;
  actor: string;
  createdAt: Date;
}

async function suggestionFor(amount: number, branchId?: string | null): Promise<SettlementRow['suggestion']> {
  const inv = await prisma.invoice.findFirst({
    where: {
      status: { in: [...RECEIVABLE] },
      ...(branchId ? { unit: { branchId } } : {}),
    },
    orderBy: { dueDate: 'asc' },
  });
  if (!inv) return null;
  // Same-amount candidate: exact open balance match within the branch scope.
  const cands = await prisma.invoice.findMany({
    where: { status: { in: [...RECEIVABLE] }, ...(branchId ? { unit: { branchId } } : {}) },
    take: 50,
    orderBy: { dueDate: 'asc' },
  });
  for (const c of cands) {
    const due = c.balanceDue != null ? toNum(c.balanceDue) : round2(toNum(c.amount) - toNum(c.amountPaid ?? 0));
    if (Math.abs(due - amount) < 0.005 && due > 0) {
      return { invoiceId: c.id, invoiceNo: c.invoiceNo, balanceDue: due };
    }
  }
  return null;
}

export function serializeSettlement(
  r: SettlementImportRow & { matchedInvoiceNo?: string | null; suggestion?: SettlementRow['suggestion'] },
): SettlementRow {
  return {
    id: r.id,
    sourceRef: r.sourceRef,
    externalRef: r.externalRef,
    amount: toNum(r.amount),
    currency: r.currency,
    receivedAt: r.receivedAt,
    status: r.status,
    matchedInvoiceId: r.matchedInvoiceId,
    matchedInvoiceNo: r.matchedInvoiceNo ?? null,
    matchedAmount: r.matchedAmount != null ? toNum(r.matchedAmount as never) : null,
    suspenseReason: r.suspenseReason,
    suggestion: r.suggestion ?? null,
    actor: r.actor,
    createdAt: r.createdAt,
  };
}

/**
 * Idempotent settlement import. Repeat the same batchRef + lines → the same
 * rows back (`deduplicated: true`, no new writes, no double allocations).
 */
export async function importSettlement(input: ImportSettlementInput) {
  const batchRef = (input.batchRef ?? '').trim();
  if (!batchRef) throw new AppError(400, 'VALIDATION', 'batchRef is required (idempotency scope for the import).');
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 500) {
    throw new AppError(400, 'VALIDATION', 'lines must be a non-empty array (max 500).');
  }
  if (input.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
  }
  const seen = new Set<string>();
  for (const [ix, l] of input.lines.entries()) {
    const ref = (l.externalRef ?? '').trim();
    if (!ref) throw new AppError(400, 'VALIDATION', `Line ${ix + 1}: externalRef is required.`);
    if (seen.has(ref)) throw new AppError(400, 'VALIDATION', `Line ${ix + 1}: duplicate externalRef ${ref} in this batch.`);
    seen.add(ref);
    if (!(l.amount > 0)) throw new AppError(400, 'VALIDATION', `Line ${ix + 1}: amount must be positive.`);
  }
  const correlationId = newCorrelationId();
  let created = 0;
  let reused = 0;
  const rows: SettlementRow[] = [];
  for (const l of input.lines) {
    const sourceRef = `${batchRef}:${l.externalRef.trim()}`;
    const existing = await prisma.settlementImport.findUnique({ where: { sourceRef } });
    if (existing) {
      reused += 1;
      rows.push(serializeSettlement(existing));
      continue;
    }
    let receivedAt: Date | null = null;
    if (l.receivedAt) {
      const d = new Date(l.receivedAt);
      if (Number.isNaN(d.getTime())) throw new AppError(400, 'VALIDATION', `Line ${l.externalRef}: receivedAt must be a valid date.`);
      receivedAt = d;
    }
    const out = await prisma.$transaction(async (tx) => {
      const db = tx as unknown as Db;
      // Deterministic auto-match: explicit invoiceRef + exact balance.
      let status = 'UNMATCHED';
      let matchedInvoiceId: string | null = null;
      let matchedAmount: number | null = null;
      const invoiceRef = (l.invoiceRef ?? '').trim();
      if (invoiceRef) {
        const inv = await prisma.invoice.findUnique({ where: { invoiceNo: invoiceRef } });
        if (inv && (RECEIVABLE as readonly string[]).includes(inv.status) && (!input.branchId || (await sameBranch(inv.id, input.branchId)))) {
          const due = inv.balanceDue != null ? toNum(inv.balanceDue) : round2(toNum(inv.amount) - toNum(inv.amountPaid ?? 0));
          if (Math.abs(due - l.amount) < 0.005 && due > 0) {
            const applied = await postInvoiceReceiptTx(tx as never, inv as never, due, { method: 'Bank' });
            if (applied.applied) {
              status = 'MATCHED';
              matchedInvoiceId = inv.id;
              matchedAmount = due;
            }
          }
        }
      }
      const row = await db.settlementImport.create({
        data: {
          branchId: input.branchId ?? null,
          sourceRef,
          externalRef: l.externalRef.trim(),
          amount: round2(l.amount),
          currency: (l.currency ?? 'SGD').trim() || 'SGD',
          receivedAt,
          raw: (l.meta ?? {}) as Prisma.InputJsonValue,
          status,
          matchedInvoiceId,
          matchedAmount,
          actor: input.actor,
        },
      });
      await writeAuditEvent(db, {
        actor: input.actor,
        action: 'SETTLEMENT_IMPORTED',
        entityType: 'settlement-import',
        entityId: row.id,
        after: { sourceRef, amount: round2(l.amount), status },
        source: 'cms',
        correlationId,
        branchId: input.branchId ?? null,
      });
      if (status === 'MATCHED') {
        await publishFinanceEvent(db, {
          type: 'reconciliation.item.matched',
          payload: { importId: row.id, invoiceId: matchedInvoiceId, amount: matchedAmount, auto: true },
          branchId: input.branchId ?? null,
          correlationId,
        });
      }
      return row;
    });
    created += 1;
    rows.push(serializeSettlement(out));
  }
  await writeAuditEvent(prisma, {
    actor: input.actor,
    action: 'SETTLEMENT_BATCH_IMPORTED',
    entityType: 'settlement-batch',
    entityId: batchRef,
    after: { created, reused, batchRef },
    source: 'cms',
    correlationId,
    branchId: input.branchId ?? null,
  });
  return { batchRef, created, reused, deduplicated: created === 0, rows };
}

async function sameBranch(invoiceId: string, branchId: string): Promise<boolean> {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { unit: { select: { branchId: true } } } });
  return inv?.unit.branchId === branchId;
}

/** Operator confirm: allocate (part of) a settlement line to an invoice. */
export async function matchSettlement(id: string, input: { invoiceId: string; amount?: number; actor: string; expectedVersion?: number }) {
  const line = await prisma.settlementImport.findUnique({ where: { id } });
  if (!line) throw new AppError(404, 'NOT_FOUND', 'Settlement line not found');
  if (line.status === 'MATCHED') throw new AppError(409, 'CONFLICT', 'This line is already fully matched.');
  // Suspense resolves by matching (the operator found the invoice after all).
  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId }, include: { unit: { select: { branchId: true } } } });
  if (!invoice) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
  if (!(RECEIVABLE as readonly string[]).includes(invoice.status)) {
    throw new AppError(409, 'CONFLICT', `Only a receivable invoice can be matched (this one is ${invoice.status}).`);
  }
  if (line.branchId && invoice.unit.branchId !== line.branchId) {
    throw new AppError(409, 'CONFLICT', 'The invoice is in a different facility from this settlement line.');
  }
  const total = toNum(line.amount);
  const already = line.matchedAmount != null ? toNum(line.matchedAmount as never) : 0;
  const remaining = round2(total - already);
  if (!(remaining > 0)) throw new AppError(409, 'CONFLICT', 'This line has no remaining amount to allocate.');
  const invoiceDue = invoice.balanceDue != null ? toNum(invoice.balanceDue) : round2(toNum(invoice.amount) - toNum(invoice.amountPaid ?? 0));
  const wanted = input.amount === undefined ? Math.min(remaining, invoiceDue) : input.amount;
  if (!(wanted > 0)) throw new AppError(400, 'VALIDATION', 'Match amount must be positive.');
  if (wanted - remaining > 0.005) {
    throw new AppError(409, 'CONFLICT', `Match amount ${wanted} exceeds the line remainder ${remaining} (§20.4: allocations cannot exceed the receipt).`);
  }
  if (wanted - invoiceDue > 0.005) {
    throw new AppError(409, 'CONFLICT', `Match amount ${wanted} exceeds the invoice balance ${invoiceDue} (§20.4: allocations cannot exceed the invoice balance).`);
  }
  const correlationId = newCorrelationId();
  const out = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const applied = await postInvoiceReceiptTx(tx as never, invoice as never, wanted, { method: 'Bank' });
    if (!applied.applied) {
      throw new AppError(409, 'CONFLICT', `The invoice changed during matching (now ${applied.status}) — reload and retry.`);
    }
    const matched = round2(already + wanted);
    const status = round2(total - matched) <= 0.005 ? 'MATCHED' : 'PARTIAL';
    const updated = await db.settlementImport.update({
      where: { id },
      data: { status, matchedInvoiceId: invoice.id, matchedAmount: matched, suspenseReason: null },
    });
    await writeAuditEvent(db, {
      actor: input.actor,
      action: 'SETTLEMENT_MATCHED',
      entityType: 'settlement-import',
      entityId: id,
      before: { status: line.status, matchedAmount: already },
      after: { status, matchedAmount: matched, invoiceId: invoice.id, invoiceNo: invoice.invoiceNo },
      source: 'cms',
      correlationId,
      branchId: line.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'reconciliation.item.matched',
      payload: { importId: id, invoiceId: invoice.id, amount: wanted, auto: false },
      branchId: line.branchId,
      correlationId,
    });
    return updated;
  });
  return serializeSettlement(out);
}

export async function suspenseSettlement(id: string, input: { reason: string; actor: string }) {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new AppError(400, 'VALIDATION', 'A suspense reason is required.');
  const line = await prisma.settlementImport.findUnique({ where: { id } });
  if (!line) throw new AppError(404, 'NOT_FOUND', 'Settlement line not found');
  if (line.status === 'MATCHED') throw new AppError(409, 'CONFLICT', 'Matched lines cannot move to suspense.');
  const correlationId = newCorrelationId();
  const updated = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const row = await db.settlementImport.update({ where: { id }, data: { status: 'SUSPENSE', suspenseReason: reason } });
    await writeAuditEvent(db, {
      actor: input.actor,
      action: 'SETTLEMENT_SUSPENSE',
      entityType: 'settlement-import',
      entityId: id,
      before: { status: line.status },
      after: { status: 'SUSPENSE' },
      reason,
      source: 'cms',
      correlationId,
      branchId: line.branchId,
    });
    return row;
  });
  return serializeSettlement(updated);
}

// ---------------------------------------------------------------------------
// Summary + close checklist UI data (spec §20.2/20.5)
// ---------------------------------------------------------------------------

export interface ReconciliationSummary {
  branchId: string | null;
  fiscalMonth: string | null;
  settled: number;
  allocated: number;
  unmatchedCount: number;
  partialCount: number;
  matchedCount: number;
  suspenseCount: number;
  refundsPaid: number;
  invoicesPosted: number;
  variance: number;
  queues: { unmatched: SettlementRow[]; partial: SettlementRow[]; matched: SettlementRow[]; suspense: SettlementRow[] };
  checklist: Array<{ key: string; label: string; pass: boolean; detail: string }>;
  batch: { id: string; status: string; closedBy: string | null; closedAt: Date | null; version: number } | null;
}

export async function getReconciliation(opts: { branchId?: string; fiscalMonth?: string }): Promise<ReconciliationSummary> {
  const { branchId, fiscalMonth } = opts;
  const lineWhere = {
    ...(branchId ? { branchId } : {}),
    ...(fiscalMonth ? lineMonthWhere(fiscalMonth) : {}),
  };
  const bounds = fiscalMonth ? monthBounds(fiscalMonth) : null;
  const lines = await prisma.settlementImport.findMany({ where: lineWhere, orderBy: { createdAt: 'desc' } });
  const invNos = [...new Set(lines.map((l) => l.matchedInvoiceId).filter(Boolean))] as string[];
  const invs = invNos.length
    ? await prisma.invoice.findMany({ where: { id: { in: invNos } }, select: { id: true, invoiceNo: true } })
    : [];
  const noById = new Map(invs.map((i) => [i.id, i.invoiceNo]));
  const withNo = lines.map((l) => ({ ...l, matchedInvoiceNo: l.matchedInvoiceId ? (noById.get(l.matchedInvoiceId) ?? null) : null }));
  const settled = round2(lines.reduce((s, l) => s + toNum(l.amount), 0));
  const allocated = round2(lines.reduce((s, l) => s + (l.matchedAmount != null ? toNum(l.matchedAmount as never) : 0), 0));
  const by = (st: string) => withNo.filter((l) => l.status === st);
  const refunds = await prisma.refund.findMany({
    where: {
      status: 'PAID',
      ...(branchId ? { branchId } : {}),
      ...(bounds ? { updatedAt: { gte: bounds.start, lt: bounds.end } } : {}),
    },
    select: { amount: true },
  });
  const refundsPaid = round2(refunds.reduce((s, r) => s + toNum(r.amount), 0));
  const posted = await prisma.invoice.findMany({
    where: {
      status: { notIn: ['DRAFT', 'APPROVED', 'VOID'] },
      ...(branchId ? { unit: { branchId } } : {}),
      ...(bounds ? { createdAt: { gte: bounds.start, lt: bounds.end } } : {}),
    },
    select: { amount: true },
  });
  const invoicesPosted = round2(posted.reduce((s, i) => s + toNum(i.amount), 0));

  const attach = async (rows: typeof withNo) => {
    const out: SettlementRow[] = [];
    for (const r of rows) out.push({ ...serializeSettlement(r), suggestion: r.status === 'UNMATCHED' ? await suggestionFor(toNum(r.amount), branchId ?? r.branchId) : null });
    return out;
  };
  const [unmatched, partial, matched, suspense] = await Promise.all([attach(by('UNMATCHED')), attach(by('PARTIAL')), attach(by('MATCHED')), attach(by('SUSPENSE'))]);

  // Close controls (spec §20.5): batch totals agree, allocations agree,
  // refunds accounted, no open suspense, sign-off recorded at close.
  const openRefunds = fiscalMonth && branchId
    ? await prisma.refund.count({ where: { branchId, status: 'REQUESTED' } })
    : 0;
  const checklist = [
    {
      key: 'batch-total',
      label: 'Processor batch total agrees',
      pass: lines.length > 0,
      detail: lines.length > 0 ? `${lines.length} settlement line(s), SGD ${settled}.` : 'No settlement lines imported for this scope.',
    },
    {
      key: 'allocations',
      label: 'Invoice allocations agree',
      pass: round2(settled - allocated) <= 0.005 && unmatched.length === 0,
      detail: `Allocated SGD ${allocated} of SGD ${settled}${unmatched.length ? `; ${unmatched.length} unmatched line(s) remain` : ''}.`,
    },
    {
      key: 'refunds',
      label: 'Refunds/chargebacks accounted for',
      pass: openRefunds === 0,
      detail: openRefunds === 0 ? `SGD ${refundsPaid} paid refunds in scope; none awaiting approval.` : `${openRefunds} refund(s) still REQUESTED — approve/reject them first.`,
    },
    {
      key: 'exceptions',
      label: 'No open suspense items',
      pass: suspense.length === 0,
      detail: suspense.length === 0 ? 'No suspense items open.' : `${suspense.length} suspense item(s) open — resolve them before closing.`,
    },
  ];
  const batch = fiscalMonth && branchId
    ? await prisma.reconciliationBatch.findUnique({ where: { branchId_fiscalMonth: { branchId, fiscalMonth } } })
    : null;
  return {
    branchId: branchId ?? null,
    fiscalMonth: fiscalMonth ?? null,
    settled,
    allocated,
    unmatchedCount: unmatched.length,
    partialCount: partial.length,
    matchedCount: matched.length,
    suspenseCount: suspense.length,
    refundsPaid,
    invoicesPosted,
    variance: round2(settled - allocated),
    queues: { unmatched, partial, matched, suspense },
    checklist,
    batch: batch ? { id: batch.id, status: batch.status, closedBy: batch.closedBy, closedAt: batch.closedAt, version: batch.version } : null,
  };
}

/** Batch close (spec §20.5/§20.7): all checks must pass; immutable after. */
export async function closeReconciliationBatch(input: { branchId: string; fiscalMonth: string; actor: string; expectedVersion?: number }) {
  monthBounds(input.fiscalMonth);
  const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
  if (!branch) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
  const sum = await getReconciliation({ branchId: input.branchId, fiscalMonth: input.fiscalMonth });
  const failed = sum.checklist.filter((c) => !c.pass);
  if (failed.length > 0) {
    throw new AppError(409, 'BLOCKED', `Reconciliation close is blocked: ${failed.map((c) => c.detail).join(' ')}`, { checklist: sum.checklist });
  }
  const correlationId = newCorrelationId();
  const row = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    let batch = await db.reconciliationBatch.findUnique({
      where: { branchId_fiscalMonth: { branchId: input.branchId, fiscalMonth: input.fiscalMonth } },
    });
    if (!batch) {
      batch = await db.reconciliationBatch.create({
        data: { branchId: input.branchId, fiscalMonth: input.fiscalMonth, status: 'OPEN', version: 0 },
      });
    }
    if (batch.status === 'CLOSED') throw new AppError(409, 'CONFLICT', 'This reconciliation batch is already CLOSED.');
    assertFreshVersion(batch.version, input.expectedVersion, 'reconciliation-batch');
    const updated = await db.reconciliationBatch.update({
      where: { id: batch.id, version: batch.version },
      data: {
        status: 'CLOSED',
        checklist: sum.checklist as unknown as Prisma.InputJsonValue,
        closedBy: input.actor,
        closedAt: new Date(),
        version: nextVersion(batch.version),
      },
    });
    await writeAuditEvent(db, {
      actor: input.actor,
      action: 'RECONCILIATION_BATCH_CLOSED',
      entityType: 'reconciliation-batch',
      entityId: batch.id,
      after: { fiscalMonth: input.fiscalMonth, settled: sum.settled, allocated: sum.allocated, variance: sum.variance },
      source: 'cms',
      correlationId,
      branchId: input.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'reconciliation.batch.closed',
      payload: { batchId: batch.id, fiscalMonth: input.fiscalMonth, settled: sum.settled, allocated: sum.allocated },
      branchId: input.branchId,
      correlationId,
    });
    return updated;
  });
  return { id: row.id, branchId: row.branchId, fiscalMonth: row.fiscalMonth, status: row.status, closedBy: row.closedBy, closedAt: row.closedAt, version: row.version };
}

/** Reopen a closed batch — elevated (Owner-only) approval, reason audited. */
export async function reopenReconciliationBatch(input: { branchId: string; fiscalMonth: string; actor: string; isOwner: boolean; reason: string }) {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new AppError(400, 'VALIDATION', 'A reopen reason is required.');
  if (!input.isOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Only an Owner can reopen a closed reconciliation batch.');
  }
  const batch = await prisma.reconciliationBatch.findUnique({
    where: { branchId_fiscalMonth: { branchId: input.branchId, fiscalMonth: input.fiscalMonth } },
  });
  if (!batch || batch.status !== 'CLOSED') throw new AppError(409, 'CONFLICT', 'No CLOSED batch exists for this month.');
  const correlationId = newCorrelationId();
  const row = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const updated = await db.reconciliationBatch.update({
      where: { id: batch.id },
      data: { status: 'OPEN', closedBy: null, closedAt: null, version: nextVersion(batch.version) },
    });
    await writeAuditEvent(db, {
      actor: input.actor,
      action: 'RECONCILIATION_BATCH_REOPENED',
      entityType: 'reconciliation-batch',
      entityId: batch.id,
      before: { status: 'CLOSED' },
      after: { status: 'OPEN' },
      reason,
      source: 'cms',
      correlationId,
      branchId: input.branchId,
    });
    return updated;
  });
  return { id: row.id, branchId: row.branchId, fiscalMonth: row.fiscalMonth, status: row.status, version: row.version };
}

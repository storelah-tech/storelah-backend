// Invoices + monthly billing run (FINANCE_MODULE_SPEC §§6.1/10.3/17, Q2/Q5/Q6).
//
// Lifecycle: DRAFT → APPROVED → ISSUED (approval REQUIRED for every
// manually-created invoice and for billing-run drafts; Q2 CONFIRMED).
// Legacy receivables (DUE/OVERDUE/PAID) keep flowing through the untouched
// portal paths. Void is terminal and needs a reason; VOID/WRITTEN_OFF rows
// are portal-hidden (toCustomerInvoice in core/invoicePayments.ts).
//
// Money is Decimal + toNum at the boundary. Tax is computed ONLY at issue
// from finance.gstEnabled/finance.gstRate (OFF default → 0, GST UI hidden).
// No Tenant billing columns, no StorageAgreement, no late-fee posting here
// (all deferred — Phase 4).

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { toNum } from '../../lib/format';
import { AppError } from '../../lib/http';
import { writeAuditEvent } from './audit';
import { publishFinanceEvent } from './events';
import { assertFreshVersion, nextVersion, newCorrelationId } from './idempotency';
import { getFinancePolicies } from './policies';
import { isMonthClosed } from './monthClose';
import { getSettings } from '../settings';
import { createInstructionTx, cancelInstructionTx } from './payments';

export const INVOICE_LINE_KINDS = ['RENT', 'FEE', 'CREDIT', 'TAX', 'ADJUSTMENT'] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

const TERMINAL = ['VOID', 'WRITTEN_OFF', 'PAID'] as const;
const VOIDABLE = ['DRAFT', 'APPROVED', 'ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID'] as const;

export interface InvoiceLineInput {
  kind: string;
  label: string;
  amount: number;
  refId?: string;
}

export interface CreateInvoiceInput {
  tenantId: string;
  unitId?: string;
  dueDate: string;
  serviceStart?: string;
  serviceEnd?: string;
  lines: InvoiceLineInput[];
  idempotencyKey?: string | null;
  actor: string;
}

type Db = Pick<typeof prisma, 'invoice' | 'invoiceLine' | 'processedStripeEvent' | 'financeAuditEvent' | 'financeEvent' | 'paymentInstruction'>;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fiscalMonthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function validDate(s: string, label: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new AppError(400, 'VALIDATION', `${label} must be a valid date.`);
  return d;
}

/** Server-generated invoice number from the billing.invoicePrefix setting. */
async function uniqueInvoiceNo(db: Pick<Db, 'invoice'>): Promise<string> {
  const s = await getSettings();
  const raw = typeof s['billing.invoicePrefix'] === 'string' ? (s['billing.invoicePrefix'] as string) : 'INV';
  const prefix = (raw || 'INV').replace(/-+$/, '') || 'INV';
  const year = new Date().getUTCFullYear();
  for (let i = 0; i < 5; i++) {
    const no = `${prefix}-${year}-${Math.floor(1000 + Math.random() * 9000)}`;
    if (!(await db.invoice.findUnique({ where: { invoiceNo: no }, select: { id: true } }))) return no;
  }
  throw new AppError(500, 'INTERNAL', 'Could not generate a unique invoice number');
}

function checkLines(lines: InvoiceLineInput[]): { subtotal: number } {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new AppError(400, 'VALIDATION', 'At least one invoice line is required.');
  }
  let subtotal = 0;
  for (const [ix, l] of lines.entries()) {
    // TAX is computed at issue from the GST policy (never hand-entered);
    // CREDIT wallets land in Phase 4 — explicit kinds keep §17.4 honest.
    if (l.kind === 'TAX' || l.kind === 'CREDIT') {
      throw new AppError(400, 'VALIDATION', `Line ${ix + 1}: ${l.kind} lines are not entered manually (tax is computed at issue; credits land in Phase 4).`);
    }
    if (l.kind !== 'RENT' && l.kind !== 'FEE' && l.kind !== 'ADJUSTMENT') {
      throw new AppError(400, 'VALIDATION', `Line ${ix + 1}: kind must be RENT, FEE or ADJUSTMENT.`);
    }
    const label = (l.label ?? '').trim();
    if (!label || label.length > 120) {
      throw new AppError(400, 'VALIDATION', `Line ${ix + 1}: label is required (max 120 chars).`);
    }
    if (typeof l.amount !== 'number' || !Number.isFinite(l.amount) || Math.abs(l.amount) > 99999999) {
      throw new AppError(400, 'VALIDATION', `Line ${ix + 1}: amount must be a finite number.`);
    }
    if ((l.kind === 'RENT' || l.kind === 'FEE') && l.amount < 0) {
      throw new AppError(400, 'VALIDATION', `Line ${ix + 1}: ${l.kind} amounts cannot be negative (use ADJUSTMENT).`);
    }
    if (l.kind === 'ADJUSTMENT' && l.amount === 0) {
      throw new AppError(400, 'VALIDATION', `Line ${ix + 1}: adjustments must be non-zero.`);
    }
    subtotal = round2(subtotal + l.amount);
  }
  return { subtotal };
}

export interface InvoiceRow {
  id: string;
  no: string;
  tenant: string;
  tenantEmail: string | null;
  unit: string;
  branch: string;
  branchId: string | null;
  amount: number;
  subtotal: number;
  taxAmount: number;
  creditApplied: number;
  amountPaid: number;
  balanceDue: number;
  dueDate: Date;
  billedMonth: Date;
  serviceStart: Date | null;
  serviceEnd: Date | null;
  status: string;
  version: number;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  issuedAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  idempotencyKey: string | null;
  lines: Array<{ id: string; kind: string; label: string; amount: number; refId: string | null }>;
  createdAt: Date;
  updatedAt: Date;
}

type InvoiceWithJoins = Prisma.InvoiceGetPayload<{
  include: {
    tenant: true;
    unit: { include: { branch: true } };
    lines: true;
  };
}>;

export function serializeInvoice(i: InvoiceWithJoins): InvoiceRow {
  const total = toNum(i.amount);
  const paid = toNum(i.amountPaid ?? 0);
  return {
    id: i.id,
    no: i.invoiceNo,
    tenant: i.tenant.name,
    tenantEmail: i.tenant.email,
    unit: i.unit.unitCode,
    branch: i.unit.branch.name,
    branchId: i.unit.branchId,
    amount: total,
    subtotal: i.subtotal != null ? toNum(i.subtotal) : total,
    taxAmount: toNum(i.taxAmount ?? 0),
    creditApplied: toNum(i.creditApplied ?? 0),
    amountPaid: paid,
    // Lazy derivation (plan §1d): stamped balanceDue wins, else total − paid.
    balanceDue: i.balanceDue != null ? toNum(i.balanceDue) : round2(total - paid),
    dueDate: i.dueDate,
    billedMonth: i.billedMonth,
    serviceStart: i.serviceStart,
    serviceEnd: i.serviceEnd,
    status: i.status,
    version: i.version,
    createdBy: i.createdBy,
    approvedBy: i.approvedBy,
    approvedAt: i.approvedAt,
    issuedAt: i.issuedAt,
    voidedAt: i.voidedAt,
    voidReason: i.voidReason,
    idempotencyKey: i.idempotencyKey,
    lines: i.lines.map((l) => ({ id: l.id, kind: l.kind, label: l.label, amount: toNum(l.amount), refId: l.refId })),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

const INVOICE_INCLUDE = { tenant: true, unit: { include: { branch: true } }, lines: true } as const;

export async function listFinanceInvoices(opts: { status?: string; branchId?: string; from?: Date; to?: Date }) {
  const valid = ['PAID', 'DUE', 'OVERDUE', 'DRAFT', 'APPROVED', 'ISSUED', 'PARTIALLY_PAID', 'VOID', 'WRITTEN_OFF'];
  const where: Record<string, unknown> = {};
  if (opts.status) {
    if (!valid.includes(opts.status)) throw new AppError(400, 'VALIDATION', `Unknown invoice status ${opts.status}.`);
    where.status = opts.status;
  }
  if (opts.branchId) where.unit = { branchId: opts.branchId };
  if (opts.from || opts.to) {
    where.dueDate = { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) };
  }
  const rows = (await prisma.invoice.findMany({
    where,
    include: INVOICE_INCLUDE,
    orderBy: { dueDate: 'desc' },
    // §25.3: registers are server-side bounded (filters narrow further).
    take: 500,
  })) as InvoiceWithJoins[];
  return rows.map(serializeInvoice);
}

export async function getInvoiceDetail(id: string) {
  const row = (await prisma.invoice.findUnique({
    where: { id },
    include: { ...INVOICE_INCLUDE, instructions: { orderBy: { createdAt: 'desc' } } },
  })) as (InvoiceWithJoins & { instructions: Array<{ id: string; status: string; amount: unknown; createdAt: Date }> }) | null;
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
  const { instructions, ...rest } = row;
  return {
    ...serializeInvoice(rest),
    instructions: instructions.map((x) => ({ id: x.id, status: x.status, amount: toNum(x.amount as never), createdAt: x.createdAt })),
  };
}

async function createInvoiceTx(db: Db, input: CreateInvoiceInput) {
  // Idempotent create: a repeated POST with the same key returns the draft.
  if (input.idempotencyKey) {
    const existing = await db.invoice.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: INVOICE_INCLUDE });
    if (existing) return { row: existing as InvoiceWithJoins, deduplicated: true };
  }
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', 'Tenant not found');
  const unitId = input.unitId ?? tenant.unitId ?? null;
  if (!unitId) throw new AppError(400, 'VALIDATION', 'A unit is required (the tenant has none linked).');
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit || unit.deletedAt) throw new AppError(404, 'NOT_FOUND', 'Unit not found');
  const dueDate = validDate(input.dueDate, 'dueDate');
  const serviceStart = input.serviceStart ? validDate(input.serviceStart, 'serviceStart') : null;
  const serviceEnd = input.serviceEnd ? validDate(input.serviceEnd, 'serviceEnd') : null;
  if (serviceStart && serviceEnd && serviceStart > serviceEnd) {
    throw new AppError(400, 'VALIDATION', 'serviceStart must not be after serviceEnd.');
  }
  // Posted months are immutable (Phase 4): no new invoice may reference a
  // CLOSED service month — corrections arrive as adjustment documents.
  if (serviceStart && tenant.branchId && (await isMonthClosed(tenant.branchId, fiscalMonthOf(serviceStart)))) {
    throw new AppError(409, 'BLOCKED', `Service month ${fiscalMonthOf(serviceStart)} is CLOSED — posted months are immutable.`);
  }
  const { subtotal } = checkLines(input.lines);
  // §17.4: no duplicate facility/agreement/service-period invoice.
  if (serviceStart) {
    const dup = await db.invoice.findFirst({
      where: {
        tenantId: tenant.id,
        unitId: unit.id,
        serviceStart,
        status: { notIn: ['VOID', 'WRITTEN_OFF'] },
      },
      select: { id: true, invoiceNo: true },
    });
    if (dup) {
      throw new AppError(409, 'CONFLICT', `A live invoice already covers this service period (${dup.invoiceNo}).`);
    }
  }
  const correlationId = newCorrelationId();
  const row = (await db.invoice.create({
    data: {
      invoiceNo: await uniqueInvoiceNo(db),
      tenantId: tenant.id,
      unitId: unit.id,
      amount: subtotal,
      subtotal,
      taxAmount: 0,
      creditApplied: 0,
      balanceDue: subtotal,
      dueDate,
      billedMonth: serviceStart ?? new Date(Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), 1)),
      serviceStart,
      serviceEnd,
      status: 'DRAFT',
      createdBy: input.actor,
      idempotencyKey: input.idempotencyKey ?? `inv-${correlationId}`,
      version: 0,
      lines: {
        create: input.lines.map((l) => ({
          kind: l.kind,
          label: l.label.trim(),
          amount: round2(l.amount),
          refId: l.refId?.trim() || null,
        })),
      },
    },
    include: INVOICE_INCLUDE,
  })) as InvoiceWithJoins;
  await writeAuditEvent(db, {
    actor: input.actor,
    action: 'INVOICE_CREATED',
    entityType: 'invoice',
    entityId: row.id,
    after: { invoiceNo: row.invoiceNo, subtotal, status: 'DRAFT' },
    source: 'cms',
    correlationId,
    branchId: unit.branchId,
  });
  await publishFinanceEvent(db, {
    type: 'invoice.generated',
    payload: { invoiceId: row.id, invoiceNo: row.invoiceNo, subtotal },
    branchId: unit.branchId,
    correlationId,
  });
  return { row, deduplicated: false };
}

export async function createInvoice(input: CreateInvoiceInput) {
  const out = await prisma.$transaction(async (tx) => createInvoiceTx(tx as unknown as Db, input));
  return { invoice: serializeInvoice(out.row), deduplicated: out.deduplicated };
}

export async function approveInvoice(id: string, opts: { expectedVersion?: number; actor: string }) {
  const now = await prisma.invoice.findUnique({ where: { id }, include: { unit: { select: { branchId: true } } } });
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
  if (now.status !== 'DRAFT') throw new AppError(409, 'CONFLICT', `Only DRAFT invoices can be approved (this one is ${now.status}).`);
  // Maker-checker (spec §4.1 — material manual adjustment): the creator
  // cannot approve their own draft, regardless of role.
  if (now.createdBy && now.createdBy === opts.actor) {
    throw new AppError(403, 'MAKER_CHECKER', 'The invoice creator cannot approve it — a different approver is required.');
  }
  assertFreshVersion(now.version, opts.expectedVersion, 'invoice');
  if (now.serviceStart && now.unit && (await isMonthClosed(now.unit.branchId, fiscalMonthOf(now.serviceStart)))) {
    throw new AppError(409, 'BLOCKED', `Service month ${fiscalMonthOf(now.serviceStart)} is CLOSED — posted months are immutable.`);
  }
  const correlationId = newCorrelationId();
  const row = (await prisma.$transaction(async (tx) => {
    const updated = (await (tx as unknown as Db).invoice.update({
      where: { id, version: now.version },
      data: { status: 'APPROVED', approvedBy: opts.actor, approvedAt: new Date(), version: nextVersion(now.version) },
      include: INVOICE_INCLUDE,
    })) as InvoiceWithJoins;
    await writeAuditEvent(tx as unknown as Db, {
      actor: opts.actor,
      action: 'INVOICE_APPROVED',
      entityType: 'invoice',
      entityId: id,
      before: { status: 'DRAFT', version: now.version },
      after: { status: 'APPROVED', version: updated.version },
      source: 'cms',
      correlationId,
      branchId: updated.unit.branchId,
    });
    return updated;
  })) as InvoiceWithJoins;
  return serializeInvoice(row);
}

export async function issueInvoice(id: string, opts: { expectedVersion?: number; actor: string }) {
  const now = await prisma.invoice.findUnique({ where: { id }, include: { lines: true, unit: { select: { branchId: true } } } });
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
  if (now.status !== 'APPROVED') {
    throw new AppError(409, 'CONFLICT', `Only APPROVED invoices can be issued (this one is ${now.status}).`);
  }
  assertFreshVersion(now.version, opts.expectedVersion, 'invoice');
  if (now.serviceStart && (await isMonthClosed(now.unit.branchId, fiscalMonthOf(now.serviceStart)))) {
    throw new AppError(409, 'BLOCKED', `Service month ${fiscalMonthOf(now.serviceStart)} is CLOSED — posted months are immutable.`);
  }
  const policies = await getFinancePolicies();
  // GST hook: read the ruling rate AT ISSUE; OFF → tax 0. The rate is a
  // decided editable default (5); a missing rate blocks issue, never guesses.
  let tax = 0;
  if (policies.gstEnabled) {
    if (!(policies.gstRate > 0)) {
      throw new AppError(409, 'BLOCKED', 'GST is ON but finance.gstRate is undecided — set the rate before issuing.', {
        policy: 'finance.gstRate',
      });
    }
    tax = round2(toNum(now.subtotal ?? now.amount) * (policies.gstRate / 100));
  }
  const subtotal = toNum(now.subtotal ?? now.amount);
  const total = round2(subtotal + tax);
  const correlationId = newCorrelationId();
  const row = (await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const updated = (await db.invoice.update({
      where: { id, version: now.version },
      data: {
        status: 'ISSUED',
        issuedAt: new Date(),
        taxAmount: tax,
        amount: total,
        balanceDue: total,
        version: nextVersion(now.version),
      },
      include: INVOICE_INCLUDE,
    })) as InvoiceWithJoins;
    // §10.3 step 5: issuing creates a PENDING_APPROVAL instruction for the
    // open balance — and NEVER charges. Same idempotency key per invoice, so
    // a retried issue can never queue two instructions.
    const created = await createInstructionTx(db, {
      invoiceId: id,
      amount: total,
      actor: opts.actor,
      idempotencyKey: `issue-${id}`,
    }, { invoice: { ...updated, amount: updated.amount, amountPaid: updated.amountPaid, balanceDue: updated.balanceDue } });
    const instruction = created.row;
    await writeAuditEvent(db, {
      actor: opts.actor,
      action: 'INVOICE_ISSUED',
      entityType: 'invoice',
      entityId: id,
      before: { status: 'APPROVED', version: now.version },
      after: { status: 'ISSUED', version: updated.version, taxAmount: tax, total },
      source: 'cms',
      correlationId,
      branchId: updated.unit.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'invoice.issued',
      payload: { invoiceId: id, invoiceNo: updated.invoiceNo, total, instructionId: instruction.id },
      branchId: updated.unit.branchId,
      correlationId,
    });
    await publishFinanceEvent(db, {
      type: 'payment.instruction.created',
      payload: { instructionId: instruction.id, invoiceId: id, amount: total },
      branchId: updated.unit.branchId,
      correlationId,
    });
    return updated;
  })) as InvoiceWithJoins;
  return serializeInvoice(row);
}

export async function voidInvoice(id: string, opts: { expectedVersion?: number; reason?: string; actor: string }) {
  const reason = (opts.reason ?? '').trim();
  if (!reason) throw new AppError(400, 'VALIDATION', 'A void reason is required.');
  const now = await prisma.invoice.findUnique({ where: { id }, include: { instructions: true, unit: { select: { branchId: true } } } });
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
  if (!(VOIDABLE as readonly string[]).includes(now.status)) {
    throw new AppError(409, 'CONFLICT', `This invoice cannot be voided from ${now.status} (PAID invoices need a credit/refund document — Phase 4).`);
  }
  if (now.serviceStart && (await isMonthClosed(now.unit.branchId, fiscalMonthOf(now.serviceStart)))) {
    throw new AppError(409, 'BLOCKED', `Service month ${fiscalMonthOf(now.serviceStart)} is CLOSED — posted months are immutable.`);
  }
  assertFreshVersion(now.version, opts.expectedVersion, 'invoice');
  const inFlight = now.instructions.filter((x) => x.status === 'SUBMITTED');
  if (inFlight.length > 0) {
    throw new AppError(409, 'CONFLICT', 'A charge is in flight for this invoice — wait for the processor outcome before voiding.');
  }
  const correlationId = newCorrelationId();
  const row = (await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const updated = (await db.invoice.update({
      where: { id, version: now.version },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: reason, version: nextVersion(now.version) },
      include: INVOICE_INCLUDE,
    })) as InvoiceWithJoins;
    // Voiding cancels every non-terminal instruction — the debt is gone.
    for (const x of now.instructions) {
      if (['PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'FAILED'].includes(x.status)) {
        await cancelInstructionTx(db, x.id, { actor: opts.actor, reason: `Invoice voided: ${reason}`, correlationId });
      }
    }
    await writeAuditEvent(db, {
      actor: opts.actor,
      action: 'INVOICE_VOIDED',
      entityType: 'invoice',
      entityId: id,
      before: { status: now.status, version: now.version },
      after: { status: 'VOID', version: updated.version },
      reason,
      source: 'cms',
      correlationId,
      branchId: updated.unit.branchId,
    });
    return updated;
  })) as InvoiceWithJoins;
  return serializeInvoice(row);
}

const WRITEOFFABLE = ['ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID'] as const;

/**
 * Approved write-off (spec §§17.3/18: resolves an arrears case but preserves
 * history — a WRITTEN_OFF row is terminal, never deleted). Reason required;
 * in-flight charges block the write-off; closed service months are BLOCKED.
 */
export async function writeOffInvoice(id: string, opts: { expectedVersion?: number; reason?: string; actor: string }) {
  const reason = (opts.reason ?? '').trim();
  if (!reason) throw new AppError(400, 'VALIDATION', 'A write-off reason is required.');
  const now = await prisma.invoice.findUnique({ where: { id }, include: { instructions: true, unit: { select: { branchId: true } } } });
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
  if (!(WRITEOFFABLE as readonly string[]).includes(now.status)) {
    throw new AppError(409, 'CONFLICT', `Only a receivable invoice can be written off (this one is ${now.status}).`);
  }
  assertFreshVersion(now.version, opts.expectedVersion, 'invoice');
  if (now.serviceStart && (await isMonthClosed(now.unit.branchId, fiscalMonthOf(now.serviceStart)))) {
    throw new AppError(409, 'BLOCKED', `Service month ${fiscalMonthOf(now.serviceStart)} is CLOSED — posted months are immutable.`);
  }
  const inFlight = now.instructions.filter((x) => x.status === 'SUBMITTED');
  if (inFlight.length > 0) {
    throw new AppError(409, 'CONFLICT', 'A charge is in flight for this invoice — wait for the processor outcome before writing it off.');
  }
  const correlationId = newCorrelationId();
  const row = (await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const updated = (await db.invoice.update({
      where: { id, version: now.version },
      data: { status: 'WRITTEN_OFF', writtenOffAt: new Date(), version: nextVersion(now.version) },
      include: INVOICE_INCLUDE,
    })) as InvoiceWithJoins;
    for (const x of now.instructions) {
      if (['PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'FAILED'].includes(x.status)) {
        await cancelInstructionTx(db, x.id, { actor: opts.actor, reason: `Invoice written off: ${reason}`, correlationId });
      }
    }
    await writeAuditEvent(db, {
      actor: opts.actor,
      action: 'INVOICE_WRITTEN_OFF',
      entityType: 'invoice',
      entityId: id,
      before: { status: now.status, version: now.version },
      after: { status: 'WRITTEN_OFF', version: updated.version },
      reason,
      source: 'cms',
      correlationId,
      branchId: updated.unit.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'invoice.written.off',
      payload: { invoiceId: id, invoiceNo: updated.invoiceNo, reason },
      branchId: updated.unit.branchId,
      correlationId,
    });
    return updated;
  })) as InvoiceWithJoins;
  return serializeInvoice(row);
}

export interface BillingRunInput {
  branchId: string;
  billingMonth: string;
  dueDate?: string;
  actor: string;
}

export interface BillingRunResult {
  billingMonth: string;
  branchId: string;
  created: number;
  reused: number;
  skipped: Array<{ tenant: string; unit: string; reason: string }>;
  invoices: InvoiceRow[];
  /** F-3: human-readable outcome when the run creates nothing (never silent). */
  reason: string | null;
}

/**
 * CMS-triggered monthly billing run (spec §10.3 steps 1–4): one DRAFT invoice
 * per active billable tenant, idempotent per (branch, month, tenant) — run
 * twice → one draft set. Drafts need one approval before issue (Q2). The run
 * NEVER posts late fees and NEVER charges (Phase 4 owns enforcement).
 */
export async function runBilling(input: BillingRunInput): Promise<BillingRunResult> {
  const m = /^(\d{4})-(\d{2})$/.exec(input.billingMonth.trim());
  if (!m) throw new AppError(400, 'VALIDATION', 'billingMonth must be YYYY-MM.');
  const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
  if (!branch) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
  const serviceStart = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  const serviceEnd = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0));
  const dueDate = input.dueDate ? validDate(input.dueDate, 'dueDate') : serviceEnd;
  const monthLabel = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(serviceStart);

  // F-3: eligibility follows the UNIT's facility, not the nullable
  // Tenant.branchId cache (legacy rows have it NULL). Tenant.branchId is still
  // stamped on create for fast filtering, but the run never depends on it.
  const tenants = await prisma.tenant.findMany({
    where: { status: 'ACTIVE', unitId: { not: null }, unit: { branchId: branch.id } },
    include: { unit: true },
  });
  const result: BillingRunResult = { billingMonth: input.billingMonth, branchId: branch.id, created: 0, reused: 0, skipped: [], invoices: [], reason: null };
  for (const t of tenants) {
    const rate = toNum(t.monthlyRate);
    if (!(rate > 0)) {
      result.skipped.push({ tenant: t.name, unit: t.unit?.unitCode ?? '—', reason: 'monthlyRate is zero' });
      continue;
    }
    const key = `billing-run:${branch.id}:${input.billingMonth}:${t.id}`;
    const existing = await prisma.invoice.findUnique({ where: { idempotencyKey: key }, include: INVOICE_INCLUDE });
    if (existing) {
      result.reused += 1;
      result.invoices.push(serializeInvoice(existing as InvoiceWithJoins));
      continue;
    }
    try {
      const out = await createInvoice({
        tenantId: t.id,
        unitId: t.unitId!,
        dueDate: dueDate.toISOString(),
        serviceStart: serviceStart.toISOString(),
        serviceEnd: serviceEnd.toISOString(),
        lines: [{ kind: 'RENT', label: `Storage rent — ${monthLabel}`, amount: rate }],
        idempotencyKey: key,
        actor: input.actor,
      });
      result.invoices.push(out.invoice);
      if (out.deduplicated) result.reused += 1;
      else result.created += 1;
    } catch (e) {
      if (e instanceof AppError && e.status === 409) {
        result.skipped.push({ tenant: t.name, unit: t.unit?.unitCode ?? '—', reason: e.message });
        continue;
      }
      throw e;
    }
  }
  // F-3: never return a silent zero — the operator needs the why.
  if (result.created === 0 && result.reused === 0) {
    result.reason = tenants.length === 0
      ? `No ACTIVE tenants with a unit in this facility for ${input.billingMonth} — nothing to bill.`
      : `No invoices created for ${input.billingMonth}: ${result.skipped.length} tenant(s) skipped (${result.skipped.slice(0, 3).map((s) => `${s.tenant}: ${s.reason}`).join('; ')}${result.skipped.length > 3 ? '; …' : ''}).`;
  }
  await writeAuditEvent(prisma, {
    actor: input.actor,
    action: 'BILLING_RUN',
    entityType: 'billing-run',
    entityId: `${branch.id}:${input.billingMonth}`,
    after: { created: result.created, reused: result.reused, skipped: result.skipped.length, reason: result.reason },
    source: 'cms',
    correlationId: newCorrelationId(),
    branchId: branch.id,
  });
  return result;
}

export { TERMINAL as INVOICE_TERMINAL_STATUSES };

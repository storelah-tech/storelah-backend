// Credits wallet + refunds (FINANCE_MODULE_SPEC §19, owner Q4 v1.2 FINAL).
//
// Wallet: one row per tenant, append-only CreditLedgerEntry ledger
// (GRANT/APPLY/REFUND/EXPIRE/ADJUST); balance = Σ entries. $1 credit = $1,
// non-transferable, no cash value by default. Applying a credit appends a
// CREDIT InvoiceLine and stamps creditApplied/balanceDue (never edits).
//
// Refunds: REQUESTED → APPROVED/REJECTED → PAID. Maker-checker (Q4 v1.2):
// EVERY refund needs a distinct requestor + approver — no threshold. ONLY a
// Super Admin (Owner) may single-step, and every bypass writes a
// FinanceAuditEvent with actor + reason. Bank-account verification is
// REQUIRED before any refund reaches PAID (explicit step). A computation
// that goes negative converts to a CHARGE (new DRAFT invoice → approval
// flow) — never a negative payment.
//
// Money is Decimal + toNum at the boundary. Idempotency-Key dedupes request
// retries; version compare-and-swap guards approve/reject/pay.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { toNum } from '../../lib/format';
import { AppError } from '../../lib/http';
import { writeAuditEvent } from './audit';
import { publishFinanceEvent } from './events';
import { assertFreshVersion, nextVersion, newCorrelationId } from './idempotency';
import { getFinancePolicies, requireDecided } from './policies';
import { isMonthClosed } from './monthClose';
import { serializeInvoice } from './billing';
import type { InvoiceRow } from './billing';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const LEDGER_KINDS = ['GRANT', 'APPLY', 'REFUND', 'EXPIRE', 'ADJUST'] as const;
export const REFUND_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'PAID'] as const;
const RECEIVABLE = ['ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID'] as const;

type Db = Pick<typeof prisma,
  'tenant' | 'invoice' | 'invoiceLine' | 'creditWallet' | 'creditLedgerEntry' | 'refund'
  | 'financeAuditEvent' | 'financeEvent'>;

// ---------------------------------------------------------------------------
// Refund calculator (spec §19.2 — the server is authoritative over the UI)
// ---------------------------------------------------------------------------

export interface RefundCalculationInput {
  monthlyRent: number;
  daysInMonth: number;
  unusedDays: number;
  refundableCredit?: number;
  earlyTerminationFee?: number;
  damageCharge?: number;
  override?: number;
  reason?: string;
}

export interface RefundCalculation {
  prorated: number;
  calculated: number;
  final: number;
  negative: boolean;
}

/**
 * Spec §19.2 formula:
 *   prorated = monthlyRent ÷ daysInMonth × unusedDays
 *   calculated = prorated + refundableCredit − earlyTerminationFee − damageCharge
 *   final = override ?? calculated
 * A reason is mandatory when any deduction or override is present. A
 * negative final becomes a charge (handled by requestRefund).
 */
export function calculateRefund(input: RefundCalculationInput): RefundCalculation {
  const fail = (m: string) => { throw new AppError(400, 'VALIDATION', m); };
  const num = (v: unknown, label: string, opts: { min?: number; max?: number } = {}): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${label} must be a finite number.`);
    if (opts.min !== undefined && (v as number) < opts.min) fail(`${label} must be at least ${opts.min}.`);
    if (opts.max !== undefined && (v as number) > opts.max) fail(`${label} must be at most ${opts.max}.`);
    return v as number;
  };
  const monthlyRent = num(input.monthlyRent, 'monthlyRent', { min: 0, max: 99999999 });
  const daysInMonth = num(input.daysInMonth, 'daysInMonth', { min: 28, max: 31 });
  const unusedDays = num(input.unusedDays, 'unusedDays', { min: 0, max: daysInMonth });
  const credit = input.refundableCredit === undefined ? 0 : num(input.refundableCredit, 'refundableCredit', { min: 0, max: 99999999 });
  const termFee = input.earlyTerminationFee === undefined ? 0 : num(input.earlyTerminationFee, 'earlyTerminationFee', { min: 0, max: 99999999 });
  const damage = input.damageCharge === undefined ? 0 : num(input.damageCharge, 'damageCharge', { min: 0, max: 99999999 });
  // F-6: a reason is required only for a deduction the operator imposes
  // (early-termination fee / damage charge) or an explicit override.
  // A refundable credit is customer money coming back — never a deduction.
  const hasDeduction = termFee > 0 || damage > 0;
  const hasOverride = input.override !== undefined && input.override !== null;
  let override = 0;
  if (hasOverride) override = num(input.override, 'override', { min: -99999999, max: 99999999 });
  if ((hasDeduction || hasOverride) && !(input.reason ?? '').trim()) {
    fail('A reason is required when a deduction or override is present.');
  }
  const prorated = round2((monthlyRent / daysInMonth) * unusedDays);
  const calculated = round2(prorated + credit - termFee - damage);
  const final = hasOverride ? round2(override) : calculated;
  return { prorated, calculated, final, negative: final < 0 };
}

// ---------------------------------------------------------------------------
// Wallet reads
// ---------------------------------------------------------------------------

export interface WalletRow {
  id: string;
  tenantId: string;
  tenant: string;
  tenantEmail: string | null;
  branchId: string | null;
  balance: number;
  version: number;
  entries: Array<{ id: string; kind: string; amount: number; refId: string | null; actor: string; note: string | null; createdAt: Date }>;
}

type WalletWithJoins = Prisma.CreditWalletGetPayload<{ include: { tenant: true; entries: true } }>;

export function serializeWallet(w: WalletWithJoins): WalletRow {
  return {
    id: w.id,
    tenantId: w.tenantId,
    tenant: w.tenant.name,
    tenantEmail: w.tenant.email,
    branchId: w.branchId,
    balance: toNum(w.balance),
    version: w.version,
    entries: [...w.entries]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((e) => ({ id: e.id, kind: e.kind, amount: toNum(e.amount), refId: e.refId, actor: e.actor, note: e.note, createdAt: e.createdAt })),
  };
}

export async function getWallet(tenantId: string): Promise<WalletRow | null> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', 'Tenant not found');
  const w = (await prisma.creditWallet.findUnique({
    where: { tenantId },
    include: { tenant: true, entries: true },
  })) as WalletWithJoins | null;
  return w ? serializeWallet(w) : null;
}

// ---------------------------------------------------------------------------
// Grant + apply
// ---------------------------------------------------------------------------

export interface GrantCreditInput {
  tenantId: string;
  amount: number;
  actor: string;
  note?: string;
  source?: string;
  idempotencyKey?: string | null;
}

async function grantCreditTx(db: Db, input: GrantCreditInput) {
  if (!(input.amount > 0)) throw new AppError(400, 'VALIDATION', 'Grant amount must be positive.');
  if (input.idempotencyKey) {
    const prior = await db.creditLedgerEntry.findFirst({
      where: { refId: `idem:${input.idempotencyKey}`, kind: 'GRANT' },
      select: { id: true },
    });
    if (prior) {
      const existing = (await db.creditWallet.findFirst({
        where: { tenantId: input.tenantId },
        include: { tenant: true, entries: true },
      })) as WalletWithJoins | null;
      if (existing) return { wallet: existing, deduplicated: true };
    }
  }
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', 'Tenant not found');
  const correlationId = newCorrelationId();
  let wallet = await db.creditWallet.findUnique({ where: { tenantId: input.tenantId } });
  if (!wallet) {
    wallet = await db.creditWallet.create({
      data: { tenantId: input.tenantId, branchId: tenant.branchId, balance: 0, version: 0 },
    });
  }
  const balance = round2(toNum(wallet.balance) + input.amount);
  const updated = (await db.creditWallet.update({
    where: { id: wallet.id, version: wallet.version },
    data: { balance, version: wallet.version + 1 },
    include: { tenant: true, entries: true },
  })) as WalletWithJoins;
  await db.creditLedgerEntry.create({
    data: {
      walletId: wallet.id,
      kind: 'GRANT',
      amount: round2(input.amount),
      refId: input.idempotencyKey ? `idem:${input.idempotencyKey}` : (input.source ?? null),
      actor: input.actor,
      note: input.note?.trim() || input.source?.trim() || null,
    },
  });
  await writeAuditEvent(db, {
    actor: input.actor,
    action: 'CREDIT_GRANTED',
    entityType: 'credit-wallet',
    entityId: wallet.id,
    after: { tenantId: input.tenantId, amount: round2(input.amount), balance },
    reason: input.note?.trim() || undefined,
    source: 'cms',
    correlationId,
    branchId: tenant.branchId,
  });
  await publishFinanceEvent(db, {
    type: 'credit.issued',
    payload: { walletId: wallet.id, tenantId: input.tenantId, amount: round2(input.amount), balance },
    branchId: tenant.branchId,
    correlationId,
  });
  const full = (await db.creditWallet.findUnique({
    where: { id: wallet.id },
    include: { tenant: true, entries: true },
  })) as WalletWithJoins;
  return { wallet: full ?? updated, deduplicated: false };
}

export async function grantCredit(input: GrantCreditInput) {
  const out = await prisma.$transaction(async (tx) => grantCreditTx(tx as unknown as Db, input));
  return { wallet: serializeWallet(out.wallet), deduplicated: out.deduplicated };
}

export interface ApplyCreditInput {
  tenantId: string;
  invoiceId: string;
  amount?: number;
  actor: string;
  note?: string;
  idempotencyKey?: string | null;
}

async function applyCreditTx(db: Db, input: ApplyCreditInput) {
  const wallet = await db.creditWallet.findUnique({ where: { tenantId: input.tenantId } });
  if (!wallet) throw new AppError(409, 'CONFLICT', 'This tenant has no credit wallet (grant credits first).');
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', 'Tenant not found');
  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice || invoice.tenantId !== input.tenantId) {
    throw new AppError(404, 'NOT_FOUND', 'Invoice not found for this tenant');
  }
  if (!(RECEIVABLE as readonly string[]).includes(invoice.status)) {
    throw new AppError(409, 'CONFLICT', `Credits can only be applied to a receivable invoice (this one is ${invoice.status}).`);
  }
  if (input.idempotencyKey) {
    const prior = await db.creditLedgerEntry.findFirst({
      where: { refId: `idem:${input.idempotencyKey}`, kind: 'APPLY' },
      select: { id: true },
    });
    if (prior) {
      const existing = (await db.creditWallet.findUnique({
        where: { id: wallet.id },
        include: { tenant: true, entries: true },
      })) as WalletWithJoins;
      return { wallet: existing, invoiceId: invoice.id, applied: 0, deduplicated: true };
    }
  }
  const balance = toNum(wallet.balance);
  if (!(balance > 0)) throw new AppError(409, 'CONFLICT', 'The credit wallet is empty.');
  const openBalance = invoice.balanceDue != null ? toNum(invoice.balanceDue) : round2(toNum(invoice.amount) - toNum(invoice.amountPaid ?? 0));
  const wanted = input.amount === undefined ? Math.min(balance, openBalance) : input.amount;
  if (!(wanted > 0)) throw new AppError(400, 'VALIDATION', 'Apply amount must be positive.');
  if (wanted - balance > 0.005) {
    throw new AppError(409, 'CONFLICT', `Apply amount ${wanted} exceeds the wallet balance ${balance}.`);
  }
  if (wanted - openBalance > 0.005) {
    throw new AppError(409, 'CONFLICT', `Apply amount ${wanted} exceeds the invoice balance ${openBalance} (§17.4: credits cannot exceed the permitted balance).`);
  }
  // Posted-period guard: no allocation into a closed service month.
  if (invoice.serviceStart && tenant.branchId && (await isMonthClosed(tenant.branchId, fiscalMonthOf(invoice.serviceStart)))) {
    throw new AppError(409, 'BLOCKED', 'This invoice sits in a closed month — post an adjustment document instead of editing it.');
  }
  const correlationId = newCorrelationId();
  const newBalance = round2(balance - wanted);
  const newCreditApplied = round2(toNum(invoice.creditApplied ?? 0) + wanted);
  const newDue = round2(openBalance - wanted);
  const paidInFull = newDue <= 0.005;
  await db.creditWallet.update({
    where: { id: wallet.id, version: wallet.version },
    data: { balance: newBalance, version: wallet.version + 1 },
  });
  await db.creditLedgerEntry.create({
    data: {
      walletId: wallet.id,
      kind: 'APPLY',
      amount: round2(wanted),
      refId: input.idempotencyKey ? `idem:${input.idempotencyKey}` : invoice.id,
      actor: input.actor,
      note: input.note?.trim() || `Applied to ${invoice.invoiceNo}`,
    },
  });
  await db.invoiceLine.create({
    data: { invoiceId: invoice.id, kind: 'CREDIT', label: `StoreLah Credits applied`, amount: -round2(wanted), refId: wallet.id },
  });
  await db.invoice.update({
    where: { id: invoice.id },
    data: {
      creditApplied: newCreditApplied,
      balanceDue: paidInFull ? 0 : newDue,
      ...(paidInFull ? { status: 'PAID', paidAt: new Date(), method: 'Credit' } : {}),
    },
  });
  await writeAuditEvent(db, {
    actor: input.actor,
    action: 'CREDIT_APPLIED',
    entityType: 'invoice',
    entityId: invoice.id,
    before: { balanceDue: openBalance },
    after: { applied: round2(wanted), balanceDue: paidInFull ? 0 : newDue, status: paidInFull ? 'PAID' : invoice.status },
    reason: input.note?.trim() || undefined,
    source: 'cms',
    correlationId,
    branchId: tenant.branchId,
  });
  await publishFinanceEvent(db, {
    type: 'credit.applied',
    payload: { walletId: wallet.id, invoiceId: invoice.id, amount: round2(wanted), paidInFull },
    branchId: tenant.branchId,
    correlationId,
  });
  const full = (await db.creditWallet.findUnique({
    where: { id: wallet.id },
    include: { tenant: true, entries: true },
  })) as WalletWithJoins;
  return { wallet: full, invoiceId: invoice.id, applied: round2(wanted), deduplicated: false };
}

export async function applyCredit(input: ApplyCreditInput) {
  const out = await prisma.$transaction(async (tx) => applyCreditTx(tx as unknown as Db, input));
  return { wallet: serializeWallet(out.wallet), invoiceId: out.invoiceId, applied: out.applied, deduplicated: out.deduplicated };
}

function fiscalMonthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Refund request / lifecycle
// ---------------------------------------------------------------------------

export interface RequestRefundInput extends RefundCalculationInput {
  tenantId: string;
  invoiceId?: string;
  actor: string;
  idempotencyKey?: string | null;
}

export interface RefundRow {
  id: string;
  tenantId: string;
  tenant: string;
  branchId: string | null;
  invoiceId: string | null;
  amount: number;
  reason: string;
  computation: unknown;
  status: string;
  requestedBy: string;
  approvedBy: string | null;
  decidedAt: Date | null;
  bankVerified: boolean;
  bankRef: string | null;
  gatewayRef: string | null;
  bypassed: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

type RefundWithTenant = Prisma.RefundGetPayload<{ include: { tenant: true } }>;

export function serializeRefund(r: RefundWithTenant): RefundRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    tenant: r.tenant.name,
    branchId: r.branchId,
    invoiceId: r.invoiceId,
    amount: toNum(r.amount),
    reason: r.reason,
    computation: r.computation,
    status: r.status,
    requestedBy: r.requestedBy,
    approvedBy: r.approvedBy,
    decidedAt: r.decidedAt,
    bankVerified: r.bankVerified,
    bankRef: r.bankRef,
    gatewayRef: r.gatewayRef,
    bypassed: r.bypassed,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function assertRefundPolicy(): Promise<void> {
  const policies = await getFinancePolicies();
  // Q4 v1.2 FINAL lands here: the SettingDef default makes this decided;
  // a missing/UNDECIDED value keeps refunds BLOCKED (policy-config rule).
  requireDecided((policies as unknown as Record<string, unknown>).refundTwoStep, 'finance.refundTwoStep',
    'Set the refund two-step rule (REQUIRED_EXCEPT_SUPERADMIN) in Global Settings before requesting refunds.');
}

export async function listRefunds(opts: { tenantId?: string; branchId?: string; status?: string }) {
  if (opts.status && !(REFUND_STATUSES as readonly string[]).includes(opts.status)) {
    throw new AppError(400, 'VALIDATION', `Unknown refund status ${opts.status}.`);
  }
  const rows = (await prisma.refund.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(opts.branchId ? { branchId: opts.branchId } : {}),
    },
    include: { tenant: true },
    orderBy: { createdAt: 'desc' },
  })) as RefundWithTenant[];
  return rows.map(serializeRefund);
}

export async function getRefund(id: string) {
  const row = (await prisma.refund.findUnique({ where: { id }, include: { tenant: true } })) as RefundWithTenant | null;
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Refund not found');
  return serializeRefund(row);
}

/**
 * Maker step. A negative computation converts to a CHARGE: a new DRAFT
 * invoice (ADJUSTMENT line) enters the normal invoice-approval flow — the
 * response carries `{ charge }` and no Refund row is created.
 */
export async function requestRefund(input: RequestRefundInput): Promise<{ refund?: RefundRow; charge?: InvoiceRow }> {
  await assertRefundPolicy();
  const calc = calculateRefund(input);
  const reason = (input.reason ?? '').trim();
  // F-6: calculateRefund already enforces reason-when-fee/damage/override.
  // A plain positive refund (prorated rent + refundable credit, no fee or
  // override) is customer money coming back and needs no extra reason;
  // the audit trail still records actor + computation either way.
  const needsReason = (input.earlyTerminationFee ?? 0) > 0 || (input.damageCharge ?? 0) > 0 || (input.override !== undefined && input.override !== null);
  if (needsReason && !reason) throw new AppError(400, 'VALIDATION', 'A refund reason is required.');
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', 'Tenant not found');
  const computation = {
    monthlyRent: input.monthlyRent,
    daysInMonth: input.daysInMonth,
    unusedDays: input.unusedDays,
    refundableCredit: input.refundableCredit ?? 0,
    earlyTerminationFee: input.earlyTerminationFee ?? 0,
    damageCharge: input.damageCharge ?? 0,
    override: input.override ?? null,
    prorated: calc.prorated,
    calculated: calc.calculated,
    final: calc.final,
  };
  if (calc.final === 0) {
    throw new AppError(400, 'VALIDATION', 'The computed refund is zero — there is nothing to refund.');
  }
  const correlationId = newCorrelationId();

  if (calc.negative) {
    const due = Math.abs(calc.final);
    const out = await prisma.$transaction(async (tx) => {
      const db = tx as unknown as Db & Pick<typeof prisma, 'invoice' | 'invoiceLine'>;
      if (input.idempotencyKey) {
        const prior = await (db as Pick<typeof prisma, 'invoice'>).invoice.findUnique({
          where: { idempotencyKey: `refund-charge:${input.idempotencyKey}` },
          include: { tenant: true, unit: { include: { branch: true } }, lines: true },
        });
        if (prior) return { row: prior as unknown as Parameters<typeof serializeInvoice>[0], deduplicated: true };
      }
      const unitId = tenant.unitId;
      if (!unitId) throw new AppError(400, 'VALIDATION', 'A unit is required (the tenant has none linked).');
      const unit = await prisma.unit.findUnique({ where: { id: unitId } });
      if (!unit || unit.deletedAt) throw new AppError(404, 'NOT_FOUND', 'Unit not found');
      const now = new Date();
      const row = await (db as Pick<typeof prisma, 'invoice'>).invoice.create({
        data: {
          invoiceNo: `ADJ-${now.getUTCFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
          tenantId: tenant.id,
          unitId: unit.id,
          amount: due,
          subtotal: due,
          taxAmount: 0,
          creditApplied: 0,
          balanceDue: due,
          dueDate: now,
          billedMonth: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
          status: 'DRAFT',
          createdBy: input.actor,
          idempotencyKey: input.idempotencyKey ? `refund-charge:${input.idempotencyKey}` : `refund-charge-${correlationId}`,
          version: 0,
          lines: { create: [{ kind: 'ADJUSTMENT', label: 'Additional charge — refund shortfall review', amount: due }] },
        },
        include: { tenant: true, unit: { include: { branch: true } }, lines: true },
      });
      await writeAuditEvent(db, {
        actor: input.actor,
        action: 'REFUND_CONVERTED_TO_CHARGE',
        entityType: 'invoice',
        entityId: row.id,
        after: { ...computation, charge: due, reason },
        reason,
        source: 'cms',
        correlationId,
        branchId: tenant.branchId,
      });
      await publishFinanceEvent(db, {
        type: 'refund.converted.to.charge',
        payload: { invoiceId: row.id, tenantId: tenant.id, amount: due, computation },
        branchId: tenant.branchId,
        correlationId,
      });
      return { row: row as unknown as Parameters<typeof serializeInvoice>[0], deduplicated: false };
    });
    return { charge: serializeInvoice(out.row) };
  }

  const created = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    if (input.idempotencyKey) {
      const prior = (await db.refund.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: { tenant: true },
      })) as RefundWithTenant | null;
      if (prior) return { row: prior, deduplicated: true };
    }
    const row = (await db.refund.create({
      data: {
        tenantId: tenant.id,
        branchId: tenant.branchId,
        invoiceId: input.invoiceId ?? null,
        amount: calc.final,
        reason,
        computation: computation as unknown as Prisma.InputJsonValue,
        status: 'REQUESTED',
        requestedBy: input.actor,
        idempotencyKey: input.idempotencyKey ?? `refund-${correlationId}`,
        version: 0,
      },
      include: { tenant: true },
    })) as RefundWithTenant;
    await writeAuditEvent(db, {
      actor: input.actor,
      action: 'REFUND_REQUESTED',
      entityType: 'refund',
      entityId: row.id,
      after: { amount: calc.final, computation, reason },
      reason,
      source: 'cms',
      correlationId,
      branchId: tenant.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'refund.calculated',
      payload: { refundId: row.id, tenantId: tenant.id, amount: calc.final, computation },
      branchId: tenant.branchId,
      correlationId,
    });
    return { row, deduplicated: false };
  });
  return { refund: serializeRefund(created.row) };
}

export interface DecideRefundOpts {
  expectedVersion?: number;
  actor: string;
  /** Super-admin single-step only — every other caller must differ from the requestor. */
  isOwner: boolean;
  reason?: string;
}

function checkChecker(row: { requestedBy: string; status: string }, opts: DecideRefundOpts, verb: string): { bypassed: boolean } {
  if (row.status !== 'REQUESTED') {
    throw new AppError(409, 'CONFLICT', `Only REQUESTED refunds can be ${verb} (this one is ${row.status}).`);
  }
  if (opts.actor === row.requestedBy && !opts.isOwner) {
    throw new AppError(403, 'MAKER_CHECKER', 'The requestor cannot approve their own refund — a different approver is required.');
  }
  if (opts.actor === row.requestedBy && opts.isOwner) {
    if (!(opts.reason ?? '').trim()) {
      throw new AppError(400, 'VALIDATION', 'A reason is required for a super-admin single-step (it is written to the audit trail).');
    }
    return { bypassed: true };
  }
  return { bypassed: false };
}

export async function approveRefund(id: string, opts: DecideRefundOpts) {
  await assertRefundPolicy();
  const now = await prisma.refund.findUnique({ where: { id } });
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Refund not found');
  const { bypassed } = checkChecker(now, opts, 'approved');
  assertFreshVersion(now.version, opts.expectedVersion, 'refund');
  const correlationId = newCorrelationId();
  const row = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const updated = (await db.refund.update({
      where: { id, version: now.version },
      data: {
        status: 'APPROVED',
        approvedBy: opts.actor,
        decidedAt: new Date(),
        decisionReason: opts.reason?.trim() || null,
        bypassed,
        version: nextVersion(now.version),
      },
      include: { tenant: true },
    })) as RefundWithTenant;
    await writeAuditEvent(db, {
      actor: opts.actor,
      action: 'REFUND_APPROVED',
      entityType: 'refund',
      entityId: id,
      before: { status: 'REQUESTED', version: now.version },
      after: { status: 'APPROVED', version: updated.version, bypassed },
      reason: opts.reason?.trim() || undefined,
      source: 'cms',
      correlationId,
      branchId: updated.branchId,
    });
    if (bypassed) {
      // Q4 risk-accepted bypass: the exemption itself is a first-class audit
      // event with actor + reason — visible in GET /finance/audit.
      await writeAuditEvent(db, {
        actor: opts.actor,
        action: 'REFUND_BYPASS',
        entityType: 'refund',
        entityId: id,
        after: { singleSteppedBy: opts.actor, reason: opts.reason?.trim() },
        reason: opts.reason?.trim(),
        source: 'cms',
        correlationId,
        branchId: updated.branchId,
      });
    }
    await publishFinanceEvent(db, {
      type: 'refund.approved',
      payload: { refundId: id, amount: toNum(updated.amount), bypassed },
      branchId: updated.branchId,
      correlationId,
    });
    return updated;
  });
  return serializeRefund(row);
}

export async function rejectRefund(id: string, opts: DecideRefundOpts) {
  await assertRefundPolicy();
  const now = await prisma.refund.findUnique({ where: { id } });
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Refund not found');
  const { bypassed } = checkChecker(now, opts, 'rejected');
  const reason = (opts.reason ?? '').trim();
  if (!reason) throw new AppError(400, 'VALIDATION', 'A rejection reason is required.');
  assertFreshVersion(now.version, opts.expectedVersion, 'refund');
  const correlationId = newCorrelationId();
  const row = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const updated = (await db.refund.update({
      where: { id, version: now.version },
      data: {
        status: 'REJECTED',
        approvedBy: opts.actor,
        decidedAt: new Date(),
        decisionReason: reason,
        bypassed,
        version: nextVersion(now.version),
      },
      include: { tenant: true },
    })) as RefundWithTenant;
    await writeAuditEvent(db, {
      actor: opts.actor,
      action: 'REFUND_REJECTED',
      entityType: 'refund',
      entityId: id,
      before: { status: 'REQUESTED', version: now.version },
      after: { status: 'REJECTED', version: updated.version },
      reason,
      source: 'cms',
      correlationId,
      branchId: updated.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'refund.rejected',
      payload: { refundId: id, amount: toNum(updated.amount), reason },
      branchId: updated.branchId,
      correlationId,
    });
    return updated;
  });
  return serializeRefund(row);
}

export async function verifyRefundBank(id: string, opts: { actor: string; bankRef?: string }) {
  const now = await prisma.refund.findUnique({ where: { id } });
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Refund not found');
  if (now.status !== 'APPROVED' && now.status !== 'REQUESTED') {
    throw new AppError(409, 'CONFLICT', `Bank details can only be verified on a REQUESTED/APPROVED refund (this one is ${now.status}).`);
  }
  const bankRef = (opts.bankRef ?? '').trim();
  if (!bankRef) throw new AppError(400, 'VALIDATION', 'Verified bank details (bankRef) are required.');
  const correlationId = newCorrelationId();
  const row = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const updated = (await db.refund.update({
      where: { id },
      data: { bankVerified: true, bankRef, version: nextVersion(now.version) },
      include: { tenant: true },
    })) as RefundWithTenant;
    await writeAuditEvent(db, {
      actor: opts.actor,
      action: 'REFUND_BANK_VERIFIED',
      entityType: 'refund',
      entityId: id,
      after: { bankVerified: true, bankRef },
      source: 'cms',
      correlationId,
      branchId: updated.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'refund.bank.verified',
      payload: { refundId: id, bankRef },
      branchId: updated.branchId,
      correlationId,
    });
    return updated;
  });
  return serializeRefund(row);
}

export async function payRefund(id: string, opts: DecideRefundOpts & { gatewayRef?: string }) {
  await assertRefundPolicy();
  const now = await prisma.refund.findUnique({ where: { id } });
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Refund not found');
  if (now.status !== 'APPROVED') {
    throw new AppError(409, 'CONFLICT', `Only APPROVED refunds can be paid (this one is ${now.status}).`);
  }
  if (!now.bankVerified) {
    throw new AppError(409, 'BLOCKED', 'Bank-account verification is required before any refund reaches PAID — record it via the verify step first.');
  }
  if (opts.actor === now.requestedBy && !opts.isOwner) {
    throw new AppError(403, 'MAKER_CHECKER', 'The requestor cannot pay their own refund — a different operator must execute it.');
  }
  assertFreshVersion(now.version, opts.expectedVersion, 'refund');
  const gatewayRef = (opts.gatewayRef ?? '').trim() || null;
  const correlationId = newCorrelationId();
  const row = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const updated = (await db.refund.update({
      where: { id, version: now.version },
      data: { status: 'PAID', gatewayRef, version: nextVersion(now.version) },
      include: { tenant: true },
    })) as RefundWithTenant;
    await writeAuditEvent(db, {
      actor: opts.actor,
      action: 'REFUND_PAID',
      entityType: 'refund',
      entityId: id,
      before: { status: 'APPROVED', version: now.version },
      after: { status: 'PAID', version: updated.version, gatewayRef },
      source: 'cms',
      correlationId,
      branchId: updated.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'refund.succeeded',
      payload: { refundId: id, tenantId: updated.tenantId, amount: toNum(updated.amount), gatewayRef },
      branchId: updated.branchId,
      correlationId,
    });
    return updated;
  });
  return serializeRefund(row);
}

/**
 * Recent credit-wallet movements across customers (StoreLah Credits ledger,
 * spec §19.1/§19.4). Read-only view over the append-only ledger; facility
 * scoped through the wallet's branch when a branchId is given.
 */
export async function listCreditLedger(opts: { branchId?: string; take?: number } = {}) {
  const rows = await prisma.creditLedgerEntry.findMany({
    where: opts.branchId ? { wallet: { branchId: opts.branchId } } : {},
    include: { wallet: { include: { tenant: { select: { name: true } } } } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.take ?? 100, 500),
  });
  return rows.map((e) => ({
    id: e.id, tenantId: e.wallet.tenantId, tenant: e.wallet.tenant.name, kind: e.kind,
    amount: toNum(e.amount), note: e.note, refId: e.refId, actor: e.actor, createdAt: e.createdAt,
  }));
}

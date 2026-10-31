// Payment instructions — the Transactions register (FINANCE_MODULE_SPEC §10).
//
// Lifecycle: PENDING_APPROVAL → QUEUED (via approve) → SUBMITTED (via retry/
// submit) → SUCCEEDED / FAILED (via webhook), CANCELLED from anywhere
// pre-terminal. APPROVED is recorded on the row (approvedBy/approvedAt) and
// in audit/outbox; the approve step lands in QUEUED (spec §10.3 step 9).
// DRAFT/EXPIRED exist for spec-completeness; Phase 3 never writes them.
//
// Controls (spec §4.1, Q3): EVERY charge is approved INDIVIDUALLY — no bulk
// endpoint, bulk column, or bulk code path exists anywhere in src/. Maker-
// checker (approver ≠ creator) is enforced in service code regardless of
// role. Approval server-REVALIDATES invoice status/balance, mandate and
// duplicate protection; submission revalidates + charges the saved card
// off-session (TEST MODE) under the instruction's STABLE idempotency key,
// so a retried submit converges on one PaymentIntent.
//
// Approval validates the mandate LINK (customer wallet in DB — hermetic,
// no Stripe call); submission resolves the DEFAULT card and charges it.
// The modal therefore shows "wallet linked — card verified at submission".

import type Stripe from 'stripe';
import { prisma } from '../../lib/prisma';
import { toNum } from '../../lib/format';
import { AppError } from '../../lib/http';
import { writeAuditEvent } from './audit';
import { publishFinanceEvent, claimStripeEvent } from './events';
import { assertFreshVersion, nextVersion, newCorrelationId } from './idempotency';
import { getStripe } from '../checkout';
import { loadDefaultPaymentMethod } from '../savedCards';
import { postInvoiceReceiptTx, openInvoiceBalance } from '../invoicePayments';

type Db = Pick<
  typeof prisma,
  'invoice' | 'paymentInstruction' | 'processedStripeEvent' | 'financeAuditEvent' | 'financeEvent'
>;

const TERMINAL = ['SUCCEEDED', 'CANCELLED', 'EXPIRED'] as const;
/** States that still own the invoice balance (block a second instruction). */
const ACTIVE = ['PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'SUBMITTED', 'FAILED'] as const;
const CANCELLABLE = ['PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'FAILED'] as const;
const RECEIVABLE = ['ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID'] as const;

export interface InstructionRow {
  id: string;
  invoiceId: string;
  invoiceNo: string;
  tenantId: string;
  tenant: string;
  tenantEmail: string | null;
  unit: string;
  branch: string;
  branchId: string | null;
  amount: number;
  method: string;
  status: string;
  version: number;
  attempts: number;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  paymentIntentId: string | null;
  failureReason: string | null;
  lastError: string | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

type InstructionWithJoins = {
  id: string;
  invoiceId: string;
  tenantId: string;
  amount: unknown;
  method: string;
  status: string;
  version: number;
  attempts: number;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  stripePaymentIntentId: string | null;
  failureReason: string | null;
  lastError: string | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
  invoice: {
    id: string;
    invoiceNo: string;
    amount: unknown;
    amountPaid: unknown;
    balanceDue: unknown;
    status: string;
    unit: { unitCode: string; branchId: string | null; branch: { name: string } };
  };
  tenant: { id: string; name: string; email: string | null; autoDebit: boolean };
};

const INSTRUCTION_INCLUDE = {
  invoice: { include: { unit: { include: { branch: true } } } },
  tenant: true,
} as const;

export function serializeInstruction(x: InstructionWithJoins): InstructionRow {
  return {
    id: x.id,
    invoiceId: x.invoiceId,
    invoiceNo: x.invoice.invoiceNo,
    tenantId: x.tenantId,
    tenant: x.tenant.name,
    tenantEmail: x.tenant.email,
    unit: x.invoice.unit.unitCode,
    branch: x.invoice.unit.branch.name,
    branchId: x.invoice.unit.branchId,
    amount: toNum(x.amount as never),
    method: x.method,
    status: x.status,
    version: x.version,
    attempts: x.attempts,
    createdBy: x.createdBy,
    approvedBy: x.approvedBy,
    approvedAt: x.approvedAt,
    paymentIntentId: x.stripePaymentIntentId,
    failureReason: x.failureReason,
    lastError: x.lastError,
    idempotencyKey: x.idempotencyKey,
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
  };
}

export async function listInstructions(opts: { status?: string; branchId?: string; invoiceId?: string }) {
  const valid = ['PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'DRAFT', 'EXPIRED'];
  const where: Record<string, unknown> = {};
  if (opts.status) {
    if (!valid.includes(opts.status)) throw new AppError(400, 'VALIDATION', `Unknown instruction status ${opts.status}.`);
    where.status = opts.status;
  }
  if (opts.invoiceId) where.invoiceId = opts.invoiceId;
  if (opts.branchId) where.invoice = { unit: { branchId: opts.branchId } };
  const rows = (await prisma.paymentInstruction.findMany({
    where,
    include: INSTRUCTION_INCLUDE,
    orderBy: { createdAt: 'desc' },
    // §25.3: registers are server-side bounded (filters narrow further).
    take: 500,
  })) as unknown as InstructionWithJoins[];
  return rows.map(serializeInstruction);
}

/** Wallet (off-session mandate) linked to the tenant's email, if any. */
async function walletForTenant(tenantEmail: string | null) {
  if (!tenantEmail?.trim()) return null;
  return prisma.customer.findFirst({
    where: { email: { equals: tenantEmail.trim(), mode: 'insensitive' } },
    select: { id: true, stripeCustomerId: true },
  });
}

export interface InstructionDetail extends InstructionRow {
  invoice: {
    id: string;
    no: string;
    status: string;
    total: number;
    amountPaid: number;
    balanceDue: number;
  };
  mandate: { walletLinked: boolean; autoDebit: boolean };
}

export async function getInstructionDetail(id: string): Promise<InstructionDetail> {
  const x = (await prisma.paymentInstruction.findUnique({
    where: { id },
    include: INSTRUCTION_INCLUDE,
  })) as unknown as InstructionWithJoins | null;
  if (!x) throw new AppError(404, 'NOT_FOUND', 'Payment instruction not found');
  const wallet = await walletForTenant(x.tenant.email);
  const total = toNum(x.invoice.amount as never);
  const paid = toNum(x.invoice.amountPaid as never);
  return {
    ...serializeInstruction(x),
    invoice: {
      id: x.invoice.id,
      no: x.invoice.invoiceNo,
      status: x.invoice.status,
      total,
      amountPaid: paid,
      balanceDue:
        x.invoice.balanceDue != null
          ? toNum(x.invoice.balanceDue as never)
          : Math.round((total - paid) * 100) / 100,
    },
    mandate: { walletLinked: !!wallet?.stripeCustomerId, autoDebit: x.tenant.autoDebit },
  };
}

export interface CreateInstructionInput {
  invoiceId: string;
  amount?: number;
  idempotencyKey?: string | null;
  actor: string;
}

async function createInstructionTx(
  db: Db,
  input: CreateInstructionInput,
  opts: { invoice?: { id: string; tenantId: string; status: string; unit: { unitCode: string; branchId: string | null; branch: { name: string } } } & Record<string, unknown> } = {},
) {
  if (input.idempotencyKey) {
    const existing = await db.paymentInstruction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: INSTRUCTION_INCLUDE,
    });
    if (existing) return { row: existing as unknown as InstructionWithJoins, deduplicated: true };
  }
  // The issue path passes its just-flipped ISSUED row (same tx, not yet
  // committed — a fresh read would still see APPROVED).
  const loaded = opts.invoice;
  const invoice = loaded ?? await prisma.invoice.findUnique({
    where: { id: input.invoiceId },
    include: { unit: { include: { branch: true } } },
  });
  if (!invoice) throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
  if (!(RECEIVABLE as readonly string[]).includes(invoice.status)) {
    throw new AppError(409, 'CONFLICT', `Instructions can only be created for receivable invoices (this one is ${invoice.status}).`);
  }
  // §10.6: one active instruction per invoice balance unless explicitly split
  // — Phase 3 has no split path, so a second live instruction is refused.
  const live = await db.paymentInstruction.findFirst({
    where: { invoiceId: invoice.id, status: { in: [...ACTIVE] } },
    select: { id: true, status: true },
  });
  if (live) {
    throw new AppError(409, 'CONFLICT', `This invoice already has a live instruction (${live.status}) — approve, submit or cancel it first.`);
  }
  const balance = openInvoiceBalance(invoice as never);
  if (!(balance > 0)) throw new AppError(409, 'CONFLICT', 'This invoice has no open balance to collect.');
  const amount = input.amount ?? balance;
  if (!(amount > 0) || amount > balance + 0.005) {
    throw new AppError(400, 'VALIDATION', `Amount must be above 0 and within the open balance (${balance}).`);
  }
  const correlationId = input.idempotencyKey ?? `instr-${newCorrelationId()}`;
  const row = (await db.paymentInstruction.create({
    data: {
      invoiceId: invoice.id,
      tenantId: invoice.tenantId,
      amount: Math.round(amount * 100) / 100,
      method: 'SAVED_CARD',
      status: 'PENDING_APPROVAL',
      idempotencyKey: correlationId,
      createdBy: input.actor,
    },
    include: INSTRUCTION_INCLUDE,
  })) as unknown as InstructionWithJoins;
  await writeAuditEvent(db, {
    actor: input.actor,
    action: 'PAYMENT_INSTRUCTION_CREATED',
    entityType: 'payment-instruction',
    entityId: row.id,
    after: { invoiceId: invoice.id, amount: row.amount, status: 'PENDING_APPROVAL' },
    source: 'cms',
    correlationId: newCorrelationId(),
    branchId: invoice.unit.branchId,
  });
  await publishFinanceEvent(db, {
    type: 'payment.instruction.created',
    payload: { instructionId: row.id, invoiceId: invoice.id, amount: toNum(row.amount as never) },
    branchId: invoice.unit.branchId,
    correlationId: newCorrelationId(),
  });
  return { row, deduplicated: false };
}

export { createInstructionTx };

export async function createInstruction(input: CreateInstructionInput) {
  const out = await prisma.$transaction(async (tx) => createInstructionTx(tx as unknown as Db, input));
  return { instruction: serializeInstruction(out.row), deduplicated: out.deduplicated };
}

export async function approveInstruction(id: string, opts: { expectedVersion?: number; actor: string }) {
  const now = (await prisma.paymentInstruction.findUnique({
    where: { id },
    include: { invoice: true, tenant: true },
  })) as unknown as (InstructionWithJoins & { invoice: { status: string } }) | null;
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Payment instruction not found');
  if (now.status !== 'PENDING_APPROVAL') {
    throw new AppError(409, 'CONFLICT', `Only PENDING_APPROVAL instructions can be approved (this one is ${now.status}).`);
  }
  // Maker-checker (spec §4.1, Q3): the requestor can NEVER approve their own
  // charge — enforced in service code regardless of role.
  if (now.createdBy === opts.actor) {
    throw new AppError(403, 'MAKER_CHECKER', 'The requestor cannot approve their own charge — a different approver is required.');
  }
  assertFreshVersion(now.version, opts.expectedVersion, 'payment instruction');
  // Server revalidation at approval (§10.4/§10.6): invoice state, balance,
  // mandate link and duplicate protection are re-checked NOW, not trusted
  // from the modal's open-time snapshot.
  if (!(RECEIVABLE as readonly string[]).includes(now.invoice.status)) {
    throw new AppError(409, 'INVOICE_CHANGED', `The invoice is no longer receivable (now ${now.invoice.status}) — review before approving.`);
  }
  const balance = openInvoiceBalance(now.invoice as never);
  if (!(balance > 0)) throw new AppError(409, 'INVOICE_CHANGED', 'The invoice balance is zero — nothing left to collect.');
  if (toNum(now.amount as never) > balance + 0.005) {
    throw new AppError(409, 'INVOICE_CHANGED', 'The invoice balance changed during review — reload and re-approve the new amount.');
  }
  const wallet = await walletForTenant(now.tenant.email);
  if (!wallet?.stripeCustomerId) {
    throw new AppError(409, 'MANDATE_REQUIRED', 'No saved-card wallet is linked to this customer — the mandate check fails until they save a card.');
  }
  const correlationId = newCorrelationId();
  const row = (await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const updated = (await db.paymentInstruction.update({
      where: { id, version: now.version },
      data: { status: 'QUEUED', approvedBy: opts.actor, approvedAt: new Date(), version: nextVersion(now.version) },
      include: INSTRUCTION_INCLUDE,
    })) as unknown as InstructionWithJoins;
    await writeAuditEvent(db, {
      actor: opts.actor,
      action: 'PAYMENT_APPROVED',
      entityType: 'payment-instruction',
      entityId: id,
      before: { status: 'PENDING_APPROVAL', version: now.version, invoiceBalance: balance },
      after: { status: 'QUEUED', version: updated.version },
      source: 'cms',
      correlationId,
      branchId: updated.invoice.unit.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'payment.approved',
      payload: { instructionId: id, invoiceId: updated.invoiceId, approvedBy: opts.actor },
      branchId: updated.invoice.unit.branchId,
      correlationId,
    });
    return updated;
  })) as unknown as InstructionWithJoins;
  return serializeInstruction(row);
}

export async function cancelInstructionTx(
  db: Db,
  id: string,
  opts: { actor: string; reason?: string | null; correlationId?: string },
) {
  const now = await db.paymentInstruction.findUnique({ where: { id }, include: { invoice: { include: { unit: true } } } });
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Payment instruction not found');
  if (!(CANCELLABLE as readonly string[]).includes(now.status as never)) {
    throw new AppError(409, 'CONFLICT', `Only pending/queued/failed instructions can be cancelled (this one is ${now.status}).`);
  }
  const correlationId = opts.correlationId ?? newCorrelationId();
  const updated = await db.paymentInstruction.update({
    where: { id },
    data: { status: 'CANCELLED', failureReason: opts.reason?.trim() || now.failureReason, version: now.version + 1 },
    include: INSTRUCTION_INCLUDE,
  });
  await writeAuditEvent(db, {
    actor: opts.actor,
    action: 'PAYMENT_CANCELLED',
    entityType: 'payment-instruction',
    entityId: id,
    before: { status: now.status },
    after: { status: 'CANCELLED' },
    reason: opts.reason ?? undefined,
    source: 'cms',
    correlationId,
    branchId: (updated as unknown as InstructionWithJoins).invoice.unit.branchId,
  });
  return updated as unknown as InstructionWithJoins;
}

export async function cancelInstruction(id: string, opts: { expectedVersion?: number; reason?: string; actor: string }) {
  const now = await prisma.paymentInstruction.findUnique({ where: { id } });
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Payment instruction not found');
  assertFreshVersion(now.version, opts.expectedVersion, 'payment instruction');
  const row = await prisma.$transaction(async (tx) =>
    cancelInstructionTx(tx as unknown as Db, id, { actor: opts.actor, reason: opts.reason ?? null }),
  );
  return serializeInstruction(row);
}

/**
 * Submit (or retry) a queued charge (spec §10.3 step 9, §10.5): creates (or
 * replays, via the instruction's STABLE idempotency key) the off-session
 * Stripe PaymentIntent for the instruction amount. Retry-after-anything uses
 * the SAME key — concurrent submits converge on one PI (charge.retry-same-key).
 * No bulk path exists: one instruction per call, always.
 */
export async function submitInstruction(id: string, opts: { expectedVersion?: number; actor: string }) {
  const now = (await prisma.paymentInstruction.findUnique({
    where: { id },
    include: { invoice: { include: { unit: { include: { branch: true } } } }, tenant: true },
  })) as unknown as InstructionWithJoins | null;
  if (!now) throw new AppError(404, 'NOT_FOUND', 'Payment instruction not found');
  if ((TERMINAL as readonly string[]).includes(now.status as never) || now.status === 'PENDING_APPROVAL') {
    throw new AppError(409, 'CONFLICT', `Only queued/failed instructions can be submitted (this one is ${now.status}).`);
  }
  assertFreshVersion(now.version, opts.expectedVersion, 'payment instruction');
  // A SUBMITTED instruction is already with the processor — return it without
  // touching Stripe (double-click safe; the webhook owns the outcome).
  if (now.status === 'SUBMITTED' && now.stripePaymentIntentId) {
    return serializeInstruction(now);
  }
  if (!(RECEIVABLE as readonly string[]).includes(now.invoice.status)) {
    throw new AppError(409, 'INVOICE_CHANGED', `The invoice is no longer receivable (now ${now.invoice.status}).`);
  }
  const balance = openInvoiceBalance(now.invoice as never);
  if (!(balance > 0)) throw new AppError(409, 'CONFLICT', 'The invoice balance is zero — nothing left to collect.');
  if (toNum(now.amount as never) > balance + 0.005) {
    throw new AppError(409, 'INVOICE_CHANGED', 'The invoice balance changed — cancel and re-raise the instruction for the new balance.');
  }
  const wallet = await walletForTenant(now.tenant.email);
  if (!wallet?.stripeCustomerId) {
    await prisma.paymentInstruction.update({
      where: { id },
      data: { lastError: 'No saved-card wallet linked to this customer.' },
    });
    throw new AppError(409, 'MANDATE_REQUIRED', 'No saved-card wallet is linked to this customer.');
  }
  const card = await loadDefaultPaymentMethod(wallet.stripeCustomerId);
  if (!card) {
    await prisma.paymentInstruction.update({
      where: { id },
      data: { lastError: 'The customer has no default saved card to charge.' },
    });
    throw new AppError(409, 'MANDATE_REQUIRED', 'The customer has no default saved card to charge.');
  }
  const stripe = getStripe();
  const amountCents = Math.round(toNum(now.amount as never) * 100);
  const correlationId = newCorrelationId();
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: 'sgd',
        customer: wallet.stripeCustomerId,
        payment_method: card.pm.id,
        payment_method_types: ['card'],
        confirm: true,
        off_session: true,
        description: `StoreLah queued charge ${now.invoice.invoiceNo} — unit ${now.invoice.unit.unitCode}`,
        metadata: {
          kind: 'instruction',
          instructionId: now.id,
          invoiceId: now.invoiceId,
          invoiceNo: now.invoice.invoiceNo,
        },
      },
      { idempotencyKey: now.idempotencyKey },
    );
  } catch (e) {
    if (isStripeCardError(e)) {
      // Synchronous decline: no webhook will arrive — the failure is final
      // for this attempt. The stored PI keeps the evidence; recovery is
      // retry (same key replays) / secure link (Phase 4) / cancel.
      const failedPi = e.payment_intent;
      const updated = await prisma.$transaction(async (tx) => {
        const db = tx as unknown as Db;
        const u = (await db.paymentInstruction.update({
          where: { id },
          data: {
            status: 'FAILED',
            stripePaymentIntentId: failedPi?.id ?? now.stripePaymentIntentId,
            failureReason: e.message || 'Card declined',
            lastError: null,
            attempts: now.attempts + 1,
            version: nextVersion(now.version),
          },
          include: INSTRUCTION_INCLUDE,
        })) as unknown as InstructionWithJoins;
        await writeAuditEvent(db, {
          actor: opts.actor,
          action: 'PAYMENT_FAILED',
          entityType: 'payment-instruction',
          entityId: id,
          before: { status: now.status },
          after: { status: 'FAILED', failureReason: u.failureReason },
          source: 'cms',
          correlationId,
          branchId: u.invoice.unit.branchId,
        });
        await publishFinanceEvent(db, {
          type: 'payment.failed',
          payload: { instructionId: id, reason: u.failureReason },
          branchId: u.invoice.unit.branchId,
          correlationId,
        });
        return u;
      });
      return serializeInstruction(updated);
    }
    // Processor outage: the instruction stays QUEUED and visible (never
    // silently FAILED) — charge.outage-queues. The 502 names the outage.
    await prisma.paymentInstruction.update({
      where: { id },
      data: { attempts: now.attempts + 1, lastError: e instanceof Error ? e.message : String(e) },
    });
    throw new AppError(502, 'PROCESSOR_OUTAGE', 'The payment processor is unreachable — the charge stays queued. Retry shortly.');
  }
  if (pi.status === 'succeeded' || pi.status === 'processing') {
    const updated = await prisma.$transaction(async (tx) => {
      const db = tx as unknown as Db;
      const u = (await db.paymentInstruction.update({
        where: { id },
        data: {
          status: 'SUBMITTED',
          stripePaymentIntentId: pi.id,
          failureReason: null,
          lastError: null,
          attempts: now.attempts + 1,
          version: nextVersion(now.version),
        },
        include: INSTRUCTION_INCLUDE,
      })) as unknown as InstructionWithJoins;
      await writeAuditEvent(db, {
        actor: opts.actor,
        action: 'PAYMENT_SUBMITTED',
        entityType: 'payment-instruction',
        entityId: id,
        before: { status: now.status },
        after: { status: 'SUBMITTED', paymentIntentId: pi.id },
        source: 'cms',
        correlationId,
        branchId: u.invoice.unit.branchId,
      });
      await publishFinanceEvent(db, {
        type: 'payment.submitted',
        payload: { instructionId: id, paymentIntentId: pi.id },
        branchId: u.invoice.unit.branchId,
        correlationId,
      });
      return u;
    });
    return serializeInstruction(updated);
  }
  // Off-session authentication_required (or any other non-terminal state) can
  // never be fulfilled without the customer present — FAILED with a recovery
  // hint, never stuck in limbo.
  const updated = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    const u = (await db.paymentInstruction.update({
      where: { id },
      data: {
        status: 'FAILED',
        stripePaymentIntentId: pi.id,
        failureReason: pi.status === 'requires_action' ? 'authentication_required — customer action needed' : `processor returned ${pi.status}`,
        lastError: null,
        attempts: now.attempts + 1,
        version: nextVersion(now.version),
      },
      include: INSTRUCTION_INCLUDE,
    })) as unknown as InstructionWithJoins;
    await writeAuditEvent(db, {
      actor: opts.actor,
      action: 'PAYMENT_FAILED',
      entityType: 'payment-instruction',
      entityId: id,
      before: { status: now.status },
      after: { status: 'FAILED', failureReason: u.failureReason },
      source: 'cms',
      correlationId,
      branchId: u.invoice.unit.branchId,
    });
    await publishFinanceEvent(db, {
      type: 'payment.failed',
      payload: { instructionId: id, reason: u.failureReason },
      branchId: u.invoice.unit.branchId,
      correlationId,
    });
    return u;
  });
  return serializeInstruction(updated);
}

function isStripeCardError(e: unknown): e is { type: string; message?: string; payment_intent?: Stripe.PaymentIntent } {
  return typeof e === 'object' && e !== null && (e as { type?: string }).type === 'StripeCardError';
}

/**
 * Webhook side for queued charges (payment_intent.succeeded with
 * metadata.kind === 'instruction'). IDEMPOTENT by Stripe event id: the claim
 * and every write share ONE transaction, so a duplicate delivery (same event
 * id) applies exactly once and a crash rolls the claim back with the writes.
 * Success posts the allocation to the invoice (PAID in full, else
 * PARTIALLY_PAID with updated amounts) — spec §10.3 steps 10–11.
 */
export async function applyInstructionPaymentSucceeded(
  pi: Stripe.PaymentIntent,
  opts: { eventId?: string } = {},
): Promise<{ instructionId: string | null; invoiceNo: string | null; applied: boolean }> {
  const instructionId = pi.metadata?.instructionId ?? null;
  if (!instructionId || pi.status !== 'succeeded') {
    return { instructionId, invoiceNo: pi.metadata?.invoiceNo ?? null, applied: false };
  }
  if (!opts.eventId) {
    throw new AppError(400, 'VALIDATION', 'A Stripe event id is required to apply a queued-charge payment.');
  }
  const out = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    if (!(await claimStripeEvent(db, opts.eventId as string, 'payment_intent.succeeded'))) {
      return { instructionId, invoiceNo: pi.metadata?.invoiceNo ?? null, applied: false };
    }
    const now = (await db.paymentInstruction.findUnique({
      where: { id: instructionId },
      include: { invoice: true },
    })) as unknown as (InstructionWithJoins & { invoice: { status: string } }) | null;
    if (!now) return { instructionId, invoiceNo: pi.metadata?.invoiceNo ?? null, applied: false };
    if (now.stripePaymentIntentId !== pi.id) {
      console.log(`[queued-charge] intent mismatch for instruction ${instructionId} — ignored`);
      return { instructionId, invoiceNo: now.invoice.invoiceNo, applied: false };
    }
    if (now.status !== 'SUBMITTED') {
      return { instructionId, invoiceNo: now.invoice.invoiceNo, applied: false };
    }
    const receivedCents =
      typeof pi.amount_received === 'number' && pi.amount_received > 0 ? pi.amount_received : pi.amount;
    await db.paymentInstruction.update({
      where: { id: instructionId },
      data: { status: 'SUCCEEDED', version: nextVersion(now.version) },
    });
    const receipt = await postInvoiceReceiptTx(db, now.invoice as never, toNum(receivedCents / 100), {
      method: 'Card',
      paymentIntentId: pi.id,
    });
    const correlationId = newCorrelationId();
    await writeAuditEvent(db, {
      actor: 'stripe-webhook',
      action: 'PAYMENT_SUCCEEDED',
      entityType: 'payment-instruction',
      entityId: instructionId,
      before: { status: 'SUBMITTED' },
      after: { status: 'SUCCEEDED', invoiceStatus: receipt.status },
      source: 'webhook',
      correlationId,
      branchId: (now.invoice as unknown as { unit?: { branchId?: string | null } }).unit?.branchId ?? null,
    });
    await publishFinanceEvent(db, {
      type: 'payment.succeeded',
      payload: { instructionId, invoiceId: now.invoiceId, invoiceStatus: receipt.status },
      branchId: (now.invoice as unknown as { unit?: { branchId?: string | null } }).unit?.branchId ?? null,
      correlationId,
    });
    return { instructionId, invoiceNo: receipt.invoiceNo, applied: receipt.applied };
  });
  return out;
}

/**
 * Webhook side for queued-charge failures (payment_intent.payment_failed with
 * metadata.kind === 'instruction'). Same event-id claim as success.
 */
export async function applyInstructionPaymentFailed(
  pi: Stripe.PaymentIntent,
  opts: { eventId?: string } = {},
): Promise<{ instructionId: string | null; applied: boolean }> {
  const instructionId = pi.metadata?.instructionId ?? null;
  if (!instructionId) return { instructionId, applied: false };
  if (!opts.eventId) {
    throw new AppError(400, 'VALIDATION', 'A Stripe event id is required to apply a queued-charge failure.');
  }
  return prisma.$transaction(async (tx) => {
    const db = tx as unknown as Db;
    if (!(await claimStripeEvent(db, opts.eventId as string, 'payment_intent.payment_failed'))) {
      return { instructionId, applied: false };
    }
    const now = await db.paymentInstruction.findUnique({
      where: { id: instructionId },
      include: { invoice: { include: { unit: true } } },
    });
    if (!now || now.stripePaymentIntentId !== pi.id || now.status !== 'SUBMITTED') {
      return { instructionId, applied: false };
    }
    const reason =
      (pi as unknown as { last_payment_error?: { message?: string } }).last_payment_error?.message ||
      'Processor reported failure';
    await db.paymentInstruction.update({
      where: { id: instructionId },
      data: { status: 'FAILED', failureReason: reason, version: now.version + 1 },
    });
    const correlationId = newCorrelationId();
    const branchId = (now as unknown as { invoice: { unit: { branchId: string | null } } }).invoice.unit.branchId;
    await writeAuditEvent(db, {
      actor: 'stripe-webhook',
      action: 'PAYMENT_FAILED',
      entityType: 'payment-instruction',
      entityId: instructionId,
      before: { status: 'SUBMITTED' },
      after: { status: 'FAILED', failureReason: reason },
      source: 'webhook',
      correlationId,
      branchId,
    });
    await publishFinanceEvent(db, {
      type: 'payment.failed',
      payload: { instructionId, reason },
      branchId,
      correlationId,
    });
    return { instructionId, applied: true };
  });
}

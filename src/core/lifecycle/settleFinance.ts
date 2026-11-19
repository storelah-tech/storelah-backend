// Settlement finance (Track A, phase A4): manual refunds, approvals,
// change-request round-trips, idempotent processing, Stripe reconciliation
// and append-only ledger posting for move-out / manual settlements.
//
// One service for every CustomerSettlement in the new lifecycle
// (PENDING_APPROVAL | CHANGES_REQUESTED | APPROVED | PROCESSING |
//  REFUNDED | POSTED | FAILED | CANCELLED). Legacy PENDING/APPROVED/REJECTED
// rows keep the old decideSettlement flow (see routes/cms.ts dispatch); legacy
// APPROVED rows flow through processSettlement() directly — nothing was ever
// posted for them, so they must NOT become POSTED without processing.
//
// Rules (handoff §§10/13 wins on formulas; brief R-rules on plumbing):
// - Preview/post share computation: processSettlement() and correctSettlement()
//   re-derive every material amount server-side — a client total is never used.
// - Maker-checker (D5): approver ≠ requester; the process actor is a third
//   party distinct from both requester and approver. Owner single-step bypass
//   is allowed with a mandatory reason, audited ( refund precedent in
//   core/finance/credits.ts checkChecker).
// - Approval role (handoff §14): moveout.approvalRole ADMIN_ONLY restricts
//   approval to the Owner; ADMIN_OR_FINANCE is the route permission
//   bill-transactions:approve.
// - Processor mapping (D6): ORIGINAL → Stripe refund on the source
//   PaymentIntent (test mode); BANK → Finance-recorded instruction + bank
//   confirmation (Phase 4 bank-verify rule kept); WALLET → CreditWallet GRANT.
//   Charges post as issued Invoices (D4, collectable via saved card) and
//   mirror a ledger debit line.
// - Idempotency: processSettlement() is keyed (Idempotency-Key header, stored
//   on ProcessorAttempt); re-running a posted settlement is a no-op success.
//   A failed processor call leaves the record Approved/Processing — never
//   Refunded — and the retry shares the same posting function (no duplicate
//   logic): postSettlementLedger() is the single writer of settlement ledger
//   lines for process, webhook reconcile and compensation retries.
// - Money: integer cents in code, Decimal(10,2) in the DB, toNum on the way
//   out. Tenant.monthlyRate is never touched by this module.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { toNum } from '../../lib/format';
import { writeAuditEvent } from '../finance/audit';
import { publishFinanceEvent } from '../finance/events';
import { assertFreshVersion, newCorrelationId } from '../finance/idempotency';
import { getBusinessRule } from '../businessRules';
import { getStripe } from '../checkout';
import { approveInvoice, createInvoice, issueInvoice } from '../finance/billing';
import { grantCredit } from '../finance/credits';
import { calculateMoveOutSettlement, MOVEOUT_CALC_VERSION } from './moveOutCalc';
import { completeMoveOutCase } from './moveOutService';
import { notifyChangeRequestAssignee } from '../recordNotes';

// ---------------------------------------------------------------------------
// Constants (handoff copy — verbatim where quoted)
// ---------------------------------------------------------------------------

/** Lifecycle values for CustomerSettlement.status (String column, §5). */
export const SETTLEMENT_STATUSES = [
  'PENDING', // legacy — routed to decideSettlement, never written here
  'PENDING_APPROVAL',
  'CHANGES_REQUESTED',
  'APPROVED',
  'PROCESSING',
  'REFUNDED',
  'POSTED',
  'FAILED',
  'CANCELLED',
  'REJECTED', // legacy terminal — routed to decideSettlement
] as const;

const TERMINAL_STATUSES = ['REFUNDED', 'POSTED', 'CANCELLED'];
const OPEN_SET_STATUSES = ['PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED', 'PROCESSING'];

/** Handoff §10.2: manual refunds are ONLY for these billing exceptions. */
export const MANUAL_REFUND_REASONS = [
  'duplicate-payment',
  'overcharge',
  'incorrect-deduction',
  'billing-correction',
  'service-recovery',
  'other',
] as const;

export const MANUAL_REFUND_REASON_LABELS: Record<string, string> = {
  'duplicate-payment': 'Duplicate payment',
  overcharge: 'Overcharge',
  'incorrect-deduction': 'Incorrect deduction',
  'billing-correction': 'Billing correction',
  'service-recovery': 'Service recovery',
  other: 'Other documented exception',
};

/** Reasons that must link the source transaction/invoice (handoff §10.3). */
const SOURCE_REQUIRED_REASONS = new Set([
  'duplicate-payment',
  'overcharge',
  'incorrect-deduction',
  'billing-correction',
]);

/** Handoff §10.3 return methods (CustomerSettlement.returnMethod values). */
export const RETURN_METHODS = ['ORIGINAL', 'BANK', 'WALLET'] as const;

export const RETURN_METHOD_LABELS: Record<string, string> = {
  ORIGINAL: 'Original payment method',
  BANK: 'Bank transfer',
  WALLET: 'Customer account credit',
};

// Handoff §10.3 exact validation copy.
const COPY_AMOUNT = 'Enter a refund amount greater than zero.';
const COPY_NOTES = 'Notes and the refund basis are required.';
const COPY_SOURCE = 'Link the source transaction or invoice for this billing refund.';
// Handoff §10.4 exact confirmation concept.
const submittedCopy = (ref: string) => `${ref} submitted for approval. No money has been sent.`;
// Handoff §10.7 exact approved copy.
const APPROVED_COPY = 'Approved; awaiting processor submission.';
// Handoff §19 exact empty-register copy.
export const NO_REFUNDS_COPY = 'No records match these filters.';

/** Category text for the ledger line label (`Refund · <category>`). */
function ledgerCategory(s: {
  origin: string | null;
  reasonCode: string | null;
  reason: string | null;
}): string {
  if (s.origin === 'MANUAL' && s.reasonCode) {
    return MANUAL_REFUND_REASON_LABELS[s.reasonCode] ?? s.reasonCode;
  }
  if (s.origin === 'MOVE_OUT') return s.reasonCode ?? s.reason ?? 'Move-out settlement';
  return s.reasonCode ?? s.reason ?? 'Settlement';
}

/** Display ref prefixes: RF- refunds, CH- charges, CL- zero-settlement closes. */
function prefixForDocType(docType: string): string {
  if (docType === 'Charge') return 'CH';
  if (docType === 'Zero settlement') return 'CL';
  return 'RF';
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const FULL_INCLUDE = {
  // CustomerSettlement carries only a scalar unitId (no unit relation), so
  // the unit context comes through the tenant's active unit.
  tenant: {
    select: {
      id: true, name: true, email: true, unitId: true, branchId: true,
      unit: {
        select: {
          id: true, unitCode: true, name: true, branchId: true,
          branch: { select: { id: true, code: true, name: true } },
        },
      },
    },
  },
  changeRequests: { orderBy: { createdAt: 'desc' as const } },
  processorAttempts: { orderBy: { attemptNo: 'desc' as const } },
  ledgerEntries: { orderBy: { createdAt: 'asc' as const } },
} as const;

export type SettlementRow = Prisma.CustomerSettlementGetPayload<{ include: typeof FULL_INCLUDE }>;

/** Facility for audit scoping: the tenant's active unit wins (billing F-3
 * rule), falling back to the tenant's branch cache. */
function branchIdOf(s: { tenant: { branchId: string | null; unit: { branchId: string } | null } }): string | null {
  return s.tenant.unit?.branchId ?? s.tenant.branchId ?? null;
}

function serializeAttempt(a: SettlementRow['processorAttempts'][number]) {
  return {
    id: a.id,
    provider: a.provider,
    providerRef: a.providerRef,
    attemptNo: a.attemptNo,
    amount: toNum(a.amount),
    status: a.status,
    errorCode: a.errorCode,
    errorMessage: a.errorMessage,
    reconciliation: a.reconciliation,
    attemptedAt: a.attemptedAt,
    confirmedAt: a.confirmedAt,
  };
}

function serializeLedgerLine(l: SettlementRow['ledgerEntries'][number]) {
  return {
    id: l.id,
    entryType: l.entryType,
    label: l.label,
    debit: l.debit != null ? toNum(l.debit) : null,
    credit: l.credit != null ? toNum(l.credit) : null,
    currency: l.currency,
    status: l.status,
    postedAt: l.postedAt,
    reversalOfId: l.reversalOfId,
    processorRef: l.processorRef,
    invoiceId: l.invoiceId,
    createdBy: l.createdBy,
  };
}

/** Full Finance review serialization (CMS only — customer payloads untouched). */
export function serializeFinanceSettlement(s: SettlementRow) {
  return {
    id: s.id,
    ref: s.ref,
    kind: s.kind,
    docType: s.docType,
    origin: s.origin,
    moveOutCaseId: s.moveOutCaseId,
    tenantId: s.tenantId,
    tenant: s.tenant,
    unitId: s.unitId,
    unit: s.tenant.unit
      ? {
          id: s.tenant.unit.id,
          unitCode: s.tenant.unit.unitCode,
          unitName: s.tenant.unit.name ?? s.tenant.unit.unitCode,
          branchId: s.tenant.unit.branchId,
          branchCode: s.tenant.unit.branch?.code ?? null,
          branchName: s.tenant.unit.branch?.name ?? null,
        }
      : null,
    effectiveDate: s.effectiveDate.toISOString().slice(0, 10),
    channel: s.channel,
    reason: s.reason,
    note: s.note,
    sourceRef: s.sourceRef,
    reasonCode: s.reasonCode,
    returnMethod: s.returnMethod,
    returnMethodLabel: s.returnMethod ? (RETURN_METHOD_LABELS[s.returnMethod] ?? s.returnMethod) : null,
    lines: s.lines,
    amount: toNum(s.amount),
    adjustment: s.adjustment,
    status: s.status,
    calcVersion: s.calcVersion,
    calcSnapshot: s.calcSnapshot,
    requestedBy: s.requestedBy,
    decidedBy: s.decidedBy,
    decidedAt: s.decidedAt,
    decisionNote: s.decisionNote,
    approvedBy: s.approvedBy,
    approvedAt: s.approvedAt,
    processedBy: s.processedBy,
    processedAt: s.processedAt,
    processorRef: s.processorRef,
    postingRef: s.postingRef,
    processingError: s.processingError,
    changeRequests: s.changeRequests.map((c) => ({
      id: c.id,
      category: c.category,
      reason: c.reason,
      assignTeam: c.assignTeam,
      assigneeId: c.assigneeId,
      dueDate: c.dueDate,
      requestedBy: c.requestedBy,
      requestedAt: c.requestedAt,
      response: c.response,
      respondedBy: c.respondedBy,
      respondedAt: c.respondedAt,
      status: c.status,
    })),
    attempts: s.processorAttempts.map(serializeAttempt),
    ledgerLines: s.ledgerEntries.map(serializeLedgerLine),
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export type FinanceSettlement = ReturnType<typeof serializeFinanceSettlement>;

async function loadSettlement(id: string): Promise<SettlementRow> {
  // findFirst (not findUnique): the facility-scope extension narrows reads,
  // so an out-of-scope record reads as not found (repo convention).
  const s = (await prisma.customerSettlement.findFirst({
    where: { id },
    include: FULL_INCLUDE,
  })) as SettlementRow | null;
  if (!s) throw new AppError(404, 'NOT_FOUND', 'Settlement not found');
  return s;
}

/** Track A A7: single-settlement readout for the review drawer and the
 * "Open Finance approval" jump action. Same facility-scope read rule as the
 * lists (out-of-scope reads as not found). */
export async function getFinanceSettlement(id: string): Promise<FinanceSettlement> {
  return serializeFinanceSettlement(await loadSettlement(id));
}

async function nextSettlementRef(tx: Prisma.TransactionClient, prefix: string): Promise<string> {
  const last = await tx.customerSettlement.findFirst({
    where: { ref: { startsWith: `${prefix}-` } },
    orderBy: { ref: 'desc' },
    select: { ref: true },
  });
  const n = last ? Number(last.ref.slice(prefix.length + 1)) + 1 : 1_000_001;
  return `${prefix}-${String(n).padStart(7, '0')}`;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function noteOnTenant(
  tx: Prisma.TransactionClient,
  tenantId: string,
  body: string,
  author: string,
) {
  return tx.recordNote.create({
    data: { entityType: 'tenant', entityId: tenantId, body, author: author.slice(0, 120) },
  });
}

// ---------------------------------------------------------------------------
// Create — manual refund (handoff §10.2–§10.4, D3: lives on CustomerSettlement)
// ---------------------------------------------------------------------------

export interface ManualRefundInput {
  tenantId: string;
  unitId?: string | null;
  /** Positive business amount (handoff §10.3); stored as a signed negative. */
  amount: number;
  reasonCode: string;
  sourceRef?: string | null;
  returnMethod: string;
  notes: string;
  idempotencyKey?: string | null;
}

export async function createManualRefund(
  input: ManualRefundInput,
  actor: string,
): Promise<{ settlement: FinanceSettlement; deduplicated: boolean; message: string }> {
  const cleanActor = actor.slice(0, 120);
  if (!(input.amount > 0)) throw new AppError(400, 'VALIDATION', COPY_AMOUNT);
  if (!input.notes?.trim()) throw new AppError(400, 'VALIDATION', COPY_NOTES);
  if (!(MANUAL_REFUND_REASONS as readonly string[]).includes(input.reasonCode)) {
    throw new AppError(400, 'VALIDATION', 'Choose a refund reason.');
  }
  if (!(RETURN_METHODS as readonly string[]).includes(input.returnMethod)) {
    throw new AppError(400, 'VALIDATION', 'Choose how the refund returns to the customer.');
  }
  if (SOURCE_REQUIRED_REASONS.has(input.reasonCode) && !input.sourceRef?.trim()) {
    throw new AppError(400, 'VALIDATION', COPY_SOURCE);
  }
  // Staff cannot bypass inspection by entering a move-out refund manually
  // (handoff §10.1): move-out rent has no manual reason — enforced by the
  // closed reason enum above.

  const tenant = await prisma.tenant.findFirst({
    where: { id: input.tenantId },
    include: { unit: { select: { id: true, branchId: true } } },
  });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
  const unitId = input.unitId ?? tenant.unitId;
  if (!unitId) throw new AppError(400, 'VALIDATION', 'Choose the rental or account this refund belongs to.');
  const unit = await prisma.unit.findFirst({ where: { id: unitId } });
  if (!unit || unit.deletedAt) throw new AppError(404, 'NOT_FOUND', 'Unit not found');

  const correlationId = newCorrelationId();
  const saved = await prisma.$transaction(async (tx) => {
    if (input.idempotencyKey) {
      const prior = (await tx.customerSettlement.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: FULL_INCLUDE,
      })) as SettlementRow | null;
      if (prior) return { row: prior, deduplicated: true };
    }
    // Same source already in review → the operator is double-entering one
    // billing refund (handoff §10.1 anti-bypass, manual flavour).
    if (input.sourceRef?.trim()) {
      const dup = await tx.customerSettlement.findFirst({
        where: {
          tenantId: tenant.id,
          unitId,
          sourceRef: input.sourceRef.trim(),
          status: { in: [...OPEN_SET_STATUSES] },
        },
        select: { ref: true },
      });
      if (dup) {
        throw new AppError(409, 'CONFLICT', `${dup.ref} already covers this source transaction and is still in review.`);
      }
    }
    const row = (await tx.customerSettlement.create({
      data: {
        ref: await nextSettlementRef(tx, 'RF'),
        kind: 'REFUND',
        docType: 'Refund',
        tenantId: tenant.id,
        unitId,
        effectiveDate: new Date(),
        reason: MANUAL_REFUND_REASON_LABELS[input.reasonCode],
        note: input.notes.trim(),
        sourceRef: input.sourceRef?.trim() || null,
        reasonCode: input.reasonCode,
        returnMethod: input.returnMethod,
        lines: [{ label: MANUAL_REFUND_REASON_LABELS[input.reasonCode], amount: -r2(input.amount) }],
        // Signed canonical: negative = money out to the customer. The API
        // takes the positive business amount (§10.3); the ledger direction
        // comes from the credit column, never a negative display amount.
        amount: -r2(input.amount),
        status: 'PENDING_APPROVAL',
        requestedBy: cleanActor,
        origin: 'MANUAL',
        calcVersion: 1,
        calcSnapshot: {
          manual: true,
          amount: r2(input.amount),
          reasonCode: input.reasonCode,
          sourceRef: input.sourceRef?.trim() || null,
          returnMethod: input.returnMethod,
        },
        idempotencyKey: input.idempotencyKey ?? `manual-${correlationId}`,
      },
      include: FULL_INCLUDE,
    })) as SettlementRow;
    await noteOnTenant(tx, tenant.id, `Refund requested · ${row.ref} · S$${r2(input.amount).toFixed(2)} ${MANUAL_REFUND_REASON_LABELS[input.reasonCode]}`, cleanActor);
    await writeAuditEvent(tx, {
      branchId: unit.branchId,
      actor: cleanActor,
      action: 'settlement.manual_requested',
      entityType: 'CustomerSettlement',
      entityId: row.id,
      after: { ref: row.ref, amount: -r2(input.amount), reasonCode: input.reasonCode, returnMethod: input.returnMethod },
      reason: input.notes.trim().slice(0, 200),
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'refund.calculated',
      payload: { settlementId: row.id, ref: row.ref, manual: true, amount: -r2(input.amount) },
      branchId: unit.branchId,
      correlationId,
    });
    return { row, deduplicated: false };
  });
  return { settlement: serializeFinanceSettlement(saved.row), deduplicated: saved.deduplicated, message: submittedCopy(saved.row.ref) };
}

// ---------------------------------------------------------------------------
// Request changes (handoff §10.6) — PENDING_APPROVAL → CHANGES_REQUESTED
// ---------------------------------------------------------------------------

export interface ChangeRequestInput {
  /** Correction required — mandatory text. */
  note: string;
  category?: string | null;
  assignTeam?: string | null;
  assigneeId?: string | null;
  dueDate?: string | null;
  expectedVersion?: number;
}

export async function requestSettlementChanges(
  id: string,
  input: ChangeRequestInput,
  actor: string,
): Promise<{ settlement: FinanceSettlement }> {
  if (!input.note?.trim()) throw new AppError(400, 'VALIDATION', 'Say what needs to change.');
  const cleanActor = actor.slice(0, 120);
  const s = await loadSettlement(id);
  // A6 wording fix (A4 latent edge): legacy rows are the pre-lifecycle ones
  // with no origin. A NEW lifecycle row that already reached APPROVED must
  // fall through to the state-specific error below — never the legacy copy.
  if (!s.origin && (s.status === 'PENDING' || s.status === 'APPROVED' || s.status === 'REJECTED')) {
    throw new AppError(409, 'CONFLICT', 'This record uses the legacy approval flow.');
  }
  if (s.kind === 'TRANSFER') {
    // A5: transfer change-requests go through the transfer flow (Operations
    // correction workspace + transfer.* events) — never the generic path.
    throw new AppError(409, 'CONFLICT', `${s.ref} is a unit transfer — return it for changes from the transfer flow.`, {
      pointer: `/api/v1/cms/transfers/${id}/changes`,
    });
  }
  if (s.status !== 'PENDING_APPROVAL' && s.status !== 'APPROVED' && s.status !== 'FAILED') {
    throw new AppError(409, 'CONFLICT', `${s.ref} cannot be returned for changes (status ${s.status}).`);
  }
  // A-16: an APPROVED settlement whose processing failed or is blocked (no
  // source card, processor rejection) must be returnable — otherwise it is
  // stuck. Maker-checker still applies: the requester cannot return their
  // own approved request for changes.
  if (s.status === 'APPROVED' && s.requestedBy != null && s.requestedBy === cleanActor) {
    throw new AppError(
      403,
      'MAKER_CHECKER',
      'The requester cannot return their own approved settlement for changes — a different Finance operator is required.',
    );
  }
  assertFreshVersion(s.version, input.expectedVersion, 'settlement');
  let due: Date | null = null;
  if (input.dueDate) {
    due = new Date(`${input.dueDate}T00:00:00.000Z`);
    if (Number.isNaN(due.getTime())) throw new AppError(400, 'VALIDATION', 'Due date must be a valid date.');
  }
  const correlationId = newCorrelationId();
  const category = input.category?.trim() || 'Other';
  const assignTeam = input.assignTeam?.trim() || null;
  const assigneeId = input.assigneeId?.trim() || null;
  const saved = await prisma.$transaction(async (tx) => {
    await tx.customerSettlement.update({
      where: { id, version: s.version },
      data: { status: 'CHANGES_REQUESTED', version: s.version + 1 },
    });
    await tx.settlementChangeRequest.create({
      data: {
        settlementId: id,
        category,
        reason: input.note.trim(),
        assignTeam,
        assigneeId,
        dueDate: due,
        requestedBy: cleanActor,
      },
    });
    await noteOnTenant(tx, s.tenantId, `Settlement returned for changes · ${s.ref} · ${input.note.trim().slice(0, 140)}`, cleanActor);
    // A-21: the Finance change request is also an Operations work item. A
    // chosen assignee is notified through the existing StaffNotification
    // path (their Overview notification queue); a team-only return stays
    // visible in the team queues with no user pinged.
    if (assigneeId) {
      await notifyChangeRequestAssignee(tx, {
        assigneeId,
        title: `Finance change requested · ${s.ref}`,
        body: `${s.tenant.name} · ${category}${due ? ` · due ${due.toISOString().slice(0, 10)}` : ''} · ${input.note.trim()}`,
        entityType: 'tenant',
        entityId: s.tenantId,
        actor: cleanActor,
      });
    }
    await writeAuditEvent(tx, {
      branchId: branchIdOf(s),
      actor: cleanActor,
      action: 'settlement.changes_requested',
      entityType: 'CustomerSettlement',
      entityId: id,
      before: { status: s.status, version: s.version },
      after: { status: 'CHANGES_REQUESTED', version: s.version + 1, category: input.category?.trim() || 'Other' },
      reason: input.note.trim().slice(0, 200),
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'refund.changes_requested',
      payload: { settlementId: id, ref: s.ref, requestedBy: cleanActor },
      branchId: branchIdOf(s),
      correlationId,
    });
    return tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE });
  });
  return { settlement: serializeFinanceSettlement(saved as SettlementRow) };
}

// ---------------------------------------------------------------------------
// Cancel (A-16) — PENDING_APPROVAL | CHANGES_REQUESTED | APPROVED | FAILED →
// CANCELLED with a mandatory reason. Gives a blocked APPROVED settlement
// (e.g. ORIGINAL-method with no source card) a terminal exit when the
// return method cannot be fixed. No money moves: PROCESSING (an async
// provider instruction may be in flight) and terminal records can never
// cancel here. Maker-checker: the requester cannot cancel their own record
// unless they are the Owner (reason already mandatory, audited).
// ---------------------------------------------------------------------------

export interface CancelSettlementInput {
  reason: string;
  expectedVersion?: number;
}

export async function cancelSettlement(
  id: string,
  input: CancelSettlementInput,
  actor: string,
  isOwner: boolean,
): Promise<{ settlement: FinanceSettlement }> {
  if (!input.reason?.trim()) throw new AppError(400, 'VALIDATION', 'A reason is required to cancel this settlement.');
  const cleanActor = actor.slice(0, 120);
  const s = await loadSettlement(id);
  if (!s.origin && (s.status === 'PENDING' || s.status === 'APPROVED' || s.status === 'REJECTED')) {
    throw new AppError(409, 'CONFLICT', 'This record uses the legacy approval flow.');
  }
  if (s.kind === 'TRANSFER') {
    throw new AppError(409, 'CONFLICT', `${s.ref} is a unit transfer — it cannot be cancelled here.`, {
      pointer: `/api/v1/cms/transfers/${id}`,
    });
  }
  if (s.status !== 'PENDING_APPROVAL' && s.status !== 'CHANGES_REQUESTED' && s.status !== 'APPROVED' && s.status !== 'FAILED') {
    throw new AppError(409, 'CONFLICT', `${s.ref} cannot be cancelled (status ${s.status}).`);
  }
  if (s.requestedBy != null && s.requestedBy === cleanActor && !isOwner) {
    throw new AppError(
      403,
      'MAKER_CHECKER',
      'The requester cannot cancel their own settlement — a different Finance operator is required.',
    );
  }
  assertFreshVersion(s.version, input.expectedVersion, 'settlement');
  const correlationId = newCorrelationId();
  const saved = await prisma.$transaction(async (tx) => {
    await tx.customerSettlement.update({
      where: { id, version: s.version },
      data: { status: 'CANCELLED', decisionNote: input.reason.trim().slice(0, 500), version: s.version + 1 },
    });
    await noteOnTenant(tx, s.tenantId, `Settlement cancelled · ${s.ref} · ${input.reason.trim().slice(0, 140)}`, cleanActor);
    await writeAuditEvent(tx, {
      branchId: branchIdOf(s),
      actor: cleanActor,
      action: 'settlement.cancelled',
      entityType: 'CustomerSettlement',
      entityId: id,
      before: { status: s.status, version: s.version },
      after: { status: 'CANCELLED', version: s.version + 1 },
      reason: input.reason.trim().slice(0, 200),
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'refund.rejected',
      payload: { settlementId: id, ref: s.ref, cancelled: true, cancelledBy: cleanActor },
      branchId: branchIdOf(s),
      correlationId,
    });
    return tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE });
  });
  return { settlement: serializeFinanceSettlement(saved as SettlementRow) };
}

// ---------------------------------------------------------------------------
// Correct + resubmit (handoff §10.6, R6) — CHANGES_REQUESTED → PENDING_APPROVAL
// ---------------------------------------------------------------------------

export interface CorrectSettlementInput {
  expectedVersion?: number;
  // MANUAL edits (§10.6 manual list).
  amount?: number;
  sourceRef?: string | null;
  returnMethod?: string;
  reasonCode?: string;
  notes?: string;
  // MOVE_OUT edits (§10.6 move-out list): charge inputs only — rent, dates and
  // policy stay snapshotted (R7/R9). Preview/post share this computation.
  charges?: {
    earlyTermination?: number;
    damage?: number;
    cleaning?: number;
    disposal?: number;
    arrears?: number;
    other?: number;
  };
  specialCredit?: number;
}

export async function correctSettlement(
  id: string,
  input: CorrectSettlementInput,
  actor: string,
): Promise<{ settlement: FinanceSettlement; outcomeChanged: boolean }> {
  const cleanActor = actor.slice(0, 120);
  const s = await loadSettlement(id);
  // A6 wording fix (A4 latent edge): legacy rows are the pre-lifecycle ones
  // with no origin. A NEW lifecycle row that already reached APPROVED must
  // fall through to the state-specific error below — never the legacy copy.
  if (!s.origin && (s.status === 'PENDING' || s.status === 'APPROVED' || s.status === 'REJECTED')) {
    throw new AppError(409, 'CONFLICT', 'This record uses the legacy approval flow.');
  }
  if (s.status !== 'CHANGES_REQUESTED' && s.status !== 'FAILED') {
    throw new AppError(409, 'CONFLICT', `${s.ref} has nothing to correct (status ${s.status}).`);
  }
  assertFreshVersion(s.version, input.expectedVersion, 'settlement');

  let patch: Prisma.CustomerSettlementUpdateInput;
  let outcomeChanged = false;
  let completion: { caseId: string; settlementId: string } | null = null;

  if (s.origin === 'MANUAL' || s.kind === 'REFUND') {
    const amount = input.amount ?? -toNum(s.amount);
    if (!(amount > 0)) throw new AppError(400, 'VALIDATION', COPY_AMOUNT);
    const reasonCode = input.reasonCode ?? s.reasonCode ?? 'other';
    if (!(MANUAL_REFUND_REASONS as readonly string[]).includes(reasonCode)) {
      throw new AppError(400, 'VALIDATION', 'Choose a refund reason.');
    }
    const returnMethod = input.returnMethod ?? s.returnMethod ?? 'ORIGINAL';
    if (!(RETURN_METHODS as readonly string[]).includes(returnMethod)) {
      throw new AppError(400, 'VALIDATION', 'Choose how the refund returns to the customer.');
    }
    const sourceRef = input.sourceRef !== undefined ? (input.sourceRef?.trim() || null) : s.sourceRef;
    if (SOURCE_REQUIRED_REASONS.has(reasonCode) && !sourceRef) {
      throw new AppError(400, 'VALIDATION', COPY_SOURCE);
    }
    const notes = (input.notes ?? s.note ?? '').trim();
    if (!notes) throw new AppError(400, 'VALIDATION', COPY_NOTES);
    patch = {
      amount: -r2(amount),
      reasonCode,
      reason: MANUAL_REFUND_REASON_LABELS[reasonCode],
      returnMethod,
      sourceRef,
      note: notes,
      lines: [{ label: MANUAL_REFUND_REASON_LABELS[reasonCode], amount: -r2(amount) }],
      calcVersion: s.calcVersion + 1,
      calcSnapshot: {
        manual: true,
        amount: r2(amount),
        reasonCode,
        sourceRef,
        returnMethod,
      },
      status: 'PENDING_APPROVAL',
      processingError: null,
      version: s.version + 1,
    };
  } else if (s.origin === 'MOVE_OUT' || s.kind === 'MOVE_OUT') {
    // Recalculate the SAME record from the stored snapshot inputs (R7) with
    // the corrected charge inputs — never a client total (R6).
    const snap = (s.calcSnapshot ?? {}) as Record<string, unknown>;
    const inputs = (snap.inputs ?? {}) as Record<string, unknown>;
    const snapCharges = (inputs.charges ?? {}) as Record<string, number>;
    const nonNeg = (v: number | undefined, label: string, fallback: number): number => {
      const n = v ?? fallback;
      if (!Number.isFinite(n) || n < 0) throw new AppError(400, 'VALIDATION', `${label} cannot be negative.`);
      return n;
    };
    const ch = input.charges ?? {};
    const charges = {
      earlyTermination: nonNeg(ch.earlyTermination, 'Early-termination charge', Number(snapCharges.earlyTermination ?? 0)),
      damage: nonNeg(ch.damage, 'Damage charge', Number(snapCharges.damageCharge ?? 0)),
      cleaning: nonNeg(ch.cleaning, 'Cleaning charge', Number(snapCharges.cleaningCharge ?? 0)),
      disposal: nonNeg(ch.disposal, 'Disposal charge', Number(snapCharges.disposalCharge ?? 0)),
      arrears: nonNeg(ch.arrears, 'Outstanding balance', Number(snapCharges.arrears ?? snapCharges.arrearsAmount ?? 0)),
      other: nonNeg(ch.other, 'Other charge', Number(snapCharges.other ?? snapCharges.otherCharge ?? 0)),
    };
    const specialCredit = nonNeg(input.specialCredit, 'Approved special credit', Number(inputs.specialCredit ?? 0));
    const calc = calculateMoveOutSettlement({
      finalAccessDate: s.effectiveDate,
      netMonthlyRent: Number(inputs.netMonthlyRent ?? 0),
      depositHeld: Number(inputs.depositHeld ?? 0),
      noticeCompliant: (inputs.noticeCompliant as boolean) ?? true,
      shortNoticeForfeitsDeposit: true,
      protectionPaid: Number((snap as Record<string, unknown>).protectionPaid ?? 0),
      charges,
      specialCredit,
    });
    const isRefund = calc.outcome === 'REFUND';
    const docType = calc.outcome === 'ZERO' ? 'Zero settlement' : isRefund ? 'Refund' : 'Charge';
    const beforeRef = s.ref;
    const afterRef =
      calc.outcome === 'ZERO' ? beforeRef : prefixForDocType(docType) === beforeRef.slice(0, 2) ? beforeRef : null;
    patch = {
      // R6: the outcome may flip refund ↔ charge — the record id stays, the
      // display prefix follows the outcome, the old ref is kept in the audit.
      docType,
      lines: calc.lines as unknown as Prisma.InputJsonValue,
      amount: calc.total,
      calcVersion: s.calcVersion + 1,
      calcSnapshot: {
        ...(snap as Record<string, unknown>),
        calcVersion: MOVEOUT_CALC_VERSION,
        calc,
        correctedCharges: charges,
        correctedSpecialCredit: specialCredit,
        correctedAt: new Date().toISOString(),
      } as unknown as Prisma.InputJsonValue,
      status: calc.outcome === 'ZERO' ? 'CANCELLED' : 'PENDING_APPROVAL',
      processingError: null,
      version: s.version + 1,
    };
    if (input.notes?.trim()) patch.note = input.notes.trim();
    if (afterRef === null) {
      // Flip needs a fresh display ref; assigned inside the tx below.
      outcomeChanged = true;
    }
    if (calc.outcome === 'ZERO' && s.moveOutCaseId) {
      completion = { caseId: s.moveOutCaseId, settlementId: id };
    }
  } else {
    // TRANSFER postings belong to A5; TRANSFER rows never reach correct().
    throw new AppError(409, 'CONFLICT', `${s.ref} cannot be corrected here (kind ${s.kind}).`);
  }

  const correlationId = newCorrelationId();
  const saved = await prisma.$transaction(async (tx) => {
    if (outcomeChanged) {
      patch.ref = await nextSettlementRef(tx, prefixForDocType(String(patch.docType)));
    }
    const updated = (await tx.customerSettlement.update({
      where: { id, version: s.version },
      data: patch,
      include: FULL_INCLUDE,
    })) as SettlementRow;
    await tx.settlementChangeRequest.updateMany({
      where: { settlementId: id, status: 'OPEN' },
      data: {
        status: 'ADDRESSED',
        response: (input.notes ?? 'Corrected and resubmitted.').slice(0, 500),
        respondedBy: cleanActor,
        respondedAt: new Date(),
      },
    });
    if (completion) {
      await completeMoveOutCase(tx, completion.caseId, completion.settlementId, cleanActor, correlationId, 'Zero after correction — rental completed and marked Former (§10.6).');
    }
    const fresh = (await tx.customerSettlement.findUnique({
      where: { id },
      include: FULL_INCLUDE,
    })) as SettlementRow;
    await noteOnTenant(tx, s.tenantId, `Settlement corrected · ${updated.ref} · returned to Finance approval`, cleanActor);
    await writeAuditEvent(tx, {
      branchId: branchIdOf(s),
      actor: cleanActor,
      action: 'settlement.corrected',
      entityType: 'CustomerSettlement',
      entityId: id,
      // R6: the previous snapshot is preserved in the audit trail.
      before: { status: s.status, ref: s.ref, amount: toNum(s.amount), calcVersion: s.calcVersion, calcSnapshot: s.calcSnapshot },
      after: { status: updated.status, ref: updated.ref, amount: toNum(updated.amount), calcVersion: updated.calcVersion },
      reason: (input.notes ?? 'Corrected and resubmitted.').slice(0, 200),
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: s.origin === 'MOVE_OUT' ? 'move_out.settlement_submitted' : 'refund.calculated',
      payload: { settlementId: id, ref: updated.ref, corrected: true, outcomeChanged },
      branchId: branchIdOf(s),
      correlationId,
    });
    return fresh;
  });
  return { settlement: serializeFinanceSettlement(saved), outcomeChanged };
}

// ---------------------------------------------------------------------------
// Approve (handoff §10.7) — PENDING_APPROVAL → APPROVED
// ---------------------------------------------------------------------------

export interface DecideOpts {
  actor: string;
  isOwner: boolean;
  expectedVersion?: number;
  reason?: string;
}

export function checkProcessorSeparation(
  requestedBy: string | null,
  approvedBy: string | null,
  actor: string,
  isOwner: boolean,
  reason: string | undefined,
  verb: 'approve' | 'process',
): { bypassed: boolean } {
  const selfDealing = actor === requestedBy || (approvedBy != null && actor === approvedBy);
  if (!selfDealing) return { bypassed: false };
  // D5: no self-approval — Owner single-step bypass only, with a mandatory
  // reason, audited (refund precedent: credits.ts checkChecker).
  if (isOwner && reason?.trim()) return { bypassed: true };
  if (isOwner) {
    throw new AppError(400, 'VALIDATION', 'A reason is required for an Owner single-step (it is written to the audit trail).');
  }
  throw new AppError(
    403,
    'MAKER_CHECKER',
    verb === 'approve'
      ? 'The requestor cannot approve their own settlement — a different approver is required.'
      : 'Processing requires an operator who neither requested nor approved this record — a different Finance operator is required.',
  );
}

export async function approveSettlement(
  id: string,
  opts: DecideOpts,
): Promise<{ settlement: FinanceSettlement; message: string; bypassed: boolean }> {
  const cleanActor = opts.actor.slice(0, 120);
  const s = await loadSettlement(id);
  // A6 wording fix (A4 latent edge): legacy rows are the pre-lifecycle ones
  // with no origin. A NEW lifecycle row that already reached APPROVED must
  // fall through to the state-specific error below — never the legacy copy.
  if (!s.origin && (s.status === 'PENDING' || s.status === 'APPROVED' || s.status === 'REJECTED')) {
    throw new AppError(409, 'CONFLICT', 'This record uses the legacy approval flow.');
  }
  if (s.kind === 'TRANSFER') {
    // A5: transfers approve through the transfer flow (maker-checker +
    // transfer.* events) — never the generic settlement approve.
    throw new AppError(409, 'CONFLICT', `${s.ref} is a unit transfer — approve it from the transfer flow.`, {
      pointer: `/api/v1/cms/transfers/${id}/approve`,
    });
  }
  if (s.status !== 'PENDING_APPROVAL') {
    throw new AppError(409, 'CONFLICT', `Only settlements awaiting approval can be approved (this one is ${s.status}).`);
  }
  assertFreshVersion(s.version, opts.expectedVersion, 'settlement');
  const { bypassed } = checkProcessorSeparation(s.requestedBy, null, cleanActor, opts.isOwner, opts.reason, 'approve');
  // Handoff §14: ADMIN_ONLY restricts approval to the Owner.
  const policy = await getBusinessRule('moveout.approvalRole');
  if (policy.value === 'ADMIN_ONLY' && !opts.isOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Settlement approval is restricted to the Owner (Move-outs & refunds policy).');
  }
  const correlationId = newCorrelationId();
  const saved = await prisma.$transaction(async (tx) => {
    const updated = (await tx.customerSettlement.update({
      where: { id, version: s.version },
      data: {
        status: 'APPROVED',
        approvedBy: cleanActor,
        approvedAt: new Date(),
        decidedBy: cleanActor,
        decidedAt: new Date(),
        decisionNote: opts.reason?.trim() || null,
        version: s.version + 1,
      },
      include: FULL_INCLUDE,
    })) as SettlementRow;
    await noteOnTenant(tx, s.tenantId, `Settlement approved · ${s.ref} · ${APPROVED_COPY}`, cleanActor);
    await writeAuditEvent(tx, {
      branchId: branchIdOf(s),
      actor: cleanActor,
      action: 'settlement.approved',
      entityType: 'CustomerSettlement',
      entityId: id,
      before: { status: 'PENDING_APPROVAL', version: s.version },
      after: { status: 'APPROVED', version: s.version + 1, bypassed },
      reason: opts.reason?.trim() || undefined,
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'refund.approved',
      payload: { settlementId: id, ref: s.ref, approvedBy: cleanActor, bypassed },
      branchId: branchIdOf(s),
      correlationId,
    });
    return updated;
  });
  return { settlement: serializeFinanceSettlement(saved), message: `${s.ref}: ${APPROVED_COPY}`, bypassed };
}

// ---------------------------------------------------------------------------
// Ledger posting — the SINGLE writer of settlement ledger lines (refunds end
// to end: process, webhook reconcile and 5xx compensation all call this; no
// duplicate logic). Corrections post reversal/correcting entries, never
// overwrites (handoff §13 append-only).
// ---------------------------------------------------------------------------

export interface PostingInput {
  processorRef: string;
  postedAt?: Date;
  invoiceId?: string | null;
}

/** Expected (live) lines for a settlement: refund → credit, charge → debit. */
function expectedLines(s: { amount: unknown; docType: string; reasonCode: string | null; reason: string | null; origin: string | null }): ExpectedLedgerLine[] {
  const abs = Math.abs(toNum(s.amount as number));
  const category = ledgerCategory({ origin: s.origin, reasonCode: s.reasonCode, reason: s.reason });
  return s.docType === 'Charge'
    ? [{ entryType: 'CHARGE', label: `Additional charge · ${category}`, debit: abs, credit: null as number | null, status: 'Posted' }]
    : [{ entryType: 'REFUND', label: `Refund · ${category}`, debit: null as number | null, credit: abs, status: 'Refunded' }];
}

type LedgerDb = Pick<Prisma.TransactionClient, 'customerLedgerEntry' | 'unit'>;

/** One live ledger line the posting writer expects (unitId overrides the
 * settlement's source unit — transfers post debits against the destination). */
export interface ExpectedLedgerLine {
  entryType: string;
  label: string;
  debit: number | null;
  credit: number | null;
  status: string;
  unitId?: string;
}

type LedgerRow = {
  id: string;
  reversalOfId: string | null;
  unitId: string | null;
  entryType: string;
  label: string;
  debit: Prisma.Decimal | number | null;
  credit: Prisma.Decimal | number | null;
};

/** Minimal structural view of a transfer calcSnapshot (built by
 * src/core/lifecycle/transferCalc.ts buildTransferSnapshot). Kept structural
 * so the shared posting writer stays decoupled from the transfer service. */
interface TransferSnapshotLike {
  sourceCredit: number;
  destProratedRent: number;
  sourceDepositCredit: number;
  destDepositRequired: number;
  protectionAdjustment: number;
  exceptionAdjustment: { amount: number; reason: string } | null;
}

const r2line = (n: number) => Math.round(Number(n) * 100) / 100;

/**
 * Expected (live) lines for a posted transfer (handoff §11.13): source
 * credit + destination debit, deposit legs when non-zero, and a Protection
 * Plan line only when a non-zero approved adjustment exists. Credit legs
 * carry the source unit, debit legs the destination unit.
 */
async function transferExpectedLines(
  db: LedgerDb,
  s: { unitId: string; toUnitId?: string | null; calcSnapshot?: unknown },
): Promise<ExpectedLedgerLine[]> {
  const snap = (s.calcSnapshot ?? {}) as Partial<TransferSnapshotLike>;
  const sourceCredit = r2line(Number(snap.sourceCredit ?? 0));
  const destProratedRent = r2line(Number(snap.destProratedRent ?? 0));
  const sourceDepositCredit = r2line(Number(snap.sourceDepositCredit ?? 0));
  const destDepositRequired = r2line(Number(snap.destDepositRequired ?? 0));
  const protectionAdjustment = r2line(Number(snap.protectionAdjustment ?? 0));
  const exc = snap.exceptionAdjustment;
  const excAmount = exc ? r2line(Number(exc.amount ?? 0)) : 0;
  const destId = s.toUnitId ?? s.unitId;
  const dest = await db.unit.findUnique({ where: { id: destId }, select: { unitCode: true, name: true } });
  const destCode = dest?.name ?? dest?.unitCode ?? 'destination';
  const lines: ExpectedLedgerLine[] = [];
  if (sourceCredit > 0) {
    lines.push({
      entryType: 'TRANSFER_CREDIT',
      label: `Unit closed · moved out (transferred to ${destCode})`,
      debit: null,
      credit: sourceCredit,
      status: 'Transferred',
      unitId: s.unitId,
    });
  }
  if (destProratedRent > 0) {
    lines.push({
      entryType: 'TRANSFER_DEBIT',
      label: 'Destination unit opened · prorated rent',
      debit: destProratedRent,
      credit: null,
      status: 'Active',
      unitId: destId,
    });
  }
  if (sourceDepositCredit > 0) {
    lines.push({
      entryType: 'TRANSFER_CREDIT',
      label: 'Source deposit transfer credit',
      debit: null,
      credit: sourceDepositCredit,
      status: 'Transferred',
      unitId: s.unitId,
    });
  }
  if (destDepositRequired > 0) {
    lines.push({
      entryType: 'TRANSFER_DEBIT',
      label: 'Destination deposit',
      debit: destDepositRequired,
      credit: null,
      status: 'Active',
      unitId: destId,
    });
  }
  if (protectionAdjustment !== 0) {
    lines.push(
      protectionAdjustment > 0
        ? {
            entryType: 'TRANSFER_DEBIT',
            label: 'Protection Plan adjustment',
            debit: protectionAdjustment,
            credit: null,
            status: 'Active',
            unitId: destId,
          }
        : {
            entryType: 'TRANSFER_CREDIT',
            label: 'Protection Plan adjustment',
            debit: null,
            credit: -protectionAdjustment,
            status: 'Transferred',
            unitId: s.unitId,
          },
    );
  }
  if (exc && excAmount !== 0 && exc.reason?.trim()) {
    const reason = exc.reason.trim().slice(0, 120);
    lines.push(
      excAmount > 0
        ? {
            entryType: 'TRANSFER_DEBIT',
            label: `Exception adjustment · ${reason}`,
            debit: excAmount,
            credit: null,
            status: 'Active',
            unitId: destId,
          }
        : {
            entryType: 'TRANSFER_CREDIT',
            label: `Exception adjustment · ${reason}`,
            debit: null,
            credit: -excAmount,
            status: 'Transferred',
            unitId: s.unitId,
          },
    );
  }
  return lines;
}

function liveOriginals(rows: LedgerRow[]) {
  const reversed = new Set(rows.map((r) => r.reversalOfId).filter(Boolean) as string[]);
  return rows.filter((r) => r.reversalOfId == null && !reversed.has(r.id));
}

function sameLines(live: LedgerRow[], expected: ExpectedLedgerLine[]): boolean {
  if (live.length !== expected.length) return false;
  return expected.every((e, i) => live[i]!.entryType === e.entryType && toNum(live[i]!.debit) === (e.debit ?? 0) && toNum(live[i]!.credit) === (e.credit ?? 0));
}

export async function postSettlementLedger(
  db: Prisma.TransactionClient | typeof prisma,
  s: {
    id: string;
    tenantId: string;
    unitId: string;
    amount: unknown;
    docType: string;
    reasonCode: string | null;
    reason: string | null;
    origin: string | null;
    kind?: string | null;
    toUnitId?: string | null;
    calcSnapshot?: unknown;
  },
  input: PostingInput,
  actor: string,
) {
  const tx = db as unknown as LedgerDb & Pick<Prisma.TransactionClient, 'customerSettlement'>;
  const existing = (await tx.customerLedgerEntry.findMany({ where: { settlementId: s.id }, orderBy: { createdAt: 'asc' } })) as unknown as LedgerRow[];
  const live = liveOriginals(existing);
  // Transfers post multi-line carryover entries derived from the stored
  // calcSnapshot (A5); refunds/charges keep the single-line mapping above.
  const isTransfer = (s.kind === 'TRANSFER' || s.docType === 'Transfer approval') && s.calcSnapshot != null;
  const expected = isTransfer ? await transferExpectedLines(tx, s) : expectedLines(s);
  if (sameLines(live, expected)) return { lines: live, deduplicated: true };
  const correlationId = newCorrelationId();
  // Accrual-reversal path: previously posted lines with different amounts are
  // reversed (mirror entries linked via reversalOfId) before fresh lines post
  // — the originals stay immutable, the books net to the new amounts.
  for (const o of live) {
    await tx.customerLedgerEntry.create({
      data: {
        tenantId: s.tenantId,
        unitId: o.unitId ?? s.unitId,
        settlementId: s.id,
        invoiceId: input.invoiceId ?? undefined,
        entryType: o.entryType,
        label: `Reversal — ${o.label}`,
        debit: o.credit != null ? toNum(o.credit) : null,
        credit: o.debit != null ? toNum(o.debit) : null,
        currency: 'SGD',
        status: 'Reversed',
        postedAt: input.postedAt ?? new Date(),
        reversalOfId: o.id,
        processorRef: input.processorRef.slice(0, 200),
        createdBy: actor.slice(0, 120),
      },
    });
  }
  const created = [];
  for (const e of expected) {
    created.push(
      await tx.customerLedgerEntry.create({
        data: {
          tenantId: s.tenantId,
          unitId: e.unitId ?? s.unitId,
          settlementId: s.id,
          invoiceId: input.invoiceId ?? undefined,
          entryType: e.entryType,
          label: e.label,
          debit: e.debit,
          credit: e.credit,
          currency: 'SGD',
          status: e.status,
          postedAt: input.postedAt ?? new Date(),
          processorRef: input.processorRef.slice(0, 200),
          createdBy: actor.slice(0, 120),
        },
      }),
    );
  }
  await writeAuditEvent(tx as unknown as Pick<typeof prisma, 'financeAuditEvent'>, {
    branchId: null,
    actor: actor.slice(0, 120),
    action: 'ledger.posted',
    entityType: 'CustomerSettlement',
    entityId: s.id,
    after: { lines: created.map((c) => ({ entryType: c.entryType, debit: toNum(c.debit), credit: toNum(c.credit) })), reversals: live.length, processorRef: input.processorRef },
    source: 'cms',
    correlationId,
  });
  return { lines: created, deduplicated: false };
}

/** Append-only reversal of a settlement's live ledger lines (no overwrites). */
export async function reverseSettlementLines(
  settlementId: string,
  actor: string,
  reason: string,
) {
  const s = await loadSettlement(settlementId);
  const out = await prisma.$transaction(async (tx) => {
    const existing = (await tx.customerLedgerEntry.findMany({ where: { settlementId }, orderBy: { createdAt: 'asc' } })) as unknown as LedgerRow[];
    const live = liveOriginals(existing);
    if (live.length === 0) return { reversals: [] as unknown[], deduplicated: true };
    const correlationId = newCorrelationId();
    const reversals = [];
    for (const o of live) {
      reversals.push(
        await tx.customerLedgerEntry.create({
          data: {
            tenantId: s.tenantId,
            unitId: o.unitId ?? s.unitId,
            settlementId: s.id,
            entryType: o.entryType,
            label: `Reversal — ${o.label}`,
            debit: o.credit != null ? toNum(o.credit) : null,
            credit: o.debit != null ? toNum(o.debit) : null,
            currency: 'SGD',
            status: 'Reversed',
            reversalOfId: o.id,
            processorRef: (s.processorRef ?? '').slice(0, 200) || null,
            createdBy: actor.slice(0, 120),
          },
        }),
      );
    }
    await writeAuditEvent(tx, {
      branchId: branchIdOf(s),
      actor: actor.slice(0, 120),
      action: 'ledger.reversed',
      entityType: 'CustomerSettlement',
      entityId: s.id,
      before: { liveLines: live.length },
      after: { reversals: reversals.length },
      reason: reason.slice(0, 200),
      source: 'cms',
      correlationId,
    });
    return { reversals, deduplicated: false };
  });
  return out;
}

// ---------------------------------------------------------------------------
// Process — APPROVED → PROCESSING → REFUNDED / POSTED (handoff §10.7).
// Idempotent: the attempt idempotency key replays the first result; a posted
// settlement re-run is a no-op success. Retries share postSettlementLedger().
// ---------------------------------------------------------------------------

export interface ProcessInput {
  expectedVersion?: number;
  idempotencyKey?: string | null;
  /** BANK two-step: confirm the operator-made transfer to post the refund. */
  bankReference?: string | null;
  reason?: string;
}

function attemptKey(settlementId: string, key: string | null | undefined): string {
  return `proc-${settlementId}:${(key ?? 'auto').slice(0, 120)}`;
}

async function resolveSourcePaymentIntent(s: SettlementRow): Promise<string> {
  // Explicit PI wins (operator-linked source transaction).
  if (s.sourceRef?.trim().startsWith('pi_')) return s.sourceRef.trim();
  if (s.sourceRef?.trim()) {
    const inv = await prisma.invoice.findFirst({
      where: { invoiceNo: s.sourceRef.trim(), tenantId: s.tenantId, paymentIntentId: { not: null } },
      select: { paymentIntentId: true },
    });
    if (inv?.paymentIntentId) return inv.paymentIntentId;
  }
  // Otherwise the latest card-paid invoice on this rental.
  const paid = await prisma.invoice.findFirst({
    where: { tenantId: s.tenantId, unitId: s.unitId, paymentIntentId: { not: null } },
    orderBy: { paidAt: 'desc' },
    select: { paymentIntentId: true },
  });
  if (paid?.paymentIntentId) return paid.paymentIntentId;
    throw new AppError(
      409,
      'CONFLICT',
      // A-16: the blocked-processing copy must name the actions actually
      // available on an APPROVED record — Return for changes (to switch the
      // return method) or Cancel with a reason.
      'No source card payment found for this rental — Return for changes to switch to Bank transfer or Account credit, or Cancel this refund with a reason.',
    );
}

async function moveCaseToProcessing(
  tx: Prisma.TransactionClient,
  s: SettlementRow,
): Promise<void> {
  if (!s.moveOutCaseId) return;
  const c = await tx.moveOutCase.findUnique({ where: { id: s.moveOutCaseId } });
  if (!c || c.status !== 'SETTLEMENT_REVIEW') return;
  await tx.moveOutCase.update({
    where: { id: c.id, version: c.version },
    data: { status: s.docType === 'Charge' ? 'CHARGE_PROCESSING' : 'REFUND_PROCESSING', version: c.version + 1 },
  });
}

async function finishPostedSettlement(
  tx: Prisma.TransactionClient,
  s: SettlementRow,
  actor: string,
  correlationId: string,
  outcome: { status: 'REFUNDED' | 'POSTED'; providerRef: string; postingRef: string; invoiceId?: string | null },
): Promise<void> {
  await postSettlementLedger(tx, s, { processorRef: outcome.providerRef, invoiceId: outcome.invoiceId ?? null }, actor);
  await tx.customerSettlement.update({
    where: { id: s.id },
    data: {
      status: outcome.status,
      processedBy: actor,
      processedAt: new Date(),
      processorRef: outcome.providerRef.slice(0, 200),
      postingRef: outcome.postingRef.slice(0, 200),
      processingError: null,
    },
  });
  await tx.processorAttempt.updateMany({
    where: { settlementId: s.id, providerRef: outcome.providerRef },
    data: { status: 'SUCCEEDED', confirmedAt: new Date(), reconciliation: 'RECONCILED' },
  });
  await noteOnTenant(
    tx,
    s.tenantId,
    outcome.status === 'REFUNDED'
      ? `Refund posted · ${s.ref} · ref ${outcome.providerRef}`
      : `Charge posted · ${s.ref} · invoice ${outcome.postingRef}`,
    actor,
  );
  await writeAuditEvent(tx, {
    branchId: branchIdOf(s),
    actor,
    action: outcome.status === 'REFUNDED' ? 'settlement.refunded' : 'settlement.charge_posted',
    entityType: 'CustomerSettlement',
    entityId: s.id,
    before: { status: s.status },
    after: { status: outcome.status, processorRef: outcome.providerRef, postingRef: outcome.postingRef },
    source: 'cms',
    correlationId,
  });
  await publishFinanceEvent(tx, {
    type: outcome.status === 'REFUNDED' ? 'refund.processed' : 'charge.posted',
    payload: { settlementId: s.id, ref: s.ref, processorRef: outcome.providerRef, postingRef: outcome.postingRef },
    branchId: branchIdOf(s),
    correlationId,
  });
  if (s.moveOutCaseId) {
    await completeMoveOutCase(tx, s.moveOutCaseId, s.id, actor, correlationId, `Move-out ${outcome.status === 'REFUNDED' ? 'refund processed' : 'charge posted'} — rental completed.`);
  }
}

async function failAttempt(
  tx: Prisma.TransactionClient,
  s: SettlementRow,
  attemptId: string,
  actor: string,
  correlationId: string,
  outcome: { revertTo: 'APPROVED' | 'PROCESSING'; errorCode: string; errorMessage: string },
): Promise<void> {
  await tx.processorAttempt.update({
    where: { id: attemptId },
    data: { status: 'FAILED', errorCode: outcome.errorCode.slice(0, 120), errorMessage: outcome.errorMessage.slice(0, 500), reconciliation: 'RECONCILED' },
  });
  // Handoff §10.7: a failed processor call leaves the request Approved or
  // Processing — it must never appear as a completed customer credit.
  await tx.customerSettlement.update({
    where: { id: s.id },
    data: { status: outcome.revertTo, processingError: outcome.errorMessage.slice(0, 500) },
  });
  await noteOnTenant(tx, s.tenantId, `Processing failed · ${s.ref} · ${outcome.errorMessage.slice(0, 140)}`, actor);
  await writeAuditEvent(tx, {
    branchId: branchIdOf(s),
    actor,
    action: 'settlement.process_failed',
    entityType: 'CustomerSettlement',
    entityId: s.id,
    before: { status: s.status },
    after: { status: outcome.revertTo, errorCode: outcome.errorCode },
    reason: outcome.errorMessage.slice(0, 200),
    source: 'cms',
    correlationId,
  });
  await publishFinanceEvent(tx, {
    type: 'refund.processed',
    payload: { settlementId: s.id, ref: s.ref, failed: true, errorCode: outcome.errorCode },
    branchId: branchIdOf(s),
    correlationId,
  });
}

/** Non-retryable provider rejections revert to APPROVED (operator must fix
 * the inputs); transport/5xx errors keep PROCESSING so the same function
 * compensates on retry (no duplicate logic). */
function classifyStripeError(e: unknown): { retryable: boolean; code: string; message: string } {
  const err = e as { type?: string; statusCode?: number; code?: string; message?: string };
  const message = err?.message || 'The payment processor rejected the refund.';
  const code = err?.code || err?.type || 'PROCESSOR_ERROR';
  if (err?.type === 'StripeInvalidRequestError' || err?.type === 'StripeCardError') {
    return { retryable: false, code, message };
  }
  if (typeof err?.statusCode === 'number' && err.statusCode < 500) {
    return { retryable: false, code, message };
  }
  return { retryable: true, code, message };
}

export async function processSettlement(
  id: string,
  input: ProcessInput,
  actor: string,
  isOwner: boolean,
): Promise<{ settlement: FinanceSettlement; deduplicated: boolean; message: string }> {
  const cleanActor = actor.slice(0, 120);
  const s = await loadSettlement(id);
  if (s.kind === 'TRANSFER') {
    throw new AppError(409, 'CONFLICT', 'Transfers post through the transfer approval flow.');
  }
  // Re-running a posted settlement is a no-op success.
  if (TERMINAL_STATUSES.includes(s.status)) {
    return { settlement: serializeFinanceSettlement(s), deduplicated: true, message: `${s.ref} is already ${s.status.toLowerCase()}.` };
  }
  if (!['APPROVED', 'PROCESSING', 'FAILED'].includes(s.status)) {
    throw new AppError(409, 'CONFLICT', `${s.ref} must be approved before processing (status ${s.status}).`);
  }
  if (Math.abs(toNum(s.amount)) < 0.005) {
    throw new AppError(409, 'CONFLICT', `${s.ref} has a zero balance — nothing to process.`);
  }
  const { bypassed } = checkProcessorSeparation(s.requestedBy, s.approvedBy, cleanActor, isOwner, input.reason, 'process');
  assertFreshVersion(s.version, input.expectedVersion, 'settlement');

  const attempts = await prisma.processorAttempt.findMany({ where: { settlementId: id }, orderBy: { attemptNo: 'desc' } });
  const key = attemptKey(id, input.idempotencyKey);
  const replay = attempts.find((a) => a.idempotencyKey === key);
  if (replay?.status === 'SUCCEEDED') {
    return { settlement: serializeFinanceSettlement(await loadSettlement(id)), deduplicated: true, message: `${s.ref} is already processed.` };
  }
  const latestPending = attempts.find((a) => a.status === 'PENDING');
  const correlationId = newCorrelationId();
  const isRefund = s.docType !== 'Charge';
  // Async providers (STRIPE webhook-confirmed, BANK two-step): a PENDING
  // attempt means the instruction is already with the provider — retrying
  // must not issue a second provider call. Sync paths (WALLET grant,
  // INVOICE issue) are individually idempotent and always proceed, so a
  // crash between their steps compensates through this same function.
  const awaitingProvider =
    latestPending &&
    (latestPending.provider === 'STRIPE' || latestPending.provider === 'BANK') &&
    s.status === 'PROCESSING';
  const bankConfirming = (s.returnMethod ?? 'ORIGINAL') === 'BANK' && !!input.bankReference?.trim();
  if (awaitingProvider && !bankConfirming) {
    return {
      settlement: serializeFinanceSettlement(await loadSettlement(id)),
      deduplicated: true,
      message: `${s.ref} is already with the processor — awaiting confirmation.`,
    };
  }

  // ── Charges: issue an Invoice (D4 — collectable via saved card). ──
  if (!isRefund) {
    const invoiceKey = `inv-${id}`;
    const started = await prisma.$transaction(async (tx) => {
      const cur = (await tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE })) as SettlementRow;
      if (TERMINAL_STATUSES.includes(cur.status)) return { already: true as const };
      const attempt = await tx.processorAttempt.create({
        data: {
          settlementId: id,
          idempotencyKey: `${key}#${attempts.length + 1}`,
          provider: 'INVOICE',
          attemptNo: attempts.length + 1,
          amount: Math.abs(toNum(s.amount)),
          status: 'PENDING',
        },
      });
      await tx.customerSettlement.update({ where: { id }, data: { status: 'PROCESSING', processingError: null } });
      await moveCaseToProcessing(tx, cur);
      return { already: false as const, attemptId: attempt.id };
    });
    if (started.already) {
      return { settlement: serializeFinanceSettlement(await loadSettlement(id)), deduplicated: true, message: `${s.ref} is already processed.` };
    }
    try {
      // The invoice draft is system-created so the processor's approve/issue
      // always satisfies invoice maker-checker (creator ≠ approver).
      type InvoiceRow = NonNullable<Awaited<ReturnType<typeof prisma.invoice.findUnique>>>;
      let invoice: InvoiceRow | null = await prisma.invoice.findUnique({ where: { idempotencyKey: invoiceKey } });
      if (!invoice) {
        invoice = (await createInvoice({
          tenantId: s.tenantId,
          unitId: s.unitId,
          dueDate: s.effectiveDate.toISOString().slice(0, 10),
          lines: [{ kind: 'ADJUSTMENT', label: `Closing charge · ${s.ref}`, amount: Math.abs(toNum(s.amount)) }],
          idempotencyKey: invoiceKey,
          actor: `settlement:${s.ref}`,
        })).invoice as unknown as InvoiceRow;
      }
      if (invoice.status === 'DRAFT') {
        await approveInvoice(invoice.id, { actor: cleanActor });
      }
      if ((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status === 'APPROVED') {
        await issueInvoice(invoice.id, { actor: cleanActor });
      }
      const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      const finished = await prisma.$transaction(async (tx) => {
        const cur = (await tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE })) as SettlementRow;
        await finishPostedSettlement(tx, cur, cleanActor, correlationId, {
          status: 'POSTED',
          providerRef: issued.invoiceNo,
          postingRef: issued.invoiceNo,
          invoiceId: issued.id,
        });
        if (bypassed) {
          await writeAuditEvent(tx, {
            branchId: branchIdOf(cur),
            actor: cleanActor,
            action: 'settlement.owner_bypass',
            entityType: 'CustomerSettlement',
            entityId: id,
            after: { singleSteppedBy: cleanActor, reason: input.reason?.trim() },
            reason: input.reason?.trim(),
            source: 'cms',
            correlationId,
          });
        }
        return tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE });
      });
      return { settlement: serializeFinanceSettlement(finished as SettlementRow), deduplicated: false, message: `${s.ref} posted as ${(finished as SettlementRow).postingRef}.` };
    } catch (e) {
      await prisma.$transaction((tx) =>
        failAttempt(tx, s, (started as { attemptId: string }).attemptId, cleanActor, correlationId, {
          revertTo: 'APPROVED',
          errorCode: e instanceof AppError ? e.code : 'PROCESS_FAILED',
          errorMessage: e instanceof Error ? e.message : String(e),
        }),
      );
      throw e;
    }
  }

  // ── Refunds by return method (D6 processor mapping). ──
  const method = s.returnMethod ?? 'ORIGINAL';
  const absAmount = Math.abs(toNum(s.amount));

  // BANK two-step: the first call records the instruction (operator makes the
  // transfer in their bank); the confirmation call carries bankReference.
  if (method === 'BANK' && !input.bankReference?.trim()) {
    if (latestPending?.provider === 'BANK') {
      return {
        settlement: serializeFinanceSettlement(await loadSettlement(id)),
        deduplicated: true,
        message: `Bank instruction ${latestPending.providerRef ?? ''} is already recorded for ${s.ref}. Confirm it with its bank reference to post the refund.`,
      };
    }
    const saved = await prisma.$transaction(async (tx) => {
      const attempt = await tx.processorAttempt.create({
        data: {
          settlementId: id,
          idempotencyKey: `${key}#${attempts.length + 1}`,
          provider: 'BANK',
          attemptNo: attempts.length + 1,
          amount: absAmount,
          status: 'PENDING',
        },
      });
      const ref = `BANK-${attempt.id.slice(-8).toUpperCase()}`;
      await tx.processorAttempt.update({ where: { id: attempt.id }, data: { providerRef: ref } });
      await tx.customerSettlement.update({
        where: { id },
        data: { status: 'PROCESSING', processorRef: ref, processingError: null },
      });
      await moveCaseToProcessing(tx, s);
      await noteOnTenant(tx, s.tenantId, `Bank instruction recorded · ${s.ref} · ${ref} · awaiting transfer confirmation`, cleanActor);
      await writeAuditEvent(tx, {
        branchId: branchIdOf(s),
        actor: cleanActor,
        action: 'settlement.process_started',
        entityType: 'CustomerSettlement',
        entityId: id,
        before: { status: s.status },
        after: { status: 'PROCESSING', provider: 'BANK', instruction: ref, bypassed },
        reason: input.reason?.trim() || undefined,
        source: 'cms',
        correlationId,
      });
      return tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE });
    });
    return {
      settlement: serializeFinanceSettlement(saved as SettlementRow),
      deduplicated: false,
      message: `Bank instruction recorded for ${s.ref}. Confirm the transfer with its bank reference to post the refund.`,
    };
  }

  // From here every path completes synchronously except ORIGINAL-Stripe
  // pending refunds, which the provider confirms via webhook (§10.7).
  const started = await prisma.$transaction(async (tx) => {
    const cur = (await tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE })) as SettlementRow;
    if (TERMINAL_STATUSES.includes(cur.status)) return { already: true as const };
    const attempt = await tx.processorAttempt.create({
      data: {
        settlementId: id,
        idempotencyKey: `${key}#${attempts.length + 1}`,
        provider: method === 'WALLET' ? 'WALLET' : method === 'BANK' ? 'BANK' : 'STRIPE',
        attemptNo: attempts.length + 1,
        amount: absAmount,
        status: 'PENDING',
      },
    });
    await tx.customerSettlement.update({ where: { id }, data: { status: 'PROCESSING', processingError: null } });
    await moveCaseToProcessing(tx, cur);
    await writeAuditEvent(tx, {
      branchId: branchIdOf(cur),
      actor: cleanActor,
      action: 'settlement.process_started',
      entityType: 'CustomerSettlement',
      entityId: id,
      before: { status: cur.status },
      after: { status: 'PROCESSING', provider: attempt.provider, bypassed },
      reason: input.reason?.trim() || undefined,
      source: 'cms',
      correlationId,
    });
    return { already: false as const, attemptId: attempt.id, provider: attempt.provider };
  });
  if (started.already) {
    return { settlement: serializeFinanceSettlement(await loadSettlement(id)), deduplicated: true, message: `${s.ref} is already processed.` };
  }
  const { attemptId, provider } = started as { attemptId: string; provider: string };

  try {
    if (provider === 'WALLET') {
      // D6: account credit lands in the CreditWallet (idempotent grant key).
      await grantCredit({
        tenantId: s.tenantId,
        amount: absAmount,
        actor: cleanActor,
        note: `Settlement ${s.ref}`,
        idempotencyKey: `settle-${id}`,
      });
      const walletRef = `WALLET-${attemptId.slice(-8).toUpperCase()}`;
      const finished = await prisma.$transaction(async (tx) => {
        await tx.processorAttempt.update({ where: { id: attemptId }, data: { providerRef: walletRef } });
        const cur = (await tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE })) as SettlementRow;
        await finishPostedSettlement(tx, cur, cleanActor, correlationId, {
          status: 'REFUNDED',
          providerRef: walletRef,
          postingRef: `POST-${s.ref}`,
        });
        return tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE });
      });
      return { settlement: serializeFinanceSettlement(finished as SettlementRow), deduplicated: false, message: `${s.ref} credited to the customer account.` };
    }

    if (provider === 'BANK') {
      // Confirmation call: the operator-made transfer is evidenced by the
      // bank reference (Phase 4 bank-verify rule, D6).
      const bankRef = input.bankReference!.trim().slice(0, 200);
      const finished = await prisma.$transaction(async (tx) => {
        await tx.processorAttempt.update({
          where: { id: attemptId },
          data: { providerRef: bankRef, status: 'SUCCEEDED', confirmedAt: new Date(), reconciliation: 'RECONCILED' },
        });
        const cur = (await tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE })) as SettlementRow;
        await finishPostedSettlement(tx, cur, cleanActor, correlationId, {
          status: 'REFUNDED',
          providerRef: bankRef,
          postingRef: `POST-${s.ref}`,
        });
        return tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE });
      });
      return { settlement: serializeFinanceSettlement(finished as SettlementRow), deduplicated: false, message: `${s.ref} refund posted (bank ${bankRef}).` };
    }

    // ORIGINAL: Stripe refund on the source PaymentIntent (test mode, D6).
    const piId = await resolveSourcePaymentIntent(s);
    const refund = await getStripe().refunds.create(
      {
        payment_intent: piId,
        amount: Math.round(absAmount * 100),
        metadata: { settlementId: s.id, settlementRef: s.ref, kind: s.origin === 'MANUAL' ? 'manual-refund' : 'moveout-refund' },
      },
      { idempotencyKey: `${key}#${attempts.length + 1}` },
    );
    if (refund.status === 'succeeded') {
      // Synchronous provider confirmation — complete in the same call.
      const finished = await prisma.$transaction(async (tx) => {
        await tx.processorAttempt.update({
          where: { id: attemptId },
          data: { providerRef: refund.id, status: 'SUCCEEDED', confirmedAt: new Date(), reconciliation: 'RECONCILED', rawEventRef: null },
        });
        const cur = (await tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE })) as SettlementRow;
        await finishPostedSettlement(tx, cur, cleanActor, correlationId, {
          status: 'REFUNDED',
          providerRef: refund.id,
          postingRef: `POST-${s.ref}`,
        });
        return tx.customerSettlement.findUnique({ where: { id }, include: FULL_INCLUDE });
      });
      return { settlement: serializeFinanceSettlement(finished as SettlementRow), deduplicated: false, message: `${s.ref} refunded (processor ${refund.id}).` };
    }
    // Async confirmation: the refund webhook completes posting (§10.7).
    await prisma.$transaction(async (tx) => {
      await tx.processorAttempt.update({ where: { id: attemptId }, data: { providerRef: refund.id } });
      await tx.customerSettlement.update({ where: { id }, data: { processorRef: refund.id.slice(0, 200) } });
      await noteOnTenant(tx, s.tenantId, `Refund submitted to processor · ${s.ref} · ${refund.id} · awaiting provider confirmation`, cleanActor);
    });
    const pending = await loadSettlement(id);
    return {
      settlement: serializeFinanceSettlement(pending),
      deduplicated: false,
      message: `${s.ref} submitted to the processor. The ledger posts when the provider confirms.`,
    };
  } catch (e) {
    // Never resolve the idempotency replay from a FAILED attempt: the retry
    // mints a fresh attempt row, so one failed call can never double-post.
    const cls = e instanceof AppError && e.code === 'CONFLICT' && /No source card payment/.test(e.message)
      ? { retryable: false, code: 'NO_SOURCE_PAYMENT', message: e.message }
      : e instanceof AppError
        ? { retryable: true, code: e.code, message: e.message }
        : classifyStripeError(e);
    await prisma.$transaction((tx) =>
      failAttempt(tx, s, attemptId, cleanActor, correlationId, {
        revertTo: cls.retryable ? 'PROCESSING' : 'APPROVED',
        errorCode: cls.code,
        errorMessage: cls.message,
      }),
    );
    if (e instanceof AppError) throw e;
    throw new AppError(
      cls.retryable ? 502 : 409,
      cls.retryable ? 'PROCESSOR_OUTAGE' : 'PROCESSOR_REJECTED',
      cls.retryable
        ? `The payment processor is unreachable — ${s.ref} stays processing. Retry shortly.`
        : `${s.ref} was rejected by the processor: ${cls.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Stripe webhook reconcile (D6): refund.created / refund.updated /
// charge.refunded → ProcessorAttempt + settlement + shared ledger posting,
// idempotent per Stripe event id (claimStripeEvent exactly-once guard).
// ---------------------------------------------------------------------------

export interface StripeRefundLike {
  id: string;
  amount: number; // cents
  status: string | null;
  payment_intent?: string | { id: string } | null;
  metadata?: Record<string, string | undefined> | null;
  created?: number;
}

export async function applyStripeRefundEvent(
  refund: StripeRefundLike,
  opts: { eventId: string },
): Promise<{ applied: boolean; deduplicated?: boolean; reason?: string }> {
  // Resolve before claiming: unknown refs are left unclaimed so a later
  // redelivery (after the record exists) can still apply.
  const metaSid = refund.metadata?.settlementId;
  let s: SettlementRow | null = null;
  if (metaSid) {
    s = (await prisma.customerSettlement.findFirst({ where: { id: metaSid }, include: FULL_INCLUDE })) as SettlementRow | null;
  }
  if (!s) {
    const attempt = await prisma.processorAttempt.findFirst({ where: { providerRef: refund.id }, select: { settlementId: true } });
    if (attempt) s = await loadSettlement(attempt.settlementId);
  }
  if (!s) return { applied: false, reason: 'unknown refund reference' };

  const out = await prisma.$transaction(async (tx) => {
    const { claimStripeEvent } = await import('../finance/events');
    const claimed = await claimStripeEvent(tx, opts.eventId, 'refund');
    if (!claimed) return { applied: false, deduplicated: true };
    const cur = (await tx.customerSettlement.findUnique({ where: { id: s!.id }, include: FULL_INCLUDE })) as SettlementRow;
    if (TERMINAL_STATUSES.includes(cur.status)) return { applied: false, deduplicated: true };
    const attempt = await tx.processorAttempt.findFirst({
      where: { settlementId: cur.id },
      orderBy: { attemptNo: 'desc' },
    });
    const correlationId = newCorrelationId();
    const amountMatches = Math.round(Math.abs(toNum(cur.amount)) * 100) === refund.amount;
    if (!amountMatches) {
      if (attempt) {
        await tx.processorAttempt.update({ where: { id: attempt.id }, data: { providerRef: refund.id, reconciliation: 'MISMATCH' } });
      }
      await tx.customerSettlement.update({
        where: { id: cur.id },
        data: { processorRef: refund.id.slice(0, 200), processingError: `Provider amount ${refund.amount}c does not match settlement ${cur.ref}.` },
      });
      await writeAuditEvent(tx, {
        branchId: branchIdOf(cur),
        actor: 'stripe-webhook',
        action: 'settlement.reconcile_mismatch',
        entityType: 'CustomerSettlement',
        entityId: cur.id,
        after: { providerRef: refund.id, providerAmountCents: refund.amount },
        reason: 'Provider amount does not match the settlement — held for operator review, nothing posted.',
        source: 'stripe-webhook',
        correlationId,
      });
      return { applied: true };
    }
    if (refund.status === 'succeeded') {
      if (attempt) {
        await tx.processorAttempt.update({
          where: { id: attempt.id },
          data: { providerRef: refund.id, status: 'SUCCEEDED', confirmedAt: new Date(), reconciliation: 'RECONCILED', rawEventRef: opts.eventId },
        });
      }
      await finishPostedSettlement(tx, cur, 'stripe-webhook', correlationId, {
        status: 'REFUNDED',
        providerRef: refund.id,
        postingRef: `POST-${cur.ref}`,
      });
      // Provider-confirmed timestamp (Singapore reporting timezone on read).
      if (refund.created) {
        await tx.customerLedgerEntry.updateMany({
          where: { settlementId: cur.id, processorRef: refund.id },
          data: { postedAt: new Date(refund.created * 1000) },
        });
      }
      return { applied: true };
    }
    if (refund.status === 'failed' || refund.status === 'canceled') {
      if (attempt) {
        await tx.processorAttempt.update({
          where: { id: attempt.id },
          data: { providerRef: refund.id, status: 'FAILED', errorCode: 'REFUND_FAILED', errorMessage: `Provider reported the refund ${refund.status}.`, reconciliation: 'RECONCILED', rawEventRef: opts.eventId },
        });
      }
      await tx.customerSettlement.update({
        where: { id: cur.id },
        data: { status: 'APPROVED', processorRef: refund.id.slice(0, 200), processingError: `Provider reported the refund ${refund.status} — nothing was posted.` },
      });
      await writeAuditEvent(tx, {
        branchId: branchIdOf(cur),
        actor: 'stripe-webhook',
        action: 'settlement.process_failed',
        entityType: 'CustomerSettlement',
        entityId: cur.id,
        before: { status: cur.status },
        after: { status: 'APPROVED' },
        reason: `Provider reported the refund ${refund.status} — nothing was posted.`,
        source: 'stripe-webhook',
        correlationId,
      });
      return { applied: true };
    }
    // Pending/async: record the provider reference, keep waiting.
    if (attempt && !attempt.providerRef) {
      await tx.processorAttempt.update({ where: { id: attempt.id }, data: { providerRef: refund.id, rawEventRef: opts.eventId } });
    }
    return { applied: true };
  });
  return out;
}

export interface FinanceSettlementsQuery extends RefundsRegisterQuery {
  kind?: string;
}

function flattenRow(r: SettlementRow) {
  const full = serializeFinanceSettlement(r);
  const latest = r.processorAttempts[0] ?? null;
  return {
    ...full,
    // Legacy GET /finance/settlements wrapper fields (additive superset).
    customer: r.tenant.name,
    unitCode: r.tenant.unit?.unitCode ?? null,
    unitName: r.tenant.unit?.name ?? r.tenant.unit?.unitCode ?? null,
    facility: r.tenant.unit?.branch?.name ?? null,
    statusLabel: REGISTER_STATUS_LABELS[r.status] ?? r.status,
    pending: PENDING_REGISTER_STATUSES.includes(r.status),
    processor: latest?.provider ?? null,
    providerRef: r.processorRef ?? latest?.providerRef ?? null,
  };
}

/** All-origins settlement list (legacy wrapper fields kept for CMS readers). */
export async function listFinanceSettlements(q: FinanceSettlementsQuery = {}) {
  const and: Prisma.CustomerSettlementWhereInput[] = [];
  if (q.kind) {
    if (!['TRANSFER', 'MOVE_OUT', 'REFUND'].includes(q.kind)) {
      throw new AppError(400, 'VALIDATION', `Unknown settlement kind "${q.kind}".`);
    }
    and.push({ kind: q.kind });
  }
  if (q.status) {
    if (!(SETTLEMENT_STATUSES as readonly string[]).includes(q.status)) {
      throw new AppError(400, 'VALIDATION', `Unknown settlement status "${q.status}".`);
    }
    and.push({ status: q.status });
  }
  if (q.from) and.push({ createdAt: { gte: new Date(`${q.from}T00:00:00.000Z`) } });
  if (q.to) and.push({ createdAt: { lte: new Date(`${q.to}T23:59:59.999Z`) } });
  if (q.branchId) and.push({ tenant: { unit: { branchId: q.branchId } } });
  if (q.facility) and.push({ tenant: { unit: { branch: { code: q.facility } } } });
  if (q.processor) {
    const p = q.processor.trim().toUpperCase();
    if (!['STRIPE', 'BANK', 'WALLET', 'INVOICE'].includes(p)) {
      throw new AppError(400, 'VALIDATION', `Unknown processor "${q.processor}".`);
    }
    and.push({ processorAttempts: { some: { provider: p } } });
  }
  if (q.search?.trim()) {
    const term = q.search.trim();
    and.push({
      OR: [
        { ref: { contains: term, mode: 'insensitive' } },
        { tenant: { name: { contains: term, mode: 'insensitive' } } },
        { tenant: { email: { contains: term, mode: 'insensitive' } } },
        { tenant: { unit: { unitCode: { contains: term, mode: 'insensitive' } } } },
      ],
    });
  }
  const rows = (await prisma.customerSettlement.findMany({
    where: and.length ? { AND: and } : undefined,
    include: FULL_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 500,
  })) as SettlementRow[];
  return rows.map(flattenRow);
}

// ---------------------------------------------------------------------------
// Refunds register (handoff §12 — the ONE Finance approval/processing
// register; no second refunds register): list/filter by status, date range,
// facility and processor.
// ---------------------------------------------------------------------------

export interface RefundsRegisterQuery {
  status?: string;
  from?: string;
  to?: string;
  /** Branch code (matches the Finance register `facility` filter). */
  facility?: string;
  branchId?: string;
  /** Processor provider: STRIPE | BANK | WALLET | INVOICE. */
  processor?: string;
  search?: string;
}

const REGISTER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending approval',
  PENDING_APPROVAL: 'Pending approval',
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Approved',
  PROCESSING: 'Processing',
  REFUNDED: 'Refunded',
  POSTED: 'Posted',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  REJECTED: 'Rejected',
};

const PENDING_REGISTER_STATUSES = ['PENDING', 'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED', 'PROCESSING'];

export async function listRefundsRegister(q: RefundsRegisterQuery = {}) {
  const and: Prisma.CustomerSettlementWhereInput[] = [{ kind: { in: ['REFUND', 'MOVE_OUT'] } }];
  if (q.status) {
    if (!(SETTLEMENT_STATUSES as readonly string[]).includes(q.status)) {
      throw new AppError(400, 'VALIDATION', `Unknown settlement status "${q.status}".`);
    }
    and.push({ status: q.status });
  }
  if (q.from) and.push({ createdAt: { gte: new Date(`${q.from}T00:00:00.000Z`) } });
  if (q.to) and.push({ createdAt: { lte: new Date(`${q.to}T23:59:59.999Z`) } });
  if (q.branchId) and.push({ tenant: { unit: { branchId: q.branchId } } });
  if (q.facility) and.push({ tenant: { unit: { branch: { code: q.facility } } } });
  if (q.processor) {
    const p = q.processor.trim().toUpperCase();
    if (!['STRIPE', 'BANK', 'WALLET', 'INVOICE'].includes(p)) {
      throw new AppError(400, 'VALIDATION', `Unknown processor "${q.processor}".`);
    }
    and.push({ processorAttempts: { some: { provider: p } } });
  }
  if (q.search?.trim()) {
    const term = q.search.trim();
    and.push({
      OR: [
        { ref: { contains: term, mode: 'insensitive' } },
        { tenant: { name: { contains: term, mode: 'insensitive' } } },
        { tenant: { email: { contains: term, mode: 'insensitive' } } },
        { tenant: { unit: { unitCode: { contains: term, mode: 'insensitive' } } } },
        { sourceRef: { contains: term, mode: 'insensitive' } },
      ],
    });
  }
  const rows = (await prisma.customerSettlement.findMany({
    where: { AND: and },
    include: FULL_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 500,
  })) as SettlementRow[];
  const data = rows.map(flattenRow);
  return {
    rows: data,
    summary: {
      total: data.length,
      pending: data.filter((r) => r.pending).length,
      failed: data.filter((r) => r.status === 'FAILED').length,
      refunded: data.filter((r) => r.status === 'REFUNDED').length,
    },
    empty: data.length === 0 ? NO_REFUNDS_COPY : null,
  };
}

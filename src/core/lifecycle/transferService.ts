// Unit-transfer service (Track A, phase A5).
//
// End-to-end transfer flow over CustomerSettlement (kind TRANSFER,
// docType 'Transfer approval', origin 'TRANSFER'):
//   request → approve (maker-checker, D5, no self-approval) → execute
//   (atomic posting) → POSTED (completed).
// Finance change-requests return a transfer to CHANGES_REQUESTED; Operations
// corrects and resubmits to PENDING_APPROVAL. A failed destination
// revalidation at execute time returns the transfer to CHANGES_REQUESTED
// (R10/D8: no hold, revalidate at posting, 409 → CHANGES_REQUESTED).
//
// Rules (handoff §11 wins on rules):
// - Destination MUST be AVAILABLE-only at request, correction, manual
//   replace and inside the execute transaction (D9).
// - Manual destination replacement is Owner-only (D9).
// - Preview and execute share one computation: execute recomputes the
//   snapshot from live DB inputs and refuses to post on drift (409).
// - Ledger lines post through the A4 shared writer postSettlementLedger()
//   (no duplicate posting logic); transfers never create invoices — the net
//   adjustment lives in the ledger and the billing guard
//   (transferBillingExemption in finance/billing.ts) keeps the transfer
//   month single-charged.
// - Money: integer cents in the engine, Decimal(10,2) in the DB, toNum out.
// - Every mutation is version-guarded (409 STALE), audit-logged and
//   publishes a transfer.* finance event in the same transaction.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { toNum } from '../../lib/format';
import { writeAuditEvent } from '../finance/audit';
import { publishFinanceEvent } from '../finance/events';
import { assertFreshVersion, newCorrelationId } from '../finance/idempotency';
import { notifyChangeRequestAssignee } from '../recordNotes';
import { getBusinessRule } from '../businessRules';
import { rentChargedOn } from '../finance/billing';
import { parseSgDate, sgCalendarDate, toYmd, ADJUSTMENT_CATEGORIES } from './moveOutCalc';
import {
  TRANSFER_CALC_VERSION,
  assertNoOpenTransfer,
  buildTransferSnapshot,
  type TransferSnapshot,
} from './transferCalc';
import { resolveDestinationPromo } from './transferPromo';
import {
  FULL_INCLUDE,
  checkProcessorSeparation,
  postSettlementLedger,
  serializeFinanceSettlement,
  type FinanceSettlement,
  type SettlementRow,
} from './settleFinance';

// ---------------------------------------------------------------------------
// Constants (handoff copy — verbatim where quoted)
// ---------------------------------------------------------------------------

/** Open transfer approvals for one source rental (handoff §11.3). */
const OPEN_TRANSFER_STATUSES = ['PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED', 'PROCESSING'];

/** Statuses a manual destination replace may touch (D9 Owner-only path). */
const REPLACEABLE_STATUSES = ['PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED'];

/** Handoff §11.9 Finance issue categories for transfer change-requests. */
export const TRANSFER_CHANGE_CATEGORIES = [
  'Unit or transfer date',
  'Pricing or promotion',
  'Proration calculation',
  'Security deposit',
  'Protection Plan',
  'Customer authorisation',
  'Other',
] as const;

/** Handoff §12 register empty-state copy, transfer flavour. */
export const NO_TRANSFERS_COPY = 'No transfers match these filters.';

// Handoff §11.7 submission concept ("source remains active until approval").
const submittedCopy = (ref: string) =>
  `${ref} submitted for approval. Source unit, access and billing stay unchanged until Finance posts the transfer.`;
// Handoff §10.7 approved concept, transfer flavour.
const APPROVED_COPY = 'Approved; awaiting transfer execution.';
// Handoff §11.9 processor/posting returned state.
const RETURNED_COPY = 'Returned to Operations';

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function loadTransfer(id: string): Promise<SettlementRow> {
  // findFirst (not findUnique): the facility-scope extension narrows reads,
  // so an out-of-scope record reads as not found (repo convention).
  const s = (await prisma.customerSettlement.findFirst({
    where: { id },
    include: FULL_INCLUDE,
  })) as SettlementRow | null;
  if (!s || s.kind !== 'TRANSFER') throw new AppError(404, 'NOT_FOUND', 'Transfer not found');
  return s;
}

function assertNewLifecycle(s: SettlementRow): void {
  // Legacy rows (pre-A4 submitSettlement) share the bare PENDING / APPROVED /
  // REJECTED statuses but carry no origin; new-lifecycle APPROVED transfers
  // always have origin = TRANSFER, so the legacy check must not fire on them.
  const legacyStatus = s.status === 'PENDING' || s.status === 'APPROVED' || s.status === 'REJECTED';
  if (legacyStatus && s.origin == null) {
    throw new AppError(409, 'CONFLICT', 'This record uses the legacy approval flow.');
  }
}

/** Destination unit context for transfer reads (CMS only). */
export interface TransferDestUnit {
  id: string;
  unitCode: string;
  unitName: string;
  branchId: string;
  branchCode: string | null;
  branchName: string | null;
}

export type TransferRow = FinanceSettlement & { sourceUnit: TransferDestUnit | null; destUnit: TransferDestUnit | null };

async function attachDestUnits(rows: SettlementRow[]): Promise<TransferRow[]> {
  // A-24: source + destination units resolve together — timeline rows render
  // the unit-display helper (name ?? unitCode), never the raw unit id.
  const ids = [
    ...new Set(
      [...rows.map((r) => r.toUnitId), ...rows.map((r) => r.unitId)].filter((v): v is string => !!v),
    ),
  ];
  const units = ids.length
    ? await prisma.unit.findMany({
        where: { id: { in: ids } },
        include: { branch: { select: { id: true, code: true, name: true } } },
      })
    : [];
  const map = new Map(
    units.map((u) => [
      u.id,
      {
        id: u.id,
        unitCode: u.unitCode,
        unitName: u.name ?? u.unitCode,
        branchId: u.branchId,
        branchCode: u.branch?.code ?? null,
        branchName: u.branch?.name ?? null,
      } as TransferDestUnit,
    ]),
  );
  return rows.map((r) => ({
    ...serializeFinanceSettlement(r),
    sourceUnit: (r.unitId ? map.get(r.unitId) : undefined) ?? null,
    destUnit: (r.toUnitId ? map.get(r.toUnitId) : undefined) ?? null,
  }));
}

export interface TransferListQuery {
  status?: string;
  branchId?: string;
  search?: string;
}

export async function listTransfers(q: TransferListQuery = {}): Promise<{ rows: TransferRow[]; empty: string | null }> {
  const and: Prisma.CustomerSettlementWhereInput[] = [{ kind: 'TRANSFER' }];
  if (q.status) {
    const known = [...OPEN_TRANSFER_STATUSES, 'POSTED', 'FAILED', 'CANCELLED'];
    if (!known.includes(q.status)) throw new AppError(400, 'VALIDATION', `Unknown transfer status "${q.status}".`);
    and.push({ status: q.status });
  }
  if (q.branchId) {
    and.push({ OR: [{ tenant: { branchId: q.branchId } }, { tenant: { unit: { branchId: q.branchId } } }] });
  }
  if (q.search?.trim()) {
    const t = q.search.trim();
    const ors: Prisma.CustomerSettlementWhereInput[] = [
      { ref: { contains: t, mode: 'insensitive' } },
      { tenant: { name: { contains: t, mode: 'insensitive' } } },
      { tenant: { email: { contains: t, mode: 'insensitive' } } },
    ];
    const units = await prisma.unit.findMany({
      where: { unitCode: { contains: t, mode: 'insensitive' } },
      select: { id: true },
      take: 50,
    });
    if (units.length) {
      ors.push({ unitId: { in: units.map((u) => u.id) } }, { toUnitId: { in: units.map((u) => u.id) } });
    }
    and.push({ OR: ors });
  }
  const rows = (await prisma.customerSettlement.findMany({
    where: { AND: and },
    include: FULL_INCLUDE,
    orderBy: { createdAt: 'desc' },
  })) as SettlementRow[];
  const out = await attachDestUnits(rows);
  return { rows: out, empty: out.length === 0 ? NO_TRANSFERS_COPY : null };
}

export async function getTransfer(id: string): Promise<TransferRow> {
  const s = await loadTransfer(id);
  return (await attachDestUnits([s]))[0]!;
}

// ---------------------------------------------------------------------------
// Shared resolve (preview/request/correct/replace read the same live inputs)
// ---------------------------------------------------------------------------

export interface TransferMutationInput {
  toUnitId?: string;
  effectiveDate?: string;
  /** A-23: accepted but IGNORED — the server recomputes the destination
   *  promotion from the destination unit (destination eligibility wins). */
  destPromoPct?: number;
  destDeposit?: number;
  destProtection?: number;
  sourceDepositHeld?: number;
  reason?: string | null;
  exceptionAdjustment?: {
    type: 'CHARGE' | 'CREDIT';
    category: string;
    amount: number;
    reason: string;
  } | null;
}

interface ResolvedTransfer {
  tenant: { id: string; name: string; monthlyRate: unknown; unitId: string };
  sourceUnitId: string;
  /** A-24: source display name (unit-display helper: name ?? unitCode) for
   *  timeline notes — never the raw unit id. */
  sourceUnitDisplay: string;
  dest: { id: string; unitCode: string; name: string | null; monthlyRate: unknown; sqft: number; branchId: string };
  snapshot: TransferSnapshot;
}

function cleanMoney(v: number | undefined, label: string): number {
  const n = v ?? 0;
  if (!Number.isFinite(n) || n < 0) throw new AppError(400, 'VALIDATION', `${label} cannot be negative.`);
  return n;
}

/**
 * Normalises an exception adjustment from either the mutation shape
 * ({type, category, amount > 0, reason}) or the stored snapshot shape
 * ({amount signed, reason}) into the engine Adjustment. The snapshot only
 * keeps the signed amount + reason, so corrections and execute-recomputes
 * re-derive type/category from it.
 */
function cleanException(
  adj: TransferMutationInput['exceptionAdjustment'] | { amount?: number; reason?: string } | null | undefined,
): { type: 'CHARGE' | 'CREDIT'; category: (typeof ADJUSTMENT_CATEGORIES)[number]; amount: number; reason: string } | null {
  if (!adj) return null;
  const a = adj as { type?: string; category?: string; amount?: number; reason?: string };
  if (a.type === 'CHARGE' || a.type === 'CREDIT') {
    if (!(a.amount != null && a.amount > 0) || !Number.isFinite(a.amount)) {
      throw new AppError(400, 'VALIDATION', 'Exception adjustment amount must be greater than zero.');
    }
    if (!(ADJUSTMENT_CATEGORIES as readonly string[]).includes(a.category ?? '')) {
      throw new AppError(400, 'VALIDATION', 'Choose an exception adjustment category.');
    }
    if (!a.reason?.trim()) throw new AppError(400, 'VALIDATION', 'Add a reason for the exception adjustment.');
    return { type: a.type, category: a.category as (typeof ADJUSTMENT_CATEGORIES)[number], amount: a.amount, reason: a.reason.trim() };
  }
  // Stored snapshot shape: signed amount, reason only.
  const signed = Number(a.amount ?? 0);
  if (!Number.isFinite(signed) || signed === 0) return null;
  if (!a.reason?.trim()) throw new AppError(400, 'VALIDATION', 'Add a reason for the exception adjustment.');
  return {
    type: signed > 0 ? 'CHARGE' : 'CREDIT',
    category: 'Other',
    amount: Math.abs(signed),
    reason: a.reason.trim(),
  };
}

async function resolveTransfer(
  tenantId: string,
  input: TransferMutationInput,
  opts: { stored?: TransferSnapshot | null },
): Promise<ResolvedTransfer> {
  const t = await prisma.tenant.findFirst({
    where: { id: tenantId },
    include: { unit: { select: { id: true, unitCode: true, name: true } } },
  });
  if (!t) throw new AppError(404, 'NOT_FOUND', `Customer ${tenantId} not found`);
  if (!t.unitId || !t.unit) throw new AppError(409, 'CONFLICT', 'This customer has no active unit.');
  // A-23: the source list excludes rentals with an open MoveOutCase (or
  // Pending move-out status). The open-case check runs first so the 409
  // names the case even though the request also flips the rental to NOTICE.
  const openCase = await prisma.moveOutCase.findFirst({
    where: { tenantId: t.id, status: { notIn: ['COMPLETED', 'REVERSED'] } },
    select: { caseNumber: true },
  });
  if (openCase) {
    throw new AppError(
      409,
      'CONFLICT',
      `${openCase.caseNumber} is still open — finish or reverse the move-out before transferring this rental.`,
    );
  }
  if (t.status !== 'ACTIVE') {
    throw new AppError(409, 'CONFLICT', 'Only active rentals can transfer to another unit.');
  }
  const stored = opts.stored ?? null;
  const toUnitId = input.toUnitId ?? stored?.destUnitId ?? null;
  if (!toUnitId) throw new AppError(400, 'VALIDATION', 'Choose a destination unit.');
  const effYmd = input.effectiveDate ?? stored?.effectiveDate ?? null;
  if (!effYmd) throw new AppError(400, 'VALIDATION', 'Choose a valid transfer date.');
  // D9: destination MUST be AVAILABLE-only — enforced on every path that
  // resolves a destination (request, correct, replace, execute re-read).
  const dest = await prisma.unit.findFirst({ where: { id: toUnitId } });
  if (!dest || dest.deletedAt) throw new AppError(404, 'NOT_FOUND', 'Choose a destination unit.');
  if (dest.status !== 'AVAILABLE') {
    throw new AppError(409, 'CONFLICT', `${dest.name ?? dest.unitCode} is not available.`);
  }
  // The destination cannot already be active for any customer (this also
  // covers the same customer holding both units).
  const occupant = await prisma.tenant.findFirst({
    where: { unitId: dest.id, status: 'ACTIVE' },
    select: { id: true },
  });
  if (occupant && occupant.id !== t.id) {
    throw new AppError(409, 'CONFLICT', `${dest.name ?? dest.unitCode} is not available.`);
  }
  const eff = parseSgDate(effYmd);
  const sourceNet = toNum(await rentChargedOn(t.id, t.unitId, eff, toNum(t.monthlyRate)));
  // A-23: destination promotion is derived from the destination unit — the
  // client value (preview/post/correct) is never trusted.
  const derived = await resolveDestinationPromo(dest.id);
  const snapshot = buildTransferSnapshot({
    sourceUnitId: t.unitId,
    destUnitId: dest.id,
    effectiveDate: effYmd,
    sourceNetMonthlyRent: sourceNet,
    sourceDepositHeld: cleanMoney(input.sourceDepositHeld ?? stored?.sourceDepositCredit ?? 0, 'Source deposit held'),
    destRackGrossMonthly: toNum(dest.monthlyRate),
    destPromoPct: derived.promoPct,
    destPromoPlanName: derived.planName,
    destDepositRequired: cleanMoney(input.destDeposit ?? stored?.destDepositRequired ?? 0, 'Destination deposit required'),
    destProtectionMonthly: cleanMoney(
      input.destProtection ?? stored?.destProtectionMonthly ?? 0,
      'Destination Protection Plan',
    ),
    exceptionAdjustment: cleanException(input.exceptionAdjustment ?? stored?.exceptionAdjustment ?? null),
  });
  return {
    tenant: { id: t.id, name: t.name, monthlyRate: t.monthlyRate, unitId: t.unitId },
    sourceUnitId: t.unitId,
    sourceUnitDisplay: t.unit.name ?? t.unit.unitCode,
    dest: {
      id: dest.id,
      unitCode: dest.unitCode,
      name: dest.name,
      monthlyRate: dest.monthlyRate,
      sqft: dest.sqft,
      branchId: dest.branchId,
    },
    snapshot,
  };
}

/** Canonical comparison fields — execute refuses to post when live inputs
 * drifted since approval (preview/execute share the computation). */
function snapshotKey(s: TransferSnapshot): string {
  return JSON.stringify({
    sourceUnitId: s.sourceUnitId,
    destUnitId: s.destUnitId,
    effectiveDate: s.effectiveDate,
    daysInMonth: s.daysInMonth,
    transferDays: s.transferDays,
    sourceNetMonthlyRent: s.sourceNetMonthlyRent,
    destRackGrossMonthly: s.destRackGrossMonthly,
    destPromoPct: s.destPromoPct,
    sourceDepositCredit: s.sourceDepositCredit,
    destDepositRequired: s.destDepositRequired,
    destProtectionMonthly: s.destProtectionMonthly,
    exceptionAdjustment: s.exceptionAdjustment,
    netAdjustment: s.netAdjustment,
  });
}

// ---------------------------------------------------------------------------
// Preview (no writes — same engine + same DB inputs as request/execute)
// ---------------------------------------------------------------------------

export async function previewTransfer(tenantId: string, input: TransferMutationInput) {
  const r = await resolveTransfer(tenantId, input, {});
  return {
    kind: 'TRANSFER' as const,
    docType: 'Transfer approval',
    ...r.snapshot,
    from: { unitId: r.sourceUnitId },
    to: {
      unitId: r.dest.id,
      unitCode: r.dest.unitCode,
      unitName: r.dest.name ?? r.dest.unitCode,
      branchId: r.dest.branchId,
    },
  };
}

// ---------------------------------------------------------------------------
// Request (Operations/Customer Service submit to Finance)
// ---------------------------------------------------------------------------

export interface RequestTransferInput extends TransferMutationInput {
  toUnitId: string;
  effectiveDate: string;
  idempotencyKey?: string | null;
}

async function nextTransferRef(tx: Prisma.TransactionClient): Promise<string> {
  const last = await tx.customerSettlement.findFirst({
    where: { ref: { startsWith: 'TRF-' } },
    orderBy: { ref: 'desc' },
    select: { ref: true },
  });
  const n = last ? Number(last.ref.slice(4)) + 1 : 1_000_001;
  return `TRF-${String(n).padStart(7, '0')}`;
}

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

/** Facility for audit scoping (billing F-3 rule, same as settlements). */
function branchIdOf(s: { tenant: { branchId: string | null; unit: { branchId: string } | null } }): string | null {
  return s.tenant.unit?.branchId ?? s.tenant.branchId ?? null;
}

export async function requestTransfer(
  tenantId: string,
  input: RequestTransferInput,
  actor: string,
): Promise<{ settlement: TransferRow; deduplicated: boolean; message: string }> {
  const cleanActor = actor.slice(0, 120);
  // Resolve without the open-transfer guard first: an identical retry must
  // replay idempotently (deduplicated) instead of 409ing against itself.
  const r = await resolveTransfer(tenantId, input, {});
  // Tenant-scoped deterministic key: the engine key alone omits the tenant,
  // so two customers moving between the same units on the same day with the
  // same amounts must not alias each other.
  const key = input.idempotencyKey?.trim() || `${r.tenant.id}:${r.snapshot.idempotencyKey}`;
  const replay = (await prisma.customerSettlement.findUnique({
    where: { idempotencyKey: key },
    include: FULL_INCLUDE,
  })) as SettlementRow | null;
  if (replay) {
    if (replay.kind !== 'TRANSFER') {
      throw new AppError(409, 'CONFLICT', 'This request duplicates an existing record.');
    }
    const settlement = (await attachDestUnits([replay]))[0]!;
    return { settlement, deduplicated: true, message: submittedCopy(replay.ref) };
  }
  // No replay: one source rental holds at most one open transfer approval.
  const open = await prisma.customerSettlement.findFirst({
    where: {
      tenantId: r.tenant.id,
      unitId: r.sourceUnitId,
      kind: 'TRANSFER',
      status: { in: OPEN_TRANSFER_STATUSES },
    },
    select: { ref: true },
  });
  assertNoOpenTransfer(open?.ref ?? null);
  const correlationId = newCorrelationId();
  const saved = await prisma.$transaction(async (tx) => {
    const row = (await tx.customerSettlement.create({
      data: {
        ref: await nextTransferRef(tx),
        kind: 'TRANSFER',
        docType: 'Transfer approval',
        origin: 'TRANSFER',
        tenantId: r.tenant.id,
        unitId: r.sourceUnitId,
        toUnitId: r.dest.id,
        effectiveDate: parseSgDate(r.snapshot.effectiveDate),
        channel: null,
        reason: input.reason?.trim() ? input.reason.trim().slice(0, 500) : null,
        note: null,
        lines: r.snapshot.lines as unknown as Prisma.InputJsonValue,
        amount: r.snapshot.netAdjustment,
        adjustment: r.snapshot.exceptionAdjustment
          ? ({
              type: r.snapshot.exceptionAdjustment.amount > 0 ? 'CHARGE' : 'CREDIT',
              category: 'Other',
              amount: Math.abs(r.snapshot.exceptionAdjustment.amount),
              reason: r.snapshot.exceptionAdjustment.reason,
            } as unknown as Prisma.InputJsonValue)
          : undefined,
        status: 'PENDING_APPROVAL',
        requestedBy: cleanActor,
        calcVersion: TRANSFER_CALC_VERSION,
        calcSnapshot: r.snapshot as unknown as Prisma.InputJsonValue,
        version: 0,
        idempotencyKey: key,
      },
      include: FULL_INCLUDE,
    })) as SettlementRow;
    await noteOnTenant(tx, r.tenant.id, `Transfer submitted · ${row.ref} · ${r.sourceUnitDisplay} → ${r.dest.name ?? r.dest.unitCode} · awaiting Finance approval`, cleanActor);
    await writeAuditEvent(tx, {
      branchId: row.tenant.unit?.branchId ?? row.tenant.branchId ?? null,
      actor: cleanActor,
      action: 'transfer.requested',
      entityType: 'CustomerSettlement',
      entityId: row.id,
      after: {
        ref: row.ref,
        status: 'PENDING_APPROVAL',
        sourceUnitId: r.sourceUnitId,
        destUnitId: r.dest.id,
        effectiveDate: r.snapshot.effectiveDate,
        netAdjustment: r.snapshot.netAdjustment,
        outcome: r.snapshot.outcome,
      },
      reason: input.reason?.trim()?.slice(0, 200) || undefined,
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'transfer.requested',
      payload: {
        settlementId: row.id,
        ref: row.ref,
        tenantId: r.tenant.id,
        sourceUnitId: r.sourceUnitId,
        destUnitId: r.dest.id,
        effectiveDate: r.snapshot.effectiveDate,
      },
      branchId: row.tenant.unit?.branchId ?? row.tenant.branchId ?? null,
      correlationId,
    });
    return row;
  });
  const settlement = (await attachDestUnits([saved]))[0]!;
  return { settlement, deduplicated: false, message: submittedCopy(saved.ref) };
}

// ---------------------------------------------------------------------------
// Finance change-request → Operations (PENDING_APPROVAL → CHANGES_REQUESTED)
// ---------------------------------------------------------------------------

export interface TransferChangesInput {
  note: string;
  category?: string | null;
  assignTeam?: string | null;
  assigneeId?: string | null;
  dueDate: string;
  expectedVersion?: number | null;
}

export async function requestTransferChanges(
  id: string,
  input: TransferChangesInput,
  actor: string,
): Promise<{ settlement: TransferRow }> {
  if (!input.note?.trim()) throw new AppError(400, 'VALIDATION', 'Say what needs to change.');
  const cleanActor = actor.slice(0, 120);
  const s = await loadTransfer(id);
  assertNewLifecycle(s);
  if (s.status !== 'PENDING_APPROVAL') {
    throw new AppError(409, 'CONFLICT', `${s.ref} cannot be returned for changes (status ${s.status}).`);
  }
  assertFreshVersion(s.version, input.expectedVersion ?? undefined, 'transfer');
  const category =
    input.category?.trim() || 'Unit or transfer date';
  if (!(TRANSFER_CHANGE_CATEGORIES as readonly string[]).includes(category)) {
    throw new AppError(
      400,
      'VALIDATION',
      `Choose an issue category: ${TRANSFER_CHANGE_CATEGORIES.join(', ')}.`,
    );
  }
  if (!input.dueDate) throw new AppError(400, 'VALIDATION', 'Set a due date for the Operations correction.');
  const due = parseSgDate(input.dueDate);
  const correlationId = newCorrelationId();
  const assigneeId = input.assigneeId?.trim() || null;
  const assignTeam = input.assignTeam?.trim() || null;
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
    await noteOnTenant(
      tx,
      s.tenantId,
      `Transfer returned for changes · ${s.ref} · ${input.note.trim().slice(0, 140)} · ${RETURNED_COPY}`,
      cleanActor,
    );
    // A-21: the Finance change request is also an Operations work item. A
    // chosen assignee is notified through the existing StaffNotification
    // path (their Overview notification queue); a team-only return stays
    // visible in the team queues with no user pinged.
    if (assigneeId) {
      await notifyChangeRequestAssignee(tx, {
        assigneeId,
        title: `Finance change requested · ${s.ref}`,
        body: `${s.tenant.name} · ${category} · due ${toYmd(due)} · ${input.note.trim()}`,
        entityType: 'tenant',
        entityId: s.tenantId,
        actor: cleanActor,
      });
    }
    await writeAuditEvent(tx, {
      branchId: branchIdOf(s),
      actor: cleanActor,
      action: 'transfer.changes_requested',
      entityType: 'CustomerSettlement',
      entityId: id,
      before: { status: 'PENDING_APPROVAL', version: s.version },
      after: {
        status: 'CHANGES_REQUESTED',
        version: s.version + 1,
        category,
        assignTeam,
        assigneeId,
        dueDate: toYmd(due),
        processorState: RETURNED_COPY,
      },
      reason: input.note.trim().slice(0, 200),
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'transfer.changes_requested',
      payload: { settlementId: id, ref: s.ref, requestedBy: cleanActor, category, dueDate: toYmd(due) },
      branchId: branchIdOf(s),
      correlationId,
    });
    return tx.customerSettlement.findFirst({ where: { id }, include: FULL_INCLUDE });
  });
  const settlement = (await attachDestUnits([saved as SettlementRow]))[0]!;
  return { settlement };
}

// ---------------------------------------------------------------------------
// Operations correct + resubmit (CHANGES_REQUESTED → PENDING_APPROVAL)
// ---------------------------------------------------------------------------

export interface CorrectTransferInput extends TransferMutationInput {
  /** Mandatory Operations response/evidence (handoff §11.10). */
  response: string;
  expectedVersion?: number | null;
}

export async function correctTransfer(
  id: string,
  input: CorrectTransferInput,
  actor: string,
): Promise<{ settlement: TransferRow }> {
  if (!input.response?.trim()) throw new AppError(400, 'VALIDATION', 'Add the Operations response to the Finance change request.');
  const cleanActor = actor.slice(0, 120);
  const s = await loadTransfer(id);
  assertNewLifecycle(s);
  if (s.status !== 'CHANGES_REQUESTED') {
    throw new AppError(409, 'CONFLICT', `${s.ref} has nothing to correct (status ${s.status}).`);
  }
  assertFreshVersion(s.version, input.expectedVersion ?? undefined, 'transfer');
  const stored = (s.calcSnapshot ?? {}) as unknown as TransferSnapshot;
  const r = await resolveTransfer(s.tenantId, input, { stored });
  // A correction recomputes the whole transfer from corrected inputs — staff
  // never key the final net amount directly (handoff §11.10).
  const fresh: TransferSnapshot = {
    ...r.snapshot,
    calcVersion: TRANSFER_CALC_VERSION,
  };
  const correlationId = newCorrelationId();
  const saved = await prisma.$transaction(async (tx) => {
    const updated = (await tx.customerSettlement.update({
      where: { id, version: s.version },
      data: {
        toUnitId: r.dest.id,
        effectiveDate: parseSgDate(fresh.effectiveDate),
        lines: fresh.lines as unknown as Prisma.InputJsonValue,
        amount: fresh.netAdjustment,
        adjustment: fresh.exceptionAdjustment
          ? ({
              type: fresh.exceptionAdjustment.amount > 0 ? 'CHARGE' : 'CREDIT',
              category: 'Other',
              amount: Math.abs(fresh.exceptionAdjustment.amount),
              reason: fresh.exceptionAdjustment.reason,
            } as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        status: 'PENDING_APPROVAL',
        calcVersion: s.calcVersion + 1,
        calcSnapshot: {
          ...(stored as unknown as Record<string, unknown>),
          ...fresh,
          correctedAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
        processingError: null,
        version: s.version + 1,
      },
      include: FULL_INCLUDE,
    })) as SettlementRow;
    await tx.settlementChangeRequest.updateMany({
      where: { settlementId: id, status: 'OPEN' },
      data: {
        status: 'ADDRESSED',
        response: input.response.trim().slice(0, 500),
        respondedBy: cleanActor,
        respondedAt: new Date(),
      },
    });
    await noteOnTenant(tx, s.tenantId, `Transfer corrected · ${updated.ref} · returned to Finance approval`, cleanActor);
    await writeAuditEvent(tx, {
      branchId: branchIdOf(s),
      actor: cleanActor,
      action: 'transfer.corrected',
      entityType: 'CustomerSettlement',
      entityId: id,
      before: { status: 'CHANGES_REQUESTED', amount: toNum(s.amount), calcVersion: s.calcVersion, calcSnapshot: s.calcSnapshot },
      after: { status: 'PENDING_APPROVAL', amount: toNum(updated.amount), calcVersion: updated.calcVersion },
      reason: input.response.trim().slice(0, 200),
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'transfer.corrected',
      payload: { settlementId: id, ref: updated.ref, corrected: true },
      branchId: branchIdOf(s),
      correlationId,
    });
    return tx.customerSettlement.findFirst({ where: { id }, include: FULL_INCLUDE });
  });
  const settlement = (await attachDestUnits([saved as SettlementRow]))[0]!;
  return { settlement };
}

// ---------------------------------------------------------------------------
// Approve (PENDING_APPROVAL → APPROVED; posting stays in execute)
// ---------------------------------------------------------------------------

export interface TransferDecideOpts {
  actor: string;
  isOwner: boolean;
  expectedVersion?: number | null;
  reason?: string;
}

export async function approveTransfer(
  id: string,
  opts: TransferDecideOpts,
): Promise<{ settlement: TransferRow; message: string; bypassed: boolean }> {
  const cleanActor = opts.actor.slice(0, 120);
  const s = await loadTransfer(id);
  assertNewLifecycle(s);
  if (s.status !== 'PENDING_APPROVAL') {
    throw new AppError(409, 'CONFLICT', `Only transfers awaiting approval can be approved (this one is ${s.status}).`);
  }
  assertFreshVersion(s.version, opts.expectedVersion ?? undefined, 'transfer');
  // D5: no self-approval — Owner single-step bypass only, with a mandatory
  // reason, audited. Handoff §14: ADMIN_ONLY restricts approval to the Owner.
  const { bypassed } = checkProcessorSeparation(s.requestedBy, null, cleanActor, opts.isOwner, opts.reason, 'approve');
  const policy = await getBusinessRule('moveout.approvalRole');
  if (policy.value === 'ADMIN_ONLY' && !opts.isOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Transfer approval is restricted to the Owner (Move-outs & refunds policy).');
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
    await noteOnTenant(tx, s.tenantId, `Transfer approved · ${s.ref} · ${APPROVED_COPY}`, cleanActor);
    await writeAuditEvent(tx, {
      branchId: branchIdOf(s),
      actor: cleanActor,
      action: 'transfer.approved',
      entityType: 'CustomerSettlement',
      entityId: id,
      before: { status: 'PENDING_APPROVAL', version: s.version },
      after: { status: 'APPROVED', version: s.version + 1, bypassed },
      reason: opts.reason?.trim() || undefined,
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'transfer.approved',
      payload: { settlementId: id, ref: s.ref, approvedBy: cleanActor, bypassed },
      branchId: branchIdOf(s),
      correlationId,
    });
    return updated;
  });
  const settlement = (await attachDestUnits([saved]))[0]!;
  return { settlement, message: `${s.ref}: ${APPROVED_COPY}`, bypassed };
}

// ---------------------------------------------------------------------------
// Execute — atomic posting (APPROVED → POSTED), handoff §11.11
// ---------------------------------------------------------------------------

export interface ExecuteTransferInput {
  expectedVersion?: number | null;
  reason?: string;
  /** Test-only clock override (SG-date helpers in e2e pass an explicit now so
   *  the effective-date guard has no wall-clock dependence). The route never
   *  sends this — the server uses the real clock. */
  now?: Date;
}

/** Destination or source failed revalidation inside the posting transaction. */
class TransferRevalidationError extends Error {}

/** Effective date is still in the future (SG calendar) at posting time. */
class TransferEarlyError extends Error {
  effYmd: string;
  todayYmd: string;
  constructor(effYmd: string, todayYmd: string) {
    super(`early:${effYmd}:${todayYmd}`);
    this.effYmd = effYmd;
    this.todayYmd = todayYmd;
  }
}

/** A-17 copy: posting swaps unit/access/rent, so it waits for the date. */
function earlyPostCopy(ref: string, effYmd: string, todayYmd: string): string {
  return (
    `Transfer ${ref} takes effect on ${effYmd} (Singapore) — ` +
    `posting is blocked until then (SG today ${todayYmd}). ` +
    `The source unit stays active.`
  );
}

async function auditExecuteBlocked(
  s: SettlementRow,
  actor: string,
  effYmd: string,
  todayYmd: string,
): Promise<void> {
  const correlationId = newCorrelationId();
  await prisma.$transaction(async (tx) => {
    await writeAuditEvent(tx, {
      branchId: branchIdOf(s),
      actor,
      action: 'transfer.execute_blocked',
      entityType: 'CustomerSettlement',
      entityId: s.id,
      before: { status: s.status, version: s.version, effectiveDate: toYmd(s.effectiveDate) },
      after: { status: s.status, version: s.version, effectiveDate: effYmd, sgToday: todayYmd },
      reason: `Blocked: effective ${effYmd} after SG today ${todayYmd}`,
      source: 'cms',
      correlationId,
    });
    await tx.recordNote.create({
      data: {
        entityType: 'tenant',
        entityId: s.tenantId,
        body:
          `Transfer posting blocked · ${s.ref} · effective ${effYmd} ` +
          `(SG today ${todayYmd}) — source stays active until the effective date`,
        author: actor,
      },
    });
  });
}

/** A concurrent execute won the compare-and-swap first. */
class TransferConcurrentError extends Error {}

function postingRefOf(ref: string): string {
  return `transfer:${ref}`.slice(0, 200);
}

async function markTransferReturned(
  s: SettlementRow,
  actor: string,
  reason: string,
): Promise<void> {
  const correlationId = newCorrelationId();
  await prisma.$transaction(async (tx) => {
    const res = await tx.customerSettlement.updateMany({
      where: { id: s.id, version: s.version, status: 'APPROVED' },
      data: { status: 'CHANGES_REQUESTED', version: s.version + 1, processingError: reason.slice(0, 500) },
    });
    if (res.count === 0) return;
    await noteOnTenant(tx, s.tenantId, `Transfer returned for changes · ${s.ref} · ${reason} · ${RETURNED_COPY}`, actor);
    await writeAuditEvent(tx, {
      branchId: branchIdOf(s),
      actor,
      action: 'transfer.changes_requested',
      entityType: 'CustomerSettlement',
      entityId: s.id,
      before: { status: 'APPROVED', version: s.version },
      after: { status: 'CHANGES_REQUESTED', version: s.version + 1, processorState: RETURNED_COPY },
      reason: reason.slice(0, 200),
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'transfer.changes_requested',
      payload: { settlementId: s.id, ref: s.ref, reason, systemReturn: true },
      branchId: branchIdOf(s),
      correlationId,
    });
  });
}

export async function executeTransfer(
  id: string,
  input: ExecuteTransferInput,
  actor: string,
  isOwner: boolean,
): Promise<{ settlement: TransferRow; message: string; deduplicated: boolean }> {
  const cleanActor = actor.slice(0, 120);
  const s = await loadTransfer(id);
  assertNewLifecycle(s);
  // Idempotent execute: a posted transfer replays the shared posting writer
  // (no-op when the lines already match) instead of moving money twice.
  if (s.status === 'POSTED') {
    await postSettlementLedger(prisma, s, { processorRef: postingRefOf(s.ref) }, cleanActor);
    const settlement = await getTransfer(id);
    return { settlement, message: `${s.ref} already posted — no duplicate entries created.`, deduplicated: true };
  }
  if (s.status !== 'APPROVED') {
    throw new AppError(409, 'CONFLICT', `Only approved transfers can execute (this one is ${s.status}).`);
  }
  assertFreshVersion(s.version, input.expectedVersion ?? undefined, 'transfer');
  // D5 three-party separation: execution needs an operator who neither
  // requested nor approved the transfer (Owner bypass with reason, audited).
  checkProcessorSeparation(s.requestedBy, s.approvedBy, cleanActor, isOwner, input.reason, 'process');
  // A-17: posting swaps unit/access/rent, so it waits for the effective SG
  // date. The server clock is the authority (R1 Asia/Singapore); `input.now`
  // exists only so e2e can inject a deterministic clock.
  const postingNow = input.now ?? new Date();
  const effOuter = toYmd(s.effectiveDate);
  const todayOuter = sgCalendarDate(postingNow);
  if (effOuter > todayOuter) {
    await auditExecuteBlocked(s, cleanActor, effOuter, todayOuter);
    throw new AppError(409, 'CONFLICT', earlyPostCopy(s.ref, effOuter, todayOuter));
  }
  const stored = (s.calcSnapshot ?? {}) as unknown as TransferSnapshot;
  const correlationId = newCorrelationId();
  try {
    const saved = await prisma.$transaction(async (tx) => {
      // A-17 re-check INSIDE the posting transaction: the effective date is
      // re-read and compared to SG today at post time, before any write.
      const freshRow = await tx.customerSettlement.findFirst({ where: { id }, select: { effectiveDate: true } });
      const effTx = freshRow ? toYmd(freshRow.effectiveDate) : effOuter;
      if (effTx > sgCalendarDate(postingNow)) throw new TransferEarlyError(effTx, sgCalendarDate(postingNow));
      // Compare-and-swap first: a concurrent execute (or correction) wins,
      // the loser replays as a no-op or 409s below — never double-posts.
      const cas = await tx.customerSettlement.updateMany({
        where: { id, version: s.version, status: 'APPROVED' },
        data: { status: 'POSTED', version: s.version + 1 },
      });
      if (cas.count === 0) throw new TransferConcurrentError();
      // R10 revalidation INSIDE the posting transaction: the destination
      // must still be AVAILABLE and the source rental still active.
      const tenant = await tx.tenant.findFirst({ where: { id: s.tenantId } });
      if (!tenant || tenant.unitId !== s.unitId || tenant.status !== 'ACTIVE') {
        throw new TransferRevalidationError();
      }
      const destId = s.toUnitId;
      if (!destId) throw new TransferRevalidationError();
      const dest = await tx.unit.findFirst({ where: { id: destId } });
      if (!dest || dest.deletedAt || dest.status !== 'AVAILABLE') {
        throw new TransferRevalidationError();
      }
      const occupant = await tx.tenant.findFirst({ where: { unitId: destId, status: 'ACTIVE' }, select: { id: true } });
      if (occupant && occupant.id !== tenant.id) throw new TransferRevalidationError();
      // Preview/execute share the computation: recompute from live inputs and
      // refuse to post on drift (a rent or destination edit needs a
      // correct-and-resubmit first). A-23: the promotion is re-derived from
      // the destination unit here too — never trusted from the snapshot.
      const livePromo = await resolveDestinationPromo(destId);
      const live = buildTransferSnapshot({
        sourceUnitId: s.unitId,
        destUnitId: destId,
        effectiveDate: toYmd(s.effectiveDate),
        sourceNetMonthlyRent: toNum(await rentChargedOn(tenant.id, tenant.unitId, s.effectiveDate, toNum(tenant.monthlyRate))),
        sourceDepositHeld: stored.sourceDepositCredit ?? 0,
        destRackGrossMonthly: toNum(dest.monthlyRate),
        destPromoPct: livePromo.promoPct,
        destPromoPlanName: livePromo.planName,
        destDepositRequired: stored.destDepositRequired ?? 0,
        destProtectionMonthly: stored.destProtectionMonthly ?? 0,
        exceptionAdjustment: cleanException(stored.exceptionAdjustment),
      });
      if (snapshotKey(live) !== snapshotKey(stored)) {
        throw new AppError(
          409,
          'CONFLICT',
          'Transfer inputs changed since approval — correct and resubmit before executing.',
        );
      }
      const destNet = live.destNetMonthly;
      const sqft = dest.sqft > 0 ? dest.sqft : 1;
      // §11.11 atomic posting: unit pointer, unit statuses, future recurring
      // rent + PSF at destination values, ledger, history — all or nothing.
      await tx.unit.update({ where: { id: s.unitId }, data: { status: 'AVAILABLE' } });
      await tx.unit.update({ where: { id: destId }, data: { status: 'OCCUPIED' } });
      await tx.tenant.update({
        where: { id: tenant.id },
        data: { unitId: destId, monthlyRate: destNet, psf: r4(r2(destNet) / sqft), version: { increment: 1 } },
      });
      const postingRef = postingRefOf(s.ref);
      await postSettlementLedger(tx, s, { processorRef: postingRef }, cleanActor);
      const invoices = await tx.invoice.findMany({
        where: { tenantId: tenant.id, unitId: s.unitId },
        select: { amount: true, amountPaid: true },
      });
      await tx.rentalUnitHistory.create({
        data: {
          tenantId: tenant.id,
          unitId: s.unitId,
          startedAt: tenant.moveInDate ?? tenant.createdAt,
          endedAt: s.effectiveDate,
          endReason: 'TRANSFER',
          replacementUnitId: destId,
          pricingSnapshot: {
            sourceNetMonthlyRent: live.sourceNetMonthlyRent,
            destNetMonthly: live.destNetMonthly,
            destRackGrossMonthly: live.destRackGrossMonthly,
            transferRef: s.ref,
          } as unknown as Prisma.InputJsonValue,
          billedTotals: {
            monthsBilled: invoices.length,
            totalBilled: r2(invoices.reduce((n, i) => n + toNum(i.amountPaid ?? i.amount), 0)),
          } as unknown as Prisma.InputJsonValue,
          transferCredit: live.sourceCredit,
          sourceSettlementId: s.id,
        },
      });
      await tx.customerSettlement.update({
        where: { id },
        data: {
          processedBy: cleanActor,
          processedAt: new Date(),
          processorRef: postingRef,
          postingRef,
          processingError: null,
        },
      });
      await noteOnTenant(
        tx,
        tenant.id,
        `Transfer posted · ${s.ref} · customer moved to ${dest.name ?? dest.unitCode} · billing continues at destination rates`,
        cleanActor,
      );
      await writeAuditEvent(tx, {
        branchId: branchIdOf(s),
        actor: cleanActor,
        action: 'transfer.executed',
        entityType: 'CustomerSettlement',
        entityId: id,
        before: { status: 'APPROVED', version: s.version, sourceUnitId: s.unitId },
        after: {
          status: 'POSTED',
          version: s.version + 1,
          destUnitId: destId,
          destNetMonthly: destNet,
          netAdjustment: live.netAdjustment,
          outcome: live.outcome,
          postingRef,
        },
        reason: input.reason?.trim()?.slice(0, 200) || undefined,
        source: 'cms',
        correlationId,
      });
      await publishFinanceEvent(tx, {
        type: 'transfer.executed',
        payload: {
          settlementId: id,
          ref: s.ref,
          tenantId: tenant.id,
          sourceUnitId: s.unitId,
          destUnitId: destId,
          postingRef,
        },
        branchId: branchIdOf(s),
        correlationId,
      });
      return tx.customerSettlement.findFirst({ where: { id }, include: FULL_INCLUDE });
    });
    const settlement = (await attachDestUnits([saved as SettlementRow]))[0]!;
    const destCode = settlement.destUnit ? `${settlement.destUnit.unitName}` : 'destination';
    return { settlement, message: `${s.ref} posted — customer moved to ${destCode}.`, deduplicated: false };
  } catch (e) {
    if (e instanceof TransferEarlyError) {
      // No partial rows: the throw happens before the CAS, so the posting
      // transaction rolled back with zero unit/ledger/history writes. Audit
      // the blocked attempt outside the rolled-back transaction.
      await auditExecuteBlocked(s, cleanActor, e.effYmd, e.todayYmd);
      throw new AppError(409, 'CONFLICT', earlyPostCopy(s.ref, e.effYmd, e.todayYmd));
    }
    if (e instanceof TransferRevalidationError) {
      // R10: no hold — the destination (or source) moved under us, so the
      // transfer goes back to Operations instead of posting against a lie.
      await markTransferReturned(s, cleanActor, 'Destination or source failed revalidation at posting');
      throw new AppError(
        409,
        'CONFLICT',
        'The destination or source changed before posting — the transfer was returned for changes.',
      );
    }
    if (e instanceof TransferConcurrentError) {
      const fresh = await loadTransfer(id);
      if (fresh.status === 'POSTED') {
        await postSettlementLedger(prisma, fresh, { processorRef: postingRefOf(fresh.ref) }, cleanActor);
        const settlement = await getTransfer(id);
        return { settlement, message: `${fresh.ref} already posted — no duplicate entries created.`, deduplicated: true };
      }
      throw new AppError(409, 'STALE', 'Transfer changed since you opened it (version is stale). Reload and retry.', {
        entity: 'transfer',
        expected: s.version,
        current: fresh.version,
      });
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Owner-only manual destination replace (D9)
// ---------------------------------------------------------------------------

export interface ReplaceDestinationInput {
  toUnitId: string;
  reason: string;
  expectedVersion?: number | null;
}

export async function replaceTransferDestination(
  id: string,
  input: ReplaceDestinationInput,
  actor: string,
  isOwner: boolean,
): Promise<{ settlement: TransferRow }> {
  // D9: the manual replace path is Owner-only — the route also carries the
  // OWNER permission, this is the service-level second lock.
  if (!isOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Only the Owner can replace the transfer destination manually.');
  }
  if (!input.reason?.trim()) throw new AppError(400, 'VALIDATION', 'A reason is required to replace the destination.');
  const cleanActor = actor.slice(0, 120);
  const s = await loadTransfer(id);
  assertNewLifecycle(s);
  if (!REPLACEABLE_STATUSES.includes(s.status)) {
    throw new AppError(409, 'CONFLICT', `${s.ref} can no longer change destination (status ${s.status}).`);
  }
  assertFreshVersion(s.version, input.expectedVersion ?? undefined, 'transfer');
  const stored = (s.calcSnapshot ?? {}) as unknown as TransferSnapshot;
  const beforeDest = s.toUnitId;
  const r = await resolveTransfer(s.tenantId, { toUnitId: input.toUnitId }, { stored });
  const fresh: TransferSnapshot = { ...r.snapshot, calcVersion: TRANSFER_CALC_VERSION };
  const correlationId = newCorrelationId();
  const saved = await prisma.$transaction(async (tx) => {
    const updated = (await tx.customerSettlement.update({
      where: { id, version: s.version },
      data: {
        toUnitId: r.dest.id,
        lines: fresh.lines as unknown as Prisma.InputJsonValue,
        amount: fresh.netAdjustment,
        adjustment: fresh.exceptionAdjustment
          ? ({
              type: fresh.exceptionAdjustment.amount > 0 ? 'CHARGE' : 'CREDIT',
              category: 'Other',
              amount: Math.abs(fresh.exceptionAdjustment.amount),
              reason: fresh.exceptionAdjustment.reason,
            } as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        status: s.status === 'CHANGES_REQUESTED' ? 'PENDING_APPROVAL' : s.status,
        calcVersion: s.calcVersion + 1,
        calcSnapshot: {
          ...(stored as unknown as Record<string, unknown>),
          ...fresh,
          manualReplace: true,
          replacedAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
        version: s.version + 1,
      },
      include: FULL_INCLUDE,
    })) as SettlementRow;
    await noteOnTenant(
      tx,
      s.tenantId,
      `Transfer destination replaced by Owner · ${s.ref} · reason: ${input.reason.trim().slice(0, 140)}`,
      cleanActor,
    );
    await writeAuditEvent(tx, {
      branchId: branchIdOf(s),
      actor: cleanActor,
      action: 'transfer.destination_replaced',
      entityType: 'CustomerSettlement',
      entityId: id,
      before: { destUnitId: beforeDest, amount: toNum(s.amount), calcVersion: s.calcVersion },
      after: { destUnitId: r.dest.id, amount: toNum(updated.amount), calcVersion: updated.calcVersion },
      reason: input.reason.trim().slice(0, 200),
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'transfer.corrected',
      payload: { settlementId: id, ref: updated.ref, manualReplace: true, destUnitId: r.dest.id },
      branchId: branchIdOf(s),
      correlationId,
    });
    return tx.customerSettlement.findFirst({ where: { id }, include: FULL_INCLUDE });
  });
  const settlement = (await attachDestUnits([saved as SettlementRow]))[0]!;
  return { settlement };
}

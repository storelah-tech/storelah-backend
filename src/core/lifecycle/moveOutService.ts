// Move-out case service (Track A, phase A3).
//
// One convergence point for every handoff §8.1 entry point: the CMS case
// routes, the operator move-outs queue and the customer-portal bridge (R2)
// all land here. Preview and post call the same pure A1 engine functions with
// inputs re-read from the DB — a client total is never accepted.
//
// State machine (handoff §8.5): PENDING_MOVE_OUT → AWAITING_INSPECTION →
// SETTLEMENT_REVIEW → REFUND_PROCESSING | CHARGE_PROCESSING → COMPLETED,
// plus REVERSED. The A4 half (approve → process/post → completed) is built on
// completeMoveOutCase(), exported here for reuse. Every mutation checks
// `version` via assertFreshVersion (409 STALE).
//
// R3: Pending → Awaiting is DERIVED ON READ (SG today from the A1 helpers,
// final access date ≤ today) and persisted with an audit event by the next
// read/write touching the case. R7: the effective moveout.* policy is
// snapshotted at request time; policy edits never rewrite open cases.
// Money: integer cents inside the engine; Decimal(10,2) in the DB; toNum on
// the way out.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { toNum } from '../../lib/format';
import { currentBranchScope } from '../../lib/facilityScope';
import { writeAuditEvent } from '../finance/audit';
import { publishFinanceEvent } from '../finance/events';
import { assertFreshVersion, newCorrelationId } from '../finance/idempotency';
import { getBusinessRule } from '../businessRules';
import { rentChargedOn } from '../finance/billing';
import { normalizeEmail } from '../customers';
import { commitmentEnd, parseCommitmentMonths } from '../customerProfile';
import {
  calculateMoveOutSettlement,
  calculateNoticeCompliance,
  deriveReadStatus,
  parseSgDate,
  sgCalendarDate,
  toYmd,
  MOVEOUT_CALC_VERSION,
  type MoveOutCaseStatus,
  type MoveOutSettlement,
} from './moveOutCalc';

// ---------------------------------------------------------------------------
// Constants (handoff copy — verbatim where quoted)
// ---------------------------------------------------------------------------

/** Handoff §8.2 request channels. */
export const MOVEOUT_CHANNELS = ['Customer portal', 'WhatsApp', 'Phone', 'Email', 'Onsite'] as const;

/** Handoff §8.2 reasons. */
export const MOVEOUT_REASONS = [
  'No longer needs storage',
  'Price',
  'Relocation completed',
  'Transferred to another provider',
  'Service issue',
  'Other',
] as const;

/** Handoff §8.9 unit release statuses. */
export const RELEASE_STATUSES = ['READY', 'CLEANING_REQUIRED', 'MAINTENANCE_REQUIRED', 'BLOCKED'] as const;

export const RELEASE_STATUS_LABELS: Record<string, string> = {
  READY: 'Ready for rental',
  CLEANING_REQUIRED: 'Cleaning required',
  MAINTENANCE_REQUIRED: 'Maintenance required',
  BLOCKED: 'Blocked for investigation',
};

/** Handoff §8.6 workspace note: access stays valid through 11:59 PM. */
export const ACCESS_CUTOFF_COPY =
  'Current access remains valid through 11:59 PM on the final access date unless a separately authorised security action overrides it.';

/** Handoff §19 empty-register copy. */
export const NO_CASES_COPY = 'No move-out cases match these filters.';

const OPEN_STATUSES: MoveOutCaseStatus[] = [
  'PENDING_MOVE_OUT',
  'AWAITING_INSPECTION',
  'SETTLEMENT_REVIEW',
  'REFUND_PROCESSING',
  'CHARGE_PROCESSING',
];

const CASE_STATUSES: MoveOutCaseStatus[] = [...OPEN_STATUSES, 'COMPLETED', 'REVERSED'];

function asStatus(s: string): MoveOutCaseStatus {
  if ((CASE_STATUSES as string[]).includes(s)) return s as MoveOutCaseStatus;
  throw new AppError(500, 'INTERNAL', `Unknown move-out case status "${s}".`);
}

/** R12: inspection release → unit status. */
export function releaseUnitStatus(releaseStatus: string): 'AVAILABLE' | 'MAINTENANCE' | 'BLOCKED' {
  if (releaseStatus === 'READY') return 'AVAILABLE';
  if (releaseStatus === 'BLOCKED') return 'BLOCKED';
  return 'MAINTENANCE';
}

// ---------------------------------------------------------------------------
// Policy snapshot (R7 — snapshot at request, D1 global-only)
// ---------------------------------------------------------------------------

export interface MoveoutPolicySnapshot {
  /** Effective required notice days (source: booking.moveOutNoticeDays). */
  noticeDays: number;
  allowDateChange: boolean;
  shortNoticeForfeitDeposit: boolean;
  depositCollectionEnabled: boolean;
  inspectionRequired: boolean;
  approvalRole: string;
}

export async function effectiveMoveoutPolicy(): Promise<MoveoutPolicySnapshot> {
  const [notice, allowDateChange, forfeit, deposit, inspection, approval] = await Promise.all([
    getBusinessRule('booking.moveOutNoticeDays'),
    getBusinessRule('moveout.allowDateChange'),
    getBusinessRule('moveout.shortNoticeForfeitDeposit'),
    getBusinessRule('moveout.depositCollectionEnabled'),
    getBusinessRule('moveout.inspectionRequired'),
    getBusinessRule('moveout.approvalRole'),
  ]);
  return {
    noticeDays: notice.value as number,
    allowDateChange: allowDateChange.value as boolean,
    shortNoticeForfeitDeposit: forfeit.value as boolean,
    depositCollectionEnabled: deposit.value as boolean,
    inspectionRequired: inspection.value as boolean,
    approvalRole: approval.value as string,
  };
}

// ---------------------------------------------------------------------------
// Reads (facility scope applied on every query)
// ---------------------------------------------------------------------------

const CASE_INCLUDE = {
  tenant: { select: { id: true, name: true, email: true, mobile: true, status: true, moveInDate: true } },
  unit: {
    select: {
      id: true, unitCode: true, name: true, branchId: true,
      branch: { select: { id: true, code: true, name: true } },
    },
  },
  branch: { select: { id: true, code: true, name: true } },
  inspection: true,
  settlement: { select: { id: true, ref: true, docType: true, amount: true, status: true, createdAt: true, requestedBy: true } },
  dateChanges: { orderBy: { createdAt: 'desc' as const } },
} as const;

type CaseRow = Prisma.MoveOutCaseGetPayload<{ include: typeof CASE_INCLUDE }>;

/** Operator facility scope as a MoveOutCase where-fragment (null = no filter). */
function scopeWhere(): Prisma.MoveOutCaseWhereInput | undefined {
  const scope = currentBranchScope();
  if (!scope) return undefined;
  return { OR: [{ branchId: { in: scope } }, { branchId: null }] };
}

function scopedAnd(where: Prisma.MoveOutCaseWhereInput): Prisma.MoveOutCaseWhereInput {
  const s = scopeWhere();
  return s ? { AND: [where, s] } : where;
}

function serializeInspection(i: CaseRow['inspection']) {
  if (!i) return null;
  return {
    id: i.id,
    unitEmpty: i.unitEmpty,
    doorLockWallsFloorChecked: i.doorLockWallsFloorChecked,
    accessRevoked: i.accessRevoked,
    releaseConfirmed: i.releaseConfirmed,
    releaseStatus: i.releaseStatus,
    releaseLabel: RELEASE_STATUS_LABELS[i.releaseStatus] ?? i.releaseStatus,
    earlyTerminationCharge: toNum(i.earlyTerminationCharge),
    damageCharge: toNum(i.damageCharge),
    cleaningCharge: toNum(i.cleaningCharge),
    disposalCharge: toNum(i.disposalCharge),
    otherCharge: toNum(i.otherCharge),
    arrearsAmount: toNum(i.arrearsAmount),
    specialCredit: toNum(i.specialCredit),
    notes: i.notes,
    evidenceRefs: i.evidenceRefs,
    inspector: i.inspector,
    completedAt: i.completedAt,
    createdAt: i.createdAt,
    version: i.version,
  };
}

/** Commitment end for reference (D7) — shown, never drives the maths. */
async function commitmentEndFor(tenantId: string, moveIn: Date | null): Promise<string | null> {
  const booking =
    (await prisma.booking.findFirst({
      where: { tenantId, status: 'CONFIRMED' },
      orderBy: { createdAt: 'desc' },
    })) ??
    (await prisma.booking.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' } }));
  const months = parseCommitmentMonths(booking?.duration ?? null);
  const moveInDate = moveIn ?? booking?.moveInDate ?? null;
  if (!moveInDate || !months) return null;
  return toYmd(commitmentEnd(moveInDate, months));
}

async function protectionPaidFor(unitCode: string | null | undefined, email: string | null): Promise<number> {
  if (!unitCode) return 0;
  const lead = await prisma.lead.findFirst({
    where: {
      unitCode,
      ...(email ? { emailNorm: normalizeEmail(email) } : {}),
      protectionCost: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    select: { protectionCost: true },
  });
  return lead?.protectionCost != null ? toNum(lead.protectionCost) : 0;
}

export function serializeCase(c: CaseRow, extra?: { commitmentEnd?: string | null; protectionPaid?: number }) {
  return {
    id: c.id,
    caseNumber: c.caseNumber,
    status: c.status,
    tenant: c.tenant,
    unit: {
      id: c.unit.id,
      unitCode: c.unit.unitCode,
      unitName: c.unit.name ?? c.unit.unitCode,
      branchId: c.unit.branchId,
      branchCode: c.unit.branch?.code ?? null,
      branchName: c.unit.branch?.name ?? c.branch?.name ?? null,
    },
    branchId: c.branchId,
    requestReceivedAt: c.requestReceivedAt,
    requestChannel: c.requestChannel,
    reasonCode: c.reasonCode,
    requestNotes: c.requestNotes,
    finalAccessDate: toYmd(c.finalAccessDate),
    accessCutoff: ACCESS_CUTOFF_COPY,
    noticeDays: c.noticeDays,
    noticeRequiredDays: c.noticeRequiredDays,
    noticeCompliant: c.noticeCompliant,
    policySnapshot: c.policySnapshot,
    noticeId: c.noticeId,
    commitmentEnd: extra?.commitmentEnd ?? null,
    protectionPaid: extra?.protectionPaid ?? 0,
    inspection: serializeInspection(c.inspection),
    settlement: c.settlement
      ? { ...c.settlement, amount: toNum(c.settlement.amount) }
      : null,
    dateChanges: c.dateChanges.map((d) => ({
      id: d.id,
      previousDate: toYmd(d.previousDate),
      newDate: toYmd(d.newDate),
      reason: d.reason,
      byCustomer: d.byCustomer,
      actor: d.actor,
      beforeCalc: d.beforeCalc,
      afterCalc: d.afterCalc,
      createdAt: d.createdAt,
    })),
    reversedAt: c.reversedAt,
    reversedBy: c.reversedBy,
    reversalReason: c.reversalReason,
    createdBy: c.createdBy,
    version: c.version,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export type SerializedCase = ReturnType<typeof serializeCase>;

/** Register row (A-5): the canonical case plus the preview's unused-rent
 * estimate with zero charges — the same engine + rentChargedOn resolution as
 * previewMoveOutCase, so free-agreement months read S$0.00 (R9). Protection
 * never refunds and never appears here. */
export type ListedMoveOutCase = SerializedCase & { estimatedRentRefund: number };

/** R3: derive + persist Pending → Awaiting (with audit) inside the caller's tx. */
async function ensureDerivedStatus(
  tx: Prisma.TransactionClient,
  c: CaseRow,
): Promise<CaseRow> {
  const today = sgCalendarDate(new Date());
  const derived = deriveReadStatus(asStatus(c.status), toYmd(c.finalAccessDate), today);
  if (derived === c.status) return c;
  const updated = (await tx.moveOutCase.update({
    where: { id: c.id },
    data: { status: derived, version: c.version + 1 },
    include: CASE_INCLUDE,
  })) as CaseRow;
  const correlationId = newCorrelationId();
  await writeAuditEvent(tx, {
    branchId: updated.branchId,
    actor: 'system',
    action: 'move_out.auto_advanced',
    entityType: 'MoveOutCase',
    entityId: c.id,
    before: { status: c.status },
    after: { status: derived },
    reason: 'Final access day reached — derived on read (R3).',
    source: 'auto-transition',
    correlationId,
  });
  await publishFinanceEvent(tx, {
    type: 'move_out.auto_advanced',
    payload: { caseId: c.id, caseNumber: c.caseNumber, from: c.status, to: derived },
    branchId: updated.branchId,
    correlationId,
  });
  return updated;
}

async function loadCase(id: string): Promise<CaseRow> {
  const c = (await prisma.moveOutCase.findFirst({
    where: scopedAnd({ id }),
    include: CASE_INCLUDE,
  })) as CaseRow | null;
  if (!c) throw new AppError(404, 'NOT_FOUND', `Move-out case ${id} not found`);
  return c;
}

/** Load + apply the R3 derived transition (persisted). Read-only callers use this. */
async function loadCaseDerived(id: string): Promise<CaseRow> {
  const c = await loadCase(id);
  if (deriveReadStatus(asStatus(c.status), toYmd(c.finalAccessDate), sgCalendarDate(new Date())) === c.status) {
    return c;
  }
  return prisma.$transaction((tx) => ensureDerivedStatus(tx, c));
}

export interface ListCasesQuery {
  status?: string;
  branchId?: string;
  search?: string;
}

export async function listMoveOutCases(q: ListCasesQuery = {}): Promise<{ rows: ListedMoveOutCase[]; empty: string | null }> {
  const and: Prisma.MoveOutCaseWhereInput[] = [];
  const scope = scopeWhere();
  if (scope) and.push(scope);
  if (q.status) {
    if (!(CASE_STATUSES as string[]).includes(q.status)) {
      throw new AppError(400, 'VALIDATION', `Unknown move-out status "${q.status}".`);
    }
    and.push({ status: q.status });
  }
  if (q.branchId) and.push({ branchId: q.branchId });
  if (q.search?.trim()) {
    const s = q.search.trim();
    and.push({
      OR: [
        { caseNumber: { contains: s, mode: 'insensitive' } },
        { tenant: { name: { contains: s, mode: 'insensitive' } } },
        { tenant: { email: { contains: s, mode: 'insensitive' } } },
        { unit: { unitCode: { contains: s, mode: 'insensitive' } } },
      ],
    });
  }
  const rows = (await prisma.moveOutCase.findMany({
    where: and.length ? { AND: and } : undefined,
    include: CASE_INCLUDE,
    orderBy: { createdAt: 'desc' },
  })) as CaseRow[];
  // R3: the next list call touching a due case persists the derived status.
  const today = sgCalendarDate(new Date());
  const touched: CaseRow[] = [];
  for (const r of rows) {
    if (deriveReadStatus(asStatus(r.status), toYmd(r.finalAccessDate), today) !== r.status) {
      touched.push(await prisma.$transaction((tx) => ensureDerivedStatus(tx, r)));
    } else {
      touched.push(r);
    }
  }
  // A-5 register estimate: the preview's unused-rent figure per row with zero
  // charges — same engine + rentChargedOn resolution as previewMoveOutCase,
  // so free-agreement months read S$0.00 (R9). Protection never refunds.
  const rateRows = await prisma.tenant.findMany({
    where: { id: { in: touched.map((r) => r.tenantId) } },
    select: { id: true, monthlyRate: true },
  });
  const rateById = new Map(rateRows.map((t) => [t.id, toNum(t.monthlyRate)] as const));
  const listed: ListedMoveOutCase[] = await Promise.all(
    touched.map(async (r) => ({
      ...serializeCase(r),
      estimatedRentRefund: calculateMoveOutSettlement({
        finalAccessDate: r.finalAccessDate,
        netMonthlyRent: await rentChargedOn(r.tenantId, r.unitId, r.finalAccessDate, rateById.get(r.tenantId) ?? 0),
      }).unusedRentRefund,
    })),
  );
  return { rows: listed, empty: listed.length === 0 ? NO_CASES_COPY : null };
}

export async function getMoveOutCase(id: string): Promise<SerializedCase> {
  const c = await loadCaseDerived(id);
  return serializeCase(c, {
    commitmentEnd: await commitmentEndFor(c.tenantId, c.tenant.moveInDate),
    protectionPaid: await protectionPaidFor(c.unit.unitCode, c.tenant.email),
  });
}

// ---------------------------------------------------------------------------
// Calculation (inputs re-read from the DB — never a client total)
// ---------------------------------------------------------------------------

export interface CaseCalcInputs {
  finalAccessDate: Date;
  netMonthlyRent: number;
  depositHeld: number;
  noticeCompliant: boolean;
  shortNoticeForfeitsDeposit: boolean;
  protectionPaid: number;
  charges: {
    earlyTermination: number;
    damage: number;
    cleaning: number;
    disposal: number;
    arrears: number;
    other: number;
  };
  specialCredit: number;
  commitmentEnd: string | null;
}

async function buildCaseCalc(c: {
  tenantId: string;
  unitId: string;
  finalAccessDate: Date;
  noticeCompliant: boolean;
  policySnapshot: MoveoutPolicySnapshot;
  tenantMonthlyRate: number;
  tenantEmail: string | null;
  unitCode: string;
  inspectionCharges?: {
    earlyTermination: number;
    damage: number;
    cleaning: number;
    disposal: number;
    arrears: number;
    other: number;
    specialCredit: number;
  } | null;
}): Promise<{ calc: MoveOutSettlement; protectionPaid: number; commitmentEnd: string | null }> {
  const rent = await rentChargedOn(c.tenantId, c.unitId, c.finalAccessDate, c.tenantMonthlyRate);
  const protectionPaid = await protectionPaidFor(c.unitCode, c.tenantEmail);
  const tenant = await prisma.tenant.findUnique({ where: { id: c.tenantId }, select: { moveInDate: true } });
  const commitmentEndYmd = await commitmentEndFor(c.tenantId, tenant?.moveInDate ?? null);
  const ch = c.inspectionCharges ?? {
    earlyTermination: 0, damage: 0, cleaning: 0, disposal: 0, arrears: 0, other: 0, specialCredit: 0,
  };
  const calc = calculateMoveOutSettlement({
    finalAccessDate: c.finalAccessDate,
    netMonthlyRent: rent,
    // R8: deposit held is S$0 on every live rental; the formula path stays
    // live through the snapshot flag + non-zero test values.
    depositHeld: 0,
    noticeCompliant: c.noticeCompliant,
    shortNoticeForfeitsDeposit: c.policySnapshot.shortNoticeForfeitDeposit,
    protectionPaid,
    charges: {
      earlyTermination: ch.earlyTermination,
      damage: ch.damage,
      cleaning: ch.cleaning,
      disposal: ch.disposal,
      arrears: ch.arrears,
      other: ch.other,
    },
    specialCredit: ch.specialCredit,
    commitmentEndYmd,
  });
  return { calc, protectionPaid, commitmentEnd: commitmentEndYmd };
}

/** Recalculate preview without posting (handoff §17). */
export async function previewMoveOutCase(id: string) {
  const c = await loadCaseDerived(id);
  const insp = c.inspection;
  const { calc, protectionPaid, commitmentEnd: commitmentEndYmd } = await buildCaseCalc({
    tenantId: c.tenantId,
    unitId: c.unitId,
    finalAccessDate: c.finalAccessDate,
    noticeCompliant: c.noticeCompliant,
    policySnapshot: c.policySnapshot as unknown as MoveoutPolicySnapshot,
    tenantMonthlyRate: toNum((await prisma.tenant.findUnique({ where: { id: c.tenantId } }))!.monthlyRate),
    tenantEmail: c.tenant.email,
    unitCode: c.unit.unitCode,
    inspectionCharges: insp
      ? {
          earlyTermination: toNum(insp.earlyTerminationCharge),
          damage: toNum(insp.damageCharge),
          cleaning: toNum(insp.cleaningCharge),
          disposal: toNum(insp.disposalCharge),
          arrears: toNum(insp.arrearsAmount),
          other: toNum(insp.otherCharge),
          specialCredit: toNum(insp.specialCredit),
        }
      : null,
  });
  return {
    caseId: c.id,
    caseNumber: c.caseNumber,
    status: c.status,
    finalAccessDate: toYmd(c.finalAccessDate),
    noticeDays: c.noticeDays,
    noticeRequiredDays: c.noticeRequiredDays,
    noticeCompliant: c.noticeCompliant,
    calc,
    calcVersion: MOVEOUT_CALC_VERSION,
    policySnapshot: c.policySnapshot,
    commitmentEnd: commitmentEndYmd,
    protectionPaid,
  };
}

// ---------------------------------------------------------------------------
// Date-change before/after preview (handoff §8.7 — the change-date modal's
// live compare). Same engine + rentChargedOn resolution as changeMoveOutDate
// below, but writes nothing and creates no Finance record: the modal calls
// this debounced while a new date is picked — it never totals money
// client-side. Confirm still goes through PATCH /:id/date, which keeps its
// behaviour (reason required, policy gate, version check, history write).
// ---------------------------------------------------------------------------

export interface DateChangePreviewSide {
  finalAccessDate: string;
  noticeDays: number;
  noticeRequiredDays: number;
  noticeCompliant: boolean;
  unusedRentRefund: number;
  netSettlement: number;
  outcome: 'REFUND' | 'CHARGE' | 'ZERO';
}

export interface DateChangePreview {
  caseId: string;
  caseNumber: string;
  status: string;
  /** Live policy value: when false the confirm PATCH 409s (R7 snapshot stays). */
  dateChangeAllowed: boolean;
  before: DateChangePreviewSide;
  after: DateChangePreviewSide;
  /** After − before (cents-exact 2dp). */
  deltas: { noticeDays: number; unusedRentRefund: number; netSettlement: number };
  calcVersion: number;
}

const twoDp = (n: number): number => Math.round(n * 100) / 100;

function toPreviewSide(
  finalAccessDate: string,
  notice: { noticeDays: number; requiredNoticeDays: number; compliant: boolean },
  calc: MoveOutSettlement,
): DateChangePreviewSide {
  return {
    finalAccessDate,
    noticeDays: notice.noticeDays,
    noticeRequiredDays: notice.requiredNoticeDays,
    noticeCompliant: notice.compliant,
    unusedRentRefund: calc.unusedRentRefund,
    netSettlement: calc.netSettlement,
    outcome: calc.outcome,
  };
}

export async function previewMoveOutDateChange(
  id: string,
  finalAccessDate: string,
): Promise<DateChangePreview> {
  const c = await loadCaseDerived(id);
  if (c.status !== 'PENDING_MOVE_OUT' && c.status !== 'AWAITING_INSPECTION') {
    throw new AppError(
      409,
      'CONFLICT',
      `Move-out ${c.caseNumber} can no longer change its date (status ${c.status}).`,
    );
  }
  const fin = parseSgDate(finalAccessDate);
  const req = new Date(Date.UTC(
    c.requestReceivedAt.getUTCFullYear(),
    c.requestReceivedAt.getUTCMonth(),
    c.requestReceivedAt.getUTCDate(),
  ));
  if (fin.getTime() < req.getTime()) {
    throw new AppError(409, 'CONFLICT', 'The new date cannot be before the request date.');
  }
  const snapshot = c.policySnapshot as unknown as MoveoutPolicySnapshot;
  const tenantRate = toNum((await prisma.tenant.findUnique({ where: { id: c.tenantId } }))!.monthlyRate);
  const shared = {
    tenantId: c.tenantId,
    unitId: c.unitId,
    policySnapshot: snapshot,
    tenantMonthlyRate: tenantRate,
    tenantEmail: c.tenant.email,
    unitCode: c.unit.unitCode,
  };
  const beforeCalc = await buildCaseCalc({ ...shared, finalAccessDate: c.finalAccessDate, noticeCompliant: c.noticeCompliant });
  const notice = calculateNoticeCompliance({
    requestDate: req,
    finalAccessDate: fin,
    requiredNoticeDays: snapshot.noticeDays,
  });
  const afterCalc = await buildCaseCalc({ ...shared, finalAccessDate: fin, noticeCompliant: notice.compliant });
  const before = toPreviewSide(
    toYmd(c.finalAccessDate),
    { noticeDays: c.noticeDays, requiredNoticeDays: c.noticeRequiredDays, compliant: c.noticeCompliant },
    beforeCalc.calc,
  );
  const after = toPreviewSide(toYmd(fin), notice, afterCalc.calc);
  const policy = await effectiveMoveoutPolicy();
  return {
    caseId: c.id,
    caseNumber: c.caseNumber,
    status: c.status,
    dateChangeAllowed: policy.allowDateChange,
    before,
    after,
    deltas: {
      noticeDays: after.noticeDays - before.noticeDays,
      unusedRentRefund: twoDp(after.unusedRentRefund - before.unusedRentRefund),
      netSettlement: twoDp(after.netSettlement - before.netSettlement),
    },
    calcVersion: MOVEOUT_CALC_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Inspection live preview (handoff §8.9 — the inspection modal's settlement
// table). Same engine + rentChargedOn resolution as submitMoveOutInspection,
// with hypothetical charge inputs; writes nothing and creates no Finance
// record. The modal calls this debounced while charges are typed — it never
// totals money client-side.
// ---------------------------------------------------------------------------

export interface InspectionPreviewInput {
  earlyTerminationCharge?: number;
  damageCharge?: number;
  cleaningCharge?: number;
  disposalCharge?: number;
  arrearsAmount?: number;
  otherCharge?: number;
  specialCredit?: number;
}

export async function previewMoveOutInspection(id: string, input: InspectionPreviewInput = {}) {
  const c = await loadCaseDerived(id);
  if (c.inspection) {
    throw new AppError(409, 'CONFLICT', `Move-out ${c.caseNumber} has already been inspected.`);
  }
  if (c.status !== 'AWAITING_INSPECTION' && c.status !== 'PENDING_MOVE_OUT') {
    throw new AppError(409, 'CONFLICT', `Move-out ${c.caseNumber} can no longer be inspected (status ${c.status}).`);
  }
  const nonNeg = (v: number | undefined, label: string): number => {
    if (v === undefined || v === null) return 0;
    if (!Number.isFinite(v) || v < 0) {
      throw new AppError(400, 'VALIDATION', `${label} cannot be negative.`);
    }
    return v;
  };
  const charges = {
    earlyTermination: nonNeg(input.earlyTerminationCharge, 'Early-termination charge'),
    damage: nonNeg(input.damageCharge, 'Damage charge'),
    cleaning: nonNeg(input.cleaningCharge, 'Cleaning charge'),
    disposal: nonNeg(input.disposalCharge, 'Disposal charge'),
    arrears: nonNeg(input.arrearsAmount, 'Outstanding balance'),
    other: nonNeg(input.otherCharge, 'Other charge'),
  };
  const specialCredit = nonNeg(input.specialCredit, 'Approved special credit');
  const tenantRate = toNum((await prisma.tenant.findUnique({ where: { id: c.tenantId } }))!.monthlyRate);
  const { calc } = await buildCaseCalc({
    tenantId: c.tenantId,
    unitId: c.unitId,
    finalAccessDate: c.finalAccessDate,
    noticeCompliant: c.noticeCompliant,
    policySnapshot: c.policySnapshot as unknown as MoveoutPolicySnapshot,
    tenantMonthlyRate: tenantRate,
    tenantEmail: c.tenant.email,
    unitCode: c.unit.unitCode,
    inspectionCharges: { ...charges, specialCredit },
  });
  return {
    caseId: c.id,
    caseNumber: c.caseNumber,
    status: c.status,
    calc,
    calcVersion: MOVEOUT_CALC_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Record-request preview (handoff §8.2 — the request modal's live banner +
// settlement table). Server-computed from DB re-reads: the modal never keys
// or totals money. An omitted finalAccessDate defaults to request date +
// notice days (booking.moveOutNoticeDays, SG calendar). Creates nothing.
// ---------------------------------------------------------------------------

export interface MoveOutRequestPreviewInput {
  tenantId: string;
  requestReceivedAt?: string;
  finalAccessDate?: string;
}

export interface MoveOutRequestPreview {
  tenant: { id: string; name: string; email: string | null };
  unit: {
    id: string;
    unitCode: string;
    unitName: string;
    branchId: string;
    branchCode: string | null;
    branchName: string | null;
  };
  requestReceivedAt: string;
  finalAccessDate: string;
  /** Request date + notice days — the modal's default final access day. */
  defaultFinalAccessDate: string;
  noticeDays: number;
  requiredNoticeDays: number;
  noticeCompliant: boolean;
  calc: MoveOutSettlement;
  calcVersion: number;
  protectionPaid: number;
  /** Open case on this rental, if any — submitting would 409. */
  openCaseNumber: string | null;
}

export async function previewMoveOutRequest(input: MoveOutRequestPreviewInput): Promise<MoveOutRequestPreview> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    include: { unit: { include: { branch: true } } },
  });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', `Customer ${input.tenantId} not found`);
  if (!tenant.unitId || !tenant.unit) {
    throw new AppError(409, 'CONFLICT', 'This customer has no active unit.');
  }
  const policy = await effectiveMoveoutPolicy();
  const req = parseSgDate(input.requestReceivedAt ?? sgCalendarDate(new Date()));
  const defaultFin = new Date(req.getTime() + policy.noticeDays * 86_400_000);
  const fin = input.finalAccessDate ? parseSgDate(input.finalAccessDate) : defaultFin;
  const notice = calculateNoticeCompliance({
    requestDate: req,
    finalAccessDate: fin,
    requiredNoticeDays: policy.noticeDays,
  });
  const rent = await rentChargedOn(tenant.id, tenant.unitId, fin, toNum(tenant.monthlyRate));
  const protectionPaid = await protectionPaidFor(tenant.unit.unitCode, tenant.email);
  // R8: deposit held is S$0 on every live rental; the formula path stays live
  // through the snapshot flag + non-zero test values. No charges exist before
  // inspection, so the request preview is unused rent + deposit only.
  const calc = calculateMoveOutSettlement({
    finalAccessDate: fin,
    netMonthlyRent: rent,
    depositHeld: 0,
    noticeCompliant: notice.compliant,
    shortNoticeForfeitsDeposit: policy.shortNoticeForfeitDeposit,
    protectionPaid,
  });
  const open = await prisma.moveOutCase.findFirst({
    where: { tenantId: tenant.id, unitId: tenant.unitId, status: { in: [...OPEN_STATUSES] } },
    select: { caseNumber: true },
  });
  return {
    tenant: { id: tenant.id, name: tenant.name, email: tenant.email },
    unit: {
      id: tenant.unit.id,
      unitCode: tenant.unit.unitCode,
      unitName: tenant.unit.name ?? tenant.unit.unitCode,
      branchId: tenant.unit.branchId,
      branchCode: tenant.unit.branch?.code ?? null,
      branchName: tenant.unit.branch?.name ?? null,
    },
    requestReceivedAt: toYmd(req),
    finalAccessDate: toYmd(fin),
    defaultFinalAccessDate: toYmd(defaultFin),
    noticeDays: notice.noticeDays,
    requiredNoticeDays: notice.requiredNoticeDays,
    noticeCompliant: notice.compliant,
    calc,
    calcVersion: MOVEOUT_CALC_VERSION,
    protectionPaid,
    openCaseNumber: open?.caseNumber ?? null,
  };
}

// ---------------------------------------------------------------------------
// Create (all §8.1 entry points converge here)
// ---------------------------------------------------------------------------

export interface CreateCaseInput {
  tenantId: string;
  finalAccessDate: string;
  requestReceivedAt?: string;
  requestChannel: string;
  reasonCode: string;
  requestNotes?: string | null;
  createdBy: string;
  noticeId?: string | null;
}

async function nextCaseNumber(tx: Prisma.TransactionClient): Promise<string> {
  const last = await tx.moveOutCase.findFirst({
    where: { caseNumber: { startsWith: 'MO-' } },
    orderBy: { caseNumber: 'desc' },
    select: { caseNumber: true },
  });
  const n = last ? Number(last.caseNumber.slice(3)) + 1 : 1_000_001;
  return `MO-${String(n).padStart(7, '0')}`;
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

function assertChannelReason(channel: string, reason: string): void {
  if (!(MOVEOUT_CHANNELS as readonly string[]).includes(channel)) {
    throw new AppError(400, 'VALIDATION', `Unknown request channel "${channel}".`);
  }
  if (!(MOVEOUT_REASONS as readonly string[]).includes(reason)) {
    throw new AppError(400, 'VALIDATION', `Unknown move-out reason "${reason}".`);
  }
}

export async function createMoveOutCase(input: CreateCaseInput): Promise<SerializedCase> {
  assertChannelReason(input.requestChannel, input.reasonCode);
  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    include: { unit: { include: { branch: true } } },
  });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', `Customer ${input.tenantId} not found`);
  if (!tenant.unitId || !tenant.unit) {
    throw new AppError(409, 'CONFLICT', 'This customer has no active unit.');
  }
  // Facility scope: the case lives at the UNIT's facility (billing F-3 rule).
  // The Prisma facility-scope extension already narrows the tenant lookup
  // above to the operator's facilities (out-of-scope reads as not found);
  // the MoveOutCase create below is re-checked by assertCreateInScope.
  const open = await prisma.moveOutCase.findFirst({
    where: { tenantId: tenant.id, unitId: tenant.unitId, status: { in: [...OPEN_STATUSES] } },
    select: { caseNumber: true },
  });
  if (open) {
    throw new AppError(409, 'CONFLICT', `Move-out ${open.caseNumber} is already open for this rental.`);
  }

  const policy = await effectiveMoveoutPolicy();
  const todayYmd = sgCalendarDate(new Date());
  const req = parseSgDate(input.requestReceivedAt ?? todayYmd);
  const fin = parseSgDate(input.finalAccessDate);
  if (fin.getTime() < req.getTime()) {
    throw new AppError(400, 'VALIDATION', 'The final access date cannot be before the request date.');
  }
  const notice = calculateNoticeCompliance({
    requestDate: req,
    finalAccessDate: fin,
    requiredNoticeDays: policy.noticeDays,
  });
  // Handoff §8.3: today/past final access → Awaiting inspection, else Pending.
  const status: MoveOutCaseStatus = toYmd(fin) <= todayYmd ? 'AWAITING_INSPECTION' : 'PENDING_MOVE_OUT';
  const correlationId = newCorrelationId();

  const saved = await prisma.$transaction(async (tx) => {
    const row = (await tx.moveOutCase.create({
      data: {
        caseNumber: await nextCaseNumber(tx),
        tenantId: tenant.id,
        unitId: tenant.unitId!,
        branchId: tenant.unit!.branchId,
        requestReceivedAt: req,
        requestChannel: input.requestChannel,
        reasonCode: input.reasonCode,
        requestNotes: input.requestNotes?.trim() ? input.requestNotes.trim() : null,
        finalAccessDate: fin,
        noticeDays: notice.noticeDays,
        noticeRequiredDays: notice.requiredNoticeDays,
        noticeCompliant: notice.compliant,
        status,
        policySnapshot: policy as unknown as Prisma.InputJsonValue,
        noticeId: input.noticeId ?? null,
        createdBy: input.createdBy.slice(0, 120),
      },
      include: CASE_INCLUDE,
    })) as CaseRow;
    const beforeStatus = tenant.status;
    if (tenant.status !== 'NOTICE') {
      await tx.tenant.update({ where: { id: tenant.id }, data: { status: 'NOTICE', version: { increment: 1 } } });
      await tx.rentalStatusChange.create({
        data: {
          tenantId: tenant.id,
          fromStatus: beforeStatus,
          toStatus: 'NOTICE',
          reason: `Move-out ${row.caseNumber} recorded — rental is Pending move-out.`,
          actor: input.createdBy.slice(0, 120),
          source: 'move-out-case',
        },
      });
    }
    await tx.recordNote.create({
      data: {
        entityType: 'tenant',
        entityId: tenant.id,
        body: `Move-out request recorded · ${row.caseNumber} · final access ${toYmd(fin)}`,
        author: input.createdBy.slice(0, 120),
      },
    });
    await writeAuditEvent(tx, {
      branchId: row.branchId,
      actor: input.createdBy.slice(0, 120),
      action: 'move_out.requested',
      entityType: 'MoveOutCase',
      entityId: row.id,
      after: {
        caseNumber: row.caseNumber,
        status,
        finalAccessDate: toYmd(fin),
        noticeDays: notice.noticeDays,
        noticeCompliant: notice.compliant,
        channel: input.requestChannel,
        reason: input.reasonCode,
      },
      reason: input.requestNotes?.trim() || input.reasonCode,
      source: input.requestChannel === 'Customer portal' ? 'customer-portal' : 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'move_out.requested',
      payload: { caseId: row.id, caseNumber: row.caseNumber, tenantId: tenant.id, unitId: tenant.unitId },
      branchId: row.branchId,
      correlationId,
    });
    return row;
  });
  return serializeCase(saved);
}

// ---------------------------------------------------------------------------
// Change date (§8.7 — before/after preview, history, recalculation)
// ---------------------------------------------------------------------------

export interface ChangeDateInput {
  finalAccessDate: string;
  reason: string;
  expectedVersion?: number;
  byCustomer?: boolean;
  noticeId?: string | null;
}

export interface DateChangeResult {
  case: SerializedCase;
  before: { finalAccessDate: string; noticeDays: number; noticeCompliant: boolean; estimatedRefund: number };
  after: { finalAccessDate: string; noticeDays: number; noticeCompliant: boolean; estimatedRefund: number };
}

export async function changeMoveOutDate(
  id: string,
  input: ChangeDateInput,
  actor: string,
  opts: { skipPolicyGate?: boolean } = {},
): Promise<DateChangeResult> {
  if (!input.reason?.trim()) {
    throw new AppError(400, 'VALIDATION', 'A reason is required to change the move-out date.');
  }
  let c = await loadCase(id);
  c = await prisma.$transaction((tx) => ensureDerivedStatus(tx, c));
  if (c.status !== 'PENDING_MOVE_OUT' && c.status !== 'AWAITING_INSPECTION') {
    throw new AppError(
      409,
      'CONFLICT',
      `Move-out ${c.caseNumber} can no longer change its date (status ${c.status}).`,
    );
  }
  if (!opts.skipPolicyGate) {
    const policy = await effectiveMoveoutPolicy();
    if (!policy.allowDateChange) {
      throw new AppError(409, 'CONFLICT', 'Date changes are disabled by the Move-outs & refunds policy.');
    }
  }
  assertFreshVersion(c.version, input.expectedVersion, 'move-out case');
  const fin = parseSgDate(input.finalAccessDate);
  const req = new Date(Date.UTC(
    c.requestReceivedAt.getUTCFullYear(),
    c.requestReceivedAt.getUTCMonth(),
    c.requestReceivedAt.getUTCDate(),
  ));
  if (fin.getTime() < req.getTime()) {
    throw new AppError(400, 'VALIDATION', 'The new date cannot be before the request date.');
  }

  const snapshot = c.policySnapshot as unknown as MoveoutPolicySnapshot;
  const beforeCalc = await buildCaseCalc({
    tenantId: c.tenantId,
    unitId: c.unitId,
    finalAccessDate: c.finalAccessDate,
    noticeCompliant: c.noticeCompliant,
    policySnapshot: snapshot,
    tenantMonthlyRate: toNum((await prisma.tenant.findUnique({ where: { id: c.tenantId } }))!.monthlyRate),
    tenantEmail: c.tenant.email,
    unitCode: c.unit.unitCode,
  });
  const notice = calculateNoticeCompliance({
    requestDate: req,
    finalAccessDate: fin,
    requiredNoticeDays: snapshot.noticeDays,
  });
  const afterCalc = await buildCaseCalc({
    tenantId: c.tenantId,
    unitId: c.unitId,
    finalAccessDate: fin,
    noticeCompliant: notice.compliant,
    policySnapshot: snapshot,
    tenantMonthlyRate: toNum((await prisma.tenant.findUnique({ where: { id: c.tenantId } }))!.monthlyRate),
    tenantEmail: c.tenant.email,
    unitCode: c.unit.unitCode,
  });

  const before = {
    finalAccessDate: toYmd(c.finalAccessDate),
    noticeDays: c.noticeDays,
    noticeCompliant: c.noticeCompliant,
    estimatedRefund: beforeCalc.calc.netSettlement,
  };
  const after = {
    finalAccessDate: toYmd(fin),
    noticeDays: notice.noticeDays,
    noticeCompliant: notice.compliant,
    estimatedRefund: afterCalc.calc.netSettlement,
  };

  const todayYmd = sgCalendarDate(new Date());
  const nextStatus: MoveOutCaseStatus = toYmd(fin) <= todayYmd ? 'AWAITING_INSPECTION' : 'PENDING_MOVE_OUT';
  const correlationId = newCorrelationId();
  const saved = await prisma.$transaction(async (tx) => {
    const row = (await tx.moveOutCase.update({
      where: { id: c.id },
      data: {
        finalAccessDate: fin,
        noticeDays: notice.noticeDays,
        noticeRequiredDays: notice.requiredNoticeDays,
        noticeCompliant: notice.compliant,
        status: nextStatus,
        noticeId: input.noticeId ?? c.noticeId,
        version: c.version + 1,
      },
      include: CASE_INCLUDE,
    })) as CaseRow;
    await tx.moveOutDateChange.create({
      data: {
        caseId: c.id,
        previousDate: c.finalAccessDate,
        newDate: fin,
        reason: input.reason.trim(),
        byCustomer: input.byCustomer ?? false,
        actor: actor.slice(0, 120),
        beforeCalc: { ...before, calc: beforeCalc.calc } as unknown as Prisma.InputJsonValue,
        afterCalc: { ...after, calc: afterCalc.calc } as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.recordNote.create({
      data: {
        entityType: 'tenant',
        entityId: c.tenantId,
        body: `Move-out date changed · ${c.caseNumber} · ${before.finalAccessDate} → ${after.finalAccessDate}`,
        author: actor.slice(0, 120),
      },
    });
    await writeAuditEvent(tx, {
      branchId: row.branchId,
      actor: actor.slice(0, 120),
      action: 'move_out.date_changed',
      entityType: 'MoveOutCase',
      entityId: c.id,
      before,
      after,
      reason: input.reason.trim(),
      source: input.byCustomer ? 'customer-portal' : 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'move_out.date_changed',
      payload: { caseId: c.id, caseNumber: c.caseNumber, before, after },
      branchId: row.branchId,
      correlationId,
    });
    return row;
  });
  return { case: serializeCase(saved), before, after };
}

// ---------------------------------------------------------------------------
// Reverse (§8.8 — reason required, rental restored, history retained)
// ---------------------------------------------------------------------------

export interface ReverseCaseInput {
  reason: string;
  expectedVersion?: number;
}

export async function reverseMoveOutCase(
  id: string,
  input: ReverseCaseInput,
  actor: string,
): Promise<SerializedCase> {
  if (!input.reason?.trim()) {
    throw new AppError(400, 'VALIDATION', 'A reason is required to reverse the move-out request.');
  }
  let c = await loadCase(id);
  c = await prisma.$transaction((tx) => ensureDerivedStatus(tx, c));
  if (c.status !== 'PENDING_MOVE_OUT' && c.status !== 'AWAITING_INSPECTION') {
    throw new AppError(
      409,
      'CONFLICT',
      `Move-out ${c.caseNumber} can no longer be reversed (status ${c.status}).`,
    );
  }
  assertFreshVersion(c.version, input.expectedVersion, 'move-out case');
  const correlationId = newCorrelationId();
  // D5: the reversal records its own requester; approval itself is A4.
  const saved = await prisma.$transaction(async (tx) => {
    const row = (await tx.moveOutCase.update({
      where: { id: c.id },
      data: {
        status: 'REVERSED',
        reversedAt: new Date(),
        reversedBy: actor.slice(0, 120),
        reversalReason: input.reason.trim(),
        version: c.version + 1,
      },
      include: CASE_INCLUDE,
    })) as CaseRow;
    const tenant = await tx.tenant.findUnique({ where: { id: c.tenantId } });
    if (tenant && tenant.status === 'NOTICE') {
      await tx.tenant.update({ where: { id: c.tenantId }, data: { status: 'ACTIVE', version: { increment: 1 } } });
      await tx.rentalStatusChange.create({
        data: {
          tenantId: c.tenantId,
          fromStatus: 'NOTICE',
          toStatus: 'ACTIVE',
          reason: `Move-out ${c.caseNumber} reversed — rental restored to Active.`,
          actor: actor.slice(0, 120),
          source: 'move-out-case',
        },
      });
    }
    await tx.recordNote.create({
      data: {
        entityType: 'tenant',
        entityId: c.tenantId,
        body: `Move-out request reversed · ${c.caseNumber}`,
        author: actor.slice(0, 120),
      },
    });
    await writeAuditEvent(tx, {
      branchId: row.branchId,
      actor: actor.slice(0, 120),
      action: 'move_out.reversed',
      entityType: 'MoveOutCase',
      entityId: c.id,
      before: { status: c.status },
      after: { status: 'REVERSED', reversalReason: input.reason.trim() },
      reason: input.reason.trim(),
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'move_out.reversed',
      payload: { caseId: c.id, caseNumber: c.caseNumber },
      branchId: row.branchId,
      correlationId,
    });
    return row;
  });
  return serializeCase(saved);
}

// ---------------------------------------------------------------------------
// Inspection submit (§8.9 — exactly one settlement unless zero)
// ---------------------------------------------------------------------------

export interface InspectionInput {
  unitEmpty: boolean;
  doorLockWallsFloorChecked: boolean;
  accessRevoked: boolean;
  releaseConfirmed: boolean;
  releaseStatus: string;
  earlyTerminationCharge?: number;
  damageCharge?: number;
  cleaningCharge?: number;
  disposalCharge?: number;
  arrearsAmount?: number;
  otherCharge?: number;
  specialCredit?: number;
  notes: string;
  evidenceRefs?: string[];
  expectedVersion?: number;
}

export interface InspectionResult {
  case: SerializedCase;
  inspection: NonNullable<SerializedCase['inspection']>;
  settlement: SerializedCase['settlement'];
  deduplicated: boolean;
}

export async function submitMoveOutInspection(
  id: string,
  input: InspectionInput,
  actor: string,
): Promise<InspectionResult> {
  let c = await loadCase(id);
  c = await prisma.$transaction((tx) => ensureDerivedStatus(tx, c));

  // Idempotent retry: the case's unique settlement link is the dedupe key —
  // a replay returns the first result, never a second Finance record.
  if (c.inspection) {
    const fresh = await loadCase(id);
    return {
      case: serializeCase(fresh),
      inspection: serializeInspection(fresh.inspection)!,
      settlement: serializeCase(fresh).settlement,
      deduplicated: true,
    };
  }
  if (c.status !== 'AWAITING_INSPECTION') {
    if (c.status === 'PENDING_MOVE_OUT') {
      throw new AppError(409, 'CONFLICT', 'Inspection is available only on or after the final access day.');
    }
    throw new AppError(409, 'CONFLICT', `Move-out ${c.caseNumber} can no longer be inspected (status ${c.status}).`);
  }
  // Handoff §8.9 mandatory checklist — all four checks, notes/evidence.
  if (!input.unitEmpty || !input.doorLockWallsFloorChecked || !input.accessRevoked || !input.releaseConfirmed) {
    throw new AppError(400, 'VALIDATION', 'Complete all four release checks before submitting.');
  }
  if (!input.notes?.trim()) {
    throw new AppError(400, 'VALIDATION', 'Inspection notes or evidence are required.');
  }
  if (!(RELEASE_STATUSES as readonly string[]).includes(input.releaseStatus)) {
    throw new AppError(400, 'VALIDATION', 'Choose a unit release status.');
  }
  const nonNeg = (v: number | undefined, label: string): number => {
    if (v === undefined || v === null) return 0;
    if (!Number.isFinite(v) || v < 0) {
      throw new AppError(400, 'VALIDATION', `${label} cannot be negative.`);
    }
    return v;
  };
  const charges = {
    earlyTermination: nonNeg(input.earlyTerminationCharge, 'Early-termination charge'),
    damage: nonNeg(input.damageCharge, 'Damage charge'),
    cleaning: nonNeg(input.cleaningCharge, 'Cleaning charge'),
    disposal: nonNeg(input.disposalCharge, 'Disposal charge'),
    arrears: nonNeg(input.arrearsAmount, 'Outstanding balance'),
    other: nonNeg(input.otherCharge, 'Other charge'),
  };
  const specialCredit = nonNeg(input.specialCredit, 'Approved special credit');
  assertFreshVersion(c.version, input.expectedVersion, 'move-out case');

  const tenantRate = toNum((await prisma.tenant.findUnique({ where: { id: c.tenantId } }))!.monthlyRate);
  const { calc, protectionPaid, commitmentEnd: commitmentEndYmd } = await buildCaseCalc({
    tenantId: c.tenantId,
    unitId: c.unitId,
    finalAccessDate: c.finalAccessDate,
    noticeCompliant: c.noticeCompliant,
    policySnapshot: c.policySnapshot as unknown as MoveoutPolicySnapshot,
    tenantMonthlyRate: tenantRate,
    tenantEmail: c.tenant.email,
    unitCode: c.unit.unitCode,
    inspectionCharges: { ...charges, specialCredit },
  });
  const correlationId = newCorrelationId();
  const cleanActor = actor.slice(0, 120);

  const saved = await prisma.$transaction(async (tx) => {
    const inspection = await tx.moveOutInspection.create({
      data: {
        caseId: c.id,
        unitEmpty: input.unitEmpty,
        doorLockWallsFloorChecked: input.doorLockWallsFloorChecked,
        accessRevoked: input.accessRevoked,
        releaseConfirmed: input.releaseConfirmed,
        releaseStatus: input.releaseStatus,
        earlyTerminationCharge: charges.earlyTermination,
        damageCharge: charges.damage,
        cleaningCharge: charges.cleaning,
        disposalCharge: charges.disposal,
        arrearsAmount: charges.arrears,
        otherCharge: charges.other,
        specialCredit,
        notes: input.notes.trim(),
        evidenceRefs: input.evidenceRefs?.length
          ? (input.evidenceRefs as unknown as Prisma.InputJsonValue)
          : undefined,
        inspector: cleanActor,
      },
    });
    // R12: unit release mapping at inspection time (the tenant link is
    // released only when the case reaches Completed).
    const unitStatus = releaseUnitStatus(input.releaseStatus);
    await tx.unit.update({ where: { id: c.unitId }, data: { status: unitStatus } });
    if (input.releaseStatus === 'CLEANING_REQUIRED' || input.releaseStatus === 'MAINTENANCE_REQUIRED') {
      await tx.workOrder.create({
        data: {
          title: `Post-move-out ${input.releaseStatus === 'MAINTENANCE_REQUIRED' ? 'maintenance' : 'cleaning'} — ${c.unit.unitCode}`,
          description: input.notes.trim().slice(0, 500),
          branchId: c.unit.branchId,
          unitId: c.unitId,
          status: 'OPEN',
        },
      });
    }
    await tx.recordNote.create({
      data: {
        entityType: 'tenant',
        entityId: c.tenantId,
        body:
          `Move-out inspected · ${c.caseNumber} · ${RELEASE_STATUS_LABELS[input.releaseStatus]} · ` +
          `net ${calc.netSettlement >= 0 ? `refund S$${calc.netSettlement.toFixed(2)}` : `charge S$${(-calc.netSettlement).toFixed(2)}`}`,
        author: cleanActor,
      },
    });
    await writeAuditEvent(tx, {
      branchId: c.branchId,
      actor: cleanActor,
      action: 'move_out.inspection_completed',
      entityType: 'MoveOutCase',
      entityId: c.id,
      before: { status: c.status },
      // R13: attestation recorded as actor + time; no gate integration.
      after: { inspectionId: inspection.id, releaseStatus: input.releaseStatus, accessAttestedBy: cleanActor },
      reason: input.notes.trim().slice(0, 200),
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'move_out.inspection_completed',
      payload: { caseId: c.id, caseNumber: c.caseNumber, releaseStatus: input.releaseStatus },
      branchId: c.branchId,
      correlationId,
    });

    const calcSnapshot = {
      calcVersion: MOVEOUT_CALC_VERSION,
      calc,
      policySnapshot: c.policySnapshot,
      inspectionId: inspection.id,
      commitmentEnd: commitmentEndYmd,
      protectionPaid,
      inputs: {
        tenantId: c.tenantId,
        unitId: c.unitId,
        netMonthlyRent: tenantRate,
        depositHeld: 0,
        noticeCompliant: c.noticeCompliant,
        charges,
        specialCredit,
      },
    } as unknown as Prisma.InputJsonValue;

    if (calc.outcome === 'ZERO') {
      // §10.6/R6: zero after calculation → CL- close record, no processor,
      // rental completed and marked Former.
      const settlement = await tx.customerSettlement.create({
        data: {
          ref: await nextSettlementRef(tx, 'CL'),
          kind: 'MOVE_OUT',
          docType: 'Zero settlement',
          tenantId: c.tenantId,
          unitId: c.unitId,
          effectiveDate: c.finalAccessDate,
          channel: c.requestChannel,
          reason: c.reasonCode,
          note: 'Zero settlement — inspection produced no refund or charge. No processor instruction.',
          lines: calc.lines as unknown as Prisma.InputJsonValue,
          amount: 0,
          status: 'CANCELLED',
          requestedBy: cleanActor,
          processedBy: cleanActor,
          processedAt: new Date(),
          origin: 'MOVE_OUT',
          moveOutCaseId: c.id,
          reasonCode: c.reasonCode,
          calcVersion: MOVEOUT_CALC_VERSION,
          calcSnapshot,
        },
      });
      const completed = await completeMoveOutCase(
        tx,
        c.id,
        settlement.id,
        cleanActor,
        correlationId,
        'Zero settlement — inspection produced no refund or charge.',
      );
      await publishFinanceEvent(tx, {
        type: 'move_out.settlement_submitted',
        payload: { caseId: c.id, caseNumber: c.caseNumber, ref: settlement.ref, outcome: 'ZERO' },
        branchId: c.branchId,
        correlationId,
      });
      return { row: completed, settlementId: settlement.id, deduplicated: false as const };
    }

    // Non-zero: exactly one Finance record, case → Settlement review (A4 owns
    // approve → process/post → completed).
    const isRefund = calc.outcome === 'REFUND';
    const settlement = await tx.customerSettlement.create({
      data: {
        ref: await nextSettlementRef(tx, isRefund ? 'RF' : 'CH'),
        kind: 'MOVE_OUT',
        docType: isRefund ? 'Refund' : 'Charge',
        tenantId: c.tenantId,
        unitId: c.unitId,
        effectiveDate: c.finalAccessDate,
        channel: c.requestChannel,
        reason: c.reasonCode,
        lines: calc.lines as unknown as Prisma.InputJsonValue,
        amount: calc.total,
        status: 'PENDING_APPROVAL',
        requestedBy: cleanActor,
        origin: 'MOVE_OUT',
        moveOutCaseId: c.id,
        reasonCode: c.reasonCode,
        calcVersion: MOVEOUT_CALC_VERSION,
        calcSnapshot,
      },
    });
    const row = (await tx.moveOutCase.update({
      where: { id: c.id },
      data: { status: 'SETTLEMENT_REVIEW', version: c.version + 1 },
      include: CASE_INCLUDE,
    })) as CaseRow;
    await writeAuditEvent(tx, {
      branchId: row.branchId,
      actor: cleanActor,
      action: 'move_out.settlement_submitted',
      entityType: 'MoveOutCase',
      entityId: c.id,
      before: { status: 'AWAITING_INSPECTION' },
      after: { status: 'SETTLEMENT_REVIEW', settlementRef: settlement.ref, outcome: calc.outcome },
      reason: `Inspection settlement ${settlement.ref} submitted for Finance approval.`,
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'move_out.settlement_submitted',
      payload: { caseId: c.id, caseNumber: c.caseNumber, ref: settlement.ref, outcome: calc.outcome },
      branchId: row.branchId,
      correlationId,
    });
    return { row, settlementId: settlement.id, deduplicated: false as const };
  });

  const fresh = await loadCase(saved.row.id);
  const withCtx = serializeCase(fresh, { commitmentEnd: commitmentEndYmd, protectionPaid });
  return {
    case: withCtx,
    inspection: serializeInspection(fresh.inspection)!,
    settlement: withCtx.settlement,
    deduplicated: saved.deduplicated,
  };
}

// ---------------------------------------------------------------------------
// Completion (rental → Former). Zero-settlement path runs it in A3; the
// approve → process/post path (A4) reuses this same function.
// ---------------------------------------------------------------------------

/**
 * Complete a move-out case: release the tenant link, mark the rental Former,
 * record history + status audit. Exported for A4 (approved refund processed /
 * charge posted). Runs inside the caller's transaction.
 */
export async function completeMoveOutCase(
  tx: Prisma.TransactionClient,
  caseId: string,
  settlementId: string,
  actor: string,
  correlationId: string,
  reason: string,
): Promise<CaseRow> {
  const c = (await tx.moveOutCase.findUnique({
    where: { id: caseId },
    include: { ...CASE_INCLUDE, tenant: { include: { invoices: true } } },
  })) as (CaseRow & { tenant: CaseRow['tenant'] & { invoices: { id: string; amount: unknown; amountPaid: unknown }[] } }) | null;
  if (!c) throw new AppError(404, 'NOT_FOUND', `Move-out case ${caseId} not found`);
  const tenant = await tx.tenant.findUnique({ where: { id: c.tenantId } });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', `Customer ${c.tenantId} not found`);

  // R13: attestation was recorded at inspection; completion revokes access.
  await tx.tenant.update({
    where: { id: c.tenantId },
    data: {
      status: 'INACTIVE',
      unitId: null,
      accessRestricted: true,
      accessRestrictedAt: new Date(),
      accessRestrictedReason: 'Move-out completed — access ended with the final access day.',
      version: { increment: 1 },
    },
  });
  // R12: the unit release mapping applied at inspection; re-assert here so a
  // completion without an inspection-time update still converges.
  if (c.inspection) {
    await tx.unit.update({
      where: { id: c.unitId },
      data: { status: releaseUnitStatus(c.inspection.releaseStatus) },
    });
  }
  const invoices = await tx.invoice.findMany({
    where: { tenantId: c.tenantId, unitId: c.unitId },
    select: { amount: true, amountPaid: true },
  });
  const monthsBilled = invoices.length;
  const totalBilled = invoices.reduce((n, i) => n + toNum(i.amountPaid ?? i.amount), 0);
  const rate = toNum(tenant.monthlyRate);
  await tx.rentalUnitHistory.create({
    data: {
      tenantId: c.tenantId,
      unitId: c.unitId,
      startedAt: tenant.moveInDate ?? tenant.createdAt,
      endedAt: c.finalAccessDate,
      endReason: 'MOVE_OUT',
      pricingSnapshot: {
        monthlyRate: rate,
        psf: toNum(tenant.psf),
        caseNumber: c.caseNumber,
      } as unknown as Prisma.InputJsonValue,
      billedTotals: { monthsBilled, totalBilled } as unknown as Prisma.InputJsonValue,
      sourceSettlementId: settlementId,
    },
  });
  await tx.rentalStatusChange.create({
    data: {
      tenantId: c.tenantId,
      fromStatus: tenant.status,
      toStatus: 'INACTIVE',
      accessRestricted: true,
      reason: `Move-out ${c.caseNumber} completed — rental is Former.`,
      actor: actor.slice(0, 120),
      source: 'move-out-case',
    },
  });
  await tx.recordNote.create({
    data: {
      entityType: 'tenant',
      entityId: c.tenantId,
      body: `Move-out completed · ${c.caseNumber} · rental is Former, no future deduction`,
      author: actor.slice(0, 120),
    },
  });
  const row = (await tx.moveOutCase.update({
    where: { id: caseId },
    data: { status: 'COMPLETED', version: c.version + 1 },
    include: CASE_INCLUDE,
  })) as CaseRow;
  await writeAuditEvent(tx, {
    branchId: row.branchId,
    actor: actor.slice(0, 120),
    action: 'move_out.completed',
    entityType: 'MoveOutCase',
    entityId: caseId,
    before: { status: c.status },
    after: { status: 'COMPLETED', settlementId },
    reason,
    source: 'move-out-case',
    correlationId,
  });
  await publishFinanceEvent(tx, {
    type: 'move_out.completed',
    payload: { caseId, caseNumber: c.caseNumber, settlementId },
    branchId: row.branchId,
    correlationId,
  });
  return row;
}

// ---------------------------------------------------------------------------
// Portal bridge (R2)
// ---------------------------------------------------------------------------

export interface PortalNoticeRef {
  id: string;
  tenantId: string;
  unitId: string;
  lastDay: Date;
}

/**
 * Keeps the portal Notice as the submission record and additionally creates
 * or updates the MoveOutCase (channel `Customer portal`, portal date
 * prefilled+locked as today SG). An open case + a new portal date becomes a
 * MoveOutDateChange with reason `Customer portal update`. Never throws —
 * callers treat this as a best-effort side effect so the portal response
 * stays byte-identical.
 */
export async function syncPortalNotice(n: PortalNoticeRef, actor: string): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: n.tenantId },
    include: { unit: true },
  });
  if (!tenant || tenant.unitId !== n.unitId || !tenant.unit) return;
  const todayYmd = sgCalendarDate(new Date());
  const portalYmd = toYmd(n.lastDay);
  // A portal date before today cannot drive a case (§8.3) — legacy Notice only.
  if (portalYmd < todayYmd) return;

  const open = (await prisma.moveOutCase.findFirst({
    where: { tenantId: tenant.id, unitId: n.unitId, status: { in: ['PENDING_MOVE_OUT', 'AWAITING_INSPECTION'] } },
    include: CASE_INCLUDE,
  })) as CaseRow | null;
  if (!open) {
    await createMoveOutCase({
      tenantId: tenant.id,
      finalAccessDate: portalYmd,
      requestReceivedAt: todayYmd,
      requestChannel: 'Customer portal',
      reasonCode: 'Other',
      createdBy: actor,
      noticeId: n.id,
    });
    return;
  }
  if (toYmd(open.finalAccessDate) !== portalYmd) {
    await changeMoveOutDate(
      open.id,
      { finalAccessDate: portalYmd, reason: 'Customer portal update', byCustomer: true, noticeId: n.id },
      actor,
      { skipPolicyGate: true },
    );
    return;
  }
  if (!open.noticeId) {
    await prisma.moveOutCase.update({ where: { id: open.id }, data: { noticeId: n.id } });
  }
}
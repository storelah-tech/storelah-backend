// Rental status editor (Track A, phase A6, handoff §7, R5).
//
// Operator-facing per-rental status transitions with a mandatory reason,
// optimistic locking (Tenant.version, 409 STALE) and an immutable audit
// trail (RentalStatusChange + RecordNote + FinanceAuditEvent). RBAC rides on
// customer-tenants:update (routePermissions.ts); no openapi.ts entry
// (no-entry precedent).
//
// Handoff §7 safeguard (verbatim, returned on every write and enforced in
// code): a status change alone NEVER creates a refund, ends access or
// releases a unit — unitId, Unit.status, invoices and ledger lines are
// untouched here. The move-out workflow (moveOutService.completeMoveOutCase)
// is the only path that ends a rental.

import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { currentBranchScope } from '../../lib/facilityScope';
import { writeAuditEvent } from '../finance/audit';
import { publishFinanceEvent } from '../finance/events';
import { assertFreshVersion, newCorrelationId } from '../finance/idempotency';
import { normalizeEmail } from '../customers';

/** Handoff §7 editable rental statuses (operator-facing labels). */
export const RENTAL_EDITOR_STATUSES = [
  'ACTIVE',
  'PENDING_MOVE_OUT',
  'PAYMENT_ATTENTION',
  'ACCESS_RESTRICTED',
  'SUSPENDED',
  'FORMER_CUSTOMER',
] as const;

export type RentalEditorStatus = (typeof RENTAL_EDITOR_STATUSES)[number];

export const RENTAL_EDITOR_STATUS_LABELS: Record<RentalEditorStatus, string> = {
  ACTIVE: 'Active',
  PENDING_MOVE_OUT: 'Pending move-out',
  PAYMENT_ATTENTION: 'Payment attention',
  ACCESS_RESTRICTED: 'Access restricted',
  SUSPENDED: 'Suspended',
  FORMER_CUSTOMER: 'Former customer',
};

/** Handoff §7 exact safeguard copy — enforced, not decorative. */
export const STATUS_SAFEGUARD_COPY =
  'Use the move-out workflow to schedule dates and settlement. A status change alone never creates a refund, ends access or releases a unit.';

/** Open settlement statuses that block a direct Former-customer edit. */
const OPEN_SETTLEMENT_STATUSES = [
  'PENDING', // legacy open
  'PENDING_APPROVAL',
  'CHANGES_REQUESTED',
  'APPROVED',
  'PROCESSING',
];

export interface StatusChangeInput {
  status: RentalEditorStatus;
  /** Mandatory reason (handoff §7) — written to the audit trail. */
  reason: string;
  expectedVersion?: number;
}

export interface StatusChangeResult {
  tenantId: string;
  fromStatus: string;
  toStatus: RentalEditorStatus;
  toStatusLabel: string;
  tenantStatus: string;
  accessRestricted: boolean;
  version: number;
  safeguard: string;
}

/** Display status for one rental (handoff §7 editor vocabulary). */
export function displayRentalStatus(status: string, accessRestricted: boolean): RentalEditorStatus {
  if (status === 'INACTIVE') return 'FORMER_CUSTOMER';
  if (status === 'SUSPENDED') return 'SUSPENDED';
  if (accessRestricted) return 'ACCESS_RESTRICTED';
  if (status === 'NOTICE') return 'PENDING_MOVE_OUT';
  if (status === 'OVERDUE' || status === 'DUE_SOON') return 'PAYMENT_ATTENTION';
  return 'ACTIVE';
}

/**
 * Derived overall customer status across every rental in the identity group
 * (handoff §7 roll-up rule): every rental Former → Former; else any Active →
 * Active; else any Pending move-out → Pending; else the most relevant
 * remaining controlled status (Suspended > Access restricted > Payment
 * attention > Former).
 */
export function deriveCustomerStatus(rentals: Array<{ status: string; accessRestricted: boolean }>): RentalEditorStatus {
  if (rentals.length === 0) return 'FORMER_CUSTOMER';
  const display = rentals.map((r) => displayRentalStatus(r.status, r.accessRestricted));
  if (display.every((d) => d === 'FORMER_CUSTOMER')) return 'FORMER_CUSTOMER';
  if (display.includes('ACTIVE')) return 'ACTIVE';
  if (display.includes('PENDING_MOVE_OUT')) return 'PENDING_MOVE_OUT';
  if (display.includes('SUSPENDED')) return 'SUSPENDED';
  if (display.includes('ACCESS_RESTRICTED')) return 'ACCESS_RESTRICTED';
  if (display.includes('PAYMENT_ATTENTION')) return 'PAYMENT_ATTENTION';
  return 'FORMER_CUSTOMER';
}

export async function setRentalStatus(
  tenantId: string,
  input: StatusChangeInput,
  actor: string,
  source = 'cms',
): Promise<StatusChangeResult> {
  const cleanActor = actor.slice(0, 120);
  if (!input.reason?.trim()) {
    throw new AppError(400, 'VALIDATION', 'A reason is required to change the rental status.');
  }
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId },
    include: { unit: { select: { id: true, branchId: true } } },
  });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', `Customer ${tenantId} not found`);
  // Facility scope (repo convention: out-of-scope reads as not found).
  const scope = currentBranchScope();
  if (scope) {
    const branchId = tenant.unit?.branchId ?? tenant.branchId;
    if (branchId && !scope.includes(branchId)) {
      throw new AppError(404, 'NOT_FOUND', `Customer ${tenantId} not found`);
    }
  }
  assertFreshVersion(tenant.version, input.expectedVersion, 'rental');

  // A-20: Pending move-out and Former customer come only from the move-out
  // workflow while the rental still holds a unit. A direct status edit sets
  // NOTICE with no MoveOutCase, so reject it here with the §7 safeguard copy
  // (same wording as the Former-customer rejection).
  if ((input.status === 'PENDING_MOVE_OUT' || input.status === 'FORMER_CUSTOMER') && tenant.unitId) {
    throw new AppError(409, 'CONFLICT', `Rental still holds a unit — ${STATUS_SAFEGUARD_COPY}`);
  }

  // Former-customer guards: the editor must never strand an active sibling,
  // an open move-out case or an open settlement — those close through the
  // move-out / Finance workflows, never through a status edit.
  if (input.status === 'FORMER_CUSTOMER') {
    const email = tenant.email ? normalizeEmail(tenant.email) : null;
    if (email) {
      const sibling = await prisma.tenant.findFirst({
        where: { id: { not: tenant.id }, email: { equals: email, mode: 'insensitive' }, status: { not: 'INACTIVE' } },
        select: { id: true },
      });
      if (sibling) {
        throw new AppError(409, 'CONFLICT', `Another rental for this customer is still active — ${STATUS_SAFEGUARD_COPY}`);
      }
    }
    const openCase = await prisma.moveOutCase.findFirst({
      where: { tenantId, status: { notIn: ['COMPLETED', 'REVERSED'] } },
      select: { caseNumber: true },
    });
    if (openCase) {
      throw new AppError(409, 'CONFLICT', `${openCase.caseNumber} is still open — ${STATUS_SAFEGUARD_COPY}`);
    }
    const openSettlement = await prisma.customerSettlement.findFirst({
      where: { tenantId, status: { in: OPEN_SETTLEMENT_STATUSES } },
      select: { ref: true },
    });
    if (openSettlement) {
      throw new AppError(409, 'CONFLICT', `${openSettlement.ref} is still awaiting Finance — ${STATUS_SAFEGUARD_COPY}`);
    }
  }

  const fromStatus = displayRentalStatus(tenant.status, tenant.accessRestricted);
  const now = new Date();
  // Safeguard: only the status marker + restriction flag move. unitId,
  // Unit.status, invoices and ledger lines are never touched here.
  const data: Record<string, unknown> =
    input.status === 'ACTIVE'
      ? { status: 'ACTIVE', accessRestricted: false, accessRestrictedAt: null, accessRestrictedReason: null }
      : input.status === 'PENDING_MOVE_OUT'
        ? { status: 'NOTICE' }
        : input.status === 'PAYMENT_ATTENTION'
          ? { status: 'OVERDUE' }
          : input.status === 'ACCESS_RESTRICTED'
            ? { accessRestricted: true, accessRestrictedAt: now, accessRestrictedReason: input.reason.trim().slice(0, 500) }
            : input.status === 'SUSPENDED'
              ? { status: 'SUSPENDED' }
              : { status: 'INACTIVE' };
  data.version = { increment: 1 };

  const correlationId = newCorrelationId();
  const saved = await prisma.$transaction(async (tx) => {
    const updated = await tx.tenant.update({ where: { id: tenantId, version: tenant.version }, data });
    await tx.rentalStatusChange.create({
      data: {
        tenantId,
        fromStatus,
        toStatus: updated.status,
        accessRestricted: updated.accessRestricted,
        reason: input.reason.trim(),
        actor: cleanActor,
        source,
      },
    });
    await tx.recordNote.create({
      data: {
        entityType: 'tenant',
        entityId: tenantId,
        body: `Rental status changed · ${RENTAL_EDITOR_STATUS_LABELS[fromStatus]} → ${RENTAL_EDITOR_STATUS_LABELS[input.status]} · ${input.reason.trim()}`,
        author: cleanActor,
      },
    });
    await writeAuditEvent(tx, {
      branchId: tenant.unit?.branchId ?? tenant.branchId,
      actor: cleanActor,
      action: 'rental.status_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      before: { status: tenant.status, accessRestricted: tenant.accessRestricted, version: tenant.version },
      after: { status: updated.status, accessRestricted: updated.accessRestricted, version: updated.version },
      reason: input.reason.trim().slice(0, 200),
      source,
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'rental.status_changed',
      payload: { tenantId, fromStatus, toStatus: updated.status, actor: cleanActor },
      branchId: tenant.unit?.branchId ?? tenant.branchId,
      correlationId,
    });
    return updated;
  });

  return {
    tenantId,
    fromStatus,
    toStatus: input.status,
    toStatusLabel: RENTAL_EDITOR_STATUS_LABELS[input.status],
    tenantStatus: saved.status,
    accessRestricted: saved.accessRestricted,
    version: saved.version,
    safeguard: STATUS_SAFEGUARD_COPY,
  };
}

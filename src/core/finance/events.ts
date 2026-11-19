// Finance outbox (FINANCE_MODULE_SPEC §21).
//
// Every domain event carries eventId, eventType, occurredAt, actor/system,
// facilityId, entityType, entityId, correlationId, causationId, sourceVersion
// plus a payload — and every consumer MUST be idempotent (spec §21).
//
// Phase 1 transport: same-transaction DB writes only. Consumers are
// synchronous recalculation or idempotent-on-read; there is no EventBridge,
// no DLQ, no background worker (CMS-triggered endpoints only). The
// status/attempts columns exist so Phase 4 can add a sweeper without
// reshaping the table.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export const FINANCE_EVENT_TYPES = [
  'model.updated',
  'model.version.saved',
  'model.submitted',
  'model.approved',
  'model.version.loaded',
  'inventory.snapshot.linked',
  'size.mix.updated',
  'scenario.applied',
  'budget.updated',
  'expense.recorded',
  'invoice.generated',
  'invoice.issued',
  'invoice.written.off',
  'payment.instruction.created',
  'payment.approved',
  'payment.submitted',
  'payment.succeeded',
  'payment.failed',
  'credit.issued',
  'credit.applied',
  'refund.calculated',
  'refund.approved',
  'refund.rejected',
  'refund.bank.verified',
  'refund.succeeded',
  // Track A move-out/manual settlement finance (phase A4, handoff §18):
  // change-request round-trip, terminal processing, charge posting.
  'refund.changes_requested',
  'refund.processed',
  'charge.posted',
  'refund.converted.to.charge',
  'reconciliation.item.matched',
  'reconciliation.batch.closed',
  'month.close.started',
  'actuals.posted',
  'close.adjustment.posted',
  'late.fee.posted',
  'late.fee.waived',
  'arrears.case.opened',
  'arrears.case.advanced',
  'arrears.access.restricted',
  'arrears.case.resolved',
  'export.generated',
  // Track A move-out workflow (phase A3, handoff §18): one event per case
  // transition, published in the same transaction as the mutation.
  'move_out.requested',
  'move_out.date_changed',
  'move_out.reversed',
  'move_out.inspection_completed',
  'move_out.settlement_submitted',
  'move_out.completed',
  'move_out.auto_advanced',
  // Track A unit transfers (phase A5, handoff §§11/13/18): one event per
  // transfer step — request/approve/execute(=complete) plus the Finance
  // change-request round-trip. Same-transaction outbox, same as above.
  'transfer.requested',
  'transfer.changes_requested',
  'transfer.corrected',
  'transfer.approved',
  'transfer.executed',
  // Track A rental status editor (phase A6, handoff §13 timeline): every
  // status edit publishes one event in the same transaction as the mutation.
  'rental.status_changed',
  // Settings › Move-outs & refunds (A-19, handoff §14): every changed policy
  // key publishes one event in the same transaction as the upsert.
  'business_rule.updated',
  // Lease-horizon P4: committed lease term updated (handoff §6.1).
  'financial_model.lease_horizon.updated',
  // Master Rate Strategy (Track B, B3 — handoff §18): version lifecycle,
  // batch lifecycle, manual-rate preservation and the due-batch sweep.
  'rate.strategy.created',
  'rate.strategy.updated',
  'rate.strategy.submitted',
  'rate.strategy.approved',
  'rate.strategy.rejected',
  'rate.strategy.superseded',
  'rate.strategy.duplicated',
  'rate.batch.created',
  'rate.batch.applied',
  'rate.batch.partially_applied',
  'rate.batch.failed',
  'rate.batch.cancelled',
  'rate.batch.retried',
  'rate.unit.preserved_manual',
  'rate.due_batches.applied',
] as const;

export type FinanceEventType = (typeof FINANCE_EVENT_TYPES)[number];

export interface FinanceEventWrite {
  type: FinanceEventType | string;
  payload?: unknown;
  branchId?: string | null;
  correlationId: string;
  causationId?: string | null;
}

/** Publishes one outbox row inside the caller's transaction (same commit as
 * the mutation). Consumers are synchronous / idempotent-on-read in Phase 1. */
export async function publishFinanceEvent(
  db: Pick<typeof prisma, 'financeEvent'>,
  e: FinanceEventWrite,
) {
  return db.financeEvent.create({
    data: {
      type: e.type,
      payload: (e.payload ?? {}) as Prisma.InputJsonValue,
      status: 'PENDING',
      branchId: e.branchId ?? null,
      correlationId: e.correlationId,
      causationId: e.causationId ?? null,
    },
  });
}

/** Marks an outbox row consumed. Consumers must be idempotent: re-delivery
 * after a crash replays the same payload with the same correlationId. */
export async function markEventConsumed(id: string) {
  return prisma.financeEvent.update({
    where: { id },
    data: { status: 'CONSUMED', consumedAt: new Date() },
  });
}

/** Marks an outbox row failed (kept visible for operator retry — the Phase 1
 * equivalent of a DLQ is "leave it PENDING/FAILED and show it", never silent). */
export async function markEventFailed(id: string) {
  const row = await prisma.financeEvent.findUnique({ where: { id } });
  if (!row) return null;
  return prisma.financeEvent.update({
    where: { id },
    data: { status: 'FAILED', attempts: row.attempts + 1 },
  });
}

/**
 * Stripe webhook exactly-once guard (spec §§10.6/21.1). Records the processor
 * event id BEFORE any allocation runs; a duplicate delivery with the same id
 * hits the primary key and returns false (caller answers applied:false).
 * Race-safe: the losers of a concurrent double-delivery both see the
 * conflict. Pass the caller's transaction client to roll the claim back with
 * the writes on crash; pass the global client for the standalone path.
 * Callers without an event id (unit-level core calls, never the HTTP
 * webhook) skip the claim and rely on conditional writes instead.
 */
export async function claimStripeEvent(
  db: Pick<typeof prisma, 'processedStripeEvent'>,
  eventId: string,
  type: string,
): Promise<boolean> {
  try {
    await db.processedStripeEvent.create({ data: { eventId, type } });
    return true;
  } catch (e) {
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') return false;
    throw e;
  }
}

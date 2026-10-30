// Finance audit trail (FINANCE_MODULE_SPEC §§6/16.5 + principle 4).
//
// Append-only: this module exposes a single writer and read-only queries.
// There is deliberately NO update/delete function — corrections are new
// events with their own correlationId. Every mutation records actor,
// timestamp (occurredAt), before/after, reason, source and correlationId.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export interface AuditWrite {
  branchId?: string | null;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  source?: string;
  correlationId: string;
}

function toJson(v: unknown): Prisma.InputJsonValue | undefined {
  if (v === undefined) return undefined;
  return v as Prisma.InputJsonValue;
}

/** Writes one audit event. Pass the caller's transaction client to keep the
 * event in the same commit as the mutation it describes. */
export async function writeAuditEvent(
  db: Pick<typeof prisma, 'financeAuditEvent'>,
  e: AuditWrite,
) {
  return db.financeAuditEvent.create({
    data: {
      branchId: e.branchId ?? null,
      actor: e.actor,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      before: toJson(e.before),
      after: toJson(e.after),
      reason: e.reason ?? null,
      source: e.source ?? null,
      correlationId: e.correlationId,
    },
  });
}

export interface AuditQuery {
  entityType?: string;
  entityId?: string;
  correlationId?: string;
  branchId?: string;
  limit?: number;
}

/** Read-only audit query (GET /finance/audit). No mutation path exists. */
export async function queryAuditEvents(q: AuditQuery) {
  const rows = await prisma.financeAuditEvent.findMany({
    where: {
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.correlationId ? { correlationId: q.correlationId } : {}),
    },
    orderBy: { occurredAt: 'desc' },
    take: Math.min(Math.max(q.limit ?? 100, 1), 500),
  });
  return rows.map((r) => ({
    id: r.id,
    branchId: r.branchId,
    actor: r.actor,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    before: r.before,
    after: r.after,
    reason: r.reason,
    source: r.source,
    correlationId: r.correlationId,
    occurredAt: r.occurredAt,
  }));
}

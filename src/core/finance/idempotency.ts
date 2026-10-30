// Optimistic-lock + idempotency-key helpers for finance mutations
// (FINANCE_MODULE_SPEC §§10.6/11.7/21.1/23.1).
//
// Every finance mutation route takes an `Idempotency-Key` header and an
// expected entity `version`. Approval (and every other state transition)
// fails safely when the underlying record changed after the operator opened
// it — compare-and-swap, 409 on stale, never a lost update.
//
// Phase 1 scope: pure helpers + the FinanceEvent outbox (same-transaction
// dedupe key in Phase 3 tables). Per-key persisted enforcement lands with
// the Phase 3 tables that carry idempotencyKey columns.

import { randomUUID } from 'node:crypto';
import { AppError } from '../../lib/http';

/** Idempotency-Key header value, or null when the caller sent none. */
export function getIdempotencyKey(headers: Record<string, unknown>): string | null {
  const raw = headers['idempotency-key'] ?? headers['Idempotency-Key'];
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v ? v : null;
}

/** Fresh correlation ID linking every event in one causal chain (§21). */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Compare-and-swap guard: throws 409 STALE when the stored version moved
 * since the operator read it. The caller keeps the user's inputs so the UI
 * can offer compare / reload / new-draft (§11.7 update-conflict contract).
 */
export function assertFreshVersion(current: number, expected: number | undefined, entityLabel: string): void {
  if (expected === undefined) return; // reads and version-less callers skip
  if (!Number.isInteger(expected)) {
    throw new AppError(400, 'VALIDATION', `Expected version for ${entityLabel} must be an integer.`);
  }
  if (current !== expected) {
    throw new AppError(409, 'STALE', `${entityLabel} changed since you opened it (version ${expected} is stale, current is ${current}). Reload and retry.`, {
      entity: entityLabel,
      expected,
      current,
    });
  }
}

/** Next version after a successful compare-and-swap write. */
export function nextVersion(current: number): number {
  return current + 1;
}

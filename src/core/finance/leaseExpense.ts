// Single shared lease-reader for downstream consumers (lease horizon P5).
//
// Given a model's stored inputs + a calendar month (YYYY-MM), this returns the
// COMMITTED lease expense from the ENGINE ROWS — never a re-derivation. Every
// downstream reader (budgets lease line, month-close actuals, performance
// budget line) calls this one function, so the lease is counted ONCE and every
// screen agrees with the projection (LH11).
//
// Semantics:
// - Month before the model's timeline start (or no model) → null (no lease
//   applies; callers keep their pre-start copy).
// - Month inside the committed term → the engine row's `opexLease` (SGD,
//   cents-rounded; prorated stubs, rent-free windows and pre-opening D6B rent
//   included exactly as projected — zero rent-free months, mid-month starts
//   and pre-opening rows included).
// - Month after the committed end → 0 (the committed term is over; no lease
//   is carried forward — shortening the term moves the end, never the history).
//
// First-of-month models without surprises read back the exact schedule rent,
// so the R14 lock holds: for a plain v1/v2 first-of-month model this equals
// the legacy `monthlyByYear` lookup (including whole-month rent-free zeros).

import { AppError } from '../../lib/http';
import { project, type ProjectionInput } from './projection';

export interface CommittedScheduleRow {
  leaseYear: number;
  periodStart: string;
  periodEnd: string;
  monthlyRent: number;
  source: string;
}

/**
 * Committed lease expense (SGD) for one calendar month, read from the engine
 * rows. Null = the month precedes the model timeline (no lease applies).
 */
export function committedLeaseForMonth(inputs: ProjectionInput, fiscalMonth: string): number | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(fiscalMonth)) {
    throw new AppError(400, 'VALIDATION', `fiscalMonth must be YYYY-MM, got ${fiscalMonth}.`);
  }
  const result = project(inputs);
  const months = result.months;
  if (!months.length) return null;
  if (fiscalMonth < months[0].month) return null;
  const row = months.find((m) => m.month === fiscalMonth);
  if (!row) return 0;
  return row.opexLease;
}

/**
 * The committed lease schedule for Year-N tables: the v2 block's active rows
 * (period-dated, shortened-term rows already excluded). Null for legacy v1
 * models — those readers keep their `monthlyByYear` table (legacy output is
 * never rewritten with a substituted schedule).
 */
export function committedScheduleOf(inputs: ProjectionInput): CommittedScheduleRow[] | null {
  const lease = (inputs as unknown as { lease?: Record<string, unknown> }).lease;
  const schedule = lease?.schedule;
  if (!Array.isArray(schedule)) return null;
  return (schedule as Array<Record<string, unknown>>)
    .filter((r) => !r.excluded)
    .map((r) => ({
      leaseYear: r.leaseYear as number,
      periodStart: r.periodStart as string,
      periodEnd: r.periodEnd as string,
      monthlyRent: r.monthlyRent as number,
      source: r.source as string,
    }))
    .sort((a, b) => a.leaseYear - b.leaseYear);
}

// Lease-horizon dates & schedule helpers (P1 — R1, R2, D1, D2, D3, D6).
//
// PURE module: no DB, no clock, no imports from routes/models. All dates are
// `YYYY-MM-DD` strings interpreted in pure UTC (calendar arithmetic only —
// never the local-timezone `Date` constructor). All money math uses
// unrounded factors; only the payable row total is rounded to SGD cents
// (owner D12A; rounding itself is asserted on the P2 engine path).
//
// CANONICAL PATH NOTE: the lane brief names this file `leaseTerm.ts`; the P0
// plan (LEASE_HORIZON_PLAN.md §7, P1 bullet) sketched the same module as
// `leaseDates.ts`. `leaseDates.ts` was never created — this file IS that
// module under the brief's canonical name. Do not create `leaseDates.ts`.
//
// OWNER OVERRIDES (2026-11-09, OVERRIDE the handoff brief on conflict):
// - D1B over brief R1: end date = day-before-anniversary when the nominal day
//   exists in the target month, else the last day of the target month
//   (29 Feb 2028 + 12mo ends 28 Feb 2029, NOT 27 Feb).
// - D6B over PLAN D6: lease_commencement_date and operational_start_date stay
//   SEPARATE; the financial timeline begins at the EARLIER date and rows
//   before operational opening carry `isPreOpening` (label support only here —
//   no consumer edits in P1; revenue/occupancy gating is a P2 consumer job).
// - D3-audit: upcastInputs() preserves the legacy whole-month rentFreeMonths
//   value in the result for the P4/P5 audit record (no audit writes in P1).
//
// DEFERRED (not in P1): D9B permission keys `finance.models.export` and
// `finance.models.view_audit` are noted here for the P4 wiring; this module
// wires NO permissions. R14 lock: ENGINE_VERSION stays `finance-projection/1`
// and `finance-projection-golden.json` must remain UNMODIFIED (P2 owns v2).

import { AppError } from '../../lib/http';

export type ProrationMethod = 'actual_days' | '30_day' | 'full_month';

export const ENGINE_TERM_MIN_MONTHS = 1;
export const ENGINE_TERM_MAX_MONTHS = 120;
export const ENGINE_MAX_ROWS = 121; // N + 1 for a mid-month start (R2)

export interface CalendarRow {
  calendarMonth: string; // YYYY-MM
  daysInMonth: number;
  periodStart: string; // YYYY-MM-DD (start date for the first row, else 1st)
  periodEnd: string; // YYYY-MM-DD (end date for the last row, else month end)
}

export interface LeaseYear {
  leaseYear: number; // 1-based
  periodStart: string; // anniversary start (inclusive)
  periodEnd: string; // capped at the committed end date (inclusive)
}

export interface RentFreePeriod {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD (inclusive)
  /** P4 hook: per-component treatment (e.g. base rent vs service charges).
   * Accepted and carried through in P1; no per-component rules enforced yet. */
  appliesTo?: string;
}

export interface ChargeableSegment {
  leaseYear: number;
  segmentStart: string;
  segmentEnd: string;
  days: number; // calendar days of this segment inside the row
  chargeableDays: number; // days minus rent-free overlap
  rentFreeDays: number;
  daysInMonth: number;
}

export interface PricedSegment extends ChargeableSegment {
  monthlyRent: number;
}

export interface SegmentExpense {
  leaseYear: number;
  chargeableDays: number;
  factor: number; // UNROUNDED period factor for this segment
  amount: number; // UNROUNDED rent × factor
}

export interface LeaseExpense {
  payableCents: number; // SGD cents (rounded — the only rounded value here)
  factor: number; // UNROUNDED row-level factor (informational on straddles)
  chargeableDays: number;
  daysInMonth: number;
  segments: SegmentExpense[];
}

export type ScheduleSource = 'contract' | 'user_entered' | 'estimated';

export interface LeaseScheduleRow {
  leaseYear: number;
  periodStart: string;
  periodEnd: string;
  monthlyRent: number;
  source: ScheduleSource;
  confirmed: boolean;
}

// ---------- date primitives (pure UTC calendar arithmetic) ----------

interface Ymd {
  y: number;
  m1: number;
  d: number;
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toISO(y: number, m1: number, d: number): string {
  return `${y}-${pad2(m1)}-${pad2(d)}`;
}

/** Strict `YYYY-MM-DD` parse; throws 400 VALIDATION on bad shape or dates. */
export function parseISODate(s: string, label = 'date'): Ymd {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new AppError(400, 'VALIDATION', `${label} must be YYYY-MM-DD, got ${s}.`);
  const y = Number(m[1]);
  const m1 = Number(m[2]);
  const d = Number(m[3]);
  if (m1 < 1 || m1 > 12 || d < 1 || d > daysInMonth(y, m1)) {
    throw new AppError(400, 'VALIDATION', `${label} is not a calendar date: ${s}.`);
  }
  return { y, m1, d };
}

/** Whole-day difference b − a (b >= a expected by callers). */
export function diffDays(aISO: string, bISO: string): number {
  const a = parseISODate(aISO, 'start date');
  const b = parseISODate(bISO, 'end date');
  return Math.round((Date.UTC(b.y, b.m1 - 1, b.d) - Date.UTC(a.y, a.m1 - 1, a.d)) / 86400000);
}

export function addDaysISO(iso: string, n: number): string {
  const p = parseISODate(iso, 'date');
  const t = new Date(Date.UTC(p.y, p.m1 - 1, p.d + n));
  return toISO(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * Shift a date by N months, clamping the day to the target month's last day.
 * This is the clamped ANNIVERSARY (no minus-one-day); committedEndDate()
 * applies the D1B end-date rule on top.
 */
export function addMonthsForLeaseEnd(startISO: string, months: number): string {
  const p = parseISODate(startISO, 'lease start date');
  if (!Number.isInteger(months)) {
    throw new AppError(400, 'VALIDATION', 'Term months must be a whole number.');
  }
  const total = p.y * 12 + (p.m1 - 1) + months;
  const ty = Math.floor(total / 12);
  const tm1 = (total % 12) + 1;
  return toISO(ty, tm1, Math.min(p.d, daysInMonth(ty, tm1)));
}

function assertEngineTerm(termMonths: number): void {
  if (!Number.isInteger(termMonths) || termMonths < ENGINE_TERM_MIN_MONTHS || termMonths > ENGINE_TERM_MAX_MONTHS) {
    throw new AppError(
      400,
      'VALIDATION',
      `Term must be a whole number of months ${ENGINE_TERM_MIN_MONTHS}–${ENGINE_TERM_MAX_MONTHS} (engine limit).`,
    );
  }
}

/**
 * D1B committed end date (inclusive): day-before-anniversary when the nominal
 * start day exists in the target month, else the target month's last day.
 * Pure UTC — no local-time `Date` behaviour.
 */
export function committedEndDate(startISO: string, termMonths: number): string {
  assertEngineTerm(termMonths);
  const p = parseISODate(startISO, 'lease start date');
  const total = p.y * 12 + (p.m1 - 1) + termMonths;
  const ty = Math.floor(total / 12);
  const tm1 = (total % 12) + 1;
  const dimT = daysInMonth(ty, tm1);
  if (p.d <= dimT) return addDaysISO(toISO(ty, tm1, p.d), -1);
  return toISO(ty, tm1, dimT);
}

/** R2: one row per calendar month from the start month through the end month. */
export function buildCalendarRows(startISO: string, endISO: string): CalendarRow[] {
  const s = parseISODate(startISO, 'lease start date');
  const e = parseISODate(endISO, 'lease end date');
  if (endISO < startISO) {
    throw new AppError(400, 'VALIDATION', `Lease end date ${endISO} is before start date ${startISO}.`);
  }
  const rows: CalendarRow[] = [];
  let y = s.y;
  let m1 = s.m1;
  for (;;) {
    const key = `${y}-${pad2(m1)}`;
    const dim = daysInMonth(y, m1);
    const first = key === `${s.y}-${pad2(s.m1)}`;
    const last = y === e.y && m1 === e.m1;
    rows.push({
      calendarMonth: key,
      daysInMonth: dim,
      periodStart: first ? startISO : toISO(y, m1, 1),
      periodEnd: last ? endISO : toISO(y, m1, dim),
    });
    if (last) break;
    m1 += 1;
    if (m1 > 12) {
      m1 = 1;
      y += 1;
    }
    if (rows.length > ENGINE_MAX_ROWS) {
      throw new AppError(400, 'VALIDATION', `Lease spans more than ${ENGINE_MAX_ROWS} calendar rows (engine limit).`);
    }
  }
  return rows;
}

/**
 * Anniversary lease-year boundaries for an N-month term: year k runs from
 * start + (k−1)×12mo to the committed end of a k×12mo term (capped at the
 * full-term end for the final partial year). Contiguous by construction.
 */
export function buildLeaseYears(startISO: string, termMonths: number): LeaseYear[] {
  assertEngineTerm(termMonths);
  parseISODate(startISO, 'lease start date');
  const endISO = committedEndDate(startISO, termMonths);
  const count = Math.ceil(termMonths / 12);
  const years: LeaseYear[] = [];
  for (let k = 1; k <= count; k++) {
    years.push({
      leaseYear: k,
      periodStart: addMonthsForLeaseEnd(startISO, (k - 1) * 12),
      periodEnd: k * 12 >= termMonths ? endISO : committedEndDate(startISO, k * 12),
    });
  }
  return years;
}

/**
 * R3: split a calendar row by lease-year anniversaries and rent-free dates.
 * Every returned segment lies inside the row; Σ days = row calendar days.
 */
export function chargeableSegments(
  row: CalendarRow,
  leaseYears: LeaseYear[],
  rentFree: RentFreePeriod | null,
): ChargeableSegment[] {
  if (rentFree) {
    parseISODate(rentFree.startDate, 'rent-free start date');
    parseISODate(rentFree.endDate, 'rent-free end date');
  }
  const out: ChargeableSegment[] = [];
  for (const ly of leaseYears) {
    const segStart = row.periodStart > ly.periodStart ? row.periodStart : ly.periodStart;
    const segEnd = row.periodEnd < ly.periodEnd ? row.periodEnd : ly.periodEnd;
    if (segEnd < segStart) continue;
    const days = diffDays(segStart, segEnd) + 1;
    let rentFreeDays = 0;
    if (rentFree && rentFree.endDate >= segStart && rentFree.startDate <= segEnd) {
      const fStart = rentFree.startDate > segStart ? rentFree.startDate : segStart;
      const fEnd = rentFree.endDate < segEnd ? rentFree.endDate : segEnd;
      rentFreeDays = diffDays(fStart, fEnd) + 1;
    }
    out.push({
      leaseYear: ly.leaseYear,
      segmentStart: segStart,
      segmentEnd: segEnd,
      days,
      chargeableDays: days - rentFreeDays,
      rentFreeDays,
      daysInMonth: row.daysInMonth,
    });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * R4 lease expense (LANDLORD LEASE only): Σ rent × chargeableDays/daysInMonth
 * per segment. Factors stay UNROUNDED; only `payableCents` is rounded.
 * - `30_day`: per-segment min(chargeableDays, 30) / 30 (capped at 30/30).
 * - `full_month`: whole-month rent when any chargeable day exists (rent of
 *   the segment with the most chargeable days, ties → earliest lease year),
 *   else 0. Row-level by design; segment factors are informational.
 */
export function leaseExpenseForRow(
  row: CalendarRow,
  segments: PricedSegment[],
  method: ProrationMethod,
): LeaseExpense {
  if (method !== 'actual_days' && method !== '30_day' && method !== 'full_month') {
    throw new AppError(400, 'VALIDATION', `Unknown proration method: ${method}.`);
  }
  const totalChargeable = segments.reduce((s, g) => s + g.chargeableDays, 0);
  let detail: SegmentExpense[];
  if (method === 'full_month') {
    let chosen: PricedSegment | null = null;
    for (const g of segments) {
      if (g.chargeableDays <= 0) continue;
      if (!chosen || g.chargeableDays > chosen.chargeableDays) chosen = g;
    }
    detail = segments.map((g) => ({
      leaseYear: g.leaseYear,
      chargeableDays: g.chargeableDays,
      factor: chosen && g === chosen ? 1 : 0,
      amount: chosen && g === chosen ? g.monthlyRent : 0,
    }));
  } else {
    detail = segments.map((g) => {
      const factor = method === 'actual_days' ? g.chargeableDays / row.daysInMonth : Math.min(g.chargeableDays, 30) / 30;
      return { leaseYear: g.leaseYear, chargeableDays: g.chargeableDays, factor, amount: g.monthlyRent * factor };
    });
  }
  const unrounded = detail.reduce((s, d) => s + d.amount, 0);
  const factor =
    method === 'actual_days'
      ? totalChargeable / row.daysInMonth
      : method === '30_day'
        ? Math.min(totalChargeable, 30) / 30
        : totalChargeable > 0
          ? 1
          : 0;
  return { payableCents: round2(unrounded), factor, chargeableDays: totalChargeable, daysInMonth: row.daysInMonth, segments: detail };
}

/** Gap/overlap/coverage check for an editable lease schedule. [] = valid. */
export function validateSchedule(
  schedule: Array<{ leaseYear?: number; periodStart: string; periodEnd: string }>,
  termStartISO: string,
  termEndISO: string,
): string[] {
  const problems: string[] = [];
  parseISODate(termStartISO, 'lease start date');
  parseISODate(termEndISO, 'lease end date');
  const rows = schedule.map((r, i) => {
    try {
      parseISODate(r.periodStart, `schedule row ${i + 1} start`);
      parseISODate(r.periodEnd, `schedule row ${i + 1} end`);
    } catch (e) {
      problems.push(e instanceof AppError ? e.message : `Schedule row ${i + 1} has an invalid date.`);
      return null;
    }
    if (r.periodEnd < r.periodStart) {
      problems.push(`Schedule row ${i + 1} ends before it starts (${r.periodStart}–${r.periodEnd}).`);
    }
    return r;
  });
  if (problems.length) return problems;
  const sorted = [...(rows as Array<{ leaseYear?: number; periodStart: string; periodEnd: string }>)].sort((a, b) =>
    a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0,
  );
  if (sorted.length && sorted[0].periodStart !== termStartISO) {
    problems.push(`Schedule does not start at the lease commencement date ${termStartISO}.`);
  }
  if (sorted.length && sorted[sorted.length - 1].periodEnd !== termEndISO) {
    problems.push(`Schedule does not end at the committed end date ${termEndISO}.`);
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.periodStart <= prev.periodEnd) {
      problems.push(`Schedule rows overlap: ${prev.periodStart}–${prev.periodEnd} and ${cur.periodStart}–${cur.periodEnd}.`);
    } else if (cur.periodStart !== addDaysISO(prev.periodEnd, 1)) {
      problems.push(`Schedule has a gap between ${prev.periodEnd} and ${cur.periodStart}.`);
    }
  }
  return problems;
}

/**
 * Rent-free window must sit inside the committed term. Component-aware stub:
 * `appliesTo` is accepted (base rent vs other landlord charges) but no
 * per-component rules are enforced until P4.
 */
export function validateRentFree(
  rentFree: RentFreePeriod | null,
  termStartISO: string,
  termEndISO: string,
): string[] {
  if (!rentFree) return [];
  parseISODate(termStartISO, 'lease start date');
  parseISODate(termEndISO, 'lease end date');
  parseISODate(rentFree.startDate, 'rent-free start date');
  parseISODate(rentFree.endDate, 'rent-free end date');
  const problems: string[] = [];
  if (rentFree.endDate < rentFree.startDate) {
    problems.push(`Rent-free end ${rentFree.endDate} is before start ${rentFree.startDate}.`);
    return problems;
  }
  if (rentFree.startDate < termStartISO || rentFree.endDate > termEndISO) {
    problems.push(
      `Rent-free period ${rentFree.startDate}–${rentFree.endDate} must be within the lease term ${termStartISO}–${termEndISO}.`,
    );
  }
  return problems;
}

// ---------- v1 → v2 upcast (PLAN §6; read-path only, never writes history) ----------

export interface V1LeaseInput {
  monthlyByYear: number[];
  rentFreeMonths: number;
  ufaSqft?: number;
  [k: string]: unknown;
}

export interface UpcastSource {
  startDate: string;
  horizonMonths: number;
  lease: V1LeaseInput;
  [k: string]: unknown;
}

export interface V2LeaseBlock {
  monthlyByYear: number[];
  rentFreeMonths: number;
  ufaSqft?: number;
  startDate: string;
  committedTermMonths: number;
  committedEndDate: string;
  rentFreeStartDate: string | null;
  rentFreeEndDate: string | null;
  prorationMethod: ProrationMethod;
  currency: 'SGD';
  schedule: LeaseScheduleRow[];
  /** D3-audit: the ORIGINAL v1 whole-month value, untouched, for the P4/P5
   * audit record. Never derived, never overwritten on re-upcast. */
  legacyRentFreeMonths: number;
  [k: string]: unknown;
}

function lastDayOfMonth(year: number, month1: number): string {
  return toISO(year, month1, daysInMonth(year, month1));
}

/**
 * Build the v2 lease block from a v1 input snapshot. Pure: clones, never
 * mutates the input, never touches the DB or version history. Idempotent —
 * upcasting an already-upcast block returns an equal block (existing per-year
 * confirmations/sources are carried over when the year, dates and rent
 * match, so P4 acknowledgement state survives a re-upcast).
 */
export function upcastInputs<T extends UpcastSource>(v1: T): T & { lease: V2LeaseBlock } {
  if (!v1 || typeof v1 !== 'object') throw new AppError(400, 'VALIDATION', 'Projection input is required.');
  if (!Number.isInteger(v1.horizonMonths)) throw new AppError(400, 'VALIDATION', 'horizonMonths must be a whole number.');
  assertEngineTerm(v1.horizonMonths);
  const startDate = v1.startDate;
  parseISODate(startDate, 'lease start date');
  const old = v1.lease ?? ({} as V1LeaseInput);
  if (!Array.isArray(old.monthlyByYear) || !old.monthlyByYear.length) {
    throw new AppError(400, 'VALIDATION', 'Lease schedule must cover at least model year 1.');
  }
  if (!Number.isInteger(old.rentFreeMonths) || old.rentFreeMonths < 0) {
    throw new AppError(400, 'VALIDATION', 'rentFreeMonths cannot be negative.');
  }

  const committedTermMonths = v1.horizonMonths;
  const committedEndDateISO = committedEndDate(startDate, committedTermMonths);

  // Whole-month legacy → explicit dates: model months 1..k free means the
  // calendar months from the start month through start + (k−1) months.
  let rentFreeStartDate: string | null = null;
  let rentFreeEndDate: string | null = null;
  if (old.rentFreeMonths > 0) {
    rentFreeStartDate = startDate;
    const anchor = addMonthsForLeaseEnd(startDate, old.rentFreeMonths - 1);
    const ap = parseISODate(anchor, 'lease start date');
    rentFreeEndDate = lastDayOfMonth(ap.y, ap.m1);
  }

  const priorSchedule = Array.isArray((old as { schedule?: unknown }).schedule)
    ? ((old as { schedule?: LeaseScheduleRow[] }).schedule as LeaseScheduleRow[])
    : [];
  const priorByYear = new Map(priorSchedule.map((r) => [r.leaseYear, r]));
  const lastRent = old.monthlyByYear[old.monthlyByYear.length - 1];
  const yearCount = Math.ceil(committedTermMonths / 12);
  const schedule: LeaseScheduleRow[] = [];
  for (let k = 1; k <= yearCount; k++) {
    const periodStart = addMonthsForLeaseEnd(startDate, (k - 1) * 12);
    const periodEnd = k * 12 >= committedTermMonths ? committedEndDateISO : committedEndDate(startDate, k * 12);
    const monthlyRent = k - 1 < old.monthlyByYear.length ? old.monthlyByYear[k - 1] : lastRent;
    const prior = priorByYear.get(k);
    const keepPrior =
      prior && prior.periodStart === periodStart && prior.periodEnd === periodEnd && prior.monthlyRent === monthlyRent;
    schedule.push({
      leaseYear: k,
      periodStart,
      periodEnd,
      monthlyRent,
      source: keepPrior ? prior.source : k - 1 < old.monthlyByYear.length ? 'user_entered' : 'estimated',
      confirmed: keepPrior ? prior.confirmed : k - 1 < old.monthlyByYear.length,
    });
  }

  const legacyRentFreeMonths =
    typeof (old as { legacyRentFreeMonths?: unknown }).legacyRentFreeMonths === 'number'
      ? ((old as { legacyRentFreeMonths?: number }).legacyRentFreeMonths as number)
      : old.rentFreeMonths;

  const { schedule: _dropped, legacyRentFreeMonths: _kept, ...restLease } = old as V1LeaseInput & {
    schedule?: unknown;
    legacyRentFreeMonths?: unknown;
  };
  void _dropped;
  void _kept;
  const lease: V2LeaseBlock = {
    ...restLease,
    monthlyByYear: [...old.monthlyByYear],
    rentFreeMonths: old.rentFreeMonths,
    startDate,
    committedTermMonths,
    committedEndDate: committedEndDateISO,
    rentFreeStartDate,
    rentFreeEndDate,
    prorationMethod: 'actual_days',
    currency: 'SGD',
    schedule,
    legacyRentFreeMonths,
  };
  if (old.ufaSqft !== undefined) lease.ufaSqft = old.ufaSqft;
  return { ...(v1 as object), lease } as T & { lease: V2LeaseBlock };
}

// ---------- two-date timeline (D6B) ----------

export interface LeaseTimeline {
  timelineStartISO: string; // the EARLIER of the two commencement dates
  leaseCommencementISO: string;
  operationalStartISO: string;
  /** True while `dateISO` is on/after the timeline start but before opening. */
  isPreOpening(dateISO: string): boolean;
}

/**
 * D6B: lease commencement and operational start stay SEPARATE. The financial
 * timeline begins at the earlier date; rows before operational opening are
 * pre-opening (label support only in P1 — landlord rent/deposits/CapEx/valid
 * pre-opening OpEx inclusion and the zero-revenue gating are P2 consumer
 * jobs, not computed here).
 */
export function resolveTimeline(leaseCommencementISO: string, operationalStartISO: string): LeaseTimeline {
  parseISODate(leaseCommencementISO, 'lease commencement date');
  parseISODate(operationalStartISO, 'operational start date');
  const timelineStartISO = leaseCommencementISO < operationalStartISO ? leaseCommencementISO : operationalStartISO;
  return {
    timelineStartISO,
    leaseCommencementISO,
    operationalStartISO,
    isPreOpening: (dateISO: string): boolean => dateISO >= timelineStartISO && dateISO < operationalStartISO,
  };
}

// Lease-horizon P1 tests — pure date/schedule/upcast engine (no DB, no clock).
//
// Every expected value below is HAND-DERIVED from the owner rulings
// (LEASE_HORIZON_OWNER_DECISIONS.md D1B/D6B, 2026-11-09), never generated
// from the module under test. D1B: end = day-before-anniversary when the
// nominal day exists in the target month, else the target month's last day.
// R14 lock: this phase must not alter ENGINE_VERSION or the golden fixture.

import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../../src/core/finance/projection';
import {
  addMonthsForLeaseEnd,
  buildCalendarRows,
  buildLeaseYears,
  chargeableSegments,
  committedEndDate,
  leaseExpenseForRow,
  resolveTimeline,
  upcastInputs,
  validateRentFree,
  validateSchedule,
  type CalendarRow,
  type PricedSegment,
} from '../../src/core/finance/leaseTerm';

function priced(row: CalendarRow, rents: Record<number, number>, rentFree: { startDate: string; endDate: string } | null) {
  const segs = chargeableSegments(
    row,
    buildLeaseYears('2026-12-15', 24),
    rentFree,
  );
  const withRent: PricedSegment[] = segs.map((s) => ({ ...s, monthlyRent: rents[s.leaseYear] ?? 0 }));
  return { segs, withRent };
}

describe('lease-term.D1B end dates (owner override of brief R1)', () => {
  it('applies the day-before-anniversary / last-day-of-target rule', () => {
    // Hand table (D1B): nominal day exists → anniversary minus one day.
    expect(committedEndDate('2026-12-01', 60)).toBe('2031-11-30');
    expect(committedEndDate('2026-12-15', 12)).toBe('2027-12-14');
    // Nominal day missing → last day of the target month (no extra minus-one).
    expect(committedEndDate('2027-01-31', 1)).toBe('2027-02-28'); // non-leap Feb
    expect(committedEndDate('2028-02-29', 12)).toBe('2029-02-28'); // NOT 27 Feb
    // 31-Jan leap vs non-leap, and 30/31-day months.
    expect(committedEndDate('2028-01-31', 1)).toBe('2028-02-29'); // leap Feb
    expect(committedEndDate('2026-04-30', 1)).toBe('2026-05-29'); // 30 exists in May
    expect(committedEndDate('2026-05-31', 1)).toBe('2026-06-30'); // 31 missing in June
    expect(committedEndDate('2026-08-31', 6)).toBe('2027-02-28'); // Aug+6 = Feb 2027
  });

  it('exposes the clamped anniversary separately from the end date', () => {
    expect(addMonthsForLeaseEnd('2026-12-15', 12)).toBe('2027-12-15');
    expect(addMonthsForLeaseEnd('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonthsForLeaseEnd('2028-02-29', 12)).toBe('2029-02-28');
  });

  it('enforces the engine term limit 1–120 (the 12–120 policy is P4 command)', () => {
    expect(() => committedEndDate('2026-12-01', 0)).toThrow(/1–120/);
    expect(() => committedEndDate('2026-12-01', 121)).toThrow(/1–120/);
    expect(() => committedEndDate('2026-12-01', 36.5)).toThrow(/whole number/);
    expect(committedEndDate('2026-12-01', 120)).toBe('2036-11-30');
  });

  it('rejects impossible calendar dates and bad shapes', () => {
    expect(() => committedEndDate('2027-02-29', 12)).toThrow(/calendar date/);
    expect(() => committedEndDate('15-12-2026', 12)).toThrow(/YYYY-MM-DD/);
    expect(() => buildCalendarRows('2027-12-14', '2026-12-15')).toThrow(/before start/);
  });
});

describe('lease-term.R2 calendar rows (N first-of-month, N+1 mid-month)', () => {
  it('builds 60 rows for a first-of-month 60-month term', () => {
    const rows = buildCalendarRows('2026-12-01', '2031-11-30');
    expect(rows).toHaveLength(60);
    expect(rows[0]).toEqual({ calendarMonth: '2026-12', daysInMonth: 31, periodStart: '2026-12-01', periodEnd: '2026-12-31' });
    expect(rows[59]).toEqual({ calendarMonth: '2031-11', daysInMonth: 30, periodStart: '2031-11-01', periodEnd: '2031-11-30' });
  });

  it('builds 13 rows for the 15 Dec 2026 12-month term (17-day stub + 11 full + 14-day stub)', () => {
    const rows = buildCalendarRows('2026-12-15', '2027-12-14');
    expect(rows).toHaveLength(13);
    expect(rows[0]).toEqual({ calendarMonth: '2026-12', daysInMonth: 31, periodStart: '2026-12-15', periodEnd: '2026-12-31' });
    expect(rows[1]).toEqual({ calendarMonth: '2027-01', daysInMonth: 31, periodStart: '2027-01-01', periodEnd: '2027-01-31' });
    expect(rows[12]).toEqual({ calendarMonth: '2027-12', daysInMonth: 31, periodStart: '2027-12-01', periodEnd: '2027-12-14' });
  });

  it('covers 12/13/36/54/60/120-month terms at N and N+1 rows', () => {
    for (const n of [12, 13, 36, 54, 60, 120]) {
      expect(buildCalendarRows('2026-12-01', committedEndDate('2026-12-01', n))).toHaveLength(n);
      expect(buildCalendarRows('2026-12-15', committedEndDate('2026-12-15', n))).toHaveLength(n + 1);
    }
    // Mid-month 120-month terms stay within the ≤121-row engine limit.
    expect(buildCalendarRows('2026-12-15', committedEndDate('2026-12-15', 120))).toHaveLength(121);
    // Anchors: 13mo from 1 Dec 2026 ends 31 Dec 2027; 36mo ends 30 Nov 2029.
    expect(committedEndDate('2026-12-01', 13)).toBe('2027-12-31');
    expect(committedEndDate('2026-12-01', 36)).toBe('2029-11-30');
    expect(committedEndDate('2026-12-15', 13)).toBe('2028-01-14');
  });

  it('builds contiguous anniversary lease years capped at the committed end', () => {
    const years = buildLeaseYears('2026-12-15', 24);
    expect(years).toEqual([
      { leaseYear: 1, periodStart: '2026-12-15', periodEnd: '2027-12-14' },
      { leaseYear: 2, periodStart: '2027-12-15', periodEnd: '2028-12-14' },
    ]);
    // Partial final year is capped, not rounded out.
    const partial = buildLeaseYears('2026-12-01', 13);
    expect(partial).toHaveLength(2);
    expect(partial[0]).toEqual({ leaseYear: 1, periodStart: '2026-12-01', periodEnd: '2027-11-30' });
    expect(partial[1]).toEqual({ leaseYear: 2, periodStart: '2027-12-01', periodEnd: '2027-12-31' });
  });
});

describe('lease-term.R4 proration (actual_days / 30_day / full_month)', () => {
  const dec26: CalendarRow = { calendarMonth: '2026-12', daysInMonth: 31, periodStart: '2026-12-15', periodEnd: '2026-12-31' };
  const dec27: CalendarRow = { calendarMonth: '2027-12', daysInMonth: 31, periodStart: '2027-12-01', periodEnd: '2027-12-14' };
  const mar27: CalendarRow = { calendarMonth: '2027-03', daysInMonth: 31, periodStart: '2027-03-01', periodEnd: '2027-03-31' };

  it('prices opening/closing stubs with unrounded factors and cents payables', () => {
    const open = leaseExpenseForRow(dec26, [{ ...chargeableSegments(dec26, buildLeaseYears('2026-12-15', 12), null)[0], monthlyRent: 5000 }], 'actual_days');
    expect(open.chargeableDays).toBe(17);
    expect(open.factor).toBeCloseTo(17 / 31, 10);
    expect(open.payableCents).toBe(2741.94); // 5000 × 17/31 hand-rounded
    const close = leaseExpenseForRow(dec27, [{ ...chargeableSegments(dec27, buildLeaseYears('2026-12-15', 12), null)[0], monthlyRent: 5000 }], 'actual_days');
    expect(close.factor).toBeCloseTo(14 / 31, 10);
    expect(close.payableCents).toBe(2258.06); // 5000 × 14/31 hand-rounded
    const full = leaseExpenseForRow(mar27, [{ ...chargeableSegments(mar27, buildLeaseYears('2026-12-15', 12), null)[0], monthlyRent: 5000 }], 'actual_days');
    expect(full.factor).toBe(1);
    expect(full.payableCents).toBe(5000);
  });

  it('caps 30_day months at 30/30 and charges full_month on any chargeable day', () => {
    const feb27: CalendarRow = { calendarMonth: '2027-02', daysInMonth: 28, periodStart: '2027-02-01', periodEnd: '2027-02-28' };
    const seg = (row: CalendarRow): PricedSegment => ({ ...chargeableSegments(row, buildLeaseYears('2026-12-15', 12), null)[0], monthlyRent: 5000 });
    // 30_day: 17/30 opening stub, 30/30 on a 31-day full month, 28/30 on Feb.
    expect(leaseExpenseForRow(dec26, [seg(dec26)], '30_day').factor).toBeCloseTo(17 / 30, 10);
    expect(leaseExpenseForRow(dec26, [seg(dec26)], '30_day').payableCents).toBe(2833.33);
    expect(leaseExpenseForRow(mar27, [seg(mar27)], '30_day').factor).toBe(1);
    expect(leaseExpenseForRow(feb27, [seg(feb27)], '30_day').factor).toBeCloseTo(28 / 30, 10);
    expect(leaseExpenseForRow(feb27, [seg(feb27)], '30_day').payableCents).toBe(4666.67);
    // full_month: stub pays the whole month; a fully rent-free row pays zero.
    expect(leaseExpenseForRow(dec26, [seg(dec26)], 'full_month').payableCents).toBe(5000);
    const free: PricedSegment = { ...seg(feb27), chargeableDays: 0 };
    const zero = leaseExpenseForRow(feb27, [free], 'full_month');
    expect(zero.factor).toBe(0);
    expect(zero.payableCents).toBe(0);
  });

  it('accepts stub sums that are not exactly N rents (D2A — no complement-closing)', () => {
    // 30_day on the 15 Dec 12-mo term: 10 full months + 17/30 + 28/30 + 14/30
    // = 11.9667 rents = S$59,833.33, deliberately NOT 12 × 5000.
    const rows = buildCalendarRows('2026-12-15', '2027-12-14');
    const years = buildLeaseYears('2026-12-15', 12);
    let total = 0;
    for (const row of rows) {
      const withRent = chargeableSegments(row, years, null).map((s) => ({ ...s, monthlyRent: 5000 }));
      total += leaseExpenseForRow(row, withRent, '30_day').payableCents;
    }
    expect(total).toBeCloseTo(59833.33, 2);
    expect(total).not.toBeCloseTo(12 * 5000, 2);
  });
});

describe('lease-term.R3 anniversary straddles + rent-free boundaries', () => {
  const dec27: CalendarRow = { calendarMonth: '2027-12', daysInMonth: 31, periodStart: '2027-12-01', periodEnd: '2027-12-31' };

  it('splits Dec 2027 of a 24-mo lease 14d Y1 + 17d Y2 with escalating rents', () => {
    const { segs, withRent } = priced(dec27, { 1: 5000, 2: 5500 }, null);
    expect(segs.map((s) => [s.leaseYear, s.days, s.chargeableDays])).toEqual([[1, 14, 14], [2, 17, 17]]);
    const exp = leaseExpenseForRow(dec27, withRent, 'actual_days');
    // Hand math: 5000×14/31 + 5500×17/31 = 2258.0645 + 3016.1290 = 5274.19.
    expect(exp.segments[0].factor).toBeCloseTo(14 / 31, 10);
    expect(exp.segments[1].factor).toBeCloseTo(17 / 31, 10);
    expect(exp.payableCents).toBe(5274.19);
  });

  it('applies a rent-free window crossing the lease-year boundary', () => {
    const rf = { startDate: '2027-12-10', endDate: '2028-01-20' };
    const { segs, withRent } = priced(dec27, { 1: 5000, 2: 5500 }, rf);
    // Y1 Dec 1–14: 5 rent-free days (10–14) → 9 chargeable. Y2 Dec 15–31: all free.
    expect(segs.map((s) => [s.leaseYear, s.days, s.rentFreeDays, s.chargeableDays])).toEqual([[1, 14, 5, 9], [2, 17, 17, 0]]);
    const exp = leaseExpenseForRow(dec27, withRent, 'actual_days');
    expect(exp.payableCents).toBe(1451.61); // 5000 × 9/31 hand-rounded
    // The window itself is inside the 15 Dec 2026 – 14 Dec 2028 term.
    expect(validateRentFree(rf, '2026-12-15', '2028-12-14')).toEqual([]);
  });

  it('prices flat and escalating schedules identically except for the rent', () => {
    const flat = leaseExpenseForRow(dec27, priced(dec27, { 1: 5000, 2: 5000 }, null).withRent, 'actual_days');
    expect(flat.payableCents).toBe(5000); // (14 + 17)/31 of the same rent
    const esc = leaseExpenseForRow(dec27, priced(dec27, { 1: 5000, 2: 5500 }, null).withRent, 'actual_days');
    expect(esc.payableCents).toBe(5274.19);
  });
});

describe('lease-term.D6B two-date timeline (lease vs operational start stay separate)', () => {
  it('starts at the earlier date and flags pre-opening rows', () => {
    const tl = resolveTimeline('2026-11-15', '2026-12-01');
    expect(tl.timelineStartISO).toBe('2026-11-15');
    expect(tl.isPreOpening('2026-11-15')).toBe(true);
    expect(tl.isPreOpening('2026-11-30')).toBe(true);
    expect(tl.isPreOpening('2026-12-01')).toBe(false);
    // Rows run from the lease commencement through its committed end.
    const rows = buildCalendarRows(tl.timelineStartISO, committedEndDate(tl.leaseCommencementISO, 12));
    expect(rows).toHaveLength(13);
    expect(rows[0].periodStart).toBe('2026-11-15');
    expect(rows[rows.length - 1].periodEnd).toBe('2027-11-14');
    const flagged = rows.filter((r) => tl.isPreOpening(r.periodStart));
    expect(flagged.map((r) => r.calendarMonth)).toEqual(['2026-11']);
  });

  it('also starts at the earlier date when the order is reversed', () => {
    expect(resolveTimeline('2026-12-01', '2026-11-15').timelineStartISO).toBe('2026-11-15');
  });
});

describe('lease-term.upcast v1 → v2 (PLAN §6; never writes history)', () => {
  const v1 = () => ({
    startDate: '2026-12-15',
    horizonMonths: 12,
    nlaSqft: 5000,
    lease: { monthlyByYear: [5000], rentFreeMonths: 3, ufaSqft: 1200 },
  });

  it('builds the v2 lease block with explicit dates and server-derived end', () => {
    const before = JSON.stringify(v1());
    const out = upcastInputs(v1());
    // Input is never mutated.
    expect(JSON.stringify(v1())).toBe(before);
    expect(out.lease.committedTermMonths).toBe(12);
    expect(out.lease.committedEndDate).toBe('2027-12-14');
    expect(out.lease.startDate).toBe('2026-12-15');
    // Legacy 3 whole months → 15 Dec 2026 through end of Feb 2027.
    expect(out.lease.rentFreeStartDate).toBe('2026-12-15');
    expect(out.lease.rentFreeEndDate).toBe('2027-02-28');
    expect(out.lease.prorationMethod).toBe('actual_days');
    expect(out.lease.currency).toBe('SGD');
    expect(out.lease.monthlyByYear).toEqual([5000]);
    // D3-audit: the original legacy value is preserved untouched for P4/P5.
    expect(out.lease.rentFreeMonths).toBe(3);
    expect(out.lease.legacyRentFreeMonths).toBe(3);
    expect(out.lease.schedule).toEqual([
      { leaseYear: 1, periodStart: '2026-12-15', periodEnd: '2027-12-14', monthlyRent: 5000, source: 'user_entered', confirmed: true },
    ]);
  });

  it('is idempotent and maps missing rents to estimated-unconfirmed years', () => {
    const once = upcastInputs(v1());
    const twice = upcastInputs({ ...v1(), lease: { ...v1().lease, ...once.lease } });
    expect(twice).toEqual(once);
    // 13-month term with one rent: year 2 carries the last rent as estimated.
    const ext = upcastInputs({ ...v1(), startDate: '2026-12-01', horizonMonths: 13, lease: { monthlyByYear: [5000], rentFreeMonths: 0 } });
    expect(ext.lease.rentFreeStartDate).toBeNull();
    expect(ext.lease.rentFreeEndDate).toBeNull();
    expect(ext.lease.schedule).toEqual([
      { leaseYear: 1, periodStart: '2026-12-01', periodEnd: '2027-11-30', monthlyRent: 5000, source: 'user_entered', confirmed: true },
      { leaseYear: 2, periodStart: '2027-12-01', periodEnd: '2027-12-31', monthlyRent: 5000, source: 'estimated', confirmed: false },
    ]);
  });
});

describe('lease-term validation (gaps / overlaps / rent-free window)', () => {
  const schedule = [
    { leaseYear: 1, periodStart: '2026-12-15', periodEnd: '2027-12-14' },
    { leaseYear: 2, periodStart: '2027-12-15', periodEnd: '2028-12-14' },
  ];

  it('accepts a contiguous schedule covering the term', () => {
    expect(validateSchedule(schedule, '2026-12-15', '2028-12-14')).toEqual([]);
  });

  it('rejects overlaps, gaps and short coverage', () => {
    const overlap = [schedule[0], { ...schedule[1], periodStart: '2027-12-14' }];
    expect(validateSchedule(overlap, '2026-12-15', '2028-12-14').join(' ')).toMatch(/overlap/i);
    const gap = [schedule[0], { ...schedule[1], periodStart: '2027-12-16' }];
    expect(validateSchedule(gap, '2026-12-15', '2028-12-14').join(' ')).toMatch(/gap/i);
    expect(validateSchedule([schedule[0]], '2026-12-15', '2028-12-14')).not.toEqual([]);
  });

  it('rejects rent-free windows outside the term or reversed', () => {
    expect(validateRentFree(null, '2026-12-15', '2027-12-14')).toEqual([]);
    expect(validateRentFree({ startDate: '2027-12-01', endDate: '2028-01-15' }, '2026-12-15', '2027-12-14').join(' ')).toMatch(/within the lease term/);
    expect(validateRentFree({ startDate: '2027-02-01', endDate: '2027-01-01' }, '2026-12-15', '2027-12-14')).not.toEqual([]);
  });
});

describe('lease-term.R14 lock (P1 changes nothing downstream)', () => {
  it('keeps the v1 engine version pinned', () => {
    expect(ENGINE_VERSION).toBe('finance-projection/1');
  });
});

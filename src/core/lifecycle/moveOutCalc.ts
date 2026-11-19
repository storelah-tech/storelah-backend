// Move-out notice + settlement engine (Track A, phase A1).
//
// Pure: no DB, no clock. The "today" the engine reasons about is always an
// Asia/Singapore calendar date passed in by the caller (R1) — the service
// layer reads the clock and converts with sgCalendarDate(). Money is integer
// cents internally, rounded at each posted component and at the result
// (handoff §9.3); outputs are 2dp numbers (cents-exact) for JSON snapshots.
//
// R8: depositHeld is S$0 on every live rental today, but every deposit
// field/formula path stays live — pass a non-zero depositHeld to exercise it.
// R9: pass netMonthlyRent already resolved through rentChargedOn() semantics
// (a free agreement month resolves to S$0, so its rent refund is S$0).
// Protection Plan paid is shown and never refunded.
// R14: no prototype workflowStatus() outcome labels here; rack-rate naming
// lives in transferCalc (destRackGrossMonthly).

import { AppError } from '../../lib/http';

/** Snapshot version stamped on every settlement calcSnapshot (R6). */
export const MOVEOUT_CALC_VERSION = 1;

/** Handoff §14 default: 30 calendar days. */
export const DEFAULT_REQUIRED_NOTICE_DAYS = 30;

// ---------------------------------------------------------------------------
// SG-calendar date helpers (R1 — pure UTC-date maths, no local-time Date)
// ---------------------------------------------------------------------------

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Asia/Singapore calendar date of an instant, as YYYY-MM-DD. */
export function sgCalendarDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Parse a YYYY-MM-DD calendar date (or a UTC-midnight Date, e.g. a Prisma
 * @db.Date) to UTC midnight. Rejects malformed and non-existent dates.
 */
export function parseSgDate(v: string | Date): Date {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) {
      throw new AppError(400, 'VALIDATION', 'Choose a valid request and move-out date.');
    }
    return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  }
  const m = YMD_RE.exec(v.trim());
  if (!m) throw new AppError(400, 'VALIDATION', 'Choose a valid request and move-out date.');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new AppError(400, 'VALIDATION', 'Choose a valid request and move-out date.');
  }
  return dt;
}

export function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysInMonthUtc(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Whole calendar days from `from` to `to` (both UTC-midnight). */
export function diffCalendarDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Cents-safe money helpers
// ---------------------------------------------------------------------------

export function toCents(n: number): number {
  return Math.round(n * 100);
}

/** Cents back to a 2dp JSON-safe number; normalises -0 to 0. */
export function centsToNum(cents: number): number {
  const n = cents / 100;
  return n === 0 ? 0 : n;
}

// ---------------------------------------------------------------------------
// Shared settlement primitives (also used by transferCalc)
// ---------------------------------------------------------------------------

export const ADJUSTMENT_CATEGORIES = [
  'Service recovery', 'Duplicate payment correction', 'Early termination fee', 'Damage to unit / door',
  'Cleaning fee', 'Lock replacement', 'Merchandise or moving service', 'Other',
] as const;

export interface Adjustment {
  type: 'CHARGE' | 'CREDIT';
  category: (typeof ADJUSTMENT_CATEGORIES)[number];
  amount: number;
  reason: string;
}

export interface SettlementLine {
  label: string;
  amount: number;
  detail?: string;
}

/** Legacy single-adjustment path (v1 API shape): CHARGE adds, CREDIT refunds. */
export function adjustmentLines(adj: Adjustment | null | undefined): {
  lines: SettlementLine[];
  chargeCents: number;
  creditCents: number;
} {
  if (!adj || !(adj.amount > 0)) return { lines: [], chargeCents: 0, creditCents: 0 };
  if (!adj.reason?.trim()) throw new AppError(400, 'VALIDATION', 'Add a reason for the special refund or charge.');
  const cents = toCents(adj.amount);
  return adj.type === 'CHARGE'
    ? {
        lines: [{ label: `Special charge · ${adj.category}`, amount: centsToNum(cents), detail: adj.reason.trim() }],
        chargeCents: cents,
        creditCents: 0,
      }
    : {
        lines: [{ label: `Special credit · ${adj.category}`, amount: centsToNum(-cents), detail: adj.reason.trim() }],
        chargeCents: 0,
        creditCents: cents,
      };
}

// ---------------------------------------------------------------------------
// Notice compliance (§8.4)
// ---------------------------------------------------------------------------

export interface NoticeCalcInput {
  requestDate: string | Date;
  finalAccessDate: string | Date;
  /** Policy snapshot value; defaults to the §14 global default. */
  requiredNoticeDays?: number;
}

export interface NoticeCalc {
  requestDate: string;
  finalAccessDate: string;
  noticeDays: number;
  requiredNoticeDays: number;
  compliant: boolean;
}

/**
 * Notice days = final access − request received, in calendar days (not
 * business days). Compliant when >= the required days.
 */
export function calculateNoticeCompliance(i: NoticeCalcInput): NoticeCalc {
  const req = parseSgDate(i.requestDate);
  const fin = parseSgDate(i.finalAccessDate);
  if (fin.getTime() < req.getTime()) {
    throw new AppError(400, 'VALIDATION', 'The final access date cannot be before the request date.');
  }
  const required = i.requiredNoticeDays ?? DEFAULT_REQUIRED_NOTICE_DAYS;
  if (!Number.isInteger(required) || required < 0) {
    throw new AppError(400, 'VALIDATION', 'Notice days must be zero or more and are rounded to a whole number.');
  }
  const noticeDays = diffCalendarDays(req, fin);
  return {
    requestDate: toYmd(req),
    finalAccessDate: toYmd(fin),
    noticeDays,
    requiredNoticeDays: required,
    compliant: noticeDays >= required,
  };
}

// ---------------------------------------------------------------------------
// Pre-inspection status derivation (§8.3, R3 — derived on read)
// ---------------------------------------------------------------------------

export type MoveOutCaseStatus =
  | 'PENDING_MOVE_OUT'
  | 'AWAITING_INSPECTION'
  | 'SETTLEMENT_REVIEW'
  | 'REFUND_PROCESSING'
  | 'CHARGE_PROCESSING'
  | 'COMPLETED'
  | 'REVERSED';

/**
 * R3: Pending move-out → Awaiting inspection is derived on read — the final
 * access day has arrived/passed when it is <= the SG-calendar today. Every
 * other status passes through untouched.
 */
export function deriveReadStatus(
  current: MoveOutCaseStatus,
  finalAccessYmd: string,
  sgTodayYmd: string,
): MoveOutCaseStatus {
  if (current === 'PENDING_MOVE_OUT' && finalAccessYmd <= sgTodayYmd) return 'AWAITING_INSPECTION';
  return current;
}

/** State machine allow-list from the handoff §8.5 diagram (for A3). */
export const MOVE_OUT_TRANSITIONS: Record<MoveOutCaseStatus, MoveOutCaseStatus[]> = {
  PENDING_MOVE_OUT: ['PENDING_MOVE_OUT', 'AWAITING_INSPECTION', 'REVERSED'],
  AWAITING_INSPECTION: ['SETTLEMENT_REVIEW', 'COMPLETED'],
  SETTLEMENT_REVIEW: ['SETTLEMENT_REVIEW', 'REFUND_PROCESSING', 'CHARGE_PROCESSING'],
  REFUND_PROCESSING: ['COMPLETED'],
  CHARGE_PROCESSING: ['COMPLETED'],
  COMPLETED: [],
  REVERSED: [],
};

export function assertMoveOutTransition(from: MoveOutCaseStatus, to: MoveOutCaseStatus): void {
  if (!MOVE_OUT_TRANSITIONS[from].includes(to)) {
    throw new AppError(409, 'CONFLICT', `A move-out case cannot move from ${from} to ${to}.`);
  }
}

// ---------------------------------------------------------------------------
// Settlement maths (handoff §9)
// ---------------------------------------------------------------------------

/**
 * Itemised inspection charges (handoff §8.9). All SGD, minimum zero — negative
 * inputs are clamped to zero so they can never increase a refund (§9.3).
 * earlyTermination is the D7 operator-entered charge (commitment end is shown
 * for reference only, via commitmentEndYmd).
 */
export interface MoveOutCharges {
  earlyTermination?: number | null;
  damage?: number | null;
  cleaning?: number | null;
  disposal?: number | null;
  arrears?: number | null;
  other?: number | null;
}

export interface MoveOutSettlementInput {
  finalAccessDate: string | Date;
  /** Net monthly storage rent — caller passes rentChargedOn() (R9). */
  netMonthlyRent: number;
  /** R8: live path, S$0 under the current launch policy. */
  depositHeld?: number;
  /** Policy snapshot outcome for this case (R7). Defaults to compliant. */
  noticeCompliant?: boolean;
  /** Policy snapshot flag (handoff §14 default On). */
  shortNoticeForfeitsDeposit?: boolean;
  /** Protection Plan paid for the month — shown, never refunded (R9). */
  protectionPaid?: number;
  charges?: MoveOutCharges;
  /** Approved special credit (e.g. service recovery). */
  specialCredit?: number;
  /** Shown for reference only (D7); never drives the maths. */
  commitmentEndYmd?: string | null;
  /** Legacy v1 single-adjustment path (kept for API compatibility). */
  legacyAdjustment?: Adjustment | null;
}

export interface MoveOutSettlement {
  calcVersion: number;
  finalAccessDate: string;
  daysInMonth: number;
  unusedDays: number;
  monthlyRent: number;
  unusedRentRefund: number;
  protectionPaid: number;
  protectionRefund: 0;
  depositHeld: number;
  depositReturn: number;
  charges: { earlyTermination: number; damage: number; cleaning: number; disposal: number; arrears: number; other: number };
  chargesTotal: number;
  specialCredit: number;
  /** Signed closing: >= 0 refund to customer, < 0 additional charge. */
  netSettlement: number;
  /** Legacy sign: negative = refund, positive = charge. */
  total: number;
  outcome: 'REFUND' | 'CHARGE' | 'ZERO';
  /** Reference only (D7): null when no commitment end was supplied. */
  withinCommitment: boolean | null;
  lines: SettlementLine[];
}

const clampCharge = (v: number | null | undefined): number => {
  const c = toCents(v ?? 0);
  return c > 0 ? c : 0;
};

/**
 * Handoff §9.1: the final access day is billed; only later days are unused.
 * Net = unused-rent refund + refundable deposit + special credit − charges.
 */
export function calculateMoveOutSettlement(i: MoveOutSettlementInput): MoveOutSettlement {
  const fin = parseSgDate(i.finalAccessDate);
  const rentCents = toCents(i.netMonthlyRent ?? 0);
  if (rentCents < 0) throw new AppError(400, 'VALIDATION', 'Monthly rent cannot be negative.');
  const depositHeldCents = toCents(i.depositHeld ?? 0);
  if (depositHeldCents < 0) throw new AppError(400, 'VALIDATION', 'Deposit held cannot be negative.');

  const dim = daysInMonthUtc(fin);
  const unused = dim - fin.getUTCDate();
  // One rounding at the posted component: round(net × unused ÷ dim).
  const refundCents = Math.round((rentCents * unused) / dim);

  // R8 deposit path: returned when notice is compliant, or whenever the
  // short-notice forfeiture policy is off. Only unused storage rent is ever
  // affected by short notice — never the rent refund itself.
  const forfeit = !(i.noticeCompliant ?? true) && (i.shortNoticeForfeitsDeposit ?? true);
  const depositReturnCents = forfeit ? 0 : depositHeldCents;

  const ch = i.charges ?? {};
  const chargeCents = {
    earlyTermination: clampCharge(ch.earlyTermination),
    damage: clampCharge(ch.damage),
    cleaning: clampCharge(ch.cleaning),
    disposal: clampCharge(ch.disposal),
    arrears: clampCharge(ch.arrears),
    other: clampCharge(ch.other),
  };
  const chargesTotalCents =
    chargeCents.earlyTermination + chargeCents.damage + chargeCents.cleaning +
    chargeCents.disposal + chargeCents.arrears + chargeCents.other;
  const specialCreditCents = clampCharge(i.specialCredit);
  const legacy = adjustmentLines(i.legacyAdjustment);

  // One rounding at the result (§9.3): components are already whole cents.
  const netCents =
    refundCents + depositReturnCents + specialCreditCents + legacy.creditCents -
    chargesTotalCents - legacy.chargeCents;

  const protectionPaidCents = toCents(i.protectionPaid ?? 0);
  const lines: SettlementLine[] = [
    { label: `Unused rent after the last day of access (${unused}/${dim} days)`, amount: centsToNum(-refundCents) },
    { label: 'Security deposit returned', amount: centsToNum(-depositReturnCents) },
    {
      label: 'Protection Plan',
      amount: 0,
      detail: protectionPaidCents > 0
        ? `S$${centsToNum(protectionPaidCents).toFixed(2)} paid retained — never prorated, no refund`
        : 'Never prorated — no refund',
    },
  ];
  const pushCharge = (label: string, cents: number) => {
    if (cents > 0) lines.push({ label, amount: centsToNum(cents) });
  };
  pushCharge('Early-termination charge', chargeCents.earlyTermination);
  pushCharge('Damage charge', chargeCents.damage);
  pushCharge('Cleaning charge', chargeCents.cleaning);
  pushCharge('Disposal charge', chargeCents.disposal);
  pushCharge('Outstanding balance / arrears', chargeCents.arrears);
  pushCharge('Other approved charge', chargeCents.other);
  if (specialCreditCents > 0) {
    lines.push({ label: 'Approved special credit', amount: centsToNum(-specialCreditCents) });
  }
  lines.push(...legacy.lines);

  let withinCommitment: boolean | null = null;
  if (i.commitmentEndYmd) {
    const end = parseSgDate(i.commitmentEndYmd);
    withinCommitment = fin.getTime() <= end.getTime();
  }

  return {
    calcVersion: MOVEOUT_CALC_VERSION,
    finalAccessDate: toYmd(fin),
    daysInMonth: dim,
    unusedDays: unused,
    monthlyRent: centsToNum(rentCents),
    unusedRentRefund: centsToNum(refundCents),
    protectionPaid: centsToNum(protectionPaidCents),
    protectionRefund: 0,
    depositHeld: centsToNum(depositHeldCents),
    depositReturn: centsToNum(depositReturnCents),
    charges: {
      earlyTermination: centsToNum(chargeCents.earlyTermination),
      damage: centsToNum(chargeCents.damage),
      cleaning: centsToNum(chargeCents.cleaning),
      disposal: centsToNum(chargeCents.disposal),
      arrears: centsToNum(chargeCents.arrears),
      other: centsToNum(chargeCents.other),
    },
    chargesTotal: centsToNum(chargesTotalCents),
    specialCredit: centsToNum(specialCreditCents),
    netSettlement: centsToNum(netCents),
    total: centsToNum(-netCents),
    outcome: netCents > 0 ? 'REFUND' : netCents < 0 ? 'CHARGE' : 'ZERO',
    withinCommitment,
    lines,
  };
}

/**
 * Legacy v1 signature (customer/public API shapes unchanged): the last day of
 * access is charged, closing = unused rent + deposit + credit − charge, and
 * the returned total uses the settlement sign (negative = refund).
 */
export function calculateMoveOut(i: {
  lastDay: Date;
  rent: number;
  deposit: number;
  adjustment?: Adjustment | null;
}): {
  lines: SettlementLine[];
  closing: number;
  total: number;
  outcome: 'REFUND' | 'CHARGE';
  unusedDays: number;
  daysInMonth: number;
} {
  const s = calculateMoveOutSettlement({
    finalAccessDate: i.lastDay,
    netMonthlyRent: i.rent,
    depositHeld: i.deposit,
    noticeCompliant: true,
    legacyAdjustment: i.adjustment,
  });
  return {
    lines: s.lines,
    closing: s.netSettlement,
    total: s.total,
    outcome: s.netSettlement >= 0 ? 'REFUND' : 'CHARGE',
    unusedDays: s.unusedDays,
    daysInMonth: s.daysInMonth,
  };
}

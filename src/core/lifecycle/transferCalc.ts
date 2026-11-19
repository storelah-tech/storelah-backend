// Unit-transfer calculation engine (Track A, phase A1).
//
// Pure: no DB, no clock. The effective date is passed in as a calendar date;
// availability is re-checked by the service at submit, resubmit and inside
// the posting transaction (R10) — the engine takes the answers as inputs.
// Money is integer cents internally, rounded at each posted component and at
// the result (handoff §9.3); outputs are 2dp numbers for JSON snapshots.
//
// Formula (handoff §11.4): the transfer effective day is INCLUDED in both the
// source credit period and the destination charge period, so transfer days =
// days in month − transfer day + 1. Positive net = amount due from customer;
// negative net = customer account credit (D6); zero still needs approval to
// post the unit change. The existing v1 formula already matched — it is
// preserved exactly; this module adds the snapshot builder, explicit
// Protection Plan carry-forward, exception adjustment and open-transfer guard.
//
// R14: rack-rate naming — the destination gross is the Units rack rate
// (destRackGrossMonthly); there are no blended values here, so no
// effective*/blended* names appear.

import { AppError } from '../../lib/http';
import {
  adjustmentLines,
  centsToNum,
  daysInMonthUtc,
  parseSgDate,
  toCents,
  toYmd,
  type Adjustment,
  type SettlementLine,
} from './moveOutCalc';

export type { Adjustment, SettlementLine };

/** Snapshot version stamped on every transfer calcSnapshot (R6). */
export const TRANSFER_CALC_VERSION = 1;

// ---------------------------------------------------------------------------
// Pure guards (inputs re-read from the DB by the service; R10)
// ---------------------------------------------------------------------------

/** §11.3 / §19: destination must differ from the source unit. */
export function assertTransferParties(i: {
  sourceUnitId: string;
  destUnitId: string;
  destActiveForCustomer?: boolean;
}): void {
  if (!i.sourceUnitId || !i.destUnitId) {
    throw new AppError(400, 'VALIDATION', 'Choose a current unit and a destination unit.');
  }
  if (i.sourceUnitId === i.destUnitId) {
    throw new AppError(400, 'VALIDATION', 'The destination unit must be different from the current unit.');
  }
  if (i.destActiveForCustomer) {
    throw new AppError(409, 'CONFLICT', 'The destination is already active for this customer.');
  }
}

/** §11.3: one source rental cannot have two open transfer approvals. */
export function assertNoOpenTransfer(openTransferRef: string | null | undefined): void {
  if (openTransferRef) {
    throw new AppError(
      409,
      'CONFLICT',
      `Transfer ${openTransferRef} is already awaiting Finance approval for this unit.`,
    );
  }
}

/** Deterministic idempotency key for submit/process retries (A4/A5). */
export function transferIdempotencyKey(i: {
  sourceUnitId: string;
  destUnitId: string;
  effectiveDate: string;
  sourceNetCents: number;
  destNetCents: number;
  exceptionCents: number;
}): string {
  return [
    'trf',
    i.sourceUnitId,
    i.destUnitId,
    i.effectiveDate,
    i.sourceNetCents,
    i.destNetCents,
    i.exceptionCents,
  ].join(':');
}

// ---------------------------------------------------------------------------
// Core proration (legacy-exact)
// ---------------------------------------------------------------------------

export interface TransferCalcInput {
  date: Date;
  currentRent: number;
  currentDeposit: number;
  destGross: number;
  destPromoPct?: number;
  destDeposit?: number;
  destProtection?: number;
  adjustment?: Adjustment | null;
}

/**
 * Transfer maths: remaining days = days in month − transfer day + 1. The
 * unused source-unit rent is credited and the destination rent charged for
 * the same days; destination pricing/promotion wins. Positive total =
 * customer pays.
 */
export function calculateTransfer(i: TransferCalcInput): {
  lines: SettlementLine[];
  total: number;
  remainingDays: number;
  daysInMonth: number;
  destNet: number;
  nextFullDeduction: number;
} {
  if (!(i.date instanceof Date) || Number.isNaN(i.date.getTime())) {
    throw new AppError(400, 'VALIDATION', 'Choose a valid transfer date.');
  }
  const promo = i.destPromoPct ?? 0;
  if (!(promo >= 0 && promo <= 100)) {
    throw new AppError(400, 'VALIDATION', 'Destination promotion must be between 0 and 100 percent.');
  }
  const currentRentCents = toCents(i.currentRent ?? 0);
  if (currentRentCents < 0) throw new AppError(400, 'VALIDATION', 'Current rent cannot be negative.');
  const currentDepositCents = toCents(i.currentDeposit ?? 0);
  const destGrossCents = toCents(i.destGross ?? 0);
  if (destGrossCents < 0) throw new AppError(400, 'VALIDATION', 'Destination rent cannot be negative.');

  const dim = daysInMonthUtc(i.date);
  const remaining = dim - i.date.getUTCDate() + 1;
  // One rounding per posted component: source credit, destination net, then
  // the destination charge — then one rounding at the result.
  const sourceCreditCents = Math.round((currentRentCents * remaining) / dim);
  const destNetCents = Math.round((destGrossCents * (100 - promo)) / 100);
  const destChargeCents = Math.round((destNetCents * remaining) / dim);
  const depositDeltaCents = toCents(i.destDeposit ?? 0) - currentDepositCents;
  const adj = adjustmentLines(i.adjustment);
  const lines: SettlementLine[] = [
    { label: `Unused current-unit rent credit (${remaining}/${dim} days)`, amount: centsToNum(-sourceCreditCents) },
    {
      label: `Destination-unit rent for the same ${remaining} days`,
      amount: centsToNum(destChargeCents),
      detail: `Net ${centsToNum(destNetCents).toFixed(2)}/month after destination pricing`,
    },
    { label: 'Security deposit difference', amount: centsToNum(depositDeltaCents) },
    {
      label: 'Protection Plan',
      amount: 0,
      detail: 'Not prorated — the destination plan starts on the next billing cycle',
    },
    ...adj.lines,
  ];
  const totalCents = destChargeCents - sourceCreditCents + depositDeltaCents + adj.chargeCents - adj.creditCents;
  const destNet = centsToNum(destNetCents);
  return {
    lines,
    total: centsToNum(totalCents),
    remainingDays: remaining,
    daysInMonth: dim,
    destNet,
    nextFullDeduction: centsToNum(destNetCents + toCents(i.destProtection ?? 0)),
  };
}

// ---------------------------------------------------------------------------
// Snapshot builder (handoff §11 required stored calculation snapshot)
// ---------------------------------------------------------------------------

export interface TransferSnapshotInput {
  sourceUnitId: string;
  destUnitId: string;
  effectiveDate: string | Date;
  /** Source net monthly rent — caller passes rentChargedOn() (R9). */
  sourceNetMonthlyRent: number;
  /** R8: live path, S$0 under the current launch policy. */
  sourceDepositHeld?: number;
  /** Destination Units rack rate (gross, pre-promotion). */
  destRackGrossMonthly: number;
  destPromoPct?: number;
  /** Display-only plan name that supplied destPromoPct (derived, A-23). */
  destPromoPlanName?: string | null;
  destDepositRequired?: number;
  /** Destination plan price — recurring from the next billing cycle. */
  destProtectionMonthly?: number;
  /** Approved exception adjustment (CHARGE adds to amount due). */
  exceptionAdjustment?: Adjustment | null;
  /** Pure guard inputs (R10): resolved by the service from the DB. */
  destActiveForCustomer?: boolean;
  openTransferRef?: string | null;
}

export interface TransferSnapshot {
  calcVersion: number;
  sourceUnitId: string;
  destUnitId: string;
  effectiveDate: string;
  daysInMonth: number;
  transferDays: number;
  sourceNetMonthlyRent: number;
  sourceCredit: number;
  destRackGrossMonthly: number;
  destPromoPct: number;
  /** Display-only plan name that supplied destPromoPct (derived, A-23). */
  destPromoPlan: string | null;
  destNetMonthly: number;
  destProratedRent: number;
  sourceDepositCredit: number;
  destDepositRequired: number;
  depositAdjustment: number;
  destProtectionMonthly: number;
  /** §11.6 carry-forward: the paid month carries, no mid-month adjustment. */
  protectionAdjustment: 0;
  exceptionAdjustment: { amount: number; reason: string } | null;
  /** Signed: positive = amount due, negative = account credit. */
  netAdjustment: number;
  outcome: 'AMOUNT_DUE' | 'ACCOUNT_CREDIT' | 'ZERO';
  idempotencyKey: string;
  lines: SettlementLine[];
}

/** Full §11 snapshot: guards first, then one cents-safe calculation. */
export function buildTransferSnapshot(i: TransferSnapshotInput): TransferSnapshot {
  assertTransferParties({ sourceUnitId: i.sourceUnitId, destUnitId: i.destUnitId, destActiveForCustomer: i.destActiveForCustomer });
  assertNoOpenTransfer(i.openTransferRef);
  const eff = parseSgDate(i.effectiveDate);
  const promo = i.destPromoPct ?? 0;

  const calc = calculateTransfer({
    date: eff,
    currentRent: i.sourceNetMonthlyRent,
    currentDeposit: i.sourceDepositHeld ?? 0,
    destGross: i.destRackGrossMonthly,
    destPromoPct: promo,
    destDeposit: i.destDepositRequired ?? 0,
    destProtection: i.destProtectionMonthly ?? 0,
    adjustment: i.exceptionAdjustment,
  });

  const adj = adjustmentLines(i.exceptionAdjustment);
  const exceptionCents = adj.chargeCents - adj.creditCents;
  const netCents = toCents(calc.total);
  return {
    calcVersion: TRANSFER_CALC_VERSION,
    sourceUnitId: i.sourceUnitId,
    destUnitId: i.destUnitId,
    effectiveDate: toYmd(eff),
    daysInMonth: calc.daysInMonth,
    transferDays: calc.remainingDays,
    sourceNetMonthlyRent: centsToNum(toCents(i.sourceNetMonthlyRent)),
    sourceCredit: -calc.lines[0].amount,
    destRackGrossMonthly: centsToNum(toCents(i.destRackGrossMonthly)),
    destPromoPct: promo,
    destPromoPlan: i.destPromoPlanName ?? null,
    destNetMonthly: calc.destNet,
    destProratedRent: calc.lines[1].amount,
    sourceDepositCredit: centsToNum(toCents(i.sourceDepositHeld ?? 0)),
    destDepositRequired: centsToNum(toCents(i.destDepositRequired ?? 0)),
    depositAdjustment: calc.lines[2].amount,
    destProtectionMonthly: centsToNum(toCents(i.destProtectionMonthly ?? 0)),
    protectionAdjustment: 0,
    exceptionAdjustment:
      exceptionCents !== 0 && i.exceptionAdjustment
        ? { amount: centsToNum(exceptionCents), reason: i.exceptionAdjustment.reason.trim() }
        : null,
    netAdjustment: calc.total,
    outcome: netCents > 0 ? 'AMOUNT_DUE' : netCents < 0 ? 'ACCOUNT_CREDIT' : 'ZERO',
    idempotencyKey: transferIdempotencyKey({
      sourceUnitId: i.sourceUnitId,
      destUnitId: i.destUnitId,
      effectiveDate: toYmd(eff),
      sourceNetCents: toCents(i.sourceNetMonthlyRent),
      destNetCents: toCents(calc.destNet),
      exceptionCents,
    }),
    lines: calc.lines,
  };
}

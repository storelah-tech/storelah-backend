// Track A A1 — pure lifecycle engine tests (no DB, no clock).
//
// Every expected value is HAND-DERIVED in the comments: integer-cents
// arithmetic of the form round(cents × days ÷ daysInMonth). Do not copy
// prototype outputs as expectations. Covers handoff §21 move-out 1–9 and
// transfer 1–9, the §9.2 (−S$19.25) and §11.5 (S$41.91) worked examples, and
// the 2026-11-05 regressions ($37.11 / $106.67 / −$43.33).

import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_CATEGORIES,
  assertMoveOutTransition,
  calculateMoveOut,
  calculateMoveOutSettlement,
  calculateNoticeCompliance,
  deriveReadStatus,
  sgCalendarDate,
} from '../../src/core/lifecycle/moveOutCalc';
import {
  assertNoOpenTransfer,
  assertTransferParties,
  buildTransferSnapshot,
  calculateTransfer,
  transferIdempotencyKey,
} from '../../src/core/lifecycle/transferCalc';
// Re-export identity: the customer API keeps these names/shapes.
import {
  calculateMoveOut as profileCalculateMoveOut,
  calculateTransfer as profileCalculateTransfer,
} from '../../src/core/customerProfile';

const day = (v: string) => new Date(`${v}T00:00:00.000Z`);

describe('re-exports keep the customer API shape', () => {
  it('customerProfile re-exports the canonical engines', () => {
    expect(profileCalculateMoveOut).toBe(calculateMoveOut);
    expect(profileCalculateTransfer).toBe(calculateTransfer);
    expect(ADJUSTMENT_CATEGORIES).toContain('Damage to unit / door');
  });
});

describe('handoff §21 move-out cases', () => {
  it('1. mid-month storage-rent-only refund', () => {
    // Rent S$600, final access 15 Nov 2026 (30-day month), unused = 15.
    // 60000 × 15 ÷ 30 = 30000 → S$300.00 refund.
    const s = calculateMoveOutSettlement({ finalAccessDate: '2026-11-15', netMonthlyRent: 600 });
    expect(s).toMatchObject({
      daysInMonth: 30, unusedDays: 15, monthlyRent: 600, unusedRentRefund: 300,
      protectionPaid: 0, protectionRefund: 0, depositHeld: 0, depositReturn: 0,
      chargesTotal: 0, specialCredit: 0, netSettlement: 300, total: -300, outcome: 'REFUND',
    });
    expect(s.lines[0]).toMatchObject({ label: 'Unused rent after the last day of access (15/30 days)', amount: -300 });
    expect(s.lines[2]).toMatchObject({ label: 'Protection Plan', amount: 0 });
  });

  it('2. date-change recalculation', () => {
    // Same S$600 rental. Before: final 15 Nov → unused 15 → S$300.00.
    // After: final 20 Nov → unused 10 → 60000 × 10 ÷ 30 = 20000 → S$200.00.
    const before = calculateMoveOutSettlement({ finalAccessDate: '2026-11-15', netMonthlyRent: 600 });
    const after = calculateMoveOutSettlement({ finalAccessDate: '2026-11-20', netMonthlyRent: 600 });
    expect(before.netSettlement).toBe(300);
    expect(after.netSettlement).toBe(200);
    // Notice recomputed too: request 10 Oct → 15 Nov = (31−10)+15 = 36 days;
    // → 20 Nov = 41 days. Both compliant against the 30-day default.
    expect(calculateNoticeCompliance({ requestDate: '2026-10-10', finalAccessDate: '2026-11-15' }))
      .toMatchObject({ noticeDays: 36, requiredNoticeDays: 30, compliant: true });
    expect(calculateNoticeCompliance({ requestDate: '2026-10-10', finalAccessDate: '2026-11-20' }))
      .toMatchObject({ noticeDays: 41, compliant: true });
  });

  it('3. notice compliance controls deposit return without changing rent refund', () => {
    // R8 path exercised with a non-zero deposit (live value is S$0).
    // Rent refund identical in all three legs: 60000 × 15 ÷ 30 = S$300.00.
    const compliant = calculateMoveOutSettlement({
      finalAccessDate: '2026-11-15', netMonthlyRent: 600, depositHeld: 200,
      noticeCompliant: true, shortNoticeForfeitsDeposit: true,
    });
    expect(compliant.unusedRentRefund).toBe(300);
    expect(compliant.depositReturn).toBe(200);
    expect(compliant.netSettlement).toBe(500);
    // Short notice (request 10 Nov → final 15 Nov = 5 days) with forfeiture on.
    const forfeited = calculateMoveOutSettlement({
      finalAccessDate: '2026-11-15', netMonthlyRent: 600, depositHeld: 200,
      noticeCompliant: false, shortNoticeForfeitsDeposit: true,
    });
    expect(forfeited.unusedRentRefund).toBe(300);
    expect(forfeited.depositReturn).toBe(0);
    expect(forfeited.netSettlement).toBe(300);
    // Same short notice, forfeiture off: deposit still returned.
    const kept = calculateMoveOutSettlement({
      finalAccessDate: '2026-11-15', netMonthlyRent: 600, depositHeld: 200,
      noticeCompliant: false, shortNoticeForfeitsDeposit: false,
    });
    expect(kept.depositReturn).toBe(200);
    expect(kept.netSettlement).toBe(500);
  });

  it('4. charges can convert refund to additional charge (§9.2 worked example)', () => {
    // Final access 15 Nov, rent S$661.50, November = 30 days, unused = 15.
    // 66150 × 15 ÷ 30 = 992250 ÷ 30 = 33075 → S$330.75.
    // Cleaning S$350.00 → 330.75 − 350.00 = −S$19.25 → S$19.25 charge.
    const s = calculateMoveOutSettlement({
      finalAccessDate: '2026-11-15', netMonthlyRent: 661.5,
      charges: { cleaning: 350 },
    });
    expect(s).toMatchObject({
      daysInMonth: 30, unusedDays: 15, unusedRentRefund: 330.75,
      chargesTotal: 350, netSettlement: -19.25, total: 19.25, outcome: 'CHARGE',
    });
    expect(s.lines).toContainEqual({ label: 'Cleaning charge', amount: 350 });
  });

  it('5. month-end produces no unused-rent refund', () => {
    // Final access 30 Nov (last day of a 30-day month): unused = 0 → S$0.
    const s = calculateMoveOutSettlement({ finalAccessDate: '2026-11-30', netMonthlyRent: 600 });
    expect(s).toMatchObject({ unusedDays: 0, unusedRentRefund: 0, netSettlement: 0, total: 0, outcome: 'ZERO' });
  });

  it('6. exactly 30 days is compliant', () => {
    // 16 Oct → 15 Nov = (31−16)+15 = 15+15 = 30 → compliant at the boundary.
    expect(calculateNoticeCompliance({ requestDate: '2026-10-16', finalAccessDate: '2026-11-15' }))
      .toMatchObject({ noticeDays: 30, compliant: true });
    // One day short is not: 17 Oct → 15 Nov = 14+15 = 29.
    expect(calculateNoticeCompliance({ requestDate: '2026-10-17', finalAccessDate: '2026-11-15' }))
      .toMatchObject({ noticeDays: 29, compliant: false });
  });

  it('7. February uses actual calendar days', () => {
    // Non-leap Feb 2027 (28 days): rent S$560, final 14 Feb → unused 14.
    // 56000 × 14 ÷ 28 = 28000 → S$280.00.
    const plain = calculateMoveOutSettlement({ finalAccessDate: '2027-02-14', netMonthlyRent: 560 });
    expect(plain).toMatchObject({ daysInMonth: 28, unusedDays: 14, unusedRentRefund: 280 });
    // Leap Feb 2024 (29 days): rent S$580, final 15 Feb → unused 14.
    // 58000 × 14 ÷ 29 = 812000 ÷ 29 = 28000 → S$280.00 exactly (29 × 28000 = 812000).
    const leap = calculateMoveOutSettlement({ finalAccessDate: '2024-02-15', netMonthlyRent: 580 });
    expect(leap).toMatchObject({ daysInMonth: 29, unusedDays: 14, unusedRentRefund: 280 });
  });

  it('8. negative inputs do not increase refund', () => {
    const base = calculateMoveOutSettlement({ finalAccessDate: '2026-11-15', netMonthlyRent: 600 });
    // Negative itemised charges / credit clamp to zero — same as no charges.
    const clamped = calculateMoveOutSettlement({
      finalAccessDate: '2026-11-15', netMonthlyRent: 600,
      charges: { damage: -50, cleaning: -20, earlyTermination: -100 }, specialCredit: -30,
    });
    expect(clamped.netSettlement).toBe(base.netSettlement);
    expect(clamped.chargesTotal).toBe(0);
    // Legacy single adjustment: non-positive amounts are ignored.
    const legacy = calculateMoveOut({
      lastDay: day('2026-11-15'), rent: 600, deposit: 0,
      adjustment: { type: 'CHARGE', category: 'Other', amount: -5, reason: 'x' },
    });
    expect(legacy.closing).toBe(300);
  });

  it('9. invalid date rejected', () => {
    // Final access before the request date.
    expect(() => calculateNoticeCompliance({ requestDate: '2026-11-15', finalAccessDate: '2026-11-10' }))
      .toThrow(/before the request date/);
    // Non-existent calendar date.
    expect(() => calculateMoveOutSettlement({ finalAccessDate: '2026-02-30', netMonthlyRent: 600 }))
      .toThrow(/valid request and move-out date/);
    expect(() => calculateNoticeCompliance({ requestDate: 'not-a-date', finalAccessDate: '2026-11-15' }))
      .toThrow(/valid request and move-out date/);
  });

  it('R3: pending move-out derives awaiting inspection on read', () => {
    // Final day today or past → Awaiting inspection; future → stays Pending.
    expect(deriveReadStatus('PENDING_MOVE_OUT', '2026-11-15', '2026-11-15')).toBe('AWAITING_INSPECTION');
    expect(deriveReadStatus('PENDING_MOVE_OUT', '2026-11-10', '2026-11-15')).toBe('AWAITING_INSPECTION');
    expect(deriveReadStatus('PENDING_MOVE_OUT', '2026-11-20', '2026-11-15')).toBe('PENDING_MOVE_OUT');
    // All other states pass through untouched.
    expect(deriveReadStatus('SETTLEMENT_REVIEW', '2026-11-10', '2026-11-15')).toBe('SETTLEMENT_REVIEW');
    expect(deriveReadStatus('COMPLETED', '2026-11-10', '2026-11-15')).toBe('COMPLETED');
    // State machine spot-checks (§8.5): date change self-loops, reversal only
    // pre-inspection, zero settlement completes from awaiting inspection.
    expect(() => assertMoveOutTransition('PENDING_MOVE_OUT', 'PENDING_MOVE_OUT')).not.toThrow();
    expect(() => assertMoveOutTransition('PENDING_MOVE_OUT', 'COMPLETED')).toThrow(/cannot move/);
    expect(() => assertMoveOutTransition('AWAITING_INSPECTION', 'COMPLETED')).not.toThrow();
  });

  it('SG calendar date is Asia/Singapore, not UTC', () => {
    // 2026-11-15T00:30+08:00 is still the 14th in UTC — SGT says 15th.
    expect(sgCalendarDate(new Date('2026-11-14T16:30:00.000Z'))).toBe('2026-11-15');
  });
});

describe('handoff §21 transfer cases', () => {
  it('1. effective day included in source and destination periods', () => {
    // Transfer on the 1st of 30-day November: 30−1+1 = 30 days (full month).
    const full = calculateTransfer({ date: day('2026-11-01'), currentRent: 300, currentDeposit: 0, destGross: 400, destPromoPct: 0, destDeposit: 0, destProtection: 0 });
    expect(full).toMatchObject({ remainingDays: 30, daysInMonth: 30 });
    expect(full.lines[0].amount).toBe(-300); // 30000 × 30 ÷ 30
    expect(full.lines[1].amount).toBe(400); // 40000 × 30 ÷ 30
    expect(full.total).toBe(100);
    // Transfer on the last day: 30−30+1 = 1 day — still one charged day each.
    const last = calculateTransfer({ date: day('2026-11-30'), currentRent: 300, currentDeposit: 0, destGross: 400, destPromoPct: 0, destDeposit: 0, destProtection: 0 });
    expect(last.remainingDays).toBe(1);
    expect(last.lines[0].amount).toBe(-10); // 30000 ÷ 30
    expect(last.lines[1].amount).toBe(13.33); // round(40000 ÷ 30) = 1333 → 13.33
    expect(last.total).toBe(3.33); // 13.33 − 10.00
  });

  it('2. actual calendar days used', () => {
    const base = { currentRent: 600, currentDeposit: 0, destGross: 900, destPromoPct: 0, destDeposit: 0, destProtection: 0 };
    // June (30 days), effective 15th: 16 days. 600×16÷30 = 320.00;
    // 900×16÷30 = 480.00 → net 160.00.
    const june = calculateTransfer({ ...base, date: day('2026-06-15') });
    expect(june).toMatchObject({ daysInMonth: 30, remainingDays: 16 });
    expect(june.lines[0].amount).toBe(-320);
    expect(june.lines[1].amount).toBe(480);
    expect(june.total).toBe(160);
    // July (31 days), effective 15th: 17 days.
    // Source: round(60000×17÷31) = round(32903.23) = 32903 → 329.03.
    // Dest: round(90000×17÷31) = round(49354.84) = 49355 → 493.55.
    // Net: 493.55 − 329.03 = 164.52.
    const july = calculateTransfer({ ...base, date: day('2026-07-15') });
    expect(july).toMatchObject({ daysInMonth: 31, remainingDays: 17 });
    expect(july.lines[0].amount).toBe(-329.03);
    expect(july.lines[1].amount).toBe(493.55);
    expect(july.total).toBe(164.52);
  });

  it('3. source deposit offsets destination deposit', () => {
    const base = { date: day('2026-11-30'), currentRent: 400, destGross: 400, destPromoPct: 0, destProtection: 0 };
    // One transfer day: 400÷30 → 13.33 each way, base net 0.00.
    const even = calculateTransfer({ ...base, currentDeposit: 150, destDeposit: 150 });
    expect(even.lines[0].amount).toBe(-13.33);
    expect(even.lines[2]).toMatchObject({ label: 'Security deposit difference', amount: 0 });
    expect(even.total).toBe(0);
    // 100 held → 200 required: +100 adjustment.
    const topUp = calculateTransfer({ ...base, currentDeposit: 100, destDeposit: 200 });
    expect(topUp.lines[2].amount).toBe(100);
    expect(topUp.total).toBe(100);
  });

  it('4. Protection Plan carry-forward has zero mid-month adjustment', () => {
    const r = calculateTransfer({
      date: day('2026-11-20'), currentRent: 320, currentDeposit: 0,
      destGross: 500, destPromoPct: 0, destDeposit: 0, destProtection: 15,
    });
    expect(r.lines[3]).toMatchObject({ label: 'Protection Plan', amount: 0 });
    expect(r.destNet).toBe(500);
    // Destination plan becomes the recurring charge next cycle — no mid-month line.
    expect(r.nextFullDeduction).toBe(515);
    const snap = buildTransferSnapshot({
      sourceUnitId: 'u-src', destUnitId: 'u-dst', effectiveDate: '2026-11-20',
      sourceNetMonthlyRent: 320, destRackGrossMonthly: 500, destProtectionMonthly: 15,
    });
    expect(snap.protectionAdjustment).toBe(0);
    expect(snap.destProtectionMonthly).toBe(15);
  });

  it('5. cheaper destination produces customer credit', () => {
    // Effective 10 Nov (30-day month): 30−10+1 = 21 days.
    // Source: 80000×21÷30 = 56000 → 560.00.
    // Dest: 50000×21÷30 = 35000 → 350.00. Net 350 − 560 = −210.00 credit.
    const r = calculateTransfer({
      date: day('2026-11-10'), currentRent: 800, currentDeposit: 0,
      destGross: 500, destPromoPct: 0, destDeposit: 0, destProtection: 0,
    });
    expect(r).toMatchObject({ remainingDays: 21, total: -210 });
    // An approved S$25 exception charge reduces the credit: −210 + 25 = −185.
    const withException = calculateTransfer({
      date: day('2026-11-10'), currentRent: 800, currentDeposit: 0,
      destGross: 500, destPromoPct: 0, destDeposit: 0, destProtection: 0,
      adjustment: { type: 'CHARGE', category: 'Other', amount: 25, reason: 'Agreed valet' },
    });
    expect(withException.total).toBe(-185);
  });

  it('6. same source/destination rejected', () => {
    expect(() => assertTransferParties({ sourceUnitId: 'u-1', destUnitId: 'u-1' }))
      .toThrow(/different from the current unit/);
    expect(() => buildTransferSnapshot({
      sourceUnitId: 'u-1', destUnitId: 'u-1', effectiveDate: '2026-11-20',
      sourceNetMonthlyRent: 300, destRackGrossMonthly: 400,
    })).toThrow(/different from the current unit/);
  });

  it('7. active destination rejected', () => {
    expect(() => assertTransferParties({ sourceUnitId: 'u-1', destUnitId: 'u-2', destActiveForCustomer: true }))
      .toThrow(/already active for this customer/);
  });

  it('8. duplicate open source transfer rejected', () => {
    expect(() => assertNoOpenTransfer('TRF-1000001')).toThrow(/TRF-1000001.*awaiting Finance approval/);
    expect(() => assertNoOpenTransfer(null)).not.toThrow();
    expect(() => buildTransferSnapshot({
      sourceUnitId: 'u-1', destUnitId: 'u-2', effectiveDate: '2026-11-20',
      sourceNetMonthlyRent: 300, destRackGrossMonthly: 400, openTransferRef: 'TRF-1000001',
    })).toThrow(/TRF-1000001/);
  });

  it('9. snapshot is deterministic — preview twice, post once', () => {
    const input = {
      sourceUnitId: 'u-1', destUnitId: 'u-2', effectiveDate: '2026-11-20',
      sourceNetMonthlyRent: 547.2, destRackGrossMonthly: 661.5,
    };
    const a = buildTransferSnapshot(input);
    const b = buildTransferSnapshot(input);
    expect(a).toEqual(b);
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    // A different effective date is a different posting.
    const c = buildTransferSnapshot({ ...input, effectiveDate: '2026-11-21' });
    expect(c.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(transferIdempotencyKey({
      sourceUnitId: 'u-1', destUnitId: 'u-2', effectiveDate: '2026-11-20',
      sourceNetCents: 54720, destNetCents: 66150, exceptionCents: 0,
    })).toBe(a.idempotencyKey);
  });

  it('§11.5 worked example + full snapshot shape', () => {
    // Effective 20 Nov 2026 (30 days): 30−20+1 = 11 transfer days.
    // Source: 54720×11÷30 = 601920÷30 = 20064 → S$200.64.
    // Dest: 66150×11÷30 = 727650÷30 = 24255 → S$242.55.
    // Net: 242.55 − 200.64 = S$41.91 amount due.
    const snap = buildTransferSnapshot({
      sourceUnitId: 'u-src', destUnitId: 'u-dst', effectiveDate: '2026-11-20',
      sourceNetMonthlyRent: 547.2, destRackGrossMonthly: 661.5,
    });
    expect(snap).toMatchObject({
      calcVersion: 1, effectiveDate: '2026-11-20', daysInMonth: 30, transferDays: 11,
      sourceNetMonthlyRent: 547.2, sourceCredit: 200.64,
      destRackGrossMonthly: 661.5, destPromoPct: 0, destNetMonthly: 661.5, destProratedRent: 242.55,
      sourceDepositCredit: 0, destDepositRequired: 0, depositAdjustment: 0,
      protectionAdjustment: 0, exceptionAdjustment: null,
      netAdjustment: 41.91, outcome: 'AMOUNT_DUE',
    });
    expect(snap.outcome).toBe('AMOUNT_DUE');
  });
});

describe('2026-11-05 regressions (via re-exported engines)', () => {
  it('transfer on 20 Nov: credit 117.33, charge 154.44, customer pays 37.11', () => {
    // 11 of 30 days. Source: 32000×11÷30 = 352000÷30 = 11733.33 → 11733.
    // Dest net: 46800×90÷100 = 42120 → 421.20.
    // Dest: 42120×11÷30 = 463320÷30 = 15444 → 154.44.
    // Total: 154.44 − 117.33 = 37.11. Next: 421.20 + 12.50 = 433.70.
    const r = profileCalculateTransfer({
      date: day('2026-11-20'), currentRent: 320, currentDeposit: 0,
      destGross: 468, destPromoPct: 10, destDeposit: 0, destProtection: 12.5,
    });
    expect(r.remainingDays).toBe(11);
    expect(r.lines[0].amount).toBe(-117.33);
    expect(r.lines[1].amount).toBe(154.44);
    expect(r.total).toBe(37.11);
    expect(r.nextFullDeduction).toBe(433.7);
  });

  it('move-out with last access 20 Nov refunds 106.67; a $150 damage charge turns it into a 43.33 charge', () => {
    // Unused 10 of 30: 32000×10÷30 = 320000÷30 = 10666.67 → 10667 → 106.67.
    const r = profileCalculateMoveOut({ lastDay: day('2026-11-20'), rent: 320, deposit: 0 });
    expect(r).toMatchObject({ unusedDays: 10, closing: 106.67, total: -106.67, outcome: 'REFUND' });
    // 106.67 − 150.00 = −43.33 → S$43.33 additional charge.
    const c = profileCalculateMoveOut({
      lastDay: day('2026-11-20'), rent: 320, deposit: 0,
      adjustment: { type: 'CHARGE', category: 'Damage to unit / door', amount: 150, reason: 'Door dent' },
    });
    expect(c).toMatchObject({ closing: -43.33, total: 43.33, outcome: 'CHARGE' });
    // Same numbers through the itemised inspection path.
    const itemised = calculateMoveOutSettlement({
      finalAccessDate: '2026-11-20', netMonthlyRent: 320, charges: { damage: 150 },
    });
    expect(itemised).toMatchObject({ netSettlement: -43.33, total: 43.33, outcome: 'CHARGE' });
    expect(() => profileCalculateMoveOut({
      lastDay: day('2026-11-20'), rent: 320, deposit: 0,
      adjustment: { type: 'CHARGE', category: 'Other', amount: 5, reason: ' ' },
    })).toThrow(/reason/);
  });
});

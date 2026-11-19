// Track A A3 — move-out case service + CMS API + portal bridge (handoff §8/§9,
// R1–R4, R7, R12, R13, D5, D7, D14).
//
// Handoff §21 move-out cases 1–9 run THROUGH THE API. Every expected value is
// hand-derived integer-cents arithmetic of the form
// round(net_cents × days ÷ daysInMonth) — cross-checked against the same A1
// pure engine the service calls, never copied from a prototype. No client
// total is ever sent: every preview/post re-reads tenant rent from the DB.

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, createOperator, prisma, resetDb, seedMoveInWorld, uniqueEmail, type Operator } from './fixtures';
import { calculateMoveOutSettlement } from '../../src/core/lifecycle/moveOutCalc';
import { sgCalendarDate } from '../../src/core/lifecycle/moveOutCalc';

const CMS = '/api/v1/cms';

const CHANNEL = 'WhatsApp';
const REASON = 'No longer needs storage';

interface World {
  branchId: string;
  floorId: string;
  sizeId: string;
}

async function seedWorld(): Promise<World> {
  await seedMoveInWorld();
  const branch = await prisma.branch.findUniqueOrThrow({ where: { code: PIN.branchCode } });
  const floor = await prisma.floor.findFirstOrThrow({ where: { branchId: branch.id } });
  const size = await prisma.unitSize.findFirstOrThrow();
  return { branchId: branch.id, floorId: floor.id, sizeId: size.id };
}

let unitSeq = 0;
async function makeUnit(w: World, rate: number, code?: string) {
  unitSeq += 1;
  return prisma.unit.create({
    data: {
      branchId: w.branchId,
      floorId: w.floorId,
      sizeId: w.sizeId,
      unitCode: code ?? `MV-E2E-${unitSeq}`,
      sqft: 50,
      monthlyRate: rate,
      status: 'AVAILABLE',
      climateControl: 'Ambient climate',
    },
  });
}

async function makeTenant(w: World, unitId: string, rate: number, email = uniqueEmail()) {
  return prisma.tenant.create({
    data: {
      name: 'E2E Mover',
      email,
      mobile: '81234567',
      unitId,
      moveInDate: new Date('2026-09-14T00:00:00.000Z'),
      monthlyRate: rate,
      psf: rate / 50,
      status: 'ACTIVE',
      branchId: w.branchId,
    },
  });
}

async function recordCase(auth: string, body: Record<string, unknown>) {
  const res = await api.post(`${CMS}/move-out-cases`).set('Authorization', auth).send(body);
  expect(res.status).toBe(201);
  return res.body.data;
}

const FULL_INSPECTION = {
  unitEmpty: true,
  doorLockWallsFloorChecked: true,
  accessRevoked: true,
  releaseConfirmed: true,
  releaseStatus: 'READY',
  notes: 'Unit empty, walls scuffed but within tolerance. Evidence: photos 1-4.',
};

describe('handoff §21 move-out cases 1–9 through the API', () => {
  let w: World;
  let owner: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    owner = await createOperator('OWNER');
  });

  it('1. mid-month storage-rent-only refund', async () => {
    // Rent S$600, final access 15 Nov 2026 (30-day month), unused = 15.
    // 60000 × 15 ÷ 30 = 30000 → S$300.00 refund.
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    expect(c.caseNumber).toMatch(/^MO-\d{7}$/);
    expect(c.status).toBe('AWAITING_INSPECTION');
    expect(c).toMatchObject({ noticeDays: 36, noticeRequiredDays: 30, noticeCompliant: true });

    const preview = (await api.get(`${CMS}/move-out-cases/${c.id}/preview`).set('Authorization', owner.auth)).body.data;
    const engine = calculateMoveOutSettlement({ finalAccessDate: '2026-11-15', netMonthlyRent: 600 });
    expect(preview.calc).toMatchObject({
      daysInMonth: 30, unusedDays: 15, monthlyRent: 600, unusedRentRefund: 300,
      protectionPaid: 0, protectionRefund: 0, depositHeld: 0, depositReturn: 0,
      chargesTotal: 0, specialCredit: 0, netSettlement: 300, total: -300, outcome: 'REFUND',
    });
    expect(preview.calc).toMatchObject({ netSettlement: engine.netSettlement, total: engine.total });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).status).toBe('NOTICE');
  });

  it('2. date-change recalculation with before/after preview', async () => {
    // Before: 15 Nov → unused 15 → S$300.00. After 20 Nov → unused 10 → S$200.00.
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const res = await api
      .patch(`${CMS}/move-out-cases/${c.id}/date`)
      .set('Authorization', owner.auth)
      .send({ finalAccessDate: '2026-11-20', reason: 'Customer wants extra days', expectedVersion: c.version });
    expect(res.status).toBe(200);
    expect(res.body.data.before).toMatchObject({
      finalAccessDate: '2026-11-15', noticeDays: 36, noticeCompliant: true, estimatedRefund: 300,
    });
    // 10 Oct → 20 Nov = 21 + 20 = 41 days; S$600 × 10 ÷ 30 = S$200.00.
    expect(res.body.data.after).toMatchObject({
      finalAccessDate: '2026-11-20', noticeDays: 41, noticeCompliant: true, estimatedRefund: 200,
    });
    expect(res.body.data.case.version).toBe(1);
    const changes = await prisma.moveOutDateChange.findMany({ where: { caseId: c.id } });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ reason: 'Customer wants extra days', byCustomer: false });
    expect(changes[0].beforeCalc).toMatchObject({ estimatedRefund: 300 });
    expect(changes[0].afterCalc).toMatchObject({ estimatedRefund: 200 });
  });

  it('3. notice compliance controls the case without changing rent refund', async () => {
    // Short notice: request 10 Nov → final 15 Nov = 5 days → non-compliant.
    // Rent refund identical: 60000 × 15 ÷ 30 = S$300.00 (deposit stays S$0 live).
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-11-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    expect(c).toMatchObject({ noticeDays: 5, noticeCompliant: false });
    const preview = (await api.get(`${CMS}/move-out-cases/${c.id}/preview`).set('Authorization', owner.auth)).body.data;
    expect(preview.calc).toMatchObject({ unusedRentRefund: 300, depositHeld: 0, depositReturn: 0, netSettlement: 300 });
    // R7: the snapshot pins the policy the case was requested under.
    expect(c.policySnapshot).toMatchObject({ noticeDays: 30, allowDateChange: true });
  });

  it('4. charges convert refund to additional charge (§9.2)', async () => {
    // 66150 × 15 ÷ 30 = 33075 → S$330.75; minus S$350 cleaning = −S$19.25.
    const unit = await makeUnit(w, 661.5);
    const tenant = await makeTenant(w, unit.id, 661.5);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const res = await api
      .post(`${CMS}/move-out-cases/${c.id}/inspection`)
      .set('Authorization', owner.auth)
      .send({ ...FULL_INSPECTION, cleaningCharge: 350 });
    expect(res.status).toBe(201);
    expect(res.body.data.deduplicated).toBe(false);
    expect(res.body.data.case.status).toBe('SETTLEMENT_REVIEW');
    expect(res.body.data.settlement).toMatchObject({ docType: 'Charge', amount: 19.25, status: 'PENDING_APPROVAL' });
    expect(res.body.data.settlement.ref).toMatch(/^CH-\d{7}$/);
    expect(res.body.data.inspection).toMatchObject({ cleaningCharge: 350, releaseStatus: 'READY' });
    // R12: ready for rental → unit AVAILABLE, tenant link kept until completion.
    expect((await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })).status).toBe('AVAILABLE');
    expect(await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).toMatchObject({ status: 'NOTICE', unitId: unit.id });
  });

  it('5. month-end produces zero → CL- close record + completion', async () => {
    // Final access on the last day of a month: unused = 0 → ZERO. Dates are
    // dynamic (previous month-end) so the case is always inspectable.
    const now = new Date();
    const prevEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    const prevStart = new Date(Date.UTC(prevEnd.getUTCFullYear(), prevEnd.getUTCMonth(), 1));
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: ymd(prevEnd),
      requestReceivedAt: ymd(prevStart),
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const preview = (await api.get(`${CMS}/move-out-cases/${c.id}/preview`).set('Authorization', owner.auth)).body.data;
    expect(preview.calc).toMatchObject({ unusedDays: 0, unusedRentRefund: 0, netSettlement: 0, total: 0, outcome: 'ZERO' });

    const res = await api
      .post(`${CMS}/move-out-cases/${c.id}/inspection`)
      .set('Authorization', owner.auth)
      .send(FULL_INSPECTION);
    expect(res.status).toBe(201);
    expect(res.body.data.settlement).toMatchObject({ docType: 'Zero settlement', amount: 0, status: 'CANCELLED' });
    expect(res.body.data.settlement.ref).toMatch(/^CL-\d{7}$/);
    expect(res.body.data.case.status).toBe('COMPLETED');
    // §10.6: no processor, rental completed and marked Former.
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(t).toMatchObject({ status: 'INACTIVE', unitId: null, accessRestricted: true });
    const history = await prisma.rentalUnitHistory.findMany({ where: { tenantId: tenant.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ unitId: unit.id, endReason: 'MOVE_OUT' });
    expect(await prisma.customerLedgerEntry.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it('6. exactly 30 days is compliant', async () => {
    // 16 Oct → 15 Nov = 15 + 15 = 30 → compliant at the boundary.
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-16',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    expect(c).toMatchObject({ noticeDays: 30, noticeCompliant: true });

    const unit2 = await makeUnit(w, 600);
    const tenant2 = await makeTenant(w, unit2.id, 600);
    const c2 = await recordCase(owner.auth, {
      tenantId: tenant2.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-17',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    expect(c2).toMatchObject({ noticeDays: 29, noticeCompliant: false });
  });

  it('7. February uses actual calendar days', async () => {
    // 2026-02 (28 days): 56000 × 14 ÷ 28 = 28000 → S$280.00.
    const unit = await makeUnit(w, 560);
    const tenant = await makeTenant(w, unit.id, 560);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-02-14',
      requestReceivedAt: '2026-01-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const preview = (await api.get(`${CMS}/move-out-cases/${c.id}/preview`).set('Authorization', owner.auth)).body.data;
    expect(preview.calc).toMatchObject({ daysInMonth: 28, unusedDays: 14, unusedRentRefund: 280 });
    // Leap 2024-02 (29 days): 58000 × 14 ÷ 29 = 812000 ÷ 29 = 28000 → S$280.00.
    const unit2 = await makeUnit(w, 580);
    const tenant2 = await makeTenant(w, unit2.id, 580);
    const c2 = await recordCase(owner.auth, {
      tenantId: tenant2.id,
      finalAccessDate: '2024-02-15',
      requestReceivedAt: '2024-01-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const p2 = (await api.get(`${CMS}/move-out-cases/${c2.id}/preview`).set('Authorization', owner.auth)).body.data;
    expect(p2.calc).toMatchObject({ daysInMonth: 29, unusedDays: 14, unusedRentRefund: 280 });
  });

  it('8. negative inputs do not increase refund (rejected at the API)', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const res = await api
      .post(`${CMS}/move-out-cases/${c.id}/inspection`)
      .set('Authorization', owner.auth)
      .send({ ...FULL_INSPECTION, damageCharge: -50 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/cannot be negative/);
    // No inspection and no settlement were written.
    expect(await prisma.moveOutInspection.count({ where: { caseId: c.id } })).toBe(0);
    expect(await prisma.customerSettlement.count({ where: { moveOutCaseId: c.id } })).toBe(0);
  });

  it('9. invalid dates rejected', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    // Non-existent calendar date.
    const bad = await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
      tenantId: tenant.id,
      finalAccessDate: '2026-02-30',
      requestReceivedAt: '2026-01-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('Choose a valid request and move-out date.');
    // Final access before the request date.
    const backwards = await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
      tenantId: tenant.id,
      finalAccessDate: '2026-11-10',
      requestReceivedAt: '2026-11-15',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.message).toBe('The final access date cannot be before the request date.');
  });
});

describe('move-out state machine, locking, idempotency and release mapping', () => {
  let w: World;
  let owner: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    owner = await createOperator('OWNER');
  });

  it('R3: pending derives awaiting on read, persisted with an audit event', async () => {
    const today = sgCalendarDate(new Date());
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    // Final access = today → created straight into AWAITING; list persists it.
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: today,
      requestReceivedAt: today,
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    expect(c.status).toBe('AWAITING_INSPECTION');
    const list = (await api.get(`${CMS}/move-out-cases`).set('Authorization', owner.auth)).body;
    expect(list.data).toHaveLength(1);
    const events = await prisma.financeAuditEvent.findMany({ where: { entityId: c.id } });
    expect(events.map((e) => e.action)).toContain('move_out.requested');
    // Empty-filter copy (§19).
    const empty = await api.get(`${CMS}/move-out-cases?status=COMPLETED`).set('Authorization', owner.auth);
    expect(empty.body.data).toEqual([]);
    expect(empty.body.meta.empty).toBe('No move-out cases match these filters.');
  });

  it('illegal transitions return 409', async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const pending = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: future,
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    expect(pending.status).toBe('PENDING_MOVE_OUT');
    // Inspection before the final access day.
    const early = await api
      .post(`${CMS}/move-out-cases/${pending.id}/inspection`)
      .set('Authorization', owner.auth)
      .send(FULL_INSPECTION);
    expect(early.status).toBe(409);
    expect(early.body.error.message).toBe('Inspection is available only on or after the final access day.');

    const unit2 = await makeUnit(w, 600);
    const tenant2 = await makeTenant(w, unit2.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant2.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    await api.post(`${CMS}/move-out-cases/${c.id}/inspection`).set('Authorization', owner.auth).send(FULL_INSPECTION);
    // Reversal after inspection is illegal (only before inspection/completion).
    const rev = await api
      .post(`${CMS}/move-out-cases/${c.id}/reverse`)
      .set('Authorization', owner.auth)
      .send({ reason: 'Changed mind' });
    expect(rev.status).toBe(409);
    // Date change after inspection is illegal too.
    const chg = await api
      .patch(`${CMS}/move-out-cases/${c.id}/date`)
      .set('Authorization', owner.auth)
      .send({ finalAccessDate: '2026-11-20', reason: 'Too late' });
    expect(chg.status).toBe(409);
  });

  it('reversal restores the rental and keeps history', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    // Reason is required (handoff §8.8).
    const noReason = await api
      .post(`${CMS}/move-out-cases/${c.id}/reverse`)
      .set('Authorization', owner.auth)
      .send({ reason: '' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.message).toBe('A reason is required to reverse the move-out request.');

    const res = await api
      .post(`${CMS}/move-out-cases/${c.id}/reverse`)
      .set('Authorization', owner.auth)
      .send({ reason: 'Customer withdrew', expectedVersion: c.version });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'REVERSED', reversedBy: owner.email });
    expect(res.body.data.reversalReason).toBe('Customer withdrew');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).status).toBe('ACTIVE');
    // A new request can be recorded after a reversal.
    const again = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    expect(again.status).toBe('AWAITING_INSPECTION');
  });

  it('optimistic locking returns 409 STALE', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const stale = await api
      .patch(`${CMS}/move-out-cases/${c.id}/date`)
      .set('Authorization', owner.auth)
      .send({ finalAccessDate: '2026-11-20', reason: 'x', expectedVersion: 999 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE');

    const ok = await api
      .patch(`${CMS}/move-out-cases/${c.id}/date`)
      .set('Authorization', owner.auth)
      .send({ finalAccessDate: '2026-11-20', reason: 'x', expectedVersion: c.version });
    expect(ok.status).toBe(200);
    const rev = await api
      .post(`${CMS}/move-out-cases/${c.id}/reverse`)
      .set('Authorization', owner.auth)
      .send({ reason: 'y', expectedVersion: c.version });
    expect(rev.status).toBe(409);
    expect(rev.body.error.code).toBe('STALE');
  });

  it('inspection retry creates exactly one settlement', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const first = await api
      .post(`${CMS}/move-out-cases/${c.id}/inspection`)
      .set('Authorization', owner.auth)
      .send({ ...FULL_INSPECTION, damageCharge: 25.5 });
    expect(first.status).toBe(201);
    expect(first.body.data.deduplicated).toBe(false);
    // 300.00 − 25.50 = S$274.50 refund.
    expect(first.body.data.settlement).toMatchObject({ docType: 'Refund', amount: -274.5 });
    expect(first.body.data.settlement.ref).toMatch(/^RF-\d{7}$/);

    const retry = await api
      .post(`${CMS}/move-out-cases/${c.id}/inspection`)
      .set('Authorization', owner.auth)
      .send({ ...FULL_INSPECTION, damageCharge: 999 });
    expect(retry.status).toBe(201);
    expect(retry.body.data.deduplicated).toBe(true);
    expect(retry.body.data.settlement.ref).toBe(first.body.data.settlement.ref);
    expect(await prisma.customerSettlement.count({ where: { moveOutCaseId: c.id } })).toBe(1);
    expect(await prisma.moveOutInspection.count({ where: { caseId: c.id } })).toBe(1);
  });

  it('R12: release mapping + work orders; R13: attestation recorded', async () => {
    for (const [releaseStatus, unitStatus, workOrders] of [
      ['CLEANING_REQUIRED', 'MAINTENANCE', 1],
      ['MAINTENANCE_REQUIRED', 'MAINTENANCE', 1],
      ['BLOCKED', 'BLOCKED', 0],
    ] as const) {
      const unit = await makeUnit(w, 600);
      const tenant = await makeTenant(w, unit.id, 600);
      const c = await recordCase(owner.auth, {
        tenantId: tenant.id,
        finalAccessDate: '2026-11-15',
        requestReceivedAt: '2026-10-10',
        requestChannel: CHANNEL,
        reasonCode: REASON,
      });
      const res = await api
        .post(`${CMS}/move-out-cases/${c.id}/inspection`)
        .set('Authorization', owner.auth)
        .send({ ...FULL_INSPECTION, releaseStatus });
      expect(res.status).toBe(201);
      expect((await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })).status).toBe(unitStatus);
      expect(await prisma.workOrder.count({ where: { unitId: unit.id } })).toBe(workOrders);
      // R13: attestation = actor + time.
      expect(res.body.data.inspection).toMatchObject({ releaseStatus, accessRevoked: true });
      expect(res.body.data.inspection.inspector).toBe(owner.email);
    }
  });

  it('validation copy is verbatim (§8.7, §8.9)', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const noReason = await api
      .patch(`${CMS}/move-out-cases/${c.id}/date`)
      .set('Authorization', owner.auth)
      .send({ finalAccessDate: '2026-11-20', reason: '' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.message).toBe('A reason is required to change the move-out date.');
    const backwards = await api
      .patch(`${CMS}/move-out-cases/${c.id}/date`)
      .set('Authorization', owner.auth)
      .send({ finalAccessDate: '2026-10-09', reason: 'oops' });
    expect(backwards.body.error.message).toBe('The new date cannot be before the request date.');
    const unchecked = await api
      .post(`${CMS}/move-out-cases/${c.id}/inspection`)
      .set('Authorization', owner.auth)
      .send({ ...FULL_INSPECTION, releaseConfirmed: false });
    expect(unchecked.status).toBe(400);
    expect(unchecked.body.error.message).toBe('Complete all four release checks before submitting.');
    const noNotes = await api
      .post(`${CMS}/move-out-cases/${c.id}/inspection`)
      .set('Authorization', owner.auth)
      .send({ ...FULL_INSPECTION, notes: '  ' });
    expect(noNotes.status).toBe(400);
    expect(noNotes.body.error.message).toBe('Inspection notes or evidence are required.');
  });
});

describe('D14 legacy retirement, permissions and facility scope', () => {
  let w: World;
  let owner: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    owner = await createOperator('OWNER');
  });

  it('PATCH /move-outs/:tenantId answers 410 with a pointer, not a 404', async () => {
    const res = await api
      .patch(`${CMS}/move-outs/tenant-nope`)
      .set('Authorization', owner.auth)
      .send({ action: 'complete' });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('GONE');
    expect(res.body.error.details).toMatchObject({ pointer: '/api/v1/cms/move-out-cases' });
  });

  it('enforces customer-moveouts permissions', async () => {
    const viewer = await createOperator('VIEWER');
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const denied = await api.post(`${CMS}/move-out-cases`).set('Authorization', viewer.auth).send({
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    expect(denied.status).toBe(403);
    // Viewer keeps the pre-existing read grant.
    expect((await api.get(`${CMS}/move-out-cases`).set('Authorization', viewer.auth)).status).toBe(200);

    const financeOp = await createOperator('FINANCE_OPERATOR');
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const changed = await api
      .patch(`${CMS}/move-out-cases/${c.id}/date`)
      .set('Authorization', financeOp.auth)
      .send({ finalAccessDate: '2026-11-16', reason: 'Operator change' });
    expect(changed.status).toBe(200);
  });

  it('applies OperatorFacilityAccess scope on every case query', async () => {
    const size = await prisma.unitSize.findFirstOrThrow();
    const otherBranch = await prisma.branch.create({
      data: { code: 'WD', name: 'Woodlands (E2E)', address: 'Woodlands', operatingHours: '9-9' },
    });
    const otherFloor = await prisma.floor.create({ data: { branchId: otherBranch.id, level: 1, name: 'L1' } });
    const otherUnit = await prisma.unit.create({
      data: { branchId: otherBranch.id, floorId: otherFloor.id, sizeId: size.id, unitCode: 'WD-E2E-01', sqft: 50, monthlyRate: 99, status: 'AVAILABLE', climateControl: 'Ambient' },
    });
    const otherTenant = await prisma.tenant.create({
      data: { name: 'E2E Mover WD', email: uniqueEmail(), unitId: otherUnit.id, moveInDate: new Date('2026-09-14T00:00:00.000Z'), monthlyRate: 99, psf: 1.98, status: 'ACTIVE', branchId: otherBranch.id },
    });
    const otherCase = await recordCase(owner.auth, {
      tenantId: otherTenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });

    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const ownCase = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });

    // Scoped role with case create/update/view.
    const role = (
      await api.post(`${CMS}/roles`).set('Authorization', owner.auth).send({
        name: 'E2E Mover',
        permissions: ['customer-moveouts:view', 'customer-moveouts:create', 'customer-moveouts:update'],
      })
    ).body.data;
    const scoped = await createOperator(role.id);
    await prisma.operatorFacilityAccess.create({
      data: { adminUserId: scoped.id, branchId: w.branchId, scope: 'FACILITY' },
    });

    const list = (await api.get(`${CMS}/move-out-cases`).set('Authorization', scoped.auth)).body.data;
    expect(list.map((c: { id: string }) => c.id)).toEqual([ownCase.id]);
    expect((await api.get(`${CMS}/move-out-cases/${otherCase.id}`).set('Authorization', scoped.auth)).status).toBe(404);
    expect((await api.get(`${CMS}/move-out-cases/${ownCase.id}`).set('Authorization', scoped.auth)).status).toBe(200);
    // A create outside the scope behaves as not found (repo convention:
    // out-of-scope records 404 everywhere — see cms-facility-scope.test.ts).
    const refused = await api.post(`${CMS}/move-out-cases`).set('Authorization', scoped.auth).send({
      tenantId: otherTenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    expect(refused.status).toBe(404);
  });
});

describe('R4 billing guard', () => {
  it('runBilling bills nothing for months after the final access date', async () => {
    await resetDb();
    const w = await seedWorld();
    const owner = await createOperator('OWNER');

    const unit = await makeUnit(w, 200);
    const tenant = await makeTenant(w, unit.id, 200);
    // Final access mid-previous-month; the case stays open (inspection due).
    const now = new Date();
    const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const prev15 = new Date(Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth() - 1, 15));
    const prev01 = new Date(Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth() - 1, 1));
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const billingMonth = ymd(firstOfMonth).slice(0, 7);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: ymd(prev15),
      requestReceivedAt: ymd(prev01),
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    // Simulate the rental still being carried ACTIVE (edge/legacy) — the R4
    // guard must skip it anyway.
    await prisma.tenant.update({ where: { id: tenant.id }, data: { status: 'ACTIVE' } });

    const run = await api
      .post(`${CMS}/finance/billing-run`)
      .set('Authorization', owner.auth)
      .send({ branchId: w.branchId, billingMonth });
    expect(run.status).toBe(200);
    expect(run.body.data.created).toBe(0);
    expect(run.body.data.reused).toBe(0);
    expect(JSON.stringify(run.body.data.skipped)).toMatch(new RegExp(`Move-out ${c.caseNumber}`));

    // Reversal lifts the guard: the rental bills again.
    await api.post(`${CMS}/move-out-cases/${c.id}/reverse`).set('Authorization', owner.auth).send({ reason: 'Back on' });
    const run2 = await api
      .post(`${CMS}/finance/billing-run`)
      .set('Authorization', owner.auth)
      .send({ branchId: w.branchId, billingMonth });
    expect(run2.body.data.created).toBe(1);
  });
});

describe('R2 portal bridge', () => {
  it('keeps the POST /customer/notice response byte-identical', async () => {
    await resetDb();
    const w = await seedWorld();

    const email = uniqueEmail();
    const reg = await api.post('/api/v1/customer/register').send({
      name: 'E2E Portal Mover',
      email,
      mobile: '81234567',
      password: 'e2e-portal-move-1',
      type: 'PERSONAL',
    });
    expect(reg.status).toBe(201);
    const token = reg.body.data.token as string;
    const unit = await makeUnit(w, 320);
    await makeTenant(w, unit.id, 320, email);

    const lastDay = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const first = await api
      .post('/api/v1/customer/notice')
      .set('Authorization', `Bearer ${token}`)
      .send({ unitId: unit.unitCode, lastDay });
    expect(first.status).toBe(200);

    // Fixture comparison: rebuild the legacy shape straight from the DB row.
    const row = await prisma.notice.findFirstOrThrow({ where: { tenantId: (await prisma.tenant.findFirstOrThrow({ where: { email } })).id }, include: { unit: true }, orderBy: { createdAt: 'desc' } });
    const expected = {
      status: 'SUBMITTED',
      lastDay: row.lastDay.toISOString(),
      id: row.id,
      unitId: row.unitId,
      unitCode: row.unit.unitCode,
      submittedAt: row.createdAt.toISOString(),
    };
    expect(JSON.stringify(first.body.data)).toBe(JSON.stringify(expected));

    // ...and the bridge created the canonical case behind it.
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { email } });
    expect(tenant.status).toBe('NOTICE');
    const cases = await prisma.moveOutCase.findMany({ where: { tenantId: tenant.id } });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      requestChannel: 'Customer portal',
      reasonCode: 'Other',
      requestReceivedAt: new Date(`${sgCalendarDate(new Date())}T00:00:00.000Z`),
      noticeId: row.id,
    });
    expect(cases[0].finalAccessDate.toISOString().slice(0, 10)).toBe(lastDay.slice(0, 10));

    // A new portal date becomes a `Customer portal update` date change.
    const later = new Date(Date.now() + 45 * 86_400_000).toISOString();
    const second = await api
      .post('/api/v1/customer/notice')
      .set('Authorization', `Bearer ${token}`)
      .send({ unitId: unit.unitCode, lastDay: later });
    expect(second.status).toBe(200);
    const row2 = await prisma.notice.findFirstOrThrow({ include: { unit: true }, orderBy: { createdAt: 'desc' } });
    const expected2 = {
      status: 'SUBMITTED',
      lastDay: row2.lastDay.toISOString(),
      id: row2.id,
      unitId: row2.unitId,
      unitCode: row2.unit.unitCode,
      submittedAt: row2.createdAt.toISOString(),
    };
    expect(JSON.stringify(second.body.data)).toBe(JSON.stringify(expected2));
    expect(await prisma.moveOutCase.count({ where: { tenantId: tenant.id } })).toBe(1);
    const changes = await prisma.moveOutDateChange.findMany({ where: { caseId: cases[0].id } });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ reason: 'Customer portal update', byCustomer: true });

    // A backdated portal date stays legacy-only (no case, response unchanged).
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const third = await api
      .post('/api/v1/customer/notice')
      .set('Authorization', `Bearer ${token}`)
      .send({ unitId: unit.unitCode, lastDay: past });
    expect(third.status).toBe(200);
    expect(await prisma.moveOutCase.count({ where: { tenantId: tenant.id } })).toBe(1);
    expect(await prisma.moveOutDateChange.count({ where: { caseId: cases[0].id } })).toBe(1);
  });
});

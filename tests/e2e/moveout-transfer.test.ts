// Track A A5 — unit transfers end-to-end through the API.
//
// Handoff §11 (transfer rules/formulas win) + §11.5 worked example:
// transfer 20 Nov 2026, 30-day month, transfer days 11,
// source S$547.20 → credit 200.64, dest S$661.50 → charge 242.55,
// net S$41.91 amount due. Every expected value is hand-derived
// integer-cents arithmetic; no client total is ever sent.
//
// Traceability — handoff §21 transfer cases 1–9 (pure-calc cover lives in
// tests/e2e/lifecycle-calc.test.ts `handoff §21 transfer cases`; the API
// mapping per case is listed here):
//   T1 effective day included in source+dest periods → preview pins 11/30
//     days and the §11.5 credit/charge pair (§11.5 worked-example test).
//   T2 actual calendar days used → calc-level only (lifecycle-calc T2 pins
//     30/31-day months); the API preview shares the same engine + route,
//     and the worked-example test already pins daysInMonth: 30, so a second
//     API preview would duplicate that path.
//   T3 source deposit offsets destination deposit → deposit-carryover test
//     (dest deposit + exception legs through the shared posting writer).
//   T4 Protection Plan carry-forward is zero mid-month → asserted on the
//     preview (protectionAdjustment: 0).
//   T5 cheaper destination produces customer credit → cheaper-destination
//     credit test below (ACCOUNT_CREDIT −210.00 through preview → execute);
//     the zero-net test pins the T5 ZERO boundary (approval still required).
//   T6 same source/destination rejected → D9 guard test (400 self-transfer).
//   T7 active destination rejected → D9 guard test (409 BLOCKED destination
//     + 409 destination occupied by another active rental).
//   T8 duplicate open source transfer rejected → idempotent-resubmit test
//     (same-key 200 deduplicated, second-source 409 names the open ref).
//   T9 posting is atomic and idempotent → atomic-execute test (pointer,
//     units, ledger, history, events, replay) hardened by the injected
//     mid-posting ledger-fault test (zero partial rows, retryable).
// Scenario D (unit transfer with Finance correction) steps:
//   D1 preview proration → worked-example preview test.
//   D2 submit, source remains active → asserted post-submit in the
//     cheaper-destination credit test (tenant pointer still on source).
//   D3 Finance correction with category/assignee/due date → change-request
//     test (category + assignTeam + assigneeId + due date stored).
//   D4 Operations queue + customer timeline show it → same test (status
//     filter lists it; tenant notes carry the Returned-to-Operations entry).
//   D5 correct + resubmit, same id + new snapshot → same test (calcVersion 2,
//     CHANGES_REQUESTED → PENDING_APPROVAL, request ADDRESSED).
//   D6 Finance approves/posts → approve + execute tests.
//   D7 destination active, source in Previous units, destination next
//     deduction, source/destination ledger lines → execute test (pointer,
//     statuses, ledger, RentalUnitHistory) + billing test (skip transfer
//     month, full destination rent next month).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PIN, api, createOperator, prisma, resetDb, seedMoveInWorld, uniqueEmail, type Operator } from './fixtures';
import { runBilling } from '../../src/core/finance/billing';
import { sgCalendarDate } from '../../src/core/lifecycle/moveOutCalc';

// A-17: pin the JS clock so the SG effective-date guard is deterministic.
// Only the Date constructor is faked (timers/sockets keep working); every
// execute below posts with SG today 2026-11-21, so the fixed 2026-11-20
// §11.5 fixtures stay due while far-future dates stay blocked.
const PINNED_NOW = new Date('2026-11-21T00:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PINNED_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// One-shot fault at the ledger/history-write seam inside the execute
// transaction (atomicity proof). Hoisted so the vi.mock factory can see it;
// armed only inside the forced-failure test and auto-disarmed when it fires,
// so no other test can observe it.
const ledgerFault = vi.hoisted(() => ({ failOnce: false }));

vi.mock('../../src/core/lifecycle/settleFinance', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/core/lifecycle/settleFinance')>();
  return {
    ...mod,
    postSettlementLedger: async (
      db: Parameters<typeof mod.postSettlementLedger>[0],
      s: Parameters<typeof mod.postSettlementLedger>[1],
      input: Parameters<typeof mod.postSettlementLedger>[2],
      actor: string,
    ) => {
      if (ledgerFault.failOnce) {
        ledgerFault.failOnce = false;
        throw new Error('E2E injected fault at the ledger/history-write seam');
      }
      return mod.postSettlementLedger(db, s, input, actor);
    },
  };
});

const CMS = '/api/v1/cms';
const EFFECTIVE = '2026-11-20';
const SOURCE_RENT = 547.2;
const DEST_RENT = 661.5;

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
async function makeUnit(w: World, rate: number, status: 'AVAILABLE' | 'OCCUPIED' | 'BLOCKED' | 'MAINTENANCE' = 'AVAILABLE') {
  unitSeq += 1;
  return prisma.unit.create({
    data: {
      branchId: w.branchId,
      floorId: w.floorId,
      sizeId: w.sizeId,
      unitCode: `TR-E2E-${unitSeq}`,
      sqft: 50,
      monthlyRate: rate,
      status,
      climateControl: 'Ambient climate',
    },
  });
}

async function makeTenant(w: World, unitId: string, rate: number, email = uniqueEmail()) {
  return prisma.tenant.create({
    data: {
      name: 'E2E Transfer',
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

async function requestAs(auth: string, tenantId: string, body: Record<string, unknown>) {
  return api.post(`${CMS}/transfers`).set('Authorization', auth).send({ tenantId, ...body });
}

async function setupTransfer(w: World, op: Operator) {
  const source = await makeUnit(w, SOURCE_RENT);
  const dest = await makeUnit(w, DEST_RENT);
  const tenant = await makeTenant(w, source.id, SOURCE_RENT);
  const res = await requestAs(op.auth, tenant.id, { toUnitId: dest.id, effectiveDate: EFFECTIVE });
  expect(res.status).toBe(201);
  return { source, dest, tenant, settlement: res.body.data.settlement };
}

describe('transfer preview — shares the execute computation', () => {
  let w: World;
  let op: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    op = await createOperator('FINANCE_OPERATOR');
  });

  it('previews the §11.5 worked example: 11/30 days, credit 200.64, charge 242.55, net 41.91', async () => {
    const source = await makeUnit(w, SOURCE_RENT);
    const dest = await makeUnit(w, DEST_RENT);
    const tenant = await makeTenant(w, source.id, SOURCE_RENT);
    const res = await api
      .post(`${CMS}/transfers/preview`)
      .set('Authorization', op.auth)
      .send({ tenantId: tenant.id, toUnitId: dest.id, effectiveDate: EFFECTIVE });
    expect(res.status).toBe(200);
    // Hand-derived: 54720 × 11 ÷ 30 = 20064 → 200.64; 66150 × 11 ÷ 30 = 24255 → 242.55.
    expect(res.body.data).toMatchObject({
      kind: 'TRANSFER',
      daysInMonth: 30,
      transferDays: 11,
      sourceNetMonthlyRent: SOURCE_RENT,
      sourceCredit: 200.64,
      destRackGrossMonthly: DEST_RENT,
      destNetMonthly: DEST_RENT,
      destProratedRent: 242.55,
      protectionAdjustment: 0,
      netAdjustment: 41.91,
      outcome: 'AMOUNT_DUE',
    });
  });

  it('rejects a non-AVAILABLE destination (D9), self-transfers and missing dates', async () => {
    const source = await makeUnit(w, SOURCE_RENT);
    const blocked = await makeUnit(w, DEST_RENT, 'BLOCKED');
    const tenant = await makeTenant(w, source.id, SOURCE_RENT);
    const body = { tenantId: tenant.id, effectiveDate: EFFECTIVE };
    expect((await requestAs(op.auth, tenant.id, { ...body, toUnitId: blocked.id })).status).toBe(409);
    expect((await requestAs(op.auth, tenant.id, { ...body, toUnitId: source.id })).status).toBe(400);
    expect((await api.post(`${CMS}/transfers/preview`).set('Authorization', op.auth).send(body)).status).toBe(400);
  });

  it('rejects an AVAILABLE destination that holds another active rental (§21 T7)', async () => {
    // Same guard family as the D9 status check, but a distinct code path:
    // the unit reads AVAILABLE yet an ACTIVE rental sits on it.
    const source = await makeUnit(w, SOURCE_RENT);
    const taken = await makeUnit(w, DEST_RENT);
    await makeTenant(w, taken.id, DEST_RENT);
    const tenant = await makeTenant(w, source.id, SOURCE_RENT);
    const res = await requestAs(op.auth, tenant.id, { toUnitId: taken.id, effectiveDate: EFFECTIVE });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/not available/);
  });

  it('an identical resubmit is idempotent; a second source transfer 409s with the open ref', async () => {
    const { tenant, dest, settlement } = await setupTransfer(w, op);
    expect(settlement.ref).toMatch(/^TRF-\d{7}$/);
    const again = await requestAs(op.auth, tenant.id, { toUnitId: dest.id, effectiveDate: EFFECTIVE });
    expect(again.status).toBe(200);
    expect(again.body.data.deduplicated).toBe(true);
    expect(again.body.data.settlement.ref).toBe(settlement.ref);
    const other = await makeUnit(w, 500);
    const clash = await requestAs(op.auth, tenant.id, { toUnitId: other.id, effectiveDate: EFFECTIVE });
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toContain(settlement.ref);
  });
});

describe('transfer approvals — maker-checker, version guard, Finance round-trip', () => {
  let w: World;
  let op: Operator;
  let approver: Operator;
  let executor: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    op = await createOperator('FINANCE_OPERATOR');
    approver = await createOperator('FINANCE_APPROVER');
    executor = await createOperator('FINANCE_APPROVER');
  });

  it('requester cannot approve (403); approver can; double approve 409s; stale version 409s', async () => {
    const { settlement } = await setupTransfer(w, op);
    const id = settlement.id as string;
    expect((await api.post(`${CMS}/transfers/${id}/approve`).set('Authorization', op.auth).send({})).status).toBe(403);
    const stale = await api
      .post(`${CMS}/transfers/${id}/approve`)
      .set('Authorization', approver.auth)
      .send({ expectedVersion: 999 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE');
    const ok = await api.post(`${CMS}/transfers/${id}/approve`).set('Authorization', approver.auth).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data.settlement.status).toBe('APPROVED');
    expect((await api.post(`${CMS}/transfers/${id}/approve`).set('Authorization', executor.auth).send({})).status).toBe(409);
  });

  it('allows an Owner single-step with reason, audited — and blocks it without one', async () => {
    const owner = await createOperator('OWNER');
    const source = await makeUnit(w, SOURCE_RENT);
    const dest = await makeUnit(w, DEST_RENT);
    const tenant = await makeTenant(w, source.id, SOURCE_RENT);
    // Owner requests, then single-steps their own request: no reason → 400.
    const own = await requestAs(owner.auth, tenant.id, { toUnitId: dest.id, effectiveDate: EFFECTIVE });
    expect(own.status).toBe(201);
    const ownId = own.body.data.settlement.id as string;
    const noReason = await api.post(`${CMS}/transfers/${ownId}/approve`).set('Authorization', owner.auth).send({});
    expect(noReason.status).toBe(400);
    // With a reason the Owner bypasses maker-checker, audited.
    const bypass = await api
      .post(`${CMS}/transfers/${ownId}/approve`)
      .set('Authorization', owner.auth)
      .send({ reason: 'Owner single-step: customer waiting on-site.' });
    expect(bypass.status).toBe(200);
    expect(bypass.body.data.bypassed).toBe(true);
    const audit = await prisma.financeAuditEvent.findFirst({
      where: { entityId: ownId, action: 'transfer.approved' },
    });
    expect(audit?.after).toMatchObject({ bypassed: true });
  });

  it('change-request needs a due date; correct recomputes and returns to approval', async () => {
    const { settlement, tenant } = await setupTransfer(w, op);
    const id = settlement.id as string;
    const noDue = await api
      .post(`${CMS}/transfers/${id}/changes`)
      .set('Authorization', approver.auth)
      .send({ note: 'Confirm the promotion.' });
    expect(noDue.status).toBe(400);
    // Scenario D step 3: category + assignee + due date travel together.
    const back = await api.post(`${CMS}/transfers/${id}/changes`).set('Authorization', approver.auth).send({
      note: 'Move the effective date one day later.',
      category: 'Unit or transfer date',
      assignTeam: 'Operations',
      assigneeId: op.id,
      dueDate: '2026-11-25',
    });
    expect(back.status).toBe(200);
    expect(back.body.data.settlement.status).toBe('CHANGES_REQUESTED');
    expect(back.body.data.settlement.changeRequests[0]).toMatchObject({
      status: 'OPEN',
      category: 'Unit or transfer date',
      assignTeam: 'Operations',
      assigneeId: op.id,
    });
    expect(String(back.body.data.settlement.changeRequests[0].dueDate)).toContain('2026-11-25');
    // Scenario D step 4: the Operations queue and the customer timeline show it.
    const queue = await api.get(`${CMS}/transfers`).query({ status: 'CHANGES_REQUESTED' }).set('Authorization', approver.auth);
    expect(queue.status).toBe(200);
    expect(queue.body.data.map((r: { ref: string }) => r.ref)).toContain(settlement.ref);
    const owner = await createOperator('OWNER');
    const timeline = await api.get(`${CMS}/tenants/${tenant.id}/notes`).set('Authorization', owner.auth);
    expect(timeline.status).toBe(200);
    expect(timeline.body.data.map((n: { body: string }) => n.body).join('\n')).toMatch(/Returned to Operations/);
    // New effective date 21 Nov → 10/30 days: credit 182.40, charge 220.50, net 38.10.
    const fixed = await api.post(`${CMS}/transfers/${id}/correct`).set('Authorization', op.auth).send({
      response: 'Date moved per Finance; dest unchanged.',
      effectiveDate: '2026-11-21',
    });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.settlement).toMatchObject({ status: 'PENDING_APPROVAL', amount: 38.1, calcVersion: 2 });
    expect(fixed.body.data.settlement.changeRequests[0]).toMatchObject({ status: 'ADDRESSED' });
  });

  // A-21: a Finance change request is also an Operations work item — the
  // chosen assignee is notified through the existing StaffNotification path
  // while the tenant timeline and the ops queues list the return.
  it('A-21: change request notifies the assignee + RecordNote + ops queues', async () => {
    const owner = await createOperator('OWNER');
    const { settlement, tenant } = await setupTransfer(w, op);
    const id = settlement.id as string;
    // Unknown assignee fails fast — no partial return, no dangling assignee.
    const bad = await api.post(`${CMS}/transfers/${id}/changes`).set('Authorization', approver.auth).send({
      note: 'Move the effective date one day later.',
      assigneeId: 'no-such-operator',
      dueDate: '2026-11-25',
    });
    expect(bad.status).toBe(400);
    expect((await api.get(`${CMS}/transfers/${id}`).set('Authorization', approver.auth)).body.data.status).toBe(
      'PENDING_APPROVAL',
    );
    const back = await api.post(`${CMS}/transfers/${id}/changes`).set('Authorization', approver.auth).send({
      note: 'Move the effective date one day later.',
      category: 'Unit or transfer date',
      assignTeam: 'Operations',
      assigneeId: op.id,
      dueDate: '2026-11-25',
    });
    expect(back.status).toBe(200);
    // StaffNotification exists for the assignee (existing notification path).
    const notes = await prisma.staffNotification.findMany({ where: { recipientId: op.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'CHANGE_REQUEST', entityType: 'tenant', entityId: tenant.id });
    expect(notes[0].title).toContain(settlement.ref);
    // Visible in the assignee's notification queue…
    const mine = await api.get(`${CMS}/notifications`).set('Authorization', op.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.data.rows.map((n: { title: string }) => n.title).join('\n')).toContain(settlement.ref);
    // …RecordNote on the tenant timeline…
    const timeline = await api.get(`${CMS}/tenants/${tenant.id}/notes`).set('Authorization', owner.auth);
    expect(timeline.status).toBe(200);
    expect(timeline.body.data.map((n: { body: string }) => n.body).join('\n')).toMatch(/Returned to Operations/);
    // …the Operations queue readout…
    const queue = await api.get(`${CMS}/transfers`).query({ status: 'CHANGES_REQUESTED' }).set('Authorization', approver.auth);
    expect(queue.status).toBe(200);
    expect(queue.body.data.map((r: { ref: string }) => r.ref)).toContain(settlement.ref);
    // …and the Command centre queue.
    const actions = await api.get(`${CMS}/action-items`).set('Authorization', owner.auth);
    expect(actions.status).toBe(200);
    expect(actions.body.data.map((a: { title: string }) => a.title).join('\n')).toContain(settlement.ref);
  });

  // A-21: a team-only return (no assignee) notifies nobody but stays
  // team-visible in the ops queues.
  it('A-21: team-only change request creates no notification but stays team-visible', async () => {
    const owner = await createOperator('OWNER');
    const { settlement } = await setupTransfer(w, op);
    const id = settlement.id as string;
    const back = await api.post(`${CMS}/transfers/${id}/changes`).set('Authorization', approver.auth).send({
      note: 'Confirm the promotion.',
      category: 'Pricing or promotion',
      assignTeam: 'Operations',
      dueDate: '2026-11-25',
    });
    expect(back.status).toBe(200);
    expect(back.body.data.settlement.changeRequests[0]).toMatchObject({ assignTeam: 'Operations', assigneeId: null });
    expect(await prisma.staffNotification.count()).toBe(0);
    const queue = await api.get(`${CMS}/transfers`).query({ status: 'CHANGES_REQUESTED' }).set('Authorization', approver.auth);
    expect(queue.body.data.map((r: { ref: string }) => r.ref)).toContain(settlement.ref);
    const actions = await api.get(`${CMS}/action-items`).set('Authorization', owner.auth);
    expect(actions.body.data.map((a: { title: string }) => a.title).join('\n')).toContain(settlement.ref);
  });

  it('the generic settlement approve/reject paths redirect transfers to the transfer flow', async () => {
    const { settlement } = await setupTransfer(w, op);
    const id = settlement.id as string;
    const viaApprove = await api.post(`/api/v1/cms/finance/settlements/${id}/approve`).set('Authorization', approver.auth).send({});
    expect(viaApprove.status).toBe(409);
    expect(viaApprove.body.error.details).toMatchObject({ pointer: `/api/v1/cms/transfers/${id}/approve` });
    const viaReject = await api.post(`/api/v1/cms/finance/settlements/${id}/reject`).set('Authorization', approver.auth).send({ note: 'x' });
    expect(viaReject.status).toBe(409);
    expect(viaReject.body.error.details).toMatchObject({ pointer: `/api/v1/cms/transfers/${id}/changes` });
  });
});

describe('transfer execute — atomic posting, idempotent, ledger carryover', () => {
  let w: World;
  let op: Operator;
  let approver: Operator;
  let executor: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    op = await createOperator('FINANCE_OPERATOR');
    approver = await createOperator('FINANCE_APPROVER');
    executor = await createOperator('FINANCE_APPROVER');
  });

  async function approve(id: string) {
    const res = await api.post(`${CMS}/transfers/${id}/approve`).set('Authorization', approver.auth).send({});
    expect(res.status).toBe(200);
    return res.body.data.settlement;
  }

  it('enforces the three-party rule: requester and approver cannot execute', async () => {
    const { settlement } = await setupTransfer(w, op);
    await approve(settlement.id);
    expect((await api.post(`${CMS}/transfers/${settlement.id}/execute`).set('Authorization', op.auth).send({})).status).toBe(403);
    expect(
      (await api.post(`${CMS}/transfers/${settlement.id}/execute`).set('Authorization', approver.auth).send({})).status,
    ).toBe(403);
  });

  it('executes atomically: pointer moved, units flipped, ledger + history posted, then replays idempotently', async () => {
    const { source, dest, tenant, settlement } = await setupTransfer(w, op);
    await approve(settlement.id);
    const done = await api.post(`${CMS}/transfers/${settlement.id}/execute`).set('Authorization', executor.auth).send({});
    expect(done.status).toBe(200);
    expect(done.body.data.settlement.status).toBe('POSTED');
    expect(done.body.data.message).toContain(settlement.ref);

    const moved = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(moved.unitId).toBe(dest.id);
    expect(Number(moved.monthlyRate)).toBe(DEST_RENT);
    expect(Number(moved.psf)).toBeCloseTo(DEST_RENT / 50, 4);
    expect((await prisma.unit.findUniqueOrThrow({ where: { id: source.id } })).status).toBe('AVAILABLE');
    expect((await prisma.unit.findUniqueOrThrow({ where: { id: dest.id } })).status).toBe('OCCUPIED');

    const lines = await prisma.customerLedgerEntry.findMany({
      where: { settlementId: settlement.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(lines.map((l) => [l.entryType, l.unitId, Number(l.credit ?? 0), Number(l.debit ?? 0), l.status])).toEqual([
      ['TRANSFER_CREDIT', source.id, 200.64, 0, 'Transferred'],
      ['TRANSFER_DEBIT', dest.id, 0, 242.55, 'Active'],
    ]);

    const history = await prisma.rentalUnitHistory.findFirstOrThrow({ where: { sourceSettlementId: settlement.id } });
    expect(history).toMatchObject({ tenantId: tenant.id, unitId: source.id, endReason: 'TRANSFER', replacementUnitId: dest.id });
    expect(Number(history.transferCredit)).toBe(200.64);

    const events = await prisma.financeEvent.findMany({ where: { type: { startsWith: 'transfer.' } }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.type)).toEqual(['transfer.requested', 'transfer.approved', 'transfer.executed']);

    const replay = await api.post(`${CMS}/transfers/${settlement.id}/execute`).set('Authorization', executor.auth).send({});
    expect(replay.status).toBe(200);
    expect(replay.body.data.deduplicated).toBe(true);
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId: settlement.id } })).toBe(2);
  });

  it('carries deposits and the approved exception through the shared posting writer', async () => {
    const source = await makeUnit(w, SOURCE_RENT);
    const dest = await makeUnit(w, DEST_RENT);
    const tenant = await makeTenant(w, source.id, SOURCE_RENT);
    const res = await requestAs(op.auth, tenant.id, {
      toUnitId: dest.id,
      effectiveDate: EFFECTIVE,
      destDeposit: 50,
      exceptionAdjustment: { type: 'CHARGE', category: 'Other', amount: 10, reason: 'Deep clean top-up' },
    });
    expect(res.status).toBe(201);
    // 242.55 − 200.64 + 50 + 10 = 101.91.
    expect(res.body.data.settlement.amount).toBe(101.91);
    await approve(res.body.data.settlement.id);
    const done = await api
      .post(`${CMS}/transfers/${res.body.data.settlement.id}/execute`)
      .set('Authorization', executor.auth)
      .send({});
    expect(done.status).toBe(200);
    const lines = await prisma.customerLedgerEntry.findMany({
      where: { settlementId: res.body.data.settlement.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(lines.map((l) => [l.entryType, Number(l.credit ?? 0), Number(l.debit ?? 0), l.status])).toEqual([
      ['TRANSFER_CREDIT', 200.64, 0, 'Transferred'],
      ['TRANSFER_DEBIT', 0, 242.55, 'Active'],
      ['TRANSFER_DEBIT', 0, 50, 'Active'],
      ['TRANSFER_DEBIT', 0, 10, 'Active'],
    ]);
    expect(lines[3]!.label).toContain('Deep clean top-up');
  });

  it('posts a zero-net transfer (approval still required for the unit change)', async () => {
    const source = await makeUnit(w, 500);
    const dest = await makeUnit(w, 500);
    const tenant = await makeTenant(w, source.id, 500);
    const res = await requestAs(op.auth, tenant.id, { toUnitId: dest.id, effectiveDate: EFFECTIVE });
    expect(res.status).toBe(201);
    expect(res.body.data.settlement.amount).toBe(0);
    await approve(res.body.data.settlement.id);
    const done = await api
      .post(`${CMS}/transfers/${res.body.data.settlement.id}/execute`)
      .set('Authorization', executor.auth)
      .send({});
    expect(done.status).toBe(200);
    expect(done.body.data.settlement.status).toBe('POSTED');
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId: res.body.data.settlement.id } })).toBe(2);
  });

  it('posts a cheaper-destination transfer as an account credit (§21 T5)', async () => {
    // Effective 10 Nov 2026 (30 days): 30−10+1 = 21 transfer days.
    // Source S$800: 80000×21÷30 = 56000 → S$560.00 credit.
    // Dest S$500: 50000×21÷30 = 35000 → S$350.00 charge.
    // Net 350 − 560 = −S$210.00 customer credit (ACCOUNT_CREDIT).
    const source = await makeUnit(w, 800);
    const dest = await makeUnit(w, 500);
    const tenant = await makeTenant(w, source.id, 800);
    const preview = await api
      .post(`${CMS}/transfers/preview`)
      .set('Authorization', op.auth)
      .send({ tenantId: tenant.id, toUnitId: dest.id, effectiveDate: '2026-11-10' });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ outcome: 'ACCOUNT_CREDIT', netAdjustment: -210, sourceCredit: 560, destProratedRent: 350 });
    const submitted = await requestAs(op.auth, tenant.id, { toUnitId: dest.id, effectiveDate: '2026-11-10' });
    expect(submitted.status).toBe(201);
    const tid = submitted.body.data.settlement.id as string;
    // Scenario D step 2: the source rental stays active until posting.
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).unitId).toBe(source.id);
    await approve(tid);
    const done = await api.post(`${CMS}/transfers/${tid}/execute`).set('Authorization', executor.auth).send({});
    expect(done.status).toBe(200);
    expect(done.body.data.settlement).toMatchObject({ status: 'POSTED', amount: -210 });
    const lines = await prisma.customerLedgerEntry.findMany({
      where: { settlementId: tid },
      orderBy: { createdAt: 'asc' },
    });
    expect(lines.map((l) => [l.entryType, l.unitId, Number(l.credit ?? 0), Number(l.debit ?? 0), l.status])).toEqual([
      ['TRANSFER_CREDIT', source.id, 560, 0, 'Transferred'],
      ['TRANSFER_DEBIT', dest.id, 0, 350, 'Active'],
    ]);
    const moved = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(moved.unitId).toBe(dest.id);
    expect(Number(moved.monthlyRate)).toBe(500);
  });

  it('a mid-posting ledger failure leaves zero partial rows and stays retryable (§21 T9)', async () => {
    const { source, dest, tenant, settlement } = await setupTransfer(w, op);
    const approved = await approve(settlement.id as string);
    const versionBeforeExecute = approved.version as number;
    // Inject the fault at the ledger/history-write seam: the CAS to POSTED,
    // unit flips, ledger, history, notes and events all sit in ONE
    // transaction, so the throw must roll every one of them back.
    ledgerFault.failOnce = true;
    const failed = await api.post(`${CMS}/transfers/${settlement.id}/execute`).set('Authorization', executor.auth).send({});
    expect(failed.status).toBe(500);
    // Zero partial rows: no ledger lines, no history, no executed event.
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId: settlement.id } })).toBe(0);
    expect(await prisma.rentalUnitHistory.count({ where: { sourceSettlementId: settlement.id } })).toBe(0);
    expect(await prisma.financeEvent.count({ where: { type: 'transfer.executed' } })).toBe(0);
    // Pointer unmoved, units untouched, status unchanged and retryable.
    const detail = await api.get(`${CMS}/transfers/${settlement.id}`).set('Authorization', op.auth);
    expect(detail.body.data).toMatchObject({ status: 'APPROVED', version: versionBeforeExecute, processingError: null });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).unitId).toBe(source.id);
    expect((await prisma.unit.findUniqueOrThrow({ where: { id: source.id } })).status).toBe('AVAILABLE');
    expect((await prisma.unit.findUniqueOrThrow({ where: { id: dest.id } })).status).toBe('AVAILABLE');
    // Retry with the fault disarmed posts exactly once.
    const done = await api.post(`${CMS}/transfers/${settlement.id}/execute`).set('Authorization', executor.auth).send({});
    expect(done.status).toBe(200);
    expect(done.body.data.settlement.status).toBe('POSTED');
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId: settlement.id } })).toBe(2);
    expect(await prisma.rentalUnitHistory.count({ where: { sourceSettlementId: settlement.id } })).toBe(1);
  });

  it('a destination taken before execute returns the transfer for changes (R10, no hold)', async () => {
    const { settlement } = await setupTransfer(w, op);
    await approve(settlement.id);
    await prisma.unit.update({ where: { id: settlement.destUnit.id }, data: { status: 'OCCUPIED' } });
    const done = await api.post(`${CMS}/transfers/${settlement.id}/execute`).set('Authorization', executor.auth).send({});
    expect(done.status).toBe(409);
    expect(done.body.error.message).toMatch(/returned for changes/);
    const detail = await api.get(`${CMS}/transfers/${settlement.id}`).set('Authorization', op.auth);
    expect(detail.body.data.status).toBe('CHANGES_REQUESTED');
  });
});

describe('transfer effective-date guard — A-17 (block early posting)', () => {
  let w: World;
  let op: Operator;
  let approver: Operator;
  let executor: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    op = await createOperator('FINANCE_OPERATOR');
    approver = await createOperator('FINANCE_APPROVER');
    executor = await createOperator('FINANCE_APPROVER');
  });

  async function approve(id: string) {
    const res = await api.post(`${CMS}/transfers/${id}/approve`).set('Authorization', approver.auth).send({});
    expect(res.status).toBe(200);
    return res.body.data.settlement;
  }

  it('blocks execute before the SG effective date: 409, zero partial rows, audited', async () => {
    // SG today is the pinned 2026-11-21; +30 days is always in the future,
    // so this has no wall-clock dependence (mirrors TRF-1000001: effective
    // 1 Dec posted 19 Nov must not swap unit/access/rent early).
    const todayYmd = sgCalendarDate(new Date());
    const futureYmd = addDaysYmd(todayYmd, 30);
    const source = await makeUnit(w, SOURCE_RENT);
    const dest = await makeUnit(w, DEST_RENT);
    const tenant = await makeTenant(w, source.id, SOURCE_RENT);
    const res = await requestAs(op.auth, tenant.id, { toUnitId: dest.id, effectiveDate: futureYmd });
    expect(res.status).toBe(201);
    const id = res.body.data.settlement.id as string;
    await approve(id);
    const blocked = await api.post(`${CMS}/transfers/${id}/execute`).set('Authorization', executor.auth).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain(`takes effect on ${futureYmd}`);
    expect(blocked.body.error.message).toMatch(/stays active/);
    // Zero partial rows: no ledger lines, no history, no unit/pointer moves.
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId: id } })).toBe(0);
    expect(await prisma.rentalUnitHistory.count({ where: { sourceSettlementId: id } })).toBe(0);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).unitId).toBe(source.id);
    expect((await prisma.unit.findUniqueOrThrow({ where: { id: source.id } })).status).toBe('AVAILABLE');
    expect((await prisma.unit.findUniqueOrThrow({ where: { id: dest.id } })).status).toBe('AVAILABLE');
    // Still APPROVED (not posted, not returned) and retryable later.
    const detail = await api.get(`${CMS}/transfers/${id}`).set('Authorization', op.auth);
    expect(detail.body.data.status).toBe('APPROVED');
    // The blocked attempt is audited (and noted on the customer timeline).
    const audit = await prisma.financeAuditEvent.findFirst({
      where: { entityId: id, action: 'transfer.execute_blocked' },
    });
    expect(audit).not.toBeNull();
    expect(String((audit?.after as { effectiveDate?: string })?.effectiveDate ?? '')).toBe(futureYmd);
  });

  it('posts fine on/after the SG effective date', async () => {
    const todayYmd = sgCalendarDate(new Date());
    const source = await makeUnit(w, SOURCE_RENT);
    const dest = await makeUnit(w, DEST_RENT);
    const tenant = await makeTenant(w, source.id, SOURCE_RENT);
    const res = await requestAs(op.auth, tenant.id, { toUnitId: dest.id, effectiveDate: todayYmd });
    expect(res.status).toBe(201);
    const id = res.body.data.settlement.id as string;
    await approve(id);
    const done = await api.post(`${CMS}/transfers/${id}/execute`).set('Authorization', executor.auth).send({});
    expect(done.status).toBe(200);
    expect(done.body.data.settlement.status).toBe('POSTED');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).unitId).toBe(dest.id);
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId: id } })).toBe(2);
  });
});

describe('transfer billing — single charge across the boundary', () => {
  let w: World;
  let op: Operator;
  let approver: Operator;
  let executor: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    op = await createOperator('FINANCE_OPERATOR');
    approver = await createOperator('FINANCE_APPROVER');
    executor = await createOperator('FINANCE_APPROVER');
  });

  it('skips the destination invoice for the transfer month, then bills it in full the next month', async () => {
    const { tenant, settlement } = await setupTransfer(w, op);
    await api.post(`${CMS}/transfers/${settlement.id}/approve`).set('Authorization', approver.auth).send({});
    await api.post(`${CMS}/transfers/${settlement.id}/execute`).set('Authorization', executor.auth).send({});

    const nov = await runBilling({ branchId: w.branchId, billingMonth: '2026-11', actor: 'e2e-finance' });
    expect(nov.created).toBe(0);
    expect(nov.skipped.map((s) => s.reason)).toEqual([expect.stringMatching(/Transfer TRF-\d+/)]);

    const novInvoices = await prisma.invoice.findMany({ where: { tenantId: tenant.id } });
    expect(novInvoices).toHaveLength(0);

    const dec = await runBilling({ branchId: w.branchId, billingMonth: '2026-12', actor: 'e2e-finance' });
    expect(dec.created).toBe(1);
    expect(Number(dec.invoices[0]!.amount)).toBe(DEST_RENT);
  });
});

describe('transfer RBAC + Owner-only replace (D9)', () => {
  let w: World;
  let owner: Operator;
  let op: Operator;
  let approver: Operator;
  let manager: Operator;
  let viewer: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    owner = await createOperator('OWNER');
    op = await createOperator('FINANCE_OPERATOR');
    approver = await createOperator('FINANCE_APPROVER');
    manager = await createOperator('MANAGER');
    viewer = await createOperator('VIEWER');
  });

  it('denies transfers to Viewer/Manager and to operators without the grant', async () => {
    const source = await makeUnit(w, SOURCE_RENT);
    const dest = await makeUnit(w, DEST_RENT);
    const tenant = await makeTenant(w, source.id, SOURCE_RENT);
    expect((await api.get(`${CMS}/transfers`).set('Authorization', viewer.auth)).status).toBe(403);
    expect((await requestAs(manager.auth, tenant.id, { toUnitId: dest.id, effectiveDate: EFFECTIVE })).status).toBe(403);
    const created = await requestAs(op.auth, tenant.id, { toUnitId: dest.id, effectiveDate: EFFECTIVE });
    expect(created.status).toBe(201);
    const id = created.body.data.settlement.id as string;
    expect((await api.get(`${CMS}/transfers/${id}`).set('Authorization', viewer.auth)).status).toBe(403);
    // Finance Operator holds no bill-transactions:approve — approve and execute are denied.
    expect((await api.post(`${CMS}/transfers/${id}/approve`).set('Authorization', op.auth).send({})).status).toBe(403);
  });

  it('rejects non-Owner destination replacement; the Owner swap recomputes the snapshot', async () => {
    const { settlement } = await setupTransfer(w, op);
    const id = settlement.id as string;
    const alt = await makeUnit(w, 600);
    const denied = await api
      .post(`${CMS}/transfers/${id}/replace-destination`)
      .set('Authorization', approver.auth)
      .send({ toUnitId: alt.id, reason: 'Customer prefers upstairs.' });
    expect(denied.status).toBe(403);
    const swapped = await api
      .post(`${CMS}/transfers/${id}/replace-destination`)
      .set('Authorization', owner.auth)
      .send({ toUnitId: alt.id, reason: 'Customer prefers upstairs.' });
    expect(swapped.status).toBe(200);
    // 600 × 11 ÷ 30 = 220.00; 220.00 − 200.64 = 19.36.
    expect(swapped.body.data.settlement).toMatchObject({ amount: 19.36, calcVersion: 2, status: 'PENDING_APPROVAL' });
    expect(swapped.body.data.settlement.destUnit.unitCode).toBe(alt.unitCode);
    const audit = await prisma.financeAuditEvent.findFirst({
      where: { entityId: id, action: 'transfer.destination_replaced' },
    });
    expect(audit).not.toBeNull();
  });
});

describe('transfer A-23 — derived destination promotion + pending-move-out source guard', () => {
  let w: World;
  let op: Operator;
  let owner: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    op = await createOperator('FINANCE_OPERATOR');
    owner = await createOperator('OWNER');
  });

  async function seedPromoPct(pct: number, name = 'E2E Transfer Promo') {
    return prisma.promotionPlan.create({
      data: {
        kind: 'DISCOUNT_MATRIX',
        name,
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
        facilityScope: [w.branchId],
        sizeScope: ['ALL'],
        matrixCells: {
          create: [{ sizeCategory: 'SMALL', accessType: 'Standard', commitmentMonths: 12, discountPct: pct }],
        },
      },
    });
  }

  it('ignores a forged destPromoPct — preview and post recompute from the destination unit', async () => {
    await seedPromoPct(20);
    const source = await makeUnit(w, 500);
    const dest = await makeUnit(w, 1000);
    const tenant = await makeTenant(w, source.id, 500);
    // Forged 50% must not move the maths: derived 20% → net 800/mo.
    // November: 11/30 days — 500 × 11 ÷ 30 = 183.33 credit,
    // 800 × 11 ÷ 30 = 293.33 charge, net 110.00 amount due.
    const preview = await api
      .post(`${CMS}/transfers/preview`)
      .set('Authorization', op.auth)
      .send({ tenantId: tenant.id, toUnitId: dest.id, effectiveDate: EFFECTIVE, destPromoPct: 50 });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      destRackGrossMonthly: 1000,
      destPromoPct: 20,
      destNetMonthly: 800,
      destProratedRent: 293.33,
      sourceCredit: 183.33,
      netAdjustment: 110,
      outcome: 'AMOUNT_DUE',
    });
    expect(preview.body.data.destPromoPlan).toBe('E2E Transfer Promo');
    const submitted = await requestAs(op.auth, tenant.id, {
      toUnitId: dest.id,
      effectiveDate: EFFECTIVE,
      destPromoPct: 50,
    });
    expect(submitted.status).toBe(201);
    expect(submitted.body.data.settlement.amount).toBe(110);
    const snap = submitted.body.data.settlement.calcSnapshot as Record<string, unknown>;
    expect(snap).toMatchObject({ destPromoPct: 20, destPromoPlan: 'E2E Transfer Promo', destRackGrossMonthly: 1000 });
  });

  it('rejects a source rental with an open MoveOutCase — the modal default must skip it', async () => {
    const source = await makeUnit(w, 500);
    const dest = await makeUnit(w, 800);
    const tenant = await makeTenant(w, source.id, 500);
    const c = (
      await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
        tenantId: tenant.id,
        finalAccessDate: '2026-12-15',
        requestReceivedAt: '2026-11-10',
        requestChannel: 'WhatsApp',
        reasonCode: 'No longer needs storage',
      })
    );
    expect(c.status).toBe(201);
    const caseNumber = c.body.data.caseNumber as string;
    // Both preview and submit refuse the pending-move-out rental, naming the
    // open case — so the modal default falls back to the first eligible rental.
    const preview = await api
      .post(`${CMS}/transfers/preview`)
      .set('Authorization', op.auth)
      .send({ tenantId: tenant.id, toUnitId: dest.id, effectiveDate: EFFECTIVE });
    expect(preview.status).toBe(409);
    expect(String(preview.body.error.message)).toContain(caseNumber);
    const submitted = await requestAs(op.auth, tenant.id, { toUnitId: dest.id, effectiveDate: EFFECTIVE });
    expect(submitted.status).toBe(409);
    expect(String(submitted.body.error.message)).toContain(caseNumber);
    // A sibling rental with no open case stays transferable (the fallback).
    const source2 = await makeUnit(w, 500);
    const tenant2 = await makeTenant(w, source2.id, 500, tenant.email);
    const okPreview = await api
      .post(`${CMS}/transfers/preview`)
      .set('Authorization', op.auth)
      .send({ tenantId: tenant2.id, toUnitId: dest.id, effectiveDate: EFFECTIVE });
    expect(okPreview.status).toBe(200);
  });
});

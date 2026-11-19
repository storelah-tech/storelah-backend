// Track A A7 — CMS UI API gate (handoff §3 jump actions, §19 states).
//
// The Track A CMS UI is static JS (no browser harness in this repo), so the
// gate is API-level: every route the UI calls must behave, every §3 jump
// target must exist and be permission-gated, and the retired legacy action
// must keep its 410 contract (the UI holds no trigger for it).
//
// UI-called routes covered here:
//   cases    POST|GET /move-out-cases, POST /move-out-cases/request-preview,
//            GET /:id, GET /:id/preview, POST /:id/inspection-preview,
//            PATCH /:id/date, POST /:id/reverse, POST /:id/inspection
//   transfer POST /transfers/preview, GET|POST /transfers, GET /:id,
//            POST /:id/changes|correct|approve|execute
//   finance  POST /finance/settlements, GET /finance/settlements,
//            GET /finance/settlements/refunds, GET /finance/settlements/:id,
//            POST /:id/approve|reject|correct|process, GET /finance/register
//   profile  GET /tenants/:id/rollup, POST /tenants/:id/status,
//            GET /business-rules, PUT /business-rules,
//            GET /tenants, GET /units?status=AVAILABLE
//   legacy   PATCH /move-outs/:tenantId → 410 (no UI trigger)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PIN, api, createOperator, prisma, resetDb, seedMoveInWorld, uniqueEmail, type Operator } from './fixtures';
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
async function makeUnit(w: World, rate: number) {
  unitSeq += 1;
  return prisma.unit.create({
    data: {
      branchId: w.branchId,
      floorId: w.floorId,
      sizeId: w.sizeId,
      unitCode: `UI-E2E-${unitSeq}`,
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
      name: 'E2E UI',
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

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const INSPECTION = {
  unitEmpty: true,
  doorLockWallsFloorChecked: true,
  accessRevoked: true,
  releaseConfirmed: true,
  releaseStatus: 'READY',
  damageCharge: 0,
  cleaningCharge: 350,
  disposalCharge: 0,
  otherCharge: 0,
  arrearsAmount: 0,
  specialCredit: 0,
  notes: 'Unit empty, light cleaning needed. Evidence: photos 1-3.',
};

describe('A7 UI gate — register, queue and case workspace readouts', () => {
  let w: World;
  let owner: Operator;
  let viewer: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    owner = await createOperator('OWNER');
    viewer = await createOperator('VIEWER');
  });

  it('register lists cases with filters; detail + preview are the jump targets', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const created = (
      await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
        tenantId: tenant.id,
        finalAccessDate: '2026-12-15',
        requestReceivedAt: '2026-11-10',
        requestChannel: CHANNEL,
        reasonCode: REASON,
      })
    );
    expect(created.status).toBe(201);
    const c = created.body.data;
    expect(c.status).toBe('PENDING_MOVE_OUT');

    // Register (Move-out notices + moves queue source).
    const list = await api.get(`${CMS}/move-out-cases`).set('Authorization', owner.auth);
    expect(list.status).toBe(200);
    expect(list.body.data.map((x: { id: string }) => x.id)).toContain(c.id);

    // Filters the register UI wires.
    const byStatus = await api.get(`${CMS}/move-out-cases`).set('Authorization', owner.auth).query({ status: 'PENDING_MOVE_OUT' });
    expect(byStatus.body.data.map((x: { id: string }) => x.id)).toContain(c.id);
    const bySearch = await api.get(`${CMS}/move-out-cases`).set('Authorization', owner.auth).query({ search: c.caseNumber });
    expect(bySearch.body.data.map((x: { id: string }) => x.id)).toContain(c.id);
    const byBranch = await api.get(`${CMS}/move-out-cases`).set('Authorization', owner.auth).query({ branchId: w.branchId });
    expect(byBranch.body.data.map((x: { id: string }) => x.id)).toContain(c.id);
    const badStatus = await api.get(`${CMS}/move-out-cases`).set('Authorization', owner.auth).query({ status: 'NOPE' });
    expect(badStatus.status).toBe(400);

    // Case workspace readout + date-change preview jump targets.
    const detail = await api.get(`${CMS}/move-out-cases/${c.id}`).set('Authorization', owner.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ caseNumber: c.caseNumber, status: 'PENDING_MOVE_OUT' });
    expect(await api.get(`${CMS}/move-out-cases/does-not-exist`).set('Authorization', owner.auth)).toMatchObject({ status: 404 });
    const preview = await api.get(`${CMS}/move-out-cases/${c.id}/preview`).set('Authorization', owner.auth);
    expect(preview.status).toBe(200);
    expect(preview.body.data.caseNumber).toBe(c.caseNumber);
    expect(preview.body.data.calc).toMatchObject({ outcome: expect.any(String) });

    // A-5 register estimate: every list row carries the preview's
    // unused-rent figure (zero charges) — same server maths, no client keying.
    const listed = list.body.data.find((x: { id: string }) => x.id === c.id);
    expect(listed).toMatchObject({ estimatedRentRefund: preview.body.data.calc.unusedRentRefund });

    // Unauthenticated register read is rejected (sign-in gate, §19).
    expect(await api.get(`${CMS}/move-out-cases`)).toMatchObject({ status: 401 });
  });

  it('request-preview: default date, live maths, unit-less rejection, viewer gate', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const previewUrl = `${CMS}/move-out-cases/request-preview`;

    // No final date → request + 30 notice days (booking.moveOutNoticeDays).
    const prev = await api.post(previewUrl).set('Authorization', owner.auth).send({ tenantId: tenant.id, requestReceivedAt: '2026-11-10' });
    expect(prev.status).toBe(200);
    expect(prev.body.data).toMatchObject({
      finalAccessDate: '2026-12-10',
      defaultFinalAccessDate: '2026-12-10',
      noticeDays: 30,
      requiredNoticeDays: 30,
      noticeCompliant: true,
      openCaseNumber: null,
    });
    // December: 600 × 21 ÷ 31 = 406.45 unused rent; deposit S$0 (R8);
    // Protection never refunded (R9).
    expect(prev.body.data.calc.unusedRentRefund).toBeCloseTo(406.45, 2);
    expect(prev.body.data.calc.depositHeld).toBe(0);
    expect(prev.body.data.calc.protectionRefund).toBe(0);

    // Explicit short-notice date: same engine, non-compliant.
    const short = await api.post(previewUrl).set('Authorization', owner.auth).send({
      tenantId: tenant.id, requestReceivedAt: '2026-11-10', finalAccessDate: '2026-11-15',
    });
    expect(short.status).toBe(200);
    expect(short.body.data).toMatchObject({ noticeDays: 5, noticeCompliant: false });
    expect(short.body.data.calc.unusedRentRefund).toBeCloseTo(300, 2);

    // Same server maths as the case preview once the request is recorded.
    const c = (
      await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
        tenantId: tenant.id, finalAccessDate: '2026-12-10', requestReceivedAt: '2026-11-10', requestChannel: CHANNEL, reasonCode: REASON,
      })
    ).body.data;
    const casePrev = await api.get(`${CMS}/move-out-cases/${c.id}/preview`).set('Authorization', owner.auth);
    expect(casePrev.body.data.calc.unusedRentRefund).toBe(prev.body.data.calc.unusedRentRefund);
    expect(casePrev.body.data.calc.lines).toEqual(prev.body.data.calc.lines);

    // Open-case warning for the same rental.
    const again = await api.post(previewUrl).set('Authorization', owner.auth).send({ tenantId: tenant.id, requestReceivedAt: '2026-11-10' });
    expect(again.body.data.openCaseNumber).toBe(c.caseNumber);

    // Unit-less tenants are rejected (the modal never lists them).
    const bare = await prisma.tenant.create({
      data: {
        name: 'No Unit', email: uniqueEmail(), mobile: '81234567',
        moveInDate: new Date('2026-09-14T00:00:00.000Z'), monthlyRate: 0, psf: 0, status: 'ACTIVE', branchId: w.branchId,
      },
    });
    expect((await api.post(previewUrl).set('Authorization', owner.auth).send({ tenantId: bare.id })).status).toBe(409);

    // Validation + auth gates.
    expect((await api.post(previewUrl).set('Authorization', owner.auth).send({ tenantId: tenant.id, requestReceivedAt: '2026-11-10', finalAccessDate: '2026-11-01' })).status).toBe(400);
    expect((await api.post(previewUrl).set('Authorization', owner.auth).send({})).status).toBe(400);
    expect((await api.post(previewUrl).set('Authorization', owner.auth).send({ tenantId: 'nope' })).status).toBe(404);
    // Viewer holds customer-moveouts:view (read-only): preview is visible,
    // recording stays 403 (proven by the "viewer cannot record" test above).
    expect((await api.post(previewUrl).set('Authorization', viewer.auth).send({ tenantId: tenant.id })).status).toBe(200);
    expect(await api.post(previewUrl).send({ tenantId: tenant.id })).toMatchObject({ status: 401 });
  });

  it('inspection-preview: live server maths match the submit; validation + viewer gate', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = (
      await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
        tenantId: tenant.id,
        finalAccessDate: '2026-11-15',
        requestReceivedAt: '2026-10-20',
        requestChannel: CHANNEL,
        reasonCode: REASON,
      })
    ).body.data;
    const previewUrl = `${CMS}/move-out-cases/${c.id}/inspection-preview`;

    // Zero charges: same engine as the case preview (unused rent only).
    const zero = await api.post(previewUrl).set('Authorization', owner.auth).send({});
    expect(zero.status).toBe(200);
    const casePrev = await api.get(`${CMS}/move-out-cases/${c.id}/preview`).set('Authorization', owner.auth);
    expect(zero.body.data.calc.lines).toEqual(casePrev.body.data.calc.lines);
    expect(zero.body.data.calc.netSettlement).toBeCloseTo(casePrev.body.data.calc.netSettlement, 2);

    // Typed charges: the preview the modal shows while typing equals the
    // maths the submit then posts (November: 600 × 15 ÷ 30 − 350).
    const withCharges = await api.post(previewUrl).set('Authorization', owner.auth).send({ cleaningCharge: 350 });
    expect(withCharges.status).toBe(200);
    expect(withCharges.body.data.calc.netSettlement).toBeCloseTo(-50, 2);
    const submitted = await api.post(`${CMS}/move-out-cases/${c.id}/inspection`).set('Authorization', owner.auth).send({ ...INSPECTION, cleaningCharge: 350 });
    expect(submitted.status).toBe(201);
    expect(submitted.body.data.settlement.amount).toBeCloseTo(withCharges.body.data.calc.total, 2);

    // Inspected cases no longer preview (the modal only previews pre-submit).
    expect((await api.post(previewUrl).set('Authorization', owner.auth).send({})).status).toBe(409);

    // Validation + auth gates on a second open case.
    const unit2 = await makeUnit(w, 600);
    const tenant2 = await makeTenant(w, unit2.id, 600);
    const c2 = (
      await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
        tenantId: tenant2.id, finalAccessDate: '2026-11-15', requestReceivedAt: '2026-10-20', requestChannel: CHANNEL, reasonCode: REASON,
      })
    ).body.data;
    const previewUrl2 = `${CMS}/move-out-cases/${c2.id}/inspection-preview`;
    expect((await api.post(previewUrl2).set('Authorization', owner.auth).send({ damageCharge: -5 })).status).toBe(400);
    expect((await api.post(previewUrl2).set('Authorization', owner.auth).send({ damageCharge: 'x' })).status).toBe(400);
    expect((await api.post(`${CMS}/move-out-cases/does-not-exist/inspection-preview`).set('Authorization', owner.auth).send({})).status).toBe(404);
    // Viewer holds the view grant: preview visible, submit stays 403.
    expect((await api.post(previewUrl2).set('Authorization', viewer.auth).send({})).status).toBe(200);
    expect(await api.post(previewUrl2).send({})).toMatchObject({ status: 401 });
  });

  it('date change needs a reason; reversal keeps the case in history', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = (
      await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
        tenantId: tenant.id,
        finalAccessDate: '2026-12-15',
        requestReceivedAt: '2026-11-10',
        requestChannel: CHANNEL,
        reasonCode: REASON,
      })
    ).body.data;

    const noReason = await api.patch(`${CMS}/move-out-cases/${c.id}/date`).set('Authorization', owner.auth).send({ finalAccessDate: '2026-12-20' });
    expect(noReason.status).toBe(400);
    const changed = await api.patch(`${CMS}/move-out-cases/${c.id}/date`).set('Authorization', owner.auth).send({ finalAccessDate: '2026-12-20', reason: 'Customer travels; later handover.' });
    expect(changed.status).toBe(200);
    expect(changed.body.data.case.finalAccessDate.slice(0, 10)).toBe('2026-12-20');
    expect(changed.body.data.before.finalAccessDate.slice(0, 10)).toBe('2026-12-15');

    const reversed = await api.post(`${CMS}/move-out-cases/${c.id}/reverse`).set('Authorization', owner.auth).send({ reason: 'Customer withdrew.' });
    expect(reversed.status).toBe(200);
    const again = await api.get(`${CMS}/move-out-cases/${c.id}`).set('Authorization', owner.auth);
    expect(again.body.data.status).toBe('REVERSED');
    // Reversal is terminal — the workspace shows the retained case, no redo.
    expect(await api.post(`${CMS}/move-out-cases/${c.id}/reverse`).set('Authorization', owner.auth).send({ reason: 'Again.' })).toMatchObject({ status: 409 });
  });

  it('viewer cannot record, change, reverse or inspect (UI hides via data-perm)', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const body = { tenantId: tenant.id, finalAccessDate: '2026-12-15', requestReceivedAt: '2026-11-10', requestChannel: CHANNEL, reasonCode: REASON };
    expect(await api.post(`${CMS}/move-out-cases`).set('Authorization', viewer.auth).send(body)).toMatchObject({ status: 403 });
    const c = (await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send(body)).body.data;
    for (const [method, path, payload] of [
      ['patch', `${CMS}/move-out-cases/${c.id}/date`, { finalAccessDate: '2026-12-20', reason: 'x' }],
      ['post', `${CMS}/move-out-cases/${c.id}/reverse`, { reason: 'x' }],
      ['post', `${CMS}/move-out-cases/${c.id}/inspection`, INSPECTION],
    ] as const) {
      const res = method === 'patch'
        ? await api.patch(path).set('Authorization', viewer.auth).send(payload)
        : await api.post(path).set('Authorization', viewer.auth).send(payload);
      expect(res.status).toBe(403);
    }
  });
});

describe('A7 UI gate — settlement drawer (approve / request-changes / correct / process)', () => {
  let w: World;
  let owner: Operator;
  let operator: Operator;
  let approver: Operator;
  let processor: Operator;
  let viewer: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    owner = await createOperator('OWNER');
    operator = await createOperator('FINANCE_OPERATOR');
    approver = await createOperator('FINANCE_APPROVER');
    processor = await createOperator('FINANCE_APPROVER');
    viewer = await createOperator('VIEWER');
  });

  async function inspectedCase() {
    const unit = await makeUnit(w, 661.5);
    const tenant = await makeTenant(w, unit.id, 661.5);
    const c = (
      await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
        tenantId: tenant.id,
        finalAccessDate: '2026-11-15',
        requestReceivedAt: '2026-10-20',
        requestChannel: CHANNEL,
        reasonCode: REASON,
      })
    ).body.data;
    const insp = await api.post(`${CMS}/move-out-cases/${c.id}/inspection`).set('Authorization', owner.auth).send(INSPECTION);
    expect(insp.status).toBe(201);
    return { tenant, unit, caseId: c.id, settlement: insp.body.data.settlement };
  }

  it('inspection creates exactly one Finance record; drawer readout is the full record', async () => {
    const { settlement } = await inspectedCase();
    // −S$19.25 charge (handoff §9.2: 661.50 × 15 ÷ 30 − 350).
    expect(settlement.ref).toMatch(/^CH-/);
    expect(settlement.status).toBe('PENDING_APPROVAL');

    // §3 jump target: Open Finance approval.
    const detail = await api.get(`${CMS}/finance/settlements/${settlement.id}`).set('Authorization', approver.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ ref: settlement.ref, kind: 'MOVE_OUT' });
    expect(Array.isArray(detail.body.data.lines)).toBe(true);
    expect(Array.isArray(detail.body.data.changeRequests)).toBe(true);
    expect(Array.isArray(detail.body.data.attempts)).toBe(true);
    expect(Array.isArray(detail.body.data.ledgerLines)).toBe(true);
    expect(await api.get(`${CMS}/finance/settlements/nope`).set('Authorization', approver.auth)).toMatchObject({ status: 404 });

    // Register carries the drawer key + linked customer (jump: customer profile).
    const reg = await api.get(`${CMS}/finance/register`).set('Authorization', approver.auth).query({ search: settlement.ref });
    const row = reg.body.data.rows.find((r: { recordId: string }) => r.recordId === settlement.ref);
    expect(row).toMatchObject({ key: `settlement:${settlement.id}`, docType: 'Charge' });
    expect(row.tenantId).toBeTruthy();
  });

  it('approve → process posts the charge; self-approval without a reason is rejected', async () => {
    const { settlement } = await inspectedCase();
    // Requester cannot approve their own inspection settlement without an
    // Owner bypass reason (D5 three-party separation).
    const selfApprove = await api.post(`${CMS}/finance/settlements/${settlement.id}/approve`).set('Authorization', owner.auth).send({});
    expect(selfApprove.status).toBe(400);
    expect(selfApprove.body.error.message).toMatch(/reason|bypass/i);
    const approved = await api.post(`${CMS}/finance/settlements/${settlement.id}/approve`).set('Authorization', approver.auth).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.data.message).toMatch('Approved; awaiting processor submission.');
    const processed = await api.post(`${CMS}/finance/settlements/${settlement.id}/process`).set('Authorization', processor.auth).send({});
    expect(processed.status).toBe(200);
    expect(processed.body.data.settlement.status).toBe('POSTED');
  });

  it('request-changes → correct → re-approve loop keeps the same record', async () => {
    const { settlement } = await inspectedCase();
    const returned = await api
      .post(`${CMS}/finance/settlements/${settlement.id}/reject`)
      .set('Authorization', approver.auth)
      .send({ reason: 'Cleaning looks high — recheck.', category: 'Amount or calculation', dueDate: '2026-11-25' });
    expect(returned.status).toBe(200);
    const corrected = await api
      .post(`${CMS}/finance/settlements/${settlement.id}/correct`)
      .set('Authorization', operator.auth)
      .send({ charges: { cleaning: 100 }, notes: 'Rechecked: light clean only.' });
    expect(corrected.status).toBe(200);
    expect(corrected.body.data.settlement.id).toBe(settlement.id);
    expect(corrected.body.data.settlement.status).toBe('PENDING_APPROVAL');
    const reapproved = await api.post(`${CMS}/finance/settlements/${settlement.id}/approve`).set('Authorization', approver.auth).send({});
    expect(reapproved.status).toBe(200);
  });

  it('manual refund flow: validation copy, submit message, approve, wallet process', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const base = { tenantId: tenant.id, unitId: unit.id, returnMethod: 'WALLET', reasonCode: 'service-recovery', sourceRef: null as string | null };
    expect((await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({ ...base, amount: 0, notes: 'x' })).status).toBe(400);
    expect((await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({ ...base, amount: 80, notes: '' })).status).toBe(400);
    expect((await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({ ...base, amount: 80, reasonCode: 'overcharge', notes: 'Double-billed.' })).status).toBe(400);
    const created = await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({ ...base, amount: 80, notes: 'Goodwill credit.' });
    expect(created.status).toBe(201);
    expect(created.body.data.message).toMatch('submitted for approval. No money has been sent.');
    const s = created.body.data.settlement;
    expect(s.ref).toMatch(/^RF-/);

    // Refunds register (Finance queue source) + detail jump target.
    const refunds = await api.get(`${CMS}/finance/settlements/refunds`).set('Authorization', approver.auth).query({ status: 'PENDING_APPROVAL' });
    expect(refunds.body.data.map((x: { id: string }) => x.id)).toContain(s.id);
    expect((await api.get(`${CMS}/finance/settlements/${s.id}`).set('Authorization', approver.auth)).status).toBe(200);

    await api.post(`${CMS}/finance/settlements/${s.id}/approve`).set('Authorization', approver.auth).send({});
    const done = await api.post(`${CMS}/finance/settlements/${s.id}/process`).set('Authorization', processor.auth).send({});
    expect(done.body.data.settlement.status).toBe('REFUNDED');
    // Posted credit is visible to the profile billing ledger (View historical ledger).
    const rollup = await api.get(`${CMS}/tenants/${tenant.id}/rollup`).set('Authorization', operator.auth);
    expect(rollup.body.data.ledgerLines.length).toBeGreaterThan(0);
  });

  it('finance actions are approve-gated; viewer gets the denied state, never mutations', async () => {
    const { settlement } = await inspectedCase();
    for (const [method, path, payload] of [
      ['post', `${CMS}/finance/settlements`, { tenantId: 'x', amount: 1, reasonCode: 'other', returnMethod: 'WALLET', notes: 'x' }],
      ['post', `${CMS}/finance/settlements/${settlement.id}/approve`, {}],
      ['post', `${CMS}/finance/settlements/${settlement.id}/reject`, { reason: 'x' }],
      ['post', `${CMS}/finance/settlements/${settlement.id}/correct`, {}],
      ['post', `${CMS}/finance/settlements/${settlement.id}/process`, {}],
    ] as const) {
      const res = await api.post(path).set('Authorization', viewer.auth).send(payload);
      expect(res.status).toBe(403);
      void method;
    }
    // Viewer holds no finance view grant (Viewer-hidden by default) — drawer
    // and register answer the §19 permission-denied state, not data.
    expect((await api.get(`${CMS}/finance/settlements/${settlement.id}`).set('Authorization', viewer.auth)).status).toBe(403);
    expect((await api.get(`${CMS}/finance/register`).set('Authorization', viewer.auth)).status).toBe(403);
    // Approvers read everything the drawer needs.
    expect((await api.get(`${CMS}/finance/settlements/${settlement.id}`).set('Authorization', approver.auth)).status).toBe(200);
    expect((await api.get(`${CMS}/finance/register`).set('Authorization', approver.auth)).status).toBe(200);
  });
});

describe('A7 UI gate — transfers (preview → approval → posting)', () => {
  let w: World;
  let owner: Operator;
  let operator: Operator;
  let approver: Operator;
  let executor: Operator;

  // A-17: pin the JS clock so the SG effective-date guard is deterministic
  // (same pattern as moveout-transfer.test.ts — only the Date constructor is
  // faked, timers/sockets keep working). The pinned instant SG-dates to
  // 2026-11-19, so dates derived from sgCalendarDate below stay due at
  // posting time while the far-future clash probe stays future-dated.
  const PINNED_NOW = new Date('2026-11-19T00:00:00.000Z');

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PINNED_NOW);
    await resetDb();
    w = await seedWorld();
    owner = await createOperator('OWNER');
    operator = await createOperator('FINANCE_OPERATOR');
    approver = await createOperator('FINANCE_APPROVER');
    executor = await createOperator('FINANCE_APPROVER');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function source() {
    const unit = await makeUnit(w, 547.2);
    const tenant = await makeTenant(w, unit.id, 547.2);
    const dest = await makeUnit(w, 661.5);
    return { unit, tenant, dest };
  }

  function transferInput(destId: string, effectiveDate: string) {
    return { toUnitId: destId, effectiveDate, destPromoPct: 0, destDeposit: 0, destProtection: 12.5, reason: 'Upgrade.' };
  }

  it('preview is server-calculated; submit → changes → correct → approve → execute posts atomically', async () => {
    const { unit, tenant, dest } = await source();
    // A-17: posting waits for the SG effective date, so every date on the
    // submit → correct → approve → execute path derives from the SG calendar
    // (never a hardcoded wall-clock): submit SG-yesterday, correct to SG
    // today — both due at posting time, so execute posts instead of 409ing.
    // Pinned clock → SG today 2026-11-19, submit 2026-11-18.
    const todayYmd = sgCalendarDate(new Date());
    const submitYmd = addDaysYmd(todayYmd, -1);
    const preview = await api.post(`${CMS}/transfers/preview`).set('Authorization', operator.auth).send({ tenantId: tenant.id, ...transferInput(dest.id, submitYmd) });
    expect(preview.status).toBe(200);
    // −S$49.53 net: 237.12 credit (547.20 × 13 ÷ 30) vs 286.65 charge
    // (661.50 × 13 ÷ 30) — November has 30 days, submit day 18 → 13
    // transfer days (effective day included in both periods, §11.4).
    expect(Number(preview.body.data.netAdjustment)).toBeCloseTo(49.53, 2);

    const submitted = await api.post(`${CMS}/transfers`).set('Authorization', operator.auth).send({ tenantId: tenant.id, ...transferInput(dest.id, submitYmd) });
    expect(submitted.status).toBe(201);
    const t = submitted.body.data.settlement;
    expect(t.ref).toMatch(/^TRF-/);
    expect(t.status).toBe('PENDING_APPROVAL');

    // Identical double-submit replays idempotently (Submit is double-click
    // safe) — the R10 guard below fires on genuinely different inputs.
    const dup = await api.post(`${CMS}/transfers`).set('Authorization', operator.auth).send({ tenantId: tenant.id, ...transferInput(dest.id, submitYmd) });
    expect(dup.status).toBe(200);
    expect(dup.body.data.deduplicated).toBe(true);
    expect(dup.body.data.settlement.id).toBe(t.id);
    // A different open transfer on the same source is rejected (R10 surface).
    // Future-dated probe stays submit-validation-only: it must 409 on the
    // open-transfer guard here and is never executed (A-17 blocks posting
    // before the SG effective date).
    const clash = await api.post(`${CMS}/transfers`).set('Authorization', operator.auth).send({ tenantId: tenant.id, ...transferInput(dest.id, '2026-11-23') });
    expect(clash.status).toBe(409);

    // §3 jump target: Open transfer record.
    const detail = await api.get(`${CMS}/transfers/${t.id}`).set('Authorization', approver.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.destUnit.unitCode).toBe(dest.unitCode);

    // Finance change request → Operations correction → resubmit (same ID).
    const changes = await api.post(`${CMS}/transfers/${t.id}/changes`).set('Authorization', approver.auth).send({
      note: `Customer wants ${todayYmd}, not ${submitYmd}.`, category: 'Unit or transfer date', assignTeam: 'Operations · Facility team', dueDate: '2026-11-25',
    });
    expect(changes.body.data.settlement.status).toBe('CHANGES_REQUESTED');
    const corrected = await api.post(`${CMS}/transfers/${t.id}/correct`).set('Authorization', operator.auth).send({ response: 'Date moved per customer.', effectiveDate: todayYmd });
    expect(corrected.body.data.settlement.status).toBe('PENDING_APPROVAL');

    await api.post(`${CMS}/transfers/${t.id}/approve`).set('Authorization', approver.auth).send({});
    const executed = await api.post(`${CMS}/transfers/${t.id}/execute`).set('Authorization', executor.auth).send({});
    // A-17 guard passes: the corrected effective date (SG today) is due.
    expect(executed.status).toBe(200);
    expect(executed.body.data.settlement.status).toBe('POSTED');

    // Previous unit + transfer history (profile Rental & pricing jump targets).
    const rollup = await api.get(`${CMS}/tenants/${tenant.id}/rollup`).set('Authorization', operator.auth);
    expect(rollup.body.data.previousRentals.length).toBe(1);
    expect(rollup.body.data.previousRentals[0].sourceRef).toBe(t.ref);
    expect(rollup.body.data.transferHistory.map((x: { ref: string }) => x.ref)).toContain(t.ref);

    // Register carries the transfer approval (Transactions register jump).
    const reg = await api.get(`${CMS}/finance/register`).set('Authorization', approver.auth).query({ search: t.ref });
    expect(reg.body.data.rows.map((r: { recordId: string }) => r.recordId)).toContain(t.ref);
  });

  it('destination validation: same unit, occupied unit and unknown unit are rejected', async () => {
    const { unit, tenant, dest } = await source();
    // Validation-only probes: derived SG-today date, never executed (A-17).
    const effYmd = sgCalendarDate(new Date());
    const same = await api.post(`${CMS}/transfers/preview`).set('Authorization', operator.auth).send({ tenantId: tenant.id, ...transferInput(unit.id, effYmd) });
    expect(same.status).toBe(400);
    // Occupied destination (status gate, D9): not available for transfer.
    await prisma.unit.update({ where: { id: dest.id }, data: { status: 'OCCUPIED' } });
    const occupied = await api.post(`${CMS}/transfers/preview`).set('Authorization', operator.auth).send({ tenantId: tenant.id, ...transferInput(dest.id, effYmd) });
    expect(occupied.status).toBe(409);
    const unknown = await api.post(`${CMS}/transfers/preview`).set('Authorization', operator.auth).send({ tenantId: tenant.id, ...transferInput('unit-does-not-exist', effYmd) });
    expect(unknown.status).toBe(404);
  });
});

describe('A7 UI gate — profile extensions, settings and legacy retirement', () => {
  let w: World;
  let owner: Operator;
  let operator: Operator;
  let approver: Operator;
  let viewer: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    owner = await createOperator('OWNER');
    operator = await createOperator('FINANCE_OPERATOR');
    approver = await createOperator('FINANCE_APPROVER');
    viewer = await createOperator('VIEWER');
  });

  it('roll-up drives Rental & pricing / billing / documents; status editor is guarded', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const rollup = await api.get(`${CMS}/tenants/${tenant.id}/rollup`).set('Authorization', operator.auth);
    expect(rollup.status).toBe(200);
    for (const key of ['rentals', 'previousRentals', 'transferHistory', 'ledgerLines', 'documents', 'openSettlements', 'totals', 'derivedStatus']) {
      expect(rollup.body.data).toHaveProperty(key);
    }
    expect(rollup.body.data.rentals[0]).toMatchObject({ tenantId: tenant.id, status: 'ACTIVE' });

    // Reason is mandatory (handoff §7 form rule).
    expect((await api.post(`${CMS}/tenants/${tenant.id}/status`).set('Authorization', owner.auth).send({ status: 'SUSPENDED' })).status).toBe(400);
    const changed = await api.post(`${CMS}/tenants/${tenant.id}/status`).set('Authorization', owner.auth).send({ status: 'SUSPENDED', reason: 'Payment dispute under review.' });
    expect(changed.status).toBe(201);
    expect(changed.body.data).toMatchObject({ toStatus: 'SUSPENDED' });
    expect(changed.body.data.safeguard).toMatch(/never creates a refund/i);
    // Stale version is rejected (optimistic locking, §19).
    const stale = await api.post(`${CMS}/tenants/${tenant.id}/status`).set('Authorization', owner.auth).send({ status: 'ACTIVE', reason: 'Resolved.', expectedVersion: 0 });
    expect(stale.status).toBe(409);
    // Viewer cannot change status (Change status hidden via data-perm).
    expect((await api.post(`${CMS}/tenants/${tenant.id}/status`).set('Authorization', viewer.auth).send({ status: 'ACTIVE', reason: 'x' })).status).toBe(403);
  });

  it('settings surface carries the moveout.* policy; scoped writes, gated reads', async () => {
    // Approver reads the policy through the settings-moveouts grant (A7).
    const rules = await api.get(`${CMS}/business-rules`).set('Authorization', approver.auth);
    expect(rules.status).toBe(200);
    for (const key of ['booking.moveOutNoticeDays', 'moveout.allowDateChange', 'moveout.shortNoticeForfeitDeposit', 'moveout.depositCollectionEnabled', 'moveout.inspectionRequired', 'moveout.approvalRole']) {
      expect(rules.body.data.map((r: { key: string }) => r.key)).toContain(key);
    }
    // Approver may save moveout.* keys only (A7 key scoping, §19).
    const saved = await api.put(`${CMS}/business-rules`).set('Authorization', approver.auth).send({ 'moveout.allowDateChange': true });
    expect(saved.status).toBe(200);
    expect((await api.put(`${CMS}/business-rules`).set('Authorization', approver.auth).send({ 'booking.moveOutNoticeDays': 14, 'moveout.allowDateChange': true })).status).toBe(403);
    // Owner keeps full access.
    expect((await api.put(`${CMS}/business-rules`).set('Authorization', owner.auth).send({ 'booking.moveOutNoticeDays': 30 })).status).toBe(200);
    expect((await api.put(`${CMS}/business-rules`).set('Authorization', owner.auth).send({ 'moveout.approvalRole': 'ANYONE' })).status).toBe(400);
    // Viewer reads the shared booking/general surface but can never save.
    expect((await api.get(`${CMS}/business-rules`).set('Authorization', viewer.auth)).status).toBe(200);
    expect((await api.put(`${CMS}/business-rules`).set('Authorization', viewer.auth).send({ 'moveout.allowDateChange': false })).status).toBe(403);
  });

  it('A-19: move-out policy saves twice in a row; each changed key audits before/after', async () => {
    const list = await api.get(`${CMS}/business-rules`).set('Authorization', owner.auth);
    expect(list.status).toBe(200);
    const cur = (list.body.data as Array<{ key: string; value: unknown }>).find(
      (r) => r.key === 'moveout.allowDateChange',
    )?.value;
    // First save flips the key…
    const first = await api.put(`${CMS}/business-rules`).set('Authorization', owner.auth).send({ 'moveout.allowDateChange': !cur });
    expect(first.status).toBe(200);
    // …and a second save immediately after works too (no reload needed).
    const second = await api.put(`${CMS}/business-rules`).set('Authorization', owner.auth).send({ 'moveout.allowDateChange': cur });
    expect(second.status).toBe(200);
    // The changed key carries a before/after audit event with actor + source.
    const audit = await api.get(`${CMS}/finance/audit`).set('Authorization', owner.auth).query({
      entityType: 'BusinessRule',
      entityId: 'moveout.allowDateChange',
      limit: 10,
    });
    expect(audit.status).toBe(200);
    const ev = (audit.body.data as Array<Record<string, unknown>>).find(
      (e) => (e.after as { value?: unknown })?.value === cur && (e.before as { value?: unknown })?.value === !cur,
    );
    expect(ev).toBeTruthy();
    expect(ev).toMatchObject({
      actor: owner.email,
      source: 'cms',
      entityType: 'BusinessRule',
      entityId: 'moveout.allowDateChange',
    });
    // Same-transaction outbox row for the policy change.
    const outbox = await prisma.financeEvent.findMany({
      where: { type: 'business_rule.updated', correlationId: String((ev as Record<string, unknown>).correlationId) },
    });
    expect(outbox.length).toBeGreaterThan(0);
    expect((outbox[0].payload as { key?: unknown }).key).toBe('moveout.allowDateChange');
  });

  it('record-request + transfer selectors read tenants and available units', async () => {
    const unit = await makeUnit(w, 600);
    await makeTenant(w, unit.id, 600);
    const tenants = await api.get(`${CMS}/tenants`).set('Authorization', operator.auth);
    expect(tenants.status).toBe(200);
    expect(tenants.body.data.length).toBeGreaterThan(0);
    const avail = await api.get(`${CMS}/units`).set('Authorization', operator.auth).query({ status: 'AVAILABLE' });
    expect(avail.status).toBe(200);
  });

  it('D14 legacy complete/cancel keeps the 410 contract — no UI trigger may exist', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    await prisma.tenant.update({ where: { id: tenant.id }, data: { status: 'NOTICE' } });
    for (const action of ['complete', 'cancel']) {
      const res = await api.patch(`${CMS}/move-outs/${tenant.id}`).set('Authorization', owner.auth).send({ action });
      expect(res.status).toBe(410);
      expect(res.body.error.message).toMatch('retired');
      expect(res.body.error.details).toMatchObject({ pointer: '/api/v1/cms/move-out-cases' });
    }
  });
});

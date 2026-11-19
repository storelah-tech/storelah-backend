// Track A A4 — finance approvals, processing, ledger posting (handoff
// §§10/12/13, D3–D6; brief R6 + §6 matrix).
//
// Covers: manual refund validation copy + submit, maker-checker approve
// (incl. Owner bypass + ADMIN_ONLY policy), change-request round-trip,
// version-guarded 409 STALE, idempotent processing per return method
// (ORIGINAL/BANK/WALLET), charge posting as an issued Invoice, Stripe
// webhook success/failure idempotency (getStripe mocked at the service seam
// — no live calls), shared ledger posting with reversal balance, and the
// refunds register filters.
//
// Every expected money value is hand-derived integer-cents arithmetic. The
// suite runs on the isolated *_test DB (never dev); each test truncates
// first via resetDb().
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { PIN, api, createOperator, prisma, resetDb, seedMoveInWorld, uniqueEmail, type Operator } from './fixtures';
import { reverseSettlementLines } from '../../src/core/lifecycle/settleFinance';

const CMS = '/api/v1/cms';

// --- Stripe fake (service seam: getStripe is swapped via vi.mock; nothing
// reaches the network). refunds.create mirrors the SDK signature incl. the
// idempotencyKey option; status is operator-controlled per test.
const fake = vi.hoisted(() => {
  const state = {
    refunds: new Map<string, { id: string; amount: number; status: string; payment_intent: string; metadata: Record<string, string> }>(),
    idem: new Map<string, { id: string }>(),
    seq: 0,
    creates: 0,
    nextStatus: 'pending',
    throwMode: null as null | { type: string; statusCode?: number; message: string },
  };
  const stripe = {
    refunds: {
      create: async (
        p: { payment_intent: string; amount: number; metadata?: Record<string, string> },
        opts?: { idempotencyKey?: string },
      ) => {
        if (state.throwMode) {
          const t = state.throwMode;
          throw Object.assign(new Error(t.message), { type: t.type, statusCode: t.statusCode });
        }
        if (opts?.idempotencyKey && state.idem.has(opts.idempotencyKey)) {
          const prior = state.idem.get(opts.idempotencyKey)!;
          return state.refunds.get(prior.id)!;
        }
        state.creates += 1;
        const id = `re_fake_${++state.seq}`;
        const r = { id, amount: p.amount, status: state.nextStatus, payment_intent: p.payment_intent, metadata: p.metadata ?? {}, created: 1763600000 };
        state.refunds.set(id, r);
        if (opts?.idempotencyKey) state.idem.set(opts.idempotencyKey, { id });
        return r;
      },
    },
  };
  return { state, stripe };
});

vi.mock('../../src/core/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/checkout')>();
  return { ...actual, getStripe: () => fake.stripe };
});

const SAVED = {
  wh: process.env.STRIPE_WEBHOOK_SECRET,
  sk: process.env.STRIPE_SECRET_KEY,
};

function resetStripeEnv() {
  fake.state.refunds.clear();
  fake.state.idem.clear();
  fake.state.seq = 0;
  fake.state.creates = 0;
  fake.state.nextStatus = 'pending';
  fake.state.throwMode = null;
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_e2e_moveout_finance';
}

afterAll(() => {
  for (const [k, v] of [['STRIPE_WEBHOOK_SECRET', SAVED.wh], ['STRIPE_SECRET_KEY', SAVED.sk]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// --- World helpers (same pinned shape as moveout-service.test.ts). ---
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
async function makeUnit(w: World, rate: number, branchId?: string, floorId?: string) {
  unitSeq += 1;
  return prisma.unit.create({
    data: {
      branchId: branchId ?? w.branchId,
      floorId: floorId ?? w.floorId,
      sizeId: w.sizeId,
      unitCode: `MVF-E2E-${unitSeq}`,
      sqft: 50,
      monthlyRate: rate,
      status: 'AVAILABLE',
      climateControl: 'Ambient climate',
    },
  });
}

async function makeTenant(w: World, unitId: string, rate: number, branchId?: string, email = uniqueEmail()) {
  return prisma.tenant.create({
    data: {
      name: 'E2E Finance',
      email,
      mobile: '81234567',
      unitId,
      moveInDate: new Date('2026-09-14T00:00:00.000Z'),
      monthlyRate: rate,
      psf: rate / 50,
      status: 'ACTIVE',
      branchId: branchId ?? w.branchId,
    },
  });
}

const CHANNEL = 'WhatsApp';
const REASON = 'No longer needs storage';

/** Drive a tenant to a PENDING_APPROVAL move-out refund settlement. Rent
 * S$600, final access 15 Nov 2026 (30-day month, unused 15 → S$300.00). */
async function moveOutToSettlement(ownerAuth: string, tenantId: string) {
  const c = (
    await api.post(`${CMS}/move-out-cases`).set('Authorization', ownerAuth).send({
      tenantId,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    })
  ).body.data;
  expect(c.status).toBe('AWAITING_INSPECTION');
  const done = (
    await api.post(`${CMS}/move-out-cases/${c.id}/inspection`).set('Authorization', ownerAuth).send({
      unitEmpty: true,
      doorLockWallsFloorChecked: true,
      accessRevoked: true,
      releaseConfirmed: true,
      releaseStatus: 'READY',
      notes: 'Unit empty, evidence attached.',
    })
  ).body.data;
  expect(done.settlement.status).toBe('PENDING_APPROVAL');
  expect(done.settlement.amount).toBe(-300);
  expect(done.case.status).toBe('SETTLEMENT_REVIEW');
  return { caseId: c.id, settlement: done.settlement };
}

function ledgerBalance(lines: Array<{ debit: number | null; credit: number | null; reversalOfId: string | null; id: string }>) {
  const reversed = new Set(lines.map((l) => l.reversalOfId).filter(Boolean) as string[]);
  const live = lines.filter((l) => l.reversalOfId == null && !reversed.has(l.id));
  return live.reduce((n, l) => n + (l.debit ?? 0) - (l.credit ?? 0), 0);
}

describe('manual refunds — validation, submit, maker-checker', () => {
  let w: World;
  let owner: Operator;
  let approver: Operator;
  let operator: Operator;
  let processor: Operator;

  beforeEach(async () => {
    await resetDb();
    resetStripeEnv();
    w = await seedWorld();
    owner = await createOperator('OWNER');
    approver = await createOperator('FINANCE_APPROVER');
    operator = await createOperator('FINANCE_OPERATOR');
    processor = await createOperator('FINANCE_OPERATOR');
  });

  it('rejects invalid manual refunds with the handoff §10.3 copy', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const base = { tenantId: tenant.id, unitId: unit.id, reasonCode: 'overcharge', sourceRef: 'INV-1', returnMethod: 'ORIGINAL' };
    const zero = await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({ ...base, amount: 0, notes: 'Dup charge.' });
    expect(zero.status).toBe(400);
    expect(zero.body.error.message).toBe('Enter a refund amount greater than zero.');
    const neg = await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({ ...base, amount: -5, notes: 'Dup charge.' });
    expect(neg.status).toBe(400);
    const noNotes = await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({ ...base, amount: 10, notes: '  ' });
    expect(noNotes.status).toBe(400);
    expect(noNotes.body.error.message).toBe('Notes and the refund basis are required.');
    const noSource = await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({ ...base, amount: 10, notes: 'Dup charge.', sourceRef: null });
    expect(noSource.status).toBe(400);
    expect(noSource.body.error.message).toBe('Link the source transaction or invoice for this billing refund.');
    expect(await prisma.customerSettlement.count()).toBe(0);
  });

  it('submits a manual refund: PENDING_APPROVAL, confirmation copy, no money moved', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const res = await api
      .post(`${CMS}/finance/settlements`)
      .set('Authorization', operator.auth)
      .set('Idempotency-Key', 'manual-1')
      .send({ tenantId: tenant.id, unitId: unit.id, amount: 42.5, reasonCode: 'service-recovery', returnMethod: 'WALLET', notes: 'Goodwill credit.' });
    expect(res.status).toBe(201);
    expect(res.body.data.settlement).toMatchObject({
      kind: 'REFUND', docType: 'Refund', origin: 'MANUAL', status: 'PENDING_APPROVAL',
      amount: -42.5, reasonCode: 'service-recovery', returnMethod: 'WALLET', calcVersion: 1,
    });
    expect(res.body.data.settlement.ref).toMatch(/^RF-\d{7}$/);
    expect(res.body.data.message).toMatch(/submitted for approval\. No money has been sent\./);
    // Same key replays the same record — one Finance row only.
    const replay = await api
      .post(`${CMS}/finance/settlements`)
      .set('Authorization', operator.auth)
      .set('Idempotency-Key', 'manual-1')
      .send({ tenantId: tenant.id, unitId: unit.id, amount: 42.5, reasonCode: 'service-recovery', returnMethod: 'WALLET', notes: 'Goodwill credit.' });
    expect(replay.status).toBe(200);
    expect(replay.body.data.deduplicated).toBe(true);
    expect(replay.body.data.settlement.id).toBe(res.body.data.settlement.id);
    // No ledger lines, no processor instruction, no wallet movement.
    expect(await prisma.customerLedgerEntry.count()).toBe(0);
    expect(await prisma.processorAttempt.count()).toBe(0);
    const wallet = await prisma.creditWallet.findUnique({ where: { tenantId: tenant.id } });
    expect(wallet).toBeNull();
  });

  it('A-22: creates a manual refund against a former rental (historical unit context)', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    // Simulate a completed move-out: the history row is kept while the
    // tenant is former with no current unit (status INACTIVE, unitId null).
    await prisma.rentalUnitHistory.create({
      data: {
        tenantId: tenant.id,
        unitId: unit.id,
        startedAt: new Date('2026-09-14T00:00:00.000Z'),
        endedAt: new Date('2026-11-15T00:00:00.000Z'),
        endReason: 'MOVE_OUT',
        pricingSnapshot: {},
        billedTotals: {},
      },
    });
    await prisma.tenant.update({ where: { id: tenant.id }, data: { status: 'INACTIVE', unitId: null } });
    // The rental selector source (roll-up) still carries the former rental
    // with its unit code.
    const rollup = await api.get(`${CMS}/tenants/${tenant.id}/rollup`).set('Authorization', operator.auth);
    expect(rollup.status).toBe(200);
    expect(rollup.body.data.previousRentals.map((r: { unitId: string }) => r.unitId)).toContain(unit.id);
    // A manual refund selected via that former rental succeeds: the same
    // tenantId/unitId payload shape as an active rental.
    const res = await api
      .post(`${CMS}/finance/settlements`)
      .set('Authorization', operator.auth)
      .send({ tenantId: tenant.id, unitId: unit.id, amount: 25, reasonCode: 'service-recovery', returnMethod: 'WALLET', notes: 'Historical billing refund.' });
    expect(res.status).toBe(201);
    expect(res.body.data.settlement).toMatchObject({
      kind: 'REFUND', docType: 'Refund', origin: 'MANUAL', status: 'PENDING_APPROVAL',
      amount: -25, reasonCode: 'service-recovery', returnMethod: 'WALLET',
    });
    expect(res.body.data.settlement.ref).toMatch(/^RF-\d{7}$/);
    expect(res.body.data.message).toMatch(/submitted for approval\. No money has been sent\./);
  });

  it('enforces maker-checker: requester cannot approve; approver can; double approve 409s', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const requester = await createOperator('FINANCE_APPROVER');
    const created = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', requester.auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 10, reasonCode: 'other', returnMethod: 'ORIGINAL', notes: 'Documented exception.',
      })
    ).body.data.settlement;
    const self = await api.post(`${CMS}/finance/settlements/${created.id}/approve`).set('Authorization', requester.auth).send({});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CHECKER');
    const done = await api.post(`${CMS}/finance/settlements/${created.id}/approve`).set('Authorization', approver.auth).send({});
    expect(done.status).toBe(200);
    expect(done.body.data.settlement).toMatchObject({ status: 'APPROVED', approvedBy: approver.email });
    expect(done.body.data.message).toMatch('Approved; awaiting processor submission.');
    const again = await api.post(`${CMS}/finance/settlements/${created.id}/approve`).set('Authorization', owner.auth).send({});
    expect(again.status).toBe(409);
  });

  it('returns 409 STALE on a version-guarded approve', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const created = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 10, reasonCode: 'other', returnMethod: 'ORIGINAL', notes: 'Documented exception.',
      })
    ).body.data.settlement;
    const stale = await api
      .post(`${CMS}/finance/settlements/${created.id}/approve`)
      .set('Authorization', approver.auth)
      .send({ expectedVersion: created.version + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE');
  });

  it('allows an Owner single-step with reason, audited — and blocks it without one', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const mk = (notes: string) =>
      api.post(`${CMS}/finance/settlements`).set('Authorization', owner.auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 10, reasonCode: 'other', returnMethod: 'ORIGINAL', notes,
      });
    const a = (await mk('First.')).body.data.settlement;
    const noReason = await api.post(`${CMS}/finance/settlements/${a.id}/approve`).set('Authorization', owner.auth).send({});
    expect(noReason.status).toBe(400);
    const yes = await api.post(`${CMS}/finance/settlements/${a.id}/approve`).set('Authorization', owner.auth).send({ reason: 'Owner single-step: time-critical.' });
    expect(yes.status).toBe(200);
    expect(yes.body.data.bypassed).toBe(true);
    expect(yes.body.data.settlement.status).toBe('APPROVED');
  });

  it('ADMIN_ONLY approval policy restricts approval to the Owner', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const created = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 10, reasonCode: 'other', returnMethod: 'ORIGINAL', notes: 'Documented exception.',
      })
    ).body.data.settlement;
    await api.put(`${CMS}/business-rules`).set('Authorization', owner.auth).send({ 'moveout.approvalRole': 'ADMIN_ONLY' });
    const denied = await api.post(`${CMS}/finance/settlements/${created.id}/approve`).set('Authorization', approver.auth).send({});
    expect(denied.status).toBe(403);
    const allowed = await api.post(`${CMS}/finance/settlements/${created.id}/approve`).set('Authorization', owner.auth).send({ reason: 'Owner-only policy.' });
    expect(allowed.status).toBe(200);
    await api.put(`${CMS}/business-rules`).set('Authorization', owner.auth).send({ 'moveout.approvalRole': 'ADMIN_OR_FINANCE' });
  });
});

describe('change-request round-trip (scenario B/C correction path)', () => {
  let w: World;
  let owner: Operator;
  let approver: Operator;
  let operator: Operator;

  beforeEach(async () => {
    await resetDb();
    resetStripeEnv();
    w = await seedWorld();
    owner = await createOperator('OWNER');
    approver = await createOperator('FINANCE_APPROVER');
    operator = await createOperator('FINANCE_OPERATOR');
  });

  it('reject → correct → re-approve recalculates the same manual record', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const created = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 50, reasonCode: 'overcharge', sourceRef: 'INV-99', returnMethod: 'BANK', notes: 'Double-billed.',
      })
    ).body.data.settlement;
    const noNote = await api.post(`${CMS}/finance/settlements/${created.id}/reject`).set('Authorization', approver.auth).send({});
    expect(noNote.status).toBe(400);
    const returned = await api
      .post(`${CMS}/finance/settlements/${created.id}/reject`)
      .set('Authorization', approver.auth)
      .send({ note: 'Attach the source invoice number.', category: 'Pricing or promotion', assignTeam: 'Operations', dueDate: '2026-12-01' });
    expect(returned.status).toBe(200);
    expect(returned.body.data.settlement).toMatchObject({ status: 'CHANGES_REQUESTED' });
    expect(returned.body.data.settlement.changeRequests).toHaveLength(1);
    expect(returned.body.data.settlement.changeRequests[0]).toMatchObject({
      reason: 'Attach the source invoice number.', status: 'OPEN', assignTeam: 'Operations',
    });
    const corrected = await api
      .post(`${CMS}/finance/settlements/${created.id}/correct`)
      .set('Authorization', operator.auth)
      .send({ amount: 45, notes: 'Recomputed from INV-99: S$45.00.', expectedVersion: returned.body.data.settlement.version });
    expect(corrected.status).toBe(200);
    expect(corrected.body.data.settlement).toMatchObject({
      id: created.id, status: 'PENDING_APPROVAL', amount: -45, calcVersion: 2,
    });
    expect(corrected.body.data.settlement.changeRequests[0]).toMatchObject({ status: 'ADDRESSED', respondedBy: operator.email });
    // R6: the previous snapshot is preserved in the audit trail.
    const audits = await prisma.financeAuditEvent.findMany({ where: { entityType: 'CustomerSettlement', entityId: created.id, action: 'settlement.corrected' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toMatchObject({ amount: -50, calcVersion: 1 });
    const reapproved = await api.post(`${CMS}/finance/settlements/${created.id}/approve`).set('Authorization', approver.auth).send({});
    expect(reapproved.body.data.settlement.status).toBe('APPROVED');
  });

  it('correcting a move-out settlement recalculates server-side and flips charge on a zero net', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const { caseId, settlement } = await moveOutToSettlement(owner.auth, tenant.id);
    // Return for changes, then correct damage to exactly the S$300 refund.
    await api.post(`${CMS}/finance/settlements/${settlement.id}/reject`).set('Authorization', approver.auth).send({ note: 'Confirm damage total.' });
    const corrected = await api
      .post(`${CMS}/finance/settlements/${settlement.id}/correct`)
      .set('Authorization', operator.auth)
      .send({ charges: { damage: 300 }, notes: 'Confirmed S$300 damage.' });
    expect(corrected.status).toBe(200);
    expect(corrected.body.data.settlement).toMatchObject({ id: settlement.id, status: 'CANCELLED', amount: 0 });
    // §10.6/R6 zero path: no processor, rental completed and marked Former.
    expect(await prisma.processorAttempt.count({ where: { settlementId: settlement.id } })).toBe(0);
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId: settlement.id } })).toBe(0);
    const c = await prisma.moveOutCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(c.status).toBe('COMPLETED');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).status).toBe('INACTIVE');
  });

  it('a charge correction flips the outcome refund → charge on the same record', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const { settlement } = await moveOutToSettlement(owner.auth, tenant.id);
    await api.post(`${CMS}/finance/settlements/${settlement.id}/reject`).set('Authorization', approver.auth).send({ note: 'Add damage.' });
    // 600 × 15 ÷ 30 = S$300.00 refund; S$350 cleaning → S$50.00 charge.
    const corrected = await api
      .post(`${CMS}/finance/settlements/${settlement.id}/correct`)
      .set('Authorization', operator.auth)
      .send({ charges: { cleaning: 350 }, notes: 'Deep clean required.' });
    expect(corrected.status).toBe(200);
    expect(corrected.body.data.settlement).toMatchObject({ id: settlement.id, docType: 'Charge', amount: 50 });
    expect(corrected.body.data.settlement.ref).toMatch(/^CH-\d{7}$/);
    expect(corrected.body.data.outcomeChanged).toBe(true);
  });

  // A-21: a Finance change request is also an Operations work item — the
  // chosen assignee is notified through the existing StaffNotification path
  // while the tenant timeline and the ops queues list the return.
  it('A-21: refund change request notifies the assignee + RecordNote + ops queues', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const created = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 50, reasonCode: 'overcharge', sourceRef: 'INV-99', returnMethod: 'BANK', notes: 'Double-billed.',
      })
    ).body.data.settlement;
    const returned = await api
      .post(`${CMS}/finance/settlements/${created.id}/reject`)
      .set('Authorization', approver.auth)
      .send({ note: 'Attach the source invoice number.', category: 'Pricing or promotion', assignTeam: 'Operations', assigneeId: operator.id, dueDate: '2026-12-01' });
    expect(returned.status).toBe(200);
    expect(returned.body.data.settlement.changeRequests[0]).toMatchObject({ status: 'OPEN', assigneeId: operator.id });
    // StaffNotification exists for the assignee (existing notification path).
    const notes = await prisma.staffNotification.findMany({ where: { recipientId: operator.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'CHANGE_REQUEST', entityType: 'tenant', entityId: tenant.id });
    expect(notes[0].title).toContain(created.ref);
    // Visible in the assignee's notification queue…
    const mine = await api.get(`${CMS}/notifications`).set('Authorization', operator.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.data.rows.map((n: { title: string }) => n.title).join('\n')).toContain(created.ref);
    // …RecordNote on the tenant timeline…
    const timeline = await api.get(`${CMS}/tenants/${tenant.id}/notes`).set('Authorization', owner.auth);
    expect(timeline.status).toBe(200);
    expect(timeline.body.data.map((n: { body: string }) => n.body).join('\n')).toMatch(/returned for changes/i);
    // …the Operations queue readout…
    const queue = await api.get(`${CMS}/finance/settlements`).query({ status: 'CHANGES_REQUESTED' }).set('Authorization', approver.auth);
    expect(queue.status).toBe(200);
    expect(queue.body.data.map((r: { ref: string }) => r.ref)).toContain(created.ref);
    // …and the Command centre queue.
    const actions = await api.get(`${CMS}/action-items`).set('Authorization', owner.auth);
    expect(actions.status).toBe(200);
    expect(actions.body.data.map((a: { title: string }) => a.title).join('\n')).toContain(created.ref);
  });

  // A-21: a team-only return (no assignee) notifies nobody but stays
  // team-visible in the ops queues.
  it('A-21: team-only refund change request creates no notification but stays team-visible', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const created = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 50, reasonCode: 'overcharge', sourceRef: 'INV-99', returnMethod: 'BANK', notes: 'Double-billed.',
      })
    ).body.data.settlement;
    const returned = await api
      .post(`${CMS}/finance/settlements/${created.id}/reject`)
      .set('Authorization', approver.auth)
      .send({ note: 'Attach the source invoice number.', category: 'Pricing or promotion', assignTeam: 'Operations', dueDate: '2026-12-01' });
    expect(returned.status).toBe(200);
    expect(returned.body.data.settlement.changeRequests[0]).toMatchObject({ assignTeam: 'Operations', assigneeId: null });
    expect(await prisma.staffNotification.count()).toBe(0);
    const queue = await api.get(`${CMS}/finance/settlements`).query({ status: 'CHANGES_REQUESTED' }).set('Authorization', approver.auth);
    expect(queue.body.data.map((r: { ref: string }) => r.ref)).toContain(created.ref);
    const actions = await api.get(`${CMS}/action-items`).set('Authorization', owner.auth);
    expect(actions.body.data.map((a: { title: string }) => a.title).join('\n')).toContain(created.ref);
  });
});

describe('processing — idempotent, per return method (scenarios A–C)', () => {
  let w: World;
  let owner: Operator;
  let approver: Operator;
  let operator: Operator;
  // Process/post rides on bill-transactions:approve (brief §6) — the third
  // party is a second approver-role holder, distinct from requester+approver.
  let processor: Operator;

  beforeEach(async () => {
    await resetDb();
    resetStripeEnv();
    w = await seedWorld();
    owner = await createOperator('OWNER');
    approver = await createOperator('FINANCE_APPROVER');
    operator = await createOperator('FINANCE_OPERATOR');
    processor = await createOperator('FINANCE_APPROVER');
  });

  async function sourceInvoice(tenantId: string, unitId: string, piId: string) {
    return prisma.invoice.create({
      data: {
        invoiceNo: `INV-E2E-${piId}`,
        tenantId,
        unitId,
        amount: 600,
        status: 'PAID',
        paidAt: new Date('2026-11-01T00:00:00.000Z'),
        paymentIntentId: piId,
        dueDate: new Date('2026-11-01T00:00:00.000Z'),
        billedMonth: new Date('2026-11-01T00:00:00.000Z'),
      },
    });
  }

  async function approvedManualRefund(auth: string, overrides: Record<string, unknown> = {}) {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const created = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 80, reasonCode: 'overcharge', sourceRef: 'INV-7', returnMethod: 'ORIGINAL', notes: 'Double-billed.', ...overrides,
      })
    ).body.data.settlement;
    await api.post(`${CMS}/finance/settlements/${created.id}/approve`).set('Authorization', approver.auth).send({});
    return { tenant, unit, settlementId: created.id };
  }

  it('ORIGINAL: process → webhook success posts one credit; redelivery is a no-op', async () => {
    fake.state.nextStatus = 'pending';
    const { tenant, unit, settlementId } = await approvedManualRefund(operator.auth);
    await sourceInvoice(tenant.id, unit.id, 'pi_src_1');
    const first = await api
      .post(`${CMS}/finance/settlements/${settlementId}/process`)
      .set('Authorization', processor.auth)
      .set('Idempotency-Key', 'proc-1')
      .send({});
    expect(first.status).toBe(200);
    expect(first.body.data.settlement.status).toBe('PROCESSING');
    expect(fake.state.creates).toBe(1);
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId } })).toBe(0);
    // Retry before confirmation creates no second provider call.
    const retry = await api
      .post(`${CMS}/finance/settlements/${settlementId}/process`)
      .set('Authorization', processor.auth)
      .set('Idempotency-Key', 'proc-1')
      .send({});
    expect(retry.status).toBe(200);
    expect(retry.body.data.deduplicated).toBe(true);
    expect(fake.state.creates).toBe(1);

    const refund = [...fake.state.refunds.values()][0]!;
    const payload = JSON.stringify({
      id: 'evt_ok_1',
      object: 'event',
      type: 'refund.updated',
      data: { object: { id: refund.id, object: 'refund', amount: 8000, status: 'succeeded', payment_intent: 'pi_src_1', metadata: { settlementId }, created: 1763600000 } },
    });
    const header = new Stripe('sk_test_fake').webhooks.generateTestHeaderString({ payload, secret: 'whsec_e2e_moveout_finance' });
    const wh = await api.post('/api/v1/customer/stripe/webhook').set('stripe-signature', header).set('Content-Type', 'application/json').send(payload);
    expect(wh.status).toBe(200);
    expect(wh.body.data).toMatchObject({ received: true, applied: true });
    const settled = await prisma.customerSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(settled).toMatchObject({ status: 'REFUNDED', processorRef: refund.id, postingRef: `POST-${settled.ref}` });
    const lines = await prisma.customerLedgerEntry.findMany({ where: { settlementId } });
    expect(lines).toHaveLength(1);
    // Negative entries balance: the credit nets the signed settlement amount.
    expect(lines[0]).toMatchObject({ entryType: 'REFUND', debit: null, status: 'Refunded', processorRef: refund.id });
    expect(Number(lines[0]!.credit)).toBe(80);
    expect(ledgerBalance(lines.map((l) => ({ ...l, debit: l.debit != null ? Number(l.debit) : null, credit: l.credit != null ? Number(l.credit) : null })))).toBe(-80);
    // Redelivery of the same event is a no-op (exactly-once claim).
    const dup = await api.post('/api/v1/customer/stripe/webhook').set('stripe-signature', header).set('Content-Type', 'application/json').send(payload);
    expect(dup.body.data).toMatchObject({ received: true, applied: false });
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId } })).toBe(1);
  });

  it('webhook failure leaves the record Approved — never Refunded — with no ledger lines', async () => {
    fake.state.nextStatus = 'pending';
    const { tenant, unit, settlementId } = await approvedManualRefund(operator.auth);
    await sourceInvoice(tenant.id, unit.id, 'pi_src_2');
    await api.post(`${CMS}/finance/settlements/${settlementId}/process`).set('Authorization', processor.auth).send({});
    const refund = [...fake.state.refunds.values()][0]!;
    const payload = JSON.stringify({
      id: 'evt_fail_1',
      object: 'event',
      type: 'refund.updated',
      data: { object: { id: refund.id, object: 'refund', amount: 8000, status: 'failed', payment_intent: 'pi_src_2', metadata: { settlementId } } },
    });
    const header = new Stripe('sk_test_fake').webhooks.generateTestHeaderString({ payload, secret: 'whsec_e2e_moveout_finance' });
    const wh = await api.post('/api/v1/customer/stripe/webhook').set('stripe-signature', header).set('Content-Type', 'application/json').send(payload);
    expect(wh.body.data).toMatchObject({ received: true, applied: true });
    const settled = await prisma.customerSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(settled.status).toBe('APPROVED');
    expect(settled.processingError).toMatch(/nothing was posted/);
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId } })).toBe(0);
  });

  it('Stripe 5xx keeps PROCESSING; the same-function retry compensates without duplicates', async () => {
    fake.state.nextStatus = 'pending';
    const { tenant, unit, settlementId } = await approvedManualRefund(operator.auth);
    await sourceInvoice(tenant.id, unit.id, 'pi_src_3');
    fake.state.throwMode = { type: 'StripeConnectionError', statusCode: 500, message: 'Upstream timeout.' };
    const failed = await api.post(`${CMS}/finance/settlements/${settlementId}/process`).set('Authorization', processor.auth).send({});
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('PROCESSOR_OUTAGE');
    expect((await prisma.customerSettlement.findUniqueOrThrow({ where: { id: settlementId } })).status).toBe('PROCESSING');
    // Retry with a healthy provider completes through the same function.
    fake.state.throwMode = null;
    fake.state.nextStatus = 'succeeded';
    const okRes = await api.post(`${CMS}/finance/settlements/${settlementId}/process`).set('Authorization', processor.auth).send({});
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.settlement.status).toBe('REFUNDED');
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId } })).toBe(1);
  });

  it('Stripe invalid-request rejects back to APPROVED for operator correction', async () => {
    const { tenant, unit, settlementId } = await approvedManualRefund(operator.auth);
    await sourceInvoice(tenant.id, unit.id, 'pi_src_4');
    fake.state.throwMode = { type: 'StripeInvalidRequestError', statusCode: 400, message: 'Charge already refunded.' };
    const res = await api.post(`${CMS}/finance/settlements/${settlementId}/process`).set('Authorization', processor.auth).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROCESSOR_REJECTED');
    const settled = await prisma.customerSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(settled.status).toBe('APPROVED');
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId } })).toBe(0);
  });

  it('WALLET: process grants account credit once; retry is a no-op success', async () => {
    const { settlementId, tenant } = await approvedManualRefund(operator.auth, { returnMethod: 'WALLET', sourceRef: null, reasonCode: 'service-recovery' });
    const first = await api
      .post(`${CMS}/finance/settlements/${settlementId}/process`)
      .set('Authorization', processor.auth)
      .set('Idempotency-Key', 'wallet-1')
      .send({});
    expect(first.body.data.settlement.status).toBe('REFUNDED');
    const wallet = await prisma.creditWallet.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(Number(wallet.balance)).toBe(80);
    const retry = await api
      .post(`${CMS}/finance/settlements/${settlementId}/process`)
      .set('Authorization', processor.auth)
      .set('Idempotency-Key', 'wallet-1')
      .send({});
    expect(retry.body.data.deduplicated).toBe(true);
    expect(Number((await prisma.creditWallet.findUniqueOrThrow({ where: { tenantId: tenant.id } })).balance)).toBe(80);
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId } })).toBe(1);
  });

  it('BANK: instruction first, then confirmation posts; no ledger until confirmed', async () => {
    const { settlementId } = await approvedManualRefund(operator.auth, { returnMethod: 'BANK', sourceRef: null, reasonCode: 'service-recovery' });
    const instructed = await api.post(`${CMS}/finance/settlements/${settlementId}/process`).set('Authorization', processor.auth).send({});
    expect(instructed.body.data.settlement).toMatchObject({ status: 'PROCESSING' });
    expect(instructed.body.data.settlement.processorRef).toMatch(/^BANK-/);
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId } })).toBe(0);
    const confirmed = await api
      .post(`${CMS}/finance/settlements/${settlementId}/process`)
      .set('Authorization', processor.auth)
      .send({ bankReference: 'FAST-2026-118' });
    expect(confirmed.body.data.settlement).toMatchObject({ status: 'REFUNDED', processorRef: 'FAST-2026-118' });
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId } })).toBe(1);
  });

  it('CHARGE: process issues an invoice, posts a debit line and completes the move-out', async () => {
    const unit = await makeUnit(w, 661.5);
    const tenant = await makeTenant(w, unit.id, 661.5);
    // 66150 × 15 ÷ 30 = S$330.75 refund; S$350 cleaning → S$19.25 charge.
    const c = (
      await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
        tenantId: tenant.id, finalAccessDate: '2026-11-15', requestReceivedAt: '2026-10-10', requestChannel: CHANNEL, reasonCode: REASON,
      })
    ).body.data;
    const done = (
      await api.post(`${CMS}/move-out-cases/${c.id}/inspection`).set('Authorization', owner.auth).send({
        unitEmpty: true, doorLockWallsFloorChecked: true, accessRevoked: true, releaseConfirmed: true,
        releaseStatus: 'READY', cleaningCharge: 350, notes: 'Deep clean required, evidence attached.',
      })
    ).body.data;
    expect(done.settlement).toMatchObject({ docType: 'Charge', amount: 19.25, status: 'PENDING_APPROVAL' });
    await api.post(`${CMS}/finance/settlements/${done.settlement.id}/approve`).set('Authorization', approver.auth).send({});
    const posted = await api.post(`${CMS}/finance/settlements/${done.settlement.id}/process`).set('Authorization', processor.auth).send({});
    expect(posted.body.data.settlement).toMatchObject({ status: 'POSTED' });
    const invoiceNo = posted.body.data.settlement.postingRef as string;
    expect(invoiceNo).toMatch(/^INV-/);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { invoiceNo } });
    expect(invoice).toMatchObject({ status: 'ISSUED' });
    expect(Number(invoice.amount)).toBe(19.25);
    // A re-run is a no-op: one invoice, one debit line, completed rental.
    const rerun = await api.post(`${CMS}/finance/settlements/${done.settlement.id}/process`).set('Authorization', processor.auth).send({});
    expect(rerun.body.data.deduplicated).toBe(true);
    expect(await prisma.invoice.count({ where: { idempotencyKey: `inv-${done.settlement.id}` } })).toBe(1);
    const lines = await prisma.customerLedgerEntry.findMany({ where: { settlementId: done.settlement.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ entryType: 'CHARGE', credit: null, status: 'Posted', invoiceId: invoice.id });
    expect(Number(lines[0]!.debit)).toBe(19.25);
    expect(ledgerBalance(lines.map((l) => ({ ...l, debit: l.debit != null ? Number(l.debit) : null, credit: l.credit != null ? Number(l.credit) : null })))).toBe(19.25);
    const finished = await prisma.moveOutCase.findUniqueOrThrow({ where: { id: c.id } });
    expect(finished.status).toBe('COMPLETED');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).status).toBe('INACTIVE');
    expect(await prisma.rentalUnitHistory.count({ where: { sourceSettlementId: done.settlement.id } })).toBe(1);
  });

  it('move-out refund end-to-end: approve → Stripe → webhook → COMPLETED Former rental', async () => {
    fake.state.nextStatus = 'succeeded';
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const { caseId, settlement } = await moveOutToSettlement(owner.auth, tenant.id);
    await api.post(`${CMS}/finance/settlements/${settlement.id}/approve`).set('Authorization', approver.auth).send({});
    await sourceInvoice(tenant.id, unit.id, 'pi_src_5');
    const processed = await api.post(`${CMS}/finance/settlements/${settlement.id}/process`).set('Authorization', processor.auth).send({});
    // Synchronous provider confirmation completes in the same call.
    expect(processed.body.data.settlement.status).toBe('REFUNDED');
    const finished = await prisma.moveOutCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(finished.status).toBe('COMPLETED');
    const former = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(former).toMatchObject({ status: 'INACTIVE', unitId: null });
    expect(await prisma.rentalUnitHistory.count({ where: { tenantId: tenant.id, endReason: 'MOVE_OUT' } })).toBe(1);
  });

  it('process enforces the three-party rule (processor ≠ requester/approver)', async () => {
    const { settlementId } = await approvedManualRefund(operator.auth);
    const asRequester = await api.post(`${CMS}/finance/settlements/${settlementId}/process`).set('Authorization', operator.auth).send({});
    expect(asRequester.status).toBe(403);
    const asApprover = await api.post(`${CMS}/finance/settlements/${settlementId}/process`).set('Authorization', approver.auth).send({});
    expect(asApprover.status).toBe(403);
  });

  it('a settlement with no source card payment explains the card path is unavailable', async () => {
    const { settlementId } = await approvedManualRefund(operator.auth);
    const res = await api.post(`${CMS}/finance/settlements/${settlementId}/process`).set('Authorization', processor.auth).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch('No source card payment found');
    expect((await prisma.customerSettlement.findUniqueOrThrow({ where: { id: settlementId } })).status).toBe('APPROVED');
  });
});

describe('A-16 blocked APPROVED recovery — return for changes or cancel', () => {
  let w: World;
  let owner: Operator;
  let approver: Operator;
  let operator: Operator;
  let processor: Operator;
  // Maker-checker probes need a requester who holds the approve permission
  // (otherwise the route permission gate answers first) — a distinct
  // FINANCE_APPROVER from the approver/processor pair.
  let requester: Operator;

  beforeEach(async () => {
    await resetDb();
    resetStripeEnv();
    w = await seedWorld();
    owner = await createOperator('OWNER');
    approver = await createOperator('FINANCE_APPROVER');
    operator = await createOperator('FINANCE_OPERATOR');
    processor = await createOperator('FINANCE_APPROVER');
    requester = await createOperator('FINANCE_APPROVER');
  });

  async function approvedOriginalRefund(auth: string) {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const created = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 80, reasonCode: 'overcharge', sourceRef: 'INV-A16', returnMethod: 'ORIGINAL', notes: 'Double-billed.',
      })
    ).body.data.settlement;
    await api.post(`${CMS}/finance/settlements/${created.id}/approve`).set('Authorization', approver.auth).send({});
    return { tenant, unit, settlementId: created.id, ref: created.ref as string };
  }

  it('blocked process names the recovery actions; return → correct method → re-approve → process succeeds', async () => {
    const { tenant, settlementId, ref } = await approvedOriginalRefund(requester.auth);
    // No source card on file: processing is blocked, the record stays
    // APPROVED, and the error names the actions actually available.
    const blocked = await api.post(`${CMS}/finance/settlements/${settlementId}/process`).set('Authorization', processor.auth).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch('No source card payment found');
    expect(blocked.body.error.message).toMatch('Return for changes');
    expect(blocked.body.error.message).toMatch('Cancel');
    expect((await prisma.customerSettlement.findUniqueOrThrow({ where: { id: settlementId } })).status).toBe('APPROVED');

    // The requester cannot return their own approved record for changes.
    const selfReturn = await api
      .post(`${CMS}/finance/settlements/${settlementId}/reject`)
      .set('Authorization', requester.auth)
      .send({ note: 'Switch method.' });
    expect(selfReturn.status).toBe(403);
    expect(selfReturn.body.error.code).toBe('MAKER_CHECKER');

    // A different Finance operator returns it for changes with a reason.
    const returned = await api
      .post(`${CMS}/finance/settlements/${settlementId}/reject`)
      .set('Authorization', processor.auth)
      .send({ note: 'No source card — switch to account credit.', category: 'Return method', assignTeam: 'Operations' });
    expect(returned.status).toBe(200);
    expect(returned.body.data.settlement).toMatchObject({ id: settlementId, status: 'CHANGES_REQUESTED' });
    const returnAudits = await prisma.financeAuditEvent.findMany({ where: { entityType: 'CustomerSettlement', entityId: settlementId, action: 'settlement.changes_requested' } });
    expect(returnAudits).toHaveLength(1);
    expect(returnAudits[0]!.after).toMatchObject({ status: 'CHANGES_REQUESTED' });

    // Correction resubmits the SAME ref with the fixed return method.
    const corrected = await api
      .post(`${CMS}/finance/settlements/${settlementId}/correct`)
      .set('Authorization', operator.auth)
      .send({ returnMethod: 'WALLET', notes: 'No card on file — account credit instead.' });
    expect(corrected.status).toBe(200);
    expect(corrected.body.data.settlement).toMatchObject({ id: settlementId, ref, status: 'PENDING_APPROVAL', returnMethod: 'WALLET', amount: -80 });
    expect(corrected.body.data.outcomeChanged ?? false).toBe(false);

    // Re-approval by a different approver, then processing succeeds.
    const reapproved = await api.post(`${CMS}/finance/settlements/${settlementId}/approve`).set('Authorization', approver.auth).send({});
    expect(reapproved.body.data.settlement.status).toBe('APPROVED');
    const processed = await api.post(`${CMS}/finance/settlements/${settlementId}/process`).set('Authorization', processor.auth).send({});
    expect(processed.body.data.settlement).toMatchObject({ id: settlementId, status: 'REFUNDED' });
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId } })).toBe(1);
    expect(Number((await prisma.creditWallet.findUniqueOrThrow({ where: { tenantId: tenant.id } })).balance)).toBe(80);
  });

  it('cancel-with-reason path: blocked APPROVED → CANCELLED, audited, terminal', async () => {
    const { settlementId } = await approvedOriginalRefund(requester.auth);
    const blocked = await api.post(`${CMS}/finance/settlements/${settlementId}/process`).set('Authorization', processor.auth).send({});
    expect(blocked.status).toBe(409);

    // Cancelling needs a reason.
    const noReason = await api.post(`${CMS}/finance/settlements/${settlementId}/cancel`).set('Authorization', processor.auth).send({});
    expect(noReason.status).toBe(400);

    // The requester cannot cancel their own record.
    const selfCancel = await api
      .post(`${CMS}/finance/settlements/${settlementId}/cancel`)
      .set('Authorization', requester.auth)
      .send({ reason: 'Customer withdrew the claim.' });
    expect(selfCancel.status).toBe(403);
    expect(selfCancel.body.error.code).toBe('MAKER_CHECKER');

    const cancelled = await api
      .post(`${CMS}/finance/settlements/${settlementId}/cancel`)
      .set('Authorization', processor.auth)
      .send({ reason: 'Customer withdrew the claim — card path unavailable.' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.settlement).toMatchObject({ id: settlementId, status: 'CANCELLED' });
    const audits = await prisma.financeAuditEvent.findMany({ where: { entityType: 'CustomerSettlement', entityId: settlementId, action: 'settlement.cancelled' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: processor.email });
    expect(audits[0]!.before).toMatchObject({ status: 'APPROVED' });
    expect(audits[0]!.after).toMatchObject({ status: 'CANCELLED' });
    // Terminal: no further processing, correction, or return.
    const afterProcess = await api.post(`${CMS}/finance/settlements/${settlementId}/process`).set('Authorization', processor.auth).send({});
    expect(afterProcess.body.data.deduplicated).toBe(true);
    const afterReturn = await api
      .post(`${CMS}/finance/settlements/${settlementId}/reject`)
      .set('Authorization', approver.auth)
      .send({ note: 'Too late.' });
    expect(afterReturn.status).toBe(409);
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId } })).toBe(0);
  });
});

describe('refunds register — list/filter (handoff §12)', () => {
  let w: World;
  let owner: Operator;
  let approver: Operator;
  let operator: Operator;
  let processor: Operator;

  beforeEach(async () => {
    await resetDb();
    resetStripeEnv();
    w = await seedWorld();
    owner = await createOperator('OWNER');
    approver = await createOperator('FINANCE_APPROVER');
    operator = await createOperator('FINANCE_OPERATOR');
    processor = await createOperator('FINANCE_APPROVER');
  });

  it('filters by status, date range, facility and processor — with the handoff empty copy', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const created = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 25, reasonCode: 'overcharge', sourceRef: 'INV-3', returnMethod: 'WALLET', notes: 'Double-billed.',
      })
    ).body.data.settlement;
    const empty = await api.get(`${CMS}/finance/settlements/refunds`).set('Authorization', operator.auth).query({ status: 'POSTED' });
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);
    expect(empty.body.meta).toMatchObject({ empty: 'No records match these filters.' });
    const pending = await api.get(`${CMS}/finance/settlements/refunds`).set('Authorization', operator.auth).query({ status: 'PENDING_APPROVAL' });
    expect(pending.body.data.map((r: { ref: string }) => r.ref)).toEqual([created.ref]);
    const branch = await prisma.branch.findUniqueOrThrow({ where: { id: w.branchId } });
    const byFacility = await api.get(`${CMS}/finance/settlements/refunds`).set('Authorization', operator.auth).query({ facility: branch.code });
    expect(byFacility.body.data).toHaveLength(1);
    const byProcessorBefore = await api.get(`${CMS}/finance/settlements/refunds`).set('Authorization', operator.auth).query({ processor: 'WALLET' });
    expect(byProcessorBefore.body.data).toHaveLength(0);
    await api.post(`${CMS}/finance/settlements/${created.id}/approve`).set('Authorization', approver.auth).send({});
    await api.post(`${CMS}/finance/settlements/${created.id}/process`).set('Authorization', processor.auth).send({});
    const byProcessorAfter = await api.get(`${CMS}/finance/settlements/refunds`).set('Authorization', operator.auth).query({ processor: 'WALLET' });
    expect(byProcessorAfter.body.data).toHaveLength(1);
    const bySearch = await api.get(`${CMS}/finance/settlements/refunds`).set('Authorization', operator.auth).query({ search: created.ref });
    expect(bySearch.body.data).toHaveLength(1);
    const today = new Date().toISOString().slice(0, 10);
    const byDate = await api.get(`${CMS}/finance/settlements/refunds`).set('Authorization', operator.auth).query({ from: '2026-01-01', to: today });
    expect(byDate.body.data).toHaveLength(1);
    expect(byDate.body.meta).toMatchObject({ total: 1, refunded: 1 });
  });

  it('the canonical register shows the new lifecycle with processor evidence', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const { settlement } = await moveOutToSettlement(owner.auth, tenant.id);
    const reg = await api.get(`${CMS}/finance/register`).set('Authorization', operator.auth).query({ status: 'Pending approval' });
    expect(reg.status).toBe(200);
    const row = reg.body.data.rows.find((r: { recordId: string }) => r.recordId === settlement.ref);
    expect(row).toMatchObject({ docType: 'Refund', status: 'Pending approval', pending: true });
    const byProcessor = await api.get(`${CMS}/finance/register`).set('Authorization', operator.auth).query({ processor: 'STRIPE' });
    expect(byProcessor.status).toBe(200);
  });

  it('a posted move-out keeps its unit and labels the charge invoice (A-13/A-14)', async () => {
    const unit = await makeUnit(w, 661.5);
    const tenant = await makeTenant(w, unit.id, 661.5);
    // 66150 × 15 ÷ 30 = S$330.75 refund; S$350 cleaning → S$19.25 charge.
    const c = (
      await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
        tenantId: tenant.id, finalAccessDate: '2026-11-15', requestReceivedAt: '2026-10-10', requestChannel: CHANNEL, reasonCode: REASON,
      })
    ).body.data;
    const done = (
      await api.post(`${CMS}/move-out-cases/${c.id}/inspection`).set('Authorization', owner.auth).send({
        unitEmpty: true, doorLockWallsFloorChecked: true, accessRevoked: true, releaseConfirmed: true,
        releaseStatus: 'READY', cleaningCharge: 350, notes: 'Deep clean required, evidence attached.',
      })
    ).body.data;
    expect(done.settlement).toMatchObject({ docType: 'Charge', amount: 19.25 });
    const ref = done.settlement.ref as string;
    await api.post(`${CMS}/finance/settlements/${done.settlement.id}/approve`).set('Authorization', approver.auth).send({});
    const posted = await api.post(`${CMS}/finance/settlements/${done.settlement.id}/process`).set('Authorization', processor.auth).send({});
    expect(posted.body.data.settlement.status).toBe('POSTED');
    const invoiceNo = posted.body.data.settlement.postingRef as string;
    // Completion releases the tenant — the A-13 regression context: the
    // tenant read carries no unit from here on.
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).unitId).toBeNull();
    const reg = await api.get(`${CMS}/finance/register`).set('Authorization', operator.auth).query({ search: ref });
    expect(reg.status).toBe(200);
    // A-13: the Finance record carries the settlement's unit, not "—".
    const srow = reg.body.data.rows.find((r: { recordId: string }) => r.recordId === ref);
    expect(srow).toMatchObject({ unit: unit.unitCode, unitName: unit.unitCode, docType: 'Charge', purpose: 'Move-out settlement', status: 'Posted' });
    // A-14: the posted charge invoice is not labelled monthly rent; the raw
    // ISSUED invoice status reads as a Due pill label.
    const irow = reg.body.data.rows.find((r: { recordId: string }) => r.recordId === invoiceNo);
    expect(irow).toMatchObject({ docType: 'Invoice', status: 'Due', purpose: `Move-out settlement charge · ${ref}` });
  });

  it('enforces bill-transactions permissions and facility scope', async () => {
    const viewer = await createOperator('VIEWER');
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    expect((await api.post(`${CMS}/finance/settlements`).set('Authorization', viewer.auth).send({
      tenantId: tenant.id, unitId: unit.id, amount: 10, reasonCode: 'other', returnMethod: 'WALLET', notes: 'x.',
    })).status).toBe(403);
    const created = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 10, reasonCode: 'other', returnMethod: 'WALLET', notes: 'Documented.',
      })
    ).body.data.settlement;
    // Operator holds create/update but not approve. Review actions (approve,
    // reject-as-change-request, process) are approve-grade; corrections ride
    // on update (covered in the round-trip suite).
    expect((await api.post(`${CMS}/finance/settlements/${created.id}/approve`).set('Authorization', operator.auth).send({})).status).toBe(403);
    expect((await api.post(`${CMS}/finance/settlements/${created.id}/process`).set('Authorization', operator.auth).send({})).status).toBe(403);
    expect((await api.post(`${CMS}/finance/settlements/${created.id}/reject`).set('Authorization', operator.auth).send({ note: 'Fix.' })).status).toBe(403);

    // Facility scope: a second branch settlement is invisible to a scoped op.
    const otherBranch = await prisma.branch.create({ data: { code: 'WD', name: 'Woodlands (E2E)', address: 'Woodlands', operatingHours: '9-9' } });
    const otherFloor = await prisma.floor.create({ data: { branchId: otherBranch.id, level: 1, name: 'L1' } });
    const otherUnit = await makeUnit(w, 99, otherBranch.id, otherFloor.id);
    const otherTenant = await makeTenant(w, otherUnit.id, 99, otherBranch.id);
    const owner = await createOperator('OWNER');
    const other = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', owner.auth).send({
        tenantId: otherTenant.id, unitId: otherUnit.id, amount: 5, reasonCode: 'other', returnMethod: 'WALLET', notes: 'Other site.',
      })
    ).body.data.settlement;
    const role = (
      await api.post(`${CMS}/roles`).set('Authorization', owner.auth).send({
        name: 'E2E Finance Scoped',
        permissions: ['bill-transactions:view', 'bill-transactions:create', 'bill-transactions:update'],
      })
    ).body.data;
    const scoped = await createOperator(role.id);
    await prisma.operatorFacilityAccess.create({ data: { adminUserId: scoped.id, branchId: w.branchId, scope: 'FACILITY' } });
    const list = (await api.get(`${CMS}/finance/settlements/refunds`).set('Authorization', scoped.auth)).body.data;
    expect(list.map((r: { id: string }) => r.id)).toEqual([created.id]);
    // A correction outside the scope reads as not found (update-grant held,
    // so the 404 comes from facility scope, not the permission guard).
    expect((await api.post(`${CMS}/finance/settlements/${other.id}/correct`).set('Authorization', scoped.auth).send({ notes: 'x' })).status).toBe(404);
  });
});

describe('shared ledger posting — idempotent, reversals balance', () => {
  let w: World;
  let approver: Operator;
  let operator: Operator;
  let processor: Operator;

  beforeEach(async () => {
    await resetDb();
    resetStripeEnv();
    w = await seedWorld();
    approver = await createOperator('FINANCE_APPROVER');
    operator = await createOperator('FINANCE_OPERATOR');
    processor = await createOperator('FINANCE_APPROVER');
  });

  it('re-running a posted settlement is a no-op success without new lines or attempts', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const created = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 30, reasonCode: 'service-recovery', returnMethod: 'WALLET', notes: 'Goodwill.',
      })
    ).body.data.settlement;
    await api.post(`${CMS}/finance/settlements/${created.id}/approve`).set('Authorization', approver.auth).send({});
    await api.post(`${CMS}/finance/settlements/${created.id}/process`).set('Authorization', processor.auth).send({});
    const attemptsBefore = await prisma.processorAttempt.count({ where: { settlementId: created.id } });
    const rerun = await api.post(`${CMS}/finance/settlements/${created.id}/process`).set('Authorization', processor.auth).send({});
    expect(rerun.body.data.deduplicated).toBe(true);
    expect(rerun.body.data.settlement.status).toBe('REFUNDED');
    expect(await prisma.processorAttempt.count({ where: { settlementId: created.id } })).toBe(attemptsBefore);
    expect(await prisma.customerLedgerEntry.count({ where: { settlementId: created.id } })).toBe(1);
  });

  it('accrual reversals net to zero and keep the originals immutable', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const created = (
      await api.post(`${CMS}/finance/settlements`).set('Authorization', operator.auth).send({
        tenantId: tenant.id, unitId: unit.id, amount: 30, reasonCode: 'service-recovery', returnMethod: 'WALLET', notes: 'Goodwill.',
      })
    ).body.data.settlement;
    await api.post(`${CMS}/finance/settlements/${created.id}/approve`).set('Authorization', approver.auth).send({});
    await api.post(`${CMS}/finance/settlements/${created.id}/process`).set('Authorization', processor.auth).send({});
    const before = await prisma.customerLedgerEntry.findMany({ where: { settlementId: created.id }, orderBy: { createdAt: 'asc' } });
    expect(before).toHaveLength(1);
    const out = await reverseSettlementLines(created.id, processor.email, 'E2E reversal check');
    expect(out.deduplicated).toBe(false);
    expect(out.reversals).toHaveLength(1);
    const after = await prisma.customerLedgerEntry.findMany({ where: { settlementId: created.id }, orderBy: { createdAt: 'asc' } });
    expect(after).toHaveLength(2);
    // The original row is untouched; the mirror nets the live balance to zero.
    expect(after[0]).toMatchObject({ status: 'Refunded', reversalOfId: null });
    expect(after[1]).toMatchObject({ status: 'Reversed', reversalOfId: before[0]!.id });
    expect(ledgerBalance(after.map((l) => ({ ...l, debit: l.debit != null ? Number(l.debit) : null, credit: l.credit != null ? Number(l.credit) : null })))).toBe(0);
    const again = await reverseSettlementLines(created.id, processor.email, 'E2E reversal check');
    expect(again.deduplicated).toBe(true);
  });
});

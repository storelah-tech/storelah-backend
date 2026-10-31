// Finance Phase 4 — Close and controls (spec §§12/18/19/20, Q4 v1.2 FINAL).
//
// Covers: credits wallet (grant/apply ledger), refund calculator + reasons,
// every-refund maker-checker (no threshold) + super-admin bypass audit,
// negative-computation → charge, bank-verify gate, arrears recovery gates
// (timings, late-fee BLOCKED without config, waive approver-gated,
// termination stub), write-off flow, reconciliation import/match/suspense/
// close checklist, month close freezing actuals + adjustments-as-new-events,
// performance em-dash until posted, and posted-month BLOCKED writes.

import { describe, expect, it, beforeEach } from 'vitest';
import { prisma } from '../../src/lib/prisma';
import { toNum } from '../../src/lib/format';
import { api, createOperator, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';

const CMS = '/api/v1/cms';
const CLOSE_MONTH = '2026-09';

interface World {
  operator: { auth: string; email: string; id: string };
  approverA: { auth: string; email: string; id: string };
  approverB: { auth: string; email: string; id: string };
  owner: { auth: string; email: string; id: string };
  branchId: string;
  unitId: string;
  tenantId: string;
}

let unitSeq = 0;
async function seedWorld(): Promise<World> {
  const email = uniqueEmail();
  const reg = await api.post('/api/v1/customer/register').send({
    name: 'E2E Phase4',
    email,
    mobile: '81234567',
    password: 'e2e-phase4-1',
    type: 'PERSONAL',
  });
  expect(reg.status).toBe(201);
  const branch = await prisma.branch.findUnique({ where: { code: 'SW' } });
  if (!branch) throw new Error('[e2e] move-in world not seeded');
  const size = await prisma.unitSize.findFirst();
  const floor = await prisma.floor.findFirst({ where: { branchId: branch.id } });
  if (!size || !floor) throw new Error('[e2e] move-in world not seeded');
  unitSeq += 1;
  const unit = await prisma.unit.create({
    data: {
      branchId: branch.id,
      floorId: floor.id,
      sizeId: size.id,
      unitCode: `E2E-4-${Date.now().toString(36)}-${unitSeq.toString(36)}`,
      sqft: 50,
      monthlyRate: 200,
      status: 'AVAILABLE',
    },
  });
  const tenant = await prisma.tenant.create({
    data: {
      name: 'E2E Phase4 Tenant',
      email,
      mobile: '81234567',
      unitId: unit.id,
      moveInDate: new Date('2026-08-01T00:00:00Z'),
      monthlyRate: 200,
      psf: 4,
      status: 'ACTIVE',
      branchId: branch.id,
    },
  });
  return {
    operator: await createOperator('FINANCE_OPERATOR'),
    approverA: await createOperator('FINANCE_APPROVER'),
    approverB: await createOperator('FINANCE_APPROVER'),
    owner: await createOperator('OWNER'),
    branchId: branch.id,
    unitId: unit.id,
    tenantId: tenant.id,
  };
}

const OCT = { start: '2026-10-01T00:00:00Z', end: '2026-10-31T00:00:00Z' };

async function draft(auth: string, w: World, overrides: Record<string, unknown> = {}) {
  const res = await api.post(`${CMS}/finance/invoices`).set('Authorization', auth).send({
    tenantId: w.tenantId,
    dueDate: '2026-10-15T00:00:00Z',
    serviceStart: OCT.start,
    serviceEnd: OCT.end,
    lines: [{ kind: 'RENT', label: 'Storage rent — October', amount: 200 }],
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; version: number; no: string };
}

async function issued(auth: string, w: World, overrides: Record<string, unknown> = {}) {
  const d = await draft(w.operator.auth, w, overrides);
  const appr = await api.post(`${CMS}/finance/invoices/${d.id}/approve`).set('Authorization', auth).send({ version: d.version });
  expect(appr.status).toBe(200);
  const iss = await api.post(`${CMS}/finance/invoices/${d.id}/issue`).set('Authorization', auth).send({ version: appr.body.data.version });
  expect(iss.status).toBe(200);
  return iss.body.data as { id: string; version: number; no: string };
}

function calc(overrides: Record<string, unknown> = {}) {
  return {
    monthlyRent: 200,
    daysInMonth: 30,
    unusedDays: 15,
    reason: 'e2e move-out refund',
    ...overrides,
  };
}

describe('finance phase 4 — credits wallet', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('credits.grant-apply-ledger: grant posts a GRANT entry; apply allocates, then pays in full', async () => {
    const w = await seedWorld();
    const inv = await issued(w.approverA.auth, w);
    const g = await api.post(`${CMS}/finance/credits/grant`).set('Authorization', w.operator.auth).send({
      tenantId: w.tenantId,
      amount: 200,
      note: 'goodwill',
    });
    expect(g.status).toBe(201);
    expect(g.body.data).toMatchObject({ balance: 200 });
    expect(g.body.data.entries.map((e: { kind: string }) => e.kind)).toContain('GRANT');

    const a1 = await api.post(`${CMS}/finance/credits/apply`).set('Authorization', w.operator.auth).send({
      tenantId: w.tenantId,
      invoiceId: inv.id,
      amount: 60,
    });
    expect(a1.status).toBe(201);
    expect(a1.body.data).toMatchObject({ applied: 60, wallet: { balance: 140 } });
    const mid = (await api.get(`${CMS}/finance/invoices/${inv.id}`).set('Authorization', w.operator.auth)).body.data;
    expect(mid).toMatchObject({ creditApplied: 60, balanceDue: 140, status: 'ISSUED' });
    expect(mid.lines.map((l: { kind: string }) => l.kind)).toContain('CREDIT');

    const a2 = await api.post(`${CMS}/finance/credits/apply`).set('Authorization', w.operator.auth).send({
      tenantId: w.tenantId,
      invoiceId: inv.id,
    });
    expect(a2.status).toBe(201);
    const done = (await api.get(`${CMS}/finance/invoices/${inv.id}`).set('Authorization', w.operator.auth)).body.data;
    expect(done).toMatchObject({ status: 'PAID', balanceDue: 0 });
  });

  it('credits.apply-guards: empty wallet, over-balance and over-invoice all fail', async () => {
    const w = await seedWorld();
    const inv = await issued(w.approverA.auth, w);
    expect((await api.post(`${CMS}/finance/credits/apply`).set('Authorization', w.operator.auth).send({
      tenantId: w.tenantId, invoiceId: inv.id, amount: 10,
    })).status).toBe(409);
    await api.post(`${CMS}/finance/credits/grant`).set('Authorization', w.operator.auth).send({ tenantId: w.tenantId, amount: 50 });
    expect((await api.post(`${CMS}/finance/credits/apply`).set('Authorization', w.operator.auth).send({
      tenantId: w.tenantId, invoiceId: inv.id, amount: 60,
    })).status).toBe(409);
    expect((await api.post(`${CMS}/finance/credits/apply`).set('Authorization', w.operator.auth).send({
      tenantId: w.tenantId, invoiceId: inv.id, amount: 500,
    })).status).toBe(409);
  });
});

describe('finance phase 4 — refunds', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('refunds.reason-required: deductions or overrides without a reason are rejected', async () => {
    const w = await seedWorld();
    const noReason = { ...calc(), reason: undefined };
    expect((await api.post(`${CMS}/finance/refunds/calculate`).set('Authorization', w.operator.auth).send({
      monthlyRent: 200, daysInMonth: 30, unusedDays: 15, damageCharge: 10,
    })).status).toBe(400);
    expect((await api.post(`${CMS}/finance/refunds`).set('Authorization', w.operator.auth).send({ tenantId: w.tenantId, ...noReason })).status).toBe(201);
    expect((await api.post(`${CMS}/finance/refunds`).set('Authorization', w.operator.auth).send({ tenantId: w.tenantId, ...calc({ damageCharge: 10 }), reason: undefined })).status).toBe(400);
  });

  it('refunds.every-refund-two-step: even a small refund needs a distinct approver', async () => {
    const w = await seedWorld();
    // Requested by an approver so the self-approval reaches the service-level
    // maker-checker (the operator role has no approve permission at all).
    const req = await api.post(`${CMS}/finance/refunds`).set('Authorization', w.approverA.auth).send({ tenantId: w.tenantId, ...calc() });
    expect(req.status).toBe(201);
    const id = req.body.data.id as string;
    expect(req.body.data).toMatchObject({ status: 'REQUESTED', amount: 100 });
    // Same identity approves their own request → 403, regardless of amount.
    const self = await api.post(`${CMS}/finance/refunds/${id}/approve`).set('Authorization', w.approverA.auth).send({ version: req.body.data.version });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CHECKER');
    // A different approver clears the checker step.
    const ok = await api.post(`${CMS}/finance/refunds/${id}/approve`).set('Authorization', w.approverB.auth).send({ version: req.body.data.version });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'APPROVED', bypassed: false });
  });

  it('refunds.superadmin-bypass-audited: Owner single-steps, and the bypass is audited', async () => {
    const w = await seedWorld();
    const req = await api.post(`${CMS}/finance/refunds`).set('Authorization', w.owner.auth).send({ tenantId: w.tenantId, ...calc() });
    expect(req.status).toBe(201);
    const id = req.body.data.id as string;
    // Bypass without a reason → 400 (the audit needs actor + reason).
    expect((await api.post(`${CMS}/finance/refunds/${id}/approve`).set('Authorization', w.owner.auth).send({})).status).toBe(400);
    const ok = await api.post(`${CMS}/finance/refunds/${id}/approve`).set('Authorization', w.owner.auth).send({ version: req.body.data.version, reason: 'owner on-call approval' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'APPROVED', bypassed: true });
    const audit = await api.get(`${CMS}/finance/audit`).set('Authorization', w.owner.auth)
      .query({ entityType: 'refund', entityId: id });
    const actions = audit.body.data.map((e: { action: string }) => e.action);
    expect(actions).toContain('REFUND_BYPASS');
    const bypass = audit.body.data.find((e: { action: string }) => e.action === 'REFUND_BYPASS');
    expect(bypass.actor).toBe(w.owner.email);
    expect(String(bypass.after?.reason ?? bypass.reason ?? '')).toContain('on-call');
  });

  it('refund.negative-converts-to-charge: a negative computation becomes a DRAFT charge', async () => {
    const w = await seedWorld();
    const res = await api.post(`${CMS}/finance/refunds`).set('Authorization', w.operator.auth).send({ tenantId: w.tenantId, ...calc({
      earlyTerminationFee: 150,
      damageCharge: 100,
    })});
    expect(res.status).toBe(201);
    // 100 prorated − 250 deductions = −150 → charge, not a refund row.
    expect(res.body.data).toMatchObject({ status: 'DRAFT', amount: 150 });
    expect(res.body.data.lines[0]).toMatchObject({ kind: 'ADJUSTMENT' });
    const refunds = await api.get(`${CMS}/finance/refunds`).set('Authorization', w.operator.auth).query({ tenantId: w.tenantId });
    expect(refunds.body.data).toHaveLength(0);
    const events = await prisma.financeEvent.findMany({ where: { type: 'refund.converted.to.charge' } });
    expect(events).toHaveLength(1);
  });

  it('refunds.bank-verify-gate: PAID needs verification first; full lifecycle to PAID', async () => {
    const w = await seedWorld();
    const req = await api.post(`${CMS}/finance/refunds`).set('Authorization', w.operator.auth).send({ tenantId: w.tenantId, ...calc() });
    const id = req.body.data.id as string;
    await api.post(`${CMS}/finance/refunds/${id}/approve`).set('Authorization', w.approverA.auth).send({ version: req.body.data.version });
    const appr1 = (await api.get(`${CMS}/finance/refunds/${id}`).set('Authorization', w.approverA.auth)).body.data;
    const payBlocked = await api.post(`${CMS}/finance/refunds/${id}/pay`).set('Authorization', w.approverA.auth).send({ version: appr1.version });
    expect(payBlocked.status).toBe(409);
    expect(payBlocked.body.error.code).toBe('BLOCKED');
    expect((await api.post(`${CMS}/finance/refunds/${id}/bank-verify`).set('Authorization', w.operator.auth).send({})).status).toBe(400);
    const ver = await api.post(`${CMS}/finance/refunds/${id}/bank-verify`).set('Authorization', w.operator.auth).send({ bankRef: 'DBS ****1234 verified' });
    expect(ver.status).toBe(200);
    expect(ver.body.data).toMatchObject({ bankVerified: true });
    // The requestor cannot execute their own refund either.
    const appr2 = (await api.get(`${CMS}/finance/refunds/${id}`).set('Authorization', w.operator.auth)).body.data;
    expect((await api.post(`${CMS}/finance/refunds/${id}/pay`).set('Authorization', w.operator.auth).send({ version: appr2.version })).status).toBe(403);
    const appr3 = (await api.get(`${CMS}/finance/refunds/${id}`).set('Authorization', w.approverB.auth)).body.data;
    const paid = await api.post(`${CMS}/finance/refunds/${id}/pay`).set('Authorization', w.approverB.auth).send({ version: appr3.version, gatewayRef: 'stripe:re_fake_1' });
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({ status: 'PAID' });
  });

  it('refunds.reject: reason required; terminal after decision', async () => {
    const w = await seedWorld();
    const req = await api.post(`${CMS}/finance/refunds`).set('Authorization', w.operator.auth).send({ tenantId: w.tenantId, ...calc() });
    const id = req.body.data.id as string;
    expect((await api.post(`${CMS}/finance/refunds/${id}/reject`).set('Authorization', w.approverA.auth).send({ version: req.body.data.version })).status).toBe(400);
    const rej = await api.post(`${CMS}/finance/refunds/${id}/reject`).set('Authorization', w.approverA.auth).send({ version: req.body.data.version, reason: 'duplicate of credit note' });
    expect(rej.status).toBe(200);
    expect(rej.body.data).toMatchObject({ status: 'REJECTED' });
    const rejv = (await api.get(`${CMS}/finance/refunds/${id}`).set('Authorization', w.approverB.auth)).body.data;
    expect((await api.post(`${CMS}/finance/refunds/${id}/approve`).set('Authorization', w.approverB.auth).send({ version: rejv.version })).status).toBe(409);
  });
});

describe('finance phase 4 — arrears', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';

  async function overdueIssued(w: World, daysOverdue: number) {
    return issued(w.approverA.auth, w, {
      dueDate: daysAgo(daysOverdue),
      serviceStart: '2026-10-01T00:00:00Z',
      serviceEnd: '2026-10-31T00:00:00Z',
    });
  }

  it('arrears.workflow-gates: advances follow the overdue ladder, early steps block', async () => {
    const w = await seedWorld();
    const inv = await overdueIssued(w, 1);
    const c = await api.post(`${CMS}/finance/arrears`).set('Authorization', w.operator.auth).send({ tenantId: w.tenantId, invoiceId: inv.id });
    expect(c.status).toBe(201);
    const id = c.body.data.id as string;
    const r1 = await api.post(`${CMS}/finance/arrears/${id}/advance`).set('Authorization', w.operator.auth).send({ version: c.body.data.version });
    expect(r1.status).toBe(200);
    expect(r1.body.data).toMatchObject({ stage: 'REMINDER' });
    // 1 day overdue: formal notice (7d gate) blocks with the timing.
    const r2 = await api.post(`${CMS}/finance/arrears/${id}/advance`).set('Authorization', w.operator.auth).send({ version: r1.body.data.version });
    expect(r2.status).toBe(409);
    expect(r2.body.error.message).toContain('finance.lateFeeAfterDays');
  });

  it('arrears.late-fee: posting needs a configured amount (requireDecided), then posts a FEE line', async () => {
    const w = await seedWorld();
    const inv = await overdueIssued(w, 10);
    const c = await api.post(`${CMS}/finance/arrears`).set('Authorization', w.operator.auth).send({ tenantId: w.tenantId, invoiceId: inv.id });
    const id = c.body.data.id as string;
    let v = c.body.data.version as number;
    for (const want of ['REMINDER', 'FORMAL_NOTICE']) {
      const r = await api.post(`${CMS}/finance/arrears/${id}/advance`).set('Authorization', w.operator.auth).send({ version: v });
      expect(r.status).toBe(200);
      expect(r.body.data.stage).toBe(want);
      v = r.body.data.version as number;
    }
    // Late-fee amount is UNDECIDED → posting BLOCKED naming the decision.
    const blocked = await api.post(`${CMS}/finance/arrears/${id}/advance`).set('Authorization', w.operator.auth).send({ version: v });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('BLOCKED');
    expect(blocked.body.error.message).toContain('lateFee');
    // Configure the editable FacilityFee → the advance posts.
    await prisma.facilityFee.create({
      data: { kind: 'FEE', key: 'lateFee', scope: 'GLOBAL', amount: 25, amountKind: 'FLAT', active: true },
    });
    const posted = await api.post(`${CMS}/finance/arrears/${id}/advance`).set('Authorization', w.operator.auth).send({ version: v });
    expect(posted.status).toBe(200);
    expect(posted.body.data).toMatchObject({ stage: 'LATE_FEE_POSTED' });
    const detail = (await api.get(`${CMS}/finance/invoices/${inv.id}`).set('Authorization', w.operator.auth)).body.data;
    expect(detail.balanceDue).toBe(225);
    expect(detail.lines.map((l: { kind: string }) => l.kind)).toContain('FEE');
    // Restriction (14d gate) still blocks at 10 days overdue.
    const r = await api.post(`${CMS}/finance/arrears/${id}/advance`).set('Authorization', w.operator.auth).send({ version: posted.body.data.version });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('finance.accessRestrictAfterDays');
  });

  it('arrears.restriction-resolve: restriction flips the account state and clears on resolve', async () => {
    const w = await seedWorld();
    const inv = await overdueIssued(w, 20);
    const c = await api.post(`${CMS}/finance/arrears`).set('Authorization', w.operator.auth).send({ tenantId: w.tenantId, invoiceId: inv.id });
    const id = c.body.data.id as string;
    await prisma.facilityFee.create({
      data: { kind: 'FEE', key: 'lateFee', scope: 'GLOBAL', amount: 25, amountKind: 'FLAT', active: true },
    });
    let v = c.body.data.version as number;
    for (const want of ['REMINDER', 'FORMAL_NOTICE', 'LATE_FEE_POSTED', 'RESTRICTED']) {
      const r = await api.post(`${CMS}/finance/arrears/${id}/advance`).set('Authorization', w.operator.auth).send({ version: v });
      expect(r.status).toBe(200);
      expect(r.body.data.stage).toBe(want);
      v = r.body.data.version as number;
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: w.tenantId } });
    expect(tenant?.accessRestricted).toBe(true);
    const detail = (await api.get(`${CMS}/finance/arrears/${id}`).set('Authorization', w.operator.auth)).body.data;
    expect(detail).toMatchObject({ stage: 'RESTRICTED', accessRestricted: true });
    const closed = await api.post(`${CMS}/finance/arrears/${id}/close`).set('Authorization', w.operator.auth).send({ version: v, reason: 'payment' });
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ stage: 'RESOLVED' });
    const cleared = await prisma.tenant.findUnique({ where: { id: w.tenantId } });
    expect(cleared?.accessRestricted).toBe(false);
  });

  it('arrears.waive-late-fee: approver-gated; approval appends a CREDIT line', async () => {
    const w = await seedWorld();
    const inv = await overdueIssued(w, 10);
    await prisma.facilityFee.create({
      data: { kind: 'FEE', key: 'lateFee', scope: 'GLOBAL', amount: 25, amountKind: 'FLAT', active: true },
    });
    const req = await api.post(`${CMS}/finance/arrears/waivers`).set('Authorization', w.operator.auth).send({
      tenantId: w.tenantId,
      invoiceId: inv.id,
      amount: 25,
      reason: 'first offence goodwill',
    });
    expect(req.status).toBe(201);
    const id = req.body.data.id as string;
    // Requestor cannot approve their own waiver.
    expect((await api.post(`${CMS}/finance/arrears/waivers/${id}/decide`).set('Authorization', w.operator.auth).send({ approve: true, version: req.body.data.version })).status).toBe(403);
    const ok = await api.post(`${CMS}/finance/arrears/waivers/${id}/decide`).set('Authorization', w.approverA.auth).send({ approve: true, version: req.body.data.version });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'APPROVED' });
    const detail = (await api.get(`${CMS}/finance/invoices/${inv.id}`).set('Authorization', w.operator.auth)).body.data;
    expect(detail.balanceDue).toBe(175);
    expect(detail.creditApplied).toBe(25);
  });

  it('arrears.terminate-blocked: termination is an UNDECIDED stub, never built', async () => {
    const w = await seedWorld();
    const inv = await overdueIssued(w, 20);
    const c = await api.post(`${CMS}/finance/arrears`).set('Authorization', w.operator.auth).send({ tenantId: w.tenantId, invoiceId: inv.id });
    const res = await api.post(`${CMS}/finance/arrears/${c.body.data.id}/terminate`).set('Authorization', w.operator.auth).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Termination steps are undecided');
  });
});

describe('finance phase 4 — invoices write-off', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('invoices.write-off: reason required; terminal; cancels instructions', async () => {
    const w = await seedWorld();
    const inv = await issued(w.approverA.auth, w);
    expect((await api.post(`${CMS}/finance/invoices/${inv.id}/write-off`).set('Authorization', w.approverA.auth).send({})).status).toBe(400);
    const wo = await api.post(`${CMS}/finance/invoices/${inv.id}/write-off`).set('Authorization', w.approverA.auth).send({ version: inv.version, reason: 'uncollectible — tenant dissolved' });
    expect(wo.status).toBe(200);
    expect(wo.body.data).toMatchObject({ status: 'WRITTEN_OFF' });
    const reg = await api.get(`${CMS}/finance/transactions?invoiceId=${inv.id}`).set('Authorization', w.approverA.auth);
    expect(reg.body.data[0].status).toBe('CANCELLED');
    // Paid invoices cannot be written off.
    const paid = await prisma.invoice.create({
      data: {
        invoiceNo: `INV-E2E-4-${Date.now()}`, tenantId: w.tenantId, unitId: w.unitId, amount: 50,
        dueDate: new Date(), billedMonth: new Date(), status: 'PAID', paidAt: new Date(), amountPaid: 50,
      },
    });
    expect((await api.post(`${CMS}/finance/invoices/${paid.id}/write-off`).set('Authorization', w.approverA.auth).send({ version: 0, reason: 'x' })).status).toBe(409);
  });
});

describe('finance phase 4 — reconciliation', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('import.partial-match: remainder stays allocatable; second match closes the line', async () => {
    const w = await seedWorld();
    const a = await issued(w.approverA.auth, w);
    const b = await issued(w.approverA.auth, w, { serviceStart: '2026-11-01T00:00:00Z', serviceEnd: '2026-11-30T00:00:00Z' });
    const imp = await api.post(`${CMS}/finance/reconciliation/import`).set('Authorization', w.operator.auth).send({
      branchId: w.branchId,
      batchRef: 'e2e-batch-1',
      lines: [{ externalRef: 'STL-1', amount: 200 }],
    });
    expect(imp.status).toBe(201);
    expect(imp.body.data.rows[0]).toMatchObject({ status: 'UNMATCHED' });
    const lineId = imp.body.data.rows[0].id as string;
    const m1 = await api.post(`${CMS}/finance/reconciliation/${lineId}/match`).set('Authorization', w.operator.auth).send({ invoiceId: a.id, amount: 120 });
    expect(m1.status).toBe(200);
    expect(m1.body.data).toMatchObject({ status: 'PARTIAL', matchedAmount: 120 });
    const invA = (await api.get(`${CMS}/finance/invoices/${a.id}`).set('Authorization', w.operator.auth)).body.data;
    expect(invA).toMatchObject({ status: 'PARTIALLY_PAID', amountPaid: 120 });
    const m2 = await api.post(`${CMS}/finance/reconciliation/${lineId}/match`).set('Authorization', w.operator.auth).send({ invoiceId: b.id, amount: 80 });
    expect(m2.status).toBe(200);
    expect(m2.body.data).toMatchObject({ status: 'MATCHED', matchedAmount: 200 });
    // Idempotent re-import returns the same rows without new writes.
    const again = await api.post(`${CMS}/finance/reconciliation/import`).set('Authorization', w.operator.auth).send({
      branchId: w.branchId,
      batchRef: 'e2e-batch-1',
      lines: [{ externalRef: 'STL-1', amount: 200 }],
    });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ deduplicated: true, created: 0 });
    expect(await prisma.settlementImport.count()).toBe(1);
  });

  it('reconciliation.suspense-queue: unmatched work queues; suspense resolves by matching', async () => {
    const w = await seedWorld();
    const inv = await issued(w.approverA.auth, w);
    const imp = await api.post(`${CMS}/finance/reconciliation/import`).set('Authorization', w.operator.auth).send({
      branchId: w.branchId,
      batchRef: 'e2e-batch-2',
      lines: [
        { externalRef: 'STL-A', amount: 200 },
        { externalRef: 'STL-B', amount: 50 },
      ],
    });
    expect(imp.status).toBe(201);
    const [la, lb] = imp.body.data.rows as Array<{ id: string }>;
    expect((await api.post(`${CMS}/finance/reconciliation/${lb.id}/match`).set('Authorization', w.operator.auth).send({ version: 0 })).status).toBe(400);
    const sus = await api.post(`${CMS}/finance/reconciliation/${lb.id}/suspense`).set('Authorization', w.operator.auth).send({ reason: 'bank ref unclear' });
    expect(sus.status).toBe(200);
    expect(sus.body.data).toMatchObject({ status: 'SUSPENSE' });
    let sum = (await api.get(`${CMS}/finance/reconciliation`).set('Authorization', w.operator.auth).query({ branchId: w.branchId })).body.data;
    expect(sum).toMatchObject({ unmatchedCount: 1, suspenseCount: 1, settled: 250, allocated: 0 });
    // Suspense resolves by matching (the operator found the invoice).
    const m = await api.post(`${CMS}/finance/reconciliation/${lb.id}/match`).set('Authorization', w.operator.auth).send({ invoiceId: inv.id, amount: 50 });
    expect(m.status).toBe(200);
    expect(m.body.data).toMatchObject({ status: 'MATCHED', suspenseReason: null });
    sum = (await api.get(`${CMS}/finance/reconciliation`).set('Authorization', w.operator.auth).query({ branchId: w.branchId })).body.data;
    expect(sum).toMatchObject({ suspenseCount: 0, allocated: 50 });
  });

  it('reconciliation.close-checklist: cannot close while checks fail; Owner reopens', async () => {
    const w = await seedWorld();
    const inv = await issued(w.approverA.auth, w);
    await api.post(`${CMS}/finance/reconciliation/import`).set('Authorization', w.operator.auth).send({
      branchId: w.branchId,
      batchRef: 'e2e-batch-3',
      lines: [{ externalRef: 'STL-X', amount: 200 }],
    });
    const blocked = await api.post(`${CMS}/finance/reconciliation/close`).set('Authorization', w.approverA.auth).send({ branchId: w.branchId, fiscalMonth: '2026-10' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('BLOCKED');
    expect(blocked.body.error.details.checklist.find((c: { key: string }) => c.key === 'allocations').pass).toBe(false);
    const line = await prisma.settlementImport.findFirstOrThrow();
    await api.post(`${CMS}/finance/reconciliation/${line.id}/match`).set('Authorization', w.operator.auth).send({ invoiceId: inv.id });
    const closed = await api.post(`${CMS}/finance/reconciliation/close`).set('Authorization', w.approverA.auth).send({ branchId: w.branchId, fiscalMonth: '2026-10' });
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ status: 'CLOSED' });
    // Elevated approval: only the Owner reopens.
    expect((await api.post(`${CMS}/finance/reconciliation/reopen`).set('Authorization', w.approverA.auth).send({
      branchId: w.branchId, fiscalMonth: '2026-10', reason: 'correction',
    })).status).toBe(403);
    const reopened = await api.post(`${CMS}/finance/reconciliation/reopen`).set('Authorization', w.owner.auth).send({
      branchId: w.branchId, fiscalMonth: '2026-10', reason: 'late bank line arrived',
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({ status: 'OPEN' });
  });
});

describe('finance phase 4 — month close + performance', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('close.freezes-actuals: posted months reject writes with BLOCKED', async () => {
    const w = await seedWorld();
    // September invoice, approved/issued, then settled via an exact auto-match.
    const d = await draft(w.operator.auth, w, {
      dueDate: '2026-09-15T00:00:00Z',
      serviceStart: '2026-09-01T00:00:00Z',
      serviceEnd: '2026-09-30T00:00:00Z',
    });
    const appr = await api.post(`${CMS}/finance/invoices/${d.id}/approve`).set('Authorization', w.approverA.auth).send({ version: d.version });
    const iss = await api.post(`${CMS}/finance/invoices/${d.id}/issue`).set('Authorization', w.approverA.auth).send({ version: appr.body.data.version });
    const inv = iss.body.data as { id: string; version: number; no: string };
    const imp = await api.post(`${CMS}/finance/reconciliation/import`).set('Authorization', w.operator.auth).send({
      branchId: w.branchId,
      batchRef: 'e2e-close-1',
      lines: [{ externalRef: 'STL-C1', amount: 200, invoiceRef: inv.no, receivedAt: '2026-09-20T00:00:00Z' }],
    });
    expect(imp.body.data.rows[0]).toMatchObject({ status: 'MATCHED' });
    const rc = await api.post(`${CMS}/finance/reconciliation/close`).set('Authorization', w.approverA.auth).send({ branchId: w.branchId, fiscalMonth: CLOSE_MONTH });
    expect(rc.status).toBe(200);
    // Operators cannot close (approve-gated); approvers can.
    expect((await api.post(`${CMS}/finance/month-close`).set('Authorization', w.operator.auth).send({ branchId: w.branchId, fiscalMonth: CLOSE_MONTH })).status).toBe(403);
    const closed = await api.post(`${CMS}/finance/month-close`).set('Authorization', w.approverA.auth).send({ branchId: w.branchId, fiscalMonth: CLOSE_MONTH });
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ status: 'CLOSED' });
    expect(closed.body.data.actuals.find((a: { metric: string }) => a.metric === 'REVENUE')).toMatchObject({ value: 200 });
    // Posted months are immutable: budget, expense, invoice and void writes block.
    expect((await api.post(`${CMS}/finance/budgets`).set('Authorization', w.operator.auth).send({
      branchId: w.branchId, fiscalMonth: CLOSE_MONTH, category: 'Utilities', amount: 50,
    })).status).toBe(409);
    expect((await api.post(`${CMS}/finance/expenses`).set('Authorization', w.operator.auth).send({
      branchId: w.branchId, category: 'Utilities', amount: 50, incurredAt: '2026-09-10T00:00:00Z',
    })).status).toBe(409);
    expect((await api.post(`${CMS}/finance/invoices`).set('Authorization', w.operator.auth).send({
      tenantId: w.tenantId, dueDate: '2026-09-20T00:00:00Z',
      serviceStart: '2026-09-01T00:00:00Z', serviceEnd: '2026-09-30T00:00:00Z',
      lines: [{ kind: 'RENT', label: 'late bill', amount: 10 }],
    })).status).toBe(409);
    const invCur = (await api.get(`${CMS}/finance/invoices/${inv.id}`).set('Authorization', w.approverA.auth)).body.data;
    expect((await api.post(`${CMS}/finance/invoices/${inv.id}/void`).set('Authorization', w.approverA.auth).send({ version: invCur.version, reason: 'oops' })).status).toBe(409);
    // Closing twice conflicts.
    expect((await api.post(`${CMS}/finance/month-close`).set('Authorization', w.approverA.auth).send({ branchId: w.branchId, fiscalMonth: CLOSE_MONTH })).status).toBe(409);
  });

  it('close.adjustment-creates-new-event: corrections are new rows, never edits', async () => {
    const w = await seedWorld();
    const d = await draft(w.operator.auth, w, {
      dueDate: '2026-09-15T00:00:00Z',
      serviceStart: '2026-09-01T00:00:00Z',
      serviceEnd: '2026-09-30T00:00:00Z',
    });
    const appr = await api.post(`${CMS}/finance/invoices/${d.id}/approve`).set('Authorization', w.approverA.auth).send({ version: d.version });
    const iss = await api.post(`${CMS}/finance/invoices/${d.id}/issue`).set('Authorization', w.approverA.auth).send({ version: appr.body.data.version });
    const inv = iss.body.data as { id: string; no: string };
    await api.post(`${CMS}/finance/reconciliation/import`).set('Authorization', w.operator.auth).send({
      branchId: w.branchId,
      batchRef: 'e2e-close-2',
      lines: [{ externalRef: 'STL-C2', amount: 200, invoiceRef: inv.no, receivedAt: '2026-09-20T00:00:00Z' }],
    });
    await api.post(`${CMS}/finance/reconciliation/close`).set('Authorization', w.approverA.auth).send({ branchId: w.branchId, fiscalMonth: CLOSE_MONTH });
    await api.post(`${CMS}/finance/month-close`).set('Authorization', w.approverA.auth).send({ branchId: w.branchId, fiscalMonth: CLOSE_MONTH });
    expect((await api.post(`${CMS}/finance/month-close/adjust`).set('Authorization', w.approverA.auth).send({
      branchId: w.branchId, fiscalMonth: CLOSE_MONTH, metric: 'REVENUE', amount: -20, reason: 'credit note posted late',
    })).status).toBe(201);
    const posted = await prisma.actualMetric.findFirstOrThrow({ where: { branchId: w.branchId, fiscalMonth: CLOSE_MONTH, metric: 'REVENUE' } });
    expect(toNum(posted.value)).toBe(200);
    expect(await prisma.monthCloseAdjustment.count()).toBe(1);
    const events = await prisma.financeEvent.findMany({ where: { type: 'close.adjustment.posted' } });
    expect(events).toHaveLength(1);
    const perf = (await api.get(`${CMS}/finance/performance`).set('Authorization', w.operator.auth).query({ branchId: w.branchId, fiscalMonth: CLOSE_MONTH })).body.data;
    expect(perf.closed).toBe(true);
    expect(perf.rows.find((r: { metric: string }) => r.metric === 'REVENUE')).toMatchObject({ actual: 180 });
  });

  it('performance.future-em-dash: unposted months carry nulls, never fabricated zeros', async () => {
    const w = await seedWorld();
    const perf = (await api.get(`${CMS}/finance/performance`).set('Authorization', w.operator.auth).query({ branchId: w.branchId, fiscalMonth: '2027-06' })).body.data;
    expect(perf.closed).toBe(false);
    for (const row of perf.rows) {
      expect(row.actual).toBeNull();
    }
    const noted = await api.post(`${CMS}/finance/performance/notes`).set('Authorization', w.operator.auth).send({
      branchId: w.branchId, fiscalMonth: '2027-06', metric: 'REVENUE', note: 'watching ramp',
    });
    expect(noted.status).toBe(201);
    const again = (await api.get(`${CMS}/finance/performance`).set('Authorization', w.operator.auth).query({ branchId: w.branchId, fiscalMonth: '2027-06' })).body.data;
    expect(again.notes).toHaveLength(1);
  });
});

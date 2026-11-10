// Lease-horizon P4 API tests — persistence + permissions + audit (no existing
// test file is modified; this file is new).
//
// Covers LH04/LH05/LH06/LH07 (validation gates), LH15 (concurrent CAS),
// LH16 (draft isolation), LH17 (valuation failure → FAILED/stale/export
// disabled/retry), idempotent replay (same key → first result, single audit),
// stale-result discard (version-scoped writes), closed write paths, the
// MonthClose shorten block, 422 details shape, §10 audit content and the D9B
// permission matrix. cms-rbac green is asserted by the untouched suite.
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';

const CMS = '/api/v1/cms';

function sched(years: number, rent = 5000, source = 'contract', confirmed = true) {
  return Array.from({ length: years }, (_, i) => ({ leaseYear: i + 1, monthlyRent: rent, source, confirmed }));
}

function leaseBody(version: number, overrides: Record<string, unknown> = {}) {
  return {
    version,
    leaseStartDate: '2026-12-01',
    committedTermMonths: 60,
    prorationMethod: 'actual_days',
    currency: 'SGD',
    ufaSqft: 3068,
    schedule: sched(5),
    ...overrides,
  };
}

async function makeBranch() {
  return prisma.branch.create({
    data: { code: `LH${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: 'Lease Horizon E2E', address: 'Admirax', operatingHours: '9-9' },
  });
}

async function makeModel(auth: string, branchId?: string) {
  const res = await api.post(`${CMS}/finance/models`).set('Authorization', auth).send({ name: 'LH Model', ...(branchId ? { branchId } : {}) });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; version: number };
}

async function enableRollout(auth: string, rollout = 'all', returns = 'on') {
  const res = await api.put(`${CMS}/settings`).set('Authorization', auth).send({
    'finance.leaseHorizon.rollout': rollout,
    'finance.leaseHorizon.returns': returns,
  });
  expect(res.status).toBe(200);
}

async function ownerWorld(rollout = 'all', returns = 'on') {
  const owner = await createOperator('OWNER');
  await enableRollout(owner.auth, rollout, returns);
  const branch = await makeBranch();
  const model = await makeModel(owner.auth, branch.id);
  return { owner, branch, model };
}

describe('lease-horizon P4: landlord-lease read + update', () => {
  beforeEach(resetDb);

  it('GET returns the full editable section with server-derived dates', async () => {
    const { owner, branch, model } = await ownerWorld();
    const res = await api.get(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth);
    expect(res.status).toBe(200);
    const s = res.body.data;
    expect(s).toMatchObject({
      modelId: model.id,
      facilityId: branch.id,
      leaseStartDate: '2026-12-01',
      committedTermMonths: 60,
      committedEndDate: '2031-11-30',
      prorationMethod: 'actual_days',
      currency: 'SGD',
      rowVersion: 0,
      calculationStatus: 'CURRENT',
    });
    expect(s.leaseSchedule).toHaveLength(5);
    // D7A: new models default to a 15% manual rate, recorded on the section.
    expect(s.valuation.methodology).toBe('manual');
    expect(s.valuation.manualAnnualRate).toBe(0.15);
    expect(s.valuation.effectiveAnnualRate).toBe(0.15);
    // D8A: renewal + terminal off by default, no sale value anywhere.
    expect(s.valuation.renewalEnabled).toBe(false);
    expect(s.valuation.includeTerminalCashFlows).toBe(false);
    expect('saleValue' in s.valuation).toBe(false);
  });

  it('PUT updates the term end-to-end (projection + valuation + audit + event)', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { committedTermMonths: 48, schedule: sched(4) }));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.fork).toBeNull();
    expect(d.replayed).toBe(false);
    expect(d.model.version).toBe(1);
    expect(d.model.calculationStatus).toBe('CURRENT');
    expect(d.lease.committedTermMonths).toBe(48);
    expect(d.lease.committedEndDate).toBe('2030-11-30');
    expect(d.calculation.status).toBe('CURRENT');
    expect(d.warning).toBeNull();
    expect(d.message).toMatch(/48 months/);

    const audits = await prisma.financeAuditEvent.findMany({
      where: { action: 'MODEL_LEASE_HORIZON_UPDATED', entityId: model.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: owner.email, source: 'cms' });
    const after = audits[0].after as Record<string, unknown>;
    expect(after).toMatchObject({
      section: 'landlord-lease',
      oldCommittedTermMonths: 60,
      newCommittedTermMonths: 48,
      oldCommittedEndDate: '2031-11-30',
      newCommittedEndDate: '2030-11-30',
      legacyRentFreeMonths: 0,
      calculationStatus: 'PENDING',
    });

    const events = await prisma.financeEvent.findMany({ where: { type: 'financial_model.lease_horizon.updated' } });
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>)).toMatchObject({
      modelId: model.id,
      modelVersion: 1,
      oldCommittedTermMonths: 60,
      newCommittedTermMonths: 48,
    });
  });

  it('LH04/LH05: 11 and 121 months are rejected with the range copy + field details', async () => {
    const { owner, model } = await ownerWorld();
    for (const term of [11, 121]) {
      const res = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
        .send(leaseBody(0, { committedTermMonths: term, schedule: sched(1) }));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.message).toMatch(/between 12 and 120 months/);
      expect(res.body.error.details.fieldErrors.committedTermMonths).toHaveLength(1);
    }
  });

  it('LH06: 36.5 months is rejected as a non-integer', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { committedTermMonths: 36.5, schedule: sched(4) }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.message).toMatch(/whole number/);
    expect(res.body.error.details.field).toBe('committedTermMonths');
  });

  it('LH07: extending without rents blocks on Estimated rows until confirmed', async () => {
    const { owner, model } = await ownerWorld();
    const shrink = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { committedTermMonths: 36, schedule: sched(3) }));
    expect(shrink.status).toBe(200);

    const blocked = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(1, { committedTermMonths: 60, schedule: sched(3) }));
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toMatch(/estimated lease-year amounts/);
    expect(blocked.body.error.details.code).toBe('LEASE_SCHEDULE_UNCONFIRMED');
    expect(blocked.body.error.details.leaseYear).toBe(4);
    expect(blocked.body.error.details.schedule).toHaveLength(5);

    const confirmed = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(1, {
        committedTermMonths: 60,
        schedule: [...sched(3), { leaseYear: 4, monthlyRent: 5000, source: 'estimated', confirmed: true }, { leaseYear: 5, monthlyRent: 5000, source: 'estimated', confirmed: true }],
      }));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.lease.committedTermMonths).toBe(60);
  });

  it('LH15: concurrent same-version writes → 409 with the handoff conflict copy', async () => {
    const { owner, model } = await ownerWorld();
    const first = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { committedTermMonths: 48, schedule: sched(4) }));
    expect(first.status).toBe(200);
    const second = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { committedTermMonths: 36, schedule: sched(3) }));
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/changed by another user.*Reload the latest version/);
    expect(second.body.error.details).toMatchObject({ entity: 'FinancialModel', expected: 0, current: 1 });
    // No silent overwrite: the first revision stands.
    const current = await api.get(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth);
    expect(current.body.data.committedTermMonths).toBe(48);
  });

  it('LH16: draft isolation — another model horizon never leaks', async () => {
    const { owner, branch } = await ownerWorld();
    const a = await makeModel(owner.auth, branch.id);
    const b = await makeModel(owner.auth, branch.id);
    const upd = await api.put(`${CMS}/finance/models/${a.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { committedTermMonths: 36, schedule: sched(3) }));
    expect(upd.status).toBe(200);
    const kept = await api.get(`${CMS}/finance/models/${b.id}/landlord-lease`).set('Authorization', owner.auth);
    expect(kept.body.data.committedTermMonths).toBe(60);
    expect(kept.body.data.committedEndDate).toBe('2031-11-30');
    // And the edited model reads its own horizon back.
    const own = await api.get(`${CMS}/finance/models/${a.id}/landlord-lease`).set('Authorization', owner.auth);
    expect(own.body.data.committedTermMonths).toBe(36);
  });

  it('a startDate change re-derives the end date and schedule', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { leaseStartDate: '2026-12-15', committedTermMonths: 12, schedule: sched(1) }));
    expect(res.status).toBe(200);
    expect(res.body.data.lease.leaseStartDate).toBe('2026-12-15');
    expect(res.body.data.lease.committedEndDate).toBe('2027-12-14');
    expect(res.body.data.lease.leaseSchedule[0]).toMatchObject({ periodStart: '2026-12-15', periodEnd: '2027-12-14' });
  });

  it('shortening before the latest MonthClose is BLOCKED with the rebase message', async () => {
    const { owner, branch, model } = await ownerWorld();
    await prisma.monthClose.create({ data: { branchId: branch.id, fiscalMonth: '2028-06', status: 'CLOSED' } });
    const res = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { committedTermMonths: 12, schedule: sched(1) }));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Rebase/);

    // A close that predates the new end does not block.
    await prisma.monthClose.deleteMany({ where: { branchId: branch.id } });
    await prisma.monthClose.create({ data: { branchId: branch.id, fiscalMonth: '2026-12', status: 'CLOSED' } });
    const okRes = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { committedTermMonths: 12, schedule: sched(1) }));
    expect(okRes.status).toBe(200);
  });

  it('idempotent replay: same key returns the first result with a single audit event', async () => {
    const { owner, model } = await ownerWorld();
    const body = leaseBody(0, { committedTermMonths: 48, schedule: sched(4) });
    const first = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .set('Idempotency-Key', 'lh-replay-1').send(body);
    expect(first.status).toBe(200);
    expect(first.body.data.replayed).toBe(false);
    const second = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .set('Idempotency-Key', 'lh-replay-1').send(body);
    expect(second.status).toBe(200);
    expect(second.body.data.replayed).toBe(true);
    expect(second.body.data.calculation.id).toBe(first.body.data.calculation.id);
    expect(second.body.data.model.version).toBe(1);

    expect(await prisma.financialModelCalculation.count({ where: { modelId: model.id } })).toBe(1);
    expect(await prisma.financeAuditEvent.count({ where: { action: 'MODEL_LEASE_HORIZON_UPDATED', entityId: model.id } })).toBe(1);
  });

  it('stale results are version-scoped; returns stay keyed to the current revision', async () => {
    const { owner, model } = await ownerWorld();
    // A stranded row for a non-current version is never touched or read.
    await prisma.financialModelCalculation.create({
      data: { modelId: model.id, modelVersion: 999, engineVersion: 'finance-projection/2', inputHash: 'x', actor: 'test' },
    });
    const upd = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { committedTermMonths: 48, schedule: sched(4) }));
    expect(upd.status).toBe(200);
    const stranded = await prisma.financialModelCalculation.findUnique({
      where: { modelId_modelVersion: { modelId: model.id, modelVersion: 999 } },
    });
    expect(stranded?.status).toBe('PENDING');

    const returns = await api.get(`${CMS}/finance/returns?modelId=${model.id}`).set('Authorization', owner.auth);
    expect(returns.status).toBe(200);
    expect(returns.body.data.committed.modelVersion).toBe(1);
    expect(returns.body.data.committed.committedMonths).toBe(48);
  });

  it('closed write paths: inputs rejects horizonMonths, opex rejects lease', async () => {
    const { owner, model } = await ownerWorld();
    const via1 = await api.put(`${CMS}/finance/models/${model.id}/inputs`).set('Authorization', owner.auth)
      .send({ version: 0, patch: { horizonMonths: 36 } });
    expect(via1.status).toBe(422);
    expect(via1.body.error.message).toMatch(/landlord-lease/);
    const via2 = await api.put(`${CMS}/finance/models/${model.id}/opex`).set('Authorization', owner.auth)
      .send({ version: 0, patch: { lease: { monthlyByYear: [1] } } });
    expect(via2.status).toBe(422);
    expect(via2.body.error.message).toMatch(/landlord-lease/);
  });

  it('D4A: editing a CURRENT model forks an identifiable child draft, never mutating the approved version', async () => {
    const owner = await createOperator('OWNER');
    await enableRollout(owner.auth);
    const model = await makeModel(owner.auth);
    expect((await api.post(`${CMS}/finance/library/${model.id}/submit`).set('Authorization', owner.auth).send({ version: 0 })).status).toBe(200);
    expect((await api.post(`${CMS}/finance/library/${model.id}/approve`).set('Authorization', owner.auth).send({ version: 1 })).status).toBe(200);

    const upd = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(2, { committedTermMonths: 48, schedule: sched(4) }));
    expect(upd.status).toBe(200);
    expect(upd.body.data.fork).toMatchObject({ basedOnVersion: 2, basedOnStatus: 'CURRENT' });
    expect(upd.body.data.fork.message).toMatch(/approved version 2/);

    const original = await api.get(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth);
    expect(original.body.data.committedTermMonths).toBe(60);
    expect(original.body.data.rowVersion).toBe(2);
    const draft = await api.get(`${CMS}/finance/models/${upd.body.data.fork.id}/landlord-lease`).set('Authorization', owner.auth);
    expect(draft.body.data.committedTermMonths).toBe(48);

    // Valuation edits on the approved model stay locked — fork through the lease first.
    const locked = await api.put(`${CMS}/finance/models/${model.id}/valuation`).set('Authorization', owner.auth)
      .send({ version: 2, methodology: 'manual', manualAnnualRate: 0.1, renewalEnabled: false, includeTerminalCashFlows: false });
    expect(locked.status).toBe(403);
  });
});

describe('lease-horizon P4: valuation section + recalculate', () => {
  beforeEach(resetDb);

  it('valuation PUT stores the full D8A shape and never overwrites a stored rate', async () => {
    const { owner, model } = await ownerWorld();
    const put = await api.put(`${CMS}/finance/models/${model.id}/valuation`).set('Authorization', owner.auth)
      .send({ version: 0, methodology: 'manual', manualAnnualRate: 0.08, renewalEnabled: true, renewalMonths: 12, includeTerminalCashFlows: true, refundableDeposit: 15000, reinstatementCost: 5000, otherTerminalCashFlow: -100 });
    expect(put.status).toBe(200);
    expect(put.body.data.model.calculationStatus).toBe('CURRENT');
    const got = await api.get(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth);
    expect(got.body.data.valuation).toMatchObject({ methodology: 'manual', manualAnnualRate: 0.08, effectiveAnnualRate: 0.08, renewalEnabled: true, renewalMonths: 12, refundableDeposit: 15000 });

    // A later lease edit keeps the stored 8% — it is never reset to 15%.
    const upd = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(1, { committedTermMonths: 48, schedule: sched(4) }));
    expect(upd.status).toBe(200);
    expect(upd.body.data.lease.valuation.manualAnnualRate).toBe(0.08);
  });

  it('LH17: forced valuation failure → FAILED revision, stale labels, export disabled, retry succeeds', async () => {
    const { owner, branch, model } = await ownerWorld();
    // Save a WACC methodology without its financing inputs: the save succeeds,
    // the compute step fails with the named error.
    const wacc = await api.put(`${CMS}/finance/models/${model.id}/valuation`).set('Authorization', owner.auth)
      .send({ version: 0, methodology: 'wacc', renewalEnabled: false, includeTerminalCashFlows: false });
    expect(wacc.status).toBe(200);
    expect(wacc.body.data.calculation.status).toBe('FAILED');
    expect(wacc.body.data.warning).toMatch(/could not be recalculated/);

    const stored = await api.get(`${CMS}/finance/models/${model.id}`).set('Authorization', owner.auth);
    expect(stored.body.data.calculationStatus).toBe('FAILED');

    const stale = await api.get(`${CMS}/finance/returns?modelId=${model.id}`).set('Authorization', owner.auth);
    expect(stale.status).toBe(200);
    expect(stale.body.data.committed.valuationError).toMatch(/WACC/);

    const blocked = await api.get(`${CMS}/finance/models/${model.id}/export.csv`).set('Authorization', owner.auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/out of date/);

    // Retry while still broken keeps failing; completing the inputs then
    // re-saving (the retry path) succeeds and re-enables exports.
    const retryFail = await api.post(`${CMS}/finance/models/${model.id}/recalculate`).set('Authorization', owner.auth).send({});
    expect(retryFail.status).toBe(422);
    const fixed = await api.put(`${CMS}/finance/models/${model.id}/valuation`).set('Authorization', owner.auth)
      .send({ version: 1, methodology: 'manual', manualAnnualRate: 0.15, renewalEnabled: false, includeTerminalCashFlows: false });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.calculation.status).toBe('CURRENT');
    const retryOk = await api.post(`${CMS}/finance/models/${model.id}/recalculate`).set('Authorization', owner.auth).send({});
    expect(retryOk.status).toBe(200);
    expect(retryOk.body.data.recalculated).toBe(false);
    expect((await api.get(`${CMS}/finance/models/${model.id}/export.csv`).set('Authorization', owner.auth)).status).toBe(200);
    expect(branch.id).toBeTruthy();
  });
});

describe('lease-horizon P4: returns committed block + rollout + permissions', () => {
  beforeEach(resetDb);

  it('committed block is keyed by model version at the stored rate; slices stay supplementary', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.get(`${CMS}/finance/returns?modelId=${model.id}&horizonYears=5`).set('Authorization', owner.auth);
    expect(res.status).toBe(200);
    const r = res.body.data;
    expect(r.npv.label).toBe('NPV through Year 5');
    expect(r.npv.discountRatePct).toBe(8);
    expect(r.committed).toMatchObject({ modelVersion: 0, annualRate: 0.15, annualRateSource: 'manual' });
    expect(r.committed.npv).toBeDefined();
    expect(r.committed.irr.display).toBeDefined();
    expect(r.committed.dcf.length).toBeGreaterThan(0);
    expect(r.committed.limitation).toMatch(/R11/);
  });

  it('rollout off blocks the write path and keeps legacy pass-through; admins mode limits to Owners', async () => {
    const owner = await createOperator('OWNER');
    const manager = await createOperator('MANAGER');
    const branch = await makeBranch();
    const model = await makeModel(owner.auth, branch.id);

    const blocked = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/not enabled/);
    // Legacy pass-through preserved while the rollout is off.
    const legacy = await api.put(`${CMS}/finance/models/${model.id}/inputs`).set('Authorization', owner.auth)
      .send({ version: 0, patch: { horizonMonths: 36 } });
    expect(legacy.status).toBe(200);
    // Returns stay legacy-shaped while finance.leaseHorizon.returns is off.
    const noCommitted = await api.get(`${CMS}/finance/returns?modelId=${model.id}`).set('Authorization', owner.auth);
    expect(noCommitted.body.data.committed).toBeUndefined();

    await enableRollout(owner.auth, 'admins');
    expect((await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', manager.auth).send(leaseBody(1))).status).toBe(403);
    expect((await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth).send(leaseBody(1))).status).toBe(200);
  });

  it('D9B matrix: Manager edits, Operator views only, Viewer hidden-but-grantable', async () => {
    const { owner } = await ownerWorld();
    const manager = await createOperator('MANAGER');
    const operator = await createOperator('FINANCE_OPERATOR');
    const viewer = await createOperator('VIEWER');
    const approver = await createOperator('FINANCE_APPROVER');
    const model = await makeModel(owner.auth);

    // Operator: no lease edits, view only if granted (granted by default).
    expect((await api.get(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', operator.auth)).status).toBe(200);
    expect((await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', operator.auth).send(leaseBody(0))).status).toBe(403);

    // Viewer: hidden by default.
    expect((await api.get(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', viewer.auth)).status).toBe(403);
    // ...grantable through User Management.
    const roles = (await api.get(`${CMS}/roles`).set('Authorization', owner.auth)).body.data as Array<{ id: string; key: string }>;
    const viewerRole = roles.find((r) => r.key === 'VIEWER')!;
    expect((await api.patch(`${CMS}/roles/${viewerRole.id}`).set('Authorization', owner.auth).send({ permissions: ['bill-lease:view'] })).status).toBe(200);
    expect((await api.get(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', viewer.auth)).status).toBe(200);
    expect((await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', viewer.auth).send(leaseBody(0))).status).toBe(403);

    // Manager: view/edit/update/retry by default.
    expect((await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', manager.auth).send(leaseBody(0))).status).toBe(200);
    // ...approval only if explicitly granted.
    expect((await api.post(`${CMS}/finance/library/${model.id}/approve`).set('Authorization', manager.auth).send({ version: 1 })).status).toBe(403);
    // Approver holds the full lease path.
    expect((await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', approver.auth).send(leaseBody(1))).status).toBe(200);
  });
});

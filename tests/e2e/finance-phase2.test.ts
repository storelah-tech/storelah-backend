// Finance Phase 2 — Planning workspace (§§11–16) API + governance tests.
//
// Covers: model CRUD + four staged sections + optimistic-lock 409, staged
// isolation (invalid update preserves committed), scenario overlay isolation,
// sensitivity tornado, returns (standard / N/A patterns / payback-never +
// NPV disclosure), budgets (protected lease line, scopes), expenses,
// pricing overlay (live wins, audit, never writes Unit rows), library
// governance (save/duplicate/submit/approve/reject/restore/archive/
// set-current + audit + inventory-mapping gate), audited exports, and RBAC
// on every new route family.

import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';

const CMS = '/api/v1/cms';

async function seedPricingWorld() {
  const locker = await prisma.unitSize.create({
    data: { code: 'LOCKER', name: 'Locker', sqftFrom: 5, sqftTo: 25, sortOrder: 1 },
  });
  const small = await prisma.unitSize.create({
    data: { code: 'SMALL', name: 'Small', sqftFrom: 26, sqftTo: 60, sortOrder: 2 },
  });
  // Full taxonomy present (no units) so the inventory-mapping gate passes;
  // live NLA/unit counts still come only from the two units below.
  for (const [code, name, from, to, sort] of [
    ['MEDIUM', 'Medium', 61, 110, 3],
    ['LARGE', 'Large', 111, 180, 4],
    ['XL', 'XL', 181, 320, 5],
  ] as const) {
    await prisma.unitSize.create({ data: { code, name, sqftFrom: from, sqftTo: to, sortOrder: sort } });
  }
  const branch = await prisma.branch.create({
    data: { code: 'F2', name: 'Finance 2', address: '1 Finance Rd', operatingHours: '9-9' },
  });
  const floor = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'L1' } });
  await prisma.unit.create({
    data: { branchId: branch.id, floorId: floor.id, sizeId: locker.id, unitCode: 'F2-01-01', sqft: 20, monthlyRate: 136, status: 'AVAILABLE' },
  });
  await prisma.unit.create({
    data: { branchId: branch.id, floorId: floor.id, sizeId: small.id, unitCode: 'F2-01-02', sqft: 50, monthlyRate: 310, status: 'OCCUPIED' },
  });
  return { branch, locker, small };
}

async function createModel(auth: string, body: Record<string, unknown> = {}) {
  const res = await api.post(`${CMS}/finance/models`).set('Authorization', auth).send({ name: 'E2E Model', ...body });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('finance models CRUD + staged sections', () => {
  beforeEach(resetDb);

  it('creates a model with a live projection + calculation checks', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await createModel(op.auth);
    expect(m.projection.months).toHaveLength(60);
    expect(m.checks.netMoveIn.pass).toBe(true);
    expect(m.checks.leaseCountedOnce.pass).toBe(true);
    expect(m.checks.sizeMixReconciles.pass).toBe(true);
    expect(m.version).toBe(0);

    const fetched = await api.get(`${CMS}/finance/models/${m.id}`).set('Authorization', op.auth);
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.projection.kpis.weightedStartPsf).toBeCloseTo(5.6384, 4);
  });

  it('commits each of the four sections independently with optimistic-lock versions', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await createModel(op.auth);
    const r1 = await api.put(`${CMS}/finance/models/${m.id}/inputs`).set('Authorization', op.auth).send({ version: 0, patch: { horizonMonths: 36 } });
    expect(r1.status).toBe(200);
    expect(r1.body.data.version).toBe(1);
    expect(r1.body.data.projection.months).toHaveLength(36);

    const r2 = await api.put(`${CMS}/finance/models/${m.id}/assumptions`).set('Authorization', op.auth).send({ version: 1, patch: { occupancy: { rampFirst6: 200, rampFrom7: 140, moveOutRatePct: 2.5, churnStartMonth: 7, targetPct: 90 } } });
    expect(r2.status).toBe(200);
    expect(r2.body.data.inputs.occupancy.rampFirst6).toBe(200);

    const r3 = await api.put(`${CMS}/finance/models/${m.id}/size-mix`).set('Authorization', op.auth).send({
      version: 2,
      patch: {
        sizeMix: [
          { name: 'LOCKER', nlaSqft: 455, units: 0, psf: 6.8 },
          { name: 'SMALL', nlaSqft: 500, units: 0, psf: 6.2 },
          { name: 'MEDIUM', nlaSqft: 650, units: 0, psf: 5.5 },
          { name: 'LARGE', nlaSqft: 405, units: 0, psf: 4.8 },
          { name: 'XL', nlaSqft: 264, units: 0, psf: 4.2 },
        ],
      },
    });
    expect(r3.status).toBe(200);

    const r4 = await api.put(`${CMS}/finance/models/${m.id}/opex`).set('Authorization', op.auth).send({ version: 3, patch: { opex: { baseMonthly: 1500, annualGrowthPct: 2 } } });
    expect(r4.status).toBe(200);
    expect(r4.body.data.inputs.opex.baseMonthly).toBe(1500);

    // Unknown section fields are rejected, not silently stored.
    const bad = await api.put(`${CMS}/finance/models/${m.id}/inputs`).set('Authorization', op.auth).send({ version: 4, patch: { lease: { monthlyByYear: [1] } } });
    expect(bad.status).toBe(400);
  });

  it('models.concurrent-update-409: stale versions conflict, fresh versions pass', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await createModel(op.auth);
    const stale = await api.put(`${CMS}/finance/models/${m.id}/inputs`).set('Authorization', op.auth).send({ version: 7, patch: { horizonMonths: 24 } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE');
    const fresh = await api.put(`${CMS}/finance/models/${m.id}/inputs`).set('Authorization', op.auth).send({ version: 0, patch: { horizonMonths: 24 } });
    expect(fresh.status).toBe(200);
  });

  it('failed update preserves the last committed result (no partial write)', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await createModel(op.auth);
    const before = await api.get(`${CMS}/finance/models/${m.id}`).set('Authorization', op.auth);
    // Negative capital fails engine validation — committed inputs untouched.
    const bad = await api.put(`${CMS}/finance/models/${m.id}/opex`).set('Authorization', op.auth).send({ version: 0, patch: { capitalTotal: -5 } });
    expect(bad.status).toBe(400);
    const after = await api.get(`${CMS}/finance/models/${m.id}`).set('Authorization', op.auth);
    expect(after.body.data.inputs).toEqual(before.body.data.inputs);
    expect(after.body.data.version).toBe(0);
  });

  it('deletes DRAFT models only — CURRENT is locked (delete is Owner-only)', async () => {
    const owner = await createOperator('OWNER');
    const op = await createOperator('FINANCE_OPERATOR');
    const approver = await createOperator('FINANCE_APPROVER');
    const m = await createModel(op.auth);
    // Least privilege: operators archive drafts; only the Owner deletes.
    expect((await api.delete(`${CMS}/finance/models/${m.id}`).set('Authorization', op.auth)).status).toBe(403);
    expect((await api.delete(`${CMS}/finance/models/${m.id}`).set('Authorization', owner.auth)).status).toBe(200);
    expect((await api.get(`${CMS}/finance/models/${m.id}`).set('Authorization', op.auth)).status).toBe(404);

    const m2 = await createModel(op.auth, { name: 'Baseline' });
    await api.post(`${CMS}/finance/library/${m2.id}/submit`).set('Authorization', op.auth).send({ version: 0 });
    await api.post(`${CMS}/finance/library/${m2.id}/approve`).set('Authorization', approver.auth).send({ version: 1 });
    const del = await api.delete(`${CMS}/finance/models/${m2.id}`).set('Authorization', owner.auth);
    expect(del.status).toBe(403); // CURRENT is never deletable, even by the Owner
  });

  it('viewer cannot read models; operator cannot approve (maker-checker)', async () => {
    const viewer = await createOperator('VIEWER');
    const op = await createOperator('FINANCE_OPERATOR');
    expect((await api.get(`${CMS}/finance/models`).set('Authorization', viewer.auth)).status).toBe(403);
    const m = await createModel(op.auth);
    await api.post(`${CMS}/finance/library/${m.id}/submit`).set('Authorization', op.auth).send({ version: 0 });
    expect((await api.post(`${CMS}/finance/library/${m.id}/approve`).set('Authorization', op.auth).send({ version: 1 })).status).toBe(403);
  });
});

describe('scenarios + sensitivity (no fork)', () => {
  beforeEach(resetDb);

  it('models.scenario-overlay-no-fork: overlay previews without mutating the base', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await createModel(op.auth);
    const res = await api.post(`${CMS}/finance/models/${m.id}/scenarios`).set('Authorization', op.auth).send({ scenario: 'downside' });
    expect(res.status).toBe(200);
    expect(res.body.data.scenario).toBe('downside');
    expect(res.body.data.kpis).toBeDefined();
    const after = await api.get(`${CMS}/finance/models/${m.id}`).set('Authorization', op.auth);
    expect(after.body.data.inputs.occupancy.rampFirst6).toBe(180); // base untouched
    expect(after.body.data.version).toBe(0); // no version written
  });

  it('models.sensitivity-tornado: lower / base / stronger cases', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await createModel(op.auth);
    const res = await api.post(`${CMS}/finance/models/${m.id}/sensitivity`).set('Authorization', op.auth).send({});
    expect(res.status).toBe(200);
    const cases = res.body.data.cases;
    expect(cases.map((c: { name: string }) => c.name)).toEqual(['lower', 'base', 'stronger']);
    const base = cases.find((c: { name: string }) => c.name === 'base');
    expect(base.targetPct).toBe(92);
    expect(base.psfDelta).toBe(0);
    const lower = cases.find((c: { name: string }) => c.name === 'lower');
    expect(lower.year1Noi).toBeLessThan(base.year1Noi);
  });
});

describe('investment returns (read-only)', () => {
  beforeEach(resetDb);

  it('returns.irr-standard: payback + IRR + NPV over the selected horizon', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await createModel(op.auth);
    const res = await api.get(`${CMS}/finance/returns?modelId=${m.id}&horizonYears=5`).set('Authorization', op.auth);
    expect(res.status).toBe(200);
    const r = res.body.data;
    expect(r.source.modelId).toBe(m.id);
    expect(r.paybackMonth).toBe(32);
    expect(r.irrAnnualised).toBeCloseTo(0.39492, 3);
    expect(r.npv.value).toBeDefined();
    expect(r.npv.discountRatePct).toBe(8);
    expect(r.npv.basis).toMatch(/Illustrative/);
    expect(r.leaseTerm.assumption).toMatch(/no terminal value/i);
    // Horizon slice: year-1 horizon has fewer months and no payback yet.
    const y1 = await api.get(`${CMS}/finance/returns?modelId=${m.id}&horizonYears=1`).set('Authorization', op.auth);
    expect(y1.body.data.horizon.months).toBe(12);
    expect(y1.body.data.paybackWithinHorizon).toBe(false);
  });

  it('returns.irr-na-no-sign-change: all-positive flows show N/A honestly', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await createModel(op.auth, {
      name: 'No capital at risk',
      inputs: { capitalTotal: 0, lease: { monthlyByYear: [0, 0, 0, 0, 0], rentFreeMonths: 0 }, opex: { baseMonthly: 0, annualGrowthPct: 0 } },
    });
    const res = await api.get(`${CMS}/finance/returns?modelId=${m.id}&horizonYears=1`).set('Authorization', op.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.irrAnnualised).toBeNull();
    expect(res.body.data.irrNote).toMatch(/Not available/);
  });

  it('returns.irr-na-all-negative + returns.payback-never', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await createModel(op.auth, {
      name: 'Never pays back',
      inputs: { capitalTotal: 1000000000, opex: { baseMonthly: 50000, annualGrowthPct: 0 } },
    });
    const res = await api.get(`${CMS}/finance/returns?modelId=${m.id}&horizonYears=5`).set('Authorization', op.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.paybackMonth).toBeNull();
    expect(res.body.data.irrAnnualised).toBeNull();
    expect(res.body.data.irrNote).toMatch(/Not available/);
  });

  it('returns without a CURRENT baseline 404s with guidance', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const res = await api.get(`${CMS}/finance/returns`).set('Authorization', op.auth);
    expect(res.status).toBe(404);
  });
});

describe('budgets + expenses', () => {
  beforeEach(resetDb);

  it('budgets.lease-line-protected: lease row is derived, read-only, never editable', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const approver = await createOperator('FINANCE_APPROVER');
    const { branch } = await seedPricingWorld();
    const m = await createModel(op.auth, { name: 'Lease source', branchId: branch.id });
    await api.post(`${CMS}/finance/library/${m.id}/submit`).set('Authorization', approver.auth).send({ version: 0 });
    await api.post(`${CMS}/finance/library/${m.id}/approve`).set('Authorization', approver.auth).send({ version: 1 });

    const res = await api.get(`${CMS}/finance/budgets?branchId=${branch.id}&fiscalMonth=2026-12`).set('Authorization', op.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.lease.amount).toBe(5000);
    expect(res.body.data.lease.note).toMatch(/Linked from Financial Model/);
    expect(res.body.data.summary.totalOperating).toBe(5000);

    // Direct PUT on the derived lease line is always forbidden.
    const put = await api.put(`${CMS}/finance/budgets/lease:2026-12`).set('Authorization', approver.auth).send({ amount: 1, version: 0 });
    expect(put.status).toBe(403);

    // Lease-like categories are rejected for ordinary budget lines.
    const bad = await api.post(`${CMS}/finance/budgets`).set('Authorization', op.auth).send({
      branchId: branch.id, fiscalMonth: '2026-12', category: 'Landlord Rent', amount: 100,
    });
    expect(bad.status).toBe(400);
  });

  it('budget scopes: month-only vs month+future, protected override path', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const approver = await createOperator('FINANCE_APPROVER');
    const { branch } = await seedPricingWorld();
    const created = await api.post(`${CMS}/finance/budgets`).set('Authorization', op.auth).send({
      branchId: branch.id, fiscalMonth: '2027-01', category: 'Utilities', amount: 400,
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const one = await api.put(`${CMS}/finance/budgets/${id}`).set('Authorization', op.auth).send({ amount: 450, scope: 'month', version: 0 });
    expect(one.status).toBe(200);
    expect(one.body.data.affectedMonths).toEqual(['2027-01']);

    const future = await api.put(`${CMS}/finance/budgets/${id}`).set('Authorization', op.auth).send({ amount: 500, scope: 'month+future', version: 1 });
    expect(future.status).toBe(200);
    expect(future.body.data.affectedMonths).toHaveLength(12);
    const feb = await api.get(`${CMS}/finance/budgets?branchId=${branch.id}&fiscalMonth=2027-02`).set('Authorization', op.auth);
    expect(feb.body.data.lines.find((l: { category: string }) => l.category === 'Utilities').budget).toBe(500);
    // Original month kept its own version bump (no silent cross-month clobber).
    expect(one.body.data.affectedMonths).toEqual(['2027-01']);

    // Protected row: operator override attempt denied, approver override allowed + audited.
    const protectedRow = await prisma.budget.create({
      data: { branchId: branch.id, fiscalMonth: '2027-03', category: 'Premises Rent Accrual', amount: 5000, protected: true, createdBy: 'e2e' },
    });
    const denied = await api.put(`${CMS}/finance/budgets/${protectedRow.id}`).set('Authorization', op.auth).send({ amount: 1, version: 0, protectedOverride: true });
    expect(denied.status).toBe(403);
    const allowed = await api.put(`${CMS}/finance/budgets/${protectedRow.id}`).set('Authorization', approver.auth).send({ amount: 5100, version: 0, protectedOverride: true });
    expect(allowed.status).toBe(200);
    const audits = await prisma.financeAuditEvent.findMany({ where: { entityType: 'budget', entityId: protectedRow.id } });
    expect(audits.some((a) => a.action === 'BUDGET_UPDATED' && (a.after as { protectedOverride?: boolean })?.protectedOverride === true)).toBe(true);
  });

  it('expenses record immediately and export audited', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const { branch } = await seedPricingWorld();
    const rec = await api.post(`${CMS}/finance/expenses`).set('Authorization', op.auth).send({
      branchId: branch.id, category: 'Utilities', amount: 120.5, incurredAt: '2027-01-15T00:00:00Z', vendor: 'Power Co', receiptRef: 'content/receipts/r1.pdf',
    });
    expect(rec.status).toBe(201);
    const list = await api.get(`${CMS}/finance/expenses?branchId=${branch.id}`).set('Authorization', op.auth);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].receiptRef).toBe('content/receipts/r1.pdf');
    const csv = await api.get(`${CMS}/finance/expenses/export.csv?branchId=${branch.id}`).set('Authorization', op.auth);
    expect(csv.status).toBe(200);
    expect(csv.text).toMatch(/Power Co/);
    const audits = await prisma.financeAuditEvent.findMany({ where: { entityType: 'expenses' } });
    expect(audits).toHaveLength(1);
  });
});

describe('pricing overlay (live wins)', () => {
  beforeEach(resetDb);

  it('reads live inventory; pricing.override-audited never touches Unit rows', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const { branch, locker } = await seedPricingWorld();
    const before = await prisma.unit.findMany({ where: { branchId: branch.id } });

    const res = await api.get(`${CMS}/finance/pricing?branchId=${branch.id}`).set('Authorization', op.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.facilityUnits).toBe(2);
    expect(res.body.data.facilityNla).toBe(70);
    // Size-mix sync labels each live size with its sqft range at this facility.
    const lockerRow = res.body.data.rows.find((r: { code: string }) => r.code === 'LOCKER');
    expect(lockerRow).toMatchObject({ name: 'Locker', units: 1, minSqft: 20, maxSqft: 20 });
    expect(res.body.data.rows.find((r: { code: string }) => r.code === 'MEDIUM')).toMatchObject({ units: 0, minSqft: null, maxSqft: null });
    expect(res.body.data.authorityNote).toMatch(/NEVER write back/);

    const over = await api.put(`${CMS}/finance/pricing/${locker.id}`).set('Authorization', op.auth).send({
      branchId: branch.id, targetPsf: 7.2, reason: 'Promo corridor test',
    });
    expect(over.status).toBe(200);
    expect(over.body.data.overlayOnly).toBe(true);
    expect(over.body.data.targetPsf).toBe(7.2);

    // Live Unit rows byte-identical; effective PSF now comes from the overlay.
    const afterUnits = await prisma.unit.findMany({ where: { branchId: branch.id } });
    expect(afterUnits.map((u) => u.monthlyRate.toString())).toEqual(before.map((u) => u.monthlyRate.toString()));
    const reread = await api.get(`${CMS}/finance/pricing?branchId=${branch.id}`).set('Authorization', op.auth);
    const row = reread.body.data.rows.find((r: { sizeId: string }) => r.sizeId === locker.id);
    expect(row.authority).toBe('MANUAL');
    expect(row.overrideBadge).toMatch(/overlay/);
    expect(row.effectivePsf).toBe(7.2);

    const audits = await prisma.financeAuditEvent.findMany({ where: { entityType: 'size-price-rule' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('PRICING_OVERRIDE');

    // Reason required; stale rule versions conflict.
    expect((await api.put(`${CMS}/finance/pricing/${locker.id}`).set('Authorization', op.auth).send({ branchId: branch.id, targetPsf: 8 })).status).toBe(400);
    expect((await api.put(`${CMS}/finance/pricing/${locker.id}`).set('Authorization', op.auth).send({ branchId: branch.id, targetPsf: 8, reason: 'x', version: 0 })).status).toBe(409);
  });
});

describe('model library governance', () => {
  beforeEach(resetDb);

  it('library.save-appears: named versions show immediately', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await createModel(op.auth);
    const saved = await api.post(`${CMS}/finance/library/${m.id}/save-version`).set('Authorization', op.auth).send({ changeSummary: 'Baseline v1' });
    expect(saved.status).toBe(201);
    const lib = await api.get(`${CMS}/finance/library`).set('Authorization', op.auth);
    expect(lib.body.data.find((c: { id: string }) => c.id === m.id).latestVersion.changeSummary).toBe('Baseline v1');
    const versions = await api.get(`${CMS}/finance/library/${m.id}/versions`).set('Authorization', op.auth);
    expect(versions.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('library.load-preserves-actuals: submit/approve/set-current never fabricate actuals', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const approver = await createOperator('FINANCE_APPROVER');
    const m = await createModel(op.auth, { name: 'Governance' });
    expect((await api.post(`${CMS}/finance/library/${m.id}/submit`).set('Authorization', approver.auth).send({ version: 0 })).status).toBe(200);
    const approved = await api.post(`${CMS}/finance/library/${m.id}/approve`).set('Authorization', approver.auth).send({ version: 1, comment: 'Looks good' });
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('CURRENT');
    // No ActualMetric table exists in Phase 2 — the endpoint must not invent one.
    expect(await prisma.financeAuditEvent.count({ where: { entityType: 'financial-model', entityId: m.id } })).toBeGreaterThan(0);
  });

  it('library.duplicate-restore: name + reason required, history never overwritten', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await createModel(op.auth, { name: 'Original' });
    expect((await api.post(`${CMS}/finance/library/${m.id}/duplicate`).set('Authorization', op.auth).send({ name: 'Copy' })).status).toBe(400);
    const dup = await api.post(`${CMS}/finance/library/${m.id}/duplicate`).set('Authorization', op.auth).send({ name: 'Copy', reason: 'Board variant' });
    expect(dup.status).toBe(201);
    expect(dup.body.data.name).toBe('Copy');
    const restored = await api.post(`${CMS}/finance/library/${m.id}/restore`).set('Authorization', op.auth).send({ version: 0, reason: 'Revisit opening plan' });
    expect(restored.status).toBe(201);
    expect(restored.body.data.name).toMatch(/restore v0/);
    // Original still has its own versions — nothing overwritten.
    const versions = await api.get(`${CMS}/finance/library/${m.id}/versions`).set('Authorization', op.auth);
    expect(versions.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('reject returns to DRAFT; archive hides; set-current supersedes', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const approver = await createOperator('FINANCE_APPROVER');
    const a = await createModel(op.auth, { name: 'A' });
    await api.post(`${CMS}/finance/library/${a.id}/submit`).set('Authorization', approver.auth).send({ version: 0 });
    const rejected = await api.post(`${CMS}/finance/library/${a.id}/reject`).set('Authorization', approver.auth).send({ version: 1, comment: 'Needs work' });
    expect(rejected.body.data.status).toBe('DRAFT');

    await api.post(`${CMS}/finance/library/${a.id}/submit`).set('Authorization', approver.auth).send({ version: 2 });
    await api.post(`${CMS}/finance/library/${a.id}/approve`).set('Authorization', approver.auth).send({ version: 3 });
    const b = await createModel(op.auth, { name: 'B' });
    const current = await api.post(`${CMS}/finance/library/${b.id}/set-current`).set('Authorization', approver.auth).send({ version: 0 });
    expect(current.body.data.status).toBe('CURRENT');
    const rereadA = await api.get(`${CMS}/finance/models/${a.id}`).set('Authorization', op.auth);
    expect(rereadA.body.data.status).toBe('ARCHIVED');

    const archived = await api.post(`${CMS}/finance/library/${b.id}/archive`).set('Authorization', approver.auth).send({ version: 1 });
    expect(archived.status).toBe(403); // CURRENT cannot be archived
  });

  it('pricing.inventory-mapping-gate: unmapped sizes block approval, never viewing', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const approver = await createOperator('FINANCE_APPROVER');
    // Minimal taxonomy: live sizes cover LOCKER + SMALL only, but the default
    // model mix also needs MEDIUM/LARGE/XL — approval must block, viewing not.
    const locker = await prisma.unitSize.create({ data: { code: 'LOCKER', name: 'Locker', sqftFrom: 5, sqftTo: 25, sortOrder: 1 } });
    await prisma.unitSize.create({ data: { code: 'SMALL', name: 'Small', sqftFrom: 26, sqftTo: 60, sortOrder: 2 } });
    const branch = await prisma.branch.create({ data: { code: 'G2', name: 'Gate', address: '1 Gate Rd', operatingHours: '9-9' } });
    const floor = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'L1' } });
    await prisma.unit.create({
      data: { branchId: branch.id, floorId: floor.id, sizeId: locker.id, unitCode: 'G2-01-01', sqft: 20, monthlyRate: 136, status: 'AVAILABLE' },
    });
    const m = await createModel(op.auth, { name: 'Unmapped', branchId: branch.id });
    // Viewing works despite the gap.
    expect((await api.get(`${CMS}/finance/models/${m.id}`).set('Authorization', op.auth)).status).toBe(200);
    await api.post(`${CMS}/finance/library/${m.id}/submit`).set('Authorization', approver.auth).send({ version: 0 });
    const blocked = await api.post(`${CMS}/finance/library/${m.id}/approve`).set('Authorization', approver.auth).send({ version: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('BLOCKED');
    expect(blocked.body.error.message).toMatch(/inventory mapping/);
  });

  it('every transition writes audit history with correlation', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const approver = await createOperator('FINANCE_APPROVER');
    const m = await createModel(op.auth, { name: 'Audited' });
    await api.put(`${CMS}/finance/models/${m.id}/inputs`).set('Authorization', op.auth).send({ version: 0, patch: { horizonMonths: 36 } });
    await api.post(`${CMS}/finance/library/${m.id}/submit`).set('Authorization', approver.auth).send({ version: 1 });
    const audit = await api.get(`${CMS}/finance/library/${m.id}/audit`).set('Authorization', op.auth);
    expect(audit.status).toBe(200);
    const actions = audit.body.data.map((a: { action: string }) => a.action);
    expect(actions).toContain('MODEL_CREATED');
    expect(actions).toContain('MODEL_SECTION_UPDATED');
    expect(actions).toContain('MODEL_SUBMITTED');
    for (const a of audit.body.data) expect(a.correlationId).toBeTruthy();
  });
});

describe('model export (audited)', () => {
  beforeEach(resetDb);

  it('downloads the month table CSV and writes a correlated audit event', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await createModel(op.auth);
    const res = await api.get(`${CMS}/finance/models/${m.id}/export.csv`).set('Authorization', op.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0]).toMatch(/^month,opening_sqft/);
    expect(res.text).toMatch(/opex_lease,opex_non_lease/);
    const audits = await prisma.financeAuditEvent.findMany({ where: { entityType: 'financial-model', entityId: m.id, action: 'EXPORT_GENERATED' } });
    expect(audits).toHaveLength(1);
  });
});

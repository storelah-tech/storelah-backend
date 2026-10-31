// Finance prototype parity — server pieces behind the ported workspace.
//
// Covers: the four staged sections (occupancy, capital, pricing, lease) with
// derived totals, monthly opex overrides in the engine, the protected lease
// category inside the model's opex lines, expenditure detail + edit (closed
// months locked), the posted-actuals series (closed months only, never
// fabricated), and the cross-customer credit ledger.

import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb, seedMoveInWorld } from './fixtures';
import { defaultModelInputs, projectModel } from '../../src/core/finance/models';
import { inventoryMappingProblems } from '../../src/core/finance/library';

const CMS = '/api/v1/cms';

async function newModel(auth: string, branchId?: string) {
  const res = await api.post(`${CMS}/finance/models`).set('Authorization', auth).send({ name: 'Parity model', branchId });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('prototype-parity model sections', () => {
  beforeEach(resetDb);

  it('new models carry the itemised template and still match the §28 golden numbers', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await newModel(op.auth);
    expect(m.inputs.capitalItems).toHaveLength(6);
    expect(m.inputs.capitalTotal).toBe(108000);
    expect(m.inputs.opex.categories.map((c: { name: string }) => c.name)).toContain('Marketing');
    expect(m.inputs.opex.baseMonthly).toBe(1200);
    expect(m.inputs.lease.monthlyByYear).toHaveLength(7);
    expect(m.projection.kpis.paybackMonth).toBe(32);
    expect(m.projection.kpis.stabilisedMonth).toBe(18);
    expect(m.projection.kpis.irrAnnualised).toBeCloseTo(0.3949, 3);
  });

  it('each staged section commits alone, with optimistic locking and derived totals', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await newModel(op.auth);
    const put = (section: string, version: number, patch: object) =>
      api.put(`${CMS}/finance/models/${m.id}/${section}`).set('Authorization', op.auth).send({ version, patch });

    const occ = await put('occupancy', 0, { occupancy: { ...m.inputs.occupancy, rampFirst6: 200 } });
    expect(occ.status).toBe(200);
    expect(occ.body.data.inputs.occupancy.rampFirst6).toBe(200);
    expect(occ.body.data.inputs.capitalTotal).toBe(108000); // other sections untouched

    const cap = await put('capital', 1, { capitalItems: [{ name: 'Fit-out', amount: 60000 }, { name: 'Locks', amount: 15000 }] });
    expect(cap.status).toBe(200);
    expect(cap.body.data.inputs.capitalTotal).toBe(75000);

    const wrongKey = await put('pricing', 2, { capitalTotal: 1 });
    expect(wrongKey.status).toBe(400);
    const stale = await put('lease', 1, { lease: { monthlyByYear: [4000], rentFreeMonths: 0 } });
    expect(stale.status).toBe(409);
    const lease = await put('lease', 2, { lease: { monthlyByYear: [4000, 4000, 4200], rentFreeMonths: 2, ufaSqft: 3068 } });
    expect(lease.status).toBe(200);
    expect(lease.body.data.projection.months[0].opexLease).toBe(0); // rent-free month
    expect(lease.body.data.projection.months[2].opexLease).toBe(4000);
  });

  it('a size-mix sync commits live size names with the facility NLA, and the mapping gate accepts them', async () => {
    const world = await seedMoveInWorld();
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await newModel(op.auth, world.branchId);
    const sizes = await prisma.unitSize.findMany({ orderBy: { sortOrder: 'asc' } });
    const sizeMix = sizes.map((s) => ({ name: s.name, range: `${s.sqftFrom} sq ft`, nlaSqft: 100, units: 2, psf: 5 }));
    // The template carries prototype labels (incl. XL) that the live taxonomy may not have.
    const synced = await api.put(`${CMS}/finance/models/${m.id}/size-mix`).set('Authorization', op.auth)
      .send({ version: 0, patch: { sizeMix, nlaSqft: 100 * sizes.length } });
    expect(synced.status).toBe(200);
    expect(synced.body.data.inputs.nlaSqft).toBe(100 * sizes.length);
    expect(synced.body.data.projection.checks.sizeMixReconciles.pass).toBe(true);
    expect(await inventoryMappingProblems(m.id)).toEqual([]);
  });

  it('opex categories derive the base; a lease-named category is rejected', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const m = await newModel(op.auth);
    const ok = await api.put(`${CMS}/finance/models/${m.id}/opex`).set('Authorization', op.auth)
      .send({ version: 0, patch: { opex: { baseMonthly: 0, annualGrowthPct: 0, categories: [{ name: 'Marketing', budget: 700 }, { name: 'Utilities', budget: 300 }] } } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.inputs.opex.baseMonthly).toBe(1000);
    const bad = await api.put(`${CMS}/finance/models/${m.id}/opex`).set('Authorization', op.auth)
      .send({ version: 1, patch: { opex: { baseMonthly: 0, annualGrowthPct: 0, categories: [{ name: 'Landlord rent', budget: 100 }] } } });
    expect(bad.status).toBe(400);
  });

  it('an approved monthly override replaces that month only (scoped budget Update)', () => {
    const base = projectModel(defaultModelInputs());
    const inputs = defaultModelInputs();
    inputs.opex = { ...inputs.opex, overrides: { '2027-03': 2500 } };
    const r = projectModel(inputs);
    const at = (p: typeof r, month: string) => p.months.find((x) => x.month === month)!;
    expect(at(r, '2027-03').opexNonLease).toBe(2500);
    expect(at(r, '2027-02').opexNonLease).toBe(at(base, '2027-02').opexNonLease);
    expect(at(r, '2027-04').opexNonLease).toBe(at(base, '2027-04').opexNonLease);
    expect(at(r, '2027-03').noi).toBe(Math.round((at(r, '2027-03').revenue - at(r, '2027-03').operatingCost) * 100) / 100);
  });
});

describe('expenditure ledger detail', () => {
  beforeEach(resetDb);

  it('records description/status/note, edits open lines, and locks closed months', async () => {
    const world = await seedMoveInWorld();
    const op = await createOperator('OWNER');
    const created = await api.post(`${CMS}/finance/expenses`).set('Authorization', op.auth).send({
      branchId: world.branchId, category: 'Marketing', amount: 500, incurredAt: '2026-12-05',
      vendor: 'Meta', description: 'Launch media', status: 'COMMITTED', note: 'Approved allocation',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('COMMITTED');
    const edit = await api.put(`${CMS}/finance/expenses/${created.body.data.id}`).set('Authorization', op.auth).send({ status: 'PAID', amount: 480 });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({ status: 'PAID', amount: 480, description: 'Launch media' });
    const lease = await api.post(`${CMS}/finance/expenses`).set('Authorization', op.auth).send({ branchId: world.branchId, category: 'Lease', amount: 10, incurredAt: '2026-12-05' });
    expect(lease.status).toBe(400);

    await prisma.monthClose.create({ data: { branchId: world.branchId, fiscalMonth: '2026-12', status: 'CLOSED', closedBy: op.email, closedAt: new Date() } });
    const locked = await api.put(`${CMS}/finance/expenses/${created.body.data.id}`).set('Authorization', op.auth).send({ note: 'late edit' });
    expect(locked.status).toBe(409);
  });
});

describe('posted actuals series + credit ledger', () => {
  beforeEach(resetDb);

  it('lists closed months only, with adjustments folded in, and names the CURRENT baseline', async () => {
    const world = await seedMoveInWorld();
    const op = await createOperator('OWNER');
    const close = await prisma.monthClose.create({ data: { branchId: world.branchId, fiscalMonth: '2026-12', status: 'CLOSED', closedBy: op.email, closedAt: new Date() } });
    await prisma.monthClose.create({ data: { branchId: world.branchId, fiscalMonth: '2027-01', status: 'OPEN' } });
    await prisma.actualMetric.createMany({ data: [
      { branchId: world.branchId, fiscalMonth: '2026-12', metric: 'REVENUE', value: 1000 },
      { branchId: world.branchId, fiscalMonth: '2026-12', metric: 'NOI', value: -5000 },
    ] });
    await prisma.monthCloseAdjustment.create({ data: { monthCloseId: close.id, metric: 'REVENUE', amount: 25, reason: 'late invoice', author: op.email } as never });
    const res = await api.get(`${CMS}/finance/performance/series?branchId=${world.branchId}`).set('Authorization', op.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.months).toHaveLength(1);
    expect(res.body.data.months[0]).toMatchObject({ fiscalMonth: '2026-12', values: { REVENUE: 1025, NOI: -5000 } });
    expect(res.body.data.currentModel).toBeNull();
    const viewer = await createOperator('VIEWER');
    const denied = await api.get(`${CMS}/finance/performance/series?branchId=${world.branchId}`).set('Authorization', viewer.auth);
    expect(denied.status).toBe(403);
  });

  it('credit ledger lists movements across customers (read-only)', async () => {
    const op = await createOperator('OWNER');
    const res = await api.get(`${CMS}/finance/credits/ledger`).set('Authorization', op.auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

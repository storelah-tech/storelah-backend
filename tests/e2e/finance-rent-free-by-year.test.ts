// Per-lease-year rent-free (Section 4 Landlord lease): one optional contract
// date range per lease-schedule row, replacing the single lease-level window.
//
// Engine: per-year windows price exactly like the equivalent single window,
// several years can each carry their own window, per-year ranges take
// precedence over a stored single window, and bad ranges fail validation.
// API: PUT …/landlord-lease persists per-row ranges, rejects out-of-year /
// one-sided ranges and a request that carries both forms, and audits changes.
import { beforeEach, describe, expect, it } from 'vitest';
import { project, type ProjectionInput } from '../../src/core/finance/projection';
import { upcastInputs } from '../../src/core/finance/leaseTerm';
import { api, createOperator, prisma, resetDb } from './fixtures';

const CMS = '/api/v1/cms';

function v2(leaseStart = '2026-12-01', opsStart = '2026-12-01', termMonths = 36): ProjectionInput & { lease: any } {
  const base = {
    startDate: leaseStart,
    horizonMonths: termMonths,
    nlaSqft: 2274,
    sizeMix: [
      { name: 'XS', nlaSqft: 455, units: 31, psf: 6.8 },
      { name: 'S', nlaSqft: 500, units: 20, psf: 6.2 },
      { name: 'M', nlaSqft: 650, units: 16, psf: 5.5 },
      { name: 'L', nlaSqft: 405, units: 7, psf: 4.8 },
      { name: 'XL', nlaSqft: 264, units: 2, psf: 4.2 },
    ],
    occupancy: { rampFirst6: 180, rampFrom7: 125, moveOutRatePct: 2.5, churnStartMonth: 7, targetPct: 92 },
    pricing: { annualIncreasePct: 3 },
    lease: { monthlyByYear: Array(Math.ceil(termMonths / 12)).fill(5000), rentFreeMonths: 0 },
    opex: { baseMonthly: 1200, annualGrowthPct: 0 },
    capitalTotal: 108000,
  };
  const out = upcastInputs(base as unknown as Parameters<typeof upcastInputs>[0]) as unknown as ProjectionInput & { lease: any };
  out.startDate = opsStart;
  return out;
}

const leaseOf = (months: ReturnType<typeof project>['months']) => months.map((m) => m.opexLease);

describe('rent-free by year — engine', () => {
  it('a per-year range prices identically to the same single window', () => {
    const single = v2();
    single.lease.rentFreeStartDate = '2026-12-01';
    single.lease.rentFreeEndDate = '2027-01-15';
    const perYear = v2();
    perYear.lease.schedule[0].rentFreeStartDate = '2026-12-01';
    perYear.lease.schedule[0].rentFreeEndDate = '2027-01-15';
    const a = project(single);
    const b = project(perYear);
    expect(leaseOf(b.months)).toEqual(leaseOf(a.months));
    expect(b.kpis.years.map((y) => y.noi)).toEqual(a.kpis.years.map((y) => y.noi));
    expect(b.months[0].opexLease).toBe(0); // Dec free
    // Jan: 16 of 31 days chargeable at 5,000.
    expect(b.months[1].opexLease).toBeCloseTo((5000 * 16) / 31, 2);
  });

  it('each lease year can carry its own window', () => {
    const inp = v2();
    inp.lease.schedule[0].rentFreeStartDate = '2026-12-01';
    inp.lease.schedule[0].rentFreeEndDate = '2027-01-31'; // Year 1: Dec + Jan
    inp.lease.schedule[1].rentFreeStartDate = '2027-12-01';
    inp.lease.schedule[1].rentFreeEndDate = '2027-12-31'; // Year 2: Dec
    const out = project(inp);
    const byMonth = Object.fromEntries(out.months.map((m) => [m.month, m.opexLease]));
    expect(byMonth['2026-12']).toBe(0);
    expect(byMonth['2027-01']).toBe(0);
    expect(byMonth['2027-02']).toBe(5000);
    expect(byMonth['2027-12']).toBe(0);
    expect(byMonth['2028-01']).toBe(5000);
    expect(byMonth['2028-12']).toBe(5000); // Year 3 has no rent-free
    // Year totals: 10 / 11 / 12 chargeable months.
    expect(out.leasePayableByYear?.[1]?.payable).toBe(50000);
    expect(out.leasePayableByYear?.[2]?.payable).toBe(55000);
    expect(out.leasePayableByYear?.[3]?.payable).toBe(60000);
  });

  it('per-year ranges take precedence over a stored single window', () => {
    const inp = v2();
    inp.lease.rentFreeStartDate = '2026-12-01';
    inp.lease.rentFreeEndDate = '2027-05-31';
    inp.lease.schedule[1].rentFreeStartDate = '2027-12-01';
    inp.lease.schedule[1].rentFreeEndDate = '2027-12-31';
    const byMonth = Object.fromEntries(project(inp).months.map((m) => [m.month, m.opexLease]));
    expect(byMonth['2026-12']).toBe(5000); // single window ignored
    expect(byMonth['2027-12']).toBe(0);
  });

  it('models without per-year ranges keep the exact single-window rows', () => {
    const inp = v2();
    inp.lease.rentFreeStartDate = '2026-12-01';
    inp.lease.rentFreeEndDate = '2027-02-28';
    const before = project(inp);
    inp.lease.schedule.forEach((r: any) => { r.rentFreeStartDate = null; r.rentFreeEndDate = null; });
    expect(project(inp).months).toEqual(before.months);
  });

  it('rejects a range outside its own lease year, one-sided and reversed ranges', () => {
    const outside = v2();
    outside.lease.schedule[0].rentFreeStartDate = '2027-11-01';
    outside.lease.schedule[0].rentFreeEndDate = '2027-12-15'; // crosses into Year 2
    expect(() => project(outside)).toThrow(/must lie within Year 1/);
    const oneSided = v2();
    oneSided.lease.schedule[1].rentFreeStartDate = '2027-12-01';
    expect(() => project(oneSided)).toThrow(/needs both a start and an end date/);
    const reversed = v2();
    reversed.lease.schedule[0].rentFreeStartDate = '2027-02-01';
    reversed.lease.schedule[0].rentFreeEndDate = '2027-01-01';
    expect(() => project(reversed)).toThrow(/before start/);
  });

  it('lease starting before opening: pre-opening rent-free months cost nothing', () => {
    const inp = v2('2026-10-01', '2026-12-01', 36);
    inp.lease.schedule[0].rentFreeStartDate = '2026-10-01';
    inp.lease.schedule[0].rentFreeEndDate = '2026-11-30';
    const byMonth = Object.fromEntries(project(inp).months.map((m) => [m.month, m.opexLease]));
    expect(byMonth['2026-10']).toBe(0);
    expect(byMonth['2026-11']).toBe(0);
    expect(byMonth['2026-12']).toBe(5000);
  });
});

// ---------- API ----------

function sched(years: number, extra: Array<Record<string, unknown>> = []) {
  return Array.from({ length: years }, (_, i) => ({ leaseYear: i + 1, monthlyRent: 5000, source: 'contract', confirmed: true, ...(extra[i] ?? {}) }));
}

function leaseBody(version: number, overrides: Record<string, unknown> = {}) {
  return {
    version,
    leaseStartDate: '2026-12-01',
    committedTermMonths: 36,
    prorationMethod: 'actual_days',
    currency: 'SGD',
    ufaSqft: 3068,
    rentFreeStartDate: null,
    rentFreeEndDate: null,
    schedule: sched(3),
    ...overrides,
  };
}

async function ownerWorld() {
  const owner = await createOperator('OWNER');
  const s = await api.put(`${CMS}/settings`).set('Authorization', owner.auth).send({
    'finance.leaseHorizon.rollout': 'all',
    'finance.leaseHorizon.returns': 'on',
  });
  expect(s.status).toBe(200);
  const branch = await prisma.branch.create({
    data: { code: `RF${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: 'Rent-free E2E', address: 'Admirax', operatingHours: '9-9' },
  });
  const m = await api.post(`${CMS}/finance/models`).set('Authorization', owner.auth).send({ name: 'RF Model', branchId: branch.id });
  expect(m.status).toBe(201);
  return { owner, model: m.body.data as { id: string; version: number } };
}

describe('rent-free by year — landlord-lease API', () => {
  beforeEach(resetDb);

  it('persists per-year ranges, projects them and audits the change', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, {
        schedule: sched(3, [
          { rentFreeStartDate: '2026-12-01', rentFreeEndDate: '2027-01-31' },
          { rentFreeStartDate: '2027-12-01', rentFreeEndDate: '2027-12-31' },
        ]),
      }));
    expect(res.status).toBe(200);
    const get = await api.get(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth);
    const rows = get.body.data.leaseSchedule;
    expect(rows[0]).toMatchObject({ leaseYear: 1, rentFreeStartDate: '2026-12-01', rentFreeEndDate: '2027-01-31' });
    expect(rows[1]).toMatchObject({ leaseYear: 2, rentFreeStartDate: '2027-12-01', rentFreeEndDate: '2027-12-31' });
    expect(rows[2].rentFreeStartDate ?? null).toBeNull();
    expect(get.body.data.rentFreeStartDate).toBeNull();

    const detail = await api.get(`${CMS}/finance/models/${model.id}`).set('Authorization', owner.auth);
    const months = detail.body.data.projection.months as Array<{ month: string; opexLease: number }>;
    const byMonth = Object.fromEntries(months.map((m) => [m.month, m.opexLease]));
    expect(byMonth['2026-12']).toBe(0);
    expect(byMonth['2027-01']).toBe(0);
    expect(byMonth['2027-12']).toBe(0);
    expect(byMonth['2028-12']).toBe(5000);

    const audit = await prisma.financeAuditEvent.findFirst({ where: { action: 'MODEL_LEASE_HORIZON_UPDATED', entityId: model.id } });
    expect(JSON.stringify(audit)).toContain('rentFreeChanged');
    expect(JSON.stringify(audit)).toContain('2027-12-01–2027-12-31');
  });

  it('rejects a range outside its lease year with a per-row field error', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { schedule: sched(3, [{ rentFreeStartDate: '2027-11-15', rentFreeEndDate: '2027-12-15' }]) }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/must lie within Year 1/);
    expect(JSON.stringify(res.body)).toContain('schedule[0]');
  });

  it('rejects a one-sided range', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { schedule: sched(3, [{}, { rentFreeStartDate: '2027-12-01' }]) }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/needs both a start and an end date/);
  });

  it('rejects per-year ranges together with the single window', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, {
        rentFreeStartDate: '2026-12-01',
        rentFreeEndDate: '2026-12-31',
        schedule: sched(3, [{ rentFreeStartDate: '2026-12-01', rentFreeEndDate: '2026-12-31' }]),
      }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/not both/);
  });

  it('the single window still works for clients that send it', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { rentFreeStartDate: '2026-12-01', rentFreeEndDate: '2026-12-31' }));
    expect(res.status).toBe(200);
    const detail = await api.get(`${CMS}/finance/models/${model.id}`).set('Authorization', owner.auth);
    expect(detail.body.data.projection.months[0].opexLease).toBe(0);
  });
});

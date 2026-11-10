// Lease-horizon WP-1 regression tests (bugs B1–B8, prototype parity 2026-11-10).
//
// API tests use the isolated test DB (fixtures); engine tests are pure. Every
// expected value below is HAND-DERIVED from the owner rulings (D1B/D6B/D12A)
// and the P1/P2 engine math — never generated from the module under test.
//
// B1: 36.5 rejected as non-integer, model unchanged.
// B2: operational start saves through PUT …/inputs with startDate only (no
//     horizonMonths) and persists after reload.
// B3: straddle rows earn prorated revenue/move-ins for operational days only.
// B4: Year 1 prices S$60,000 / 12 months for lease 15 Dec + ops 1 Dec.
// B5: shorten 60→36 then extend to 72 reuses the kept rents, no duplicate years.
// B7: the closing part-month is a forecast row and reads through the shared
//     lease reader.
// B8: term 121 rejected with the range copy, model unchanged.

import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';
import { project, type ProjectionInput } from '../../src/core/finance/projection';
import { upcastInputs } from '../../src/core/finance/leaseTerm';
import { committedLeaseForMonth } from '../../src/core/finance/leaseExpense';

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
    data: { code: `LH${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: 'Lease Horizon WP1', address: 'Admirax', operatingHours: '9-9' },
  });
}

async function makeModel(auth: string, branchId?: string) {
  const res = await api.post(`${CMS}/finance/models`).set('Authorization', auth).send({ name: 'LH WP1', ...(branchId ? { branchId } : {}) });
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

// ---------- engine fixtures (hand-derived) ----------

function v1Base(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    startDate: '2026-12-01',
    horizonMonths: 60,
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
    lease: { monthlyByYear: [5000, 5000, 5000, 5000, 5000], rentFreeMonths: 0 },
    opex: { baseMonthly: 1200, annualGrowthPct: 0 },
    capitalTotal: 108000,
    ...overrides,
  };
}

/** Two-date v2 input: upcast from the LEASE start (dates derived there), then
 * move the OPERATIONAL start. horizonMonths stays mirrored to the term. */
function twoDateInput(leaseStart: string, opsStart: string, termMonths: number): ProjectionInput {
  const base = v1Base({
    startDate: leaseStart,
    horizonMonths: termMonths,
    lease: { monthlyByYear: Array(Math.ceil(termMonths / 12)).fill(5000), rentFreeMonths: 0 },
  });
  const v2 = upcastInputs(base as unknown as Parameters<typeof upcastInputs>[0]) as unknown as ProjectionInput;
  v2.startDate = opsStart;
  return v2;
}

// Weighted PSF: (455·6.8 + 500·6.2 + 650·5.5 + 405·4.8 + 264·4.2) / 2274
// = 12821.8 / 2274 = 5.6384 (round4). December cap: 2274 · 92% = 2092.08.

describe('wp1.B3 engine: operational days inside a straddle row are prorated', () => {
  it('lease 1 Dec, opening 15 Dec: December earns 17 trading days (not zero)', () => {
    const out = project(twoDateInput('2026-12-01', '2026-12-15', 12));
    expect(out.months).toHaveLength(12);
    const dec = out.months[0];
    expect(dec.month).toBe('2026-12');
    expect(dec.isPreOpening).toBe(true); // row-start label is kept
    // Hand math: move-in 180·17/31 = 98.71; revenue 98.71·5.6384·17/31 = 305.21.
    expect(dec.moveInSqft).toBe(98.71);
    expect(dec.closingSqft).toBe(98.71);
    expect(dec.revenue).toBe(305.21);
    expect(out.checks.revenueUsesOccupiedPsf.pass).toBe(true);
  });

  it('opening 1 Dec, lease 15 Dec: December earns from the lease start', () => {
    const out = project(twoDateInput('2026-12-15', '2026-12-01', 12));
    expect(out.months).toHaveLength(13);
    const dec = out.months[0];
    expect(dec.moveInSqft).toBe(98.71);
    expect(dec.revenue).toBe(305.21);
    // Lease rent IS charged for the 17 chargeable days (D6: lease commenced).
    expect(dec.opexLease).toBe(2741.94);
    expect(out.checks.revenueUsesOccupiedPsf.pass).toBe(true);
  });

  it('operations before the lease: whole pre-lease months stay at zero', () => {
    const out = project(twoDateInput('2026-12-15', '2026-10-01', 12));
    expect(out.months).toHaveLength(15);
    const [oct, nov, dec] = out.months;
    expect(oct.month).toBe('2026-10');
    for (const m of [oct, nov]) {
      expect(m.revenue).toBe(0);
      expect(m.moveInSqft).toBe(0);
      expect(m.closingSqft).toBe(0);
      expect(m.opexLease).toBe(0);
    }
    expect(dec.revenue).toBeGreaterThan(0);
    expect(out.checks.revenueUsesOccupiedPsf.pass).toBe(true);
  });
});

describe('wp1.B4 engine: per-lease-year payable splits straddle rows', () => {
  it('lease 15 Dec + ops 1 Dec prices Year 1 at S$60,000 / 12 months', () => {
    const out = project(twoDateInput('2026-12-15', '2026-12-01', 12));
    const y1 = out.leasePayableByYear?.[1];
    expect(y1).toBeDefined();
    // Hand math: 5000·17/31 + 11·5000 + 5000·14/31 = 2741.94 + 55000 + 2258.06.
    expect(y1?.payable).toBe(60000);
    expect(y1?.factor).toBeCloseTo(12, 9);
  });
});

describe('wp1.B7 engine: the closing part-month is a forecast row', () => {
  it('15 Dec 12-month term ends with a 1–14 Dec 2027 row the budget list can offer', () => {
    const inputs = twoDateInput('2026-12-15', '2026-12-01', 12);
    const out = project(inputs);
    const last = out.months[out.months.length - 1];
    expect(last.month).toBe('2027-12');
    expect(last.periodStart).toBe('2027-12-01');
    expect(last.periodEnd).toBe('2027-12-14');
    // Hand math: 5000·14/31 = 2258.06 through the shared lease reader.
    expect(committedLeaseForMonth(inputs, '2027-12')).toBe(2258.06);
  });
});

describe('wp1 API: term gates leave the model untouched (B1 decimal, B8 range)', () => {
  beforeEach(resetDb);

  it('B1: 36.5 is rejected with the whole-number copy; committed term stays 60', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { committedTermMonths: 36.5, schedule: sched(3) }));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/whole number/);
    const kept = await api.get(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth);
    expect(kept.body.data.committedTermMonths).toBe(60);
    expect(kept.body.data.committedEndDate).toBe('2031-11-30');
    expect(kept.body.data.leaseSchedule).toHaveLength(5);
  });

  it('B8: 121 is rejected with the range copy; no rows are added or changed', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { committedTermMonths: 121, schedule: sched(10) }));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/between 12 and 120 months/);
    expect(res.body.error.details.fieldErrors.committedTermMonths).toHaveLength(1);
    const kept = await api.get(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth);
    expect(kept.body.data.committedTermMonths).toBe(60);
    expect(kept.body.data.leaseSchedule).toHaveLength(5);
  });
});

describe('wp1 API: operational start saves without horizonMonths (B2)', () => {
  beforeEach(resetDb);

  it('PUT …/inputs with startDate only persists and re-times the projection', async () => {
    const { owner, model } = await ownerWorld();
    // Mid-month lease on the 15th…
    const lease = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { leaseStartDate: '2026-12-15', committedTermMonths: 12, schedule: sched(1) }));
    expect(lease.status).toBe(200);
    // …then move the OPERATIONAL start through the generic inputs section —
    // no horizonMonths in the patch (the B2 rejection travelled with it).
    const upd = await api.put(`${CMS}/finance/models/${model.id}/inputs`).set('Authorization', owner.auth)
      .send({ version: 1, patch: { startDate: '2026-11-20' } });
    expect(upd.status).toBe(200);
    const detail = await api.get(`${CMS}/finance/models/${model.id}`).set('Authorization', owner.auth);
    expect(detail.body.data.inputs.startDate).toBe('2026-11-20');
    // Timeline starts at the earlier date; the pre-lease month earns nothing
    // while the lease-start row earns its 17 operational days (B3/B4).
    const months = detail.body.data.projection.months as Array<{ month: string; revenue: number }>;
    expect(months[0].month).toBe('2026-11');
    expect(months[0].revenue).toBe(0);
    const dec = months.find((m) => m.month === '2026-12');
    expect(dec?.revenue).toBeGreaterThan(0);
    const y1 = detail.body.data.projection.leasePayableByYear?.['1'] as { payable: number; factor: number } | undefined;
    expect(y1?.payable).toBe(60000);
    expect(y1?.factor).toBeCloseTo(12, 9);
  });
});

describe('wp1 API: shorten then re-extend reuses the kept rents (B5)', () => {
  beforeEach(resetDb);

  it('60→36 keeps Years 4–5; 36→72 restores them with no duplicate years', async () => {
    const { owner, model } = await ownerWorld();
    const short = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(0, { committedTermMonths: 36, schedule: sched(3) }));
    expect(short.status).toBe(200);
    expect(short.body.data.lease.committedTermMonths).toBe(36);
    const kept = short.body.data.lease.leaseSchedule as Array<{ leaseYear: number; monthlyRent: number; excluded?: boolean }>;
    const outside = kept.filter((r) => r.excluded).sort((a, b) => a.leaseYear - b.leaseYear);
    expect(outside.map((r) => r.leaseYear)).toEqual([4, 5]);
    expect(outside.map((r) => r.monthlyRent)).toEqual([5000, 5000]);

    // Re-extend mirroring the UI: resurrected kept rows + one confirmed estimate.
    const extend = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(1, {
        committedTermMonths: 72,
        schedule: [
          ...sched(3),
          ...outside.map((r) => ({ leaseYear: r.leaseYear, monthlyRent: r.monthlyRent, source: 'contract', confirmed: true })),
          { leaseYear: 6, monthlyRent: 5000, source: 'estimated', confirmed: true },
        ],
      }));
    expect(extend.status).toBe(200);
    const rows = extend.body.data.lease.leaseSchedule as Array<{ leaseYear: number; monthlyRent: number; source: string; excluded?: boolean }>;
    expect(rows.map((r) => r.leaseYear)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.filter((r) => r.excluded)).toHaveLength(0);
    expect(rows.filter((r) => r.leaseYear === 4 || r.leaseYear === 5).map((r) => r.monthlyRent)).toEqual([5000, 5000]);
    expect(rows.find((r) => r.leaseYear === 6)?.source).toBe('estimated');
  });
});

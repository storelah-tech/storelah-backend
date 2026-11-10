// Lease-horizon WP-2 regression tests (Investment Returns parity P1/P2/P5,
// prototype v36 2026-11-10).
//
// P1 (labels) is pinned in finance-valuation.test.ts `valuation.R10 payback
// labels` + the fixture regen; this file covers the committed-block additions:
// P2 (scenario comparison) and P5 (renewal result).
//
// Prototype anchors (60-month Sembawang, S$5,000/mo, 15% — evidence §1/§3):
// - Scenario NPVs: Downside S$35,863 / Base S$85,323 / Upside S$115,800.
// - Scenario IRRs: 24.7% / 39.5% / 50.0%.
// - Renewal: shown separately as `Renewal scenario: S$X NPV`; committed
//   figures byte-identical with renewal on or off (LH14).
//
// The engine reproduces the prototype NPVs to S$1 (D12A per-row cents
// rounding; the 36-month precedent −S$8,702 vs −S$8,701 records the same
// accepted drift): engine S$35,861.67 / S$85,322.66 / S$115,799.30.

import { describe, expect, it, beforeEach } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';
import { upcastInputs } from '../../src/core/finance/leaseTerm';
import { project, type ProjectionInput } from '../../src/core/finance/projection';
import {
  analyse,
  buildCashFlowSeries,
  solveIrr,
  type ValuationInputs,
} from '../../src/core/finance/valuation';
import { committedScenarioInputs } from '../../src/core/finance/returns';
import fixture from './fixtures/finance-lease-horizon-validation.json';

const CMS = '/api/v1/cms';

function sched(years: number, rent = 5000) {
  return Array.from({ length: years }, (_, i) => ({ leaseYear: i + 1, monthlyRent: rent, source: 'contract', confirmed: true }));
}

async function makeBranch() {
  return prisma.branch.create({
    data: { code: `LH${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: 'Lease Horizon WP2', address: 'Admirax', operatingHours: '9-9' },
  });
}

async function makeModel(auth: string, branchId?: string) {
  const res = await api.post(`${CMS}/finance/models`).set('Authorization', auth).send({ name: 'LH WP2', ...(branchId ? { branchId } : {}) });
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

async function ownerWorld() {
  const owner = await createOperator('OWNER');
  await enableRollout(owner.auth);
  const branch = await makeBranch();
  const model = await makeModel(owner.auth, branch.id);
  return { owner, branch, model };
}

/** Rebuild the sanctioned v2 input for a fixture case (same as valuation tests). */
function v2InputFor(name: string): ProjectionInput {
  const fx = (fixture as unknown as { inputs: Record<string, any> }).inputs;
  const f = fx[name];
  const econ = fx.sembawang60;
  const upcast = upcastInputs({
    startDate: f.lease.startDate,
    horizonMonths: f.horizonMonths,
    nlaSqft: econ.nlaSqft,
    sizeMix: econ.sizeMix,
    occupancy: f.occupancy,
    pricing: econ.pricing,
    opex: econ.opex,
    capitalTotal: econ.capitalTotal,
    lease: { monthlyByYear: f.lease.monthlyByYear, rentFreeMonths: f.lease.rentFreeMonths },
  });
  return { ...(upcast as unknown as Record<string, unknown>), startDate: f.startDate } as unknown as ProjectionInput;
}

// ---------- P2 engine: prototype-anchored scenario NPVs ----------

describe('wp2.P2 engine: scenario comparison values the committed base with occupancy-only overlays', () => {
  const valuation = (fixture as unknown as { valued: Record<string, { valuation: ValuationInputs }> }).valued.sembawang60.valuation;

  function scenarioNpv(scenario: 'downside' | 'base' | 'upside') {
    const input = committedScenarioInputs(v2InputFor('sembawang60'), scenario);
    const series = buildCashFlowSeries(project(input), valuation);
    return { input, analysis: analyse(series, 0.15), irr: solveIrr(series) };
  }

  it('Downside NPV S$35,861.67 (prototype S$35,863, S$1 D12A drift)', () => {
    const { analysis, irr } = scenarioNpv('downside');
    expect(analysis.npv).toBeCloseTo(35861.67, 2);
    expect(Math.round(analysis.npv)).toBe(35862);
    expect(irr.annualRate as number).toBeCloseTo(0.2473, 4);
  });

  it('Base NPV S$85,322.66 (prototype S$85,323)', () => {
    const { analysis, irr } = scenarioNpv('base');
    expect(analysis.npv).toBeCloseTo(85322.66, 2);
    expect(Math.round(analysis.npv)).toBe(85323);
    expect(irr.annualRate as number).toBeCloseTo(0.3949, 4);
  });

  it('Upside NPV S$115,799.30 (prototype S$115,800, S$1 D12A drift)', () => {
    const { analysis, irr } = scenarioNpv('upside');
    expect(analysis.npv).toBeCloseTo(115799.3, 2);
    expect(Math.round(analysis.npv)).toBe(115799);
    expect(irr.annualRate as number).toBeCloseTo(0.5003, 4);
  });

  it('LH18: overlays touch occupancy only — lease, OPEX, capital, horizon identical', () => {
    const base = v2InputFor('sembawang60');
    for (const name of ['downside', 'upside'] as const) {
      const over = committedScenarioInputs(base, name);
      expect(over.lease).toEqual(base.lease);
      expect(over.opex).toEqual(base.opex);
      expect(over.capitalTotal).toBe(base.capitalTotal);
      expect(over.horizonMonths).toBe(base.horizonMonths);
      expect(over.startDate).toBe(base.startDate);
      expect(over.occupancy).not.toEqual(base.occupancy);
    }
    // Base is a clean clone of the saved plan.
    expect(committedScenarioInputs(base, 'base').occupancy).toEqual(base.occupancy);
  });
});

// ---------- P2 + P5 API: committed.scenarios + committed.renewal ----------

describe('wp2 API: /finance/returns committed block carries scenarios (P2) and renewal (P5)', () => {
  beforeEach(resetDb);

  async function committedModel() {
    const { owner, model } = await ownerWorld();
    const lease = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
      .send({ version: 0, leaseStartDate: '2026-12-01', committedTermMonths: 60, prorationMethod: 'actual_days', currency: 'SGD', ufaSqft: 3068, schedule: sched(5) });
    expect(lease.status).toBe(200);
    return { owner, model };
  }

  it('P2: scenarios rows read Downside / Base / Upside NPV, IRR, paybacks, investment, rate', async () => {
    const { owner, model } = await committedModel();
    const res = await api.get(`${CMS}/finance/returns?modelId=${model.id}`).set('Authorization', owner.auth);
    expect(res.status).toBe(200);
    const c = res.body.data.committed;
    expect(c.renewal).toBeNull();
    expect(c.scenarios.map((s: { scenario: string }) => s.scenario)).toEqual(['downside', 'base', 'upside']);
    for (const s of c.scenarios) {
      expect(s.annualRate).toBe(0.15);
      expect(s.initialInvestment).toBe(108000);
      expect(typeof s.npv).toBe('number');
      expect(typeof s.irr.display).toBe('string');
      expect(typeof s.simplePayback.label).toBe('string');
      expect(typeof s.discountedPayback.label).toBe('string');
    }
    const byName = Object.fromEntries(c.scenarios.map((s: { scenario: string; npv: number }) => [s.scenario, s.npv]));
    // Engine cents vs prototype whole dollars (S$1 D12A drift, see header).
    expect(Math.round(byName.downside)).toBe(35862);
    expect(Math.round(byName.base)).toBe(85323);
    expect(Math.round(byName.upside)).toBe(115799);
    // Base scenario IS the committed valuation.
    const base = c.scenarios.find((s: { scenario: string }) => s.scenario === 'base');
    expect(base.npv).toBe(c.npv);
    expect(base.irr).toEqual(c.irr);
    // P1 labels flow through the API: no calendar-month day counts.
    const simple = c.scenarios.find((s: { scenario: string }) => s.scenario === 'base').simplePayback;
    expect(simple.label).toBe('Month 31 + 19 days');
  });

  it('P5: renewal NPV is shown separately; committed NPV is byte-identical on/off (LH14)', async () => {
    const { owner, model } = await committedModel();
    const before = await api.get(`${CMS}/finance/returns?modelId=${model.id}`).set('Authorization', owner.auth);
    expect(before.body.data.committed.renewal).toBeNull();
    // LH14 compares the committed FIGURES (npv, paybacks, IRR, DCF series):
    // enabling renewal stamps a new model version + input hash, which is
    // expected to advance.
    const figures = (c: any) => JSON.stringify({
      npv: c.npv,
      cumulativeFreeCashFlow: c.cumulativeFreeCashFlow,
      profitabilityIndex: c.profitabilityIndex,
      simplePayback: c.simplePayback,
      discountedPayback: c.discountedPayback,
      paybackMonth: c.paybackMonth,
      discountedPaybackMonth: c.discountedPaybackMonth,
      irr: c.irr,
      dcf: c.dcf,
    });
    const committedBefore = figures(before.body.data.committed);

    const upd = await api.put(`${CMS}/finance/models/${model.id}/valuation`).set('Authorization', owner.auth)
      .send({ version: 1, methodology: 'manual', manualAnnualRate: 0.15, renewalEnabled: true, renewalMonths: 24, includeTerminalCashFlows: false, refundableDeposit: 0, reinstatementCost: 0, otherTerminalCashFlow: 0 });
    expect(upd.status).toBe(200);

    const after = await api.get(`${CMS}/finance/returns?modelId=${model.id}`).set('Authorization', owner.auth);
    const c = after.body.data.committed;
    expect(c.renewal).toMatchObject({ renewalMonths: 24, renewalEndDate: '2033-11-30', annualRate: 0.15 });
    expect(c.renewal.npv).toBeCloseTo(164656.3, 1);
    expect(c.renewal.irr.status).toBe('valid');
    expect(typeof c.renewal.simplePayback.label).toBe('string');
    // LH14: enabling renewal never rewrites the committed figures (only the
    // version + hash stamps advance).
    expect(figures(c)).toBe(committedBefore);
    expect(c.scenarios.find((s: { scenario: string }) => s.scenario === 'base').npv).toBe(c.npv);
  });
});

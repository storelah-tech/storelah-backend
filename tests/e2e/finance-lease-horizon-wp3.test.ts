// Lease-horizon WP-3 regression tests (Financial models parity P7–P12,
// prototype v36 2026-11-10).
//
// P7 (valuation methodology defaults) is engine/API-testable: the prototype's
// Risk-adjusted 8% + 3% + 2% + 2% = 15%, WACC 18% / 6.5% / 70:30 / 17% tax
// and renewal length 24 apply to new models and null stored fields only —
// stored values are never overwritten (D7A). P8–P12 are CMS presentation
// (collapsible card, selects, labels, Expand buttons, audit reachability) and
// are browser-verified with screenshots in
// docs/finance/lease-horizon-evidence/08-parity-fixes/.

import { describe, expect, it, beforeEach } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';
import {
  DEFAULT_VALUATION_ASSUMPTIONS,
  effectiveAnnualRate,
  monthlyRateFromAnnual,
} from '../../src/core/finance/valuation';

const CMS = '/api/v1/cms';

async function makeBranch() {
  return prisma.branch.create({
    data: { code: `LH${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: 'Lease Horizon WP3', address: 'Admirax', operatingHours: '9-9' },
  });
}

async function makeModel(auth: string, branchId?: string, inputs?: Record<string, unknown>) {
  const res = await api.post(`${CMS}/finance/models`).set('Authorization', auth).send({ name: 'LH WP3', ...(branchId ? { branchId } : {}), ...(inputs ? { inputs } : {}) });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; version: number };
}

async function ownerWorld() {
  const owner = await createOperator('OWNER');
  await api.put(`${CMS}/settings`).set('Authorization', owner.auth).send({
    'finance.leaseHorizon.rollout': 'all',
    'finance.leaseHorizon.returns': 'on',
  });
  const branch = await makeBranch();
  const model = await makeModel(owner.auth, branch.id);
  return { owner, branch, model };
}

beforeEach(resetDb);

describe('wp3.P7 prototype valuation defaults (new models + null-only)', () => {
  it('DEFAULT_VALUATION_ASSUMPTIONS matches the prototype v36 methodology block', () => {
    expect(DEFAULT_VALUATION_ASSUMPTIONS.manualAnnualRate).toBe(0.15);
    expect(DEFAULT_VALUATION_ASSUMPTIONS.baseReturn).toBe(0.08);
    expect(DEFAULT_VALUATION_ASSUMPTIONS.businessRisk).toBe(0.03);
    expect(DEFAULT_VALUATION_ASSUMPTIONS.leaseRisk).toBe(0.02);
    expect(DEFAULT_VALUATION_ASSUMPTIONS.executionRisk).toBe(0.02);
    expect(DEFAULT_VALUATION_ASSUMPTIONS.costEquity).toBe(0.18);
    expect(DEFAULT_VALUATION_ASSUMPTIONS.costDebt).toBe(0.065);
    expect(DEFAULT_VALUATION_ASSUMPTIONS.equityWeight).toBe(0.7);
    expect(DEFAULT_VALUATION_ASSUMPTIONS.debtWeight).toBe(0.3);
    expect(DEFAULT_VALUATION_ASSUMPTIONS.taxRate).toBe(0.17);
    expect(DEFAULT_VALUATION_ASSUMPTIONS.renewalEnabled).toBe(false);
    expect(DEFAULT_VALUATION_ASSUMPTIONS.renewalMonths).toBe(24);
  });

  it('Risk-adjusted defaults sum to exactly 15.0% (fresh model choosing Risk-adjusted)', () => {
    const d = DEFAULT_VALUATION_ASSUMPTIONS;
    expect(
      effectiveAnnualRate({
        methodology: 'risk',
        baseReturn: d.baseReturn,
        businessRisk: d.businessRisk,
        leaseRisk: d.leaseRisk,
        executionRisk: d.executionRisk,
      }),
    ).toBeCloseTo(0.15, 12);
  });

  it('WACC defaults resolve to 18%·70% + 6.5%·30%·(1−17%) ≈ 14.2185%', () => {
    const d = DEFAULT_VALUATION_ASSUMPTIONS;
    expect(
      effectiveAnnualRate({
        methodology: 'wacc',
        costEquity: d.costEquity as number,
        costDebt: d.costDebt as number,
        equityWeight: d.equityWeight as number,
        debtWeight: d.debtWeight as number,
        taxRate: d.taxRate as number,
      }),
    ).toBeCloseTo(0.142185, 6);
  });

  it('15% annual shows the prototype summary figures (15.0% · 1.171% effective monthly)', () => {
    expect(monthlyRateFromAnnual(0.15)).toBeCloseTo(0.0117149, 6);
  });

  it('a new model stores the prototype defaults (risk sums to 15%, renewal 24)', async () => {
    const { owner, model } = await ownerWorld();
    const got = await api.get(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth);
    expect(got.status).toBe(200);
    const v = got.body.data.valuation;
    expect(v.methodology).toBe('manual');
    expect(v.manualAnnualRate).toBe(0.15);
    expect(v.baseReturn + v.businessRisk + v.leaseRisk + v.executionRisk).toBeCloseTo(0.15, 12);
    expect(v.costEquity).toBe(0.18);
    expect(v.costDebt).toBe(0.065);
    expect(v.equityWeight).toBe(0.7);
    expect(v.debtWeight).toBe(0.3);
    expect(v.taxRate).toBe(0.17);
    expect(v.renewalEnabled).toBe(false);
    expect(v.renewalMonths).toBe(24);
  });

  it('D7A: an explicit stored rate is never overwritten by the default', async () => {
    const owner = await createOperator('OWNER');
    await api.put(`${CMS}/settings`).set('Authorization', owner.auth).send({
      'finance.leaseHorizon.rollout': 'all',
      'finance.leaseHorizon.returns': 'on',
    });
    const branch = await makeBranch();
    const model = await makeModel(owner.auth, branch.id, {
      valuation: { ...DEFAULT_VALUATION_ASSUMPTIONS, methodology: 'manual', manualAnnualRate: 0.08 },
    });
    const got = await api.get(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth);
    expect(got.status).toBe(200);
    expect(got.body.data.valuation.manualAnnualRate).toBe(0.08);
    expect(got.body.data.valuation.effectiveAnnualRate).toBe(0.08);
  });
});

// Lease-horizon round-2 regression tests (browser check 2026-11-10,
// docs/finance/lease-horizon-evidence/08-parity-fixes/WP-2-4-browser-check.md).
//
// - Bug 5: discounted payback interpolates on the DISCOUNTED row flow, as the
//   prototype's npv-engine paybackPeriod does. Before the fix the engine
//   divided by the undiscounted flow: Downside showed Month 49 + 6 days and
//   Upside Month 32 + 7 days; prototype v36 shows Month 49 + 11 days and
//   Month 32 + 10 days. NPV, IRR and simple payback are unchanged.
// - Bug 7: the DCF export file name identifies model version, rate and
//   methodology.
// - Bug 9: the WACC error names only the missing inputs.
// UI-only items (sensitivity default/Add/slider, Audit history buttons) are
// browser-verified; see the evidence doc.

import { describe, expect, it, beforeEach } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';
import { upcastInputs } from '../../src/core/finance/leaseTerm';
import { project, type ProjectionInput } from '../../src/core/finance/projection';
import { analyse, buildCashFlowSeries, effectiveAnnualRate, type ValuationInputs } from '../../src/core/finance/valuation';
import { committedScenarioInputs } from '../../src/core/finance/returns';
import fixture from './fixtures/finance-lease-horizon-validation.json';

const CMS = '/api/v1/cms';

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

describe('round2 bug 5: scenario discounted payback matches prototype v36', () => {
  const valuation = (fixture as unknown as { valued: Record<string, { valuation: ValuationInputs }> }).valued.sembawang60.valuation;
  const run = (s: 'downside' | 'base' | 'upside') =>
    analyse(buildCashFlowSeries(project(committedScenarioInputs(v2InputFor('sembawang60'), s)), valuation), 0.15);

  it('Downside: Month 49 + 11 days (was Month 49 + 6 days)', () => {
    const a = run('downside');
    expect(a.discountedPayback.label).toBe('Month 49 + 11 days');
    // −S$1,337.08 cumulative after period 49, +S$3,582.05 discounted in 50.
    expect(a.discountedPayback.fractionalMonths as number).toBeCloseTo(49 + 1337.08 / 3582.05, 3);
    expect(a.simplePayback.label).toBe('Month 39 + 18 days');
    expect(Math.round(a.npv)).toBe(35862);
  });

  it('Base: Month 38 (label unchanged)', () => {
    const a = run('base');
    expect(a.discountedPayback.label).toBe('Month 38');
    expect(a.simplePayback.label).toBe('Month 31 + 19 days');
  });

  it('Upside: Month 32 + 10 days (was Month 32 + 7 days)', () => {
    const a = run('upside');
    expect(a.discountedPayback.label).toBe('Month 32 + 10 days');
    expect(a.simplePayback.label).toBe('Month 27 + 14 days');
  });
});

describe('round2 bug 9: WACC error names only the missing inputs', () => {
  it('one missing input', () => {
    expect(() => effectiveAnnualRate({ methodology: 'wacc', costEquity: 0.18, costDebt: null, equityWeight: 0.7, debtWeight: 0.3, taxRate: 0.17 } as never))
      .toThrow('WACC needs cost of debt — enter it or use the manual rate.');
  });
  it('several missing inputs', () => {
    expect(() => effectiveAnnualRate({ methodology: 'wacc', costEquity: null, costDebt: 0.065, equityWeight: 0.7, debtWeight: 0.3, taxRate: null } as never))
      .toThrow('WACC needs cost of equity and tax rate — enter them or use the manual rate.');
  });
});

describe('round2 bug 7: DCF export file name identifies version, rate and methodology', () => {
  beforeEach(resetDb);

  it('financial-model-<id>-v<version>-<rate>pct-<methodology>-dcf.csv', async () => {
    const owner = await createOperator('OWNER');
    const s = await api.put(`${CMS}/settings`).set('Authorization', owner.auth)
      .send({ 'finance.leaseHorizon.rollout': 'all', 'finance.leaseHorizon.returns': 'on' });
    expect(s.status).toBe(200);
    const branch = await prisma.branch.create({
      data: { code: `LH${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: 'Lease Horizon R2', address: 'Admirax', operatingHours: '9-9' },
    });
    const m = await api.post(`${CMS}/finance/models`).set('Authorization', owner.auth).send({ name: 'LH R2', branchId: branch.id });
    expect(m.status).toBe(201);
    const id = m.body.data.id as string;
    const schedule = Array.from({ length: 5 }, (_, i) => ({ leaseYear: i + 1, monthlyRent: 5000, source: 'contract', confirmed: true }));
    const lease = await api.put(`${CMS}/finance/models/${id}/landlord-lease`).set('Authorization', owner.auth)
      .send({ version: 0, leaseStartDate: '2026-12-01', committedTermMonths: 60, prorationMethod: 'actual_days', currency: 'SGD', ufaSqft: 3068, schedule });
    expect(lease.status).toBe(200);
    const res = await api.get(`${CMS}/finance/models/${id}/export.csv?format=dcf`).set('Authorization', owner.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="financial-model-${id}-v1-15pct-manual-dcf.csv"`);
    // Columns unchanged (handoff §8.3 / WP-4 assertions).
    expect(res.text.split('\n')[0]).toBe('month_or_date_range,period_months,revenue_sgd,operating_cash_flow_sgd,capex_sgd,other_cash_flows_sgd,net_free_cash_flow_sgd,discount_factor,discounted_cash_flow_sgd,cumulative_dcf_sgd');
  });
});

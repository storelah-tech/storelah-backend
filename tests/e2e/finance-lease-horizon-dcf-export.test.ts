// Lease-horizon P7 DCF export tests — the `?format=dcf` reuse variant on the
// existing month-table export route (no new route, no new permission surface).
// New file; no existing test is modified.
//
// Covers: §8.3 column set + exact date-range/Period binding from the ONE
// committed series, audit trail parity with the month-table export, stale
// (FAILED) blocking per handoff §8.5, and backward compatibility of the
// default months format.
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';

const CMS = '/api/v1/cms';

function sched(years: number, rent = 5000, source = 'contract', confirmed = true) {
  return Array.from({ length: years }, (_, i) => ({ leaseYear: i + 1, monthlyRent: rent, source, confirmed }));
}

async function makeBranch() {
  return prisma.branch.create({
    data: { code: `LH${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: 'Lease Horizon E2E', address: 'Admirax', operatingHours: '9-9' },
  });
}

async function makeModel(auth: string, branchId?: string) {
  const res = await api.post(`${CMS}/finance/models`).set('Authorization', auth).send({ name: 'LH DCF Model', ...(branchId ? { branchId } : {}) });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; version: number };
}

async function ownerWorld() {
  const owner = await createOperator('OWNER');
  const res = await api.put(`${CMS}/settings`).set('Authorization', owner.auth).send({
    'finance.leaseHorizon.rollout': 'all',
    'finance.leaseHorizon.returns': 'on',
  });
  expect(res.status).toBe(200);
  const branch = await makeBranch();
  const model = await makeModel(owner.auth, branch.id);
  return { owner, branch, model };
}

describe('lease-horizon P7: DCF export variant (?format=dcf)', () => {
  beforeEach(resetDb);

  it('serves the §8.3 column set from the committed series at the stored rate', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.get(`${CMS}/finance/models/${model.id}/export.csv?format=dcf`).set('Authorization', owner.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/-dcf\.csv/);
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe(
      'month_or_date_range,period_months,revenue_sgd,operating_cash_flow_sgd,capex_sgd,other_cash_flows_sgd,net_free_cash_flow_sgd,discount_factor,discounted_cash_flow_sgd,cumulative_dcf_sgd',
    );
    const returns = await api.get(`${CMS}/finance/returns?modelId=${model.id}`).set('Authorization', owner.auth);
    expect(returns.status).toBe(200);
    const committed = returns.body.data.committed as {
      modelVersion: number;
      annualRate: number;
      npv: number;
      dcf: Array<{ month: string; periodLabel: string; netCashFlow: number; cumulativeDiscountedCashFlow: number; display: { cumulativeDiscountedCashFlow: number } }>;
    };
    // Same revision, same rows: t=0 plus one row per committed month.
    expect(lines.length - 1).toBe(committed.dcf.length);
    // t=0 binds the server commencement date at period 0.
    expect(lines[1].split(',')[0]).toBe(committed.dcf[0].month);
    expect(lines[1].split(',')[1]).toBe('0');
    // The closing row reconciles to the committed NPV from the same array;
    // the CSV carries the SGD-cents display value (D12A: round only display).
    const last = committed.dcf[committed.dcf.length - 1];
    expect(last.cumulativeDiscountedCashFlow).toBeCloseTo(committed.npv, 6);
    expect(lines[lines.length - 1].split(',')[9]).toBe(String(last.display.cumulativeDiscountedCashFlow));
  });

  it('is audited with the DCF reason, like the month-table export', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.get(`${CMS}/finance/models/${model.id}/export.csv?format=dcf`).set('Authorization', owner.auth);
    expect(res.status).toBe(200);
    const audits = await prisma.financeAuditEvent.findMany({
      where: { action: 'EXPORT_GENERATED', entityId: model.id },
    });
    const dcf = audits.filter((a) => (a.after as { reason?: string } | null) !== null && JSON.stringify(a.after).includes('dcf-export-csv'));
    expect(dcf.length).toBe(1);
    expect(dcf[0]).toMatchObject({ reason: 'Model DCF export', source: 'cms' });
  });

  it('default (no format) still serves the month table — backward compatible', async () => {
    const { owner, model } = await ownerWorld();
    const res = await api.get(`${CMS}/finance/models/${model.id}/export.csv`).set('Authorization', owner.auth);
    expect(res.status).toBe(200);
    expect(res.text.split('\n')[0]).toMatch(/^month,opening_sqft/);
  });

  it('stale (FAILED) revisions block the DCF export until retry succeeds (§8.5)', async () => {
    const { owner, model } = await ownerWorld();
    // Incomplete WACC saves fine but fails the compute step (LH17 fixture).
    const wacc = await api
      .put(`${CMS}/finance/models/${model.id}/valuation`)
      .set('Authorization', owner.auth)
      .send({ version: 0, methodology: 'wacc', renewalEnabled: false, includeTerminalCashFlows: false });
    expect(wacc.status).toBe(200);
    expect(wacc.body.data.model.calculationStatus).toBe('FAILED');
    const blocked = await api.get(`${CMS}/finance/models/${model.id}/export.csv?format=dcf`).set('Authorization', owner.auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/Returns are out of date/);
    // Completing the financing inputs + recalculating reopens the export.
    const fixed = await api
      .put(`${CMS}/finance/models/${model.id}/valuation`)
      .set('Authorization', owner.auth)
      .send({
        version: 1, methodology: 'wacc', costEquity: 0.12, costDebt: 0.05, equityWeight: 0.6, debtWeight: 0.4, taxRate: 0.17,
        renewalEnabled: false, includeTerminalCashFlows: false,
      });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.model.calculationStatus).toBe('CURRENT');
    const ok = await api.get(`${CMS}/finance/models/${model.id}/export.csv?format=dcf`).set('Authorization', owner.auth);
    expect(ok.status).toBe(200);
  });
});

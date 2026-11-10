// Lease-horizon WP-4 tests — the areas §07-5 left uncovered: the full
// per-role matrix across Sections 4–5 + Returns + export (owner D9B), stale
// submit/approve blocking (handoff §8.5), and mid-month DCF file contents
// (§8.3: columns, Period + dates, cents, closing part-month row, committed vs
// renewal separation). New file; no existing test is modified.
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
  const res = await api.post(`${CMS}/finance/models`).set('Authorization', auth).send({ name: 'LH WP4 Model', ...(branchId ? { branchId } : {}) });
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
  return { owner, branch };
}

async function roleWith(auth: string, name: string, permissions: string[]) {
  const res = await api.post(`${CMS}/roles`).set('Authorization', auth).send({ name, permissions });
  expect(res.status).toBe(201);
  return createOperator(res.body.data.id);
}

describe('lease-horizon WP-4: per-role matrix for Sections 4-5, Returns and export (D9B)', () => {
  beforeEach(resetDb);

  it('Returns read + DCF export follow bill-returns:view / bill-models:view independently of lease-edit rights', async () => {
    const { owner, branch } = await ownerWorld();
    const model = await makeModel(owner.auth, branch.id);
    const manager = await createOperator('MANAGER');
    const operator = await createOperator('FINANCE_OPERATOR');
    const approver = await createOperator('FINANCE_APPROVER');
    const viewer = await createOperator('VIEWER');
    const leaseOnly = await roleWith(owner.auth, 'Lease viewer', ['bill-lease:view']);
    const returnsOnly = await roleWith(owner.auth, 'Returns viewer', ['bill-returns:view']);
    const modelsOnly = await roleWith(owner.auth, 'Models viewer', ['bill-models:view']);

    const getReturns = (auth: string) => api.get(`${CMS}/finance/returns?modelId=${model.id}`).set('Authorization', auth);
    const getDcf = (auth: string) => api.get(`${CMS}/finance/models/${model.id}/export.csv?format=dcf`).set('Authorization', auth);

    // Full-finance roles read Returns and export DCF.
    expect((await getReturns(owner.auth)).status).toBe(200);
    expect((await getDcf(owner.auth)).status).toBe(200);
    expect((await getReturns(operator.auth)).status).toBe(200);
    expect((await getDcf(operator.auth)).status).toBe(200);
    expect((await getReturns(approver.auth)).status).toBe(200);
    expect((await getDcf(approver.auth)).status).toBe(200);

    // Manager holds bill-lease:update but neither bill-returns:view nor
    // bill-models:view — Returns and both exports stay 403 (recorded as an
    // owner question in WP-4: D9B "Manager: view" vs the seeded matrix).
    expect((await getReturns(manager.auth)).status).toBe(403);
    expect((await getDcf(manager.auth)).status).toBe(403);

    // Viewer hidden by default; a lease-only grant does not open Returns.
    expect((await getReturns(viewer.auth)).status).toBe(403);
    expect((await getDcf(viewer.auth)).status).toBe(403);
    expect((await getReturns(leaseOnly.auth)).status).toBe(403);
    expect((await getDcf(leaseOnly.auth)).status).toBe(403);

    // Split grants stay split: Returns without model-export rights reads the
    // screen but cannot export (the UI disables Export DCF); model rights
    // without Returns rights export but cannot open the screen.
    expect((await getReturns(returnsOnly.auth)).status).toBe(200);
    expect((await getDcf(returnsOnly.auth)).status).toBe(403);
    expect((await getReturns(modelsOnly.auth)).status).toBe(403);
    expect((await getDcf(modelsOnly.auth)).status).toBe(200);
  });

  it('Section 5 writes + Retry follow bill-lease:update (Manager yes, Operator no)', async () => {
    const { owner, branch } = await ownerWorld();
    const manager = await createOperator('MANAGER');
    const operator = await createOperator('FINANCE_OPERATOR');
    const approver = await createOperator('FINANCE_APPROVER');
    const viewer = await createOperator('VIEWER');

    const valuation = (version: number) => ({
      version,
      methodology: 'manual',
      manualAnnualRate: 0.12,
      renewalEnabled: false,
      includeTerminalCashFlows: false,
    });

    // Fresh model per writer (version CAS starts at 0).
    for (const [who, auth, want] of [
      ['owner', owner.auth, 200],
      ['manager', manager.auth, 200],
      ['operator', operator.auth, 403],
      ['approver', approver.auth, 200],
      ['viewer', viewer.auth, 403],
    ] as const) {
      const m = await makeModel(owner.auth, branch.id);
      const res = await api.put(`${CMS}/finance/models/${m.id}/valuation`).set('Authorization', auth).send(valuation(0));
      expect(res.status, `valuation PUT as ${who}`).toBe(want);
      if (want === 200) expect(res.body.data.model.calculationStatus).toBe('CURRENT');
    }

    for (const [who, auth, want] of [
      ['manager', manager.auth, 200],
      ['operator', operator.auth, 403],
      ['viewer', viewer.auth, 403],
    ] as const) {
      const m = await makeModel(owner.auth, branch.id);
      const res = await api.post(`${CMS}/finance/models/${m.id}/recalculate`).set('Authorization', auth).send({});
      expect(res.status, `recalculate as ${who}`).toBe(want);
    }
  });

  it('stale (FAILED) revisions block submit; retry reopens it (§8.5)', async () => {
    const { owner, branch } = await ownerWorld();
    const manager = await createOperator('MANAGER');
    const model = await makeModel(owner.auth, branch.id);

    // Incomplete WACC saves fine but fails the compute step (LH17 fixture).
    const wacc = await api
      .put(`${CMS}/finance/models/${model.id}/valuation`)
      .set('Authorization', owner.auth)
      .send({ version: 0, methodology: 'wacc', renewalEnabled: false, includeTerminalCashFlows: false });
    expect(wacc.status).toBe(200);
    expect(wacc.body.data.model.calculationStatus).toBe('FAILED');

    const blocked = await api.post(`${CMS}/finance/library/${model.id}/submit`).set('Authorization', manager.auth).send({ version: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/Retry calculation before submitting or approving/);

    // Completing the financing inputs + recalculating reopens submit.
    const fixed = await api
      .put(`${CMS}/finance/models/${model.id}/valuation`)
      .set('Authorization', owner.auth)
      .send({ version: 1, methodology: 'wacc', costEquity: 0.12, costDebt: 0.05, equityWeight: 0.6, debtWeight: 0.4, taxRate: 0.17, renewalEnabled: false, includeTerminalCashFlows: false });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.model.calculationStatus).toBe('CURRENT');
    const submitted = await api.post(`${CMS}/finance/library/${model.id}/submit`).set('Authorization', manager.auth).send({ version: 2 });
    expect(submitted.status).toBe(200);
  });
});

describe('lease-horizon WP-4: mid-month DCF file contents (§8.3)', () => {
  beforeEach(resetDb);

  it('columns, Period + dates, cents, closing part-month row, committed-only rows', async () => {
    const { owner, branch } = await ownerWorld();
    const model = await makeModel(owner.auth, branch.id);
    // Mid-month on both dates (the §07 evidence-doc case): operational start
    // moves via the inputs section, the lease via the governed section.
    const before0 = await api.get(`${CMS}/finance/models/${model.id}`).set('Authorization', owner.auth);
    expect(before0.status).toBe(200);
    const moveOps = await api
      .put(`${CMS}/finance/models/${model.id}/inputs`)
      .set('Authorization', owner.auth)
      .send({ version: 0, patch: { startDate: '2026-12-15', nlaSqft: before0.body.data.inputs.nlaSqft } });
    expect(moveOps.status).toBe(200);
    const put = await api
      .put(`${CMS}/finance/models/${model.id}/landlord-lease`)
      .set('Authorization', owner.auth)
      .send(leaseBody(1, { leaseStartDate: '2026-12-15', committedTermMonths: 12, schedule: sched(1) }));
    expect(put.status).toBe(200);
    const version = put.body.data.model.version as number;

    const res = await api.get(`${CMS}/finance/models/${model.id}/export.csv?format=dcf`).set('Authorization', owner.auth);
    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe(
      'month_or_date_range,period_months,revenue_sgd,operating_cash_flow_sgd,capex_sgd,other_cash_flows_sgd,net_free_cash_flow_sgd,discount_factor,discounted_cash_flow_sgd,cumulative_dcf_sgd',
    );

    const returns = await api.get(`${CMS}/finance/returns?modelId=${model.id}`).set('Authorization', owner.auth);
    expect(returns.status).toBe(200);
    const committed = returns.body.data.committed as {
      modelVersion: number;
      dcf: Array<{ month: string; periodLabel: string }>;
    };
    // t=0 plus one row per committed month: 12-month mid-month term → 14 rows.
    expect(lines.length - 1).toBe(committed.dcf.length);
    expect(committed.dcf.length).toBe(14);

    // t=0 binds the commencement date at period 0.
    expect(lines[1].split(',')[0]).toBe('2026-12-15');
    expect(lines[1].split(',')[1]).toBe('0');

    // Opening stub carries exact dates + running-sum period (17/31 = 0.548).
    const opening = lines[2].split(',');
    expect(opening[0]).toBe('2026-12-15→2026-12-31');
    expect(opening[1]).toBe('0.548');

    // Closing part-month row carries exact dates at period 12.
    const closing = lines[lines.length - 1].split(',');
    expect(closing[0]).toBe('2027-12-01→2027-12-14');
    expect(closing[1]).toBe('12');

    // Money cells are SGD-cents values; discount factors at 7dp (§7.7).
    const cents = (s: string) => {
      const v = Number(s);
      return Number.isFinite(v) && Math.abs(v - Math.round(v * 100) / 100) < 1e-9;
    };
    for (const line of lines.slice(1)) {
      const c = line.split(',');
      expect(c).toHaveLength(10);
      for (const cell of c.slice(2, 7)) expect(cents(cell), `cents: ${cell} in ${line}`).toBe(true);
      // Discount factor at 7dp (§7.7): the CSV carries the numeric value
      // (t=0 writes `1`, the UI pads with toFixed(7)) — assert 7dp rounding.
      const df = Number(c[7]);
      expect(Number.isFinite(df), `df: ${c[7]} in ${line}`).toBe(true);
      expect(Math.abs(df - Math.round(df * 1e7) / 1e7) < 1e-12, `df 7dp: ${c[7]} in ${line}`).toBe(true);
      for (const cell of [c[8], c[9]]) expect(cents(cell), `cents: ${cell} in ${line}`).toBe(true);
    }

    // Committed vs renewal separation: enabling renewal leaves the file
    // byte-identical (renewal is a separate comparison case, R13).
    const before = res.text;
    const renewal = await api
      .put(`${CMS}/finance/models/${model.id}/valuation`)
      .set('Authorization', owner.auth)
      .send({ version, methodology: 'manual', manualAnnualRate: 0.15, renewalEnabled: true, renewalMonths: 24, includeTerminalCashFlows: false });
    expect(renewal.status).toBe(200);
    const again = await api.get(`${CMS}/finance/models/${model.id}/export.csv?format=dcf`).set('Authorization', owner.auth);
    expect(again.status).toBe(200);
    expect(again.text).toBe(before);
    const returns2 = await api.get(`${CMS}/finance/returns?modelId=${model.id}`).set('Authorization', owner.auth);
    expect(returns2.body.data.committed.renewal).toBeDefined();
  });
});

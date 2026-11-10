// Lease-horizon P5 consumer tests — downstream readers consume the committed
// engine result (no new routes, no migrations, no approved-model writes).
//
// Covers LH11 (lease counted ONCE through budgets total), LH12-server
// (committed block: NPV/IRR/both paybacks/cumulative/PI/DCF refresh to the
// same model version), LH16 (a draft's own horizon in Returns/library) on a
// 36-month first-of-month model + a 15-Dec mid-month model. R14 stays green
// via the UNMODIFIED golden suite (finance-projection.test.ts); this file
// additionally pins the legacy fallback shape when the rollout is off.
//
// PDF assertions are programmatic (bytes header + labels + data-level figures;
// visual review is P8).

import { beforeEach, describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { api, createOperator, prisma, resetDb } from './fixtures';
import { project } from '../../src/core/finance/projection';
import { buildCashFlowSeries, analyse } from '../../src/core/finance/valuation';
import { computeActuals, getPerformance } from '../../src/core/finance/monthClose';
import { getReturns } from '../../src/core/finance/returns';
import { listLibrary } from '../../src/core/finance/library';
import { buildFinanceReport } from '../../src/core/finance/report';
import { buildFinanceReportPdf } from '../../src/core/finance/reportPdf';
import { getInvestorSummary, investorSummaryCsv } from '../../src/core/finance/investor';
import { buildProjectionReport } from '../../src/core/finance/projectionReport';
import { buildProjectionReportPdf } from '../../src/core/finance/projectionReportPdf';

const CMS = '/api/v1/cms';
const pdfHead = (b: Buffer) => b.subarray(0, 5).toString();

/**
 * Programmatic PDF label assertion: pdf-lib compresses page content with
 * FlateDecode and encodes drawn text as hex strings, so raw bytes never
 * contain the labels. This inflates every compressed stream, decodes the hex
 * text-show operations and returns the searchable text. (Visual review is P8;
 * every number here is additionally asserted at the data level above.)
 */
function pdfDecodedText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const parts: string[] = [raw];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    try {
      parts.push(inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'));
    } catch {
      // Not a deflated stream — the raw copy above already covers it.
    }
  }
  const joined = parts.join('\n');
  const out: string[] = [];
  const hex = /<([0-9A-Fa-f]+)>/g;
  let h: RegExpExecArray | null;
  while ((h = hex.exec(joined))) {
    const digits = h[1].length % 2 === 0 ? h[1] : h[1].slice(0, -1);
    out.push(Buffer.from(digits, 'hex').toString('latin1'));
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

function sched(years: number, rent = 5000) {
  return Array.from({ length: years }, (_, i) => ({ leaseYear: i + 1, monthlyRent: rent, source: 'contract', confirmed: true }));
}

function leaseBody(version: number, overrides: Record<string, unknown> = {}) {
  return {
    version,
    leaseStartDate: '2026-12-01',
    committedTermMonths: 36,
    prorationMethod: 'actual_days',
    currency: 'SGD',
    ufaSqft: 3068,
    schedule: sched(3),
    ...overrides,
  };
}

async function makeBranch(prefix: string) {
  return prisma.branch.create({
    data: { code: `${prefix}${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: `LH Consumers ${prefix}`, address: 'Admirax', operatingHours: '9-9' },
  });
}

async function makeModel(auth: string, branchId: string) {
  const res = await api.post(`${CMS}/finance/models`).set('Authorization', auth).send({ name: 'LH Consumer Model', branchId });
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

async function setCurrent(modelId: string) {
  await prisma.financialModel.update({ where: { id: modelId }, data: { status: 'CURRENT' } });
}

/** 36-month first-of-month model + 15-Dec mid-month model, both CURRENT. */
async function consumerWorld() {
  const owner = await createOperator('OWNER');
  await enableRollout(owner.auth);
  const branchA = await makeBranch('CA');
  const branchB = await makeBranch('CB');
  const a = await makeModel(owner.auth, branchA.id);
  const putA = await api.put(`${CMS}/finance/models/${a.id}/landlord-lease`).set('Authorization', owner.auth).send(leaseBody(0));
  expect(putA.status).toBe(200);
  const b = await makeModel(owner.auth, branchB.id);
  // Mid-month commencement: move the operational start to the lease start so
  // the timeline opens with the 17-day stub (handoff §1 example).
  const moved = await api.put(`${CMS}/finance/models/${b.id}/inputs`).set('Authorization', owner.auth).send({
    version: 0, patch: { startDate: '2026-12-15' },
  });
  expect(moved.status).toBe(200);
  const putB = await api.put(`${CMS}/finance/models/${b.id}/landlord-lease`).set('Authorization', owner.auth)
    .send(leaseBody(1, { leaseStartDate: '2026-12-15' }));
  expect(putB.status).toBe(200);
  await setCurrent(a.id);
  await setCurrent(b.id);
  const freshA = await prisma.financialModel.findUniqueOrThrow({ where: { id: a.id } });
  const freshB = await prisma.financialModel.findUniqueOrThrow({ where: { id: b.id } });
  return { owner, branchA, branchB, modelA: { ...a, version: freshA.version }, modelB: { ...b, version: freshB.version } };
}

describe('lease-horizon P5 consumers', () => {
  beforeEach(resetDb);

  it('LH11: budgets counts the committed lease ONCE in total operating cost', async () => {
    const { owner, branchA, branchB } = await consumerWorld();
    for (const branch of [branchA, branchB]) {
      const created = await api.post(`${CMS}/finance/budgets`).set('Authorization', owner.auth).send({
        branchId: branch.id, fiscalMonth: '2026-12', category: 'Utilities', amount: 400,
      });
      expect(created.status).toBe(201);
    }

    // First-of-month: full schedule rent; total = lease + non-lease opex, once.
    const resA = await api.get(`${CMS}/finance/budgets?branchId=${branchA.id}&fiscalMonth=2026-12`).set('Authorization', owner.auth);
    expect(resA.status).toBe(200);
    expect(resA.body.data.lease.amount).toBe(5000);
    expect(resA.body.data.summary.otherOpex).toBe(400);
    expect(resA.body.data.summary.totalOperating).toBe(5400);

    // Mid-month: the opening stub is prorated from the engine row (17/31).
    const resB = await api.get(`${CMS}/finance/budgets?branchId=${branchB.id}&fiscalMonth=2026-12`).set('Authorization', owner.auth);
    expect(resB.status).toBe(200);
    expect(resB.body.data.lease.amount).toBeCloseTo(2741.94, 2);
    expect(resB.body.data.summary.totalOperating).toBeCloseTo(3141.94, 2);

    // Zero after the committed end; null before the model start.
    const after = await api.get(`${CMS}/finance/budgets?branchId=${branchA.id}&fiscalMonth=2030-06`).set('Authorization', owner.auth);
    expect(after.body.data.lease.amount).toBe(0);
    expect(after.body.data.summary.totalOperating).toBe(0);
    const before = await api.get(`${CMS}/finance/budgets?branchId=${branchA.id}&fiscalMonth=2026-10`).set('Authorization', owner.auth);
    expect(before.body.data.lease.amount).toBeNull();
    expect(before.body.data.summary.totalOperating).toBeNull();
  });

  it('LH12-server: committed block reads the ONE P3 array at the stored rate', async () => {
    const { modelA, modelB } = await consumerWorld();

    for (const [model, endDate, rows] of [
      [modelA, '2029-11-30', 36],
      [modelB, '2029-12-14', 37],
    ] as const) {
      const r = await getReturns({ modelId: model.id, horizonYears: 5 });
      const c = r.committed;
      expect(c).toBeDefined();
      expect(c).not.toHaveProperty('valuationError');
      const ok = c as unknown as {
        modelVersion: number; annualRate: number; annualRateSource: string;
        committedEndDate: string; committedMonths: number; npv: number;
        cumulativeFreeCashFlow: number; profitabilityIndex: number | null;
        simplePayback: { label: string }; discountedPayback: { label: string };
        irr: { display: string }; dcf: Array<{ cumulativeDiscountedCashFlow: number }>;
        limitation: string;
      };
      // Rate identified on every output (D7A); keyed to the model version.
      expect(ok.annualRate).toBe(0.15);
      expect(ok.annualRateSource).toBe('manual');
      expect(ok.modelVersion).toBe(model.version);
      expect(ok.committedEndDate).toBe(endDate);
      expect(ok.committedMonths).toBe(36);
      expect(ok.dcf).toHaveLength(rows + 1); // t=0 + monthly rows
      expect(ok.limitation).toMatch(/R11/);
      // DCF reconciles to NPV from the same array; paybacks are labelled.
      expect(ok.dcf[ok.dcf.length - 1].cumulativeDiscountedCashFlow).toBeCloseTo(ok.npv, 6);
      expect(typeof ok.simplePayback.label).toBe('string');
      expect(typeof ok.discountedPayback.label).toBe('string');
      expect(typeof ok.irr.display).toBe('string');
      expect(typeof ok.cumulativeFreeCashFlow).toBe('number');
    }

    // Truncated slices stay supplementary — never "Project NPV" (§8.4).
    const r = await getReturns({ modelId: modelA.id, horizonYears: 5 });
    expect(r.npv.label).toBe('NPV through Year 5');
  });

  it('LH12-server: extending the term refreshes the committed block to the new version', async () => {
    // Own draft world: CURRENT models fork on landlord-lease edit (D4A), so
    // the refresh path is exercised on the editable draft itself.
    const owner = await createOperator('OWNER');
    await enableRollout(owner.auth);
    const branch = await makeBranch('RF');
    const m = await makeModel(owner.auth, branch.id);
    const first = await api.put(`${CMS}/finance/models/${m.id}/landlord-lease`).set('Authorization', owner.auth).send(leaseBody(0));
    expect(first.status).toBe(200);
    const before = await getReturns({ modelId: m.id });
    const beforeNpv = (before.committed as unknown as { npv: number }).npv;

    const upd = await api.put(`${CMS}/finance/models/${m.id}/landlord-lease`).set('Authorization', owner.auth)
      .send(leaseBody(1, { committedTermMonths: 48, schedule: sched(4) }));
    expect(upd.status).toBe(200);
    const stored = await prisma.financialModel.findUniqueOrThrow({ where: { id: m.id } });
    expect(upd.body.data.model.version).toBe(stored.version);

    const after = await getReturns({ modelId: m.id });
    const c = after.committed as unknown as { modelVersion: number; inputHash: string; committedEndDate: string; committedMonths: number; npv: number };
    expect(c.modelVersion).toBe(stored.version);
    expect(stored.inputHash).toBe(c.inputHash);
    expect(c.committedEndDate).toBe('2030-11-30');
    expect(c.committedMonths).toBe(48);
    expect(c.npv).not.toBe(beforeNpv);
  });

  it('LH16: Returns and library use each draft\u2019s own horizon', async () => {
    const { modelA, modelB, branchA, branchB } = await consumerWorld();
    const rA = await getReturns({ modelId: modelA.id });
    const rB = await getReturns({ modelId: modelB.id });
    const cA = rA.committed as unknown as { committedEndDate: string; committedMonths: number };
    const cB = rB.committed as unknown as { committedEndDate: string; committedMonths: number };
    // Same contractual term, different exact boundaries — no leak either way.
    expect(cA.committedEndDate).toBe('2029-11-30');
    expect(cB.committedEndDate).toBe('2029-12-14');
    expect(cA.committedMonths).toBe(36);
    expect(cB.committedMonths).toBe(36);

    const libA = await listLibrary({ branchId: branchA.id });
    const libB = await listLibrary({ branchId: branchB.id });
    expect(libA).toHaveLength(1);
    expect(libB).toHaveLength(1);
    const hA = libA[0].headline.committed as unknown as { committedEndDate: string; npv: number };
    const hB = libB[0].headline.committed as unknown as { committedEndDate: string; npv: number };
    expect(hA.committedEndDate).toBe('2029-11-30');
    expect(hB.committedEndDate).toBe('2029-12-14');
    // Headline committed NPV matches the returns committed NPV (one series).
    expect(hA.npv).toBe((cA as unknown as { npv: number }).npv);
    expect(hB.npv).toBe((cB as unknown as { npv: number }).npv);
    // Legacy headline fields still present (fallback shape intact).
    expect(libA[0].headline).toMatchObject({ irrAnnualised: expect.anything(), paybackMonth: expect.anything() });
  });

  it('monthClose actuals + performance budget read the committed engine rows', async () => {
    const { branchA } = await consumerWorld();
    const actuals = await computeActuals(branchA.id, '2026-12');
    expect(actuals.lines.find((l) => l.metric === 'LEASE')).toMatchObject({ value: 5000, source: 'approved-schedule' });
    const pre = await computeActuals(branchA.id, '2026-10');
    expect(pre.lines.find((l) => l.metric === 'LEASE')).toMatchObject({ value: 0, source: 'pre-model-start' });
    const post = await computeActuals(branchA.id, '2030-06');
    expect(post.lines.find((l) => l.metric === 'LEASE')).toMatchObject({ value: 0, source: 'approved-schedule' });

    const perf = await getPerformance(branchA.id, '2026-12');
    expect(perf.rows.find((r) => r.metric === 'LEASE')).toMatchObject({ budget: 5000 });
    // Forecast still comes from the engine row (pre-existing scale preserved).
    const stored = await prisma.financialModel.findFirstOrThrow({ where: { branchId: branchA.id, status: 'CURRENT' } });
    const engine = project(stored.inputs as unknown as Parameters<typeof project>[0]);
    const row = engine.months.find((m) => m.month === '2026-12');
    expect(perf.rows.find((r) => r.metric === 'LEASE')!.forecast).toBeCloseTo((row as { opexLease: number }).opexLease / 100, 2);
  });

  it('projection report: Year-N lease table + committed valuation + corrected labels', async () => {
    const { modelA } = await consumerWorld();
    const r = await buildProjectionReport({ modelId: modelA.id, generatedBy: 'P5 test' });
    // Committed schedule drives the Year-N lease table.
    expect(r.leaseSchedule).toHaveLength(3);
    expect(r.leaseSchedule![0]).toMatchObject({ leaseYear: 1, periodStart: '2026-12-01', periodEnd: '2027-11-30', monthlyRent: 5000 });
    expect(r.years[0].lease).toBeCloseTo(60000, 2);
    // Truncated returns are labelled as views, never Project NPV/IRR.
    expect(r.returns.npvLabel).toBe('NPV through Year 3');
    expect(r.returns.discountRateSource).toBe('manual');
    // Committed block present at the stored rate.
    expect(r.committed).toBeDefined();
    const c = r.committed as unknown as { annualRate: number; committedMonths: number; dcf: unknown[] };
    expect(c.annualRate).toBe(0.15);
    expect(c.committedMonths).toBe(36);

    const pdf = await buildProjectionReportPdf(r);
    expect(pdfHead(pdf)).toBe('%PDF-');
    const text = pdfDecodedText(pdf);
    expect(text).toContain('Project NPV');
    expect(text).toContain('NPV through Year 3');
    expect(text).toContain('Committed project valuation');
  });

  it('finance report + investor summary: committed figures with the rate identified', async () => {
    const { branchA } = await consumerWorld();
    const from = new Date(Date.UTC(2026, 11, 1));
    const to = new Date(Date.UTC(2026, 11, 31));
    const report = await buildFinanceReport({
      from, to, branchId: branchA.id, generatedBy: 'P5 test',
      sections: ['model', 'returns'],
    });
    const row = report.returns![0];
    expect(row.valuationRate).toBe(0.15);
    expect(row.valuationRateSource).toBe('manual');
    expect(row.npvLabel).toBe('Project NPV (36-month committed term)');
    expect(row.committedMonths).toBe(36);
    expect(row.committedEndDate).toBe('2029-11-30');
    const fm = report.model![0];
    expect(fm.model!.valuation).toMatchObject({ annualRate: 0.15, annualRateSource: 'manual', committedMonths: 36 });
    expect(fm.model!.leaseSchedule).toHaveLength(3);

    const pdf = await buildFinanceReportPdf(report);
    expect(pdfHead(pdf)).toBe('%PDF-');
    const text = pdfDecodedText(pdf);
    expect(text).toContain('Investment returns');
    expect(text).toContain('Project NPV (36-month committed term)');

    const summary = await getInvestorSummary({ branchId: branchA.id });
    expect(summary.returns.npvLabel).toBe('Project NPV (36-month committed term)');
    expect(summary.returns.npvDiscountRatePct).toBe(15);
    expect(summary.returns.valuationRateSource).toBe('manual');
    expect(summary.returns.committedMonths).toBe(36);
    expect(summary.returns.committedEndDate).toBe('2029-11-30');
    const csv = investorSummaryCsv(summary);
    expect(csv).toContain('NPV discount rate %,15');
    expect(csv).toContain('valuation rate source,manual');
  });

  it('models CSV export gains period dates at the END of the row shape', async () => {
    const { owner, modelA, modelB } = await consumerWorld();
    for (const model of [modelA, modelB]) {
      const res = await api.get(`${CMS}/finance/models/${model.id}/export.csv`).set('Authorization', owner.auth);
      expect(res.status).toBe(200);
      const lines = res.text.trim().split('\n');
      expect(lines[0]).toBe(
        'month,opening_sqft,move_in_sqft,move_out_sqft,net_move_in_sqft,closing_sqft,occupancy_pct,psf,revenue,opex_lease,opex_non_lease,operating_cost,noi,noi_margin_pct,cash,period_start,period_end',
      );
    }
    const resA = await api.get(`${CMS}/finance/models/${modelA.id}/export.csv`).set('Authorization', owner.auth);
    const rowsA = resA.text.trim().split('\n');
    expect(rowsA[1].endsWith(',2026-12-01,2026-12-31')).toBe(true);
    const resB = await api.get(`${CMS}/finance/models/${modelB.id}/export.csv`).set('Authorization', owner.auth);
    const rowsB = resB.text.trim().split('\n');
    expect(rowsB).toHaveLength(38); // header + 37 calendar rows
    expect(rowsB[1].endsWith(',2026-12-15,2026-12-31')).toBe(true);
    expect(rowsB[rowsB.length - 1].endsWith(',2029-12-01,2029-12-14')).toBe(true);
  });

  it('legacy models without a stored rate keep the legacy output (no substituted default)', async () => {
    const owner = await createOperator('OWNER');
    await enableRollout(owner.auth);
    const branch = await makeBranch('LG');
    const m = await makeModel(owner.auth, branch.id);
    // Simulate a pre-P4 row: strip the stamped valuation assumptions.
    const stored = await prisma.financialModel.findUniqueOrThrow({ where: { id: m.id } });
    const inputs = { ...(stored.inputs as unknown as Record<string, unknown>) };
    delete inputs.valuation;
    await prisma.financialModel.update({ where: { id: m.id }, data: { inputs: inputs as never } });
    await setCurrent(m.id);

    const r = await getReturns({ modelId: m.id, horizonYears: 5 });
    expect(r.committed).toBeUndefined();
    expect(r.npv.label).toBe('NPV through Year 5');
    const summary = await getInvestorSummary({ branchId: branch.id });
    expect(summary.returns.npvLabel).toBe('NPV through Year 5');
    expect(summary.returns.valuationRateSource).toBe('illustrative query rate');
    const lib = await listLibrary({ branchId: branch.id });
    expect(lib[0].headline).not.toHaveProperty('committed');
  });

  it('mid-month committed series matches the independent fixture engine path', async () => {
    // The P3 fixture derivation already pins the series math; here the same
    // engine path is reached through the persisted model (persistence parity).
    const { modelB } = await consumerWorld();
    const stored = await prisma.financialModel.findUniqueOrThrow({ where: { id: modelB.id } });
    const inputs = stored.inputs as unknown as Parameters<typeof project>[0];
    const result = project(inputs);
    expect(result.months).toHaveLength(37);
    expect(result.months[0]).toMatchObject({ month: '2026-12', periodStart: '2026-12-15', periodEnd: '2026-12-31' });
    expect(result.months[result.months.length - 1]).toMatchObject({ month: '2029-12', periodStart: '2029-12-01', periodEnd: '2029-12-14' });
    const series = buildCashFlowSeries(result, { capitalTotal: inputs.capitalTotal });
    const a = analyse(series, 0.15);
    const r = await getReturns({ modelId: modelB.id });
    const c = r.committed as unknown as { npv: number; cumulativeFreeCashFlow: number };
    expect(c.npv).toBe(a.npv);
    expect(c.cumulativeFreeCashFlow).toBe(a.cumulativeFreeCashFlow);
  });
});

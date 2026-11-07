// Model projection report (PDF): Financial Models › Projection report. One
// investor-facing report per model — calculations only (base case, scenarios,
// returns, assumptions). Monthly detail = first 24 months; yearly = 5 years.

import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';
import { createModel } from '../../src/core/finance/models';
import { buildProjectionReport, yearRows } from '../../src/core/finance/projectionReport';
import { buildProjectionReportPdf, projectionReportFileName } from '../../src/core/finance/projectionReportPdf';
import { applyScenario, project } from '../../src/core/finance/projection';
import { defaultModelInputs } from '../../src/core/finance/models';

const CMS = '/api/v1/cms';
const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function seedModel(status: 'CURRENT' | 'DRAFT') {
  const branch = await prisma.branch.create({ data: { code: 'PJ', name: 'Projection Park', address: '1 Model Rd', operatingHours: '9-9' } });
  const m = await createModel({ name: 'Projection Park base case', branchId: branch.id, actor: 'test' });
  if (status === 'CURRENT') await prisma.financialModel.update({ where: { id: m.id }, data: { status: 'CURRENT' } });
  return { branch, model: m };
}

describe('model projection report (PDF)', () => {
  beforeEach(resetDb);

  it('projects the saved model: 24 monthly rows, 5 model years, 3 scenarios, returns', async () => {
    const { model } = await seedModel('CURRENT');
    const r = await buildProjectionReport({ modelId: model.id, generatedBy: 'Test' });
    expect(r.meta).toMatchObject({ modelName: 'Projection Park base case', facility: 'Projection Park', status: 'CURRENT', approved: true });
    expect(r.months).toHaveLength(24);
    expect(r.months[0]).toMatchObject({ t: 1, month: '2026-12' });
    expect(r.years).toHaveLength(5);
    expect(r.years[0]).toMatchObject({ year: 1, firstMonth: '2026-12', lastMonth: '2027-11', months: 12 });
    // Year rows reconcile with the engine's own annual summary.
    for (const y of r.years) {
      const e = r.kpis.years[y.year - 1];
      expect(y.revenue).toBeCloseTo(e.revenue, 2);
      expect(y.noi).toBeCloseTo(e.noi, 2);
      expect(y.lease + y.otherCosts).toBeCloseTo(e.operatingCost, 2);
    }
    expect(r.scenarios.map((s) => s.scenario)).toEqual(['downside', 'base', 'upside']);
    const [down, base, up] = r.scenarios;
    expect(base.years[0].noi).toBeCloseTo(r.kpis.years[0].noi, 2);
    expect(down.years[0].revenue).toBeLessThan(base.years[0].revenue);
    expect(up.years[0].revenue).toBeGreaterThan(base.years[0].revenue);
    expect(r.returns).toMatchObject({ horizonYears: 5, discountRatePct: 8, paybackMonth: r.kpis.paybackMonth });
    expect(r.returns.irrAnnualised).toBeCloseTo(0.39492, 3);
    expect(r).not.toHaveProperty('sensitivity');

    const pdf = await buildProjectionReportPdf(r);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(projectionReportFileName(r)).toBe(`StoreLah_Financial_Projection_Projection-Park_Projection-Park-base-case_v${r.meta.version}.pdf`);
  });

  it('keeps scenario overlays inside the valid range (high / low saved targets)', async () => {
    for (const t of [98, 99, 100, 4, 1]) {
      const i = defaultModelInputs();
      i.occupancy.targetPct = t;
      const up = applyScenario(i, 'upside');
      const down = applyScenario(i, 'downside');
      expect(up.occupancy.targetPct).toBeLessThanOrEqual(100);
      expect(down.occupancy.targetPct).toBeGreaterThan(0);
      expect(() => project({ ...i, occupancy: up.occupancy })).not.toThrow();
      expect(() => project({ ...i, occupancy: down.occupancy })).not.toThrow();
    }
    // Typical targets are unchanged by the caps.
    expect(applyScenario(defaultModelInputs(), 'upside').occupancy.targetPct).toBe(95);
    expect(applyScenario(defaultModelInputs(), 'downside').occupancy.targetPct).toBe(87);

    // A saved 99% target exports (regression: "targetPct must be between 0 and 100").
    const { model } = await seedModel('CURRENT');
    const row = await prisma.financialModel.findUniqueOrThrow({ where: { id: model.id } });
    const inputs = row.inputs as { occupancy: { targetPct: number } };
    inputs.occupancy.targetPct = 99;
    await prisma.financialModel.update({ where: { id: model.id }, data: { inputs: inputs as never } });
    const r = await buildProjectionReport({ modelId: model.id, generatedBy: 'Test' });
    expect(r.scenarios.find((s) => s.scenario === 'upside')!.occupancy.targetPct).toBe(100);
    expect(r.scenarios.find((s) => s.scenario === 'upside')!.note).toContain('capped at 100%');
    expect((await buildProjectionReportPdf(r)).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('caps the windows to a short model horizon', () => {
    const months = Array.from({ length: 18 }, (_, n) => ({ t: n + 1, month: `2027-${String((n % 12) + 1).padStart(2, '0')}`, revenue: 100, opexLease: 30, opexNonLease: 20, operatingCost: 50, noi: 50, occupancyPct: 50, closingSqft: 10, cash: n } as never));
    const ys = yearRows(months);
    expect(ys).toHaveLength(2);
    expect(ys[1]).toMatchObject({ year: 2, months: 6, revenue: 600, noi: 300 });
  });

  it('downloads an audited PDF; drafts are stamped DRAFT; needs Financial Models access', async () => {
    const { model } = await seedModel('DRAFT');
    const op = await createOperator('FINANCE_OPERATOR');
    const res = await api.get(`${CMS}/finance/models/${model.id}/report.pdf`).set('Authorization', op.auth).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('_DRAFT.pdf');
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const audit = await prisma.financeAuditEvent.findFirst({ where: { entityType: 'financial-model', entityId: model.id, action: 'EXPORT_GENERATED' } });
    expect(audit).toMatchObject({ actor: op.email, reason: 'Model projection report (PDF)' });

    expect((await api.get(`${CMS}/finance/models/does-not-exist/report.pdf`).set('Authorization', op.auth)).status).toBe(404);
    const viewer = await createOperator('VIEWER');
    expect((await api.get(`${CMS}/finance/models/${model.id}/report.pdf`).set('Authorization', viewer.auth)).status).toBe(403);
  });
});

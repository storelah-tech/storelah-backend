// Investment returns report (PDF): Finance › Investment returns › Returns
// report. Prints the committed valuation the screen shows; blocked when the
// model has no committed valuation.

import { writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';
import { buildReturnsReport, buildReturnsReportPdf, npvOfSeries, returnsReportFileName } from '../../src/core/finance/returnsReportPdf';

const CMS = '/api/v1/cms';
const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const sched = (years: number, rent = 5000) =>
  Array.from({ length: years }, (_, i) => ({ leaseYear: i + 1, monthlyRent: rent, source: 'contract', confirmed: true }));

async function world(returns: 'on' | 'off' = 'on') {
  const owner = await createOperator('OWNER');
  const s = await api.put(`${CMS}/settings`).set('Authorization', owner.auth).send({ 'finance.leaseHorizon.rollout': 'all', 'finance.leaseHorizon.returns': returns });
  expect(s.status).toBe(200);
  const branch = await prisma.branch.create({ data: { code: 'RR', name: 'Returns Park', address: '1 Return Rd', operatingHours: '9-9' } });
  const m = await api.post(`${CMS}/finance/models`).set('Authorization', owner.auth).send({ name: 'Returns Park base case', branchId: branch.id });
  expect(m.status).toBe(201);
  const model = m.body.data as { id: string };
  const lease = await api.put(`${CMS}/finance/models/${model.id}/landlord-lease`).set('Authorization', owner.auth)
    .send({ version: 0, leaseStartDate: '2026-12-01', committedTermMonths: 60, prorationMethod: 'actual_days', currency: 'SGD', ufaSqft: 3068, schedule: sched(5) });
  expect(lease.status).toBe(200);
  return { owner, model };
}

describe('investment returns report (PDF)', () => {
  beforeEach(resetDb);

  it('prints the committed valuation the screen shows, with rate sensitivity', async () => {
    const { owner, model } = await world();
    const screen = (await api.get(`${CMS}/finance/returns?modelId=${model.id}`).set('Authorization', owner.auth)).body.data.committed;
    const r = await buildReturnsReport({ modelId: model.id, generatedBy: 'Test' });
    expect(r.committed.npv).toBe(screen.npv);
    expect(r.committed.irr).toEqual(screen.irr);
    expect(r.committed.scenarios.map((s) => s.scenario)).toEqual(['downside', 'base', 'upside']);
    expect(r.sensitivity.map((s) => s.rate)).toEqual([0.1, 0.12, 0.15, 0.18, 0.2]);
    const stored = r.sensitivity.find((s) => s.stored)!;
    expect(stored.rate).toBe(0.15);
    // Re-discounting the committed series at the stored rate reproduces Project NPV.
    expect(stored.npv).toBeCloseTo(r.committed.npv, 0);
    expect(npvOfSeries(r.committed.dcf, 0.1)).toBeGreaterThan(npvOfSeries(r.committed.dcf, 0.2));

    const pdf = await buildReturnsReportPdf(r);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(returnsReportFileName(r)).toMatch(/^StoreLah_Investment_Returns_Returns-Park_Returns-Park-base-case_v\d+_DRAFT\.pdf$/);
    if (process.env.RETURNS_REPORT_SAMPLE) writeFileSync(process.env.RETURNS_REPORT_SAMPLE, pdf);
  });

  it('downloads an audited PDF; blocked without a committed valuation; needs Investment returns access', async () => {
    const { owner, model } = await world();
    const res = await api.get(`${CMS}/finance/returns/report.pdf?modelId=${model.id}`).set('Authorization', owner.auth).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('StoreLah_Investment_Returns_');
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const audit = await prisma.financeAuditEvent.findFirst({ where: { entityId: model.id, action: 'EXPORT_GENERATED', reason: 'Investment returns report (PDF)' } });
    expect(audit).toMatchObject({ actor: owner.email });

    expect((await api.get(`${CMS}/finance/returns/report.pdf`).set('Authorization', owner.auth)).status).toBe(400);
    expect((await api.get(`${CMS}/finance/returns/report.pdf?modelId=nope`).set('Authorization', owner.auth)).status).toBe(404);
    const noPerm = await createOperator('VIEWER');
    const denied = await api.get(`${CMS}/finance/returns/report.pdf?modelId=${model.id}`).set('Authorization', noPerm.auth);
    expect(denied.status).toBe(403);
    // Rollout off → no committed block → 409, never uncommitted figures.
    await api.put(`${CMS}/settings`).set('Authorization', owner.auth).send({ 'finance.leaseHorizon.returns': 'off' });
    const blocked = await api.get(`${CMS}/finance/returns/report.pdf?modelId=${model.id}`).set('Authorization', owner.auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('Committed valuation is unavailable');
  });
});

// Financial report (PDF): Finance overview › Financial report. One report per
// period / facility / basis built from the Finance read models; sections are
// limited to what the operator can view; every download is audited.

import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb, uniqueEmail } from './fixtures';
import { buildFinanceReport, monthsBetween } from '../../src/core/finance/report';
import { buildFinanceReportPdf } from '../../src/core/finance/reportPdf';
import { createModel } from '../../src/core/finance/models';

const CMS = '/api/v1/cms';
const day = (v: string) => new Date(`${v}T00:00:00.000Z`);
const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function seed() {
  const size = await prisma.unitSize.create({ data: { code: 'RPT-S', name: 'Small', sqftFrom: 10, sqftTo: 60, sortOrder: 1 } });
  const branch = await prisma.branch.create({ data: { code: 'RP', name: 'Report Park', address: '1 Report Rd', operatingHours: '9-9' } });
  const floor = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'L1' } });
  const unit = await prisma.unit.create({ data: { branchId: branch.id, floorId: floor.id, sizeId: size.id, unitCode: 'RP-01-01', sqft: 40, monthlyRate: 320, status: 'OCCUPIED' } });
  const tenant = await prisma.tenant.create({ data: { name: 'Report Tenant', email: uniqueEmail(), unitId: unit.id, moveInDate: day('2026-09-01'), monthlyRate: 320, psf: 8, status: 'ACTIVE', branchId: branch.id } });
  await prisma.invoice.create({ data: { invoiceNo: 'INV-RPT-1', tenantId: tenant.id, unitId: unit.id, amount: 320, dueDate: day('2026-10-05'), billedMonth: day('2026-10-01'), status: 'PAID', paidAt: day('2026-10-05'), amountPaid: 320 } });
  return { branch };
}

describe('financial report (PDF)', () => {
  beforeEach(resetDb);

  it('lists the fiscal months a period touches', () => {
    expect(monthsBetween(day('2026-08-15'), day('2026-11-05'))).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
    expect(monthsBetween(day('2026-12-01'), day('2027-01-31'))).toEqual(['2026-12', '2027-01']);
  });

  it('builds sections from the finance read models, marking open months provisional', async () => {
    const { branch } = await seed();
    const r = await buildFinanceReport({ from: day('2026-10-01'), to: day('2026-10-31'), branchId: branch.id, generatedBy: 'Test' });
    expect(r.meta).toMatchObject({ facility: 'Report Park', basis: 'accrual', months: ['2026-10'] });
    expect(r.meta.sections).not.toContain('returns');
    expect(r.summary!.kpis.find((k) => k.key === 'cashCollected')!.value).toBe(320);
    expect(r.performance![0]).toMatchObject({ branch: 'Report Park', fiscalMonth: '2026-10', closed: false });
    expect(r.performance![0].rows.find((x) => x.metric === 'REVENUE')!.actual).toBe(320);
    expect(r.transactions!.byType).toEqual(expect.arrayContaining([expect.objectContaining({ docType: 'Invoice', count: 1, amount: 320 })]));
  });

  it('includes each facility\'s current approved financial model (assumptions + projection)', async () => {
    const { branch } = await seed();
    const other = await prisma.branch.create({ data: { code: 'RQ', name: 'Quiet Park', address: '2 Report Rd', operatingHours: '9-9' } });
    const draft = await createModel({ name: 'Draft only', branchId: other.id, actor: 'test' });
    const m = await createModel({ name: 'Report Park base case', branchId: branch.id, actor: 'test' });
    await prisma.financialModel.update({ where: { id: m.id }, data: { status: 'CURRENT' } });

    const r = await buildFinanceReport({ from: day('2026-10-01'), to: day('2026-10-31'), generatedBy: 'Test' });
    expect(r.meta.sections).toContain('model');
    const park = r.model!.find((x) => x.branch === 'Report Park')!;
    expect(park.model).toMatchObject({ name: 'Report Park base case', version: expect.any(Number) });
    expect(park.model!.inputs.nlaSqft).toBeGreaterThan(0);
    expect(park.model!.kpis.years.length).toBeGreaterThan(0);
    // Drafts are never reported — only the CURRENT (approved) model.
    expect(r.model!.find((x) => x.branch === 'Quiet Park')!.model).toBeNull();
    expect(draft.id).toBeTruthy();

    const pdf = await buildFinanceReportPdf(r);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('omits the model section for roles without Financial Models access', async () => {
    await seed();
    const manager = await createOperator('MANAGER');
    expect((await api.get(`${CMS}/finance/reports/financial.pdf?sections=model`).set('Authorization', manager.auth)).status).toBe(403);
    const op = await createOperator('FINANCE_OPERATOR');
    const res = await api.get(`${CMS}/finance/reports/financial.pdf?sections=model`).set('Authorization', op.auth).buffer(true).parse(binary);
    expect(res.status).toBe(200);
  });

  it('downloads an audited PDF and limits sections to what the operator may view', async () => {
    const { branch } = await seed();
    const owner = await createOperator('OWNER');
    const res = await api.get(`${CMS}/finance/reports/financial.pdf?from=2026-10-01&to=2026-10-31&branchId=${branch.id}&basis=cash`)
      .set('Authorization', owner.auth).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('StoreLah_Financial_Report_2026-10-01_2026-10-31_Report-Park_cash.pdf');
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const audit = await prisma.financeAuditEvent.findFirst({ where: { entityType: 'finance-report' } });
    expect(audit).toMatchObject({ action: 'EXPORT_GENERATED', actor: owner.email, branchId: branch.id });

    expect((await api.get(`${CMS}/finance/reports/financial.pdf?sections=bogus`).set('Authorization', owner.auth)).status).toBe(400);

    // Manager: Overview + Arrears are visible, Transactions is not.
    const manager = await createOperator('MANAGER');
    expect((await api.get(`${CMS}/finance/reports/financial.pdf?sections=transactions`).set('Authorization', manager.auth)).status).toBe(403);
    const partial = await api.get(`${CMS}/finance/reports/financial.pdf`).set('Authorization', manager.auth).buffer(true).parse(binary);
    expect(partial.status).toBe(200);
    const last = await prisma.financeAuditEvent.findFirst({ where: { entityType: 'finance-report', actor: manager.email } });
    expect((last!.after as { filters: { sections: string[] } }).filters.sections).toEqual(['summary', 'arrears']);

    // Viewer: no finance access at all.
    const viewer = await createOperator('VIEWER');
    expect((await api.get(`${CMS}/finance/reports/financial.pdf`).set('Authorization', viewer.auth)).status).toBe(403);
  });
});

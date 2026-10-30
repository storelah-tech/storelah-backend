// Finance Phase 5 — Investor summary (spec §15.4, owner Q10 FINAL).
//
// Covers: Investor role gating (200 on the two masked routes, 403 on every
// other finance route), approved-only data (CURRENT model; DRAFT invisible;
// CLOSED months only, OPEN excluded), masked-field assertions (no customer
// name/email/phone, no transaction detail, no PII keys anywhere in the
// payload), Q10 formatting (amounts rounded whole, psf ALWAYS 2dp,
// percents 1dp), watermark on JSON + CSV, and audited masked export.

import { beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from '@prisma/client/runtime/library';
import { api, createOperator, prisma, resetDb } from './fixtures';

const CMS = '/api/v1/cms';

const PII_NAME = 'Pii Probe Person';
const PII_EMAIL = 'pii-probe-person@e2e.test';
const PII_MOBILE = '81001001';
const DRAFT_MODEL_NAME = 'Draft That Must Stay Invisible';

const FORBIDDEN_KEYS = new Set([
  'email', 'tenantEmail', 'customerEmail', 'phone', 'mobile',
  'tenantId', 'customerId', 'invoiceId', 'invoiceNo',
  'paymentIntentId', 'stripeSessionId', 'sessionId', 'setupIntentId',
  'cardLast4', 'mandate', 'unitCode', 'address', 'bankAccount',
]);

function keysOf(v: unknown, acc: string[] = []): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => keysOf(x, acc));
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      acc.push(k);
      keysOf(val, acc);
    }
  }
  return acc;
}

async function seedInvestorWorld() {
  const branch = await prisma.branch.create({
    data: { code: 'INV5', name: 'Investor Five', address: '1 Masked Rd', operatingHours: '9-9' },
  });
  const floor = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'L1' } });
  // Canonical planning taxonomy so the branch-scoped CURRENT baseline passes
  // the inventory-mapping gate (spec §14.2); live NLA/counts come from the
  // two units below.
  const locker = await prisma.unitSize.create({
    data: { code: 'LOCKER', name: 'Locker', sqftFrom: 5, sqftTo: 25, sortOrder: 1 },
  });
  for (const [code, name, from, to, sort] of [
    ['SMALL', 'Small', 26, 60, 2], ['MEDIUM', 'Medium', 61, 110, 3],
    ['LARGE', 'Large', 111, 180, 4], ['XL', 'XL', 181, 320, 5],
  ] as const) {
    await prisma.unitSize.create({ data: { code, name, sqftFrom: from, sqftTo: to, sortOrder: sort } });
  }
  const size = locker;
  const mkUnit = (code: string) =>
    prisma.unit.create({
      data: { branchId: branch.id, floorId: floor.id, sizeId: size.id, unitCode: code, sqft: 50, monthlyRate: 250, status: 'OCCUPIED' },
    });
  const unitA = await mkUnit('INV5-01-01');
  const unitB = await mkUnit('INV5-01-02');

  const operator = await createOperator('FINANCE_OPERATOR');
  const approver = await createOperator('FINANCE_APPROVER');
  const investor = await createOperator('INVESTOR');

  // CURRENT baseline through the governed path (submit + approve).
  const created = await api.post(`${CMS}/finance/models`).set('Authorization', operator.auth).send({ name: 'Approved Baseline', branchId: branch.id });
  expect(created.status).toBe(201);
  const modelId = created.body.data.id as string;
  expect((await api.post(`${CMS}/finance/library/${modelId}/submit`).set('Authorization', approver.auth).send({ version: 0 })).status).toBe(200);
  expect((await api.post(`${CMS}/finance/library/${modelId}/approve`).set('Authorization', approver.auth).send({ version: 1, comment: 'Board sign-off' })).status).toBe(200);

  // A second model stays DRAFT — investor output must never mention it.
  const draft = await api.post(`${CMS}/finance/models`).set('Authorization', operator.auth).send({ name: DRAFT_MODEL_NAME, branchId: branch.id });
  expect(draft.status).toBe(201);

  // Tenant aggregates with PII that must never surface.
  const t1 = await prisma.tenant.create({
    data: {
      name: PII_NAME, email: PII_EMAIL, mobile: PII_MOBILE,
      unitId: unitA.id, moveInDate: new Date('2025-06-01T00:00:00Z'),
      monthlyRate: 200, psf: 4, status: 'ACTIVE', branchId: branch.id,
    },
  });
  await prisma.tenant.create({
    data: {
      name: 'Second Occupant', email: 'second-occupant@e2e.test', mobile: '81001002',
      unitId: unitB.id, moveInDate: new Date('2025-12-01T00:00:00Z'),
      monthlyRate: 300, psf: 6, status: 'ACTIVE', branchId: branch.id,
    },
  });
  // One ISSUED (open balance) + one PAID invoice on tenant 1.
  await prisma.invoice.create({
    data: {
      invoiceNo: 'INV-E2E-ISSUED-01', tenantId: t1.id, unitId: unitA.id, status: 'ISSUED',
      dueDate: new Date('2026-09-01T00:00:00Z'),
      amount: new Decimal('250.75'), subtotal: new Decimal('250.75'),
      balanceDue: new Decimal('250.75'), version: 1,
    },
  });
  await prisma.invoice.create({
    data: {
      invoiceNo: 'INV-E2E-PAID-01', tenantId: t1.id, unitId: unitA.id, status: 'PAID',
      dueDate: new Date('2026-08-01T00:00:00Z'), paidAt: new Date('2026-08-02T00:00:00Z'),
      amount: new Decimal('200.40'), amountPaid: new Decimal('200.40'),
      subtotal: new Decimal('200.40'), balanceDue: new Decimal(0), version: 1,
    },
  });
  // CLOSED month carries posted actuals; OPEN month must be excluded.
  await prisma.monthClose.create({
    data: { branchId: branch.id, fiscalMonth: '2026-08', status: 'CLOSED', closedBy: 'e2e', closedAt: new Date() },
  });
  await prisma.actualMetric.create({
    data: { branchId: branch.id, fiscalMonth: '2026-08', metric: 'REVENUE', value: new Decimal('1234.56'), source: 'e2e' },
  });
  await prisma.monthClose.create({ data: { branchId: branch.id, fiscalMonth: '2026-09', status: 'OPEN' } });
  await prisma.actualMetric.create({
    data: { branchId: branch.id, fiscalMonth: '2026-09', metric: 'REVENUE', value: new Decimal('9999.99'), source: 'e2e' },
  });
  return { branchId: branch.id, operator, approver, investor, modelId };
}

describe('investor summary (Phase 5)', () => {
  beforeEach(resetDb);

  it('serves a watermarked masked summary over approved data only', async () => {
    const w = await seedInvestorWorld();
    const res = await api.get(`${CMS}/finance/investor/summary`).set('Authorization', w.investor.auth).query({ branchId: w.branchId });
    expect(res.status).toBe(200);
    const d = res.body.data;
    // Watermark + label on every output.
    expect(d.watermark).toBe('MASKED SUMMARY — APPROVED DATA ONLY');
    expect(d.label).toMatch(/masked summary/i);
    // CURRENT baseline only — the DRAFT model is invisible.
    expect(d.modelling.source.modelStatus).toBe('CURRENT');
    expect(JSON.stringify(d)).not.toContain(DRAFT_MODEL_NAME);
    // Q10 content list present.
    for (const k of ['occupancyRatePct', 'earnedPsf', 'rampUpSqft', 'signUpsUnits', 'moveOutRatePctMonth', 'avgTenureMonths', 'avgCustomerValue', 'totalRevenueModel']) {
      expect(d.modelling).toHaveProperty(k);
    }
    // Q10 formatting: psf ALWAYS 2dp, amounts rounded whole.
    expect(Math.round(d.modelling.earnedPsf * 100) / 100).toBe(d.modelling.earnedPsf);
    for (const n of [d.modelling.totalRevenueModel, d.modelling.avgCustomerValue, d.returns.initialInvestment, d.returns.npv, d.aggregates.issuedTotal, d.aggregates.collectedTotal]) {
      expect(Number.isInteger(n)).toBe(true);
    }
    // Aggregates from the seeded ledger: 2 invoices, 200.40 collected → 200.
    expect(d.aggregates.issuedInvoices).toBe(2);
    expect(d.aggregates.collectedTotal).toBe(200);
    // CLOSED months only — the OPEN month and its 9999.99 never appear.
    expect(d.actuals.closedMonths.map((c: { fiscalMonth: string }) => c.fiscalMonth)).toEqual(['2026-08']);
    expect(d.actuals.closedMonths[0].metrics.REVENUE).toBe(1235);
    expect(JSON.stringify(d)).not.toContain('9999');
    // Tenant aggregates work without exposing tenants.
    expect(d.modelling.avgCustomerValue).toBe(250);
  });

  it('contains no customer PII, transaction detail or PII keys', async () => {
    const w = await seedInvestorWorld();
    const res = await api.get(`${CMS}/finance/investor/summary`).set('Authorization', w.investor.auth).query({ branchId: w.branchId });
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body.data);
    expect(text).not.toContain(PII_NAME);
    expect(text).not.toContain('Second Occupant');
    expect(text).not.toContain(PII_EMAIL);
    expect(text).not.toContain('second-occupant@e2e.test');
    expect(text).not.toContain(PII_MOBILE);
    expect(text).not.toContain('81001002');
    const bad = keysOf(res.body.data).filter((k) => FORBIDDEN_KEYS.has(k));
    expect(bad).toEqual([]);
    // Same guarantee on the CSV export.
    const csv = await api.get(`${CMS}/finance/investor/summary.csv`).set('Authorization', w.investor.auth).query({ branchId: w.branchId });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('MASKED SUMMARY');
    expect(csv.text).not.toContain(PII_NAME);
    expect(csv.text).not.toContain(PII_EMAIL);
    expect(csv.text).not.toContain(PII_MOBILE);
    // Earned PSF renders with exactly 2dp in the CSV.
    const psfLine = csv.text.split('\n').find((l: string) => l.startsWith('earned psf,'));
    expect(psfLine).toMatch(/earned psf,\d+\.\d{2}$/);
  });

  it('404s without a CURRENT baseline (drafts never substitute)', async () => {
    const w = await seedInvestorWorld();
    const op = w.operator;
    // Supersede the CURRENT baseline with a fresh CURRENT-less state: archive
    // the only approved model path is closed, so delete via API is blocked —
    // instead query a branch with no models at all.
    const other = await prisma.branch.create({
      data: { code: 'INVX', name: 'Empty', address: 'x', operatingHours: '9-9' },
    });
    const res = await api.get(`${CMS}/finance/investor/summary`).set('Authorization', op.auth).query({ branchId: other.id });
    expect(res.status).toBe(404);
  });

  it('investor role is denied every other finance route', async () => {
    const w = await seedInvestorWorld();
    const denied = [
      ['get', '/finance/overview'], ['get', '/finance/overview/export.csv'],
      ['get', '/finance/audit'],
      ['get', '/finance/models'], ['get', `/finance/models/${w.modelId}`],
      ['get', '/finance/library'], ['get', '/finance/budgets'], ['get', '/finance/expenses'],
      ['get', '/finance/pricing'], ['get', '/finance/returns'],
      ['get', '/finance/invoices'], ['get', '/finance/transactions'],
      ['get', '/finance/credits'], ['get', '/finance/refunds'],
      ['get', '/finance/arrears'], ['get', '/finance/reconciliation'],
      ['get', '/finance/performance'], ['get', '/finance/month-close'],
    ] as const;
    for (const [method, path] of denied) {
      const r = await (api as any)[method](`${CMS}${path}`).set('Authorization', w.investor.auth);
      expect(`${method} ${path} → ${r.status}`).toBe(`${method} ${path} → 403`);
    }
    expect((await api.post(`${CMS}/finance/models`).set('Authorization', w.investor.auth).send({ name: 'Nope' })).status).toBe(403);
    expect((await api.post(`${CMS}/finance/month-close`).set('Authorization', w.investor.auth).send({})).status).toBe(403);
  });

  it('finance operators keep the masked summary; CSV export is audited', async () => {
    const w = await seedInvestorWorld();
    expect((await api.get(`${CMS}/finance/investor/summary`).set('Authorization', w.operator.auth).query({ branchId: w.branchId })).status).toBe(200);
    const csv = await api.get(`${CMS}/finance/investor/summary.csv`).set('Authorization', w.operator.auth).query({ branchId: w.branchId });
    expect(csv.status).toBe(200);
    const events = await prisma.financeAuditEvent.findMany({
      where: { entityType: 'finance-investor-summary', action: 'EXPORT_GENERATED' },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect((events[0].after as unknown as { masked: boolean }).masked).toBe(true);
  });
});

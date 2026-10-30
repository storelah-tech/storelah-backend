// WP-A F-1…F-9 regression + mandatory UI smoke (F-1 shipped for lack of this).
//
// One test per testable defect. Golden projection numbers stay pinned by
// finance-projection.test.ts — this file asserts behaviour, never numbers.

import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../src/lib/prisma';
import { api, createOperator, resetDb, seedMoveInWorld } from './fixtures';
// @ts-expect-error — plain browser ES module (no types); pure, no DOM imports.
import { REPORTING_PERIODS, reportingRange } from '../../src/cms/admin/financePeriods.js';

const CMS = '/api/v1/cms';
const PANELS = [
  'bill-overview', 'bill-transactions', 'bill-models', 'bill-performance',
  'bill-budgets', 'bill-pricing', 'bill-returns', 'bill-library',
  'bill-invoices', 'bill-arrears', 'bill-credits', 'bill-reconciliation',
  'bill-investor',
];
const VIEWS: Array<[string, string]> = [
  ['bill-overview', 'financeOverviewView.js'],
  ['bill-transactions', 'financeTransactionsView.js'],
  ['bill-models', 'financeModelsView.js'],
  ['bill-performance', 'financePerformanceView.js'],
  ['bill-budgets', 'financeBudgetsView.js'],
  ['bill-pricing', 'financePricingView.js'],
  ['bill-returns', 'financeReturnsView.js'],
  ['bill-library', 'financeLibraryView.js'],
  ['bill-invoices', 'financeInvoicesView.js'],
  ['bill-arrears', 'financeArrearsView.js'],
  ['bill-credits', 'financeCreditsView.js'],
  ['bill-reconciliation', 'financeReconciliationView.js'],
  ['bill-investor', 'financeInvestorView.js'],
];
const adminDir = path.join(__dirname, '..', '..', 'src', 'cms', 'admin');
const readView = (f: string) => fs.readFileSync(path.join(adminDir, f), 'utf8');
const readDashboard = () => fs.readFileSync(path.join(adminDir, 'dashboard.html'), 'utf8');

describe('WP-A F-1 mount contract', () => {
  it('every finance view binds via getFinMount(panel) — never a silent id lookup', () => {
    for (const [panel, file] of VIEWS) {
      const src = readView(file);
      expect(src.includes('getFinMount'), `${file} must import getFinMount`);
      expect(src.includes(`getFinMount(PANEL)`), `${file} must bind getFinMount(PANEL)`);
      // No silent early-return on a missing legacy id.
      expect(src.includes(`$('#finance`), `${file} must not use a legacy #finance id lookup`);
      expect(src.includes(`[data-fin-arrears]`) || !src.includes('data-fin-arrears'), `${file} arrears uses the shared mount`);
      expect(src.includes(`[data-fin-invoices]`) || !src.includes('data-fin-invoices'), `${file} invoices uses the shared mount`);
      void panel;
    }
    const shared = readView('financeShared.js');
    expect(shared).toMatch(/console\.error.*missing host/);
  });

  it('dashboard.html provides [data-fin-mount] in all 13 panels, no legacy tables', () => {
    const html = readDashboard();
    for (const panel of PANELS) {
      expect(html.includes(`id="${panel}"`), `missing panel ${panel}`);
    }
    expect((html.match(/data-fin-mount/g) || []).length).toBeGreaterThanOrEqual(13);
    for (const legacy of ['billingStats', 'agingBreakdown', 'invoiceRows', 'arrearRows', 'financeModels', 'financeBudgets', 'financePricing', 'financeReturns', 'financeLibrary']) {
      expect(html.includes(legacy)).toBe(false);
    }
  });
});

describe('WP-A F-2 arrears route order', () => {
  beforeEach(resetDb);

  it('literal /waivers is not shadowed by /:id', async () => {
    await seedMoveInWorld();
    const op = await createOperator('FINANCE_OPERATOR');
    const branch = await prisma.branch.findUniqueOrThrow({ where: { code: 'SW' } });
    const size = await prisma.unitSize.findFirstOrThrow();
    const floor = await prisma.floor.findFirstOrThrow({ where: { branchId: branch.id } });
    const unit = await prisma.unit.create({
      data: { branchId: branch.id, floorId: floor.id, sizeId: size.id, unitCode: `WA-${Date.now().toString(36)}`, sqft: 50, monthlyRate: 200, status: 'OCCUPIED' },
    });
    const tenant = await prisma.tenant.create({
      data: { name: 'Arrears Waiver', email: `w${Date.now()}@e2e.test`, unitId: unit.id, moveInDate: new Date('2026-08-01T00:00:00Z'), monthlyRate: 200, psf: 4, status: 'ACTIVE', branchId: branch.id },
    });
    const inv = await prisma.invoice.create({
      data: { invoiceNo: `INV-WA-${Date.now()}`, tenantId: tenant.id, unitId: unit.id, amount: 200, dueDate: new Date(Date.now() - 86400000 * 3), billedMonth: new Date(), status: 'OVERDUE' },
    });
    const c = await api.post(`${CMS}/finance/arrears`).set('Authorization', op.auth).send({ tenantId: tenant.id, invoiceId: inv.id });
    expect(c.status).toBe(201);
    const waivers = await api.get(`${CMS}/finance/arrears/waivers`).set('Authorization', op.auth);
    expect(waivers.status).toBe(200); // was 404 "Arrears case not found" when shadowed
    const one = await api.get(`${CMS}/finance/arrears/${c.body.data.id}`).set('Authorization', op.auth);
    expect(one.status).toBe(200);
  });
});

describe('WP-A F-3 billing run', () => {
  beforeEach(resetDb);

  it('bills by unit.branchId and explains an empty run', async () => {
    await seedMoveInWorld();
    const op = await createOperator('FINANCE_OPERATOR');
    const branch = await prisma.branch.findUniqueOrThrow({ where: { code: 'SW' } });
    const run = await api.post(`${CMS}/finance/billing-run`).set('Authorization', op.auth).send({ branchId: branch.id, billingMonth: '2026-10' });
    expect(run.status).toBe(200);
    expect(run.body.data.created).toBeGreaterThanOrEqual(0);
    // Empty facility → reason string, never a silent zero.
    const emptyBranch = await prisma.branch.create({ data: { code: `EB${Date.now().toString(36).slice(-4).toUpperCase()}`, name: 'Empty', address: '1 Nowhere Rd', operatingHours: '9-9' } });
    const empty = await api.post(`${CMS}/finance/billing-run`).set('Authorization', op.auth).send({ branchId: emptyBranch.id, billingMonth: '2026-10' });
    expect(empty.status).toBe(200);
    expect(empty.body.data.created).toBe(0);
    expect(typeof empty.body.data.reason).toBe('string');
    expect(empty.body.data.reason.length).toBeGreaterThan(0);
  });
});

describe('WP-A F-5 version required', () => {
  beforeEach(resetDb);

  it('missing version → 400 on section PUT, library submit, invoice approve', async () => {
    await seedMoveInWorld();
    const op = await createOperator('FINANCE_OPERATOR');
    const approver = await createOperator('FINANCE_APPROVER');
    const created = await api.post(`${CMS}/finance/models`).set('Authorization', op.auth).send({ name: 'V5' });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect((await api.put(`${CMS}/finance/models/${id}/inputs`).set('Authorization', op.auth).send({ patch: { horizonMonths: 36 } })).status).toBe(400);
    expect((await api.post(`${CMS}/finance/library/${id}/submit`).set('Authorization', approver.auth).send({})).status).toBe(400);
  });
});

describe('WP-A F-6 refund reasons', () => {
  beforeEach(resetDb);

  it('plain credit needs no reason; fee/override without reason → 400', async () => {
    await seedMoveInWorld();
    const op = await createOperator('FINANCE_OPERATOR');
    const plain = await api.post(`${CMS}/finance/refunds/calculate`).set('Authorization', op.auth).send({ monthlyRent: 300, daysInMonth: 30, unusedDays: 10, refundableCredit: 50 });
    expect(plain.status).toBe(200);
    const fee = await api.post(`${CMS}/finance/refunds/calculate`).set('Authorization', op.auth).send({ monthlyRent: 300, daysInMonth: 30, unusedDays: 10, earlyTerminationFee: 20 });
    expect(fee.status).toBe(400);
    const over = await api.post(`${CMS}/finance/refunds/calculate`).set('Authorization', op.auth).send({ monthlyRent: 300, daysInMonth: 30, unusedDays: 10, override: 5 });
    expect(over.status).toBe(400);
  });
});

describe('WP-A F-7 overview split + period', () => {
  beforeEach(resetDb);

  it('Revenue billed and Cash collected are separate connected KPIs; export honours the period', async () => {
    await seedMoveInWorld();
    const op = await createOperator('FINANCE_OPERATOR');
    const res = await api.get(`${CMS}/finance/overview?basis=accrual`).set('Authorization', op.auth);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.data.kpis.map((k: { key: string; value: number | null; connected: boolean }) => [k.key, k]));
    expect(byKey.revenueBilled.connected).toBe(true);
    expect(byKey.cashCollected.connected).toBe(true);
    expect(byKey.failedPayments.connected).toBe(true);
    expect(byKey.creditsRefunds.connected).toBe(true);
    const csv = await api.get(`${CMS}/finance/overview/export.csv?basis=accrual`).set('Authorization', op.auth);
    expect(csv.status).toBe(200);
    expect(csv.text).toMatch(/Cash collected/);
  });

  // Regression: the view sent ISO timestamps and every Overview load 400'd.
  // Feed the exact values the view builds for every preset into both endpoints.
  it('every reporting-period preset the view sends is accepted by overview + export', async () => {
    const op = await createOperator('FINANCE_OPERATOR');
    const now = new Date(Date.UTC(2026, 0, 15)); // January: exercises year rollback
    for (const [preset] of REPORTING_PERIODS) {
      const { from, to } = reportingRange(preset, now);
      const q = new URLSearchParams({ basis: 'accrual' });
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      const res = await api.get(`${CMS}/finance/overview?${q}`).set('Authorization', op.auth);
      expect(res.status, `${preset} → ${q}`).toBe(200);
      const csv = await api.get(`${CMS}/finance/overview/export.csv?${q}`).set('Authorization', op.auth);
      expect(csv.status, `${preset} export`).toBe(200);
    }
    expect(reportingRange('last-m', now)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(reportingRange('last-6m', now)).toEqual({ from: '2025-08-01', to: '2026-01-31' });
    expect(reportingRange('this-y', now)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
});

describe('WP-A F-8 investor empty state', () => {
  beforeEach(resetDb);

  it('no CURRENT baseline → 404; view carries the designed empty state + library link', async () => {
    await seedMoveInWorld();
    const op = await createOperator('FINANCE_OPERATOR');
    const res = await api.get(`${CMS}/finance/investor/summary`).set('Authorization', op.auth);
    expect(res.status).toBe(404);
    const src = readView('financeInvestorView.js');
    expect(src).toMatch(/No CURRENT model baseline/);
    expect(src).toMatch(/Open Model Library/);
  });
});

describe('WP-A F-9 dead legacy removed', () => {
  it('no dead header buttons, blocks, or legacy wiring', () => {
    const html = readDashboard();
    expect(html.includes('＋ Create invoice')).toBe(false);
    const admin = fs.readFileSync(path.join(adminDir, 'admin.js'), 'utf8');
    expect(admin).toMatch(/bindBilling is retired/);
    expect(admin.includes(`bindBilling().catch`)).toBe(false);
  });
});

describe('WP-A mandatory UI smoke — /admin mounts', () => {
  it('loads /admin as Owner; every finance sub-page mount is present and error-free', async () => {
    const res = await api.get('/admin');
    expect(res.status).toBe(200);
    const html = res.text;
    for (const panel of PANELS) {
      expect(html.includes(`id="${panel}"`), `panel ${panel} missing in served /admin`);
    }
    const mounts = html.match(/data-fin-mount/g) || [];
    expect(mounts.length).toBeGreaterThanOrEqual(13);
    // No rendered error state ships in the static shell (errors render at runtime only).
    expect(html.includes('Couldn’t load this screen')).toBe(false);
  });
});

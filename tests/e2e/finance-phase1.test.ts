// Finance Phase 1 foundations — API + roles + audit/outbox (spec §§6/9/16.5/21).
//
// Covers: seeded Finance roles (zero members, Owner assigns), per-role route
// enforcement on the three Phase 1 finance routes, read-only Overview KPIs
// from REAL data (accrual/cash toggle, not-connected KPIs never zero,
// em-dash-equivalent nulls), audited CSV export with correlation linkage,
// same-transaction outbox writes, append-only audit, and the optimistic-lock
// + idempotency helpers. Customer API is untouched (DRAFT is not a valid
// InvoiceStatus in Phase 1 — the lifecycle widening is Phase 3).

import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb, uniqueEmail } from './fixtures';
import { SYSTEM_ROLES } from '../../src/lib/permissions';
import { assertFreshVersion, getIdempotencyKey, newCorrelationId } from '../../src/core/finance/idempotency';

const CMS = '/api/v1/cms';

async function seedLedgerWorld() {
  const size = await prisma.unitSize.create({
    data: { code: 'FIN-S', name: 'Fin Small', sqftFrom: 10, sqftTo: 40, sortOrder: 1 },
  });
  const branch = await prisma.branch.create({
    data: { code: 'FN', name: 'Finance E2E', address: '1 Finance Rd', operatingHours: '9-9' },
  });
  const floor = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'L1' } });
  const unit = await prisma.unit.create({
    data: { branchId: branch.id, floorId: floor.id, sizeId: size.id, unitCode: 'FN-01-01', sqft: 40, monthlyRate: 200, status: 'OCCUPIED' },
  });
  const tenant = await prisma.tenant.create({
    data: {
      name: 'Fin Tenant', email: uniqueEmail(), mobile: '81234567', unitId: unit.id,
      moveInDate: new Date('2026-09-01T00:00:00Z'), monthlyRate: 200, psf: 5,
      status: 'ACTIVE', branchId: branch.id, createdAt: new Date('2026-09-01T00:00:00Z'),
    },
  });
  // DUE in September (receivable), OVERDUE from August, PAID in September.
  await prisma.invoice.create({
    data: { invoiceNo: 'INV-FIN-001', tenantId: tenant.id, unitId: unit.id, amount: 200, dueDate: new Date('2026-09-05T00:00:00Z'), billedMonth: new Date('2026-09-01T00:00:00Z'), status: 'DUE' },
  });
  await prisma.invoice.create({
    data: { invoiceNo: 'INV-FIN-002', tenantId: tenant.id, unitId: unit.id, amount: 200, dueDate: new Date('2026-08-05T00:00:00Z'), billedMonth: new Date('2026-08-01T00:00:00Z'), status: 'OVERDUE' },
  });
  await prisma.invoice.create({
    data: {
      invoiceNo: 'INV-FIN-003', tenantId: tenant.id, unitId: unit.id, amount: 200,
      dueDate: new Date('2026-09-05T00:00:00Z'), billedMonth: new Date('2026-09-01T00:00:00Z'),
      status: 'PAID', paidAt: new Date('2026-09-06T00:00:00Z'), amountPaid: 200,
    },
  });
  await prisma.booking.create({
    data: { bookingRef: `SL-FIN-${Date.now()}`, tenantId: tenant.id, unitId: unit.id, moveInDate: new Date('2026-09-01T00:00:00Z'), duration: 'Monthly', amount: 200, status: 'CONFIRMED' },
  });
  await prisma.notice.create({
    data: { tenantId: tenant.id, unitId: unit.id, lastDay: new Date('2026-09-20T00:00:00Z') },
  });
  return { branch, tenant };
}

describe('finance roles', () => {
  beforeEach(resetDb);

  it('seeds Finance Operator / Approver / Auditor with zero members', async () => {
    const keys = SYSTEM_ROLES.filter((r) => r.key.startsWith('FINANCE_')).map((r) => r.key);
    expect(keys).toEqual(['FINANCE_OPERATOR', 'FINANCE_APPROVER', 'FINANCE_AUDITOR']);
    for (const key of keys) {
      const role = await prisma.adminRole.findUnique({ where: { key }, include: { users: true } });
      expect(role).not.toBeNull();
      expect(role!.users).toEqual([]);
    }
  });

  it('operator reads overview, auditor reads everything, viewer sees no finance', async () => {
    const operator = await createOperator('FINANCE_OPERATOR');
    const auditor = await createOperator('FINANCE_AUDITOR');
    const viewer = await createOperator('VIEWER');
    expect((await api.get(`${CMS}/finance/overview`).set('Authorization', operator.auth)).status).toBe(200);
    expect((await api.get(`${CMS}/finance/audit`).set('Authorization', auditor.auth)).status).toBe(200);
    expect((await api.get(`${CMS}/finance/overview`).set('Authorization', viewer.auth)).status).toBe(403);
    expect((await api.get(`${CMS}/finance/audit`).set('Authorization', viewer.auth)).status).toBe(403);
  });

  it('manager keeps read-only finance (overview only) and cannot approve', async () => {
    const manager = await createOperator('MANAGER');
    expect((await api.get(`${CMS}/finance/overview`).set('Authorization', manager.auth)).status).toBe(200);
    // No mutation routes exist in Phase 1; the manager matrix holds no approve grant.
    const roles = await prisma.adminRole.findUnique({ where: { key: 'MANAGER' }, include: { permissions: true } });
    const perms = roles!.permissions.map((p) => p.permission);
    expect(perms).toContain('bill-overview:view');
    expect(perms.some((p) => p.startsWith('bill-') && p.endsWith(':approve'))).toBe(false);
  });
});

describe('finance overview', () => {
  beforeEach(resetDb);

  it('reports real KPIs on accrual basis with lineage', async () => {
    const operator = await createOperator('FINANCE_OPERATOR');
    await seedLedgerWorld();
    const res = await api
      .get(`${CMS}/finance/overview?from=2026-09-01&to=2026-09-30&basis=accrual`)
      .set('Authorization', operator.auth);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.data.kpis.map((k: any) => [k.key, k]));
    expect(byKey.revenueBilled.value).toBe(400); // two September invoices
    expect(byKey.accountsReceivable.value).toBe(400); // DUE + OVERDUE open balances
    expect(byKey.overdueBalance.value).toBe(200);
    expect(byKey.newSignups.value).toBe(1);
    expect(byKey.occupiedUnits.value).toBe(1);
    expect(byKey.moveIns.value).toBe(1);
    expect(byKey.moveOuts.value).toBe(1);
    // F-7: failed payments + credits & refunds read live ledgers (zero is measured).
    expect(byKey.failedPayments.connected).toBe(true);
    expect(byKey.failedPayments.value).toBe(0);
    expect(byKey.creditsRefunds.connected).toBe(true);
    expect(byKey.creditsRefunds.value).toBe(0);
    expect(byKey.cashCollected.value).toBe(200); // the one PAID September invoice
    // Every connected KPI carries definition + source + refresh.
    for (const k of res.body.data.kpis) {
      expect(k.lineage.definition.length).toBeGreaterThan(0);
      expect(k.lineage.source.length).toBeGreaterThan(0);
    }
    expect(res.body.data.collectionTrend).toHaveLength(6);
  });

  it('cash basis reports collected cash instead of billed revenue', async () => {
    const operator = await createOperator('FINANCE_OPERATOR');
    await seedLedgerWorld();
    const res = await api
      .get(`${CMS}/finance/overview?from=2026-09-01&to=2026-09-30&basis=cash`)
      .set('Authorization', operator.auth);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.data.kpis.map((k: any) => [k.key, k]));
    // F-7: Revenue billed and Cash collected are separate KPIs under both bases.
    expect(byKey.revenueBilled.value).toBe(400); // two September invoices billed
    expect(byKey.cashCollected.value).toBe(200); // the one PAID September invoice
    // AR is a ledger balance under both bases — never relabelled as cash.
    expect(byKey.accountsReceivable.value).toBe(400);
  });

  it('rejects garbage filters and requires auth', async () => {
    const operator = await createOperator('FINANCE_OPERATOR');
    expect((await api.get(`${CMS}/finance/overview?from=nope`).set('Authorization', operator.auth)).status).toBe(400);
    expect((await api.get(`${CMS}/finance/overview?basis=whatever`).set('Authorization', operator.auth)).status).toBe(400);
    expect((await api.get(`${CMS}/finance/overview`)).status).toBe(401);
  });
});

describe('finance export + audit + outbox', () => {
  beforeEach(resetDb);

  it('export downloads CSV and writes a correlated audit event + outbox row', async () => {
    const operator = await createOperator('FINANCE_OPERATOR');
    const { branch } = await seedLedgerWorld();
    const res = await api
      .get(`${CMS}/finance/overview/export.csv?from=2026-09-01&to=2026-09-30&branchId=${branch.id}`)
      .set('Authorization', operator.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toMatch(/^kpi,value,connected,source/m);
    expect(res.text).toMatch(/Revenue billed,400,yes/);

    const audits = await prisma.financeAuditEvent.findMany({ where: { entityType: 'finance-overview' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('EXPORT_GENERATED');
    expect(audits[0].actor).toBe(operator.email);
    const events = await prisma.financeEvent.findMany({ where: { type: 'export.generated' } });
    expect(events).toHaveLength(1);
    // Correlation links cause and effect across the two stores.
    expect(events[0].correlationId).toBe(audits[0].correlationId);
  });

  it('writes audit + outbox in the same transaction (rollback removes both)', async () => {
    const correlationId = newCorrelationId();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.financeAuditEvent.create({
          data: { actor: 'e2e', action: 'TEST', entityType: 't', entityId: '1', correlationId },
        });
        await tx.financeEvent.create({ data: { type: 'test', payload: {}, correlationId } });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await prisma.financeAuditEvent.count({ where: { correlationId } })).toBe(0);
    expect(await prisma.financeEvent.count({ where: { correlationId } })).toBe(0);
  });

  it('audit is append-only: no update/delete path exists', async () => {
    const operator = await createOperator('FINANCE_OPERATOR');
    expect((await api.post(`${CMS}/finance/audit`).set('Authorization', operator.auth).send({})).status).toBe(404);
    expect((await api.patch(`${CMS}/finance/audit/x`).set('Authorization', operator.auth).send({})).status).toBe(404);
    expect((await api.delete(`${CMS}/finance/audit/x`).set('Authorization', operator.auth)).status).toBe(404);
  });

  it('audit reads filter by entity and correlation', async () => {
    const operator = await createOperator('FINANCE_OPERATOR');
    const correlationId = newCorrelationId();
    await prisma.financeAuditEvent.create({
      data: { actor: 'e2e', action: 'CHARGE_APPROVED', entityType: 'payment-instruction', entityId: 'pi_1', correlationId },
    });
    const res = await api.get(`${CMS}/finance/audit?correlationId=${correlationId}`).set('Authorization', operator.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ action: 'CHARGE_APPROVED', entityId: 'pi_1' });
  });
});

describe('finance mutation guards', () => {
  it('optimistic lock: stale versions conflict, fresh versions pass', () => {
    expect(() => assertFreshVersion(3, 2, 'FinancialModel')).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => assertFreshVersion(3, 3, 'FinancialModel')).not.toThrow();
    expect(() => assertFreshVersion(3, undefined, 'FinancialModel')).not.toThrow();
    expect(() => assertFreshVersion(3, 1.5, 'FinancialModel')).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('idempotency keys parse from headers; correlation ids are unique', () => {
    expect(getIdempotencyKey({ 'idempotency-key': '  k1 ' })).toBe('k1');
    expect(getIdempotencyKey({})).toBeNull();
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });

  it('customer invoice lifecycle is unchanged (no DRAFT in Phase 1)', async () => {
    await expect(
      prisma.invoice.create({
        data: { invoiceNo: 'INV-NOPE', tenantId: 'x', unitId: 'y', amount: 1, dueDate: new Date(), status: 'DRAFT' as never },
      }),
    ).rejects.toThrow();
  });
});

// A-2 register filters (handoff 12): Period (?from=&to=, incl. custom range)
// and Unit type (?unitType=UnitSize code) filter the Finance Transactions
// register server-side, combine with the existing filters, and keep the
// facility scope intact.

import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb, seedMoveInWorld, uniqueEmail, type Operator } from './fixtures';

const CMS = '/api/v1/cms';
const today = () => new Date().toISOString().slice(0, 10);

let owner: Operator;

async function makeSetup() {
  const world = await seedMoveInWorld();
  const smallSize = await prisma.unitSize.findFirstOrThrow({ where: { code: 'SMALL' } });
  const lockerSize = await prisma.unitSize.create({
    data: { code: 'LOCKER', name: 'Locker', sqftFrom: 8, sqftTo: 15, widthFt: 3, heightFt: 4, sortOrder: 1 },
  });
  const now = new Date();
  let seq = 0;
  async function invoiceFor(sizeId: string, tag: string) {
    seq += 1;
    const unit = await prisma.unit.create({
      data: {
        branchId: world.branchId,
        floorId: world.floorId,
        sizeId,
        unitCode: `REG-E2E-${tag}-${seq}`,
        sqft: 50,
        monthlyRate: 100,
        status: 'AVAILABLE',
      },
    });
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Register Filter',
        email: uniqueEmail(),
        mobile: '81234567',
        unitId: unit.id,
        moveInDate: new Date('2026-09-14T00:00:00.000Z'),
        monthlyRate: 100,
        psf: 2,
        status: 'ACTIVE',
        branchId: world.branchId,
      },
    });
    return prisma.invoice.create({
      data: {
        invoiceNo: `INV-REG-${tag}-${seq}`,
        tenantId: tenant.id,
        unitId: unit.id,
        amount: 100,
        dueDate: now,
        billedMonth: now,
        issuedAt: now,
      },
    });
  }
  const small = await invoiceFor(smallSize.id, 'SMALL');
  const locker = await invoiceFor(lockerSize.id, 'LOCKER');
  return { small, locker };
}

beforeEach(async () => {
  await resetDb();
  owner = await createOperator('OWNER');
});

async function register(query: Record<string, string>) {
  const res = await api.get(`${CMS}/finance/register`).set('Authorization', owner.auth).query(query);
  expect(res.status).toBe(200);
  return res.body.data as { rows: Array<Record<string, unknown>>; summary: Record<string, number> };
}

describe('finance register Period + Unit-type filters', () => {
  it('carries unitType/unitTypeLabel on every row', async () => {
    const { small } = await makeSetup();
    const { rows } = await register({ search: small.invoiceNo });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ unitType: 'SMALL', unitTypeLabel: 'Small' });
  });

  it('unitType filters server-side', async () => {
    await makeSetup();
    const smallOnly = await register({ unitType: 'SMALL', docType: 'Invoice' });
    expect(smallOnly.rows.length).toBeGreaterThan(0);
    expect(smallOnly.rows.every((r) => r.unitType === 'SMALL')).toBe(true);
    const lockerOnly = await register({ unitType: 'LOCKER', docType: 'Invoice' });
    expect(lockerOnly.rows.length).toBe(1);
    expect(lockerOnly.rows[0]).toMatchObject({ unitType: 'LOCKER', unitTypeLabel: 'Locker' });
    expect(await register({ unitType: 'NOPE' })).toMatchObject({ rows: [] });
  });

  it('Period from/to filters server-side, including an empty custom range', async () => {
    const { small } = await makeSetup();
    const t = today();
    const inToday = await register({ from: t, to: t, search: small.invoiceNo });
    expect(inToday.rows.length).toBe(1);
    // A custom range with no records yields zero rows (the UI renders the
    // handoff 12 caring copy: `No records match these filters.`).
    expect(await register({ from: '2000-01-01', to: '2000-01-02' })).toMatchObject({ rows: [] });
  });

  it('combined Period + Unit-type + Doc-type filters narrow together', async () => {
    const t = today();
    const { locker } = await makeSetup();
    const { rows } = await register({ from: t, to: t, unitType: 'LOCKER', docType: 'Invoice' });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ recordId: locker.invoiceNo });
    // Same unit type but a range with no records → empty.
    const empty = await register({ from: '2000-01-01', to: '2000-01-02', unitType: 'LOCKER', docType: 'Invoice' });
    expect(empty.rows).toEqual([]);
  });

  it('rejects a malformed Period bound', async () => {
    await makeSetup();
    const res = await api.get(`${CMS}/finance/register`).set('Authorization', owner.auth).query({ from: 'not-a-date' });
    expect(res.status).toBe(400);
  });
});

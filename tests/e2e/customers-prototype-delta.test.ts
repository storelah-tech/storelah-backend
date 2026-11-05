// Customers prototype delta (2026-11-04 handover): profile lifecycle facts,
// unit ledger, transfer + move-out settlements (owner-confirmed proration:
// transfer day billed on the new unit, last access day charged, Protection
// Plan never prorated, deposit $0) and Finance maker-checker approval.

import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb, uniqueEmail } from './fixtures';
import { calculateMoveOut, calculateTransfer, commitmentEnd, remainingText } from '../../src/core/customerProfile';

const CMS = '/api/v1/cms';
const day = (v: string) => new Date(`${v}T00:00:00.000Z`);

describe('settlement calculations (handover worked examples)', () => {
  it('transfer on 20 Nov: credit 117.33, charge 154.44, customer pays 37.11', () => {
    const r = calculateTransfer({ date: day('2026-11-20'), currentRent: 320, currentDeposit: 0, destGross: 468, destPromoPct: 10, destDeposit: 0, destProtection: 12.5 });
    expect(r.remainingDays).toBe(11);
    expect(r.lines[0].amount).toBe(-117.33);
    expect(r.lines[1].amount).toBe(154.44);
    expect(r.total).toBe(37.11);
    expect(r.nextFullDeduction).toBe(433.7);
  });

  it('move-out with last access 20 Nov refunds 106.67; a $150 damage charge turns it into a 43.33 charge', () => {
    const r = calculateMoveOut({ lastDay: day('2026-11-20'), rent: 320, deposit: 0 });
    expect(r).toMatchObject({ unusedDays: 10, closing: 106.67, total: -106.67, outcome: 'REFUND' });
    const c = calculateMoveOut({ lastDay: day('2026-11-20'), rent: 320, deposit: 0, adjustment: { type: 'CHARGE', category: 'Damage to unit / door', amount: 150, reason: 'Door dent' } });
    expect(c).toMatchObject({ closing: -43.33, total: 43.33, outcome: 'CHARGE' });
    expect(() => calculateMoveOut({ lastDay: day('2026-11-20'), rent: 320, deposit: 0, adjustment: { type: 'CHARGE', category: 'Other', amount: 5, reason: ' ' } })).toThrow(/reason/);
  });

  it('commitment end and time remaining', () => {
    expect(commitmentEnd(day('2026-09-14'), 6).toISOString().slice(0, 10)).toBe('2027-03-13');
    expect(remainingText(day('2027-03-13'), day('2026-11-04'))).toBe('4 months 9 days');
    expect(remainingText(day('2026-07-07'), day('2026-11-04'))).toBe('Commitment completed');
  });
});

async function seedCustomer() {
  const size = await prisma.unitSize.create({ data: { code: 'CUS-S', name: 'Small', sqftFrom: 10, sqftTo: 60, sortOrder: 1 } });
  const branch = await prisma.branch.create({ data: { code: 'CU', name: 'Customer E2E', address: '1 Customer Rd', operatingHours: '9-9' } });
  const floor = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'L1' } });
  const unit = await prisma.unit.create({ data: { branchId: branch.id, floorId: floor.id, sizeId: size.id, unitCode: 'CU-01-01', sqft: 40, monthlyRate: 320, status: 'OCCUPIED' } });
  const dest = await prisma.unit.create({ data: { branchId: branch.id, floorId: floor.id, sizeId: size.id, unitCode: 'CU-01-02', sqft: 60, monthlyRate: 468, status: 'AVAILABLE' } });
  const email = uniqueEmail();
  const tenant = await prisma.tenant.create({
    data: { name: 'Sarah Tan', email, mobile: '91234821', unitId: unit.id, moveInDate: day('2026-09-14'), monthlyRate: 320, psf: 8, status: 'ACTIVE', branchId: branch.id },
  });
  await prisma.booking.create({ data: { bookingRef: 'BK-CUS-1', tenantId: tenant.id, unitId: unit.id, moveInDate: day('2026-09-14'), duration: '6 months', amount: 320, status: 'CONFIRMED', paidAt: day('2026-09-12') } });
  await prisma.invoice.create({ data: { invoiceNo: 'INV-CUS-1', tenantId: tenant.id, unitId: unit.id, amount: 320, dueDate: day('2026-10-14'), billedMonth: day('2026-10-01'), status: 'PAID', paidAt: day('2026-10-14'), amountPaid: 320 } });
  return { tenant, unit, dest };
}

describe('customer profile and settlements', () => {
  beforeEach(resetDb);

  it('profiles agreement, commitment, rent and the unit ledger', async () => {
    const { tenant } = await seedCustomer();
    const op = await createOperator('OWNER');
    const res = await api.get(`${CMS}/tenants/${tenant.id}/profile`).set('Authorization', op.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.units[0]).toMatchObject({
      unitCode: 'CU-01-01', agreementSigned: '2026-09-12', moveIn: '2026-09-14', commitmentMonths: 6,
      commitmentEnd: '2027-03-13', netRent: 320, deposit: 0, billingFrequency: 'Monthly',
    });
    expect(res.body.data.ledger.map((l: { lineItem: string }) => l.lineItem)).toEqual(expect.arrayContaining(['Payment allocation']));
    expect(res.body.data.revenueToDate).toBe(320);
  });

  it('submits a transfer for Finance approval without touching the unit, with maker-checker', async () => {
    const { tenant, unit, dest } = await seedCustomer();
    const maker = await createOperator('OWNER');
    const preview = await api.post(`${CMS}/tenants/${tenant.id}/settlements/preview`).set('Authorization', maker.auth)
      .send({ kind: 'TRANSFER', date: '2026-11-20', toUnitId: dest.id, destPromoPct: 10, destProtection: 12.5 });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ amount: 37.11, nextFullDeduction: 433.7, to: 'CU-01-02' });

    const sub = await api.post(`${CMS}/tenants/${tenant.id}/settlements`).set('Authorization', maker.auth)
      .send({ kind: 'TRANSFER', date: '2026-11-20', toUnitId: dest.id, destPromoPct: 10, destProtection: 12.5 });
    expect(sub.status).toBe(201);
    expect(sub.body.data).toMatchObject({ docType: 'Transfer approval', status: 'PENDING', amount: 37.11 });
    expect(sub.body.data.ref).toMatch(/^TRF-\d{7}$/);
    expect((await prisma.tenant.findUnique({ where: { id: tenant.id } }))!.unitId).toBe(unit.id);
    expect((await api.post(`${CMS}/tenants/${tenant.id}/settlements`).set('Authorization', maker.auth)
      .send({ kind: 'TRANSFER', date: '2026-11-20', toUnitId: dest.id })).status).toBe(409);

    expect((await api.post(`${CMS}/finance/settlements/${sub.body.data.id}/approve`).set('Authorization', maker.auth).send({})).status).toBe(403);
    const checker = await createOperator('FINANCE_APPROVER');
    const queue = await api.get(`${CMS}/finance/settlements?status=PENDING`).set('Authorization', checker.auth);
    expect(queue.body.data).toHaveLength(1);
    const ok = await api.post(`${CMS}/finance/settlements/${sub.body.data.id}/approve`).set('Authorization', checker.auth).send({});
    expect(ok.body.data.status).toBe('APPROVED');
  });

  it('move-out uses and locks a portal notice date, else requires a staff-entered date', async () => {
    const { tenant, unit } = await seedCustomer();
    const op = await createOperator('OWNER');
    const missing = await api.post(`${CMS}/tenants/${tenant.id}/settlements/preview`).set('Authorization', op.auth).send({ kind: 'MOVE_OUT' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/last day of access/);
    const staff = await api.post(`${CMS}/tenants/${tenant.id}/settlements`).set('Authorization', op.auth)
      .send({ kind: 'MOVE_OUT', lastDay: '2026-11-20', channel: 'WhatsApp', adjustment: { type: 'CHARGE', category: 'Damage to unit / door', amount: 150, reason: 'Door dent' } });
    expect(staff.body.data).toMatchObject({ docType: 'Charge', amount: 43.33, channel: 'WhatsApp' });
    expect(staff.body.data.ref).toMatch(/^CH-\d{7}$/);

    await prisma.customerSettlement.deleteMany();
    await prisma.notice.create({ data: { tenantId: tenant.id, unitId: unit.id, lastDay: day('2026-11-15') } });
    const portal = await api.post(`${CMS}/tenants/${tenant.id}/settlements/preview`).set('Authorization', op.auth)
      .send({ kind: 'MOVE_OUT', lastDay: '2026-11-28', channel: 'Phone' });
    expect(portal.body.data).toMatchObject({ portalLocked: true, lastDay: '2026-11-15', docType: 'Refund', amount: -160 });
  });

  it('records service requests on the customer timeline', async () => {
    const { tenant } = await seedCustomer();
    const op = await createOperator('OWNER');
    const r = await api.post(`${CMS}/tenants/${tenant.id}/service-requests`).set('Authorization', op.auth).send({ type: 'Moving service', preferredDate: '2026-11-20', details: '2 movers' });
    expect(r.status).toBe(201);
    const notes = await api.get(`${CMS}/tenants/${tenant.id}/notes`).set('Authorization', op.auth);
    expect(notes.body.data[0].body).toMatch(/^Service request · Moving service/);
  });
});

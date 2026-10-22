// TN-06 (2026-10-22): a tenant created or assigned in the CMS takes its unit
// off the market (OCCUPIED / OVERDUE) so online checkout can't book it and
// never drops the tenant's link; every release path frees the unit again.

import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, futureMoveInISO, prisma, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';
import { createTenant, deactivateTenant, transitionMoveOut, updateTenant } from '../../src/core/tenants';

const unitByCode = (unitCode: string) => prisma.unit.findUniqueOrThrow({ where: { unitCode } });
const statusOf = async (unitCode: string) => (await unitByCode(unitCode)).status;

async function guestBooking(unitCode: string) {
  return api.post('/api/v1/customer/bookings').send({
    unitCode, moveInDate: futureMoveInISO(), durationMonths: 1, email: uniqueEmail(), name: 'Online Booker', mobile: '81234567',
  });
}

describe('tenant ↔ unit hold (TN-06)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('a CMS tenant with a unit marks it OCCUPIED and online checkout cannot take it', async () => {
    const unit = await unitByCode(PIN.rentableUnit);
    const t = await createTenant({ name: 'Walk-in', unitId: unit.id, monthlyRate: 120, moveInDate: new Date() });
    expect(await statusOf(PIN.rentableUnit)).toBe('OCCUPIED');

    const res = await guestBooking(PIN.rentableUnit);
    expect(res.status).toBe(409);
    // The walk-in tenant keeps the unit.
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })).unitId).toBe(unit.id);
  });

  it('an OVERDUE tenant holds the unit as OVERDUE; status edits follow the tenant', async () => {
    const unit = await unitByCode(PIN.rentableUnit);
    const t = await createTenant({ name: 'Late payer', unitId: unit.id, monthlyRate: 120, status: 'OVERDUE' });
    expect(await statusOf(PIN.rentableUnit)).toBe('OVERDUE');
    await updateTenant(t.id, { status: 'ACTIVE' });
    expect(await statusOf(PIN.rentableUnit)).toBe('OCCUPIED');
    await updateTenant(t.id, { status: 'OVERDUE' });
    expect(await statusOf(PIN.rentableUnit)).toBe('OVERDUE');
  });

  it('reassigning frees the old unit and holds the new one; unassigning frees it', async () => {
    const a = await unitByCode(PIN.rentableUnit);
    const b = await unitByCode(PIN.guestUnit);
    const t = await createTenant({ name: 'Mover', unitId: a.id, monthlyRate: 120 });
    await updateTenant(t.id, { unitId: b.id });
    expect(await statusOf(PIN.rentableUnit)).toBe('AVAILABLE');
    expect(await statusOf(PIN.guestUnit)).toBe('OCCUPIED');
    await updateTenant(t.id, { unitId: null });
    expect(await statusOf(PIN.guestUnit)).toBe('AVAILABLE');
    // The freed unit is bookable online again.
    expect((await guestBooking(PIN.guestUnit)).status).toBe(201);
  });

  it('deactivation and a completed move-out release the unit', async () => {
    const a = await unitByCode(PIN.rentableUnit);
    const b = await unitByCode(PIN.guestUnit);
    const t1 = await createTenant({ name: 'Leaving', unitId: a.id, monthlyRate: 120 });
    await deactivateTenant(t1.id);
    expect(await statusOf(PIN.rentableUnit)).toBe('AVAILABLE');

    const t2 = await createTenant({ name: 'On notice', unitId: b.id, monthlyRate: 130, status: 'NOTICE' });
    expect(await statusOf(PIN.guestUnit)).toBe('OCCUPIED');
    await transitionMoveOut(t2.id, 'complete');
    expect(await statusOf(PIN.guestUnit)).toBe('AVAILABLE');
  });

  it('a unit with a pending online booking cannot be assigned in the CMS', async () => {
    expect((await guestBooking(PIN.rentableUnit)).status).toBe(201);
    const unit = await unitByCode(PIN.rentableUnit);
    await expect(createTenant({ name: 'Too late', unitId: unit.id, monthlyRate: 120 }))
      .rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(await statusOf(PIN.rentableUnit)).toBe('AVAILABLE');
  });

  it('the CMS API marks the unit OCCUPIED on POST /tenants', async () => {
    const unit = await unitByCode(PIN.rentableUnit);
    // The e2e world seeds no operator — create one for this request.
    const email = uniqueEmail();
    const password = 'e2e-operator-1';
    await prisma.adminUser.create({ data: { email, name: 'E2E Operator', passwordHash: await bcrypt.hash(password, 4) } });
    const res = await api.post('/api/v1/cms/login').send({ email, password });
    expect(res.status).toBe(200);
    const created = await api
      .post('/api/v1/cms/tenants')
      .set('Authorization', `Bearer ${res.body.data.token}`)
      .send({ name: 'API walk-in', unitId: unit.id, monthlyRate: 120 });
    expect(created.status).toBe(201);
    expect(await statusOf(PIN.rentableUnit)).toBe('OCCUPIED');
  });
});

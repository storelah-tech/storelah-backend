// Move-in E2E (edge cases): double-booking, non-rentable / missing units,
// payload validation, auth enforcement (never a guest fallback), duplicate
// registration, and floor-plan empty/unknown states. All assertions pin the
// stable error contract: { error: { code, message } } with codes VALIDATION /
// UNAUTHORIZED / NOT_FOUND / CONFLICT.

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, futureMoveInISO, prisma, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';

async function register(email: string): Promise<string> {
  const res = await api
    .post('/api/v1/customer/register')
    .send({ name: 'E2E Edge', email, mobile: '80001111', password: 'e2e-password-1' });
  expect(res.status).toBe(201);
  return res.body.data.token as string;
}

describe('move-in edge cases', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('second user double-booking the same unit → 409 CONFLICT', async () => {
    const tokenA = await register(uniqueEmail());
    const first = await api
      .post('/api/v1/customer/bookings')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ unitCode: PIN.rentableUnit, moveInDate: futureMoveInISO(), durationMonths: 1 });
    expect(first.status).toBe(201);

    const tokenB = await register(uniqueEmail());
    const second = await api
      .post('/api/v1/customer/bookings')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ unitCode: PIN.rentableUnit, moveInDate: futureMoveInISO(), durationMonths: 1 });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');

    // Exactly one booking exists for the unit — no partial second write.
    const count = await prisma.booking.count({
      where: { unit: { unitCode: PIN.rentableUnit } },
    });
    expect(count).toBe(1);
  });

  it.each([
    ['OCCUPIED', PIN.occupiedUnit],
    ['BLOCKED', PIN.blockedUnit],
    ['MAINTENANCE', PIN.maintenanceUnit],
  ])('%s unit cannot be booked → 409 CONFLICT', async (_label, unitCode) => {
    const token = await register(uniqueEmail());
    const res = await api
      .post('/api/v1/customer/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ unitCode, moveInDate: futureMoveInISO(), durationMonths: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('soft-deleted unit cannot be booked → 404 NOT_FOUND', async () => {
    const token = await register(uniqueEmail());
    const res = await api
      .post('/api/v1/customer/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ unitCode: PIN.deletedUnit, moveInDate: futureMoveInISO(), durationMonths: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('missing unit code → 404 NOT_FOUND', async () => {
    const token = await register(uniqueEmail());
    const res = await api
      .post('/api/v1/customer/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ unitCode: 'BM-01-99', moveInDate: futureMoveInISO(), durationMonths: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('bad payload → 400 VALIDATION; guest without email → 400 VALIDATION', async () => {
    const token = await register(uniqueEmail());

    const missingUnit = await api
      .post('/api/v1/customer/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ moveInDate: futureMoveInISO(), durationMonths: 1 });
    expect(missingUnit.status).toBe(400);
    expect(missingUnit.body.error.code).toBe('VALIDATION');

    const badDuration = await api
      .post('/api/v1/customer/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ unitCode: PIN.rentableUnit, moveInDate: futureMoveInISO(), durationMonths: -2 });
    expect(badDuration.status).toBe(400);
    expect(badDuration.body.error.code).toBe('VALIDATION');

    const badDate = await api
      .post('/api/v1/customer/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ unitCode: PIN.rentableUnit, moveInDate: 'not-a-date', durationMonths: 1 });
    expect(badDate.status).toBe(400);
    expect(badDate.body.error.code).toBe('VALIDATION');

    // Guest checkout without an email cannot provision an account.
    const guestNoEmail = await api.post('/api/v1/customer/bookings').send({
      unitCode: PIN.rentableUnit,
      moveInDate: futureMoveInISO(),
      durationMonths: 1,
      name: 'No Email',
    });
    expect(guestNoEmail.status).toBe(400);
    expect(guestNoEmail.body.error.code).toBe('VALIDATION');
  });

  it('portal/bookings without token or with a garbage token → 401, never guest fallback', async () => {
    const noTokenPortal = await api.get('/api/v1/customer/portal');
    expect(noTokenPortal.status).toBe(401);
    expect(noTokenPortal.body.error.code).toBe('UNAUTHORIZED');

    const noTokenBookings = await api.get('/api/v1/customer/bookings');
    expect(noTokenBookings.status).toBe(401);
    expect(noTokenBookings.body.error.code).toBe('UNAUTHORIZED');

    const garbagePortal = await api
      .get('/api/v1/customer/portal')
      .set('Authorization', 'Bearer this-is-not-a-token');
    expect(garbagePortal.status).toBe(401);

    // A present-but-invalid token on booking is a hard 401 — the request must
    // NOT be downgraded to guest checkout (which would create a booking).
    const before = await prisma.booking.count();
    const invalidBooking = await api
      .post('/api/v1/customer/bookings')
      .set('Authorization', 'Bearer this-is-not-a-token')
      .send({ unitCode: PIN.rentableUnit, moveInDate: futureMoveInISO(), durationMonths: 1, email: uniqueEmail() });
    expect(invalidBooking.status).toBe(401);
    expect(invalidBooking.body.error.code).toBe('UNAUTHORIZED');
    expect(await prisma.booking.count()).toBe(before);
  });

  it('duplicate registration → 409 CONFLICT', async () => {
    const email = uniqueEmail();
    await register(email);
    const dup = await api
      .post('/api/v1/customer/register')
      .send({ name: 'E2E Dup', email, password: 'e2e-password-1' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('AVAILABLE unit with a dangling tenant link is still bookable → 201 (list truth wins)', async () => {
    // Regression: the public list is Unit.status-sourced, so a unit marketed
    // AVAILABLE must stay bookable even when a stale Tenant.unitId row still
    // references it (bulk status reset / operator status edit that bypassed
    // the release paths). The dangling link is released in-transaction.
    const stale = await prisma.tenant.create({
      data: {
        name: 'E2E Dangling',
        type: 'PERSONAL',
        email: uniqueEmail(),
        monthlyRate: 120,
        psf: 2.4,
        status: 'ACTIVE',
        unit: { connect: { unitCode: PIN.rentableUnit } },
      },
    });

    const token = await register(uniqueEmail());
    const res = await api
      .post('/api/v1/customer/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ unitCode: PIN.rentableUnit, moveInDate: futureMoveInISO(), durationMonths: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.unit.code).toBe(PIN.rentableUnit);

    // Dangling row preserved, link released; unit flipped to RESERVED as usual.
    const released = await prisma.tenant.findUnique({ where: { id: stale.id } });
    expect(released).not.toBeNull();
    expect(released!.unitId).toBeNull();
    const unit = await prisma.unit.findUnique({ where: { unitCode: PIN.rentableUnit } });
    expect(unit!.status).toBe('RESERVED');
  });

  it('RESERVED unit with a foreign tenant link still rejects → 409 CONFLICT', async () => {
    // The genuine-hold counterpart to the test above: a marketed-as-held unit
    // keeps the second-customer double-booking guard (status gate passes
    // RESERVED; the tenant-link gate must still fire).
    const holder = await prisma.tenant.create({
      data: {
        name: 'E2E Holder',
        type: 'PERSONAL',
        email: uniqueEmail(),
        monthlyRate: 120,
        psf: 2.4,
        status: 'ACTIVE',
        unit: { connect: { unitCode: PIN.rentableUnit } },
      },
    });
    await prisma.unit.update({ where: { unitCode: PIN.rentableUnit }, data: { status: 'RESERVED' } });

    const token = await register(uniqueEmail());
    const res = await api
      .post('/api/v1/customer/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ unitCode: PIN.rentableUnit, moveInDate: futureMoveInISO(), durationMonths: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');

    // Hold untouched: link and status preserved.
    const kept = await prisma.tenant.findUnique({ where: { id: holder.id } });
    expect(kept!.unitId).not.toBeNull();
    const unit = await prisma.unit.findUnique({ where: { unitCode: PIN.rentableUnit } });
    expect(unit!.status).toBe('RESERVED');
  });

  it('floor without an authored plan → 200 with plan:null (empty state)', async () => {
    const res = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/${PIN.planlessLevel}`);
    expect(res.status).toBe(200);
    expect(res.body.data.plan).toBeNull();
    expect(res.body.data.floor.level).toBe(PIN.planlessLevel);
  });

  it('unknown branch / level → 404 NOT_FOUND; invalid level → 400 VALIDATION', async () => {
    const unknownBranch = await api.get(`/api/v1/public/floor-plans/ZZ/${PIN.level}`);
    expect(unknownBranch.status).toBe(404);
    expect(unknownBranch.body.error.code).toBe('NOT_FOUND');

    const unknownLevel = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/99`);
    expect(unknownLevel.status).toBe(404);
    expect(unknownLevel.body.error.code).toBe('NOT_FOUND');

    const invalidLevel = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/0`);
    expect(invalidLevel.status).toBe(400);
    expect(invalidLevel.body.error.code).toBe('VALIDATION');
  });
});

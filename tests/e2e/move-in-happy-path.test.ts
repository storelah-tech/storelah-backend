// Move-in E2E (happy path, authenticated): user rents a unit → persisted in
// the backend DB → visible via the customer portal, using the real floor-plan
// layout. Exercises the exact contracts storelah-booking consumes:
//   GET /api/v1/public/units?branch=&level=&status=
//   GET /api/v1/public/floor-plans/:branchCode/:level
//   POST /api/v1/customer/register | /login
//   POST /api/v1/customer/bookings (Bearer)
//   GET /api/v1/customer/portal | /bookings

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, futureMoveInISO, prisma, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';

describe('move-in happy path (authenticated)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('public units lists the rentable unit', async () => {
    const res = await api
      .get('/api/v1/public/units')
      .query({ branch: PIN.branchCode, level: PIN.level, status: 'AVAILABLE' });

    expect(res.status).toBe(200);
    const codes = (res.body.data as Array<{ unitCode: string }>).map((u) => u.unitCode);
    expect(codes).toContain(PIN.rentableUnit);
    // Soft-deleted units never surface in public reads.
    expect(codes).not.toContain(PIN.deletedUnit);
    // Non-browseable statuses never surface either.
    expect(codes).not.toContain(PIN.occupiedUnit);
    expect(codes).not.toContain(PIN.blockedUnit);
  });

  it('register → login → authed booking → persisted → portal-visible', async () => {
    // 1. The real plan contains the unit's placement (the layout the booking
    //    renderer draws — joined live to unitCode/status, no PII).
    const planRes = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/${PIN.level}`);
    expect(planRes.status).toBe(200);
    expect(planRes.body.data.plan).not.toBeNull();
    const placements = planRes.body.data.plan.placements as Array<{
      unit: { unitCode: string; status: string };
    }>;
    const placed = placements.find((p) => p.unit.unitCode === PIN.rentableUnit);
    expect(placed).toBeDefined();
    expect(placed!.unit.status).toBe('AVAILABLE');

    // 2. Register + login issue a usable Bearer token.
    const email = uniqueEmail();
    const password = 'e2e-password-1';
    const reg = await api
      .post('/api/v1/customer/register')
      .send({ name: 'E2E Renter', email, mobile: '81234567', password });
    expect(reg.status).toBe(201);
    expect(reg.body.data.token).toBeTruthy();

    const login = await api.post('/api/v1/customer/login').send({ email, password });
    expect(login.status).toBe(200);
    const token = login.body.data.token as string;
    expect(token).toBeTruthy();

    // 3. Authenticated booking → 201 PENDING_PAYMENT.
    const moveInDate = futureMoveInISO();
    const booking = await api
      .post('/api/v1/customer/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ unitCode: PIN.rentableUnit, moveInDate, durationMonths: 3 });
    expect(booking.status).toBe(201);
    expect(booking.body.data.status).toBe('PENDING_PAYMENT');
    expect(booking.body.data.unit.code).toBe(PIN.rentableUnit);
    const bookingRef = booking.body.data.bookingRef as string;
    expect(bookingRef).toMatch(/^SL-/);

    // 4. DB asserts: Booking (unique ref) + Tenant email linkage + DUE
    //    invoice + unit flipped to RESERVED.
    const dbBooking = await prisma.booking.findUnique({
      where: { bookingRef },
      include: { tenant: true, unit: true },
    });
    expect(dbBooking).not.toBeNull();
    expect(dbBooking!.tenant.email).toBe(email);
    expect(dbBooking!.unit.unitCode).toBe(PIN.rentableUnit);

    const refs = await prisma.booking.findMany({ select: { bookingRef: true } });
    expect(new Set(refs.map((r) => r.bookingRef)).size).toBe(refs.length);

    const invoices = await prisma.invoice.findMany({ where: { tenantId: dbBooking!.tenantId } });
    expect(invoices.length).toBeGreaterThan(0);
    expect(invoices[0].status).toBe('DUE');
    expect(Number(invoices[0].amount)).toBeGreaterThan(0);

    const unit = await prisma.unit.findUnique({ where: { unitCode: PIN.rentableUnit } });
    expect(unit!.status).toBe('RESERVED');

    // 5. Portal + bookings show the rented unit.
    const portal = await api.get('/api/v1/customer/portal').set('Authorization', `Bearer ${token}`);
    expect(portal.status).toBe(200);
    expect(portal.body.data.unit?.code ?? portal.body.data.unit?.id).toBe(PIN.rentableUnit);
    expect((portal.body.data.bookings as Array<{ bookingRef: string }>).map((b) => b.bookingRef)).toContain(
      bookingRef,
    );

    const bookings = await api.get('/api/v1/customer/bookings').set('Authorization', `Bearer ${token}`);
    expect(bookings.status).toBe(200);
    const refs2 = (bookings.body.data as Array<{ bookingRef: string; unitCode: string }>).map((b) => b.bookingRef);
    expect(refs2).toContain(bookingRef);
    expect(
      (bookings.body.data as Array<{ unitCode: string }>).find((b) => b.bookingRef === bookingRef)?.unitCode,
    ).toBe(PIN.rentableUnit);
  });
});

// Move-in E2E (guest variant): unauthenticated checkout with just an email
// auto-provisions a GUEST customer, links Booking → Tenant → Unit + DUE
// invoice, then the guest claims portal access (bookingRef + email + mobile)
// which rotates the account to PERSONAL — after which the portal shows the
// rented unit.

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, futureMoveInISO, prisma, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';

describe('move-in guest variant (GUEST create → claim → PERSONAL → portal)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('guest books with email only, claims, and sees the unit in the portal', async () => {
    const email = uniqueEmail();
    const mobile = '81998877';

    // 1. Guest checkout: no Authorization header, flat email/name/mobile fields.
    const booking = await api.post('/api/v1/customer/bookings').send({
      unitCode: PIN.guestUnit,
      moveInDate: futureMoveInISO(),
      durationMonths: 1,
      email,
      name: 'E2E Guest',
      mobile,
    });
    expect(booking.status).toBe(201);
    expect(booking.body.data.status).toBe('PENDING_PAYMENT');
    const bookingRef = booking.body.data.bookingRef as string;

    // Auto-provisioned customer is type GUEST …
    const guest = await prisma.customer.findUnique({ where: { email } });
    expect(guest).not.toBeNull();
    expect(guest!.type).toBe('GUEST');

    // … with Tenant email linkage, DUE invoice, and the unit RESERVED.
    const tenant = await prisma.tenant.findFirst({ where: { email } });
    expect(tenant).not.toBeNull();
    const invoices = await prisma.invoice.findMany({ where: { tenantId: tenant!.id } });
    expect(invoices.length).toBeGreaterThan(0);
    expect(invoices[0].status).toBe('DUE');
    const unit = await prisma.unit.findUnique({ where: { unitCode: PIN.guestUnit } });
    expect(unit!.status).toBe('RESERVED');

    // 2. Claim: proves identity with the out-of-band triple
    //    (bookingRef + email + mobile) and sets a real portal password.
    const claim = await api.post('/api/v1/customer/claim').send({
      email,
      bookingRef,
      mobile,
      password: 'e2e-guest-claimed-1',
    });
    expect(claim.status).toBe(200);
    expect(claim.body.data.token).toBeTruthy();
    expect(claim.body.data.customer.type).toBe('PERSONAL');

    const claimed = await prisma.customer.findUnique({ where: { email } });
    expect(claimed!.type).toBe('PERSONAL');

    // 3. Claimed credentials sign in, and the portal shows the rented unit.
    const login = await api.post('/api/v1/customer/login').send({ email, password: 'e2e-guest-claimed-1' });
    expect(login.status).toBe(200);

    const portal = await api
      .get('/api/v1/customer/portal')
      .set('Authorization', `Bearer ${login.body.data.token}`);
    expect(portal.status).toBe(200);
    expect(portal.body.data.unit?.code ?? portal.body.data.unit?.id).toBe(PIN.guestUnit);
    expect(
      (portal.body.data.bookings as Array<{ bookingRef: string }>).map((b) => b.bookingRef),
    ).toContain(bookingRef);
  });
});

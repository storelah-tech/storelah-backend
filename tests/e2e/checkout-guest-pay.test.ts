// Guest-pay regression (SL-2026-1982 shape): a portal-created booking owned
// by a REGISTERED (PERSONAL) customer in PENDING_PAYMENT with a DUE invoice
// must be payable logged-out with email proof alone — never 401, regardless
// of Customer type. A supplied `mobile` is accepted but never compared and
// never blocks (SL-2026-6926: stored +65 0804901431 vs supplied 804901431
// with matching email must succeed). Wrong/missing email still 401s safely with the stable
// UNAUTHORIZED code; a stale Bearer never blocks valid proof; authed owner
// flows are unchanged. The webhook stays the paid truth (no auto-confirm on
// session create).
//
// NOTE: Stripe is hermetically unconfigured here (env cleared per test), so
// a passing access gate surfaces as 503 STRIPE_NOT_CONFIGURED — never 401.
// Assertions pin "not 401" for valid proof and "401 UNAUTHORIZED" for
// missing/invalid proof, plus DB state (booking still PENDING_PAYMENT,
// invoice still DUE) to prove session creation never auto-confirms.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, futureMoveInISO, prisma, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';

const SAVED_STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const SAVED_APP_URL = process.env.BOOKING_APP_URL;

async function registerPortalOwner(email: string, mobile = '81234567'): Promise<string> {
  const reg = await api.post('/api/v1/customer/register').send({
    name: 'E2E Portal Owner',
    email,
    mobile,
    password: 'e2e-guestpay-owner-1',
    type: 'PERSONAL',
  });
  expect(reg.status).toBe(201);
  return reg.body.data.token as string;
}

/** Portal-created booking: authed REGISTERED owner books → PENDING_PAYMENT + DUE. */
async function createPortalBooking(token: string): Promise<string> {
  const booking = await api
    .post('/api/v1/customer/bookings')
    .set('Authorization', `Bearer ${token}`)
    .send({ unitCode: PIN.rentableUnit, moveInDate: futureMoveInISO(), durationMonths: 1 });
  expect(booking.status).toBe(201);
  expect(booking.body.data.status).toBe('PENDING_PAYMENT');
  return booking.body.data.bookingRef as string;
}

async function assertSl1982Shape(email: string, bookingRef: string): Promise<void> {
  const owner = await prisma.customer.findUnique({ where: { email } });
  expect(owner?.type).toBe('PERSONAL');
  await expect(prisma.booking.findUnique({ where: { bookingRef } })).resolves.toMatchObject({
    status: 'PENDING_PAYMENT',
  });
  const dbBooking = await prisma.booking.findUnique({ where: { bookingRef } });
  const invoices = await prisma.invoice.findMany({ where: { tenantId: dbBooking!.tenantId } });
  expect(invoices.some((i) => i.status === 'DUE')).toBe(true);
}

async function assertNotAutoConfirmed(bookingRef: string): Promise<void> {
  await expect(prisma.booking.findUnique({ where: { bookingRef } })).resolves.toMatchObject({
    status: 'PENDING_PAYMENT',
  });
  const dbBooking = await prisma.booking.findUnique({ where: { bookingRef } });
  const invoices = await prisma.invoice.findMany({ where: { tenantId: dbBooking!.tenantId } });
  expect(invoices.some((i) => i.status === 'DUE')).toBe(true);
}

describe('guest-pay for REGISTERED-owner PENDING_PAYMENT bookings (SL-2026-1982 shape)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
    // Hermetic: never touch live Stripe from tests — a passing access gate
    // then reads as 503 STRIPE_NOT_CONFIGURED instead of 401.
    process.env.STRIPE_SECRET_KEY = '';
    process.env.BOOKING_APP_URL = '';
  });

  afterAll(() => {
    if (SAVED_STRIPE_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = SAVED_STRIPE_KEY;
    if (SAVED_APP_URL === undefined) delete process.env.BOOKING_APP_URL;
    else process.env.BOOKING_APP_URL = SAVED_APP_URL;
  });

  it('logged-out {bookingRef,email} with matching email succeeds (not 401) regardless of Customer type', async () => {
    const email = uniqueEmail();
    const token = await registerPortalOwner(email);
    const bookingRef = await createPortalBooking(token);
    await assertSl1982Shape(email, bookingRef);

    // Logged-out guest pay — padded + uppercased to pin trim/case-insensitive
    // matching — must NOT 401.
    const guestPay = await api.post('/api/v1/customer/checkout/sessions').send({
      bookingRef,
      email: `  ${email.toUpperCase()}  `,
    });
    expect(guestPay.status).not.toBe(401);
    expect(guestPay.body?.error?.code ?? null).not.toBe('UNAUTHORIZED');

    // No auto-confirm on session create: the webhook stays the paid truth.
    await assertNotAutoConfirmed(bookingRef);
  });

  it('matching email succeeds with matching, mismatched, or absent mobile (mobile never blocks)', async () => {
    const email = uniqueEmail();
    const token = await registerPortalOwner(email, '81234567');
    const bookingRef = await createPortalBooking(token);
    await assertSl1982Shape(email, bookingRef);

    const withMobile = await api.post('/api/v1/customer/checkout/sessions').send({
      bookingRef,
      email,
      mobile: '81234567',
    });
    expect(withMobile.status).not.toBe(401);

    // USER RULE: a digits mismatch must NOT deny guest pay — email proof
    // alone suffices.
    const badMobile = await api.post('/api/v1/customer/checkout/sessions').send({
      bookingRef,
      email,
      mobile: '89998888',
    });
    expect(badMobile.status).not.toBe(401);
    expect(badMobile.body?.error?.code ?? null).not.toBe('UNAUTHORIZED');

    await assertNotAutoConfirmed(bookingRef);
  });

  it('SL-2026-6926 shape: stored +65 0804901431 vs supplied 804901431 with matching email succeeds (not 401)', async () => {
    const email = uniqueEmail();
    const token = await registerPortalOwner(email, '+65 0804901431');
    const bookingRef = await createPortalBooking(token);
    await assertSl1982Shape(email, bookingRef);

    // Pin the live-failure shape: stored number carries the +65 prefix while
    // the guest supplies bare digits — different digit strings, same owner.
    const dbBooking = await prisma.booking.findUnique({ where: { bookingRef } });
    await prisma.tenant.update({
      where: { id: dbBooking!.tenantId },
      data: { mobile: '+65 0804901431' },
    });

    const guestPay = await api.post('/api/v1/customer/checkout/sessions').send({
      bookingRef,
      email,
      mobile: '804901431',
    });
    expect(guestPay.status).not.toBe(401);
    expect(guestPay.body?.error?.code ?? null).not.toBe('UNAUTHORIZED');

    // Email alone (no mobile at all) also succeeds against the stored number.
    const emailOnly = await api.post('/api/v1/customer/checkout/sessions').send({
      bookingRef,
      email,
    });
    expect(emailOnly.status).not.toBe(401);
    expect(emailOnly.body?.error?.code ?? null).not.toBe('UNAUTHORIZED');

    await assertNotAutoConfirmed(bookingRef);
  });

  it('wrong or missing email still 401s safely with stable UNAUTHORIZED code; unknown ref 404s', async () => {
    const email = uniqueEmail();
    const token = await registerPortalOwner(email);
    const bookingRef = await createPortalBooking(token);
    await assertSl1982Shape(email, bookingRef);

    const wrongEmail = await api.post('/api/v1/customer/checkout/sessions').send({
      bookingRef,
      email: uniqueEmail(),
    });
    expect(wrongEmail.status).toBe(401);
    expect(wrongEmail.body.error.code).toBe('UNAUTHORIZED');

    const missingEmail = await api.post('/api/v1/customer/checkout/sessions').send({
      bookingRef,
    });
    expect(missingEmail.status).toBe(401);
    expect(missingEmail.body.error.code).toBe('UNAUTHORIZED');

    const unknownRef = await api.post('/api/v1/customer/checkout/sessions').send({
      bookingRef: 'SL-2026-0000',
      email,
    });
    expect(unknownRef.status).toBe(404);
    expect(unknownRef.body.error.code).toBe('NOT_FOUND');
  });

  it('stale Bearer never blocks valid guest proof; without proof it stays a hard 401', async () => {
    const email = uniqueEmail();
    const token = await registerPortalOwner(email);
    const bookingRef = await createPortalBooking(token);
    await assertSl1982Shape(email, bookingRef);

    const staleWithProof = await api
      .post('/api/v1/customer/checkout/sessions')
      .set('Authorization', 'Bearer this-is-not-a-token')
      .send({ bookingRef, email });
    expect(staleWithProof.status).not.toBe(401);
    expect(staleWithProof.body?.error?.code ?? null).not.toBe('UNAUTHORIZED');

    const staleWithoutProof = await api
      .post('/api/v1/customer/checkout/sessions')
      .set('Authorization', 'Bearer this-is-not-a-token')
      .send({ bookingRef });
    expect(staleWithoutProof.status).toBe(401);
    expect(staleWithoutProof.body.error.code).toBe('UNAUTHORIZED');

    await assertNotAutoConfirmed(bookingRef);
  });

  it('authed owner Bearer still works (authed flows unchanged)', async () => {
    const email = uniqueEmail();
    const token = await registerPortalOwner(email);
    const bookingRef = await createPortalBooking(token);
    await assertSl1982Shape(email, bookingRef);

    const authed = await api
      .post('/api/v1/customer/checkout/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ bookingRef });
    expect(authed.status).not.toBe(401);
    expect(authed.status).not.toBe(403);
    expect(authed.body?.error?.code ?? null).not.toBe('UNAUTHORIZED');

    await assertNotAutoConfirmed(bookingRef);
  });
});

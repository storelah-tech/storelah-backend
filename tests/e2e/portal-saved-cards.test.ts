// Saved payment cards (docs/SAVED_CARDS_PLAN.md) — hermetic half.
//
// Stripe is unconfigured (env cleared per test), so a request that PASSES
// the auth/ownership/status gate surfaces as 503 STRIPE_NOT_CONFIGURED. The
// webhook side is exercised by calling applyInvoicePaymentSucceeded with a
// synthetic PaymentIntent (no Stripe network), like portal-invoices.test.ts.
// The Stripe-backed paths (pm ownership, detach, PI creation) live in
// portal-saved-cards-stripe.test.ts against a mocked SDK.

import type Stripe from 'stripe';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyInvoicePaymentSucceeded, INVOICE_SESSION_KIND } from '../../src/core/invoicePayments';
import { toSavedCard } from '../../src/core/savedCards';
import { api, prisma, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';
import { registerCustomer, seedCardPayer } from './saved-cards-world';

const SAVED = {
  sk: process.env.STRIPE_SECRET_KEY,
  pk: process.env.STRIPE_PUBLISHABLE_KEY,
  app: process.env.BOOKING_APP_URL,
};

function restore(name: string, v: string | undefined) {
  if (v === undefined) delete process.env[name];
  else process.env[name] = v;
}

function succeededPi(id: string, invoiceId: string, cents: number, status = 'succeeded'): Stripe.PaymentIntent {
  return {
    id,
    status,
    amount: cents,
    amount_received: status === 'succeeded' ? cents : 0,
    metadata: { kind: INVOICE_SESSION_KIND, invoiceId },
  } as unknown as Stripe.PaymentIntent;
}

describe('portal saved cards — gates + webhook', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
    process.env.STRIPE_SECRET_KEY = '';
    process.env.STRIPE_PUBLISHABLE_KEY = '';
    process.env.BOOKING_APP_URL = '';
  });

  afterAll(() => {
    restore('STRIPE_SECRET_KEY', SAVED.sk);
    restore('STRIPE_PUBLISHABLE_KEY', SAVED.pk);
    restore('BOOKING_APP_URL', SAVED.app);
  });

  it('every saved-card route requires a customer Bearer', async () => {
    const calls = [
      api.get('/api/v1/customer/payment-methods'),
      api.post('/api/v1/customer/payment-methods/setup-intent'),
      api.post('/api/v1/customer/payment-methods/pm_x/default'),
      api.delete('/api/v1/customer/payment-methods/pm_x'),
      api.post('/api/v1/customer/invoices/inv_x/pay').send({ paymentMethodId: 'pm_x' }),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
  });

  it('GET /payment-methods with no Stripe Customer is an empty wallet and never calls Stripe', async () => {
    const { token } = await registerCustomer(uniqueEmail());
    const res = await api.get('/api/v1/customer/payment-methods').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ cards: [], defaultId: null, publishableKey: null });
  });

  it('setup-intent needs Stripe configured (publishable + secret in the same mode)', async () => {
    const { token, customerId } = await registerCustomer(uniqueEmail());
    const res = await api.post('/api/v1/customer/payment-methods/setup-intent').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STRIPE_NOT_CONFIGURED');
    process.env.STRIPE_SECRET_KEY = 'sk_live_mismatch';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_mismatch';
    const mixed = await api.post('/api/v1/customer/payment-methods/setup-intent').set('Authorization', `Bearer ${token}`);
    expect(mixed.status).toBe(503);
    // No wallet was linked by a refused call.
    expect((await prisma.customer.findUnique({ where: { id: customerId } }))?.stripeCustomerId).toBeNull();
  });

  it('set-default / remove on a customer without a wallet → 404 (never confirms a foreign pm)', async () => {
    const { token } = await registerCustomer(uniqueEmail());
    const auth = { Authorization: `Bearer ${token}` };
    expect((await api.post('/api/v1/customer/payment-methods/pm_123/default').set(auth)).status).toBe(404);
    expect((await api.delete('/api/v1/customer/payment-methods/pm_123').set(auth)).status).toBe(404);
  });

  it('pay gate: validation, owner only, paid → 409, pending booking → USE_CHECKOUT, own DUE reaches the card check', async () => {
    const w = await seedCardPayer(uniqueEmail());
    const stranger = await registerCustomer(uniqueEmail());
    const pay = (token: string, invoiceId: string, body: object = { paymentMethodId: 'pm_123' }) =>
      api.post(`/api/v1/customer/invoices/${invoiceId}/pay`).set('Authorization', `Bearer ${token}`).send(body);

    expect((await pay(w.token, w.recurringInvoiceId, {})).status).toBe(400);
    expect((await pay(stranger.token, w.recurringInvoiceId)).status).toBe(404);
    const paid = await pay(w.token, w.paidInvoiceId);
    expect(paid.status).toBe(409);
    expect(paid.body.error.code).toBe('CONFLICT');
    const pending = await pay(w.token, w.pendingInvoiceId);
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe('USE_CHECKOUT');
    // Own DUE invoice passes the invoice gate; the customer has no wallet → card 404.
    const noCard = await pay(w.token, w.recurringInvoiceId);
    expect(noCard.status).toBe(404);
    expect(noCard.body.error.message).toMatch(/card/i);
    // Nothing was flipped or stamped by refused calls.
    const inv = await prisma.invoice.findUnique({ where: { id: w.recurringInvoiceId } });
    expect(inv).toMatchObject({ status: 'DUE', paymentIntentId: null });
  });

  it('webhook: payment_intent.succeeded flips exactly the stamped invoice once', async () => {
    const w = await seedCardPayer(uniqueEmail());
    await prisma.invoice.update({ where: { id: w.recurringInvoiceId }, data: { paymentIntentId: 'pi_e2e_ok' } });

    const first = await applyInvoicePaymentSucceeded(succeededPi('pi_e2e_ok', w.recurringInvoiceId, 12000));
    expect(first.applied).toBe(true);
    const retry = await applyInvoicePaymentSucceeded(succeededPi('pi_e2e_ok', w.recurringInvoiceId, 12000));
    expect(retry.applied).toBe(false);

    const inv = await prisma.invoice.findUnique({ where: { id: w.recurringInvoiceId } });
    expect(inv?.status).toBe('PAID');
    expect(inv?.method).toBe('Card');
    expect(Number(inv?.amountPaid)).toBe(120);
    expect(inv?.paidAt).toBeInstanceOf(Date);
    // Bookings untouched (the pending one stays pending).
    const pendingInv = await prisma.invoice.findUnique({ where: { id: w.pendingInvoiceId } });
    expect(pendingInv?.status).toBe('DUE');
    expect(await prisma.booking.count({ where: { status: 'PENDING_PAYMENT' } })).toBe(1);
  });

  it('webhook: PI id mismatch, non-succeeded and unknown invoice are ignored', async () => {
    const w = await seedCardPayer(uniqueEmail());
    await prisma.invoice.update({ where: { id: w.recurringInvoiceId }, data: { paymentIntentId: 'pi_e2e_current' } });

    expect((await applyInvoicePaymentSucceeded(succeededPi('pi_e2e_stale', w.recurringInvoiceId, 12000))).applied).toBe(false);
    expect(
      (await applyInvoicePaymentSucceeded(succeededPi('pi_e2e_current', w.recurringInvoiceId, 12000, 'processing'))).applied,
    ).toBe(false);
    expect((await applyInvoicePaymentSucceeded(succeededPi('pi_e2e_current', 'missing-invoice', 12000))).applied).toBe(false);
    // An unstamped invoice can't be flipped by any PI.
    expect((await applyInvoicePaymentSucceeded(succeededPi('pi_e2e_any', w.pendingInvoiceId, 9000))).applied).toBe(false);
    const inv = await prisma.invoice.findUnique({ where: { id: w.recurringInvoiceId } });
    expect(inv?.status).toBe('DUE');
  });

  it('toSavedCard exposes only the allow-listed display fields', () => {
    const pm = {
      id: 'pm_1',
      card: {
        brand: 'visa',
        last4: '4242',
        exp_month: 12,
        exp_year: 2030,
        fingerprint: 'secret-fp',
        funding: 'credit',
        country: 'SG',
      },
      billing_details: { address: { line1: 'x' } },
    } as unknown as Stripe.PaymentMethod;
    const card = toSavedCard(pm, 'pm_1');
    expect(card).toEqual({ id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true });
    expect(Object.keys(card!).sort()).toEqual(['brand', 'expMonth', 'expYear', 'id', 'isDefault', 'last4']);
  });
});

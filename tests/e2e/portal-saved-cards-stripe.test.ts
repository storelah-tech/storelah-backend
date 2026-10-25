// Saved payment cards — Stripe-backed half, against an in-memory fake of the
// few Stripe SDK calls core/savedCards.ts + payInvoiceWithSavedCard make
// (getStripe is swapped via vi.mock; nothing reaches the network). Covers pm
// ownership, the lazy wallet link, default promotion, and PaymentIntent
// creation / decline / reuse. The hermetic gates live in portal-saved-cards.test.ts.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePm {
  id: string;
  type: 'card';
  customer: string | null;
  card: { brand: string; last4: string; exp_month: number; exp_year: number; fingerprint: string };
}
interface FakePi {
  id: string;
  status: string;
  amount: number;
  payment_method: string;
  client_secret: string;
  metadata: Record<string, string>;
}

const fake = vi.hoisted(() => {
  const state = {
    customers: new Map<string, { id: string; default: string | null }>(),
    pms: new Map<string, FakePm>(),
    pis: new Map<string, FakePi>(),
    idem: new Map<string, FakePi>(),
    nextPiStatus: 'succeeded' as string,
    seq: 0,
    customerCreates: 0,
  };
  const stripe = {
    customers: {
      create: async (_p: unknown, opts?: { idempotencyKey?: string }) => {
        state.customerCreates += 1;
        const id = `cus_${opts?.idempotencyKey ?? ++state.seq}`;
        if (!state.customers.has(id)) state.customers.set(id, { id, default: null });
        return { id };
      },
      retrieve: async (id: string) => {
        const c = state.customers.get(id)!;
        return { id, invoice_settings: { default_payment_method: c.default } };
      },
      update: async (id: string, p: { invoice_settings: { default_payment_method: string } }) => {
        state.customers.get(id)!.default = p.invoice_settings.default_payment_method;
        return { id };
      },
      listPaymentMethods: async (id: string) => ({
        data: [...state.pms.values()].filter((p) => p.customer === id).reverse(),
      }),
    },
    setupIntents: {
      create: async () => ({ id: 'seti_1', client_secret: 'seti_1_secret_x' }),
    },
    paymentMethods: {
      retrieve: async (id: string) => {
        const pm = state.pms.get(id);
        if (!pm) throw Object.assign(new Error('No such payment_method'), { type: 'StripeInvalidRequestError' });
        return pm;
      },
      detach: async (id: string) => {
        state.pms.get(id)!.customer = null;
        return state.pms.get(id);
      },
    },
    paymentIntents: {
      create: async (p: { amount: number; payment_method: string; metadata: Record<string, string> }, opts: { idempotencyKey: string }) => {
        const replay = state.idem.get(opts.idempotencyKey);
        if (replay) return replay;
        const id = `pi_fake_${++state.seq}`;
        const pi: FakePi = {
          id,
          status: state.nextPiStatus,
          amount: p.amount,
          payment_method: p.payment_method,
          client_secret: `${id}_secret_x`,
          metadata: p.metadata,
        };
        state.pis.set(id, pi);
        state.idem.set(opts.idempotencyKey, pi);
        if (pi.status === 'requires_payment_method') {
          throw Object.assign(new Error('Your card was declined.'), {
            type: 'StripeCardError',
            payment_intent: pi,
          });
        }
        return pi;
      },
      retrieve: async (id: string) => {
        const pi = state.pis.get(id);
        if (!pi) throw new Error('No such payment_intent');
        return pi;
      },
    },
  };
  return { state, stripe };
});

vi.mock('../../src/core/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/checkout')>();
  return { ...actual, getStripe: () => fake.stripe };
});

import Stripe from 'stripe';
import { prisma, api, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';
import { applyInvoicePaymentSucceeded } from '../../src/core/invoicePayments';
import { registerCustomer, seedCardPayer } from './saved-cards-world';

const SAVED = { wh: process.env.STRIPE_WEBHOOK_SECRET, pk: process.env.STRIPE_PUBLISHABLE_KEY, sk: process.env.STRIPE_SECRET_KEY, app: process.env.BOOKING_APP_URL };

function addCard(id: string, customer: string | null, brand = 'visa', last4 = '4242') {
  fake.state.pms.set(id, {
    id,
    type: 'card',
    customer,
    card: { brand, last4, exp_month: 12, exp_year: 2030, fingerprint: 'fp-secret' },
  });
}

describe('portal saved cards — Stripe-backed paths (mocked SDK)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
    fake.state.customers.clear();
    fake.state.pms.clear();
    fake.state.pis.clear();
    fake.state.idem.clear();
    fake.state.nextPiStatus = 'succeeded';
    fake.state.customerCreates = 0;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake';
    process.env.BOOKING_APP_URL = 'http://localhost:3101';
  });

  afterAll(() => {
    for (const [k, v] of [
      ['STRIPE_WEBHOOK_SECRET', SAVED.wh],
      ['STRIPE_PUBLISHABLE_KEY', SAVED.pk],
      ['STRIPE_SECRET_KEY', SAVED.sk],
      ['BOOKING_APP_URL', SAVED.app],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('setup-intent links one Stripe Customer (concurrent first calls converge) and returns the pk', async () => {
    const { token, customerId } = await registerCustomer(uniqueEmail());
    const auth = { Authorization: `Bearer ${token}` };
    const [a, b] = await Promise.all([
      api.post('/api/v1/customer/payment-methods/setup-intent').set(auth),
      api.post('/api/v1/customer/payment-methods/setup-intent').set(auth),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.data).toEqual({ clientSecret: 'seti_1_secret_x', publishableKey: 'pk_test_fake' });
    const c = await prisma.customer.findUnique({ where: { id: customerId } });
    expect(c?.stripeCustomerId).toBe(`cus_portal-customer-${customerId}`);
    expect(fake.state.customers.size).toBe(1);
  });

  it('list → allow-listed cards, first card auto-default; set-default + remove promote correctly; foreign pm 404', async () => {
    const { token, customerId } = await registerCustomer(uniqueEmail());
    const auth = { Authorization: `Bearer ${token}` };
    await api.post('/api/v1/customer/payment-methods/setup-intent').set(auth);
    const cus = (await prisma.customer.findUnique({ where: { id: customerId } }))!.stripeCustomerId!;
    addCard('pm_a', cus, 'visa', '4242');
    addCard('pm_b', cus, 'mastercard', '4444');
    addCard('pm_foreign', 'cus_someone_else', 'visa', '1111');

    const list = await api.get('/api/v1/customer/payment-methods').set(auth);
    expect(list.status).toBe(200);
    // Newest first; a wallet without a default promotes the newest.
    expect(list.body.data.defaultId).toBe('pm_b');
    expect(list.body.data.cards).toEqual([
      { id: 'pm_b', brand: 'mastercard', last4: '4444', expMonth: 12, expYear: 2030, isDefault: true },
      { id: 'pm_a', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: false },
    ]);
    expect(JSON.stringify(list.body)).not.toContain('fp-secret');
    expect(list.body.data.publishableKey).toBe('pk_test_fake');

    const setA = await api.post('/api/v1/customer/payment-methods/pm_a/default').set(auth);
    expect(setA.body.data.defaultId).toBe('pm_a');

    expect((await api.post('/api/v1/customer/payment-methods/pm_foreign/default').set(auth)).status).toBe(404);
    expect((await api.delete('/api/v1/customer/payment-methods/pm_foreign').set(auth)).status).toBe(404);
    expect(fake.state.pms.get('pm_foreign')?.customer).toBe('cus_someone_else');

    const removed = await api.delete('/api/v1/customer/payment-methods/pm_a').set(auth);
    expect(removed.status).toBe(200);
    expect(removed.body.data).toMatchObject({ defaultId: 'pm_b', cards: [{ id: 'pm_b', isDefault: true }] });
  });

  it('pay: creates an on-session PI for the server amount, stamps the invoice, never marks PAID; webhook does', async () => {
    const w = await seedCardPayer(uniqueEmail());
    const auth = { Authorization: `Bearer ${w.token}` };
    await api.post('/api/v1/customer/payment-methods/setup-intent').set(auth);
    const cus = (await prisma.customer.findUnique({ where: { id: w.customerId } }))!.stripeCustomerId!;
    addCard('pm_a', cus);
    addCard('pm_foreign', 'cus_other');

    const foreign = await api.post(`/api/v1/customer/invoices/${w.recurringInvoiceId}/pay`).set(auth).send({ paymentMethodId: 'pm_foreign' });
    expect(foreign.status).toBe(404);

    const res = await api.post(`/api/v1/customer/invoices/${w.recurringInvoiceId}/pay`).set(auth).send({ paymentMethodId: 'pm_a' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'succeeded' });
    const pi = fake.state.pis.get(res.body.data.paymentIntentId)!;
    expect(pi.amount).toBe(12000);
    expect(pi.metadata).toMatchObject({ kind: 'invoice', invoiceId: w.recurringInvoiceId });

    let inv = await prisma.invoice.findUnique({ where: { id: w.recurringInvoiceId } });
    expect(inv).toMatchObject({ status: 'DUE', paymentIntentId: pi.id });

    // A second slide while the PI is already succeeded reuses it (no second charge).
    const again = await api.post(`/api/v1/customer/invoices/${w.recurringInvoiceId}/pay`).set(auth).send({ paymentMethodId: 'pm_a' });
    expect(again.body.data.paymentIntentId).toBe(pi.id);
    expect(fake.state.pis.size).toBe(1);

    await applyInvoicePaymentSucceeded({ ...pi, amount_received: 12000 } as never);
    inv = await prisma.invoice.findUnique({ where: { id: w.recurringInvoiceId } });
    expect(inv?.status).toBe('PAID');
  });

  it('pay: 3DS returns requires_action + clientSecret and resumes the same PI', async () => {
    const w = await seedCardPayer(uniqueEmail());
    const auth = { Authorization: `Bearer ${w.token}` };
    await api.post('/api/v1/customer/payment-methods/setup-intent').set(auth);
    const cus = (await prisma.customer.findUnique({ where: { id: w.customerId } }))!.stripeCustomerId!;
    addCard('pm_3ds', cus);
    fake.state.nextPiStatus = 'requires_action';
    const first = await api.post(`/api/v1/customer/invoices/${w.recurringInvoiceId}/pay`).set(auth).send({ paymentMethodId: 'pm_3ds' });
    expect(first.body.data).toMatchObject({ status: 'requires_action' });
    expect(first.body.data.clientSecret).toMatch(/_secret_/);
    const second = await api.post(`/api/v1/customer/invoices/${w.recurringInvoiceId}/pay`).set(auth).send({ paymentMethodId: 'pm_3ds' });
    expect(second.body.data.paymentIntentId).toBe(first.body.data.paymentIntentId);
    expect(fake.state.pis.size).toBe(1);
  });

  it('pay: a decline is 402 CARD_DECLINED and the retry mints a fresh PI', async () => {
    const w = await seedCardPayer(uniqueEmail());
    const auth = { Authorization: `Bearer ${w.token}` };
    await api.post('/api/v1/customer/payment-methods/setup-intent').set(auth);
    const cus = (await prisma.customer.findUnique({ where: { id: w.customerId } }))!.stripeCustomerId!;
    addCard('pm_bad', cus);
    fake.state.nextPiStatus = 'requires_payment_method';
    const declined = await api.post(`/api/v1/customer/invoices/${w.recurringInvoiceId}/pay`).set(auth).send({ paymentMethodId: 'pm_bad' });
    expect(declined.status).toBe(402);
    expect(declined.body.error.code).toBe('CARD_DECLINED');

    fake.state.nextPiStatus = 'succeeded';
    const retry = await api.post(`/api/v1/customer/invoices/${w.recurringInvoiceId}/pay`).set(auth).send({ paymentMethodId: 'pm_bad' });
    expect(retry.status).toBe(200);
    expect(fake.state.pis.size).toBe(2);
    const inv = await prisma.invoice.findUnique({ where: { id: w.recurringInvoiceId } });
    expect(inv?.paymentIntentId).toBe(retry.body.data.paymentIntentId);
  });

  it('POST /stripe/webhook routes a signed payment_intent.succeeded (kind=invoice) to the invoice flip', async () => {
    const w = await seedCardPayer(uniqueEmail());
    await prisma.invoice.update({ where: { id: w.recurringInvoiceId }, data: { paymentIntentId: 'pi_wh_1' } });
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_e2e_saved_cards';
    const payload = JSON.stringify({
      id: 'evt_e2e_1',
      object: 'event',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_wh_1',
          object: 'payment_intent',
          status: 'succeeded',
          amount: 12000,
          amount_received: 12000,
          metadata: { kind: 'invoice', invoiceId: w.recurringInvoiceId },
        },
      },
    });
    const header = new Stripe('sk_test_fake').webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_e2e_saved_cards',
    });
    const res = await api
      .post('/api/v1/customer/stripe/webhook')
      .set('stripe-signature', header)
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ received: true, applied: true });
    const inv = await prisma.invoice.findUnique({ where: { id: w.recurringInvoiceId } });
    expect(inv?.status).toBe('PAID');

    const forged = await api
      .post('/api/v1/customer/stripe/webhook')
      .set('stripe-signature', 't=1,v1=deadbeef')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(forged.status).toBe(400);
  });
});

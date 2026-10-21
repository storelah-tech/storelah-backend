// Portal payments (Phase 2): invoice checkout gate, invoice webhook, per-
// invoice PDF receipts, the multi-tenant /portal invoice list, and move-out
// notice by unit code.
//
// Stripe is hermetically unconfigured (env cleared per test), so a request
// that PASSES the ownership/status gate surfaces as 503 STRIPE_NOT_CONFIGURED;
// the webhook side is exercised by calling applyInvoiceCheckoutCompleted with
// a synthetic checkout.session object (no Stripe network), like
// checkout-lead-won.test.ts does for bookings.

import { inflateSync } from 'node:zlib';
import type Stripe from 'stripe';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyInvoiceCheckoutCompleted, INVOICE_SESSION_KIND } from '../../src/core/invoicePayments';
import { PIN, api, prisma, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';

const SAVED_STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const SAVED_APP_URL = process.env.BOOKING_APP_URL;

async function register(email: string): Promise<string> {
  const reg = await api.post('/api/v1/customer/register').send({
    name: 'E2E Portal Payer',
    email,
    mobile: '81234567',
    password: 'e2e-portal-pay-1',
    type: 'PERSONAL',
  });
  expect(reg.status).toBe(201);
  return reg.body.data.token as string;
}

interface PayerWorld {
  token: string;
  paidUnitCode: string;
  pendingUnitCode: string;
  pendingBookingRef: string;
  paidInvoiceId: string;
  recurringInvoiceId: string;
  pendingInvoiceId: string;
}

/**
 * One customer, two Tenant rows (one per unit, as linkTenantForPaidBooking
 * creates them): unit A paid (CONFIRMED booking, PAID first invoice + a DUE
 * recurring invoice), unit B still PENDING_PAYMENT (DUE first invoice).
 */
async function seedPayer(email: string): Promise<PayerWorld> {
  const token = await register(email);
  const branch = await prisma.branch.findUnique({ where: { code: PIN.branchCode } });
  const unitA = await prisma.unit.findUnique({ where: { unitCode: PIN.rentableUnit } });
  const unitB = await prisma.unit.findUnique({ where: { unitCode: PIN.guestUnit } });
  if (!branch || !unitA || !unitB) throw new Error('[e2e] move-in world not seeded');
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();

  const tenantFor = (unitId: string) =>
    prisma.tenant.create({
      data: {
        name: 'E2E Portal Payer',
        email,
        mobile: '81234567',
        unitId,
        moveInDate: new Date(),
        monthlyRate: 120,
        psf: 2.4,
        status: 'ACTIVE',
        branchId: branch.id,
      },
    });
  const tenantA = await tenantFor(unitA.id);
  const tenantB = await tenantFor(unitB.id);

  await prisma.booking.create({
    data: {
      bookingRef: `SL-E2E-A${suffix}`,
      tenantId: tenantA.id,
      unitId: unitA.id,
      moveInDate: new Date(),
      duration: '6 months',
      amount: 120,
      status: 'CONFIRMED',
    },
  });
  const pending = await prisma.booking.create({
    data: {
      bookingRef: `SL-E2E-B${suffix}`,
      tenantId: tenantB.id,
      unitId: unitB.id,
      moveInDate: new Date(),
      duration: '1 month',
      amount: 90,
      status: 'PENDING_PAYMENT',
    },
  });

  const invoice = (no: string, tenantId: string, unitId: string, status: 'PAID' | 'DUE', amount: number) =>
    prisma.invoice.create({
      data: {
        invoiceNo: `INV-E2E-${no}${suffix}`,
        tenantId,
        unitId,
        amount,
        dueDate: new Date(),
        status,
        ...(status === 'PAID' ? { paidAt: new Date(), amountPaid: amount, method: 'Card' } : {}),
      },
    });
  const paid = await invoice('1', tenantA.id, unitA.id, 'PAID', 120);
  const recurring = await invoice('2', tenantA.id, unitA.id, 'DUE', 120);
  const pendingInv = await invoice('3', tenantB.id, unitB.id, 'DUE', 90);

  return {
    token,
    paidUnitCode: unitA.unitCode,
    pendingUnitCode: unitB.unitCode,
    pendingBookingRef: pending.bookingRef,
    paidInvoiceId: paid.id,
    recurringInvoiceId: recurring.id,
    pendingInvoiceId: pendingInv.id,
  };
}

/** Visible text of a pdf-lib PDF: inflate each content stream, decode the hex `Tj` strings. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    try {
      const body = inflateSync(pdf.subarray(start, end)).toString('latin1');
      for (const t of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        out.push(Buffer.from(t[1], 'hex').toString('latin1'));
      }
      for (const t of body.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) out.push(t[1]);
    } catch {
      // Not a deflate stream (fonts/xref) — skip.
    }
  }
  return out.join('\n');
}

function invoiceSession(
  id: string,
  invoiceId: string,
  amountCents: number,
  paymentStatus: 'paid' | 'unpaid' = 'paid',
): Stripe.Checkout.Session {
  return {
    id,
    payment_status: paymentStatus,
    payment_intent: `pi_${id}`,
    amount_total: amountCents,
    metadata: { kind: INVOICE_SESSION_KIND, invoiceId },
  } as unknown as Stripe.Checkout.Session;
}

describe('portal invoice payments + receipts', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
    process.env.STRIPE_SECRET_KEY = '';
    process.env.BOOKING_APP_URL = '';
  });

  afterAll(() => {
    if (SAVED_STRIPE_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = SAVED_STRIPE_KEY;
    if (SAVED_APP_URL === undefined) delete process.env.BOOKING_APP_URL;
    else process.env.BOOKING_APP_URL = SAVED_APP_URL;
  });

  it('GET /portal lists invoices across every tenant row with unit/payable/bookingRef + support', async () => {
    const w = await seedPayer(uniqueEmail());
    const res = await api.get('/api/v1/customer/portal').set('Authorization', `Bearer ${w.token}`);
    expect(res.status).toBe(200);
    const byId = new Map<string, Record<string, unknown>>(
      (res.body.data.invoices as Array<Record<string, unknown>>).map((i) => [i.id as string, i]),
    );
    expect(byId.size).toBe(3);
    expect(byId.get(w.paidInvoiceId)).toMatchObject({ unitCode: w.paidUnitCode, payable: false, bookingRef: null });
    expect(byId.get(w.recurringInvoiceId)).toMatchObject({ unitCode: w.paidUnitCode, payable: true, bookingRef: null });
    expect(byId.get(w.pendingInvoiceId)).toMatchObject({
      unitCode: w.pendingUnitCode,
      payable: true,
      bookingRef: w.pendingBookingRef,
    });
    expect(typeof res.body.data.support.contact).toBe('string');
    expect(res.body.data.support.contact.length).toBeGreaterThan(0);
  });

  it('checkout gate: auth required, owner only, paid → 409, own DUE passes to Stripe (503 here)', async () => {
    const w = await seedPayer(uniqueEmail());
    const stranger = await register(uniqueEmail());

    const anon = await api.post(`/api/v1/customer/invoices/${w.recurringInvoiceId}/checkout`);
    expect(anon.status).toBe(401);

    const foreign = await api
      .post(`/api/v1/customer/invoices/${w.recurringInvoiceId}/checkout`)
      .set('Authorization', `Bearer ${stranger}`);
    expect(foreign.status).toBe(404);

    const paid = await api
      .post(`/api/v1/customer/invoices/${w.paidInvoiceId}/checkout`)
      .set('Authorization', `Bearer ${w.token}`);
    expect(paid.status).toBe(409);

    const own = await api
      .post(`/api/v1/customer/invoices/${w.recurringInvoiceId}/checkout`)
      .set('Authorization', `Bearer ${w.token}`);
    expect(own.status).toBe(503);
    expect(own.body.error.code).toBe('STRIPE_NOT_CONFIGURED');

    // Session creation never marks anything paid.
    await expect(prisma.invoice.findUnique({ where: { id: w.recurringInvoiceId } })).resolves.toMatchObject({
      status: 'DUE',
    });
  });

  it('webhook flips exactly that invoice to PAID, is idempotent, and leaves bookings alone', async () => {
    const w = await seedPayer(uniqueEmail());
    await prisma.invoice.update({ where: { id: w.recurringInvoiceId }, data: { stripeSessionId: 'cs_inv_1' } });

    const first = await applyInvoiceCheckoutCompleted(invoiceSession('cs_inv_1', w.recurringInvoiceId, 12000));
    expect(first.applied).toBe(true);
    const row = await prisma.invoice.findUnique({ where: { id: w.recurringInvoiceId } });
    expect(row).toMatchObject({ status: 'PAID', method: 'Card', stripeSessionId: 'cs_inv_1', paymentIntentId: 'pi_cs_inv_1' });
    expect(Number(row!.amountPaid)).toBe(120);
    expect(row!.paidAt).toBeInstanceOf(Date);

    const replay = await applyInvoiceCheckoutCompleted(invoiceSession('cs_inv_1', w.recurringInvoiceId, 12000));
    expect(replay.applied).toBe(false);

    // Other invoices + the unpaid booking are untouched.
    await expect(prisma.invoice.findUnique({ where: { id: w.pendingInvoiceId } })).resolves.toMatchObject({ status: 'DUE' });
    await expect(prisma.booking.findUnique({ where: { bookingRef: w.pendingBookingRef } })).resolves.toMatchObject({
      status: 'PENDING_PAYMENT',
    });
  });

  it('webhook ignores a session that does not match the stored one, and unpaid sessions', async () => {
    const w = await seedPayer(uniqueEmail());
    await prisma.invoice.update({ where: { id: w.recurringInvoiceId }, data: { stripeSessionId: 'cs_inv_real' } });

    const foreign = await applyInvoiceCheckoutCompleted(invoiceSession('cs_inv_other', w.recurringInvoiceId, 12000));
    expect(foreign.applied).toBe(false);
    const unpaid = await applyInvoiceCheckoutCompleted(
      invoiceSession('cs_inv_real', w.recurringInvoiceId, 12000, 'unpaid'),
    );
    expect(unpaid.applied).toBe(false);
    await expect(prisma.invoice.findUnique({ where: { id: w.recurringInvoiceId } })).resolves.toMatchObject({
      status: 'DUE',
    });
  });

  it('receipt: PDF for an owned PAID invoice; 409 while DUE; 404 for strangers', async () => {
    const w = await seedPayer(uniqueEmail());
    const stranger = await register(uniqueEmail());

    const pdf = await api
      .get(`/api/v1/customer/invoices/${w.paidInvoiceId}/receipt`)
      .set('Authorization', `Bearer ${w.token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/attachment; filename="StoreLah-receipt-INV-E2E-1/);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    // Recurring-invoice receipt: billing period + invoice quote, never a move-in line.
    const text = pdfText(pdf.body as Buffer);
    expect(text).toMatch(/Invoice no\./);
    expect(text).toMatch(/INV-E2E-1/);
    expect(text).toMatch(/Billing period: /);
    expect(text).not.toMatch(/Move-in date:/);
    expect(text).toMatch(/quote invoice INV-E2E-1/);

    const due = await api
      .get(`/api/v1/customer/invoices/${w.recurringInvoiceId}/receipt`)
      .set('Authorization', `Bearer ${w.token}`);
    expect(due.status).toBe(409);

    const foreign = await api
      .get(`/api/v1/customer/invoices/${w.paidInvoiceId}/receipt`)
      .set('Authorization', `Bearer ${stranger}`);
    expect(foreign.status).toBe(404);
  });

  it('move-out notice accepts the unit code /portal exposes, across tenant rows; strangers 404', async () => {
    const w = await seedPayer(uniqueEmail());
    const stranger = await register(uniqueEmail());
    const lastDay = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();

    // Unit B lives on the customer's SECOND tenant row.
    const byCode = await api
      .post('/api/v1/customer/notice')
      .set('Authorization', `Bearer ${w.token}`)
      .send({ unitId: w.pendingUnitCode, lastDay });
    expect(byCode.status).toBe(200);
    expect(byCode.body.data).toMatchObject({ status: 'SUBMITTED', unitCode: w.pendingUnitCode });

    const foreign = await api
      .post('/api/v1/customer/notice')
      .set('Authorization', `Bearer ${stranger}`)
      .send({ unitId: w.paidUnitCode, lastDay });
    expect(foreign.status).toBe(404);
  });
});

// Portal invoice payments (Stripe Checkout, TEST MODE) + per-invoice receipts.
//
// Booking payments keep their own flow (core/checkout.ts). This module adds
// the missing piece for everything after move-in: a signed-in customer can
// pay any of their own DUE/OVERDUE invoices from the portal, and download a
// PDF receipt for a PAID one.
//
// Flow:
//   1. POST /customer/invoices/:id/checkout (Bearer required, owner only) →
//      Stripe Checkout Session for the invoice's server-side amount (SGD).
//      metadata { kind: 'invoice', invoiceId, invoiceNo }. Idempotent: an
//      open session stored on Invoice.stripeSessionId is reused and concurrent
//      creates are deduped. An invoice that belongs to a still-PENDING_PAYMENT
//      booking (same tenant + unit) is delegated to the booking checkout so
//      confirmation, occupancy and tenant linkage keep their single path.
//   2. Stripe redirects to BOOKING_APP_URL/portal?screen=invoices&paid=<no>
//      &session_id={CHECKOUT_SESSION_ID} (cancel → ?screen=invoices).
//   3. POST /customer/stripe/webhook routes checkout.session.completed with
//      metadata.kind === 'invoice' to applyInvoiceCheckoutCompleted, which
//      flips exactly that invoice DUE/OVERDUE → PAID (conditional write, so
//      retried deliveries are no-ops). Bookings/units are never touched here.
//   4. GET /customer/invoices/:id/receipt → application/pdf for a PAID invoice
//      the caller owns (reuses the booking receipt layout in receiptPdf.ts).
//
// Ownership: an invoice belongs to the caller when its Tenant row's email
// matches the Customer's email (case-insensitive) — the same email-keyed
// linkage GET /portal uses (a customer can hold several Tenant rows, one per
// paid unit).

import type Stripe from 'stripe';
import type { Invoice } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import type { CustomerJwtPayload } from '../middleware/auth';
import { createCheckoutSession, getBookingAppUrl, getStripe } from './checkout';
import { loadCustomer } from './customers';
import { resolveSupportContact, type BookingConfirmationData } from './emails';
import { buildReceiptPdfBytes, deriveReceiptNumber } from './receiptPdf';
import { loadOwnedPaymentMethod } from './savedCards';

export const INVOICE_SESSION_KIND = 'invoice';

const PAYABLE: Array<Invoice['status']> = ['DUE', 'OVERDUE'];

async function loadOwnedInvoice(caller: CustomerJwtPayload, invoiceId: string) {
  const customer = await loadCustomer(caller);
  const email = customer.email?.trim();
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { tenant: true, unit: { include: { branch: true } } },
  });
  // Same 404 for "missing" and "not yours" — never confirms another
  // customer's invoice id exists.
  if (
    !invoice ||
    !email ||
    (invoice.tenant.email ?? '').trim().toLowerCase() !== email.toLowerCase()
  ) {
    throw new AppError(404, 'NOT_FOUND', 'Invoice not found');
  }
  return { customer, invoice };
}

/** PENDING_PAYMENT booking this invoice opens (same tenant + unit), if any. */
export async function pendingBookingForInvoice(invoice: Pick<Invoice, 'tenantId' | 'unitId'>) {
  return prisma.booking.findFirst({
    where: { tenantId: invoice.tenantId, unitId: invoice.unitId, status: 'PENDING_PAYMENT' },
    orderBy: { createdAt: 'desc' },
    select: { bookingRef: true },
  });
}

const pendingCreates = new Map<string, Promise<{ sessionId: string; url: string }>>();

export async function createInvoiceCheckoutSession(
  caller: CustomerJwtPayload,
  invoiceId: string,
): Promise<{ sessionId: string; url: string }> {
  const { customer, invoice } = await loadOwnedInvoice(caller, invoiceId);
  if (!PAYABLE.includes(invoice.status)) {
    throw new AppError(409, 'CONFLICT', 'This invoice is already paid');
  }

  // First invoice of an unpaid booking → the booking checkout owns it.
  const pending = await pendingBookingForInvoice(invoice);
  if (pending) {
    return createCheckoutSession({ bookingRef: pending.bookingRef }, caller);
  }

  const amountSgd = toNum(invoice.amount);
  if (!(amountSgd > 0)) {
    throw new AppError(409, 'CONFLICT', 'This invoice has no amount due');
  }

  // Reuse an open session for this invoice (sequential double POSTs, retries).
  if (invoice.stripeSessionId) {
    try {
      const existing = await getStripe().checkout.sessions.retrieve(invoice.stripeSessionId);
      if (existing.status === 'open' && existing.payment_status !== 'paid' && existing.url) {
        return { sessionId: existing.id, url: existing.url };
      }
    } catch {
      // Unknown/expired stored id — mint a fresh session below.
    }
  }

  const queued = pendingCreates.get(invoice.id);
  if (queued) return queued;

  const task = (async () => {
    const appUrl = getBookingAppUrl();
    const successUrl =
      `${appUrl}/portal?screen=invoices&paid=${encodeURIComponent(invoice.invoiceNo)}` +
      `&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${appUrl}/portal?screen=invoices`;
    const email = customer.email?.trim() || invoice.tenant.email?.trim() || undefined;
    const session = await getStripe().checkout.sessions.create({
      mode: 'payment',
      currency: 'sgd',
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'sgd',
            unit_amount: Math.round(amountSgd * 100),
            product_data: {
              name: `StoreLah invoice ${invoice.invoiceNo} — unit ${invoice.unit.unitCode}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        kind: INVOICE_SESSION_KIND,
        invoiceId: invoice.id,
        invoiceNo: invoice.invoiceNo,
        unitCode: invoice.unit.unitCode,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    if (!session.id || !session.url) {
      throw new AppError(500, 'INTERNAL', 'Stripe did not return a checkout URL');
    }
    console.log(
      `[invoice-checkout] session created invoiceNo=${invoice.invoiceNo} sessionId=${session.id}`,
    );
    // Persist at creation: the webhook matches on it and the next create
    // reuses the session while it stays open.
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { stripeSessionId: session.id },
    });
    return { sessionId: session.id, url: session.url };
  })();
  pendingCreates.set(invoice.id, task);
  try {
    return await task;
  } finally {
    pendingCreates.delete(invoice.id);
  }
}

/**
 * Webhook side for invoice sessions. IDEMPOTENT: the write is conditional on
 * the invoice still being DUE/OVERDUE, so retried deliveries flip nothing.
 * The invoice is matched by metadata.invoiceId AND (when stored) the session
 * id, so a stale/foreign session can never mark a different invoice paid.
 */
export async function applyInvoiceCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<{ invoiceNo: string | null; applied: boolean }> {
  const invoiceId = session.metadata?.invoiceId ?? null;
  if (!invoiceId) return { invoiceNo: null, applied: false };
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return { invoiceNo: session.metadata?.invoiceNo ?? null, applied: false };
  if (invoice.stripeSessionId && invoice.stripeSessionId !== session.id) {
    console.log(`[invoice-checkout] session mismatch for invoiceNo=${invoice.invoiceNo} — ignored`);
    return { invoiceNo: invoice.invoiceNo, applied: false };
  }
  if (session.payment_status !== 'paid') {
    return { invoiceNo: invoice.invoiceNo, applied: false };
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  const amountPaid =
    typeof session.amount_total === 'number' ? toNum(session.amount_total / 100) : toNum(invoice.amount);

  const flipped = await prisma.invoice.updateMany({
    where: { id: invoice.id, status: { in: PAYABLE } },
    data: {
      status: 'PAID',
      method: 'Card',
      stripeSessionId: session.id,
      paymentIntentId,
      paidAt: new Date(),
      amountPaid,
    },
  });
  if (flipped.count > 0) {
    console.log(`[invoice-checkout] invoiceNo=${invoice.invoiceNo} marked PAID`);
  }
  return { invoiceNo: invoice.invoiceNo, applied: flipped.count > 0 };
}

// ── Saved-card payment (PaymentIntent) ─────────────────────────────────
//
// POST /customer/invoices/:id/pay { paymentMethodId } charges one of the
// caller's saved cards (core/savedCards.ts) for the invoice's server-owned
// amount. The customer is present (slide-to-pay), so the PI is on-session and
// 3-D Secure comes back as requires_action + clientSecret for Stripe.js
// handleNextAction. The response NEVER marks the invoice paid —
// payment_intent.succeeded (applyInvoicePaymentSucceeded) is the only writer,
// matched on Invoice.paymentIntentId which is stamped here at creation.
//
// Double-charge guards: a stored PI that is succeeded/processing is returned
// as-is; a stored requires_action PI for the same card is resumed; the Stripe
// idempotency key is derived from (invoice, card, stored PI) so concurrent
// slides across Lambda instances converge on one PI, while a retry after a
// decline (stored PI now requires_payment_method) mints a fresh one.

export type SavedCardPayStatus = 'succeeded' | 'processing' | 'requires_action';

export interface SavedCardPayResult {
  status: SavedCardPayStatus;
  invoiceNo: string;
  paymentIntentId: string;
  clientSecret?: string;
}

const pendingPays = new Map<string, Promise<SavedCardPayResult>>();

function payResult(pi: Stripe.PaymentIntent, invoiceNo: string): SavedCardPayResult | null {
  if (pi.status === 'succeeded' || pi.status === 'processing') {
    return { status: pi.status === 'succeeded' ? 'succeeded' : 'processing', invoiceNo, paymentIntentId: pi.id };
  }
  if (pi.status === 'requires_action' && pi.client_secret) {
    return { status: 'requires_action', invoiceNo, paymentIntentId: pi.id, clientSecret: pi.client_secret };
  }
  return null;
}

function isStripeCardError(e: unknown): e is { type: string; message?: string; payment_intent?: Stripe.PaymentIntent } {
  return typeof e === 'object' && e !== null && (e as { type?: string }).type === 'StripeCardError';
}

export async function payInvoiceWithSavedCard(
  caller: CustomerJwtPayload,
  invoiceId: string,
  paymentMethodId: string,
): Promise<SavedCardPayResult> {
  const { customer, invoice } = await loadOwnedInvoice(caller, invoiceId);
  if (!PAYABLE.includes(invoice.status)) {
    throw new AppError(409, 'CONFLICT', 'This invoice is already paid');
  }
  // First invoice of an unpaid booking → hosted booking checkout owns it
  // (confirmation, occupancy and tenant linkage keep their single path).
  if (await pendingBookingForInvoice(invoice)) {
    throw new AppError(
      409,
      'USE_CHECKOUT',
      "This first payment confirms your booking — please pay it on Stripe's secure page",
    );
  }
  const amountSgd = toNum(invoice.amount);
  if (!(amountSgd > 0)) {
    throw new AppError(409, 'CONFLICT', 'This invoice has no amount due');
  }
  const { pm, stripeCustomerId } = await loadOwnedPaymentMethod(customer, paymentMethodId);
  const stripe = getStripe();
  const amountCents = Math.round(amountSgd * 100);

  // Resume / short-circuit on the PI already stamped on this invoice.
  if (invoice.paymentIntentId?.startsWith('pi_')) {
    try {
      const existing = await stripe.paymentIntents.retrieve(invoice.paymentIntentId);
      const samePm =
        (typeof existing.payment_method === 'string' ? existing.payment_method : existing.payment_method?.id) === pm.id;
      if (existing.status === 'succeeded' || existing.status === 'processing') {
        return payResult(existing, invoice.invoiceNo)!;
      }
      if (existing.status === 'requires_action' && samePm) {
        const resumed = payResult(existing, invoice.invoiceNo);
        if (resumed) return resumed;
      }
    } catch {
      // Unknown stored id — create below.
    }
  }

  const key = `${invoice.id}:${pm.id}`;
  const queued = pendingPays.get(key);
  if (queued) return queued;

  const task = (async (): Promise<SavedCardPayResult> => {
    const idempotencyKey = `inv-pay-${invoice.id}-${pm.id}-${amountCents}-${invoice.paymentIntentId ?? 'none'}`;
    let pi: Stripe.PaymentIntent;
    try {
      pi = await stripe.paymentIntents.create(
        {
          amount: amountCents,
          currency: 'sgd',
          customer: stripeCustomerId,
          payment_method: pm.id,
          payment_method_types: ['card'],
          confirm: true,
          off_session: false,
          // 3-D Secure runs in Stripe.js's in-page modal (handleNextAction)
          // so the customer stays in the pay sheet — no return_url redirect.
          use_stripe_sdk: true,
          description: `StoreLah invoice ${invoice.invoiceNo} — unit ${invoice.unit.unitCode}`,
          metadata: {
            kind: INVOICE_SESSION_KIND,
            invoiceId: invoice.id,
            invoiceNo: invoice.invoiceNo,
            unitCode: invoice.unit.unitCode,
          },
        },
        { idempotencyKey },
      );
    } catch (e) {
      if (isStripeCardError(e)) {
        // Remember the declined PI so the next attempt gets a fresh key.
        if (e.payment_intent?.id) {
          await prisma.invoice.update({ where: { id: invoice.id }, data: { paymentIntentId: e.payment_intent.id } });
        }
        console.log(`[invoice-pay] card declined invoiceNo=${invoice.invoiceNo}`);
        throw new AppError(402, 'CARD_DECLINED', e.message || 'Your card was declined');
      }
      throw e;
    }
    await prisma.invoice.update({ where: { id: invoice.id }, data: { paymentIntentId: pi.id } });
    console.log(`[invoice-pay] intent invoiceNo=${invoice.invoiceNo} pi=${pi.id} status=${pi.status}`);
    const result = payResult(pi, invoice.invoiceNo);
    if (!result) {
      throw new AppError(402, 'CARD_DECLINED', pi.last_payment_error?.message || 'Your card was declined');
    }
    return result;
  })();
  pendingPays.set(key, task);
  try {
    return await task;
  } finally {
    pendingPays.delete(key);
  }
}

/**
 * Webhook side for saved-card payments (payment_intent.succeeded with
 * metadata.kind === 'invoice'). IDEMPOTENT and scoped: the invoice must still
 * be DUE/OVERDUE AND carry this exact PaymentIntent id, so a stale or foreign
 * PI can never flip a different invoice. Bookings/units are never touched.
 */
export async function applyInvoicePaymentSucceeded(
  pi: Stripe.PaymentIntent,
): Promise<{ invoiceNo: string | null; applied: boolean }> {
  const invoiceId = pi.metadata?.invoiceId ?? null;
  if (!invoiceId || pi.status !== 'succeeded') {
    return { invoiceNo: pi.metadata?.invoiceNo ?? null, applied: false };
  }
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return { invoiceNo: pi.metadata?.invoiceNo ?? null, applied: false };
  if (invoice.paymentIntentId !== pi.id) {
    console.log(`[invoice-pay] intent mismatch for invoiceNo=${invoice.invoiceNo} — ignored`);
    return { invoiceNo: invoice.invoiceNo, applied: false };
  }
  const received = typeof pi.amount_received === 'number' && pi.amount_received > 0 ? pi.amount_received : pi.amount;
  const flipped = await prisma.invoice.updateMany({
    where: { id: invoice.id, status: { in: PAYABLE }, paymentIntentId: pi.id },
    data: {
      status: 'PAID',
      method: 'Card',
      paidAt: new Date(),
      amountPaid: toNum(received / 100),
    },
  });
  if (flipped.count > 0) {
    console.log(`[invoice-pay] invoiceNo=${invoice.invoiceNo} marked PAID`);
  }
  return { invoiceNo: invoice.invoiceNo, applied: flipped.count > 0 };
}

function monthLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(d);
}

/** Last 4 of the card that paid (best-effort; null when Stripe is unreachable/unconfigured). */
async function paidCardLast4(paymentIntentId: string | null): Promise<string | null> {
  if (!paymentIntentId?.startsWith('pi_') || !process.env.STRIPE_SECRET_KEY) return null;
  try {
    const pi = await getStripe().paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const charge = pi.latest_charge;
    if (!charge || typeof charge === 'string') return null;
    return charge.payment_method_details?.card?.last4 ?? null;
  } catch {
    return null;
  }
}

/** PDF receipt for a PAID invoice the caller owns. */
export async function buildInvoiceReceipt(
  caller: CustomerJwtPayload,
  invoiceId: string,
): Promise<{ filename: string; bytes: Buffer }> {
  const { customer, invoice } = await loadOwnedInvoice(caller, invoiceId);
  if (invoice.status !== 'PAID') {
    throw new AppError(409, 'CONFLICT', 'A receipt is available once this invoice is paid');
  }
  // Latest booking for the same tenant + unit supplies the booking ref and
  // tenancy context; recurring invoices print their billing month instead of
  // a move-in line (see BookingConfirmationData.detailLine).
  const booking = await prisma.booking.findFirst({
    where: { tenantId: invoice.tenantId, unitId: invoice.unitId },
    orderBy: { createdAt: 'desc' },
  });
  const bookingRef = booking?.bookingRef ?? invoice.invoiceNo;
  const period = monthLabel(invoice.billedMonth);
  const unitName = invoice.unit.name?.trim() || invoice.unit.unitCode;
  const data: BookingConfirmationData = {
    toEmail: invoice.tenant.email?.trim() || customer.email,
    customerName: invoice.tenant.name?.trim() || customer.name || null,
    bookingRef,
    unitCode: invoice.unit.unitCode,
    unitDisplayName: unitName,
    unitSqft: invoice.unit.sqft ?? null,
    branchName: invoice.unit.branch.name,
    branchAddress: invoice.unit.branch.address?.trim() || null,
    moveInDate: booking?.moveInDate ?? invoice.billedMonth,
    duration: booking?.duration ?? '',
    amountPaidSgd: toNum(invoice.amountPaid ?? invoice.amount),
    paymentMethod: invoice.method?.trim() || 'Card',
    cardLast4: await paidCardLast4(invoice.paymentIntentId),
    paidAt: invoice.paidAt ?? invoice.updatedAt,
    invoiceNo: invoice.invoiceNo,
    receiptUrl: null,
    // Not printed on the PDF; same fallback as the confirmation email.
    portalUrl: `${(process.env.BOOKING_APP_URL ?? 'https://app.storelah.sg').replace(/\/$/, '')}/portal`,
    supportContact: await resolveSupportContact(),
    receiptNumber: deriveReceiptNumber(bookingRef, invoice.invoiceNo, invoice.id),
    receiptAttached: true,
    detailLine: `Billing period: ${period}`,
    lineDescription: `Storage — ${unitName}, ${invoice.unit.branch.name} — ${period}`,
  };
  const bytes = await buildReceiptPdfBytes(data);
  const safe = invoice.invoiceNo.replace(/[^A-Za-z0-9-]+/g, '-');
  return { filename: `StoreLah-receipt-${safe}.pdf`, bytes };
}

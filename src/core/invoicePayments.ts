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
import { claimStripeEvent } from './finance/events';

export const INVOICE_SESSION_KIND = 'invoice';
/** Queued-charge PaymentIntents (core/finance/payments.ts) carry this kind. */
export const INSTRUCTION_SESSION_KIND = 'instruction';

/** Stored statuses that are real receivables (portal-visible, payable). */
export const RECEIVABLE_STATUSES: Array<Invoice['status']> = ['ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID'];
/** Pre-receivable or terminal statuses — the portal never sees these rows. */
export const PORTAL_HIDDEN_STATUSES: Array<Invoice['status']> = ['DRAFT', 'APPROVED', 'VOID', 'WRITTEN_OFF'];

const PAYABLE: Array<Invoice['status']> = [...RECEIVABLE_STATUSES];

/**
 * Open balance of an invoice (SGD): stamped `balanceDue` when a write has set
 * it, else lazily derived as total − paid (plan §1d — no mass backfill).
 */
export function openInvoiceBalance(inv: Pick<Invoice, 'amount' | 'amountPaid' | 'balanceDue'>): number {
  if (inv.balanceDue != null) return toNum(inv.balanceDue);
  return Math.round((toNum(inv.amount) - toNum(inv.amountPaid ?? 0)) * 100) / 100;
}

/** Calendar-day UTC truncation (Q5 timings: graceDays are whole days). */
function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * OVERDUE derivation for the portal (Q5: graceDays = 0 default → overdue the
 * next day after the due date; editable Global Setting, display-only — the
 * billing run never flips statuses and Phase 3 posts no late fees).
 */
export function isInvoiceOverdueByGrace(dueDate: Date, graceDays: number): boolean {
  const grace = Number.isFinite(graceDays) && graceDays > 0 ? Math.floor(graceDays) : 0;
  return startOfUtcDay(new Date()) > startOfUtcDay(new Date(dueDate)) + grace * 86400000;
}

export interface CustomerInvoiceShape {
  id: string;
  no: string;
  /** Invoice total — EXCEPT PARTIALLY_PAID, which shows the remaining balance
   * (same field, corrected semantics for a status the portal never had; no
   * new response fields — balanceDue/amountPaid stay deferred). */
  amount: number;
  dueDate: Date;
  status: 'DUE' | 'OVERDUE' | 'PAID';
  billedMonth: Date;
  method: string | null;
  paidAt: Date | null;
  payable: boolean;
}

/**
 * Single portal-serialization helper (EXACT shape, portal-safe). Both GET
 * /portal and every per-invoice read use this: DRAFT/APPROVED/VOID/
 * WRITTEN_OFF → null (hidden; callers 404 as "missing"), ISSUED → DUE,
 * PARTIALLY_PAID → DUE showing the remaining balance, OVERDUE derived by
 * billing.graceDays. PAID rows pass through unchanged.
 */
export function toCustomerInvoice(
  inv: Pick<Invoice, 'id' | 'invoiceNo' | 'amount' | 'amountPaid' | 'balanceDue' | 'dueDate' | 'status' | 'billedMonth' | 'method' | 'paidAt'>,
  graceDays = 0,
): CustomerInvoiceShape | null {
  if ((PORTAL_HIDDEN_STATUSES as Array<Invoice['status']>).includes(inv.status)) return null;
  if (inv.status === 'PAID') {
    return {
      id: inv.id, no: inv.invoiceNo, amount: toNum(inv.amount), dueDate: inv.dueDate,
      status: 'PAID', billedMonth: inv.billedMonth, method: inv.method, paidAt: inv.paidAt, payable: false,
    };
  }
  const overdue = inv.status === 'OVERDUE' || isInvoiceOverdueByGrace(inv.dueDate, graceDays);
  const amount = inv.status === 'PARTIALLY_PAID' ? Math.max(0, openInvoiceBalance(inv)) : toNum(inv.amount);
  return {
    id: inv.id, no: inv.invoiceNo, amount, dueDate: inv.dueDate,
    status: overdue ? 'OVERDUE' : 'DUE', billedMonth: inv.billedMonth, method: inv.method,
    paidAt: inv.paidAt, payable: true,
  };
}

async function loadOwnedInvoice(caller: CustomerJwtPayload, invoiceId: string) {
  const customer = await loadCustomer(caller);
  const email = customer.email?.trim();
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { tenant: true, unit: { include: { branch: true } } },
  });
  // Same 404 for "missing" and "not yours" — never confirms another
  // customer's invoice id exists. Pre-receivable (DRAFT/APPROVED) and
  // terminal (VOID/WRITTEN_OFF) rows are hidden the same way: the portal
  // only ever sees DUE/OVERDUE/PAID (toCustomerInvoice).
  if (
    !invoice ||
    !email ||
    (PORTAL_HIDDEN_STATUSES as Array<Invoice['status']>).includes(invoice.status) ||
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

  // Server-owned charge = the OPEN balance (total for a fresh invoice,
  // remaining balanceDue for PARTIALLY_PAID) — internal change only, the
  // response shape is unchanged.
  const amountSgd = openInvoiceBalance(invoice);
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
 * Shared receipt posting for every portal payment path (checkout sessions,
 * saved-card PIs, queued-charge PIs): adds the received amount to amountPaid
 * and flips to PAID only when the total is covered — otherwise the invoice
 * stays PARTIALLY_PAID with updated amounts. The write is conditional on the
 * invoice still being a receivable, so a retried delivery without an event id
 * still flips nothing (the HTTP webhook additionally claims the Stripe event
 * id first — duplicate event id → single apply).
 */
export async function postInvoiceReceiptTx(
  db: Pick<typeof prisma, 'invoice' | 'processedStripeEvent'>,
  invoice: Pick<Invoice, 'id' | 'invoiceNo' | 'amount' | 'amountPaid' | 'balanceDue' | 'status'>,
  receivedSgd: number,
  extra: { method?: string; stripeSessionId?: string | null; paymentIntentId?: string | null } = {},
): Promise<{ invoiceNo: string; applied: boolean; status: Invoice['status'] }> {
  const total = toNum(invoice.amount);
  const nowPaid = Math.round((toNum(invoice.amountPaid ?? 0) + receivedSgd) * 100) / 100;
  const paidInFull = nowPaid >= total - 0.005;
  const data = paidInFull
    ? {
        status: 'PAID' as const,
        method: extra.method ?? 'Card',
        paidAt: new Date(),
        amountPaid: nowPaid,
        balanceDue: 0,
        ...(extra.stripeSessionId !== undefined ? { stripeSessionId: extra.stripeSessionId } : {}),
        ...(extra.paymentIntentId !== undefined ? { paymentIntentId: extra.paymentIntentId } : {}),
      }
    : {
        status: 'PARTIALLY_PAID' as const,
        amountPaid: nowPaid,
        balanceDue: Math.round((total - nowPaid) * 100) / 100,
        ...(extra.stripeSessionId !== undefined ? { stripeSessionId: extra.stripeSessionId } : {}),
        ...(extra.paymentIntentId !== undefined ? { paymentIntentId: extra.paymentIntentId } : {}),
      };
  const flipped = await db.invoice.updateMany({
    where: { id: invoice.id, status: { in: PAYABLE } },
    data,
  });
  if (flipped.count > 0) {
    console.log(`[invoice-pay] invoiceNo=${invoice.invoiceNo} receipt ${receivedSgd} → ${data.status}`);
  }
  const fresh = await db.invoice.findUnique({ where: { id: invoice.id }, select: { status: true } });
  return { invoiceNo: invoice.invoiceNo, applied: flipped.count > 0, status: fresh?.status ?? invoice.status };
}

/** Non-transactional receipt posting (unit-level callers without an event id). */
export async function postInvoiceReceipt(
  invoice: Pick<Invoice, 'id' | 'invoiceNo' | 'amount' | 'amountPaid' | 'balanceDue' | 'status'>,
  receivedSgd: number,
  extra: { method?: string; stripeSessionId?: string | null; paymentIntentId?: string | null } = {},
) {
  return postInvoiceReceiptTx(prisma, invoice, receivedSgd, extra);
}

/**
 * Webhook side for invoice sessions. IDEMPOTENT twice over: the HTTP route
 * claims the Stripe event id first (duplicate delivery → applied:false
 * before touching the ledger), and the write is conditional on the invoice
 * still being a receivable, so retried deliveries flip nothing.
 * The invoice is matched by metadata.invoiceId AND (when stored) the session
 * id, so a stale/foreign session can never mark a different invoice paid.
 */
export async function applyInvoiceCheckoutCompleted(
  session: Stripe.Checkout.Session,
  opts: { eventId?: string } = {},
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
  const received =
    typeof session.amount_total === 'number' ? toNum(session.amount_total / 100) : openInvoiceBalance(invoice);
  const extra = { method: 'Card', stripeSessionId: session.id, paymentIntentId };
  // Unit-level callers (no event id) keep the historical conditional-write
  // path. The HTTP webhook passes its Stripe event id: claim + receipt share
  // one transaction, so a duplicate delivery applies exactly once and a crash
  // rolls the claim back with the writes.
  if (!opts.eventId) {
    const out = await postInvoiceReceipt(invoice, received, extra);
    return { invoiceNo: out.invoiceNo, applied: out.applied };
  }
  return prisma.$transaction(async (tx) => {
    const db = tx as unknown as Pick<typeof prisma, 'invoice' | 'processedStripeEvent'>;
    if (!(await claimStripeEvent(db, opts.eventId as string, 'checkout.session.completed'))) {
      return { invoiceNo: invoice.invoiceNo, applied: false };
    }
    const out = await postInvoiceReceiptTx(db, invoice, received, extra);
    return { invoiceNo: out.invoiceNo, applied: out.applied };
  });
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
  const amountSgd = openInvoiceBalance(invoice);
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
 * metadata.kind === 'invoice'). IDEMPOTENT and scoped: the HTTP route claims
 * the Stripe event id first (duplicate delivery → single apply), and the
 * invoice must still be a receivable AND carry this exact PaymentIntent id,
 * so a stale or foreign PI can never flip a different invoice. A receipt for
 * less than the balance leaves the invoice PARTIALLY_PAID with updated
 * amounts. Bookings/units are never touched.
 */
export async function applyInvoicePaymentSucceeded(
  pi: Stripe.PaymentIntent,
  opts: { eventId?: string } = {},
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
  const receivedCents =
    typeof pi.amount_received === 'number' && pi.amount_received > 0 ? pi.amount_received : pi.amount;
  const extra = { method: 'Card', paymentIntentId: pi.id };
  if (!opts.eventId) {
    const out = await postInvoiceReceipt(invoice, toNum(receivedCents / 100), extra);
    return { invoiceNo: out.invoiceNo, applied: out.applied };
  }
  return prisma.$transaction(async (tx) => {
    const db = tx as unknown as Pick<typeof prisma, 'invoice' | 'processedStripeEvent'>;
    if (!(await claimStripeEvent(db, opts.eventId as string, 'payment_intent.succeeded'))) {
      return { invoiceNo: invoice.invoiceNo, applied: false };
    }
    const out = await postInvoiceReceiptTx(db, invoice, toNum(receivedCents / 100), extra);
    return { invoiceNo: out.invoiceNo, applied: out.applied };
  });
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

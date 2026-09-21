// Stripe Checkout (hosted redirect, TEST MODE only) for the booking payment flow.
//
// Flow:
//   1. POST /customer/checkout/sessions { bookingRef, email?, mobile? } → Stripe Checkout
//      Session (amount computed server-side from the booking/invoice, SGD).
//      Idempotent per bookingRef: a stored open session is reused and
//      concurrent creates are deduped — no two active sessions for one
//      PENDING_PAYMENT booking. The session id is persisted on the booking.
//   2. Customer pays on Stripe-hosted page → redirected to BOOKING_APP_URL.
//   3. POST /customer/stripe/webhook (checkout.session.completed) marks the
//      booking/invoice paid, scoped to the invoiced session (never bulk-flips
//      other DUE invoices). Idempotent on retried deliveries.
//   4. GET /customer/checkout/sessions/:id reflects Stripe truth for the
//      frontend return page.
//
// Payment-state mapping (no new states invented — schema already fits):
//   - Booking.status PENDING_PAYMENT → CONFIRMED on payment.
//   - Invoice.status DUE → PAID on payment (method recorded as 'Card').
// A booking that is already CONFIRMED/ACTIVE with no DUE invoice left for the
// session is a no-op (webhook retries). A CANCELLED booking is never resurrected.

import Stripe from 'stripe';
import { AccountType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import type { CustomerJwtPayload } from '../middleware/auth';

let stripeClient: Stripe | null = null;

function stripe(): Stripe {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new AppError(
      503,
      'STRIPE_NOT_CONFIGURED',
      'Stripe is not configured (STRIPE_SECRET_KEY is missing)',
    );
  }
  stripeClient = new Stripe(key);
  return stripeClient;
}

function bookingAppUrl(): string {
  const base = process.env.BOOKING_APP_URL;
  if (!base) {
    throw new AppError(
      503,
      'STRIPE_NOT_CONFIGURED',
      'Stripe is not configured (BOOKING_APP_URL is missing)',
    );
  }
  return base.replace(/\/$/, '');
}

type BookingWithRefs = Awaited<
  ReturnType<typeof loadBookingForCheckout>
>;

async function loadBookingForCheckout(bookingRef: string) {
  const booking = await prisma.booking.findUnique({
    where: { bookingRef },
    include: {
      unit: true,
      tenant: {
        include: {
          invoices: {
            where: { status: 'DUE' },
            orderBy: { createdAt: 'desc' },
          },
        },
      },
    },
  });
  if (!booking) {
    throw new AppError(404, 'NOT_FOUND', `Booking ${bookingRef} not found`);
  }
  return booking;
}

/**
 * Dual-mode access check, mirroring POST /customer/bookings:
 *  - GUEST booking (owning customer is type GUEST, or no customer row yet) →
 *    no auth required.
 *  - Authed booking (owning PERSONAL/BUSINESS customer) → the Bearer token
 *    must belong to the booking owner, else 401/403.
 * A present-but-invalid token never downgrades to guest — the route layer
 * already rejects it via extractCustomerPayload before reaching here.
 *
 * Narrow email-proof bypass (pay gate ONLY, no PII read): when there is no
 * Bearer caller but the request proves ownership with the booking's own
 * payer email (case-insensitive, trimmed) for THIS bookingRef, session
 * creation is allowed without a password/login. Safe because (a) bookingRef
 * is unguessable and already scopes the row, (b) only the payer holding the
 * confirmation email can present the exact address, and (c) this grants only
 * Stripe-session creation — never a PII read (portal/bookings/me stay
 * Bearer-gated). An optional `mobile` strengthens the proof when supplied
 * (digits-only comparison against the stored tenant mobile; a mismatch
 * falls through to 401) but is NEVER required — absent mobile still allows
 * via the email proof (back-compat with { bookingRef, email } clients).
 */
export async function assertCheckoutAccess(
  booking: BookingWithRefs,
  caller: CustomerJwtPayload | null,
  proof?: { email?: string; mobile?: string },
): Promise<void> {
  const owner = booking.tenant.email
    ? await prisma.customer.findUnique({
        where: { email: booking.tenant.email },
      })
    : null;
  const isGuestBooking =
    !owner || owner.type === AccountType.GUEST;
  if (isGuestBooking) return;
  if (!caller && proof?.email) {
    const claimed = proof.email.trim().toLowerCase();
    const tenantEmail = (booking.tenant.email ?? '').trim().toLowerCase();
    if (claimed && tenantEmail && claimed === tenantEmail) {
      // Optional mobile strengthening: when the caller volunteers a mobile
      // AND the tenant has a stored number, the digits must match — a
      // mismatch falls through to the 401 below (login remains available).
      // Absent input mobile, or no stored number to check against, keeps
      // the email proof sufficient (back-compat).
      const proofDigits = (proof.mobile ?? '').replace(/\D/g, '');
      const tenantDigits = (booking.tenant.mobile ?? '').replace(/\D/g, '');
      if (proofDigits && tenantDigits && proofDigits !== tenantDigits) {
        // Mobile offered but does not match — do not bypass.
      } else {
        return;
      }
    }
  }
  if (!caller) {
    throw new AppError(
      401,
      'UNAUTHORIZED',
      'Authentication is required to pay for this booking',
    );
  }
  if (caller.sub !== owner!.id) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'This booking belongs to a different customer',
    );
  }
}

// Server-side amount (SGD): the latest open (DUE) invoice for the booking's
// tenant+unit — which already encodes the server-side due-today recompute
// (unit rate − validated promo + catalog protection/addons) from booking
// creation — falling back to the booking amount (unit monthly rate).
// The client never supplies an amount.
function chargeableAmountSgd(booking: BookingWithRefs): number {
  const invoiced = booking.tenant.invoices[0];
  return invoiced ? toNum(invoiced.amount) : toNum(booking.amount);
}

// In-flight session creates per bookingRef: a double-click (two concurrent
// POSTs) shares one Stripe call instead of minting two sessions. Best-effort
// single-instance guard (same per-instance caveat as the claim rate limiter
// in core/customers.ts); the durable guards are Booking.stripeSessionId plus
// the open-session reuse below.
const pendingCreates = new Map<string, Promise<{ sessionId: string; url: string }>>();

// Reuse the stored session when Stripe still reports it open — covers both
// sequential double POSTs and retries after a stored-but-unreturned create.
// Returns null when there is nothing reusable (no stored id, unknown id,
// completed/expired session, or an open session with no redirect URL left).
async function findReusableSession(
  booking: BookingWithRefs,
): Promise<{ sessionId: string; url: string } | null> {
  if (!booking.stripeSessionId) return null;
  try {
    const existing = await stripe().checkout.sessions.retrieve(booking.stripeSessionId);
    if (existing.status === 'open' && existing.payment_status !== 'paid' && existing.url) {
      return { sessionId: existing.id, url: existing.url };
    }
  } catch {
    // Unknown/expired stored id — fall through and mint a fresh session.
  }
  return null;
}

export interface CreateCheckoutSessionInput {
  bookingRef: string;
  email?: string;
  mobile?: string;
}

export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
  caller: CustomerJwtPayload | null,
): Promise<{ sessionId: string; url: string }> {
  const booking = await loadBookingForCheckout(input.bookingRef);
  await assertCheckoutAccess(booking, caller, {
    email: input.email,
    mobile: input.mobile,
  });

  if (booking.status === 'CANCELLED') {
    throw new AppError(409, 'CONFLICT', 'This booking was cancelled and cannot be paid');
  }
  if (booking.status !== 'PENDING_PAYMENT') {
    throw new AppError(409, 'CONFLICT', 'This booking has already been paid');
  }

  const email = input.email?.trim() || booking.tenant.email || undefined;
  if (!email) {
    throw new AppError(400, 'VALIDATION', 'No email is available for this booking');
  }

  const amountSgd = chargeableAmountSgd(booking);
  if (!(amountSgd > 0)) {
    throw new AppError(409, 'CONFLICT', 'This booking has no amount due');
  }
  const unitAmount = Math.round(amountSgd * 100); // SGD cents

  const appUrl = bookingAppUrl();

  // Idempotency per bookingRef: prefer the stored open session over minting.
  const reusable = await findReusableSession(booking);
  if (reusable) return reusable;

  // Dedupe concurrent creates (double-click safe): queued callers await the
  // in-flight Stripe call instead of minting a second session.
  const queued = pendingCreates.get(booking.bookingRef);
  if (queued) return queued;

  const task = (async () => {
    // Return origin resolves from BOOKING_APP_URL only — there is no
    // per-request return-URL override (the POST /customer/checkout/sessions
    // contract stays { bookingRef, email } → { sessionId, url }). The
    // effective URLs are logged after creation so each session can be
    // correlated in the Stripe Dashboard.
    const successUrl = `${appUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${appUrl}/checkout/cancel`;
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      currency: 'sgd',
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'sgd',
            unit_amount: unitAmount,
            product_data: {
              name: `StoreLah booking ${booking.bookingRef} — ${booking.unit.unitCode}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        bookingRef: booking.bookingRef,
        unitCode: booking.unit.unitCode,
        email,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    if (!session.id || !session.url) {
      throw new AppError(500, 'INTERNAL', 'Stripe did not return a checkout URL');
    }
    // Log the effective return URLs at creation for Stripe Dashboard
    // correlation (session id + booking ref + resolved origin).
    console.log(
      `[checkout] session created bookingRef=${booking.bookingRef} ` +
        `sessionId=${session.id} success_url=${successUrl} cancel_url=${cancelUrl}`,
    );
    // Persist the session id at creation time: the webhook lookup prefers it
    // over metadata, and the next create call reuses the session while open.
    await prisma.booking.update({
      where: { id: booking.id },
      data: { stripeSessionId: session.id },
    });
    return { sessionId: session.id, url: session.url };
  })();
  pendingCreates.set(booking.bookingRef, task);
  try {
    return await task;
  } finally {
    pendingCreates.delete(booking.bookingRef);
  }
}

export async function getCheckoutSessionStatus(sessionId: string): Promise<{
  status: string;
  paymentStatus: string;
  bookingRef: string | null;
}> {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  return {
    status: session.status ?? 'unknown',
    paymentStatus: session.payment_status ?? 'unknown',
    bookingRef: session.metadata?.bookingRef ?? null,
  };
}

/**
 * Marks booking + invoice paid for a completed Checkout Session. IDEMPOTENT:
 * current state is read first and conditional writes (status filters) make
 * retried deliveries safe no-ops. Scoped to the invoiced session: only the
 * DUE invoice whose amount matches what Stripe collected is flipped (latest
 * DUE as fallback so single-invoice bookings keep working through any
 * rounding drift) — other DUE invoices for the tenant are never touched,
 * keeping future recurring billing safe.
 */
export async function applyCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<{ bookingRef: string | null; applied: boolean }> {
  const sessionId = session.id;
  const metadataRef = session.metadata?.bookingRef ?? null;

  // Prefer the stored session id (tamper-proof server linkage over the
  // client-echoed metadata ref); fall back to metadata.bookingRef for
  // sessions minted before the id was persisted.
  let booking = sessionId
    ? await prisma.booking.findFirst({
        where: { stripeSessionId: sessionId },
        include: {
          tenant: {
            include: { invoices: true },
          },
        },
      })
    : null;
  if (!booking && metadataRef) {
    booking = await prisma.booking.findUnique({
      where: { bookingRef: metadataRef },
      include: {
        tenant: {
          include: { invoices: true },
        },
      },
    });
  }
  if (!booking) return { bookingRef: metadataRef, applied: false };
  if (booking.status === 'CANCELLED') return { bookingRef: booking.bookingRef, applied: false };

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  const amountPaid =
    typeof session.amount_total === 'number' ? toNum(session.amount_total / 100) : null;
  const paidAt = new Date();

  const dueInvoices = booking.tenant.invoices
    .filter((i) => i.tenantId === booking!.tenantId && i.unitId === booking!.unitId && i.status === 'DUE')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const target =
    amountPaid != null
      ? (dueInvoices.find((i) => Math.abs(toNum(i.amount) - amountPaid) < 0.01) ?? dueInvoices[0] ?? null)
      : (dueInvoices[0] ?? null);

  // No DUE invoice left for the session and the booking already left
  // PENDING_PAYMENT → this delivery (or an earlier one) already applied.
  if (!target && (booking.status === 'CONFIRMED' || booking.status === 'ACTIVE')) {
    return { bookingRef: booking.bookingRef, applied: false };
  }

  await prisma.$transaction(async (tx) => {
    // Preserve first-payment stamps on retried deliveries: only fill columns
    // that are still null, but always refresh the session linkage.
    const bookingPatch: {
      status?: typeof booking.status;
      stripeSessionId: string;
      paymentIntentId?: string | null;
      paidAt?: Date;
      amountPaid?: number;
    } = { stripeSessionId: sessionId };
    if (booking!.status === 'PENDING_PAYMENT') bookingPatch.status = 'CONFIRMED';
    if (paymentIntentId && !booking!.paymentIntentId) bookingPatch.paymentIntentId = paymentIntentId;
    if (!booking!.paidAt) bookingPatch.paidAt = paidAt;
    if (amountPaid != null && booking!.amountPaid == null) bookingPatch.amountPaid = amountPaid;
    await tx.booking.update({
      where: { id: booking!.id },
      data: bookingPatch,
    });
    if (target) {
      // Conditional on status DUE + row id so concurrent/retried deliveries
      // only ever flip this one invoice once.
      await tx.invoice.updateMany({
        where: { id: target.id, status: 'DUE' },
        data: {
          status: 'PAID',
          method: 'Card',
          stripeSessionId: sessionId,
          paymentIntentId,
          paidAt,
          amountPaid: amountPaid ?? toNum(target.amount),
        },
      });
    }
  });

  return { bookingRef: booking.bookingRef, applied: true };
}

/**
 * Verifies the `stripe-signature` header against STRIPE_WEBHOOK_SECRET using
 * the RAW request body (the route runs under the express.raw mount in
 * src/app.ts, registered BEFORE express.json).
 */
export function constructWebhookEvent(
  rawBody: Buffer,
  signature: string | undefined,
): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new AppError(
      503,
      'STRIPE_NOT_CONFIGURED',
      'Stripe is not configured (STRIPE_WEBHOOK_SECRET is missing)',
    );
  }
  if (!signature) {
    throw new AppError(400, 'INVALID_SIGNATURE', 'Missing stripe-signature header');
  }
  try {
    return stripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new AppError(400, 'INVALID_SIGNATURE', 'Invalid webhook signature');
  }
}

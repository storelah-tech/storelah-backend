// Stripe Checkout (hosted redirect, TEST MODE only) for the booking payment flow.
//
// Flow:
//   1. POST /customer/checkout/sessions { bookingRef, email? } → Stripe Checkout
//      Session (amount computed server-side from the booking/invoice, SGD).
//   2. Customer pays on Stripe-hosted page → redirected to BOOKING_APP_URL.
//   3. POST /customer/stripe/webhook (checkout.session.completed) marks the
//      booking/invoice paid. Idempotent on retried deliveries.
//   4. GET /customer/checkout/sessions/:id reflects Stripe truth for the
//      frontend return page.
//
// Payment-state mapping (no new states invented — schema already fits):
//   - Booking.status PENDING_PAYMENT → CONFIRMED on payment.
//   - Invoice.status DUE → PAID on payment (method recorded as 'Card').
// A booking that is already CONFIRMED/ACTIVE with all invoices PAID is a
// no-op (webhook retries). A CANCELLED booking is never resurrected.

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
 */
export async function assertCheckoutAccess(
  booking: BookingWithRefs,
  caller: CustomerJwtPayload | null,
): Promise<void> {
  const owner = booking.tenant.email
    ? await prisma.customer.findUnique({
        where: { email: booking.tenant.email },
      })
    : null;
  const isGuestBooking =
    !owner || owner.type === AccountType.GUEST;
  if (isGuestBooking) return;
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
// tenant+unit — which already encodes totalDueToday/promo/quote logic from
// booking creation — falling back to the booking amount (unit monthly rate).
// The client never supplies an amount.
function chargeableAmountSgd(booking: BookingWithRefs): number {
  const invoiced = booking.tenant.invoices[0];
  return invoiced ? toNum(invoiced.amount) : toNum(booking.amount);
}

export interface CreateCheckoutSessionInput {
  bookingRef: string;
  email?: string;
}

export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
  caller: CustomerJwtPayload | null,
): Promise<{ sessionId: string; url: string }> {
  const booking = await loadBookingForCheckout(input.bookingRef);
  await assertCheckoutAccess(booking, caller);

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
    success_url: `${appUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/checkout/cancel`,
  });

  if (!session.id || !session.url) {
    throw new AppError(500, 'INTERNAL', 'Stripe did not return a checkout URL');
  }
  return { sessionId: session.id, url: session.url };
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
 * Marks booking + invoices paid for a completed Checkout Session. IDEMPOTENT:
 * current state is read first and conditional writes (status filters) make
 * retried deliveries safe no-ops.
 */
export async function applyCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<{ bookingRef: string | null; applied: boolean }> {
  const bookingRef = session.metadata?.bookingRef ?? null;
  if (!bookingRef) return { bookingRef: null, applied: false };

  const booking = await prisma.booking.findUnique({
    where: { bookingRef },
    include: {
      tenant: {
        include: { invoices: true },
      },
    },
  });
  if (!booking) return { bookingRef, applied: false };
  if (booking.status === 'CANCELLED') return { bookingRef, applied: false };

  const openInvoices = booking.tenant.invoices.filter(
    (i) => i.status !== 'PAID',
  );
  const alreadyPaid =
    (booking.status === 'CONFIRMED' || booking.status === 'ACTIVE') &&
    openInvoices.length === 0;
  if (alreadyPaid) return { bookingRef, applied: false };

  await prisma.$transaction(async (tx) => {
    if (booking.status === 'PENDING_PAYMENT') {
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: 'CONFIRMED' },
      });
    }
    // Conditional on status DUE so concurrent/retried deliveries only ever
    // flip each invoice once.
    await tx.invoice.updateMany({
      where: {
        tenantId: booking.tenantId,
        unitId: booking.unitId,
        status: 'DUE',
      },
      data: { status: 'PAID', method: 'Card' },
    });
  });

  return { bookingRef, applied: true };
}

/**
 * Verifies the `stripe-signature` header against STRIPE_WEBHOOK_SECRET using
 * the RAW request body (the route must run under express.raw — see index.ts).
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

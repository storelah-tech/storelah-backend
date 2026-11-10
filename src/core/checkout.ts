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
//   - Unit.status AVAILABLE (or legacy RESERVED) → OCCUPIED on verified
//     payment, in the same transaction. Unpaid / cancelled bookings never
//     move the unit — it stays AVAILABLE while the invoice is DUE.
//   - Tenant linkage: the paid unit gains a Tenant row (email + unitId) via
//     linkTenantForPaidBooking, so GET /portal `units[]` (My Units = every
//     paid unit, no primary/secondary) surfaces it. Unpaid bookings stay under
//     `bookings[]` only.
// A booking that is already CONFIRMED/ACTIVE with no DUE invoice left for the
// session is a no-op (webhook retries). A CANCELLED booking is never resurrected.

import Stripe from 'stripe';
import { AccountType, type Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import type { CustomerJwtPayload } from '../middleware/auth';
import { markLeadWonForBooking } from './leads';
import { linkTenantForPaidBooking } from './customers';
import { sendBookingConfirmationForBooking } from './emails';

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

/** Shared Stripe client (also used by core/invoicePayments.ts). */
export function getStripe(): Stripe {
  return stripe();
}

/** BOOKING_APP_URL without a trailing slash (503 when unset). */
export function getBookingAppUrl(): string {
  return bookingAppUrl();
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
      unit: { include: { branch: true } },
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
 * Stripe DESCRIPTION COMPOSITION (canonical facility rename SW → SS).
 * facilityCode = uppercased branch.code (SS for Sembawang); unitDigits =
 * unitCode stripped of non-alphanumerics, minus any leading SW/SS/S facility
 * prefix; label = facilityCode + unitDigits (e.g. unitCode 1011 at SS →
 * SS1011; legacy SS-01-01 → SS0101). 4-digit branch-free codes stay
 * branch-free: they carry no prefix to strip and are never rewritten.
 */
export function buildFacilityUnitLabel(unitCode: string, branchCode?: string | null): string {
  const raw = (unitCode ?? '').trim();
  const alnum = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const digits = alnum.replace(/^(SW|SS|S)/, '');
  const facility = (branchCode ?? '').trim().toUpperCase() || 'SS';
  return `${facility}${digits}`;
}

/**
 * True when Stripe says the customer id does not exist (or was deleted) in the
 * account the current secret key belongs to.
 */
export function isMissingStripeCustomer(e: unknown): boolean {
  const err = e as { code?: string; statusCode?: number; message?: string } | null;
  if (!err) return false;
  if (err.code === 'resource_missing') return true;
  return /no such customer/i.test(err.message ?? '') || /deleted customer/i.test(err.message ?? '');
}

/**
 * Stripe Customer for the booking pay path, carrying name + email (mirrors
 * ensureStripeCustomer in core/savedCards.ts). Name priority:
 * booking.tenant.name → Customer.name. Returns null when Stripe/DB is
 * unreachable — the caller then falls back to customer_email so the pay
 * path never fails on customer linkage. Stripe rejects `customer` +
 * `customer_email` together, so exactly one is ever sent.
 */
async function resolveBookingStripeCustomer(
  booking: Pick<BookingWithRefs, 'id' | 'bookingRef'>,
  email: string | undefined,
  tenantName: string | undefined,
): Promise<string | null> {
  try {
    const stripeApi = stripe();
    const normalizedEmail = (email ?? '').trim();
    const customer = normalizedEmail
      ? await prisma.customer.findFirst({
          where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
        })
      : null;
    const name = tenantName || customer?.name || undefined;
    let staleStripeCustomerId: string | null = null;
    if (customer?.stripeCustomerId) {
      try {
        await stripeApi.customers.update(customer.stripeCustomerId, {
          ...(normalizedEmail ? { email: normalizedEmail } : {}),
          ...(name ? { name } : {}),
        });
        return customer.stripeCustomerId;
      } catch (e) {
        // Best-effort name/email sync — unless the stored id no longer exists
        // in this Stripe account (key/account/mode switched, or the customer
        // was deleted). Sending it to Checkout would fail with "No such
        // customer", so unlink it and create a fresh one below.
        if (!isMissingStripeCustomer(e)) return customer.stripeCustomerId;
        staleStripeCustomerId = customer.stripeCustomerId;
        await prisma.customer.updateMany({
          where: { id: customer.id, stripeCustomerId: staleStripeCustomerId },
          data: { stripeCustomerId: null },
        });
        console.warn(`[checkout] customer=${customer.id} stale Stripe customer unlinked — relinking`);
      }
    }
    if (customer) {
      const created = await stripeApi.customers.create(
        {
          email: normalizedEmail || customer.email,
          ...(name ? { name } : {}),
          metadata: { portalCustomerId: customer.id },
        },
        // A relink needs a new key: the original one may replay the dead id.
        {
          idempotencyKey: staleStripeCustomerId
            ? `portal-customer-${customer.id}-relink-${staleStripeCustomerId}`
            : `portal-customer-${customer.id}`,
        },
      );
      const won = await prisma.customer.updateMany({
        where: { id: customer.id, stripeCustomerId: null },
        data: { stripeCustomerId: created.id },
      });
      if (won.count > 0) return created.id;
      const fresh = await prisma.customer.findUnique({ where: { id: customer.id } });
      return fresh?.stripeCustomerId ?? created.id;
    }
    // Guest booking with no Customer row: ephemeral Stripe customer carrying
    // name + email (no DB linkage to persist).
    const created = await stripeApi.customers.create(
      {
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
        ...(name ? { name } : {}),
        metadata: { bookingRef: booking.bookingRef, bookingId: booking.id },
      },
      { idempotencyKey: `booking-customer-${booking.id}` },
    );
    return created.id;
  } catch {
    return null;
  }
}

/**
 * Email-proof for the pay gate ONLY (no PII read): the request proves
 * ownership with the booking's own payer email (case-insensitive, trimmed)
 * for THIS bookingRef. Safe because (a) bookingRef is unguessable and
 * already scopes the row, (b) only the payer holding the confirmation email
 * can present the exact address, and (c) this grants only Stripe-session
 * creation — never a PII read (portal/bookings/me stay Bearer-gated).
 *
 * USER RULE (binding): every guest can pay with email proof alone — `mobile`
 * is accepted in the body for back-compat but is NEVER compared and NEVER
 * blocks payment. A digits mismatch (e.g. stored "+65 0804901431" vs
 * supplied "804901431") or an absent mobile still passes when the email
 * matches. Wrong/missing email still fails the proof (safe 401/404).
 */
function hasValidEmailProof(
  booking: BookingWithRefs,
  proof?: { email?: string; mobile?: string },
): boolean {
  void proof?.mobile;
  const claimed = (proof?.email ?? '').trim().toLowerCase();
  const tenantEmail = (booking.tenant.email ?? '').trim().toLowerCase();
  if (!claimed || !tenantEmail || claimed !== tenantEmail) return false;
  return true;
}

/**
 * Dual-mode access check, mirroring POST /customer/bookings:
 *  - GUEST booking (owning customer is type GUEST, or no customer row yet) →
 *    no auth required.
 *  - Authed booking (owning PERSONAL/BUSINESS customer) → the Bearer token
 *    must belong to the booking owner, else 401/403.
 * A present-but-invalid token never downgrades to guest HERE — the route
 * layer decides: when the Bearer fails verification but the request carries
 * valid guest email-proof, the route retries as guest (caller=null) so a
 * stale session never blocks guest pay; without guest proof the route keeps
 * the hard 401 UNAUTHORIZED. An invalid token is therefore never accepted
 * as AUTHENTICATED — at worst it is treated as absent.
 *
 * USER RULE — guest-pay (SL-2026-1982 shape): booking payment works
 * regardless of portal login session. Every guest user can pay for a
 * PENDING_PAYMENT booking with email proof alone: the PENDING check below
 * is evaluated FIRST, independently of the owning Customer's type (GUEST or
 * REGISTERED/PERSONAL/BUSINESS), so a portal-created booking never requires
 * a Bearer token on this path. The legacy bypass after the owner lookup is
 * preserved so proof for non-PENDING bookings keeps surfacing the stable
 * 409 status errors (already paid / cancelled) instead of 401.
 */
export async function assertCheckoutAccess(
  booking: BookingWithRefs,
  caller: CustomerJwtPayload | null,
  proof?: { email?: string; mobile?: string },
): Promise<void> {
  // USER RULE — guest-pay FIRST: a PENDING_PAYMENT booking with valid email
  // proof never requires a Bearer token, regardless of the owning
  // Customer's type. Runs before the owner lookup so it never depends on
  // the Customer row resolving.
  if (!caller && booking.status === 'PENDING_PAYMENT' && hasValidEmailProof(booking, proof)) {
    return;
  }
  // Case-insensitive owner lookup so legacy mixed-case Customer/Tenant rows
  // resolve to the canonical account (see normalizeEmail in core/customers).
  const owner = booking.tenant.email
    ? await prisma.customer.findFirst({
        where: { email: { equals: booking.tenant.email.trim(), mode: 'insensitive' } },
      })
    : null;
  const isGuestBooking =
    !owner || owner.type === AccountType.GUEST;
  if (isGuestBooking) return;
  // Legacy bypass (preserved, additive): proof for a non-PENDING booking
  // still skips the auth requirement so the caller sees the stable 409
  // status errors below (already paid / cancelled) instead of 401.
  if (!caller && hasValidEmailProof(booking, proof)) {
    return;
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
// from booking creation (frontend-parity prorated first month: discounted
// rent prorated by move-in day + catalog protection/addons, deposit/admin $0,
// GST 0) — falling back to the booking amount (unit monthly rate).
// The client never supplies an amount; Stripe `unit_amount` is
// Math.round(amountSgd * 100), so the charged cents equal the booking-app Due
// Today summary to the cent whenever the server quote matches it.
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
    // DESCRIPTION COMPOSITION: facility + unit (e.g. SS1011). Missing
    // branch/code falls back to the raw unitCode in the name — never fail
    // the pay path on a missing branch.
    const branchCode = booking.unit.branch?.code ?? null;
    let label: string;
    let facilityCode: string;
    if (branchCode) {
      facilityCode = branchCode.trim().toUpperCase();
      label = buildFacilityUnitLabel(booking.unit.unitCode, branchCode);
    } else {
      facilityCode = '';
      label = booking.unit.unitCode;
      console.log(
        `[checkout] bookingRef=${booking.bookingRef} missing branch for unit ${booking.unit.unitCode} — using raw code`,
      );
    }
    const stripeCustomerId = await resolveBookingStripeCustomer(
      booking,
      email,
      booking.tenant.name?.trim() || undefined,
    );
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      currency: 'sgd',
      ...(stripeCustomerId ? { customer: stripeCustomerId } : { customer_email: email }),
      line_items: [
        {
          price_data: {
            currency: 'sgd',
            unit_amount: unitAmount,
            product_data: {
              name: `StoreLah ${label} — booking ${booking.bookingRef}`,
              description: label,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        bookingRef: booking.bookingRef,
        unitCode: booking.unit.unitCode,
        email,
        facilityCode,
        unitLabel: label,
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
  kind: 'booking' | 'invoice';
  invoiceNo: string | null;
}> {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  return {
    status: session.status ?? 'unknown',
    paymentStatus: session.payment_status ?? 'unknown',
    bookingRef: session.metadata?.bookingRef ?? null,
    // --- appended (additive): portal invoice sessions (core/invoicePayments.ts) ---
    kind: session.metadata?.kind === 'invoice' ? 'invoice' : 'booking',
    invoiceNo: session.metadata?.invoiceNo ?? null,
  };
}

/**
 * Verified-payment occupancy flip (shared by the fresh-payment path and the
 * idempotent-replay heal): the paid unit moves AVAILABLE → OCCUPIED in the
 * same transaction as the booking/invoice stamps. Legacy RESERVED rows
 * (pre-change unpaid holds — new bookings never produce RESERVED) move to
 * OCCUPIED for the same reason: a paid unit is occupied. Conditional on the
 * pre-payment statuses and scoped to this unit row only, so replays are safe
 * no-ops and an operator-set state applied after payment (MAINTENANCE /
 * BLOCKED / INACTIVE) is never overwritten. CANCELLED bookings early-return
 * before this is ever reached, so unpaid/cancelled units never flip.
 */
async function occupyUnitOnPayment(tx: Prisma.TransactionClient, unitId: string): Promise<void> {
  await tx.unit.updateMany({
    where: { id: unitId, status: { in: ['AVAILABLE', 'RESERVED'] } },
    data: { status: 'OCCUPIED' },
  });
}

/**
 * Marks booking + invoice paid for a completed Checkout Session. IDEMPOTENT:
 * current state is read first and conditional writes (status filters) make
 * retried deliveries safe no-ops. Scoped to the invoiced session: only the
 * DUE invoice whose amount matches what Stripe collected is flipped (latest
 * DUE as fallback so single-invoice bookings keep working through any
 * rounding drift) — other DUE invoices for the tenant are never touched,
 * keeping future recurring billing safe.
 *
 * Payment-won attribution: matching Lead(s) flip to WON in the same
 * transaction (see markLeadWonForBooking in core/leads.ts — heuristic contact
 * match, forward-only, LOST never resurrected). Best-effort: lead failures
 * never fail the payment. The booking frontend stays read-only on paid
 * verification, so this webhook is the single source of truth for WON.
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
          unit: { select: { id: true, unitCode: true, branchId: true, status: true } },
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
        unit: { select: { id: true, unitCode: true, branchId: true, status: true } },
      },
    });
  }
  if (!booking) return { bookingRef: metadataRef, applied: false };
  if (booking.status === 'CANCELLED') return { bookingRef: booking.bookingRef, applied: false };

  // Heuristic Lead↔Booking linkage (no FK exists): tenant contact plus the
  // booked unit/branch when available. Contact-only, never PII content, in
  // any log line below.
  const leadMatch = {
    email: booking.tenant.email,
    mobile: booking.tenant.mobile,
    unitCode: booking.unit.unitCode,
    branchId: booking.unit.branchId ?? booking.tenant.branchId ?? null,
  };

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
  // Still heal leads created after the first delivery (e.g. a late enquiry
  // for the same contact) — best-effort, never fails the webhook. Also heal
  // the My-Units tenant linkage in case the first delivery predated it, and
  // the unit occupancy flip in case the first delivery predated it.
  if (!target && (booking.status === 'CONFIRMED' || booking.status === 'ACTIVE')) {
    try {
      await markLeadWonForBooking(prisma, leadMatch);
    } catch {
      // Best-effort attribution only — the payment itself already applied.
    }
    try {
      await prisma.$transaction(async (tx) => {
        await linkTenantForPaidBooking(tx, { bookingId: booking!.id });
        await occupyUnitOnPayment(tx, booking!.unitId);
      });
    } catch {
      // Best-effort linkage/occupancy heal only — the payment itself already applied.
    }
    return { bookingRef: booking.bookingRef, applied: false };
  }

  // Fresh-payment evidence for the confirmation email below: only the
  // delivery that actually flips the DUE invoice (updateMany is conditional
  // on status DUE, so concurrent/retried deliveries flip zero rows) counts
  // as "paid now". A PENDING_PAYMENT booking with no DUE invoice left still
  // counts — it just turned CONFIRMED with nothing to flip.
  let invoiceFlipped = false;
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
      const flipped = await tx.invoice.updateMany({
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
      invoiceFlipped = flipped.count > 0;
    }
    // Payment-won attribution INSIDE the same transaction: matching leads flip
    // to WON atomically with the booking/invoice writes. Best-effort — a
    // failure here must never fail (or roll back) the payment, so errors are
    // swallowed; the log carries counts only, never contact values.
    try {
      const wonCount = await markLeadWonForBooking(tx, leadMatch);
      if (wonCount > 0) {
        console.log(`[checkout] bookingRef=${booking!.bookingRef} marked ${wonCount} lead(s) WON`);
      }
    } catch {
      console.log(`[checkout] bookingRef=${booking!.bookingRef} lead WON attribution skipped`);
    }
    // My-Units tenant linkage INSIDE the same transaction: the paid unit
    // becomes a Tenant row (email + unitId) so GET /portal `units[]` — and
    // every other email-keyed downstream read (map, summary, KPIs) — surfaces
    // it. Unlike lead attribution this is load-bearing (not best-effort): a
    // failure rolls back with the payment stamps and Stripe redelivers.
    const link = await linkTenantForPaidBooking(tx, { bookingId: booking!.id });
    if (link.created) {
      console.log(`[checkout] bookingRef=${booking!.bookingRef} linked additional unit tenant ${link.tenantId}`);
    }
    // Verified payment occupies the unit INSIDE the same transaction (see
    // occupyUnitOnPayment): the unit stayed AVAILABLE through the whole
    // unpaid window, so only the delivery that confirms payment moves it.
    await occupyUnitOnPayment(tx, booking!.unitId);
  });

  // Booking + payment confirmation email (AWS SES) — FIRST payment only.
  // Retried deliveries either early-return above (`applied: false`) or flip
  // zero invoices, so they never resend. Best-effort: the send helper never
  // throws (it logs + returns `{ sent: false }` when unconfigured/failing),
  // and this call is additionally guarded so email can never fail the
  // webhook — the payment stays applied regardless.
  if (invoiceFlipped || (booking.status === 'PENDING_PAYMENT' && !target)) {
    try {
      await sendBookingConfirmationForBooking(booking.id, {
        stripeSessionId: sessionId,
        paymentIntentId,
      });
    } catch (err) {
      console.error(
        `[checkout] bookingRef=${booking.bookingRef} confirmation email failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

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

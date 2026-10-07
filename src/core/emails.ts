// Booking + payment confirmation email (AWS SES).
//
// Sent best-effort from the Stripe `checkout.session.completed` webhook path
// (`applyCheckoutCompleted` in core/checkout.ts) after the booking/invoice
// writes commit. Email failure NEVER fails the payment: every send path
// catches, logs, and returns `{ sent: false }` instead of throwing.
//
// Idempotency: the caller only invokes the send on a fresh payment (an
// invoice actually flipped DUE → PAID, or a PENDING_PAYMENT booking with no
// DUE invoice left that just turned CONFIRMED). Retried webhook deliveries
// find no DUE invoice and early-return `applied: false`, so they never reach
// the send. This module performs no state checks itself — it renders + sends
// what it is given.
//
// Env (see .env.example — empty defaults, no secrets in code):
//   SES_FROM_EMAIL   — verified SES sender address (missing → send skipped).
//   SES_FROM_NAME    — sender display name (default "StoreLah").
//   AWS_SES_REGION   — SES send region (default "ap-southeast-1", matching the
//                      Lambda deploy region).
// Configuration sets: this module NEVER passes ConfigurationSetName (the
// SendRawEmail call carries only RawMessage) — there is deliberately no
// SES_CONFIGURATION_SET env var. If a send still fails with "not authorized
// ... on resource ...configuration-set/<name>", that set is the SES sender
// identity's DEFAULT configuration set (an AWS-side setting on the verified
// identity, not code): either grant the execution role ses:SendRawEmail on
// that configuration-set resource, or clear the default on the identity.
// See .env.example + docs/backend-deploy.md.
// Auth uses the default AWS credential chain: the Lambda execution role in
// prod (no keys in code), or explicit AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
// env vars for local dev.
// NODE_ENV handling: when NODE_ENV=test the network send is skipped outright
// (log + `{ sent: false, reason: 'test-env' }`) so hermetic e2e suites never
// touch SES. All other envs send when configured.

import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { getSetting } from './settings';
import { buildReceiptPdfBytes, deriveReceiptNumber, receiptFilename } from './receiptPdf';
import { quotationFilename } from './quotationPdf';

// StoreLah application theme tokens (booking-app palette): terra #BD6B50,
// dark #9E5139, light #F8ECE6, olive #5D6B55, olive-light #EEF0E8, cream
// #FBF7F1, charcoal #282B27, muted #746F66, border #E1D8CB, green #4F684C,
// green-bg #E8ECDF.
const C = {
  terra: '#BD6B50',
  terraDark: '#9E5139',
  terraLight: '#F8ECE6',
  olive: '#5D6B55',
  oliveLight: '#EEF0E8',
  cream: '#FBF7F1',
  charcoal: '#282B27',
  muted: '#746F66',
  border: '#E1D8CB',
  green: '#4F684C',
  greenBg: '#E8ECDF',
  white: '#FFFFFF',
} as const;

const SUPPORT_FALLBACK = 'ops@storelah.sg';

export function isEmailConfigured(): boolean {
  return Boolean(process.env.SES_FROM_EMAIL);
}

function fromSender(): { email: string; name: string } {
  return {
    email: process.env.SES_FROM_EMAIL ?? '',
    name: process.env.SES_FROM_NAME?.trim() || 'StoreLah',
  };
}

function sesRegion(): string {
  return process.env.AWS_SES_REGION?.trim() || 'ap-southeast-1';
}

export interface BookingConfirmationData {
  toEmail: string;
  customerName: string | null;
  bookingRef: string;
  unitCode: string;
  unitDisplayName: string;
  unitSqft: number | null;
  branchName: string;
  branchAddress: string | null;
  moveInDate: Date;
  duration: string;
  amountPaidSgd: number;
  paymentMethod: string;
  cardLast4: string | null;
  paidAt: Date;
  invoiceNo: string | null;
  receiptUrl: string | null;
  portalUrl: string;
  supportContact: string;
  // StoreLah PDF receipt (server-generated attachment — primary payment proof).
  // `receiptNumber` is derived deterministically from booking ref + invoice
  // (see deriveReceiptNumber in core/receiptPdf.ts). `receiptAttached` tells
  // the renderer whether the PDF is actually attached on this send: true →
  // attachment-primary layout; false → the Stripe `receiptUrl` (when present)
  // renders as a tiny fallback text link so payment proof is never dropped.
  // Both optional so existing builders keep compiling; the send path always
  // sets `receiptAttached` explicitly from the attachment bytes.
  receiptNumber?: string | null;
  receiptAttached?: boolean;
}

export interface BuiltBookingEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatSgd(amount: number): string {
  return new Intl.NumberFormat('en-SG', {
    style: 'currency',
    currency: 'SGD',
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatDay(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

function formatDateTime(d: Date): string {
  return (
    new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(d) +
    ', ' +
    new Intl.DateTimeFormat('en-SG', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d)
  );
}

/**
 * Renders the booking + payment confirmation email (HTML + plain-text).
 * Pure function — no I/O, safe to call from preview scripts and tests.
 */
export function buildBookingConfirmationEmail(d: BookingConfirmationData): BuiltBookingEmail {
  const subject = `Payment confirmed — booking ${d.bookingRef} (StoreLah)`;
  const greetingName = d.customerName?.trim() ? d.customerName.trim() : 'there';
  const amount = formatSgd(d.amountPaidSgd);
  const methodLine = d.cardLast4 ? `${d.paymentMethod} •••• ${d.cardLast4}` : d.paymentMethod;
  const unitLine = d.unitSqft ? `${d.unitDisplayName} · ${d.unitSqft} sqft` : d.unitDisplayName;

  const e = {
    name: escapeHtml(greetingName),
    ref: escapeHtml(d.bookingRef),
    unit: escapeHtml(unitLine),
    unitCode: escapeHtml(d.unitCode),
    branch: escapeHtml(d.branchName),
    branchAddress: escapeHtml(d.branchAddress ?? ''),
    moveIn: escapeHtml(formatDay(d.moveInDate)),
    duration: escapeHtml(d.duration),
    amount: escapeHtml(amount),
    method: escapeHtml(methodLine),
    paidAt: escapeHtml(formatDateTime(d.paidAt)),
    invoiceNo: escapeHtml(d.invoiceNo ?? '—'),
    receiptNumber: escapeHtml(d.receiptNumber?.trim() || deriveReceiptNumber(d.bookingRef, d.invoiceNo ?? null)),
    portalUrl: escapeHtml(d.portalUrl),
    support: escapeHtml(d.supportContact),
    receiptUrl: d.receiptUrl ? escapeHtml(d.receiptUrl) : null,
  };
  // Our PDF is the primary receipt. The Stripe hosted receipt_url survives
  // ONLY as a tiny fallback text link when the PDF could not be attached —
  // payment proof is never dropped entirely.
  const attached = d.receiptAttached ?? true;

  const receiptRow = attached
    ? `<tr>
        <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Receipt</td>
        <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.charcoal};">Attached PDF (${e.receiptNumber})</td>
      </tr>`
    : e.receiptUrl
      ? `<tr>
        <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Receipt</td>
        <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;"><a href="${e.receiptUrl}" style="color:${C.terraDark};text-decoration:underline;">View Stripe receipt</a></td>
      </tr>`
      : '';

  const attachNote = attached
    ? `<tr><td style="padding:12px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:${C.green};">&#10003;&nbsp; Your receipt is attached (PDF) — look for the attachment on this email.</td></tr>`
    : e.receiptUrl
      ? `<tr><td style="padding:12px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:${C.muted};">Your PDF receipt could not be attached — use the Stripe receipt link in the payment box above.</td></tr>`
      : '';

  const ctaBlock = `<tr><td align="center" style="padding:20px 32px 8px 32px;">
        <a href="${e.portalUrl}" style="display:inline-block;background-color:${C.terra};color:${C.white};font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:13px 32px;border-radius:8px;">Go to my portal</a>
      </td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:${C.cream};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${C.cream};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background-color:${C.white};border:1px solid ${C.border};border-radius:12px;overflow:hidden;">
        <tr>
          <td style="background-color:${C.terra};padding:28px 32px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:${C.white};">StoreLah</div>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.terraLight};padding-top:4px;">Self-storage, sorted.</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 8px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${C.greenBg};border-radius:8px;">
              <tr><td style="padding:14px 18px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:${C.green};">&#10003;&nbsp; Payment confirmed</td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:${C.charcoal};">
            Hi ${e.name},
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:${C.charcoal};">
            Thank you — your payment was successful and your booking is confirmed. Your booking reference is <strong>${e.ref}</strong>. Please keep it handy for move-in and support.
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:${C.charcoal};">Your booking</td>
        </tr>
        <tr><td style="padding:8px 32px 0 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ${C.border};border-radius:8px;">
            <tr><td style="padding:14px 18px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Booking ref</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:${C.charcoal};">${e.ref}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Unit</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.charcoal};">${e.unit} (${e.unitCode})</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Branch</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.charcoal};">${e.branch}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Move-in date</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.charcoal};">${e.moveIn}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Duration</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.charcoal};">${e.duration}</td>
                </tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
        <tr>
          <td style="padding:20px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:${C.charcoal};">Payment receipt</td>
        </tr>
        <tr><td style="padding:8px 32px 0 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ${C.border};border-radius:8px;">
            <tr><td style="padding:14px 18px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Amount paid</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:${C.charcoal};">${e.amount}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Method</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.charcoal};">${e.method}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Paid on</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.charcoal};">${e.paidAt}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Invoice</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.charcoal};">${e.invoiceNo}</td>
                </tr>
                ${receiptRow}
              </table>
            </td></tr>
          </table>
        </td></tr>
        <tr>
          <td style="padding:20px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:${C.charcoal};">Next steps</td>
        </tr>
        <tr>
          <td style="padding:8px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:${C.charcoal};">
            1. Save your booking reference <strong>${e.ref}</strong> — you will need it on move-in day.<br>
            2. Manage your booking, invoices and move-out notices anytime in the customer portal.<br>
            3. On your move-in date, head to ${e.branch}${e.branchAddress ? ` (${e.branchAddress})` : ''} with a photo ID and your own padlock.
          </td>
        </tr>
        ${ctaBlock}
        ${attachNote}
        <tr>
          <td style="padding:20px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:${C.muted};">
            Questions? Reply to this email or contact us at ${e.support} — quote your booking reference ${e.ref} so we can help faster.
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 28px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${C.muted};border-top:1px solid ${C.border};">
            <div style="padding-top:16px;">StoreLah · Self-storage, sorted.<br>This is a payment confirmation for booking ${e.ref}. You received this because a payment was made with your email address.</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const receiptTextLine = attached
    ? `  Receipt     : attached PDF (${d.receiptNumber?.trim() || deriveReceiptNumber(d.bookingRef, d.invoiceNo ?? null)})`
    : d.receiptUrl
      ? `  Receipt     : ${d.receiptUrl} (PDF unavailable)`
      : null;
  const textLines = [
    `StoreLah — Payment confirmed`,
    ``,
    `Hi ${greetingName},`,
    ``,
    `Thank you — your payment was successful and your booking is confirmed.`,
    `Booking reference: ${d.bookingRef}`,
    ``,
    `YOUR BOOKING`,
    `  Booking ref : ${d.bookingRef}`,
    `  Unit        : ${unitLine} (${d.unitCode})`,
    `  Branch      : ${d.branchName}`,
    ...(d.branchAddress ? [`  Address     : ${d.branchAddress}`] : []),
    `  Move-in date: ${formatDay(d.moveInDate)}`,
    `  Duration    : ${d.duration}`,
    ``,
    `PAYMENT RECEIPT`,
    `  Amount paid : ${amount}`,
    `  Method      : ${methodLine}`,
    `  Paid on     : ${formatDateTime(d.paidAt)}`,
    `  Invoice     : ${d.invoiceNo ?? '—'}`,
    ...(receiptTextLine ? [receiptTextLine] : []),
    ``,
    `NEXT STEPS`,
    `  1. Save your booking reference ${d.bookingRef} — you will need it on move-in day.`,
    `  2. Manage your booking, invoices and move-out notices in the customer portal: ${d.portalUrl}`,
    ...(attached
      ? [`  Your receipt is attached (PDF) — look for the attachment on this email.`]
      : []),
    `  3. On your move-in date, head to ${d.branchName} with a photo ID and your own padlock.`,
    ``,
    `Questions? Contact us at ${d.supportContact} and quote booking ${d.bookingRef}.`,
    ``,
    `StoreLah · Self-storage, sorted.`,
  ];
  return { subject, html, text: textLines.join('\n') };
}

/** Best-effort support contact: live `operations.supportContact` setting, else default. */
async function resolveSupportContact(): Promise<string> {
  try {
    const v = await getSetting('operations.supportContact');
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch {
    // Best-effort only — fall through to the default.
  }
  return SUPPORT_FALLBACK;
}

/** Portal URL for the email CTA — resolves from BOOKING_APP_URL only. */
function portalUrl(): string {
  const base = (process.env.BOOKING_APP_URL ?? '').replace(/\/$/, '');
  return base ? `${base}/portal` : 'https://app.storelah.sg/portal';
}

interface StripeEnrichment {
  cardLast4: string | null;
  receiptUrl: string | null;
}

/**
 * Best-effort Stripe enrichment for the receipt block: card last4 + hosted
 * receipt URL from the PaymentIntent. Any failure (unconfigured Stripe,
 * unknown intent, network) yields nulls — the email still sends.
 */
async function enrichFromStripe(paymentIntentId: string | null): Promise<StripeEnrichment> {
  const empty: StripeEnrichment = { cardLast4: null, receiptUrl: null };
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !paymentIntentId) return empty;
  try {
    const client = new Stripe(key);
    const pi = await client.paymentIntents.retrieve(paymentIntentId, {
      expand: ['payment_method', 'latest_charge'],
    });
    let cardLast4: string | null = null;
    const pm = pi.payment_method;
    if (pm && typeof pm !== 'string' && pm.type === 'card' && pm.card?.last4) {
      cardLast4 = pm.card.last4;
    }
    let receiptUrl: string | null = null;
    const charge = pi.latest_charge;
    if (charge && typeof charge !== 'string' && charge.receipt_url) {
      receiptUrl = charge.receipt_url;
    }
    return { cardLast4, receiptUrl };
  } catch {
    return empty;
  }
}

/**
 * Loads the confirmation data for a freshly-paid booking. Reads committed
 * post-webhook state (booking + tenant + unit/branch + the PAID invoice for
 * the session, falling back to the latest PAID invoice for the unit).
 * Returns null when the booking has no payer email (nothing to send to).
 */
export async function loadBookingConfirmationData(
  bookingId: string,
  opts?: { stripeSessionId?: string | null; paymentIntentId?: string | null },
): Promise<BookingConfirmationData | null> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      tenant: true,
      unit: { include: { branch: true } },
    },
  });
  if (!booking) return null;
  const toEmail = (booking.tenant.email ?? '').trim();
  if (!toEmail) return null;

  const paidInvoice = await prisma.invoice.findFirst({
    where: {
      tenantId: booking.tenantId,
      unitId: booking.unitId,
      status: 'PAID',
      ...(opts?.stripeSessionId ? { stripeSessionId: opts.stripeSessionId } : {}),
    },
    orderBy: { paidAt: 'desc' },
  });
  const fallbackInvoice =
    paidInvoice ??
    (await prisma.invoice.findFirst({
      where: { tenantId: booking.tenantId, unitId: booking.unitId, status: 'PAID' },
      orderBy: { paidAt: 'desc' },
    }));

  const amountPaidSgd = toNum(
    fallbackInvoice?.amountPaid ?? fallbackInvoice?.amount ?? booking.amountPaid ?? booking.amount,
  );
  const invoicePaidAt =
    fallbackInvoice?.paidAt ?? booking.paidAt ?? fallbackInvoice?.updatedAt ?? booking.updatedAt;

  const enrichment = await enrichFromStripe(opts?.paymentIntentId ?? booking.paymentIntentId ?? null);
  const supportContact = await resolveSupportContact();

  // Unit display name falls back to the immutable unitCode (see
  // docs/UNIT_CODE_AND_NAME.md).
  const rawName = booking.unit.name?.trim();
  const invoiceNo = fallbackInvoice?.invoiceNo ?? null;
  return {
    toEmail,
    customerName: booking.tenant.name?.trim() ? booking.tenant.name : null,
    bookingRef: booking.bookingRef,
    unitCode: booking.unit.unitCode,
    unitDisplayName: rawName ? rawName : booking.unit.unitCode,
    unitSqft: booking.unit.sqft ?? null,
    branchName: booking.unit.branch.name,
    branchAddress: booking.unit.branch.address?.trim() ? booking.unit.branch.address : null,
    moveInDate: booking.moveInDate,
    duration: booking.duration,
    amountPaidSgd,
    paymentMethod: fallbackInvoice?.method?.trim() ? fallbackInvoice.method! : 'Card',
    cardLast4: enrichment.cardLast4,
    paidAt: invoicePaidAt,
    invoiceNo,
    receiptUrl: enrichment.receiptUrl,
    portalUrl: portalUrl(),
    supportContact,
    // Deterministic receipt number from our own rows (see receiptPdf.ts).
    // `receiptAttached` is decided by the send path from the actual
    // attachment bytes; default true here so standalone renders preview
    // the attachment-primary layout.
    receiptNumber: deriveReceiptNumber(booking.bookingRef, invoiceNo, fallbackInvoice?.id ?? null),
    receiptAttached: true,
  };
}

export interface SendResult {
  sent: boolean;
  reason?: string;
}

export interface BookingEmailAttachment {
  filename: string;
  bytes: Buffer;
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function chunkBase64(b64: string): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join('\r\n');
}

function randomBoundary(prefix: string): string {
  const hex = Math.random().toString(16).slice(2) + Date.now().toString(16);
  return `${prefix}-${hex}`;
}

/**
 * Hand-built MIME multipart/mixed message (plain-text + HTML + optional PDF
 * attachment). No extra dependency — base64 parts keep the raw message
 * 7-bit safe for SendRawEmail. Pure function, safe to unit-test.
 */
export function buildRawMimeMessage(args: {
  fromName: string;
  fromEmail: string;
  to: string;
  built: BuiltBookingEmail;
  attachment: BookingEmailAttachment | null;
}): Buffer {
  const mixedBoundary = randomBoundary('storelah-mixed');
  const altBoundary = randomBoundary('storelah-alt');
  const lines: string[] = [
    `From: "${args.fromName.replace(/"/g, "'")}" <${args.fromEmail}>`,
    `To: ${args.to}`,
    `Subject: ${encodeHeader(args.built.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    '',
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: inline',
    '',
    chunkBase64(Buffer.from(args.built.text, 'utf8').toString('base64')),
    '',
    `--${altBoundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: inline',
    '',
    chunkBase64(Buffer.from(args.built.html, 'utf8').toString('base64')),
    '',
    `--${altBoundary}--`,
  ];
  if (args.attachment) {
    const safeName = args.attachment.filename.replace(/"/g, '');
    lines.push(
      '',
      `--${mixedBoundary}`,
      `Content-Type: application/pdf; name="${safeName}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${safeName}"`,
      '',
      chunkBase64(args.attachment.bytes.toString('base64')),
    );
  }
  lines.push('', `--${mixedBoundary}--`, '');
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

/**
 * Renders + sends the confirmation email with the StoreLah PDF receipt
 * attached (SendRawEmail, multipart/mixed). NEVER throws — every failure
 * mode (unconfigured, test env, no recipient, SES error) is logged and
 * returned as `{ sent: false }` so the payment path always succeeds.
 *
 * Attachment fallback: when `opts.pdfBytes` is absent/empty the email sends
 * without it (renderer shows the tiny Stripe fallback link instead). When
 * MIME assembly with the attachment fails, the send is retried once WITHOUT
 * the attachment + a log line — the customer still gets the confirmation
 * and (when available) the Stripe fallback proof.
 */
export async function sendBookingConfirmationEmail(
  data: BookingConfirmationData,
  opts?: { pdfBytes?: Buffer | null; pdfFilename?: string | null },
): Promise<SendResult> {
  if (process.env.NODE_ENV === 'test') {
    console.log(
      `[email] skip booking confirmation bookingRef=${data.bookingRef} (NODE_ENV=test, no send)`,
    );
    return { sent: false, reason: 'test-env' };
  }
  if (!isEmailConfigured()) {
    console.log(
      `[email] skip booking confirmation bookingRef=${data.bookingRef} (SES not configured)`,
    );
    return { sent: false, reason: 'not-configured' };
  }
  if (!data.toEmail) {
    console.log(
      `[email] skip booking confirmation bookingRef=${data.bookingRef} (no recipient email)`,
    );
    return { sent: false, reason: 'no-recipient' };
  }
  try {
    const from = fromSender();
    // The rendered layout always matches what is actually attached:
    // bytes present → attachment-primary; absent → Stripe fallback link.
    const pdfBytes = opts?.pdfBytes && opts.pdfBytes.length > 0 ? opts.pdfBytes : null;
    const attachment: BookingEmailAttachment | null = pdfBytes
      ? { filename: opts?.pdfFilename?.trim() || receiptFilename(data.bookingRef), bytes: pdfBytes }
      : null;
    let built = buildBookingConfirmationEmail({ ...data, receiptAttached: Boolean(attachment) });
    let raw: Buffer;
    try {
      raw = buildRawMimeMessage({
        fromName: from.name,
        fromEmail: from.email,
        to: data.toEmail,
        built,
        attachment,
      });
    } catch (mimeErr) {
      const message = mimeErr instanceof Error ? mimeErr.message : String(mimeErr);
      console.log(
        `[email] booking confirmation attachment build failed bookingRef=${data.bookingRef} (${message}) — sending without attachment`,
      );
      built = buildBookingConfirmationEmail({ ...data, receiptAttached: false });
      raw = buildRawMimeMessage({
        fromName: from.name,
        fromEmail: from.email,
        to: data.toEmail,
        built,
        attachment: null,
      });
    }
    // Default credential chain: Lambda execution role in prod, explicit
    // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars for local dev.
    // NOTE (owner): SendRawEmail needs ses:SendRawEmail on the sender
    // identity/role (ses:SendEmail optional / back-compat only).
    // Deliberate: no ConfigurationSetName is passed — the configuration set
    // is optional in SES and this product needs no event publishing. Do NOT
    // add one without also granting the execution role ses:SendRawEmail on
    // that configuration-set resource, or every send fails closed.
    const ses = new SESClient({ region: sesRegion() });
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: raw } }));
    // Log carries the booking ref + outcome only — never the recipient PII.
    console.log(
      `[email] booking confirmation sent bookingRef=${data.bookingRef}${attachment ? ' (receipt attached)' : ' (no attachment)'}`,
    );
    return { sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[email] booking confirmation failed bookingRef=${data.bookingRef}: ${message}`);
    if (/configuration-set/i.test(message)) {
      // No retry helps here: this send passes no ConfigurationSetName, so the
      // denied set is the sender identity's AWS-side DEFAULT configuration
      // set. Log the remediation (IAM grant or clear the default) — payment
      // is unaffected (best-effort email, `{ sent: false }` below).
      console.error(
        `[email] bookingRef=${data.bookingRef} SES denied access to an SES configuration set. ` +
          `Grant the execution role ses:SendRawEmail on that configuration-set resource, ` +
          `or clear the default configuration set on the SES sender identity.`,
      );
    }
    return { sent: false, reason: 'send-failed' };
  }
}

/**
 * Loads + generates the receipt PDF + sends the confirmation for a paid
 * booking. Best-effort wrapper for the webhook path — never throws. The PDF
 * is generated in-memory per send (never stored in the DB); when generation
 * fails the email still sends WITHOUT the attachment (Stripe fallback link
 * preserved) plus a log line.
 */
export async function sendBookingConfirmationForBooking(
  bookingId: string,
  opts?: { stripeSessionId?: string | null; paymentIntentId?: string | null },
): Promise<SendResult> {
  try {
    const data = await loadBookingConfirmationData(bookingId, opts);
    if (!data) return { sent: false, reason: 'no-recipient' };
    let pdfBytes: Buffer | null = null;
    try {
      pdfBytes = await buildReceiptPdfBytes(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[email] receipt PDF generation failed bookingRef=${data.bookingRef} (${message}) — sending without attachment`,
      );
      pdfBytes = null;
    }
    return await sendBookingConfirmationEmail(
      data,
      pdfBytes ? { pdfBytes, pdfFilename: receiptFilename(data.bookingRef) } : undefined,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[email] booking confirmation load/send failed bookingId=${bookingId}: ${message}`);
    return { sent: false, reason: 'send-failed' };
  }
}

// ---------------------------------------------------------------------------
// Quotation email (Customers → Quotes → New quotation).
//
// Sent best-effort from the POST /quotes path AFTER the quotation + PDF bytes
// commit (`finalizeQuotation` in core/quotes.ts). Same contract as the booking
// confirmation above: SES SendRawEmail multipart/mixed with the quotation PDF
// attached, NEVER throws — every failure mode is logged and returned as
// `{ sent: false, reason }` so quotation creation always succeeds.
// Guards (same order): NODE_ENV=test skip → SES unconfigured skip →
// no-recipient skip. Logs carry quoteNo/lead id only — never recipient PII.
// ---------------------------------------------------------------------------

export interface QuotationEmailData {
  toEmail: string;
  leadId: string;
  leadName: string | null;
  quoteNo: string;
  unitCode: string | null;
  branchName: string | null;
  monthlyRateSgd: number | null;
  totalDueTodaySgd: number | null;
  supportContact: string;
}

export interface BuiltQuotationEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Renders the quotation email (HTML + plain-text). Pure function — no I/O,
 * safe to call from preview scripts and tests.
 */
export function buildQuotationEmail(d: QuotationEmailData): BuiltQuotationEmail {
  const subject = `Your StoreLah quotation ${d.quoteNo}`;
  const greetingName = d.leadName?.trim() ? d.leadName.trim() : 'there';
  const e = {
    name: escapeHtml(greetingName),
    quoteNo: escapeHtml(d.quoteNo),
    unit: escapeHtml(d.unitCode?.trim() ? d.unitCode.trim() : 'To be confirmed at viewing'),
    branch: escapeHtml(d.branchName?.trim() ? d.branchName.trim() : 'To be confirmed'),
    rate: escapeHtml(d.monthlyRateSgd != null ? formatSgd(d.monthlyRateSgd) : 'To be confirmed'),
    total: escapeHtml(d.totalDueTodaySgd != null ? formatSgd(d.totalDueTodaySgd) : 'To be confirmed'),
    support: escapeHtml(d.supportContact),
  };
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:${C.cream};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${C.cream};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background-color:${C.white};border:1px solid ${C.border};border-radius:12px;overflow:hidden;">
        <tr>
          <td style="background-color:${C.terra};padding:28px 32px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:${C.white};">StoreLah</div>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.terraLight};padding-top:4px;">Self-storage, sorted.</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 8px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${C.oliveLight};border-radius:8px;">
              <tr><td style="padding:14px 18px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:${C.olive};">Your quotation is ready — ${e.quoteNo}</td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:${C.charcoal};">
            Hi ${e.name},
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:${C.charcoal};">
            Thank you for your enquiry — please find your storage quotation attached (PDF). A summary is below.
          </td>
        </tr>
        <tr><td style="padding:8px 32px 0 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ${C.border};border-radius:8px;">
            <tr><td style="padding:14px 18px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Quotation no.</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:${C.charcoal};">${e.quoteNo}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Unit</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.charcoal};">${e.unit}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Facility</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.charcoal};">${e.branch}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Monthly rate</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.charcoal};">${e.rate}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C.muted};">Total due today</td>
                  <td align="right" style="padding:8px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:${C.charcoal};">${e.total}</td>
                </tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:12px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:${C.green};">&#10003;&nbsp; Your quotation is attached (PDF) — look for the attachment on this email.</td></tr>
        <tr>
          <td style="padding:20px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:${C.muted};">
            Questions? Reply to this email or contact us at ${e.support} — quote ${e.quoteNo} so we can help faster.
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 28px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${C.muted};border-top:1px solid ${C.border};">
            <div style="padding-top:16px;">StoreLah · Self-storage, sorted.<br>This quotation is an estimate only and is valid subject to unit availability.</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  const textLines = [
    `StoreLah — Your quotation ${d.quoteNo}`,
    ``,
    `Hi ${greetingName},`,
    ``,
    `Thank you for your enquiry — your storage quotation is attached (PDF). Summary:`,
    `  Quotation no. : ${d.quoteNo}`,
    `  Unit          : ${d.unitCode?.trim() ? d.unitCode.trim() : 'To be confirmed at viewing'}`,
    `  Facility      : ${d.branchName?.trim() ? d.branchName.trim() : 'To be confirmed'}`,
    `  Monthly rate  : ${d.monthlyRateSgd != null ? formatSgd(d.monthlyRateSgd) : 'To be confirmed'}`,
    `  Total due today: ${d.totalDueTodaySgd != null ? formatSgd(d.totalDueTodaySgd) : 'To be confirmed'}`,
    ``,
    `Questions? Contact us at ${d.supportContact} and quote ${d.quoteNo}.`,
    ``,
    `StoreLah · Self-storage, sorted. This quotation is an estimate only and is valid subject to unit availability.`,
  ];
  return { subject, html, text: textLines.join('\n') };
}

/**
 * Renders + sends the quotation email with the quotation PDF attached
 * (SendRawEmail, multipart/mixed). NEVER throws — every failure mode
 * (unconfigured, test env, no recipient, SES error) is logged and returned
 * as `{ sent: false, reason }` so quotation creation always succeeds.
 * No attachment-fallback retry: without the PDF there is no quotation to
 * send, so a MIME failure is a FAILED send (the PDF stays downloadable in
 * the CMS regardless).
 */
export async function sendQuotationEmail(
  data: QuotationEmailData,
  opts: { pdfBytes: Buffer; pdfFilename?: string | null },
): Promise<SendResult> {
  if (process.env.NODE_ENV === 'test') {
    console.log(`[email] skip quotation quoteNo=${data.quoteNo} (NODE_ENV=test, no send)`);
    return { sent: false, reason: 'test-env' };
  }
  if (!isEmailConfigured()) {
    console.log(`[email] skip quotation quoteNo=${data.quoteNo} (SES not configured)`);
    return { sent: false, reason: 'not-configured' };
  }
  if (!data.toEmail) {
    console.log(`[email] skip quotation quoteNo=${data.quoteNo} (no recipient email)`);
    return { sent: false, reason: 'no-recipient' };
  }
  try {
    const from = fromSender();
    const attachment: BookingEmailAttachment = {
      filename: opts?.pdfFilename?.trim() || quotationFilename(data.quoteNo),
      bytes: opts.pdfBytes,
    };
    const built = buildQuotationEmail(data);
    const raw = buildRawMimeMessage({
      fromName: from.name,
      fromEmail: from.email,
      to: data.toEmail,
      built,
      attachment,
    });
    const ses = new SESClient({ region: sesRegion() });
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: raw } }));
    // Log carries the quote number only — never the recipient PII.
    console.log(`[email] quotation sent quoteNo=${data.quoteNo} (quotation attached)`);
    return { sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[email] quotation failed quoteNo=${data.quoteNo}: ${message}`);
    return { sent: false, reason: 'send-failed' };
  }
}

// StoreLah PDF receipt — server-generated, attached to the booking/payment
// confirmation email (see src/core/emails.ts).
//
// Lambda-safe: built on pdf-lib (pure JS, no native binaries, no Chromium).
// Generated in-memory per send; PDFs are NOT stored in the DB (no migration).
//
// RECEIPT-NUMBER SCHEME (deterministic, derived from our own rows):
//   R-<bookingRef>-<invoice suffix>
// where <invoice suffix> is the last dash-separated segment of the invoiceNo
// (e.g. booking SL-2026-0912 + invoice INV-2026-0847 → R-SL-2026-0912-0847).
// Fallbacks: first 6 alphanumeric chars of the invoice id (uppercased) when
// there is no invoiceNo, else "0000" (e.g. R-SL-2026-0912-0000).
//
// LINE ITEMS: the Invoice row stores a single invoiced total (no per-line
// breakdown is persisted — proration / protection / addon / discount splits
// live only in the transient booking-creation quote, not on the invoice).
// The PDF therefore lists ONE charge line for the invoiced total "as the
// invoice stores it", plus explicit GST 0% / S$0.00 rows matching the current
// GST-0 convention. If per-line persistence is added later, expand
// `receiptLinesFromConfirmation` to emit those rows.
//
// COMPANY PLACEHOLDERS: UEN / registered address / logo are NOT known to this
// repo — the footer carries clearly-marked "____" placeholders. The owner
// must supply real details before launch. Never invent a real-looking UEN.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { BookingConfirmationData } from './emails';

/** Local SGD formatter (mirrors formatSgd in core/emails.ts — kept local so this
 *  module has no runtime import cycle with emails.ts). */
function formatSgd(amount: number): string {
  return new Intl.NumberFormat('en-SG', {
    style: 'currency',
    currency: 'SGD',
    minimumFractionDigits: 2,
  }).format(amount);
}

export interface ReceiptLineItem {
  description: string;
  amount: number;
}

/**
 * Deterministic receipt number from our own booking + invoice rows.
 * See the scheme documented at the top of this file.
 */
export function deriveReceiptNumber(
  bookingRef: string,
  invoiceNo: string | null,
  invoiceId?: string | null,
): string {
  const ref = (bookingRef ?? '').trim() || 'UNKNOWN';
  let suffix = '0000';
  const no = (invoiceNo ?? '').trim();
  if (no) {
    const segments = no.split('-').map((s) => s.trim()).filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    if (last) suffix = last.toUpperCase().slice(0, 12);
  } else if (invoiceId?.trim()) {
    const compact = invoiceId.trim().replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
    if (compact) suffix = compact;
  }
  return `R-${ref}-${suffix}`;
}

/** Attachment filename for the receipt PDF (sanitised booking ref). */
export function receiptFilename(bookingRef: string): string {
  const safe = (bookingRef ?? '').trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-');
  return `StoreLah-receipt-${safe || 'booking'}.pdf`;
}

/**
 * Charge lines "as the invoice stores them": the invoice persists a single
 * total, so this is one line covering storage + protection + addons for the
 * move-in billing period. GST stays 0 (current convention — do not invent).
 */
export function receiptLinesFromConfirmation(d: BookingConfirmationData): ReceiptLineItem[] {
  const unitBit = d.unitSqft ? `${d.unitDisplayName} (${d.unitSqft} sqft)` : d.unitDisplayName;
  return [
    {
      description: `Storage — ${unitBit}, ${d.branchName} — ${d.duration} from ${formatDay(d.moveInDate)}`,
      amount: d.amountPaidSgd,
    },
  ];
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
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d) +
    ', ' +
    new Intl.DateTimeFormat('en-SG', { hour: 'numeric', minute: '2-digit', hour12: true }).format(d)
  );
}

const INK = rgb(0.157, 0.169, 0.153); // #282B27 charcoal
const MUTED = rgb(0.455, 0.435, 0.4); // #746F66 muted
const TERRA = rgb(0.741, 0.42, 0.314); // #BD6B50 terra
const LINE = rgb(0.882, 0.847, 0.796); // #E1D8CB border

interface Cursor {
  y: number;
}

function drawText(
  page: PDFPage,
  font: PDFFont,
  opts: { text: string; x: number; y: number; size?: number; color?: ReturnType<typeof rgb> },
): void {
  page.drawText(opts.text, {
    x: opts.x,
    y: opts.y,
    size: opts.size ?? 11,
    font,
    color: opts.color ?? INK,
  });
}

function ascii(s: string): string {
  // pdf-lib standard fonts are WinAnsi — replace common non-WinAnsi chars so
  // PDF generation never throws on em dashes / bullets from our copy.
  return s
    .replace(/[—–]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/•/g, '-')
    .replace(/✓|✔|☑|☐/g, 'v')
    .replace(/[^\x20-\x7E\n]/g, '?');
}

/**
 * Builds the receipt PDF bytes from OUR invoice/booking data (carried in the
 * confirmation payload — no Stripe fields except the payment method label).
 * Throws on pdf-lib failure; callers treat that as "send without attachment".
 */
export async function buildReceiptPdfBytes(d: BookingConfirmationData): Promise<Buffer> {
  const receiptNo = d.receiptNumber?.trim() || deriveReceiptNumber(d.bookingRef, d.invoiceNo ?? null);
  const lines = receiptLinesFromConfirmation(d);
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const gst = 0;
  const total = subtotal + gst;
  const methodLine = d.cardLast4 ? `${d.paymentMethod} ending ${d.cardLast4}` : d.paymentMethod;
  const billedName = d.customerName?.trim() ? d.customerName.trim() : 'Customer';
  const unitBit = d.unitSqft ? `${d.unitDisplayName} (${d.unitSqft} sqft)` : d.unitDisplayName;

  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4 portrait in points
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595;
  const M = 48; // margin
  const cur: Cursor = { y: 800 };

  // Header band
  page.drawRectangle({ x: 0, y: 742, width: W, height: 100, color: TERRA });
  drawText(page, bold, { text: ascii('StoreLah'), x: M, y: 800, size: 22, color: rgb(1, 1, 1) });
  drawText(page, regular, { text: ascii('Self-storage, sorted.'), x: M, y: 782, size: 11, color: rgb(1, 1, 1) });
  drawText(page, bold, { text: ascii('PAYMENT RECEIPT'), x: M, y: 758, size: 11, color: rgb(1, 1, 1) });
  cur.y = 716;

  const row = (label: string, value: string, opts?: { gap?: number }) => {
    drawText(page, regular, { text: ascii(label), x: M, y: cur.y, size: 10, color: MUTED });
    const v = ascii(value);
    const w = regular.widthOfTextAtSize(v, 10);
    drawText(page, regular, { text: v, x: W - M - w, y: cur.y, size: 10 });
    cur.y -= opts?.gap ?? 18;
  };

  drawText(page, bold, { text: ascii('Receipt'), x: M, y: cur.y, size: 14 });
  cur.y -= 22;
  row('Receipt no.', receiptNo);
  row('Booking ref', d.bookingRef);
  if (d.invoiceNo?.trim()) row('Invoice no.', d.invoiceNo.trim());
  row('Paid on', formatDateTime(d.paidAt));
  cur.y -= 6;

  // Billed-to
  page.drawLine({ start: { x: M, y: cur.y }, end: { x: W - M, y: cur.y }, color: LINE, thickness: 1 });
  cur.y -= 18;
  drawText(page, bold, { text: ascii('Billed to'), x: M, y: cur.y, size: 12 });
  cur.y -= 18;
  drawText(page, regular, { text: ascii(billedName), x: M, y: cur.y, size: 11 });
  cur.y -= 16;
  drawText(page, regular, { text: ascii(d.toEmail), x: M, y: cur.y, size: 11 });
  cur.y -= 16;
  drawText(page, regular, {
    text: ascii(`Unit ${d.unitCode} — ${unitBit}, ${d.branchName}`),
    x: M,
    y: cur.y,
    size: 10,
    color: MUTED,
  });
  cur.y -= 16;
  drawText(page, regular, {
    text: ascii(`Move-in date: ${formatDay(d.moveInDate)}  |  Duration: ${d.duration}`),
    x: M,
    y: cur.y,
    size: 10,
    color: MUTED,
  });
  cur.y -= 24;

  // Line items
  drawText(page, bold, { text: ascii('Charges'), x: M, y: cur.y, size: 12 });
  cur.y -= 20;
  page.drawLine({ start: { x: M, y: cur.y }, end: { x: W - M, y: cur.y }, color: LINE, thickness: 1 });
  cur.y -= 16;
  for (const l of lines) {
    drawText(page, regular, { text: ascii(l.description), x: M, y: cur.y, size: 10 });
    const amt = ascii(formatSgd(l.amount));
    const w = regular.widthOfTextAtSize(amt, 10);
    drawText(page, regular, { text: amt, x: W - M - w, y: cur.y, size: 10 });
    cur.y -= 18;
  }
  page.drawLine({ start: { x: M, y: cur.y + 6 }, end: { x: W - M, y: cur.y + 6 }, color: LINE, thickness: 1 });
  cur.y -= 4;
  row('Subtotal', formatSgd(subtotal));
  row('GST (0%)', formatSgd(gst));
  const totalStr = ascii(formatSgd(total));
  drawText(page, bold, { text: ascii('Total paid'), x: M, y: cur.y, size: 12 });
  const tw = bold.widthOfTextAtSize(totalStr, 12);
  drawText(page, bold, { text: totalStr, x: W - M - tw, y: cur.y, size: 12 });
  cur.y -= 26;

  // Payment method block
  page.drawLine({ start: { x: M, y: cur.y }, end: { x: W - M, y: cur.y }, color: LINE, thickness: 1 });
  cur.y -= 18;
  row('Amount paid', formatSgd(d.amountPaidSgd));
  row('Payment method', methodLine);
  row('Paid on', formatDateTime(d.paidAt));
  cur.y -= 6;

  // Footer — company details are placeholders until the owner supplies them.
  page.drawLine({ start: { x: M, y: cur.y }, end: { x: W - M, y: cur.y }, color: LINE, thickness: 1 });
  cur.y -= 18;
  drawText(page, regular, {
    text: ascii('StoreLah Pte. Ltd.  |  UEN: ____ (to be confirmed by owner)'),
    x: M,
    y: cur.y,
    size: 9,
    color: MUTED,
  });
  cur.y -= 14;
  drawText(page, regular, {
    text: ascii('Registered address: ____ (to be confirmed by owner)'),
    x: M,
    y: cur.y,
    size: 9,
    color: MUTED,
  });
  cur.y -= 14;
  drawText(page, regular, {
    text: ascii(`Questions? Contact ${d.supportContact} and quote booking ${d.bookingRef}.`),
    x: M,
    y: cur.y,
    size: 9,
    color: MUTED,
  });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

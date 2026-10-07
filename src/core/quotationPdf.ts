// StoreLah quotation PDF — server-generated, attached to the quotation email
// and persisted on the Quotation row (see src/core/quotes.ts).
//
// Lambda-safe: built on pdf-lib (pure JS, no native binaries, no Chromium).
// Generated in-memory per quotation; the bytes ARE stored in the DB (the
// Quotation.pdf column) so the CMS download serves the exact saved bytes.
//
// QUOTATION-NUMBER SCHEME (deterministic, derived from our own rows):
//   Q-<leadShortId>-<yyyymmdd>-<seq>
// where <leadShortId> is the first 6 alphanumeric chars of the lead id
// (uppercased), <yyyymmdd> is the issue date (UTC), and <seq> is the
// 2-digit 1-based count of quotations already on file for that lead + 1
// (e.g. lead cm1234abcd issued 7 Oct 2026, first quotation →
// Q-CM1234-20261007-01). quoteNo has a UNIQUE constraint so a same-day
// double-submit retries with the next seq (see nextQuoteSeq in quotes.ts).
//
// COMPANY PLACEHOLDERS: UEN / registered address / logo are NOT known to this
// repo — the footer carries clearly-marked "____" placeholders. The owner
// must supply real details before launch. Never invent a real-looking UEN.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

function formatSgd(amount: number): string {
  return new Intl.NumberFormat('en-SG', {
    style: 'currency',
    currency: 'SGD',
    minimumFractionDigits: 2,
  }).format(amount);
}

export interface QuotationAddonLine {
  name: string;
  qty: number;
  price: number;
}

export interface QuotationPdfData {
  quoteNo: string;
  issuedAt: Date;
  // Lead information.
  leadName: string;
  leadEmail: string | null;
  leadMobile: string | null;
  leadType: string | null;
  // Unit information.
  unitCode: string | null;
  unitDisplayName: string | null;
  unitSqft: number | null;
  branchName: string | null;
  branchAddress: string | null;
  preferredSize: string | null;
  monthlyRate: number | null;
  durationMonths: number | null;
  moveInDate: Date | null;
  // Payment information.
  protectionTier: string | null;
  protectionCost: number | null;
  addons: QuotationAddonLine[];
  promoCode: string | null;
  promoDiscountAmt: number | null;
  movingService: boolean | null;
  totalDueToday: number | null;
  note: string | null;
  owner: string | null;
  // StoreLah contacts.
  supportContact: string;
}

/**
 * Deterministic quotation number from our own lead row + issue date + seq.
 * See the scheme documented at the top of this file.
 */
export function deriveQuoteNo(leadId: string, issuedAt: Date, seq: number): string {
  const short = (leadId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'LEAD';
  const d = issuedAt instanceof Date && !Number.isNaN(issuedAt.getTime()) ? issuedAt : new Date();
  const yyyymmdd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const seqBit = String(Math.max(1, Math.floor(seq))).padStart(2, '0');
  return `Q-${short}-${yyyymmdd}-${seqBit}`;
}

/** Attachment filename for the quotation PDF (sanitised quote number). */
export function quotationFilename(quoteNo: string): string {
  const safe = (quoteNo ?? '').trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-');
  return `StoreLah-quotation-${safe || 'quote'}.pdf`;
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

function money(n: number | null): string {
  return n == null ? 'To be confirmed' : formatSgd(n);
}

/**
 * Builds the quotation PDF bytes from OUR lead/unit data (carried in the
 * payload — no external fields). Covers lead information, unit information,
 * payment information and StoreLah contacts. Throws on pdf-lib failure;
 * callers treat that as "quotation created without a PDF" (best-effort).
 */
export async function buildQuotationPdfBytes(d: QuotationPdfData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  let page = doc.addPage([595, 842]); // A4 portrait in points
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595;
  const M = 48; // margin
  const cur: Cursor = { y: 800 };

  const need = (n: number): void => {
    if (cur.y - n < 70) {
      page = doc.addPage([595, 842]);
      cur.y = 800;
    }
  };

  // Header band
  page.drawRectangle({ x: 0, y: 742, width: W, height: 100, color: TERRA });
  drawText(page, bold, { text: ascii('StoreLah'), x: M, y: 800, size: 22, color: rgb(1, 1, 1) });
  drawText(page, regular, { text: ascii('Self-storage, sorted.'), x: M, y: 782, size: 11, color: rgb(1, 1, 1) });
  drawText(page, bold, { text: ascii('STORAGE QUOTATION'), x: M, y: 758, size: 11, color: rgb(1, 1, 1) });
  cur.y = 716;

  const row = (label: string, value: string, opts?: { gap?: number }) => {
    need(24);
    drawText(page, regular, { text: ascii(label), x: M, y: cur.y, size: 10, color: MUTED });
    const v = ascii(value);
    const w = regular.widthOfTextAtSize(v, 10);
    drawText(page, regular, { text: v, x: Math.max(M + 170, W - M - w), y: cur.y, size: 10 });
    cur.y -= opts?.gap ?? 18;
  };

  const section = (title: string) => {
    need(60);
    page.drawLine({ start: { x: M, y: cur.y }, end: { x: W - M, y: cur.y }, color: LINE, thickness: 1 });
    cur.y -= 18;
    drawText(page, bold, { text: ascii(title), x: M, y: cur.y, size: 12 });
    cur.y -= 20;
  };

  drawText(page, bold, { text: ascii('Quotation'), x: M, y: cur.y, size: 14 });
  cur.y -= 22;
  row('Quotation no.', d.quoteNo);
  row('Issued', formatDateTime(d.issuedAt));
  if (d.owner?.trim()) row('Prepared by', d.owner.trim());
  cur.y -= 6;

  // Lead information
  section('Lead information');
  row('Name', d.leadName?.trim() ? d.leadName.trim() : 'Customer');
  if (d.leadType?.trim()) row('Account type', d.leadType.trim());
  row('Email', d.leadEmail?.trim() ? d.leadEmail.trim() : '—');
  row('Mobile', d.leadMobile?.trim() ? d.leadMobile.trim() : '—');
  cur.y -= 6;

  // Unit information
  section('Unit information');
  row('Facility', d.branchName?.trim() ? d.branchName.trim() : 'To be confirmed');
  if (d.branchAddress?.trim()) row('Facility address', d.branchAddress.trim());
  if (d.preferredSize?.trim()) row('Preferred size', d.preferredSize.trim());
  if (d.unitCode?.trim()) {
    const unitBit =
      d.unitDisplayName?.trim() && d.unitDisplayName.trim() !== d.unitCode.trim()
        ? `${d.unitCode.trim()} (${d.unitDisplayName.trim()})`
        : d.unitCode.trim();
    row('Unit', d.unitSqft ? `${unitBit} - ${d.unitSqft} sqft` : unitBit);
  } else {
    row('Unit', 'To be confirmed at viewing');
  }
  row('Monthly rate', money(d.monthlyRate));
  if (d.durationMonths) row('Duration', `${d.durationMonths} month(s)`);
  if (d.moveInDate) row('Move-in date', formatDay(d.moveInDate));
  cur.y -= 6;

  // Payment information
  section('Payment information');
  row('Monthly rate', money(d.monthlyRate));
  if (d.protectionTier?.trim()) {
    row(
      'Protection plan',
      d.protectionCost != null
        ? `${d.protectionTier.trim()} (${formatSgd(d.protectionCost)}/mo)`
        : d.protectionTier.trim(),
    );
  }
  for (const a of d.addons ?? []) {
    const line = `${a.name} x ${a.qty}`;
    const amt = formatSgd(a.price * a.qty);
    need(24);
    drawText(page, regular, { text: ascii(line), x: M, y: cur.y, size: 10 });
    const w = regular.widthOfTextAtSize(ascii(amt), 10);
    drawText(page, regular, { text: ascii(amt), x: W - M - w, y: cur.y, size: 10 });
    cur.y -= 18;
  }
  if (d.promoCode?.trim()) {
    row(
      'Promotion',
      d.promoDiscountAmt != null ? `${d.promoCode.trim()} (-${formatSgd(d.promoDiscountAmt)})` : d.promoCode.trim(),
    );
  }
  if (d.movingService) row('Moving service', 'Requested (charged separately)');
  cur.y -= 2;
  page.drawLine({ start: { x: M, y: cur.y + 6 }, end: { x: W - M, y: cur.y + 6 }, color: LINE, thickness: 1 });
  cur.y -= 4;
  const totalStr = ascii(d.totalDueToday != null ? formatSgd(d.totalDueToday) : 'To be confirmed');
  drawText(page, bold, { text: ascii('Total due today'), x: M, y: cur.y, size: 12 });
  const tw = bold.widthOfTextAtSize(totalStr, 12);
  drawText(page, bold, { text: totalStr, x: W - M - tw, y: cur.y, size: 12 });
  cur.y -= 26;

  if (d.note?.trim()) {
    section('Note');
    need(24);
    drawText(page, regular, { text: ascii(d.note.trim().slice(0, 500)), x: M, y: cur.y, size: 10, color: MUTED });
    cur.y -= 20;
  }

  // Footer — company details are placeholders until the owner supplies them.
  need(70);
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
    text: ascii(`Questions? Contact ${d.supportContact} and quote ${d.quoteNo}.`),
    x: M,
    y: cur.y,
    size: 9,
    color: MUTED,
  });
  cur.y -= 14;
  drawText(page, regular, {
    text: ascii('This quotation is an estimate only and is valid subject to unit availability.'),
    x: M,
    y: cur.y,
    size: 9,
    color: MUTED,
  });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

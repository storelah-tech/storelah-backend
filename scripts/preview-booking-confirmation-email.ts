// Preview renderer for the booking + payment confirmation email.
// Builds representative sample payloads, renders the HTML + plain-text via
// the pure `buildBookingConfirmationEmail` (src/core/emails.ts), generates a
// fixture StoreLah PDF receipt via `buildReceiptPdfBytes`
// (src/core/receiptPdf.ts), and writes all outputs to the OS temp dir.
// NEVER sends — no SES call, no DB, no Stripe. Fixture data only (fake).
// Run: `pnpm tsx scripts/preview-booking-confirmation-email.ts`.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildBookingConfirmationEmail, type BookingConfirmationData } from '../src/core/emails';
import { buildReceiptPdfBytes, deriveReceiptNumber } from '../src/core/receiptPdf';

function fixture(overrides?: Partial<BookingConfirmationData>): BookingConfirmationData {
  const bookingRef = 'SL-2026-0912';
  const invoiceNo = 'INV-2026-0847';
  return {
    toEmail: 'preview@example.com',
    customerName: 'Alex Tan',
    bookingRef,
    unitCode: '1001',
    unitDisplayName: '1001',
    unitSqft: 120,
    branchName: 'Bukit Merah',
    branchAddress: '123 Bukit Merah Lane 1, Singapore 150123',
    moveInDate: new Date('2026-10-15T00:00:00+08:00'),
    duration: '3 months',
    amountPaidSgd: 486.2,
    paymentMethod: 'Card',
    cardLast4: '4242',
    paidAt: new Date('2026-10-02T09:30:00+08:00'),
    invoiceNo,
    receiptUrl: 'https://pay.stripe.com/receipts/preview-demo',
    portalUrl: 'http://localhost:3001/portal',
    supportContact: 'ops@storelah.sg',
    receiptNumber: deriveReceiptNumber(bookingRef, invoiceNo),
    receiptAttached: true,
    ...overrides,
  };
}

async function main(): Promise<void> {
  // 1. Attachment-primary layout (the live path: PDF attached).
  const attached = buildBookingConfirmationEmail(fixture({ receiptAttached: true }));
  const attachedOut = join(tmpdir(), 'storelah-booking-confirmation-preview.html');
  writeFileSync(attachedOut, attached.html, 'utf8');

  // 2. Fallback layout (PDF generation failed → tiny Stripe link preserved).
  const fallback = buildBookingConfirmationEmail(
    fixture({ receiptAttached: false, receiptNumber: null }),
  );
  const fallbackOut = join(tmpdir(), 'storelah-booking-confirmation-preview-fallback.html');
  writeFileSync(fallbackOut, fallback.html, 'utf8');

  // 3. Fixture PDF receipt (fake data) + parse check (page count, bytes).
  const pdf = await buildReceiptPdfBytes(fixture({ receiptAttached: true }));
  const pdfOut = join(tmpdir(), 'storelah-receipt-preview.pdf');
  writeFileSync(pdfOut, pdf);
  const parsed = await PDFDocument.load(pdf);
  const pages = parsed.getPageCount();

  console.log(`subject: ${attached.subject}`);
  console.log(`attached html bytes: ${attached.html.length}, text bytes: ${attached.text.length}`);
  console.log(`attached html written to: ${attachedOut}`);
  console.log(`fallback html bytes: ${fallback.html.length}, written to: ${fallbackOut}`);
  console.log(`fixture pdf bytes: ${pdf.length}, pages: ${pages}, written to: ${pdfOut}`);
  console.log(`attached layout has PDF note: ${attached.html.includes('Your receipt is attached (PDF)')}`);
  console.log(`attached layout has no View-receipt CTA: ${!attached.html.includes('View receipt')}`);
  console.log(
    `fallback layout keeps Stripe link: ${fallback.html.includes('View Stripe receipt') && !fallback.html.includes('Your receipt is attached (PDF)')}`,
  );
  console.log('--- text fallback (attached) ---');
  console.log(attached.text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

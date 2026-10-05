// Preview renderer for the booking + payment confirmation email.
// Builds a representative sample payload, renders the HTML + plain-text via
// the pure `buildBookingConfirmationEmail` (src/core/emails.ts) and writes
// the HTML to the OS temp dir. NEVER sends — no SES call, no DB, no
// Stripe. Run: `pnpm tsx scripts/preview-booking-confirmation-email.ts`.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBookingConfirmationEmail } from '../src/core/emails';

const built = buildBookingConfirmationEmail({
  toEmail: 'preview@example.com',
  customerName: 'Alex Tan',
  bookingRef: 'SL-2026-0912',
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
  invoiceNo: 'INV-2026-0847',
  receiptUrl: 'https://pay.stripe.com/receipts/preview-demo',
  portalUrl: 'http://localhost:3001/portal',
  supportContact: 'ops@storelah.sg',
});

const out = join(tmpdir(), 'storelah-booking-confirmation-preview.html');
writeFileSync(out, built.html, 'utf8');

console.log(`subject: ${built.subject}`);
console.log(`html bytes: ${built.html.length}, text bytes: ${built.text.length}`);
console.log(`html written to: ${out}`);
console.log('--- text fallback ---');
console.log(built.text);

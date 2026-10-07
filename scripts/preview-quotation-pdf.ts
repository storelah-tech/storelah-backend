// Preview renderer for the quotation PDF + quotation email.
// Builds a representative sample payload, generates the StoreLah quotation
// PDF via `buildQuotationPdfBytes` (src/core/quotationPdf.ts), renders the
// quotation email via the pure `buildQuotationEmail` (src/core/emails.ts),
// and writes all outputs to the OS temp dir.
// NEVER sends — no SES call, no DB. Fixture data only (fake).
// Run: `pnpm tsx scripts/preview-quotation-pdf.ts`.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildQuotationEmail, type QuotationEmailData } from '../src/core/emails';
import {
  buildQuotationPdfBytes,
  deriveQuoteNo,
  quotationFilename,
  type QuotationPdfData,
} from '../src/core/quotationPdf';

function fixturePdf(quoteNo: string): QuotationPdfData {
  return {
    quoteNo,
    issuedAt: new Date('2026-10-07T09:30:00+08:00'),
    leadName: 'Alex Tan',
    leadEmail: 'preview@example.com',
    leadMobile: '+65 9123 4567',
    leadType: 'PERSONAL',
    unitCode: '1001',
    unitDisplayName: '1001',
    unitSqft: 120,
    branchName: 'Bukit Merah',
    branchAddress: '123 Bukit Merah Lane 1, Singapore 150123',
    preferredSize: 'MEDIUM',
    monthlyRate: 280,
    durationMonths: 3,
    moveInDate: new Date('2026-10-15T00:00:00+08:00'),
    protectionTier: 'standard',
    protectionCost: 12,
    addons: [{ name: 'Medium Box', qty: 2, price: 3.5 }],
    promoCode: 'STORELAH10',
    promoDiscountAmt: 28,
    movingService: false,
    totalDueToday: 848,
    note: 'Corner unit preferred; call before viewing.',
    owner: 'Preview Operator',
    supportContact: 'ops@storelah.sg',
  };
}

function fixtureEmail(quoteNo: string): QuotationEmailData {
  return {
    toEmail: 'preview@example.com',
    leadId: 'cm1234abcd',
    leadName: 'Alex Tan',
    quoteNo,
    unitCode: '1001',
    branchName: 'Bukit Merah',
    monthlyRateSgd: 280,
    totalDueTodaySgd: 848,
    supportContact: 'ops@storelah.sg',
  };
}

async function main(): Promise<void> {
  const quoteNo = deriveQuoteNo('cm1234abcd', new Date('2026-10-07T09:30:00+08:00'), 1);

  // 1. Fixture quotation PDF (fake data) + parse check (page count, bytes).
  const pdf = await buildQuotationPdfBytes(fixturePdf(quoteNo));
  const pdfOut = join(tmpdir(), 'storelah-quotation-preview.pdf');
  writeFileSync(pdfOut, pdf);
  const parsed = await PDFDocument.load(pdf);

  // 2. Quotation email render (attachment-primary layout).
  const email = buildQuotationEmail(fixtureEmail(quoteNo));
  const emailOut = join(tmpdir(), 'storelah-quotation-email-preview.html');
  writeFileSync(emailOut, email.html, 'utf8');

  console.log(`quoteNo: ${quoteNo}`);
  console.log(`filename: ${quotationFilename(quoteNo)}`);
  console.log(`fixture pdf bytes: ${pdf.length}, pages: ${parsed.getPageCount()}, written to: ${pdfOut}`);
  console.log(`email subject: ${email.subject}`);
  console.log(`email html bytes: ${email.html.length}, written to: ${emailOut}`);
  console.log(`email has attachment note: ${email.html.includes('Your quotation is attached (PDF)')}`);
  console.log('--- text fallback ---');
  console.log(email.text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

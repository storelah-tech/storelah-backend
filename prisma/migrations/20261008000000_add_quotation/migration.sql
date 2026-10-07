-- Operator-issued quotation PDFs (Customers → Quotes upgrade).
-- Additive only: brand-new Quotation table, no changes to existing tables.
-- pdf holds the exact PDF bytes served by GET /quotes/:id/pdf (bytea — no
-- filesystem, no new infra); emailStatus/emailReason record the honest outcome
-- of the best-effort post-create email (SENT | SKIPPED | FAILED + reason).
CREATE TABLE "Quotation" (
    "id" TEXT NOT NULL,
    "quoteNo" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "unitCode" TEXT,
    "monthlyRate" DECIMAL(10,2),
    "totalDueToday" DECIMAL(10,2),
    "pdf" BYTEA NOT NULL,
    "pdfFilename" TEXT,
    "createdBy" TEXT,
    "emailStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "emailReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quotation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Quotation_quoteNo_key" ON "Quotation"("quoteNo");

CREATE INDEX "Quotation_leadId_idx" ON "Quotation"("leadId");

ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Finance module Phase 3 — Billing and payments (FINANCE_MODULE_SPEC §§6/10/17/21).
--
-- Additive only: no drops, no renames, no Tenant billing columns (deferred),
-- no StorageAgreement (deferred), no late-fee posting (Phase 4). Existing
-- Invoice rows keep DRAFT-free values (DUE/OVERDUE/PAID); the portal keeps
-- seeing only DUE/OVERDUE/PAID via toCustomerInvoice().
--
-- Enum widening WITHOUT `ALTER TYPE ... ADD VALUE` (which Postgres forbids
-- inside a transaction block, and Prisma migrate wraps in one): create the
-- widened type, swap the column, drop the old type. No row is touched.

CREATE TYPE "InvoiceStatus_new" AS ENUM ('PAID', 'DUE', 'OVERDUE', 'DRAFT', 'APPROVED', 'ISSUED', 'PARTIALLY_PAID', 'VOID', 'WRITTEN_OFF');
ALTER TABLE "Invoice" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Invoice" ALTER COLUMN "status" TYPE "InvoiceStatus_new" USING "status"::text::"InvoiceStatus_new";
ALTER TABLE "Invoice" ALTER COLUMN "status" SET DEFAULT 'DUE';
ALTER TYPE "InvoiceStatus" RENAME TO "InvoiceStatus_old";
ALTER TYPE "InvoiceStatus_new" RENAME TO "InvoiceStatus";
DROP TYPE "InvoiceStatus_old";

-- CreateEnum
CREATE TYPE "PaymentInstructionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- New lifecycle / money / service-period / concurrency columns on Invoice.
ALTER TABLE "Invoice" ADD COLUMN "approvedBy" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "issuedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "voidedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "voidReason" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "writtenOffAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "subtotal" DECIMAL(10, 2);
ALTER TABLE "Invoice" ADD COLUMN "taxAmount" DECIMAL(10, 2);
ALTER TABLE "Invoice" ADD COLUMN "creditApplied" DECIMAL(10, 2);
ALTER TABLE "Invoice" ADD COLUMN "balanceDue" DECIMAL(10, 2);
ALTER TABLE "Invoice" ADD COLUMN "serviceStart" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "serviceEnd" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(10, 2) NOT NULL,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentInstruction" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "amount" DECIMAL(10, 2) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'SAVED_CARD',
    "status" "PaymentInstructionStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "idempotencyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "stripePaymentIntentId" TEXT,
    "failureReason" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedStripeEvent" (
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedStripeEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_idempotencyKey_key" ON "Invoice"("idempotencyKey");
CREATE INDEX "Invoice_tenantId_unitId_idx" ON "Invoice"("tenantId", "unitId");
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");
CREATE UNIQUE INDEX "PaymentInstruction_idempotencyKey_key" ON "PaymentInstruction"("idempotencyKey");
CREATE INDEX "PaymentInstruction_invoiceId_idx" ON "PaymentInstruction"("invoiceId");
CREATE INDEX "PaymentInstruction_tenantId_idx" ON "PaymentInstruction"("tenantId");
CREATE INDEX "PaymentInstruction_status_idx" ON "PaymentInstruction"("status");

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentInstruction" ADD CONSTRAINT "PaymentInstruction_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentInstruction" ADD CONSTRAINT "PaymentInstruction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MANAGER', 'VIEWER');

-- CreateEnum
CREATE TYPE "BranchStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "UnitStatus" AS ENUM ('OCCUPIED', 'AVAILABLE', 'RESERVED', 'OVERDUE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'DUE_SOON', 'OVERDUE', 'NOTICE');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('PERSONAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PAID', 'DUE', 'OVERDUE');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW_ENQUIRY', 'CONTACTED', 'VIEWING_BOOKED', 'PROPOSAL_SENT', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('WEBSITE', 'WHATSAPP', 'REFERRAL', 'GOOGLE');

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MANAGER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "description" TEXT,
    "operatingHours" TEXT NOT NULL,
    "status" "BranchStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Floor" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Floor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitSize" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sqftFrom" INTEGER NOT NULL,
    "sqftTo" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "UnitSize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "sizeId" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL,
    "sqft" INTEGER NOT NULL,
    "status" "UnitStatus" NOT NULL DEFAULT 'AVAILABLE',
    "climateControl" TEXT,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL DEFAULT 'PERSONAL',
    "segment" TEXT,
    "email" TEXT,
    "mobile" TEXT,
    "unitId" TEXT,
    "moveInDate" TIMESTAMP(3),
    "monthlyRate" DECIMAL(10,2) NOT NULL,
    "psf" DECIMAL(10,2) NOT NULL,
    "nextPayment" TIMESTAMP(3),
    "status" "TenantStatus" NOT NULL,
    "lastAccessAt" TIMESTAMP(3),
    "accessMethod" TEXT,
    "autoDebit" BOOLEAN NOT NULL DEFAULT false,
    "missedPayments" INTEGER NOT NULL DEFAULT 0,
    "paymentCount" INTEGER NOT NULL DEFAULT 0,
    "lifetimeValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "branchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "bookingRef" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "moveInDate" TIMESTAMP(3) NOT NULL,
    "duration" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DUE',
    "method" TEXT,
    "billedMonth" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL DEFAULT 'PERSONAL',
    "segment" TEXT,
    "stage" "LeadStage" NOT NULL DEFAULT 'NEW_ENQUIRY',
    "source" "LeadSource" NOT NULL DEFAULT 'WEBSITE',
    "preferredSize" TEXT,
    "preferredBranchId" TEXT,
    "monthlyRate" DECIMAL(10,2),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateChange" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "previous" DECIMAL(10,2) NOT NULL,
    "current" DECIMAL(10,2) NOT NULL,
    "changePct" DECIMAL(6,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "appliedBy" TEXT NOT NULL,

    CONSTRAINT "RateChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_code_key" ON "Branch"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Floor_branchId_level_key" ON "Floor"("branchId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "UnitSize_code_key" ON "UnitSize"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_unitCode_key" ON "Unit"("unitCode");

-- CreateIndex
CREATE INDEX "Unit_branchId_floorId_idx" ON "Unit"("branchId", "floorId");

-- CreateIndex
CREATE INDEX "Unit_status_idx" ON "Unit"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_branchId_unitCode_key" ON "Unit"("branchId", "unitCode");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_unitId_key" ON "Tenant"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_bookingRef_key" ON "Booking"("bookingRef");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNo_key" ON "Invoice"("invoiceNo");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "RateChange_unitId_idx" ON "RateChange"("unitId");

-- AddForeignKey
ALTER TABLE "Floor" ADD CONSTRAINT "Floor_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_sizeId_fkey" FOREIGN KEY ("sizeId") REFERENCES "UnitSize"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_preferredBranchId_fkey" FOREIGN KEY ("preferredBranchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateChange" ADD CONSTRAINT "RateChange_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

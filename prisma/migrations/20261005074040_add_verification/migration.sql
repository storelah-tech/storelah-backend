-- DropIndex
DROP INDEX "FloorPlan_status_idx";

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "tenantId" TEXT,
    "bookingRef" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'mock-camera',
    "idType" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Verification_bookingRef_idx" ON "Verification"("bookingRef");

-- CreateIndex
CREATE INDEX "Verification_customerId_idx" ON "Verification"("customerId");

-- AddForeignKey
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT,
    "passwordHash" TEXT NOT NULL,
    "type" "AccountType" NOT NULL DEFAULT 'PERSONAL',
    "companyName" TEXT,
    "uen" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");

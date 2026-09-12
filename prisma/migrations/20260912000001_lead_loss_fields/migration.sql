-- AlterTable: analytics loss attribution on Lead (see schema.prisma).
-- lossReason defaults at the application layer ("Unspecified" on LOST transition),
-- so no DB default is set; existing rows stay NULL (= never lost / unknown).
ALTER TABLE "Lead" ADD COLUMN "lossReason" TEXT,
ADD COLUMN "lossValue" DECIMAL(10,2);

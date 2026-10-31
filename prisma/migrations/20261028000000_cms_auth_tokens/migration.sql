-- CMS auth emails (2026-10-28): operator invites + password reset links.
-- Existing operators already have a password, so they are marked active now;
-- only operators created by invite start with activatedAt = NULL.
-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "invitedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AdminAuthToken" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminAuthToken_tokenHash_key" ON "AdminAuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminAuthToken_adminUserId_kind_idx" ON "AdminAuthToken"("adminUserId", "kind");

-- AddForeignKey
ALTER TABLE "AdminAuthToken" ADD CONSTRAINT "AdminAuthToken_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: every existing operator is already active.
UPDATE "AdminUser" SET "activatedAt" = "createdAt" WHERE "activatedAt" IS NULL;

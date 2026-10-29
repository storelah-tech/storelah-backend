-- Site-builder global settings (docs/SITE_BUILDER_PLAN.md §4.1 SiteSettings). Additive.

-- AlterTable
ALTER TABLE "SitePublish" ADD COLUMN     "settingsVersion" INTEGER;

-- CreateTable
CREATE TABLE "SiteSettings" (
    "id" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "draftRev" INTEGER NOT NULL DEFAULT 0,
    "live" JSONB,
    "liveVersion" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteSettings_pkey" PRIMARY KEY ("id")
);


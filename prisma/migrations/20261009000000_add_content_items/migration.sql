-- Landing content management (mini-WordPress for images + texts).
-- Additive only: brand-new enum + table, no changes to existing models.
-- One row per landing slot keyed by operator slug `key`; images live in S3
-- (CONTENT_S3_BUCKET, see docs/CONTENT_MANAGEMENT.md) or as local files.
CREATE TYPE "ContentType" AS ENUM ('HERO_IMAGE', 'TESTIMONIAL', 'TEXT', 'IMAGE');

CREATE TABLE "ContentItem" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "ContentType" NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "author" TEXT,
    "role" TEXT,
    "imageKey" TEXT,
    "imageUrl" TEXT,
    "alt" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContentItem_key_key" ON "ContentItem"("key");
CREATE INDEX "ContentItem_type_published_sortOrder_idx" ON "ContentItem"("type", "published", "sortOrder");

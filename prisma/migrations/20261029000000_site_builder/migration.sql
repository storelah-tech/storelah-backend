-- Site builder (docs/SITE_BUILDER_PLAN.md §4.1, Phase 1): landing pages as
-- validated JSON documents with immutable published versions + publish audit.
-- Additive only. Seeds the new `site-builder` permissions into the default
-- Manager (all but approve = publish) and Viewer (view) roles; Owner is
-- re-synced to every permission on boot by ensureSystemRoles().

-- CreateEnum
CREATE TYPE "SitePageStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SitePublishStatus" AS ENUM ('NOT_CONFIGURED', 'SKIPPED', 'DISPATCHED', 'FAILED');

-- CreateTable
CREATE TABLE "SitePage" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "SitePageStatus" NOT NULL DEFAULT 'DRAFT',
    "system" BOOLEAN NOT NULL DEFAULT false,
    "draft" JSONB NOT NULL,
    "draftRev" INTEGER NOT NULL DEFAULT 0,
    "liveVersionId" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SitePage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SitePageVersion" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "doc" JSONB NOT NULL,
    "note" TEXT,
    "publishId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SitePageVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SitePublish" (
    "id" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "note" TEXT,
    "status" "SitePublishStatus" NOT NULL,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SitePublish_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SitePage_slug_key" ON "SitePage"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "SitePage_liveVersionId_key" ON "SitePage"("liveVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "SitePageVersion_pageId_number_key" ON "SitePageVersion"("pageId", "number");

-- AddForeignKey
ALTER TABLE "SitePage" ADD CONSTRAINT "SitePage_liveVersionId_fkey" FOREIGN KEY ("liveVersionId") REFERENCES "SitePageVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SitePageVersion" ADD CONSTRAINT "SitePageVersion_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "SitePage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Default role grants (roles may since have been edited; skip if absent).
INSERT INTO "AdminRolePermission" ("id", "roleId", "permission")
SELECT v.id, v."roleId", v.permission
FROM (VALUES
  ('role_manager_site_builder_view', 'role_manager', 'site-builder:view'),
  ('role_manager_site_builder_create', 'role_manager', 'site-builder:create'),
  ('role_manager_site_builder_update', 'role_manager', 'site-builder:update'),
  ('role_manager_site_builder_delete', 'role_manager', 'site-builder:delete'),
  ('role_viewer_site_builder_view', 'role_viewer', 'site-builder:view')
) AS v(id, "roleId", permission)
WHERE EXISTS (SELECT 1 FROM "AdminRole" r WHERE r.id = v."roleId")
ON CONFLICT DO NOTHING;

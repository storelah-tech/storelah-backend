-- Booking extras catalog (CMS-editable): protection tiers + packing-supply addons.
-- Additive only: two brand-new tables, no changes to existing models.
-- `id` is the stable frontend slug (TEXT primary key, no cuid default).
-- `active=false` hides a row from public reads (preferred over hard delete).
CREATE TABLE "ProtectionPlan" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "price" DECIMAL(10,2) NOT NULL,
  "coverage" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProtectionPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Addon" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "price" DECIMAL(10,2) NOT NULL,
  "unit" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Addon_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProtectionPlan_active_sortOrder_idx" ON "ProtectionPlan"("active", "sortOrder");
CREATE INDEX "Addon_active_sortOrder_idx" ON "Addon"("active", "sortOrder");

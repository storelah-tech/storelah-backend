-- Customer move-out notice persistence.
-- POST /api/v1/customer/notice previously validated ownership but persisted
-- NOTHING, so the booking portal could not read a submitted notice back after
-- refresh. This adds a dedicated Notice table (one row per submission; the
-- portal reads the latest by createdAt). No existing table or column changes.
--
-- Applied manually via `prisma db execute` + `migrate resolve` following the
-- 20260822000000 precedent, because the dev database carries pre-existing
-- drift (20260820030247_add_customer_profile_fields is applied remotely but
-- missing from this checkout) and `migrate dev` would otherwise demand a
-- destructive reset. NOT yet applied to any database as of creation.

-- CreateTable
CREATE TABLE "Notice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "lastDay" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notice_tenantId_idx" ON "Notice"("tenantId");

-- AddForeignKey
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

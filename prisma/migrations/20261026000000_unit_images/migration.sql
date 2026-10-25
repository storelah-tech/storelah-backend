-- Customer-facing photos per unit (CMS unit detail → Photos; first = booking cover).
CREATE TABLE "UnitImage" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "imageKey" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitImage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UnitImage_unitId_sortOrder_idx" ON "UnitImage"("unitId", "sortOrder");

ALTER TABLE "UnitImage" ADD CONSTRAINT "UnitImage_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

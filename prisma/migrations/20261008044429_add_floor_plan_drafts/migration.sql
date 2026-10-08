-- CreateTable
CREATE TABLE "FloorPlanDraft" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "structure" JSONB,
    "gfaSqft" DOUBLE PRECISION,
    "placements" JSONB NOT NULL,
    "blocks" JSONB NOT NULL,
    "boundaries" JSONB NOT NULL,
    "markers" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorPlanDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FloorPlanDraft_floorId_idx" ON "FloorPlanDraft"("floorId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorPlanDraft_floorId_version_key" ON "FloorPlanDraft"("floorId", "version");

-- AddForeignKey
ALTER TABLE "FloorPlanDraft" ADD CONSTRAINT "FloorPlanDraft_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

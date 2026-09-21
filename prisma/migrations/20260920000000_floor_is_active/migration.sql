-- Floor active/inactive flag for public visibility gating.
-- Adds non-nullable "isActive" (default true) to "Floor" so every existing
-- floor stays visible with no backfill; the public API filters
-- floor.isActive = true on all unit/branch/plan reads. Deactivation is
-- reversible (PUT /floors/:id { isActive }) — see docs/FLOORS.md.
ALTER TABLE "Floor" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "Floor_isActive_idx" ON "Floor"("isActive");

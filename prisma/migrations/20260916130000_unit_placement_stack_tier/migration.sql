-- Stackable locker placements: two locker units may share the exact same
-- x/y/width/height rect as an upper/lower pair, distinguished by "stackTier"
-- (0 = ground/sole tier, 1 = upper tier). Additive only: DEFAULT 0 keeps every
-- existing placement on the ground tier, so no existing row changes meaning.
ALTER TABLE "UnitPlacement" ADD COLUMN "stackTier" INTEGER NOT NULL DEFAULT 0;

-- Odd-shaped units (D1): nullable outline polygon on UnitPlacement.
-- NULL = plain rectangle (every existing row unchanged); when set, x/y/width/height
-- store the server-derived bounding box and outline holds [[x,y],...] absolute
-- decimal-foot vertices in clockwise order.
ALTER TABLE "UnitPlacement" ADD COLUMN "outline" JSONB;

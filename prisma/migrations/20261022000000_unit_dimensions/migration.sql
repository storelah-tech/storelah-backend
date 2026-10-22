-- Unit physical dimensions (decimal feet). Additive + nullable: existing rows
-- keep their sqft untouched; sqft is derived from length × width only when
-- both are written through the API.
ALTER TABLE "Unit" ADD COLUMN "lengthFt" DOUBLE PRECISION;
ALTER TABLE "Unit" ADD COLUMN "widthFt" DOUBLE PRECISION;
ALTER TABLE "Unit" ADD COLUMN "heightFt" DOUBLE PRECISION;

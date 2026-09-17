-- AlterEnum: P1 unit-map parity — BLOCKED units are held out of inventory
-- (fit-out, damage, audit hold). Additive only: no existing value is touched.
ALTER TYPE "UnitStatus" ADD VALUE 'BLOCKED';

-- Canonical facility rename SW → SS (Sembawang), 2026-11-10. DEV ONLY.
-- DO NOT APPLY TO PROD/CLOUD: this migration is for the local dev DB only
-- (DATABASE_URL on Postgres port 5433). Production needs explicit owner
-- authorization per the standing rules — migrate first (direct Neon URL),
-- then the Lambda code update.
--
-- Contract: the canonical Sembawang code is SS; SW stays a deprecated alias
-- on reads (see canonicalBranchCode in src/core/branches.ts). Unit codes are
-- 4-digit branch-free (e.g. 1001) and UNCHANGED — never map 1001 → SS1001.
-- Legacy dash rows map SW-01-01 → SS-01-01 (level + sequence preserved).
--
-- Collision guard: abort when an SS branch row or any SS-% unit code already
-- exists, so the rename can never merge two facilities or double-rename.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Branch" WHERE code = 'SS') THEN
    RAISE EXCEPTION 'rename aborted: Branch code SS already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM "Unit" WHERE "unitCode" LIKE 'SS-%') THEN
    RAISE EXCEPTION 'rename aborted: Unit rows with SS-%% codes already exist';
  END IF;
END
$$;

UPDATE "Branch" SET code = 'SS' WHERE code = 'SW';

UPDATE "Unit" SET "unitCode" = 'SS' || substr("unitCode", 3) WHERE "unitCode" LIKE 'SW-%';

-- Report-only audits (loose unitCode references — no FK, so no writes here;
-- run by hand and reconcile against the renamed units):
--   SELECT id, "unitCode" FROM "Lead" WHERE "unitCode" LIKE 'SW-%';
--   SELECT id, "unitCode" FROM "Quotation" WHERE "unitCode" LIKE 'SW-%';
-- "Notice" carries no unitCode column (FK unitId only) — nothing to audit.

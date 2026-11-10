# Lease Horizon P9 — Production Rollout Runbook (D11A)

**Status:** PROCEDURE ONLY — this document executes nothing. Every numbered
rollout step below requires the user's explicit go-ahead before it is run.
Nothing in this file changes code, flags, data, or infrastructure by itself.

**Scope:** additive migration `20261109000000_finance_lease_horizon_p4`
(new `FinancialModelCalculation` table + `FinancialModel.calculationStatus`
default `CURRENT`) and the P4 gating flags. No src/ behaviour changes in P9.

**References (read before executing):** handoff §14 (steps 1–9),
`docs/finance/LEASE_HORIZON_OWNER_DECISIONS.md` (D10A term cap, D11A rollout,
D13B fixture), `docs/finance/LEASE_HORIZON_PLAN.md` §9 (P1 owner overrides),
`docs/finance/lease-horizon-evidence/05-shadow-report-and-p9-procedure.md`
(full transcripts + per-model report shape), `src/core/finance/landlordLease.ts`
(rollout gate semantics), `src/core/settings.ts` + `src/core/finance/policies.ts`
(flag definitions, both default off).

## 0. Preconditions (all must hold before Step 1)

1. **Branch:** work happens from the `feature/24-lease-horizon` lane; the prod
   deploy itself is a Lambda code update (Step 1), not a git push.
2. **Flags off:** `finance.leaseHorizon.rollout = off` and
   `finance.leaseHorizon.returns = off` (both defaults — `src/core/settings.ts`,
   `src/core/finance/policies.ts`). While both are off, all reads serve the v1
   path: the governed write routes (`PUT …/landlord-lease`, `PUT …/valuation`,
   `POST …/recalculate`) return 409 `BLOCKED` (`requireLeaseWriteRollout`,
   `src/core/finance/landlordLease.ts`), and `GET /finance/returns` returns the
   legacy 1/3/5-year shape only (`buildCommittedBlock` returns `null` unless
   `returns = on` AND the model stores valuation assumptions —
   `src/core/finance/returns.ts`).
3. **Evidence + sign-off:** the D13B fixture
   (`tests/e2e/fixtures/finance-lease-horizon-validation.json` + `DERIVATION.md`)
   reconciliation (`02-sembawang-reconciliation.md`) is signed off by
   Finance/owner. As of writing the reviewer row is `_pending_` — **this is the
   release gate; do not proceed past this section without it.**
4. **Owner review list:** the per-model shadow report (Step 2) for every
   mid-month CURRENT model, in the D11A shape (model + facility, old/new lease
   end dates, old/new lease cash flows by affected month, old/new committed
   Project NPV / IRR / paybacks from `/finance/returns`, variance explanation,
   reviewer + approval status — same SIGN-OFF block shape as
   `02-sembawang-reconciliation.md`).

## 1. Prod migration first, then Lambda code update

1. **Migrate first, with the direct Neon URL** (migrations cannot run over the
   pooled URL):
   ```sh
   DATABASE_URL="<direct-Neon-URL>" pnpm prisma migrate deploy
   ```
   This applies `20261109000000_finance_lease_horizon_p4`, which is
   **additive only**: one `ADD COLUMN … DEFAULT 'CURRENT'` on
   `FinancialModel` plus the new `FinancialModelCalculation` table with its
   unique indexes and FK. No column is altered or dropped, no row is rewritten,
   and `FinancialModelVersion` snapshots are untouched.
2. **Then update the Lambda function code** to the published P9 build
   (`update-function-code` with the P9 zip). Never do a full CloudFormation
   deploy of the backend stack — the live Lambda env has drifted from
   `infra/backend-stack.yaml` and a stack deploy would regress it.
3. **Expected result:** no number changes while both flags are off. The new
   write path is 409-blocked, the committed returns block is absent, and every
   read serves the v1 path exactly as before. Verify with a spot
   `GET /finance/returns` (legacy shape, no `committed` block) before
   continuing.

## 2. Read-only shadow run against prod

Script: `scripts/lease-horizon-shadow.ts` — single `findUnique`, no writes, no
recalculation, no audit events, prints no secrets (model identity + money rows
+ KPI names only).

**Preferred invocation (no DB connection at all):** export each CURRENT model's
stored `inputs` JSON via a read-only fetch, then run the script against the file:
```sh
pnpm tsx scripts/lease-horizon-shadow.ts path/to/model-snapshot.json
```
The script also accepts `{ "inputs": … }` / `{ "input": … }` wrappers (the
golden fixture uses `{ "input": … }`).

**Live-id invocation (only if a snapshot is impractical):**
```sh
pnpm tsx scripts/lease-horizon-shadow.ts <modelId>
```

**DB posture (mandatory):** point at prod with a **READ-ONLY** connection —
direct or pooled read URL. NEVER run the shadow against prod with a
write-capable role. (The script header additionally cautions against prod use:
when in doubt, prefer the JSON-file form, which opens no database connection.)

**Rules (D11A, handoff §14):**

- Produce the row-level report for **every** CURRENT model first (report shape:
  evidence doc `05`, §"Per-model report shape").
- **Report every difference.** The known systematic variance is the closing
  stub: every mid-month CURRENT model shows one extra closing row (e.g. the
  12-mo 15 Dec 2026 fixture: v1 12 rows → v2 13 rows, revenue +4077.84, lease
  +2258.06, cash-end +1277.84 — exactly the stub NOI; see
  `shadow/shadow-mid-month-12mo.txt`). Record old/new NPV, IRR and paybacks
  from the committed fractional-period figures, not the integer-period KPI line.
- **First-of-month models must show zero diff** — they are regression evidence
  (`shadow/shadow-first-of-month-60mo.txt`: 60 rows identical to the cent,
  totals and KPIs equal, `v2 checks: all pass`). Any non-zero diff on a
  first-of-month model is a defect: STOP, do not proceed.
- **NO auto-migration:** any CURRENT model whose result changes requires
  owner/Finance review of that model's report BEFORE the new result is enabled
  for it (Step 3). Keep the rollback path: source assumptions are never
  deleted; prior revisions stay restorable.

## 3. Per-model owner decision (every mid-month CURRENT model)

For each mid-month CURRENT model in the Step 2 report, the owner records one of:

- **Approve migration** — the stub variance is understood and the model may
  move to the v2 result (enacted in Step 4); or
- **Hold on v1** — the model keeps serving its existing numbers; no write is
  made to it and its report stays open.

There is deliberately **no bulk or automatic migration**: the codebase contains
no bulk-migration path for the v2 lease block (upcast happens on READ only —
`editableBase`/`upcastInputs`, never written back as history), so an approved
model moves only through its own governed `PUT …/landlord-lease` in Step 4.
Holding is the default — doing nothing preserves v1 output exactly.

## 4. Authorised backfill of the v2 lease block

Only for models the owner approved in Step 3, one governed write each:

- `PUT /api/v1/cms/finance/models/:id/landlord-lease` with the current
  `version` (rowVersion CAS; 409 with the handoff conflict copy on mismatch),
  server-derived end date (client `committedEndDate` is accepted and ignored),
  complete per-year schedule (unconfirmed `estimated` rows block with 422
  `LEASE_SCHEDULE_UNCONFIRMED` until confirmed), and an idempotency key
  (repeat key replays the first result without re-projecting).
- **Non-archived models only.** `ARCHIVED` models are `LOCKED` (restore to a
  new draft instead); `CURRENT`/`PENDING` models are never mutated — the first
  edit auto-forks an identifiable child draft (`Editing draft based on approved
  version {v}`) and the write lands there. `DRAFT` models update in place.
- **Never touch version snapshots:** `FinancialModelVersion` rows are
  immutable; the write creates a new model revision + `FinancialModelCalculation`
  row (after-commit valuation is conditional on `modelVersion` — stale results
  are discarded, never applied).
- **Legacy values retained in audit:** the whole-month `rentFreeMonths` is
  carried as `legacyRentFreeMonths` into the `MODEL_LEASE_HORIZON_UPDATED` audit
  event (D3A) and is never edited through this route.
- Each write emits `financial_model.lease_horizon.updated` + audit in the same
  transaction; shortening before the latest posted actuals month is 409-blocked
  (no auto-rebase in v1).

## 5. Independent Sembawang validation (D13B gate)

Before enabling anything beyond admins, re-confirm the signed-off fixture
against the deployed build:

- Fixture: `tests/e2e/fixtures/finance-lease-horizon-validation.json`
  (independent Python derivation — `scripts/derive-lease-horizon-valuation.py`,
  `DERIVATION.md`); reconciliation: evidence `02-sembawang-reconciliation.md`
  (60-mo §7.7 anchors, NPV @ 0/8/15%, IRR, paybacks, deposit/reinstatement
  placement; worst series diff 0).
- If the owner supplied a current Sembawang spreadsheet, use it as an
  additional comparison source, investigate every difference, and do not treat
  its formulas as correct. If none exists, the signed-off fixture is sufficient.
- Mismatch rule: STOP and report both sides — never silently fix either side.

## 6. Rollout = admins (Finance-Admin-first UI)

Flip `finance.leaseHorizon.rollout` from `off` to `admins` (Global Settings).
Effect (`requireLeaseWriteRollout`): the write path opens for Owners only;
non-Owners still get 403/409. Then:

1. Confirm the Model Library snapshot round-trips the v2 block (load a
   migrated draft → Landlord lease section shows the stored term/dates/schedule;
   history view shows the `MODEL_LEASE_HORIZON_UPDATED` entries).
2. Confirm the audit trail: field before/after (old/new term + end dates,
   schedule added/changed/excluded/confirmed, `legacyRentFreeMonths`), actor,
   timestamp, source version → new version, calculation status.

## 7. Returns = on, then rollout = all

1. Flip `finance.leaseHorizon.returns` from `off` to `on`. Effect: models that
   store valuation assumptions gain the `committed` block in
   `GET /finance/returns` (full-horizon NPV/IRR/paybacks at the model's stored
   rate, version-keyed; 1/3/5-year slices stay supplementary and labelled
   `NPV through Year X`). Legacy models without a stored rate keep the legacy
   shape — the global default is never substituted.
2. Refresh downstream consumers that read the committed block (Investment
   Returns, reports/PDFs, DCF export) and confirm they show the new revision
   (`modelVersion`/`inputHash`-keyed; stale figures stay labelled, export stays
   disabled until the matching calculation succeeds).
3. Only then flip `finance.leaseHorizon.rollout` from `admins` to `all`,
   opening the write path to every operator holding the lease permission.
   (Permission mapping: `finance.models.edit_lease` → `bill-models:update`;
   every new route is already in `src/lib/routePermissions.ts`.)

## 8. Rollback

1. **Lambda:** redeploy the prior published function version
   (`update-function-code` to the previous build). Reads immediately return to
   the v1 path.
2. **Flags:** set `finance.leaseHorizon.rollout` and
   `finance.leaseHorizon.returns` back to `off`.
3. **Data:** no data rollback is needed. Source assumptions were never deleted;
   prior model revisions and `FinancialModelVersion` snapshots remain
   restorable; any v2-block revisions written in Step 4 stay inert readable rows
   once the flags are off.
4. **No down-migration:** this procedure provides **no down SQL**, explicitly.
   It is safe because the migration is purely additive — one nullable-effect
   column with a default plus one new table. The pre-P9 code simply ignores
   both, so rolling the Lambda back needs no schema reversal. (Do not invent a
   `DROP TABLE`/`DROP COLUMN` rollback: it would destroy calculation history
   for zero benefit.)

## 9. Local screenshot session (worktree backend, throwaway/local DB only)

No `.vscode` launch config exists in this repo — do not invent one. Run the
worktree backend directly:

```sh
PORT=4176 pnpm dev
```

Run from the worktree root (`storelah-backend/_worktrees/lease-horizon`).
`.env` (gitignored, copy `.env.example`) points `DATABASE_URL` at the local
Postgres on port **5433**. For the screenshot session, flip
`finance.leaseHorizon.rollout` (→ `admins` or `all`) and
`finance.leaseHorizon.returns` (→ `on`) in Global Settings **on the
throwaway/local DB only** — never against prod, and never with real secrets in
chat or code. `pnpm db:seed` is destructive (wipes all tables): never run it
against cloud/prod; the harness DB is throwaway by design.

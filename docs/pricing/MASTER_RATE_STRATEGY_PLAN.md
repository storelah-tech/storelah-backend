# Master Rate Strategy — P0 Design Note (Track B)

**Scope:** Track B only (§15, R15–R17; §5 Track B models; §6 `facility-rate-strategy`).
Move-out / refund / transfer (Track A) is a separate plan — referenced here only for
shared rules (§2) and the §3 rows about Unit / Financial Model / Promotions.
**No app code, migration, or schema edit in P0** — research + design only.

**Base:** worktree `feature/52-master-rate-strategy` at `7c16f71` (== `origin/main` HEAD;
`git status` clean). Handoff
(`StoreLah_Refund_Transfer_Moveout_Rate_Strategy_Developer_Handoff_2026-11-18.md`,
prototype v55) was **not available in-repo at P0 time** — every rule below comes from
brief `.opencode/briefs/moveout-refund-transfer-rate-strategy.md` (and
`.opencode/briefs/finance-module.md` §§2–4). Anything needing handoff-only detail
(§15.16/§15.17 worked examples, §21 rate 1–18, §15.3 page order, chart approach) is
marked **PENDING_HANDOFF**. Nothing is guessed beyond the brief.

Conventions assumed throughout (brief §2): additive-only migrations; money in
`Prisma.Decimal` / integer cents with `toNum` at the API boundary
(`src/lib/format.ts`); server-is-authoritative (preview and post share one pure
function); `writeAuditEvent` + `publishFinanceEvent` in the same transaction
(`src/core/finance/audit.ts:31`, `src/core/finance/events.ts:71`); optimistic
locking via `assertFreshVersion`/`nextVersion` + idempotency keys
(`src/core/finance/idempotency.ts`); versions immutable once submitted; every new
CMS route in `src/lib/routePermissions.ts` (else `tests/e2e/cms-rbac.test.ts` fails)
and `src/lib/openapi.ts`; Bearer JWT auth preserved.

---

## 1. §3 mapping-table rows (Track B) — confirmed against code

### 1a. `Unit.monthlyRate` — readers and writers

**Writers** (only three code paths + scripts/seed):

| Writer | File:line | `RateChange` row? | `appliedBy` value |
|---|---|---|---|
| `adjustRate()` via `POST /units/:code/rate` | `src/core/rates.ts:13-37`, route `src/routes/cms.ts:793-800` | Yes, one row per call (`rates.ts:26-36`) | Operator name from JWT, fallback `'Operator'` (`cms.ts:798`) |
| Floor-plan publish sync (`unitSizeSync`) | `src/core/unitSizeSync.ts:257` (rate), `:274` (history) | Yes (`RateChange` + `UnitAreaChange`) | Caller-supplied `opts.appliedBy` (`unitSizeSync.ts:234,270,284`) |
| `scripts/retier-units.ts` (manual retier) | `scripts/retier-units.ts:129` | Yes | `'retier-units script (owner-approved 2026-11-11)'` |
| Seed only | `prisma/seed.ts:330-331` | Yes (2 rows) | `'Faisal Z.'` / `'System'` |

`adjustRate()` internals (`src/core/rates.ts:13-53`): reads unit (+tenant),
rounds to cents, `$transaction`s the `Unit.monthlyRate` write + `RateChange`
(previous/current/changePct/reason/appliedBy), then **also writes
`Tenant.monthlyRate` + `Tenant.psf`** when the unit is occupied (`rates.ts:39-44`).
→ The R17 rule "`Tenant.monthlyRate` is never touched" applies to the **batch
apply path only** (new code must NOT reuse `adjustRate` wholesale — it must reuse
the Unit+RateChange internals minus the tenant write).

**Readers** (rack-rate consumers; none may be silently forked — the batch apply
writes the same `Unit.monthlyRate` column they read):

- `src/core/rates.ts:59-126` `getNetPsf()` (portfolio net PSF over OCCUPIED+OVERDUE)
- `src/core/units.ts:143` (map), `:326` (list serialize), `:745-746` (serialize),
  `:887-888,901` (detail + tenant rate), `:1241` (create/update), `:1282-1337`
  (activity incl. `rateChange.findMany`)
- `src/core/branches.ts:30,45-47` (portfolio MRR/PSF)
- `src/core/summary.ts:28,32,44` (command-centre KPIs)
- `src/core/actionCenter.ts:27,38,48,58` (below-market flag etc.)
- `src/core/finance/pricing.ts:74,82-83` (`liveAvgPsf`/overlay base)
- `src/core/floorPlanMetricsService.ts:637,865` (actuals, moneyJson)
- `src/core/promotionPlans.ts:846,865` + `src/core/quotes.ts:53,57` (sample-book
  quotes sorted by `monthlyRate`)
- `src/core/customers.ts:468-469,910` (booking totals from `Unit.monthlyRate`),
  `src/core/customerProfile.ts:194-195,284` (net/gross rent)
- `src/core/quotationRegister.ts:46`, `src/core/quotationPdf.ts:52,216,223`
- `src/core/finance/billing.ts:706` reads **`Tenant.monthlyRate`** (recurring
  billing — untouched by rate batches per R17), `arrears.ts:70,345`, `investor.ts:81-84`
- CMS admin: `unitsView.js` (filter/sort/edit, `:1073,:1190,:1251`),
  `tenantsView.js:218,430`, quotes workspace (`leadsWorkspace.js`)

### 1b. `UnitSize.code` / `Floor.level` / branch lowest level

- `UnitSize` (`prisma/schema.prisma:590-612`): `code @unique`, `sqftFrom/sqftTo`,
  `sortOrder`. **Canonical post-migration taxonomy** (`prisma/migrations/
  20261111000000_unit_size_ranges/migration.sql:1-98`): `LOCKER` 8–15, `XS` 10–19,
  `SMALL`("S") 20–39, `MEDIUM`("M") 40–69, `LARGE`("L") 70–99, `XLBIZ`("XL")
  100–150 (codes unchanged; display names shortened). Pre-existing `LOCKER` rows
  were re-coded to `XS`; new `LOCKER` + `XLBIZ` rows seeded.
- **Dev-DB caveat:** local `storelah` still shows the OLD taxonomy (`LOCKER/SMALL/
  MEDIUM/LARGE`, sqft 12/30/60/120) — migration `20261111000000` has **not** been
  applied to dev. B2 must migrate dev before any size-point work, or size points
  will mis-map. (Read-only counts, 2026-11-18.)
- `Floor` (`schema.prisma:306-329`): `level Int` (real building level 1..99),
  `@@unique([branchId, level])`, `isActive`. Seed (`prisma/seed.ts:179-194`):
  branches SS/WD/UB each with floors 1–4 (`multiLevel: true`); dev DB currently
  has only SS with lowest active level **1** (single floor).
- R15 confirmed implementable: Locker = `UnitSize.code === 'LOCKER'`
  (post-migration); Ground floor = `Floor.level` equals the branch's lowest
  **active** level (`MIN(level) WHERE branchId + isActive`).

### 1c. `Unit.status` values in use

Enum (`schema.prisma:20-34`): `OCCUPIED, AVAILABLE, RESERVED, OVERDUE,
MAINTENANCE, INACTIVE, BLOCKED, DRAFT` (8 values; `SUSPENDED` does **not** exist —
that is a Track A `TenantStatus` addition).
In-use on dev (read-only, 2026-11-18): `AVAILABLE` 903, `RESERVED` 6
(`OCCUPIED` 0 — dev is an inventory snapshot; seed distribution is
~60/20/20 AVAILABLE/RESERVED/OCCUPIED per `prisma/seed.ts:64-70`).
R15/R17 mapping holds against code: schedule size point = `Math.round(unit.sqft)`;
**Vacant = `status == AVAILABLE` only** — `RESERVED`, `DRAFT` (unpublished plan
units, excluded from browse/rent paths e.g. `rates.ts:66-83`, `pricing.ts:69-75`),
`BLOCKED`, `MAINTENANCE`, occupied (`tenant != null`) are all excluded from
`Preserve existing manual rates` and from batch writes.

### 1d. `Unit.restrictedAccess` / `Unit.rateSource` — confirmed absent

`grep rateSource|restrictedAccess src/ prisma/` → **no matches** (`schema.prisma`
`Unit` model `:614-658` has neither column; R17's `Tenant.accessRestricted`
exists at `schema.prisma:760-762` and is a different, tenant-level concern).
Both are pure B2 additions — no back-compat reads to preserve.

---

## 2. Financial Model target field (CURRENT read path)

**There is no stored scalar "recurring effective PSF" column.** `FinancialModel`
(`schema.prisma:2093-2118`) stores `status` (`DRAFT | PENDING | CURRENT |
ARCHIVED`), `inputs Json`, `engineVersion`, `inputHash`, `version`. The PSF lives
**inside `inputs` + the projection result**:

- Reference values (test model on dev + golden fixture): `inputs.pricing =
  { annualIncreasePct: 3 }` — **no `weightedStartPsf` override** — and
  `inputs.sizeMix` (Sembawang Launch Plan: NLA 2,274; XS 455×6.8 … XL 264×4.2).
  Engine derives `weightedStartPsf = Σ(nla×psf)/Σnla = 12821.8/2274 =
  **5.6384**` (`src/core/finance/projection.ts:319-322,387`; golden
  `tests/e2e/fixtures/finance-projection-golden.json:22`; `docs/finance/
  TEST_MATRIX.md:150`; UI copy "200 sq ft × $5.64" in `financeWorkspace.js:318`).
- The **approved CURRENT read path** used by every consumer is identical:
  `findFirst({ where: { branchId, status: 'CURRENT' }, orderBy: { updatedAt: 'desc' } }`
  then `project()` → `result.kpis.weightedStartPsf`
  (`src/core/finance/returns.ts:49`, `report.ts:239,286`, `monthClose.ts:104,403`,
  `budgets.ts:49`, `investor.ts:51`; KPI produced at `projection.ts:768`,
  override path at `projection.ts:387,622`: `pricing.weightedStartPsf ??
  weightedPsf(sizeMix)`).

**Design decision (for B3): the strategy engine must read the branch's latest
`CURRENT` FinancialModel, project it with the same pure `project()` engine, and
take `kpis.weightedStartPsf` as the target PSF** (4dp; reference 5.6384).
Candidates considered and rejected:

| Candidate | Why not the target |
|---|---|
| `inputs.pricing.weightedStartPsf` (stored override) | Optional; absent in the reference model. Using it when present but derived otherwise splits the source of truth. Engine must use the *resolved* KPI either way |
| `SizePriceRule.targetPsf` / `getPricing().weightedPsf` (`pricing.ts:86,114`) | Planning **overlay** (authority SYSTEM/MANUAL, may be empty — dev has 0 rows), not the approved model. Explicitly not authoritative (brief §3: "Read-only: latest CURRENT (approved) FinancialModel … Never a DRAFT") |
| `MARKET_PSF` (`market.ts`, `rates.ts:118`) | Read-only external reference, "never used as a rate input" (`rates.ts:117`) |

**Blocking state:** dev has exactly one model and it is `DRAFT` (no `CURRENT`
row) — the strategy preview must answer **409 `NO_CURRENT_MODEL`** naming the
branch (never the S$5.64 fallback; brief §3). **PENDING_HANDOFF / owner-confirm:**
that the resolved-KPI choice (vs a new stored target field on the version row)
matches handoff §15; and whether a `PENDING` model counts (brief says CURRENT
only — implemented as CURRENT only).

---

## 3. Promotions — statuses, `accessType`, readers

**Statuses.** `PlanStatus` (`schema.prisma:1183-1189`):
`DRAFT | VALIDATED | SCHEDULED | ACTIVE | ENDED`. Lifecycle
`DRAFT → VALIDATED → SCHEDULED → ACTIVE → ENDED` (`src/core/promotionPlans.ts:
513-545`); editable content = `DRAFT, VALIDATED` only
(`EDITABLE_PLAN_STATUSES`, `promotionPlans.ts:17`); scheduler auto-transitions
due `SCHEDULED ↔ ACTIVE` and expires to `ENDED` (`promotionPlans.ts:461-481`).
**Active (selectable in strategy preview) = `ACTIVE` only.** **Draft
(preview-only) = `DRAFT` (+ `VALIDATED`).** `SCHEDULED` (future-effective) is
preview-only until its `effectiveFrom` — **PENDING_HANDOFF** whether the handoff
wants SCHEDULED selectable ahead of go-live. Dev counts (read-only): 1×`DRAFT`,
1×`SCHEDULED`, 1×`ACTIVE`.

**`accessType`.** `DiscountMatrixCell.accessType` (`schema.prisma:1279`) is a
free-text String; the only values in code, seed, and dev data are **`"Standard"`**
and **`"Ground floor"`** (dev distinct values confirm both; builder authors
`Standard` only — `src/cms/admin/admin.js:3797-3801`; `"Ground floor"` is legacy
read-only per `docs/PROMOTIONS_SPEC.md:135`). Canonical size categories
(`promotionPlans.ts:30`): `LOCKER, XS, SMALL, MEDIUM, LARGE, XL, XXL`.
Mapping for §15: **"Standard unit" → `accessType = 'Standard'`**;
**"Premium access / ground floor" → `accessType = 'Ground floor'`**.
(The legacy S/M/L aliases map via `toCanonicalSizeCategory`,
`promotionPlans.ts:43-46`; `XLBIZ → XL`.)

**Readers** (every consumer the strategy engine's read-only promotion fetch must
stay consistent with):

- `src/core/promotionPlans.ts` — all CRUD + `validatePlan`, `duplicatePlan`,
  `recordRedemption`, `listActivePublicPromotionPlans` (`:203-1351`)
- `src/core/promotions.ts:286,348-371` — `validatePromotion` (ACTIVE + window
  check), plan-scope helpers (re-exported from promotionPlans)
- `src/core/customers.ts:7,935-952` — booking totals: `matrixPlans` /
  `freePlans` queries (ACTIVE + scope + date window)
- `src/routes/cms.ts:4322-4444` — all `/promotion-plans*`, `/safeguards` routes;
  `src/routes/public.ts:122-175` — public validate + active-matrix tiles
- `src/lib/openapi.ts:5406-5443` (`PublicPromotionPlanCell.accessType` etc.)
- CMS admin: `admin.js:2693-2900` (matrix builder), `financeWorkspace.js`
  (perf), `leadsWorkspace.js` (quote promo attach)
- Free-month truth for billing: `rentChargedOn()` (`finance/billing.ts:629`,
  re-exported via `customerProfile.ts:21,287`), `FreeMonthAllocation` rows read
  in `promotionPlans.ts` free-month paths + `customers.ts:952`

---

## 4. §5 Track B models vs `schema.prisma` + R16 backfill design

### 4a. What is new (nothing exists)

`grep RateStrategy|UnitRateBatch` across repo → **no matches**. §5 Track B is
entirely additive:

| Brief model | Schema delta |
|---|---|
| `RateStrategy` | New table: `id, branchId→Branch, name, owner, currentVersionId?, createdAt, updatedAt` |
| `RateStrategyVersion` | New table: scalar levers as typed columns (`referenceSize Int, startingRate Decimal(10,2), method String(SMOOTH\|STEP), curveStrength Decimal, stepEvery Int, stepPsf Decimal(10,4), psfFloor Decimal(10,4), minMonthly Decimal(10,2), {locker,groundFloor,restricted,facility}Adj Decimal, rounding Int, status String, effectiveFrom @db.Date, financialModelId?, financialModelVersion?, targetPsf Decimal(10,4)?, validation Json?, warningOverride Json?, submittedBy/At, approvedBy/At, rejectedBy/At, rejectReason, originVersionId?, version Int, createdBy, …`), `categoryFloors Json, sizeOverrides Json, previewSelection Json`; `@@unique([strategyId, versionNo])`. Status as **String + app-level allowed set** (repo precedent: `FinancialModel.status` String, `schema.prisma:2098`) — or a new Prisma enum; B2 to decide, additive either way |
| `UnitRateBatch` | New table: `ref @unique` (`RATE-`+digits, cuid-style human ref per repo convention), `versionId, branchId, effectiveDate @db.Date, conflictRule String (PRESERVE_MANUAL\|REPLACE_MANUAL\|CANCEL_IF_MANUAL), status String (SCHEDULED\|APPLYING\|APPLIED\|PARTIALLY_FAILED\|FAILED\|CANCELLED), unitCount, sizeCount, idempotencyKey @unique, createdBy, appliedBy?, appliedAt?, …` |
| `UnitRateBatchLine` | New table: `batchId, unitId, sizePoint Int, previousRack/current… (Decimal(10,2)), proposedRack Decimal(10,2), outcome String (APPLIED\|PRESERVED_MANUAL\|SKIPPED_OCCUPIED\|FAILED\|PENDING), conflictReason?, appliedAt?` |
| `Unit` | **+2 columns only:** `rateSource String @default("LEGACY")`, `restrictedAccess Boolean @default(false)` — both backfilled/defaulted so existing rows are valid without a data migration |

Reuse (do not reinvent): `version` CAS pattern (`FinancialModel.version`,
`assertFreshVersion` → 409 `STALE`); `idempotencyKey @unique` pattern
(`Invoice`, `PaymentInstruction`, `Refund`); `FinanceAuditEvent` +
`FinanceEvent` outbox in the same transaction.

### 4b. R16 backfill design (counted, read-only, dev DB `storelah`, 2026-11-18)

`RateChange` rows: **9 total — `Faisal Z.` 8, `System` 1.**
R16 rule: `MANUAL` where a `RateChange` exists for the unit with non-`'System'`
`appliedBy`, else `LEGACY`. Applied to dev: **8 units → `MANUAL`, remainder →
`LEGACY`** (the single `'System'` row behaves as non-manual under the rule).

Design for B2 migration (idempotent, UPDATE-only):
`UPDATE "Unit" SET "rateSource" = 'MANUAL' WHERE EXISTS (SELECT 1 FROM
"RateChange" rc WHERE rc."unitId" = "Unit"."id" AND rc."appliedBy" <> 'System')`
— all other units keep the column default `'LEGACY'`. Going forward:
`adjustRate()` sets `MANUAL` (B2 edits `rates.ts:24-36` to stamp it);
floor-plan sync sets `MANUAL`; batch apply sets `STRATEGY`.
**Caveat (recorded, not solved here):** `appliedBy` is free text
(`rates.ts:34-35`, `unitSizeSync.ts:234`); any future writer using literally
`'System'` would misclassify — B2 should either reserve the value or switch the
check to `appliedBy NOT IN ('System') AND source <> 'BATCH'`; flagged for B2,
default stays per brief.

---

## 5. §6 `facility-rate-strategy` vs RBAC + seeded-role proposal

**Current state:** resource does **not** exist (`src/lib/permissions.ts:36-115`
has no `facility-rate-strategy`; `customer-moveouts` is RU-only, no
`customer-transfers`/`settings-moveouts` either — all Track A/B additions).
`ROUTE_PERMISSIONS` (`src/lib/routePermissions.ts:1-494`) is deny-by-default;
`tests/e2e/cms-rbac.test.ts` fails on any unlisted route.

**Proposed resource** (do NOT apply in P0): `{ key: 'facility-rate-strategy',
label: 'Master Rate Strategy', group: 'Facilities', actions: ['view','create',
'update','approve'] }` (`RCUA`).

**Proposed seeded-role defaults** (proposal only — `SYSTEM_ROLES`,
`permissions.ts:231-290`, + `ensureSystemRoles()` in `src/core/users.ts`
untouched in P0):

| Role | Grants | Rationale |
|---|---|---|
| Owner | all (implicit) | Locked role holds every permission |
| Manager | `view, create, update` (no `approve`) | Day-to-day strategy work; approval stays segregated (maker-checker: approver ≠ submitter enforced in service code) |
| Finance Operator | `view` | Visibility for target-PSF reconciliation; no edits |
| Finance Approver | `view` | Same; approvals live with operations Owner/Manager chain per brief §6 |
| Finance Auditor | `view` | Read-only like all finance areas |
| Investor | — (hidden) | Rate levers are not investor-surface (mirrors `bill-investor` isolation) |
| Viewer | `view` (or hidden — owner call) | Read-only; hidden by default preferred, consistent with finance hiding (`VIEWER_HIDDEN`, `permissions.ts:179-183`) |

**Apply-batch rule:** `POST …/batches/:id/apply` requires
`facility-rate-strategy:approve` **AND** `facility-units:update` (checked in
service code, not just route table, since it writes `Unit.monthlyRate`).
**D9 authority (open question):** `REPLACE_MANUAL` (overwrite operator-manual
rates) requires Owner — i.e. holder of the Owner role (or, if generalised, a
dedicated `facility-rate-strategy:approve` + Owner-role check; recommended:
Owner-only, decided with D9).

**Planned new CMS routes** (all under `/api/v1/cms`, Bearer JWT, into
`ROUTE_PERMISSIONS` + `openapi.ts`; `/:id` after literals):
`GET/POST /facilities/:branchId/rate-strategy` (view / create),
`GET /facilities/:branchId/rate-strategy/versions` (view),
`POST /rate-strategy/:id/submit|approve|reject` (update / approve / approve),
`GET /rate-strategy/:id/preview` (view, blocking `NO_CURRENT_MODEL` state),
`POST /rate-strategy/:id/duplicate` (create),
`GET /rate-strategy/library` (view),
`POST /rate-strategy/:id/batches` (approve, idempotency key),
`POST /rate-batches/:id/apply|retry-failed|cancel` (approve + units:update
for apply; approve for retry/cancel).

---

## 6. §8 deferred items relevant to Track B

State in B-phase plans as out-of-scope (brief §8, Track B slice): **file/evidence
upload service** (strategy evidence = text references in v1); **physical
access-gate integration** (no gate writes from rate batches);
**general-ledger account mapping** (§26 item 10 — rate batches post rack rates
only, no GL postings); **facility-level notice overrides** (n/a to rates);
**queued/async processing UI** beyond a short `Processing` state (batch apply is
synchronous per-batch; future-dated batches use idempotent `applyDueRateBatches()`
until D10 scheduler exists). (d11 promotion persistence is a **decision**, kept
in D11 below — not a deferral.)

---

## 7. Owner decisions D9–D13 (open — no answers, for the orchestrator)

| # | Decision | Recommended default (brief §9) | Blocks |
|---|---|---|---|
| D9 | Rate-batch scope (§26.12) + manual-rate authority (§26.13) | `AVAILABLE` units only (R17); **Replace-manual requires Owner** | B3 |
| D10 | Scheduler for future-dated batches (no cron on Lambda) | v1 manual **Apply due batches** (`applyDueRateBatches()`); daily EventBridge later as devops step | B3 |
| D11 | Promotion preview persistence (§26.11) | Save referenced plan ids + versions on the strategy version (reproducibility) | B2 |
| D12 | Approval thresholds (§26.14) | No numeric thresholds in v1; all warnings need a reason | B3 |
| D13 | Sizes over 150 sq ft (§26.15) | R15: extend schedule to largest stocked size under XL; flag sizes >150 in the report | B1 |

---

## 8. Baseline: `pnpm test:e2e` (this worktree, 2026-11-18)

- `pnpm check` (`tsc --noEmit`): **passes** (after `pnpm exec prisma generate`).
- Command: `DATABASE_URL_TEST=…/storelah_rstrategy_test pnpm vitest run
  --no-file-parallelism --maxWorkers=1` (isolated DB — see Note; suite fails
  identically on shared `storelah_test` when quiet).
- Result: **616/642 pass; 26 fail in 2 files** (`57 passed | 2 failed` files):
  - `tests/e2e/finance-phase3.test.ts` — **6 fail** (all submit/webhook retry
    paths): `charge.retry-same-key`, `webhook.duplicate-delivery-single-paid`,
    `queued charge via signed webhook`, `charge.failed-retry-recovery`,
    `charge.outage-queues`, `partial receipt`. Error: `POST …/retry → 409
    MANDATE_REQUIRED` ("no default saved card"). Approve (DB-only wallet-link
    check, `payments.ts:311-314`) passes; submit's card resolution
    (`payments.ts:424` → `savedCards.ts:217-240`) resolves null in the submit
    path although the Stripe mock is installed and fake wallet state is healthy
    (probed in-test). Mechanism not isolated — flagged for B3; finance charging
    shares no code path with rate strategy except audit/event helpers.
  - `tests/e2e/finance-phase4.test.ts` — **20/20 fail**: `seedWorld()` looks up
    `prisma.branch.findUnique({ where: { code: 'SW' } })` (`:40-41`) but the
    world seeds branch `SS` (`fixtures.ts:PIN.branchCode`) since the SW→SS
    rename (`d4f0eec`) — throws `[e2e] move-in world not seeded` before any
    assertion. Test bug, pre-existing on this base commit.
- **Update vs last known:** the "one pre-existing finance-phase4 failure"
  (reconciliation `close-checklist`, per decisions log) is now **26 failures
  (6 phase3 + 20 phase4)** on base `7c16f71`. The phase4 `close-checklist` test
  itself still fails (listed above) but is masked by the seed bug. Worktree is
  code-clean (`git status` clean apart from this doc), so this is the base
  commit's behaviour, not Track B drift. Re-verify before B1.

## Appendix — R14 prototype behaviours explicitly NOT copied

Per brief R14, the following v55 behaviours must not be ported (listed here so
B-phase plans avoid them): `workflowStatus()` returning *Settlement review*
for a zero settlement (handoff: *Completed*) and *Refund processing* for an
approved **charge** (handoff: *Charge processing*); Blended values named
`effective*` (§15.15 — use `rack*`, `effective*` = after percentage,
`blended*` = with free months); hard-coded facility inventories, promotions,
users and the S$5.64 target; browser-generated refs (server mints `RATE-…`).

## Appendix — §18 event types to add (proposal)

Existing `FINANCE_EVENT_TYPES` (`src/core/finance/events.ts:16-57`) cover
model/budget/invoice/payment/credit/refund/reconciliation/month-close/export.
Track B adds (naming follows the `entity.verb` convention; final list to confirm
against handoff §18 in B3): `rate.strategy.created`, `rate.strategy.updated`,
`rate.strategy.submitted`, `rate.strategy.approved`, `rate.strategy.rejected`,
`rate.strategy.superseded`, `rate.strategy.duplicated`,
`rate.batch.created`, `rate.batch.applied`, `rate.batch.partially_applied`,
`rate.batch.failed`, `rate.batch.cancelled`, `rate.batch.retried`,
`rate.unit.preserved_manual`, `rate.due_batches.applied`.

---

# As-built record — B1–B5 (Track B close-out, 2026-11-18, branch `feature/52-master-rate-strategy`)

P0 above was the design note. This section records what was actually built.
Handoff = `docs/pricing/HANDOFF_2026-11-18.md` (Track B copy). No customer or
public API shapes were changed at any phase; money stays integer cents in
transit / `Decimal` in storage with `toNum` at the boundary (4dp via
`toNum(x, 4)` for Decimal(10,4) PSF levers — the B3 2dp truncation bug is
fixed at every 4dp read site).

## B1 — pure engine (`src/core/pricing/rateStrategy.ts`, 774 lines)

DB/clock-free. `previewFacility()` is the single code path preview and apply
share (server-is-authoritative). Terminology per R14: `rack*` pre-promotion,
`effective*` after percentage discounts, `blended*` with free months spread.
`combineDiscounts` = 1 − Π(1 − d). Solver `solveRequiredBaseRate` is
integer-cent bisection. D12: validation has blockers vs warnings only — no
numeric magnitude ever blocks; every warning carries a mandatory `reason`.
D13: `scheduleMaxFor` = max(150, largest stocked size); `categoryForSize`
maps sizes >150 to XL; `sizesAboveRange` flags stocked sizes >150 as the
`SIZE_ABOVE_RANGE` warning. `isBatchEligibleUnit` = AVAILABLE only (R17).
Tests: `tests/e2e/rate-strategy.test.ts` — §21 rate 1–18 + §15.16/§15.17
hand-derived worked examples + D11/D12/D13 engine observables.

## B2 — schema (migration `20261118000000_rate_strategy_b2`, additive only)

4 tables (`RateStrategy`, `RateStrategyVersion`, `UnitRateBatch`,
`UnitRateBatchLine`), 5 enums (`RateStrategyStatus`, `RateStrategyMethod`,
`RateBatchStatus`, `RateBatchConflictRule`, `RateBatchLineOutcome`), +2
`Unit` columns (`rateSource` String default `'LEGACY'` — plain String, not an
enum, so future provenance values stay additive; `restrictedAccess` Boolean
default false). R16 backfill (idempotent, UPDATE-only): `MANUAL` where a
`RateChange` exists with non-`'System'` `appliedBy`, else `LEGACY`.
Seeded-role grants for `facility-rate-strategy` in the same migration
(Owner full; Manager view/create/update, deny approve; Finance roles +
Auditor view; Viewer hidden). B5 follow-up in seed only: `prisma/seed.ts`
stamps `SS-01-01` MANUAL (its operator `Faisal Z.` RateChange row postdates
the backfill on fresh DBs). `Unit.restrictedAccess` is operator-editable via
Units create/update forms; `rateSource` is system-stamped only (never an
operator input). `facilityScope` extension covers the new models
(`RateStrategy`/`UnitRateBatch` direct; versions via strategy, lines via
batch). `src/lib/openapi.ts` intentionally untouched (no-entry precedent).

## B3 — service + API (`src/core/pricing/rateStrategyService.ts`, 16 routes)

Draft CRUD with optimistic-lock `version` (409 `STALE`); versions immutable
once submitted (DRAFT-only edits); preview/validate read-only with BLOCKING
409 `NO_CURRENT_MODEL` naming the branch (CURRENT-model KPI
`weightedStartPsf` as target, never DRAFT, never fallback — reference
5.6384); submit requires one warning reason per warning (409
`WARNING_OVERRIDE_REQUIRED`); approve/reject are maker-checker (approver ≠
submitter, 403 `SELF_APPROVAL`, no Owner bypass); library list/load;
duplicate with uplift (anchor, floors, minimum, category floors, overrides;
reset to v1 DRAFT, `originVersionId` kept); batch create/apply/retry-failed/
cancel + idempotent `applyDueBatches()` sweep (D10). Batch apply is one
transaction (Unit + RateChange + lines); `Tenant.monthlyRate` is NEVER
touched (R17 — proven by test). R16: PRESERVE_MANUAL preserves MANUAL only;
the apply response lists LEGACY units separately (`legacyUnits` post-apply;
per-line live `rateSource` pre- and post-apply since B5). R15: inventory
read live from Units (`Math.round(sqft)`, `LOCKER` code, lowest active floor
level, `restrictedAccess`); promotions read-only (ACTIVE default,
DRAFT/VALIDATED/SCHEDULED preview-only when explicitly selected, ENDED
never); D11: version stores planId + planVersion refs, re-resolved at submit.
Audit (`RATE_STRATEGY_*` / `RATE_BATCH_*`) + §18 events in the same
transaction — all 15 proposed event types shipped, plus `rate.batch.retried`.

Routes (all `/api/v1/cms`, Bearer JWT, all in `ROUTE_PERMISSIONS`; apply
family additionally requires `facility-units:update` in service code since
one route carries one permission):

| Route | Permission |
|---|---|
| `GET /rate-strategy/library` | `facility-rate-strategy:view` |
| `POST /facilities/:branchId/rate-strategy` | `:create` |
| `GET /rate-strategy/:id` · `PATCH /rate-strategy/:id` | `:view` · `:update` + CAS `version` |
| `GET /rate-strategy/:id/preview` · `POST /rate-strategy/:id/validate` | `:view` |
| `POST /rate-strategy/:id/submit` | `:update` + CAS |
| `POST /rate-strategy/:id/approve` · `/reject` | `:approve` + CAS, maker-checker |
| `POST /rate-strategy/:id/duplicate` | `:create` |
| `POST /rate-strategy/:id/batches` | `:approve` (+Owner for REPLACE_MANUAL) + idempotency key |
| `GET /rate-batches` · `GET /rate-batches/:id` | `:view` |
| `POST /rate-batches/:id/apply` · `/retry-failed` · `/cancel` | `:approve` (+units:update; +Owner for REPLACE) |
| `POST /units/rate-batches/apply-due` | `:approve` (+units:update) |

D9: REPLACE_MANUAL requires the Owner role, checked at create AND re-checked
at apply. CANCEL_IF_MANUAL cancels the whole batch before any write and the
apply answers 409 `MANUAL_RATES_EXIST`. Batch refs are server-minted
(`RATE-…`, never browser-built).

## B4 — CMS UI (`src/cms/admin/rateStrategyView.js`, self-mounted)

Facilities › Master rate strategy: list (branch/status filters, empty state),
detail (lever summary, preview with 1/3/6/12 + matrix filters, category
table, unit-rate table with range filter + override modal, validation modal),
submit/approve/reject with maker-checker note data, library + duplicate with
uplift, scheduler (batch list filters, batch detail with per-unit lines,
run-now, retry, cancel), Units banner **Open rate strategy** + **Apply due
batches**, Global Settings `ratestrategy.*` defaults surface (`defaultRounding`,
`defaultConflictRule` in `businessRules.ts` — UI defaults only, server
validation unchanged). Permission-gated per action; schedule/apply buttons
only for APPROVED/ACTIVE versions. Calls ONLY the B3 routes (listed in the
file header). Tests: `tests/e2e/rate-strategy-ui.test.ts` (API-level contract
for every UI-called route).

## B5 — close-out (this phase)

Legacy/manual-rate paths, per D12 (no thresholds) + D13 (max(150, largest
stocked)) and the brief/handoff rules for superseded paths:

- `adjustRate()` (operator rate change) stamps MANUAL — B2, kept.
- **Floor-plan publish sync (`src/core/unitSizeSync.ts`) stamps MANUAL when
  it changes the rate** — the last unstamped manual-rate path (B5 fix).
  KEEP_RATE / equal recomputes keep existing provenance; only real rate
  changes stamp. `retier-units.ts` needs nothing (never touches monthlyRate).
- **Apply refuses versions that are no longer APPROVED/ACTIVE** (409
  `NOT_APPROVED`) — handoff §27 "Only approved, saved rate versions can
  update Units", §15.25. Guards apply, retry-failed and the due-batch sweep.
- **CANCEL_IF_MANUAL 409 now carries the cancelled batch in
  `error.details.batch`** (the HTTP envelope drops custom error props, so
  UI-called routes previously lost it).
- **Due-batch sweep no longer fabricates `CANCELLED`** on guard rejections —
  it reports the stored status (B5 bug fix, caught by the new test).
- **Batch lines carry live `rateSource`** — the apply preview lists LEGACY
  units separately from MANUAL ones on SCHEDULED batches too, not just in
  the post-apply record.
- **CMS "Apply now" only renders for due SCHEDULED batches** (future batches
  always answered 409 `NOT_DUE` — the button was a dead end).
- No new routes (nothing added to `routePermissions.ts` / `openapi.ts`), no
  migration (no schema change needed), no customer/public shape changes,
  occupied rents and `Tenant.monthlyRate` untouched throughout (re-proven
  under REPLACE_MANUAL too).

Tests: `tests/e2e/rate-strategy-closeout.test.ts` (6 tests: cancel-if-manual
due + future paths with zero-write proof; replace-manual Owner re-check at
apply + occupied-rent proof; superseded/draft/rejected version guards incl.
sweep skip; idempotent create replay + stale approve + partial-reasons D12;
floor-plan MANUAL/KEEP_RATE stamping; scheduled-line provenance + D13
160-sq-ft-XL S$827 pin). Full suite on isolated `*_test` DBs; only known
pre-existing failures remain (finance-phase3 6 + finance-phase4 20, both
unrelated to Track B — see baseline §8, unchanged).

## Owner decisions D9–D13 — final record

| # | Decision | Built |
|---|---|---|
| D9 | Replace-manual authority | Owner role only, enforced at batch create AND apply (403 otherwise) |
| D10 | Scheduler (no cron on Lambda) | v1 manual **Apply due batches** (`POST /units/rate-batches/apply-due`, idempotent sweep); daily EventBridge rule stays a later devops step |
| D11 | Promotion preview persistence | Version stores planId + planVersion refs; re-resolved at submit; drafts reproducible |
| D12 | Approval thresholds | No numeric thresholds — below-target at ANY magnitude is a warning; every warning needs its own reason (409 otherwise) |
| D13 | Sizes over 150 sq ft | Schedule = 8…max(150, largest stocked); >150 uses XL category + floor; `SIZE_ABOVE_RANGE` warning flags them |

## Deferred / carried forward (not in Track B v1)

EventBridge daily scheduler for due batches (D10 devops step); file/evidence
upload service (strategy evidence = text references); physical access-gate
integration (no gate writes from rate batches); general-ledger mapping (§26
item 10 — batches post rack rates only); facility-level notice overrides
(n/a to rates); queued/async processing UI beyond the short `Processing`
state; a "new version from approved" route (supersede path is coded but
unreachable via API — versions are singletons per strategy today).

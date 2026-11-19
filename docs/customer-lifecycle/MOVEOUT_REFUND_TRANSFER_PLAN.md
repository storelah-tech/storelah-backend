# Track A P0 Design Note — Move-outs, Refunds, Unit Transfers

**Worktree:** `storelah-backend/_worktrees/moveout-refund-transfer` (branch
`feature/51-moveout-refund-transfer`, cut from `main` `7c16f71`).
**Date:** 2026-11-18. **Scope:** Track A only (move-outs / refunds / transfers).
Track B (Master Rate Strategy) is a separate plan and is ignored here except for
shared rules. **No app code, migration, or schema change in this note.**

**Handoff status:** the authoritative handoff
(`StoreLah_Refund_Transfer_Moveout_Rate_Strategy_Developer_Handoff_2026-11-18.md`,
prototype v55) is **not yet in the repo**. Every rule below comes from the
orchestrator brief §§1–6, 8, 9. Anything that depends on handoff-only detail
(§21 test cases, §9.2/§11.5 worked examples, §8 entry-point specifics, §19 copy,
§15 rate-strategy content) is marked **PENDING_HANDOFF** — never guessed.

**Non-negotiables carried forward (brief §2):** additive-only migrations;
money in integer cents / `Prisma.Decimal` (JSON via `toNum`,
`src/lib/format.ts`); server-is-authoritative; `writeAuditEvent` →
`FinanceAuditEvent` + `publishFinanceEvent` on every mutation (new §18 types go
in `FINANCE_EVENT_TYPES`); optimistic locking (`version` + `assertFreshVersion`,
409 `STALE`) and idempotency keys on process-refund / post-charge /
approve-and-post-transfer; customer/public API response shapes unchanged
(anything needing a shape change is a cross-lane stop-and-report); new CMS
routes plan for `routePermissions.ts` + `openapi.ts` registration with `/:id`
after literal siblings.

---

## 1. Brief §3 mapping — confirmed or corrected against the code

| Handoff | Verdict | Code reference |
|---|---|---|
| customer = identity group of Tenant rows sharing normalised email; keep `identityGroup()`, no Customer→Tenant FK | **CONFIRMED** | `src/core/customerProfile.ts:135-142` (`identityGroup()`; groups by `normalizeEmail`, primary-first). No Customer→Tenant FK exists and none is proposed. |
| rental / `rental_id` = one Tenant row (unit, monthlyRate, psf, moveInDate, status) | **CONFIRMED** | `prisma/schema.prisma:727-770` (`Tenant`: `unitId @unique` at :735, `monthlyRate` :737, `psf` :738, `moveInDate` :736, `status` :740). One row per unit is enforced by the unique FK. |
| unit / facility = Unit / Branch (`facility_id` = `branchId`) | **CONFIRMED** | `prisma/schema.prisma:614-658` (`Unit.branchId` :616); `Tenant.branchId` :747 (nullable legacy cache — billing uses the unit's branch, `src/core/finance/billing.ts:697-703`). |
| `move_out_case` (+ date change, inspection, settlement snapshot) | **NEW — does not exist** | Grep for `MoveOutCase\|MoveOutDateChange\|MoveOutInspection` in `prisma/` + `src/` returns zero hits. Proposed: `MoveOutCase`, `MoveOutDateChange`, `MoveOutInspection` per brief §5; settlement snapshot = versioned `calcSnapshot` JSON on the Finance record (R6). |
| `financial_approval_record` + `refund_request` → extend `CustomerSettlement` | **CONFIRMED (exists, needs extension)** | `prisma/schema.prisma:2525-2551`: `ref` (`TRF-/RF-/CH-` + 7 digits) :2527, `kind` :2528, `docType` :2529, `lines` :2538, `amount` (signed; negative = refund) :2539, `status` = `PENDING/APPROVED/REJECTED` :2541. Maker-checker: `decideSettlement()` `src/core/customerProfile.ts:345-357` (409 unless PENDING; 403 when requester == approver; REJECT needs note). **Gap confirmed:** approval changes status only — nothing posts (header comment `src/core/customerProfile.ts:1-14` records owner Q16 as open; the handoff resolves Q16: posting is required). New columns per §5 (`origin`, `moveOutCaseId`, `sourceRef`, `returnMethod`, `reasonCode`, `calcVersion`, `calcSnapshot`, `version`, `idempotencyKey`, `approvedBy/At`, `processedBy/At`, `processorRef`, `postingRef`, `processingError`, `CL-` zero-settlement close records). |
| `approval_change_request` | **NEW** | No `SettlementChangeRequest` in schema or `src/`. |
| `processor_attempt` | **NEW** | No `ProcessorAttempt` in schema or `src/`. Stripe client exists (`src/core/checkout.ts:39-57`, `getStripe()` at :56) and the webhook exact-once guard exists (`ProcessedStripeEvent` `prisma/schema.prisma:917-921`; `claimStripeEvent()` `src/core/finance/events.ts:117-129`; webhook `src/routes/customer.ts:460ff`), but **`stripe.refunds.create` appears nowhere** in `src/` (grep zero hits) — `payRefund()` (`src/core/finance/credits.ts:733-776`) records only a typed `gatewayRef`. |
| `ledger_entry` (customer ledger) | **NEW table; read-model exists** | No `CustomerLedgerEntry` in schema. Today's profile ledger is assembled from invoices + settlements in `src/core/customerProfile.ts:206-222`. D4 decision still open (see §7). |
| `unit_transfer` | **CONFIRMED as designed (no separate table)** | `CustomerSettlement` kind `TRANSFER` + snapshot: `buildSettlement()` TRANSFER branch `src/core/customerProfile.ts:288-304` (destination must be `AVAILABLE`, dest pricing wins). No transfer table exists or is proposed. |
| `rental_unit_history` | **NEW** | No `RentalUnitHistory` in schema or `src/`. Link-loss confirmed: `deactivateTenant()` nulls `unitId` (`src/core/tenants.ts:334-347`); `transitionMoveOut` complete does the same (`src/core/tenants.ts:464-472`). |
| rental status + history | **CONFIRMED, needs additive enum value + new table** | `TenantStatus` `prisma/schema.prisma:36-42` = `ACTIVE/DUE_SOON/OVERDUE/NOTICE/INACTIVE` — **no `SUSPENDED`**. No `RentalStatusChange` in schema or `src/`. R5 editor mapping is new design (status values map; access-restricted is the existing `Tenant.accessRestricted` flag, `prisma/schema.prisma:760-762`). |
| Global move-out policy (`moveout.*`, keep `booking.moveOutNoticeDays`) | **CONFIRMED (exists, needs 5 siblings)** | `BusinessRule` `prisma/schema.prisma:1726-1737`; `booking.moveOutNoticeDays` default 30, integer 0–120 (`src/core/businessRules.ts:72-81`); CMS surface `src/cms/admin/settingsExtView.js:132`. Other five `moveout.*` settings are new design. |
| Financial Model target (recurring effective PSF; ref model 5.6384) | **PENDING_HANDOFF** | Read-only use of latest CURRENT `FinancialModel` is the design; the exact target field must be identified from the handoff (§15). Not verified in code. |
| Promotions (read-only `PromotionPlan` + matrix + free months) | **CONFIRMED (structures exist; mapping partly PENDING_HANDOFF)** | `PromotionPlan` (`status`: `PlanStatus`, default `DRAFT`, `prisma/schema.prisma:1232-1271`), `DiscountMatrixCell.accessType` = `"Ground floor" / "Standard"` (:1279), `FreeMonthAllocation` (:1287-1300). Brief P0 asks which plan statuses + which `accessType` values map to "Standard unit" / "Premium access / ground floor" — **PENDING_HANDOFF** (needs handoff §15 mapping; `accessType` strings are confirmed above). |
| Operations work item / customer timeline (`StaffNotification` + `RecordNote`) | **CONFIRMED** | `RecordNote` (`entityType` lead\|tenant, `mentions` JSON) `prisma/schema.prisma:2490-2500`; `StaffNotification` (`kind`, `entityType/Id`, `actor`) :2502-2516. No new task system. |
| Roles (§4 → permission mapping, "Administrator" = Owner) | **CONFIRMED** | Seeded roles are Owner, Manager, Viewer, Finance Operator, Finance Approver, Finance Auditor, Investor (`src/lib/permissions.ts:231-290`). No Customer Service / Operations / Commercial roles exist. |
| Hash routes (`#moveout-notices`, `#settings-moveouts`, `#facilities` + `facility-rate-strategy`, `#billing` + `bill-transactions`, `#customer-profile` panels) | **PENDING_HANDOFF** | Prototype-only routing; CMS admin shell exists (`src/cms/admin/`). Panel wiring is A7 design against handoff §3/§19. |
| Processor = Stripe test mode via existing client + webhook | **CONFIRMED** | `getStripe()` `src/core/checkout.ts:56-57`; webhook `POST /customer/stripe/webhook` `src/routes/customer.ts:460ff` → `checkout.session.completed` → `markBookingPaidForSession` + `payment_intent.succeeded/failed` → `claimStripeEvent` (`src/core/invoicePayments.ts:379,589`; `src/core/finance/payments.ts:605,668`). |

**Corrections to the brief's line references (re-checked 2026-11-18):**
`calculateMoveOut` is at `src/core/customerProfile.ts:113` ✓,
`calculateTransfer` at `:85` ✓, `identityGroup()` at `:135` ✓ (brief says
"in `customerProfile.ts`" without a line — now pinned), `GET/PATCH /cms/move-outs`
core at `src/core/tenants.ts:420-479` ✓ (list `420-447`, transition `451-479`),
`settingsExtView.js:132` ✓, `businessRules.ts:72` ✓.

---

## 2. Every reader/writer (grep, this worktree)

**`CustomerSettlement`** (`prisma` model :2525-2551)
- Writers: `src/core/customerProfile.ts:333` (`customerSettlement.create` in
  `submitSettlement`), `:352` (`.update` in `decideSettlement`).
- Readers: `src/core/customerProfile.ts:162` (profile query by `tenantIds`),
  `:305-315` (`buildSettlement` reads latest `Notice`, not settlements),
  `:331` (pending-settlement guard), `:347` (decision lookup), `:360`
  (`listSettlements`); `src/core/finance/register.ts:50` (register union).

**`Refund`** (Phase 4 table, `prisma` model :2289-2317)
- Writers: `src/core/finance/credits.ts` — `requestRefund` create `:530-544`
  (+ idempotent replay `:524-529`; negative→charge invoice path `:479-498`),
  `approveRefund` `:591ff`, `rejectRefund` `:650`, `verifyRefundBank`
  `:696-731`, `payRefund` `:749-775` (all `version`-guarded via
  `assertFreshVersion`, maker-checker via `checkChecker` `:575-589`).
- Readers: `credits.ts:411` (`listRefunds`), `:424` (`getRefund`),
  `:593/:652/:697/:735` (per-transition re-reads);
  `src/core/finance/register.ts:49` (register union);
  `src/core/finance/reconciliation.ts:378,407` (refund matching counts);
  `src/core/finance/overview.ts:171` (overview totals).

**`Notice`** (portal submissions, `prisma` model :777-788; doc comment :772-776 —
one row per submission, never auto-flips status)
- Writer (only): `src/core/customers.ts:1467` (`notice.create` in
  `submitCustomerNotice`, `1427-1484`).
- Readers: `src/core/customerProfile.ts:161` (profile `notices`),
  `:305` (latest notice for settlement date/channel lock);
  `src/core/customers.ts:672,685` (portal snapshot);
  `src/core/finance/overview.ts:112` (move-out count).

**`TenantStatus.NOTICE`** (writers vs readers)
- Writers: generic CMS status write `updateTenant`
  (`src/core/tenants.ts:300-328`, `status: input.status` at :312; routes
  `PUT /tenants/:id` `src/routes/cms.ts:327ff` + bulk `src/routes/cms.ts:434ff`
  accept `ACTIVE/DUE_SOON/OVERDUE/NOTICE`, `src/routes/cms.ts:436,448`). Portal
  never writes NOTICE (explicit: `src/core/customers.ts:493` comment).
  Seed writes no NOTICE rows (grep `NOTICE` in `prisma/seed.ts` = zero hits).
- Readers/gates: `listMoveOuts` (`tenants.ts:420-447`, `where: {status:'NOTICE'}`),
  `transitionMoveOut` guard (`tenants.ts:457-462`, 409 unless NOTICE);
  openapi docs (`src/lib/openapi.ts:4242-4258,5964`);
  investor/overview occupied-set filters include NOTICE
  (`src/core/finance/investor.ts:72`, `src/core/finance/overview.ts:103`).

**`Unit.monthlyRate`** (rack rate)
- Writers: CMS unit create/update (`src/routes/cms.ts:327,353,1360,1373,3819`
  validation; core `src/core/units.ts` + `adjustRate` internals in
  `src/core/rates.ts:20-42` — writes `monthlyRate` **and** a `RateChange` row).
- Readers (non-exhaustive): `src/core/rates.ts:73-103` (MRR/PSF aggregates);
  `src/core/customerProfile.ts:195` (`grossRent: toNum(g.unit!.monthlyRate)`);
  `src/core/quotes.ts:53-57,187`; `src/core/promotionPlans.ts:846-933`.
  Tenant contracted rent (`Tenant.monthlyRate`) is separate — R17 reiterates
  it is never touched by rate batches.

**`deactivateTenant`**
- Defined `src/core/tenants.ts:334-347` (sets `INACTIVE`, nulls `unitId`,
  releases unit to `AVAILABLE`).
- Callers: `DELETE /tenants/:id` (`src/routes/cms.ts:835`);
  referenced for release-semantics parity in `src/core/tenants.ts:220,316`
  and `src/core/customers.ts:1162-1165`; covered by
  `tests/e2e/tenant-unit-hold.test.ts:7,62`.

---

## 3. Brief §5 (Track A) vs `prisma/schema.prisma` — delta + counts + remap

### 3a. Exists / new

| §5 element | State |
|---|---|
| `TenantStatus.SUSPENDED` | NEW enum value. Precedent for additive enum migration: `InvoiceStatus` Phase 3 values via create-and-swap (`prisma/schema.prisma:60-73` comment). |
| `MoveOutCase` (incl. `caseNumber` `MO-#######`, 7 statuses, `policySnapshot`, `settlementId? @unique`, `noticeId?`, reversal fields, `version`) | NEW model. Status is `String` per brief (not an enum) — keep as `String` with a code-level allow-list. |
| `MoveOutDateChange` | NEW model. |
| `MoveOutInspection` (incl. `Decimal(10,2)` charge fields, `caseId @unique`, `version`) | NEW model. |
| `CustomerSettlement` extensions (`origin`, `moveOutCaseId`, `sourceRef`, `reasonCode`, `returnMethod`, `calcVersion`, `calcSnapshot`, `version`, `idempotencyKey? @unique`, `approvedBy/At`, `processedBy/At`, `processorRef`, `postingRef`, `processingError`) | ADDITIVE columns, **all nullable or defaulted**. |
| `CustomerSettlement.status` new values (`PENDING_APPROVAL\|CHANGES_REQUESTED\|APPROVED\|PROCESSING\|REFUNDED\|POSTED\|FAILED\|CANCELLED`) | Status is already `String` (`:2541`), so **no DB enum change** — values change in code + data remap. |
| `SettlementChangeRequest`, `ProcessorAttempt` (own `idempotencyKey @unique`), `CustomerLedgerEntry` (append-only; `reversalOfId?`, `processorRef?`), `RentalUnitHistory`, `RentalStatusChange` | NEW models. `CustomerLedgerEntry`/`RentalStatusChange` follow the append-only precedent (`CreditLedgerEntry` :2267-2280, `FinanceAuditEvent` :2040-2060 — both have no update/delete path). |
| Track B models (`RateStrategy`, `RateStrategyVersion`, `UnitRateBatch`, `UnitRateBatchLine`, `Unit.rateSource`, `Unit.restrictedAccess`) | Out of scope for Track A — named here only so the Track A migration does not collide (both tracks edit `schema.prisma`; merge A first per brief §2.1). |

### 3b. Legacy `CustomerSettlement.status` remap + row counts

Read-only counts on the local dev DB **`storelah`** (Postgres `localhost:5433`,
container `storelah-postgres`, 2026-11-18):

| Table | Rows by status |
|---|---|
| `CustomerSettlement` | **0 rows** (table empty) |
| `Refund` | **0 rows** (table empty) |
| `Notice` | 1 row |
| `Tenant` | 326 rows, all `ACTIVE` (0 on `NOTICE`) |

Proposed remap (A2 migration data step; **proposal — confirm in A2**):
`PENDING → PENDING_APPROVAL`, `APPROVED → APPROVED`, `REJECTED → CHANGES_REQUESTED`
(rejected settlements carry a decision note saying what must change, i.e.
change-request semantics — `decideSettlement`, `src/core/customerProfile.ts:351-356`).
**Semantic flag:** legacy `APPROVED` was terminal (nothing posted), while new
`APPROVED` means approved-but-not-yet-processed; A2 must state whether legacy
`APPROVED` rows become `POSTED` (nothing was ever posted — the handoff resolves
Q16 by requiring posting) or stay `APPROVED` and flow through processing.
**Idempotency:** the step is UPDATE-only (`UPDATE … WHERE status IN
('PENDING','APPROVED','REJECTED')`); a re-run matches zero rows and is a no-op.
On the current dev DB it is trivially idempotent (zero rows to remap). Prod
counts are a P9 rollout step, not done here — no prod access from this lane.

---

## 4. Brief §6 (Track A resources) vs `permissions.ts` / `routePermissions.ts` / seeded roles

| Resource | Code state | Plan |
|---|---|---|
| `customer-moveouts` (exists, RU) → `view, create, update, approve` | **CONFIRMED exists as RU** (`src/lib/permissions.ts:51`). Route `GET /move-outs` → `customer-moveouts:view`, `PATCH /move-outs/:tenantId` → `customer-moveouts:update` (`src/lib/routePermissions.ts:90-91`). | Widen actions to `view, create, update, approve` (create/change/reverse = create/update; complete inspection = update; approval step = approve). |
| `customer-transfers` (new, `view, create, update`) | **CONFIRMED absent** (zero hits in `permissions.ts` / `routePermissions.ts`). | New resource; wire preview/submit/correct routes. |
| `customer-tenants:update` (exists) | **CONFIRMED** (`PUT /tenants/:id` → `customer-tenants:update`, `src/lib/routePermissions.ts:84`). | Rental status editor reuses it; no new resource. |
| `bill-transactions` approval rule (manual refund create = create; request changes = update; approve = approve; **process/post/approve-and-post = approve + actor ≠ requester and ≠ approver**) | **CONFIRMED exists as view/create/update/approve** (`src/lib/permissions.ts:82`); routes for settlements approve/reject + transactions approve/retry/cancel exist (`src/lib/routePermissions.ts:114-117,239-244`). Maker-checker precedent exists in code (`decideSettlement` 403, `customerProfile.ts:350`; `checkChecker` for refunds, `credits.ts:575-589`). The process/post actor-separation rule is **new design** (extends the precedent to a three-party separation). | Enforce in `src/core/` service code, not RBAC (per finance brief §3). |
| `settings-moveouts` (new, `view, update`) | **CONFIRMED absent** (zero hits). Seeded settings resources today: `settings-general/booking/lead-sla/fees/facilities` (`permissions.ts:110-114`). | New resource for Global Settings › Move-outs & refunds. |

**Seeded-role default grants (proposal — do not edit yet):**
Owner holds everything automatically (locked `ALL_PERMISSIONS`,
`permissions.ts:237`). Finance Operator +=
`customer-moveouts:view/update`, `customer-transfers:view/create/update`,
`settings-moveouts:view`, `bill-transactions:create/update` (already held);
Finance Approver += the above + `customer-moveouts:approve`,
`bill-transactions:approve` (already held), `settings-moveouts:update`
(decision: approver or Owner-only for policy edits — ties to D1/D2, see §7).
Manager: deny all four new grants by default (consistent with `MANAGER_DENY`
stripping finance + approvals, `permissions.ts:144-178`); Viewer: hide all four
(consistent with `VIEWER_HIDDEN`, `:179-183`). Facility scope
(`OperatorFacilityAccess`) applies to every new list/mutation — enforced in
service code via the existing `facilityScope` helper pattern.

**Registration debt to close in A2/A3:** `GET /finance/settlements`,
`POST /finance/settlements/:id/approve|reject`, `GET /finance/register` are in
`routePermissions.ts` (`:114-117`) but have **no `openapi.ts` entries** (grep
`settlements|finance/register` in `src/lib/openapi.ts` = zero hits; move-outs
entries exist at `openapi.ts:4239-4258`). New Track A routes must be added to
both, with `/:id` routes after literal siblings (brief §2.5).

---

## 5. R2 verification + portal/customer response-shape freeze

**R2 claim — CONFIRMED for the first half:** `submitCustomerNotice()` keeps
writing `Notice` — sole writer `src/core/customers.ts:1467` (one row per
submission, history preserved); response shape is
`{ status: 'SUBMITTED', lastDay, id, unitId, unitCode, submittedAt }`
(`src/core/customers.ts:1476-1484`), served by `POST /customer/notice`
(`src/routes/customer.ts:337-344`, zod `noticeSchema`). Byte-shape tests:
`tests/e2e/portal-invoices.test.ts:294-308`
(`toMatchObject({ status: 'SUBMITTED', unitCode })`) and
`tests/e2e/portal-requests-notices.test.ts:99-133` (latest-notice-per-unit,
`notices[]` shape). A3 must add the byte-identical regression test R2
requires; **the case-creation / date-change / channel-lock half of R2 is new
design** (no `MoveOutCase` exists).

**Files that MUST NOT change shape (customer/portal freeze):**
`src/routes/customer.ts` (portal, notice, invoices, checkout, saved-cards,
Stripe webhook), `src/core/customers.ts` (identity, portal snapshot, notice
submit), `src/core/invoicePayments.ts` + `src/core/savedCards.ts` +
`src/core/checkout.ts` (portal pay paths; webhook truth), `src/lib/openapi.ts`
customer section incl. `data.notice`/`data.notices` schema (`:1897-2283`,
`:5929-6079`), and the_invoice lifecycle mapping the portal depends on
(`Invoice.status ∈ {PAID, DUE, OVERDUE}` + customer JSON — finance-brief guard).
Portal e2e covering these: `portal-invoices`, `portal-requests-notices`,
`portal-saved-cards(-stripe)`, `customers-prototype-delta`
(move-out/transfer settlement expectations incl. the $37.11 / $106.67 / −$43.33
regressions), `billing-free-months` (free-month S$0 rule).

---

## 6. Brief §8 deferred items — out of scope for Track A (verbatim)

1. E-signature for transfer amendments (handoff §26 item 7).
2. File/evidence upload service (evidence = text references in v1).
3. Physical access-gate integration.
4. General-ledger account mapping (§26 item 10).
5. Facility-level notice overrides.
6. Queued/async processing UI beyond a short `Processing` state.

---

## 7. Owner decisions D1–D8 + D14 — open questions for the orchestrator (no answers here)

| # | Decision | Why it needs asking | Recommended (brief) | Blocks |
|---|---|---|---|---|
| D1 | Notice policy scope (§26.1) | Global vs facility/agreement override | Global only in v1 | A2 |
| D2 | Policy change effect (§26.2) | Recalculate open cases or not | Snapshot at request (R7) | A3 |
| D3 | Home of manual refunds | Phase 4 `Refund` (bank-verify, bypass) vs canonical `CustomerSettlement` | New manual refunds on `CustomerSettlement`; old `Refund` rows read-only in the register | A4 |
| D4 | Ledger model | Handoff wants append-only ledger; today the ledger is built from invoices | `CustomerLedgerEntry` for refunds/credits/transfers; charges post as issued `Invoice` (so saved-card works) and mirror a ledger line | A4 |
| D5 | Self-approval (§26.5) | Existing settlements forbid requester = approver; Owner bypass exists for refunds | No self-approval; Owner bypass with reason, audited | A4 |
| D6 | Processor per return method (§26.8/9) | No Stripe refund code exists | Original method → Stripe refund on source PaymentIntent (test mode); bank transfer → Finance-recorded instruction + bank-verify; account credit → `CreditWallet` GRANT; negative transfer adjustment → account credit | A4, A5 |
| D7 | Early-termination charge (§26.4) | Automated from commitment vs entered | Entered at inspection in v1; commitment end shown for reference | A3 |
| D8 | Destination reservation (§26.6) | Holding a unit vs revalidation | R10: no hold, revalidate at posting (409 → `CHANGES_REQUESTED`) | A5 |
| D14 | Retire legacy move-out actions | `PATCH /move-outs/:tenantId` complete/cancel bypasses inspection | Retire (410 + pointer); CMS buttons route to canonical flow | A3 |

(D9–D13 are Track B and are not listed here.)

---

## 8. Baseline — `pnpm test:e2e` (this worktree, clean checkout `7c16f71`)

**Command:** `pnpm exec vitest run tests/e2e --pool=forks --maxWorkers=1
--no-file-parallelism` (sequential; the config's `fileParallelism: false`
alone did not prevent cross-file DB races in the first attempt).
**Run:** 2026-11-18 ~10:50–10:55 SGT against `storelah_test` on
`localhost:5433`. **Result: 56/59 files pass, 599/642 tests pass.**
Failing files (worktree is untouched — all failures are pre-existing on
`7c16f71`, none caused by this note):

| File | Failures | Cause (verified) |
|---|---|---|
| `finance-phase4.test.ts` | 20/20 | Deterministic: `seedWorld` looks up branch code `'SW'` (`:40`) but the seed/fixtures world is `'SS'` (`prisma/seed.ts:180`, `fixtures.ts` PIN) after the SW→SS rename — every test throws `[e2e] move-in world not seeded`. Brief's "one pre-existing finance-phase4 failure" is stale; the whole file fails. |
| `floor-plan-unit-sync.test.ts` | 17/47 in the shared-DB run; **0 in an isolated re-run** (2026-11-18 ~11:00, quiet DB: file passes fully) | Contention artifact of two worktrees sharing `storelah_test` (see environment notes), not a code failure. Proves the sharing hazard is real. |
| `finance-phase3.test.ts` | 6/18, **same 6 in the isolated re-run** | Genuine pre-existing drift (e.g. `charge.retry-same-key` expects 200, gets 409; downstream `paymentIntentId` undefined cascade). Needs triage in A4 (do not silently fix — record expected-vs-actual). |

**Environment notes (all observed, all flagged):**
- `pnpm check` (`tsc --noEmit`) **passes** clean on this worktree.
- The dev-DB container `storelah-postgres` (host port 5433) was **down
  mid-baseline** (connection refused ~10:32); restarted with
  `docker start storelah-postgres` — dev counts re-verified afterwards
  (326 tenants, 1 notice). No data action was taken beyond the restart.
- **Test-DB sharing hazard:** this worktree has no `.env`, so e2e falls back
  to `DATABASE_URL_TEST=…/storelah_test` (`tests/e2e/test-db.ts`), and the
  sibling Track B worktree (`master-rate-strategy`) uses the **same**
  database and ran its own e2e concurrently (observed 10:35 + 10:58). Every
  suite truncates first (`fixtures.ts:resetDb`), so concurrent runs corrupt
  each other. Brief §2.2 requires one isolated DB per worktree — recommend
  the orchestrator assign `storelah_test_track_a` / `_track_b` (or per-file
  DBs) before A1/B1, and serialize full-suite runs until then.
- The `finance-phase4` SW/SS staleness and the phase3 retry/status-code diffs are
  the first triage items. `floor-plan-unit-sync` is cleared (passes isolated);
  the remaining red files (phase3 ×6, phase4 ×20) fail identically with a quiet
  DB and are pre-existing on `7c16f71`.

---

## Appendix — PENDING_HANDOFF register (do not design without the handoff)

1. §21's 18 move-out + transfer test cases and the §15 rate cases (A1/B1 inputs).
2. §9.2 (−S$19.25) and §11.5 (S$41.91) worked examples (A1 hand-derived constants).
3. §8 entry-point specifics (all §8.1 channels converging on one service) and §19 copy strings (A3/A7 verbatim copy).
4. Financial Model target field (recurring effective PSF; ref model 5.6384) — §5 Financial-Model row.
5. `PromotionPlan` statuses + `DiscountMatrixCell.accessType` → "Standard unit" / "Premium access / ground floor" mapping.
6. R15 size-point schedule detail beyond `Math.round(unit.sqft)` (Track B; listed so Track A migration avoids the `Unit` columns it will need).
7. Exact `MoveOutCase` 7-state names/transitions and inspection field copy (A3 state machine).

*End of P0 design note — gate: bring §7 (D1–D8, D14) to the owner before A1.*

## Post-A3 correction — openapi.ts NO-ENTRY (2026-11-18)

Phase A3 had added ~265 lines to `src/lib/openapi.ts` (six `/cms/move-out-cases*`
paths plus `MoveOutCase` / `MoveOutPreview` / `MoveOutDateChangeResult` /
`MoveOutInspectionResult` schemas, and a 410-retired rewrite of
`PATCH /cms/move-outs/{tenantId}` for D14). That addition contradicted the
file's own header scope (booking-only spec; CMS routes out of scope per the
Lease-horizon P4 no-entry precedent) and Track B phase B3 correctly added zero
entries — so the file was reverted to base `7c16f71` (byte-identical;
`git diff 7c16f71 -- src/lib/openapi.ts` empty). CMS route contracts for this
track live in `src/lib/routePermissions.ts` (enforced by
`tests/e2e/cms-rbac.test.ts`) plus the route code itself — not in the OpenAPI
spec. Note: the restored base doc for `PATCH /cms/move-outs/{tenantId}` again
describes the pre-D14 complete/cancel behaviour while the route returns 410 +
pointer; that staleness is accepted as the cost of the no-entry rule.

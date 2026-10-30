# Finance Module — IMPLEMENTATION_PLAN (Phase 0 design note, research only)

- **Status:** PROPOSED — needs owner approval before Phase 1 starts.
- **Sources:** orchestrator brief `storelah-backend` lane brief §§2–5, 7 (`finance-module.md`, 29 Oct 2026)
  + worktree inspection (branch `feature/9-finance-module` @ `6843dbd`). The brief wins on *how to fit
  the codebase*; the spec wins on business rules/formulas/controls (spec §1 priority order).
- **⚠️ Spec file not found in this worktree:** `docs/finance/FINANCE_MODULE_SPEC.md` does not exist here
  and `git log --all -- docs/finance/` is empty. All spec §-references below come from the brief's
  summary of the spec (31 sections, 12 submodules, §§26/27/28/29/30). **Before Phase 1, place the real
  spec at `docs/finance/FINANCE_MODULE_SPEC.md` and re-verify §§6, 8, 16.5, 21, 26–30 against this plan.**
  Anything below marked PROPOSED still needs the spec text + an owner decision.
- **Zero code/migration/Stripe changes in Phase 0.** This file is the only change.

## 0. Worktree baseline (what this plan assumes)

Inspected in this worktree (cut from `develop`, predates several lanes):

- `InvoiceStatus` = `{PAID, DUE, OVERDUE}`; `Invoice` has `stripeSessionId/paymentIntentId/paidAt/amountPaid`
  (additive, nullable). Customer portal pays DUE/OVERDUE via Stripe Checkout test mode
  (`src/core/invoicePayments.ts`, `checkout.ts`, `src/routes/customer.ts` + webhook).
- `Tenant` carries `unitId, monthlyRate, psf, moveInDate, nextPayment, branchId` — but **no**
  billing-day, agreement start/end, or rent-free fields (see §1 decision point).
- `Setting` has `billing.graceDays / lateFeeEnabled / gstEnabled / invoicePrefix` (all with code
  defaults; missing rows → defaults). `FacilityFee` (kind/key/scope/branch/size/tenant, FLAT|PCT|MONTHS)
  and `BusinessRule` (key/category/value) exist. `OperatorFacilityAccess` exists in schema.
- CMS API: `GET /invoices`, `GET /bookings` in `src/routes/cms.ts` via `src/core/finance.ts`
  (booking/invoice list serializers). Admin UI has Finance with 3 subtabs
  (`bill-overview/invoices/arrears`).
- **Absent from this worktree, present per brief (other lanes/branches):**
  `src/lib/permissions.ts`, `src/lib/routePermissions.ts`, `src/lib/facilityScope.ts`,
  `SYSTEM_ROLES` seeded roles, `tests/e2e/cms-rbac.test.ts`, `src/core/savedCards.ts`,
  `src/core/finance/` directory, RBAC-gated CMS routes. The schema already has
  `AdminUser.role/facilityAccess/permissions` relations (P1 items 5/6).
- **Plan target = post-rebase state** where those RBAC files exist on `develop`.
  **Phase 1 must not start until this worktree is rebased onto `develop` and the RBAC files are
  confirmed present** (re-check `src/lib/routePermissions.ts` + `cms-rbac.test.ts`). Phase 3 additionally
  depends on the `saved-cards` worktree landing in `develop` (brief §6).

Repo conventions this plan follows: `cuid()` ids; `Decimal` columns + `Prisma.Decimal` math, `toNum`
at the API boundary; `ok()/created()/fail()` envelopes, never ad-hoc `res.json`; Bearer JWT
`requireAuth` on every CMS route; thin routes in `src/routes/cms.ts` → logic in `src/core/finance/`;
openapi entries in `src/lib/openapi.ts`; additive-only migrations (no drops/renames on
Invoice/Tenant/Booking); Stripe test mode only; launch port **4150** (never 4000/4010–4012/4100–4140);
local DB port 5433, never `db:seed` on anything but throwaway.

---

## 1. Prisma model list (new + additive changes)

### 1a. Additive changes to existing tables (no drops, no renames, all nullable/defaulted)

**`Invoice`** — extend lifecycle additively (spec §6.1):

```prisma
enum InvoiceStatus {
  PAID DUE OVERDUE            // existing — NEVER renamed/removed
  DRAFT APPROVED ISSUED       // new pre-receivable states
  PARTIALLY_PAID              // new: paid 0 < x < total
  VOID WRITTEN_OFF            // new terminal non-paid states
}
// New nullable/additive columns on Invoice:
  // lifecycle
  status           // widened enum above (default stays DUE for back-compat creation path)
  approvedBy  String?
  approvedAt  DateTime?
  issuedAt    DateTime?
  voidedAt    DateTime?
  voidReason  String?
  writtenOffAt DateTime?
  // money (Decimal, never float)
  subtotal    Decimal?  @db.Decimal(10, 2) // pre-tax/pre-credit
  taxAmount   Decimal?  @db.Decimal(10, 2) // GST hook, 0 until Q1 decided
  creditApplied Decimal? @db.Decimal(10, 2)
  balanceDue  Decimal?  @db.Decimal(10, 2) // total − paid − credits; derived, stored for audit
  // service period (revenue recognition hook, Q2)
  serviceStart DateTime?
  serviceEnd   DateTime?
  // idempotency + concurrency (spec controls)
  idempotencyKey String?  @unique  // monthly-billing-run + queued-charge dedupe
  version        Int      @default(0) // optimistic lock on approve/issue/pay transitions
```

Why additive-safe: existing rows keep `DUE/OVERDUE/PAID`; Postgres `ALTER TYPE … ADD VALUE`
adds values without touching rows. `ALTER TYPE ADD VALUE` cannot run inside a transaction
block — migration must use separate statements (Prisma handles native enum extension; verify
generated SQL before `db:migrate`). Rollback = code revert; new values simply unused.

**`Tenant`** — carry billing terms additively (preferred option; needs owner sign-off, see §1d):

```prisma
  billingDay      Int?      // 1–28 day-of-month override; null = derived from moveInDate
  agreementStart  DateTime? // storage-agreement term start (null = moveInDate)
  agreementEnd    DateTime? // null = rolling monthly
  rentFreeMonths  Int?      @default(0)
```

**`Unit` / `UnitSize` / `Branch`** — no changes. Projection reads them in-process
(“Facilities Management API” = direct reads of `Unit`/`UnitSize`/`Floor` + snapshots).

### 1b. New tables (all `cuid()` ids, `Decimal` money, branch-scoped where noted)

| Model | Purpose (spec ref) | Key fields |
|---|---|---|
| `FinanceAuditEvent` | Append-only audit trail (§6/§16.5). **No update/delete code path** | `id, branchId?, actor, action, entityType, entityId, before Json?, after Json?, correlationId, createdAt`. `@@index([entityType, entityId])`, `@@index([correlationId])` |
| `FinanceEvent` | Outbox table (§21). Same-DB-transaction writes; consumers = synchronous recalc or idempotent-on-read; scheduled work via CMS-triggered endpoint first | `id, type, payload Json, status (PENDING/CONSUMED/FAILED), attempts, correlationId, createdAt, consumedAt?`. `@@index([status])` |
| `FinancialModel` | Planning workspace (§11): one row per model | `id, branchId?, name, status (DRAFT/CURRENT/ARCHIVED), inputSnapshot Json (complete inputs), engineVersion, inputHash, createdBy, updatedBy, version (optimistic lock), createdAt, updatedAt` |
| `FinancialModelVersion` | Version history + submit/approve/reject/restore/duplicate audit (§16) | `id, modelId FK, version, snapshot Json, changeSummary, status, decidedBy?, decidedAt?, @@unique([modelId, version])` |
| `Budget` | Budgets & expenses (§13): protected lease line + scoped update | `id, branchId, fiscalMonth, category, amount Decimal, protected Boolean @default(false) (lease line), createdBy, version, @@unique([branchId, fiscalMonth, category])` |
| `Expense` | Expense ledger with attachments via existing content storage (§13) | `id, branchId, budgetId?, incurredAt, vendor?, category, amount Decimal, receiptRef String? (content-storage key), postedMonth? (immutability anchor), createdBy` |
| `SizePriceRule` | Size Mix & Pricing (§14): manual overrides over live `Unit` inventory + sync log | `id, branchId, sizeId FK→UnitSize, targetPsf Decimal?, targetRate Decimal?, authority (SYSTEM/MANUAL), effectiveFrom, createdBy, version` |
| `InvoiceLine` | Invoice lines (§17) | `id, invoiceId FK, kind (RENT/FEE/CREDIT/TAX/ADJUSTMENT), label, amount Decimal, refId?` |
| `PaymentInstruction` | Transactions register: ISSUE → `PENDING_APPROVAL` charge, approved individually (§10.4, no bulk) | `id, invoiceId FK, tenantId, amount Decimal, method (SAVED_CARD), status (PENDING_APPROVAL/APPROVED/QUEUED/SUBMITTED/SUCCEEDED/FAILED/CANCELLED), idempotencyKey @unique, approvedBy?, approvedAt?, stripePaymentIntentId?, failureReason?, version, timestamps` |
| `CreditWallet` | Credits & refunds ledger (§19) | `id, tenantId FK, balance Decimal, version, updatedAt` + `CreditLedgerEntry {id, walletId FK, kind (GRANT/APPLY/REFUND/EXPIRE/ADJUST), amount Decimal, refId?, actor, createdAt}` (append-only) |
| `Refund` | Refund lifecycle + maker-checker + threshold (§19) | `id, tenantId, amount Decimal, reason, status (REQUESTED/APPROVED/REJECTED/PAID), requestedBy, approvedBy?, bankVerified Boolean @default(false), idempotencyKey @unique, version` |
| `ArrearsCase` | Arrears + recovery workflow (§18) | `id, tenantId, invoiceId?, stage, assignee?, notes?, policyGated Json? (which Global Settings gated each action), openedAt, closedAt?` |
| `SettlementImport` | Reconciliation: Stripe settlement import + matching + suspense (§20) | `id, branchId?, importedAt, sourceRef, raw Json, status (UNMATCHED/MATCHED/SUSPENSE), matchedInvoiceId?, actor` |
| `MonthClose` | Month close → immutable actuals anchor (§12/§20) | `id, branchId, fiscalMonth @unique-per-branch, status (OPEN/CLOSED), closedBy?, closedAt?, @@unique([branchId, fiscalMonth])` |
| `ActualMetric` | Posted actuals; Forecast vs Actuals reads these (em dash until posted, never zero-fabricated) | `id, branchId, fiscalMonth, metric (RENT_COLLECTED/OPEX/…), value Decimal, source, @@unique([branchId, fiscalMonth, metric])` |
| `VarianceNote` | Forecast-vs-actual variance notes (§12) | `id, branchId, fiscalMonth, metric, note, author` |

`FinanceEvent` payload types (§21 catalogue) are string constants in `src/core/finance/events.ts`
(`model.updated`, `invoice.issued`, `charge.approved`, `charge.succeeded/failed`,
`refund.requested/approved`, `month.closed`, …) — catalogue lives in code + `TEST_MATRIX.md`, not in DB.

### 1c. Invoice status → customer API mapping (EXACT, portal-safe)

The portal (`/api/v1/customer`) keeps returning **only** `status ∈ {PAID, DUE, OVERDUE}` and the
current invoice JSON shape. No portal change, no `frontend-agent` task. Mapping applied at
serialization in `src/core/invoicePayments.ts` (single `toCustomerInvoice()` helper both
`GET /portal` and invoice reads use):

| Stored status | Customer-visible | Payable? | Notes |
|---|---|---|---|
| `DRAFT`, `APPROVED` | **hidden** (excluded; unknown id → existing 404) | No | Pre-receivable; portal never sees them |
| `ISSUED` | `DUE` | Yes | New-flow receivable; amount = `balanceDue ?? amount` |
| `DUE` | `DUE` | Yes | Legacy rows unchanged |
| `PARTIALLY_PAID` | `DUE` | Yes | Amount shown = remaining `balanceDue`; `amountPaid` additive field documents progress |
| `OVERDUE` | `OVERDUE` | Yes | Derived by `billing.graceDays` as today |
| `PAID` | `PAID` | No (receipt available) | Unchanged |
| `VOID`, `WRITTEN_OFF` | **hidden** (excluded; receipt endpoint 404s as non-PAID today) | No | Operator-visible only |

Rules: (a) `amount` keeps meaning **invoice total** (portal charges `balanceDue` server-side at
checkout — `createInvoiceCheckoutSession` already uses server-owned amounts; extend to
`balanceDue ?? amount` — internal change, same response shape). (b) Two additive response fields
are proposed — `balanceDue`, `amountPaid` — ignored by the current portal; surfaced in portal UI
only via a future cross-lane task with user go-ahead. (c) Webhook `applyInvoiceCheckoutCompleted`
flips `ISSUED/DUE/OVERDUE → PAID`, and `PARTIALLY_PAID → PAID` only when paid-in-full, else updates
`amountPaid/balanceDue` and stays `PARTIALLY_PAID` (conditional write → idempotent on retry).
(d) Any future change to a `/api/v1/customer` response shape → STOP, report to user, plan a
`frontend-agent` task (brief §2 — cross-lane gate).

### 1d. Backfill sketch (reversible, additive-only)

1. Enum extension migration: `ALTER TYPE "InvoiceStatus" ADD VALUE` × 6 (separate statements,
   outside transaction). No row updates. Reversible by code revert (values unused until code writes them).
2. New nullable columns: `subtotal/taxAmount/creditApplied/balanceDue/serviceStart/serviceEnd/...`
   default NULL; `version` defaults 0; `idempotencyKey` NULL (unique index allows multiple NULLs in PG).
3. Lazy derivation, no mass UPDATE: `balanceDue` computed on read as `amount − (amountPaid ?? 0)`
   until a write stamps it; first lifecycle write stamps all derived columns. Zero-downtime, no
   destructive seed, nothing to “undo” beyond the additive migration.
4. **StorageAgreement decision (needs owner approval before Phase 1):** PROPOSED = do **not**
   create a `StorageAgreement` table; Tenant + the four additive nullable columns (§1a) carry
   billing-day/start/end/rent-free. Proof sketch: every spec billing input (who, which unit, rate,
   when to bill, term bounds, rent-free) maps to `Tenant` + `Unit` + `Booking.duration`; no second
   customer registry is created and portal linkage (email-keyed Tenant rows) is untouched. If the
   owner later wants multi-term history per tenant, revisit as a Phase 4+ additive table.
    UPDATE 2026-10-30: still PROPOSED — owner has not yet answered, sign-off still needed before Phase 1 (see §9).

---

## 2. Permission resources + actions + seeded Finance roles

Target system = live CMS RBAC per brief: `src/lib/permissions.ts` (`RESOURCES` + `view/create/update/
delete/approve`) + `src/lib/routePermissions.ts` (deny by default) + facility scope via
`OperatorFacilityAccess` + `src/lib/facilityScope.ts`. **None of these files exist in this worktree
yet — rebase first (§0).** Every new CMS route MUST be added to `routePermissions.ts` or
`tests/e2e/cms-rbac.test.ts` fails.

### 2a. Resources (keep 3, add 9 → 12 total, one per submodule)

| # | Resource key | Submodule | Status |
|---|---|---|---|
| 1 | `bill-overview` | Finance Overview | KEEP, widen actions |
| 2 | `bill-invoices` | Invoices | KEEP, widen actions |
| 3 | `bill-arrears` | Arrears | KEEP, widen actions |
| 4 | `bill-transactions` | Transactions & Approvals | NEW |
| 5 | `bill-models` | Financial Models | NEW |
| 6 | `bill-performance` | Forecast vs Actuals | NEW |
| 7 | `bill-budgets` | Budgets & Expenses | NEW |
| 8 | `bill-pricing` | Size Mix & Pricing | NEW |
| 9 | `bill-returns` | Investment Returns | NEW |
| 10 | `bill-library` | Model Library | NEW |
| 11 | `bill-credits` | Credits & Refunds | NEW |
| 12 | `bill-reconciliation` | Reconciliation | NEW |

### 2b. Action matrix (PROPOSED; maker-checker stays in service code, not RBAC)

- `bill-overview`: `view` (+ export CSV with `view`; export writes audit event, needs no separate action).
- `bill-invoices`: `view/create/update/approve` (approve = APPROVED step; no `delete` — lifecycle uses VOID).
- `bill-arrears`: `view/update` (case work), `approve` (recovery actions gated by policy).
- `bill-transactions`: `view/create` (instructions), `approve` (per-charge approval; **no bulk**).
- `bill-models`: `view/create/update/delete/approve` (drafts deletable; CURRENT/ARCHIVED not deletable —
  enforced in service code).
- `bill-performance`: `view` (+ variance-note `update`).
- `bill-budgets`: `view/create/update/approve` (lease line: `update` denied in code unless protected override).
- `bill-pricing`: `view/update/approve` (manual override = `update` + audit).
- `bill-returns`: `view` (read-only; inputs come from CURRENT model).
- `bill-library`: `view/update/approve` (submit/approve/reject/restore/Set-as-Current; no `delete`).
- `bill-credits`: `view/create/update/approve` (refund second approval = `approve` + threshold in code).
- `bill-reconciliation`: `view/create/update/approve` (import/match = create/update; close = approve).
- Audit events: readable with any `bill-* view`; no action grants mutation (no update/delete path exists).

### 2c. Seeded Finance roles (editable rows in `SYSTEM_ROLES`; PROPOSED matrix)

| Role | Grants (resource: actions) | Scope | Notes |
|---|---|---|---|
| Finance Operator | invoices v/c/u; transactions v/c; models v/c/u; budgets v/c/u; pricing v/u; arrears v/u; credits v/c/u; reconciliation v/c/u; overview/performance/returns/library v | Facility (Manager-style + `OperatorFacilityAccess`) | Cannot approve anything; cannot touch protected lease line |
| Finance Approver | Everything Operator has + `approve` on transactions, invoices, budgets, credits/refunds, library, reconciliation close | Facility | Maker-checker: approver ≠ requester enforced in code |
| Finance Auditor | `view` on all 12 + audit-trail view | ALL (read-only) | No mutations; export allowed (audited) |
| Owner (Platform Admin) | all actions all resources | ALL | Existing; unchanged |
| Manager (Facility) | overview/invoices/arrears v (+ existing billing keys) | Facility | Existing keys keep working; new resources NOT auto-granted |
| Investor | **deferred to Phase 5** (masked read-only) | — | No seed row until Phase 5 |

**Open (ask owner, §6 Q-plus):** are the three Finance roles auto-added to existing operator accounts,
or does the Owner assign them in Global Settings › Team & access? PROPOSED default: seed roles exist
with zero members; Owner assigns (least-privilege, matches 2026-10-27 RBAC model). Needs explicit owner call.
UPDATE 2026-10-30: DECIDED — Owner assigns, seed three Finance roles with zero members (see §9 Q11).

---

## 3. API route list (`/api/v1/cms/finance/...`)

Thin routes in `src/routes/cms.ts` (all `requireAuth` + `routePermissions` entry + `openapi.ts` entry);
logic in `src/core/finance/<module>.ts`. `ok()/created()/fail()` envelopes; `toNum` at boundary.
Facility scope (`facilityScope.ts`) applied in every handler. Mutation routes take
`Idempotency-Key` header where marked (⋄) and `version` for optimistic-lock compare-and-swap (∗).

```
# Overview (§9)
GET    /api/v1/cms/finance/overview?branchId=&from=&to=&basis=accrual|cash
GET    /api/v1/cms/finance/overview/export.csv            (audit event)

# Transactions & Approvals (§10)
GET    /api/v1/cms/finance/transactions?status=&branchId=
POST   /api/v1/cms/finance/transactions                  ⋄ (create instruction; no charge)
POST   /api/v1/cms/finance/transactions/:id/approve      ⋄∗ (server revalidates; queues charge)
POST   /api/v1/cms/finance/transactions/:id/retry        ⋄∗
POST   /api/v1/cms/finance/transactions/:id/cancel       ∗

# Financial Models (§11: four independently-staged sections Undo/Update §11.6–11.7)
GET    /api/v1/cms/finance/models
POST   /api/v1/cms/finance/models                        ⋄
GET    /api/v1/cms/finance/models/:id                    (inputs + computed rows + KPIs + checks)
PUT    /api/v1/cms/finance/models/:id/inputs             ∗ (per-section staged update)
PUT    /api/v1/cms/finance/models/:id/assumptions        ∗
PUT    /api/v1/cms/finance/models/:id/size-mix           ∗
PUT    /api/v1/cms/finance/models/:id/opex               ∗
POST   /api/v1/cms/finance/models/:id/scenarios          (scenario §8.9: named overlay, no fork)
POST   /api/v1/cms/finance/models/:id/sensitivity        (tornado §8.10 inputs)
GET    /api/v1/cms/finance/models/:id/export.csv

# Forecast vs Actuals (§12)
GET    /api/v1/cms/finance/performance?branchId=&fiscalMonth=   (em dash until posted)
POST   /api/v1/cms/finance/performance/notes             (variance notes)

# Budgets & Expenses (§13)
GET    /api/v1/cms/finance/budgets?branchId=&fiscalMonth=
PUT    /api/v1/cms/finance/budgets/:id                   ∗ (lease line protected in code)
GET    /api/v1/cms/finance/expenses?branchId=&from=&to=
POST   /api/v1/cms/finance/expenses                      ⋄ (receiptRef via content storage)
GET    /api/v1/cms/finance/expenses/export.csv

# Size Mix & Pricing (§14)
GET    /api/v1/cms/finance/pricing?branchId=             (live Unit inventory + rules)
PUT    /api/v1/cms/finance/pricing/:sizeId               ∗ (manual override + audit)

# Investment Returns (§15; read-only over CURRENT model; IRR N/A patterns, never fabricated)
GET    /api/v1/cms/finance/returns?modelId=              (payback/IRR/MoM + N/A reasons)

# Model Library (§16)
GET    /api/v1/cms/finance/library
POST   /api/v1/cms/finance/library/:id/duplicate         ⋄
POST   /api/v1/cms/finance/library/:id/submit            ∗
POST   /api/v1/cms/finance/library/:id/approve           ∗
POST   /api/v1/cms/finance/library/:id/reject            ∗
POST   /api/v1/cms/finance/library/:id/restore           ∗
POST   /api/v1/cms/finance/library/:id/set-current       ∗
GET    /api/v1/cms/finance/library/:id/audit

# Invoices (§17)
GET    /api/v1/cms/finance/invoices?status=&branchId=&from=&to=
POST   /api/v1/cms/finance/invoices                      ⋄ (Create invoice: lines + tax hook)
POST   /api/v1/cms/finance/invoices/:id/approve           ∗
POST   /api/v1/cms/finance/invoices/:id/issue             ∗ (APPROVED → ISSUED; portal-visible from here)
POST   /api/v1/cms/finance/invoices/:id/void              ∗ (reason required; terminal)
POST   /api/v1/cms/finance/billing-run                   ⋄ (CMS-triggered monthly run → DRAFTs only)

# Arrears (§18)
GET    /api/v1/cms/finance/arrears?branchId=
POST   /api/v1/cms/finance/arrears                       (open case)
POST   /api/v1/cms/finance/arrears/:id/advance           ∗ (policy-gated by Global Settings)
POST   /api/v1/cms/finance/arrears/:id/close             ∗

# Credits & Refunds (§19)
GET    /api/v1/cms/finance/credits?tenantId=
POST   /api/v1/cms/finance/credits/grant                 ⋄
POST   /api/v1/cms/finance/credits/apply                 ⋄∗ (wallet → invoice allocation)
POST   /api/v1/cms/finance/refunds                       ⋄ (request; maker)
POST   /api/v1/cms/finance/refunds/:id/approve           ∗ (checker; threshold in code; bank verify)
POST   /api/v1/cms/finance/refunds/:id/reject            ∗

# Reconciliation + Close (§20)
POST   /api/v1/cms/finance/reconciliation/import         ⋄ (Stripe settlement import)
GET    /api/v1/cms/finance/reconciliation?branchId=&fiscalMonth=  (matched/suspense queues)
POST   /api/v1/cms/finance/reconciliation/:id/match      ∗
POST   /api/v1/cms/finance/month-close                   ∗ (OPEN → CLOSED; freezes ActualMetric)

# Shared
GET    /api/v1/cms/finance/audit?entityType=&entityId=&correlationId=
```

`src/core/finance/` modules: `projection.ts` (pure engine), `models.ts`, `budgets.ts`, `billing.ts`,
`payments.ts` (extends `invoicePayments.ts`, never forks), `refunds.ts`, `reconciliation.ts`,
`monthClose.ts`, `audit.ts`, `events.ts` (outbox catalogue), `idempotency.ts`, `policies.ts`
(`finance.*` Setting/BusinessRule reads with UNDECIDED-block), `overview.ts`, `arrears.ts`,
`pricing.ts`, `returns.ts`, `library.ts`.

---

## 4. UI module breakdown (12 submodules → view files)

Live admin = `src/cms/admin/dashboard.html` + ES modules (legacy `src/cms/dashboard.html` +
`data-layer.js` stay frozen). Finance keeps `data-core-page="billing"`; extend the 3 subtabs to a
**left subcategory list of 12** (one item per submodule), one view module per submodule. Do NOT grow
`admin.js` (~4.8k lines). Hash routing `#bill-<sub>` + safe query params (ids, months); never PII or
draft state in the URL. Look = existing CMS design system; prototype is layout/content/interaction
reference only (its localStorage data paths are NOT copied).

| # | Submodule | Hash | View file | Phase | Server data (no fabrication) |
|---|---|---|---|---|---|
| 1 | Finance Overview | `#bill-overview` | `financeOverviewView.js` | 1 | Real invoices/tenants/bookings/move-ins; accrual/cash toggle; KPI lineage tooltips; “Not yet connected” for sourceless KPIs |
| 2 | Transactions & Approvals | `#bill-transactions` | `financeTransactionsView.js` | 3 | Register + Review & Approve modal; server revalidates at approval |
| 3 | Financial Models | `#bill-models` | `financeModelsView.js` | 2 | 4 staged sections, month table, charts, calculation-checks panel |
| 4 | Forecast vs Actuals | `#bill-performance` | `financePerformanceView.js` | 4 | Em dash until month posted; variance notes |
| 5 | Budgets & Expenses | `#bill-budgets` | `financeBudgetsView.js` | 2 | Protected lease line; expense ledger + receipt upload |
| 6 | Size Mix & Pricing | `#bill-pricing` | `financePricingView.js` | 2 | Live Unit inventory sync; override authority per Q9 |
| 7 | Investment Returns | `#bill-returns` | `financeReturnsView.js` | 2 | Read-only; IRR N/A patterns shown honestly |
| 8 | Model Library | `#bill-library` | `financeLibraryView.js` | 2 | Versions, duplicate/submit/approve/reject/restore/archive, Set as Current, audit |
| 9 | Invoices | `#bill-invoices` | `financeInvoicesView.js` | 3 | Lifecycle + lines + Create invoice |
| 10 | Arrears | `#bill-arrears` | `financeArrearsView.js` | 4 | Cases + recovery workflow, policy-gated actions |
| 11 | Credits & Refunds | `#bill-credits` | `financeCreditsView.js` | 4 | Wallet ledger + refund calculator/lifecycle |
| 12 | Reconciliation | `#bill-reconciliation` | `financeReconciliationView.js` | 4 | Settlement import, matching, suspense, close checklist |

Shared: `financeShared.js` (states, money fmt via `toNum`-shaped JSON, lineage tooltip, CSV export).
Every view implements **loading / empty / error / permission-denied** states (Phase 1 shell proves the
pattern). Phase 1 also ships the 12-item sidebar shell with per-item permission gating.

**Open (ask owner):** is the spec’s seven-item top “journey navigation” (§3) wanted *in addition* to
the left subcategories? PROPOSED: no — one 12-item left list only (two navs for the same 12 pages
duplicates state and hash surface). Needs explicit owner call.
UPDATE 2026-10-30: ADOPTED as proposed — 12-item left list only, no journey nav (see §9 Q12).
UPDATE 2026-10-30 v1.2: SUPERSEDED — build journey nav SAME AS the prototype: top journey nav PLUS left list (see §10 Q12).

---

## 5. Deferred spec features (out of v1 build)

- Terminal value / financing / tax / depreciation inside IRR (§15/Q8) — confirmed “no” pending owner
  (returns = unlevered project cash flows only; any of these later = additive engine inputs + version bump).
  UPDATE 2026-10-30: SUPERSEDED by owner IRR scope — full spec DECIDED, with spec CONFLICTs flagged (see §9 Q8).
- Investor role + masked read-only views + printable summary + investor export (Phase 5; no seed row before).
- EventBridge cron / DLQ infra — CMS-triggered endpoints first; cron only as later devops task on user request.
- Bulk payment approval — never (spec §4.1); every charge individually approved, enforced in code.
- Second Stripe path — never; Phase 3 extends `checkout.ts`/`invoicePayments.ts`/`savedCards.ts` + existing webhook.
- `StorageAgreement` table — deferred unless owner rejects the Tenant-columns option (§1d).
- Auto-charging / off-session without per-charge approval; late-fee auto-posting before Q5 decided.
- Data-retention purge jobs and PII-masking export (Phase 5, Q10).
  UPDATE 2026-10-30 v1.2: SUPERSEDED in part — perpetual retention, no purge job, purge explicitly out of scope; investor export = summary (see §10 Q10).
- WCAG 2.2 AA audit (Phase 5, `ui-ux-reviewer` skill).

---

## 6. Open questions — brief §7 (all PROPOSED, need owner decision; phase blocked in brackets)

1. **GST/tax treatment; is model revenue tax-exclusive? [blocks Phase 3].**
   PROPOSED: `billing.gstEnabled` (exists, default false) stays the switch; model + invoice money stored
   **tax-exclusive**, `taxAmount` computed at issue from the ruling rate; `taxAmount = 0` and GST UI hidden
    while OFF. Needs IRAS/GST-registration ruling from owner — never assume a rate.
     UPDATE 2026-10-30: DECIDED — toggle `finance.gstEnabled` + configurable `finance.gstRate`; money stays tax-exclusive, `taxAmount = 0` + GST UI hidden while OFF; rate UNDECIDED (spec v1.0 states no rate) — see §9 Q1.
     UPDATE 2026-10-30 GST final: rate DECIDED — 5% default (editable, NOT hardcoded); see GST final note after §10 Q8 final confirmation.
2. **Invoice approval requirement + service-period revenue recognition [Phase 3].**
   PROPOSED: approval REQUIRED for every manually-created invoice (DRAFT → APPROVED → ISSUED);
   billing-run drafts need one approval before issue; revenue recognised over `serviceStart–serviceEnd`
    (accrual basis), cash basis recognises on payment. Months close → `MonthClose` freezes both.
     UPDATE 2026-10-30: ADOPTED as proposed (see §9 Q2).
     UPDATE 2026-10-30 v1.2: CONFIRMED — no change (see §10 Q2).
3. **Which roles approve charges; is bulk approval ever allowed? [Phase 3].**
   PROPOSED: Finance Approver + Owner only; bulk approval NEVER (spec §4.1); each
    `PaymentInstruction` approved individually with server revalidation + idempotency key.
    UPDATE 2026-10-30: DECIDED — Finance Approver + Owner only; no bulk ever, enforced in service code regardless of role (see §9 Q3).
4. **Refund second-approval threshold (prototype SGD 250) + bank-transfer verification [Phase 4].**
   PROPOSED: adopt SGD 250 second-approval threshold (Finance Approver ≠ requester above it) and REQUIRE
   bank-account verification before any refund `PAID`; store as `finance.refundThresholdSgd = 250` /
    `finance.refundBankVerify = REQUIRED` in Settings (UNDECIDED until owner confirms → refunds BLOCKED).
     UPDATE 2026-10-30: DECIDED — this §9 entry is the countersign (SGD 250 + bank verification REQUIRED); refunds stay BLOCKED until the settings land in Phase 4 code (see §9 Q4).
     UPDATE 2026-10-30 v1.2: SUPERSEDED — NO threshold; every-refund maker-checker + Super Admin bypass (see §10 Q4).
5. **Late fee, grace period, access restriction, termination policy [Phase 4].**
   PROPOSED: reuse `billing.graceDays` (5) + `billing.lateFeeEnabled` (true) + `FacilityFee`
   (lateFee/adminFee/deposit keys, tenant-level exceptions already supported) + `BusinessRule`
    for the rest; do NOT invent parallel policy tables. Exact fee values/schedules need owner numbers.
    UPDATE 2026-10-30 v1.2: DECIDED timings — graceDays 0 / lateFeeAfterDays 7 / accessRestrictAfterDays 14 (all editable); waive-late-fee REQUIRED; amount/formula + termination STILL OPEN (see §10 Q5).
6. **Expense accrual vs cash at month close [Phase 4].**
   PROPOSED: Overview supports both bases via toggle (accrual default); `MonthClose` posts
    `ActualMetric` rows per basis; Forecast vs Actuals compares on the selected basis consistently.
    UPDATE 2026-10-30 v1.2: DECIDED — expenses recognised when incurred; cash-basis view derived/display-only (see §10 Q6).
7. **Deposits: liability, credit, or separately controlled funds? [Phase 4].**
   PROPOSED: liability (held, never auto-applied); application to an invoice requires an explicit
    operator action + audit event. Auto-offset: no.
    UPDATE 2026-10-30: DECIDED — REPLACED by segregated separately-controlled funds (see §9 Q7).
8. **Terminal value / financing / tax / depreciation in IRR [out of scope; confirm “no”].**
     PROPOSED: confirmed out of v1 (see §5). Owner to countersign.
     UPDATE 2026-10-30: SUPERSEDED — full owner IRR scope DECIDED, with spec CONFLICTs flagged (see §9 Q8).
     UPDATE 2026-10-30: FINAL — owner confirmed the §9 Q8 text as the FINAL Q8 answer, no further input coming (see §10 Q8 final confirmation).
9. **Size taxonomy (XS–XL vs live `UnitSize` names) + manual-override authority [Phase 2].**
   PROPOSED: canonical planning buckets LOCKER/SMALL/MEDIUM/LARGE/XL/XXL (matches
   `DiscountMatrixCell.sizeCategory`; legacy XS reads as LOCKER); live `UnitSize` rows map into buckets
   via `SizePriceRule`; manual override allowed for Manager+ with `update` on `bill-pricing` + audit,
    authority recorded per change.
    UPDATE 2026-10-30: DECIDED — live `Unit`/`UnitSize` inventory always wins, buckets map via `SizePriceRule`; manual-override sub-question OPEN (see §9 Q9).
10. **Data retention, investor export, PII masking [Phase 5].**
    PROPOSED: no purge before owner-approved retention schedule; investor export = masked, approved-only,
    watermarked; PII never in URLs (§4). Owner Legal to confirm.
    UPDATE 2026-10-30 v1.2: DECIDED — perpetual retention, investor summary content + psf/no-names rules (see §10 Q10).
11. **Role assignment [Phase 1].** PROPOSED: seed the three Finance roles with zero members; Owner assigns
    in Team & access (see §2c). Confirm.
    UPDATE 2026-10-30: DECIDED — Owner assigns (see §9 Q11).
12. **Seven-item journey nav [Phase 1 UI].** PROPOSED: not built; 12-item left list only (see §4). Confirm.
     UPDATE 2026-10-30: ADOPTED as proposed (see §9 Q12).
     UPDATE 2026-10-30 v1.2: SUPERSEDED — build SAME AS prototype, journey nav + left list (see §10 Q12).

Policy-config rule (applies to every PROPOSED above): undecided = stored `UNDECIDED` under
`finance.*` in `Setting`/`BusinessRule`; dependent action BLOCKED with a clear message; never guess.

---

## 7. Test mapping seed for `TEST_MATRIX.md` + golden fixtures + edge cases

`TEST_MATRIX.md` (new file, Phase 1) maps **every** spec §26.1 (calc) / §26.2 (workflow) / §26.3 (failure)
bullet to a named test, with the phase that turns it green. Seed table (test names are the contract):

| Spec | Named test | Phase |
|---|---|---|
| 26.1 projection math | `projection.sembawang-golden` (golden fixture, §28), `projection.proration-mid-month`, `projection.rent-free-overlap`, `projection.churn-from-month-7`, `projection.target-92-cap`, `projection.annual-uplift-3pct` | 1 |
| 26.1 scenarios/sensitivity | `models.scenario-overlay-no-fork`, `models.sensitivity-tornado` | 2 |
| 26.1 IRR | `returns.irr-standard`, `returns.irr-na-no-sign-change`, `returns.irr-na-all-negative`, `returns.payback-never` | 2 |
| 26.1 overview KPIs | `overview.accrual-cash-parity`, `overview.no-fabricated-actuals` (em dash, never 0), `overview.kpi-lineage` | 1 |
| 26.2 maker-checker | `transactions.approver-not-requester`, `refunds.threshold-second-approval`, `invoices.void-requires-reason` | 3/4 |
| 26.2 approvals/thresholds | `transactions.individual-only-no-bulk`, `budgets.lease-line-protected`, `pricing.override-audited` | 2/3 |
| 26.2 month close | `close.freezes-actuals` (post-month immutable), `close.adjustment-creates-new-event` | 4 |
| 26.2 idempotency | `billing-run.twice-one-draft-set`, `webhook.duplicate-delivery-single-paid`, `charge.retry-same-key` | 3 |
| 26.2 optimistic lock | `models.concurrent-update-409`, `transactions.approve-stale-409` | 1→ reused 2/3 |
| 26.3 failure/recovery | `charge.failed-retry-recovery`, `refund.negative-converts-to-charge`, `reconciliation.suspense-queue`, `import.partial-match` | 3/4 |
| 26.3 RBAC | `cms-rbac.finance-routes-all-permissioned` (existing suite extended — every route in §3) | every phase |
| 26.3 audit | `audit.append-only-no-update-path`, `audit.correlation-links-cause-effect` | 1 |

UPDATE 2026-10-30 v1.2: `refunds.threshold-second-approval` to be renamed — no threshold, every refund two-step + bypass audit (see §10 Q4).

### Golden-fixture derivation plan (spec §28 Sembawang Launch Plan)

1. Inputs (frozen): start 2026-12-01, NLA 2,274; size-mix table; Opex $1,200/mo; capex $108,000;
   lease $5,000/mo; ramp 180/125 sqft; churn 2.5% from month 7; target 92%; +3%/yr.
2. Derive expected month rows **independently** — hand/spreadsheet calculation committed as the fixture
   with its derivation notes (which cells, which rounding: cents at line level, `Prisma.Decimal`
   semantics — no float).
3. Cross-check headline KPIs (weighted PSF, Y1–Y3 NOI, payback, IRR) against the live prototype.
4. **Report mismatches to the user; fix neither side silently.** Prototype is interaction reference,
   server is authoritative.
5. Engine determinism: same snapshot + `engineVersion` + `inputHash` → byte-identical rows
   (`projection.deterministic` test with fixed fixture).

### Edge cases (each gets a named test)

- Feb leap-year mid-month start (2028-02-15 pro-rata over 29 days).
- Rent-free months spanning the prorated first month (free-month allocation vs partial month).
- IRR “Not available” sign patterns (all-negative, no sign change, single-period).
- Refund that goes negative → converts to a charge (never a negative payment).
- Duplicate Stripe webhook delivery → exactly-once apply (conditional write).
- Concurrent model update → 409 on stale `version`, no lost update.
- `PARTIALLY_PAID` webhook for less-than-balance → stays partial, updates `amountPaid/balanceDue`.
- Posted-month write attempt → BLOCKED with clear message (not silent ignore).
- UNDECIDED policy → dependent action BLOCKED with message naming the missing decision.
- Backfill: legacy DUE invoice pays through new webhook path unchanged (portal regression:
  existing `portal-invoices.test.ts` stays green).

---

## 8. Phase gates (what “done” means per phase — for the orchestrator)

- Phase 0 (this note): owner approves plan + answers §6 per-phase questions + spec file placed.
- Every phase: `pnpm check`, `pnpm test:e2e` (incl. extended `cms-rbac`), phase tests in §7 green,
  `TEST_MATRIX.md` ticked, decision log appended, report to user. No prod migrations/deploys/commits
  without explicit user go-ahead for that step.

---

## 9. Owner decisions v1.1 (2026-10-30)

Owner answers to §6 Q1–Q12 (plus the §1d StorageAgreement sign-off), recorded 2026-10-30. §§1–8 above
are history and are NOT rewritten; one-line `UPDATE 2026-10-30:` pointers were added where a proposal
status changed. Terms: DECIDED = owner ruled, build accordingly; ADOPTED = owner said follow the §6
proposal as written; PROPOSED = still needs owner confirm; UNDECIDED = value not set, dependent
action BLOCKED per the §6 policy-config rule (never guess).

### Q1 — GST/tax: DECIDED (toggle); rate UNDECIDED

- Model + invoice money stored tax-exclusive (as now — unchanged).
- Add a Global Settings toggle to turn GST on/off: `finance.gstEnabled` + configurable `finance.gstRate`.
- Rate value: spec v1.0 states NO prevailing rate (§5.1 defers GST treatment to Finance; §17.2 mentions a
  GST/tax code only) → `finance.gstRate` stays UNDECIDED. Never assume a rate; owner confirmation needed.
- While OFF: `taxAmount = 0`, GST UI hidden. Turning GST ON (or issuing a GST-bearing invoice) with the
  rate still UNDECIDED → invoice issue BLOCKED with a message naming the missing decision.
- UPDATE 2026-10-30 GST final: `finance.gstRate` DECIDED — default 5%, editable in Global Settings (NOT hardcoded); see GST final note after §10 Q8 final confirmation.

### Q2 — Invoice approval + revenue recognition: ADOPTED as proposed (§6 Q2)

- Approval REQUIRED for every manually-created invoice (DRAFT → APPROVED → ISSUED); billing-run drafts
  need one approval before issue.
- Revenue recognised over `serviceStart`–`serviceEnd` (accrual basis); cash basis recognised on payment.
- `MonthClose` freezes both bases.
- UPDATE 2026-10-30 v1.2: CONFIRMED — no change (see §10 Q2).

### Q3 — Charge approvers / bulk: DECIDED

- Finance Approver + Owner only. Bulk approval NEVER (spec §4.1): each `PaymentInstruction` approved
  individually with server revalidation + idempotency key.
- RBAC roles are editable, so an equivalent custom-built role with the same permissions is allowed —
  but the no-bulk rule is enforced in service code regardless of role.

### Q4 — Refund threshold + bank verification: DECIDED (this entry is the countersign)

- SGD 250 second-approval threshold: above it, the approver must differ from the requester
  (maker-checker = requester/maker + separate approver/checker — i.e. yes, two layers above threshold).
- Bank-account verification REQUIRED before any refund reaches PAID.
- Phase 4 stores `finance.refundThresholdSgd = 250` / `finance.refundBankVerify = REQUIRED`. Refunds stay
  BLOCKED until those settings exist in code (policy-config rule); no code changed in this Phase 0 note.
- UPDATE 2026-10-30 v1.2: SUPERSEDED — NO SGD 250 threshold; every-refund maker-checker + Super Admin bypass (see §10 Q4).

### Q5 — Late fee / grace / access / termination: STILL OPEN (owner didn't see the question)

- Exact fee amounts, grace-day count, access-restriction and termination steps need owner numbers.
- Proposal stands PROPOSED: reuse `billing.graceDays` / `FacilityFee` / `BusinessRule`, no parallel tables.
- UPDATE 2026-10-30 v1.2: DECIDED timings (graceDays 0 / lateFeeAfterDays 7 / accessRestrictAfterDays 14, all editable; waive-late-fee REQUIRED); amount/formula + termination STILL OPEN (see §10 Q5).

### Q6 — Accrual vs cash at close: STILL OPEN (owner didn't see the question)

- Whether month-close posts `ActualMetric` per basis with an accrual/cash toggle (proposal) needs owner
  confirm; stands PROPOSED.
- UPDATE 2026-10-30 v1.2: DECIDED — expenses recognised when incurred; cash-basis view derived/display-only (see §10 Q6).

### Q7 — Deposits: DECIDED (replaces the §6 Q7 liability proposal)

- Deposits are SEGREGATED, separately-controlled funds: held as liability, NEVER auto-applied.
- Application to an invoice requires an explicit operator action + audit event.

### Q8 — IRR scope: DECIDED with full owner spec (prior "confirmed out of v1" proposal SUPERSEDED)

- Project IRR (base case) from unlevered project cash flows: EXCLUDE debt drawdowns, interest, loan
  repayments, equity distributions. INCLUDE operating cash flows after rent + other opex, initial setup
  costs, working capital movements, capex, and taxes if the model supports them. Do NOT deduct
  depreciation as a cash outflow (effect only via tax).
- Terminal value EXCLUDED from the base case (lease renewal unsecured). Optional separate renewal/exit
  scenario with disclosed terminal-value assumption. Residual = equipment + working capital + refundable
  deposits, or a realistic business sale — NOT property appreciation.
- Equity IRR calculated separately from equity contributions/distributions timing + amounts (debt flows
  included where applicable), always labeled "Equity IRR".
- Display: lease term + renewal assumptions shown; NPV + payback alongside IRR; 3 rent-free months +
  refundable deposit in cash flows in the months they occur; monthly/varying-date cash flows use dated
  IRR (XIRR).
- CONFLICT vs spec v1.0 (spec wins per §1 priority order — FLAG FOR OWNER to amend spec before Phase 2
  builds returns): (a) spec §8.8 fixes `CF_0 = −total capital investment`, `CF_t = monthly NOI_t` with a
  monthly-rate solve annualised as `(1+r)^12 − 1` — Q8's capex phasing, working-capital movements,
  refundable-deposit timing, conditional taxes and dated XIRR go beyond that formula; (b) spec §5.1
  excludes debt financing, tax, depreciation and terminal value with no Equity IRR or exit-scenario
  metric — Q8's separately-labeled Equity IRR and optional renewal/exit scenario are extensions needing
  spec amendment (§§5.1/8.8, plus §15 layout for NPV/Equity IRR display). Base-case exclusions
  (unlevered, no terminal value, no depreciation deduction) are CONSISTENT with §§5.1/8.6/8.8. Until the
   spec is amended, the engine must follow the spec formulas.
- UPDATE 2026-10-30: FINAL — owner confirmed this §9 Q8 text as the FINAL Q8 answer, no further input coming (see §10 Q8 final confirmation).

### Q9 — Size taxonomy: DECIDED (live inventory wins); sub-question OPEN

- Live `Unit` / `UnitSize` inventory is always the source of truth; planning buckets map from live rows
  via `SizePriceRule`.
- OPEN sub-question for owner: are manual price overrides still allowed as an assumptions-overlay (never
  writing back to live), or fully disallowed? Proposal stands until answered: overlay-with-audit.

### Q10 — Retention / investor / PII: STILL OPEN (owner didn't understand — restated plainly)

- How long to keep financial records, what investor exports may contain, and PII masking rules need
  owner/legal confirm.
- Proposal stands PROPOSED: no purge before an approved retention schedule; investor export = masked,
  approved-only, watermarked; no PII in URLs.
- UPDATE 2026-10-30 v1.2: DECIDED — perpetual retention, investor summary content + psf/no-names rules (see §10 Q10).

### Q11 — Role assignment: DECIDED

- Owner assigns. Seed the three Finance roles with zero members; Owner grants in Team & access.

### Q12 — Journey nav: ADOPTED as proposed (§6 Q12)

- No seven-item journey nav; 12-item left subcategory list only (§4).
- UPDATE 2026-10-30 v1.2: SUPERSEDED — build SAME AS prototype: journey nav PLUS left list (see §10 Q12).

### StorageAgreement vs Tenant columns: STILL OPEN (owner has not yet answered)

- Keeps PROPOSED status (§1d): Tenant + 4 additive columns, no new table. Still needs sign-off before
  Phase 1.

### Still-open summary (blocks)

- Q5 (Phase 4), Q6 (Phase 4), Q10 (Phase 5), Q9 override sub-question (Phase 2), StorageAgreement
  sign-off (before Phase 1), `finance.gstRate` value (before GST ON / Phase 3), Q8 spec amendment to
  §§5.1/8.8/15 (before Phase 2 returns work).
- Zero code/migration/Stripe changes in this note; this file is the only change.

---

## 10. Owner decisions v1.2 (2026-10-30, second round)

Second-round owner answers. §§1–9 above are history and are NOT rewritten; one-line
`UPDATE 2026-10-30 v1.2:` pointers were added where an earlier status changed. Terms as in §9:
DECIDED = owner ruled, build accordingly; CONFIRMED = v1.1 ruling re-confirmed unchanged;
SUPERSEDED = v1.1 ruling replaced; PROPOSED = still needs owner confirm; UNDECIDED = value not
set, dependent action BLOCKED per the §6 policy-config rule (never guess).

### Q2 — Invoice approval + revenue recognition: CONFIRMED 2026-10-30 v1.2 (no change)

- Approval REQUIRED for every manually-created invoice (DRAFT → APPROVED → ISSUED); billing-run
  drafts need one approval before issue.
- Revenue recognised over `serviceStart`–`serviceEnd` (accrual basis); cash basis recognised on payment.

### Q4 — Refunds: SUPERSEDED — NO SGD 250 threshold; every-refund maker-checker + Super Admin bypass

- New DECIDED rule: EVERY refund amount requires a distinct requestor (maker) + approver
  (checker) — no threshold.
- Exemption ONLY for Super Admin (Owner / Platform Admin), who may single-step. The exemption must
  be visible/configurable in Global Settings under user permissions (admins bypass two-step approval).
- Replace `finance.refundThresholdSgd = 250` with a proposal such as
  `finance.refundTwoStep = REQUIRED_EXCEPT_SUPERADMIN` (name is a proposal; store
  UNDECIDED-blocked until Phase 4 code lands). Refunds stay BLOCKED until the settings exist in
  code (policy-config rule); no code changed in this Phase 0 note.
- Bank-account verification before any refund reaches PAID still REQUIRED (unchanged from v1.1).
- Explicit risk note (owner risk-accepted): the Super Admin bypass weakens maker-checker — and every
  bypassed refund must still write a `FinanceAuditEvent` with actor + reason.
- Phase 4 consequences: `refunds.threshold-second-approval` test to be renamed (every-refund two-step
  + bypass-audit coverage); `bill-credits` `approve` action covers the checker step; the bypass path
  still writes the audit event.

### Q5 — Late fee / grace / access restriction: DECIDED timings (all editable in Global Settings, NOT hardcoded)

- Payment becomes OVERDUE the very next day after the due date (graceDays = 0; records that this
  sets the `billing.graceDays` default to 0, editable).
- Late fees kick in 7 days after the due date (`finance.lateFeeAfterDays = 7`, editable).
- A waive-late-fee function is REQUIRED (operator action + amount/reason + audit event;
  permission-gated, approver-level).
- Access restriction 14 days after non-payment (`finance.accessRestrictAfterDays = 14`, editable;
  enforcement hook into existing access control to be designed in Phase 4).
- STILL OPEN: late-fee amount/formula and termination steps — flagged for owner.

### Q6 — Expense recognition: DECIDED accrual

- Expenses recognised when incurred, not when paid. `MonthClose` posts `ActualMetric` on the incurred
  basis (cash-basis view, if kept, is derived/display-only — Phase 4 design consequence).

### Q10 — Retention / investor export: DECIDED

- Finance records kept PERPETUALLY (system + backup; no purge job — any retention-purge feature is
  explicitly out of scope).
- Investor export contains a SUMMARY of the Financial Modelling + Investment Returns modules.
- Amounts MAY be rounded but psf rates ALWAYS 2 decimal places; customer names never appear in these
  modules.
- Investor KPI list (content requirements for the Phase 5 investor summary): occupancy rate, earned
  psf, ramp-up sqft, sign-ups (unit count), move-outs, customer tenure, average customer value, total
  revenue, etc.

### Q12 — Journey nav: SUPERSEDED — build SAME AS the prototype

- Build the journey navigation SAME AS the prototype
  (https://storelah-crm-leads.faisal-0213.chatgpt.site/): the spec §3 seven-item top journey nav PLUS
  the left subcategory list, matching the prototype's structure. Replaces the v1.1 "left list only"
  adoption.
- Phase 1 UI design notes: the prototype is layout/content/interaction reference only (its
  localStorage data paths are NOT copied); styling follows the existing CMS design system; hash
  routing still `#bill-<sub>` + safe query params, never PII/draft in URL.
- The prototype's exact 7 journey items are TO-CONFIRM from the prototype during Phase 1 UI design
  (no guessing) — not enumerated here (not verifiable offline).

### Still-open summary v1.2 (blocks)

- Unchanged still-open items (restated briefly): Q8 spec amendment (owner to amend spec §§5.1/8.8/15
  for the IRR scope), Q9 manual-override sub-question, StorageAgreement sign-off (before Phase 1),
  `finance.gstRate` value (RESOLVED after this note — GST final 5% default, see §10), late-fee amount/formula + termination steps (new from Q5 — STILL OPEN after Phase 4; Phase 4 reads the amount from editable config and never builds termination).
- Zero code/migration/Stripe changes in this note; this file is the only change — except the §12 Phase 4 build note appended below (code + migration + tests + docs, per the Phase 4 brief).

### Q8 final confirmation (2026-10-30)

- FINAL: the owner has confirmed the full IRR text in §9 Q8 as the FINAL Q8 answer — no further
  owner input on IRR scope is coming.
- Project IRR from unlevered project cash flows: EXCLUDE debt/equity flows; INCLUDE opex-after-rent,
  setup costs, working-capital movements, capex, and taxes if supported; depreciation effect via tax only.
- Terminal value EXCLUDED from the base case (renewal unsecured); optional separate disclosed
  renewal/exit scenario; residual = equipment + working capital + refundable deposits or a realistic
  business sale — NOT property appreciation.
- Equity IRR calculated separately and always labeled "Equity IRR" (equity contributions/distributions
  timing + amounts; debt flows included where applicable).
- Display: lease term + renewal assumptions shown; NPV + payback alongside IRR; 3 rent-free months +
  refundable deposit land in-month as they occur; monthly/varying-date cash flows use dated IRR (XIRR).
- CONFLICT vs spec v1.0 §§5.1/8.8/15 STANDS (spec wins per §1 priority order): the owner must amend
  the spec text (or explicitly delegate the amendment wording to a later phase) before Phase 2 returns
  work. Phase 1 (foundations + projection-engine golden fixtures per spec §28) may proceed on the
  existing spec; Phase 2 engine/returns work needs the amended IRR basis.

### GST final (2026-10-30)

- FINAL: the owner has set the GST decision — no further owner input on GST is coming.
- Toggle via backend Global Settings: `finance.gstEnabled`, OFF by default.
- When ON, the default rate is 5%: `finance.gstRate` default 5, editable in Global Settings —
  NOT hardcoded. Phase 3 reads it at invoice issue time.
- When OFF: money stays tax-exclusive, `taxAmount = 0`, GST UI hidden.
- This resolves the previously-UNDECIDED `finance.gstRate` value (§6 Q1 / §9 Q1): DECIDED as
  default 5% (editable). The UNDECIDED-block on issuing a GST-bearing invoice lifts once the
  settings land in Phase 3 code (policy-config rule still applies until then — no guessing).
- Spec interaction (recorded honestly): if spec v1.0 §5.1 defers the GST rate, the owner has now
  set it (5% default) and the spec should be amended to match — a minor spec-amendment item
  alongside the Q8 amendment (§§5.1/8.8/15), NOT a blocker for Phase 1.

---

## 11. Phase 3 build note (2026-10-30, backend-agent)

Built per brief §6 Phase 3 + owner Q-decisions in force (Q1 GST final, Q2
approval-required, Q3 approver+owner/never-bulk, Q5 timings display-only,
Q6 accrual, Q7 segregated deposits). §§1–10 above are history and are NOT
rewritten.

### What shipped

- **Schema** (`20261030000003_finance_phase3_billing`, additive): `InvoiceStatus`
  widened via create-type-and-swap (transaction-safe — `ALTER TYPE ADD VALUE`
  cannot run inside a migrate transaction); `Invoice` += lifecycle/money/
  service-period/idempotency/version columns; `InvoiceLine`,
  `PaymentInstruction` (spec §6.1 statuses incl. DRAFT/EXPIRED unused),
  `ProcessedStripeEvent` (webhook exactly-once). No Tenant columns, no
  StorageAgreement, no drops/renames.
- **Grants** (`20261030000004_...` + `RESOURCES` fix): `bill-transactions:update`
  to Finance Operator/Approver (cancel own mistakes); charging stays
  `bill-transactions:approve`.
- **Core**: `billing.ts` (DRAFT→APPROVED→ISSUED, GST at issue, void with
  reason + instruction cancel, CMS billing run — DRAFTs only, idempotent per
  branch/month/tenant, never late fees/charges); `payments.ts` (individual
  approve → QUEUED, stable-key off-session submit, cancel, webhook allocation
  with event-id claim + writes in ONE transaction); `toCustomerInvoice()` in
  `invoicePayments.ts` (portal EXACT shape — hidden statuses 404, ISSUED→DUE,
  PARTIALLY_PAID→DUE showing the remainder, OVERDUE by `billing.graceDays`).
- **Portal paths extended, not forked**: checkout + saved-card pay charge the
  open balance; both webhook apply paths post partial-aware receipts with
  event-id dedupe (no-event-id callers keep conditional writes).
- **CMS**: 13 routes (invoices + billing run + transactions incl. detail
  reads), all in `routePermissions.ts`; full `financeInvoicesView.js`
  (workspace prepended — legacy tables untouched) +
  `financeTransactionsView.js` (register + Review & Approve modal).
- **Overview/legacy coherence**: billed revenue + trend exclude
  DRAFT/APPROVED/VOID/WRITTEN_OFF; AR covers all receivable states;
  legacy `GET /invoices` shows the 5 live statuses (shape unchanged).

### Calls made inside delegated scope (flagged, not owner questions)

- Approval validates the mandate LINK (wallet in DB, no Stripe call —
  hermetic/outage-safe); the DEFAULT card is resolved at SUBMIT time and the
  masked method is stamped on the instruction then. Rationale in code comments.
- Maker-checker also enforced on invoice approve (spec §4.1 material
  adjustment); issue/void need `approve` perm without a second maker check.
- `PARTIALLY_PAID` portal `amount` = remaining balance (same field, corrected
  semantics for a status the portal never had; new `balanceDue`/`amountPaid`
  fields stay DEFERRED per the brief — no new customer-facing fields).
- Approve lands in QUEUED (spec §10.3 step 9); APPROVED lives on the row +
  audit/outbox only. No scheduler in Phase 3 — submit is the CMS retry step.
- Off-session `requires_action` → FAILED `authentication_required` (cannot be
  fulfilled without the customer); network throw → stays QUEUED + 502.
- `ProcessedStripeEvent` is global (no facility scope); InvoiceLine +
  PaymentInstruction scope through their invoice's unit.

### Verification

- `pnpm check` green; full `pnpm test:e2e` 276/276 green (25 files) incl.
  portal-invoices, both saved-cards suites, cms-rbac, finance-phase1/2.
- New `tests/e2e/finance-phase3.test.ts`: 18 tests covering every Phase 3
  matrix row. TEST_MATRIX.md ticked accordingly.
- Step-0 saved-cards dependency: true merge blocked by uncommitted Phase 1–2
  work (staged rename) + no-commit rule → brought in file-by-file via
  `git checkout origin/feature/8-saved-cards -- <11 paths>` (local-only, no
  push) + hand-applied the 4-line `stripeCustomerId` schema hunk on top of the
  Phase 1–2 schema. `savedCards.ts` + webhook route present; portal suites green.

### Deferred / STOP conditions

- None triggered. No customer-response change was unavoidable; the one
  semantics call (partial `amount` = remainder) is documented above.
- Phase 4 owns: WRITTEN_OFF flow, credits/refunds, arrears, reconciliation,
  late-fee posting, access restriction, `renderPhasePlaceholder` leftovers.

---

## 12. Phase 4 build note (2026-10-30, backend-agent)

Built per brief §6 Phase 4 + owner Q-decisions in force (Q4 v1.2 every-refund
maker-checker + super-admin bypass; Q5 timings now enforced; Q6 accrual; Q7
segregated deposits untouched). §§1–11 above are history and are NOT
rewritten. Q8 rule stands (spec formulas only — returns/projection untouched).

### What shipped

- **Schema** (`20261030000005_finance_phase4_close_controls`, additive):
  `CreditWallet` + append-only `CreditLedgerEntry` (GRANT/APPLY/REFUND/EXPIRE/
  ADJUST kinds); `Refund` (REQUESTED/APPROVED/REJECTED/PAID, computation Json,
  bankVerified, bypassed flag); `ArrearsCase` (OPEN…RESOLVED + policyGated);
  `LateFeeWaiver`; `SettlementImport` (UNMATCHED/PARTIAL/MATCHED/SUSPENSE,
  sourceRef unique); `ReconciliationBatch`; `MonthClose` (+ `ActualMetric`
  unique-per-branch/month/metric + `MonthCloseAdjustment` + `VarianceNote`);
  Tenant += `accessRestricted/At/Reason` (account state, NOT a billing column —
  no billing-day/agreement/rent-free columns added; StorageAgreement still
  deferred). No drops/renames.
- **Settings**: `finance.refundTwoStep = REQUIRED_EXCEPT_SUPERADMIN` SettingDef
  (select, visible in Global Settings per Q4) — refunds unblock in Phase 4
  code via the policy-config rule; any UNDECIDED value BLOCKED.
- **Core** (`src/core/finance/`): `credits.ts` (spec §19 calculator — prorated/
  calculated/final, reason rule, negative→DRAFT-charge + `refund.converted.
  to.charge`; wallet grant/apply with CREDIT lines; approve/reject maker-
  checker + owner bypass audit; bank-verify explicit step; pay gate);
  `arrears.ts` (spec §18 ladder OPEN→…→RESTRICTED→RESOLVED, per-stage timing
  gates from editable settings, late-fee amount from FacilityFee/BusinessRule
  or BLOCKED, FEE-line posting, TERMINATE stub always 409, waivers with
  CREDIT-line approval, candidates queue); `reconciliation.ts` (spec §20
  idempotent import with deterministic auto-match, manual match with partial
  allocations via `postInvoiceReceiptTx`, suspense↔match resolution, close
  checklist + batch close, Owner-only reopen); `monthClose.ts` (spec §12
  readiness checks, accrual-basis `computeActuals`, OPEN→CLOSED freeze,
  adjustments as NEW events, performance variance view with null-until-posted
  actuals, variance notes); `billing.ts` += `writeOffInvoice` + posted-month
  BLOCKED guards on create/approve/issue/void; `budgets.ts` += posted-month
  BLOCKED guards on create/update/record.
- **Permissions**: `bill-performance` gains `approve` (month close =
  the sign-off; update stays variance notes); FINANCE_APPROVER +
  MANAGER_DENY updated. `routePermissions.ts`: 34 new Phase 4 entries
  (credits/refunds/arrears/waivers/write-off/reconciliation/performance/
  month-close).
- **CMS routes**: 34 routes in `src/routes/cms.ts` (thin → core); customer API
  untouched (no `/api/v1/customer` response change — cross-lane gate intact).
- **UI**: full `financeCreditsView.js`, `financeArrearsView.js`
  (workspace prepended — legacy overdue table untouched),
  `financeReconciliationView.js`, `financePerformanceView.js` (loading /
  empty / error / permission-denied states, design system, journey nav).

### Calls made inside delegated scope (flagged, not owner questions)

- Refund PAY records a gateway reference (operator-confirmed) — no live
  Stripe refund call in Phase 4 (TEST MODE, no network in e2e).
- Settlement auto-match only on explicit invoiceRef + exact balance; same-
  amount candidates surface as suggestions for operator confirm.
- Reconciliation batch close requires zero unmatched/suspense (strict reading
  of §20.5 "exceptions below policy threshold or explicitly approved" — no
  threshold policy exists, so none is assumed; recorded for owner review).
- Access restriction = Tenant flag + CMS workflow + cleared on resolve;
  physical-gate integration explicitly out of scope; portal surfacing needs a
  frontend-lane task (customer API unchanged by the cross-lane gate).
- Termination: no route logic beyond the BLOCKED stub (UNDECIDED).
- Late-fee amount from `FacilityFee` kind FEE key `lateFee` (FLAT/PCT/MONTHS)
  or a `finance.lateFeeAmount` BusinessRule row; legacy `billing.graceDays`
  untouched (finance timing reads `finance.graceDays`).
- OpenAPI: `src/lib/openapi.ts` documents only the booking API — Phase 1–3
  added no CMS finance entries, Phase 4 follows that precedent (no-op).

### Verification

- `pnpm check` green; new `tests/e2e/finance-phase4.test.ts`: 20 tests
  covering every Phase 4 matrix row. TEST_MATRIX.md ticked (incl. the
  `refunds.threshold-second-approval` → `refunds.every-refund-needs-approver`
  + `refunds.superadmin-bypass-audited` rename).
- Full `pnpm test:e2e` to green (incl. portal-invoices regression,
  saved-cards suites, cms-rbac with the new routes); fix what breaks.

### Deferred / STOP conditions

- None triggered. No customer-response change was unavoidable.
- Phase 5 owns: investor views/exports, purge (explicitly out of scope).

---

## 13. Phase 5 build note (2026-10-30, backend-agent)

Built per brief §6 Phase 5 + owner Q-decisions in force (Q10 FINAL investor
content; purge explicitly out of scope; Q8 rule stands — spec formulas
only, engine/returns untouched). §§1–12 above are history and are NOT
rewritten.

### What shipped

- **Investor role + masked surface.** `bill-investor` resource (view-only)
  in `src/lib/permissions.ts`; `INVESTOR` system role seeded with exactly
  that one permission (zero members — Owner assigns); `VIEWER` hidden-set
  and `MANAGER` deny-list updated so the masked surface stays investor-only
  (finance staff keep `bill-investor:view` via `FINANCE_VIEW_ALL`).
  Migration `20261030000006_finance_phase5_investor` (additive, idempotent
  `ON CONFLICT DO NOTHING`): INVESTOR role row + five grant rows.
- **Core** (`src/core/finance/investor.ts`): `getInvestorSummary` over
  approved-only data — CURRENT model + returns (horizon Y5) + CLOSED-month
  actuals + issued/paid aggregates (counts + rounded sums). No drafts, no
  open-month data, no names/emails/phones/ids/refs — by construction and by
  test. Q10 content: occupancy rate, earned PSF (2dp), ramp-up sqft,
  sign-ups (units), move-out rate, avg tenure (tenant aggregates), avg
  customer value, total revenue; amounts rounded whole, percents 1dp
  (spec §7.4). Every output carries the `MASKED SUMMARY — APPROVED DATA
  ONLY` watermark; `investorSummaryCsv` renders psf with exactly 2dp.
- **CMS routes** (thin, `requireAuth` + `routePermissions` + audited CSV):
  `GET /finance/investor/summary`, `GET /finance/investor/summary.csv`
  (EXPORT_GENERATED with `masked: true`). Customer API untouched.
- **UI**: `financeInvestorView.js` (watermark banner, modelling + returns +
  closed-month actuals + aggregates + definitions, Print via
  `@media print` isolation + Export CSV), 13th subtab + panel, sidebar and
  permission-gating entries. Investor sees only this tab (all others
  `perm-hidden` + server 403).
- **WCAG 2.2 AA pass** (`docs/finance/ACCESSIBILITY_AUDIT.md`): live
  regions on all async states, `scope="col"` + `aria-label` on every
  finance table, labels on placeholder-only inputs, global `:focus-visible`
  (olive, ≈12:1), Escape/focus management on the approval dialog,
  reduced-motion guard, investor print stylesheet. Residuals R-1–R-3
  recorded (manual AT pass recommended pre-launch; skip-link + `--red`
  are app-shell concerns).
- **Performance (§25.3, measured on the worktree-local TEST DB at
  §28 scale — 76 units, 28 tenants/invoices):** overview 45ms accrual /
  29ms cash (target <2s); projection 3ms @60mo / 1ms @120mo (targets
  <1s/<3s); month-table payload 17KB/35KB. EXPLAIN: invoice + audit +
  correlation reads all index-backed; outbox `status` seq-scans only at
  trivial table size (index exists for growth — no change). One genuine
  fix: invoice + transaction registers were unbounded `findMany` — now
  server-side `take: 500` (existing 200–500 convention). Async export
  queue deferred (D-2 — current CSVs are KB-scale filtered datasets).
- **Security review** (`docs/finance/SECURITY_REVIEW.md`): 5 findings,
  0 critical. Route→permission proof (table test + 19-route investor 403
  matrix), masked-field key/value assertions, full mutation-guard table
  (idempotency/version/maker-checker), bypass-audit coverage, secrets/PII
  grep. F-02/F-03/F-05 accepted-and-documented, F-01/F-04 fixed.
- **Runbook** (`docs/finance/RUNBOOK.md`): lane prerequisites (RBAC and
  saved-cards verified NOT on `develop` — merge-order decision needed),
  migration chain 00000→00006, seed/role bootstrap + `finance.*` defaults,
  test command, rollback notes (Phase 3 enum type-swap is forward-only),
  outstanding owner items.
- **Matrix**: `TEST_MATRIX.md` investor row ✅, §29 checklist completed
  (21/22 ticked; charts-hover/zoom marked PARTIAL with D-1), Deferred
  D-1–D-8 listed explicitly.

### Verification

- `pnpm check` green; new `tests/e2e/finance-phase5.test.ts`: 5 tests
  (watermark + approved-only + Q10 formatting, PII-free JSON + CSV,
  no-CURRENT 404, 19-route 403 matrix, operator visibility + export audit).
- `tests/e2e/cms-rbac.test.ts` extended with an investor gating block.
- Full `pnpm test:e2e` to green (incl. portal-invoices, saved-cards,
  finance-phase1–4); fix what breaks.

### Calls made inside delegated scope (flagged, not owner questions)

- Investor aggregates read live Tenant rows for averages/counts only
  (tenure, avg value, occupancy) — no tenant row, name or id crosses the
  API boundary; branch identity (code/name) is included as facility
  context, not PII.
- Finance Operator/Approver/Auditor granted `bill-investor:view` (same
  masked payload — safe by construction); Manager denied (keeps the
  existing 3-tab finance surface); Viewer hidden (Finance stays hidden).
- No `StorageAgreement`, no purge, no bulk paths, no customer-response
  changes, no secrets in code/logs.

### Deferred / STOP conditions

- None triggered.
- D-1–D-8 recorded in TEST_MATRIX.md (charts interactivity, async
  exports, cursor pagination, header keys on 3 creation paths, operator
  PII minimization, AT pass/skip-link/`--red`, Q8 amendment wait, open
  owner items).

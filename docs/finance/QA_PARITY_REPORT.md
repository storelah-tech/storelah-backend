# Finance module — end-to-end QA and prototype parity report

**Date:** 2026-10-30
**Build under test:** worktree `storelah-backend/_worktrees/finance-module` (branch
`feature/9-finance-module`, base `7bab036`; all finance work is still uncommitted).
**Reference:** https://storelah-crm-leads.faisal-0213.chatgpt.site (Finance Management, all 12 sub-pages).
**Spec:** `docs/finance/FINANCE_MODULE_SPEC.md`.

## Verdict

**The build does not match the prototype, and it is not ready to sign off.**

- **Server side is mostly solid.** The calculation engine reproduces the prototype's numbers
  exactly, and most controls behave as the spec requires. The full test suite is green.
- **UI does not match.** Five of the twelve screens render blank. The screens that do render are
  developer-style forms, not the prototype's layouts. Fields, charts, actions and terminology
  differ on every page.
- **Billing does not work.** The monthly billing run finds no tenants on a seeded database (see F-3).

## How it was tested

| Check | Result |
|---|---|
| `pnpm check` (tsc) | pass |
| `pnpm test:e2e` (27 files) | **302/302 pass**, including finance phases 1–5, projection fixtures and `cms-rbac` |
| Live CMS | Ran on port 4151 against a new local DB `storelah_finance_qa`, seeded with 3 branches, 720 units, 291 tenants and 288 invoices. Signed in as a QA Owner account (local test account only). |
| Prototype | Every finance sub-page opened. An inventory was taken of headings, buttons, table columns, selectors and KPI values. |
| API flows | Exercised directly against the live server: model CRUD, optimistic lock, scenarios, library, budgets, refunds, billing run, reconciliation, performance, overview. |

The worktree's own dev DB (`storelah_finance`) is empty and was not touched.

## A. Calculation engine — matches

The §28 Sembawang reference model was run through `projectModel` and compared with the
prototype's Financial Models and Investment Returns pages.

| Metric | Prototype | Build |
|---|---|---|
| Weighted start PSF | $5.64 | 5.6384 |
| Month 1 (Dec 26) | 180 sqft, 7.9%, revenue $1,015, cost $6,200, NOI −$5,185, cash −$113,185 | identical |
| Month 7 (Jun 27) | move-out 27, closing 1,178, NOI $442 | identical |
| Year 1 / 2 / 3 NOI | −$5,417 / $65,147 / $75,773 | −$5,417.84 / $65,146.8 / $75,772.8 |
| Y5 NOI, margin | $84,919, 53.3% | identical |
| NOI-positive / stabilised / payback | M7 / M18 / M32 | 7 / 18 / 32 |
| IRR through Y5 | 39.5% | 0.3949 |

Downside scenario runs as an overlay. The base model is unchanged afterwards.

## B. Functional defects found (fix before parity work)

| # | Severity | Defect | Evidence |
|---|---|---|---|
| F-1 | **Blocker** | **Models, Budgets, Pricing, Returns and Library render nothing.** Their views look up `#financeModels`, `#financeBudgets`, `#financePricing`, `#financeReturns` and `#financeLibrary`. `dashboard.html` only provides `<div data-fin-mount>` in those panels, so each binder returns silently. No API call is made. | `financeModelsView.js:107`, `financeBudgetsView.js:26` and the same in Pricing, Returns and Library vs `dashboard.html:1939-1956`. Once the ids were injected in the browser, all five rendered and called their APIs. |
| F-2 | **Blocker** | **Arrears screen is broken.** `GET /finance/arrears/waivers` is shadowed by `GET /finance/arrears/:id`, so it returns 404 "Arrears case not found". The view then fails and shows only Retry. The legacy "Overdue Invoices" table remains, and the panel has no `data-fin-mount`. | `src/routes/cms.ts`: the `:id` route is registered before `/waivers`. |
| F-3 | **High** | **Billing run creates zero invoices.** It filters `Tenant.branchId`. That field is null for all 288 seeded tenants, and it is never set by `tenants.ts:231` (CMS-created tenants) or `customers.ts:1186` (a booking path). Only `customers.ts:1356` sets it. The run reports `created:0, skipped:[]` with no warning. | `src/core/finance/billing.ts:568-569`. Should use `unit.branchId` (or backfill `Tenant.branchId`). |
| F-4 | **High** | **Performance (Forecast vs Actuals) errors in the default "All facilities" scope.** `/finance/performance` and `/finance/month-close` are called without `branchId`, which returns 400. The screen shows only Retry, not a "choose a facility" state. | network log + API response |
| F-5 | Medium | **Optimistic lock is optional.** A model section `PUT` without `version` is accepted, so lost updates are possible. Spec §11.7/§23.1 requires the expected version on every mutation. | `financeSectionSchema.version` is `.optional()`; the probe returned 200 |
| F-6 | Medium | **Refund calculator treats refundable credit/deposit as a deduction.** It demands a reason with no deduction or override present. | `{monthlyRent:300, daysInMonth:30, unusedDays:10, refundableCredit:50}` → 400 "A reason is required…" |
| F-7 | Medium | **Overview says "Not yet connected" for sources that now exist.** Failed payments and Credits & refunds show it although Phases 3/4 built them. Cash collected and Revenue billed share one tile that changes label, where the spec and prototype have two KPIs. | Overview screenshot / `overview` API |
| F-8 | Low | **Investor tab 404s with no CURRENT baseline.** It shows plain text, not the designed empty state. The library approve path is blocked by size-taxonomy mapping (correct per spec Q9), so the investor view cannot be reached on seed data. | `investor/summary` → 404 |
| F-9 | Low | **Legacy controls remain.** The header still has the dead "Export" and "＋ Create invoice" buttons, and the old `billingStats`/aging blocks still render under the new Overview. | `dashboard.html:1928-1934` |

Verified as working: stale `version` → 409 STALE with compare details; landlord-rent budget category rejected; negative refund flagged `negative:true`; deduction without reason rejected; reconciliation close blocked with a failing checklist; library approval blocked by missing inventory mapping; billing run idempotent; scenario overlay isolated.

## C. UI parity — screen by screen

Common to all screens:
- **Navigation.**
  - The prototype has one journey stepper: numbered steps 1–7 with sub-captions ("Position & cash" …) inside a "Financial planning & performance" card with "Investor-ready" and "Investor access".
  - The build stacks **three** nav rows: journey tabs, 13 subtabs, and a second "Journey:" pill row inside each view.
  - Sidebar labels are shortened ("Models", "Performance", "Pricing", "Library", "Credits"). The prototype uses "Financial models", "Forecast vs actuals", "Size mix & pricing", "Model library", "Credits & refunds".
  - The build adds a 13th "Investor" item. The prototype uses an "Investor access" button instead.
- **Planning toolbar.** The prototype's shared planning toolbar has Facility, Loaded model, Operational start and Downside/Base/Upside buttons. It is missing, and each view has its own selects.
- **Number formatting.** It does not follow spec §7.4. The build shows `1632.45`, `$-5,417.84` and `$65,146.8`. The prototype shows `1,632 sq ft`, `-$5,417` and `$65,147`.
- **Prototype affordances missing.** The `?` info tips on KPIs and table headers, and "How calculations work" / "Definitions" panels.

| Screen | Prototype has | Build has / missing |
|---|---|---|
| 1 Overview | Reporting period (8 presets), facility, basis; Export summary; Open payment operations; 6 primary + 4 secondary KPI tiles with values; Collection performance **bar chart**; Cash & control snapshot (6 tiles); Priority finance actions (Review / Approve individually / Calculate & review); Finance health checks; Definitions | Facility + basis only (**no period selector**); 9 tiles, 2 "Not yet connected"; collection rate as a plain table; snapshot and health checks present; **no priority actions**; no "Open payment operations" |
| 2 Transactions | Period / status / processor filters; 10-column register (Transaction ID, Processor ref, Scheduled, Customer/unit, Invoice, Method, Amount, Status, Approved by, Action); Review & approve modal; ＋ Calculate refund; Export transactions; Payment control policy | Facility + status filters, register, "Queue instruction" form; no period/processor filter, no export, no policy panel. Register empty because no invoices could be billed (F-3). |
| 3 Financial models | KPI strip (Y1 area, Y1 net move-in, 1/3/5-yr cash, Y1–Y3 NOI+margin); 12/24/All 60/Yearly summary + Download CSV; **3 charts** (area ramp, monthly space movement, revenue vs cost) with Zoom; sections **1 Occupancy plan · 2 Capital investment (itemised, ＋ Add item) · 3 Customer pricing (7-yr projection table) · 4 Landlord lease (7 lease years, UFA, rent-free, implied PSF table)**, each with Undo/Update; Calculation checks; Operating milestones | Blank (F-1). With ids injected: KPI strip without 1/3/5-yr cash; month table OK; 2 charts (no space-movement chart, cost not plotted); sections are **A Model inputs · B Occupancy & pricing · C Size mix · D Opex, lease & capital** (capital is one total, not items; no lease-year table or UFA); no milestones |
| 4 Forecast vs actuals | Facility / loaded model / reporting window / actuals-posted-through; 14-column monthly bridge (Budget/Forecast/Actual × revenue, occupancy, costs, NOI + Status); Month-end workflow; Import accounting actuals; Prepare month close; Export; How forecast becomes actual | Errors in default scope (F-4). With a branch: a single-month metric list, not the 12/24/60-month bridge |
| 5 Budgets & expenses | Budget month selector, view selector, "When Update is clicked" scope; Monthly operating budget table with Undo/Update + Submit revised budget; Expense mix chart; How the figures work; Individual expenditure table (Date, Ref, Vendor, Description, Category, Amount, Status, Note) + ＋ Add expenditure / ＋ Add category | Blank (F-1). With ids injected: facility + scope, "New budget line" form, expenditure ledger + Export CSV; no month selector, no budget table with actual/committed/forecast/variance, no expense-mix chart |
| 6 Size mix & pricing | Size mix and net rental rate table (editable NLA/units/PSF), Rent potential by size chart, Pricing guardrails, View unit inventory, Sync size mix, Suggest mix | Blank (F-1). With ids injected: facility + Sync from Facilities only |
| 7 Investment returns | 6 headline tiles; Investor return summary; IRR progression table (Y1–Y5); Simple return sensitivity (3 cases with Apply); Scenario comparison; Committed capital assumptions + Edit capital | Blank (F-1). With ids injected: facility / model / horizon selects only on seed data |
| 8 Model library | Model cards (Sembawang Launch Plan, Conservative, Template) with View forecast / Open inputs / Duplicate; templates; Version and approval history table (Version, Change, Changed by, Approved by, Effective from, Status, Action) with Load / Restore as draft / Compare; Export audit log | Blank (F-1). With ids injected: list with Approve / Reject / Open inputs / Set as Current / Audit history; no templates, no Compare, no history table |
| 9 Invoices | Status / facility / month filters; columns Invoice, Customer, Agreement, Issue/due, Rent, Add-ons, Credits, Total, Status, Action (Open / Recover) | Workspace + register of 288 with New invoice and Billing run; columns differ (no Agreement, Rent/Add-ons/Credits split); the legacy Invoices table still renders below |
| 10 Arrears | Sort; case table (Customer, Outstanding, Age, Last contact, Promise to pay, Access status, Case owner, Risk, Next action) | Broken (F-2); legacy 4-column overdue table |
| 11 Credits & refunds | Refunds to original payment method table (11 columns, Open/Track/Retry); StoreLah Credits ledger (＋ Adjust credit); Refund approvals (Review); ＋ Create refund | Credit wallet, refund calculator, refunds list; no ledger table columns, no approvals queue as designed |
| 12 Reconciliation | Daily/Monthly toggle; summary tiles (receipts, invoices posted, refunds, net variance, days closed); Daily close summary table; Unmatched items with Match/Review; Open reconciliation workspace | Settlement import form, unmatched/partial/suspense/matched lists, close checklist; no daily/monthly view, summary tiles or daily table |

## D. Recommended next dispatch (backend-agent, same worktree)

1. Fix F-1 to F-9, adding a regression test for each where it is testable server-side. Include a
   UI smoke test that asserts every finance panel renders non-empty.
2. **UI parity pass, screen by screen, against the prototype.** Rebuild each view's layout to
   mirror the prototype's sections, columns, controls and copy (section C). Specifically:
   - the single numbered journey stepper;
   - the shared planning toolbar (facility / loaded model / operational start / scenario buttons);
   - the prototype's four model sections (occupancy, itemised capital, customer pricing with the
     7-year table, landlord lease with lease-year rows, UFA and rent-free);
   - the missing charts and spec §7.4 number formatting;
   - sidebar labels matching the prototype.

   Evidence-driven: take the prototype screenshot and the CMS screenshot per screen, and keep
   the CMS design tokens.
3. Re-run this report afterwards. Parity is reached when every row in section C reads "matches".

---

## Re-run — 2026-10-30 19:30 (after the "fixes + parity" dispatch)

**Verdict: WP-A (defect fixes) is mostly done. WP-B (shared frame) and WP-C (screen parity)
were not done. The UI still does not match the prototype. One new regression breaks the
Overview screen.**

The orchestrator wrote **no decision-log entries** for this work. It also produced no
`docs/finance/parity/` inventories or screenshots, and did not update this report. That is
against the brief (sections 3, 5 and 6). All findings below come from re-checking the
worktree directly.

### Defects

| # | Status | Evidence |
|---|---|---|
| F-1 blank screens | **Fixed** | All 13 panels render. `getFinMount()` is used everywhere, and `finance-wp-a.test.ts` asserts it. |
| F-2 waivers route | **Fixed** | `GET /finance/arrears/waivers` → 200. The Arrears panel renders cases, candidates and waivers. |
| F-3 billing run | **Fixed** | 2027-01 run on Sembawang created 96 drafts. Both tenant create sites now set `branchId`. Backfill migration `20261030000007` (data-only, idempotent) is applied to the QA DB. |
| F-4 performance scope | **Fixed in UI** | The view defaults to the first facility. The API still returns 400 without `branchId`, which is acceptable. |
| F-5 optional version | **Fixed** | Section PUT without `version` → 400. |
| F-6 refund reason | **Fixed** | Credit-only calculation → 200, final $150. |
| F-7 overview | **Regressed — Overview screen broken.** The new period picker sends ISO timestamps (`from=2026-05-01T00:00:00.000Z`), but the API only accepts `YYYY-MM-DD`. Every load returns 400, and the screen shows only "Couldn't load this screen … Retry". With `YYYY-MM-DD` the API works: Revenue billed and Cash collected are now separate KPIs, and Failed payments and Credits & refunds are connected. The WP-A test calls the API with dates directly, so it missed the front-end format. | `financeOverviewView.js:53-55` / `financeShared.js reportingRange()` vs the overview zod schema in `src/routes/cms.ts` |
| F-8 investor empty state | Fixed | "Investor Summary" designed empty state with a library link. |
| F-9 legacy leftovers | Fixed | Header buttons and legacy tables removed. |

Data note: Cash collected = 0 on the seed data, because seeded PAID invoices carry no payment
allocations. This is expected under the cash-basis definition (§7.2); it is not a defect.
Minor: draft invoices for billing month 2027-01 are numbered `INV-2026-…`. Numbering appears
to use the run date, not the service period. Confirm with the owner which is intended.

### UI parity — unchanged since the first run

- **Navigation.** Still two stacked tab rows plus the in-view "Journey:" pills. There is no
  numbered stepper card and no "Investor access" button. The sidebar still shows short labels
  (Models, Performance, Budgets, Pricing, Returns, Library, Credits) plus a 13th "Investor"
  item. The header has no actions at all (Reconciliation, Billing settings and ＋ Create invoice
  are missing).
- **No shared planning toolbar**, no Downside/Base/Upside buttons, no §7.4 number formatter,
  and no chart helper (zoom, legend, range).
- **Financial models.** Still has sections A–D (`src/core/finance/models.ts` unchanged since
  13:04). It does not have the prototype's Occupancy plan, itemised Capital investment, Customer
  pricing (7-year table) and Landlord lease (lease years, UFA) sections. Still 2 charts, no
  space-movement chart, no milestones.
- **Budgets & expenses** gained the monthly category table (Category, Budget, Actual,
  Committed, Forecast, Variance, Owner, Action). Still missing: the month/view selects, the
  linked lease row label, the expense-mix chart, and the expenditure table columns.
- **Size mix & pricing** gained an editable category table. Still missing: the prototype's
  NLA/units/net PSF/rent potential layout, the rent-potential chart, guardrails, and the
  Suggest mix and View unit inventory actions.
- **Forecast vs actuals** is still a single-month metric list, not the 14-column monthly bridge.
- **Overview, Transactions, Investment returns, Model library, Invoices, Arrears, Credits &
  refunds, Reconciliation** are structurally the same as in section C of the first run.

### Required next steps

1. Fix the F-7 regression: send `YYYY-MM-DD`, or accept ISO in the schema. Add a test that
   drives the real view's request, not a hand-built URL.
2. Execute WP-B, then WP-C1–C3 from `.opencode/briefs/finance-module-fixes.md`, with the
   per-screen prototype/CMS inventories and screenshots in `docs/finance/parity/`, and a
   decision-log entry per dispatch.

Checks on this re-run: `pnpm check` passes; `pnpm test:e2e` **28 files / 312 tests pass**
(this includes the new `finance-wp-a.test.ts`). Golden numbers unchanged: PSF 5.6384, payback
M32, stabilised M18, IRR 39.49%. The green suite did not catch the Overview regression.

### F-7 regression fixed — 2026-10-30 (Claude Code orchestrator session)

- **Cause:** the view sent ISO timestamps; the shared date-range schema expects `YYYY-MM-DD`.
- **Fix:** `reportingRange()` moved to a new pure module, `src/cms/admin/financePeriods.js`. It
  now returns `YYYY-MM-DD` with inclusive UTC month bounds. `financeShared.js` re-exports it,
  so no call sites changed. The API schema is unchanged, because 12 other list endpoints share
  it.
- **Test:** new test in `finance-wp-a.test.ts`. It sends the view's own output for all 8 presets
  (with a fixed January date, to cover year rollover) to `/finance/overview` and
  `/export.csv`, and checks the month bounds.
- **Checks:**
  - `pnpm check` passes.
  - `pnpm test:e2e` **28 files / 313 tests pass**.
  - In the browser, all 8 presets load the Overview. Requests use `from=YYYY-MM-DD&to=YYYY-MM-DD`,
    and the export returns 200.

---

## Parity build — 2026-10-30 (Claude Code orchestrator session, WP-B + WP-C)

**Approach.** The owner's prototype script (`financial-model.js`) was ported
into the CMS as `src/cms/admin/financeWorkspace.js`. Its templates and
interactions are kept, and its panel ids are mapped to the CMS ids, so the RBAC
keys are unchanged. Its demo data, localStorage and local-only actions are
replaced by a CMS data layer:

- Models, the library, expenses, transactions, the overview, posted actuals and
  live inventory all load from `/api/v1/cms/finance/*`.
- Every committed edit (the four section Updates, budget Update, size-mix edits,
  operational start) is PUT to the model with a required version.
- The prototype's client engine is used only for previews. After every load and
  save, its annual NOI and payback are compared with the server projection. The
  "Server engine agrees" calculation check shows the result.

`finance.css` is the prototype's `financial-model.css` plus 13 shared ops rules
the CMS shell lacked. It uses the CMS `:root` tokens.

**Server additions**
- Engine:
  - per-month approved opex overrides (scoped budget Update);
  - opex categories derive `baseMonthly`, and lease-named categories are
    rejected;
  - `capitalItems` derive `capitalTotal`;
  - size `range`;
  - a 7-year lease with UFA.
- New model template (the §28 itemised values, with golden numbers unchanged).
- Sections `occupancy` / `capital` / `pricing` / `lease`. The legacy
  `assumptions` / `opex` sections are kept.
- Expense `description` / `status` / `note`, plus `PUT /finance/expenses/:id`.
  Closed months are locked.
- `GET /finance/performance/series` returns closed months only, with
  adjustments folded in, and the CURRENT baseline.
- `GET /finance/credits/ledger`.
- Size labels XS/S/M/L alias to the live buckets for the approval mapping check.

**Screen status vs the prototype (section C rows)**

| Screen | Status |
|---|---|
| Navigation / header | **Matches.** One journey card (7 numbered steps, Investor access) and the prototype sidebar labels. Legacy tab rows are hidden. Per-screen H1, purpose line and header actions follow the prototype. The Investor view opens from Investor access, not the sidebar. |
| Finance overview | **Matches layout.** Period presets (Today … Custom), facility, basis, 6 KPIs + 4 ops KPIs with lineage tips, collection bars, snapshot, priority actions, health checks. Values are live, and unconnected sources show "—". |
| Transactions & approvals | **Matches.** 10-column register, KPIs, manual-approval banner, Review & approve (server approve with version), refund calculator (server refund case). |
| Financial models | **Matches.** 8 KPIs, the 12/24/60 table, 3 charts with hover and zoom, the four staged sections with Undo/Update saved to the server, calculation checks + server agreement, milestones. Reference model numbers are identical to the prototype. |
| Forecast vs actuals | **Matches, minus sample actuals.** The 14-column bridge has Budget = CURRENT model, Forecast = loaded model, and Actual = posted months only. The "Hide sample actuals" toggle is removed (spec §12.1). Prepare close posts through the server checklist. |
| Budgets & expenses | **Matches.** Month / view / scope selects, model-linked lease row, staged Update saved to the model (month-only = override), expense mix, ledger with add/edit saved to the server. |
| Size mix & pricing | **Matches.** Editable mix (saved), rent-potential bars, guardrails. Sync from the live Unit inventory replaces NLA and units only. |
| Investment returns | **Matches.** Tiles, summary, IRR progression, sensitivity cases, scenario comparison, read-only committed capital. |
| Model library | **Matches structure.** Live model cards with status-driven actions (submit / approve / reject / set current / archive / duplicate). Live version history with Restore as draft. Live audit modal and CSV. The built-in "Conservative case" card is replaced by the downside-scenario preview option, and the template card creates from the server template. |
| Invoices | **Matches columns.** Status / facility / month filters; Open → approve / issue; Recover → arrears. "Add-ons" shows "—" because the register API does not split line types. "Agreement" shows the unit (there is no agreement entity). |
| Arrears | **Matches columns.** "Last contact" uses the case note. "Promise to pay" shows "—" (not tracked yet). |
| Credits & refunds | **Matches.** Refunds table (11 columns), cross-customer credit ledger, approvals queue with Review (server approve). |
| Reconciliation | **Matches.** Daily/Monthly switch, summary strip, daily close table (receipts per day; invoices/refunds per day show "—", which the API does not break down), unmatched items. |

The previous operational tools for Invoices, Arrears, Credits and Reconciliation
remain under a collapsible "tools" section on each screen. Nothing functional
was dropped.

**Checks**
- `pnpm check` passes.
- Full `pnpm test:e2e` — see the log entry for the count. It includes the new
  `finance-parity.test.ts` (7 tests).
- Browser, on the QA DB:
  - all 12 screens render with no console errors;
  - a section Update persists (server v1, Y1 NOI $669.04 vs preview $670);
  - a budget Update persists (base $1,350, v2);
  - an expenditure saves to the ledger;
  - no horizontal scroll at 768 px on any screen.
- Not covered: a manual screen-reader pass, and live Stripe processing (test
  mode, mocked in tests).

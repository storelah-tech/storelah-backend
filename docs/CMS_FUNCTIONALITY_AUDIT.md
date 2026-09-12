# CMS Functionality Audit — `src/cms/admin/` (audit only, no fixes)

Date: 2026-09-12. Live server probed at `http://localhost:4000` (seeded DB).
2026-09-12 update: promo Phase 5 implemented (§5 statuses updated below for items
actually fixed and curl-verified; everything else untouched).
Scope: ONLY `src/cms/admin/` (`admin.js`, `*View.js`, `dashboard.html`, `dom.js`,
`confirmDialog.js`, `api.js`, `state.js`). Frozen legacy `src/cms/dashboard.html` +
`data-layer.js` is out of scope. No code, migration, or seed changes were made
(`db:seed` never run).

Status legend: **WORKS** · **BROKEN-UI** (dead/miswired handler, static copy where
live data expected) · **BROKEN-API** (endpoint missing/errors, or empty despite
seeded data) · **UI-ONLY-NO-MODEL** (mock UI, no Prisma model / backend design
needed) · **NEEDS-OPS-DECISION** (functions, but needs a product call).

## 0. Checklist source (the full nav tree)

`sideNav` in `src/cms/admin/admin.js:45-57` is the checklist. Top-level sidebar
buttons in `src/cms/admin/dashboard.html:622-628`: Overview(command),
Leads Management, Customer Management, Facilities Management,
Discount & Promotion, Finance Management, Global Settings. There is **no Admin
section** in the new nav (see §9). Submenus are generated at runtime from
`sideNav` (`admin.js:60-73`); page switching via `openPage`/`openPanel`
(`admin.js:95-149`) is wired and works for every entry — nav render/switch itself
is WORKS across the board. Findings below are about what happens *after* you land.

Live API baseline (all 200): `/summary /leads /leads/stats /appointments
/action-items /invoices /bookings /move-ins /promotions /promotion-plans
/safeguards /branches /floors /sizes /tenants /units /units/activity`.
Seeded payload sizes: leads 8 (3 NEW / 2 CONTACTED / 1 VIEWING / 1 PROPOSAL /
1 WON / 0 LOST), appointments 12, invoices 289, bookings 4, move-ins 0,
promotions 0, promotion-plans 1, safeguards 0, action-items 0, units 720.

---

## 1. Command core (`command`)

| Item | Status | Evidence (file:line + endpoint + model) | Notes |
|---|---|---|---|
| Command centre (`#command`) | WORKS | `admin.js:184-247` → `GET /summary` (`core/summary.ts`), `GET /leads` (`Lead`), `GET /action-items` (`core/actionCenter.ts`), `GET /units/activity` | Stats, funnel, priority queue, sources, activity all live. `action-items` returns `[]` on seed (honest empty). |
| Team pulse card | BROKEN-UI | `admin.js:229-233` hardcoded Nur/Marcus/Ravi table | Static placeholder; no staff model. Needs ops decision on whether to keep, wire, or drop. |
| Revenue / Occupancy charts | NEEDS-OPS-DECISION | `dashboardView.js:125-147` static seed data; `bindCharts` (`dashboardView.js:32-51`) live-updates from `summary.monthlyRevenue` / `occupancyByBranch` (`core/summary.ts:52-57`) | Works, but initial paint is static sample until `bindCharts` runs; mini-tab Revenue/Occupancy toggle (`dashboard.html:665`) has no handler. |
| `bindKpis` | BROKEN-UI (dead code) | `dashboardView.js:13-14` targets `.kpi-strip .kpi` — no such markup in `dashboard.html` (only CSS refs) | Harmless: command page uses `cmd*` ids instead. Remove or repoint. |
| Today / Run today's operations buttons | BROKEN-UI | `dashboard.html:649`, no listener in `admin.js` | Dead. |
| Global search, Tasks/Notifications icons | BROKEN-UI | `#globalSearch` (`dashboard.html:636`), icon buttons (`dashboard.html:638-639`); zero listeners | Dead. ⌘K hint non-functional. |
| Performance dashboards (`#analytics`, sideNav `analytics` under both command and leads cores) | WORKS (2026-09-12) | `admin.js` `bindAnalytics` → `GET /leads/stats` (extended: `conversionByFacility` + `overallConversionPct`, `medianFirstResponseMin` + `firstResponseSample`, `lostCount/lostValue/lossReasonBreakdown`, `scorecard`, `enquiries/qualified/bookings`) + `GET /analytics/weekly?weeks=N` → `#analyticsStats` (5 kept KPI tiles + 5 new tiles), `#anaChart` weekly chart with Volume/Value mini-tabs, `#convByFacility` bar-rows, JS-appended `#anaExtra` (advisor scorecard table + loss-reason bars); Export downloads CSV built from the same endpoints, Share copies `#analytics` deep link + toast | First-response = earliest OUTBOUND message per lead (no migration; notes excluded; n reported, honest empty when 0). Loss attribution = `Lead.lossReason/lossValue` (migration `20260912000001_lead_loss_fields`); LOST transition defaults reason "Unspecified" + value = monthlyRate. Quality = round(50·contactRate + 50·conversion), documented in `core/leads.ts`. Loss picker = `window.prompt` (cancel aborts); Share = clipboard copy of hash link. |

## 2. Leads core (`leads`)

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Lead database (`#leads`) | WORKS | `admin.js:259-282` → `GET /leads` (`Lead` model, 8 rows live); row Edit/Delete via `PATCH/DELETE /leads/:id` | Table renders; select-all delegation via `initSelectAll` works. |
| Lead status/source filters, Import/Export, pagination, List/Board seg | WORKS (2026-09-12) | `#leadStatusFilter #leadSourceFilter` filter client-side; pager `‹ n/m ›` paginates 10/page; Export downloads CSV; Import parses CSV → `POST /leads` per row (`admin.js` `importLeadsCsv/exportLeadsCsv`) | "More filters" button still dead (no-op). |
| Add lead (topbar `#addLeadBtn`, `#addLeadBtn2`, pipeline header button) | WORKS (2026-09-12) | Lead modal → `POST /leads` (zod) + edit via `PATCH /leads/:id`, delete via `DELETE` + confirmDialog (`core/leads.ts`); new `email/mobile/owner/nextActionAt` columns (migration `leads_conversations`) | — |
| Pipeline (`#pipeline`) | WORKS (2026-09-12) | Kanban live from `/leads`; HTML5 drag-drop persists stage via `PATCH /leads/:id`; `#pipelineFilter` filters by facility (`admin.js` `wirePipelineDragDrop`) | — |
| Conversations (`#inbox`) | WORKS (2026-09-12, send = stub) | `Conversation`/`Message`/`ConversationNote` models + `core/conversations.ts`; `GET /conversations`, `GET /conversations/:id/messages` (unified timeline), `POST …/notes`, `POST …/messages` (**stub**: records OUT message, `delivered:false` — real WhatsApp/email sending still NEEDS-OPS-DECISION), `PATCH /conversations/:id` (Assign). Inbox reads real threads; Assign/New message/Templates/Send wired (Templates = 3 static presets; composer `/note …` prefix saves an internal note) | Backfill script `scripts/backfill-conversations.ts` gave each existing lead one thread. |
| Appointments (`#calendar`) | WORKS (2026-09-12) | `GET /appointments` (12 rows) + new `POST/PATCH/DELETE /appointments` (`core/appointments.ts`); ＋Schedule modal; Today-list Edit/Cancel (cancel = `PATCH … {status:CANCELLED}` + confirmDialog) | Move-in-type events tint green — fine. |
| Sales analytics | WORKS — see Performance dashboards (§1) | same `#analytics` page | — |
| Automation (`#automation`) | UI-ONLY-NO-MODEL | `admin.js:439-449`: only two pill counts derived from `GET /action-items` (0 rows on seed → "0 alerts"); six workflow cards + `.sw` toggles (`dashboard.html:712-718`) static, no listeners; ＋Create workflow dead | No workflow/automation-rule model. Phase 7; likely NEEDS-OPS-DECISION on scope (real engine vs. remove). |

## 3. Customers core (`customers`) — tabs Tenants / Bookings / Move-ins

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Tab switching | WORKS | `admin.js:978-992` `data-tabs="customer"` handler; sideNav panels `customer-tenants/bookings/moveins` (`admin.js:49-50`) | — |
| Tenants | WORKS | `tenantsView.js` full CRUD → `GET/POST/PUT/DELETE /tenants` (`core/tenants.ts`, `Tenant` model); search/filter/pager wired (`admin.js:1099-1113`) | — |
| Bookings | WORKS (read) | `bookingsView.js:50-81` → `GET /bookings` (`core/finance.ts`, 4 rows); search + status filter wired (`admin.js:1060-1061`) | No booking create/cancel/status-change UI or routes (BROKEN-API gap, Phase 4). |
| Move-ins | WORKS (read) | `bookingsView.js:83-101` → `GET /move-ins` (0 today = honest empty state) | No controls by design; fine. |
| ＋New customer header button | BROKEN-UI | `dashboard.html:724`, no listener (only in-tab `#addTenantBtn` works) | Wire to tenant modal or remove. |

## 4. Facilities core (`facilities`) — tabs Unit map / Units / Floor plans / Promotions

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Tab switching | WORKS | `admin.js:961-976` handler; lazy-loads map/units/floorplans/promos per tab | — |
| Unit map (`facility-map`) | WORKS (per-branch) | `dashboardView.js:101-122` → `GET /units/map` (`core/units.ts getUnitMap`); floor tabs/legend/grid live | NEEDS-OPS-DECISION: All-Facilities shows placeholder "Select a facility above" (a floor map is inherently per-facility) — confirm desired. `sbBranchSelect` change handler (`admin.js:1022-1028`) re-renders then jumps to command — jump looks unintentional, review. |
| Unit detail actions | WORKS except History | Edit / Adjust Rate / Delete wired (`admin.js:1084-1097` → `PUT/POST :code/rate/DELETE /units/:code`); **`#viewHistoryBtn` (`dashboard.html:765`) has no listener** | BROKEN-UI: History button dead (rate history data exists via `getUnitDetail`). |
| Units table (`facility-units`) | WORKS | `unitsView.js` → `GET /units` paged + `POST/PUT/DELETE`; status filter + pager wired (`admin.js:1063-1075`) | — |
| Floor plans (`facility-floorplans`) | WORKS | `floorplanView.js` editor: canvas upsert, placements, blocks, delete → `GET/POST/PUT/DELETE /floor-plans*` (`core/floorPlans.ts`, `FloorPlan/UnitPlacement/FloorPlanBlock`); buttons wired (`floorplanView.js:1295-1301`, incl. `fpSaveCanvas/fpDeletePlan/fpView*`) | Most complete module. Read-only preview (`unitShowFloorPlan`) works. |
| Facility Promotions (`facility-promos`) | REMOVED per owner direction | — | Duplicate summary removed; use the standalone Promotions section. |

## 5. Promotions core (`promotions`) — 8 panels

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Tab switching | WORKS | `admin.js:1006-1017` `data-tabs="promo"` handler | — |
| **Generic `data-tab-jump` navigation** | WORKS (2026-09-12) | Document-level delegated handler `installPromoTabJump` (`admin.js`); covers static + runtime-rendered buttons (`dashboard.html` promo section + `admin.js` library rows) | Fixed Phase 0 item 1. |
| Dashboard (`promo-overview`) | WORKS (partial, 2026-09-12) | Live: `#promoActiveCount` (kind breakdown), `#promoBookingsDiscounted` (= total redemptions), `#promoDiscountCost` (live $), promo cards + attention list from `GET /promotion-plans/performance` (`admin.js` `bindPromoPerformance`); honest `—` for effective revenue / conflicts | Revenue needs invoice joins (follow-up); conflicts need per-plan validate (follow-up). |
| Discount plan builder (`promo-discount-matrix`) | WORKS (save path) | Save Draft → `POST /promotion-plans`, update → `PUT /promotion-plans/:id` (`admin.js`); Duplicate → `POST …/duplicate` via `promoState.discountPlanId` (2026-09-12: nonexistent `#discountPlanId` fixed, API errors surfaced); validation modal renders REAL `POST /promotion-plans/:id/validate` checks; Schedule → save + `PATCH …/status` VALIDATED→SCHEDULED through the state machine | Remaining gap: (c) Facility/Storage-type filter buttons dead. Former gaps (a) static mock, (b) duplicate 404, (d) client-side-only status pill — all fixed 2026-09-12. |
| Free months (`promo-free-months`) | WORKS (2026-09-12) | `saveFreeMonthsPlan`/`loadFreeMonthsPlan` (`admin.js`) → kind FREE_MONTHS + `freeMonths` cells + `earlyExitTreatment`/`minStayPct`; injected Save draft/Reload bar; save → reload round-trips | Size-scope stores category labels (not UnitSize IDs) — documented simplification. |
| Promo code builder (`promo-code-builder`) | WORKS (2026-09-12) | `saveCodePlan`/`loadCodePlan` (`admin.js`) → kind PROMO_CODE + `rules`; injected Save draft/Reload bar; save → reload round-trips | Benefit choice+value stored as `description` line (`BENEFIT: …`) — documented simplification. No `POST /promotions` row created (plan is the source of truth). |
| Promotions library (`promo-library`) | WORKS (read) | `admin.js` replaces static rows with live plans + promotions | Open/Edit buttons fixed via the generic `data-tab-jump` handler (2026-09-12). Type/Status/Facility filter buttons still dead. |
| History (`promo-history`) | WORKS (2026-09-12) | Live version rows from `GET /promotion-plans/:id/versions` with plan picker, Restore-as-draft (`POST …/restore`), field-diff Compare (`GET …/compare`) | Diff is scalar-key level; per-row 36-cell matrix diffs are follow-up. |
| Safeguards (`promo-safeguards`) | WORKS (2026-09-12) | `bindSafeguards` (`admin.js`) CRUD-binds `GET/POST/DELETE /safeguards`; 3 default rules via `scripts/seed-safeguards.ts` (additive, idempotent — NOT db:seed); priority-config explicitly dropped (order fixed per spec §2.4, rendered as note) | — |
| Performance (`promo-performance`) | WORKS (partial, 2026-09-12) | `PromotionRedemption` model + migration; `POST/GET /promotion-plans/:id/redemptions`; `GET /promotion-plans/performance`; live applied/discount-cost/cap/budget table; honest `—` for revenue/retention/eligible-bookings | Booking-time auto-link is follow-up (no booking-create route in this service). |
| Deferred promotion-engine items (per brief) | PARTIAL (2026-09-12) | `validatePlan` now has rate-floor/overlap/sample-booking checks (`core/promotionPlans.ts`); redemptions model + endpoints exist; status state machine enforced in `setPlanStatus` (DRAFT→VALIDATED→SCHEDULED→ACTIVE→ENDED + VALIDATED/SCHEDULED→DRAFT rollback, ENDED terminal) with `approverRole` audit label; stacking/eligibility still never evaluated at booking time | `approverRole` is a self-declared label (no users/roles model — real RBAC is follow-up). |

## 6. Billing core (`billing`) — tabs Overview / Invoices / Arrears

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Tab switching + Overview + Invoices + Arrears | WORKS (read) | `admin.js:848-888` → `GET /invoices` (`Invoice`, 289 rows) + `/summary`; stats/aging/invoice/arrear tables render | Collection rate computed client-side; honest empty states. |
| Export / ＋Create invoice | BROKEN-UI + BROKEN-API | `dashboard.html:1104`, no listeners; **no `POST /invoices`, no pay/void endpoints** | Phase 4. |

## 7. Settings core (`settings`)

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Global Settings page | WORKS (2026-09-12) | `Setting` key/value model + migration `add_settings`; `src/core/settings.ts` (13 known keys, zod validation + toggle/text/number coercion); `GET /settings` + `PUT /settings` batch upsert (`src/routes/cms.ts`); additive idempotent `scripts/seed-settings.ts`; 5 grouped setting cards (`dashboard.html` `#settings`) mirroring the automation `.card.auto` + `.sw` toggle pattern (toggles wired for real), Save-all bar with dirty-dot state + toast + persisted-state reload (`admin.js` `bindSettings/saveSettings`) | The 3 dead static cards were replaced: Organisation → editable Display group (currency kept), Booking rules → editable Booking group, System (API/version display-only) dropped. |

## 8. Auth / shell

Login via `GET /api/cms/config` auto-login + `POST /login` Bearer JWT
(`api.js:20-36`, `src/middleware/auth.ts`) — WORKS, contract preserved. Sidebar
auto-expansion, hash routing, mobile drawer, modals/confirm dialog, toasts —
WORKS.

## 9. "Admin" checklist item

There is no Admin section in `sideNav` or the sidebar markup. Interpreted as the
legacy breakout views + CRUD modals: `closeAllViews` hides
`view-dashboard/units/tenants/bookings/moveins/floorplans` (`admin.js:88-92`,
none present in markup — harmless backward-compat) and unit/rate/tenant/floorplan
modals all open/close/submit correctly (WORKS). If "admin" meant user
management: **no admin-user UI exists** (only `AdminUser` model + login) —
UI-ONLY gap, needs ops decision.

---

## 10. COMPREHENSIVE phased implementation plan

Ordering: shell fixes → lead/booking money-path CRUD → promo engine completion →
settings → workflow/automation (ops-gated). Every item names model/migration,
core aggregate, route, and admin-view binding.

**Phase 0 — Dead-wire sweep (no migration; biggest click-nothing wins)**
1. Generic `data-tab-jump` handler in `wireEvents` (`admin.js` ~949): click →
   find `[data-tabs] [data-tab="<target>"]` → click (fixes ~12 promo buttons).
2. Wire dead buttons: `#viewHistoryBtn` → unit rate/tenant history panel;
   `#globalSearch` (+⌘K) → leads search or drop; Tasks/Notifications → drop or
   action-items drawer; command Today/Run-ops, mini-tabs, Import/Export (drop or
   CSV), `＋New customer` → tenant modal, billing Export/Create-invoice (drop
   until Phase 4), settings Save (drop until Phase 6), automation `.sw` toggles
   (visual only or drop until Phase 7).
3. Fix `duplicateDiscountPlan` (`admin.js:724-746`): track created plan id in
   module state instead of nonexistent `#discountPlanId`; surface API errors
   instead of swallowing.
4. Remove/repoint dead `bindKpis` `.kpi-strip` selectors (`dashboardView.js:13-14`)
   and dead `bindLeads/bindActions` (`#kanbanBoard/#alertList`, `admin.js:1188+`).
5. Decide `sbBranchSelect` → `openPage('command')` jump (`admin.js:1027`) and
   All-Facilities map placeholder (keep vs. aggregate map).

**Phase 1 — Leads become real CRUD**
- Migration: none (Lead model suffices; optional `owner`, `nextActionAt` fields).
- Core: `src/core/leads.ts` += `createLead/createAppointmentLink/updateLeadStage/addNote`.
- Routes (`src/routes/cms.ts`): `POST /leads`, `PATCH /leads/:id` (stage/contact),
  `DELETE /leads/:id`, lead notes sub-resource if keeping inbox notes client-side.
- Admin: Add-lead modal (replace toast), working status/source filters, pager,
  pipeline drag-drop persisting stage via `PATCH`, pipeline filter options.

**Phase 2 — Conversations inbox (has no API; full backend design)**
- Migration: `Conversation` (leadId, channel, externalId) + `Message`
  (conversationId, direction, body, sentAt, sender) models; optional `LeadNote`
  for the composer "Add a note".
- Core: new `src/core/conversations.ts` (threads, timeline, post-note/send stub).
- Routes: `GET /conversations`, `GET /conversations/:id/messages`,
  `POST /conversations/:id/notes` (+ send stub behind ops flag — real
  WhatsApp/email sending is NEEDS-OPS-DECISION).
- Admin: `bindInbox` reads threads/messages; wire Assign/New message/Templates/Send.

**Phase 3 — Appointments scheduling**
- Migration: none (`Appointment` exists; optional `leadId` link already there).
- Core: `src/core/appointments.ts` += create/update/cancel.
- Routes: `POST /appointments`, `PATCH /appointments/:id`, `DELETE`.
- Admin: Schedule modal; wire ＋Schedule; calendar edit/cancel actions.

**Phase 4 — Money path: bookings + invoices mutations**
- Migration: none for v1 (Booking/Invoice exist); payment receipts model later
  if needed.
- Core: `src/core/finance.ts` += booking confirm/cancel, invoice create/void/mark-paid.
- Routes: `PATCH /bookings/:id`, `POST /invoices`, `PATCH /invoices/:id/pay|void`.
- Admin: bookings row actions; billing Create-invoice modal + arrears actions.
- Ops: arrears dunning/ autopay behaviour is NEEDS-OPS-DECISION.

**Phase 5 — Promotion engine completion (deferred items)**
1. Validation engine: extend `validatePlan` (`core/promotionPlans.ts:361`) with
   rate-floor checks (vs `SafeguardRule`), overlap detection, sample-booking
   evaluation; **wire modal to `POST /promotion-plans/:id/validate`** and render
   real check list; gate scheduling on `valid`.
2. Status/approval state machine: enforce transitions in `setPlanStatus`
   (DRAFT→VALIDATED→SCHEDULED→ACTIVE→ENDED, guards + `approverRole`); wire
   schedule button through `PATCH …/status`; log approvals to `PromotionVersion`.
3. Builder persistence: free-months panel → create/update plan
   (kind FREE_MONTHS + `freeMonths` cells + `earlyExitTreatment`/`minStayPct`);
   code-builder panel → plan (kind PROMO_CODE + `rules`) and/or `POST /promotions`
   extended fields.
4. Safeguards UI: CRUD binding to `/safeguards`; priority-config UI or drop.
5. Performance aggregation: bookings↔plans linkage + `PromotionRedemption` model
   (planId, bookingId, amount, redeemedAt) + `GET /promotion-plans/performance`;
   replace static overview cards/performance/history panels.
6. History: expose versions (`GET /promotion-plans/:id/versions` or include) +
   restore-as-draft; replace static rows; wire Compare (diff view, ops-scoped).

**Phase 6 — Settings**
- Migration: `Setting(key, valueJson)` or typed `OrgSettings` singleton.
- Core `src/core/settings.ts`; routes `GET/PUT /settings`; Admin: form bindings +
  working Save. Smallest backend slice; do after promo engine.

**Phase 7 — Automation/workflows (ops-gated)**
- NEEDS-OPS-DECISION: real rules engine vs. static showcase vs. removal.
- If real: `WorkflowRule` model + `src/core/automation.ts` + CRUD routes +
  runner (cron/worker) + toggle bindings. Do not build until Phase 1–2 land.

**Phase 8 — Analytics depth**
- DONE 2026-09-12: `GET /leads/stats` extended with conversion-by-facility
  (+ overall), weekly series via `GET /analytics/weekly?weeks=N`, response-time
  proxy, lost-revenue attribution, owner-grouped scorecard in `core/leads.ts`;
  `#convByFacility`, scorecard, loss reasons, Export/Share all bound (see §1).
  Remaining: `#funnelPeriod` control never existed in markup — dropped.
  Team-pulse: keep static, wire to staff metrics (new model), or drop.

## 11. Counts & uncertainty

33 checklist entries audited (7 cores incl. 24 sub-tabs/panels + shell/auth).
Approx: 12 WORKS (nav switch, command read, leads/pipeline/calendar read,
tenants, bookings/move-ins read, unit map/units/floorplans, billing read,
auth/shell), 14 BROKEN-UI (incl. cross-cutting `data-tab-jump`), 6 BROKEN-API
gaps (lead/appointment/booking/invoice mutations, inbox, promo performance),
5 UI-ONLY-NO-MODEL (automation, settings, performance, safeguards-UI,
code/free-months persistence), 4 NEEDS-OPS-DECISION (team pulse, charts
initial-paint, All-Facilities map, automation/send/dunning scope).
Uncertain without browser run: drag intent on pipeline (no handlers found —
confident), `.sw` toggle CSS-only (no JS refs — confident), select-all in leads
(delegation present — likely works, untested in browser). `pnpm check` not run
(no code changes, per brief).

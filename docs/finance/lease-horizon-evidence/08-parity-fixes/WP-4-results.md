# WP-4 results — untested areas (2026-11-10, backend-agent — NO BROWSER ACCESS)

Test bed intended: `http://localhost:4176/admin/` (worktree server, local
`storelah_lh` DB). This environment has **no browser tool**, so every item
below was verified at API level (new `tests/e2e/finance-lease-horizon-wp4.test.ts`,
4/4 green) and by code inspection against `src/cms/admin/financeWorkspace.js`
+ `src/lib/permissions.ts` + `src/lib/routePermissions.ts`. **Nothing below is
browser-signed-off.** The exact clicks + screenshots still required are at the
end of this file. Do not mark any item done until a human has done them.

Checks on this dispatch: `pnpm check` green,
`node --check src/cms/admin/financeWorkspace.js` OK,
full `pnpm test:e2e` **566/567** (only failure is the known
`finance-phase4` close-checklist failure — baseline was 562/563, +4 new WP-4
tests). No calculated number changed (UI gating only), so no before/after
figures apply. The dev-server `storelah_lh` DB was never touched — no model
reset needed.

## 1. Role permissions in the UI per D9B (Owner decisions §D9)

### 1a. Permission-string reconciliation (as required by the brief)

The owner decisions (`finance.models.*`) and the brief §3 mapping predate the
P4 implementation. **The UI and the API both gate on the `bill-*` strings.**
Concretely:

| Owner doc (`finance.models.*`) | Implemented as | Gates |
|---|---|---|
| `finance.models.view` | `bill-models:view` (Financial Models tab + model reads) **and** `bill-returns:view` (Returns tab + returns read) | Tab visibility (`access.js canView`), `GET /finance/models…`, `GET /finance/returns`, `GET …/export.csv` (`bill-models:view`) |
| `finance.models.edit_lease` | **split**: `bill-lease:update` (governed lease path: Sections 4–5, Retry) + `bill-models:update` (legacy section writes) | `leaseCanEdit()` (ws L952), `valCanEdit` (ws L~1377), `PUT …/landlord-lease`, `PUT …/valuation`, `POST …/recalculate` |
| `finance.models.submit` | `bill-library:update` | Request-publish / Submit buttons, `POST …/submit` |
| `finance.models.approve` | `bill-library:approve` | Publish buttons, `POST …/publish`, `POST …/approve` |
| `finance.models.recalculate` | `bill-lease:update` | Retry buttons, `POST …/recalculate` |

### 1b. Per-role matrix (seeded defaults — API asserted in `finance-lease-horizon-wp4.test.ts`)

| Role | Sections 4–5 | Returns screen | Export DCF | Retry | Submit / Approve | API agrees |
|---|---|---|---|---|---|---|
| **Owner** | edit | view | yes | yes | both | 200 everywhere |
| **Manager** | **UI: unreachable** (no `bill-models:view` → Financial Models tab hidden; API `PUT` would 200) | **hidden** (no `bill-returns:view`) | n/a (403) | API 200, no UI surface | submit 200; approve 403 | asserted: lease PUT 200, returns/export 403, valuation PUT 200, recalculate 200 |
| **Finance Operator** | visible, **read-only** inputs + "You can view this section but your role cannot update it." | view | yes (CURRENT only) | **hidden** (no `bill-lease:update`) | submit yes; approve no | asserted: lease PUT 403, returns/export 200, valuation 403, recalculate 403 |
| **Finance Approver** | edit | view | yes | yes | both | asserted: all 200 |
| **Viewer** (default) | hidden (no Finance tabs at all) | hidden | n/a | n/a | n/a | asserted 403 |
| **Viewer + `bill-lease:view`** | **still hidden** (tab needs `bill-models:view`) | hidden | n/a | n/a | n/a | asserted: lease GET 200 (P4 test), returns 403, export 403 (this file) |
| **Viewer + `bill-returns:view`** | hidden | view, Export DCF **disabled** w/ reason (new WP-4 gate) | disabled | hidden | n/a | asserted: returns 200, export CSV 403 |
| **Viewer + `bill-models:view`** | visible read-only | hidden | enabled (CURRENT only) | hidden | n/a | asserted: returns 403, export CSV 200 |

UI gating points (all `bill-lease:update`, matching the routes): `leaseCanEdit()`
ws L952, valuation edit check ws L~1377, Retry buttons ws L465/483/502, section
banners ws L1084/1467/1741. Tab visibility: `access.js canView(key+':view')`
over `bill-models` / `bill-returns` tabs.

### 1c. Open owner questions (NOT changed — needs owner call, do not fix silently)

1. **Manager cannot reach any lease UI.** Seeded Manager has
   `bill-lease:update` (API PUT 200) but no `bill-models:view` / `bill-returns:view`,
   so Sections 4–5 and Returns are hidden and DCF export 403s. D9B says
   "Manager: view, edit drafts, update, submit and retry" — "view" of what is
   ambiguous against the seeded matrix (pre-existing deny, not introduced by
   lease-horizon). Options: grant Manager `bill-models:view` + `bill-returns:view`
   by default (UI becomes visible, edits still governed by `bill-lease:update`),
   or confirm API-only lease editing is intended.
2. **`Viewer + bill-lease:view` alone shows nothing** (tab is keyed on
   `bill-models:view`). The grant only takes effect together with
   `bill-models:view`. Confirm this matches the D9B "grantable through User
   Management" intent, or key the section on `bill-lease:view`.

## 2. Stale / pending / failed calculation states + Retry (handoff §8.5, LH17)

Server (already built, re-verified this dispatch):

- `GET …/export.csv` (both formats) requires CURRENT (`requireCurrentCalculation`,
  cms.ts L1791); otherwise 409 `BLOCKED` "Returns are out of date…".
- `POST …/library/:id/submit` and `…/approve` require CURRENT
  (`assertFiguresCurrent`, library.ts L285) — asserted by the new test:
  FAILED → submit 409 "Retry calculation before submitting or approving";
  after completing WACC → CURRENT → submit 200.
- PENDING is transient (valuation runs synchronously after commit), so the
  pending banner is defensive; FAILED is reachable (incomplete-WACC fixture).

UI (verified by code inspection; browser clicks still open):

- PENDING: "Updating from model version {v}. Last-good figures are shown; export
  and approval actions are disabled until the recalculation succeeds." (ws L501)
- FAILED: "Returns are out of date…" + last-success timestamp + model version +
  Retry only for `bill-lease:update` holders (ws L502, L465–466); Sections 4/5
  show "The lease was saved, but investment returns could not be recalculated.
  Retry calculation…" with Retry for editors (ws L1084/1467); export handler
  pre-checks CURRENT before downloading (ws L654).
- **Fixed this dispatch (was failing §8.5):** Publish / Request publish /
  Submit / Approve buttons stayed ENABLED on stale models (the Returns copy even
  claimed "approval actions are disabled" while they were not — only the server
  409 stopped them). Now: `fillPublishSlot` + `libraryCard` render the buttons
  `disabled` with title "Returns are out of date — retry the calculation before
  submitting or approving." when `(calculationStatus||'CURRENT')!=='CURRENT'`,
  and the `submit-approval` / `approve-budget` / `approve-model` /
  `publish-model` / `request-publish` handlers notify
  "Returns are out of date — … Retry calculation before submitting or
  approving." instead of POSTing. `srv.model` (loaded) is preferred over the
  library list row for freshness (`staleTarget`); both refresh on every
  Update/Retry via `hydrate` + `refreshModelList`, so the disable clears after a
  successful recalculation. Reject / send-back / archive / delete / set-current
  are intentionally NOT gated (they move no figures forward; server permits).
- **New UI gate (consistency):** Export DCF is now also disabled with
  "Model exports need the Financial Models view permission." when the operator
  lacks `bill-models:view` (route requirement), instead of a 403 dead end.
  Affects only split-grant roles (e.g. Viewer + `bill-returns:view` only).

## 3. Export DCF file contents, mid-month model (asserted in the new e2e test)

Model: operational + lease start 15 Dec 2026, 12 months, S$5,000/mo, 15% manual.

- Header: `month_or_date_range,period_months,revenue_sgd,operating_cash_flow_sgd,capex_sgd,other_cash_flows_sgd,net_free_cash_flow_sgd,discount_factor,discounted_cash_flow_sgd,cumulative_dcf_sgd` ✓
- 14 data rows = t=0 + 13 committed months (matches `GET returns` committed array) ✓
- t=0: `2026-12-15` at period `0` ✓
- Opening stub: `2026-12-15→2026-12-31` at period `0.548` ✓
- Closing part-month row: `2027-12-01→2027-12-14` at period `12` ✓
- Every money cell parses to a finite number equal to its 2dp rounding (cents
  values; whole dollars render unpadded, e.g. `5000` not `5000.00` — value, not
  format, is the §13/D12A property) ✓
- Discount factor equals its 7dp rounding (CSV carries the number — t=0 writes
  `1`; the UI pads with `toFixed(7)`) ✓
- Committed vs renewal: enabling renewal (24 mo) leaves the file
  **byte-identical**; `GET returns` carries the renewal case separately (R13) ✓

## 4. Mobile 375px, no horizontal scroll (handoff §13) — code audit, browser open

- All wide tables (`fm-table` 1040px, `fm-dcf-table` 1500px, compact/scenario
  520–760px, lease-year 620px) render inside `.table-wrap{overflow:auto}`
  (dashboard.html L89) — page-level scroll cannot come from tables; inner scroll
  is the established pattern. Scenario tables carry inline `min-width:760px`
  inside `.table-wrap` ✓.
- Grids collapse: `fm-main-grid/budget/mix/overview/return-pair/capital` → 1fr
  @1250; `fm-kpis` → 3col @1250 → 2col @760; `fm-kpis-returns` → 2col @760
  (finance.css L121); `fm-assumption` → 1col @760; `fm-start` (incl.
  `fm-returns-head`) → column @760; `fm-schedule-head` → column @760;
  `fm-loaded-model-banner` → 1col @760 ✓.
- Flex rows that could overflow wrap: `fm-toolbar`, `fm-filter-bar`,
  `fm-returns-head .actions`, `fm-sens-controls` (`flex-wrap`, L123),
  `fm-section-actions` (`flex-wrap`) ✓. `fm-date-pair` is flex with
  `min-width:0` children ✓. `fm-modal-card{width:min(960px,96vw)}` ✓.
- No page-level `min-width` > 375 found on the Sections 4–5 / Returns / DCF
  render paths. **A real 375px pass (Chrome device toolbar, Sections 4–5,
  Returns incl. DCF table) is still required — see click-list.**

## 5. Browser click-list (user must do — no browser in this environment)

Prereqs: `http://localhost:4176/admin/` on the worktree server, local
`storelah_lh` DB, test model "LH verify …" on Sembawang (currently 1 Dec 2026 /
60 months — leave it there when done). Open DevTools console; keep it visible.

**P-permissions (need 5 logins — Owner + Manager + Finance Operator + Viewer
with and without `bill-lease:view`; grant via Global Settings › Team & access):**
1. As Manager: Finance section shows Overview only — Financial Models and
   Investment Returns tabs hidden (§1c-Q1). Confirm no lease UI is reachable.
2. As Finance Operator: open Sections 4–5 — every input disabled + "You can view
   this section but your role cannot update it."; Update/Undo disabled. Returns:
   visible, Export DCF enabled, NO Retry button anywhere, no Publish/Request
   publish on DRAFT models (or disabled if stale).
3. As Viewer (+`bill-lease:view` only): no Finance tabs at all (§1c-Q2).
4. As Owner: everything enabled; on a DRAFT model Publish is enabled when
   CURRENT.
5. API agreement spot-check (already e2e-asserted): as Operator, `PUT
   …/landlord-lease` → 403; as Manager → 200. UI must match (no enabled button
   that 403s).

**P-stale (§8.5 + new fix):**
6. As Owner: Section 5 → methodology WACC, clear all inputs, Update → model goes
   FAILED; Returns shows "Returns are out of date…" + last-success time +
   Retry; Export DCF disabled (button + click); header Publish / library
   Publish / Request publish **disabled with the stale title** (NEW — was
   enabled before this dispatch); submit attempt notifies the stale message.
   Click Retry → CURRENT; all buttons re-enable. Screenshot each state.
7. PENDING is timing-only (synchronous recalc) — confirm last-good figures stay
   mounted during a slow Update if observable; otherwise record N/A.

**P-DCF file:**
8. Mid-month model (15 Dec 2026 / 12 mo): Returns → Export DCF → open the CSV:
   header as §3; t=0 `2026-12-15,0`; opening `2026-12-15→2026-12-31,0.548`;
   closing `2027-12-01→2027-12-14,12`; cents values; renewal on → file
   unchanged. Confirm the download filename `StoreLah_DCF_…_vN.csv`.

**P-mobile:**
9. Chrome device toolbar 375px: Sections 4–5 (incl. proration radios, schedule
   table inner-scroll), Returns (KPI grid 2-col, sensitivity slider usable, DCF
   table inner-scrolls, page itself does NOT scroll horizontally), library cards.
   Screenshot each.

**WP-3 carry-over (from `WP-3-click-list.md` — still browser-open):** P7 items
1–5, P8, P9, P10 (`capped` tag + `Sept 27`), P11 Expand, P12 Audit history, B9
retest. This dispatch did not re-test them.

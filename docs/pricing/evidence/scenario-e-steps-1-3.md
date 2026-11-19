# Scenario E steps 1–3 — browser verification (B4 close-out)

**Status: BROWSER VERIFICATION PENDING OWNER-RUN.** This repo has no browser
test harness (no Playwright/puppeteer/Cypress runner; `package.json` devDeps
are `vitest + supertest + tsx` only — API-level). What follows is the careful
static wiring audit (every button → handler → route → permission) plus the
exact manual click-list for an owner-run against seeded demo data on an
isolated `*_test` DB. Do not mark steps 1–3 done until a human (or a browser
capable agent) works the list below and screenshots each state.

Handoff ref: `docs/pricing/HANDOFF_2026-11-18.md` §22 scenario E:

> 1. Open Sembawang strategy and select 1, 3, 6 and 12 months.
> 2. Confirm chart, category table, totals, duration cards and unit table remain synchronised.
> 3. Select Active and Draft test promotions; confirm Draft is preview-only.

Workspace: `src/cms/admin/rateStrategyView.js`, panel
`#facilities` → `facility-rate-strategy` (body self-mounts into
`#rateStrategyRoot`; `dashboard.html` untouched).

## 1. Static wiring audit (implementer-verified 2026-11-18)

All routes below are existing B3 CMS routes — the workspace adds no endpoints.
Permissions use `src/lib/routePermissions.ts` (`facility-rate-strategy:*`) and
every action button carries an explicit `data-perm` so the `access.js` sweep
hides what the role lacks.

| # | UI element | Handler | Route called | Permission |
|---|---|---|---|---|
| 1 | Strategies list rows + branch/status filters, Open | `loadList` → `GET /rate-strategy/library?branchId=&status=` | view | view |
| 2 | Show header: Edit levers / Validate / Send for approval / Approve / Reject / Duplicate / Schedule batch | `openLeverModal` → `PATCH /rate-strategy/:id`; `runValidation` → `POST /rate-strategy/:id/validate`; submit/approve/reject/duplicate/batch modals → existing B3 posts | view / update / approve / create | update / view / approve / create (gated per button) |
| 3 | Workbench duration filter (1/3/6/12, §15.12) + matrix select + Preview | `setDuration` → cache hit re-renders, else `refreshWorkbench` → `GET /rate-strategy/:id/preview` ×4 (1,3,6,12) with `matrix` + explicit `planIds` | view | view |
| 4 | Live chart (beside levers on desktop, stacked on mobile via `flex-wrap`) | `renderRsChart` → `rsChartSvg` — inline SVG, same `fm-chart/fm-legend/fm-chart-tooltip` approach as `financeWorkspace.js` `chartCardV2` (no new dependency). Series: Rack sage, Effective teal, Blended terracotta (only when free months apply), Model target dashed brass. X 8–150 full commercial axis kept; hover crosshair + `<title>` per stocked point | — (renders cached preview) | view |
| 5 | Size categories + live rate outcomes + totals (§15.12) | `renderRsCats` — per-category NLA/units/Rack+Net PSF ranges/(Blended range)/potentials from preview `rows`; unstocked categories render “Not stocked — excluded from totals”; totals from preview `summary` | — (same cache) | view |
| 6 | Duration cards (§15.9) | `renderRsDurCards` — weighted Effective PSF + gap + net potential (+blended) per duration; click → `setDuration` synchronises chart/categories/table | — (same cache) | view |
| 7 | Promotion library preview panel (§15.13) | `loadPromos` → `GET /promotion-plans`; checkboxes toggle explicit `planIds` → `refreshWorkbench`. Draft = preview-only note; conditional kinds (promo-code/credits) render disabled “visible only” | promotion read (panel degrades to an explanatory empty state on 403) |
| 8 | Unit-rate breakdown (§15.20): own 1/3/6/12 filter, Facility-sizes-only / Every-1-sqft + From/To, Availability/Cat/Size/Promo(s)/Rack/PSF/Disc/Effective/Free/Blended/Target/Gap/Override columns, 200-row cap, totals line | `renderPreviewTables` — unstocked rows labelled “Not stocked / Rate only” and never affect totals (totals come from `summary`, stocked-only) | — (same cache) | view; Override needs Draft + update |
| 9 | Per-row override modal (§15.21) | `openOverrideModal` → `PATCH /rate-strategy/:id` with updated `sizeOverrides` (Apply) or entry removed (Use generated rate); reason mandatory; then `refreshShow` + `refreshWorkbench`. Draft-only; below-floor stays a server blocker | update |
| 10 | Validation modal (§15.23) | `runValidation` renders inline AND opens `overlay()` modal with blockers/warnings/passed + exact rule text (“Warnings do not block approval… Only red blockers prevent submission or approval”). Close-only; approval stays on header actions | view |
| 11 | Scheduler tabs, batch list/detail/apply/retry/cancel/apply-due, settings, history, activity | unchanged from B4 (already audited) | view / approve | as gated |
| 12 | Facilities › Units header: “Open rate strategy” + “Apply due batches” | `mountUnitsRateEntry` (called once at boot in `admin.js`, permission-gated) → `location.hash = '#facilities'` + clicks `[data-tab="facility-rate-strategy"]`; apply-due → `POST /units/rate-batches/apply-due` | view / approve | view / approve |

Synchronisation invariant: one `view.duration` + one `view.matrix` + one
`view.planIds` feed all four previews (`view.previews[1|3|6|12]`); `setDuration`
re-renders chart, categories, cards and table from the same cache, so the four
surfaces cannot disagree except while a fetch is in flight (loading states).

## 2. Manual click-list (owner-run, isolated `*_test` DB)

Setup: `DATABASE_URL_TEST=postgresql://…/storelah_owner_e2e_test`, `pnpm prisma
migrate deploy` (via the e2e global-setup or `DATABASE_URL=<test-url> pnpm
db:deploy`), seed demo data (dev seed or the `seedWorld` shape in
`tests/e2e/rate-strategy-ui.test.ts`: branch + floors + LOCKER/XS/MEDIUM units,
one CURRENT Financial Model, one ACTIVE DISCOUNT_MATRIX + one ACTIVE
FREE_MONTHS + one DRAFT plan, one Draft strategy v1). Serve with `pnpm dev`,
sign in as Owner.

1. **List → show.** Facilities → Master rate strategy → strategy list loads
   (facility + status filters work; empty filter shows “No strategies match
   these filters.”). Open a Draft → header shows status pill v1, lever summary,
   action bar (Edit levers / Validate / Send for approval / Duplicate; no
   Approve/Reject on a Draft).
2. **Durations 1/3/6/12.** Click Preview (12 mo default). Click each duration
   button in the workbench toolbar, then each in the unit-table toolbar, then
   each duration card. Every click updates ALL of: chart series + subtitle,
   category ranges + totals line, highlighted duration card, unit-table values.
   Screenshot each duration.
3. **Chart.** Rack (sage), Effective (teal), Blended (terracotta) only when the
   selected duration + category earns free months (e.g. 12 mo shows Blended;
   1/3/6 mo hide it), Model target dashed brass. Hover a point → tooltip with
   size + PSF values. Resize to 375px → chart stacks below levers, tables
   scroll horizontally, labels stay readable.
4. **Categories + totals.** Six category rows; unstocked category shows “Not
   stocked — excluded from totals”. Totals line matches the unit-table totals
   line (NLA, units, weighted rack/effective/blended, potentials).
5. **Promotions.** Library lists ACTIVE + DRAFT plans with kind/status/scope.
   Untick all → reverts to stored selection. Tick only the DRAFT plan →
   preview recomputes, plan shows “preview only”, Discount & Promotion records
   unchanged (verify in Promotions → library: still Draft, no activation).
6. **Range view.** Switch to “Every 1 sq ft”, set From 8 To 150 → full
   schedule rows appear with “Not stocked / Rate only” availability; totals
   unchanged. Narrow to 40–60 → only that window renders.
7. **Override modal.** On the Draft, Override a stocked size (e.g. 40 sq ft):
   empty reason → error; below-floor rate → saves, then Validate shows a
   blocker. “Use generated rate” removes the override (pill disappears).
8. **Validation modal.** Validate strategy → modal opens with blockers
   (red) / warnings (amber) / passed + exact rule text; inline section mirrors
   it. Screenshot.
9. **Submit/approve/schedule (steps 4–6 context).** Covered by API suites
   (`rate-strategy-service`, `rate-strategy-ui`, `rate-strategy-closeout`
   green); owner-run may repeat: submit with one warning reason per warning →
   Pending approval; self-approval blocked with note; second Owner approves;
   schedule batch → Units banner shows batch status; occupied rent untouched.

Sign-off: operator name + date + screenshots attached here. Until then, steps
1–3 remain **PENDING**.

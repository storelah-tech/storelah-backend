# CMS Full Functional Test Plan — `src/cms/admin/`

Date: 2026-10-18 · Code baseline: backend `main` @ `c88f2fc` (clean working tree).
Scope: every sidebar item → every sub-page → every button, filter, form field,
modal, row action, keyboard shortcut and cross-page jump in the operator CMS
(`/admin` locally, `cms.storelah.sg` in prod). The frozen legacy
`src/cms/dashboard.html` + `data-layer.js` are out of scope.

This plan was built from a static inventory of `dashboard.html` (~600 controls)
plus every runtime-rendered button in `admin.js` and the `*View.js` modules,
each traced to its handler and `/api/v1/cms/*` route. Controls that do **not**
work are listed with the reason in §3 (Known non-working register) and are also
flagged inline with their test case, so the tester confirms the reason rather
than reporting them as new bugs.

---

## 0. Priority and execution order

Owner priority (2026-10-18): **floor plan publishing** and the **promotion
modules** are the most important features. Run them first; a Fail in either
blocks release.

| Priority | Suites | Gate |
| --- | --- | --- |
| **P0** | §1A Floor plan publishing (FPP-*), then regression FP-01–30 + LB-01–07 · §1B Promotions (PRM-*), then regression PR-01–24 | Any Fail blocks release. Suspected defects (R-*) must get a Pass/Fail and an owner decision |
| P1 | Data that feeds P0: Units, Floors, Global Settings → Facilities (branch active/inactive), Safeguards, Protection & Addons, Fees/business rules, RBAC §2.10 | Fail needs fix or owner waiver |
| P2 | Customers (quotes, tenants, move-outs), Leads, Overview, Finance, Content, Facility ops | Log and triage |
| P3 | Shell/responsive (SH-*), re-confirm the Known-NW register §3 | Log only |

Before the manual P0 pass, run the automated floor-plan suites (vitest + test DB):

```bash
npx vitest run tests/e2e/floor-plan
```

(`floor-plan-publish-guards`, `floor-plan-unit-sync`, `floor-plan-precision`,
`floor-plan-underlay`). There are no automated promotion suites yet (see §5).

---

## 1. How to run this plan

### 1.1 Environment (local only — never prod)

| Item | Value |
| --- | --- |
| Backend + CMS | `pnpm dev` in `storelah-backend/` → CMS at `http://localhost:4000/admin` |
| DB | dev Postgres on `:5433` (Docker). Use a **disposable copy**; many cases create/delete data |
| Seed | `pnpm db:seed` is destructive — run it **only** against the local dev DB, to reset between runs |
| Auth | CMS auto-logs in via `GET /api/v1/cms/config` → `POST /login` (no login screen). See §3 D-25 |
| Browser | Chrome desktop 1440×900 + one pass at 760px (drawer mode) and 900px (rail breakpoint) |
| Tools open | DevTools Network (filter `api/v1/cms`) + Console. Every case's "API" column is checked here |

Never run the destructive cases (delete facility/floor/unit/user, publish floor
plan, publish promo) against `cms.storelah.sg` — prod data mutations need
explicit owner authorization each time.

### 1.2 Pre-conditions / test data

Before starting, make sure the dev DB has at least: 2 facilities (one with ≥2
floors), units in every status (AVAILABLE / OCCUPIED / RESERVED / OVERDUE),
≥12 leads spread across all 7 stages and ≥2 sharing the same email (for
"By email" grouping), ≥1 conversation, ≥3 appointments (one today), ≥1 tenant
on NOTICE, ≥1 booking PENDING_PAYMENT with a verification record, invoices in
PAID / DUE / OVERDUE, ≥1 protection plan + addon, ≥1 content item with image.
The seed provides most of this; create the rest through the CMS in the first
pass (that also exercises the create flows).

### 1.3 Result recording

For every case record: **Pass / Fail / Blocked / Known-NW** (known non-working,
reason in §3), the build SHA, and for a Fail the network request + console
error. A **Fail** is anything where the observed behaviour differs from the
Expected column. A dead control that is not in §3 is a new Fail.

### 1.4 Cross-cutting checks applied to EVERY page (run once per page)

| ID | Check | Expected |
| --- | --- | --- |
| X-01 | Open the page from the sidebar sub-item | Page shows, sub-item highlighted, parent expanded, URL hash = page id |
| X-02 | Reload with the hash in the URL | Same page restores |
| X-03 | Change sidebar **facility selector** (`#sbBranchSelect`) | Data scoped to that facility (units, map, floors, plans); "All Facilities" restores all. Note: changing it jumps you to Overview by design |
| X-04 | Empty state | With no rows, a readable "No …" message shows (never a blank table or JS error) |
| X-05 | API error | Stop the backend, click a load/save action → red banner `#errorBanner` with a message, no frozen UI. Restart → reload recovers |
| X-06 | Console | No uncaught errors during the whole page walk |
| X-07 | Validation | Every form: submit empty → field errors shown inline / in modal alert; server 400 surfaces readable text |
| X-08 | Destructive actions | Every delete/deactivate/publish opens the confirm dialog; **Cancel** and **✕** abort with no request; **Confirm** sends exactly one request |
| X-09 | Modal close | ✕, Cancel, overlay click and **Esc** close the modal without saving (Esc gaps listed in §3 D-24) |
| X-10 | Date-range filter (where present) | Presets (Today, 7d, 30d, custom…) refetch with date query; label updates; empty-state text mentions the range; clear restores |
| X-11 | Narrow viewport (≤760px) | Sidebar becomes drawer; tables scroll horizontally; modals fit |

---

## 1A. P0 — Floor plan publishing (FPP)

How publishing works (from `core/floorPlans.ts`, `core/unitSizeSync.ts`,
`core/floorPlanDrafts.ts`):

- One plan row per floor. Status is only **DRAFT** or **ACTIVE**. Customers
  (`GET /api/v1/public/floor-plans/:branchCode/:level`) see **ACTIVE only**, and
  only when the floor is active and the facility is ACTIVE.
- **Every** CMS edit (unit move, block, boundary, marker, canvas size, GFA,
  underlay) sets the plan back to DRAFT. Publish is DRAFT → ACTIVE.
- Publishing also applies "size sync" in the same transaction: redrawn units get
  new sqft / size tier / rate, DRAFT units become AVAILABLE.
- Guards: `409 EMPTY_PLAN` (0 placements without typed confirm), `409
  PUBLISH_BLOCKED` (a contracted unit — occupied / reserved / overdue — would
  change size, or no size tiers exist), `409 STALE_PREVIEW` (plan changed after
  the preview), `409 PLACEMENT_OVERLAP` on edits, `403` without
  `promotions.approve` (only for operators that hold grants).
- Draft versions: "Save as draft" freezes version N. Publishing a version
  replaces the live canvas wholesale, demotes every other published version to
  DRAFT, and skips placements whose unit has since been deleted, moved floor or
  deactivated.

**Test data (create once on a disposable DB):** facility `TST` (ACTIVE), floor
L1 (active) with a saved canvas; size tiers present; units on L1: `A1`, `A2`
AVAILABLE · `O1` OCCUPIED (tenant) · `R1` RESERVED (pending booking) · `I1`
INACTIVE · `D1` AVAILABLE (will be deleted later). Booking app on `:3001`, or
check the public endpoint directly:

```bash
curl -s http://localhost:4000/api/v1/public/floor-plans/TST/1
```

### 1A.1 Publish preview and confirm

| ID | Steps | Expected | Evidence |
| --- | --- | --- | --- |
| FPP-01 | New floor with no canvas saved → Publish | Banner: no floor plan exists, save a canvas first (404); no modal | Network 404 |
| FPP-02 | Place A1, A2 (no resizes) → Publish | Preview modal: placement count 2, no blockers, no size changes; Cancel / ✕ close with no request | `GET …/publish-preview` |
| FPP-03 | Draw a new unit with the N tool → Publish | Preview lists it under new units (code, sqft, tier, rate) → after Publish the unit is AVAILABLE in Units list and bookable | Unit row status |
| FPP-04 | Resize A1 drawing by +10 sqft → Publish | Preview shows old→new sqft, old→new tier, rate preview for KEEP_PSF (default) and KEEP_RATE | Preview body |
| FPP-05 | In preview pick **KEEP_RATE** for A1 → Publish | A1 sqft updated, rate unchanged | Unit A1 |
| FPP-06 | Repeat with **KEEP_PSF** | Rate = old rate ÷ old sqft × new sqft (2 dp) | Unit A1 |
| FPP-07 | Repeat with **SET** + a rate; then SET with no rate | Rate set exactly; missing rate → 400 "ratePolicy SET needs a rate" | Network |
| FPP-08 | Override the size tier for A1 in preview | Unit gets the chosen tier; unknown tier id → 400 | Unit A1 |
| FPP-09 | Resize to a sqft no tier band covers | Preview flags tier out of band (nearest tier shown) | Preview |
| FPP-10 | Double-click Publish in the confirm | Exactly one `POST …/publish` | Network |
| FPP-11 | Publish an already ACTIVE plan (no edits) | No-op success; no unit changes | `meta.sizeSync` empty |

### 1A.2 Publish guards

| ID | Steps | Expected | Evidence |
| --- | --- | --- | --- |
| FPP-12 | Remove all placements → Publish | Preview shows the empty-plan danger warning; publishing without the typed confirm → 409 EMPTY_PLAN; with confirm → ACTIVE with 0 placements and public shows an empty floor | Network + public GET |
| FPP-13 | Resize A2 (available), then mark A2 RESERVED → Publish (a contracted unit can't be resized directly — that edit is refused 409 UNIT_CONTRACTED) | Preview lists the blocker; Publish → 409 PUBLISH_BLOCKED; **nothing written** (O1 sqft unchanged, plan still DRAFT, other resizes not applied) | Unit O1 + plan status |
| FPP-14 | Try to resize RESERVED and OVERDUE unit drawings directly | 409 UNIT_CONTRACTED at edit time | Network |
| FPP-15 | Fix FPP-13 via Sizes button → Reconcile → **FIT_DRAWING** on O1 → Publish | Drawing snaps back to O1's sqft; publish succeeds | |
| FPP-16 | Grandfathered mismatch on an OCCUPIED unit: Reconcile **MARK_FOR_SYNC**, then **FIT_DRAWING** | MARK_FOR_SYNC → 409 UNIT_CONTRACTED. FIT_DRAWING → 409 while the plan is live ("uneditable when live — unpublish to draft"), works once the plan is draft | Network |
| FPP-17 | Open preview in tab 1; in tab 2 move A2; confirm in tab 1 | 409 STALE_PREVIEW with "review the size changes again"; re-opening preview then publishing works | Network |
| FPP-18 | Try to drop a unit overlapping another | 409 PLACEMENT_OVERLAP, unit snaps back; overlap can never reach publish | Network |
| FPP-19 | Stacked units: place upper tier with no matching ground rect | 400 "no ground-tier placement shares its exact rect" | Network |
| FPP-20 | Try to place I1 (INACTIVE) and a deleted unit | 400 "is INACTIVE…reactivate it first" / "is deleted" | Network |
| FPP-21 | Operator holding grants but **not** `promotions.approve` publishes (API) | 403; operator with no grant rows → allowed (legacy) | API call |
| FPP-22 | Inactive floor: deactivate L1 → try adding a unit | 400 "Floor … is inactive" | Network |

### 1A.3 What customers see after publish

| ID | Steps | Expected | Evidence |
| --- | --- | --- | --- |
| FPP-23 | After a good publish | CMS status pill ACTIVE; public GET returns plan with placements (unit code, size, status), no tenant data; booking floor-plan view matches the canvas | public GET + booking screenshot |
| FPP-24 | Deactivate floor L1, then facility TST (Global Settings) | Public returns `plan: null` while plan stays ACTIVE in CMS; reactivate → visible again | public GET |
| FPP-25 | Deactivate a placed unit / soft-delete D1 after publish | Disappears from the public plan; placement count drops | public GET |
| FPP-26 | Units list / map after publish | Resized units show new sqft & rate; activity feed logs the changes | Units, Overview activity |
| **FPP-27 (R-FP1)** | Publish, then make **one** small edit (move A2 by 1 ft) — do not republish | **Code says:** plan drops to DRAFT and public GET returns `plan: null` — the booking floor plan disappears until someone republishes. Record what the booking app shows. Business risk for owner decision (a live floor goes dark during any edit) | public GET + booking screenshot |
| FPP-28 | After FPP-27, Undo the edit | Plan stays DRAFT (undo is an edit too); needs republish | Status pill |

### 1A.4 Draft versions (Save as draft + Library)

| ID | Steps | Expected | Evidence |
| --- | --- | --- | --- |
| FPP-29 | ⋯ More → Save as draft twice with different edits | Library shows v1, v2 (max+1 per floor) with names | `GET …/drafts` |
| FPP-30 | Rename a draft: valid, empty, 81 chars | Valid saves; empty / >80 → 400 | Network |
| FPP-31 | Save as draft with I1 placed (made inactive after placing) | 400 "cannot be snapshotted into a draft" | Network |
| FPP-32 | Library → Publish v1 while live canvas differs | Confirm lists: what goes live, the currently published version that goes back to draft, skipped placements, blockers, empty warning | `GET /drafts/:id/publish-preview` |
| FPP-33 | Confirm publish v1 | Live canvas = v1 snapshot exactly (placements added after v1 are removed); v1 marked published; every other version DRAFT — exactly one published | Library + public GET |
| FPP-34 | Delete a unit, move another to L2, deactivate a third — all present in v1 — then publish v1 | Those placements skipped and listed (`meta.skippedPlacements`); rest goes live | Network meta |
| FPP-35 | Publish an empty draft / a draft that resizes O1 | EMPTY_PLAN needs confirm / PUBLISH_BLOCKED, nothing written | Network |
| FPP-36 | Library → Load v2 | Canvas shows v2; check public GET — live plan should be unchanged until publish (tooltip claim) | public GET before/after |
| FPP-37 | Library → View | Read-only preview; Edit opens designer on that floor | |
| FPP-38 | Delete a draft version (try the published one too) | Version removed; live plan untouched. Record behaviour for the published version | public GET |
| FPP-39 | ⋯ More → Delete plan on a published floor | Confirm; public returns `plan: null`; units themselves remain in Units list | public GET + Units |

---

## 1B. P0 — Promotions (PRM)

How promotions work (from `core/promotionPlans.ts`, `core/customers.ts`
checkout pricing, `admin.js` builders):

- Plan kinds: DISCOUNT_MATRIX, FREE_MONTHS, PROMO_CODE (CREDITS exists in API only).
- Status machine: DRAFT → VALIDATED → SCHEDULED → ACTIVE → ENDED. Also
  VALIDATED → DRAFT, SCHEDULED → DRAFT / ENDED. ACTIVE → DRAFT and anything out
  of ENDED are refused (400 INVALID_TRANSITION). The server re-runs validation
  on DRAFT→VALIDATED and VALIDATED→SCHEDULED.
- UI buttons walk the chain: **Save Draft**; **Validate plan** (checks only);
  **Schedule next month** (→ SCHEDULED); **Publish** (→ ACTIVE).
- Checkout (`/api/v1/public` quote + booking): takes the **highest** matching
  cell from **all ACTIVE matrix plans** for (size category, duration =
  commitment months). Only if no matrix cell matches does it try a promo code,
  and it looks codes up in the legacy `Promotion` table.

**Test data:** global safeguard floor $80/mo (Safeguards tab); units of SMALL
and MEDIUM at two facilities (`TST`, plus one seeded); booking app on `:3001`.
For price checks use the booking wizard quote, or the public quote API the
booking app calls (watch its Network tab).

### 1B.1 Discount plan builder — lifecycle

| ID | Steps | Expected | Evidence |
| --- | --- | --- | --- |
| PRM-01 | Fill name, start date, matrix cells → Save Draft | Plan DRAFT v1, appears in Library; status pill DRAFT | `POST /promotion-plans` |
| PRM-02 | Change a cell → Save Draft again | Same plan id (PUT), version +1, new History row | `PUT /promotion-plans/:id` |
| PRM-03 | Validate with: empty name; effective-to before from; all cells empty; a cell at 120%; a cell at −5% | Each → blocker listed in validation modal; Confirm not possible | `POST …/validate` |
| PRM-04 | Validate a plan with a 30% cell, then a 45% cell | Warning "exceeds 25% — manager approval" / "exceeds 40% — Commercial/Finance" (warnings don't block) | modal |
| PRM-05 | Validate a cell that takes a $100 unit below the $80 floor (e.g. 30%) | Blocker "Rate floor breach"; delete the safeguard → warning "No safeguard rules configured" instead | modal |
| PRM-06 | Validate while another ACTIVE plan covers the same dates/facility/size | Warning "Overlap: …" naming the other plan | modal |
| PRM-07 | Valid plan → Validate | All pass + sample booking prices shown; toast "passed validation" | modal |
| PRM-08 | Schedule next month (valid) | Status SCHEDULED; record the effective-from date the plan ends up with | `PATCH …/status` ×2 |
| PRM-09 | Schedule next month with a blocker | Banner + validation modal; status stays DRAFT | Network 400 VALIDATION_FAILED |
| PRM-10 | Publish (from DRAFT) | Calls go VALIDATED → SCHEDULED → ACTIVE; pill ACTIVE; Library green | Network ×3 |
| PRM-11 | Click Publish twice fast; then Publish again on an ACTIVE plan | One chain only; second time toast "already active", no writes | Network |
| PRM-12 | API: DRAFT→ACTIVE, ACTIVE→DRAFT, ENDED→VALIDATED | 400 INVALID_TRANSITION with `allowed` list | API call |
| PRM-13 | Library → Disable (ACTIVE) / End (SCHEDULED) | Confirm; status ENDED; no buttons to reactivate | `PATCH …/status {ENDED}` |
| PRM-14 | Library → Delete on DRAFT; Delete on ACTIVE via API | Draft deleted; non-draft button disabled with tooltip; API 400 INVALID_STATUS | Network |
| PRM-15 | Duplicate (builder + History) | New DRAFT copy, original untouched | `POST …/duplicate` |
| PRM-16 | History → Restore v1 as draft; Compare v1 vs v3 | New draft from v1; diff table lists changed fields | `POST …/restore`, `GET …/compare` |
| PRM-17 | Two plans with same code | 409 CONFLICT "Plan code … already exists" | Network |
| PRM-18 | Operator with grants but no `promotions.approve` → Schedule / Publish (API) | 403 | API call |
| PRM-19 | Facility + floor scope selectors | Floor list follows chosen facility; saved scope shows when reopened from Library | Reopen plan |
| **PRM-20 (R-PR1)** | Library → Open an **ACTIVE** plan, change one cell, click **Save Draft** | History rule on screen says live versions are never overwritten. **Code says:** `updatePlan` has no status check, so the live plan is edited in place (still ACTIVE, version +1) and checkout prices change at once. Record status, version and booking price before/after | Plan GET + booking price |

### 1B.2 Free months and promo code builders

| ID | Steps | Expected | Evidence |
| --- | --- | --- | --- |
| PRM-21 | Free months: set count 2, commitment 12, click months in the strip, try Upfront / Back-loaded / Spread / Manual | Strip and summaries (offer, commitment, applied, effective %) update each time | UI |
| PRM-22 | Save with strip showing 3 free but count 2 → Validate | Blocker "Allocation marks 3 free month(s) but plan promises 2" | modal |
| PRM-23 | Free months with no allocation saved → Validate | Warning "No month allocation rows saved" | modal |
| PRM-24 | Free months Save → Validate → Publish | DRAFT → … → ACTIVE, appears in Library | Network |
| PRM-25 | Promo code builder: each benefit (percentage, dollar, credits), name, code, value, conditions (+ Add condition), dates, cap, stack/exclusive | Code and benefit previews update; Save creates PROMO_CODE plan | `POST /promotion-plans` |
| PRM-26 | Code plan with empty code → Validate | Blocker "Promo code is required"; no rules → warning "applies to all" | modal |
| **PRM-27 (R-PR2)** | Free months **and** code builder: Save, then edit a field, then click **Publish** without saving again | **Code says:** these Publish buttons skip the save when a draft already exists (`publishPromoPlan`), so the published plan lacks the last edit. The discount builder does save first — compare. Reopen the plan from Library and check | Plan GET |

### 1B.3 Effect on booking prices (end-to-end)

| ID | Steps | Expected | Evidence |
| --- | --- | --- | --- |
| PRM-28 | ACTIVE matrix plan with SMALL × 6 months = 15% | Booking quote for a SMALL unit, 6 months, shows 15% off the monthly rate; End the plan → price back to full | booking quote |
| PRM-29 | Same plan, booking duration 2 months and 24 months | No discount (only exact tiers 1/3/6/12 match) | booking quote |
| PRM-30 | Two ACTIVE plans: SMALL × 6 = 10% and 20% | Booking uses 20% (highest wins, never stacks) | booking quote |
| **PRM-31 (R-PR3)** | Plan scoped to facility TST only; quote a SMALL × 6 unit at the **other** facility | Expected by the builder: no discount. **Code says:** checkout ignores facility/floor scope, so the discount applies everywhere. Record | booking quote |
| **PRM-32 (R-PR4)** | ACTIVE plan with effective-to in the past (set via API) / effective-from in the future | Expected: not applied outside its dates. **Code says:** checkout does not check dates. Record | booking quote |
| **PRM-33 (R-PR5)** | Schedule a plan for next month; check after its start date (move the date in DB or set effective-from = today) | Expected: goes live automatically. **Code says:** there is no scheduler — SCHEDULED never becomes ACTIVE on its own, and checkout uses ACTIVE only. Record | Plan status + booking quote |
| **PRM-34 (R-PR6)** | Publish a PROMO_CODE plan `TEST10`; enter `TEST10` in the booking promo field | Expected: code accepted. **Code says:** checkout and `POST /public/promotions/validate` read only the legacy `Promotion` table; the CMS builder never creates a row there, so the code is rejected. Record | booking + `POST /api/v1/public/promotions/validate` |
| **PRM-35 (R-PR7)** | Publish a FREE_MONTHS plan for SMALL × 12; quote SMALL × 12 | Expected: free months reflected. **Code says:** checkout has no free-month logic. Record | booking quote |
| PRM-36 | Legacy promo code (create via `POST /api/v1/cms/promotions` — no CMS UI for these): percentage recurring, first-month only, flat $; with start/end dates, `minMonths`, inactive | Applied only when active, in dates and duration ≥ minMonths; never on top of a matrix discount | booking quote |
| PRM-37 | After a booking that used a plan discount | Performance tab "Applied" count: record whether it moves (redemptions are only recorded via `POST …/redemptions`; booking does not auto-record — expected to stay 0) | Performance tab |
| PRM-38 | After every transition above | Dashboard counts/charts, Library status pill, History rows and Performance table all agree | UI |

### 1B.4 Suspected defects (from code review — all confirmed by the 2026-10-18 run, see §1C)

| ID | Area | Suspected issue | Confirm with |
| --- | --- | --- | --- |
| R-FP1 | Floor plan | Any edit after publish takes the customer floor plan offline until republished | FPP-27 |
| R-PR1 | Promotions | "Save Draft" on an opened ACTIVE plan edits the live plan in place | PRM-20 |
| R-PR2 | Promotions | Free months / code builder Publish ignores unsaved edits | PRM-27 |
| R-PR3 | Checkout | Facility / floor scope of discount plans not honoured | PRM-31 |
| R-PR4 | Checkout | Effective dates of ACTIVE plans not honoured | PRM-32 |
| R-PR5 | Promotions | SCHEDULED plans never auto-activate | PRM-33 |
| R-PR6 | Checkout | Promo codes built in the CMS can't be redeemed | PRM-34 |
| R-PR7 | Checkout | Free-month plans have no effect on price | PRM-35 |

A confirmed R-* item is a P0 Fail unless the owner accepts it as known
behaviour; accepted ones move into §3 with the reason.

---

## 1C. P0 run results — 2026-10-18

**Build:** backend `c88f2fc` (clean). **Where:** isolated clone `storelah_p0` of
the local dev DB (dev DB untouched), backend on `:4100`, CMS UI at
`localhost:4100/admin`. Checkout effects were measured with real guest
`POST /api/v1/customer/bookings` calls (the server-side price customers are
charged, `breakdown.discountPct`). The booking web app on `:3001` was **not**
started, so on-screen booking display is not covered. Fixture facilities `TST`,
`TS2`, `TS3` and `P0 …` plans exist only in the clone.

**Automated:** `npx vitest run tests/e2e/floor-plan`: 4 files, **80/80 pass**.
(The full `pnpm test:e2e` also has 2 failures outside P0:
`move-in-edges` "portal/bookings without token → 401" got 201, and
`move-in-happy-path` "register → … portal-visible" got null. Not triaged.)

### 1C.1 Scoreboard

| Suite | Pass | Fail (defect) | Confirmed R-* | Not run |
| --- | --- | --- | --- | --- |
| §1A Floor plan publishing (39) | 33 | FPP-08, FPP-10 | R-FP1 (FPP-27) | FPP-28 (UI undo, same mechanism as R-FP1), FPP-36/37 (code-verified only) |
| §1B Promotions (38) | 24 | PRM-05, PRM-08, PRM-11 | R-PR1–R-PR7 (PRM-20, 27, 31–35) | PRM-19, PRM-21, PRM-25 (builder UI widgets), PRM-37 informational |

### 1C.2 Defects found (ranked)

| # | Sev | Case | Defect | Evidence | Where |
| --- | --- | --- | --- | --- | --- |
| 1 | **High** | PRM-34 (R-PR6) | Promo codes built in the CMS can't be redeemed. An ACTIVE PROMO_CODE plan `TEST10` gives 0% at checkout, and `POST /public/promotions/validate` returns `valid:false`. Checkout reads only the legacy `Promotion` table, and the builder saves the discount value only as description text ("BENEFIT: percentage 10") | booking discountPct=0, promoDiscount=0 | `core/customers.ts` promo path; `admin.js collectCodePlanPayload` |
| 2 | **High** | PRM-35 (R-PR7) | Free-month plans have no effect on price. ACTIVE plan (2 free of 12, SMALL): SMALL×12 booking pays full price ($142 due today) | booking breakdown all 0 | `core/customers.ts computeServerDueToday` |
| 3 | **High** | PRM-31 (R-PR3) | Discount facility scope is ignored. Plan scoped to UB only gave 18% at UB **and** WD. Checkout takes the best cell across all ACTIVE plans with no facility or floor filter | UB 18%, WD 18% | `core/customers.ts:786` |
| 4 | **High** | PRM-32 (R-PR4) | Plan dates are ignored. A plan that expired yesterday still gave 22%; a plan starting in 30 days already gave 23%. Validation didn't block the expired plan either (start date < end date only) | booking 22% / 23% | same |
| 5 | **High** | PRM-20 (R-PR1) | Saving an ACTIVE plan edits it live. PUT on an ACTIVE plan: status stays ACTIVE, version 4→5, and the booking price went 10% → **35% instantly**, with no validation or approval (35% is above the 25% manager threshold). The Free-months and Code tabs auto-load the newest plan of their kind **whatever its status**, so a plain "Save draft" can hit an ACTIVE or ENDED plan | booking 10% → 35% | `core/promotionPlans.ts updatePlan` (no status guard); `admin.js loadFreeMonthsPlan/loadCodePlan` |
| 6 | **High** | FPP-27 (R-FP1) | Any edit to a published floor plan takes it offline for customers. Moving one unit 1 ft → plan DRAFT → public `GET /floor-plans/:branch/:level` returns `plan: null` until re-published. The UI publish dialog does say "Further edits return it to draft", but customers see no floor plan in between | public plan null | `core/floorPlans.ts markDraft` + `getPublicFloorPlan` (ACTIVE only) |
| 7 | **High** | FPP-08 | Tier override at publish is impossible. Picking a tier in the publish review → 409 STALE_PREVIEW → the review reopens with the tier reset. It repeats forever (verified in the UI). Cause: the preview token hash includes `newSize.id`, which reflects the override | UI: POST publish 409, then re-preview, tier reset to Small | `core/unitSizeSync.ts:176` |
| 8 | **Med** | PRM-27 (R-PR2) | Free-months (and code) **Publish** ignores unsaved edits. Save → rename → Publish made the plan ACTIVE under the **old** name; the screen still shows the new name. The discount builder saves first, these two don't | verified in UI: plan name "P0 UI FM base" | `admin.js publishPromoPlan` |
| 9 | **Med** | PRM-33 (R-PR5) | SCHEDULED plans never go live. A plan scheduled with yesterday's start date stays SCHEDULED, isn't in the public feed and gives 0% at checkout. The backend has no scheduler | status SCHEDULED after wait | — |
| 10 | **Med** | PRM-05 | The rate-floor safeguard checks the wrong price. It uses the median rate of the first 200 available units of **any** size and facility ($146), not the units the plan discounts. A 45% SMALL cell passes ($80.30 ≥ $80 floor), but SMALL units at $142 drop to $78.10 | validate: "Rate floor holds … at $146/mo base" | `core/promotionPlans.ts:643–660` |
| 11 | **Med** | PRM-08 | "Schedule next month" doesn't schedule for next month: it only changes status, and the start date stays as typed. Combined with #9, the plan never activates | effectiveFrom unchanged | `admin.js` schedule handler |
| 12 | Low | PRM-37 | Performance never counts real usage. A booking that got a plan discount leaves `applied=0, discountCost=$0`; redemptions are only written by a manual API call | perf row 0/0 | checkout doesn't call `recordRedemption` |
| 13 | Low | FPP-10 | Two publishes at the same moment both apply the resize, leaving 2 rate-history entries for one change. Values happened to end up correct. The UI button guard prevents it from the screen (verified: 3 fast clicks sent 1 request) | rateHistory ×2 | no lock in `publishFloorPlanWithSync` |
| 14 | Low | PRM-11 | `PATCH /status` to the same status (ACTIVE→ACTIVE) returns 200 and writes a new version. API only; the UI checks first | v5→v6 | `setPlanStatus` |

Behaviours checked and **as designed** (no defect): publish guards EMPTY_PLAN /
PUBLISH_BLOCKED / STALE_PREVIEW (for real changes) / PLACEMENT_OVERLAP /
contracted-unit edit refusal; rate policies KEEP_PSF / KEEP_RATE / SET; DRAFT
unit promotion; inactive floor/facility/unit hidden from the public plan;
`promotions.approve` gate (403 without, legacy pass with no grants); draft
versions (numbering, single published version, wholesale restore, skipped
placements, delete keeps live plan); promo state machine and its 400s;
validation blockers and warnings; highest-cell-wins and no stacking with legacy
codes; legacy code STORELAH10 still works. Note: History → Restore on an ENDED
plan turns **the same plan** back into a DRAFT, so it can be published again.

### 1C.3a Fixes (branch `feature/6-p0-promo-floorplan-fixes`, 2026-10-18, not yet merged)

| Defect | Fix | Verified |
| --- | --- | --- |
| #7 FPP-08 tier override loop | The preview token hashes the system-resolved tier, not the operator's override (`core/unitSizeSync.ts`). Without an override the token is unchanged | New e2e test; clone API publish 200 with token + LARGE; CMS UI: one publish, 200, unit became MEDIUM |
| #5 R-PR1 live plans edited in place | `updatePlan` accepts only DRAFT / VALIDATED plans. SCHEDULED, ACTIVE and ENDED return **409 PLAN_LOCKED** with guidance (duplicate / restore / move back to draft) (`core/promotionPlans.ts`). Builders now stop on a failed save: the discount builder used to toast, set the pill to DRAFT and carry on publishing | 3 new e2e tests; clone: PUT on ACTIVE → 409; UI Save on an ACTIVE free-months plan shows the lock banner |
| #8 R-PR2 Publish skipped save | Free-months / code **Publish** and **Schedule** always save first and abort if the save fails. A SCHEDULED plan is published as scheduled (it's locked) (`admin.js publishPromoPlan`, `schedulePromoPlan`) | Clone UI: Save → rename → Publish → ACTIVE with the new name |
| #10 PRM-05 rate floor | Each safeguard prices the **cheapest available unit** each discount cell (or free-month size scope) actually hits, within plan facility scope ∩ safeguard facility/size. Also fixed: facility-scoped safeguards were skipped for plans scoped by branch **id** (they were compared with codes) | 4 new e2e tests; clone: 45% SMALL now blocks ($117.79 → $64.78 < $80) |

Tests: `npx vitest run tests/e2e/promotion-plans tests/e2e/floor-plan` → 88/88
pass. With the source fixes stashed, the 6 targeted new tests fail. Still open:
defects #1–#4, #6, #9, #11–#14 (need owner decisions or are low priority).

### 1C.3b Owner decisions applied (2026-10-18, same branch, uncommitted)

| Decision | Implementation | Verified |
| --- | --- | --- |
| R-FP1: keep the last published floor plan visible while editing | Every publish stores the public view on `FloorPlan.publishedSnapshot` (+ `publishedAt`, migration `20261018000000_floor_plan_published_snapshot`). A DRAFT plan with a snapshot is served publicly, with unit status refreshed live and deleted/inactive/moved units dropped. Legacy ACTIVE plans are captured lazily on public read and by `scripts/backfill-floorplan-snapshots.ts`. Designer badge: "Unpublished changes — customers see last published". Deleting the plan or deactivating the floor/facility still hides it | 6 e2e tests; clone: edit after publish → public still served at the old position; backfill captured 15 plans |
| Promotions #1–#5, #9 fixed before launch | **Checkout** applies a plan only if it is ACTIVE, inside its dates, and its facility / floor (/ size) scope covers the unit. **Free-month plans** price bookings that meet the commitment: month 1 free waives today's rent; the free months are listed in `breakdown.appliedPromotion` and recorded. **CMS promo codes** sync a linked redeemable `Promotion` row (benefit % / S$, dates, caps) and redeem at checkout and at `/promotions/validate` (optional `unitCode` for the scope check); `redemptionCap` / `usagePerCustomer` are enforced. **Scheduling:** due SCHEDULED plans activate and expired plans end lazily before pricing/listing, and a future-dated Publish stays SCHEDULED (409 NOT_YET_EFFECTIVE → "scheduled" toast). "Schedule next month" now sets the 1st of next month. Every plan-priced booking records a `PromotionRedemption` (#12). The public feed lists only live plans, with additive `kind`, `facilities`, `floors`, `effectiveFrom/To`, `freeMonths` | 14 new e2e tests; clone: UB-only plan 18% at UB / 0% at WD; expired plan 0% and auto-ENDED; scheduled plan auto-activated → 7%; SMALL code 20% first month; free months SMALL×12 → $0 due today, perf applied=1 |
| #5: live plans must be disabled before editing | ACTIVE → DRAFT allowed as **Disable** (versioned "Disabled for editing"); stops applying at checkout at once; edit; Publish re-validates. Library: "Disable to edit" / "Unschedule" + "End". Restore refused on live plans (409); same-status PATCH is a no-op (#14) | e2e; clone API + UI (Library Disable → DRAFT) |

**Booking app follow-up (separate repo, not done here):** the booking summary
computes its own price from the public feed. For full parity it must (a) skip
plans whose `facilities` / `floors` don't cover the selected unit, (b) show
`freeMonths` plans (month 1 free → $0 rent today), and (c) send `unitCode`
to `/promotions/validate`. Until then, for scoped plans and free-month plans
the booking screen can show a different figure from the invoice; Stripe
charges the server figure.

**Deploy order (prod):** run migration `20261018000000_floor_plan_published_snapshot`
(direct Neon URL), deploy the Lambda code, then run
`scripts/backfill-floorplan-snapshots.ts`. Each step needs owner authorization.
**Config note:** the global $80/mo rate floor is above locker list prices
($61–$84), so any all-sizes promotion that includes lockers is blocked by
validation. Scope promotions by size, or add a LOCKER-specific floor.

### 1C.4 Release + rerun (2026-10-19)

**Released:** backend `948886e` live on Lambda (rollback = version 17 = `c88f2fc`), prod
migration `20261018000000` applied, 10/10 live floor plans snapshotted; booking
`5012b57` live via Amplify job 93 (gate unchanged, content check behind the gate
still owner-side).

**P0 rerun on the final code (test copy):** all §1A/§1B cases pass except
**FPP-10** (known, low: two simultaneous publishes both write rate history).
R-FP1 and R-PR1–R-PR7 no longer reproduce.

**Backend e2e:** 142/142. The 2 move-in tests were stale, not bugs. One predates
the deliberate stale-token guest fallback (`c880f0e`); the other expected a
public plan from an unpublished fixture. Both tests updated.

**P1 suites (test copy, API level): 27/30 pass.**

| Area | Result |
| --- | --- |
| Facilities ST-13/14 | Pass: create/validate, edit, code immutable, inactive hidden from booking, delete guarded (409) |
| Floors FL-02..05 | Pass: create, duplicate level 409, edit, delete empty, delete with units 409, deactivate |
| Units UN/UM | Pass: create + validation (incl. legacy `climateControl` 400), list filters + paging, edit, rate change + history, map + size filter, delete guard (occupied 409), CSV import (2 created / 2 errors reported) |
| Safeguards PR-21 | Pass |
| Protection & Addons EX | Pass: CRUD, slug validation, price/wasPrice reach the public catalog, inactive hidden |
| Settings / business rules / fees ST-01..08 | Pass: range + unknown-key validation; fee resolve picks Product > Facility > Global (75 / 50 / 1) |
| Users ST-09..12, RB-01..03, RB-06 | Pass: password rule, grants gate fees / rules / users, every CMS route 401 without a valid token |
| **RB-04 facility scoping** | **FAIL:** an operator limited to one facility can read and edit other facilities' units. Access rows are saved but never enforced (`scopedBranchIds` has no callers) |
| **RB-05 VIEWER role** | **FAIL:** a VIEWER can create units and save settings. The role isn't checked on writes |
| Activity feed (observation) | Booking events sort by move-in date, so future move-ins sit above today's changes in "Latest Unit Activity" |

P2 (Customers, Leads, Overview, Finance, Content, Facility ops) and P3 (shell,
Known-NW re-check) not run yet.

### 1C.3 Owner decisions needed

1. R-FP1: should a published floor plan stay visible while it's being edited?
   (E.g. keep serving the last published snapshot until re-publish.)
2. Promotions #1–#5, #9: the CMS promo engine doesn't drive checkout except
   ACTIVE discount-matrix cells, and those ignore scope and dates. Fix before
   launch, or hide the Free-months / Promo-code builders and scope selectors
   until checkout supports them?
3. #5: should editing an ACTIVE plan be blocked (forcing Duplicate → new draft),
   as the History panel's own rule text says?

---

## 2. Test cases by sidebar item

Status column: **Live** = wired to API (expected to pass) · **Client** = works
without an API (client-side only) · **Known-NW D-xx** = does not work, reason in §3.

### 2.0 Global shell (sidebar + topbar)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| SH-01 | Boot / auto-login | Open `/admin` | Overview loads with data; no login prompt | `GET /config`, `POST /login`, `GET /branches /floors /sizes` | Live |
| SH-02 | Boot failure | Unset admin creds env, restart, open | Banner explains creds not configured; no infinite spinner | `GET /config` 4xx | Live |
| SH-03 | Facility selector | Pick each facility, then All | Options = All + every branch; selection re-scopes current facility tab and returns to Overview | — | Client |
| SH-04 | 9 top-level nav items | Click each: Overview, Leads, Customers, Facilities, Protection & Addons, Discount & Promotion, Finance, Content, Global Settings | Opens first sub-page, expands its submenu | — | Client |
| SH-05 | Re-click active parent | Click an active+expanded parent | Submenu collapses (page stays) | — | Client |
| SH-06 | Every sub-item | Click all 45 sub-items (listed in §2.1–2.9) | Correct page + inner tab opens; only clicked entry highlighted | — | Client |
| SH-07 | Leads badge | Compare badge vs leads awaiting first contact | Equal | `GET /leads` | Live |
| SH-08 | Facilities badge | Compare with open work orders / incidents / expiring certs | Count matches | `GET /work-orders /incidents /inspections/certificates?expiring=1` | Live |
| SH-09 | Hamburger `#navToggle` (desktop) | Click | Toggles icon-rail ↔ full; choice persists after reload (localStorage); aria-expanded flips | — | Client |
| SH-10 | Rail hover/focus preview | Collapse rail, hover / Tab into sidebar | Expands temporarily; leaves → rail; nav items show title tooltips in rail | — | Client |
| SH-11 | Drawer mode (≤760px) | Open drawer, tap backdrop; tap a nav item | Backdrop closes; nav tap navigates and closes drawer | — | Client |
| SH-12 | 900px breakpoint | Resize across 900px with no stored choice | Auto-collapses/expands; with stored choice, resize does not override | — | Client |
| SH-13 | Global search `#globalSearch` + ⌘K | Type a lead name; press ⌘K | — | none | **Known-NW D-01** |
| SH-14 | Notifications bell | Click | — | none | **Known-NW D-02** |
| SH-15 | User chip (FZ / Faisal / Administrator) | Log in as another operator | — | none | **Known-NW D-23** |
| SH-16 | Toast | Trigger any save | Toast shows ~3s then hides | — | Client |

### 2.1 Overview

#### 2.1.1 Command centre (`#command`)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| OV-01 | 5 stat tiles | Load page | New leads today, Awaiting first response, Occupancy %, Monthly revenue, Action items = values recomputed from API (cross-check with Leads + Finance) | `GET /summary /leads /action-items` | Live |
| OV-02 | Lead funnel | Load | One step per stage with count and % of first stage (no % on Won/Lost) | `GET /leads` | Live |
| OV-03 | Funnel period picker `#funnelPeriod` | Look for control | — | none | **Known-NW D-07** |
| OV-04 | Priority queue | Load | Top 5 action items with tone colour; empty → "No priority items." | `GET /action-items` | Live |
| OV-05 | Priority queue "View all" | Click | Opens Leads → Lead database | — | Client |
| OV-06 | Enquiry sources | Load | Bars per source, counts sum to total leads | `GET /leads` | Live |
| OV-07 | Team pulse | Load | — (hardcoded advisors) | none | **Known-NW D-06** |
| OV-08 | Monthly Revenue chart | Load | Chart renders from `summary.monthlyRevenue` | `GET /summary` | Live |
| OV-09 | Revenue / Occupancy mini-tabs | Click Occupancy | — | none | **Known-NW D-05** |
| OV-10 | Occupancy by Branch chart | Load | Bars per facility = occupancy from summary | `GET /summary` | Live |
| OV-11 | Latest Unit Activity | Edit a unit rate, return | New activity at top with icon + "time ago" | `GET /units/activity?limit=5` | Live |
| OV-12 | "Today" button | Click | — | none | **Known-NW D-03** |
| OV-13 | "Run today's operations →" | Click | — | none | **Known-NW D-04** |

#### 2.1.2 Facility portfolio (`#portfolio`)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| PF-01 | Portfolio cards | Load | One card per facility: sqft, units, rates computed from live units | `GET /portfolio` | Live |
| PF-02 | "+ Inspection" on a card | Click | Checklist form opens pre-filled with that facility; Save creates checklist (verify in Facilities → Inspections) | `POST /inspections/checklists` | Live |
| PF-03 | "+ Work order" on a card | Click, fill, Save | Work order created for that facility (verify in Maintenance) | `POST /work-orders` | Live |
| PF-04 | "⭳ Report" | Click | Area report renders per floor (authoritative snapshot if any, else live metrics) | `GET /floor-plans/:id/metrics/snapshots/authoritative`, `/metrics` | Live |
| PF-05 | Net rental rate / sqft table | Load | Per facility Units / Sqft / MRR / Net PSF; market PSF reference line | `GET /rates/net-psf` | Live |
| PF-06 | "Back to Command centre" | Click | Opens Overview | — | Client |

#### 2.1.3 Performance dashboards (`#analytics`)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| AN-01 | 10 stat tiles | Load | Occupancy, MRR, Avg PSF, Overdue, Leads + Enquiries, Qualified, Bookings (conv %), Median first response (n=), Lost revenue (lost count) | `GET /summary /leads /leads/stats` | Live |
| AN-02 | Enquiries & bookings chart + Volume/Value tabs | Toggle tabs | 8 weekly groups; Value switches to $ | `GET /analytics/weekly?weeks=8` | Live |
| AN-03 | Conversion by facility | Load | Bar per facility with % | `GET /leads/stats` | Live |
| AN-04 | Advisor scorecard + loss reasons | Load | Table per owner; loss-reason bars | `GET /leads/stats` | Live |
| AN-05 | Export | Click | Downloads `analytics-YYYY-MM-DD.csv` with WEEKLY / FACILITY / ADVISOR sections; no data → "Nothing to export" toast | — | Client |
| AN-06 | Share dashboard | Click | Toast "Analytics link copied"; clipboard = `…/admin#analytics`; opening it lands on analytics | — | Client |

### 2.2 Leads

#### 2.2.1 Lead database (`#leads`)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| LD-01 | Table load | Open | Columns Lead, Status, Intent, Product/Facility, Source, Next action, Est. value, Created; 10 per page | `GET /leads` | Live |
| LD-02 | Status filter (7 stages) | Pick each | Only that stage; count updates; combine with source | client / `?stage=` in email mode | Live |
| LD-03 | Source filter (4) | Pick each | Only that source | client / `?source=` | Live |
| LD-04 | Date-range filter | Apply presets | X-10 | `GET /leads?from&to` | Live |
| LD-05 | Pager ‹ n › | Page through | Moves 10 at a time; Prev disabled-effect at 1 | — | Client |
| LD-06 | By stage / By email toggle | Switch to By email | Rows grouped per email with counts; search box appears (debounced); paging becomes server-side | `GET /leads/groups` | Live |
| LD-07 | Group Expand / Collapse | Click on a group | Child leads load beneath; Collapse hides | `GET /leads/groups/:key` | Live |
| LD-08 | Email search (group mode) | Type part of an email | Groups filtered after debounce | `GET /leads/groups?q=` | Live |
| LD-09 | ＋ Add lead | Click, fill all fields (name, type, source, stage, facility, size, rate, owner, next action, email, mobile, note), Save | Lead appears; modal closes; toast | `POST /leads` | Live |
| LD-10 | Add lead validation | Save empty / bad email | Field errors shown, no create | `POST /leads` 400 | Live |
| LD-11 | Row Edit | Edit, change stage to LOST | Loss-reason prompt; cancel aborts; OK saves reason | `PATCH /leads/:id` | Live |
| LD-12 | Row Delete | Delete → confirm | Row gone; Cancel keeps it | `DELETE /leads/:id` | Live |
| LD-13 | Row click / Enter / Space | Click a row (not a button/checkbox) | Lead drawer opens (§2.2.6) | — | Client |
| LD-14 | Export | Click | CSV of current leads downloads | — | Client |
| LD-15 | Import | Pick CSV with 3 valid + 1 invalid row | Valid rows created, summary of failures shown | `POST /leads` per row | Live |
| LD-16 | Select-all / row checkboxes | Tick header, untick one | Header indeterminate; no drawer opens | — | Client · **Known-NW D-10** (no bulk action) |
| LD-17 | ＋ More filters | Click | — | none | **Known-NW D-08** |
| LD-18 | List / Board segment | Click Board; click List | Board → Pipeline page. List has no handler (already current) | — | Client · **D-09** |

#### 2.2.2 Pipeline (`#pipeline`)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| PL-01 | Kanban load | Open | One column per stage, cards with value; header total "$ pipeline value" | `GET /leads` | Live |
| PL-02 | Drag card to another stage | Drag Contacted → Quoted | Card moves and persists after reload | `PATCH /leads/:id` | Live |
| PL-03 | Drag to Lost | Drop on Lost | Loss-reason prompt; cancel reverts | `PATCH /leads/:id` | Live |
| PL-04 | Facility filter | Pick facility | Only that facility's cards; total recalculates | — | Client |
| PL-05 | ＋ Add lead | Same as LD-09 | Card appears in its stage | `POST /leads` | Live |

#### 2.2.3 Conversations (`#inbox`)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| CV-01 | Thread list | Open | Threads with channel label and last activity | `GET /conversations` | Live |
| CV-02 | Open thread | Click a thread | Unified timeline (messages + notes) and lead profile panel | `GET /conversations/:id/messages` | Live |
| CV-03 | Assign | Click Assign, enter owner | Thread owner updates | `PATCH /conversations/:id` | Live |
| CV-04 | ＋ New message | Click | Composer focused | — | Client |
| CV-05 | Templates | Click repeatedly | Cycles 3 static presets into composer | — | Client · D-13 |
| CV-06 | Send | Type text, Send | Message appears as outbound; **not delivered** to customer | `POST /conversations/:id/messages` | Live (stub) · **D-12** |
| CV-07 | Internal note | Type `/note text`, Send | Saved as internal note, styled differently | `POST /conversations/:id/notes` | Live |
| CV-08 | Send empty | Send with blank composer | Nothing sent; prompt to type | — | Client |

#### 2.2.4 Appointments (`#calendar`)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| AP-01 | Calendar + Today list | Open | Appointments by day; move-ins tinted green; Today list | `GET /appointments` | Live |
| AP-02 | ＋ Schedule | Fill title, person, type, facility, lead, start, end, note; Save | Appears on calendar day | `POST /appointments` | Live |
| AP-03 | Validation | End before start / empty title | Error, no save | 400 | Live |
| AP-04 | Today list Edit | Edit time | Updated | `PATCH /appointments/:id` | Live |
| AP-05 | Today list Cancel | Confirm | Status CANCELLED, removed from active | `PATCH … {status:CANCELLED}` | Live |
| AP-06 | Drag appointment to another day | Drag | Moves; overlap warning when clashing | `PATCH /appointments/:id` | Live |
| AP-07 | Drag onto Today list | Drag | Rescheduled to today | `PATCH` | Live |
| AP-08 | Date-range filter | X-10 | | `GET /appointments?from&to` | Live |

#### 2.2.5 Automation (`#automation`)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| AU-01 | Alert pills (24-hour follow-up, SLA) | Load | Counts of amber / red action items | `GET /action-items` | Live |
| AU-02 | 6 workflow cards + toggles | Click toggles | — | none | **Known-NW D-14** |
| AU-03 | ＋ Create workflow | Click | — | none | **Known-NW D-14** |

#### 2.2.6 Lead detail drawer (opened from Lead database)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| DR-01 | Details tab | Open drawer | Lead fields, stage selector | — | Client |
| DR-02 | Apply stage | Change stage, Apply | Stage saved; lists refresh | `PATCH /leads/:id` | Live |
| DR-03 | Edit | Click | Lead modal opens pre-filled | — | Client |
| DR-04 | Schedule / ＋ Schedule | Click | Appointment modal opens with this lead pre-selected | `POST /appointments` | Live |
| DR-05 | Convert | Click | Banner "Convert is manual…" and jumps to Customers → Tenants | — | **Known-NW D-11** (by design) |
| DR-06 | Delete | Confirm | Lead deleted, drawer closes | `DELETE /leads/:id` | Live |
| DR-07 | Conversations tab | Open | Thread timeline for this lead (or empty) | `GET /conversations…/messages` | Live |
| DR-08 | Send message / Save note | Type, click each | Creates thread if none, then message / note | `POST /conversations`, `…/messages`, `…/notes` | Live (send = stub D-12) |
| DR-09 | Appointments tab | Open | This lead's appointments | `GET /appointments` | Live |
| DR-10 | Close | ✕, overlay | Drawer closes | — | Client |

### 2.3 Customers (header ＋ New Quotation on every tab)

#### 2.3.0 New Quotation (header button `#addQuoteHeaderBtn`)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| QT-01 | Open modal | Click | Lead dropdown (quotable leads), facility list, available units load | `GET /quotes/quotable-leads`, `/branches`, `/units?status=AVAILABLE` | Live |
| QT-02 | Pick existing lead | Select lead | Name/contact/facility/size prefill | — | Client |
| QT-03 | Total preview | Change rate, duration, protection, promo discount, moving service | `qf-quoteTotalPreview` recalculates live | — | Client |
| QT-04 | Create quotation | Submit | Quote no. assigned; lead → PROPOSAL_SENT; appears in Quotes tab with PDF + Email status | `POST /quotes` | Live |
| QT-05 | Email status | With SES not configured locally | Pill "Not emailed" with reason tooltip (SKIPPED) | — | Live |
| QT-06 | Validation | Submit without name/rate | Error | 400 | Live |

#### 2.3.1 Tenants

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| TN-01 | Table | Open | Name, Type/Segment, Unit, Size/sqft, Rate, Status, Next payment | `GET /tenants` | Live |
| TN-02 | Search | Type name / unit | Filters; page resets to 1 | — | Client |
| TN-03 | Status filter (5) | Pick each | Filters | — | Client |
| TN-04 | Date filter | X-10 | | `GET /tenants?from&to` | Live |
| TN-05 | Prev / Next | Page | Page info updates | — | Client |
| TN-06 | + New Tenant | Fill all fields incl. unit + move-in date, Save | Tenant created; unit becomes OCCUPIED | `POST /tenants` | Live |
| TN-07 | Edit | Change rate/status | Saved | `PUT /tenants/:id` | Live |
| TN-08 | Verification Validate / Reject (edit modal, booking-linked tenant) | Click each | Review status updates and shows in modal | `GET /verifications?bookingRef`, `PATCH /verifications/:id` | Live |
| TN-09 | View | Click | Stay-history drawer timeline; ✕ / Close / Esc close it | `GET /bookings /move-ins` | Live |
| TN-10 | Deactivate | Confirm | Status INACTIVE; button disabled on inactive rows | `DELETE /tenants/:id` | Live |

#### 2.3.2 Bookings

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| BK-01 | Table | Open | Ref, Customer, Unit, Move-in, Duration, $/mo, Paid/Due, Status | `GET /bookings` | Live |
| BK-02 | Search / Status filter / Date filter | Use each | Filters correctly | client + `?from&to` | Live |
| BK-03 | Row actions | Look for actions | Read-only list | — | **D-15** (by design) |

#### 2.3.3 Move-ins

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| MI-01 | Table + date filter | Open, filter by move-in date | Rows within range | `GET /move-ins?from&to` | Live |

#### 2.3.4 Quotes

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| QQ-01 | Table | Open | PROPOSAL_SENT leads with inventory count, quote no, PDF, Email pill | `GET /quotes` | Live |
| QQ-02 | PDF | Click | Quotation PDF downloads, correct quote no | `GET /quotes/:id/pdf` | Live |
| QQ-03 | Units | Click | Matching available units listed under table | `GET /quotes/:id` | Live |
| QQ-04 | Edit / resend / delete quotation | Look | Not available | — | **D-16** |

#### 2.3.5 Move-outs

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| MO-01 | Table | Open | NOTICE tenants with last day | `GET /move-outs` | Live |
| MO-02 | Complete | Confirm | Tenant leaves, unit released to AVAILABLE | `PATCH /move-outs/:tenantId {action:complete}` | Live |
| MO-03 | Withdraw | Confirm | Notice cancelled, tenant back to ACTIVE | `PATCH … {action:cancel}` | Live |

### 2.4 Facilities

#### 2.4.1 Units Information (`facility-map`)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| UM-01 | Floor tabs | Click each level | Map for that level | `GET /units/map?level=` | Live |
| UM-02 | Size filter / Near lift | Change | Map narrows | `GET /units/map?size&nearLift` | Live |
| UM-03 | Click unit cell | Click | Detail panel loads | `GET /units/:code` | Live |
| UM-04 | Detail tabs: Overview, Tenant history, Bookings, Invoices, Activity | Click each | Correct data; history filter `udHistFilter` filters; Retry on error | `GET /tenants /bookings /move-ins /units/activity` | Live |
| UM-05 | 📋 History | Click | Jumps to Tenant history tab | — | Client |
| UM-06 | ✏️ Edit | With/without selection | Unit modal pre-filled / "Select a unit first." | `PUT /units/:code` | Live |
| UM-07 | ⚡ Adjust Rate | New rate + reason, Apply | Rate updated; activity logged | `POST /units/:code/rate` | Live |
| UM-08 | 🗑 Delete | Available unit vs occupied unit | Available: confirm → deleted. Occupied/reserved/overdue: refused with reason | `DELETE /units/:code` | Live |
| UM-09 | 👁 Show Floor Plan | With selection | Opens designer on that unit's floor | — | Client |

#### 2.4.2 Units (`facility-units`)

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| UN-01 | Table + pager | Open, Prev/Next | Paged list | `GET /units?page=` | Live |
| UN-02 | Facility / Level / Status / AC filters | Combine | Server-side filtering; level list follows facility | `GET /units?…` | Live |
| UN-03 | + Add Unit | Pick facility → floors load; size → sqft/rate defaults; Save | Unit created with generated code | `POST /units` | Live |
| UN-04 | Row View / Edit / Rate / Delete | Each | Same as UM-03, UM-06, UM-07, UM-08 | | Live |
| UN-05 | ⭳ Import | Upload CSV (valid + invalid rows) | Created/failed summary | `POST /units/import` | Live |

#### 2.4.3 Floors

| ID | Control | Steps | Expected | API | Status |
| --- | --- | --- | --- | --- | --- |
| FL-01 | Table + facility filter | Open | Floors per facility with status | `GET /floors` | Live |
| FL-02 | + Add Floor | Facility, level, name, active; Save | Created (inactive if unticked) | `POST /floors` (+`PUT` isActive) | Live |
| FL-03 | Edit | Rename | Saved | `PUT /floors/:id` | Live |
| FL-04 | Deactivate / Activate | Confirm | Status flips; inactive levels disappear from all selectors | `PUT /floors/:id {isActive}` | Live |
| FL-05 | Delete | Floor with units vs empty floor | Empty: deleted; with units: falls back to deactivate / refuses with reason | `DELETE /floors/:id` | Live |
| FL-06 | Designer | Click | Opens Floor Plan Designer on that floor | — | Client |

#### 2.4.4 Floor Plan Designer (`facility-floorplans`) — **P0** (run after §1A)

Run on a throw-away floor. Each tool: activate by button **and** shortcut.

| ID | Control | Expected | API | Status |
| --- | --- | --- | --- | --- |
| FP-01 | Facility / Floor selectors | Load plan + palette of unplaced units | `GET /floor-plans/:floorId` | Live |
| FP-02 | Plan size button → width / height / GFA, Save plan size | Canvas resizes; GFA shown in label | `PUT /floor-plans/:floorId` | Live |
| FP-03 | Select tool (V), click / Shift-click / marquee / Cmd+A | Selection + multi-select strip | — | Client |
| FP-04 | Drag unit from palette to canvas | Placement saved; leaves palette | `PUT …/units/:unitId` | Live |
| FP-05 | Move / nudge (arrows, Shift ×10, Alt 0.01) / numeric inspector (Enter applies, Esc reverts) | Position persists | `PUT …/units/:unitId` | Live |
| FP-06 | Rotate (ghost) / Lock area | Rotation & sqft lock respected | `PUT` | Live |
| FP-07 | New-unit tool (N): drag rectangle → tier/rate form → Enter | Draft unit created; Esc cancels; Delete discards new unit | `PUT/batch` | Live |
| FP-08 | Boundary / line tool (L): vertices, typed length + Tab angle, C closes, Backspace, double-click finishes | Boundary saved; vertex edit/delete | `POST/PUT/DELETE …/boundaries` | Live |
| FP-09 | Add block (B): name, colour, Default, Add block, Cancel; rename; delete | Block saved/updated/removed | `POST/PUT/DELETE …/blocks` | Live |
| FP-10 | Markers menu (K): add, rename, move, delete safety markers | Saved | `POST/PUT/DELETE …/markers` | Live |
| FP-11 | Measure tool (M) | Two clicks show distance; Esc exits | — | Client |
| FP-12 | Door-move tool (D) | Door slides along wall edge, persists | `PUT …/units/:unitId` | Live |
| FP-13 | Auto-place / Auto-doors | Places unplaced units / assigns doors; result summary | `POST …/batch` | Live |
| FP-14 | Multi-select strip: align ×6, distribute H/V, Duplicate, Remove | Geometry updated; Remove returns units to palette | `POST …/batch` | Live |
| FP-15 | Array form (count, direction, gap, Place/Cancel) | N copies placed; "short" message when space runs out | `POST …/batch` | Live |
| FP-16 | Copy / Paste / Duplicate (Cmd+C/V/D) | Works for blocks, markers, lines; D on unit makes new draft unit | `POST …/batch` | Live |
| FP-17 | Undo / Redo (buttons + Cmd+Z / Shift+Z / Y) | Reverses / re-applies last change server-side | various | Live |
| FP-18 | Sizes warning button | Lists size mismatches; Reconcile modal fixes; Done closes | `GET …/size-mismatches`, `POST …/reconcile` | Live |
| FP-19 | Layers, Grid toggle, Object snap, Snap step (button + select) | View/snap behaviour changes | — | Client |
| FP-20 | Underlay: upload image, opacity/position, remove | Image under grid, persists | `POST/PUT/DELETE …/underlay`, `GET …/underlay/image` | Live |
| FP-21 | Zoom − / + / label menu (50/75/100/150%/Fit) / preset / Shift+1 | Zoom changes | — | Client |
| FP-22 | Palette AC filter + collapse toggle | Filters unplaced list; panel collapses | — | Client |
| FP-23 | Structure text area | Notes saved with plan | `PUT /floor-plans/:floorId` | Live |
| FP-24 | Shortcuts sheet (button / `?`) | Sheet lists all shortcuts; Esc closes | — | Client |
| FP-25 | Export: format, scale, grid, underlay, Export | File downloads in chosen format | — | Client |
| FP-26 | ⋯ More → Save as draft | Draft version saved, appears in Library | `POST …/drafts` | Live |
| FP-27 | ⋯ More → Delete plan | Confirm → plan cleared | `DELETE /floor-plans/:floorId` | Live |
| FP-28 | Publish → publish-preview modal → Publish / Cancel | Preview lists going live / back to draft / skipped; publish updates units | `GET …/publish-preview`, `POST …/publish` | Live |
| FP-29 | Area metrics panel Refresh | Metrics recalc | `GET …/metrics` | Live |
| FP-30 | Publish guards | Publish with overlaps / unplaced | Blocked with reason (also covered by `tests/e2e/floor-plan-publish-guards.test.ts`) | Live |

#### 2.4.5 Floor Plan Library — **P0** (run after §1A)

| ID | Control | Expected | API | Status |
| --- | --- | --- | --- | --- |
| LB-01 | Draft list for selected floor | Versions with name, status | `GET /floor-plans/:floorId/drafts` | Live |
| LB-02 | Rename → Save / Cancel | Name saved (draft only) | `PUT /drafts/:id` | Live |
| LB-03 | View | Read-only preview modal; Close / ✕ / Esc; Edit → opens designer | `GET /drafts/:id` | Live |
| LB-04 | Load | Draft loaded into editable canvas; live plan unchanged | `GET /drafts/:id` | Live |
| LB-05 | Publish | Preview modal then publish | `GET /drafts/:id/publish-preview`, `POST /drafts/:id/publish` | Live |
| LB-06 | Delete | Confirm → removed | `DELETE /drafts/:id` | Live |
| LB-07 | Open Designer | Jumps to designer | — | Client |

#### 2.4.6 Maintenance

| ID | Control | Expected | API | Status |
| --- | --- | --- | --- | --- |
| MT-01 | Work orders table + status filter | Filters by status | `GET /work-orders?status=` | Live |
| MT-02 | + New Work Order / Edit | Create & update (facility, unit, priority, vendor, due) | `POST/PATCH /work-orders` | Live |
| MT-03 | → next status (advance) | OPEN → IN_PROGRESS → DONE chain | `PATCH /work-orders/:id {status}` | Live |
| MT-04 | Delete | Confirm → removed | `DELETE /work-orders/:id` | Live |
| MT-05 | Preventive tasks: + New Task / Edit / Delete; progress bar | CRUD + progress % | `GET/POST/PATCH/DELETE /preventive-tasks`, `/progress` | Live |

#### 2.4.7 Assets & vendors

| ID | Control | Expected | API | Status |
| --- | --- | --- | --- | --- |
| AS-01 | Assets: + New / Edit / Delete | CRUD | `/assets` | Live |
| AS-02 | Vendors: + New / Edit / Delete | CRUD; vendor selectable in work orders | `/vendors` | Live |

#### 2.4.8 Incidents

| ID | Control | Expected | API | Status |
| --- | --- | --- | --- | --- |
| IN-01 | Severity + status filters | Filtered list | `GET /incidents?severity&status` | Live |
| IN-02 | + New / Edit / advance status / Delete | CRUD + status chain | `/incidents` | Live |

#### 2.4.9 Access control (5 inner tabs)

| ID | Control | Expected | API | Status |
| --- | --- | --- | --- | --- |
| AC-01 | Inner tabs Live / Credentials / Temporary / Exceptions / Policies | Switch panels; last tab remembered | — | Client |
| AC-02 | Live: stats + events; + Log Event | Event logged (door, credential, result) and appears top | `GET /access/stats /access/events`, `POST /access/events` | Live |
| AC-03 | Credentials: + New / Edit / Revoke | Revoke → REVOKED; no actions on revoked rows | `/access/credentials` | Live |
| AC-04 | Temporary | Lists temporary credentials; same Edit/Revoke | `GET /access/credentials?temporary=1` | Live |
| AC-05 | Exceptions | DENIED events list (read-only) | `GET /access/events?result=DENIED` | Live |
| AC-06 | Policies: + New / Edit / Delete | CRUD | `/access/policies` | Live |
| AC-07 | Doors: + New / Edit / Delete | CRUD | `/access/doors` | Live |

#### 2.4.10 Inspections

| ID | Control | Expected | API | Status |
| --- | --- | --- | --- | --- |
| IS-01 | Checklists: frequency filter, + New / Edit / Delete | CRUD + filter | `/inspections/checklists` | Live |
| IS-02 | Certificates: + New / Edit / Delete; expiring highlighted | CRUD; expiring feeds Facilities badge | `/inspections/certificates` | Live |

### 2.5 Protection & Addons

| ID | Control | Expected | API | Status |
| --- | --- | --- | --- | --- |
| EX-01 | Protection plans table | Plans with price, coverage, active | `GET /protection-plans` | Live |
| EX-02 | + Add plan / Edit (modal Save/Cancel/✕/Esc) | Created / updated | `POST/PATCH /protection-plans` | Live |
| EX-03 | Deactivate / Activate | Confirm → flips; booking app hides inactive | `PATCH … {active}` | Live |
| EX-04 | Delete | Confirm → removed (deactivate preferred) | `DELETE /protection-plans/:id` | Live |
| EX-05 | Addons: same 4 actions | Same as above | `/addons` | Live |
| EX-06 | Cross-app check | Change price → booking checkout step shows new price | public API | Live |

### 2.6 Discount & Promotion — **P0** (run after §1B)

| ID | Control | Expected | API | Status |
| --- | --- | --- | --- | --- |
| PR-01 | Dashboard: Active rule sets + 2 live charts | Counts & charts from API; empty-state text when none | `GET /promotions /promotion-plans /promotion-plans/performance` | Live |
| PR-02 | Dashboard: Discount cost, Effective revenue, Conflicts, What needs attention | — | partial | **Known-NW D-17** |
| PR-03 | Discount builder: facility + floor scope selectors | Floor list follows facility | `GET /floors` | Live |
| PR-04 | Discount matrix cells | Colour band updates on change (low/mid/hot) | — | Client |
| PR-05 | Plan name + start date; Save Draft | Draft saved; status pill DRAFT | `POST/PUT /promotion-plans` | Live |
| PR-06 | Validate plan → modal → Confirm | Live checks (rate floor etc.); pass → VALIDATED | `POST /promotion-plans/:id/validate`, `PATCH …/status` | Live |
| PR-07 | Schedule next month | Status SCHEDULED, effectiveFrom = 1st next month; unvalidated → blocked | `PATCH …/status` | Live |
| PR-08 | Publish | ACTIVE; previous active version ended | `PATCH …/status` | Live |
| PR-09 | Duplicate / History buttons | New draft copy / jumps to History | `POST …/duplicate` | Live |
| PR-10 | Free months: name, count, commitment, facility, month strip clicks, allocation Upfront/Back-loaded/Spread/Manual | Strip & summaries (offer, applied, effective %) update; Save/Validate/Publish as PR-05–08 | `/promotion-plans` | Live |
| PR-11 | Promo code builder: benefit choice, name, code, value, conditions (+ Add condition), dates, cap, stack/exclusive | Preview updates; save/validate/publish | `/promotion-plans` | Live |
| PR-12 | Library: table, date filter | Plans + legacy promos | `GET /promotion-plans /promotions` | Live |
| PR-13 | Library: Open | Opens plan in its builder, populated | `GET /promotion-plans/:id` | Live |
| PR-14 | Library: Delete (draft only) | Draft deleted; non-draft Delete disabled with tooltip | `DELETE /promotion-plans/:id` | Live |
| PR-15 | Library: Disable / End | ACTIVE/SCHEDULED → ENDED | `PATCH …/status {ENDED}` | Live |
| PR-16 | Library: Type / Status / Facility / Storage type filters | — | none | **Known-NW D-18** |
| PR-17 | Library: legacy promotion "Open" | Jumps to Discount builder but doesn't load the code | — | **D-19** |
| PR-18 | History: plan picker, versions table, date filter | Versions of picked plan | `GET …/versions` | Live |
| PR-19 | History: Restore as draft | New draft from version | `POST …/restore` | Live |
| PR-20 | History: Compare (from/to) | Field-level diff table | `GET …/compare` | Live |
| PR-21 | Safeguards: Configured rate floors add / delete | Rule added/removed; validation then enforces it | `GET/POST/DELETE /safeguards` | Live |
| PR-22 | Safeguards: Configure priority + static policy cards | — | none | **Known-NW D-20** |
| PR-23 | Performance: Performance-by-plan table | Live applied / cost / cap / budget; Revenue & Retention "—" | `GET …/performance` | Live (partial) |
| PR-24 | Performance: Last 90 days, revenue impact chart, commercial health | — | none | **Known-NW D-21** |

### 2.7 Finance

| ID | Control | Expected | API | Status |
| --- | --- | --- | --- | --- |
| FN-01 | Overview stats: MRR, Invoices, Total due, Overdue units | Match API | `GET /invoices /summary` | Live |
| FN-02 | Overview "Collection rate" tile | Always "—" (aging box shows the real %) | — | **D-22** |
| FN-03 | Aging: Paid / Due / Overdue / Collection rate / Total | Counts match invoice statuses | `GET /invoices` | Live |
| FN-04 | Invoices tab + date filter | First 20 invoices in range | `GET /invoices?from&to` | Live · **D-22** (20-row cap, no paging) |
| FN-05 | Arrears tab | OVERDUE only, "days overdue" correct; shares date range with Invoices | `GET /invoices` | Live |
| FN-06 | Export / ＋ Create invoice | — | none | **Known-NW D-22** |

### 2.8 Content

| ID | Control | Expected | API | Status |
| --- | --- | --- | --- | --- |
| CT-01 | Table + type filter + published filter | Filtered list | `GET /content?type&published` | Live |
| CT-02 | + Add content (key, type, text fields) | Created | `POST /content` | Live |
| CT-03 | Edit → Save | Updated | `PUT /content/:key` | Live |
| CT-04 | Upload image / Remove image (in modal) | Image stored and previewed / removed | `POST/DELETE /content/:key/image` | Live |
| CT-05 | Publish / Unpublish | Flips; only published items reach the landing build | `PUT /content/:key {published}` | Live |
| CT-06 | Delete | Confirm → removed | `DELETE /content/:key` | Live |
| CT-07 | Modal fields per type | Changing type shows the right fields | — | Client |

### 2.9 Global Settings

| ID | Control | Expected | API | Status |
| --- | --- | --- | --- | --- |
| ST-01 | General: grouped cards (toggles / number / text / select) | Values from API; editing shows "Unsaved general changes" and enables header Save | `GET /settings` | Live |
| ST-02 | Save general settings | Only changed keys sent; dirty clears; reload keeps values; invalid value → banner | `PUT /settings` | Live |
| ST-03 | Toggle keyboard | Space/Enter on a switch flips it | — | Client |
| ST-04 | Booking & billing: limits + Save booking & billing | Own dirty state; header save not affected | `PUT /settings` | Live |
| ST-05 | Business rules + Save rules | Typed values saved; operator without `businessRules.manage` → 403 banner | `GET/PUT /business-rules` | Live |
| ST-06 | Fees & deposits: + Add rule (kind, key, scope, facility/size/tenant, amount kind, amount, note) | Rule listed; scope-dependent selects | `POST /fees` | Live |
| ST-07 | Fee Delete | Confirm → removed | `DELETE /fees/:id` | Live |
| ST-08 | Effective-rule preview Resolve | Shows winning rule by priority Global→Facility→Product→Exception | `GET /fees/resolve` | Live |
| ST-09 | Team: + Add operator (email, name, password 8+, role) | User listed; short password → error | `POST /users` | Live |
| ST-10 | Access → Save access | Facility scoping saved | `PUT /users/:id/access` | Live |
| ST-11 | Permissions → Save grants | Grants added/removed | `POST/DELETE /users/:id/permissions` | Live |
| ST-12 | Delete operator | Confirm → removed | `DELETE /users/:id` | Live |
| ST-13 | Facilities: + Add Facility (code, name, address, hours, active, description) | Created; code immutable on edit | `POST /branches` | Live |
| ST-14 | Facility Edit / Deactivate-Activate / Delete / Floors | Edit saved; status flips (hidden from booking when inactive); delete with floors → refused or deactivated; Floors jumps to Facilities → Floors filtered | `PUT/DELETE /branches/:id` | Live |
| ST-15 | Tab memory | Leave Settings and return | Last selected tab restored | — | Client |

### 2.10 Permissions (RBAC) pass

Create three operators in Settings → Team: OWNER, MANAGER, VIEWER, and a MANAGER
with no grants vs. one with grants. Because the CMS auto-logs in as the
configured admin, run this pass at API level (log in as each user with
`POST /api/v1/cms/login`, call with the token) or temporarily point the admin
creds at the test user.

| ID | Check | Expected |
| --- | --- | --- |
| RB-01 | `fees.manage` | Without grant (when user holds any grant): `POST/DELETE /fees` → 403 |
| RB-02 | `businessRules.manage` | `PUT /business-rules` → 403 without grant |
| RB-03 | `users.manage` | All `/users*` writes → 403 without grant |
| RB-04 | Facility scoping | User scoped to facility A cannot read/write facility B data |
| RB-05 | VIEWER role | Record actual behaviour on writes (no route-level VIEWER block found in code — flag result for owner decision) |
| RB-06 | No token / bad token | Every `/api/v1/cms/*` route except `/config` and `/login` → 401 |

### 2.11 Cross-module (end-to-end) scenarios

| ID | Scenario | Verify |
| --- | --- | --- |
| E2E-01 | Lead → Quote → Tenant | Add lead → New Quotation (lead PROPOSAL_SENT, in Quotes, PDF) → create tenant on that unit → unit OCCUPIED on map, Overview occupancy changes |
| E2E-02 | Booking from booking app | Complete a test-mode booking on `localhost:3001` → appears in Customers → Bookings / Move-ins, unit RESERVED, verification visible on tenant |
| E2E-03 | Move-out | Put tenant on notice → Move-outs → Complete → unit AVAILABLE, activity logged |
| E2E-04 | Rate change | Adjust rate → activity feed, portfolio MRR / net PSF, unit detail Activity tab |
| E2E-05 | Facility retire | Deactivate facility → hidden from booking app facility list, still visible in CMS |
| E2E-06 | Floor plan publish | New unit drafted in designer → publish → unit appears in Units list and booking floor plan |
| E2E-07 | Promo | Publish discount plan → booking app price reflects discount; End it → price reverts |
| E2E-08 | Extras | Deactivate addon → disappears from booking checkout |
| E2E-09 | Content | Publish hero text → landing build (`pnpm build` in landing, build-time fetch) shows it; unpublish → fallback |

---

## 3. Known non-working register (reason for every dead or partial control)

Verified in code at `c88f2fc`. Testers mark these **Known-NW**, not Fail, unless
behaviour differs from the description.

| ID | Location | Control | What happens | Reason (code evidence) |
| --- | --- | --- | --- | --- |
| D-01 | Topbar | Global search + ⌘K hint | Typing does nothing | `#globalSearch` has no listener in any admin module; no search API exists |
| D-02 | Topbar | Notifications bell | No-op | Button has no id/listener; no notification model |
| D-03 | Overview | "Today" | No-op | No listener (`dashboard.html` command head) |
| D-04 | Overview | "Run today's operations →" | No-op | No listener; no "daily ops" workflow defined |
| D-05 | Overview | Revenue / Occupancy mini-tabs | Tabs don't switch chart | `.mini-tab` has no listener; chart always revenue (occupancy is the separate branch chart) |
| D-06 | Overview | Team pulse card + "On track" pill | Hardcoded Nur Aisyah / Marcus Lim / Ravi Kumar figures | `refreshCommandPage` writes a static placeholder table; no staff-performance data source (the real advisor scorecard is on Performance dashboards) |
| D-07 | Overview | Lead funnel period picker | Empty | `#funnelPeriod` container is never mounted by JS; funnel is all-time |
| D-08 | Leads | ＋ More filters | No-op | No listener; only status/source/date filters implemented |
| D-09 | Leads | "List" segment | No-op | Already the current view; real mode switch is the injected By stage / By email toggle |
| D-10 | Leads | Row checkboxes / select-all | Select works, nothing to do with it | `initSelectAll` only syncs checkbox state; no bulk-action endpoints or UI |
| D-11 | Lead drawer | Convert | Banner + jump to Tenants | By design: no `POST /leads/:id/convert` endpoint; conversion is manual |
| D-12 | Conversations, drawer | Send | Message recorded, **never delivered** | `POST /conversations/:id/messages` is a stub (`delivered:false`); WhatsApp/email delivery not built — needs ops decision |
| D-13 | Conversations | Templates | Cycles 3 fixed texts | Static `INBOX_TEMPLATES` array; no template management |
| D-14 | Automation | ＋ Create workflow, 6 workflow cards, toggles | No-op; toggles don't flip | Static markup; no automation/workflow model. Only the two alert pills are live |
| D-15 | Customers → Bookings, Move-ins | Row actions | Read-only | By design: bookings come from the booking app; no CMS cancel/edit booking route |
| D-16 | Customers → Quotes | Edit / resend / delete quotation | Not available | Only `POST /quotes`, `GET /quotes/:id(/pdf)` exist |
| D-17 | Promotions → Dashboard | Discount cost, Effective revenue, Conflicts, "What needs attention", Active-rule-set sub-line | Show prototype values ($9.8k, $24.6k, 3, "Stay 12 Pay 10" conflict) until the **Performance** tab is opened once; after that Effective revenue and Conflicts show "—" | Only `bindPromoPerformance()` writes these ids, and it runs only on the Performance tab; effective revenue and conflict detection are not computed |
| D-18 | Promotions → Library | Type / Status / Facility / Storage type filter buttons | No-op | No listeners; only the date-range filter is wired |
| D-19 | Promotions → Library | "Open" on legacy promotion rows | Jumps to Discount builder empty | Legacy `Promotion` rows render `data-tab-jump` without `data-open-plan`; no legacy-promo editor exists |
| D-20 | Promotions → Safeguards | "Configure priority" + priority flow, risk controls, edge-case policy, approval workflow cards | No-op / static text | Static documentation markup; only "Configured rate floors" card is live |
| D-21 | Promotions → Performance | "Last 90 days", revenue-impact chart, commercial-health bars; Revenue & Retention columns | No-op / static numbers / "—" | Static prototype markup; perf table notes revenue/retention need invoice/tenure joins |
| D-22 | Finance | Header Export, ＋ Create invoice; Collection rate tile; Invoices list | No-op; tile always "—"; max 20 rows | No listeners; no invoice-create or payment-recording API; `bindBilling` hardcodes "—" and slices to 20 |
| D-23 | Sidebar footer | User chip "FZ / Faisal / Administrator" | Never changes | Hardcoded in `dashboard.html`; `getCurrentUser()` result is not rendered |
| D-24 | Modals | Esc on Quote, Floor, Facility (branch) modals | Esc does nothing (✕/Cancel work) | Global Esc handler (`admin.js` wireEvents) covers unit/rate/tenant/lead/appt/fp-view only; extras, content and ops modals have their own |
| D-25 | Auth | Login / logout | No login screen or logout; every visitor gets the admin session | CMS fetches admin creds from `GET /api/v1/cms/config` — accepted for MVP, must be fixed before public launch (protected only by the CloudFront Basic Auth gate) |

---

## 4. Coverage summary

| Sidebar item | Sub-pages | Test cases | Known-NW items |
| --- | --- | --- | --- |
| **P0 §1A Floor plan publishing** | — | 39 (FPP) | R-FP1 |
| **P0 §1B Promotions** | — | 38 (PRM) | R-PR1–R-PR7 |
| Shell | — | 16 | D-01, D-02, D-23, D-25 |
| Overview | 3 | 25 | D-03–D-07 |
| Leads | 5 + drawer | 49 | D-08–D-14 |
| Customers | 5 + quote modal | 27 | D-15, D-16, D-24 |
| Facilities | 10 | 72 | D-24 (floor modal) |
| Protection & Addons | 2 | 6 | — |
| Discount & Promotion | 8 | 24 | D-17–D-21 |
| Finance | 3 | 6 | D-22 |
| Content | 1 | 7 | — |
| Global Settings | 5 | 15 | D-24 (facility modal) |
| RBAC + E2E | — | 15 | — |
| **Total** | **42** | **~350** + 11 cross-cutting checks per page | **25** (D-01–D-25) + 8 suspected (R-*) |

## 5. Suggested automation (follow-up)

- API layer: extend `tests/e2e` (vitest + test DB) with one CRUD test per CMS
  route group listed in §2 — the floor-plan suites already follow this pattern.
- UI layer: a Playwright smoke that walks every sidebar sub-item (SH-06),
  asserts no console errors (X-06), and clicks each Known-NW control to confirm
  it is still inert (so a later fix flips the test and the register gets updated).
- Re-run §3 verification after any CMS change; update this register rather
  than letting it drift like `CMS_FUNCTIONALITY_AUDIT.md` (2026-09-12).

# Floor Plan ⇄ Unit Sync — Feature Plan

Status: **Phases 1–3 + decimal sqft pushed (`b68cec4`, `a458fd1`, `fed444c`, `3af4ee8`); Phase 4 implemented** (2026-10-14, branch `feature/5-floorplan-unit-sync`, uncommitted). Owner reversed Q1 on 2026-10-14: `Unit.sqft` is decimal (see D3). Owner accepted all recommendations: Q1 integer sqft, Q2 keep $/sqft, Q3 `MARKET_PSF[tier] × sqft`, Q4 no pillar deduction, Q5 sync on publish, Q6 RESERVED/pending-payment locked, no override.
Lane: backend (CMS designer + API). Optional cross-lane follow-up: booking (§9).
Builds on: `FLOOR_PLAN_MODEL.md`, `FLOOR_PLAN_PRECISION_PLAN.md` (decimal-feet geometry, Phases 1–5 merged on `main` at `9b46aa9`/`960edfd`).

## 1. Goal

Make the floor-plan designer the **source of truth for a placed unit's physical size**, and let
operators **create units directly on the plan**:

1. **Resize ⇒ real size.** When a unit's rectangle is resized, the unit's `sqft` (and, by rule,
   its size tier and optionally its rate) follows the drawn area.
2. **Draw ⇒ new unit.** Drawing a unit rectangle on the canvas creates a real `Unit` row
   (4-digit code, branch, floor, size tier, rate, AC/pillar) — no detour through the Units page.
3. Both follow the existing **Draft → Publish** lifecycle: nothing reaches booking until the
   plan is published.

## 2. Current state (what the code does today)

| Area | Today | File |
| --- | --- | --- |
| Unit size | `Unit.sqft Int`, `Unit.sizeId → UnitSize` (`sqftFrom/sqftTo` bands, `widthFt/heightFt` blueprint) | `prisma/schema.prisma:445-503` |
| Placement | `UnitPlacement` x/y/w/h decimal ft, `@@unique(unitId)`, `stackTier`, `doorEdges` | `schema.prisma:505-547` |
| Resize rule | New/resized placement **rejected** if `w×h` deviates > **2 %** (`AREA_TOLERANCE`) from `Unit.sqft`; moves/rotations grandfathered | `floorPlans.ts:1222-1236` (single), `:1860-1865` (batch) |
| Editor | 🔒 "lock sqft" derives the other side so area stays = sqft; units come from an **unplaced palette** only (must already exist) | `floorplanView.js:2984`, `:940-966` |
| Unit creation | Only `POST /cms/units` (+ CSV import) via `createUnit()`; codegen = next free 4-digit above MAX (codes never reused) | `units.ts:239-298` |
| Unit edit | `PUT /cms/units/:code` may set `sqft` freely — no link back to geometry | `units.ts:300-329` |
| Lifecycle | Any placement write → plan `DRAFT`; booking reads only `ACTIVE` plans. **But `Unit.sqft` is read live** by `listPublicUnits` regardless of plan state | `floorPlans.ts:1017`, `units.ts:196` |
| Occupied lock | OCCUPIED/OVERDUE placements uneditable **only while plan is ACTIVE** | `assertPlacementEditable`, batch `lockCheck` |
| Pricing | `Unit.monthlyRate` stored per unit; `psf = rate / sqft` computed; `RateChange` history; `Tenant.psf` snapshot; `MARKET_PSF` per tier | `rates.ts`, `market.ts` |
| Drafts | `FloorPlanDraft` JSON snapshots carry `sqft` per placement; publishing a draft wholesale-replaces live placements | `floorPlanDrafts.ts` |
| Booking | Shows `sqft` from public units; derives fake L×W from sqft (`unitDims`) | `storelah-booking/web/src/lib/unit-explorer.ts:54` |

So today the designer is a *view* of units; the 2 % rule actively prevents the requested
behaviour. This plan inverts that for placed units.

## 3. Core design decisions (recommended)

### D1 — Floor plan owns size for placed units
- A **placed** unit's area = its placement `width × height` (stack mates share one footprint).
- `Unit.sqft` becomes a **derived, synced** value for placed units.
- Units page: the `sqft` field is **read-only for placed units** ("Size is set on the floor plan →
  Open in designer"). Unplaced units keep the editable field (they have no geometry).
- `PUT /cms/units/:code` with `sqft` on a placed unit → `409 SIZE_OWNED_BY_PLAN` (API mirrors UI).

### D2 — Sync on **publish**, not on every save
Saving a resize only changes geometry (plan goes DRAFT as today). On **Publish**, the server
applies size changes to `Unit` rows in the same transaction as `DRAFT → ACTIVE`.
- Why: `Unit.sqft` is read live by booking/quotes/summary. Syncing on save would leak half-finished
  edits (plan hidden from booking, but list prices/sizes changed).
- **Which placements sync:** only those flagged `areaDirty` (set when a placement's area
  changes; cleared on publish). This prevents the first publish after release from mass-rewriting
  hundreds of **grandfathered** rows that were drawn under the old 15 %/2 % tolerances.
- A separate, explicit **"Reconcile sizes"** tool lists all placed units whose
  `round(w×h) ≠ sqft` and lets the operator choose per unit: *update unit to drawing* or
  *fit drawing to unit* (existing `fitSqftFootprint`).

### D3 — Rounding & precision (SUPERSEDED 2026-10-14 — decimal sqft)
**Now:** `Unit.sqft` is `DOUBLE PRECISION`, quantized to **0.01 sqft** on every write
(`quantizeSqft`, `src/core/unitSizing.ts`); a drawn unit's sqft = exact drawn area to 0.01
(`sqftForRect`); sizes within **0.05 sqft** count as the same (`sameSqft`) so catalogue-fitted rects
stored to 0.001 ft (e.g. 4.73 × 6.342 = 29.998 for 30) never show as resized. `UnitAreaChange`
previous/current widened too. CSV import accepts ≤ 2 decimals; API `sqft` is a number (was integer)
— booking and emails/PDFs render it as-is (`47.25 sq ft`); sums are rounded to 0.01.
Migration `20261014010000_unit_sqft_decimal`.

**Prod deploy (must follow):** the deployed Lambda's Prisma client writes `Int` into the widened
column as garbage (3 → 1.5e-323, same hazard as the precision migration). Only CMS unit create /
edit / CSV import (and floor-plan publish, new code only) write `Unit.sqft`; booking never does.
1. Freeze CMS unit create/edit/CSV import (and floor-plan edits — the precision procedure).
2. `prisma migrate deploy` on Neon (direct URL; explicit owner authorization).
3. Update the Lambda code immediately after.
4. Corruption check (must be 0 rows):
   `SELECT id FROM "Unit" WHERE sqft <> 0 AND abs(sqft) < 0.005;`
   `SELECT id FROM "UnitAreaChange" WHERE (previous <> 0 AND abs(previous) < 0.005) OR (current <> 0 AND abs(current) < 0.005);`
5. Lift the freeze. Rollback is only clean before any decimal write.

*Original (Phase 1) text, kept for history:*
- Drawn area is exact decimal (0.001 ft geometry). `Unit.sqft` stays **Int** for MVP:
  `sqft = round(width × height)` (half-up). Keeps psf, quotes, receipts, booking unchanged.
- The editor shows both: `7.5 × 6.3 ft = 47.25 sq ft → unit 47 sqft`.
- Open question Q1 if the owner wants decimal sqft (would need `Int → Decimal(10,2)` widening and
  every consumer re-checked — out of scope here).

### D4 — Size tier follows area (revised in Phase 2)
On sync, `sizeId` becomes the tier whose `sqftFrom..sqftTo` band is **nearest** to the new sqft
(distance 0 = inside; ties keep the current tier, then `sortOrder`) — `resolveSizeTier` in
`src/core/unitSizing.ts`. The publish review pre-selects it, flags it "nearest tier" when no band
covers the area, and lets the operator override it.
- **Why revised:** `prisma/seed.ts` seeds every tier as a single point (`sqftFrom = sqftTo`, e.g.
  Medium 60–60) and no CMS screen edits bands, so the original "no band → block" rule would have
  blocked every resize. `SIZE_OUT_OF_BAND` now only fires when no tiers exist at all.
- Follow-up worth doing: give tiers real ranges (or a CMS editor for them).
- **Lockers:** a stacked pair (stackTier 0/1) syncs both units to the same sqft; a resize whose
  nearest tier is not LOCKER is rejected on save (stacking is lockers-only).

### D5 — Rate policy on resize (operator choice at publish, default per unit status)
| Option | Effect | Default for |
| --- | --- | --- |
| **Keep $/sqft** | `newRate = round2(oldRate / oldSqft × newSqft)` | AVAILABLE, MAINTENANCE, BLOCKED |
| Keep rate | `monthlyRate` unchanged (psf changes) | — |
| Set rate | operator types the new rate | — |
Every rate change writes a `RateChange` row (`reason: "Floor plan resize <old>→<new> sqft"`,
`appliedBy` = CMS user). Uses the existing `adjustRate` transaction shape.

### D6 — Contracted units cannot change size
Area change is **rejected in any plan state** (draft or live) for units that are OCCUPIED,
OVERDUE, RESERVED, or have a `Booking` in `PENDING_PAYMENT`. *(Phase 1 finding: a linked
`Tenant` alone does **not** lock — the dev clone has 301 ACTIVE tenants still linked to
AVAILABLE units (seed / `db:free-units --keep-tenant-links`), and booking treats those units as
rentable, so `Unit.status` is the source of truth.)* Moves
and door edits on draft plans remain allowed (as today). Rationale: the customer contracted a
size and a price; changing either needs a separate commercial process. Error:
`409 UNIT_CONTRACTED — Unit 1042 is OCCUPIED; its size can't change while rented`.

### D7 — New units are real rows in a new `DRAFT` unit status
- Add `UnitStatus.DRAFT`. A unit drawn on the canvas is created **immediately** as a `Unit` row
  with `status = DRAFT` (so it has an id/code, can be placed, undone, stacked, arrayed, and
  appears in draft snapshots).
- `DRAFT` is excluded by every existing status filter (public browse uses `BROWSEABLE_STATUSES`,
  so it is invisible to booking automatically). Audit list below (§5.4) for the rest.
- **On publish:** `DRAFT → AVAILABLE` (or the status chosen in the new-unit form).
- **Discard:** removing a DRAFT unit from the plan **hard-deletes** it (no bookings/invoices can
  exist — guarded), clearing its placement first (`onDelete: Restrict`). Its 4-digit code is
  freed *(revised in Phase 3: it was never published, so nothing references it, and undo → redraw
  shouldn't burn codes; the never-reuse rule still protects codes with history)*.
- Code is minted at creation (needed for `unitCode @unique NOT NULL` and so the canvas can label
  it). Minting runs inside the creating transaction with a retry on unique violation.

## 4. Data model changes (one additive migration)

```prisma
enum UnitStatus { …existing…  DRAFT }      // ALTER TYPE ADD VALUE — no row uses it until new code ships

model UnitPlacement {
  …
  areaDirty   Boolean  @default(false)   // area changed since last publish → sync Unit.sqft on publish
}

model UnitAreaChange {                     // audit trail for size changes (mirrors RateChange)
  id          String   @id @default(cuid())
  unitId      String
  unit        Unit     @relation(fields: [unitId], references: [id])
  previous    Int      // sqft
  current     Int
  prevSizeId  String
  newSizeId   String
  widthFt     Float    // drawn rect at publish
  heightFt    Float
  source      String   // FLOOR_PLAN_PUBLISH | RECONCILE | MANUAL
  floorPlanId String?
  appliedBy   String
  createdAt   DateTime @default(now())
  @@index([unitId])
}
```
All additive; no backfill (`areaDirty` defaults false so existing rows never auto-sync).
Prod deploy caveat: adding an enum value is read-safe for the old Lambda **only while no row
holds `DRAFT`** — satisfied because only new code writes it. Order per runbook: migrate (direct
Neon URL) → Lambda code update, back-to-back.

## 5. Backend work

### 5.1 Geometry rule change (`floorPlans.ts`)
- Remove the 2 % `AREA_TOLERANCE` **rejection** for resizes of non-contracted units; instead set
  `areaDirty = true` when `rectAreaSqft(existing) ≠ rectAreaSqft(geom)` (milli-ft compare).
- Keep: canvas bounds, overlap, stacking, min side (`MIN_RECT_SIDE_FT`), occupied lock.
- Add: D6 contracted guard; D4 locker-band guard for stacked pairs; sanity cap
  (e.g. 1 – 2,000 sqft per unit, configurable constant).
- Apply identically in `setUnitPlacement` and `applyFloorPlanBatch` (both paths today duplicate
  the tolerance check — extract one `checkPlacementArea()` helper).

### 5.2 Unit creation from the plan
- `POST /cms/floor-plans/:floorId/units` — body: `{ x, y, width, height, stackTier?, doorEdges?,
  sizeId?, name?, hasAC?, hasPillar?, monthlyRate?, status? }`. One transaction: validate
  geometry (same rules), `createUnit({ …, status: 'DRAFT', sqft: round(w×h), sizeId: sizeId ??
  bandFor(sqft) })`, create placement (`areaDirty: false` — new units sync via status, not dirty).
- **Batch:** extend `POST /floor-plans/:floorId/batch` with `create.units[]` carrying a client
  `tempId`; response returns `{ tempId → { id, unitCode } }` so editor undo/redo, array and paste
  can create many units atomically. Shares `MAX_BATCH_ITEMS`.
- Default rate when not given: `round2(MARKET_PSF[tier] × sqft)` (or the tier's median live psf —
  Q3). Branch comes from the floor.
- `DELETE /floor-plans/:floorId/units/:unitId?discard=1` — hard-delete a DRAFT unit (rejects
  non-DRAFT; non-DRAFT keeps today's "remove placement only").

### 5.3 Publish = sync (`publishFloorPlan`, `floorPlanDrafts` publish)
Inside one `$transaction`:
1. Collect `areaDirty` placements + all `DRAFT` units on the floor.
2. Pre-flight: D6 contracted guard, D4 band resolution, locker pairs consistent. Any failure →
   `409 PUBLISH_BLOCKED` with a per-unit list (nothing written).
3. For each dirty unit: update `sqft`, `sizeId`, rate per D5 choice; write `UnitAreaChange` (+
   `RateChange` if rate changed); update `Tenant.psf` is N/A (contracted units can't be dirty).
4. `DRAFT` units → `AVAILABLE` (or chosen status).
5. Clear `areaDirty`; `DRAFT → ACTIVE` as today.
- New `GET /floor-plans/:floorId/publish-preview` returns the exact change list (old/new sqft,
  tier, rate, new units, blockers) the UI shows before confirming. Publish takes the reviewed
  per-unit choices `{ unitId, ratePolicy, rate?, sizeId? }[]` and re-validates (stale preview →
  409 so the operator re-reviews).
- **Draft snapshot publish:** after wholesale-replacing placements, mark `areaDirty` where the
  restored rect area ≠ current `Unit.sqft`-equivalent area; snapshot placements referencing a
  since-discarded DRAFT unit are skipped with a warning. Snapshot `sqft` is display-only.

### 5.4 DRAFT-status exclusion audit (must touch / verify each)
`listPublicUnits` (auto via `BROWSEABLE_STATUSES` — add test), `listUnits` CMS (hide by default,
`?includeDraft=1` for the designer), `getUnitMap`, `getUnitDetail`, `summary.ts` totals/occupancy,
`rates.getNetPsf`, `quotes.ts`, `leads.ts` unit matching, `floorPlanMetricsService` (count as
planned NLA, flagged), CSV export/import (import must not collide with burned codes — already
safe), booking create/checkout guards (reject DRAFT unit ids), customer portal, OpenAPI enums.

### 5.5 Units API alignment
- `PUT /cms/units/:code` `sqft` on placed unit → 409 (D1). `sizeId` changes for placed units also
  routed through the plan.
- `GET /cms/units/:code` gains `placement: { widthFt, heightFt, floorPlanStatus, areaDirty }` and
  `areaHistory` (last N `UnitAreaChange`).
- OpenAPI bump (1.10.0): new routes, `DRAFT` status, error codes `SIZE_OWNED_BY_PLAN`,
  `UNIT_CONTRACTED`, `SIZE_OUT_OF_BAND`, `PUBLISH_BLOCKED`.

## 6. CMS designer UX (`floorplanView.js`, `dashboard.html`, `state.js`)

**Resize feedback (live, while dragging handles or typing W/H in the inspector)**
- Readout chip next to the handle: `8.0 × 6.0 ft · 48 sqft (was 40) · SMALL → MEDIUM`.
- Inspector shows *Drawn area*, *Unit sqft (on publish)*, *Tier*, *Rate preview* (per D5 default).
- Contracted units: resize handles hidden, tooltip "Rented — size locked"; move still allowed in
  draft.
- 🔒 Lock-sqft stays as an **optional** constraint (off by default) for "move/reshape without
  changing size"; the true-size ghost for palette units remains.
- Dirty units get a small "Δ" badge; the save chip says "3 size changes pending publish".

**Create unit tool (new: `U` shortcut, toolbar "＋ Unit")**
- Drag a rectangle (snaps to grid/objects as other tools). On release → compact popover:
  tier (auto-suggested from area, editable), name (optional), AC, pillar, monthly rate (prefilled
  per §5.2, shows psf), status after publish. Enter = create.
- Quick variants: **Duplicate** (Ctrl/Cmd+D) and **Array** create *new* units of the same
  footprint/settings (today's Array only places existing unplaced units — add a "create new"
  toggle when the unplaced pool runs out).
- Locker stacking: "＋ Stack new locker" on a locker creates the upper tier as a new DRAFT unit.
- New units render with a dashed outline + "NEW" tag until published; delete = discard.
- Undo/redo: create/discard are batch ops with temp ids (§5.2) so undo of a create discards the
  DRAFT row server-side.

**Publish review dialog (replaces the bare publish confirm)**
- Table: unit · old→new sqft · old→new tier · rate policy (dropdown per row, bulk "apply to all")
  · new rate · psf. Section for new units. Blockers in red with "Show on plan" links.
- "Reconcile sizes" (Layers/⋯ menu) opens the same table for grandfathered mismatches with
  per-row *Update unit* / *Fit drawing*.

**Units page**: read-only sqft for placed units with "Open in floor plan" deep link; area history
tab next to rate history.

UI follows the existing designer's visual language (no redesign); run the `ui-ux-reviewer`
skill on the resize readout, create popover and publish review before shipping.

## 7. Edge cases checklist
- Non-rectangular units: not supported today (placements are rects) — unchanged.
- Pillars inside a unit (`hasPillar`, pillar blocks): sqft stays gross rect area for MVP; Q4
  whether to subtract pillar blocks overlapping the unit.
- Rotation (90°) never changes area → never dirty.
- Resize then resize back to original area before publish → clear `areaDirty` (compare against
  `Unit.sqft`-at-last-publish stored implicitly as area of last published rect; simplest: on
  publish, skip units where `round(area) === sqft` and only stamp history when it differs).
- Two operators editing the same floor: existing batch final-layout validation + publish-preview
  staleness token (plan `updatedAt`).
- Concurrent booking of an AVAILABLE unit between preview and publish → publish re-checks D6
  inside the transaction; that unit blocks.
- Inactive floor: creating units refused (mirrors `createUnit`).
- Unit soft-deleted while DRAFT can't happen (DRAFT discard = hard delete).

## 8. Testing
- **e2e (`tests/e2e/floor-plan-unit-sync.test.ts`)**: resize → dirty → publish updates sqft/tier/
  rate + history rows; keep-psf math; contracted guard (each status + pending booking); out-of-
  band blocker; locker pair sync + band guard; grandfathered rows untouched on publish;
  reconcile both directions; draft-snapshot publish marks dirty; create unit (single + batch with
  tempIds) → invisible to `/public/units` until publish → AVAILABLE after; discard hard-deletes
  and burns code; codegen race (parallel creates); Units PUT sqft 409 for placed units.
- **Unit**: `checkPlacementArea`, band resolver, rate policy rounding.
- **Existing suites**: floor-plan precision/underlay e2e, metrics fixtures, drift test, `tsc`.
- **Browser** (cloned DB, e.g. `storelah_fp_dev`, never the shared dev DB for migration trials):
  draw unit → popover → publish review → check Units page + booking list.

## 9. Cross-lane impact
- **Booking (optional, separate frontend-agent task):** expose additive
  `placement: { widthFt, heightFt }` on public units and use it in `unitDims()` instead of the
  derived factor pair, so customers see the real drawn L×W. No breaking change; sqft field
  unchanged. Must be coordinated after backend ships.
- **Landing:** none (static).
- **DevOps:** one migration + Lambda update; follow `backend-deploy.md` order. Note the precision
  migrations (§3a freeze procedure in `FLOOR_PLAN_PRECISION_PLAN.md`) must already be on prod
  first.

## 10. Phasing
| Phase | Scope | Deliverable / gate |
| --- | --- | --- |
| 0 | Owner answers Q1–Q6 | decisions logged |
| 1 ✅ | Migration `20261014000000_floor_plan_unit_sync` (DRAFT enum, `areaDirty`, `UnitAreaChange`); `src/core/unitSizing.ts` (`checkPlacementArea`, contracted guard, locker band) wired into `setUnitPlacement` + `applyFloorPlanBatch`; `areaDirty` in placement reads; minimal editor: sqft lock default OFF, contracted units force-locked, readout "unit 60 → 72 on publish" | `tests/e2e/floor-plan-unit-sync.test.ts` (16); precision tests re-pointed at contracted units. **Gap until Phase 2:** dirty sizes do not sync yet, and draft-snapshot publish does not mark dirty |
| 2 ✅ | `src/core/unitSizeSync.ts` (`buildSizeSyncPlan`, `applySizeSync` inside the publish transaction, token, `listSizeMismatches`); `publishFloorPlanWithSync` + `reconcileUnitSizes` (MARK_FOR_SYNC / FIT_DRAWING); draft-version publish flags restored size changes with a contracted preflight; routes `GET …/publish-preview`, `POST …/publish` + `/drafts/:id/publish` body `{ token, choices }`, `GET …/size-mismatches`, `POST …/reconcile`; Units `PUT` 409 `SIZE_OWNED_BY_PLAN`, detail `placement` / `sizeOwnedByPlan` / `areaHistory`; OpenAPI 1.10.0; **publish review dialog** (moved up from Phase 4) + Units form sqft lock | e2e 32 in unit-sync suite; browser-verified end to end on clone. Reconcile has API only (UI in Phase 4) |
| 3 ✅ | `POST /cms/floor-plans/:floorId/units` (`createUnitOnPlan`, single-item batch) + batch `create.units[]` with `tempId` → response `created` map; codes minted in the tx; default tier = nearest, rate = `defaultRateFor` (MARKET_PSF, lowest PSF fallback); removing a DRAFT unit's placement **discards** it (`discardDraftUnitTx`, refuses if tenant/booking/invoice/notice/work order/incident; code freed); resizing a DRAFT unit updates its Unit row immediately; DRAFT excluded from CMS units list, unit map, activity, summary, branch totals, net PSF, facility metrics, unplaced palette, public plan read (rent/quote paths already AVAILABLE-only; floor counts intentionally include drafts) | 9 new e2e (41 in suite); live HTTP smoke on :4100. Designer still renders DRAFT as available-green — dashed "NEW" styling is Phase 4 |
| 3b ✅ | **Decimal sqft** (owner, 2026-10-14): migration `20261014010000_unit_sqft_decimal`; `quantizeSqft` / `sameSqft` / decimal `sqftForRect`; Units create/edit/CSV import quantize; summary / branch / rates / metrics sums rounded; OpenAPI `sqft` → number; designer readouts + Units form step 0.01 | 109 e2e (107 pass, same 2 pre-existing); browser: 6.25×10 → "unit 60 → 62.5 on publish", review rate S$280.21, drawn 7.5×6.3 → 47.25 sqft |
| 4 ✅ | Designer (`floorplanView.js`, `dashboard.html`, `state.js`, `unitsView.js`): **＋ New Unit** tool (N; drag with object snap → ghost + live "W × H ft = A sqft · tier (nearest)" readout; overlap/too-small shown red) → form (tier pre-selected nearest, name, rate pre-filled MARKET_PSF × sqft with live $/sqft, AC, pillar; Enter/Esc) → batch `create.units`; **undo/redo** carries a `createSpec` and remaps minted ids, so undoing a discard re-creates the draft (typed rate kept while size unchanged); DRAFT tiles dashed + **NEW** tag, pending-size **Δ** tag; save chip "N new units, M size changes pending publish"; **Discard new unit** (inspector/Delete/multi) with undo; **Cmd/Ctrl+D** on a unit → new draft beside it; **Array** offers to create new drafts when unplaced units run out; **⧉ Stack new locker**; **⚖ Sizes** reconcile modal (Use drawing / Fit drawing); Units drawer Size tile shows drawn size, last change and history tooltip; shortcut sheet | Browser-verified (pane hidden → driven with dispatched pointer/keyboard events on the real handlers): draw 6×8 → form → 1001 Small S$230.40 AC; undo → server discard; redo → re-created (new id, same code); Delete → discard dialog → undo restores with typed rate; Cmd+D → 1002 flush right; Sizes: 2 mismatches → Use drawing (Δ) + Fit drawing; Array 2 → confirm → 1003/1004, one-step undo; clone restored. **ui-ux-reviewer pass still pending** (needs the browser pane visible for screenshots) |
| 5 | Docs (`FLOOR_PLAN_MODEL.md`, OpenAPI 1.10.0), decision log, prod rollout (authorized) | prod smoke |
| 6 | (Booking lane, optional) real dims from placement | vitest + visual check |

## 11. Open questions for the owner
- **Q1** Keep `Unit.sqft` integer (rounded drawn area) — or move to decimal sqft?
- **Q2** Default rate policy on resize: *keep $/sqft* (recommended) vs *keep rate*?
- **Q3** Default rate for a newly drawn unit: `MARKET_PSF[tier] × sqft`, or the floor/branch's
  current median psf for that tier?
- **Q4** Should pillar blocks overlapping a unit reduce its sqft?
- **Q5** Sync on publish (recommended) vs immediately on save?
- **Q6** Should RESERVED / pending-payment units also be size-locked (recommended yes), and may
  operators override with a reason?

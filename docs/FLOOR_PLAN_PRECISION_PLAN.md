# Floor Plan Designer — Precision & Pro-Editor Plan

Status: **Phase 1 implemented** on `feature/2-floorplan-precision` (2026-10-13,
not merged/deployed). Owner decisions 2026-10-13: display **decimal feet**,
default snap **0.1 ft**, area tolerance **2%** (applies from Phase 2 — see §3a).
Underlay, `Unit.sqft` and migration style were not answered; defaults below. Companion to
`docs/FLOOR_PLAN_MODEL.md` (current model) — this doc describes how to move from
the integer-foot grid to a decimal-precision, CAD-style designer.

---

## 1. Problem

Today the plan has **one coordinate system: 1 grid unit = 1 foot, integers only**.
Every layer enforces it:

| Layer | Where the integer-foot assumption lives |
| --- | --- |
| DB | `FloorPlan.width/height`, `UnitPlacement.x/y/width/height`, `FloorPlanBlock.x/y/width/height`, `FloorPlanMarker.x/y`, `FloorPlanDraft.width/height`, `UnitSize.widthFt/heightFt` are all `Int` (`prisma/schema.prisma`). Boundary `points` JSON is integer-validated. |
| API validation | `checkCanvasDim`, `checkGeometry`, `checkBoundaryPoints`, `checkMarkerPoint` in `src/core/floorPlans.ts` use `Number.isInteger`; draft snapshot parse in `src/core/floorPlanDrafts.ts` (L145–581) filters out non-integers. |
| Metrics bridge | `assertRect` in `src/core/floorPlanMetricsService.ts` throws `NON_RECTANGULAR` for any non-integer coordinate, even though the metrics core (`floorPlanMetrics.ts`) already works in an exact **0.1 mm integer base (3048 per ft) with a 1-inch snap** — the core is more precise than its inputs. |
| Editor | `src/cms/admin/floorplanView.js` (4,268 lines): `fpCanvasCellAt` (`Math.floor`), `fpCanvasPointAt` (`Math.round`), move/resize deltas `Math.round(px / u)`, `fpSnapToSqft` rounds W/H to whole feet, CSS background grid fixed at 1 ft, `sqftFootprint` mirrored in two places ("keep in sync"). |
| Footprints | `sqftFootprint` forces `w·h ≥ sqft` in whole feet, so a 30 sqft unit that is really 4.75 × 6.33 ft must be drawn as 5 × 6 (= 30) or the ±15% `AREA_TOLERANCE` is used to paper over the error. |

Consequences: units like 4.73 ft wide can't be drawn true to size; lines/borders
can only start/end on whole-foot points, so walls, columns and odd-angle
boundaries are approximations; the 15% area tolerance exists largely because
integer feet can't represent real dimensions; and floor metrics (NLA/UFA/
efficiency) inherit that error.

## 2. Goals / non-goals

**Goals**
1. Decimal-precision geometry everywhere (units, blocks, lines, markers, canvas) — at least 0.01 ft (≈3 mm), exact for feet, inches and millimetres.
2. A designer that feels professional: adaptive grid, selectable snap, rulers, numeric inspector, typed dimensions, smart guides, live measurements, multi-select, align/distribute, redo.
3. A real line tool: continuous polylines, typed length/angle, ortho/45° constraint, endpoint/midpoint snapping, vertex editing.
4. Zero breaking change for consumers: every existing integer plan stays valid and renders identically; the booking renderer keeps reading **feet**.
5. Tighter, honest area validation (drawn area ≈ real sqft within ~2%, not 15%).

**Non-goals (this plan)**
- Arbitrary-angle (non-90°) **units/blocks** — metrics and overlap rules assume axis-aligned rects. Lines/boundaries *may* be any angle.
- Multi-user real-time co-editing.
- Changing pricing logic. (`Unit.sqft` decimal is an optional, separately-approved phase — see §8.)

## 3. Core design decision — "feet at the edges, integers in the core"

### Recommendation
- **Canonical storage = integer base units, 1 base = 0.1 mm** (`BASE_PER_FOOT = 3048`, the constant already defined in `src/core/floorPlanMetrics.ts`).
  - Exact for: whole feet (3048), inches (254), ½"/¼" (127 / 63.5 → ¼" is *not* exact; ½" is), millimetres (10).
  - 0.01 ft = 30.48 base → rounds to 30 (error 0.005 mm — invisible).
  - Max canvas 500 ft = 1,524,000 base → fits `Int` (Int32); area math in JS numbers (≤ 2.3e12) or BigInt as the metrics core already does.
- **All geometry math (overlap, containment, snap, area, metrics) runs on integers.** No epsilon fudging; "touching edges" stay exact because the editor snaps b.x to exactly a.x + a.w in base units.
- **API contract stays in feet**, as JSON numbers with up to 4 decimals. Conversion at the boundary:
  `ftToBase(ft) = Math.round(ft * 3048)`, `baseToFt(b) = round4(b / 3048)`.
  Round-trip is idempotent at 4 dp (0.0001 ft = 0.305 base < 0.5), so ft→base→ft→base never drifts.
  Integer-foot payloads from old clients are accepted unchanged.

### Alternatives considered (rejected)
| Option | Why not |
| --- | --- |
| `Float` feet columns, compare in floats | `1.1 + 2.2 ≠ 3.3`: neighbours that touch get flagged as overlapping by 1 ulp; needs epsilons everywhere; drift on repeated edits. |
| `Decimal(10,4)` feet columns | Exact, readable, but Prisma returns `Decimal` objects that serialise as **strings** — every read path + booking would need conversion; still need integer math for snapping consistency. |
| Integer **inches** | Doesn't represent mm (architect drawings in Singapore are metric) or 0.01 ft. |
| Integer **mm** | 1 ft = 304.8 mm is not an integer → whole-foot plans would no longer be exact. |

### Schema change (one additive migration + column type change)
For each geometry column, migrate in place with a value transform, and rename
the Prisma field to make the unit explicit (map to a new DB column so no reader
silently misinterprets old data):

```
UnitPlacement:  x,y,width,height (Int ft)  →  xB,yB,widthB,heightB (Int, 0.1 mm)   = old * 3048
FloorPlanBlock: same
FloorPlanMarker: x,y → xB,yB
FloorPlan / FloorPlanDraft: width,height → widthB,heightB
UnitSize: widthFt,heightFt (Int?) → widthB,heightB (Int?)
FloorPlanBoundary.points JSON: [[x,y]] ft → [[xB,yB]] base (data migration in SQL: jsonb array map)
FloorPlanDraft.placements/blocks/boundaries/markers JSON: add top-level `geomUnit: "base"`;
   legacy drafts (no field) are read as integer feet and converted on load — no rewrite needed.
FloorPlan: + precisionFt Decimal? / snapStep (editor default per plan, optional)
```

Migration is mechanical (`UPDATE ... SET x_b = x * 3048`), reversible, and
keeps every existing plan pixel-identical. Order on prod (standing rule): **migrate
first (direct Neon URL, explicit authorization), then Lambda code update.**
Old Lambda code must not run against the new columns → do it in one maintenance
window, or do a two-step expand/contract (add new columns + dual-write release,
backfill, switch reads, drop old columns) if zero-downtime matters. Recommendation:
expand/contract — the CMS is operator-only, but the booking public read is live.

### 3a. REVISED after the owner chose decimal feet (supersedes the base-unit recommendation above)

With ft-in and mm off the table, a **decimal** base is exact for every value the
operator can enter, which makes in-place widening possible:

- **Storage = `Float` (double) decimal feet, quantized on write to 0.001 ft.**
  Same column names, so the booking app and the existing readers are unchanged. The
  migration is a lossless `ALTER COLUMN … TYPE DOUBLE PRECISION`.
- **Math = integer milli-feet** (`toMilli = round(ft × 1000)`) in
  `src/core/planGeometry.ts`. Exact for any 3-dp value, so touching edges never
  produce phantom overlaps, with no epsilons.
- The metrics core keeps its 0.1 mm base. Decimal feet convert via
  `feetToBase` (≤ 0.05 mm rounding), and `OFF_GRID` now also accepts the
  0.01-ft grid.
- `AREA_TOLERANCE` stayed **15% in Phase 1** (integer editor) and is **2% since
  Phase 2a**. It applies only to new or resized placements; moves and rotations
  that keep the stored area are grandfathered (otherwise every legacy unit
  drawn under 15% would fail on its next drag).

#### Phase 1 deploy procedure (must read before prod)
Verified locally (2026-10-13): the **currently deployed** Prisma client (`Int`
fields) reads the widened columns fine, but **its writes corrupt them**. An
`Int` param bound into a `double precision` column is reinterpreted bitwise
(`x: 3` was stored as `1.5e-323`). Only CMS floor-plan editor actions write
geometry (public/booking never does), so:
1. Announce a **floor-plan edit freeze** (no CMS floor-plan / draft edits) for the deploy.
2. `prisma migrate deploy` on Neon (direct URL; explicit owner authorization).
3. Immediately update the Lambda code (same session, back to back).
4. Corruption check (must return 0 rows):
   `SELECT id FROM "UnitPlacement" WHERE (x <> 0 AND abs(x) < 0.0005) OR (y <> 0 AND abs(y) < 0.0005) OR abs(width) < 0.0005 OR abs(height) < 0.0005;`
   Run the same check on `FloorPlanBlock`, `FloorPlanMarker` (x/y), `FloorPlan` and
   `FloorPlanDraft` (width/height).
5. Lift the freeze.
Rollback: the code can't simply be reverted once decimals have been written. Old
code truncates decimals on read. Roll back only before any decimal write, or
first round the geometry columns.

## 4. Shared geometry module (kill the "keep in sync" mirrors)

New pure module `src/core/geometry/` (no Prisma/Express), imported by the API and
bundled for the CMS admin:

- `units.ts` — `ftToBase`, `baseToFt`, `parseLength("4' 8 3/4\"" | "4.73" | "4.73ft" | "1440mm" | "1.44m" | "56in")`, `formatLength(base, pref)` for **ft-decimal / ft-in / mm / m** display.
- `rect.ts` — `rectsOverlap` (interior-only, integer), `rectInPolygon`, `rectStraddlesPolygon`, area.
- `footprint.ts` — single `sqftFootprint()` that returns decimal W×H with `w·h = sqft` exactly (to the snap step) instead of `ceil`.
- `snap.ts` — snap engine (grid step + object snaps, see §5.3).
- `polygon.ts` — shoelace, point-in-polygon, segment intersection (moved from `floorplanView.js` L2234–2301).

The CMS admin is plain ES modules today; add a tiny build step (esbuild, one
command in `package.json`) that emits `src/cms/admin/vendor/geometry.js` from the
TS module, so the server and editor run **the same code**. Unit-test it once.

## 5. Editor redesign (CMS)

### 5.1 Rendering: DOM divs → SVG
`fpRenderCanvas()` wipes `canvas.innerHTML` and rebuilds every element on every
pointermove. Replace with one `<svg>` whose `viewBox` is in **feet** (decimals are
native, zoom is crisp at any level, hit-testing via `getScreenCTM()`), keyed
element updates (only the dragged node changes during a drag), and layers:
`underlay → grid → boundaries/walls → blocks → units → markers → dimensions/guides → handles`.
The booking renderer (`UnitFloorPlan.tsx`) is already SVG, so this also converges
the two visual models.

### 5.2 Grid, rulers, coordinates
- **Adaptive grid**: major/minor lines chosen by zoom (e.g. 10 ft / 1 ft when zoomed out → 1 ft / 0.1 ft or 1 ft / 1 in when zoomed in), drawn as SVG `<pattern>`; grid toggle kept.
- **Rulers** on top/left with the cursor position tick; origin at canvas top-left.
- **Status bar**: cursor X/Y, selection W×H and area (2 dp), snap mode, zoom %.
- **Display units** preference (per operator, `localStorage`): ft (decimal) · ft-in · mm · m. Storage is unaffected.

### 5.3 Snapping
- **Snap step selector**: 1 ft · ½ ft · ¼ ft · 0.1 ft · 1 in · 100 mm · 10 mm · off. Default 0.1 ft (or 1 in).
- **Object snaps** (toggle chips): grid, element edges, centres, line endpoints, midpoints, intersections, canvas edges. Priority: endpoint > intersection > edge > midpoint > grid. Snap radius in **screen px** (~8 px) so it feels the same at every zoom.
- **Smart guides**: magenta alignment lines when an edge/centre aligns with a neighbour; live gap readouts ("0.50 ft") between the dragged item and nearest neighbours.
- Modifiers: hold **Alt** = temporarily disable snapping; **Shift** = constrain (axis lock on move, 0/45/90° on lines, keep aspect on resize).

### 5.4 Numeric inspector (selection panel)
Replace the info strip (`fpRenderSelInfo`) with editable fields:
**X · Y · W · H · Area (read-only, vs. unit sqft with ✓/⚠ deviation %)**, rotation 0/90.
Fields accept any length syntax from `parseLength` plus simple arithmetic
(`4.73*2`, `12'-6"`), Enter commits, Esc reverts, ↑/↓ steps by the snap step.
For lines: per-vertex X/Y list, segment length and angle.

### 5.5 Units: true-size placement
- "Lock to sqft" resize becomes exact: drag width → height = sqft / width, rounded to the snap step; inspector shows the residual (e.g. "29.98 / 30 sqft").
- Palette drop uses the decimal footprint from the unit's size dims.
- `AREA_TOLERANCE` tightened from 15% → **2%** for *new/edited* placements once decimals ship (grandfathered rows still read fine, same rule as today). Make it a constant, revisit after operator feedback.

### 5.6 Line / boundary tool (the "pro" pen)
Current: one drag = one 2-point segment snapped to whole feet.
New behaviour:
- **Click–click polyline**: each click adds a vertex; rubber-band preview with live **length + angle** label; **double-click / Enter** finishes open; **click the first vertex** (or `C`) closes the loop; Backspace removes the last vertex; Esc cancels.
- **Typed input while drawing**: start typing a number → length field appears ("12.5" Enter places the next vertex 12.5 ft along the current direction); Tab switches to angle.
- **Constraint**: Shift = 0/45/90°; ortho mode toggle for wall tracing.
- **Snaps** to endpoints/midpoints of other lines, unit/block corners and edges.
- **Vertex editing** on a selected line: drag vertices, drag a segment midpoint to insert a vertex, Del on a vertex removes it, inspector edits coordinates numerically.
- **Line kinds** (field already exists: `kind`): `BOUNDARY` (metrics), `WALL` (with `thicknessB`, rendered as a band — feeds the metrics core's wall-thickness logic), `PARTITION`, `GUIDE` (non-printing construction line). Kind stays a plain string — additive.
- **Measure tool** (`M`): click two points → temporary dimension, not persisted.
- **Dimension annotations** (optional, persisted as a new lightweight kind `DIMENSION`) for printed plans.

### 5.7 Productivity
- **Multi-select**: marquee drag on empty canvas, Shift-click add/remove; move/nudge/delete as a group.
- **Keyboard**: arrows nudge by snap step, Shift+arrows ×10; `Cmd/Ctrl+D` duplicate; `Cmd+C/V` copy/paste (offset by one snap step); `Cmd+Z` / `Cmd+Shift+Z` **undo/redo**; `V` select, `L` line, `M` measure, `R` rotate 90°, `G` grid, `0` zoom-to-fit; `?` shortcut sheet.
- **Align / distribute** (left/centre/right/top/middle/bottom, equal gaps).
- **Array / repeat**: "create N copies along X with gap G" — the fastest way to lay out a locker row; combined with auto-assign of unplaced units in code order.
- **Layers panel**: show/hide/lock per layer (underlay, lines, blocks, units, markers).
- **Locked occupied units** keep today's rules (`fpIsOccupiedLocked`).

### 5.8 Save model
Today every drag fires its own API call per element (`fpPersist`, `fpPersistBlock`, …) and undo replays server mutations. For multi-select, arrays and redo, move to a **client document + command stack**:
- Commands (`Move`, `Resize`, `AddVertex`, …) mutate the local document and are undoable/redoable instantly.
- A debounced **batch save** (`PUT /floor-plans/:floorId/canvas` — extend the existing `fpSaveCanvas` path, transactional, validates the whole document server-side, returns per-element errors) with a visible "Saved · Saving… · Unsaved (n)" indicator and `beforeunload` guard.
- Keep per-element endpoints for old clients; the editor stops using them.
- Optimistic concurrency: send `updatedAt`/revision; 409 on conflict → reload prompt.

### 5.9 Underlay & calibration (biggest accuracy win)
- Upload the architect's floor plan (PDF page / PNG / JPG) per floor via existing `src/lib/contentStorage.ts` (S3).
- **Calibrate**: click two points on the image, type the real distance ("12,500 mm") → scale + offset stored on the plan (`underlay` JSON: `{ assetKey, scale, offsetXB, offsetYB, rotation, opacity }`).
- Trace walls/boundaries/units over it with snapping; opacity slider; lock.
- CMS-only — never exposed by the public read.

### 5.10 Output
- Export PDF / SVG / PNG at a chosen scale (1:100, 1:200) with title block, scale bar, north arrow, legend, unit codes + sqft.
- Print-ready view for the operations team.

### 5.11 Code structure
Split `floorplanView.js` (4,268 lines) into `src/cms/admin/floorplan/`:
`doc.js` (document + commands + undo), `render-svg.js`, `tools/{select,line,measure,marker,block}.js`,
`snap-ui.js`, `inspector.js`, `persist.js`, plus the bundled shared geometry.
Do this split **first** in Phase 2 (pure move, no behaviour change) so later diffs are reviewable.

## 6. Backend changes summary

| Area | Change |
| --- | --- |
| `prisma/schema.prisma` + migration(s) | Base-unit columns per §3 (expand/contract). |
| `src/core/floorPlans.ts` | Replace `Number.isInteger` checks with `Number.isFinite` + `ftToBase`; bounds/overlap/stacking in base ints; `sqftFootprint` from shared module; area tolerance constant 2%; error messages print formatted decimals. |
| `src/core/floorPlanDrafts.ts` | `geomUnit` on snapshots; legacy integer-ft drafts converted on read; no rewrite of history. |
| `src/core/floorPlanMetricsService.ts` | `assertRect` accepts any finite non-negative value; bridge passes base units straight to the core (drop the ft→base round-trip). Decide whether the 1-inch snap in `floorPlanMetrics.ts` stays (recommended: keep core exact at 0.1 mm; inch snap only as an editor option). |
| `src/routes/cms.ts`, `src/lib/openapi.ts` | Document decimal feet (≤4 dp) on all geometry fields; batch canvas PUT; underlay endpoints. |
| `getPublicFloorPlan` | Keeps the same shape, values in **feet** (now possibly decimal). |
| Tests | Geometry unit tests (parse/format, round-trip idempotency, touching-edge exactness, overlap with decimals, footprint exactness); migration test (integer plan before == after); API validation tests; metrics regression fixtures (`floorPlanMetrics.fixtures.ts`) re-run on decimal inputs; e2e (`tests/e2e/*`) unchanged results for integer plans. |

## 7. Cross-lane impact (call-out before any edit)

- **Booking (`storelah-booking/web`)** — reads `/api/v1/public/floor-plans/:branchCode/:level` via `src/lib/floor-plan.ts`, `use-floor-plan-boundaries.ts`, `UnitFloorPlan.tsx`. Values become decimal feet. SVG handles that natively, but the frontend lane must verify: label fitting on small rects, any integer cell math (e.g. "CELL 34 ft-px" scaling), test fixtures, pinch-zoom bounds. **No contract shape change**, only value precision. Needs a frontend-agent verification pass before backend deploys.
- **Landing** — unaffected (no live floor-plan data, per standing rule).
- **Devops** — prod migration (authorised separately) then Lambda update; S3 bucket/prefix for underlays reuses content storage.

## 8. Optional: decimal `Unit.sqft`
`Unit.sqft` is `Int`. If units are sold as e.g. 29.6 sqft, true-size drawing still
shows an integer target. Making it `Decimal(8,2)` touches pricing displays, PSF,
quotes/PDFs, imports, booking UI, metrics. **Separate decision** — recommend
deferring until the geometry work ships, then deriving `sqft` from the drawn
rect as an *optional* "measured sqft" field (`measuredSqft`) rather than changing
the billed `sqft`.

## 9. Phased delivery

| Phase | Scope | Lanes | Exit criteria |
| --- | --- | --- | --- |
| **0. Decisions** (½ day) | Confirm: base unit (0.1 mm), API in ft ≤4 dp, default snap step, display units, area tolerance 2%, expand/contract migration, `Unit.sqft` deferred. | owner | Signed-off answers to §11. |
| **1. Precision core** ✅ implemented (see §3a) | `planGeometry.ts` + 12 tests; in-place Int→Float migration; validation/routes/drafts/metrics accept + quantize decimals; OpenAPI 1.9.2; editor read guards tolerate decimals (editor input still integer → behaviour unchanged). | backend | All existing tests green; integer plans byte-identical in public read; new decimal API tests pass. |
| **2a. Decimal editing** ✅ implemented (2026-10-13) | Shared `planGeometry` bundled to the editor (`pnpm build:admin-geometry`, drift-tested); snap-step selector (1 / 0.5 / 0.25 / **0.1** / 0.05 / 0.01 ft, remembered per browser) + Alt = 0.01 ft, Shift = axis lock / 0–45–90° lines; numeric inspector X/Y/W/H (+ simple arithmetic, ↑/↓ steps) with live area deviation; arrow-key nudge (Shift ×10, one save per burst); adaptive grid (10-ft majors, snap-step minors when ≥ 6 px); live readout; decimal canvas dims; exact lock-to-sqft; decimal footprints; edge-candidate auto-place; integer-exact client overlap; 2% tolerance with grandfathering. | backend (CMS) | ✅ Verified in browser on a cloned dev DB: 4.73 × 6.342 ft unit by typing (29.998 sqft), flush neighbour at 10.93 accepted / 10.92 rejected, nudge 5.9 → 6.2, Shift line snapped horizontal, Alt line at 0.01 ft. |
| **2b. Editor structure** | Split `floorplanView.js` into modules; SVG renderer; rulers. Deferred until the uncommitted lead-dedup edits to `floorplanView.js` land (avoids a large merge conflict). | backend (CMS) | No visual regression on existing plans (screenshot diff). |
| **3. Pro line tool** ✅ implemented (2026-10-13) | Click-click pen (rubber band, live length/angle, double-click / Enter finishes, first-vertex / C closes, Backspace, Esc; press-drag = one segment); typed length + Tab angle (CAD 0° = east, 90° = north) with canvas-edge clamp warning; Shift 0/45/90°; object snaps (endpoint > corner > midpoint > edge, ~10 px, ⌖ toggle); vertex handles (drag, midpoint-insert, click → X/Y inspector, Delete); line kinds BOUNDARY / WALL (+ `thickness`, migration `20261013010000_floor_plan_line_thickness`) / PARTITION / GUIDE — only BOUNDARY (+ legacy PENCIL) mark area, GUIDE hidden from the public read; 📏 measure tool (M); L toggles the line tool. Also fixed: a closed loop's closing edge was not clickable. | backend (CMS) | ✅ Browser-verified on the cloned dev DB: 30 × 25.5 ft loop typed from dimensions = 765 sqft (server + editor agree); 45° shape matched shoelace; midpoint insert + typed vertex Y = 840 sqft (765 + 75 triangle); WALL kind drops out of UFA; measure snapped unit corners (Δx 10.73, Δy 10). |
| **4. Productivity** ✅ implemented (2026-10-13) | Transactional `POST /floor-plans/:floorId/batch` (final-layout validation, atomic); generic undo + **redo** (100 steps, legacy entries converted, Cmd/Ctrl+Shift+Z / Y); multi-select (Shift-click, marquee, Cmd/Ctrl+A) with group drag / arrow nudge (one save per burst) / Delete; align ×6 + distribute ×2; copy / paste / duplicate for blocks, markers, lines (units are inventory — use Array); ⇶ Array (next N unplaced same-size units in a row, or N block copies); Layers (show / lock, remembered per browser); ⌨ / ? shortcut sheet; save-status chip + beforeunload guard. Deferred: cross-operator concurrency control (element writes don't bump a plan revision; single-operator CMS today). | backend (CMS) | ✅ Browser-verified on the cloned dev DB: array of 10 SMALL units placed flush in one batch (~1.8 s incl. waits); 50 edits → 50 undo → 50 redo exact (150 saves, 6.8 s); group nudge = 1 save, undo/redo keep the selection; align top / distribute (0, 15, 30); Cmd+A 16 → Delete → one undo restores all; layer lock blocks clicks, hide removes render. |
| **5. Underlay + export** ✅ implemented (2026-10-13) | **Underlay** stored in Postgres (`FloorPlanUnderlay`, migration `20261013020000_floor_plan_underlay`, ≤ 3.5 MB, magic-byte sniffed) — NOT the public content bucket (facility layouts must stay behind the CMS login); served as JSON base64 by an authed route; never in the public read or drafts. 🗺 panel: upload PNG/JPEG/WebP or PDF (page 1 rasterised by pdf.js, lazy-loaded from cdnjs), auto-downsize ≤ 4000 px; 📐 two-point calibration (`calibrateUnderlay` in planGeometry, point A stays fixed); ✥ move; ↻ 90° / free rotation; X/Y; opacity; show / lock. **Export** ⤓: PDF (jsPDF, page = exact sheet mm), PNG (200 dpi), SVG (vector, mm); Fit A1–A4 picks the largest standard scale that fits, or fixed 1:50 / 1:100 / 1:200 / 1:500; title block, scale bar, north arrow (plan up), legend; guides never print; optional grid / underlay. Also fixed: the global `express.json()` 100 KB limit pre-empted route body limits — the underlay route's 6 MB limit is mounted before it (content-image route has the same pre-existing bug — flagged as a separate task). | backend (+devops: nothing — no S3/IAM change) | ✅ Browser-verified: synthetic 2000×1500 drawing calibrated on its 75 ft wall → independent 30 ft dimension = 30.000 ft (0.000% error, ≤ 0.1% required); A3 PDF via pdf.js → 4000×2829 px underlay; PDF export MediaBox 841.89 × 1190.55 pt = exactly 297 × 420 mm at 1:100; fixed-1:100 SVG = 237.36 × 297.84 mm (= 70 × 80 ft / 100 + margins); PNG fit-A4 1:125 = 1654 × 2339 px. PDF raster (not vector) — vector PDF via svg2pdf is a possible follow-up. |
| **6. Booking verification** ✅ implemented (2026-10-13) | Booking (`storelah-booking`, branch `feature/4-floorplan-decimal-kinds` from `main`): `parseBoundaries` carries `kind` + WALL `thickness` and drops GUIDE defensively; `boundaryOutline` uses area lines only (`isAreaBoundary`) so a closed WALL loop never becomes the floor and an interior PARTITION no longer breaks the chained perimeter; `BoundaryShape` draws WALL at `thickness × CELL` (scales with zoom, ≥ 3 px) and PARTITION 1.5 px dashed, same reference tone. Decimal geometry needed no change (continuous px pipeline). **No "contract" step**: Phase 1 widened columns in place, so there are no old columns to drop. | frontend | ✅ Booking typecheck + build clean; vitest 808 pass / 29 fail = the identical pre-existing set on `main` (4 new tests); live check against the precision backend on the cloned DB: BM-01-01 (6.2, 1, 4.73 × 6.342) drawn at its exact centre (8.565, 4.171 ft), 0.75 ft wall = 25.5 px, partition dashed, floor outline from the BOUNDARY loop, GUIDE absent, no underlay in the public payload. **Deviation from the v13 reference** (owner to confirm): walls now render at real thickness instead of the uniform 3 px edge. |

Estimates are engineering days for one developer/agent; phases 2–4 are the bulk.
Each phase is its own `feature/<n>-floorplan-…` branch from `develop`.

### Booking follow-ups found in Phase 3 (Phase 6 scope, frontend lane)
- `boundaryOutline()` in `storelah-booking/web/src/lib/floor-plan.ts` takes the
  first closed loop of ANY kind as the facility outline — it should prefer
  BOUNDARY / PENCIL loops so a closed WALL loop never becomes the outline.
- Booking draws every line at one stroke width; WALL lines could use
  `thickness` (ft × scale), PARTITION a thinner dash. GUIDE lines never reach
  booking (filtered server-side).

## 10. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Prod migration on live booking read | Expand/contract; dual-write release first; migrate → Lambda order; explicit owner authorization each time. |
| Float drift / phantom overlaps | Integer base everywhere internally; 4-dp round-trip invariant tested. |
| 4k-line editor refactor regressions | Pure-move split first; screenshot diff of existing plans per phase; keep per-element endpoints until batch save is proven. |
| Tighter area tolerance blocks operators | Only on new/edited placements; inspector shows exact deviation + one-click "fit to sqft". |
| Booking label/scale assumptions | Frontend lane verification phase before contract step. |
| Uncommitted lead-dedup work in backend (incl. 55 lines in `floorplanView.js`) | Land/commit that first; start floor-plan branches from a clean `develop`. |

## 11. Open questions for the owner

1. Display unit default: **decimal feet** (4.73 ft) or **ft-in** (4' 8¾")? Should mm be offered (architect drawings)?
2. Default snap step: 0.1 ft or 1 inch?
3. Accept the 2% area tolerance (vs today's 15%)?
4. Is underlay calibration (Phase 5) wanted now, or later?
5. Should `Unit.sqft` stay integer (recommended), with an optional `measuredSqft` from the drawing?
6. Zero-downtime expand/contract migration, or a short maintenance window?

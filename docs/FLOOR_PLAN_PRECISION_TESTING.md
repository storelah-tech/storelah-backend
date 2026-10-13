# Floor Plan Precision — How to Test

Companion to `docs/FLOOR_PLAN_PRECISION_PLAN.md`. Covers the automated
suites, a safe local setup, a manual walkthrough per feature with the
expected results (the values below were verified on 2026-10-13), and the
post-deploy smoke test.

| Repo | Branch | Local worktree |
| --- | --- | --- |
| backend | `feature/2-floorplan-precision` (pushed, Phases 1–5) | `storelah-backend/_worktrees/fp-precision` |
| booking | `feature/4-floorplan-decimal-kinds` (Phase 6, not yet committed) | `storelah-booking/_worktrees/fp-decimal` |

---

## 1. Automated tests

### Backend (in the backend worktree)

```bash
pnpm check
```

```bash
pnpm metrics:fixtures
```

```bash
DATABASE_URL_TEST='postgresql://storelah:storelah@localhost:5433/storelah_fp_test?schema=public' pnpm test:e2e
```

Expected: typecheck clean · fixtures `failures=0` · e2e **60 pass / 2 fail**.
The 2 failures (`portal/bookings without token…`, `register → login → authed
booking…`) also fail on `main` — they are pre-existing, not precision bugs.

Precision-only suites (29 tests):

```bash
DATABASE_URL_TEST='postgresql://storelah:storelah@localhost:5433/storelah_fp_test?schema=public' pnpm vitest run tests/e2e/floor-plan-precision.test.ts tests/e2e/floor-plan-underlay.test.ts
```

They cover: 0.001 ft quantisation, exact touching edges (1.1 + 2.2 = 3.3),
canvas-edge fit, 2% area tolerance with move/rotate grandfathering, decimal
footprints, line kinds + wall thickness, GUIDE hidden from the public read,
drafts, the batch endpoint (row shift, atomic rejection, id-stable restore,
occupied lock), underlay upload over HTTP (> 100 KB body), public-read
exclusion, calibration maths (≤ 0.1% error), and that the editor's bundled
`src/cms/admin/planGeometry.js` matches `src/core/planGeometry.ts`.

If you change `src/core/planGeometry.ts`, regenerate the browser copy first:

```bash
pnpm build:admin-geometry
```

### Booking (in `storelah-booking/_worktrees/fp-decimal/web`)

```bash
pnpm typecheck
```

```bash
pnpm vitest run src/components/booking/__tests__/floor-plan-precision.test.tsx src/lib/__tests__/floor-plan-boundaries.test.ts src/components/booking/__tests__/floor-plan-boundaries.test.tsx src/components/booking/__tests__/floor-plan-reference.test.tsx
```

Expected: 21 pass. The full `pnpm test` run is **808 pass / 29 fail** — the
29 are the identical pre-existing set on booking `main` (none are floor-plan
tests).

---

## 2. Local setup for manual testing

> **Never apply the precision migrations to the shared dev DB (`storelah`)**
> while the main backend checkout runs older code: the old Prisma client
> silently corrupts writes to the widened columns (`x: 3` is stored as
> `1.5e-323`). Use a clone.

1. Clone the dev DB:

```bash
docker exec storelah-db psql -U storelah -d postgres -c 'CREATE DATABASE storelah_fp_dev'
```

```bash
docker exec storelah-db sh -c "pg_dump -U storelah -d storelah --no-owner | psql -q -U storelah -d storelah_fp_dev"
```

2. Apply the three precision migrations to the clone (backend worktree):

```bash
DATABASE_URL='postgresql://storelah:storelah@localhost:5433/storelah_fp_dev?schema=public' pnpm prisma migrate deploy
```

3. Start the backend on :4100 against the clone:

```bash
PORT=4100 DATABASE_URL='postgresql://storelah:storelah@localhost:5433/storelah_fp_dev?schema=public' pnpm dev
```

4. Optional — booking on :3101 against it (booking worktree `web/`):

```bash
NEXT_PUBLIC_API_URL=http://localhost:4100 NEXT_PUBLIC_API_PREFIX=/api/v1/public pnpm dev --port 3101
```

Open `http://localhost:4100/admin` → Facilities Management → **Floor Plan
Designer** (hard-refresh after pulling new code). Only floors marked active
appear in the floor picker.

---

## 3. Manual walkthrough (CMS designer)

Each step lists what to do and what you should see.

### Phase 1–2 · Decimal editing

| # | Do | Expect |
| --- | --- | --- |
| 1 | Toolbar **Snap** shows `0.1 ft` by default. Drag a unit from the palette onto the canvas. | It lands on a 0.1 ft position (e.g. `5.9, 1`); toast shows decimals. |
| 2 | Select it; in the strip type **W = 4.73**, Enter (🔒 sqft on, unit 30 sqft). | H becomes **6.342**; area note `30 sqft · -0.01%`. DB row: `4.73 × 6.342`. |
| 3 | Press → three times. | X moves 0.1 ft per press; **one** save at the end (toast `Nudged …`). |
| 4 | Place a second unit; type **X = 6.2+4.73** (where the first ends). | Accepted and flush — touching edges are not overlaps. |
| 5 | Type **X = 10.92** (0.01 ft into the first unit). | Rejected: `overlaps …`. |
| 6 | Turn 🔒 sqft off; resize a unit to > 2% off its sqft. | Area note turns terra; save rejected (2% rule). Moving / rotating an old unit drawn under the 15% rule still works. |
| 7 | Hold **Alt** while dragging. | Snaps to 0.01 ft. **Shift** locks to one axis. |
| 8 | Zoom to 300%. | Faint 0.1 ft minor grid appears; darker lines every 10 ft. |
| 9 | Canvas size **70.5 × 80.25**, Save Canvas. | Accepted (decimals allowed). |

### Phase 3 · Line tool

| # | Do | Expect |
| --- | --- | --- |
| 1 | **✎ Draw** (or `L`), kind **Boundary**. Click at (20, 20). Type `30` Enter, `25.5` Tab `270` Enter, `30` Tab `180` Enter, press `C`. | Closed loop; badge **Marked 765 sqft · UFA 765**. Same figure on the server (`GET /cms/floor-plans/:id` → `boundaryMetrics`). |
| 2 | Draw a shape with a 45° edge from typed lengths. | Area matches a hand shoelace calculation. A segment that would cross the canvas edge stops at the edge with a warning. |
| 3 | Hover near another line's end / a unit corner while drawing. | Orange snap marker (□ endpoint/corner, △ midpoint, × edge); readout says `snap endpoint`. ⌖ Snap toggles it off. |
| 4 | Select the 765 loop; drag the **■** on the top edge upward; click the new **●** and type **Y = 15**. | Area becomes **840 sqft** (765 + 30 × 5 / 2). **Delete** removes that vertex → 765 again. |
| 5 | In the line inspector change kind to **Wall**, T = `0.75`. | Loop drops out of UFA; drawn as a thick band. Back to Boundary → area returns. |
| 6 | **📏 Measure** (`M`): click two unit corners. | Readout shows length, angle, Δx, Δy (e.g. `Δx 10.73 · Δy 10`). Esc clears, Esc again leaves the tool. |
| 7 | Draw a **Guide** line. | Dotted blue; never in the public read or exports. |
| 8 | While drawing: Backspace / Esc / press-and-drag. | Removes last vertex / cancels / draws one straight segment. |

### Phase 4 · Productivity

| # | Do | Expect |
| --- | --- | --- |
| 1 | Select a placed unit → **⇶ Array** → 10, → right, gap 0 → Place. | 10 unplaced units of the same size placed flush in **one** save; all 11 left selected. |
| 2 | With the group selected press ↓ three times, then Cmd/Ctrl+Z, then Cmd/Ctrl+Shift+Z. | One save for the burst; undo restores, redo re-applies; selection kept. |
| 3 | Make 50 edits, then 50 undos, then 50 redos. | Lands exactly back on the start, then the end (up to 100 steps). |
| 4 | Shift-click two units → **⤒ Align top**; select 3 blocks → **⋯ Distribute**. | Tops aligned; equal gaps (e.g. blocks at x = 0, 15, 30). |
| 5 | Drag on empty canvas (marquee); Cmd/Ctrl+A; Delete → confirm; Cmd/Ctrl+Z. | Box-selects; select-all; one undo restores units and blocks. |
| 6 | Select a block: Cmd/Ctrl+D, Cmd/Ctrl+C then V twice. | Copies appear offset 1 ft, 2 ft… Units can't be copied (toast points to Array). |
| 7 | **☰ Layers**: lock Units; hide Units. | Locked = clicks ignored; hidden = not drawn. Remembered per browser. |
| 8 | Press `?`. | Shortcut sheet; Esc closes. |
| 9 | Watch the strip while saving. | `Saving…` → `✓ Saved hh:mm` (or `⚠ Last save failed`). Leaving mid-save warns. |

### Phase 5 · Underlay + export

| # | Do | Expect |
| --- | --- | --- |
| 1 | **🗺 Underlay** → Upload a PNG/JPEG/WebP or a **PDF**. | Image appears at 50% opacity, scaled to the canvas width. PDF page 1 is rasterised in the browser (up to 4000 px). |
| 2 | **📐 Calibrate**: click both ends of a dimension you know on the drawing; type its real length; Enter. | Image rescales; the first point stays put. **📏 Measure** a *second* known dimension: within 0.1% (verified: 30.000 ft on a 30 ft wall). |
| 3 | **✥ Move**, ↻ 90°, X/Y, opacity slider, show / lock. | Each applies and persists; lock disables Calibrate / Move. |
| 4 | Log out, or call `GET /api/v1/cms/floor-plans/:id/underlay/image` without a token. | 401. The public read (`/api/v1/public/floor-plans/BM/1`) contains no `underlay`. |
| 5 | **⤓ Export** → PDF, **Fit A3**. | Downloads `…-1to100.pdf`; page is exactly **297 × 420 mm**; print at **100% / Actual size** and measure the scale bar with a ruler: at 1:100 every 10 ft is 30.48 mm (a 70 ft-wide plan gets a 20 ft bar = 60.96 mm). |
| 6 | Export SVG at **1:100**; PNG at **Fit A4**. | SVG sheet = canvas ft × 304.8 / 100 + margins (70 × 80 ft → 237.36 × 297.84 mm). PNG 200 dpi (A4 → 1654 × 2339 px). |
| 7 | Check any export. | Title block (branch, level, date, UFA/NLA), scale bar, north arrow, legend; guide lines absent. |

### Phase 6 · Booking (`http://localhost:3101`)

Publish the plan in the CMS first (the public read only serves ACTIVE plans).

| # | Do | Expect |
| --- | --- | --- |
| 1 | Pick a size → Continue → **Floor plan** view. | Decimal units at exact positions (e.g. BM-01-01 centred at 8.565, 4.171 ft); neighbours flush. |
| 2 | Look at walls / partitions. | WALL drawn at real thickness (0.75 ft → 25.5 px at 100%), PARTITION thin dashed, no GUIDE lines. |
| 3 | A plan with a closed wall loop and interior partitions. | The cream floor fill follows the **Boundary** outline only. |

Quick API check:

```bash
curl -s http://localhost:4100/api/v1/public/floor-plans/BM/1 | python3 -m json.tool | grep -E '"kind"|"thickness"|underlay'
```

Expect `BOUNDARY` / `PENCIL` / `WALL` / `PARTITION` kinds (never `GUIDE`), a
`thickness` on walls, and no `underlay`.

---

## 4. Production rollout check (after deploy)

Run in order. Each prod migration needs explicit owner authorization.

1. **Freeze floor-plan edits** in the CMS (decimal-feet migration only).
2. `prisma migrate deploy` on Neon with the direct URL (applies
   `20261013000000_floor_plan_decimal_feet`, `…010000_floor_plan_line_thickness`,
   `…020000_floor_plan_underlay`).
3. Immediately update the Lambda code.
4. **Corruption check — must return 0 rows**:

```sql
SELECT id FROM "UnitPlacement" WHERE (x <> 0 AND abs(x) < 0.0005) OR (y <> 0 AND abs(y) < 0.0005) OR abs(width) < 0.0005 OR abs(height) < 0.0005;
```

   Repeat for `FloorPlanBlock` (x, y, width, height), `FloorPlanMarker` (x, y),
   `FloorPlan` and `FloorPlanDraft` (width, height).
5. Lift the freeze. Smoke test: open a live floor in the CMS, move one unit
   by 0.1 ft and back, check `/api/v1/public/floor-plans/<branch>/<level>`
   still returns the plan, then deploy booking and open its floor-plan view.

Rollback: before any decimal value is written, revert the Lambda to the prior
version. After decimals exist, old code would truncate them on read — round
the geometry columns first.

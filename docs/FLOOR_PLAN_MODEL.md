# Floor-Plan Layout Persistence (Operator CMS "facility setup")

Model + migration that lets operators author floor plans per facility/floor and place the
floor's units on them (position + size). This is the persistence half of the floor-plan
editor; the CMS editor UI and CRUD routes land in later dispatches.

## BLUEPRINT SCALE (P0): 1 grid unit = 1 foot

All canvas geometry (plan `width`/`height`, placement/block `x`/`y`,
`width`/`height`) is in **feet**: canvas W/H are the building's real dimensions
in feet, and every placement/block rect is an integer foot rect in the same
space. Columns stay `Int` (1 grid unit maps 1:1 to 1 ft — no fractional feet).
The editor snaps to the grid and the renderer scales ft → px at whatever zoom
it wants (editor: 24 px/ft at zoom 1), so a layout is both blueprint-accurate
and resolution-independent.

## The models

Two new tables, both additive (creation only — no existing column/table is altered):

### `FloorPlan` — the editable canvas for a floor

| Field       | Type      | Meaning                                                       |
| ----------- | --------- | ------------------------------------------------------------- |
| `id`        | `cuid`    | PK                                                            |
| `floorId`   | FK → Floor| one plan per floor: `@@unique([floorId])`                     |
| `width`     | `Int`     | canvas width in **FEET** (`default 0`)                        |
| `height`    | `Int`     | canvas height in **FEET** (`default 0`)                       |
| `structure` | `Json?`   | **LEGACY** free-form decorations (walls/corridors/entrance/lift/stairs/fire exit) |
| timestamps  |           | `createdAt` / `updatedAt`                                      |

**Feet, not pixels.** (See BLUEPRINT SCALE above.) The legacy wording
"logical grid units" in older revisions of this doc means the same integer
unit — it is now **defined as 1 ft**, so historic placements keep their
numbers and gain real-world meaning.

**`structure` is LEGACY JSONB.** It predates blocks: free-form decorations
(walls/corridors/entrance/lift/stairs/fire exit) were authored as one polymorphic document.
The column stays **readable/writable** so old clients and stored data keep working — the
editor no longer authors *new* decorations into it. Rect-shaped markers authored there are
converted to `FloorPlanBlock` rows (`scripts/backfill-floor-plan-blocks.ts`); walls and
corridors (line/path primitives with no block equivalent) remain as static legacy
decoration and render exactly as before.

### `UnitPlacement` — one geometry row per unit on its floor's plan

| Field         | Type      | Meaning                                                          |
| ------------- | --------- | ---------------------------------------------------------------- |
| `id`          | `cuid`    | PK                                                               |
| `floorPlanId` | FK → FloorPlan | `@@index([floorPlanId])` for plan-scoped reads; `onDelete: Cascade` |
| `unitId`      | FK → Unit | **`@unique`** — a unit is placed at most once; `onDelete: Restrict` |
| `x`, `y`      | `Int`     | top-left position in **FEET**                                    |
| `width`, `height` | `Int` | rendered bounding box in **FEET** (drag/resize; area ≈ unit sqft — see "Footprints" below) |
| timestamps    |           | `createdAt` / `updatedAt`                                        |

Unit linkage is by `Unit.id` (the cuid), never `unitCode` — consistent with every other
relation in the schema.

### `FloorPlanBlock` — one decoration rectangle per element on the plan

| Field         | Type      | Meaning                                                          |
| ------------- | --------- | ---------------------------------------------------------------- |
| `id`          | `cuid`    | PK                                                               |
| `floorPlanId` | FK → FloorPlan | `@@index([floorPlanId])` for plan-scoped reads; `onDelete: Cascade` |
| `name`        | `String`  | operator-given label ("Lift", "Stair", "Walking area", "Exit", ...) |
| `x`, `y`      | `Int`     | top-left position in **FEET** (same coordinate space as placements) |
| `width`, `height` | `Int` | rendered bounding box in **FEET** (drag/resize)            |
| `color`       | `String?` | optional render tint (hex); renderers default to a neutral tone when null |
| timestamps    |           | `createdAt` / `updatedAt`                                        |

**Why relational rows and not more JSON?** Blocks are user-authored layout-decoration
rectangles (lifts, stairs, exits, walking areas, ...) with NO behaviour other than
displaying. Unlike the legacy `structure` markers they are all the **same uniform
primitive** — a name label plus a rect — so the JSON polymorphism argument that justified
`structure` (heterogeneous wall/corridor/entrance/lift/stairs/fireExit shapes, consumed
only as a whole document) **no longer applies**. Every block is individually
created/edited/deleted (add, rename, drag, resize) and is addressable by id, which a flat
relational table gives us for free. The model deliberately mirrors `UnitPlacement`
(plan-scoped FK + cascade, int grid geometry, same upsert pattern), keeping the two
element types consistent. `color` is an optional convenience tint, deliberately minimal —
the feature does not depend on it (NULL → neutral tone).

Delete semantics mirror placements: deleting a `FloorPlan` cascades its blocks; blocks
never reference business rows (no unit/tenant PK), so nothing else is touched.

## Footprints, overlap, and area tolerance (P1–P3)

A bare `sqft` scalar cannot yield a W×H rect, so true-size placement is driven
by **`UnitSize.widthFt`/`heightFt`** (migration
`20260912000000_add_unit_size_footprint`, backfilled for the four catalogue
sizes — no re-seed, existing rows untouched):

| Size   | sqft | Footprint (ft) | Aspect (w/h) |
| ------ | ---- | -------------- | ------------ |
| LOCKER | 12   | 3 × 4          | 0.75         |
| SMALL  | 30   | 5 × 6          | ≈0.833       |
| MEDIUM | 60   | 6 × 10         | 0.6          |
| LARGE  | 120  | 10 × 12        | ≈0.833       |

Resolution order (`sqftFootprint()` in `src/core/floorPlans.ts`, mirrored by
`sizeFootprint()` in the editor): explicit `widthFt`/`heightFt` → per-size
constants → documented fallback **`w = round(sqrt(sqft·aspect))`,
`h = ceil(sqft/w)`** with the per-size aspects above (default aspect 0.75).
Areas match sqft exactly for the catalogue sizes, so the 15% tolerance below
never bites them. The palette chip shows `sqft · W×H ft`.

**Dead XLBIZ key — dropped.** The old editor hardcoded an `XLBIZ: 6×5`
footprint, but no such `UnitSize` exists in the DB or seed (catalogue is
LOCKER/SMALL/MEDIUM/LARGE). Rather than inventing a new size row, the key was
removed; unknown size codes use the aspect fallback. If an XL business size is
ever introduced, add the `UnitSize` row **with** `widthFt`/`heightFt` and the
editor picks it up live via `GET /sizes`.

**Overlap policy — reject.** Unit-vs-unit overlaps are refused: the editor
pre-checks on place/move/resize (toast + revert, no request sent) and the
server enforces the same rule with **409 `PLACEMENT_OVERLAP`**. Blocks are
decoration and may underlay units, so unit-vs-block is NOT checked
(deliberate — corridors span the floor). Touching edges are fine; only shared
interior area collides.

**Resize — lock-to-sqft ON by default.** The corner handle snaps to the
nearest integer rect preserving area ≈ sqft (keeps the dragged width, derives
`h = round(sqft/w)`, clamped to canvas). The toolbar `🔒/🔓 sqft` toggle is the
ops override — turning it off shows a warning because the server still
enforces the area rule. A `⟳ Rotate` button (selection strip) plus a palette
ghost orientation toggle cover rectangular units (swap W/H, clamped +
overlap-checked + persisted).

**Server area-vs-sqft validation (P3) — 400.** `setUnitPlacement` rejects
writes whose drawn area deviates more than **±15%** (`AREA_TOLERANCE`) from
the unit's sqft, with a message naming the expected footprint
(`400 VALIDATION`). Rejection (not warn-and-save) was chosen so the canvas can
never silently drift from the booking truth. Grandfathered rows (e.g. seeded
uniform 2×3 geometry) keep reading fine — the check fires on write only, and
the editor guides the operator back to true size. Fit-in-canvas,
floor-membership, and not-deleted checks are unchanged; place/move never
writes `Unit` rows.

**Legacy placement migration — clamp, don't wipe.** The seeded uniform 2×3
placements are NOT touched by the migration. `pnpm db:backfill-footprints`
(`scripts/backfill-placement-footprints.ts`, opt-in, idempotent) resizes each
placement to its true footprint at the first free spot on its plan; until ops
runs it, old rows render as-is and validate-on-write nudges them to true size.

**Public shape unchanged.** `GET /floor-plans/:branchCode/:level` returns the
same fields as before — canvas numbers are now feet and placement rects are ft
rects, which is exactly what the booking renderer already consumes, so booking
stays compatible with zero client changes.

## Decisions and tradeoffs

**(a) Single plan per floor** (`@@unique([floorId])`):

- A floor has one physical layout; there is no "which plan is current" ambiguity for any
  consumer (the booking renderer wants *the* plan; the CMS editor wants to edit *the* plan).
- Multi-plan would need version activation logic on every read; it can be added additively
  later (e.g. a `status`/`version` column) without schema surgery.
- Consequence: the floor→plan relation is one-to-one (`Floor.floorPlan`), and the plan's
  upsert key for the editor save is simply `floorId`.

**(b) Placement join model, NOT geometry columns on `Unit`**:

- Units predate floor plans; geometry would be null/meaningless without a plan and would
  burden every future unit feature (codegen, soft-delete, searches) with layout baggage.
- The placement is subordinate presentation data whose lifecycle is tied to the *plan*, not
  the unit: drag/resize only ever writes `UnitPlacement`.
- Tradeoff: reading a layout requires a join plan → placements → unit — one query, and it is
  exactly the shape the renderer needs, so the cost is negligible.
- The `@unique` on `unitId` is the editor's upsert key and guards against duplicate geometry.

**(c) Soft-delete handling for placed units**:

- `Unit.deletedAt` is an **UPDATE** (per `docs/UNIT_DELETION.md`), so a soft-deleted unit's
  `UnitPlacement` row is untouched — authored geometry survives and reads simply exclude it.
- Reads render a plan by joining `placement -> unit` and **filtering `unit.deletedAt == null`**;
  the round-trip verification shows `findMany({ where: { unit: { deletedAt: null } } })` returns
  0 rows for a soft-deleted unit while the placement row still exists.
- A future **hard** delete of a unit is blocked while a placement exists (`onDelete: Restrict`)
  — a purge path must clear placements explicitly instead of silently destroying geometry.

### DELETE semantics

| Action                    | Result                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| Delete a `FloorPlan`      | Cascades its `UnitPlacement` **and `FloorPlanBlock`** rows; **Unit rows untouched** (FKs point placement/block → plan, never back) |
| Delete a `Floor`          | Cascades its plan (and so its placements/blocks); a floor with units is already undeletable (`Unit.floorId` has no cascade) |
| Soft-delete a `Unit`      | Placement row persists; visible reads filter it out                       |
| Hard-delete a `Unit` (future) | Blocked (`Restrict`) until its placement is removed (or the decision is revisited) |

## Migration

`prisma/migrations/20260817140819_add_floor_plan_layout/migration.sql` — two `CREATE TABLE`,
three `CREATE INDEX`/`CREATE UNIQUE INDEX`, three `ADD CONSTRAINT` statements only. Verified
by `prisma migrate dev --create-only` (generated SQL), applied with `prisma migrate deploy`
over a freshly replayed migration history (7 prior migrations) plus a seeded replica of the
dev dataset; pre/post counts were identical (Branch 3, Floor 12, Unit 80) and both new
tables start empty.

`prisma/migrations/20260819071957_add_floor_plan_blocks/migration.sql` — additive `CREATE
TABLE "FloorPlanBlock"` + one `CREATE INDEX` + one `ADD CONSTRAINT` (ON DELETE CASCADE).
Applied cleanly over the existing dev data (the 2 authored plans with their placements were
untouched; `FloorPlanBlock` starts empty).

`prisma/migrations/20260912000000_add_unit_size_footprint/migration.sql` — additive
`ADD COLUMN "UnitSize"."widthFt"/"heightFt"` (nullable `INTEGER`) + deterministic
`UPDATE` backfill for LOCKER/SMALL/MEDIUM/LARGE (see Footprints table above).
Safe to apply over live data: no existing column/table is altered, unknown/custom
sizes keep NULL (aspect fallback), and no placement rows are touched.

## Forward compatibility

The single plan-per-floor shape already serves the **public read endpoint** (see
`docs`/routes): a renderer needs `FloorPlan` (canvas + legacy `structure` + blocks) and its
`UnitPlacement`s with the unit's `unitCode`/`name`/`size` — all reachable via existing
relations with no tenant/PII. Both migrations are purely additive, so the existing public
unit listing and map APIs are unaffected; the public floor-plan read stayed additive too —
it gained a `plan.blocks` array and old clients (which fall back to a synthesized grid via
`UnitFloorPlan.tsx`) tolerate it as before.

## Reference

- DB: `FloorPlan` + `UnitPlacement` + `FloorPlanBlock` in `prisma/schema.prisma`
  (migrations `add_floor_plan_layout` and `add_floor_plan_blocks`).
- Aggregate + CMS routes: `src/core/floorPlans.ts` and `src/routes/cms.ts`
  (`/api/v1/cms/floor-plans/:floorId/blocks` POST/PUT/DELETE; plan GETs now include
  `blocks`). Editor UI: `src/cms/admin/dashboard.html` + `src/cms/admin/admin.js`.
- Data conversion (one-off, no re-seed): `scripts/backfill-floor-plan-blocks.ts`
  (`pnpm db:backfill-blocks`) — converts rect-shaped legacy `structure` markers (lift /
  stairs / entrance / fireExit) into `FloorPlanBlock` rows and keeps walls/corridors as
  static legacy structure.
- Footprint backfill (opt-in, no re-seed): `scripts/backfill-placement-footprints.ts`
  (`pnpm db:backfill-footprints`) — resizes grandfathered placements (e.g. seeded
  uniform 2×3) to true `sqftFootprint()` rects at each plan's first free spot.
- Unit soft-delete rules that placements must respect: `docs/UNIT_DELETION.md`.
# Floor-Plan Layout Persistence (Operator CMS "facility setup")

Model + migration that lets operators author floor plans per facility/floor and place the
floor's units on them (position + size). This is the persistence half of the floor-plan
editor; the CMS editor UI and CRUD routes land in later dispatches.

## The models

Two new tables, both additive (creation only — no existing column/table is altered):

### `FloorPlan` — the editable canvas for a floor

| Field       | Type      | Meaning                                                       |
| ----------- | --------- | ------------------------------------------------------------- |
| `id`        | `cuid`    | PK                                                            |
| `floorId`   | FK → Floor| one plan per floor: `@@unique([floorId])`                     |
| `width`     | `Int`     | canvas width in logical grid units (`default 0`)              |
| `height`    | `Int`     | canvas height in logical grid units (`default 0`)             |
| `structure` | `Json?`   | **LEGACY** free-form decorations (walls/corridors/entrance/lift/stairs/fire exit) |
| timestamps  |           | `createdAt` / `updatedAt`                                      |

**Grid units, not pixels.** All canvas geometry (plan `width`/`height`, placement/block
`x`/`y`, `width`/`height`) is in *logical grid units*. The editor snaps to the grid and the
renderer scales grid → px at whatever zoom it wants, so a layout is resolution-independent.

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
| `x`, `y`      | `Int`     | top-left grid-unit position                                       |
| `width`, `height` | `Int` | rendered bounding box in grid units (drag/resize)            |
| timestamps    |           | `createdAt` / `updatedAt`                                        |

Unit linkage is by `Unit.id` (the cuid), never `unitCode` — consistent with every other
relation in the schema.

### `FloorPlanBlock` — one decoration rectangle per element on the plan

| Field         | Type      | Meaning                                                          |
| ------------- | --------- | ---------------------------------------------------------------- |
| `id`          | `cuid`    | PK                                                               |
| `floorPlanId` | FK → FloorPlan | `@@index([floorPlanId])` for plan-scoped reads; `onDelete: Cascade` |
| `name`        | `String`  | operator-given label ("Lift", "Stair", "Walking area", "Exit", ...) |
| `x`, `y`      | `Int`     | top-left grid-unit position (same coordinate space as placements) |
| `width`, `height` | `Int` | rendered bounding box in grid units (drag/resize)            |
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
- Unit soft-delete rules that placements must respect: `docs/UNIT_DELETION.md`.
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
| `structure` | `Json?`   | free-form decorations (walls/corridors/entrance/lift/stairs/fire exit) |
| timestamps  |           | `createdAt` / `updatedAt`                                      |

**Grid units, not pixels.** All canvas geometry (plan `width`/`height`, placement `x`/`y`,
`width`/`height`) is in *logical grid units*. The editor snaps to the grid and the renderer
scales grid → px at whatever zoom it wants, so a layout is resolution-independent. The
editor is free to introduce a zoom/scale factor; the schema deliberately stores the
abstract grid, not screen pixels.

**`structure` is deliberately JSONB.** Decorations are presentational, heterogeneously
shaped (a wall has `x1/y1/x2/y2`, an entrance or lift has a position/size, a corridor has a
path), are only ever consumed *as a whole document* by the renderer, and are never queried
or filtered individually. Relational tables would mean polymorphic element tables,
schema-evolution churn, and zero query benefit. Postgres validates the document at write
time. The exact inner shape is owned by the future editor API — a suggested starting point:

```json
{
  "walls": [{ "x1": 0, "y1": 0, "x2": 120, "y2": 0 }],
  "corridors": [{ "pts": [{ "x": 0, "y": 40 }, { "x": 120, "y": 40 }], "w": 3 }],
  "entrance": { "x": 60, "y": 0, "w": 4 },
  "lift": { "x": 8, "y": 8, "w": 6, "h": 6 },
  "stairs": { "x": 108, "y": 8, "w": 8, "h": 6 },
  "fireExit": { "x": 60, "y": 84, "w": 4 }
}
```

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
| Delete a `FloorPlan`      | Cascades its `UnitPlacement` rows; **Unit rows untouched** (FK is placement → unit, never back) |
| Delete a `Floor`          | Cascades its plan (and so its placements); a floor with units is already undeletable (`Unit.floorId` has no cascade) |
| Soft-delete a `Unit`      | Placement row persists; visible reads filter it out                       |
| Hard-delete a `Unit` (future) | Blocked (`Restrict`) until its placement is removed (or the decision is revisited) |

## Migration

`prisma/migrations/20260817140819_add_floor_plan_layout/migration.sql` — two `CREATE TABLE`,
three `CREATE INDEX`/`CREATE UNIQUE INDEX`, three `ADD CONSTRAINT` statements only. Verified
by `prisma migrate dev --create-only` (generated SQL), applied with `prisma migrate deploy`
over a freshly replayed migration history (7 prior migrations) plus a seeded replica of the
dev dataset; pre/post counts were identical (Branch 3, Floor 12, Unit 80) and both new
tables start empty.

## Forward compatibility

The model is ready for a later **public read endpoint**: a renderer only needs
`FloorPlan` (canvas + structure) and its `UnitPlacement`s with the unit's
`unitCode`/`name`/`size` — all reachable via existing relations. Because this migration is
purely additive, the existing public unit listing and map APIs are unaffected. When the
endpoint lands, keep the current JSON shape additive-only so older booking clients keep
working (they already tolerate an absent layout — `UnitFloorPlan.tsx` synthesizes a grid).

## Reference

- DB: `FloorPlan` + `UnitPlacement` in `prisma/schema.prisma` (migration
  `add_floor_plan_layout`).
- Unit soft-delete rules that placements must respect: `docs/UNIT_DELETION.md`.
- This document is the layout persistence contract only — no `src/core` aggregate or route
  mounts it yet. The editor dispatch will add `src/core/floorPlans.ts` (thin) and
  `src/routes/cms.ts` endpoints under `/api/v1/cms` using the `ok`/`created`/`AppError`
  envelope and `requireAuth`.
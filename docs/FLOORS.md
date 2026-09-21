# Facility Floors — active/inactive + CRUD

`Floor.isActive` (boolean, default `true`, indexed) gates **public visibility**.
It is deliberately separate from `Unit.deletedAt` (soft-delete) and from
`UnitStatus.INACTIVE` (a normal business state of a unit): floors are never
soft-deleted — they are either deactivated (reversible) or hard-deleted
(irreversible, guarded).

## Semantics

| State | Public API (`/api/v1/public/…`) | CMS admin (`/api/v1/cms/…`) |
|---|---|---|
| `isActive: true` | floor + its units visible (subject to the usual browseable-status + `deletedAt` filters) | visible |
| `isActive: false` | **invisible everywhere**: `GET /units`, `GET /units/map` (empty units + zero legend), `GET /branches` (level dropped, `availableUnits` excludes the floor), `GET /floor-plans/:branch/:level` (404) | visible with an **Inactive** badge |

- `isActive: false` is **reversible**: `PUT /floors/:id { "isActive": true }`.
- Admin reads (`GET /units`, `GET /units/map`, `GET /branches`, `GET
  /floor-plans/*`, `GET /summary`, portfolio) are **unfiltered** — operators
  always see the whole estate including inactive floors.
- `POST /units` refuses an inactive `floorId` (400 VALIDATION) so operators
  cannot create inventory that is invisible to booking. Reactivate the floor
  first.

## CMS CRUD (`/api/v1/cms/floors`, Bearer JWT, envelope `{ data, meta }`)

- `GET /floors[?branchId=]` — all floors incl. inactive, each with
  `isActive`, `unitCount` (all rows) and `liveUnitCount` (`deletedAt: null`).
- `POST /floors { branchId, level 1..99, name? }` — name defaults to
  `Level N`. Duplicate `(branch, level)` → 409.
- `GET /floors/:id` — one floor with counts.
- `PUT /floors/:id { level?, name?, isActive? }` — the `isActive` toggle is
  the (de)activation path. Level collisions → 409.
- `DELETE /floors/:id` — **guarded**: 409 CONFLICT while ANY Unit rows
  reference the floor (live or soft-deleted — Unit rows are append-only
  history, codes are never reused, and the Floor→Unit FK has no cascade, so
  the database itself would refuse). The 409 body names the counts and points
  at deactivation.
- `DELETE /floors/:id?deactivate=true` — converts the delete into a
  reversible deactivation (`isActive: false`) instead of removing the row.
  This is the safe path for floors that still hold units.
- A floor with **zero** Unit rows hard-deletes cleanly (plan, placements and
  metrics snapshots cascade; no Unit rows exist to touch).

Guard choice (documented per task): **block, never orphan, never force**.
There is no `?force` that deletes units — bulk-deleting live (incl.
OCCUPIED/RESERVED, tenant-linked) units through a floor delete would bypass
the per-unit `softDeleteUnit` guards. Deactivation achieves the product goal
(hidden from booking) with zero data loss.

## Cleanup record — 2026-09-20: keep L1 only

Live DB held 12 floors (BM/WD/UB × L1–L4), 841 Unit rows (840 live, 696
browseable AVAILABLE/RESERVED).

- L2–L4 per branch: 70 live units each (46 AVAILABLE + 12 RESERVED + 12
  OCCUPIED), 630 live units total across the 9 floors, 216 tenant-linked.
  **Hard deletion is refused by the guard** (and would strand tenants), so no
  floor or unit was deleted.
- Action taken (reversible): `isActive: false` on all 9 L2–L4 floors via
  `PUT /floors/:id`. Public browseable units drop 696 → 174 (L1 only:
  58 per branch). Admin still lists all 12 floors with Inactive badges.
- To ever remove an L2–L4 floor permanently: vacate every unit (move tenants
  out, clear RESERVED holds), soft-delete each unit via `DELETE /units/:code`
  (OCCUPIED/OVERDUE units refuse — by design), then `DELETE /floors/:id`
  succeeds once the floor holds zero Unit rows. Until then, deactivation is
  the steady state.

There is no public `GET /floors` route (booking reads `/units`, `/units/map`,
`/floor-plans/:branch/:level`, `/branches` — all gated); none was added.

## Map size legend — 2026-09-20: categorize units by size

Sizes are the 4 `UnitSize` rows (`LOCKER` / `SMALL` / `MEDIUM` / `LARGE`,
`GET /api/v1/cms/sizes`). Both map payloads (`GET /api/v1/cms/units/map` +
`GET /api/v1/public/units/map`) now carry size identity **additively** — every
existing key (`size` name string, `sizeCode`, `sqft`, `rate`, `psf`, `status`,
`legend`) is untouched:

- Per cell: new `sizeInfo: { code, name }` object alongside the existing
  `size` / `sizeCode` strings (kept byte-compatible for booking readers).
- Top level: new `sizes` array — one entry per size over the SAME visible set
  the status `legend` counts (post `?size=` / `?nearLift=` filter):
  `{ code, name, total, byStatus: { occupied, available, reserved, overdue,
  maintenance, blocked, inactive } }`.
- Public map accepts the same optional `?size=` / `?nearLift=` filters as the
  admin map (defaults omitted → unchanged BM/L1 browseable-units response).

Admin unit-map convention (see `SIZE_COLOR` in `src/cms/admin/constants.js` —
colours mirror the psf-chart size series):

- **Cell fill + corner dot = status** (existing `.u-cell.{tone}` backgrounds,
  unchanged: occupied/available/reserved/overdue/maintenance/blocked).
- **Top ribbon + tinted size chip = size**: LOCKER terracotta `#c97952`,
  SMALL green `#526557`, MEDIUM dark-green `#334437`, LARGE gold `#e5a84b`
  (unknown sizes fall back to grey `#8a8478`).
- The legend keeps the status row intact and appends a `Sizes:` row with per-size
  counts (hover = by-status breakdown). The existing size filter (`All sizes` +
  each size, populated from `GET /sizes`) now shows live counts per option and
  composes with the branch/level tabs (server-side `?size=`).

# Unit Codes vs Display Names

**Always respected.** This document defines how `Unit.code` and `Unit.name` relate. Any future
work touching units (backend, API, admin UI, bookings, or reporting) must follow these rules.

## The convention

Every `Unit` row has two identifiers:

| Field      | DB column  | Purpose                          | Immutable? | Unique?      |
| ---------- | ---------- | -------------------------------- | ---------- | ------------ |
| `unitCode` | `unitCode` | Stable identity / unique key     | **Yes**    | **Yes**      |
| `name`     | `name`     | Optional human-friendly label    | No         | No           |

- **`unitCode`** is auto-generated at creation as a **4-digit numeric code**,
  e.g. `1001` (next free code above the global MAX across all rows, deleted
  included, starting at 1001; range 1001–9999). It is immutable, globally
  unique, and the only key used for lookups, relations, map cells, and codegen.
  Pre-4-digit legacy codes (`BM-01-01` style) keep working everywhere — they are
  only replaced by the opt-in rename script
  (`scripts/backfill-unit-codes-4digit.ts`, `--dry-run` first); codegen itself
  never renames. FKs always point at `Unit.id`, never at the code (see that
  script's header for the full safety note).
- **`name`** is an optional display label. When it is `NULL`, empty, or whitespace-only, the
  **display name equals `unitCode`** (the fallback). It is purely cosmetic.

### Rules (must follow)

1. **Never use `name` for identity.** Lookups, uniqueness, relations, and URL params must always
   use `unitCode`. `name` never affects codegen — the next `unitCode` is derived solely from
   existing codes, never from names.
2. **Never let `name` leak into the map.** Map cells show the short code (identity), never the
   display name. Do not change map rendering to show names. (Short code = the
   full code for 4-digit codes, which have no dashes; legacy `BM-01-01` codes
   shorten to their trailing segments.)
3. **Normalize before storing:** `name` is trimmed; empty/whitespace-only values are stored as
   `NULL` (which triggers the code fallback). Max length 80.
4. **Serialize with the fallback:** every API serializer returns `name: unit.name ?? unit.unitCode`
   so clients never have to re-implement the fallback. If a serializer lacks `name`, add it —
   do not drop it.
5. **Undefined vs null on update:** `PUT /units/:code` treats `name: undefined` (absent) as "leave
   unchanged" and `name: null` as "clear it" (falls back to the code). Empty string also clears.

## API contract

All endpoints are under `/api/v1/cms` (admin, Bearer JWT) unless noted.

| Endpoint                      | Accepts `name`?                      | Returns `name`? |
| ----------------------------- | ------------------------------------ | --------------- |
| `POST /units`                 | Yes — optional string, trimmed       | Yes             |
| `PUT /units/:code`            | Yes — optional `string \| null`      | Yes             |
| `GET /units` (list)           | —                                    | Yes (per row)   |
| `GET /units/:code` (detail)   | —                                    | Yes             |
| `GET /api/v1/public/units`    | —                                    | Yes (additive)  |
| `GET /units/map`              | —                                    | No (map = identity) |

- `POST /units` with no `name` (or empty) stores `NULL` → the returned `name` equals the new code.
- `PUT /units/:code` with `name: null` clears the label → `name` falls back to the code.
- Validation: `name` is a trimmed string, max 80 chars; `null` allowed on update only.

## UI behavior (admin dashboard)

- **Add Unit form** — a `Name (optional)` text input (`#f-name`) with placeholder
  "Defaults to unit code". On create the trimmed value is sent **only when
  non-empty**; otherwise the unit is created unnamed and displays its code.
  The form also carries **Air-con (AC)** and **Pillar** Yes/No selects
  (`#f-hasAC`, `#f-hasPillar`, default No); the legacy Climate Control text
  input is removed (the API still accepts `climateControl` and maps it onto
  `hasAC` — see `climateControlToHasAC` in `src/core/units.ts`).
- **Edit Unit form** — `#f-name` is pre-filled with the current name, or left empty when the
  display name equals the code. On save: non-empty → sent as `name`; empty → sent as `name: null`
  (clears back to the code fallback).
- **Units table** — a **Name** column shows the normalized display name (code fallback already
  applied server-side and in `normalizeUnit`); the Code column always shows the immutable code.
  A **Type** column shows `AC` / `Non-AC` (+ `Pillar` when present).
- **Detail panel** — the title shows the display name (`Name · Size Unit`); when the name differs
  from the code, the code is shown as a secondary badge so identity stays visible. When there is
  no custom name, the title shows the code (unchanged behaviour).

## Reference

- DB: `Unit.name String?` in `prisma/schema.prisma` (migration `add_unit_name`).
- Core: `src/core/units.ts` — `CreateUnitInput.name`, `UpdateUnitInput.name`,
  `serializeUnit` / `getUnitDetail` / `listPublicUnits` emit the code-fallback.
- Admin UI: `src/cms/admin/dashboard.html` (`#f-name`, Name `<th>`) and
  `src/cms/admin/admin.js` (`normalizeUnit`, `renderUnitsTable`, `showUnitDetail`,
  `openCreateForm`, `openEditForm`, `submitUnitForm`).

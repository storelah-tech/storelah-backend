# Unit Deletion (Soft-Delete) — Lifecycle vs Status

**Always respected.** This document defines how units are deleted. Any future work touching units
(backend, API, admin UI, bookings, reporting, or seed data) must follow these rules.

## The model

Every `Unit` row has two independent markers that are **never mixed**:

| Marker      | DB column    | Meaning                                                    | Set by                    |
| ----------- | ------------ | ---------------------------------------------------------- | ------------------------- |
| `deletedAt` | `deletedAt`  | **Lifecycle**: is this unit deleted? (`null` = active)     | `DELETE /units/:code` only |
| `status`    | `status`     | **Business state**: Occupied / Available / Reserved / …    | create / update only      |

- **`deletedAt` is THE deletion marker.** Deleting a unit sets `deletedAt = now()` and does
  **NOT** touch `status`.
- **`status` is a pure business state.** `INACTIVE` remains a legitimate, creatable/updatable
  status (e.g. a unit taken out of service) — but deletion never sets it, and setting a unit to
  `INACTIVE` does **not** delete it (it stays visible in lists).
- A deleted unit (`deletedAt IS NOT NULL`) is **hidden from every read** and **not addressable**
  (direct access → 404).

## Rules (must follow)

1. **The only delete primitive is `softDeleteUnit`** (`src/core/units.ts`). It sets
   `data: { deletedAt: new Date() }`. It keeps the 409 guard: units that are `OCCUPIED` or
   `OVERDUE` cannot be deleted. Deleting an already-deleted unit → 404.
2. **Every read of units must filter `deletedAt: null`** — lists (`findMany` **and** the count),
   the public listing, the map, the detail lookup, the activity feed, summary/KPI counts, rate
   adjustment lookups, and the customer portal. A unit that can be seen anywhere must not be
   deleted. If a new read path is added, it must filter too.
3. **A deleted unit is not addressable**: `GET /units/:code`, `PUT /units/:code`, and
   `POST /units/:code/rate` all 404 for a deleted code. Do not "un-delete" by writing to it.
4. **Never set `status = 'INACTIVE'` to delete.** That was the old convention and is gone. If a
   flow legitimately wants a unit out of service but visible, update `status` to `INACTIVE`
   (via the normal create/update path); if it wants the unit gone, call `softDeleteUnit`.
5. **Codegen never reuses codes of deleted units.** `createUnit` derives the next `unitCode`
   from the MAX suffix across **all** rows on that branch+floor (deleted or not), so the sequence
   stays monotonic and codes with history are never re-assigned. Do not add a `deletedAt: null`
   filter to that codegen query.
6. **Keep `deletedAt` in serializers** (`serializeUnit`, the public serializer) as a nullable
   field so consumers can distinguish a normal `INACTIVE` unit from a deleted one if they ever
   hold a stale reference.

## API contract

All endpoints under `/api/v1/cms` (admin, Bearer JWT) unless noted.

| Endpoint                     | Behavior for a deleted unit                          |
| ---------------------------- | ---------------------------------------------------- |
| `DELETE /units/:code`        | Sets `deletedAt`; **status unchanged**; `OCCUPIED`/`OVERDUE` → 409 |
| `GET /units`                 | Excluded (never appears)                             |
| `GET /units/map`             | Excluded (never appears)                             |
| `GET /units/:code`           | 404 NOT_FOUND                                        |
| `PUT /units/:code`           | 404 NOT_FOUND                                        |
| `POST /units/:code/rate`     | 404 NOT_FOUND                                        |
| `GET /api/v1/public/units`   | Excluded (never appears)                             |
| `GET /units/activity`        | Excluded (no events from deleted units)              |

## UI behavior (admin dashboard)

- The **Delete** row action calls `DELETE /units/:code` (soft-delete). Its `window.confirm`
  message reflects soft-delete: "removes it from the map and lists".
- Deleted units simply stop appearing after the next refresh — there is **no** client-side
  removal logic and **no** `INACTIVE` styling for deletion (the `row-blocked`/INACTIVE styling
  now exclusively means a genuinely inactive — but visible — unit).
- `INACTIVE` stays selectable in the Add/Edit form status dropdown; setting it is a business
  decision, not a deletion.

## Reference

- DB: `Unit.deletedAt DateTime?` in `prisma/schema.prisma` (migration
  `add_unit_deleted_at`, which backfilled `deletedAt = updatedAt` for the former
  `status = 'INACTIVE'` "deleted" residues).
- Core: `src/core/units.ts` — `softDeleteUnit`, `listUnits`, `listPublicUnits`,
  `getUnitMap`, `getUnitDetail`, `updateUnit`, `getUnitActivity`; also
  `src/core/summary.ts`, `src/core/rates.ts`, `src/core/customers.ts`,
  `src/core/tenants.ts` (assignment validation).
- Routes: `src/routes/cms.ts` — `DELETE /units/:code` → `softDeleteUnit`.
- Admin UI: `src/cms/admin/admin.js` — delete `window.confirm` text.

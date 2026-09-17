# Facility Operations (sidebar modules 2–6)

Migration: `20260916114112_add_facility_operations` (additive — 12 new tables,
back-relation arrays on `Branch`/`Unit` only). Seed: `pnpm db:seed-facility-ops`
(wipes only the new tables, recreates representative rows).

## 2. Maintenance (`src/core/maintenance.ts`)

- `WorkOrder` — branch/unit scope, `OPEN → IN_PROGRESS → DONE`, monetary
  `value`. Entering `DONE` stamps `completedAt`; reopening clears it.
  Routes: `GET/POST /work-orders`, `GET/PATCH/DELETE /work-orders/:id`.
- `PreventiveTask` — trade category `HVAC / FIRE / DOORS / CCTV` with
  `percentComplete` 0..100 (validated server-side).
  Routes: `GET/POST /preventive-tasks`, `PATCH/DELETE /preventive-tasks/:id`,
  plus `GET /preventive-tasks/progress` (% complete per category).
- UI: `facility-maintenance` panel — stat tiles, work-order table with
  one-click status advance, preventive progress bars + task table.

## 3. Assets & vendors (`src/core/assets.ts`)

- `Asset` — stable unique `code` (e.g. `AST-WDL-HVAC-04`, immutable after
  create — 409 on clash) + branch link. `GET/POST /assets`,
  `GET/PATCH/DELETE /assets/:id`.
- `Vendor` — `sla` commitment + `ytdSpend`. `GET/POST /vendors`,
  `GET/PATCH/DELETE /vendors/:id`.
- UI: `facility-assets` panel — asset register table + vendor register table.

## 4. Incidents (`src/core/incidents.ts`)

- `Incident` — severity `LOW/MEDIUM/HIGH/CRITICAL`, status
  `OPEN → IN_PROGRESS → RESOLVED → CLOSED` (`resolvedAt` bookkeeping),
  branch/unit link, multi-step `checklist` JSON (`[{ label, done }]`) with a
  derived `checklistProgress` %. `GET/POST /incidents`,
  `GET/PATCH/DELETE /incidents/:id`.
- UI: `facility-incidents` panel — severity/status filters, stat tiles,
  one-click status advance, checklist progress column.

## 5. Access control (`src/core/access.ts`)

- `AccessDoor` (unique code, immutable), `AccessCredential` (`PERMANENT /
  TEMPORARY / VISITOR`, `validTo` expiry for temporary passes),
  `AccessPolicy`, `AccessEvent` (`GRANTED / DENIED`).
- Doors/credentials with recorded events 409 on delete (revoke instead).
- Routes under `/access/*`: `stats`, `events` (GET list + POST record),
  `credentials` (GET/POST/PATCH/DELETE, `?temporary=1`), `doors`
  (GET/POST/PATCH/DELETE), `policies` (GET/POST/PATCH/DELETE).
- UI: `facility-access` panel — header stats (entries / credentials / doors)
  + 5 sub-panels: `access-live` (latest events), `access-credentials`,
  `access-temporary` (expiry window), `access-exceptions` (DENIED events),
  `access-policies` (+ doors table).

## 6. Inspections & compliance (`src/core/inspections.ts`)

- `InspectionChecklist` — frequency `DAILY / WEEKLY / MONTHLY / QUARTERLY /
  ANNUAL`, JSON step items, `% complete`. `GET/POST
  /inspections/checklists`, `PATCH/DELETE /inspections/checklists/:id`.
- `ComplianceCertificate` — type (Fire Safety / Lift / Public Liability),
  `expiryDate`. Expiry surfacing derives from the date (`derivedStatus` +
  `daysUntilExpiry`; EXPIRING ≤ 60 days), never trusts the stored mirror.
  `GET /inspections/certificates?expiring=1` returns EXPIRING/EXPIRED only.
  `GET/POST /inspections/certificates`, `PATCH/DELETE
  /inspections/certificates/:id`.
- UI: `facility-inspections` panel — frequency filter, expiry countdown +
  status pills.

All routes live under `/api/v1/cms`, sit behind `requireAuth`
(unauthenticated → 401 in the app envelope), use zod validation and the
`ok()` / `created()` envelope. OpenAPI: spec v1.3.0 (additive), `Operator CMS`
tag.

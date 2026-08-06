# Tenants Session Plan — dedicated sidebar CRUD view (mirror of Units)

Goal: add a **Tenants** sidebar view to the operator admin UI (`src/cms/admin/dashboard.html` + `admin.js`), wiring full CRUD to the live `/api/v1/cms/tenants` endpoints, mirroring the Units pattern exactly. Backend gap-fixes (unit reassignment, occupied-unit guard) are in scope.

Read this doc top-to-bottom before starting. Execute phases in order; do not commit (orchestrator commits after review).

---

## 0. Non-negotiables (carried from the Units sessions)

- **Frozen files:** `src/cms/dashboard.html` and `src/cms/data-layer.js` are immutable — byte-identical. All work lives in `src/cms/admin/dashboard.html` + `src/cms/admin/admin.js` (+ backend `src/core`/`src/routes` where the plan says).
- **No browser/CDP verification.** A prior attempt hung there. Verify with `pnpm check` + live `curl` round-trips only.
- **Envelope API:** responses are `{ data, meta }` / `{ error: { code, message, details? } }` via `src/lib/http.ts`. Auth = Bearer JWT (`requireAuth`). The UI's `ApiError` helper tolerates both the envelope and the plain-string 401.
- **`deletedAt: null` rule** (units): every unit read must filter `deletedAt: null`; deleted units are invisible and 404 on direct access. Already applied in `src/core/tenants.ts` unit lookups — keep it that way.
- Leave the backend running on `:4000` at the end. Restore any test data you create (no AVAILABLE strays; see Baseline below).
- Verification is curl-only, no headless Chrome.

---

## 1. Current state (verified 2026-08-06)

### Backend — already complete, no work needed unless stated
- `GET /api/v1/cms/tenants` → `listTenants()`: all tenants, ordered by name asc. Row shape: `{ id, name, type, segment, unit: <unitCode|null>, size, sqft, rate, psf, since, nextPayment, status }`. Envelope meta `{ count }`. **No pagination, no search, no filters.**
- `POST /api/v1/cms/tenants` — `createTenantSchema`: `name` (required), `type` PERSONAL|BUSINESS, `segment`, `email` (email-format), `mobile`, `unitId`, `moveInDate` (ISO datetime string → Date), `monthlyRate` (required, ≥0), `sqft` (positive), `status` ACTIVE|DUE_SOON|OVERDUE|NOTICE, `autoDebit`. `psf` derived server-side: `monthlyRate / sqft` (sqft from unit if `unitId` given, else from `sqft`).
- `PUT /api/v1/cms/tenants/:id` — `updateTenantSchema`: `name`, `type`, `segment` (nullable), `email`, `mobile` (nullable), `monthlyRate`, `status`, `autoDebit`. **Missing `unitId` — tenants cannot be reassigned through the API today.** (Gap 1.)
- `DELETE /api/v1/cms/tenants/:id` → `deactivateTenant`: transaction — tenant `status: 'INACTIVE'`, `unitId: null`, and (if it had one) the unit is released back to `status: 'AVAILABLE'`. Returns `{ id, unitReleased }`. Tenant has **no `deletedAt`** — deactivation is its soft-delete and is correct as-is.
- `Unit.unitId` is `@unique` — two tenants pointing at one unit hits a unique constraint → unhandled 500 today. (Gap 2.)
- Tenant enums: `AccountType { PERSONAL, BUSINESS }`; `TenantStatus { ACTIVE, DUE_SOON, OVERDUE, NOTICE, INACTIVE }`.

### UI — current admin app
- Sidebar nav lives in `dashboard.html` (`.nav-item[data-view=...]`, sections "Overview" / "Operations" / "Revenue" / "Growth" / "System"). Only `dashboard` + `units` are wired.
- `admin.js` `switchView(view)` (~line 853) toggles `#view-dashboard` / `#view-units`; nav click handlers bound ~line 926; `location.hash === '#units'` handled ~line 1010.
- Units view is `#view-units` (`dashboard.html` line 515+): datatable `#unitsBody`, pagination controls, `.act-btn` action buttons (View/Edit/Delete/Rate), create/edit modal using `#f-*` fields, `refreshUnitsView()` on switch.
- `bindTenants(rows)` exists at `admin.js` ~line 309 and renders the **dashboard** view's small tenants table (`#tenantsBody`). Do not remove or break it.

---

## 2. In-scope backend gaps (small, deliberate)

1. **Unit reassignment.** Add `unitId: z.string().nullable().optional()` to `updateTenantSchema`; extend `updateTenant` to handle `unitId`:
   - If a new `unitId` is given: look up with `deletedAt: null`, else 400 VALIDATION (not found / deleted).
   - If the target unit is occupied by another tenant (i.e. `unit.tenant` exists), or currently OCCUPIED/OVERDUE — 400 VALIDATION (see Gap 2). Otherwise reassign, recompute `sqft`/`psf` from the new unit, and release the previous unit back to AVAILABLE if it was occupied by this tenant. Keep the old unit's status rules consistent with `deactivateTenant`.
   - If `unitId: null`: release current unit to AVAILABLE, clear assignment.
   - Do this in a transaction.
2. **Occupied-unit guard on create/assign.** Before assigning a `unitId`, check the unit is currently not occupied (no live tenant on it). `unitId @unique` is the DB backstop, but turn the raw 500 into a clean 400 VALIDATION. Applies to both `createTenant` and the new reassignment path.
   - Decision needed at implementation: what counts as "occupied" — any existing `Tenant.unitId === unitId` (strongest, matches the unique constraint) vs only ACTIVE/DUE_SOON/OVERDUE tenants. Recommend: any tenant row pointing at it, since a tenant is released (unitId→null) on deactivate anyway.

**Out of scope (deliberate):** keep `listTenants` unpaginated — client-side search over the full list is fine at this data size (matches dashboard volume). Do NOT add server pagination/filters unless the orchestrator asks. Do NOT add tenant `deletedAt` — `INACTIVE` status is the tenant soft-delete.

---

## 3. UI work (the bulk)

Mirror the Units view structure exactly.

### 3.1 `dashboard.html`
- Add a nav item under the **Operations** section, next to Units: `<div class="nav-item" data-view="tenants"><span class="nav-icon">👤</span> Tenants</div>`.
- Add a new `<div class="view" id="view-tenants" hidden>` section mirroring `#view-units`'s layout: header + "New Tenant" button, search/filter row, table (`<tbody id="tenantsViewBody">`), empty state, and a create/edit modal reusing the modal shell with `#tf-*` field ids (tenant form), e.g. `#tf-name, #tf-type, #tf-segment, #tf-email, #tf-mobile, #tf-unit, #tf-moveInDate, #tf-rate, #tf-status, #tf-autoDebit`.
- Table columns (match Units density): **Name** (primary), **Type/Segment** (secondary), **Unit** (unitCode or —), **Size/sqft**, **Rate** (rate + psf sub-line), **Status** (badge), **Next payment** (date), **Actions** (View / Edit / Deactivate — `.act-btn` compact, same CSS as units).
- Status badges reuse the Units status-badge styling approach; map ACTIVE/DUE_SOON/OVERDUE/NOTICE/INACTIVE.

### 3.2 `admin.js`
- Extend `state` with a tenants view state if needed. Extend `switchView(view)` for `tenants` (toggle `#view-tenants`), add `#tenants` to the `location.hash` handler, and bind the new nav item in the same loop (~line 928) — it already binds by `data-view`, so it may be automatic; verify.
- `normalizeTenant(row)` — mirror `normalizeUnit` (~line 137): flatten nested `unit`/`size`, format rate/psf via the existing number formatting, `since`/`nextPayment` display strings, status default.
- `refreshTenantsView()` — fetch `GET /tenants`, `bindTenantsView(rows)`.
- `bindTenantsView(rows)` — render `#tenantsViewBody` (distinct id from the dashboard's `#tenantsBody`; keep `bindTenants` untouched), client-side search filter (name/segment/unit/status) + client-side pagination (reuse the Units pagination control pattern), empty state.
- Create/Edit modal:
  - Open create: empty form, defaults type=PERSONAL, status=ACTIVE, autoDebit=false.
  - Open edit: prefill from the row. For the **unit dropdown**, populate with assignable units — fetch `GET /units?status=AVAILABLE` (plus the tenant's current unit, which may be OCCUPIED by them) — and remember units listing is paginated; request a high `perPage` or a suitable page. Show unit as unitCode in the dropdown.
  - Submit create → `POST /tenants`; submit edit → `PUT /tenants/:id` (include `unitId` even when unchanged; include null when cleared). Surface server `error.details` in the modal (VALIDATION 400 messages).
  - **Do not invent fields the API doesn't accept** — e.g. no `psf` or `sqft` inputs on edit (server derives); `moveInDate` send as ISO datetime or omit.
- Deactivate: `window.confirm` (consistent with Units) warning: "Deactivate <name>? Their unit (<unitCode>) is released back to AVAILABLE." Then `DELETE /tenants/:id`, refresh, toast/alert on `unitReleased`.

---

## 4. Verification (curl-only)

1. `pnpm check` clean. Frozen files byte-identical (`git diff` empty on `src/cms/dashboard.html`, `src/cms/data-layer.js`).
2. **Baseline first:** capture `GET /tenants` count and `GET /units?status=AVAILABLE&perPage=200` set (expected 8: BM-01-04/08/13/18/23/26, UB-01-01, WD-01-01). Record before/after.
3. Live curl round-trips (auth: `GET /api/cms/config` → `POST /api/cms/login` → Bearer):
   - Create tenant w/ `unitId` of an AVAILABLE unit → 201, unit shows as its unit, psf = rate/sqft.
   - Create tenant w/ `unitId` of an OCCUPIED unit → 400 VALIDATION (Gap 2). Create w/ deleted unit's id → 400.
   - `PUT` reassign the tenant to a different AVAILABLE unit → previous unit returns to AVAILABLE, new unit assigned, psf recomputed.
   - `PUT` set `unitId: null` → unit released to AVAILABLE.
   - `DELETE` → status INACTIVE, unit released, `{ unitReleased: true }`.
   - Reassign onto a tenant that was just deactivated — confirm guard behavior is sane.
4. Verify `GET /units` shows no AVAILABLE strays from your tests; clean up (deactivate any test tenants you created, or reuse a single test tenant and leave it INACTIVE).
5. Confirm dashboard view still renders its tenants table (`#tenantsBody` untouched) — e.g. the shared fetch path in `refreshDashboard` still populates it.

## 5. Delivery

- Return: files changed, backend gap changes, verification results (pnpm check tail, baseline before/after, each curl sample incl. reassignment + guard 400s), any concerns.
- Do NOT commit. Orchestrator commits after review and logs the dispatch.

## Reference

- Units pattern to mirror: `src/cms/admin/dashboard.html` (#view-units) + `admin.js` (switchView, refreshUnitsView, bindUnits, modal handlers, pagination).
- Backend: `src/core/tenants.ts`, `src/routes/cms.ts` (tenant schemas ~lines 205–250).
- Conventions: `AGENTS.md`; `docs/UNIT_DELETION.md` (deletedAt rules); `docs/UNIT_CODE_AND_NAME.md` (code/name display).

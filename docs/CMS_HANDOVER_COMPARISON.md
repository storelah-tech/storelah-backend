# StoreLah CMS — Handover-to-Implementation Comparison

Source: *MySelfStorage / StoreLah — Engineering Handover and Technical Specification* (1 Aug 2026).
Scope: the **Operator dashboard / CMS** portion only (handover §§4, 5, 10, 14, 16, 19).
As of: 4 Aug 2026.

---

## 1. Extracted CMS specification (from handover)

The handover described the operator dashboard as a **static prototype** (`dashboard.html`, `styles.css`) with no backend. Its documented surfaces and intended capabilities were:

| # | Operational area (handover §10) | Intended staff capability | Handover's "actual delivered" verdict |
|---|---|---|---|
| 1 | Overview | Track occupancy, available units, overdue, MRR, PC | Static metric values + local Chart.js |
| 2 | Unit map | Inspect units by size/status, select a unit | Static cell grid; only selection/scroll |
| 3 | Unit management | View tenant, rate, status, payment & access history | Hard-coded sample detail |
| 4 | Rate management | Review historic rate; send notice / apply adjustments | Presentation-only inputs/buttons |
| 5 | Tenants | Search/manage accounts & payments | Static sample table; no search |
| 6 | Leads CRM | Track leads through enquiry-to-win stages | Static Kanban; no creation/assignment |
| 7 | Payments / action centre | Chase overdue, schedule move-ins, flag rate reviews | Static list; no operational action |

Handover verdict (§10, §19): the dashboard had *no login, no RBAC, no tenant isolation, no audit logging, no exports, no query layer, no reporting-correctness guarantees, no payment/access integration*, and was "not safe to expose as an internal production tool" in its supplied form.

### Handover-prescribed future state (§16 domain model, §14 risks)
- Facilities/inventory, pricing & commerce, customers, tenancy, billing, access, customer service, reporting domains.
- P1 risk items: no live inventory/reservation model, no PII controls, no formal business/tenant model, no audit.
- P2: no tests/CI, monolithic page, duplicated prototype code.

---

## 2. Implementation status matrix

### Rewritten stack (differs from handover prototype)
| Layer | Handover prototype | Current implementation |
|---|---|---|
| Frontend | React/Vite detached + static HTML | Static `dashboard.html` + Chart.js (frozen) |
| Backend | Declared only (absent) | Express 5, thin routes, `src/core/*` aggregates |
| Data | Declared only (Drizzle/MySQL absent) | Prisma 6 + PostgreSQL (port 5433) |
| API contract | None | Envelope `{ data, meta }` / `{ error }` via `src/lib/http.ts` |
| Auth | None | Bearer JWT via `src/middleware/auth.ts` |

### Capability-by-capability status
| Surface (handover §10) | Backend implemented | UI bound in `data-layer.js` |
|---|---|---|
| 1 Overview KPIs | ✅ `GET /summary` (`core/summary.ts`) | ✅ KPIs + revenue/branch charts |
| 2 Unit map | ✅ `GET /units/map` (`core/units.ts`) | ✅ BM Level 1 cells re-synced |
| 3 Unit management | ⚠️ `GET /units/:code` exists | ❌ detail panel static |
| 4 Rate management | ✅ `POST /units/:code/rate` (`core/rates.ts`) | ❌ no POST call in data layer |
| 5 Tenants | ✅ `GET /tenants` (`core/tenants.ts`) | ✅ table bound |
| 6 Leads CRM | ✅ `GET /leads` (`core/leads.ts`) | ✅ Kanban bound |
| 7 Action centre | ✅ `GET /action-items` (`core/actionCenter.ts`) | ✅ alerts bound |
| Bookings | ✅ `GET /bookings` (`core/finance.ts`) | ❌ |
| Move-ins | ✅ `GET /move-ins` (`core/branches.ts`) | ❌ |
| Invoices | ✅ `GET /invoices` | ❌ |
| Branches | ✅ `GET /branches` | ❌ |
| PSF / Revenue-by-size charts | ✅ data in `GET /summary` | ❌ static in HTML |

### CRUD status (added 4 Aug 2026)
| Entity | Endpoints | Status |
|---|---|---|
| Promotions | `GET/POST /promotions`, `GET/PUT/DELETE /promotions/:id` | ✅ `core/promotions.ts` |
| Units | `GET/POST /units`, `PUT/DELETE /units/:code`, auto-codegen | ✅ `core/units.ts` |
| Tenants | `GET/POST /tenants`, `PUT/DELETE /tenants/:id`, releases unit on soft-delete | ✅ `core/tenants.ts` |

Legend: ✅ done · ⚠️ partial · ❌ not done / not bound

### Handover risk register (§14) → current state
| Handover risk | Current status |
|---|---|
| No login | ✅ Fixed — JWT required on all routes except `/login`, `/config` |
| No RBAC | ⚠️ `Role` enum (OWNER/MANAGER/VIEWER) exists but is **not enforced** |
| No tenant isolation | ✅ N/A for single-operator CMS (no multi-tenant data scoping) |
| No audit logging | ❌ None |
| No exports / reporting correctness | ❌ None |
| No tests/CI | ⚠️ `pnpm check` (typecheck) host; no test/lint suite |
| Payment/access integration | ❌ Out of scope (no real payment/access systems) |

---

## 3. Gaps

**Read-only vs write.** Only `POST /units/:code/rate` mutated originally. As of 4 Aug 2026, **promotions, units, and tenants have full create/update/soft-delete**; bookings, invoices, leads, and branches remain read-only.

**Unbound panels.** Unit detail + rate rate-history table, rate-adjustment form (no `POST` ever sent), PSF/revenue-by-size charts, booking/invoice/move-in/branch surfaces have backend data but no data-layer bindings. CRUD endpoints exist but are not yet wired to the UI (API-only per scope decision).

**Remaining aggregates.** Bookings, invoices, leads, and branches have no CRUD. Promotions now have a backing model.

**No RBAC enforcement.** `Role` on `AdminUser` is unused; every authed user can reach every route.

**No audit trail.** Mutating operations (rate changes, etc.) are not logged beyond `RateChange`.

**No exports / reports.** "Export" buttons in the HTML are static.

---

## 4. Suggested next steps

1. ~~**API-first CRUD** — units, tenants, promotions~~ ✅ Done 4 Aug 2026: `Promotion` model, `POST/PUT/DELETE` endpoints, zod-validated, JWT-protected, envelope responses, status-based soft delete (`INACTIVE`). Remaining: CRUD for bookings, invoices, leads, branches.
2. **Bind remaining panels in `data-layer.js`** — unit detail + rate history, rate adjustment submit, booking/move-in/invoice/branch lists, PSF/revenue-by-size charts. Keep `dashboard.html` frozen; modals/forms built at runtime from `data-layer.js`.
3. **Enforce RBAC** — an `requireRole(...)` middleware layered on `requireAuth`, mapping `Role` → permitted CRUD (e.g. `VIEWER` read-only, `OWNER` deletes).
4. **Add audit logging** — an `AuditEvent` model recording mutating actions (actor, action, entity, diff, timestamp); log in transaction with the originating write.
5. **Exports/reports** — CSV/snapshot exports from list endpoints; ideally derived from authoritative queries.

---

*Keep this file in sync with the codebase; the status matrix section will drift as CRUD and bindings land.*
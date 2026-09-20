# Move-in E2E Test Plan (backend side)

Covers: **user rents a unit → persisted in backend DB → visible via portal,
using the real floor-plan layout**. Implemented in `tests/e2e/`; run with
`pnpm test:e2e` (vitest, supertest, tsx-adjacent — all dev-only, additive).

## Contracts under test (stable — storelah-booking consumes these)

- `GET /api/v1/public/units?branch=&level=&status=` → `{ data: units, meta }`
- `GET /api/v1/public/floor-plans/:branchCode/:level` → `{ data: { branch, floor, plan | null } }`
  (`plan: null` with 200 when the floor has no authored plan)
- `POST /api/v1/customer/register | /login` → `{ data: { token, customer } }`
- `POST /api/v1/customer/bookings` (Bearer, or guest with flat `email`) → 201 `{ data: { bookingRef, status: PENDING_PAYMENT, unit, … } }`
- `GET /api/v1/customer/portal | /bookings` (Bearer) → `{ data: … }`
- Errors: `{ error: { code, message } }` with `VALIDATION` / `UNAUTHORIZED` / `NOT_FOUND` / `CONFLICT`.

Any change to these shapes needs cross-app coordination — do not silently alter.

## Isolation

- Dedicated DB `storelah_test` via `DATABASE_URL_TEST` (see `tests/e2e/test-db.ts`).
- `global-setup.ts` creates the DB if missing and runs `prisma migrate deploy` against it.
- `setup.ts` repoints `DATABASE_URL` per worker **before** `src/*` is imported.
- `assertSafeTestDb()` refuses any DB name not ending in `_test` before migrate/truncate.
- NEVER run `pnpm db:seed` against dev for this suite; the suite never connects to dev.

## Fixtures (`tests/e2e/fixtures.ts`)

Pinned world per test (after full truncate): branch `BM`, floor L1 (authored
70×80 ft plan, 5×10 ft placements for every non-deleted unit) + plan-less floor
L2, units `BM-01-01` (rentable) / `BM-01-02` (guest) / `BM-01-03` OCCUPIED /
`BM-01-04` BLOCKED / `BM-01-05` soft-deleted / `BM-01-06` MAINTENANCE.
Emails are `e2e+<uuid>@test.local`.

## Suites

1. `move-in-happy-path.test.ts` (2 tests) — public listing contains the
   rentable unit (and hides deleted/non-browseable); plan contains its live
   placement; register→login→token; authed booking → 201 PENDING_PAYMENT;
   DB asserts (unique bookingRef, Tenant email linkage, DUE invoice > 0,
   unit → RESERVED); portal + bookings show the unit.
2. `move-in-guest.test.ts` (1 test) — guest checkout provisions GUEST,
   persists Tenant/Invoice/RESERVED, claim rotates to PERSONAL, login works,
   portal shows the unit.
3. `move-in-edges.test.ts` (11 tests) — second-user double-book → 409 + single
   booking row; OCCUPIED/BLOCKED/MAINTENANCE → 409; soft-deleted → 404 (guard
   in `createCustomerBooking`, per `docs/UNIT_DELETION.md`); missing unit →
   404; bad payload / guest-no-email → 400; missing/garbage token → 401 and an
   invalid token on booking is a hard 401 with zero rows written (never guest
   fallback); duplicate register → 409; plan-less floor → 200 `plan: null`;
   unknown branch/level → 404, invalid level → 400.

## How to run

```
DATABASE_URL_TEST="postgresql://storelah:storelah@localhost:5433/storelah_test?schema=public" pnpm test:e2e
# (defaults to the URL above when unset)
pnpm check   # must still pass; tests/ is outside tsconfig so check is unaffected
```

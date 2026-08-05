# StoreLah CMS

Operator dashboard backend & app for StoreLah self-storage. Express 5 + Prisma 6 + PostgreSQL + TypeScript, serving the original frozen dashboard UI city.

## Quick start

```bash
# 1. Configure env (fill DATABASE_URL, JWT_SECRET)
cp .env.example .env

# 2. Migrate & seed (seeding is destructive — wipes tables first)
pnpm db:migrate
pnpm db:seed

# 3. Run
pnpm dev            # hot reload  OR  pnpm build && pnpm start
```

Open <http://localhost:4000> — the dashboard auto-binds live data via `data-layer.js`.
Default admin: `admin@storelah.sg` / `password`.

## Scripts (`pnpm`)

| Command | Description |
| --- | --- |
| `dev` | `tsx watch src/index.ts` (hot reload) |
| `start` | run compiled `dist/src/index.js` |
| `build` | `tsc` **then** copy `src/cms` → `dist/src/cms` (required, or UI is missing) |
| `check` | typecheck (`tsc --noEmit`); the primary verification (no lint/test scripts) |
| `db:migrate` / `db:deploy` | apply dev / deployment migrations |
| `db:seed` | wipe + reseed demo data |
| `db:studio` | Prisma Studio |

## Architecture

- **Entry** `src/index.ts` — Express app, mounts API + static dashboard, global error middleware.
- **API** `src/routes/cms.ts` — thin handlers: validate, call a core function, respond via envelope.
- **Domain** `src/core/` — aggregate functions produce the dashboard payloads (`summary`, `units`, `tenants`, `leads`, `finance`, `branches`, `actionCenter`, `rates`, `market`).
- **lib/** — `prisma.ts` (client), `config.ts` (env), `http.ts` (envelope + `AppError` + `errorHandler`), `format.ts` (`toNum`/`pct`).
- **auth** `src/middleware/auth.ts` — Bearer JWT (`requireAuth`, `signToken`).
- **data** `prisma/schema.prisma` — 10 models; migrations under `prisma/migrations/`.
- **UI** `src/cms/dashboard.html` (layout/CSS frozen) + `src/cms/data-layer.js` (live bindings).

### Response contract

- Success: `{ "data": <payload>, "meta"?: { count, ... } }`
- Error: `{ "error": { "code", "message", "details"? } }` (4xx/5xx via `errorHandler`)
- Auth: `Authorization: Bearer <token>` (JWT, from `POST /login`)

## API spec (base `/api/v1/cms`)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/login` | `{ email, password }` → `{ token, user }` |
| GET | `/summary` | KPIs, monthly revenue, occupancy by branch, revenue by size |
| GET | `/units/map?branch=BM&level=1` | unit-map grid + legend for a floor |
| GET | `/units/:code` | unit detail + tenant + rate history |
| POST | `/units/:code/rate` | `{ newRate, effectiveDate?, reason? }` — create a `RateChange` & update |
| GET | `/tenants` | list of tenants (with unit/size/rate/status) |
| GET | `/leads` | kanban columns by stage |
| GET | `/bookings` | list of bookings |
| GET | `/invoices?status=DUE\|PAID\|OVERDUE` | invoices, optional status filter |
| GET | `/branches` | branches with floors + counts |
| GET | `/move-ins` | bookings with move-in today |
| GET | `/action-items` | action-centre items (overdue, due-tomorrow, below-market) |

`/api/cms/*` is a legacy alias for the same router.

## Constraints

- Do **not** edit the dashboard layout/CSS in `src/cms/dashboard.html` — only add bindings in `data-layer.js`.
- Recomputed values come back as `Prisma.Decimal`; return them through `toNum` from `src/lib/format.ts` (JSON-stringify a `Decimal` throws).
- Keep schema enums as Prisma enums (see `prisma/schema.prisma`).
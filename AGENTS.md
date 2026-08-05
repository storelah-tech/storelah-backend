# AGENTS.md

StoreLah operator CMS backend & dashboard. Express 5 + Prisma 6 + PostgreSQL, TypeScript, served dashboard UI.

## Commands

- Package manager is **pnpm** (pinned `pnpm@10.4.1`, corepack). Do not use npm/yarn.
- `pnpm dev` — run with hot reload (`tsx watch src/index.ts`).
- `pnpm check` — typecheck only (`tsc --noEmit`). This is the primary verification; there is **no lint or test script** in this repo.
- `pnpm build` — `tsc` **then** `cp -R src/cms dist/src/cms`. The second step is required: `index.ts` serves `src/cms` statically via `__dirname`, so a build that omits it produces a dashboard-less `dist`.
- `pnpm start` — runs the compiled `dist/src/index.js`; requires `pnpm build` first.
- Prisma: `pnpm db:migrate` (dev), `pnpm db:deploy`, `pnpm db:seed`, `pnpm db:studio`.

## Setup

- `.env` is required and gitignored; copy `.env.example`. Key points: `DATABASE_URL` points to Postgres on **port 5433** (non-default; not managed by any docker-compose in this repo), `JWT_SECRET`, `PORT=4000`.
- Run `pnpm db:migrate` then `pnpm db:seed`.

## Architecture

- Entry: `src/index.ts`. Express 5 app; all API under **`/api/v1/cms`** (`src/routes/cms.ts`). `/api/cms` is kept as a legacy alias — do not add new routes there.
- **Business logic lives in `src/core/`** (one module per aggregate: `summary`, `units`, `tenants`, `leads`, `finance`, `branches`, `actionCenter`, `rates`, `market`). Routes stay thin: parse/validate, call a `src/core` function, respond. Keep new aggregates there, not in the route file.
- **Responses use an envelope** via `src/lib/http.ts`: `ok(res, data, meta?)` → `{ data, meta }`; errors handled by `errorHandler` middleware → `{ error: { code, message, details? } }`. Use `created()` for 201 and `AppError`/`fail()` for errors. Do not `res.json` ad-hoc.
- **Auth is a Bearer JWT in the `Authorization` header**, not a cookie (`src/middleware/auth.ts`, `requireAuth`). `cookie-parser` is configured but not used for auth. Preserve this contract on any new routes.
- The dashboard auto-logs-in via `GET /api/cms/config`, which returns admin creds read from env (`STORELAH_ADMIN_EMAIL` / `STORELAH_ADMIN_PASSWORD`, see `.env.example`). No credentials are hardcoded client-side.


## Conventions / constraints

- The dashboard `src/cms/dashboard.html` layout/CSS is **frozen and immutable** — only add data bindings in `src/cms/data-layer.js`. Do not restyle or restructure the HTML.
- Decimal columns come back as `Prisma.Decimal`; pass them through `toNum` from `src/lib/format.ts` before returning in an API response (JSON.stringify of a Decimal throws).
- Schema enums (Role, UnitStatus, TenantStatus, etc.) are Prisma enums (see `prisma/schema.prisma`). Keep them as enums; do not reinterpret as string unions.
- `pnpm db:seed` wipes and recreates all tables before seeding, so it is destructive by design.
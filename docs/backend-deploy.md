# Deepwork — storelah-backend AWS Deployment (Lambda + API Gateway)

## Goal

Deploy the StoreLah **backend API** (`storelah-backend/`, Express 5 + Prisma 6 + PostgreSQL)
to AWS **Lambda (Node 20) + API Gateway** behind the custom domain `api.storelah.sg`. This
runbook is the handoff for the next session — devops-agent executes Phase 0–C against it
(user/decision actions marked `[USER]` / `[BLOCKING]`, devops-owned steps marked `[devops]`,
code changes marked `[backend-agent]`). Landing is done; booking is waiting on THIS session
(Option A — backend first, then booking).

## STATUS: BACKEND IS LIVE (verified 2026-08-13) — booking gate CLEARED; ONE security discrepancy remains

- **Landing is LIVE:** `https://storelah.sg` + `https://www.storelah.sg` via CloudFront +
  Route 53 (zone `storelah-dns`). Cross-ref: `storelah-landing/docs/DEPLOYMENT.md`.
- **Backend: DEPLOYED and LIVE (re-verified 2026-08-13 from public DNS/curl — no AWS creds
  available for console checks).** `api.storelah.sg` and `cms.storelah.sg` both resolve to
  API Gateway regional endpoints in ap-southeast-1 and serve HTTPS with valid ACM certs:
  - `https://api.storelah.sg/health` → `{ ok: true, service: 'storelah-cms', time }`
  - `https://api.storelah.sg/api/v1/public/branches` → seeded Neon rows (BM/UB/WD) —
    **confirms Prisma reached Neon through the pooled URL and the cloud DB was seeded**
  - `https://api.storelah.sg/` and `/admin` → 200 CMS dashboard; `cms.storelah.sg/` → 200
  - `POST /api/v1/cms/login` with the env-configured admin pair → 200 (admin user exists in Neon)
  - All four ACM validation CNAMEs (apex, www, api, cms) resolve in DNS; MX/NS intact.
  **A full Phase C admin-flow re-run with a Bearer token remains pending (blocked on AWS
  creds), and the item below must be fixed first.**
- **⚠ SECURITY DISCREPANCY — FIX READY (2026-08-13):** `GET https://api.storelah.sg/api/v1/
  cms/config` was returning **HTTP 200 with the admin email + plaintext password** on the
  PUBLIC api host — the original Phase 0 step 4 gate (404 on the api host when
  `NODE_ENV=production`, added in commit `294f4da`) was NOT active on the live function
  (Lambda deployed from an earlier build and/or `NODE_ENV=production` unset at runtime).
  **The gate is now hardened and no longer depends on `NODE_ENV`:** `/config` 404s on ANY
  api-kind host (`api.storelah.sg`, the raw execute-api invoke URL, forged/unknown hosts) on
  both `/api/v1/cms/config` AND the legacy `/api/cms/config`, unconditionally — only
  `cms.storelah.sg` and local dev (`localhost`/loopback) still get the creds. A live Lambda
  with this build can NEVER leak `/config` even if `NODE_ENV` is missing. Remediation for
  the live deploy: rebuild from `origin/main`, set `NODE_ENV=production` +
  `API_HOST_SERVES_UI=0`, redeploy, then re-verify `/config` 404s on the api host
  (verification below). Because the password was publicly readable, **rotate it now**:
  set a NEW `STORELAH_ADMIN_PASSWORD` in the Lambda env AND update the seeded AdminUser row
  to match WITHOUT re-running `db:seed` — exact steps in the **PASSWORD ROTATION** block
  below.
- **🔑 PASSWORD ROTATION — devops-agent one-shot (do NOT re-run `db:seed`):** the seeded
  AdminUser row in Neon must be re-hashed to the NEW password. Backend-agent shipped
  `scripts/rotate-admin-password.ts` (`pnpm db:rotate-admin-password`) — a safe one-shot
  updater that bcrypt-hashes `STORELAH_ADMIN_PASSWORD` and UPDATEs the existing AdminUser
  row (targeted by `STORELAH_ADMIN_EMAIL`, default `admin@storelah.sg`); it never prints
  the password, refuses placeholders/short values, and fails cleanly if no row matches.
  1. Pick a strong NEW value (16+ random chars). Set it as the Lambda env var
     **`STORELAH_ADMIN_PASSWORD`** (keep `STORELAH_ADMIN_EMAIL=admin@storelah.sg`).
  2. From a deployer machine with the repo checked out, run (with the NEW value inline —
     the **DIRECT** Neon URL, same convention as migrations/seed):
     ```bash
     DATABASE_URL="$NEON_DIRECT_URL" \
       STORELAH_ADMIN_EMAIL=admin@storelah.sg \
       STORELAH_ADMIN_PASSWORD=<NEW-VALUE> \
       pnpm db:rotate-admin-password
     ```
     Expected output: `updated password hash for AdminUser "admin@storelah.sg" (1 row) — no
     re-seed performed.` Anything else = DO NOT proceed; investigate first.
  3. Redeploy/update the Lambda env so the new value is live, then verify:
     - `POST /api/v1/cms/login` with email + NEW password → 200 `{ data: { token, ... } }`
     - `POST /api/v1/cms/login` with old password → 401
     - the old plaintext password is NOT accepted anywhere (it was public).
  ⚠ Order note: because `/config` serves the SAME env var, the cms-host dashboard auto-login
  keeps working automatically once the new env var is live — no dashboard change needed.
- **Verifying the gate after redeploy:** on the production Lambda —
  ```bash
  curl -si https://api.storelah.sg/api/v1/cms/config | head -1          # expect HTTP/2 404
  curl -si https://api.storelah.sg/api/cms/config  | head -1            # legacy alias: 404
  curl -si https://cms.storelah.sg/api/cms/config  | head -1            # expect 200
  ```
  (the first two must 404 regardless of `NODE_ENV`; the third returns `{"email","password"}`,
  which is the dashboard auto-login on its own host).
- **Ordering decision RESOLVED (2026-08-10): user chose Option A — backend first, then
  booking.** Booking's `NEXT_PUBLIC_API_URL` = `https://api.storelah.sg`; the backend is live,
  so the booking gate is CLEARED (see `storelah-booking/docs/booking-deploy.md`, updated
  `6014c4a`). Booking now only needs its own Amplify deploy + DNS (Phases A/B).
- **Database decision RESOLVED (2026-08-10): NEON FREE** (serverless Postgres, Phase 0 step 1)
  — the former BLOCKING prerequisite is cleared and confirmed working live (seeded rows served
  via the pooled URL). Lambda reaches Neon over the public internet (no VPC, no NAT). Local
  Docker DB on port 5433 remains dev-only.

## Confirmed facts (orchestrator-verified, 2026-08-10)

- **Stack:** Express `5.1.0`, Prisma `6.5.0` (`@prisma/client` + `prisma` CLI), TypeScript
  `5.6.3`, zod 4, jsonwebtoken, bcryptjs, cors, cookie-parser, dotenv; pnpm `10.4.1`
  (corepack, pinned via `packageManager`). Local `@types/node` is 24 — the **Lambda runtime
  target is Node 20** (per approved architecture).
- **Scripts:** `dev` (tsx watch), `start` (`node dist/src/index.js`), `build` (`tsc` **then**
  `rm -rf dist/src/cms && cp -R src/cms dist/src/cms` — REQUIRED: `index.ts` serves the
  dashboard statically via `__dirname`), `check` (`tsc --noEmit` — **the ONLY quality gate;
  there is NO lint or test script**), `db:migrate` / `db:deploy` / `db:seed` / `db:studio`.
  `db:seed` wipes + recreates all tables (destructive by design).
- **Entry `src/index.ts`:** Express 5 app — `GET /health`; `/api/v1/cms` (admin, Bearer JWT
  via `src/middleware/auth.ts` `requireAuth`) **plus legacy `/api/cms` alias** (do NOT add
  new routes there); `/api/v1/public`; `/api/v1/customer`; static CMS UI at `/admin` →
  `path.join(__dirname,'cms','admin','dashboard.html')`, `express.static(__dirname/cms)`,
  `/` → `dashboard.html`; 404 handler + `errorHandler`. **Ends with `app.listen(config.port)`
  — this must be adapted for Lambda (Phase 0 step 2).**
- **Response envelope:** `src/lib/http.ts` — `ok()` → `{ data, meta? }`, errors →
  `{ error: { code, message, details? } }`.
- **Admin auth:** `POST /api/v1/cms/login` (email+password → `{ token, user }`) and
  `GET /api/v1/cms/config` which returns **`{ email, password }` read straight from env**
  (dashboard auto-login; 503 if unset). **⚠ SECURITY FLAG — see Phase 0 step 4.**
- **Env vars (`.env.example`):** `PORT=4000`, `NODE_ENV`, `DATABASE_URL`
  (`postgresql://storelah:storelah@localhost:5433/storelah?schema=public` — **localhost, dev
  only**), `JWT_SECRET` ("change-me-in-production"), `JWT_EXPIRES_IN=12h`,
  `STORELAH_ADMIN_EMAIL=admin@storelah.sg`, `STORELAH_ADMIN_PASSWORD`. `.env` exists locally,
  gitignored. `src/lib/config.ts` reads them via `dotenv.config()` (a no-op when no `.env`
  exists — Lambda env vars take over).
- **Prisma migrations (7):** `20260803091218_init`, `..._unit_rate`,
  `..._add_promotions_crud`, `20260804120000_customer_auth`, `20260806120000_add_crud_timestamps`,
  `20260806150000_add_unit_name`, `20260806160000_add_unit_deleted_at`.
- **Client singleton:** `src/lib/prisma.ts` keeps one `PrismaClient` per process — correct
  for Lambda (one client per warm container; never create one per request).
- **git: repo `storelah-tech/storelah-backend` on `main`, remote configured, fully pushed
  (`origin/main` == `HEAD`, currently 294f4da), working tree clean. `.env` is gitignored and
  never pushed. All prior "no remote / four uncommitted files / stale dist" notes are
  obsolete — a fresh `pnpm build` was verified passing on 2026-08-13 (see commit below).
  NOTE: `origin/main` was at `294f4da` (the `/config` gate + env-driven seed); the live
  Lambda behaves as if deployed from an EARLIER build / without prod env vars — see the
  security discrepancy in the STATUS block above. **Follow-up commit (2026-08-13, live-action
  security session):** `/config` gate hardened to be **host-kind-based and unconditional**
  (no `NODE_ENV` dependency) + new one-shot `pnpm db:rotate-admin-password`
  (`scripts/rotate-admin-password.ts`) for rotating the seeded AdminUser hash without
  re-seeding — see the PASSWORD ROTATION block in the STATUS section.

## Why Lambda + API Gateway (and not Amplify / EC2 / a long-running container)

| Piece | Choice | Why |
|---|---|---|
| Compute | **AWS Lambda** (Node 20 runtime) | Express app is request-driven and stateless; fits Lambda's model. Free tier 1M req/mo + 400K GB-s. Cold starts 1–3 s are acceptable for MVP. No 24/7 server cost. |
| Entry | **serverless-http adapter** (`export const handler = serverless(app)`) | Standard Express-on-Lambda bridge; framework-agnostic (works with Express 5). **Code change owned by backend-agent** (Phase 0 step 2) — devops does NOT edit `src/`. |
| Front door | **API Gateway — HTTP API** (recommended) | Cheapest API Gateway flavor (~$1.00/M req after free tier vs REST API ~$3.50/M); has Lambda proxy + custom domains + CORS. The whole Express app mounts under one route. |
| Database | **Neon Free** (serverless Postgres, primary region `aws-ap-southeast-1`) — RESOLVED 2026-08-10 | External SaaS; Lambda reaches it over public internet (pooled URL, TLS); no VPC needed. `localhost:5433` is dev-only. |
| DNS | `api.storelah.sg` CNAME in the existing `storelah-dns` stack | Same zone as landing/booking; the exact CNAME record is now the sole resolution — the `*.storelah.sg` wildcard has been deleted, so there is no wildcard to shadow and no fallback. |
| CI/CD | **None for MVP** | Deploy via CLI (landing's manual-flow style). A CloudFormation template `infra/backend-stack.yaml` is a recommended future devops deliverable (Phase 0 step 3). |

## Target architecture (approved)

```
Booking (Amplify, server-side proxy — no browser CORS)
   └─> https://api.storelah.sg  (Route 53 CNAME in storelah-dns stack)
          └─> API Gateway HTTP API (custom domain, regional, ap-southeast-1)
                 └─> $default route → Lambda proxy (payload 2.0)
                        └─> Express 5 (serverless-http) on Node 20
                               ├─ /api/v1/public   (branches, units, units/map, promotions)
                               ├─ /api/v1/customer (register/login/me/bookings/portal/requests/notice)
                               ├─ /api/v1/cms      (admin, Bearer JWT) + legacy /api/cms
                               ├─ /admin, /        (static CMS dashboard from dist/src/cms)
                               └─ /health
                               
Database (Neon Free, serverless Postgres) ← PrismaClient (one per warm container)
```

| Piece | Choice | Cost basis |
|---|---|---|
| Runtime | Lambda Node 20.x, ~256 MB, timeout 30 s, handler `dist/src/index.handler` | free tier 1M req/mo |
| API front door | HTTP API, `$default` route → `AWS_PROXY` integration | free tier 1M req/mo |
| Custom domain | `api.storelah.sg`, ACM cert in **ap-southeast-1** (gotcha — see Phase B) | ACM free |
| Bundle | `dist/` (compiled + copied `src/cms`) + prod `node_modules` + Prisma engines | free |
| Database | **Neon Free** (serverless Postgres, pooled URL at runtime) | $0/mo (free tier: 0.5 GB storage, 190 compute-h/mo) |
| CI/CD | none for MVP; CLI deploy documented; `infra/backend-stack.yaml` recommended later | free |

## Phase 0 — Prerequisites [USER blocks; devops assists]

### 1. Database decision — **RESOLVED (2026-08-10): NEON FREE** [USER]

**The user chose Neon Free** (serverless Postgres, scale-to-zero) on 2026-08-10. Rationale:
$0/mo; built for Lambda — no VPC → no NAT gateway (≈ $32/mo avoided); pooled connection
string; TLS built in. Tradeoffs accepted: data resides outside AWS (SG data-residency flag),
0.5 GB storage limit, 190 compute-hrs/mo, and the DB pauses after ~5 min idle. The local
Docker DB on `localhost:5433` remains dev-only (`prisma migrate deploy` runs against the CLOUD
DB during Phase A, not the local one).

The comparison below is kept as **context only** (considered but not chosen):

| Option | Setup effort | Cost | Ops / caveats | Fit for MVP |
|---|---|---|---|---|
| **AWS RDS PostgreSQL** (ap-southeast-1, e.g. `db.t3.micro`/`db.t4g.micro`) | Medium (IaC-able) | Free tier ~750 h/mo for 12 mo, then ~$13–20/mo + storage + backups | Managed backups/HA. **Networking gotcha:** Lambda has no fixed egress IP — either deploy the Lambda in the same VPC (needs a NAT gateway ≈ $32/mo for internet egress, or no internet at all if the app never calls out) or make RDS publicly accessible with a security-group-restricted 5432 (security tradeoff). **RDS Proxy** adds cost. Simplest MVP path = public endpoint + tight SG, flagged for tightening later. | Good if you want everything in AWS — **NOT chosen** |
| **Neon (serverless Postgres)** | Low (connection string, no VPC) | Free tier ~0.5 GB / 190 compute-h/mo, pauses on idle | Pooled connection string built for Lambda; TLS built in; no VPC needed. Data sits outside AWS region (SG data-residency flag). | **Easiest Lambda fit — CHOSEN 2026-08-10** |
| **Supabase Postgres** | Low | Free tier 500 MB, pauses after 7 d inactivity | Same "external" tradeoffs as Neon; adds auth/storage extras you don't need yet. | Easy — **NOT chosen** |
| **Keep local Docker + tunnel** (Tailscale/ngrok/SSH) | Low | $0 | **Not production-grade** — flaky, not for a public API; document as a last resort only. | ❌ — **NOT chosen** |

#### Neon setup (user/console step — do it now or at the start of the deploy session)

- Create the project at neon.tech: plan **Free**; primary region **Singapore
  (`aws-ap-southeast-1`)** — offered as the "Primary region" choice at project creation.
  Matching the app region keeps latency lowest.
- The Neon dashboard shows **two connection strings** for the same database: a **pooled**
  endpoint (host contains `-pooler.neon.tech`) and a **direct** endpoint (same host without
  `-pooler`). Copy both.
- **Runtime (Lambda/Prisma):** use the **POOLED** URL for the Lambda's `DATABASE_URL` env
  var. Recommended Prisma params:
  `postgres://<user>:<password>@<project>-pooler.neon.tech/<db>?sslmode=require&pgbouncer=true&connection_limit=1`
  — `pgbouncer=true` routes Prisma through Neon's pgBouncer-compatible pooler (avoids
  exhausting Neon Free's 10-connection limit from concurrent Lambdas); `connection_limit=1`
  is what Prisma recommends for serverless; `sslmode=require` for TLS.
- **Migrations (`prisma migrate deploy`):** use the **DIRECT** (non-pooled) URL — same DB,
  just a different connection string for the deploy step. `pgbouncer=true` breaks
  DDL/migrations, so never run migrations against the pooled endpoint.
- **Scale-to-zero:** the compute pauses after ~5 min idle; the first connection after idle
  wakes it (a few hundred ms extra latency on the first call) — acceptable for MVP; see the
  Phase C cold-start note.
- **Free-plan limits to watch:** **0.5 GB storage** (seed data is small — fine for MVP),
  **190 compute-hrs/mo** (scale-to-zero keeps this low; an always-busy app would exhaust it in
  ~8 days — escalation: Neon Launch $19/mo if traffic grows). No credit card needed to start;
  no API keys required — the connection string is all you need.

- `DATABASE_URL` for the Lambda runtime = the **pooled** Neon URL (above). The **direct**
  URL is for the one-shot `prisma migrate deploy` only (Phase A step 4).
- `pnpm db:seed` is destructive (wipes tables) — NEVER run it against the cloud DB.

### 2. Lambda adapter code change — `[backend-agent]` dispatch (devops coordinates, does NOT edit)

`src/index.ts` ends with `app.listen(config.port, ...)` — Lambda needs an exported handler
instead. Dispatch to backend-agent:

```ts
import serverless from 'serverless-http';
// ... existing app setup ...
export const handler = serverless(app);
// local dev only: keep app.listen behind a guard, e.g.
//   if (!process.env.AWS_LAMBDA_FUNCTION_NAME) app.listen(config.port, ...)
```

- Add runtime dep: `serverless-http` (must be inside the Lambda bundle — see Phase A).
  Works with Express 5 (framework-agnostic). Handles API Gateway payload 1.0 AND 2.0.
- **⚠ `__dirname` static-CMS caveat (flag explicitly):** `index.ts` serves the dashboard via
  `path.join(__dirname, 'cms', ...)` and `express.static(path.join(__dirname, 'cms'))`. Under
  Lambda the bundle layout must keep the copied `dist/src/cms` **beside `dist/src/index.js`**
  (zip layout in Phase A does this). If backend-agent restructures the entry file (e.g.
  moves the app to `src/app.ts`), the relative `cms` path MUST be re-derived accordingly —
  otherwise `/admin` and `/` 404. Coordinate this with backend-agent before Phase A.
- **Guard `app.listen`:** if the process binds a port in Lambda, the handler never returns
  cleanly / the invocation hangs. The guard above is the standard pattern.

### 3. Create + push the GitHub repo — `[USER]` creates; `[devops]` assists `[USER]` blocks

- Create **`storelah-tech/storelah-backend`** (empty, **private**, NO README/license/
  .gitignore seed — the repo already has history on `main`; a seed README would force a
  merge). Same `storelah-tech` identity as landing + booking.
- **Before pushing, commit the FOUR uncommitted files** (`src/cms/admin/admin.js`,
  `src/cms/admin/dashboard.html`, `src/core/tenants.ts`, `src/routes/cms.ts`) plus `docs/`
  (this runbook). Confirm `git status` shows no `.env` (gitignored — never push it).
- Push via the `github-storelah` SSH alias (from `~/.ssh/config` — same as landing/booking):
  ```bash
  git -C /Users/apple/Documents/Projects/StoreLah/storelah-backend add -A
  git -C /Users/apple/Documents/Projects/StoreLah/storelah-backend commit -m "docs: add backend deployment runbook"
  git remote add origin git@github-storelah:storelah-tech/storelah-backend.git
  git push -u origin main
  ```
- **No CI workflow needed** — Lambda deploy is CLI/console-driven (landing-style manual flow).
  **Recommended future devops deliverable:** a CloudFormation template
  `infra/backend-stack.yaml` (Lambda + HTTP API + stage + custom domain + record set) so the
  whole backend is IaC like the landing stack — document but do NOT build in this session.

### 4. Confirm the env var plan — `[USER]` provides values; never committed

Stored as **Lambda function env vars** (simplest for MVP) or **AWS Secrets Manager** (when
credentials rotate / audit is needed — reading Secrets Manager at cold start adds latency and
needs a code change; defer unless asked):

| Var | Value | Notes |
|---|---|---|
| `DATABASE_URL` | **pooled Neon URL** — with `?sslmode=require&pgbouncer=true&connection_limit=1` | reachable from Lambda (NOT localhost). The **direct** URL is for migrations only (Phase A step 4) |
| `JWT_SECRET` | strong random value | never reuse the `.env.example` placeholder |
| `JWT_EXPIRES_IN` | `12h` (or chosen) | |
| `STORELAH_ADMIN_EMAIL` | `admin@storelah.sg` | |
| `STORELAH_ADMIN_PASSWORD` | strong value | **⚠ security — see flag below** |
| `NODE_ENV` | `production` | `config.isProd` + Prisma global-cache behavior key off this |
| `PORT` | not needed under Lambda | harmless if set; adapter doesn't use it |

- **✅ SECURITY FLAG — RESOLVED (2026-08-13, backend-agent commit):** `GET /api/v1/cms/config`
  used to return **`{ email, password }` in plaintext from env** to anyone. It is now gated
  **by host kind, unconditionally (not `NODE_ENV`-dependent):** the **api host
  (api.storelah.sg and the raw execute-api invoke URL) returns 404** for `/config` (both
  `/api/v1/cms` and the legacy `/api/cms`) in every environment; only the **cms host
  (cms.storelah.sg) and local dev** (`localhost`/loopback) still get the creds, so the CMS
  dashboard auto-login keeps working on its own host and locally. Booking never calls
  `/config`. ⚠ Pair with `API_HOST_SERVES_UI=0` on the api host in production — the api host
  should 404 the CMS UI entirely (it cannot log in there anymore by design).
- **⚠ CORS flag:** `app.use(cors())` sets `Access-Control-Allow-Origin: *` on every response.
  Booking's `/api/units` proxy is server-side (CORS-free), but any direct browser call to the
  API is wide open. Acceptable for MVP; tighten later if needed (backend-agent).

## Phase A — Lambda package [devops; needs Phase 0 steps 1–2 done]

Run from `storelah-backend/` with pnpm 10.4.1 (corepack).

1. **Install + gate:**
   ```bash
   corepack prepare pnpm@10.4.1 --activate   # pin (matches packageManager)
   pnpm install --frozen-lockfile
   pnpm check          # tsc --noEmit — the repo's only gate (no lint/test exists)
   ```
2. **Build (fresh — the existing `dist/` is stale):**
   ```bash
   pnpm build
   # tsc -p tsconfig.json  THEN  rm -rf dist/src/cms && cp -R src/cms dist/src/cms
   # verify: dist/src/index.js exists AND dist/src/cms/ contains dashboard.html +
   #   data-layer.js + admin/dashboard.html (the copied static UI)
   ```
3. **Prisma engine for Lambda (classic gotcha):** `pnpm prisma generate` on macOS produces
   the query engine for the **build machine**, not Lambda. Lambda Node 20 (Amazon Linux 2023,
   glibc, OpenSSL 3) needs a linux engine. Backend-agent must add `binaryTargets` to the
   generator block in `prisma/schema.prisma` (a `prisma/` edit — NOT devops's):
   ```prisma
   generator client {
     provider      = "prisma-client-js"
     binaryTargets = ["native", "linux-x64-openssl-3.0.x", "linux-arm64-openssl-3.0.x"]
   }
   ```
   (pick the arch you deploy — x86_64 or arm64). Then `pnpm prisma generate` re-runs with
   both engines so the zip carries the linux one. `@prisma/client`'s postinstall auto-runs
   generate (package.json `onlyBuiltDependencies` already allows `@prisma/client`,
   `@prisma/engines`, `prisma`, `esbuild`). Verify the linux engine is present in the zip.
4. **Migrate the CLOUD DB (deployer machine, NOT the Lambda):** use the **DIRECT** Neon URL
   (non-pooled — the pooled endpoint + `pgbouncer=true` breaks DDL/migrations), passed as an
   env override for the one-shot deploy command:
   ```bash
   DATABASE_URL="$NEON_DIRECT_URL" pnpm db:deploy   # prisma migrate deploy (DIRECT URL only)
   ```
   This applies the 7 migrations. Do this ONCE, before/at first deploy — never on every cold
   start. The Lambda's runtime `DATABASE_URL` is the **POOLED** URL (Phase 0 steps 1 + 4).
4b. **Seed the CLOUD DB ONCE (contradiction resolved):** the runbook's blanket "never run
   `db:seed` against the cloud DB" refers to ACCIDENTAL/destructive re-seeds. Phase C expects
   **seeded rows** (`GET /api/v1/public/branches` non-empty → proves Prisma reached Neon),
   and the CMS needs an `AdminUser` row to log in — so a **deliberate, one-shot** seed at
   deploy time is REQUIRED:
   ```bash
   STORELAH_ADMIN_EMAIL=admin@storelah.sg STORELAH_ADMIN_PASSWORD=<same-as-lambda-env> \
     DATABASE_URL="$NEON_DIRECT_URL" pnpm db:seed
   ```
   The seed now reads the admin pair from env (fallback `admin@storelah.sg` / `password` for
   local dev only — committed 2026-08-13), so the admin row matches the Lambda's
   `STORELAH_ADMIN_PASSWORD`. Never re-run it against the cloud DB after launch (wipes data).
5. **Bundle the zip (pnpm layout gotcha):** `node_modules` is **symlink-based** under pnpm —
   a naive `zip -r node_modules` ships broken symlinks. Build a self-contained staging dir
   (guaranteed approach — this repo is NOT a pnpm workspace, so `pnpm deploy` [experimental,
   workspace-oriented] is optional; `--legacy` mode + manual copy both work, manual is safest):
   ```bash
   rm -rf /tmp/storelah-backend-zip
   mkdir -p /tmp/storelah-backend-zip
   cp -R dist package.json /tmp/storelah-backend-zip/
   cd /tmp/storelah-backend-zip && pnpm install --prod --frozen-lockfile
   #   ^ installs prod deps with REAL files (no symlinks); if the lockfile
   #     misbehaves outside the repo, fall back to: pnpm deploy --prod --legacy /tmp/storelah-backend-zip
   cd /tmp/storelah-backend-zip && zip -qr ../backend.zip .   # zip root = dist/ + node_modules/ + package.json
   ```
   - Layout matters for `__dirname`: `dist/src/index.js` must sit beside `dist/src/cms/`.
   - **Must include** (prod deps): `@prisma/client` + `.prisma/client` (generated) +
     `@prisma/engines` (linux engine), `serverless-http`, `express`, `cors`,
     `cookie-parser`, `dotenv`, `jsonwebtoken`, `bcryptjs`, `zod`. **Exclude** devDeps
     (`typescript`, `tsx`, `@types/*`, `prettier`, and the `prisma` CLI — not needed at
     runtime).
   - **Limits:** Lambda zip ≤ **50 MB** for console direct upload / ≤ 250 MB unzipped
     (larger zips go via S3). Express + Prisma ≈ 20–40 MB zipped — comfortable.
6. **Create / update the function:**
   ```bash
   aws lambda create-function \
     --function-name storelah-backend \
     --runtime nodejs20.x \
     --role arn:aws:iam::<acct>:role/<lambda-exec-role> \
     --handler dist/src/index.handler \
      --memory-size 256 --timeout 30 \
      --environment 'Variables={DATABASE_URL=<POOLED-NEON-URL>,JWT_SECRET=...,JWT_EXPIRES_IN=12h,STORELAH_ADMIN_EMAIL=...,STORELAH_ADMIN_PASSWORD=...,NODE_ENV=production}' \
     --zip-file fileb:///tmp/backend.zip
   # iterate on code:  aws lambda update-function-code --function-name storelah-backend --zip-file fileb:///tmp/backend.zip
   ```
   - Runtime **nodejs20.x**; handler `dist/src/index.handler`; 256 MB + 30 s is ample.
   - **Execution role (what the function runs AS):** needs CloudWatch Logs
     (`logs:CreateLogGroup` / `CreateLogStream` / `PutLogEvents`) only. **No VPC, no `ec2`
     ENI permissions** — Neon is reached over the public internet, so the Lambda stays in the
     default (non-VPC) execution model. Scoped policy, never admin (landing's deploy-user
     pattern).
   - **Invoke permission (who can CALL the function):** API Gateway needs
     `lambda:InvokeFunction` on the function. Creating the HTTP API integration from the
     console auto-grants it; via CLI add
     `aws lambda add-permission --function-name storelah-backend --principal apigateway.amazonaws.com --action lambda:InvokeFunction --statement-id apigw-invoke`.
7. **Smoke-test the raw function** before wiring API Gateway: `aws lambda invoke` with a
   synthetic API Gateway event (payload 1.0 and 2.0 both) — confirm the handler responds.

## Phase B — API Gateway + DNS [devops; DNS edit is a FUTURE dispatch]

### B1. Create the HTTP API

- **HTTP API** (cheaper than REST; free tier 1M req/mo). Create
  `storelah-backend-api` with a **Lambda proxy integration** for the function.
- **Routes:** a catch-all — with HTTP API either a single `$default` route (matches
  everything not matched elsewhere, including `/health`, `/admin`, `/`) or explicit
  `ANY /api/{proxy+}` PLUS `$default` for the non-`/api` paths. Recommend **`$default`**
  alone: the Express app routes internally, and it keeps the custom-domain base-path mapping
  trivial (see B2 gotcha).
- **Payload format 2.0** (HTTP API default). serverless-http handles 1.0 and 2.0 — verify
  with the synthetic-event smoke test in Phase A step 7.
- Stage: `prod` (invoke URL `https://<api-id>.execute-api.ap-southeast-1.amazonaws.com`).

### B2. Custom domain — `api.storelah.sg` + ACM cert

- **⚠ GOTCHA — ACM region is INVERTED vs CloudFront:** CloudFront requires the cert in
  **us-east-1**; **API Gateway requires the cert in the SAME region as the API Gateway
  (ap-southeast-1)**. Create the cert in **ap-southeast-1** with DNS validation
  (`api.storelah.sg`). Because the zone lives in Route 53 (global), add the validation CNAME
  to the `storelah-dns` stack the same way the CloudFront cert's validation CNAMEs already
  live there. Do NOT reuse the us-east-1 CloudFront cert.
- **Base-path mapping gotcha:** map the custom domain to stage `prod` with a **`/` (root)
  base path** — then API Gateway forwards the FULL path (`/api/v1/...`) to Express and all
  mounts match. If you map base path `/api` instead, the prefix is STRIPPED and Express's
  `/api/v1/...` mounts 404. (With HTTP API + `$default` route, a root mapping is the safe
  choice.)

### B3. DNS — `api.storelah.sg` record (documented; do NOT edit the stack in this session)

The zone is CloudFormation-owned by `storelah-dns`
(`storelah-landing/infra/route53-stack.yaml`, stack region us-east-1). Like booking's Phase B,
this is a FUTURE devops dispatch once the API is live. Model on `WwwCname` / the booking
`BookingCname` patch:

```yaml
ApiCname:
  Type: AWS::Route53::RecordSet
  Properties:
    HostedZoneId: !Ref HostedZoneId
    Name: api.storelah.sg
    Type: CNAME
    TTL: 300
    ResourceRecords:
      - <api-id>.execute-api.ap-southeast-1.amazonaws.com   # [PLACEHOLDER — exact regional endpoint]
```

- API Gateway **regional** endpoints accept a plain CNAME (no ALIAS needed — ALIAS would
  require the API Gateway hosted-zone ID per region; CNAME is simpler and correct here).
- The legacy `*.storelah.sg` wildcard has been **deleted** from the zone — there is no
  wildcard left to shadow, so `api.storelah.sg` resolves **solely** through its exact CNAME
  record (which is unchanged and live). Do not recreate the wildcard.
- Redeploy **in place** (never delete/recreate; `HostedZoneId` is kept on update):
  ```bash
  aws cloudformation deploy \
    --stack-name storelah-dns \
    --template-file infra/route53-stack.yaml \
    --parameter-overrides HostedZoneId=<zone-id> \
    --region us-east-1
  ```

## Phase C — Verification

```bash
curl -s https://api.storelah.sg/health                        # { ok: true, service: 'storelah-cms', time }
curl -s https://api.storelah.sg/api/v1/public/branches         # { data: [...] }
curl -s "https://api.storelah.sg/api/v1/public/units/map?branch=BM&level=1"
curl -s https://api.storelah.sg/api/v1/public/promotions       # { data: [...] }
curl -s -X POST https://api.storelah.sg/api/v1/public/promotions/validate \
  -H 'content-type: application/json' -d '{"code":"ANY10","rate":100,"months":6}'
# customer auth flow:
curl -s -X POST https://api.storelah.sg/api/v1/customer/register \
  -H 'content-type: application/json' \
  -d '{"name":"Verify User","email":"verify@example.com","password":"secret1","type":"PERSONAL"}'
TOKEN=$(curl -s -X POST https://api.storelah.sg/api/v1/customer/login \
  -H 'content-type: application/json' -d '{"email":"verify@example.com","password":"secret1"}' | jq -r .data.token)
curl -s https://api.storelah.sg/api/v1/customer/me -H "Authorization: Bearer $TOKEN"
# static dashboard (served from the bundle's dist/src/cms):
curl -sI https://api.storelah.sg/admin                        # 200 HTML (dashboard.html)
curl -sI https://api.storelah.sg/                             # 200 HTML (dashboard.html)
# admin CMS with Bearer token (login as the env-configured admin):
ADMIN_TOKEN=$(curl -s -X POST https://api.storelah.sg/api/v1/cms/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@storelah.sg","password":"<env STORELAH_ADMIN_PASSWORD>"}' | jq -r .data.token)
curl -s https://api.storelah.sg/api/v1/cms/summary -H "Authorization: Bearer $ADMIN_TOKEN"
echo | openssl s_client -connect api.storelah.sg:443 -servername api.storelah.sg
```

- **Expect the `{ data, meta? }` envelope everywhere and `{ error: { code, message } }` on
  failures** (`src/lib/http.ts`).
- **CORS:** booking's `/api/units` proxy is server-side (no browser CORS involved). For
  DIRECT browser calls, the API answers with `Access-Control-Allow-Origin: *` (from
  `app.use(cors())`) — verify the header is present if a browser path is added later. Flag
  if API Gateway-level CORS config is ever added — do not double it with Express CORS.
- **Cold start:** first hit after idle may take 1–3 s (acceptable for MVP); warmed
  containers answer in ms. Watch for timeouts on the 30 s ceiling.
- **Neon verification (proves the pooled URL works):** `GET /api/v1/public/branches` (line
  above) must return **seeded rows** (non-empty `data`) — that confirms Prisma reached Neon
  through the pooled endpoint + `pgbouncer=true`. Expect the **first call after ~5 min idle
  to be slower**: the Neon compute wakes from scale-to-zero (adds a few hundred ms on top of
  the Lambda cold start); subsequent calls are fast. If it errors with a connection/pool
  error, re-check the pooled URL + query params against Phase 0 step 1.
- **`/api/v1/cms/config`** is the dashboard auto-login creds endpoint — **404s on the api
  host unconditionally** (both `/api/v1/cms` and legacy `/api/cms`, see Phase 0 step 4) and
  returns creds only on the cms host / local dev. When verifying admin flows, call `/login`
  directly with the env-configured `STORELAH_ADMIN_PASSWORD` instead.

## Cross-app notes

- **Booking (Option A):** waits on this session. Once `https://api.storelah.sg` is live, the
  booking session sets Amplify env `NEXT_PUBLIC_API_URL=https://api.storelah.sg` (+
  `NEXT_PUBLIC_API_PREFIX=/api/v1/public`) and deploys. Do NOT point booking at the API
  before Phase C passes.
- **Landing:** unaffected. `BOOKING_URL` / gate / `PriceClass` decisions stay with
  `storelah-landing/docs/DEPLOYMENT.md`.
- **`storelah-dns` stack:** hosts the zone for all three hostnames (storelah.sg apex+www,
  booking.storelah.sg, api.storelah.sg). All record-set edits go through the stack — never
  the console.

## Cost & free-tier watch

| Item | Free tier | Overage (approx — verify at deploy) | Risk |
|---|---|---|---|
| Lambda | 1M req/mo + 400K GB-s/mo | ~$0.20/M req + ~$0.0000167/GB-s | `@prisma` boot per cold start eats GB-s; MVP traffic is tiny |
| API Gateway (HTTP API) | 1M req/mo | ~$1.00/M req | trivial at MVP scale |
| ACM cert | free | n/a | n/a |
| Route 53 | hosted zone already exists (no new zone cost) | $0.50/zone/mo | none new |
| **Database** | **Neon Free — $0/mo** | Neon Free: 0.5 GB storage, 190 compute-h/mo, 10-connection limit (pooled). Escalation: Neon Launch $19/mo. RDS/NAT-gateway costs no longer in play (no VPC) | **watch the 190 compute-h/mo ceiling** — scale-to-zero keeps it low at MVP traffic |

Watch: same free-tier-model caveat as landing/booking — the AWS account may be on the
**July 2025 credit-based free-tier model** for NEW accounts; confirm eligibility before
relying on the 1M/1M free tiers. Recommend an AWS billing alarm at **$5/mo** (same as
landing/booking).

## Rollback

- **Function:** re-run `aws lambda update-function-code` with the previous zip, or use
  Lambda versions/aliases (recommended once IaC lands) and roll back the alias pointer.
- **Env var change:** update `--environment` and redeploy (a full config update; no code
  rebuild needed) — e.g. if `DATABASE_URL` or `JWT_SECRET` rotates.
- **API Gateway:** stateless config — redeploy the previous stack/template or delete the API;
  the Lambda keeps working standalone.
- **DNS:** remove the `ApiCname` record set from the `storelah-dns` stack + redeploy —
  `api.storelah.sg` stops resolving (the `*.storelah.sg` wildcard fallback at the old
  `103.11.189.189` placeholder has been deleted, so there is no fallback record left), the
  `execute-api...amazonaws.com` invoke URL keeps working meanwhile.
- **Database:** Neon Free has **no point-in-time restore** — before any risky
  migration/seed, export a backup: `pg_dump "$NEON_DIRECT_URL" > backup.sql`. Rollback =
  restore from that dump (drop/recreate schema, re-apply). Neon's branch/restore features
  are the richer path [verify free-plan branch limits at setup]. Escalation path = Neon
  Launch (paid) for PITR.

## Excluded (explicitly out of scope for this runbook)

- **Database provisioning** beyond the decision itself — the Neon project + connection
  strings are a **USER console step** (Phase 0 step 1 "Neon setup"); applying the migrations
  to the cloud DB happens in Phase A step 4.
- `infra/backend-stack.yaml` (Lambda + API Gateway IaC) — recommended future devops
  deliverable, not built here.
- Stripe / payment wiring — Phase 4+ feature work.
- Booking deployment (Amplify) — Option A makes it NEXT after this session.
- Landing deployment / gate removal / `PriceClass` — landing's own runbook.
- Monorepo consolidation — rejected; three separate repos stay.

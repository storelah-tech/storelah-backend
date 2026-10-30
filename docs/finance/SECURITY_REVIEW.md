# Finance Module — SECURITY REVIEW (Phase 5)

Date: 2026-10-30 · Branch: `feature/9-finance-module` (worktree-local) ·
Spec: `docs/finance/FINANCE_MODULE_SPEC.md` §§25.2 (security), 15.4, 26.2–26.3.

## 1. Verdict

**5 findings, 0 critical.** The finance surface is deny-by-default
(`routePermissions.ts` + `applyRoutePermissions`), every new Phase 5 route is
permissioned and covered by tests, no secrets or PII leak into code/logs, and
all money-moving mutations carry idempotency and/or optimistic-lock guards.
Two findings are accepted-and-documented (not fixed): operational tenant
name/email in case-work serializers (F-02) and synchronous CSV exports (F-05).

## 2. Route → permission coverage proof

- `tests/e2e/cms-rbac.test.ts` fails on ANY CMS route missing a
  `ROUTE_PERMISSIONS` entry (`declares a permission for every CMS route` —
  uses `listRouteKeys(cmsRouter)`), and fails on any entry referencing an
  unknown catalog permission. Both tests are green.
- Phase 5 adds exactly two routes, both `bill-investor:view`:
  `GET /finance/investor/summary`, `GET /finance/investor/summary.csv`
  (`src/lib/routePermissions.ts`). The table test covers them automatically.
- `tests/e2e/finance-phase5.test.ts` additionally asserts the INVESTOR role
  gets **403 on 19 other finance routes** (overview, models, library,
  budgets, expenses, pricing, returns, invoices, transactions, credits,
  refunds, arrears, reconciliation, performance, month-close, audit + both
  exports) and 403 on `POST /finance/models` and `POST /finance/month-close`.
- `INVESTOR` seeded with exactly one permission (`bill-investor:view`);
  `MANAGER` deny-list and `VIEWER` hidden-set both updated so the masked
  surface stays investor-only (`src/lib/permissions.ts`).

## 3. Masked-field assertions (investor surface)

`tests/e2e/finance-phase5.test.ts` proves the negative:

- No seeded PII values (tenant names, emails, mobiles) appear in the JSON
  summary or the CSV export.
- A recursive key scan fails on 19 forbidden keys (`email`, `phone`,
  `mobile`, `tenantId`, `customerId`, `invoiceId`, `invoiceNo`,
  `paymentIntentId`, `stripeSessionId`, `sessionId`, `cardLast4`,
  `mandate`, `unitCode`, `address`, `bankAccount`, …) — none present.
- Only aggregates cross the boundary: counts, rounded sums, averages,
  CURRENT-model projection, CLOSED-month actuals. Draft models, open-month
  actuals, invoice lines, transaction detail and internal notes are excluded
  by construction (queried only from CURRENT / CLOSED / aggregate reads) and
  by test (DRAFT name absent, OPEN month `9999.99` absent).

## 4. Idempotency + optimistic-lock coverage (all finance mutations)

| Mutation route | Guard |
|---|---|
| `POST /finance/models` | create-then-edit; no key needed (fresh row) |
| `PUT /finance/models/:id/{inputs,assumptions,size-mix,opex}` | `version` compare-and-swap → 409 (`models.concurrent-update-409` ✅) |
| `POST /finance/library/:id/duplicate` | Idempotency-Key header (`⋄`); name+reason required |
| `POST /finance/library/:id/{save-version,submit,approve,reject,restore,archive,set-current}` | `expectedVersion` where a row is rewritten (submit/approve/reject/archive/set-current take version) |
| `DELETE /finance/models/:id` | drafts only (service-code) |
| `POST /finance/budgets`, `PUT /finance/budgets/:id` | unique (branch, month, category) → 409 CONFLICT; update takes `version`; closed-month BLOCKED |
| `POST /finance/expenses` | receiptRef content key + closed-month BLOCKED (single-shot operator form; no header key — see F-03) |
| `PUT /finance/pricing/:sizeId` | `version` compare-and-swap + audit |
| `POST /finance/invoices` | Idempotency-Key header → same-key replay returns the first row (`billing-run.twice-one-draft-set` ✅) |
| `POST /finance/invoices/:id/{approve,issue,void,write-off}` | `version` compare-and-swap → 409 (`transactions.approve-stale-409` pattern ✅); void/write-off require reason |
| `POST /finance/billing-run` | deterministic per-branch/month/tenant idempotencyKey → re-run reuses, never duplicates ✅ |
| `POST /finance/transactions` | Idempotency-Key header (`charge.retry-same-key` ✅) |
| `POST /finance/transactions/:id/{approve,retry}` | `version` + server revalidation at approval ✅; `cancel` takes version + reason |
| `POST /finance/credits/{grant,apply}` | Idempotency-Key header via ledger `refId: idem:<key>` ✅ |
| `POST /finance/refunds` | Idempotency-Key header ✅; negative → DRAFT charge conversion (`refund.negative-converts-to-charge` ✅) |
| `POST /finance/refunds/:id/{approve,reject,pay}` | maker-checker (approver ≠ requester, every amount) + `expectedVersion`; pay gated on bank verification |
| `POST /finance/arrears`, `.../advance`, `.../close` | open dedupes on open case (`findFirst`); advance/close take `expectedVersion` + timing gates |
| `POST /finance/arrears/waivers`, `.../waivers/:id/decide` | Idempotency-Key on request; decide takes version + approver gate |
| `POST /finance/reconciliation/import` | `sourceRef = batchRef:externalRef` unique → retried import returns the batch (`import.partial-match` ✅) |
| `POST /finance/reconciliation/:id/{match,suspense}` | match takes `expectedVersion`; suspense↔match resolution audited |
| `POST /finance/reconciliation/{close,reopen}` | checklist 409; reopen is `OWNER`-only |
| `POST /finance/performance/notes` | variance notes (append; no version needed) |
| `POST /finance/month-close`, `.../month-close/adjust` | `version` on close; adjustments are NEW events, never edits (`close.freezes-actuals`, `close.adjustment-creates-new-event` ✅) |
| Stripe webhook | event-id claim (`ProcessedStripeEvent`) + conditional writes → duplicate delivery applies once (`webhook.duplicate-delivery-single-paid` ✅) |

## 5. Super-Admin refund bypass audit

Owner/Platform-Admin single-step refund (`finance.refundTwoStep =
REQUIRED_EXCEPT_SUPERADMIN`) still writes a `FinanceAuditEvent` with actor +
reason on every bypassed step (`refunds.superadmin-bypass-audited` ✅).
Risk accepted by owner (Q4 v1.2); the bypass is config-visible in Global
Settings and covered by test, not silent.

## 6. Secrets / PII in code and logs

- `grep` over `src/core/finance/*` + `src/routes/cms.ts`: no `console.log`
  with payloads (one static `[queued-charge]` mismatch line, no data), no
  `STRIPE_*` / password / secret reads outside `src/lib/config.ts`
  (server-side env only, with a dev-only fallback secret that production
  overrides via real `JWT_SECRET`).
- No raw card data: only Stripe tokens/ids (`paymentIntentId`,
  `stripeCustomerId`) travel server-side; webhooks are signed + replay-safe.
- No PII in URLs anywhere (branchId/month/ids only — including the new
  investor routes); no PII in finance log lines.

## 7. Findings

- **F-01 (fixed): investor registers unscoped.** First draft of
  `getInvestorSummary` accepted an optional branchId correctly; verified the
  branch filter threads through every sub-read (model, units, tenants,
  invoices, closes). ✅
- **F-02 (accepted): tenant name/email in operator serializers.** Invoice,
  transaction, arrears, credit and refund reads return `tenant` + `tenantEmail`
  to roles holding the respective `view` (Finance Operator/Approver/Auditor,
  Manager on invoices/arrears). This is operational necessity (case work is
  keyed by tenant), not an investor/analyst export; no phone, address, or
  payment-instrument data is serialized. The INVESTOR role cannot reach these
  routes (403, tested). Recommendation: field-level minimization (drop email
  where the UI never renders it) as a later hardening pass — NOT done here to
  avoid breaking operator workflows mid-phase.
- **F-03 (accepted): no Idempotency-Key on budget/expense/arrears-open.**
  These converge via unique constraints (budget 409, settlement sourceRef,
  arrears-open dedupe). Double-click duplicate POSTs are the residual risk;
  the UI disables submit while pending. Noted for a future header-key pass.
- **F-04 (fixed): unbounded invoice/transaction registers.** `findMany`
  without `take` (Phase 5 perf probe). Bounded to 500 server-side, matching
  the existing `take: 200–500` convention. ✅
- **F-05 (accepted): exports are synchronous.** CSV builders run in-request
  over filtered datasets (all current exports are KB-scale). No async job
  queue exists; a genuinely large export would block the request. Deferred —
  no large-blob export path is specified yet.

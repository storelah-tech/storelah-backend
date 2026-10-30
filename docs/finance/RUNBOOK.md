# Finance Module — RUNBOOK (Phase 5)

Deploy + migration order for the whole finance build (Phases 1–5).
Standing rules: no prod migration or deploy without explicit owner
go-ahead each time; `pnpm db:seed` is destructive and NEVER runs on
cloud/prod; Stripe stays in test mode.

## 1. Prerequisite lane state (verified 2026-10-30 in this checkout)

- **RBAC lane: NOT on `develop`.** `20261027120000_cms_rbac` (+ the
  `feature/user-role-permission` commits `b9bd113/025c2b7/8916412`) lives on
  `release/user-role-permission` and in this branch's history — `git
  merge-base --is-ancestor 8916412 develop` is FALSE and `git log develop --
  <cms_rbac migration>` is empty. The finance branch depends on it
  (`src/lib/permissions.ts`, `src/lib/routePermissions.ts`,
  `src/lib/facilityScope.ts`, `ensureSystemRoles`, `cms-rbac.test.ts`).
- **Saved-cards lane: NOT on `develop`.** `feature/8-saved-cards`
  (`daa8c46`) is not an ancestor of `develop`. The finance branch carries
  those files **local-only, uncommitted**: `src/core/savedCards.ts`, the
  webhook route, portal suites, and migration
  `20261025000000_customer_stripe_customer_id` (staged, not pushed) plus a
  hand-applied `stripeCustomerId` schema hunk on top of the Phase 1–2 schema
  (see IMPLEMENTATION_PLAN §11).

### Merge-order options (owner decision needed)

- **Option A (recommended): land lanes in dependency order.** Merge the RBAC
  release to `develop` first; then merge `feature/8-saved-cards`; then
  rebase `feature/9-finance-module` onto `develop` and resolve (expected:
  the carried saved-cards copies become identical to the lane's, the
  hand-applied schema hunk drops out). Cleanest history, no duplicate files.
- **Option B: merge the finance branch as-is.** Its history already
  contains the RBAC commits and its tree already contains the saved-cards
  files + migration, so `develop` gets everything in one merge — but the
  saved-cards lane still has an open branch that will conflict when it
  merges later (same files, two sources). Only with the saved-cards owner's
  agreement to abandon/FF their branch.
- Either way: NEVER push/merge to shared branches without the user saying
  so (standing rule). Phase 5 adds no new cross-lane files.

## 2. Migration chain (apply in timestamp order)

`migrate deploy` applies by timestamp, which is already the right order:

1. `20261025000000_customer_stripe_customer_id` — saved-cards lane file
   carried local-only (Option A makes this arrive via the saved-cards
   merge instead; harmless either way, additive).
2. `20261030000000_finance_phase1_foundations` — audit/outbox tables,
   FinancialModel, projection inputs, Finance roles seed, overview.
3. `20261030000001_finance_phase2_planning` — planning workspace tables
   (budgets/expenses/pricing/library versions).
4. `20261030000002_finance_library_update_grant` — `bill-library:update`
   grants (data-only).
5. `20261030000003_finance_phase3_billing` — invoice lifecycle widening
   (**enum via create-type-and-swap**, NOT `ALTER TYPE ADD VALUE` —
   irreversible by plain down-migration, see §5), InvoiceLine,
   PaymentInstruction, ProcessedStripeEvent.
6. `20261030000004_finance_transactions_update_grant` —
   `bill-transactions:update` grants (data-only).
7. `20261030000005_finance_phase4_close_controls` — credits/refunds,
   arrears, late-fee waivers, settlement/reconciliation, month-close,
   Tenant `accessRestricted*` columns, `finance.refundTwoStep` SettingDef.
8. `20261030000006_finance_phase5_investor` — INVESTOR role row +
   `bill-investor:view` grants (Owner + three Finance roles). Data-only,
   idempotent (`ON CONFLICT DO NOTHING`).
9. `20261030000007_tenant_branch_backfill` — fills NULL `Tenant.branchId`
   from the tenant's unit (F-3). **Data update on existing rows**; idempotent.
10. `20261030000008_expense_detail` — `Expense.description`, `status`
   (default `PAID`, so existing rows read as actuals), `note`. Additive.

Pre-prod checklist: `npx prisma migrate status` clean on a staging clone;
`pnpm check`; full `pnpm test:e2e` green (see §4). Order for prod: **migrate
first (direct Neon URL), then Lambda code update** (standing rule).

## 3. Seed / role bootstrap (post-deploy, Owner does this)

1. `ensureSystemRoles()` runs on boot/seed/tests — creates any missing
   seeded role, keeps Owner on `ALL_PERMISSIONS`, never overwrites an
   editable role's matrix. The three Finance roles + INVESTOR seed with
   **zero members**.
2. Owner signs in (`admin@storelah.sg`) → Global Settings › Team & access →
   assigns operators to Finance Operator / Approver / Auditor / Investor.
3. Super-Admin bypass config: `finance.refundTwoStep =
   REQUIRED_EXCEPT_SUPERADMIN` is visible/editable in Global Settings
   (owner Q4 v1.2). Every bypassed refund still writes a
   `FinanceAuditEvent` with actor + reason.
4. `finance.*` defaults (all editable, none hardcoded):
   `gstEnabled OFF`, `gstRate 5%`, `expenseBasis accrual`,
   `depositMode segregated`, `graceDays 0`, `lateFeeAfterDays 7`,
   `accessRestrictAfterDays 14`. While GST is OFF: `taxAmount = 0`, GST UI
   hidden. Issuing a GST-bearing invoice with the rate UNDECIDED is
   BLOCKED with a message naming the decision.
5. Late-fee amount/formula + termination remain UNDECIDED (see §6): the
   amount resolves from `FacilityFee`/`finance.lateFeeAmount` or BLOCKS;
   termination is a 409 stub.

## 4. Test command

```
pnpm check            # tsc --noEmit (primary gate)
pnpm test:e2e         # full suite, incl. finance-phase1–5, cms-rbac,
                      # portal-invoices + saved-cards regression
```

- Suite runs against the isolated `storelah_*_test` DB only (guarded —
  refuses any name not ending in `_test`); the shared dev DB is never
  migrated or truncated by tests.
- Local dev server port **4150** (never 4000/4010–4012/4100–4140); local
  Postgres on **5433**. Real secrets stay env-only, in-shell, unset after.

## 5. Rollback notes

- **Phases 1, 2, 4, 5: additive-only → code revert.** All tables/columns
  added nullable/defaulted; no drops or renames. Rolling back the Lambda
  code leaves the new tables/values unused; no data migration needed.
- **Phase 3 enum widen is NOT reversible by plain down-migration.** The
  `InvoiceStatus` widening used create-type-and-swap inside a transaction
  (because `ALTER TYPE ADD VALUE` cannot run in a transaction). Rolling
  that back requires a manual type-swap procedure, not `migrate resolve` —
  treat Phase 3 as forward-only; if an invoice-state bug ships, fix forward
  (VOID/WRITE_OFF are terminal and audited).
- Permission-grant migrations (00002/00004/00006) are data-only inserts
  with `ON CONFLICT DO NOTHING` — safe to re-apply, and `ensureSystemRoles`
  repairs a missing role row on next boot.
- No purge path exists by design (perpetual retention, owner Q10).

## 6. Outstanding owner items (still open after Phase 5)

- **Q8 spec amendment** (blocks returns-engine extension, not current
  behaviour): spec §§5.1/8.8/15 still describe the narrow IRR; the engine
  deliberately follows the spec formulas until the owner amends the text
  (IMPLEMENTATION_PLAN §9 Q8 / §10 Q8-final).
- **Q5 amounts/termination:** late-fee amount/formula + termination steps
  still OPEN (timings decided: grace 0 / late-fee 7d / restrict 14d).
- **Q9 manual-override authority:** overlay-with-audit is the standing
  proposal (live inventory always wins).
- **StorageAgreement sign-off:** Tenant + 4 additive columns remains the
  PROPOSED option (§1d); no `StorageAgreement` table built.
- **Deferred (not owner-blocking):** async export queue (F-05), budget/
  expense idempotency header keys (F-03), field-level PII minimization in
  operator serializers (F-02), R-1 manual AT pass, R-2 skip-link, R-3
  `--red` contrast outside finance — see SECURITY_REVIEW.md /
  ACCESSIBILITY_AUDIT.md.

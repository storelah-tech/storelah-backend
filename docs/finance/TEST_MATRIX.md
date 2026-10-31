# Finance Module — TEST_MATRIX (Phase 1 foundations)

Maps **every** spec §26.1 (calculation) / §26.2 (workflow) / §26.3 (failure)
bullet to a named test, with the phase that turns it green. Phase 1 rows are
ticked ✅ with the test file; everything else is ⬜ with its target phase.

Test commands: `pnpm check` (primary) + `pnpm test:e2e` (vitest, isolated
`storelah_*_test` DB — never dev, never `db:seed` except throwaway local DB).

## §26.1 Calculation tests

| Spec bullet | Named test | Phase | Status |
|---|---|---|---|
| Net move-in always equals move-in minus move-out | `projection.invariants` (every month) + `projection.sembawang-golden` | 1 | ✅ `tests/e2e/finance-projection.test.ts` |
| Month 1 prorated for every calendar month + leap year | `projection.proration-mid-month` (2028-02-15, 15/29 factor) | 1 | ✅ |
| Churn begins only in the configured model month | `projection.churn-from-month-7` | 1 | ✅ |
| Occupied sqft never exceeds stabilization target | `projection.target-92-cap` (cap 2092.08) | 1 | ✅ |
| Weighted PSF matches category-weighted result | `projection.weighted-psf` (12821.8/2274) | 1 | ✅ |
| Customer annual increase starts at model-year boundary | `projection.annual-uplift-3pct` (m12→m13, m24→m25) | 1 | ✅ |
| Free landlord months produce zero paid lease, incl. mid-month rules | `projection.rent-free-overlap` | 1 | ✅ |
| Lease counted exactly once in operating cost | `checks.leaseCountedOnce` on golden (`projection.sembawang-golden`) | 1 | ✅ |
| Monthly budget override affects only selected open scope | `budgets.lease-line-protected` (scope month vs month+future, protected override) | 2 | ✅ `tests/e2e/finance-phase2.test.ts` |
| NOI equals revenue minus total operating cost | `projection.invariants` (every month) | 1 | ✅ |
| Cash starts at negative capital, accumulates NOI | `projection.invariants` + `checks.cashStartsAtCapital` | 1 | ✅ |
| IRR uses selected horizon, N/A for invalid sign patterns | `returns.irr` (hand case + N/A + NPV self-consistency) + `returns.irr-standard/na/no-sign/payback-never` | 1 solver / 2 horizon UI | ✅ solver + horizon UI (`tests/e2e/finance-phase2.test.ts`) |
| Overview accrual/cash parity | `finance overview` cash-vs-accrual test | 1 | ✅ `tests/e2e/finance-phase1.test.ts` |
| Overview never fabricates actuals (em dash, never 0) | sourceless KPIs null + `not-connected` (failedPayments, creditsRefunds) | 1 | ✅ |
| Overview KPI lineage (definition/source/refresh) | lineage assertion on every KPI | 1 | ✅ |

## §26.2 Workflow tests

| Spec bullet | Named test | Phase | Status |
|---|---|---|---|
| Typing in a section does not mutate the committed model until Update | `models.staged-sections-commit` (per-section Update, unknown-field reject) | 2 | ✅ |
| Undo restores last committed section values | section Undo = staged clone discarded in UI; `models.failed-update-preserves-committed` (invalid Update leaves committed untouched) | 2 | ✅ |
| Updating one section refreshes dependents, not unrelated assumptions | `models.staged-sections-commit` (merged projection returned per update) | 2 | ✅ |
| Saving a named version appears in Library immediately | `library.save-appears` | 2 | ✅ |
| Loading a version changes forecast/returns, never posted actuals | `library.load-preserves-actuals` (no ActualMetric fabrication) | 2 | ✅ |
| Duplicate/restore always requests name + reason | `library.duplicate-restore` | 2 | ✅ |
| Future actuals show em dash | `performance.future-em-dash` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — unposted months carry nulls, never fabricated zeros) |
| A posted month cannot be directly edited | `close.freezes-actuals` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — budget/expense/invoice/void writes into a CLOSED month all BLOCKED) |
| Cash/accrual selection produces different figures when timing differs | `finance overview` cash-basis test | 1 | ✅ |
| Export Summary downloads filtered dataset + creates audit evidence | `finance export + audit + outbox` (CSV + correlated event) | 1 | ✅ |
| Invoice issue creates a payment instruction but does not charge | `billing.issue-creates-instruction` | 3 | ✅ `tests/e2e/finance-phase3.test.ts` |
| Only authorised users can approve a charge | `transactions.approver-not-requester` + RBAC matrix | 3 | ✅ (`tests/e2e/finance-phase3.test.ts`; matrix ✅ in Phase 1) |
| Approval rejected if invoice changed during review | `transactions.approve-stale-409` (helper ✅ Phase 1) | 1 helper / 3 route | ✅ helper + route (`tests/e2e/finance-phase3.test.ts`) |
| Refund override/deduction requires a reason | `refunds.reason-required` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — calculator + request reject reason-less deductions/overrides) |
| Negative refund becomes an additional charge workflow | `refund.negative-converts-to-charge` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — creates a DRAFT charge, no refund row, outbox event) |
| Reconciliation cannot close while checks fail | `reconciliation.close-checklist` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — 409 with checklist; Owner-only reopen) |
| Investor never sees mutation controls or customer PII | investor view tests (gating 403-matrix + masked-field key/value scan on JSON + CSV, CURRENT-only, CLOSED-only) | 5 | ✅ `tests/e2e/finance-phase5.test.ts` + investor block in `tests/e2e/cms-rbac.test.ts` |
| Scenario overlay isolated from base | `models.scenario-overlay-no-fork` | 1 engine / 2 route | ✅ engine + route |
| Sensitivity tornado (target ±pp, PSF ±$0.50) | `models.sensitivity-tornado` | 1 engine / 2 route | ✅ engine + route |
| Maker-checker on refunds (every refund needs a distinct approver; NO threshold — replaces the old `refunds.threshold-second-approval` name) | `refunds.every-refund-needs-approver` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — self-approval 403 MAKER_CHECKER at any amount) |
| Super-admin single-step bypass is audited with actor + reason | `refunds.superadmin-bypass-audited` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — Owner self-approve + REFUND_BYPASS audit event) |
| Bank verification recorded before any refund reaches PAID | `refunds.bank-verify-gate` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — pay BLOCKED until verified; requestor cannot execute) |
| Credit wallet grant/apply ledger (append-only, §17.4 balance cap) | `credits.grant-apply-ledger` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — GRANT/APPLY entries, full-pay flips PAID) |
| Void requires a reason; void cancels the live instruction | `invoices.void-requires-reason` | 3 | ✅ (`tests/e2e/finance-phase3.test.ts`) |
| Individual approval only, no bulk | `transactions.individual-only-no-bulk` (service-code enforcement) | 3 | ✅ (`tests/e2e/finance-phase3.test.ts` — no bulk route exists, approving one leaves the other pending) |
| Protected lease line | `budgets.lease-line-protected` (derived read-only, PUT 403, override path) | 2 | ✅ |
| Manual pricing override audited | `pricing.override-audited` (overlay-only, Unit rows untouched) + `pricing.inventory-mapping-gate` | 2 | ✅ |
| Model CSV export (audited) | `models.export-csv` (month table + lease/non-lease Opex columns) | 2 | ✅ |
| Month close freezes actuals; adjustments create new events | `close.freezes-actuals`, `close.adjustment-creates-new-event` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — posted row untouched, adjustment folds into the variance view) |
| Arrears advances follow the overdue ladder (timing gates) | `arrears.workflow-gates` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — early REMINDER/FORMAL_NOTICE block with the gating setting named) |
| Late-fee posting needs a configured amount (UNDECIDED-blocked) | `arrears.late-fee-requireDecided` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — BLOCKED naming lateFee; FacilityFee configured → FEE line posted) |
| Restriction flips the account state; resolve clears it | `arrears.restriction-resolve` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts`) |
| Waive-late-fee is approver-gated; approval appends a CREDIT line | `arrears.waive-late-fee` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — self-approve 403) |
| Termination is an UNDECIDED stub (never built) | `arrears.terminate-blocked` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — 409 naming the missing decision) |
| Approved write-off is terminal, reason-required, cancels instructions | `invoices.write-off` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts`) |
| Idempotency: billing run / webhook / retry | `billing-run.twice-one-draft-set`, `webhook.duplicate-delivery-single-paid`, `charge.retry-same-key` | 3 | ✅ (`tests/e2e/finance-phase3.test.ts`) |
| Optimistic lock: concurrent model update → 409 | `models.concurrent-update-409` | 1 helper / 2 route | ✅ helper + route |

## §26.3 Failure / RBAC / audit tests

| Spec bullet | Named test | Phase | Status |
|---|---|---|---|
| Reconciliation suspense queue (move + resolve by matching) | `reconciliation.suspense-queue` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts`) |
| Settlement import partial match (remainder stays allocatable) | `import.partial-match` | 4 | ✅ (`tests/e2e/finance-phase4.test.ts` — PARTIAL → MATCHED; re-import deduplicated) |
| Duplicate processor webhook does not duplicate payment/allocation | `webhook.duplicate-delivery-single-paid` | 3 | ✅ (same test as the §26.2 row — `tests/e2e/finance-phase3.test.ts` incl. signed HTTP replay) |
| Network failure after approval does not lose/repeat the command | outbox same-tx test ✅ (Phase 1 transport proof) | 1 | ✅ `finance export + audit + outbox` |
| Concurrent model updates → compare/reload conflict | `models.concurrent-update-409` | 1 / 2 | ✅ helper + route |
| Failed projection preserves last approved result with stale warning | `models.failed-update-preserves-committed` (invalid Update rejected, committed inputs + version unchanged) | 2 | ✅ |
| Missing inventory mapping blocks approval, not viewing | `pricing.inventory-mapping-gate` | 2 | ✅ |
| Processor outage leaves approved instructions queued + visible | `charge.outage-queues` | 3 | ✅ (`tests/e2e/finance-phase3.test.ts` — stays QUEUED, attempts+1, still in the register) |
| Export failure retries, never claims completion | export writes audit only after success (CSV path ✅) | 1 | ✅ |
| Every CMS route permissioned (`cms-rbac` suite incl. Phase 1+2 finance routes) | `tests/e2e/cms-rbac.test.ts` route-table test | every phase | ✅ (Phase 2: 30 new entries) |
| Audit append-only, no update/delete path | `finance export + audit + outbox` append-only test | 1 | ✅ |
| Audit correlation links cause and effect | export audit ↔ outbox correlationId assertion | 1 | ✅ |

## Golden fixture — Sembawang Launch Plan (spec §28)

File: `tests/e2e/fixtures/finance-projection-golden.json`.
Test: `projection.sembawang-golden` (months 1–12 exact, Y1–Y3 exact,
milestones, IRR regression, all engine checks pass, byte-determinism).

Independent derivation notes (hand/spreadsheet, committed in the fixture):

- Weighted PSF: category NLA×PSF = 455×6.80 (3094.0) + 500×6.20 (3100.0) +
  650×5.50 (3575.0) + 405×4.80 (1944.0) + 264×4.20 (1108.8) = 12821.8;
  ÷ 2274 = 5.638434… → **5.6384** (engine rounds PSF to 4dp, money to cents).
- Month t revenue = round2(closing × 5.6384 × factor); costs = 5000 + 1200;
  NOI = revenue − cost; cash opens at −108000 and accumulates NOI.
- Months 1–6: no churn, +180/mo → closings 180…1080. Month 7: opening 1080,
  move-out 1080×0.025 = 27, move-in min(125, 2092.08−1080+27) = 125,
  net 98, closing 1178; revenue 1178×5.6384 = 6642.04; NOI +442.04.
- Months 8–12 verified cell-by-cell (see fixture `derivation`): move-out =
  round2(opening×0.025); e.g. m9: 31.84, net 93.16, closing 1366.71,
  revenue 7706.06, NOI 1506.06, cash −120957.97.
- Milestones hand-verified: NOI-positive m7 (m6 −110.53); 70% = 1591.8 crossed
  m12 (m11 1546.10); stabilisation = first month ≥ 0.99×2092.08 = 2071.16 →
  m18 (m17 ≈ 2032.8); payback asserted as invariant cash[31] < 0 ≤ cash[32].
- IRR pinned as regression (0.39492); the solver is independently verified on
  the hand-computable case CF [−1000, +1100] → (1.1)^12 − 1 ≈ 2.13843, plus
  NPV≈0 self-consistency at the solved rate, plus N/A patterns.
- Engine also pins Y2/Y3 (capped at 2092.08; year-2 PSF uplift 5.6384×1.03):
  Y2 NOI 65146.80, Y3 NOI 75772.80, payback m32.

### Prototype cross-check (REPORT — no silent fixes)

The live prototype (fetched 2026-10-30) exposes finance only as
**demonstration datasets** (spec §1.3): Collected $284k / Outstanding $11.8k /
Failed $2,840 / Credits $6.4k / Refunds $1,280. None of these is a real
ledger value, so no KPI parity check is possible or meaningful. The prototype
exposes no model/NOI/IRR numbers in readable form, so the engine headline
KPIs (weighted PSF 5.6384, Y1–Y3 NOI, payback m32, IRR ≈ 39.5%) have no
prototype counterpart to cross-check — recorded here explicitly rather than
asserted. The prototype's visible finance subtabs (Overview / Invoices /
Arrears / Credits & refunds / Reconciliation) differ from the spec §3
12-submodule list; per spec §1 priority the SPEC wins — the 12-item shell is
built as specified.

## Edge cases (each a named test)

| Edge | Test | Status |
|---|---|---|
| Feb leap-year mid-month start (2028-02-15, factor 15/29) | `projection.proration-mid-month` | ✅ |
| Rent-free spanning the prorated first month | `projection.rent-free-overlap` | ✅ |
| IRR N/A patterns (all-negative, no sign change, single-period) | `returns.irr` | ✅ |
| Refund negative → converts to charge | `refund.negative-converts-to-charge` | 4 | ✅ |
| Duplicate Stripe webhook → exactly-once apply | Phase 3 (`webhook.duplicate-delivery-single-paid` + signed HTTP replay) | ✅ (`tests/e2e/finance-phase3.test.ts`) |
| Concurrent model update → 409, no lost update | `models.concurrent-update-409` (helper ✅ Phase 1, route ✅ Phase 2) | ✅ |
| PARTIALLY_PAID webhook for less-than-balance | Phase 3 | ✅ (`tests/e2e/finance-phase3.test.ts` — stays partial, amounts updated, portal shows the remainder) |
| Posted-month write → BLOCKED with message | `close.freezes-actuals` | 4 | ✅ |
| UNDECIDED policy → BLOCKED naming the decision | `arrears.late-fee-requireDecided` (route-level; helper established Phase 1) | 4 | ✅ |
| Legacy DUE invoice pays through new webhook path unchanged | existing `portal-invoices.test.ts` stays green | ✅ (run in full suite) |

## §29 Source-to-feature checklist — completion (Phase 5, 2026-10-30)

Every spec §29 item verified by the named suite, or explicitly deferred
below. Nothing silently dropped.

- [x] All twelve finance submodules have stable routes and permission guards (+ Investor Summary as a 13th masked surface; `cms-rbac` route-table test denies undeclared routes by default).
- [x] Filters persist in URL/preferences and flow to exports (hash `#bill-<sub>` + safe query params; CSV exports take the same filters and write audit events).
- [x] Every KPI has definition and lineage (overview lineage tips; investor `definitions[]` + per-metric notes).
- [x] Cash/accrual basis changes actual queries and values (`overview.accrual-cash-parity`).
- [x] All model formulas have automated fixtures (golden `finance-projection-golden` + engine checks).
- [x] Four model sections stage, Undo and Update independently (`models.staged-sections-commit`, `models.failed-update-preserves-committed`).
- [x] Size Mix drives weighted PSF and model revenue (`pricing.inventory-mapping-gate`, `pricing.override-audited`).
- [x] Landlord Lease drives the protected lease cost line once (`checks.leaseCountedOnce`, `budgets.lease-line-protected`).
- [x] Budget and expense states drive forecast and posted actuals correctly (phase 2 budgets + `close.freezes-actuals`).
- [x] Scenario overlays are isolated from the base model (`models.scenario-overlay-no-fork`).
- [ ] Charts support hover, zoom, range and actual-vs-forecast semantics — PARTIAL (see Deferred D-1): static accessible SVG renders of the served month rows (`role="img"` + labels, reduced-motion safe); actual-vs-forecast is carried by the performance table. Interactive hover/zoom/range deferred.
- [x] Save, duplicate, load, submit, approve, restore and audit work server-side (library governance suite).
- [x] Month close produces immutable actuals and future months remain blank (`close.*`, `performance.future-em-dash`).
- [x] Invoices generate draft instructions without charging (`billing.issue-creates-instruction`).
- [x] Every charge requires individual authorised approval (`transactions.individual-only-no-bulk`, `transactions.approver-not-requester`).
- [x] Processor webhooks are secure and idempotent (`webhook.duplicate-delivery-single-paid` incl. signed HTTP replay + event-id claim).
- [x] Refund proration, deductions, override reasons and negative outcomes work (`refunds.*`, `refund.negative-converts-to-charge`).
- [x] Reconciliation supports partial matches, suspense and close control (`import.partial-match`, `reconciliation.suspense-queue`, `reconciliation.close-checklist`).
- [x] Investor view is read-only, approved-data-only and privacy-safe (`tests/e2e/finance-phase5.test.ts`).
- [x] Exports are filtered, traceable and audited (overview + models + expenses + investor CSVs, all audit-backed).
- [x] Loading/error/empty/stale/conflict states are implemented (shared state boxes with live regions + 409 conflict paths tested).
- [x] WCAG, performance, security and audit requirements pass review (`docs/finance/ACCESSIBILITY_AUDIT.md`, §25.3 numbers in IMPLEMENTATION_PLAN §13, `docs/finance/SECURITY_REVIEW.md`; residuals listed as Deferred, not dropped).

## Deferred list (explicit)

- **D-1 Interactive charts.** Hover/zoom/range deferred; current charts are static SVG renders of server-computed rows with accessible names. No separate client-side calculation exists to diverge.
- **D-2 Async export queue.** All CSV exports run in-request over filtered datasets (KB-scale today). A large-export job queue waits on a specified large-blob export path (SECURITY_REVIEW.md F-05).
- **D-3 Cursor pagination on registers.** Invoice/transaction registers are server-side bounded (`take: 500`, matching the existing 200–500 convention) with filters; cursor pagination deferred with D-2.
- **D-4 Budget/expense/arrears-open Idempotency-Key headers.** These converge via unique constraints (budget 409, settlement sourceRef, arrears-open dedupe); header keys deferred (SECURITY_REVIEW.md F-03).
- **D-5 Operator-serializer PII minimization.** Tenant name/email remain visible to case-work roles by operational necessity; Investor cannot reach those routes. Field-level minimization deferred (SECURITY_REVIEW.md F-02).
- **D-6 Manual AT pass + skip-link + `--red` contrast.** See ACCESSIBILITY_AUDIT.md residuals R-1–R-3 (app-shell concerns outside the finance lane, except the AT pass recommended pre-launch).
- **D-7 Q8 engine extension.** The returns/projection engine follows the spec formulas until the owner amends §§5.1/8.8/15 (IMPLEMENTATION_PLAN §9 Q8). An amendment wait, not a code gap.
- **D-8 Q5 amounts/termination, Q9 override authority, StorageAgreement sign-off.** Owner decisions still open; code BLOCKs/stubs honestly (409 + named messages) instead of guessing.

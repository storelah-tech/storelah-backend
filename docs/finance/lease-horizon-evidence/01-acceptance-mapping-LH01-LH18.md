# LH01–LH18 acceptance mapping (P8)

Verdict per handoff §12.2 ID. **PASS (API/engine)** = asserted by an automated e2e
test (file:line). **visual-pending** = pure-browser interaction (click path, toast
rendering, badge/state visibility) that no automated test can claim — the exact
screen and state to capture are listed. No Playwright was used; no browser
verification is claimed beyond the programmatic PDF byte/label assertions in
`finance-lease-horizon-consumers.test.ts`.

Copy reference: `src/cms/admin/financeWorkspace.js` `LEASE_COPY` (`:831`–`:836`),
`VALUATION_COPY` (`:1193`–`:1194`), Returns stale/pending notes (`:444`, `:479`–`:480`),
lease section (`:941`–`:1085`), valuation section (`:1290`–`:1380`).

| ID | Scenario | Verdict | Covering evidence |
|---|---|---|---|
| LH01 | Change 60→36 + Update: model saves 36 mo, end date + forecast update, success toast | PASS (API/engine); visual-pending (toast) | `tests/e2e/finance-lease-horizon-api.test.ts:90` (PUT 60→48 end-to-end: version, end date, audit, event); `:192` (60→36 persisted, read-back 36); `tests/e2e/finance-lease-horizon-consumers.test.ts:202` (term refresh to new version). Toast copy `financeWorkspace.js:836` — capture: Financial Models §4, set 36, Update → toast “Landlord lease updated to 36 months. Forecast horizon, NPV, IRR, payback, monthly lease and budgets are synced.” |
| LH02 | Edit but do NOT Update: forecast + Returns stay on committed value; “Unsaved changes” | PASS (API/engine semantics); visual-pending (badge/buttons) | `tests/e2e/finance-phase2.test.ts:68` (staged commit: nothing mutates until Update); `tests/e2e/finance-lease-horizon-api.test.ts:251` (stale revision never read). UI: `financeWorkspace.js:255` (sectionActions dirty gating), `:941` (`data-lh-undo`/`data-lh-update` disabled until dirty) — capture: §4 with edited-but-unsaved term → badge “Unsaved changes”, Update enabled, Returns unchanged |
| LH03 | Undo after 60→36: field back to 60; no recalculation, no audit | PASS (engine semantics); visual-pending (click) | Undo is client-staged-draft discard: `financeWorkspace.js:1038`–`:1042` (`leaseUndoClicked` → `LEASE_COPY.undone` `:831`, no PUT, no audit). API-side guard: `tests/e2e/finance-phase2.test.ts:110` (failed update preserves committed) — capture: §4 60→36 → Undo → field 60, toast “Landlord lease changes undone.”, version unchanged |
| LH04 | 11 months → blocked with range error | PASS | `tests/e2e/finance-lease-horizon-api.test.ts:132` (422 `VALIDATION`, range copy + `fieldErrors.committedTermMonths`) |
| LH05 | 121 months → blocked with range error | PASS | Same test `:132` (121 in the same loop) |
| LH06 | 36.5 months → blocked as non-integer | PASS | `tests/e2e/finance-lease-horizon-api.test.ts:144` (422, “whole number”, `field: committedTermMonths`) |
| LH07 | Extend 36→60 without Y4/Y5 rents: Estimated rows require confirmation | PASS | `tests/e2e/finance-lease-horizon-api.test.ts:154` (422 `LEASE_SCHEDULE_UNCONFIRMED` + leaseYear + schedule; confirmed-estimated retry → 200); engine gate `tests/e2e/finance-projection-v2.test.ts:256`, `:275` (excluded rows stay re-extendable) |
| LH08 | Shorten term: later cash flows excluded; actuals untouched | PASS (engine+API); visual-pending (toast only) | `tests/e2e/finance-projection-v2.test.ts:366` (60→36: identical 36-mo prefix, 24 rows dropped; input never mutated; lease counted once); `tests/e2e/finance-lease-horizon-api.test.ts:217` (shorten-before-posted-actuals BLOCKED with rebase message; pre-term close does not block); actuals purity `tests/e2e/finance-lease-horizon-consumers.test.ts:256` |
| LH09 | Start 15 Dec 2026, 12 mo → end 14 Dec 2027; stubs prorated | PASS | `tests/e2e/finance-lease-term.test.ts:79` (13 rows: 17-day stub + 11 full + 14-day stub); `tests/e2e/finance-lease-horizon-api.test.ts:207` (PUT startDate → `committedEndDate: 2027-12-14`, schedule `2026-12-15→2027-12-14`); `tests/e2e/finance-projection-v2.test.ts:116` (17/31 + 14/31 stubs); `tests/e2e/finance-lease-horizon-consumers.test.ts:375` (persisted-model parity) |
| LH10 | Rent-free 0 → opening lease expense non-zero (prorated only if mid-month) | PASS | `tests/e2e/finance-lease-horizon-consumers.test.ts:131` (first-of-month 5000; mid-month 2741.94 = 5000×17/31; post-horizon 0; pre-start null); method matrix `tests/e2e/finance-projection-v2.test.ts:182`, `:197` |
| LH11 | Budgets shows model-linked lease; total operating cost counts it once | PASS | `tests/e2e/finance-lease-horizon-consumers.test.ts:131` (lease + other opex = total, both models); engine invariant `tests/e2e/finance-projection-v2.test.ts:388`; golden `checks.leaseCountedOnce` (`tests/e2e/finance-projection.test.ts`) |
| LH12 | NPV, IRR, both paybacks, cumulative FCF, PI, DCF refresh to same model version | PASS | `tests/e2e/finance-lease-horizon-consumers.test.ts:162` (committed block at stored 15%: end dates, 36/37 rows, DCF⇄NPV reconcile, rate identified) + `:202` (extend → new version, new end date, NPV changes, inputHash-keyed); `tests/e2e/finance-lease-horizon-api.test.ts:368` (slices labelled “NPV through Year N”, never Project NPV); `tests/e2e/finance-lease-horizon-dcf-export.test.ts:45` (§8.3 columns from the ONE series); `tests/e2e/finance-lease-horizon-consumers.test.ts:298` (projection report: Year-N lease table + committed block + corrected labels) |
| LH13 | Horizon ends before payback → “Beyond horizon” | PASS | `tests/e2e/finance-valuation.test.ts:452` (`Month 32 + 20 days` inside horizon for sembawang60; `Beyond horizon` when recovery never arrives — midMonth12/short36 + synthetic beyond-horizon series); integer `paybackMonth` kept per R10; UI label `financeWorkspace.js:222`, `:224`, `:550` |
| LH14 | Optional renewal: committed case unchanged; renewal separate | PASS | `tests/e2e/finance-valuation.test.ts:376` (committed byte-identical with renewal on/off; separate 60-mo run ending 2031-11-30; input never mutated) |
| LH15 | Concurrent same-version updates → 409, no silent overwrite | PASS | `tests/e2e/finance-lease-horizon-api.test.ts:177` (409 + handoff conflict copy “changed by another user…Reload the latest version”, `{entity, expected, current}`; first revision stands) |
| LH16 | Loading another draft uses that draft's own horizon | PASS | `tests/e2e/finance-lease-horizon-api.test.ts:192` (model A 36 vs model B 60, no leak either way); `tests/e2e/finance-lease-horizon-consumers.test.ts:229` (Returns + Library headlines per draft: 2029-11-30 vs 2029-12-14, headline NPV = returns NPV); D4A fork `tests/e2e/finance-lease-horizon-api.test.ts:283` |
| LH17 | Recalculation fails → FAILED/pending, stale labels, export disabled, retry | PASS | `tests/e2e/finance-lease-horizon-api.test.ts:328` (WACC-incomplete → FAILED, stale returns with `valuationError`, CSV 409 “out of date”, retry-while-broken 422, fix → CURRENT, export 200); DCF parity `tests/e2e/finance-lease-horizon-dcf-export.test.ts:94`; Returns UI states `financeWorkspace.js:479`–`:480`, `:560` |
| LH18 | Base/Upside/Downside share horizon, lease expense, non-lease opex | PASS | `tests/e2e/finance-projection-v2.test.ts:399` (identical horizon/lease/opex across scenarios); sensitivity isolation is suite-pinned in phase 2 (`models.sensitivity-tornado`, `models.scenario-overlay-no-fork` in `tests/e2e/finance-phase2.test.ts`) |

## Visual-pending capture list (browser only — owner/user session)

1. §4 Landlord lease: 60→36 Update → success toast (`LEASE_COPY.success`).
2. §4 dirty state: “Unsaved changes” badge + enabled Undo/Update before Update.
3. §4 Undo: value back to 60 + “Landlord lease changes undone.” toast.
4. §5 linked card: “Committed valuation horizon / 36 months” + “Edit in Landlord lease” jump-focus to §4.
5. Returns: “Committed project valuation / 36 months from 1 Dec 2026” header; DCF selector (First 12 / First 24 / Full horizon); mid-month model shows `2026-12-15→2026-12-31` opening and `2027-12-01→2027-12-14` closing ranges; `Beyond horizon` where applicable.
6. Stale/failed: “Updating from model version {n}” and “Returns are out of date” + disabled export + “Retry calculation”.
7. Budgets read-only model-linked lease line.

## Suite position

`pnpm check` green. Full e2e suite at the P7 baseline (540/541 — the single
known phase4 close-checklist failure, pre-existing and unrelated to this lane).
No `src/` diff in P8.

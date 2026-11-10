# Lease Horizon — prototype parity check (2026-11-10)

Side-by-side test of the worktree CMS (`localhost:4176`, branch `feature/24-lease-horizon`, local
`storelah_lh` DB) against the reference prototype v36
(https://storelah-crm-leads.faisal-0213.chatgpt.site). Both were set to identical inputs: Sembawang launch
template, operational and lease start 1 Dec 2026, S$5,000/month, 15% manual discount rate. Then the term
was set to 60 months, then 36, then a 15 Dec 2026 / 12-month mid-month lease.

Fixed during the test (uncommitted, `src/cms/admin/financeWorkspace.js`):
- `pct()` was undefined in Section 5 (Manual rate field). The whole Financial models page crashed with
  "Finance: pct is not defined". Replaced with the sibling fields' `num(x*100,2)` formatting.
- Section 4 and Section 5 Update buttons rendered with an inverted condition
  (`updateDisabled?'':'disabled'`). After any re-render, Update was enabled with no changes and disabled
  with changes.

## 1. Same logic (verified)

| Area | 60 months | 36 months |
|---|---|---|
| Financial models KPI cards (8) | Identical text | — |
| Month-by-month table (60 rows) | Same rows; ≤ S$1 cell differences from per-row cents rounding (owner D12A) | — |
| Project NPV | S$85,323 both | −S$8,702 vs −S$8,701 (D12A rounding) |
| Project IRR | 39.49% vs 39.5% | 10.74% vs 10.7% |
| Profitability index | 1.79× both | 0.92× both |
| Cumulative FCF | S$192,700 both | S$27,502 vs S$27,503 |
| Discounted payback | see 3.1 | Beyond horizon both |
| Discount factors (first-of-month) | 0.9884207, 0.9769755 … identical | — |
| Scenario IRRs | 24.7% / 39.5% / 50.0% both | — |
| Budgets lease line (Dec 2026, mid-month case) | S$2,742 model-linked read-only; total S$3,400 counted once — identical | — |
| Section order, Undo/Update per section, scenario buttons | Same | — |

## 2. Different on purpose (handoff rules + owner decisions) — owner to confirm

| Item | Prototype | CMS | Rule |
|---|---|---|---|
| Mid-month closing row | Missing — 15 Dec + 12 months stops at Nov 27 | `1–14 Dec 2027` row included | Handoff §1, R2 |
| Discount period after an opening part-month | 2 (DF 0.97698) | 1.548 (DF 0.98213) | Handoff §7.5, R7 |
| Mid-month NPV / FCF / IRR | −S$116,568 / −S$116,138 / −95.9% | −S$115,486 / −S$114,861 / −95.29% | Consequence of the two rows above |
| Decimal term | 36.5 → saved as 37 | API rejects; see 4.1 for the UI | Handoff §12.1, LH06 |
| Extending the term | Commits silently | Estimated rows + per-row Confirm + acknowledgement | Handoff §4.4, LH07 |
| Lease start / end date, rent-free dates, proration selector | Not present | Present | Handoff §4.1, D3A, D6B |
| Updating an approved model | Edits it directly | Forks a draft | D4A |
| DCF table | No Period column; whole dollars | Period column; cents | Handoff §8.3, §13 |
| Section 4 schedule columns | Lease year / Monthly rent / PSF / Payable in term / Basis | Adds Payable months; handoff names | Handoff §4.4 |

## 3. Different logic — fix to match the prototype

1. **Payback label.** Prototype: `Month 31 + 19 days`, `Month 38` (whole months elapsed + round(fraction×30)
   days; days omitted when 0). CMS: `Month 32 + 20 days`, `Month 39 + 0 days` (month in which recovery
   happens + days of that calendar month). `valuation.ts:620`.
2. **Scenario comparison.** Prototype rows: Project NPV, Project IRR, Simple payback, Discounted payback,
   Initial investment, Annual discount rate per scenario (Downside NPV S$35,863, Upside S$115,800). CMS rows:
   occupancy inputs, NOI positive, Cash payback, Cumulative FCF, IRR — no per-scenario NPV or paybacks.
3. **Discount-rate sensitivity.** Prototype: chart at 10/12/15/18/20% + `Test rate` input + `Add to chart`
   + drag slider. CMS: table at 13–17%. Values agree where rates overlap.
4. **Missing Returns blocks:** "Project NPV interpretation" card, "Equity NPV is not calculated" note,
   "Calculation details and data lineage · Show details".
5. **Valuation methodology defaults.** Prototype Risk-adjusted 8%+3%+2%+2% = 15%; WACC 18% / 6.5% / 70:30 /
   17% tax. CMS stores 0 / null, so choosing Risk-adjusted gives 0% and WACC is incomplete.
6. **Section 5 presentation.** Prototype: collapsible card with summary `Manual · 15.0% / 1.171% effective
   monthly · N committed months` and `Expand settings`; methodology is a select; labels "Annual discount
   rate", "Include terminal cash flows", "Refundable lease deposit", "Reinstatement cost at lease end",
   "Other explicit terminal cash flow"; subtitle "Discount rate, lease horizon and explicit terminal
   cash-flow treatment". CMS: always expanded, three buttons, different labels and subtitle
   ("How the committed cash flows are valued").
7. **Renewal result.** Prototype Section 5 shows `Renewal scenario: S$X NPV`. CMS shows only `+N months`;
   `buildRenewalCase` is not wired to `/finance/returns` (LH14 incomplete).
8. **Month-by-month table.** Prototype marks capped move-ins `52 sq ft capped`; CMS does not. Prototype
   month label `Sept 27`, CMS `Sep 27`.
9. **Operating milestones / Calculation checks** have an `Expand` button in the prototype; missing in CMS.
10. **Section 4 `Show projection` year selector** exists in the prototype; CMS always lists every year.
11. **Model library `Audit history`.** Prototype has the button. CMS renders it only in the unused
     `draftLibraryCard` (line 586), so the D5A history view is unreachable.

### WP-3 status (2026-11-10, backend-agent — implemented, browser check pending)

Items 5, 6, 8–11 implemented in the worktree; item 7 (renewal) was done in WP-2. No browser was
available to the implementer — see `08-parity-fixes/WP-3-click-list.md` for the exact clicks and
screenshots still required before any item is marked done.

| Item | Status |
|---|---|
| 5 Valuation methodology defaults | Implemented — server `DEFAULT_VALUATION_ASSUMPTIONS` = risk 8/3/2/2, WACC 18/6.5/70:30/17%, renewal 24; client shows these when a stored field is null, never overwrites stored values. Choosing Risk-adjusted on a fresh model gives 15.0%. E2E `finance-lease-horizon-wp3.test.ts` 6/6. Stored-model numbers unchanged (new + null-only). |
| 6 Section 5 presentation | Implemented — collapsible card with `Manual · 15.0%` / `1.171% effective monthly · N committed months` summary + `Expand settings`; methodology is a select; prototype labels and subtitle; handoff §4.6 linked-term copy kept. |
| 7 Renewal result | Done in WP-2 (browser-verify). |
| 8 Month-by-month table | Implemented — `capped` tag recovered from committed occupancy inputs (engine-mirroring, integer date math); month labels `Sept 27` via the shared month table. |
| 9 Operating milestones / Calculation checks | Implemented — `Expand`/`Collapse` toggles, collapsed by default. |
| 10 Section 4 `Show projection` | Implemented — select in the schedule head (`All N years` / 1 / 2 / 3 / 5 years); handoff columns kept. Option labels to confirm against the prototype. |
| 11 Model library `Audit history` | Already reachable before WP-3 (live library toolbar button + banner History button → server-backed read-only modal, no restore). Browser-confirm only. |

## 4. CMS bugs found (not parity questions)

1. **Decimal term silently truncated in the UI.** Typing 36.5 becomes 36 (`Math.trunc` on input) and
   Update saves 36. Must be blocked with the handoff message (LH06).
2. **Operational start cannot be changed** from the toolbar. Its save sends the old `horizonMonths` field
   (`financeWorkspace.js:663`), and the server rejects it ("horizonMonths: Use the Landlord lease section…")
   after showing a success toast.
3. **Mid-month opening after lease start loses revenue (D6B).** Lease 1 Dec, opening 15 Dec: all of
   December is pre-opening and the 17 trading days earn nothing. The pre-opening gate works on whole
   calendar months (`projection.ts:618–622`). Ops-before-lease zeroes the whole month too.
4. **Year 1 payable wrong when lease starts after operational start**: shows S$57,258 / 11.45 months
   instead of S$60,000 / 12. The first part-month row is grouped by row start date.
5. **Re-extending after a shortening** shows Years 4–5 twice (estimated + "Outside the committed term")
   and does not reuse the kept rents.
6. **`All 60` label is hard-coded** in the month-by-month table even for a 12-month term.
7. **Budget month list** stops at Nov 2027 for a lease ending 14 Dec 2027 (the closing part-month is not
   selectable).
8. **121 months**: Update stays disabled (estimated rows need acknowledgement) and the range error is
   never shown.

## 5. Not covered

Permissions per role in the UI, mobile layout, stale/failed calculation states (§8.5) and Export DCF file
contents were not exercised in this session.

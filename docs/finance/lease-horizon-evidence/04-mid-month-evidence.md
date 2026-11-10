# Mid-month evidence: 15 Dec 2026, 12 months

**Contractual boundary (D1B):** nominal day 15 exists in Dec 2027 →
`committed_end_date = 15 Dec 2027 − 1 day = **14 Dec 2027**`.
Asserted `tests/e2e/finance-lease-horizon-api.test.ts:207` and engine-side
`tests/e2e/finance-lease-term.test.ts:79`.

## Calendar rows (N+1 for mid-month, R2)

13 rows: an opening 17-day stub, eleven full calendar months, a closing 14-day stub.

| Row | Range | Factor |
|---|---|---|
| Opening | 2026-12-15 → 2026-12-31 | 17/31 = 0.548387 |
| Full months | 2027-01 … 2027-11 | 1.0 each |
| Closing | 2027-12-01 → 2027-12-14 | 14/31 = 0.451613 |

Fractional periods run 0, 0.548, 1.548, …, **12.0** (running-sum of factors, R7 —
asserted `tests/e2e/finance-valuation.test.ts:312`; the DCF Period column shows
`0.548` etc., handoff §8.3).

## Lease-expense total vs naive N×rent (D2A explanation)

- 15 Dec 2026 term: lease total **S$60000.00** vs naive 12×5000 = 60000.00
  (diff 0.00) — because 17 + 14 = 31, the December stubs happen to sum to
  exactly one rent.
- Counter-case proving the rule (15 Feb 2027, 12 mo, engine): factors
  14/28 + 11 + 14/29 = **11.982759** rents → lease total **S$59913.79**,
  diff **−86.21** vs naive.

Per D2A this is accepted: actual-days proration does NOT force the closing stub
to be the mathematical complement of the opening stub (that would change the
daily rate in the final month and break invoice reconciliation). The sum of
prorated rents is generally slightly above or below exactly N monthly rents
(accepted deviation recorded in `finance-lease-term.test.ts:149`).

## Committed valuation of the 12-mo mid-month run

| Rate | NPV | Simple payback | Discounted payback | IRR |
|---|---|---|---|---|
| 0% | −114860.66 | Beyond horizon | Beyond horizon | status `valid`, annual −0.95294363 |
| 8% | −115219.40 | Beyond horizon | Beyond horizon | (negative — 12 mo of ramp cannot recover S$108,000) |
| 15% | −115486.42 | Beyond horizon | Beyond horizon | |

The negative 12-mo NPV is expected economics (early-stage ramp vs upfront
capital), not a defect: the same engine path prices the 60-mo Sembawang run at
+85322.66 @15%. Payback correctly reports `Beyond horizon` at every rate (LH13
evidence alongside `tests/e2e/finance-valuation.test.ts:452`).

## Closing-stub scaling (R5)

The 14/31 factor scales revenue, non-lease opex, planned move-ins AND churn —
not lease alone (asserted `tests/e2e/finance-projection-v2.test.ts:207`).
Pre-opening variant: revenue/occupancy/move-ins zero before operations while
rent + CapEx + deposit stay on (`tests/e2e/finance-projection-v2.test.ts:306`,
D6B timeline `tests/e2e/finance-lease-term.test.ts:196`).

## Sign-off

| Role | Name | Date | Result |
|---|---|---|---|
| Reviewer (Finance/owner) | _pending_ | _pending_ | _pending_ |
| Calculation check (backend-agent, P8) | backend-agent | 2026-11-10 | end date, stub factors, totals, and D2A deviation as above |

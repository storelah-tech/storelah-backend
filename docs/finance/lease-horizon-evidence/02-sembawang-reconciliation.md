# Sembawang 60-month reconciliation (D13B)

**Method:** the P3 fixture (`tests/e2e/fixtures/finance-lease-horizon-validation.json`)
was derived by an independent Python replica reading NO `src/` code
(`scripts/derive-lease-horizon-valuation.py`; method in `DERIVATION.md`).
The engine side below re-runs `project()` → `buildCashFlowSeries()` →
`analyse()`/`solveIrr()` in-process (throwaway script, no DB) and diffs every
field. Tolerances: money rows $0.01, periods 1e-9, NPV $0.01, IRR 1e-6, PI 1e-6
(fixture `tolerances`; mismatch rule: STOP and report both sides — none found).

**Assumptions (§7.7):** start 1 Dec 2026, 60 mo, 15% annual, S$108,000 initial
outflow, month-1 revenue S$1,015 (rounded illustration; engine uses 1014.91 =
180 × 5.6384), month-1 opex S$6,200 (S$5,000 lease once + S$1,200 non-lease).

## Expected vs engine — series rows (t=0 + 60 months)

| Section | Max abs diff |
|---|---|
| period (fractional months) | 0 |
| revenue | 0 (exact cents) |
| operatingCashFlow | 0 (exact cents) |
| capex | 0 |
| otherCashFlow | 0 |
| cashFlow (net FCF) | 0 |

61 engine rows vs 61 fixture rows; worst diff across ALL sections is **0**.

## §7.7 anchors (asserted `tests/e2e/finance-valuation.test.ts:279`)

| Anchor | Expected | Engine |
|---|---|---|
| Monthly rate (1.15)^(1/12)−1 | 1.1714917% | 1.1714917% |
| Discount factor @ period 1 | 0.9884207 | 0.9884207 |
| Month-1 FCF (illustration) | −5185 (1015 − 6200) | −5185.09 (1014.91 − 6200; unrounded revenue) |
| Month-1 DCF (illustration) | −5124.96 | −5124.96 on the −5185 hand series; live row −5185.09 |

Both the rounded illustration and the live unrounded row hold (test pins both).

## NPV / IRR / paybacks (one identical series)

| Rate | NPV engine | NPV fixture | Diff | Simple payback | Discounted payback |
|---|---|---|---|---|---|
| 0% | 192699.52 | 192699.52 | −8.7e-11 | Month 32 + 20 days | Month 32 + 20 days |
| 8% | 127221.591331 | 127221.591331 | 4.4e-11 | Month 32 + 20 days | Month 35 + 19 days |
| 15% | 85322.663967 | 85322.663967 | −1.5e-11 | Month 32 + 20 days | Month 39 + 0 days |

- IRR: `valid`, annual **0.39491727136449395** both sides, diff **0**.
- Cumulative FCF 192699.52 both sides, diff 0; PI diffs ≤ 1e-15 (display-level).
- 0%-rate run: NPV == cumulative FCF (192699.52); discounted payback ==
  simple payback (Month 32 + 20 days) — undiscounted identity holds.

## Deposit / reinstatement placement

| Case | Terminal | Lands on | t=0 |
|---|---|---|---|
| `terminalFull60` | +10000 (15000 − 5000) at index 60 | 2031-11-30 (committed end) | −108000 |
| `terminalShort36` | +10000 at index 36 | 2029-11-30 (committed end) | −108000 |
| `depositSunkShort36` (terminal flows OFF) | none (`terminalApplied: false`) | — | −123000 (15000 deposit sunk in capital, R11) |

Asserted `tests/e2e/finance-valuation.test.ts:333` (R11 limitation + t=0 shape)
and `:349` (truncation: deposit + reinstatement move with the term).

## Sign-off (D13B — REQUIRED before release)

| Role | Name | Date | Result |
|---|---|---|---|
| Reviewer (Finance/owner) | _pending_ | _pending_ | _pending_ |
| Calculation check (backend-agent, P3/P8) | backend-agent | 2026-11-10 | engine vs fixture: worst diff 0 (series), ≤ 1e-10 (NPV), 0 (IRR) — see above |

> If a current Sembawang spreadsheet exists, use it as an additional comparison
> source, investigate every difference, and do not automatically treat its
> formulas as correct (OWNER_DECISIONS D13). If none exists, this signed-off
> fixture is sufficient and development is not blocked.

# P3 valuation fixture — derivation note (D13B)

Fixture: `finance-lease-horizon-validation.json` (this folder).
Generator: `scripts/derive-lease-horizon-valuation.py` (Python 3, stdlib only).
Status: **unsigned** — Finance/owner sign-off pending (fields below).

## Method (independent of the TypeScript engine)

1. Re-implemented the handoff formulas from scratch in Python, reading no
   `src/` code: D1B end dates, calendar-row enumeration, anniversary
   lease years, actual-days lease expense with anniversary + rent-free splits,
   row-indexed ramp/churn with the target cap, anniversary pricing uplift,
   cents-rounded NOI rows, running-sum fractional periods, `t=0 =
   -(capital + deposit)`, terminal placement at the exact committed end,
   dated NPV / scan-then-bisect IRR / interpolated paybacks / PI / DCF.
2. Rounding mirrors the contract: `floor(x*100+0.5)/100` (== JS `Math.round`
   for every input) for money, unrounded factors/rates/DFs internally.
3. Triangulated the Sembawang 60-month months 1–12 against the COMMITTED
   golden fixture `finance-projection-golden.json` (§28): worst diff
   **0.000000** (exact cents agreement, verified at generation time).
4. Hand-verified anchors (asserted in `finance-valuation.test.ts`):
   - §7.7: monthly rate `(1.15)^(1/12)−1` → **1.1714917%**; DF at period 1 →
     **0.9884207** (7dp); month-1 FCF **−5185** (1015 − 6200) → DCF
     **−5124.96**. Note: the live projection month-1 NOI is **−5185.09**
     (revenue 1014.91 = 180 × 5.6384, unrounded); §7.7 uses the rounded 1015
     illustration. Both hold; the test pins both.
   - Multiple-IRR series `[−100, +250, −150]` (periods 0,1,2): exact monthly
     roots **0** and **0.5** (factor: −100(1+m)² + 250(1+m) − 150 = 0 ⟺
     50m(1−2m) = 0); annualised second root 1.5¹²−1 = 128.74633789….
   - Partial rent-free Jan: 5000×16/31 = **2580.65**; leap-day opening lease
     5000/29 = **172.41**; month-end opening lease 5000/31 = **161.29**;
     Dec-2027 straddle 5000×14/31 + 5500×17/31 = **5274.19**; pre-opening Nov
     5000×16/30 = **2666.67** + opex 640.
   - Renewal: 36 mo + 24 mo renewal = 60-mo run ending **2031-11-30** with the
     terminal (+10000) at index 60; committed input JSON unchanged.

## Regeneration

`python3 scripts/derive-lease-horizon-valuation.py` — exits non-zero if the
golden triangulation fails. Re-run after any economic-assumption change, then
re-run `finance-valuation.test.ts`.

## On mismatch (release gate, D13B)

If fixture values disagree with the engine beyond tolerance ($0.01 rows/NPV,
1e-9 periods/payback fractions, 1e-6 IRR/PI): **STOP and report both sides.
Do not silently fix either side** — owner sign-off required.

## Sign-off

| Role | Name | Date | Result |
|---|---|---|---|
| Reviewer (Finance/owner) | _pending_ | _pending_ | _pending_ |
| Calculation check | backend-agent (P3) | 2026-11-09 | engine vs fixture: see test report |

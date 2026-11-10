# Truncation evidence: 60 → 36 months

**Question answered:** what exactly changes when the committed term shortens
from 60 to 36 months (same economics otherwise — `short36` shares the
`sembawang60` economics; the 36-mo prefix is byte-identical, asserted
`tests/e2e/finance-valuation.test.ts:349`).

## Before / after

| Item | Before (60 mo) | After (36 mo) |
|---|---|---|
| Series rows (t=0 + months) | 61 | 37 |
| Excluded months | — | **24 (months 37–60)** — excluded from the committed case, never deleted from history |
| Committed end | 2031-11-30 | 2029-11-30 (terminal items move here when enabled) |
| 36-mo prefix | — | byte-identical to months 0–36 of the 60-mo run (`JSON` equality, test `:349`) |

## NPV / IRR / payback deltas (one identical series per run)

| Rate | NPV 60 mo | NPV 36 mo | Delta |
|---|---|---|---|
| 0% | 192699.52 | 27501.76 | −165197.76 |
| 8% | 127221.59 | 6196.61 | −121024.98 |
| 15% | 85322.66 | −8702.14 | −94024.81 |

| Metric | 60 mo | 36 mo |
|---|---|---|
| IRR (valid, same-series solve) | 0.39491727 | 0.10742701 (delta −0.28749026) |
| Simple payback | Month 32 + 20 days | Month 32 + 20 days |
| Discounted payback @8% | Month 35 + 19 days | Month 35 + 19 days |
| Discounted payback @15% | Month 39 + 0 days | **Beyond horizon** (recovery needs month 39 > 36) |

Read: at 15% the shortened term never recovers the S$108,000 outflow inside the
committed window (NPV −8702.14), so discounted payback correctly reports
`Beyond horizon` instead of a month number (handoff §8.5; LH13).

## Terminal move on shorten (handoff §7.6)

- Terminal ON: +10000 (deposit 15000 − reinstatement 5000) sits at index 60
  (`terminalFull60`, end 2031-11-30) → moves to index 36 (`terminalShort36`,
  end 2029-11-30). No other row carries `otherCashFlow`.
- Terminal OFF: deposit stays sunk — t=0 is −123000, every month's
  `otherCashFlow` is 0 (`depositSunkShort36`, R11).

## API-level refresh (same revision discipline)

`PUT …/landlord-lease` 36→48 re-runs projection + valuation in the new revision;
`GET /finance/returns` returns the committed block keyed to the new
`modelVersion`/`inputHash` with the new end date and a changed NPV
(`tests/e2e/finance-lease-horizon-consumers.test.ts:202`).

## Sign-off

| Role | Name | Date | Result |
|---|---|---|---|
| Reviewer (Finance/owner) | _pending_ | _pending_ | _pending_ |
| Calculation check (backend-agent, P8) | backend-agent | 2026-11-10 | prefix-identical; deltas as above; no unexplained variance |

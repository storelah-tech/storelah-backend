# Shadow report — demonstration + P9 prod procedure (D11A)

**Script:** `scripts/lease-horizon-shadow.ts` (P2, READ-ONLY — one `findUnique`,
no writes, no recalculation, no audit events; prints no secrets).
Full transcripts: `shadow/shadow-first-of-month-60mo.txt`,
`shadow/shadow-mid-month-12mo.txt`.

## Demonstration (JSON fixtures, zero DB touch)

Command shape (file path preferred — no DB connection at all):

```sh
pnpm tsx scripts/lease-horizon-shadow.ts <modelId | path/to/model.json>
```

### A. First-of-month 60-mo (golden fixture — R14 lock)

Input: `tests/e2e/fixtures/finance-projection-golden.json` (`{input}` wrapper).

- v1 engine=`finance-projection/1` rows=60; v2 engine=`finance-projection/2` rows=60.
- Every row identical to the cent (revenue / lease / NOI / cash).
- Totals: revenue 672699.52 = 672699.52; lease 300000 = 300000;
  cash-end 192699.52 = 192699.52.
- KPIs: payback 32 = 32; IRR 0.3949172713645086 both; years 5 = 5.
- `v2 checks: all pass`.

**Reading:** first-of-month models change number not at all under v2 —
the upcast + bucket engine is a pure refactor for them. These can be
regression-tested in bulk in the same report.

### B. Mid-month 12-mo (fixture-derived v2 input — 15 Dec 2026)

- v1 rows=12; v2 rows=**13** (the closing stub `2027-12-01→2027-12-14`).
- Rows 1–12 match to the cent (incl. opening stub lease 2741.94 = 5000×17/31).
- Row 13 (v2 only): revenue 4077.84, lease 2258.06 (= 5000×14/31),
  NOI +1277.84.
- Totals: revenue v1 63461.50 → v2 67539.34 (+4077.84);
  lease v1 57741.94 → v2 60000.00 (+2258.06);
  cash-end v1 −116138.50 → v2 −114860.66 (+1277.84 — exactly the stub NOI).
- KPIs: payback null = null (beyond horizon both); IRR −0.9596 → −0.9463
  (integer-period KPI series; the committed fractional-period valuation IRR is
  −0.95294363 — different metric, same series family).
- `v2 checks: all pass`.

**Reading (the investigated diff, handoff §14 steps 3–4):** v1 drops the final
14-day stub — it under-counts closing revenue AND closing lease, net +1277.84
to v2's closing cash. Every mid-month CURRENT model shows this shape: one
extra closing row, lease total moving toward (but per D2A not exactly onto)
N×rent, NPV/IRR/payback shifting by the stub's contribution. No other
systematic variance exists in the demonstration.

## Per-model report shape (D11A — every row required)

For each affected model the P9 report must record:

1. model + facility;
2. old and new lease end dates;
3. old and new lease cash flows by affected month (the shadow rows);
4. old and new Project NPV, IRR and paybacks (committed fractional-period
   figures from `/finance/returns`, not the integer-period KPI line);
5. explanation of each variance (template: “closing stub {range}: revenue
   {x}, lease {y}, net {z} — previously dropped by v1”);
6. reviewer + approval status.

## P9 prod procedure (read-only; owner-gated)

```sh
# 1. Point at prod with a READ-ONLY connection (direct or pooled read URL).
#    NEVER run the shadow against prod with a write-capable role.
# 2. Prefer JSON snapshots over live ids where possible:
pnpm tsx scripts/lease-horizon-shadow.ts path/to/model-snapshot.json
# 3. Or pass a live model id (single findUnique, no writes):
pnpm tsx scripts/lease-horizon-shadow.ts <modelId>
```

Rules (D11A, handoff §14):

- Produce the row-level report for every CURRENT model first.
- **NO auto-migration on changed CURRENT models**: any CURRENT model whose
  result changes (every mid-month one will, by the stub) requires owner/Finance
  review of that model's report BEFORE the new calculation result is enabled
  for it (rollout gating; handoff §14 steps 6–9).
- First-of-month models with zero diffs are regression evidence, not approvals.
- Keep the rollback path: prior model revision stays restorable; source
  assumptions are never deleted.
- Finance-Admin-first UI enablement; downstream Investment Returns refresh only
  after sign-off (handoff §14 steps 6–8).
- Approval recorded per model: reviewer name, date, result — the same SIGN-OFF
  block shape as `02-sembawang-reconciliation.md`.

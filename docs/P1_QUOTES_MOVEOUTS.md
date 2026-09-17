# P1 item 4 — Quotes + Move-outs (design note)

## Quotes: no table, by design

A "quote" is a **Lead in stage `PROPOSAL_SENT`** with unit options resolved
**live** from current inventory (`GET /quotes`, `src/core/quotes.ts`).

Why `PROPOSAL_SENT` + unit link suffices instead of a Quote model:

1. A quote is pipeline state, not a snapshot. Snapshotting unit + rate at
   quote time goes stale the moment `adjustRate` moves a rate or the unit
   leases; the live read (`AVAILABLE` units matching `preferredBranchId` /
   `preferredSize`) is always truthful.
2. The lifecycle is already modelled: `PROPOSAL_SENT → WON` (+ `Booking`) on
   conversion, `→ LOST` + `lossReason`/`lossValue` on loss. Stage moves reuse
   `PATCH /leads/:id` — no second state machine to keep in sync.
3. Value is already tracked (`Lead.monthlyRate`, pipeline analytics, promo
   performance). A Quote table would duplicate all three.

If quotes ever need snapshots (e.g. price-locked offers with expiry), add a
`Quote` model additively then — the read-model endpoints keep their shape.

## Move-outs: explicit state machine, no auto-flip

- `GET /move-outs` reads `TenantStatus.NOTICE` tenants + their latest `Notice`
  row (`src/core/tenants.ts listMoveOuts`). Tenants with no notice row still
  list (operator-set NOTICE); `noticeCount`/`lastDay` are null then.
- `PATCH /move-outs/:tenantId { action }` is the **only** path that flips
  tenant status here:
  - `complete`: `NOTICE → INACTIVE`, unit released to `AVAILABLE`.
  - `cancel`: `NOTICE → ACTIVE`, unit untouched.
- Customer `Notice` submission (portal) **never** flips `Tenant.status`
  (unchanged — see the `Notice` model docs). Non-NOTICE tenants 409.

# Lease Horizon — P8 acceptance + reconciliation evidence (D13B)

**Feature:** Committed lease term / Lease Horizon (Financial Models + Investment Returns).
**Phase:** P8 (docs + evidence only — zero behaviour changes; `src/` untouched).
**Date:** 2026-11-10. **Engine:** `finance-projection/2`.
**Independent fixture:** `tests/e2e/fixtures/finance-lease-horizon-validation.json` +
`DERIVATION.md` (unsigned — Finance/owner sign-off pending, see `02-sembawang-reconciliation.md`).
**Generation:** pure-engine recon via throwaway script (no DB) + shadow CLI on JSON
fixtures (read-only) + sample artefacts via the CMS API against the isolated
harness test DB (`storelah_test`, never dev/prod, never `db:seed`).

## Contents

| File | Covers |
|---|---|
| `01-acceptance-mapping-LH01-LH18.md` | LH01–LH18 verdict + covering e2e file:line; browser-only parts marked `visual-pending` with the exact screen/state to capture |
| `02-sembawang-reconciliation.md` | P3 60-month fixture expected-vs-engine (max abs diff per section, §7.7 anchors, NPV @0/8/15%, IRR, paybacks, deposit/reinstatement) + unsigned SIGN-OFF block (D13B) |
| `03-truncation-60-to-36.md` | 60→36 before/after (excluded months, terminal move, NPV/IRR/payback deltas) |
| `04-mid-month-evidence.md` | 15 Dec 2026 12-mo end date 14 Dec 2027 + stub factors + lease-expense total vs naive N×rent with the D2A explanation |
| `05-shadow-report-and-p9-procedure.md` | Shadow-report demonstration (first-of-month + mid-month outputs) + exact P9 prod procedure; rule: NO auto-migration on changed CURRENT models |
| `06-sample-artefacts-checklist.md` | Sample PDFs (36-mo + mid-month) + DCF CSVs with the numbers/labels checklist; visual layout review stays with the user |
| `shadow/` | Full CLI transcripts (`shadow-first-of-month-60mo.txt`, `shadow-mid-month-12mo.txt`) |
| `artefacts/` | Generated PDFs, month-table CSVs, DCF CSVs, committed-returns JSONs |

## Reproduction

- Recon numbers: throwaway pure-engine script (imports `src/core/finance/*` only,
  no DB). Re-run `finance-valuation.test.ts` — every figure below is asserted there.
- Shadow: `pnpm tsx scripts/lease-horizon-shadow.ts <modelId | path/to/model.json>`
  (read-only; prefers a JSON file — see `05-shadow-report-and-p9-procedure.md`).
- Artefacts: CMS API on the harness test DB (`storelah_test`), models created via
  `POST /api/v1/cms/finance/models` + `PUT …/landlord-lease` — never `db:seed`.

## Gate status

- `pnpm check` green; full e2e suite at the P7 baseline (see `01-…` footer).
- No `src/` changes in P8 (docs + `docs/` artefacts only, plus the launch-config
  note below).
- Launch config: no `.vscode/` or tracked launch config exists in-lane, so the
  `backend-lease-horizon` port-4176 entry has NO in-lane pattern to follow —
  reported, not guessed (see Note in the P8 report).
- `visual-pending` browser captures are listed per LH ID in `01-…`; no Playwright,
  no new dependencies (per brief).

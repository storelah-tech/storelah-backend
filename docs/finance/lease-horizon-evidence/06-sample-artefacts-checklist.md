# Sample artefacts — numbers/labels checklist (f)

Generated 2026-11-10 via the CMS API against the isolated harness test DB
(`storelah_test` — created through `POST /finance/models` +
`PUT …/landlord-lease`, never `db:seed`). Both models use the default 15%
manual rate (D7A) and flat S$5,000 schedule rents.

| Artefact | Model |
|---|---|
| `artefacts/model-36mo-first-of-month.report.pdf` (20320 B) | 36 mo, start 2026-12-01, end 2029-11-30 |
| `artefacts/model-36mo-first-of-month.export.months.csv` | month table + `period_start,period_end` |
| `artefacts/model-36mo-first-of-month.export.dcf.csv` | §8.3 DCF at the stored rate |
| `artefacts/model-36mo-first-of-month.returns.json` | committed block (version-keyed) |
| `artefacts/model-12mo-mid-month.report.pdf` (16425 B) | 12 mo, start 2026-12-15, end **2027-12-14** |
| `artefacts/model-12mo-mid-month.export.months.csv` | incl. stub rows `2026-12-15→2026-12-31`, `2027-12-01→2027-12-14` |
| `artefacts/model-12mo-mid-month.export.dcf.csv` | fractional `period_months` (`0.548`, …, `12`) |
| `artefacts/model-12mo-mid-month.returns.json` | committed block (version-keyed) |

## Numbers checklist (all verified programmatically)

- [x] Both PDFs start with `%PDF-` (valid PDF bytes).
- [x] 36-mo DCF final row: `cumulative_dcf_sgd −8702.14` == committed NPV
  `−8702.141330806502` (rounds to it; D12A cents display). Matches the
  independent recon `short36 @15%` figure to the cent.
- [x] Mid-month DCF final row: `−115486.42` == committed NPV `−115486.41505225445`.
- [x] Mid-month DCF t=0 row binds the server commencement date (`2026-12-15`,
  period `0`); opening stub row carries period `0.548` and date range
  `2026-12-15→2026-12-31`; closing row period `12`, range
  `2027-12-01→2027-12-14` (handoff §8.3 exact-range requirement).
- [x] Mid-month month-table: 13 data rows; first row lease 2741.94
  (5000×17/31), last row lease 2258.06 (5000×14/31); both rows carry
  `period_start,period_end`.
- [x] 36-mo month-table first row: revenue 1014.91, lease 5000, NOI −5185.09
  (§7.7 live row).
- [x] `returns.json` committed blocks: `annualRate 0.15`, `annualRateSource
  manual`, `committedEndDate` 2029-11-30 / 2027-12-14, `modelVersion`-keyed,
  DCF length = months + 1.
- [x] PDF text layer contains: `Project NPV`, `Committed project valuation`,
  `Beyond horizon`, `DRAFT` (non-approved stamp), `36 months` / `12 months`,
  `NPV through Year 3` (36-mo report).
- [x] Every export wrote an `EXPORT_GENERATED` audit event + `export.generated`
  outbox row (route-tested `tests/e2e/finance-lease-horizon-dcf-export.test.ts:75`).

## Labels checklist (visual layout review STAYS WITH THE USER)

Programmatic label presence above does not prove layout. When reviewing the
PDFs by eye, confirm:

1. 36-mo report: “Project NPV (36-month committed term)” headline figure;
   “NPV through Year 3” supplementary label (never bare “Project NPV” on a
   truncated slice); committed horizon + stored 15% rate identified on every
   valuation surface.
2. Mid-month report: stub date ranges readable in the DCF/month tables; `Period
   0.548`-style fractional labels; `Beyond horizon` payback rendering.
3. DCF CSVs open cleanly (10 §8.3 columns, UTF-8, no thousand separators).
4. `DRAFT` stamp present (both sample models are unapproved — by design).
5. No PII, no secrets, no connection strings in any artefact.

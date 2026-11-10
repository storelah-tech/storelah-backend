# WP-2 to WP-4 browser check (2026-11-10)

Checked by the Claude Code orchestrator session in a real browser, side by side with prototype v36
(https://storelah-crm-leads.faisal-0213.chatgpt.site), after backend-agent reported WP-2, WP-3 and WP-4
without browser access. Worktree CMS `localhost:4176`, local `storelah_lh` DB, test models "LH verify 5735"
(1 Dec 2026 / 60 months / S$5,000 / 15% manual, as the prototype) and a new "LH P7 fresh" model.

Automated: `pnpm check` green, `node --check financeWorkspace.js` OK, full e2e **566/567** (only the known
`finance-phase4` close-checklist failure).

## Pass

| Item | What was seen |
|---|---|
| **B9** false conflict | Toolbar Operational start PUT `/inputs` 200 → Section 4 Update PUT `/landlord-lease` 200; then ops start again → Section 5 Update PUT `/valuation` 200 ×2. No "changed by another user". **Fixed.** |
| B1 / B5 / B8 regression | 36.5 kept + inline whole-number error + Update disabled; 121 → range error; 48 → 60 restores Year 5 as Entered |
| P1 payback label | `Month 31 + 19 days` / `Month 38` — same as prototype |
| P2 scenario NPV / IRR / simple payback | S$35,862 / 85,323 / 115,799 vs S$35,863 / 85,323 / 115,800 (D12A); IRR and simple paybacks identical |
| P3 sensitivity values | 10/12/15/18/20% = 114,034 / 101,868 / 85,323 / 70,566 / 61,602 (prototype ≤ S$1); 25% = S$41,806, equal to the NPV of the committed series |
| P4 blocks | Interpretation card, Equity NPV note, "Calculation details and data lineage · Show details" (expands) present |
| P5 renewal | Renewal NPV **S$164,656** — identical to prototype; IRR 48.17%; committed NPV unchanged S$85,323 |
| P6 rows | Select `First 12 / First 24 / Full lease horizon` |
| P7 defaults | New model stores risk 8/3/2/2 (=15%), WACC 18/6.5/70:30/17% (→14.22%), renewal 24 |
| P8 Section 5 | Collapsed summary `Manual · 15.0%` / `1.171% effective monthly · 60 committed months` / Expand settings; methodology select; prototype labels and subtitle |
| P10 month table | 60 rows, 43 capped months (first May 28 `110 sq ft capped`) — identical to prototype; `Sept 27` labels |
| P11 Expand | Calculation checks + Operating milestones collapse/expand |
| Stale / failed (LH17) | Incomplete WACC → FAILED: Returns banner + last-success time, Publish disabled with reason (Returns and Library), Export hidden, Retry → 422 stays failed; switching to Manual + Update → CURRENT, Publish/Export re-enabled |
| Export DCF | 62 lines (header + t=0 + 60), values equal the screen, last cumulative S$85,322.66 = NPV |
| Mobile 375 px | No horizontal page scroll on Returns, Financial models, Model library |

## Open — bugs

1. **Sensitivity test rate defaults to 0%.** Readout "0.00% → $192,700"; Add to chart without typing adds a
   0% point. `sensTestRate()` (`financeWorkspace.js:559`) does `Number(srv.sensTest)` and `Number(null)` is 0,
   so the stored-rate fallback never runs. Prototype starts at the stored 15.0%. Slider starts at 5 (its min).
2. **First "Add to chart" click after typing is lost.** Typing 25 then clicking Add: the field's `change`
   handler re-renders the card (L651) and the clicked button is replaced, so nothing is added; a second click
   adds 25%. Read the field inside the Add handler, or update on `input` without a full re-render.
3. **Slider readout shows "…"** instead of the NPV while dragging, and the number field does not follow the
   slider. Prototype updates both live.
4. **P12 still open — Audit history is unreachable.** No History / Audit history button on Model library,
   Financial models or Returns. The `model-history` button exists only in `renderLibraryV2`/`draftLibraryCard`
   (L686), which the live page does not use; the live `libraryCard` (L1791) has Open / Publish / Delete only.
   WP-3's "already reachable" note is wrong.
5. **Scenario discounted payback differs from the prototype.** Downside `Month 49 + 6 days` vs prototype
   `Month 49 + 11 days`; Upside `Month 32 + 7 days` vs `Month 32 + 10 days`. Base matches (`Month 38`).
   Both use the same interpolation (prototype `npv-engine.js` `paybackPeriod`), and the NPVs agree, so the
   scenario monthly series must differ in timing around months 49–50 / 32–33. Compare the scenario rows
   month by month with the prototype's `npvScenarioRows()` in `financial-model.js`.
6. **ISO dates on screen:** renewal card "+24 months through 2033-11-30"; lineage block
   "2026-12-01 → 2031-11-30". Use the `15 Dec 2026` format.
7. **DCF CSV does not identify the rate, methodology or model version**, while Section 5 says "Every screen
   and exported DCF reads this stored rate and identifies it." Add them (header rows or columns) or fix the copy.
8. **Retry that fails gives no feedback** (POST `/recalculate` 422, page unchanged, no toast).
9. FAILED copy lists all five WACC inputs even when only one is missing (here only cost of debt).

## Open — presentation parity

- Section 4 **Show projection** options: CMS `All 5 years / 1 / 2 / 3 / 5 years`; prototype `1 / 3 / 5 / 7
  years`, default 3 years.
- Section 5: extra header `Expand` button beside `Expand settings` (prototype has only the latter). Expanded
  prototype view has summary tiles — Effective annual rate, Effective monthly rate, Committed valuation horizon,
  **Renewal scenario `Not included` / `$164,656 NPV`** — CMS shows no renewal NPV in Section 5.
- Card order: prototype Operating milestones → Calculation checks; CMS reversed. Prototype buttons read
  `Set target owners · Expand`.
- Returns: prototype shows the **NPV interpretation card first** ("Forecast value exceeds the required
  return"); CMS shows it at the bottom ("Value-creating", different copy). Prototype has an **NPV breakeven
  rate** panel (Below/Above 39.5%, "Current decision check"); CMS has an "Investment breakeven" KPI only.
  Sensitivity chart lacks the prototype's axis titles, the three reading guides and the "why the circles
  cannot be dragged" note (CMS table can stay). KPI subtitles differ (prototype "Manual · 1.171% monthly",
  "$108,000 CapEx · $0 deposit").
- Rows select labels `First 12` vs prototype `First 12 months`.

## Owner notes

- Models created before WP-3 store zeros, so Risk-adjusted shows 0% on them (D7A: stored values are never
  overwritten). "LH verify 5735" is such a model. Owner to decide whether zeros from the old default count as
  "not set".
- opencode's WP-4 role questions: Manager has `bill-lease:update` but no `bill-models:view`, so no lease UI;
  Viewer + `bill-lease:view` alone shows nothing.
- From WP-1: revenue starts at the lease date when opening precedes it; pre-opening days are not labelled.

## Not covered

Role permissions were not clicked through in the UI (no other role accounts on the local DB; API matrix is
covered by `finance-lease-horizon-wp4.test.ts`). Screenshots were viewed but not saved as files.
"LH P7 fresh" was left in the local DB (now CURRENT, manual 15%).

## Round 2 — fixed in the orchestrator session and browser-verified (2026-11-10)

| # | Fix | Browser result |
|---|---|---|
| 1 | `sensTestRate()` treats `null` as "not tested" → stored rate | Test rate starts at 15.00% → S$85,323 |
| 2 | Field/slider update readout + marker live (no re-render); Add reads the field | Type 25 + one click → 25.00% S$41,806 added |
| 3 | Slider 0–100%, live NPV readout, field ↔ slider synced | Drag to 10% → field 10, readout S$114,034, marker moves |
| 4 | Audit history button on every Model library card + toolbar | Opens "Audit history — LH verify 5735", read-only, no restore |
| 5 | Payback interpolates on the series' own row increment (`valuation.ts`; same fix in `scripts/derive-lease-horizon-valuation.py`, fixture regenerated — only `discountedPayback` fields changed) | Downside Month 49 + 11 days, Base Month 38, Upside Month 32 + 10 days — identical to prototype. Before: 49 + 6 / 38 / 32 + 7. NPV, IRR, simple payback unchanged. Fixture discounted-payback changes: sembawang60/short36/term120 @8% Month 34 + 18 → + 23 days; terminalFull60 @8% 37 + 16 → + 20, @15% 41 + 11 → + 18 |
| 6 | Renewal end date and lineage window use `1 Dec 2026` format | Lineage "1 Dec 2026 – 30 Nov 2031" |
| 7 | DCF file name `financial-model-<id>-v<ver>-<rate>pct-<method>-dcf.csv`; Section 5 copy corrected; CSV columns unchanged | `…-v44-15pct-manual-dcf.csv` |
| 8 | No change — re-test shows a failed Retry already toasts "The lease was saved, but investment returns could not be recalculated…" (first check missed the toast) | — |
| 9 | WACC error names only the missing inputs | "WACC needs cost of debt — enter it or use the manual rate." |

Presentation parity, all verified: Returns order (interpretation card first with prototype wording, 8 KPI cards with prototype subtitles, Equity NPV note, sensitivity with reading guides + axis titles + read-only note, NPV breakeven rate panel with decision check, DCF table with "First 12 months / First 24 months / Full lease horizon", scenario comparison with IRR/rate at 1 dp, renewal). Section 4 Show projection 1 / 3 / 5 / 7 years (default 3; unconfirmed Estimated years are always shown; out-of-term years listed only when all years are shown). Section 5 header shows "Collapse settings" only when expanded; expanded view has the four prototype tiles incl. Renewal scenario. Operating milestones before Calculation checks, buttons in prototype order. 375 px: no horizontal scroll on the three screens.

Checks: `pnpm check` green; full e2e 571/573 — the known phase4 close-checklist failure and one `cms-facility-scope` failure caused by a momentary "Can't reach database server" (re-run alone 7/7 twice). New `tests/e2e/finance-lease-horizon-round2.test.ts` (6 tests).

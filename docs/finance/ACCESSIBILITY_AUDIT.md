# Finance Module — WCAG 2.2 AA AUDIT (Phase 5)

Date: 2026-10-30 · Scope: 12 finance views (`finance*View.js`) + top journey
nav + left subcategory list + new Investor Summary view.
Method: code-level audit per the ui-ux-reviewer skill workflow (inspect
implementation, map states, judge against WCAG 2.2 + APG). No live
browser/AT run was available in the worktree lane — dynamic behaviour
(focus order, screen-reader announcements) is verified by code path, not by
an assistive-technology pass. A manual AT check before public launch is
recommended (see Residual).

## What was already working

- Navigation is native `<button>`/`<select>` elements throughout (journey nav,
  subtabs, filters) — keyboard operable with no extra code.
- The models SVG chart already carries `role="img"` + `aria-label`.
- The Review & Approve dialog already carries `role="dialog"` + `aria-label`.
- All async views funnel through four shared states (loading / empty /
  error / permission-denied) in one helper — one fix covers all 13 views.
- No information is conveyed by colour alone: PASS/FAIL badges pair colour
  with text, negative cash/variance carries a minus sign, N/A patterns are
  words ("Not available" + reason), never bare colour.
- No PII or draft state in URLs (hash + safe query params only).

## Findings and fixes (all fixed in Phase 5 unless noted)

1. **Async states had no live region (4.1.3).** FIXED — `renderLoading /
   renderDenied / renderEmpty` now render `role="status" aria-live="polite"`;
   `renderError` renders `role="alert"`. Covers all 13 views at once.
   (Investor view additionally sets its host to `role="status"`.)
2. **Table headers had no scope (1.3.1).** FIXED — every `<th>` in all 13
   finance views now carries `scope="col"`.
3. **Tables had no accessible name (1.3.1/2.4.6).** FIXED — every finance
   `<table>` now carries a specific `aria-label` (e.g. "Arrears recovery
   cases", "Posted actuals for closed months"). Chosen over visible
   `<caption>` to avoid restyling frozen layouts.
4. **Placeholder-only inputs had no label (3.3.2).** FIXED — budget
   category/amount, expense category/amount/date/vendor/receipt-ref, and the
   library search input now carry `aria-label`s. (The returns discount input
   was already wrapped in a `<label>`.)
5. **No visible focus indicator outside sign-in (2.4.7/2.4.11).** FIXED — a
   global `:focus-visible` rule (2px solid deep olive, ≈12:1 on paper, so the
   indicator itself passes 3:1) now covers buttons, links, inputs, selects,
   textareas and `[tabindex]` app-wide.
6. **Dialog: no Escape, no focus management (2.1.1/2.4.3).** FIXED — the
   Review & Approve modal now closes on Escape, moves focus into the dialog
   on open, and restores focus to the opener on close.
7. **No reduced-motion guard (2.3.3).** FIXED — `@media
   (prefers-reduced-motion: reduce)` zeroes animations/transitions app-wide.
   (Finance charts are static SVG renders — no JS animation to gate.)
8. **Investor print view (1.4.x print legibility).** ADDED — print button +
   `@media print` rules that isolate the masked summary on paper (nav,
   tabs, buttons and other panels hidden; cards kept unbroken with visible
   borders). The watermark banner prints with the summary.

## Contrast spot-checks (text on backgrounds, AA ≥ 4.5)

- `--muted` #6f746d on paper #fffdfa ≈ **4.78:1** — passes.
- PASS #1a7f37 / FAIL #b42318 on white — pass (dark literal values).
- Focus outline olive #334437 on paper ≈ **12:1** — passes 3:1 indicator bar.
- `--red` #c9574e on white ≈ **4.27:1** — BELOW 4.5. Used for `.deal .flag`
  and `.trend.bad` in NON-finance screens (deals/trends); no finance view
  renders body text in `--red`. Recorded as a pre-existing, out-of-scope
  finding for the owning lane — not fixed here.

## Keyboard path (by code inspection)

Tab order follows DOM (filters → content → actions) in every view; subtabs,
journey buttons and modal buttons are reachable and operable; `guardHiddenClicks`
blocks activation of permission-hidden tabs for keyboard/click alike (server
403s back it). Skip-link: none exists app-wide — consistent with the rest of
the CMS; not introduced or fixed here (see Residual).

## Residual (deferred, not finance-blockers)

- R-1: Manual screen-reader + keyboard-only pass over the 13 views on a
  staging build (NVDA/VoiceOver) — recommended before public launch.
- R-2: App-wide skip-link — belongs to the CMS shell, not the finance lane.
- R-3: `--red` 4.27:1 text in deals/trends screens — owning lane's call.
- R-4: Data tables have no `scope="row"` (no row-header cells exist — all
  finance tables are column-header only, so `scope="col"` suffices).

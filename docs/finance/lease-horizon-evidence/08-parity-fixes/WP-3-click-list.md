# WP-3 browser verification click-list (2026-11-10, backend-agent — NO BROWSER ACCESS)

Implemented in the worktree but **not browser-verified by the implementer** (this environment has no
browser tool; the prototype could not be scraped — its detail screens are JS-rendered). Automated checks
are green: `pnpm check`, `node --check src/cms/admin/financeWorkspace.js`,
`tests/e2e/finance-lease-horizon-wp3.test.ts` 6/6, full `pnpm test:e2e` 562/563 (only the known
`finance-phase4` close-checklist failure). **Do not mark any item done until a human (or a browser
session) has done the clicks below side by side with the prototype v36**
(https://storelah-crm-leads.faisal-0213.chatgpt.site → Finance Management) **and saved screenshots here.**

Test bed: `http://localhost:4176/admin/` (worktree server, local `storelah_lh` DB). Test model
"LH verify …" on Sembawang may be edited freely; **reset it to 1 Dec 2026 / 60 months when done.**
Keep the dev-server console open — the Section-5 `pct` crash shipped because nobody looked.

## P7 — Valuation methodology defaults

Server: `DEFAULT_VALUATION_ASSUMPTIONS` = risk 8/3/2/2, WACC 18/6.5/70:30/17% tax, renewal 24.
Client: null stored fields display these defaults; stored numbers are never overwritten (D7A).

1. Financial Models → **＋ New financial model** (any name) → open Section 5 (collapsed summary should
   read `Manual · 15.0%` / `1.171% effective monthly · 60 committed months`).
2. **Expand settings** → methodology select → choose **Risk-adjusted** → effective rate must read
   **15.0%** (0.08 + 0.03 + 0.02 + 0.02). Screenshot vs prototype Risk-adjusted block.
3. Methodology select → choose **WACC** → fields must prefill 18.00 / 6.50 / 70.00 / 30.00 / 17.00 and
   the effective rate ≈ **14.22%**. (Do not click Update on the shared verify model; use the new model.)
4. Open the existing stored model ("LH verify …") → Section 5 values must be **unchanged** by this
   release (Manual 15%, renewal off). Investment Returns Project NPV must still be **S$85,323**
   (60-month Sembawang case) — P7 changes no stored model's numbers. Record the before/after NPV here.
5. On the scratch model: tick **Enable renewal comparison** → Renewal length must default to **24**.

## P8 — Section 5 layout

1. Section 5 must load **collapsed**: summary `Manual · 15.0%` / `1.171% effective monthly · N committed
   months` + **Expand settings** button. Header keeps Undo/Update + Expand/Collapse.
2. **Expand settings** → methodology is a **select** (not three buttons); labels read **"Annual discount
   rate"**, **"Include terminal cash flows"**, **"Refundable lease deposit"**,
   **"Reinstatement cost at lease end"**, **"Other explicit terminal cash flow"**; subtitle reads
   **"Discount rate, lease horizon and explicit terminal cash-flow treatment"**.
3. The handoff §4.6 linked-term copy must still be there after expanding: "Committed valuation horizon"
   card and the "Committed lease term … Edit lease term" row. Screenshot vs prototype §5.

## P9 — Section 4 `Show projection` year selector

1. Section 4 schedule head now has a **Show projection** select: `All N years` (default), 1/2/3/5 years.
2. Choose **2 years** on a 60-month model → only Years 1–2 render; the key reads
   "Showing 2 of 5 lease years …"; Payable-months / Payable-amount / Basis columns stay.
3. Screenshot vs prototype Section 4 selector (option labels may need aligning to the prototype).

## P10 — Month-by-month table

1. Open a stabilised model (or the 60-month Sembawang case, scrolled past stabilisation): capped
   move-in months must show a **`capped`** tag next to the move-in figure, as in the prototype
   (`52 sq ft capped`).
2. Month labels must read **`Sept 27`** style (not `Sep 27`) — check a September row. Note: this change
   also affects `fmtDayLong` ("15 Sept 2026") and chart/KPI labels, which now use the same table.

## P11 — Operating milestones / Calculation checks

1. Both cards now show an **Expand** button (collapsed by default). Click **Expand** → contents appear,
   button becomes **Collapse**. "Set target owners" / "View definitions" buttons stay alongside.
2. Screenshot vs prototype Expand behaviour.

## P12 — Model library audit history

Already wired before WP-3 (verify, don't re-implement): Model library page → toolbar
**Audit history** button AND the loaded-model banner **History** button → both must open the
**server-backed, read-only** audit modal ("Audit history — …", field-level before/after, "no restore
function in v1"). Confirm there is **no restore control** (D5A). Screenshot the modal.

## B9 retest (fixed in WP-3 as a drive-by — it blocked Section 4/5 Updates)

1. On "LH verify …": change the toolbar **Operational start**, wait for the save toast.
2. Immediately edit Section 4 (or Section 5) and click **Update** → must save **without**
   "This model was changed by another user." (Previously 409; `flush()` now re-fetches the lease block.)

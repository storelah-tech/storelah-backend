# Prototype delta 2026-11-04: gap report against the CMS

Source: [storelah-prototype-updates-2026-11-04.md](storelah-prototype-updates-2026-11-04.md),
the customer's handover from prototype `afa1971`/`e5cebbe` to `7932258`.

Compared against: backend `main` at `dbb58e1` (live CMS). This was checked from the
written handover only. **The handover's source files (`dist/v29-request.js/.css`,
`crm-ux-v2.js`, `financial-model.js`, `crm-refresh.js`, `experience.js`) were not
attached.** Ask for them before UI parity work starts; the finance parity was built from
the prototype source.

Legend:
- **Built:** matches already.
- **Partial:** the data or flow exists, but the UI or rules differ.
- **Missing:** nothing exists yet.
- **Decision:** the prototype conflicts with an earlier owner decision, or is itself
  only a placeholder.

## Leads

| # | Prototype change | CMS today | Status |
|---|---|---|---|
| L1 | Add lead writes `SL-####` into the database and pipeline | `POST /leads` exists and the lead is persisted (cuid id, no `SL-####` display number) | Partial: add a display sequence |
| L2 | Date of enquiry (defaults to today in SGT, editable) | Only `createdAt` exists | Missing: needs a field and a migration |
| L3 | Product fixed to **AC Self-Storage** | No product field | Missing (UI constant) |
| L4 | Personal/Business with company, UEN and **representative** | `type` PERSONAL/BUSINESS/GUEST, plus `companyName` and `uen` | Partial: add `representative` and Business validation |
| L5 | Full lead page with tabs: Overview / Enquiries / Notes & tasks, plus a KPI row | Right-side detail drawer (`leadsDetailDrawer.js`) | Missing |
| L6 | Many enquiries under one master identity, with identity fields locked | Lead groups by `emailNorm`/`mobileNorm`/`leadGroupKey` (`leadsGroups.js`); each enquiry is its own `Lead` row | Partial: the grouping exists, but there is no "Add enquiry from lead" with locked identity and no `ENQ-` ids |
| L7 | Potential value = net monthly × months (6 if not sure), with tooltips | `monthlyRate` and `durationMonths` exist; no value column | Partial |
| L8 | Probability per stage, with the signal scoring described in the tooltip | No probability | Missing. **Decision:** stage base only, or the full score (Q7) |
| L9 | Access frequency dropdown that includes "Not sure" | No field | Missing |
| L10 | Pipeline settings: per-stage probability, ageing, entry rules, automation, lost reasons | Fixed `LeadStage` enum (7 stages) | Missing. **Decision:** the prototype has 9 stages plus Nurturing; ours has 7. Versioning is undefined (Q8) |
| L11 | Appointments are calendar-first with filters and colours; lead appointments lock the lead | `Appointment` model + CRUD; types VIEWING/CALLBACK/VIDEO_CONSULT/MOVE_IN; statuses PENDING/CONFIRMED/DONE/CANCELLED | Partial: needs a calendar UI, and statuses differ (Proposed/Awaiting reply/Ready). Calendar sync is a placeholder (Q10) |
| L12 | Quotation register: `QT-YYYY-#####`, status, expiry, promotion, delivery, void, admin-only draft delete | `Quotation` stores the issued PDF as bytes; `Q-CM…` numbers; email status only | Partial: needs status/expiry/promo/void fields, a register UI and a number format change. **Decision:** keep the existing `Q-` numbers? (Q9) |
| L13 | `@` mentions in notes create an Overview notification | Nothing | Missing: needs a notifications entity |
| L14 | Global Settings › Lead & response SLA (channel targets, business hours, escalation) | Nothing | Missing. The prototype doesn't persist these values either |
| L15 | Minimum 13 px type, 15 px body | Not checked | Partial: CSS pass |
| L16 | Identity check before save | Dedup normalisation (`emailNorm`/`mobileNorm`) exists server-side | Partial. The prototype's version is a placeholder; ours is further along (Q6) |

## Customers

The CMS Customers area has four tabs (Tenants, Bookings, Move-ins, Move-outs) and a
customer-side move-out notice. **There is no Customer 360 profile page.** Most of these
changes need that page first.

| # | Prototype change | CMS today | Status |
|---|---|---|---|
| C1 | Customer profile, tabbed: Overview, Rental & pricing, Billing & payments, Documents, Access, Move-out & transfers, Notes & activity | Tenant list and modal | Missing (the foundation for C2–C8) |
| C2 | Agreement and move-in facts: signed date, move-in, commitment, commitment end, time remaining | `Tenant.moveInDate`; no commitment fields | Partial: data model needed |
| C3 | Services & add-ons, and an Add service request modal | Lead/booking add-ons only | Missing. The prototype only shows a toast here |
| C4 | Unit-level customer ledger (rent, Protection Plan, merchandise, moving, allocations) | Invoices + payments exist in finance | Partial: needs a ledger view per customer/unit |
| C5 | Transfer unit with a calculated settlement → pending Finance approval | `customers.ts` has an UPSIZE/DOWNSIZE/TRANSFER type; no settlement or approval | Missing. Open: does the transfer day count on both units? (Q12) |
| C6 | Staff-entered move-out and last access date → refund `RF-` or charge `CH-` → Finance queue | `GET/PATCH /move-outs`, customer notice, and finance refunds (`/finance/refunds/calculate`, maker-checker approve/pay) | Partial: the refund engine exists. Missing: the closing charge, and staff/portal date locking. Open: is the last access day charged? (Q13) |
| C7 | Special credit/charge categories with a mandatory reason | Refund adjustments exist in finance | Partial |
| C8 | Protection Plan never prorated | Not checked against the refund engine | Verify (Q14) |
| C9 | `@` mentions in customer notes | Nothing | Missing (shared with L13) |

## Finance

The CMS finance UI is a port of the 30 Oct prototype, so most of the model, forecast,
budget and returns behaviour is already built. The newer changes are mainly about
navigation and moving responsibilities between screens.

| # | Prototype change | CMS today | Status |
|---|---|---|---|
| F1 | Remove the 7-step journey bar and "Financial planning & performance" | Present | Missing: removal only |
| F2 | Remove Investor access/invite/role | Investor access button + `bill-investor` (spec Phase 5) | **Decision:** this reverses the spec's investor summary. Remove it, or keep it behind a role? |
| F3 | Larger type, responsive KPIs (3 columns under 1,450 px, 2 under 1,100 px) | 30 Oct CSS | Partial: CSS pass |
| F4 | Overview: 8 periods, lineage, cash/accrual, operational KPIs, CSV | 8 periods + lineage + basis + CSV built; operational KPIs present | Built. Verify the facility filter and custom range use real data (ours already queries the server) |
| F5 | **Transactions, documents & approvals**: one sortable register for invoices, refunds, charges, credit notes, transfers and adjustments; processor reference moves to detail | Payment-instruction register + separate Invoices, Credits and Refunds screens | Missing: a server-side union query and a new UI |
| F6 | Model sections with Update/Undo, NOI margin, 1/3/5-year cash, charts with hover/zoom, proration | `commitModelSection`, `chartCardV2`, `bindChartHover`, server section PUTs | Built |
| F7 | Forecast vs actuals: Budget/Forecast/Actual together, sample actuals labelled | Real posted months only (no sample data) | Built. Our version is stricter |
| F8 | Budgets: read-only linked lease, staged edits, expense ledger | Built (Expense description/status/note) | Built |
| F9 | Size mix: "Xtra Small/Small" labels, guardrails as a collapsible config modal | Sync now uses the live Units names (Locker/Small/Medium/Large); guardrails card is static | Partial. **Decision:** prototype labels or live Units names (we use Units names since 2026-10-31) |
| F10 | Investment returns: single column, period selection, three sensitivity cases, read-only capital | `renderReturnsInvestor`, `simpleSensitivityCards`, "Edit capital assumptions" present | Built. Copy: "Investor return summary" vs "Investment" (Q3) |
| F11 | Model library: Save into the same draft, Save as new, Open, Duplicate, Submit | Server-versioned library (save version / duplicate / submit / approve) | Partial: no "save into the same draft" action (`saveCurrentDraft`); the server already autosaves section edits into the draft |
| F12 | Invoices removed from the sidebar; builder/preview inside the unified register | Invoices is a sidebar item with its own screen | Blocked on F5. **Decision** (Q2) |
| F13 | Arrears: staff can't set Resolved; only payment/reversal/write-off resolves | `financeArrearsView.js` uses RESOLVED | Verify whether staff can set it manually; if so, remove that option |
| F14 | **Credits ledger (WIP)**: no issuing or redeeming; refunds move to Customer (start) and Transactions (approve) | Full credits wallet + refunds maker-checker built to spec | **Decision:** this contradicts the spec decisions recorded for refunds (Q4/Q5) and credits. Hide credits, or keep them? |
| F15 | Reconciliation: typography only | Built | CSS pass |

## Owner decisions needed before a build brief

1. **F2:** remove the investor summary and access, or keep it as an ordinary role?
2. **F14:** take the live credits wallet out of use (WIP), and move refund initiation to
   Customer while approval moves to the unified register?
3. **F5/F12:** where do invoices live? Is the unified register the only financial document
   screen?
4. **F9:** size labels: Units names (current) or Xtra Small/Small/Medium/Large?
5. **L10:** the stage list: keep our 7 `LeadStage` values or adopt the prototype's 9
   plus Nurturing? This needs a data migration either way.
6. **L8:** probability: stage base only, or the full signal score?
7. **L12:** quote numbers: keep `Q-CM…-YYYYMMDD-NN` or switch to `QT-YYYY-#####`?
8. **C5/C6/C8:** proration rules (does the transfer day count on both units, is the last
   access day charged, Protection Plan never prorated) and the deposit rule.
9. The handover's open questions 4, 5, 16 and 20 (persistence, RBAC, approval posting,
   actuals import) apply as well. Several prototype actions are only toasts.

## Suggested order

1. **Finance clean-up** (F1, F3, F13, F15, plus F2/F14 once decided): small, UI-only.
2. **Leads data model** (L2, L3, L4, L7, L9) and **lead page + enquiries** (L5, L6).
3. **Quotation register** (L12) and **Appointments calendar** (L11).
4. **Customer 360 profile** (C1, C2, C4), then **transfer + move-out settlements** (C5–C8),
   which feed **unified Transactions** (F5, F12).
5. **Notifications/mentions** (L13, C9), **Pipeline settings** (L10), **SLA settings** (L14).

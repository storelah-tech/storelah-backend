# StoreLah Finance Management Module

## Feature Specification, UI/UX Contract, Business Logic and End-to-End Data Flow

**Document version:** 1.0  
**Date:** 29 October 2026  
**Product:** StoreLah CRM — Finance Management  
**Audience:** Product owner, ChatGPT UI/UX agent, Claude coding agent, frontend and backend engineers, QA, finance operations, investors and auditors  
**Live interactive reference:** [https://storelah-crm-leads.faisal-0213.chatgpt.site](https://storelah-crm-leads.faisal-0213.chatgpt.site)

---

## 1. Purpose and implementation contract

This document is the authoritative handoff for reproducing and productionising the StoreLah Finance Management module. The live URL is the visual and interaction reference. This document is the business-logic, state, data-flow, permissions, integration and acceptance-test reference. If the prototype and this specification differ, the following priority applies:

1. Explicit business rules and formulas in this document.
2. Data integrity, accounting controls and permission rules in this document.
3. Current behaviour in the live prototype.
4. Visual details that are not material to the business result.

The intended collaboration model is:

- **ChatGPT:** product specification, information architecture, UI/UX, interaction rules, terminology and acceptance criteria.
- **Claude:** application architecture and implementation, database migrations, APIs, calculation engine, tests and integrations.
- **StoreLah product owner:** approves business rules, thresholds, permissions, accounting policies and production release.

The module is for a self-storage operator. It combines operational finance, controlled payment execution, month-end reporting, facility underwriting, forecast modelling, budget control and investor reporting. It must not be implemented as a collection of unrelated dashboards. One authoritative data model and event trail must connect the screens.

### 1.1 Required outcome

The production module must allow StoreLah to:

- understand billed revenue, cash, receivables, expenses, occupancy and movement for any reporting period;
- generate monthly customer invoices and draft payment instructions while requiring an administrator to approve every charge before submission;
- calculate, approve, process and reconcile refunds, including the case where deductions turn a refund into an additional charge;
- build facility-level financial models from unit inventory, pricing, occupancy, lease, capital and operating-expense assumptions;
- compare approved budget, current forecast and posted actuals month by month;
- save, duplicate, approve, load and audit complete model versions;
- maintain monthly budgets and individual expenditure records with notes and evidence;
- calculate NOI, NOI margin, cash position, payback and IRR consistently across every screen;
- provide a simple read-only investor journey without exposing operational controls or unnecessary customer information;
- export traceable data and preserve an immutable audit trail.

### 1.2 Definition of “connected”

A feature is connected only when a committed source record changes every dependent calculation and view through a documented service or event, with permission checks and audit evidence. A visual link, a copied value or a hard-coded demonstration number is not a production connection.

### 1.3 Prototype status warning

The live reference is an interactive product prototype. It currently stores financial-model data and model versions in browser local storage and uses demonstration datasets for several operational-finance screens. It does not currently provide a server database, real accounting ledger, live payment-processor execution, bank feed, authentication-backed permissions or immutable audit store. Section 5 identifies the current wiring and the production target.

---

## 2. Product principles

1. **One number, one owner, one source.** Each KPI must state its definition and authoritative source.
2. **Lease is counted once.** Landlord lease is part of operating cost and must never be added both as an expense category and as a separate model line.
3. **Staging is not committing.** Editable model sections use local staged values. Only **Update** commits that section to the active working model.
4. **Every financial mutation is auditable.** Actor, timestamp, before, after, reason, source, version and correlation ID must be retained.
5. **Actuals are posted, not predicted.** Future actuals are displayed as an em dash. A posted month is immutable except through a controlled adjustment entry.
6. **Manual payment approval is deliberate.** Generating a payment instruction does not charge the customer. Each instruction is reviewed and approved individually.
7. **Scenario changes remain isolated.** Occupancy scenarios do not silently change pricing, capital, lease or operating expenses.
8. **Investor views are explanatory.** The default investor journey exposes approved data, definitions, assumptions and variance commentary, but not editable controls.
9. **Facility operations drive planning.** Unit inventory and closed move-in/move-out events are authoritative for actual area and unit counts.
10. **No unexplained recalculation.** Every changed value must be traceable to a user update, source-system event, scheduled process or approved version load.

---

## 3. Information architecture and navigation

The main CRM navigation contains **Finance Management**. Its left-panel subcategories are:

| Order | Submodule | Primary purpose | Default permission |
|---:|---|---|---|
| 1 | Finance Overview | Operational finance and collection position | Finance view |
| 2 | Transactions & Approvals | Payment instruction approval, payment status and recovery | Finance operations |
| 3 | Financial Models | Assumptions, monthly roadmap and calculation engine | Model editor |
| 4 | Forecast vs Actuals | Budget/forecast/actual comparison and month close | Finance reporting |
| 5 | Budgets & Expenses | Monthly Opex budgets and individual expenditure | Budget editor |
| 6 | Size Mix & Pricing | Facility unit mix, net PSF and rent potential | Pricing/model editor |
| 7 | Investment Returns | Cash returns, IRR, payback and scenarios | Investor view |
| 8 | Model Library | Versions, approvals, duplication and audit | Governance |
| 9 | Invoices | Customer invoice register and creation | Billing operations |
| 10 | Arrears | Delinquency cases and recovery workflow | Collections |
| 11 | Credits & Refunds | Credit-wallet and refund lifecycle | Finance operations |
| 12 | Reconciliation | Gateway/bank/invoice matching and period sign-off | Reconciliation |

The financial-planning screens also expose a top journey navigation:

| Journey label | Meaning | Destination |
|---|---|---|
| Overview | Position & cash | Finance Overview |
| Forecast | Monthly roadmap | Financial Models |
| Performance | Budget vs forecast vs actual | Forecast vs Actuals |
| Costs | Budget & spend | Budgets & Expenses |
| Assumptions | Size mix & pricing | Size Mix & Pricing |
| Returns | IRR & scenarios | Investment Returns |
| Governance | Versions & audit | Model Library |

### 3.1 Global page frame

Every finance page must contain:

- persistent left navigation with the active subcategory highlighted;
- page title, concise purpose statement and last-refresh timestamp;
- facility scope, where applicable;
- reporting/model period, where applicable;
- accounting basis on operational-finance pages;
- current model/version badge on planning pages;
- contextual primary action at top right;
- loading, empty, error, permission-denied and stale-data states;
- accessible information tips for finance terms and data lineage;
- breadcrumbs only when entering a record detail or approval flow.

### 3.2 URL and deep-link contract

Each submodule and record detail must have a stable route. Suggested routes:

```text
/finance/overview
/finance/transactions
/finance/transactions/:transactionId
/finance/models/:modelId/forecast
/finance/performance
/finance/budgets
/finance/pricing
/finance/returns
/finance/models
/finance/invoices
/finance/invoices/:invoiceId
/finance/arrears
/finance/credits-refunds
/finance/reconciliation
```

Filters should be serialised into the query string when safe, for example `?facility=fac_001&period=2026-10&basis=accrual`. Sensitive identifiers and uncommitted draft state must not be placed in URLs.

---

## 4. Roles, permissions and segregation of duties

Permissions are facility-scoped unless the role is explicitly portfolio-wide.

| Capability | Platform Admin | Finance Approver | Finance Operator | Facility Manager | Investor | Auditor |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| View finance overview | ✓ | ✓ | ✓ | Own facility | Approved only | ✓ |
| View customer PII | ✓ | As required | As required | Own facility | Masked/none | Masked |
| Create/edit invoice draft | ✓ | ✓ | ✓ | — | — | — |
| Approve individual charge | ✓ | ✓ | — | — | — | — |
| Retry failed payment | ✓ | ✓ | Initiate only | — | — | — |
| Draft refund | ✓ | ✓ | ✓ | Initiate only | — | — |
| Approve/process refund | ✓ | ✓ | — | — | — | — |
| Match reconciliation item | ✓ | ✓ | ✓ | — | — | Read-only |
| Close reconciliation period | ✓ | ✓ | — | — | — | Read-only |
| Edit model assumptions | ✓ | ✓ | If granted | Own facility inputs | — | — |
| Approve financial model | ✓ | ✓ | — | — | — | — |
| Enter expense/actual note | ✓ | ✓ | ✓ | Own facility | — | — |
| Post month-end actuals | ✓ | ✓ | Prepare only | Provide inputs | — | Read-only |
| View returns | ✓ | ✓ | ✓ | If granted | ✓ | ✓ |
| Export | ✓ | ✓ | Scoped | Scoped | Approved summary | ✓ |
| Manage finance policies | ✓ | Selected | — | — | — | — |

### 4.1 Control rules

- The maker of a refund or material manual adjustment cannot be its approver when maker-checker policy applies.
- The default second-approval threshold is configurable; prototype example is SGD 250 for refunds.
- Every payment approval is individual. Bulk approval is intentionally unavailable in the initial release.
- Model approval freezes the approved version. Subsequent changes create a new draft version.
- A closed month cannot be edited directly. Corrections use an adjustment journal or reopen process with elevated permission and mandatory reason.
- An investor never sees editable inputs, approval buttons, payment-method details or unmasked customer data.

---

## 5. Connection map: prototype, production target and exclusions

| Area | Live prototype today | Required production connection |
|---|---|---|
| Financial model inputs | Interactive and recalculated in browser | Persisted model/version service with optimistic locking |
| Model versions | Browser local storage | Database-backed immutable snapshots and approval workflow |
| Size mix → PSF | Connected in prototype | Pricing service consumes authoritative unit inventory snapshot |
| PSF → revenue/returns | Connected in calculation engine | Shared server-side calculation library used by API and jobs |
| Landlord lease → Opex | Connected and counted once | Lease schedule service; expense category protected from duplication |
| Opex budget → model | Connected, including monthly overrides | Budget service with effective period, status and approval |
| Scenario → occupancy only | Connected | Scenario overlay object; never mutates base assumptions |
| Forecast → returns | Connected | Versioned projection rows generated deterministically |
| Forecast vs actual | Sample actuals are synthetic | Actuals from posted invoices, expenses and facility movement |
| Facilities inventory sync | Demonstration snapshot | Versioned API from Facilities Management units module |
| Finance Overview | Demonstration dataset | Invoice, payment, credit, refund, agreement, movement and reconciliation read models |
| Transactions | Interactive demonstration | Payment orchestration and processor webhook integration |
| Invoices | Interactive form/static rows | Billing engine, tax, invoice document and ledger |
| Refund calculator | Formula and modal work | Refund case, approvals, processor submission and ledger posting |
| Arrears | Demonstration cases | Rule-driven collections case service and communication tasks |
| Credits | Demonstration ledger | Double-entry customer credit-wallet ledger |
| Reconciliation | Demonstration workspace | Processor settlement, bank receipt and invoice allocation engine |
| Audit history | Demonstration rows | Append-only audit/event store |
| Authentication/RBAC | UI-level concept | Server-enforced identity, role, facility scope and policy checks |

### 5.1 Deliberate non-features in the current model

- No property sale/terminal value is included in IRR.
- No debt financing, loan amortisation, interest, tax or depreciation is included.
- No multicurrency conversion is included; default currency is SGD.
- GST treatment is not yet part of NOI formulas and must be configured with Finance before production.
- No automatic bank-journal posting is assumed.
- No payment is charged merely because an invoice exists.

These are extension points, not values to infer silently.

---

## 6. Core domain model

All primary keys should be opaque UUIDs. Human-readable references are separate unique fields.

| Entity | Purpose | Important fields |
|---|---|---|
| Facility | Operating location and scope | id, code, name, timezone, currency, operationalStartDate |
| UnitInventorySnapshot | Versioned unit mix from Facilities | facilityId, capturedAt, sourceVersion, totalNLA, unitCount, items[] |
| StorageAgreement | Customer commercial contract | customerId, unitId, start/end, monthlyRent, billingDay, status |
| Invoice | Amount due and tax document | invoiceNo, agreementId, issue/due dates, lines, credits, total, balance, status |
| PaymentInstruction | Approval-controlled intent to collect | invoiceId, scheduledAt, amount, methodToken, status, approvedBy |
| PaymentTransaction | Processor/bank execution result | transactionRef, processorRef, amount, status, attempts, settledAt |
| PaymentAllocation | Link between receipt and invoice | paymentId, invoiceId, amount, allocationDate |
| CreditEntry | Customer wallet movement | customerId, type, amount, expiry, sourceId, balanceAfter |
| RefundCase | Calculated customer adjustment | baseRefund, credits, deductions, override, finalAmount, reason, status |
| ArrearsCase | Recovery workflow | customerId, balance, ageing, risk, owner, promiseDate, nextAction |
| ReconciliationBatch | Daily/monthly control | period, source, expected, received, difference, status, signedOffBy |
| ReconciliationItem | Match or exception | externalRef, amount, matchType, matchedEntityId, status, note |
| FinancialModel | Logical facility model | facilityId, name, activeVersionId, approvedVersionId |
| ModelVersion | Immutable assumption snapshot | versionNo, status, effectiveMonth, snapshot, reason, createdBy, approvedBy |
| ProjectionMonth | Calculated monthly result | versionId, month, movement, revenue, costs, NOI, cash, flags |
| BudgetVersion | Monthly/category budget | facilityId, year, status, lines, approvedBy |
| BudgetLine | Category plan | categoryId, month, budget, note, owner |
| Expense | Individual spend item | vendor, date, category, amount, status, invoiceRef, note |
| MonthClose | Posted actual period | facilityId, month, status, postedAt, sourceCutoff, adjustmentVersion |
| ActualMetric | Immutable posted measure | monthCloseId, metric, value, source, sourceRecordIds |
| AuditEvent | Append-only evidence | eventType, actor, entity, before, after, reason, correlationId, occurredAt |

### 6.1 Status values

**ModelVersion:** `DRAFT → SUBMITTED → APPROVED → CURRENT`; a previous current version becomes `SUPERSEDED`. Drafts may become `ARCHIVED`. Approval rejection returns a new or existing draft to `DRAFT` with comments.

**Invoice:** `DRAFT → APPROVED → ISSUED → PARTIALLY_PAID → PAID`; alternative states are `VOID`, `OVERDUE`, `WRITTEN_OFF`.

**PaymentInstruction:** `DRAFT → PENDING_APPROVAL → APPROVED → QUEUED → SUBMITTED`; terminal/exception states are `CANCELLED`, `EXPIRED`, `FAILED`.

**PaymentTransaction:** `PROCESSING → SUCCEEDED` or `FAILED`; a successful transaction can become `PARTIALLY_REFUNDED` or `REFUNDED`.

**RefundCase:** `DRAFT → SUBMITTED → APPROVED → PROCESSING → SUCCEEDED`; alternatives are `REJECTED`, `FAILED`, `CANCELLED`, `CONVERTED_TO_CHARGE`.

**ReconciliationItem:** `UNMATCHED → PROPOSED_MATCH → MATCHED`; alternatives are `SUSPENSE`, `DISPUTED`, `WRITTEN_OFF`.

**MonthClose:** `OPEN → PREPARING → REVIEW → POSTED`; exceptional transition `POSTED → REOPENED` requires elevated approval and audit.

---

## 7. Shared filters, dates, currency and display rules

### 7.1 Reporting periods

Operational screens support:

- Today
- Last 7 days
- Last calendar week
- Month to date
- Last month
- Quarter to date
- Year to date
- Custom range

The selected period flows to the overview, transaction register and exports. It does not change the active financial-model horizon.

### 7.2 Accounting basis

**Accrual:** recognised/billed revenue is derived from issued invoices and credit notes for the service period.  
**Cash:** recognised cash is derived from successfully received and allocated payments for the receipt period.

Changing the basis must change headline revenue and dependent rates. Accounts receivable remains an invoice-ledger balance and should not be relabelled as cash revenue.

### 7.3 Date and time

- Store dates in UTC and retain the facility timezone.
- Display operational dates in the facility timezone.
- A financial model may start mid-month.
- A model month is anchored to the model start sequence, while reporting months use calendar boundaries.
- The opening model month uses day-level proration: active days from operational start through month end divided by days in that calendar month.

### 7.4 Number presentation

- Currency: `SGD 1,234` or `$1,234` after context is established.
- PSF: two decimal places, monthly unless explicitly annual.
- Square feet: whole numbers in operational tables; retain decimals in calculations.
- Occupancy and margin: one decimal place.
- Future actual: em dash, never zero.
- Negative cash/variance: minus sign and accessible colour/icon, not colour alone.
- “PSF” in the monthly model table means average monthly customer rental rate per occupied square foot sourced from Customer Pricing.

---

## 8. Calculation engine

The production calculation engine must run server-side and may be shared with the frontend for previews. Server results are authoritative. A calculation run records input version, engine version, timestamp and deterministic hash.

### 8.1 Size mix and pricing

For size category \(i\):

```text
monthly rent potential_i = NLA_i × net monthly PSF_i
weighted monthly PSF = Σ(NLA_i × PSF_i) ÷ Σ(NLA_i)
```

The model uses the weighted monthly PSF. “Monthly rent potential” is the correct label; do not use “monthly rent” for a fully occupied theoretical amount.

### 8.2 Occupancy movement

For month \(t\):

```text
planned move-in_t = early ramp sqft when t = 1..6, otherwise late ramp sqft
move-out_t = opening occupied sqft_t × monthly move-out rate, when t >= churn start month
available to stabilization_t = max(0, NLA × target occupancy − opening occupied_t + move-out_t)
move-in_t = min(planned move-in_t, available to stabilization_t)
net move-in_t = move-in_t − move-out_t
closing occupied_t = clamp(opening occupied_t + net move-in_t, 0, NLA × target occupancy)
occupancy_t = closing occupied_t ÷ NLA
opening occupied_(t+1) = closing occupied_t
```

The first month’s planned move-in is prorated for a mid-month operational start. The user enters monthly move-out rate as a percentage; the UI displays the equivalent square feet for the selected/reference month. Actual net move-in equals completed move-in square feet minus completed move-out square feet.

### 8.3 Pricing over time

```text
monthly PSF_t = weighted starting PSF × (1 + annual customer rent increase)^floor((t−1)/12)
rental revenue_t = closing occupied sqft_t × monthly PSF_t × opening-month period factor
```

Customer pricing and landlord lease are separate components. Customer rate growth affects revenue only. Landlord escalation affects lease expense only.

### 8.4 Landlord lease

The primary input is an explicit monthly landlord-rent schedule by model year, for up to seven years in the initial UI. The screen also displays implied UFA PSF and annual payable.

```text
contractual lease_t = configured monthly rent for model year(t)
paid lease_t = 0 during configured rent-free model months
paid lease_t = contractual lease_t otherwise
```

The first paid month is prorated if the facility starts mid-month. Lease is a protected, model-linked operating-cost line. Users must not create another “lease” or “landlord rent” expense category.

### 8.5 Operating expenses

```text
base non-lease Opex = Σ active non-lease category budgets
non-lease Opex_t = monthly override total when an approved override exists
otherwise = base non-lease Opex × (1 + annual Opex growth)^model year × period factor
total operating cost_t = paid landlord lease_t + non-lease Opex_t
```

Individual expenses provide actual/committed detail. They do not silently replace the approved category budget; the Forecast column uses an explicit policy such as `actual + committed + remaining forecast`.

### 8.6 NOI, margin and cash

```text
NOI_t = rental revenue_t − total operating cost_t
NOI margin_t = NOI_t ÷ rental revenue_t, when revenue_t != 0
opening cumulative cash = −total capital investment
cumulative cash_t = cumulative cash_(t−1) + NOI_t
```

This NOI excludes financing, tax, depreciation and sale proceeds unless a future version explicitly adds them.

### 8.7 Milestones

- **NOI-positive month:** first month where monthly NOI is greater than or equal to zero.
- **Stabilised occupancy:** first month where occupancy reaches at least 99% of the configured target occupancy. Stabilisation is a planning threshold, not necessarily 100% physical occupancy.
- **Payback month:** first month where cumulative cash is greater than or equal to zero.
- **70% occupancy milestone:** first month where occupancy is at least 70%.

### 8.8 IRR

Monthly cash flows are:

```text
CF_0 = −total capital investment
CF_t = monthly NOI_t
```

Solve the monthly discount rate \(r\) such that:

```text
0 = Σ(CF_t ÷ (1+r)^t)
annualised IRR = (1+r)^12 − 1
```

IRR can change when the selected measurement horizon changes because a 1-year, 3-year or 5-year view includes different cash-flow periods. It also changes when any linked assumption changes. Since no terminal value is included, the UI must state “operating cash-flow IRR, no sale value.” If cash flows do not contain at least one negative and one positive value, IRR is not meaningful and should display “Not available” with a tooltip.

### 8.9 Scenario overlays

| Scenario | Gross move-in | Churn | Stabilisation target | Other variables |
|---|---:|---:|---:|---|
| Downside | −20% | +25% | −5 percentage points | Unchanged |
| Base | Saved plan | Saved plan | Saved plan | Unchanged |
| Upside | +20% | −20% | +3 percentage points | Unchanged |

Applying a scenario creates a temporary overlay. It must not overwrite the saved base until the user deliberately saves a named version.

### 8.10 Sensitivity analysis

The simplified sensitivity display compares target occupancy and weighted customer PSF:

| Case | Target occupancy | Weighted PSF |
|---|---:|---:|
| Lower demand | Base −6 percentage points | Base −$0.50 |
| Current plan | Base | Base |
| Stronger demand | Base +3 percentage points, capped at 98% | Base +$0.50 |

Show resulting annual revenue, NOI, margin, payback and IRR. Avoid a dense matrix in the default view; advanced users may expand one.

---

## 9. Finance Overview

### 9.1 Purpose

Provide an operational, period-based view of revenue, collection, receivables, customer activity and finance exceptions. It is not the facility-underwriting workspace.

### 9.2 Header controls

- Reporting period selector.
- Facility selector, including authorised portfolio view.
- Accounting basis: Accrual or Cash.
- Refresh with source timestamps.
- Export Summary.

### 9.3 KPI definitions and lineage

| KPI | Definition | Authoritative source | Click behaviour |
|---|---|---|---|
| Revenue billed | Issued invoice lines less issued credit notes in period | Invoice ledger | Opens invoice register filtered to period |
| Cash collected | Successful receipts allocated to invoices in period | Payments + allocations + reconciliation | Opens paid transactions |
| Accounts receivable | Open invoice balance at period end | Invoice ledger less payments/credits | Opens AR/invoices |
| Overdue balance | Open balance past due date after grace rules | Invoice ageing | Opens arrears cases |
| Failed payments | Processor/bank attempts in failed state | Payment transactions | Opens failed transaction register |
| Credits & refunds | Unused credit-wallet balance plus pending refunds | Credit and refund ledgers | Opens Credits & Refunds |
| New sign-ups | Agreements activated in period | Customer agreements | Opens customer list |
| Occupied units | Units with active agreement at period end | Facilities + agreements | Opens unit inventory |
| Move-ins | Completed access handovers in period | Move-in events | Opens movement log |
| Move-outs | Completed releases in period | Move-out events | Opens movement log |

Each KPI has an information tip containing definition, inclusion/exclusion rules, source and refresh cadence.

### 9.4 Secondary content

- Six-month collection-rate chart with point hover values.
- Cash and control snapshot: unallocated receipts, reconciliation exceptions, refunds pending, credit balance, next payout and projected month-end cash.
- Priority actions ordered by risk, value and age.
- Finance health checks for manual approval, unmatched items, refund controls and data freshness.

### 9.5 Events

**Reporting period changed** → validate dates → update URL → request overview read model → update all KPIs/charts/actions → retain basis/facility → record analytics event only.  
**Accounting basis changed** → request same period under chosen basis → replace revenue/collection labels and dependent values → preserve AR definition.  
**Export Summary clicked** → freeze filter parameters and source timestamps → generate CSV asynchronously → store export audit event → download or notify failure.  
**Clickable KPI selected** → navigate to destination with identical facility/period/status filters.

### 9.6 Empty and error states

- No activity: show zeros for valid measured metrics and “No transactions in selected period.”
- Source delayed: retain last good value with “Data as at …” warning.
- Partial failure: show unavailable KPI as em dash with source-specific error; do not zero it.

---

## 10. Transactions & Approvals

### 10.1 Purpose

Maintain every payment instruction and execution result, with manual approval before any saved payment method is charged.

### 10.2 Register columns

- internal transaction/instruction ID;
- processor reference, such as Stripe PaymentIntent ID;
- scheduled date;
- customer and unit;
- invoice number;
- method;
- amount;
- status and attempt count;
- approved by and approved at;
- action.

Filters: period, status, processor/method, facility, amount, customer, invoice and search. Exports use the current filter.

### 10.3 Monthly billing and charge lifecycle

1. Billing engine identifies active billable agreements for the first of the month.
2. It calculates rent, add-ons, approved fees, credits, tax and proration.
3. It creates an invoice draft and validation report.
4. An authorised user approves/issues the invoice.
5. The system creates a `PENDING_APPROVAL` payment instruction for the open balance. No external charge occurs.
6. Administrator opens **Review & Approve**.
7. Modal verifies invoice status/balance, customer payment authority, payment method, duplicate-charge protection, amount and scheduled date.
8. Administrator approves or rejects with reason.
9. Approved instruction becomes `QUEUED`; at scheduled time the payment orchestration service creates/confirms the processor transaction with an idempotency key.
10. Processor webhook changes result to `SUCCEEDED` or `FAILED`.
11. Success creates payment allocation, updates invoice/AR, creates settlement item and refreshes Overview.
12. Failure increments attempt, opens or updates arrears/recovery task and refreshes failed-payment metrics.

### 10.4 Review & Approve modal

Display:

- invoice and agreement summary;
- amount breakdown;
- payment authority/mandate status;
- masked payment method;
- prior attempts and duplicate check;
- scheduled execution time;
- warning conditions;
- approve and reject actions.

Approval writes actor, timestamp, decision, reason, IP/device metadata if policy permits, and before/after state. Approval must be revalidated server-side at submission.

### 10.5 Retry and recovery

A failed transaction detail offers permitted actions: send secure payment link, retry saved method, record bank receipt, record promise to pay, create communication task or escalate arrears. Retry creates a new attempt linked to the same instruction; it does not overwrite prior processor evidence.

### 10.6 Idempotency and concurrency

- One active instruction per invoice balance and scheduled run unless explicitly split.
- Processor submission uses a unique idempotency key.
- Approval fails safely if invoice balance or payment authority changed after modal open.
- Webhooks are idempotent and ordered using processor event ID and occurrence time.

---

## 11. Financial Models

### 11.1 Purpose

Provide the facility planning workspace and month-by-month performance roadmap.

### 11.2 Global toolbar

- Facility selector.
- Loaded model/version selector.
- Operational start date, including mid-month dates.
- Scenario: Downside, Base, Upside.
- status badge: Draft, Pending Approval or Approved.
- Save New Version.
- Export monthly performance.

Changing facility or model with unsaved staged sections prompts: **Discard changes**, **Stay**, or **Save version**. Changing start date recalculates the calendar and first-month proration; it is itself a committed model input only after confirmation.

### 11.3 KPI strip

- Year 1 occupied area.
- Year 1 net move-in.
- 1-year, 3-year and 5-year cash position.
- Year 1, Year 2 and Year 3 NOI with NOI margin.

KPI tooltips state period, formula and source version.

### 11.4 Month-by-month table

Columns:

1. Month
2. Opening occupied sqft
3. Move-in sqft
4. Move-out sqft
5. Net move-in sqft
6. Closing occupied sqft
7. Occupancy
8. PSF
9. Rental revenue
10. Operating costs
11. NOI
12. NOI margin
13. Cash position

Values are centred where appropriate. Controls show 12 months, 24 months or all 60 months. A year filter provides year summaries. CSV export includes landlord lease and non-lease Opex as separate columns even though the visible table uses total operating cost.

### 11.5 Charts

**Occupied Area Ramp:** budget/approved forecast as dotted line, loaded forecast as line, actual as solid line through the latest posted month, and Stabilisation as reference line.  
**Monthly Space Movement:** projected move-in and move-out as dotted lines; actual completed movement as solid lines.  
**Revenue vs Operating Cost:** separate revenue and total operating-cost lines; do not label revenue “net revenue.”

Charts provide 12/24/60-month range, cursor-aligned tooltip, legend toggles and a zoom modal. Actual points exist only for posted months.

### 11.6 Independently staged input sections

Each section has **Unsaved changes**, **Undo** and **Update**. Typing affects only the preview for that section until Update.

#### A. Occupancy Plan

- Gross move-in sqft/month for months 1–6.
- Gross move-in sqft/month from month 7 onward.
- Monthly move-out rate percentage.
- Displayed move-out sqft equivalent.
- Churn start month.
- Stabilisation occupancy percentage.

Update writes the active working model and recalculates movement, occupancy, revenue, NOI, cash, returns, charts and forecast. It does not change lease, Opex, pricing or capital.

#### B. Capital Investment

- Add, edit or remove capital items.
- Fields: category, description, amount, timing, owner, status and note.
- Show pending total and committed total.

Update changes initial investment and therefore cash, payback and IRR. It does not change NOI.

#### C. Customer Pricing

- Starting weighted PSF sourced from Size Mix & Pricing.
- Annual customer rent increase.
- Projection table for years 1–7, with a collapsed default and “Show more years.”
- Monthly and annual rent potential at 100% occupancy.

Starting weighted PSF is normally read-only here and edited through size-category pricing. If a manual override is allowed, display source, reason, effective date and override badge.

#### D. Landlord Lease

- UFA.
- Rent-free months.
- Monthly landlord rent by lease year, years 1–7.
- Implied UFA PSF.
- Annual payable.
- lease start/end, escalation notes and source-document reference in production.

Update changes lease, operating costs, NOI, cash, returns and budgets’ linked lease row. It does not create an additional expense category.

### 11.7 Update and Undo event contract

**Input changed** → clone committed section into staged state if not already cloned → validate locally → update section preview → show Unsaved.  
**Undo clicked** → discard staged clone → restore committed inputs and dependent preview → no audit event because nothing committed.  
**Update clicked** → validate complete section → send expected model version and section patch → server performs optimistic-lock check → store new working revision and audit event → recalculate projection → return changed outputs and calculation hash → update every dependent screen cache → show success.  
**Update conflict** → preserve user inputs → show who changed the version and options to compare/reload/create new draft.

### 11.8 Validation

- NLA and UFA greater than zero; NLA cannot exceed valid facility constraints without warning.
- Occupancy target between 0% and 100%.
- Move-out rate between 0% and configured safe maximum.
- Churn start is within horizon.
- Capital and rent values cannot be negative.
- Size-mix NLA must reconcile to facility/model NLA before approval.
- Lease years cover the model horizon or an explicit carry-forward rule is selected.
- Duplicate lease expense category is rejected.
- Start date is required and must be within facility/model policy.

### 11.9 Calculation checks panel

Show pass/warn/fail for:

- net move-in equals move-in minus move-out;
- churn uses opening occupied NLA;
- revenue uses occupied NLA and customer PSF;
- size mix reconciles to NLA;
- lease schedule is explicit and counted once;
- opening month is date-prorated;
- cash begins with capital investment;
- source versions are current.

---

## 12. Forecast vs Actuals

### 12.1 Definitions

- **Budget:** the approved baseline/model version for the selected month.
- **Forecast:** the latest selected current model/version, including approved overrides.
- **Actual:** immutable month-end posted values from source transactions and facility events.

The live prototype includes sample actuals for demonstration. Production must never manufacture actuals from a forecast percentage.

### 12.2 Controls and layout

- Facility.
- Model source.
- Reporting window: 12, 24 or 60 months.
- Year selector.
- Metric group.
- Variance display: amount and percentage, amount only, or percentage only.
- Month-close action when permitted.

Table rows/sections compare Budget, Forecast, Actual and Variance for revenue, occupancy, operating costs and NOI. Future actual is an em dash.

### 12.3 Month-end close lifecycle

1. Scheduled job opens the month-close checklist after calendar month end.
2. System records source cutoffs and data freshness for invoices, credits, payments, expenses, lease, move-ins and move-outs.
3. Finance Operator reviews exceptions: draft invoices, unallocated payments, unapproved expenses, unmatched movement and incomplete reconciliation.
4. Facility Manager supplies missing operational notes/evidence.
5. System calculates proposed actual metrics from posted source records.
6. Operator adds metric/line notes and variance explanations.
7. Finance Approver reviews source totals and checklist.
8. Approver posts the month.
9. Server writes immutable `MonthClose` and `ActualMetric` records, calculation hash and audit event.
10. Forecast vs Actual, Financial Models charts, Overview historical trends and investor views refresh.
11. Corrections after close use an adjustment version. The original close remains visible.

### 12.4 Actual source mapping

| Actual metric | Source |
|---|---|
| Revenue | Invoice service-period lines less credits, under accounting policy |
| Cash | Successful allocated payments |
| Occupied sqft | Active unit/agreement snapshot at month end |
| Move-in/out sqft | Completed facility movement events |
| Landlord lease | Approved lease schedule plus posted adjustment |
| Non-lease Opex | Posted expenses/accruals mapped to categories |
| NOI | Actual revenue minus actual operating cost |

### 12.5 Notes

Every metric and expenditure line supports an internal note. Material variance thresholds require a reason before posting. Notes store author and timestamp and are visible in audit and investor commentary according to permission.

---

## 13. Budgets & Expenses

### 13.1 Purpose

Manage monthly non-lease Opex plans and the individual expenditures that explain actual and committed spend.

### 13.2 Monthly category table

Columns:

- category;
- budget;
- actual;
- committed;
- forecast;
- variance;
- owner;
- note;
- action.

The landlord lease line is visible but read-only and labelled **Linked from Financial Model → Landlord Lease**. The page summary shows lease, other Opex and total operating cost separately.

### 13.3 Scope of an update

On Update, the user selects:

- selected month only; or
- selected month and future open months.

The scope must never alter posted actual months. A confirmation summarises affected months and categories.

### 13.4 Individual expenditure ledger

Fields:

- expenditure ID;
- vendor/payee;
- date and service month;
- description;
- category;
- amount and tax;
- status: Draft, Committed, Paid/Actual;
- invoice/receipt/purchase-order reference;
- notes;
- attachments;
- creator/approver.

Adding or editing an item updates actual/committed rollups according to status. The action is saved immediately as a ledger record; category-budget edits remain staged until Update.

### 13.5 Protected categories

Names matching lease, landlord rent, premises rent or property rent are rejected for ordinary expense categories. If the business needs a non-landlord property cost, use a distinct configured category with finance approval.

### 13.6 Data flow

Budget Update → approved/current budget lines → monthly model Opex input → operating cost → NOI → cash → returns → Forecast vs Actual budget/forecast columns.  
Expense Posted → category actual/committed → actual/forecast expense rollup → month close → actual operating cost and NOI.

---

## 14. Size Mix & Pricing

### 14.1 Purpose

Model facility storage-area allocation, unit count, customer net PSF and theoretical rent potential.

### 14.2 Inventory sync

The page displays:

- facility NLA and units from Facilities Management;
- inventory version and last-updated time;
- allocated size-mix NLA;
- mismatch warning;
- manual override badge, if present.

**Sync from Facilities** opens a comparison showing source and current values by size. Confirming sync replaces NLA and unit counts only. Net PSF remains unchanged. A changed size taxonomy requires explicit mapping.

### 14.3 Editable category table

For XS, S, M, L and XL, and any configured categories:

- NLA sqft;
- unit count;
- net monthly PSF;
- monthly rent potential;
- optional demand/conversion evidence.

Totals show facility NLA, allocated NLA, units, weighted PSF, current monthly rent potential and year-5 potential.

### 14.4 Events

**Inventory sync requested** → fetch versioned inventory → compare → confirm → save source version and mapped mix → recalculate weighted PSF/model.  
**PSF edited** → stage row → validate non-negative → Update → recalculate category rent potential, weighted PSF, monthly model PSF/revenue, NOI, cash and returns.  
**Optimise Mix applied** → create staged suggestion only → show fit-out/corridor warning → require Update and named model version before approval.

---

## 15. Investment Returns

### 15.1 Purpose

Explain the operating cash return of the selected model without crowding the investor with editable assumptions.

### 15.2 Layout

- Return horizon selector: Year 1 through Year 5 initially.
- Source model/version and as-of date.
- Initial investment.
- Stabilisation month.
- NOI-positive month.
- Payback month.
- Annual NOI margin.
- Cash through selected year.
- Annualised operating cash-flow IRR.
- Return summary and IRR progression.
- Simplified sensitivity cases.
- Scenario comparison.

Capex assumptions are read-only here. **Edit Capital** takes an authorised user to Financial Models → Capital Investment. Avoid overlapping cards and ensure the page reflows at tablet widths.

### 15.3 Period behaviour

The horizon is measured from operational start, not calendar year. Changing horizon recalculates cumulative cash and IRR using only cash flows through that horizon; it does not mutate the model.

### 15.4 Investor access

Investor view defaults to the approved model, posted actuals and approved commentary. It hides customer names, transaction details, internal notes and all mutation controls. It supports a printable/exportable summary with definitions and “no terminal value” disclosure.

---

## 16. Model Library and governance

### 16.1 Library cards and filters

Show approved baseline, saved drafts, templates, scenario copies and archived/superseded versions. Filters: facility, status, owner, effective month and search.

Each card shows:

- model/draft name;
- facility;
- version number;
- status;
- effective month;
- updated by/at;
- change note;
- headline assumptions/results;
- available actions.

### 16.2 Save New Version

Prompt for:

- required name;
- required change note/purpose;
- effective month;
- approval route;
- optional tags.

Save captures a complete snapshot: start date, horizon, facility/NLA/UFA, occupancy, pricing, size mix, lease, Opex, capital, monthly overrides, source inventory version and engine version. It is not a sparse patch.

### 16.3 Actions

- **Load Forecast:** makes the version the active comparison forecast and recalculates dependent screens.
- **Open Inputs:** opens Financial Models with that version.
- **Duplicate:** prompts for new name and reason; creates an independent draft.
- **Submit Approval:** validates completeness, locks submission revision and routes it.
- **Approve/Reject:** authorised decision with comments.
- **Restore:** always creates a new draft from the historical snapshot; history is never overwritten.
- **Archive:** hides a non-current version after confirmation.
- **Audit History:** opens real before/after event evidence.

### 16.4 Load semantics

Loading a version changes the current forecast, charts, cash, returns and Forecast vs Actual forecast values. It does not change posted actuals. Loading an approved version for viewing does not automatically make it the current baseline unless an authorised user performs **Set as Current**.

### 16.5 Audit history

Columns: timestamp, user, action, version, field/section, before, after, reason, status, source and correlation ID. Export uses the current filters. Audit data is append-only.

---

## 17. Invoices

### 17.1 Register

Columns: invoice, customer, agreement, facility/unit, issue date, due date, rent, add-ons, fees, credits, tax, total, balance, status and action.

### 17.2 Create invoice

The modal supports customer/agreement, invoice/service dates, line type, quantity, amount, GST/tax code, due date, description, credits and approval route. Most monthly invoices should be generated by the billing engine, not hand-entered.

### 17.3 Invoice data flow

Agreement/pricing/fees/credits → draft invoice → validation → approval/issue → AR balance → draft payment instruction → approved charge → payment allocation → paid status → reconciliation. Voiding or crediting an issued invoice creates a linked document; it does not delete ledger history.

### 17.4 Validation

- active or valid terminated agreement;
- no duplicate facility/agreement/service-period invoice;
- line totals, tax and credits reconcile;
- credits cannot exceed permitted balance;
- due date policy applied;
- posted-period changes use credit/adjustment documents.

---

## 18. Arrears

### 18.1 Case table

Customer, agreement/unit, outstanding balance, oldest age, last contact, promise to pay, access status, owner, risk and next action.

### 18.2 Default recovery workflow

1. Payment failure: immediate email/WhatsApp and secure payment link; case opened.
2. Day 3: retry/task according to authority and customer consent.
3. Day 7: formal notice and manager review.
4. Policy threshold: late fee, access restriction or termination action only when enabled in Global Settings and permitted by agreement/law.

Every communication and promise-to-pay is an event. Payment success or approved write-off resolves the case but preserves history.

---

## 19. Credits & Refunds

### 19.1 StoreLah Credits

- Denominated in dollars; `$1 credit = $1` unless future policy says otherwise.
- Non-transferable and no cash value by default.
- Fields: customer, amount, issued/expiry dates, source, remaining balance, restrictions and status.
- Ledger entries are immutable; balance is the sum of entries.
- Applying a credit creates an allocation to an invoice.

### 19.2 Refund calculator

Inputs:

- customer/agreement and move-out date;
- monthly storage rent;
- days in billing month;
- unused storage days;
- other refundable credit/deposit;
- early-termination penalty;
- damage/miscellaneous charge;
- optional final override;
- mandatory reason when any deduction or override is present.

Formula:

```text
prorated storage refund = monthly storage rent ÷ days in month × unused days
calculated final = prorated refund + refundable credit − early termination fee − damage/misc charge
final = approved override when entered, otherwise calculated final
```

If final is negative, the workflow becomes an additional charge for admin review; it is not sent as a negative refund.

### 19.3 Refund lifecycle

1. Move-out, duplicate payment or approved adjustment starts a refund case.
2. System gathers original payment allocation, unused period, deposit/credit and eligible deductions.
3. Calculator proposes amount and itemised basis.
4. Operator adds evidence and reason.
5. Approval rules select one or two approvers.
6. Approved positive amount is submitted to original payment method by default; bank transfer requires verified bank details and exception approval. StoreLah Credits are optional only with customer consent/policy.
7. Processor result updates refund ledger and original transaction.
8. Successful refund creates accounting/reconciliation items and updates overview.
9. Failed refund returns to queue with failure reason.
10. Negative result creates a new invoice/payment instruction after approval.

### 19.4 Refund ledger

Columns: refund ID, customer, reason, prorated rent, deposit/credit, deductions, total, destination, gateway reference, status, submitted/processed dates and action.

---

## 20. Reconciliation

### 20.1 Purpose

Prove that processor/bank money, StoreLah payment records, invoice allocations, credits and refunds agree.

### 20.2 Views

- Daily reconciliation.
- Monthly reconciliation.
- Summary: gateway settled, bank received, invoices posted, refunds, variance and unmatched count.
- Unmatched workspace.
- Batch checklist and finance sign-off.

### 20.3 Data flow

Money received from Stripe/PayNow/bank → settlement/receipt imported → matching engine proposes invoice/payment/refund → operator confirms or moves to suspense → differences resolved → batch totals reconcile → authorised sign-off → Overview and month-close readiness update.

### 20.4 Match Payment modal

- external transaction reference and date;
- amount/currency;
- match type;
- customer/invoice search;
- one or multiple allocations;
- remainder;
- note and evidence.

Allocations cannot exceed available receipt or invoice balance. Partial allocations are permitted. Remainders remain unmatched or move to a controlled suspense account.

### 20.5 Close controls

Checklist:

- processor batch total agrees;
- bank deposit agrees;
- invoice allocations agree;
- refunds/chargebacks accounted for;
- exceptions below policy threshold or explicitly approved;
- sign-off recorded.

Closed reconciliation batches are immutable. Reopening requires elevated approval.

---

## 21. Event catalogue

Every domain event includes `eventId`, `eventType`, `occurredAt`, `actorId/system`, `facilityId`, `entityType`, `entityId`, `correlationId`, `causationId`, `sourceVersion` and an event-specific payload. Consumers must be idempotent.

| Event | Trigger | Primary write | Downstream consumers |
|---|---|---|---|
| FinanceReportingPeriodChanged | User changes filter | None | Overview query, export context |
| AccountingBasisChanged | User selects cash/accrual | Preference only | Overview query |
| InventorySyncRequested | User requests sync | Sync job | Facilities API |
| InventorySnapshotLinked | Sync confirmed | Model source reference | Size mix, validations, audit |
| SizeMixUpdated | Pricing Update | Model working revision | Projection, returns, library dirty state |
| ModelSectionUpdated | Section Update | Working revision + audit | Projection engine, dependent views |
| OperationalStartChanged | Date confirmed | Working revision | Calendar/proration/projection |
| ScenarioApplied | User selects scenario | Session overlay | Projection preview |
| ModelVersionSaved | Save New Version | Immutable snapshot | Library, audit |
| ModelSubmitted | Submit Approval | Status transition | Approval inbox |
| ModelApproved | Approver confirms | Approved/current pointers | Budget baseline, investor view |
| ModelVersionLoaded | User loads version | User/session active version | Forecast, charts, returns |
| BudgetUpdated | Scoped Update | Budget lines/version | Opex forecast, model, returns |
| ExpenseRecorded | Expenditure saved | Expense ledger | Category rollup, forecast/actual |
| InvoiceGenerated | Billing/manual creation | Invoice draft | Approval queue |
| InvoiceIssued | Approval/issue | Invoice + AR | Payment instruction generation |
| PaymentInstructionCreated | Issued invoice | Instruction | Transactions queue |
| PaymentApproved | Admin approval | Instruction status/audit | Scheduler |
| PaymentSubmitted | Scheduled execution | Transaction attempt | Processor |
| PaymentSucceeded | Webhook/bank match | Transaction/allocation | Invoice, AR, reconciliation, overview |
| PaymentFailed | Webhook | Attempt/status | Arrears, overview, recovery |
| CreditIssued | Approved credit | Credit ledger entry | Wallet balance, invoices |
| CreditApplied | Invoice allocation | Credit allocation | Invoice balance, AR |
| RefundCalculated | Calculator confirms | Refund draft | Approval queue |
| RefundApproved | Approver decision | Refund status/audit | Processor submission |
| RefundSucceeded | Processor result | Refund ledger | Reconciliation, overview |
| RefundConvertedToCharge | Negative calculation approved | Invoice draft | Billing approval |
| ReconciliationItemMatched | Operator confirms | Allocation/match | Batch totals, month close |
| ReconciliationBatchClosed | Approver signs off | Closed batch | Close readiness, audit |
| MonthCloseStarted | Schedule/user | MonthClose PREPARING | Checklist/data snapshot |
| ActualsPosted | Month close approved | Actual metrics + POSTED | Performance, charts, investor view |
| CloseAdjustmentPosted | Approved correction | Adjustment version | Restated actual views |
| ArrearsCaseOpened | Payment failure/overdue | Arrears case | Tasks, communications |
| ExportGenerated | User export succeeds | Export audit record | Download/notification |

### 21.1 Standard event failure behaviour

- Reject unauthorised commands before mutation.
- Validate current entity version to prevent lost updates.
- Use database transaction/outbox for mutation plus event publication.
- Retry asynchronous consumers with exponential backoff.
- Send poison events to a dead-letter queue with alerting.
- Never display zero when a source failed; display unavailable/stale.

---

## 22. End-to-end sequence summaries

### 22.1 Model assumption to investor return

```text
User edits one model section
→ local staged preview and validation
→ User clicks Update
→ server saves working revision and audit event
→ projection engine rebuilds monthly rows
→ model table and charts refresh
→ Forecast vs Actual forecast refreshes
→ cash, payback, NOI margin and IRR refresh
→ user saves named immutable version
→ approval makes version available to investors
```

### 22.2 Unit inventory to revenue

```text
Facilities unit change
→ versioned inventory snapshot
→ user reviews and confirms sync
→ size-category NLA/unit counts update
→ weighted PSF recalculates
→ monthly rent potential recalculates
→ model monthly revenue/NOI/cash recalculates
→ returns and forecast views refresh
```

### 22.3 Monthly invoice to reconciled cash

```text
Active agreement at billing cutoff
→ invoice draft
→ invoice approval and issue
→ payment instruction pending approval
→ administrator reviews and approves
→ scheduled processor submission
→ processor success webhook
→ payment allocation to invoice
→ AR reduced and invoice paid
→ settlement/bank receipt imported
→ reconciliation match and sign-off
→ Overview cash/collection metrics refresh
```

### 22.4 Refund to final accounting outcome

```text
Move-out/payment exception
→ proposed proration and deductions
→ operator evidence and reason
→ approval policy
→ positive: processor refund
→ negative: additional invoice/charge instruction
→ result ledger entry
→ reconciliation
→ Overview and customer balance refresh
```

### 22.5 Month-end actual

```text
Calendar month ends
→ source cutoffs captured
→ invoices/payments/expenses/movement/reconciliation validated
→ proposed actual metrics
→ notes and variance explanations
→ finance approval
→ immutable actual posting
→ budget/forecast/actual and investor charts refresh
```

---

## 23. Suggested service and API boundaries

The exact stack is Claude’s implementation decision, but the following contracts prevent UI coupling.

| Service | Example operations |
|---|---|
| Finance Read Model | `GET /finance/overview`, trends and KPI lineage |
| Model Service | create model, patch working section, save/load/approve version |
| Projection Service | calculate and retrieve monthly projections and sensitivity |
| Budget Service | retrieve/update scoped monthly budgets and categories |
| Expense Service | CRUD expenditure, attachments and status transitions |
| Pricing Service | retrieve/update size mix; link inventory snapshot |
| Billing Service | generate, approve, issue, credit and void invoices |
| Payment Orchestration | create/approve/submit instructions; process webhooks |
| Credit/Refund Service | wallet entries, refund calculation, approval and processing |
| Collections Service | arrears cases, actions and promises |
| Reconciliation Service | import, match, close and reopen batches |
| Close Service | prepare, review, post and adjust monthly actuals |
| Audit Service | query immutable events and exports |

### 23.1 Example commands

```text
PATCH /models/:id/working-sections/occupancy
POST  /models/:id/versions
POST  /model-versions/:id/submit
POST  /model-versions/:id/approve
POST  /facilities/:id/inventory-sync-preview
POST  /budgets/:id/apply
POST  /payment-instructions/:id/approve
POST  /refunds/:id/approve
POST  /reconciliation-batches/:id/close
POST  /month-closes/:facilityId/:month/post
```

All mutation requests accept an idempotency key and expected entity version. Responses include new version, affected calculations, warnings and audit correlation ID.

---

## 24. UI event and state conventions

### 24.1 Buttons

- Primary buttons describe the committed action: Update, Approve Charge, Post Month, Save Version.
- Secondary buttons: Undo, Cancel, Preview, Export.
- Destructive actions require confirmation and explain reversibility.
- Disabled buttons show a tooltip explaining why.
- A successful action shows a concise toast and the visible state changes immediately.

### 24.2 Forms

- Validate on blur and submit; do not block typing with premature errors.
- Preserve entered values after server errors.
- Show units in labels, not placeholders.
- Currency and percent inputs retain exact underlying decimal values.
- Notes support plain text initially; no executable markup.

### 24.3 Loading and refresh

- Use skeletons for first load.
- Use inline progress for recalculation or export.
- Show source timestamps and stale badges.
- Long calculations return a job ID and progress; the page remains navigable.

### 24.4 Tooltips

Tooltips answer “What is this?”, “How is it calculated?” and “Where does it come from?”. They are keyboard accessible and do not contain essential-only information.

### 24.5 Charts

- Tooltip appears nearest the cursor and includes month, series and exact value.
- Keyboard users can move among data points.
- Legend toggles series.
- Zoom opens a modal/fullscreen view with the same filters.
- Provide table/CSV alternative.

---

## 25. Non-functional requirements

### 25.1 Accuracy and consistency

- Decimal arithmetic for money; no binary floating-point persistence.
- Rounding policy documented per currency/tax and applied at line level.
- Projection engine has golden test fixtures.
- Same version and engine hash must return the same result.

### 25.2 Security

- Server-enforced RBAC and facility scope.
- Processor tokens only; never store raw card details.
- Encrypt sensitive data in transit and at rest.
- Audit permission failures and high-risk actions.
- Signed webhook validation and replay protection.
- Mask customer/payment data in investor and auditor exports as configured.

### 25.3 Performance

- Overview initial content under two seconds at normal portfolio scale.
- Model section recalculation target under one second for 60 months and under three seconds for 120 months.
- Large exports run asynchronously.
- Paginate operational registers server-side.

### 25.4 Accessibility

- WCAG 2.2 AA target.
- Full keyboard navigation and visible focus.
- Semantic table headings and captions.
- Colour-independent status communication.
- Responsive layout down to tablet; operational approvals remain usable on mobile.

### 25.5 Observability

- Structured logs with correlation ID.
- Metrics for calculation failures, webhook lag, unreconciled value, failed billing jobs and close readiness.
- Alerts for source freshness, duplicate instructions, negative unexpected balances and audit publication failure.

### 25.6 Retention

Retain invoice, payment, refund, reconciliation, model approval and month-close evidence according to Singapore legal/accounting policy approved by StoreLah. Deletion of customer PII must not destroy required financial evidence; use permitted anonymisation.

---

## 26. Acceptance criteria and critical tests

### 26.1 Calculation tests

- Net move-in always equals move-in minus move-out.
- Month 1 is prorated correctly for every calendar month and leap year.
- Churn begins only in the configured model month.
- Occupied sqft never exceeds stabilization target.
- Weighted PSF matches category-weighted result.
- Customer annual increase starts at model-year boundary.
- Free landlord months produce zero paid lease, including mid-month rules.
- Lease is counted exactly once in operating cost.
- Monthly budget override affects only selected open scope.
- NOI equals revenue minus total operating cost.
- Cash starts at negative capital and accumulates monthly NOI.
- IRR uses the selected horizon and shows unavailable for invalid sign patterns.

### 26.2 Workflow tests

- Typing in a section does not mutate the committed model until Update.
- Undo restores the last committed section values.
- Updating one section refreshes all dependent screens, not unrelated assumptions.
- Saving a named version makes it appear in Model Library immediately.
- Loading a version changes forecast and returns but never posted actuals.
- Duplicate/restore always requests name and reason.
- Future actuals show em dash.
- A posted month cannot be directly edited.
- Cash/accrual selection produces different figures when source timing differs.
- Export Summary downloads the filtered dataset and creates export audit evidence.
- Invoice issue creates a payment instruction but does not charge.
- Only authorised users can approve a charge.
- Approval is rejected if the invoice changed during review.
- Refund override/deduction requires a reason.
- Negative refund becomes an additional charge workflow.
- Reconciliation cannot close while required control checks fail.
- Investor cannot see mutation controls or customer PII.

### 26.3 Failure tests

- Duplicate processor webhook does not duplicate payment/allocation.
- Network failure after approval does not lose or repeat the command.
- Concurrent model updates produce a compare/reload conflict.
- Failed projection preserves last approved result with stale warning.
- Missing inventory mapping blocks model approval, not all viewing.
- Payment processor outage leaves approved instructions queued and visible.
- Export failure provides retry and does not claim completion.

---

## 27. Recommended implementation phases

### Phase 1 — Foundations

Identity/RBAC, facility scope, core ledgers, audit/outbox, model service, projection engine and read-only overview.

### Phase 2 — Planning workspace

Financial Models, Size Mix & Pricing, Budgets & Expenses, Model Library, version approvals, returns and exports.

### Phase 3 — Billing and payments

Invoice engine, payment instructions, individual approval, processor integration, allocations, failed-payment recovery and operational Overview.

### Phase 4 — Close and controls

Reconciliation, credits/refunds, arrears, month close, posted actuals and variance notes.

### Phase 5 — Investor experience and hardening

Investor portal permissions, approved commentary, print/export, performance tuning, accessibility, security review and disaster recovery.

Do not implement payment charging before ledger, idempotency, permission and audit foundations are tested.

---

## 28. Prototype reference values

These values help engineers reproduce the live reference and build deterministic tests. They are demonstration defaults, not business policy.

### 28.1 Facility and model

- Facility: StoreLah Sembawang.
- Model: Sembawang Launch Plan.
- Operational start: 1 December 2026.
- Horizon: 60 months.
- UFA: 3,068 sqft.
- NLA: 2,274 sqft.
- Units: 76.
- Months 1–6 gross move-in: 180 sqft/month.
- Month 7 onward gross move-in: 125 sqft/month.
- Monthly move-out rate: 2.5%.
- Churn begins: model month 7.
- Stabilisation target: 92%.
- Annual customer rent increase: 3%.
- Landlord rent-free months: 0.

### 28.2 Size mix

| Size | NLA sqft | Units | Net monthly PSF |
|---|---:|---:|---:|
| XS | 455 | 31 | $6.80 |
| S | 500 | 20 | $6.20 |
| M | 650 | 16 | $5.50 |
| L | 405 | 7 | $4.80 |
| XL | 264 | 2 | $4.20 |

### 28.3 Base monthly non-lease Opex

| Category | Amount |
|---|---:|
| Payroll & contractor | $0 |
| Marketing | $500 |
| Utilities | $500 |
| Software & IT | $100 |
| Maintenance & cleaning | $0 |
| Insurance & admin | $0 |
| Other operating costs | $100 |
| **Total** | **$1,200** |

### 28.4 Capital

| Item | Amount |
|---|---:|
| Partitions, doors & latches | $30,000 |
| Smart locks & access control | $15,000 |
| CCTV, network & IT | $8,000 |
| Fit-out, electrical & signage | $28,000 |
| Professional and pre-opening | $7,000 |
| Opening working capital | $20,000 |
| **Total** | **$108,000** |

### 28.5 Landlord lease

Prototype default: $5,000 per month for each of seven lease years, before any user change.

---

## 29. Source-to-feature implementation checklist

Claude should confirm each item before declaring parity:

- [ ] All twelve finance submodules have stable routes and permission guards.
- [ ] Filters persist in URL/preferences and flow to exports.
- [ ] Every KPI has definition and lineage.
- [ ] Cash/accrual basis changes actual queries and values.
- [ ] All model formulas have automated fixtures.
- [ ] Four model sections stage, Undo and Update independently.
- [ ] Size Mix drives weighted PSF and model revenue.
- [ ] Landlord Lease drives the protected lease cost line once.
- [ ] Budget and expense states drive forecast and posted actuals correctly.
- [ ] Scenario overlays are isolated from the base model.
- [ ] Charts support hover, zoom, range and actual-vs-forecast semantics.
- [ ] Save, duplicate, load, submit, approve, restore and audit work server-side.
- [ ] Month close produces immutable actuals and future months remain blank.
- [ ] Invoices generate draft instructions without charging.
- [ ] Every charge requires individual authorised approval.
- [ ] Processor webhooks are secure and idempotent.
- [ ] Refund proration, deductions, override reasons and negative outcomes work.
- [ ] Reconciliation supports partial matches, suspense and close control.
- [ ] Investor view is read-only, approved-data-only and privacy-safe.
- [ ] Exports are filtered, traceable and audited.
- [ ] Loading/error/empty/stale/conflict states are implemented.
- [ ] WCAG, performance, security and audit requirements pass review.

---

## 30. Handoff decisions requiring StoreLah approval

Claude must not guess these production policies. Record decisions in configuration and update this specification:

1. GST registration/tax treatment and whether displayed model revenue is tax-exclusive.
2. Invoice approval requirements and service-period recognition policy.
3. Payment approval roles and whether a future bulk approval is ever permitted.
4. Refund second-approval thresholds and bank-transfer verification.
5. Late-fee, grace-period, access-restriction and termination policy.
6. Actual-expense accrual versus cash recognition at month close.
7. Whether deposits are liabilities, credits or separately controlled funds.
8. Terminal value, financing, tax and depreciation scope for future IRR versions.
9. Inventory size taxonomy and manual-override authority.
10. Data retention, investor export and PII-masking policies.

---

## 31. Completion definition

The finance module is complete when an authorised StoreLah user can begin with a facility and unit inventory, build and approve a model, issue monthly invoices, approve each payment, receive and allocate results, record expenses, reconcile money, close a month, compare actuals with the approved budget/current forecast, explain variances, process a controlled refund and give an investor a clear approved view—while every number remains traceable to its source, formula, version and event history.


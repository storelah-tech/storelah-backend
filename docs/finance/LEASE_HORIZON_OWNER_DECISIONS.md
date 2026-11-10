# StoreLah — Lease Horizon Owner Decisions

**Feature:** Committed lease term / Lease Horizon  
**Modules:** Finance Management — Financial Models and Investment Returns  
**Decision date:** 9 November 2026  
**Status:** Approved implementation direction, subject only to the reconciliation-file note under D13

## Copy-paste reply to the implementation agent

> D1: **B** — Use the day-before-anniversary rule when the nominal anniversary date exists. If the original calendar day does not exist in the target month, use the target month’s last calendar day as the inclusive end date; do not clamp and subtract another day. Example: 29 Feb 2028 + 12 months ends 28 Feb 2029.  
> D2: **A** — Use actual calendar days for both opening and closing stubs. Accept that the sum of prorated rent can be slightly above or below exactly N monthly rents because calendar months have different lengths.  
> D3: **A** — Store explicit rent-free start and end dates. Convert legacy whole-month values into dates during migration and retain the original legacy value in the audit record.  
> D4: **A** — Keep automatic draft creation when a user first attempts to edit an approved model. Require or suggest a draft name, clearly show the created draft and never modify the approved version.  
> D5: **A** — Provide a read-only audit-history view. Keep it out of the primary Model Library table to avoid clutter; expose it through the model’s details or overflow action. No restore function in v1.  
> D6: **B** — Allow lease commencement and operational start dates to differ. Begin the financial timeline at the earlier date. Label periods before operational opening as Pre-opening; customer revenue, occupancy and move-ins remain zero, while landlord rent, deposits, CapEx and valid pre-opening OpEx are included. Investment Returns must include these cash flows.  
> D7: **A** — New models default to a 15% annual discount rate in Investment valuation assumptions. Do not overwrite rates already saved on existing models. Every screen and exported PDF must read the selected model version’s stored rate and identify it.  
> D8: **A** — Build the complete Investment valuation assumptions section: Manual, Risk-Adjusted and WACC methodologies; effective monthly rate; committed horizon; optional renewal; refundable deposit; reinstatement; explicit terminal cash flows. Renewal and terminal values remain off by default. Do not assume a property or fit-out sale value.  
> D9: **B** — Use permission-based access with current roles as defaults. Admin: view, edit drafts, update, submit, approve and retry. Manager: view, edit drafts, update, submit and retry; approval only if explicitly granted. Operator: no lease edits; view only if granted. Viewer: Finance hidden by default but `finance.models.view` may be granted through User Management. No Sales access by default. Do not let Operator edit while Manager is view-only.  
> D10: **A** — Default maximum 120 months and make the maximum globally configurable. Existing models exceeding a future reduced cap remain readable but cannot be extended without authorised configuration.  
> D11: **A** — Produce a shadow-comparison report and require owner/Finance review of every affected CURRENT mid-month model before enabling the new calculation result. First-of-month models can still be regression-tested in the same report.  
> D12: **A** — Keep monetary cash-flow rows rounded to SGD cents. Keep proration factors, discount rates and discount factors unrounded internally. NPV and IRR must consume the same cents-rounded monthly cash-flow series. Validate monetary inputs to two decimals and record this as an accepted implementation decision.  
> D13: **B**, unless the owner supplies a current Sembawang spreadsheet — Build an independently calculated fixture and have Finance/owner sign it off. If an existing spreadsheet is supplied, use it as an additional comparison source, investigate every difference and do not automatically treat its formulas as correct.

## Rationale and implementation clarifications

### D1 — Contractual end date

The recommended literal clamp-then-subtract rule can create an unintuitive short term. For example, it produces 27 February 2029 for a lease beginning on 29 February 2028. The adopted rule is:

```text
nominal_day = day(lease_start_date)
target_month = month containing lease_start_date shifted by committed_term_months

if nominal_day exists in target_month:
    committed_end_date = date(target_month, nominal_day) - 1 day
else:
    committed_end_date = last_calendar_day(target_month)
```

Examples:

| Start date | Term | Inclusive end date |
|---|---:|---|
| 15 Dec 2026 | 12 months | 14 Dec 2027 |
| 29 Feb 2028 | 12 months | 28 Feb 2029 |
| 31 Jan 2027 | 1 month | 28 Feb 2027 |

The generated end date remains reviewable against the signed lease. If a particular contract explicitly states a different end date, StoreLah should store that explicit contractual date and flag any difference from the generated date for confirmation rather than silently changing it.

### D2 — Proration

Actual-days proration is transparent and reconcilable to calendar periods:

```text
period_factor = chargeable_days / days_in_calendar_month
landlord_rent = contractual_monthly_rent × period_factor
```

Do not force the closing stub to become the mathematical complement of the opening stub. Doing so changes the daily rate in the final month and is harder to reconcile to invoices.

### D3 — Rent-free dates

Explicit dates are required because a rent-free period may:

- start or end mid-month;
- differ from the lease commencement date;
- cross a lease-year or calendar-year boundary; or
- apply to base rent while excluding service charges or other landlord charges.

The data model should therefore allow rent-free treatment by charge component if the landlord lease contains different rules.

### D4 and D5 — Drafts and history

Editing an approved model must never mutate it. On the first edit attempt:

1. Create an editable child draft from the approved model.
2. Prompt for a name or offer a clear default such as `Sembawang Base — Draft 2`.
3. Route the user into that draft.
4. Show `Editing draft based on approved version {version}`.
5. Record who created it and when.

The read-only audit history should show field-level before/after values, user, timestamp, source version, resulting version and calculation status. It does not need restore or side-by-side comparison in v1.

### D6 — Two start dates

`lease_commencement_date` and `operational_start_date` represent different commercial events and must remain separate:

| Period | Landlord lease | CapEx/deposit | Customer revenue and occupancy |
|---|---:|---:|---:|
| Before lease commencement | No | Only if contractually paid | No |
| Lease commenced, before operations | Yes, subject to rent-free terms | Yes | No |
| Operations commenced | Yes | As scheduled | Yes |

Financial Model tables should label pre-opening rows clearly. Investment Returns must begin with the earliest project cash flow, not merely the first customer revenue month.

### D7 and D8 — Valuation assumptions

Fifteen per cent is the default required return for newly created StoreLah models, reflecting early-stage execution, occupancy ramp-up and lease risk. It is a default, not a claim that 15% is universally correct.

Existing model versions retain their saved rate, including 8% where already approved. Loading or exporting a model must never substitute a global default for the model’s stored rate.

WACC should be available only when the required financing inputs are complete. Project NPV continues to use unlevered project cash flows and the appropriate project discount rate. Equity NPV is a separate result using post-financing equity cash flows and cost of equity.

### D9 — Access control

Use granular permissions rather than embedding all behaviour directly in role names:

```text
finance.models.view
finance.models.edit_lease
finance.models.submit
finance.models.approve
finance.models.recalculate
finance.models.export
finance.models.view_audit
```

User Management controls these permissions. Role templates provide defaults only. The UI must hide or disable unavailable actions, while the API must enforce the same permissions independently.

### D10 and D11 — Term cap and rollout

The 120-month cap covers leases up to ten years without designing the current UI around unusually long schedules. Keep it configuration-driven so the business can increase it later.

For migration, produce a row-level report containing:

- model and facility;
- old and new lease end dates;
- old and new lease cash flows by affected month;
- old and new Project NPV, IRR and paybacks;
- explanation of each variance; and
- reviewer and approval status.

No approved CURRENT model with a changed result should be switched automatically.

### D12 — Calculation precision

The accepted order is:

1. Calculate proration using unrounded factors.
2. Round the payable cash-flow row to SGD cents.
3. Persist or expose that same cents-rounded row as the monthly cash-flow source of truth.
4. Apply unrounded discount factors to those cash flows.
5. Keep full internal valuation precision and round only displayed metrics.

This prevents the NPV table, exported DCF and accounting-facing monthly rows from using slightly different cash flows.

### D13 — Reconciliation evidence

The independent fixture should include at least:

- first-day and mid-month starts;
- leap-day and month-end dates;
- zero and partial rent-free periods;
- annual rent escalation;
- 12-, 36-, 60- and 120-month terms;
- refundable deposits and reinstatement;
- terminal cash flows on and off;
- NPV at zero, 8% and 15%;
- one valid IRR, no-IRR and multiple-IRR examples; and
- simple and discounted payback inside and beyond the horizon.

The release evidence should retain the fixture, expected results, independent calculation method, reviewer and sign-off date.

## Remaining owner input

Only D13 may require an additional file from the owner: if a current Sembawang Excel financial model exists, provide the latest version for comparison. If none exists, the independently derived and signed-off fixture is sufficient and development should not remain blocked.

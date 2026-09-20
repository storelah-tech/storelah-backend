# StoreLah Promotions Engine — Feature Specification

> **Version:** 1.0 · 11 Sep 2026  
> **Scope:** Operator CMS Discount & Promotion subsystem  
> **Audience:** Engineering, Product, Commercial teams

---

## 1. Feature Map

The Promotions engine lives under the **Promotions** sidebar section in the CMS. It contains **8 sub-tabs**:

| # | Tab ID | Purpose | Data source |
|---|--------|---------|-------------|
| 1 | `promo-overview` (Dashboard) | KPIs, active rule sets, discount cost, conflicts, attention queue | `PromotionPlan` (aggregate) |
| 2 | `promo-discount-matrix` | Build % discount plans by size×access×commitment | `PromotionPlan` (kind=DISCOUNT_MATRIX) + `DiscountMatrixCell` |
| 3 | `promo-free-months` | Build free-month allocation plans | `PromotionPlan` (kind=FREE_MONTHS) + `FreeMonthAllocation` |
| 4 | `promo-code-builder` | Build campaign promo codes with eligibility rules | `PromotionPlan` (kind=PROMO_CODE) + `PromotionRule` |
| 5 | `promo-library` | Unified list of all plans and codes | All `PromotionPlan` records |
| 6 | `promo-history` | Versioned snapshots of every plan | `PromotionVersion` |
| 7 | `promo-safeguards` | Rate floors, rule priority, approval workflow | `SafeguardRule` + config |
| 8 | `promo-performance` | Revenue impact, usage tracking, commercial health | Aggregated from `Promotion` + bookings |

---

## 2. Correlation Between Features

### 2.1 How Plans Produce Promotions

- **Discount plan** (DISCOUNT_MATRIX) → automatic % discounts applied at booking based on unit size, access type, and commitment duration. Stored as matrix cells.
- **Free months plan** (FREE_MONTHS) → automatically marks specific months in a commitment as free (or discounted). Defined via month-strip selection.
- **Promo code** (PROMO_CODE) → customer-entered code validated at checkout. Has eligibility rules and campaign limits.
- **Credits** (CREDITS) → future: wallet-based reward stored against customer account.

All three produce **customer-facing discounts** that are ultimately recorded as `Promotion` redemption rows.

### 2.2 Promotions Library (Tab 5)

The library is a **unified table** showing every `PromotionPlan` regardless of kind. Each row shows name, benefit type, eligibility summary, commitment, validity period, usage stats, effective discount, and status.

### 2.3 History (Tab 6)

Every save/publish of a `PromotionPlan` creates a `PromotionVersion` snapshot (full JSON of the plan state at that point). Active/Ended versions are immutable. Editing always creates a new Draft.

### 2.4 Safeguards (Tab 7)

Three layers that apply across all plan kinds:

1. **Rule priority** — contracted rate → automatic plan → promo code → credits
2. **Rate floors** — `SafeguardRule` per facility/size: min effective rate, requires approval above threshold
3. **Approval workflow** — automatic (≤25%), manager (25–40%), Commercial/Finance (>40%)

### 2.5 Performance (Tab 8)

Tracks per-plan: eligible bookings, applied count, booked revenue, discount cost, effective rate, retention. Data aggregated from `Promotion` redemptions linked to plans.

### 2.6 Choice-Grid on Promo Code Builder

The 4 benefit type choices (`PERCENTAGE`, `DOLLAR`, `FREE_MONTHS`, `CREDITS`) determine which form fields appear:

| Choice | Shown fields |
|--------|-------------|
| Percentage off | Discount value (%), Apply discount to, Name, Code |
| Dollar value off | Discount amount ($), Apply discount to, Name, Code |
| Free months | Number of free months, Month allocation, Name, Code |
| StoreLah Credits | Credit value, Issue timing, Name, Code |

### 2.7 Discount Matrix Values

The matrix grid has **6 size categories** (LOCKER, SMALL, MEDIUM, LARGE, XL, XXL) × **4 commitment bands** (1/3/6/12 months) = **24 cells**. Each cell stores a discount percentage. The matrix is versioned with the parent plan. Builder authors Standard cells only; Ground floor cells are legacy read-only.

### 2.8 Month Strip & Free Months Plan

The month strip renders 12 months in a grid. Each month can be:
- **Normal** (100% — full rate charged)
- **Free** (FREE — no charge, background turns olive)
- **Discounted** (partial discount — future: amber background)

The plan stores `freeMonthCount` (1, 2, 3, or custom) and `commitmentMonths` (3, 6, 12). Each `FreeMonthAllocation` row captures which month indices are free/discounted.

### 2.9 Eligibility Rules for Promo Codes

Rules are grouped by `groupId` (AND/OR logic). Each rule targets:
- Branch/facility
- Unit size category
- Storage type
- Customer type (new/existing)
- Customer group
- Commitment duration
- Tenure
- Move-in date window

Rules feed into `PromotionRule` records.

---

## 3. Data Model Design (ERD-like)

### `PromotionPlan`
| Field | Type | Notes | Tabs |
|-------|------|-------|------|
| id | String (cuid) | PK | All |
| kind | enum | DISCOUNT_MATRIX / FREE_MONTHS / PROMO_CODE / CREDITS | 2,3,4,5 |
| name | String | Plan name | All |
| code | String? | Customer-facing code (only for PROMO_CODE kind) | 4,5 |
| status | enum | DRAFT / VALIDATED / SCHEDULED / ACTIVE / ENDED | 1,2,3,4,5,6 |
| description | String? | Internal notes | 2,3,4 |
| effectiveFrom | DateTime | Plan start date | 2,3,4,5 |
| effectiveTo | DateTime? | Plan end date | 2,3,4,5 |
| facilityScope | Json | `["ALL"]` or list of branch IDs | 2,3,4 |
| storageType | String? | "Self Storage" / "Business Storage" / "Wine Storage" | 2,3,4 |
| sizeScope | Json | `["ALL"]` or list of UnitSize IDs | 2,3,4 |
| appliesTo | String? | "First invoice" / "First 3 invoices" / "Every invoice" / "Selected months" | 4 |
| usagePerCustomer | Int? | Limit per customer | 4 |
| redemptionCap | Int? | Total capacity | 4 |
| stackingRule | String? | "Exclusive" / "Can combine selected" / "Can combine with credits" | 4 |
| budgetCap | Decimal? | Maximum discount budget | 4 |
| version | Int | Auto-incrementing version | 6 |
| createdAt | DateTime | | |
| updatedAt | DateTime | | |

**Relations:**
- One → many `DiscountMatrixCell` (for DISCOUNT_MATRIX kind)
- One → many `FreeMonthAllocation` (for FREE_MONTHS kind)
- One → many `PromotionRule` (for PROMO_CODE kind)
- One → many `PromotionVersion`
- One → many `Promotion` (customer-facing redemptions)

### `DiscountMatrixCell`
| Field | Type | Notes |
|-------|------|-------|
| id | String (cuid) | PK |
| planId | String | FK → PromotionPlan |
| sizeCategory | String | LOCKER / SMALL / MEDIUM / LARGE / XL / XXL (canonical; legacy XS reads as LOCKER) |
| accessType | String | "Ground floor" or "Standard" — builder authors Standard only; Ground floor is legacy read-only |
| commitmentMonths | Int | 3 / 6 / 12 |
| discountPct | Decimal | 0–100 |

**Relations:** belongs to PromotionPlan

### `FreeMonthAllocation`
| Field | Type | Notes |
|-------|------|-------|
| id | String (cuid) | PK |
| planId | String | FK → PromotionPlan |
| monthIndex | Int | 0-based (0 = month 1) |
| free | Boolean | Is this month free? |
| discountPct | Decimal? | Partial discount if not free |

**Relations:** belongs to PromotionPlan

### `PromotionRule`
| Field | Type | Notes |
|-------|------|-------|
| id | String (cuid) | PK |
| planId | String | FK → PromotionPlan |
| groupId | Int | Groups rules into AND/OR clauses |
| field | String | "Facility" / "Size category" / "Customer type" / etc. |
| operator | String | "equals" / "is any of" / "at least" / "is between" / "is not" |
| value | String | The RHS value |

**Relations:** belongs to PromotionPlan

### `PromotionVersion`
| Field | Type | Notes |
|-------|------|-------|
| id | String (cuid) | PK |
| planId | String | FK → PromotionPlan |
| version | Int | Sequential version number |
| snapshot | Json | Full plan state (cells, allocs, rules, all fields) |
| changedBy | String | Operator name or "System" |
| changeSummary | String | Humanities summary of changes |
| createdAt | DateTime | Version timestamp |

**Relations:** belongs to PromotionPlan

### `Promotion` (existing — enhanced)
| Field (existing) | Type | Notes |
|------------------|------|-------|
| id | String | PK |
| code | String @unique | Customer-facing code |
| name | String | Display name |
| description | String? | |
| discountType | enum | PERCENTAGE / FLAT |
| discountValue | Decimal | |
| minMonths | Int? | |
| applicableSizeId | String? | FK → UnitSize |
| startDate | DateTime? | |
| endDate | DateTime? | |
| active | Boolean | |
| createdAt | DateTime | |
| updatedAt | DateTime | |

| Field (new) | Type | Notes |
|-------------|------|-------|
| planId | String? | FK → PromotionPlan (nullable for backward compat) |
| status | enum | DRAFT / ACTIVE / SCHEDULED / ENDED / USED |
| benefitType | enum? | PERCENTAGE / DOLLAR / FREE_MONTHS / CREDITS |
| applyTo | String? | "First invoice only" / "First 3 invoices" / "Every invoice" / "Selected months" |
| usagePerCustomer | Int? | |
| redemptionCap | Int? | |
| perUnitApplication | Boolean? | |
| stackingRule | String? | "Cannot combine" / "Can combine selected" / "Can combine with credits" |
| budgetCap | Decimal? | |

### `SafeguardRule`
| Field | Type | Notes |
|-------|------|-------|
| id | String (cuid) | PK |
| facilityId | String? | FK → Branch (null = global) |
| sizeId | String? | FK → UnitSize (null = all sizes) |
| minEffectiveRate | Decimal | Floor rate that discounts cannot go below |
| requiresApprovalAbove | Decimal? | Discount % threshold requiring approval |
| approverRole | String? | Role that approves |

---

## 4. API Contract

All endpoints under `/api/v1/cms`. Auth: Bearer JWT.

### Promotion Plans

| Method | Path | Description |
|--------|------|-------------|
| GET | `/promotion-plans` | List all plans (include cells, allocs, rules, latest version) |
| POST | `/promotion-plans` | Create plan (with nested cells/allocs/rules) |
| GET | `/promotion-plans/:id` | Get single plan with all nested data |
| PUT | `/promotion-plans/:id` | Update plan (replaces nested data) |
| PATCH | `/promotion-plans/:id/status` | Change status (DRAFT→VALIDATED→SCHEDULED→ACTIVE→ENDED) |
| POST | `/promotion-plans/:id/validate` | Validate plan (check completeness, rate floors, overlap) |
| POST | `/promotion-plans/:id/duplicate` | Create copy as new draft (bumps version) |
| DELETE | `/promotion-plans/:id` | Delete plan (only DRAFT status) |

### Safeguards

| Method | Path | Description |
|--------|------|-------------|
| GET | `/safeguards` | List all safeguard rules |
| POST | `/safeguards` | Create safeguard rule |
| PUT | `/safeguards/:id` | Update safeguard rule |
| DELETE | `/safeguards/:id` | Delete safeguard |

### Promotions (existing — enhanced)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/promotions` | List all promotions (now includes planId, status, benefitType) |
| POST | `/promotions` | Create promotion (now optional planId) |
| GET | `/promotions/:id` | Get promotion detail |
| PUT | `/promotions/:id` | Update promotion |
| DELETE | `/promotions/:id` | Delete promotion |

### Public endpoints (unchanged contract)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/public/promotions` | List active, date-window-filtered promotions |
| POST | `/api/v1/public/promotions/validate` | Validate promo code against rate + months |

---

## 5. Gap Analysis

### Already backed by live data

| Feature | Data source | Status |
|---------|-------------|--------|
| Promotions library static rows | `Promotion` model | ✅ Static sample rows in HTML + `bindPromotionsOverview()` reads real promotions |
| Overview stats (active count) | `Promotion` model | ✅ Partial (only counts code-based promos, not plans) |
| Public promotions list + validate | `Promotion` model | ✅ Full |
| Discount matrix 36-cell input | HTML static | ❌ Sample data only |
| Free months month strip | HTML static | ❌ Sample data only |
| Promo code builder form | HTML static | ❌ Sample data only |
| Eligibility rules builder | HTML static | ❌ Sample data only |
| Plan validation modal | HTML static | ❌ Sample data only |
| Plan history table | HTML static | ❌ Sample data only |
| Safeguards risk controls | HTML static | ❌ Sample data only |
| Performance analytics | HTML static | ❌ Sample data only |
| Duplicate/save/schedule plan | `PromotionPlan` + admin.js | ❌ Client-side only (no persistence) |

### What this task delivers

- `PromotionPlan`, `DiscountMatrixCell`, `FreeMonthAllocation`, `PromotionRule`, `PromotionVersion`, `SafeguardRule` models with full CRUD
- Migration to create tables (additive — existing `Promotion` table untouched)
- Enhanced `Promotion` model with `planId`, `status`, `benefitType`, `applyTo`, etc.
- API routes for plans, safeguards, and enhanced promotions
- Admin JS data bindings to wire overview, library, and builder tabs to live API

### Intentionally deferred (sample data preserved)

- **Calendar scheduling** — the "Schedule next month" action creates a draft row only
- **Real-time validation engine** — the validation modal shows static check results
- **Performance aggregation** — revenue impact charts remain sample data
- **Promotion redemptions tracking** — `Promotion` linking to bookings/invoices is future work
- **Approval workflow state machine** — safeguards tab shows static policy descriptions
- **Credits (PROMO_CODE → CREDITS)** — model supports it but UI not wired
- **Customer-facing public listing of discount plans** — only code-based promos currently public

---

*End of spec*
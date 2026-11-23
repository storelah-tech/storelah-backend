// Master Rate Strategy — pure pricing engine (Track B, B1).
//
// PURE: no DB, no clock, no imports from server modules. Inventory,
// promotions and the Financial Model target are passed in as parameters so
// preview and apply (B3) share this exact code path (server-is-authoritative).
//
// Terminology (R14 — do NOT reuse the prototype's confusing `effective*`
// name for blended values):
//   rack*      = pre-promotion monthly rent / PSF
//   effective* = after percentage discount(s), recurring
//   blended*   = with free months spread across the commitment
//
// Target PSF (P0-open question, resolved for B1 as source-agnostic input):
// the engine takes `targetPsf` as a plain number. B3 MUST resolve it from
// the branch's latest CURRENT (approved) FinancialModel by running the same
// pure `project()` engine and reading `kpis.weightedStartPsf` (reference
// 5.6384) — see docs/pricing/MASTER_RATE_STRATEGY_PLAN.md §2. Never a DRAFT
// model, never a hard-coded fallback. A null target means "unavailable": the
// engine reports variance as null plus a TARGET_UNAVAILABLE warning.
//
// Money discipline: every monthly-rent step is integer cents; the single
// float multiply per discount application is rounded back to cents
// immediately (no float accumulation). PSF values are rates, kept at 4dp.
//
// Caller-side derivations required by R15 (the engine trusts them):
//   sizePoint   = Math.round(unit.sqft)
//   isLocker    = unit's UnitSize.code === 'LOCKER'
//   ground floor / restricted = per-unit flags; B3 finalizes them per unit via
//     finalizeRackCents()/rackCentsForUnit() (batch writes) — the size
//     schedule itself is the unattributed base rate (§15.7 example cards
//     isolate each factor).

export type PricingMethod = 'SMOOTH' | 'STEP';

export type SizeCategory = 'LOCKER' | 'XS' | 'S' | 'M' | 'L' | 'XL';

export type RoundingIncrement = 1 | 5 | 10;

export type DurationMonths = 1 | 3 | 6 | 12;

/** Prototype §15.8 workbench defaults (business rules, not demo data). */
export const DEFAULT_LEVERS = {
  referenceSize: 10,
  startingRate: 90,
  method: 'SMOOTH' as PricingMethod,
  curveStrength: 0.2,
  stepEvery: 5,
  stepPsf: 0.2,
  psfFloor: 4.2,
  minMonthly: 45,
  lockerAdj: -0.25,
  groundFloorAdj: 0.1,
  restrictedAdj: -0.1,
  facilityAdj: 0,
  rounding: 1 as RoundingIncrement,
  categoryFloors: {
    LOCKER: 7.0,
    XS: 7.0,
    S: 6.5,
    M: 5.8,
    L: 5.0,
    XL: 4.2,
  } as Record<SizeCategory, number>,
} as const;

/** Commercial schedule window; the upper end extends, never hard-coded (§26.15). */
export const SCHEDULE_MIN_SIZE = 8;
export const SCHEDULE_BASE_MAX_SIZE = 150;

export interface StrategyLevers {
  referenceSize: number;
  startingRate: number;
  method: PricingMethod;
  curveStrength: number;
  stepEvery: number;
  stepPsf: number;
  psfFloor: number;
  minMonthly: number;
  lockerAdj: number;
  groundFloorAdj: number;
  restrictedAdj: number;
  facilityAdj: number;
  rounding: RoundingIncrement;
  /** Minimum rack PSF per category; absent category = overall floor only. */
  categoryFloors: Partial<Record<SizeCategory, number>>;
  sizeOverrides: SizeOverride[];
}

export interface SizeOverride {
  size: number;
  monthlyRate: number;
  reason: string;
}

/** One stocked size point at a facility (lives in Facilities · Units in B3). */
export interface StockedSizeInput {
  /** Whole sq ft — B3 derives via Math.round(unit.sqft) per R15. */
  sizePoint: number;
  unitCount: number;
  /** B3 derives from UnitSize.code === 'LOCKER' per R15. */
  isLocker?: boolean;
}

/**
 * Read-only promotion preview input (Discount & Promotion owns the records).
 * D11: planId + planVersion travel with the version so B2 can persist the
 * referenced plan versions for reproducibility.
 */
export interface PromotionPreviewInput {
  planId: string;
  planVersion: number;
  /** 'ACTIVE' = selectable; anything else (e.g. 'DRAFT') = preview-only warning. */
  status: string;
  kind: 'PERCENTAGE' | 'FREE_MONTHS';
  /** PERCENTAGE: size point -> discount decimal 0..1 (caller's matrix column). */
  discountsBySize?: Record<number, number>;
  /** FREE_MONTHS: number of free months in the commitment. */
  freeMonths?: number;
  /** FREE_MONTHS: categories eligible; omitted = all stocked categories. */
  eligibleCategories?: SizeCategory[];
  /** FREE_MONTHS: duration this plan requires; omitted = selected duration. */
  commitmentMonths?: number;
  /** Which matrix column was previewed ('Standard' | 'Ground floor'). */
  matrix?: string;
}

export interface PreviewRequest {
  levers: StrategyLevers;
  inventory: StockedSizeInput[];
  promotions: PromotionPreviewInput[];
  selectedDurationMonths: DurationMonths;
  /** Source-agnostic approved-model target (CURRENT FinancialModel KPI). */
  targetPsf: number | null;
  /** Which access column is previewed; echoed into previewSelection (D11). */
  matrix?: string;
}

export interface SizeRateRow {
  size: number;
  category: SizeCategory;
  stocked: boolean;
  unitCount: number;
  rackMonthly: number;
  rackPsf: number;
  combinedDiscount: number;
  effectiveMonthly: number;
  effectivePsf: number;
  freeMonths: number;
  commitmentMonths: number;
  /** Always computed (= effective when no free months, §15.16); see hasBlended. */
  blendedMonthly: number;
  blendedPsf: number;
  /** False -> UI must NOT render Blended columns/series (§15.17, rate case 17). */
  hasBlended: boolean;
  overridden: boolean;
  targetPsf: number | null;
  /** Recurring Effective PSF minus target (never Blended, §15.18 / rate 14). */
  gapVsTarget: number | null;
}

export interface FacilitySummary {
  stockedSizeCount: number;
  totalUnits: number;
  totalNla: number;
  rackPotential: number;
  netPotential: number;
  blendedPotential: number;
  weightedRackPsf: number;
  weightedEffectivePsf: number;
  weightedBlendedPsf: number | null;
  hasBlended: boolean;
  targetPsf: number | null;
  gapVsTarget: number | null;
}

export interface PreviewSelectionEcho {
  durationMonths: DurationMonths;
  matrix: string | null;
  planRefs: Array<{
    planId: string;
    planVersion: number;
    status: string;
    kind: 'PERCENTAGE' | 'FREE_MONTHS';
  }>;
}

export interface ValidationIssue {
  code: string;
  message: string;
  /** D12: every warning MUST carry a human-readable reason. */
  reason: string;
  sizes?: number[];
}

export interface ValidationPassed {
  code: string;
  /** Human-readable label — same role as ValidationIssue.message (B-11). */
  message: string;
}

/**
 * Human-readable labels for the validation Passed list (B-11). The UI
 * renders `message`, never the raw code; codes stay for stable assertions.
 */
export const PASSED_MESSAGES: Record<string, string> = {
  HAS_INVENTORY: 'Facility sizes are linked.',
  STARTING_RATE_POSITIVE: 'Starting monthly rack rate is greater than zero.',
  REFERENCE_SIZE_VALID: 'Reference size is at least 1 sq ft.',
  FLOOR_NON_NEGATIVE: 'Overall PSF floor is not negative.',
  STEP_SETTINGS_VALID: 'Step-down settings are valid.',
  ROUNDING_VALID: 'Rounding increment is S$1, S$5 or S$10.',
  FLOORS_HOLD: 'Stocked sizes meet the applicable rack PSF floors.',
  NO_WARNINGS: 'No warnings.',
};

export interface StrategyValidation {
  blockers: ValidationIssue[];
  warnings: ValidationIssue[];
  passed: ValidationPassed[];
}

export interface FacilityPreview {
  scheduleMax: number;
  rows: SizeRateRow[];
  summary: FacilitySummary;
  validation: StrategyValidation;
  previewSelection: PreviewSelectionEcho;
  /** Stocked sizes above the 150 commercial window (D13/R15 flag). */
  sizesAboveRange: number[];
}

// ---------------------------------------------------------------------------
// cents-safe helpers
// ---------------------------------------------------------------------------

const toCents = (sgd: number): number => Math.round(sgd * 100);
const toSgd = (cents: number): number => Math.round(cents) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const round6 = (n: number): number => Math.round(n * 1000000) / 1000000;

/** Round a cents value to the nearest S$1 / S$5 / S$10 increment. */
export function roundToIncrementCents(cents: number, rounding: RoundingIncrement): number {
  const inc = rounding * 100;
  return Math.round(cents / inc) * inc;
}

// ---------------------------------------------------------------------------
// categories (handoff §15.10 + R15)
// ---------------------------------------------------------------------------

/**
 * Locker (8–15) overlaps XS (10–19) by design; the locker attribute wins.
 * Non-locker sizes below 10 fall to the nearest band (XS). Sizes above 150
 * use XL (R15); D13 flags stocked ones in the report.
 */
/** Ground-floor attribute: building Level 1 only (Floor.level is the real level). */
export function isGroundFloorLevel(level: number): boolean {
  return level === 1;
}

export function categoryForSize(size: number, isLocker = false): SizeCategory {
  if (isLocker) return 'LOCKER';
  if (size < 20) return 'XS';
  if (size < 40) return 'S';
  if (size < 70) return 'M';
  if (size < 100) return 'L';
  return 'XL';
}

// ---------------------------------------------------------------------------
// rack-rate core (§15.9)
// ---------------------------------------------------------------------------

/** Raw pre-floor PSF for one size point. */
export function rawPsf(size: number, levers: StrategyLevers): number {
  const basePsf = levers.startingRate / levers.referenceSize;
  if (levers.method === 'STEP') {
    const steps = Math.floor(Math.max(0, size - levers.referenceSize) / levers.stepEvery);
    return basePsf - steps * levers.stepPsf;
  }
  return basePsf * Math.pow(size / levers.referenceSize, -levers.curveStrength);
}

export function applicableFloor(size: number, isLocker: boolean, levers: StrategyLevers): number {
  const category = categoryForSize(size, isLocker);
  return Math.max(levers.psfFloor, levers.categoryFloors[category] ?? Number.NEGATIVE_INFINITY);
}

/**
 * Pre-attribute base monthly rent in cents: PSF floors applied, but no
 * attribute adjustments, no monthly minimum and no increment rounding yet.
 */
export function baseMonthlyCents(size: number, isLocker: boolean, levers: StrategyLevers): number {
  const preAttrPsf = Math.max(rawPsf(size, levers), applicableFloor(size, isLocker, levers));
  return toCents(preAttrPsf * size);
}

/**
 * Finalize a (generated or override) base into the published rack rent
 * (§15.9): attribute adjustments FIRST, then max(minimum monthly rent,
 * adjusted), then round to the increment. The minimum and the rounding both
 * sit AFTER the adjustments, so a discounted locker can never publish below
 * the minimum and an uplifted unit always lands on the increment.
 */
export function finalizeRackCents(
  baseCents: number,
  attrs: UnitAttributes,
  levers: Pick<
    StrategyLevers,
    'lockerAdj' | 'groundFloorAdj' | 'restrictedAdj' | 'facilityAdj' | 'minMonthly' | 'rounding'
  >,
): number {
  const adjusted = applyAttributeAdjustments(baseCents, attrs, levers);
  const floored = Math.max(toCents(levers.minMonthly), adjusted);
  return roundToIncrementCents(floored, levers.rounding);
}

/**
 * Attributed per-unit final rack in cents (§15.9 order). `isLocker` feeds
 * both the category floor (via baseMonthlyCents) and the locker factor.
 */
export function rackCentsForUnit(
  size: number,
  attrs: UnitAttributes,
  levers: StrategyLevers,
): number {
  return finalizeRackCents(baseMonthlyCents(size, attrs.isLocker ?? false, levers), attrs, levers);
}

/**
 * Generated (pre-override, unattributed) schedule rack in cents. The size
 * schedule carries no per-unit attributes, so this is the base finalized
 * with empty attributes — identical values to the pre-B-9 schedule.
 */
export function generatedRackCents(size: number, isLocker: boolean, levers: StrategyLevers): number {
  return finalizeRackCents(baseMonthlyCents(size, isLocker, levers), {}, levers);
}

export interface UnitAttributes {
  isLocker?: boolean;
  isGroundFloor?: boolean;
  isRestricted?: boolean;
}

/**
 * Signed attribute factors, multiplicative (§15.9). Each factor applies only
 * when the unit carries the attribute — cards isolate factors, they never
 * imply every unit receives every factor.
 */
export function applyAttributeAdjustments(
  baseMonthlyCents: number,
  attrs: UnitAttributes,
  levers: Pick<StrategyLevers, 'lockerAdj' | 'groundFloorAdj' | 'restrictedAdj' | 'facilityAdj'>,
): number {
  let cents = baseMonthlyCents;
  cents = Math.round(cents * (1 + (attrs.isLocker ? levers.lockerAdj : 0)));
  cents = Math.round(cents * (1 + (attrs.isGroundFloor ? levers.groundFloorAdj : 0)));
  cents = Math.round(cents * (1 + (attrs.isRestricted ? levers.restrictedAdj : 0)));
  cents = Math.round(cents * (1 + levers.facilityAdj));
  return cents;
}

/**
 * Isolated-factor example cards (§15.7): base + each factor alone + combined.
 * Each card is a finalized rate (adjust → minimum → increment rounding,
 * §15.9), so lockers show the floored minimum and uplifted units land on the
 * rounding increment exactly as a published batch would.
 */
export function buildAttributeExamples(
  baseCents: number,
  levers: Pick<
    StrategyLevers,
    'lockerAdj' | 'groundFloorAdj' | 'restrictedAdj' | 'facilityAdj' | 'minMonthly' | 'rounding'
  >,
): { base: number; locker: number; groundFloor: number; restricted: number; combined: number } {
  return {
    base: toSgd(finalizeRackCents(baseCents, {}, levers)),
    locker: toSgd(finalizeRackCents(baseCents, { isLocker: true }, levers)),
    groundFloor: toSgd(finalizeRackCents(baseCents, { isGroundFloor: true }, levers)),
    restricted: toSgd(finalizeRackCents(baseCents, { isRestricted: true }, levers)),
    combined: toSgd(
      finalizeRackCents(baseCents, { isLocker: true, isGroundFloor: true, isRestricted: true }, levers),
    ),
  };
}

// ---------------------------------------------------------------------------
// promotions (§15.13–§15.15)
// ---------------------------------------------------------------------------

/** Combined percentage discount: 1 − Π(1 − d) — sequential, never additive. */
export function combineDiscounts(discounts: number[]): number {
  return round6(1 - discounts.reduce((acc, d) => acc * (1 - d), 1));
}

function discountForSize(promos: PromotionPreviewInput[], size: number): number {
  const ds: number[] = [];
  for (const p of promos) {
    if (p.kind !== 'PERCENTAGE') continue;
    const d = p.discountsBySize?.[size] ?? 0;
    if (d > 0) ds.push(d);
  }
  return combineDiscounts(ds);
}

function freeMonthsFor(
  promos: PromotionPreviewInput[],
  category: SizeCategory,
  durationMonths: number,
): number {
  let free = 0;
  for (const p of promos) {
    if (p.kind !== 'FREE_MONTHS' || !p.freeMonths) continue;
    if (p.commitmentMonths != null && p.commitmentMonths !== durationMonths) continue;
    if (p.eligibleCategories && !p.eligibleCategories.includes(category)) continue;
    free += p.freeMonths;
  }
  return free;
}

export interface PromotionOutcome {
  effectiveMonthlyCents: number;
  blendedMonthlyCents: number;
  freeMonths: number;
  hasBlended: boolean;
}

export function applyPromotions(
  rackMonthlyCents: number,
  combinedDiscount: number,
  freeMonths: number,
  commitmentMonths: number,
): PromotionOutcome {
  const effectiveMonthlyCents = Math.round(rackMonthlyCents * (1 - combinedDiscount));
  const paidMonths = Math.max(0, commitmentMonths - freeMonths);
  const commitmentCents = effectiveMonthlyCents * paidMonths;
  const blendedMonthlyCents = Math.round(commitmentCents / commitmentMonths);
  return {
    effectiveMonthlyCents,
    blendedMonthlyCents,
    freeMonths,
    hasBlended: freeMonths > 0,
  };
}

// ---------------------------------------------------------------------------
// facility preview
// ---------------------------------------------------------------------------

/** Schedule covers 8 to the largest stocked size, never below 150 (R15/D13). */
export function scheduleMaxFor(inventory: StockedSizeInput[]): number {
  const largest = inventory.reduce((m, s) => Math.max(m, s.sizePoint), 0);
  return Math.max(SCHEDULE_BASE_MAX_SIZE, largest);
}

function overrideFor(levers: StrategyLevers, size: number): SizeOverride | undefined {
  return levers.sizeOverrides.find((o) => o.size === size);
}

export function previewFacility(req: PreviewRequest): FacilityPreview {
  const { levers, inventory, promotions, selectedDurationMonths, targetPsf } = req;
  const scheduleMax = scheduleMaxFor(inventory);
  const stockedBySize = new Map<number, StockedSizeInput>();
  for (const s of inventory) {
    const prev = stockedBySize.get(s.sizePoint);
    if (prev) {
      prev.unitCount += s.unitCount;
      prev.isLocker = prev.isLocker || s.isLocker;
    } else {
      stockedBySize.set(s.sizePoint, { ...s });
    }
  }

  const rows: SizeRateRow[] = [];
  for (let size = SCHEDULE_MIN_SIZE; size <= scheduleMax; size += 1) {
    const stocked = stockedBySize.get(size);
    const isLocker = stocked?.isLocker ?? false;
    const category = categoryForSize(size, isLocker);
    const override = overrideFor(levers, size);

    const rackCents = override ? toCents(override.monthlyRate) : generatedRackCents(size, isLocker, levers);
    const discount = discountForSize(promotions, size);
    const free = freeMonthsFor(promotions, category, selectedDurationMonths);
    const promo = applyPromotions(rackCents, discount, free, selectedDurationMonths);

    const rackMonthly = toSgd(rackCents);
    const effectiveMonthly = toSgd(promo.effectiveMonthlyCents);
    const blendedMonthly = toSgd(promo.blendedMonthlyCents);
    const effectivePsf = round4(promo.effectiveMonthlyCents / 100 / size);
    rows.push({
      size,
      category,
      stocked: stocked != null,
      unitCount: stocked?.unitCount ?? 0,
      rackMonthly,
      rackPsf: round4(rackCents / 100 / size),
      combinedDiscount: discount,
      effectiveMonthly,
      effectivePsf,
      freeMonths: promo.freeMonths,
      commitmentMonths: selectedDurationMonths,
      blendedMonthly,
      blendedPsf: round4(promo.blendedMonthlyCents / 100 / size),
      hasBlended: promo.hasBlended,
      overridden: override != null,
      targetPsf,
      gapVsTarget: targetPsf == null ? null : round4(effectivePsf - targetPsf),
    });
  }

  const stockedRows = rows.filter((r) => r.stocked);
  const totalUnits = stockedRows.reduce((s, r) => s + r.unitCount, 0);
  const totalNla = stockedRows.reduce((s, r) => s + r.size * r.unitCount, 0);
  const rackPotential = toSgd(
    stockedRows.reduce((s, r) => s + toCents(r.rackMonthly) * r.unitCount, 0),
  );
  const netPotential = toSgd(
    stockedRows.reduce((s, r) => s + toCents(r.effectiveMonthly) * r.unitCount, 0),
  );
  const blendedPotential = toSgd(
    stockedRows.reduce((s, r) => s + toCents(r.blendedMonthly) * r.unitCount, 0),
  );
  const hasBlended = stockedRows.some((r) => r.hasBlended);
  const weightedRackPsf = totalNla > 0 ? round4(rackPotential / totalNla) : 0;
  const weightedEffectivePsf = totalNla > 0 ? round4(netPotential / totalNla) : 0;
  const summary: FacilitySummary = {
    stockedSizeCount: stockedRows.length,
    totalUnits,
    totalNla,
    rackPotential,
    netPotential,
    blendedPotential,
    weightedRackPsf,
    weightedEffectivePsf,
    weightedBlendedPsf: totalNla > 0 && hasBlended ? round4(blendedPotential / totalNla) : null,
    hasBlended,
    targetPsf,
    gapVsTarget: targetPsf == null || totalNla === 0 ? null : round4(weightedEffectivePsf - targetPsf),
  };

  const sizesAboveRange = stockedRows.filter((r) => r.size > SCHEDULE_BASE_MAX_SIZE).map((r) => r.size);

  return {
    scheduleMax,
    rows,
    summary,
    validation: validateStrategy(req, rows, summary, sizesAboveRange),
    previewSelection: {
      durationMonths: selectedDurationMonths,
      matrix: req.matrix ?? promotions.find((p) => p.matrix)?.matrix ?? null,
      planRefs: promotions.map((p) => ({
        planId: p.planId,
        planVersion: p.planVersion,
        status: p.status,
        kind: p.kind,
      })),
    },
    sizesAboveRange,
  };
}

// ---------------------------------------------------------------------------
// validation (§15.23 + D12: warnings always carry a reason; no numeric
// magnitude ever blocks — below-target is a warning at any size of gap)
// ---------------------------------------------------------------------------

export function validateStrategy(
  req: PreviewRequest,
  rows: SizeRateRow[],
  summary: FacilitySummary,
  sizesAboveRange: number[],
): StrategyValidation {
  const { levers, promotions, targetPsf } = req;
  const blockers: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const passed: ValidationPassed[] = [];
  const pass = (code: string): void => {
    passed.push({ code, message: PASSED_MESSAGES[code] ?? code });
  };

  const stockedRows = rows.filter((r) => r.stocked);

  if (stockedRows.length === 0) {
    blockers.push({
      code: 'NO_INVENTORY',
      message: 'No facility sizes are linked yet.',
      reason: 'Facility totals, weighted PSF and the schedule need at least one stocked size from Facilities · Units.',
    });
  } else {
    pass('HAS_INVENTORY');
  }

  if (!(levers.startingRate > 0)) {
    blockers.push({
      code: 'INVALID_STARTING_RATE',
      message: 'Starting monthly rack rate is not greater than zero.',
      reason: 'The anchor rate scales every size point; a zero or negative anchor produces no valid schedule.',
    });
  } else {
    pass('STARTING_RATE_POSITIVE');
  }

  if (!(levers.referenceSize >= 1)) {
    blockers.push({
      code: 'INVALID_REFERENCE_SIZE',
      message: 'Reference size must be at least 1 sq ft.',
      reason: 'The anchor rate is quoted at the reference size; it must be a real size point.',
    });
  } else {
    pass('REFERENCE_SIZE_VALID');
  }

  if (levers.psfFloor < 0) {
    blockers.push({
      code: 'NEGATIVE_FLOOR',
      message: 'Overall PSF floor is negative.',
      reason: 'A floor is a minimum allowable PSF; a negative floor is never meaningful.',
    });
  } else {
    pass('FLOOR_NON_NEGATIVE');
  }

  if (levers.method === 'STEP' && !(levers.stepEvery >= 1)) {
    blockers.push({
      code: 'INVALID_STEP_INTERVAL',
      message: 'PSF reduction interval must be at least 1 sq ft.',
      reason: 'The step-down method divides by the interval; zero or negative would be division by zero or nonsense.',
    });
  }
  if (levers.method === 'STEP' && levers.stepPsf < 0) {
    blockers.push({
      code: 'NEGATIVE_STEP_PSF',
      message: 'PSF reduction per step is negative.',
      reason: 'A negative step would raise PSF with size, contradicting the step-down method.',
    });
  }
  if (levers.method === 'STEP' && levers.stepEvery >= 1 && levers.stepPsf >= 0) {
    pass('STEP_SETTINGS_VALID');
  }

  if (![1, 5, 10].includes(levers.rounding)) {
    blockers.push({
      code: 'INVALID_ROUNDING',
      message: 'Rounding increment must be S$1, S$5 or S$10.',
      reason: 'Published rates round to a supported increment so quotes and the schedule agree.',
    });
  } else {
    pass('ROUNDING_VALID');
  }

  for (const o of levers.sizeOverrides) {
    if (!(o.monthlyRate > 0)) {
      blockers.push({
        code: 'INVALID_OVERRIDE',
        message: `Override for ${o.size} sq ft must be greater than zero.`,
        reason: 'An override replaces the generated rack rate; it must be a positive monthly rent.',
        sizes: [o.size],
      });
    }
    if (!o.reason.trim()) {
      blockers.push({
        code: 'OVERRIDE_REASON_REQUIRED',
        message: `Override for ${o.size} sq ft needs a reason.`,
        reason: 'Every override stays visible and auditable; a reason is mandatory.',
        sizes: [o.size],
      });
    }
  }

  // Floors bind pre-attribute and pre-rounding by construction (generated
  // rows take max() with the floor), so only an override can truly breach.
  // Generated rows are skipped here — rounding to S$1/5/10 can leave the
  // displayed PSF a fraction under the floor, which is presentation, not a
  // breach. Overridden rows are checked exactly.
  const belowFloor = stockedRows.filter(
    (r) =>
      r.overridden && r.rackPsf < applicableFloor(r.size, r.category === 'LOCKER', levers) - 1e-9,
  );
  if (belowFloor.length > 0) {
    blockers.push({
      code: 'BELOW_FLOOR',
      message: 'Stocked size breaches the applicable rack PSF floor.',
      reason:
        'The higher of the overall floor and the category floor applies before rounding; a rate below it (only possible via override) must be fixed before Set Active.',
      sizes: belowFloor.map((r) => r.size),
    });
  } else if (stockedRows.length > 0) {
    pass('FLOORS_HOLD');
  }

  // Warnings (D12): reason is mandatory; none of these blocks Set Active —
  // an authorised approver accepts them with a note (B3 enforces the note).
  for (let i = 1; i < stockedRows.length; i += 1) {
    const prev = stockedRows[i - 1];
    const cur = stockedRows[i];
    if (toCents(cur.rackMonthly) < toCents(prev.rackMonthly)) {
      warnings.push({
        code: 'NON_MONOTONIC_TOTALS',
        message: `Larger unit total falls below a smaller unit (${prev.size} sq ft S$${prev.rackMonthly} > ${cur.size} sq ft S$${cur.rackMonthly}).`,
        reason:
          'Total rent should not fall as size grows; the larger size looks cheaper overall and needs commercial sign-off.',
        sizes: [prev.size, cur.size],
      });
      break;
    }
  }

  const hasPct = promotions.some(
    (p) => p.kind === 'PERCENTAGE' && Object.values(p.discountsBySize ?? {}).some((d) => d > 0),
  );
  const hasFree = stockedRows.some((r) => r.freeMonths > 0);
  if (hasPct && hasFree) {
    warnings.push({
      code: 'STACKED_PROMOS',
      message: 'Percentage discount and free months are stacked in this preview.',
      reason: 'Stacking compounds the customer saving; confirm the combined cash-equivalent discount is intended.',
    });
  }

  if (summary.gapVsTarget != null && summary.gapVsTarget < 0) {
    warnings.push({
      code: 'BELOW_TARGET',
      message: `Weighted Effective PSF is below the Financial Model target (gap ${summary.gapVsTarget}).`,
      reason:
        'The target comparison uses recurring Effective PSF, never Blended PSF; pricing below target needs commercial sign-off regardless of the size of the gap.',
    });
  }

  for (const p of promotions) {
    if (p.status !== 'ACTIVE') {
      warnings.push({
        code: 'DRAFT_PROMO_PREVIEW',
        message: `Plan ${p.planId} v${p.planVersion} is ${p.status}, preview-only.`,
        reason: 'Selecting a non-active plan never activates it; the preview is indicative until the plan itself is Active.',
      });
    }
  }

  if (sizesAboveRange.length > 0) {
    warnings.push({
      code: 'SIZE_ABOVE_RANGE',
      message: `Stocked sizes above the 150 sq ft commercial window: ${sizesAboveRange.join(', ')}.`,
      reason:
        'Sizes above 150 use the XL category and floor and extend the schedule; confirm the facility really stocks them.',
      sizes: [...sizesAboveRange],
    });
  }

  if (targetPsf == null) {
    warnings.push({
      code: 'TARGET_UNAVAILABLE',
      message: 'No Financial Model target is linked for this facility.',
      reason: 'Variance cannot be computed without the CURRENT-model recurring Effective PSF target; target comparisons show as unavailable; nothing is blocked.',
    });
  }

  if (warnings.length === 0 && targetPsf != null) pass('NO_WARNINGS');

  return { blockers, warnings, passed };
}

// ---------------------------------------------------------------------------
// required-base solver (§15.18 — deterministic guidance only)
// ---------------------------------------------------------------------------

export interface SolverInput {
  levers: StrategyLevers;
  inventory: StockedSizeInput[];
  promotions: PromotionPreviewInput[];
  durationMonths: DurationMonths;
  targetPsf: number;
}

export interface SolverResult {
  suggestedStartingRate: number;
  achievedWeightedEffectivePsf: number;
  gapVsTarget: number;
  iterations: number;
  reachable: boolean;
  note: string;
}

const SOLVER_CAP_CENTS = 100_000_000; // S$1,000,000 anchor — absurd by construction

function weightedEffFor(input: SolverInput, anchorCents: number): number {
  const preview = previewFacility({
    levers: { ...input.levers, startingRate: anchorCents / 100 },
    inventory: input.inventory,
    promotions: input.promotions,
    selectedDurationMonths: input.durationMonths,
    targetPsf: input.targetPsf,
  });
  return preview.summary.weightedEffectivePsf;
}

/**
 * Lowest whole-cent anchor whose weighted recurring Effective PSF reaches
 * the target. Integer-cent bisection: exact and deterministic (no float
 * convergence edge). Monotonicity holds because every stage — raw curve,
 * floors, attribute adjustments, min-monthly, rounding, discount — is
 * non-decreasing in the anchor.
 */
export function solveRequiredBaseRate(input: SolverInput): SolverResult {
  if (!(input.targetPsf > 0)) {
    throw new Error('solveRequiredBaseRate: targetPsf must be greater than zero.');
  }
  if (input.inventory.length === 0) {
    throw new Error('solveRequiredBaseRate: inventory must not be empty.');
  }
  let lo = 1;
  let hi = Math.max(100, Math.ceil(input.targetPsf * input.levers.referenceSize * 100));
  let guard = 0;
  while (weightedEffFor(input, hi) < input.targetPsf) {
    hi *= 2;
    guard += 1;
    if (hi > SOLVER_CAP_CENTS || guard > 60) {
      return {
        suggestedStartingRate: hi / 100,
        achievedWeightedEffectivePsf: weightedEffFor(input, hi),
        gapVsTarget: round4(weightedEffFor(input, hi) - input.targetPsf),
        iterations: guard,
        reachable: false,
        note: 'Target not reached within the solver cap; floors or discounts dominate — review levers.',
      };
    }
  }
  let iterations = 0;
  while (lo < hi) {
    iterations += 1;
    const mid = Math.floor((lo + hi) / 2);
    if (weightedEffFor(input, mid) >= input.targetPsf) hi = mid;
    else lo = mid + 1;
  }
  const achieved = weightedEffFor(input, lo);
  return {
    suggestedStartingRate: lo / 100,
    achievedWeightedEffectivePsf: achieved,
    gapVsTarget: round4(achieved - input.targetPsf),
    iterations,
    reachable: true,
    note: 'Guidance only — changing the anchor never alters the model or strategy until the draft is saved.',
  };
}

// ---------------------------------------------------------------------------
// batch eligibility (R17 — engine-observable part; B3 enforces + writes)
// ---------------------------------------------------------------------------

/** Vacant = AVAILABLE only. Everything else is excluded from batch writes. */
export function isBatchEligibleUnit(status: string): boolean {
  return status === 'AVAILABLE';
}

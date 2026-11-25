// Master Rate Strategy pure-engine tests (Track B, B1).
//
// Covers handoff §21 rate cases 1–18 plus the §15.16 / §15.17 worked
// examples. EVERY expected value below is a HAND-DERIVED constant — the
// derivation is shown in comments; nothing is copied from the v55 prototype
// (per R14 the prototype's hard-coded inventories, promotions, S$5.64 target
// and browser refs must never be ported).
//
// Conventions: schedule inputs are pre-rounded whole sq ft (B3 derives
// sizePoint via Math.round(unit.sqft) per R15). Money is asserted exact to
// the cent; PSF to 4dp exact except where IEEE754 representation of a
// repeating decimal forces toBeCloseTo (noted inline).
//
// Engine defaults used throughout (§15.8): reference 10 sq ft @ S$90,
// smooth strength 0.20, step every 5 / S$0.20, floor S$4.20, min S$45,
// locker −25%, ground +10%, restricted −10%, facility 0%, round S$1,
// category floors LOCKER 7.00 / XS 7.00 / S 6.50 / M 5.80 / L 5.00 / XL 4.20.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEVERS,
  DEFAULT_DURATION_MIX,
  DEFAULT_DURATION_MIX_SOURCE,
  applyAttributeAdjustments,
  applyPromotions,
  baseMonthlyCents,
  buildAttributeExamples,
  categoryForSize,
  combineDiscounts,
  finalizeRackCents,
  generatedRackCents,
  isBatchEligibleUnit,
  isGroundFloorLevel,
  portfolioFromDurationSummaries,
  previewFacility,
  rackCentsForUnit,
  solveRequiredBaseRate,
  validateDurationMix,
  type DurationMix,
  type FacilitySummary,
  type PreviewRequest,
  type StrategyLevers,
} from '../../src/core/pricing/rateStrategy';

function baseLevers(over: Partial<StrategyLevers> = {}): StrategyLevers {
  return {
    referenceSize: 10,
    startingRate: 90,
    method: 'SMOOTH',
    curveStrength: 0.2,
    stepEvery: 5,
    stepPsf: 0.2,
    psfFloor: 4.2,
    minMonthly: 45,
    lockerAdj: -0.25,
    groundFloorAdj: 0.1,
    restrictedAdj: -0.1,
    facilityAdj: 0,
    rounding: 1,
    categoryFloors: { LOCKER: 7.0, XS: 7.0, S: 6.5, M: 5.8, L: 5.0, XL: 4.2 },
    sizeOverrides: [],
    ...over,
  };
}

function stockedRow(req: PreviewRequest, size: number) {
  const row = previewFacility(req).rows.find((r) => r.size === size);
  if (!row || !row.stocked) throw new Error(`size ${size} not stocked`);
  return row;
}

describe('rate-strategy engine defaults (§15.8)', () => {
  it('DEFAULT_LEVERS matches the handoff workbench defaults', () => {
    expect(DEFAULT_LEVERS.referenceSize).toBe(10);
    expect(DEFAULT_LEVERS.startingRate).toBe(90);
    expect(DEFAULT_LEVERS.method).toBe('SMOOTH');
    expect(DEFAULT_LEVERS.curveStrength).toBe(0.2);
    expect(DEFAULT_LEVERS.stepEvery).toBe(5);
    expect(DEFAULT_LEVERS.stepPsf).toBe(0.2);
    expect(DEFAULT_LEVERS.psfFloor).toBe(4.2);
    expect(DEFAULT_LEVERS.minMonthly).toBe(45);
    expect(DEFAULT_LEVERS.lockerAdj).toBe(-0.25);
    expect(DEFAULT_LEVERS.groundFloorAdj).toBe(0.1);
    expect(DEFAULT_LEVERS.restrictedAdj).toBe(-0.1);
    expect(DEFAULT_LEVERS.facilityAdj).toBe(0);
    expect(DEFAULT_LEVERS.rounding).toBe(1);
    expect(DEFAULT_LEVERS.categoryFloors).toEqual({
      LOCKER: 7.0,
      XS: 7.0,
      S: 6.5,
      M: 5.8,
      L: 5.0,
      XL: 4.2,
    });
  });
});

describe('§21 rate cases', () => {
  it('1. every whole sq ft receives a rate; totals use stocked sizes only', () => {
    // Schedule 8..150 inclusive = 143 rows; only the 2 stocked points count.
    const p = previewFacility({
      levers: baseLevers(),
      inventory: [
        { sizePoint: 10, unitCount: 2 },
        { sizePoint: 40, unitCount: 1 },
      ],
      promotions: [],
      selectedDurationMonths: 12,
      targetPsf: null,
    });
    expect(p.scheduleMax).toBe(150);
    expect(p.rows.length).toBe(143); // 150 − 8 + 1
    expect(p.rows.filter((r) => r.stocked).map((r) => r.size)).toEqual([10, 40]);
    // NLA = 10×2 + 40×1 = 60; units = 3 — unstocked rows contribute nothing.
    expect(p.summary.totalNla).toBe(60);
    expect(p.summary.totalUnits).toBe(3);
    expect(p.summary.stockedSizeCount).toBe(2);
  });

  it('2. facility inventory reconciles to Units NLA and unit count', () => {
    // NLA = 12×3 + 25×2 = 36 + 50 = 86; units = 5.
    const p = previewFacility({
      levers: baseLevers(),
      inventory: [
        { sizePoint: 12, unitCount: 3 },
        { sizePoint: 25, unitCount: 2 },
      ],
      promotions: [],
      selectedDurationMonths: 1,
      targetPsf: null,
    });
    expect(p.summary.totalNla).toBe(86);
    expect(p.summary.totalUnits).toBe(5);
  });

  it('3. category boundaries and locker overlap', () => {
    // Handoff §15.10: Locker 8–15 (locker flag wins), XS 10–19, S 20–39,
    // M 40–69, L 70–99, XL 100–150; >150 → XL (R15); 8–9 non-locker → XS.
    const cases: Array<[number, boolean, string]> = [
      [8, true, 'LOCKER'],
      [10, true, 'LOCKER'],
      [15, true, 'LOCKER'],
      [8, false, 'XS'],
      [10, false, 'XS'],
      [15, false, 'XS'],
      [19, false, 'XS'],
      [20, false, 'S'],
      [39, false, 'S'],
      [40, false, 'M'],
      [69, false, 'M'],
      [70, false, 'L'],
      [99, false, 'L'],
      [100, false, 'XL'],
      [150, false, 'XL'],
      [151, false, 'XL'],
      [200, false, 'XL'],
      [200, true, 'LOCKER'],
    ];
    for (const [size, locker, want] of cases) {
      expect(categoryForSize(size, locker)).toBe(want);
    }
  });

  it('4. percentage discount changes Effective rent/PSF consistently', () => {
    // 10 sq ft rack S$90; 45% → eff 90×0.55 = 49.50; PSF 49.50/10 = 4.95.
    const row = stockedRow(
      {
        levers: baseLevers(),
        inventory: [{ sizePoint: 10, unitCount: 1 }],
        promotions: [
          { planId: 'p1', planVersion: 1, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: 0.45 } },
        ],
        selectedDurationMonths: 12,
        targetPsf: null,
      },
      10,
    );
    expect(row.rackMonthly).toBe(90);
    expect(row.rackPsf).toBe(9);
    expect(row.combinedDiscount).toBe(0.45);
    expect(row.effectiveMonthly).toBe(49.5);
    expect(row.effectivePsf).toBe(4.95);
  });

  it('5. stacked percentages compound sequentially (20% + 10% = 28%)', () => {
    // 1 − 0.80×0.90 = 0.28 (not 0.30); 90 × 0.72 = 64.80; PSF 6.48.
    expect(combineDiscounts([0.2, 0.1])).toBeCloseTo(0.28, 10);
    const row = stockedRow(
      {
        levers: baseLevers(),
        inventory: [{ sizePoint: 10, unitCount: 1 }],
        promotions: [
          { planId: 'p1', planVersion: 1, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: 0.2 } },
          { planId: 'p2', planVersion: 1, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: 0.1 } },
        ],
        selectedDurationMonths: 12,
        targetPsf: null,
      },
      10,
    );
    expect(row.combinedDiscount).toBeCloseTo(0.28, 10);
    expect(row.effectiveMonthly).toBe(64.8);
    expect(row.effectivePsf).toBe(6.48);
  });

  it('6. free months blend evenly across the commitment', () => {
    // Eff 158.34, 2 free of 12: commitment 158.34×10 = 1583.40;
    // blended 1583.40/12 = 131.95; PSF 131.95/40 = 3.29875.
    const out = applyPromotions(15834, 0, 2, 12);
    expect(out.effectiveMonthlyCents).toBe(15834);
    expect(out.blendedMonthlyCents).toBe(13195);
    expect(out.hasBlended).toBe(true);
  });

  it('7. free-month eligibility applies only to eligible categories', () => {
    const req: PreviewRequest = {
      levers: baseLevers(),
      inventory: [
        { sizePoint: 10, unitCount: 1 },
        { sizePoint: 40, unitCount: 1 },
      ],
      promotions: [
        {
          planId: 'stay-12',
          planVersion: 2,
          status: 'ACTIVE',
          kind: 'FREE_MONTHS',
          freeMonths: 2,
          eligibleCategories: ['M', 'L', 'XL'],
          commitmentMonths: 12,
        },
      ],
      selectedDurationMonths: 12,
      targetPsf: null,
    };
    const p = previewFacility(req);
    const xs = p.rows.find((r) => r.size === 10)!;
    const m = p.rows.find((r) => r.size === 40)!;
    // XS is not eligible (Stay 12, Pay 10 covers M/L/XL): no blending.
    expect(xs.freeMonths).toBe(0);
    expect(xs.hasBlended).toBe(false);
    expect(xs.blendedMonthly).toBe(xs.effectiveMonthly);
    // M is eligible: 2 free months blend.
    expect(m.freeMonths).toBe(2);
    expect(m.hasBlended).toBe(true);
  });

  it('8. percentage plus free months use one cash-equivalent formula', () => {
    // 42% then 2/12 free: cash-equiv = 1 − 0.58×(10/12) = 1 − 0.483333…;
    // blended 131.95 on rack 273 → 1 − 131.95/273 ≈ 0.516667.
    const row = stockedRow(
      {
        levers: baseLevers(),
        inventory: [{ sizePoint: 40, unitCount: 1 }],
        promotions: [
          { planId: 'p1', planVersion: 4, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 40: 0.42 } },
          { planId: 'stay-12', planVersion: 2, status: 'ACTIVE', kind: 'FREE_MONTHS', freeMonths: 2, eligibleCategories: ['M', 'L', 'XL'], commitmentMonths: 12 },
        ],
        selectedDurationMonths: 12,
        targetPsf: null,
      },
      40,
    );
    expect(row.effectiveMonthly).toBe(158.34);
    expect(row.blendedMonthly).toBe(131.95);
    expect(1 - row.blendedMonthly / row.rackMonthly).toBeCloseTo(0.516667, 4);
  });

  it('9. required base-rate solver reaches the model target', () => {
    // Single stocked size at the reference point: eff ≥ 9 ⟺
    // round(anchor) ≥ 90 ⟺ anchor ≥ 89.50 — lowest whole cent is 8950.
    const input = {
      levers: baseLevers(),
      inventory: [{ sizePoint: 10, unitCount: 1 }],
      promotions: [],
      durationMonths: 12 as const,
      targetPsf: 9,
    };
    const s = solveRequiredBaseRate(input);
    expect(s.reachable).toBe(true);
    expect(s.suggestedStartingRate).toBe(89.5);
    expect(s.achievedWeightedEffectivePsf).toBe(9);
    expect(s.gapVsTarget).toBe(0);
    // Feeding the suggestion back must reproduce the achievement.
    const back = previewFacility({
      levers: baseLevers({ startingRate: s.suggestedStartingRate }),
      inventory: input.inventory,
      promotions: [],
      selectedDurationMonths: 12,
      targetPsf: 9,
    });
    expect(back.summary.weightedEffectivePsf).toBe(s.achievedWeightedEffectivePsf);
    // Determinism: same input twice → identical output.
    expect(solveRequiredBaseRate(input)).toEqual(s);
  });

  it('10. warnings carry reasons and never block; blockers do', () => {
    // Clean: rack 90 eff 9.00 meets target 9.00 exactly → no warnings.
    const clean: PreviewRequest = {
      levers: baseLevers(),
      inventory: [{ sizePoint: 10, unitCount: 1 }],
      promotions: [],
      selectedDurationMonths: 12,
      targetPsf: 9,
    };
    const v0 = previewFacility(clean).validation;
    expect(v0.blockers).toEqual([]);
    expect(v0.warnings).toEqual([]);
    // B-11: passed carries human-readable labels (same role as
    // blockers/warnings message) — the UI renders message, never raw codes.
    expect(v0.passed.map((p) => p.code)).toContain('HAS_INVENTORY');
    const hasInv = v0.passed.find((p) => p.code === 'HAS_INVENTORY')!;
    expect(hasInv.message).toBe('Facility sizes are linked.');
    expect(hasInv.message).not.toBe('HAS_INVENTORY');
    for (const p of v0.passed) {
      expect(p.message.trim().length).toBeGreaterThan(0);
      expect(p.message).not.toBe(p.code);
    }

    // Draft promo → exactly one warning, with a non-empty reason (D12).
    const v1 = previewFacility({
      ...clean,
      promotions: [{ planId: 'festive', planVersion: 1, status: 'DRAFT', kind: 'PERCENTAGE', discountsBySize: { 10: 0.25 } }],
    }).validation;
    expect(v1.blockers).toEqual([]);
    expect(v1.warnings.map((w) => w.code)).toContain('DRAFT_PROMO_PREVIEW');
    for (const w of v1.warnings) expect(w.reason.trim().length).toBeGreaterThan(0);

    // Zero anchor → blocker.
    const v2 = previewFacility({ ...clean, levers: baseLevers({ startingRate: 0 }) }).validation;
    expect(v2.blockers.map((b) => b.code)).toContain('INVALID_STARTING_RATE');

    // No inventory → blocker with the §19 copy.
    const v3 = previewFacility({ ...clean, inventory: [] }).validation;
    expect(v3.blockers.map((b) => b.code)).toContain('NO_INVENTORY');
    expect(v3.blockers.find((b) => b.code === 'NO_INVENTORY')!.message).toBe(
      'No facility sizes are linked yet.',
    );
  });

  it('11. category floors and manual override validation', () => {
    // Strength 0.60: raw(69) = 9×6.9^−0.6 ≈ 2.82 < M floor 5.80 → floor
    // binds: 5.80×69 = 400.20 → S$400.00; PSF 400/69 = 5.7971.
    const row = stockedRow(
      {
        levers: baseLevers({ curveStrength: 0.6 }),
        inventory: [{ sizePoint: 69, unitCount: 1 }],
        promotions: [],
        selectedDurationMonths: 1,
        targetPsf: null,
      },
      69,
    );
    expect(row.category).toBe('M');
    expect(row.rackMonthly).toBe(400);
    expect(row.rackPsf).toBe(5.7971);

    // Override below the M floor (200/40 = 5.00 < 5.80) → blocker.
    const bad = previewFacility({
      levers: baseLevers({ sizeOverrides: [{ size: 40, monthlyRate: 200, reason: 'test' }] }),
      inventory: [{ sizePoint: 40, unitCount: 1 }],
      promotions: [],
      selectedDurationMonths: 1,
      targetPsf: null,
    }).validation;
    expect(bad.blockers.map((b) => b.code)).toContain('BELOW_FLOOR');
    expect(bad.blockers.find((b) => b.code === 'BELOW_FLOOR')!.sizes).toEqual([40]);

    // Override above the floor replaces the generated rate exactly.
    const goodRow = stockedRow(
      {
        levers: baseLevers({ sizeOverrides: [{ size: 40, monthlyRate: 250, reason: 'test' }] }),
        inventory: [{ sizePoint: 40, unitCount: 1 }],
        promotions: [],
        selectedDurationMonths: 1,
        targetPsf: null,
      },
      40,
    );
    expect(goodRow.overridden).toBe(true);
    expect(goodRow.rackMonthly).toBe(250);
    expect(goodRow.rackPsf).toBe(6.25); // 250/40

    // Override without a reason → blocker.
    const noReason = previewFacility({
      levers: baseLevers({ sizeOverrides: [{ size: 40, monthlyRate: 250, reason: '  ' }] }),
      inventory: [{ sizePoint: 40, unitCount: 1 }],
      promotions: [],
      selectedDurationMonths: 1,
      targetPsf: null,
    }).validation;
    expect(noReason.blockers.map((b) => b.code)).toContain('OVERRIDE_REASON_REQUIRED');
  });

  it('12. locker and signed attribute factors', () => {
    // Base 10000c, facility 0: locker −25% → 7500; ground +10% → 11000;
    // restricted −10% → 9000; unflagged → 10000.
    const plain = baseLevers();
    expect(applyAttributeAdjustments(10000, { isLocker: true }, plain)).toBe(7500);
    expect(applyAttributeAdjustments(10000, { isGroundFloor: true }, plain)).toBe(11000);
    expect(applyAttributeAdjustments(10000, { isRestricted: true }, plain)).toBe(9000);
    expect(applyAttributeAdjustments(10000, {}, plain)).toBe(10000);
    // Facility +5% always applies: base → 10500; combined multiplicative
    // 100×0.75×1.10×0.90×1.05 = 77.9625 → S$77.96. Per-stage cents
    // rounding: 7500 → 8250 → 7425 → 7796.25 → 7796.
    const uplifted = baseLevers({ facilityAdj: 0.05 });
    expect(applyAttributeAdjustments(10000, {}, uplifted)).toBe(10500);
    expect(
      applyAttributeAdjustments(
        10000,
        { isLocker: true, isGroundFloor: true, isRestricted: true },
        uplifted,
      ),
    ).toBe(7796);
  });

  it('13. facility weighted averages reconcile to rent potential and NLA', () => {
    // Racks: 10 sq ft → 90.00; 40 sq ft → raw 9×4^−0.2 ≈ 6.8207,
    // 6.8207×40 = 272.83 → S$273.00. Potential 90×2 + 273 = 453;
    // NLA 60 → weighted 453/60 = 7.55.
    const p = previewFacility({
      levers: baseLevers(),
      inventory: [
        { sizePoint: 10, unitCount: 2 },
        { sizePoint: 40, unitCount: 1 },
      ],
      promotions: [],
      selectedDurationMonths: 1,
      targetPsf: null,
    });
    expect(p.summary.rackPotential).toBe(453);
    expect(p.summary.netPotential).toBe(453);
    expect(p.summary.weightedRackPsf).toBe(7.55);
    expect(p.summary.weightedEffectivePsf).toBe(7.55);
  });

  it('14. target variance uses recurring Effective PSF, not Blended PSF', () => {
    // Eff: 49.50×2 + 158.34 = 257.34 → 257.34/60 = 4.289; gap 4.289−5 = −0.711.
    // Blended (with 2 free on M): (99 + 131.95)/60 = 230.95/60 = 3.8492 —
    // the gap must still read −0.711 (effective, §15.18).
    const p = previewFacility({
      levers: baseLevers(),
      inventory: [
        { sizePoint: 10, unitCount: 2 },
        { sizePoint: 40, unitCount: 1 },
      ],
      promotions: [
        { planId: 'p1', planVersion: 4, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: 0.45, 40: 0.42 } },
        { planId: 'stay-12', planVersion: 2, status: 'ACTIVE', kind: 'FREE_MONTHS', freeMonths: 2, eligibleCategories: ['M', 'L', 'XL'], commitmentMonths: 12 },
      ],
      selectedDurationMonths: 12,
      targetPsf: 5,
    });
    expect(p.summary.weightedEffectivePsf).toBe(4.289);
    expect(p.summary.weightedBlendedPsf).toBe(3.8492);
    expect(p.summary.gapVsTarget).toBe(-0.711);
    expect(p.summary.gapVsTarget).toBe(
      Math.round((p.summary.weightedEffectivePsf - 5) * 10000) / 10000,
    );
  });

  it('15. Excel-style step-down respects interval and floor', () => {
    // Base 9.00. Steps = floor(max(0, size−10)/5): 8→0, 10→0, 14→0,
    // 15→1 (8.80), 20→2 (8.60), 40→6 (9−1.20 = 7.80).
    const req = (stepPsf: number): PreviewRequest => ({
      levers: baseLevers({ method: 'STEP', stepPsf }),
      inventory: [
        { sizePoint: 8, unitCount: 1 },
        { sizePoint: 14, unitCount: 1 },
        { sizePoint: 15, unitCount: 1 },
        { sizePoint: 20, unitCount: 1 },
        { sizePoint: 40, unitCount: 1 },
      ],
      promotions: [],
      selectedDurationMonths: 1,
      targetPsf: null,
    });
    const rows = previewFacility(req(0.2)).rows;
    const at = (s: number) => rows.find((r) => r.size === s)!;
    expect(at(8).rackMonthly).toBe(72); // 9×8
    expect(at(14).rackMonthly).toBe(126); // 9×14
    expect(at(15).rackMonthly).toBe(132); // 8.80×15
    expect(at(15).rackPsf).toBe(8.8);
    expect(at(20).rackMonthly).toBe(172); // 8.60×20
    expect(at(20).rackPsf).toBe(8.6);
    expect(at(40).rackMonthly).toBe(312); // 7.80×40
    expect(at(40).rackPsf).toBe(7.8);
    // Floor binds: step S$2 → 9−12 < 0 → M floor 5.80: 5.80×40 = 232.00.
    expect(stockedRow(req(2.0), 40).rackMonthly).toBe(232);
  });

  it('16. 1/3/6/12-month filters update all linked views consistently', () => {
    // Same inventory, duration-resolved discounts: 0 / 10% / 20% / 42%.
    // 10 sq ft rack 90 → eff 90 / 81 / 72 / 52.20; PSF /10.
    const discounts = { 1: 0, 3: 0.1, 6: 0.2, 12: 0.42 } as const;
    const expected = { 1: [90, 9], 3: [81, 8.1], 6: [72, 7.2], 12: [52.2, 5.22] } as const;
    for (const d of [1, 3, 6, 12] as const) {
      const p = previewFacility({
        levers: baseLevers(),
        inventory: [{ sizePoint: 10, unitCount: 2 }],
        promotions: [
          { planId: 'p1', planVersion: 4, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: discounts[d] } },
        ],
        selectedDurationMonths: d,
        targetPsf: null,
      });
      const [rent, psf] = expected[d];
      const stocked = p.rows.filter((r) => r.stocked);
      expect(stocked.length).toBe(1);
      expect(stocked[0].effectiveMonthly).toBe(rent);
      expect(stocked[0].effectivePsf).toBe(psf);
      // Summary reconciles to the rows: potential = rent×count, NLA = 20.
      expect(p.summary.netPotential).toBe(rent * 2);
      expect(p.summary.weightedEffectivePsf).toBe(Math.round(((rent * 2) / 20) * 10000) / 10000);
      expect(p.summary.totalNla).toBe(20);
    }
  });

  it('17. no Blended series/columns when free months do not apply', () => {
    const p = previewFacility({
      levers: baseLevers(),
      inventory: [
        { sizePoint: 10, unitCount: 1 },
        { sizePoint: 40, unitCount: 1 },
      ],
      promotions: [
        { planId: 'p1', planVersion: 4, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: 0.45, 40: 0.42 } },
      ],
      selectedDurationMonths: 12,
      targetPsf: null,
    });
    expect(p.summary.hasBlended).toBe(false);
    expect(p.summary.weightedBlendedPsf).toBeNull();
    for (const r of p.rows.filter((x) => x.stocked)) {
      expect(r.hasBlended).toBe(false);
      expect(r.freeMonths).toBe(0);
      // Value still present (= effective, §15.16) but flagged hidden.
      expect(r.blendedMonthly).toBe(r.effectiveMonthly);
      expect(r.blendedPsf).toBe(r.effectivePsf);
    }
  });

  it('18. only AVAILABLE units are batch-eligible (R17)', () => {
    expect(isBatchEligibleUnit('AVAILABLE')).toBe(true);
    for (const s of ['OCCUPIED', 'OVERDUE', 'RESERVED', 'DRAFT', 'BLOCKED', 'MAINTENANCE', 'INACTIVE']) {
      expect(isBatchEligibleUnit(s)).toBe(false);
    }
  });
});

describe('§15.16 worked rate example — 10 sq ft XS', () => {
  it('matches the handoff hand-computed values', () => {
    // Reference 10 @ S$90, smooth 0.20; 12-mo standard 45% for 10 sq ft;
    // XS not eligible for Stay 12, Pay 10 free months.
    // Rack 90.00; PSF 90/10 = 9.00; eff 90×0.55 = 49.50; PSF 4.95;
    // blended = 4.95 (no free months); gap 4.95 − 5.6384 = −0.6884.
    const p = previewFacility({
      levers: baseLevers(),
      inventory: [{ sizePoint: 10, unitCount: 1 }],
      promotions: [
        { planId: 'longer-stay', planVersion: 4, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: 0.45 } },
        { planId: 'stay-12', planVersion: 2, status: 'ACTIVE', kind: 'FREE_MONTHS', freeMonths: 2, eligibleCategories: ['M', 'L', 'XL'], commitmentMonths: 12 },
      ],
      selectedDurationMonths: 12,
      targetPsf: 5.6384,
    });
    const row = p.rows.find((r) => r.size === 10)!;
    expect(row.category).toBe('XS');
    expect(row.rackMonthly).toBe(90);
    expect(row.rackPsf).toBe(9);
    expect(row.effectiveMonthly).toBe(49.5);
    expect(row.effectivePsf).toBe(4.95);
    expect(row.freeMonths).toBe(0);
    expect(row.blendedMonthly).toBe(49.5);
    expect(row.blendedPsf).toBe(4.95);
    expect(row.hasBlended).toBe(false);
    expect(row.gapVsTarget).toBe(-0.6884);
  });
});

describe('§15.17 worked rate example — 40 sq ft M', () => {
  it('matches the handoff hand-computed values', () => {
    // Raw = 9 × (40/10)^−0.2 = 9 × 4^−0.2 ≈ 6.8207 (handoff: ≈S$6.82).
    // Base 6.8207×40 = 272.83 → S$273.00; displayed PSF 273/40 = 6.825.
    // Eff 273×0.58 = 158.34; PSF 158.34/40 = 3.9585.
    // Commitment 158.34×10 = 1583.40; blended 1583.40/12 = 131.95;
    // blended PSF 131.95/40 = 3.29875 (IEEE754 lands the 4dp rounding at
    // 3.2987 — asserted to 3dp); gap uses 3.9585, never 3.30.
    const p = previewFacility({
      levers: baseLevers(),
      inventory: [{ sizePoint: 40, unitCount: 1 }],
      promotions: [
        { planId: 'longer-stay', planVersion: 4, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 40: 0.42 } },
        { planId: 'stay-12', planVersion: 2, status: 'ACTIVE', kind: 'FREE_MONTHS', freeMonths: 2, eligibleCategories: ['M', 'L', 'XL'], commitmentMonths: 12 },
      ],
      selectedDurationMonths: 12,
      targetPsf: 5.6384,
    });
    const row = p.rows.find((r) => r.size === 40)!;
    expect(row.category).toBe('M');
    expect(row.rackMonthly).toBe(273);
    expect(row.rackPsf).toBe(6.825);
    expect(row.effectiveMonthly).toBe(158.34);
    expect(row.effectivePsf).toBe(3.9585);
    expect(row.freeMonths).toBe(2);
    expect(row.commitmentMonths).toBe(12);
    expect(row.blendedMonthly).toBe(131.95);
    expect(row.blendedPsf).toBeCloseTo(3.29875, 3);
    expect(row.hasBlended).toBe(true);
    expect(row.gapVsTarget).toBeCloseTo(3.9585 - 5.6384, 4);
  });
});

describe('B-9 attribute/minimum/rounding order (§15.9)', () => {
  it('ground-floor uplift rounds AFTER adjusting (S$382.80 → S$383)', () => {
    // Hand constant base S$348.00 × (1 + 0.10) = S$382.80 (38280c); the S$1
    // increment applies to the ADJUSTED rent: round(382.80) = S$383.00.
    // The old order rounded first (S$348) then uplifted, publishing S$382.80.
    expect(finalizeRackCents(34800, { isGroundFloor: true }, baseLevers())).toBe(38300);
    // Per-unit end to end: 10 sq ft schedule S$90.00 × 1.10 = S$99.00.
    expect(rackCentsForUnit(10, { isGroundFloor: true }, baseLevers())).toBe(9900);
  });

  it('locker discount floors at the minimum monthly rent', () => {
    // S$45.00 × (1 − 0.25) = S$33.75 < S$45.00 minimum → S$45.00.
    expect(finalizeRackCents(4500, { isLocker: true }, baseLevers())).toBe(4500);
    // S$60.00 × 0.75 = S$45.00 → exactly the minimum.
    expect(finalizeRackCents(6000, { isLocker: true }, baseLevers())).toBe(4500);
    // Engine level with default levers at a low anchor: basePsf = 10/10 =
    // S$1.00; raw(8) = 1.00 × (8/10)^−0.2 ≈ S$1.0456; floors bind at XS
    // S$7.00 → base 7.00 × 8 = S$56.00 (5600c); × 0.75 = 4200 < 4500 → S$45.
    expect(rackCentsForUnit(8, { isLocker: true }, baseLevers({ startingRate: 10 }))).toBe(4500);
  });

  it('each rounding increment applies to the adjusted rent', () => {
    // S$348.00 ground-floor adjusted = S$382.80 (38280c, hand constant above).
    expect(finalizeRackCents(34800, { isGroundFloor: true }, baseLevers({ rounding: 1 }))).toBe(38300);
    // round(38280/500) = round(76.56) = 77 → S$385.00.
    expect(finalizeRackCents(34800, { isGroundFloor: true }, baseLevers({ rounding: 5 }))).toBe(38500);
    // round(38280/1000) = round(38.28) = 38 → S$380.00.
    expect(finalizeRackCents(34800, { isGroundFloor: true }, baseLevers({ rounding: 10 }))).toBe(38000);
  });

  it('ground floor is building Level 1 only — a single-floor branch on Level 6 gets no uplift', () => {
    expect(isGroundFloorLevel(1)).toBe(true);
    expect(isGroundFloorLevel(2)).toBe(false);
    expect(isGroundFloorLevel(6)).toBe(false);
  });

  it('12 sq ft locker on the ground floor finalizes to S$86 (batch regression)', () => {
    // Schedule (unattributed): raw = 9.00 × (12/10)^−0.2 ≈ S$8.6777; LOCKER
    // floor S$7.00 does not bind; base 8.6777 × 12 = S$104.13 (10413c) →
    // S$1 schedule S$104.00 — the locker factor is NOT in the schedule.
    expect(baseMonthlyCents(12, true, baseLevers())).toBe(10413);
    expect(generatedRackCents(12, true, baseLevers())).toBe(10400);
    // Per-unit final: 10413 × 0.75 = 7809.75 → 7810; × 1.10 = 8591.00 →
    // max(45, 85.91) → S$1 → S$86.00. The old order published S$85.80
    // (rounded 10400 × 0.75 × 1.10 with no post-adjustment rounding).
    expect(rackCentsForUnit(12, { isLocker: true, isGroundFloor: true }, baseLevers())).toBe(8600);
  });

  it('unattributed schedule values are unchanged (§15.16/§15.17 pins hold)', () => {
    // No attributes → adjustment is identity, so minimum + rounding match the
    // old schedule exactly: 10 → S$90.00, 40 → S$273.00 (27283c → S$1).
    expect(rackCentsForUnit(10, {}, baseLevers())).toBe(9000);
    expect(rackCentsForUnit(40, {}, baseLevers())).toBe(27300);
    expect(rackCentsForUnit(10, {}, baseLevers())).toBe(generatedRackCents(10, false, baseLevers()));
  });

  it('attribute example cards are finalized rates (min + rounding included)', () => {
    // Base S$348.00 hand constant under the default S$1 increment: locker
    // 348 × 0.75 = S$261.00; ground 348 × 1.10 = S$382.80 → S$383.00;
    // restricted 348 × 0.90 = S$313.20 → S$313.00; combined
    // 348 × 0.75 × 1.10 × 0.90 = S$258.39 → S$258.00.
    expect(buildAttributeExamples(34800, baseLevers())).toEqual({
      base: 348,
      locker: 261,
      groundFloor: 383,
      restricted: 313,
      combined: 258,
    });
    // Locker at the minimum: S$45.00 × 0.75 = S$33.75 → floored to S$45.00.
    expect(buildAttributeExamples(4500, baseLevers()).locker).toBe(45);
  });
});

describe('D11 / D12 / D13 engine observables', () => {
  it('D11: previewSelection carries referenced plan ids + versions', () => {
    const p = previewFacility({
      levers: baseLevers(),
      inventory: [{ sizePoint: 10, unitCount: 1 }],
      promotions: [
        { planId: 'longer-stay', planVersion: 4, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: 0.45 }, matrix: 'Standard' },
        { planId: 'stay-12', planVersion: 2, status: 'ACTIVE', kind: 'FREE_MONTHS', freeMonths: 2, eligibleCategories: ['M', 'L', 'XL'], commitmentMonths: 12 },
      ],
      selectedDurationMonths: 12,
      targetPsf: null,
      matrix: 'Standard',
    });
    expect(p.previewSelection).toEqual({
      durationMonths: 12,
      matrix: 'Standard',
      planRefs: [
        { planId: 'longer-stay', planVersion: 4, status: 'ACTIVE', kind: 'PERCENTAGE' },
        { planId: 'stay-12', planVersion: 2, status: 'ACTIVE', kind: 'FREE_MONTHS' },
      ],
      durationMix: { 1: 25, 3: 25, 6: 25, 12: 25 },
      durationMixSource: 'Equal planning assumption',
    });
  });

  it('D12: every warning carries a reason; no magnitude ever blocks', () => {
    // Deep below target (gap −4+) is still a warning, never a blocker.
    const p = previewFacility({
      levers: baseLevers(),
      inventory: [{ sizePoint: 10, unitCount: 1 }],
      promotions: [],
      selectedDurationMonths: 1,
      targetPsf: 50,
    });
    expect(p.summary.gapVsTarget).toBeLessThan(-4);
    expect(p.validation.blockers).toEqual([]);
    const below = p.validation.warnings.find((w) => w.code === 'BELOW_TARGET')!;
    expect(below.reason.trim().length).toBeGreaterThan(0);
    for (const w of p.validation.warnings) {
      expect(typeof w.reason).toBe('string');
      expect(w.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('D13: schedule extends past 150 for stocked sizes; >150 flagged', () => {
    // R15: sizes above 150 use the XL category and floor.
    const p = previewFacility({
      levers: baseLevers(),
      inventory: [
        { sizePoint: 10, unitCount: 1 },
        { sizePoint: 160, unitCount: 2 },
      ],
      promotions: [],
      selectedDurationMonths: 1,
      targetPsf: null,
    });
    expect(p.scheduleMax).toBe(160);
    expect(p.rows.length).toBe(153); // 160 − 8 + 1
    const big = p.rows.find((r) => r.size === 160)!;
    expect(big.stocked).toBe(true);
    expect(big.category).toBe('XL');
    expect(p.sizesAboveRange).toEqual([160]);
    const flag = p.validation.warnings.find((w) => w.code === 'SIZE_ABOVE_RANGE')!;
    expect(flag.sizes).toEqual([160]);
    expect(flag.reason.trim().length).toBeGreaterThan(0);
  });
});

describe('Handoff v2 — Master Rate Strategy Release 57', () => {
  it('validates duration mix weights (default 25%, 0..100%, 100% total)', () => {
    // Default
    const def = validateDurationMix();
    expect(def.valid).toBe(true);
    expect(def.total).toBe(100);
    expect(def.normalized).toEqual({ 1: 25, 3: 25, 6: 25, 12: 25 });

    // Valid custom mix
    const custom = validateDurationMix({ 1: 10, 3: 20, 6: 30, 12: 40 });
    expect(custom.valid).toBe(true);
    expect(custom.total).toBe(100);
    expect(custom.normalized).toEqual({ 1: 10, 3: 20, 6: 30, 12: 40 });

    // Invalid total > 100%
    const over = validateDurationMix({ 1: 25, 3: 25, 6: 25, 12: 30 });
    expect(over.valid).toBe(false);
    expect(over.total).toBe(105);
    expect(over.issues.length).toBeGreaterThan(0);
    // Normalization still allows temporary preview
    expect(over.normalized[1]).toBeCloseTo((25 / 105) * 100, 2);

    // Negative weight invalid
    const neg = validateDurationMix({ 1: -5, 3: 25, 6: 25, 12: 55 });
    expect(neg.valid).toBe(false);
    expect(neg.issues).toContain('Duration 1 month mix must be zero or more.');

    // Exceeding 100% invalid
    const excessive = validateDurationMix({ 1: 110, 3: 0, 6: 0, 12: 0 });
    expect(excessive.valid).toBe(false);
    expect(excessive.issues).toContain('Duration 1 month mix cannot exceed 100%.');
  });

  it('pins the §14 worked example: S$5.17 portfolio Effective PSF, -S$0.18 variance vs S$5.35 target, S$4.99 Blended PSF', () => {
    // Mock duration-level summaries matching §14:
    // 1 mo: 6.20, 3 mo: 5.51, 6 mo: 4.82, 12 mo: 4.13 (blended 3.44)
    const mockSummary = (eff: number, blend: number | null = null): FacilitySummary => ({
      stockedSizeCount: 5,
      totalUnits: 50,
      totalNla: 1000,
      rackPotential: 6500,
      netPotential: eff * 1000,
      blendedPotential: (blend ?? eff) * 1000,
      weightedRackPsf: 6.5,
      weightedEffectivePsf: eff,
      weightedBlendedPsf: blend,
      hasBlended: blend != null && blend !== eff,
      targetPsf: 5.35,
      gapVsTarget: eff - 5.35,
    });

    const summaries = {
      1: mockSummary(6.20),
      3: mockSummary(5.51),
      6: mockSummary(4.82),
      12: mockSummary(4.13, 3.44),
    };

    const portfolio = portfolioFromDurationSummaries(
      summaries,
      { 1: 25, 3: 25, 6: 25, 12: 25 },
      'Equal planning assumption',
      5.35,
    );

    // §14: Portfolio-weighted Effective PSF = 5.165 -> S$5.17
    expect(portfolio.portfolioEffectivePsf).toBe(5.165);
    expect(Number(portfolio.portfolioEffectivePsf.toFixed(2))).toBe(5.17);

    // Variance vs S$5.35 target = 5.165 - 5.35 = -0.185 -> display -S$0.18 (or -S$0.19 at 4dp)
    expect(portfolio.gapVsTarget).toBe(-0.185);
    expect(Number(portfolio.portfolioEffectivePsf.toFixed(2)) - 5.35).toBeCloseTo(-0.18, 2);
    expect(portfolio.meetsTarget).toBe(false);
    expect(portfolio.status).toBe('BELOW_TARGET');

    // Portfolio-weighted Blended PSF = 4.9925 -> S$4.99
    expect(portfolio.hasBlended).toBe(true);
    expect(portfolio.portfolioBlendedPsf).toBe(4.9925);
    expect(Number(portfolio.portfolioBlendedPsf!.toFixed(2))).toBe(4.99);

    // Breakdown rows
    expect(portfolio.breakdown.length).toBe(4);
    const b12 = portfolio.breakdown.find((b) => b.durationMonths === 12)!;
    expect(b12.effectivePsf).toBe(4.13);
    expect(b12.blendedPsf).toBe(3.44);
    expect(b12.enteredWeight).toBe(25);
    expect(b12.normalizedWeight).toBe(25);
    expect(b12.effectiveContribution).toBe(1.0325); // 4.13 * 0.25
    expect(b12.blendedContribution).toBe(0.86); // 3.44 * 0.25
  });

  it('previewFacility integrates portfolio metrics and reports red blocker on invalid mix total', () => {
    // Valid 100% mix
    const validPreview = previewFacility({
      levers: baseLevers(),
      inventory: [{ sizePoint: 10, unitCount: 1 }],
      promotions: [],
      selectedDurationMonths: 12,
      targetPsf: 5.35,
      durationMix: { 1: 25, 3: 25, 6: 25, 12: 25 },
      durationMixSource: 'Equal planning assumption',
    });
    expect(validPreview.portfolio).toBeDefined();
    expect(validPreview.portfolio?.durationMixValid).toBe(true);
    expect(validPreview.validation.blockers.some((b) => b.code === 'DURATION_MIX_INVALID_TOTAL')).toBe(false);
    expect(validPreview.validation.passed.some((p) => p.code === 'DURATION_MIX_VALID')).toBe(true);

    // Invalid 105% mix blocks Set Active / approval
    const invalidPreview = previewFacility({
      levers: baseLevers(),
      inventory: [{ sizePoint: 10, unitCount: 1 }],
      promotions: [],
      selectedDurationMonths: 12,
      targetPsf: 5.35,
      durationMix: { 1: 25, 3: 25, 6: 25, 12: 30 },
      durationMixSource: 'Manual planning assumption',
    });
    expect(invalidPreview.portfolio).toBeDefined();
    expect(invalidPreview.portfolio?.durationMixValid).toBe(false);
    const blocker = invalidPreview.validation.blockers.find((b) => b.code === 'DURATION_MIX_INVALID_TOTAL')!;
    expect(blocker).toBeDefined();
    expect(blocker.message).toBe('Duration mix does not total 100%.');
    expect(blocker.reason).toContain('105.00%');
  });

  it('previewFacility uses per-duration promotionsByDuration when aggregating portfolio PSF across 1/3/6/12 mo', () => {
    const p = previewFacility({
      levers: baseLevers(),
      inventory: [{ sizePoint: 10, unitCount: 1 }], // rack = S$90, rackPsf = S$9.00
      promotions: [{ planId: 'p1', planVersion: 1, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: 0.4 } }],
      promotionsByDuration: {
        1: [{ planId: 'p1', planVersion: 1, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: 0.1 } }],
        3: [{ planId: 'p1', planVersion: 1, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: 0.2 } }],
        6: [{ planId: 'p1', planVersion: 1, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: 0.3 } }],
        12: [{ planId: 'p1', planVersion: 1, status: 'ACTIVE', kind: 'PERCENTAGE', discountsBySize: { 10: 0.4 } }],
      },
      selectedDurationMonths: 12,
      targetPsf: 6.5,
      durationMix: { 1: 25, 3: 25, 6: 25, 12: 25 },
      durationMixSource: 'Equal planning assumption',
    });
    // 1m: 9.00*0.9=8.10, 3m: 9.00*0.8=7.20, 6m: 9.00*0.7=6.30, 12m: 9.00*0.6=5.40
    // Equal 25% portfolio weighted average = (8.10 + 7.20 + 6.30 + 5.40) / 4 = 6.75
    expect(p.portfolio?.breakdown.map((b) => b.effectivePsf)).toEqual([8.1, 7.2, 6.3, 5.4]);
    expect(p.portfolio?.portfolioEffectivePsf).toBe(6.75);
    expect(p.portfolio?.gapVsTarget).toBe(0.25);
    expect(p.portfolio?.meetsTarget).toBe(true);
  });
});

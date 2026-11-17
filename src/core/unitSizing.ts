import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { AREA_TOLERANCE, formatFt, outlineArea, rectAreaSqft } from './planGeometry';
import { MARKET_PSF } from './market';

// Floor-plan ⇄ unit size sync (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md).
//
// The floor plan owns a PLACED unit's size: Unit.sqft = round(width × height).
// A resize no longer has to stay within AREA_TOLERANCE of the stored sqft —
// it flags the placement `areaDirty` and the next publish syncs the Unit row
// (Phase 2). Two exceptions keep the legacy ±AREA_TOLERANCE rule:
//   - CONTRACTED units (rented, reserved or mid-checkout): the customer agreed
//     a size and a price, so the drawn area may only be reshaped within
//     tolerance and never becomes dirty (D6);
//   - stacked LOCKER pairs must stay inside the LOCKER size band (D4).

/** Statuses whose size is contractually fixed (D6). */
export const CONTRACTED_STATUSES = ['OCCUPIED', 'OVERDUE', 'RESERVED'] as const;

/** Sanity band for a unit's synced sqft (D3). */
export const MIN_UNIT_SQFT = 1;
export const MAX_UNIT_SQFT = 2000;

/**
 * Unit.sqft precision: whole sqft since 2026-11-16 (see wholeSqft below —
 * supersedes the 2026-10-14 0.01-sqft decision). quantizeSqft is kept for
 * aggregate totals; legacy rows may still hold decimals until re-saved.
 */
export const SQFT_STEP = 0.01;
export function quantizeSqft(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Whole square feet (owner 2026-11-16: "round the unit size to zero decimal
 * place when creating a unit"). Every write of Unit.sqft — Add Unit form,
 * edit, CSV import, floor-plan drawn units and publish sync — stores the area
 * rounded half-up to an integer. quantizeSqft (0.01) stays for aggregates;
 * plan geometry and NLA/UFA keep their exact drawn area.
 */
export function wholeSqft(n: number): number {
  return Math.round(n);
}

/**
 * Two sizes count as the SAME when they differ by less than 0.05 sqft. The
 * drawing is stored to 0.001 ft, so a rect fitted to a catalogue size
 * (w snapped, h = sqft / w quantized) can land a few hundredths off — e.g.
 * 4.73 × 6.342 = 29.998 for a 30 sqft unit. Anything ≥ 0.05 is a real resize.
 */
export const SQFT_EPSILON = 0.05;
export function sameSqft(a: number, b: number): boolean {
  // Whole-sqft units (2026-11-16): two sizes are the same when they round to
  // the same integer, so a legacy 47.18 unit drawn at 47.18 stays unchanged
  // (it is never silently re-written to 47) and a 29.998 drawing is still 30.
  return Math.abs(a - b) < SQFT_EPSILON || wholeSqft(a) === wholeSqft(b);
}

/** Unit.sqft for a drawn rect: the drawn area rounded to whole sqft. */
export function sqftForRect(r: { width: number; height: number }): number {
  return wholeSqft(rectAreaSqft(r));
}

/**
 * Unit.sqft for a drawn placement (odd-shaped units, D3): the outline polygon
 * area when an outline is set, else the bbox w×h — rounded with wholeSqft
 * like rects. Replaces sqftForRect at placement call sites (sqftForRect stays
 * for rect-only callers).
 */
export function sqftForPlacement(p: { width: number; height: number; outline?: unknown }): number {
  return wholeSqft(placementAreaSqft(p));
}

/** Drawn area of a placement in sq ft (outline polygon area, else w×h). */
export function placementAreaSqft(p: { width: number; height: number; outline?: unknown }): number {
  const o = p.outline;
  if (Array.isArray(o) && o.length >= 3) {
    const pts = (o as unknown[]).filter(
      (v): v is [number, number] => Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number',
    );
    if (pts.length >= 3) return Math.round(outlineArea(pts) * 10000) / 10000;
  }
  return rectAreaSqft(p);
}

/** Deviation of a placement's drawn area from `sqft` (0 = exact). */
export function placementAreaDeviation(p: { width: number; height: number; outline?: unknown }, sqft: number): number {
  return Math.abs(placementAreaSqft(p) - sqft) / Math.max(1, sqft);
}

/**
 * Unit ids (of `unitIds`) whose size is contractually fixed, with the reason:
 * status in CONTRACTED_STATUSES, or a booking awaiting payment (a Stripe
 * webhook can still confirm it). One query regardless of batch size.
 *
 * A linked Tenant alone does NOT lock: Unit.status is the operational truth
 * (booking lists AVAILABLE units as rentable), and stale Tenant.unitId links
 * on AVAILABLE units exist (seed data, `db:free-units --keep-tenant-links`).
 */
export async function loadContractedUnits(
  unitIds: readonly string[],
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!unitIds.length) return out;
  const rows = await db.unit.findMany({
    where: { id: { in: [...unitIds] } },
    select: {
      id: true,
      status: true,
      bookings: { where: { status: 'PENDING_PAYMENT' }, select: { id: true }, take: 1 },
    },
  });
  for (const u of rows) {
    if ((CONTRACTED_STATUSES as readonly string[]).includes(u.status)) out.set(u.id, u.status);
    else if (u.bookings.length) out.set(u.id, 'awaiting booking payment');
  }
  return out;
}

type Rect = { width: number; height: number };

/** Any rect-or-outline footprint the area rule accepts. */
export type PlacementGeom = Rect & { outline?: unknown };

/**
 * Area rule for one placement write. Returns the placement's next `areaDirty`.
 *  - area unchanged (move / 90° rotation / door toggle / outline vertex edit
 *    that keeps the stored area): keep the stored flag;
 *  - contracted unit: legacy ±AREA_TOLERANCE vs Unit.sqft, never dirty
 *    (409 UNIT_CONTRACTED beyond it) — changing a contracted unit's SHAPE is
 *    the same as resizing it (D3);
 *  - otherwise: any area within [MIN_UNIT_SQFT, MAX_UNIT_SQFT] is accepted and
 *    dirty iff the drawn sqft differs from Unit.sqft by ≥ SQFT_EPSILON
 *    (resizing back clears it).
 * Shaped placements compare the outline polygon area (sqftForPlacement);
 * rect placements keep the exact w×h path. `existing` carries the stored
 * outline so an outline redraw with the same area is grandfathered.
 */
export function checkPlacementArea(input: {
  unit: { unitCode: string; sqft: number };
  geom: PlacementGeom;
  existing: (PlacementGeom & { areaDirty?: boolean | null }) | null | undefined;
  contractedReason: string | undefined;
}): boolean {
  const { unit, geom, existing, contractedReason } = input;
  const area = placementAreaSqft(geom);
  const existingArea = existing ? placementAreaSqft(existing) : null;
  const areaChanged = existingArea == null || existingArea !== area;
  // An outline set/cleared/redrawn that keeps the drawn area is a move-class
  // edit (label/door anchor follows the drawing) — never dirty by itself.
  if (!areaChanged) return existing?.areaDirty === true;

  if (contractedReason) {
    if (placementAreaDeviation(geom, unit.sqft) > AREA_TOLERANCE) {
      const dims = describeGeom(geom);
      throw new AppError(
        409,
        'UNIT_CONTRACTED',
        `Unit ${unit.unitCode} is ${contractedReason.toLowerCase()} — its ${unit.sqft} sqft can't change while contracted. ` +
          `${dims} (= ${Math.round(area * 100) / 100} sq ft) is more than ` +
          `${Math.round(AREA_TOLERANCE * 100)}% off; reshape within tolerance only.`,
      );
    }
    return false;
  }

  const sqft = sqftForPlacement(geom);
  if (sqft < MIN_UNIT_SQFT || sqft > MAX_UNIT_SQFT) {
    throw new AppError(
      400,
      'VALIDATION',
      `Unit ${unit.unitCode} ${describeGeom(geom)} would be ${sqft} sqft — units must be ${MIN_UNIT_SQFT}–${MAX_UNIT_SQFT} sqft`,
    );
  }
  return !sameSqft(sqft, unit.sqft);
}

/** Human-readable footprint for error messages (outline or W×H). */
function describeGeom(geom: PlacementGeom): string {
  const o = geom.outline;
  if (Array.isArray(o) && o.length >= 3) return `shaped outline (${(o as unknown[]).length} corners)`;
  return `${formatFt(geom.width)}×${formatFt(geom.height)} ft`;
}

export type SizeTierRow = { id: string; code: string; name: string; sqftFrom: number; sqftTo: number; sortOrder: number };

/**
 * Size tier for `sqft` (D4, revised in Phase 2): the tier whose sqft band is
 * NEAREST to the new area (distance 0 = inside the band); ties keep the
 * current tier, then lowest sortOrder. Bands follow booking Step 1
 * (2026-11-11: LOCKER 10–19, SMALL 20–39, MEDIUM 40–69, LARGE 70–99, XLBIZ
 * 100–150) and may overlap or leave gaps, so
 * "no band covers it" is normal and must not block — `inBand`
 * tells the review UI to flag the pick as "nearest". null only when no
 * size tiers exist at all.
 */
export function resolveSizeTier(
  sizes: readonly SizeTierRow[],
  currentSizeId: string,
  sqft: number,
): { size: SizeTierRow; inBand: boolean } | null {
  const dist = (s: SizeTierRow) => (sqft < s.sqftFrom ? s.sqftFrom - sqft : sqft > s.sqftTo ? sqft - s.sqftTo : 0);
  const ranked = [...sizes].sort(
    (a, b) => dist(a) - dist(b) || Number(b.id === currentSizeId) - Number(a.id === currentSizeId) || a.sortOrder - b.sortOrder,
  );
  return ranked.length ? { size: ranked[0], inBand: dist(ranked[0]) === 0 } : null;
}

/**
 * Default monthly rate for a unit drawn on the plan (owner decision Q3):
 * MARKET_PSF[tier] × sqft, rounded to cents. Tiers without a reference PSF
 * (e.g. XLBIZ) fall back to the lowest reference PSF (largest-unit rate).
 */
export function defaultRateFor(sizeCode: string, sqft: number): number {
  const psf = MARKET_PSF[sizeCode.toUpperCase()] ?? Math.min(...Object.values(MARKET_PSF));
  return Math.round(psf * sqft * 100) / 100;
}

/** All size tiers (for the stacked-locker tier check). */
export async function loadSizeTiers(): Promise<SizeTierRow[]> {
  return prisma.unitSize.findMany({ select: { id: true, code: true, name: true, sqftFrom: true, sqftTo: true, sortOrder: true } });
}

/**
 * D4: a stacked locker pair is lockers-only, so a resize may not move its
 * footprint into another tier (the pair would re-tier on publish). Uses the
 * same nearest-tier rule as publish (resolveSizeTier).
 */
export function assertStackedLockerTier(unitCode: string, currentSizeId: string, geom: PlacementGeom, sizes: readonly SizeTierRow[]): void {
  const sqft = sqftForPlacement(geom);
  const tier = resolveSizeTier(sizes, currentSizeId, sqft);
  const code = tier ? tier.size.code.toUpperCase() : '';
  if (tier && code !== 'LOCKER' && code !== 'XS') {
    throw new AppError(
      400,
      'VALIDATION',
      `Stacked locker ${unitCode} ${describeGeom(geom)} would be ${sqft} sqft — that sizes it as ${tier.size.name}, and stacked pairs must stay lockers. Unstack first to resize beyond the locker size.`,
    );
  }
}

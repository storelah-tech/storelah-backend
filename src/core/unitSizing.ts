import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { AREA_TOLERANCE, areaDeviation, formatFt, rectAreaSqft } from './planGeometry';
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

/** Unit.sqft for a drawn rect: whole square feet, half-up (D3 — sqft stays Int). */
export function sqftForRect(r: { width: number; height: number }): number {
  return Math.round(rectAreaSqft(r));
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

/**
 * Area rule for one placement write. Returns the placement's next `areaDirty`.
 *  - area unchanged (move / 90° rotation / door toggle): keep the stored flag;
 *  - contracted unit: legacy ±AREA_TOLERANCE vs Unit.sqft, never dirty
 *    (409 UNIT_CONTRACTED beyond it);
 *  - otherwise: any area within [MIN_UNIT_SQFT, MAX_UNIT_SQFT] is accepted and
 *    dirty iff round(area) differs from Unit.sqft (resizing back clears it).
 */
export function checkPlacementArea(input: {
  unit: { unitCode: string; sqft: number };
  geom: Rect;
  existing: (Rect & { areaDirty?: boolean | null }) | null | undefined;
  contractedReason: string | undefined;
}): boolean {
  const { unit, geom, existing, contractedReason } = input;
  const area = rectAreaSqft(geom);
  const areaChanged = !existing || rectAreaSqft(existing) !== area;
  if (!areaChanged) return existing?.areaDirty === true;

  if (contractedReason) {
    if (areaDeviation(geom, unit.sqft) > AREA_TOLERANCE) {
      throw new AppError(
        409,
        'UNIT_CONTRACTED',
        `Unit ${unit.unitCode} is ${contractedReason.toLowerCase()} — its ${unit.sqft} sqft can't change while contracted. ` +
          `${formatFt(geom.width)}×${formatFt(geom.height)} ft (= ${Math.round(area * 100) / 100} sq ft) is more than ` +
          `${Math.round(AREA_TOLERANCE * 100)}% off; reshape within tolerance only.`,
      );
    }
    return false;
  }

  const sqft = sqftForRect(geom);
  if (sqft < MIN_UNIT_SQFT || sqft > MAX_UNIT_SQFT) {
    throw new AppError(
      400,
      'VALIDATION',
      `Unit ${unit.unitCode} ${formatFt(geom.width)}×${formatFt(geom.height)} ft would be ${sqft} sqft — units must be ${MIN_UNIT_SQFT}–${MAX_UNIT_SQFT} sqft`,
    );
  }
  return sqft !== unit.sqft;
}

export type SizeTierRow = { id: string; code: string; name: string; sqftFrom: number; sqftTo: number; sortOrder: number };

/**
 * Size tier for `sqft` (D4, revised in Phase 2): the tier whose sqft band is
 * NEAREST to the new area (distance 0 = inside the band); ties keep the
 * current tier, then lowest sortOrder. Bands are often single points in
 * practice (prisma/seed.ts seeds sqftFrom = sqftTo, and no CMS screen edits
 * them), so "no band covers it" is the norm and must not block — `inBand`
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
export function assertStackedLockerTier(unitCode: string, currentSizeId: string, geom: Rect, sizes: readonly SizeTierRow[]): void {
  const sqft = sqftForRect(geom);
  const tier = resolveSizeTier(sizes, currentSizeId, sqft);
  if (tier && tier.size.code.toUpperCase() !== 'LOCKER') {
    throw new AppError(
      400,
      'VALIDATION',
      `Stacked locker ${unitCode} ${formatFt(geom.width)}×${formatFt(geom.height)} ft would be ${sqft} sqft — that sizes it as ${tier.size.name}, and stacked pairs must stay lockers. Unstack first to resize beyond the locker size.`,
    );
  }
}

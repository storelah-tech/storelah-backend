import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { AREA_TOLERANCE, areaDeviation, formatFt, rectAreaSqft } from './planGeometry';

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
export async function loadContractedUnits(unitIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!unitIds.length) return out;
  const rows = await prisma.unit.findMany({
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

/** The LOCKER size band (sqftFrom..sqftTo), or null when no LOCKER size exists. */
export async function loadLockerBand(): Promise<{ from: number; to: number } | null> {
  const s = await prisma.unitSize.findUnique({ where: { code: 'LOCKER' }, select: { sqftFrom: true, sqftTo: true } });
  return s ? { from: s.sqftFrom, to: s.sqftTo } : null;
}

/**
 * D4: a stacked locker pair is lockers-only, so a resize may not push its
 * footprint out of the LOCKER band (the pair would re-tier on publish).
 */
export function assertStackedLockerBand(unitCode: string, geom: Rect, band: { from: number; to: number } | null): void {
  if (!band) return;
  const sqft = sqftForRect(geom);
  if (sqft < band.from || sqft > band.to) {
    throw new AppError(
      400,
      'VALIDATION',
      `Stacked locker ${unitCode} ${formatFt(geom.width)}×${formatFt(geom.height)} ft would be ${sqft} sqft — stacked lockers must stay within the LOCKER band (${band.from}–${band.to} sqft). Unstack first to resize beyond it.`,
    );
  }
}

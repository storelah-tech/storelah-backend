/**
 * Opt-in footprint migration for grandfathered placements — NO re-seed, NO deletes.
 *
 * Seeded (and some early-authored) UnitPlacement rows use a uniform 2×3 rect
 * that predates blueprint-accurate footprints (1 grid unit = 1 ft, rect area ≈
 * unit sqft; see docs/FLOOR_PLAN_MODEL.md). Those rows keep READING fine, but
 * any re-save now hits the server's ±15% area-vs-sqft validation, so ops
 * should migrate them once per database.
 *
 * For every plan, this script resizes each placement whose area deviates more
 * than 15% from its unit's sqft to the true `sqftFootprint()` rect (explicit
 * UnitSize.widthFt/heightFt when present, else the documented aspect fallback
 * — same constants as src/core/floorPlans.ts), laid out at the plan's first
 * free spot scanning top-left → bottom-right. Placements already within
 * tolerance are left untouched (idempotent: re-running is a no-op). Unit rows,
 * plans, and blocks are never modified; nothing is deleted.
 *
 * Overlap policy on write is unit-vs-unit REJECT, so packing is first-fit:
 * units that cannot fit on their plan are REPORTED, not forced — enlarge the
 * canvas (or rotate: swap w/h is tried before reporting) and re-run.
 *
 * Run against the intended DB (local dev uses .env's DATABASE_URL on :5433):
 *
 *   pnpm db:backfill-footprints
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();

const SIZE_DIMS: Record<string, { w: number; h: number }> = {
  LOCKER: { w: 3, h: 4 },
  SMALL: { w: 5, h: 6 },
  MEDIUM: { w: 6, h: 10 },
  LARGE: { w: 10, h: 12 },
};
const SIZE_ASPECT: Record<string, number> = { LOCKER: 3 / 4, SMALL: 5 / 6, MEDIUM: 6 / 10, LARGE: 10 / 12 };
const DEFAULT_ASPECT = 3 / 4;
const TOLERANCE = 0.15;

function footprint(sqft: number, sizeCode: string, widthFt: number | null, heightFt: number | null) {
  if (widthFt != null && heightFt != null && widthFt > 0 && heightFt > 0) return { w: widthFt, h: heightFt };
  const known = SIZE_DIMS[sizeCode?.toUpperCase()];
  if (known) return { ...known };
  const aspect = SIZE_ASPECT[sizeCode?.toUpperCase()] || DEFAULT_ASPECT;
  const w = Math.max(1, Math.round(Math.sqrt(Math.max(1, sqft) * aspect)));
  return { w, h: Math.max(1, Math.ceil(Math.max(1, sqft) / w)) };
}

type Rect = { x: number; y: number; width: number; height: number };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function firstFreeSpot(cw: number, ch: number, w: number, h: number, taken: Rect[]): Rect | null {
  for (let y = 0; y + h <= ch; y++) {
    for (let x = 0; x + w <= cw; x++) {
      const r = { x, y, width: w, height: h };
      if (!taken.some((t) => overlaps(r, t))) return r;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const plans = await prisma.floorPlan.findMany({
    select: {
      id: true,
      width: true,
      height: true,
      floor: { select: { branch: { select: { code: true } }, level: true } },
      placements: {
        select: {
          id: true,
          x: true,
          y: true,
          width: true,
          height: true,
          unit: { select: { unitCode: true, sqft: true, size: { select: { code: true, widthFt: true, heightFt: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: [{ floor: { branch: { code: 'asc' } } }, { floor: { level: 'asc' } }],
  });

  let resized = 0;
  let skipped = 0;
  const unplaceable: string[] = [];

  for (const plan of plans) {
    const cw = Math.max(1, plan.width);
    const ch = Math.max(1, plan.height);
    const taken: Rect[] = [];
    for (const p of plan.placements) {
      const sqft = p.unit.sqft;
      const area = p.width * p.height;
      const dev = Math.abs(area - sqft) / Math.max(1, sqft);
      if (dev <= TOLERANCE) {
        taken.push({ x: p.x, y: p.y, width: p.width, height: p.height });
        skipped += 1;
        continue;
      }
      const fp = footprint(sqft, p.unit.size.code, p.unit.size.widthFt, p.unit.size.heightFt);
      // Try canonical orientation, then rotated, at the first free spot.
      const orientations = [
        { w: fp.w, h: fp.h },
        { w: fp.h, h: fp.w },
      ];
      let spot: Rect | null = null;
      for (const o of orientations) {
        if (o.w > cw || o.h > ch) continue;
        spot = firstFreeSpot(cw, ch, o.w, o.h, taken);
        if (spot) break;
      }
      if (!spot) {
        unplaceable.push(`${p.unit.unitCode} (${fp.w}×${fp.h} ft) on ${plan.floor.branch.code} L${plan.floor.level}`);
        taken.push({ x: p.x, y: p.y, width: p.width, height: p.height });
        continue;
      }
      await prisma.unitPlacement.update({ where: { id: p.id }, data: { x: spot.x, y: spot.y, width: spot.width, height: spot.height } });
      taken.push(spot);
      resized += 1;
      console.log(
        `backfill: ${p.unit.unitCode} ${p.width}×${p.height} → ${spot.width}×${spot.height} ft at ${spot.x},${spot.y} (${plan.floor.branch.code} L${plan.floor.level})`,
      );
    }
  }

  console.log(`backfill: done — ${resized} placement(s) resized, ${skipped} already within tolerance.`);
  if (unplaceable.length) {
    console.log(`backfill: ${unplaceable.length} unit(s) need a bigger canvas (left as-is):`);
    for (const u of unplaceable) console.log(`  - ${u}`);
  }
}

main()
  .catch((err) => {
    console.error('backfill-placement-footprints:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

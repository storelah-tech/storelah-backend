/**
 * One-off data conversion for the floor-plan "blocks" feature — NO re-seed.
 *
 * The pre-blocks editor authored decorations as a `structure` JSON document that
 * mixed line/path primitives (walls, corridors) with RECT-shaped markers
 * (lift / stairs / entrance / fireExit). Blocks are the replacement for the
 * rect-shaped markers: uniform name+rect rows in FloorPlanBlock.
 *
 * This script, for every plan that still has rect-shaped markers AND no blocks:
 *   1. creates a FloorPlanBlock row per marker with the matching name + geometry
 *      (x/y/w/h in the same grid units; entrance/fireExit used the renderer's
 *      default h=2 when the JSON had no explicit height);
 *   2. removes those converted keys from the plan's legacy `structure`, keeping
 *      walls/corridors as static legacy decoration (the old editor still
 *      renders them; nothing disappears).
 *
 * Idempotent: a plan that already has any FloorPlanBlock rows is left alone, so
 * re-running after a partial/interrupted run cannot duplicate blocks.
 *
 * Run against the intended DB (local dev uses .env's DATABASE_URL on :5433):
 *
 *   pnpm db:backfill-blocks
 */
import { Prisma, PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();

// Rect-shaped structure keys → block names. Note: entrance/fireExit entries in
// the authored JSON carry no explicit height; the renderer defaulted them to 2
// grid units, so we materialize h=2 for them.
const RECT_KEYS: Array<{ key: string; name: string; defaultH: number }> = [
  { key: 'lift', name: 'Lift', defaultH: 0 },
  { key: 'stairs', name: 'Stairs', defaultH: 0 },
  { key: 'entrance', name: 'Entrance', defaultH: 2 },
  { key: 'fireExit', name: 'Fire Exit', defaultH: 2 },
];

function isRectMarker(v: unknown): v is Record<string, number> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

async function main(): Promise<void> {
  const plans = await prisma.floorPlan.findMany({
    select: { id: true, structure: true, _count: { select: { blocks: true } } },
  });

  let plansConverted = 0;
  let blocksCreated = 0;

  for (const plan of plans) {
    // Already has blocks (or a fresh run created them) → skip to stay idempotent.
    if (plan._count.blocks > 0) continue;
    if (!plan.structure || typeof plan.structure !== 'object' || Array.isArray(plan.structure)) continue;

    const structure = plan.structure as Record<string, unknown>;
    const rectEntries = RECT_KEYS.filter((r) => isRectMarker(structure[r.key]));
    if (!rectEntries.length) continue;

    // Create one block per rect-shaped marker.
    const data: Prisma.FloorPlanBlockCreateManyInput[] = rectEntries.map((r) => {
      const marker = structure[r.key] as Record<string, number>;
      return {
        floorPlanId: plan.id,
        name: r.name,
        x: marker.x ?? 0,
        y: marker.y ?? 0,
        width: Math.max(1, marker.w ?? 2),
        height: Math.max(1, marker.h ?? r.defaultH),
      };
    });
    const created = await prisma.floorPlanBlock.createMany({ data });
    blocksCreated += created.count;

    // Strip the converted rect keys from legacy structure; keep walls/corridors.
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(structure)) {
      if (!RECT_KEYS.some((r) => r.key === k)) next[k] = v;
    }
    await prisma.floorPlan.update({
      where: { id: plan.id },
      data: { structure: Object.keys(next).length ? (next as Prisma.InputJsonValue) : Prisma.JsonNull },
    });

    plansConverted += 1;
    console.log(
      `backfill: plan ${plan.id} — created ${created.count} block(s) ` +
        `[${rectEntries.map((r) => r.name).join(', ')}]; legacy structure now ` +
        `${Object.keys(next).length ? Object.keys(next).join(', ') : 'empty (cleared to JSON null)'}`,
    );
  }

  console.log(
    `backfill: done — ${plansConverted} plan(s) converted, ${blocksCreated} FloorPlanBlock row(s) created. No re-seed, no destructive operations.`,
  );
}

main()
  .catch((err) => {
    console.error('backfill-floor-plan-blocks:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
/**
 * Size re-tag DRY RUN — READ-ONLY, writes nothing.
 *
 * Lists which live units would move to which size category if every unit
 * were re-tiered by its Unit.sqft against the current UnitSize bands
 * (migration 20261111000000_unit_size_ranges: LOCKER 8–15, XS 10–19,
 * SMALL 20–39, MEDIUM 40–69, LARGE 70–99, XLBIZ 100–150 sq ft).
 *
 * Rule = the floor-plan publish rule (resolveSizeTier in src/core/unitSizing.ts):
 * nearest band (inside = distance 0); ties keep the unit's current size,
 * then lowest sortOrder. So a unit already inside its own band never moves,
 * and overlaps (LOCKER/XS at 10–15) keep the current size.
 *
 * Owner decision 2026-11-11: dry run only — nothing is re-tagged. A real
 * re-tag would be a separate, explicitly authorised change.
 *
 *   pnpm db:retier-units-dry-run            # summary + up to 50 sample rows
 *   pnpm db:retier-units-dry-run --all      # every unit that would move
 *   pnpm db:retier-units-dry-run --csv      # CSV of every move to stdout
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { resolveSizeTier } from '../src/core/unitSizing';

const prisma = new PrismaClient();

async function main() {
  const args = new Set(process.argv.slice(2));
  const sizes = await prisma.unitSize.findMany({
    select: { id: true, code: true, name: true, sqftFrom: true, sqftTo: true, sortOrder: true },
    orderBy: { sortOrder: 'asc' },
  });
  const byId = new Map(sizes.map((s) => [s.id, s]));
  // Live inventory only: soft-deleted rows excluded, DRAFT (unpublished
  // plan designs) excluded in JS (old-client enum safety, as elsewhere).
  const units = (
    await prisma.unit.findMany({
      where: { deletedAt: null },
      select: {
        unitCode: true,
        name: true,
        sqft: true,
        status: true,
        sizeId: true,
        branch: { select: { code: true } },
        floor: { select: { level: true } },
      },
      orderBy: { unitCode: 'asc' },
    })
  ).filter((u) => u.status !== 'DRAFT');

  type Move = { unitCode: string; unitNo: string; branch: string; level: number; sqft: number; status: string; from: string; to: string; inBand: boolean };
  const moves: Move[] = [];
  const outOfBandStay: Move[] = [];
  for (const u of units) {
    const cur = byId.get(u.sizeId);
    const tier = resolveSizeTier(sizes, u.sizeId, u.sqft);
    if (!cur || !tier) continue;
    const row: Move = {
      unitCode: u.unitCode,
      unitNo: u.name ?? u.unitCode,
      branch: u.branch.code,
      level: u.floor.level,
      sqft: u.sqft,
      status: u.status,
      from: cur.code,
      to: tier.size.code,
      inBand: tier.inBand,
    };
    if (tier.size.id !== cur.id) moves.push(row);
    else if (!tier.inBand) outOfBandStay.push(row);
  }

  if (args.has('--csv')) {
    console.log('unitCode,unitNo,branch,level,sqft,status,from,to,targetInBand');
    for (const m of moves) console.log([m.unitCode, JSON.stringify(m.unitNo), m.branch, m.level, m.sqft, m.status, m.from, m.to, m.inBand].join(','));
    return;
  }

  console.log('Size re-tag DRY RUN — nothing is written.');
  console.log('Bands: ' + sizes.map((s) => `${s.code} ${s.sqftFrom}–${s.sqftTo}`).join(' · '));
  console.log(`Live units checked: ${units.length}; would move: ${moves.length}; out of band but nearest is current: ${outOfBandStay.length}`);
  const pairs = new Map<string, { n: number; min: number; max: number; contracted: number }>();
  for (const m of moves) {
    const k = `${m.from} → ${m.to}`;
    const p = pairs.get(k) ?? { n: 0, min: Infinity, max: -Infinity, contracted: 0 };
    p.n++;
    p.min = Math.min(p.min, m.sqft);
    p.max = Math.max(p.max, m.sqft);
    if (m.status === 'OCCUPIED' || m.status === 'OVERDUE' || m.status === 'RESERVED') p.contracted++;
    pairs.set(k, p);
  }
  for (const [k, p] of [...pairs.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k}: ${p.n} unit(s), ${p.min}–${p.max} sq ft${p.contracted ? `, ${p.contracted} occupied/overdue/reserved` : ''}`);
  }
  const list = args.has('--all') ? moves : moves.slice(0, 50);
  if (list.length) {
    console.log(`\n${args.has('--all') ? 'All' : 'Sample'} moves (unit no. · facility L# · sqft · status · from → to):`);
    for (const m of list) console.log(`  ${m.unitNo} · ${m.branch} L${m.level} · ${m.sqft} · ${m.status} · ${m.from} → ${m.to}${m.inBand ? '' : ' (nearest, not in band)'}`);
    if (!args.has('--all') && moves.length > list.length) console.log(`  … ${moves.length - list.length} more (use --all or --csv)`);
  }
}

main()
  .catch((e) => {
    console.error('retier dry run failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

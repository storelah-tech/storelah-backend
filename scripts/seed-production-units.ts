/**
 * ADDITIVE production unit seeder — adds ~N new storage units per size
 * category, per ACTIVE branch (N = --count, default 10). Size-agnostic: size
 * categories are enumerated from the DB at runtime, never hardcoded (local
 * dev has LOCKER/SMALL/MEDIUM/LARGE; prod may differ).
 *
 * Usage (target DB = whatever .env's DATABASE_URL points at; this script
 * never prints env values or connection details):
 *
 *   pnpm db:seed-units --dry-run              # print the full would-be insertion matrix, insert NOTHING
 *   pnpm db:seed-units --count 10             # insert 10 units per size per branch (the default)
 *   pnpm db:seed-units -- --count 5 --dry-run # same, with the pnpm/npm '--' separator (also accepted)
 *
 * The devops agent runs the same commands against production with the prod
 * env in place (preview with --dry-run first, then run without it).
 *
 * Guarantees:
 *  - ADDITIVE ONLY. Never deletes or updates existing rows, never calls the
 *    db:seed logic, runs no migrations. The only writes are Unit INSERTs via
 *    createUnit.
 *  - NO FloorPlan / UnitPlacement writes: new units get NO floor-plan
 *    placement. They show in unit lists / availability / booking flows, but
 *    not on the floor-plan map until an operator places them via the CMS
 *    floor-plan editor.
 *  - New units: status AVAILABLE, attached to a real Floor of their branch,
 *    distributed roughly evenly across the branch's existing floors
 *    (round-robin over the whole per-branch batch).
  *  - Per-unit attributes are derived from EXISTING live units of the same
  *    branch+size (median sqft, median monthly rate, modal climateControl).
  *    hasAC is derived from that modal climateControl via the canonical
  *    climateControlToHasAC mapping (hasPillar defaults false — pillars are
  *    surveyed per unit, never guessed). Fallbacks when a size has no live
  *    units in a branch: same size in other branches (median sqft, median
  *    psf × sqft, modal climate) → branch-wide median psf × sqft → size-range
  *    midpoint × default 4.50 psf, climate null.
  *  - unitCode: minted by the CANONICAL codegen — this script inserts through
  *    src/core/units.ts createUnit, the exact POST /units API path. Next code
  *    = MAX 4-digit code across ALL rows (soft-deleted included, so a deleted
  *    unit's code is never reused) + 1, starting at 1001. No codes are invented
  *    or hardcoded anywhere; the dry-run's codes are a read-only projection of
  *    the same algorithm for preview — actual codes are re-derived by createUnit
  *    at insert time, so a concurrent writer can never cause a collision.
 *  - NOT idempotent on purpose: re-running adds another batch. Every run
 *    prints exactly what it planned/inserted (unit codes, attributes, and a
 *    before/after count matrix per branch×size) so runs are auditable.
 */
import 'dotenv/config';
import { UnitStatus } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { createUnit, nextFourDigitCode, climateControlToHasAC } from '../src/core/units';
import { toNum } from '../src/lib/format';

// ---------- CLI args (strict: an unknown flag is a hard error, never a silent live insert) ----------

const MAX_COUNT = 100; // fat-finger guard for a script that writes to prod
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
let count = 10;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--' || a === '--dry-run') continue; // '--' = pnpm/npm run arg separator
  if (a === '--count') {
    const raw = args[++i];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) {
      console.error(`--count must be an integer between 1 and ${MAX_COUNT} (got "${raw}")`);
      process.exit(1);
    }
    count = n;
  } else if (a?.startsWith('--count=')) {
    const raw = a.slice('--count='.length);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) {
      console.error(`--count must be an integer between 1 and ${MAX_COUNT} (got "${raw}")`);
      process.exit(1);
    }
    count = n;
  } else {
    console.error(`Unknown argument: ${a} (supported: --dry-run, --count N)`);
    process.exit(1);
  }
}

// ---------- stats helpers ----------

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Most frequent non-null value; deterministic on ties (alphabetically first).
function mode(values: (string | null)[]): string | null {
  const tally = new Map<string, number>();
  for (const v of values) {
    if (v == null) continue;
    tally.set(v, (tally.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- types ----------

interface UnitRow {
  branchId: string;
  floorId: string;
  sizeId: string;
  unitCode: string;
  sqft: number;
  rate: number;
  climateControl: string | null;
  deleted: boolean;
}

interface FloorLite {
  id: string;
  level: number;
}

interface BucketPlan {
  branchCode: string;
  branchId: string;
  sizeCode: string;
  sizeName: string;
  sizeId: string;
  count: number;
  sqft: number;
  rate: number;
  climateControl: string | null;
  source: string;
  floorSequence: FloorLite[]; // floor for unit #i — mirrors the code projection below
  projectedCodes: string[]; // dry-run projection of the canonical codegen
}

// ---------- attribute derivation (from EXISTING live units of the same bucket) ----------

const DEFAULT_PSF = 4.5;

function deriveBucket(
  snapshot: UnitRow[],
  branchId: string,
  sizeId: string,
  size: { code: string; sqftFrom: number; sqftTo: number },
): { sqft: number; rate: number; climateControl: string | null; source: string } {
  const live = snapshot.filter((u) => !u.deleted);
  const sameBranchSize = live.filter((u) => u.branchId === branchId && u.sizeId === sizeId);
  const sameSizeAny = live.filter((u) => u.sizeId === sizeId);
  const sameBranchAny = live.filter((u) => u.branchId === branchId);
  const medianPsf = (rows: UnitRow[]) =>
    median(rows.filter((u) => u.sqft > 0).map((u) => u.rate / u.sqft));
  const notes: string[] = [];

  // sqft: median of same branch+size → median of this size anywhere → size-range midpoint.
  let sqft = median(sameBranchSize.map((u) => u.sqft));
  if (sqft != null) {
    notes.push('sqft: median of existing same-branch units of this size');
  } else if ((sqft = median(sameSizeAny.map((u) => u.sqft))) != null) {
    notes.push('sqft: median of this size across other branches (none in this branch)');
  } else {
    sqft = (size.sqftFrom + size.sqftTo) / 2;
    notes.push(`sqft: midpoint of size range ${size.sqftFrom}–${size.sqftTo} (no existing units of this size anywhere)`);
  }
  sqft = Math.max(1, Math.round(sqft));

  // monthlyRate: median of same branch+size → median psf of this size anywhere × sqft
  //              → branch-wide median psf × sqft → default psf × sqft.
  let rate = median(sameBranchSize.map((u) => u.rate));
  if (rate != null) {
    notes.push('rate: median of existing same-branch units of this size');
  } else {
    const psfSameSize = medianPsf(sameSizeAny);
    const psfSameBranch = medianPsf(sameBranchAny);
    if (psfSameSize != null) {
      rate = psfSameSize * sqft;
      notes.push('rate: median psf of this size (other branches) × sqft');
    } else if (psfSameBranch != null) {
      rate = psfSameBranch * sqft;
      notes.push('rate: branch-wide median psf × sqft');
    } else {
      rate = DEFAULT_PSF * sqft;
      notes.push(`rate: default ${DEFAULT_PSF.toFixed(2)} psf × sqft (no pricing data at all)`);
    }
  }
  rate = round2(rate);

  // climateControl — the Unit table's only feature-like attribute (no features column exists):
  // modal value of same branch+size → modal value of this size anywhere → null (unset).
  let climateControl = mode(sameBranchSize.map((u) => u.climateControl));
  if (climateControl == null) climateControl = mode(sameSizeAny.map((u) => u.climateControl));

  return { sqft, rate, climateControl, source: notes.join('; ') };
}

// ---------- dry-run projection of the canonical createUnit codegen ----------

// Mirrors src/core/units.ts createUnit exactly: the next free 4-digit code =
// MAX 4-digit code across ALL rows (soft-deleted INCLUDED — codes of deleted
// units are never reused) + 1, starting at 1001. The `nextCode` counter is
// shared ACROSS branches (one object threaded through every projectBranch
// call) to match the sequential insert loop, where each createUnit sees the
// previous inserts. Legacy BM-01-01 codes never match /^\d{4}$/ so they are
// ignored by both the projection and the real codegen.
function projectBranch(
  floors: FloorLite[],
  sizeCount: number,
  perBucket: number,
  nextCode: { value: number },
): { floorSequence: FloorLite[]; codes: string[] }[] {
  return Array.from({ length: sizeCount }, (_, sizeIndex) => {
    const floorSequence: FloorLite[] = [];
    const codes: string[] = [];
    for (let i = 0; i < perBucket; i++) {
      const g = sizeIndex * perBucket + i; // global index within the branch's batch
      const floor = floors[g % floors.length];
      floorSequence.push(floor);
      codes.push(String(nextCode.value++));
    }
    return { floorSequence, codes };
  });
}

// ---------- matrix printing ----------

function printMatrix(
  title: string,
  branchCodes: string[],
  sizeCodes: string[],
  cellFor: (branch: string, size: string) => string,
  totalFor: (branch: string) => string,
) {
  const header = ['branch', ...sizeCodes, 'total'];
  const rows = branchCodes.map((b) => [
    b,
    ...sizeCodes.map((s) => cellFor(b, s)),
    totalFor(b),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)) + 2,
  );
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('');
  console.log(title);
  console.log(`  ${line(header)}`);
  for (const r of rows) console.log(`  ${line(r)}`);
}

// ---------- main ----------

async function main() {
  console.log(
    `seed-production-units — ${dryRun ? 'DRY RUN (nothing will be inserted)' : 'LIVE RUN (will insert)'}, ` +
      `${count} unit(s) per size per ACTIVE branch. Target DB: DATABASE_URL from .env (value not printed).`,
  );

  const [branches, sizes] = await Promise.all([
    prisma.branch.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { code: 'asc' },
      include: { floors: { orderBy: { level: 'asc' }, select: { id: true, level: true } } },
    }),
    prisma.unitSize.findMany({ orderBy: { sortOrder: 'asc' } }),
  ]);
  if (!branches.length) throw new Error('No ACTIVE branches found — nothing to do');
  if (!sizes.length) throw new Error('No UnitSize rows found — nothing to do');

  // One snapshot of ALL unit rows, soft-deleted INCLUDED: the code projection
  // must see deleted codes (never reused); attribute derivation filters them.
  const snapshot: UnitRow[] = (
    await prisma.unit.findMany({
      select: {
        branchId: true,
        floorId: true,
        sizeId: true,
        unitCode: true,
        sqft: true,
        monthlyRate: true,
        climateControl: true,
        deletedAt: true,
      },
    })
  ).map((u) => ({
    branchId: u.branchId,
    floorId: u.floorId,
    sizeId: u.sizeId,
    unitCode: u.unitCode,
    sqft: u.sqft,
    rate: toNum(u.monthlyRate),
    climateControl: u.climateControl,
    deleted: u.deletedAt != null,
  }));

  const branchCodeOf = (id: string) => branches.find((b) => b.id === id)?.code ?? id;
  const sizeCodeOf = (id: string) => sizes.find((s) => s.id === id)?.code ?? id;
  const key = (b: string, s: string) => `${b}|${s}`;
  const beforeCounts = new Map<string, number>();
  for (const u of snapshot) {
    if (u.deleted) continue;
    const k = key(branchCodeOf(u.branchId), sizeCodeOf(u.sizeId));
    beforeCounts.set(k, (beforeCounts.get(k) ?? 0) + 1);
  }

  const sizeCodes = sizes.map((s) => s.code);

  console.log(
    `sizes (from DB): ${sizes.map((s) => `${s.code} [${s.sqftFrom}–${s.sqftTo} sqft]`).join(', ')}`,
  );
  console.log(
    `branches (ACTIVE, from DB): ${branches
      .map((b) => `${b.code} (floors ${b.floors.map((f) => f.level).join(',') || '—'})`)
      .join(', ')}`,
  );
  console.log('');

  // ---------- plan ----------
  // Shared 4-digit code counter across ALL branches (matches the global
  // codegen): starts above the current MAX 4-digit code in the snapshot.
  const nextCode = { value: Number(nextFourDigitCode(snapshot.map((u) => u.unitCode))) };
  const plans: BucketPlan[] = [];
  for (const branch of branches) {
    if (!branch.floors.length) {
      console.log(`skip: ${branch.code} has no floors — a unit must attach to a real Floor`);
      continue;
    }
    const projected = projectBranch(branch.floors, sizes.length, count, nextCode);
    sizes.forEach((size, sizeIndex) => {
      const derived = deriveBucket(snapshot, branch.id, size.id, size);
      const { floorSequence, codes } = projected[sizeIndex];
      plans.push({
        branchCode: branch.code,
        branchId: branch.id,
        sizeCode: size.code,
        sizeName: size.name,
        sizeId: size.id,
        count,
        sqft: derived.sqft,
        rate: derived.rate,
        climateControl: derived.climateControl,
        source: derived.source,
        floorSequence,
        projectedCodes: codes,
      });
    });
  }

  const plannedBranches = [...new Set(plans.map((p) => p.branchCode))];
  printMatrix(
    'BEFORE — live units per branch × size:',
    plannedBranches,
    sizeCodes,
    (b, s) => String(beforeCounts.get(key(b, s)) ?? 0),
    (b) => String(sizeCodes.reduce((sum, s) => sum + (beforeCounts.get(key(b, s)) ?? 0), 0)),
  );
  console.log('');
  printMatrix(
    `PLANNED insertion (branch × size):`,
    plannedBranches,
    sizeCodes,
    (b, s) => {
      const p = plans.find((x) => x.branchCode === b && x.sizeCode === s);
      return p ? `+${p.count}` : '—';
    },
    (b) => `+${plans.filter((p) => p.branchCode === b).reduce((sum, p) => sum + p.count, 0)}`,
  );
  console.log('');

  console.log('Derived attributes + projected codes per bucket (projection of the canonical codegen):');
  for (const p of plans) {
    const psf = p.sqft ? round2(p.rate / p.sqft) : 0;
    const perFloor = new Map<number, number>();
    for (const f of p.floorSequence) perFloor.set(f.level, (perFloor.get(f.level) ?? 0) + 1);
    console.log(
      `  ${p.branchCode} × ${p.sizeCode} (${p.sizeName}): ${p.count} unit(s) @ ${p.sqft} sqft, ` +
        `$${p.rate.toFixed(2)}/mo (${psf.toFixed(2)} psf), climate=${p.climateControl ?? '(unset)'}, ` +
        `floor split: ${[...perFloor.entries()].sort((a, b) => a[0] - b[0]).map(([lv, n]) => `L${lv}×${n}`).join(' ')}`,
    );
    console.log(`    projected codes: ${p.projectedCodes.join(', ')}`);
    console.log(`    source: ${p.source}`);
  }
  console.log('');

  if (dryRun) {
    console.log(
      `DRY RUN complete — nothing was inserted. Re-run without --dry-run to insert ` +
        `${plans.reduce((sum, p) => sum + p.count, 0)} unit(s).`,
    );
    return;
  }

  // ---------- insert (via createUnit — the canonical POST /units path) ----------
  console.log('Inserting…');
  const inserted: Array<{ branch: string; code: string }> = [];
  const failures: string[] = [];
  let n = 0;
  for (const p of plans) {
    for (let i = 0; i < p.count; i++) {
      n++;
      const floor = p.floorSequence[i];
      try {
        const unit = await createUnit({
          branchId: p.branchId,
          floorId: floor.id,
          sizeId: p.sizeId,
          sqft: p.sqft,
          monthlyRate: p.rate,
          status: UnitStatus.AVAILABLE,
          climateControl: p.climateControl ?? undefined,
          // createUnit maps the legacy climate string onto hasAC itself; the
          // explicit flag here keeps the seeded row honest even if the string
          // mapping ever changes.
          hasAC: climateControlToHasAC(p.climateControl) ?? false,
        });
        inserted.push({ branch: p.branchCode, code: unit.unitCode });
        console.log(
          `  [${n}] inserted ${unit.unitCode} — ${p.branchCode}, ${p.sizeCode}, floor ${floor.level}, ` +
            `${p.sqft} sqft, $${p.rate.toFixed(2)}/mo${p.climateControl ? `, climate: ${p.climateControl}` : ''}`,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        failures.push(`${p.branchCode} × ${p.sizeCode} #${i + 1}: ${message}`);
        console.error(`  [${n}] FAILED ${p.branchCode} × ${p.sizeCode} #${i + 1}: ${message}`);
      }
    }
  }

  // ---------- after matrix ----------
  const afterRows = await prisma.unit.groupBy({
    by: ['branchId', 'sizeId'],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const afterCounts = new Map<string, number>();
  for (const r of afterRows) {
    const k = key(branchCodeOf(r.branchId), sizeCodeOf(r.sizeId));
    afterCounts.set(k, (afterCounts.get(k) ?? 0) + r._count._all);
  }

  console.log('');
  printMatrix(
    'AFTER — live units per branch × size (before → after (+delta)):',
    plannedBranches,
    sizeCodes,
    (b, s) => {
      const before = beforeCounts.get(key(b, s)) ?? 0;
      const after = afterCounts.get(key(b, s)) ?? 0;
      return `${before} → ${after} (+${after - before})`;
    },
    (b) => {
      const before = sizeCodes.reduce((sum, s) => sum + (beforeCounts.get(key(b, s)) ?? 0), 0);
      const after = sizeCodes.reduce((sum, s) => sum + (afterCounts.get(key(b, s)) ?? 0), 0);
      return `${before} → ${after} (+${after - before})`;
    },
  );

  console.log('');
  console.log(
    `DONE: inserted ${inserted.length} unit(s), failed ${failures.length}. Inserted unit codes:`,
  );
  for (const b of plannedBranches) {
    const codes = inserted.filter((c) => c.branch === b).map((c) => c.code);
    if (codes.length) console.log(`  ${b}: ${codes.join(', ')}`);
  }
  console.log(
    'NOTE: the new units have NO floor-plan placement (UnitPlacement untouched) — they show in ' +
      'lists/availability/booking but not on the floor-plan map until an operator places them ' +
      'via the CMS floor-plan editor.',
  );
  if (failures.length) {
    throw new Error(`${failures.length} unit insert(s) failed — see FAILED lines above`);
  }
}

main()
  .catch((e) => {
    console.error('seed-production-units failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

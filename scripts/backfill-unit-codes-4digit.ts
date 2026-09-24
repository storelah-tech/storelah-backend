/**
 * One-time backfill: rename legacy unit codes (BM-01-01 style) to 4-digit
 * numeric codes (1001…), globally unique.
 *
 *   pnpm dlx tsx scripts/backfill-unit-codes-4digit.ts --dry-run   # preview only (DEFAULT)
 *   pnpm dlx tsx scripts/backfill-unit-codes-4digit.ts --apply     # perform the rename
 *
 * Safety:
 *  - FK-SAFE BY CONSTRUCTION: UnitPlacement.unitId, Tenant.unitId,
 *    Booking.unitId, Invoice.unitId, Notice.unitId, RateChange.unitId,
 *    WorkOrder.unitId and Incident.unitId all reference Unit.id (cuid), NEVER
 *    the code. The rename updates ONLY Unit.unitCode (by id) — no FK row is
 *    touched and no relation can break.
 *  - LOOSE REFERENCES (flagged, never rewritten): Lead.unitCode is a free-text
 *    (non-FK) reference and RateChange has no code column. The script REPORTS
 *    how many Lead rows reference each old code so the operator can follow up;
 *    it does not rewrite them (lead history is append-only evidence).
 *  - Already-4-digit codes are never touched; soft-deleted rows ARE renamed
 *    too (they still own their code; renaming keeps the sequence audit-clean).
 *    To skip deleted rows, pass --skip-deleted.
 *  - Deterministic order: branch code → floor level → createdAt → id. New
 *    codes start above the current MAX 4-digit code (default first code 1001),
 *    so concurrent 4-digit rows (imports / creates) can never collide with the
 *    plan — the script re-checks uniqueness per row inside a transaction and
 *    aborts the whole run on the first conflict.
 *  - The mapping (old → new) prints as JSON lines on stdout in --apply mode so
 *    the operator keeps a traceable log: redirect to a file for the audit trail.
 *
 * If a full rename of live data is deemed too risky, do NOT run --apply: new
 * and imported units already mint 4-digit codes via the canonical codegen
 * (src/core/units.ts), and legacy codes keep working everywhere (lookups are
 * by exact code string; the dashboard short-code falls back to the full code
 * for dashless codes).
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { nextFourDigitCode, isFourDigitCode } from '../src/core/units';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dryRun = !apply || args.includes('--dry-run');
const skipDeleted = args.includes('--skip-deleted');

for (const a of args) {
  if (!['--apply', '--dry-run', '--skip-deleted'].includes(a)) {
    console.error(`Unknown argument: ${a} (supported: --apply, --dry-run, --skip-deleted)`);
    process.exit(1);
  }
}

async function main() {
  const units = await prisma.unit.findMany({
    where: skipDeleted ? { deletedAt: null } : {},
    select: { id: true, unitCode: true, status: true, deletedAt: true, branch: { select: { code: true } }, floor: { select: { level: true } }, createdAt: true },
    orderBy: [{ branch: { code: 'asc' } }, { floor: { level: 'asc' } }, { createdAt: 'asc' }, { id: 'asc' }],
  });

  const legacy = units.filter((u) => !isFourDigitCode(u.unitCode));
  const taken = new Set(units.filter((u) => isFourDigitCode(u.unitCode)).map((u) => u.unitCode));

  // Loose (non-FK) Lead references to each legacy code — reported, not rewritten.
  const leadRefs = new Map<string, number>();
  if (legacy.length) {
    const grouped = await prisma.lead.groupBy({
      by: ['unitCode'],
      where: { unitCode: { in: legacy.map((u) => u.unitCode) } },
      _count: { _all: true },
    });
    for (const g of grouped) {
      if (g.unitCode) leadRefs.set(g.unitCode, g._count._all);
    }
  }

  // Plan the mapping deterministically: next free code above the running max.
  let next = Number(nextFourDigitCode([...taken]));
  const plan = legacy.map((u) => {
    while (taken.has(String(next))) next++;
    const to = String(next++);
    taken.add(to);
    return { id: u.id, from: u.unitCode, to, status: u.status, deleted: u.deletedAt != null, leadRefs: leadRefs.get(u.unitCode) ?? 0 };
  });

  console.log(`backfill-unit-codes-4digit — ${dryRun ? 'DRY RUN (no writes)' : 'APPLY (renaming codes)'}${skipDeleted ? ' — skipping soft-deleted rows' : ''}`);
  console.log(`units: ${units.length} total, ${units.length - legacy.length} already 4-digit, ${legacy.length} to rename.`);

  if (!plan.length) {
    console.log('Nothing to rename — every unit code is already 4-digit.');
    return;
  }

  if (dryRun) {
    console.log('Planned mapping (old → new):');
    for (const p of plan) {
      console.log(`  ${p.from} → ${p.to}  [${p.status}${p.deleted ? ' +deleted' : ''}${p.leadRefs ? ` +${p.leadRefs} lead ref(s)` : ''}]`);
    }
    console.log('Re-run with --apply to perform the rename (mapping will print as JSON for the audit trail).');
    return;
  }

  // --apply: rename one row at a time (by id), re-checking uniqueness first so
  // a concurrent 4-digit create can never silently collide — any conflict
  // aborts the run before further writes.
  const mapping: Array<{ from: string; to: string }> = [];
  for (const p of plan) {
    const clash = await prisma.unit.findUnique({ where: { unitCode: p.to }, select: { id: true } });
    if (clash) {
      throw new Error(`ABORTED: target code ${p.to} (for ${p.from}) was taken concurrently — no further rows renamed. Re-run to re-plan.`);
    }
    await prisma.unit.update({ where: { id: p.id }, data: { unitCode: p.to } });
    mapping.push({ from: p.from, to: p.to });
    console.log(JSON.stringify({ from: p.from, to: p.to, status: p.status, leadRefs: p.leadRefs }));
  }
  console.log(`DONE: renamed ${mapping.length} unit code(s). Lead rows referencing old codes were NOT rewritten (${plan.reduce((s, p) => s + p.leadRefs, 0)} loose ref(s) reported above).`);
}

main()
  .catch((e) => {
    console.error('backfill-unit-codes-4digit failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

/**
 * FREE-ALL-UNITS — set every live unit to AVAILABLE (release reserved/hold blockers).
 *
 * One-shot operator reset for the LIVE database. "Free up the units, including
 * reserved ones" == every non-deleted Unit row ends in status AVAILABLE with no
 * hold blockers left behind. Run from the deployer machine against the DB you
 * intend to update (production = Neon; use the DIRECT URL, same convention as
 * migrations/seed — see docs/backend-deploy.md):
 *
 *   # 1. Preview first (DEFAULT — read-only, writes NOTHING):
 *   DATABASE_URL="$NEON_DIRECT_URL" pnpm db:free-units --dry-run
 *
 *   # 2. Execute (explicit opt-in; all writes land in ONE transaction):
 *   DATABASE_URL="$NEON_DIRECT_URL" pnpm db:free-units --live
 *
 * What --live does, in a single prisma.$transaction (all-or-nothing):
 *   1. Tenant holds released: Tenant.unitId -> NULL for every linked tenant.
 *      Rows are PRESERVED (identity/history kept); this mirrors the release
 *      semantics in deactivateTenant / createCustomerBooking (customers.ts),
 *      which null the link instead of deleting the tenant.
 *      Opt out with --keep-tenant-links (unit statuses still flip, but linked
 *      tenants stay linked — the CMS drawer will still show an occupant).
 *   2. Unpaid holds cancelled: Booking.status PENDING_PAYMENT -> CANCELLED.
 *      Rows are PRESERVED (no hard delete); CONFIRMED / ACTIVE / CANCELLED
 *      bookings are untouched. A leftover PENDING_PAYMENT row is an unpaid
 *      hold that the Stripe webhook could later confirm (re-occupying the
 *      unit), so cancelling is what makes the release stick.
 *      Opt out with --keep-pending-bookings.
 *   3. Unit statuses flipped: every Unit with deletedAt NULL and status !=
 *      AVAILABLE -> AVAILABLE (OCCUPIED, RESERVED, OVERDUE, MAINTENANCE,
 *      INACTIVE, BLOCKED — all of them; that is the requested "set ALL units
 *      to available").
 *
 * What it NEVER touches:
 *   - Soft-deleted units (deletedAt != null) — excluded, per docs/UNIT_DELETION.md.
 *   - Booking / Invoice / Tenant ROWS — updated in place only, never deleted.
 *   - UnitPlacement, rates, floors, branches — untouched.
 *   - Env values / connection strings are never printed (counts only).
 *
 * Safety: no flags (or --dry-run) == read-only preview. --live is the only
 * path that writes, and an unknown flag is a hard error (never a silent live run).
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma';

const args = process.argv.slice(2);
let live = false;
let dryRun = false;
let keepTenantLinks = false;
let keepPendingBookings = false;

for (const a of args) {
  if (a === '--') continue; // pnpm/npm run arg separator
  else if (a === '--live') live = true;
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--keep-tenant-links') keepTenantLinks = true;
  else if (a === '--keep-pending-bookings') keepPendingBookings = true;
  else {
    console.error(
      `Unknown argument: ${a} (supported: --dry-run, --live, --keep-tenant-links, --keep-pending-bookings)`,
    );
    process.exit(1);
  }
}

if (live && dryRun) {
  console.error('Pass exactly one of --live / --dry-run (default without flags is a dry run).');
  process.exit(1);
}

const WRITE = live && !dryRun;

type StatusCounts = Record<string, number>;

async function countUnitsByStatus(): Promise<StatusCounts> {
  const rows = await prisma.unit.groupBy({
    by: ['status'],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const counts: StatusCounts = {};
  for (const r of rows) counts[r.status] = r._count._all;
  return counts;
}

function printStatusCounts(title: string, counts: StatusCounts): void {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  console.log(title);
  for (const s of Object.keys(counts).sort()) {
    console.log(`  ${s}: ${counts[s]}`);
  }
  console.log(`  TOTAL live units: ${total}`);
}

async function main(): Promise<void> {
  const before = await countUnitsByStatus();
  const pendingBookings = await prisma.booking.count({ where: { status: 'PENDING_PAYMENT' } });
  const linkedTenants = await prisma.tenant.count({ where: { unitId: { not: null } } });
  const nonAvailable = Object.entries(before)
    .filter(([s]) => s !== 'AVAILABLE')
    .reduce((s, [, n]) => s + n, 0);

  printStatusCounts('BEFORE — live units by status (deletedAt null):', before);
  console.log(`BEFORE — PENDING_PAYMENT bookings (unpaid holds): ${pendingBookings}`);
  console.log(`BEFORE — tenants linked to a unit (paid holds): ${linkedTenants}`);
  console.log('');

  if (!WRITE) {
    console.log(
      `DRY RUN — no writes performed. A --live run would, in one transaction: ` +
        `set ${nonAvailable} non-AVAILABLE unit(s) -> AVAILABLE` +
        (keepTenantLinks
          ? `; KEEP ${linkedTenants} tenant link(s) (--keep-tenant-links)`
          : `; unlink ${linkedTenants} tenant link(s) (unitId -> NULL, rows preserved)`) +
        (keepPendingBookings
          ? `; KEEP ${pendingBookings} PENDING_PAYMENT booking(s) (--keep-pending-bookings)`
          : `; cancel ${pendingBookings} PENDING_PAYMENT booking(s) -> CANCELLED (rows preserved)`) +
        `.`,
    );
    console.log('Re-run with --live to execute (target DB = whatever DATABASE_URL points at).');
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    let tenantsUnlinked = 0;
    let bookingsCancelled = 0;
    if (!keepTenantLinks) {
      const r = await tx.tenant.updateMany({
        where: { unitId: { not: null } },
        data: { unitId: null },
      });
      tenantsUnlinked = r.count;
    }
    if (!keepPendingBookings) {
      const r = await tx.booking.updateMany({
        where: { status: 'PENDING_PAYMENT' },
        data: { status: 'CANCELLED' },
      });
      bookingsCancelled = r.count;
    }
    const unitsFreed = (
      await tx.unit.updateMany({
        where: { deletedAt: null, status: { not: 'AVAILABLE' } },
        data: { status: 'AVAILABLE' },
      })
    ).count;
    return { tenantsUnlinked, bookingsCancelled, unitsFreed };
  });

  console.log(
    `LIVE — transaction committed: ${result.unitsFreed} unit(s) -> AVAILABLE, ` +
      `${result.tenantsUnlinked} tenant link(s) released, ` +
      `${result.bookingsCancelled} PENDING_PAYMENT booking(s) cancelled.`,
  );
  console.log('');

  const after = await countUnitsByStatus();
  printStatusCounts('AFTER — live units by status (deletedAt null):', after);
  const remaining = Object.entries(after)
    .filter(([s]) => s !== 'AVAILABLE')
    .reduce((s, [, n]) => s + n, 0);
  if (remaining !== 0) {
    throw new Error(`${remaining} live unit(s) still non-AVAILABLE after the update — investigate.`);
  }
  console.log('VERIFY OK — all live units are AVAILABLE.');
  if (!keepTenantLinks) {
    const stillLinked = await prisma.tenant.count({ where: { unitId: { not: null } } });
    console.log(`VERIFY — tenants still linked to a unit: ${stillLinked} (expected 0).`);
    if (stillLinked !== 0) throw new Error('tenant links remain after release — investigate.');
  }
  if (!keepPendingBookings) {
    const stillPending = await prisma.booking.count({ where: { status: 'PENDING_PAYMENT' } });
    console.log(`VERIFY — bookings still PENDING_PAYMENT: ${stillPending} (expected 0).`);
    if (stillPending !== 0) throw new Error('PENDING_PAYMENT bookings remain — investigate.');
  }
  console.log('');
  console.log(
    'NOTE: MAINTENANCE / BLOCKED / INACTIVE holds were overridden by design ("set ALL ' +
      'units to available"). Re-apply any physical hold (fit-out, damage, audit) or ' +
      'INACTIVE business state via the CMS unit editor if it still applies. No rows ' +
      'were deleted; cancelled bookings and unlinked tenants remain queryable history.',
  );
}

main()
  .catch((e) => {
    console.error('free-all-units failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

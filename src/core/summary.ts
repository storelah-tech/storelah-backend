import { prisma } from '../lib/prisma';
import { toNum, pct } from '../lib/format';
import { quantizeSqft } from './unitSizing';

export async function getSummary() {
  const fetched = await prisma.unit.findMany({
    // DRAFT = drawn on a floor plan, not yet published (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md D7) — not inventory yet.
    // Excluded in JS below, NOT in this where clause: sending the DRAFT
    // literal as query input throws `Invalid value for argument 'not'.
    // Expected UnitStatus` on any runtime whose generated Prisma client
    // predates the DRAFT enum value (migration 20261014000000). Filtering
    // post-fetch keeps the result identical on old and new clients.
    where: { deletedAt: null },
    include: { size: true, tenant: true, branch: true },
  });
  // Draft-plan units are not inventory yet (see where clause above).
  const units = fetched.filter((u) => u.status !== 'DRAFT');

  const total = units.length;
  const occupiedUnits = units.filter((u) => u.status === 'OCCUPIED').length;
  const overdueUnits = units.filter((u) => u.status === 'OVERDUE').length;
  const leased = units.filter(
    (u) => u.status === 'OCCUPIED' || u.status === 'OVERDUE' || u.status === 'RESERVED',
  ).length;

  const mrr = units
    .filter((u) => u.status === 'OCCUPIED' || u.status === 'OVERDUE')
    .reduce((s, u) => s + toNum(u.monthlyRate), 0);

  const active = units.filter((u) => u.status === 'OCCUPIED' || u.status === 'OVERDUE');
  const avgPsf = active.length
    ? active.reduce((s, u) => s + toNum(u.monthlyRate) / u.sqft, 0) / active.length
    : 0;

  const byBranch = units.reduce<Record<string, { name: string; total: number; leased: number }>>((acc, u) => {
    const b = u.branch;
    acc[b.code] ??= { name: b.name, total: 0, leased: 0 };
    acc[b.code].total++;
    if (u.status === 'OCCUPIED' || u.status === 'OVERDUE' || u.status === 'RESERVED') acc[b.code].leased++;
    return acc;
  }, {});

  const bySize = active.reduce<Record<string, number>>((acc, u) => {
    acc[u.size.code] = (acc[u.size.code] ?? 0) + toNum(u.monthlyRate);
    return acc;
  }, {});

  const overdueTenants = await prisma.tenant.count({ where: { status: 'OVERDUE' } });

  // Command-centre "today" tiles (additive): sign-ups = Tenant.createdAt on the
  // current UTC calendar day; move-ins = Booking.moveInDate on the current UTC
  // calendar day (the CMS move-ins table keys off Booking.moveInDate — see
  // getMoveIns in core/branches.ts). UTC day bounds match the shared
  // YYYY-MM-DD date-range contract (src/lib/dateRange.ts); Singapore (UTC+8)
  // operators should note a UTC day lags SGT by 8h (00:00–07:59 SGT still
  // counts as "yesterday"). Zero is a real count; the block is always present
  // so the UI can render an honest empty/zero state instead of "—".
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const [signupsToday, moveInsToday] = await Promise.all([
    prisma.tenant.count({ where: { createdAt: { gte: dayStart } } }),
    prisma.booking.count({ where: { moveInDate: { gte: dayStart, lt: dayEnd } } }),
  ]);

  // P1 item 1: portfolio rollup computed from the same Unit rows (sqft-based).
  // BLOCKED units contribute to totals but never to leased/MRR/PSF.
  // Decimal sqft: sums rounded to 0.01 so float noise never surfaces.
  const totalSqft = quantizeSqft(units.reduce((s, u) => s + u.sqft, 0));
  const leasedUnits = units.filter(
    (u) => u.status === 'OCCUPIED' || u.status === 'OVERDUE' || u.status === 'RESERVED',
  );
  const leasedSqft = quantizeSqft(leasedUnits.reduce((s, u) => s + u.sqft, 0));
  const sqftByBranch = units.reduce<Record<string, { name: string; totalSqft: number; leasedSqft: number }>>(
    (acc, u) => {
      const b = u.branch;
      acc[b.code] ??= { name: b.name, totalSqft: 0, leasedSqft: 0 };
      acc[b.code].totalSqft += u.sqft;
      if (u.status === 'OCCUPIED' || u.status === 'OVERDUE' || u.status === 'RESERVED') {
        acc[b.code].leasedSqft += u.sqft;
      }
      return acc;
    },
    {},
  );

  return {
    kpis: {
      totalUnits: total,
      occupiedUnits,
      overdueUnits,
      occupancyPct: pct(leased, total),
      mrr: Math.round(mrr),
      avgPsf: Math.round(avgPsf * 100) / 100,
      activeTenants: occupiedUnits,
      overdueTenants,
    },
    monthlyRevenue: {
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
      actual: [36200, 37800, 38500, 39200, 40100, 41600, Math.round(mrr)],
      target: [38000, 38000, 39000, 39000, 40000, 41000, 42000],
    },
    occupancyByBranch: Object.entries(byBranch).map(([code, b]) => ({
      branch: code,
      name: b.name,
      occupancyPct: pct(b.leased, b.total),
    })),
    revenueBySize: Object.entries(bySize).map(([code, amount]) => ({
      code,
      amount: Math.round(amount),
    })),
    // P1 item 1: portfolio overview (computed only — same Unit rows as above).
    portfolio: {
      totalUnits: total,
      leasedUnits: leased,
      occupancyPct: pct(leased, total),
      totalSqft,
      leasedSqft,
      availableSqft: quantizeSqft(Math.max(0, totalSqft - leasedSqft)),
      sqftOccupancyPct: pct(leasedSqft, totalSqft),
      mrr: Math.round(mrr),
      byBranch: Object.entries(sqftByBranch).map(([code, b]) => ({
        branch: code,
        name: b.name,
        totalSqft: quantizeSqft(b.totalSqft),
        leasedSqft: quantizeSqft(b.leasedSqft),
        sqftOccupancyPct: pct(b.leasedSqft, b.totalSqft),
      })),
    },
    // Command-centre "today" tiles (live counts — see the query above).
    today: {
      date: dayStart.toISOString().slice(0, 10),
      timezone: 'UTC',
      signups: signupsToday,
      moveIns: moveInsToday,
    },
  };
}
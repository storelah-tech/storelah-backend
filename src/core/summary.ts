import { prisma } from '../lib/prisma';
import { toNum, pct } from '../lib/format';

export async function getSummary() {
  const units = await prisma.unit.findMany({
    where: { deletedAt: null },
    include: { size: true, tenant: true, branch: true },
  });

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

  // P1 item 1: portfolio rollup computed from the same Unit rows (sqft-based).
  // BLOCKED units contribute to totals but never to leased/MRR/PSF.
  const totalSqft = units.reduce((s, u) => s + u.sqft, 0);
  const leasedUnits = units.filter(
    (u) => u.status === 'OCCUPIED' || u.status === 'OVERDUE' || u.status === 'RESERVED',
  );
  const leasedSqft = leasedUnits.reduce((s, u) => s + u.sqft, 0);
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
      availableSqft: Math.max(0, totalSqft - leasedSqft),
      sqftOccupancyPct: pct(leasedSqft, totalSqft),
      mrr: Math.round(mrr),
      byBranch: Object.entries(sqftByBranch).map(([code, b]) => ({
        branch: code,
        name: b.name,
        totalSqft: b.totalSqft,
        leasedSqft: b.leasedSqft,
        sqftOccupancyPct: pct(b.leasedSqft, b.totalSqft),
      })),
    },
  };
}
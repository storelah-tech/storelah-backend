import { prisma } from '../lib/prisma';
import { toNum, pct } from '../lib/format';
import { serializeBookings } from './finance';

// Statuses that count as revenue-generating / leased for portfolio math.
// BLOCKED is held out of inventory: it counts toward totals but never toward
// leased, MRR or PSF.
const LEASED_STATUSES = ['OCCUPIED', 'OVERDUE', 'RESERVED'];
const REVENUE_STATUSES = ['OCCUPIED', 'OVERDUE'];

// P1 item 1 (portfolio overview): per-facility sqft totals computed from the
// existing Unit rows — no migration, no stored rollup. leasedSqft covers
// OCCUPIED + OVERDUE + RESERVED; BLOCKED units contribute to totalSqft only.
export async function listBranches() {
  const branches = await prisma.branch.findMany({
    include: {
      _count: { select: { units: true, tenants: true, leads: true } },
      floors: { select: { level: true }, orderBy: { level: 'asc' } },
      units: {
        where: { deletedAt: null },
        select: { status: true, sqft: true, monthlyRate: true },
      },
    },
    orderBy: { code: 'asc' },
  });

  return branches.map((b) => {
    const units = b.units;
    const totalSqft = units.reduce((s, u) => s + u.sqft, 0);
    const leasedSqft = units
      .filter((u) => LEASED_STATUSES.includes(u.status))
      .reduce((s, u) => s + u.sqft, 0);
    const revenueUnits = units.filter((u) => REVENUE_STATUSES.includes(u.status));
    const mrr = revenueUnits.reduce((s, u) => s + toNum(u.monthlyRate), 0);
    const netPsf = revenueUnits.length
      ? revenueUnits.reduce((s, u) => s + (u.sqft ? toNum(u.monthlyRate) / u.sqft : 0), 0) /
        revenueUnits.length
      : 0;
    const leasedUnits = units.filter((u) => LEASED_STATUSES.includes(u.status)).length;
    return {
      id: b.id,
      code: b.code,
      name: b.name,
      address: b.address,
      operatingHours: b.operatingHours,
      status: b.status,
      floors: b.floors.map((f) => f.level),
      unitCount: b._count.units,
      tenantCount: b._count.tenants,
      leadCount: b._count.leads,
      // --- P1 portfolio fields (computed from Unit rows) ---
      totalUnits: units.length,
      leasedUnits,
      availableUnits: units.filter((u) => u.status === 'AVAILABLE').length,
      blockedUnits: units.filter((u) => u.status === 'BLOCKED').length,
      totalSqft,
      leasedSqft,
      availableSqft: Math.max(0, totalSqft - leasedSqft),
      occupancyPct: pct(leasedUnits, units.length),
      sqftOccupancyPct: pct(leasedSqft, totalSqft),
      mrr: Math.round(mrr),
      netPsf: Math.round(netPsf * 100) / 100,
    };
  });
}

// P1 item 1: portfolio rollup across facilities + the per-facility cards in
// one fetch for the admin portfolio view. Computed only.
export async function getPortfolio() {
  const facilities = await listBranches();
  const totalUnits = facilities.reduce((s, f) => s + f.totalUnits, 0);
  const leasedUnits = facilities.reduce((s, f) => s + f.leasedUnits, 0);
  const totalSqft = facilities.reduce((s, f) => s + f.totalSqft, 0);
  const leasedSqft = facilities.reduce((s, f) => s + f.leasedSqft, 0);
  const mrr = facilities.reduce((s, f) => s + f.mrr, 0);
  return {
    totals: {
      facilities: facilities.length,
      totalUnits,
      leasedUnits,
      occupancyPct: pct(leasedUnits, totalUnits),
      totalSqft,
      leasedSqft,
      availableSqft: Math.max(0, totalSqft - leasedSqft),
      sqftOccupancyPct: pct(leasedSqft, totalSqft),
      mrr,
    },
    facilities,
  };
}

// Customer-facing branch list: no internal counters, only availability.
// Inactive floors contribute nothing: the floor list holds active levels only
// and availableUnits counts live AVAILABLE units on active floors (previously
// unfiltered — soft-deleted units and inactive-floor units leaked into the
// count). See docs/FLOORS.md.
export async function listPublicBranches() {
  const branches = await prisma.branch.findMany({
    include: {
      floors: {
        where: { isActive: true },
        select: { level: true },
        orderBy: { level: 'asc' },
      },
      units: {
        where: { deletedAt: null, status: 'AVAILABLE', floor: { isActive: true } },
        select: { status: true },
      },
    },
    orderBy: { code: 'asc' },
  });

  return branches.map((b) => ({
    id: b.id,
    code: b.code,
    name: b.name,
    address: b.address,
    operatingHours: b.operatingHours,
    floors: b.floors.map((f) => f.level),
    availableUnits: b.units.length,
  }));
}

export async function getMoveIns(opts?: { from?: Date; to?: Date }) {
  // Default: today's move-ins only. An explicit from/to overrides the window
  // (the CMS move-ins table uses this for its date-range filter).
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const range: { gte?: Date; lt?: Date; lte?: Date } =
    opts?.from || opts?.to
      ? { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) }
      : { gte: startToday, lt: startTomorrow };

  const bookings = await prisma.booking.findMany({
    where: { moveInDate: range },
    include: { tenant: true, unit: { include: { size: true, branch: true } } },
  });

  // Same enriched shape as GET /bookings (shared serializer in core/finance.ts).
  return serializeBookings(bookings);
}

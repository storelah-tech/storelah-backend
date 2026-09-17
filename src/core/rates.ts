import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { MARKET_PSF } from './market';

export interface AdjustRateInput {
  newRate: number;
  effectiveDate?: string;
  reason?: string;
  appliedBy?: string;
}

export async function adjustRate(code: string, input: AdjustRateInput) {
  const unit = await prisma.unit.findUnique({
    where: { unitCode: code, deletedAt: null },
    include: { tenant: true },
  });
  if (!unit) throw new AppError(404, 'NOT_FOUND', `Unit ${code} not found`);

  const previous = toNum(unit.monthlyRate);
  const current = Math.round(input.newRate * 100) / 100;
  const changePct = previous ? Math.round(((current - previous) / previous) * 1000) / 10 : 0;

  await prisma.$transaction([
    prisma.unit.update({ where: { id: unit.id }, data: { monthlyRate: current } }),
    prisma.rateChange.create({
      data: {
        unitId: unit.id,
        date: new Date(input.effectiveDate || Date.now()),
        previous,
        current,
        changePct,
        reason: input.reason || 'Manual adjustment',
        appliedBy: input.appliedBy || 'Operator',
      },
    }),
  ]);

  if (unit.tenant) {
    await prisma.tenant.update({
      where: { id: unit.tenant.id },
      data: { monthlyRate: current, psf: current / unit.sqft },
    });
  }

  return {
    unit: code,
    previous,
    current,
    changePct,
    effectiveDate: input.effectiveDate || new Date().toISOString(),
  };
}

// P1 item 2: net rental rate per sqft per facility — computed aggregation over
// Unit.monthlyRate / sqft grouped by branch, over revenue-generating units
// (OCCUPIED + OVERDUE, mirroring getSummary's avgPsf). MARKET_PSF stays as a
// read-only reference (per size) alongside the per-size actuals.
export async function getNetPsf() {
  const branches = await prisma.branch.findMany({
    include: {
      units: {
        where: { deletedAt: null },
        select: { status: true, sqft: true, monthlyRate: true, size: { select: { code: true } } },
      },
    },
    orderBy: { code: 'asc' },
  });

  const sizeAgg: Record<string, { total: number; count: number }> = {};
  const facilities = branches.map((b) => {
    const revenue = b.units.filter((u) => u.status === 'OCCUPIED' || u.status === 'OVERDUE');
    for (const u of revenue) {
      if (!u.sqft) continue;
      const psf = toNum(u.monthlyRate) / u.sqft;
      const key = u.size.code;
      sizeAgg[key] ??= { total: 0, count: 0 };
      sizeAgg[key].total += psf;
      sizeAgg[key].count += 1;
    }
    const netPsf = revenue.length
      ? revenue.reduce((s, u) => s + (u.sqft ? toNum(u.monthlyRate) / u.sqft : 0), 0) /
        revenue.length
      : 0;
    const totalSqft = b.units.reduce((s, u) => s + u.sqft, 0);
    return {
      branch: b.code,
      name: b.name,
      units: revenue.length,
      totalUnits: b.units.length,
      totalSqft,
      mrr: Math.round(revenue.reduce((s, u) => s + toNum(u.monthlyRate), 0)),
      netPsf: Math.round(netPsf * 100) / 100,
    };
  });

  const counted = facilities.reduce((s, f) => s + f.units, 0);
  const portfolioNetPsf = counted
    ? Math.round(
        (facilities.reduce((s, f) => s + f.netPsf * f.units, 0) / counted) * 100,
      ) / 100
    : 0;

  return {
    portfolioNetPsf,
    // Reference only — never used as a rate input.
    marketPsf: { ...MARKET_PSF },
    bySize: Object.entries(sizeAgg).map(([code, a]) => ({
      code,
      actualPsf: Math.round((a.total / a.count) * 100) / 100,
      marketPsf: MARKET_PSF[code] ?? null,
    })),
    facilities,
  };
}
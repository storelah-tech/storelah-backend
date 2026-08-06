import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';

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
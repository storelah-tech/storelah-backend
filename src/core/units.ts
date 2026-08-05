import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { Prisma, UnitStatus } from '@prisma/client';

type UnitWithRelations = Prisma.UnitGetPayload<{
  include: { size: true; branch: true; floor: true; tenant: true };
}>;

export interface CreateUnitInput {
  branchId: string;
  floorId: string;
  sizeId: string;
  sqft: number;
  monthlyRate: number;
  status?: UnitStatus;
  climateControl?: string;
}

export interface UpdateUnitInput {
  sqft?: number;
  monthlyRate?: number;
  status?: UnitStatus;
  climateControl?: string | null;
}

function serializeUnit(u: UnitWithRelations) {
  const rate = toNum(u.monthlyRate);
  return {
    id: u.id,
    code: u.unitCode,
    unitCode: u.unitCode,
    sqft: u.sqft,
    rate,
    psf: u.sqft ? rate / u.sqft : 0,
    status: u.status,
    climateControl: u.climateControl,
    branchId: u.branchId,
    floorId: u.floorId,
    sizeId: u.sizeId,
    size: u.size,
    branch: u.branch,
    floor: u.floor,
    tenant: u.tenant,
  };
}

export async function listUnits() {
  const units = await prisma.unit.findMany({
    include: { size: true, branch: true, floor: true, tenant: true },
    orderBy: { unitCode: 'asc' },
  });
  return units.map(serializeUnit);
}

export interface PublicUnitsQuery {
  branch?: string;
  level?: number;
  status?: 'AVAILABLE' | 'RESERVED';
}

const BROWSEABLE_STATUSES: UnitStatus[] = ['AVAILABLE', 'RESERVED'];

// Customer-facing unit listing: only browseable statuses, no tenant/PII anywhere.
export async function listPublicUnits(query: PublicUnitsQuery = {}) {
  const statuses = query.status ? [query.status] : BROWSEABLE_STATUSES;
  const units = await prisma.unit.findMany({
    where: {
      status: { in: statuses },
      ...(query.branch ? { branch: { code: query.branch } } : {}),
      ...(query.level != null ? { floor: { level: query.level } } : {}),
    },
    include: { size: true, branch: true, floor: true },
    orderBy: { unitCode: 'asc' },
  });

  const publicUnits = units.map((u) => {
    const rate = toNum(u.monthlyRate);
    return {
      id: u.id,
      code: u.unitCode,
      unitCode: u.unitCode,
      sqft: u.sqft,
      rate,
      psf: u.sqft ? rate / u.sqft : 0,
      status: u.status,
      climateControl: u.climateControl,
      size: { code: u.size.code, name: u.size.name },
      branch: { code: u.branch.code, name: u.branch.name },
      floor: { level: u.floor.level },
    };
  });

  return {
    units: publicUnits,
    branches: [...new Set(publicUnits.map((u) => u.branch.code))],
  };
}

export async function createUnit(input: CreateUnitInput) {
  const [branch, floor, size] = await Promise.all([
    prisma.branch.findUnique({ where: { id: input.branchId } }),
    prisma.floor.findUnique({ where: { id: input.floorId } }),
    prisma.unitSize.findUnique({ where: { id: input.sizeId } }),
  ]);
  if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  if (!floor) throw new AppError(400, 'VALIDATION', `Floor ${input.floorId} not found`);
  if (!size) throw new AppError(400, 'VALIDATION', `Unit size ${input.sizeId} not found`);

  const existing = await prisma.unit.count({ where: { branchId: input.branchId, floorId: input.floorId } });
  const seq = String(existing + 1).padStart(2, '0');
  const unitCode = `${branch.code}-${String(floor.level).padStart(2, '0')}-${seq}`;

  const unit = await prisma.unit.create({
    data: {
      branchId: input.branchId,
      floorId: input.floorId,
      sizeId: input.sizeId,
      unitCode,
      sqft: input.sqft,
      monthlyRate: input.monthlyRate,
      status: input.status ?? 'AVAILABLE',
      climateControl: input.climateControl,
    },
    include: { size: true, branch: true, floor: true, tenant: true },
  });
  return serializeUnit(unit);
}

export async function updateUnit(code: string, input: UpdateUnitInput) {
  const unit = await prisma.unit.findUnique({ where: { unitCode: code } });
  if (!unit) throw new AppError(404, 'NOT_FOUND', `Unit ${code} not found`);

  const updated = await prisma.unit.update({
    where: { id: unit.id },
    data: {
      sqft: input.sqft,
      monthlyRate: input.monthlyRate,
      status: input.status,
      climateControl: input.climateControl,
    },
    include: { size: true, branch: true, floor: true, tenant: true },
  });
  return serializeUnit(updated);
}

export async function deactivateUnit(code: string) {
  const unit = await prisma.unit.findUnique({ where: { unitCode: code } });
  if (!unit) throw new AppError(404, 'NOT_FOUND', `Unit ${code} not found`);
  if (unit.status === 'OCCUPIED' || unit.status === 'OVERDUE') {
    throw new AppError(409, 'CONFLICT', `Unit ${code} is ${unit.status} and cannot be deactivated`);
  }
  const updated = await prisma.unit.update({
    where: { id: unit.id },
    data: { status: 'INACTIVE' },
    include: { size: true, branch: true, floor: true, tenant: true },
  });
  return serializeUnit(updated);
}

export async function getUnitMap(branchCode: string, level: number, opts?: { public?: boolean }) {
  const isPublic = opts?.public ?? false;
  const units = await prisma.unit.findMany({
    where: { branch: { code: branchCode }, floor: { level } },
    include: { size: true, tenant: true },
    orderBy: { unitCode: 'asc' },
  });

  const legend = {
    occupied: units.filter((u) => u.status === 'OCCUPIED').length,
    available: units.filter((u) => u.status === 'AVAILABLE').length,
    reserved: units.filter((u) => u.status === 'RESERVED').length,
    overdue: units.filter((u) => u.status === 'OVERDUE').length,
    maintenance: units.filter((u) => u.status === 'MAINTENANCE').length,
  };

  return {
    branch: branchCode,
    level,
    legend,
    units: units.map((u) => ({
      id: u.unitCode,
      code: u.unitCode,
      short: u.unitCode.split('-').slice(1).join('-'),
      size: u.size.name,
      psf: u.sqft ? toNum(u.monthlyRate) / u.sqft : 0,
      rate: toNum(u.monthlyRate),
      sqft: u.sqft,
      status: u.status.toLowerCase(),
      // Public view must never expose tenant names / PII.
      ...(isPublic ? {} : { tenant: u.tenant?.name ?? null }),
    })),
  };
}

export async function getUnitDetail(code: string) {
  const unit = await prisma.unit.findUnique({
    where: { unitCode: code },
    include: {
      size: true,
      branch: true,
      floor: true,
      tenant: true,
      rateHistory: { orderBy: { date: 'desc' } },
    },
  });
  if (!unit) throw new AppError(404, 'NOT_FOUND', `Unit ${code} not found`);

  return {
    id: unit.unitCode,
    code: unit.unitCode,
    size: unit.size.name,
    sizeCode: unit.size.code,
    sqft: unit.sqft,
    rate: toNum(unit.monthlyRate),
    psf: unit.sqft ? toNum(unit.monthlyRate) / unit.sqft : 0,
    status: unit.status.toLowerCase(),
    branch: unit.branch.name,
    branchCode: unit.branch.code,
    level: unit.floor.level,
    climateControl: unit.climateControl,
    tenant: unit.tenant
      ? {
          name: unit.tenant.name,
          type: unit.tenant.type,
          segment: unit.tenant.segment,
          monthlyRate: toNum(unit.tenant.monthlyRate),
          psf: toNum(unit.tenant.psf),
          since: unit.tenant.moveInDate,
          nextPayment: unit.tenant.nextPayment,
          lifetimeValue: toNum(unit.tenant.lifetimeValue),
          payments: unit.tenant.paymentCount,
          missed: unit.tenant.missedPayments,
          autoDebit: unit.tenant.autoDebit,
        }
      : null,
    rateHistory: unit.rateHistory.map((r) => ({
      date: r.date,
      previous: toNum(r.previous),
      current: toNum(r.current),
      changePct: toNum(r.changePct, 1),
      reason: r.reason,
      by: r.appliedBy,
    })),
  };
}
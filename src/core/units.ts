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
  name?: string;
}

export interface UpdateUnitInput {
  sqft?: number;
  monthlyRate?: number;
  status?: UnitStatus;
  climateControl?: string | null;
  name?: string | null;
}

function serializeUnit(u: UnitWithRelations) {
  const rate = toNum(u.monthlyRate);
  return {
    id: u.id,
    code: u.unitCode,
    unitCode: u.unitCode,
    name: u.name ?? u.unitCode,
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

export async function listUnits(query: UnitListQuery = {}) {
  const page = Math.max(1, query.page ?? 1);
  const perPage = Math.min(200, Math.max(1, query.perPage ?? 25));
  const where: Prisma.UnitWhereInput = {
    ...(query.status ? { status: query.status as UnitStatus } : {}),
    ...(query.branch ? { branch: { code: query.branch } } : {}),
    ...(query.level != null ? { floor: { level: query.level } } : {}),
  };
  const [units, total] = await Promise.all([
    prisma.unit.findMany({
      where,
      include: { size: true, branch: true, floor: true, tenant: true },
      orderBy: { unitCode: 'asc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.unit.count({ where }),
  ]);
  return {
    rows: units.map(serializeUnit),
    meta: {
      count: units.length,
      page,
      perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      total,
    },
  };
}

export interface UnitListQuery {
  page?: number;
  perPage?: number;
  status?: string;
  branch?: string;
  level?: number;
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
      name: u.name ?? u.unitCode,
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

  // Derive the next unitCode from the MAX existing numeric suffix on this branch+floor,
  // not the row count — counts collide when the floor's numbering has gaps (e.g. seed gaps).
  const existingCodes = await prisma.unit.findMany({
    where: { branchId: input.branchId, floorId: input.floorId },
    select: { unitCode: true },
  });
  let maxSeq = 0;
  for (const u of existingCodes) {
    const m = u.unitCode.match(/-(\d+)$/);
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }
  const seq = String(maxSeq + 1).padStart(2, '0');
  const unitCode = `${branch.code}-${String(floor.level).padStart(2, '0')}-${seq}`;

  const unit = await prisma.unit.create({
    data: {
      branchId: input.branchId,
      floorId: input.floorId,
      sizeId: input.sizeId,
      unitCode,
      name: input.name?.trim() || null,
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

  // name is optional display label only: undefined = not provided (leave unchanged),
  // null or empty string = explicit clear (display name falls back to unitCode).
  const data: Prisma.UnitUpdateInput = {
    sqft: input.sqft,
    monthlyRate: input.monthlyRate,
    status: input.status,
    climateControl: input.climateControl,
    ...(input.name !== undefined
      ? { name: input.name === null ? null : input.name.trim() || null }
      : {}),
  };

  const updated = await prisma.unit.update({
    where: { id: unit.id },
    data,
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

// Reference data for the admin units UI: all distinct floors (with branch info).
export async function listFloors() {
  const floors = await prisma.floor.findMany({
    include: { branch: { select: { code: true, name: true } } },
    orderBy: [{ branch: { code: 'asc' } }, { level: 'asc' }],
  });
  return floors.map((f) => ({
    id: f.id,
    branchId: f.branchId,
    branch: f.branch,
    level: f.level,
    name: f.name,
  }));
}

// Reference data for the admin units UI: all UnitSize rows.
export async function listSizes() {
  const sizes = await prisma.unitSize.findMany({ orderBy: { sortOrder: 'asc' } });
  return sizes.map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    sqftFrom: s.sqftFrom,
    sqftTo: s.sqftTo,
    sortOrder: s.sortOrder,
  }));
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
    name: unit.name ?? unit.unitCode,
    branchId: unit.branchId,
    floorId: unit.floorId,
    sizeId: unit.sizeId,
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

// ---------- unit activity feed (dashboard "Latest Unit Activity") ----------

export interface UnitActivityItem {
  type: 'unit_created' | 'unit_updated' | 'rate_change' | 'move_in' | 'booking';
  unitCode: string;
  at: Date;
  message: string;
  unit?: { code: string; size?: string; branch?: string };
  actor?: string;
}

const fmtDollars = (n: number) =>
  '$' + n.toLocaleString('en-US', { maximumFractionDigits: n % 1 === 0 ? 0 : 2 });

// Merges unit-related events (additions, non-rate updates, rate changes, move-ins,
// scheduled move-in bookings) sorted newest-first. Requires Unit.createdAt/updatedAt,
// which the add_crud_timestamps migration backfilled for pre-existing rows.
export async function getUnitActivity(limit = 20) {
  const capped = Math.min(100, Math.max(1, limit));
  const [units, rateChanges, moveIns, bookings] = await Promise.all([
    prisma.unit.findMany({
      include: { size: true, branch: true },
      orderBy: { unitCode: 'asc' },
    }),
    prisma.rateChange.findMany({
      include: { unit: { include: { size: true, branch: true } } },
      orderBy: { date: 'desc' },
    }),
    prisma.tenant.findMany({
      where: { moveInDate: { not: null } },
      include: { unit: { include: { size: true, branch: true } } },
      orderBy: { moveInDate: 'desc' },
    }),
    prisma.booking.findMany({
      include: { tenant: true, unit: { include: { size: true, branch: true } } },
      orderBy: { moveInDate: 'desc' },
    }),
  ]);

  const events: UnitActivityItem[] = [];

  for (const u of units) {
    const unit = { code: u.unitCode, size: u.size.name, branch: u.branch.code };
    events.push({
      type: 'unit_created',
      unitCode: u.unitCode,
      at: u.createdAt,
      message: `New unit ${u.unitCode} added`,
      unit,
    });
    // Non-rate updates only: skip backfilled rows where updatedAt == createdAt.
    if (u.updatedAt && u.createdAt && u.updatedAt.getTime() > u.createdAt.getTime()) {
      events.push({
        type: 'unit_updated',
        unitCode: u.unitCode,
        at: u.updatedAt,
        message: `Unit ${u.unitCode} updated`,
        unit,
      });
    }
  }

  for (const rc of rateChanges) {
    const u = rc.unit;
    events.push({
      type: 'rate_change',
      unitCode: u.unitCode,
      at: rc.date,
      message: `Rate for ${u.unitCode} changed ${fmtDollars(toNum(rc.previous))} → ${fmtDollars(toNum(rc.current))}`,
      actor: rc.appliedBy,
      unit: { code: u.unitCode, size: u.size.name, branch: u.branch.code },
    });
  }

  for (const t of moveIns) {
    if (!t.unit || !t.moveInDate) continue;
    events.push({
      type: 'move_in',
      unitCode: t.unit.unitCode,
      at: t.moveInDate,
      message: `Tenant ${t.name} moved into ${t.unit.unitCode}`,
      unit: { code: t.unit.unitCode, size: t.unit.size.name, branch: t.unit.branch.code },
    });
  }

  for (const b of bookings) {
    if (!b.unit) continue;
    events.push({
      type: 'booking',
      unitCode: b.unit.unitCode,
      at: b.moveInDate,
      message: `Move-in booked for ${b.tenant.name} at ${b.unit.unitCode}`,
      unit: { code: b.unit.unitCode, size: b.unit.size.name, branch: b.unit.branch.code },
    });
  }

  events.sort((a, b) => b.at.getTime() - a.at.getTime() || a.unitCode.localeCompare(b.unitCode));
  return events.slice(0, capped);
}
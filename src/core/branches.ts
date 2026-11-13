import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { Prisma } from '@prisma/client';
import { quantizeSqft } from './unitSizing';
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
        // DRAFT = drawn on a floor plan, not yet published (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md D7) — not inventory yet.
        // Excluded in JS below, NOT in this where clause: sending the DRAFT
        // literal as query input throws `Invalid value for argument 'not'.
        // Expected UnitStatus` on any runtime whose generated Prisma client
        // predates the DRAFT enum value (migration 20261014000000). Filtering
        // post-fetch keeps the result identical on old and new clients.
        where: { deletedAt: null },
        select: { status: true, sqft: true, monthlyRate: true },
      },
    },
    orderBy: { code: 'asc' },
  });

  return branches.map((b) => {
    // Draft-plan units are not inventory yet (see where clause above).
    const units = b.units.filter((u) => u.status !== 'DRAFT');
    // Decimal sqft: round sums to 0.01 so float noise never surfaces.
    const totalSqft = quantizeSqft(units.reduce((s, u) => s + u.sqft, 0));
    const leasedSqft = quantizeSqft(
      units.filter((u) => LEASED_STATUSES.includes(u.status)).reduce((s, u) => s + u.sqft, 0),
    );
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
      description: b.description,
      operatingHours: b.operatingHours,
      status: b.status,
      multiLevel: b.multiLevel,
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
// one fetch for the admin portfolio view. Computed only. Only ACTIVE
// facilities list here: an INACTIVE branch is retired (hidden from every
// public read — see listPublicBranches) and must not inflate portfolio
// totals. GET /branches (listBranches above, unfiltered) remains the
// management surface where INACTIVE facilities stay visible. meta reports
// how many were excluded so the UI can say so honestly.
export async function getPortfolio() {
  const all = await listBranches();
  const facilities = all.filter((f) => f.status === 'ACTIVE');
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
    meta: { excludedInactive: all.length - facilities.length },
  };
}

// Customer-facing branch list: no internal counters, only availability.
// ACTIVE branches only — an INACTIVE branch (plus its floors/units) is hidden
// from the frontend entirely. Inactive floors contribute nothing: the floor
// list holds active levels only and availableUnits counts live AVAILABLE units
// on active floors (previously unfiltered — soft-deleted units and
// inactive-floor units leaked into the count). See docs/FLOORS.md.
export async function listPublicBranches() {
  const branches = await prisma.branch.findMany({
    where: { status: 'ACTIVE' },
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
    multiLevel: b.multiLevel,
    floors: b.floors.map((f) => f.level),
    availableUnits: b.units.length,
  }));
}

export async function getMoveIns(opts?: { from?: Date; to?: Date }) {
  // Default: ALL move-ins (no date restriction). An explicit from/to narrows
  // the window to Booking.moveInDate (the CMS move-ins table uses this for
  // its date-range filter).
  const range: { gte?: Date; lte?: Date } | undefined =
    opts?.from || opts?.to
      ? { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) }
      : undefined;

  const bookings = await prisma.booking.findMany({
    where: { ...(range ? { moveInDate: range } : {}) },
    include: { tenant: true, unit: { include: { size: true, branch: true } } },
    orderBy: { moveInDate: 'asc' },
  });

  // Same enriched shape as GET /bookings (shared serializer in core/finance.ts).
  return serializeBookings(bookings);
}

// --- Branch (facility) CRUD for Global Settings (CMS-only) ---
//
// Branch.code is IMMUTABLE after create: it is embedded in Unit.unitCode and
// door/asset codes, so a rename would orphan those references. The route
// schema never accepts `code` on update and the core guard below rejects it
// defensively. Preferred safe path for retiring a facility is status INACTIVE
// (hides it from every public read — see listPublicBranches); DELETE is the
// hard path and is blocked while any Floor/Unit/Tenant/Lead/Appointment rows
// reference the branch (409, matching the deleteFloor guard pattern).
//
// ONE-TIME EXCEPTION (2026-11, canonical rename SW → SS for Sembawang):
// the data migration renamed the stored Branch row (SW → SS) and legacy
// unit codes (SW-01-01 → SS-01-01) in place. Do NOT reopen `code` on update —
// updateBranchSchema stays strict and the core guard below still rejects
// `code`. On reads, the deprecated alias SW keeps resolving to SS (see
// canonicalBranchCode) during transition.

export interface CreateBranchInput {
  code: string;
  name: string;
  address: string;
  operatingHours: string;
  description?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
  /** Site type (default single-level). */
  multiLevel?: boolean;
  /** Single-level sites: the real building level of the one floor (e.g. 6). */
  floorLevel?: number;
}

export interface UpdateBranchInput {
  name?: string;
  address?: string;
  operatingHours?: string;
  description?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
  multiLevel?: boolean;
  floorLevel?: number;
}

const BRANCH_CODE_RE = /^[A-Z0-9]{2,8}$/;

/**
 * Canonical facility code for reads. SW is the deprecated alias for
 * Sembawang (canonically SS since the 2026-11 rename): every branchCode
 * read path maps SW → SS before lookup, so `?branch=SW` keeps resolving
 * during transition. Writes must use the canonical code.
 */
export function canonicalBranchCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  return code === 'SW' ? 'SS' : code;
}

function normalizeBranchCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!BRANCH_CODE_RE.test(code)) {
    throw new AppError(
      400,
      'VALIDATION',
      `Branch code must be 2..8 uppercase letters/digits (e.g. SS, WD, UB) — got ${JSON.stringify(raw)}`,
    );
  }
  return code;
}

function serializeBranchRow(
  b: Prisma.BranchGetPayload<{ include: { _count: { select: { floors: true; units: true } } } }>,
) {
  return {
    id: b.id,
    code: b.code,
    name: b.name,
    address: b.address,
    description: b.description,
    operatingHours: b.operatingHours,
    status: b.status,
    multiLevel: b.multiLevel,
    floorCount: b._count.floors,
    unitCount: b._count.units,
  };
}

const branchWithCounts = {
  _count: { select: { floors: true, units: true } },
} as const;

function checkLevel(level: number): number {
  if (!Number.isInteger(level) || level < 1 || level > 99) {
    throw new AppError(400, 'VALIDATION', 'Floor level must be a whole number 1..99', {
      fieldErrors: { floorLevel: ['Floor level must be a whole number 1..99'] },
    });
  }
  return level;
}

/**
 * Single-level site: keep exactly one active floor, at `floorLevel` when
 * given. No floor yet → create it; one floor at another level → re-level it
 * (units, plan and placements follow, they reference the floor row); more
 * than one active floor → refuse, the operator must deactivate the extras or
 * keep the site multi-level.
 */
async function applySingleLevel(branch: { id: string; name: string }, floorLevel?: number) {
  const level = floorLevel === undefined ? undefined : checkLevel(floorLevel);
  const active = await prisma.floor.findMany({
    where: { branchId: branch.id, isActive: true },
    select: { id: true, level: true, name: true },
    orderBy: { level: 'asc' },
  });
  if (active.length > 1) {
    const levels = active.map((f) => f.level).join(', ');
    throw new AppError(
      400,
      'SINGLE_LEVEL_SITE',
      `${branch.name} has ${active.length} active floors (Levels ${levels}). ` +
        'Deactivate the extra floors in Floors first, or keep it a multi-level site.',
      { activeLevels: active.map((f) => f.level), fieldErrors: { multiLevel: [`${active.length} active floors (Levels ${levels}) — deactivate the extra floors in Floors first`] } },
    );
  }
  if (level === undefined) return;
  const current = active[0];
  if (current && current.level === level) return;
  const clash = await prisma.floor.findUnique({ where: { branchId_level: { branchId: branch.id, level } } });
  if (!current) {
    if (clash) {
      // An inactive floor already sits at that level — re-activate it.
      await prisma.floor.update({ where: { id: clash.id }, data: { isActive: true } });
    } else {
      await prisma.floor.create({ data: { branchId: branch.id, level, name: `Level ${level}` } });
    }
    return;
  }
  if (clash) {
    throw new AppError(
      409,
      'CONFLICT',
      `${branch.name} already has an inactive floor at Level ${level}. Remove it in Floors first, or pick another level.`,
      { fieldErrors: { floorLevel: [`Level ${level} already exists (inactive)`] } },
    );
  }
  const autoName = current.name === `Level ${current.level}`;
  await prisma.floor.update({
    where: { id: current.id },
    data: { level, ...(autoName ? { name: `Level ${level}` } : {}) },
  });
}

export async function createBranch(input: CreateBranchInput) {
  const code = normalizeBranchCode(input.code);
  try {
    const branch = await prisma.branch.create({
      data: {
        code,
        name: input.name.trim(),
        address: input.address.trim(),
        operatingHours: input.operatingHours.trim(),
        description: input.description === undefined ? undefined : input.description?.trim() || null,
        status: input.status ?? 'ACTIVE',
        multiLevel: input.multiLevel ?? false,
        // A single-level site starts with its one floor at the real level.
        ...(!input.multiLevel && input.floorLevel !== undefined
          ? { floors: { create: { level: checkLevel(input.floorLevel), name: `Level ${input.floorLevel}` } } }
          : {}),
      },
      include: branchWithCounts,
    });
    return serializeBranchRow(branch);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(409, 'CONFLICT', `Branch code ${code} already exists`);
    }
    throw e;
  }
}

export async function updateBranch(id: string, input: UpdateBranchInput & { code?: unknown }) {
  // Defensive: code is immutable — the route schema never sends it, but a raw
  // caller attempting a rename gets a 400, never a silent rename.
  if (input.code !== undefined) {
    throw new AppError(400, 'VALIDATION', 'Branch code is immutable after create (it is embedded in unit/door/asset codes)');
  }
  const existing = await prisma.branch.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Branch ${id} not found`);
  const data: Prisma.BranchUpdateInput = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.address !== undefined ? { address: input.address.trim() } : {}),
    ...(input.operatingHours !== undefined ? { operatingHours: input.operatingHours.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.multiLevel !== undefined ? { multiLevel: input.multiLevel } : {}),
  };
  const singleLevel = input.multiLevel === false || (input.multiLevel === undefined && !existing.multiLevel);
  if (singleLevel) await applySingleLevel(existing, input.floorLevel);
  const updated = await prisma.branch.update({
    where: { id },
    data,
    include: branchWithCounts,
  });
  return serializeBranchRow(updated);
}

export interface DeleteBranchOptions {
  // ?deactivate=true converts the delete into a reversible deactivation
  // (sets status=INACTIVE) instead of removing the row — the safe path for
  // branches that still hold floors/units.
  deactivate?: boolean;
}

export async function deleteBranch(id: string, opts: DeleteBranchOptions = {}) {
  const branch = await prisma.branch.findUnique({
    where: { id },
    include: {
      _count: {
        select: { floors: true, units: true, tenants: true, leads: true, appointments: true },
      },
    },
  });
  if (!branch) throw new AppError(404, 'NOT_FOUND', `Branch ${id} not found`);

  if (opts.deactivate) {
    const deactivated = await prisma.branch.update({
      where: { id },
      data: { status: 'INACTIVE' },
      include: branchWithCounts,
    });
    return { ...serializeBranchRow(deactivated), deactivated: true };
  }

  // Guard: never orphan facility history. Floor/Unit rows block the hard
  // delete (tenant/lead/appointment rows reference the branch too, so they
  // block as well). Operators deactivate (PUT status=INACTIVE or
  // DELETE ?deactivate=true) instead.
  const { floors, units, tenants, leads, appointments } = branch._count;
  if (floors > 0 || units > 0 || tenants > 0 || leads > 0 || appointments > 0) {
    throw new AppError(
      409,
      'CONFLICT',
      `Branch ${branch.code} still has ${floors} floor(s), ${units} unit(s), ${tenants} tenant(s), ` +
        `${leads} lead(s) and ${appointments} appointment(s) and cannot be deleted.` +
        ` Deactivate it instead (PUT /branches/${id} { "status": "INACTIVE" } or DELETE ?deactivate=true).`,
      { floorCount: floors, unitCount: units, tenantCount: tenants, leadCount: leads, appointmentCount: appointments },
    );
  }

  await prisma.branch.delete({ where: { id } });
  return { id, deleted: true };
}

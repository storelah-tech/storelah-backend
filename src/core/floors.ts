import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { Prisma } from '@prisma/client';

type FloorWithRelations = Prisma.FloorGetPayload<{
  include: { branch: { select: { id: true; code: true; name: true } } };
}>;

// Floor visibility semantics (see docs/FLOORS.md):
//   isActive = true   → floor + its units appear in PUBLIC reads.
//   isActive = false  → hidden from every public read path, still fully
//                       visible in the CMS admin (with an inactive badge).
// Deactivation is reversible. It is deliberately distinct from deletion:
// floors are never soft-deleted — DELETE hard-deletes and is blocked while
// ANY Unit rows (live or soft-deleted) reference the floor, because Unit
// rows are append-only history (codes are never reused) and the FK has no
// cascade. An inactive floor rejects new units (activate it first).

export interface FloorListQuery {
  branchId?: string;
  includeInactive?: boolean;
}

export interface CreateFloorInput {
  branchId: string;
  level: number;
  name?: string;
}

export interface UpdateFloorInput {
  level?: number;
  name?: string;
  isActive?: boolean;
}

function serializeFloor(
  f: FloorWithRelations & { _count: { units: number } } & {
    liveUnits?: number;
  },
) {
  return {
    id: f.id,
    branchId: f.branchId,
    branch: f.branch,
    level: f.level,
    name: f.name,
    isActive: f.isActive,
    unitCount: f._count.units,
    liveUnitCount: f.liveUnits ?? f._count.units,
  };
}

export async function listFloors(query: FloorListQuery = {}) {
  const floors = await prisma.floor.findMany({
    where: {
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.includeInactive ? {} : { isActive: true }),
    },
    include: {
      branch: { select: { id: true, code: true, name: true } },
      _count: { select: { units: true } },
    },
    orderBy: [{ branch: { code: 'asc' } }, { level: 'asc' }],
  });
  // Live (non-soft-deleted) unit counts per floor for the delete guard UI.
  const live = await prisma.unit.groupBy({
    by: ['floorId'],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const liveByFloor = new Map(live.map((r) => [r.floorId, r._count._all]));
  return floors.map((f) =>
    serializeFloor({ ...f, liveUnits: liveByFloor.get(f.id) ?? 0 }),
  );
}

// Admin reference list (existing GET /floors contract): every floor including
// inactive ones, with the branch join the admin UI already consumes.
// Extended additively with isActive + unit counts — no field removed.
export async function listFloorsAdmin(branchId?: string) {
  return listFloors({ branchId, includeInactive: true });
}

export async function getFloor(id: string) {
  const floor = await prisma.floor.findUnique({
    where: { id },
    include: {
      branch: { select: { id: true, code: true, name: true } },
      _count: { select: { units: true } },
    },
  });
  if (!floor) throw new AppError(404, 'NOT_FOUND', `Floor ${id} not found`);
  const liveUnitCount = await prisma.unit.count({
    where: { floorId: id, deletedAt: null },
  });
  return serializeFloor({ ...floor, liveUnits: liveUnitCount });
}

export async function createFloor(input: CreateFloorInput) {
  const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
  if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  if (!Number.isInteger(input.level) || input.level < 1 || input.level > 99) {
    throw new AppError(400, 'VALIDATION', 'level must be an integer 1..99');
  }
  const name = input.name?.trim() || `Level ${input.level}`;
  try {
    const floor = await prisma.floor.create({
      data: { branchId: input.branchId, level: input.level, name },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        _count: { select: { units: true } },
      },
    });
    return serializeFloor({ ...floor, liveUnits: 0 });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(
        409,
        'CONFLICT',
        `Branch ${branch.code} already has a floor at level ${input.level}`,
      );
    }
    throw e;
  }
}

export async function updateFloor(id: string, input: UpdateFloorInput) {
  const floor = await prisma.floor.findUnique({
    where: { id },
    include: { branch: { select: { code: true } } },
  });
  if (!floor) throw new AppError(404, 'NOT_FOUND', `Floor ${id} not found`);
  if (input.level !== undefined && (!Number.isInteger(input.level) || input.level < 1 || input.level > 99)) {
    throw new AppError(400, 'VALIDATION', 'level must be an integer 1..99');
  }
  // Renaming/re-levelling keeps the auto-derived convention ("Level N") only
  // when the operator leaves the name untouched; an explicit name always wins.
  const data: Prisma.FloorUpdateInput = {
    ...(input.level !== undefined ? { level: input.level } : {}),
    ...(input.name !== undefined ? { name: input.name.trim() || `Level ${input.level ?? floor.level}` } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
  };
  try {
    const updated = await prisma.floor.update({
      where: { id },
      data,
      include: {
        branch: { select: { id: true, code: true, name: true } },
        _count: { select: { units: true } },
      },
    });
    const liveUnitCount = await prisma.unit.count({
      where: { floorId: id, deletedAt: null },
    });
    return serializeFloor({ ...updated, liveUnits: liveUnitCount });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(
        409,
        'CONFLICT',
        `Branch ${floor.branch.code} already has a floor at level ${input.level}`,
      );
    }
    throw e;
  }
}

export interface DeleteFloorOptions {
  // ?deactivate=true converts the delete into a reversible deactivation
  // (sets isActive=false) instead of removing the row — the safe path for
  // floors that still hold units.
  deactivate?: boolean;
}

export async function deleteFloor(id: string, opts: DeleteFloorOptions = {}) {
  const floor = await prisma.floor.findUnique({
    where: { id },
    include: {
      branch: { select: { code: true } },
      _count: { select: { units: true } },
    },
  });
  if (!floor) throw new AppError(404, 'NOT_FOUND', `Floor ${id} not found`);

  if (opts.deactivate) {
    const deactivated = await prisma.floor.update({
      where: { id },
      data: { isActive: false },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        _count: { select: { units: true } },
      },
    });
    const liveUnitCount = await prisma.unit.count({
      where: { floorId: id, deletedAt: null },
    });
    return { ...serializeFloor({ ...deactivated, liveUnits: liveUnitCount }), deactivated: true };
  }

  // Guard: never orphan units and never break the append-only Unit history.
  // The Floor→Unit FK has no cascade and soft-deleted Unit rows still
  // reference the floor, so ANY referencing Unit row blocks the hard delete.
  // Operators deactivate (PUT isActive=false or ?deactivate=true) instead.
  if (floor._count.units > 0) {
    const liveUnitCount = await prisma.unit.count({
      where: { floorId: id, deletedAt: null },
    });
    throw new AppError(
      409,
      'CONFLICT',
      `Floor ${floor.branch.code} level ${floor.level} still has ${liveUnitCount} live unit(s)` +
        ` (${floor._count.units} total incl. soft-deleted) and cannot be deleted.` +
        ` Deactivate it instead (PUT /floors/${id} { "isActive": false } or DELETE ?deactivate=true).`,
      { liveUnitCount, totalUnitCount: floor._count.units },
    );
  }

  // Zero units: hard-delete cascades the plan/placements/snapshots (all
  // onDelete: Cascade) and touches no Unit rows.
  await prisma.floor.delete({ where: { id } });
  return { id, deleted: true };
}

import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { Prisma } from '@prisma/client';

// Floor-plan layout aggregate (see docs/FLOOR_PLAN_MODEL.md).
//
// All geometry is in LOGICAL GRID UNITS (not px): plan width/height and
// placement/block x/y/width/height are abstract grid coordinates; renderers
// scale grid → px at whatever zoom they want.
//
// Single plan per floor (FloorPlan.floorId is @unique). The upsert key for the
// operator editor save is therefore the floorId itself.
//
// Two element types, both subordinate to the plan:
//   - placements (UnitPlacement): real units on the layout;
//   - blocks (FloorPlanBlock): user-authored name+rect decoration rectangles
//     (lifts, stairs, exits, walking areas, ...) — display only, no behaviour.
//     They REPLACE authoring the legacy `structure` JSON markers, which stays
//     readable/writable for old clients and renders statically.
//
// Soft-delete rule: every plan read joins placements → unit and filters out
// placements whose unit has deletedAt != null. Never touch Unit rows.

export const CANVAS_DEFAULTS = { width: 40, height: 30 } as const;
const MAX_CANVAS = 500; // grid units per axis, sanity cap

// Plan payload used by every read; placements exclude soft-deleted units;
// blocks are plain name+rect rows in authored order (stable for the editor).
const planInclude = {
  floor: { include: { branch: true } },
  placements: {
    where: { unit: { deletedAt: null } },
    include: { unit: { include: { size: true } } },
    orderBy: { createdAt: 'asc' },
  },
  blocks: {
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.FloorPlanInclude;

type PlanPayload = Prisma.FloorPlanGetPayload<{ include: typeof planInclude }>;

type PlacementUnit = {
  id: string;
  unitCode: string;
  name: string | null;
  sqft: number;
  status: string;
  size: { code: string; name: string };
};

// ---------- serializers ----------

function serializeUnitSummary(u: PlacementUnit) {
  return {
    id: u.id,
    unitCode: u.unitCode,
    // Optional display label falls back to the immutable unitCode.
    name: u.name ?? u.unitCode,
    sqft: u.sqft,
    status: u.status,
    size: { code: u.size.code, name: u.size.name },
  };
}

function serializePlacement(p: { id: string; x: number; y: number; width: number; height: number; unit: PlacementUnit }) {
  return {
    id: p.id,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    unit: serializeUnitSummary(p.unit),
  };
}

type BlockRow = { id: string; name: string; x: number; y: number; width: number; height: number; color: string | null };

function serializeBlock(b: BlockRow) {
  return {
    id: b.id,
    name: b.name,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    color: b.color,
  };
}

// Public-safe: branch/floor/unit summaries only — no tenant, no PII, no rates.
function serializePlan(p: PlanPayload) {
  return {
    id: p.id,
    floorId: p.floorId,
    width: p.width,
    height: p.height,
    structure: p.structure,
    branch: { id: p.floor.branchId, code: p.floor.branch.code, name: p.floor.branch.name },
    floor: { id: p.floor.id, level: p.floor.level, name: p.floor.name },
    placements: p.placements.map(serializePlacement),
    blocks: p.blocks.map(serializeBlock),
  };
}

// ---------- validation ----------

async function assertFloor(floorId: string) {
  const floor = await prisma.floor.findUnique({ where: { id: floorId }, select: { id: true } });
  if (!floor) throw new AppError(404, 'NOT_FOUND', `Floor ${floorId} not found`);
}

function checkCanvasDim(v: number, axis: 'width' | 'height'): number {
  if (!Number.isInteger(v) || v < 1 || v > MAX_CANVAS) {
    throw new AppError(400, 'VALIDATION', `Canvas ${axis} must be an integer between 1 and ${MAX_CANVAS}`);
  }
  return v;
}

function checkGeometry(g: PlacementGeometry): void {
  const check = (v: number, name: string, min: number) => {
    if (!Number.isInteger(v) || v < min) {
      throw new AppError(400, 'VALIDATION', `${name} must be an integer >= ${min}`);
    }
  };
  check(g.x, 'x', 0);
  check(g.y, 'y', 0);
  check(g.width, 'width', 1);
  check(g.height, 'height', 1);
}

function checkBlockName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) {
    throw new AppError(400, 'VALIDATION', 'Block name must be a non-empty string of at most 80 characters');
  }
  return trimmed;
}

// ---------- API ----------

export interface UpsertFloorPlanInput {
  width?: number;
  height?: number;
  structure?: unknown; // any JSON value (JSONB); null clears it
}

/** Upsert the canvas for a floor: create if absent, then update given fields. */
export async function upsertFloorPlan(floorId: string, input: UpsertFloorPlanInput = {}) {
  await assertFloor(floorId);

  const update: Prisma.FloorPlanUpdateInput = {};
  if (input.width !== undefined) update.width = checkCanvasDim(input.width, 'width');
  if (input.height !== undefined) update.height = checkCanvasDim(input.height, 'height');
  if (input.structure !== undefined) {
    update.structure = input.structure === null ? Prisma.JsonNull : (input.structure as Prisma.InputJsonValue);
  }

  const create: Prisma.FloorPlanCreateInput = {
    floor: { connect: { id: floorId } },
    width: input.width !== undefined ? checkCanvasDim(input.width, 'width') : CANVAS_DEFAULTS.width,
    height: input.height !== undefined ? checkCanvasDim(input.height, 'height') : CANVAS_DEFAULTS.height,
  };
  if (input.structure !== undefined) {
    create.structure = input.structure === null ? Prisma.JsonNull : (input.structure as Prisma.InputJsonValue);
  }

  const plan = await prisma.floorPlan.upsert({
    where: { floorId },
    create,
    update,
    include: planInclude,
  });
  return serializePlan(plan);
}

export interface ListFloorPlansQuery {
  branch?: string; // branch code, e.g. 'BM'
  level?: number; // floor level 1..4
}

/** List plans across branches/floors (optionally filtered), each with placements + unit summaries. */
export async function listFloorPlans(query: ListFloorPlansQuery = {}) {
  const floorFilter: Prisma.FloorWhereInput = {};
  if (query.branch) floorFilter.branch = { code: query.branch };
  if (query.level != null) floorFilter.level = query.level;

  const plans = await prisma.floorPlan.findMany({
    where: { floor: floorFilter },
    include: planInclude,
    orderBy: [{ floor: { branch: { code: 'asc' } } }, { floor: { level: 'asc' } }],
  });
  return plans.map(serializePlan);
}

/**
 * Get THE plan for a floor (its upsert key) with placements joined to
 * unit code/name/size/status (soft-deleted units filtered out), plus the
 * floor's unplaced units. If no plan exists yet, returns an empty scaffold
 * so an editor can start fresh — callers decide how to present it.
 */
export async function getFloorPlan(floorId: string) {
  const floor = await prisma.floor.findUnique({ where: { id: floorId }, include: { branch: true } });
  if (!floor) throw new AppError(404, 'NOT_FOUND', `Floor ${floorId} not found`);

  const plan = await prisma.floorPlan.findFirst({ where: { floorId }, include: planInclude });
  const unplacedUnits = await prisma.unit.findMany({
    where: { floorId, deletedAt: null, placement: { is: null } },
    include: { size: true },
    orderBy: { unitCode: 'asc' },
  });

  return {
    plan: plan ? serializePlan(plan) : null,
    canvasDefaults: CANVAS_DEFAULTS,
    floor: { id: floor.id, level: floor.level, name: floor.name },
    branch: { id: floor.branchId, code: floor.branch.code, name: floor.branch.name },
    unplacedUnits: unplacedUnits.map(serializeUnitSummary),
  };
}

export interface PlacementGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Lazy-initialize the plan for a floor if an operator drops the first unit/block
// before ever saving a canvas: create it at the default canvas size so geometry
// always has a surface to land on (the editor snap-clamps; the canvas can be
// resized afterwards via POST /floor-plans/:floorId). Also promotes a plan whose
// canvas is still at the zero-size schema default to a renderable size.
async function ensureCanvasPlan(floorId: string) {
  await assertFloor(floorId);
  let plan = await prisma.floorPlan.findUnique({ where: { floorId } });
  if (!plan) {
    plan = await prisma.floorPlan.create({
      data: { floorId, width: CANVAS_DEFAULTS.width, height: CANVAS_DEFAULTS.height, structure: Prisma.JsonNull },
    });
  } else if (plan.width <= 0 || plan.height <= 0) {
    plan = await prisma.floorPlan.update({
      where: { id: plan.id },
      data: { width: CANVAS_DEFAULTS.width, height: CANVAS_DEFAULTS.height },
    });
  }
  return plan;
}

/**
 * Upsert one unit placement keyed by unitId + floorPlanId. Validates the unit
 * belongs to the plan's floor and is not soft-deleted, and that the geometry
 * fits inside the canvas. Never touches the Unit row.
 */
export async function setUnitPlacement(floorId: string, unitId: string, geom: PlacementGeometry) {
  checkGeometry(geom);

  const unit = await prisma.unit.findUnique({ where: { id: unitId }, include: { size: true } });
  if (!unit) throw new AppError(404, 'NOT_FOUND', `Unit ${unitId} not found`);
  if (unit.deletedAt) {
    throw new AppError(400, 'VALIDATION', `Unit ${unit.unitCode} is deleted and cannot be placed on a plan`);
  }
  if (unit.floorId !== floorId) {
    throw new AppError(400, 'VALIDATION', `Unit ${unit.unitCode} does not belong to floor ${floorId}`);
  }

  const plan = await ensureCanvasPlan(floorId);

  if (geom.x + geom.width > plan.width || geom.y + geom.height > plan.height) {
    throw new AppError(
      400,
      'VALIDATION',
      `Placement ${geom.x},${geom.y} ${geom.width}×${geom.height} exceeds the ${plan.width}×${plan.height} canvas for floor ${floorId} — enlarge the canvas first`,
    );
  }

  const placement = await prisma.unitPlacement.upsert({
    where: { unitId },
    create: { floorPlanId: plan.id, unitId, x: geom.x, y: geom.y, width: geom.width, height: geom.height },
    update: { x: geom.x, y: geom.y, width: geom.width, height: geom.height },
    include: { unit: { include: { size: true } } },
  });
  return serializePlacement(placement);
}

/** Remove a unit's placement (geometry only — never soft-deletes the Unit). */
export async function removeUnitPlacement(floorId: string, unitId: string) {
  const plan = await prisma.floorPlan.findUnique({ where: { floorId } });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `No floor plan exists for floor ${floorId}`);
  const placement = await prisma.unitPlacement.findUnique({ where: { unitId } });
  if (!placement || placement.floorPlanId !== plan.id) {
    throw new AppError(404, 'NOT_FOUND', `Unit ${unitId} has no placement on the floor ${floorId} plan`);
  }
  await prisma.unitPlacement.delete({ where: { unitId } });
  return { floorId, unitId, removed: true };
}

export interface BlockInput {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string | null; // optional render tint (hex); renderers default when null
}

/**
 * Create a layout-decoration block on a floor's plan. Blocks are plain name+rect
 * primitives (no polymorphism like the legacy `structure` markers), so each one
 * is its own row — addressable for drag/resize/rename/delete.
 */
export async function createFloorPlanBlock(floorId: string, input: BlockInput) {
  checkBlockName(input.name);
  checkGeometry(input);
  const plan = await ensureCanvasPlan(floorId);
  if (input.x + input.width > plan.width || input.y + input.height > plan.height) {
    throw new AppError(
      400,
      'VALIDATION',
      `Block ${input.x},${input.y} ${input.width}×${input.height} exceeds the ${plan.width}×${plan.height} canvas for floor ${floorId} — enlarge the canvas first`,
    );
  }
  const block = await prisma.floorPlanBlock.create({
    data: {
      floorPlanId: plan.id,
      name: input.name.trim(),
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      color: input.color ?? null,
    },
  });
  return serializeBlock(block);
}

/**
 * Set/upsert a block scoped to a floor's plan: if a block with the given id
 * exists ON THIS plan it is updated (drag / resize / rename persistence); a
 * fresh client-chosen id for a block that does not exist creates it. A block id
 * belonging to a DIFFERENT plan is rejected (never touched cross-plan).
 */
export async function setFloorPlanBlock(floorId: string, blockId: string, input: BlockInput) {
  checkBlockName(input.name);
  checkGeometry(input);
  const plan = await ensureCanvasPlan(floorId);
  if (input.x + input.width > plan.width || input.y + input.height > plan.height) {
    throw new AppError(
      400,
      'VALIDATION',
      `Block ${input.x},${input.y} ${input.width}×${input.height} exceeds the ${plan.width}×${plan.height} canvas for floor ${floorId} — enlarge the canvas first`,
    );
  }

  const existing = await prisma.floorPlanBlock.findUnique({ where: { id: blockId } });
  if (existing) {
    if (existing.floorPlanId !== plan.id) {
      throw new AppError(404, 'NOT_FOUND', `Block ${blockId} does not belong to floor ${floorId}'s plan`);
    }
    const block = await prisma.floorPlanBlock.update({
      where: { id: blockId },
      data: {
        name: input.name.trim(),
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        color: input.color ?? null,
      },
    });
    return serializeBlock(block);
  }

  const block = await prisma.floorPlanBlock.create({
    data: {
      id: blockId,
      floorPlanId: plan.id,
      name: input.name.trim(),
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      color: input.color ?? null,
    },
  });
  return serializeBlock(block);
}

/** Remove a layout-decoration block (scoped to the plan; cross-plan ids 404). */
export async function removeFloorPlanBlock(floorId: string, blockId: string) {
  const plan = await prisma.floorPlan.findUnique({ where: { floorId } });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `No floor plan exists for floor ${floorId}`);
  const block = await prisma.floorPlanBlock.findUnique({ where: { id: blockId } });
  if (!block || block.floorPlanId !== plan.id) {
    throw new AppError(404, 'NOT_FOUND', `Block ${blockId} does not belong to floor ${floorId}'s plan`);
  }
  await prisma.floorPlanBlock.delete({ where: { id: blockId } });
  return { floorId, blockId, removed: true };
}

/** Delete the plan for a floor (cascades its placements; Unit rows untouched). */
export async function deleteFloorPlan(floorId: string) {
  const plan = await prisma.floorPlan.findUnique({ where: { floorId } });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `No floor plan exists for floor ${floorId}`);
  await prisma.floorPlan.delete({ where: { id: plan.id } });
  return { floorId, deleted: true };
}

// ---------- public read (forward compatibility, see FLOOR_PLAN_MODEL.md) ----------

/**
 * PUBLIC read of a floor's plan for the booking renderer: canvas + legacy
 * structure + blocks (name+rect) + placements joined to unit
 * unitCode/name/size/status, soft-deleted units filtered out. No tenant/PII/rates
 * anywhere (serializePlan is public-safe).
 */
export async function getPublicFloorPlan(branchCode: string, level: number) {
  const floor = await prisma.floor.findFirst({
    where: { branch: { code: branchCode }, level },
    include: { branch: true },
  });
  if (!floor) throw new AppError(404, 'NOT_FOUND', `Floor ${level} not found at branch ${branchCode}`);

  const plan = await prisma.floorPlan.findFirst({ where: { floorId: floor.id }, include: planInclude });
  return {
    branch: { id: floor.branchId, code: floor.branch.code, name: floor.branch.name },
    floor: { id: floor.id, level: floor.level, name: floor.name },
    plan: plan ? serializePlan(plan) : null,
  };
}
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { Prisma } from '@prisma/client';
import {
  CANVAS_DEFAULTS,
  FP_MARKER_KINDS,
  MAX_GFA_SQFT,
  boundaryPointsOf,
  normalizeDoorEdges,
  publishFloorPlan,
} from './floorPlans';

// Floor-plan draft versions (see docs/FLOOR_PLAN_MODEL.md "Draft versions").
//
// The live FloorPlan stays single-per-floor (the working copy the editor
// mutates); a draft is an IMMUTABLE JSON snapshot of the whole canvas frozen
// as version N for that floor. Snapshots are JSONB, not relational copies:
// canvas geometry is only ever consumed as a whole by the renderer/editor and
// is never queried per element (same presentational-geometry argument as the
// legacy `structure` JSON), and relational copies would explode the FK graph
// (UnitPlacement.unitId is @unique, so a second live copy per version is
// impossible without shadow tables).
//
// Snapshot shapes mirror the editor's normalized shapes (see
// fpNormalizePlacements/fpNormalizeBlocks/fpNormalizeBoundaries/
// fpNormalizeMarkers in src/cms/admin/floorplanView.js) so a draft can be
// rendered by the read-only preview with zero translation. Row ids ride along
// for traceability only — publish mints fresh live rows and never reuses them.
//
// Drafts are CMS-only: the public booking read resolves the ACTIVE FloorPlan
// and never touches FloorPlanDraft, so drafts can never leak to booking.
// Publishing a draft copies its snapshot into the live FloorPlan (wholesale
// replace — placements added after the snapshot are removed) and then walks
// DRAFT → ACTIVE via the existing publishFloorPlan path; the single-plan
// publish flow is untouched.

const MAX_CANVAS = 500; // feet per axis, same sanity cap as the live canvas

export interface DraftPlacementSnapshot {
  unitId: string;
  unitCode: string;
  name: string | null;
  sizeCode: string;
  sizeName: string;
  sqft: number;
  status: string;
  hasAC: boolean;
  hasPillar: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  stackTier: 0 | 1;
  doorEdges: string[] | null;
}

export interface DraftBlockSnapshot {
  id?: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string | null;
  doorEdges: string[] | null;
}

export interface DraftBoundarySnapshot {
  id?: string;
  label: string;
  kind: string;
  points: Array<[number, number]>;
  closed: boolean;
  sortOrder: number;
}

export interface DraftMarkerSnapshot {
  id?: string;
  kind: string;
  label: string | null;
  x: number;
  y: number;
}

// Canvas payload for a draft save. Every field is OPTIONAL: omitted fields
// fall back to the live plan's current values, so POST {} freezes the working
// copy as a new version. Explicit arrays REPLACE the fallback wholesale
// (there is no per-element merge — a draft is a whole-canvas freeze).
export interface SaveDraftInput {
  width?: number;
  height?: number;
  structure?: unknown; // any JSON value (JSONB); null clears it
  gfaSqft?: number | null;
  placements?: DraftPlacementInput[];
  blocks?: DraftBlockInput[];
  boundaries?: DraftBoundaryInput[];
  markers?: DraftMarkerInput[];
  createdBy?: string | null;
}

export interface DraftPlacementInput {
  unitId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  stackTier?: number;
  doorEdges?: string[] | null;
}

export interface DraftBlockInput {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string | null;
  doorEdges?: string[] | null;
}

export interface DraftBoundaryInput {
  label?: string;
  kind?: string | null;
  points: unknown;
  closed?: boolean;
  sortOrder?: number | null;
}

export interface DraftMarkerInput {
  kind: string;
  label?: string | null;
  x: number;
  y: number;
}

// ---------- validation (mirrors the live-canvas rules, minus overlap/area) ----------
//
// Draft saves enforce membership + shape + canvas-fit (a draft that cannot be
// published is a broken promise), but NOT the overlap guard or the ±15%
// area-vs-sqft rule — drafts are free-form design snapshots and the
// interactive editor already enforces those on the live canvas. Publish
// re-checks membership + fit (units may have moved on since the save).

function checkDraftDim(v: number, axis: 'width' | 'height'): number {
  if (!Number.isInteger(v) || v < 1 || v > MAX_CANVAS) {
    throw new AppError(400, 'VALIDATION', `Canvas ${axis} must be an integer between 1 and ${MAX_CANVAS}`);
  }
  return v;
}

function checkDraftRect(g: { x: number; y: number; width: number; height: number }, what: string): void {
  for (const [v, name, min] of [[g.x, 'x', 0], [g.y, 'y', 0], [g.width, 'width', 1], [g.height, 'height', 1]] as const) {
    if (!Number.isInteger(v) || (v as number) < min) {
      throw new AppError(400, 'VALIDATION', `Draft ${what} ${name} must be an integer >= ${min}`);
    }
  }
}

function checkDraftFit(
  g: { x: number; y: number; width: number; height: number },
  plan: { width: number; height: number },
  what: string,
): void {
  if (g.x + g.width > plan.width || g.y + g.height > plan.height) {
    throw new AppError(
      400,
      'VALIDATION',
      `Draft ${what} ${g.x},${g.y} ${g.width}×${g.height} exceeds the ${plan.width}×${plan.height} ft draft canvas — enlarge the canvas first`,
    );
  }
}

function checkDraftGfa(v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_GFA_SQFT) {
    throw new AppError(400, 'VALIDATION', `GFA must be a positive number of sqft (up to ${MAX_GFA_SQFT}) — got ${JSON.stringify(v)}`);
  }
  return Math.round(v * 10) / 10;
}

function asSnapshotArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

// ---------- serializers ----------

type DraftRow = Prisma.FloorPlanDraftGetPayload<{ include: { floor: { include: { branch: true } } } }>;

function serializeDraftSummary(d: DraftRow) {
  const placements = asSnapshotArray(d.placements);
  const blocks = asSnapshotArray(d.blocks);
  const boundaries = asSnapshotArray(d.boundaries);
  const markers = asSnapshotArray(d.markers);
  return {
    id: d.id,
    floorId: d.floorId,
    version: d.version,
    // DRAFT = saved design snapshot; ACTIVE = this version was published to
    // the live plan (informational — the live FloorPlan carries the real state).
    status: d.status,
    width: d.width,
    height: d.height,
    gfaSqft: d.gfaSqft ?? null,
    counts: {
      placements: placements.length,
      blocks: blocks.length,
      boundaries: boundaries.length,
      markers: markers.length,
    },
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function serializeDraft(d: DraftRow) {
  return {
    ...serializeDraftSummary(d),
    structure: (d.structure ?? null) as unknown,
    placements: asSnapshotArray<DraftPlacementSnapshot>(d.placements),
    blocks: asSnapshotArray<DraftBlockSnapshot>(d.blocks),
    boundaries: asSnapshotArray<DraftBoundarySnapshot>(d.boundaries),
    markers: asSnapshotArray<DraftMarkerSnapshot>(d.markers),
    floor: { id: d.floor.id, level: d.floor.level, name: d.floor.name },
    branch: { id: d.floor.branchId, code: d.floor.branch.code, name: d.floor.branch.name },
  };
}

// ---------- API ----------

/**
 * Freeze the floor's canvas as a new draft version (max+1 per floor).
 * Omitted fields fall back to the live plan's current values, so POST {}
 * snapshots the working copy as-is. Explicit geometry is validated for
 * membership (unit exists, belongs to the floor, not soft-deleted, not
 * INACTIVE) + shape + canvas-fit; overlap/area rules are live-canvas-only.
 * Never touches the live FloorPlan. 409-safe: a version race retries once.
 */
export async function saveDraft(floorId: string, input: SaveDraftInput = {}) {
  const floor = await prisma.floor.findUnique({ where: { id: floorId } });
  if (!floor) throw new AppError(404, 'NOT_FOUND', `Floor ${floorId} not found`);

  const live = await prisma.floorPlan.findUnique({
    where: { floorId },
    include: {
      placements: { include: { unit: { include: { size: true } } } },
      blocks: true,
      boundaries: true,
      markers: true,
    },
  });

  const width = input.width !== undefined ? checkDraftDim(input.width, 'width') : (live?.width || CANVAS_DEFAULTS.width);
  const height = input.height !== undefined ? checkDraftDim(input.height, 'height') : (live?.height || CANVAS_DEFAULTS.height);
  const canvas = { width, height };

  const structure =
    input.structure !== undefined
      ? input.structure
      : ((live?.structure ?? null) as unknown);
  const gfaSqft =
    input.gfaSqft !== undefined ? (input.gfaSqft === null ? null : checkDraftGfa(input.gfaSqft)) : (live?.gfaSqft ?? null);

  // Placements: explicit array replaces the live fallback wholesale. Each
  // entry resolves against its Unit row (denormalized into the snapshot so a
  // draft stays self-describing for the read-only preview).
  let placements: DraftPlacementSnapshot[];
  if (input.placements !== undefined) {
    if (!Array.isArray(input.placements)) throw new AppError(400, 'VALIDATION', 'Draft placements must be an array');
    placements = [];
    for (const p of input.placements) {
      checkDraftRect(p, 'placement');
      checkDraftFit(p, canvas, 'placement');
      const tier = p.stackTier === undefined ? 0 : p.stackTier;
      if (tier !== 0 && tier !== 1) {
        throw new AppError(400, 'VALIDATION', `Draft placement stackTier must be 0 or 1 — got ${tier}`);
      }
      // Validates the compass subset (400 outside N/S/E/W); snapshots keep the
      // authored ARRAY form the preview consumes (publish re-encodes to CSV).
      const doorCsv = normalizeDoorEdges(p.doorEdges);
      const doorArr = doorCsv == null ? null : String(doorCsv).split(',');
      const unit = await prisma.unit.findUnique({ where: { id: p.unitId }, include: { size: true } });
      if (!unit) throw new AppError(404, 'NOT_FOUND', `Unit ${p.unitId} not found`);
      if (unit.floorId !== floorId) {
        throw new AppError(400, 'VALIDATION', `Unit ${unit.unitCode} does not belong to floor ${floorId}`);
      }
      if (unit.deletedAt) {
        throw new AppError(400, 'VALIDATION', `Unit ${unit.unitCode} is deleted and cannot be snapshotted into a draft`);
      }
      if (unit.status === 'INACTIVE') {
        throw new AppError(400, 'VALIDATION', `Unit ${unit.unitCode} is INACTIVE and cannot be snapshotted into a draft — reactivate it first`);
      }
      placements.push({
        unitId: unit.id,
        unitCode: unit.unitCode,
        name: unit.name,
        sizeCode: unit.size.code,
        sizeName: unit.size.name,
        sqft: unit.sqft,
        status: unit.status,
        hasAC: unit.hasAC,
        hasPillar: unit.hasPillar,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        stackTier: tier as 0 | 1,
        doorEdges: doorArr,
      });
    }
  } else {
    placements = (live?.placements ?? []).map((p) => ({
      unitId: p.unit.id,
      unitCode: p.unit.unitCode,
      name: p.unit.name,
      sizeCode: p.unit.size.code,
      sizeName: p.unit.size.name,
      sqft: p.unit.sqft,
      status: p.unit.status,
      hasAC: p.unit.hasAC,
      hasPillar: p.unit.hasPillar,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      stackTier: (p.stackTier === 1 ? 1 : 0) as 0 | 1,
      doorEdges: p.doorEdges ? String(p.doorEdges).split(',') : null,
    }));
  }

  let blocks: DraftBlockSnapshot[];
  if (input.blocks !== undefined) {
    if (!Array.isArray(input.blocks)) throw new AppError(400, 'VALIDATION', 'Draft blocks must be an array');
    blocks = input.blocks.map((b) => {
      const name = String(b.name ?? '').trim();
      if (!name || name.length > 80) {
        throw new AppError(400, 'VALIDATION', 'Draft block name must be a non-empty string of at most 80 characters');
      }
      checkDraftRect(b, 'block');
      checkDraftFit(b, canvas, 'block');
      const blockDoorCsv = normalizeDoorEdges(b.doorEdges);
      return {
        name,
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        color: b.color === undefined || b.color === null ? null : String(b.color),
        doorEdges: (blockDoorCsv == null ? null : String(blockDoorCsv).split(',')) as string[] | null,
      };
    });
  } else {
    blocks = (live?.blocks ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      color: b.color,
      doorEdges: b.doorEdges ? String(b.doorEdges).split(',') : null,
    }));
  }

  let boundaries: DraftBoundarySnapshot[];
  if (input.boundaries !== undefined) {
    if (!Array.isArray(input.boundaries)) throw new AppError(400, 'VALIDATION', 'Draft boundaries must be an array');
    boundaries = input.boundaries.map((b) => {
      const closed = b.closed ?? false;
      const points = boundaryPointsOf(b.points);
      if (points.length < 2) {
        throw new AppError(400, 'VALIDATION', 'Draft boundary points must list at least 2 vertices');
      }
      for (const [x, y] of points) {
        if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) {
          throw new AppError(
            400,
            'VALIDATION',
            `Draft boundary vertex ${x},${y} sits outside the ${canvas.width}×${canvas.height} ft draft canvas`,
          );
        }
      }
      return {
        label: b.label === undefined ? 'Boundary' : String(b.label).trim() || 'Boundary',
        kind: b.kind == null ? 'BOUNDARY' : String(b.kind).trim() || 'BOUNDARY',
        points,
        closed,
        sortOrder: b.sortOrder ?? 0,
      };
    });
  } else {
    boundaries = (live?.boundaries ?? []).map((b) => ({
      id: b.id,
      label: b.label,
      kind: b.kind,
      points: boundaryPointsOf(b.points),
      closed: b.closed,
      sortOrder: b.sortOrder,
    }));
  }

  let markers: DraftMarkerSnapshot[];
  if (input.markers !== undefined) {
    if (!Array.isArray(input.markers)) throw new AppError(400, 'VALIDATION', 'Draft markers must be an array');
    markers = input.markers.map((m) => {
      if (!(FP_MARKER_KINDS as readonly string[]).includes(m.kind)) {
        throw new AppError(
          400,
          'VALIDATION',
          `Draft marker kind must be one of ${FP_MARKER_KINDS.join(', ')} — got ${JSON.stringify(m.kind)}`,
        );
      }
      if (!Number.isInteger(m.x) || !Number.isInteger(m.y) || m.x < 0 || m.y < 0 || m.x > canvas.width || m.y > canvas.height) {
        throw new AppError(
          400,
          'VALIDATION',
          `Draft marker point ${m.x},${m.y} sits outside the ${canvas.width}×${canvas.height} ft draft canvas`,
        );
      }
      return { kind: m.kind, label: m.label == null || !String(m.label).trim() ? null : String(m.label).trim(), x: m.x, y: m.y };
    });
  } else {
    markers = (live?.markers ?? []).map((m) => ({ id: m.id, kind: m.kind, label: m.label, x: m.x, y: m.y }));
  }

  const data = {
    floorId,
    width,
    height,
    structure: structure === null ? Prisma.JsonNull : (structure as Prisma.InputJsonValue),
    gfaSqft,
    placements: placements as unknown as Prisma.InputJsonValue,
    blocks: blocks as unknown as Prisma.InputJsonValue,
    boundaries: boundaries as unknown as Prisma.InputJsonValue,
    markers: markers as unknown as Prisma.InputJsonValue,
    createdBy: input.createdBy ?? null,
  };

  // Version = max+1 per floor. A concurrent save racing the same max hits the
  // @@unique([floorId, version]) guard (P2002) — retry once with a fresh max.
  for (let attempt = 0; attempt < 2; attempt++) {
    const agg = await prisma.floorPlanDraft.aggregate({ where: { floorId }, _max: { version: true } });
    const version = (agg._max.version ?? 0) + 1;
    try {
      const draft = await prisma.floorPlanDraft.create({
        data: { ...data, version, status: 'DRAFT' },
        include: { floor: { include: { branch: true } } },
      });
      return serializeDraft(draft);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt === 0) continue;
      throw err;
    }
  }
  throw new AppError(409, 'CONFLICT', 'Draft version race — please retry the save');
}

/** List a floor's draft versions, newest version first (summaries only — no snapshots). */
export async function listDrafts(floorId: string) {
  const floor = await prisma.floor.findUnique({ where: { id: floorId }, select: { id: true } });
  if (!floor) throw new AppError(404, 'NOT_FOUND', `Floor ${floorId} not found`);
  const rows = await prisma.floorPlanDraft.findMany({
    where: { floorId },
    include: { floor: { include: { branch: true } } },
    orderBy: { version: 'desc' },
  });
  return rows.map(serializeDraftSummary);
}

/** View one draft version with its full canvas snapshot. */
export async function getDraft(draftId: string) {
  const draft = await prisma.floorPlanDraft.findUnique({
    where: { id: draftId },
    include: { floor: { include: { branch: true } } },
  });
  if (!draft) throw new AppError(404, 'NOT_FOUND', `Floor plan draft ${draftId} not found`);
  return serializeDraft(draft);
}

/** Delete one draft version (design history only — the live plan is untouched). */
export async function deleteDraft(draftId: string) {
  const draft = await prisma.floorPlanDraft.findUnique({ where: { id: draftId }, select: { id: true, floorId: true, version: true } });
  if (!draft) throw new AppError(404, 'NOT_FOUND', `Floor plan draft ${draftId} not found`);
  await prisma.floorPlanDraft.delete({ where: { id: draftId } });
  return { draftId: draft.id, floorId: draft.floorId, version: draft.version, deleted: true };
}

export interface PublishDraftResult {
  plan: Awaited<ReturnType<typeof publishFloorPlan>>;
  /** Unit codes from the snapshot that could not be restored (deleted, moved floors, or deactivated since the save). */
  skippedPlacements: string[];
}

/**
 * Publish a draft version: copy its snapshot into the live FloorPlan
 * (wholesale replace — placements added after the snapshot are removed) and
 * walk DRAFT → ACTIVE via the existing publishFloorPlan path. Snapshot
 * placements whose unit has since been deleted, moved floors, or deactivated
 * are SKIPPED (reported, never fatal). The draft row is marked ACTIVE as its
 * published marker. The single-plan publish flow is untouched.
 */
export async function publishDraft(draftId: string, opts?: { actorId?: string }): Promise<PublishDraftResult> {
  const draft = await prisma.floorPlanDraft.findUnique({
    where: { id: draftId },
    include: { floor: true },
  });
  if (!draft) throw new AppError(404, 'NOT_FOUND', `Floor plan draft ${draftId} not found`);
  const floorId = draft.floorId;
  const canvas = { width: draft.width, height: draft.height };

  const snapshotPlacements = asSnapshotArray<DraftPlacementSnapshot>(draft.placements);
  const snapshotBlocks = asSnapshotArray<DraftBlockSnapshot>(draft.blocks);
  const snapshotBoundaries = asSnapshotArray<DraftBoundarySnapshot>(draft.boundaries);
  const snapshotMarkers = asSnapshotArray<DraftMarkerSnapshot>(draft.markers);

  // Resolve snapshot placements against CURRENT unit rows (last wins per
  // unit — a unit is still placed at most once).
  const byUnit = new Map<string, DraftPlacementSnapshot>();
  for (const p of snapshotPlacements) {
    if (p && typeof p.unitId === 'string') byUnit.set(p.unitId, p);
  }
  const skippedPlacements: string[] = [];
  const placementRows: Prisma.UnitPlacementCreateManyInput[] = [];
  if (byUnit.size) {
    const units = await prisma.unit.findMany({ where: { id: { in: [...byUnit.keys()] } } });
    const unitById = new Map(units.map((u) => [u.id, u]));
    for (const [unitId, p] of byUnit) {
      const unit = unitById.get(unitId);
      const label = p.unitCode || unitId;
      if (!unit || unit.floorId !== floorId || unit.deletedAt || unit.status === 'INACTIVE') {
        skippedPlacements.push(label);
        continue;
      }
      if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || !Number.isInteger(p.width) || !Number.isInteger(p.height)) {
        skippedPlacements.push(label);
        continue;
      }
      if (p.x + p.width > canvas.width || p.y + p.height > canvas.height) {
        skippedPlacements.push(label);
        continue;
      }
      placementRows.push({
        floorPlanId: '', // stamped after the canvas upsert below
        unitId,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        stackTier: p.stackTier === 1 ? 1 : 0,
        doorEdges: (normalizeDoorEdges(p.doorEdges) ?? null) as string | null,
      });
    }
  }

  const blockRows = snapshotBlocks
    .filter((b) => b && Number.isInteger(b.x) && Number.isInteger(b.y) && Number.isInteger(b.width) && Number.isInteger(b.height))
    .filter((b) => b.x + b.width <= canvas.width && b.y + b.height <= canvas.height)
    .map((b) => ({
      floorPlanId: '',
      name: String(b.name ?? '').trim().slice(0, 80) || 'Block',
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      color: b.color ?? null,
      doorEdges: (normalizeDoorEdges(b.doorEdges) ?? null) as string | null,
    }));

  const boundaryRows = snapshotBoundaries
    .filter((b) => b && Array.isArray(b.points))
    .map((b) => ({
      floorPlanId: '',
      label: String(b.label ?? '').trim().slice(0, 80) || 'Boundary',
      kind: String(b.kind ?? '').trim().slice(0, 24) || 'BOUNDARY',
      points: boundaryPointsOf(b.points) as unknown as Prisma.InputJsonValue,
      closed: !!b.closed,
      sortOrder: Number.isInteger(b.sortOrder) ? (b.sortOrder as number) : 0,
    }));

  const markerRows = snapshotMarkers
    .filter((m) => m && (FP_MARKER_KINDS as readonly string[]).includes(m.kind))
    .filter((m) => Number.isInteger(m.x) && Number.isInteger(m.y) && m.x >= 0 && m.y >= 0 && m.x <= canvas.width && m.y <= canvas.height)
    .map((m) => ({
      floorPlanId: '',
      kind: m.kind,
      label: m.label ?? null,
      x: m.x,
      y: m.y,
    }));

  await prisma.$transaction(async (tx) => {
    const plan = await tx.floorPlan.upsert({
      where: { floorId },
      create: {
        floor: { connect: { id: floorId } },
        status: 'DRAFT',
        width: canvas.width,
        height: canvas.height,
        structure: draft.structure === null ? Prisma.JsonNull : ((draft.structure ?? Prisma.JsonNull) as Prisma.InputJsonValue),
        gfaSqft: draft.gfaSqft,
      },
      update: {
        status: 'DRAFT',
        width: canvas.width,
        height: canvas.height,
        structure: draft.structure === null ? Prisma.JsonNull : ((draft.structure ?? Prisma.JsonNull) as Prisma.InputJsonValue),
        gfaSqft: draft.gfaSqft,
      },
    });
    await tx.unitPlacement.deleteMany({ where: { floorPlanId: plan.id } });
    await tx.floorPlanBlock.deleteMany({ where: { floorPlanId: plan.id } });
    await tx.floorPlanBoundary.deleteMany({ where: { floorPlanId: plan.id } });
    await tx.floorPlanMarker.deleteMany({ where: { floorPlanId: plan.id } });
    if (placementRows.length) {
      await tx.unitPlacement.createMany({ data: placementRows.map((r) => ({ ...r, floorPlanId: plan.id })) });
    }
    if (blockRows.length) {
      await tx.floorPlanBlock.createMany({ data: blockRows.map((r) => ({ ...r, floorPlanId: plan.id })) });
    }
    if (boundaryRows.length) {
      await tx.floorPlanBoundary.createMany({ data: boundaryRows.map((r) => ({ ...r, floorPlanId: plan.id })) });
    }
    if (markerRows.length) {
      await tx.floorPlanMarker.createMany({ data: markerRows.map((r) => ({ ...r, floorPlanId: plan.id })) });
    }
    await tx.floorPlanDraft.update({ where: { id: draftId }, data: { status: 'ACTIVE' } });
  });

  const plan = await publishFloorPlan(floorId, { actorId: opts?.actorId });
  return { plan, skippedPlacements };
}

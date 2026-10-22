import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { Prisma, type PlanStatus } from '@prisma/client';
import {
  CANVAS_DEFAULTS,
  FP_MARKER_KINDS,
  MAX_GFA_SQFT,
  boundaryPointsOf,
  doorOffsetsToObject,
  normalizeDoorEdges,
  normalizeDoorOffsets,
  PUBLISH_TX_OPTIONS,
  assertPublishPermission,
  ensurePublishedSnapshotTx,
  getFloorPlan,
  publishFloorPlan,
  publishFloorPlanWithSync,
  publishPlanTx,
  type DoorOffsets,
  type PublicPlanView,
  type PublishFloorPlanOptions,
} from './floorPlans';
import { loadContractedUnits, sameSqft, sqftForRect } from './unitSizing';
import {
  DEFAULT_WALL_THICKNESS_FT,
  MAX_WALL_THICKNESS_FT,
  MIN_RECT_SIDE_FT,
  MIN_WALL_THICKNESS_FT,
  clampFt,
  isPlanNumber,
  pointOnCanvas,
  quantizeFt,
  quantizeRect,
  rectAreaSqft,
  rectFitsCanvas,
} from './planGeometry';

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
// DRAFT → ACTIVE through the shared publishPlanTx (which also applies the
// floor-plan unit sync) — all in ONE transaction, so a failed publish leaves
// nothing half-applied. Exactly one version per floor carries the published
// marker; publishing the working copy directly clears it (the live plan then
// matches no saved version). Loading a version (loadDraft) restores the same
// way without publishing.

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
  // Authored door positions (door-move tool fractions per edge); null = all
  // centred. Snapshots keep the OBJECT form the preview/editor consume.
  doorOffsets: DoorOffsets | null;
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
  thickness?: number | null; // WALL thickness in ft (absent in pre-Phase-3 snapshots)
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
  // Authored door positions (door-move tool); pruned to the authored edges on
  // save, null clears back to centred, omitted clears too — same defaulting
  // as doorEdges (the editor always sends explicit values; the live fallback
  // below is the keep path).
  doorOffsets?: Record<string, number> | null;
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
  thickness?: number | null;
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

// Geometry is decimal feet quantized to 0.001 ft (src/core/planGeometry.ts);
// callers persist the RETURNED (quantized) values.
function checkDraftDim(v: number, axis: 'width' | 'height'): number {
  if (!isPlanNumber(v) || quantizeFt(v) < 1 || quantizeFt(v) > MAX_CANVAS) {
    throw new AppError(400, 'VALIDATION', `Canvas ${axis} must be a number of feet between 1 and ${MAX_CANVAS}`);
  }
  return quantizeFt(v);
}

function checkDraftRect<T extends { x: number; y: number; width: number; height: number }>(g: T, what: string): T {
  for (const [v, name, min] of [[g.x, 'x', 0], [g.y, 'y', 0], [g.width, 'width', MIN_RECT_SIDE_FT], [g.height, 'height', MIN_RECT_SIDE_FT]] as const) {
    if (!isPlanNumber(v) || quantizeFt(v) < min) {
      throw new AppError(400, 'VALIDATION', `Draft ${what} ${name} must be a number of feet >= ${min}`);
    }
  }
  return quantizeRect(g);
}

function checkDraftFit(
  g: { x: number; y: number; width: number; height: number },
  plan: { width: number; height: number },
  what: string,
): void {
  if (!rectFitsCanvas(g, plan)) {
    throw new AppError(
      400,
      'VALIDATION',
      `Draft ${what} ${g.x},${g.y} ${g.width}×${g.height} exceeds the ${plan.width}×${plan.height} ft draft canvas — enlarge the canvas first`,
    );
  }
}

// WALL thickness for snapshots: quantized ft within range, default when unset;
// null for every other kind (mirrors resolveThickness in floorPlans.ts).
function draftThickness(kind: string, v: number | null | undefined): number | null {
  if (kind.toUpperCase() !== 'WALL') return null;
  if (!isPlanNumber(v) || v <= 0) return DEFAULT_WALL_THICKNESS_FT;
  return clampFt(v, MIN_WALL_THICKNESS_FT, MAX_WALL_THICKNESS_FT);
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

// ---------- live canvas → snapshot ----------

const liveInclude = {
  placements: { include: { unit: { include: { size: true } } } },
  blocks: true,
  boundaries: true,
  markers: true,
} satisfies Prisma.FloorPlanInclude;

type LivePlan = Prisma.FloorPlanGetPayload<{ include: typeof liveInclude }>;

// The live working copy in snapshot shape — the keep path of saveDraft and
// the version every live publish freezes.
function liveSnapshotOf(live: LivePlan | null) {
  return {
    placements: (live?.placements ?? []).map((p): DraftPlacementSnapshot => ({
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
      doorOffsets: doorOffsetsToObject(p.doorOffsets),
    })),
    blocks: (live?.blocks ?? []).map((b): DraftBlockSnapshot => ({
      id: b.id,
      name: b.name,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      color: b.color,
      doorEdges: b.doorEdges ? String(b.doorEdges).split(',') : null,
    })),
    boundaries: (live?.boundaries ?? []).map((b): DraftBoundarySnapshot => ({
      id: b.id,
      label: b.label,
      kind: b.kind,
      points: boundaryPointsOf(b.points),
      closed: b.closed,
      sortOrder: b.sortOrder,
      thickness: b.thickness ?? null,
    })),
    markers: (live?.markers ?? []).map((m): DraftMarkerSnapshot => ({ id: m.id, kind: m.kind, label: m.label, x: m.x, y: m.y })),
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

  const live = await prisma.floorPlan.findUnique({ where: { floorId }, include: liveInclude });

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
    for (const raw of input.placements) {
      const p = checkDraftRect(raw, 'placement');
      checkDraftFit(p, canvas, 'placement');
      const tier = p.stackTier === undefined ? 0 : p.stackTier;
      if (tier !== 0 && tier !== 1) {
        throw new AppError(400, 'VALIDATION', `Draft placement stackTier must be 0 or 1 — got ${tier}`);
      }
      // Validates the compass subset (400 outside N/S/E/W); snapshots keep the
      // authored ARRAY form the preview consumes (publish re-encodes to CSV).
      // Offsets prune to the authored edges (toggling an edge off drops its
      // offset); omitted clears back to centred — same defaulting as doorEdges
      // (the editor always sends explicit values; the live fallback below is
      // the keep path).
      const doorCsv = normalizeDoorEdges(p.doorEdges);
      const doorArr = doorCsv == null ? null : String(doorCsv).split(',');
      const doorOffsets = normalizeDoorOffsets(p.doorOffsets, doorArr) ?? null;
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
        doorOffsets,
      });
    }
  } else {
    placements = liveSnapshotOf(live).placements;
  }

  let blocks: DraftBlockSnapshot[];
  if (input.blocks !== undefined) {
    if (!Array.isArray(input.blocks)) throw new AppError(400, 'VALIDATION', 'Draft blocks must be an array');
    blocks = input.blocks.map((b) => {
      const name = String(b.name ?? '').trim();
      if (!name || name.length > 80) {
        throw new AppError(400, 'VALIDATION', 'Draft block name must be a non-empty string of at most 80 characters');
      }
      const r = checkDraftRect(b, 'block');
      checkDraftFit(r, canvas, 'block');
      const blockDoorCsv = normalizeDoorEdges(b.doorEdges);
      return {
        name,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        color: b.color === undefined || b.color === null ? null : String(b.color),
        doorEdges: (blockDoorCsv == null ? null : String(blockDoorCsv).split(',')) as string[] | null,
      };
    });
  } else {
    blocks = liveSnapshotOf(live).blocks;
  }

  let boundaries: DraftBoundarySnapshot[];
  if (input.boundaries !== undefined) {
    if (!Array.isArray(input.boundaries)) throw new AppError(400, 'VALIDATION', 'Draft boundaries must be an array');
    boundaries = input.boundaries.map((b) => {
      const closed = b.closed ?? false;
      const points = boundaryPointsOf(b.points).map(([x, y]) => [quantizeFt(x), quantizeFt(y)] as [number, number]);
      if (points.length < 2) {
        throw new AppError(400, 'VALIDATION', 'Draft boundary points must list at least 2 vertices');
      }
      for (const [x, y] of points) {
        if (!pointOnCanvas(x, y, canvas)) {
          throw new AppError(
            400,
            'VALIDATION',
            `Draft boundary vertex ${x},${y} sits outside the ${canvas.width}×${canvas.height} ft draft canvas`,
          );
        }
      }
      return {
        label: b.label === undefined ? 'Wall' : String(b.label).trim() || 'Wall',
        kind: b.kind == null ? 'BOUNDARY' : String(b.kind).trim() || 'BOUNDARY',
        points,
        closed,
        sortOrder: b.sortOrder ?? 0,
        thickness: draftThickness(b.kind == null ? 'BOUNDARY' : String(b.kind).trim(), b.thickness),
      };
    });
  } else {
    boundaries = liveSnapshotOf(live).boundaries;
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
      if (!isPlanNumber(m.x) || !isPlanNumber(m.y) || !pointOnCanvas(m.x, m.y, canvas)) {
        throw new AppError(
          400,
          'VALIDATION',
          `Draft marker point ${m.x},${m.y} sits outside the ${canvas.width}×${canvas.height} ft draft canvas`,
        );
      }
      return { kind: m.kind, label: m.label == null || !String(m.label).trim() ? null : String(m.label).trim(), x: quantizeFt(m.x), y: quantizeFt(m.y) };
    });
  } else {
    markers = liveSnapshotOf(live).markers;
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
  const plan = await prisma.floorPlan.findUnique({ where: { floorId }, select: { publishedAt: true } });
  return rows.map((r) => ({ ...serializeDraftSummary(r), status: effectiveStatus(r, plan?.publishedAt) }));
}

/** View one draft version with its full canvas snapshot. */
export async function getDraft(draftId: string) {
  const draft = await prisma.floorPlanDraft.findUnique({
    where: { id: draftId },
    include: { floor: { include: { branch: true } } },
  });
  if (!draft) throw new AppError(404, 'NOT_FOUND', `Floor plan draft ${draftId} not found`);
  const plan = await prisma.floorPlan.findUnique({ where: { floorId: draft.floorId }, select: { publishedAt: true } });
  return { ...serializeDraft(draft), status: effectiveStatus(draft, plan?.publishedAt) };
}

// The marker the CMS shows: ACTIVE only when it is trustworthy.
function effectiveStatus(row: { status: PlanStatus; updatedAt: Date }, publishedAt: Date | null | undefined): PlanStatus {
  return row.status === 'ACTIVE' && !isTrustedMarker(row, publishedAt) ? 'DRAFT' : row.status;
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
export interface PublishPreview {
  draftId: string;
  floorId: string;
  version: number;
  status: string;
  counts: { placements: number; blocks: number; boundaries: number; markers: number };
  /** The floor's currently-published version, if any (null = nothing published yet). */
  published: { id: string; version: number } | null;
  /** The live serving copy's status (null = no live plan exists yet). */
  liveStatus: string | null;
  /** Unit codes the publish would skip (deleted, moved floors, deactivated, or unfit since the save). */
  skippedPlacements: string[];
  /** True when the draft would put 0 placements live — the confirm popup
   * escalates to a danger confirm and the publish needs { confirmEmpty: true }. */
  emptyPlan: boolean;
  /** Would-be contracted-unit publish blockers (same contracted semantics +
   * epsilon as the publish preflight — the popup lists these BEFORE confirm so
   * a blocked draft never fails only after confirm). Empty when clean. */
  blockers: DraftPublishBlocker[];
}

/** A draft resize the publish would refuse (contracted unit, 409 PUBLISH_BLOCKED). */
export interface DraftPublishBlocker {
  unitId: string;
  unitCode: string;
  code: 'UNIT_CONTRACTED';
  /** Unit.sqft the customer contracted → drawn sqft the draft would sync. */
  from: number;
  to: number;
  /** Contracted reason (unit status or 'awaiting booking payment'). */
  reason: string;
}

// Would-be contracted-unit blockers for a draft's size changes — the single
// helper shared by the publish preflight and the read-only preview (identical
// contracted semantics + epsilon in both, so the popup can never disagree
// with the publish). `sizeChanges` already carries the SQFT_EPSILON rule
// (dirty only when !sameSqft in resolveDraftSnapshotRows); this step applies
// the loadContractedUnits half, exactly as the publish does.
async function findDraftContractedBlockers(
  sizeChanges: Array<{ unitId: string; unitCode: string; from: number; to: number }>,
): Promise<DraftPublishBlocker[]> {
  if (!sizeChanges.length) return [];
  const contracted = await loadContractedUnits(sizeChanges.map((c) => c.unitId));
  return sizeChanges
    .filter((c) => contracted.has(c.unitId))
    .map((c) => ({ unitId: c.unitId, unitCode: c.unitCode, code: 'UNIT_CONTRACTED' as const, from: c.from, to: c.to, reason: contracted.get(c.unitId)! }));
}

type DraftWithFloor = Prisma.FloorPlanDraftGetPayload<{ include: { floor: true } }>;

// What a restore needs from a version — also built from the published
// snapshot by revertToPublished.
type SnapshotSource = Pick<
  DraftWithFloor,
  'floorId' | 'width' | 'height' | 'structure' | 'gfaSqft' | 'placements' | 'blocks' | 'boundaries' | 'markers'
>;

// Snapshot → live-row resolution shared by the publish preview and the
// publish itself (identical skip semantics in both, so the confirm popup can
// never promise units the publish then drops). Placements whose unit has since
// been deleted, moved floors, or deactivated — or whose geometry no longer
// fits the draft canvas — are SKIPPED (reported, never fatal). Row ids from
// the snapshot are traceability only — publish mints fresh live rows.
// Size-change bookkeeping (areaDirty flags + sizeChanges) reuses the Float
// unit-sizing helpers (sqftForRect/sameSqft — Unit.sqft is float8 quantized to
// 0.01, never Math.round).
async function resolveDraftSnapshotRows(draft: SnapshotSource) {
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
  // Floor-plan unit sync: a restored rect whose area differs from the CURRENT
  // live rect (or was already pending) and from Unit.sqft is flagged
  // areaDirty, so publish syncs it; grandfathered mismatches carried over
  // unchanged stay unflagged (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md §5.3).
  const live = await prisma.unitPlacement.findMany({
    where: { floorPlan: { floorId }, unitId: { in: [...byUnit.keys()] } },
    select: { unitId: true, width: true, height: true, areaDirty: true },
  });
  const liveByUnit = new Map(live.map((l) => [l.unitId, l]));
  const sizeChanges: Array<{ unitId: string; unitCode: string; from: number; to: number }> = [];
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
      if (!isPlanNumber(p.x) || !isPlanNumber(p.y) || !isPlanNumber(p.width) || !isPlanNumber(p.height)) {
        skippedPlacements.push(label);
        continue;
      }
      const r = quantizeRect(p);
      if (r.width <= 0 || r.height <= 0 || !rectFitsCanvas(r, canvas)) {
        skippedPlacements.push(label);
        continue;
      }
      placementRows.push({
        floorPlanId: '', // stamped after the canvas upsert below
        unitId,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        stackTier: p.stackTier === 1 ? 1 : 0,
        doorEdges: (normalizeDoorEdges(p.doorEdges) ?? null) as string | null,
        doorOffsets: (normalizeDoorOffsets(p.doorOffsets, p.doorEdges) ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
        areaDirty: (() => {
          const prev = liveByUnit.get(unitId);
          const changed = !prev || prev.areaDirty || rectAreaSqft(prev) !== rectAreaSqft(r);
          const dirty = changed && !sameSqft(sqftForRect(r), unit.sqft);
          if (dirty) sizeChanges.push({ unitId, unitCode: unit.unitCode, from: unit.sqft, to: sqftForRect(r) });
          return dirty;
        })(),
      });
    }
  }
  // Preflight lives in publishDraft (after the shared resolution above): a
  // contracted unit's size can never sync, so the publish refuses up front
  // instead of leaving a half-applied draft. The read-only preview below
  // never throws — it only reports counts and skips.

  const blockRows = snapshotBlocks
    .filter((b) => b && isPlanNumber(b.x) && isPlanNumber(b.y) && isPlanNumber(b.width) && isPlanNumber(b.height))
    .map((b) => ({ ...b, ...quantizeRect(b) }))
    .filter((b) => b.width > 0 && b.height > 0 && rectFitsCanvas(b, canvas))
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
      label: String(b.label ?? '').trim().slice(0, 80) || 'Wall',
      kind: String(b.kind ?? '').trim().slice(0, 24) || 'BOUNDARY',
      points: boundaryPointsOf(b.points).map(([x, y]) => [quantizeFt(x), quantizeFt(y)]) as unknown as Prisma.InputJsonValue,
      closed: !!b.closed,
      sortOrder: Number.isInteger(b.sortOrder) ? (b.sortOrder as number) : 0,
      thickness: draftThickness(String(b.kind ?? ''), b.thickness),
    }));

  const markerRows = snapshotMarkers
    .filter((m) => m && (FP_MARKER_KINDS as readonly string[]).includes(m.kind))
    .filter((m) => isPlanNumber(m.x) && isPlanNumber(m.y) && pointOnCanvas(m.x, m.y, canvas))
    .map((m) => ({
      floorPlanId: '',
      kind: m.kind,
      label: m.label ?? null,
      x: quantizeFt(m.x),
      y: quantizeFt(m.y),
    }));

  return {
    canvas,
    placementRows,
    blockRows,
    boundaryRows,
    markerRows,
    skippedPlacements,
    sizeChanges,
    counts: {
      placements: placementRows.length,
      blocks: blockRows.length,
      boundaries: boundaryRows.length,
      markers: markerRows.length,
    },
  };
}

/**
 * Publish preview for the confirm popup (read-only — never writes): the
 * draft's restorable counts, the floor's currently-published version (which
 * the publish demotes back to DRAFT), the live plan status, and the exact
 * skipped-placement list the publish would report. The editor fetches this
 * BEFORE confirming so the popup names what will go live (counts), what goes
 * back to draft, and what will be skipped.
 */
export async function getPublishPreview(draftId: string): Promise<PublishPreview> {
  const draft = await prisma.floorPlanDraft.findUnique({
    where: { id: draftId },
    include: { floor: true },
  });
  if (!draft) throw new AppError(404, 'NOT_FOUND', `Floor plan draft ${draftId} not found`);
  const resolved = await resolveDraftSnapshotRows(draft);
  const blockers = await findDraftContractedBlockers(resolved.sizeChanges);
  const live = await prisma.floorPlan.findUnique({ where: { floorId: draft.floorId }, select: { status: true } });
  // Highest ACTIVE version wins the "currently published" label (a legacy
  // floor could hold more than one ACTIVE marker — the next publish demotes
  // all but the chosen one, self-healing the invariant).
  const livePlan = await prisma.floorPlan.findUnique({ where: { floorId: draft.floorId }, select: { publishedAt: true } });
  const activeRow = await prisma.floorPlanDraft.findFirst({
    where: { floorId: draft.floorId, status: 'ACTIVE' },
    select: { id: true, version: true, status: true, updatedAt: true },
    orderBy: { version: 'desc' },
  });
  const publishedRow = activeRow && isTrustedMarker(activeRow, livePlan?.publishedAt) ? activeRow : null;
  return {
    draftId: draft.id,
    floorId: draft.floorId,
    version: draft.version,
    status: effectiveStatus(draft, livePlan?.publishedAt),
    counts: resolved.counts,
    published: publishedRow ? { id: publishedRow.id, version: publishedRow.version } : null,
    liveStatus: live?.status ?? null,
    skippedPlacements: resolved.skippedPlacements,
    emptyPlan: resolved.placementRows.length === 0,
    blockers,
  };
}

/**
 * Publish a draft version: copy its snapshot into the live FloorPlan
 * (wholesale replace — placements added after the snapshot are removed) and
 * walk DRAFT → ACTIVE via the existing publishFloorPlan path (which also
 * applies the floor-plan unit sync). Snapshot placements whose unit has since
 * been deleted, moved floors, or deactivated are SKIPPED (reported, never
 * fatal). Restore, unit sync, DRAFT → ACTIVE and the version markers run in
 * ONE transaction (a failed publish changes nothing); the chosen draft row is
 * marked ACTIVE and every other version is demoted back to DRAFT, so exactly
 * one version per floor stays published.
 */
export async function publishDraft(draftId: string, opts?: PublishFloorPlanOptions): Promise<PublishDraftResult> {
  const draft = await prisma.floorPlanDraft.findUnique({
    where: { id: draftId },
    include: { floor: true },
  });
  if (!draft) throw new AppError(404, 'NOT_FOUND', `Floor plan draft ${draftId} not found`);
  const resolved = await resolveDraftSnapshotRows(draft);
  const { blockRows, boundaryRows, markerRows, placementRows, skippedPlacements, sizeChanges } = resolved;

  // Empty-plan guard: a publish that would put 0 placements live is refused
  // (409 EMPTY_PLAN) without the typed { confirmEmpty: true }
  // acknowledgement — customers would see an empty floor.
  if (placementRows.length === 0 && !opts?.confirmEmpty) {
    throw new AppError(
      409,
      'EMPTY_PLAN',
      `Publish refused: draft v${draft.version} would put 0 units live — customers will see an empty floor. Re-confirm with { confirmEmpty: true } to publish it empty.`,
      { counts: { placements: 0, blocks: blockRows.length, boundaries: boundaryRows.length, markers: markerRows.length }, skippedPlacements },
    );
  }

  // Preflight before the working copy is replaced: a contracted unit's size
  // can never sync, so refuse up front with the same blocker list the preview
  // shows (from→to sqft).
  const blocked = await findDraftContractedBlockers(sizeChanges);
  if (blocked.length) {
    throw new AppError(
      409,
      'PUBLISH_BLOCKED',
      `Publish blocked: this version resizes contracted unit(s) ${blocked.map((b) => `${b.unitCode} (${b.reason.toLowerCase()}, ${b.from}→${b.to} sqft)`).join(', ')}`,
      { blockers: blocked.map((b) => ({ unitId: b.unitId, unitCode: b.unitCode, code: b.code, from: b.from, to: b.to })) },
    );
  }
  await assertPublishPermission(opts);

  // Restore + publish + version markers in ONE transaction: any failure inside
  // the publish (size-sync blocker, stale preview, …) rolls the restore back,
  // so the working copy, the published marker and the public view are never
  // left half-applied.
  const plan = await prisma.$transaction(async (tx) => {
    const planId = await restoreDraftTx(tx, draft, resolved);
    const { plan } = await publishPlanTx(tx, draft.floorId, planId, opts);
    // publishPlanTx cleared every marker — this version is the published one.
    await tx.floorPlanDraft.update({ where: { id: draftId }, data: { status: 'ACTIVE' } });
    return plan;
  }, PUBLISH_TX_OPTIONS);
  return { plan, skippedPlacements };
}

export interface LoadDraftResult {
  plan: Awaited<ReturnType<typeof getFloorPlan>>;
  /** Unit codes from the snapshot that could not be restored (deleted, moved floors, or deactivated since the save). */
  skippedPlacements: string[];
}

/**
 * Load a version into the designer: restore its snapshot into the live
 * working copy (wholesale replace, fresh row ids) WITHOUT publishing. The
 * plan becomes DRAFT, so customers keep the last published snapshot (R-FP1)
 * until the operator publishes; version markers are untouched. Restoring
 * server-side means every later editor write addresses real rows, and the
 * header Publish ships exactly what the designer shows.
 */
export async function loadDraft(draftId: string): Promise<LoadDraftResult> {
  const draft = await prisma.floorPlanDraft.findUnique({
    where: { id: draftId },
    include: { floor: true },
  });
  if (!draft) throw new AppError(404, 'NOT_FOUND', `Floor plan draft ${draftId} not found`);
  const resolved = await resolveDraftSnapshotRows(draft);
  await prisma.$transaction((tx) => restoreDraftTx(tx, draft, resolved), PUBLISH_TX_OPTIONS);
  return { plan: await getFloorPlan(draft.floorId), skippedPlacements: resolved.skippedPlacements };
}

// Copy a resolved snapshot into the live working copy (DRAFT): canvas dims,
// structure, GFA, then every element wholesale (placements added after the
// snapshot are removed). A published plan without a snapshot gets one first
// so customers never lose the floor. Returns the live plan id.
async function restoreDraftTx(
  tx: Prisma.TransactionClient,
  draft: SnapshotSource,
  resolved: Awaited<ReturnType<typeof resolveDraftSnapshotRows>>,
): Promise<string> {
  const floorId = draft.floorId;
  const { canvas, placementRows, blockRows, boundaryRows, markerRows } = resolved;
  await ensurePublishedSnapshotTx(tx, floorId);
  const structure = draft.structure === null ? Prisma.JsonNull : ((draft.structure ?? Prisma.JsonNull) as Prisma.InputJsonValue);
  const plan = await tx.floorPlan.upsert({
    where: { floorId },
    create: {
      floor: { connect: { id: floorId } },
      status: 'DRAFT',
      width: canvas.width,
      height: canvas.height,
      structure,
      gfaSqft: draft.gfaSqft,
    },
    update: {
      status: 'DRAFT',
      width: canvas.width,
      height: canvas.height,
      structure,
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
  return plan.id;
}

/**
 * Live publish (header Publish) that also freezes the published canvas as a
 * new version marked ACTIVE, in the same transaction — so the Library always
 * holds exactly what customers see and it can be loaded back later.
 */
export async function publishLivePlan(floorId: string, opts?: PublishFloorPlanOptions) {
  return publishFloorPlanWithSync(floorId, opts, {
    afterPublishTx: (tx) => freezeLiveAsPublishedVersionTx(tx, floorId, opts?.actorName ?? null),
  });
}

// Freeze the live working copy as a new version marked ACTIVE (every other
// version demoted) — the Library row that equals what customers see.
async function freezeLiveAsPublishedVersionTx(tx: Prisma.TransactionClient, floorId: string, createdBy: string | null) {
  const live = await tx.floorPlan.findUniqueOrThrow({ where: { floorId }, include: liveInclude });
  const snap = liveSnapshotOf(live);
  const agg = await tx.floorPlanDraft.aggregate({ where: { floorId }, _max: { version: true } });
  await tx.floorPlanDraft.updateMany({ where: { floorId, status: 'ACTIVE' }, data: { status: 'DRAFT' } });
  await tx.floorPlanDraft.create({
    data: {
      floorId,
      version: (agg._max.version ?? 0) + 1,
      status: 'ACTIVE',
      width: live.width,
      height: live.height,
      structure: live.structure === null ? Prisma.JsonNull : (live.structure as Prisma.InputJsonValue),
      gfaSqft: live.gfaSqft,
      placements: snap.placements as unknown as Prisma.InputJsonValue,
      blocks: snap.blocks as unknown as Prisma.InputJsonValue,
      boundaries: snap.boundaries as unknown as Prisma.InputJsonValue,
      markers: snap.markers as unknown as Prisma.InputJsonValue,
      createdBy,
    },
  });
}

// A version's ACTIVE marker is only trustworthy when it was set by the
// floor's latest publish (same transaction ⇒ updatedAt ≥ publishedAt). Rows
// marked before marker hygiene existed (a later live publish left them
// ACTIVE) read as DRAFT so the Library never claims customers see them.
const MARKER_SKEW_MS = 5000;
function isTrustedMarker(row: { status: string; updatedAt: Date }, publishedAt: Date | null | undefined): boolean {
  return row.status === 'ACTIVE' && !!publishedAt && row.updatedAt.getTime() >= publishedAt.getTime() - MARKER_SKEW_MS;
}

export interface RevertToPublishedResult extends LoadDraftResult {
  publishedAt: string | null;
}

/**
 * Discard unpublished edits: restore the working copy from the published
 * snapshot (what customers see right now) and mark it ACTIVE again — nothing
 * new goes live, the public view is unchanged. Works for plans published
 * before publish auto-saved versions. The snapshot is the public view, so
 * CMS-only details it never carried come back at defaults: door positions
 * re-centre and GUIDE construction lines are absent.
 */
export async function revertToPublished(floorId: string, createdBy?: string | null): Promise<RevertToPublishedResult> {
  const plan = await prisma.floorPlan.findUnique({ where: { floorId } });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `No floor plan exists for floor ${floorId}`);
  const snap = plan.publishedSnapshot as unknown as PublicPlanView | null;
  if (!snap) {
    throw new AppError(409, 'NOT_PUBLISHED', 'This floor plan has never been published — there is no published version to revert to.');
  }
  const source: SnapshotSource = {
    floorId,
    width: snap.width,
    height: snap.height,
    structure: (snap.structure ?? null) as Prisma.JsonValue,
    gfaSqft: snap.gfaSqft ?? null,
    placements: (snap.placements ?? []).map((pl) => ({
      unitId: pl.unit.id,
      unitCode: pl.unit.unitCode,
      x: pl.x,
      y: pl.y,
      width: pl.width,
      height: pl.height,
      stackTier: pl.stackTier,
      doorEdges: pl.doorEdges,
      doorOffsets: null,
    })) as unknown as Prisma.JsonValue,
    blocks: (snap.blocks ?? []) as unknown as Prisma.JsonValue,
    boundaries: (snap.boundaries ?? []) as unknown as Prisma.JsonValue,
    markers: (snap.markers ?? []) as unknown as Prisma.JsonValue,
  };
  const resolved = await resolveDraftSnapshotRows(source);
  await prisma.$transaction(async (tx) => {
    const planId = await restoreDraftTx(tx, source, resolved);
    // The working copy now equals the published view — back to ACTIVE with
    // the snapshot (and publishedAt) untouched: nothing new is published.
    await tx.floorPlan.update({ where: { id: planId }, data: { status: 'ACTIVE' } });
    // Published geometry is already synced to its units: nothing is pending.
    await tx.unitPlacement.updateMany({ where: { floorPlanId: planId }, data: { areaDirty: false } });
    // Make sure the Library holds the plan customers see: when no version is
    // trustworthily marked Published (legacy publish, stale marker), freeze
    // the restored copy as one.
    const markers = await tx.floorPlanDraft.findMany({ where: { floorId, status: 'ACTIVE' }, select: { status: true, updatedAt: true } });
    if (!markers.some((m) => isTrustedMarker(m, plan.publishedAt))) {
      await freezeLiveAsPublishedVersionTx(tx, floorId, createdBy ? `${createdBy} (restored published plan)` : 'Restored published plan');
    }
  }, PUBLISH_TX_OPTIONS);
  return {
    plan: await getFloorPlan(floorId),
    skippedPlacements: resolved.skippedPlacements,
    publishedAt: plan.publishedAt ? plan.publishedAt.toISOString() : null,
  };
}

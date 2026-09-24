import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { Prisma } from '@prisma/client';

// Floor-plan layout aggregate (see docs/FLOOR_PLAN_MODEL.md).
//
// BLUEPRINT SCALE: 1 grid unit = 1 FOOT. Plan width/height are the building's
// real dimensions in feet; placement/block x/y/width/height are integer foot
// rects in the same space. Columns stay `Int` (1:1 grid-unit→ft); renderers
// scale ft → px at whatever zoom they want.
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
// Footprints: a unit's drawn rect must approximate its real area —
// `sqftFootprint()` resolves UnitSize.widthFt/heightFt when present and falls
// back to a documented per-size aspect formula otherwise. Writes validate
// area-vs-sqft within AREA_TOLERANCE (P3) and reject overlaps (409).
//
// Soft-delete + INACTIVE rule: every plan read joins placements → unit and
// filters out placements whose unit has deletedAt != null OR status INACTIVE.
// Never touch Unit rows.

export const CANVAS_DEFAULTS = { width: 70, height: 80 } as const;
const MAX_CANVAS = 500; // feet per axis, sanity cap

// P3: a placement's drawn area (w×h, square feet) must be within ±15% of the
// unit's sqft. Rejected with 400 VALIDATION; the editor's lock-to-sqft resize
// keeps operators inside the band, and the ops override warns that breaching
// it will be rejected here. Grandfathered rows (e.g. seeded uniform 2×3
// geometry) keep READING fine — this only fires on write.
export const AREA_TOLERANCE = 0.15;

// Per-size width/height aspect (w/h) used ONLY when a UnitSize row has no
// widthFt/heightFt dims. Chosen so the formula reproduces the catalogue
// footprints exactly: LOCKER 3/4, SMALL 5/6, MEDIUM 6/10, LARGE 10/12.
const SIZE_ASPECT: Record<string, number> = {
  LOCKER: 3 / 4,
  SMALL: 5 / 6,
  MEDIUM: 6 / 10,
  LARGE: 10 / 12,
};
const DEFAULT_ASPECT = 3 / 4;

/**
 * Integer foot rect for a unit of `sqft` square feet. Prefers explicit
 * UnitSize.widthFt/heightFt dims; otherwise derives from the per-size aspect:
 * w = round(sqrt(sqft·aspect)), h = ceil(sqft/w) (so w·h ≥ sqft and the rect
 * stays integral). Unknown sizes use DEFAULT_ASPECT.
 */
export function sqftFootprint(
  sqft: number,
  sizeCode?: string | null,
  widthFt?: number | null,
  heightFt?: number | null,
): { w: number; h: number } {
  if (
    widthFt != null &&
    heightFt != null &&
    Number.isInteger(widthFt) &&
    Number.isInteger(heightFt) &&
    widthFt > 0 &&
    heightFt > 0
  ) {
    return { w: widthFt, h: heightFt };
  }
  const aspect = (sizeCode && SIZE_ASPECT[sizeCode.toUpperCase()]) || DEFAULT_ASPECT;
  const w = Math.max(1, Math.round(Math.sqrt(Math.max(1, sqft) * aspect)));
  const h = Math.max(1, Math.ceil(Math.max(1, sqft) / w));
  return { w, h };
}

/** True when two integer foot rects share any interior area (touching edges are fine). */
export function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// Plan payload used by every read; placements exclude soft-deleted units AND
// INACTIVE units (an INACTIVE unit is out of service and must not render on
// the editor canvas, the preview modal, or the public read — while staying
// fully visible in the CMS units list and the dashboard Unit Map, which have
// their own expectations); blocks are plain name+rect rows in authored order
// (stable for the editor); boundaries are line-item polylines in sort order
// (stable for the editor).
const planInclude = {
  floor: { include: { branch: true } },
  placements: {
    where: { unit: { deletedAt: null, status: { not: 'INACTIVE' } } },
    include: { unit: { include: { size: true } } },
    orderBy: { createdAt: 'asc' },
  },
  blocks: {
    orderBy: { createdAt: 'asc' },
  },
  boundaries: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
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

function serializePlacement(p: { id: string; x: number; y: number; width: number; height: number; stackTier: number; doorEdges: string | null; unit: PlacementUnit }) {
  return {
    id: p.id,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    // Stacking tier: 0 = ground/sole tier, 1 = upper tier of a same-rect locker pair.
    stackTier: p.stackTier,
    // Authored door compass edges (N/S/E/W toggles); null = unauthored
    // (metrics bridge falls back to AUTO_ALL_EDGES for this unit).
    doorEdges: doorEdgesToArray(p.doorEdges),
    unit: serializeUnitSummary(p.unit),
  };
}

type BlockRow = { id: string; name: string; x: number; y: number; width: number; height: number; color: string | null; doorEdges: string | null };

type BoundaryRow = {
  id: string;
  label: string;
  kind: string;
  points: unknown; // JSONB [[x,y],...] polyline vertices in grid-ft units
  closed: boolean;
  sortOrder: number;
};

// Boundary points as validated [x, y] integer pairs (grid-ft units). Rows that
// fail validation normalise to [] so a malformed row can never break a read.
export function boundaryPointsOf(points: unknown): Array<[number, number]> {
  if (!Array.isArray(points)) return [];
  const out: Array<[number, number]> = [];
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    out.push([x, y]);
  }
  return out;
}

function serializeBoundary(b: BoundaryRow) {
  return {
    id: b.id,
    label: b.label,
    kind: b.kind,
    // Polyline vertices [[x,y],...] in grid-ft units (1 grid unit = 1 ft).
    points: boundaryPointsOf(b.points),
    // True once the loop is closed. Marked-area rule: closed loops AND open
    // >= 3-vertex polylines (chord-closed) feed boundaryMetrics; open 2-vertex
    // segments contribute 0 until extended/closed.
    closed: b.closed,
    sortOrder: b.sortOrder,
  };
}

function serializeBlock(b: BlockRow) {
  return {
    id: b.id,
    name: b.name,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    color: b.color,
    // Authored door edges round-trip per region; blocks are non-leasable so
    // the metrics bridge ignores them (placements carry unit doors).
    doorEdges: doorEdgesToArray(b.doorEdges),
  };
}

// ---------- boundary metrics (marked facility area -> UFA / NLA) ----------
//
// MARKED-AREA RULE (deterministic; applied identically on server and editor —
// see fpBoundaryMetricsLocal in floorplanView.js, keep the two in sync):
//   - Every boundary polyline with >= 3 vertices and nonzero shoelace area
//     contributes its chord-closed area (shoelace implicitly closes last->first,
//     so CLOSED loops and OPEN >= 3-vertex polylines count alike). Multiple
//     contributing lines are summed (non-overlapping marks assumed;
//     overlapping marks may double-count).
//   - Pencil-stroke stitching: leftover polylines (2-vertex sides, degenerate
//     rows) that share exact integer endpoints are chained via
//     chainBoundarySegments, and each resulting >= 3-vertex nonzero ring feeds
//     UFA/NLA as one loop — a square drawn as four separate strokes counts.
//   - A LONE open 2-vertex segment encloses no area and contributes 0 — a line has
//     no area, so nothing is fabricated. The editor selection strip says this
//     explicitly ("needs a 3rd vertex / close the loop to feed UFA/NLA").
// DEFINITIONS:
//   - facilityArea (marked gross, exposed as BOTH `gla` and `facilityAreaSqft`):
//     summed marked-loop area above (shoelace over grid-ft vertices;
//     1 grid unit = 1 ft so area = sqft). `gla` is kept so existing
//     `boundaries`/`boundaryMetrics` shapes stay byte-compatible; new readers
//     should prefer `facilityAreaSqft`.
//   - UFA (usable floor area): marked gross minus non-lettable obstructed
//     areas — every FloorPlanBlock rect plus the solid legacy-structure rects
//     (corridor bounding boxes, entrance/lift/stairs/fireExit rects). Thin wall
//     LINES are excluded, matching the overlap policy (unit-vs-unit only) and
//     the auto-place obstacle set (fpAutoPlaceAll `taken` minus placements).
//   - NLA (net lettable area): sum of placed-unit footprints clipped to the
//     marked loops (each placement row contributes its own rect∩loop area, so
//     both tiers of a stacked locker pair count).
//   - `gfaSqft` mirrors the plan's operator-entered GFA (null when unset);
//     `gfaSource` is 'USER' when set, 'CANVAS' when the metrics report must
//     fall back to the canvas-derived rect (see floorPlanMetricsService).
// All measures clamp ≥ 0, NLA clamps ≤ UFA, rounded to 1 decimal. With no
// contributing marked line the report is all-zero with boundaryClosed: false —
// never fabricated. `boundaryClosed` is REUSED (not renamed, additive rule):
// true means ">= 1 area-contributing marked line exists" (a closed loop OR an
// open >= 3-vertex polyline), false means "no marked area".

export type GfaSource = 'USER' | 'CANVAS';

export interface BoundaryMetrics {
  gla: number;
  ufa: number;
  nla: number;
  unit: 'sqft';
  boundaryClosed: boolean;
  /** Marked gross area (sqft) — same value as `gla`, clearer name for new readers. */
  facilityAreaSqft: number;
  /** Operator-entered plan GFA (sqft), mirrored from FloorPlan.gfaSqft; null when unset. */
  gfaSqft: number | null;
  /** 'USER' when gfaSqft is set, 'CANVAS' when the metrics report falls back to the canvas rect. */
  gfaSource: GfaSource;
}

export type FootRect = { x: number; y: number; width: number; height: number };

/** Shoelace area of a polygon in grid-ft units (= sqft). <3 vertices → 0. */
export function polygonArea(points: ReadonlyArray<readonly [number, number]>): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/**
 * Stitch endpoint-connected boundary polylines into longer chains (mirrors
 * fpChainBoundarySegments() in src/cms/admin/floorplanView.js — keep the two
 * in sync). The pencil tool persists one row per stroke, so a loop drawn as
 * several 2-vertex sides (e.g. four strokes forming a 3x3 square) never forms
 * a single >= 3-vertex row — chaining joins rows that share an exact integer
 * endpoint (either orientation) into one vertex list, repeating until no two
 * open chains share an endpoint. Closed chains (first == last vertex) are
 * final and never extended; zero-length polylines (all vertices identical)
 * carry no geometry and are skipped. Returns the chains in deterministic
 * input order; callers keep only >= 3-vertex nonzero-shoelace chains, so a
 * lone 2-vertex segment still contributes 0, and overlapping marks may
 * double-count (same non-overlapping assumption as the marked-area rule).
 */
export function chainBoundarySegments(
  segments: Array<ReadonlyArray<readonly [number, number]>>,
): Array<Array<[number, number]>> {
  const key = (p: readonly [number, number]): string => `${p[0]},${p[1]}`;
  const chains: Array<Array<[number, number]>> = [];
  for (const seg of segments) {
    const pts = seg.map(([x, y]) => [x, y] as [number, number]);
    if (pts.length < 2) continue;
    if (!pts.some(([x, y]) => x !== pts[0][0] || y !== pts[0][1])) continue;
    chains.push(pts);
  }
  const isClosed = (c: Array<[number, number]>): boolean =>
    c.length >= 2 && key(c[0]) === key(c[c.length - 1]);
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < chains.length && !merged; i++) {
      if (isClosed(chains[i])) continue;
      for (let j = 0; j < chains.length && !merged; j++) {
        if (i === j || isClosed(chains[j])) continue;
        const a = chains[i];
        const b = chains[j];
        let joined: Array<[number, number]> | null = null;
        if (key(a[a.length - 1]) === key(b[0])) joined = [...a, ...b.slice(1)];
        else if (key(a[a.length - 1]) === key(b[b.length - 1])) joined = [...a, ...b.slice(0, -1).reverse()];
        else if (key(a[0]) === key(b[b.length - 1])) joined = [...b, ...a.slice(1)];
        else if (key(a[0]) === key(b[0])) joined = [...b.slice(0, -1).reverse(), ...a];
        if (joined) {
          chains[i] = joined;
          chains.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return chains;
}

/**
 * Exact intersection area of an integer foot rect with a polygon: clips the
 * polygon to the rect (Sutherland–Hodgman, 4 half-planes) then shoelaces.
 * Handles rects partially outside the loop or canvas — only the overlap counts.
 */
export function rectPolygonArea(rect: FootRect, polygon: ReadonlyArray<readonly [number, number]>): number {
  let pts: Array<[number, number]> = polygon.map(([x, y]) => [x, y] as [number, number]);
  if (pts.length < 3) return 0;
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.width;
  const y1 = rect.y + rect.height;
  const clip = (
    input: Array<[number, number]>,
    inside: (p: [number, number]) => boolean,
    cross: (a: [number, number], b: [number, number]) => [number, number],
  ): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    if (!input.length) return out;
    let s = input[input.length - 1];
    for (const e of input) {
      const eIn = inside(e);
      const sIn = inside(s);
      if (eIn) {
        if (!sIn) out.push(cross(s, e));
        out.push(e);
      } else if (sIn) {
        out.push(cross(s, e));
      }
      s = e;
    }
    return out;
  };
  pts = clip(pts, (p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0] || 1e-9)]);
  pts = clip(pts, (p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0] || 1e-9)]);
  pts = clip(pts, (p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1] || 1e-9), y0]);
  pts = clip(pts, (p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1] || 1e-9), y1]);
  return polygonArea(pts);
}

/**
 * Solid legacy-structure footprints (mirrors fpStructureRects() in
 * src/cms/admin/floorplanView.js — keep the two in sync): corridor bounding
 * boxes expanded by half-width plus entrance/lift/stairs/fireExit rects. Thin
 * wall lines stay non-blocking, matching the overlap policy.
 */
export function solidStructureRects(structure: unknown): FootRect[] {
  const s = structure as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return [];
  const rects: FootRect[] = [];
  const corridors = Array.isArray(s.corridors) ? (s.corridors as unknown[]) : [];
  for (const c of corridors) {
    const cc = c as { pts?: unknown; w?: unknown };
    const pts = Array.isArray(cc?.pts) ? (cc.pts as Array<{ x?: unknown; y?: unknown }>) : [];
    if (pts.length < 2) continue;
    const half = (typeof cc.w === 'number' ? cc.w : 3) / 2;
    const xs = pts.map((p) => Number(p?.x)).filter((n) => Number.isFinite(n));
    const ys = pts.map((p) => Number(p?.y)).filter((n) => Number.isFinite(n));
    if (!xs.length || !ys.length) continue;
    const x0 = Math.floor(Math.min(...xs) - half);
    const y0 = Math.floor(Math.min(...ys) - half);
    const x1 = Math.ceil(Math.max(...xs) + half);
    const y1 = Math.ceil(Math.max(...ys) + half);
    rects.push({ x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) });
  }
  for (const key of ['entrance', 'lift', 'stairs', 'fireExit']) {
    const d = s[key] as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
    if (!d || typeof d !== 'object') continue;
    rects.push({
      x: Math.floor(Number(d.x) || 0),
      y: Math.floor(Number(d.y) || 0),
      width: Math.max(1, Math.ceil(Number(d.w) || 2)),
      height: Math.max(1, Math.ceil(Number(d.h) || 2)),
    });
  }
  return rects;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * Boundary metrics for one plan. Inputs are plain rects/polylines so the
 * editor can reuse this definition client-side (see fpBoundaryMetricsLocal in
 * floorplanView.js — keep the two in sync). Marked-area rule: every polyline
 * with >= 3 vertices and nonzero shoelace area contributes its chord-closed
 * area (closed loops and open >= 3-vertex polylines alike), plus stitched
 * rings chained from endpoint-connected leftover strokes (so a loop drawn as
 * separate 2-vertex sides counts); a lone open 2-vertex segment contributes 0
 * (a line encloses no area — never fabricated).
 */
export function computeBoundaryMetrics(input: {
  boundaries: Array<{ points: unknown; closed: boolean }>;
  blocks: FootRect[];
  structure: unknown;
  placements: FootRect[];
  gfaSqft?: number | null;
}): BoundaryMetrics {
  const validated = input.boundaries
    .map((b) => boundaryPointsOf(b.points))
    .filter((pts) => pts.length >= 2 && pts.some(([x, y]) => x !== pts[0][0] || y !== pts[0][1]));
  const direct = validated.filter((pts) => pts.length >= 3 && polygonArea(pts) > 0);
  const leftover = validated.filter((pts) => !(pts.length >= 3 && polygonArea(pts) > 0));
  const stitched = chainBoundarySegments(leftover).filter((pts) => pts.length >= 3 && polygonArea(pts) > 0);
  const loops = [...direct, ...stitched];
  const gfaSqft = input.gfaSqft ?? null;
  const gfaSource: GfaSource = gfaSqft != null ? 'USER' : 'CANVAS';
  if (!loops.length) {
    return { gla: 0, ufa: 0, nla: 0, unit: 'sqft', boundaryClosed: false, facilityAreaSqft: 0, gfaSqft, gfaSource };
  }
  const obstacles: FootRect[] = [...input.blocks, ...solidStructureRects(input.structure)];
  let gla = 0;
  let ufa = 0;
  let nla = 0;
  for (const loop of loops) {
    const gross = polygonArea(loop);
    gla += gross;
    const blocked = obstacles.reduce((sum, r) => sum + rectPolygonArea(r, loop), 0);
    ufa += Math.max(0, gross - blocked);
    nla += input.placements.reduce((sum, r) => sum + rectPolygonArea(r, loop), 0);
  }
  const ufaClamped = Math.max(0, ufa);
  const glaRounded = round1(Math.max(0, gla));
  return {
    gla: glaRounded,
    ufa: round1(ufaClamped),
    // NLA is lettable footprint inside the marked loops — it can never exceed UFA.
    nla: round1(Math.min(Math.max(0, nla), ufaClamped)),
    unit: 'sqft',
    boundaryClosed: true,
    facilityAreaSqft: glaRounded,
    gfaSqft,
    gfaSource,
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
    // Facility-boundary line items (grid-ft polylines) in editor sort order.
    boundaries: p.boundaries.map(serializeBoundary),
    // Operator-entered gross floor area (sqft); null when unset — the metrics
    // report then falls back to the canvas-derived rect (gfaSource 'CANVAS').
    gfaSqft: p.gfaSqft ?? null,
    gfaSource: (p.gfaSqft ?? null) != null ? ('USER' as const) : ('CANVAS' as const),
    // Marked facility area -> UFA / NLA (see computeBoundaryMetrics for the
    // marked-area rule). All-zero with boundaryClosed: false when no marked
    // line contributes area — never fabricated.
    boundaryMetrics: computeBoundaryMetrics({
      boundaries: p.boundaries,
      blocks: p.blocks,
      structure: p.structure,
      placements: p.placements,
      gfaSqft: p.gfaSqft ?? null,
    }),
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

// ---------- authored door edges (Phase 3) ----------

const DOOR_EDGE_ORDER = ['N', 'S', 'E', 'W'] as const;
export type DoorEdge = (typeof DOOR_EDGE_ORDER)[number];

/**
 * Normalise an authored door-edge selection for storage. `undefined` means
 * "not supplied — keep the current value" (upsert endpoints); `null` clears
 * back to unauthored; an array stores the canonical CSV subset in compass
 * order (e.g. ["S","N"] -> "N,S"). Anything outside N/S/E/W is 400.
 */
export function normalizeDoorEdges(input: readonly string[] | null | undefined): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const set = new Set<string>();
  for (const e of input) {
    if (e !== 'N' && e !== 'S' && e !== 'E' && e !== 'W') {
      throw new AppError(400, 'VALIDATION', `doorEdges must be a subset of ["N","S","E","W"] — got ${JSON.stringify(e)}`);
    }
    set.add(e);
  }
  if (set.size === 0) {
    throw new AppError(400, 'VALIDATION', 'doorEdges must list at least one compass edge, or be null to clear');
  }
  return DOOR_EDGE_ORDER.filter((e) => set.has(e)).join(',');
}

/** Stored canonical CSV ("N,S") -> authored edge array; NULL/empty -> null (unauthored). */
export function doorEdgesToArray(stored: string | null | undefined): DoorEdge[] | null {
  if (stored == null) return null;
  const parts = stored
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s === 'N' || s === 'S' || s === 'E' || s === 'W') as DoorEdge[];
  return parts.length > 0 ? parts : null;
}

// ---------- API ----------

export interface UpsertFloorPlanInput {
  width?: number;
  height?: number;
  structure?: unknown; // any JSON value (JSONB); null clears it
  // Operator-entered GFA in sqft: a positive finite number (rounded to 1dp,
  // capped at MAX_GFA_SQFT); null clears back to unset; omitted keeps the
  // current value. Additive — old clients simply omit it.
  gfaSqft?: number | null;
}

// Sanity cap for an operator-entered GFA (sqft): far above the largest
// canvas-derived rect (500x500 ft) while still rejecting garbage/typos.
export const MAX_GFA_SQFT = 10000000;

function checkGfaSqft(v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_GFA_SQFT) {
    throw new AppError(400, 'VALIDATION', `GFA must be a positive number of sqft (up to ${MAX_GFA_SQFT}) — got ${JSON.stringify(v)}`);
  }
  return Math.round(v * 10) / 10;
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
  if (input.gfaSqft !== undefined) {
    update.gfaSqft = input.gfaSqft === null ? null : checkGfaSqft(input.gfaSqft);
  }

  const create: Prisma.FloorPlanCreateInput = {
    floor: { connect: { id: floorId } },
    width: input.width !== undefined ? checkCanvasDim(input.width, 'width') : CANVAS_DEFAULTS.width,
    height: input.height !== undefined ? checkCanvasDim(input.height, 'height') : CANVAS_DEFAULTS.height,
    ...(input.gfaSqft !== undefined && input.gfaSqft !== null ? { gfaSqft: checkGfaSqft(input.gfaSqft) } : {}),
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
 * unit code/name/size/status (soft-deleted AND inactive units filtered out),
 * plus the floor's unplaced units (same filters — INACTIVE units stay out of
 * the editor palette). If no plan exists yet, returns an empty scaffold
 * so an editor can start fresh — callers decide how to present it.
 */
export async function getFloorPlan(floorId: string) {
  const floor = await prisma.floor.findUnique({ where: { id: floorId }, include: { branch: true } });
  if (!floor) throw new AppError(404, 'NOT_FOUND', `Floor ${floorId} not found`);

  const plan = await prisma.floorPlan.findFirst({ where: { floorId }, include: planInclude });
  const unplacedUnits = await prisma.unit.findMany({
    where: { floorId, deletedAt: null, status: { not: 'INACTIVE' }, placement: { is: null } },
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
  // Stacking tier: 0 = ground/sole tier (default), 1 = upper tier of a
  // same-rect locker pair. Omitted on update keeps the placement's tier.
  stackTier?: number;
  // Authored door compass edges (editor N/S/E/W toggles): omitted keeps the
  // placement's edges, null clears back to unauthored (AUTO_ALL_EDGES in
  // metrics), an array replaces. Additive — old clients simply omit it.
  doorEdges?: DoorEdge[] | null;
}

// Only tiers 0 and 1 exist — lockers stack at most 2 high (upper + lower).

// Stacking is lockers-only (per owner): both units sharing a rect must be
// LOCKER size. Compared case-insensitively against the UnitSize code.
function isLockerSize(sizeCode: string | null | undefined): boolean {
  return String(sizeCode || '').toUpperCase() === 'LOCKER';
}

function checkStackTier(tier: number): 0 | 1 {
  if (tier !== 0 && tier !== 1) {
    throw new AppError(400, 'VALIDATION', `stackTier must be 0 (ground/sole tier) or 1 (upper tier of a stacked pair) — got ${tier}`);
  }
  return tier;
}

/**
 * Demote orphaned upper tiers on one rect back to ground singles. Called after
 * a ground-tier placement moves off (or is deleted from) its rect: any tier-1
 * placement left on that rect with no tier-0 partner would otherwise be a lone
 * upper, which writes reject — so it becomes a standalone tier-0 single.
 * Keeps "delete tier-1 or move restores single" true with a single write.
 */
async function demoteOrphanedUppers(
  floorPlanId: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const orphans = await prisma.unitPlacement.findMany({
    where: {
      floorPlanId,
      stackTier: 1,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    select: { id: true },
  });
  for (const orphan of orphans) {
    const groundRemains = await prisma.unitPlacement.count({
      where: {
        floorPlanId,
        stackTier: 0,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
    });
    if (groundRemains === 0) {
      await prisma.unitPlacement.update({ where: { id: orphan.id }, data: { stackTier: 0 } });
    }
  }
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
 * belongs to the plan's floor and is neither soft-deleted nor INACTIVE, that the geometry
 * fits inside the canvas, that the drawn area is within AREA_TOLERANCE of the
 * unit's sqft (P3), and that the rect does not overlap another unit's
 * placement (409 PLACEMENT_OVERLAP — client pre-checks the same rule and
 * rejects with a toast). Never touches the Unit row.
 *
 * STACKING (lockers only): two locker placements may share the EXACT same
 * rect as an upper/lower pair (`stackTier` 0 + 1). Rules enforced here:
 *   - `stackTier` is 0 or 1 only (anything else is 400 VALIDATION);
 *   - omitted on update keeps the placement's current tier (0 on create);
 *   - tier 1 requires a tier-0 partner on the same rect (lone tier 1 is 400);
 *   - a rect holding tiers 0 + 1 rejects any further placement (409);
 *   - both units sharing a rect must be LOCKER size (else 400, lockers-only);
 *   - paired drag/resize moves the ground tier first, then the upper tier
 *     onto the same new rect (the upper's write needs its partner present).
 * Moving a ground tier off its rect (or deleting it) demotes a leftover upper
 * to a standalone tier-0 single, so "move restores single" holds.
 */
export async function setUnitPlacement(floorId: string, unitId: string, geom: PlacementGeometry) {
  checkGeometry(geom);

  const unit = await prisma.unit.findUnique({ where: { id: unitId }, include: { size: true } });
  if (!unit) throw new AppError(404, 'NOT_FOUND', `Unit ${unitId} not found`);
  if (unit.deletedAt) {
    throw new AppError(400, 'VALIDATION', `Unit ${unit.unitCode} is deleted and cannot be placed on a plan`);
  }
  // INACTIVE units never render on a plan (reads filter them out) — refuse the
  // placement instead of writing invisible geometry. Reactivate the unit first
  // to place it; a unit deactivated while placed keeps its row but stays hidden
  // until reactivated.
  if (unit.status === 'INACTIVE') {
    throw new AppError(400, 'VALIDATION', `Unit ${unit.unitCode} is INACTIVE and cannot be placed on a plan — reactivate it first`);
  }
  if (unit.floorId !== floorId) {
    throw new AppError(400, 'VALIDATION', `Unit ${unit.unitCode} does not belong to floor ${floorId}`);
  }

  const existing = await prisma.unitPlacement.findUnique({ where: { unitId } });
  const tier = geom.stackTier === undefined ? (existing?.stackTier ?? 0) : checkStackTier(geom.stackTier);
  const doorEdges = normalizeDoorEdges(geom.doorEdges); // undefined = keep, null = clear, CSV = replace

  const plan = await ensureCanvasPlan(floorId);

  // Sibling placements on this plan (self excluded — the upsert key is unitId,
  // so this covers both place and move). Carries each sibling's tier + size
  // for the stacking rules below.
  const siblings = await prisma.unitPlacement.findMany({
    where: { floorPlanId: plan.id, unitId: { not: unitId } },
    select: {
      id: true,
      x: true,
      y: true,
      width: true,
      height: true,
      stackTier: true,
      unit: { select: { unitCode: true, size: { select: { code: true } } } },
    },
  });
  const isSameRect = (s: { x: number; y: number; width: number; height: number }) =>
    s.x === geom.x && s.y === geom.y && s.width === geom.width && s.height === geom.height;
  const sameRect = siblings.filter(isSameRect);
  const rectLabel = `${geom.x},${geom.y} ${geom.width}×${geom.height}`;
  const selfIsLocker = isLockerSize(unit.size.code);

  // Same-rect stacking rules run BEFORE the area/canvas/overlap checks so a
  // stack attempt gets its specific error (lone tier 1, third tier,
  // lockers-only) rather than a generic area/overlap message. Same-rect writes
  // were always rejected before stacking existed, so no valid write changes
  // meaning — only the error gets more precise.
  if (tier === 1) {
    const ground = sameRect.find((s) => s.stackTier === 0);
    if (!ground) {
      throw new AppError(
        400,
        'VALIDATION',
        `Cannot place ${unit.unitCode} as upper tier (stackTier 1) at ${rectLabel} — no ground-tier (stackTier 0) placement shares that exact rect. Place the ground locker first, then stack onto it.`,
      );
    }
    if (sameRect.some((s) => s.stackTier === 1)) {
      throw new AppError(
        409,
        'PLACEMENT_OVERLAP',
        `Placement ${rectLabel} already holds a stacked pair (${ground.unit.unitCode} + upper tier) — lockers stack at most 2 high. Move to a free spot`,
      );
    }
    if (!selfIsLocker || !isLockerSize(ground.unit.size.code)) {
      throw new AppError(
        400,
        'VALIDATION',
        `Cannot stack ${unit.unitCode} with ${ground.unit.unitCode} at ${rectLabel} — stacking is lockers-only (both units must be LOCKER size)`,
      );
    }
  } else {
    const ground = sameRect.find((s) => s.stackTier === 0);
    if (ground) {
      throw new AppError(
        409,
        'PLACEMENT_OVERLAP',
        `Placement ${rectLabel} overlaps ${ground.unit.unitCode} (${ground.x},${ground.y} ${ground.width}×${ground.height}) — move to a free spot`,
      );
    }
    const upper = sameRect.find((s) => s.stackTier === 1);
    if (upper && (!selfIsLocker || !isLockerSize(upper.unit.size.code))) {
      throw new AppError(
        400,
        'VALIDATION',
        `Cannot share rect ${rectLabel} with ${upper.unit.unitCode} — stacking is lockers-only (both units must be LOCKER size)`,
      );
    }
    if (sameRect.length > 1) {
      throw new AppError(
        409,
        'PLACEMENT_OVERLAP',
        `Placement ${rectLabel} already holds a stacked pair — lockers stack at most 2 high. Move to a free spot`,
      );
    }
  }

  // General overlap: every overlapping sibling rejects, EXCEPT the same-rect
  // stack mate (same rect, differing tier — allowed by the rules above).
  // Blocks are decoration and may underlay, so only unit-vs-unit is checked.
  const exemptIds = new Set(sameRect.filter((s) => s.stackTier !== tier).map((s) => s.id));
  // Pair-move exemption: a ground tier that currently shares its exact rect
  // with an upper-tier mate is being moved as one block — the editor's paired
  // drag/resize/rotate writes the ground tier first, then the upper onto the
  // same new rect. While the first write lands, the mate still sits on the OLD
  // rect, so an in-place rotation (or a small nudge) legitimately overlaps the
  // mate's stale rect — exempt that ONE mate placement (by id). Genuine
  // collisions with any other unit still 409, and the upper's follow-up write
  // is re-validated (tier-1 rules require the ground on the new rect).
  if (
    tier === 0 &&
    existing &&
    existing.floorPlanId === plan.id &&
    existing.stackTier === 0 &&
    (existing.x !== geom.x || existing.y !== geom.y || existing.width !== geom.width || existing.height !== geom.height)
  ) {
    const mate = siblings.find(
      (s) =>
        s.stackTier === 1 &&
        s.x === existing.x &&
        s.y === existing.y &&
        s.width === existing.width &&
        s.height === existing.height,
    );
    if (mate) exemptIds.add(mate.id);
  }
  const hit = siblings.find((s) => !exemptIds.has(s.id) && rectsOverlap(geom, s));
  if (hit) {
    throw new AppError(
      409,
      'PLACEMENT_OVERLAP',
      `Placement ${rectLabel} overlaps ${hit.unit.unitCode} (${hit.x},${hit.y} ${hit.width}×${hit.height}) — move to a free spot`,
    );
  }

  // P3: drawn area (square feet, 1 unit = 1 ft) must approximate the unit's
  // real sqft. Grandfathered rows only hit this when re-saved — the editor's
  // lock-to-sqft resize and true-size ghost keep new writes inside the band.
  // Runs after the stacking/overlap rules so stack attempts report their
  // specific error first.
  const area = geom.width * geom.height;
  const deviation = Math.abs(area - unit.sqft) / Math.max(1, unit.sqft);
  if (deviation > AREA_TOLERANCE) {
    const pct = Math.round(deviation * 100);
    const fp = sqftFootprint(unit.sqft, unit.size.code, unit.size.widthFt, unit.size.heightFt);
    throw new AppError(
      400,
      'VALIDATION',
      `Placement ${geom.width}×${geom.height} (= ${area} sq ft) deviates ${pct}% from unit ${unit.unitCode}'s ${unit.sqft} sqft (tolerance ${Math.round(AREA_TOLERANCE * 100)}%) — use ~${fp.w}×${fp.h} ft`,
    );
  }

  if (geom.x + geom.width > plan.width || geom.y + geom.height > plan.height) {
    throw new AppError(
      400,
      'VALIDATION',
      `Placement ${geom.x},${geom.y} ${geom.width}×${geom.height} exceeds the ${plan.width}×${plan.height} ft canvas for floor ${floorId} — enlarge the canvas first`,
    );
  }

  const placement = await prisma.unitPlacement.upsert({
    where: { unitId },
    create: {
      floorPlanId: plan.id,
      unitId,
      x: geom.x,
      y: geom.y,
      width: geom.width,
      height: geom.height,
      stackTier: tier,
      ...(doorEdges !== undefined ? { doorEdges } : {}),
    },
    update: {
      x: geom.x,
      y: geom.y,
      width: geom.width,
      height: geom.height,
      stackTier: tier,
      ...(doorEdges !== undefined ? { doorEdges } : {}),
    },
    include: { unit: { include: { size: true } } },
  });

  // A ground tier moving off its rect orphans its upper tier — demote the
  // leftover upper to a standalone ground single (never leave a lone tier 1).
  if (
    existing &&
    existing.floorPlanId === plan.id &&
    existing.stackTier === 0 &&
    (existing.x !== geom.x || existing.y !== geom.y || existing.width !== geom.width || existing.height !== geom.height)
  ) {
    await demoteOrphanedUppers(plan.id, { x: existing.x, y: existing.y, width: existing.width, height: existing.height });
  }

  return serializePlacement(placement);
}

/** Remove a unit's placement (geometry only — never soft-deletes the Unit).
 * Deleting a ground tier demotes a leftover upper tier on the same rect to a
 * standalone ground single (never leaves a lone tier 1); deleting the upper
 * tier restores the ground placement to a single. */
export async function removeUnitPlacement(floorId: string, unitId: string) {
  const plan = await prisma.floorPlan.findUnique({ where: { floorId } });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `No floor plan exists for floor ${floorId}`);
  const placement = await prisma.unitPlacement.findUnique({ where: { unitId } });
  if (!placement || placement.floorPlanId !== plan.id) {
    throw new AppError(404, 'NOT_FOUND', `Unit ${unitId} has no placement on the floor ${floorId} plan`);
  }
  await prisma.unitPlacement.delete({ where: { unitId } });
  if (placement.stackTier === 0) {
    await demoteOrphanedUppers(plan.id, { x: placement.x, y: placement.y, width: placement.width, height: placement.height });
  }
  return { floorId, unitId, removed: true };
}

export interface BlockInput {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string | null; // optional render tint (hex); renderers default when null
  // Authored door compass edges, same keep/clear/replace semantics as
  // placements (round-tripped per region; non-leasable so metrics ignores).
  doorEdges?: DoorEdge[] | null;
}

/**
 * Create a layout-decoration block on a floor's plan. Blocks are plain name+rect
 * primitives (no polymorphism like the legacy `structure` markers), so each one
 * is its own row — addressable for drag/resize/rename/delete.
 */
export async function createFloorPlanBlock(floorId: string, input: BlockInput) {
  checkBlockName(input.name);
  checkGeometry(input);
  const doorEdges = normalizeDoorEdges(input.doorEdges);
  const plan = await ensureCanvasPlan(floorId);
  if (input.x + input.width > plan.width || input.y + input.height > plan.height) {
    throw new AppError(
      400,
      'VALIDATION',
      `Block ${input.x},${input.y} ${input.width}×${input.height} exceeds the ${plan.width}×${plan.height} ft canvas for floor ${floorId} — enlarge the canvas first`,
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
      ...(doorEdges !== undefined ? { doorEdges } : {}),
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
  const doorEdges = normalizeDoorEdges(input.doorEdges);
  const plan = await ensureCanvasPlan(floorId);
  if (input.x + input.width > plan.width || input.y + input.height > plan.height) {
    throw new AppError(
      400,
      'VALIDATION',
      `Block ${input.x},${input.y} ${input.width}×${input.height} exceeds the ${plan.width}×${plan.height} ft canvas for floor ${floorId} — enlarge the canvas first`,
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
        ...(doorEdges !== undefined ? { doorEdges } : {}),
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
      ...(doorEdges !== undefined ? { doorEdges } : {}),
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

// ---------- facility-boundary line items ----------

function checkBoundaryLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed || trimmed.length > 80) {
    throw new AppError(400, 'VALIDATION', 'Boundary label must be a non-empty string of at most 80 characters');
  }
  return trimmed;
}

function checkBoundaryKind(kind: string | null | undefined): string {
  if (kind == null) return 'BOUNDARY';
  const trimmed = kind.trim();
  if (!trimmed || trimmed.length > 24) {
    throw new AppError(400, 'VALIDATION', 'Boundary kind must be a non-empty string of at most 24 characters');
  }
  return trimmed;
}

function checkBoundarySortOrder(sortOrder: number | null | undefined): number | undefined {
  if (sortOrder == null) return undefined;
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) {
    throw new AppError(400, 'VALIDATION', 'Boundary sortOrder must be an integer between 0 and 100000');
  }
  return sortOrder;
}

// Strict polyline validation: an array of [x, y] integer-foot pairs (2+
// vertices; 3+ distinct vertices when closed). Vertices must sit on the canvas
// (edges included) — enlarge the canvas first, same contract as blocks.
function checkBoundaryPoints(points: unknown, closed: boolean, plan: { width: number; height: number }): Array<[number, number]> {
  if (!Array.isArray(points)) {
    throw new AppError(400, 'VALIDATION', 'Boundary points must be an array of [x, y] integer pairs');
  }
  if (points.length < 2) {
    throw new AppError(400, 'VALIDATION', 'Boundary points must list at least 2 vertices');
  }
  if (points.length > 500) {
    throw new AppError(400, 'VALIDATION', 'Boundary points must list at most 500 vertices');
  }
  const out: Array<[number, number]> = [];
  for (const p of points) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || !Number.isInteger(p[1])) {
      throw new AppError(400, 'VALIDATION', 'Boundary points must be an array of [x, y] integer pairs');
    }
    const [x, y] = p as [number, number];
    if (x < 0 || y < 0 || x > plan.width || y > plan.height) {
      throw new AppError(
        400,
        'VALIDATION',
        `Boundary vertex ${x},${y} sits outside the ${plan.width}×${plan.height} ft canvas for this plan — enlarge the canvas first`,
      );
    }
    out.push([x, y]);
  }
  if (closed) {
    const distinct = new Set(out.map(([x, y]) => `${x},${y}`));
    if (distinct.size < 3) {
      throw new AppError(400, 'VALIDATION', 'A closed boundary needs at least 3 distinct vertices — keep drawing or save it open');
    }
  }
  return out;
}

export interface BoundaryInput {
  label?: string;
  kind?: string | null;
  points?: unknown;
  closed?: boolean;
  sortOrder?: number | null;
}

/** List a floor's boundary line items (editor sort order). Empty when no plan exists yet. */
export async function listFloorPlanBoundaries(floorId: string) {
  const plan = await prisma.floorPlan.findUnique({
    where: { floorId },
    include: { boundaries: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
  });
  if (!plan) return [];
  return plan.boundaries.map(serializeBoundary);
}

/**
 * Create a boundary line item on a floor's plan. The plan is lazily created at
 * the default canvas when the floor has none yet (same as blocks). `closed`
 * defaults to false — an open polyline persists honestly. Marked-area rule:
 * >= 3-vertex polylines (open or closed) feed boundaryMetrics via chord-close;
 * a 2-vertex segment contributes 0 until it is extended/closed.
 */
export async function createFloorPlanBoundary(floorId: string, input: BoundaryInput) {
  const plan = await ensureCanvasPlan(floorId);
  const label = input.label === undefined ? 'Boundary' : checkBoundaryLabel(input.label);
  const kind = checkBoundaryKind(input.kind);
  const closed = input.closed ?? false;
  if (input.points === undefined) {
    throw new AppError(400, 'VALIDATION', 'Boundary points must be an array of [x, y] integer pairs');
  }
  const points = checkBoundaryPoints(input.points, closed, plan);
  const sortOrder = checkBoundarySortOrder(input.sortOrder) ?? 0;
  const boundary = await prisma.floorPlanBoundary.create({
    data: { floorPlanId: plan.id, label, kind, points, closed, sortOrder },
  });
  return serializeBoundary(boundary);
}

/**
 * Update a boundary line item scoped to the floor's plan (vertex drag / close
 * loop / rename persistence). Omitted fields keep their values; `points`
 * replaces the whole polyline. A boundary id on a DIFFERENT plan 404s.
 */
export async function updateFloorPlanBoundary(floorId: string, boundaryId: string, input: BoundaryInput) {
  const plan = await prisma.floorPlan.findUnique({ where: { floorId } });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `No floor plan exists for floor ${floorId}`);
  const existing = await prisma.floorPlanBoundary.findUnique({ where: { id: boundaryId } });
  if (!existing || existing.floorPlanId !== plan.id) {
    throw new AppError(404, 'NOT_FOUND', `Boundary ${boundaryId} does not belong to floor ${floorId}'s plan`);
  }
  const closed = input.closed ?? existing.closed;
  const data: Prisma.FloorPlanBoundaryUpdateInput = {};
  if (input.label !== undefined) data.label = checkBoundaryLabel(input.label);
  if (input.kind !== undefined) data.kind = checkBoundaryKind(input.kind);
  if (input.sortOrder !== undefined) {
    const sortOrder = checkBoundarySortOrder(input.sortOrder);
    if (sortOrder !== undefined) data.sortOrder = sortOrder;
  }
  if (input.points !== undefined) {
    data.points = checkBoundaryPoints(input.points, closed, plan);
  } else if (input.closed === true) {
    // Closing without new vertices still needs 3+ distinct points.
    checkBoundaryPoints(boundaryPointsOf(existing.points), true, plan);
  }
  data.closed = closed;
  const boundary = await prisma.floorPlanBoundary.update({ where: { id: boundaryId }, data });
  return serializeBoundary(boundary);
}

/** Remove a boundary line item (scoped to the plan; cross-plan ids 404). */
export async function removeFloorPlanBoundary(floorId: string, boundaryId: string) {
  const plan = await prisma.floorPlan.findUnique({ where: { floorId } });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `No floor plan exists for floor ${floorId}`);
  const boundary = await prisma.floorPlanBoundary.findUnique({ where: { id: boundaryId } });
  if (!boundary || boundary.floorPlanId !== plan.id) {
    throw new AppError(404, 'NOT_FOUND', `Boundary ${boundaryId} does not belong to floor ${floorId}'s plan`);
  }
  await prisma.floorPlanBoundary.delete({ where: { id: boundaryId } });
  return { floorId, boundaryId, removed: true };
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
 * unitCode/name/size/status, soft-deleted AND inactive units filtered out. No
 * tenant/PII/rates anywhere (serializePlan is public-safe).
 */
export async function getPublicFloorPlan(branchCode: string, level: number) {
  const floor = await prisma.floor.findFirst({
    where: { branch: { code: branchCode }, level },
    include: { branch: true },
  });
  if (!floor) throw new AppError(404, 'NOT_FOUND', `Floor ${level} not found at branch ${branchCode}`);
  // An inactive floor has no public presence — the booking renderer must not
  // draw it (same 404 as a missing floor; admin reads are unaffected).
  if (!floor.isActive) {
    throw new AppError(404, 'NOT_FOUND', `Floor ${level} not found at branch ${branchCode}`);
  }

  const plan = await prisma.floorPlan.findFirst({ where: { floorId: floor.id }, include: planInclude });
  return {
    branch: { id: floor.branchId, code: floor.branch.code, name: floor.branch.name },
    floor: { id: floor.id, level: floor.level, name: floor.name },
    plan: plan ? serializePlan(plan) : null,
  };
}
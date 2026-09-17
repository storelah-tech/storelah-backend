// StoreLah — Floor plan area metrics core (Phase 1: pure geometry + computation).
//
// PURE module: no prisma, no express, no I/O. All geometry is integer-exact:
//
//   - Canonical base unit = a tenth of a millimetre. 1 ft = 304.8 mm exactly,
//     so 1 ft = 3048 base units EXACTLY. Ingress converts feet -> base with
//     Math.round(feet * 3048) (exact for integer feet and inch multiples).
//   - 1-inch snap grid = 3048 / 12 = 254 base units EXACTLY.
//   - Areas accumulate in BigInt. Because clear dimensions can be half base
//     units (wall thickness is split across a centreline), the canonical area
//     unit is the QUARTER base-unit-squared, so every area stays an exact
//     BigInt: rectAreaQ(w, d) = 4*w*d; clearAreaQ = cw2*cd2 where cw2/cd2 are
//     full widths measured in half base units. Q_PER_SQFT = 4 * 3048^2.
//   - Floating point appears ONLY at the display boundary (areaQToSqft and the
//     efficiency / load-factor / variance ratios). Geometry never uses it.
//
// Measurement conventions (see research note in the Phase 1 report):
//   - GFA: outline shoelace minus holes minus inside-outline UNIT_OUTDOOR /
//     NON_ENCLOSED rects. Outdoor bays are leasable but excluded from GFA.
//   - UFA: GFA minus STRUCTURAL / CIRCULATION_VERTICAL / PLANT_MECHANICAL /
//     RESTROOM rects minus the exterior-wall band (outline+hole perimeter x
//     exterior thickness, perimeter-band method: corners are double-counted
//     by construction — documented, deterministic, and exact in integers).
//   - NLA_enclosed: billable sum over enclosed leasable kinds
//     (UNIT_STORAGE, UNIT_PARKING_INDOOR, LOCKER incl. stacked levels,
//     OFFICE_RETAIL). NLA_outdoor: UNIT_OUTDOOR billable sum.
//   - GLA is reported BOTH ways, always tagged: exclusive (= NLA_total) and
//     inclusive (= NLA_total + COMMON, where COMMON = circulation kinds +
//     LOADING_BAY + derived circulation). This dual tagging is the whole
//     point of the inclusive-vs-exclusive convention split.
//   - efficiency = NLA_enclosed / GFA; load_factor = GLA_inclusive / NLA_total.
//
// Relation to src/core/floorPlans.ts: that module owns the persisted
// integer-FOOT editor canvas (placements/blocks). This module owns metric
// computation on ingress feet values and never touches the DB. A later phase
// (API/snapshots/UI) may bridge the two; Phase 1 deliberately does not.

import { createHash } from 'node:crypto';
import { AppError } from '../lib/http';

// ---------- integer base ----------

/** Base units per foot: 1 ft = 304.8 mm = 3048 tenths-of-a-mm, exactly. */
export const BASE_PER_FOOT = 3048;
/** 1-inch snap grid in base units: 3048 / 12 = 254, exactly. */
export const INCH_SNAP = 254;
/** Quarter-base-units-squared per square foot: 4 * 3048^2 = 37,161,216. */
export const Q_PER_SQFT = 37161216n;
/** Sliver threshold: circulation components below 0.25 sqft are dropped. */
export const SLIVER_MIN_Q = Q_PER_SQFT / 4n; // 9,290,304 Q, exact
/** Nominal-variance warn threshold, percent. */
export const NOMINAL_VARIANCE_WARN_PCT = 5;
/** Tessellation cell-count guard against pathological inputs. */
const MAX_CELLS = 4_000_000;

/** Feet -> base units on ingress. Exact for integer feet/inch multiples. */
export function feetToBase(feet: number): number {
  if (!Number.isFinite(feet)) throw new AppError(400, 'VALIDATION', `Dimension must be finite, got ${feet}`);
  return Math.round(feet * BASE_PER_FOOT);
}

/** Snap a base-unit coordinate to the 1-inch grid (nearest multiple of 254). */
export function snapToInch(base: number): number {
  return Math.round(base / INCH_SNAP) * INCH_SNAP;
}

/** True when a base-unit coordinate sits exactly on the 1-inch grid. */
export function isOnInchGrid(base: number): boolean {
  return base % INCH_SNAP === 0;
}

/** Exact rect area in Q (quarter-base-units^2) from base-unit side lengths. */
export function rectAreaQ(wBase: number, dBase: number): bigint {
  return 4n * BigInt(wBase) * BigInt(dBase);
}

/** Display conversion ONLY: Q -> square feet (float, boundary use only). */
export function areaQToSqft(q: bigint): number {
  return Number(q) / Number(Q_PER_SQFT);
}

// ---------- vocabulary ----------

export const REGION_KINDS = [
  'UNIT_STORAGE',
  'UNIT_PARKING_INDOOR',
  'UNIT_OUTDOOR',
  'LOCKER',
  'CIRCULATION_AISLE',
  'CIRCULATION_VERTICAL',
  'LOADING_BAY',
  'OFFICE_RETAIL',
  'RESTROOM',
  'PLANT_MECHANICAL',
  'STRUCTURAL',
  'NON_ENCLOSED',
] as const;
export type RegionKind = (typeof REGION_KINDS)[number];

/** Enclosed leasable kinds: billable sum -> NLA_enclosed. */
export const LEASABLE_ENCLOSED: ReadonlySet<RegionKind> = new Set([
  'UNIT_STORAGE',
  'UNIT_PARKING_INDOOR',
  'LOCKER',
  'OFFICE_RETAIL',
]);
/** Outdoor leasable kinds: billable sum -> NLA_outdoor, excluded from GFA. */
export const LEASABLE_OUTDOOR: ReadonlySet<RegionKind> = new Set(['UNIT_OUTDOOR']);
/** Kinds deducted from GFA to reach UFA (plus the exterior-wall band). */
export const UFA_DEDUCT_KINDS: ReadonlySet<RegionKind> = new Set([
  'STRUCTURAL',
  'CIRCULATION_VERTICAL',
  'PLANT_MECHANICAL',
  'RESTROOM',
]);
/** Shared non-leasable kinds counted into COMMON (hence GLA_inclusive). */
export const COMMON_KINDS: ReadonlySet<RegionKind> = new Set([
  'CIRCULATION_AISLE',
  'CIRCULATION_VERTICAL',
  'LOADING_BAY',
]);
/**
 * Region-to-circulation connectivity (Phase 3): designated circulation-kind
 * regions are TRAVERSABLE — the reachability flood fill runs over free
 * (derived-circulation) cells UNION circulation-kind region cells, seeded
 * from building entrances. A spanning Corridor block therefore JOINS the
 * derived components on either side instead of splitting them (the seeded
 * floors publish again). Every other covered kind (units, offices, plant,
 * restrooms, structure, …) stays an obstacle, so doors opening into units or
 * walls still resolve to nothing. Dropped slivers stay non-walkable (too
 * small to walk through). Derived-circulation areas/counts are untouched —
 * only the connectivity graph changes, so all Phase-1 exact values hold.
 */
export const CIRCULATION_TRAVERSABLE_KINDS: ReadonlySet<RegionKind> = new Set([
  'CIRCULATION_AISLE',
  'CIRCULATION_VERTICAL',
  'LOADING_BAY',
]);
/** Inside-outline rects of these kinds are subtracted from GFA. */
export const GFA_EXCLUDE_INSIDE: ReadonlySet<RegionKind> = new Set(['UNIT_OUTDOOR', 'NON_ENCLOSED']);

export const WALL_KINDS = ['partition', 'demising', 'exterior', 'none'] as const;
export type WallKind = (typeof WALL_KINDS)[number];

/**
 * Per-edge wall thickness in feet. partition ~= 6.3mm mesh/partition panels,
 * demising = 0.5 ft masonry compartment walls, exterior = 0.667 ft (8 in)
 * facade. `none` (0) is an extension for outdoor/open edges with no wall.
 * Converted to integer base units on ingress via feetToBase.
 */
export const WALL_THICKNESS_FEET: Record<WallKind, number> = {
  partition: 0.0208,
  demising: 0.5,
  exterior: 0.667,
  none: 0,
};

export const PRICING_BASES = ['NOMINAL', 'GROSS', 'CLEAR'] as const;
export type PricingBasis = (typeof PRICING_BASES)[number];

export type Edge = 'N' | 'S' | 'E' | 'W'; // N = min-y edge, S = max-y, W = min-x, E = max-x

export type ValidationSeverity = 'error' | 'warn';

export type ValidationCode =
  | 'NON_RECTANGULAR'
  | 'OVERLAP'
  | 'DEGENERATE'
  | 'OFF_GRID'
  | 'OUT_OF_BOUNDS'
  | 'DUPLICATE_LABEL'
  | 'UNIT_TOO_SMALL'
  | 'NOMINAL_VARIANCE'
  | 'NO_DOOR'
  | 'DOOR_BLOCKED'
  | 'UNREACHABLE_UNIT'
  | 'ENTRANCE_NOT_ON_CIRCULATION';

export interface ValidationRecord {
  code: ValidationCode;
  severity: ValidationSeverity;
  region_ids: string[];
  message: string;
}

// ---------- inputs ----------

export interface PointFeet {
  x: number;
  y: number;
}

export interface RegionInput {
  id: string;
  label: string;
  kind: RegionKind;
  /** Centreline rect, feet (integers typical; fractional rounded on ingress). */
  xFeet: number;
  yFeet: number;
  wFeet: number;
  dFeet: number;
  /** LOCKER stacking tier: 0 = ground/sole, >0 = stacked (counts to NLA, excluded from tessellation). */
  stackLevel?: number;
  /** Advertised dims, feet; default = centreline w/d. */
  advertisedWFeet?: number;
  advertisedDFeet?: number;
  /** Per-edge wall kinds; default all `partition`. */
  walls?: { n?: WallKind; s?: WallKind; e?: WallKind; w?: WallKind };
  pricingBasis?: PricingBasis;
}

export interface DoorInput {
  regionId: string;
  edge: Edge;
}

export interface FloorMetricsInput {
  outlineFeet: PointFeet[];
  holesFeet?: PointFeet[][];
  regions: RegionInput[];
  doors?: DoorInput[];
  /** Building entrances as points (feet); flood-fill seeds from their circulation cells. */
  entrances?: PointFeet[];
  exteriorWallFeet?: number; // default WALL_THICKNESS_FEET.exterior
}

// ---------- outputs (areas carry exact Q BigInt + boundary sqft float) ----------

export interface AreaBreakdown {
  q: bigint;
  sqft: number;
}

function area(q: bigint): AreaBreakdown {
  return { q, sqft: areaQToSqft(q) };
}

export interface UnitAreas {
  regionId: string;
  label: string;
  kind: RegionKind;
  basis: PricingBasis;
  nominal: AreaBreakdown;
  gross: AreaBreakdown;
  clear: AreaBreakdown;
  billable: AreaBreakdown;
  nominalVariancePct: number;
  nominalVarianceWarn: boolean;
}

export interface CirculationComponent {
  id: string;
  area: AreaBreakdown;
  cells: number;
  reachable: boolean;
  /**
   * Representative interior point (feet) inside this component, e.g. the
   * centre of one of its cells. Deterministic. Used by the API bridge to seed
   * a building entrance on the largest circulation component (two-pass live
   * compute); fractional .5 ft values are exact through feetToBase.
   */
  seedFeet: { x: number; y: number };
}

export interface UnitReachability {
  regionId: string;
  label: string;
  reachable: boolean;
  code?: 'NO_DOOR' | 'DOOR_BLOCKED' | 'UNREACHABLE_UNIT';
}

export interface FloorMetrics {
  units: UnitAreas[];
  gfa: AreaBreakdown;
  exteriorWall: AreaBreakdown;
  ufa: AreaBreakdown;
  nlaEnclosed: AreaBreakdown;
  nlaOutdoor: AreaBreakdown;
  nlaTotal: AreaBreakdown;
  common: AreaBreakdown;
  glaExclusive: { area: AreaBreakdown; convention: 'exclusive' };
  glaInclusive: { area: AreaBreakdown; convention: 'inclusive' };
  efficiency: number;
  loadFactor: number;
  circulation: CirculationComponent[];
  derivedCirculation: AreaBreakdown;
  droppedSlivers: AreaBreakdown;
  reachability: UnitReachability[];
  validations: ValidationRecord[];
  identity: { interiorQ: bigint; coveredQ: bigint; circulationQ: bigint; sliverQ: bigint; balanced: boolean };
}

// ---------- per-unit four areas ----------

export interface UnitAreasInput {
  wFeet: number;
  dFeet: number;
  advertisedWFeet?: number;
  advertisedDFeet?: number;
  walls?: { n?: WallKind; s?: WallKind; e?: WallKind; w?: WallKind };
  pricingBasis?: PricingBasis;
}

function wallBase(kind: WallKind | undefined, label: string): number {
  const k: WallKind = kind ?? 'partition';
  if (!(k in WALL_THICKNESS_FEET)) throw new AppError(400, 'VALIDATION', `Unknown wall kind "${label}"`);
  return feetToBase(WALL_THICKNESS_FEET[k]);
}

/**
 * Four areas for one unit. nominal = advertised w*d; gross = centreline w*d;
 * clear deducts half of each edge's wall thickness per side:
 *   clearW = w - (tE + tW) / 2, clearD = d - (tN + tS) / 2
 * computed in half-base units (cw2 = 2*wBase - tE - tW) so clear area stays
 * an exact BigInt in Q. Raises AppError UNIT_TOO_SMALL when clear <= 0.
 * Billable follows the pricing basis. nominalVariancePct is measured against
 * gross; >5% sets the warn flag (floor level also emits NOMINAL_VARIANCE).
 */
export function computeUnitAreas(
  regionId: string,
  label: string,
  kind: RegionKind,
  input: UnitAreasInput,
): UnitAreas {
  const wBase = feetToBase(input.wFeet);
  const dBase = feetToBase(input.dFeet);
  const advW = input.advertisedWFeet ?? input.wFeet;
  const advD = input.advertisedDFeet ?? input.dFeet;
  const basis = input.pricingBasis ?? 'GROSS';

  const nominalQ = rectAreaQ(feetToBase(advW), feetToBase(advD));
  const grossQ = rectAreaQ(wBase, dBase);

  const tN = wallBase(input.walls?.n, `${label}.n`);
  const tS = wallBase(input.walls?.s, `${label}.s`);
  const tE = wallBase(input.walls?.e, `${label}.e`);
  const tW = wallBase(input.walls?.w, `${label}.w`);
  const cw2 = 2 * wBase - tE - tW; // clear width in half-base units
  const cd2 = 2 * dBase - tN - tS;
  if (cw2 <= 0 || cd2 <= 0) {
    throw new AppError(
      400,
      'UNIT_TOO_SMALL',
      `Unit ${label}: walls leave no clear space ` +
        `(centreline ${input.wFeet}x${input.dFeet} ft vs walls e=${input.walls?.e ?? 'partition'} w=${input.walls?.w ?? 'partition'} n=${input.walls?.n ?? 'partition'} s=${input.walls?.s ?? 'partition'})`,
    );
  }
  const clearQ = BigInt(cw2) * BigInt(cd2);

  const billableQ = basis === 'NOMINAL' ? nominalQ : basis === 'CLEAR' ? clearQ : grossQ;
  const grossSqft = areaQToSqft(grossQ);
  const nominalVariancePct = grossSqft > 0 ? (Math.abs(areaQToSqft(nominalQ) - grossSqft) / grossSqft) * 100 : 0;

  return {
    regionId,
    label,
    kind,
    basis,
    nominal: area(nominalQ),
    gross: area(grossQ),
    clear: area(clearQ),
    billable: area(billableQ),
    nominalVariancePct,
    nominalVarianceWarn: nominalVariancePct > NOMINAL_VARIANCE_WARN_PCT,
  };
}

// ---------- integer polygon helpers (base-unit coords) ----------

interface IPoint {
  x: number;
  y: number;
}

function toBasePoints(feet: PointFeet[], what: string): IPoint[] {
  if (feet.length < 3) throw new AppError(400, 'VALIDATION', `${what} must have at least 3 points`);
  return feet.map((p) => ({ x: feetToBase(p.x), y: feetToBase(p.y) }));
}

/** Exact signed shoelace area in Q: 2*|sum| (always integral for integer coords). */
export function shoelaceQ(poly: IPoint[]): bigint {
  let sum = 0n;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += BigInt(a.x) * BigInt(b.y) - BigInt(b.x) * BigInt(a.y);
  }
  return sum >= 0n ? 2n * sum : -2n * sum;
}

/** Exact Manhattan perimeter in base units for rectilinear rings; diagonal edges round (flagged via NON_RECTANGULAR). */
function perimeterBase(poly: IPoint[]): number {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    p += dx === 0 || dy === 0 ? dx + dy : Math.round(Math.sqrt(dx * dx + dy * dy));
  }
  return p;
}

function isRectilinear(poly: IPoint[]): boolean {
  return poly.every((a, i) => {
    const b = poly[(i + 1) % poly.length];
    return a.x === b.x || a.y === b.y;
  });
}

function onSegment(px: number, py: number, a: IPoint, b: IPoint): boolean {
  const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
  if (cross !== 0) return false;
  return Math.min(a.x, b.x) <= px && px <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= py && py <= Math.max(a.y, b.y);
}

/**
 * Point-in-polygon, boundary-inclusive, exact integer arithmetic
 * (even-odd ray cast with cross-multiplied comparisons; all values are
 * small integers so float64 holds them exactly — no rounding anywhere).
 */
function pipExact(px: number, py: number, poly: IPoint[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (onSegment(px, py, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  let inside = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.y > py !== b.y > py) {
      const dy = b.y - a.y;
      const dx = b.x - a.x;
      const t = py - a.y;
      // px < a.x + dx*t/dy, dy != 0; flip the comparison when dy < 0.
      const holds = dy > 0 ? (px - a.x) * dy < dx * t : (px - a.x) * dy > dx * t;
      if (holds) inside = !inside;
    }
  }
  return inside;
}

/**
 * True when an axis-aligned region edge genuinely PIERCES a boundary edge:
 * the two meet at a point strictly interior to the REGION edge. Endpoint
 * touches are legal and return false — a region corner landing exactly on
 * the wall (flush placement, wall-to-wall corridors, door-side edges) is
 * inside-or-on the boundary by construction (corners are verified before
 * this runs). Collinear overlaps (flush shared edges) are likewise legal.
 * All comparisons are cross-multiplied integer arithmetic — exact.
 * (Region edges are always axis-aligned: non-degenerate centreline rects.)
 */
function regionEdgePierces(a: IPoint, b: IPoint, c: IPoint, d: IPoint): boolean {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  if (a.y === b.y) {
    // Horizontal region edge y=Y vs boundary segment c->d.
    const Y = a.y;
    const den = d.y - c.y;
    if (den === 0) return false; // parallel: collinear flush or disjoint — legal
    if ((Y < c.y && Y < d.y) || (Y > c.y && Y > d.y)) return false; // no touch
    const num = c.x * den + (d.x - c.x) * (Y - c.y); // x_at * den
    if (den > 0) return num > x0 * den && num < x1 * den;
    return num < x0 * den && num > x1 * den;
  }
  // Vertical region edge x=X vs boundary segment c->d.
  const X = a.x;
  const den = d.x - c.x;
  if (den === 0) return false; // parallel — legal
  if ((X < c.x && X < d.x) || (X > c.x && X > d.x)) return false; // no touch
  const num = c.y * den + (d.y - c.y) * (X - c.x); // y_at * den
  if (den > 0) return num > y0 * den && num < y1 * den;
  return num < y0 * den && num > y1 * den;
}

interface IRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function rectCorners(r: IRect): IPoint[] {
  return [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
}

function rectEdges(r: IRect): Array<[IPoint, IPoint]> {
  const c = rectCorners(r);
  return [
    [c[0], c[1]],
    [c[1], c[2]],
    [c[2], c[3]],
    [c[3], c[0]],
  ];
}

function polyEdges(poly: IPoint[]): Array<[IPoint, IPoint]> {
  return poly.map((a, i) => [a, poly[(i + 1) % poly.length]] as [IPoint, IPoint]);
}

// ---------- floor computation ----------

interface RegionGeom extends IRect {
  id: string;
  label: string;
  kind: RegionKind;
  stackLevel: number;
  input: RegionInput;
}

export function computeFloorMetrics(input: FloorMetricsInput): FloorMetrics {
  const validations: ValidationRecord[] = [];
  const outline = toBasePoints(input.outlineFeet, 'outline');
  const holes = (input.holesFeet ?? []).map((h, i) => toBasePoints(h, `hole[${i}]`));
  const extWallBase = feetToBase(input.exteriorWallFeet ?? WALL_THICKNESS_FEET.exterior);

  if (!isRectilinear(outline) || holes.some((h) => !isRectilinear(h))) {
    validations.push({
      code: 'NON_RECTANGULAR',
      severity: 'warn',
      region_ids: [],
      message: 'Outline or a hole has non-axis-aligned edges; tessellation falls back to centre sampling on those cells',
    });
  }

  const insideInterior = (px: number, py: number): boolean => {
    if (!pipExact(px, py, outline)) return false;
    return !holes.some((h) => pipExact(px, py, h));
  };

  // --- region ingress ---
  const geoms: RegionGeom[] = input.regions.map((r) => {
    const x0 = feetToBase(r.xFeet);
    const y0 = feetToBase(r.yFeet);
    const wBase = feetToBase(r.wFeet);
    const dBase = feetToBase(r.dFeet);
    return {
      id: r.id,
      label: r.label,
      kind: r.kind,
      stackLevel: r.stackLevel ?? 0,
      input: r,
      x0,
      y0,
      x1: x0 + wBase,
      y1: y0 + dBase,
    };
  });

  for (const g of geoms) {
    if (g.x1 <= g.x0 || g.y1 <= g.y0) {
      validations.push({
        code: 'DEGENERATE',
        severity: 'error',
        region_ids: [g.id],
        message: `Region ${g.label}: non-positive dimensions (${g.input.wFeet}x${g.input.dFeet} ft)`,
      });
    }
    const coords = [g.x0, g.y0, g.x1, g.y1];
    if (!coords.every(isOnInchGrid)) {
      validations.push({
        code: 'OFF_GRID',
        severity: 'warn',
        region_ids: [g.id],
        message: `Region ${g.label}: coordinates are not on the 1-inch (254 base unit) grid; geometry stays exact but is unsnapped`,
      });
    }
  }

  const labelGroups = new Map<string, string[]>();
  for (const g of geoms) labelGroups.set(g.label, [...(labelGroups.get(g.label) ?? []), g.id]);
  for (const [label, ids] of labelGroups) {
    if (ids.length > 1) {
      validations.push({
        code: 'DUPLICATE_LABEL',
        severity: 'error',
        region_ids: ids,
        message: `Label "${label}" is used by ${ids.length} regions`,
      });
    }
  }

  // Stacked lockers (stackLevel > 0) are exempt from tessellation AND from the
  // same-rect overlap with their ground-tier partner; every other pair with
  // interior overlap is reported via an exact AABB sweep-line.
  const tessellated = geoms.filter((g) => !(g.kind === 'LOCKER' && g.stackLevel > 0));
  const reported = new Set<string>();
  const events = tessellated.flatMap((g) => [
    { x: g.x0, start: true, g },
    { x: g.x1, start: false, g },
  ]);
  events.sort((a, b) => a.x - b.x || Number(a.start) - Number(b.start)); // ends before starts: touching is legal
  const active: RegionGeom[] = [];
  for (const ev of events) {
    if (ev.start) {
      for (const o of active) {
        if (o.y0 < ev.g.y1 && ev.g.y0 < o.y1) {
          const key = [o.id, ev.g.id].sort().join('|');
          if (!reported.has(key)) {
            reported.add(key);
            validations.push({
              code: 'OVERLAP',
              severity: 'error',
              region_ids: [o.id, ev.g.id],
              message: `Regions ${o.label} and ${ev.g.label} overlap in interior area`,
            });
          }
        }
      }
      active.push(ev.g);
    } else {
      const idx = active.findIndex((a) => a.id === ev.g.id);
      if (idx >= 0) active.splice(idx, 1);
    }
  }

  // OUT_OF_BOUNDS: enclosed-participating regions must sit fully inside the
  // outline-minus-holes interior (corners inside + no edge piercing the
  // boundary). Edge-endpoint touches are legal — flush-against-the-wall
  // placements and wall-to-wall regions (e.g. a full-width corridor) have
  // corners ON the wall and never pierce it (see regionEdgePierces).
  // UNIT_OUTDOOR / NON_ENCLOSED are exempt — they may lie outside.
  const outlineEdges = polyEdges(outline);
  const holeEdges = holes.flatMap(polyEdges);
  const boundaryEdges = [...outlineEdges, ...holeEdges];
  const containedInInterior = (r: IRect): boolean => {
    if (!rectCorners(r).every((c) => insideInterior(c.x, c.y))) return false;
    return !rectEdges(r).some(([a, b]) => boundaryEdges.some(([c, d]) => regionEdgePierces(a, b, c, d)));
  };
  for (const g of tessellated) {
    if (g.kind === 'UNIT_OUTDOOR' || g.kind === 'NON_ENCLOSED') continue;
    if (g.x1 <= g.x0 || g.y1 <= g.y0) continue; // already DEGENERATE
    if (!containedInInterior(g)) {
      validations.push({
        code: 'OUT_OF_BOUNDS',
        severity: 'error',
        region_ids: [g.id],
        message: `Region ${g.label}: rect is not fully inside the floor interior`,
      });
    }
  }

  // --- per-unit four areas (leasable kinds); UNIT_TOO_SMALL becomes a record ---
  const units: UnitAreas[] = [];
  const billableById = new Map<string, bigint>();
  for (const g of geoms) {
    if (!LEASABLE_ENCLOSED.has(g.kind) && !LEASABLE_OUTDOOR.has(g.kind)) continue;
    if (g.x1 <= g.x0 || g.y1 <= g.y0) {
      billableById.set(g.id, 0n);
      continue;
    }
    try {
      const u = computeUnitAreas(g.id, g.label, g.kind, {
        wFeet: g.input.wFeet,
        dFeet: g.input.dFeet,
        advertisedWFeet: g.input.advertisedWFeet,
        advertisedDFeet: g.input.advertisedDFeet,
        walls: g.input.walls,
        pricingBasis: g.input.pricingBasis,
      });
      units.push(u);
      billableById.set(g.id, u.billable.q);
      if (u.nominalVarianceWarn) {
        validations.push({
          code: 'NOMINAL_VARIANCE',
          severity: 'warn',
          region_ids: [g.id],
          message: `Unit ${g.label}: nominal area differs ${u.nominalVariancePct.toFixed(2)}% from gross (>5%)`,
        });
      }
    } catch (e) {
      if (e instanceof AppError && e.code === 'UNIT_TOO_SMALL') {
        validations.push({ code: 'UNIT_TOO_SMALL', severity: 'error', region_ids: [g.id], message: e.message });
        billableById.set(g.id, 0n);
      } else {
        throw e;
      }
    }
  }

  // --- aggregates (all BigInt Q) ---
  const outlineQ = shoelaceQ(outline);
  const holesQ = holes.reduce((s, h) => s + shoelaceQ(h), 0n);
  const insideQ = (g: RegionGeom): bigint =>
    containedInInterior(g) ? rectAreaQ(g.x1 - g.x0, g.y1 - g.y0) : 0n;
  const excludedInsideQ = geoms
    .filter((g) => GFA_EXCLUDE_INSIDE.has(g.kind))
    .reduce((s, g) => s + insideQ(g), 0n);
  const gfaQ = outlineQ - holesQ - excludedInsideQ;

  const perimeterQ = (() => {
    const p = perimeterBase(outline) + holes.reduce((s, h) => s + perimeterBase(h), 0);
    return 4n * BigInt(p) * BigInt(extWallBase);
  })();
  const deductQ = tessellated
    .filter((g) => UFA_DEDUCT_KINDS.has(g.kind))
    .reduce((s, g) => s + rectAreaQ(g.x1 - g.x0, g.y1 - g.y0), 0n);
  const ufaQ = gfaQ - deductQ - perimeterQ;

  const nlaEnclosedQ = geoms
    .filter((g) => LEASABLE_ENCLOSED.has(g.kind))
    .reduce((s, g) => s + (billableById.get(g.id) ?? 0n), 0n);
  const nlaOutdoorQ = geoms
    .filter((g) => LEASABLE_OUTDOOR.has(g.kind))
    .reduce((s, g) => s + (billableById.get(g.id) ?? 0n), 0n);
  const nlaTotalQ = nlaEnclosedQ + nlaOutdoorQ;

  // --- tessellation via coordinate compression ---
  const xsSet = new Set<number>();
  const ysSet = new Set<number>();
  for (const p of outline) {
    xsSet.add(p.x);
    ysSet.add(p.y);
  }
  for (const h of holes) for (const p of h) {
    xsSet.add(p.x);
    ysSet.add(p.y);
  }
  const bbox = {
    x0: Math.min(...outline.map((p) => p.x)),
    x1: Math.max(...outline.map((p) => p.x)),
    y0: Math.min(...outline.map((p) => p.y)),
    y1: Math.max(...outline.map((p) => p.y)),
  };
  for (const g of tessellated) {
    // Only regions touching the bbox can cover interior cells.
    if (g.x1 <= bbox.x0 || g.x0 >= bbox.x1 || g.y1 <= bbox.y0 || g.y0 >= bbox.y1) continue;
    xsSet.add(g.x0);
    xsSet.add(g.x1);
    ysSet.add(g.y0);
    ysSet.add(g.y1);
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  if (xs.length < 2 || ys.length < 2 || (xs.length - 1) * (ys.length - 1) > MAX_CELLS) {
    throw new AppError(400, 'VALIDATION', 'Floor geometry exceeds tessellation limits');
  }

  interface Cell {
    i: number;
    j: number;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    areaQ: bigint;
    coverId: string | null;
  }
  const interiorCells: Cell[] = [];
  const cellAt: Array<Array<Cell | null>> = [];
  for (let i = 0; i < xs.length - 1; i++) {
    cellAt[i] = [];
    for (let j = 0; j < ys.length - 1; j++) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      const y0 = ys[j];
      const y1 = ys[j + 1];
      const corners = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
      const states = corners.map(([cx, cy]) => insideInterior(cx, cy));
      let interior: boolean;
      if (states.every(Boolean)) {
        interior = true;
      } else if (states.every((s) => !s)) {
        interior = false;
      } else {
        // Straddles a boundary edge: only possible with diagonal edges
        // (already flagged NON_RECTANGULAR) — resolve by centre sample in
        // doubled coordinates so the sample point stays integral and exact.
        const dbl = (poly: IPoint[]): IPoint[] => poly.map((p) => ({ x: p.x * 2, y: p.y * 2 }));
        const cx2 = x0 + x1;
        const cy2 = y0 + y1;
        interior = pipExact(cx2, cy2, dbl(outline)) && !holes.some((h) => pipExact(cx2, cy2, dbl(h)));
      }
      if (!interior) {
        cellAt[i][j] = null;
        continue;
      }
      let coverId: string | null = null;
      for (const g of tessellated) {
        if (g.x0 <= x0 && x1 <= g.x1 && g.y0 <= y0 && y1 <= g.y1) {
          coverId = g.id;
          break; // first wins; genuine overlaps already reported by sweep-line
        }
      }
      const cell: Cell = {
        i,
        j,
        x0,
        x1,
        y0,
        y1,
        areaQ: 4n * BigInt(x1 - x0) * BigInt(y1 - y0),
        coverId,
      };
      interiorCells.push(cell);
      cellAt[i][j] = cell;
    }
  }

  // 4-connected components over uncovered interior cells.
  const seen = new Set<Cell>();
  const components: Cell[][] = [];
  for (const cell of interiorCells) {
    if (cell.coverId !== null || seen.has(cell)) continue;
    const comp: Cell[] = [];
    const queue: Cell[] = [cell];
    seen.add(cell);
    while (queue.length > 0) {
      const c = queue.pop() as Cell;
      comp.push(c);
      const neighbours: Array<[number, number]> = [
        [c.i - 1, c.j],
        [c.i + 1, c.j],
        [c.i, c.j - 1],
        [c.i, c.j + 1],
      ];
      for (const [ni, nj] of neighbours) {
        const n = ni >= 0 && nj >= 0 && ni < cellAt.length && nj < (cellAt[ni]?.length ?? 0) ? cellAt[ni][nj] : null;
        if (n && n.coverId === null && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    components.push(comp);
  }

  let sliverQ = 0n;
  const circulation: CirculationComponent[] = [];
  const compOfCell = new Map<Cell, number>(); // index into circulation (non-sliver only)
  const circulationCells: Cell[][] = []; // member cells per circulation entry (indices align)
  components.forEach((comp) => {
    const q = comp.reduce((s, c) => s + c.areaQ, 0n);
    if (q < SLIVER_MIN_Q) {
      sliverQ += q;
      return;
    }
    const id = `CIRC-${circulation.length + 1}`;
    const first = comp[0];
    circulation.push({
      id,
      area: area(q),
      cells: comp.length,
      reachable: false,
      seedFeet: { x: (first.x0 + first.x1) / 2 / BASE_PER_FOOT, y: (first.y0 + first.y1) / 2 / BASE_PER_FOOT },
    });
    circulationCells.push(comp);
    for (const c of comp) compOfCell.set(c, circulation.length - 1);
  });

  const coveredQ = interiorCells.reduce((s, c) => s + (c.coverId !== null ? c.areaQ : 0n), 0n);
  const circulationQ = circulation.reduce((s, c) => s + c.area.q, 0n);
  const interiorQ = interiorCells.reduce((s, c) => s + c.areaQ, 0n);
  const balanced = coveredQ + circulationQ + sliverQ === interiorQ;

  const commonRegionsQ = tessellated
    .filter((g) => COMMON_KINDS.has(g.kind))
    .reduce((s, g) => s + rectAreaQ(g.x1 - g.x0, g.y1 - g.y0), 0n);
  const commonQ = commonRegionsQ + circulationQ;

  // --- doors + entrance flood fill ---
  const geomById = new Map(geoms.map((g) => [g.id, g]));
  const groundPartner = (g: RegionGeom): RegionGeom | null => {
    if (!(g.kind === 'LOCKER' && g.stackLevel > 0)) return g;
    return (
      geoms.find(
        (o) => o.kind === 'LOCKER' && o.stackLevel === 0 && o.x0 === g.x0 && o.y0 === g.y0 && o.x1 === g.x1 && o.y1 === g.y1,
      ) ?? null
    );
  };

  // A cell is walkable when it is derived circulation (uncovered interior,
  // non-sliver) or lies inside a designated circulation-kind region
  // (CIRCULATION_AISLE / CIRCULATION_VERTICAL / LOADING_BAY). Dropped slivers
  // stay non-walkable; every other covered kind stays an obstacle, so a door
  // edge facing another unit (or a wall of units) still resolves to nothing
  // and keeps its DOOR_BLOCKED semantics.
  const isTraversableCell = (cell: Cell): boolean => {
    if (cell.coverId === null) return compOfCell.has(cell);
    const cov = geomById.get(cell.coverId);
    return cov !== undefined && CIRCULATION_TRAVERSABLE_KINDS.has(cov.kind);
  };

  // Interior cells abutting one door edge of a region rect (compass sides:
  // N = min-y edge, S = max-y, W = min-x, E = max-x). Includes covered cells —
  // callers filter through isTraversableCell, so a door opening directly onto
  // a Corridor block counts as open (region-to-circulation connectivity).
  const doorEdgeCells = (g: RegionGeom, edge: Edge): Cell[] => {
    const ix0 = xs.indexOf(g.x0);
    const ix1 = xs.indexOf(g.x1);
    const iy0 = ys.indexOf(g.y0);
    const iy1 = ys.indexOf(g.y1);
    if (ix0 < 0 || ix1 < 0 || iy0 < 0 || iy1 < 0) return [];
    const out: Cell[] = [];
    const collect = (i: number, j: number) => {
      const n = i >= 0 && j >= 0 && i < cellAt.length && j < (cellAt[i]?.length ?? 0) ? cellAt[i][j] : null;
      if (n && !out.includes(n)) out.push(n);
    };
    if (edge === 'N') for (let i = ix0; i < ix1; i++) collect(i, iy0 - 1);
    if (edge === 'S') for (let i = ix0; i < ix1; i++) collect(i, iy1);
    if (edge === 'W') for (let j = iy0; j < iy1; j++) collect(ix0 - 1, j);
    if (edge === 'E') for (let j = iy0; j < iy1; j++) collect(ix1, j);
    return out;
  };

  const neighboursOf = (c: Cell): Cell[] => {
    const out: Cell[] = [];
    const neighbours: Array<[number, number]> = [
      [c.i - 1, c.j],
      [c.i + 1, c.j],
      [c.i, c.j - 1],
      [c.i, c.j + 1],
    ];
    for (const [ni, nj] of neighbours) {
      const n = ni >= 0 && nj >= 0 && ni < cellAt.length && nj < (cellAt[ni]?.length ?? 0) ? cellAt[ni][nj] : null;
      if (n && isTraversableCell(n)) out.push(n);
    }
    return out;
  };

  // Reachable set over the traversable union, seeded from building entrances.
  const reachableCells = new Set<Cell>();
  const floodFrom = (start: Cell): void => {
    if (!isTraversableCell(start) || reachableCells.has(start)) return;
    const queue: Cell[] = [start];
    reachableCells.add(start);
    while (queue.length > 0) {
      const c = queue.pop() as Cell;
      for (const n of neighboursOf(c)) {
        if (!reachableCells.has(n)) {
          reachableCells.add(n);
          queue.push(n);
        }
      }
    }
  };

  // Seed reachable cells from entrance points (an entrance landing on derived
  // circulation OR on a circulation-kind region seeds the flood; anything
  // else keeps the ENTRANCE_NOT_ON_CIRCULATION warn).
  for (const e of input.entrances ?? []) {
    const px = feetToBase(e.x);
    const py = feetToBase(e.y);
    const hit = interiorCells.find((cell) => cell.x0 <= px && px <= cell.x1 && cell.y0 <= py && py <= cell.y1) ?? null;
    if (hit && isTraversableCell(hit)) {
      floodFrom(hit);
    } else {
      validations.push({
        code: 'ENTRANCE_NOT_ON_CIRCULATION',
        severity: 'warn',
        region_ids: [],
        message: `Entrance at (${e.x}, ${e.y} ft) does not land on derived circulation`,
      });
    }
  }
  // A derived component is reachable when the flood reached any of its cells.
  circulation.forEach((c, ci) => {
    c.reachable = (circulationCells[ci] ?? []).some((cell) => reachableCells.has(cell));
  });

  const doorsByRegion = new Map<string, Edge[]>();
  for (const d of input.doors ?? []) {
    if (!geomById.has(d.regionId)) {
      throw new AppError(400, 'VALIDATION', `Door references unknown region ${d.regionId}`);
    }
    doorsByRegion.set(d.regionId, [...(doorsByRegion.get(d.regionId) ?? []), d.edge]);
  }

  const reachability: UnitReachability[] = [];
  for (const g of geoms) {
    const isLeasable = LEASABLE_ENCLOSED.has(g.kind);
    if (!isLeasable) continue; // UNIT_OUTDOOR bays are accessed externally — exempt from door checks
    const partner = groundPartner(g);
    if (!partner) {
      reachability.push({ regionId: g.id, label: g.label, reachable: false, code: 'NO_DOOR' });
      validations.push({
        code: 'NO_DOOR',
        severity: 'error',
        region_ids: [g.id],
        message: `Stacked locker ${g.label} has no ground-tier partner`,
      });
      continue;
    }
    const ownEdges = doorsByRegion.get(g.id) ?? [];
    // A stacked locker shares its ground partner's rect, so the partner's
    // doors (and any declared on the stacked level itself) all apply.
    const partnerEdges = partner.id !== g.id ? (doorsByRegion.get(partner.id) ?? []) : [];
    const edges = [...ownEdges, ...partnerEdges];
    // Walkable openings through the declared door edges: neighbouring
    // traversable cells (derived circulation OR circulation-kind regions).
    // Door-edge compass semantics are unchanged (UNIT_OUTDOOR stays exempt
    // above; NO_DOOR / DOOR_BLOCKED codes intact below).
    const open = new Set<Cell>();
    for (const edge of edges) for (const n of doorEdgeCells(partner, edge)) if (isTraversableCell(n)) open.add(n);
    if (edges.length === 0) {
      reachability.push({ regionId: g.id, label: g.label, reachable: false, code: 'NO_DOOR' });
      validations.push({ code: 'NO_DOOR', severity: 'error', region_ids: [g.id], message: `Unit ${g.label} has no door` });
    } else if (open.size === 0) {
      reachability.push({ regionId: g.id, label: g.label, reachable: false, code: 'DOOR_BLOCKED' });
      validations.push({
        code: 'DOOR_BLOCKED',
        severity: 'error',
        region_ids: [g.id],
        message: `Unit ${g.label}: none of its doors opens onto circulation`,
      });
    } else if (![...open].some((c) => reachableCells.has(c))) {
      reachability.push({ regionId: g.id, label: g.label, reachable: false, code: 'UNREACHABLE_UNIT' });
      validations.push({
        code: 'UNREACHABLE_UNIT',
        severity: 'error',
        region_ids: [g.id],
        message: `Unit ${g.label}: its circulation is not connected to any entrance`,
      });
    } else {
      reachability.push({ regionId: g.id, label: g.label, reachable: true });
    }
  }

  // --- final aggregates ---
  const gfaSqft = areaQToSqft(gfaQ);
  const nlaEnclosedSqft = areaQToSqft(nlaEnclosedQ);
  const nlaTotalSqft = areaQToSqft(nlaTotalQ);
  const glaInclusiveQ = nlaTotalQ + commonQ;
  const efficiency = gfaSqft > 0 ? nlaEnclosedSqft / gfaSqft : 0;
  const loadFactor = nlaTotalSqft > 0 ? areaQToSqft(glaInclusiveQ) / nlaTotalSqft : 1;

  return {
    units,
    gfa: area(gfaQ),
    exteriorWall: area(perimeterQ),
    ufa: area(ufaQ),
    nlaEnclosed: area(nlaEnclosedQ),
    nlaOutdoor: area(nlaOutdoorQ),
    nlaTotal: area(nlaTotalQ),
    common: area(commonQ),
    glaExclusive: { area: area(nlaTotalQ), convention: 'exclusive' },
    glaInclusive: { area: area(glaInclusiveQ), convention: 'inclusive' },
    efficiency,
    loadFactor,
    circulation,
    derivedCirculation: area(circulationQ),
    droppedSlivers: area(sliverQ),
    reachability,
    validations,
    identity: { interiorQ, coveredQ, circulationQ, sliverQ, balanced },
  };
}

// ---------------------------------------------------------------------------
// Phase 2 calculation surface (still pure: no prisma, no express, no I/O).
//
// Money is integer-exact BigInt CENTS throughout (1 SGD = 100 cents); areas
// stay BigInt Q (quarter-base-units^2); volumes stay BigInt E (eighth
// base-units^3, see below). Floating point appears ONLY at the display
// boundary (sqft/sqft-ratio/pct/SGD conversions), exactly like Phase 1.
//
// Occupied state, market rents, climate flags and ceiling heights are INPUTS
// here (plain data). The API bridge (src/core/floorPlanMetricsService.ts)
// reads them from the existing Unit rows (status/tenancy, monthlyRate,
// size→MARKET_PSF, climateControl string) and passes them in — no new flags,
// no duplicated queries.
// ---------------------------------------------------------------------------

/** Payload schema version, stored on every snapshot; bump on shape change. */
export const METRICS_SCHEMA_VERSION = 1;

/** Centreline measurement basis (walls split half/half across centrelines). */
export const MEASUREMENT_BASIS = 'CENTERLINE' as const;

/** Residual-area tolerance surfaced in the assumptions block (sqft). */
export const RESIDUAL_TOLERANCE_SQFT = 0.25;

/** Minimum aisle width surfaced in the assumptions block (feet). */
export const MIN_AISLE_WIDTH_FT = 3.0;

/** Fallback clear height when no per-unit ceiling override is stored (feet). */
export const DEFAULT_CLEAR_HEIGHT_FT = 8;

/**
 * Eighth-base-units^3 per cubic foot: 8 * 3048^3 = 226,614,772,736, exact.
 * A unit's clear volume is volumeE = 2 * clearQ * hBase (clearQ is in
 * quarter-base-units^2, hBase in whole base units: Q(1/4 u^2) * u = 1/4 u^3,
 * times 2 -> eighths of a cubic base unit). Stays an exact BigInt.
 */
export const EIGHTH_PER_CUFT = 8n * 3048n * 3048n * 3048n;

/** Display conversion ONLY: eighth-base-units^3 -> cubic feet (boundary use). */
export function volumeEighthToCuft(v: bigint): number {
  return Number(v) / Number(EIGHTH_PER_CUFT);
}

/** Display conversion ONLY: integer cents -> SGD (boundary use). */
export function centsToSgd(cents: bigint): number {
  return Number(cents) / 100;
}

// ---------- geometry_hash ----------

/**
 * Stable SHA-256 fingerprint of a floor's region set for caching/debounce.
 * Canonical form: regions sorted by id, geometry in integer base units
 * (feetToBase — exact), walls/pricing normalised to their defaults. Any
 * geometry-affecting change flips the hash; label-only edits do not move
 * areas but DO flip it (labels ride along so two floors never alias).
 * Authored doors ride along too (they change reachability/publishability):
 * when no doors are passed the hash is byte-identical to the pre-door form,
 * so existing snapshots stay comparable.
 */
export function geometryHash(regions: RegionInput[], doors?: DoorInput[]): string {
  const canonical = regions
    .map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      x: feetToBase(r.xFeet),
      y: feetToBase(r.yFeet),
      w: feetToBase(r.wFeet),
      d: feetToBase(r.dFeet),
      stack: r.stackLevel ?? 0,
      advW: feetToBase(r.advertisedWFeet ?? r.wFeet),
      advD: feetToBase(r.advertisedDFeet ?? r.dFeet),
      walls: {
        n: r.walls?.n ?? 'partition',
        s: r.walls?.s ?? 'partition',
        e: r.walls?.e ?? 'partition',
        w: r.walls?.w ?? 'partition',
      },
      basis: r.pricingBasis ?? 'GROSS',
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const canonicalDoors = (doors ?? [])
    .map((d) => ({ id: d.regionId, edge: d.edge }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : 0));
  const body = canonicalDoors.length > 0 ? { regions: canonical, doors: canonicalDoors } : canonical;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

// ---------- occupancy triple ----------

export interface OccupancyUnitInput {
  regionId: string;
  /** Exact billable area (Q) from the unit's four-area computation. */
  billableQ: bigint;
  /** From existing unit status/tenancy reads (OCCUPIED or OVERDUE). No new flags. */
  occupied: boolean;
}

export interface OccupancyTriple {
  /** Count-based: occupied units / measured units. */
  physical: { occupiedUnits: number; totalUnits: number; pct: number };
  /** Area-based: billable occupied sqft / NLA sqft. */
  sqft: { occupiedQ: bigint; occupiedSqft: number; nlaQ: bigint; nlaSqft: number; pct: number };
  /** Rent-based: actual rent collected / GPI at market rent. */
  economic: { actualCents: bigint; gpiCents: bigint; pct: number };
}

/**
 * Occupancy triple, accumulated in BigInt (counts/areas/cents); pct ratios
 * are display-boundary floats. Zero denominators yield 0 (never NaN).
 */
export function computeOccupancy(
  units: OccupancyUnitInput[],
  nlaQ: bigint,
  actualCents: bigint,
  gpiCents: bigint,
): OccupancyTriple {
  const occupiedUnits = units.filter((u) => u.occupied).length;
  const occupiedQ = units.reduce((s, u) => s + (u.occupied ? u.billableQ : 0n), 0n);
  const occupiedSqft = areaQToSqft(occupiedQ);
  const nlaSqft = areaQToSqft(nlaQ);
  return {
    physical: {
      occupiedUnits,
      totalUnits: units.length,
      pct: units.length > 0 ? (occupiedUnits / units.length) * 100 : 0,
    },
    sqft: {
      occupiedQ,
      occupiedSqft,
      nlaQ,
      nlaSqft,
      pct: nlaSqft > 0 ? (occupiedSqft / nlaSqft) * 100 : 0,
    },
    economic: {
      actualCents,
      gpiCents,
      pct: gpiCents > 0n ? (Number(actualCents) / Number(gpiCents)) * 100 : 0,
    },
  };
}

// ---------- revenue ----------

export interface RevenueUnitInput {
  regionId: string;
  occupied: boolean;
  /** Actual contracted rent, integer cents (from Unit.monthlyRate at the boundary). */
  actualCents: bigint;
  /** Market rent at 100% occupancy, integer cents (size -> MARKET_PSF). */
  marketCents: bigint;
}

export interface RevenueSummary {
  gpiMonthlyCents: bigint;
  gpiAnnualCents: bigint;
  actualMonthlyCents: bigint;
  actualAnnualCents: bigint;
  /** GPI_annual / NLA sqft: full-occupancy rent per sqft per year (SGD). */
  ratePerSfAnnual: number;
  /** Actual monthly rent / NLA sqft (revenue per available sqft, SGD). */
  revpafMonthly: number;
  revpafAnnual: number;
  /** Actual monthly rent / occupied billable sqft (SGD, 0 when none occupied). */
  revpofMonthly: number;
  /**
   * Walkable gross -> efficiency -> rentable -> rent chain: each step names
   * the value the next step derives from, so operators can trace GPI/actual
   * back to GFA without re-running the core.
   */
  chain: {
    gfaSqft: number;
    efficiency: number;
    nlaSqft: number;
    occupiedSqft: number;
    occupancySqftPct: number;
    gpiMonthlySgd: number;
    actualMonthlySgd: number;
  };
  basisNote: string;
}

export const GPI_BASIS_NOTE =
  'GPI assumes 100% occupancy at market rent (size -> MARKET_PSF reference table); ' +
  'actual is contracted rent on OCCUPIED/OVERDUE units only.';

/**
 * Revenue rollup in integer cents (annual = monthly x12, exact). Per-sqft
 * ratios are display-boundary floats. Zero-area denominators yield 0.
 */
export function computeRevenue(
  units: RevenueUnitInput[],
  nlaQ: bigint,
  occupiedQ: bigint,
  gfaQ: bigint,
  efficiency: number,
): RevenueSummary {
  const gpiMonthlyCents = units.reduce((s, u) => s + u.marketCents, 0n);
  const actualMonthlyCents = units.reduce((s, u) => s + (u.occupied ? u.actualCents : 0n), 0n);
  const gpiAnnualCents = gpiMonthlyCents * 12n;
  const actualAnnualCents = actualMonthlyCents * 12n;
  const nlaSqft = areaQToSqft(nlaQ);
  const occupiedSqft = areaQToSqft(occupiedQ);
  const gfaSqft = areaQToSqft(gfaQ);
  return {
    gpiMonthlyCents,
    gpiAnnualCents,
    actualMonthlyCents,
    actualAnnualCents,
    ratePerSfAnnual: nlaSqft > 0 ? centsToSgd(gpiAnnualCents) / nlaSqft : 0,
    revpafMonthly: nlaSqft > 0 ? centsToSgd(actualMonthlyCents) / nlaSqft : 0,
    revpafAnnual: nlaSqft > 0 ? centsToSgd(actualAnnualCents) / nlaSqft : 0,
    revpofMonthly: occupiedSqft > 0 ? centsToSgd(actualMonthlyCents) / occupiedSqft : 0,
    chain: {
      gfaSqft,
      efficiency,
      nlaSqft,
      occupiedSqft,
      occupancySqftPct: nlaSqft > 0 ? (occupiedSqft / nlaSqft) * 100 : 0,
      gpiMonthlySgd: centsToSgd(gpiMonthlyCents),
      actualMonthlySgd: centsToSgd(actualMonthlyCents),
    },
    basisNote: GPI_BASIS_NOTE,
  };
}

// ---------- unit mix ----------

export interface UnitMixUnitInput {
  regionId: string;
  sizeCode: string;
  billableQ: bigint;
  /** From the Unit.climateControl string heuristic (see service). No new flags. */
  climateControlled: boolean;
}

export interface UnitMixSummary {
  climateControlledQ: bigint;
  climateControlledSqft: number;
  totalQ: bigint;
  totalSqft: number;
  /** Climate-controlled AREA share (billable Q), display-boundary pct. */
  climateControlledPct: number;
  /** Size-band histogram by AREA share (billable Q), sorted by size code. */
  bySize: Array<{
    sizeCode: string;
    units: number;
    areaQ: bigint;
    areaSqft: number;
    areaSharePct: number;
  }>;
}

/** Climate + size-band mix over exact billable Q; shares are boundary pcts. */
export function computeUnitMix(units: UnitMixUnitInput[]): UnitMixSummary {
  const totalQ = units.reduce((s, u) => s + u.billableQ, 0n);
  const climateControlledQ = units.reduce((s, u) => s + (u.climateControlled ? u.billableQ : 0n), 0n);
  const totalSqft = areaQToSqft(totalQ);
  const bands = new Map<string, { units: number; areaQ: bigint }>();
  for (const u of units) {
    const band = bands.get(u.sizeCode) ?? { units: 0, areaQ: 0n };
    band.units += 1;
    band.areaQ += u.billableQ;
    bands.set(u.sizeCode, band);
  }
  const bySize = [...bands.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([sizeCode, band]) => ({
      sizeCode,
      units: band.units,
      areaQ: band.areaQ,
      areaSqft: areaQToSqft(band.areaQ),
      areaSharePct: totalSqft > 0 ? (areaQToSqft(band.areaQ) / totalSqft) * 100 : 0,
    }));
  return {
    climateControlledQ,
    climateControlledSqft: areaQToSqft(climateControlledQ),
    totalQ,
    totalSqft,
    climateControlledPct: totalSqft > 0 ? (areaQToSqft(climateControlledQ) / totalSqft) * 100 : 0,
    bySize,
  };
}

// ---------- volumetric ----------

export interface VolumetricUnitInput {
  regionId: string;
  label: string;
  /** Exact clear area (Q) from the unit's four-area computation. */
  clearQ: bigint;
  /** Per-unit ceiling override in feet; null/omitted falls back to the floor height. */
  ceilingFt?: number | null;
}

export interface VolumetricUnitOutput {
  regionId: string;
  label: string;
  clearSqft: number;
  heightFt: number;
  volumeEighth: bigint;
  cubicFt: number;
}

export interface VolumetricSummary {
  units: VolumetricUnitOutput[];
  totalVolumeEighth: bigint;
  totalCubicFt: number;
  defaultHeightFt: number;
}

/**
 * Cubic capacity per unit: clear_area x (ceiling override ?? floor height),
 * accumulated as exact BigInt E (eighth-base-units^3). Cubic feet and the
 * per-unit height echo are display-boundary values.
 */
export function computeVolumetric(
  units: VolumetricUnitInput[],
  defaultHeightFt: number = DEFAULT_CLEAR_HEIGHT_FT,
): VolumetricSummary {
  if (!Number.isFinite(defaultHeightFt) || defaultHeightFt <= 0) {
    throw new AppError(400, 'VALIDATION', `Default clear height must be a positive number of feet, got ${defaultHeightFt}`);
  }
  const rows = units.map((u) => {
    const heightFt = u.ceilingFt ?? defaultHeightFt;
    if (!Number.isFinite(heightFt) || heightFt <= 0) {
      throw new AppError(400, 'VALIDATION', `Unit ${u.label}: ceiling height must be positive, got ${u.ceilingFt}`);
    }
    const volumeEighth = 2n * u.clearQ * BigInt(feetToBase(heightFt));
    return {
      regionId: u.regionId,
      label: u.label,
      clearSqft: areaQToSqft(u.clearQ),
      heightFt,
      volumeEighth,
      cubicFt: volumeEighthToCuft(volumeEighth),
    };
  });
  const totalVolumeEighth = rows.reduce((s, r) => s + r.volumeEighth, 0n);
  return {
    units: rows,
    totalVolumeEighth,
    totalCubicFt: volumeEighthToCuft(totalVolumeEighth),
    defaultHeightFt,
  };
}

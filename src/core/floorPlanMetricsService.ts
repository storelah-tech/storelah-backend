// StoreLah — Floor plan area metrics API bridge (Phase 2).
//
// Reads the persisted editor canvas (FloorPlan + UnitPlacement + FloorPlanBlock
// via src/core/floorPlans.ts geometry, plus Unit status/rates/sizes) and runs
// the pure core (src/core/floorPlanMetrics.ts) over it. Also owns append-only
// snapshot persistence (FloorplanMetricsSnapshot).
//
// Bridge mapping (documented in every payload's assumptions/basis_notes):
//   - outline = the plan canvas rect (0,0)-(width,height) in feet. Legacy
//     `structure` JSON decorations are NOT measured (walls/corridors are
//     line/path primitives with no area; rect markers already live as blocks).
//   - GFA: the operator-entered FloorPlan.gfaSqft wins when set
//     (geometry.gfaSource 'USER', efficiency + revenue chain follow it);
//     otherwise GFA is the canvas-derived rect (gfaSource 'CANVAS', flagged in
//     basis_notes).
//   - UFA/NLA are LINE-ONLY (marked-area, never the whole canvas): the
//     authoritative source is the plan's marked boundary lines via
//     computeBoundaryMetrics() (see floorPlans.ts) — geometry.ufa is the marked
//     gross minus blocks/solid-structure rects, geometry.nlaEnclosed/nlaTotal
//     are placement footprints clipped to the marked loops (capped ≤ UFA),
//     geometry.nlaOutdoor is 0 (the marked-area model has no outdoor split),
//     geometry.common is the marked remainder (UFA − NLA), and efficiency +
//     the occupancy-sqft/revenue NLA denominators follow the same line-only
//     NLA. With no contributing marked line (boundaryClosed false) all of
//     these are 0 — never the canvas rect. The canvas-tessellated
//     whole-canvas UFA/NLA survive only as diagnostic numbers inside
//     basis_notes (plus exteriorWall/derivedCirculation/droppedSlivers/balanced,
//     which stay canvas-tessellation diagnostics). The exact marked figures
//     are also exposed as top-level `boundaryMetrics` (byte-identical to the
//     plan-read shape).
//   - placements -> UNIT_STORAGE (LOCKER when the unit's size code is LOCKER),
//     label = unitCode, pricing GROSS, default partition walls, stackLevel from
//     stackTier. Soft-deleted units are filtered out (soft-delete rule).
//   - blocks -> kinds by name heuristic (kind_source 'heuristic'); unknown
//     names map to CIRCULATION_AISLE. Duplicate block names are suffixed
//     deterministically ("Walking area (2)") so DUPLICATE_LABEL never fires
//     on decoration.
//   - doors: operator-authored per-unit compass edges (UnitPlacement.doorEdges,
//     editor N/S/E/W toggles) where present, every unit edge (AUTO_ALL_EDGES)
//     otherwise — a unit is accessed from wherever circulation touches its
//     declared edges; edges facing other units/walls simply resolve to nothing
//     inside the core. entrance: seeded at the largest derived circulation
//     component's interior point (two-pass compute). Units with no abutting
//     circulation still report DOOR_BLOCKED (genuine, blocks publish).
//     Circulation-kind blocks (Corridor/aisle/lift/lobby — see
//     CIRCULATION_TRAVERSABLE_KINDS) are traversable, so a spanning Corridor
//     joins derived circulation instead of splitting it.
//   - occupied = Unit.status OCCUPIED or OVERDUE (the revenue convention from
//     summary/rates — no new flags). GPI = market rent at 100% occupancy via
//     the MARKET_PSF reference table (actual-rate fallback per unit, flagged).
//   - climate-controlled = Unit.climateControl string heuristic (contains
//     "climate" but not "ambient"); seeded rows are all 'Ambient climate'.
//   - ceiling heights are not stored anywhere: every unit uses
//     DEFAULT_CLEAR_HEIGHT_FT (flagged), no per-unit overrides exist yet.
//
// All BigInt Q (areas) serialise as decimal STRINGS (q) + sqft floats; money
// serialises as integer cents + 2dp SGD. JSON.stringify of a BigInt throws,
// so nothing BigInt ever reaches the response/payload unconverted.

import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import type { Prisma } from '@prisma/client';
import { MARKET_PSF } from './market';
import { computeBoundaryMetrics, doorEdgesToArray, type BoundaryMetrics, type GfaSource } from './floorPlans';
import {
  computeFloorMetrics,
  computeOccupancy,
  computeRevenue,
  computeUnitMix,
  computeVolumetric,
  geometryHash,
  MEASUREMENT_BASIS,
  METRICS_SCHEMA_VERSION,
  RESIDUAL_TOLERANCE_SQFT,
  MIN_AISLE_WIDTH_FT,
  DEFAULT_CLEAR_HEIGHT_FT,
  Q_PER_SQFT,
  WALL_THICKNESS_FEET,
  type DoorInput,
  type Edge,
  type FloorMetricsInput,
  type RegionInput,
  type RegionKind,
} from './floorPlanMetrics';

export { METRICS_SCHEMA_VERSION };

// Occupied state comes from the existing revenue convention (summary/rates):
// OCCUPIED + OVERDUE. RESERVED is leased but not rent-paying.
const OCCUPIED_STATUSES = new Set(['OCCUPIED', 'OVERDUE']);

// ---------- facility size groups (owner-confirmed mapping) ----------
//
// Locker Units = UnitSize LOCKER (Locker stays separate, NOT XS).
// XS units = UnitSize SMALL. M Units = UnitSize MEDIUM. L Units = UnitSize LARGE.
// XL Units = Extra Large — NO such UnitSize row exists in the schema, seed or
// migrations (codes are exactly LOCKER / SMALL / MEDIUM / LARGE; the old XLBIZ
// market key was dropped with the floor-plan P1 work — see src/core/market.ts).
// The XL bucket is therefore implemented as 0 units / 0 sqft and flagged in
// `unitGroups.notes`; no migration or seed row is created.
export interface FacilitySizeGroupDef {
  key: 'locker' | 'xs' | 'm' | 'l' | 'xl';
  label: string;
  /** UnitSize codes (upper-cased) feeding this bucket; empty = no DB code. */
  sizeCodes: string[];
}

export const FACILITY_SIZE_GROUPS: readonly FacilitySizeGroupDef[] = [
  { key: 'locker', label: 'Locker', sizeCodes: ['LOCKER'] },
  { key: 'xs', label: 'XS', sizeCodes: ['SMALL'] },
  { key: 'm', label: 'M', sizeCodes: ['MEDIUM'] },
  { key: 'l', label: 'L', sizeCodes: ['LARGE'] },
  { key: 'xl', label: 'XL (Extra Large)', sizeCodes: [] },
] as const;

export const XL_MISSING_CODE_NOTE =
  'No Extra Large UnitSize code exists in the DB (codes are LOCKER / SMALL / MEDIUM / LARGE) — the XL bucket reports 0 units / 0 sqft until such a size is added via migration + seed.';

export interface UnitGroupsReport {
  /** Overall units = all non-deleted units in scope (equals the bucket sum
   * for the current 4-code catalogue; any future/unknown size code counts in
   * overall but in no bucket). */
  overall: { units: number; areaSqft: number };
  groups: Array<{
    key: string;
    label: string;
    sizeCodes: string[];
    units: number;
    areaSqft: number;
    areaSharePct: number;
  }>;
  notes: string[];
}

/** 1dp guard-wrapped helpers for the facility contract (ratios stay 4dp in core). */
function round1(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
}

/** Corridor area = max(0, UFA − NLA), 1dp, null-safe. */
export function corridorAreaOf(ufaSqft: number | null | undefined, nlaSqft: number | null | undefined): number {
  const ufa = typeof ufaSqft === 'number' && Number.isFinite(ufaSqft) ? ufaSqft : 0;
  const nla = typeof nlaSqft === 'number' && Number.isFinite(nlaSqft) ? nlaSqft : 0;
  return round1(Math.max(0, ufa - nla));
}

/** GFA → UFA efficiency (%) = UFA/GFA*100, zero-division guarded, 1dp. */
export function gfaToUfaEfficiencyPctOf(
  ufaSqft: number | null | undefined,
  gfaSqft: number | null | undefined,
): number {
  const ufa = typeof ufaSqft === 'number' && Number.isFinite(ufaSqft) ? ufaSqft : 0;
  const gfa = typeof gfaSqft === 'number' && Number.isFinite(gfaSqft) ? gfaSqft : 0;
  return gfa > 0 ? round1((ufa / gfa) * 100) : 0;
}

/** UFA → NLA efficiency (%) = NLA/UFA*100, zero-division guarded, 1dp. */
export function ufaToNlaEfficiencyPctOf(
  nlaSqft: number | null | undefined,
  ufaSqft: number | null | undefined,
): number {
  const nla = typeof nlaSqft === 'number' && Number.isFinite(nlaSqft) ? nlaSqft : 0;
  const ufa = typeof ufaSqft === 'number' && Number.isFinite(ufaSqft) ? ufaSqft : 0;
  return ufa > 0 ? round1((nla / ufa) * 100) : 0;
}

/**
 * Per-size unit groups over nominal Unit.sqft sums (placed + unplaced,
 * soft-deleted units already filtered by the caller). Overall = sum of all
 * buckets. Additive — unit_mix.bySize (billable-Q histogram) is untouched.
 */
export function buildUnitGroups(units: Array<{ sizeCode: string | null | undefined; sqft: number }>): UnitGroupsReport {
  const perCode = new Map<string, { units: number; areaSqft: number }>();
  let overallUnits = 0;
  let overallArea = 0;
  for (const u of units) {
    const code = String(u.sizeCode || '').toUpperCase();
    const sqft = typeof u.sqft === 'number' && Number.isFinite(u.sqft) && u.sqft > 0 ? u.sqft : 0;
    overallUnits += 1;
    overallArea += sqft;
    const band = perCode.get(code) ?? { units: 0, areaSqft: 0 };
    band.units += 1;
    band.areaSqft += sqft;
    perCode.set(code, band);
  }
  overallArea = round1(overallArea);
  const groups = FACILITY_SIZE_GROUPS.map((def) => {
    let groupUnits = 0;
    let groupArea = 0;
    for (const code of def.sizeCodes) {
      const band = perCode.get(code);
      if (band) {
        groupUnits += band.units;
        groupArea += band.areaSqft;
      }
    }
    groupArea = round1(groupArea);
    return {
      key: def.key,
      label: def.label,
      sizeCodes: [...def.sizeCodes],
      units: groupUnits,
      areaSqft: groupArea,
      areaSharePct: overallArea > 0 ? round1((groupArea / overallArea) * 100) : 0,
    };
  });
  return { overall: { units: overallUnits, areaSqft: overallArea }, groups, notes: [XL_MISSING_CODE_NOTE] };
}

function decimalToCents(v: Prisma.Decimal | number | null | undefined): bigint {
  if (v == null) return 0n;
  return BigInt(Math.round(toNum(v) * 100));
}

function round4(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

function moneyJson(cents: bigint): { cents: number; sgd: number } {
  const c = Number(cents);
  return { cents: c, sgd: Math.round(c) / 100 };
}

function areaJson(a: { q: bigint; sqft: number }): { q: string; sqft: number } {
  return { q: a.q.toString(), sqft: a.sqft };
}

function zeroArea(): { q: string; sqft: number } {
  return { q: '0', sqft: 0 };
}

/** Block-name -> metric region kind heuristic (transparent via kind_source). */
export function mapBlockKind(name: string): RegionKind {
  const n = name.toLowerCase();
  if (/(lift|stair|escalator)/.test(n)) return 'CIRCULATION_VERTICAL';
  if (/(aisle|walk|corridor|entrance|exit|lobby|passage)/.test(n)) return 'CIRCULATION_AISLE';
  if (/(toilet|wc|restroom|bath|washroom)/.test(n)) return 'RESTROOM';
  if (/(plant|mech|elect|riser|mdf|switch|pump|ahu|genset)/.test(n)) return 'PLANT_MECHANICAL';
  if (/(office|retail|counter|reception)/.test(n)) return 'OFFICE_RETAIL';
  if (/(column|struct|pillar|shear)/.test(n)) return 'STRUCTURAL';
  if (/(loading|dock)/.test(n)) return 'LOADING_BAY';
  if (/(outdoor|open|yard)/.test(n)) return 'NON_ENCLOSED';
  return 'CIRCULATION_AISLE';
}

/**
 * Climate-control heuristic over the free-text Unit.climateControl column.
 * 'Ambient climate' (the seed value) is NOT controlled; strings like
 * 'Climate controlled' / 'Air-con' are. No new flags — Phase 3 may add one.
 */
export function isClimateControlled(climateControl: string | null | undefined): boolean {
  if (!climateControl) return false;
  const s = climateControl.toLowerCase();
  if (/(ambient|non-climate|not climate|uncontrolled)/.test(s)) return false;
  return /(climate|air-con|aircon|conditioned)/.test(s);
}

/** Market monthly rent in integer cents (size -> MARKET_PSF reference table). */
export function marketMonthlyCents(sizeCode: string, sqft: number): { cents: bigint; source: 'MARKET_PSF' } | null {
  const psf = MARKET_PSF[String(sizeCode || '').toUpperCase()];
  if (psf == null || !Number.isFinite(psf) || !(sqft > 0)) return null;
  return { cents: BigInt(Math.round(psf * sqft * 100)), source: 'MARKET_PSF' };
}

// ---------- report shape (all JSON-safe: no BigInt, no undefined) ----------

export interface FloorMetricsReport {
  schema_version: number;
  geometry_hash: string;
  facility: { id: string; code: string; name: string };
  floor: { id: string; level: number; name: string; canvasWidthFt: number; canvasHeightFt: number };
  coverage: { placedUnits: number; totalUnits: number; unplacedUnits: number; unplacedCodes: string[] };
  assumptions: {
    measurement_basis: string;
    pricing_basis: string;
    gla_convention: string;
    wall_thickness_ft: { partition: number; demising: number; exterior: number };
    residual_tolerance_sqft: number;
    min_aisle_width_ft: number;
    access_model: string;
    ceiling_height_ft: number;
    market_rate_source: string;
    basis_notes: string[];
  };
  geometry: {
    gfa: { q: string; sqft: number };
    /** 'USER' = operator-entered FloorPlan.gfaSqft; 'CANVAS' = canvas-rect fallback. */
    gfaSource: GfaSource;
    exteriorWall: { q: string; sqft: number };
    /** LINE-ONLY (marked-area) usable floor area — 0 with no contributing marked line. */
    ufa: { q: string; sqft: number };
    /** LINE-ONLY NLA (placements clipped to the marked loops, capped ≤ UFA). */
    nlaEnclosed: { q: string; sqft: number };
    /** Always 0 — the marked-area model has no outdoor/enclosed split. */
    nlaOutdoor: { q: string; sqft: number };
    /** LINE-ONLY NLA total (= nlaEnclosed; outdoor is 0). */
    nlaTotal: { q: string; sqft: number };
    /** Marked remainder (UFA − NLA, ≥ 0). */
    common: { q: string; sqft: number };
    /** Additive alias of `common` (= UFA − NLA, ≥ 0, 1dp) — Total Corridor Area. */
    corridorArea: { q: string; sqft: number };
    /** Additive: GFA → UFA efficiency (%) = UFA/GFA*100, guarded, 1dp. */
    gfaToUfaEfficiencyPct: number;
    /** Additive: UFA → NLA efficiency (%) = NLA/UFA*100, guarded, 1dp. */
    ufaToNlaEfficiencyPct: number;
    glaExclusive: { area: { q: string; sqft: number }; convention: string };
    glaInclusive: { area: { q: string; sqft: number }; convention: string };
    efficiency: number;
    loadFactor: number;
    derivedCirculation: { q: string; sqft: number };
    droppedSlivers: { q: string; sqft: number };
    balanced: boolean;
  };
  /** Authoritative marked-area figures (byte-identical to the plan-read shape). */
  boundaryMetrics: BoundaryMetrics;
  /**
   * Additive per-size unit groups (owner-confirmed mapping: Locker=LOCKER,
   * XS=SMALL, M=MEDIUM, L=LARGE, XL=missing → 0/0 flagged). Overall = sum of
   * all buckets over nominal Unit.sqft (placed + unplaced, non-deleted).
   */
  unitGroups: UnitGroupsReport;
  occupancy: {
    physical: { occupiedUnits: number; totalUnits: number; pct: number };
    sqft: { occupiedQ: string; occupiedSqft: number; nlaQ: string; nlaSqft: number; pct: number };
    economic: { actual: { cents: number; sgd: number }; gpi: { cents: number; sgd: number }; pct: number };
  };
  revenue: {
    gpiMonthly: { cents: number; sgd: number };
    gpiAnnual: { cents: number; sgd: number };
    actualMonthly: { cents: number; sgd: number };
    actualAnnual: { cents: number; sgd: number };
    ratePerSfAnnual: number;
    revpafMonthly: number;
    revpafAnnual: number;
    revpofMonthly: number;
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
  };
  unit_mix: {
    climateControlledQ: string;
    climateControlledSqft: number;
    totalQ: string;
    totalSqft: number;
    climateControlledPct: number;
    bySize: Array<{ sizeCode: string; units: number; areaQ: string; areaSqft: number; areaSharePct: number }>;
  };
  volumetric: {
    units: Array<{
      regionId: string;
      label: string;
      clearSqft: number;
      heightFt: number;
      volumeEighth: string;
      cubicFt: number;
    }>;
    totalVolumeEighth: string;
    totalCubicFt: number;
    defaultHeightFt: number;
  };
  units: Array<{
    regionId: string;
    unitId: string;
    unitCode: string;
    name: string;
    sizeCode: string;
    sizeName: string;
    sqft: number;
    status: string;
    occupied: boolean;
    climateControlled: boolean;
    monthlyRate: { cents: number; sgd: number };
    marketRate: { cents: number; sgd: number };
    marketRateSource: string;
    nominal: { q: string; sqft: number };
    gross: { q: string; sqft: number };
    clear: { q: string; sqft: number };
    billable: { q: string; sqft: number };
    nominalVariancePct: number | null;
    nominalVarianceWarn: boolean | null;
    ceilingFt: number | null;
    cubicFt: number;
    kindSource: string;
    /** Effective door compass edges driving reachability for this unit. */
    doors: Edge[] | null;
    /** 'authored' = editor N/S/E/W toggles; 'auto' = AUTO_ALL_EDGES fallback. */
    doorSource: 'authored' | 'auto';
  }>;
  circulation: Array<{
    id: string;
    area: { q: string; sqft: number };
    cells: number;
    reachable: boolean;
    seedFeet: { x: number; y: number };
  }>;
  reachability: Array<{ regionId: string; label: string; reachable: boolean; code?: string }>;
  validation: Array<{ code: string; severity: string; region_ids: string[]; message: string }>;
  statusBreakdown: Record<string, number>;
}

// ---------- live compute ----------

interface PlacedUnit {
  placementId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  stackTier: number;
  doorEdges: string | null; // canonical CSV subset (N/S/E/W) or NULL = unauthored
  unit: {
    id: string;
    unitCode: string;
    name: string | null;
    sqft: number;
    status: string;
    monthlyRate: Prisma.Decimal | number;
    climateControl: string | null;
    hasAC: boolean;
    hasPillar: boolean;
    size: { code: string; name: string };
  };
}

const AUTO_DOOR_EDGES: readonly Edge[] = ['N', 'S', 'E', 'W'];

/**
 * Effective core doors per placed unit (Phase 3 door authoring). A placement
 * with authored `doorEdges` (editor N/S/E/W toggles) contributes exactly
 * those edges (`doorSource: 'authored'`); an unauthored placement falls back
 * to all four edges (`doorSource: 'auto'`, the pre-Phase-3 AUTO_ALL_EDGES
 * behaviour — edges facing units/walls resolve to nothing in the core).
 * `authoredOnly` feeds geometryHash so door edits flip the fingerprint.
 */
export function buildUnitDoors(placed: Array<{ doorEdges: string | null; unit: { id: string } }>): {
  doors: DoorInput[];
  authoredOnly: DoorInput[];
  doorSourceByRegion: Map<string, { edges: Edge[]; source: 'authored' | 'auto' }>;
  authoredUnits: number;
} {
  const doors: DoorInput[] = [];
  const authoredOnly: DoorInput[] = [];
  const doorSourceByRegion = new Map<string, { edges: Edge[]; source: 'authored' | 'auto' }>();
  let authoredUnits = 0;
  for (const p of placed) {
    const regionId = `u-${p.unit.id}`;
    const authored = doorEdgesToArray(p.doorEdges);
    if (authored && authored.length > 0) {
      authoredUnits += 1;
      for (const edge of authored) {
        doors.push({ regionId, edge });
        authoredOnly.push({ regionId, edge });
      }
      doorSourceByRegion.set(regionId, { edges: authored, source: 'authored' });
    } else {
      for (const edge of AUTO_DOOR_EDGES) doors.push({ regionId, edge });
      doorSourceByRegion.set(regionId, { edges: [...AUTO_DOOR_EDGES], source: 'auto' });
    }
  }
  return { doors, authoredOnly, doorSourceByRegion, authoredUnits };
}

function assertRect(name: string, x: number, y: number, w: number, h: number): void {
  for (const [v, label] of [
    [x, 'x'],
    [y, 'y'],
    [w, 'width'],
    [h, 'height'],
  ] as Array<[number, string]>) {
    if (!Number.isInteger(v)) {
      throw new AppError(400, 'NON_RECTANGULAR', `${name}: ${label} must be an integer-foot rect coordinate, got ${v}`);
    }
  }
  if (w < 1 || h < 1 || x < 0 || y < 0) {
    throw new AppError(400, 'NON_RECTANGULAR', `${name}: non-positive or negative geometry is not measurable (${x},${y} ${w}x${h})`);
  }
}

/** Live compute from the current canvas geometry. Throws 404 when floor/plan is missing. */
export async function getFloorMetrics(floorId: string): Promise<FloorMetricsReport> {
  const floor = await prisma.floor.findUnique({ where: { id: floorId }, include: { branch: true } });
  if (!floor) throw new AppError(404, 'NOT_FOUND', `Floor ${floorId} not found`);

  const plan = await prisma.floorPlan.findUnique({
    where: { floorId },
    include: {
      placements: {
        where: { unit: { deletedAt: null, status: { not: 'INACTIVE' } } },
        include: { unit: { include: { size: true } } },
        orderBy: { createdAt: 'asc' },
      },
      blocks: { orderBy: { createdAt: 'asc' } },
      boundaries: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
    },
  });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `No floor plan exists for floor ${floorId}`);
  if (!Number.isInteger(plan.width) || !Number.isInteger(plan.height) || plan.width < 1 || plan.height < 1) {
    throw new AppError(400, 'VALIDATION', `Floor plan canvas for floor ${floorId} is not initialized (${plan.width}x${plan.height} ft) — save the canvas first`);
  }

  const placed = plan.placements as unknown as PlacedUnit[];
  for (const p of placed) assertRect(`Placement ${p.unit.unitCode}`, p.x, p.y, p.width, p.height);
  for (const b of plan.blocks) assertRect(`Block ${b.name}`, b.x, b.y, b.width, b.height);

  // Duplicate block names are suffixed deterministically so decoration never
  // trips DUPLICATE_LABEL (unitCodes are unique by schema, so units are safe).
  const nameCounts = new Map<string, number>();
  const blockLabels = new Map<string, string>();
  for (const b of [...plan.blocks].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const n = (nameCounts.get(b.name) ?? 0) + 1;
    nameCounts.set(b.name, n);
    blockLabels.set(b.id, n === 1 ? b.name : `${b.name} (${n})`);
  }

  const regions: RegionInput[] = [
    ...placed.map((p) => ({
      id: `u-${p.unit.id}`,
      label: p.unit.unitCode,
      kind: (String(p.unit.size.code).toUpperCase() === 'LOCKER' ? 'LOCKER' : 'UNIT_STORAGE') as RegionKind,
      xFeet: p.x,
      yFeet: p.y,
      wFeet: p.width,
      dFeet: p.height,
      stackLevel: p.stackTier ?? 0,
    })),
    ...plan.blocks.map((b) => ({
      id: `blk-${b.id}`,
      label: blockLabels.get(b.id) ?? b.name,
      kind: mapBlockKind(b.name),
      xFeet: b.x,
      yFeet: b.y,
      wFeet: b.width,
      dFeet: b.height,
    })),
  ];

  const unitDoors = buildUnitDoors(placed);
  const baseInput: FloorMetricsInput = {
    outlineFeet: [
      { x: 0, y: 0 },
      { x: plan.width, y: 0 },
      { x: plan.width, y: plan.height },
      { x: 0, y: plan.height },
    ],
    regions,
    doors: unitDoors.doors,
    entrances: [],
  };

  // Two-pass: first pass locates derived circulation; the entrance is seeded
  // at the largest component's interior point, then the floor is recomputed
  // with access resolved (authored unit edges where present, all unit edges
  // otherwise — see buildUnitDoors).
  const pass1 = computeFloorMetrics(baseInput);
  const largest = [...pass1.circulation].sort((a, b) => Number(b.area.q - a.area.q))[0];
  const m = largest ? computeFloorMetrics({ ...baseInput, entrances: [largest.seedFeet] }) : pass1;
  const hash = geometryHash(regions, unitDoors.authoredOnly);

  // Operator-entered GFA (FloorPlan.gfaSqft) overrides the canvas-derived GFA
  // in geometry.gfa + efficiency + the revenue chain. NULL/unusable falls back
  // to the canvas rect and is flagged in basis_notes (never fabricated).
  const userGfaRaw = plan.gfaSqft ?? null;
  const userGfa = typeof userGfaRaw === 'number' && Number.isFinite(userGfaRaw) && userGfaRaw > 0 ? userGfaRaw : null;
  const gfaSource: GfaSource = userGfa != null ? 'USER' : 'CANVAS';
  const effGfaQ = userGfa != null ? BigInt(Math.round(userGfa * Number(Q_PER_SQFT))) : m.gfa.q;
  const effGfaSqft = userGfa ?? m.gfa.sqft;

  // LINE-ONLY (marked-area) UFA/NLA — the authoritative facility figures (see
  // computeBoundaryMetrics in floorPlans.ts): marked gross minus blocks/solid
  // structure rects (UFA), placements clipped to the marked loops capped ≤ UFA
  // (NLA). All-zero with boundaryClosed false when no marked line contributes
  // area — never the whole-canvas rect. `sqft` echoes the 1dp boundaryMetrics
  // numbers exactly; `q` is derived from them (BigInt would throw via JSON).
  const boundaryMetrics: BoundaryMetrics = computeBoundaryMetrics({
    boundaries: (plan.boundaries ?? []).map((b) => ({ points: b.points, closed: b.closed })),
    blocks: plan.blocks.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })),
    structure: (plan as { structure?: unknown }).structure ?? null,
    placements: placed.map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height })),
    gfaSqft: userGfa,
  });
  const lineUfaQ = BigInt(Math.round(boundaryMetrics.ufa * Number(Q_PER_SQFT)));
  const lineNlaQ = BigInt(Math.round(boundaryMetrics.nla * Number(Q_PER_SQFT)));
  const lineCommonSqft = Math.round(Math.max(0, boundaryMetrics.ufa - boundaryMetrics.nla) * 10) / 10;
  const lineCommonQ = BigInt(Math.round(lineCommonSqft * Number(Q_PER_SQFT)));
  const lineEfficiency = effGfaSqft > 0 ? boundaryMetrics.nla / effGfaSqft : 0;
  const lineLoadFactor = boundaryMetrics.nla > 0 ? boundaryMetrics.ufa / boundaryMetrics.nla : 1;

  const coreUnits = new Map(m.units.map((u) => [u.regionId, u]));
  const occupiedOf = (status: string): boolean => OCCUPIED_STATUSES.has(status);

  const perUnit = placed.map((p) => {
    const regionId = `u-${p.unit.id}`;
    const core = coreUnits.get(regionId);
    const occupied = occupiedOf(p.unit.status);
    const actualCents = decimalToCents(p.unit.monthlyRate);
    const market = marketMonthlyCents(p.unit.size.code, p.unit.sqft);
    return {
      p,
      regionId,
      occupied,
      actualCents,
      marketCents: market ? market.cents : actualCents,
      marketRateSource: market ? market.source : 'ACTUAL_FALLBACK',
      // hasAC is the source of truth; the legacy climateControl string
      // heuristic stays as an OR fallback so pre-flag rows keep their share
      // (the flag migration defaults old rows to false — never downgrade them).
      climateControlled: p.unit.hasAC === true || isClimateControlled(p.unit.climateControl),
      billableQ: core ? core.billable.q : 0n,
      clearQ: core ? core.clear.q : 0n,
    };
  });

  const nlaQ = lineNlaQ;
  const occupiedQ = perUnit.reduce((s, u) => s + (u.occupied ? u.billableQ : 0n), 0n);
  const actualCents = perUnit.reduce((s, u) => s + (u.occupied ? u.actualCents : 0n), 0n);
  const gpiCents = perUnit.reduce((s, u) => s + u.marketCents, 0n);

  const occupancy = computeOccupancy(
    perUnit.map((u) => ({ regionId: u.regionId, billableQ: u.billableQ, occupied: u.occupied })),
    nlaQ,
    actualCents,
    gpiCents,
  );
  const revenue = computeRevenue(
    perUnit.map((u) => ({ regionId: u.regionId, occupied: u.occupied, actualCents: u.actualCents, marketCents: u.marketCents })),
    nlaQ,
    occupiedQ,
    effGfaQ,
    lineEfficiency,
  );
  const mix = computeUnitMix(
    perUnit.map((u) => ({
      regionId: u.regionId,
      sizeCode: String(u.p.unit.size.code).toUpperCase(),
      billableQ: u.billableQ,
      climateControlled: u.climateControlled,
    })),
  );
  const volumetric = computeVolumetric(
    perUnit.map((u) => ({ regionId: u.regionId, label: u.p.unit.unitCode, clearQ: u.clearQ })),
    DEFAULT_CLEAR_HEIGHT_FT,
  );
  const cubicByRegion = new Map(volumetric.units.map((v) => [v.regionId, v]));

  const unplacedUnits = await prisma.unit.findMany({
    where: { floorId, deletedAt: null, status: { not: 'INACTIVE' }, placement: { is: null } },
    select: { unitCode: true, sqft: true, size: { select: { code: true } } },
    orderBy: { unitCode: 'asc' },
  });
  const statusBreakdown: Record<string, number> = {};
  for (const u of perUnit) statusBreakdown[u.p.unit.status] = (statusBreakdown[u.p.unit.status] ?? 0) + 1;

  const marketFallbacks = perUnit.filter((u) => u.marketRateSource === 'ACTUAL_FALLBACK').length;

  // Additive facility-contract fields (all existing fields kept byte-identical):
  // corridorArea aliases geometry.common; the two efficiency pcts are guarded
  // 1dp percentages; unitGroups covers ALL floor units (placed + unplaced,
  // non-deleted) over nominal Unit.sqft sums.
  const corridorSqft = lineCommonSqft;
  const gfaToUfaEfficiencyPct = gfaToUfaEfficiencyPctOf(boundaryMetrics.ufa, effGfaSqft);
  const ufaToNlaEfficiencyPct = ufaToNlaEfficiencyPctOf(boundaryMetrics.nla, boundaryMetrics.ufa);
  const unitGroups = buildUnitGroups([
    ...perUnit.map((u) => ({ sizeCode: u.p.unit.size.code, sqft: u.p.unit.sqft })),
    ...unplacedUnits.map((u) => ({ sizeCode: u.size.code, sqft: u.sqft })),
  ]);

  return {
    schema_version: METRICS_SCHEMA_VERSION,
    geometry_hash: hash,
    facility: { id: floor.branch.id, code: floor.branch.code, name: floor.branch.name },
    floor: { id: floor.id, level: floor.level, name: floor.name, canvasWidthFt: plan.width, canvasHeightFt: plan.height },
    coverage: {
      placedUnits: perUnit.length,
      totalUnits: perUnit.length + unplacedUnits.length,
      unplacedUnits: unplacedUnits.length,
      unplacedCodes: unplacedUnits.map((u) => u.unitCode),
    },
    assumptions: {
      measurement_basis: MEASUREMENT_BASIS,
      pricing_basis: 'GROSS',
      gla_convention: 'DUAL_TAGGED_EXCLUSIVE_AND_INCLUSIVE',
      wall_thickness_ft: {
        partition: WALL_THICKNESS_FEET.partition,
        demising: WALL_THICKNESS_FEET.demising,
        exterior: WALL_THICKNESS_FEET.exterior,
      },
      residual_tolerance_sqft: RESIDUAL_TOLERANCE_SQFT,
      min_aisle_width_ft: MIN_AISLE_WIDTH_FT,
      access_model: unitDoors.authoredUnits > 0 ? 'MIXED_AUTHORED_AND_AUTO_SEEDED_ENTRANCE' : 'AUTO_ALL_EDGES_SEEDED_ENTRANCE',
      ceiling_height_ft: DEFAULT_CLEAR_HEIGHT_FT,
      market_rate_source: 'MARKET_PSF reference table (size -> sgd/sqft/month)',
      basis_notes: [
        'GPI assumes 100% occupancy at market rent (size -> MARKET_PSF reference table); actual is contracted rent on OCCUPIED/OVERDUE units only.',
        gfaSource === 'USER'
          ? `GFA is operator-entered (${userGfa} sqft) — geometry.gfa, efficiency and the revenue chain use it instead of the canvas-derived rect (${plan.width}x${plan.height} ft = ${m.gfa.sqft} sqft).`
          : `No operator-entered GFA on this plan — GFA falls back to the canvas-derived rect (${plan.width}x${plan.height} ft); enter a GFA per plan to override (gfaSource CANVAS).`,
        ...(gfaSource === 'USER' && lineEfficiency > 1
          ? [`Operator-entered GFA (${userGfa} sqft) is below line-only enclosed NLA (${boundaryMetrics.nla} sqft) — efficiency exceeds 100%; verify the entered GFA.`]
          : []),
        ...(boundaryMetrics.boundaryClosed
          ? [
              `UFA/NLA are line-only (marked-area, authoritative = boundaryMetrics): geometry.ufa ${boundaryMetrics.ufa} sqft (marked gross ${boundaryMetrics.facilityAreaSqft} minus blocks/structure), geometry.nlaEnclosed/nlaTotal ${boundaryMetrics.nla} sqft (placements clipped to loops, capped at UFA); outdoor split is 0 under the marked-area model. Canvas-tessellated whole-canvas figures were UFA ${m.ufa.sqft} / NLA ${m.nlaTotal.sqft} sqft (diagnostic only, never facility UFA/NLA).`,
            ]
          : [
              `No marked area on this plan (boundaryClosed false) — geometry.ufa/nla* are 0; canvas-tessellated whole-canvas figures were UFA ${m.ufa.sqft} / NLA ${m.nlaTotal.sqft} sqft (diagnostic only, never facility UFA/NLA). Draw a line (3+ vertices, then close the loop) to measure UFA/NLA.`,
            ]),
        unitDoors.authoredUnits > 0
          ? `${unitDoors.authoredUnits} unit(s) use editor-authored door edges (N/S/E/W toggles); the rest fall back to every edge as a door, and the entrance is seeded at the largest derived circulation component (two-pass compute). Units with no abutting circulation report DOOR_BLOCKED.`
          : 'No unit has authored door edges yet: every unit edge is treated as a door and the entrance is seeded at the largest derived circulation component (two-pass compute). Units with no abutting circulation report DOOR_BLOCKED.',
        'Circulation-kind blocks (Corridor/aisle/lift/lobby/loading) are traversable: a spanning Corridor joins derived circulation instead of splitting it (region-to-circulation connectivity).',
        'Block region kinds are name-heuristic mappings (kind_source heuristic on decoration; placements are exact).',
        'Legacy structure JSON decorations are not measured; rect markers already live as blocks.',
        `Climate-controlled share uses the Unit.hasAC flag, OR the legacy Unit.climateControl string heuristic ('Ambient climate' counts as ambient) for pre-flag rows.`,
        `Clear heights are not stored: every unit uses the default ${DEFAULT_CLEAR_HEIGHT_FT} ft ceiling; no per-unit overrides exist yet.`,
        ...(marketFallbacks > 0
          ? [`${marketFallbacks} unit(s) have no MARKET_PSF entry for their size and fall back to actual rent in GPI.`]
          : []),
        ...(unplacedUnits.length > 0
          ? [`${unplacedUnits.length} floor unit(s) have no placement and are excluded from measured areas (see coverage.unplacedCodes).`]
          : []),
        'unitGroups carries the owner-confirmed per-size buckets over nominal Unit.sqft (Locker=LOCKER, XS=SMALL, M=MEDIUM, L=LARGE, overall = sum); the XL (Extra Large) bucket is 0/0 — no such UnitSize code exists in the DB (see unitGroups.notes).',
      ],
    },
    geometry: {
      gfa: areaJson({ q: effGfaQ, sqft: effGfaSqft }),
      gfaSource,
      exteriorWall: areaJson(m.exteriorWall),
      ufa: { q: lineUfaQ.toString(), sqft: boundaryMetrics.ufa },
      nlaEnclosed: { q: lineNlaQ.toString(), sqft: boundaryMetrics.nla },
      nlaOutdoor: zeroArea(),
      nlaTotal: { q: lineNlaQ.toString(), sqft: boundaryMetrics.nla },
      common: { q: lineCommonQ.toString(), sqft: lineCommonSqft },
      corridorArea: { q: lineCommonQ.toString(), sqft: corridorSqft },
      gfaToUfaEfficiencyPct,
      ufaToNlaEfficiencyPct,
      glaExclusive: { area: { q: lineNlaQ.toString(), sqft: boundaryMetrics.nla }, convention: m.glaExclusive.convention },
      glaInclusive: { area: { q: lineUfaQ.toString(), sqft: boundaryMetrics.ufa }, convention: m.glaInclusive.convention },
      efficiency: round4(lineEfficiency),
      loadFactor: round4(lineLoadFactor),
      derivedCirculation: areaJson(m.derivedCirculation),
      droppedSlivers: areaJson(m.droppedSlivers),
      balanced: m.identity.balanced,
    },
    boundaryMetrics,
    unitGroups,
    occupancy: {
      physical: { ...occupancy.physical, pct: round4(occupancy.physical.pct) },
      sqft: {
        occupiedQ: occupancy.sqft.occupiedQ.toString(),
        occupiedSqft: occupancy.sqft.occupiedSqft,
        nlaQ: occupancy.sqft.nlaQ.toString(),
        nlaSqft: occupancy.sqft.nlaSqft,
        pct: round4(occupancy.sqft.pct),
      },
      economic: { actual: moneyJson(occupancy.economic.actualCents), gpi: moneyJson(occupancy.economic.gpiCents), pct: round4(occupancy.economic.pct) },
    },
    revenue: {
      gpiMonthly: moneyJson(revenue.gpiMonthlyCents),
      gpiAnnual: moneyJson(revenue.gpiAnnualCents),
      actualMonthly: moneyJson(revenue.actualMonthlyCents),
      actualAnnual: moneyJson(revenue.actualAnnualCents),
      ratePerSfAnnual: round4(revenue.ratePerSfAnnual),
      revpafMonthly: round4(revenue.revpafMonthly),
      revpafAnnual: round4(revenue.revpafAnnual),
      revpofMonthly: round4(revenue.revpofMonthly),
      chain: {
        gfaSqft: revenue.chain.gfaSqft,
        efficiency: round4(revenue.chain.efficiency),
        nlaSqft: revenue.chain.nlaSqft,
        occupiedSqft: revenue.chain.occupiedSqft,
        occupancySqftPct: round4(revenue.chain.occupancySqftPct),
        gpiMonthlySgd: revenue.chain.gpiMonthlySgd,
        actualMonthlySgd: revenue.chain.actualMonthlySgd,
      },
      basisNote: revenue.basisNote,
    },
    unit_mix: {
      climateControlledQ: mix.climateControlledQ.toString(),
      climateControlledSqft: mix.climateControlledSqft,
      totalQ: mix.totalQ.toString(),
      totalSqft: mix.totalSqft,
      climateControlledPct: round4(mix.climateControlledPct),
      bySize: mix.bySize.map((b) => ({
        sizeCode: b.sizeCode,
        units: b.units,
        areaQ: b.areaQ.toString(),
        areaSqft: b.areaSqft,
        areaSharePct: round4(b.areaSharePct),
      })),
    },
    volumetric: {
      units: volumetric.units.map((v) => ({
        regionId: v.regionId,
        label: v.label,
        clearSqft: v.clearSqft,
        heightFt: v.heightFt,
        volumeEighth: v.volumeEighth.toString(),
        cubicFt: v.cubicFt,
      })),
      totalVolumeEighth: volumetric.totalVolumeEighth.toString(),
      totalCubicFt: volumetric.totalCubicFt,
      defaultHeightFt: volumetric.defaultHeightFt,
    },
    units: perUnit
      .slice()
      .sort((a, b) => (a.p.unit.unitCode < b.p.unit.unitCode ? -1 : 1))
      .map((u) => {
        const core = coreUnits.get(u.regionId);
        const cubic = cubicByRegion.get(u.regionId);
        const doorInfo = unitDoors.doorSourceByRegion.get(u.regionId) ?? { edges: [...AUTO_DOOR_EDGES], source: 'auto' as const };
        return {
          regionId: u.regionId,
          unitId: u.p.unit.id,
          unitCode: u.p.unit.unitCode,
          name: u.p.unit.name ?? u.p.unit.unitCode,
          sizeCode: String(u.p.unit.size.code).toUpperCase(),
          sizeName: u.p.unit.size.name,
          sqft: u.p.unit.sqft,
          status: u.p.unit.status,
          occupied: u.occupied,
          climateControlled: u.climateControlled,
          monthlyRate: moneyJson(u.actualCents),
          marketRate: moneyJson(u.marketCents),
          marketRateSource: u.marketRateSource,
          nominal: core ? areaJson(core.nominal) : zeroArea(),
          gross: core ? areaJson(core.gross) : zeroArea(),
          clear: core ? areaJson(core.clear) : zeroArea(),
          billable: core ? areaJson(core.billable) : zeroArea(),
          nominalVariancePct: core ? core.nominalVariancePct : null,
          nominalVarianceWarn: core ? core.nominalVarianceWarn : null,
          ceilingFt: null,
          cubicFt: cubic ? cubic.cubicFt : 0,
          kindSource: 'placement',
          doors: doorInfo.edges,
          doorSource: doorInfo.source,
        };
      }),
    circulation: m.circulation.map((c) => ({
      id: c.id,
      area: areaJson(c.area),
      cells: c.cells,
      reachable: c.reachable,
      seedFeet: c.seedFeet,
    })),
    reachability: m.reachability.map((r) => ({
      regionId: r.regionId,
      label: r.label,
      reachable: r.reachable,
      ...(r.code !== undefined ? { code: r.code } : {}),
    })),
    validation: m.validations.map((v) => ({ code: v.code, severity: v.severity, region_ids: v.region_ids, message: v.message })),
    statusBreakdown,
  };
}

// ---------- facility-level rollup (additive) ----------

export interface FacilityMetricsFloorRow {
  floorId: string;
  level: number;
  name: string;
  hasPlan: boolean;
  gfaSqft: number;
  ufaSqft: number;
  nlaSqft: number;
  gfaSource: GfaSource | null;
  placedUnits: number;
  unplacedUnits: number;
  occupiedUnits: number;
}

export interface FacilityMetricsReport {
  facility: { id: string; code: string; name: string };
  /** Live-rollup source: per-floor live reports are summed (no snapshot selection). */
  source: 'LIVE';
  floors: FacilityMetricsFloorRow[];
  floorCount: number;
  floorsWithPlan: number;
  floorsWithoutPlan: string[];
  geometry: {
    gfa: { q: string; sqft: number };
    /** USER when every contributing plan is operator-entered, CANVAS when all
     * fall back to the canvas rect, MIXED otherwise (or when no plan exists). */
    gfaSource: GfaSource | 'MIXED';
    gfaSourcesByFloor: Array<{ floorId: string; gfaSource: GfaSource }>;
    ufa: { q: string; sqft: number };
    nlaEnclosed: { q: string; sqft: number };
    nlaOutdoor: { q: string; sqft: number };
    nlaTotal: { q: string; sqft: number };
    common: { q: string; sqft: number };
    /** Additive alias of `common` (= UFA − NLA, ≥ 0, 1dp) — Total Corridor Area. */
    corridorArea: { q: string; sqft: number };
    /** NLA/GFA ratio (display-boundary, 4dp) — guarded, 0 when GFA is 0. */
    efficiency: number;
    /** UFA/NLA ratio (display-boundary, 4dp) — guarded, 1 when NLA is 0. */
    loadFactor: number;
    /** Additive: GFA → UFA efficiency (%) = UFA/GFA*100, guarded, 1dp. */
    gfaToUfaEfficiencyPct: number;
    /** Additive: UFA → NLA efficiency (%) = NLA/UFA*100, guarded, 1dp. */
    ufaToNlaEfficiencyPct: number;
  };
  totals: {
    totalUnits: number;
    placedUnits: number;
    /** Facility sum of the coverage.unplacedUnits definition (no placement, non-deleted). */
    unplacedUnits: number;
    /** Facility sum of occupied units (status OCCUPIED + OVERDUE, RESERVED excluded). */
    occupiedUnits: number;
  };
  /**
   * Additive per-size unit groups over nominal Unit.sqft (whole facility,
   * non-deleted units; overall = all units, equalling the bucket sum for the
   * current 4-code catalogue). XL is 0/0 — no Extra Large UnitSize code exists
   * (see notes).
   */
  unitGroups: UnitGroupsReport;
  basis_notes: string[];
}

/**
 * Facility-level rollup: sums the per-floor LIVE reports (getFloorMetrics)
 * into one facility aggregate. Floors without a plan contribute zero geometry
 * and are listed in `floorsWithoutPlan` (their DB units still count in
 * totals/unitGroups). Conventions reused from the per-floor report:
 * zero-division guards on both efficiencies, NLA clamped ≤ UFA, and GFA falls
 * back to the canvas rect per plan (gfaSource CANVAS) unless the operator
 * entered a GFA (USER). Snapshot payloads are NOT summed — the rollup is
 * live; snapshots remain per-floor history. Every read filters
 * `deletedAt: null` (soft-delete rule) AND excludes INACTIVE units (they never
 * render on a plan — same rule as the plan reads in src/core/floorPlans.ts).
 */
export async function getFacilityMetrics(branchRef: string): Promise<FacilityMetricsReport> {
  const ref = String(branchRef || '').trim();
  const branch =
    (ref ? await prisma.branch.findUnique({ where: { id: ref } }) : null) ??
    (ref ? await prisma.branch.findUnique({ where: { code: ref } }) : null);
  if (!branch) throw new AppError(404, 'NOT_FOUND', `Facility ${branchRef} not found`);

  const floors = await prisma.floor.findMany({
    where: { branchId: branch.id },
    select: { id: true, level: true, name: true },
    orderBy: { level: 'asc' },
  });

  const rows: FacilityMetricsFloorRow[] = [];
  let gfaSum = 0;
  let ufaSum = 0;
  let nlaSum = 0;
  const gfaSourcesByFloor: Array<{ floorId: string; gfaSource: GfaSource }> = [];
  for (const f of floors) {
    try {
      const report = await getFloorMetrics(f.id);
      rows.push({
        floorId: f.id,
        level: f.level,
        name: f.name,
        hasPlan: true,
        gfaSqft: report.geometry.gfa.sqft,
        ufaSqft: report.geometry.ufa.sqft,
        nlaSqft: report.geometry.nlaTotal.sqft,
        gfaSource: report.geometry.gfaSource,
        placedUnits: report.coverage.placedUnits,
        unplacedUnits: report.coverage.unplacedUnits,
        occupiedUnits: report.occupancy.physical.occupiedUnits,
      });
      gfaSum += report.geometry.gfa.sqft;
      ufaSum += report.geometry.ufa.sqft;
      nlaSum += report.geometry.nlaTotal.sqft;
      gfaSourcesByFloor.push({ floorId: f.id, gfaSource: report.geometry.gfaSource });
    } catch (err) {
      // Floors with no plan (404) contribute zero geometry but stay visible;
      // any other error (e.g. invalid canvas geometry) still propagates so a
      // broken floor can never silently poison the facility aggregate.
      if (err instanceof AppError && err.status === 404) {
        rows.push({
          floorId: f.id,
          level: f.level,
          name: f.name,
          hasPlan: false,
          gfaSqft: 0,
          ufaSqft: 0,
          nlaSqft: 0,
          gfaSource: null,
          placedUnits: 0,
          unplacedUnits: 0,
          occupiedUnits: 0,
        });
        continue;
      }
      throw err;
    }
  }

  // Facility clamps mirror the per-floor conventions: areas ≥ 0, NLA ≤ UFA.
  const ufa = round1(Math.max(0, ufaSum));
  const nla = round1(Math.min(Math.max(0, nlaSum), ufa));
  const gfa = round1(Math.max(0, gfaSum));
  const corridor = corridorAreaOf(ufa, nla);
  const efficiency = gfa > 0 ? Math.round((nla / gfa) * 10000) / 10000 : 0;
  const loadFactor = nla > 0 ? Math.round((ufa / nla) * 10000) / 10000 : 1;
  const toQ = (sqft: number): string => BigInt(Math.round(sqft * Number(Q_PER_SQFT))).toString();

  const sources = new Set(gfaSourcesByFloor.map((s) => s.gfaSource));
  const gfaSource: GfaSource | 'MIXED' =
    sources.size === 0 ? 'CANVAS' : sources.size === 1 ? [...sources][0] : 'MIXED';

  // Facility-wide unit aggregates straight from the DB (all floors, non-deleted,
  // non-INACTIVE — INACTIVE units are out of the floorplan, so the rollup keeps
  // the same denominator as the per-floor coverage figures):
  // unplaced = the coverage.unplacedUnits definition (no placement row);
  // occupied = OCCUPIED + OVERDUE (RESERVED excluded, per revenue convention).
  const inactiveFilter = { status: { not: 'INACTIVE' as const } };
  const [allUnits, unplacedUnits, occupiedUnits] = await Promise.all([
    prisma.unit.findMany({
      where: { branchId: branch.id, deletedAt: null, ...inactiveFilter },
      select: { sqft: true, size: { select: { code: true } } },
    }),
    prisma.unit.count({ where: { branchId: branch.id, deletedAt: null, ...inactiveFilter, placement: { is: null } } }),
    prisma.unit.count({
      where: { branchId: branch.id, deletedAt: null, status: { in: ['OCCUPIED', 'OVERDUE'] } },
    }),
  ]);
  const unitGroups = buildUnitGroups(allUnits.map((u) => ({ sizeCode: u.size.code, sqft: u.sqft })));
  const placedUnits = Math.max(0, allUnits.length - unplacedUnits);

  const floorsWithoutPlan = rows.filter((r) => !r.hasPlan).map((r) => r.floorId);
  return {
    facility: { id: branch.id, code: branch.code, name: branch.name },
    source: 'LIVE',
    floors: rows,
    floorCount: floors.length,
    floorsWithPlan: rows.filter((r) => r.hasPlan).length,
    floorsWithoutPlan,
    geometry: {
      gfa: { q: toQ(gfa), sqft: gfa },
      gfaSource,
      gfaSourcesByFloor,
      ufa: { q: toQ(ufa), sqft: ufa },
      nlaEnclosed: { q: toQ(nla), sqft: nla },
      nlaOutdoor: { q: '0', sqft: 0 },
      nlaTotal: { q: toQ(nla), sqft: nla },
      common: { q: toQ(corridor), sqft: corridor },
      corridorArea: { q: toQ(corridor), sqft: corridor },
      efficiency,
      loadFactor,
      gfaToUfaEfficiencyPct: gfaToUfaEfficiencyPctOf(ufa, gfa),
      ufaToNlaEfficiencyPct: ufaToNlaEfficiencyPctOf(nla, ufa),
    },
    totals: { totalUnits: allUnits.length, placedUnits, unplacedUnits, occupiedUnits },
    unitGroups,
    basis_notes: [
      'Facility rollup sums the per-floor LIVE reports (getFloorMetrics) — snapshot payloads are not summed; snapshots remain per-floor history. Re-run per floor after canvas edits to refresh.',
      gfaSource === 'USER'
        ? 'Every contributing plan carries an operator-entered GFA (all gfaSource USER).'
        : gfaSource === 'CANVAS'
          ? 'GFA falls back to the canvas-derived rect on every contributing plan (all gfaSource CANVAS) — enter a GFA per plan to override.'
          : 'GFA basis is mixed across floors (see gfaSourcesByFloor): USER where the operator entered a GFA, CANVAS rect fallback elsewhere.',
      'Facility NLA is clamped ≤ UFA and both efficiencies are zero-division guarded (0 when the denominator is 0).',
      ...(floorsWithoutPlan.length > 0
        ? [
            `${floorsWithoutPlan.length} floor(s) have no plan and contribute zero geometry (${floorsWithoutPlan.join(', ')}); their DB units still count in totals/unitGroups.`,
          ]
        : []),
      'Occupied = Unit.status OCCUPIED + OVERDUE (RESERVED excluded, per the revenue convention); reads filter deletedAt null.',
      'unitGroups areas are nominal Unit.sqft sums (overall = sum of all buckets); XL (Extra Large) is 0/0 — no such UnitSize code exists in the DB (see unitGroups.notes).',
    ],
  };
}

// ---------- snapshots (append-only; no update route exists by design) ----------

export interface MetricsSnapshotSummary {
  id: string;
  floorId: string;
  branchId: string;
  effectiveDate: string;
  schemaVersion: number;
  geometryHash: string;
  createdAt: string;
}

function serializeSnapshot(row: {
  id: string;
  floorId: string;
  branchId: string;
  effectiveDate: Date;
  schemaVersion: number;
  geometryHash: string;
  createdAt: Date;
}): MetricsSnapshotSummary {
  return {
    id: row.id,
    floorId: row.floorId,
    branchId: row.branchId,
    effectiveDate: row.effectiveDate.toISOString().slice(0, 10),
    schemaVersion: row.schemaVersion,
    geometryHash: row.geometryHash,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Persist an append-only snapshot of the live metrics. Validation ERRORs
 * block publication (422 + validation array) — invalid geometry is never
 * persisted. Same (floor, date) twice creates two rows: history, not state.
 */
export async function createMetricsSnapshot(floorId: string, effectiveDate: string): Promise<MetricsSnapshotSummary> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || Number.isNaN(Date.parse(`${effectiveDate}T00:00:00Z`))) {
    throw new AppError(400, 'VALIDATION', `effective_date must be a valid YYYY-MM-DD date, got ${JSON.stringify(effectiveDate)}`);
  }
  const report = await getFloorMetrics(floorId);
  const errors = report.validation.filter((v) => v.severity === 'error');
  if (errors.length > 0) {
    throw new AppError(422, 'METRICS_INVALID', `Floor ${floorId} metrics have ${errors.length} blocking validation error(s) — snapshot not persisted`, {
      validation: errors,
    });
  }
  const created = await prisma.floorplanMetricsSnapshot.create({
    data: {
      floorId: report.floor.id,
      branchId: report.facility.id,
      effectiveDate: new Date(`${effectiveDate}T00:00:00Z`),
      schemaVersion: METRICS_SCHEMA_VERSION,
      geometryHash: report.geometry_hash,
      payload: report as unknown as Prisma.InputJsonValue,
    },
  });
  return serializeSnapshot(created);
}

/** Snapshot history for a floor (newest effective date first), payloads included. */
export async function listMetricsSnapshots(floorId: string): Promise<Array<MetricsSnapshotSummary & { payload: unknown }>> {
  const floor = await prisma.floor.findUnique({ where: { id: floorId }, select: { id: true } });
  if (!floor) throw new AppError(404, 'NOT_FOUND', `Floor ${floorId} not found`);
  const rows = await prisma.floorplanMetricsSnapshot.findMany({
    where: { floorId },
    orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
  });
  return rows.map((r) => ({ ...serializeSnapshot(r), payload: r.payload }));
}

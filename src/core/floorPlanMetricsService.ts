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
import { doorEdgesToArray } from './floorPlans';
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
    exteriorWall: { q: string; sqft: number };
    ufa: { q: string; sqft: number };
    nlaEnclosed: { q: string; sqft: number };
    nlaOutdoor: { q: string; sqft: number };
    nlaTotal: { q: string; sqft: number };
    common: { q: string; sqft: number };
    glaExclusive: { area: { q: string; sqft: number }; convention: string };
    glaInclusive: { area: { q: string; sqft: number }; convention: string };
    efficiency: number;
    loadFactor: number;
    derivedCirculation: { q: string; sqft: number };
    droppedSlivers: { q: string; sqft: number };
    balanced: boolean;
  };
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
        where: { unit: { deletedAt: null } },
        include: { unit: { include: { size: true } } },
        orderBy: { createdAt: 'asc' },
      },
      blocks: { orderBy: { createdAt: 'asc' } },
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
      climateControlled: isClimateControlled(p.unit.climateControl),
      billableQ: core ? core.billable.q : 0n,
      clearQ: core ? core.clear.q : 0n,
    };
  });

  const nlaQ = m.nlaTotal.q;
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
    m.gfa.q,
    m.efficiency,
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
    where: { floorId, deletedAt: null, placement: { is: null } },
    select: { unitCode: true },
    orderBy: { unitCode: 'asc' },
  });
  const statusBreakdown: Record<string, number> = {};
  for (const u of perUnit) statusBreakdown[u.p.unit.status] = (statusBreakdown[u.p.unit.status] ?? 0) + 1;

  const marketFallbacks = perUnit.filter((u) => u.marketRateSource === 'ACTUAL_FALLBACK').length;

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
        unitDoors.authoredUnits > 0
          ? `${unitDoors.authoredUnits} unit(s) use editor-authored door edges (N/S/E/W toggles); the rest fall back to every edge as a door, and the entrance is seeded at the largest derived circulation component (two-pass compute). Units with no abutting circulation report DOOR_BLOCKED.`
          : 'No unit has authored door edges yet: every unit edge is treated as a door and the entrance is seeded at the largest derived circulation component (two-pass compute). Units with no abutting circulation report DOOR_BLOCKED.',
        'Circulation-kind blocks (Corridor/aisle/lift/lobby/loading) are traversable: a spanning Corridor joins derived circulation instead of splitting it (region-to-circulation connectivity).',
        'Block region kinds are name-heuristic mappings (kind_source heuristic on decoration; placements are exact).',
        'Legacy structure JSON decorations are not measured; rect markers already live as blocks.',
        `Climate-controlled share uses the Unit.climateControl string heuristic ('Ambient climate' counts as ambient).`,
        `Clear heights are not stored: every unit uses the default ${DEFAULT_CLEAR_HEIGHT_FT} ft ceiling; no per-unit overrides exist yet.`,
        ...(marketFallbacks > 0
          ? [`${marketFallbacks} unit(s) have no MARKET_PSF entry for their size and fall back to actual rent in GPI.`]
          : []),
        ...(unplacedUnits.length > 0
          ? [`${unplacedUnits.length} floor unit(s) have no placement and are excluded from measured areas (see coverage.unplacedCodes).`]
          : []),
      ],
    },
    geometry: {
      gfa: areaJson(m.gfa),
      exteriorWall: areaJson(m.exteriorWall),
      ufa: areaJson(m.ufa),
      nlaEnclosed: areaJson(m.nlaEnclosed),
      nlaOutdoor: areaJson(m.nlaOutdoor),
      nlaTotal: areaJson(m.nlaTotal),
      common: areaJson(m.common),
      glaExclusive: { area: areaJson(m.glaExclusive.area), convention: m.glaExclusive.convention },
      glaInclusive: { area: areaJson(m.glaInclusive.area), convention: m.glaInclusive.convention },
      efficiency: round4(m.efficiency),
      loadFactor: round4(m.loadFactor),
      derivedCirculation: areaJson(m.derivedCirculation),
      droppedSlivers: areaJson(m.droppedSlivers),
      balanced: m.identity.balanced,
    },
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

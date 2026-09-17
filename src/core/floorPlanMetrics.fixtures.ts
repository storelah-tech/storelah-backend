// StoreLah — Golden fixtures for src/core/floorPlanMetrics.ts (Phase 1).
//
// Runnable tests with exact expected values (BigInt Q compared by integer
// equality; ratios by tight float tolerance at the display boundary).
// Run: pnpm metrics:fixtures   (tsx src/core/floorPlanMetrics.fixtures.ts)
//
// Every floor fixture asserts:
//   regions + derived circulation + slivers == interior EXACTLY (integer Q),
//   dropped slivers == 0, NLA_enclosed <= UFA <= GFA, and exact aggregates.
//
// Hand-derived expected values (1 sqft = 37,161,216 Q; wall band uses
// exterior 0.667 ft -> 2033 base units; partition 0.0208 ft -> 63 base):
//   grid16:   GFA 10000, NLA 1600, wall band 400ft*2033 = 9,914,534,400 Q,
//             UFA = 371,612,160,000 - 9,914,534,400 = 361,697,625,600 Q,
//             circ 8400 -> 312,154,214,400 Q, eff 0.16, load 6.25.
//   lShape:   GFA 3300 -> 122,632,012,800 Q; perimeter 260 ft,
//             wall 6,444,447,360 Q; restroom 25 -> 929,030,400 Q;
//             UFA = 115,258,535,040 Q; NLA 400 -> 14,864,486,400 Q;
//             circ 2875 -> 106,838,496,000 Q; load 8.1875.
//   courtyard:GFA 3200 -> 118,915,891,200 Q; perimeter 320 ft (hole incl.),
//             wall 7,931,627,520 Q; UFA = 110,984,263,680 Q;
//             NLA 421 (3x100 + 1x121 nominal) -> 15,644,871,936 Q;
//             circ 2800 -> 104,051,404,800 Q.
//   outdoorRV:GFA 1600 -> 59,457,945,600 Q; wall 3,965,813,760 Q;
//             UFA = 55,492,131,840 Q; NLA_encl 200, NLA_out 1200;
//             circ 1250 -> 46,451,520,000 Q; COMMON 1400; eff 0.125; load 2.0.
//   storey1:  GFA 2500 -> 92,903,040,000 Q; wall 4,957,267,200 Q;
//             deduct lift/rest/plant 200 -> UFA = 80,513,529,600 Q;
//             NLA 400; circ 1900 -> 70,606,310,400 Q.
//   storey2:  deduct lift 100 -> UFA = 84,229,651,200 Q;
//             NLA 600; circ 1800 -> 66,890,188,800 Q.
//   lockers:  GFA 600 -> 22,296,729,600 Q; wall 2,478,633,600 Q;
//             UFA = 19,818,096,000 Q; NLA 300 -> 11,148,364,800 Q;
//             circ 400 -> 14,864,486,400 Q.

import { AppError } from '../lib/http';
import {
  computeFloorMetrics,
  computeUnitAreas,
  areaQToSqft,
  type FloorMetrics,
  type FloorMetricsInput,
  type RegionInput,
  type ValidationCode,
  type ValidationSeverity,
} from './floorPlanMetrics';

// ---------- tiny assertion harness (no test framework in this repo) ----------

let failures = 0;

function check(cond: boolean, msg: string, extra?: unknown): void {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${msg}`, extra ?? '');
  }
}

function eqQ(actual: bigint, expected: bigint, msg: string): void {
  check(actual === expected, `${msg}: expected Q ${expected}, got ${actual}`);
}

function approx(actual: number, expected: number, tol: number, msg: string): void {
  check(Math.abs(actual - expected) <= tol, `${msg}: expected ~${expected}, got ${actual}`);
}

function hasCode(m: FloorMetrics, code: ValidationCode, severity?: ValidationSeverity): boolean {
  return m.validations.some((v) => v.code === code && (severity === undefined || v.severity === severity));
}

function noErrors(m: FloorMetrics, name: string): void {
  const errs = m.validations.filter((v) => v.severity === 'error');
  check(errs.length === 0, `${name}: expected zero error validations`, errs);
}

function checkFloorInvariants(m: FloorMetrics, name: string): void {
  check(m.identity.balanced, `${name}: tessellation identity unbalanced`, m.identity);
  eqQ(m.identity.sliverQ, 0n, `${name}: dropped slivers`);
  check(
    m.nlaEnclosed.q <= m.ufa.q && m.ufa.q <= m.gfa.q,
    `${name}: expected NLA_enclosed <= UFA <= GFA`,
    { nla: m.nlaEnclosed.q, ufa: m.ufa.q, gfa: m.gfa.q },
  );
  const unreachable = m.reachability.filter((r) => !r.reachable);
  check(unreachable.length === 0, `${name}: all leasable units reachable`, unreachable);
}

function unit(
  id: string,
  label: string,
  kind: RegionInput['kind'],
  x: number,
  y: number,
  w = 10,
  d = 10,
  extra?: Partial<RegionInput>,
): RegionInput {
  return { id, label, kind, xFeet: x, yFeet: y, wFeet: w, dFeet: d, ...extra };
}

// ---------- fixture 1: 100x100, sixteen 10x10 units + 5 ft aisles ----------

function fixtureGrid16(): FloorMetrics {
  const regions: RegionInput[] = [];
  const doors: { regionId: string; edge: 'N' | 'S' | 'E' | 'W' }[] = [];
  const grid = [10, 25, 40, 55];
  grid.forEach((x, c) =>
    grid.forEach((y, r) => {
      const id = `u-${r}-${c}`;
      regions.push(unit(id, `U-R${r}C${c}`, 'UNIT_STORAGE', x, y));
      doors.push({ regionId: id, edge: c < 3 ? 'E' : 'W' });
    }),
  );
  const input: FloorMetricsInput = {
    outlineFeet: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    regions,
    doors,
    entrances: [
      { x: 2, y: 52 },
      { x: 52, y: 2 },
    ],
  };
  const m = computeFloorMetrics(input);
  checkFloorInvariants(m, 'grid16');
  noErrors(m, 'grid16');
  eqQ(m.gfa.q, 371612160000n, 'grid16 GFA');
  eqQ(m.exteriorWall.q, 9914534400n, 'grid16 exterior wall band');
  eqQ(m.ufa.q, 361697625600n, 'grid16 UFA');
  eqQ(m.nlaEnclosed.q, 59457945600n, 'grid16 NLA_enclosed');
  eqQ(m.nlaOutdoor.q, 0n, 'grid16 NLA_outdoor');
  eqQ(m.derivedCirculation.q, 312154214400n, 'grid16 derived circulation');
  approx(m.efficiency, 0.16, 1e-12, 'grid16 efficiency');
  approx(m.loadFactor, 6.25, 1e-12, 'grid16 load factor');
  check(m.units.length === 16, 'grid16: 16 unit areas');
  return m;
}

// ---------- fixture 2: L-shaped outline ----------

function fixtureLShape(): FloorMetrics {
  const input: FloorMetricsInput = {
    outlineFeet: [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 40 },
      { x: 30, y: 40 },
      { x: 30, y: 70 },
      { x: 0, y: 70 },
    ],
    regions: [
      unit('u1', 'U1', 'UNIT_STORAGE', 5, 5),
      unit('u2', 'U2', 'UNIT_STORAGE', 20, 5),
      unit('off1', 'OFF1', 'OFFICE_RETAIL', 5, 20, 10, 20),
      unit('rest1', 'WC1', 'RESTROOM', 40, 5, 5, 5),
    ],
    doors: [
      { regionId: 'u1', edge: 'E' },
      { regionId: 'u2', edge: 'E' },
      { regionId: 'off1', edge: 'E' },
    ],
    entrances: [{ x: 45, y: 30 }],
  };
  const m = computeFloorMetrics(input);
  checkFloorInvariants(m, 'lShape');
  noErrors(m, 'lShape');
  check(!hasCode(m, 'NON_RECTANGULAR'), 'lShape: rectilinear L fires no NON_RECTANGULAR');
  eqQ(m.gfa.q, 122632012800n, 'lShape GFA');
  eqQ(m.ufa.q, 115258535040n, 'lShape UFA');
  eqQ(m.nlaEnclosed.q, 14864486400n, 'lShape NLA_enclosed');
  eqQ(m.derivedCirculation.q, 106838496000n, 'lShape derived circulation');
  approx(m.efficiency, 400 / 3300, 1e-12, 'lShape efficiency');
  approx(m.loadFactor, 8.1875, 1e-12, 'lShape load factor');
  return m;
}

// ---------- fixture 3: courtyard hole + nominal-variance unit ----------

function fixtureCourtyard(): FloorMetrics {
  const input: FloorMetricsInput = {
    outlineFeet: [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
      { x: 0, y: 60 },
    ],
    holesFeet: [
      [
        { x: 20, y: 20 },
        { x: 40, y: 20 },
        { x: 40, y: 40 },
        { x: 20, y: 40 },
      ],
    ],
    regions: [
      unit('a', 'A', 'UNIT_STORAGE', 5, 5),
      unit('b', 'B', 'UNIT_STORAGE', 45, 5),
      unit('c', 'C', 'UNIT_STORAGE', 5, 45),
      unit('d', 'D', 'UNIT_STORAGE', 45, 45, 10, 10, {
        advertisedWFeet: 11,
        advertisedDFeet: 11,
        pricingBasis: 'NOMINAL',
      }),
    ],
    doors: [
      { regionId: 'a', edge: 'E' },
      { regionId: 'b', edge: 'W' },
      { regionId: 'c', edge: 'E' },
      { regionId: 'd', edge: 'W' },
    ],
    entrances: [{ x: 30, y: 2 }],
  };
  const m = computeFloorMetrics(input);
  checkFloorInvariants(m, 'courtyard');
  noErrors(m, 'courtyard');
  eqQ(m.gfa.q, 118915891200n, 'courtyard GFA (hole subtracted)');
  eqQ(m.ufa.q, 110984263680n, 'courtyard UFA');
  eqQ(m.nlaEnclosed.q, 15644871936n, 'courtyard NLA_enclosed (3x100 + 1x121)');
  eqQ(m.derivedCirculation.q, 104051404800n, 'courtyard derived circulation');
  check(hasCode(m, 'NOMINAL_VARIANCE', 'warn'), 'courtyard: NOMINAL_VARIANCE warn for unit D');
  const du = m.units.find((u) => u.regionId === 'd');
  check(du !== undefined && du.nominalVarianceWarn, 'courtyard: unit D variance flag set');
  approx(m.efficiency, 421 / 3200, 1e-12, 'courtyard efficiency');
  return m;
}

// ---------- fixture 4: outdoor RV bays (efficiency <= 1.0) ----------

function fixtureOutdoorRV(): FloorMetrics {
  const input: FloorMetricsInput = {
    outlineFeet: [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 40 },
    ],
    regions: [
      unit('u1', 'U1', 'UNIT_STORAGE', 5, 5),
      unit('u2', 'U2', 'UNIT_STORAGE', 25, 5),
      { id: 'aisle', label: 'AISLE', kind: 'CIRCULATION_AISLE', xFeet: 5, yFeet: 20, wFeet: 30, dFeet: 5 },
      unit('rv1', 'RV1', 'UNIT_OUTDOOR', 50, 5, 10, 30),
      unit('rv2', 'RV2', 'UNIT_OUTDOOR', 60, 5, 10, 30),
      unit('rv3', 'RV3', 'UNIT_OUTDOOR', 70, 5, 10, 30),
      unit('rv4', 'RV4', 'UNIT_OUTDOOR', 80, 5, 10, 30),
    ],
    doors: [
      { regionId: 'u1', edge: 'E' },
      { regionId: 'u2', edge: 'W' },
    ],
    entrances: [{ x: 20, y: 30 }],
  };
  const m = computeFloorMetrics(input);
  checkFloorInvariants(m, 'outdoorRV');
  noErrors(m, 'outdoorRV');
  eqQ(m.gfa.q, 59457945600n, 'outdoorRV GFA (outdoor excluded)');
  eqQ(m.ufa.q, 55492131840n, 'outdoorRV UFA');
  eqQ(m.nlaEnclosed.q, 7432243200n, 'outdoorRV NLA_enclosed');
  eqQ(m.nlaOutdoor.q, 44593459200n, 'outdoorRV NLA_outdoor');
  eqQ(m.nlaTotal.q, 52025702400n, 'outdoorRV NLA_total');
  eqQ(m.derivedCirculation.q, 46451520000n, 'outdoorRV derived circulation');
  approx(m.efficiency, 0.125, 1e-12, 'outdoorRV efficiency');
  check(m.efficiency <= 1.0, 'outdoorRV: efficiency <= 1.0');
  approx(m.loadFactor, 2.0, 1e-12, 'outdoorRV load factor');
  check(m.glaExclusive.convention === 'exclusive', 'outdoorRV: GLA exclusive tagged');
  check(m.glaInclusive.convention === 'inclusive', 'outdoorRV: GLA inclusive tagged');
  eqQ(m.glaExclusive.area.q, m.nlaTotal.q, 'outdoorRV: GLA_exclusive == NLA');
  return m;
}

// ---------- fixture 5: two storeys sharing a lift core ----------

function storeyInput(level: 1 | 2): FloorMetricsInput {
  const outline = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 50, y: 50 },
    { x: 0, y: 50 },
  ];
  const lift: RegionInput = { id: 'lift', label: 'LIFT', kind: 'CIRCULATION_VERTICAL', xFeet: 20, yFeet: 20, wFeet: 10, dFeet: 10 };
  const baseUnits: RegionInput[] = [
    unit('u1', 'U1', 'UNIT_STORAGE', 5, 5),
    unit('u2', 'U2', 'UNIT_STORAGE', 35, 5),
    unit('u3', 'U3', 'UNIT_STORAGE', 5, 35),
    unit('u4', 'U4', 'UNIT_STORAGE', 35, 35),
  ];
  const doors = [
    { regionId: 'u1', edge: 'E' as const },
    { regionId: 'u2', edge: 'W' as const },
    { regionId: 'u3', edge: 'E' as const },
    { regionId: 'u4', edge: 'W' as const },
  ];
  const entrances = [
    { x: 10, y: 17 },
    { x: 40, y: 17 },
  ];
  if (level === 1) {
    return {
      outlineFeet: outline,
      regions: [
        ...baseUnits,
        lift,
        { id: 'wc', label: 'WC', kind: 'RESTROOM', xFeet: 20, yFeet: 5, wFeet: 5, dFeet: 10 },
        { id: 'plant', label: 'PLANT', kind: 'PLANT_MECHANICAL', xFeet: 25, yFeet: 5, wFeet: 5, dFeet: 10 },
      ],
      doors,
      entrances,
    };
  }
  return {
    outlineFeet: outline,
    regions: [...baseUnits, lift, unit('u5', 'U5', 'UNIT_STORAGE', 5, 20), unit('u6', 'U6', 'UNIT_STORAGE', 35, 20)],
    doors: [...doors, { regionId: 'u5', edge: 'E' as const }, { regionId: 'u6', edge: 'W' as const }],
    entrances,
  };
}

function fixtureTwoStorey(): void {
  const m1 = computeFloorMetrics(storeyInput(1));
  const m2 = computeFloorMetrics(storeyInput(2));
  for (const [m, name] of [
    [m1, 'storey1'],
    [m2, 'storey2'],
  ] as Array<[FloorMetrics, string]>) {
    checkFloorInvariants(m, name);
    noErrors(m, name);
    eqQ(m.gfa.q, 92903040000n, `${name} GFA`);
  }
  eqQ(m1.ufa.q, 80513529600n, 'storey1 UFA (lift+wc+plant deducted)');
  eqQ(m2.ufa.q, 84229651200n, 'storey2 UFA (lift deducted)');
  check(m1.ufa.q < m2.ufa.q, 'twoStorey: serviced floor has lower UFA');
  eqQ(m1.nlaEnclosed.q, 14864486400n, 'storey1 NLA (4 units)');
  eqQ(m2.nlaEnclosed.q, 22296729600n, 'storey2 NLA (6 units)');
  eqQ(m1.derivedCirculation.q, 70606310400n, 'storey1 derived circulation');
  eqQ(m2.derivedCirculation.q, 66890188800n, 'storey2 derived circulation');
}

// ---------- fixture 6: stacked lockers (double-count NLA, single footprint) ----------

function fixtureStackedLockers(): FloorMetrics {
  const input: FloorMetricsInput = {
    outlineFeet: [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 20 },
      { x: 0, y: 20 },
    ],
    regions: [
      unit('l1', 'L1', 'LOCKER', 5, 5, 10, 10, { stackLevel: 0 }),
      unit('l2', 'L2', 'LOCKER', 5, 5, 10, 10, { stackLevel: 1 }),
      unit('u1', 'U1', 'UNIT_STORAGE', 18, 5),
    ],
    doors: [
      { regionId: 'l1', edge: 'E' },
      { regionId: 'u1', edge: 'W' },
    ],
    entrances: [{ x: 15, y: 2 }],
  };
  const m = computeFloorMetrics(input);
  checkFloorInvariants(m, 'lockers');
  noErrors(m, 'lockers');
  check(!hasCode(m, 'OVERLAP'), 'lockers: stacked pair fires no OVERLAP');
  eqQ(m.gfa.q, 22296729600n, 'lockers GFA');
  eqQ(m.ufa.q, 19818096000n, 'lockers UFA');
  eqQ(m.nlaEnclosed.q, 11148364800n, 'lockers NLA_enclosed (stacked level counts twice)');
  eqQ(m.derivedCirculation.q, 14864486400n, 'lockers derived circulation (footprint covered once)');
  const l2 = m.reachability.find((r) => r.regionId === 'l2');
  check(l2 !== undefined && l2.reachable, 'lockers: stacked locker inherits reachability');
  return m;
}

// ---------- fixture 7: corridor-split floor (Phase 3: region-to-circulation connectivity) ----------

function fixtureCorridorSplit(): void {
  // Mirrors the seeded floors (40x30 canvas, full-width Corridor block at
  // y13-15 splitting derived circulation north/south, 2x3 units both sides).
  // Circulation-kind regions are traversable, so the Corridor JOINS the two
  // derived sides: every unit is reachable and the floor is publishable
  // (zero error validations — the snapshot service persists iff no ERRORs).
  // N3's ONLY door faces the Corridor block directly (region-to-circulation).
  const allEdges = [
    { edge: 'N' as const },
    { edge: 'S' as const },
    { edge: 'E' as const },
    { edge: 'W' as const },
  ];
  const input: FloorMetricsInput = {
    outlineFeet: [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 30 },
      { x: 0, y: 30 },
    ],
    regions: [
      unit('n1', 'N1', 'UNIT_STORAGE', 1, 5, 2, 3),
      unit('n2', 'N2', 'UNIT_STORAGE', 5, 5, 2, 3),
      unit('n3', 'N3', 'UNIT_STORAGE', 1, 10, 2, 3), // y10-13: S edge abuts the Corridor
      { id: 'corr', label: 'Corridor', kind: 'CIRCULATION_AISLE', xFeet: 0, yFeet: 13, wFeet: 40, dFeet: 2 },
      unit('s1', 'S1', 'UNIT_STORAGE', 1, 16, 2, 3),
      unit('s2', 'S2', 'UNIT_STORAGE', 5, 16, 2, 3),
      unit('s3', 'S3', 'UNIT_STORAGE', 1, 24, 2, 3),
    ],
    doors: [
      ...['n1', 'n2', 's1', 's2', 's3'].flatMap((regionId) => allEdges.map((d) => ({ regionId, edge: d.edge }))),
      { regionId: 'n3', edge: 'S' }, // faces the Corridor block — open via region connectivity
    ],
    entrances: [{ x: 10, y: 2 }],
  };
  const m = computeFloorMetrics(input);
  checkFloorInvariants(m, 'corridorSplit');
  noErrors(m, 'corridorSplit');
  check(!hasCode(m, 'UNREACHABLE_UNIT', 'error'), 'corridorSplit: no UNREACHABLE_UNIT');
  check(!hasCode(m, 'DOOR_BLOCKED', 'error'), 'corridorSplit: no DOOR_BLOCKED');
  check(!hasCode(m, 'NO_DOOR', 'error'), 'corridorSplit: no NO_DOOR');
  const n3 = m.reachability.find((r) => r.regionId === 'n3');
  check(n3 !== undefined && n3.reachable, 'corridorSplit: door-onto-corridor unit N3 reachable');
  const s3 = m.reachability.find((r) => r.regionId === 's3');
  check(s3 !== undefined && s3.reachable, 'corridorSplit: far-side unit S3 reachable across the Corridor');
  // Genuine negatives still fire beside the fix: a doorless unit raises
  // NO_DOOR and a door opened into another unit raises DOOR_BLOCKED.
  const doorless = computeFloorMetrics({ ...input, doors: input.doors!.filter((d) => d.regionId !== 's3') });
  check(hasCode(doorless, 'NO_DOOR', 'error'), 'corridorSplit: doorless unit still raises NO_DOOR');
  const intoUnit = computeFloorMetrics({
    ...input,
    regions: input.regions.map((r) => (r.id === 'n2' ? { ...r, xFeet: 3 } : r)), // N2's W edge now faces N1's rect
    doors: [{ regionId: 'n2', edge: 'W' }],
    entrances: [{ x: 10, y: 2 }],
  });
  check(hasCode(intoUnit, 'DOOR_BLOCKED', 'error'), 'corridorSplit: door-into-unit still raises DOOR_BLOCKED');
}

function testUnitAreas(): void {
  // 10x10, all partition (63 base): cw2 = 60960-126 = 60834; Q = 60834^2.
  const p = computeUnitAreas('t1', 'T1', 'UNIT_STORAGE', { wFeet: 10, dFeet: 10 });
  eqQ(p.gross.q, 3716121600n, 'unit gross 10x10');
  eqQ(p.clear.q, 3700775556n, 'unit clear all-partition');
  check(!p.nominalVarianceWarn, 'unit: no variance warn when nominal == gross');

  // 10x10, N exterior (2033), S/E/W demising (1524):
  // cw2 = 60960-3048 = 57912; cd2 = 60960-2033-1524 = 57403.
  const e = computeUnitAreas('t2', 'T2', 'UNIT_STORAGE', {
    wFeet: 10,
    dFeet: 10,
    walls: { n: 'exterior', s: 'demising', e: 'demising', w: 'demising' },
    pricingBasis: 'CLEAR',
  });
  eqQ(e.clear.q, 3324322536n, 'unit clear exterior/demising');
  eqQ(e.billable.q, e.clear.q, 'unit: CLEAR basis bills clear');

  // 11x11 advertised vs 10x10 centreline: variance 21% -> warn.
  const v = computeUnitAreas('t3', 'T3', 'UNIT_STORAGE', { wFeet: 10, dFeet: 10, advertisedWFeet: 11, advertisedDFeet: 11 });
  eqQ(v.nominal.q, 4496507136n, 'unit nominal 11x11');
  approx(v.nominalVariancePct, 21, 1e-9, 'unit nominal variance pct');
  check(v.nominalVarianceWarn, 'unit: variance warn flag set');

  // Walls thicker than the unit -> UNIT_TOO_SMALL is raised.
  let raised: string | null = null;
  try {
    computeUnitAreas('t4', 'T4', 'UNIT_STORAGE', {
      wFeet: 0.5,
      dFeet: 10,
      walls: { e: 'exterior', w: 'exterior', n: 'none', s: 'none' },
    });
  } catch (err) {
    if (err instanceof AppError) raised = err.code;
  }
  check(raised === 'UNIT_TOO_SMALL', 'unit: UNIT_TOO_SMALL raised', raised);

  // Display conversion is boundary-only: 100 sqft round-trips through Q.
  approx(areaQToSqft(3716121600n), 100, 1e-9, 'unit: 100 sqft boundary conversion');
}

// ---------- validation basics: one focused input per code ----------

const SQUARE: FloorMetricsInput['outlineFeet'] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

function baseInput(): FloorMetricsInput {
  return {
    outlineFeet: SQUARE,
    regions: [unit('u1', 'U1', 'UNIT_STORAGE', 10, 10)],
    doors: [{ regionId: 'u1', edge: 'E' }],
    entrances: [{ x: 50, y: 50 }],
  };
}

function testValidations(): void {
  const overlap = computeFloorMetrics({
    ...baseInput(),
    regions: [unit('a', 'A', 'UNIT_STORAGE', 10, 10), unit('b', 'B', 'UNIT_STORAGE', 15, 15)],
    doors: [
      { regionId: 'a', edge: 'E' },
      { regionId: 'b', edge: 'E' },
    ],
  });
  check(hasCode(overlap, 'OVERLAP', 'error'), 'validation: OVERLAP');

  const degenerate = computeFloorMetrics({
    ...baseInput(),
    regions: [unit('z', 'Z', 'UNIT_STORAGE', 10, 10, 0, 10)],
    doors: [{ regionId: 'z', edge: 'E' }],
  });
  check(hasCode(degenerate, 'DEGENERATE', 'error'), 'validation: DEGENERATE');

  const offGrid = computeFloorMetrics({
    ...baseInput(),
    regions: [unit('g', 'G', 'UNIT_STORAGE', 1 / 24, 10)], // half-inch x -> 127 base, off the 254 grid
    doors: [{ regionId: 'g', edge: 'E' }],
  });
  check(hasCode(offGrid, 'OFF_GRID', 'warn'), 'validation: OFF_GRID');

  const oob = computeFloorMetrics({
    ...baseInput(),
    regions: [unit('o', 'O', 'UNIT_STORAGE', 95, 95)],
    doors: [{ regionId: 'o', edge: 'E' }],
  });
  check(hasCode(oob, 'OUT_OF_BOUNDS', 'error'), 'validation: OUT_OF_BOUNDS');

  const dup = computeFloorMetrics({
    ...baseInput(),
    regions: [unit('d1', 'SAME', 'UNIT_STORAGE', 10, 10), unit('d2', 'SAME', 'UNIT_STORAGE', 30, 30)],
    doors: [{ regionId: 'd1', edge: 'E' }],
  });
  check(hasCode(dup, 'DUPLICATE_LABEL', 'error'), 'validation: DUPLICATE_LABEL');

  const nonRect = computeFloorMetrics({
    outlineFeet: [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 0, y: 60 },
    ],
    regions: [unit('t', 'T', 'UNIT_STORAGE', 5, 5, 5, 5)],
    doors: [{ regionId: 't', edge: 'E' }],
    entrances: [{ x: 40, y: 5 }],
  });
  check(hasCode(nonRect, 'NON_RECTANGULAR', 'warn'), 'validation: NON_RECTANGULAR');

  const noDoor = computeFloorMetrics({ ...baseInput(), doors: [] });
  check(hasCode(noDoor, 'NO_DOOR', 'error'), 'validation: NO_DOOR');

  const blocked = computeFloorMetrics({
    ...baseInput(),
    regions: [unit('u1', 'U1', 'UNIT_STORAGE', 10, 10), unit('u2', 'U2', 'UNIT_STORAGE', 20, 10)],
    doors: [
      { regionId: 'u1', edge: 'E' }, // opens into U2's rect -> blocked
      { regionId: 'u2', edge: 'E' },
    ],
  });
  check(hasCode(blocked, 'DOOR_BLOCKED', 'error'), 'validation: DOOR_BLOCKED');

  // Divider splits circulation east/west; U2's door opens east of it.
  const unreachable = computeFloorMetrics({
    outlineFeet: [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 20 },
      { x: 0, y: 20 },
    ],
    regions: [
      unit('w1', 'W1', 'UNIT_STORAGE', 5, 5, 5, 5),
      { id: 'div', label: 'DIV', kind: 'OFFICE_RETAIL', xFeet: 14, yFeet: 0, wFeet: 2, dFeet: 20 },
      unit('e1', 'E1', 'UNIT_STORAGE', 20, 5, 5, 5),
    ],
    doors: [
      { regionId: 'w1', edge: 'W' },
      { regionId: 'div', edge: 'W' },
      { regionId: 'e1', edge: 'E' },
    ],
    entrances: [{ x: 2, y: 15 }],
  });
  check(hasCode(unreachable, 'UNREACHABLE_UNIT', 'error'), 'validation: UNREACHABLE_UNIT');

  // UNIT_TOO_SMALL at floor level becomes a record, not a throw.
  const tooSmall = computeFloorMetrics({
    ...baseInput(),
    regions: [
      unit('s1', 'S1', 'UNIT_STORAGE', 10, 10, 0.5, 10, {
        walls: { e: 'exterior', w: 'exterior', n: 'none', s: 'none' },
      }),
    ],
    doors: [{ regionId: 's1', edge: 'N' }],
  });
  check(hasCode(tooSmall, 'UNIT_TOO_SMALL', 'error'), 'validation: UNIT_TOO_SMALL record');
}

// ---------- runner ----------

export function runGoldenFixtures(): void {
  failures = 0;
  const m1 = fixtureGrid16();
  fixtureLShape();
  fixtureCourtyard();
  const m4 = fixtureOutdoorRV();
  fixtureTwoStorey();
  fixtureStackedLockers();
  fixtureCorridorSplit();
  testUnitAreas();
  testValidations();
  console.log(
    `[floorPlanMetrics] golden fixtures: GFA grid16=${m1.gfa.sqft} NLA=${m1.nlaEnclosed.sqft} ` +
      `eff=${m1.efficiency} load=${m1.loadFactor} | outdoorRV eff=${m4.efficiency} load=${m4.loadFactor} ` +
      `| failures=${failures}`,
  );
  if (failures > 0) throw new Error(`[floorPlanMetrics] ${failures} golden-fixture assertion(s) failed`);
}

if (require.main === module) {
  runGoldenFixtures();
}

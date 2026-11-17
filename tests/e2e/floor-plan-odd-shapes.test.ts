// Odd-shaped units (docs/FLOOR_PLAN_ODD_SHAPES_PLAN.md §10): geometry unit
// tests (validation, shoelace, overlap, server↔CMS parity) + e2e
// (PUT → bbox/sqft/areaDirty/publish, contracted 409, stacking 409, NLA with
// a column in the notch, public read shape, draft round-trip).
//
// Runs against the isolated `_test` database only (see test-db.ts); never
// touches dev or prod.

import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDb } from './fixtures';
import {
  normalizeOutline,
  outlineArea,
  outlineBBox,
  outlineOf,
  placementsOverlap,
  polygonIntersectionArea,
  polygonLabelPoint,
} from '../../src/core/planGeometry';
import * as cmsGeometry from '../../src/cms/admin/planGeometry.js';
import {
  createFloorPlanBoundary,
  createFloorPlanBlock,
  getFloorPlan,
  getPublicFloorPlan,
  setUnitPlacement,
  publishFloorPlanWithSync,
} from '../../src/core/floorPlans';
import { loadDraft, saveDraft } from '../../src/core/floorPlanDrafts';

// Client L example: full-width bottom is taller than the step at the top,
// top-left corner cut away — 10×10 with a 4×6 notch = 76 sqft.
const L_SHAPE: Array<[number, number]> = [
  [14, 10],
  [20, 10],
  [20, 20],
  [10, 20],
  [10, 16],
  [14, 16],
];

const ANGLED: Array<[number, number]> = [
  [30, 30],
  [40, 30],
  [40, 40],
  [30, 36],
];

async function expectAppError(p: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ status, code });
}

describe('outline geometry (pure)', () => {
  it('normalises a valid outline: quantise, clockwise, drop collinear/duplicates', () => {
    // Collinear midpoint (17,10) and a closing duplicate of the first vertex.
    const raw = [
      [14, 10],
      [17, 10],
      [20, 10],
      [20, 20],
      [10, 20],
      [10, 16],
      [14, 16],
      [14, 10],
    ];
    const out = normalizeOutline(raw);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(6);
    expect(out).toEqual(L_SHAPE);
  });

  it('rejects self-intersecting (bowtie), spike, too-small, and too-many-vertex outlines', () => {
    expect(() => normalizeOutline([[0, 0], [10, 10], [10, 0], [0, 10]])).toThrow(/simple polygon/);
    // Spike: out-and-back fold along the same wall.
    expect(() => normalizeOutline([[0, 0], [10, 0], [10, 10], [5, 10], [5, 0], [0, 0]])).toThrow();
    // Too small: 0.5×0.5 ft = 0.25 sqft < MIN.
    expect(() => normalizeOutline([[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]])).toThrow(/sq ft/);
    // Too many vertices: 25-gon.
    const many: Array<[number, number]> = [];
    for (let i = 0; i < 25; i++) many.push([10 + 5 * Math.cos((i / 25) * 2 * Math.PI), 10 + 5 * Math.sin((i / 25) * 2 * Math.PI)]);
    expect(() => normalizeOutline(many)).toThrow(/3–24/);
    // Short edge: 0.05 ft wall < snap step.
    expect(() => normalizeOutline([[0, 0], [10, 0], [10, 10], [9.95, 10]])).toThrow(/at least 0.1 ft/);
  });

  it('normalises a bbox-filling 4-vertex outline to NULL (rectangles are never outlines)', () => {
    expect(normalizeOutline([[2, 2], [7, 2], [7, 12], [2, 12]])).toBeNull();
    expect(normalizeOutline(null)).toBeNull();
    expect(normalizeOutline(undefined)).toBeNull();
  });

  it('shoelace areas: L = 76, angled quad = 80', () => {
    expect(outlineArea(L_SHAPE)).toBeCloseTo(76, 9);
    // (30,30)-(40,30)-(40,40)-(30,36): trapezoid 10 wide, heights 10+6 / 2 = 80.
    expect(outlineArea(ANGLED)).toBeCloseTo(80, 9);
    expect(outlineBBox(L_SHAPE)).toEqual({ x: 10, y: 10, width: 10, height: 10 });
  });

  it('overlap: notch neighbour NOT, edge-touch NOT, angled-flush NOT, 0.1ft intrusion IS', () => {
    const l = { x: 10, y: 10, width: 10, height: 10, outline: L_SHAPE };
    // Neighbour sitting in the L notch (x 10–14, y 10–16): bbox overlaps, polygons don't.
    const inNotch = { x: 10, y: 10, width: 4, height: 6 };
    expect(placementsOverlap(l, inNotch)).toBe(false);
    expect(placementsOverlap(inNotch, l)).toBe(false);
    // Edge-touching rect to the east: intersection area 0.
    expect(placementsOverlap(l, { x: 20, y: 10, width: 5, height: 10 })).toBe(false);
    // Angled wall pressed flush: triangle (20,12)-(24,12)-(20,16) against the
    // L's east wall x=20 touches but shares no area.
    const flush = { x: 20, y: 12, width: 4, height: 4, outline: [[20, 12], [24, 12], [20, 16]] as Array<[number, number]> };
    expect(placementsOverlap(l, flush)).toBe(false);
    // 0.1 ft intrusion into the L body: 0.1 ft × 2 ft = 0.2 sqft > 0.01.
    expect(placementsOverlap(l, { x: 19.9, y: 17, width: 5, height: 2 })).toBe(true);
  });

  it('server and CMS mirror agree on fixtures', () => {
    const cases: Array<Array<[number, number]>> = [
      L_SHAPE,
      ANGLED,
      [[0, 0], [10, 0], [10, 10], [0, 10]],
    ];
    for (const poly of cases) {
      expect((cmsGeometry as { outlineArea: typeof outlineArea }).outlineArea(poly)).toBeCloseTo(outlineArea(poly), 9);
      expect((cmsGeometry as { outlineBBox: typeof outlineBBox }).outlineBBox(poly)).toEqual(outlineBBox(poly));
    }
    const inter = (cmsGeometry as { polygonIntersectionArea: typeof polygonIntersectionArea }).polygonIntersectionArea;
    expect(inter(L_SHAPE, [[16, 8], [22, 8], [22, 16], [16, 16]])).toBeCloseTo(
      polygonIntersectionArea(L_SHAPE, [[16, 8], [22, 8], [22, 16], [16, 16]]),
      9,
    );
    // A rect fully inside the notch shares no area with the L.
    expect(inter(L_SHAPE, [[10, 10], [14, 10], [14, 16], [10, 16]])).toBeCloseTo(0, 9);
  });

  it('labelAt pole: L label sits in the body, rect label is the bbox centre', () => {
    const [lx, ly] = polygonLabelPoint(L_SHAPE);
    // Body is the full-width bottom (y 16–20) or the right bar; never the
    // notch (x 10–14, y 10–16).
    const inNotch = lx >= 10 && lx <= 14 && ly >= 10 && ly <= 16;
    expect(inNotch).toBe(false);
    expect(outlineOf('nope')).toBeNull();
  });
});

describe('odd-shaped placements (DB)', () => {
  let branchId: string;
  let floorId: string;
  let lockerSizeId: string;
  let smallSizeId: string;

  async function makeUnit(code: string, status: string, sqft: number, sizeId: string) {
    return prisma.unit.create({
      data: { branchId, floorId, sizeId, unitCode: code, sqft, monthlyRate: 100, status: status as 'AVAILABLE' },
    });
  }

  beforeEach(async () => {
    await resetDb();
    const locker = await prisma.unitSize.create({ data: { code: 'LOCKER', name: 'Locker', sqftFrom: 10, sqftTo: 19, sortOrder: 1 } });
    const small = await prisma.unitSize.create({ data: { code: 'SMALL', name: 'Small', sqftFrom: 20, sqftTo: 39, sortOrder: 2 } });
    await prisma.unitSize.create({ data: { code: 'MEDIUM', name: 'Medium', sqftFrom: 40, sqftTo: 69, sortOrder: 3 } });
    await prisma.unitSize.create({ data: { code: 'LARGE', name: 'Large', sqftFrom: 70, sqftTo: 99, sortOrder: 4 } });
    lockerSizeId = locker.id;
    smallSizeId = small.id;
    const branch = await prisma.branch.create({ data: { code: 'SS', name: 'Sembawang', address: 'Admirax', operatingHours: '9-9' } });
    branchId = branch.id;
    const floor = await prisma.floor.create({ data: { branchId, level: 1, name: 'Level 1' } });
    floorId = floor.id;
  });

  it('PUT outline → bbox derived, sqft = polygon area, areaDirty set; publish syncs sqft/size/rate and nulls L×W', async () => {
    const u = await makeUnit('SS-01-10', 'AVAILABLE', 50, smallSizeId);
    const p = await setUnitPlacement(floorId, u.id, { x: 0, y: 0, width: 1, height: 1, outline: L_SHAPE, doorEdges: ['e0'], doorOffsets: { e0: 0.5, w: 3 } as never });
    expect(p).toMatchObject({ x: 10, y: 10, width: 10, height: 10, areaDirty: true });
    expect(p.outline).toEqual(L_SHAPE);
    expect(p.labelAt).toBeDefined();
    // Shaped door form round-trips (CMS view keeps offsets).
    expect(p.doorEdges).toEqual(['e0']);
    expect(p.doorOffsets).toMatchObject({ e0: 0.5, w: 3 });
    const before = await prisma.unit.findUniqueOrThrow({ where: { id: u.id } });
    expect(before.sqft).toBe(50); // synced on publish, never on save
    const { plan } = await getFloorPlan(floorId);
    const row = plan!.placements.find((x: { unit: { id: string } }) => x.unit.id === u.id)!;
    expect(row).toMatchObject({ areaDirty: true, outline: L_SHAPE });
    const { sizeSync } = await publishFloorPlanWithSync(floorId, { actorName: 'E2E' });
    expect(sizeSync.changed.map((c) => c.unitCode)).toContain('SS-01-10');
    const after = await prisma.unit.findUniqueOrThrow({ where: { id: u.id }, include: { size: true } });
    expect(after.sqft).toBe(76);
    expect(after.size.code).toBe('LARGE');
    expect(after.monthlyRate.toNumber()).toBeGreaterThan(100);
    // D4: shaped units carry no L×W.
    expect(after.lengthFt).toBeNull();
    expect(after.widthFt).toBeNull();
  });

  it('bbox-filling outline normalises to a rectangle (outline omitted, byte-identical rect)', async () => {
    const u = await makeUnit('SS-01-11', 'AVAILABLE', 50, smallSizeId);
    const p = await setUnitPlacement(floorId, u.id, { x: 0, y: 0, width: 1, height: 1, outline: [[2, 2], [7, 2], [7, 12], [2, 12]] });
    expect(p).toMatchObject({ x: 2, y: 2, width: 5, height: 10, areaDirty: false });
    expect('outline' in p).toBe(false);
  });

  it('contracted unit outline change → 409 UNIT_CONTRACTED; in-tolerance reshape allowed', async () => {
    const u = await makeUnit('SS-01-12', 'OCCUPIED', 76, smallSizeId);
    const p = await setUnitPlacement(floorId, u.id, { x: 0, y: 0, width: 1, height: 1, outline: L_SHAPE });
    expect(p.areaDirty).toBe(false);
    // Same-area reshape (notch moved to the top-right, still 4×6 = 24 →
    // 76 sqft) is a move-class edit and stays allowed while contracted.
    await setUnitPlacement(floorId, u.id, { x: 0, y: 0, width: 1, height: 1, outline: [[10, 10], [16, 10], [16, 16], [20, 16], [20, 20], [10, 20]] });
    await expectAppError(
      setUnitPlacement(floorId, u.id, { x: 0, y: 0, width: 1, height: 1, outline: [[10, 10], [24, 10], [24, 20], [10, 20]] }),
      409,
      'UNIT_CONTRACTED',
    );
  });

  it('stacking a shaped unit → 409; outlining a stacked unit → 409', async () => {
    const a = await makeUnit('SS-01-20', 'AVAILABLE', 12, lockerSizeId);
    const b = await makeUnit('SS-01-21', 'AVAILABLE', 12, lockerSizeId);
    await setUnitPlacement(floorId, a.id, { x: 2, y: 2, width: 3, height: 4 });
    await setUnitPlacement(floorId, b.id, { x: 2, y: 2, width: 3, height: 4, stackTier: 1 });
    // Outlining the stacked ground tier is blocked.
    await expectAppError(
      setUnitPlacement(floorId, a.id, { x: 0, y: 0, width: 1, height: 1, outline: L_SHAPE }),
      409,
      'PLACEMENT_OVERLAP',
    );
    // Stacking a shaped unit is blocked.
    const c = await makeUnit('SS-01-22', 'AVAILABLE', 12, lockerSizeId);
    await expectAppError(
      setUnitPlacement(floorId, c.id, { x: 0, y: 0, width: 1, height: 1, outline: L_SHAPE, stackTier: 1 }),
      409,
      'PLACEMENT_OVERLAP',
    );
  });

  it('NLA: L-unit clipped to the loop; a column in the notch does not reduce NLA, one on the body does', async () => {
    const u = await makeUnit('SS-01-30', 'AVAILABLE', 76, smallSizeId);
    await setUnitPlacement(floorId, u.id, { x: 0, y: 0, width: 1, height: 1, outline: L_SHAPE });
    await createFloorPlanBoundary(floorId, { label: 'Shell', kind: 'BOUNDARY', points: [[0, 0], [70, 0], [70, 80], [0, 80]], closed: true });
    // Column 2×2 inside the notch (x 10–14, y 10–16): not on the footprint.
    await createFloorPlanBlock(floorId, { name: 'Column A', x: 10.5, y: 10.5, width: 2, height: 2 });
    const { plan } = await getFloorPlan(floorId);
    expect(plan!.boundaryMetrics.nla).toBeCloseTo(76, 0);
    // Column 2×2 on the body deducts 4.
    await createFloorPlanBlock(floorId, { name: 'Column B', x: 15, y: 17, width: 2, height: 2 });
    const again = await getFloorPlan(floorId);
    expect(again.plan!.boundaryMetrics.nla).toBeCloseTo(72, 0);
  });

  it('public read omits outline for rects, includes it for shapes; shaped doors use edge keys', async () => {
    const r = await makeUnit('SS-01-40', 'AVAILABLE', 50, smallSizeId);
    await setUnitPlacement(floorId, r.id, { x: 2, y: 2, width: 5, height: 10 });
    const s = await makeUnit('SS-01-41', 'AVAILABLE', 76, smallSizeId);
    await setUnitPlacement(floorId, s.id, { x: 0, y: 0, width: 1, height: 1, outline: L_SHAPE, doorEdges: ['e2'] });
    // Publish so the public read resolves (DRAFT-only floor reads plan: null).
    await publishFloorPlanWithSync(floorId, { actorName: 'E2E', confirmEmpty: false });
    const prev = process.env.PUBLIC_MAP_INCLUDE_SHAPED_UNITS;
    try {
      process.env.PUBLIC_MAP_INCLUDE_SHAPED_UNITS = 'true';
      const view = await getPublicFloorPlan('SS', 1);
      const rect = view.plan!.placements.find((p) => p.unit.unitCode === 'SS-01-40')!;
      const shaped = view.plan!.placements.find((p) => p.unit.unitCode === 'SS-01-41')!;
      expect('outline' in rect).toBe(false);
      expect('labelAt' in rect).toBe(false);
      expect(shaped.outline).toEqual(L_SHAPE);
      expect(shaped.labelAt).toHaveLength(2);
      expect(shaped.doorEdges).toEqual(['e2']);
      expect('doorOffsets' in shaped).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_MAP_INCLUDE_SHAPED_UNITS;
      else process.env.PUBLIC_MAP_INCLUDE_SHAPED_UNITS = prev;
    }
  });

  it('safety net hides shaped units from the public map by default', async () => {
    const s = await makeUnit('SS-01-42', 'AVAILABLE', 76, smallSizeId);
    await setUnitPlacement(floorId, s.id, { x: 0, y: 0, width: 1, height: 1, outline: L_SHAPE });
    await publishFloorPlanWithSync(floorId, { actorName: 'E2E' });
    delete process.env.PUBLIC_MAP_INCLUDE_SHAPED_UNITS;
    const view = await getPublicFloorPlan('SS', 1);
    expect(view.plan!.placements.find((p) => p.unit.unitCode === 'SS-01-42')).toBeUndefined();
  });

  it('draft save/restore round-trips the outline', async () => {
    const u = await makeUnit('SS-01-50', 'AVAILABLE', 76, smallSizeId);
    await setUnitPlacement(floorId, u.id, { x: 0, y: 0, width: 1, height: 1, outline: L_SHAPE });
    const saved = await saveDraft(floorId, {
      placements: [
        { unitId: u.id, x: 10, y: 10, width: 10, height: 10, outline: L_SHAPE, doorEdges: ['e0'], doorOffsets: { e0: 0.5 } },
      ],
    });
    const loaded = await loadDraft(saved.id);
    const row = loaded.plan.plan!.placements.find((p: { unit: { id: string } }) => p.unit.id === u.id)!;
    expect(row.outline).toEqual(L_SHAPE);
    expect(row.doorEdges).toEqual(['e0']);
  });
});

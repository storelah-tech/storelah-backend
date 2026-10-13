// Floor-plan precision Phase 1 (docs/FLOOR_PLAN_PRECISION_PLAN.md): geometry is
// decimal feet quantized to 0.001 ft, compared in integer milli-feet. Covers the
// pure geometry module, every write path (placements, blocks, markers,
// boundaries, canvas, drafts), the metrics bridge, the public read, and that
// pre-existing integer-foot plans are untouched.

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, prisma, resetDb, seedMoveInWorld, type MoveInWorld } from './fixtures';
import {
  formatFt,
  quantizeFt,
  rectAreaSqft,
  rectFitsCanvas,
  rectsOverlapExact,
  toMilli,
} from '../../src/core/planGeometry';
import {
  createFloorPlanBlock,
  createFloorPlanBoundary,
  createFloorPlanMarker,
  updateFloorPlanBoundary,
  applyFloorPlanBatch,
  getFloorPlan,
  publishFloorPlan,
  setUnitPlacement,
  upsertFloorPlan,
} from '../../src/core/floorPlans';
import { publishDraft, saveDraft } from '../../src/core/floorPlanDrafts';
import { readFileSync } from 'node:fs';
import { ADMIN_GEOMETRY_OUT, renderAdminGeometry } from '../../scripts/build-admin-geometry';
import { sqftFootprint } from '../../src/core/floorPlans';
import { AREA_TOLERANCE, angleDeg, areaDeviation, lineFeedsArea, pointAtAngle, snapFt } from '../../src/core/planGeometry';
import { getFloorMetrics } from '../../src/core/floorPlanMetricsService';

async function unitId(unitCode: string): Promise<string> {
  const u = await prisma.unit.findUnique({ where: { unitCode } });
  return u!.id;
}

async function expectAppError(p: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ status, code });
}

describe('planGeometry (pure)', () => {
  it('quantizes to 0.001 ft and is idempotent', () => {
    expect(quantizeFt(4.73)).toBe(4.73);
    expect(quantizeFt(40.12345)).toBe(40.123);
    expect(quantizeFt(quantizeFt(7.0717))).toBe(7.072);
    expect(Object.is(quantizeFt(-0.0001), 0)).toBe(true);
    for (const v of [0.1, 1.1, 2.2, 3.3, 12.345, 499.999]) expect(toMilli(quantizeFt(v))).toBe(toMilli(v));
  });

  it('touching decimal edges never overlap (float math would say they do)', () => {
    const a = { x: 1.1, y: 0, width: 2.2, height: 1 };
    const b = { x: 3.3, y: 0, width: 1, height: 1 };
    expect(b.x < a.x + a.width).toBe(true); // the float trap: 3.3 < 3.3000000000000003
    expect(rectsOverlapExact(a, b)).toBe(false);
    expect(rectsOverlapExact(a, { ...b, x: 3.299 })).toBe(true);
    expect(rectFitsCanvas(a, { width: 3.3, height: 1 })).toBe(true);
    expect(rectFitsCanvas(a, { width: 3.299, height: 1 })).toBe(false);
  });

  it('computes exact areas and clean labels', () => {
    expect(rectAreaSqft({ width: 4.73, height: 6.34 })).toBe(29.9882);
    expect(formatFt(1.1 + 2.2)).toBe('3.3');
    expect(formatFt(30)).toBe('30');
  });
});

describe('precision Phase 2 shared rules (pure)', () => {
  it('the CMS editor bundle is generated from src/core/planGeometry.ts (no drift)', () => {
    expect(readFileSync(ADMIN_GEOMETRY_OUT, 'utf8')).toBe(renderAdminGeometry());
  });

  it('snaps to the operator step exactly', () => {
    expect(snapFt(4.7349, 0.1)).toBe(4.7);
    expect(snapFt(4.75, 0.1)).toBe(4.8);
    expect(snapFt(4.738, 0.01)).toBe(4.74);
    expect(snapFt(4.6, 0.25)).toBe(4.5);
  });

  it('decimal footprints match sqft within the 2% tolerance', () => {
    expect(AREA_TOLERANCE).toBe(0.02);
    expect(sqftFootprint(50, 'SMALL', 5, 10)).toEqual({ w: 5, h: 10 }); // catalogue dims already exact
    for (const [sqft, code, w, h] of [
      [37, 'LOCKER', null, null],
      [35, 'SMALL', 5, 6], // dims are 30 sqft → rescaled to 35 keeping 5:6
      [118, 'LARGE', 10, 12],
      [9.5, 'LOCKER', 3, 4],
    ] as const) {
      const fp = sqftFootprint(sqft, code, w, h);
      expect(areaDeviation({ width: fp.w, height: fp.h }, sqft)).toBeLessThanOrEqual(AREA_TOLERANCE);
    }
    const r = sqftFootprint(35, 'SMALL', 5, 6);
    expect(r.w / r.h).toBeCloseTo(5 / 6, 1);
  });
});

describe('precision Phase 3 line helpers (pure)', () => {
  it('uses CAD angles (0° east, 90° north) and inverts with pointAtAngle', () => {
    expect(angleDeg([0, 0], [10, 0])).toBe(0);
    expect(angleDeg([0, 10], [0, 0])).toBe(90); // up the screen = north
    expect(angleDeg([0, 0], [-5, 0])).toBe(180);
    expect(pointAtAngle([10, 10], 12.5, 90)).toEqual([10, -2.5]);
    expect(pointAtAngle([1, 1], 3, 0)).toEqual([4, 1]);
  });

  it('only boundary (and legacy pencil / unknown) lines mark area', () => {
    for (const k of ['BOUNDARY', 'PENCIL', 'boundary', null, 'CUSTOM']) expect(lineFeedsArea(k)).toBe(true);
    for (const k of ['WALL', 'PARTITION', 'GUIDE', 'guide']) expect(lineFeedsArea(k)).toBe(false);
  });
});

describe('floor-plan decimal geometry (DB)', () => {
  let world: MoveInWorld;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
  });

  it('integer-foot plans read back unchanged (migration is lossless)', async () => {
    const res = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/${PIN.level}`);
    // Seeded plan is DRAFT (schema default) → publish it so the public read resolves.
    if (res.body.data.plan === null) {
      await publishFloorPlan(world.floorId);
    }
    const pub = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/${PIN.level}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.plan.width).toBe(70);
    expect(pub.body.data.plan.height).toBe(80);
    const rects = pub.body.data.plan.placements.map((p: { x: number; y: number; width: number; height: number }) => [p.x, p.y, p.width, p.height]);
    expect(rects).toContainEqual([2, 2, 5, 10]);
    for (const [x, y, w, h] of rects) for (const v of [x, y, w, h]) expect(Number.isInteger(v)).toBe(true);
  });

  it('places a unit at decimal feet, quantized to 0.001 ft', async () => {
    const id = await unitId(PIN.rentableUnit);
    const p = await setUnitPlacement(world.floorId, id, { x: 40.12345, y: 30.25, width: 7.0711, height: 7.0711 });
    expect(p).toMatchObject({ x: 40.123, y: 30.25, width: 7.071, height: 7.071 });
    const row = await prisma.unitPlacement.findUnique({ where: { unitId: id } });
    expect(row).toMatchObject({ x: 40.123, y: 30.25, width: 7.071, height: 7.071 });
  });

  it('accepts neighbours whose decimal edges touch exactly, rejects a 0.001 ft overlap', async () => {
    const a = await unitId(PIN.rentableUnit);
    const b = await unitId(PIN.guestUnit);
    // 2.2 × 22.727 ≈ 49.999 sqft (unit sqft 50, inside tolerance).
    await setUnitPlacement(world.floorId, a, { x: 1.1, y: 30, width: 2.2, height: 22.727 });
    await expect(setUnitPlacement(world.floorId, b, { x: 3.3, y: 30, width: 2.2, height: 22.727 })).resolves.toMatchObject({ x: 3.3 });
    await expectAppError(setUnitPlacement(world.floorId, b, { x: 3.299, y: 30, width: 2.2, height: 22.727 }), 409, 'PLACEMENT_OVERLAP');
  });

  // Since the floor-plan unit sync (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md) the 2%
  // rule only binds CONTRACTED units (here: the OCCUPIED unit on a draft plan);
  // other units resize freely — see floor-plan-unit-sync.test.ts.
  it('still enforces area tolerance with decimal sides (contracted unit)', async () => {
    const id = await unitId(PIN.occupiedUnit);
    await expectAppError(setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 4.5, height: 8.5 }), 409, 'UNIT_CONTRACTED'); // 38.25 vs 50
  });

  it('2% tolerance applies to new/resized contracted placements; moves of legacy rects are grandfathered', async () => {
    const id = await unitId(PIN.occupiedUnit); // 50 sqft
    // Legacy row drawn under the old 15% band: 5 × 11 = 55 sqft (+10%).
    await prisma.unitPlacement.update({ where: { unitId: id }, data: { width: 5, height: 11 } });
    // Pure move (same area) → allowed.
    await expect(setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 5, height: 11 })).resolves.toMatchObject({ x: 40 });
    // 90° rotation (same area) → allowed.
    await expect(setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 11, height: 5 })).resolves.toMatchObject({ width: 11 });
    // Resize to 52.5 sqft (+5%) → rejected under the 2% band.
    await expectAppError(setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 5, height: 10.5 }), 409, 'UNIT_CONTRACTED');
    // Resize to 50.96 sqft (+1.9%) → allowed.
    await expect(setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 4.9, height: 10.4 })).resolves.toMatchObject({ width: 4.9 });
  });

  it('rejects a NEW contracted placement more than 2% off its sqft', async () => {
    const id = await unitId(PIN.occupiedUnit);
    await prisma.unitPlacement.delete({ where: { unitId: id } });
    await expectAppError(setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 5, height: 10.25 }), 409, 'UNIT_CONTRACTED'); // +2.5%
    await expect(setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 5, height: 10.05 })).resolves.toMatchObject({ height: 10.05 }); // +0.5%
  });

  it('rejects sides below 0.1 ft', async () => {
    await expectAppError(
      createFloorPlanBlock(world.floorId, { name: 'Pillar', x: 1, y: 1, width: 0.05, height: 1 }),
      400,
      'VALIDATION',
    );
  });

  it('fits a decimal canvas exactly at its edge', async () => {
    const plan = await upsertFloorPlan(world.planlessFloorId, { width: 3.3, height: 10.0004 });
    expect(plan).toMatchObject({ width: 3.3, height: 10 });
    await expect(
      createFloorPlanBlock(world.planlessFloorId, { name: 'Pillar', x: 1.1, y: 0.25, width: 2.2, height: 0.75 }),
    ).resolves.toMatchObject({ x: 1.1, width: 2.2 });
    await expectAppError(
      createFloorPlanBlock(world.planlessFloorId, { name: 'Too wide', x: 1.1, y: 2, width: 2.201, height: 1 }),
      400,
      'VALIDATION',
    );
  });

  it('stores decimal markers and boundaries; a decimal loop feeds boundaryMetrics', async () => {
    const m = await createFloorPlanMarker(world.floorId, { kind: 'FIRE_EXTINGUISHER', x: 12.3456, y: 0.5 });
    expect(m).toMatchObject({ x: 12.346, y: 0.5 });
    const b = await createFloorPlanBoundary(world.floorId, {
      points: [[0.5, 0.5], [10.5, 0.5], [10.5, 10.5], [0.5, 10.5]],
      closed: true,
    });
    expect(b.points).toEqual([[0.5, 0.5], [10.5, 0.5], [10.5, 10.5], [0.5, 10.5]]);
    const { plan } = await getFloorPlan(world.floorId);
    expect(plan!.boundaryMetrics.boundaryClosed).toBe(true);
    expect(plan!.boundaryMetrics.facilityAreaSqft).toBe(100);
  });

  it('line kinds: wall thickness, area rule and the public guide filter', async () => {
    const square = [[0.5, 0.5], [10.5, 0.5], [10.5, 10.5], [0.5, 10.5]];
    await createFloorPlanBoundary(world.floorId, { points: square, closed: true }); // BOUNDARY → 100 sqft
    const wall = await createFloorPlanBoundary(world.floorId, { kind: 'WALL', points: [[20, 0], [20, 30], [40, 30], [40, 0]], closed: true });
    expect(wall.thickness).toBe(0.5); // default
    const guide = await createFloorPlanBoundary(world.floorId, { kind: 'GUIDE', points: [[0, 50], [60, 50], [60, 70]], closed: false });
    expect(guide.thickness).toBeNull();
    await createFloorPlanBoundary(world.floorId, { kind: 'PARTITION', points: [[45, 0], [45, 20], [55, 20]], closed: false, thickness: 2 });

    const { plan } = await getFloorPlan(world.floorId);
    expect(plan!.boundaryMetrics.facilityAreaSqft).toBe(100); // walls/partitions/guides never mark area
    expect(plan!.boundaries.find((b) => b.kind === 'PARTITION')!.thickness).toBeNull(); // thickness only for walls

    const thick = await updateFloorPlanBoundary(world.floorId, wall.id, { thickness: 0.6667 });
    expect(thick.thickness).toBe(0.667);
    const asBoundary = await updateFloorPlanBoundary(world.floorId, wall.id, { kind: 'BOUNDARY' });
    expect(asBoundary.thickness).toBeNull();
    expect((await getFloorPlan(world.floorId)).plan!.boundaryMetrics.facilityAreaSqft).toBe(700); // 100 + 20×30
    await expectAppError(updateFloorPlanBoundary(world.floorId, wall.id, { kind: 'WALL', thickness: 20 }), 400, 'VALIDATION');

    await publishFloorPlan(world.floorId);
    const pub = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/${PIN.level}`);
    const kinds = pub.body.data.plan.boundaries.map((b: { kind: string }) => b.kind);
    expect(kinds).not.toContain('GUIDE');
    expect(kinds).toContain('PARTITION');
    expect((await getFloorPlan(world.floorId)).plan!.boundaries.some((b) => b.kind === 'GUIDE')).toBe(true); // CMS still sees it
  });

  it('batch: a whole row shifts into its neighbours\' old spots atomically', async () => {
    const rows = await prisma.unitPlacement.findMany({ where: { unit: { deletedAt: null } }, orderBy: { x: 'asc' } });
    expect(rows.length).toBeGreaterThanOrEqual(5);
    // Move every placed unit 8 ft right: each lands on the next unit's OLD rect
    // (the draft plan has no occupied lock). Sequential single writes would 409.
    const moved = rows.map((r) => ({ unitId: r.unitId, x: r.x + 8, y: r.y, width: r.width, height: r.height }));
    const res = await applyFloorPlanBatch(world.floorId, { upsert: { placements: moved } });
    for (const m of moved) expect(res.plan!.placements.find((p) => p.unit.id === m.unitId)).toMatchObject({ x: m.x });
  });

  it('batch: an overlap in the final layout rejects the WHOLE batch', async () => {
    const [a, b] = await prisma.unitPlacement.findMany({ where: { unit: { status: 'AVAILABLE', deletedAt: null } }, orderBy: { x: 'asc' } });
    const before = await prisma.unitPlacement.findMany({ orderBy: { unitId: 'asc' } });
    await expectAppError(
      applyFloorPlanBatch(world.floorId, {
        upsert: { placements: [{ unitId: a.unitId, x: 40, y: 40, width: a.width, height: a.height }, { unitId: b.unitId, x: 42, y: 41, width: b.width, height: b.height }] },
      }),
      409,
      'PLACEMENT_OVERLAP',
    );
    expect(await prisma.unitPlacement.findMany({ orderBy: { unitId: 'asc' } })).toEqual(before); // nothing applied
  });

  it('batch: delete then upsert-by-id restores the same block / marker / line ids', async () => {
    const res1 = await applyFloorPlanBatch(world.floorId, {
      upsert: {
        blocks: [{ id: 'blk-test-1', name: 'Pillar', x: 50.5, y: 60.25, width: 1.5, height: 1.5 }],
        markers: [{ id: 'mk-test-1', kind: 'EXIT_SIGN', x: 1.25, y: 79 }],
        boundaries: [{ id: 'bd-test-1', kind: 'WALL', points: [[0, 70], [20.5, 70]], thickness: 0.75 }],
      },
    });
    expect(res1.plan!.blocks.map((b) => b.id)).toContain('blk-test-1');
    await applyFloorPlanBatch(world.floorId, { delete: { blocks: ['blk-test-1'], markers: ['mk-test-1'], boundaries: ['bd-test-1'] } });
    expect(await prisma.floorPlanBlock.count({ where: { id: 'blk-test-1' } })).toBe(0);
    const res2 = await applyFloorPlanBatch(world.floorId, {
      upsert: {
        blocks: [{ id: 'blk-test-1', name: 'Pillar', x: 50.5, y: 60.25, width: 1.5, height: 1.5 }],
        markers: [{ id: 'mk-test-1', kind: 'EXIT_SIGN', x: 1.25, y: 79 }],
        boundaries: [{ id: 'bd-test-1', kind: 'WALL', points: [[0, 70], [20.5, 70]], thickness: 0.75 }],
      },
    });
    expect(res2.plan!.markers.find((m) => m.id === 'mk-test-1')).toMatchObject({ x: 1.25 });
    expect(res2.plan!.boundaries.find((b) => b.id === 'bd-test-1')).toMatchObject({ thickness: 0.75 });
  });

  it('batch: keeps the occupied lock on a live plan and the 2% rule for contracted resizes', async () => {
    await publishFloorPlan(world.floorId);
    const occ = await prisma.unitPlacement.findFirst({ where: { unit: { unitCode: PIN.occupiedUnit } } });
    await expectAppError(applyFloorPlanBatch(world.floorId, { upsert: { placements: [{ unitId: occ!.unitId, x: occ!.x, y: 40, width: occ!.width, height: occ!.height }] } }), 409, 'CONFLICT');
    const id = await unitId(PIN.rentableUnit);
    await prisma.unit.update({ where: { id }, data: { status: 'RESERVED' } }); // contracted, not live-locked
    await expectAppError(applyFloorPlanBatch(world.floorId, { upsert: { placements: [{ unitId: id, x: 40, y: 40, width: 5, height: 10.5 }] } }), 409, 'UNIT_CONTRACTED');
    const plan = await prisma.floorPlan.findUnique({ where: { floorId: world.floorId } });
    expect(plan!.status).toBe('ACTIVE'); // rejected batches never demote
  });

  it('drafts keep wall thickness through save + publish', async () => {
    const draft = await saveDraft(world.floorId, {
      boundaries: [{ kind: 'WALL', points: [[1, 1], [30.25, 1]], thickness: 0.75 }, { kind: 'WALL', points: [[1, 5], [9, 5]] }],
    });
    const { plan } = await publishDraft(draft.id);
    const t = plan.boundaries.map((b) => b.thickness);
    expect(t).toEqual([0.75, 0.5]);
  });

  it('round-trips decimal geometry through a draft save + publish', async () => {
    const id = await unitId(PIN.rentableUnit);
    const draft = await saveDraft(world.floorId, {
      width: 70.5,
      height: 80.25,
      placements: [{ unitId: id, x: 60.4, y: 70.1, width: 7.071, height: 7.071 }],
      blocks: [{ name: 'Corridor', x: 0, y: 60.5, width: 70.5, height: 4.75 }],
      boundaries: [{ points: [[0.25, 0.25], [70.25, 0.25], [70.25, 80]], closed: false }],
      markers: [{ kind: 'EXIT_SIGN', x: 70.5, y: 80.25 }],
    });
    expect(draft).toMatchObject({ width: 70.5, height: 80.25 });
    const { plan, skippedPlacements } = await publishDraft(draft.id);
    expect(skippedPlacements).toEqual([]);
    expect(plan).toMatchObject({ width: 70.5, height: 80.25 });
    expect(plan.placements[0]).toMatchObject({ x: 60.4, y: 70.1, width: 7.071, height: 7.071 });
    expect(plan.blocks[0]).toMatchObject({ y: 60.5, width: 70.5, height: 4.75 });
    expect(plan.markers[0]).toMatchObject({ x: 70.5, y: 80.25 });

    const pub = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/${PIN.level}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.plan.width).toBe(70.5);
    expect(pub.body.data.plan.placements[0]).toMatchObject({ x: 60.4, width: 7.071 });
  });

  it('metrics bridge accepts decimal rects (no NON_RECTANGULAR)', async () => {
    const id = await unitId(PIN.rentableUnit);
    await setUnitPlacement(world.floorId, id, { x: 40.5, y: 30.25, width: 7.071, height: 7.071 });
    await createFloorPlanBlock(world.floorId, { name: 'Corridor', x: 0, y: 40, width: 70, height: 3.5 });
    const report = await getFloorMetrics(world.floorId);
    expect(report).toBeTruthy();
  });
});

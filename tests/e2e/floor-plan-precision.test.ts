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
  getFloorPlan,
  publishFloorPlan,
  setUnitPlacement,
  upsertFloorPlan,
} from '../../src/core/floorPlans';
import { publishDraft, saveDraft } from '../../src/core/floorPlanDrafts';
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

  it('still enforces area tolerance with decimal sides', async () => {
    const id = await unitId(PIN.rentableUnit);
    await expectAppError(setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 4.5, height: 8.5 }), 400, 'VALIDATION'); // 38.25 vs 50
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

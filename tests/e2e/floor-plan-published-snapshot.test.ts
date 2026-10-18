// R-FP1 (owner decision 2026-10-18): a published floor plan stays visible to
// customers while it is being edited — the public read serves the last
// published snapshot until the plan is published again.

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, prisma, resetDb, seedMoveInWorld, type MoveInWorld } from './fixtures';
import {
  backfillPublishedSnapshots,
  deleteFloorPlan,
  getFloorPlan,
  publishFloorPlanWithSync,
  setUnitPlacement,
} from '../../src/core/floorPlans';

const publicPlan = async () => {
  const res = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/${PIN.level}`);
  expect(res.status).toBe(200);
  return res.body.data.plan as null | { status: string; placements: Array<{ x: number; y: number; unit: { unitCode: string; status: string } }> };
};
const placementOf = (plan: NonNullable<Awaited<ReturnType<typeof publicPlan>>>, code: string) =>
  plan.placements.find((p) => p.unit.unitCode === code);

describe('floor plan — published snapshot while editing (R-FP1)', () => {
  let world: MoveInWorld;
  let rentable: string;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
    rentable = (await prisma.unit.findUnique({ where: { unitCode: PIN.rentableUnit } }))!.id;
  });

  it('a never-published floor reads as plan: null', async () => {
    expect(await publicPlan()).toBeNull();
  });

  it('editing a published plan keeps serving the published version until re-publish', async () => {
    await publishFloorPlanWithSync(world.floorId, { actorName: 'E2E' });
    const before = (await publicPlan())!;
    const pos = placementOf(before, PIN.rentableUnit)!;

    // Move the unit (an edit) — the plan returns to DRAFT in the CMS…
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 50, width: 5, height: 10 });
    const cms = await getFloorPlan(world.floorId);
    expect(cms.plan!.status).toBe('DRAFT');
    expect(cms.plan!.publishedAt).toBeTruthy();

    // …but customers still see the published geometry, not null.
    const during = (await publicPlan())!;
    expect(during).not.toBeNull();
    expect(during.status).toBe('ACTIVE');
    expect(placementOf(during, PIN.rentableUnit)).toMatchObject({ x: pos.x, y: pos.y });

    // Publishing again shows the edit.
    await publishFloorPlanWithSync(world.floorId, { actorName: 'E2E' });
    expect(placementOf((await publicPlan())!, PIN.rentableUnit)).toMatchObject({ x: 40, y: 50 });
  });

  it('the snapshot reflects live unit status and drops deactivated / deleted units', async () => {
    await publishFloorPlanWithSync(world.floorId, { actorName: 'E2E' });
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 50, width: 5, height: 10 }); // now DRAFT
    const guest = await prisma.unit.findUnique({ where: { unitCode: PIN.guestUnit } });
    await prisma.unit.update({ where: { id: rentable }, data: { status: 'RESERVED' } });
    await prisma.unit.update({ where: { id: guest!.id }, data: { status: 'INACTIVE' } });
    const blocked = await prisma.unit.findUnique({ where: { unitCode: PIN.blockedUnit } });
    await prisma.unit.update({ where: { id: blocked!.id }, data: { deletedAt: new Date() } });

    const plan = (await publicPlan())!;
    expect(placementOf(plan, PIN.rentableUnit)!.unit.status).toBe('RESERVED');
    expect(placementOf(plan, PIN.guestUnit)).toBeUndefined();
    expect(placementOf(plan, PIN.blockedUnit)).toBeUndefined();
  });

  it('legacy ACTIVE plans without a snapshot are captured (backfill + lazy read)', async () => {
    await prisma.floorPlan.update({ where: { floorId: world.floorId }, data: { status: 'ACTIVE' } });
    expect(await backfillPublishedSnapshots()).toEqual([world.floorId]);
    expect(await backfillPublishedSnapshots()).toEqual([]); // idempotent

    // Lazy path: wipe the snapshot, one public read captures it again.
    await prisma.$executeRawUnsafe(`UPDATE "FloorPlan" SET "publishedSnapshot" = NULL, "publishedAt" = NULL WHERE "floorId" = '${world.floorId}'`);
    await publicPlan();
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 50, width: 5, height: 10 });
    expect(await publicPlan()).not.toBeNull();
  });

  it('deleting the plan removes it for customers', async () => {
    await publishFloorPlanWithSync(world.floorId, { actorName: 'E2E' });
    await deleteFloorPlan(world.floorId);
    expect(await publicPlan()).toBeNull();
  });

  it('an inactive floor still hides the snapshot', async () => {
    await publishFloorPlanWithSync(world.floorId, { actorName: 'E2E' });
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 50, width: 5, height: 10 });
    await prisma.floor.update({ where: { id: world.floorId }, data: { isActive: false } });
    const res = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/${PIN.level}`);
    expect(res.status).toBe(404);
  });
});

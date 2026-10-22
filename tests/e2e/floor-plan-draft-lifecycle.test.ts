// Draft-version lifecycle against the live plan (docs/FLOOR_PLAN_MODEL.md
// "Draft versions"):
//
// - Publishing a version is ONE transaction: if the publish fails (permission,
//   size-sync blocker, stale preview) the working copy, the version markers
//   and the public view are exactly as before — never a half-applied restore.
// - Publishing the working copy directly clears every version's "Published"
//   marker (the live plan no longer equals any saved version).
// - Loading a version restores its snapshot INTO the working copy (DRAFT, real
//   row ids) without publishing: customers keep the last published snapshot,
//   the version markers are untouched, and later edits address real rows.

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, prisma, resetDb, seedMoveInWorld, type MoveInWorld } from './fixtures';
import { listDrafts, loadDraft, publishDraft, saveDraft } from '../../src/core/floorPlanDrafts';
import {
  createFloorPlanBlock,
  getFloorPlan,
  publishFloorPlanWithSync,
  setFloorPlanBlock,
  setUnitPlacement,
} from '../../src/core/floorPlans';

const publicPlan = async () => {
  const res = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/${PIN.level}`);
  expect(res.status).toBe(200);
  return res.body.data.plan as null | { placements: Array<{ x: number; y: number; unit: { unitCode: string } }> };
};

const markers = async (floorId: string) =>
  Object.fromEntries((await listDrafts(floorId)).map((d) => [d.version, d.status]));

describe('floor plan draft versions vs the live plan (DB)', () => {
  let world: MoveInWorld;
  let rentable: string;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
    rentable = (await prisma.unit.findUnique({ where: { unitCode: PIN.rentableUnit } }))!.id;
  });

  it('a failed version publish leaves the working copy, markers and public view untouched', async () => {
    await publishFloorPlanWithSync(world.floorId, { actorName: 'E2E' });
    const v1 = await saveDraft(world.floorId);
    await publishDraft(v1.id);

    // v2 moves the unit; the working copy holds a different, unsaved edit.
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 50, width: 5, height: 10 });
    const v2 = await saveDraft(world.floorId);
    await setUnitPlacement(world.floorId, rentable, { x: 20, y: 30, width: 5, height: 10 });
    const publicBefore = await publicPlan();

    // An operator without promotions.approve is refused…
    const actor = await prisma.adminUser.create({
      data: { email: 'no-approve@e2e.test', name: 'No Approve', passwordHash: 'x', permissions: { create: { permission: 'units.edit' } } },
    });
    await expect(publishDraft(v2.id, { actorId: actor.id })).rejects.toMatchObject({ status: 403 });

    // …and nothing moved: working copy keeps the unsaved edit, v1 stays the
    // published version, customers still see v1.
    const cms = await getFloorPlan(world.floorId);
    expect(cms.plan!.placements.find((p) => p.unit.id === rentable)).toMatchObject({ x: 20, y: 30 });
    expect(cms.plan!.status).toBe('DRAFT');
    expect(await markers(world.floorId)).toEqual({ 1: 'ACTIVE', 2: 'DRAFT' });
    expect(await publicPlan()).toEqual(publicBefore);
  });

  it('publishing the working copy directly clears the version Published marker', async () => {
    const v1 = await saveDraft(world.floorId);
    await publishDraft(v1.id);
    expect(await markers(world.floorId)).toEqual({ 1: 'ACTIVE' });

    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 50, width: 5, height: 10 });
    await publishFloorPlanWithSync(world.floorId, { actorName: 'E2E' });
    expect(await markers(world.floorId)).toEqual({ 1: 'DRAFT' });
  });

  it('loading a version restores it into the working copy without publishing', async () => {
    await publishFloorPlanWithSync(world.floorId, { actorName: 'E2E' });
    const publishedPos = (await publicPlan())!.placements.find((p) => p.unit.unitCode === PIN.rentableUnit)!;

    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 50, width: 5, height: 10 });
    await createFloorPlanBlock(world.floorId, { name: 'Lift', x: 1, y: 1, width: 4, height: 4 });
    const v1 = await saveDraft(world.floorId);
    // Drift the working copy away from v1.
    await setUnitPlacement(world.floorId, rentable, { x: 20, y: 30, width: 5, height: 10 });

    const res = await loadDraft(v1.id);
    expect(res.skippedPlacements).toEqual([]);
    const cms = await getFloorPlan(world.floorId);
    expect(cms.plan!.status).toBe('DRAFT');
    expect(cms.plan!.placements.find((p) => p.unit.id === rentable)).toMatchObject({ x: 40, y: 50 });

    // Customers still see the last published geometry; v1 is not "published".
    expect((await publicPlan())!.placements.find((p) => p.unit.unitCode === PIN.rentableUnit)).toMatchObject({
      x: publishedPos.x,
      y: publishedPos.y,
    });
    expect(await markers(world.floorId)).toEqual({ 1: 'DRAFT' });

    // Restored rows carry real ids, so the editor's per-element writes work.
    const block = cms.plan!.blocks[0];
    await setFloorPlanBlock(world.floorId, block.id, { name: 'Lift', x: 2, y: 2, width: 4, height: 4 });

    // Publishing the working copy now shows the loaded version.
    await publishFloorPlanWithSync(world.floorId, { actorName: 'E2E' });
    expect((await publicPlan())!.placements.find((p) => p.unit.unitCode === PIN.rentableUnit)).toMatchObject({ x: 40, y: 50 });
  });

  it('loading over a published plan that has no snapshot keeps it visible to customers', async () => {
    // Legacy ACTIVE plan published before snapshots existed.
    await prisma.floorPlan.update({ where: { floorId: world.floorId }, data: { status: 'ACTIVE' } });
    const v1 = await saveDraft(world.floorId, {
      placements: [{ unitId: rentable, x: 40, y: 50, width: 5, height: 10 }],
    });
    await loadDraft(v1.id);
    const view = await publicPlan();
    expect(view).not.toBeNull();
    expect(view!.placements.find((p) => p.unit.unitCode === PIN.rentableUnit)).not.toMatchObject({ x: 40, y: 50 });
  });
});

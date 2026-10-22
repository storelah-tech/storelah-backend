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
import { listDrafts, loadDraft, publishDraft, publishLivePlan, revertToPublished, saveDraft } from '../../src/core/floorPlanDrafts';
import {
  createFloorPlanBlock,
  createFloorPlanBoundary,
  createUnitOnPlan,
  getFloorPlan,
  publishFloorPlanWithSync,
  removeFloorPlanBlock,
  removeUnitPlacement,
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

  it('publishing the working copy saves it as a new version marked Published', async () => {
    const v1 = await saveDraft(world.floorId);
    await publishDraft(v1.id);
    expect(await markers(world.floorId)).toEqual({ 1: 'ACTIVE' });

    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 50, width: 5, height: 10 });
    await publishLivePlan(world.floorId, { actorName: 'E2E' });
    expect(await markers(world.floorId)).toEqual({ 1: 'DRAFT', 2: 'ACTIVE' });

    // The new version is exactly what customers see — loading it is a no-op.
    const v2 = (await listDrafts(world.floorId))[0];
    expect(v2.createdBy).toBe('E2E');
    await loadDraft(v2.id);
    expect((await getFloorPlan(world.floorId)).plan!.placements.find((p) => p.unit.id === rentable)).toMatchObject({ x: 40, y: 50 });
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

  // Production report 2026-10-22: published last week, today deleted
  // everything and drew one wall + one unit, saved, then "loaded last week's
  // plan" and got the wall + unit — no Library row was the published plan.
  it('revert to published recovers the plan customers see after a delete-all redraw', async () => {
    await publishFloorPlanWithSync(world.floorId, { actorName: 'E2E' }); // legacy: no version saved
    const published = (await publicPlan())!;
    const before = await getFloorPlan(world.floorId);
    const block = await createFloorPlanBlock(world.floorId, { name: 'Lift', x: 1, y: 1, width: 4, height: 4 });
    await publishFloorPlanWithSync(world.floorId, { actorName: 'E2E' });
    const publishedWithLift = (await publicPlan())!;

    // An old version still carries a stale Published marker (pre-hygiene data).
    const stale = await saveDraft(world.floorId, { placements: [] });
    await prisma.floorPlanDraft.update({ where: { id: stale.id }, data: { status: 'ACTIVE', updatedAt: new Date(Date.now() - 86_400_000) } });
    expect((await listDrafts(world.floorId)).find((d) => d.id === stale.id)!.status).toBe('DRAFT');

    // Delete all, draw a wall and a unit, Save as draft.
    for (const p of before.plan!.placements) await removeUnitPlacement(world.floorId, p.unit.id);
    await removeFloorPlanBlock(world.floorId, (block as { id: string }).id);
    await createFloorPlanBoundary(world.floorId, { kind: 'WALL', points: [[2, 2], [30, 2]] });
    await createUnitOnPlan(world.floorId, { x: 10, y: 10, width: 6, height: 8 });
    const today = await saveDraft(world.floorId);
    expect(today.counts.placements).toBe(1);

    // Loading the newest version only brings back the wall + unit…
    await loadDraft(today.id);
    expect((await getFloorPlan(world.floorId)).plan!.placements).toHaveLength(1);
    // …while customers still see the full published plan.
    expect((await publicPlan())!.placements).toHaveLength(published.placements.length);

    const res = await revertToPublished(world.floorId);
    expect(res.skippedPlacements).toEqual([]);
    const cms = (await getFloorPlan(world.floorId)).plan!;
    expect(cms.status).toBe('ACTIVE');
    expect(cms.placements).toHaveLength(published.placements.length);
    expect(cms.placements.every((p) => !p.areaDirty)).toBe(true);
    expect(cms.blocks.map((b) => b.name)).toEqual(['Lift']);
    expect(cms.boundaries).toHaveLength(0);
    for (const pl of publishedWithLift.placements) {
      expect(cms.placements.find((p) => p.unit.unitCode === pl.unit.unitCode)).toMatchObject({ x: pl.x, y: pl.y });
    }
    // Nothing new was published; today's drawing survives as a version.
    // (fresh row ids after the restore — compare what customers see)
    const shape = (v: any) => ({
      size: [v.width, v.height],
      units: v.placements.map((p: any) => [p.unit.unitCode, p.unit.status, p.x, p.y, p.width, p.height]).sort(),
      blocks: v.blocks.map((b: any) => [b.name, b.x, b.y, b.width, b.height]).sort(),
      lines: v.boundaries.length,
    });
    expect(shape(await publicPlan())).toEqual(shape(publishedWithLift));
    // The Library now holds the published plan as the one Published version.
    const rows = await listDrafts(world.floorId);
    expect(rows.some((d) => d.id === today.id)).toBe(true);
    expect(rows.filter((d) => d.status === 'ACTIVE')).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'ACTIVE', counts: { placements: published.placements.length, blocks: 1 } });
    // Reverting again does not pile up versions.
    await revertToPublished(world.floorId);
    expect(await listDrafts(world.floorId)).toHaveLength(rows.length);
  });

  it('revert to published is refused for a never-published floor', async () => {
    await expect(revertToPublished(world.floorId)).rejects.toMatchObject({ status: 409, code: 'NOT_PUBLISHED' });
  });
});

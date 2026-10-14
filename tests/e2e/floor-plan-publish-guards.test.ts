// Empty-plan publish guard + draft blocker preview
// (docs/FLOOR_PLAN_MODEL.md "Draft versions").
//
// - A publish that would put 0 placements live is refused with 409 EMPTY_PLAN
//   unless the body carries { confirmEmpty: true } — both the per-draft path
//   (publishDraft) and the live path (publishFloorPlanWithSync). Customers
//   would see an empty floor.
// - GET /drafts/:id/publish-preview (getPublishPreview) lists would-be
//   contracted-unit blockers (codes + from→to sqft, same contracted semantics
//   + epsilon as the publish preflight) BEFORE confirm; a clean draft lists
//   none. The 409 itself is unchanged.
// - The live publish-preview plan carries placementCount + emptyPlan.

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, prisma, resetDb, seedMoveInWorld, type MoveInWorld } from './fixtures';
import { getPublishPreview, publishDraft, saveDraft } from '../../src/core/floorPlanDrafts';
import { publishFloorPlanWithSync, setUnitPlacement } from '../../src/core/floorPlans';
import { buildSizeSyncPlan } from '../../src/core/unitSizeSync';

async function unitId(unitCode: string): Promise<string> {
  const u = await prisma.unit.findUnique({ where: { unitCode } });
  return u!.id;
}

async function expectAppError(p: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ status, code });
}

describe('empty-plan publish guard (DB)', () => {
  let world: MoveInWorld;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
  });

  it('draft publish with 0 placements needs { confirmEmpty: true }', async () => {
    const draft = await saveDraft(world.floorId, { placements: [], blocks: [], boundaries: [], markers: [] });
    const preview = await getPublishPreview(draft.id);
    expect(preview.emptyPlan).toBe(true);
    expect(preview.counts.placements).toBe(0);

    await expectAppError(publishDraft(draft.id), 409, 'EMPTY_PLAN');
    await expect(publishDraft(draft.id)).rejects.toMatchObject({
      status: 409,
      code: 'EMPTY_PLAN',
      details: { counts: { placements: 0 } },
    });

    const { plan } = await publishDraft(draft.id, { confirmEmpty: true });
    expect(plan.status).toBe('ACTIVE');
    expect(await prisma.unitPlacement.count({ where: { floorPlan: { floorId: world.floorId } } })).toBe(0);
  });

  it('live publish of an empty plan needs { confirmEmpty: true }', async () => {
    await prisma.unitPlacement.deleteMany({ where: { floorPlan: { floorId: world.floorId } } });
    const preview = await buildSizeSyncPlan(world.floorId);
    expect(preview.emptyPlan).toBe(true);
    expect(preview.placementCount).toBe(0);

    await expectAppError(publishFloorPlanWithSync(world.floorId), 409, 'EMPTY_PLAN');

    const { plan } = await publishFloorPlanWithSync(world.floorId, { confirmEmpty: true });
    expect(plan.status).toBe('ACTIVE');
  });

  it('live preview of a non-empty plan carries placementCount and emptyPlan: false', async () => {
    const preview = await buildSizeSyncPlan(world.floorId);
    expect(preview.emptyPlan).toBe(false);
    expect(preview.placementCount).toBeGreaterThan(0);
  });
});

describe('draft blocker preview (DB)', () => {
  let world: MoveInWorld;
  let rentable: string;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
    rentable = await unitId(PIN.rentableUnit);
  });

  it('a draft containing a contracted-resize lists the blocker codes with from→to sqft', async () => {
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 8, height: 8 }); // 64 vs 50
    const draft = await saveDraft(world.floorId);
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 5, height: 10 }); // live back to 50
    await prisma.unit.update({ where: { id: rentable }, data: { status: 'RESERVED' } });

    const preview = await getPublishPreview(draft.id);
    expect(preview.emptyPlan).toBe(false);
    expect(preview.blockers).toMatchObject([{ unitCode: PIN.rentableUnit, code: 'UNIT_CONTRACTED', from: 50, to: 64 }]);

    // The 409 itself is unchanged — still refused after confirm.
    await expectAppError(publishDraft(draft.id), 409, 'PUBLISH_BLOCKED');
  });

  it('a clean draft preview lists no blockers', async () => {
    const draft = await saveDraft(world.floorId);
    const preview = await getPublishPreview(draft.id);
    expect(preview.blockers).toEqual([]);
    expect(preview.emptyPlan).toBe(false);
  });
});

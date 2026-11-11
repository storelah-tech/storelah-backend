// Units module: Floor + Size editable after create (Level 1..8, floors created
// on demand), and the floor-plan L × W fix — the designer gets each unit's own
// length × width, and publishing a resized drawing writes L × W back onto the
// unit so the Units module never shows dimensions that disagree with sqft.

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, prisma, resetDb, seedMoveInWorld, type MoveInWorld } from './fixtures';
import { getFloorPlan, publishFloorPlanWithSync, setUnitPlacement, unitDimsFootprint } from '../../src/core/floorPlans';
import { createUnit, updateUnit, UNIT_FLOOR_LEVELS } from '../../src/core/units';

async function unitId(unitCode: string): Promise<string> {
  const u = await prisma.unit.findUnique({ where: { unitCode } });
  return u!.id;
}

describe('units — floor & size editable', () => {
  let world: MoveInWorld;
  let largeId: string;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
    largeId = (await prisma.unitSize.create({ data: { code: 'LARGE', name: 'Large', sqftFrom: 81, sqftTo: 200, sortOrder: 4 } })).id;
  });

  it('offers Level 1..8', () => {
    expect(UNIT_FLOOR_LEVELS).toBe(8);
  });

  it('create by floorLevel creates a missing level as an active "Level N" floor', async () => {
    const small = await prisma.unitSize.findFirstOrThrow({ where: { code: 'SMALL' } });
    const u = await createUnit({ branchId: world.branchId, floorLevel: 6, sizeId: small.id, lengthFt: 8, widthFt: 5, monthlyRate: 100 });
    const floor = await prisma.floor.findUniqueOrThrow({ where: { id: u.floorId } });
    expect(floor).toMatchObject({ branchId: world.branchId, level: 6, name: 'Level 6', isActive: true });
    // Same level again reuses the floor.
    const u2 = await createUnit({ branchId: world.branchId, floorLevel: 6, sizeId: small.id, lengthFt: 8, widthFt: 5, monthlyRate: 100 });
    expect(u2.floorId).toBe(u.floorId);
  });

  it('create refuses an inactive floor (by id or level)', async () => {
    await prisma.floor.update({ where: { id: world.planlessFloorId }, data: { isActive: false } });
    const small = await prisma.unitSize.findFirstOrThrow({ where: { code: 'SMALL' } });
    const base = { branchId: world.branchId, sizeId: small.id, lengthFt: 8, widthFt: 5, monthlyRate: 100 };
    await expect(createUnit({ ...base, floorId: world.planlessFloorId })).rejects.toMatchObject({ status: 400 });
    await expect(createUnit({ ...base, floorLevel: PIN.planlessLevel })).rejects.toMatchObject({ status: 400 });
  });

  it('edit changes the size category and moves an unplaced unit to another level', async () => {
    const id = await unitId(PIN.rentableUnit);
    await prisma.unitPlacement.delete({ where: { unitId: id } });
    const out = await updateUnit(PIN.rentableUnit, { sizeId: largeId, floorLevel: 7 });
    expect(out.size.code).toBe('LARGE');
    const row = await prisma.unit.findUniqueOrThrow({ where: { id }, include: { floor: true } });
    expect(row.floor.level).toBe(7);
    expect(row.sizeId).toBe(largeId);
  });

  it('edit refuses moving a placed unit off its floor (409 UNIT_ON_PLAN); same floor is a no-op', async () => {
    await expect(updateUnit(PIN.rentableUnit, { floorId: world.planlessFloorId })).rejects.toMatchObject({ status: 409, code: 'UNIT_ON_PLAN' });
    await expect(updateUnit(PIN.rentableUnit, { floorId: world.floorId, sizeId: largeId })).resolves.toMatchObject({ size: { code: 'LARGE' } });
  });

  it('updateUnit validates floorLevel 1..8 and an unknown size', async () => {
    await expect(updateUnit(PIN.rentableUnit, { sizeId: 'nope' })).rejects.toMatchObject({ status: 400 });
    await expect(updateUnit(PIN.rentableUnit, { floorLevel: 9 })).rejects.toMatchObject({ status: 400 });
  });
});

describe('floor plan — L × W', () => {
  let world: MoveInWorld;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
  });

  it('unitDimsFootprint uses the unit L × W (w = width, h = length), else the size estimate', () => {
    const size = { code: 'SMALL', widthFt: 5, heightFt: 6 };
    expect(unitDimsFootprint({ sqft: 40, lengthFt: 8, widthFt: 5, size })).toEqual({ w: 5, h: 8 });
    const est = unitDimsFootprint({ sqft: 40, lengthFt: null, widthFt: null, size });
    expect(est.w * est.h).toBeCloseTo(40, 1);
    expect(est).not.toEqual({ w: 5, h: 8 });
  });

  it('the CMS plan read carries each unit L × W; the public read keeps its shape', async () => {
    const id = await unitId(PIN.rentableUnit);
    await prisma.unit.update({ where: { id }, data: { lengthFt: 10, widthFt: 5 } });
    const guest = await unitId(PIN.guestUnit);
    await prisma.unitPlacement.delete({ where: { unitId: guest } });
    await prisma.unit.update({ where: { id: guest }, data: { lengthFt: 8, widthFt: 6.25, sqft: 50 } });
    const body = await getFloorPlan(world.floorId);
    const placed = body.plan!.placements.find((p: { unit: { id: string } }) => p.unit.id === id)!;
    expect(placed.unit).toMatchObject({ lengthFt: 10, widthFt: 5 });
    expect(body.unplacedUnits.find((u: { id: string }) => u.id === guest)).toMatchObject({ lengthFt: 8, widthFt: 6.25 });
    await publishFloorPlanWithSync(world.floorId);
    const pub = await api.get(`/api/v1/public/floor-plans/${PIN.branchCode}/${PIN.level}`);
    if (pub.status === 200) {
      const unit = (pub.body.data.placements || [])[0]?.unit;
      if (unit) expect(unit).not.toHaveProperty('lengthFt');
    }
  });

  it('publishing a resized drawing writes L × W back onto the unit', async () => {
    const id = await unitId(PIN.rentableUnit); // 50 sqft, drawn 5 × 10
    await prisma.unit.update({ where: { id }, data: { lengthFt: 10, widthFt: 5 } });
    await setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 6, height: 9 }); // 54 sqft
    await publishFloorPlanWithSync(world.floorId);
    const u = await prisma.unit.findUniqueOrThrow({ where: { id } });
    expect(u).toMatchObject({ sqft: 54, lengthFt: 9, widthFt: 6 });
  });

  it('a same-area reshape updates L × W; a pure rotation keeps the stored orientation', async () => {
    const id = await unitId(PIN.rentableUnit);
    await prisma.unit.update({ where: { id }, data: { lengthFt: 10, widthFt: 5 } });
    await setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 10, height: 5 }); // rotation, 50 sqft
    await prisma.unitPlacement.update({ where: { unitId: id }, data: { areaDirty: true } });
    await publishFloorPlanWithSync(world.floorId);
    expect(await prisma.unit.findUniqueOrThrow({ where: { id } })).toMatchObject({ lengthFt: 10, widthFt: 5, sqft: 50 });

    await setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 4, height: 12.5 }); // 50 sqft, new shape
    await prisma.unitPlacement.update({ where: { unitId: id }, data: { areaDirty: true } });
    await publishFloorPlanWithSync(world.floorId);
    expect(await prisma.unit.findUniqueOrThrow({ where: { id } })).toMatchObject({ lengthFt: 12.5, widthFt: 4, sqft: 50 });
  });
});

describe('size codes — LOCKER (8–15) + XS (10–19, the former LOCKER row)', () => {
  it('both LOCKER and XS are locker-class for stacking', async () => {
    const { isLockerSize } = await import('../../src/core/floorPlans');
    expect(isLockerSize('LOCKER')).toBe(true);
    expect(isLockerSize('xs')).toBe(true);
    expect(isLockerSize('SMALL')).toBe(false);
  });

  it('promotions: LOCKER and XS are separate discount rows; XLBIZ reads as XL', async () => {
    const { toCanonicalSizeCategory, CANONICAL_SIZE_CATEGORIES } = await import('../../src/core/promotionPlans');
    expect(CANONICAL_SIZE_CATEGORIES.slice(0, 2)).toEqual(['LOCKER', 'XS']);
    expect(toCanonicalSizeCategory('xs')).toBe('XS');
    expect(toCanonicalSizeCategory('LOCKER')).toBe('LOCKER');
    expect(toCanonicalSizeCategory('XLBIZ')).toBe('XL');
  });
});

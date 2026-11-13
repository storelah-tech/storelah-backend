// Site type: a single-level facility keeps exactly one active floor at its
// real building level (e.g. Level 6) so booking shows no floor choice; a
// multi-level facility runs several floors and booking lets customers choose.

import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDb } from './fixtures';
import { createBranch, listPublicBranches, updateBranch } from '../../src/core/branches';
import { createFloor, updateFloor } from '../../src/core/floors';
import { createUnit } from '../../src/core/units';

const base = { name: 'Level Six', address: '6 High Rd', operatingHours: '9-9' };

async function activeLevels(branchId: string) {
  const rows = await prisma.floor.findMany({ where: { branchId, isActive: true }, orderBy: { level: 'asc' } });
  return rows.map((f) => f.level);
}

describe('facility site type (single-level vs multi-level)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a single-level site with its floor at the real level', async () => {
    const b = await createBranch({ code: 'L6', ...base, floorLevel: 6 });
    expect(b.multiLevel).toBe(false);
    expect(await activeLevels(b.id)).toEqual([6]);
    const pub = (await listPublicBranches()).find((x) => x.code === 'L6');
    expect(pub).toMatchObject({ multiLevel: false, floors: [6] });
  });

  it('a single-level site refuses a second active floor (Floors, unit floorLevel, re-activation)', async () => {
    const b = await createBranch({ code: 'L6', ...base, floorLevel: 6 });
    await expect(createFloor({ branchId: b.id, level: 7 })).rejects.toMatchObject({ status: 400, code: 'SINGLE_LEVEL_SITE' });
    const size = await prisma.unitSize.create({ data: { code: 'SMALL', name: 'Small', sqftFrom: 20, sqftTo: 39, sortOrder: 1 } });
    const unit = { branchId: b.id, sizeId: size.id, lengthFt: 8, widthFt: 5, monthlyRate: 100 };
    await expect(createUnit({ ...unit, floorLevel: 7 })).rejects.toMatchObject({ status: 400, code: 'SINGLE_LEVEL_SITE' });
    // Its own floor still takes units.
    await expect(createUnit({ ...unit, floorLevel: 6 })).resolves.toBeTruthy();
    // An inactive extra floor cannot be switched on.
    const extra = await prisma.floor.create({ data: { branchId: b.id, level: 2, name: 'Level 2', isActive: false } });
    await expect(updateFloor(extra.id, { isActive: true })).rejects.toMatchObject({ status: 400, code: 'SINGLE_LEVEL_SITE' });
  });

  it('changing the level of a single-level site re-levels its one floor (units follow)', async () => {
    const b = await createBranch({ code: 'L6', ...base, floorLevel: 1 });
    const size = await prisma.unitSize.create({ data: { code: 'SMALL', name: 'Small', sqftFrom: 20, sqftTo: 39, sortOrder: 1 } });
    const u = await createUnit({ branchId: b.id, floorLevel: 1, sizeId: size.id, lengthFt: 8, widthFt: 5, monthlyRate: 100 });
    await updateBranch(b.id, { floorLevel: 6 });
    expect(await activeLevels(b.id)).toEqual([6]);
    const floor = await prisma.floor.findUniqueOrThrow({ where: { id: u.floorId } });
    expect(floor).toMatchObject({ level: 6, name: 'Level 6' });
  });

  it('multi-level sites add floors freely; switching back to single-level needs one active floor', async () => {
    const b = await createBranch({ code: 'ML', ...base, multiLevel: true });
    await createFloor({ branchId: b.id, level: 1 });
    await createFloor({ branchId: b.id, level: 2 });
    expect(await activeLevels(b.id)).toEqual([1, 2]);
    await expect(updateBranch(b.id, { multiLevel: false })).rejects.toMatchObject({ status: 400, code: 'SINGLE_LEVEL_SITE' });
    const l2 = await prisma.floor.findFirstOrThrow({ where: { branchId: b.id, level: 2 } });
    await updateFloor(l2.id, { isActive: false });
    await expect(updateBranch(b.id, { multiLevel: false, floorLevel: 1 })).resolves.toMatchObject({ multiLevel: false });
    expect((await listPublicBranches()).find((x) => x.code === 'ML')).toMatchObject({ multiLevel: false, floors: [1] });
  });

  it('single-level with no floor yet creates it; an inactive floor at that level is re-activated', async () => {
    const b = await createBranch({ code: 'NF', ...base });
    expect(await activeLevels(b.id)).toEqual([]);
    await prisma.floor.create({ data: { branchId: b.id, level: 6, name: 'Level 6', isActive: false } });
    await updateBranch(b.id, { floorLevel: 6 });
    expect(await activeLevels(b.id)).toEqual([6]);
  });
});

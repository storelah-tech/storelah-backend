// Floor-plan ⇄ unit sync Phase 1 (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md): the plan
// owns a placed unit's size. A resize is accepted at any sane area and flags
// the placement `areaDirty` (publish syncs Unit.sqft in Phase 2); contracted
// units keep the ±2% rule (409 UNIT_CONTRACTED); stacked lockers stay inside
// the LOCKER band; the new DRAFT unit status never reaches public reads.

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, prisma, resetDb, seedMoveInWorld, type MoveInWorld } from './fixtures';
import { applyFloorPlanBatch, getFloorPlan, setUnitPlacement } from '../../src/core/floorPlans';
import { MAX_UNIT_SQFT, checkPlacementArea, sqftForRect } from '../../src/core/unitSizing';

async function unitId(unitCode: string): Promise<string> {
  const u = await prisma.unit.findUnique({ where: { unitCode } });
  return u!.id;
}

async function expectAppError(p: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ status, code });
}

async function dirty(id: string): Promise<boolean> {
  const row = await prisma.unitPlacement.findUnique({ where: { unitId: id } });
  return row!.areaDirty;
}

describe('unitSizing (pure)', () => {
  const unit = { unitCode: '1001', sqft: 50 };

  it('rounds the drawn area half-up to whole sqft', () => {
    expect(sqftForRect({ width: 7.5, height: 6.3 })).toBe(47); // 47.25
    expect(sqftForRect({ width: 5, height: 10.1 })).toBe(51); // 50.5
    expect(sqftForRect({ width: 5, height: 10.09 })).toBe(50); // 50.45
  });

  it('unchanged area keeps the stored flag (move / rotation)', () => {
    const existing = { width: 5, height: 12, areaDirty: true };
    expect(checkPlacementArea({ unit, geom: { width: 12, height: 5 }, existing, contractedReason: undefined })).toBe(true);
    expect(checkPlacementArea({ unit, geom: { width: 5, height: 12 }, existing: { ...existing, areaDirty: false }, contractedReason: undefined })).toBe(false);
  });

  it('resize is dirty iff the rounded area differs from sqft', () => {
    const existing = { width: 5, height: 10 };
    expect(checkPlacementArea({ unit, geom: { width: 8, height: 8 }, existing, contractedReason: undefined })).toBe(true);
    expect(checkPlacementArea({ unit, geom: { width: 4, height: 12.6 }, existing, contractedReason: undefined })).toBe(false); // 50.4 → 50
  });

  it('contracted: within tolerance never dirty, beyond → 409 UNIT_CONTRACTED', () => {
    const existing = { width: 5, height: 10 };
    expect(checkPlacementArea({ unit, geom: { width: 4.9, height: 10.4 }, existing, contractedReason: 'OCCUPIED' })).toBe(false);
    expect(() => checkPlacementArea({ unit, geom: { width: 6, height: 10 }, existing, contractedReason: 'OCCUPIED' })).toThrow(
      expect.objectContaining({ status: 409, code: 'UNIT_CONTRACTED' }),
    );
  });

  it('rejects areas outside the sanity band', () => {
    expect(() => checkPlacementArea({ unit, geom: { width: 0.5, height: 0.5 }, existing: null, contractedReason: undefined })).toThrow(
      expect.objectContaining({ status: 400, code: 'VALIDATION' }),
    );
    expect(() => checkPlacementArea({ unit, geom: { width: 50, height: 41 }, existing: null, contractedReason: undefined })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(MAX_UNIT_SQFT).toBe(2000);
  });
});

describe('floor-plan unit sync — resize (DB)', () => {
  let world: MoveInWorld;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
  });

  it('a resize beyond 2% is accepted, flags areaDirty and leaves Unit.sqft for publish', async () => {
    const id = await unitId(PIN.rentableUnit); // 50 sqft, 5×10
    const p = await setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 8, height: 8 });
    expect(p).toMatchObject({ width: 8, height: 8, areaDirty: true });
    expect(await dirty(id)).toBe(true);
    const u = await prisma.unit.findUnique({ where: { id } });
    expect(u!.sqft).toBe(50); // synced on publish (Phase 2), never on save
    const { plan } = await getFloorPlan(world.floorId);
    expect(plan!.placements.find((x: { unit: { id: string } }) => x.unit.id === id)).toMatchObject({ areaDirty: true });
  });

  it('resizing back to the unit sqft clears the flag; a move keeps it', async () => {
    const id = await unitId(PIN.rentableUnit);
    await setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 8, height: 8 });
    await setUnitPlacement(world.floorId, id, { x: 50, y: 30, width: 8, height: 8 }); // move
    expect(await dirty(id)).toBe(true);
    await setUnitPlacement(world.floorId, id, { x: 50, y: 30, width: 5, height: 10.05 }); // 50.25 → 50
    expect(await dirty(id)).toBe(false);
  });

  it('grandfathered mismatched rows are never auto-flagged by moves', async () => {
    const id = await unitId(PIN.rentableUnit);
    await prisma.unitPlacement.update({ where: { unitId: id }, data: { width: 5, height: 11 } }); // 55 vs 50, legacy
    await setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 11, height: 5 }); // rotation
    expect(await dirty(id)).toBe(false);
  });

  it('rejects a unit beyond the sqft sanity band', async () => {
    const id = await unitId(PIN.rentableUnit);
    await expectAppError(setUnitPlacement(world.floorId, id, { x: 0, y: 30, width: 45, height: 45 }), 400, 'VALIDATION'); // 2025
  });

  it.each([
    ['OCCUPIED status', async (id: string) => { await prisma.unit.update({ where: { id }, data: { status: 'OCCUPIED' } }); }],
    ['RESERVED status', async (id: string) => { await prisma.unit.update({ where: { id }, data: { status: 'RESERVED' } }); }],
    ['a booking awaiting payment', async (id: string) => {
      const t = await prisma.tenant.create({ data: { name: 'T', monthlyRate: 120, psf: 2.4, status: 'ACTIVE' } });
      await prisma.booking.create({
        data: { bookingRef: 'SL-E2E-0001', tenantId: t.id, unitId: id, moveInDate: new Date(), duration: 'Monthly', amount: 120, status: 'PENDING_PAYMENT' },
      });
    }],
  ])('contracted via %s: resize > 2%% → 409 UNIT_CONTRACTED, reshape within 2%% ok', async (_label, contract) => {
    const id = await unitId(PIN.rentableUnit);
    await contract(id);
    await expectAppError(setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 8, height: 8 }), 409, 'UNIT_CONTRACTED');
    const p = await setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 4.9, height: 10.4 }); // 50.96
    expect(p.areaDirty).toBe(false);
  });

  it('a stale tenant link on an AVAILABLE unit does not lock its size (status is the truth)', async () => {
    const id = await unitId(PIN.rentableUnit);
    await prisma.tenant.create({ data: { name: 'T', unitId: id, monthlyRate: 120, psf: 2.4, status: 'ACTIVE' } });
    const p = await setUnitPlacement(world.floorId, id, { x: 40, y: 30, width: 8, height: 8 });
    expect(p.areaDirty).toBe(true);
  });

  it('batch: resizes flag dirty; a contracted resize rejects the WHOLE batch', async () => {
    const a = await unitId(PIN.rentableUnit);
    const b = await unitId(PIN.guestUnit);
    await applyFloorPlanBatch(world.floorId, { upsert: { placements: [{ unitId: a, x: 40, y: 30, width: 8, height: 8 }] } });
    expect(await dirty(a)).toBe(true);

    await prisma.unit.update({ where: { id: b }, data: { status: 'RESERVED' } });
    await expectAppError(
      applyFloorPlanBatch(world.floorId, {
        upsert: { placements: [{ unitId: a, x: 50, y: 30, width: 5, height: 10 }, { unitId: b, x: 40, y: 50, width: 8, height: 8 }] },
      }),
      409,
      'UNIT_CONTRACTED',
    );
    const row = await prisma.unitPlacement.findUnique({ where: { unitId: a } });
    expect(row).toMatchObject({ x: 40, width: 8, areaDirty: true }); // nothing written
  });

  it('batch: a stacked locker pair stays inside the LOCKER band', async () => {
    const locker = await prisma.unitSize.create({ data: { code: 'LOCKER', name: 'Locker', sqftFrom: 1, sqftTo: 25, sortOrder: 1 } });
    const mk = (unitCode: string) =>
      prisma.unit.create({
        data: { branchId: world.branchId, floorId: world.floorId, sizeId: locker.id, unitCode, sqft: 12, monthlyRate: 40 },
      });
    const lo = await mk('9001');
    const hi = await mk('9002');
    await setUnitPlacement(world.floorId, lo.id, { x: 50, y: 60, width: 3, height: 4 });
    await setUnitPlacement(world.floorId, hi.id, { x: 50, y: 60, width: 3, height: 4, stackTier: 1 });

    const pair = (w: number, h: number) => ({
      upsert: {
        placements: [
          { unitId: lo.id, x: 50, y: 60, width: w, height: h, stackTier: 0 },
          { unitId: hi.id, x: 50, y: 60, width: w, height: h, stackTier: 1 },
        ],
      },
    });
    await expectAppError(applyFloorPlanBatch(world.floorId, pair(6, 5)), 400, 'VALIDATION'); // 30 > 25
    await applyFloorPlanBatch(world.floorId, pair(4, 5)); // 20, in band
    expect(await dirty(lo.id)).toBe(true);
    expect(await dirty(hi.id)).toBe(true);
    // Single-write path: the upper tier alone may not leave the band either.
    await expectAppError(setUnitPlacement(world.floorId, lo.id, { x: 50, y: 60, width: 6, height: 5 }), 400, 'VALIDATION');
  });
});

describe('DRAFT unit status', () => {
  let world: MoveInWorld;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
  });

  it('a DRAFT unit is invisible to the public units read', async () => {
    const size = await prisma.unitSize.findFirst();
    await prisma.unit.create({
      data: { branchId: world.branchId, floorId: world.floorId, sizeId: size!.id, unitCode: '9100', sqft: 50, monthlyRate: 100, status: 'DRAFT' },
    });
    const res = await api.get('/api/v1/public/units');
    expect(res.status).toBe(200);
    const codes = res.body.data.map((u: { unitCode: string }) => u.unitCode);
    expect(codes).toContain(PIN.rentableUnit);
    expect(codes).not.toContain('9100');
  });
});

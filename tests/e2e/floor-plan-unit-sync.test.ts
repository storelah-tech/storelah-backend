// Floor-plan ⇄ unit sync Phase 1 (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md): the plan
// owns a placed unit's size. A resize is accepted at any sane area and flags
// the placement `areaDirty` (publish syncs Unit.sqft in Phase 2); contracted
// units keep the ±2% rule (409 UNIT_CONTRACTED); stacked lockers stay inside
// the LOCKER band; the new DRAFT unit status never reaches public reads.

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, prisma, resetDb, seedMoveInWorld, type MoveInWorld } from './fixtures';
import {
  applyFloorPlanBatch,
  getFloorPlan,
  publishFloorPlan,
  publishFloorPlanWithSync,
  reconcileUnitSizes,
  setUnitPlacement,
} from '../../src/core/floorPlans';
import { MAX_UNIT_SQFT, checkPlacementArea, sqftForRect } from '../../src/core/unitSizing';
import { buildSizeSyncPlan, keepPsfRate, listSizeMismatches, resolveSizeTier } from '../../src/core/unitSizeSync';
import { publishDraft, saveDraft } from '../../src/core/floorPlanDrafts';
import { getUnitDetail, updateUnit } from '../../src/core/units';

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

// ---------------------------------------------------------------------------
// Phase 2: publish applies pending sizes (D2/D4/D5), reconcile, Units API lock.
// Fixture: SMALL band 30–80 sqft; rentable unit = 50 sqft @ S$120 (5×10).
// ---------------------------------------------------------------------------

describe('unitSizeSync (pure)', () => {
  const sizes = [
    { id: 's', code: 'SMALL', name: 'Small', sqftFrom: 30, sqftTo: 80, sortOrder: 2 },
    { id: 'm', code: 'MEDIUM', name: 'Medium', sqftFrom: 70, sqftTo: 150, sortOrder: 3 },
  ];
  it('picks the covering band (current tier wins overlaps), else the nearest band', () => {
    expect(resolveSizeTier(sizes, 's', 75)).toMatchObject({ size: { id: 's' }, inBand: true }); // overlap 70–80
    expect(resolveSizeTier(sizes, 'm', 75)).toMatchObject({ size: { id: 'm' }, inBand: true });
    expect(resolveSizeTier(sizes, 's', 100)).toMatchObject({ size: { id: 'm' }, inBand: true });
    expect(resolveSizeTier(sizes, 's', 151)).toMatchObject({ size: { id: 'm' }, inBand: false });
    expect(resolveSizeTier([], 's', 50)).toBeNull();
  });

  it('works with single-point bands (as prisma/seed.ts creates them)', () => {
    const points = [
      { id: 'l', code: 'LOCKER', name: 'Locker', sqftFrom: 12, sqftTo: 12, sortOrder: 1 },
      { id: 's', code: 'SMALL', name: 'Small', sqftFrom: 30, sqftTo: 30, sortOrder: 2 },
      { id: 'm', code: 'MEDIUM', name: 'Medium', sqftFrom: 60, sqftTo: 60, sortOrder: 3 },
    ];
    expect(resolveSizeTier(points, 'm', 72)).toMatchObject({ size: { id: 'm' }, inBand: false });
    expect(resolveSizeTier(points, 's', 45)).toMatchObject({ size: { id: 's' }, inBand: false }); // tie 15/15 → keeps current
    expect(resolveSizeTier(points, 'm', 45)).toMatchObject({ size: { id: 'm' }, inBand: false });
    expect(resolveSizeTier(points, 'l', 20)).toMatchObject({ size: { id: 'l' } });
    expect(resolveSizeTier(points, 'l', 22)).toMatchObject({ size: { id: 's' } });
  });
  it('KEEP_PSF scales the rate by area, rounded to cents', () => {
    expect(keepPsfRate(120, 50, 64)).toBe(153.6);
    expect(keepPsfRate(100, 30, 31)).toBe(103.33);
  });
});

describe('floor-plan unit sync — publish (DB)', () => {
  let world: MoveInWorld;
  let rentable: string;

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
    rentable = await unitId(PIN.rentableUnit);
  });

  it('publish applies the drawn size: sqft, rate (keep $/sqft), history, flag cleared, plan ACTIVE', async () => {
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 8, height: 8 });
    const preview = await buildSizeSyncPlan(world.floorId);
    expect(preview.blockers).toEqual([]);
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]).toMatchObject({ unitCode: PIN.rentableUnit, oldSqft: 50, newSqft: 64, oldRate: 120, ratePreview: { KEEP_PSF: 153.6, KEEP_RATE: 120 } });

    const { plan, sizeSync } = await publishFloorPlanWithSync(world.floorId, { token: preview.token, actorName: 'E2E Op' });
    expect(plan.status).toBe('ACTIVE');
    expect(sizeSync.changed).toEqual([{ unitCode: PIN.rentableUnit, oldSqft: 50, newSqft: 64, oldSize: 'SMALL', newSize: 'SMALL', oldRate: 120, newRate: 153.6 }]);
    const u = await prisma.unit.findUnique({ where: { id: rentable } });
    expect(u!.sqft).toBe(64);
    expect(Number(u!.monthlyRate)).toBe(153.6);
    expect(await dirty(rentable)).toBe(false);
    const area = await prisma.unitAreaChange.findMany({ where: { unitId: rentable } });
    expect(area).toMatchObject([{ previous: 50, current: 64, widthFt: 8, heightFt: 8, source: 'FLOOR_PLAN_PUBLISH', appliedBy: 'E2E Op' }]);
    const rates = await prisma.rateChange.findMany({ where: { unitId: rentable } });
    expect(rates).toHaveLength(1);
    expect(Number(rates[0].current)).toBe(153.6);
    expect(rates[0].reason).toContain('50→64 sqft');
    // Public read sees the new size immediately.
    const pub = await api.get('/api/v1/public/units');
    expect(pub.body.data.find((x: { unitCode: string }) => x.unitCode === PIN.rentableUnit)).toMatchObject({ sqft: 64, rate: 153.6 });
  });

  it('KEEP_RATE leaves the rate (no RateChange); SET uses the typed rate', async () => {
    const guest = await unitId(PIN.guestUnit); // 50 sqft @ 130
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 8, height: 8 });
    await setUnitPlacement(world.floorId, guest, { x: 50, y: 30, width: 6, height: 10 });
    await publishFloorPlan(world.floorId, {
      choices: [
        { unitId: rentable, ratePolicy: 'KEEP_RATE' },
        { unitId: guest, ratePolicy: 'SET', rate: 149.5 },
      ],
    });
    expect(Number((await prisma.unit.findUnique({ where: { id: rentable } }))!.monthlyRate)).toBe(120);
    expect(await prisma.rateChange.count({ where: { unitId: rentable } })).toBe(0);
    expect(Number((await prisma.unit.findUnique({ where: { id: guest } }))!.monthlyRate)).toBe(149.5);
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 8, height: 9 });
    await expectAppError(publishFloorPlan(world.floorId, { choices: [{ unitId: rentable, ratePolicy: 'SET' }] }), 400, 'VALIDATION');
  });

  it('re-tiers into the band that covers the new size', async () => {
    await prisma.unitSize.create({ data: { code: 'MEDIUM', name: 'Medium', sqftFrom: 81, sqftTo: 150, sortOrder: 3 } });
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 10, height: 10 });
    const { sizeSync } = await publishFloorPlanWithSync(world.floorId);
    expect(sizeSync.changed[0]).toMatchObject({ oldSize: 'SMALL', newSize: 'MEDIUM', newSqft: 100 });
    const u = await prisma.unit.findUnique({ where: { id: rentable }, include: { size: true } });
    expect(u!.size.code).toBe('MEDIUM');
  });

  it('a size outside every band takes the nearest tier (flagged), and a chosen tier overrides it', async () => {
    const large = await prisma.unitSize.create({ data: { code: 'LARGE', name: 'Large', sqftFrom: 120, sqftTo: 120, sortOrder: 4 } });
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 15, height: 13 }); // 195
    const preview = await buildSizeSyncPlan(world.floorId);
    expect(preview.blockers).toEqual([]);
    expect(preview.changes[0]).toMatchObject({ newSqft: 195, newSize: { code: 'LARGE' }, tierInBand: false });
    const small = await prisma.unitSize.findUnique({ where: { code: 'SMALL' } });
    const { sizeSync } = await publishFloorPlanWithSync(world.floorId, { choices: [{ unitId: rentable, sizeId: small!.id }] });
    expect(sizeSync.changed[0]).toMatchObject({ newSqft: 195, newSize: 'SMALL' });
    expect((await prisma.unit.findUnique({ where: { id: rentable } }))!.sizeId).toBe(small!.id);
    expect(large.code).toBe('LARGE');
  });

  it('an unknown tier choice is refused and nothing is written', async () => {
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 8, height: 8 });
    await expectAppError(publishFloorPlan(world.floorId, { choices: [{ unitId: rentable, sizeId: 'nope' }] }), 400, 'VALIDATION');
    expect((await prisma.floorPlan.findUnique({ where: { floorId: world.floorId } }))!.status).toBe('DRAFT');
    expect((await prisma.unit.findUnique({ where: { id: rentable } }))!.sqft).toBe(50);
  });

  it('a unit that became contracted after its resize blocks publish', async () => {
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 8, height: 8 });
    await prisma.unit.update({ where: { id: rentable }, data: { status: 'RESERVED' } });
    const preview = await buildSizeSyncPlan(world.floorId);
    expect(preview.blockers).toMatchObject([{ code: 'UNIT_CONTRACTED' }]);
    await expectAppError(publishFloorPlan(world.floorId), 409, 'PUBLISH_BLOCKED');
    expect((await prisma.unit.findUnique({ where: { id: rentable } }))!.sqft).toBe(50);
  });

  it('a stale preview token is refused', async () => {
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 8, height: 8 });
    const { token } = await buildSizeSyncPlan(world.floorId);
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 8, height: 9 });
    await expectAppError(publishFloorPlan(world.floorId, { token }), 409, 'STALE_PREVIEW');
    const fresh = await buildSizeSyncPlan(world.floorId);
    await publishFloorPlan(world.floorId, { token: fresh.token });
    expect((await prisma.unit.findUnique({ where: { id: rentable } }))!.sqft).toBe(72);
  });

  it('a dirty flag whose rounded area already matches is just cleared (no history)', async () => {
    await prisma.unitPlacement.update({ where: { unitId: rentable }, data: { areaDirty: true } });
    await publishFloorPlan(world.floorId);
    expect(await dirty(rentable)).toBe(false);
    expect(await prisma.unitAreaChange.count()).toBe(0);
  });

  it('DRAFT units on the plan are promoted to AVAILABLE on publish', async () => {
    const size = await prisma.unitSize.findUnique({ where: { code: 'SMALL' } });
    const d = await prisma.unit.create({
      data: { branchId: world.branchId, floorId: world.floorId, sizeId: size!.id, unitCode: '9200', sqft: 40, monthlyRate: 99, status: 'DRAFT' },
    });
    const plan = await prisma.floorPlan.findUnique({ where: { floorId: world.floorId } });
    await prisma.unitPlacement.create({ data: { floorPlanId: plan!.id, unitId: d.id, x: 60, y: 60, width: 5, height: 8 } });
    const preview = await buildSizeSyncPlan(world.floorId);
    expect(preview.newUnits).toMatchObject([{ unitCode: '9200', sqft: 40 }]);
    const { sizeSync } = await publishFloorPlanWithSync(world.floorId);
    expect(sizeSync.promoted).toEqual(['9200']);
    expect((await prisma.unit.findUnique({ where: { id: d.id } }))!.status).toBe('AVAILABLE');
  });

  it('grandfathered mismatches never auto-sync; reconcile marks or fits them', async () => {
    const guest = await unitId(PIN.guestUnit);
    await prisma.unitPlacement.update({ where: { unitId: rentable }, data: { width: 5, height: 11 } }); // 55 vs 50
    await prisma.unitPlacement.update({ where: { unitId: guest }, data: { width: 5, height: 11 } });
    const occ = await unitId(PIN.occupiedUnit);
    await prisma.unitPlacement.update({ where: { unitId: occ }, data: { width: 5, height: 11 } });

    await publishFloorPlan(world.floorId);
    expect((await prisma.unit.findUnique({ where: { id: rentable } }))!.sqft).toBe(50);

    const mism = await listSizeMismatches(world.floorId);
    expect(mism.map((m) => m.unitCode).sort()).toEqual([PIN.rentableUnit, PIN.guestUnit, PIN.occupiedUnit].sort());
    expect(mism.find((m) => m.unitId === occ)!.contracted).toBe('OCCUPIED');

    await expectAppError(reconcileUnitSizes(world.floorId, [{ unitId: occ, action: 'MARK_FOR_SYNC' }]), 409, 'UNIT_CONTRACTED');
    const r = await reconcileUnitSizes(world.floorId, [
      { unitId: rentable, action: 'MARK_FOR_SYNC' },
      { unitId: guest, action: 'FIT_DRAWING' },
    ]);
    expect(r.reconciled).toHaveLength(2);
    expect(r.mismatches.map((m) => m.unitCode)).toEqual([PIN.occupiedUnit]);
    const g = await prisma.unitPlacement.findUnique({ where: { unitId: guest } });
    expect(sqftForRect(g!)).toBe(50);
    expect(g!.height).toBeGreaterThan(g!.width); // orientation kept (portrait)

    await publishFloorPlan(world.floorId);
    expect((await prisma.unit.findUnique({ where: { id: rentable } }))!.sqft).toBe(55);
    expect((await prisma.unit.findUnique({ where: { id: guest } }))!.sqft).toBe(50);
  });

  it('publishing a draft version flags restored size changes and syncs them', async () => {
    const guest = await unitId(PIN.guestUnit);
    await prisma.unitPlacement.update({ where: { unitId: guest }, data: { width: 5, height: 11 } }); // grandfathered
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 8, height: 8 });
    const draft = await saveDraft(world.floorId);
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 5, height: 10 }); // live back to 50
    expect(await dirty(rentable)).toBe(false);

    await publishDraft(draft.id);
    expect((await prisma.unit.findUnique({ where: { id: rentable } }))!.sqft).toBe(64);
    expect((await prisma.unit.findUnique({ where: { id: guest } }))!.sqft).toBe(50); // carried over unchanged
  });

  it('a draft version that resizes a contracted unit is refused before the working copy changes', async () => {
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 8, height: 8 });
    const draft = await saveDraft(world.floorId);
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 5, height: 10 });
    await prisma.unit.update({ where: { id: rentable }, data: { status: 'RESERVED' } });
    await expectAppError(publishDraft(draft.id), 409, 'PUBLISH_BLOCKED');
    const row = await prisma.unitPlacement.findUnique({ where: { unitId: rentable } });
    expect(row).toMatchObject({ width: 5, height: 10 });
  });

  it('Units API: a placed unit\'s sqft is owned by the plan; detail exposes placement + history', async () => {
    await expectAppError(updateUnit(PIN.rentableUnit, { sqft: 60 }), 409, 'SIZE_OWNED_BY_PLAN');
    await expect(updateUnit(PIN.rentableUnit, { sqft: 50, monthlyRate: 125 })).resolves.toMatchObject({}); // same sqft = no-op
    await setUnitPlacement(world.floorId, rentable, { x: 40, y: 30, width: 8, height: 8 });
    await publishFloorPlan(world.floorId, { actorName: 'E2E Op' });
    const d = await getUnitDetail(PIN.rentableUnit);
    expect(d).toMatchObject({ sizeOwnedByPlan: true, sqft: 64, placement: { widthFt: 8, heightFt: 8, areaDirty: false, floorPlanStatus: 'ACTIVE' } });
    expect(d.areaHistory).toMatchObject([{ previous: 50, current: 64, source: 'FLOOR_PLAN_PUBLISH', by: 'E2E Op' }]);
    // An unplaced unit keeps the editable sqft.
    await prisma.unitPlacement.delete({ where: { unitId: rentable } });
    await expect(updateUnit(PIN.rentableUnit, { sqft: 70 })).resolves.toMatchObject({ sqft: 70 });
  });
});

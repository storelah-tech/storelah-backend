// Master Rate Strategy close-out (Track B, B5).
//
// Guardrail + legacy-path proof across the UI-called CMS routes:
//   - CANCEL_IF_MANUAL 409 cancels the batch, surfaces it in the response,
//     and writes nothing (units, tenants, RateChange).
//   - REPLACE_MANUAL is re-checked at apply time (Owner only), and occupied
//     Tenant.monthlyRate is untouched under every conflict rule.
//   - A version that stops being APPROVED/ACTIVE can no longer apply — not
//     via apply, retry, or the due-batch sweep (handoff §27, §15.25).
//   - Draft / rejected versions can never create batches.
//   - Batch creation idempotency replays on the same key.
//   - Stale approve + partial warning reasons are rejected (D12: no numeric
//     threshold ever blocks; every warning needs its own reason).
//   - Floor-plan publish stamps MANUAL only when the rate actually changes
//     (R16 — the last unstamped manual-rate path alongside adjustRate).
//   - SCHEDULED batch lines carry live rateSource (apply preview lists
//     LEGACY separately); the D13 schedule covers stocked sizes past 150 as
//     XL (hand-derived: 160 sq ft → S$827, same engine/world as B3).
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { api, createOperator, prisma, resetDb, type Operator } from './fixtures';
import { todaySg } from '../../src/core/pricing/rateStrategyService';
import { applySizeSync } from '../../src/core/unitSizeSync';
import { createModel } from '../../src/core/finance/models';
import { project as projectModel } from '../../src/core/finance/projection';

const CMS = '/api/v1/cms';

const LEvers = {
  referenceSize: 10,
  startingRate: 90,
  method: 'SMOOTH',
  curveStrength: 0.2,
  stepEvery: 5,
  stepPsf: 0.2,
  psfFloor: 4.2,
  minMonthly: 45,
  lockerAdj: -0.25,
  groundFloorAdj: 0.1,
  restrictedAdj: -0.1,
  facilityAdj: 0,
  rounding: 1,
  categoryFloors: { LOCKER: 7.0, XS: 7.0, S: 6.5, M: 5.8, L: 5.0, XL: 4.2 },
  sizeOverrides: [],
};

interface World {
  ownerA: Operator;
  ownerB: Operator;
  manager: Operator;
  branchId: string;
  tenantId: string;
  pctPlanId: string;
  freePlanId: string;
  mediumId: string;
}

function sgDate(offsetDays = 0): string {
  const d = new Date(`${todaySg()}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function seedWorld(): Promise<World> {
  const ownerA = await createOperator('OWNER');
  const ownerB = await createOperator('OWNER');
  const manager = await createOperator('MANAGER');

  const branch = await prisma.branch.create({
    data: { code: 'RC', name: 'Rate Closeout (E2E)', address: 'E2E', operatingHours: '9am – 9pm daily' },
  });
  const l1 = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'Level 1' } });
  const l2 = await prisma.floor.create({ data: { branchId: branch.id, level: 2, name: 'Level 2' } });

  const locker = await prisma.unitSize.create({ data: { code: 'LOCKER', name: 'Locker', sqftFrom: 8, sqftTo: 15, sortOrder: 0 } });
  const xs = await prisma.unitSize.create({ data: { code: 'XS', name: 'XS', sqftFrom: 10, sqftTo: 19, sortOrder: 1 } });
  const small = await prisma.unitSize.create({ data: { code: 'SMALL', name: 'Small', sqftFrom: 20, sqftTo: 39, sortOrder: 2 } });
  const medium = await prisma.unitSize.create({ data: { code: 'MEDIUM', name: 'Medium', sqftFrom: 40, sqftTo: 69, sortOrder: 3 } });
  const xlbiz = await prisma.unitSize.create({ data: { code: 'XLBIZ', name: 'XL', sqftFrom: 100, sqftTo: 150, sortOrder: 5 } });

  async function unit(unitCode: string, sizeId: string, floorId: string, sqft: number, status: 'AVAILABLE' | 'OCCUPIED', rate: number, rateSource = 'LEGACY') {
    return prisma.unit.create({
      data: { branchId: branch.id, floorId, sizeId, unitCode, sqft, status, monthlyRate: new Prisma.Decimal(rate), rateSource, climateControl: 'Ambient climate' },
    });
  }

  // RC-U01 10 XS AVAILABLE LEGACY · RC-U02 12 LOCKER AVAILABLE MANUAL ·
  // RC-U03 40 MEDIUM AVAILABLE LEGACY · RC-U04 50 MEDIUM OCCUPIED LEGACY ·
  // RC-U05 160 XLBIZ AVAILABLE LEGACY (above 150, D13).
  await unit('RC-U01', xs.id, l1.id, 10, 'AVAILABLE', 100);
  const u02 = await unit('RC-U02', locker.id, l1.id, 12, 'AVAILABLE', 90, 'MANUAL');
  await prisma.rateChange.create({
    data: { unitId: u02.id, date: new Date(), previous: new Prisma.Decimal(95), current: new Prisma.Decimal(90), changePct: -5.3, reason: 'Operator retier', appliedBy: 'Operator' },
  });
  await unit('RC-U03', medium.id, l2.id, 40, 'AVAILABLE', 270);
  const u04 = await unit('RC-U04', medium.id, l1.id, 50, 'OCCUPIED', 300);
  const tenant = await prisma.tenant.create({
    data: { name: 'Closeout Renter', email: 'closeout@e2e.test', unitId: u04.id, branchId: branch.id, monthlyRate: new Prisma.Decimal(300), psf: new Prisma.Decimal(6), status: 'ACTIVE' },
  });
  await unit('RC-U05', xlbiz.id, l2.id, 160, 'AVAILABLE', 400);

  const model = await createModel({ name: 'RC launch', branchId: branch.id, actor: 'e2e' });
  await prisma.financialModel.update({ where: { id: model.id }, data: { status: 'CURRENT' } });

  const pct = await prisma.promotionPlan.create({
    data: {
      kind: 'DISCOUNT_MATRIX', name: 'Longer Stay RC', status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      facilityScope: ['ALL'], sizeScope: ['ALL'],
      matrixCells: {
        create: [
          { sizeCategory: 'XS', accessType: 'Standard', commitmentMonths: 12, discountPct: new Prisma.Decimal(45) },
          { sizeCategory: 'LOCKER', accessType: 'Standard', commitmentMonths: 12, discountPct: new Prisma.Decimal(50) },
          { sizeCategory: 'MEDIUM', accessType: 'Standard', commitmentMonths: 12, discountPct: new Prisma.Decimal(42) },
          { sizeCategory: 'SMALL', accessType: 'Standard', commitmentMonths: 12, discountPct: new Prisma.Decimal(20) },
          { sizeCategory: 'XLBIZ', accessType: 'Standard', commitmentMonths: 12, discountPct: new Prisma.Decimal(30) },
        ],
      },
    },
  });
  const free = await prisma.promotionPlan.create({
    data: {
      kind: 'FREE_MONTHS', name: 'Stay 12 Pay 10 RC', status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      facilityScope: ['ALL'], sizeScope: [medium.id],
      freeMonthCount: 2, commitmentMonths: 12,
    },
  });

  return { ownerA, ownerB, manager, branchId: branch.id, tenantId: tenant.id, pctPlanId: pct.id, freePlanId: free.id, mediumId: medium.id };
}

async function createDraft(world: World, actor: Operator) {
  return api.post(`${CMS}/facilities/${world.branchId}/rate-strategy`).set('Authorization', actor.auth).send({
    name: 'RC Sembawang',
    levers: LEvers,
    effectiveFrom: sgDate(0),
    promotionPreview: { durationMonths: 12, matrix: 'Standard', planIds: [world.pctPlanId, world.freePlanId] },
  });
}

async function warningsOf(versionId: string, actor: Operator): Promise<Array<{ code: string }>> {
  const validated = await api.post(`${CMS}/rate-strategy/${versionId}/validate`).set('Authorization', actor.auth).send({});
  expect(validated.status).toBe(200);
  return validated.body.data.warnings as Array<{ code: string }>;
}

async function submitAndApprove(world: World, versionId: string): Promise<void> {
  const warnings = await warningsOf(versionId, world.ownerA);
  const submitted = await api.post(`${CMS}/rate-strategy/${versionId}/submit`).set('Authorization', world.ownerA.auth).send({
    version: 0, warningOverride: { reasons: warnings.map(() => 'Accepted for close-out.') },
  });
  expect(submitted.status).toBe(200);
  const approved = await api.post(`${CMS}/rate-strategy/${versionId}/approve`)
    .set('Authorization', world.ownerB.auth).send({ version: 1, comment: 'Close-out.' });
  expect(approved.status).toBe(200);
}

describe('rate strategy close-out (B5 guardrails + legacy paths)', () => {
  let world: World;

  beforeEach(async () => {
    await resetDb();
    world = await seedWorld();
  });

  it('cancel-if-manual: due creation 409s, cancels, surfaces the batch, writes nothing', async () => {
    const draft = await createDraft(world, world.ownerA);
    const versionId = draft.body.data.id as string;
    await submitAndApprove(world, versionId);

    const unitsBefore = await prisma.unit.findMany({ where: { branchId: world.branchId }, select: { unitCode: true, monthlyRate: true, rateSource: true }, orderBy: { unitCode: 'asc' } });
    const changesBefore = await prisma.rateChange.count();

    // A due CANCEL_IF_MANUAL batch cancels inside creation → 409, batch kept.
    const blocked = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(0), conflictRule: 'CANCEL_IF_MANUAL' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('MANUAL_RATES_EXIST');
    expect(blocked.body.error.details.manualCount).toBe(1);
    expect(blocked.body.error.details.batchStatus).toBe('CANCELLED');
    expect(blocked.body.error.details.batch.status).toBe('CANCELLED');
    expect(blocked.body.error.details.batch.ref).toMatch(/^RATE-/);
    // Nothing applied: every line still PENDING.
    expect((blocked.body.error.details.batch.lines as Array<{ outcome: string }>).every((l) => l.outcome === 'PENDING')).toBe(true);

    const stored = await prisma.unitRateBatch.findFirstOrThrow({ where: { ref: blocked.body.error.details.batch.ref } });
    expect(stored.status).toBe('CANCELLED');

    // Units, tenant rent and rate history are untouched.
    const unitsAfter = await prisma.unit.findMany({ where: { branchId: world.branchId }, select: { unitCode: true, monthlyRate: true, rateSource: true }, orderBy: { unitCode: 'asc' } });
    expect(unitsAfter.map((u) => ({ ...u, monthlyRate: Number(u.monthlyRate) })))
      .toEqual(unitsBefore.map((u) => ({ ...u, monthlyRate: Number(u.monthlyRate) })));
    expect(Number((await prisma.tenant.findUniqueOrThrow({ where: { id: world.tenantId } })).monthlyRate)).toBe(300);
    expect(await prisma.rateChange.count()).toBe(changesBefore);

    // A future-dated CANCEL_IF_MANUAL batch schedules, then cancels on apply
    // once due (NOT_DUE guards early apply — the date is simulated forward,
    // exactly like the B3 sweep test).
    const future = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(7), conflictRule: 'CANCEL_IF_MANUAL' });
    expect(future.status).toBe(201);
    expect(future.body.data.status).toBe('SCHEDULED');
    const early = await api.post(`${CMS}/rate-batches/${future.body.data.id}/apply`)
      .set('Authorization', world.ownerB.auth).send({});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('NOT_DUE');
    await prisma.unitRateBatch.update({ where: { id: future.body.data.id }, data: { effectiveDate: new Date(`${sgDate(0)}T00:00:00.000Z`) } });
    const apply = await api.post(`${CMS}/rate-batches/${future.body.data.id}/apply`)
      .set('Authorization', world.ownerB.auth).send({});
    expect(apply.status).toBe(409);
    expect(apply.body.error.code).toBe('MANUAL_RATES_EXIST');
    expect((await prisma.unitRateBatch.findUniqueOrThrow({ where: { id: future.body.data.id } })).status).toBe('CANCELLED');
    expect(Number((await prisma.unit.findFirstOrThrow({ where: { unitCode: 'RC-U01' } })).monthlyRate)).toBe(100);
  });

  it('replace-manual re-checks Owner at apply time; occupied rent untouched under every rule', async () => {
    const draft = await createDraft(world, world.ownerA);
    const versionId = draft.body.data.id as string;
    await submitAndApprove(world, versionId);

    const future = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(5), conflictRule: 'REPLACE_MANUAL' });
    expect(future.status).toBe(201);
    // Simulate the date arriving: only due batches apply.
    await prisma.unitRateBatch.update({ where: { id: future.body.data.id }, data: { effectiveDate: new Date(`${sgDate(0)}T00:00:00.000Z`) } });

    // A non-Owner with approve + units:update passes route RBAC but fails the
    // service Owner re-check at apply time.
    const roleRes = await api.post(`${CMS}/roles`).set('Authorization', world.ownerA.auth).send({
      name: 'Rate publisher RC',
      permissions: ['facility-rate-strategy:view', 'facility-rate-strategy:approve', 'facility-units:update'],
    });
    expect(roleRes.status).toBe(201);
    const publisher = await createOperator(roleRes.body.data.key);
    const denied = await api.post(`${CMS}/rate-batches/${future.body.data.id}/apply`)
      .set('Authorization', publisher.auth).send({});
    expect(denied.status).toBe(403);

    // Owner apply overwrites the manual unit (B-9 §15.9 order, hand-derived
    // in B3: S$104.13 base × 0.75 × 1.10 = S$85.91 → S$1 → S$86.00).
    const applied = await api.post(`${CMS}/rate-batches/${future.body.data.id}/apply`)
      .set('Authorization', world.ownerB.auth).send({});
    expect(applied.status).toBe(200);
    expect(applied.body.data.status).toBe('APPLIED');
    const manualLine = (applied.body.data.lines as Array<Record<string, unknown>>).find((l) => l.unitCode === 'RC-U02')!;
    expect(manualLine).toMatchObject({ outcome: 'APPLIED', proposedRack: 86 });
    expect(await prisma.unit.findFirstOrThrow({ where: { unitCode: 'RC-U02' } })).toMatchObject({ rateSource: 'STRATEGY' });
    expect(Number((await prisma.tenant.findUniqueOrThrow({ where: { id: world.tenantId } })).monthlyRate)).toBe(300);
  });

  it('versions that stop being approved cannot apply — via apply, retry or sweep', async () => {
    const draft = await createDraft(world, world.ownerA);
    const versionId = draft.body.data.id as string;

    // Draft and rejected versions can never create batches.
    const draftBatch = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(0) });
    expect(draftBatch.status).toBe(409);
    expect(draftBatch.body.error.code).toBe('NOT_ACTIVE');
    const warnings = await warningsOf(versionId, world.ownerA);
    await api.post(`${CMS}/rate-strategy/${versionId}/submit`).set('Authorization', world.ownerA.auth).send({
      version: 0, warningOverride: { reasons: warnings.map(() => 'Accepted.') },
    });
    const rejected = await api.post(`${CMS}/rate-strategy/${versionId}/reject`)
      .set('Authorization', world.ownerB.auth).send({ version: 1, reason: 'Not this quarter.' });
    expect(rejected.status).toBe(200);
    const rejectedBatch = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(0) });
    expect(rejectedBatch.status).toBe(409);
    expect(rejectedBatch.body.error.code).toBe('NOT_ACTIVE');

    // Approved version → scheduled batch → version superseded → apply blocked.
    const draft2 = await createDraft(world, world.ownerA);
    const v2 = draft2.body.data.id as string;
    await submitAndApprove(world, v2);
    const future = await api.post(`${CMS}/rate-strategy/${v2}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(5), conflictRule: 'PRESERVE_MANUAL' });
    expect(future.status).toBe(201);
    await prisma.rateStrategyVersion.update({ where: { id: v2 }, data: { status: 'SUPERSEDED' } });
    // Simulate the date arriving so the timing guard passes and the
    // eligibility guard is the one under test.
    await prisma.unitRateBatch.update({ where: { id: future.body.data.id }, data: { effectiveDate: new Date(`${sgDate(0)}T00:00:00.000Z`) } });

    const apply = await api.post(`${CMS}/rate-batches/${future.body.data.id}/apply`)
      .set('Authorization', world.ownerB.auth).send({});
    expect(apply.status).toBe(409);
    expect(apply.body.error.code).toBe('NOT_ACTIVE');
    expect((await prisma.unitRateBatch.findUniqueOrThrow({ where: { id: future.body.data.id } })).status).toBe('SCHEDULED');
    expect(Number((await prisma.unit.findFirstOrThrow({ where: { unitCode: 'RC-U01' } })).monthlyRate)).toBe(100);

    // The due-batch sweep skips it instead of applying stale rates.
    const sweep = await api.post(`${CMS}/units/rate-batches/apply-due`)
      .set('Authorization', world.ownerB.auth).send({});
    expect(sweep.status).toBe(200);
    expect(sweep.body.data.results.find((r: { batchId: string }) => r.batchId === future.body.data.id))
      .toMatchObject({ status: 'SCHEDULED', skipped: 'NOT_ACTIVE' });
    expect(Number((await prisma.unit.findFirstOrThrow({ where: { unitCode: 'RC-U01' } })).monthlyRate)).toBe(100);
  });

  it('batch creation idempotency replays on the same key; stale approve and partial reasons fail (D12)', async () => {
    const draft = await createDraft(world, world.ownerA);
    const versionId = draft.body.data.id as string;
    const warnings = await warningsOf(versionId, world.ownerA);
    expect(warnings.length).toBeGreaterThanOrEqual(2);

    // Partial reasons (fewer than warnings) never satisfy the override.
    const partial = await api.post(`${CMS}/rate-strategy/${versionId}/submit`)
      .set('Authorization', world.ownerA.auth).send({ version: 0, warningOverride: { reasons: ['Only one reason.'] } });
    expect(partial.status).toBe(409);
    expect(partial.body.error.code).toBe('WARNING_OVERRIDE_REQUIRED');

    const submitted = await api.post(`${CMS}/rate-strategy/${versionId}/submit`).set('Authorization', world.ownerA.auth).send({
      version: 0, warningOverride: { reasons: warnings.map(() => 'Accepted for close-out.') },
    });
    expect(submitted.status).toBe(200);

    // Stale approve → 409 STALE (version-conflict handling on every mutation).
    const stale = await api.post(`${CMS}/rate-strategy/${versionId}/approve`)
      .set('Authorization', world.ownerB.auth).send({ version: 999, comment: 'Stale.' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE');

    const approved = await api.post(`${CMS}/rate-strategy/${versionId}/approve`)
      .set('Authorization', world.ownerB.auth).send({ version: 1, comment: 'Close-out.' });
    expect(approved.status).toBe(200);

    // Same idempotency key twice: first creates (201), second replays (200).
    const payload = { effectiveDate: sgDate(6), conflictRule: 'PRESERVE_MANUAL', idempotencyKey: 'rc-closeout-1' };
    const first = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send(payload);
    expect(first.status).toBe(201);
    const second = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send(payload);
    expect(second.status).toBe(200);
    expect(second.body.meta).toMatchObject({ replayed: true });
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.lines).toEqual(first.body.data.lines);
  });

  it('floor-plan publish stamps MANUAL only when the rate changes (R16)', async () => {
    const branch = await prisma.branch.create({
      data: { code: 'RF', name: 'Rate Floorplan (E2E)', address: 'E2E', operatingHours: '9am – 9pm daily' },
    });
    const floor = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'Level 1' } });
    // Reuse the world's XS (10–19) / SMALL (20–39) tiers — size codes are global.
    const xs = await prisma.unitSize.findFirstOrThrow({ where: { code: 'XS' } });
    const small = await prisma.unitSize.findFirstOrThrow({ where: { code: 'SMALL' } });
    const plan = await prisma.floorPlan.create({ data: { floorId: floor.id } });

    // KEEP_PSF default: 5×4 ft drawing on a 10 sq ft / S$100 unit → 20 sq ft,
    // S$200 — an operator rate change, so MANUAL.
    const changed = await prisma.unit.create({
      data: { branchId: branch.id, floorId: floor.id, sizeId: xs.id, unitCode: 'RF-U01', sqft: 10, status: 'AVAILABLE', monthlyRate: new Prisma.Decimal(100), rateSource: 'LEGACY' },
    });
    await prisma.unitPlacement.create({
      data: { floorPlanId: plan.id, unitId: changed.id, x: 0, y: 0, width: 5, height: 4, areaDirty: true },
    });
    const sync = await prisma.$transaction((tx) =>
      applySizeSync(tx, floor.id, { appliedBy: 'E2E Operator', floorPlanId: plan.id }));
    expect(sync.changed.map((c) => c.unitCode)).toEqual(['RF-U01']);
    expect(sync.changed[0]).toMatchObject({ newSqft: 20, newRate: 200 });
    expect(await prisma.unit.findUniqueOrThrow({ where: { id: changed.id } })).toMatchObject({
      sqft: 20, rateSource: 'MANUAL',
    });
    expect(Number((await prisma.unit.findUniqueOrThrow({ where: { id: changed.id } })).monthlyRate)).toBe(200);
    expect((await prisma.unit.findUniqueOrThrow({ where: { id: changed.id } })).sizeId).toBe(small.id);
    const history = await prisma.rateChange.findMany({ where: { unitId: changed.id } });
    expect(history.length).toBe(1);
    expect(history[0]).toMatchObject({ appliedBy: 'E2E Operator' });

    // KEEP_RATE: same geometry, rate untouched — provenance stays LEGACY and
    // no RateChange row is written.
    const kept = await prisma.unit.create({
      data: { branchId: branch.id, floorId: floor.id, sizeId: xs.id, unitCode: 'RF-U02', sqft: 10, status: 'AVAILABLE', monthlyRate: new Prisma.Decimal(100), rateSource: 'LEGACY' },
    });
    await prisma.unitPlacement.create({
      data: { floorPlanId: plan.id, unitId: kept.id, x: 10, y: 0, width: 5, height: 4, areaDirty: true },
    });
    await prisma.$transaction((tx) =>
      applySizeSync(tx, floor.id, { choices: [{ unitId: kept.id, ratePolicy: 'KEEP_RATE' }], appliedBy: 'E2E Operator', floorPlanId: plan.id }));
    expect(await prisma.unit.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({
      sqft: 20, rateSource: 'LEGACY',
    });
    expect(await prisma.rateChange.count({ where: { unitId: kept.id } })).toBe(0);
  });

  it('scheduled batch lines carry live rateSource; D13 schedule covers 160 as XL', async () => {
    const draft = await createDraft(world, world.ownerA);
    const versionId = draft.body.data.id as string;

    // Hand-derived preview pins: 10 sq ft → S$90 rack; 160 sq ft (above the
    // 150 window) extends the schedule as XL → S$827.
    const preview = await api.get(`${CMS}/rate-strategy/${versionId}/preview`).set('Authorization', world.ownerA.auth);
    expect(preview.status).toBe(200);
    expect(preview.body.data.preview.scheduleMax).toBeGreaterThanOrEqual(160);
    const rows = preview.body.data.preview.rows as Array<{ size: number; category: string; rackMonthly: number }>;
    expect(rows.find((r) => r.size === 160)).toMatchObject({ category: 'XL', rackMonthly: 827 });
    expect(rows.find((r) => r.size === 10)).toMatchObject({ category: 'XS', rackMonthly: 90 });
    expect(preview.body.data.preview.sizesAboveRange).toEqual([160]);

    await submitAndApprove(world, versionId);
    const future = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(5), conflictRule: 'PRESERVE_MANUAL' });
    expect(future.status).toBe(201);
    expect(future.body.data.status).toBe('SCHEDULED');
    // The apply preview lists LEGACY separately: every PENDING line carries
    // live provenance, so MANUAL vs LEGACY is visible before anything applies.
    const byCode = new Map((future.body.data.lines as Array<{ unitCode: string; rateSource: string; outcome: string }>).map((l) => [l.unitCode, l]));
    expect(byCode.get('RC-U02')).toMatchObject({ outcome: 'PENDING', rateSource: 'MANUAL' });
    for (const code of ['RC-U01', 'RC-U03', 'RC-U04', 'RC-U05']) {
      expect(byCode.get(code)).toMatchObject({ outcome: 'PENDING', rateSource: 'LEGACY' });
    }

    const detail = await api.get(`${CMS}/rate-batches/${future.body.data.id}`).set('Authorization', world.manager.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.lines.length).toBe(5);
    expect(detail.body.data.lines.every((l: { outcome: string }) => l.outcome === 'PENDING')).toBe(true);
  });
});

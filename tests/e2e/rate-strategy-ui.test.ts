// Master Rate Strategy CMS UI contract (Track B, B4).
//
// The UI is static JS (src/cms/admin/rateStrategyView.js), so the gate is
// API-level: every route the workspace calls must still behave — list, show,
// update-draft, preview, validate, submit, approve, duplicate, batch
// create/list/detail/apply/retry/cancel, apply-due, audit timeline and the
// ratestrategy.* settings surface.
//
// Expectations mirror the B3 service suite (same hand-derived §15.16/§15.17
// numbers, not the prototype): reference 10 sq ft @ S$90 smooth 0.20, floor
// S$4.20, round S$1; 45% XS / 42% MEDIUM percentage cells; 2 free months for
// MEDIUM on 12-month commitments.
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { api, createOperator, prisma, resetDb, type Operator } from './fixtures';
import { todaySg } from '../../src/core/pricing/rateStrategyService';
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
  modelId: string;
  pctPlanId: string;
  freePlanId: string;
  versionId: string;
  targetPsf: number;
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
    data: { code: 'RU', name: 'Rate UI (E2E)', address: 'E2E', operatingHours: '9am – 9pm daily' },
  });
  const l1 = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'Level 1' } });
  const l2 = await prisma.floor.create({ data: { branchId: branch.id, level: 2, name: 'Level 2' } });
  const locker = await prisma.unitSize.create({ data: { code: 'LOCKER', name: 'Locker', sqftFrom: 8, sqftTo: 15, sortOrder: 0 } });
  const xs = await prisma.unitSize.create({ data: { code: 'XS', name: 'XS', sqftFrom: 10, sqftTo: 19, sortOrder: 1 } });
  const medium = await prisma.unitSize.create({ data: { code: 'MEDIUM', name: 'Medium', sqftFrom: 40, sqftTo: 69, sortOrder: 3 } });

  async function unit(unitCode: string, sizeId: string, floorId: string, sqft: number, status: 'AVAILABLE' | 'OCCUPIED', rate: number, rateSource = 'LEGACY') {
    return prisma.unit.create({
      data: { branchId: branch.id, floorId, sizeId, unitCode, sqft, status, monthlyRate: new Prisma.Decimal(rate), rateSource, climateControl: 'Ambient climate' },
    });
  }

  await unit('RU-U01', xs.id, l1.id, 10, 'AVAILABLE', 100);
  const u02 = await unit('RU-U02', locker.id, l1.id, 12, 'AVAILABLE', 90, 'MANUAL');
  await prisma.rateChange.create({
    data: { unitId: u02.id, date: new Date(), previous: new Prisma.Decimal(95), current: new Prisma.Decimal(90), changePct: -5.3, reason: 'Operator retier', appliedBy: 'Operator' },
  });
  await unit('RU-U03', medium.id, l2.id, 40, 'AVAILABLE', 270);
  const u04 = await unit('RU-U04', medium.id, l1.id, 50, 'OCCUPIED', 300);
  await prisma.tenant.create({
    data: { name: 'E2E Renter', email: 'renter@e2e.test', unitId: u04.id, branchId: branch.id, monthlyRate: new Prisma.Decimal(300), psf: new Prisma.Decimal(6), status: 'ACTIVE' },
  });

  const model = await createModel({ name: 'RS UI launch', branchId: branch.id, actor: 'e2e' });
  await prisma.financialModel.update({ where: { id: model.id }, data: { status: 'CURRENT' } });
  const stored = await prisma.financialModel.findUniqueOrThrow({ where: { id: model.id } });
  const targetPsf = projectModel(stored.inputs as never).kpis.weightedStartPsf;

  const pct = await prisma.promotionPlan.create({
    data: {
      kind: 'DISCOUNT_MATRIX', name: 'Longer Stay UI E2E', status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      facilityScope: ['ALL'], sizeScope: ['ALL'],
      matrixCells: {
        create: [
          { sizeCategory: 'XS', accessType: 'Standard', commitmentMonths: 12, discountPct: new Prisma.Decimal(45) },
          { sizeCategory: 'MEDIUM', accessType: 'Standard', commitmentMonths: 12, discountPct: new Prisma.Decimal(42) },
        ],
      },
    },
  });

  const free = await prisma.promotionPlan.create({
    data: {
      kind: 'FREE_MONTHS', name: 'Stay 12 Pay 10 UI E2E', status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      facilityScope: ['ALL'], sizeScope: [medium.id],
      freeMonthCount: 2, commitmentMonths: 12,
    },
  });

  const draft = await api.post(`${CMS}/facilities/${branch.id}/rate-strategy`).set('Authorization', ownerA.auth).send({
    name: 'RU Sembawang',
    levers: LEvers,
    effectiveFrom: sgDate(0),
    promotionPreview: { durationMonths: 12, matrix: 'Standard', planIds: [pct.id, free.id] },
  });
  expect(draft.status).toBe(201);

  return { ownerA, ownerB, manager, branchId: branch.id, modelId: model.id, pctPlanId: pct.id, freePlanId: free.id, versionId: draft.body.data.id as string, targetPsf };
}

async function approveWorld(world: World): Promise<string> {
  const validated = await api.post(`${CMS}/rate-strategy/${world.versionId}/validate`).set('Authorization', world.ownerA.auth).send({});
  expect(validated.status).toBe(200);
  const submitted = await api.post(`${CMS}/rate-strategy/${world.versionId}/submit`).set('Authorization', world.ownerA.auth).send({
    version: 0,
    warningOverride: { reasons: (validated.body.data.warnings as unknown[]).map(() => 'Accepted for the UI workspace.') },
  });
  expect(submitted.status).toBe(200);
  const approved = await api.post(`${CMS}/rate-strategy/${world.versionId}/approve`)
    .set('Authorization', world.ownerB.auth).send({ version: 1, comment: 'UI E2E.' });
  expect(approved.status).toBe(200);
  return world.versionId;
}

describe('rate strategy CMS UI contract (B4)', () => {
  let world: World;

  beforeEach(async () => {
    await resetDb();
    world = await seedWorld();
  });

  it('strategy list: library cards, status/branch filters and the empty state', async () => {
    // List view — every card carries what the table renders.
    const all = await api.get(`${CMS}/rate-strategy/library`).set('Authorization', world.ownerA.auth);
    expect(all.status).toBe(200);
    const card = all.body.data.find((c: { versionId: string }) => c.versionId === world.versionId);
    expect(card).toMatchObject({
      strategyName: 'RU Sembawang', versionNo: 1, status: 'DRAFT',
      branchCode: 'RU', effectiveFrom: sgDate(0), owner: world.ownerA.email,
    });
    expect(card.updatedAt).toBeTruthy();

    // Branch + status filters (the workspace filter bar).
    const byBranch = await api.get(`${CMS}/rate-strategy/library?branchId=${world.branchId}`).set('Authorization', world.ownerA.auth);
    expect(byBranch.body.data.map((c: { versionId: string }) => c.versionId)).toContain(world.versionId);
    const byStatus = await api.get(`${CMS}/rate-strategy/library?status=DRAFT`).set('Authorization', world.manager.auth);
    expect(byStatus.body.data.length).toBeGreaterThanOrEqual(1);
    // Handoff §19: `No strategies match these filters.`
    const empty = await api.get(`${CMS}/rate-strategy/library?status=REJECTED`).set('Authorization', world.ownerA.auth);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);
    const emptyBranch = await api.get(`${CMS}/rate-strategy/library?branchId=no-such-branch`).set('Authorization', world.ownerA.auth);
    expect(emptyBranch.status).toBe(200);
    expect(emptyBranch.body.data).toEqual([]);
  });

  it('show view reads: detail, lever summary and draft update with CAS', async () => {
    const detail = await api.get(`${CMS}/rate-strategy/${world.versionId}`).set('Authorization', world.manager.auth);
    expect(detail.status).toBe(200);
    // Header (status/version) + lever summary.
    expect(detail.body.data).toMatchObject({ status: 'DRAFT', versionNo: 1, version: 0, strategyName: 'RU Sembawang' });
    expect(detail.body.data.levers).toMatchObject({ referenceSize: 10, startingRate: 90, method: 'SMOOTH', rounding: 1 });

    // Edit-levers form → PATCH with the CAS version.
    const updated = await api.patch(`${CMS}/rate-strategy/${world.versionId}`)
      .set('Authorization', world.ownerA.auth).send({ version: 0, levers: { startingRate: 95 } });
    expect(updated.status).toBe(200);
    expect(updated.body.data.levers.startingRate).toBe(95);
    expect(updated.body.data.version).toBe(1);

    // Stale edit → 409 STALE (the UI keeps the user's inputs and reloads).
    const stale = await api.patch(`${CMS}/rate-strategy/${world.versionId}`)
      .set('Authorization', world.ownerA.auth).send({ version: 0, levers: { startingRate: 96 } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE');

    // Unknown version → 404.
    const missing = await api.get(`${CMS}/rate-strategy/no-such-version`).set('Authorization', world.ownerA.auth);
    expect(missing.status).toBe(404);
  });

  it('preview sample and validation feed the show view (hand-derived)', async () => {
    const preview = await api.get(`${CMS}/rate-strategy/${world.versionId}/preview?durationMonths=12&matrix=Standard`)
      .set('Authorization', world.ownerA.auth);
    expect(preview.status).toBe(200);
    const rows = preview.body.data.preview.rows as Array<Record<string, number & string>>;
    const at = (size: number) => rows.find((r) => (r.size as number) === size)!;
    // §15.16: 10 sq ft @ 90 with 45% XS → 49.50 / 4.95.
    expect(at(10).rackMonthly).toBe(90);
    expect(at(10).effectiveMonthly).toBe(49.5);
    // §15.17: 40 sq ft → 273.00 / 158.34 / 131.95 blended.
    expect(at(40).rackMonthly).toBe(273);
    expect(at(40).blendedMonthly).toBe(131.95);
    expect(preview.body.data.target.targetPsf).toBe(world.targetPsf);

    const validated = await api.post(`${CMS}/rate-strategy/${world.versionId}/validate`)
      .set('Authorization', world.ownerA.auth).send({});
    expect(validated.status).toBe(200);
    expect(validated.body.data.blockers).toEqual([]);
    expect(validated.body.data.warnings.length).toBeGreaterThan(0);
    for (const w of validated.body.data.warnings as Array<{ reason: string }>) {
      expect(w.reason.trim().length).toBeGreaterThan(0);
    }

    // No CURRENT model: the show view still gets the rack schedule with
    // the target labelled unavailable (B-6) — submit stays blocked.
    const branch = await prisma.branch.create({ data: { code: 'RX', name: 'No model (UI)', address: 'E2E', operatingHours: '9-9' } });
    const floor = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'L1' } });
    const size = await prisma.unitSize.findFirstOrThrow();
    await prisma.unit.create({
      data: { branchId: branch.id, floorId: floor.id, sizeId: size.id, unitCode: 'RX-U01', sqft: 10, status: 'AVAILABLE', monthlyRate: new Prisma.Decimal(100) },
    });
    const draft = await api.post(`${CMS}/facilities/${branch.id}/rate-strategy`)
      .set('Authorization', world.ownerA.auth).send({ name: 'No model UI' });
    expect(draft.status).toBe(201);
    const rackOnly = await api.get(`${CMS}/rate-strategy/${draft.body.data.id}/preview`).set('Authorization', world.ownerA.auth);
    expect(rackOnly.status).toBe(200);
    expect(rackOnly.body.data.noTarget).toBe(true);
    expect(rackOnly.body.data.target).toBeNull();
    expect((rackOnly.body.data.preview.rows as unknown[]).length).toBeGreaterThan(0);
    const submitBlocked = await api.post(`${CMS}/rate-strategy/${draft.body.data.id}/submit`).set('Authorization', world.ownerA.auth).send({ version: 0 });
    expect(submitBlocked.status).toBe(409);
    expect(submitBlocked.body.error.code).toBe('NO_CURRENT_MODEL');
  });

  it('actions: submit/approve with the maker-checker note data, duplicate with uplift', async () => {
    const validated = await api.post(`${CMS}/rate-strategy/${world.versionId}/validate`).set('Authorization', world.ownerA.auth).send({});
    const submitted = await api.post(`${CMS}/rate-strategy/${world.versionId}/submit`).set('Authorization', world.ownerA.auth).send({
      version: 0,
      warningOverride: { reasons: (validated.body.data.warnings as unknown[]).map(() => 'Accepted for the UI workspace.') },
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('PENDING_APPROVAL');
    expect(submitted.body.data.submittedBy).toBe(world.ownerA.email);

    // Maker-checker: the UI shows its note from this 403 (submittedBy echo).
    const selfApprove = await api.post(`${CMS}/rate-strategy/${world.versionId}/approve`)
      .set('Authorization', world.ownerA.auth).send({ version: 1 });
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('SELF_APPROVAL');
    expect(selfApprove.body.error.details).toMatchObject({ submittedBy: world.ownerA.email });

    const approved = await api.post(`${CMS}/rate-strategy/${world.versionId}/approve`)
      .set('Authorization', world.ownerB.auth).send({ version: 1, comment: 'UI E2E.' });
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');

    // Duplicate for facility (default +5% uplift path the UI offers).
    const dup = await api.post(`${CMS}/rate-strategy/${world.versionId}/duplicate`)
      .set('Authorization', world.ownerA.auth).send({ destinationBranchId: world.branchId, name: 'RU copy', upliftPct: 5 });
    expect(dup.status).toBe(201);
    expect(dup.body.data).toMatchObject({ versionNo: 1, status: 'DRAFT', originVersionId: world.versionId });
    expect(dup.body.data.levers.startingRate).toBe(94.5);

    // Version history: the library carries both versions for the timeline.
    const library = await api.get(`${CMS}/rate-strategy/library`).set('Authorization', world.ownerA.auth);
    const versions = (library.body.data as Array<{ strategyId: string; versionNo: number }>)
      .filter((c) => c.strategyId === approved.body.data.strategyId).map((c) => c.versionNo);
    expect(versions).toEqual([1]);
    const dupRows = (library.body.data as Array<{ versionId: string }>)
      .filter((c) => c.versionId === dup.body.data.id);
    expect(dupRows.length).toBe(1);
  });

  it('scheduler: batch list filters, detail lines, run-now and cancel rules', async () => {
    await approveWorld(world);

    // Immediate batch applies on create; future batch stays Scheduled.
    const now = await api.post(`${CMS}/rate-strategy/${world.versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(0), conflictRule: 'PRESERVE_MANUAL' });
    expect(now.status).toBe(201);
    expect(now.body.data.status).toBe('APPLIED');
    expect(now.body.data.summary).toMatchObject({ applied: 2, preservedManual: 1, skippedOccupied: 1, failed: 0, pending: 0 });

    const future = await api.post(`${CMS}/rate-strategy/${world.versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(5), conflictRule: 'PRESERVE_MANUAL' });
    expect(future.status).toBe(201);
    expect(future.body.data.status).toBe('SCHEDULED');

    // Scheduler list (the new GET /rate-batches): all + filters.
    const all = await api.get(`${CMS}/rate-batches`).set('Authorization', world.manager.auth);
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBe(2);
    expect(all.body.data[0]).toMatchObject({ branchCode: 'RU' });
    expect(Object.keys(all.body.data[0].summary).sort()).toEqual(['applied', 'failed', 'pending', 'preservedManual', 'skippedOccupied']);
    const scheduled = await api.get(`${CMS}/rate-batches?status=SCHEDULED`).set('Authorization', world.ownerB.auth);
    expect(scheduled.body.data.map((b: { id: string }) => b.id)).toEqual([future.body.data.id]);
    const byVersion = await api.get(`${CMS}/rate-batches?versionId=${world.versionId}`).set('Authorization', world.ownerB.auth);
    expect(byVersion.body.data.length).toBe(2);
    const byBranch = await api.get(`${CMS}/rate-batches?branchId=${world.branchId}`).set('Authorization', world.ownerB.auth);
    expect(byBranch.body.data.length).toBe(2);
    // Unknown status never 500s — it is ignored like an empty filter.
    const unknownStatus = await api.get(`${CMS}/rate-batches?status=NOPE`).set('Authorization', world.ownerB.auth);
    expect(unknownStatus.status).toBe(200);
    expect(unknownStatus.body.data.length).toBe(2);

    // Batch detail with per-unit lines.
    const detail = await api.get(`${CMS}/rate-batches/${future.body.data.id}`).set('Authorization', world.manager.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.lines.length).toBe(4);
    expect(detail.body.data.lines.every((l: { outcome: string }) => l.outcome === 'PENDING')).toBe(true);
    const missing = await api.get(`${CMS}/rate-batches/no-such-batch`).set('Authorization', world.ownerB.auth);
    expect(missing.status).toBe(404);

    // Run-now: nothing due yet → skipped; force the date, sweep applies.
    const empty = await api.post(`${CMS}/units/rate-batches/apply-due`).set('Authorization', world.ownerB.auth).send({});
    expect(empty.status).toBe(200);
    expect(empty.body.data.results.find((r: { batchId: string }) => r.batchId === future.body.data.id))
      .toMatchObject({ status: 'SCHEDULED', skipped: 'not-due' });
    await prisma.unitRateBatch.update({ where: { id: future.body.data.id }, data: { effectiveDate: new Date(`${sgDate(0)}T00:00:00.000Z`) } });
    const sweep = await api.post(`${CMS}/units/rate-batches/apply-due`).set('Authorization', world.ownerB.auth).send({});
    const applied = sweep.body.data.results.find((r: { batchId: string }) => r.batchId === future.body.data.id);
    expect(applied.status).toBe('APPLIED');
    expect(applied.summary.applied).toBe(2);

    // Cancel rules: applied → 409; no reason → 400; scheduled + reason → CANCELLED.
    const cancelApplied = await api.post(`${CMS}/rate-batches/${now.body.data.id}/cancel`)
      .set('Authorization', world.ownerB.auth).send({ reason: 'Too late.' });
    expect(cancelApplied.status).toBe(409);
    const future2 = await api.post(`${CMS}/rate-strategy/${world.versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(9) });
    const cancelNoReason = await api.post(`${CMS}/rate-batches/${future2.body.data.id}/cancel`)
      .set('Authorization', world.ownerB.auth).send({});
    expect(cancelNoReason.status).toBe(400);
    const cancelled = await api.post(`${CMS}/rate-batches/${future2.body.data.id}/cancel`)
      .set('Authorization', world.ownerB.auth).send({ reason: 'Superseded.' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    // No approval gate (client 2026-11-20): scheduler mutations need
    // facility-rate-strategy:update, which the system Manager role holds.
    const mgrDue = await api.post(`${CMS}/units/rate-batches/apply-due`).set('Authorization', world.manager.auth).send({});
    expect(mgrDue.status).toBe(200);
  });

  it('activity feed: audit timeline covers the version and its batches', async () => {
    await approveWorld(world);
    const batch = await api.post(`${CMS}/rate-strategy/${world.versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(0) });
    expect(batch.status).toBe(201);

    const versionFeed = await api.get(`${CMS}/finance/audit?entityType=rate-strategy&entityId=${world.versionId}&limit=100`)
      .set('Authorization', world.ownerA.auth);
    expect(versionFeed.status).toBe(200);
    expect(versionFeed.body.data.map((r: { action: string }) => r.action))
      .toEqual(expect.arrayContaining(['RATE_STRATEGY_SUBMITTED', 'RATE_STRATEGY_APPROVED']));

    const batchFeed = await api.get(`${CMS}/finance/audit?entityType=rate-batch&entityId=${batch.body.data.id}&limit=50`)
      .set('Authorization', world.ownerA.auth);
    expect(batchFeed.status).toBe(200);
    expect(batchFeed.body.data.map((r: { action: string }) => r.action))
      .toEqual(expect.arrayContaining(['RATE_BATCH_APPLIED']));
  });

  it('settings: defaults surface reads and writes through business rules', async () => {
    const rules = await api.get(`${CMS}/business-rules`).set('Authorization', world.ownerA.auth);
    expect(rules.status).toBe(200);
    const byKey = Object.fromEntries((rules.body.data as Array<{ key: string; value: unknown }>).map((r) => [r.key, r.value]));
    expect(byKey['ratestrategy.defaultRounding']).toBe(1);
    expect(byKey['ratestrategy.defaultConflictRule']).toBe('PRESERVE_MANUAL');

    const saved = await api.put(`${CMS}/business-rules`).set('Authorization', world.ownerA.auth).send({
      'ratestrategy.defaultRounding': 5,
      'ratestrategy.defaultConflictRule': 'REPLACE_MANUAL',
    });
    expect(saved.status).toBe(200);
    const again = Object.fromEntries((saved.body.data as Array<{ key: string; value: unknown }>).map((r) => [r.key, r.value]));
    expect(again['ratestrategy.defaultRounding']).toBe(5);
    expect(again['ratestrategy.defaultConflictRule']).toBe('REPLACE_MANUAL');

    const unknown = await api.put(`${CMS}/business-rules`).set('Authorization', world.ownerA.auth).send({ 'ratestrategy.nope': 1 });
    expect(unknown.status).toBe(400);
  });
});

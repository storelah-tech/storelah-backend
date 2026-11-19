// Master Rate Strategy service + CMS API (Track B, B3).
//
// Scenario E steps 4–7 through the API: draft → preview → validate →
// submit-with-override → approve → batch apply, with occupied-tenant-rent
// proof, stale-submit rejection, self-approval block, idempotent batch
// replay, future-dated Scheduled + applyDueBatches, warning-without-reason
// rejection and below-target-never-blocks (D12).
//
// Expectations are hand-derived from the B1 pure engine (§15.16/§15.17
// numbers, not the prototype): reference 10 sq ft @ S$90 smooth 0.20,
// floor S$4.20, round S$1; 45% XS / 42% MEDIUM percentage cells; 2 free
// months for MEDIUM on 12-month commitments.
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
  branchCode: string;
  tenantId: string;
  pctPlanId: string;
  freePlanId: string;
  draftPlanId: string;
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
    data: { code: 'RS', name: 'Rate Strategy (E2E)', address: 'E2E', operatingHours: '9am – 9pm daily' },
  });
  const l1 = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'Level 1' } });
  const l2 = await prisma.floor.create({ data: { branchId: branch.id, level: 2, name: 'Level 2' } });

  const locker = await prisma.unitSize.create({ data: { code: 'LOCKER', name: 'Locker', sqftFrom: 8, sqftTo: 15, sortOrder: 0 } });
  const xs = await prisma.unitSize.create({ data: { code: 'XS', name: 'XS', sqftFrom: 10, sqftTo: 19, sortOrder: 1 } });
  const small = await prisma.unitSize.create({ data: { code: 'SMALL', name: 'Small', sqftFrom: 20, sqftTo: 39, sortOrder: 2 } });
  const medium = await prisma.unitSize.create({ data: { code: 'MEDIUM', name: 'Medium', sqftFrom: 40, sqftTo: 69, sortOrder: 3 } });
  const xlbiz = await prisma.unitSize.create({ data: { code: 'XLBIZ', name: 'XL', sqftFrom: 100, sqftTo: 150, sortOrder: 5 } });

  async function unit(unitCode: string, sizeId: string, floorId: string, sqft: number, status: 'AVAILABLE' | 'OCCUPIED' | 'RESERVED', rate: number, rateSource = 'LEGACY') {
    return prisma.unit.create({
      data: { branchId: branch.id, floorId, sizeId, unitCode, sqft, status, monthlyRate: new Prisma.Decimal(rate), rateSource, climateControl: 'Ambient climate' },
    });
  }

  // U01 10 XS AVAILABLE LEGACY · U02 12 LOCKER AVAILABLE MANUAL ·
  // U03 40 MEDIUM AVAILABLE LEGACY · U04 50 MEDIUM OCCUPIED LEGACY ·
  // U05 160 XL AVAILABLE LEGACY (above the 150 commercial window, D13) ·
  // U06 25 SMALL RESERVED LEGACY (vacant != AVAILABLE, R17).
  await unit('RS-U01', xs.id, l1.id, 10, 'AVAILABLE', 100);
  const u02 = await unit('RS-U02', locker.id, l1.id, 12, 'AVAILABLE', 90, 'MANUAL');
  await prisma.rateChange.create({
    data: { unitId: u02.id, date: new Date(), previous: new Prisma.Decimal(95), current: new Prisma.Decimal(90), changePct: -5.3, reason: 'Operator retier', appliedBy: 'Operator' },
  });
  await unit('RS-U03', medium.id, l2.id, 40, 'AVAILABLE', 270);
  const u04 = await unit('RS-U04', medium.id, l1.id, 50, 'OCCUPIED', 300);
  const tenant = await prisma.tenant.create({
    data: { name: 'E2E Renter', email: 'renter@e2e.test', unitId: u04.id, branchId: branch.id, monthlyRate: new Prisma.Decimal(300), psf: new Prisma.Decimal(6), status: 'ACTIVE' },
  });
  await unit('RS-U05', xlbiz.id, l2.id, 160, 'AVAILABLE', 400);
  await unit('RS-U06', small.id, l1.id, 25, 'RESERVED', 150);

  // CURRENT (approved) FinancialModel — the read-only benchmark.
  const model = await createModel({ name: 'RS launch', branchId: branch.id, actor: 'e2e' });
  await prisma.financialModel.update({ where: { id: model.id }, data: { status: 'CURRENT' } });
  const stored = await prisma.financialModel.findUniqueOrThrow({ where: { id: model.id } });
  const targetPsf = projectModel(stored.inputs as never).kpis.weightedStartPsf;

  // Read-only promotion library: ACTIVE percentage + ACTIVE free-months +
  // a DRAFT percentage plan (preview-only).
  const pct = await prisma.promotionPlan.create({
    data: {
      kind: 'DISCOUNT_MATRIX', name: 'Longer Stay E2E', status: 'ACTIVE',
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
      kind: 'FREE_MONTHS', name: 'Stay 12 Pay 10 E2E', status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      facilityScope: ['ALL'], sizeScope: [medium.id],
      freeMonthCount: 2, commitmentMonths: 12,
    },
  });
  const draftPlan = await prisma.promotionPlan.create({
    data: {
      kind: 'DISCOUNT_MATRIX', name: 'FESTIVE25 E2E', status: 'DRAFT',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      facilityScope: ['ALL'], sizeScope: ['ALL'],
      matrixCells: {
        create: [{ sizeCategory: 'XS', accessType: 'Standard', commitmentMonths: 12, discountPct: new Prisma.Decimal(25) }],
      },
    },
  });

  return { ownerA, ownerB, manager, branchId: branch.id, branchCode: branch.code, tenantId: tenant.id, pctPlanId: pct.id, freePlanId: free.id, draftPlanId: draftPlan.id, targetPsf };
}

async function createDraft(world: World, actor: Operator, over: Record<string, unknown> = {}) {
  return api.post(`${CMS}/facilities/${world.branchId}/rate-strategy`).set('Authorization', actor.auth).send({
    name: 'RS Sembawang',
    levers: LEvers,
    effectiveFrom: sgDate(0),
    promotionPreview: { durationMonths: 12, matrix: 'Standard', planIds: [world.pctPlanId, world.freePlanId] },
    ...over,
  });
}

describe('rate strategy service (scenario E steps 4–7)', () => {
  let world: World;

  beforeEach(async () => {
    await resetDb();
    world = await seedWorld();
  });

  it('draft → preview → validate → submit-with-override → approve → batch apply', async () => {
    // --- draft ---
    const draft = await createDraft(world, world.ownerA);
    expect(draft.status).toBe(201);
    expect(draft.body.data.status).toBe('DRAFT');
    expect(draft.body.data.versionNo).toBe(1);
    expect(draft.body.data.version).toBe(0);
    const versionId = draft.body.data.id as string;
    expect(draft.body.data.previewSelection.planRefs.map((r: { planId: string }) => r.planId).sort())
      .toEqual([world.freePlanId, world.pctPlanId].sort());

    // --- preview (hand-derived: 10 sq ft 90.00/49.50; 40 sq ft 273.00/158.34/131.95) ---
    const preview = await api.get(`${CMS}/rate-strategy/${versionId}/preview`).set('Authorization', world.ownerA.auth);
    expect(preview.status).toBe(200);
    const rows = preview.body.data.preview.rows as Array<Record<string, number & string>>;
    const at = (size: number) => rows.find((r) => (r.size as number) === size)!;
    expect(at(10).rackMonthly).toBe(90);
    expect(at(10).effectiveMonthly).toBe(49.5);
    expect(at(10).effectivePsf).toBe(4.95);
    expect(at(10).freeMonths).toBe(0);
    expect(at(40).rackMonthly).toBe(273);
    expect(at(40).effectiveMonthly).toBe(158.34);
    expect(at(40).freeMonths).toBe(2);
    expect(at(40).blendedMonthly).toBe(131.95);
    // Target variance uses recurring Effective PSF, never Blended (§15.18).
    expect(at(40).gapVsTarget).toBeCloseTo(3.9585 - world.targetPsf, 4);
    expect(preview.body.data.target.targetPsf).toBe(world.targetPsf);
    expect(preview.body.data.preview.summary.hasBlended).toBe(true);
    // D11: the selection echoes planId + planVersion.
    const refs = preview.body.data.previewSelection.planRefs as Array<{ planId: string; planVersion: number; status: string }>;
    expect(refs.find((r) => r.planId === world.pctPlanId)).toMatchObject({ planVersion: 1, status: 'ACTIVE' });

    // --- validate: blockers empty, warnings reasoned ---
    const validated = await api.post(`${CMS}/rate-strategy/${versionId}/validate`).set('Authorization', world.ownerA.auth).send({});
    expect(validated.status).toBe(200);
    expect(validated.body.data.blockers).toEqual([]);
    expect(validated.body.data.warnings.length).toBeGreaterThan(0);
    for (const w of validated.body.data.warnings as Array<{ reason: string }>) {
      expect(w.reason.trim().length).toBeGreaterThan(0);
    }
    expect((validated.body.data.warnings as Array<{ code: string }>).map((w) => w.code)).toContain('SIZE_ABOVE_RANGE');
    // B-11: Passed list carries human-readable labels, never raw codes.
    for (const p of validated.body.data.passed as Array<{ code: string; message: string }>) {
      expect(p.message.trim().length).toBeGreaterThan(0);
      expect(p.message).not.toBe(p.code);
    }
    expect((validated.body.data.passed as Array<{ code: string }>).map((p) => p.code)).toContain('HAS_INVENTORY');
    expect((validated.body.data.passed as Array<{ code: string; message: string }>).find((p) => p.code === 'HAS_INVENTORY')!.message)
      .toBe('Facility sizes are linked.');

    // --- submit without override → rejected; with reasons → pending ---
    const noOverride = await api.post(`${CMS}/rate-strategy/${versionId}/submit`)
      .set('Authorization', world.ownerA.auth).send({ version: 0 });
    expect(noOverride.status).toBe(409);
    expect(noOverride.body.error.code).toBe('WARNING_OVERRIDE_REQUIRED');

    const submitted = await api.post(`${CMS}/rate-strategy/${versionId}/submit`)
      .set('Authorization', world.ownerA.auth).send({
        version: 0,
        warningOverride: { reasons: validated.body.data.warnings.map(() => 'Accepted for launch pricing review.'), note: 'Launch' },
      });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('PENDING_APPROVAL');
    expect(submitted.body.data.submittedBy).toBe(world.ownerA.email);
    expect(submitted.body.data.financialModel.targetPsf).toBe(world.targetPsf);

    // --- approved-but-unsaved-changes: mutate after submit → 409 ---
    const mutate = await api.patch(`${CMS}/rate-strategy/${versionId}`)
      .set('Authorization', world.ownerA.auth).send({ version: 1, levers: { startingRate: 95 } });
    expect(mutate.status).toBe(409);

    // --- maker-checker: submitter cannot approve their own version ---
    const selfApprove = await api.post(`${CMS}/rate-strategy/${versionId}/approve`)
      .set('Authorization', world.ownerA.auth).send({ version: 1 });
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('SELF_APPROVAL');
    const managerApprove = await api.post(`${CMS}/rate-strategy/${versionId}/approve`)
      .set('Authorization', world.manager.auth).send({ version: 1 });
    expect(managerApprove.status).toBe(403);

    const approved = await api.post(`${CMS}/rate-strategy/${versionId}/approve`)
      .set('Authorization', world.ownerB.auth).send({ version: 1, comment: 'Reviewed.' });
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');
    expect(approved.body.data.version).toBe(2);

    // --- batch apply (R17): vacant AVAILABLE only, MANUAL preserved, occupied skipped ---
    const rentBefore = Number((await prisma.tenant.findUniqueOrThrow({ where: { id: world.tenantId } })).monthlyRate);
    expect(rentBefore).toBe(300);
    const batch = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(0), conflictRule: 'PRESERVE_MANUAL' });
    expect(batch.status).toBe(201);
    expect(batch.body.data.status).toBe('APPLIED');
    expect(batch.body.data.summary).toMatchObject({ applied: 3, preservedManual: 1, skippedOccupied: 2, failed: 0, pending: 0 });
    const lineFor = (code: string) => (batch.body.data.lines as Array<Record<string, unknown>>).find((l) => l.unitCode === code)!;
    // RS-U01 sits on the ground floor (Level 1 = branch minimum): 90 × 1.10.
    expect(lineFor('RS-U01')).toMatchObject({ outcome: 'APPLIED', previousRack: 100, proposedRack: 99 });
    expect(lineFor('RS-U02')).toMatchObject({ outcome: 'PRESERVED_MANUAL' });
    expect(lineFor('RS-U03')).toMatchObject({ outcome: 'APPLIED', previousRack: 270, proposedRack: 273 });
    expect(lineFor('RS-U04')).toMatchObject({ outcome: 'SKIPPED_OCCUPIED' });
    expect(lineFor('RS-U05')).toMatchObject({ outcome: 'APPLIED', previousRack: 400, proposedRack: 827 });
    expect(lineFor('RS-U06')).toMatchObject({ outcome: 'SKIPPED_OCCUPIED' });
    // LEGACY split is listed separately (R16): the three applied units were LEGACY.
    expect([...(batch.body.data.legacyUnits as string[])].sort()).toEqual(['RS-U01', 'RS-U03', 'RS-U05']);

    // Occupied-tenant-rent-unchanged proof: Tenant.monthlyRate identical pre/post.
    const rentAfter = Number((await prisma.tenant.findUniqueOrThrow({ where: { id: world.tenantId } })).monthlyRate);
    expect(rentAfter).toBe(rentBefore);
    // Unit writes + provenance: applied units take STRATEGY; manual stays MANUAL at 90.
    const u01 = await prisma.unit.findFirstOrThrow({ where: { unitCode: 'RS-U01' } });
    const u02 = await prisma.unit.findFirstOrThrow({ where: { unitCode: 'RS-U02' } });
    expect(Number(u01.monthlyRate)).toBe(99);
    expect(u01.rateSource).toBe('STRATEGY');
    expect(Number(u02.monthlyRate)).toBe(90);
    expect(u02.rateSource).toBe('MANUAL');
    const changes = await prisma.rateChange.findMany({ where: { unitId: { in: [u01.id, u02.id] } } });
    expect(changes.filter((c) => c.unitId === u01.id).length).toBeGreaterThanOrEqual(1);
    expect(changes.filter((c) => c.unitId === u02.id && c.appliedBy === world.ownerB.email).length).toBe(0);

    // --- idempotent batch replay: apply twice → first result replayed ---
    const replay = await api.post(`${CMS}/rate-batches/${batch.body.data.id}/apply`)
      .set('Authorization', world.ownerB.auth).send({});
    expect(replay.status).toBe(200);
    expect(replay.body.meta).toMatchObject({ replayed: true });
    expect(replay.body.data.lines).toEqual(batch.body.data.lines);

    // --- audit + events (§18) ---
    const audits = await prisma.financeAuditEvent.findMany({ where: { entityType: 'rate-strategy', entityId: versionId } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['RATE_STRATEGY_SUBMITTED', 'RATE_STRATEGY_APPROVED']));
    const events = await prisma.financeEvent.findMany({ where: { type: { in: ['rate.strategy.submitted', 'rate.strategy.approved', 'rate.batch.created', 'rate.batch.applied'] } } });
    expect(events.length).toBeGreaterThanOrEqual(4);
  });

  it('stale-submit, self-approval, replace-manual Owner gate and cancel rules', async () => {
    const draft = await createDraft(world, world.ownerA);
    const versionId = draft.body.data.id as string;

    // Stale version → 409 STALE.
    const stale = await api.post(`${CMS}/rate-strategy/${versionId}/submit`)
      .set('Authorization', world.ownerA.auth).send({ version: 999, warningOverride: { reasons: ['x'] } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE');

    // Non-approval-role operator cannot drive the workflow past drafts.
    const mgrValidated = await api.post(`${CMS}/rate-strategy/${versionId}/validate`).set('Authorization', world.manager.auth).send({});
    const mgrSubmit = await api.post(`${CMS}/rate-strategy/${versionId}/submit`)
      .set('Authorization', world.manager.auth).send({ version: 0, warningOverride: { reasons: mgrValidated.body.data.warnings.map(() => 'Accepted by manager.') } });
    // Manager holds update: submit succeeds — approval is the segregated step.
    expect(mgrSubmit.status).toBe(200);

    // Manager cannot approve (no approve grant).
    const mgrApprove = await api.post(`${CMS}/rate-strategy/${versionId}/approve`)
      .set('Authorization', world.manager.auth).send({ version: 1 });
    expect(mgrApprove.status).toBe(403);

    // But the submitter still cannot self-approve (maker-checker, not just RBAC).
    const selfApprove = await api.post(`${CMS}/rate-strategy/${versionId}/approve`)
      .set('Authorization', world.manager.auth).send({ version: 1 });
    expect(selfApprove.status).toBe(403);

    // Second approver approves the manager-submitted version.
    const approved = await api.post(`${CMS}/rate-strategy/${versionId}/approve`)
      .set('Authorization', world.ownerB.auth).send({ version: 1 });
    expect(approved.status).toBe(200);

    // REPLACE_MANUAL requires the Owner role (D9): a non-owner with approve +
    // units:update still gets 403 from the service check.
    const roleRes = await api.post(`${CMS}/roles`).set('Authorization', world.ownerA.auth).send({
      name: 'Rate publisher E2E',
      permissions: ['facility-rate-strategy:view', 'facility-rate-strategy:approve', 'facility-units:update'],
    });
    expect(roleRes.status).toBe(201);
    const publisher = await createOperator(roleRes.body.data.key);
    const replaceDenied = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', publisher.auth).send({ effectiveDate: sgDate(0), conflictRule: 'REPLACE_MANUAL' });
    expect(replaceDenied.status).toBe(403);

    // Owner REPLACE_MANUAL overwrites the manual unit (B-9 §15.9 order:
    // S$104.13 base × 0.75 = 7810 → × 1.10 = S$85.91 → S$1 → S$86.00).
    const replace = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(0), conflictRule: 'REPLACE_MANUAL' });
    expect(replace.status).toBe(201);
    const u02line = (replace.body.data.lines as Array<Record<string, unknown>>).find((l) => l.unitCode === 'RS-U02')!;
    expect(u02line).toMatchObject({ outcome: 'APPLIED', proposedRack: 86 });
    const u02 = await prisma.unit.findFirstOrThrow({ where: { unitCode: 'RS-U02' } });
    expect(Number(u02.monthlyRate)).toBe(86);
    expect(u02.rateSource).toBe('STRATEGY');

    // Cancel rules: cancelling an APPLIED batch → 409; without reason → 400.
    const cancelApplied = await api.post(`${CMS}/rate-batches/${replace.body.data.id}/cancel`)
      .set('Authorization', world.ownerB.auth).send({ reason: 'Too late.' });
    expect(cancelApplied.status).toBe(409);
    const future = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(7), conflictRule: 'PRESERVE_MANUAL' });
    expect(future.status).toBe(201);
    expect(future.body.data.status).toBe('SCHEDULED');
    const cancelNoReason = await api.post(`${CMS}/rate-batches/${future.body.data.id}/cancel`)
      .set('Authorization', world.ownerB.auth).send({});
    expect(cancelNoReason.status).toBe(400);
    const cancelled = await api.post(`${CMS}/rate-batches/${future.body.data.id}/cancel`)
      .set('Authorization', world.ownerB.auth).send({ reason: 'Superseded by newer plan.' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
  });

  it('future-dated batch is Scheduled until applyDueBatches picks it up when due', async () => {
    const draft = await createDraft(world, world.ownerA);
    const versionId = draft.body.data.id as string;
    const validated = await api.post(`${CMS}/rate-strategy/${versionId}/validate`).set('Authorization', world.ownerA.auth).send({});
    await api.post(`${CMS}/rate-strategy/${versionId}/submit`).set('Authorization', world.ownerA.auth).send({
      version: 0, warningOverride: { reasons: validated.body.data.warnings.map(() => 'Accepted.') },
    });
    await api.post(`${CMS}/rate-strategy/${versionId}/approve`).set('Authorization', world.ownerB.auth).send({ version: 1 });

    const future = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(3), conflictRule: 'PRESERVE_MANUAL' });
    expect(future.status).toBe(201);
    expect(future.body.data.status).toBe('SCHEDULED');
    expect(future.body.data.summary.pending).toBe(6);

    // Applying before the effective date → 409 NOT_DUE, nothing written.
    const early = await api.post(`${CMS}/rate-batches/${future.body.data.id}/apply`)
      .set('Authorization', world.ownerB.auth).send({});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('NOT_DUE');

    // The sweep is safe to repeat while nothing is due.
    const sweepEmpty = await api.post(`${CMS}/units/rate-batches/apply-due`)
      .set('Authorization', world.ownerB.auth).send({});
    expect(sweepEmpty.status).toBe(200);
    expect(sweepEmpty.body.data.results.find((r: { batchId: string }) => r.batchId === future.body.data.id))
      .toMatchObject({ status: 'SCHEDULED', skipped: 'not-due' });

    // Simulate the date arriving, then sweep: the batch applies.
    await prisma.unitRateBatch.update({ where: { id: future.body.data.id }, data: { effectiveDate: new Date(`${sgDate(0)}T00:00:00.000Z`) } });
    const sweep = await api.post(`${CMS}/units/rate-batches/apply-due`)
      .set('Authorization', world.ownerB.auth).send({});
    expect(sweep.status).toBe(200);
    const applied = sweep.body.data.results.find((r: { batchId: string }) => r.batchId === future.body.data.id);
    expect(applied.status).toBe('APPLIED');
    expect(applied.summary.applied).toBe(3);

    // Repeating the sweep never double-applies.
    const again = await api.post(`${CMS}/units/rate-batches/apply-due`)
      .set('Authorization', world.ownerB.auth).send({});
    expect(again.status).toBe(200);
    const u01changes = await prisma.rateChange.count({ where: { unit: { unitCode: 'RS-U01' }, appliedBy: world.ownerB.email } });
    expect(u01changes).toBe(1);
  });

  it('warning-without-reason is rejected; below-target never blocks (D12)', async () => {
    // Deep below target: startingRate 10 anchors every size far under target.
    const draft = await createDraft(world, world.ownerA, { levers: { ...LEvers, startingRate: 10 } });
    const versionId = draft.body.data.id as string;
    const validated = await api.post(`${CMS}/rate-strategy/${versionId}/validate`).set('Authorization', world.ownerA.auth).send({});
    expect(validated.status).toBe(200);
    expect(validated.body.data.blockers).toEqual([]);
    const below = (validated.body.data.warnings as Array<{ code: string }>).find((w) => w.code === 'BELOW_TARGET')!;
    expect(below).toBeDefined();

    // No override → 409; blank reasons → 409; real reasons → submits (D12: any magnitude).
    const none = await api.post(`${CMS}/rate-strategy/${versionId}/submit`)
      .set('Authorization', world.ownerA.auth).send({ version: 0 });
    expect(none.status).toBe(409);
    const blank = await api.post(`${CMS}/rate-strategy/${versionId}/submit`)
      .set('Authorization', world.ownerA.auth).send({ version: 0, warningOverride: { reasons: ['  '] } });
    expect(blank.status).toBe(409);
    const okSubmit = await api.post(`${CMS}/rate-strategy/${versionId}/submit`)
      .set('Authorization', world.ownerA.auth).send({
        version: 0, warningOverride: { reasons: validated.body.data.warnings.map(() => 'Deliberately below target for the E2E.') },
      });
    expect(okSubmit.status).toBe(200);
    expect(okSubmit.body.data.status).toBe('PENDING_APPROVAL');
  });

  it('no CURRENT model: preview returns rack-only with target unavailable; submit still blocks', async () => {
    // A facility with no approved model: preview/validate return the rack
    // schedule with target/promo marked unavailable (B-6); only submit
    // BLOCKS with NO_CURRENT_MODEL.
    const branch = await prisma.branch.create({ data: { code: 'RN', name: 'No model (E2E)', address: 'E2E', operatingHours: '9am – 9pm daily' } });
    const floor = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'Level 1' } });
    const size = await prisma.unitSize.findFirstOrThrow();
    await prisma.unit.create({
      data: { branchId: branch.id, floorId: floor.id, sizeId: size.id, unitCode: 'RN-U01', sqft: 10, status: 'AVAILABLE', monthlyRate: new Prisma.Decimal(100) },
    });
    const draft = await api.post(`${CMS}/facilities/${branch.id}/rate-strategy`).set('Authorization', world.ownerA.auth).send({ name: 'No model' });
    expect(draft.status).toBe(201);
    // B-6: preview is 200 with the rack schedule + noTarget flag; the
    // target and promotion/effective/blended outcomes are unavailable.
    const rackOnly = await api.get(`${CMS}/rate-strategy/${draft.body.data.id}/preview`).set('Authorization', world.ownerA.auth);
    expect(rackOnly.status).toBe(200);
    expect(rackOnly.body.data.noTarget).toBe(true);
    expect(rackOnly.body.data.target).toBeNull();
    expect(rackOnly.body.data.targetUnavailable).toBe(true);
    const rows = rackOnly.body.data.preview.rows as Array<{ size: number; rackMonthly: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.find((r) => r.size === 10)?.rackMonthly).toBeGreaterThan(0);
    expect(rackOnly.body.data.preview.summary.targetPsf).toBeNull();
    expect(rackOnly.body.data.preview.summary.gapVsTarget).toBeNull();
    expect(rackOnly.body.data.previewSelection.planRefs).toEqual([]);
    const noTargetCodes = (rackOnly.body.data.preview.validation.warnings as Array<{ code: string }>).map((w) => w.code);
    expect(noTargetCodes).toContain('TARGET_UNAVAILABLE');
    // Validate stays read-only (200); submit still 409s.
    const validated = await api.post(`${CMS}/rate-strategy/${draft.body.data.id}/validate`).set('Authorization', world.ownerA.auth).send({});
    expect(validated.status).toBe(200);
    const submit = await api.post(`${CMS}/rate-strategy/${draft.body.data.id}/submit`).set('Authorization', world.ownerA.auth).send({ version: 0 });
    expect(submit.status).toBe(409);
    expect(submit.body.error.code).toBe('NO_CURRENT_MODEL');

    // DRAFT promotion selected explicitly: preview works, flagged preview-only.
    const withDraftPromo = await createDraft(world, world.ownerA, {
      name: 'RS with draft promo',
      promotionPreview: { durationMonths: 12, matrix: 'Standard', planIds: [world.pctPlanId, world.draftPlanId] },
    });
    expect(withDraftPromo.status).toBe(201);
    const preview = await api.get(`${CMS}/rate-strategy/${withDraftPromo.body.data.id}/preview`).set('Authorization', world.ownerA.auth);
    expect(preview.status).toBe(200);
    const codes = (preview.body.data.preview.validation.warnings as Array<{ code: string }>).map((w) => w.code);
    expect(codes).toContain('DRAFT_PROMO_PREVIEW');
    // Selecting it never activates it.
    expect((await prisma.promotionPlan.findUniqueOrThrow({ where: { id: world.draftPlanId } })).status).toBe('DRAFT');
  });

  it('unsaved-levers preview recalculates read-only without touching the draft (B-4)', async () => {
    const draft = await createDraft(world, world.ownerA);
    expect(draft.status).toBe(201);
    const versionId = draft.body.data.id as string;
    const at = (rows: Array<{ size: number; rackMonthly: number }>, size: number) =>
      rows.find((r) => r.size === size)!;

    const saved = await api.get(`${CMS}/rate-strategy/${versionId}/preview`).set('Authorization', world.ownerA.auth);
    expect(saved.status).toBe(200);
    expect(at(saved.body.data.preview.rows, 10).rackMonthly).toBe(90);

    // Unsaved startingRate 100 moves the anchor; the draft is untouched.
    const live = await api.post(`${CMS}/rate-strategy/${versionId}/preview`).set('Authorization', world.ownerA.auth)
      .send({ levers: { startingRate: 100 }, durationMonths: 12, matrix: 'Standard' });
    expect(live.status).toBe(200);
    expect(live.body.data.unsaved).toBe(true);
    expect(at(live.body.data.preview.rows, 10).rackMonthly).toBe(100);
    expect(live.body.data.target.targetPsf).toBe(world.targetPsf);

    const untouched = await api.get(`${CMS}/rate-strategy/${versionId}`).set('Authorization', world.ownerA.auth);
    expect(untouched.body.data.levers.startingRate).toBe(90);
    expect(untouched.body.data.version).toBe(0);

    // Invalid unsaved levers are rejected like PATCH, without a draft write.
    const bad = await api.post(`${CMS}/rate-strategy/${versionId}/preview`).set('Authorization', world.ownerA.auth)
      .send({ levers: { curveStrength: 5 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION');

    // Read-only consumers can live-preview too (view permission suffices).
    const ro = await api.post(`${CMS}/rate-strategy/${versionId}/preview`).set('Authorization', world.manager.auth)
      .send({ levers: { startingRate: 100 } });
    expect(ro.status).toBe(200);
  });

  it('library list/load and duplicate reset to v1 DRAFT with uplift', async () => {
    const draft = await createDraft(world, world.ownerA);
    const versionId = draft.body.data.id as string;

    const library = await api.get(`${CMS}/rate-strategy/library?branchId=${world.branchId}`).set('Authorization', world.manager.auth);
    expect(library.status).toBe(200);
    expect(library.body.data.map((c: { versionId: string }) => c.versionId)).toContain(versionId);
    const empty = await api.get(`${CMS}/rate-strategy/library?status=REJECTED`).set('Authorization', world.manager.auth);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);

    const detail = await api.get(`${CMS}/rate-strategy/${versionId}`).set('Authorization', world.manager.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.levers.startingRate).toBe(90);

    const dup = await api.post(`${CMS}/rate-strategy/${versionId}/duplicate`)
      .set('Authorization', world.ownerA.auth).send({ destinationBranchId: world.branchId, name: 'RS copy', upliftPct: 5 });
    expect(dup.status).toBe(201);
    expect(dup.body.data.versionNo).toBe(1);
    expect(dup.body.data.status).toBe('DRAFT');
    expect(dup.body.data.originVersionId).toBe(versionId);
    // Uplift applied to the anchor, floors, minimum and overrides — B-11:
    // every uplifted money field lands on the S$0.05 grid (half-up to the
    // nearest nickel). 6.50 x 1.05 = 6.825 -> S$6.85 (136.5 -> 137 / 20);
    // 4.20 x 1.05 = 4.41 -> S$4.40; 5.80 x 1.05 = 6.09 -> S$6.10.
    expect(dup.body.data.levers.startingRate).toBe(94.5);
    expect(dup.body.data.levers.psfFloor).toBe(4.4);
    expect(dup.body.data.levers.minMonthly).toBe(47.25);
    expect(dup.body.data.levers.categoryFloors.S).toBe(6.85);
    expect(dup.body.data.levers.categoryFloors.M).toBe(6.1);
    expect(dup.body.data.levers.categoryFloors.LOCKER).toBe(7.35);
    expect(dup.body.data.levers.categoryFloors.XL).toBe(4.4);
    // Every uplifted floor sits on the S$0.05 grid.
    for (const v of [
      dup.body.data.levers.psfFloor,
      dup.body.data.levers.minMonthly,
      dup.body.data.levers.startingRate,
      ...Object.values(dup.body.data.levers.categoryFloors as Record<string, number>),
    ]) {
      expect(Math.round((v as number) * 20) / 20).toBeCloseTo(v as number, 10);
    }
  });

  it('batch detail exposes per-unit lines; manager cannot touch batches', async () => {
    const draft = await createDraft(world, world.ownerA);
    const versionId = draft.body.data.id as string;
    const validated = await api.post(`${CMS}/rate-strategy/${versionId}/validate`).set('Authorization', world.ownerA.auth).send({});
    await api.post(`${CMS}/rate-strategy/${versionId}/submit`).set('Authorization', world.ownerA.auth).send({
      version: 0, warningOverride: { reasons: validated.body.data.warnings.map(() => 'Accepted.') },
    });
    await api.post(`${CMS}/rate-strategy/${versionId}/approve`).set('Authorization', world.ownerB.auth).send({ version: 1 });

    const denied = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.manager.auth).send({ effectiveDate: sgDate(0) });
    expect(denied.status).toBe(403);

    const future = await api.post(`${CMS}/rate-strategy/${versionId}/batches`)
      .set('Authorization', world.ownerB.auth).send({ effectiveDate: sgDate(5) });
    expect(future.status).toBe(201);
    const detail = await api.get(`${CMS}/rate-batches/${future.body.data.id}`).set('Authorization', world.manager.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.lines.length).toBe(6);
    expect(detail.body.data.lines.every((l: { outcome: string }) => l.outcome === 'PENDING')).toBe(true);
  });
});

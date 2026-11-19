// Track A A-12 — date-change before/after compare preview (handoff §8.7).
//
// GET /move-out-cases/:id/preview?finalAccessDate= reuses the case preview
// route with a date override: server-computed before/after (notice days,
// compliance, unused rent, settlement outcome + deltas), writes nothing.
// Confirm still goes through PATCH /:id/date (behaviour unchanged).

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, createOperator, prisma, resetDb, seedMoveInWorld, uniqueEmail, type Operator } from './fixtures';

const CMS = '/api/v1/cms';

const CHANNEL = 'WhatsApp';
const REASON = 'No longer needs storage';

interface World {
  branchId: string;
  floorId: string;
  sizeId: string;
}

async function seedWorld(): Promise<World> {
  await seedMoveInWorld();
  const branch = await prisma.branch.findUniqueOrThrow({ where: { code: PIN.branchCode } });
  const floor = await prisma.floor.findFirstOrThrow({ where: { branchId: branch.id } });
  const size = await prisma.unitSize.findFirstOrThrow();
  return { branchId: branch.id, floorId: floor.id, sizeId: size.id };
}

let unitSeq = 1000;
async function makeUnit(w: World, rate: number) {
  unitSeq += 1;
  return prisma.unit.create({
    data: {
      branchId: w.branchId,
      floorId: w.floorId,
      sizeId: w.sizeId,
      unitCode: `MV-DP-${unitSeq}`,
      sqft: 50,
      monthlyRate: rate,
      status: 'AVAILABLE',
      climateControl: 'Ambient climate',
    },
  });
}

async function makeTenant(w: World, unitId: string, rate: number) {
  return prisma.tenant.create({
    data: {
      name: 'E2E Date Preview',
      email: uniqueEmail(),
      mobile: '81234567',
      unitId,
      moveInDate: new Date('2026-09-14T00:00:00.000Z'),
      monthlyRate: rate,
      psf: rate / 50,
      status: 'ACTIVE',
      branchId: w.branchId,
    },
  });
}

async function recordCase(auth: string, body: Record<string, unknown>) {
  const res = await api.post(`${CMS}/move-out-cases`).set('Authorization', auth).send(body);
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('A-12 date-change before/after compare preview', () => {
  let w: World;
  let owner: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    owner = await createOperator('OWNER');
  });

  it('returns server-computed before/after with deltas and writes nothing', async () => {
    // Rent S$600, request 10 Oct, current final 15 Nov (30-day month):
    // before unused 15 → S$300.00; after 20 Nov → unused 10 → S$200.00.
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const res = await api
      .get(`${CMS}/move-out-cases/${c.id}/preview?finalAccessDate=2026-11-20`)
      .set('Authorization', owner.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      caseId: c.id,
      caseNumber: c.caseNumber,
      dateChangeAllowed: true,
      calcVersion: 1,
      before: {
        finalAccessDate: '2026-11-15',
        noticeDays: 36,
        noticeRequiredDays: 30,
        noticeCompliant: true,
        unusedRentRefund: 300,
        netSettlement: 300,
        outcome: 'REFUND',
      },
      after: {
        finalAccessDate: '2026-11-20',
        noticeDays: 41,
        noticeRequiredDays: 30,
        noticeCompliant: true,
        unusedRentRefund: 200,
        netSettlement: 200,
        outcome: 'REFUND',
      },
      deltas: { noticeDays: 5, unusedRentRefund: -100, netSettlement: -100 },
    });
    // Read-only: no version bump, no history row, date untouched.
    const fresh = await prisma.moveOutCase.findUniqueOrThrow({ where: { id: c.id } });
    expect(fresh.version).toBe(c.version);
    expect(fresh.finalAccessDate.toISOString().slice(0, 10)).toBe('2026-11-15');
    expect(await prisma.moveOutDateChange.count({ where: { caseId: c.id } })).toBe(0);
  });

  it('flags short-notice in the after side when the new date compresses notice', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const res = await api
      .get(`${CMS}/move-out-cases/${c.id}/preview?finalAccessDate=2026-10-20`)
      .set('Authorization', owner.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.after).toMatchObject({ noticeDays: 10, noticeCompliant: false });
    expect(res.body.data.before.noticeCompliant).toBe(true);
  });

  it('rejects a before-request date with 409 + copy', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const res = await api
      .get(`${CMS}/move-out-cases/${c.id}/preview?finalAccessDate=2026-10-05`)
      .set('Authorization', owner.auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(String(res.body.error.message)).toMatch(/before the request date/i);
  });

  it('rejects a malformed date with 400', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const res = await api
      .get(`${CMS}/move-out-cases/${c.id}/preview?finalAccessDate=not-a-date`)
      .set('Authorization', owner.auth);
    expect(res.status).toBe(400);
  });

  it('rejects the preview on a closed case with 409 + copy', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const rev = await api
      .post(`${CMS}/move-out-cases/${c.id}/reverse`)
      .set('Authorization', owner.auth)
      .send({ reason: 'Entered in error', expectedVersion: c.version });
    expect(rev.status).toBe(200);
    const res = await api
      .get(`${CMS}/move-out-cases/${c.id}/preview?finalAccessDate=2026-11-20`)
      .set('Authorization', owner.auth);
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toMatch(/can no longer change its date/i);
  });

  it('plain preview without the date override is unchanged', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const c = await recordCase(owner.auth, {
      tenantId: tenant.id,
      finalAccessDate: '2026-11-15',
      requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL,
      reasonCode: REASON,
    });
    const res = await api.get(`${CMS}/move-out-cases/${c.id}/preview`).set('Authorization', owner.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.calc).toMatchObject({ unusedRentRefund: 300, netSettlement: 300 });
    expect(res.body.data.before).toBeUndefined();
  });
});

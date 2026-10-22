// Portal Phase 4: change-request history + latest move-out notice per unit on
// GET /customer/portal (additive keys `requests` and `notices`).

import { beforeEach, describe, expect, it } from 'vitest';
import { parseCustomerRequestNote } from '../../src/core/customers';
import { PIN, api, prisma, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';

async function register(email: string): Promise<string> {
  const reg = await api.post('/api/v1/customer/register').send({
    name: 'E2E Portal History',
    email,
    mobile: '81234567',
    password: 'e2e-portal-history-1',
    type: 'PERSONAL',
  });
  expect(reg.status).toBe(201);
  return reg.body.data.token as string;
}

async function portal(token: string) {
  const res = await api.get('/api/v1/customer/portal').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.data as {
    requests: Array<Record<string, unknown>>;
    notices: Array<Record<string, unknown>>;
  };
}

describe('parseCustomerRequestNote', () => {
  it('splits type, preferred date, unit code and free notes', () => {
    expect(parseCustomerRequestNote('Request type: UPSIZE | Preferred date: 2026-11-01 | Unit SW-01-01 — need 60 sqft')).toEqual({
      type: 'UPSIZE',
      preferredDate: '2026-11-01',
      unitCode: 'SW-01-01',
      notes: 'need 60 sqft',
    });
    expect(parseCustomerRequestNote('Request type: TRANSFER | Unit 1001')).toEqual({
      type: 'TRANSFER',
      preferredDate: null,
      unitCode: '1001',
      notes: null,
    });
    expect(parseCustomerRequestNote('Request type: DOWNSIZE | free text only')).toEqual({
      type: 'DOWNSIZE',
      preferredDate: null,
      unitCode: null,
      notes: 'free text only',
    });
  });
});

describe('GET /portal requests[] + notices[]', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it("lists only this customer's requests, newest first, with customer-facing statuses", async () => {
    const email = uniqueEmail();
    const token = await register(email);
    const stranger = await register(uniqueEmail());

    const a = await api
      .post('/api/v1/customer/requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'UPSIZE', preferredDate: '2026-11-01', notes: `Unit ${PIN.rentableUnit} — bigger please` });
    expect(a.status).toBe(201);
    const b = await api
      .post('/api/v1/customer/requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'TRANSFER' });
    expect(b.status).toBe(201);
    await api.post('/api/v1/customer/requests').set('Authorization', `Bearer ${stranger}`).send({ type: 'DOWNSIZE' });
    // Legacy contact-less request row (pre-fix) can't be attributed → never shown.
    await prisma.lead.create({
      data: { name: 'E2E Portal History', source: 'WEBSITE', stage: 'NEW_ENQUIRY', note: 'Request type: UPSIZE' },
    });

    // Ops moved the first request along, then completed it.
    await prisma.lead.update({ where: { id: a.body.data.id }, data: { stage: 'WON' } });

    const { requests } = await portal(token);
    expect(requests.map((r) => r.id)).toEqual([b.body.data.id, a.body.data.id]);
    expect(requests[0]).toMatchObject({ type: 'TRANSFER', unitCode: null, status: 'RECEIVED' });
    expect(requests[1]).toMatchObject({
      type: 'UPSIZE',
      preferredDate: '2026-11-01',
      unitCode: PIN.rentableUnit,
      notes: 'bigger please',
      status: 'COMPLETED',
    });
    // Pipeline stage names never leak.
    expect(JSON.stringify(requests)).not.toMatch(/NEW_ENQUIRY|WON|PROPOSAL/);

    await prisma.lead.update({ where: { id: b.body.data.id }, data: { stage: 'CONTACTED' } });
    expect((await portal(token)).requests[0].status).toBe('IN_PROGRESS');
  });

  it('notices[] holds the latest notice per unit across every tenant row', async () => {
    const email = uniqueEmail();
    const token = await register(email);
    const branch = await prisma.branch.findUnique({ where: { code: PIN.branchCode } });
    const unitA = await prisma.unit.findUnique({ where: { unitCode: PIN.rentableUnit } });
    const unitB = await prisma.unit.findUnique({ where: { unitCode: PIN.guestUnit } });
    if (!branch || !unitA || !unitB) throw new Error('[e2e] world not seeded');
    for (const unit of [unitA, unitB]) {
      await prisma.tenant.create({
        data: {
          name: 'E2E Portal History',
          email,
          unitId: unit.id,
          moveInDate: new Date(),
          monthlyRate: 120,
          psf: 2.4,
          status: 'ACTIVE',
          branchId: branch.id,
        },
      });
    }
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
    const send = (unitId: string, lastDay: string) =>
      api.post('/api/v1/customer/notice').set('Authorization', `Bearer ${token}`).send({ unitId, lastDay });

    expect((await send(unitA.unitCode, day(30))).status).toBe(200);
    expect((await send(unitA.unitCode, day(45))).status).toBe(200); // superseding notice
    expect((await send(unitB.unitCode, day(60))).status).toBe(200); // second tenant row

    const { notices } = await portal(token);
    expect(notices).toHaveLength(2);
    const byUnit = new Map(notices.map((n) => [n.unitCode as string, n]));
    expect(new Date(byUnit.get(unitA.unitCode)!.lastDay as string).toISOString().slice(0, 10)).toBe(day(45).slice(0, 10));
    expect(new Date(byUnit.get(unitB.unitCode)!.lastDay as string).toISOString().slice(0, 10)).toBe(day(60).slice(0, 10));
    expect(byUnit.get(unitA.unitCode)).toMatchObject({ status: 'SUBMITTED' });
  });
});

// CMS facility scope (2026-10-27): an operator limited to some facilities
// only sees and changes those facilities' data, on every CMS route, via the
// Prisma query extension (lib/facilityScope.ts). Owners and operators with
// no facility rows see everything; records with no facility stay visible.
import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, createOperator, prisma, resetDb, seedMoveInWorld, type MoveInWorld } from './fixtures';
import { runScoped } from '../../src/lib/facilityScope';

const CMS = '/api/v1/cms';
const OTHER_UNIT = 'WD-E2E-01';

describe('facility scope', () => {
  let world: MoveInWorld;
  let other: { branchId: string; floorId: string; unitId: string };
  let leads: { sw: string; wd: string; none: string };

  beforeEach(async () => {
    await resetDb();
    world = await seedMoveInWorld();
    const size = await prisma.unitSize.findFirstOrThrow();
    const branch = await prisma.branch.create({ data: { code: 'WD', name: 'Woodlands (E2E)', address: 'Woodlands', operatingHours: '9am – 9pm daily' } });
    const floor = await prisma.floor.create({ data: { branchId: branch.id, level: 1, name: 'Level 1' } });
    const unit = await prisma.unit.create({
      data: { branchId: branch.id, floorId: floor.id, sizeId: size.id, unitCode: OTHER_UNIT, sqft: 50, monthlyRate: 99, status: 'AVAILABLE', climateControl: 'Ambient climate' },
    });
    other = { branchId: branch.id, floorId: floor.id, unitId: unit.id };
    leads = {
      sw: (await prisma.lead.create({ data: { name: 'SW lead', preferredBranchId: world.branchId } })).id,
      wd: (await prisma.lead.create({ data: { name: 'WD lead', preferredBranchId: branch.id } })).id,
      none: (await prisma.lead.create({ data: { name: 'No-site lead' } })).id,
    };
  });

  async function scopedManager() {
    const op = await createOperator('MANAGER');
    await prisma.operatorFacilityAccess.create({ data: { adminUserId: op.id, branchId: world.branchId, scope: 'FACILITY' } });
    return op;
  }

  it('lists only the operator\'s facilities', async () => {
    const op = await scopedManager();
    const branches = await api.get(`${CMS}/branches`).set('Authorization', op.auth);
    expect(branches.status).toBe(200);
    expect(JSON.stringify(branches.body.data)).toContain(PIN.branchCode);
    expect(JSON.stringify(branches.body.data)).not.toContain('"WD"');

    const units = await api.get(`${CMS}/units`).set('Authorization', op.auth);
    expect(units.status).toBe(200);
    expect(JSON.stringify(units.body)).toContain(PIN.rentableUnit);
    expect(JSON.stringify(units.body)).not.toContain(OTHER_UNIT);

    const me = await api.get(`${CMS}/me`).set('Authorization', op.auth);
    expect(me.body.data.branchIds).toEqual([world.branchId]);
  });

  it('treats another facility\'s records as not found', async () => {
    const op = await scopedManager();
    expect((await api.get(`${CMS}/units/${OTHER_UNIT}`).set('Authorization', op.auth)).status).toBe(404);
    expect((await api.get(`${CMS}/units/${PIN.rentableUnit}`).set('Authorization', op.auth)).status).toBe(200);
    expect((await api.get(`${CMS}/leads/${leads.wd}`).set('Authorization', op.auth)).status).toBe(404);
    expect((await api.get(`${CMS}/leads/${leads.sw}`).set('Authorization', op.auth)).status).toBe(200);
    // A lead with no preferred site stays visible to every facility.
    expect((await api.get(`${CMS}/leads/${leads.none}`).set('Authorization', op.auth)).status).toBe(200);
  });

  it('refuses writes to another facility', async () => {
    const op = await scopedManager();
    const edit = await api.put(`${CMS}/units/${OTHER_UNIT}`).set('Authorization', op.auth).send({ monthlyRate: 1 });
    expect([403, 404]).toContain(edit.status);
    expect(Number((await prisma.unit.findUniqueOrThrow({ where: { id: other.unitId } })).monthlyRate)).toBe(99);

    const del = await api.delete(`${CMS}/leads/${leads.wd}`).set('Authorization', op.auth);
    expect(del.status).toBe(403); // Manager cannot delete leads at all
    await expect(runScoped([world.branchId], async () => await prisma.lead.delete({ where: { id: leads.wd } }))).rejects.toThrow();
    expect(await prisma.lead.findUnique({ where: { id: leads.wd } })).not.toBeNull();

    await expect(runScoped([world.branchId], async () => await
      prisma.floor.create({ data: { branchId: other.branchId, level: 9, name: 'Sneaky' } }),
    )).rejects.toMatchObject({ status: 403 });
    // Moving an own unit into another facility is refused too.
    const mine = await prisma.unit.findUniqueOrThrow({ where: { unitCode: PIN.rentableUnit } });
    await expect(runScoped([world.branchId], async () => await
      prisma.unit.update({ where: { id: mine.id }, data: { branchId: other.branchId } }),
    )).rejects.toMatchObject({ status: 403 });
  });

  it('counts on the dashboard follow the scope', async () => {
    const all = await prisma.unit.count({ where: { deletedAt: null } });
    const scoped = await runScoped([world.branchId], async () => await prisma.unit.count({ where: { deletedAt: null } }));
    expect(scoped).toBe(all - 1);
  });

  it('Owners and unscoped operators see every facility', async () => {
    const owner = await createOperator('OWNER');
    await prisma.operatorFacilityAccess.create({ data: { adminUserId: owner.id, branchId: world.branchId, scope: 'FACILITY' } });
    const unscoped = await createOperator('MANAGER');
    for (const op of [owner, unscoped]) {
      const units = await api.get(`${CMS}/units`).set('Authorization', op.auth);
      expect(JSON.stringify(units.body)).toContain(OTHER_UNIT);
      expect((await api.get(`${CMS}/leads/${leads.wd}`).set('Authorization', op.auth)).status).toBe(200);
    }
  });

  it('a facility change applies on the next request', async () => {
    const owner = await createOperator('OWNER');
    const op = await scopedManager();
    expect((await api.get(`${CMS}/units/${OTHER_UNIT}`).set('Authorization', op.auth)).status).toBe(404);
    await api.put(`${CMS}/users/${op.id}/access`).set('Authorization', owner.auth).send({ access: [{ branchId: world.branchId }, { branchId: other.branchId }] });
    expect((await api.get(`${CMS}/units/${OTHER_UNIT}`).set('Authorization', op.auth)).status).toBe(200);
  });

  it('public booking API is never scoped', async () => {
    const res = await api.get('/api/v1/public/branches');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('WD');
  });
});

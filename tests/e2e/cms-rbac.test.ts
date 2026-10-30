// CMS RBAC (2026-10-27): sign-in + lockout, deny-by-default route table,
// per-role enforcement (reads included), Owner-only users/roles with guard
// rails, immediate role changes, password change signs out other sessions,
// audit trail.
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';
import cmsRouter from '../../src/routes/cms';
import { ROUTE_PERMISSIONS, listRouteKeys } from '../../src/lib/routePermissions';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from '../../src/lib/permissions';
import { signCustomerToken } from '../../src/middleware/auth';

const CMS = '/api/v1/cms';

describe('route permission table', () => {
  it('declares a permission for every CMS route', () => {
    const missing = listRouteKeys(cmsRouter).filter((k) => !(k in ROUTE_PERMISSIONS));
    expect(missing).toEqual([]);
  });

  it('only references permissions that exist in the catalog', () => {
    const specials = new Set(['PUBLIC', 'AUTH', 'OWNER']);
    const unknown = Object.entries(ROUTE_PERMISSIONS)
      .flatMap(([route, spec]) => (typeof spec === 'string' ? [spec] : [...spec]).map((p) => [route, p] as const))
      .filter(([, p]) => !specials.has(p) && !ALL_PERMISSIONS.includes(p));
    expect(unknown).toEqual([]);
  });

  it('seeds Manager and Viewer with catalog permissions only', () => {
    for (const r of SYSTEM_ROLES) expect(r.permissions.every((p) => ALL_PERMISSIONS.includes(p))).toBe(true);
  });
});

describe('sign-in', () => {
  beforeEach(resetDb);

  it('the old /config auto-login endpoint is gone', async () => {
    expect((await api.get(`${CMS}/config`)).status).toBe(404);
  });

  it('signs in with a real account and returns the role', async () => {
    const op = await createOperator('VIEWER');
    const res = await api.post(`${CMS}/login`).send({ email: op.email.toUpperCase(), password: op.password });
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('VIEWER');
    const me = await api.get(`${CMS}/me`).set('Authorization', `Bearer ${res.body.data.token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.role.key).toBe('VIEWER');
    expect(me.body.data.permissions).toContain('leads:view');
    expect(me.body.data.permissions).not.toContain('leads:create');
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const op = await createOperator('VIEWER');
    const a = await api.post(`${CMS}/login`).send({ email: 'nobody@e2e.test', password: 'whatever1' });
    const b = await api.post(`${CMS}/login`).send({ email: op.email, password: 'wrong-pass' });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('locks the account after 5 failures, even for the right password, until an Owner unlocks it', async () => {
    const owner = await createOperator('OWNER');
    const op = await createOperator('VIEWER');
    for (let i = 0; i < 4; i++) {
      expect((await api.post(`${CMS}/login`).send({ email: op.email, password: 'wrong-pass' })).status).toBe(401);
    }
    expect((await api.post(`${CMS}/login`).send({ email: op.email, password: 'wrong-pass' })).status).toBe(423);
    const locked = await api.post(`${CMS}/login`).send({ email: op.email, password: op.password });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('LOCKED');

    const unlock = await api.patch(`${CMS}/users/${op.id}`).set('Authorization', owner.auth).send({ unlock: true });
    expect(unlock.status).toBe(200);
    expect((await api.post(`${CMS}/login`).send({ email: op.email, password: op.password })).status).toBe(200);
  });

  it('rejects missing, garbage and customer tokens', async () => {
    expect((await api.get(`${CMS}/leads`)).status).toBe(401);
    expect((await api.get(`${CMS}/leads`).set('Authorization', 'Bearer nope')).status).toBe(401);
    const customer = signCustomerToken({ id: 'c1', email: 'c@e2e.test', name: 'C' });
    expect((await api.get(`${CMS}/leads`).set('Authorization', `Bearer ${customer}`)).status).toBe(401);
  });

  it('a deleted operator is signed out on the next request', async () => {
    const owner = await createOperator('OWNER');
    const op = await createOperator('MANAGER');
    expect((await api.get(`${CMS}/me`).set('Authorization', op.auth)).status).toBe(200);
    expect((await api.delete(`${CMS}/users/${op.id}`).set('Authorization', owner.auth)).status).toBe(200);
    expect((await api.get(`${CMS}/me`).set('Authorization', op.auth)).status).toBe(401);
  });

  it('changing your password signs out other sessions and returns a working token', async () => {
    const op = await createOperator('MANAGER');
    const bad = await api.post(`${CMS}/me/password`).set('Authorization', op.auth).send({ currentPassword: 'nope', newPassword: 'brand-new-pass' });
    expect(bad.status).toBe(400);
    const res = await api.post(`${CMS}/me/password`).set('Authorization', op.auth).send({ currentPassword: op.password, newPassword: 'brand-new-pass' });
    expect(res.status).toBe(200);
    expect((await api.get(`${CMS}/me`).set('Authorization', op.auth)).status).toBe(401);
    expect((await api.get(`${CMS}/me`).set('Authorization', `Bearer ${res.body.data.token}`)).status).toBe(200);
    expect((await api.post(`${CMS}/login`).send({ email: op.email, password: 'brand-new-pass' })).status).toBe(200);
  });
});

describe('role enforcement', () => {
  beforeEach(resetDb);

  it('Viewer reads but cannot write, and cannot see Finance or Team & access', async () => {
    const viewer = await createOperator('VIEWER');
    expect((await api.get(`${CMS}/leads`).set('Authorization', viewer.auth)).status).toBe(200);
    expect((await api.get(`${CMS}/branches`).set('Authorization', viewer.auth)).status).toBe(200);
    const write = await api.post(`${CMS}/leads`).set('Authorization', viewer.auth).send({});
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('FORBIDDEN');
    expect((await api.get(`${CMS}/invoices`).set('Authorization', viewer.auth)).status).toBe(403);
    expect((await api.get(`${CMS}/users`).set('Authorization', viewer.auth)).status).toBe(403);
  });

  it('Manager edits operations but not settings, approvals or lead deletes', async () => {
    const manager = await createOperator('MANAGER');
    const lead = await prisma.lead.create({ data: { name: 'L' } });
    expect((await api.delete(`${CMS}/leads/${lead.id}`).set('Authorization', manager.auth)).status).toBe(403);
    expect((await api.post(`${CMS}/fees`).set('Authorization', manager.auth).send({})).status).toBe(403);
    expect((await api.put(`${CMS}/business-rules`).set('Authorization', manager.auth).send({})).status).toBe(403);
    expect((await api.get(`${CMS}/roles`).set('Authorization', manager.auth)).status).toBe(403);
    // Allowed write: reaches the handler (validation answers, not the guard).
    const write = await api.post(`${CMS}/leads`).set('Authorization', manager.auth).send({});
    expect(write.status).not.toBe(403);
    expect((await api.get(`${CMS}/invoices`).set('Authorization', manager.auth)).status).toBe(200);
  });

  it('a role edit applies on the very next request (no re-login)', async () => {
    const owner = await createOperator('OWNER');
    const role = await api.post(`${CMS}/roles`).set('Authorization', owner.auth).send({ name: 'Front desk', permissions: ['leads:view'] });
    expect(role.status).toBe(201);
    expect(role.body.data.key).toBe('FRONT_DESK');
    const desk = await createOperator(role.body.data.id);
    expect((await api.get(`${CMS}/leads`).set('Authorization', desk.auth)).status).toBe(200);
    expect((await api.get(`${CMS}/tenants`).set('Authorization', desk.auth)).status).toBe(403);

    // create implies view
    const upd = await api.patch(`${CMS}/roles/${role.body.data.id}`).set('Authorization', owner.auth).send({ permissions: ['customer-tenants:create'] });
    expect(upd.status).toBe(200);
    expect(upd.body.data.permissions).toEqual(['customer-tenants:create', 'customer-tenants:view']);
    expect((await api.get(`${CMS}/tenants`).set('Authorization', desk.auth)).status).toBe(200);
    expect((await api.get(`${CMS}/leads`).set('Authorization', desk.auth)).status).toBe(403);
  });

  it('rejects unknown permissions, and edits or deletes of the Owner role', async () => {
    const owner = await createOperator('OWNER');
    const bad = await api.post(`${CMS}/roles`).set('Authorization', owner.auth).send({ name: 'X', permissions: ['leads:launch'] });
    expect(bad.status).toBe(400);
    const roles = (await api.get(`${CMS}/roles`).set('Authorization', owner.auth)).body.data as Array<{ id: string; key: string }>;
    const ownerRole = roles.find((r) => r.key === 'OWNER')!;
    expect((await api.patch(`${CMS}/roles/${ownerRole.id}`).set('Authorization', owner.auth).send({ name: 'Boss' })).status).toBe(409);
    expect((await api.delete(`${CMS}/roles/${ownerRole.id}`).set('Authorization', owner.auth)).status).toBe(409);
  });

  it('a role with users cannot be deleted', async () => {
    const owner = await createOperator('OWNER');
    const roles = (await api.get(`${CMS}/roles`).set('Authorization', owner.auth)).body.data as Array<{ id: string; key: string }>;
    await createOperator('VIEWER');
    const viewerRole = roles.find((r) => r.key === 'VIEWER')!;
    expect((await api.delete(`${CMS}/roles/${viewerRole.id}`).set('Authorization', owner.auth)).status).toBe(409);
  });

  it('approval is enforced in the core too (Manager cannot take a promotion live)', async () => {
    const { requirePermission } = await import('../../src/core/users');
    const manager = await createOperator('MANAGER');
    const owner = await createOperator('OWNER');
    await expect(requirePermission(manager.id, 'promo-library:approve')).rejects.toMatchObject({ status: 403 });
    await expect(requirePermission(owner.id, 'promo-library:approve')).resolves.toBeUndefined();
  });
});

describe('investor role (Finance Phase 5, spec §15.4)', () => {
  beforeEach(resetDb);

  it('sees only the masked summary — every other finance route is 403', async () => {
    const investor = await createOperator('INVESTOR');
    // No CURRENT baseline yet: the route is reachable (permission passes) and
    // the service answers 404, proving the guard is permission — not absence.
    expect((await api.get(`${CMS}/finance/investor/summary`).set('Authorization', investor.auth)).status).toBe(404);
    expect((await api.get(`${CMS}/finance/overview`).set('Authorization', investor.auth)).status).toBe(403);
    expect((await api.get(`${CMS}/finance/returns`).set('Authorization', investor.auth)).status).toBe(403);
    expect((await api.post(`${CMS}/finance/models`).set('Authorization', investor.auth).send({ name: 'X' })).status).toBe(403);
  });
});

describe('users guard rails + audit', () => {
  beforeEach(resetDb);

  it('keeps at least one Owner and blocks self-demotion / self-delete', async () => {
    const owner = await createOperator('OWNER');
    const roles = (await api.get(`${CMS}/roles`).set('Authorization', owner.auth)).body.data as Array<{ id: string; key: string }>;
    const viewerRoleId = roles.find((r) => r.key === 'VIEWER')!.id;
    expect((await api.patch(`${CMS}/users/${owner.id}`).set('Authorization', owner.auth).send({ roleId: viewerRoleId })).status).toBe(409);
    expect((await api.delete(`${CMS}/users/${owner.id}`).set('Authorization', owner.auth)).status).toBe(409);

    const second = await createOperator('OWNER');
    // Two owners: one may demote the other; the last one is protected again.
    expect((await api.patch(`${CMS}/users/${second.id}`).set('Authorization', owner.auth).send({ roleId: viewerRoleId })).status).toBe(200);
  });

  it('records role and user changes in the audit log', async () => {
    const owner = await createOperator('OWNER');
    const roles = (await api.get(`${CMS}/roles`).set('Authorization', owner.auth)).body.data as Array<{ id: string; key: string }>;
    const created = await api.post(`${CMS}/users`).set('Authorization', owner.auth)
      .send({ email: 'new.op@e2e.test', name: 'New Op', password: 'new-op-pass', roleId: roles.find((r) => r.key === 'VIEWER')!.id });
    expect(created.status).toBe(201);
    await api.patch(`${CMS}/users/${created.body.data.id}`).set('Authorization', owner.auth)
      .send({ roleId: roles.find((r) => r.key === 'MANAGER')!.id });
    await api.put(`${CMS}/users/${created.body.data.id}/access`).set('Authorization', owner.auth).send({ access: [{ scope: 'ALL' }] });

    const audit = await api.get(`${CMS}/permission-audit`).set('Authorization', owner.auth);
    expect(audit.status).toBe(200);
    const actions = (audit.body.data as Array<{ action: string; actorEmail: string }>).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['USER_CREATE', 'USER_UPDATE', 'USER_ACCESS']));
    const upd = (audit.body.data as Array<{ action: string; before: any; after: any; actorEmail: string }>).find((a) => a.action === 'USER_UPDATE')!;
    expect(upd).toMatchObject({ actorEmail: owner.email, before: { role: 'VIEWER' }, after: { role: 'MANAGER' } });
  });
});

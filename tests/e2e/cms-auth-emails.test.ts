// CMS auth emails (2026-10-28): invites, Owner reset links, self-service
// forgot password, one-time link rules, sign out everywhere. Emails are
// skipped under NODE_ENV=test, so Owner flows return the fallback link — the
// tests use it exactly as the operator would.
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';

const CMS = '/api/v1/cms';
const tokenOf = (link: string) => new URL(link).searchParams.get('auth') as string;

async function roleId(owner: { auth: string }, key: string): Promise<string> {
  const roles = (await api.get(`${CMS}/roles`).set('Authorization', owner.auth)).body.data as Array<{ id: string; key: string }>;
  return roles.find((r) => r.key === key)!.id;
}

describe('invites', () => {
  beforeEach(resetDb);

  it('invites by email; the operator sets a password from the link and is signed in', async () => {
    const owner = await createOperator('OWNER');
    const res = await api.post(`${CMS}/users`).set('Authorization', owner.auth)
      .send({ email: 'New.Op@e2e.test', name: 'New Op', roleId: await roleId(owner, 'VIEWER') });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('INVITED');
    expect(res.body.data.invite.sent).toBe(false); // test env: no SES
    const link: string = res.body.data.invite.link;
    expect(link).toMatch(/\/admin\?auth=/);

    // No password works before the invite is accepted.
    expect((await api.post(`${CMS}/login`).send({ email: 'new.op@e2e.test', password: 'anything-at-all' })).status).toBe(401);

    const info = await api.get(`${CMS}/auth/token`).query({ token: tokenOf(link) });
    expect(info.status).toBe(200);
    expect(info.body.data).toMatchObject({ kind: 'INVITE', email: 'new.op@e2e.test', name: 'New Op' });

    const set = await api.post(`${CMS}/auth/token`).send({ token: tokenOf(link), password: 'my-own-pass-1' });
    expect(set.status).toBe(200);
    const me = await api.get(`${CMS}/me`).set('Authorization', `Bearer ${set.body.data.token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.role.key).toBe('VIEWER');

    // Single use.
    const again = await api.post(`${CMS}/auth/token`).send({ token: tokenOf(link), password: 'another-pass-2' });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('LINK_INVALID');
    expect((await api.post(`${CMS}/login`).send({ email: 'new.op@e2e.test', password: 'my-own-pass-1' })).status).toBe(200);

    const users = (await api.get(`${CMS}/users`).set('Authorization', owner.auth)).body.data as Array<{ email: string; status: string }>;
    expect(users.find((u) => u.email === 'new.op@e2e.test')!.status).toBe('ACTIVE');
  });

  it('resending an invite replaces the old link', async () => {
    const owner = await createOperator('OWNER');
    const created = await api.post(`${CMS}/users`).set('Authorization', owner.auth)
      .send({ email: 'resend@e2e.test', name: 'Resend', roleId: await roleId(owner, 'MANAGER') });
    const first = tokenOf(created.body.data.invite.link);
    const resent = await api.post(`${CMS}/users/${created.body.data.id}/invite`).set('Authorization', owner.auth);
    expect(resent.status).toBe(200);
    expect((await api.get(`${CMS}/auth/token`).query({ token: first })).status).toBe(400);
    expect((await api.get(`${CMS}/auth/token`).query({ token: tokenOf(resent.body.data.link) })).status).toBe(200);
  });

  it('refuses mixed-up actions: reset for an invited operator, invite for an active one', async () => {
    const owner = await createOperator('OWNER');
    const active = await createOperator('VIEWER');
    const invited = await api.post(`${CMS}/users`).set('Authorization', owner.auth)
      .send({ email: 'pending@e2e.test', name: 'Pending', roleId: await roleId(owner, 'VIEWER') });
    expect((await api.post(`${CMS}/users/${invited.body.data.id}/reset-password`).set('Authorization', owner.auth)).status).toBe(409);
    expect((await api.post(`${CMS}/users/${active.id}/invite`).set('Authorization', owner.auth)).status).toBe(409);
  });

  it('only an Owner can invite or send links', async () => {
    const manager = await createOperator('MANAGER');
    const viewer = await createOperator('VIEWER');
    expect((await api.post(`${CMS}/users/${viewer.id}/reset-password`).set('Authorization', manager.auth)).status).toBe(403);
    expect((await api.post(`${CMS}/users`).set('Authorization', manager.auth).send({ email: 'x@e2e.test', name: 'X', roleId: 'role_viewer' })).status).toBe(403);
  });
});

describe('password resets', () => {
  beforeEach(resetDb);

  it('an Owner reset link sets a new password and signs out old sessions', async () => {
    const owner = await createOperator('OWNER');
    const op = await createOperator('MANAGER');
    const r = await api.post(`${CMS}/users/${op.id}/reset-password`).set('Authorization', owner.auth);
    expect(r.status).toBe(200);
    // Old password keeps working until the new one is set.
    expect((await api.post(`${CMS}/login`).send({ email: op.email, password: op.password })).status).toBe(200);
    expect((await api.get(`${CMS}/auth/token`).query({ token: tokenOf(r.body.data.link) })).body.data.kind).toBe('RESET');
    expect((await api.post(`${CMS}/auth/token`).send({ token: tokenOf(r.body.data.link), password: 'fresh-pass-99' })).status).toBe(200);
    expect((await api.get(`${CMS}/me`).set('Authorization', op.auth)).status).toBe(401);
    expect((await api.post(`${CMS}/login`).send({ email: op.email, password: op.password })).status).toBe(401);
    expect((await api.post(`${CMS}/login`).send({ email: op.email, password: 'fresh-pass-99' })).status).toBe(200);
  });

  it('a reset link also clears a lockout', async () => {
    const owner = await createOperator('OWNER');
    const op = await createOperator('VIEWER');
    await prisma.adminUser.update({ where: { id: op.id }, data: { lockedUntil: new Date(Date.now() + 600_000) } });
    const r = await api.post(`${CMS}/users/${op.id}/reset-password`).set('Authorization', owner.auth);
    await api.post(`${CMS}/auth/token`).send({ token: tokenOf(r.body.data.link), password: 'unlocked-pass-1' });
    expect((await api.post(`${CMS}/login`).send({ email: op.email, password: 'unlocked-pass-1' })).status).toBe(200);
  });

  it('forgot password answers the same for unknown and known emails, and throttles', async () => {
    const op = await createOperator('VIEWER');
    const unknown = await api.post(`${CMS}/auth/forgot`).send({ email: 'nobody@e2e.test' });
    const known = await api.post(`${CMS}/auth/forgot`).send({ email: op.email.toUpperCase() });
    expect([unknown.status, known.status]).toEqual([200, 200]);
    expect(unknown.body.data.message).toBe(known.body.data.message);
    for (let i = 0; i < 4; i++) await api.post(`${CMS}/auth/forgot`).send({ email: op.email });
    const rows = await prisma.adminAuthToken.findMany({ where: { adminUserId: op.id, kind: 'RESET' } });
    expect(rows).toHaveLength(3); // capped at 3 per hour
    expect(rows.filter((t) => !t.usedAt)).toHaveLength(1); // only the newest is live
    expect(rows.every((t) => t.tokenHash.length === 64)).toBe(true); // stored hashed
  });

  it('expired and garbage links are refused', async () => {
    const owner = await createOperator('OWNER');
    const op = await createOperator('VIEWER');
    const r = await api.post(`${CMS}/users/${op.id}/reset-password`).set('Authorization', owner.auth);
    await prisma.adminAuthToken.updateMany({ where: { adminUserId: op.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await api.post(`${CMS}/auth/token`).send({ token: tokenOf(r.body.data.link), password: 'too-late-pass' })).status).toBe(400);
    expect((await api.get(`${CMS}/auth/token`).query({ token: 'x'.repeat(43) })).status).toBe(400);
  });
});

describe('sessions + audit', () => {
  beforeEach(resetDb);

  it('sign out everywhere: by an Owner, or yourself', async () => {
    const owner = await createOperator('OWNER');
    const op = await createOperator('MANAGER');
    expect((await api.post(`${CMS}/users/${op.id}/sign-out`).set('Authorization', owner.auth)).status).toBe(200);
    expect((await api.get(`${CMS}/me`).set('Authorization', op.auth)).status).toBe(401);
    expect((await api.post(`${CMS}/login`).send({ email: op.email, password: op.password })).status).toBe(200);

    expect((await api.post(`${CMS}/me/sign-out-all`).set('Authorization', owner.auth)).status).toBe(200);
    expect((await api.get(`${CMS}/me`).set('Authorization', owner.auth)).status).toBe(401);
  });

  it('records invites, resets and sign-outs in the audit log', async () => {
    const owner = await createOperator('OWNER');
    const created = await api.post(`${CMS}/users`).set('Authorization', owner.auth)
      .send({ email: 'audit@e2e.test', name: 'Audit', roleId: await roleId(owner, 'VIEWER') });
    await api.post(`${CMS}/auth/token`).send({ token: tokenOf(created.body.data.invite.link), password: 'audit-pass-1' });
    await api.post(`${CMS}/users/${created.body.data.id}/reset-password`).set('Authorization', owner.auth);
    await api.post(`${CMS}/users/${created.body.data.id}/sign-out`).set('Authorization', owner.auth);
    const actions = ((await api.get(`${CMS}/permission-audit`).set('Authorization', owner.auth)).body.data as Array<{ action: string }>).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['USER_CREATE', 'USER_INVITE', 'INVITE_ACCEPTED', 'USER_RESET_LINK', 'USER_SIGN_OUT']));
  });
});

// Simplified Model library flow (owner 2026-11-07): create → save draft →
// load → Publish. Approvers publish a DRAFT (or a PENDING publish request) in
// one step; the previous published model on the facility is archived.

import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb } from './fixtures';
import { createModel } from '../../src/core/finance/models';

const CMS = '/api/v1/cms';

async function seedWorld() {
  // Full size taxonomy so the inventory-mapping gate passes.
  for (const [code, name, from, to, sort] of [
    ['LOCKER', 'Locker', 5, 25, 1], ['XS', 'XS', 10, 19, 1], ['SMALL', 'Small', 26, 60, 2], ['MEDIUM', 'Medium', 61, 110, 3],
    ['LARGE', 'Large', 111, 180, 4], ['XL', 'XL', 181, 320, 5],
  ] as const) {
    await prisma.unitSize.create({ data: { code, name, sqftFrom: from, sqftTo: to, sortOrder: sort } });
  }
  const branch = await prisma.branch.create({ data: { code: 'PB', name: 'Publish Bay', address: '1 Pub Rd', operatingHours: '9-9' } });
  return { branch };
}

describe('model library — publish', () => {
  beforeEach(resetDb);

  it('an approver publishes a draft in one step; the old published model is archived', async () => {
    const { branch } = await seedWorld();
    const owner = await createOperator('OWNER');
    const old = await createModel({ name: 'Old plan', branchId: branch.id, actor: 'test' });
    await prisma.financialModel.update({ where: { id: old.id }, data: { status: 'CURRENT' } });
    const draft = await createModel({ name: 'New plan', branchId: branch.id, actor: 'test' });

    const res = await api.post(`${CMS}/finance/library/${draft.id}/publish`).set('Authorization', owner.auth).send({ version: draft.version });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: draft.id, status: 'CURRENT' });
    expect((await prisma.financialModel.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('ARCHIVED');
    const audit = await prisma.financeAuditEvent.findFirst({ where: { entityId: draft.id, action: 'MODEL_PUBLISHED' } });
    expect(audit).toMatchObject({ actor: owner.email });

    // Already published → locked; stale version → conflict.
    expect((await api.post(`${CMS}/finance/library/${draft.id}/publish`).set('Authorization', owner.auth).send({ version: res.body.data.version })).status).toBe(403);
    const other = await createModel({ name: 'Third', branchId: branch.id, actor: 'test' });
    expect((await api.post(`${CMS}/finance/library/${other.id}/publish`).set('Authorization', owner.auth).send({ version: other.version + 5 })).status).toBe(409);
  });

  it('editors request publish (PENDING); only approvers can publish', async () => {
    const { branch } = await seedWorld();
    const op = await createOperator('FINANCE_OPERATOR');
    const approver = await createOperator('FINANCE_APPROVER');
    const draft = await createModel({ name: 'Requested', branchId: branch.id, actor: 'test' });

    expect((await api.post(`${CMS}/finance/library/${draft.id}/publish`).set('Authorization', op.auth).send({ version: draft.version })).status).toBe(403);
    const req = await api.post(`${CMS}/finance/library/${draft.id}/submit`).set('Authorization', op.auth).send({ version: draft.version, changeSummary: 'Publish requested' });
    expect(req.status).toBe(200);
    expect(req.body.data.status).toBe('PENDING');
    const pub = await api.post(`${CMS}/finance/library/${draft.id}/publish`).set('Authorization', approver.auth).send({ version: req.body.data.version });
    expect(pub.status).toBe(200);
    expect(pub.body.data.status).toBe('CURRENT');
  });

  it('publishes a model whose size-mix total differs from its NLA (planning edits allowed)', async () => {
    const { branch } = await seedWorld();
    const owner = await createOperator('OWNER');
    const draft = await createModel({ name: 'Planning edit', branchId: branch.id, actor: 'test' });
    const row = await prisma.financialModel.findUniqueOrThrow({ where: { id: draft.id } });
    const inputs = row.inputs as { nlaSqft: number };
    inputs.nlaSqft = 9999;
    await prisma.financialModel.update({ where: { id: draft.id }, data: { inputs: inputs as never } });
    const res = await api.post(`${CMS}/finance/library/${draft.id}/publish`).set('Authorization', owner.auth).send({ version: draft.version });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CURRENT');
  });
});

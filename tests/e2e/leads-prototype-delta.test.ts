// Leads prototype delta (2026-11-04 handover): lead identity + enquiry fields,
// enquiries under one identity, pipeline + SLA settings, notes with @mentions,
// the quotation register (QT-YYYY-#####, void, drafts) and appointment staff.

import { beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb, seedMoveInWorld } from './fixtures';

const CMS = '/api/v1/cms';

function sgToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

describe('lead identity and enquiries', () => {
  beforeEach(resetDb);

  it('creates SL-numbered leads with enquiry date, product, value and probability', async () => {
    const op = await createOperator('OWNER');
    const noRep = await api.post(`${CMS}/leads`).set('Authorization', op.auth)
      .send({ name: 'Northstar Commerce Pte Ltd', type: 'BUSINESS', companyName: 'Northstar Commerce Pte Ltd', uen: '202498877N', email: 'ops@northstar.test' });
    expect(noRep.status).toBe(400);
    expect(noRep.body.error.message).toMatch(/representative/);

    const res = await api.post(`${CMS}/leads`).set('Authorization', op.auth).send({
      name: 'Northstar Commerce Pte Ltd', type: 'BUSINESS', companyName: 'Northstar Commerce Pte Ltd', uen: '202498877N',
      representative: 'Jason Lee', email: 'ops@northstar.test', source: 'WALK_IN', monthlyRate: 320, accessFrequency: 'Not sure',
    });
    expect(res.status).toBe(201);
    const lead = res.body.data;
    expect(lead.displayId).toMatch(/^SL-\d{4,}$/);
    expect(lead).toMatchObject({
      representative: 'Jason Lee', enquiryDate: sgToday(), product: 'AC Self-Storage', accessFrequency: 'Not sure',
      potentialValue: 1920, probability: 10, stageLabel: 'New', source: 'WALK_IN',
    });

    const dated = await api.post(`${CMS}/leads`).set('Authorization', op.auth)
      .send({ name: 'Sarah Tan', mobile: '+65 9123 4821', enquiryDate: '2026-11-01', monthlyRate: 300, durationMonths: 12 });
    expect(dated.body.data).toMatchObject({ enquiryDate: '2026-11-01', potentialValue: 3600 });
    expect(dated.body.data.leadNo).toBeGreaterThan(lead.leadNo);
  });

  it('adds an enquiry under the same identity without letting identity change', async () => {
    const op = await createOperator('OWNER');
    const lead = (await api.post(`${CMS}/leads`).set('Authorization', op.auth)
      .send({ name: 'Sarah Tan', email: 'sarah@example.test', mobile: '+65 9123 4821' })).body.data;
    const enq = await api.post(`${CMS}/leads/${lead.id}/enquiries`).set('Authorization', op.auth)
      .send({ enquiryDate: sgToday(), preferredSize: '26–50', accessFrequency: 'Weekly', name: 'Someone Else' });
    expect(enq.status).toBe(201);
    expect(enq.body.data).toMatchObject({ name: 'Sarah Tan', email: 'sarah@example.test', accessFrequency: 'Weekly', enquiryDate: sgToday() });
    expect(enq.body.data.id).not.toBe(lead.id);
    const list = await api.get(`${CMS}/leads/${lead.id}/enquiries`).set('Authorization', op.auth);
    expect(list.body.data.map((r: { id: string }) => r.id)).toEqual([enq.body.data.id, lead.id]);
    expect((await api.post(`${CMS}/leads/nope/enquiries`).set('Authorization', op.auth).send({})).status).toBe(404);
  });
});

describe('pipeline and SLA settings', () => {
  beforeEach(resetDb);

  it('saves versioned pipeline settings and uses the stage probability', async () => {
    const op = await createOperator('OWNER');
    const cur = (await api.get(`${CMS}/leads/pipeline-settings`).set('Authorization', op.auth)).body.data;
    expect(cur.version).toBe(0);
    expect(cur.stages.map((s: { stage: string }) => s.stage)).toContain('NURTURING');
    const stages = cur.stages.map((s: { stage: string }) => (s.stage === 'NEW_ENQUIRY' ? { ...s, probability: 12 } : s));
    const body = { version: 0, stages, assignmentRule: cur.assignmentRule, lostReasons: cur.lostReasons, requireNextAction: true };
    const saved = await api.put(`${CMS}/leads/pipeline-settings`).set('Authorization', op.auth).send(body);
    expect(saved.status).toBe(200);
    expect(saved.body.data.version).toBe(1);
    expect((await api.put(`${CMS}/leads/pipeline-settings`).set('Authorization', op.auth).send(body)).status).toBe(409);
    const lead = await api.post(`${CMS}/leads`).set('Authorization', op.auth).send({ name: 'Probability check', email: 'p@example.test' });
    expect(lead.body.data.probability).toBe(12);
    const missing = await api.put(`${CMS}/leads/pipeline-settings`).set('Authorization', op.auth).send({ ...body, version: 1, stages: stages.slice(1) });
    expect(missing.status).toBe(400);
  });

  it('validates SLA targets against the allowed options and gates edits', async () => {
    const op = await createOperator('OWNER');
    const cur = (await api.get(`${CMS}/settings/lead-sla`).set('Authorization', op.auth)).body.data;
    expect(cur.targets).toEqual({ website: 15, whatsapp: 15, phone: 10, email: 30 });
    const body = { targets: { ...cur.targets, email: 240 }, businessHoursOnly: true, pauseOnPublicHolidays: true, whatsapp247: true, warningPct: 80, escalateTo: ['Sales Manager'] };
    expect((await api.put(`${CMS}/settings/lead-sla`).set('Authorization', op.auth).send(body)).body.data).toMatchObject({ version: 1, whatsapp247: true });
    expect((await api.put(`${CMS}/settings/lead-sla`).set('Authorization', op.auth).send({ ...body, targets: { ...body.targets, phone: 45 } })).status).toBe(400);
    const manager = await createOperator('MANAGER');
    expect((await api.put(`${CMS}/settings/lead-sla`).set('Authorization', manager.auth).send(body)).status).toBe(403);
  });
});

describe('notes with mentions', () => {
  beforeEach(resetDb);

  it('notifies each mentioned operator and marks notifications read', async () => {
    const op = await createOperator('OWNER');
    const colleague = await createOperator('MANAGER');
    const lead = (await api.post(`${CMS}/leads`).set('Authorization', op.auth).send({ name: 'Mention target', email: 'm@example.test' })).body.data;
    const note = await api.post(`${CMS}/leads/${lead.id}/notes`).set('Authorization', op.auth)
      .send({ body: '@E2E MANAGER please call back', mentions: [colleague.id] });
    expect(note.status).toBe(201);
    expect(note.body.data.notified).toHaveLength(1);
    expect((await api.get(`${CMS}/leads/${lead.id}/notes`).set('Authorization', op.auth)).body.data).toHaveLength(1);
    const inbox = await api.get(`${CMS}/notifications`).set('Authorization', colleague.auth);
    expect(inbox.body.data.unread).toBe(1);
    expect(inbox.body.data.rows[0]).toMatchObject({ kind: 'MENTION', entityType: 'lead', entityId: lead.id });
    expect((await api.get(`${CMS}/notifications`).set('Authorization', op.auth)).body.data.unread).toBe(0);
    await api.post(`${CMS}/notifications/read`).set('Authorization', colleague.auth).send({});
    expect((await api.get(`${CMS}/notifications`).set('Authorization', colleague.auth)).body.data.unread).toBe(0);
    expect((await api.post(`${CMS}/leads/${lead.id}/notes`).set('Authorization', op.auth).send({ body: 'x', mentions: ['ghost'] })).status).toBe(400);
  });
});

describe('quotation register', () => {
  beforeEach(resetDb);

  it('serialises QT-YYYY numbers, voids issued quotes and only deletes drafts', async () => {
    const world = await seedMoveInWorld();
    const op = await createOperator('OWNER');
    const lead = (await api.post(`${CMS}/leads`).set('Authorization', op.auth)
      .send({ name: 'Quote lead', email: 'q@example.test', preferredBranchId: world.branchId, monthlyRate: 468, durationMonths: 6 })).body.data;
    const quoted = await api.post(`${CMS}/quotes`).set('Authorization', op.auth).send({ leadId: lead.id });
    expect(quoted.status).toBe(201);
    const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric' }).format(new Date());
    expect(quoted.body.data.quotation.quoteNo).toBe(`QT-${year}-00001`);

    const reg = (await api.get(`${CMS}/quotations`).set('Authorization', op.auth)).body.data;
    expect(reg.summary).toMatchObject({ total: 1, awaitingFollowUp: 1, drafts: 0 });
    const row = reg.rows[0];
    expect(row).toMatchObject({ number: `QT-${year}-00001`, gross: 468, net: 468, status: 'SENT', commitmentMonths: 6, leadDisplayId: lead.displayId });

    const draft = await api.post(`${CMS}/quotations/${row.id}/duplicate`).set('Authorization', op.auth);
    expect(draft.status).toBe(201);
    expect(draft.body.data.status).toBe('DRAFT');
    expect((await api.post(`${CMS}/quotations/${draft.body.data.id}/void`).set('Authorization', op.auth).send({ reason: 'x' })).status).toBe(409);
    expect((await api.delete(`${CMS}/quotations/${row.id}`).set('Authorization', op.auth)).status).toBe(409);
    const manager = await createOperator('MANAGER');
    expect((await api.delete(`${CMS}/quotations/${draft.body.data.id}`).set('Authorization', manager.auth)).status).toBe(403);
    expect((await api.delete(`${CMS}/quotations/${draft.body.data.id}`).set('Authorization', op.auth)).status).toBe(200);

    const voided = await api.post(`${CMS}/quotations/${row.id}/void`).set('Authorization', op.auth).send({ reason: 'Customer chose another unit' });
    expect(voided.body.data).toMatchObject({ status: 'VOIDED', voidReason: 'Customer chose another unit' });
    const filtered = (await api.get(`${CMS}/quotations?status=VOIDED`).set('Authorization', op.auth)).body.data;
    expect(filtered.rows).toHaveLength(1);
    expect((await api.get(`${CMS}/quotations/${row.id}/pdf`).set('Authorization', op.auth)).headers['content-type']).toMatch(/pdf/);
  });
});

describe('appointments', () => {
  beforeEach(resetDb);

  it('stores the assigned staff member and the new statuses', async () => {
    const op = await createOperator('OWNER');
    const created = await api.post(`${CMS}/appointments`).set('Authorization', op.auth).send({
      title: 'Facility viewing', personName: 'Sarah Tan', type: 'VIEWING', startAt: '2026-11-10T02:00:00.000Z', staff: 'Nur Aisyah',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.staff).toBe('Nur Aisyah');
    const upd = await api.patch(`${CMS}/appointments/${created.body.data.id}`).set('Authorization', op.auth).send({ status: 'AWAITING_REPLY' });
    expect(upd.body.data.status).toBe('AWAITING_REPLY');
    expect(await prisma.appointment.count()).toBe(1);
  });
});

describe('lead database rows (one master lead per identity)', () => {
  beforeEach(resetDb);

  it('returns the most relevant enquiry as the row, honouring facility filters and SL-number search', async () => {
    const op = await createOperator('OWNER');
    const branch = await prisma.branch.create({ data: { code: 'LG', name: 'Lead Grid', address: '1 Grid Rd', operatingHours: '9-9' } });
    const first = await api.post(`${CMS}/leads`).set('Authorization', op.auth)
      .send({ name: 'Grace Lim', email: 'grace@grid.test', mobile: '91112222', source: 'PHONE', preferredBranchId: branch.id });
    expect(first.status).toBe(201);
    const second = await api.post(`${CMS}/leads/${first.body.data.id}/enquiries`).set('Authorization', op.auth)
      .send({ enquiryDate: sgToday(), source: 'WEBSITE' });
    expect(second.status).toBe(201);

    const all = await api.get(`${CMS}/leads/groups`).set('Authorization', op.auth);
    expect(all.status).toBe(200);
    const g = all.body.data.find((x: { email: string }) => x.email === 'grace@grid.test');
    expect(g.count).toBe(2);
    expect(g.primary).toMatchObject({ id: second.body.data.id, source: 'WEBSITE' });

    const byFacility = await api.get(`${CMS}/leads/groups?branchId=${branch.id}`).set('Authorization', op.auth);
    expect(byFacility.body.data).toHaveLength(1);
    expect(byFacility.body.data[0].primary).toMatchObject({ id: first.body.data.id, branchName: 'Lead Grid' });

    const bySl = await api.get(`${CMS}/leads/groups?search=${encodeURIComponent(first.body.data.displayId)}`).set('Authorization', op.auth);
    expect(bySl.body.data.map((x: { email: string }) => x.email)).toEqual(['grace@grid.test']);
  });
});

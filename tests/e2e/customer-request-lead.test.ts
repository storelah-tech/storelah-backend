// Portal change requests (POST /customer/requests) are stored as contactable
// leads: the authenticated customer's email + mobile with the standard
// identity stamp, so they link into that email's lead group (link, never
// merge). They must never be auto-marked WON by a booking payment, and never
// count as repeat enquiries. The 201 response shape is unchanged.

import { beforeEach, describe, expect, it } from 'vitest';
import { getLeadGroupTimeline, getLeadStats, markLeadWonForBooking, normalizeLeadIdentity } from '../../src/core/leads';
import { api, prisma, resetDb, uniqueEmail } from './fixtures';

async function registerCustomer(email: string, mobile?: string): Promise<string> {
  const reg = await api.post('/api/v1/customer/register').send({
    name: 'E2E Request Owner',
    email,
    ...(mobile ? { mobile } : {}),
    password: 'e2e-request-owner-1',
    type: 'PERSONAL',
  });
  expect(reg.status).toBe(201);
  return reg.body.data.token as string;
}

async function submitRequest(token: string, body: Record<string, unknown>) {
  return api.post('/api/v1/customer/requests').set('Authorization', `Bearer ${token}`).send(body);
}

describe('customer change request leads are contactable', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('stores the customer email + mobile with the identity stamp; response unchanged', async () => {
    const email = uniqueEmail();
    const token = await registerCustomer(email, '8123 4567');

    const res = await submitRequest(token, {
      type: 'UPSIZE',
      preferredDate: '2026-11-01',
      notes: 'Unit SW-01-01 — need a bigger one',
    });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body.data).sort()).toEqual(['id', 'status']);
    expect(res.body.data.status).toBe('SUBMITTED');

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(lead).toMatchObject({
      name: 'E2E Request Owner',
      stage: 'NEW_ENQUIRY',
      source: 'WEBSITE',
      email,
      mobile: '8123 4567',
      emailNorm: email.toLowerCase(),
      mobileNorm: '6581234567',
      leadGroupKey: email.toLowerCase(),
      note: 'Request type: UPSIZE | Preferred date: 2026-11-01 | Unit SW-01-01 — need a bigger one',
    });
  });

  it('a customer without a mobile still gets an email-keyed lead', async () => {
    const email = uniqueEmail();
    const token = await registerCustomer(email);

    const res = await submitRequest(token, { type: 'TRANSFER' });
    expect(res.status).toBe(201);

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(lead).toMatchObject({ email, mobile: null, mobileNorm: null, leadGroupKey: email.toLowerCase() });
  });

  it('links into the email group, is never auto-WON, and stays out of the repeat-enquiry rollup', async () => {
    const email = uniqueEmail();
    const token = await registerCustomer(email, '81234567');
    const enquiry = await prisma.lead.create({
      data: { name: 'E2E Request Owner', email, mobile: '81234567', ...normalizeLeadIdentity(email, '81234567') },
    });

    const res = await submitRequest(token, { type: 'DOWNSIZE', notes: 'Unit SW-01-01 — too big' });
    expect(res.status).toBe(201);
    const requestId = res.body.data.id as string;

    // Linked (not merged): both rows sit in the same email group timeline.
    const { group, timeline } = await getLeadGroupTimeline(email.toLowerCase());
    expect(group.count).toBe(2);
    expect(timeline.map((l) => l.id).sort()).toEqual([enquiry.id, requestId].sort());

    // A booking payment for the same email converts the enquiry only.
    const flipped = await prisma.$transaction((tx) => markLeadWonForBooking(tx, { email, mobile: '81234567' }));
    expect(flipped).toBe(1);
    await expect(prisma.lead.findUnique({ where: { id: enquiry.id } })).resolves.toMatchObject({ stage: 'WON' });
    await expect(prisma.lead.findUnique({ where: { id: requestId } })).resolves.toMatchObject({ stage: 'NEW_ENQUIRY' });

    // One email identity with one real enquiry: no repeat behaviour.
    const stats = await getLeadStats();
    expect(stats.uniqueEmails).toBe(1);
    expect(stats.repeatEnquiryRate).toBe(0);
  });
});

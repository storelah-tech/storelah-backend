// Finance Phase 3 — Billing and payments (spec §§6/10/17/21, Q2/Q3/Q5).
//
// Covers: invoice lifecycle (DRAFT → APPROVED → ISSUED + GST hook at issue),
// billing-run idempotency (twice → one draft set), the transactions register
// (individual approval only, maker-checker, stale-version 409, server
// revalidation), queued off-session charges under a STABLE idempotency key,
// webhook exactly-once by Stripe event id, partial receipts, retry/recovery,
// outage queuing, void rules, and the portal cross-lane regression (hidden
// statuses, no new customer-facing fields).
//
// Stripe is MOCKED (vi.mock on getStripe, same pattern as
// portal-saved-cards-stripe.test.ts) — nothing reaches the network. The one
// signed HTTP webhook test uses the real Stripe lib only for the local HMAC
// signature, like the saved-cards suite does.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import {
  INSTRUCTION_SESSION_KIND,
  applyInvoicePaymentSucceeded,
  toCustomerInvoice,
} from '../../src/core/invoicePayments';
import {
  applyInstructionPaymentFailed,
  applyInstructionPaymentSucceeded,
} from '../../src/core/finance/payments';
import { PIN, api, createOperator, prisma, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';
import { ROUTE_PERMISSIONS } from '../../src/lib/routePermissions';
import cmsRouter from '../../src/routes/cms';
import { listRouteKeys } from '../../src/lib/routePermissions';

const CMS = '/api/v1/cms';

const fake = vi.hoisted(() => {
  const state = {
    defaults: new Map<string, string>(),
    pms: new Map<string, { id: string; type: string; customer: string | null }>(),
    pis: new Map<string, Record<string, unknown>>(),
    idem: new Map<string, Record<string, unknown>>(),
    nextPiStatus: 'succeeded',
    throwMode: null as null | 'card' | 'outage',
    seq: 0,
  };
  const stripe = {
    customers: {
      retrieve: async (id: string) => ({
        id,
        invoice_settings: { default_payment_method: state.defaults.get(id) ?? null },
      }),
    },
    paymentMethods: {
      retrieve: async (id: string) => {
        const pm = state.pms.get(id);
        if (!pm) throw Object.assign(new Error('No such payment_method'), { type: 'StripeInvalidRequestError' });
        return pm;
      },
    },
    paymentIntents: {
      create: async (p: Record<string, unknown>, opts: { idempotencyKey: string }) => {
        if (state.throwMode === 'outage') throw new Error('socket hang up');
        const replay = state.idem.get(opts.idempotencyKey);
        if (replay) return replay;
        const id = `pi_fake_${++state.seq}`;
        const pi: Record<string, unknown> = {
          id,
          status: state.nextPiStatus,
          amount: p.amount,
          amount_received: p.amount,
          payment_method: p.payment_method,
          customer: p.customer,
          metadata: p.metadata,
        };
        state.pis.set(id, pi);
        state.idem.set(opts.idempotencyKey, pi);
        if (state.nextPiStatus === 'requires_payment_method' || state.throwMode === 'card') {
          throw Object.assign(new Error('Your card was declined.'), {
            type: 'StripeCardError',
            payment_intent: pi,
          });
        }
        return pi;
      },
      retrieve: async (id: string) => {
        const pi = state.pis.get(id);
        if (!pi) throw new Error('No such payment_intent');
        return pi;
      },
    },
  };
  return { state, stripe };
});

vi.mock('../../src/core/checkout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/checkout')>();
  return { ...actual, getStripe: () => fake.stripe };
});

const SAVED = {
  wh: process.env.STRIPE_WEBHOOK_SECRET,
  pk: process.env.STRIPE_PUBLISHABLE_KEY,
  sk: process.env.STRIPE_SECRET_KEY,
  app: process.env.BOOKING_APP_URL,
};

function resetFake() {
  fake.state.defaults.clear();
  fake.state.pms.clear();
  fake.state.pis.clear();
  fake.state.idem.clear();
  fake.state.nextPiStatus = 'succeeded';
  fake.state.throwMode = null;
  fake.state.seq = 0;
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake';
  process.env.BOOKING_APP_URL = 'http://localhost:3101';
}

afterAll(() => {
  for (const [k, v] of [
    ['STRIPE_WEBHOOK_SECRET', SAVED.wh],
    ['STRIPE_PUBLISHABLE_KEY', SAVED.pk],
    ['STRIPE_SECRET_KEY', SAVED.sk],
    ['BOOKING_APP_URL', SAVED.app],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface BillWorld {
  operator: { auth: string; email: string; id: string };
  approverA: { auth: string; email: string; id: string };
  approverB: { auth: string; email: string; id: string };
  branchId: string;
  unitId: string;
  tenantId: string;
  tenantEmail: string;
  customerId: string;
}

/** Branch + unit + ACTIVE tenant linked to a wallet-holding customer. */
let billUnitSeq = 0;
async function seedBillWorld(email?: string): Promise<BillWorld> {
  const tenantEmail = email ?? uniqueEmail();
  const reg = await api.post('/api/v1/customer/register').send({
    name: 'E2E Bill Payer',
    email: tenantEmail,
    mobile: '81234567',
    password: 'e2e-bill-pay-1',
    type: 'PERSONAL',
  });
  expect(reg.status).toBe(201);
  const customer = await prisma.customer.findUnique({ where: { email: tenantEmail } });
  if (!customer) throw new Error('[e2e] customer missing');
  const stripeCustomerId = `cus_e2e_${customer.id.slice(-8)}`;
  await prisma.customer.update({ where: { id: customer.id }, data: { stripeCustomerId } });

  const branch = await prisma.branch.findUnique({ where: { code: PIN.branchCode } });
  if (!branch) throw new Error('[e2e] move-in world not seeded');
  // Fresh unit per world: Tenant.unitId is UNIQUE, so worlds never share one.
  const size = await prisma.unitSize.findFirst();
  const floor = await prisma.floor.findFirst({ where: { branchId: branch.id } });
  if (!size || !floor) throw new Error('[e2e] move-in world not seeded');
  billUnitSeq += 1;
  const unit = await prisma.unit.create({
    data: {
      branchId: branch.id,
      floorId: floor.id,
      sizeId: size.id,
      unitCode: `E2E-3-${Date.now().toString(36)}-${billUnitSeq.toString(36)}`,
      sqft: 50,
      monthlyRate: 200,
      status: 'OCCUPIED',
    },
  });
  const tenant = await prisma.tenant.create({
    data: {
      name: 'E2E Bill Tenant',
      email: tenantEmail,
      mobile: '81234567',
      unitId: unit.id,
      moveInDate: new Date('2026-09-01T00:00:00Z'),
      monthlyRate: 200,
      psf: 4,
      status: 'ACTIVE',
      branchId: branch.id,
    },
  });
  // Default saved card on the wallet (the off-session mandate).
  fake.state.defaults.set(stripeCustomerId, 'pm_default');
  fake.state.pms.set('pm_default', { id: 'pm_default', type: 'card', customer: stripeCustomerId });
  return {
    operator: await createOperator('FINANCE_OPERATOR'),
    approverA: await createOperator('FINANCE_APPROVER'),
    approverB: await createOperator('FINANCE_APPROVER'),
    branchId: branch.id,
    unitId: unit.id,
    tenantId: tenant.id,
    tenantEmail,
    customerId: customer.id,
  };
}

async function createDraft(
  auth: string,
  w: BillWorld,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; version: number; invoiceNo: string }> {
  const res = await api.post(`${CMS}/finance/invoices`).set('Authorization', auth).send({
    tenantId: w.tenantId,
    dueDate: new Date('2026-10-15T00:00:00Z').toISOString(),
    serviceStart: new Date('2026-10-01T00:00:00Z').toISOString(),
    serviceEnd: new Date('2026-10-31T00:00:00Z').toISOString(),
    lines: [{ kind: 'RENT', label: 'Storage rent — October', amount: 200 }],
    ...overrides,
  });
  expect(res.status).toBe(201);
  return { id: res.body.data.id as string, version: res.body.data.version as number, invoiceNo: res.body.data.no as string };
}

async function createApproveIssue(auth: string, w: BillWorld, overrides: Record<string, unknown> = {}) {
  // Drafts are raised by the operator; approval/issue by a different identity
  // (maker-checker) unless the caller deliberately passes the same operator.
  const draft = await createDraft(w.operator.auth, w, overrides);
  const appr = await api.post(`${CMS}/finance/invoices/${draft.id}/approve`).set('Authorization', auth).send({ version: draft.version });
  expect(appr.status).toBe(200);
  const issued = await api.post(`${CMS}/finance/invoices/${draft.id}/issue`).set('Authorization', auth).send({ version: appr.body.data.version });
  expect(issued.status).toBe(200);
  return issued.body.data as { id: string; version: number; no: string };
}

describe('finance phase 3 — invoice lifecycle', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
    resetFake();
  });

  it('billing.issue-creates-instruction: DRAFT → APPROVED → ISSUED queues a PENDING_APPROVAL instruction and never charges', async () => {
    const w = await seedBillWorld();
    const draft = await createDraft(w.operator.auth, w);
    let inv = (await api.get(`${CMS}/finance/invoices/${draft.id}`).set('Authorization', w.operator.auth)).body.data;
    expect(inv).toMatchObject({ status: 'DRAFT', amount: 200, taxAmount: 0, balanceDue: 200, createdBy: w.operator.email });

    const appr = await api.post(`${CMS}/finance/invoices/${draft.id}/approve`).set('Authorization', w.approverA.auth).send({ version: draft.version });
    expect(appr.status).toBe(200);
    expect(appr.body.data).toMatchObject({ status: 'APPROVED', approvedBy: w.approverA.email });

    const issued = await api.post(`${CMS}/finance/invoices/${draft.id}/issue`).set('Authorization', w.approverA.auth).send({ version: appr.body.data.version });
    expect(issued.status).toBe(200);
    expect(issued.body.data).toMatchObject({ status: 'ISSUED' });

    // One instruction, pending approval, no processor touch.
    const reg = await api.get(`${CMS}/finance/transactions?invoiceId=${draft.id}`).set('Authorization', w.approverA.auth);
    expect(reg.body.data).toHaveLength(1);
    expect(reg.body.data[0]).toMatchObject({ invoiceId: draft.id, amount: 200, method: 'SAVED_CARD', status: 'PENDING_APPROVAL' });
    expect(reg.body.data[0].paymentIntentId).toBeNull();
    expect(fake.state.pis.size).toBe(0);
  });

  it('billing.gst: OFF keeps tax 0; ON taxes 5% at issue from the editable setting', async () => {
    const w = await seedBillWorld();
    await createApproveIssue(w.approverA.auth, w);
    const off = await prisma.invoice.findFirst({ where: { tenantId: w.tenantId } });
    expect(toNum2(off!.taxAmount)).toBe(0);
    expect(toNum2(off!.amount)).toBe(200);

    await prisma.setting.upsert({
      where: { key: 'finance.gstEnabled' },
      create: { key: 'finance.gstEnabled', value: true },
      update: { value: true },
    });
    const w2 = await seedBillWorld();
    await createApproveIssue(w2.approverA.auth, w2, {
      serviceStart: new Date('2026-11-01T00:00:00Z').toISOString(),
      serviceEnd: new Date('2026-11-30T00:00:00Z').toISOString(),
    });
    const on = await prisma.invoice.findFirst({ where: { tenantId: w2.tenantId } });
    expect(toNum2(on!.taxAmount)).toBe(10);
    expect(toNum2(on!.amount)).toBe(210);
    expect(toNum2(on!.balanceDue)).toBe(210);
  });

  it('invoices.lifecycle-guards: no issue without approval, no double approve, maker-checker, paid lock', async () => {
    const w = await seedBillWorld();
    const draft = await createDraft(w.operator.auth, w);

    // Issue before approval → 409.
    expect((await api.post(`${CMS}/finance/invoices/${draft.id}/issue`).set('Authorization', w.approverA.auth).send({ version: draft.version })).status).toBe(409);

    // Creator cannot approve their own draft (spec §4.1), regardless of role.
    // The operator lacks bill-invoices:approve anyway — the guard answers 403.
    const own = await api.post(`${CMS}/finance/invoices/${draft.id}/approve`).set('Authorization', w.operator.auth).send({ version: draft.version });
    expect(own.status).toBe(403);

    // An approver creating + approving their own draft hits maker-checker.
    const mine = await createDraft(w.approverA.auth, w, {
      serviceStart: new Date('2026-12-01T00:00:00Z').toISOString(),
      serviceEnd: new Date('2026-12-31T00:00:00Z').toISOString(),
    });
    const selfApprove = await api.post(`${CMS}/finance/invoices/${mine.id}/approve`).set('Authorization', w.approverA.auth).send({ version: mine.version });
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('MAKER_CHECKER');

    // Proper approval, then double-approve → 409.
    const ok = await api.post(`${CMS}/finance/invoices/${draft.id}/approve`).set('Authorization', w.approverA.auth).send({ version: draft.version });
    expect(ok.status).toBe(200);
    expect((await api.post(`${CMS}/finance/invoices/${draft.id}/approve`).set('Authorization', w.approverB.auth).send({ version: ok.body.data.version })).status).toBe(409);

    // Paid invoices cannot be voided (credit/refund documents are Phase 4).
    const paid = await prisma.invoice.create({
      data: {
        invoiceNo: `INV-E2E-PAID-${Date.now()}`, tenantId: w.tenantId, unitId: w.unitId, amount: 50,
        dueDate: new Date(), billedMonth: new Date(), status: 'PAID', paidAt: new Date(), amountPaid: 50,
      },
    });
    expect((await api.post(`${CMS}/finance/invoices/${paid.id}/void`).set('Authorization', w.approverA.auth).send({ version: 0, reason: 'oops' })).status).toBe(409);
  });

  it('invoices.create-validation: lines required, no hand-entered tax/credit, no duplicate service period', async () => {
    const w = await seedBillWorld();
    const base = {
      tenantId: w.tenantId,
      dueDate: new Date('2026-10-15T00:00:00Z').toISOString(),
      serviceStart: new Date('2026-10-01T00:00:00Z').toISOString(),
      serviceEnd: new Date('2026-10-31T00:00:00Z').toISOString(),
    };
    expect((await api.post(`${CMS}/finance/invoices`).set('Authorization', w.operator.auth).send({ ...base, lines: [] })).status).toBe(400);
    expect((await api.post(`${CMS}/finance/invoices`).set('Authorization', w.operator.auth).send({ ...base, lines: [{ kind: 'TAX', label: 'GST', amount: 10 }] })).status).toBe(400);
    expect((await api.post(`${CMS}/finance/invoices`).set('Authorization', w.operator.auth).send({ ...base, lines: [{ kind: 'CREDIT', label: 'credit', amount: -5 }] })).status).toBe(400);

    await createDraft(w.operator.auth, w);
    // Same tenant + unit + service month twice → 409.
    const dup = await api.post(`${CMS}/finance/invoices`).set('Authorization', w.operator.auth).send({ ...base, lines: [{ kind: 'RENT', label: 'again', amount: 200 }] });
    expect(dup.status).toBe(409);
  });

  it('invoices.void-requires-reason: reason mandatory; void cancels the live instruction', async () => {
    const w = await seedBillWorld();
    const inv = await createApproveIssue(w.approverA.auth, w);
    expect((await api.post(`${CMS}/finance/invoices/${inv.id}/void`).set('Authorization', w.approverA.auth).send({})).status).toBe(400);

    const voided = await api.post(`${CMS}/finance/invoices/${inv.id}/void`).set('Authorization', w.approverA.auth).send({ version: inv.version, reason: 'tenant moved out early' });
    expect(voided.status).toBe(200);
    expect(voided.body.data).toMatchObject({ status: 'VOID', voidReason: 'tenant moved out early' });

    const reg = await api.get(`${CMS}/finance/transactions?invoiceId=${inv.id}`).set('Authorization', w.approverA.auth);
    expect(reg.body.data).toHaveLength(1);
    expect(reg.body.data[0].status).toBe('CANCELLED');
  });

  it('billing-run.twice-one-draft-set: run twice → one draft set, drafts need approval, zero-rate skipped, no late fees', async () => {
    const w = await seedBillWorld();
    await prisma.tenant.create({
      data: {
        name: 'Zero Rate', email: uniqueEmail(), unitId: (await prisma.unit.findUnique({ where: { unitCode: PIN.guestUnit } }))!.id,
        moveInDate: new Date(), monthlyRate: 0, psf: 0, status: 'ACTIVE', branchId: w.branchId,
      },
    });
    const body = { branchId: w.branchId, billingMonth: '2026-11', dueDate: new Date('2026-11-30T00:00:00Z').toISOString() };
    const first = await api.post(`${CMS}/finance/billing-run`).set('Authorization', w.operator.auth).send(body);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ created: 1, reused: 0 });
    expect(first.body.data.skipped).toHaveLength(1);

    const second = await api.post(`${CMS}/finance/billing-run`).set('Authorization', w.operator.auth).send(body);
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ created: 0, reused: 1 });

    const drafts = await prisma.invoice.findMany({ where: { serviceStart: new Date('2026-11-01T00:00:00Z') } });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: 'DRAFT', idempotencyKey: `billing-run:${w.branchId}:2026-11:${w.tenantId}` });
    expect(toNum2(drafts[0].amount)).toBe(200);
  });
});

describe('finance phase 3 — transactions register', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
    resetFake();
  });

  async function issuedWithInstruction(w: BillWorld, overrides: Record<string, unknown> = {}) {
    const invoice = await createApproveIssue(w.approverA.auth, w, overrides);
    const reg = await api.get(`${CMS}/finance/transactions?invoiceId=${invoice.id}`).set('Authorization', w.approverA.auth);
    return { invoice, instruction: reg.body.data[0] as { id: string; version: number } };
  }

  it('transactions.approver-not-requester: the requestor can never approve their own charge', async () => {
    const w = await seedBillWorld();
    const { instruction } = await issuedWithInstruction(w);
    // approverA created the invoice AND the auto-instruction (issuer) → 403.
    const self = await api.post(`${CMS}/finance/transactions/${instruction.id}/approve`).set('Authorization', w.approverA.auth).send({ version: instruction.version });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CHECKER');
    // A different approver queues it.
    const ok = await api.post(`${CMS}/finance/transactions/${instruction.id}/approve`).set('Authorization', w.approverB.auth).send({ version: instruction.version });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'QUEUED', approvedBy: w.approverB.email });
  });

  it('transactions.individual-only-no-bulk: approving one instruction leaves the other pending, and no bulk route exists', async () => {
    const w = await seedBillWorld();
    const a = await issuedWithInstruction(w);
    const w2 = await seedBillWorld();
    const b = await issuedWithInstruction(w2);
    await api.post(`${CMS}/finance/transactions/${a.instruction.id}/approve`).set('Authorization', w.approverB.auth).send({ version: a.instruction.version });
    const stillPending = await api.get(`${CMS}/finance/transactions/${b.instruction.id}`).set('Authorization', w.approverB.auth);
    expect(stillPending.body.data.status).toBe('PENDING_APPROVAL');

    // No bulk approval/submit path: every mutation route addresses one id.
    const keys = listRouteKeys(cmsRouter).filter((k) => k.includes('/finance/transactions'));
    expect(keys).toEqual(expect.arrayContaining([
      'GET /finance/transactions',
      'POST /finance/transactions/:id/approve',
      'POST /finance/transactions/:id/retry',
    ]));
    expect(keys.some((k) => /transactions\/(approve|retry|cancel)$/.test(k))).toBe(false);
    expect(ROUTE_PERMISSIONS['POST /finance/transactions/:id/approve']).toBe('bill-transactions:approve');
  });

  it('transactions.approve-stale-409: a changed version fails safely, no lost update', async () => {
    const w = await seedBillWorld();
    const { instruction } = await issuedWithInstruction(w);
    const stale = await api.post(`${CMS}/finance/transactions/${instruction.id}/approve`).set('Authorization', w.approverB.auth).send({ version: 999 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE');
    const row = await prisma.paymentInstruction.findUnique({ where: { id: instruction.id } });
    expect(row!.status).toBe('PENDING_APPROVAL');
  });

  it('transactions.approve-revalidates: paid invoice, missing wallet and changed balance all block approval', async () => {
    const w = await seedBillWorld();
    // Paid meanwhile → 409.
    const a = await issuedWithInstruction(w);
    await prisma.invoice.update({ where: { id: a.invoice.id }, data: { status: 'PAID', paidAt: new Date(), amountPaid: 200, balanceDue: 0 } });
    const paid = await api.post(`${CMS}/finance/transactions/${a.instruction.id}/approve`).set('Authorization', w.approverB.auth).send({ version: a.instruction.version });
    expect(paid.status).toBe(409);
    expect(paid.body.error.code).toBe('INVOICE_CHANGED');

    // No wallet on the tenant email → 409 MANDATE_REQUIRED.
    const w2 = await seedBillWorld(uniqueEmail());
    await prisma.customer.deleteMany({ where: { email: w2.tenantEmail } });
    const b = await issuedWithInstruction(w2);
    const noWallet = await api.post(`${CMS}/finance/transactions/${b.instruction.id}/approve`).set('Authorization', w2.approverB.auth).send({ version: b.instruction.version });
    expect(noWallet.status).toBe(409);
    expect(noWallet.body.error.code).toBe('MANDATE_REQUIRED');

    // Balance dropped below the instruction amount (partial payment arrived) → 409.
    const w3 = await seedBillWorld();
    const c = await issuedWithInstruction(w3);
    await prisma.invoice.update({ where: { id: c.invoice.id }, data: { amountPaid: 150, balanceDue: 50 } });
    const changed = await api.post(`${CMS}/finance/transactions/${c.instruction.id}/approve`).set('Authorization', w3.approverB.auth).send({ version: c.instruction.version });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('INVOICE_CHANGED');
  });

  it('charge.retry-same-key: double submit converges on one PaymentIntent', async () => {
    const w = await seedBillWorld();
    const { instruction } = await issuedWithInstruction(w);
    const appr = await api.post(`${CMS}/finance/transactions/${instruction.id}/approve`).set('Authorization', w.approverB.auth).send({ version: instruction.version });
    const first = await api.post(`${CMS}/finance/transactions/${instruction.id}/retry`).set('Authorization', w.approverB.auth).send({ version: appr.body.data.version });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ status: 'SUBMITTED' });
    const pi = first.body.data.paymentIntentId as string;
    expect(pi).toMatch(/^pi_fake_/);
    expect(fake.state.pis.size).toBe(1);

    // A repeated submit (same stable key, no version) replays — no new PI.
    const again = await api.post(`${CMS}/finance/transactions/${instruction.id}/retry`).set('Authorization', w.approverB.auth).send({});
    expect(again.status).toBe(200);
    expect(again.body.data.paymentIntentId).toBe(pi);
    expect(fake.state.pis.size).toBe(1);
    const row = await prisma.paymentInstruction.findUnique({ where: { id: instruction.id } });
    expect(row!.attempts).toBe(1);
  });

  it('webhook.duplicate-delivery-single-paid: same Stripe event id applies exactly once', async () => {
    const w = await seedBillWorld();
    const { instruction, invoice } = await issuedWithInstruction(w);
    const appr = await api.post(`${CMS}/finance/transactions/${instruction.id}/approve`).set('Authorization', w.approverB.auth).send({ version: instruction.version });
    const sub = await api.post(`${CMS}/finance/transactions/${instruction.id}/retry`).set('Authorization', w.approverB.auth).send({ version: appr.body.data.version });
    const piId = sub.body.data.paymentIntentId as string;
    const pi = { ...(fake.state.pis.get(piId) as object), status: 'succeeded', amount_received: 20000 } as unknown as Stripe.PaymentIntent;

    const first = await applyInstructionPaymentSucceeded(pi, { eventId: 'evt_dup_1' });
    expect(first).toMatchObject({ applied: true, invoiceNo: invoice.no });
    const second = await applyInstructionPaymentSucceeded(pi, { eventId: 'evt_dup_1' });
    expect(second.applied).toBe(false);

    const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(inv).toMatchObject({ status: 'PAID' });
    expect(toNum2(inv!.amountPaid)).toBe(200);
    expect(await prisma.processedStripeEvent.count()).toBe(1);
    const instr = await prisma.paymentInstruction.findUnique({ where: { id: instruction.id } });
    expect(instr!.status).toBe('SUCCEEDED');
  });

  it('queued charge via signed webhook: SUBMITTED → SUCCEEDED + invoice PAID, replay is a no-op', async () => {
    const w = await seedBillWorld();
    const { instruction, invoice } = await issuedWithInstruction(w);
    const appr = await api.post(`${CMS}/finance/transactions/${instruction.id}/approve`).set('Authorization', w.approverB.auth).send({ version: instruction.version });
    const sub = await api.post(`${CMS}/finance/transactions/${instruction.id}/retry`).set('Authorization', w.approverB.auth).send({ version: appr.body.data.version });
    const piId = sub.body.data.paymentIntentId as string;

    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_e2e_phase3';
    const payload = JSON.stringify({
      id: 'evt_e2e_phase3_1',
      object: 'event',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: piId,
          object: 'payment_intent',
          status: 'succeeded',
          amount: 20000,
          amount_received: 20000,
          metadata: { kind: INSTRUCTION_SESSION_KIND, instructionId: instruction.id, invoiceId: invoice.id },
        },
      },
    });
    const header = new Stripe('sk_test_fake').webhooks.generateTestHeaderString({ payload, secret: 'whsec_e2e_phase3' });
    const send = () =>
      api.post('/api/v1/customer/stripe/webhook').set('stripe-signature', header).set('Content-Type', 'application/json').send(payload);
    const first = await send();
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ received: true, applied: true });
    const replay = await send();
    expect(replay.body.data).toMatchObject({ received: true, applied: false });

    await expect(prisma.invoice.findUnique({ where: { id: invoice.id } })).resolves.toMatchObject({ status: 'PAID' });
    await expect(prisma.paymentInstruction.findUnique({ where: { id: instruction.id } })).resolves.toMatchObject({ status: 'SUCCEEDED' });
  });

  it('charge.failed-retry-recovery: a decline FAILS with reason, stays visible, cancel recovers', async () => {
    const w = await seedBillWorld();
    const { instruction, invoice } = await issuedWithInstruction(w);
    const appr = await api.post(`${CMS}/finance/transactions/${instruction.id}/approve`).set('Authorization', w.approverB.auth).send({ version: instruction.version });
    fake.state.nextPiStatus = 'requires_payment_method';
    const declined = await api.post(`${CMS}/finance/transactions/${instruction.id}/retry`).set('Authorization', w.approverB.auth).send({ version: appr.body.data.version });
    expect(declined.status).toBe(200);
    expect(declined.body.data).toMatchObject({ status: 'FAILED' });
    expect(declined.body.data.failureReason).toMatch(/declined/i);

    // The processor failure webhook for the same PI is a consistent no-op
    // (already FAILED with this PI id) — and never flips the invoice.
    const piId = declined.body.data.paymentIntentId as string;
    const failed = await applyInstructionPaymentFailed(
      { id: piId, status: 'requires_payment_method', metadata: { instructionId: instruction.id }, last_payment_error: { message: 'Your card was declined.' } } as unknown as Stripe.PaymentIntent,
      { eventId: 'evt_fail_1' },
    );
    expect(failed.applied).toBe(false);
    // The invoice is untouched by the processor failure.
    await expect(prisma.invoice.findUnique({ where: { id: invoice.id } })).resolves.toMatchObject({ status: 'ISSUED' });

    // Recovery: cancel from FAILED works and keeps the evidence.
    const cur = await api.get(`${CMS}/finance/transactions/${instruction.id}`).set('Authorization', w.approverA.auth);
    const cancelled = await api.post(`${CMS}/finance/transactions/${instruction.id}/cancel`).set('Authorization', w.approverA.auth).send({ version: cur.body.data.version, reason: 'customer will pay at counter' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
  });

  it('charge.outage-queues: a processor throw leaves the instruction QUEUED and visible', async () => {
    const w = await seedBillWorld();
    const { instruction } = await issuedWithInstruction(w);
    const appr = await api.post(`${CMS}/finance/transactions/${instruction.id}/approve`).set('Authorization', w.approverB.auth).send({ version: instruction.version });
    fake.state.throwMode = 'outage';
    const res = await api.post(`${CMS}/finance/transactions/${instruction.id}/retry`).set('Authorization', w.approverB.auth).send({ version: appr.body.data.version });
    expect(res.status).toBe(502);
    const row = await prisma.paymentInstruction.findUnique({ where: { id: instruction.id } });
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(row!.lastError).toMatch(/socket hang up/);
    // Still visible in the register for operator retry.
    const reg = await api.get(`${CMS}/finance/transactions?status=QUEUED`).set('Authorization', w.approverB.auth);
    expect((reg.body.data as Array<{ id: string }>).some((r) => r.id === instruction.id)).toBe(true);
  });

  it('partial receipt: a short payment stays PARTIALLY_PAID with updated amounts and shows the remainder', async () => {
    const w = await seedBillWorld();
    // Future due date so the portal mapping stays DUE (Q5 grace derivation
    // would otherwise show OVERDUE for the fixed Oct-15 fixture date).
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { instruction, invoice } = await issuedWithInstruction(w, { dueDate: future });
    const appr = await api.post(`${CMS}/finance/transactions/${instruction.id}/approve`).set('Authorization', w.approverB.auth).send({ version: instruction.version });
    const sub = await api.post(`${CMS}/finance/transactions/${instruction.id}/retry`).set('Authorization', w.approverB.auth).send({ version: appr.body.data.version });
    const piId = sub.body.data.paymentIntentId as string;
    const pi = { ...(fake.state.pis.get(piId) as object), status: 'succeeded', amount_received: 8000 } as unknown as Stripe.PaymentIntent;
    const out = await applyInstructionPaymentSucceeded(pi, { eventId: 'evt_partial_1' });
    expect(out.applied).toBe(true);

    const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(inv).toMatchObject({ status: 'PARTIALLY_PAID' });
    expect(toNum2(inv!.amountPaid)).toBe(80);
    expect(toNum2(inv!.balanceDue)).toBe(120);

    // Portal mapping: visible as DUE with the remaining balance, same shape.
    const mapped = toCustomerInvoice(inv!, 0);
    expect(mapped).toMatchObject({ status: 'DUE', amount: 120, payable: true });

    // The saved-card PI path (kind=invoice) for less-than-balance behaves the same.
    await prisma.invoice.update({ where: { id: inv!.id }, data: { paymentIntentId: 'pi_short_1', status: 'DUE' } });
    const short = await applyInvoicePaymentSucceeded(
      { id: 'pi_short_1', status: 'succeeded', amount: 20000, amount_received: 5000, metadata: { invoiceId: inv!.id } } as unknown as Stripe.PaymentIntent,
    );
    expect(short.applied).toBe(true);
    const after = await prisma.invoice.findUnique({ where: { id: inv!.id } });
    expect(after).toMatchObject({ status: 'PARTIALLY_PAID' });
    expect(toNum2(after!.amountPaid)).toBe(130);
  });

  it('portal regression: DRAFT/APPROVED/VOID rows are hidden and unpayable (cross-lane gate)', async () => {
    const w = await seedBillWorld();
    const draft = await createDraft(w.operator.auth, w);
    const token = (await api.post('/api/v1/customer/login').send({ email: w.tenantEmail, password: 'e2e-bill-pay-1' })).body.data.token as string;

    const portal = await api.get('/api/v1/customer/portal').set('Authorization', `Bearer ${token}`);
    expect(portal.status).toBe(200);
    expect((portal.body.data.invoices as Array<{ id: string }>).some((i) => i.id === draft.id)).toBe(false);

    expect((await api.post(`/api/v1/customer/invoices/${draft.id}/checkout`).set('Authorization', `Bearer ${token}`)).status).toBe(404);
    expect((await api.get(`/api/v1/customer/invoices/${draft.id}/receipt`).set('Authorization', `Bearer ${token}`)).status).toBe(404);
  });

  it('transactions.register: operator creates, cannot approve; viewer sees neither', async () => {
    const w = await seedBillWorld();
    const viewer = await createOperator('VIEWER');
    expect((await api.get(`${CMS}/finance/transactions`).set('Authorization', viewer.auth)).status).toBe(403);
    expect((await api.get(`${CMS}/finance/invoices`).set('Authorization', viewer.auth)).status).toBe(403);

    const inv = await createApproveIssue(w.approverA.auth, w);
    const reg = await api.get(`${CMS}/finance/transactions?invoiceId=${inv.id}`).set('Authorization', w.operator.auth);
    expect(reg.status).toBe(200);
    const own = await api.post(`${CMS}/finance/transactions/${reg.body.data[0].id}/approve`).set('Authorization', w.operator.auth).send({});
    // No bill-transactions:approve on the operator role → guard answers first.
    expect(own.status).toBe(403);
  });
});

function toNum2(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  return Math.round(Number(String(v)) * 100) / 100;
}

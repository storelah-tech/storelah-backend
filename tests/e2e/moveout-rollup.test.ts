// Track A A6 — roll-up, status editor, former customers, portal safety.
//
// Handoff R5 (status editor + roll-up + former-customer history) through the
// API. Every expected value is hand-derived; no client total is ever sent.
// The portal half pins the R5/customer-freeze rule: former rentals return
// the SAME response shapes with no future deduction for ended rentals.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PIN, api, createOperator, prisma, resetDb, seedMoveInWorld, uniqueEmail, type Operator } from './fixtures';
import { runBilling } from '../../src/core/finance/billing';

// A-17: pin the JS clock so the transfer effective-date guard is
// deterministic (SG today 2026-11-21, so the fixed 2026-11-20 fixture stays
// due). Only Date is faked; timers/sockets keep working.
const PINNED_NOW = new Date('2026-11-21T00:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PINNED_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

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

let unitSeq = 0;
async function makeUnit(w: World, rate: number) {
  unitSeq += 1;
  return prisma.unit.create({
    data: {
      branchId: w.branchId,
      floorId: w.floorId,
      sizeId: w.sizeId,
      unitCode: `RU-E2E-${unitSeq}`,
      sqft: 50,
      monthlyRate: rate,
      status: 'AVAILABLE',
      climateControl: 'Ambient climate',
    },
  });
}

async function makeTenant(w: World, unitId: string, rate: number, email = uniqueEmail()) {
  return prisma.tenant.create({
    data: {
      name: 'E2E Rollup',
      email,
      mobile: '81234567',
      unitId,
      moveInDate: new Date('2026-09-14T00:00:00.000Z'),
      nextPayment: new Date('2026-12-05T00:00:00.000Z'),
      monthlyRate: rate,
      psf: rate / 50,
      status: 'ACTIVE',
      branchId: w.branchId,
    },
  });
}

let invoiceSeq = 0;
async function makeInvoice(tenantId: string, unitId: string, billedMonth: string, amount: number, paid: number | null) {
  const due = new Date(`${billedMonth}-05T00:00:00.000Z`);
  invoiceSeq += 1;
  return prisma.invoice.create({
    data: {
      invoiceNo: `INV-RU-${invoiceSeq}-${billedMonth}`,
      tenantId,
      unitId,
      billedMonth: new Date(`${billedMonth}-01T00:00:00.000Z`),
      dueDate: due,
      amount,
      amountPaid: paid,
      status: paid != null && paid >= amount ? 'PAID' : 'DUE',
      paidAt: paid != null ? due : null,
    },
  });
}

async function registerCustomer(email: string): Promise<string> {
  const reg = await api.post('/api/v1/customer/register').send({
    name: 'E2E Rollup',
    email,
    mobile: '81234567',
    password: 'e2e-rollup-1',
    type: 'PERSONAL',
  });
  expect(reg.status).toBe(201);
  return reg.body.data.token as string;
}

async function portal(token: string) {
  const res = await api.get('/api/v1/customer/portal').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.data;
}

describe('roll-up — multi-unit mixes', () => {
  let w: World;
  let owner: Operator;
  let op: Operator;
  let approver: Operator;
  let executor: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    owner = await createOperator('OWNER');
    op = await createOperator('FINANCE_OPERATOR');
    approver = await createOperator('FINANCE_APPROVER');
    executor = await createOperator('FINANCE_APPROVER');
  });

  it('rolls up two concurrent units: rents sum, open settlements and ledger balance', async () => {
    const email = uniqueEmail();
    const unitA = await makeUnit(w, 600);
    const unitB = await makeUnit(w, 400);
    const tenantA = await makeTenant(w, unitA.id, 600, email);
    const tenantB = await makeTenant(w, unitB.id, 400, email);
    await makeInvoice(tenantA.id, unitA.id, '2026-10', 600, 600);
    await makeInvoice(tenantB.id, unitB.id, '2026-10', 400, null);
    // One open manual refund on unit B (PENDING_APPROVAL, signed −50).
    const refund = await api.post(`${CMS}/finance/settlements`).set('Authorization', op.auth).send({
      tenantId: tenantB.id, unitId: unitB.id, amount: 50,
      reasonCode: 'service-recovery', returnMethod: 'WALLET', notes: 'Goodwill credit.',
    });
    expect(refund.status).toBe(201);

    const res = await api.get(`${CMS}/tenants/${tenantA.id}/rollup`).set('Authorization', owner.auth);
    expect(res.status).toBe(200);
    const rollup = res.body.data;
    expect(rollup.derivedStatus).toBe('ACTIVE');
    expect(rollup.derivedStatusLabel).toBe('Active');
    expect(rollup.rentals).toHaveLength(2);
    expect(rollup.rentals.map((r: { unitCode: string }) => r.unitCode).sort()).toEqual(
      [unitA.unitCode, unitB.unitCode].sort(),
    );
    expect(rollup.previousRentals).toEqual([]);
    expect(rollup.totals).toMatchObject({
      currency: 'SGD', activeRent: 1000, depositsHeld: 0,
      openSettlementBalance: -50, openSettlementCount: 1, outstandingInvoices: 400,
    });
    expect(rollup.openSettlements).toHaveLength(1);
    // The CMS profile gains the same keys additively — legacy keys untouched.
    const profile = (await api.get(`${CMS}/tenants/${tenantA.id}/profile`).set('Authorization', owner.auth)).body.data;
    expect(profile.units).toHaveLength(2);
    expect(profile.monthlyDeductions).toBe(1000);
    expect(profile.rentals).toHaveLength(2);
    expect(profile.previousRentals).toEqual([]);
    expect(profile.totals).toMatchObject({ activeRent: 1000, openSettlementBalance: -50 });
    expect(profile.documents.length).toBeGreaterThanOrEqual(3); // 2 invoices + 1 settlement
    expect(profile.derivedStatus).toBe('ACTIVE');
  });

  it('mid-cycle transfer: source moves to previous, destination bills at destination rates', async () => {
    // §11.5 worked example: effective 20 Nov (11/30 days), source 547.20 →
    // credit 200.64, dest 661.50 → charge 242.55, net 41.91 amount due.
    const email = uniqueEmail();
    const source = await makeUnit(w, 547.2);
    const dest = await makeUnit(w, 661.5);
    const tenant = await makeTenant(w, source.id, 547.2, email);
    const submitted = await api.post(`${CMS}/transfers`).set('Authorization', op.auth).send({
      tenantId: tenant.id, toUnitId: dest.id, effectiveDate: '2026-11-20',
    });
    expect(submitted.status).toBe(201);
    const tid = submitted.body.data.settlement.id as string;
    await api.post(`${CMS}/transfers/${tid}/approve`).set('Authorization', approver.auth).send({});
    const done = await api.post(`${CMS}/transfers/${tid}/execute`).set('Authorization', executor.auth).send({});
    expect(done.status).toBe(200);
    expect(done.body.data.settlement.status).toBe('POSTED');

    const rollup = (await api.get(`${CMS}/tenants/${tenant.id}/rollup`).set('Authorization', owner.auth)).body.data;
    expect(rollup.rentals).toHaveLength(1);
    expect(rollup.rentals[0]).toMatchObject({ unitCode: dest.unitCode, netRent: 661.5, displayStatus: 'ACTIVE' });
    expect(rollup.previousRentals).toHaveLength(1);
    expect(rollup.previousRentals[0]).toMatchObject({
      unitCode: source.unitCode, endReason: 'TRANSFER', status: 'FORMER_CUSTOMER', transferCredit: 200.64,
    });
    expect(rollup.transferHistory).toHaveLength(1);
    expect(rollup.transferHistory[0]).toMatchObject({
      ref: submitted.body.data.settlement.ref, status: 'POSTED', amount: 41.91,
      fromUnitCode: source.unitCode, toUnitCode: dest.unitCode,
    });
    expect(rollup.ledgerLines).toHaveLength(2);
    expect(rollup.totals).toMatchObject({ activeRent: 661.5 });
    expect(rollup.derivedStatus).toBe('ACTIVE');
    // Next deduction follows the destination unit at destination rates.
    const profile = (await api.get(`${CMS}/tenants/${tenant.id}/profile`).set('Authorization', owner.auth)).body.data;
    expect(profile.units).toHaveLength(1);
    expect(profile.units[0].unitCode).toBe(dest.unitCode);
    expect(profile.monthlyDeductions).toBe(661.5);
  });

  it('ended rental: former roll-up, no future billing, byte-identical portal shape with no future deduction', async () => {
    const email = uniqueEmail();
    const token = await registerCustomer(email);
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600, email);
    const before = await portal(token);
    const beforeKeys = Object.keys(before).sort();

    // Month-end move-out: 31 Oct (already past) → unused 0, no charges →
    // zero settlement → the case completes synchronously on inspection
    // (no processor involved). Inspection requires final day ≤ today.
    const c = (await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
      tenantId: tenant.id, finalAccessDate: '2026-10-31', requestReceivedAt: '2026-09-20',
      requestChannel: CHANNEL, reasonCode: REASON,
    })).body.data;
    const inspection = await api.post(`${CMS}/move-out-cases/${c.id}/inspection`).set('Authorization', owner.auth).send({
      unitEmpty: true, doorLockWallsFloorChecked: true, accessRevoked: true,
      releaseConfirmed: true, releaseStatus: 'READY', notes: 'Unit empty, evidence attached.',
    });
    expect(inspection.status).toBe(201);
    expect(inspection.body.data.case.status).toBe('COMPLETED');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).unitId).toBeNull();

    // Roll-up: no current rentals, one previous segment, zero recurring.
    const rollup = (await api.get(`${CMS}/tenants/${tenant.id}/rollup`).set('Authorization', owner.auth)).body.data;
    expect(rollup.rentals).toEqual([]);
    expect(rollup.previousRentals).toHaveLength(1);
    expect(rollup.previousRentals[0]).toMatchObject({
      unitCode: unit.unitCode, endReason: 'MOVE_OUT', status: 'FORMER_CUSTOMER', endedAt: '2026-10-31',
    });
    expect(rollup.derivedStatus).toBe('FORMER_CUSTOMER');
    expect(rollup.totals).toMatchObject({ activeRent: 0, monthlyRecurring: 0, depositsHeld: 0 });
    const profile = (await api.get(`${CMS}/tenants/${tenant.id}/profile`).set('Authorization', owner.auth)).body.data;
    expect(profile.units).toEqual([]);
    expect(profile.monthlyDeductions).toBe(0);

    // The November billing run bills nothing for the ended rental.
    const nov = await runBilling({ branchId: w.branchId, billingMonth: '2026-11', actor: 'e2e-finance' });
    expect(nov.created).toBe(0);
    expect(await prisma.invoice.count({ where: { tenantId: tenant.id } })).toBe(0);

    // Portal: byte-identical top-level keys, ended rental carries history but
    // no future deduction (nextPayment null, no post-access invoices).
    const after = await portal(token);
    expect(Object.keys(after).sort()).toEqual(beforeKeys);
    expect(after.tenancy).toMatchObject({ nextPayment: null });
    expect(after.units).toEqual([]);
    const cutoff = new Date('2026-10-31T00:00:00.000Z').getTime();
    for (const inv of after.invoices as Array<{ billedMonth: string }>) {
      expect(new Date(inv.billedMonth).getTime()).toBeLessThanOrEqual(cutoff);
    }
  });
});

describe('status editor — guarded transitions', () => {
  let w: World;
  let owner: Operator;

  beforeEach(async () => {
    await resetDb();
    w = await seedWorld();
    owner = await createOperator('OWNER');
  });

  async function setStatus(auth: string, tenantId: string, body: Record<string, unknown>) {
    return api.post(`${CMS}/tenants/${tenantId}/status`).set('Authorization', auth).send(body);
  }

  it('moves through the lifecycle statuses with reason, version guard and audit', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const missing = await setStatus(owner.auth, tenant.id, { status: 'SUSPENDED', reason: '  ' });
    expect(missing.status).toBe(400);

    const suspended = await setStatus(owner.auth, tenant.id, { status: 'SUSPENDED', reason: 'Payment hold.', expectedVersion: 0 });
    expect(suspended.status).toBe(201);
    expect(suspended.body.data).toMatchObject({
      fromStatus: 'ACTIVE', toStatus: 'SUSPENDED', toStatusLabel: 'Suspended',
      tenantStatus: 'SUSPENDED', accessRestricted: false, version: 1,
    });
    expect(suspended.body.data.safeguard).toMatch('never creates a refund');

    // A stale write loses the optimistic-locking race.
    const stale = await setStatus(owner.auth, tenant.id, { status: 'ACTIVE', reason: 'Late write.', expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE');

    const restricted = await setStatus(owner.auth, tenant.id, { status: 'ACCESS_RESTRICTED', reason: 'Door fault.', expectedVersion: 1 });
    expect(restricted.status).toBe(201);
    expect(restricted.body.data).toMatchObject({ tenantStatus: 'SUSPENDED', accessRestricted: true, version: 2 });

    // A-20: Pending move-out while the rental still holds a unit is rejected
    // with the §7 safeguard copy — that state comes only from the move-out
    // workflow (a direct edit would set NOTICE with no MoveOutCase).
    const held = await setStatus(owner.auth, tenant.id, { status: 'PENDING_MOVE_OUT', reason: 'Notice served.', expectedVersion: 2 });
    expect(held.status).toBe(409);
    expect(held.body.error.message).toMatch('never creates a refund');
    // Zero status change / audit rows from the rejected edit.
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).status).toBe('SUSPENDED');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).version).toBe(2);
    expect(await prisma.rentalStatusChange.count({ where: { tenantId: tenant.id } })).toBe(2);
    expect(await prisma.financeAuditEvent.count({ where: { action: 'rental.status_changed', entityId: tenant.id } })).toBe(2);

    // Without a unit (already released) the workflow state is still allowed.
    const released = await prisma.tenant.create({
      data: {
        name: 'E2E Released', email: uniqueEmail(), mobile: '81234567',
        moveInDate: new Date('2026-09-14T00:00:00.000Z'), nextPayment: new Date('2026-12-05T00:00:00.000Z'),
        monthlyRate: 600, psf: 600 / 50, status: 'ACTIVE', branchId: w.branchId,
      },
    });
    const pending = await setStatus(owner.auth, released.id, { status: 'PENDING_MOVE_OUT', reason: 'Notice served.', expectedVersion: 0 });
    expect(pending.status).toBe(201);
    expect(pending.body.data).toMatchObject({ tenantStatus: 'NOTICE', version: 1 });
    expect(pending.body.data.safeguard).toMatch('never creates a refund');

    const active = await setStatus(owner.auth, tenant.id, { status: 'ACTIVE', reason: 'Resolved.', expectedVersion: 2 });
    expect(active.body.data).toMatchObject({ tenantStatus: 'ACTIVE', accessRestricted: false, version: 3 });

    // Immutable audit: one RentalStatusChange per accepted transition + finance trail.
    expect(await prisma.rentalStatusChange.count({ where: { tenantId: tenant.id } })).toBe(3);
    const audits = await prisma.financeAuditEvent.findMany({ where: { action: 'rental.status_changed', entityId: tenant.id } });
    expect(audits).toHaveLength(3);
    const events = await prisma.financeEvent.findMany({ where: { type: 'rental.status_changed' } });
    expect(events).toHaveLength(4);
    // The safeguard held: the unit never moved and access was never revoked.
    const untouched = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(untouched.unitId).toBe(unit.id);
    expect((await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })).status).toBe('AVAILABLE');
  });

  it('blocks Former while a sibling rental is active or Finance is open', async () => {
    const email = uniqueEmail();
    const unitA = await makeUnit(w, 600);
    const unitB = await makeUnit(w, 400);
    const tenantA = await makeTenant(w, unitA.id, 600, email);
    await makeTenant(w, unitB.id, 400, email);
    // A-20: a rental that still holds a unit can never be marked Former
    // directly — that state comes only from the move-out workflow.
    const held = await setStatus(owner.auth, tenantA.id, { status: 'FORMER_CUSTOMER', reason: 'Gone.', expectedVersion: 0 });
    expect(held.status).toBe(409);
    expect(held.body.error.message).toMatch('never creates a refund');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantA.id } })).status).toBe('ACTIVE');
    // Release the unit (workflow-equivalent) — the sibling guard still blocks.
    await prisma.tenant.update({ where: { id: tenantA.id }, data: { unitId: null } });
    const blocked = await setStatus(owner.auth, tenantA.id, { status: 'FORMER_CUSTOMER', reason: 'Gone.', expectedVersion: 0 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch('never creates a refund');

    // A sole rental that still holds its unit is likewise rejected; once the
    // unit is released with no open case or settlement it may be marked Former.
    const solo = await makeUnit(w, 300);
    const lone = await makeTenant(w, solo.id, 300);
    const loneHeld = await setStatus(owner.auth, lone.id, { status: 'FORMER_CUSTOMER', reason: 'Walk-in closed.', expectedVersion: 0 });
    expect(loneHeld.status).toBe(409);
    expect(loneHeld.body.error.message).toMatch('never creates a refund');
    await prisma.tenant.update({ where: { id: lone.id }, data: { unitId: null } });
    const former = await setStatus(owner.auth, lone.id, { status: 'FORMER_CUSTOMER', reason: 'Walk-in closed.', expectedVersion: 0 });
    expect(former.status).toBe(201);
    expect(former.body.data).toMatchObject({ tenantStatus: 'INACTIVE', version: 1 });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: lone.id } })).unitId).toBeNull();

    // An open move-out case blocks the direct edit — close via the workflow.
    const unitC = await makeUnit(w, 500);
    const tenantC = await makeTenant(w, unitC.id, 500);
    await api.post(`${CMS}/move-out-cases`).set('Authorization', owner.auth).send({
      tenantId: tenantC.id, finalAccessDate: '2026-11-15', requestReceivedAt: '2026-10-10',
      requestChannel: CHANNEL, reasonCode: REASON,
    });
    // Recording the case moved the rental to NOTICE (version 0 → 1) — release
    // the unit so the open-case guard (not the unit guard) is exercised here.
    const fresh = (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantC.id } })).version;
    await prisma.tenant.update({ where: { id: tenantC.id }, data: { unitId: null } });
    const cased = await setStatus(owner.auth, tenantC.id, { status: 'FORMER_CUSTOMER', reason: 'Skip.', expectedVersion: fresh });
    expect(cased.status).toBe(409);
    expect(cased.body.error.message).toMatch('still open');
  });

  it('re-approving a new APPROVED settlement names the state, not the legacy flow', async () => {
    const unit = await makeUnit(w, 600);
    const tenant = await makeTenant(w, unit.id, 600);
    const requester = await createOperator('FINANCE_OPERATOR');
    const submitted = await api.post(`${CMS}/finance/settlements`).set('Authorization', requester.auth).send({
      tenantId: tenant.id, unitId: unit.id, amount: 20,
      reasonCode: 'service-recovery', returnMethod: 'WALLET', notes: 'Goodwill credit.',
    });
    expect(submitted.status).toBe(201);
    const approver = await createOperator('FINANCE_APPROVER');
    const first = await api.post(`${CMS}/finance/settlements/${submitted.body.data.settlement.id}/approve`).set('Authorization', approver.auth).send({});
    expect(first.status).toBe(200);
    const again = await api.post(`${CMS}/finance/settlements/${submitted.body.data.settlement.id}/approve`).set('Authorization', approver.auth).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch('Only settlements awaiting approval');
    expect(again.body.error.message).not.toMatch('legacy');
  });
});

// Stripe payment completion auto-marks matching leads WON (webhook path).
//
// Calls applyCheckoutCompleted directly with a synthetic checkout.session
// object (no Stripe network): covers the webhook's Booking CONFIRMED +
// Invoice PAID path plus the payment-won attribution — forward-only,
// idempotent, LOST never resurrected, no-match still succeeds, and the manual
// PATCH (core updateLead) path to WON keeps working.

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { applyCheckoutCompleted } from '../../src/core/checkout';
import { updateLead } from '../../src/core/leads';
import { PIN, prisma, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function completedSession(
  sessionId: string,
  bookingRef: string,
  amountCents: number,
): Stripe.Checkout.Session {
  return {
    id: sessionId,
    metadata: { bookingRef },
    payment_intent: `pi_${shortId()}`,
    amount_total: amountCents,
  } as unknown as Stripe.Checkout.Session;
}

interface BookingWorld {
  branchId: string;
  email: string;
  mobile: string;
  bookingRef: string;
  sessionId: string;
  invoiceId: string;
}

/** PENDING_PAYMENT booking + DUE invoice for the pinned rentable unit. */
async function seedBookingWorld(contact: { email: string; mobile: string }): Promise<BookingWorld> {
  const branch = await prisma.branch.findUnique({ where: { code: PIN.branchCode } });
  const unit = await prisma.unit.findUnique({ where: { unitCode: PIN.rentableUnit } });
  if (!branch || !unit) throw new Error('[e2e] move-in world not seeded');

  const tenant = await prisma.tenant.create({
    data: {
      name: 'E2E Payer',
      email: contact.email,
      mobile: contact.mobile,
      unitId: unit.id,
      moveInDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      monthlyRate: 120,
      psf: 2.4,
      status: 'ACTIVE',
      branchId: branch.id,
    },
  });
  const bookingRef = `SL-E2E-${shortId()}`;
  const sessionId = `cs_test_${shortId()}`;
  await prisma.booking.create({
    data: {
      bookingRef,
      tenantId: tenant.id,
      unitId: unit.id,
      moveInDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      duration: '3 months',
      amount: 120,
      status: 'PENDING_PAYMENT',
      stripeSessionId: sessionId,
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNo: `INV-E2E-${shortId()}`,
      tenantId: tenant.id,
      unitId: unit.id,
      amount: 120,
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'DUE',
    },
  });
  return { branchId: branch.id, email: contact.email, mobile: contact.mobile, bookingRef, sessionId, invoiceId: invoice.id };
}

async function makeLead(data: {
  name: string;
  email?: string | null;
  mobile?: string | null;
  stage?: 'NEW_ENQUIRY' | 'CONTACTED' | 'PROPOSAL_SENT' | 'WON' | 'LOST';
  unitCode?: string | null;
  preferredBranchId?: string | null;
}) {
  return prisma.lead.create({
    data: {
      name: data.name,
      email: data.email ?? null,
      mobile: data.mobile ?? null,
      stage: data.stage ?? 'NEW_ENQUIRY',
      unitCode: data.unitCode ?? null,
      preferredBranchId: data.preferredBranchId ?? null,
    },
  });
}

describe('checkout completion marks matching leads WON', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('payment flips booking/invoice and marks the contact+unit+branch lead WON', async () => {
    const world = await seedBookingWorld({ email: uniqueEmail(), mobile: '81234567' });
    const lead = await makeLead({
      name: 'E2E Prospect',
      email: world.email,
      mobile: world.mobile,
      stage: 'PROPOSAL_SENT',
      unitCode: PIN.rentableUnit,
      preferredBranchId: world.branchId,
    });

    const result = await applyCheckoutCompleted(completedSession(world.sessionId, world.bookingRef, 12000));

    expect(result).toEqual({ bookingRef: world.bookingRef, applied: true });
    await expect(prisma.booking.findUnique({ where: { bookingRef: world.bookingRef } })).resolves
      .toMatchObject({ status: 'CONFIRMED' });
    await expect(prisma.invoice.findUnique({ where: { id: world.invoiceId } })).resolves
      .toMatchObject({ status: 'PAID' });
    await expect(prisma.lead.findUnique({ where: { id: lead.id } })).resolves
      .toMatchObject({ stage: 'WON' });
  });

  it('mobile-only contact matches; LOST is never resurrected; other-unit lead is left alone', async () => {
    const world = await seedBookingWorld({ email: uniqueEmail(), mobile: '87654321' });
    const mobileOnly = await makeLead({
      name: 'Mobile Prospect',
      email: 'someone-else@test.local',
      mobile: world.mobile,
      stage: 'CONTACTED',
    });
    const otherUnit = await makeLead({
      name: 'Other Unit Prospect',
      email: world.email,
      mobile: world.mobile,
      stage: 'NEW_ENQUIRY',
      unitCode: PIN.guestUnit,
      preferredBranchId: world.branchId,
    });
    const lost = await makeLead({
      name: 'Lost Prospect',
      email: world.email,
      mobile: world.mobile,
      stage: 'LOST',
      unitCode: PIN.rentableUnit,
      preferredBranchId: world.branchId,
    });

    const result = await applyCheckoutCompleted(completedSession(world.sessionId, world.bookingRef, 12000));

    expect(result.applied).toBe(true);
    await expect(prisma.lead.findUnique({ where: { id: mobileOnly.id } })).resolves
      .toMatchObject({ stage: 'WON' });
    await expect(prisma.lead.findUnique({ where: { id: otherUnit.id } })).resolves
      .toMatchObject({ stage: 'NEW_ENQUIRY' });
    await expect(prisma.lead.findUnique({ where: { id: lost.id } })).resolves
      .toMatchObject({ stage: 'LOST' });
  });

  it('replaying the same webhook is a safe no-op and leaves WON intact', async () => {
    const world = await seedBookingWorld({ email: uniqueEmail(), mobile: '80001111' });
    const lead = await makeLead({
      name: 'Replay Prospect',
      email: world.email,
      mobile: world.mobile,
      stage: 'VIEWING_BOOKED',
      unitCode: PIN.rentableUnit,
      preferredBranchId: world.branchId,
    });
    const session = completedSession(world.sessionId, world.bookingRef, 12000);

    const first = await applyCheckoutCompleted(session);
    expect(first).toEqual({ bookingRef: world.bookingRef, applied: true });

    const second = await applyCheckoutCompleted(session);
    expect(second).toEqual({ bookingRef: world.bookingRef, applied: false });

    await expect(prisma.lead.findUnique({ where: { id: lead.id } })).resolves
      .toMatchObject({ stage: 'WON' });
    await expect(prisma.booking.findUnique({ where: { bookingRef: world.bookingRef } })).resolves
      .toMatchObject({ status: 'CONFIRMED' });
    await expect(prisma.invoice.findUnique({ where: { id: world.invoiceId } })).resolves
      .toMatchObject({ status: 'PAID' });
  });

  it('checkout still succeeds when no lead matches', async () => {
    const world = await seedBookingWorld({ email: uniqueEmail(), mobile: '89998888' });

    const result = await applyCheckoutCompleted(completedSession(world.sessionId, world.bookingRef, 12000));

    expect(result).toEqual({ bookingRef: world.bookingRef, applied: true });
    await expect(prisma.booking.findUnique({ where: { bookingRef: world.bookingRef } })).resolves
      .toMatchObject({ status: 'CONFIRMED' });
    await expect(prisma.invoice.findUnique({ where: { id: world.invoiceId } })).resolves
      .toMatchObject({ status: 'PAID' });
  });

  it('an already-WON lead is left untouched (forward-only)', async () => {
    const world = await seedBookingWorld({ email: uniqueEmail(), mobile: '87776666' });
    const won = await makeLead({
      name: 'Already Won',
      email: world.email,
      mobile: world.mobile,
      stage: 'WON',
      unitCode: PIN.rentableUnit,
      preferredBranchId: world.branchId,
    });

    const result = await applyCheckoutCompleted(completedSession(world.sessionId, world.bookingRef, 12000));

    expect(result.applied).toBe(true);
    const after = await prisma.lead.findUnique({ where: { id: won.id } });
    expect(after?.stage).toBe('WON');
    // Excluded from the conditional write, so the row is byte-identical.
    expect(after?.updatedAt.getTime()).toBe(won.updatedAt.getTime());
  });

  it('manual updateLead to WON still works as before', async () => {
    const lead = await makeLead({ name: 'Manual Prospect', email: uniqueEmail(), stage: 'CONTACTED' });

    const updated = await updateLead(lead.id, { stage: 'WON' });

    expect(updated.stage).toBe('WON');
    await expect(prisma.lead.findUnique({ where: { id: lead.id } })).resolves
      .toMatchObject({ stage: 'WON' });
  });
});

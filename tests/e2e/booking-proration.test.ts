// Booking due-today proration parity: POST /customer/bookings must invoice
// the frontend Due Today figure (discounted rent prorated by move-in day +
// catalog protection/addons, deposit/admin $0, GST 0) so the Stripe
// `unit_amount = Math.round(dueToday * 100)` charges exactly what the price
// summary showed.
//
// Pinned calendar: October 2026 has 31 days (move-in 15th → 17/31 incl. the
// move-in day), November 2026 has 30 days (move-in 1st → full month).
// Pinned rentable unit BM-01-01 is rate S$120 (SMALL).
//
// Expected values (hand-computed frontend formula):
//   full-month, no promos/extras ......... 120
//   mid-month Oct 15, no promos/extras ... round(120 * 17/31) = 66
//   mid-month + 10% plan matrix .......... discPrice round(120*0.9)=108 → round(108*17/31) = 59
//   mid-month + $20 first-month promo
//     + $8 protection + 3×$5 addons ..... 66 − 20 + 8 + 15 = 69
//   full-month + 10% recurring promo ..... round(120*0.9) = 108

import { beforeEach, describe, expect, it } from 'vitest';
import { PIN, api, prisma, resetDb, seedMoveInWorld, uniqueEmail } from './fixtures';

// Pinned calendar (Zulu instants — the route's zod datetime() rejects
// explicit offsets; both instants are SGT midnights, which is also what the
// server proration basis resolves): October 2026 has 31 days (SGT move-in
// 15th → 17/31 incl. the move-in day), November 2026 has 30 days (SGT
// move-in 1st → full month).
const MID_MONTH = '2026-10-14T16:00:00.000Z'; // SGT 2026-10-15 00:00
const FULL_MONTH = '2026-10-31T16:00:00.000Z'; // SGT 2026-11-01 00:00

async function registerOwner(): Promise<{ token: string; email: string }> {
  const email = uniqueEmail();
  const reg = await api.post('/api/v1/customer/register').send({
    name: 'E2E Proration',
    email,
    mobile: '81234567',
    password: 'e2e-proration-1',
    type: 'PERSONAL',
  });
  expect(reg.status).toBe(201);
  return { token: reg.body.data.token as string, email };
}

async function book(token: string, body: Record<string, unknown>) {
  const res = await api
    .post('/api/v1/customer/bookings')
    .set('Authorization', `Bearer ${token}`)
    .send({ unitCode: PIN.rentableUnit, durationMonths: 3, ...body });
  expect(res.status).toBe(201);
  return res.body.data;
}

async function invoicedAmount(bookingRef: string): Promise<number> {
  const booking = await prisma.booking.findUnique({ where: { bookingRef } });
  const invoice = await prisma.invoice.findFirst({
    where: { tenantId: booking!.tenantId, unitId: booking!.unitId, status: 'DUE' },
    orderBy: { createdAt: 'desc' },
  });
  return Number(invoice!.amount);
}

describe('booking due-today proration parity', () => {
  beforeEach(async () => {
    await resetDb();
    await seedMoveInWorld();
  });

  it('full-month move-in (1st) invoices the full monthly rate', async () => {
    const { token } = await registerOwner();
    const data = await book(token, { moveInDate: FULL_MONTH });

    expect(data.dueToday).toBe(120);
    expect(data.amount).toBe(120); // unchanged: monthly-rate snapshot
    expect(data.breakdown).toMatchObject({
      base: 120,
      prorated: 120,
      remainingDays: 30,
      totalDays: 30,
    });
    await expect(invoicedAmount(data.bookingRef)).resolves.toBe(120);
    // Stripe charges cents of the invoiced figure.
    expect(Math.round(data.dueToday * 100)).toBe(12000);
  });

  it('mid-month move-in (15th) invoices prorated rent', async () => {
    const { token } = await registerOwner();
    const data = await book(token, { moveInDate: MID_MONTH });

    expect(data.dueToday).toBe(66); // round(120 * 17/31)
    expect(data.amount).toBe(120); // monthly-rate snapshot untouched
    expect(data.breakdown).toMatchObject({
      base: 120,
      monthlyStorage: 120,
      proratedFull: 66,
      prorated: 66,
      remainingDays: 17,
      totalDays: 31,
    });
    await expect(invoicedAmount(data.bookingRef)).resolves.toBe(66);
    expect(Math.round(data.dueToday * 100)).toBe(6600);
  });

  it('plan-matrix pct discounts the rent before proration', async () => {
    await prisma.promotionPlan.create({
      data: {
        kind: 'DISCOUNT_MATRIX',
        name: 'E2E 10% plan',
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-01-01'),
        matrixCells: {
          create: { sizeCategory: 'SMALL', accessType: 'Standard', commitmentMonths: 3, discountPct: 10 },
        },
      },
    });
    const { token } = await registerOwner();
    const data = await book(token, { moveInDate: MID_MONTH });

    // discPrice round(120 * 0.9) = 108 → round(108 * 17/31) = 59.
    expect(data.dueToday).toBe(59);
    expect(data.breakdown).toMatchObject({ discountPct: 10, discPrice: 108, prorated: 59 });
    await expect(invoicedAmount(data.bookingRef)).resolves.toBe(59);
  });

  it('first-month promo + catalog protection/addons land post-proration at catalog prices', async () => {
    await prisma.promotion.create({
      data: {
        code: 'E2E-FIRST20',
        name: 'E2E first-month $20',
        discountType: 'FLAT',
        discountValue: 20,
        active: true,
        applyTo: 'First invoice only',
      },
    });
    await prisma.protectionPlan.upsert({
      where: { id: 'essential' },
      update: { price: 8, active: true },
      create: { id: 'essential', name: 'Essential', price: 8, active: true },
    });
    await prisma.addon.upsert({
      where: { id: 'medium-box' },
      update: { price: 5, active: true },
      create: { id: 'medium-box', name: 'Medium Box', price: 5, active: true },
    });

    const { token } = await registerOwner();
    const data = await book(token, {
      moveInDate: MID_MONTH,
      promoCode: 'E2E-FIRST20',
      // Inflated client costs — the catalog prices ($8 / $5) must win.
      protectionPlan: { tier: 'essential', cost: 999 },
      addons: [{ name: 'Medium Box', qty: 3, price: 999 }],
    });

    // 66 (prorated) − 20 (first-month) + 8 (protection) + 15 (addons) = 69.
    expect(data.dueToday).toBe(69);
    expect(data.breakdown).toMatchObject({
      prorated: 46,
      firstMonthDiscount: 20,
      protection: 8,
      addons: 15,
    });
    await expect(invoicedAmount(data.bookingRef)).resolves.toBe(69);
  });

  it('recurring percent promo defines the discounted rent (full month)', async () => {
    await prisma.promotion.create({
      data: {
        code: 'E2E-RECUR10',
        name: 'E2E recurring 10%',
        discountType: 'PERCENTAGE',
        discountValue: 10,
        active: true,
        applyTo: 'Every invoice',
      },
    });
    const { token } = await registerOwner();
    const data = await book(token, { moveInDate: FULL_MONTH, promoCode: 'E2E-RECUR10' });

    expect(data.dueToday).toBe(108); // round(120 * 0.9), no proration on the 1st
    expect(data.breakdown).toMatchObject({ discountPct: 10, discPrice: 108 });
    await expect(invoicedAmount(data.bookingRef)).resolves.toBe(108);
  });
});

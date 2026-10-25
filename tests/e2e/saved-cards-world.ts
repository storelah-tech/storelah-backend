// Shared seed for the saved-card specs: one registered customer holding two
// Tenant rows (as linkTenantForPaidBooking creates them) — unit A paid
// (CONFIRMED booking, DUE recurring invoice), unit B still PENDING_PAYMENT
// (DUE first invoice) — plus a PAID invoice for the "already paid" gate.

import { expect } from 'vitest';
import { PIN, api, prisma } from './fixtures';

export interface CardPayerWorld {
  token: string;
  customerId: string;
  recurringInvoiceId: string;
  pendingInvoiceId: string;
  paidInvoiceId: string;
}

export async function registerCustomer(email: string): Promise<{ token: string; customerId: string }> {
  const reg = await api.post('/api/v1/customer/register').send({
    name: 'E2E Card Payer',
    email,
    mobile: '81234567',
    password: 'e2e-saved-card-1',
    type: 'PERSONAL',
  });
  expect(reg.status).toBe(201);
  const customer = await prisma.customer.findUnique({ where: { email } });
  if (!customer) throw new Error('[e2e] registered customer missing');
  return { token: reg.body.data.token as string, customerId: customer.id };
}

export async function seedCardPayer(email: string): Promise<CardPayerWorld> {
  const { token, customerId } = await registerCustomer(email);
  const branch = await prisma.branch.findUnique({ where: { code: PIN.branchCode } });
  const unitA = await prisma.unit.findUnique({ where: { unitCode: PIN.rentableUnit } });
  const unitB = await prisma.unit.findUnique({ where: { unitCode: PIN.guestUnit } });
  if (!branch || !unitA || !unitB) throw new Error('[e2e] move-in world not seeded');
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();

  const tenantFor = (unitId: string) =>
    prisma.tenant.create({
      data: {
        name: 'E2E Card Payer',
        email,
        unitId,
        moveInDate: new Date(),
        monthlyRate: 120,
        psf: 2.4,
        status: 'ACTIVE',
        branchId: branch.id,
      },
    });
  const tenantA = await tenantFor(unitA.id);
  const tenantB = await tenantFor(unitB.id);
  const booking = (ref: string, tenantId: string, unitId: string, status: 'CONFIRMED' | 'PENDING_PAYMENT') =>
    prisma.booking.create({
      data: { bookingRef: ref, tenantId, unitId, moveInDate: new Date(), duration: '1 month', amount: 120, status },
    });
  await booking(`SL-E2E-CA${suffix}`, tenantA.id, unitA.id, 'CONFIRMED');
  await booking(`SL-E2E-CB${suffix}`, tenantB.id, unitB.id, 'PENDING_PAYMENT');

  const invoice = (no: string, tenantId: string, unitId: string, status: 'PAID' | 'DUE') =>
    prisma.invoice.create({
      data: {
        invoiceNo: `INV-E2E-C${no}${suffix}`,
        tenantId,
        unitId,
        amount: 120,
        dueDate: new Date(),
        status,
        ...(status === 'PAID' ? { paidAt: new Date(), amountPaid: 120, method: 'Card' } : {}),
      },
    });
  const paid = await invoice('1', tenantA.id, unitA.id, 'PAID');
  const recurring = await invoice('2', tenantA.id, unitA.id, 'DUE');
  const pending = await invoice('3', tenantB.id, unitB.id, 'DUE');
  return {
    token,
    customerId,
    recurringInvoiceId: recurring.id,
    pendingInvoiceId: pending.id,
    paidInvoiceId: paid.id,
  };
}

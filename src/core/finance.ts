import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';

type BookingWithRelations = Prisma.BookingGetPayload<{
  include: { tenant: true; unit: { include: { size: true; branch: true } } };
}>;

// Shared serializer for Booking rows — used by GET /bookings (listBookings) and
// GET /move-ins (branches.getMoveIns) so both surfaces expose one identical shape.
//
// Payment state is derived ONLY from recorded Invoice rows (matched by tenantId +
// unitId, most recent by dueDate; paidAmount sums PAID invoices for the tenant).
// Nothing is fabricated: a guest that has not paid yet truthfully reports
// invoiceStatus DUE and paidAmount 0. Every Decimal passes through toNum because
// JSON.stringify on a Prisma.Decimal throws.
export async function serializeBookings(bookings: BookingWithRelations[]) {
  const tenantIds = [...new Set(bookings.map((b) => b.tenantId))];
  const invoices = tenantIds.length
    ? await prisma.invoice.findMany({
        where: { tenantId: { in: tenantIds } },
        orderBy: { dueDate: 'desc' },
      })
    : [];

  return bookings.map((b) => {
    const forUnit = invoices.filter((i) => i.tenantId === b.tenantId && i.unitId === b.unitId);
    const latest = forUnit[0]; // most recent by dueDate
    const paidAmount = invoices
      .filter((i) => i.tenantId === b.tenantId && i.status === 'PAID')
      .reduce((sum, i) => sum + toNum(i.amount), 0);

    return {
      id: b.id,
      ref: b.bookingRef,
      tenant: b.tenant.name,
      tenantEmail: b.tenant.email,
      tenantMobile: b.tenant.mobile,
      tenantType: b.tenant.type, // GUEST | PERSONAL | BUSINESS (AccountType enum)
      unit: b.unit.unitCode,
      // Display-name fallback per docs/UNIT_CODE_AND_NAME.md rule 4.
      unitName: b.unit.name ?? b.unit.unitCode,
      size: b.unit.size.name,
      sqft: b.unit.sqft,
      branch: b.unit.branch.name,
      moveInDate: b.moveInDate,
      duration: b.duration,
      amount: toNum(b.amount),
      amountDue: latest ? toNum(latest.amount) : 0,
      invoiceStatus: latest?.status ?? null,
      method: latest?.method ?? null,
      paidAmount,
      status: b.status,
      createdAt: b.createdAt,
    };
  });
}

export async function listBookings() {
  const bookings = await prisma.booking.findMany({
    include: { tenant: true, unit: { include: { size: true, branch: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return serializeBookings(bookings);
}

export async function listInvoices(status?: string) {
  const invoices = await prisma.invoice.findMany({
    where: status && ['DUE', 'PAID', 'OVERDUE'].includes(status) ? { status: status as any } : undefined,
    include: { tenant: true, unit: true },
    orderBy: { dueDate: 'asc' },
  });

  return invoices.map((i) => ({
    id: i.id,
    no: i.invoiceNo,
    tenant: i.tenant.name,
    unit: i.unit.unitCode,
    amount: toNum(i.amount),
    dueDate: i.dueDate,
    billedMonth: i.billedMonth,
    method: i.method,
    status: i.status,
  }));
}
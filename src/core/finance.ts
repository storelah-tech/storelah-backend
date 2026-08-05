import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';

export async function listBookings() {
  const bookings = await prisma.booking.findMany({
    include: { tenant: true, unit: true },
    orderBy: { createdAt: 'desc' },
  });

  return bookings.map((b) => ({
    id: b.id,
    ref: b.bookingRef,
    tenant: b.tenant.name,
    unit: b.unit.unitCode,
    moveInDate: b.moveInDate,
    duration: b.duration,
    amount: toNum(b.amount),
    status: b.status,
    createdAt: b.createdAt,
  }));
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
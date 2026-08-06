import bcrypt from 'bcryptjs';
import { AccountType, Customer, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { CustomerJwtPayload, signCustomerToken } from '../middleware/auth';

export interface RegisterCustomerInput {
  name: string;
  email: string;
  mobile?: string;
  password: string;
  type: AccountType;
  companyName?: string;
  uen?: string;
}

export interface CreateBookingInput {
  unitCode: string;
  moveInDate: string;
  durationMonths: number;
  protectionPlan?: { tier: string; cost: number };
  addons?: Array<{ name: string; qty: number; price: number }>;
  promoCode?: string;
  movingService?: boolean;
  totalDueToday?: number;
}

export interface CustomerRequestInput {
  type: 'UPSIZE' | 'DOWNSIZE' | 'TRANSFER';
  notes?: string;
  preferredDate?: string;
}

function serializeCustomer(c: Customer) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    mobile: c.mobile,
    type: c.type,
    companyName: c.companyName,
    uen: c.uen,
  };
}

async function loadCustomer(payload: CustomerJwtPayload): Promise<Customer> {
  const customer = await prisma.customer.findUnique({ where: { id: payload.sub } });
  if (!customer) throw new AppError(401, 'UNAUTHORIZED', 'Customer not found');
  return customer;
}

// --- Auth ---------------------------------------------------------------

export async function registerCustomer(input: RegisterCustomerInput) {
  const existing = await prisma.customer.findUnique({ where: { email: input.email } });
  if (existing) throw new AppError(409, 'CONFLICT', 'An account with this email already exists');

  const passwordHash = await bcrypt.hash(input.password, 10);
  const customer = await prisma.customer.create({
    data: {
      name: input.name,
      email: input.email,
      mobile: input.mobile ?? null,
      passwordHash,
      type: input.type,
      companyName: input.companyName ?? null,
      uen: input.uen ?? null,
    },
  });

  return { token: signCustomerToken(customer), customer: serializeCustomer(customer) };
}

export async function loginCustomer(input: { email: string; password: string }) {
  const customer = await prisma.customer.findUnique({ where: { email: input.email } });
  if (!customer || !(await bcrypt.compare(input.password, customer.passwordHash))) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password');
  }
  return { token: signCustomerToken(customer), customer: serializeCustomer(customer) };
}

// --- Profile & bookings --------------------------------------------------

export async function getCustomerProfile(payload: CustomerJwtPayload) {
  const customer = await loadCustomer(payload);
  const bookings = await listCustomerBookings(payload);
  return { customer: serializeCustomer(customer), bookings };
}

export async function listCustomerBookings(payload: CustomerJwtPayload) {
  const customer = await loadCustomer(payload);
  const tenant = customer.email
    ? await prisma.tenant.findFirst({ where: { email: customer.email } })
    : null;
  if (!tenant) return [];

  const bookings = await prisma.booking.findMany({
    where: { tenantId: tenant.id },
    include: { unit: { include: { branch: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return bookings.map((b) => ({
    bookingRef: b.bookingRef,
    status: b.status,
    moveInDate: b.moveInDate,
    duration: b.duration,
    amount: toNum(b.amount),
    unitCode: b.unit.unitCode,
    sqft: b.unit.sqft,
    branchName: b.unit.branch.name,
  }));
}

type PortalUnit = Prisma.UnitGetPayload<{
  include: { size: true; branch: true; floor: true };
}>;

function serializePortalUnit(u: PortalUnit) {
  return {
    id: u.unitCode,
    code: u.unitCode,
    size: u.size.name,
    sqft: u.sqft,
    rate: toNum(u.monthlyRate),
    psf: u.sqft ? toNum(u.monthlyRate) / u.sqft : 0,
    status: u.status,
    branchName: u.branch.name,
    level: u.floor.level,
  };
}

export async function getCustomerPortal(payload: CustomerJwtPayload) {
  const customer = await loadCustomer(payload);
  const tenant = customer.email
    ? await prisma.tenant.findFirst({ where: { email: customer.email } })
    : null;

  let unit = null;
  if (tenant) {
    const current = tenant.unitId
      ? await prisma.unit.findUnique({
          where: { id: tenant.unitId, deletedAt: null },
          include: { size: true, branch: true, floor: true },
        })
      : null;
    if (current) unit = serializePortalUnit(current);

    if (!unit) {
      const latest = await prisma.booking.findFirst({
        where: { tenantId: tenant.id },
        include: { unit: { include: { size: true, branch: true, floor: true } } },
        orderBy: { createdAt: 'desc' },
      });
      if (latest) unit = serializePortalUnit(latest.unit);
    }
  }

  const invoices = tenant
    ? (
        await prisma.invoice.findMany({
          where: { tenantId: tenant.id },
          orderBy: { dueDate: 'desc' },
        })
      ).map((i) => ({
        id: i.id,
        no: i.invoiceNo,
        amount: toNum(i.amount),
        dueDate: i.dueDate,
        status: i.status,
        billedMonth: i.billedMonth,
        method: i.method,
      }))
    : [];

  const bookings = await listCustomerBookings(payload);

  return { customer: serializeCustomer(customer), unit, invoices, bookings };
}

// --- Booking creation ----------------------------------------------------

async function uniqueRef(db: Prisma.TransactionClient, kind: 'booking' | 'invoice', prefix: string): Promise<string> {
  const year = new Date().getFullYear();
  for (let i = 0; i < 5; i++) {
    const seq = Math.floor(1000 + Math.random() * 9000);
    const ref = `${prefix}-${year}-${seq}`;
    const existing =
      kind === 'booking'
        ? await db.booking.findUnique({ where: { bookingRef: ref } })
        : await db.invoice.findUnique({ where: { invoiceNo: ref } });
    if (!existing) return ref;
  }
  throw new AppError(500, 'INTERNAL', `Could not generate a unique ${kind} reference`);
}

export async function createCustomerBooking(payload: CustomerJwtPayload, input: CreateBookingInput) {
  const customer = await loadCustomer(payload);
  const moveInDate = new Date(input.moveInDate);
  if (Number.isNaN(moveInDate.getTime())) {
    throw new AppError(400, 'VALIDATION', 'Invalid moveInDate');
  }

  return prisma.$transaction(async (tx) => {
    const unit = await tx.unit.findUnique({ where: { unitCode: input.unitCode } });
    if (!unit) throw new AppError(404, 'NOT_FOUND', `Unit ${input.unitCode} not found`);
    if (unit.status !== 'AVAILABLE' && unit.status !== 'RESERVED') {
      throw new AppError(409, 'CONFLICT', `Unit ${input.unitCode} is ${unit.status.toLowerCase()} and cannot be booked`);
    }

    let tenant = customer.email
      ? await tx.tenant.findFirst({ where: { email: customer.email } })
      : null;
    if (!tenant) {
      tenant = await tx.tenant.create({
        data: {
          name: customer.name,
          type: customer.type,
          email: customer.email,
          mobile: customer.mobile,
          unitId: unit.id,
          moveInDate,
          monthlyRate: unit.monthlyRate,
          psf: unit.sqft ? toNum(unit.monthlyRate) / unit.sqft : toNum(unit.monthlyRate),
          status: 'ACTIVE',
        },
      });
    }

    const booking = await tx.booking.create({
      data: {
        bookingRef: await uniqueRef(tx, 'booking', 'SL'),
        tenantId: tenant.id,
        unitId: unit.id,
        moveInDate,
        duration: `${input.durationMonths} months`,
        amount: unit.monthlyRate,
        status: 'PENDING_PAYMENT',
      },
    });

    await tx.unit.update({ where: { id: unit.id }, data: { status: 'RESERVED' } });

    await tx.invoice.create({
      data: {
        invoiceNo: await uniqueRef(tx, 'invoice', 'INV'),
        tenantId: tenant.id,
        unitId: unit.id,
        amount: input.totalDueToday ?? unit.monthlyRate,
        dueDate: moveInDate,
        status: 'DUE',
      },
    });

    return {
      bookingRef: booking.bookingRef,
      status: booking.status,
      unit: { code: unit.unitCode, sqft: unit.sqft, rate: toNum(unit.monthlyRate) },
      moveInDate,
      amount: toNum(booking.amount),
    };
  });
}

// --- Requests & notice ----------------------------------------------------

export async function submitCustomerRequest(payload: CustomerJwtPayload, input: CustomerRequestInput) {
  const customer = await loadCustomer(payload);

  const parts = [`Request type: ${input.type}`];
  if (input.preferredDate) parts.push(`Preferred date: ${input.preferredDate}`);
  if (input.notes) parts.push(input.notes);

  const lead = await prisma.lead.create({
    data: {
      name: customer.name,
      type: customer.type,
      source: 'WEBSITE',
      stage: 'NEW_ENQUIRY',
      note: parts.join(' | '),
    },
  });

  return { id: lead.id, status: 'SUBMITTED' };
}

export async function submitCustomerNotice(payload: CustomerJwtPayload, input: { unitId: string; lastDay: string }) {
  const customer = await loadCustomer(payload);
  const tenant = customer.email
    ? await prisma.tenant.findFirst({ where: { email: customer.email } })
    : null;

  const belongsToCustomer =
    !!tenant &&
    (tenant.unitId === input.unitId ||
      !!(await prisma.booking.findFirst({ where: { tenantId: tenant.id, unitId: input.unitId } })));

  if (!belongsToCustomer) {
    throw new AppError(404, 'NOT_FOUND', 'Unit not found for this customer');
  }

  return { status: 'SUBMITTED', lastDay: new Date(input.lastDay) };
}

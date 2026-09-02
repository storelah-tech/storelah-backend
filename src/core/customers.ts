import crypto from 'node:crypto';
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

export async function loadCustomer(payload: CustomerJwtPayload): Promise<Customer> {
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

// --- Guest checkout -------------------------------------------------------

// Default password for auto-provisioned guest accounts. Configurable via env;
// always stored bcrypt-hashed and never returned by any API response.
const GUEST_DEFAULT_PASSWORD = process.env.STORELAH_GUEST_DEFAULT_PASSWORD || 'storelah-guest-default';

/**
 * Find-or-create a Customer by email for unauthenticated (guest) booking.
 * Existing customers are returned untouched — their password/type/name are
 * NEVER overwritten. New customers are created with type GUEST and the
 * default password (bcrypt-hashed).
 */
export async function findOrCreateGuestCustomer(input: {
  email: string;
  name?: string;
  mobile?: string;
}): Promise<Customer> {
  const existing = await prisma.customer.findUnique({ where: { email: input.email } });
  if (existing) return existing;

  const passwordHash = await bcrypt.hash(GUEST_DEFAULT_PASSWORD, 10);
  return prisma.customer.create({
    data: {
      name: input.name?.trim() || 'Guest',
      email: input.email,
      mobile: input.mobile?.trim() || null,
      passwordHash,
      type: AccountType.GUEST,
    },
  });
}

// --- Guest claim (portal password setup) ----------------------------------
//
// POST /customer/claim: a guest who booked with email+mobile receives their
// bookingRef on confirmation and calls this to set their portal password.
// Success rotates away the shared GUEST default password and moves the
// account off type GUEST onto PERSONAL.

export interface ClaimGuestAccountInput {
  email: string;
  bookingRef: string;
  mobile: string;
  password: string;
}

// Uniform failure message for every claim mismatch below — never reveal WHICH
// factor failed (bookingRef / email / mobile / account state).
const CLAIM_MISMATCH_MESSAGE = "We couldn't match those details to a recent booking.";

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

// Minimal fixed-window rate limit for FAILED claim attempts only (successes
// never burn the window). Keyed by `${ip}|${lowercasedEmail}`, max
// CLAIM_ATTEMPT_LIMIT failures per rolling CLAIM_WINDOW_MS. NB: the app is
// exported through serverless-http (index.ts `export const handler`), so each
// warm Lambda instance keeps its OWN copy of this Map — the cap is per
// instance, not global. Swap in Redis/DynamoDB if a hard cross-instance limit
// is ever required. Malformed payloads rejected by zod at the route layer do
// not reach this counter by design.
const CLAIM_ATTEMPT_LIMIT = 5;
const CLAIM_WINDOW_MS = 60_000;
const claimFailures = new Map<string, { windowStart: number; count: number }>();

function assertClaimNotRateLimited(key: string): void {
  const entry = claimFailures.get(key);
  if (!entry) return;
  if (Date.now() - entry.windowStart >= CLAIM_WINDOW_MS) {
    claimFailures.delete(key); // expired windows clear themselves
    return;
  }
  if (entry.count >= CLAIM_ATTEMPT_LIMIT) {
    throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Please try again shortly.');
  }
}

function recordClaimFailure(key: string): void {
  const now = Date.now();
  const entry = claimFailures.get(key);
  if (!entry || now - entry.windowStart >= CLAIM_WINDOW_MS) {
    claimFailures.set(key, { windowStart: now, count: 1 });
    return;
  }
  entry.count += 1;
}

/**
 * Set a portal password for a GUEST customer, proving identity with the
 * bookingRef + email + mobile triple from their confirmation.
 *
 * v1 control = exact triple match; no recency or booking-status filter on
 * purpose — the bookingRef is delivered out-of-band on confirmation and any
 * booking linked to the tenant proves the same identity. Revisit only if refs
 * ever become guessable.
 */
export async function claimGuestAccount(
  input: ClaimGuestAccountInput,
  ip: string,
): Promise<{ token: string; customer: ReturnType<typeof serializeCustomer> }> {
  const key = `${ip}|${input.email.toLowerCase()}`;
  assertClaimNotRateLimited(key);

  const booking = await prisma.booking.findUnique({
    where: { bookingRef: input.bookingRef },
    include: { tenant: true },
  });

  // Mobile numbers are stored raw-trimmed (findOrCreateGuestCustomer above),
  // so both sides are normalized to digits-only before comparing; a result of
  // fewer than 6 digits is treated as no-match (too weak to identify anyone).
  const tenantDigits = digitsOnly(booking?.tenant.mobile ?? '');
  const matched =
    !!booking &&
    !!booking.tenant.email &&
    booking.tenant.email.toLowerCase() === input.email.toLowerCase() &&
    tenantDigits.length >= 6 &&
    tenantDigits === digitsOnly(input.mobile);

  if (!matched) {
    recordClaimFailure(key);
    throw new AppError(401, 'UNAUTHORIZED', CLAIM_MISMATCH_MESSAGE);
  }

  // Exact-match lookup on the lowercased address, per the customers.ts pattern.
  const customer = await prisma.customer.findUnique({ where: { email: input.email.toLowerCase() } });
  if (!customer) {
    recordClaimFailure(key);
    throw new AppError(401, 'UNAUTHORIZED', CLAIM_MISMATCH_MESSAGE);
  }
  // Type GUEST is only ever set by findOrCreateGuestCustomer above, so any
  // non-GUEST value reliably means the portal access was already claimed or
  // the account was properly registered.
  if (customer.type !== AccountType.GUEST) {
    recordClaimFailure(key);
    throw new AppError(409, 'CONFLICT', 'Portal access already set up. Please sign in.');
  }

  const passwordHash = await bcrypt.hash(input.password, 10);
  const updated = await prisma.$transaction(async (tx) =>
    tx.customer.update({
      where: { id: customer.id },
      data: { passwordHash, type: AccountType.PERSONAL },
    }),
  );

  // Identical shape to loginCustomer's response.
  return { token: signCustomerToken(updated), customer: serializeCustomer(updated) };
}

// --- Forgot / Reset password --------------------------------------------------

export async function forgotPassword(input: { email: string }) {
  // Always return the same message to avoid revealing whether the account exists.
  const message = 'If an account with that email exists, a reset token has been generated.';

  const customer = await prisma.customer.findUnique({ where: { email: input.email } });
  if (!customer) {
    return { message, token: null };
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = await bcrypt.hash(rawToken, 6);
  const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);

  await prisma.customer.update({
    where: { id: customer.id },
    data: { resetToken: hashedToken, resetTokenExpiry },
  });

  return { message, token: rawToken };
}

export async function resetPassword(input: { token: string; password: string }) {
  const candidates = await prisma.customer.findMany({
    where: { resetTokenExpiry: { gt: new Date() } },
  });

  for (const customer of candidates) {
    if (!customer.resetToken) continue;
    const match = await bcrypt.compare(input.token, customer.resetToken);
    if (!match) continue;

    const passwordHash = await bcrypt.hash(input.password, 10);
    await prisma.customer.update({
      where: { id: customer.id },
      data: { passwordHash, resetToken: null, resetTokenExpiry: null },
    });

    return { message: 'Password reset successful.' };
  }

  throw new AppError(400, 'INVALID_TOKEN', 'Invalid or expired reset token.');
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

// Additive-only enrichment (audit 2026-08): every pre-existing key keeps its
// name/type/order — new keys are appended so deployed portal clients that read
// the old shape continue to work untouched.
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
    // --- appended (additive) ---
    climateControl: u.climateControl,
    sizeCode: u.size.code,
    branch: { address: u.branch.address, operatingHours: u.branch.operatingHours },
  };
}

// Latest customer-submitted move-out notice, read back inside GET /portal so
// the booking app can restore its timeline after refresh (there is no separate
// GET /notice endpoint by design — one round-trip preferred).
type PortalNotice = Prisma.NoticeGetPayload<{ include: { unit: true } }>;

function serializePortalNotice(n: PortalNotice) {
  return {
    id: n.id,
    unitId: n.unitId,
    unitCode: n.unit.unitCode,
    // No workflow state machine exists yet: a persisted row means SUBMITTED.
    // TenantStatus.NOTICE stays operator-managed in the CMS.
    status: 'SUBMITTED' as const,
    lastDay: n.lastDay,
    submittedAt: n.createdAt,
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

  // Latest submitted move-out notice (null when none was ever persisted).
  const notice = tenant
    ? await prisma.notice.findFirst({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: 'desc' },
        include: { unit: true },
      })
    : null;

  return {
    customer: serializeCustomer(customer),
    unit,
    invoices,
    bookings,
    // --- appended (additive) ---
    notice: notice ? serializePortalNotice(notice) : null,
    tenancy: tenant
      ? { moveInDate: tenant.moveInDate, nextPayment: tenant.nextPayment }
      : null,
  };
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

export async function createCustomerBooking(customer: Customer, input: CreateBookingInput) {
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
      // Tenant.unitId is UNIQUE (one active tenancy per unit). A RESERVED unit
      // may already belong to a different customer — reject cleanly with 409
      // instead of letting tenant.create blow up with a raw unique violation.
      const unitTenant = await tx.tenant.findFirst({ where: { unitId: unit.id } });
      if (unitTenant) {
        throw new AppError(409, 'CONFLICT', `Unit ${input.unitCode} is already booked`);
      }
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

  if (!belongsToCustomer || !tenant) {
    throw new AppError(404, 'NOT_FOUND', 'Unit not found for this customer');
  }

  const lastDay = new Date(input.lastDay);
  if (Number.isNaN(lastDay.getTime())) {
    throw new AppError(400, 'VALIDATION', 'Invalid lastDay');
  }

  // Persist one row per submission (history preserved); the portal reads the
  // latest by createdAt. Ownership rules above are unchanged.
  const notice = await prisma.notice.create({
    data: {
      tenantId: tenant.id,
      unitId: input.unitId,
      lastDay,
    },
    include: { unit: true },
  });

  return {
    status: 'SUBMITTED' as const,
    lastDay: notice.lastDay,
    // --- appended (additive) ---
    id: notice.id,
    unitId: notice.unitId,
    unitCode: notice.unit.unitCode,
    submittedAt: notice.createdAt,
  };
}

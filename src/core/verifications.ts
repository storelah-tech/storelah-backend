// Mock ID-verification store (Jumio-style camera mock, booking Confirmation
// step). Confirmation-only, guest-visible: persistence is keyed by bookingRef
// (plain String, never an FK) so a verification is never blocked by booking
// existence. No provider SDK — result flags only (pass→VERIFIED,
// fail→FAILED), no image binaries (the repo has no upload/S3 pattern).
//
// booking.requireIDVerification stays display-only: nothing in this module
// gates move-in or payment on verification status.
import type { Verification } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import type { CustomerJwtPayload } from '../middleware/auth';
import { findOrCreateGuestCustomer, loadCustomer, normalizeEmail } from './customers';

export const VERIFICATION_PROVIDER = 'mock' as const;
export const VERIFICATION_METHOD = 'mock-camera' as const;

export type VerificationIdType = 'passport' | 'nric-fin' | 'drivers-licence' | 'residence-permit';
export type VerificationResult = 'pass' | 'fail';
export type VerificationStatus = 'VERIFIED' | 'FAILED';

/** Deterministic result → status mapper: pass→VERIFIED, fail→FAILED. */
export function statusForResult(result: VerificationResult): VerificationStatus {
  return result === 'pass' ? 'VERIFIED' : 'FAILED';
}

export interface RecordMockVerificationInput {
  bookingRef: string;
  email?: string;
  method: typeof VERIFICATION_METHOD;
  idType: VerificationIdType;
  result: VerificationResult;
  capturedAt: string;
  selfiePresent?: boolean;
}

export interface SerializedVerification {
  id: string;
  status: VerificationStatus;
  result: VerificationResult;
  idType: VerificationIdType;
  bookingRef: string;
  capturedAt: string | null;
  verifiedAt: string;
  provider: typeof VERIFICATION_PROVIDER;
  // CMS staff-validation layer (additive — provider status/result untouched).
  // Every mock row reads PENDING_VALIDATION until an operator VALIDATEs or
  // REJECTs it via PATCH /api/v1/cms/verifications/:id.
  reviewStatus: VerificationReviewStatus;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export const VERIFICATION_REVIEW_STATUSES = ['PENDING_VALIDATION', 'VALIDATED', 'REJECTED'] as const;
export type VerificationReviewStatus = (typeof VERIFICATION_REVIEW_STATUSES)[number];

export function serializeVerification(v: Verification): SerializedVerification {
  return {
    id: v.id,
    status: v.status as VerificationStatus,
    result: v.result as VerificationResult,
    idType: v.idType as VerificationIdType,
    bookingRef: v.bookingRef,
    capturedAt: v.capturedAt ? v.capturedAt.toISOString() : null,
    verifiedAt: v.verifiedAt.toISOString(),
    provider: VERIFICATION_PROVIDER,
    // Pre-review-layer rows cannot exist (the column backfills via its DB
    // default), but fall back defensively so a NULL never escapes.
    reviewStatus: (v.reviewStatus as VerificationReviewStatus) ?? 'PENDING_VALIDATION',
    reviewedAt: v.reviewedAt ? v.reviewedAt.toISOString() : null,
    reviewedBy: v.reviewedBy ?? null,
  };
}

// Max clock skew tolerated for a client-captured timestamp: captures more
// than 5 minutes in the future are rejected (client clock or tampering).
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function parseCapturedAt(raw: string): Date {
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new AppError(400, 'VALIDATION', 'capturedAt must be a valid ISO datetime');
  }
  if (at.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
    throw new AppError(400, 'VALIDATION', 'capturedAt must not be more than 5 minutes in the future');
  }
  return at;
}

// Uniform mismatch message — never reveal which factor failed (bookingRef /
// email), mirroring the /claim proof pattern in core/customers.ts.
const VERIFICATION_MISMATCH_MESSAGE = "We couldn't match those details to a booking.";

/**
 * Dual-mode customer resolution, mirroring POST /bookings:
 *  - WITH a valid Bearer JWT (caller) → the authenticated customer.
 *  - WITHOUT → guest: bookingRef alone suffices; when BOTH the booking has
 *    a tenant email AND the request supplies one, they must match
 *    (case-insensitive, trimmed), otherwise 401. A supplied guest email is
 *    found-or-created (never duplicated) so the row links to a customer;
 *    without email the row is stored with a null customerId.
 */
async function resolveCustomerId(
  caller: CustomerJwtPayload | null,
  bookingRef: string,
  email?: string,
): Promise<{ customerId: string | null; tenantId: string | null }> {
  if (caller) {
    const customer = await loadCustomer(caller);
    const booking = await prisma.booking.findUnique({
      where: { bookingRef },
      select: { tenantId: true },
    });
    return { customerId: customer.id, tenantId: booking?.tenantId ?? null };
  }

  const booking = await prisma.booking.findUnique({
    where: { bookingRef },
    include: { tenant: true },
  });

  const trimmedEmail = email?.trim();
  if (booking?.tenant.email && trimmedEmail) {
    if (normalizeEmail(booking.tenant.email) !== normalizeEmail(trimmedEmail)) {
      throw new AppError(401, 'UNAUTHORIZED', VERIFICATION_MISMATCH_MESSAGE);
    }
  }

  if (trimmedEmail) {
    const guest = await findOrCreateGuestCustomer({ email: trimmedEmail });
    return { customerId: guest.id, tenantId: booking?.tenantId ?? null };
  }
  return { customerId: null, tenantId: booking?.tenantId ?? null };
}

export async function recordMockVerification(
  input: RecordMockVerificationInput,
  caller: CustomerJwtPayload | null,
): Promise<SerializedVerification> {
  const bookingRef = input.bookingRef.trim();
  if (!bookingRef) {
    throw new AppError(400, 'VALIDATION', 'bookingRef is required');
  }
  const capturedAt = parseCapturedAt(input.capturedAt);
  const { customerId, tenantId } = await resolveCustomerId(caller, bookingRef, input.email);

  const row = await prisma.verification.create({
    data: {
      customerId,
      tenantId,
      bookingRef,
      method: VERIFICATION_METHOD,
      idType: input.idType,
      result: input.result,
      status: statusForResult(input.result),
      capturedAt,
      payload: {
        method: VERIFICATION_METHOD,
        selfiePresent: input.selfiePresent ?? null,
      },
    },
  });
  return serializeVerification(row);
}

export async function listVerificationsByBookingRef(
  bookingRef: string,
): Promise<SerializedVerification[]> {
  const ref = bookingRef.trim();
  if (!ref) {
    throw new AppError(400, 'VALIDATION', 'bookingRef is required');
  }
  const rows = await prisma.verification.findMany({
    where: { bookingRef: ref },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return rows.map(serializeVerification);
}

// ---------- CMS operator surface (staff-validation layer) ----------
//
// listVerificationsForCms backs GET /api/v1/cms/verifications: the same
// newest-first ordering as the customer read, optionally narrowed by
// bookingRef and/or reviewStatus, with take/skip paging. The provider
// result (status/result) is echoed as-is; reviewStatus is the flag staff act
// on. setVerificationReview backs PATCH /:id: the ONLY writer of the review
// flag — PENDING_VALIDATION → VALIDATED | REJECTED, any other edge is 409
// (provider status is never rewritten here).

export interface ListVerificationsForCmsInput {
  bookingRef?: string;
  reviewStatus?: VerificationReviewStatus;
  take?: number;
  skip?: number;
}

export async function listVerificationsForCms(
  input: ListVerificationsForCmsInput,
): Promise<{ rows: SerializedVerification[]; count: number }> {
  const where: { bookingRef?: string; reviewStatus?: string } = {};
  if (input.bookingRef?.trim()) where.bookingRef = input.bookingRef.trim();
  if (input.reviewStatus) where.reviewStatus = input.reviewStatus;
  const [rows, count] = await Promise.all([
    prisma.verification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.take,
      skip: input.skip,
    }),
    prisma.verification.count({ where }),
  ]);
  return { rows: rows.map(serializeVerification), count };
}

export interface SetVerificationReviewInput {
  reviewStatus: 'VALIDATED' | 'REJECTED';
  reviewedBy?: string;
}

export async function setVerificationReview(
  id: string,
  input: SetVerificationReviewInput,
): Promise<SerializedVerification> {
  const row = await prisma.verification.findUnique({ where: { id } });
  if (!row) throw new AppError(404, 'NOT_FOUND', `Verification ${id} not found`);
  const current = (row.reviewStatus ?? 'PENDING_VALIDATION') as VerificationReviewStatus;
  if (current !== 'PENDING_VALIDATION') {
    throw new AppError(
      409,
      'CONFLICT',
      `Verification ${id} is already ${current} — only rows pending validation can be reviewed`,
    );
  }
  const updated = await prisma.verification.update({
    where: { id },
    data: {
      reviewStatus: input.reviewStatus,
      reviewedAt: new Date(),
      reviewedBy: input.reviewedBy?.trim() ? input.reviewedBy.trim().slice(0, 120) : null,
    },
  });
  return serializeVerification(updated);
}

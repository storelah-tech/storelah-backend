import { z } from 'zod';
import { AppError } from './http';

// Shared date-range filter for CMS list endpoints (YYYY-MM-DD, inclusive day bounds).
//
// TABLE INVENTORY — one line per data table + its filter date field:
// leads #leadRows → Lead.createdAt; units table → Unit.createdAt;
// tenants table → Tenant.createdAt; bookings table → Booking.createdAt;
// move-ins table → Booking.moveInDate (overrides the today-only default when set);
// invoices table → Invoice.dueDate; arrears table → Invoice.dueDate (OVERDUE subset);
// appointments lists (Today + week) → Appointment.startAt;
// promotions library → Promotion.createdAt + PromotionPlan.effectiveFrom (combined client-side);
// promo history (versions) → PromotionVersion.createdAt;
// promo performance redemptions → PromotionRedemption.redeemedAt.
// NOT tables (no range filter): inbox threads, unit map, unit activity feed,
// action-items, analytics series, safeguards, settings.

export const dateRangeFields = {
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD')
    .optional(),
};

export interface DateRange {
  from?: Date;
  to?: Date;
}

// Inclusive day bounds (UTC): from → 00:00:00.000, to → 23:59:59.999.
// Throws 400 when from is after to.
export function resolveDateRange(q: { from?: string; to?: string }): DateRange {
  const from = q.from ? new Date(q.from + 'T00:00:00.000Z') : undefined;
  const to = q.to ? new Date(q.to + 'T23:59:59.999Z') : undefined;
  if (from && isNaN(from.getTime())) throw new AppError(400, 'VALIDATION', 'Invalid from date');
  if (to && isNaN(to.getTime())) throw new AppError(400, 'VALIDATION', 'Invalid to date');
  if (from && to && from.getTime() > to.getTime()) {
    throw new AppError(400, 'VALIDATION', 'from must not be after to');
  }
  return { from, to };
}

export function isDateRangeActive(r: DateRange): boolean {
  return !!r.from || !!r.to;
}

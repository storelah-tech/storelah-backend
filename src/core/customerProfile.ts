// Customer profile + settlements (prototype 2026-11-04, Customers §§ profile,
// Transfer unit, Move-out and refund/closing charge).
//
// A customer is the identity behind one or more Tenant rows (one Tenant per
// unit), grouped by normalised email. Lifecycle facts are read from what the
// platform already records: booking (agreement date + duration), tenant
// (move-in, net rent), converted lead (Protection Plan) and notices (portal
// move-out date). Settlements are calculated here — the server is the only
// calculator — and wait as PENDING until Finance approves them; approval
// changes status only (posting to the ledger is an open owner question, Q16).
//
// Owner-confirmed rules (2026-11-05): the transfer day is billed on the new
// unit; the last day of access is charged; Protection Plan is never prorated;
// security deposits default to $0.

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { toNum } from '../lib/format';
import { normalizeEmail } from './customers';

const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export function daysInMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

export function parseCommitmentMonths(duration: string | null | undefined): number | null {
  const m = String(duration ?? '').match(/(\d+)\s*month/i);
  return m ? Number(m[1]) : null;
}

/** Commitment end = move-in + N months − 1 day. */
export function commitmentEnd(moveIn: Date, months: number): Date {
  const d = new Date(Date.UTC(moveIn.getUTCFullYear(), moveIn.getUTCMonth() + months, moveIn.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

export function remainingText(end: Date, today = new Date()): string {
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (end.getTime() < t.getTime()) return 'Commitment completed';
  let months = (end.getUTCFullYear() - t.getUTCFullYear()) * 12 + (end.getUTCMonth() - t.getUTCMonth());
  let anchor = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + months, t.getUTCDate()));
  if (anchor.getTime() > end.getTime()) { months -= 1; anchor = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + months, t.getUTCDate())); }
  const days = Math.round((end.getTime() - anchor.getTime()) / 86_400_000);
  const parts = [months > 0 ? `${months} month${months === 1 ? '' : 's'}` : null, days > 0 ? `${days} day${days === 1 ? '' : 's'}` : null].filter(Boolean);
  return parts.length ? parts.join(' ') : 'Ends today';
}

// ---------------------------------------------------------------------------
// Settlement calculations (pure; exported for tests)
// ---------------------------------------------------------------------------

export const ADJUSTMENT_CATEGORIES = [
  'Service recovery', 'Duplicate payment correction', 'Early termination fee', 'Damage to unit / door',
  'Cleaning fee', 'Lock replacement', 'Merchandise or moving service', 'Other',
] as const;

export interface Adjustment {
  type: 'CHARGE' | 'CREDIT';
  category: (typeof ADJUSTMENT_CATEGORIES)[number];
  amount: number;
  reason: string;
}

export interface SettlementLine { label: string; amount: number; detail?: string }

function adjustmentLines(adj: Adjustment | null | undefined): { lines: SettlementLine[]; charge: number; credit: number } {
  if (!adj || !(adj.amount > 0)) return { lines: [], charge: 0, credit: 0 };
  if (!adj.reason?.trim()) throw new AppError(400, 'VALIDATION', 'Add a reason for the special refund or charge.');
  const amount = r2(adj.amount);
  return adj.type === 'CHARGE'
    ? { lines: [{ label: `Special charge · ${adj.category}`, amount, detail: adj.reason.trim() }], charge: amount, credit: 0 }
    : { lines: [{ label: `Special credit · ${adj.category}`, amount: -amount, detail: adj.reason.trim() }], charge: 0, credit: amount };
}

/**
 * Transfer: remaining days = days in month − transfer day + 1. The unused
 * current-unit rent is credited and the destination rent charged for the same
 * days; destination pricing/promotion wins. Positive total = customer pays.
 */
export function calculateTransfer(i: {
  date: Date; currentRent: number; currentDeposit: number;
  destGross: number; destPromoPct: number; destDeposit: number; destProtection: number;
  adjustment?: Adjustment | null;
}) {
  const dim = daysInMonth(i.date);
  const remaining = dim - i.date.getUTCDate() + 1;
  const sourceCredit = r2((i.currentRent * remaining) / dim);
  const destNet = r2(i.destGross * (1 - i.destPromoPct / 100));
  const destCharge = r2((destNet * remaining) / dim);
  const depositDelta = r2(i.destDeposit - i.currentDeposit);
  const adj = adjustmentLines(i.adjustment);
  const lines: SettlementLine[] = [
    { label: `Unused current-unit rent credit (${remaining}/${dim} days)`, amount: -sourceCredit },
    { label: `Destination-unit rent for the same ${remaining} days`, amount: destCharge, detail: `Net ${destNet.toFixed(2)}/month after destination pricing` },
    { label: 'Security deposit difference', amount: depositDelta },
    { label: 'Protection Plan', amount: 0, detail: 'Not prorated — the destination plan starts on the next billing cycle' },
    ...adj.lines,
  ];
  const total = r2(destCharge - sourceCredit + depositDelta + adj.charge - adj.credit);
  return { lines, total, remainingDays: remaining, daysInMonth: dim, destNet, nextFullDeduction: r2(destNet + i.destProtection) };
}

/**
 * Move-out: the last day of access is charged; refund only the days after
 * it. closing = unused rent + deposit + special credit − special charge.
 * Returned total uses the settlement sign: negative = refund to the customer.
 */
export function calculateMoveOut(i: { lastDay: Date; rent: number; deposit: number; adjustment?: Adjustment | null }) {
  const dim = daysInMonth(i.lastDay);
  const unused = dim - i.lastDay.getUTCDate();
  const credit = r2((i.rent * unused) / dim);
  const adj = adjustmentLines(i.adjustment);
  const lines: SettlementLine[] = [
    { label: `Unused rent after the last day of access (${unused}/${dim} days)`, amount: -credit },
    { label: 'Security deposit returned', amount: -r2(i.deposit) },
    { label: 'Protection Plan', amount: 0, detail: 'Never prorated — no refund' },
    ...adj.lines,
  ];
  const closing = r2(credit + i.deposit + adj.credit - adj.charge); // >= 0 refund, < 0 charge
  return { lines, closing, total: r2(-closing), outcome: closing >= 0 ? 'REFUND' as const : 'CHARGE' as const, unusedDays: unused, daysInMonth: dim };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const UNIT_INCLUDE = { unit: { include: { size: true, branch: true, floor: true } }, branch: true } as const;
type TenantRow = Prisma.TenantGetPayload<{ include: typeof UNIT_INCLUDE }>;

async function identityGroup(tenantId: string): Promise<TenantRow[]> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, include: UNIT_INCLUDE });
  if (!t) throw new AppError(404, 'NOT_FOUND', `Customer ${tenantId} not found`);
  const email = t.email ? normalizeEmail(t.email) : null;
  if (!email) return [t];
  const rows = await prisma.tenant.findMany({ where: { email: { equals: email, mode: 'insensitive' } }, include: UNIT_INCLUDE, orderBy: { createdAt: 'asc' } });
  return [t, ...rows.filter((r) => r.id !== t.id)];
}

async function protectionFor(unitCode: string | null | undefined, email: string | null) {
  if (!unitCode) return null;
  const lead = await prisma.lead.findFirst({
    where: { unitCode, ...(email ? { emailNorm: normalizeEmail(email) } : {}), protectionCost: { not: null } },
    orderBy: { updatedAt: 'desc' },
    select: { protectionCost: true, protectionTier: true, movingService: true },
  });
  return lead;
}

export async function getCustomerProfile(tenantId: string) {
  const group = await identityGroup(tenantId);
  const primary = group[0];
  const tenantIds = group.map((g) => g.id);
  const [bookings, invoices, notices, settlements, account, notesCount] = await Promise.all([
    prisma.booking.findMany({ where: { tenantId: { in: tenantIds } }, orderBy: { createdAt: 'desc' } }),
    prisma.invoice.findMany({ where: { tenantId: { in: tenantIds }, voidedAt: null }, include: { unit: { select: { unitCode: true } } }, orderBy: { billedMonth: 'desc' }, take: 60 }),
    prisma.notice.findMany({ where: { tenantId: { in: tenantIds } }, orderBy: { createdAt: 'desc' } }),
    prisma.customerSettlement.findMany({ where: { tenantId: { in: tenantIds } }, orderBy: { createdAt: 'desc' } }),
    primary.email ? prisma.customer.findUnique({ where: { email: normalizeEmail(primary.email) }, select: { companyName: true, uen: true, type: true } }) : null,
    prisma.recordNote.count({ where: { entityType: 'tenant', entityId: primary.id } }),
  ]);

  const units = await Promise.all(group.filter((g) => g.unit).map(async (g) => {
    const booking = bookings.find((b) => b.tenantId === g.id && (b.status === 'CONFIRMED' || b.paidAt)) ?? bookings.find((b) => b.tenantId === g.id) ?? null;
    const moveIn = g.moveInDate ?? booking?.moveInDate ?? null;
    const months = parseCommitmentMonths(booking?.duration);
    const end = moveIn && months ? commitmentEnd(moveIn, months) : null;
    const prot = await protectionFor(g.unit!.unitCode, g.email);
    const notice = notices.find((n) => n.tenantId === g.id) ?? null;
    return {
      tenantId: g.id,
      unitId: g.unitId,
      unitCode: g.unit!.unitCode,
      facility: g.unit!.branch?.name ?? g.branch?.name ?? null,
      level: g.unit!.floor?.level ?? null,
      size: g.unit!.size?.name ?? null,
      sqft: g.unit!.sqft,
      status: g.status,
      agreementSigned: ymd(booking?.paidAt ?? booking?.createdAt ?? null),
      bookingRef: booking?.bookingRef ?? null,
      moveIn: ymd(moveIn),
      commitmentMonths: months,
      commitment: booking?.duration ?? null,
      commitmentEnd: ymd(end),
      remaining: end ? remainingText(end) : null,
      withinCommitment: end ? end.getTime() >= Date.now() : false,
      netRent: toNum(g.monthlyRate),
      grossRent: toNum(g.unit!.monthlyRate),
      protectionMonthly: prot?.protectionCost != null ? toNum(prot.protectionCost) : null,
      protectionTier: prot?.protectionTier ?? null,
      movingService: prot?.movingService ?? null,
      deposit: 0, // launch policy: security deposit $0 (configurable later)
      billingFrequency: 'Monthly',
      nextPayment: ymd(g.nextPayment),
      portalMoveOut: ymd(notice?.lastDay ?? null),
    };
  }));

  const ledger = invoices.flatMap((inv) => {
    const rows = [{
      date: ymd(inv.issuedAt ?? inv.billedMonth), document: inv.invoiceNo, unit: inv.unit.unitCode,
      lineItem: `Monthly AC self-storage rent · ${inv.billedMonth.toLocaleDateString('en-SG', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`,
      status: inv.status === 'PAID' ? 'Paid' : inv.status === 'OVERDUE' ? 'Overdue' : inv.approvedAt ? 'Issued' : 'Pending approval',
      debit: toNum(inv.amount), credit: null as number | null,
    }];
    if (inv.paidAt && inv.amountPaid != null) {
      rows.push({ date: ymd(inv.paidAt), document: inv.invoiceNo, unit: inv.unit.unitCode, lineItem: 'Payment allocation', status: 'Allocated', debit: null as unknown as number, credit: toNum(inv.amountPaid) });
    }
    return rows;
  }).concat(settlements.map((s) => ({
    date: ymd(s.createdAt), document: s.ref, unit: units.find((u) => u.unitId === s.unitId)?.unitCode ?? '—',
    lineItem: s.docType, status: s.status === 'PENDING' ? 'Pending approval' : s.status === 'APPROVED' ? 'Approved' : 'Rejected',
    debit: toNum(s.amount) > 0 ? toNum(s.amount) : (null as unknown as number), credit: toNum(s.amount) < 0 ? -toNum(s.amount) : null,
  }))).sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const revenue = invoices.reduce((n, i) => n + (i.amountPaid != null ? toNum(i.amountPaid) : 0), 0);
  return {
    id: primary.id,
    name: account?.companyName && primary.type === 'BUSINESS' ? account.companyName : primary.name,
    type: primary.type,
    uen: account?.uen ?? null,
    email: primary.email,
    mobile: primary.mobile,
    status: primary.status,
    since: ymd(group.map((g) => g.moveInDate).filter(Boolean).sort()[0] ?? primary.createdAt),
    revenueToDate: r2(revenue),
    units,
    monthlyDeductions: r2(units.reduce((n, u) => n + u.netRent + (u.protectionMonthly ?? 0), 0)),
    depositsHeld: 0,
    ledger,
    settlements: settlements.map(serializeSettlement),
    notesCount,
    adjustmentCategories: ADJUSTMENT_CATEGORIES,
  };
}

export function serializeSettlement(s: Prisma.CustomerSettlementGetPayload<object>) {
  return {
    id: s.id, ref: s.ref, kind: s.kind, docType: s.docType, tenantId: s.tenantId, unitId: s.unitId, toUnitId: s.toUnitId,
    effectiveDate: ymd(s.effectiveDate), channel: s.channel, reason: s.reason, note: s.note,
    lines: s.lines as unknown as SettlementLine[], amount: toNum(s.amount), adjustment: s.adjustment,
    status: s.status, requestedBy: s.requestedBy, decidedBy: s.decidedBy, decidedAt: s.decidedAt, decisionNote: s.decisionNote, createdAt: s.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Preview + submit
// ---------------------------------------------------------------------------

export interface TransferRequest {
  kind: 'TRANSFER';
  date: string; // YYYY-MM-DD
  toUnitId: string;
  destPromoPct?: number;
  destProtection?: number;
  destDeposit?: number;
  reason?: string | null;
  adjustment?: Adjustment | null;
}
export interface MoveOutRequest {
  kind: 'MOVE_OUT' | 'REFUND';
  lastDay?: string | null; // required unless a portal notice exists
  channel?: string | null;
  reason?: string | null;
  note?: string | null;
  adjustment?: Adjustment | null;
}
export type SettlementRequest = TransferRequest | MoveOutRequest;

const dateOf = (v: string) => new Date(`${v}T00:00:00.000Z`);

async function buildSettlement(tenantId: string, req: SettlementRequest) {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, include: UNIT_INCLUDE });
  if (!t) throw new AppError(404, 'NOT_FOUND', `Customer ${tenantId} not found`);
  if (!t.unitId || !t.unit) throw new AppError(409, 'CONFLICT', 'This customer has no active unit.');
  const rent = toNum(t.monthlyRate);
  if (req.kind === 'TRANSFER') {
    const dest = await prisma.unit.findUnique({ where: { id: req.toUnitId }, include: { branch: true, size: true } });
    if (!dest || dest.deletedAt) throw new AppError(404, 'NOT_FOUND', 'Choose a destination unit.');
    if (dest.id === t.unitId) throw new AppError(400, 'VALIDATION', 'The destination must be a different unit.');
    if (dest.status !== 'AVAILABLE') throw new AppError(409, 'CONFLICT', `${dest.unitCode} is not available.`);
    const calc = calculateTransfer({
      date: dateOf(req.date), currentRent: rent, currentDeposit: 0,
      destGross: toNum(dest.monthlyRate), destPromoPct: req.destPromoPct ?? 0, destDeposit: req.destDeposit ?? 0,
      destProtection: req.destProtection ?? 0, adjustment: req.adjustment,
    });
    return {
      tenant: t, kind: 'TRANSFER', docType: 'Transfer approval', prefix: 'TRF', unitId: t.unitId, toUnitId: dest.id,
      effectiveDate: dateOf(req.date), channel: null, reason: req.reason ?? null, note: null,
      lines: calc.lines, amount: calc.total, adjustment: req.adjustment ?? null,
      preview: { ...calc, from: t.unit.unitCode, to: dest.unitCode, toFacility: dest.branch?.name ?? null, toSqft: dest.sqft },
    };
  }
  const notice = await prisma.notice.findFirst({ where: { tenantId: t.id }, orderBy: { createdAt: 'desc' } });
  const lastDay = notice ? notice.lastDay : req.lastDay ? dateOf(req.lastDay) : null;
  if (!lastDay) throw new AppError(400, 'VALIDATION', 'Enter the customer’s last day of access. The system will then calculate unused rent and the closing balance.');
  const calc = calculateMoveOut({ lastDay, rent, deposit: 0, adjustment: req.adjustment });
  return {
    tenant: t, kind: req.kind, docType: calc.outcome === 'REFUND' ? 'Refund' : 'Charge', prefix: calc.outcome === 'REFUND' ? 'RF' : 'CH',
    unitId: t.unitId, toUnitId: null, effectiveDate: lastDay,
    channel: notice ? 'Customer portal' : (req.channel ?? null), reason: req.reason ?? null, note: req.note ?? null,
    lines: calc.lines, amount: calc.total, adjustment: req.adjustment ?? null,
    preview: { ...calc, portalLocked: !!notice, lastDay: ymd(lastDay), unit: t.unit.unitCode },
  };
}

export async function previewSettlement(tenantId: string, req: SettlementRequest) {
  const b = await buildSettlement(tenantId, req);
  return { ...b.preview, kind: b.kind, docType: b.docType, lines: b.lines, amount: b.amount };
}

async function nextRef(tx: Prisma.TransactionClient, prefix: string) {
  const last = await tx.customerSettlement.findFirst({ where: { ref: { startsWith: `${prefix}-` } }, orderBy: { ref: 'desc' }, select: { ref: true } });
  const n = last ? Number(last.ref.slice(prefix.length + 1)) + 1 : 1_000_001;
  return `${prefix}-${String(n).padStart(7, '0')}`;
}

export async function submitSettlement(tenantId: string, req: SettlementRequest, actor: string) {
  const b = await buildSettlement(tenantId, req);
  const pending = await prisma.customerSettlement.findFirst({ where: { tenantId, kind: b.kind === 'REFUND' ? { in: ['REFUND', 'MOVE_OUT'] } : b.kind === 'MOVE_OUT' ? { in: ['REFUND', 'MOVE_OUT'] } : 'TRANSFER', status: 'PENDING' } });
  if (pending) throw new AppError(409, 'CONFLICT', `${pending.ref} is already awaiting Finance approval for this unit.`);
  const saved = await prisma.$transaction(async (tx) => tx.customerSettlement.create({
    data: {
      ref: await nextRef(tx, b.prefix), kind: b.kind, docType: b.docType, tenantId, unitId: b.unitId, toUnitId: b.toUnitId,
      effectiveDate: b.effectiveDate, channel: b.channel, reason: b.reason, note: b.note,
      lines: b.lines as unknown as Prisma.InputJsonValue, amount: b.amount,
      adjustment: b.adjustment ? (b.adjustment as unknown as Prisma.InputJsonValue) : undefined,
      requestedBy: actor.slice(0, 120),
    },
  }));
  return serializeSettlement(saved);
}

/** Finance decision (maker-checker: the requester cannot approve their own settlement). */
export async function decideSettlement(id: string, decision: 'APPROVED' | 'REJECTED', opts: { actor: string; note?: string | null }) {
  const s = await prisma.customerSettlement.findUnique({ where: { id } });
  if (!s) throw new AppError(404, 'NOT_FOUND', 'Settlement not found');
  if (s.status !== 'PENDING') throw new AppError(409, 'CONFLICT', `${s.ref} has already been ${s.status.toLowerCase()}.`);
  if (s.requestedBy === opts.actor) throw new AppError(403, 'FORBIDDEN', 'The person who requested a settlement cannot approve it.');
  if (decision === 'REJECTED' && !opts.note?.trim()) throw new AppError(400, 'VALIDATION', 'Say what needs to change.');
  const saved = await prisma.customerSettlement.update({
    where: { id },
    data: { status: decision, decidedBy: opts.actor.slice(0, 120), decidedAt: new Date(), decisionNote: opts.note?.trim() || null },
  });
  return serializeSettlement(saved);
}

export async function listSettlements(q: { status?: string }) {
  const rows = await prisma.customerSettlement.findMany({
    where: q.status ? { status: q.status } : undefined,
    include: { tenant: { select: { name: true, email: true, unit: { select: { unitCode: true, branch: { select: { name: true } } } } } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({ ...serializeSettlement(r), customer: r.tenant.name, unitCode: r.tenant.unit?.unitCode ?? null, facility: r.tenant.unit?.branch?.name ?? null }));
}

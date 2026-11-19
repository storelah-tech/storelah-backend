// Transactions, documents & approvals (prototype 2026-11-04, Finance).
//
// One read-only register over every payment-related record: invoices,
// payment instructions, refunds and customer settlements (transfer approvals,
// move-out refunds and closing charges). Each row keeps a pointer to its
// source so the register's Review action calls that record's own approval
// endpoint — this module never mutates anything. The processor reference
// stays in the row detail (evidence), not in the table.

import { prisma } from '../../lib/prisma';
import { toNum } from '../../lib/format';

export const REGISTER_DOC_TYPES = ['Invoice', 'Payment', 'Refund', 'Charge', 'Transfer approval', 'Credit note', 'Adjustment'] as const;

export interface RegisterRow {
  key: string; // `${source}:${id}`
  source: 'invoice' | 'payment' | 'refund' | 'settlement';
  id: string;
  date: string; // YYYY-MM-DD
  recordId: string;
  customer: string;
  tenantId: string | null;
  unit: string | null;
  /** Operator-facing unit number (name ?? unitCode) — unit stays the key. */
  unitName: string | null;
  /** UnitSize code (LOCKER / XS / SMALL / MEDIUM / LARGE / XLBIZ) — null when no unit. */
  unitType: string | null;
  /** UnitSize display name (Locker / XS / S / M / L / XL) — null when no unit. */
  unitTypeLabel: string | null;
  facility: string | null;
  docType: (typeof REGISTER_DOC_TYPES)[number];
  purpose: string;
  method: string | null;
  amount: number; // negative = refund / credit to the customer
  status: string;
  pending: boolean;
  approver: string | null;
  processor: string | null;
  /** Latest processor-attempt provider (STRIPE | BANK | WALLET | INVOICE). */
  provider?: string | null;
  scheduled: string | null;
}

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '');
const month = (d: Date) => d.toLocaleDateString('en-SG', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const INVOICE_STATUS: Record<string, string> = { DUE: 'Due', PAID: 'Paid', OVERDUE: 'Overdue', VOID: 'Void', DRAFT: 'Draft', ISSUED: 'Due', APPROVED: 'Approved', PARTIALLY_PAID: 'Part paid', WRITTEN_OFF: 'Written off' };
const PAYMENT_STATUS: Record<string, string> = { PENDING_APPROVAL: 'Pending approval', DRAFT: 'Draft', APPROVED: 'Approved', QUEUED: 'Approved', SUBMITTED: 'Processing', SUCCEEDED: 'Paid', FAILED: 'Failed', CANCELLED: 'Cancelled', EXPIRED: 'Expired' };
const REFUND_STATUS: Record<string, string> = { REQUESTED: 'Pending approval', APPROVED: 'Approved', REJECTED: 'Rejected', PAID: 'Paid' };
// Track A settlement lifecycle (handoff §12 status list + §19 failure copy:
// a failed processor call shows Approved/Processing with the failure reason,
// never Refunded). Legacy PENDING/APPROVED/REJECTED rows keep their labels.
const SETTLEMENT_STATUS: Record<string, string> = {
  PENDING: 'Pending approval',
  PENDING_APPROVAL: 'Pending approval',
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Approved',
  PROCESSING: 'Processing',
  REFUNDED: 'Refunded',
  POSTED: 'Posted',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  REJECTED: 'Rejected',
};
const SETTLEMENT_PENDING = new Set(['PENDING', 'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED', 'PROCESSING']);
// Handoff §10.7 exact approved copy (replaces the stale Q16 placeholder).
const APPROVED_COPY = 'Approved; awaiting processor submission.';

export async function listRegister(q: { search?: string; docType?: string; status?: string; facility?: string; unitType?: string; from?: string; to?: string; processor?: string; branchIds?: string[] | null }) {
  const unitSel = { select: { unitCode: true, name: true, size: { select: { code: true, name: true } }, branch: { select: { id: true, name: true, code: true } } } } as const;
  const tenantSel = { select: { name: true, unit: unitSel } } as const;
  const [invoices, payments, refunds, settlements] = await Promise.all([
    prisma.invoice.findMany({ include: { tenant: { select: { name: true } }, unit: unitSel }, orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.paymentInstruction.findMany({ include: { tenant: tenantSel, invoice: { select: { invoiceNo: true, billedMonth: true } } }, orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.refund.findMany({ include: { tenant: tenantSel }, orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.customerSettlement.findMany({
      include: { tenant: tenantSel, processorAttempts: { orderBy: { attemptNo: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
  ]);

  // A-13: CustomerSettlement carries its own scalar unitId (the case rental).
  // Completion releases the tenant (unitId → null), so reading the unit off
  // the tenant renders "—" on every posted move-out. Resolve the settlement
  // unit directly and fall back to the tenant's active unit when it matches.
  const settlementUnitIds = [...new Set(settlements.map((s) => s.unitId).filter(Boolean))];
  const settlementUnits = settlementUnitIds.length
    ? await prisma.unit.findMany({ where: { id: { in: settlementUnitIds } }, select: { id: true, unitCode: true, name: true, size: { select: { code: true, name: true } }, branch: { select: { id: true, name: true, code: true } } } })
    : [];
  const settlementUnitById = new Map(settlementUnits.map((u) => [u.id, u]));

  /** A-13 unit resolution for a settlement row: the settlement's own unit
   * first (survives completion), the tenant's active unit as fallback. */
  const settlementUnitOf = (s: (typeof settlements)[number]) => {
    const settled = settlementUnitById.get(s.unitId) ?? null;
    const active = s.tenant.unit ?? null;
    const u = settled ?? active;
    return {
      unit: u?.unitCode ?? null,
      unitName: u?.name ?? u?.unitCode ?? null,
      unitType: u?.size?.code ?? null,
      unitTypeLabel: u?.size?.name ?? null,
      facility: u?.branch?.name ?? null,
      facilityCode: u?.branch?.code ?? null,
      branchId: u?.branch?.id ?? null,
    };
  };

  const rows: (RegisterRow & { facilityCode: string | null; branchId: string | null })[] = [
    ...invoices.map((i) => {
      const status = i.voidedAt ? 'Void' : i.writtenOffAt ? 'Written off' : !i.approvedAt && i.status !== 'PAID' && i.createdBy ? 'Pending approval' : INVOICE_STATUS[i.status] ?? i.status;
      // A-14: invoices the settlement processor issues for a posted move-out
      // charge (processSettlement: createdBy `settlement:<ref>`, line
      // `Closing charge · <ref>`) get their own purpose — they are not
      // monthly rent, so the rent purpose must not label them.
      const settlementRef = i.createdBy?.startsWith('settlement:') ? i.createdBy.slice('settlement:'.length) : null;
      return {
        key: `invoice:${i.id}`, source: 'invoice' as const, id: i.id, date: ymd(i.issuedAt ?? i.billedMonth), recordId: i.invoiceNo,
        customer: i.tenant.name, tenantId: i.tenantId, unit: i.unit.unitCode, unitName: i.unit.name ?? i.unit.unitCode, unitType: i.unit.size?.code ?? null, unitTypeLabel: i.unit.size?.name ?? null, facility: i.unit.branch?.name ?? null, facilityCode: i.unit.branch?.code ?? null, branchId: i.unit.branch?.id ?? null,
        docType: 'Invoice' as const, purpose: settlementRef ? `Move-out settlement charge · ${settlementRef}` : `Monthly AC self-storage rent · ${month(i.billedMonth)}`, method: i.method, amount: toNum(i.amount),
        status, pending: status === 'Pending approval', approver: i.approvedBy, processor: i.paymentIntentId, scheduled: ymd(i.dueDate),
      };
    }),
    ...payments.map((p) => ({
      key: `payment:${p.id}`, source: 'payment' as const, id: p.id, date: ymd(p.createdAt), recordId: `PAY-${p.id.slice(-8).toUpperCase()}`,
      customer: p.tenant.name, tenantId: p.tenantId, unit: p.tenant.unit?.unitCode ?? null, unitName: p.tenant.unit?.name ?? p.tenant.unit?.unitCode ?? null, unitType: p.tenant.unit?.size?.code ?? null, unitTypeLabel: p.tenant.unit?.size?.name ?? null, facility: p.tenant.unit?.branch?.name ?? null, facilityCode: p.tenant.unit?.branch?.code ?? null, branchId: p.tenant.unit?.branch?.id ?? null,
      docType: 'Payment' as const, purpose: `Payment instruction · ${p.invoice.invoiceNo}`, method: p.method === 'SAVED_CARD' ? 'Saved card' : p.method,
      amount: toNum(p.amount), status: PAYMENT_STATUS[p.status] ?? p.status, pending: p.status === 'PENDING_APPROVAL',
      approver: p.approvedBy, processor: p.stripePaymentIntentId, scheduled: ymd(p.approvedAt),
    })),
    ...refunds.map((r) => ({
      key: `refund:${r.id}`, source: 'refund' as const, id: r.id, date: ymd(r.requestedAt), recordId: `RFD-${r.id.slice(-8).toUpperCase()}`,
      customer: r.tenant.name, tenantId: r.tenantId, unit: r.tenant.unit?.unitCode ?? null, unitName: r.tenant.unit?.name ?? r.tenant.unit?.unitCode ?? null, unitType: r.tenant.unit?.size?.code ?? null, unitTypeLabel: r.tenant.unit?.size?.name ?? null, facility: r.tenant.unit?.branch?.name ?? null, facilityCode: r.tenant.unit?.branch?.code ?? null, branchId: r.tenant.unit?.branch?.id ?? null,
      docType: 'Refund' as const, purpose: r.reason, method: 'Original payment method', amount: -toNum(r.amount),
      status: REFUND_STATUS[r.status] ?? r.status, pending: r.status === 'REQUESTED', approver: r.approvedBy, processor: r.gatewayRef ?? r.bankRef, scheduled: ymd(r.decidedAt),
    })),
    ...settlements.map((s) => ({
      key: `settlement:${s.id}`, source: 'settlement' as const, id: s.id, date: ymd(s.createdAt), recordId: s.ref,
      customer: s.tenant.name, tenantId: s.tenantId, ...settlementUnitOf(s),
      docType: s.docType as RegisterRow['docType'],
      purpose: s.kind === 'TRANSFER' ? 'Transfer settlement' : s.kind === 'MOVE_OUT' ? 'Move-out settlement' : 'Customer closing settlement',
      method: s.returnMethod === 'BANK' ? 'Bank transfer' : s.returnMethod === 'WALLET' ? 'Customer account credit' : s.docType === 'Refund' ? 'Original payment method' : toNum(s.amount) >= 0 ? 'Customer payment method' : 'Customer account credit',
      amount: toNum(s.amount), status: SETTLEMENT_STATUS[s.status] ?? s.status, pending: SETTLEMENT_PENDING.has(s.status), approver: s.approvedBy ?? s.decidedBy ?? 'Finance review',
      // Processor reference is evidence (record detail), not a table column —
      // but the register carries it for the processor filter + failure copy
      // (handoff §19: show Approved/Processing plus failure reason and Retry).
      processor: s.processorRef ?? s.processorAttempts[0]?.providerRef ?? (s.status === 'APPROVED' ? APPROVED_COPY : s.processingError),
      provider: (s.processorAttempts[0]?.provider ?? null) as string | null,
      scheduled: ymd(s.effectiveDate),
    })),
  ];

  const term = q.search?.trim().toLowerCase();
  const scoped = q.branchIds ? rows.filter((r) => r.branchId != null && q.branchIds!.includes(r.branchId)) : rows;
  const filtered = scoped.filter((r) => {
    if (q.docType && r.docType !== q.docType) return false;
    if (q.status && r.status !== q.status) return false;
    if (q.facility && r.facilityCode !== q.facility) return false;
    if (q.unitType && r.unitType !== q.unitType) return false;
    if (q.from && r.date < q.from) return false;
    if (q.to && r.date > q.to) return false;
    if (q.processor && (r.provider ?? '').toUpperCase() !== q.processor.trim().toUpperCase()) return false;
    if (term && ![r.recordId, r.customer, r.unit, r.facility, r.method, r.purpose].filter(Boolean).join(' ').toLowerCase().includes(term)) return false;
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date) || b.recordId.localeCompare(a.recordId));

  return {
    summary: {
      total: scoped.length,
      pending: scoped.filter((r) => r.pending).length,
      failed: scoped.filter((r) => r.status === 'Failed').length,
      refundsPending: scoped.filter((r) => r.pending && (r.docType === 'Refund' || r.docType === 'Transfer approval' || r.docType === 'Charge')).length,
    },
    rows: filtered,
  };
}

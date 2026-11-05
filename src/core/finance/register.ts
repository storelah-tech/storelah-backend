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
  facility: string | null;
  docType: (typeof REGISTER_DOC_TYPES)[number];
  purpose: string;
  method: string | null;
  amount: number; // negative = refund / credit to the customer
  status: string;
  pending: boolean;
  approver: string | null;
  processor: string | null;
  scheduled: string | null;
}

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '');
const month = (d: Date) => d.toLocaleDateString('en-SG', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const INVOICE_STATUS: Record<string, string> = { DUE: 'Due', PAID: 'Paid', OVERDUE: 'Overdue', VOID: 'Void', DRAFT: 'Draft' };
const PAYMENT_STATUS: Record<string, string> = { PENDING_APPROVAL: 'Pending approval', DRAFT: 'Draft', APPROVED: 'Approved', QUEUED: 'Approved', SUBMITTED: 'Processing', SUCCEEDED: 'Paid', FAILED: 'Failed', CANCELLED: 'Cancelled', EXPIRED: 'Expired' };
const REFUND_STATUS: Record<string, string> = { REQUESTED: 'Pending approval', APPROVED: 'Approved', REJECTED: 'Rejected', PAID: 'Paid' };

export async function listRegister(q: { search?: string; docType?: string; status?: string; facility?: string; from?: string; to?: string; branchIds?: string[] | null }) {
  const tenantSel = { select: { name: true, unit: { select: { unitCode: true, branch: { select: { id: true, name: true, code: true } } } } } } as const;
  const [invoices, payments, refunds, settlements] = await Promise.all([
    prisma.invoice.findMany({ include: { tenant: { select: { name: true } }, unit: { select: { unitCode: true, branch: { select: { id: true, name: true, code: true } } } } }, orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.paymentInstruction.findMany({ include: { tenant: tenantSel, invoice: { select: { invoiceNo: true, billedMonth: true } } }, orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.refund.findMany({ include: { tenant: tenantSel }, orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.customerSettlement.findMany({ include: { tenant: tenantSel }, orderBy: { createdAt: 'desc' }, take: 500 }),
  ]);

  const rows: (RegisterRow & { facilityCode: string | null; branchId: string | null })[] = [
    ...invoices.map((i) => {
      const status = i.voidedAt ? 'Void' : i.writtenOffAt ? 'Written off' : !i.approvedAt && i.status !== 'PAID' && i.createdBy ? 'Pending approval' : INVOICE_STATUS[i.status] ?? i.status;
      return {
        key: `invoice:${i.id}`, source: 'invoice' as const, id: i.id, date: ymd(i.issuedAt ?? i.billedMonth), recordId: i.invoiceNo,
        customer: i.tenant.name, tenantId: i.tenantId, unit: i.unit.unitCode, facility: i.unit.branch?.name ?? null, facilityCode: i.unit.branch?.code ?? null, branchId: i.unit.branch?.id ?? null,
        docType: 'Invoice' as const, purpose: `Monthly AC self-storage rent · ${month(i.billedMonth)}`, method: i.method, amount: toNum(i.amount),
        status, pending: status === 'Pending approval', approver: i.approvedBy, processor: i.paymentIntentId, scheduled: ymd(i.dueDate),
      };
    }),
    ...payments.map((p) => ({
      key: `payment:${p.id}`, source: 'payment' as const, id: p.id, date: ymd(p.createdAt), recordId: `PAY-${p.id.slice(-8).toUpperCase()}`,
      customer: p.tenant.name, tenantId: p.tenantId, unit: p.tenant.unit?.unitCode ?? null, facility: p.tenant.unit?.branch?.name ?? null, facilityCode: p.tenant.unit?.branch?.code ?? null, branchId: p.tenant.unit?.branch?.id ?? null,
      docType: 'Payment' as const, purpose: `Payment instruction · ${p.invoice.invoiceNo}`, method: p.method === 'SAVED_CARD' ? 'Saved card' : p.method,
      amount: toNum(p.amount), status: PAYMENT_STATUS[p.status] ?? p.status, pending: p.status === 'PENDING_APPROVAL',
      approver: p.approvedBy, processor: p.stripePaymentIntentId, scheduled: ymd(p.approvedAt),
    })),
    ...refunds.map((r) => ({
      key: `refund:${r.id}`, source: 'refund' as const, id: r.id, date: ymd(r.requestedAt), recordId: `RFD-${r.id.slice(-8).toUpperCase()}`,
      customer: r.tenant.name, tenantId: r.tenantId, unit: r.tenant.unit?.unitCode ?? null, facility: r.tenant.unit?.branch?.name ?? null, facilityCode: r.tenant.unit?.branch?.code ?? null, branchId: r.tenant.unit?.branch?.id ?? null,
      docType: 'Refund' as const, purpose: r.reason, method: 'Original payment method', amount: -toNum(r.amount),
      status: REFUND_STATUS[r.status] ?? r.status, pending: r.status === 'REQUESTED', approver: r.approvedBy, processor: r.gatewayRef ?? r.bankRef, scheduled: ymd(r.decidedAt),
    })),
    ...settlements.map((s) => ({
      key: `settlement:${s.id}`, source: 'settlement' as const, id: s.id, date: ymd(s.createdAt), recordId: s.ref,
      customer: s.tenant.name, tenantId: s.tenantId, unit: s.tenant.unit?.unitCode ?? null, facility: s.tenant.unit?.branch?.name ?? null, facilityCode: s.tenant.unit?.branch?.code ?? null, branchId: s.tenant.unit?.branch?.id ?? null,
      docType: s.docType as RegisterRow['docType'],
      purpose: s.kind === 'TRANSFER' ? 'Transfer settlement' : s.kind === 'MOVE_OUT' ? 'Move-out settlement' : 'Customer closing settlement',
      method: s.docType === 'Refund' ? 'Original payment method' : toNum(s.amount) >= 0 ? 'Customer payment method' : 'Customer account credit',
      amount: toNum(s.amount), status: s.status === 'PENDING' ? 'Pending approval' : s.status === 'APPROVED' ? 'Approved' : 'Rejected',
      pending: s.status === 'PENDING', approver: s.decidedBy ?? 'Finance review', processor: s.status === 'APPROVED' ? 'Posting pending (owner decision Q16)' : 'Created after approval', scheduled: ymd(s.effectiveDate),
    })),
  ];

  const term = q.search?.trim().toLowerCase();
  const scoped = q.branchIds ? rows.filter((r) => r.branchId != null && q.branchIds!.includes(r.branchId)) : rows;
  const filtered = scoped.filter((r) => {
    if (q.docType && r.docType !== q.docType) return false;
    if (q.status && r.status !== q.status) return false;
    if (q.facility && r.facilityCode !== q.facility) return false;
    if (q.from && r.date < q.from) return false;
    if (q.to && r.date > q.to) return false;
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

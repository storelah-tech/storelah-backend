// Quotation register (prototype 2026-11-04, Leads › Quotes).
//
// Every issued quotation is one serialised Quotation row (QT-YYYY-#####);
// rows issued before the register keep their Q-CM… numbers. Lifecycle:
//   DRAFT ──send──▶ SENT ──(viewed/accepted)──▶ … ; SENT past expiry reads EXPIRED.
// Issued quotations are never deleted: they are voided so history survives.
// Only DRAFT rows can be deleted, and only by an operator holding quotes:delete.

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { toNum } from '../lib/format';
import { displayLeadNo } from './leadPipeline';
import { quotationFilename } from './quotationPdf';

export const QUOTE_VALID_DAYS = 14;
export const QUOTE_STATUSES = ['DRAFT', 'SENT', 'VIEWED', 'ACCEPTED', 'EXPIRED', 'VOIDED'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** Next register number for the issue year (Asia/Singapore): QT-YYYY-#####. */
export async function nextRegisterQuoteNo(issuedAt: Date): Promise<string> {
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric' }).format(issuedAt);
  const prefix = `QT-${year}-`;
  const last = await prisma.quotation.findFirst({
    where: { quoteNo: { startsWith: prefix } },
    orderBy: { quoteNo: 'desc' },
    select: { quoteNo: true },
  });
  const seq = last ? Number(last.quoteNo.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(5, '0')}`;
}

const num = (v: Prisma.Decimal | null | undefined) => (v == null ? null : toNum(v));

type RegisterRow = Prisma.QuotationGetPayload<{
  include: { lead: { select: { id: true; leadNo: true; name: true; companyName: true; type: true; owner: true; unitCode: true; branch: { select: { code: true; name: true } } } } };
}>;

/** Effective status: a SENT/VIEWED quote past its expiry reads EXPIRED. */
export function effectiveStatus(q: { status: string; expiresAt: Date | null }, now = new Date()): string {
  if ((q.status === 'SENT' || q.status === 'VIEWED') && q.expiresAt && q.expiresAt.getTime() < now.getTime()) return 'EXPIRED';
  return q.status;
}

function serializeRegisterRow(q: RegisterRow) {
  const gross = num(q.grossRate) ?? num(q.monthlyRate);
  const promo = num(q.promoPct);
  const net = gross == null ? null : Math.round(gross * (1 - (promo ?? 0) / 100) * 100) / 100;
  const protection = num(q.protectionMonthly);
  return {
    id: q.id,
    number: q.quoteNo,
    leadId: q.leadId,
    leadDisplayId: displayLeadNo(q.lead.leadNo),
    leadName: q.lead.type === 'BUSINESS' && q.lead.companyName ? q.lead.companyName : q.lead.name,
    enquiry: displayLeadNo(q.lead.leadNo),
    unit: q.unitCode ?? q.lead.unitCode ?? null,
    facility: q.lead.branch?.name ?? null,
    facilityCode: q.lead.branch?.code ?? null,
    gross,
    promotionPct: promo,
    net,
    protection,
    estimatedMonthly: net == null ? null : Math.round((net + (protection ?? 0)) * 100) / 100,
    commitmentMonths: q.commitmentMonths,
    createdAt: q.createdAt,
    expiresAt: q.expiresAt,
    status: effectiveStatus(q),
    delivery: q.delivery ?? (q.emailStatus === 'SENT' ? 'Email · sent' : `Email · ${q.emailStatus.toLowerCase()}`),
    owner: q.createdBy ?? q.lead.owner ?? null,
    hasPdf: q.pdf != null,
    voidedAt: q.voidedAt,
    voidReason: q.voidReason,
  };
}

const INCLUDE = {
  lead: { select: { id: true, leadNo: true, name: true, companyName: true, type: true, owner: true, unitCode: true, branch: { select: { code: true, name: true } } } },
} as const;

export async function listQuotationRegister(q: { search?: string; status?: string; facility?: string }) {
  const rows = await prisma.quotation.findMany({ include: INCLUDE, orderBy: { createdAt: 'desc' } });
  const all = rows.map(serializeRegisterRow);
  const term = q.search?.trim().toLowerCase();
  const filtered = all.filter((r) => {
    if (q.status && r.status !== q.status) return false;
    if (q.facility && r.facilityCode !== q.facility) return false;
    if (term) {
      const hay = [r.number, r.leadName, r.leadDisplayId, r.enquiry, r.unit, r.owner].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });
  return {
    summary: {
      total: all.length,
      awaitingFollowUp: all.filter((r) => r.status === 'SENT' || r.status === 'VIEWED').length,
      accepted: all.filter((r) => r.status === 'ACCEPTED').length,
      drafts: all.filter((r) => r.status === 'DRAFT').length,
    },
    rows: filtered,
  };
}

async function load(id: string) {
  const q = await prisma.quotation.findUnique({ where: { id }, include: INCLUDE });
  if (!q) throw new AppError(404, 'NOT_FOUND', `Quotation ${id} not found`);
  return q;
}

export async function voidQuotation(id: string, opts: { reason: string; actor: string }) {
  const q = await load(id);
  if (q.status === 'DRAFT') throw new AppError(409, 'CONFLICT', 'Drafts are deleted, not voided.');
  if (q.status === 'VOIDED') throw new AppError(409, 'CONFLICT', `${q.quoteNo} is already void.`);
  const saved = await prisma.quotation.update({
    where: { id },
    data: { status: 'VOIDED', voidedAt: new Date(), voidedBy: opts.actor.slice(0, 120), voidReason: opts.reason.trim().slice(0, 500) },
    include: INCLUDE,
  });
  return serializeRegisterRow(saved);
}

/** Only DRAFT rows are deletable; issued ones must be voided to keep the audit trail. */
export async function deleteDraftQuotation(id: string) {
  const q = await load(id);
  if (q.status !== 'DRAFT') {
    throw new AppError(409, 'CONFLICT', 'Issued, sent or accepted quotations cannot be deleted. Void them to retain the audit trail.');
  }
  await prisma.quotation.delete({ where: { id } });
  return { id, number: q.quoteNo, deleted: true };
}

/** Copies an issued quotation's terms into a new DRAFT (no number consumed, no PDF). */
export async function duplicateAsDraft(id: string, actor: string) {
  const q = await load(id);
  const saved = await prisma.quotation.create({
    data: {
      quoteNo: `DRAFT-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      leadId: q.leadId,
      unitCode: q.unitCode,
      monthlyRate: q.monthlyRate ?? undefined,
      totalDueToday: q.totalDueToday ?? undefined,
      grossRate: q.grossRate ?? undefined,
      promoPct: q.promoPct ?? undefined,
      protectionMonthly: q.protectionMonthly ?? undefined,
      commitmentMonths: q.commitmentMonths ?? undefined,
      status: 'DRAFT',
      emailStatus: 'SKIPPED',
      emailReason: 'draft',
      delivery: 'Not sent',
      createdBy: actor.slice(0, 120),
    },
    include: INCLUDE,
  });
  return serializeRegisterRow(saved);
}

/** Records a manual re-send of the issued PDF (delivery queued + logged). */
export async function resendQuotation(id: string, channels: string[]) {
  const q = await load(id);
  if (q.status === 'DRAFT' || q.status === 'VOIDED') throw new AppError(409, 'CONFLICT', `${q.quoteNo} cannot be sent in status ${q.status}.`);
  const label = channels.length ? channels.join(' + ') : 'Email';
  const saved = await prisma.quotation.update({ where: { id }, data: { delivery: `${label} · queued` }, include: INCLUDE });
  return serializeRegisterRow(saved);
}

export async function getQuotationPdfById(id: string): Promise<{ bytes: Buffer; filename: string; quoteNo: string }> {
  const q = await prisma.quotation.findUnique({ where: { id }, select: { pdf: true, pdfFilename: true, quoteNo: true } });
  if (!q || !q.pdf) throw new AppError(404, 'NOT_FOUND', 'No issued PDF for this quotation.');
  return { bytes: Buffer.from(q.pdf), filename: q.pdfFilename?.trim() ? q.pdfFilename : quotationFilename(q.quoteNo), quoteNo: q.quoteNo };
}

export { serializeRegisterRow };

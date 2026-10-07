// P1 item 4 — quotes ops (no migration, by design).
//
// A "quote" is NOT a separate table: it is a Lead in stage PROPOSAL_SENT with
// its unit options resolved live from current inventory (AVAILABLE units
// matching preferredBranchId / preferredSize). Rationale (see
// docs/P1_QUOTES_MOVEOUTS.md): a quote is pipeline state, not a snapshot —
// snapshotting unit + rate at quote time would go stale the moment rates move
// (adjustRate) or units lease, while the live read is always truthful.
// Conversion is already modelled: PROPOSAL_SENT → WON (+ Booking), loss via
// LOST + lossReason/lossValue. Stage transitions reuse PATCH /leads/:id, so
// this module is a read-model over existing rows.
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { createLead } from './leads';
import { getSetting } from './settings';
import { buildQuotationPdfBytes, deriveQuoteNo, quotationFilename, type QuotationPdfData } from './quotationPdf';
import { sendQuotationEmail } from './emails';

const QUOTE_STAGE = 'PROPOSAL_SENT' as const;
const MAX_OPTIONS = 25;

// Stages that can never appear in the "Existing lead" quotation picker: the
// already-quoted stage plus both terminal stages (see TERMINAL_STAGES below).
// Every other stage (NEW_ENQUIRY, CONTACTED, VIEWING_BOOKED, PENDING_PAYMENT)
// is quotable. Server-side guards in createQuotation (409 on WON/LOST /
// already-quoted) stay authoritative — the picker is a UX filter only.
const NON_QUOTABLE_STAGES = ['PROPOSAL_SENT', 'WON', 'LOST'] as const;

export const QUOTABLE_STAGE_LABEL: Record<string, string> = {
  NEW_ENQUIRY: 'New enquiry',
  CONTACTED: 'Contacted',
  VIEWING_BOOKED: 'Viewing booked',
  PENDING_PAYMENT: 'Pending payment',
};

export interface QuoteInventoryQuery {
  branchId?: string;
  size?: string;
}

async function inventoryOptions(query: QuoteInventoryQuery) {
  const units = await prisma.unit.findMany({
    where: {
      deletedAt: null,
      status: 'AVAILABLE',
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.size ? { size: { code: query.size } } : {}),
    },
    include: { size: true, branch: true },
    orderBy: { monthlyRate: 'asc' },
    take: MAX_OPTIONS,
  });
  return units.map((u) => {
    const rate = toNum(u.monthlyRate);
    return {
      code: u.unitCode,
      branchCode: u.branch.code,
      sizeCode: u.size.code,
      size: u.size.name,
      sqft: u.sqft,
      rate,
      psf: u.sqft ? rate / u.sqft : 0,
    };
  });
}

async function matchingAvailableCount(branchId?: string | null, size?: string | null) {
  return prisma.unit.count({
    where: {
      deletedAt: null,
      status: 'AVAILABLE',
      ...(branchId ? { branchId } : {}),
      ...(size ? { size: { code: size } } : {}),
    },
  });
}

function serializeQuote(
  l: {
    id: string;
    name: string;
    type: string;
    segment: string | null;
    stage: string;
    source: string;
    preferredSize: string | null;
    preferredBranchId: string | null;
    monthlyRate: unknown;
    email: string | null;
    mobile: string | null;
    owner: string | null;
    nextActionAt: Date | null;
    note: string | null;
    createdAt: Date;
    updatedAt: Date;
    branch: { code: string; name: string } | null;
  },
  matchingAvailable: number,
  quotation?: QuotationMeta | null,
) {
  return {
    id: l.id,
    name: l.name,
    type: l.type,
    segment: l.segment,
    stage: l.stage,
    source: l.source,
    preferredSize: l.preferredSize,
    preferredBranchId: l.preferredBranchId,
    branchCode: l.branch?.code ?? '',
    branchName: l.branch?.name ?? '',
    monthlyRate: l.monthlyRate ? toNum(l.monthlyRate as never) : null,
    email: l.email,
    mobile: l.mobile,
    owner: l.owner,
    nextActionAt: l.nextActionAt,
    note: l.note,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
    // Live inventory for this quote (recomputed per read — never stored).
    matchingAvailable,
    // Latest issued quotation document for this lead (null when no PDF has
    // been issued yet — e.g. rows quoted before the Quotation model existed).
    quotation: quotation ?? null,
  };
}

export interface QuotationMeta {
  quoteNo: string;
  pdfUrl: string;
  emailStatus: string;
  emailReason: string | null;
  createdAt: Date;
}

function toQuotationMeta(q: {
  quoteNo: string;
  emailStatus: string;
  emailReason: string | null;
  createdAt: Date;
  leadId: string;
}): QuotationMeta {
  return {
    quoteNo: q.quoteNo,
    pdfUrl: `/api/v1/cms/quotes/${q.leadId}/pdf`,
    emailStatus: q.emailStatus,
    emailReason: q.emailReason,
    createdAt: q.createdAt,
  };
}

// Latest issued Quotation row per lead (one query for the whole queue —
// avoids N+1 on listQuotes). Leads without a row map to null.
async function latestQuotationByLead(leadIds: string[]): Promise<Map<string, QuotationMeta>> {
  const out = new Map<string, QuotationMeta>();
  if (!leadIds.length) return out;
  const rows = await prisma.quotation.findMany({
    where: { leadId: { in: leadIds } },
    select: { leadId: true, quoteNo: true, emailStatus: true, emailReason: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  for (const r of rows) {
    if (!out.has(r.leadId)) out.set(r.leadId, toQuotationMeta(r));
  }
  return out;
}

// Operator quotes queue: every PROPOSAL_SENT lead + live availability match.
export async function listQuotes() {
  const leads = await prisma.lead.findMany({
    where: { stage: QUOTE_STAGE },
    include: { branch: { select: { code: true, name: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  const quotations = await latestQuotationByLead(leads.map((l) => l.id));
  const rows = await Promise.all(
    leads.map(async (l) =>
      serializeQuote(l, await matchingAvailableCount(l.preferredBranchId, l.preferredSize), quotations.get(l.id) ?? null),
    ),
  );
  const quotedValue = rows.reduce((s, q) => s + (q.monthlyRate ?? 0), 0);
  return { rows, meta: { count: rows.length, quotedValue: Math.round(quotedValue) } };
}

// Quotable leads for the quotation "Existing lead" picker: every lead NOT in
// a non-quotable stage (excludes already-quoted PROPOSAL_SENT + terminal
// WON/LOST). Each row carries its stage label for the picker display.
export async function listQuotableLeads() {
  const leads = await prisma.lead.findMany({
    where: { stage: { notIn: [...NON_QUOTABLE_STAGES] } },
    select: {
      id: true,
      name: true,
      stage: true,
      email: true,
      mobile: true,
      preferredSize: true,
      preferredBranchId: true,
      branch: { select: { code: true, name: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });
  const rows = leads.map((l) => ({
    id: l.id,
    name: l.name,
    stage: l.stage,
    stageLabel: QUOTABLE_STAGE_LABEL[l.stage as string] ?? l.stage,
    email: l.email,
    mobile: l.mobile,
    preferredSize: l.preferredSize,
    preferredBranchId: l.preferredBranchId,
    branchCode: l.branch?.code ?? '',
    branchName: l.branch?.name ?? '',
  }));
  return { rows, meta: { count: rows.length } };
}

// Single quote + concrete unit options the operator can offer right now.
export async function getQuote(id: string, opts?: { branchId?: string; size?: string }) {
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: { branch: { select: { code: true, name: true } } },
  });
  if (!lead) throw new AppError(404, 'NOT_FOUND', `Lead ${id} not found`);
  if (lead.stage !== QUOTE_STAGE) {
    throw new AppError(409, 'CONFLICT', `Lead ${id} is in stage ${lead.stage}, not ${QUOTE_STAGE}`);
  }
  const branchId = opts?.branchId ?? lead.preferredBranchId ?? undefined;
  const size = opts?.size ?? lead.preferredSize ?? undefined;
  const quotations = await latestQuotationByLead([lead.id]);
  const [matchingAvailable, options] = await Promise.all([
    matchingAvailableCount(lead.preferredBranchId, lead.preferredSize),
    inventoryOptions({ branchId, size }),
  ]);
  return { quote: serializeQuote(lead, matchingAvailable, quotations.get(lead.id) ?? null), options };
}

export interface CreateQuotationInput {
  // Transition path: quote an existing lead by id (any supplied fields below
  // are applied as overrides on the same write).
  leadId?: string;
  // Create path: required when leadId is omitted (a new PROPOSAL_SENT lead).
  name?: string;  type?: 'PERSONAL' | 'BUSINESS';
  segment?: string | null;
  source?: 'WEBSITE' | 'WHATSAPP' | 'REFERRAL' | 'GOOGLE';
  preferredSize?: string | null;
  preferredBranchId?: string | null;
  monthlyRate?: number | null;
  note?: string | null;
  email?: string | null;
  mobile?: string | null;
  owner?: string | null;
  nextActionAt?: Date | null;
  unitCode?: string | null;
  moveInDate?: Date | null;
  durationMonths?: number | null;
  companyName?: string | null;
  uen?: string | null;
  consentPdpa?: boolean | null;
  consentMarketing?: boolean | null;
  protectionTier?: string | null;
  protectionCost?: number | null;
  addons?: { id?: string; name: string; qty: number; price: number }[] | null;
  promoCode?: string | null;
  promoDiscountAmt?: number | null;
  movingService?: boolean | null;
  totalDueToday?: number | null;
}

// Terminal stages are forward-only (see markLeadWonForBooking in leads.ts):
// a quotation is never resurrected from WON/LOST.
const TERMINAL_STAGES = ['WON', 'LOST'] as const;

async function assertQuotationRefs(input: Pick<CreateQuotationInput, 'preferredBranchId' | 'preferredSize' | 'unitCode'>) {
  if (input.preferredBranchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.preferredBranchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', 'Unknown preferredBranchId');
  }
  if (input.preferredSize) {
    const size = await prisma.unitSize.findUnique({ where: { code: input.preferredSize } });
    if (!size) throw new AppError(400, 'VALIDATION', `Unknown preferredSize: ${input.preferredSize}`);
  }
  if (input.unitCode) {
    const unit = await prisma.unit.findFirst({ where: { unitCode: input.unitCode, deletedAt: null } });
    if (!unit) throw new AppError(404, 'NOT_FOUND', `Unit ${input.unitCode} not found`);
    if (unit.status !== 'AVAILABLE') {
      throw new AppError(409, 'CONFLICT', `Unit ${input.unitCode} is ${unit.status}, not AVAILABLE`, {
        unitCode: input.unitCode,
        status: unit.status,
      });
    }
  }
}

// Create path duplicate guard: an OPEN quotation (PROPOSAL_SENT) already on
// file for the same contact + facility is the same quotation — resubmitting is
// a 409, not a second row. Contacts without email/mobile skip the guard.
async function assertNoOpenQuotation(input: Pick<CreateQuotationInput, 'email' | 'mobile' | 'preferredBranchId'>) {
  const email = input.email?.trim() ? input.email.trim() : null;
  const mobile = input.mobile?.trim() ? input.mobile.trim() : null;
  if (!email && !mobile) return;
  const contactOr = [];
  if (email) contactOr.push({ email: { equals: email, mode: 'insensitive' as const } });
  if (mobile) contactOr.push({ mobile: { equals: mobile } });
  const existing = await prisma.lead.findFirst({
    where: {
      stage: QUOTE_STAGE,
      preferredBranchId: { equals: input.preferredBranchId?.trim() ? input.preferredBranchId.trim() : null },
      OR: contactOr,
    },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    throw new AppError(409, 'DUPLICATE', 'An open quotation already exists for this contact at this facility', {
      existingLeadId: existing.id,
    });
  }
}

// Create a quotation (CMS operator action). Two shapes, one outcome — a
// PROPOSAL_SENT lead returned with its live unit options (same payload as
// GET /quotes/:id) PLUS the issued quotation document metadata:
//   - { leadId } transitions an existing lead to PROPOSAL_SENT (409 when the
//     lead is already quoted or in a terminal WON/LOST stage);
//   - otherwise a new PROPOSAL_SENT lead is created (409 on an open duplicate).
//
// After the lead write commits, the quotation PDF is generated, persisted on
// a Quotation row and emailed to the lead — BEST-EFFORT (finalizeQuotation
// never throws): quotation creation succeeds even when PDF/email fails, and
// the honest outcome rides along as `quotation` (emailStatus SKIPPED/FAILED +
// emailReason, or quotation: null when even persistence failed).
export async function createQuotation(input: CreateQuotationInput, opts?: { createdBy?: string | null }) {
  const createdBy = opts?.createdBy?.trim() ? opts.createdBy.trim().slice(0, 120) : null;
  if (input.leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: input.leadId } });
    if (!lead) throw new AppError(404, 'NOT_FOUND', `Lead ${input.leadId} not found`);
    if (lead.stage === QUOTE_STAGE) {
      throw new AppError(409, 'CONFLICT', `Lead ${input.leadId} is already quoted`, { leadId: lead.id });
    }
    if ((TERMINAL_STAGES as readonly string[]).includes(lead.stage)) {
      throw new AppError(409, 'CONFLICT', `Lead ${input.leadId} is ${lead.stage} and cannot be quoted`, {
        leadId: lead.id,
        stage: lead.stage,
      });
    }
    await assertQuotationRefs(input);
    const { leadId: _leadId, ...overrides } = input;
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        stage: QUOTE_STAGE,
        ...(overrides.name !== undefined ? { name: overrides.name.trim() } : {}),
        ...(overrides.type !== undefined ? { type: overrides.type } : {}),
        ...(overrides.segment !== undefined ? { segment: overrides.segment } : {}),
        ...(overrides.source !== undefined ? { source: overrides.source } : {}),
        ...(overrides.preferredSize !== undefined ? { preferredSize: overrides.preferredSize } : {}),
        ...(overrides.preferredBranchId !== undefined ? { preferredBranchId: overrides.preferredBranchId } : {}),
        ...(overrides.monthlyRate !== undefined ? { monthlyRate: overrides.monthlyRate } : {}),
        ...(overrides.note !== undefined ? { note: overrides.note } : {}),
        ...(overrides.email !== undefined ? { email: overrides.email } : {}),
        ...(overrides.mobile !== undefined ? { mobile: overrides.mobile } : {}),
        ...(overrides.owner !== undefined ? { owner: overrides.owner } : {}),
        ...(overrides.nextActionAt !== undefined ? { nextActionAt: overrides.nextActionAt } : {}),
        ...(overrides.unitCode !== undefined ? { unitCode: overrides.unitCode } : {}),
        ...(overrides.moveInDate !== undefined ? { moveInDate: overrides.moveInDate } : {}),
        ...(overrides.durationMonths !== undefined ? { durationMonths: overrides.durationMonths } : {}),
        ...(overrides.companyName !== undefined ? { companyName: overrides.companyName } : {}),
        ...(overrides.uen !== undefined ? { uen: overrides.uen } : {}),
        ...(overrides.consentPdpa !== undefined ? { consentPdpa: overrides.consentPdpa } : {}),
        ...(overrides.consentMarketing !== undefined ? { consentMarketing: overrides.consentMarketing } : {}),
        ...(overrides.protectionTier !== undefined ? { protectionTier: overrides.protectionTier } : {}),
        ...(overrides.protectionCost !== undefined ? { protectionCost: overrides.protectionCost } : {}),
        ...(overrides.addons !== undefined
          ? { addons: overrides.addons === null ? Prisma.DbNull : (overrides.addons as Prisma.InputJsonValue) }
          : {}),
        ...(overrides.promoCode !== undefined ? { promoCode: overrides.promoCode } : {}),
        ...(overrides.promoDiscountAmt !== undefined ? { promoDiscountAmt: overrides.promoDiscountAmt } : {}),
        ...(overrides.movingService !== undefined ? { movingService: overrides.movingService } : {}),
        ...(overrides.totalDueToday !== undefined ? { totalDueToday: overrides.totalDueToday } : {}),
      },
    });
    return withFinalizedQuotation(lead.id, { createdBy });
  }

  if (!input.name?.trim()) {
    throw new AppError(400, 'VALIDATION', 'Either leadId or name is required');
  }
  await assertQuotationRefs(input);
  await assertNoOpenQuotation(input);
  const createdLead = await createLead({
    name: input.name.trim(),
    type: input.type ?? 'PERSONAL',
    segment: input.segment ?? null,
    stage: QUOTE_STAGE,
    source: input.source ?? 'WEBSITE',
    preferredSize: input.preferredSize ?? null,
    preferredBranchId: input.preferredBranchId ?? null,
    monthlyRate: input.monthlyRate ?? null,
    note: input.note ?? null,
    email: input.email ?? null,
    mobile: input.mobile ?? null,
    owner: input.owner ?? null,
    nextActionAt: input.nextActionAt ?? null,
    unitCode: input.unitCode ?? null,
    moveInDate: input.moveInDate ?? null,
    durationMonths: input.durationMonths ?? null,
    companyName: input.companyName ?? null,
    uen: input.uen ?? null,
    consentPdpa: input.consentPdpa ?? null,
    consentMarketing: input.consentMarketing ?? null,
    protectionTier: input.protectionTier ?? null,
    protectionCost: input.protectionCost ?? null,
    addons: input.addons ?? null,
    promoCode: input.promoCode ?? null,
    promoDiscountAmt: input.promoDiscountAmt ?? null,
    movingService: input.movingService ?? null,
    totalDueToday: input.totalDueToday ?? null,
  });
  // createdLead is the serializeLead shape; re-read through the finalized
  // path so the create response carries { quote, options, quotation }.
  return withFinalizedQuotation(createdLead.id, { createdBy });
}

// Reads the committed PROPOSAL_SENT lead, issues the quotation PDF + row +
// email (best-effort), and returns the { quote, options, quotation } payload.
async function withFinalizedQuotation(leadId: string, opts: { createdBy: string | null }) {
  const detail = await getQuote(leadId);
  const quotation = await finalizeQuotation(leadId, opts);
  return { ...detail, quotation };
}

async function resolveSupportContact(): Promise<string> {
  try {
    const v = await getSetting('operations.supportContact');
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch {
    // Best-effort only — fall through to the default.
  }
  return 'ops@storelah.sg';
}

function toNumOrNull(v: unknown): number | null {
  if (v == null) return null;
  try {
    return toNum(v as never);
  } catch {
    return null;
  }
}

type FinalizedLead = Prisma.LeadGetPayload<{ include: { branch: true } }>;

/**
 * Next quotation seq for a lead: 1-based count of Quotation rows already on
 * file for that lead + 1. The quoteNo UNIQUE constraint is the backstop: on a
 * same-day double-submit race the second insert 409s at the DB layer and we
 * retry once with a fresh seq (see below).
 */
async function nextQuoteSeq(leadId: string): Promise<number> {
  return (await prisma.quotation.count({ where: { leadId } })) + 1;
}

function quotationPdfData(
  lead: FinalizedLead,
  unit: { name: string | null; sqft: number | null } | null,
  quoteNo: string,
  issuedAt: Date,
  supportContact: string,
): QuotationPdfData {
  const addonsRaw = lead.addons as { name?: unknown; qty?: unknown; price?: unknown }[] | null;
  return {
    quoteNo,
    issuedAt,
    leadName: lead.name,
    leadEmail: lead.email,
    leadMobile: lead.mobile,
    leadType: lead.type,
    unitCode: lead.unitCode,
    unitDisplayName: unit?.name?.trim() ? unit.name : (lead.unitCode ?? null),
    unitSqft: unit?.sqft ?? null,
    branchName: lead.branch?.name ?? null,
    branchAddress: lead.branch?.address?.trim() ? lead.branch.address : null,
    preferredSize: lead.preferredSize,
    monthlyRate: toNumOrNull(lead.monthlyRate),
    durationMonths: lead.durationMonths,
    moveInDate: lead.moveInDate,
    protectionTier: lead.protectionTier,
    protectionCost: toNumOrNull(lead.protectionCost),
    addons: Array.isArray(addonsRaw)
      ? addonsRaw
          .filter((a) => a && typeof a.name === 'string' && a.name.trim())
          .slice(0, 20)
          .map((a) => ({
            name: String(a.name).trim(),
            qty: typeof a.qty === 'number' && a.qty > 0 ? Math.floor(a.qty) : 1,
            price: typeof a.price === 'number' && a.price >= 0 ? a.price : 0,
          }))
      : [],
    promoCode: lead.promoCode,
    promoDiscountAmt: toNumOrNull(lead.promoDiscountAmt),
    movingService: lead.movingService,
    totalDueToday: toNumOrNull(lead.totalDueToday),
    note: lead.note,
    owner: lead.owner,
    supportContact,
  };
}

/**
 * Generates the quotation PDF, persists the Quotation row and emails it to
 * the lead. Runs AFTER the PROPOSAL_SENT lead write commits. NEVER throws —
 * every failure is swallowed to null (creation succeeds regardless) except
 * that email send-failures/skip reasons are recorded on the row when it was
 * persisted. Logs carry lead id/quoteNo only — never recipient PII.
 */
export async function finalizeQuotation(
  leadId: string,
  opts?: { createdBy?: string | null },
): Promise<QuotationMeta | null> {
  try {
    const lead = (await prisma.lead.findUnique({
      where: { id: leadId },
      include: { branch: true },
    })) as FinalizedLead | null;
    if (!lead) return null;

    let unit: { name: string | null; sqft: number | null } | null = null;
    if (lead.unitCode?.trim()) {
      unit = await prisma.unit.findFirst({
        where: { unitCode: lead.unitCode.trim(), deletedAt: null },
        select: { name: true, sqft: true },
      });
    }
    const supportContact = await resolveSupportContact();
    const issuedAt = new Date();
    const dataFor = (quoteNo: string): QuotationPdfData =>
      quotationPdfData(lead, unit, quoteNo, issuedAt, supportContact);

    // PDF first (no row without bytes worth storing).
    const seq = await nextQuoteSeq(lead.id);
    const quoteNo = deriveQuoteNo(lead.id, issuedAt, seq);
    let pdf: Buffer;
    try {
      pdf = await buildQuotationPdfBytes(dataFor(quoteNo));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[quotation] PDF generation failed leadId=${lead.id} quoteNo=${quoteNo}: ${message}`);
      return null;
    }

    const filename = quotationFilename(quoteNo);
    let row: { quoteNo: string; emailStatus: string; emailReason: string | null; createdAt: Date; leadId: string };
    try {
      row = await prisma.quotation.create({
        data: {
          quoteNo,
          leadId: lead.id,
          unitCode: lead.unitCode,
          monthlyRate: lead.monthlyRate ?? undefined,
          totalDueToday: lead.totalDueToday ?? undefined,
          // Prisma Bytes is Uint8Array<ArrayBuffer>; Buffer's backing store
          // types as ArrayBufferLike, so copy into a fresh Uint8Array.
          pdf: new Uint8Array(pdf),
          pdfFilename: filename,
          createdBy: opts?.createdBy?.trim() ? opts.createdBy.trim().slice(0, 120) : null,
          emailStatus: 'PENDING',
        },
        select: { quoteNo: true, emailStatus: true, emailReason: true, createdAt: true, leadId: true },
      });
    } catch (err) {
      // Same-day double-submit race on the UNIQUE quoteNo: retry once with a
      // fresh seq so the second quotation still issues instead of dropping
      // the document.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        try {
          const retrySeq = await nextQuoteSeq(lead.id);
          const retryNo = deriveQuoteNo(lead.id, new Date(), retrySeq);
          const retryPdf = await buildQuotationPdfBytes(dataFor(retryNo));
          row = await prisma.quotation.create({
            data: {
              quoteNo: retryNo,
              leadId: lead.id,
              unitCode: lead.unitCode,
              monthlyRate: lead.monthlyRate ?? undefined,
              totalDueToday: lead.totalDueToday ?? undefined,
              pdf: new Uint8Array(retryPdf),
              pdfFilename: quotationFilename(retryNo),
              createdBy: opts?.createdBy?.trim() ? opts.createdBy.trim().slice(0, 120) : null,
              emailStatus: 'PENDING',
            },
            select: { quoteNo: true, emailStatus: true, emailReason: true, createdAt: true, leadId: true },
          });
        } catch (retryErr) {
          const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error(`[quotation] persist retry failed leadId=${lead.id}: ${message}`);
          return null;
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[quotation] persist failed leadId=${lead.id} quoteNo=${quoteNo}: ${message}`);
        return null;
      }
    }

    // Email best-effort; the honest outcome is stamped back on the row.
    const toEmail = (lead.email ?? '').trim();
    if (!toEmail) {
      await prisma.quotation
        .update({ where: { quoteNo: row!.quoteNo }, data: { emailStatus: 'SKIPPED', emailReason: 'no-recipient' } })
        .catch(() => undefined);
      console.log(`[quotation] email skipped quoteNo=${row!.quoteNo} (no recipient email)`);
      return toQuotationMeta({ ...row!, emailStatus: 'SKIPPED', emailReason: 'no-recipient' });
    }
    try {
      const result = await sendQuotationEmail(
        {
          toEmail,
          leadId: lead.id,
          leadName: lead.name,
          quoteNo: row!.quoteNo,
          unitCode: lead.unitCode,
          branchName: lead.branch?.name ?? null,
          monthlyRateSgd: toNumOrNull(lead.monthlyRate),
          totalDueTodaySgd: toNumOrNull(lead.totalDueToday),
          supportContact,
        },
        { pdfBytes: pdf!, pdfFilename: filename },
      );
      const status = result.sent ? 'SENT' : result.reason === 'send-failed' ? 'FAILED' : 'SKIPPED';
      await prisma.quotation
        .update({
          where: { quoteNo: row!.quoteNo },
          data: { emailStatus: status, emailReason: result.sent ? null : (result.reason ?? 'send-failed') },
        })
        .catch(() => undefined);
      return toQuotationMeta({ ...row!, emailStatus: status, emailReason: result.sent ? null : (result.reason ?? 'send-failed') });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[quotation] email failed quoteNo=${row!.quoteNo}: ${message}`);
      await prisma.quotation
        .update({ where: { quoteNo: row!.quoteNo }, data: { emailStatus: 'FAILED', emailReason: 'send-failed' } })
        .catch(() => undefined);
      return toQuotationMeta({ ...row!, emailStatus: 'FAILED', emailReason: 'send-failed' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[quotation] finalize failed leadId=${leadId}: ${message}`);
    return null;
  }
}

/**
 * Exact saved PDF bytes (+ filename) for the CMS download endpoint. Resolves
 * the LATEST quotation for the lead (re-quotes supersede). 404 when the lead
 * has no issued quotation yet.
 */
export async function getQuotationPdf(leadId: string): Promise<{ bytes: Buffer; filename: string; quoteNo: string }> {
  const row = await prisma.quotation.findFirst({
    where: { leadId },
    orderBy: { createdAt: 'desc' },
    select: { pdf: true, pdfFilename: true, quoteNo: true },
  });
  if (!row) throw new AppError(404, 'NOT_FOUND', `No issued quotation for lead ${leadId}`);
  return {
    bytes: Buffer.from(row.pdf),
    filename: row.pdfFilename?.trim() ? row.pdfFilename : quotationFilename(row.quoteNo),
    quoteNo: row.quoteNo,
  };
}

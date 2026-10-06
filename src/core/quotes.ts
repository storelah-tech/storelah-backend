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

const QUOTE_STAGE = 'PROPOSAL_SENT' as const;
const MAX_OPTIONS = 25;

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
  };
}

// Operator quotes queue: every PROPOSAL_SENT lead + live availability match.
export async function listQuotes() {
  const leads = await prisma.lead.findMany({
    where: { stage: QUOTE_STAGE },
    include: { branch: { select: { code: true, name: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  const rows = await Promise.all(
    leads.map(async (l) => serializeQuote(l, await matchingAvailableCount(l.preferredBranchId, l.preferredSize))),
  );
  const quotedValue = rows.reduce((s, q) => s + (q.monthlyRate ?? 0), 0);
  return { rows, meta: { count: rows.length, quotedValue: Math.round(quotedValue) } };
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
  const [matchingAvailable, options] = await Promise.all([
    matchingAvailableCount(lead.preferredBranchId, lead.preferredSize),
    inventoryOptions({ branchId, size }),
  ]);
  return { quote: serializeQuote(lead, matchingAvailable), options };
}

export interface CreateQuotationInput {
  // Transition path: quote an existing lead by id (any supplied fields below
  // are applied as overrides on the same write).
  leadId?: string;
  // Create path: required when leadId is omitted (a new PROPOSAL_SENT lead).
  name?: string;
  type?: 'PERSONAL' | 'BUSINESS';
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
// GET /quotes/:id):
//   - { leadId } transitions an existing lead to PROPOSAL_SENT (409 when the
//     lead is already quoted or in a terminal WON/LOST stage);
//   - otherwise a new PROPOSAL_SENT lead is created (409 on an open duplicate).
export async function createQuotation(input: CreateQuotationInput) {
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
    return getQuote(lead.id);
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
  // createdLead is the serializeLead shape; re-read through getQuote so the
  // create response carries the same { quote, options } payload as GET /quotes/:id.
  return getQuote(createdLead.id);
}

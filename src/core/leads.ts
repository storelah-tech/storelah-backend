import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { AccountType, LeadSource, LeadStage, Prisma } from '@prisma/client';

const COLUMNS: LeadStage[] = ['NEW_ENQUIRY', 'CONTACTED', 'VIEWING_BOOKED', 'PROPOSAL_SENT', 'WON', 'LOST'];

const STAGE_LABEL: Record<string, string> = {
  NEW_ENQUIRY: 'New',
  CONTACTED: 'Contacted',
  VIEWING_BOOKED: 'Qualified',
  PROPOSAL_SENT: 'Quoted',
  WON: 'Booked',
  LOST: 'Lost',
};

// Loss reasons offered by the pipeline drop-to-LOST picker (admin.js) and the
// lead modal. "Unspecified" is the default so existing PATCH flows that only
// send { stage: 'LOST' } keep working — updateLead fills it in.
export const LOSS_REASONS = [
  'Price',
  'Location',
  'Timing',
  'Competitor',
  'No response',
  'Unspecified',
] as const;

export interface LeadBookingIntent {
  unitCode?: string | null;
  moveInDate?: Date | null;
  durationMonths?: number | null;
  companyName?: string | null;
  uen?: string | null;
  consentPdpa?: boolean | null;
  consentMarketing?: boolean | null;
  protectionTier?: string | null;
  protectionCost?: number | null;
  addons?: LeadAddon[] | null;
  promoCode?: string | null;
  promoDiscountAmt?: number | null;
  movingService?: boolean | null;
  totalDueToday?: number | null;
}

export interface LeadAddon {
  id?: string;
  name: string;
  qty: number;
  price: number;
}

export interface CreateLeadInput {
  name: string;
  type?: AccountType;
  segment?: string | null;
  stage?: LeadStage;
  source?: LeadSource;
  preferredSize?: string | null;
  preferredBranchId?: string | null;
  monthlyRate?: number | null;
  note?: string | null;
  email?: string | null;
  mobile?: string | null;
  owner?: string | null;
  nextActionAt?: Date | null;
  lossReason?: string | null;
  lossValue?: number | null;
  unitCode?: string | null;
  moveInDate?: Date | null;
  durationMonths?: number | null;
  companyName?: string | null;
  uen?: string | null;
  consentPdpa?: boolean | null;
  consentMarketing?: boolean | null;
  protectionTier?: string | null;
  protectionCost?: number | null;
  addons?: LeadAddon[] | null;
  promoCode?: string | null;
  promoDiscountAmt?: number | null;
  movingService?: boolean | null;
  totalDueToday?: number | null;
}

export interface UpdateLeadInput {
  name?: string;
  type?: AccountType;
  segment?: string | null;
  stage?: LeadStage;
  source?: LeadSource;
  preferredSize?: string | null;
  preferredBranchId?: string | null;
  monthlyRate?: number | null;
  note?: string | null;
  email?: string | null;
  mobile?: string | null;
  owner?: string | null;
  nextActionAt?: Date | null;
  lossReason?: string | null;
  lossValue?: number | null;
  unitCode?: string | null;
  moveInDate?: Date | null;
  durationMonths?: number | null;
  companyName?: string | null;
  uen?: string | null;
  consentPdpa?: boolean | null;
  consentMarketing?: boolean | null;
  protectionTier?: string | null;
  protectionCost?: number | null;
  addons?: LeadAddon[] | null;
  promoCode?: string | null;
  promoDiscountAmt?: number | null;
  movingService?: boolean | null;
  totalDueToday?: number | null;
}

type LeadWithBranch = Prisma.LeadGetPayload<{ include: { branch: true } }>;

// ---------------------------------------------------------------------------
// Legacy note parser (v1 backfill reader). Pre-v2 public leads packed overflow
// fields into `note` as stable `key: value` lines with an optional free-text
// message head on the first line(s). New rows write first-class columns
// directly, so this parser is a READ fallback only: serializeLead prefers the
// real column and fills the gap from the note when the column is NULL, which
// keeps old rows working without a data migration.
// ---------------------------------------------------------------------------

function parseLegacyBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function parseLegacyNum(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

function parseLegacyInt(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isInteger(n) ? n : null;
}

function parseLegacyAddons(raw: string): LeadAddon[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    const rows = parsed
      .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
      .map((a) => ({
        ...(typeof a.id === 'string' ? { id: a.id } : {}),
        name: String(a.name ?? ''),
        qty: Number(a.qty ?? 0),
        price: Number(a.price ?? 0),
      }))
      .filter((a) => a.name && Number.isInteger(a.qty) && a.qty > 0 && Number.isFinite(a.price) && a.price >= 0)
      .slice(0, 20);
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

/** Extract legacy `key: value` lines from a v1-packed note (null-safe). */
export function parseLegacyLeadNote(note: string | null | undefined): LeadBookingIntent & { idempotencyKey?: string | null } {
  const out: LeadBookingIntent & { idempotencyKey?: string | null } = {};
  if (!note) return out;
  for (const line of note.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (!raw) continue;
    switch (key) {
      case 'unitCode': out.unitCode = raw.slice(0, 40); break;
      case 'moveInDate': {
        const d = new Date(raw);
        if (!Number.isNaN(d.getTime())) out.moveInDate = d;
        break;
      }
      case 'durationMonths': {
        const n = parseLegacyInt(raw);
        if (n != null && n > 0) out.durationMonths = n;
        break;
      }
      case 'companyName': out.companyName = raw.slice(0, 120); break;
      case 'uen': out.uen = raw.slice(0, 40); break;
      case 'consentPdpa': {
        const b = parseLegacyBool(raw);
        if (b != null) out.consentPdpa = b;
        break;
      }
      case 'consentMarketing': {
        const b = parseLegacyBool(raw);
        if (b != null) out.consentMarketing = b;
        break;
      }
      case 'protectionTier': out.protectionTier = raw.slice(0, 80); break;
      case 'protectionCost': {
        const n = parseLegacyNum(raw);
        if (n != null && n >= 0) out.protectionCost = n;
        break;
      }
      case 'addons': {
        const rows = parseLegacyAddons(raw);
        if (rows) out.addons = rows;
        break;
      }
      case 'promoCode': out.promoCode = raw.slice(0, 40); break;
      case 'promoDiscountAmt': {
        const n = parseLegacyNum(raw);
        if (n != null && n >= 0) out.promoDiscountAmt = n;
        break;
      }
      case 'movingService': {
        const b = parseLegacyBool(raw);
        if (b != null) out.movingService = b;
        break;
      }
      case 'totalDueToday': {
        const n = parseLegacyNum(raw);
        if (n != null && n >= 0) out.totalDueToday = n;
        break;
      }
      case 'idempotencyKey': out.idempotencyKey = raw.slice(0, 80); break;
      default: break;
    }
  }
  return out;
}

function legacyOr<T>(column: T | null | undefined, fallback: T | null | undefined): T | null {
  return column ?? fallback ?? null;
}

export function serializeLead(l: LeadWithBranch) {
  // Prefer first-class columns; fall back to legacy note-packed lines so
  // pre-v2 rows keep rendering without a data migration.
  const legacy = parseLegacyLeadNote(l.note);
  const addons = (l.addons as unknown) ?? legacy.addons ?? null;
  return {
    id: l.id,
    name: l.name,
    type: l.type,
    segment: l.segment ?? l.type.toLowerCase(),
    size: l.preferredSize,
    branchCode: l.branch?.code ?? '',
    branchName: l.branch?.name ?? '',
    note: l.note,
    stage: l.stage,
    source: l.source,
    monthlyRate: l.monthlyRate ? toNum(l.monthlyRate) : null,
    email: l.email,
    mobile: l.mobile,
    owner: l.owner,
    nextActionAt: l.nextActionAt,
    lossReason: l.lossReason ?? null,
    lossValue: l.lossValue ? toNum(l.lossValue) : null,
    unitCode: legacyOr(l.unitCode, legacy.unitCode),
    moveInDate: l.moveInDate ?? legacy.moveInDate ?? null,
    durationMonths: legacyOr(l.durationMonths, legacy.durationMonths),
    companyName: legacyOr(l.companyName, legacy.companyName),
    uen: legacyOr(l.uen, legacy.uen),
    consentPdpa: legacyOr(l.consentPdpa, legacy.consentPdpa),
    consentMarketing: legacyOr(l.consentMarketing, legacy.consentMarketing),
    protectionTier: legacyOr(l.protectionTier, legacy.protectionTier),
    protectionCost: l.protectionCost != null ? toNum(l.protectionCost) : (legacy.protectionCost ?? null),
    addons: Array.isArray(addons) ? (addons as LeadAddon[]) : null,
    promoCode: legacyOr(l.promoCode, legacy.promoCode),
    promoDiscountAmt: l.promoDiscountAmt != null ? toNum(l.promoDiscountAmt) : (legacy.promoDiscountAmt ?? null),
    movingService: legacyOr(l.movingService, legacy.movingService),
    totalDueToday: l.totalDueToday != null ? toNum(l.totalDueToday) : (legacy.totalDueToday ?? null),
    createdAt: l.createdAt,
    daysSince: Math.floor((Date.now() - l.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
  };
}

async function assertBranch(branchId: string | null | undefined) {
  if (!branchId) return;
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw new AppError(400, 'VALIDATION', 'Unknown preferredBranchId');
}

function assertLossReason(reason: string | null | undefined) {
  if (reason === undefined || reason === null) return;
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 80) {
    throw new AppError(400, 'VALIDATION', 'lossReason must be 1-80 characters');
  }
}

// Nullable-Json writes must use Prisma.DbNull for SQL NULL (plain `null`
// means JSON null and is rejected by the Json filter type).
function toJsonColumn(value: LeadAddon[] | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return value as unknown as Prisma.InputJsonValue;
}

function assertIntent(input: CreateLeadInput | UpdateLeadInput) {
  if (input.durationMonths !== undefined && input.durationMonths !== null && (!Number.isInteger(input.durationMonths) || input.durationMonths <= 0)) {
    throw new AppError(400, 'VALIDATION', 'durationMonths must be a positive integer');
  }
  for (const [key, value] of [['protectionCost', input.protectionCost], ['promoDiscountAmt', input.promoDiscountAmt], ['totalDueToday', input.totalDueToday]] as const) {
    if (value !== undefined && value !== null && !(value >= 0)) {
      throw new AppError(400, 'VALIDATION', `${key} must be 0 or greater`);
    }
  }
  if (input.addons !== undefined && input.addons !== null) {
    if (!Array.isArray(input.addons) || input.addons.length > 20) {
      throw new AppError(400, 'VALIDATION', 'addons must be an array of at most 20 items');
    }
    for (const a of input.addons) {
      if (!a || typeof a.name !== 'string' || !a.name.trim() || !Number.isInteger(a.qty) || a.qty <= 0 || typeof a.price !== 'number' || !(a.price >= 0)) {
        throw new AppError(400, 'VALIDATION', 'each addon needs name, qty (int > 0) and price (>= 0)');
      }
    }
  }
}

export async function createLead(input: CreateLeadInput) {
  await assertBranch(input.preferredBranchId ?? null);
  assertLossReason(input.lossReason ?? undefined);
  assertIntent(input);
  const lead = await prisma.lead.create({
    data: {
      name: input.name,
      type: input.type ?? 'PERSONAL',
      segment: input.segment ?? null,
      stage: input.stage ?? 'NEW_ENQUIRY',
      source: input.source ?? 'WEBSITE',
      preferredSize: input.preferredSize ?? null,
      preferredBranchId: input.preferredBranchId ?? null,
      monthlyRate: input.monthlyRate ?? null,
      note: input.note ?? null,
      email: input.email ?? null,
      mobile: input.mobile ?? null,
      owner: input.owner ?? null,
      nextActionAt: input.nextActionAt ?? null,
      // Creating directly into LOST still gets attributed (same default as updateLead).
      lossReason: input.stage === 'LOST' ? (input.lossReason?.trim() || 'Unspecified') : (input.lossReason?.trim() || null),
      lossValue: input.lossValue ?? (input.stage === 'LOST' ? (input.monthlyRate ?? null) : null),
      unitCode: input.unitCode ?? null,
      moveInDate: input.moveInDate ?? null,
      durationMonths: input.durationMonths ?? null,
      companyName: input.companyName ?? null,
      uen: input.uen ?? null,
      consentPdpa: input.consentPdpa ?? null,
      consentMarketing: input.consentMarketing ?? null,
      protectionTier: input.protectionTier ?? null,
      protectionCost: input.protectionCost ?? null,
      // addons snapshot as JSON (validated upstream by zod; legacy rows may
      // carry a JSON string inside a note-packed line — parsed on read only).
      addons: toJsonColumn(input.addons),
      promoCode: input.promoCode ?? null,
      promoDiscountAmt: input.promoDiscountAmt ?? null,
      movingService: input.movingService ?? null,
      totalDueToday: input.totalDueToday ?? null,
    },
    include: { branch: true },
  });
  return serializeLead(lead);
}

// ---------------------------------------------------------------------------
// Public lead capture (POST /api/v1/public/leads, booking "Your details").
// v2 field-sync: every booking-steps datum is written to a first-class Lead
// column on create (see the v2 columns on the Lead model). `note` carries
// only the free-text message head for new rows. packPublicLeadNote survives
// below as the LEGACY writer reference for the parseLegacyLeadNote reader —
// it is no longer called on the create path.
// ---------------------------------------------------------------------------

export interface PublicLeadInput {
  name: string;
  email?: string | null;
  mobile?: string | null;
  // personal|business → AccountType; BUSINESS wins when company/uen present.
  purpose?: 'personal' | 'business' | null;
  companyName?: string | null;
  uen?: string | null;
  // Either a Branch.code (BM/WD/UB, case-insensitive) or a raw branch cuid.
  branchCode?: string | null;
  preferredBranchId?: string | null;
  preferredSize?: string | null;
  // Loose reference only — validated best-effort, never an FK, never a 400.
  unitCode?: string | null;
  moveInDate?: string | null;
  durationMonths?: number | null;
  monthlyRate?: number | null;
  message?: string | null;
  source?: LeadSource;
  consentPdpa?: boolean | null;
  consentMarketing?: boolean | null;
  protectionTier?: string | null;
  protectionCost?: number | null;
  addons?: LeadAddon[] | null;
  promoCode?: string | null;
  promoDiscountAmt?: number | null;
  movingService?: boolean | null;
  totalDueToday?: number | null;
  idempotencyKey?: string | null;
}

export interface PublicLeadResult {
  lead: ReturnType<typeof serializeLead> & { preferredBranchId: string | null };
  /** true when an existing row was returned instead of creating a duplicate. */
  deduped: boolean;
}

// Overflow fields packed into `note` (no dedicated column in v1). Stable
// `key: value` prefixes, one per line — only present fields are emitted.
//
// LEGACY WRITER (pre-v2 only): new rows write first-class columns directly
// and keep `note` for the message head, so this is no longer called on the
// create path. Kept (exported) beside parseLegacyLeadNote as the format
// reference for the reader — do not extend it with new fields.
export function packPublicLeadNote(input: PublicLeadInput): string | null {
  const lines: string[] = [];
  if (input.unitCode) lines.push(`unitCode: ${input.unitCode}`);
  if (input.moveInDate) lines.push(`moveInDate: ${input.moveInDate}`);
  if (input.durationMonths != null) lines.push(`durationMonths: ${input.durationMonths}`);
  if (input.companyName) lines.push(`companyName: ${input.companyName}`);
  if (input.uen) lines.push(`uen: ${input.uen}`);
  if (input.consentPdpa != null) lines.push(`consentPdpa: ${input.consentPdpa}`);
  if (input.consentMarketing != null) lines.push(`consentMarketing: ${input.consentMarketing}`);
  if (input.idempotencyKey) lines.push(`idempotencyKey: ${input.idempotencyKey}`);
  const head = input.message?.trim() ? input.message.trim() : null;
  if (!head && lines.length === 0) return null;
  return [head, ...lines].filter(Boolean).join('\n');
}

async function resolvePublicBranchId(input: PublicLeadInput): Promise<string | null> {
  if (input.branchCode?.trim()) {
    const code = input.branchCode.trim().toUpperCase();
    const branch = await prisma.branch.findUnique({ where: { code } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Unknown branchCode: ${input.branchCode.trim()}`);
    return branch.id;
  }
  if (input.preferredBranchId?.trim()) {
    await assertBranch(input.preferredBranchId.trim());
    return input.preferredBranchId.trim();
  }
  return null;
}

const PUBLIC_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function createPublicLead(input: PublicLeadInput): Promise<PublicLeadResult> {
  const email = input.email?.trim() ? input.email.trim() : null;
  const mobile = input.mobile?.trim() ? input.mobile.trim() : null;
  if (!email && !mobile) {
    throw new AppError(400, 'VALIDATION', 'At least one of email or mobile is required');
  }

  const preferredBranchId = await resolvePublicBranchId(input);

  // Dedupe 1: idempotencyKey — a recent Lead with the same key is the same
  // submission (double-click / retry safe). v2 rows carry the key in the
  // `idempotencyKey` column; pre-v2 rows carry the packed
  // `idempotencyKey: <key>` note line — match either. Full-line fragment on
  // the note side avoids prefix collisions on short keys.
  if (input.idempotencyKey?.trim()) {
    const key = input.idempotencyKey.trim();
    const existing = await prisma.lead.findFirst({
      where: {
        OR: [{ idempotencyKey: key }, { note: { contains: `idempotencyKey: ${key}` } }],
        createdAt: { gte: new Date(Date.now() - IDEMPOTENCY_WINDOW_MS) },
      },
      include: { branch: true },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return { lead: { ...serializeLead(existing), preferredBranchId: existing.preferredBranchId ?? null }, deduped: true };
    }
  }

  // Dedupe 2: same contact + same branch within 10 minutes.
  const recent = await prisma.lead.findFirst({
    where: {
      email: { equals: email },
      mobile: { equals: mobile },
      preferredBranchId: { equals: preferredBranchId },
      createdAt: { gte: new Date(Date.now() - PUBLIC_DUPLICATE_WINDOW_MS) },
    },
    include: { branch: true },
    orderBy: { createdAt: 'desc' },
  });
  if (recent) {
    return { lead: { ...serializeLead(recent), preferredBranchId: recent.preferredBranchId ?? null }, deduped: true };
  }

  // Loose unitCode check (best-effort existence, never a 400, never an FK):
  // the code is stored on the column either way so nothing blocks capture.
  const unitCode = input.unitCode?.trim() ? input.unitCode.trim() : null;
  if (unitCode) {
    await prisma.unit.findFirst({
      where: { unitCode, deletedAt: null },
      select: { id: true },
    });
  }

  const type: AccountType =
    input.purpose === 'business' || input.companyName?.trim() || input.uen?.trim() ? 'BUSINESS' : 'PERSONAL';

  // v2: every booking-steps datum lands in a first-class column. `note`
  // carries only the free-text message head (legacy rows keep their packed
  // lines, which serializeLead parses back on read).
  const moveInDate = input.moveInDate?.trim() ? new Date(input.moveInDate.trim()) : null;
  const lead = await prisma.lead.create({
    data: {
      name: input.name.trim(),
      type,
      stage: 'NEW_ENQUIRY',
      source: input.source ?? 'WEBSITE',
      preferredSize: input.preferredSize?.trim() ? input.preferredSize.trim() : null,
      preferredBranchId,
      monthlyRate: input.monthlyRate ?? null,
      note: input.message?.trim() ? input.message.trim() : null,
      email,
      mobile,
      unitCode,
      moveInDate: moveInDate && !Number.isNaN(moveInDate.getTime()) ? moveInDate : null,
      durationMonths: input.durationMonths ?? null,
      companyName: input.companyName?.trim() ? input.companyName.trim() : null,
      uen: input.uen?.trim() ? input.uen.trim() : null,
      consentPdpa: input.consentPdpa ?? null,
      consentMarketing: input.consentMarketing ?? null,
      protectionTier: input.protectionTier?.trim() ? input.protectionTier.trim() : null,
      protectionCost: input.protectionCost ?? null,
      addons: toJsonColumn(input.addons),
      promoCode: input.promoCode?.trim() ? input.promoCode.trim() : null,
      promoDiscountAmt: input.promoDiscountAmt ?? null,
      movingService: input.movingService ?? null,
      totalDueToday: input.totalDueToday ?? null,
      idempotencyKey: input.idempotencyKey?.trim() ? input.idempotencyKey.trim() : null,
    },
    include: { branch: true },
  });
  return { lead: { ...serializeLead(lead), preferredBranchId: lead.preferredBranchId ?? null }, deduped: false };
}

export async function getLeadById(id: string) {
  const lead = await prisma.lead.findUnique({ where: { id }, include: { branch: true } });
  if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
  return { ...serializeLead(lead), preferredBranchId: lead.preferredBranchId ?? null };
}

export async function updateLead(id: string, input: UpdateLeadInput) {
  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
  await assertBranch(input.preferredBranchId);
  assertLossReason(input.lossReason ?? undefined);
  assertIntent(input);
  if (input.lossValue !== undefined && input.lossValue !== null && input.lossValue < 0) {
    throw new AppError(400, 'VALIDATION', 'lossValue must be 0 or greater');
  }

  // Moving into LOST stamps attribution so old clients that only send
  // { stage: 'LOST' } still produce a countable row: reason defaults to
  // "Unspecified", value falls back to the lead's monthlyRate (revenue proxy).
  // Explicit values are never overwritten; rows leaving LOST keep history.
  const movingToLost = input.stage === 'LOST' && existing.stage !== 'LOST';
  const lossPatch: { lossReason?: string | null; lossValue?: number | null } = {};
  if (movingToLost) {
    lossPatch.lossReason = input.lossReason?.trim() || existing.lossReason || 'Unspecified';
    const fallback =
      input.lossValue ??
      (existing.lossValue != null ? toNum(existing.lossValue) : null) ??
      (existing.monthlyRate != null ? toNum(existing.monthlyRate) : null) ??
      input.monthlyRate ??
      null;
    lossPatch.lossValue = fallback;
  } else {
    if (input.lossReason !== undefined) lossPatch.lossReason = input.lossReason?.trim() || null;
    if (input.lossValue !== undefined) lossPatch.lossValue = input.lossValue;
  }

  const lead = await prisma.lead.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.segment !== undefined ? { segment: input.segment } : {}),
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.preferredSize !== undefined ? { preferredSize: input.preferredSize } : {}),
      ...(input.preferredBranchId !== undefined ? { preferredBranchId: input.preferredBranchId } : {}),
      ...(input.monthlyRate !== undefined ? { monthlyRate: input.monthlyRate } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.nextActionAt !== undefined ? { nextActionAt: input.nextActionAt } : {}),
      ...(lossPatch.lossReason !== undefined ? { lossReason: lossPatch.lossReason } : {}),
      ...(lossPatch.lossValue !== undefined ? { lossValue: lossPatch.lossValue } : {}),
      ...(input.unitCode !== undefined ? { unitCode: input.unitCode } : {}),
      ...(input.moveInDate !== undefined ? { moveInDate: input.moveInDate } : {}),
      ...(input.durationMonths !== undefined ? { durationMonths: input.durationMonths } : {}),
      ...(input.companyName !== undefined ? { companyName: input.companyName } : {}),
      ...(input.uen !== undefined ? { uen: input.uen } : {}),
      ...(input.consentPdpa !== undefined ? { consentPdpa: input.consentPdpa } : {}),
      ...(input.consentMarketing !== undefined ? { consentMarketing: input.consentMarketing } : {}),
      ...(input.protectionTier !== undefined ? { protectionTier: input.protectionTier } : {}),
      ...(input.protectionCost !== undefined ? { protectionCost: input.protectionCost } : {}),
      ...(input.addons !== undefined ? { addons: toJsonColumn(input.addons) } : {}),
      ...(input.promoCode !== undefined ? { promoCode: input.promoCode } : {}),
      ...(input.promoDiscountAmt !== undefined ? { promoDiscountAmt: input.promoDiscountAmt } : {}),
      ...(input.movingService !== undefined ? { movingService: input.movingService } : {}),
      ...(input.totalDueToday !== undefined ? { totalDueToday: input.totalDueToday } : {}),
    },
    include: { branch: true },
  });
  return serializeLead(lead);
}

export async function deleteLead(id: string) {
  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
  // Appointments only lose the lead link (they survive); conversations
  // cascade via the FK. Unlink first — Appointment.leadId has no ON DELETE
  // action, so deleting the lead while rows still point at it would fail.
  await prisma.$transaction([
    prisma.appointment.updateMany({ where: { leadId: id }, data: { leadId: null } }),
    prisma.lead.delete({ where: { id } }),
  ]);
  return { id };
}

export async function listLeads(opts?: { from?: Date; to?: Date }) {
  const createdAt: { gte?: Date; lte?: Date } = {};
  if (opts?.from) createdAt.gte = opts.from;
  if (opts?.to) createdAt.lte = opts.to;
  const leads = await prisma.lead.findMany({
    where: createdAt.gte || createdAt.lte ? { createdAt } : undefined,
    include: { branch: true },
    orderBy: { createdAt: 'desc' },
  });

  return COLUMNS.map((stage) => ({
    stage,
    count: leads.filter((l) => l.stage === stage).length,
    leads: leads
      .filter((l) => l.stage === stage)
      .map((l) => serializeLead(l)),
  }));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function getLeadStats() {
  const leads = await prisma.lead.findMany({
    include: { branch: true },
    orderBy: { createdAt: 'desc' },
  });

  const total = leads.length;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const newToday = leads.filter((l) => l.createdAt >= todayStart).length;
  const awaitingFirstContact = leads.filter((l) => l.stage === 'NEW_ENQUIRY').length;

  const funnel = COLUMNS.map((stage) => {
    const filtered = leads.filter((l) => l.stage === stage);
    return {
      stage,
      label: STAGE_LABEL[stage] ?? stage,
      count: filtered.length,
    };
  });

  // Headline counts for the analytics stat tiles.
  const byStage = (s: LeadStage) => leads.filter((l) => l.stage === s).length;
  const enquiries = total;
  const qualified = byStage('VIEWING_BOOKED') + byStage('PROPOSAL_SENT') + byStage('WON');
  const bookings = byStage('WON');

  const sourceBreakdown = leads.reduce<Record<string, number>>((acc, l) => {
    const key = l.source.toLowerCase();
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const branchBreakdown = leads.reduce<Record<string, number>>((acc, l) => {
    const key = l.branch?.code ?? 'none';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  // --- Conversion by facility: leads -> WON per branch + overall. ---
  const byBranch = new Map<string, { branchId: string | null; code: string; name: string; leads: number; won: number }>();
  for (const l of leads) {
    const key = l.branch?.code ?? 'none';
    const row =
      byBranch.get(key) ??
      { branchId: l.preferredBranchId ?? null, code: key, name: l.branch?.name ?? 'No facility', leads: 0, won: 0 };
    row.leads += 1;
    if (l.stage === 'WON') row.won += 1;
    if (!row.branchId && l.preferredBranchId) row.branchId = l.preferredBranchId;
    byBranch.set(key, row);
  }
  const conversionByFacility = [...byBranch.values()].map((r) => ({
    ...r,
    conversionPct: r.leads ? Math.round((r.won / r.leads) * 1000) / 10 : 0,
  }));
  const overallConversionPct = total ? Math.round((bookings / total) * 1000) / 10 : 0;

  // --- First-response proxy (no migration): earliest OUTBOUND message per
  // lead minus lead.createdAt. Leads with no outbound message yet are excluded
  // (sample size reported so the UI can show an honest empty state). Notes are
  // internal-only and excluded — only direction=OUT counts as first contact.
  const outbounds = await prisma.message.findMany({
    where: { direction: 'OUT' },
    select: { sentAt: true, conversation: { select: { leadId: true } } },
    orderBy: { sentAt: 'asc' },
  });
  const firstOutByLead = new Map<string, Date>();
  for (const m of outbounds) {
    if (!firstOutByLead.has(m.conversation.leadId)) firstOutByLead.set(m.conversation.leadId, m.sentAt);
  }
  const responseMinutes: number[] = [];
  for (const l of leads) {
    const first = firstOutByLead.get(l.id);
    if (first && first.getTime() >= l.createdAt.getTime()) {
      responseMinutes.push((first.getTime() - l.createdAt.getTime()) / 60000);
    }
  }
  const medMin = median(responseMinutes);
  const medianFirstResponseMin = medMin == null ? null : Math.round(medMin * 10) / 10;

  // --- Lost revenue: sum of lossValue, falling back to monthlyRate where a
  // lost row has no explicit lossValue (pre-migration rows). avgValue is the
  // mean monthlyRate across ALL leads (the tile's "count x avg" fallback).
  const lostRows = leads.filter((l) => l.stage === 'LOST');
  const lostValue = lostRows.reduce(
    (sum, l) => sum + toNum(l.lossValue ?? l.monthlyRate ?? 0),
    0,
  );
  const ratesAll = leads.map((l) => toNum(l.monthlyRate ?? 0)).filter((n) => n > 0);
  const avgValue = ratesAll.length ? Math.round((ratesAll.reduce((a, b) => a + b, 0) / ratesAll.length) * 100) / 100 : 0;
  const lossReasonBreakdown = lostRows.reduce<Record<string, number>>((acc, l) => {
    const key = l.lossReason?.trim() || 'Unspecified';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  // --- Advisor scorecard grouped by lead.owner (no staff model by design).
  // QUALITY SCORE (documented heuristic, not a black box):
  //   quality = round( 50 * contactRate + 50 * conversionRate )
  // where contactRate = share of assigned leads past NEW_ENQUIRY (0..1) and
  // conversionRate = share of assigned leads WON (0..1). Equal weights: half
  // responsiveness, half closing. Revenue is a proxy (sum of WON monthlyRate).
  const byOwner = new Map<string, typeof leads>();
  for (const l of leads) {
    const key = l.owner?.trim() || 'Unassigned';
    byOwner.set(key, [...(byOwner.get(key) ?? []), l]);
  }
  const scorecard = [...byOwner.entries()]
    .map(([owner, rows]) => {
      const assigned = rows.length;
      const contacted = rows.filter((r) => r.stage !== 'NEW_ENQUIRY').length;
      const won = rows.filter((r) => r.stage === 'WON').length;
      const contactRate = assigned ? contacted / assigned : 0;
      const conversion = assigned ? won / assigned : 0;
      const revenue = rows
        .filter((r) => r.stage === 'WON')
        .reduce((sum, r) => sum + toNum(r.monthlyRate ?? 0), 0);
      const quality = Math.round(50 * contactRate + 50 * conversion);
      return {
        owner,
        assigned,
        contactRate: Math.round(contactRate * 1000) / 10,
        conversion: Math.round(conversion * 1000) / 10,
        revenue,
        quality,
      };
    })
    .sort((a, b) => b.assigned - a.assigned);

  return {
    total,
    newToday,
    awaitingFirstContact,
    funnel,
    sourceBreakdown,
    branchBreakdown,
    enquiries,
    qualified,
    bookings,
    overallConversionPct,
    conversionByFacility,
    medianFirstResponseMin,
    firstResponseSample: responseMinutes.length,
    lostCount: lostRows.length,
    lostValue,
    avgValue,
    lossReasonBreakdown,
    scorecard,
    lossReasons: [...LOSS_REASONS],
  };
}

// Weekly enquiry/booking series for the analytics chart. Buckets count
// createdAt per ISO week (Monday-start, UTC); value columns sum monthlyRate.
// Weeks with no data return zeros so the chart renders honest empty states.
export async function getWeeklyAnalytics(weeks = 8) {
  const n = Math.min(Math.max(Math.floor(weeks) || 8, 1), 26);
  const now = new Date();
  const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  thisMonday.setUTCDate(thisMonday.getUTCDate() - ((thisMonday.getUTCDay() + 6) % 7));
  thisMonday.setUTCHours(0, 0, 0, 0);

  const start = new Date(thisMonday);
  start.setUTCDate(start.getUTCDate() - (n - 1) * 7);

  const leads = await prisma.lead.findMany({
    where: { createdAt: { gte: start } },
    select: { createdAt: true, stage: true, monthlyRate: true, updatedAt: true },
  });

  // WON attribution uses updatedAt (close time) so a booking lands in the week
  // it closed; enquiries always use createdAt.
  const wonAll = await prisma.lead.findMany({
    where: { stage: 'WON', updatedAt: { gte: start } },
    select: { updatedAt: true, monthlyRate: true },
  });

  const buckets = Array.from({ length: n }, (_, i) => {
    const s = new Date(start);
    s.setUTCDate(s.getUTCDate() + i * 7);
    const e = new Date(s);
    e.setUTCDate(e.getUTCDate() + 7);
    return {
      weekStart: s.toISOString().slice(0, 10),
      label: s.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      enquiries: 0,
      bookings: 0,
      enquiryValue: 0,
      bookingValue: 0,
      _s: s.getTime(),
      _e: e.getTime(),
    };
  });

  for (const l of leads) {
    const t = l.createdAt.getTime();
    const b = buckets.find((x) => t >= x._s && t < x._e);
    if (!b) continue;
    b.enquiries += 1;
    b.enquiryValue += toNum(l.monthlyRate ?? 0);
  }
  for (const w of wonAll) {
    const t = w.updatedAt.getTime();
    const b = buckets.find((x) => t >= x._s && t < x._e);
    if (!b) continue;
    b.bookings += 1;
    b.bookingValue += toNum(w.monthlyRate ?? 0);
  }

  return {
    weeks: buckets.map(({ _s, _e, ...rest }) => rest),
    meta: { count: n, from: start.toISOString().slice(0, 10) },
  };
}

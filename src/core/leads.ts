import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { AccountType, LeadSource, LeadStage, Prisma } from '@prisma/client';
import { normalizeEmail } from './customers';

const COLUMNS: LeadStage[] = ['NEW_ENQUIRY', 'CONTACTED', 'VIEWING_BOOKED', 'PROPOSAL_SENT', 'PENDING_PAYMENT', 'WON', 'LOST'];

const STAGE_LABEL: Record<string, string> = {
  NEW_ENQUIRY: 'New',
  CONTACTED: 'Contacted',
  VIEWING_BOOKED: 'Qualified',
  PROPOSAL_SENT: 'Quoted',
  PENDING_PAYMENT: 'Pending Payment',
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

export interface LeadIdentity {
  emailNorm: string | null;
  mobileNorm: string | null;
  leadGroupKey: string | null;
}

// ---------------------------------------------------------------------------
// Lead identity (email-primary / phone-secondary) — the single shared helper
// for every lead write path (createLead, createPublicLead, quotes new-lead +
// transition, customer requests, CSV import via POST /leads, and the Stripe
// webhook attribution in markLeadWonForBooking).
//
//   emailNorm  = trim().toLowerCase() or null (via normalizeEmail in
//     core/customers.ts — the same canonicalizer as Customer.email).
//   mobileNorm = digits-only with the SG rule: 8 digits starting 3/6/8/9 get
//     a 65 prefix ("81234567" -> "6581234567"); 65+8 digits kept as-is;
//     fewer than 6 digits -> null (too weak to identify anyone).
//   leadGroupKey = emailNorm ?? ('phone:' + mobileNorm) ?? null, so
//     NULL-email phone-only rows form phone-only groups that never auto-merge
//     into email groups, and contact-less rows stay ungrouped (null).
//
// Global email identity: the branch leg is dropped — the same email across
// branches is one identity. Same email + different/empty phone auto-links
// (never blocks). Grouping never widens consent: per-row consentPdpa /
// consentMarketing are preserved untouched — rows link, never merge.
// ---------------------------------------------------------------------------

/** Canonical email for lead identity: trim + lowercase, empty -> null. */
export function normalizeLeadEmail(email: string | null | undefined): string | null {
  if (email == null) return null;
  const trimmed = email.trim();
  return trimmed ? normalizeEmail(trimmed) : null;
}

/** Canonical phone for lead identity: digits-only + SG rule, weak -> null. */
export function normalizeLeadMobile(mobile: string | null | undefined): string | null {
  if (mobile == null) return null;
  const digits = mobile.replace(/\D/g, '');
  if (!digits || digits.length < 6) return null;
  if (digits.length === 8 && /^[3689]/.test(digits)) return `65${digits}`;
  return digits;
}

export function normalizeLeadIdentity(
  email: string | null | undefined,
  mobile: string | null | undefined,
): LeadIdentity {
  const emailNorm = normalizeLeadEmail(email);
  const mobileNorm = normalizeLeadMobile(mobile);
  return {
    emailNorm,
    mobileNorm,
    leadGroupKey: emailNorm ?? (mobileNorm ? `phone:${mobileNorm}` : null),
  };
}

/** Prisma write fragment stamping the identity columns for a lead row. */
export function leadIdentityColumns(
  email: string | null | undefined,
  mobile: string | null | undefined,
): LeadIdentity {
  return normalizeLeadIdentity(email, mobile);
}

// Portal change requests (UPSIZE/DOWNSIZE/TRANSFER via POST
// /customer/requests — submitCustomerRequest in core/customers.ts) are
// service requests from an existing customer, not sales enquiries. They carry
// the customer's contact and the standard identity stamp, so they LINK into
// that email's group timeline (rows link, never merge), but they must never
// be auto-converted by a booking (markLeadWonForBooking) or counted as repeat
// enquiries (getLeadStats). There is no column for this (no migration), so the
// note prefix the request writer always emits is the marker — legacy
// contact-less request rows carry the same prefix.
export const CUSTOMER_REQUEST_NOTE_PREFIX = 'Request type: ';

export function isCustomerRequestLead(lead: { note: string | null }): boolean {
  return !!lead.note && lead.note.startsWith(CUSTOMER_REQUEST_NOTE_PREFIX);
}

// Group linkage stats for a freshly written row: `linked` when the group
// already held other rows, `groupCount` including this row, `phoneVariance`
// when any other group row carries a different normalized phone (auto-link,
// never block — same email + different/empty phone still links). Terminal
// WON/LOST rows count: they link read-only (timeline) and are never
// re-opened by a new enquiry — every capture below always creates a new row.
async function groupStats(
  groupKey: string,
  mobileNorm: string | null,
  excludeId?: string,
): Promise<{ linked: boolean; groupCount: number; phoneVariance: boolean }> {
  const others = await prisma.lead.findMany({
    where: { leadGroupKey: groupKey, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { mobileNorm: true },
  });
  return {
    linked: others.length > 0,
    groupCount: others.length + 1,
    phoneVariance: others.some((r) => (r.mobileNorm ?? null) !== mobileNorm),
  };
}

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
    // Identity linkage (additive): the group this row links into. Every
    // write stamps these columns; the ?? fallback covers any row predating
    // the identity backfill without a data migration.
    emailNorm: l.emailNorm ?? normalizeLeadEmail(l.email),
    mobileNorm: l.mobileNorm ?? normalizeLeadMobile(l.mobile),
    leadGroupKey: l.leadGroupKey ?? normalizeLeadIdentity(l.email, l.mobile).leadGroupKey,
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
  // Normalize contact on write (trim + lowercase email, trim mobile) so the
  // stored row and its identity columns agree.
  const email = input.email?.trim() ? normalizeLeadEmail(input.email)! : (input.email ?? null);
  const mobile = input.mobile?.trim() ? input.mobile.trim() : (input.mobile ?? null);
  const identity = normalizeLeadIdentity(email, mobile);
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
      email,
      mobile,
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
      ...leadIdentityColumns(email, mobile),
    },
    include: { branch: true },
  });
  // Operator creates never dedupe — the row is always new — but it still
  // links into its identity group (additive linked/groupCount/phoneVariance).
  const stats = identity.leadGroupKey
    ? await groupStats(identity.leadGroupKey, identity.mobileNorm, lead.id)
    : { linked: false, groupCount: 1, phoneVariance: false };
  return { ...serializeLead(lead), ...stats };
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
  // Either a Branch.code (SW/WD/UB, case-insensitive) or a raw branch cuid.
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
  /** true when the row linked into a group that already had rows (additive). */
  linked: boolean;
  /** rows in the group including this row (additive). */
  groupCount: number;
  /** true when group rows carry a different phone (additive, never blocks). */
  phoneVariance: boolean;
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

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Minimum normalized-phone length for phone-only identity lookup. Below
// this a digit string is too weak to identify anyone (mirrors the <6-digit
// null rule in normalizeLeadMobile, with one extra digit of margin).
const PHONE_LOOKUP_MIN_LENGTH = 7;

export async function createPublicLead(input: PublicLeadInput): Promise<PublicLeadResult> {
  // Normalize contact first (trim + lowercase email, trim mobile) so
  // validation and identity agree: Foo@X.com and foo@x.com are one identity.
  const email = normalizeLeadEmail(input.email);
  const mobile = input.mobile?.trim() ? input.mobile.trim() : null;
  if (!email && !mobile) {
    throw new AppError(400, 'VALIDATION', 'At least one of email or mobile is required');
  }
  const identity = normalizeLeadIdentity(email, mobile);

  const preferredBranchId = await resolvePublicBranchId(input);

  // Dedupe 1 (fast path, unchanged): idempotencyKey — a recent Lead with the
  // same key is the same submission (double-click / retry safe). v2 rows
  // carry the key in the `idempotencyKey` column; pre-v2 rows carry the
  // packed `idempotencyKey: <key>` note line — match either. Full-line
  // fragment on the note side avoids prefix collisions on short keys.
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
      const existingKey =
        existing.leadGroupKey ?? normalizeLeadIdentity(existing.email, existing.mobile).leadGroupKey;
      const stats = existingKey
        ? await groupStats(existingKey, existing.mobileNorm ?? normalizeLeadMobile(existing.mobile), existing.id)
        : { linked: false, groupCount: 1, phoneVariance: false };
      return {
        lead: { ...serializeLead(existing), preferredBranchId: existing.preferredBranchId ?? null },
        deduped: true,
        ...stats,
      };
    }
  }

  // Link-or-create (email-primary / phone-secondary, no branch leg): a new
  // row is ALWAYS created — even for a seen contact, even across branches,
  // even when an earlier row already went WON/LOST (terminal rows link
  // read-only and are never re-opened). The row carries its group key so the
  // timeline can render the whole identity together.
  //
  //   - email present  -> group by emailNorm (same email + different/empty
  //     phone auto-links; a different email is a different group even when
  //     the phone matches);
  //   - email absent   -> group by normalized phone only (phone-only groups
  //     never auto-merge into email groups — the lookup is scoped to rows
  //     with no emailNorm via the 'phone:' key prefix).
  const groupKey = identity.leadGroupKey;
  const linkable =
    identity.emailNorm != null ||
    (identity.mobileNorm != null && identity.mobileNorm.length >= PHONE_LOOKUP_MIN_LENGTH);
  const stats =
    groupKey && linkable
      ? await groupStats(groupKey, identity.mobileNorm)
      : { linked: false, groupCount: 1, phoneVariance: false };

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
  // lines, which serializeLead parses back on read). Consent is per-row:
  // grouping never widens consent, so the new row keeps exactly the consent
  // it arrived with — nothing is copied from (or to) group rows.
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
      ...leadIdentityColumns(email, mobile),
    },
    include: { branch: true },
  });
  // groupStats ran pre-create over the existing group rows; its groupCount
  // already includes the new row joining the group.
  return {
    lead: { ...serializeLead(lead), preferredBranchId: lead.preferredBranchId ?? null },
    deduped: false,
    linked: stats.linked,
    groupCount: stats.groupCount,
    phoneVariance: stats.phoneVariance,
  };
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

  // Contact writes are normalized (trim + lowercase email, trim mobile)
  // and re-stamp the identity columns so an edited email/mobile moves the
  // row into the right group instead of stranding stale norms.
  const nextEmail =
    input.email !== undefined
      ? (input.email?.trim() ? normalizeLeadEmail(input.email)! : input.email)
      : undefined;
  const nextMobile =
    input.mobile !== undefined
      ? (input.mobile?.trim() ? input.mobile.trim() : input.mobile)
      : undefined;
  const nextIdentity =
    nextEmail !== undefined || nextMobile !== undefined
      ? leadIdentityColumns(
          nextEmail !== undefined ? nextEmail : existing.email,
          nextMobile !== undefined ? nextMobile : existing.mobile,
        )
      : null;

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
      ...(nextEmail !== undefined ? { email: nextEmail } : {}),
      ...(nextMobile !== undefined ? { mobile: nextMobile } : {}),
      ...(nextIdentity ? { ...nextIdentity } : {}),
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

  // Same-email merge view (additive, read-only): every serialized lead carries
  // `sameEmailEnquiries` — the other enquiries sharing its lowercased email —
  // so the inbox/database can render multiple enquiries under one row. No
  // rows are merged or deleted; the column arrays below are unchanged.
  const serialized = leads.map((l) => serializeLead(l));
  const byEmail = new Map<string, typeof serialized>();
  for (const row of serialized) {
    const email = String((row as { email?: string | null }).email ?? '').trim().toLowerCase();
    if (!email) continue;
    const group = byEmail.get(email);
    if (group) group.push(row);
    else byEmail.set(email, [row]);
  }
  const withMerge = serialized.map((row) => {
    const email = String((row as { email?: string | null }).email ?? '').trim().toLowerCase();
    const group = (email && byEmail.get(email)) || [];
    const others = group
      .filter((g) => g.id !== row.id)
      .map((g) => ({ id: g.id, name: g.name, stage: g.stage, createdAt: g.createdAt }));
    return { ...row, sameEmailEnquiries: others };
  });
  const byId = new Map(withMerge.map((r) => [r.id, r]));

  return COLUMNS.map((stage) => ({
    stage,
    count: leads.filter((l) => l.stage === stage).length,
    leads: leads
      .filter((l) => l.stage === stage)
      .map((l) => byId.get(l.id) ?? serializeLead(l)),
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

  // --- Email identity rollup (Phase 3, additive — see the return-note for
  // definitions). Norms are stamped on every write and backfilled, so the
  // stored column is authoritative; the ?? fallback covers any row predating
  // the backfill without a data migration.
  const emailNormOf = (l: (typeof leads)[number]) => l.emailNorm ?? normalizeLeadEmail(l.email);
  // Portal change requests are not enquiries: kept out of the repeat rollup.
  const emailRows = leads.filter((l) => emailNormOf(l) != null && !isCustomerRequestLead(l));
  const uniqueEmails = new Set(emailRows.map((l) => emailNormOf(l) as string)).size;
  const avgEnquiriesPerEmail =
    emailRows.length && uniqueEmails ? Math.round((emailRows.length / uniqueEmails) * 100) / 100 : 0;
  const repeatEnquiryRate = emailRows.length
    ? Math.round(((emailRows.length - uniqueEmails) / emailRows.length) * 1000) / 10
    : 0;

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
    // --- Per-email identity rollup (Phase 3, additive): distinct normalized
    // emails plus repeat behaviour. uniqueEmails counts distinct emailNorm
    // identities (phone-only and contact-less rows excluded — they have no
    // email identity). avgEnquiriesPerEmail = email-identified rows ÷ unique
    // emails (2dp, 0 when no email rows). repeatEnquiryRate = % of
    // email-identified enquiries beyond the first per email, i.e.
    // 100*(emailRows-unique)/emailRows (1dp, 0 when none) — 0 means every
    // email enquired exactly once.
    uniqueEmails,
    repeatEnquiryRate,
    avgEnquiriesPerEmail,
  };
}

// ---------------------------------------------------------------------------
// Lead groups — per-email / per-phone read model (Phase 3, additive reads).
//
// Groups derive from the stamped `leadGroupKey` column (emailNorm ??
// 'phone:' + mobileNorm ?? null — see normalizeLeadIdentity). Contact-less
// rows (leadGroupKey IS NULL) are EXCLUDED from both endpoints by design:
// with no email and no usable phone there is no identity to group by, and
// inventing a per-row pseudo-group would fake repeat counts. They stay
// visible in GET /leads (grouped-by-stage, unchanged) and GET /leads/:id.
//
// Filter semantics (documented choice): `search` / `stage` / `source` select
// GROUPS by existence (a group lists when >= 1 of its rows matches), but
// every listed group carries its FULL content (count / stages / phones /
// names / leadIds over ALL rows, newest-first). Rationale: the count badge
// ("foo@x.com — 4 enquiries") must agree with the expanded timeline; counts
// over the filtered subset would disagree with the timeline just opened.
// ---------------------------------------------------------------------------

export interface LeadGroupQuery {
  search?: string;
  stage?: LeadStage;
  source?: LeadSource;
  page?: number;
  perPage?: number;
}

export interface LeadGroupSummary {
  /** Most recent non-null raw email, or null for phone-only groups. */
  email: string | null;
  /** Display identity: email ?? most-recent mobile ?? groupKey. */
  emailDisplay: string;
  /** emailNorm for email groups, 'phone:<mobileNorm>' for phone-only groups. */
  groupKey: string;
  count: number;
  latestAt: Date;
  /** Distinct stages, newest-row-first. */
  stages: LeadStage[];
  /** Distinct non-null raw mobiles, newest-row-first. */
  phones: string[];
  /** Distinct names, newest-row-first. */
  names: string[];
  /** Row ids, newest-first (== timeline order). */
  leadIds: string[];
  /** True when group rows carry >1 distinct normalized phone (auto-linked, never blocked). */
  phoneVariance: boolean;
}

/** Summarize one group's rows (must arrive newest-first). */
function summarizeGroup(groupKey: string, rowsDesc: LeadWithBranch[]): LeadGroupSummary {
  const email = rowsDesc.map((r) => r.email?.trim() || null).find((e) => e != null) ?? null;
  const topMobile = rowsDesc.map((r) => r.mobile?.trim() || null).find((m) => m != null) ?? null;
  const stages: LeadStage[] = [];
  for (const r of rowsDesc) if (!stages.includes(r.stage)) stages.push(r.stage);
  const phones: string[] = [];
  for (const r of rowsDesc) {
    const m = r.mobile?.trim() || null;
    if (m && !phones.includes(m)) phones.push(m);
  }
  const names: string[] = [];
  for (const r of rowsDesc) if (!names.includes(r.name)) names.push(r.name);
  const normPhones = new Set(
    rowsDesc.map((r) => r.mobileNorm ?? normalizeLeadMobile(r.mobile)).filter((n): n is string => n != null),
  );
  return {
    email,
    emailDisplay: email ?? topMobile ?? groupKey,
    groupKey,
    count: rowsDesc.length,
    latestAt: rowsDesc[0]?.createdAt ?? new Date(0),
    stages,
    phones,
    names,
    leadIds: rowsDesc.map((r) => r.id),
    phoneVariance: normPhones.size > 1,
  };
}

export async function listLeadGroups(q: LeadGroupQuery): Promise<{
  rows: LeadGroupSummary[];
  meta: { total: number; page: number; perPage: number };
}> {
  const search = q.search?.trim() || '';
  const page = Math.max(1, Math.floor(q.page ?? 1) || 1);
  const perPage = Math.min(100, Math.max(1, Math.floor(q.perPage ?? 10) || 10));
  // Existence filter: groups having >= 1 row matching search/stage/source.
  const rowWhere: Prisma.LeadWhereInput = { leadGroupKey: { not: null } };
  if (search) {
    rowWhere.OR = [
      { email: { contains: search, mode: 'insensitive' } },
      { emailNorm: { contains: search.toLowerCase(), mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (q.stage) rowWhere.stage = q.stage;
  if (q.source) rowWhere.source = q.source;
  const matched = await prisma.lead.findMany({
    where: rowWhere,
    select: { leadGroupKey: true },
    distinct: ['leadGroupKey'],
  });
  const keys = matched.map((r) => r.leadGroupKey).filter((k): k is string => !!k);
  if (!keys.length) return { rows: [], meta: { total: 0, page, perPage } };
  // Full timelines for the matched groups (see the filter-semantics note above).
  const rows = await prisma.lead.findMany({
    where: { leadGroupKey: { in: keys } },
    include: { branch: true },
    orderBy: { createdAt: 'desc' },
  });
  const byKey = new Map<string, LeadWithBranch[]>();
  for (const r of rows) {
    const k = r.leadGroupKey as string;
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  const summaries = [...byKey.entries()].map(([groupKey, rs]) => summarizeGroup(groupKey, rs));
  summaries.sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime());
  const total = summaries.length;
  return { rows: summaries.slice((page - 1) * perPage, page * perPage), meta: { total, page, perPage } };
}

export interface LeadGroupTimelineRow extends ReturnType<typeof serializeLead> {
  /** True when this row's normalized phone differs from a group sibling's. */
  phoneVariance: boolean;
  /** True for terminal WON/LOST rows: linked read-only, never re-opened. */
  terminalReadOnly: boolean;
}

export async function getLeadGroupTimeline(groupKey: string): Promise<{
  group: LeadGroupSummary;
  timeline: LeadGroupTimelineRow[];
}> {
  const rows = await prisma.lead.findMany({
    where: { leadGroupKey: groupKey },
    include: { branch: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!rows.length) throw new AppError(404, 'NOT_FOUND', 'Lead group not found');
  const norms = rows.map((r) => r.mobileNorm ?? normalizeLeadMobile(r.mobile));
  const timeline = rows.map((r, i) => ({
    ...serializeLead(r),
    // Same variance rule as link-time groupStats: any sibling with a
    // different normalized phone (null counts as its own value).
    phoneVariance: norms.some((n, j) => j !== i && (n ?? null) !== (norms[i] ?? null)),
    // WON/LOST rows link read-only: capture always creates a new row and
    // never re-opens them (see createPublicLead link-or-create).
    terminalReadOnly: r.stage === 'WON' || r.stage === 'LOST',
  }));
  return { group: summarizeGroup(groupKey, rows), timeline };
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

// ---------------------------------------------------------------------------
// Payment-won attribution (Stripe webhook → Lead WON).
// Called best-effort from applyCheckoutCompleted (src/core/checkout.ts) — the
// backend webhook is the single source of truth; the booking frontend never
// sets lead stage. There is no Lead↔Booking FK, so matching is by identity:
// the shared normalizeLeadIdentity() columns (emailNorm / mobileNorm,
// stamped on every write and backfilled — see lead_identity_norms).
//
//   - CONTACT match is by identity: booking email -> emailNorm equality
//     (global email identity — same email across branches is one identity; a
//     different email is a different identity even when the phone matches);
//     email-less bookings fall back to phone-only rows (emailNorm IS NULL +
//     mobileNorm equality, length >= 7, so phone-only groups never merge into
//     email groups).
//   - UNIT/BRANCH narrow only when the lead carries them: a lead with a
//     different unitCode, or a preferredBranchId different from the booking's
//     branch, is a different enquiry and is left alone. Leads carrying neither
//     still convert on contact match alone.
// Forward-only + never resurrect: WON and LOST are excluded both in the read
// and in the conditional updateMany, so concurrent/retried webhooks stay safe
// no-ops. Unlike the LOST path in updateLead there is no win attribution to
// stamp (no won-reason/value columns exist) — the stage flip is the whole
// write. Manual PATCH /leads/:id to WON is untouched and keeps working.
// Returns the number of leads flipped (0 when nothing matched).
// ---------------------------------------------------------------------------

export interface LeadWonMatch {
  email?: string | null;
  mobile?: string | null;
  unitCode?: string | null;
  branchId?: string | null;
}

export async function markLeadWonForBooking(
  client: Prisma.TransactionClient,
  match: LeadWonMatch,
): Promise<number> {
  const { emailNorm, mobileNorm } = normalizeLeadIdentity(match.email, match.mobile);
  if (!emailNorm && !mobileNorm) return 0;
  const unitCode = match.unitCode?.trim() || null;
  const branchId = match.branchId?.trim() || null;

  // Identity prefilter on the indexed norm columns. Email-primary: a booking
  // email matches emailNorm rows only (never a phone cross-match into a
  // different email's group). Phone-only bookings match phone-only rows.
  const contactOr: Prisma.LeadWhereInput[] = [];
  if (emailNorm) {
    contactOr.push({ emailNorm });
  } else if (mobileNorm && mobileNorm.length >= PHONE_LOOKUP_MIN_LENGTH) {
    contactOr.push({ emailNorm: null, mobileNorm });
  }
  if (contactOr.length === 0) return 0;
  const candidates = await client.lead.findMany({
    where: { stage: { notIn: ['WON', 'LOST'] }, OR: contactOr },
    select: {
      id: true,
      stage: true,
      emailNorm: true,
      mobileNorm: true,
      unitCode: true,
      preferredBranchId: true,
      note: true,
    },
  });

  const ids: string[] = [];
  for (const c of candidates) {
    if (c.stage === 'WON' || c.stage === 'LOST') continue;
    // Portal change requests share the customer's identity but are not
    // enquiries a booking can convert — ops close them by hand.
    if (isCustomerRequestLead(c)) continue;
    // Re-verify in JS so a loose index hit can never widen the write set.
    // (Norms are stamped on every write and backfilled, so the stored
    // columns are authoritative — no raw-contact fuzzy fallback.)
    const emailOk = !!emailNorm && (c.emailNorm ?? null) === emailNorm;
    const mobileOk =
      !emailNorm &&
      !!mobileNorm &&
      (c.emailNorm ?? null) == null &&
      (c.mobileNorm ?? null) === mobileNorm;
    if (!emailOk && !mobileOk) continue;
    // Narrow by unit/branch only when the lead carries them (effective
    // unitCode falls back to legacy note-packed lines for pre-v2 rows).
    const leadUnit = c.unitCode?.trim() || parseLegacyLeadNote(c.note).unitCode || null;
    if (unitCode && leadUnit && leadUnit !== unitCode) continue;
    if (branchId && c.preferredBranchId && c.preferredBranchId !== branchId) continue;
    ids.push(c.id);
  }
  if (ids.length === 0) return 0;

  // Conditional on stage so a concurrent webhook/retry flips each row once and
  // never touches a row that moved to LOST in between (forward-only).
  const updated = await client.lead.updateMany({
    where: { id: { in: ids }, stage: { notIn: ['WON', 'LOST'] } },
    data: { stage: 'WON' },
  });
  return updated.count;
}

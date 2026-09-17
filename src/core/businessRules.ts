// P1 item 7 — org + booking business rules beyond the 3 existing booking
// scalars (booking.autoConfirm / minAdvanceHours / maxStayMonths in
// src/core/settings.ts, untouched).
//
// Typed settings-group approach on the BusinessRule model: every known key has
// a def (kind + default + constraints) driving validation here and the control
// in the CMS; reads merge stored rows over code defaults so a fresh DB behaves
// like a configured one. Consumers (CMS UI today; booking flows next) read via
// GET /business-rules.
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';

export type BusinessRuleKind = 'boolean' | 'number' | 'text';

export interface BusinessRuleDef {
  key: string;
  category: 'org' | 'booking';
  kind: BusinessRuleKind;
  label: string;
  description: string;
  default: boolean | number | string;
  min?: number;
  max?: number;
  integer?: boolean;
  maxLength?: number;
}

export const BUSINESS_RULE_DEFS: BusinessRuleDef[] = [
  // --- Booking (beyond the 3 scalar booking settings) ---
  {
    key: 'booking.minStayDays',
    category: 'booking',
    kind: 'number',
    label: 'Minimum stay',
    description: 'Shortest bookable stay, in days.',
    default: 30,
    min: 1,
    max: 365,
    integer: true,
  },
  {
    key: 'booking.holdHours',
    category: 'booking',
    kind: 'number',
    label: 'Quote hold window',
    description: 'Hours a quoted unit is held for the lead before release.',
    default: 48,
    min: 1,
    max: 336,
    integer: true,
  },
  {
    key: 'booking.maxUnitsPerCustomer',
    category: 'booking',
    kind: 'number',
    label: 'Max units per customer',
    description: 'Most active units one customer may hold at once.',
    default: 5,
    min: 1,
    max: 50,
    integer: true,
  },
  {
    key: 'booking.requireIDVerification',
    category: 'booking',
    kind: 'boolean',
    label: 'Require ID verification',
    description: 'Block move-in until the tenant identity is verified.',
    default: true,
  },
  {
    key: 'booking.moveOutNoticeDays',
    category: 'booking',
    kind: 'number',
    label: 'Move-out notice period',
    description: 'Days of notice a tenant must give before the last day.',
    default: 30,
    min: 0,
    max: 120,
    integer: true,
  },
  // --- Org ---
  {
    key: 'org.timezone',
    category: 'org',
    kind: 'text',
    label: 'Operating timezone',
    description: 'IANA timezone for all operational dates (e.g. Asia/Singapore).',
    default: 'Asia/Singapore',
    maxLength: 64,
  },
  {
    key: 'org.supportSLA',
    category: 'org',
    kind: 'text',
    label: 'Support SLA',
    description: 'Public support response commitment (e.g. 4h response).',
    default: '4h response',
    maxLength: 64,
  },
  {
    key: 'org.maxOverdueDays',
    category: 'org',
    kind: 'number',
    label: 'Max overdue days',
    description: 'Days overdue before an account is escalated to collections.',
    default: 60,
    min: 1,
    max: 365,
    integer: true,
  },
];

const DEF_BY_KEY = new Map(BUSINESS_RULE_DEFS.map((d) => [d.key, d]));

export type BusinessRuleMap = Record<string, boolean | number | string>;

export const DEFAULT_BUSINESS_RULES: BusinessRuleMap = Object.fromEntries(
  BUSINESS_RULE_DEFS.map((d) => [d.key, d.default]),
);

function coerceValue(def: BusinessRuleDef, raw: unknown): boolean | number | string {
  if (def.kind === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    throw new AppError(400, 'VALIDATION', `Rule "${def.key}" must be a boolean (true/false).`);
  }
  if (def.kind === 'number') {
    const n = typeof raw === 'number' ? raw : NaN;
    if (!Number.isFinite(n)) throw new AppError(400, 'VALIDATION', `Rule "${def.key}" must be a number.`);
    if (def.integer && !Number.isInteger(n)) {
      throw new AppError(400, 'VALIDATION', `Rule "${def.key}" must be a whole number.`);
    }
    if (def.min !== undefined && n < def.min) {
      throw new AppError(400, 'VALIDATION', `Rule "${def.key}" must be at least ${def.min}.`);
    }
    if (def.max !== undefined && n > def.max) {
      throw new AppError(400, 'VALIDATION', `Rule "${def.key}" must be at most ${def.max}.`);
    }
    return n;
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new AppError(400, 'VALIDATION', `Rule "${def.key}" must not be empty.`);
  }
  const s = raw.trim();
  if (def.maxLength !== undefined && s.length > def.maxLength) {
    throw new AppError(400, 'VALIDATION', `Rule "${def.key}" must be at most ${def.maxLength} characters.`);
  }
  return s;
}

/** Whole rules map with metadata: stored rows merged over code defaults. */
export async function listBusinessRules() {
  const rows = await prisma.businessRule.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return BUSINESS_RULE_DEFS.map((def) => {
    const row = byKey.get(def.key);
    const v = row?.value as unknown;
    const value =
      typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string' ? v : def.default;
    return {
      key: def.key,
      category: def.category,
      kind: def.kind,
      label: def.label,
      description: def.description,
      value,
      active: row?.active ?? true,
      customized: !!row,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

/** Single rule value (stored row or default). 404 on unknown key. */
export async function getBusinessRule(key: string) {
  const def = DEF_BY_KEY.get(key);
  if (!def) throw new AppError(404, 'NOT_FOUND', `Unknown business rule "${key}".`);
  const row = await prisma.businessRule.findUnique({ where: { key } });
  const v = row?.value as unknown;
  const value =
    typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string' ? v : def.default;
  return { key, category: def.category, value, active: row?.active ?? true };
}

/** Batch upsert `{ key: value }` — unknown keys and invalid values 400 with
 * nothing written (validated before the transaction). */
export async function upsertBusinessRules(input: unknown) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AppError(400, 'VALIDATION', 'Business-rules payload must be an object of { key: value }.');
  }
  const entries = Object.entries(input);
  if (!entries.length) {
    throw new AppError(400, 'VALIDATION', 'Business-rules payload must not be empty.');
  }
  const coerced = entries.map(([key, raw]) => {
    const def = DEF_BY_KEY.get(key);
    if (!def) throw new AppError(400, 'VALIDATION', `Unknown business rule "${key}".`);
    return { key, value: coerceValue(def, raw), def };
  });
  await prisma.$transaction(
    coerced.map(({ key, value, def }) =>
      prisma.businessRule.upsert({
        where: { key },
        update: { value, category: def.category },
        create: { key, category: def.category, value, description: def.description },
      }),
    ),
  );
  return listBusinessRules();
}

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
import { writeAuditEvent } from './finance/audit';
import { publishFinanceEvent } from './finance/events';
import { newCorrelationId } from './finance/idempotency';

export type BusinessRuleKind = 'boolean' | 'number' | 'text';

/** Group for the Global Settings rules list. `ratestrategy` is the B4
 * Master Rate Strategy defaults surface (new-draft + batch-form defaults
 * consumed by the CMS; server validation is unchanged). */
export type BusinessRuleCategory = 'org' | 'booking' | 'moveout' | 'ratestrategy';

export interface BusinessRuleDef {
  key: string;
  category: BusinessRuleCategory;
  kind: BusinessRuleKind;
  label: string;
  description: string;
  default: boolean | number | string;
  min?: number;
  max?: number;
  integer?: boolean;
  maxLength?: number;
  // Track A: closed value set for text settings that are enums in practice
  // (e.g. moveout.approvalRole). When present, coerceValue rejects anything
  // outside the set.
  allowed?: readonly string[];
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
  // --- Move-outs & refunds (handoff §14; Track A).
  // The required-notice-days source stays `booking.moveOutNoticeDays` above
  // (the notice-days source of truth — not duplicated here). These five are
  // the remaining §14 rows; every new case snapshots the effective values at
  // request time (R7), so policy edits never rewrite open cases.
  {
    key: 'moveout.allowDateChange',
    category: 'moveout',
    kind: 'boolean',
    label: 'Allow requested move-out date changes',
    description: 'Staff may change the final access date (a reason and recalculation are always required).',
    default: true,
  },
  {
    key: 'moveout.shortNoticeForfeitDeposit',
    category: 'moveout',
    kind: 'boolean',
    label: 'Short notice may forfeit deposit',
    description: 'A non-compliant notice forfeits the deposit. Affects the deposit only, never unused storage rent.',
    default: true,
  },
  {
    key: 'moveout.depositCollectionEnabled',
    category: 'moveout',
    kind: 'boolean',
    label: 'Security deposit collection',
    description: 'Whether deposits are collected at all. Off at launch (S$0 everywhere); authoritative source is Fees & deposits.',
    default: false,
  },
  {
    key: 'moveout.inspectionRequired',
    category: 'moveout',
    kind: 'boolean',
    label: 'Physical inspection required',
    description: 'Inspection is required before a settlement can be submitted and a unit released. Locked on.',
    default: true,
  },
  {
    key: 'moveout.approvalRole',
    category: 'moveout',
    kind: 'text',
    label: 'Approval role',
    description: 'Who may approve refunds/charges: ADMIN_OR_FINANCE (any holder of bill-transactions:approve) or ADMIN_ONLY (Owner only).',
    default: 'ADMIN_OR_FINANCE',
    maxLength: 32,
    allowed: ['ADMIN_OR_FINANCE', 'ADMIN_ONLY'],
  },
  // --- Master Rate Strategy defaults (B4 CMS workspace) ---
  // Consumed as new-draft / batch-form defaults by the operator UI only;
  // every server calculation still validates its own inputs.
  {
    key: 'ratestrategy.defaultRounding',
    category: 'ratestrategy',
    kind: 'number',
    label: 'Default rate rounding',
    description: 'Monthly-rate rounding preselected for new strategy drafts (S$1, S$5 or S$10).',
    default: 1,
    min: 1,
    max: 10,
    integer: true,
  },
  {
    key: 'ratestrategy.defaultConflictRule',
    category: 'ratestrategy',
    kind: 'text',
    label: 'Default manual-rate rule',
    description: 'Manual-rate rule preselected when scheduling a Units rate batch (PRESERVE_MANUAL, REPLACE_MANUAL or CANCEL_IF_MANUAL).',
    default: 'PRESERVE_MANUAL',
    maxLength: 32,
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
  if (def.allowed !== undefined && !def.allowed.includes(s)) {
    throw new AppError(400, 'VALIDATION', `Rule "${def.key}" must be one of: ${def.allowed.join(', ')}.`);
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
 * nothing written (validated before the transaction).
 *
 * A-19 (handoff §14): every key whose value actually changes writes one
 * FinanceAuditEvent (actor, key, before value, after value, source) plus a
 * matching FinanceEvent outbox row, in the same transaction as the upsert —
 * the writeAuditEvent → publishFinanceEvent path used by other Track A
 * mutations. Unchanged keys write nothing. */
export async function upsertBusinessRules(
  input: unknown,
  opts?: { actor?: string; source?: string; correlationId?: string },
) {
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
  // Before-values for the audit trail: stored row, else the code default.
  const stored = await prisma.businessRule.findMany({ where: { key: { in: coerced.map((c) => c.key) } } });
  const beforeByKey = new Map<string, boolean | number | string>();
  for (const c of coerced) {
    const row = stored.find((r) => r.key === c.key);
    const v = row?.value as unknown;
    beforeByKey.set(
      c.key,
      typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string' ? v : c.def.default,
    );
  }
  const actor = (opts?.actor ?? 'cms-operator').slice(0, 120);
  const source = opts?.source ?? 'cms';
  const correlationId = opts?.correlationId ?? newCorrelationId();
  await prisma.$transaction(async (tx) => {
    for (const { key, value, def } of coerced) {
      await tx.businessRule.upsert({
        where: { key },
        update: { value, category: def.category },
        create: { key, category: def.category, value, description: def.description },
      });
    }
    for (const { key, value } of coerced) {
      const before = beforeByKey.get(key);
      if (before === value) continue; // no change — no audit event
      await writeAuditEvent(tx, {
        actor,
        action: 'business_rule.updated',
        entityType: 'BusinessRule',
        entityId: key,
        before: { key, value: before },
        after: { key, value },
        source,
        correlationId,
      });
      await publishFinanceEvent(tx, {
        type: 'business_rule.updated',
        payload: { key, before, after: value, actor },
        correlationId,
      });
    }
  });
  return listBusinessRules();
}

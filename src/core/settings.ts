// Whole-app Global Settings (CMS "Global Settings" page, Phase 6).
//
// Key/value store over the `Setting` model: `GET /settings` returns the whole
// map, `PUT /settings` batch-upserts `{ key: value }`. Every known key is
// documented below with its `kind`, which drives both validation/coercion here
// and the control rendered in the CMS (boolean → `.sw` toggle switch,
// number → number input, text → text input, select → dropdown).
//
// Adding a new setting: append a `SettingDef` (key + kind + default +
// constraints) — no migration needed. Unknown keys are rejected on write;
// reads always merge stored rows over `DEFAULT_SETTINGS` so missing rows
// fall back to defaults.
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';

export type SettingKind = 'boolean' | 'number' | 'text' | 'select';

export interface SettingDef {
  key: string;
  group: 'notifications' | 'booking' | 'billing' | 'display' | 'operations';
  /** Control kind: boolean → toggle switch, number → number input, text → text input, select → dropdown. */
  kind: SettingKind;
  label: string;
  description: string;
  default: boolean | number | string;
  /** number kind only */
  min?: number;
  max?: number;
  integer?: boolean;
  /** text kind only */
  maxLength?: number;
  pattern?: RegExp;
  patternHint?: string;
  /** select kind only */
  options?: string[];
}

export const SETTING_DEFS: SettingDef[] = [
  // --- Notifications ---
  {
    key: 'notifications.emailBookingAlerts',
    group: 'notifications',
    kind: 'boolean',
    label: 'Email booking alerts',
    description: 'Email operators when a new booking arrives.',
    default: true,
  },
  {
    key: 'notifications.whatsappBookingAlerts',
    group: 'notifications',
    kind: 'boolean',
    label: 'WhatsApp booking alerts',
    description: 'Ping operators on WhatsApp for new bookings.',
    default: true,
  },
  {
    key: 'notifications.reminderLeadHours',
    group: 'notifications',
    kind: 'number',
    label: 'Follow-up reminder',
    description: 'Hours after a new enquiry before a follow-up reminder fires.',
    default: 24,
    min: 1,
    max: 168,
    integer: true,
  },
  // --- Booking ---
  {
    key: 'booking.autoConfirm',
    group: 'booking',
    kind: 'boolean',
    label: 'Auto-confirm bookings',
    description: 'Confirm paid bookings without operator review.',
    default: false,
  },
  {
    key: 'booking.minAdvanceHours',
    group: 'booking',
    kind: 'number',
    label: 'Min advance booking',
    description: 'Earliest a move-in can be booked, in hours from now.',
    default: 24,
    min: 0,
    max: 720,
    integer: true,
  },
  {
    key: 'booking.maxStayMonths',
    group: 'booking',
    kind: 'number',
    label: 'Max stay length',
    description: 'Longest single booking allowed, in months.',
    default: 24,
    min: 1,
    max: 60,
    integer: true,
  },
  // --- Billing ---
  {
    key: 'billing.graceDays',
    group: 'billing',
    kind: 'number',
    label: 'Payment grace period',
    description: 'Days after the due date before an invoice counts as overdue.',
    default: 5,
    min: 0,
    max: 30,
    integer: true,
  },
  {
    key: 'billing.lateFeeEnabled',
    group: 'billing',
    kind: 'boolean',
    label: 'Late fees',
    description: 'Apply late fees to invoices past the grace period.',
    default: true,
  },
  {
    key: 'billing.invoicePrefix',
    group: 'billing',
    kind: 'text',
    label: 'Invoice prefix',
    description: 'Prefix for generated invoice numbers (e.g. INV-2026-0001).',
    default: 'INV-',
    maxLength: 12,
    pattern: /^[A-Z0-9-]{1,12}$/,
    patternHint: 'Up to 12 chars: A–Z, 0–9, hyphen.',
  },
  // --- Display ---
  {
    key: 'display.currency',
    group: 'display',
    kind: 'select',
    label: 'Currency',
    description: 'Currency shown across the CMS and invoices.',
    default: 'SGD',
    options: ['SGD', 'USD', 'MYR'],
  },
  {
    key: 'display.dateFormat',
    group: 'display',
    kind: 'select',
    label: 'Date format',
    description: 'Date format used across the CMS.',
    default: 'DD/MM/YYYY',
    options: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'],
  },
  // --- Operations ---
  {
    key: 'operations.maintenanceMode',
    group: 'operations',
    kind: 'boolean',
    label: 'Maintenance mode',
    description: 'Pause new bookings while maintenance is underway.',
    default: false,
  },
  {
    key: 'operations.supportContact',
    group: 'operations',
    kind: 'text',
    label: 'Support contact',
    description: 'Support email or phone shown to customers.',
    default: 'ops@storelah.sg',
    maxLength: 120,
  },
];

const DEF_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

export type SettingsMap = Record<string, boolean | number | string>;

/** Defaults for every known key (the map `GET /settings` returns on a fresh DB). */
export const DEFAULT_SETTINGS: SettingsMap = Object.fromEntries(
  SETTING_DEFS.map((d) => [d.key, d.default]),
);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function coerceValue(def: SettingDef, raw: unknown): boolean | number | string {
  switch (def.kind) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'number' && (raw === 1 || raw === 0)) return raw === 1;
      if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        if (['true', '1', 'on', 'yes'].includes(s)) return true;
        if (['false', '0', 'off', 'no'].includes(s)) return false;
      }
      throw new AppError(400, 'VALIDATION', `Setting "${def.key}" must be a boolean (true/false).`);
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new AppError(400, 'VALIDATION', `Setting "${def.key}" must be a number.`);
      }
      if (def.integer && !Number.isInteger(n)) {
        throw new AppError(400, 'VALIDATION', `Setting "${def.key}" must be a whole number.`);
      }
      if (def.min !== undefined && n < def.min) {
        throw new AppError(400, 'VALIDATION', `Setting "${def.key}" must be at least ${def.min}.`);
      }
      if (def.max !== undefined && n > def.max) {
        throw new AppError(400, 'VALIDATION', `Setting "${def.key}" must be at most ${def.max}.`);
      }
      return n;
    }
    case 'text': {
      if (typeof raw !== 'string') {
        throw new AppError(400, 'VALIDATION', `Setting "${def.key}" must be text.`);
      }
      const s = raw.trim();
      if (!s) throw new AppError(400, 'VALIDATION', `Setting "${def.key}" must not be empty.`);
      if (def.maxLength !== undefined && s.length > def.maxLength) {
        throw new AppError(400, 'VALIDATION', `Setting "${def.key}" must be at most ${def.maxLength} characters.`);
      }
      if (def.pattern && !def.pattern.test(s)) {
        throw new AppError(400, 'VALIDATION', `Setting "${def.key}" is invalid. ${def.patternHint ?? ''}`.trim());
      }
      return s;
    }
    case 'select': {
      if (typeof raw !== 'string' || !def.options?.includes(raw)) {
        throw new AppError(
          400,
          'VALIDATION',
          `Setting "${def.key}" must be one of: ${(def.options ?? []).join(', ')}.`,
        );
      }
      return raw;
    }
  }
}

/** Whole settings map: stored rows merged over code defaults (missing rows → defaults). */
export async function getSettings(): Promise<SettingsMap> {
  const rows = await prisma.setting.findMany();
  const map: SettingsMap = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    const def = DEF_BY_KEY.get(r.key);
    if (!def) continue; // stale row for a retired key — never surfaces
    const v = r.value as unknown;
    if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
      map[r.key] = v;
    }
  }
  return map;
}

/** Single setting value (stored row or default). 404 on unknown key. */
export async function getSetting(key: string): Promise<boolean | number | string> {
  const def = DEF_BY_KEY.get(key);
  if (!def) throw new AppError(404, 'NOT_FOUND', `Unknown setting "${key}".`);
  const row = await prisma.setting.findUnique({ where: { key } });
  const v = row?.value as unknown;
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  return def.default;
}

/**
 * Batch upsert `{ key: value }`. Every key must be known, every value must
 * validate/coerce per its def — the first failure aborts the whole batch
 * (400, nothing written). Returns the full saved map.
 */
export async function upsertSettings(input: unknown): Promise<SettingsMap> {
  if (!isPlainObject(input)) {
    throw new AppError(400, 'VALIDATION', 'Settings payload must be an object of { key: value }.');
  }
  const entries = Object.entries(input);
  if (!entries.length) {
    throw new AppError(400, 'VALIDATION', 'Settings payload must not be empty.');
  }
  const coerced: Array<{ key: string; value: boolean | number | string }> = entries.map(([key, raw]) => {
    const def = DEF_BY_KEY.get(key);
    if (!def) throw new AppError(400, 'VALIDATION', `Unknown setting "${key}".`);
    return { key, value: coerceValue(def, raw) };
  });
  await prisma.$transaction(
    coerced.map(({ key, value }) =>
      prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      }),
    ),
  );
  return getSettings();
}

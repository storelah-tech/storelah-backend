// Lead pipeline, response SLA and lead-value rules (prototype 2026-11-04,
// docs/prototype-updates/storelah-prototype-updates-2026-11-04.md §Leads).
//
// Stage identifiers are the stored LeadStage values; the prototype's stage
// names are labels over them. Pipeline settings and SLA settings are versioned
// documents in the Setting key/value table (keys below), each save keeping the
// previous versions for rollback.

import { LeadStage, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';

export const LEAD_PRODUCT = 'AC Self-Storage';

/** Months used for potential value when the duration is unknown or ongoing. */
export const PLANNING_DEFAULT_MONTHS = 6;

export const ACCESS_FREQUENCIES = [
  'Not sure',
  'Daily',
  '2–3 times weekly',
  'Weekly',
  '2–3 times monthly',
  'Monthly',
  'Rarely / archive storage',
] as const;

interface StageDef {
  stage: LeadStage;
  label: string;
  probability: number; // %
  maxAgeMinutes: number | null; // null = no limit
  colour: string;
}

// Pipeline order + prototype defaults. NURTURING sits outside the main flow.
export const STAGE_DEFS: readonly StageDef[] = [
  { stage: 'NEW_ENQUIRY', label: 'New', probability: 10, maxAgeMinutes: 15, colour: '#547b8d' },
  { stage: 'CONTACTED', label: 'Contacted', probability: 20, maxAgeMinutes: 60, colour: '#6c8490' },
  { stage: 'QUALIFIED', label: 'Qualified', probability: 40, maxAgeMinutes: 120, colour: '#5d6e52' },
  { stage: 'VIEWING_BOOKED', label: 'Viewing set', probability: 55, maxAgeMinutes: 24 * 60, colour: '#c98a58' },
  { stage: 'PROPOSAL_SENT', label: 'Quoted', probability: 65, maxAgeMinutes: 24 * 60, colour: '#a96245' },
  { stage: 'PENDING_PAYMENT', label: 'Booking started', probability: 80, maxAgeMinutes: 12 * 60, colour: '#8b6743' },
  { stage: 'PAID_BOOKING', label: 'Paid booking', probability: 95, maxAgeMinutes: 4 * 60, colour: '#55775f' },
  { stage: 'WON', label: 'Converted', probability: 100, maxAgeMinutes: null, colour: '#3e6648' },
  { stage: 'LOST', label: 'Lost', probability: 0, maxAgeMinutes: null, colour: '#9b5a54' },
  { stage: 'NURTURING', label: 'Nurturing', probability: 15, maxAgeMinutes: null, colour: '#7d7f86' },
];

export const PIPELINE_COLUMNS: LeadStage[] = STAGE_DEFS.map((d) => d.stage);
export const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGE_DEFS.map((d) => [d.stage, d.label]));

// ---------------------------------------------------------------------------
// Pipeline settings (stage probability / ageing / entry rule / automation).
// ---------------------------------------------------------------------------

export const PIPELINE_SETTING_KEY = 'leads.pipeline';
const MAX_HISTORY = 10;

export interface PipelineStageSetting {
  stage: LeadStage;
  probability: number;
  maxAgeMinutes: number | null;
  requiredBeforeEntry: string;
  automation: string;
}

export interface PipelineSettings {
  version: number;
  savedAt: string | null;
  savedBy: string | null;
  stages: PipelineStageSetting[];
  assignmentRule: string;
  lostReasons: string[];
  requireNextAction: boolean;
}

const DEFAULT_ENTRY: Partial<Record<LeadStage, [string, string]>> = {
  NEW_ENQUIRY: ['Name and one contact method', 'Auto-assign and start the first-response SLA'],
  CONTACTED: ['First meaningful response logged', 'Schedule a follow-up task'],
  QUALIFIED: ['Size, move-in date and duration captured', 'Suggest available units'],
  VIEWING_BOOKED: ['Appointment booked', 'Send viewing confirmation'],
  PROPOSAL_SENT: ['Quotation sent', 'Follow up 24 h after the quote is viewed'],
  PENDING_PAYMENT: ['Booking started online or by staff', 'Remind about unpaid booking'],
  PAID_BOOKING: ['Payment received', 'Prepare move-in'],
  WON: ['Agreement signed and moved in', 'Create customer record'],
  LOST: ['Lost reason selected', 'Add to nurture list after 30 days'],
  NURTURING: ['Not ready to book', 'Monthly check-in'],
};

export function defaultPipelineSettings(): PipelineSettings {
  return {
    version: 0,
    savedAt: null,
    savedBy: null,
    stages: STAGE_DEFS.map((d) => ({
      stage: d.stage,
      probability: d.probability,
      maxAgeMinutes: d.maxAgeMinutes,
      requiredBeforeEntry: DEFAULT_ENTRY[d.stage]?.[0] ?? '',
      automation: DEFAULT_ENTRY[d.stage]?.[1] ?? '',
    })),
    assignmentRule: 'Round robin across available sales staff',
    lostReasons: ['Price', 'Location', 'Timing', 'Competitor', 'No response', 'Unspecified'],
    requireNextAction: true,
  };
}

interface StoredDoc<T> {
  current: T;
  history: T[];
}

async function readDoc<T>(key: string): Promise<StoredDoc<T> | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row ? (row.value as unknown as StoredDoc<T>) : null;
}

async function writeDoc<T extends { version: number }>(key: string, next: T, expectedVersion: number | undefined): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { key } });
    const doc = row ? (row.value as unknown as StoredDoc<T>) : null;
    const currentVersion = doc?.current.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new AppError(409, 'CONFLICT', `These settings were changed by someone else (now version ${currentVersion}). Reload and try again.`);
    }
    const saved = { ...next, version: currentVersion + 1 };
    const history = doc ? [doc.current, ...doc.history].slice(0, MAX_HISTORY) : [];
    const value = { current: saved, history } as unknown as Prisma.InputJsonValue;
    await tx.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    return saved;
  });
}

// Short-lived cache so serializers can read stage probabilities synchronously.
let probabilityCache: { at: number; byStage: Record<string, number> } | null = null;
const CACHE_MS = 30_000;

export async function getPipelineSettings(): Promise<PipelineSettings> {
  const doc = await readDoc<PipelineSettings>(PIPELINE_SETTING_KEY);
  const settings = doc?.current ?? defaultPipelineSettings();
  probabilityCache = { at: Date.now(), byStage: Object.fromEntries(settings.stages.map((s) => [s.stage, s.probability])) };
  return settings;
}

/** Refreshes the probability cache when stale (call before serializing many leads). */
export async function warmPipelineCache(): Promise<void> {
  if (!probabilityCache || Date.now() - probabilityCache.at > CACHE_MS) await getPipelineSettings();
}

export function stageProbability(stage: LeadStage): number {
  const cached = probabilityCache?.byStage[stage];
  if (cached !== undefined) return cached;
  return STAGE_DEFS.find((d) => d.stage === stage)?.probability ?? 0;
}

export async function savePipelineSettings(input: Omit<PipelineSettings, 'version' | 'savedAt' | 'savedBy'> & { version?: number }, actor: string): Promise<PipelineSettings> {
  const known = new Set(PIPELINE_COLUMNS);
  const seen = new Set<string>();
  for (const s of input.stages) {
    if (!known.has(s.stage)) throw new AppError(400, 'VALIDATION', `Unknown stage ${s.stage}`);
    if (seen.has(s.stage)) throw new AppError(400, 'VALIDATION', `Stage ${s.stage} is listed twice`);
    seen.add(s.stage);
  }
  if (seen.size !== known.size) throw new AppError(400, 'VALIDATION', 'Every pipeline stage must be configured.');
  if (!input.lostReasons.length) throw new AppError(400, 'VALIDATION', 'Keep at least one lost reason.');
  const saved = await writeDoc<PipelineSettings>(PIPELINE_SETTING_KEY, {
    version: 0,
    savedAt: new Date().toISOString(),
    savedBy: actor,
    stages: input.stages,
    assignmentRule: input.assignmentRule,
    lostReasons: input.lostReasons,
    requireNextAction: input.requireNextAction,
  }, input.version);
  probabilityCache = { at: Date.now(), byStage: Object.fromEntries(saved.stages.map((s) => [s.stage, s.probability])) };
  return saved;
}

// ---------------------------------------------------------------------------
// First-response SLA (Global Settings › Lead & response SLA).
// ---------------------------------------------------------------------------

export const SLA_SETTING_KEY = 'leads.sla';

export const SLA_CHANNEL_OPTIONS = {
  website: [15, 30, 60],
  whatsapp: [15, 30, 60],
  phone: [10, 15, 30],
  email: [30, 60, 240],
} as const;

export interface SlaSettings {
  version: number;
  savedAt: string | null;
  savedBy: string | null;
  targets: { website: number; whatsapp: number; phone: number; email: number }; // minutes
  businessHoursOnly: boolean;
  pauseOnPublicHolidays: boolean;
  whatsapp247: boolean;
  warningPct: number;
  escalateTo: string[];
}

export function defaultSlaSettings(): SlaSettings {
  return {
    version: 0,
    savedAt: null,
    savedBy: null,
    targets: { website: 15, whatsapp: 15, phone: 10, email: 30 },
    businessHoursOnly: true,
    pauseOnPublicHolidays: true,
    whatsapp247: false,
    warningPct: 80,
    escalateTo: ['Sales Manager', 'Assigned salesperson'],
  };
}

export async function getSlaSettings(): Promise<SlaSettings> {
  return (await readDoc<SlaSettings>(SLA_SETTING_KEY))?.current ?? defaultSlaSettings();
}

export async function saveSlaSettings(input: Omit<SlaSettings, 'version' | 'savedAt' | 'savedBy'> & { version?: number }, actor: string): Promise<SlaSettings> {
  for (const [channel, options] of Object.entries(SLA_CHANNEL_OPTIONS)) {
    const v = input.targets[channel as keyof SlaSettings['targets']];
    if (!(options as readonly number[]).includes(v)) {
      throw new AppError(400, 'VALIDATION', `${channel} target must be one of ${options.join(', ')} minutes.`);
    }
  }
  if (!(input.warningPct >= 1 && input.warningPct <= 100)) throw new AppError(400, 'VALIDATION', 'Warning threshold must be 1–100%.');
  return writeDoc<SlaSettings>(SLA_SETTING_KEY, {
    version: 0,
    savedAt: new Date().toISOString(),
    savedBy: actor,
    targets: input.targets,
    businessHoursOnly: input.businessHoursOnly,
    pauseOnPublicHolidays: input.pauseOnPublicHolidays,
    whatsapp247: input.whatsapp247,
    warningPct: input.warningPct,
    escalateTo: input.escalateTo,
  }, input.version);
}

// ---------------------------------------------------------------------------
// Lead value + dates.
// ---------------------------------------------------------------------------

/** Potential value = expected net monthly rent × expected billed months (6 when unknown). */
export function potentialValue(monthlyRate: number | null, durationMonths: number | null): number | null {
  if (monthlyRate == null) return null;
  const months = durationMonths && durationMonths > 0 ? durationMonths : PLANNING_DEFAULT_MONTHS;
  return Math.round(monthlyRate * months * 100) / 100;
}

/** Today's date in Singapore as a UTC-midnight Date (for @db.Date columns). */
export function sgToday(now = new Date()): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return new Date(`${ymd}T00:00:00.000Z`);
}

export function ymd(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function displayLeadNo(leadNo: number): string {
  return `SL-${leadNo}`;
}

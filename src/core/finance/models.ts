// Financial Models — planning workspace CRUD + staged sections (spec §11).
//
// One row per model; `inputs` is the complete committed ProjectionInput
// snapshot. The UI stages each of the FOUR sections independently and commits
// per-section with optimistic-lock `version` compare-and-swap (§§11.6–11.7):
//   PUT /models/:id/inputs      → startDate / horizonMonths / nlaSqft
//   PUT /models/:id/assumptions → occupancy + pricing
//   PUT /models/:id/size-mix    → sizeMix
//   PUT /models/:id/opex        → opex + lease + capitalTotal
//
// Every committed update: validates the FULL merged input through the pure
// engine (never persists its own math — the engine re-projects on read),
// bumps version, writes a FinanceAuditEvent + FinanceEvent in the same
// transaction, and returns the recomputed projection + calculation checks.
// Staged-state is UI-only: it never appears in URLs (spec §3.2) and Undo
// discards the clone without an audit event (nothing was committed).
//
// Statuses: DRAFT (editable) → PENDING (submitted, locked) → CURRENT
// (approved baseline) / ARCHIVED. Only DRAFT models accept section updates
// or deletion; CURRENT/ARCHIVED/PENDING are locked (submit/approve/restore
// paths live in library.ts).

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { toNum } from '../../lib/format';
import { writeAuditEvent } from './audit';
import { publishFinanceEvent } from './events';
import { isProtectedCategory } from './budgets';
import { assertFreshVersion, nextVersion, newCorrelationId } from './idempotency';
import {
  project,
  hashInput,
  ENGINE_VERSION,
  type ProjectionInput,
  type ProjectionResult,
} from './projection';

export const MODEL_STATUSES = ['DRAFT', 'PENDING', 'CURRENT', 'ARCHIVED'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

// The four prototype-parity staged sections (occupancy, capital, pricing,
// lease — spec §11.6 A–D) plus the toolbar inputs, Size Mix and the Budgets
// opex lines. `assumptions` is the legacy combined section (kept for API
// compatibility).
const SECTION_FIELDS = {
  inputs: ['startDate', 'horizonMonths', 'nlaSqft'],
  occupancy: ['occupancy'],
  capital: ['capitalItems', 'capitalTotal'],
  pricing: ['pricing'],
  lease: ['lease'],
  assumptions: ['occupancy', 'pricing'],
  'size-mix': ['sizeMix', 'nlaSqft'],
  opex: ['opex', 'lease', 'capitalTotal'],
} as const;
export const MODEL_SECTIONS = Object.keys(SECTION_FIELDS) as ModelSection[];
export type ModelSection = keyof typeof SECTION_FIELDS;

/** Default working inputs for a new model (Sembawang Launch Plan shape, §28). */
export function defaultModelInputs(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    startDate: '2026-12-01',
    horizonMonths: 60,
    nlaSqft: 2274,
    sizeMix: [
      { name: 'XS', range: '10–20 sq ft', nlaSqft: 455, units: 31, psf: 6.8 },
      { name: 'S', range: '21–30 sq ft', nlaSqft: 500, units: 20, psf: 6.2 },
      { name: 'M', range: '31–50 sq ft', nlaSqft: 650, units: 16, psf: 5.5 },
      { name: 'L', range: '51–80 sq ft', nlaSqft: 405, units: 7, psf: 4.8 },
      { name: 'XL', range: '81+ sq ft', nlaSqft: 264, units: 2, psf: 4.2 },
    ],
    occupancy: {
      rampFirst6: 180,
      rampFrom7: 125,
      moveOutRatePct: 2.5,
      churnStartMonth: 7,
      targetPct: 92,
    },
    pricing: { annualIncreasePct: 3 },
    lease: { monthlyByYear: [5000, 5000, 5000, 5000, 5000, 5000, 5000], rentFreeMonths: 0, ufaSqft: 3068 },
    opex: {
      baseMonthly: 1200,
      annualGrowthPct: 0,
      categories: [
        { name: 'Payroll & contractor', budget: 0, owner: 'Operations', note: '' },
        { name: 'Marketing', budget: 500, owner: 'Commercial', note: 'Launch media, content and local partnerships.' },
        { name: 'Utilities', budget: 500, owner: 'Operations', note: 'Electricity and air-conditioning allowance.' },
        { name: 'Software & IT', budget: 100, owner: 'Technology', note: 'CRM, hosting, access control and communications.' },
        { name: 'Maintenance & cleaning', budget: 0, owner: 'Operations', note: 'Preventive maintenance and cleaning.' },
        { name: 'Insurance & admin', budget: 0, owner: 'Finance', note: 'Insurance, bookkeeping and statutory costs.' },
        { name: 'Other operating costs', budget: 100, owner: 'Finance', note: 'Small approved operating items.' },
      ],
    },
    capitalTotal: 108000,
    capitalItems: [
      { name: 'Partitions, doors & latches', amount: 30000 },
      { name: 'Smart locks & access control', amount: 15000 },
      { name: 'CCTV, network & IT', amount: 8000 },
      { name: 'Fit-out, electrical & signage', amount: 28000 },
      { name: 'Professional and pre-opening', amount: 7000 },
      { name: 'Opening working capital', amount: 20000 },
    ],
    ...overrides,
  };
}

/**
 * Derived totals stay consistent with their itemised sources: capitalTotal =
 * Σ capitalItems, opex.baseMonthly = Σ categories (lease is never a category).
 */
export function normaliseInputs(inputs: ProjectionInput): ProjectionInput {
  const out = { ...inputs };
  if (Array.isArray(out.capitalItems)) {
    out.capitalTotal = Math.round(out.capitalItems.reduce((s, c) => s + (Number(c.amount) || 0), 0) * 100) / 100;
  }
  if (out.opex && Array.isArray(out.opex.categories)) {
    for (const c of out.opex.categories) {
      if (isProtectedCategory(c.name)) {
        throw new AppError(400, 'VALIDATION', `Category "${c.name}" is reserved for the landlord lease line — the lease is linked from the Financial Model, not an opex category.`);
      }
    }
    out.opex = { ...out.opex, baseMonthly: Math.round(out.opex.categories.reduce((s, c) => s + (Number(c.budget) || 0), 0) * 100) / 100 };
  }
  return out;
}

function toProjectionInput(raw: unknown): ProjectionInput {
  if (!raw || typeof raw !== 'object') throw new AppError(400, 'VALIDATION', 'Model inputs snapshot is missing or corrupt.');
  return raw as ProjectionInput;
}

export interface ModelSummary {
  id: string;
  branchId: string | null;
  name: string;
  status: string;
  engineVersion: string;
  inputHash: string;
  version: number;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ModelDetail extends ModelSummary {
  inputs: ProjectionInput;
  projection: ProjectionResult;
  checks: ProjectionResult['checks'];
}

function serializeModel(m: {
  id: string; branchId: string | null; name: string; status: string;
  engineVersion: string; inputHash: string; version: number;
  createdBy: string; updatedBy: string | null; createdAt: Date; updatedAt: Date;
}): ModelSummary {
  return { ...m };
}

/** Computes the live projection for a stored model (pure engine, §8). */
export function projectModel(inputs: ProjectionInput): ProjectionResult {
  return project(toProjectionInput(inputs));
}

export async function listModels(opts: { branchId?: string; status?: string; search?: string } = {}) {
  const rows = await prisma.financialModel.findMany({
    where: {
      ...(opts.branchId ? { branchId: opts.branchId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.search ? { name: { contains: opts.search, mode: 'insensitive' } } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  return rows.map(serializeModel);
}

export async function getModel(id: string): Promise<ModelDetail> {
  const m = await prisma.financialModel.findUnique({ where: { id } });
  if (!m) throw new AppError(404, 'NOT_FOUND', `Financial model ${id} not found.`);
  const inputs = toProjectionInput(m.inputs);
  const projection = projectModel(inputs);
  return { ...serializeModel(m), inputs, projection, checks: projection.checks };
}

export async function createModel(opts: {
  name: string;
  branchId?: string | null;
  inputs?: Partial<ProjectionInput>;
  actor: string;
  correlationId?: string;
}) {
  const name = opts.name.trim();
  if (!name) throw new AppError(400, 'VALIDATION', 'Model name is required.');
  if (opts.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: opts.branchId } });
    if (!branch) throw new AppError(404, 'NOT_FOUND', `Branch ${opts.branchId} not found.`);
  }
  const seeded = defaultModelInputs(opts.inputs ?? {});
  // An explicit capitalTotal without items wins over the template's items.
  if (opts.inputs && 'capitalTotal' in opts.inputs && !('capitalItems' in opts.inputs)) delete seeded.capitalItems;
  const inputs = normaliseInputs(seeded);
  // Full-engine validation before anything is stored (§11.8).
  const preview = projectModel(inputs);
  const correlationId = opts.correlationId ?? newCorrelationId();
  const created = await prisma.$transaction(async (tx) => {
    const m = await tx.financialModel.create({
      data: {
        branchId: opts.branchId ?? null,
        name,
        status: 'DRAFT',
        inputs: inputs as unknown as Prisma.InputJsonValue,
        engineVersion: ENGINE_VERSION,
        inputHash: hashInput(inputs),
        createdBy: opts.actor,
        updatedBy: opts.actor,
        version: 0,
      },
    });
    await tx.financialModelVersion.create({
      data: {
        modelId: m.id,
        version: 0,
        snapshot: inputs as unknown as Prisma.InputJsonValue,
        changeSummary: 'Model created',
        status: 'DRAFT',
        createdBy: opts.actor,
      },
    });
    await writeAuditEvent(tx, {
      branchId: m.branchId,
      actor: opts.actor,
      action: 'MODEL_CREATED',
      entityType: 'financial-model',
      entityId: m.id,
      after: { name, inputHash: m.inputHash },
      reason: 'Model created',
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'model.updated',
      payload: { modelId: m.id, section: null, inputHash: m.inputHash },
      branchId: m.branchId,
      correlationId,
    });
    return m;
  });
  return { ...serializeModel(created), inputs, projection: preview, checks: preview.checks };
}

/**
 * Commits one staged section (§§11.6–11.7). Rejects with 409 STALE when the
 * caller's `expectedVersion` moved, and with 403 LOCKED when the model is
 * not a DRAFT. Invalid sections leave the committed model untouched — the
 * last approved result is preserved and the failure is reported, never a
 * silent partial write.
 */
export async function updateModelSection(opts: {
  id: string;
  section: ModelSection;
  patch: Record<string, unknown>;
  expectedVersion?: number;
  actor: string;
  correlationId?: string;
}) {
  const stored = await prisma.financialModel.findUnique({ where: { id: opts.id } });
  if (!stored) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.id} not found.`);
  if (stored.status !== 'DRAFT') {
    throw new AppError(403, 'LOCKED', `Model "${stored.name}" is ${stored.status} — section edits apply to DRAFT models only. Duplicate or restore it to a new draft to continue.`);
  }
  assertFreshVersion(stored.version, opts.expectedVersion, 'FinancialModel');
  const allowed = SECTION_FIELDS[opts.section];
  const unknownKeys = Object.keys(opts.patch).filter((k) => !(allowed as readonly string[]).includes(k));
  if (unknownKeys.length) {
    throw new AppError(400, 'VALIDATION', `Section "${opts.section}" accepts only ${allowed.join(', ')} — got ${unknownKeys.join(', ')}.`);
  }
  const base = toProjectionInput(stored.inputs);
  const combined = { ...base, ...opts.patch } as ProjectionInput;
  // A bare capitalTotal patch (legacy opex section) replaces the itemised list.
  if ('capitalTotal' in opts.patch && !('capitalItems' in opts.patch)) delete combined.capitalItems;
  const merged = normaliseInputs(combined);
  // Validate + project the FULL merged input before storing (§11.7 contract).
  const preview = projectModel(merged);
  const correlationId = opts.correlationId ?? newCorrelationId();
  const before = { version: stored.version, inputHash: stored.inputHash };
  const updated = await prisma.$transaction(async (tx) => {
    const m = await tx.financialModel.update({
      where: { id: stored.id },
      data: {
        inputs: merged as unknown as Prisma.InputJsonValue,
        inputHash: preview.inputHash,
        updatedBy: opts.actor,
        version: nextVersion(stored.version),
      },
    });
    await writeAuditEvent(tx, {
      branchId: m.branchId,
      actor: opts.actor,
      action: 'MODEL_SECTION_UPDATED',
      entityType: 'financial-model',
      entityId: m.id,
      before,
      after: { section: opts.section, version: m.version, inputHash: m.inputHash },
      reason: `Section ${opts.section} updated`,
      source: 'cms',
      correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'model.updated',
      payload: { modelId: m.id, section: opts.section, inputHash: m.inputHash },
      branchId: m.branchId,
      correlationId,
    });
    return m;
  });
  return {
    ...serializeModel(updated),
    inputs: merged,
    projection: preview,
    checks: preview.checks,
    changedOutputs: {
      inputHash: preview.inputHash,
      engineVersion: preview.engineVersion,
      kpis: preview.kpis,
    },
  };
}

/** Deletes a DRAFT model only — CURRENT/ARCHIVED/PENDING are never deletable. */
export async function deleteModel(id: string, actor: string) {
  const stored = await prisma.financialModel.findUnique({ where: { id } });
  if (!stored) throw new AppError(404, 'NOT_FOUND', `Financial model ${id} not found.`);
  if (stored.status !== 'DRAFT') {
    throw new AppError(403, 'LOCKED', `Model "${stored.name}" is ${stored.status} — only DRAFT models can be deleted. Archive it instead.`);
  }
  const correlationId = newCorrelationId();
  await prisma.$transaction(async (tx) => {
    await writeAuditEvent(tx, {
      branchId: stored.branchId,
      actor,
      action: 'MODEL_DELETED',
      entityType: 'financial-model',
      entityId: stored.id,
      before: { name: stored.name, version: stored.version },
      reason: 'Draft model deleted',
      source: 'cms',
      correlationId,
    });
    await tx.financialModel.delete({ where: { id } });
  });
  return { id };
}

/** Month-table CSV export (audited at the route layer, like the Overview). */
export function modelExportCsv(detail: ModelDetail): string {
  const esc = (v: string | number | null): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    'month', 'opening_sqft', 'move_in_sqft', 'move_out_sqft', 'net_move_in_sqft',
    'closing_sqft', 'occupancy_pct', 'psf', 'revenue', 'opex_lease', 'opex_non_lease',
    'operating_cost', 'noi', 'noi_margin_pct', 'cash',
  ];
  const lines = [head.join(',')];
  for (const m of detail.projection.months) {
    lines.push(
      [m.month, m.openingSqft, m.moveInSqft, m.moveOutSqft, m.netMoveInSqft,
        m.closingSqft, m.occupancyPct, m.psf, m.revenue, m.opexLease, m.opexNonLease,
        m.operatingCost, m.noi, m.noiMarginPct ?? '', m.cash].map(esc).join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export function serializeMoney(n: number): number {
  return toNum(n);
}

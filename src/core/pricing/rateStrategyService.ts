// Master Rate Strategy — versioned strategy service + effective-dated batch
// apply (Track B, B3).
//
// Writes RateStrategy / RateStrategyVersion / UnitRateBatch /
// UnitRateBatchLine (schema: B2 migration 20261118000000). Reads inventory
// live from Units (R15), promotions read-only from Discount & Promotion, and
// the target from the branch's latest CURRENT FinancialModel (read-only,
// never a DRAFT, never a hard-coded fallback — preview returns the rack
// schedule with target/promo marked unavailable (noTarget) when none;
// submit still BLOCKS 409 until a CURRENT model exists).
//
// Server-is-authoritative: preview and apply call the same B1 pure engine
// (`previewFacility` / `baseMonthlyCents` / `finalizeRackCents`);
// the API never accepts a client-computed total. Money is integer cents in
// transit and Decimal(10,2) in storage; every mutation writes a
// FinanceAuditEvent + FinanceEvent in the same transaction (§18 types) and
// checks the optimistic-lock `version` via assertFreshVersion (409 STALE).
// Versions are immutable once submitted — enforced here, never in the DB.
//
// Copy contract (handoff §§15/19, quoted verbatim where the UI/tests need it):
//   'No facility sizes are linked yet.' · 'No strategies match these filters.'
//   'Warnings do not block approval. An authorised approver can accept a
//   warning with a note. Only red blockers prevent submission or approval.'

import { Prisma, type RateStrategy, type RateStrategyVersion } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { toNum } from '../../lib/format';
import { writeAuditEvent } from '../finance/audit';
import { publishFinanceEvent } from '../finance/events';
import { assertFreshVersion, nextVersion, newCorrelationId } from '../finance/idempotency';
import { currentBranchScope } from '../../lib/facilityScope';
import {
  DEFAULT_LEVERS,
  baseMonthlyCents,
  categoryForSize,
  finalizeRackCents,
  isBatchEligibleUnit,
  previewFacility,
  type DurationMonths,
  type PromotionPreviewInput,
  type SizeCategory,
  type StrategyLevers,
} from './rateStrategy';
import { project } from '../finance/projection';
import { planCoversBranch, toCanonicalSizeCategory } from '../promotionPlans';

// ---------------------------------------------------------------------------
// dates (R1: Asia/Singapore calendar day)
// ---------------------------------------------------------------------------

/** Today as YYYY-MM-DD on the Asia/Singapore calendar. */
export function todaySg(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Normalises a @db.Date (or date-like) to YYYY-MM-DD for comparison. */
export function dateKey(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function parseEffectiveDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AppError(400, 'VALIDATION', 'effectiveDate must be a YYYY-MM-DD date.');
  }
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new AppError(400, 'VALIDATION', 'effectiveDate must be a YYYY-MM-DD date.');
  return d;
}

// ---------------------------------------------------------------------------
// actor + scope
// ---------------------------------------------------------------------------

/** What the service needs from the CMS principal (built from adminOf(req)). */
export interface StrategyActor {
  email: string;
  isOwner: boolean;
  permissions: string[];
}

function canWriteUnits(actor: StrategyActor): boolean {
  return actor.isOwner || actor.permissions.includes('facility-units:update');
}

/** Out-of-scope rows read as not found (the Prisma extension already filters
 *  direct models; this is the explicit defence for parent-scoped reads). */
function assertInScope(branchId: string, scope: string[] | null): void {
  if (scope && !scope.includes(branchId)) {
    throw new AppError(404, 'NOT_FOUND', 'Rate strategy not found.');
  }
}

// ---------------------------------------------------------------------------
// lever inputs (routes pass partial; the service merges + validates)
// ---------------------------------------------------------------------------

export type RoundingIncrement = 1 | 5 | 10;

export interface LeverInput {
  referenceSize?: number;
  startingRate?: number;
  method?: 'SMOOTH' | 'STEP';
  curveStrength?: number;
  stepEvery?: number;
  stepPsf?: number;
  psfFloor?: number;
  minMonthly?: number;
  lockerAdj?: number;
  groundFloorAdj?: number;
  restrictedAdj?: number;
  facilityAdj?: number;
  rounding?: RoundingIncrement;
  categoryFloors?: Partial<Record<SizeCategory, number>>;
  sizeOverrides?: Array<{ size: number; monthlyRate: number; reason: string }>;
}

export interface PromotionPreviewSelection {
  durationMonths?: DurationMonths;
  /** 'Standard' | 'Ground floor' matrix column (handoff §15.13). */
  matrix?: string;
  planIds?: string[];
}

const SIZE_CATEGORIES: readonly SizeCategory[] = ['LOCKER', 'XS', 'S', 'M', 'L', 'XL'];

function isDurationMonths(n: unknown): n is DurationMonths {
  return n === 1 || n === 3 || n === 6 || n === 12;
}

function validateFullLevers(l: StrategyLevers): void {
  const fail = (message: string): never => {
    throw new AppError(400, 'VALIDATION', message);
  };
  if (!Number.isInteger(l.referenceSize) || l.referenceSize < 1) fail('referenceSize must be a whole sq ft, minimum 1.');
  if (!(l.startingRate > 0)) fail('startingRate (starting monthly rack rate) must be greater than zero.');
  if (l.method !== 'SMOOTH' && l.method !== 'STEP') fail("method must be 'SMOOTH' or 'STEP'.");
  if (!(l.curveStrength >= 0) || l.curveStrength > 1) fail('curveStrength must be between 0 and 1.');
  if (!Number.isInteger(l.stepEvery) || l.stepEvery < 1) fail('stepEvery must be a whole sq ft, minimum 1.');
  if (!(l.stepPsf >= 0)) fail('stepPsf must be zero or more.');
  if (!(l.psfFloor >= 0)) fail('psfFloor (overall rack PSF floor) must be zero or more.');
  if (!(l.minMonthly >= 0)) fail('minMonthly (minimum monthly rack rent) must be zero or more.');
  for (const [k, v] of [
    ['lockerAdj', l.lockerAdj],
    ['groundFloorAdj', l.groundFloorAdj],
    ['restrictedAdj', l.restrictedAdj],
  ] as const) {
    if (!(v >= -0.95) || !(v <= 1)) fail(`${k} must be between -95% and +100% (-0.95 to 1).`);
  }
  if (!(l.facilityAdj >= -0.5) || !(l.facilityAdj <= 1)) fail('facilityAdj must be between -50% and +100% (-0.5 to 1).');
  if (l.rounding !== 1 && l.rounding !== 5 && l.rounding !== 10) fail('rounding must be S$1, S$5 or S$10.');
  for (const c of SIZE_CATEGORIES) {
    const v = l.categoryFloors[c];
    if (v !== undefined && !(v >= 0)) fail(`categoryFloors.${c} must be zero or more.`);
  }
  for (const o of l.sizeOverrides) {
    if (!Number.isInteger(o.size) || o.size < 1) fail('sizeOverrides[].size must be a whole sq ft, minimum 1.');
    if (!(o.monthlyRate > 0)) fail(`Override for ${o.size} sq ft must be greater than zero.`);
    if (!o.reason.trim()) fail(`Override for ${o.size} sq ft needs a reason.`);
  }
}

function mergeLevers(base: StrategyLevers, patch: LeverInput | undefined): StrategyLevers {
  if (!patch) return { ...base, categoryFloors: { ...base.categoryFloors }, sizeOverrides: base.sizeOverrides.map((o) => ({ ...o })) };
  const merged: StrategyLevers = {
    referenceSize: patch.referenceSize ?? base.referenceSize,
    startingRate: patch.startingRate ?? base.startingRate,
    method: patch.method ?? base.method,
    curveStrength: patch.curveStrength ?? base.curveStrength,
    stepEvery: patch.stepEvery ?? base.stepEvery,
    stepPsf: patch.stepPsf ?? base.stepPsf,
    psfFloor: patch.psfFloor ?? base.psfFloor,
    minMonthly: patch.minMonthly ?? base.minMonthly,
    lockerAdj: patch.lockerAdj ?? base.lockerAdj,
    groundFloorAdj: patch.groundFloorAdj ?? base.groundFloorAdj,
    restrictedAdj: patch.restrictedAdj ?? base.restrictedAdj,
    facilityAdj: patch.facilityAdj ?? base.facilityAdj,
    rounding: patch.rounding ?? base.rounding,
    categoryFloors: { ...base.categoryFloors, ...(patch.categoryFloors ?? {}) },
    sizeOverrides: (patch.sizeOverrides ?? base.sizeOverrides).map((o) => ({ ...o })),
  };
  validateFullLevers(merged);
  return merged;
}

function defaultLevers(): StrategyLevers {
  return {
    referenceSize: DEFAULT_LEVERS.referenceSize,
    startingRate: DEFAULT_LEVERS.startingRate,
    method: DEFAULT_LEVERS.method,
    curveStrength: DEFAULT_LEVERS.curveStrength,
    stepEvery: DEFAULT_LEVERS.stepEvery,
    stepPsf: DEFAULT_LEVERS.stepPsf,
    psfFloor: DEFAULT_LEVERS.psfFloor,
    minMonthly: DEFAULT_LEVERS.minMonthly,
    lockerAdj: DEFAULT_LEVERS.lockerAdj,
    groundFloorAdj: DEFAULT_LEVERS.groundFloorAdj,
    restrictedAdj: DEFAULT_LEVERS.restrictedAdj,
    facilityAdj: DEFAULT_LEVERS.facilityAdj,
    rounding: DEFAULT_LEVERS.rounding,
    categoryFloors: { ...DEFAULT_LEVERS.categoryFloors },
    sizeOverrides: [],
  };
}

// ---------------------------------------------------------------------------
// row <-> levers + serialisation
// ---------------------------------------------------------------------------

type VersionWithStrategy = RateStrategyVersion & { strategy: RateStrategy };

function leversOf(v: {
  referenceSize: number; startingRate: Prisma.Decimal; method: string; curveStrength: Prisma.Decimal;
  stepEvery: number; stepPsf: Prisma.Decimal; psfFloor: Prisma.Decimal; minMonthly: Prisma.Decimal;
  lockerAdj: Prisma.Decimal; groundFloorAdj: Prisma.Decimal; restrictedAdj: Prisma.Decimal;
  facilityAdj: Prisma.Decimal; rounding: number; categoryFloors: unknown; sizeOverrides: unknown;
}): StrategyLevers {
  const levers: StrategyLevers = {
    referenceSize: v.referenceSize,
    startingRate: toNum(v.startingRate),
    method: v.method === 'STEP' ? 'STEP' : 'SMOOTH',
    // PSF/rate-factor columns are Decimal(10,4): keep 4dp (toNum defaults to
    // money 2dp, which would corrupt floors and adjustments).
    curveStrength: toNum(v.curveStrength, 4),
    stepEvery: v.stepEvery,
    stepPsf: toNum(v.stepPsf, 4),
    psfFloor: toNum(v.psfFloor, 4),
    minMonthly: toNum(v.minMonthly),
    lockerAdj: toNum(v.lockerAdj, 4),
    groundFloorAdj: toNum(v.groundFloorAdj, 4),
    restrictedAdj: toNum(v.restrictedAdj, 4),
    facilityAdj: toNum(v.facilityAdj, 4),
    rounding: (v.rounding === 5 || v.rounding === 10 ? v.rounding : 1) as RoundingIncrement,
    categoryFloors: (v.categoryFloors ?? {}) as StrategyLevers['categoryFloors'],
    sizeOverrides: (v.sizeOverrides ?? []) as StrategyLevers['sizeOverrides'],
  };
  return levers;
}

function serializeVersion(v: VersionWithStrategy, branchCode: string) {
  return {
    id: v.id,
    strategyId: v.strategyId,
    strategyName: v.strategy.name,
    branchId: v.strategy.branchId,
    branchCode,
    versionNo: v.versionNo,
    status: v.status,
    effectiveFrom: dateKey(v.effectiveFrom),
    levers: {
      ...leversOf(v),
      categoryFloors: (v.categoryFloors ?? {}) as Record<string, number>,
      sizeOverrides: (v.sizeOverrides ?? []) as Array<{ size: number; monthlyRate: number; reason: string }>,
    },
    previewSelection: (v.previewSelection ?? {}) as Record<string, unknown>,
    financialModel: v.financialModelId
      ? { id: v.financialModelId, version: v.financialModelVersion, targetPsf: v.targetPsf == null ? null : toNum(v.targetPsf, 4) }
      : null,
    targetPsf: v.targetPsf == null ? null : toNum(v.targetPsf, 4),
    validation: (v.validation ?? null) as Record<string, unknown> | null,
    warningOverride: (v.warningOverride ?? null) as Record<string, unknown> | null,
    submittedBy: v.submittedBy,
    submittedAt: v.submittedAt,
    approvedBy: v.approvedBy,
    approvedAt: v.approvedAt,
    rejectedBy: v.rejectedBy,
    rejectedAt: v.rejectedAt,
    rejectReason: v.rejectReason,
    originVersionId: v.originVersionId,
    version: v.version,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

export type SerializedVersion = ReturnType<typeof serializeVersion>;

// ---------------------------------------------------------------------------
// reads: strategy/version, inventory (R15), promotions (read-only), target
// ---------------------------------------------------------------------------

async function loadVersion(versionId: string, scope: string[] | null) {
  const v = await prisma.rateStrategyVersion.findUnique({
    where: { id: versionId },
    include: { strategy: true },
  });
  if (!v || (scope && !scope.includes(v.strategy.branchId))) {
    throw new AppError(404, 'NOT_FOUND', `Rate strategy version ${versionId} not found.`);
  }
  const branch = await prisma.branch.findUnique({ where: { id: v.strategy.branchId } });
  return { v, branchCode: branch?.code ?? v.strategy.branchId };
}

export interface InventoryUnit {
  id: string;
  unitCode: string;
  sizePoint: number;
  isLocker: boolean;
  isGroundFloor: boolean;
  isRestricted: boolean;
  status: string;
  rateSource: string;
  monthlyRate: number;
}

export interface BranchInventory {
  branch: { id: string; code: string };
  units: InventoryUnit[];
  stocked: Array<{ sizePoint: number; unitCount: number; isLocker: boolean }>;
  totalUnits: number;
  totalNla: number;
}

/** Live Units inventory (R15): Math.round(sqft), LOCKER code, lowest Floor.level, restrictedAccess. */
export async function inventoryOf(branchId: string): Promise<BranchInventory> {
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw new AppError(404, 'NOT_FOUND', `Branch ${branchId} not found.`);
  const [units, floors] = await Promise.all([
    prisma.unit.findMany({
      where: { branchId, deletedAt: null },
      include: { size: true, floor: true },
    }),
    prisma.floor.findMany({ where: { branchId, isActive: true }, select: { level: true } }),
  ]);
  const minLevel = floors.length ? Math.min(...floors.map((f) => f.level)) : null;
  const list: InventoryUnit[] = units.map((u) => ({
    id: u.id,
    unitCode: u.unitCode,
    sizePoint: Math.round(u.sqft),
    isLocker: u.size.code === 'LOCKER',
    isGroundFloor: minLevel != null && u.floor.level === minLevel,
    isRestricted: u.restrictedAccess,
    status: u.status,
    rateSource: u.rateSource,
    monthlyRate: toNum(u.monthlyRate),
  }));
  const bySize = new Map<number, { unitCount: number; isLocker: boolean }>();
  for (const u of list) {
    const prev = bySize.get(u.sizePoint);
    if (prev) {
      prev.unitCount += 1;
      prev.isLocker = prev.isLocker || u.isLocker;
    } else {
      bySize.set(u.sizePoint, { unitCount: 1, isLocker: u.isLocker });
    }
  }
  return {
    branch: { id: branch.id, code: branch.code },
    units: list,
    stocked: [...bySize.entries()].map(([sizePoint, s]) => ({ sizePoint, ...s })),
    totalUnits: list.length,
    totalNla: list.reduce((sum, u) => sum + u.sizePoint, 0),
  };
}

// Matrix size category (canonical) is resolved to the engine category inline
// in discountsForCells via MATRIX_OF_ENGINE.

// Engine category -> canonical matrix category for cell lookup.
const MATRIX_OF_ENGINE: Record<SizeCategory, string> = {
  LOCKER: 'LOCKER', XS: 'XS', S: 'SMALL', M: 'MEDIUM', L: 'LARGE', XL: 'XL',
};

// UnitSize.code -> engine category (for FREE_MONTHS sizeScope resolution).
function engineCategoryOfSizeCode(code: string): SizeCategory | null {
  const c = code.trim().toUpperCase();
  if (c === 'LOCKER') return 'LOCKER';
  if (c === 'XS') return 'XS';
  if (c === 'SMALL' || c === 'S') return 'S';
  if (c === 'MEDIUM' || c === 'M') return 'M';
  if (c === 'LARGE' || c === 'L') return 'L';
  if (c === 'XLBIZ' || c === 'XL' || c === 'XXL') return 'XL';
  return null;
}

export interface ResolvedPromotions {
  inputs: PromotionPreviewInput[];
  refs: Array<{ planId: string; planVersion: number; status: string; kind: string }>;
}

/**
 * Read-only promotion preview inputs (Discount & Promotion owns the records).
 * Default: every ACTIVE plan covering the branch. DRAFT / VALIDATED /
 * SCHEDULED plans are preview-only and resolve only when explicitly
 * selected; ENDED plans never resolve. PROMO_CODE / CREDITS kinds are not
 * recurring unit-rate analysis and are skipped.
 */
export async function promotionsOf(
  branch: { id: string; code: string },
  opts: {
    durationMonths: DurationMonths; matrix: string; planIds?: string[];
    branchSizePoints?: Array<{ sizePoint: number; isLocker: boolean }>;
  },
): Promise<ResolvedPromotions> {
  const explicit = [...new Set(opts.planIds ?? [])];
  const plans = await prisma.promotionPlan.findMany({
    where: explicit.length
      ? { id: { in: explicit } }
      : { status: 'ACTIVE' },
    include: { matrixCells: true },
  });
  if (explicit.length) {
    const missing = explicit.filter((id) => !plans.some((p) => p.id === id));
    if (missing.length) throw new AppError(404, 'NOT_FOUND', `Promotion plan(s) not found: ${missing.join(', ')}.`);
  }
  const inputs: PromotionPreviewInput[] = [];
  const refs: ResolvedPromotions['refs'] = [];
  for (const plan of plans) {
    if (plan.status === 'ENDED') {
      if (explicit.includes(plan.id)) throw new AppError(400, 'VALIDATION', `Promotion plan ${plan.name} has ended and cannot be previewed.`);
      continue;
    }
    if (!explicit.length && plan.status !== 'ACTIVE') continue;
    if (!planCoversBranch(plan.facilityScope, branch)) {
      if (explicit.includes(plan.id)) {
        throw new AppError(400, 'VALIDATION', `Promotion plan ${plan.name} does not cover facility ${branch.code}.`);
      }
      continue;
    }
    if (plan.kind === 'DISCOUNT_MATRIX') {
      inputs.push({
        planId: plan.id,
        planVersion: plan.version,
        status: plan.status,
        kind: 'PERCENTAGE',
        discountsBySize: discountsForCells(
          plan.matrixCells.map((c) => ({
            sizeCategory: c.sizeCategory,
            accessType: c.accessType,
            commitmentMonths: c.commitmentMonths,
            discountPct: toNum(c.discountPct),
          })),
          { durationMonths: opts.durationMonths, matrix: opts.matrix, branchSizePoints: opts.branchSizePoints },
        ),
        matrix: opts.matrix,
      });
      refs.push({ planId: plan.id, planVersion: plan.version, status: plan.status, kind: 'PERCENTAGE' });
    } else if (plan.kind === 'FREE_MONTHS') {
      const freeMonths = plan.freeMonthCount ?? 0;
      if (!(freeMonths > 0)) continue;
      inputs.push({
        planId: plan.id,
        planVersion: plan.version,
        status: plan.status,
        kind: 'FREE_MONTHS',
        freeMonths,
        eligibleCategories: await eligibleCategoriesOf(plan),
        commitmentMonths: plan.commitmentMonths ?? opts.durationMonths,
        matrix: opts.matrix,
      });
      refs.push({ planId: plan.id, planVersion: plan.version, status: plan.status, kind: 'FREE_MONTHS' });
    }
    // PROMO_CODE / CREDITS: visible only / excluded from recurring analysis.
  }
  return { inputs, refs };
}

interface MatrixCellLike {
  sizeCategory: string;
  accessType: string;
  commitmentMonths: number;
  discountPct: number;
}

function discountsForCells(
  cells: MatrixCellLike[],
  opts: { durationMonths: DurationMonths; matrix: string; branchSizePoints?: Array<{ sizePoint: number; isLocker: boolean }> },
): Record<number, number> {
  const points = opts.branchSizePoints ?? [];
  const out: Record<number, number> = {};
  for (const p of points) {
    const cat = categoryForSize(p.sizePoint, p.isLocker);
    const want = MATRIX_OF_ENGINE[cat];
    const cell = cells.find(
      (c) => c.accessType === opts.matrix && c.commitmentMonths === opts.durationMonths
        && (toCanonicalSizeCategory(c.sizeCategory) === want || (cat === 'XL' && toCanonicalSizeCategory(c.sizeCategory) === 'XXL')),
    );
    const d = cell ? cell.discountPct / 100 : 0;
    if (d > 0) out[p.sizePoint] = d;
  }
  return out;
}

async function eligibleCategoriesOf(plan: { sizeScope: unknown }): Promise<SizeCategory[] | undefined> {
  const scope = Array.isArray(plan.sizeScope) ? plan.sizeScope.map(String) : ['ALL'];
  if (scope.length === 0 || scope.some((s) => /^all$/i.test(s))) return undefined;
  const sizes = await prisma.unitSize.findMany({ where: { id: { in: scope } }, select: { code: true } });
  const cats = new Set<SizeCategory>();
  for (const s of sizes) {
    const c = engineCategoryOfSizeCode(s.code);
    if (c) cats.add(c);
  }
  return cats.size ? [...cats] : undefined;
}

export interface ResolvedTarget {
  modelId: string;
  modelVersion: number;
  targetPsf: number;
}

/** Latest CURRENT (approved) FinancialModel → recurring Effective PSF target. BLOCKING when none. */
export async function targetOf(branch: { id: string; code: string }): Promise<ResolvedTarget> {
  const m = await prisma.financialModel.findFirst({
    where: { branchId: branch.id, status: 'CURRENT' },
    orderBy: { updatedAt: 'desc' },
  });
  if (!m) {
    throw new AppError(
      409,
      'NO_CURRENT_MODEL',
      `No approved Financial Model target for facility ${branch.code} — approve a model before previewing a rate strategy.`,
      { branchId: branch.id, branchCode: branch.code },
    );
  }
  let targetPsf: number;
  try {
    targetPsf = project(m.inputs as unknown as Parameters<typeof project>[0]).kpis.weightedStartPsf;
  } catch {
    throw new AppError(
      409,
      'NO_CURRENT_MODEL',
      `The approved Financial Model for facility ${branch.code} no longer projects — restore a working version before previewing a rate strategy.`,
      { branchId: branch.id, branchCode: branch.code, modelId: m.id },
    );
  }
  return { modelId: m.id, modelVersion: m.version, targetPsf };
}

// ---------------------------------------------------------------------------
// draft CRUD
// ---------------------------------------------------------------------------

export interface CreateDraftInput {
  branchId: string;
  name: string;
  owner?: string;
  levers?: LeverInput;
  effectiveFrom?: string;
  promotionPreview?: PromotionPreviewSelection;
  actor: StrategyActor;
  correlationId?: string;
}

export async function createDraft(input: CreateDraftInput) {
  if (!input.name.trim()) throw new AppError(400, 'VALIDATION', 'A strategy name is required.');
  const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
  if (!branch) throw new AppError(404, 'NOT_FOUND', `Branch ${input.branchId} not found.`);
  const levers = mergeLevers(defaultLevers(), input.levers);
  const effectiveFrom = input.effectiveFrom ? parseEffectiveDate(input.effectiveFrom) : new Date(`${todaySg()}T00:00:00.000Z`);
  const selection = await resolveSelection(input.branchId, input.promotionPreview);
  const correlationId = input.correlationId ?? newCorrelationId();
  const created = await prisma.$transaction(async (tx) => {
    const strategy = await tx.rateStrategy.create({
      data: { branchId: branch.id, name: input.name.trim(), owner: input.owner?.trim() || input.actor.email },
    });
    const version = await tx.rateStrategyVersion.create({
      data: {
        strategyId: strategy.id,
        versionNo: 1,
        status: 'DRAFT',
        effectiveFrom,
        referenceSize: levers.referenceSize,
        startingRate: new Prisma.Decimal(levers.startingRate),
        method: levers.method,
        curveStrength: new Prisma.Decimal(levers.curveStrength),
        stepEvery: levers.stepEvery,
        stepPsf: new Prisma.Decimal(levers.stepPsf),
        psfFloor: new Prisma.Decimal(levers.psfFloor),
        minMonthly: new Prisma.Decimal(levers.minMonthly),
        lockerAdj: new Prisma.Decimal(levers.lockerAdj),
        groundFloorAdj: new Prisma.Decimal(levers.groundFloorAdj),
        restrictedAdj: new Prisma.Decimal(levers.restrictedAdj),
        facilityAdj: new Prisma.Decimal(levers.facilityAdj),
        rounding: levers.rounding,
        categoryFloors: levers.categoryFloors as unknown as Prisma.InputJsonValue,
        sizeOverrides: levers.sizeOverrides as unknown as Prisma.InputJsonValue,
        previewSelection: selection as unknown as Prisma.InputJsonValue,
        version: 0,
        createdBy: input.actor.email,
      },
    });
    await writeAuditEvent(tx, {
      branchId: branch.id, actor: input.actor.email, action: 'RATE_STRATEGY_CREATED',
      entityType: 'rate-strategy', entityId: version.id,
      after: { strategyId: strategy.id, versionNo: 1, status: 'DRAFT', name: strategy.name },
      reason: 'Draft created', source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'rate.strategy.created',
      payload: { strategyId: strategy.id, versionId: version.id, versionNo: 1 },
      branchId: branch.id, correlationId,
    });
    return { strategy, version };
  });
  const loaded = await loadVersion(created.version.id, null);
  return serializeVersion(loaded.v, loaded.branchCode);
}

export interface UpdateDraftInput {
  versionId: string;
  expectedVersion?: number;
  levers?: LeverInput;
  effectiveFrom?: string;
  promotionPreview?: PromotionPreviewSelection;
  actor: StrategyActor;
  correlationId?: string;
}

export async function updateDraft(input: UpdateDraftInput) {
  const scope = currentBranchScopeLazy();
  const { v, branchCode } = await loadVersion(input.versionId, scope);
  if (v.status !== 'DRAFT') {
    throw new AppError(
      409,
      'LOCKED',
      `Version ${v.versionNo} is ${v.status} — only DRAFT versions can be edited. Versions are immutable once submitted.`,
      { status: v.status, versionNo: v.versionNo },
    );
  }
  assertFreshVersion(v.version, input.expectedVersion, 'RateStrategyVersion');
  const levers = mergeLevers(leversOf(v), input.levers);
  const effectiveFrom = input.effectiveFrom ? parseEffectiveDate(input.effectiveFrom) : v.effectiveFrom;
  const selection = input.promotionPreview
    ? await resolveSelection(v.strategy.branchId, input.promotionPreview)
    : v.previewSelection;
  const before = { levers: leversOf(v), effectiveFrom: dateKey(v.effectiveFrom) };
  const correlationId = input.correlationId ?? newCorrelationId();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.rateStrategyVersion.update({
      where: { id: v.id },
      data: {
        referenceSize: levers.referenceSize,
        startingRate: new Prisma.Decimal(levers.startingRate),
        method: levers.method,
        curveStrength: new Prisma.Decimal(levers.curveStrength),
        stepEvery: levers.stepEvery,
        stepPsf: new Prisma.Decimal(levers.stepPsf),
        psfFloor: new Prisma.Decimal(levers.psfFloor),
        minMonthly: new Prisma.Decimal(levers.minMonthly),
        lockerAdj: new Prisma.Decimal(levers.lockerAdj),
        groundFloorAdj: new Prisma.Decimal(levers.groundFloorAdj),
        restrictedAdj: new Prisma.Decimal(levers.restrictedAdj),
        facilityAdj: new Prisma.Decimal(levers.facilityAdj),
        rounding: levers.rounding,
        categoryFloors: levers.categoryFloors as unknown as Prisma.InputJsonValue,
        sizeOverrides: levers.sizeOverrides as unknown as Prisma.InputJsonValue,
        previewSelection: selection as unknown as Prisma.InputJsonValue,
        effectiveFrom,
        // Any saved draft change invalidates prior validation (handoff §15.9).
        validation: Prisma.JsonNull,
        version: nextVersion(v.version),
      },
      include: { strategy: true },
    });
    await writeAuditEvent(tx, {
      branchId: u.strategy.branchId, actor: input.actor.email, action: 'RATE_STRATEGY_UPDATED',
      entityType: 'rate-strategy', entityId: u.id,
      before, after: { levers, effectiveFrom: dateKey(u.effectiveFrom) },
      reason: 'Draft updated', source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'rate.strategy.updated',
      payload: { versionId: u.id, versionNo: u.versionNo },
      branchId: u.strategy.branchId, correlationId,
    });
    return u;
  });
  return serializeVersion(updated, branchCode);
}

function currentBranchScopeLazy(): string[] | null {
  return currentBranchScope();
}

async function resolveSelection(branchId: string, input: PromotionPreviewSelection | undefined) {
  const durationMonths = input?.durationMonths ?? 12;
  if (!isDurationMonths(durationMonths)) throw new AppError(400, 'VALIDATION', 'durationMonths must be 1, 3, 6 or 12.');
  const matrix = input?.matrix ?? 'Standard';
  if (matrix !== 'Standard' && matrix !== 'Ground floor') {
    throw new AppError(400, 'VALIDATION', "matrix must be 'Standard' or 'Ground floor'.");
  }
  const branch = await prisma.branch.findUniqueOrThrow({ where: { id: branchId } });
  const inv = await inventoryOf(branchId);
  const { refs } = await promotionsOf(
    { id: branch.id, code: branch.code },
    {
      durationMonths,
      matrix,
      planIds: input?.planIds,
      branchSizePoints: inv.stocked,
    },
  );
  return { durationMonths, matrix, planRefs: refs };
}

// ---------------------------------------------------------------------------
// preview + validate (read-only; rack-only with noTarget when no CURRENT model)
// ---------------------------------------------------------------------------

export interface PreviewOpts {
  durationMonths?: DurationMonths;
  matrix?: string;
  planIds?: string[];
  /** Unsaved lever edits for the live workbench (B-4): merged over the
   *  saved levers, validated identically, never persisted. */
  levers?: LeverInput;
}

function selectionOf(v: VersionWithStrategy, opts: PreviewOpts): PromotionPreviewSelection {
  const stored = (v.previewSelection ?? {}) as { durationMonths?: unknown; matrix?: unknown; planRefs?: Array<{ planId: string }> };
  return {
    durationMonths: opts.durationMonths ?? (isDurationMonths(stored.durationMonths) ? stored.durationMonths : 12),
    matrix: opts.matrix ?? (typeof stored.matrix === 'string' ? stored.matrix : 'Standard'),
    planIds: opts.planIds ?? (Array.isArray(stored.planRefs) ? stored.planRefs.map((r) => r.planId) : []),
  };
}

async function buildPreview(versionId: string, opts: PreviewOpts, scope: string[] | null) {
  const { v } = await loadVersion(versionId, scope);
  const inv = await inventoryOf(v.strategy.branchId);
  const branch = { id: v.strategy.branchId, code: (await prisma.branch.findUniqueOrThrow({ where: { id: v.strategy.branchId } })).code };
  const sel = selectionOf(v, opts);
  if (!isDurationMonths(sel.durationMonths)) throw new AppError(400, 'VALIDATION', 'durationMonths must be 1, 3, 6 or 12.');
  if (sel.matrix !== 'Standard' && sel.matrix !== 'Ground floor') {
    throw new AppError(400, 'VALIDATION', "matrix must be 'Standard' or 'Ground floor'.");
  }
  // B-6: no CURRENT model must not block the rack schedule. Return rack-only
  // preview with target/promo marked unavailable (§19: label the target as
  // unavailable; keep rack-rate editing). Submit still blocks (see below).
  let target: ResolvedTarget | null = null;
  let noTarget = false;
  try {
    target = await targetOf(branch);
  } catch (e) {
    if (e instanceof AppError && (e as AppError).code === 'NO_CURRENT_MODEL') {
      noTarget = true;
    } else {
      throw e;
    }
  }
  const { inputs, refs } = noTarget
    ? { inputs: [] as PromotionPreviewInput[], refs: [] as Array<{ planId: string; planVersion: number; status: string; kind: string }> }
    : await promotionsOf(branch, {
      durationMonths: sel.durationMonths as DurationMonths,
      matrix: sel.matrix as string,
      planIds: sel.planIds,
      branchSizePoints: inv.stocked,
    });
  // B-4 live workbench: unsaved lever edits preview through the same pure
  // engine (server is the only calculator) without touching the draft.
  const levers = mergeLevers(leversOf(v), opts.levers);
  const preview = previewFacility({
    levers,
    inventory: inv.stocked,
    promotions: inputs,
    selectedDurationMonths: sel.durationMonths as DurationMonths,
    targetPsf: target ? target.targetPsf : null,
    matrix: sel.matrix,
  });
  return { v, inv, branch, target, noTarget, preview, selection: { durationMonths: sel.durationMonths, matrix: sel.matrix, planRefs: refs } };
}

export async function previewVersion(versionId: string, opts: PreviewOpts = {}) {
  const { preview, selection, target, noTarget, inv } = await buildPreview(versionId, opts, currentBranchScopeLazy());
  return {
    preview,
    previewSelection: selection,
    target,
    noTarget: noTarget === true ? true : undefined,
    targetUnavailable: noTarget === true ? true : undefined,
    inventory: { unitCount: inv.totalUnits, stockedSizeCount: inv.stocked.length, totalNla: inv.totalNla },
  };
}

/** B-4 live workbench: preview unsaved lever edits read-only. Merges the
 *  patch over the saved levers (same validation as PATCH), runs the same
 *  engine, persists nothing — no version bump, no audit event. The caller
 *  marks the workbench dirty; Save draft (PATCH) persists. */
export async function previewVersionWithLevers(versionId: string, levers: LeverInput | undefined, opts: PreviewOpts = {}) {
  const out = await previewVersion(versionId, { ...opts, levers });
  return { ...out, unsaved: true };
}

export async function validateVersion(versionId: string, opts: PreviewOpts = {}) {
  const { preview, target, noTarget } = await buildPreview(versionId, opts, currentBranchScopeLazy());
  return { blockers: preview.validation.blockers, warnings: preview.validation.warnings, passed: preview.validation.passed, target, noTarget: noTarget === true ? true : undefined };
}

// ---------------------------------------------------------------------------
// submit (with warning override) / approve / reject — maker-checker
// ---------------------------------------------------------------------------

export interface SubmitInput {
  versionId: string;
  expectedVersion?: number;
  warningOverride?: { reasons?: string[]; note?: string };
  changeNote?: string;
  actor: StrategyActor;
  correlationId?: string;
}

export async function submitVersion(input: SubmitInput) {
  const scope = currentBranchScopeLazy();
  const { v, branchCode } = await loadVersion(input.versionId, scope);
  if (v.status !== 'DRAFT') {
    throw new AppError(409, 'LOCKED', `Version ${v.versionNo} is ${v.status} — only DRAFT versions can be submitted.`, { status: v.status });
  }
  assertFreshVersion(v.version, input.expectedVersion, 'RateStrategyVersion');
  // D11: persist + reproduce — the submitted selection carries planId +
  // planVersion; the stored selection is re-resolved so refs are never stale.
  const built = await buildPreview(input.versionId, {}, scope);
  const target = built.target;
  if (built.noTarget || !target) {
    throw new AppError(
      409,
      'NO_CURRENT_MODEL',
      'No approved Financial Model target for this facility — approve a model before sending a rate strategy for approval. Rack editing and preview remain available.',
      { branchId: built.branch.id, branchCode: built.branch.code },
    );
  }
  const { blockers, warnings } = built.preview.validation;
  if (blockers.length) {
    throw new AppError(409, 'BLOCKED', `Version ${v.versionNo} has blockers: ${blockers.map((b) => b.message).join(' ')}`, {
      blockers: blockers.map((b) => b.code),
    });
  }
  const reasons = input.warningOverride?.reasons ?? [];
  if (warnings.length > 0) {
    const usable = reasons.filter((r) => typeof r === 'string' && r.trim().length > 0);
    if (usable.length < warnings.length) {
      throw new AppError(
        409,
        'WARNING_OVERRIDE_REQUIRED',
        `Warnings do not block approval. An authorised approver can accept a warning with a note. Only red blockers prevent submission or approval — ${warnings.length} warning(s) need a reason each.`,
        { warnings: warnings.map((w) => ({ code: w.code, message: w.message, reason: w.reason })) },
      );
    }
  }
  const correlationId = input.correlationId ?? newCorrelationId();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.rateStrategyVersion.update({
      where: { id: v.id },
      data: {
        status: 'PENDING_APPROVAL',
        financialModelId: target.modelId,
        financialModelVersion: target.modelVersion,
        targetPsf: new Prisma.Decimal(target.targetPsf),
        validation: built.preview.validation as unknown as Prisma.InputJsonValue,
        warningOverride: {
          warningCodes: warnings.map((w) => w.code),
          reasons: reasons.map((r) => r.trim()),
          note: input.warningOverride?.note?.trim() || input.changeNote?.trim() || null,
        } as unknown as Prisma.InputJsonValue,
        previewSelection: built.selection as unknown as Prisma.InputJsonValue,
        submittedBy: input.actor.email,
        submittedAt: new Date(),
        version: nextVersion(v.version),
      },
      include: { strategy: true },
    });
    await writeAuditEvent(tx, {
      branchId: u.strategy.branchId, actor: input.actor.email, action: 'RATE_STRATEGY_SUBMITTED',
      entityType: 'rate-strategy', entityId: u.id,
      before: { status: 'DRAFT', version: v.version },
      after: {
        status: 'PENDING_APPROVAL', version: u.version,
        validation: built.preview.validation, warningOverride: u.warningOverride,
        target, previewSelection: built.selection,
      },
      reason: input.changeNote?.trim() || 'Submitted for approval',
      source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'rate.strategy.submitted',
      payload: { versionId: u.id, versionNo: u.versionNo, warningCodes: warnings.map((w) => w.code) },
      branchId: u.strategy.branchId, correlationId,
    });
    return u;
  });
  return serializeVersion(updated, branchCode);
}

export interface DecideInput {
  versionId: string;
  expectedVersion?: number;
  comment?: string;
  reason?: string;
  actor: StrategyActor;
  correlationId?: string;
}

async function decideVersion(input: DecideInput, approve: boolean) {
  const scope = currentBranchScopeLazy();
  const { v, branchCode } = await loadVersion(input.versionId, scope);
  if (v.status !== 'PENDING_APPROVAL') {
    throw new AppError(
      approve ? 403 : 403,
      'LOCKED',
      `Version ${v.versionNo} is ${v.status} — only versions pending approval can be ${approve ? 'approved' : 'rejected'}.`,
      { status: v.status },
    );
  }
  assertFreshVersion(v.version, input.expectedVersion, 'RateStrategyVersion');
  // Maker-checker: the approver must differ from the submitter. Owner
  // single-step bypass is NOT offered here (brief D5 analog) — no
  // self-approval, audited either way.
  const submittedBy = v.submittedBy ?? 'unknown';
  if (input.actor.email.toLowerCase() === submittedBy.toLowerCase()) {
    throw new AppError(403, 'SELF_APPROVAL', 'You submitted this version — a different approver must decide it.', {
      submittedBy,
    });
  }
  if (!approve && !(input.reason ?? '').trim()) {
    throw new AppError(400, 'VALIDATION', 'A reason is required to reject a version.');
  }
  const correlationId = input.correlationId ?? newCorrelationId();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.rateStrategyVersion.update({
      where: { id: v.id },
      data: approve
        ? { status: 'APPROVED', approvedBy: input.actor.email, approvedAt: new Date(), version: nextVersion(v.version) }
        : {
            status: 'REJECTED', rejectedBy: input.actor.email, rejectedAt: new Date(),
            rejectReason: (input.reason ?? '').trim(), version: nextVersion(v.version),
          },
      include: { strategy: true },
    });
    if (approve) {
      // The newly approved version becomes current; other APPROVED versions
      // of the same strategy are superseded (approval freezes the snapshot).
      const others = await tx.rateStrategyVersion.findMany({
        where: { strategyId: v.strategyId, status: 'APPROVED', id: { not: v.id } },
      });
      for (const o of others) {
        await tx.rateStrategyVersion.update({ where: { id: o.id }, data: { status: 'SUPERSEDED' } });
        await writeAuditEvent(tx, {
          branchId: u.strategy.branchId, actor: input.actor.email, action: 'RATE_STRATEGY_SUPERSEDED',
          entityType: 'rate-strategy', entityId: o.id,
          before: { status: 'APPROVED' }, after: { status: 'SUPERSEDED', supersededBy: u.id },
          reason: `Superseded by approval of version ${u.versionNo}`, source: 'cms', correlationId,
        });
        await publishFinanceEvent(tx, {
          type: 'rate.strategy.superseded',
          payload: { versionId: o.id, supersededBy: u.id },
          branchId: u.strategy.branchId, correlationId,
        });
      }
      await tx.rateStrategy.update({ where: { id: v.strategyId }, data: { currentVersionId: u.id } });
    }
    await writeAuditEvent(tx, {
      branchId: u.strategy.branchId, actor: input.actor.email,
      action: approve ? 'RATE_STRATEGY_APPROVED' : 'RATE_STRATEGY_REJECTED',
      entityType: 'rate-strategy', entityId: u.id,
      before: { status: 'PENDING_APPROVAL', version: v.version, submittedBy },
      after: { status: u.status, version: u.version, decidedBy: input.actor.email },
      reason: (approve ? input.comment : input.reason)?.trim() || (approve ? 'Approved' : 'Rejected'),
      source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: approve ? 'rate.strategy.approved' : 'rate.strategy.rejected',
      payload: { versionId: u.id, versionNo: u.versionNo, decidedBy: input.actor.email },
      branchId: u.strategy.branchId, correlationId,
    });
    return u;
  });
  return serializeVersion(updated, branchCode);
}

export function approveVersion(input: DecideInput) {
  return decideVersion(input, true);
}

export function rejectVersion(input: DecideInput) {
  return decideVersion(input, false);
}

// ---------------------------------------------------------------------------
// library list/load
// ---------------------------------------------------------------------------

export interface LibraryFilter {
  branchId?: string;
  status?: string;
}

export async function listLibrary(filter: LibraryFilter = {}) {
  const strategies = await prisma.rateStrategy.findMany({
    where: { ...(filter.branchId ? { branchId: filter.branchId } : {}) },
    include: { versions: { orderBy: { versionNo: 'desc' } } },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  const branchIds = [...new Set(strategies.map((s) => s.branchId))];
  const branches = await prisma.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, code: true } });
  const codeOf = new Map(branches.map((b) => [b.id, b.code]));
  const cards = strategies.flatMap((s) =>
    s.versions
      .filter((ver) => !filter.status || ver.status === filter.status)
      .map((ver) => ({
        strategyId: s.id,
        strategyName: s.name,
        branchId: s.branchId,
        branchCode: codeOf.get(s.branchId) ?? s.branchId,
        versionId: ver.id,
        versionNo: ver.versionNo,
        status: ver.status,
        effectiveFrom: dateKey(ver.effectiveFrom),
        targetPsf: ver.targetPsf == null ? null : toNum(ver.targetPsf),
        owner: s.owner,
        currentVersion: s.currentVersionId === ver.id,
        updatedAt: ver.updatedAt,
      })),
  );
  return cards;
}

export async function loadVersionDetail(versionId: string) {
  const { v, branchCode } = await loadVersion(versionId, currentBranchScopeLazy());
  return serializeVersion(v, branchCode);
}

/** Read-only batch detail with per-unit lines (Units banner + history). */
export async function getBatch(batchId: string) {
  const b = await loadBatch(batchId, currentBranchScopeLazy());
  const units = await prisma.unit.findMany({ where: { id: { in: b.lines.map((l) => l.unitId) } }, select: { id: true, unitCode: true, rateSource: true } });
  return serializeBatch(b, b.lines, new Map(units.map((u) => [u.id, { unitCode: u.unitCode, rateSource: u.rateSource }])));
}

export interface BatchFilter {
  branchId?: string;
  status?: string;
  versionId?: string;
  limit?: number;
}

const BATCH_STATUSES = ['SCHEDULED', 'APPLYING', 'APPLIED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED'] as const;

/** Scheduler batch list (B4 CMS UI): per-batch outcome counts without the
 * full per-unit lines — detail stays on getBatch. Immediate-vs-scheduled
 * grouping is derived client-side from effectiveDate. */
export async function listBatches(filter: BatchFilter = {}) {
  const scope = currentBranchScopeLazy();
  const take = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const status = filter.status && (BATCH_STATUSES as readonly string[]).includes(filter.status)
    ? (filter.status as (typeof BATCH_STATUSES)[number])
    : undefined;
  const batches = await prisma.unitRateBatch.findMany({
    where: {
      ...(scope ? { branchId: { in: scope } } : {}),
      ...(filter.branchId ? { branchId: filter.branchId } : {}),
      ...(status ? { status } : {}),
      ...(filter.versionId ? { versionId: filter.versionId } : {}),
    },
    include: { lines: { select: { outcome: true } }, version: { select: { versionNo: true, strategy: { select: { name: true } } } } },
    orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
    take,
  });
  const branchIds = [...new Set(batches.map((b) => b.branchId))];
  const branches = await prisma.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, code: true } });
  const codeOf = new Map(branches.map((b) => [b.id, b.code]));
  return batches.map((b) => {
    const summary = { applied: 0, preservedManual: 0, skippedOccupied: 0, failed: 0, pending: 0 };
    for (const l of b.lines) {
      if (l.outcome === 'APPLIED') summary.applied += 1;
      else if (l.outcome === 'PRESERVED_MANUAL') summary.preservedManual += 1;
      else if (l.outcome === 'SKIPPED_OCCUPIED') summary.skippedOccupied += 1;
      else if (l.outcome === 'FAILED') summary.failed += 1;
      else summary.pending += 1;
    }
    return {
      id: b.id,
      ref: b.ref,
      versionId: b.versionId,
      versionNo: b.version.versionNo,
      strategyName: b.version.strategy.name,
      branchId: b.branchId,
      branchCode: codeOf.get(b.branchId) ?? b.branchId,
      effectiveDate: dateKey(b.effectiveDate),
      conflictRule: b.conflictRule,
      status: b.status,
      unitCount: b.unitCount,
      sizeCount: b.sizeCount,
      summary,
      createdBy: b.createdBy,
      appliedBy: b.appliedBy,
      appliedAt: b.appliedAt,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// duplicate (uplift on anchor, floors, minimum, category floors, overrides)
// ---------------------------------------------------------------------------

export interface DuplicateInput {
  versionId: string;
  destinationBranchId: string;
  name: string;
  /** Rate uplift percentage, default +5 (handoff §15.25). */
  upliftPct?: number;
  actor: StrategyActor;
  correlationId?: string;
}

export async function duplicateVersion(input: DuplicateInput) {
  const scope = currentBranchScopeLazy();
  const { v } = await loadVersion(input.versionId, scope);
  if (!input.name.trim()) throw new AppError(400, 'VALIDATION', 'A new strategy name is required to duplicate.');
  const upliftPct = input.upliftPct ?? 5;
  if (!Number.isFinite(upliftPct) || upliftPct < -50 || upliftPct > 100) {
    throw new AppError(400, 'VALIDATION', 'upliftPct must be between -50 and +100.');
  }
  const dest = await prisma.branch.findUnique({ where: { id: input.destinationBranchId } });
  if (!dest) throw new AppError(404, 'NOT_FOUND', `Branch ${input.destinationBranchId} not found.`);
  assertInScope(dest.id, scope);
  const factor = 1 + upliftPct / 100;
  // B-11: every uplifted money field lands on the S$0.05 grid (§15.22 floors
  // use S$0.05 steps). Half-up to the nearest nickel: 6.825 -> S$6.85
  // (6.825 * 20 = 136.5 -> 137 / 20). The trailing cents rounding only
  // cleans IEEE754 residue (6.849999... -> 6.85).
  const upliftNickel = (n: number): number => Math.round(Math.round(n * factor * 20) / 20 * 100) / 100;
  const src = leversOf(v);
  const levers: StrategyLevers = {
    ...src,
    startingRate: upliftNickel(src.startingRate),
    psfFloor: upliftNickel(src.psfFloor),
    minMonthly: upliftNickel(src.minMonthly),
    categoryFloors: Object.fromEntries(
      Object.entries(src.categoryFloors).map(([k, val]) => [k, upliftNickel(val as number)]),
    ) as StrategyLevers['categoryFloors'],
    sizeOverrides: src.sizeOverrides.map((o) => ({ ...o, monthlyRate: upliftNickel(o.monthlyRate) })),
  };
  validateFullLevers(levers);
  // The destination facility re-links to its own Units inventory; the
  // promotion selection is carried for reference (re-resolved at preview).
  const stored = (v.previewSelection ?? {}) as { durationMonths?: unknown; matrix?: unknown; planRefs?: Array<{ planId: string }> };
  const correlationId = input.correlationId ?? newCorrelationId();
  const created = await prisma.$transaction(async (tx) => {
    const strategy = await tx.rateStrategy.create({
      data: { branchId: dest.id, name: input.name.trim(), owner: input.actor.email },
    });
    const version = await tx.rateStrategyVersion.create({
      data: {
        strategyId: strategy.id,
        versionNo: 1,
        status: 'DRAFT',
        effectiveFrom: new Date(`${todaySg()}T00:00:00.000Z`),
        referenceSize: levers.referenceSize,
        startingRate: new Prisma.Decimal(levers.startingRate),
        method: levers.method,
        curveStrength: new Prisma.Decimal(levers.curveStrength),
        stepEvery: levers.stepEvery,
        stepPsf: new Prisma.Decimal(levers.stepPsf),
        psfFloor: new Prisma.Decimal(levers.psfFloor),
        minMonthly: new Prisma.Decimal(levers.minMonthly),
        lockerAdj: new Prisma.Decimal(levers.lockerAdj),
        groundFloorAdj: new Prisma.Decimal(levers.groundFloorAdj),
        restrictedAdj: new Prisma.Decimal(levers.restrictedAdj),
        facilityAdj: new Prisma.Decimal(levers.facilityAdj),
        rounding: levers.rounding,
        categoryFloors: levers.categoryFloors as unknown as Prisma.InputJsonValue,
        sizeOverrides: levers.sizeOverrides as unknown as Prisma.InputJsonValue,
        previewSelection: {
          durationMonths: stored.durationMonths ?? 12,
          matrix: stored.matrix ?? 'Standard',
          planRefs: [],
        } as unknown as Prisma.InputJsonValue,
        originVersionId: v.id,
        version: 0,
        createdBy: input.actor.email,
      },
    });
    await writeAuditEvent(tx, {
      branchId: dest.id, actor: input.actor.email, action: 'RATE_STRATEGY_DUPLICATED',
      entityType: 'rate-strategy', entityId: version.id,
      after: {
        strategyId: strategy.id, originVersionId: v.id, upliftPct,
        from: { strategyId: v.strategyId, versionNo: v.versionNo, branchId: v.strategy.branchId },
      },
      reason: `Duplicated for facility ${dest.code} with ${upliftPct}% uplift`,
      source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'rate.strategy.duplicated',
      payload: { versionId: version.id, originVersionId: v.id, upliftPct },
      branchId: dest.id, correlationId,
    });
    return { strategy, version };
  });
  const loaded = await loadVersion(created.version.id, null);
  return serializeVersion(loaded.v, dest.code);
}

// ---------------------------------------------------------------------------
// batches: create / apply / retry-failed / cancel + applyDueBatches (D10)
// ---------------------------------------------------------------------------

export type ConflictRule = 'PRESERVE_MANUAL' | 'REPLACE_MANUAL' | 'CANCEL_IF_MANUAL';

export interface CreateBatchInput {
  versionId: string;
  effectiveDate: string;
  conflictRule?: ConflictRule;
  idempotencyKey?: string;
  actor: StrategyActor;
  correlationId?: string;
}

function serializeBatch(
  b: {
    id: string; ref: string; versionId: string; branchId: string; effectiveDate: Date | string;
    conflictRule: string; status: string; unitCount: number; sizeCount: number;
    idempotencyKey: string; createdBy: string; appliedBy: string | null; appliedAt: Date | null;
    createdAt: Date; updatedAt: Date;
  },
  lines: Array<{
    id: string; unitId: string; sizePoint: number; previousRack: Prisma.Decimal; proposedRack: Prisma.Decimal;
    outcome: string; conflictReason: string | null; appliedAt: Date | null;
  }>,
  // Live Unit identity + provenance (R16): the apply preview lists LEGACY
  // units separately from MANUAL ones, before anything is written as well
  // as after. rateSource is read live at serialize time — a SCHEDULED
  // batch shows the current split; post-apply, `legacyUnits` (below) stays
  // the apply-time record.
  unitsById: Map<string, { unitCode: string; rateSource: string }>,
  extra?: { replayed?: boolean; legacyUnits?: string[] },
) {
  const counts = { APPLIED: 0, PRESERVED_MANUAL: 0, SKIPPED_OCCUPIED: 0, FAILED: 0, PENDING: 0 };
  for (const l of lines) {
    if (l.outcome in counts) counts[l.outcome as keyof typeof counts] += 1;
  }
  return {
    id: b.id,
    ref: b.ref,
    versionId: b.versionId,
    branchId: b.branchId,
    effectiveDate: dateKey(b.effectiveDate),
    conflictRule: b.conflictRule,
    status: b.status,
    unitCount: b.unitCount,
    sizeCount: b.sizeCount,
    idempotencyKey: b.idempotencyKey,
    createdBy: b.createdBy,
    appliedBy: b.appliedBy,
    appliedAt: b.appliedAt,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    summary: {
      applied: counts.APPLIED,
      preservedManual: counts.PRESERVED_MANUAL,
      skippedOccupied: counts.SKIPPED_OCCUPIED,
      failed: counts.FAILED,
      pending: counts.PENDING,
    },
    ...(extra?.legacyUnits ? { legacyUnits: extra.legacyUnits } : {}),
    ...(extra?.replayed ? { replayed: true } : {}),
    lines: lines.map((l) => {
      const u = unitsById.get(l.unitId);
      return {
        id: l.id,
        unitId: l.unitId,
        unitCode: u?.unitCode ?? l.unitId,
        sizePoint: l.sizePoint,
        previousRack: toNum(l.previousRack),
        proposedRack: toNum(l.proposedRack),
        outcome: l.outcome,
        conflictReason: l.conflictReason,
        appliedAt: l.appliedAt,
        rateSource: u?.rateSource ?? 'LEGACY',
      };
    }),
  };
}

async function loadBatch(batchId: string, scope: string[] | null) {
  const b = await prisma.unitRateBatch.findUnique({ where: { id: batchId }, include: { lines: true, version: true } });
  if (!b || (scope && !scope.includes(b.branchId))) {
    throw new AppError(404, 'NOT_FOUND', `Rate batch ${batchId} not found.`);
  }
  return b;
}

/** Server-minted human ref (RATE-<timestamp>, never browser-built). */
async function mintBatchRef(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    const ref = `RATE-${stamp}${suffix}${rand ? `-${rand}` : ''}`;
    const exists = await prisma.unitRateBatch.findUnique({ where: { ref } });
    if (!exists) return ref;
  }
  return `RATE-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * Per-unit proposed rack (cents) from the frozen version levers + the unit's
 * own attributes. §15.9 order: (override or generated) base → attribute
 * adjustments → minimum monthly rent → increment rounding. An override
 * replaces the generated base only; attributes, minimum and rounding still
 * apply exactly as for a generated size.
 */
function proposedCentsFor(levers: StrategyLevers, sizePoint: number, u: { isLocker: boolean; isGroundFloor: boolean; isRestricted: boolean }): number {
  const override = levers.sizeOverrides.find((o) => o.size === sizePoint);
  const base = override ? Math.round(override.monthlyRate * 100) : baseMonthlyCents(sizePoint, u.isLocker, levers);
  return finalizeRackCents(
    base,
    { isLocker: u.isLocker, isGroundFloor: u.isGroundFloor, isRestricted: u.isRestricted },
    levers,
  );
}

interface ComputedLine {
  unitId: string;
  unitCode: string;
  sizePoint: number;
  previousRack: number;
  proposedRack: number;
}

async function computeBatchLines(versionId: string, strategyBranchId: string): Promise<{ levers: StrategyLevers; lines: ComputedLine[]; unitsById: Map<string, { unitCode: string; rateSource: string }> }> {
  const ver = await prisma.rateStrategyVersion.findUniqueOrThrow({ where: { id: versionId } });
  const levers = leversOf(ver);
  const inv = await inventoryOf(strategyBranchId);
  const lines: ComputedLine[] = inv.units.map((u) => ({
    unitId: u.id,
    unitCode: u.unitCode,
    sizePoint: u.sizePoint,
    previousRack: u.monthlyRate,
    proposedRack: proposedCentsFor(levers, u.sizePoint, u) / 100,
  }));
  return { levers, lines, unitsById: new Map(inv.units.map((u) => [u.id, { unitCode: u.unitCode, rateSource: u.rateSource }])) };
}

export async function createBatch(input: CreateBatchInput) {
  const scope = currentBranchScopeLazy();
  const { v } = await loadVersion(input.versionId, scope);
  if (v.status !== 'APPROVED' && v.status !== 'ACTIVE') {
    throw new AppError(
      409,
      'NOT_APPROVED',
      `Only Approved or Active strategies are eligible for Units application — version ${v.versionNo} is ${v.status}.`,
      { status: v.status },
    );
  }
  const rule: ConflictRule = input.conflictRule ?? 'PRESERVE_MANUAL';
  if (rule !== 'PRESERVE_MANUAL' && rule !== 'REPLACE_MANUAL' && rule !== 'CANCEL_IF_MANUAL') {
    throw new AppError(400, 'VALIDATION', 'conflictRule must be PRESERVE_MANUAL, REPLACE_MANUAL or CANCEL_IF_MANUAL.');
  }
  if (rule === 'REPLACE_MANUAL' && !input.actor.isOwner) {
    // D9: Replace manual rates requires Owner.
    throw new AppError(403, 'FORBIDDEN', 'Replace manual rates requires the Owner role.');
  }
  const effectiveDate = parseEffectiveDate(input.effectiveDate);
  const idempotencyKey = input.idempotencyKey?.trim() || newCorrelationId();
  const existing = await prisma.unitRateBatch.findUnique({ where: { idempotencyKey }, include: { lines: true } });
  if (existing) {
    if (scope && !scope.includes(existing.branchId)) throw new AppError(404, 'NOT_FOUND', 'Rate batch not found.');
    const units = await prisma.unit.findMany({ where: { id: { in: existing.lines.map((l) => l.unitId) } }, select: { id: true, unitCode: true, rateSource: true } });
    return serializeBatch(existing, existing.lines, new Map(units.map((u) => [u.id, { unitCode: u.unitCode, rateSource: u.rateSource }])), { replayed: true });
  }
  const computed = await computeBatchLines(v.id, v.strategy.branchId);
  const sizeCount = new Set(computed.lines.map((l) => l.sizePoint)).size;
  const correlationId = input.correlationId ?? newCorrelationId();
  const ref = await mintBatchRef();
  const due = dateKey(effectiveDate) <= todaySg();
  const created = await prisma.$transaction(async (tx) => {
    const b = await tx.unitRateBatch.create({
      data: {
        ref,
        versionId: v.id,
        branchId: v.strategy.branchId,
        effectiveDate,
        conflictRule: rule,
        status: 'SCHEDULED',
        unitCount: computed.lines.length,
        sizeCount,
        idempotencyKey,
        createdBy: input.actor.email,
      },
    });
    await tx.unitRateBatchLine.createMany({
      data: computed.lines.map((l) => ({
        batchId: b.id,
        unitId: l.unitId,
        sizePoint: l.sizePoint,
        previousRack: new Prisma.Decimal(l.previousRack),
        proposedRack: new Prisma.Decimal(l.proposedRack),
        outcome: 'PENDING',
      })),
    });
    await writeAuditEvent(tx, {
      branchId: v.strategy.branchId, actor: input.actor.email, action: 'RATE_BATCH_CREATED',
      entityType: 'rate-batch', entityId: b.id,
      after: { ref, versionId: v.id, effectiveDate: dateKey(effectiveDate), conflictRule: rule, unitCount: computed.lines.length, sizeCount },
      reason: `Batch ${ref} scheduled`,
      source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'rate.batch.created',
      payload: { batchId: b.id, ref, versionId: v.id, effectiveDate: dateKey(effectiveDate), conflictRule: rule },
      branchId: v.strategy.branchId, correlationId,
    });
    return b;
  });
  // R17: a batch dated today or earlier applies immediately; a future-dated
  // batch waits as Scheduled until applyDueBatches() runs (D10).
  if (due) {
    return applyBatch({ batchId: created.id, actor: input.actor, correlationId });
  }
  const lines = await prisma.unitRateBatchLine.findMany({ where: { batchId: created.id } });
  return serializeBatch({ ...created, status: 'SCHEDULED' }, lines, computed.unitsById);
}

export interface ApplyBatchInput {
  batchId: string;
  actor: StrategyActor;
  correlationId?: string;
  viaRetry?: boolean;
}

export async function applyBatch(input: ApplyBatchInput) {
  const scope = currentBranchScopeLazy();
  if (!canWriteUnits(input.actor)) {
    throw new AppError(403, 'FORBIDDEN', "Applying a rate batch writes unit rates — it needs the facility-units:update permission.");
  }
  const b = await loadBatch(input.batchId, scope);
  if (b.status === 'CANCELLED') {
    throw new AppError(409, 'LOCKED', `Batch ${b.ref} is cancelled and cannot be applied.`);
  }
  if (b.conflictRule === 'REPLACE_MANUAL' && !input.actor.isOwner) {
    // D9: enforced at create and re-checked at apply.
    throw new AppError(403, 'FORBIDDEN', 'Replace manual rates requires the Owner role.');
  }
  if (b.status === 'APPLIED') {
    // Idempotent replay: the first result is returned unchanged.
    const units = await prisma.unit.findMany({ where: { id: { in: b.lines.map((l) => l.unitId) } }, select: { id: true, unitCode: true, rateSource: true } });
    return serializeBatch(b, b.lines, new Map(units.map((u) => [u.id, { unitCode: u.unitCode, rateSource: u.rateSource }])), { replayed: true });
  }
  if (dateKey(b.effectiveDate) > todaySg()) {
    throw new AppError(409, 'NOT_DUE', `Batch ${b.ref} takes effect ${dateKey(b.effectiveDate)} — it cannot be applied before its effective date.`, {
      effectiveDate: dateKey(b.effectiveDate),
    });
  }
  const correlationId = input.correlationId ?? newCorrelationId();
  const version = await prisma.rateStrategyVersion.findUniqueOrThrow({ where: { id: b.versionId }, include: { strategy: true } });
  // Handoff §27 + §15.25: only Approved or Active versions update Units. A
  // version superseded (or rejected) after its batch was scheduled must not
  // apply stale rates — not via apply, retry, or the due-batch sweep.
  if (version.status !== 'APPROVED' && version.status !== 'ACTIVE') {
    throw new AppError(
      409,
      'NOT_APPROVED',
      `Only Approved or Active strategies are eligible for Units application — version ${version.versionNo} is ${version.status}.`,
      { status: version.status, batchStatus: b.status },
    );
  }
  const levers = leversOf(version);
  const inv = await inventoryOf(b.branchId);
  const liveById = new Map(inv.units.map((u) => [u.id, u]));

  // Phase 1 (read-only): decide every line outcome. CANCEL_IF_MANUAL aborts
  // the whole batch before any write.
  type Decision =
    | { kind: 'APPLY'; previousRack: number; proposedRack: number }
    | { kind: 'PRESERVED_MANUAL' }
    | { kind: 'SKIPPED_OCCUPIED'; status: string }
    | { kind: 'FAILED'; reason: string };
  const decisions = new Map<string, Decision>();
  let manualCount = 0;
  for (const line of b.lines) {
    const u = liveById.get(line.unitId);
    if (!u) {
      decisions.set(line.id, { kind: 'FAILED', reason: 'Unit no longer exists or was deleted.' });
      continue;
    }
    const proposed = proposedCentsFor(levers, u.sizePoint, u) / 100;
    if (!isBatchEligibleUnit(u.status)) {
      decisions.set(line.id, { kind: 'SKIPPED_OCCUPIED', status: u.status });
      continue;
    }
    if (u.rateSource === 'MANUAL') {
      manualCount += 1;
      if (b.conflictRule === 'PRESERVE_MANUAL') {
        decisions.set(line.id, { kind: 'PRESERVED_MANUAL' });
        continue;
      }
      if (b.conflictRule === 'CANCEL_IF_MANUAL') continue; // counted; batch cancels below
      // REPLACE_MANUAL (Owner-checked above) falls through to APPLY.
    }
    decisions.set(line.id, { kind: 'APPLY', previousRack: u.monthlyRate, proposedRack: proposed });
  }
  if (b.conflictRule === 'CANCEL_IF_MANUAL' && manualCount > 0) {
    const cancelled = await prisma.$transaction(async (tx) => {
      const c = await tx.unitRateBatch.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
      await writeAuditEvent(tx, {
        branchId: b.branchId, actor: input.actor.email, action: 'RATE_BATCH_CANCELLED',
        entityType: 'rate-batch', entityId: b.id,
        before: { status: b.status }, after: { status: 'CANCELLED' },
        reason: `${manualCount} manual-rate unit(s) block this batch (Cancel-if-manual rule).`,
        source: 'cms', correlationId,
      });
      await publishFinanceEvent(tx, {
        type: 'rate.batch.cancelled',
        payload: { batchId: b.id, ref: b.ref, reason: 'CANCEL_IF_MANUAL', manualCount },
        branchId: b.branchId, correlationId,
      });
      return c;
    });
    const lines = await prisma.unitRateBatchLine.findMany({ where: { batchId: b.id } });
    const units = await prisma.unit.findMany({ where: { id: { in: lines.map((l) => l.unitId) } }, select: { id: true, unitCode: true, rateSource: true } });
    const unitsById = new Map(units.map((u) => [u.id, { unitCode: u.unitCode, rateSource: u.rateSource }]));
    const cancelledBatch = serializeBatch({ ...b, status: cancelled.status }, lines, unitsById);
    throw Object.assign(
      // details.batch carries the cancelled batch body: the HTTP envelope
      // drops custom error props, so UI-called routes would otherwise lose it.
      new AppError(409, 'MANUAL_RATES_EXIST', `${manualCount} manual-rate unit(s) block batch ${b.ref} (Cancel-if-manual rule) — the batch was cancelled.`, {
        manualCount, batchStatus: cancelled.status, batch: cancelledBatch,
      }),
      { cancelledBatch },
    );
  }

  // Phase 2 (ONE transaction): write Units + RateChange rows + line outcomes.
  // Tenant.monthlyRate is NEVER touched (R17) — this path deliberately does
  // NOT reuse adjustRate()'s tenant write, only its Unit + RateChange shape.
  const result = await prisma.$transaction(async (tx) => {
    await tx.unitRateBatch.update({ where: { id: b.id }, data: { status: 'APPLYING' } });
    let applied = 0;
    let failed = 0;
    const legacyUnits: string[] = [];
    const preservedUnits: string[] = [];
    for (const line of b.lines) {
      // APPLIED lines stay final — replay/apply never rewrites them.
      if (line.outcome === 'APPLIED') {
        applied += 1;
        continue;
      }
      const d = decisions.get(line.id);
      if (!d || d.kind === 'APPLY') {
        const u = liveById.get(line.unitId);
        if (!u || !d || d.kind !== 'APPLY') {
          const reason = !u ? 'Unit no longer exists or was deleted.' : 'No decision computed for this line.';
          await tx.unitRateBatchLine.update({
            where: { id: line.id },
            data: { outcome: 'FAILED', conflictReason: reason },
          });
          failed += 1;
          continue;
        }
        try {
          const previous = Math.round(d.previousRack * 100) / 100;
          const current = Math.round(d.proposedRack * 100) / 100;
          const pct = previous ? Math.round(((current - previous) / previous) * 1000) / 10 : 0;
          await tx.unit.update({
            where: { id: u.id },
            data: { monthlyRate: new Prisma.Decimal(current), rateSource: 'STRATEGY' },
          });
          await tx.rateChange.create({
            data: {
              unitId: u.id,
              date: new Date(),
              previous: new Prisma.Decimal(previous),
              current: new Prisma.Decimal(current),
              changePct: pct,
              reason: `Rate strategy ${version.strategy.name} v${version.versionNo} (${b.ref})`,
              appliedBy: input.actor.email,
            },
          });
          await tx.unitRateBatchLine.update({
            where: { id: line.id },
            data: {
              outcome: 'APPLIED',
              previousRack: new Prisma.Decimal(previous),
              proposedRack: new Prisma.Decimal(current),
              conflictReason: null,
              appliedAt: new Date(),
            },
          });
          applied += 1;
          if (u.rateSource === 'LEGACY') legacyUnits.push(u.unitCode);
        } catch (e) {
          await tx.unitRateBatchLine.update({
            where: { id: line.id },
            data: { outcome: 'FAILED', conflictReason: e instanceof Error ? e.message : 'Apply failed.' },
          });
          failed += 1;
        }
      } else if (d.kind === 'PRESERVED_MANUAL') {
        await tx.unitRateBatchLine.update({
          where: { id: line.id },
          data: { outcome: 'PRESERVED_MANUAL', conflictReason: 'Manual rate preserved (operator-set).' },
        });
        preservedUnits.push(liveById.get(line.unitId)?.unitCode ?? line.unitId);
      } else if (d.kind === 'SKIPPED_OCCUPIED') {
        await tx.unitRateBatchLine.update({
          where: { id: line.id },
          data: { outcome: 'SKIPPED_OCCUPIED', conflictReason: `Unit status is ${d.status} — only AVAILABLE units take strategy rates.` },
        });
      } else {
        await tx.unitRateBatchLine.update({
          where: { id: line.id },
          data: { outcome: 'FAILED', conflictReason: d.reason },
        });
        failed += 1;
      }
    }
    const status = failed > 0 ? (applied > 0 ? 'PARTIALLY_FAILED' : 'FAILED') : 'APPLIED';
    const done = await tx.unitRateBatch.update({
      where: { id: b.id },
      data: { status, appliedBy: input.actor.email, appliedAt: new Date() },
      include: { lines: true },
    });
    await writeAuditEvent(tx, {
      branchId: b.branchId, actor: input.actor.email,
      action: input.viaRetry ? 'RATE_BATCH_RETRIED' : 'RATE_BATCH_APPLIED',
      entityType: 'rate-batch', entityId: b.id,
      before: { status: b.status },
      after: { status, applied, failed, ref: b.ref },
      reason: input.viaRetry ? `Retry of failed lines for batch ${b.ref}` : `Batch ${b.ref} applied`,
      source: 'cms', correlationId,
    });
    const terminalType = status === 'APPLIED' ? 'rate.batch.applied' : status === 'PARTIALLY_FAILED' ? 'rate.batch.partially_applied' : 'rate.batch.failed';
    await publishFinanceEvent(tx, {
      type: input.viaRetry ? 'rate.batch.retried' : terminalType,
      payload: { batchId: b.id, ref: b.ref, status, applied, failed, legacyUnits, preservedUnits },
      branchId: b.branchId, correlationId,
    });
    if (preservedUnits.length > 0) {
      await publishFinanceEvent(tx, {
        type: 'rate.unit.preserved_manual',
        payload: { batchId: b.id, ref: b.ref, unitCodes: preservedUnits },
        branchId: b.branchId, correlationId,
      });
    }
    return { done, legacyUnits };
  });
  const units = await prisma.unit.findMany({ where: { id: { in: result.done.lines.map((l) => l.unitId) } }, select: { id: true, unitCode: true, rateSource: true } });
  return serializeBatch(result.done, result.done.lines, new Map(units.map((u) => [u.id, { unitCode: u.unitCode, rateSource: u.rateSource }])), {
    ...(input.viaRetry ? {} : {}),
    legacyUnits: result.legacyUnits,
  });
}

export interface CancelBatchInput {
  batchId: string;
  reason: string;
  actor: StrategyActor;
  correlationId?: string;
}

export async function cancelBatch(input: CancelBatchInput) {
  const scope = currentBranchScopeLazy();
  const b = await loadBatch(input.batchId, scope);
  if (!['SCHEDULED', 'APPLYING', 'FAILED', 'PARTIALLY_FAILED'].includes(b.status)) {
    throw new AppError(409, 'LOCKED', `Batch ${b.ref} is ${b.status} — only scheduled or failed batches can be cancelled.`);
  }
  if (!input.reason.trim()) throw new AppError(400, 'VALIDATION', 'A reason is required to cancel a batch.');
  const correlationId = input.correlationId ?? newCorrelationId();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.unitRateBatch.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
    await writeAuditEvent(tx, {
      branchId: b.branchId, actor: input.actor.email, action: 'RATE_BATCH_CANCELLED',
      entityType: 'rate-batch', entityId: b.id,
      before: { status: b.status }, after: { status: 'CANCELLED' },
      reason: input.reason.trim(), source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'rate.batch.cancelled',
      payload: { batchId: b.id, ref: b.ref, reason: input.reason.trim() },
      branchId: b.branchId, correlationId,
    });
    return u;
  });
  const units = await prisma.unit.findMany({ where: { id: { in: b.lines.map((l) => l.unitId) } }, select: { id: true, unitCode: true, rateSource: true } });
  return serializeBatch({ ...b, status: updated.status }, b.lines, new Map(units.map((u) => [u.id, { unitCode: u.unitCode, rateSource: u.rateSource }])));
}

export async function retryFailedBatch(input: ApplyBatchInput) {
  const scope = currentBranchScopeLazy();
  const b = await loadBatch(input.batchId, scope);
  if (b.status !== 'FAILED' && b.status !== 'PARTIALLY_FAILED') {
    throw new AppError(409, 'LOCKED', `Batch ${b.ref} is ${b.status} — only failed batches can be retried (applied batches replay via apply).`);
  }
  return applyBatch({ ...input, viaRetry: true });
}

/**
 * Applies every SCHEDULED batch whose effective date has arrived (D10 —
 * no scheduler on Lambda, so the Units banner calls this). Idempotent and
 * safe to repeat: non-due and terminal batches are never touched.
 */
export async function applyDueBatches(actor: StrategyActor, correlationId?: string) {
  if (!canWriteUnits(actor)) {
    throw new AppError(403, 'FORBIDDEN', "Applying rate batches writes unit rates — it needs the facility-units:update permission.");
  }
  const scope = currentBranchScopeLazy();
  const due = await prisma.unitRateBatch.findMany({
    where: { status: 'SCHEDULED', ...(scope ? { branchId: { in: scope } } : {}) },
    include: { lines: true },
    orderBy: { effectiveDate: 'asc' },
  });
  const cid = correlationId ?? newCorrelationId();
  const results: Array<{ batchId: string; ref: string; status: string; summary?: Record<string, number>; skipped?: string }> = [];
  for (const b of due) {
    if (dateKey(b.effectiveDate) > todaySg()) {
      results.push({ batchId: b.id, ref: b.ref, status: b.status, skipped: 'not-due' });
      continue;
    }
    try {
      const applied = await applyBatch({ batchId: b.id, actor, correlationId: cid });
      results.push({ batchId: b.id, ref: b.ref, status: applied.status, summary: applied.summary });
    } catch (e) {
      // A batch that cancels itself (CANCEL_IF_MANUAL) or hits a guard
      // reports its outcome instead of aborting the sweep. Guard rejections
      // (NOT_DUE excluded above; NOT_APPROVED, FORBIDDEN) leave the stored
      // row untouched, so the reported status is the stored one — never a
      // fabricated CANCELLED.
      if (e instanceof AppError) {
        const cancelled = (e as AppError & { cancelledBatch?: { status: string; summary: Record<string, number> } }).cancelledBatch;
        results.push({
          batchId: b.id, ref: b.ref,
          status: cancelled?.status ?? b.status, skipped: e.code,
        });
      } else {
        results.push({ batchId: b.id, ref: b.ref, status: 'SCHEDULED', skipped: 'error' });
      }
    }
  }
  await publishFinanceEvent(prisma, {
    type: 'rate.due_batches.applied',
    payload: { at: new Date().toISOString(), results },
    branchId: null, correlationId: cid,
  });
  return { today: todaySg(), results };
}

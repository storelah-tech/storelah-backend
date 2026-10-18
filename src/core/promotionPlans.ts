import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { PlanKind, PlanStatus, Prisma } from '@prisma/client';

export interface CellInput { sizeCategory: string; accessType: string; commitmentMonths: number; discountPct: number }
export interface FreeInput { monthIndex: number; free: boolean; discountPct?: number }
export interface RuleInput { groupId: number; field: string; operator: string; value: string }

// Discount commitment tiers offered by the Discount plan builder matrix:
// 1 / 3 / 6 / 12 months × 6 size categories × 2 access types = 48 cells.
// The 1-month tier is additive — existing 3/6/12 plans validate unchanged.
export const ALLOWED_COMMITMENT_MONTHS = [1, 3, 6, 12] as const;

// Statuses whose content (cells, scope, dates, rules…) may still be edited via
// updatePlan(). Everything else is locked — see updatePlan().
export const EDITABLE_PLAN_STATUSES: readonly PlanStatus[] = ['DRAFT', 'VALIDATED'];

// Canonical discount-matrix size categories, unified with the booking
// frontend: LOCKER, SMALL, MEDIUM, LARGE, XL (+ XXL, retained — it pre-exists
// in builder/matrix rows and is NOT invented here). Legacy single-letter
// codes (XS / S / M / L) are accepted on write AND read and mapped here —
// the SINGLE canonical mapping layer — so XS is retired (LOCKER canonical)
// without breaking stored rows. The builder UI + public surface always emit
// canonical codes.
export const CANONICAL_SIZE_CATEGORIES = ['LOCKER', 'SMALL', 'MEDIUM', 'LARGE', 'XL', 'XXL'] as const;
export type CanonicalSizeCategory = (typeof CANONICAL_SIZE_CATEGORIES)[number];

const LEGACY_SIZE_ALIASES: Record<string, string> = {
  XS: 'LOCKER', LOCKER: 'LOCKER',
  S: 'SMALL', SMALL: 'SMALL',
  M: 'MEDIUM', MEDIUM: 'MEDIUM',
  L: 'LARGE', LARGE: 'LARGE',
  XL: 'XL', XXL: 'XXL',
};

// Lenient read-path mapping: known codes (incl. legacy XS / S / M / L) map
// to canonical; unknown values pass through upper-cased so reads never throw.
export function toCanonicalSizeCategory(raw: unknown): string {
  const key = String(raw ?? '').trim().toUpperCase();
  return LEGACY_SIZE_ALIASES[key] ?? key;
}

// Strict write-path mapping: unknown codes reject with the canonical tier
// list (surfaces as 400 VALIDATION via AppError).
export function assertCanonicalSizeCategory(raw: unknown): string {
  const v = toCanonicalSizeCategory(raw);
  if (!(CANONICAL_SIZE_CATEGORIES as readonly string[]).includes(v)) {
    throw new AppError(
      400,
      'VALIDATION',
      `Unknown size category "${String(raw)}" — expected one of ${CANONICAL_SIZE_CATEGORIES.join(' / ')} (legacy XS / S / M / L also accepted)`,
    );
  }
  return v;
}

// Post-normalization collision handling (the owner-reported 500).
//
// The @@unique([planId, sizeCategory, accessType, commitmentMonths]) key
// compares RAW strings, so a legacy code and its canonical twin (e.g. "S"
// and "SMALL") can coexist as distinct stored rows — and builder payloads can
// mix both forms. After assertCanonicalSizeCategory collapses aliases, such
// pairs share one unique key and a naive nested create dies with a Prisma
// P2002 that escapes as 500 INTERNAL. This helper collapses exact-key
// collisions BEFORE the write: rows already in canonical form win over
// legacy-alias rows (mirrors the backfill "canonical wins" rule); ties keep
// first occurrence. Pure + total — the only throw is the honest 400 from
// assertCanonicalSizeCategory on unknown codes.
export function normalizeMatrixCellsForWrite<
  T extends { sizeCategory: string; accessType: string; commitmentMonths: number },
>(cells: T[]): T[] {
  const seen = new Map<string, { cell: T; canonical: boolean }>();
  for (const c of cells) {
    const sizeCategory = assertCanonicalSizeCategory(c.sizeCategory);
    const key = `${sizeCategory}${c.accessType}${c.commitmentMonths}`;
    const canonical = (CANONICAL_SIZE_CATEGORIES as readonly string[]).includes(
      String(c.sizeCategory ?? '').trim().toUpperCase(),
    );
    const prev = seen.get(key);
    if (!prev || (!prev.canonical && canonical)) {
      seen.set(key, { cell: { ...c, sizeCategory }, canonical });
    }
  }
  return [...seen.values()].map((e) => e.cell);
}

export interface PlanInput {
  kind: PlanKind;
  name: string;
  code?: string;
  description?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  facilityScope?: Prisma.InputJsonValue;
  storageType?: string;
  sizeScope?: Prisma.InputJsonValue;
  appliesTo?: string;
  usagePerCustomer?: number;
  redemptionCap?: number;
  perUnitApplication?: boolean;
  stackingRule?: string;
  budgetCap?: number;
  freeMonthCount?: number;
  commitmentMonths?: number;
  earlyExitTreatment?: string;
  minStayPct?: number;
  matrixCells?: CellInput[];
  freeMonths?: FreeInput[];
  rules?: RuleInput[];
  // PROMO_CODE benefit (stored on the linked, redeemable Promotion row —
  // see syncLinkedPromotion). PERCENTAGE = % off, DOLLAR = S$ off.
  benefitType?: CodeBenefitType;
  benefitValue?: number;
}

export type CodeBenefitType = 'PERCENTAGE' | 'DOLLAR' | 'FREE_MONTHS' | 'CREDITS';
// Benefits checkout can price today (CREDITS needs a wallet, FREE_MONTHS via
// code is the FREE_MONTHS plan kind) — validatePlan blocks the rest.
export const CHECKOUT_CODE_BENEFITS: readonly CodeBenefitType[] = ['PERCENTAGE', 'DOLLAR'];

function serialize(plan: any) {
  return {
    id: plan.id,
    kind: plan.kind,
    name: plan.name,
    code: plan.code,
    status: plan.status,
    description: plan.description,
    effectiveFrom: plan.effectiveFrom,
    effectiveTo: plan.effectiveTo,
    facilityScope: plan.facilityScope,
    storageType: plan.storageType,
    sizeScope: plan.sizeScope,
    appliesTo: plan.appliesTo,
    usagePerCustomer: plan.usagePerCustomer,
    redemptionCap: plan.redemptionCap,
    perUnitApplication: plan.perUnitApplication,
    stackingRule: plan.stackingRule,
    budgetCap: plan.budgetCap ? toNum(plan.budgetCap) : null,
    freeMonthCount: plan.freeMonthCount,
    commitmentMonths: plan.commitmentMonths,
    earlyExitTreatment: plan.earlyExitTreatment,
    minStayPct: plan.minStayPct,
    version: plan.version,
    // PROMO_CODE benefit, read back from the linked Promotion row.
    benefit: (() => {
      const promo = (plan.promotions || [])[0];
      return promo ? { type: promo.benefitType ?? (promo.discountType === 'FLAT' ? 'DOLLAR' : 'PERCENTAGE'), value: toNum(promo.discountValue) } : null;
    })(),
    matrixCells: (plan.matrixCells || []).map((c: any) => ({
      id: c.id,
      // Lenient: legacy XS rows read as LOCKER (backward-compat).
      sizeCategory: toCanonicalSizeCategory(c.sizeCategory),
      accessType: c.accessType,
      commitmentMonths: c.commitmentMonths,
      discountPct: toNum(c.discountPct),
    })),
    freeMonths: (plan.freeMonths || []).map((f: any) => ({
      id: f.id,
      monthIndex: f.monthIndex,
      free: f.free,
      discountPct: f.discountPct ? toNum(f.discountPct) : null,
    })),
    rules: (plan.rules || []).map((r: any) => ({
      id: r.id,
      groupId: r.groupId,
      field: r.field,
      operator: r.operator,
      value: r.value,
    })),
    versions: (plan.versions || []).map((v: any) => ({
      id: v.id,
      version: v.version,
      snapshot: v.snapshot,
      changedBy: v.changedBy,
      changeSummary: v.changeSummary,
      createdAt: v.createdAt,
    })),
    promotionCount: (plan.promotions || []).length,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

const INCLUDE = {
  matrixCells: true,
  freeMonths: true,
  rules: true,
  versions: { orderBy: { version: 'desc' as const } },
  promotions: true,
} as const;

export async function listPlans(opts?: { from?: Date; to?: Date }) {
  await syncPlanSchedule();
  const effectiveFrom: { gte?: Date; lte?: Date } = {};
  if (opts?.from) effectiveFrom.gte = opts.from;
  if (opts?.to) effectiveFrom.lte = opts.to;
  const rows = await prisma.promotionPlan.findMany({
    where: effectiveFrom.gte || effectiveFrom.lte ? { effectiveFrom } : undefined,
    include: INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(serialize);
}

export async function getPlan(id: string) {
  const row = await prisma.promotionPlan.findUnique({ where: { id }, include: INCLUDE });
  if (!row) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${id} not found`);
  return serialize(row);
}

async function assertCodeFreeForPlan(code: string, planId?: string) {
  const promo = await prisma.promotion.findUnique({ where: { code } });
  if (promo && (!planId || promo.planId !== planId)) {
    throw new AppError(409, 'CONFLICT', `Promo code ${code} is already used by another promotion`);
  }
}

export async function createPlan(input: PlanInput) {
  if (input.code) {
    const existing = await prisma.promotionPlan.findUnique({ where: { code: input.code } });
    if (existing) throw new AppError(409, 'CONFLICT', `Plan code ${input.code} already exists`);
    await assertCodeFreeForPlan(input.code);
  }

  const plan = await prisma.promotionPlan.create({
    data: {
      kind: input.kind,
      name: input.name,
      code: input.code,
      description: input.description,
      effectiveFrom: new Date(input.effectiveFrom),
      effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : undefined,
      facilityScope: (input.facilityScope ?? ['ALL']) as Prisma.InputJsonValue,
      storageType: input.storageType,
      sizeScope: (input.sizeScope ?? ['ALL']) as Prisma.InputJsonValue,
      appliesTo: input.appliesTo,
      usagePerCustomer: input.usagePerCustomer,
      redemptionCap: input.redemptionCap,
      perUnitApplication: input.perUnitApplication,
      stackingRule: input.stackingRule,
      budgetCap: input.budgetCap,
      freeMonthCount: input.freeMonthCount,
      commitmentMonths: input.commitmentMonths,
      earlyExitTreatment: input.earlyExitTreatment,
      minStayPct: input.minStayPct,
      matrixCells: input.matrixCells ? {
        create: normalizeMatrixCellsForWrite(input.matrixCells).map(c => ({
          // Strict: legacy XS / S / M / L normalize to canonical LOCKER /
          // SMALL / MEDIUM / LARGE; unknown codes 400. Exact-key collisions
          // after normalization are collapsed in normalizeMatrixCellsForWrite
          // (P2002 → 500 fix), so the nested create cannot violate the
          // @@unique([planId, sizeCategory, accessType, commitmentMonths]) key.
          sizeCategory: c.sizeCategory,
          accessType: c.accessType,
          commitmentMonths: c.commitmentMonths,
          discountPct: c.discountPct,
        })),
      } : undefined,
      freeMonths: input.freeMonths ? {
        create: input.freeMonths.map(f => ({
          monthIndex: f.monthIndex,
          free: f.free,
          discountPct: f.discountPct,
        })),
      } : undefined,
      rules: input.rules ? {
        create: input.rules.map(r => ({
          groupId: r.groupId,
          field: r.field,
          operator: r.operator,
          value: r.value,
        })),
      } : undefined,
      versions: {
        create: {
          version: 1,
          snapshot: input as unknown as Prisma.InputJsonValue,
          changedBy: 'System',
          changeSummary: 'Plan created',
        },
      },
    },
    include: INCLUDE,
  });

  if (plan.kind === 'PROMO_CODE') {
    await syncLinkedPromotion(plan.id, input);
    return getPlan(plan.id);
  }
  return serialize(plan);
}

export async function updatePlan(id: string, input: Partial<PlanInput>) {
  const existing = await prisma.promotionPlan.findUnique({ where: { id }, include: INCLUDE });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${id} not found`);
  // Live rules are never edited in place: only DRAFT / VALIDATED plans take
  // content edits (VALIDATED → SCHEDULED re-validates). SCHEDULED, ACTIVE and
  // ENDED are locked — corrections go through Duplicate / Restore as draft
  // (or SCHEDULED → DRAFT first), so checkout prices never change silently.
  if (!EDITABLE_PLAN_STATUSES.includes(existing.status as PlanStatus)) {
    throw new AppError(
      409,
      'PLAN_LOCKED',
      `Plan "${existing.name}" is ${existing.status} and can't be edited — ` +
        (existing.status === 'SCHEDULED'
          ? 'move it back to draft first, or duplicate it.'
          : existing.status === 'ACTIVE'
            ? 'disable it first (it stops applying at checkout), edit, then publish again.'
            : 'restore a version as a new draft, or duplicate it, to make changes.'),
      { status: existing.status },
    );
  }

  if (input.code && input.code !== existing.code) {
    const clash = await prisma.promotionPlan.findUnique({ where: { code: input.code } });
    if (clash) throw new AppError(409, 'CONFLICT', `Plan code ${input.code} already exists`);
    await assertCodeFreeForPlan(input.code, id);
  }

  if (input.matrixCells !== undefined) {
    await prisma.discountMatrixCell.deleteMany({ where: { planId: id } });
  }
  if (input.freeMonths !== undefined) {
    await prisma.freeMonthAllocation.deleteMany({ where: { planId: id } });
  }
  if (input.rules !== undefined) {
    await prisma.promotionRule.deleteMany({ where: { planId: id } });
  }

  const newVersion = existing.version + 1;

  const plan = await prisma.promotionPlan.update({
    where: { id },
    data: {
      kind: input.kind,
      name: input.name,
      code: input.code,
      description: input.description,
      effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : undefined,
      effectiveTo: input.effectiveTo !== undefined ? (input.effectiveTo ? new Date(input.effectiveTo) : null) : undefined,
      facilityScope: input.facilityScope as Prisma.InputJsonValue | undefined,
      storageType: input.storageType,
      sizeScope: input.sizeScope as Prisma.InputJsonValue | undefined,
      appliesTo: input.appliesTo,
      usagePerCustomer: input.usagePerCustomer,
      redemptionCap: input.redemptionCap,
      perUnitApplication: input.perUnitApplication,
      stackingRule: input.stackingRule,
      budgetCap: input.budgetCap,
      freeMonthCount: input.freeMonthCount,
      commitmentMonths: input.commitmentMonths,
      earlyExitTreatment: input.earlyExitTreatment,
      minStayPct: input.minStayPct,
      version: newVersion,
      matrixCells: input.matrixCells ? {
        create: normalizeMatrixCellsForWrite(input.matrixCells).map(c => ({
          // Strict write-path normalization + collision collapse (see
          // createPlan) — without it a payload mixing legacy + canonical
          // twins (S + SMALL) P2002s into a 500 after deleteMany.
          sizeCategory: c.sizeCategory,
          accessType: c.accessType,
          commitmentMonths: c.commitmentMonths,
          discountPct: c.discountPct,
        })),
      } : undefined,
      freeMonths: input.freeMonths ? {
        create: input.freeMonths.map(f => ({
          monthIndex: f.monthIndex,
          free: f.free,
          discountPct: f.discountPct,
        })),
      } : undefined,
      rules: input.rules ? {
        create: input.rules.map(r => ({
          groupId: r.groupId,
          field: r.field,
          operator: r.operator,
          value: r.value,
        })),
      } : undefined,
    },
    include: INCLUDE,
  });

  await prisma.promotionVersion.create({
    data: {
      planId: id,
      version: newVersion,
      snapshot: input as unknown as Prisma.InputJsonValue,
      changedBy: 'Operator',
      changeSummary: 'Plan updated',
    },
  });

  if (plan.kind === 'PROMO_CODE') {
    await syncLinkedPromotion(plan.id, input);
    return getPlan(plan.id);
  }
  return serialize(plan);
}

// --- Linked promo-code row (PROMO_CODE plans) ---
//
// Checkout and POST /public/promotions/validate redeem codes from the
// Promotion table. A PROMO_CODE plan owns exactly one linked Promotion row
// (planId) that mirrors its code, benefit, dates and caps; it is `active` only
// while the plan is ACTIVE. Called after every create / update / status change
// / restore so the redeemable row can never drift from the plan (R-PR6).
const PLAN_TO_PROMO_STATUS: Record<PlanStatus, 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'ENDED'> = {
  DRAFT: 'DRAFT', VALIDATED: 'DRAFT', SCHEDULED: 'SCHEDULED', ACTIVE: 'ACTIVE', ENDED: 'ENDED',
};

export async function syncLinkedPromotion(planId: string, input?: Partial<PlanInput>): Promise<void> {
  const plan = await prisma.promotionPlan.findUnique({ where: { id: planId }, include: { promotions: true } });
  if (!plan || plan.kind !== 'PROMO_CODE') return;
  const linked = plan.promotions[0] ?? null;
  if (!plan.code) {
    // No customer-facing code yet → nothing redeemable.
    if (linked) await prisma.promotion.update({ where: { id: linked.id }, data: { active: false, status: 'DRAFT' } });
    return;
  }
  const clash = await prisma.promotion.findUnique({ where: { code: plan.code } });
  if (clash && clash.planId !== plan.id) {
    throw new AppError(409, 'CONFLICT', `Promo code ${plan.code} is already used by another promotion`);
  }
  const benefitType = (input?.benefitType ?? linked?.benefitType ?? 'PERCENTAGE') as CodeBenefitType;
  const benefitValue = input?.benefitValue ?? (linked ? toNum(linked.discountValue) : 0);
  const data = {
    code: plan.code,
    name: plan.name,
    description: plan.description,
    discountType: benefitType === 'DOLLAR' ? ('FLAT' as const) : ('PERCENTAGE' as const),
    discountValue: benefitValue,
    benefitType,
    startDate: plan.effectiveFrom,
    endDate: plan.effectiveTo,
    active: plan.status === 'ACTIVE',
    status: PLAN_TO_PROMO_STATUS[plan.status as PlanStatus],
    applyTo: plan.appliesTo,
    usagePerCustomer: plan.usagePerCustomer,
    redemptionCap: plan.redemptionCap,
    stackingRule: plan.stackingRule,
    planId: plan.id,
  };
  if (linked) await prisma.promotion.update({ where: { id: linked.id }, data });
  else await prisma.promotion.create({ data });
}

// --- Schedule sync (lazy activation / expiry, no cron) ---
//
// There is no scheduler in the Lambda, so date-driven transitions run lazily
// before every read that prices or lists promotions (checkout quote/booking,
// public feeds, CMS lists): SCHEDULED plans whose effectiveFrom has passed go
// ACTIVE, and ACTIVE/SCHEDULED plans whose effectiveTo has passed go ENDED.
// Each transition goes through setPlanStatus (versioned, changedBy
// 'Scheduler'). Cheap: one indexed query when nothing is due.
export async function syncPlanSchedule(now: Date = new Date()): Promise<{ activated: string[]; ended: string[] }> {
  const activated: string[] = [];
  const ended: string[] = [];
  const due = await prisma.promotionPlan.findMany({
    where: {
      OR: [
        { status: { in: ['ACTIVE', 'SCHEDULED'] }, effectiveTo: { lte: now } },
        { status: 'SCHEDULED', effectiveFrom: { lte: now } },
      ],
    },
    select: { id: true, status: true, effectiveFrom: true, effectiveTo: true },
  });
  for (const p of due) {
    try {
      if (p.effectiveTo && p.effectiveTo <= now) {
        await setPlanStatus(p.id, 'ENDED', { changedBy: 'Scheduler', now });
        ended.push(p.id);
      } else if (p.status === 'SCHEDULED' && p.effectiveFrom <= now) {
        await setPlanStatus(p.id, 'ACTIVE', { changedBy: 'Scheduler', now });
        activated.push(p.id);
      }
    } catch {
      // A concurrent request already moved it — the next read re-checks.
    }
  }
  return { activated, ended };
}

/** True when the plan's facility scope covers this unit's branch (ids or codes). */
export function planCoversBranch(facilityScope: unknown, branch: { id: string; code: string }): boolean {
  const scope = Array.isArray(facilityScope) ? facilityScope.map(String) : ['ALL'];
  return scope.length === 0 || scope.some((f) => /^all$/i.test(f)) || scope.includes(branch.id) || scope.includes(branch.code);
}

/** True when the plan's size scope covers this canonical size category. */
export function planCoversSize(sizeScope: unknown, sizeCategory: string): boolean {
  const scope = Array.isArray(sizeScope) ? sizeScope.map(String) : ['ALL'];
  return scope.length === 0 || scope.some((x) => /^all$/i.test(x)) || scope.map(toCanonicalSizeCategory).includes(sizeCategory);
}

/** Floor rules ({ field: 'floor', operator: 'equals', value: floorId }) — none = every floor. */
export function planCoversFloor(rules: ReadonlyArray<{ field: string; operator: string; value: string }>, floorId: string | null): boolean {
  const floors = rules.filter((r) => r.field === 'floor' && r.operator === 'equals').map((r) => r.value);
  return floors.length === 0 || (floorId != null && floors.includes(floorId));
}

// --- Status / approval state machine ---
//
// Allowed transitions (see docs/PROMOTIONS_SPEC.md §2.4 + CMS audit Phase 5):
//
//   DRAFT ──► VALIDATED ──► SCHEDULED ──► ACTIVE ──► ENDED
//     ▲          │              │
//     └──────────┘              │  (rollback to DRAFT for rework)
//     └────────────────────────┘
//
// - DRAFT → VALIDATED: requires validatePlan().valid (zero blockers).
// - VALIDATED → SCHEDULED, SCHEDULED → ACTIVE: no extra data checks; the
//   operator performing the step is recorded on the version row (changedBy) and
//   an optional approverRole label (e.g. "MANAGER", "COMMERCIAL") is stored in
//   the version snapshot for audit. P1 item 6 adds a GATED verified check:
//   actors that hold any Permission row must also hold 'promotions.approve'
//   for these go-live edges (see the requirePermission call below); actors
//   without rows keep the legacy label-only behavior.
// - SCHEDULED → ENDED and ACTIVE → ENDED: early termination.
// - VALIDATED → DRAFT and SCHEDULED → DRAFT: safe rollback for rework.
// - ACTIVE → DRAFT = "Disable" (owner decision 2026-10-18): a live plan is
//   never edited in place (updatePlan locks it), so changing one is
//   Disable (stops applying at checkout immediately, versioned) → edit →
//   re-publish through validation. ENDED stays terminal (restore-as-draft
//   turns it back into a DRAFT for reuse).
// - SCHEDULED → ACTIVE also happens automatically once effectiveFrom is
//   reached, and ACTIVE/SCHEDULED → ENDED once effectiveTo passes — see
//   syncPlanSchedule() (lazy, run before every pricing/listing read).
// - Any other edge (e.g. DRAFT → ACTIVE, DRAFT → SCHEDULED, ENDED → anything)
//   is rejected with 400 INVALID_TRANSITION.
const PLAN_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  DRAFT: ['VALIDATED'],
  VALIDATED: ['SCHEDULED', 'DRAFT'],
  SCHEDULED: ['ACTIVE', 'ENDED', 'DRAFT'],
  ACTIVE: ['ENDED', 'DRAFT'],
  ENDED: [],
};

export function allowedTransitions(from: PlanStatus): PlanStatus[] {
  return PLAN_TRANSITIONS[from] ?? [];
}

export async function setPlanStatus(
  id: string,
  status: PlanStatus,
  opts?: { changedBy?: string; approverRole?: string; actorId?: string; now?: Date },
) {
  const existing = await prisma.promotionPlan.findUnique({ where: { id }, include: INCLUDE });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${id} not found`);

  const from = existing.status as PlanStatus;
  // Same-status PATCH is a no-op (no phantom version row).
  if (from === status) return serialize(existing);
  if (!allowedTransitions(from).includes(status)) {
    throw new AppError(
      400,
      'INVALID_TRANSITION',
      `Cannot move plan from ${from} to ${status}`,
      { from, to: status, allowed: allowedTransitions(from) },
    );
  }

  // P1 item 6 (gated): go-live transitions (→ SCHEDULED / → ACTIVE) require
  // the verified 'promotions.approve' permission — but ONLY for actors that
  // have permission rows at all. Actors without rows keep the legacy behavior
  // (free-text approverRole label, no check), so existing auth flows never
  // break. Import is lazy to avoid a core/users ⇄ core/promotionPlans cycle.
  if ((status === 'SCHEDULED' || status === 'ACTIVE') && opts?.actorId) {
    const { requirePermission } = await import('./users');
    await requirePermission(opts.actorId, 'promotions.approve');
  }

  // Gate: scheduling-line transitions require a clean validation.
  // DRAFT → VALIDATED always re-validates; VALIDATED → SCHEDULED re-checks so
  // a plan edited after validation cannot slip through stale.
  if ((from === 'DRAFT' && status === 'VALIDATED') || (from === 'VALIDATED' && status === 'SCHEDULED')) {
    const result = await validatePlan(id);
    if (!result.valid) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Plan has validation blockers', {
        blockers: result.blockers,
        checks: result.checks.filter((c) => c.status === 'blocker'),
      });
    }
  }

  // A plan cannot be made ACTIVE before its start date — it stays SCHEDULED
  // and syncPlanSchedule() activates it on effectiveFrom (Publish of a
  // future-dated plan therefore ends as "scheduled", never ACTIVE-but-idle).
  if (status === 'ACTIVE' && existing.effectiveFrom > (opts?.now ?? new Date())) {
    throw new AppError(409, 'NOT_YET_EFFECTIVE',
      `Plan "${existing.name}" starts ${existing.effectiveFrom.toISOString().slice(0, 10)} — it stays scheduled and goes live automatically on that date.`,
      { effectiveFrom: existing.effectiveFrom });
  }

  const changedBy = opts?.changedBy ?? 'Operator';
  const newVersion = existing.version + 1;

  const plan = await prisma.promotionPlan.update({
    where: { id },
    data: { status, version: newVersion },
    include: INCLUDE,
  });
  await syncLinkedPromotion(id);

  await prisma.promotionVersion.create({
    data: {
      planId: id,
      version: newVersion,
      snapshot: { status, approverRole: opts?.approverRole ?? null } as unknown as Prisma.InputJsonValue,
      changedBy,
      changeSummary: (from === 'ACTIVE' && status === 'DRAFT' ? 'Disabled for editing (ACTIVE → DRAFT)' : `Status changed from ${from} to ${status}`) +
        (opts?.approverRole ? ` (approver role: ${opts.approverRole})` : ''),
    },
  });

  return serialize((await prisma.promotionPlan.findUnique({ where: { id }, include: INCLUDE })) ?? plan);
}

export async function duplicatePlan(id: string) {
  const existing = await prisma.promotionPlan.findUnique({
    where: { id },
    include: { matrixCells: true, freeMonths: true, rules: true },
  });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${id} not found`);

  const plan = await prisma.promotionPlan.create({
    data: {
      kind: existing.kind,
      name: `Copy of ${existing.name}`,
      status: 'DRAFT' as PlanStatus,
      version: 1,
      effectiveFrom: new Date(),
      effectiveTo: existing.effectiveTo,
      facilityScope: (existing.facilityScope ?? ['ALL']) as Prisma.InputJsonValue,
      storageType: existing.storageType,
      sizeScope: (existing.sizeScope ?? ['ALL']) as Prisma.InputJsonValue,
      appliesTo: existing.appliesTo,
      usagePerCustomer: existing.usagePerCustomer,
      redemptionCap: existing.redemptionCap,
      perUnitApplication: existing.perUnitApplication,
      stackingRule: existing.stackingRule,
      budgetCap: existing.budgetCap,
      freeMonthCount: existing.freeMonthCount,
      commitmentMonths: existing.commitmentMonths,
      earlyExitTreatment: existing.earlyExitTreatment,
      minStayPct: existing.minStayPct,
      description: existing.description,
      // Re-canonicalize on copy so legacy XS rows duplicate as LOCKER;
      // collapse legacy/canonical twins (S + SMALL) that coexist as distinct
      // raw strings — without it the copy P2002s into a 500.
      matrixCells: existing.matrixCells.length ? {
        create: normalizeMatrixCellsForWrite(existing.matrixCells.map((c) => ({
          sizeCategory: c.sizeCategory,
          accessType: c.accessType,
          commitmentMonths: c.commitmentMonths,
          discountPct: c.discountPct,
        }))),
      } : undefined,
      freeMonths: existing.freeMonths.length ? {
        create: existing.freeMonths.map(f => ({
          monthIndex: f.monthIndex,
          free: f.free,
          discountPct: f.discountPct,
        })),
      } : undefined,
      rules: existing.rules.length ? {
        create: existing.rules.map(r => ({
          groupId: r.groupId,
          field: r.field,
          operator: r.operator,
          value: r.value,
        })),
      } : undefined,
      versions: {
        create: {
          version: 1,
          snapshot: { duplicatedFrom: id, originalName: existing.name } as unknown as Prisma.InputJsonValue,
          changedBy: 'Operator',
          changeSummary: `Duplicated from plan ${existing.name}`,
        },
      },
    },
    include: INCLUDE,
  });

  return serialize(plan);
}

export async function deletePlan(id: string) {
  const existing = await prisma.promotionPlan.findUnique({ where: { id }, include: INCLUDE });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${id} not found`);
  if (existing.status !== 'DRAFT') {
    throw new AppError(400, 'INVALID_STATUS', 'Only draft plans can be deleted');
  }
  await prisma.promotion.deleteMany({ where: { planId: id } });
  await prisma.promotionPlan.delete({ where: { id } });
  return { id };
}

export interface PlanCheck { status: 'pass' | 'warning' | 'blocker'; message: string }
export interface SampleBooking { unitCode: string; branch: string; monthlyRate: number; months: number; baseTotal: number; discountTotal: number; effectiveTotal: number; effectiveRate: number; note: string }
export interface PlanOverlap { planId: string; planName: string; status: string; effectiveFrom: Date; effectiveTo: Date | null }

// DIFFICULTY LOG (validation engine simplifications — see return Note):
// 1. Rate floors are checked worst-case: for every discounted (size category,
//    pct) pair, the cheapest AVAILABLE unit of that category inside the plan's
//    facility scope ∩ the safeguard's facility/size is priced (unit size codes
//    are canonicalized via toCanonicalSizeCategory). Access type and commitment
//    are not unit attributes, so every cell of a category prices against the
//    same cheapest unit. Plans with no available units in scope skip the check.
// 2. Overlap detection compares date-range × facilityScope × sizeScope only
//    (string lists with "ALL" wildcard). Eligibility RULES (PromoRule rows) are
//    not evaluated for overlap — rule semantics (AND/OR groups over customer
//    fields) would need a full predicate engine (follow-up).
// 3. Sample-booking pricing uses the plan's HEADLINE discount (max matrix cell
//    / free-month effective %) on up to 3 real units, 12-month horizon, no
//    proration, no stacking, no credits. It proves the plan prices sanely, not
//    that every cell prices sanely.
export async function validatePlan(id: string) {
  const plan = await prisma.promotionPlan.findUnique({
    where: { id },
    include: { matrixCells: true, freeMonths: true, rules: true },
  });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${id} not found`);

  let blockers = 0;
  let warnings = 0;
  const checks: PlanCheck[] = [];
  const overlaps: PlanOverlap[] = [];
  const samples: SampleBooking[] = [];
  const push = (status: PlanCheck['status'], message: string) => {
    if (status === 'blocker') blockers++;
    if (status === 'warning') warnings++;
    checks.push({ status, message });
  };

  // --- 1. Completeness (as before) ---
  if (!plan.name || plan.name.trim().length === 0) push('blocker', 'Plan name is required');
  if (!plan.effectiveFrom) push('blocker', 'Effective from date is required');
  if (plan.effectiveTo && plan.effectiveTo <= plan.effectiveFrom) {
    push('blocker', 'Effective-to date must be after effective-from date');
  }

  // Headline discount % used by floor + sample checks.
  let headlinePct = 0;
  if (plan.kind === 'DISCOUNT_MATRIX') {
    const cells = plan.matrixCells;
    if (cells.length === 0) push('blocker', 'Discount matrix must have at least one cell');
    else {
      const bad = cells.filter((c) => {
        const v = toNum(c.discountPct);
        return !(v >= 0 && v <= 100);
      });
      if (bad.length) push('blocker', `${bad.length} matrix cell(s) outside 0–100%`);
      else push('pass', `${cells.length} matrix cells defined (all within 0–100%)`);
      // Size tiers: legacy XS / S / M / L read as canonical LOCKER / SMALL /
      // MEDIUM / LARGE, so migrated and unmigrated rows both pass; anything
      // outside the canonical set blocks with the tier list.
      const canonicalSizes = cells.map((c) => toCanonicalSizeCategory(c.sizeCategory));
      const unknownSizes = [...new Set(canonicalSizes)].filter(
        (s) => !(CANONICAL_SIZE_CATEGORIES as readonly string[]).includes(s),
      );
      if (unknownSizes.length) {
        push('blocker', `Unknown size categor${unknownSizes.length === 1 ? 'y' : 'ies'} ${unknownSizes.join(', ')} — expected one of ${CANONICAL_SIZE_CATEGORIES.join(' / ')}`);
      } else {
        const tiers = [...new Set(canonicalSizes)].sort();
        push('pass', `Size categories covered: ${tiers.join(' / ')}`);
      }
      const allowed = ALLOWED_COMMITMENT_MONTHS as readonly number[];
      const offTier = cells.filter((c) => !allowed.includes(c.commitmentMonths));
      if (offTier.length) push('blocker', `${offTier.length} matrix cell(s) outside commitment tiers 1 / 3 / 6 / 12 months`);
      else {
        const tiers = [...new Set(cells.map((c) => c.commitmentMonths))].sort((a, b) => a - b);
        push('pass', `Commitment tiers covered: ${tiers.join(' / ')} months`);
      }
      headlinePct = Math.max(...cells.map((c) => toNum(c.discountPct)));
      if (headlinePct > 40) {
        push('warning', `Headline discount ${headlinePct}% exceeds 40% — requires Commercial/Finance approval before activation`);
      } else if (headlinePct > 25) {
        push('warning', `Headline discount ${headlinePct}% exceeds 25% — requires manager approval before activation`);
      }
    }
  }

  if (plan.kind === 'FREE_MONTHS') {
    if (!plan.freeMonthCount || plan.freeMonthCount < 1) push('blocker', 'Free month count must be at least 1');
    if (!plan.commitmentMonths || plan.commitmentMonths < 1) push('blocker', 'Commitment months must be specified');
    const allocs = plan.freeMonths;
    if (plan.freeMonthCount && plan.commitmentMonths) {
      const freeCount = allocs.filter((a) => a.free).length;
      if (allocs.length && freeCount !== plan.freeMonthCount) {
        push('blocker', `Allocation marks ${freeCount} free month(s) but plan promises ${plan.freeMonthCount}`);
      } else if (!allocs.length) {
        push('warning', 'No month allocation rows saved — allocation panel state will be required before scheduling');
      } else {
        push('pass', `${plan.freeMonthCount} free months over ${plan.commitmentMonths} months`);
      }
      headlinePct = (plan.freeMonthCount / plan.commitmentMonths) * 100;
      if (headlinePct > 40) push('warning', `Effective discount ${headlinePct.toFixed(1)}% exceeds 40% — requires Commercial/Finance approval`);
    }
  }

  if (plan.kind === 'PROMO_CODE') {
    if (!plan.code) push('blocker', 'Promo code is required for PROMO_CODE plans');
    // Benefit lives on the linked Promotion row (syncLinkedPromotion).
    const promo = await prisma.promotion.findFirst({ where: { planId: plan.id } });
    const bType = (promo?.benefitType ?? null) as CodeBenefitType | null;
    const bValue = promo ? toNum(promo.discountValue) : 0;
    if (!promo || !(bValue > 0)) push('blocker', 'Benefit value is required (e.g. 10 for 10% or S$10 off)');
    else if (!bType || !CHECKOUT_CODE_BENEFITS.includes(bType)) push('blocker', `Benefit "${bType ?? 'unknown'}" can't be applied at checkout yet — use % or S$ off`);
    else if (bType === 'PERCENTAGE' && bValue > 100) push('blocker', 'Percentage benefit must be 100% or less');
    else {
      push('pass', `Benefit: ${bType === 'PERCENTAGE' ? bValue + '% off' : 'S$' + bValue + ' off'}`);
      if (bType === 'PERCENTAGE') headlinePct = bValue;
    }
    if (plan.rules.length === 0) push('warning', 'No eligibility rules defined — plan applies to all');
    else push('pass', `${plan.rules.length} eligibility rule(s) defined`);
  }

  // --- 2. Rate-floor checks vs SafeguardRule ---
  // Each safeguard is checked against the CHEAPEST available unit the plan
  // actually discounts (PRM-05): per matrix cell (size category × pct) — or the
  // headline % over the size scope for other kinds — narrowed to the plan's
  // facility scope ∩ the safeguard's facility/size. A generic median base let
  // cheap units slip below the floor.
  const safeguards = await prisma.safeguardRule.findMany({ include: { branch: true, unitSize: true } });
  if (safeguards.length && headlinePct > 0) {
    const facilityScope = Array.isArray(plan.facilityScope) ? (plan.facilityScope as unknown[]).map(String) : ['ALL'];
    const allFacilities = facilityScope.length === 0 || facilityScope.some((f) => /^all$/i.test(f));
    // Scope entries are branch ids (builder) or codes (legacy) — accept both.
    const planCovers = (b: { id: string; code: string }) =>
      allFacilities || facilityScope.includes(b.id) || facilityScope.includes(b.code);
    const sizeScope = Array.isArray(plan.sizeScope) ? (plan.sizeScope as unknown[]).map(String) : ['ALL'];
    const scopedSizes = sizeScope.some((x) => /^all$/i.test(x)) ? null : sizeScope.map(toCanonicalSizeCategory);
    // Discounted (size, pct) pairs; size null = every size in scope.
    const pairs: Array<{ size: string | null; pct: number }> =
      plan.kind === 'DISCOUNT_MATRIX'
        ? plan.matrixCells.map((c) => ({ size: toCanonicalSizeCategory(c.sizeCategory), pct: toNum(c.discountPct) }))
        : (scopedSizes ?? [null]).map((size) => ({ size, pct: headlinePct }));
    const units = await prisma.unit.findMany({
      where: { deletedAt: null, status: 'AVAILABLE' },
      select: { monthlyRate: true, sizeId: true, branch: { select: { id: true, code: true } }, size: { select: { code: true, name: true } } },
    });
    for (const s of safeguards) {
      const code = s.branch?.code ?? null;
      if (s.branch && !planCovers(s.branch)) continue;
      const floor = toNum(s.minEffectiveRate);
      const scopeLabel = (code ? `facility ${code}` : 'global floor') + (s.unitSize ? ` · ${s.unitSize.code}` : '');
      // Worst case across pairs: lowest effective rate after discount.
      let worst: { effective: number; base: number; pct: number; size: string } | null = null;
      for (const pr of pairs) {
        if (!(pr.pct > 0)) continue;
        let minBase: number | null = null;
        let minSize = '';
        for (const u of units) {
          if (!planCovers(u.branch)) continue;
          if (s.facilityId && u.branch.id !== s.facilityId) continue;
          if (s.sizeId && u.sizeId !== s.sizeId) continue;
          const cat = toCanonicalSizeCategory(u.size?.code ?? u.size?.name ?? '');
          if (pr.size && cat !== pr.size) continue;
          const rate = toNum(u.monthlyRate);
          if (minBase == null || rate < minBase) { minBase = rate; minSize = cat; }
        }
        if (minBase == null) continue;
        const effective = minBase * (1 - pr.pct / 100);
        if (!worst || effective < worst.effective) worst = { effective, base: minBase, pct: pr.pct, size: minSize };
      }
      if (!worst) {
        push('pass', `Rate floor (${scopeLabel}): no available units in scope to price — check skipped`);
      } else if (worst.effective < floor) {
        push('blocker', `Rate floor breach (${scopeLabel}): ${worst.pct}% off cheapest ${worst.size} unit $${worst.base}/mo → $${worst.effective.toFixed(2)} below $${floor}/mo floor`);
      } else {
        push('pass', `Rate floor holds (${scopeLabel}): worst case $${worst.effective.toFixed(2)} ≥ $${floor}/mo floor (${worst.pct}% off cheapest ${worst.size} unit $${worst.base}/mo)`);
      }
      const threshold = s.requiresApprovalAbove != null ? toNum(s.requiresApprovalAbove) : null;
      if (threshold != null && headlinePct >= threshold) {
        push('warning', `Discount ${headlinePct}% meets approval threshold ${threshold}% (${s.approverRole ?? 'manager'} approval required, ${scopeLabel})`);
      }
    }
  } else if (headlinePct > 0) {
    push('warning', 'No safeguard rules configured — rate-floor check skipped (add floors under Safeguards)');
  }

  // --- 3. Overlap detection: date-range × branch × size vs live plans ---
  const liveStatuses = ['VALIDATED', 'SCHEDULED', 'ACTIVE'] as PlanStatus[];
  const others = await prisma.promotionPlan.findMany({
    where: { id: { not: id }, status: { in: liveStatuses } },
    select: { id: true, name: true, status: true, effectiveFrom: true, effectiveTo: true, facilityScope: true, sizeScope: true },
  });
  const scopeOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : ['ALL']);
  const myFac = scopeOf(plan.facilityScope);
  const mySize = scopeOf(plan.sizeScope);
  const myFrom = plan.effectiveFrom.getTime();
  const myTo = plan.effectiveTo ? plan.effectiveTo.getTime() : Infinity;
  const intersects = (a: string[], b: string[]) =>
    a.includes('ALL') || b.includes('ALL') || a.some((x) => b.includes(x));
  for (const o of others) {
    const oFrom = o.effectiveFrom.getTime();
    const oTo = o.effectiveTo ? o.effectiveTo.getTime() : Infinity;
    if (myFrom > oTo || oFrom > myTo) continue; // date ranges disjoint
    if (!intersects(myFac, scopeOf(o.facilityScope))) continue;
    if (!intersects(mySize, scopeOf(o.sizeScope))) continue;
    warnings++;
    overlaps.push({ planId: o.id, planName: o.name, status: o.status, effectiveFrom: o.effectiveFrom, effectiveTo: o.effectiveTo });
    checks.push({ status: 'warning', message: `Overlap: "${o.name}" (${o.status}) covers an intersecting date × facility × size window — stacking safeguard picks one rent promotion` });
  }
  if (!overlaps.length) checks.push({ status: 'pass', message: 'No overlapping live plans in the same date × facility × size window' });

  // --- 4. Sample-booking evaluation ---
  if (headlinePct > 0) {
    const sampleUnits = await prisma.unit.findMany({
      where: { deletedAt: null, status: 'AVAILABLE' },
      include: { branch: true },
      orderBy: { monthlyRate: 'asc' },
      take: 3,
    });
    if (!sampleUnits.length) {
      push('warning', 'No available units to price a sample booking against');
    } else {
      const months = 12;
      for (const u of sampleUnits) {
        const rate = toNum(u.monthlyRate);
        const baseTotal = rate * months;
        const discountTotal = (baseTotal * headlinePct) / 100;
        samples.push({
          unitCode: u.unitCode,
          branch: u.branch.code,
          monthlyRate: rate,
          months,
          baseTotal,
          discountTotal,
          effectiveTotal: baseTotal - discountTotal,
          effectiveRate: rate * (1 - headlinePct / 100),
          note: plan.kind === 'FREE_MONTHS'
            ? `Free-month effective ${headlinePct.toFixed(1)}% applied as headline across ${months} months (no proration)`
            : `Headline ${headlinePct}% (max cell) applied flat across ${months} months (no stacking)`,
        });
      }
      push('pass', `Sample booking priced on ${samples.length} unit(s) at headline ${headlinePct.toFixed(1)}%`);
    }
  }

  return {
    valid: blockers === 0, blockers, warnings, checks, overlaps, samples,
    planId: id, planName: plan.name, status: plan.status,
  };
}

// --- Safeguard rules ---

export async function listSafeguards() {
  const rows = await prisma.safeguardRule.findMany({
    include: { branch: true, unitSize: true },
    orderBy: [{ facilityId: 'asc' }, { sizeId: 'asc' }],
  });
  return rows.map((s: any) => ({
    id: s.id,
    facilityId: s.facilityId,
    facility: s.branch ? { id: s.branch.id, code: s.branch.code, name: s.branch.name } : null,
    sizeId: s.sizeId,
    unitSize: s.unitSize ? { id: s.unitSize.id, code: s.unitSize.code, name: s.unitSize.name } : null,
    minEffectiveRate: toNum(s.minEffectiveRate),
    requiresApprovalAbove: s.requiresApprovalAbove ? toNum(s.requiresApprovalAbove) : null,
    approverRole: s.approverRole,
  }));
}

export async function createSafeguard(input: {
  facilityId?: string; sizeId?: string; minEffectiveRate: number;
  requiresApprovalAbove?: number; approverRole?: string;
}) {
  const rule = await prisma.safeguardRule.create({
    data: {
      facilityId: input.facilityId, sizeId: input.sizeId,
      minEffectiveRate: input.minEffectiveRate,
      requiresApprovalAbove: input.requiresApprovalAbove,
      approverRole: input.approverRole,
    },
    include: { branch: true, unitSize: true },
  });
  return {
    id: rule.id,
    facilityId: rule.facilityId,
    facility: (rule as any).branch ? { id: (rule as any).branch.id, code: (rule as any).branch.code, name: (rule as any).branch.name } : null,
    sizeId: rule.sizeId,
    unitSize: (rule as any).unitSize ? { id: (rule as any).unitSize.id, code: (rule as any).unitSize.code, name: (rule as any).unitSize.name } : null,
    minEffectiveRate: toNum(rule.minEffectiveRate),
    requiresApprovalAbove: rule.requiresApprovalAbove ? toNum(rule.requiresApprovalAbove) : null,
    approverRole: rule.approverRole,
  };
}

export async function updateSafeguard(id: string, input: Partial<{
  facilityId?: string; sizeId?: string; minEffectiveRate: number;
  requiresApprovalAbove?: number; approverRole?: string;
}>) {
  const existing = await prisma.safeguardRule.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Safeguard rule ${id} not found`);
  const rule = await prisma.safeguardRule.update({
    where: { id }, data: input,
    include: { branch: true, unitSize: true },
  });
  return {
    id: rule.id,
    facilityId: rule.facilityId,
    facility: (rule as any).branch ? { id: (rule as any).branch.id, code: (rule as any).branch.code, name: (rule as any).branch.name } : null,
    sizeId: rule.sizeId,
    unitSize: (rule as any).unitSize ? { id: (rule as any).unitSize.id, code: (rule as any).unitSize.code, name: (rule as any).unitSize.name } : null,
    minEffectiveRate: toNum(rule.minEffectiveRate),
    requiresApprovalAbove: rule.requiresApprovalAbove ? toNum(rule.requiresApprovalAbove) : null,
    approverRole: rule.approverRole,
  };
}

export async function deleteSafeguard(id: string) {
  const existing = await prisma.safeguardRule.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Safeguard rule ${id} not found`);
  await prisma.safeguardRule.delete({ where: { id } });
  return { id };
}

// --- History: versions + restore-as-draft ---
//
// DIFFICULTY: version snapshots written before this change store only the
// *input delta* (create input, update input, or { status }) — not a full plan
// state — so old rows cannot restore nested cells/rules exactly. restoreVersion
// therefore applies whatever scalar + nested fields the snapshot carries and
// keeps current nested data otherwise; every restore forces status DRAFT, bumps
// version, and logs a new version row (Active/Ended rows are never mutated).
export async function listVersions(planId: string, opts?: { from?: Date; to?: Date }) {
  const plan = await prisma.promotionPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${planId} not found`);
  const createdAt: { gte?: Date; lte?: Date } = {};
  if (opts?.from) createdAt.gte = opts.from;
  if (opts?.to) createdAt.lte = opts.to;
  const rows = await prisma.promotionVersion.findMany({
    where: {
      planId,
      ...(createdAt.gte || createdAt.lte ? { createdAt } : {}),
    },
    orderBy: { version: 'desc' },
  });
  return rows.map((v) => ({
    id: v.id,
    planId: v.planId,
    version: v.version,
    snapshot: v.snapshot,
    changedBy: v.changedBy,
    changeSummary: v.changeSummary,
    createdAt: v.createdAt,
  }));
}

// Field-level diff between two version snapshots (used by the History Compare
// view). Compares only JSON-scalar keys present in either snapshot; nested
// arrays are compared by length + JSON hash, not per-row (per-row matrix diffs
// of 48 cells are follow-up).
export function diffSnapshots(a: unknown, b: unknown): { field: string; from: unknown; to: unknown }[] {
  const ra = (a ?? {}) as Record<string, unknown>;
  const rb = (b ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter((k) => k !== 'status');
  const out: { field: string; from: unknown; to: unknown }[] = [];
  for (const k of keys) {
    const va = JSON.stringify(ra[k] ?? null);
    const vb = JSON.stringify(rb[k] ?? null);
    if (va !== vb) out.push({ field: k, from: ra[k] ?? null, to: rb[k] ?? null });
  }
  return out;
}

export async function compareVersions(planId: string, fromVersion: number, toVersion: number) {
  const rows = await prisma.promotionVersion.findMany({
    where: { planId, version: { in: [fromVersion, toVersion] } },
  });
  if (rows.length < 2) throw new AppError(404, 'NOT_FOUND', 'One or both versions not found');
  const from = rows.find((r) => r.version === fromVersion)!;
  const to = rows.find((r) => r.version === toVersion)!;
  return {
    planId,
    from: { version: from.version, changedBy: from.changedBy, changeSummary: from.changeSummary, createdAt: from.createdAt },
    to: { version: to.version, changedBy: to.changedBy, changeSummary: to.changeSummary, createdAt: to.createdAt },
    diff: diffSnapshots(from.snapshot, to.snapshot),
  };
}

const RESTORABLE_SCALARS = [
  'name', 'code', 'description', 'effectiveFrom', 'effectiveTo',
  'facilityScope', 'storageType', 'sizeScope', 'appliesTo',
  'usagePerCustomer', 'redemptionCap', 'perUnitApplication', 'stackingRule',
  'budgetCap', 'freeMonthCount', 'commitmentMonths', 'earlyExitTreatment', 'minStayPct',
] as const;

export async function restoreVersion(planId: string, version: number, changedBy = 'Operator') {
  const plan = await prisma.promotionPlan.findUnique({ where: { id: planId }, include: INCLUDE });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${planId} not found`);
  const row = await prisma.promotionVersion.findUnique({
    where: { planId_version: { planId, version } },
  });
  if (!row) throw new AppError(404, 'NOT_FOUND', `Version ${version} of plan ${planId} not found`);
  // Restoring rewrites the plan as a DRAFT — never allowed on a live plan
  // (that would silently drop it from checkout and change it in place).
  if (plan.status === 'ACTIVE' || plan.status === 'SCHEDULED') {
    throw new AppError(409, 'PLAN_LOCKED',
      `Plan "${plan.name}" is ${plan.status} — ${plan.status === 'ACTIVE' ? 'disable' : 'move it back to draft'} first, then restore a version.`,
      { status: plan.status });
  }
  const snap = (row.snapshot ?? {}) as Record<string, unknown>;

  // Nested restores replace wholesale (same semantics as updatePlan).
  if (Array.isArray(snap.matrixCells)) {
    await prisma.discountMatrixCell.deleteMany({ where: { planId } });
  }
  if (Array.isArray(snap.freeMonths)) {
    await prisma.freeMonthAllocation.deleteMany({ where: { planId } });
  }
  if (Array.isArray(snap.rules)) {
    await prisma.promotionRule.deleteMany({ where: { planId } });
  }

  const data: Record<string, unknown> = { status: 'DRAFT' as PlanStatus, version: plan.version + 1 };
  for (const k of RESTORABLE_SCALARS) {
    if (snap[k] === undefined) continue;
    if ((k === 'effectiveFrom' || k === 'effectiveTo') && snap[k]) data[k] = new Date(String(snap[k]));
    else if (k === 'effectiveTo' && (snap[k] === null)) data[k] = null;
    else data[k] = snap[k] as unknown;
  }
  if (Array.isArray(snap.matrixCells)) {
    data.matrixCells = {
      // Re-canonicalize on restore so legacy XS snapshots restore as LOCKER;
      // collapse legacy/canonical twins sharing a post-normalization key
      // (P2002 → 500 fix, same as createPlan).
      create: normalizeMatrixCellsForWrite(
        (snap.matrixCells as any[]).map((c) => ({
          sizeCategory: String(c.sizeCategory),
          accessType: String(c.accessType),
          commitmentMonths: Number(c.commitmentMonths),
          discountPct: Number(c.discountPct),
        })),
      ),
    };
  }
  if (Array.isArray(snap.freeMonths)) {
    data.freeMonths = {
      create: (snap.freeMonths as any[]).map((f) => ({
        monthIndex: Number(f.monthIndex),
        free: Boolean(f.free),
        discountPct: f.discountPct != null ? Number(f.discountPct) : undefined,
      })),
    };
  }
  if (Array.isArray(snap.rules)) {
    data.rules = {
      create: (snap.rules as any[]).map((r) => ({
        groupId: Number(r.groupId ?? 0),
        field: String(r.field),
        operator: String(r.operator),
        value: String(r.value),
      })),
    };
  }

  const updated = await prisma.promotionPlan.update({ where: { id: planId }, data: data as any, include: INCLUDE });
  await prisma.promotionVersion.create({
    data: {
      planId,
      version: plan.version + 1,
      snapshot: { restoredFrom: version } as unknown as Prisma.InputJsonValue,
      changedBy,
      changeSummary: `Restored v${version} as new draft`,
    },
  });
  if (updated.kind === 'PROMO_CODE') {
    await syncLinkedPromotion(planId);
    return getPlan(planId);
  }
  return serialize(updated);
}

// --- Performance aggregation + redemptions ---
//
// Redemptions are recorded automatically by createCustomerBooking
// (core/customers.ts) for every booking a plan priced (2026-10-18); manual
// entries via POST /promotion-plans/:id/redemptions remain available.
export async function recordRedemption(
  planId: string,
  input: { bookingId?: string; code?: string; amount: number },
) {
  const plan = await prisma.promotionPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${planId} not found`);
  if (!(input.amount >= 0)) throw new AppError(400, 'VALIDATION', 'Redemption amount must be 0 or greater');
  if (input.bookingId) {
    const booking = await prisma.booking.findUnique({ where: { id: input.bookingId } });
    if (!booking) throw new AppError(404, 'NOT_FOUND', `Booking ${input.bookingId} not found`);
  }
  const row = await prisma.promotionRedemption.create({
    data: {
      planId,
      bookingId: input.bookingId,
      code: input.code,
      amount: input.amount,
    },
  });
  return {
    id: row.id,
    planId: row.planId,
    bookingId: row.bookingId,
    code: row.code,
    amount: toNum(row.amount),
    redeemedAt: row.redeemedAt,
    createdAt: row.createdAt,
  };
}

export async function listRedemptions(planId: string, opts?: { from?: Date; to?: Date }) {
  const plan = await prisma.promotionPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${planId} not found`);
  const redeemedAt: { gte?: Date; lte?: Date } = {};
  if (opts?.from) redeemedAt.gte = opts.from;
  if (opts?.to) redeemedAt.lte = opts.to;
  const rows = await prisma.promotionRedemption.findMany({
    where: {
      planId,
      ...(redeemedAt.gte || redeemedAt.lte ? { redeemedAt } : {}),
    },
    orderBy: { redeemedAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    planId: r.planId,
    bookingId: r.bookingId,
    code: r.code,
    amount: toNum(r.amount),
    redeemedAt: r.redeemedAt,
    createdAt: r.createdAt,
  }));
}

// Per-plan performance: applied count + discount cost from redemptions, caps
// and budget utilisation from plan fields. Revenue/retention need invoice +
// tenant-tenure joins (follow-up — returned as null, never fabricated).
export async function getPerformance() {
  const plans = await prisma.promotionPlan.findMany({
    include: { redemptions: true },
    orderBy: { createdAt: 'desc' },
  });
  const perPlan = plans.map((p) => {
    const applied = p.redemptions.length;
    const discountCost = p.redemptions.reduce((s, r) => s + toNum(r.amount), 0);
    const budgetCap = p.budgetCap != null ? toNum(p.budgetCap) : null;
    return {
      planId: p.id,
      planName: p.name,
      kind: p.kind,
      status: p.status,
      applied,
      eligibleBookings: null as number | null,
      bookedRevenue: null as number | null,
      discountCost,
      effectiveRate: null as number | null,
      retention: null as number | null,
      redemptionCap: p.redemptionCap,
      capUsedPct: p.redemptionCap ? Math.round((applied / p.redemptionCap) * 100) : null,
      budgetCap,
      budgetUsedPct: budgetCap ? Math.round((discountCost / budgetCap) * 100) : null,
    };
  });
  const totals = {
    plans: plans.length,
    activePlans: plans.filter((p) => p.status === 'ACTIVE' || p.status === 'SCHEDULED').length,
    totalRedemptions: perPlan.reduce((s, p) => s + p.applied, 0),
    totalDiscountCost: perPlan.reduce((s, p) => s + p.discountCost, 0),
  };
  return { plans: perPlan, totals };
}

// --- Public booking surface (additive) ---
//
// GET /api/v1/public/promotion-plans exposes the ACTIVE Discount Plan matrix
// to the booking frontend so Expected Stay tiles (size × 1/3/6/12 months) can
// apply it. Served from the existing PromotionPlan / DiscountMatrixCell rows
// (no schema change): ACTIVE plans only — DRAFT / SCHEDULED / ENDED are
// excluded — and an honest empty array when no plan is ACTIVE. Cells carry
// sizeCategory + commitmentMonths + discountPct (accessType rides along so the
// frontend can disambiguate the two access tiers sharing a size × month key).
// No auth, no PII, no CMS behaviour change.
export async function listActivePublicPromotionPlans() {
  await syncPlanSchedule();
  const now = new Date();
  const rows = await prisma.promotionPlan.findMany({
    // Live plans only: ACTIVE and inside the effective window (2026-10-18).
    where: {
      status: 'ACTIVE',
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    include: { matrixCells: true, freeMonths: true, rules: true },
    orderBy: { createdAt: 'asc' },
  });
  const branches = await prisma.branch.findMany({ select: { id: true, code: true } });
  const codeOf = new Map(branches.map((b) => [b.id, b.code]));
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    // --- additive scope fields (booking parity for scoped plans) ---
    kind: p.kind,
    effectiveFrom: p.effectiveFrom,
    effectiveTo: p.effectiveTo,
    // Branch codes the plan covers; null = every facility.
    facilities: (() => {
      const scope = Array.isArray(p.facilityScope) ? (p.facilityScope as unknown[]).map(String) : ['ALL'];
      return scope.length === 0 || scope.some((f) => /^all$/i.test(f)) ? null : scope.map((f) => codeOf.get(f) ?? f);
    })(),
    // Floor ids the plan is limited to; null = every floor.
    floors: (() => {
      const f = p.rules.filter((r) => r.field === 'floor' && r.operator === 'equals').map((r) => r.value);
      return f.length ? f : null;
    })(),
    ...(p.kind === 'FREE_MONTHS'
      ? {
          freeMonths: {
            commitmentMonths: p.commitmentMonths,
            sizes: Array.isArray(p.sizeScope) && !(p.sizeScope as unknown[]).some((x) => /^all$/i.test(String(x)))
              ? (p.sizeScope as unknown[]).map((x) => toCanonicalSizeCategory(x))
              : null,
            // 1-based month numbers that are rent-free.
            months: p.freeMonths.filter((f) => f.free).map((f) => f.monthIndex + 1).sort((a, b) => a - b),
          },
        }
      : {}),
    cells: p.matrixCells
      .map((c) => ({
        // Canonical on the wire; legacy XS rows read as LOCKER.
        sizeCategory: toCanonicalSizeCategory(c.sizeCategory),
        commitmentMonths: c.commitmentMonths,
        discountPct: toNum(c.discountPct),
        accessType: c.accessType,
      }))
      .sort(
        (a, b) =>
          a.commitmentMonths - b.commitmentMonths ||
          (a.sizeCategory < b.sizeCategory ? -1 : a.sizeCategory > b.sizeCategory ? 1 : 0) ||
          (a.accessType < b.accessType ? -1 : a.accessType > b.accessType ? 1 : 0),
      ),
  }));
}
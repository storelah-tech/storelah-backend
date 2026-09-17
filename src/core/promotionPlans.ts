import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { PlanKind, PlanStatus, Prisma } from '@prisma/client';

export interface CellInput { sizeCategory: string; accessType: string; commitmentMonths: number; discountPct: number }
export interface FreeInput { monthIndex: number; free: boolean; discountPct?: number }
export interface RuleInput { groupId: number; field: string; operator: string; value: string }

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
}

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
    matrixCells: (plan.matrixCells || []).map((c: any) => ({
      id: c.id,
      sizeCategory: c.sizeCategory,
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

export async function createPlan(input: PlanInput) {
  if (input.code) {
    const existing = await prisma.promotionPlan.findUnique({ where: { code: input.code } });
    if (existing) throw new AppError(409, 'CONFLICT', `Plan code ${input.code} already exists`);
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
        create: input.matrixCells.map(c => ({
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

  return serialize(plan);
}

export async function updatePlan(id: string, input: Partial<PlanInput>) {
  const existing = await prisma.promotionPlan.findUnique({ where: { id }, include: INCLUDE });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${id} not found`);

  if (input.code && input.code !== existing.code) {
    const clash = await prisma.promotionPlan.findUnique({ where: { code: input.code } });
    if (clash) throw new AppError(409, 'CONFLICT', `Plan code ${input.code} already exists`);
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
        create: input.matrixCells.map(c => ({
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

  return serialize(plan);
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
//   ACTIVE → DRAFT is FORBIDDEN (a live plan must END, never silently revert);
//   ENDED is terminal (restore-as-draft creates a NEW draft version instead).
// - Any other edge (e.g. DRAFT → ACTIVE, DRAFT → SCHEDULED, ENDED → anything)
//   is rejected with 400 INVALID_TRANSITION.
const PLAN_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  DRAFT: ['VALIDATED'],
  VALIDATED: ['SCHEDULED', 'DRAFT'],
  SCHEDULED: ['ACTIVE', 'ENDED', 'DRAFT'],
  ACTIVE: ['ENDED'],
  ENDED: [],
};

export function allowedTransitions(from: PlanStatus): PlanStatus[] {
  return PLAN_TRANSITIONS[from] ?? [];
}

export async function setPlanStatus(
  id: string,
  status: PlanStatus,
  opts?: { changedBy?: string; approverRole?: string; actorId?: string },
) {
  const existing = await prisma.promotionPlan.findUnique({ where: { id }, include: INCLUDE });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${id} not found`);

  const from = existing.status as PlanStatus;
  if (from !== status && !allowedTransitions(from).includes(status)) {
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
  if ((status === 'SCHEDULED' || status === 'ACTIVE') && from !== status && opts?.actorId) {
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

  const changedBy = opts?.changedBy ?? 'Operator';
  const newVersion = existing.version + 1;

  const plan = await prisma.promotionPlan.update({
    where: { id },
    data: { status, version: newVersion },
    include: INCLUDE,
  });

  await prisma.promotionVersion.create({
    data: {
      planId: id,
      version: newVersion,
      snapshot: { status, approverRole: opts?.approverRole ?? null } as unknown as Prisma.InputJsonValue,
      changedBy,
      changeSummary: `Status changed from ${from} to ${status}` +
        (opts?.approverRole ? ` (approver role: ${opts.approverRole})` : ''),
    },
  });

  return serialize(plan);
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
      matrixCells: existing.matrixCells.length ? {
        create: existing.matrixCells.map(c => ({
          sizeCategory: c.sizeCategory,
          accessType: c.accessType,
          commitmentMonths: c.commitmentMonths,
          discountPct: c.discountPct,
        })),
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
  await prisma.promotionPlan.delete({ where: { id } });
  return { id };
}

export interface PlanCheck { status: 'pass' | 'warning' | 'blocker'; message: string }
export interface SampleBooking { unitCode: string; branch: string; monthlyRate: number; months: number; baseTotal: number; discountTotal: number; effectiveTotal: number; effectiveRate: number; note: string }
export interface PlanOverlap { planId: string; planName: string; status: string; effectiveFrom: Date; effectiveTo: Date | null }

// DIFFICULTY LOG (validation engine simplifications — see return Note):
// 1. Rate floors are per (facility, size) but matrix cells are per (size
//    CATEGORY, access, commitment) and UnitSize codes (LOCKER/SMALL/...) do not
//    map 1:1 to categories (XS–XXL). So floors are applied against a
//    REPRESENTATIVE base rate (median available-unit monthlyRate, fallback $300)
//    rather than per-unit exact pricing. A global safeguard (null facility/size)
//    applies to every plan; a scoped one applies when the plan scope includes
//    ALL or overlaps textually — approximate, documented in each check message.
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
    if (plan.rules.length === 0) push('warning', 'No eligibility rules defined — plan applies to all');
    else push('pass', `${plan.rules.length} eligibility rule(s) defined`);
  }

  // --- 2. Rate-floor checks vs SafeguardRule ---
  const safeguards = await prisma.safeguardRule.findMany({ include: { branch: true, unitSize: true } });
  if (safeguards.length && headlinePct > 0) {
    // Representative base: median monthlyRate of available units, else $300.
    const rateRows = await prisma.unit.findMany({
      where: { deletedAt: null, status: 'AVAILABLE' },
      select: { monthlyRate: true },
      take: 200,
    });
    const rates = rateRows.map((r) => toNum(r.monthlyRate)).sort((a, b) => a - b);
    const base = rates.length ? rates[Math.floor(rates.length / 2)] : 300;
    const facilityScope = (plan.facilityScope as unknown as string[]) ?? ['ALL'];
    const inScope = (ruleBranchCode: string | null) =>
      !ruleBranchCode || facilityScope.includes('ALL') || facilityScope.includes(ruleBranchCode);
    for (const s of safeguards) {
      const code = (s as any).branch?.code ?? null;
      if (!inScope(code)) continue;
      const floor = toNum(s.minEffectiveRate);
      const effective = base * (1 - headlinePct / 100);
      const scopeLabel = code ? `facility ${code}` : 'global floor';
      if (effective < floor) {
        push('blocker', `Rate floor breach (${scopeLabel}): ${headlinePct}% off $${base}/mo → $${effective.toFixed(2)} below $${floor}/mo floor`);
      } else {
        push('pass', `Rate floor holds (${scopeLabel}): $${effective.toFixed(2)} ≥ $${floor}/mo floor at $${base}/mo base`);
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
// of 36 cells are follow-up).
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
      create: (snap.matrixCells as any[]).map((c) => ({
        sizeCategory: String(c.sizeCategory),
        accessType: String(c.accessType),
        commitmentMonths: Number(c.commitmentMonths),
        discountPct: Number(c.discountPct),
      })),
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
  return serialize(updated);
}

// --- Performance aggregation + redemptions ---
//
// DIFFICULTY: there is no booking-create route in the CMS (bookings are read
// via core/finance.ts listBookings; creation happens in the booking app), so
// no server-side hook could auto-link bookings → plans. Redemptions are
// therefore recorded explicitly via POST /promotion-plans/:id/redemptions
// (operator or booking-app client). Wiring auto-link at booking time is a
// follow-up once a booking-create path exists in this service.
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
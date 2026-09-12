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

export async function listPlans() {
  const rows = await prisma.promotionPlan.findMany({ include: INCLUDE, orderBy: { createdAt: 'desc' } });
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

export async function setPlanStatus(id: string, status: PlanStatus) {
  const existing = await prisma.promotionPlan.findUnique({ where: { id }, include: INCLUDE });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${id} not found`);

  const plan = await prisma.promotionPlan.update({
    where: { id },
    data: { status },
    include: INCLUDE,
  });

  await prisma.promotionVersion.create({
    data: {
      planId: id,
      version: existing.version + 1,
      snapshot: { status } as unknown as Prisma.InputJsonValue,
      changedBy: 'Operator',
      changeSummary: `Status changed to ${status}`,
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

export async function validatePlan(id: string) {
  const plan = await prisma.promotionPlan.findUnique({
    where: { id },
    include: { matrixCells: true, freeMonths: true, rules: true },
  });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `Promotion plan ${id} not found`);

  let blockers = 0;
  let warnings = 0;
  const checks: { status: string; message: string }[] = [];

  if (!plan.name || plan.name.trim().length === 0) { blockers++; checks.push({ status: 'blocker', message: 'Plan name is required' }); }
  if (!plan.effectiveFrom) { blockers++; checks.push({ status: 'blocker', message: 'Effective from date is required' }); }

  if (plan.kind === 'DISCOUNT_MATRIX') {
    const cells = plan.matrixCells;
    if (cells.length === 0) { blockers++; checks.push({ status: 'blocker', message: 'Discount matrix must have at least one cell' }); }
    checks.push({ status: 'pass', message: `${cells.length} matrix cells defined` });
  }

  if (plan.kind === 'FREE_MONTHS') {
    if (!plan.freeMonthCount || plan.freeMonthCount < 1) { blockers++; checks.push({ status: 'blocker', message: 'Free month count must be at least 1' }); }
    if (!plan.commitmentMonths || plan.commitmentMonths < 1) { blockers++; checks.push({ status: 'blocker', message: 'Commitment months must be specified' }); }
    if (!blockers) checks.push({ status: 'pass', message: `${plan.freeMonthCount} free months over ${plan.commitmentMonths} months` });
  }

  if (plan.kind === 'PROMO_CODE') {
    if (!plan.code) { blockers++; checks.push({ status: 'blocker', message: 'Promo code is required for PROMO_CODE plans' }); }
    if (plan.rules.length === 0) { warnings++; checks.push({ status: 'warning', message: 'No eligibility rules defined — plan applies to all' }); }
    checks.push({ status: 'pass', message: `${plan.rules.length} eligibility rule(s) defined` });
  }

  return {
    valid: blockers === 0, blockers, warnings, checks,
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
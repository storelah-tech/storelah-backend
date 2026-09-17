import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { Prisma, PreventiveCategory, WorkOrderStatus } from '@prisma/client';

type WorkOrderRow = Prisma.WorkOrderGetPayload<{
  include: { branch: { select: { code: true; name: true } }; unit: { select: { unitCode: true } } };
}>;

function serializeWorkOrder(w: WorkOrderRow) {
  return {
    id: w.id,
    title: w.title,
    description: w.description,
    branchId: w.branchId,
    branchCode: w.branch?.code ?? null,
    branchName: w.branch?.name ?? null,
    unitId: w.unitId,
    unitCode: w.unit?.unitCode ?? null,
    status: w.status,
    priority: w.priority,
    value: toNum(w.value),
    assignee: w.assignee,
    dueDate: w.dueDate,
    completedAt: w.completedAt,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export interface CreateWorkOrderInput {
  title: string;
  description?: string | null;
  branchId?: string | null;
  unitId?: string | null;
  status?: WorkOrderStatus;
  priority?: string | null;
  value?: number;
  assignee?: string | null;
  dueDate?: Date | null;
}

export interface UpdateWorkOrderInput {
  title?: string;
  description?: string | null;
  branchId?: string | null;
  unitId?: string | null;
  status?: WorkOrderStatus;
  priority?: string | null;
  value?: number;
  assignee?: string | null;
  dueDate?: Date | null;
}

async function assertWorkOrderRefs(branchId?: string | null, unitId?: string | null) {
  if (branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${branchId} not found`);
  }
  if (unitId) {
    // Soft-delete-aware: a deleted unit is not addressable.
    const unit = await prisma.unit.findUnique({ where: { id: unitId, deletedAt: null } });
    if (!unit) throw new AppError(400, 'VALIDATION', `Unit ${unitId} not found`);
  }
}

const WORK_ORDER_INCLUDE = {
  branch: { select: { code: true, name: true } },
  unit: { select: { unitCode: true } },
} as const;

export async function listWorkOrders(query: { status?: string; branchId?: string } = {}) {
  const where: Prisma.WorkOrderWhereInput = {
    ...(query.status ? { status: query.status as WorkOrderStatus } : {}),
    ...(query.branchId ? { branchId: query.branchId } : {}),
  };
  const rows = await prisma.workOrder.findMany({
    where,
    include: WORK_ORDER_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(serializeWorkOrder);
}

export async function getWorkOrder(id: string) {
  const row = await prisma.workOrder.findUnique({ where: { id }, include: WORK_ORDER_INCLUDE });
  if (!row) throw new AppError(404, 'NOT_FOUND', `Work order ${id} not found`);
  return serializeWorkOrder(row);
}

export async function createWorkOrder(input: CreateWorkOrderInput) {
  await assertWorkOrderRefs(input.branchId ?? null, input.unitId ?? null);
  const row = await prisma.workOrder.create({
    data: {
      title: input.title,
      description: input.description ?? null,
      branchId: input.branchId ?? null,
      unitId: input.unitId ?? null,
      status: input.status ?? 'OPEN',
      priority: input.priority ?? null,
      value: input.value ?? 0,
      assignee: input.assignee ?? null,
      dueDate: input.dueDate ?? null,
      completedAt: input.status === 'DONE' ? new Date() : null,
    },
    include: WORK_ORDER_INCLUDE,
  });
  return serializeWorkOrder(row);
}

export async function updateWorkOrder(id: string, input: UpdateWorkOrderInput) {
  const existing = await prisma.workOrder.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Work order ${id} not found`);
  await assertWorkOrderRefs(
    input.branchId === undefined ? null : input.branchId,
    input.unitId === undefined ? null : input.unitId,
  );
  const nextStatus = input.status ?? existing.status;
  const row = await prisma.workOrder.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      // Status transition bookkeeping: entering DONE stamps completedAt,
      // reopening clears it.
      ...(input.status !== undefined
        ? { completedAt: nextStatus === 'DONE' ? existing.completedAt ?? new Date() : null }
        : {}),
    },
    include: WORK_ORDER_INCLUDE,
  });
  return serializeWorkOrder(row);
}

export async function deleteWorkOrder(id: string) {
  const existing = await prisma.workOrder.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Work order ${id} not found`);
  await prisma.workOrder.delete({ where: { id } });
  return { id };
}

// --- Preventive checklist tasks (HVAC / Fire / Doors / CCTV % complete) ---

type PreventiveRow = Prisma.PreventiveTaskGetPayload<{
  include: { branch: { select: { code: true; name: true } } };
}>;

function serializePreventiveTask(t: PreventiveRow) {
  return {
    id: t.id,
    title: t.title,
    category: t.category,
    branchId: t.branchId,
    branchCode: t.branch?.code ?? null,
    branchName: t.branch?.name ?? null,
    percentComplete: t.percentComplete,
    dueDate: t.dueDate,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export interface CreatePreventiveTaskInput {
  title: string;
  category: PreventiveCategory;
  branchId?: string | null;
  percentComplete?: number;
  dueDate?: Date | null;
}

export interface UpdatePreventiveTaskInput {
  title?: string;
  category?: PreventiveCategory;
  branchId?: string | null;
  percentComplete?: number;
  dueDate?: Date | null;
}

const PREVENTIVE_INCLUDE = { branch: { select: { code: true, name: true } } } as const;

export async function listPreventiveTasks(query: { category?: string; branchId?: string } = {}) {
  const rows = await prisma.preventiveTask.findMany({
    where: {
      ...(query.category ? { category: query.category as PreventiveCategory } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
    },
    include: PREVENTIVE_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(serializePreventiveTask);
}

// % complete per category (HVAC / Fire / Doors / CCTV) for the dashboard.
export async function getPreventiveProgress(branchId?: string) {
  const rows = await prisma.preventiveTask.findMany({
    where: { ...(branchId ? { branchId } : {}) },
    select: { category: true, percentComplete: true },
  });
  const byCategory: Record<string, { tasks: number; total: number }> = {};
  for (const r of rows) {
    const slot = (byCategory[r.category] ??= { tasks: 0, total: 0 });
    slot.tasks += 1;
    slot.total += r.percentComplete;
  }
  return (Object.keys(PreventiveCategory) as (keyof typeof PreventiveCategory)[]).map((category) => {
    const slot = byCategory[category];
    return {
      category,
      tasks: slot?.tasks ?? 0,
      percentComplete: slot?.tasks ? Math.round((slot.total / slot.tasks) * 10) / 10 : 0,
    };
  });
}

export async function createPreventiveTask(input: CreatePreventiveTaskInput) {
  if (input.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  }
  if (input.percentComplete != null && (input.percentComplete < 0 || input.percentComplete > 100)) {
    throw new AppError(400, 'VALIDATION', 'percentComplete must be 0..100');
  }
  const row = await prisma.preventiveTask.create({
    data: {
      title: input.title,
      category: input.category,
      branchId: input.branchId ?? null,
      percentComplete: input.percentComplete ?? 0,
      dueDate: input.dueDate ?? null,
    },
    include: PREVENTIVE_INCLUDE,
  });
  return serializePreventiveTask(row);
}

export async function updatePreventiveTask(id: string, input: UpdatePreventiveTaskInput) {
  const existing = await prisma.preventiveTask.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Preventive task ${id} not found`);
  if (input.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  }
  if (input.percentComplete != null && (input.percentComplete < 0 || input.percentComplete > 100)) {
    throw new AppError(400, 'VALIDATION', 'percentComplete must be 0..100');
  }
  const row = await prisma.preventiveTask.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...(input.percentComplete !== undefined ? { percentComplete: input.percentComplete } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
    },
    include: PREVENTIVE_INCLUDE,
  });
  return serializePreventiveTask(row);
}

export async function deletePreventiveTask(id: string) {
  const existing = await prisma.preventiveTask.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Preventive task ${id} not found`);
  await prisma.preventiveTask.delete({ where: { id } });
  return { id };
}

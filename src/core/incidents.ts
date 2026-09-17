import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { IncidentSeverity, IncidentStatus, Prisma } from '@prisma/client';

type IncidentRow = Prisma.IncidentGetPayload<{
  include: {
    branch: { select: { code: true; name: true } };
    unit: { select: { unitCode: true } };
  };
}>;

function serializeIncident(i: IncidentRow) {
  const checklist = Array.isArray(i.checklist) ? i.checklist : [];
  const steps = checklist.length;
  const doneSteps = checklist.filter(
    (s) => typeof s === 'object' && s !== null && (s as { done?: unknown }).done === true,
  ).length;
  return {
    id: i.id,
    title: i.title,
    description: i.description,
    severity: i.severity,
    status: i.status,
    branchId: i.branchId,
    branchCode: i.branch?.code ?? null,
    branchName: i.branch?.name ?? null,
    unitId: i.unitId,
    unitCode: i.unit?.unitCode ?? null,
    checklist: i.checklist ?? [],
    checklistProgress: steps ? Math.round((doneSteps / steps) * 1000) / 10 : 0,
    reportedBy: i.reportedBy,
    resolvedAt: i.resolvedAt,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

export interface CreateIncidentInput {
  title: string;
  description?: string | null;
  severity?: IncidentSeverity;
  status?: IncidentStatus;
  branchId?: string | null;
  unitId?: string | null;
  checklist?: unknown;
  reportedBy?: string | null;
}

export interface UpdateIncidentInput {
  title?: string;
  description?: string | null;
  severity?: IncidentSeverity;
  status?: IncidentStatus;
  branchId?: string | null;
  unitId?: string | null;
  checklist?: unknown;
  reportedBy?: string | null;
}

const INCIDENT_INCLUDE = {
  branch: { select: { code: true, name: true } },
  unit: { select: { unitCode: true } },
} as const;

async function assertIncidentRefs(branchId?: string | null, unitId?: string | null) {
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

export async function listIncidents(query: { severity?: string; status?: string; branchId?: string } = {}) {
  const rows = await prisma.incident.findMany({
    where: {
      ...(query.severity ? { severity: query.severity as IncidentSeverity } : {}),
      ...(query.status ? { status: query.status as IncidentStatus } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
    },
    include: INCIDENT_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(serializeIncident);
}

export async function getIncident(id: string) {
  const row = await prisma.incident.findUnique({ where: { id }, include: INCIDENT_INCLUDE });
  if (!row) throw new AppError(404, 'NOT_FOUND', `Incident ${id} not found`);
  return serializeIncident(row);
}

export async function createIncident(input: CreateIncidentInput) {
  await assertIncidentRefs(input.branchId ?? null, input.unitId ?? null);
  const status = input.status ?? 'OPEN';
  const row = await prisma.incident.create({
    data: {
      title: input.title,
      description: input.description ?? null,
      severity: input.severity ?? 'MEDIUM',
      status,
      branchId: input.branchId ?? null,
      unitId: input.unitId ?? null,
      checklist: input.checklist === undefined ? [] : (input.checklist as Prisma.InputJsonValue),
      reportedBy: input.reportedBy ?? null,
      resolvedAt: status === 'RESOLVED' || status === 'CLOSED' ? new Date() : null,
    },
    include: INCIDENT_INCLUDE,
  });
  return serializeIncident(row);
}

export async function updateIncident(id: string, input: UpdateIncidentInput) {
  const existing = await prisma.incident.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Incident ${id} not found`);
  await assertIncidentRefs(
    input.branchId === undefined ? null : input.branchId,
    input.unitId === undefined ? null : input.unitId,
  );
  const nextStatus = input.status ?? existing.status;
  const row = await prisma.incident.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
      ...(input.checklist !== undefined
        ? { checklist: input.checklist as Prisma.InputJsonValue }
        : {}),
      ...(input.reportedBy !== undefined ? { reportedBy: input.reportedBy } : {}),
      // Status transition bookkeeping: entering RESOLVED/CLOSED stamps
      // resolvedAt, reopening clears it.
      ...(input.status !== undefined
        ? {
            resolvedAt:
              nextStatus === 'RESOLVED' || nextStatus === 'CLOSED'
                ? existing.resolvedAt ?? new Date()
                : null,
          }
        : {}),
    },
    include: INCIDENT_INCLUDE,
  });
  return serializeIncident(row);
}

export async function deleteIncident(id: string) {
  const existing = await prisma.incident.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Incident ${id} not found`);
  await prisma.incident.delete({ where: { id } });
  return { id };
}

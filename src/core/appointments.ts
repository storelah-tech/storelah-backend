import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { AppointmentStatus, AppointmentType, Prisma } from '@prisma/client';

export async function listAppointments(from?: Date, to?: Date) {
  const where: Record<string, unknown> = {};
  if (from || to) {
    const startAt: Record<string, Date> = {};
    if (from) startAt.gte = from;
    if (to) startAt.lte = to;
    where.startAt = startAt;
  }

  const rows = await prisma.appointment.findMany({
    where,
    include: {
      branch: { select: { code: true, name: true } },
    },
    orderBy: { startAt: 'asc' },
  });

  return rows.map((a) => ({
    id: a.id,
    title: a.title,
    personName: a.personName,
    type: a.type,
    branchCode: a.branch?.code ?? null,
    branchName: a.branch?.name ?? null,
    startAt: a.startAt,
    endAt: a.endAt,
    status: a.status,
    note: a.note,
    leadId: a.leadId,
  }));
}

export async function getTodaysAppointments() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return listAppointments(startOfDay, endOfDay);
}

export interface CreateAppointmentInput {
  title: string;
  personName: string;
  type: AppointmentType;
  branchId?: string | null;
  leadId?: string | null;
  startAt: Date;
  endAt?: Date | null;
  note?: string | null;
}

export interface UpdateAppointmentInput {
  title?: string;
  personName?: string;
  type?: AppointmentType;
  status?: AppointmentStatus;
  branchId?: string | null;
  leadId?: string | null;
  startAt?: Date;
  endAt?: Date | null;
  note?: string | null;
}

type AppointmentRow = Prisma.AppointmentGetPayload<{
  include: { branch: { select: { code: true; name: true } } };
}>;

function serializeAppointment(a: AppointmentRow) {
  return {
    id: a.id,
    title: a.title,
    personName: a.personName,
    type: a.type,
    branchId: a.branchId,
    branchCode: a.branch?.code ?? null,
    branchName: a.branch?.name ?? null,
    startAt: a.startAt,
    endAt: a.endAt,
    status: a.status,
    note: a.note,
    leadId: a.leadId,
  };
}

async function assertAppointmentRefs(branchId?: string | null, leadId?: string | null) {
  if (branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', 'Unknown branchId');
  }
  if (leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new AppError(400, 'VALIDATION', 'Unknown leadId');
  }
}

export async function createAppointment(input: CreateAppointmentInput) {
  await assertAppointmentRefs(input.branchId ?? null, input.leadId ?? null);
  if (input.endAt && input.endAt <= input.startAt) {
    throw new AppError(400, 'VALIDATION', 'endAt must be after startAt');
  }
  const row = await prisma.appointment.create({
    data: {
      title: input.title,
      personName: input.personName,
      type: input.type,
      branchId: input.branchId ?? null,
      leadId: input.leadId ?? null,
      startAt: input.startAt,
      endAt: input.endAt ?? null,
      note: input.note ?? null,
    },
    include: { branch: { select: { code: true, name: true } } },
  });
  return serializeAppointment(row);
}

export async function updateAppointment(id: string, input: UpdateAppointmentInput) {
  const existing = await prisma.appointment.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
  await assertAppointmentRefs(
    input.branchId === undefined ? null : input.branchId,
    input.leadId === undefined ? null : input.leadId,
  );
  const startAt = input.startAt ?? existing.startAt;
  const endAt = input.endAt === undefined ? existing.endAt : input.endAt;
  if (endAt && endAt <= startAt) {
    throw new AppError(400, 'VALIDATION', 'endAt must be after startAt');
  }
  const row = await prisma.appointment.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.personName !== undefined ? { personName: input.personName } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...(input.leadId !== undefined ? { leadId: input.leadId } : {}),
      ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
      ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
    include: { branch: { select: { code: true, name: true } } },
  });
  return serializeAppointment(row);
}

export async function deleteAppointment(id: string) {
  const existing = await prisma.appointment.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
  await prisma.appointment.delete({ where: { id } });
  return { id };
}

// --- Overlap warning (non-blocking) ---
// Drag-drop reschedules (and the schedule form) only send startAt/endAt, so a
// move can land on top of another appointment. That is allowed — ops may
// double-book deliberately — but callers should warn. Resolved intervals use
// endAt when set, otherwise a 60-min default duration. Cancelled appointments
// never conflict. Same-branch only (branchId null matches branchId null).
export const DEFAULT_APPOINTMENT_MINUTES = 60;

export interface AppointmentConflict {
  id: string;
  title: string;
  personName: string;
  startAt: Date;
  endAt: Date | null;
}

function resolveEnd(startAt: Date, endAt: Date | null): Date {
  return endAt ?? new Date(startAt.getTime() + DEFAULT_APPOINTMENT_MINUTES * 60000);
}

export async function findAppointmentConflicts(
  branchId: string | null,
  startAt: Date,
  endAt: Date | null,
  excludeId?: string,
): Promise<AppointmentConflict[]> {
  const rows = await prisma.appointment.findMany({
    where: {
      ...(excludeId ? { id: { not: excludeId } } : {}),
      status: { not: 'CANCELLED' },
      branchId,
    },
    select: { id: true, title: true, personName: true, startAt: true, endAt: true },
  });
  const end = resolveEnd(startAt, endAt);
  return rows
    .filter((r) => startAt < resolveEnd(r.startAt, r.endAt) && r.startAt < end)
    .map((r) => ({ id: r.id, title: r.title, personName: r.personName, startAt: r.startAt, endAt: r.endAt }));
}

import { prisma } from '../lib/prisma';

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

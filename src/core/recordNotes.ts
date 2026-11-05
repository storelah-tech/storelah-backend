// Record notes with @mentions (prototype 2026-11-04: lead notes, customer
// notes, task instructions). The note editor's typeahead sends the mentioned
// operators' ids; each one gets a StaffNotification shown in the top bar.

import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';

export const NOTE_ENTITIES = ['lead', 'tenant'] as const;
export type NoteEntity = (typeof NOTE_ENTITIES)[number];

async function assertEntity(entityType: NoteEntity, entityId: string) {
  const found = entityType === 'lead'
    ? await prisma.lead.findUnique({ where: { id: entityId }, select: { id: true, name: true } })
    : await prisma.tenant.findUnique({ where: { id: entityId }, select: { id: true, name: true } });
  if (!found) throw new AppError(404, 'NOT_FOUND', `${entityType} ${entityId} not found`);
  return found;
}

/** Operators that can be @mentioned (active accounts only). */
export async function listMentionableUsers() {
  const users = await prisma.adminUser.findMany({
    where: { activatedAt: { not: null } },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  });
  return users.map((u) => ({ id: u.id, name: u.name, email: u.email }));
}

export async function listNotes(entityType: NoteEntity, entityId: string) {
  await assertEntity(entityType, entityId);
  return prisma.recordNote.findMany({ where: { entityType, entityId }, orderBy: { createdAt: 'desc' } });
}

export async function addNote(opts: { entityType: NoteEntity; entityId: string; body: string; mentionIds: string[]; author: string }) {
  const record = await assertEntity(opts.entityType, opts.entityId);
  const body = opts.body.trim();
  if (!body) throw new AppError(400, 'VALIDATION', 'Write a note first.');
  const ids = [...new Set(opts.mentionIds)];
  const users = ids.length ? await prisma.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  if (users.length !== ids.length) throw new AppError(400, 'VALIDATION', 'A mentioned user no longer exists.');
  return prisma.$transaction(async (tx) => {
    const note = await tx.recordNote.create({
      data: {
        entityType: opts.entityType,
        entityId: opts.entityId,
        body,
        author: opts.author.slice(0, 120),
        mentions: users.length ? users.map((u) => ({ userId: u.id, name: u.name })) : undefined,
      },
    });
    if (users.length) {
      await tx.staffNotification.createMany({
        data: users.map((u) => ({
          recipientId: u.id,
          kind: 'MENTION',
          title: `${opts.author} mentioned you on ${record.name}`,
          body: body.slice(0, 500),
          entityType: opts.entityType,
          entityId: opts.entityId,
          actor: opts.author.slice(0, 120),
        })),
      });
    }
    return { ...note, notified: users.map((u) => u.name) };
  });
}

export async function listMyNotifications(userId: string) {
  const [rows, unread] = await Promise.all([
    prisma.staffNotification.findMany({ where: { recipientId: userId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.staffNotification.count({ where: { recipientId: userId, readAt: null } }),
  ]);
  return { unread, rows };
}

export async function markNotificationsRead(userId: string, ids?: string[]) {
  const res = await prisma.staffNotification.updateMany({
    where: { recipientId: userId, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  });
  return { updated: res.count };
}

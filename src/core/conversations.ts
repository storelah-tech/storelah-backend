import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { ConversationChannel, MessageDirection, Prisma } from '@prisma/client';

type ThreadRow = Prisma.ConversationGetPayload<{
  include: {
    lead: { include: { branch: true } };
    messages: true;
    _count: { select: { messages: true; notes: true } };
  };
}>;

function serializeThread(c: ThreadRow) {
  const sorted = [...c.messages].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  const last = sorted[0] ?? null;
  return {
    id: c.id,
    leadId: c.leadId,
    leadName: c.lead.name,
    leadStage: c.lead.stage,
    leadSource: c.lead.source,
    branchCode: c.lead.branch?.code ?? '',
    branchName: c.lead.branch?.name ?? '',
    channel: c.channel,
    externalId: c.externalId,
    assignee: c.assignee,
    status: c.status,
    messageCount: c._count.messages,
    noteCount: c._count.notes,
    lastMessage: last
      ? { direction: last.direction, sender: last.sender, body: last.body, sentAt: last.sentAt }
      : null,
    updatedAt: c.updatedAt,
    createdAt: c.createdAt,
  };
}

export async function listConversations(status?: string) {
  const rows = await prisma.conversation.findMany({
    where: status ? { status } : undefined,
    include: {
      lead: { include: { branch: true } },
      messages: true,
      _count: { select: { messages: true, notes: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(serializeThread);
}

export async function createConversation(leadId: string, channel: ConversationChannel = 'WHATSAPP') {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
  const row = await prisma.conversation.create({
    data: { leadId, channel },
    include: {
      lead: { include: { branch: true } },
      messages: true,
      _count: { select: { messages: true, notes: true } },
    },
  });
  return serializeThread(row);
}

export async function updateConversation(id: string, input: { assignee?: string | null; status?: string }) {
  const existing = await prisma.conversation.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
  if (input.status !== undefined && !['OPEN', 'CLOSED'].includes(input.status)) {
    throw new AppError(400, 'VALIDATION', 'status must be OPEN or CLOSED');
  }
  const row = await prisma.conversation.update({
    where: { id },
    data: {
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
    include: {
      lead: { include: { branch: true } },
      messages: true,
      _count: { select: { messages: true, notes: true } },
    },
  });
  return serializeThread(row);
}

export interface TimelineItem {
  kind: 'message' | 'note';
  id: string;
  direction?: MessageDirection;
  sender?: string | null;
  author?: string | null;
  body: string;
  at: Date;
}

export async function getTimeline(conversationId: string) {
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      lead: { include: { branch: true } },
      messages: { orderBy: { sentAt: 'asc' } },
      notes: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!convo) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
  const timeline: TimelineItem[] = [
    ...convo.messages.map((m) => ({
      kind: 'message' as const,
      id: m.id,
      direction: m.direction,
      sender: m.sender,
      body: m.body,
      at: m.sentAt,
    })),
    ...convo.notes.map((n) => ({
      kind: 'note' as const,
      id: n.id,
      author: n.author,
      body: n.body,
      at: n.createdAt,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    conversation: {
      id: convo.id,
      leadId: convo.leadId,
      leadName: convo.lead.name,
      leadStage: convo.lead.stage,
      branchCode: convo.lead.branch?.code ?? '',
      channel: convo.channel,
      assignee: convo.assignee,
      status: convo.status,
    },
    timeline,
  };
}

export async function postNote(conversationId: string, body: string, author?: string | null) {
  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!convo) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
  const note = await prisma.conversationNote.create({
    data: { conversationId, body, author: author ?? null },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: {} });
  return { id: note.id, body: note.body, author: note.author, at: note.createdAt };
}

// Send stub: real WhatsApp/email delivery is out of scope (ops-gated), so the
// outbound message is only RECORDED on the thread. The `delivered: false`
// flag tells the UI this never left the building.
export async function sendMessageStub(conversationId: string, body: string, sender?: string | null) {
  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!convo) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
  const message = await prisma.message.create({
    data: { conversationId, direction: 'OUT', body, sender: sender ?? null },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  return {
    delivered: false,
    message: {
      id: message.id,
      direction: message.direction,
      sender: message.sender,
      body: message.body,
      at: message.sentAt,
    },
  };
}

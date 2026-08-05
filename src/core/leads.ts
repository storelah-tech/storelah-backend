import { prisma } from '../lib/prisma';
import { LeadStage } from '@prisma/client';

const COLUMNS: LeadStage[] = ['NEW_ENQUIRY', 'CONTACTED', 'VIEWING_BOOKED', 'PROPOSAL_SENT', 'WON', 'LOST'];

export async function listLeads() {
  const leads = await prisma.lead.findMany({
    include: { branch: true },
    orderBy: { createdAt: 'asc' },
  });

  return COLUMNS.map((stage) => ({
    stage,
    count: leads.filter((l) => l.stage === stage).length,
    leads: leads
      .filter((l) => l.stage === stage)
      .map((l) => ({
        id: l.id,
        name: l.name,
        type: l.type,
        segment: l.segment ?? l.type.toLowerCase(),
        size: l.preferredSize,
        branch: l.branch?.code ?? '',
        note: l.note,
      })),
  }));
}
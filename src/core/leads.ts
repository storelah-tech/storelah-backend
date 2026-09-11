import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { LeadStage } from '@prisma/client';

const COLUMNS: LeadStage[] = ['NEW_ENQUIRY', 'CONTACTED', 'VIEWING_BOOKED', 'PROPOSAL_SENT', 'WON', 'LOST'];

const STAGE_LABEL: Record<string, string> = {
  NEW_ENQUIRY: 'New',
  CONTACTED: 'Contacted',
  VIEWING_BOOKED: 'Qualified',
  PROPOSAL_SENT: 'Quoted',
  WON: 'Booked',
  LOST: 'Lost',
};

export async function listLeads() {
  const leads = await prisma.lead.findMany({
    include: { branch: true },
    orderBy: { createdAt: 'desc' },
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
        branchCode: l.branch?.code ?? '',
        branchName: l.branch?.name ?? '',
        note: l.note,
        stage: l.stage,
        source: l.source,
        monthlyRate: l.monthlyRate ? toNum(l.monthlyRate) : null,
        createdAt: l.createdAt,
        daysSince: Math.floor((Date.now() - l.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
      })),
  }));
}

export async function getLeadStats() {
  const leads = await prisma.lead.findMany({
    include: { branch: true },
    orderBy: { createdAt: 'desc' },
  });

  const total = leads.length;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const newToday = leads.filter((l) => l.createdAt >= todayStart).length;
  const awaitingFirstContact = leads.filter((l) => l.stage === 'NEW_ENQUIRY').length;

  const funnel = COLUMNS.map((stage) => {
    const filtered = leads.filter((l) => l.stage === stage);
    return {
      stage,
      label: STAGE_LABEL[stage] ?? stage,
      count: filtered.length,
    };
  });

  const sourceBreakdown = leads.reduce<Record<string, number>>((acc, l) => {
    const key = l.source.toLowerCase();
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const branchBreakdown = leads.reduce<Record<string, number>>((acc, l) => {
    const key = l.branch?.code ?? 'none';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return {
    total,
    newToday,
    awaitingFirstContact,
    funnel,
    sourceBreakdown,
    branchBreakdown,
  };
}
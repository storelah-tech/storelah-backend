import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { AccountType, LeadSource, LeadStage, Prisma } from '@prisma/client';

const COLUMNS: LeadStage[] = ['NEW_ENQUIRY', 'CONTACTED', 'VIEWING_BOOKED', 'PROPOSAL_SENT', 'WON', 'LOST'];

const STAGE_LABEL: Record<string, string> = {
  NEW_ENQUIRY: 'New',
  CONTACTED: 'Contacted',
  VIEWING_BOOKED: 'Qualified',
  PROPOSAL_SENT: 'Quoted',
  WON: 'Booked',
  LOST: 'Lost',
};

// Loss reasons offered by the pipeline drop-to-LOST picker (admin.js) and the
// lead modal. "Unspecified" is the default so existing PATCH flows that only
// send { stage: 'LOST' } keep working — updateLead fills it in.
export const LOSS_REASONS = [
  'Price',
  'Location',
  'Timing',
  'Competitor',
  'No response',
  'Unspecified',
] as const;

export interface CreateLeadInput {
  name: string;
  type?: AccountType;
  segment?: string | null;
  stage?: LeadStage;
  source?: LeadSource;
  preferredSize?: string | null;
  preferredBranchId?: string | null;
  monthlyRate?: number | null;
  note?: string | null;
  email?: string | null;
  mobile?: string | null;
  owner?: string | null;
  nextActionAt?: Date | null;
  lossReason?: string | null;
  lossValue?: number | null;
}

export interface UpdateLeadInput {
  name?: string;
  type?: AccountType;
  segment?: string | null;
  stage?: LeadStage;
  source?: LeadSource;
  preferredSize?: string | null;
  preferredBranchId?: string | null;
  monthlyRate?: number | null;
  note?: string | null;
  email?: string | null;
  mobile?: string | null;
  owner?: string | null;
  nextActionAt?: Date | null;
  lossReason?: string | null;
  lossValue?: number | null;
}

type LeadWithBranch = Prisma.LeadGetPayload<{ include: { branch: true } }>;

function serializeLead(l: LeadWithBranch) {
  return {
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
    email: l.email,
    mobile: l.mobile,
    owner: l.owner,
    nextActionAt: l.nextActionAt,
    lossReason: l.lossReason ?? null,
    lossValue: l.lossValue ? toNum(l.lossValue) : null,
    createdAt: l.createdAt,
    daysSince: Math.floor((Date.now() - l.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
  };
}

async function assertBranch(branchId: string | null | undefined) {
  if (!branchId) return;
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw new AppError(400, 'VALIDATION', 'Unknown preferredBranchId');
}

function assertLossReason(reason: string | null | undefined) {
  if (reason === undefined || reason === null) return;
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 80) {
    throw new AppError(400, 'VALIDATION', 'lossReason must be 1-80 characters');
  }
}

export async function createLead(input: CreateLeadInput) {
  await assertBranch(input.preferredBranchId ?? null);
  assertLossReason(input.lossReason ?? undefined);
  const lead = await prisma.lead.create({
    data: {
      name: input.name,
      type: input.type ?? 'PERSONAL',
      segment: input.segment ?? null,
      stage: input.stage ?? 'NEW_ENQUIRY',
      source: input.source ?? 'WEBSITE',
      preferredSize: input.preferredSize ?? null,
      preferredBranchId: input.preferredBranchId ?? null,
      monthlyRate: input.monthlyRate ?? null,
      note: input.note ?? null,
      email: input.email ?? null,
      mobile: input.mobile ?? null,
      owner: input.owner ?? null,
      nextActionAt: input.nextActionAt ?? null,
      // Creating directly into LOST still gets attributed (same default as updateLead).
      lossReason: input.stage === 'LOST' ? (input.lossReason?.trim() || 'Unspecified') : (input.lossReason?.trim() || null),
      lossValue: input.lossValue ?? (input.stage === 'LOST' ? (input.monthlyRate ?? null) : null),
    },
    include: { branch: true },
  });
  return serializeLead(lead);
}

export async function updateLead(id: string, input: UpdateLeadInput) {
  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
  await assertBranch(input.preferredBranchId);
  assertLossReason(input.lossReason ?? undefined);
  if (input.lossValue !== undefined && input.lossValue !== null && input.lossValue < 0) {
    throw new AppError(400, 'VALIDATION', 'lossValue must be 0 or greater');
  }

  // Moving into LOST stamps attribution so old clients that only send
  // { stage: 'LOST' } still produce a countable row: reason defaults to
  // "Unspecified", value falls back to the lead's monthlyRate (revenue proxy).
  // Explicit values are never overwritten; rows leaving LOST keep history.
  const movingToLost = input.stage === 'LOST' && existing.stage !== 'LOST';
  const lossPatch: { lossReason?: string | null; lossValue?: number | null } = {};
  if (movingToLost) {
    lossPatch.lossReason = input.lossReason?.trim() || existing.lossReason || 'Unspecified';
    const fallback =
      input.lossValue ??
      (existing.lossValue != null ? toNum(existing.lossValue) : null) ??
      (existing.monthlyRate != null ? toNum(existing.monthlyRate) : null) ??
      input.monthlyRate ??
      null;
    lossPatch.lossValue = fallback;
  } else {
    if (input.lossReason !== undefined) lossPatch.lossReason = input.lossReason?.trim() || null;
    if (input.lossValue !== undefined) lossPatch.lossValue = input.lossValue;
  }

  const lead = await prisma.lead.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.segment !== undefined ? { segment: input.segment } : {}),
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.preferredSize !== undefined ? { preferredSize: input.preferredSize } : {}),
      ...(input.preferredBranchId !== undefined ? { preferredBranchId: input.preferredBranchId } : {}),
      ...(input.monthlyRate !== undefined ? { monthlyRate: input.monthlyRate } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.nextActionAt !== undefined ? { nextActionAt: input.nextActionAt } : {}),
      ...(lossPatch.lossReason !== undefined ? { lossReason: lossPatch.lossReason } : {}),
      ...(lossPatch.lossValue !== undefined ? { lossValue: lossPatch.lossValue } : {}),
    },
    include: { branch: true },
  });
  return serializeLead(lead);
}

export async function deleteLead(id: string) {
  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
  // Appointments only lose the lead link (they survive); conversations
  // cascade via the FK. Unlink first — Appointment.leadId has no ON DELETE
  // action, so deleting the lead while rows still point at it would fail.
  await prisma.$transaction([
    prisma.appointment.updateMany({ where: { leadId: id }, data: { leadId: null } }),
    prisma.lead.delete({ where: { id } }),
  ]);
  return { id };
}

export async function listLeads(opts?: { from?: Date; to?: Date }) {
  const createdAt: { gte?: Date; lte?: Date } = {};
  if (opts?.from) createdAt.gte = opts.from;
  if (opts?.to) createdAt.lte = opts.to;
  const leads = await prisma.lead.findMany({
    where: createdAt.gte || createdAt.lte ? { createdAt } : undefined,
    include: { branch: true },
    orderBy: { createdAt: 'desc' },
  });

  return COLUMNS.map((stage) => ({
    stage,
    count: leads.filter((l) => l.stage === stage).length,
    leads: leads
      .filter((l) => l.stage === stage)
      .map((l) => serializeLead(l)),
  }));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

  // Headline counts for the analytics stat tiles.
  const byStage = (s: LeadStage) => leads.filter((l) => l.stage === s).length;
  const enquiries = total;
  const qualified = byStage('VIEWING_BOOKED') + byStage('PROPOSAL_SENT') + byStage('WON');
  const bookings = byStage('WON');

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

  // --- Conversion by facility: leads -> WON per branch + overall. ---
  const byBranch = new Map<string, { branchId: string | null; code: string; name: string; leads: number; won: number }>();
  for (const l of leads) {
    const key = l.branch?.code ?? 'none';
    const row =
      byBranch.get(key) ??
      { branchId: l.preferredBranchId ?? null, code: key, name: l.branch?.name ?? 'No facility', leads: 0, won: 0 };
    row.leads += 1;
    if (l.stage === 'WON') row.won += 1;
    if (!row.branchId && l.preferredBranchId) row.branchId = l.preferredBranchId;
    byBranch.set(key, row);
  }
  const conversionByFacility = [...byBranch.values()].map((r) => ({
    ...r,
    conversionPct: r.leads ? Math.round((r.won / r.leads) * 1000) / 10 : 0,
  }));
  const overallConversionPct = total ? Math.round((bookings / total) * 1000) / 10 : 0;

  // --- First-response proxy (no migration): earliest OUTBOUND message per
  // lead minus lead.createdAt. Leads with no outbound message yet are excluded
  // (sample size reported so the UI can show an honest empty state). Notes are
  // internal-only and excluded — only direction=OUT counts as first contact.
  const outbounds = await prisma.message.findMany({
    where: { direction: 'OUT' },
    select: { sentAt: true, conversation: { select: { leadId: true } } },
    orderBy: { sentAt: 'asc' },
  });
  const firstOutByLead = new Map<string, Date>();
  for (const m of outbounds) {
    if (!firstOutByLead.has(m.conversation.leadId)) firstOutByLead.set(m.conversation.leadId, m.sentAt);
  }
  const responseMinutes: number[] = [];
  for (const l of leads) {
    const first = firstOutByLead.get(l.id);
    if (first && first.getTime() >= l.createdAt.getTime()) {
      responseMinutes.push((first.getTime() - l.createdAt.getTime()) / 60000);
    }
  }
  const medMin = median(responseMinutes);
  const medianFirstResponseMin = medMin == null ? null : Math.round(medMin * 10) / 10;

  // --- Lost revenue: sum of lossValue, falling back to monthlyRate where a
  // lost row has no explicit lossValue (pre-migration rows). avgValue is the
  // mean monthlyRate across ALL leads (the tile's "count x avg" fallback).
  const lostRows = leads.filter((l) => l.stage === 'LOST');
  const lostValue = lostRows.reduce(
    (sum, l) => sum + toNum(l.lossValue ?? l.monthlyRate ?? 0),
    0,
  );
  const ratesAll = leads.map((l) => toNum(l.monthlyRate ?? 0)).filter((n) => n > 0);
  const avgValue = ratesAll.length ? Math.round((ratesAll.reduce((a, b) => a + b, 0) / ratesAll.length) * 100) / 100 : 0;
  const lossReasonBreakdown = lostRows.reduce<Record<string, number>>((acc, l) => {
    const key = l.lossReason?.trim() || 'Unspecified';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  // --- Advisor scorecard grouped by lead.owner (no staff model by design).
  // QUALITY SCORE (documented heuristic, not a black box):
  //   quality = round( 50 * contactRate + 50 * conversionRate )
  // where contactRate = share of assigned leads past NEW_ENQUIRY (0..1) and
  // conversionRate = share of assigned leads WON (0..1). Equal weights: half
  // responsiveness, half closing. Revenue is a proxy (sum of WON monthlyRate).
  const byOwner = new Map<string, typeof leads>();
  for (const l of leads) {
    const key = l.owner?.trim() || 'Unassigned';
    byOwner.set(key, [...(byOwner.get(key) ?? []), l]);
  }
  const scorecard = [...byOwner.entries()]
    .map(([owner, rows]) => {
      const assigned = rows.length;
      const contacted = rows.filter((r) => r.stage !== 'NEW_ENQUIRY').length;
      const won = rows.filter((r) => r.stage === 'WON').length;
      const contactRate = assigned ? contacted / assigned : 0;
      const conversion = assigned ? won / assigned : 0;
      const revenue = rows
        .filter((r) => r.stage === 'WON')
        .reduce((sum, r) => sum + toNum(r.monthlyRate ?? 0), 0);
      const quality = Math.round(50 * contactRate + 50 * conversion);
      return {
        owner,
        assigned,
        contactRate: Math.round(contactRate * 1000) / 10,
        conversion: Math.round(conversion * 1000) / 10,
        revenue,
        quality,
      };
    })
    .sort((a, b) => b.assigned - a.assigned);

  return {
    total,
    newToday,
    awaitingFirstContact,
    funnel,
    sourceBreakdown,
    branchBreakdown,
    enquiries,
    qualified,
    bookings,
    overallConversionPct,
    conversionByFacility,
    medianFirstResponseMin,
    firstResponseSample: responseMinutes.length,
    lostCount: lostRows.length,
    lostValue,
    avgValue,
    lossReasonBreakdown,
    scorecard,
    lossReasons: [...LOSS_REASONS],
  };
}

// Weekly enquiry/booking series for the analytics chart. Buckets count
// createdAt per ISO week (Monday-start, UTC); value columns sum monthlyRate.
// Weeks with no data return zeros so the chart renders honest empty states.
export async function getWeeklyAnalytics(weeks = 8) {
  const n = Math.min(Math.max(Math.floor(weeks) || 8, 1), 26);
  const now = new Date();
  const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  thisMonday.setUTCDate(thisMonday.getUTCDate() - ((thisMonday.getUTCDay() + 6) % 7));
  thisMonday.setUTCHours(0, 0, 0, 0);

  const start = new Date(thisMonday);
  start.setUTCDate(start.getUTCDate() - (n - 1) * 7);

  const leads = await prisma.lead.findMany({
    where: { createdAt: { gte: start } },
    select: { createdAt: true, stage: true, monthlyRate: true, updatedAt: true },
  });

  // WON attribution uses updatedAt (close time) so a booking lands in the week
  // it closed; enquiries always use createdAt.
  const wonAll = await prisma.lead.findMany({
    where: { stage: 'WON', updatedAt: { gte: start } },
    select: { updatedAt: true, monthlyRate: true },
  });

  const buckets = Array.from({ length: n }, (_, i) => {
    const s = new Date(start);
    s.setUTCDate(s.getUTCDate() + i * 7);
    const e = new Date(s);
    e.setUTCDate(e.getUTCDate() + 7);
    return {
      weekStart: s.toISOString().slice(0, 10),
      label: s.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      enquiries: 0,
      bookings: 0,
      enquiryValue: 0,
      bookingValue: 0,
      _s: s.getTime(),
      _e: e.getTime(),
    };
  });

  for (const l of leads) {
    const t = l.createdAt.getTime();
    const b = buckets.find((x) => t >= x._s && t < x._e);
    if (!b) continue;
    b.enquiries += 1;
    b.enquiryValue += toNum(l.monthlyRate ?? 0);
  }
  for (const w of wonAll) {
    const t = w.updatedAt.getTime();
    const b = buckets.find((x) => t >= x._s && t < x._e);
    if (!b) continue;
    b.bookings += 1;
    b.bookingValue += toNum(w.monthlyRate ?? 0);
  }

  return {
    weeks: buckets.map(({ _s, _e, ...rest }) => rest),
    meta: { count: n, from: start.toISOString().slice(0, 10) },
  };
}

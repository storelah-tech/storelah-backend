// P1 item 4 — quotes ops (no migration, by design).
//
// A "quote" is NOT a separate table: it is a Lead in stage PROPOSAL_SENT with
// its unit options resolved live from current inventory (AVAILABLE units
// matching preferredBranchId / preferredSize). Rationale (see
// docs/P1_QUOTES_MOVEOUTS.md): a quote is pipeline state, not a snapshot —
// snapshotting unit + rate at quote time would go stale the moment rates move
// (adjustRate) or units lease, while the live read is always truthful.
// Conversion is already modelled: PROPOSAL_SENT → WON (+ Booking), loss via
// LOST + lossReason/lossValue. Stage transitions reuse PATCH /leads/:id, so
// this module is a read-model over existing rows.
import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';

const QUOTE_STAGE = 'PROPOSAL_SENT' as const;
const MAX_OPTIONS = 25;

export interface QuoteInventoryQuery {
  branchId?: string;
  size?: string;
}

async function inventoryOptions(query: QuoteInventoryQuery) {
  const units = await prisma.unit.findMany({
    where: {
      deletedAt: null,
      status: 'AVAILABLE',
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.size ? { size: { code: query.size } } : {}),
    },
    include: { size: true, branch: true },
    orderBy: { monthlyRate: 'asc' },
    take: MAX_OPTIONS,
  });
  return units.map((u) => {
    const rate = toNum(u.monthlyRate);
    return {
      code: u.unitCode,
      branchCode: u.branch.code,
      sizeCode: u.size.code,
      size: u.size.name,
      sqft: u.sqft,
      rate,
      psf: u.sqft ? rate / u.sqft : 0,
    };
  });
}

async function matchingAvailableCount(branchId?: string | null, size?: string | null) {
  return prisma.unit.count({
    where: {
      deletedAt: null,
      status: 'AVAILABLE',
      ...(branchId ? { branchId } : {}),
      ...(size ? { size: { code: size } } : {}),
    },
  });
}

function serializeQuote(
  l: {
    id: string;
    name: string;
    type: string;
    segment: string | null;
    stage: string;
    source: string;
    preferredSize: string | null;
    preferredBranchId: string | null;
    monthlyRate: unknown;
    email: string | null;
    mobile: string | null;
    owner: string | null;
    nextActionAt: Date | null;
    note: string | null;
    createdAt: Date;
    updatedAt: Date;
    branch: { code: string; name: string } | null;
  },
  matchingAvailable: number,
) {
  return {
    id: l.id,
    name: l.name,
    type: l.type,
    segment: l.segment,
    stage: l.stage,
    source: l.source,
    preferredSize: l.preferredSize,
    preferredBranchId: l.preferredBranchId,
    branchCode: l.branch?.code ?? '',
    branchName: l.branch?.name ?? '',
    monthlyRate: l.monthlyRate ? toNum(l.monthlyRate as never) : null,
    email: l.email,
    mobile: l.mobile,
    owner: l.owner,
    nextActionAt: l.nextActionAt,
    note: l.note,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
    // Live inventory for this quote (recomputed per read — never stored).
    matchingAvailable,
  };
}

// Operator quotes queue: every PROPOSAL_SENT lead + live availability match.
export async function listQuotes() {
  const leads = await prisma.lead.findMany({
    where: { stage: QUOTE_STAGE },
    include: { branch: { select: { code: true, name: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  const rows = await Promise.all(
    leads.map(async (l) => serializeQuote(l, await matchingAvailableCount(l.preferredBranchId, l.preferredSize))),
  );
  const quotedValue = rows.reduce((s, q) => s + (q.monthlyRate ?? 0), 0);
  return { rows, meta: { count: rows.length, quotedValue: Math.round(quotedValue) } };
}

// Single quote + concrete unit options the operator can offer right now.
export async function getQuote(id: string, opts?: { branchId?: string; size?: string }) {
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: { branch: { select: { code: true, name: true } } },
  });
  if (!lead) throw new AppError(404, 'NOT_FOUND', `Lead ${id} not found`);
  if (lead.stage !== QUOTE_STAGE) {
    throw new AppError(409, 'CONFLICT', `Lead ${id} is in stage ${lead.stage}, not ${QUOTE_STAGE}`);
  }
  const branchId = opts?.branchId ?? lead.preferredBranchId ?? undefined;
  const size = opts?.size ?? lead.preferredSize ?? undefined;
  const [matchingAvailable, options] = await Promise.all([
    matchingAvailableCount(lead.preferredBranchId, lead.preferredSize),
    inventoryOptions({ branchId, size }),
  ]);
  return { quote: serializeQuote(lead, matchingAvailable), options };
}

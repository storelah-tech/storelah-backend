// Destination promotion resolver (Track A, A-23).
//
// Handoff §11.2: the destination promotion is read-only and derived —
// destination eligibility takes precedence. The CMS never keys a promotion
// %; preview/post recompute it from the destination unit, so a forged
// client destPromoPct is ignored (see transferService.resolveTransfer).
//
// Rule: best (max) DISCOUNT_MATRIX cell % across ACTIVE in-window plans
// covering the destination unit's branch + floor + canonical size category.
// Any commitment tier counts — the transfer keeps the customer's existing
// commitment, so the "effective promotion" is the best eligible % for the
// unit, labelled with the owning plan name. No eligible plan → 0 / null.

import { prisma } from '../../lib/prisma';
import { toNum } from '../../lib/format';
import {
  planCoversBranch,
  planCoversFloor,
  planCoversSize,
  toCanonicalSizeCategory,
} from '../promotionPlans';

export interface DestinationPromo {
  promoPct: number;
  planName: string | null;
  planId: string | null;
}

const NONE: DestinationPromo = { promoPct: 0, planName: null, planId: null };

export async function resolveDestinationPromo(destUnitId: string): Promise<DestinationPromo> {
  const dest = await prisma.unit.findFirst({
    where: { id: destUnitId },
    include: { branch: { select: { id: true, code: true } }, size: { select: { code: true, name: true } } },
  });
  if (!dest || dest.deletedAt) return NONE;
  const branch = dest.branch ? { id: dest.branch.id, code: dest.branch.code } : null;
  const sizeCategory = toCanonicalSizeCategory(dest.size?.code ?? dest.size?.name ?? '');
  const now = new Date();
  const plans = await prisma.promotionPlan.findMany({
    where: {
      status: 'ACTIVE',
      kind: 'DISCOUNT_MATRIX',
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    include: { matrixCells: true, rules: true },
  });
  let best: DestinationPromo | null = null;
  for (const p of plans) {
    if (branch && !planCoversBranch(p.facilityScope, branch)) continue;
    if (!planCoversFloor(p.rules, dest.floorId ?? null)) continue;
    if (!planCoversSize(p.sizeScope, sizeCategory)) continue;
    for (const c of p.matrixCells) {
      if (toCanonicalSizeCategory(c.sizeCategory) !== sizeCategory) continue;
      const pct = toNum(c.discountPct);
      if (!(pct > 0) || pct > 100) continue;
      if (!best || pct > best.promoPct) {
        best = { promoPct: Math.round(pct * 100) / 100, planName: p.name, planId: p.id };
      }
    }
  }
  return best ?? NONE;
}

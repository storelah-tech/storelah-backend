// Size Mix & Pricing (FINANCE_MODULE_SPEC §14).
//
// Live `Unit`/`UnitSize` inventory ALWAYS wins for NLA and unit counts (Q9
// DECIDED) — this module reads them directly. Planning buckets map from live
// rows via SizePriceRule; MANUAL rules carry only planning PSF/rate targets
// plus an audit trail (the ASSUMPTIONS OVERLAY — Q9 manual-override authority
// is still OPEN with the owner, so overrides NEVER write back to live Unit
// rows; the response + UI flag this prominently).
//
// Canonical buckets: LOCKER / SMALL / MEDIUM / LARGE / XL / XXL. Legacy XS
// reads as LOCKER. A changed size taxonomy requires explicit mapping: sizes
// that match no bucket surface as UNMAPPED with a mismatch warning instead
// of silently joining a bucket.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { toNum } from '../../lib/format';
import { writeAuditEvent } from './audit';
import { publishFinanceEvent } from './events';
import { assertFreshVersion, nextVersion, newCorrelationId } from './idempotency';

export const CANONICAL_BUCKETS = ['LOCKER', 'SMALL', 'MEDIUM', 'LARGE', 'XL', 'XXL'] as const;

/** Maps a live UnitSize code to a canonical planning bucket (or null). */
export function bucketForSize(code: string, sqftTo: number): string | null {
  const c = code.trim().toUpperCase();
  if (c === 'XS') return 'LOCKER'; // legacy XS reads as LOCKER
  if ((CANONICAL_BUCKETS as readonly string[]).includes(c)) return c;
  // Fallback by footprint so a renamed taxonomy still maps explicitly.
  if (sqftTo <= 0) return null;
  if (sqftTo <= 25) return 'LOCKER';
  if (sqftTo <= 60) return 'SMALL';
  if (sqftTo <= 110) return 'MEDIUM';
  if (sqftTo <= 180) return 'LARGE';
  if (sqftTo <= 320) return 'XL';
  return 'XXL';
}

export interface PricingRow {
  sizeId: string;
  code: string;
  name: string;
  bucket: string | null;
  units: number;
  nlaSqft: number;
  /** Smallest / largest live unit of this size at the facility (null when none). */
  minSqft: number | null;
  maxSqft: number | null;
  liveAvgPsf: number | null;
  liveAvgRate: number | null;
  targetPsf: number | null;
  targetRate: number | null;
  effectivePsf: number | null;
  monthlyPotential: number | null;
  authority: 'SYSTEM' | 'MANUAL';
  overrideBadge: string | null;
  ruleVersion: number | null;
}

/** Live inventory + overlay rules for a facility (sync view, §14.2). */
export async function getPricing(opts: { branchId: string }) {
  if (!opts.branchId) throw new AppError(400, 'VALIDATION', 'branchId is required for pricing.');
  const branch = await prisma.branch.findUnique({ where: { id: opts.branchId } });
  if (!branch) throw new AppError(404, 'NOT_FOUND', `Branch ${opts.branchId} not found.`);
  const sizes = await prisma.unitSize.findMany({ orderBy: { sortOrder: 'asc' } });
  const units = await prisma.unit.findMany({
    where: { branchId: opts.branchId, deletedAt: null },
    select: { sizeId: true, sqft: true, monthlyRate: true, status: true },
  });
  const rules = await prisma.sizePriceRule.findMany({ where: { branchId: opts.branchId } });
  const ruleBySize = new Map(rules.map((r) => [r.sizeId, r]));

  const rows: PricingRow[] = sizes.map((s) => {
    const mine = units.filter((u) => u.sizeId === s.id);
    const nla = mine.reduce((sum, u) => sum + u.sqft, 0);
    const rent = mine.reduce((sum, u) => sum + toNum(u.monthlyRate), 0);
    const liveAvgPsf = nla > 0 ? Math.round((rent / nla) * 10000) / 10000 : null;
    const liveAvgRate = mine.length ? Math.round((rent / mine.length) * 100) / 100 : null;
    const rule = ruleBySize.get(s.id);
    const targetPsf = rule?.targetPsf != null ? toNum(rule.targetPsf, 4) : null;
    const targetRate = rule?.targetRate != null ? toNum(rule.targetRate) : null;
    const effectivePsf = targetPsf ?? liveAvgPsf;
    return {
      sizeId: s.id,
      code: s.code,
      name: s.name,
      bucket: bucketForSize(s.code, s.sqftTo),
      units: mine.length,
      nlaSqft: Math.round(nla * 100) / 100,
      minSqft: mine.length ? Math.min(...mine.map((u) => u.sqft)) : null,
      maxSqft: mine.length ? Math.max(...mine.map((u) => u.sqft)) : null,
      liveAvgPsf,
      liveAvgRate,
      targetPsf,
      targetRate,
      effectivePsf,
      monthlyPotential: effectivePsf === null ? null : Math.round(nla * effectivePsf * 100) / 100,
      authority: (rule?.authority as 'SYSTEM' | 'MANUAL' | undefined) ?? 'SYSTEM',
      overrideBadge: rule?.authority === 'MANUAL' ? 'Manual override (assumptions overlay — live inventory untouched)' : null,
      ruleVersion: rule?.version ?? null,
    };
  });

  const unmapped = rows.filter((r) => r.bucket === null);
  const facilityNla = rows.reduce((s, r) => s + r.nlaSqft, 0);
  const facilityUnits = rows.reduce((s, r) => s + r.units, 0);
  const potential = rows.reduce((s, r) => s + (r.monthlyPotential ?? 0), 0);
  const weightedPsf = facilityNla > 0 ? Math.round((potential / facilityNla) * 10000) / 10000 : null;
  const year5Potential = potential === 0 ? null : Math.round(potential * 12 * 5 * 100) / 100;

  // Manual overrides are an overlay: confirm live rows were never touched by
  // reporting the inventory version (max Unit.updatedAt) alongside the rules.
  const inventoryVersion = await prisma.unit.aggregate({
    where: { branchId: opts.branchId, deletedAt: null },
    _max: { updatedAt: true },
  });

  return {
    branchId: opts.branchId,
    generatedAt: new Date(),
    inventoryVersion: inventoryVersion._max.updatedAt,
    facilityNla: Math.round(facilityNla * 100) / 100,
    facilityUnits,
    weightedPsf,
    monthlyPotential: Math.round(potential * 100) / 100,
    year5Potential,
    mismatchWarning: unmapped.length
      ? `${unmapped.length} live size${unmapped.length === 1 ? '' : 's'} (${unmapped.map((r) => r.code).join(', ')}) match no planning bucket — map the taxonomy before approval.`
      : null,
    authorityNote: 'Live Unit/UnitSize inventory always wins. MANUAL rows are an audit-logged assumptions overlay: they NEVER write back to live Unit rows (Q9 manual-override authority still open with the owner).',
    rows,
  };
}

/**
 * Manual price override (audited overlay, §14.4). Writes a SizePriceRule with
 * authority MANUAL — live Unit rows are never touched. `reason` is required.
 */
export async function overridePricing(opts: {
  branchId: string;
  sizeId: string;
  targetPsf?: number | null;
  targetRate?: number | null;
  reason: string;
  expectedVersion?: number;
  actor: string;
}) {
  if (!opts.reason.trim()) throw new AppError(400, 'VALIDATION', 'A reason is required for a manual price override.');
  if (opts.targetPsf == null && opts.targetRate == null) {
    throw new AppError(400, 'VALIDATION', 'At least one of targetPsf / targetRate is required.');
  }
  if (opts.targetPsf != null && !(opts.targetPsf >= 0)) throw new AppError(400, 'VALIDATION', 'targetPsf cannot be negative.');
  if (opts.targetRate != null && !(opts.targetRate >= 0)) throw new AppError(400, 'VALIDATION', 'targetRate cannot be negative.');
  const size = await prisma.unitSize.findUnique({ where: { id: opts.sizeId } });
  if (!size) throw new AppError(404, 'NOT_FOUND', `UnitSize ${opts.sizeId} not found.`);
  const branch = await prisma.branch.findUnique({ where: { id: opts.branchId } });
  if (!branch) throw new AppError(404, 'NOT_FOUND', `Branch ${opts.branchId} not found.`);
  // The override must apply to inventory that exists at this facility.
  const liveCount = await prisma.unit.count({ where: { branchId: opts.branchId, sizeId: opts.sizeId, deletedAt: null } });
  if (liveCount === 0) {
    throw new AppError(409, 'BLOCKED', `No live units of size ${size.code} exist at this facility — an override needs live inventory to overlay. Sync inventory first.`);
  }
  const correlationId = newCorrelationId();
  const rule = await prisma.$transaction(async (tx) => {
    const existing = await tx.sizePriceRule.findFirst({
      where: { branchId: opts.branchId, sizeId: opts.sizeId },
    });
    if (existing) assertFreshVersion(existing.version, opts.expectedVersion, 'SizePriceRule');
    const data = {
      targetPsf: opts.targetPsf != null ? new Prisma.Decimal(opts.targetPsf) : undefined,
      targetRate: opts.targetRate != null ? new Prisma.Decimal(opts.targetRate) : undefined,
      authority: 'MANUAL',
      effectiveFrom: new Date(),
      createdBy: opts.actor,
      version: nextVersion(existing?.version ?? 0),
    };
    const saved = existing
      ? await tx.sizePriceRule.update({ where: { id: existing.id }, data })
      : await tx.sizePriceRule.create({ data: { branchId: opts.branchId, sizeId: opts.sizeId, ...data } });
    await writeAuditEvent(tx, {
      branchId: opts.branchId, actor: opts.actor, action: 'PRICING_OVERRIDE',
      entityType: 'size-price-rule', entityId: saved.id,
      before: existing ? { targetPsf: existing.targetPsf?.toString() ?? null, authority: existing.authority } : null,
      after: {
        targetPsf: opts.targetPsf ?? null, targetRate: opts.targetRate ?? null,
        authority: 'MANUAL', overlayOnly: true, liveUnitsUntouched: true,
      },
      reason: opts.reason.trim(), source: 'cms', correlationId,
    });
    await publishFinanceEvent(tx, {
      type: 'size.mix.updated',
      payload: { branchId: opts.branchId, sizeId: opts.sizeId, authority: 'MANUAL' },
      branchId: opts.branchId, correlationId,
    });
    return saved;
  });
  return {
    id: rule.id,
    branchId: rule.branchId,
    sizeId: rule.sizeId,
    targetPsf: rule.targetPsf != null ? toNum(rule.targetPsf, 4) : null,
    targetRate: rule.targetRate != null ? toNum(rule.targetRate) : null,
    authority: rule.authority,
    version: rule.version,
    overlayOnly: true as const,
  };
}

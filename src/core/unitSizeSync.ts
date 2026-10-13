import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { toNum } from '../lib/format';
import { formatFt, rectAreaSqft } from './planGeometry';
import { loadContractedUnits, resolveSizeTier, sqftForRect } from './unitSizing';

export { resolveSizeTier };

// Floor-plan ⇄ unit size sync, Phase 2 (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md D2/D4/D5).
//
// Publish is the ONLY moment a drawn size reaches the Unit row. The plan is
// derived, never stored: `buildSizeSyncPlan()` reads every placement flagged
// `areaDirty` (plus DRAFT units, promoted on publish) and returns the exact
// per-unit change list; the preview endpoint shows it, and publish recomputes
// it INSIDE the publishing transaction (so a booking that lands between
// preview and publish blocks instead of being overwritten). A `token` hashes
// the change list so a publish confirmed against a stale preview is refused.

export const RATE_POLICIES = ['KEEP_PSF', 'KEEP_RATE', 'SET'] as const;
export type RatePolicy = (typeof RATE_POLICIES)[number];

export interface SizeSyncChoice {
  unitId: string;
  ratePolicy?: RatePolicy;
  rate?: number; // required when ratePolicy = SET
  sizeId?: string; // manual tier override (also resolves SIZE_OUT_OF_BAND)
}

type Db = Prisma.TransactionClient | typeof prisma;

type SizeRow = { id: string; code: string; name: string; sqftFrom: number; sqftTo: number; sortOrder: number };

export interface SizeSyncBlocker {
  unitId: string;
  unitCode: string;
  code: 'UNIT_CONTRACTED' | 'SIZE_OUT_OF_BAND';
  message: string;
}

export interface SizeSyncChange {
  unitId: string;
  unitCode: string;
  status: string;
  widthFt: number;
  heightFt: number;
  drawnSqft: number; // exact drawn area (2 dp)
  oldSqft: number;
  newSqft: number;
  oldSize: { id: string; code: string; name: string };
  newSize: { id: string; code: string; name: string } | null; // null only when no size tiers exist (blocker)
  /** false = no tier band covers newSqft; newSize is the nearest tier (review UI flags it). */
  tierInBand: boolean;
  oldRate: number;
  ratePreview: Record<'KEEP_PSF' | 'KEEP_RATE', number>;
  defaultPolicy: RatePolicy;
}

export interface SizeSyncPlan {
  token: string;
  changes: SizeSyncChange[];
  /** Dirty placements whose rounded area already equals Unit.sqft — flag is just cleared. */
  unchanged: Array<{ unitId: string; unitCode: string }>;
  /** DRAFT units on this floor's plan — promoted to AVAILABLE on publish. */
  newUnits: Array<{ unitId: string; unitCode: string; sqft: number; size: { code: string; name: string }; rate: number }>;
  blockers: SizeSyncBlocker[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** KEEP_PSF: same $/sqft at the new size (D5 default). */
export function keepPsfRate(oldRate: number, oldSqft: number, newSqft: number): number {
  if (!(oldSqft > 0)) return round2(oldRate);
  return round2((oldRate / oldSqft) * newSqft);
}

function sizeRef(s: SizeRow) {
  return { id: s.id, code: s.code, name: s.name };
}

/** Build the size-sync plan for a floor's plan (read-only). */
export async function buildSizeSyncPlan(
  floorId: string,
  opts: { db?: Db; choices?: readonly SizeSyncChoice[] } = {},
): Promise<SizeSyncPlan> {
  const db = opts.db ?? prisma;
  const choiceBy = new Map((opts.choices ?? []).map((c) => [c.unitId, c]));
  const plan = await db.floorPlan.findUnique({ where: { floorId }, select: { id: true } });
  const empty: SizeSyncPlan = { token: hashToken([]), changes: [], unchanged: [], newUnits: [], blockers: [] };
  if (!plan) return empty;

  const placements = await db.unitPlacement.findMany({
    where: {
      floorPlanId: plan.id,
      unit: { deletedAt: null, status: { not: 'INACTIVE' } },
      OR: [{ areaDirty: true }, { unit: { status: 'DRAFT' } }],
    },
    include: { unit: { include: { size: true } } },
    orderBy: { unit: { unitCode: 'asc' } },
  });
  if (!placements.length) return empty;

  const sizes = await db.unitSize.findMany({ select: { id: true, code: true, name: true, sqftFrom: true, sqftTo: true, sortOrder: true } });
  const contracted = await loadContractedUnits(placements.map((p) => p.unitId), db);
  const out: SizeSyncPlan = { token: '', changes: [], unchanged: [], newUnits: [], blockers: [] };

  for (const p of placements) {
    const u = p.unit;
    if (u.status === 'DRAFT') {
      out.newUnits.push({ unitId: u.id, unitCode: u.unitCode, sqft: u.sqft, size: { code: u.size.code, name: u.size.name }, rate: toNum(u.monthlyRate) });
      continue;
    }
    const newSqft = sqftForRect(p);
    if (newSqft === u.sqft) {
      out.unchanged.push({ unitId: u.id, unitCode: u.unitCode });
      continue;
    }
    const reason = contracted.get(u.id);
    if (reason) {
      out.blockers.push({
        unitId: u.id,
        unitCode: u.unitCode,
        code: 'UNIT_CONTRACTED',
        message: `Unit ${u.unitCode} is ${reason.toLowerCase()} — its ${u.sqft} sqft can't change to ${newSqft}. Resize it back (or fit the drawing to its size) before publishing.`,
      });
    }
    const override = choiceBy.get(u.id)?.sizeId;
    const overrideSize = override ? sizes.find((s) => s.id === override) : undefined;
    if (override && !overrideSize) throw new AppError(400, 'VALIDATION', `Unknown size ${override} chosen for unit ${u.unitCode}`);
    const resolved = resolveSizeTier(sizes, u.sizeId, newSqft);
    const tier = overrideSize ?? resolved?.size ?? null;
    if (!tier) {
      out.blockers.push({
        unitId: u.id,
        unitCode: u.unitCode,
        code: 'SIZE_OUT_OF_BAND',
        message: `Unit ${u.unitCode} would be ${newSqft} sqft, but no size tiers exist — add size tiers first.`,
      });
    }
    const oldRate = toNum(u.monthlyRate);
    out.changes.push({
      unitId: u.id,
      unitCode: u.unitCode,
      status: u.status,
      widthFt: p.width,
      heightFt: p.height,
      drawnSqft: round2(rectAreaSqft(p)),
      oldSqft: u.sqft,
      newSqft,
      oldSize: sizeRef(u.size),
      newSize: tier ? sizeRef(tier) : null,
      tierInBand: overrideSize ? true : (resolved?.inBand ?? false),
      oldRate,
      ratePreview: { KEEP_PSF: keepPsfRate(oldRate, u.sqft, newSqft), KEEP_RATE: oldRate },
      defaultPolicy: 'KEEP_PSF',
    });
  }
  out.token = hashToken([
    ...out.changes.map((c) => `${c.unitId}:${c.oldSqft}>${c.newSqft}:${c.oldRate}:${c.newSize?.id ?? '-'}:${c.status}`),
    ...out.newUnits.map((n) => `new:${n.unitId}`),
    ...out.blockers.map((b) => `block:${b.unitId}:${b.code}`),
  ]);
  return out;
}

function hashToken(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function rateFor(change: SizeSyncChange, choice: SizeSyncChoice | undefined): number {
  const policy = choice?.ratePolicy ?? change.defaultPolicy;
  if (policy === 'KEEP_RATE') return change.oldRate;
  if (policy === 'SET') {
    const r = choice?.rate;
    if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 1_000_000) {
      throw new AppError(400, 'VALIDATION', `Unit ${change.unitCode}: ratePolicy SET needs a rate between 0 and 1,000,000`);
    }
    return round2(r);
  }
  return change.ratePreview.KEEP_PSF;
}

export interface SizeSyncResult {
  changed: Array<{ unitCode: string; oldSqft: number; newSqft: number; oldSize: string; newSize: string; oldRate: number; newRate: number }>;
  promoted: string[];
}

/**
 * Apply the sync inside the caller's publishing transaction. Recomputes the
 * plan on `tx`, refuses blockers (409 PUBLISH_BLOCKED, nothing written) and a
 * stale preview token (409 STALE_PREVIEW), then writes Unit sqft/size/rate,
 * UnitAreaChange + RateChange history, clears areaDirty and promotes DRAFT
 * units to AVAILABLE.
 */
export async function applySizeSync(
  tx: Prisma.TransactionClient,
  floorId: string,
  opts: { token?: string; choices?: readonly SizeSyncChoice[]; appliedBy: string; floorPlanId: string },
): Promise<SizeSyncResult> {
  const plan = await buildSizeSyncPlan(floorId, { db: tx, choices: opts.choices });
  if (opts.token && opts.token !== plan.token) {
    throw new AppError(409, 'STALE_PREVIEW', 'The floor plan changed since you reviewed it — review the size changes again before publishing', {
      token: plan.token,
    });
  }
  if (plan.blockers.length) {
    throw new AppError(409, 'PUBLISH_BLOCKED', `Publish blocked: ${plan.blockers.map((b) => b.message).join(' ')}`, { blockers: plan.blockers });
  }
  const choiceBy = new Map((opts.choices ?? []).map((c) => [c.unitId, c]));
  const now = new Date();
  const result: SizeSyncResult = { changed: [], promoted: [] };

  for (const c of plan.changes) {
    const newSize = c.newSize!; // no blockers ⇒ every change has a tier
    const newRate = rateFor(c, choiceBy.get(c.unitId));
    await tx.unit.update({ where: { id: c.unitId }, data: { sqft: c.newSqft, sizeId: newSize.id, monthlyRate: newRate } });
    await tx.unitAreaChange.create({
      data: {
        unitId: c.unitId,
        previous: c.oldSqft,
        current: c.newSqft,
        prevSizeId: c.oldSize.id,
        newSizeId: newSize.id,
        widthFt: c.widthFt,
        heightFt: c.heightFt,
        source: 'FLOOR_PLAN_PUBLISH',
        floorPlanId: opts.floorPlanId,
        appliedBy: opts.appliedBy,
      },
    });
    if (newRate !== c.oldRate) {
      await tx.rateChange.create({
        data: {
          unitId: c.unitId,
          date: now,
          previous: c.oldRate,
          current: newRate,
          changePct: c.oldRate ? Math.round(((newRate - c.oldRate) / c.oldRate) * 1000) / 10 : 0,
          reason: `Floor plan resize ${c.oldSqft}→${c.newSqft} sqft (${formatFt(c.widthFt)}×${formatFt(c.heightFt)} ft)`,
          appliedBy: opts.appliedBy,
        },
      });
    }
    result.changed.push({
      unitCode: c.unitCode,
      oldSqft: c.oldSqft,
      newSqft: c.newSqft,
      oldSize: c.oldSize.code,
      newSize: newSize.code,
      oldRate: c.oldRate,
      newRate,
    });
  }
  const touched = [...plan.changes.map((c) => c.unitId), ...plan.unchanged.map((u) => u.unitId)];
  if (touched.length) await tx.unitPlacement.updateMany({ where: { unitId: { in: touched } }, data: { areaDirty: false } });
  if (plan.newUnits.length) {
    await tx.unit.updateMany({ where: { id: { in: plan.newUnits.map((n) => n.unitId) }, status: 'DRAFT' }, data: { status: 'AVAILABLE' } });
    result.promoted = plan.newUnits.map((n) => n.unitCode);
  }
  return result;
}

// ---------- reconcile (grandfathered mismatches) ----------

export interface SizeMismatch {
  unitId: string;
  unitCode: string;
  status: string;
  sqft: number;
  drawnSqft: number;
  widthFt: number;
  heightFt: number;
  contracted: string | null;
}

/**
 * Placed units whose rounded drawn area differs from Unit.sqft and that are
 * NOT already flagged for sync — rows drawn under the old 15% / 2% bands.
 * Never changes anything; the operator picks per unit (see reconcile route).
 */
export async function listSizeMismatches(floorId: string): Promise<SizeMismatch[]> {
  const plan = await prisma.floorPlan.findUnique({ where: { floorId }, select: { id: true } });
  if (!plan) return [];
  const rows = await prisma.unitPlacement.findMany({
    where: { floorPlanId: plan.id, areaDirty: false, unit: { deletedAt: null, status: { notIn: ['INACTIVE', 'DRAFT'] } } },
    include: { unit: { select: { id: true, unitCode: true, status: true, sqft: true } } },
    orderBy: { unit: { unitCode: 'asc' } },
  });
  const mism = rows.filter((p) => sqftForRect(p) !== p.unit.sqft);
  const contracted = await loadContractedUnits(mism.map((p) => p.unitId));
  return mism.map((p) => ({
    unitId: p.unitId,
    unitCode: p.unit.unitCode,
    status: p.unit.status,
    sqft: p.unit.sqft,
    drawnSqft: round2(rectAreaSqft(p)),
    widthFt: p.width,
    heightFt: p.height,
    contracted: contracted.get(p.unitId) ?? null,
  }));
}

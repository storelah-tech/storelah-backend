// P1 item 5 — fees & deposits with per-facility override.
//
// The scalar Setting store (13 keys, untouched) cannot hold this shape: a fee
// needs a key + a scope + an optional branch/size/tenant target. FacilityFee
// rows express the Global → Facility → Product → Exception priority chain and
// resolveFee() collapses it to a single effective rule per (kind, key).
import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { FeeKind, FeeScope, Prisma } from '@prisma/client';

export const FEE_KINDS = ['FEE', 'DEPOSIT'] as const;
export const FEE_SCOPES = ['GLOBAL', 'FACILITY', 'PRODUCT', 'EXCEPTION'] as const;
export const FEE_AMOUNT_KINDS = ['FLAT', 'PCT', 'MONTHS'] as const;

export interface FeeInput {
  kind?: FeeKind;
  key: string;
  scope?: FeeScope;
  branchId?: string | null;
  sizeId?: string | null;
  tenantId?: string | null;
  amount: number;
  amountKind?: string;
  active?: boolean;
  note?: string | null;
}

export interface FeeFilter {
  kind?: string;
  key?: string;
  branchId?: string;
  active?: boolean;
}

type FeeWithTargets = Prisma.FacilityFeeGetPayload<{
  include: { branch: { select: { code: true; name: true } }; unitSize: { select: { code: true; name: true } }; tenant: { select: { name: true } } };
}>;

function serializeFee(f: FeeWithTargets) {
  return {
    id: f.id,
    kind: f.kind,
    key: f.key,
    scope: f.scope,
    branchId: f.branchId,
    branch: f.branch,
    sizeId: f.sizeId,
    size: f.unitSize,
    tenantId: f.tenantId,
    tenant: f.tenant,
    amount: toNum(f.amount),
    amountKind: f.amountKind,
    active: f.active,
    note: f.note,
    updatedAt: f.updatedAt,
  };
}

const FEE_INCLUDE = {
  branch: { select: { code: true, name: true } },
  unitSize: { select: { code: true, name: true } },
  tenant: { select: { name: true } },
} as const;

function scopeTargets(scope: FeeScope, input: FeeInput) {
  // A row's scope must agree with the target it carries: GLOBAL carries no
  // target, FACILITY a branch, PRODUCT a size, EXCEPTION a tenant.
  if (scope === 'GLOBAL' && (input.branchId || input.sizeId || input.tenantId)) {
    throw new AppError(400, 'VALIDATION', 'GLOBAL fees carry no branch/size/tenant target.');
  }
  if (scope === 'FACILITY' && !input.branchId) {
    throw new AppError(400, 'VALIDATION', 'FACILITY fees require branchId.');
  }
  if (scope === 'PRODUCT' && !input.sizeId) {
    throw new AppError(400, 'VALIDATION', 'PRODUCT fees require sizeId.');
  }
  if (scope === 'EXCEPTION' && !input.tenantId) {
    throw new AppError(400, 'VALIDATION', 'EXCEPTION fees require tenantId.');
  }
}

async function assertTargetsExist(input: FeeInput) {
  if (input.branchId) {
    const b = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!b) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  }
  if (input.sizeId) {
    const s = await prisma.unitSize.findUnique({ where: { id: input.sizeId } });
    if (!s) throw new AppError(400, 'VALIDATION', `Unit size ${input.sizeId} not found`);
  }
  if (input.tenantId) {
    const t = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
    if (!t) throw new AppError(400, 'VALIDATION', `Tenant ${input.tenantId} not found`);
  }
}

export async function listFees(filter: FeeFilter = {}) {
  const rows = await prisma.facilityFee.findMany({
    where: {
      ...(filter.kind ? { kind: filter.kind as FeeKind } : {}),
      ...(filter.key ? { key: filter.key } : {}),
      ...(filter.branchId ? { branchId: filter.branchId } : {}),
      ...(filter.active !== undefined ? { active: filter.active } : {}),
    },
    include: FEE_INCLUDE,
    orderBy: [{ kind: 'asc' }, { key: 'asc' }, { scope: 'asc' }],
  });
  return rows.map(serializeFee);
}

export async function createFee(input: FeeInput) {
  const scope = input.scope ?? 'GLOBAL';
  scopeTargets(scope, input);
  await assertTargetsExist(input);
  if (input.amountKind && !FEE_AMOUNT_KINDS.includes(input.amountKind as never)) {
    throw new AppError(400, 'VALIDATION', 'amountKind must be one of: FLAT, PCT, MONTHS.');
  }
  const row = await prisma.facilityFee.create({
    data: {
      kind: input.kind ?? 'FEE',
      key: input.key.trim(),
      scope,
      branchId: input.branchId ?? null,
      sizeId: input.sizeId ?? null,
      tenantId: input.tenantId ?? null,
      amount: input.amount,
      amountKind: input.amountKind ?? 'FLAT',
      active: input.active ?? true,
      note: input.note?.trim() || null,
    },
    include: FEE_INCLUDE,
  });
  return serializeFee(row);
}

export async function updateFee(id: string, input: Partial<FeeInput>) {
  const existing = await prisma.facilityFee.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Fee ${id} not found`);
  const scope = input.scope ?? existing.scope;
  scopeTargets(scope, {
    key: input.key ?? existing.key,
    amount: input.amount ?? 0,
    branchId: input.branchId !== undefined ? input.branchId : existing.branchId,
    sizeId: input.sizeId !== undefined ? input.sizeId : existing.sizeId,
    tenantId: input.tenantId !== undefined ? input.tenantId : existing.tenantId,
  });
  await assertTargetsExist({
    key: '',
    amount: 0,
    branchId: input.branchId !== undefined ? input.branchId : existing.branchId,
    sizeId: input.sizeId !== undefined ? input.sizeId : existing.sizeId,
    tenantId: input.tenantId !== undefined ? input.tenantId : existing.tenantId,
  });
  if (input.amountKind && !FEE_AMOUNT_KINDS.includes(input.amountKind as never)) {
    throw new AppError(400, 'VALIDATION', 'amountKind must be one of: FLAT, PCT, MONTHS.');
  }
  const row = await prisma.facilityFee.update({
    where: { id },
    data: {
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.key ? { key: input.key.trim() } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...(input.sizeId !== undefined ? { sizeId: input.sizeId } : {}),
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(input.amountKind ? { amountKind: input.amountKind } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
    },
    include: FEE_INCLUDE,
  });
  return serializeFee(row);
}

export async function deleteFee(id: string) {
  const existing = await prisma.facilityFee.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Fee ${id} not found`);
  await prisma.facilityFee.delete({ where: { id } });
  return { id };
}

export interface FeeResolveQuery {
  kind?: FeeKind;
  key: string;
  branchId?: string;
  sizeId?: string;
  tenantId?: string;
}

// Collapse the priority chain to the single effective rule: the most specific
// ACTIVE row matching (kind, key) whose targets all agree with the context —
// EXCEPTION (tenantId match) > PRODUCT (sizeId match) > FACILITY (branchId
// match) > GLOBAL. Returns null when no row covers the key (callers fall back
// to their own default — there is intentionally no hardcoded fee schedule).
export async function resolveFee(query: FeeResolveQuery) {
  const rows = await prisma.facilityFee.findMany({
    where: { kind: query.kind ?? 'FEE', key: query.key, active: true },
    include: FEE_INCLUDE,
  });
  const match = (scope: FeeScope) =>
    rows.find((r) => {
      if (r.scope !== scope) return false;
      if (scope === 'EXCEPTION') return !!query.tenantId && r.tenantId === query.tenantId;
      if (scope === 'PRODUCT') {
        if (!query.sizeId || r.sizeId !== query.sizeId) return false;
        // A product row pinned to a branch only fires for that branch.
        if (r.branchId && r.branchId !== query.branchId) return false;
        return true;
      }
      if (scope === 'FACILITY') return !!query.branchId && r.branchId === query.branchId;
      return true;
    });
  const winner =
    match('EXCEPTION') ?? match('PRODUCT') ?? match('FACILITY') ?? match('GLOBAL') ?? null;
  if (!winner) return null;
  return { ...serializeFee(winner), matchedScope: winner.scope };
}

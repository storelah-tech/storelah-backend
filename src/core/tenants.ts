import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { AccountType, Prisma, TenantStatus } from '@prisma/client';

type TenantWithUnit = Prisma.TenantGetPayload<{
  include: { unit: { include: { size: true } } };
}>;

export interface CreateTenantInput {
  name: string;
  type?: AccountType;
  segment?: string;
  email?: string;
  mobile?: string;
  unitId?: string;
  moveInDate?: Date;
  monthlyRate: number;
  sqft?: number;
  status?: TenantStatus;
  autoDebit?: boolean;
}

export interface UpdateTenantInput {
  name?: string;
  type?: AccountType;
  segment?: string | null;
  email?: string;
  mobile?: string | null;
  unitId?: string | null;
  monthlyRate?: number;
  status?: TenantStatus;
  autoDebit?: boolean;
}

function serializeTenant(t: TenantWithUnit) {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    segment: t.segment,
    email: t.email,
    mobile: t.mobile,
    unit: t.unit?.unitCode ?? null,
    size: t.unit?.size?.name ?? null,
    sqft: t.unit?.sqft ?? null,
    rate: toNum(t.monthlyRate),
    psf: toNum(t.psf),
    since: t.moveInDate,
    nextPayment: t.nextPayment,
    status: t.status,
    autoDebit: t.autoDebit,
  };
}

function isOccupiedStatus(status: string) {
  return status === 'OCCUPIED' || status === 'OVERDUE';
}

// Guard shared by create + reassignment: a unit is assignable only when it is not
// already pointed at by any tenant (matches the unitId @unique DB backstop) and is
// not in a business-occupied status.
async function assertUnitAssignable(unitId: string, opts?: { selfId?: string }) {
  const unit = await prisma.unit.findUnique({
    where: { id: unitId, deletedAt: null },
    include: { tenant: true },
  });
  if (!unit) throw new AppError(400, 'VALIDATION', `Unit ${unitId} not found`);
  if (unit.tenant && unit.tenant.id !== opts?.selfId) {
    throw new AppError(400, 'VALIDATION', `Unit ${unit.unitCode} is already assigned to another tenant`);
  }
  if (isOccupiedStatus(unit.status)) {
    throw new AppError(400, 'VALIDATION', `Unit ${unit.unitCode} is ${unit.status.toLowerCase()} and cannot be assigned`);
  }
  return unit;
}

export async function createTenant(input: CreateTenantInput) {
  let sqft = input.sqft;
  if (input.unitId) {
    const unit = await assertUnitAssignable(input.unitId);
    sqft = unit.sqft;
  }

  const tenant = await prisma.tenant.create({
    data: {
      name: input.name,
      type: input.type ?? 'PERSONAL',
      segment: input.segment,
      email: input.email,
      mobile: input.mobile,
      unitId: input.unitId,
      moveInDate: input.moveInDate,
      monthlyRate: input.monthlyRate,
      psf: sqft ? input.monthlyRate / sqft : input.monthlyRate,
      status: input.status ?? 'ACTIVE',
      autoDebit: input.autoDebit ?? false,
    },
    include: { unit: { include: { size: true } } },
  });
  return serializeTenant(tenant);
}

export async function updateTenant(id: string, input: UpdateTenantInput) {
  const tenant = await prisma.tenant.findUnique({
    where: { id },
    include: { unit: true },
  });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', `Tenant ${id} not found`);

  // unitId is tri-state on update: undefined = leave the assignment untouched,
  // null = release the current unit, string = (re)assign to that unit.
  const hasUnitChange = input.unitId !== undefined;
  let nextUnitId = tenant.unitId;
  let releaseUnitId: string | null = null;
  let sqft: number | null = tenant.unit?.sqft ?? null;

  if (hasUnitChange) {
    const targetUnitId = input.unitId;
    if (targetUnitId === null) {
      if (tenant.unitId) {
        releaseUnitId = tenant.unitId;
        nextUnitId = null;
        sqft = null;
      }
    } else if (targetUnitId != null && targetUnitId !== tenant.unitId) {
      const target = await assertUnitAssignable(targetUnitId, { selfId: id });
      if (tenant.unitId) releaseUnitId = tenant.unitId;
      nextUnitId = targetUnitId;
      sqft = target.sqft;
    }
  }

  const rate = input.monthlyRate != null ? input.monthlyRate : toNum(tenant.monthlyRate);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.tenant.update({
      where: { id },
      data: {
        name: input.name,
        type: input.type,
        segment: input.segment,
        email: input.email,
        mobile: input.mobile,
        monthlyRate: input.monthlyRate,
        unitId: nextUnitId,
        psf: sqft != null ? rate / sqft : undefined,
        status: input.status,
        autoDebit: input.autoDebit,
      },
    });
    // Release the tenant's previous unit back to AVAILABLE (consistent with deactivateTenant).
    if (releaseUnitId) {
      await tx.unit.update({ where: { id: releaseUnitId }, data: { status: 'AVAILABLE' } });
    }
    return tx.tenant.findUnique({
      where: { id },
      include: { unit: { include: { size: true } } },
    });
  });

  return serializeTenant(updated!);
}

export async function deactivateTenant(id: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', `Tenant ${id} not found`);

  const unitId = tenant.unitId;
  const updated = await prisma.$transaction([
    prisma.tenant.update({ where: { id }, data: { status: 'INACTIVE', unitId: null } }),
    ...(unitId
      ? [prisma.unit.update({ where: { id: unitId }, data: { status: 'AVAILABLE' } })]
      : []),
  ]);

  return { id, unitReleased: updated[0].unitId === null };
}

export async function listTenants(opts?: { from?: Date; to?: Date }) {
  const createdAt: { gte?: Date; lte?: Date } = {};
  if (opts?.from) createdAt.gte = opts.from;
  if (opts?.to) createdAt.lte = opts.to;
  const tenants = await prisma.tenant.findMany({
    where: createdAt.gte || createdAt.lte ? { createdAt } : undefined,
    include: { unit: { include: { size: true, branch: true } } },
    orderBy: { name: 'asc' },
  });

  const rows = tenants.map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    segment: t.segment,
    email: t.email,
    mobile: t.mobile,
    unit: t.unit?.unitCode ?? null,
    size: t.unit?.size?.name ?? null,
    sqft: t.unit?.sqft ?? null,
    // Facility attribution for the CMS sidebar facility filter ("All Facilities").
    branchCode: t.unit?.branch?.code ?? null,
    branchName: t.unit?.branch?.name ?? null,
    rate: toNum(t.monthlyRate),
    psf: toNum(t.psf),
    since: t.moveInDate,
    nextPayment: t.nextPayment,
    status: t.status,
    autoDebit: t.autoDebit,
  }));

  return rows;
}

// ---------- move-outs queue (P1 item 4) ----------
//
// Read-model over the existing Notice rows + TenantStatus.NOTICE — no
// migration. Workflow/state machine with EXPLICIT operator transitions only:
//   - submitting a Notice (customer portal) never flips tenant status
//     (unchanged — see the Notice model docs);
//   - the operator moves a tenant out via PATCH /move-outs/:tenantId
//     { action: 'complete' } (NOTICE → INACTIVE + unit released) or withdraws
//     the notice via { action: 'cancel' } (NOTICE → ACTIVE, unit untouched).
// There is no auto-transition anywhere in this path.
export interface MoveOutRow {
  tenantId: string;
  name: string;
  email: string | null;
  mobile: string | null;
  status: TenantStatus;
  unitCode: string | null;
  branchCode: string | null;
  branchName: string | null;
  monthlyRate: number;
  lastDay: Date | null;
  noticeCount: number;
  submittedAt: Date | null;
}

export async function listMoveOuts(): Promise<MoveOutRow[]> {
  const tenants = await prisma.tenant.findMany({
    where: { status: 'NOTICE' },
    include: {
      unit: { include: { size: true, branch: true } },
      notices: { orderBy: { createdAt: 'desc' } },
    },
    orderBy: { name: 'asc' },
  });
  return tenants.map((t) => {
    const latest = t.notices[0] ?? null;
    return {
      tenantId: t.id,
      name: t.name,
      email: t.email,
      mobile: t.mobile,
      status: t.status,
      unitCode: t.unit?.unitCode ?? null,
      branchCode: t.unit?.branch?.code ?? null,
      branchName: t.unit?.branch?.name ?? null,
      monthlyRate: toNum(t.monthlyRate),
      lastDay: latest?.lastDay ?? null,
      noticeCount: t.notices.length,
      submittedAt: latest?.createdAt ?? null,
    };
  });
}

export type MoveOutAction = 'complete' | 'cancel';

export async function transitionMoveOut(tenantId: string, action: MoveOutAction) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { unit: true },
  });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', `Tenant ${tenantId} not found`);
  if (tenant.status !== 'NOTICE') {
    throw new AppError(
      409,
      'CONFLICT',
      `Tenant ${tenant.name} is ${tenant.status}, not NOTICE — only tenants on notice can move out`,
    );
  }
  if (action === 'complete') {
    // Explicit operator action: end the tenancy and release the unit.
    await prisma.$transaction([
      prisma.tenant.update({ where: { id: tenantId }, data: { status: 'INACTIVE', unitId: null } }),
      ...(tenant.unitId
        ? [prisma.unit.update({ where: { id: tenant.unitId }, data: { status: 'AVAILABLE' } })]
        : []),
    ]);
    return { tenantId, action, status: 'INACTIVE' as const, unitReleased: tenant.unitId !== null };
  }
  // cancel: withdraw the notice, tenancy continues, unit untouched.
  const updated = await prisma.tenant.update({
    where: { id: tenantId },
    data: { status: 'ACTIVE' },
  });
  return { tenantId, action, status: updated.status, unitReleased: false };
}
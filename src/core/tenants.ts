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

export async function listTenants() {
  const tenants = await prisma.tenant.findMany({
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
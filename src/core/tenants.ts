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
    unit: t.unit?.unitCode ?? null,
    size: t.unit?.size?.name ?? null,
    sqft: t.unit?.sqft ?? null,
    rate: toNum(t.monthlyRate),
    psf: toNum(t.psf),
    since: t.moveInDate,
    nextPayment: t.nextPayment,
    status: t.status,
  };
}

export async function createTenant(input: CreateTenantInput) {
  let sqft = input.sqft;
  if (input.unitId) {
    const unit = await prisma.unit.findUnique({
      where: { id: input.unitId, deletedAt: null },
    });
    if (!unit) throw new AppError(400, 'VALIDATION', `Unit ${input.unitId} not found`);
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
  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) throw new AppError(404, 'NOT_FOUND', `Tenant ${id} not found`);

  const unit = tenant.unitId
    ? await prisma.unit.findUnique({ where: { id: tenant.unitId, deletedAt: null } })
    : null;
  const sqft = unit?.sqft ?? null;

  const updated = await prisma.tenant.update({
    where: { id },
    data: {
      name: input.name,
      type: input.type,
      segment: input.segment,
      email: input.email,
      mobile: input.mobile,
      monthlyRate: input.monthlyRate,
      psf: input.monthlyRate && sqft ? input.monthlyRate / sqft : undefined,
      status: input.status,
      autoDebit: input.autoDebit,
    },
    include: { unit: { include: { size: true } } },
  });
  return serializeTenant(updated);
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
    include: { unit: { include: { size: true } } },
    orderBy: { name: 'asc' },
  });

  const rows = tenants.map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    segment: t.segment,
    unit: t.unit?.unitCode ?? null,
    size: t.unit?.size?.name ?? null,
    sqft: t.unit?.sqft ?? null,
    rate: toNum(t.monthlyRate),
    psf: toNum(t.psf),
    since: t.moveInDate,
    nextPayment: t.nextPayment,
    status: t.status,
  }));

  return rows;
}
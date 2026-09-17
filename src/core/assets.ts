import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { AssetStatus, Prisma, VendorStatus } from '@prisma/client';

type AssetRow = Prisma.AssetGetPayload<{
  include: { branch: { select: { code: true; name: true } } };
}>;

function serializeAsset(a: AssetRow) {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    category: a.category,
    branchId: a.branchId,
    branchCode: a.branch?.code ?? null,
    branchName: a.branch?.name ?? null,
    status: a.status,
    purchaseDate: a.purchaseDate,
    value: a.value == null ? null : toNum(a.value),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export interface CreateAssetInput {
  code: string;
  name: string;
  category: string;
  branchId?: string | null;
  status?: AssetStatus;
  purchaseDate?: Date | null;
  value?: number | null;
}

export interface UpdateAssetInput {
  name?: string;
  category?: string;
  branchId?: string | null;
  status?: AssetStatus;
  purchaseDate?: Date | null;
  value?: number | null;
}

const ASSET_INCLUDE = { branch: { select: { code: true, name: true } } } as const;

export async function listAssets(query: { status?: string; branchId?: string } = {}) {
  const rows = await prisma.asset.findMany({
    where: {
      ...(query.status ? { status: query.status as AssetStatus } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
    },
    include: ASSET_INCLUDE,
    orderBy: { code: 'asc' },
  });
  return rows.map(serializeAsset);
}

export async function getAsset(id: string) {
  const row = await prisma.asset.findUnique({ where: { id }, include: ASSET_INCLUDE });
  if (!row) throw new AppError(404, 'NOT_FOUND', `Asset ${id} not found`);
  return serializeAsset(row);
}

export async function createAsset(input: CreateAssetInput) {
  const clash = await prisma.asset.findUnique({ where: { code: input.code } });
  if (clash) throw new AppError(409, 'CONFLICT', `Asset code ${input.code} already exists`);
  if (input.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  }
  const row = await prisma.asset.create({
    data: {
      code: input.code,
      name: input.name,
      category: input.category,
      branchId: input.branchId ?? null,
      status: input.status ?? 'ACTIVE',
      purchaseDate: input.purchaseDate ?? null,
      value: input.value ?? null,
    },
    include: ASSET_INCLUDE,
  });
  return serializeAsset(row);
}

export async function updateAsset(id: string, input: UpdateAssetInput) {
  const existing = await prisma.asset.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Asset ${id} not found`);
  if (input.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  }
  const row = await prisma.asset.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.purchaseDate !== undefined ? { purchaseDate: input.purchaseDate } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
    },
    include: ASSET_INCLUDE,
  });
  return serializeAsset(row);
}

export async function deleteAsset(id: string) {
  const existing = await prisma.asset.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Asset ${id} not found`);
  await prisma.asset.delete({ where: { id } });
  return { id };
}

// --- Vendor register (SLA + YTD spend) ---

function serializeVendor(v: Prisma.VendorGetPayload<Record<string, never>>) {
  return {
    id: v.id,
    name: v.name,
    service: v.service,
    sla: v.sla,
    ytdSpend: toNum(v.ytdSpend),
    status: v.status,
    contact: v.contact,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

export interface CreateVendorInput {
  name: string;
  service?: string | null;
  sla?: string | null;
  ytdSpend?: number;
  status?: VendorStatus;
  contact?: string | null;
}

export interface UpdateVendorInput {
  name?: string;
  service?: string | null;
  sla?: string | null;
  ytdSpend?: number;
  status?: VendorStatus;
  contact?: string | null;
}

export async function listVendors(query: { status?: string } = {}) {
  const rows = await prisma.vendor.findMany({
    where: { ...(query.status ? { status: query.status as VendorStatus } : {}) },
    orderBy: { name: 'asc' },
  });
  return rows.map(serializeVendor);
}

export async function getVendor(id: string) {
  const row = await prisma.vendor.findUnique({ where: { id } });
  if (!row) throw new AppError(404, 'NOT_FOUND', `Vendor ${id} not found`);
  return serializeVendor(row);
}

export async function createVendor(input: CreateVendorInput) {
  const row = await prisma.vendor.create({
    data: {
      name: input.name,
      service: input.service ?? null,
      sla: input.sla ?? null,
      ytdSpend: input.ytdSpend ?? 0,
      status: input.status ?? 'ACTIVE',
      contact: input.contact ?? null,
    },
  });
  return serializeVendor(row);
}

export async function updateVendor(id: string, input: UpdateVendorInput) {
  const existing = await prisma.vendor.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Vendor ${id} not found`);
  const row = await prisma.vendor.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.service !== undefined ? { service: input.service } : {}),
      ...(input.sla !== undefined ? { sla: input.sla } : {}),
      ...(input.ytdSpend !== undefined ? { ytdSpend: input.ytdSpend } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.contact !== undefined ? { contact: input.contact } : {}),
    },
  });
  return serializeVendor(row);
}

export async function deleteVendor(id: string) {
  const existing = await prisma.vendor.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Vendor ${id} not found`);
  await prisma.vendor.delete({ where: { id } });
  return { id };
}

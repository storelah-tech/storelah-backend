import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { CertificateStatus, ChecklistStatus, InspectionFrequency, Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Inspections & compliance: recurring checklists (daily / monthly / ...) and
// compliance certificates (Fire Safety / Lift / Public Liability / ...) with
// expiry dates. Expiry surfacing reads expiryDate — the status mirror is
// maintained on write but never trusted over the date itself.
// ---------------------------------------------------------------------------

type ChecklistRow = Prisma.InspectionChecklistGetPayload<{
  include: { branch: { select: { code: true; name: true } } };
}>;

function serializeChecklist(c: ChecklistRow) {
  const items = Array.isArray(c.items) ? c.items : [];
  return {
    id: c.id,
    title: c.title,
    frequency: c.frequency,
    branchId: c.branchId,
    branchCode: c.branch?.code ?? null,
    branchName: c.branch?.name ?? null,
    items,
    steps: items.length,
    percentComplete: c.percentComplete,
    status: c.status,
    dueDate: c.dueDate,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

const CHECKLIST_INCLUDE = { branch: { select: { code: true, name: true } } } as const;

export interface CreateChecklistInput {
  title: string;
  frequency?: InspectionFrequency;
  branchId?: string | null;
  items?: unknown;
  percentComplete?: number;
  status?: ChecklistStatus;
  dueDate?: Date | null;
}

async function assertChecklistBranch(branchId?: string | null) {
  if (branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${branchId} not found`);
  }
}

function assertPercent(v: number | undefined, field: string) {
  if (v != null && (v < 0 || v > 100)) {
    throw new AppError(400, 'VALIDATION', `${field} must be 0..100`);
  }
}

export async function listChecklists(query: { frequency?: string; branchId?: string } = {}) {
  const rows = await prisma.inspectionChecklist.findMany({
    where: {
      ...(query.frequency ? { frequency: query.frequency as InspectionFrequency } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
    },
    include: CHECKLIST_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(serializeChecklist);
}

export async function createChecklist(input: CreateChecklistInput) {
  await assertChecklistBranch(input.branchId ?? null);
  assertPercent(input.percentComplete, 'percentComplete');
  const row = await prisma.inspectionChecklist.create({
    data: {
      title: input.title,
      frequency: input.frequency ?? 'DAILY',
      branchId: input.branchId ?? null,
      items: input.items === undefined ? [] : (input.items as Prisma.InputJsonValue),
      percentComplete: input.percentComplete ?? 0,
      status: input.status ?? 'OPEN',
      dueDate: input.dueDate ?? null,
    },
    include: CHECKLIST_INCLUDE,
  });
  return serializeChecklist(row);
}

export async function updateChecklist(id: string, input: Partial<CreateChecklistInput>) {
  const existing = await prisma.inspectionChecklist.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Checklist ${id} not found`);
  if (input.branchId) await assertChecklistBranch(input.branchId);
  assertPercent(input.percentComplete, 'percentComplete');
  const row = await prisma.inspectionChecklist.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...(input.items !== undefined ? { items: input.items as Prisma.InputJsonValue } : {}),
      ...(input.percentComplete !== undefined ? { percentComplete: input.percentComplete } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
    },
    include: CHECKLIST_INCLUDE,
  });
  return serializeChecklist(row);
}

export async function deleteChecklist(id: string) {
  const existing = await prisma.inspectionChecklist.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Checklist ${id} not found`);
  await prisma.inspectionChecklist.delete({ where: { id } });
  return { id };
}

// --- Compliance certificates ---

type CertificateRow = Prisma.ComplianceCertificateGetPayload<{
  include: { branch: { select: { code: true; name: true } } };
}>;

export const CERT_EXPIRING_DAYS = 60;

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

export function deriveCertificateStatus(expiryDate: Date): CertificateStatus {
  const days = daysUntil(expiryDate);
  if (days < 0) return 'EXPIRED';
  if (days <= CERT_EXPIRING_DAYS) return 'EXPIRING';
  return 'VALID';
}

function serializeCertificate(c: CertificateRow) {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    branchId: c.branchId,
    branchCode: c.branch?.code ?? null,
    branchName: c.branch?.name ?? null,
    issuer: c.issuer,
    expiryDate: c.expiryDate,
    daysUntilExpiry: daysUntil(c.expiryDate),
    // Expiry surfacing derives from the date, not the stored mirror.
    derivedStatus: deriveCertificateStatus(c.expiryDate),
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

const CERTIFICATE_INCLUDE = { branch: { select: { code: true, name: true } } } as const;

export interface CreateCertificateInput {
  name: string;
  type: string;
  branchId?: string | null;
  issuer?: string | null;
  expiryDate: Date;
  status?: CertificateStatus;
}

export async function listCertificates(query: { branchId?: string; expiring?: boolean } = {}) {
  const rows = await prisma.complianceCertificate.findMany({
    where: { ...(query.branchId ? { branchId: query.branchId } : {}) },
    include: CERTIFICATE_INCLUDE,
    orderBy: { expiryDate: 'asc' },
  });
  const serialized = rows.map(serializeCertificate);
  if (!query.expiring) return serialized;
  // Expiring = derived EXPIRING or EXPIRED (surfacing reads the date).
  return serialized.filter((c) => c.derivedStatus !== 'VALID');
}

export async function createCertificate(input: CreateCertificateInput) {
  if (input.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  }
  const row = await prisma.complianceCertificate.create({
    data: {
      name: input.name,
      type: input.type,
      branchId: input.branchId ?? null,
      issuer: input.issuer ?? null,
      expiryDate: input.expiryDate,
      status: input.status ?? deriveCertificateStatus(input.expiryDate),
    },
    include: CERTIFICATE_INCLUDE,
  });
  return serializeCertificate(row);
}

export async function updateCertificate(id: string, input: Partial<CreateCertificateInput>) {
  const existing = await prisma.complianceCertificate.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Certificate ${id} not found`);
  if (input.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  }
  const nextExpiry = input.expiryDate ?? existing.expiryDate;
  const row = await prisma.complianceCertificate.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...(input.issuer !== undefined ? { issuer: input.issuer } : {}),
      ...(input.expiryDate !== undefined ? { expiryDate: input.expiryDate } : {}),
      // Keep the stored mirror in sync unless the caller sets it explicitly.
      status: input.status ?? deriveCertificateStatus(nextExpiry),
    },
    include: CERTIFICATE_INCLUDE,
  });
  return serializeCertificate(row);
}

export async function deleteCertificate(id: string) {
  const existing = await prisma.complianceCertificate.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Certificate ${id} not found`);
  await prisma.complianceCertificate.delete({ where: { id } });
  return { id };
}

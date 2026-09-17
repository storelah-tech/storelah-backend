import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import {
  AccessEventResult,
  CredentialStatus,
  CredentialType,
  DoorStatus,
  Prisma,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// Access control: doors + credentials + events + policies.
// The admin "Access" screen renders 5 sub-panels from these four aggregates:
//   Live        → latest access events
//   Credentials → all credentials
//   Temporary   → credentials with a validTo expiry (TEMPORARY / VISITOR)
//   Exceptions  → events with result DENIED
//   Policies    → access policies
// ---------------------------------------------------------------------------

type DoorRow = Prisma.AccessDoorGetPayload<{
  include: { branch: { select: { code: true; name: true } } };
}>;

function serializeDoor(d: DoorRow) {
  return {
    id: d.id,
    code: d.code,
    name: d.name,
    branchId: d.branchId,
    branchCode: d.branch?.code ?? null,
    branchName: d.branch?.name ?? null,
    location: d.location,
    status: d.status,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

const DOOR_INCLUDE = { branch: { select: { code: true, name: true } } } as const;

export interface CreateDoorInput {
  code: string;
  name: string;
  branchId?: string | null;
  location?: string | null;
  status?: DoorStatus;
}

export async function listDoors(query: { branchId?: string; status?: string } = {}) {
  const rows = await prisma.accessDoor.findMany({
    where: {
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.status ? { status: query.status as DoorStatus } : {}),
    },
    include: DOOR_INCLUDE,
    orderBy: { code: 'asc' },
  });
  return rows.map(serializeDoor);
}

export async function createDoor(input: CreateDoorInput) {
  const clash = await prisma.accessDoor.findUnique({ where: { code: input.code } });
  if (clash) throw new AppError(409, 'CONFLICT', `Door code ${input.code} already exists`);
  if (input.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  }
  const row = await prisma.accessDoor.create({
    data: {
      code: input.code,
      name: input.name,
      branchId: input.branchId ?? null,
      location: input.location ?? null,
      status: input.status ?? 'ACTIVE',
    },
    include: DOOR_INCLUDE,
  });
  return serializeDoor(row);
}

export async function updateDoor(id: string, input: Partial<CreateDoorInput>) {
  const existing = await prisma.accessDoor.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Door ${id} not found`);
  if (input.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  }
  const row = await prisma.accessDoor.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
    include: DOOR_INCLUDE,
  });
  return serializeDoor(row);
}

export async function deleteDoor(id: string) {
  const existing = await prisma.accessDoor.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Door ${id} not found`);
  const events = await prisma.accessEvent.count({ where: { doorId: id } });
  if (events > 0) throw new AppError(409, 'CONFLICT', 'Door has access events and cannot be deleted');
  await prisma.accessDoor.delete({ where: { id } });
  return { id };
}

// --- Credentials ---

type CredentialRow = Prisma.AccessCredentialGetPayload<{
  include: { branch: { select: { code: true; name: true } } };
}>;

function serializeCredential(c: CredentialRow) {
  return {
    id: c.id,
    holderName: c.holderName,
    type: c.type,
    status: c.status,
    branchId: c.branchId,
    branchCode: c.branch?.code ?? null,
    branchName: c.branch?.name ?? null,
    validFrom: c.validFrom,
    validTo: c.validTo,
    expired: c.validTo != null && c.validTo.getTime() < Date.now(),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

const CREDENTIAL_INCLUDE = { branch: { select: { code: true, name: true } } } as const;

export interface CreateCredentialInput {
  holderName: string;
  type?: CredentialType;
  status?: CredentialStatus;
  branchId?: string | null;
  validFrom?: Date | null;
  validTo?: Date | null;
}

export async function listCredentials(query: { status?: string; type?: string; temporary?: boolean } = {}) {
  const rows = await prisma.accessCredential.findMany({
    where: {
      ...(query.status ? { status: query.status as CredentialStatus } : {}),
      ...(query.type ? { type: query.type as CredentialType } : {}),
      // Temporary sub-panel: credentials carrying an expiry window.
      ...(query.temporary ? { validTo: { not: null } } : {}),
    },
    include: CREDENTIAL_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(serializeCredential);
}

export async function createCredential(input: CreateCredentialInput) {
  if (input.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  }
  if (input.validFrom && input.validTo && input.validTo <= input.validFrom) {
    throw new AppError(400, 'VALIDATION', 'validTo must be after validFrom');
  }
  const row = await prisma.accessCredential.create({
    data: {
      holderName: input.holderName,
      type: input.type ?? 'PERMANENT',
      status: input.status ?? 'ACTIVE',
      branchId: input.branchId ?? null,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
    },
    include: CREDENTIAL_INCLUDE,
  });
  return serializeCredential(row);
}

export async function updateCredential(id: string, input: Partial<CreateCredentialInput>) {
  const existing = await prisma.accessCredential.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Credential ${id} not found`);
  if (input.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  }
  const validFrom = input.validFrom === undefined ? existing.validFrom : input.validFrom;
  const validTo = input.validTo === undefined ? existing.validTo : input.validTo;
  if (validFrom && validTo && validTo <= validFrom) {
    throw new AppError(400, 'VALIDATION', 'validTo must be after validFrom');
  }
  const row = await prisma.accessCredential.update({
    where: { id },
    data: {
      ...(input.holderName !== undefined ? { holderName: input.holderName } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
    },
    include: CREDENTIAL_INCLUDE,
  });
  return serializeCredential(row);
}

export async function deleteCredential(id: string) {
  const existing = await prisma.accessCredential.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Credential ${id} not found`);
  const events = await prisma.accessEvent.count({ where: { credentialId: id } });
  if (events > 0) throw new AppError(409, 'CONFLICT', 'Credential has access events and cannot be deleted');
  await prisma.accessCredential.delete({ where: { id } });
  return { id };
}

// --- Policies ---

function serializePolicy(p: Prisma.AccessPolicyGetPayload<Record<string, never>>) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    scope: p.scope,
    active: p.active,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function listPolicies() {
  const rows = await prisma.accessPolicy.findMany({ orderBy: { name: 'asc' } });
  return rows.map(serializePolicy);
}

export async function createPolicy(input: { name: string; description?: string | null; scope?: string | null; active?: boolean }) {
  const row = await prisma.accessPolicy.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      scope: input.scope ?? null,
      active: input.active ?? true,
    },
  });
  return serializePolicy(row);
}

export async function updatePolicy(
  id: string,
  input: { name?: string; description?: string | null; scope?: string | null; active?: boolean },
) {
  const existing = await prisma.accessPolicy.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Policy ${id} not found`);
  const row = await prisma.accessPolicy.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
  return serializePolicy(row);
}

export async function deletePolicy(id: string) {
  const existing = await prisma.accessPolicy.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Policy ${id} not found`);
  await prisma.accessPolicy.delete({ where: { id } });
  return { id };
}

// --- Events ---

type AccessEventRow = Prisma.AccessEventGetPayload<{
  include: {
    door: { select: { code: true; name: true } };
    credential: { select: { holderName: true; type: true } };
    branch: { select: { code: true; name: true } };
  };
}>;

function serializeEvent(e: AccessEventRow) {
  return {
    id: e.id,
    doorId: e.doorId,
    doorCode: e.door?.code ?? null,
    doorName: e.door?.name ?? null,
    credentialId: e.credentialId,
    holderName: e.credential?.holderName ?? null,
    credentialType: e.credential?.type ?? null,
    branchId: e.branchId,
    branchCode: e.branch?.code ?? null,
    branchName: e.branch?.name ?? null,
    result: e.result,
    occurredAt: e.occurredAt,
    note: e.note,
    createdAt: e.createdAt,
  };
}

const EVENT_INCLUDE = {
  door: { select: { code: true, name: true } },
  credential: { select: { holderName: true, type: true } },
  branch: { select: { code: true, name: true } },
} as const;

export async function listAccessEvents(query: { result?: string; branchId?: string; limit?: number } = {}) {
  const limit = Math.min(200, Math.max(1, query.limit ?? 50));
  const rows = await prisma.accessEvent.findMany({
    where: {
      ...(query.result ? { result: query.result as AccessEventResult } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
    },
    include: EVENT_INCLUDE,
    orderBy: { occurredAt: 'desc' },
    take: limit,
  });
  return rows.map(serializeEvent);
}

export async function createAccessEvent(input: {
  doorId?: string | null;
  credentialId?: string | null;
  branchId?: string | null;
  result?: AccessEventResult;
  occurredAt?: Date;
  note?: string | null;
}) {
  if (input.doorId) {
    const door = await prisma.accessDoor.findUnique({ where: { id: input.doorId } });
    if (!door) throw new AppError(400, 'VALIDATION', `Door ${input.doorId} not found`);
  }
  if (input.credentialId) {
    const cred = await prisma.accessCredential.findUnique({ where: { id: input.credentialId } });
    if (!cred) throw new AppError(400, 'VALIDATION', `Credential ${input.credentialId} not found`);
  }
  if (input.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  }
  const row = await prisma.accessEvent.create({
    data: {
      doorId: input.doorId ?? null,
      credentialId: input.credentialId ?? null,
      branchId: input.branchId ?? null,
      result: input.result ?? 'GRANTED',
      occurredAt: input.occurredAt ?? new Date(),
      note: input.note ?? null,
    },
    include: EVENT_INCLUDE,
  });
  return serializeEvent(row);
}

// Header stats for the Access screen: entries / credentials / doors.
export async function getAccessStats(branchId?: string) {
  const scope = branchId ? { branchId } : {};
  const [entries, credentials, doors, denied, temporary] = await Promise.all([
    prisma.accessEvent.count({ where: scope }),
    prisma.accessCredential.count({ where: scope }),
    prisma.accessDoor.count({ where: scope }),
    prisma.accessEvent.count({ where: { ...scope, result: 'DENIED' } }),
    prisma.accessCredential.count({ where: { ...scope, validTo: { not: null } } }),
  ]);
  return { entries, credentials, doors, denied, temporary };
}

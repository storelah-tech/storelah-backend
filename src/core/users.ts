// P1 item 6 — users & roles facility scoping (largest blast radius, done last
// and carefully).
//
// Model: OperatorFacilityAccess rows scope an operator to facilities
// (branchId set) or everything (scope ALL, branchId null); Permission rows
// grant verified capabilities from the catalog below.
//
// Enforcement contract (deliberate — preserves existing auth flows):
//   - Login / JWT / requireAuth are UNCHANGED (role claim only, as today).
//   - mayAct(adminUserId, permission): operators with ZERO permission rows are
//     unchecked (legacy fallback → true). Enforcement bites ONLY for operators
//     that have at least one permission row, and then only for the listed
//     capability. New rows are opt-in, so existing logins keep working.
//   - Free-text approverRole is still recorded as a label everywhere; the
//     gated check in setPlanStatus additionally requires
//     'promotions.approve' for actors that have permission rows.
//   - Read paths (GET /users etc.) are never permission-gated — only writes.
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { Role } from '@prisma/client';

// Verified-permission catalog. Adding a capability = a new string here + a
// mayAct() call at the write path (never a role reinterpretation).
export const PERMISSIONS = [
  'promotions.approve',
  'fees.manage',
  'businessRules.manage',
  'users.manage',
] as const;

export type PermissionName = (typeof PERMISSIONS)[number];

export function isKnownPermission(p: string): p is PermissionName {
  return (PERMISSIONS as readonly string[]).includes(p);
}

function serializeUser(u: {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
  facilityAccess: Array<{ id: string; branchId: string | null; scope: string; branch: { code: string; name: string } | null }>;
  permissions: Array<{ permission: string }>;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    // Never serialize passwordHash.
    facilityAccess: u.facilityAccess.map((a) => ({
      id: a.id,
      branchId: a.branchId,
      branchCode: a.branch?.code ?? null,
      branchName: a.branch?.name ?? null,
      scope: a.scope,
    })),
    permissions: u.permissions.map((p) => p.permission),
    scoped: u.facilityAccess.length > 0,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

const USER_INCLUDE = {
  facilityAccess: { include: { branch: { select: { code: true, name: true } } } },
  permissions: true,
} as const;

export async function listUsers() {
  const rows = await prisma.adminUser.findMany({
    include: USER_INCLUDE,
    orderBy: { email: 'asc' },
  });
  return rows.map(serializeUser);
}

export async function createUser(input: { email: string; name: string; password: string; role?: Role }) {
  const email = input.email.trim().toLowerCase();
  const clash = await prisma.adminUser.findUnique({ where: { email } });
  if (clash) throw new AppError(409, 'CONFLICT', `Admin ${email} already exists`);
  const row = await prisma.adminUser.create({
    data: {
      email,
      name: input.name.trim(),
      passwordHash: await bcrypt.hash(input.password, 10),
      role: input.role ?? 'MANAGER',
    },
    include: USER_INCLUDE,
  });
  return serializeUser(row);
}

export async function updateUser(
  id: string,
  input: { name?: string; role?: Role; password?: string },
) {
  const existing = await prisma.adminUser.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `User ${id} not found`);
  const row = await prisma.adminUser.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.password !== undefined ? { passwordHash: await bcrypt.hash(input.password, 10) } : {}),
    },
    include: USER_INCLUDE,
  });
  return serializeUser(row);
}

export async function deleteUser(id: string, opts?: { actorId?: string }) {
  if (opts?.actorId && opts.actorId === id) {
    throw new AppError(409, 'CONFLICT', 'You cannot delete your own account');
  }
  const existing = await prisma.adminUser.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `User ${id} not found`);
  const remaining = await prisma.adminUser.count();
  if (remaining <= 1) {
    throw new AppError(409, 'CONFLICT', 'Cannot delete the last operator account');
  }
  await prisma.adminUser.delete({ where: { id } });
  return { id };
}

// Replace-all facility access for an operator. entries: [{ branchId }] for
// facility scope, or [{ scope: 'ALL' }] (branchId null) for every facility.
// Empty array = unscoped (legacy full access).
export async function setFacilityAccess(
  adminUserId: string,
  entries: Array<{ branchId?: string | null; scope?: string }>,
) {
  const user = await prisma.adminUser.findUnique({ where: { id: adminUserId } });
  if (!user) throw new AppError(404, 'NOT_FOUND', `User ${adminUserId} not found`);
  const normalized = entries.map((e) => ({
    branchId: e.scope === 'ALL' ? null : (e.branchId ?? null),
    scope: e.scope === 'ALL' ? 'ALL' : 'FACILITY',
  }));
  // Code-level dedupe (Postgres NULLs defeat the @@unique backstop for ALL).
  const seen = new Set<string>();
  for (const n of normalized) {
    const k = `${n.scope}:${n.branchId ?? ''}`;
    if (seen.has(k)) throw new AppError(400, 'VALIDATION', 'Duplicate facility access entry.');
    seen.add(k);
    if (n.branchId) {
      const b = await prisma.branch.findUnique({ where: { id: n.branchId } });
      if (!b) throw new AppError(400, 'VALIDATION', `Branch ${n.branchId} not found`);
    }
  }
  await prisma.$transaction([
    prisma.operatorFacilityAccess.deleteMany({ where: { adminUserId } }),
    ...(normalized.length
      ? [
          prisma.operatorFacilityAccess.createMany({
            data: normalized.map((n) => ({ adminUserId, branchId: n.branchId, scope: n.scope })),
          }),
        ]
      : []),
  ]);
  const row = await prisma.adminUser.findUniqueOrThrow({
    where: { id: adminUserId },
    include: USER_INCLUDE,
  });
  return serializeUser(row);
}

// ---------- permissions ----------

export async function grantPermission(adminUserId: string, permission: string) {
  if (!isKnownPermission(permission)) {
    throw new AppError(400, 'VALIDATION', `Unknown permission "${permission}". Known: ${PERMISSIONS.join(', ')}.`);
  }
  const user = await prisma.adminUser.findUnique({ where: { id: adminUserId } });
  if (!user) throw new AppError(404, 'NOT_FOUND', `User ${adminUserId} not found`);
  await prisma.permission.upsert({
    where: { adminUserId_permission: { adminUserId, permission } },
    update: {},
    create: { adminUserId, permission },
  });
  return { adminUserId, permission };
}

export async function revokePermission(adminUserId: string, permission: string) {
  const user = await prisma.adminUser.findUnique({ where: { id: adminUserId } });
  if (!user) throw new AppError(404, 'NOT_FOUND', `User ${adminUserId} not found`);
  await prisma.permission.deleteMany({ where: { adminUserId, permission } });
  return { adminUserId, permission };
}

export async function hasPermission(adminUserId: string, permission: string): Promise<boolean> {
  const row = await prisma.permission.findUnique({
    where: { adminUserId_permission: { adminUserId, permission } },
  });
  return !!row;
}

// Gated enforcement with legacy fallback: operators WITHOUT any permission
// row keep full legacy behavior (true); operators WITH rows must hold the
// specific capability. Safe to call on write paths without breaking existing
// logins — enforcement is strictly opt-in via granted rows.
export async function mayAct(adminUserId: string | undefined, permission: string): Promise<boolean> {
  if (!adminUserId) return true;
  const count = await prisma.permission.count({ where: { adminUserId } });
  if (count === 0) return true;
  return hasPermission(adminUserId, permission);
}

export async function requirePermission(adminUserId: string | undefined, permission: string) {
  if (!(await mayAct(adminUserId, permission))) {
    throw new AppError(403, 'FORBIDDEN', `Requires permission "${permission}".`);
  }
}

// Facility scoping read helper for future consumers: branchIds the operator
// may act on, or null when unscoped (legacy full access).
export async function scopedBranchIds(adminUserId: string | undefined): Promise<string[] | null> {
  if (!adminUserId) return null;
  const rows = await prisma.operatorFacilityAccess.findMany({ where: { adminUserId } });
  if (!rows.length) return null;
  if (rows.some((r) => r.scope === 'ALL')) return null;
  return rows.map((r) => r.branchId).filter((b): b is string => !!b);
}

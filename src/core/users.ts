// CMS operators, roles and permissions (CMS RBAC, 2026-10-27).
//
// Model:
//   - AdminUser.roleId → AdminRole. A role holds `<resource>:<action>` keys
//     from src/lib/permissions.ts. OWNER is a locked system role: it holds every
//     permission and is the only role allowed to manage users and roles.
//   - OperatorFacilityAccess rows scope an operator to facilities (branchId
//     set) or everything (scope ALL / no rows). Access = role × facilities.
//   - Enforcement is deny-by-default: requireAuth loads the operator's
//     principal on every request (so role changes apply immediately) and the
//     route table in src/lib/routePermissions.ts checks it.
//   - Every role / user / facility-scope change writes a PermissionAudit row.
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import {
  ALL_PERMISSIONS,
  OWNER_ROLE_KEY,
  RESOURCES,
  SYSTEM_ROLES,
  isKnownPermission,
} from '../lib/permissions';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

// ---------- principal (who is calling, what they may do) ----------

export interface Principal {
  id: string;
  email: string;
  name: string;
  role: { id: string; key: string; name: string };
  isOwner: boolean;
  permissions: string[];
  /** Branch ids the operator is limited to, or null for every facility. */
  branchIds: string[] | null;
  passwordChangedAt: Date;
}

export interface Actor {
  id?: string;
  email?: string;
}

export async function loadPrincipal(adminUserId: string): Promise<Principal | null> {
  const u = await prisma.adminUser.findUnique({
    where: { id: adminUserId },
    include: { role: { include: { permissions: true } }, facilityAccess: true },
  });
  if (!u) return null;
  const isOwner = u.role.key === OWNER_ROLE_KEY;
  const scoped = u.facilityAccess.length > 0 && !u.facilityAccess.some((a) => a.scope === 'ALL');
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: { id: u.role.id, key: u.role.key, name: u.role.name },
    isOwner,
    permissions: isOwner ? [...ALL_PERMISSIONS] : u.role.permissions.map((p) => p.permission).filter(isKnownPermission),
    branchIds: scoped ? u.facilityAccess.map((a) => a.branchId).filter((b): b is string => !!b) : null,
    passwordChangedAt: u.passwordChangedAt,
  };
}

export function can(p: Principal, permission: string): boolean {
  return p.isOwner || p.permissions.includes(permission);
}

/** Core-layer gate for actions decided below the route (e.g. a status
 * transition that only some edges require approval for). */
export async function requirePermission(adminUserId: string | undefined, permission: string): Promise<void> {
  const p = adminUserId ? await loadPrincipal(adminUserId) : null;
  if (!p || !can(p, permission)) {
    throw new AppError(403, 'FORBIDDEN', `You don't have permission to do this (${permission}).`);
  }
}

/** Branch ids the operator may act on, or null when unscoped. */
export async function scopedBranchIds(adminUserId: string | undefined): Promise<string[] | null> {
  if (!adminUserId) return null;
  return (await loadPrincipal(adminUserId))?.branchIds ?? null;
}

// ---------- audit ----------

async function audit(
  tx: Prisma.TransactionClient | typeof prisma,
  actor: Actor | undefined,
  action: string,
  targetType: 'ROLE' | 'USER',
  targetId: string,
  before: unknown,
  after: unknown,
) {
  await tx.permissionAudit.create({
    data: {
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      action,
      targetType,
      targetId,
      before: before == null ? Prisma.JsonNull : (before as Prisma.InputJsonValue),
      after: after == null ? Prisma.JsonNull : (after as Prisma.InputJsonValue),
    },
  });
}

export async function listAudit(limit = 100) {
  return prisma.permissionAudit.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(limit, 1), 500) });
}

// ---------- sign-in ----------

let dummyHash: string | undefined;

/** Verifies credentials with lockout. Unknown email and wrong password give
 * the same 401; a locked account gets 423 with the remaining minutes. */
export async function authenticate(emailInput: string, password: string) {
  const email = emailInput.trim().toLowerCase();
  const user = await prisma.adminUser.findUnique({ where: { email }, include: { role: true } });
  const now = new Date();
  if (!user) {
    // Same cost as a real check so timing does not reveal unknown emails.
    dummyHash ??= await bcrypt.hash('storelah-timing-pad', 10);
    await bcrypt.compare(password, dummyHash);
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password');
  }
  if (user.lockedUntil && user.lockedUntil > now) {
    const mins = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60000);
    throw new AppError(423, 'LOCKED', `Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    const failures = user.failedLoginCount + 1;
    const lock = failures >= MAX_FAILED_LOGINS;
    await prisma.adminUser.update({
      where: { id: user.id },
      data: lock
        ? { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MINUTES * 60000) }
        : { failedLoginCount: failures },
    });
    if (lock) {
      throw new AppError(423, 'LOCKED', `Too many failed sign-in attempts. Try again in ${LOCKOUT_MINUTES} minutes.`);
    }
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password');
  }
  if (user.failedLoginCount || user.lockedUntil) {
    await prisma.adminUser.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
  }
  return user;
}

export async function changeOwnPassword(adminUserId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.adminUser.findUnique({ where: { id: adminUserId } });
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new AppError(400, 'VALIDATION', 'Current password is incorrect');
  }
  if (currentPassword === newPassword) {
    throw new AppError(400, 'VALIDATION', 'New password must be different from the current one');
  }
  return prisma.adminUser.update({
    where: { id: adminUserId },
    // Older tokens are rejected from now on (see requireAuth).
    data: { passwordHash: await bcrypt.hash(newPassword, 10), passwordChangedAt: new Date() },
  });
}

// ---------- roles ----------

const ROLE_INCLUDE = { permissions: true, _count: { select: { users: true } } } as const;

function serializeRole(r: {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
  permissions: Array<{ permission: string }>;
  _count: { users: number };
}) {
  const isOwner = r.key === OWNER_ROLE_KEY;
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    locked: r.isSystem,
    isOwner,
    permissions: isOwner ? [...ALL_PERMISSIONS] : r.permissions.map((p) => p.permission).filter(isKnownPermission).sort(),
    userCount: r._count.users,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function roleCatalog() {
  return { resources: RESOURCES, permissions: ALL_PERMISSIONS };
}

export async function listRoles() {
  const rows = await prisma.adminRole.findMany({ include: ROLE_INCLUDE, orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }] });
  return rows.map(serializeRole);
}

function validatePermissions(permissions: string[]): string[] {
  const unknown = permissions.filter((p) => !isKnownPermission(p));
  if (unknown.length) throw new AppError(400, 'VALIDATION', `Unknown permission(s): ${unknown.join(', ')}`);
  // Any write/approve implies view of the same screen.
  const set = new Set(permissions);
  for (const p of permissions) set.add(`${p.split(':')[0]}:view`);
  return [...set].filter(isKnownPermission).sort();
}

function slugKey(name: string): string {
  const base = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return base || 'ROLE';
}

export async function createRole(input: { name: string; description?: string | null; permissions: string[] }, actor?: Actor) {
  const permissions = validatePermissions(input.permissions);
  let key = slugKey(input.name);
  if (key === OWNER_ROLE_KEY) key = 'OWNER_CUSTOM';
  for (let i = 2; await prisma.adminRole.findUnique({ where: { key } }); i++) key = `${slugKey(input.name)}_${i}`;
  const nameClash = await prisma.adminRole.findFirst({ where: { name: { equals: input.name.trim(), mode: 'insensitive' } } });
  if (nameClash) throw new AppError(409, 'CONFLICT', `A role named "${input.name.trim()}" already exists`);
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.adminRole.create({
      data: {
        key,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        permissions: { create: permissions.map((permission) => ({ permission })) },
      },
      include: ROLE_INCLUDE,
    });
    await audit(tx, actor, 'ROLE_CREATE', 'ROLE', r.id, null, { name: r.name, permissions });
    return r;
  });
  return serializeRole(row);
}

export async function updateRole(
  id: string,
  input: { name?: string; description?: string | null; permissions?: string[] },
  actor?: Actor,
) {
  const existing = await prisma.adminRole.findUnique({ where: { id }, include: ROLE_INCLUDE });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Role ${id} not found`);
  if (existing.isSystem) throw new AppError(409, 'CONFLICT', `The ${existing.name} role cannot be edited`);
  if (input.name !== undefined) {
    const clash = await prisma.adminRole.findFirst({
      where: { id: { not: id }, name: { equals: input.name.trim(), mode: 'insensitive' } },
    });
    if (clash) throw new AppError(409, 'CONFLICT', `A role named "${input.name.trim()}" already exists`);
  }
  const permissions = input.permissions !== undefined ? validatePermissions(input.permissions) : undefined;
  const before = serializeRole(existing);
  const row = await prisma.$transaction(async (tx) => {
    if (permissions) {
      await tx.adminRolePermission.deleteMany({ where: { roleId: id } });
      if (permissions.length) {
        await tx.adminRolePermission.createMany({ data: permissions.map((permission) => ({ roleId: id, permission })) });
      }
    }
    const r = await tx.adminRole.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
        // Touch updatedAt even when only permissions changed.
        updatedAt: new Date(),
      },
      include: ROLE_INCLUDE,
    });
    await audit(
      tx,
      actor,
      'ROLE_UPDATE',
      'ROLE',
      id,
      { name: before.name, description: before.description, permissions: before.permissions },
      { name: r.name, description: r.description, permissions: permissions ?? before.permissions },
    );
    return r;
  });
  return serializeRole(row);
}

export async function deleteRole(id: string, actor?: Actor) {
  const existing = await prisma.adminRole.findUnique({ where: { id }, include: ROLE_INCLUDE });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Role ${id} not found`);
  if (existing.isSystem) throw new AppError(409, 'CONFLICT', `The ${existing.name} role cannot be deleted`);
  if (existing._count.users > 0) {
    throw new AppError(409, 'CONFLICT', `Move the ${existing._count.users} user(s) on this role to another role first`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.adminRole.delete({ where: { id } });
    await audit(tx, actor, 'ROLE_DELETE', 'ROLE', id, serializeRole(existing), null);
  });
  return { id };
}

/** Idempotent: creates any missing seeded role; keeps Owner at every
 * permission. Never overwrites an existing editable role's matrix. Used by
 * the seed script and tests (the migration seeds prod). */
export async function ensureSystemRoles() {
  for (const r of SYSTEM_ROLES) {
    const existing = await prisma.adminRole.findUnique({ where: { key: r.key } });
    if (!existing) {
      await prisma.adminRole.create({
        data: {
          id: `role_${r.key.toLowerCase()}`,
          key: r.key,
          name: r.name,
          description: r.description,
          isSystem: r.locked,
          permissions: { create: r.permissions.map((permission) => ({ permission })) },
        },
      });
    } else if (r.key === OWNER_ROLE_KEY) {
      await prisma.adminRolePermission.deleteMany({ where: { roleId: existing.id } });
      await prisma.adminRolePermission.createMany({
        data: ALL_PERMISSIONS.map((permission) => ({ roleId: existing.id, permission })),
      });
    }
  }
}

export async function roleIdByKey(key: string): Promise<string> {
  const r = await prisma.adminRole.findUnique({ where: { key } });
  if (!r) throw new AppError(400, 'VALIDATION', `Role ${key} not found`);
  return r.id;
}

// ---------- users ----------

const USER_INCLUDE = {
  role: true,
  facilityAccess: { include: { branch: { select: { code: true, name: true } } } },
} as const;

type UserRow = Prisma.AdminUserGetPayload<{ include: typeof USER_INCLUDE }>;

function serializeUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    // Never serialize passwordHash.
    role: { id: u.role.id, key: u.role.key, name: u.role.name },
    isOwner: u.role.key === OWNER_ROLE_KEY,
    facilityAccess: u.facilityAccess.map((a) => ({
      id: a.id,
      branchId: a.branchId,
      branchCode: a.branch?.code ?? null,
      branchName: a.branch?.name ?? null,
      scope: a.scope,
    })),
    scoped: u.facilityAccess.length > 0 && !u.facilityAccess.some((a) => a.scope === 'ALL'),
    lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil : null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export async function listUsers() {
  const rows = await prisma.adminUser.findMany({ include: USER_INCLUDE, orderBy: { email: 'asc' } });
  return rows.map(serializeUser);
}

export async function getUser(id: string) {
  const row = await prisma.adminUser.findUnique({ where: { id }, include: USER_INCLUDE });
  if (!row) throw new AppError(404, 'NOT_FOUND', `User ${id} not found`);
  return serializeUser(row);
}

async function assertRole(roleId: string) {
  const r = await prisma.adminRole.findUnique({ where: { id: roleId } });
  if (!r) throw new AppError(400, 'VALIDATION', `Role ${roleId} not found`);
  return r;
}

async function ownerCount(tx: Prisma.TransactionClient | typeof prisma = prisma) {
  return tx.adminUser.count({ where: { role: { key: OWNER_ROLE_KEY } } });
}

export async function createUser(input: { email: string; name: string; password: string; roleId: string }, actor?: Actor) {
  const email = input.email.trim().toLowerCase();
  const clash = await prisma.adminUser.findUnique({ where: { email } });
  if (clash) throw new AppError(409, 'CONFLICT', `A user with ${email} already exists`);
  await assertRole(input.roleId);
  const row = await prisma.$transaction(async (tx) => {
    const u = await tx.adminUser.create({
      data: { email, name: input.name.trim(), passwordHash: await bcrypt.hash(input.password, 10), roleId: input.roleId },
      include: USER_INCLUDE,
    });
    await audit(tx, actor, 'USER_CREATE', 'USER', u.id, null, { email, name: u.name, role: u.role.key });
    return u;
  });
  return serializeUser(row);
}

export async function updateUser(
  id: string,
  input: { name?: string; roleId?: string; password?: string; unlock?: boolean },
  actor?: Actor,
) {
  const existing = await prisma.adminUser.findUnique({ where: { id }, include: USER_INCLUDE });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `User ${id} not found`);
  const roleChange = input.roleId !== undefined && input.roleId !== existing.roleId;
  if (roleChange) {
    if (actor?.id === id) throw new AppError(409, 'CONFLICT', 'You cannot change your own role');
    const next = await assertRole(input.roleId as string);
    if (existing.role.key === OWNER_ROLE_KEY && next.key !== OWNER_ROLE_KEY && (await ownerCount()) <= 1) {
      throw new AppError(409, 'CONFLICT', 'There must be at least one Owner');
    }
  }
  const row = await prisma.$transaction(async (tx) => {
    const u = await tx.adminUser.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(roleChange ? { roleId: input.roleId } : {}),
        // An Owner-set password signs the user out everywhere and clears a lockout.
        ...(input.password !== undefined
          ? { passwordHash: await bcrypt.hash(input.password, 10), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null }
          : {}),
        ...(input.unlock ? { failedLoginCount: 0, lockedUntil: null } : {}),
      },
      include: USER_INCLUDE,
    });
    if (roleChange || input.name !== undefined || input.password !== undefined || input.unlock) {
      await audit(
        tx,
        actor,
        'USER_UPDATE',
        'USER',
        id,
        { name: existing.name, role: existing.role.key },
        {
          name: u.name,
          role: u.role.key,
          ...(input.password !== undefined ? { passwordReset: true } : {}),
          ...(input.unlock ? { unlocked: true } : {}),
        },
      );
    }
    return u;
  });
  return serializeUser(row);
}

export async function deleteUser(id: string, actor?: Actor) {
  if (actor?.id && actor.id === id) {
    throw new AppError(409, 'CONFLICT', 'You cannot delete your own account');
  }
  const existing = await prisma.adminUser.findUnique({ where: { id }, include: USER_INCLUDE });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `User ${id} not found`);
  if (existing.role.key === OWNER_ROLE_KEY && (await ownerCount()) <= 1) {
    throw new AppError(409, 'CONFLICT', 'There must be at least one Owner');
  }
  await prisma.$transaction(async (tx) => {
    await tx.adminUser.delete({ where: { id } });
    await audit(tx, actor, 'USER_DELETE', 'USER', id, { email: existing.email, name: existing.name, role: existing.role.key }, null);
  });
  return { id };
}

// Replace-all facility access for an operator. entries: [{ branchId }] for
// facility scope, or [{ scope: 'ALL' }] (branchId null) for every facility.
// Empty array = unscoped (every facility).
export async function setFacilityAccess(
  adminUserId: string,
  entries: Array<{ branchId?: string | null; scope?: string }>,
  actor?: Actor,
) {
  const user = await prisma.adminUser.findUnique({ where: { id: adminUserId }, include: USER_INCLUDE });
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
  const before = serializeUser(user).facilityAccess.map((a) => (a.scope === 'ALL' ? 'ALL' : a.branchCode));
  await prisma.$transaction(async (tx) => {
    await tx.operatorFacilityAccess.deleteMany({ where: { adminUserId } });
    if (normalized.length) {
      await tx.operatorFacilityAccess.createMany({
        data: normalized.map((n) => ({ adminUserId, branchId: n.branchId, scope: n.scope })),
      });
    }
    const after = await tx.operatorFacilityAccess.findMany({ where: { adminUserId }, include: { branch: { select: { code: true } } } });
    await audit(tx, actor, 'USER_ACCESS', 'USER', adminUserId, { facilities: before }, {
      facilities: after.map((a) => (a.scope === 'ALL' ? 'ALL' : a.branch?.code ?? a.branchId)),
    });
  });
  return getUser(adminUserId);
}

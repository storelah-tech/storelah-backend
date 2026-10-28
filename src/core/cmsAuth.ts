// CMS operator invites + password resets (2026-10-28).
//
// One-time links: a random 32-byte token goes in the emailed link
// (`<cms>/admin?auth=<token>`); only its SHA-256 is stored (AdminAuthToken).
// A token is single use, expires (invite 72 h, reset 1 h) and is superseded
// when a newer one of the same kind is issued. Redeeming one sets the
// password, activates an invited operator, clears any lockout and signs out
// every other session (passwordChangedAt bump).
//
// Emails never block the action: when one cannot be sent (SES down, not
// configured locally), Owner-triggered flows return the link so the Owner can
// pass it on. The self-service forgot-password flow never reveals whether an
// account exists and never returns the link.
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { audit, getUser, type Actor } from './users';
import { buildInviteEmail, buildPasswordChangedEmail, buildResetEmail, sendAuthEmail } from './authEmails';

export const INVITE_HOURS = 72;
export const RESET_HOURS = 1;
const RESETS_PER_HOUR = 3;

type Kind = 'INVITE' | 'RESET';

export interface LinkResult {
  sent: boolean;
  /** Only when the email could not be sent (Owner flows) — hand it over another way. */
  link?: string;
  expiresAt: Date;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function authLink(baseUrl: string, raw: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/admin?auth=${encodeURIComponent(raw)}`;
}

async function issueToken(adminUserId: string, kind: Kind, createdById: string | null) {
  const raw = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (kind === 'INVITE' ? INVITE_HOURS : RESET_HOURS) * 3600_000);
  await prisma.$transaction([
    // Supersede any older unused link of the same kind.
    prisma.adminAuthToken.updateMany({ where: { adminUserId, kind, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.adminAuthToken.create({ data: { adminUserId, kind, tokenHash: hashToken(raw), expiresAt, createdById } }),
  ]);
  return { raw, expiresAt };
}

async function inviterName(actor?: Actor): Promise<string> {
  if (!actor?.id) return 'Your Owner';
  const u = await prisma.adminUser.findUnique({ where: { id: actor.id }, select: { name: true } });
  return u?.name || 'Your Owner';
}

/** Emails a (new) invite link to an operator who has not set a password yet. */
export async function sendInvite(adminUserId: string, actor: Actor | undefined, baseUrl: string): Promise<LinkResult> {
  const u = await prisma.adminUser.findUnique({ where: { id: adminUserId }, include: { role: true } });
  if (!u) throw new AppError(404, 'NOT_FOUND', `User ${adminUserId} not found`);
  if (u.activatedAt) throw new AppError(409, 'CONFLICT', `${u.email} has already set a password. Send a reset link instead.`);
  const { raw, expiresAt } = await issueToken(u.id, 'INVITE', actor?.id ?? null);
  const url = authLink(baseUrl, raw);
  const res = await sendAuthEmail(
    u.email,
    buildInviteEmail({ name: u.name, inviterName: await inviterName(actor), roleName: u.role.name, url, expiresHours: INVITE_HOURS }),
    'invite',
  );
  await prisma.adminUser.update({ where: { id: u.id }, data: { invitedAt: new Date() } });
  await audit(prisma, actor, 'USER_INVITE', 'USER', u.id, null, { email: u.email, emailed: res.sent });
  return { sent: res.sent, expiresAt, ...(res.sent ? {} : { link: url }) };
}

/** Owner-triggered: email a reset link to an active operator. */
export async function sendResetLink(adminUserId: string, actor: Actor | undefined, baseUrl: string): Promise<LinkResult> {
  const u = await prisma.adminUser.findUnique({ where: { id: adminUserId } });
  if (!u) throw new AppError(404, 'NOT_FOUND', `User ${adminUserId} not found`);
  if (!u.activatedAt) throw new AppError(409, 'CONFLICT', `${u.email} has not accepted their invite yet. Resend the invite instead.`);
  const { raw, expiresAt } = await issueToken(u.id, 'RESET', actor?.id ?? null);
  const url = authLink(baseUrl, raw);
  const res = await sendAuthEmail(u.email, buildResetEmail({ name: u.name, url, expiresHours: RESET_HOURS, byOwner: true }), 'reset (owner)');
  await audit(prisma, actor, 'USER_RESET_LINK', 'USER', u.id, null, { email: u.email, emailed: res.sent });
  return { sent: res.sent, expiresAt, ...(res.sent ? {} : { link: url }) };
}

/** Self-service forgot password. Silent about whether the email exists. */
export async function requestPasswordReset(emailInput: string, baseUrl: string): Promise<void> {
  const email = emailInput.trim().toLowerCase();
  const u = await prisma.adminUser.findUnique({ where: { email } });
  if (!u || !u.activatedAt) return;
  const recent = await prisma.adminAuthToken.count({
    where: { adminUserId: u.id, kind: 'RESET', createdAt: { gt: new Date(Date.now() - 3600_000) } },
  });
  if (recent >= RESETS_PER_HOUR) return; // throttled quietly
  const { raw } = await issueToken(u.id, 'RESET', null);
  await sendAuthEmail(u.email, buildResetEmail({ name: u.name, url: authLink(baseUrl, raw), expiresHours: RESET_HOURS, byOwner: false }), 'reset (self)');
}

async function liveToken(raw: string) {
  const t = raw ? await prisma.adminAuthToken.findUnique({ where: { tokenHash: hashToken(raw) }, include: { adminUser: true } }) : null;
  if (!t || t.usedAt || t.expiresAt <= new Date()) {
    throw new AppError(400, 'LINK_INVALID', 'This link has expired or was already used. Ask for a new one.');
  }
  return t;
}

/** What the set-password screen shows for a link (no side effects). */
export async function inspectToken(raw: string) {
  const t = await liveToken(raw);
  return { kind: t.kind as Kind, email: t.adminUser.email, name: t.adminUser.name, expiresAt: t.expiresAt };
}

/** Sets the password from a link. Returns the operator so the route can sign them in. */
export async function redeemToken(raw: string, password: string) {
  const t = await liveToken(raw);
  const now = new Date();
  const user = await prisma.$transaction(async (tx) => {
    // Claim the token first; a concurrent redeem finds usedAt set and fails.
    const claimed = await tx.adminAuthToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: now } });
    if (claimed.count !== 1) throw new AppError(400, 'LINK_INVALID', 'This link has expired or was already used. Ask for a new one.');
    await tx.adminAuthToken.updateMany({ where: { adminUserId: t.adminUserId, usedAt: null }, data: { usedAt: now } });
    const u = await tx.adminUser.update({
      where: { id: t.adminUserId },
      data: {
        passwordHash: await bcrypt.hash(password, 10),
        passwordChangedAt: now,
        activatedAt: t.adminUser.activatedAt ?? now,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    await audit(tx, { id: u.id, email: u.email }, t.kind === 'INVITE' ? 'INVITE_ACCEPTED' : 'PASSWORD_RESET', 'USER', u.id, null, null);
    return u;
  });
  if (t.kind === 'RESET') {
    sendAuthEmail(user.email, buildPasswordChangedEmail({ name: user.name, when: now, byOwner: false }), 'password-changed').catch(() => {});
  }
  return user;
}

/** Ends every session of an operator (their next request must sign in again). */
export async function signOutEverywhere(adminUserId: string, actor: Actor | undefined) {
  const u = await prisma.adminUser.findUnique({ where: { id: adminUserId } });
  if (!u) throw new AppError(404, 'NOT_FOUND', `User ${adminUserId} not found`);
  await prisma.adminUser.update({ where: { id: adminUserId }, data: { passwordChangedAt: new Date() } });
  await audit(prisma, actor, 'USER_SIGN_OUT', 'USER', adminUserId, null, { email: u.email });
  return getUser(adminUserId);
}

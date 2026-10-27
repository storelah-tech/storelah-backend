import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AppError, fail } from '../lib/http';
import { loadPrincipal, type Principal } from '../core/users';
import { runScoped } from '../lib/facilityScope';

export interface AdminJwt {
  sub: string;
  email: string;
  name: string;
  /** passwordChangedAt (epoch ms) when the token was issued. */
  pwv?: number;
  kind?: string;
}

export interface CustomerJwtPayload {
  kind: 'customer';
  sub: string;
  email: string;
  name: string;
}

export const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export function signToken(user: { id: string; email: string; name: string; passwordChangedAt?: Date }): string {
  const claims = { sub: user.id, email: user.email, name: user.name, pwv: user.passwordChangedAt?.getTime() };
  return jwt.sign(claims, SECRET, {
    expiresIn: (process.env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '12h',
  });
}

export function signCustomerToken(user: { id: string; email: string; name: string }): string {
  return jwt.sign(
    { kind: 'customer', sub: user.id, email: user.email, name: user.name },
    SECRET,
    { expiresIn: (process.env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '12h' },
  );
}

/**
 * CMS operator auth. Verifies the Bearer JWT, then loads the operator's
 * principal (role, permissions, facility scope) from the DB on EVERY request,
 * so a role change or deletion applies on the next call. A token whose
 * password version (pwv) no longer matches the operator's passwordChangedAt
 * is rejected, so a password change signs out every other session. Sets
 * req.user (JWT claims, unchanged shape) and req.admin, and runs the rest
 * of the request inside the operator's facility scope (lib/facilityScope.ts).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    fail(res, 401, 'UNAUTHORIZED', 'Sign in to continue');
    return;
  }
  let payload: AdminJwt;
  try {
    payload = jwt.verify(header.slice(7), SECRET) as AdminJwt;
  } catch {
    fail(res, 401, 'UNAUTHORIZED', 'Your session has expired. Sign in again.');
    return;
  }
  // Customer tokens share the secret — never accept them as operators.
  if (payload.kind === 'customer' || !payload.sub) {
    fail(res, 401, 'UNAUTHORIZED', 'Sign in to continue');
    return;
  }
  const principal = await loadPrincipal(payload.sub);
  if (!principal) {
    fail(res, 401, 'UNAUTHORIZED', 'Sign in to continue');
    return;
  }
  if (payload.pwv !== principal.passwordChangedAt.getTime()) {
    fail(res, 401, 'UNAUTHORIZED', 'Your session has ended. Sign in again.');
    return;
  }
  (req as any).user = { sub: principal.id, email: principal.email, name: principal.name };
  (req as any).admin = principal;
  // The rest of the request only sees the operator's facilities.
  runScoped(principal.branchIds, next);
}

export function adminOf(req: Request): Principal | undefined {
  return (req as any).admin;
}

export function requireCustomerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    fail(res, 401, 'UNAUTHORIZED', 'Unauthorized');
    return;
  }
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, SECRET) as CustomerJwtPayload;
    if (payload.kind !== 'customer' || !payload.sub) {
      fail(res, 401, 'UNAUTHORIZED', 'Unauthorized');
      return;
    }
    (req as any).customer = payload;
    next();
  } catch {
    fail(res, 401, 'UNAUTHORIZED', 'Unauthorized');
  }
}

/**
 * Returns the verified customer payload for a VALID bearer token. Throws
 * 401 UNAUTHORIZED (stable code string) when NO header is supplied or when
 * the header is present but malformed/expired/invalid — it never leaks into
 * the global handler as a 500, and a verified payload is the ONLY way to be
 * treated as authenticated.
 *
 * STALE-TOKEN POLICY (prod fix): dual-mode checkout routes
 * (POST /customer/bookings, POST /customer/checkout/sessions) catch this
 * throw, and — only when the request ALSO carries valid guest email-proof —
 * retry the call as guest (caller=null). Without guest proof the 401 stands.
 * Stale sessions are therefore never silently upgraded to AUTHED, but they
 * no longer hard-block a guest payer holding proof.
 */
export function extractCustomerPayload(req: Request): CustomerJwtPayload {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
  }
  let payload: CustomerJwtPayload;
  try {
    payload = jwt.verify(header.slice(7), SECRET) as CustomerJwtPayload;
  } catch {
    // Malformed/expired/garbage token must surface as 401 UNAUTHORIZED,
    // never leak into the global handler as a 500.
    throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
  }
  if (payload.kind !== 'customer' || !payload.sub) {
    throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
  }
  return payload;
}

/**
 * True only when an Authorization header carrying a Bearer token is present.
 * Non-Bearer garbage (e.g. a stale/misconfigured client default) is treated
 * as ABSENT so dual-mode routes (POST /customer/bookings, checkout sessions)
 * fall through to guest handling instead of 401ing. A present Bearer token is
 * still verified strictly — extractCustomerPayload / requireCustomerAuth below
 * hard-401 on verify-fail/kind-mismatch and never downgrade to guest.
 */
export function hasAuthorizationHeader(req: Request): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && /^Bearer\s+\S+/.test(header);
}
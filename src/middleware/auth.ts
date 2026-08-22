import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AppError, fail } from '../lib/http';

export interface AdminJwt {
  sub: string;
  email: string;
  name: string;
}

export interface CustomerJwtPayload {
  kind: 'customer';
  sub: string;
  email: string;
  name: string;
}

export const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export function signToken(user: { id: string; email: string; name: string }): string {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, SECRET, {
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

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, SECRET) as AdminJwt;
    (req as any).user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
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
 * Returns the verified customer payload when a VALID bearer token is present,
 * null when NO Authorization header is supplied. A header that is present but
 * malformed/expired/invalid throws — callers must treat that as a hard 401 so
 * stale sessions are never silently downgraded to guest checkout.
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

export function hasAuthorizationHeader(req: Request): boolean {
  return !!req.headers.authorization;
}
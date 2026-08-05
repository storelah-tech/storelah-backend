import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { fail } from '../lib/http';

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
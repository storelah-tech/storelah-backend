import { NextFunction, Request, Response } from 'express';

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function ok(res: Response, data: unknown, meta?: Record<string, unknown>): void {
  res.json({ data, meta });
}

export function created(res: Response, data: unknown): void {
  res.status(201).json({ data });
}

export function fail(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({ error: { code, message, details } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  console.error('[storelah] unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL', message } });
}
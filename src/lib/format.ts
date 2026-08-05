import { Prisma } from '@prisma/client';

export function toNum(v: Prisma.Decimal | number | null | undefined, digits = 2): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : v.toNumber();
  return Math.round(n * 10 ** digits) / 10 ** digits;
}

export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
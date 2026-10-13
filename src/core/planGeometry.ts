// StoreLah — floor-plan precision geometry (shared, PURE: no prisma/express/IO).
//
// PRECISION MODEL ("feet at the edges, integers in the core"):
//   - Plan geometry is DECIMAL FEET everywhere it is stored or sent over the
//     API (Float columns, JSON numbers). Every value is quantized on write to
//     PLAN_PRECISION_FT (0.001 ft ≈ 0.3 mm), so a stored value is always the
//     nearest double to a 3-decimal foot value (4.73, 12.5, 30).
//   - Every COMPARISON or SUM (overlap, canvas fit, same-rect, touching edges)
//     runs on integer MILLI-FEET via toMilli(). Decimal feet are exact in that
//     base, so 1.1 + 2.2 meets 3.3 exactly (1100 + 2200 === 3300) — float
//     comparisons would report a phantom overlap there.
//   - Integer-foot plans are a subset: every pre-precision row is unchanged.
//
// This module is the single source of truth the CMS editor will bundle in
// Phase 2 (see docs/FLOOR_PLAN_PRECISION_PLAN.md) — keep it dependency-free.

/** Integer base units per foot (1 milli-foot = 0.001 ft). */
export const MILLI_PER_FOOT = 1000;
/** Storage precision of every plan coordinate/length, in feet. */
export const PLAN_PRECISION_FT = 1 / MILLI_PER_FOOT;
/** Smallest rect side (placement/block) accepted on write, in feet. */
export const MIN_RECT_SIDE_FT = 0.1;
/** Editor default snap step, in feet (operator decision 2026-10-13). */
export const DEFAULT_SNAP_FT = 0.1;

export type FtRect = { x: number; y: number; width: number; height: number };

/** Feet -> integer milli-feet. Exact for any value with <= 3 decimals. */
export function toMilli(ft: number): number {
  return Math.round(ft * MILLI_PER_FOOT);
}

/** Integer milli-feet -> feet (nearest double to the 3-decimal value). */
export function fromMilli(milli: number): number {
  return milli / MILLI_PER_FOOT;
}

/** Quantize a foot value to the storage precision. Idempotent. */
export function quantizeFt(ft: number): number {
  const q = fromMilli(toMilli(ft));
  return q === 0 ? 0 : q; // never persist -0
}

/** Quantize all four sides of a rect. */
export function quantizeRect<T extends FtRect>(r: T): T {
  return { ...r, x: quantizeFt(r.x), y: quantizeFt(r.y), width: quantizeFt(r.width), height: quantizeFt(r.height) };
}

/** True for a finite JS number (the only accepted shape for a plan length). */
export function isPlanNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Exact equality of two foot values at storage precision. */
export function ftEquals(a: number, b: number): boolean {
  return toMilli(a) === toMilli(b);
}

/** Exact same-rect test at storage precision (stacked locker pairs). */
export function sameRect(a: FtRect, b: FtRect): boolean {
  return ftEquals(a.x, b.x) && ftEquals(a.y, b.y) && ftEquals(a.width, b.width) && ftEquals(a.height, b.height);
}

/** True when two rects share interior area; touching edges never overlap. Integer-exact. */
export function rectsOverlapExact(a: FtRect, b: FtRect): boolean {
  const ax0 = toMilli(a.x);
  const ay0 = toMilli(a.y);
  const bx0 = toMilli(b.x);
  const by0 = toMilli(b.y);
  const ax1 = ax0 + toMilli(a.width);
  const ay1 = ay0 + toMilli(a.height);
  const bx1 = bx0 + toMilli(b.width);
  const by1 = by0 + toMilli(b.height);
  return ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1;
}

/** True when the rect lies inside a width×height canvas (edges inclusive). Integer-exact. */
export function rectFitsCanvas(r: FtRect, canvas: { width: number; height: number }): boolean {
  return (
    toMilli(r.x) >= 0 &&
    toMilli(r.y) >= 0 &&
    toMilli(r.x) + toMilli(r.width) <= toMilli(canvas.width) &&
    toMilli(r.y) + toMilli(r.height) <= toMilli(canvas.height)
  );
}

/** True when a point lies on the canvas, edges inclusive. Integer-exact. */
export function pointOnCanvas(x: number, y: number, canvas: { width: number; height: number }): boolean {
  const mx = toMilli(x);
  const my = toMilli(y);
  return mx >= 0 && my >= 0 && mx <= toMilli(canvas.width) && my <= toMilli(canvas.height);
}

/** Rect area in square feet, computed exactly in milli-feet then rounded to 0.0001 sqft. */
export function rectAreaSqft(r: { width: number; height: number }): number {
  const milli2 = toMilli(r.width) * toMilli(r.height); // <= 5e5 * 5e5 = 2.5e11, safe integer
  return Math.round(milli2 / 100) / 10000;
}

/** Display a foot value without float noise: 4.73 -> "4.73", 30 -> "30". */
export function formatFt(ft: number): string {
  return String(quantizeFt(ft));
}

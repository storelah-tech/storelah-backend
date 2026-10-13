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

// ---------- snapping ----------

/** Snap steps the editor offers, in feet (operator default DEFAULT_SNAP_FT). */
export const SNAP_STEPS_FT = [1, 0.5, 0.25, 0.1, 0.05, 0.01] as const;
/** Fine step used while the operator holds Alt during a drag. */
export const FINE_SNAP_FT = 0.01;

/** Round a foot value to the nearest multiple of `step` (integer-exact in milli-feet). */
export function snapFt(ft: number, step: number = DEFAULT_SNAP_FT): number {
  const s = Math.max(1, toMilli(step));
  return quantizeFt(fromMilli(Math.round(toMilli(ft) / s) * s));
}

/** Clamp then quantize: keeps lo <= v <= hi (hi wins when the range is empty). */
export function clampFt(v: number, lo: number, hi: number): number {
  return quantizeFt(Math.max(Math.min(v, hi), Math.min(lo, hi)));
}

// ---------- area tolerance + footprints ----------

/**
 * Max relative deviation between a placement's drawn area and its unit's
 * sqft for NEW or RESIZED placements (owner decision 2026-10-13: 2%).
 * Moves/rotations that keep the stored area are grandfathered.
 */
export const AREA_TOLERANCE = 0.02;

/** Relative deviation of a rect's area from `sqft` (0 = exact). */
export function areaDeviation(r: { width: number; height: number }, sqft: number): number {
  return Math.abs(rectAreaSqft(r) - sqft) / Math.max(1, sqft);
}

/**
 * Decimal-foot footprint for a unit of `sqft` square feet.
 *  - Explicit size dims (widthFt × heightFt) win when their area is within
 *    AREA_TOLERANCE of sqft.
 *  - Otherwise the rect keeps the dims' aspect (or `fallbackAspect`, w/h) and
 *    is scaled to the unit's exact sqft: w = sqrt(sqft·aspect) snapped to
 *    `step`, h = sqft / w at 0.001 ft — so w·h ≈ sqft within rounding.
 */
export function fitSqftFootprint(
  sqft: number,
  opts: { widthFt?: number | null; heightFt?: number | null; fallbackAspect?: number; step?: number } = {},
): { w: number; h: number } {
  const safe = Math.max(MIN_RECT_SIDE_FT * MIN_RECT_SIDE_FT, isPlanNumber(sqft) && sqft > 0 ? sqft : 1);
  const step = opts.step ?? DEFAULT_SNAP_FT;
  const dw = opts.widthFt;
  const dh = opts.heightFt;
  const hasDims = isPlanNumber(dw) && isPlanNumber(dh) && dw > 0 && dh > 0;
  if (hasDims && areaDeviation({ width: dw, height: dh }, safe) <= AREA_TOLERANCE) {
    return { w: quantizeFt(dw), h: quantizeFt(dh) };
  }
  const aspect = hasDims ? dw / dh : opts.fallbackAspect && opts.fallbackAspect > 0 ? opts.fallbackAspect : 3 / 4;
  const w = Math.max(MIN_RECT_SIDE_FT, snapFt(Math.sqrt(safe * aspect), step));
  const h = Math.max(MIN_RECT_SIDE_FT, quantizeFt(safe / w));
  return { w, h };
}

// ---------- line kinds (precision Phase 3) ----------

/**
 * Line kinds the editor authors (FloorPlanBoundary.kind stays a free string
 * for compatibility). Legacy 'PENCIL' rows are drawn boundary lines.
 *  - BOUNDARY  marks facility area → feeds UFA/NLA (marked-area rule)
 *  - WALL      drawn with `thickness` (ft); does NOT mark area
 *  - PARTITION thin internal divider; does NOT mark area
 *  - GUIDE     construction line — CMS-only, hidden from the public read
 */
export const LINE_KINDS = ['BOUNDARY', 'WALL', 'PARTITION', 'GUIDE'] as const;
export type LineKind = (typeof LINE_KINDS)[number];
const NON_AREA_LINE_KINDS = new Set(['WALL', 'PARTITION', 'GUIDE']);
/** Default wall thickness for new WALL lines, in feet (≈ 150 mm block wall). */
export const DEFAULT_WALL_THICKNESS_FT = 0.5;
/** Accepted wall thickness range, in feet. */
export const MIN_WALL_THICKNESS_FT = 0.05;
export const MAX_WALL_THICKNESS_FT = 10;

/** True when lines of this kind mark facility area (BOUNDARY, legacy PENCIL, unknown kinds). */
export function lineFeedsArea(kind: string | null | undefined): boolean {
  return !NON_AREA_LINE_KINDS.has(String(kind ?? '').toUpperCase());
}

/** True for CMS-only construction lines that must never reach the public read. */
export function isGuideLine(kind: string | null | undefined): boolean {
  return String(kind ?? '').toUpperCase() === 'GUIDE';
}

// ---------- segment helpers ----------

/** Euclidean length of a segment, in feet. */
export function segmentLengthFt(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Total polyline length (closed adds the closing segment), in feet. */
export function polylineLengthFt(points: ReadonlyArray<readonly [number, number]>, closed = false): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += segmentLengthFt(points[i - 1], points[i]);
  if (closed && points.length > 2) len += segmentLengthFt(points[points.length - 1], points[0]);
  return len;
}

/**
 * Plan angle of a→b in degrees, CAD convention: 0° = +x (east), 90° = north
 * (up the screen, i.e. −y), counter-clockwise positive, range [0, 360).
 */
export function angleDeg(a: readonly [number, number], b: readonly [number, number]): number {
  const deg = (Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Point at `length` ft from `a` along plan angle `deg` (inverse of angleDeg), quantized. */
export function pointAtAngle(a: readonly [number, number], length: number, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  return [quantizeFt(a[0] + length * Math.cos(r)), quantizeFt(a[1] - length * Math.sin(r))];
}

/** Nearest point to p on segment a–b, plus its distance (feet). */
export function nearestOnSegment(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): { x: number; y: number; dist: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  const t = lenSq ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq)) : 0;
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return { x, y, dist: Math.hypot(p[0] - x, p[1] - y) };
}

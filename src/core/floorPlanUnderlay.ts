// StoreLah — floor-plan tracing underlay (precision Phase 5).
//
// One CMS-only image per plan, shown under the editor canvas and calibrated
// onto plan feet:  canvasFt = (offsetX, offsetY) + rotate(rotation°) · (px · ftPerPx).
// Bytes live in Postgres (FloorPlanUnderlay.bytes), NOT the public content
// bucket: a facility layout must never be reachable without a CMS login. The
// image is served as JSON base64 through an authenticated route (no binary
// response config needed on API Gateway / Lambda). Never in the public read,
// never in draft snapshots. PDFs are rasterised client-side (pdf.js) before
// upload, so the server only ever stores PNG / JPEG / WebP.
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { ensureCanvasPlan } from './floorPlans';

export const UNDERLAY_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** Byte cap: base64 of 3.5 MiB ≈ 4.7 MB, inside the 6 MB Lambda payload limit both ways. */
export const UNDERLAY_MAX_BYTES = 3.5 * 1024 * 1024;
const MAX_PX = 20000;

export interface UnderlayUploadInput {
  name?: string | null;
  contentType: string;
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
}

export interface UnderlayPatch {
  name?: string | null;
  ftPerPx?: number;
  offsetX?: number;
  offsetY?: number;
  rotation?: number;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
}

type UnderlayRow = {
  id: string;
  name: string | null;
  mime: string;
  widthPx: number;
  heightPx: number;
  ftPerPx: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  updatedAt: Date;
  bytes?: Uint8Array;
};

/** Metadata only — the image itself is fetched separately. */
export function serializeUnderlay(u: UnderlayRow) {
  return {
    id: u.id,
    name: u.name,
    mime: u.mime,
    widthPx: u.widthPx,
    heightPx: u.heightPx,
    ftPerPx: u.ftPerPx,
    // Derived: the image's footprint on the plan, in feet.
    widthFt: Math.round(u.widthPx * u.ftPerPx * 1000) / 1000,
    heightFt: Math.round(u.heightPx * u.ftPerPx * 1000) / 1000,
    offsetX: u.offsetX,
    offsetY: u.offsetY,
    rotation: u.rotation,
    opacity: u.opacity,
    visible: u.visible,
    locked: u.locked,
    sizeBytes: u.bytes ? u.bytes.length : undefined,
    updatedAt: u.updatedAt,
  };
}

const META_SELECT = {
  id: true, name: true, mime: true, widthPx: true, heightPx: true, ftPerPx: true, offsetX: true, offsetY: true,
  rotation: true, opacity: true, visible: true, locked: true, updatedAt: true,
} as const;

// Magic-number sniff: the declared type must match the bytes.
function sniffMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function num(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new AppError(400, 'VALIDATION', `${name} must be a number between ${min} and ${max}`);
  }
  return v;
}

function checkName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const t = String(name).trim().slice(0, 120);
  return t || null;
}

async function planFor(floorId: string) {
  const plan = await prisma.floorPlan.findUnique({ where: { floorId }, select: { id: true } });
  if (!plan) throw new AppError(404, 'NOT_FOUND', `No floor plan exists for floor ${floorId}`);
  return plan;
}

/** Underlay metadata for a floor's plan, or null. */
export async function getUnderlay(floorId: string) {
  const plan = await prisma.floorPlan.findUnique({ where: { floorId }, select: { id: true } });
  if (!plan) return null;
  const u = await prisma.floorPlanUnderlay.findUnique({ where: { floorPlanId: plan.id }, select: META_SELECT });
  return u ? serializeUnderlay(u) : null;
}

/** The image as { mime, dataBase64 } (authenticated CMS route only). */
export async function getUnderlayImage(floorId: string) {
  const plan = await planFor(floorId);
  const u = await prisma.floorPlanUnderlay.findUnique({ where: { floorPlanId: plan.id }, select: { mime: true, bytes: true, updatedAt: true } });
  if (!u) throw new AppError(404, 'NOT_FOUND', `Floor ${floorId} has no underlay`);
  return { mime: u.mime, dataBase64: Buffer.from(u.bytes).toString('base64'), updatedAt: u.updatedAt };
}

/**
 * Upload / replace the underlay. A new image starts uncalibrated-but-sane:
 * scaled so its width spans the canvas width, at the canvas origin, 50% opacity.
 */
export async function setUnderlay(floorId: string, input: UnderlayUploadInput) {
  const mime = String(input.contentType || '').toLowerCase();
  if (!(UNDERLAY_MIME as readonly string[]).includes(mime)) {
    throw new AppError(400, 'VALIDATION', `Underlay must be ${UNDERLAY_MIME.join(', ')} (PDFs are converted in the browser) — got "${input.contentType}"`);
  }
  if (!input.bytes.length) throw new AppError(400, 'VALIDATION', 'Underlay image is empty');
  if (input.bytes.length > UNDERLAY_MAX_BYTES) {
    throw new AppError(400, 'VALIDATION', `Underlay image is ${input.bytes.length} bytes — the limit is ${UNDERLAY_MAX_BYTES} (the editor downsizes large drawings automatically)`);
  }
  if (sniffMime(input.bytes) !== mime) throw new AppError(400, 'VALIDATION', `Underlay bytes are not a valid ${mime} file`);
  const widthPx = num(input.widthPx, 'widthPx', 1, MAX_PX);
  const heightPx = num(input.heightPx, 'heightPx', 1, MAX_PX);
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx)) throw new AppError(400, 'VALIDATION', 'widthPx / heightPx must be whole pixels');
  const plan = await ensureCanvasPlan(floorId);
  // Copy into a plain ArrayBuffer-backed Uint8Array (Prisma's Bytes type).
  const bytes = new Uint8Array(input.bytes.length);
  bytes.set(input.bytes);
  const data = { name: checkName(input.name), mime, bytes, widthPx, heightPx, ftPerPx: plan.width / widthPx, offsetX: 0, offsetY: 0, rotation: 0, opacity: 0.5, visible: true, locked: false };
  const u = await prisma.floorPlanUnderlay.upsert({
    where: { floorPlanId: plan.id },
    create: { floorPlanId: plan.id, ...data },
    update: data,
    select: META_SELECT,
  });
  return serializeUnderlay(u);
}

/** Calibration / display settings. Omitted fields keep their values. */
export async function updateUnderlay(floorId: string, patch: UnderlayPatch) {
  const plan = await planFor(floorId);
  const existing = await prisma.floorPlanUnderlay.findUnique({ where: { floorPlanId: plan.id }, select: { id: true } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Floor ${floorId} has no underlay — upload one first`);
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = checkName(patch.name);
  if (patch.ftPerPx !== undefined) {
    const v = num(patch.ftPerPx, 'ftPerPx', 1e-6, 100);
    if (v <= 0) throw new AppError(400, 'VALIDATION', 'ftPerPx must be positive');
    data.ftPerPx = v;
  }
  if (patch.offsetX !== undefined) data.offsetX = num(patch.offsetX, 'offsetX', -5000, 5000);
  if (patch.offsetY !== undefined) data.offsetY = num(patch.offsetY, 'offsetY', -5000, 5000);
  if (patch.rotation !== undefined) data.rotation = ((num(patch.rotation, 'rotation', -3600, 3600) % 360) + 360) % 360;
  if (patch.opacity !== undefined) data.opacity = num(patch.opacity, 'opacity', 0.05, 1);
  if (patch.visible !== undefined) data.visible = !!patch.visible;
  if (patch.locked !== undefined) data.locked = !!patch.locked;
  const u = await prisma.floorPlanUnderlay.update({ where: { floorPlanId: plan.id }, data, select: META_SELECT });
  return serializeUnderlay(u);
}

export async function removeUnderlay(floorId: string) {
  const plan = await planFor(floorId);
  await prisma.floorPlanUnderlay.deleteMany({ where: { floorPlanId: plan.id } });
  return { removed: true };
}

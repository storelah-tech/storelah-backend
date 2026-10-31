// Site-builder media library (docs/SITE_BUILDER_PLAN.md §5 Phase 1/3).
//
// The CMS resizes in the browser and uploads up to three variants (≈600 /
// 1200 / 2400 px wide, usually webp), so Lambda never needs `sharp`. The
// server trusts nothing it is told: the type and pixel size of every variant
// are read from the bytes (PNG / JPEG / WebP headers), variants must ascend in
// width and share one aspect ratio, and each must fit the content-image size
// limit. Files go through the same storage as content images (S3 in prod,
// local disk in dev). Pages reference an asset by URL, so a delete is refused
// while any draft or live page still uses it.

import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { deleteContentImage, putContentImage } from '../lib/contentStorage';

const MAX_VARIANTS = 3;
const MAX_DIMENSION = 6000;
/** Variant used as the page `src` (the landing has no srcset yet). */
const DEFAULT_WIDTH = 1200;

export interface MediaVariant {
  width: number;
  height: number;
  bytes: number;
  url: string;
  key: string;
}

// ---------- byte sniffing ----------

type Sniffed = { mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number };

/** Reads the real format and pixel size from the file header (null = not an image we accept). */
export function sniffImage(b: Buffer): Sniffed | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') {
    return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return { mime: 'image/webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

// ---------- serialize ----------

type Row = Prisma.MediaAssetGetPayload<object>;

function serialize(r: Row) {
  const variants = r.variants as unknown as MediaVariant[];
  return {
    id: r.id,
    filename: r.filename,
    url: r.url,
    variants: variants.map(({ width, height, bytes, url }) => ({ width, height, bytes, url })),
    width: r.width,
    height: r.height,
    alt: r.alt,
    tags: r.tags,
    createdById: r.createdById,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---------- reads ----------

export const listMediaQuery = z.object({
  q: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(40).optional(),
});

export async function listMedia(query: z.infer<typeof listMediaQuery>) {
  const rows = await prisma.mediaAsset.findMany({
    where: {
      ...(query.tag ? { tags: { has: query.tag.toLowerCase() } } : {}),
      ...(query.q
        ? { OR: [{ alt: { contains: query.q, mode: 'insensitive' } }, { filename: { contains: query.q, mode: 'insensitive' } }] }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return rows.map(serialize);
}

async function findAsset(id: string): Promise<Row> {
  const r = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Image not found');
  return r;
}

// ---------- writes ----------

const tagsSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(40).regex(/^[a-z0-9][a-z0-9 -]*$/, 'Tags: letters, numbers, spaces, dashes'))
  .max(20)
  .transform((t) => [...new Set(t)]);

export const uploadMediaInput = z.object({
  filename: z.string().trim().min(1).max(200),
  alt: z.string().trim().min(1, 'Alt text is required').max(200),
  tags: tagsSchema.default([]),
  variants: z
    .array(z.object({ dataBase64: z.string().min(1) }))
    .min(1)
    .max(MAX_VARIANTS),
});

/**
 * @param localBaseUrl absolute origin of this API (local-disk storage only):
 * the landing app renders the URL on another host, so it must be absolute.
 */
export async function uploadMedia(input: z.infer<typeof uploadMediaInput>, opts: { actorId?: string; localBaseUrl: string }) {
  const files = input.variants.map((v, i) => {
    const bytes = Buffer.from(v.dataBase64, 'base64');
    const img = bytes.length ? sniffImage(bytes) : null;
    if (!img) throw new AppError(400, 'VALIDATION', `Variant ${i + 1} is not a PNG, JPEG or WebP image`);
    if (img.width < 1 || img.height < 1 || img.width > MAX_DIMENSION || img.height > MAX_DIMENSION) {
      throw new AppError(400, 'VALIDATION', `Variant ${i + 1} is ${img.width}×${img.height}; the limit is ${MAX_DIMENSION} px`);
    }
    return { bytes, ...img };
  });
  for (let i = 1; i < files.length; i++) {
    const a = files[i - 1];
    const b = files[i];
    if (b.width <= a.width) throw new AppError(400, 'VALIDATION', 'Variants must be sent smallest first, each wider than the last');
    if (Math.abs(a.width / a.height - b.width / b.height) > 0.02) throw new AppError(400, 'VALIDATION', 'All variants must have the same aspect ratio');
  }

  // Flat stem: local storage puts it in the filename (no sub-directories).
  const stem = `site-${Date.now().toString(36)}`;
  const variants: MediaVariant[] = [];
  try {
    for (const f of files) {
      const stored = await putContentImage(stem, `${input.filename}-${f.width}w`, f.mime, f.bytes);
      const url = stored.storage === 'local' ? `${opts.localBaseUrl.replace(/\/+$/, '')}${stored.imageUrl}` : stored.imageUrl;
      variants.push({ width: f.width, height: f.height, bytes: f.bytes.length, url, key: stored.imageKey });
    }
  } catch (e) {
    await Promise.all(variants.map((v) => deleteContentImage(v.key)));
    throw e;
  }
  const largest = variants[variants.length - 1];
  const pick = [...variants].reverse().find((v) => v.width <= DEFAULT_WIDTH) ?? variants[0];
  const row = await prisma.mediaAsset.create({
    data: {
      filename: input.filename,
      url: pick.url,
      variants: variants as unknown as Prisma.InputJsonValue,
      width: largest.width,
      height: largest.height,
      alt: input.alt,
      tags: input.tags,
      createdById: opts.actorId,
    },
  });
  return serialize(row);
}

export const updateMediaInput = z
  .object({ alt: z.string().trim().min(1, 'Alt text is required').max(200).optional(), tags: tagsSchema.optional() })
  .refine((v) => v.alt !== undefined || v.tags !== undefined, { message: 'Nothing to update' });

export async function updateMedia(id: string, input: z.infer<typeof updateMediaInput>) {
  await findAsset(id);
  return serialize(await prisma.mediaAsset.update({ where: { id }, data: input }));
}

/** Pages (draft or live version) whose document mentions any of these URLs. */
async function pagesUsing(urls: string[]) {
  const pages = await prisma.sitePage.findMany({
    where: { status: { not: 'ARCHIVED' } },
    select: { slug: true, title: true, draft: true, liveVersion: { select: { doc: true } } },
  });
  return pages
    .filter((p) => {
      const text = JSON.stringify(p.draft) + JSON.stringify(p.liveVersion?.doc ?? null);
      return urls.some((u) => text.includes(JSON.stringify(u).slice(1, -1)));
    })
    .map((p) => ({ slug: p.slug, title: p.title }));
}

export async function deleteMedia(id: string) {
  const r = await findAsset(id);
  const variants = r.variants as unknown as MediaVariant[];
  const used = await pagesUsing(variants.map((v) => v.url));
  if (used.length) {
    throw new AppError(409, 'CONFLICT', `Still used on ${used.map((p) => p.title).join(', ')}. Replace it there first.`, { pages: used });
  }
  await prisma.mediaAsset.delete({ where: { id } });
  await Promise.all(variants.map((v) => deleteContentImage(v.key)));
  return { id, deleted: true };
}

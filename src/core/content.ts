// Landing content management (mini-WordPress for images + texts).
//
// One ContentItem row per landing slot, addressed by its operator slug `key`
// (e.g. "hero-banner-1", "testimonial-3", "pricing-note"). Types:
// HERO_IMAGE | TESTIMONIAL | TEXT | IMAGE. TESTIMONIAL rows carry
// quote (body) + author + role; TEXT rows carry title/body copy;
// HERO_IMAGE / IMAGE rows carry an uploaded image (imageKey + imageUrl) plus
// alt text. `published=false` is a CMS draft — public reads (published-only,
// no PII) never see it. Image bytes live in S3 when CONTENT_S3_BUCKET is set,
// otherwise as local files (see src/lib/contentStorage.ts).
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { Prisma, ContentType } from '@prisma/client';
import { deleteContentImage, putContentImage } from '../lib/contentStorage';

const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CONTENT_TYPES = ['HERO_IMAGE', 'TESTIMONIAL', 'TEXT', 'IMAGE'] as const;
export type ContentTypeName = (typeof CONTENT_TYPES)[number];

function assertKey(key: string) {
  if (!KEY_RE.test(key)) {
    throw new AppError(
      400,
      'VALIDATION',
      'Content key must be a URL-safe slug (lowercase letters, numbers, hyphens, e.g. "hero-banner-1").',
    );
  }
}

type ContentRow = Prisma.ContentItemGetPayload<Record<string, never>>;

export function serializeContentItem(r: ContentRow) {
  return {
    id: r.id,
    key: r.key,
    type: r.type as ContentTypeName,
    title: r.title,
    body: r.body,
    author: r.author,
    role: r.role,
    imageKey: r.imageKey,
    imageUrl: r.imageUrl,
    alt: r.alt,
    sortOrder: r.sortOrder,
    published: r.published,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export interface ContentInput {
  key: string;
  type: ContentTypeName;
  title?: string | null;
  body?: string | null;
  author?: string | null;
  role?: string | null;
  alt?: string | null;
  imageUrl?: string | null;
  sortOrder?: number;
  published?: boolean;
}

function cleanText(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function validateCommon(input: Partial<ContentInput>, isCreate: boolean) {
  if (input.title !== undefined && input.title !== null && input.title.trim().length > 200) {
    throw new AppError(400, 'VALIDATION', 'title must be at most 200 characters.');
  }
  if (input.body !== undefined && input.body !== null && input.body.trim().length > 5000) {
    throw new AppError(400, 'VALIDATION', 'body must be at most 5000 characters.');
  }
  if (input.author !== undefined && input.author !== null && input.author.trim().length > 120) {
    throw new AppError(400, 'VALIDATION', 'author must be at most 120 characters.');
  }
  if (input.role !== undefined && input.role !== null && input.role.trim().length > 200) {
    throw new AppError(400, 'VALIDATION', 'role must be at most 200 characters.');
  }
  if (input.alt !== undefined && input.alt !== null && input.alt.trim().length > 200) {
    throw new AppError(400, 'VALIDATION', 'alt must be at most 200 characters.');
  }
  if (input.type === 'TESTIMONIAL' && isCreate) {
    if (!input.body || input.body.trim() === '') {
      throw new AppError(400, 'VALIDATION', 'Testimonials require a quote (body).');
    }
    if (!input.author || input.author.trim() === '') {
      throw new AppError(400, 'VALIDATION', 'Testimonials require an author.');
    }
  }
}

export async function listContentItems(opts: { type?: ContentTypeName; published?: boolean } = {}) {
  const rows = await prisma.contentItem.findMany({
    where: {
      ...(opts.type ? { type: opts.type as ContentType } : {}),
      ...(opts.published !== undefined ? { published: opts.published } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
  });
  return rows.map(serializeContentItem);
}

export async function getContentItem(key: string) {
  assertKey(key);
  const row = await prisma.contentItem.findUnique({ where: { key } });
  if (!row) throw new AppError(404, 'NOT_FOUND', `Content item "${key}" not found`);
  return serializeContentItem(row);
}

export async function createContentItem(input: ContentInput) {
  assertKey(input.key);
  validateCommon(input, true);
  const existing = await prisma.contentItem.findUnique({ where: { key: input.key } });
  if (existing) throw new AppError(409, 'CONFLICT', `Content item "${input.key}" already exists`);
  const row = await prisma.contentItem.create({
    data: {
      key: input.key,
      type: input.type as ContentType,
      title: cleanText(input.title),
      body: cleanText(input.body),
      author: cleanText(input.author),
      role: cleanText(input.role),
      alt: cleanText(input.alt),
      imageUrl: cleanText(input.imageUrl),
      sortOrder: input.sortOrder ?? 0,
      published: input.published ?? false,
    },
  });
  return serializeContentItem(row);
}

export async function updateContentItem(key: string, input: Partial<Omit<ContentInput, 'key'>>) {
  assertKey(key);
  validateCommon({ ...input, key }, false);
  const existing = await prisma.contentItem.findUnique({ where: { key } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Content item "${key}" not found`);
  if (input.type !== undefined && input.type !== (existing.type as ContentTypeName)) {
    // Retyping a row with an image or testimonial payload would orphan
    // semantics — force an explicit delete + recreate instead.
    throw new AppError(400, 'VALIDATION', 'Content type is immutable. Delete and recreate the item to change its type.');
  }
  const row = await prisma.contentItem.update({
    where: { key },
    data: {
      ...(input.title !== undefined ? { title: cleanText(input.title) } : {}),
      ...(input.body !== undefined ? { body: cleanText(input.body) } : {}),
      ...(input.author !== undefined ? { author: cleanText(input.author) } : {}),
      ...(input.role !== undefined ? { role: cleanText(input.role) } : {}),
      ...(input.alt !== undefined ? { alt: cleanText(input.alt) } : {}),
      ...(input.imageUrl !== undefined ? { imageUrl: cleanText(input.imageUrl) } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.published !== undefined ? { published: input.published } : {}),
    },
  });
  return serializeContentItem(row);
}

export async function deleteContentItem(key: string) {
  assertKey(key);
  const existing = await prisma.contentItem.findUnique({ where: { key } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Content item "${key}" not found`);
  await prisma.contentItem.delete({ where: { key } });
  // Best-effort S3/local cleanup — never fails the delete (see contentStorage).
  await deleteContentImage(existing.imageKey);
  return { key };
}

/** Upload (or replace) an item's image: direct PUT, then stamps imageKey/imageUrl. */
export async function setContentItemImage(key: string, filename: string, contentType: string, data: Buffer) {
  assertKey(key);
  const existing = await prisma.contentItem.findUnique({ where: { key } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Content item "${key}" not found`);
  const stored = await putContentImage(key, filename, contentType, data);
  const row = await prisma.contentItem.update({
    where: { key },
    data: { imageKey: stored.imageKey, imageUrl: stored.imageUrl },
  });
  // Remove the replaced object where safe (skipped when the key is unchanged).
  if (existing.imageKey && existing.imageKey !== stored.imageKey) {
    await deleteContentImage(existing.imageKey);
  }
  return { ...serializeContentItem(row), storage: stored.storage };
}

/** Remove an item's image (clears imageKey/imageUrl + deletes the stored object). */
export async function removeContentItemImage(key: string) {
  assertKey(key);
  const existing = await prisma.contentItem.findUnique({ where: { key } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', `Content item "${key}" not found`);
  const row = await prisma.contentItem.update({
    where: { key },
    data: { imageKey: null, imageUrl: null },
  });
  await deleteContentImage(existing.imageKey);
  return serializeContentItem(row);
}

// --- Public reads (published only, no PII — rows carry no contact fields by design) ---

export async function listPublishedContent(opts: { type?: ContentTypeName } = {}) {
  const rows = await prisma.contentItem.findMany({
    where: { published: true, ...(opts.type ? { type: opts.type as ContentType } : {}) },
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
  });
  return rows.map(serializeContentItem);
}

export async function getPublishedContent(key: string) {
  assertKey(key);
  const row = await prisma.contentItem.findUnique({ where: { key } });
  if (!row || !row.published) throw new AppError(404, 'NOT_FOUND', `Content item "${key}" not found`);
  return serializeContentItem(row);
}

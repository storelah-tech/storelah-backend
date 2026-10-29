// Site builder: landing pages as validated JSON documents
// (docs/SITE_BUILDER_PLAN.md §4, Phase 1).
//
// Lifecycle: a page has one working `draft` (optimistic lock on `draftRev`).
// Publishing re-validates the draft, freezes it as the next SitePageVersion
// and points `liveVersionId` at it, then asks GitHub to rebuild the static
// landing site. The public bundle serves live versions only, so drafts never
// leak. Rollback = copy an old version into the draft and publish it again.
// Archiving removes a page from the bundle but keeps its versions.

import { Prisma, SitePageStatus, SitePublishStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';
import { pageDocSchema, type PageDoc } from './sitePageSchema';

/** "/" (home) or lowercase path segments: "about", "guides/packing". */
export const SLUG_RE = /^(\/|[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*)$/;

// Paths the landing export already uses for non-page files.
const RESERVED_SLUGS = new Set(['site-preview', 'api', 'assets', '_next', '404']);

function assertSlug(slug: string) {
  if (!SLUG_RE.test(slug)) {
    throw new AppError(400, 'VALIDATION', 'Slug must be "/" or lowercase words separated by "-" or "/" (e.g. "guides/packing").');
  }
  if (RESERVED_SLUGS.has(slug.split('/')[0])) {
    throw new AppError(400, 'VALIDATION', `Slug "${slug}" is reserved by the site.`);
  }
}

/** Validates a page document; 400 with field paths the editor can highlight. */
export function validatePageDoc(raw: unknown): PageDoc {
  const r = pageDocSchema.safeParse(raw);
  if (!r.success) {
    throw new AppError(
      400,
      'VALIDATION',
      'Page document is invalid',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

const asJson = (doc: PageDoc) => doc as unknown as Prisma.InputJsonValue;

const PAGE_INCLUDE = {
  liveVersion: { select: { id: true, number: true, doc: true, createdAt: true } },
} as const;

type PageRow = Prisma.SitePageGetPayload<{ include: typeof PAGE_INCLUDE }>;

function hasUnpublishedChanges(p: PageRow): boolean {
  if (p.status === SitePageStatus.ARCHIVED) return false;
  return !p.liveVersion || JSON.stringify(p.liveVersion.doc) !== JSON.stringify(p.draft);
}

function serializePage(p: PageRow, withDraft: boolean) {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    status: p.status,
    system: p.system,
    draftRev: p.draftRev,
    live: p.liveVersion ? { versionId: p.liveVersion.id, number: p.liveVersion.number, publishedAt: p.liveVersion.createdAt } : null,
    hasUnpublishedChanges: hasUnpublishedChanges(p),
    updatedById: p.updatedById,
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
    ...(withDraft ? { draft: p.draft } : {}),
  };
}

async function findPage(id: string): Promise<PageRow> {
  const p = await prisma.sitePage.findUnique({ where: { id }, include: PAGE_INCLUDE });
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Page not found');
  return p;
}

// ---------- reads ----------

export async function listSitePages(opts: { includeArchived?: boolean } = {}) {
  const rows = await prisma.sitePage.findMany({
    where: opts.includeArchived ? {} : { status: { not: SitePageStatus.ARCHIVED } },
    include: PAGE_INCLUDE,
    orderBy: { slug: 'asc' },
  });
  return rows.map((p) => serializePage(p, false));
}

export async function getSitePage(id: string) {
  return serializePage(await findPage(id), true);
}

export async function listSitePageVersions(id: string) {
  await findPage(id);
  return prisma.sitePageVersion.findMany({
    where: { pageId: id },
    orderBy: { number: 'desc' },
    select: { id: true, number: true, note: true, publishId: true, createdById: true, createdAt: true },
  });
}

export async function getSitePageVersion(id: string, versionId: string) {
  const v = await prisma.sitePageVersion.findFirst({ where: { id: versionId, pageId: id } });
  if (!v) throw new AppError(404, 'NOT_FOUND', 'Version not found');
  return v;
}

// ---------- writes ----------

export const createPageInput = z.object({
  slug: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120),
  doc: z.unknown().optional(),
});

async function assertSlugFree(slug: string, exceptId?: string) {
  const clash = await prisma.sitePage.findUnique({ where: { slug } });
  if (clash && clash.id !== exceptId) throw new AppError(409, 'CONFLICT', `A page already uses the slug "${slug}"`);
}

export async function createSitePage(input: z.infer<typeof createPageInput>, actorId?: string) {
  assertSlug(input.slug);
  await assertSlugFree(input.slug);
  const doc = validatePageDoc(input.doc ?? { seo: { title: input.title }, sections: [] });
  const p = await prisma.sitePage.create({
    data: { slug: input.slug, title: input.title, draft: asJson(doc), updatedById: actorId },
    include: PAGE_INCLUDE,
  });
  return serializePage(p, true);
}

export const saveDraftInput = z.object({
  doc: z.unknown(),
  rev: z.number().int().min(0),
});

/** Optimistic lock: answers 409 with the current rev when `rev` is stale. */
export async function saveSitePageDraft(id: string, input: z.infer<typeof saveDraftInput>, actorId?: string) {
  const page = await findPage(id);
  if (page.status === SitePageStatus.ARCHIVED) throw new AppError(409, 'CONFLICT', 'Page is archived');
  const doc = validatePageDoc(input.doc);
  const r = await prisma.sitePage.updateMany({
    where: { id, draftRev: input.rev },
    data: { draft: asJson(doc), draftRev: { increment: 1 }, updatedById: actorId },
  });
  if (r.count === 0) {
    const current = await prisma.sitePage.findUnique({ where: { id }, select: { draftRev: true, updatedById: true, updatedAt: true } });
    throw new AppError(409, 'CONFLICT', 'This page was changed since you opened it. Reload to see the latest draft.', current);
  }
  return getSitePage(id);
}

export const updatePageInput = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    slug: z.string().trim().min(1).max(120).optional(),
  })
  .refine((v) => v.title !== undefined || v.slug !== undefined, { message: 'Nothing to update' });

export async function updateSitePage(id: string, input: z.infer<typeof updatePageInput>, actorId?: string) {
  const page = await findPage(id);
  if (input.slug !== undefined && input.slug !== page.slug) {
    if (page.system) throw new AppError(409, 'CONFLICT', 'Core site pages keep their URL');
    assertSlug(input.slug);
    await assertSlugFree(input.slug, id);
  }
  await prisma.sitePage.update({ where: { id }, data: { ...input, updatedById: actorId } });
  return getSitePage(id);
}

export const duplicatePageInput = z.object({
  slug: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(120),
});

export async function duplicateSitePage(id: string, input: z.infer<typeof duplicatePageInput>, actorId?: string) {
  const page = await findPage(id);
  return createSitePage({ ...input, doc: page.draft }, actorId);
}

export async function archiveSitePage(id: string, actorId?: string) {
  const page = await findPage(id);
  if (page.system) throw new AppError(409, 'CONFLICT', 'Core site pages cannot be archived');
  await prisma.sitePage.update({
    where: { id },
    data: { status: SitePageStatus.ARCHIVED, liveVersionId: null, updatedById: actorId },
  });
  return getSitePage(id);
}

// ---------- publish ----------

export const publishInput = z.object({
  /** Defaults to every page with unpublished changes. */
  pageIds: z.array(z.string().min(1)).max(200).optional(),
  note: z.string().trim().max(300).optional(),
});

export interface PublishOptions {
  /** false = record the publish but never trigger a landing rebuild (import script). */
  dispatch?: boolean;
}

export async function publishSitePages(
  input: z.infer<typeof publishInput>,
  actorId?: string,
  opts: PublishOptions = {},
) {
  const rows = await prisma.sitePage.findMany({
    where: {
      status: { not: SitePageStatus.ARCHIVED },
      ...(input.pageIds ? { id: { in: input.pageIds } } : {}),
    },
    include: PAGE_INCLUDE,
  });
  if (input.pageIds) {
    const found = new Set(rows.map((r) => r.id));
    const missing = input.pageIds.filter((id) => !found.has(id));
    if (missing.length) throw new AppError(404, 'NOT_FOUND', 'Some pages were not found or are archived', { missing });
  }
  const pending = rows.filter(hasUnpublishedChanges);
  if (pending.length === 0) throw new AppError(400, 'VALIDATION', 'Nothing to publish: every selected page is already live.');

  // Re-validate: the schema may have changed since the draft was saved.
  const docs = pending.map((p) => {
    try {
      return validatePageDoc(p.draft);
    } catch (e) {
      if (e instanceof AppError) throw new AppError(400, 'VALIDATION', `Page "${p.slug}" is invalid`, e.details);
      throw e;
    }
  });

  const publish = await prisma.$transaction(async (tx) => {
    const pub = await tx.sitePublish.create({
      data: { scope: [], note: input.note, status: SitePublishStatus.NOT_CONFIGURED, createdById: actorId },
    });
    const scope: { pageId: string; slug: string; versionId: string; number: number }[] = [];
    for (const [i, p] of pending.entries()) {
      const last = await tx.sitePageVersion.findFirst({ where: { pageId: p.id }, orderBy: { number: 'desc' }, select: { number: true } });
      const number = (last?.number ?? 0) + 1;
      const v = await tx.sitePageVersion.create({
        data: { pageId: p.id, number, doc: asJson(docs[i]), note: input.note, publishId: pub.id, createdById: actorId },
      });
      await tx.sitePage.update({ where: { id: p.id }, data: { liveVersionId: v.id, status: SitePageStatus.PUBLISHED } });
      scope.push({ pageId: p.id, slug: p.slug, versionId: v.id, number });
    }
    return tx.sitePublish.update({ where: { id: pub.id }, data: { scope } });
  });

  // The versions are live in the bundle now; the rebuild is best-effort and
  // its outcome is recorded on the publish row (never rolls the publish back).
  const outcome = opts.dispatch === false ? { status: SitePublishStatus.SKIPPED } : await dispatchLandingBuild(publish.id);
  return prisma.sitePublish.update({ where: { id: publish.id }, data: outcome });
}

export async function rollbackSitePage(id: string, versionId: string, actorId?: string) {
  const page = await findPage(id);
  if (page.status === SitePageStatus.ARCHIVED) throw new AppError(409, 'CONFLICT', 'Page is archived');
  const v = await getSitePageVersion(id, versionId);
  if (page.liveVersion?.id === v.id) throw new AppError(400, 'VALIDATION', `Version ${v.number} is already live`);
  await prisma.sitePage.update({
    where: { id },
    data: { draft: v.doc as Prisma.InputJsonValue, draftRev: { increment: 1 }, updatedById: actorId },
  });
  return publishSitePages({ pageIds: [id], note: `Rollback to version ${v.number}` }, actorId);
}

export async function listSitePublishes(limit = 50) {
  return prisma.sitePublish.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(limit, 1), 200) });
}

// ---------- landing rebuild trigger ----------

/**
 * Fires the landing deploy workflow (workflow_dispatch). Env names per
 * docs/backend-deploy.md; unset token = NOT_CONFIGURED (dev, tests, until the
 * owner creates the token). Errors never include the token.
 */
async function dispatchLandingBuild(publishId: string): Promise<{ status: SitePublishStatus; error?: string }> {
  const token = process.env.LANDING_DISPATCH_TOKEN;
  const repo = process.env.LANDING_DISPATCH_REPO;
  const workflow = process.env.LANDING_DISPATCH_WORKFLOW || 'landing-deploy.yaml';
  const ref = process.env.LANDING_DISPATCH_REF || 'main';
  if (!token || !repo) return { status: SitePublishStatus.NOT_CONFIGURED };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref, inputs: { publishId } }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 204) return { status: SitePublishStatus.DISPATCHED };
    return { status: SitePublishStatus.FAILED, error: `GitHub answered ${res.status}` };
  } catch (e) {
    return { status: SitePublishStatus.FAILED, error: e instanceof Error ? e.name : 'Request failed' };
  }
}

// ---------- public ----------

/** Live versions only — the single thing the landing build reads. */
export async function getSiteBundle() {
  const [pages, last] = await Promise.all([
    prisma.sitePage.findMany({
      where: { status: SitePageStatus.PUBLISHED, liveVersionId: { not: null } },
      select: { slug: true, liveVersion: { select: { doc: true, number: true } } },
      orderBy: { slug: 'asc' },
    }),
    prisma.sitePublish.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true } }),
  ]);
  return {
    pages: pages.map((p) => ({ slug: p.slug, version: p.liveVersion!.number, doc: p.liveVersion!.doc })),
    publishId: last?.id ?? null,
    publishedAt: last?.createdAt ?? null,
  };
}

/**
 * Editor config. The live preview iframes the landing app's /site-preview/
 * (it must list the CMS origin in NEXT_PUBLIC_PREVIEW_PARENT_ORIGINS).
 * Unset LANDING_PREVIEW_ORIGIN = no preview; editing still works.
 */
export function getSiteEditorConfig() {
  const origin = (process.env.LANDING_PREVIEW_ORIGIN || '').trim().replace(/\/+$/, '');
  return {
    previewUrl: /^https?:\/\/[^\s/]+$/.test(origin) ? `${origin}/site-preview/` : null,
    rebuildConfigured: !!(process.env.LANDING_DISPATCH_TOKEN && process.env.LANDING_DISPATCH_REPO),
  };
}

/** JSON Schema of the page document, for the landing contract test. */
export function getPageDocJsonSchema() {
  return z.toJSONSchema(pageDocSchema, { io: 'input', unrepresentable: 'any' });
}

// ---------- import (scripts/site-import.ts) ----------

const SNAPSHOT_TITLE_SUFFIX = / \| StoreLah Self Storage$/;

/**
 * Imports the landing repo's content/snapshot.json as version 1 of each page,
 * marked `system` (core routes). Existing slugs are never touched. Every doc
 * is validated before anything is written. Records one publish with the
 * rebuild trigger SKIPPED (the snapshot already is what the site shows).
 */
export async function importSiteSnapshot(raw: unknown, opts: { apply: boolean; actorId?: string }) {
  const pages = (raw as { pages?: Record<string, unknown> } | null)?.pages;
  if (!pages || typeof pages !== 'object') throw new AppError(400, 'VALIDATION', 'Snapshot must be { pages: { <slug>: <doc> } }');

  const entries = Object.entries(pages).map(([slug, doc]) => {
    assertSlug(slug);
    try {
      return { slug, doc: validatePageDoc(doc) };
    } catch (e) {
      if (e instanceof AppError) throw new AppError(400, 'VALIDATION', `Snapshot page "${slug}" is invalid`, e.details);
      throw e;
    }
  });
  const existing = new Set(
    (await prisma.sitePage.findMany({ where: { slug: { in: entries.map((e) => e.slug) } }, select: { slug: true } })).map((p) => p.slug),
  );
  const toCreate = entries.filter((e) => !existing.has(e.slug));
  const result = { created: toCreate.map((e) => e.slug), skipped: [...existing].sort(), publishId: null as string | null };
  if (!opts.apply || toCreate.length === 0) return result;

  const ids: string[] = [];
  for (const e of toCreate) {
    const p = await prisma.sitePage.create({
      data: {
        slug: e.slug,
        title: e.doc.seo.title.replace(SNAPSHOT_TITLE_SUFFIX, '') || e.slug,
        system: true,
        draft: asJson(e.doc),
        updatedById: opts.actorId,
      },
    });
    ids.push(p.id);
  }
  const pub = await publishSitePages({ pageIds: ids, note: 'Imported from landing content/snapshot.json' }, opts.actorId, { dispatch: false });
  result.publishId = pub.id;
  return result;
}

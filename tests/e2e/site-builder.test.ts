// Site builder Phase 1 (docs/SITE_BUILDER_PLAN.md §5): page-document
// validation per section type, optimistic-lock 409, publish/version rules,
// rollback, archive, a public bundle that never carries drafts, permissions
// (approve = publish), and the landing snapshot import.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, createOperator, prisma, resetDb, type Operator } from './fixtures';
import { pageDocSchema, siteSettingsSchema } from '../../src/core/sitePageSchema';
import { importSiteSnapshot } from '../../src/core/sitePages';

const CMS = '/api/v1/cms';
const PUB = '/api/v1/public';
const snapshot = JSON.parse(readFileSync(join(__dirname, 'site-snapshot.json'), 'utf8')) as {
  settings: Record<string, any>;
  pages: Record<string, { sections: { type: string }[] }>;
};

const doc = (heading = 'Hello', extra: object[] = []) => ({
  seo: { title: 'Test page' },
  sections: [
    { id: 'hero', type: 'pageHero', variant: 'textOnly', props: { crumb: 'Test', heading } },
    ...extra,
  ],
});

async function newPage(owner: Operator, slug = 'test-page', body: object = doc()) {
  const res = await api.post(`${CMS}/site/pages`).set('Authorization', owner.auth).send({ slug, title: 'Test', doc: body });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; draftRev: number };
}

describe('page document schema', () => {
  it('accepts every page in the landing snapshot', () => {
    const bad = Object.entries(snapshot.pages)
      .map(([slug, d]) => [slug, pageDocSchema.safeParse(d)] as const)
      .filter(([, r]) => !r.success)
      .map(([slug, r]) => [slug, r.success ? null : r.error.issues.slice(0, 2)]);
    expect(bad).toEqual([]);
  });

  it('accepts the landing snapshot settings and rejects a bad contact email / link', () => {
    expect(siteSettingsSchema.safeParse(snapshot.settings).success).toBe(true);
    const bad = siteSettingsSchema.safeParse({
      ...snapshot.settings,
      contact: { email: 'not-an-email' },
      footer: { ...snapshot.settings.footer, legal: [{ label: 'x', href: 'javascript:alert(1)' }] },
    });
    expect(bad.success ? [] : bad.error.issues.map((i) => i.path.join('.'))).toEqual(['contact.email', 'footer.legal.0.href']);
  });

  it('the snapshot exercises every section type', () => {
    const used = new Set(Object.values(snapshot.pages).flatMap((d) => d.sections.map((s) => s.type)));
    const all = pageDocSchema.shape.sections.element.options.map((o) => o.shape.type.value);
    expect(all.filter((t) => !used.has(t))).toEqual([]);
  });

  // One invalid sample per section type (plus shared rules), each naming the field.
  const invalid: [string, object, string][] = [
    ['unknown section type', { id: 'x', type: 'marquee', props: {} }, 'sections.0.type'],
    ['pageHero without heading', { id: 'x', type: 'pageHero', props: { crumb: 'A' } }, 'sections.0.props.heading'],
    ['split with one column', { id: 'x', type: 'split', props: { columns: [{ kind: 'text' }] } }, 'sections.0.props.columns'],
    ['featureCards without items', { id: 'x', type: 'featureCards', props: { items: [] } }, 'sections.0.props.items'],
    ['faqSearch item without answer', { id: 'x', type: 'faqSearch', props: { items: [{ q: 'Q' }] } }, 'sections.0.props.items.0.a'],
    ['article with raw HTML link', { id: 'x', type: 'article', props: { blocks: [{ kind: 'link', cta: { label: 'x', href: 'javascript:alert(1)' } }] } }, 'sections.0.props.blocks.0.cta.href'],
    ['cardGrid image without alt', { id: 'x', type: 'cardGrid', props: { items: [{ title: 'T', image: { src: '/a.webp', alt: '' } }] } }, 'sections.0.props.items.0.image.alt'],
    ['comparisonTable row/column mismatch', { id: 'x', type: 'comparisonTable', props: { columns: ['A', 'B'], rows: [{ label: 'r', cells: ['1', '2'] }] } }, 'sections.0.props.rows'],
    ['gallery with two images', { id: 'x', type: 'gallery', props: { images: [{ src: '/a', alt: 'a' }, { src: '/b', alt: 'b' }] } }, 'sections.0.props.images'],
    ['sizeCalculator without crumb', { id: 'x', type: 'sizeCalculator', props: { heading: 'H' } }, 'sections.0.props.crumb'],
    ['unknown widget', { id: 'x', type: 'widget', props: { widget: 'iframe' } }, 'sections.0.props.widget'],
    ['heroCarousel duplicate keys', { id: 'x', type: 'heroCarousel', props: { slides: [1, 2].map(() => ({ key: 'hero-a', label: 'L', image: { src: '/a', alt: 'a' }, eyebrow: 'E', heading: 'H', text: 'T' })) } }, 'sections.0.props.slides'],
    ['bookingFinder fact without title', { id: 'x', type: 'bookingFinder', props: { facts: [{ text: 't' }] } }, 'sections.0.props.facts.0.title'],
    ['sizeShowcase bad CTA style', { id: 'x', type: 'sizeShowcase', props: { ctas: [{ label: 'x', href: '/', style: 'huge' }] } }, 'sections.0.props.ctas.0.style'],
    ['calculatorTeaser http image', { id: 'x', type: 'calculatorTeaser', props: { heading: 'H', image: { src: 'http://x/a.png', alt: 'a' } } }, 'sections.0.props.image.src'],
    ['bookingJourney without steps', { id: 'x', type: 'bookingJourney', props: { steps: [] } }, 'sections.0.props.steps'],
    ['locationFeature without card', { id: 'x', type: 'locationFeature', props: { heading: 'H' } }, 'sections.0.props.card'],
    ['faqTeaser without items', { id: 'x', type: 'faqTeaser', props: { heading: 'H', items: [] } }, 'sections.0.props.items'],
    ['bad section id', { id: 'has space', type: 'ctaBand', props: {} }, 'sections.0.id'],
  ];
  it.each(invalid)('rejects %s', (_name, section, path) => {
    const r = pageDocSchema.safeParse({ seo: { title: 'T' }, sections: [section] });
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues.map((i) => i.path.join('.'))).toContain(path);
  });
});

describe('site builder API', () => {
  let owner: Operator;
  beforeEach(async () => {
    await resetDb();
    owner = await createOperator('OWNER');
  });

  it('creates a page, rejects invalid docs with field paths, and enforces unique, valid slugs', async () => {
    await newPage(owner);
    const dup = await api.post(`${CMS}/site/pages`).set('Authorization', owner.auth).send({ slug: 'test-page', title: 'Again' });
    expect(dup.status).toBe(409);
    const bad = await api.post(`${CMS}/site/pages`).set('Authorization', owner.auth).send({ slug: 'Bad Slug', title: 'x' });
    expect(bad.status).toBe(400);
    const reserved = await api.post(`${CMS}/site/pages`).set('Authorization', owner.auth).send({ slug: 'site-preview', title: 'x' });
    expect(reserved.status).toBe(400);
    const invalid = await api
      .post(`${CMS}/site/pages`)
      .set('Authorization', owner.auth)
      .send({ slug: 'other', title: 'x', doc: { seo: { title: '' }, sections: [] } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details).toEqual([expect.objectContaining({ path: 'seo.title' })]);
  });

  it('saves drafts with an optimistic lock: a stale rev gets 409 and the current rev', async () => {
    const p = await newPage(owner);
    const first = await api.put(`${CMS}/site/pages/${p.id}/draft`).set('Authorization', owner.auth).send({ doc: doc('One'), rev: 0 });
    expect(first.status).toBe(200);
    expect(first.body.data.draftRev).toBe(1);
    const stale = await api.put(`${CMS}/site/pages/${p.id}/draft`).set('Authorization', owner.auth).send({ doc: doc('Two'), rev: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.draftRev).toBe(1);
    const again = await api.get(`${CMS}/site/pages/${p.id}`).set('Authorization', owner.auth);
    expect(again.body.data.draft.sections[0].props.heading).toBe('One');
  });

  it('publishes drafts as numbered versions; the public bundle serves live versions only', async () => {
    const p = await newPage(owner, 'about');
    const unpublished = await newPage(owner, 'draft-only');

    const before = await api.get(`${PUB}/site/bundle`);
    expect(before.status).toBe(200);
    expect(before.body.data.pages).toEqual([]);

    const pub = await api.post(`${CMS}/site/publish`).set('Authorization', owner.auth).send({ pageIds: [p.id], note: 'first' });
    expect(pub.status).toBe(201);
    expect(pub.body.data.status).toBe('NOT_CONFIGURED'); // no dispatch token in tests
    expect(pub.body.data.scope).toEqual([expect.objectContaining({ slug: 'about', number: 1 })]);

    // Editing the draft after publishing must not change what is live.
    await api.put(`${CMS}/site/pages/${p.id}/draft`).set('Authorization', owner.auth).send({ doc: doc('Draft edit'), rev: 0 });
    const bundle = await api.get(`${PUB}/site/bundle`);
    expect(bundle.body.data.pages).toHaveLength(1);
    expect(bundle.body.data.pages[0]).toMatchObject({ slug: 'about', version: 1 });
    expect(bundle.body.data.pages[0].doc.sections[0].props.heading).toBe('Hello');
    expect(bundle.body.data.publishId).toBe(pub.body.data.id);
    expect(JSON.stringify(bundle.body)).not.toContain('Draft edit');
    expect(bundle.body.data.pages.map((x: { slug: string }) => x.slug)).not.toContain('draft-only');

    const list = await api.get(`${CMS}/site/pages`).set('Authorization', owner.auth);
    const about = list.body.data.find((x: { id: string }) => x.id === p.id);
    expect(about).toMatchObject({ status: 'PUBLISHED', hasUnpublishedChanges: true, live: { number: 1 } });

    // Default scope = every page with unpublished changes (about + draft-only).
    const second = await api.post(`${CMS}/site/publish`).set('Authorization', owner.auth).send({});
    expect(second.body.data.scope.map((s: { slug: string; number: number }) => [s.slug, s.number]).sort()).toEqual([
      ['about', 2],
      ['draft-only', 1],
    ]);
    expect(unpublished.id).toBeTruthy();
    const nothing = await api.post(`${CMS}/site/publish`).set('Authorization', owner.auth).send({});
    expect(nothing.status).toBe(400);
  });

  it('rolls back by publishing an old version as the next version', async () => {
    const p = await newPage(owner, 'about');
    await api.post(`${CMS}/site/publish`).set('Authorization', owner.auth).send({ pageIds: [p.id] });
    await api.put(`${CMS}/site/pages/${p.id}/draft`).set('Authorization', owner.auth).send({ doc: doc('V2'), rev: 0 });
    await api.post(`${CMS}/site/publish`).set('Authorization', owner.auth).send({ pageIds: [p.id] });

    const versions = await api.get(`${CMS}/site/pages/${p.id}/versions`).set('Authorization', owner.auth);
    expect(versions.body.data.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    const v1 = versions.body.data[1].id;
    const live = await api.post(`${CMS}/site/pages/${p.id}/rollback/${versions.body.data[0].id}`).set('Authorization', owner.auth);
    expect(live.status).toBe(400); // already live

    const rb = await api.post(`${CMS}/site/pages/${p.id}/rollback/${v1}`).set('Authorization', owner.auth);
    expect(rb.status).toBe(200);
    expect(rb.body.data.note).toBe('Rollback to version 1');
    const bundle = await api.get(`${PUB}/site/bundle`);
    expect(bundle.body.data.pages[0]).toMatchObject({ version: 3 });
    expect(bundle.body.data.pages[0].doc.sections[0].props.heading).toBe('Hello');
  });

  it('archives custom pages out of the bundle but protects core pages', async () => {
    const custom = await newPage(owner, 'summer-offer');
    await api.post(`${CMS}/site/publish`).set('Authorization', owner.auth).send({ pageIds: [custom.id] });
    const del = await api.delete(`${CMS}/site/pages/${custom.id}`).set('Authorization', owner.auth);
    expect(del.status).toBe(200);
    expect(del.body.data.status).toBe('ARCHIVED');
    expect((await api.get(`${PUB}/site/bundle`)).body.data.pages).toEqual([]);
    expect((await api.get(`${CMS}/site/pages/${custom.id}/versions`).set('Authorization', owner.auth)).body.data).toHaveLength(1);

    await prisma.sitePage.create({ data: { slug: 'about', title: 'About', system: true, draft: doc() } });
    const core = await prisma.sitePage.findUniqueOrThrow({ where: { slug: 'about' } });
    expect((await api.delete(`${CMS}/site/pages/${core.id}`).set('Authorization', owner.auth)).status).toBe(409);
    expect((await api.patch(`${CMS}/site/pages/${core.id}`).set('Authorization', owner.auth).send({ slug: 'about-us' })).status).toBe(409);
    const renamed = await api.patch(`${CMS}/site/pages/${core.id}`).set('Authorization', owner.auth).send({ title: 'About StoreLah' });
    expect(renamed.body.data.title).toBe('About StoreLah');
  });

  it('duplicates a page draft under a new slug', async () => {
    const p = await newPage(owner, 'about', doc('Original'));
    const copy = await api.post(`${CMS}/site/pages/${p.id}/duplicate`).set('Authorization', owner.auth).send({ slug: 'about-copy', title: 'Copy' });
    expect(copy.status).toBe(201);
    expect(copy.body.data).toMatchObject({ slug: 'about-copy', status: 'DRAFT', system: false });
    expect(copy.body.data.draft.sections[0].props.heading).toBe('Original');
  });

  it('editor config: no preview until LANDING_PREVIEW_ORIGIN is set; never exposes the dispatch token', async () => {
    const before = await api.get(`${CMS}/site/config`).set('Authorization', owner.auth);
    expect(before.body.data).toEqual({ previewUrl: null, rebuildConfigured: false });
    process.env.LANDING_PREVIEW_ORIGIN = 'https://preview.storelah.sg/';
    process.env.LANDING_DISPATCH_TOKEN = 'secret-value';
    process.env.LANDING_DISPATCH_REPO = 'example/repo';
    try {
      const after = await api.get(`${CMS}/site/config`).set('Authorization', owner.auth);
      expect(after.body.data).toEqual({ previewUrl: 'https://preview.storelah.sg/site-preview/', rebuildConfigured: true });
      expect(JSON.stringify(after.body)).not.toContain('secret-value');
    } finally {
      delete process.env.LANDING_PREVIEW_ORIGIN;
      delete process.env.LANDING_DISPATCH_TOKEN;
      delete process.env.LANDING_DISPATCH_REPO;
    }
  });

  it('serves the page JSON Schema publicly and to the CMS', async () => {
    const res = await api.get(`${PUB}/site/schema`);
    expect(res.status).toBe(200);
    expect(res.body.data.properties.sections.type).toBe('array');
    expect(JSON.stringify(res.body.data)).toContain('heroCarousel');
  });

  it('accepts a 300 KB draft (above the global 100 KB JSON limit)', async () => {
    const p = await newPage(owner);
    const big = doc('Big', [
      { id: 'faq', type: 'faqSearch', props: { items: Array.from({ length: 100 }, (_, i) => ({ q: `Q${i}`, a: 'x'.repeat(2900) })) } },
    ]);
    expect(JSON.stringify(big).length).toBeGreaterThan(290_000);
    const res = await api.put(`${CMS}/site/pages/${p.id}/draft`).set('Authorization', owner.auth).send({ doc: big, rev: 0 });
    expect(res.status).toBe(200);
  });
});

describe('global site settings', () => {
  let owner: Operator;
  beforeEach(async () => {
    await resetDb();
    owner = await createOperator('OWNER');
  });

  it('import creates v1; drafts lock on rev; publish scoping; the bundle serves live settings only', async () => {
    expect((await api.get(`${CMS}/site/settings`).set('Authorization', owner.auth)).status).toBe(404);
    const imp = await importSiteSnapshot(snapshot, { apply: true });
    expect(imp.settings).toBe(true);
    const pub0 = await prisma.sitePublish.findUniqueOrThrow({ where: { id: imp.publishId! } });
    expect(pub0.settingsVersion).toBe(1);

    const cur = await api.get(`${CMS}/site/settings`).set('Authorization', owner.auth);
    expect(cur.body.data).toMatchObject({ draftRev: 0, live: { version: 1 }, hasUnpublishedChanges: false });
    expect(cur.body.data.schema.properties.header.type).toBe('object');
    let bundle = await api.get(`${PUB}/site/bundle`);
    expect(bundle.body.data.settings).toEqual(siteSettingsSchema.parse(snapshot.settings));
    expect(bundle.body.data.settingsVersion).toBe(1);

    const edited = { ...cur.body.data.draft, topline: { show: true, text: 'Now open in **Sembawang**' } };
    const bad = await api.put(`${CMS}/site/settings/draft`).set('Authorization', owner.auth).send({ doc: { ...edited, contact: { email: 'x' } }, rev: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([expect.objectContaining({ path: 'contact.email' })]);
    const saved = await api.put(`${CMS}/site/settings/draft`).set('Authorization', owner.auth).send({ doc: edited, rev: 0 });
    expect(saved.body.data).toMatchObject({ draftRev: 1, hasUnpublishedChanges: true });
    expect((await api.put(`${CMS}/site/settings/draft`).set('Authorization', owner.auth).send({ doc: edited, rev: 0 })).status).toBe(409);

    // Draft settings never reach the bundle.
    bundle = await api.get(`${PUB}/site/bundle`);
    expect(bundle.body.data.settings.topline.text).not.toContain('Now open');

    // Publishing named pages leaves settings alone…
    const about = await prisma.sitePage.findUniqueOrThrow({ where: { slug: 'about' } });
    await prisma.sitePage.update({ where: { id: about.id }, data: { title: 'About (renamed)' } });
    const pagesOnly = await api.post(`${CMS}/site/publish`).set('Authorization', owner.auth).send({ pageIds: [about.id] });
    expect(pagesOnly.status).toBe(400); // renaming is not a content change; settings not included
    // …settings-only publish takes them live.
    const settingsOnly = await api.post(`${CMS}/site/publish`).set('Authorization', owner.auth).send({ pageIds: [], settings: true });
    expect(settingsOnly.status).toBe(201);
    expect(settingsOnly.body.data).toMatchObject({ settingsVersion: 2, scope: [] });
    bundle = await api.get(`${PUB}/site/bundle`);
    expect(bundle.body.data.settings.topline.text).toBe('Now open in **Sembawang**');
    expect((await api.post(`${CMS}/site/publish`).set('Authorization', owner.auth).send({})).status).toBe(400); // nothing left

    const viewer = await createOperator('VIEWER');
    expect((await api.get(`${CMS}/site/settings`).set('Authorization', viewer.auth)).status).toBe(200);
    expect((await api.put(`${CMS}/site/settings/draft`).set('Authorization', viewer.auth).send({ doc: edited, rev: 1 })).status).toBe(403);
  });
});

describe('site builder permissions', () => {
  beforeEach(resetDb);

  it('Viewer reads only; Manager edits but cannot publish or roll back; Owner publishes', async () => {
    const owner = await createOperator('OWNER');
    const manager = await createOperator('MANAGER');
    const viewer = await createOperator('VIEWER');
    const p = await newPage(owner);

    expect((await api.get(`${CMS}/site/pages`).set('Authorization', viewer.auth)).status).toBe(200);
    expect((await api.put(`${CMS}/site/pages/${p.id}/draft`).set('Authorization', viewer.auth).send({ doc: doc(), rev: 0 })).status).toBe(403);
    expect((await api.post(`${CMS}/site/pages`).set('Authorization', viewer.auth).send({ slug: 'v', title: 'v' })).status).toBe(403);

    expect((await api.put(`${CMS}/site/pages/${p.id}/draft`).set('Authorization', manager.auth).send({ doc: doc('M'), rev: 0 })).status).toBe(200);
    expect((await api.post(`${CMS}/site/publish`).set('Authorization', manager.auth).send({})).status).toBe(403);
    expect((await api.post(`${CMS}/site/pages/${p.id}/rollback/x`).set('Authorization', manager.auth)).status).toBe(403);

    expect((await api.post(`${CMS}/site/publish`).set('Authorization', owner.auth).send({})).status).toBe(201);
    expect((await api.get(`${CMS}/site/pages`)).status).toBe(401);
  });
});

describe('landing snapshot import', () => {
  beforeEach(resetDb);
  afterEach(() => {
    delete process.env.LANDING_DISPATCH_TOKEN;
    delete process.env.LANDING_DISPATCH_REPO;
  });

  it('dry run writes nothing; apply creates core pages as v1 without triggering a rebuild; re-run skips them', async () => {
    // A configured trigger must still not fire for the import.
    process.env.LANDING_DISPATCH_TOKEN = 'not-a-real-token';
    process.env.LANDING_DISPATCH_REPO = 'example/never-called';
    const slugs = Object.keys(snapshot.pages);

    const dry = await importSiteSnapshot(snapshot, { apply: false });
    expect(dry.created.sort()).toEqual([...slugs].sort());
    expect(await prisma.sitePage.count()).toBe(0);

    const applied = await importSiteSnapshot(snapshot, { apply: true });
    expect(applied.created).toHaveLength(slugs.length);
    const pub = await prisma.sitePublish.findUniqueOrThrow({ where: { id: applied.publishId! } });
    expect(pub.status).toBe('SKIPPED');
    const home = await prisma.sitePage.findUniqueOrThrow({ where: { slug: '/' }, include: { liveVersion: true } });
    expect(home).toMatchObject({ system: true, status: 'PUBLISHED', title: 'Self-storage in Sembawang' });
    expect(home.liveVersion?.number).toBe(1);

    // The bundle now reproduces the snapshot exactly (what the landing build reads).
    const bundle = await api.get(`${PUB}/site/bundle`);
    const bySlug = Object.fromEntries(bundle.body.data.pages.map((p: { slug: string; doc: unknown }) => [p.slug, p.doc]));
    for (const slug of slugs) expect(bySlug[slug]).toEqual(pageDocSchema.parse(snapshot.pages[slug]));

    const rerun = await importSiteSnapshot(snapshot, { apply: true });
    expect(rerun).toMatchObject({ created: [], publishId: null });
    expect(rerun.skipped).toHaveLength(slugs.length);
  });

  it('rejects the whole import when one page is invalid', async () => {
    const broken = { pages: { ...snapshot.pages, about: { seo: { title: 'x' }, sections: [{ id: 'x', type: 'nope' }] } } };
    await expect(importSiteSnapshot(broken, { apply: true })).rejects.toThrow(/about/);
    expect(await prisma.sitePage.count()).toBe(0);
  });
});

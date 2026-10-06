// Landing-page CMS content (minimal v1).
//
// Key/value store over the `SiteContent` model for the three landing keys:
// `tickerItems`, `heroSlides`, `testimonials`. Reads merge stored rows over
// the code defaults below so a fresh DB returns usable content without any
// seed run (same pattern as src/core/settings.ts). Writes validate against
// the allowlist + per-key shapes (arrays only, caps against abuse).
//
// NOTE: defaults mirror the landing static copy shapes (strings only —
// images stay as landing `/images/*` paths, backend never serves binaries).
// Values below are shape-compatible placeholders; the operator CMS is the
// source of truth once a key is saved.
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/http';

export const SITE_CONTENT_KEYS = ['tickerItems', 'heroSlides', 'testimonials'] as const;
export type SiteContentKey = (typeof SITE_CONTENT_KEYS)[number];

export interface HeroSlide {
  id: string;
  tag: string;
  label: string;
  headline: string;
  sub: string;
  cta: string;
  img: string;
}

export interface Testimonial {
  name: string;
  context: string;
  quote: string;
  stars: number;
  img: string;
}

const MAX_ITEMS = 50;

export const DEFAULT_TICKER_ITEMS: string[] = [
  '24/7 secure access across all StoreLah facilities',
  'From lockers to large units — Bukit Merah · Woodlands · Ubi',
  'CCTV-monitored floors with individual unit alarms',
  'Flexible month-to-month stays, no long lock-in',
  'Book a free viewing in under 60 seconds',
  'Movers and packing supplies available at checkout',
];

export const DEFAULT_HERO_SLIDES: HeroSlide[] = [
  {
    id: 'slide-1',
    tag: 'Self storage',
    label: 'Bukit Merah · Woodlands · Ubi',
    headline: 'Storage that fits your life',
    sub: 'Clean, secure units from lockers to large rooms — from a few dollars a month.',
    cta: 'Get a quote',
    img: '/images/hero-1.jpg',
  },
  {
    id: 'slide-2',
    tag: 'Business storage',
    label: 'For SMEs and e-commerce',
    headline: 'Room for your business to grow',
    sub: 'Store stock, documents and equipment with 24/7 access and flexible terms.',
    cta: 'Explore units',
    img: '/images/hero-2.jpg',
  },
  {
    id: 'slide-3',
    tag: 'Peace of mind',
    label: 'Secure by design',
    headline: 'Secure today, flexible tomorrow',
    sub: 'CCTV, individual alarms and friendly on-site support at every facility.',
    cta: 'Book a viewing',
    img: '/images/hero-3.jpg',
  },
];

export const DEFAULT_TESTIMONIALS: Testimonial[] = [
  {
    name: 'Sarah Lim',
    context: 'Stored with Woodlands · 12 months',
    quote: 'The unit was spotless and access was always smooth. Moving in took less than an hour.',
    stars: 5,
    img: '/images/customer-1.jpg',
  },
  {
    name: 'Marcus Tan',
    context: 'E-commerce seller · Ubi',
    quote: 'We keep all our inventory here. Flexible sizing meant we never paid for space we did not need.',
    stars: 5,
    img: '/images/customer-2.jpg',
  },
  {
    name: 'Priya Nair',
    context: 'Stored with Bukit Merah · 6 months',
    quote: 'Staff helped us pick the right size and the whole booking took minutes. Highly recommended.',
    stars: 4,
    img: '/images/customer-3.jpg',
  },
];

const DEFAULTS: Record<SiteContentKey, unknown[]> = {
  tickerItems: DEFAULT_TICKER_ITEMS,
  heroSlides: DEFAULT_HERO_SLIDES,
  testimonials: DEFAULT_TESTIMONIALS,
};

export function isSiteContentKey(key: string): key is SiteContentKey {
  return (SITE_CONTENT_KEYS as readonly string[]).includes(key);
}

function assertKey(key: string): SiteContentKey {
  if (!isSiteContentKey(key)) {
    throw new AppError(
      404,
      'NOT_FOUND',
      `Unknown site-content key "${key}". Expected one of: ${SITE_CONTENT_KEYS.join(', ')}.`,
    );
  }
  return key;
}

function isNonEmptyString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}

function validateTickerItems(value: unknown): string[] {
  if (!Array.isArray(value)) throw new AppError(400, 'VALIDATION', 'tickerItems must be an array of strings.');
  if (value.length > MAX_ITEMS) {
    throw new AppError(400, 'VALIDATION', `tickerItems must have at most ${MAX_ITEMS} items.`);
  }
  return value.map((item, i) => {
    if (!isNonEmptyString(item, 200)) {
      throw new AppError(400, 'VALIDATION', `tickerItems[${i}] must be a non-empty string of at most 200 characters.`);
    }
    return (item as string).trim();
  });
}

function validateHeroSlides(value: unknown): HeroSlide[] {
  if (!Array.isArray(value)) throw new AppError(400, 'VALIDATION', 'heroSlides must be an array.');
  if (value.length > MAX_ITEMS) {
    throw new AppError(400, 'VALIDATION', `heroSlides must have at most ${MAX_ITEMS} items.`);
  }
  const caps: Record<keyof HeroSlide, number> = {
    id: 80,
    tag: 80,
    label: 120,
    headline: 200,
    sub: 500,
    cta: 80,
    img: 500,
  };
  return value.map((slide, i) => {
    if (typeof slide !== 'object' || slide === null || Array.isArray(slide)) {
      throw new AppError(400, 'VALIDATION', `heroSlides[${i}] must be an object.`);
    }
    const s = slide as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const field of Object.keys(caps) as Array<keyof HeroSlide>) {
      const raw = s[field];
      if (!isNonEmptyString(raw, caps[field])) {
        throw new AppError(
          400,
          'VALIDATION',
          `heroSlides[${i}].${field} must be a non-empty string of at most ${caps[field]} characters.`,
        );
      }
      out[field] = (raw as string).trim();
    }
    return out as unknown as HeroSlide;
  });
}

function validateTestimonials(value: unknown): Testimonial[] {
  if (!Array.isArray(value)) throw new AppError(400, 'VALIDATION', 'testimonials must be an array.');
  if (value.length > MAX_ITEMS) {
    throw new AppError(400, 'VALIDATION', `testimonials must have at most ${MAX_ITEMS} items.`);
  }
  return value.map((t, i) => {
    if (typeof t !== 'object' || t === null || Array.isArray(t)) {
      throw new AppError(400, 'VALIDATION', `testimonials[${i}] must be an object.`);
    }
    const row = t as Record<string, unknown>;
    if (!isNonEmptyString(row.name, 120)) {
      throw new AppError(400, 'VALIDATION', `testimonials[${i}].name must be a non-empty string of at most 120 characters.`);
    }
    if (!isNonEmptyString(row.context, 200)) {
      throw new AppError(400, 'VALIDATION', `testimonials[${i}].context must be a non-empty string of at most 200 characters.`);
    }
    if (!isNonEmptyString(row.quote, 1000)) {
      throw new AppError(400, 'VALIDATION', `testimonials[${i}].quote must be a non-empty string of at most 1000 characters.`);
    }
    if (typeof row.stars !== 'number' || !Number.isInteger(row.stars) || row.stars < 1 || row.stars > 5) {
      throw new AppError(400, 'VALIDATION', `testimonials[${i}].stars must be an integer 1..5.`);
    }
    if (!isNonEmptyString(row.img, 500)) {
      throw new AppError(400, 'VALIDATION', `testimonials[${i}].img must be a non-empty string of at most 500 characters.`);
    }
    return {
      name: (row.name as string).trim(),
      context: (row.context as string).trim(),
      quote: (row.quote as string).trim(),
      stars: row.stars as number,
      img: (row.img as string).trim(),
    };
  });
}

/** Validate + normalise a value for a key (throws 400 VALIDATION on abuse). */
export function validateSiteContentValue(key: SiteContentKey, value: unknown): unknown[] {
  switch (key) {
    case 'tickerItems':
      return validateTickerItems(value);
    case 'heroSlides':
      return validateHeroSlides(value);
    case 'testimonials':
      return validateTestimonials(value);
  }
}

export interface SiteContentEntry {
  key: SiteContentKey;
  value: unknown[];
  updatedAt: string | null;
}

/** Latest updatedAt across stored rows (null on a fresh DB). */
async function latestUpdatedAt(): Promise<string | null> {
  const row = await prisma.siteContent.findFirst({ orderBy: { updatedAt: 'desc' } });
  return row ? row.updatedAt.toISOString() : null;
}

/** All three keys merged over code defaults (fresh DB == landing static copy). */
export async function getSiteContent(): Promise<Record<SiteContentKey, unknown[]>> {
  const rows = await prisma.siteContent.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r.value as unknown]));
  return {
    tickerItems: (byKey.get('tickerItems') as unknown[] | undefined) ?? [...DEFAULTS.tickerItems],
    heroSlides: (byKey.get('heroSlides') as unknown[] | undefined) ?? [...DEFAULTS.heroSlides],
    testimonials: (byKey.get('testimonials') as unknown[] | undefined) ?? [...DEFAULTS.testimonials],
  };
}

/** Values + latest updatedAt (public envelope meta source). */
export async function getSiteContentWithMeta(): Promise<{
  values: Record<SiteContentKey, unknown[]>;
  updatedAt: string | null;
}> {
  const [values, updatedAt] = await Promise.all([getSiteContent(), latestUpdatedAt()]);
  return { values, updatedAt };
}

/** List all three keys as entries (CMS list view). */
export async function listSiteContent(): Promise<SiteContentEntry[]> {
  const rows = await prisma.siteContent.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return SITE_CONTENT_KEYS.map((key) => ({
    key,
    value: ((byKey.get(key)?.value as unknown[] | undefined) ?? [...DEFAULTS[key]]) as unknown[],
    updatedAt: byKey.get(key)?.updatedAt.toISOString() ?? null,
  }));
}

/** Single key read (stored row or default). 404 on unknown key. */
export async function getSiteContentByKey(key: string): Promise<SiteContentEntry> {
  const k = assertKey(key);
  const row = await prisma.siteContent.findUnique({ where: { key: k } });
  return {
    key: k,
    value: ((row?.value as unknown[] | undefined) ?? [...DEFAULTS[k]]) as unknown[],
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** Validate + upsert a key. 404 on unknown key, 400 on invalid value. */
export async function upsertSiteContent(key: string, value: unknown): Promise<SiteContentEntry> {
  const k = assertKey(key);
  const clean = validateSiteContentValue(k, value);
  const row = await prisma.siteContent.upsert({
    where: { key: k },
    update: { value: clean as unknown as object },
    create: { key: k, value: clean as unknown as object },
  });
  return { key: k, value: clean, updatedAt: row.updatedAt.toISOString() };
}

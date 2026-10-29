/**
 * Site-builder page document schema — CANONICAL copy (backend owns it from
 * Phase 1; docs/SITE_BUILDER_PLAN.md §4.2–4.3).
 *
 * Everything below the header is kept byte-identical to the landing renderer's
 * storelah-landing/src/site-builder/schema.ts, so drift shows up in a plain
 * diff. Change both together: adding or changing a section type is a
 * cross-lane contract change (backend schema + landing component + snapshot).
 * GET /api/v1/public/site/schema serves this as JSON Schema for landing CI.
 *
 * Text fields are "rich-lite" strings rendered by landing: `\n` = line break,
 * **bold**, *italic*, [label](href). No raw HTML is ever accepted.
 */

import { z } from "zod";

const text = (max: number) => z.string().max(max);
const rich = (max: number) => z.string().max(max);

/** Internal path, in-page anchor, https, mailto or tel. Nothing else. */
export const hrefSchema = z
  .string()
  .max(500)
  .regex(/^(\/[^\s]*|#[\w-]+|https:\/\/[^\s]+|mailto:[^\s]+|tel:[+\d][\d\s-]*)$/, "Unsupported link");

export const ctaSchema = z.object({
  label: text(80).min(1),
  href: hrefSchema,
  style: z.enum(["primary", "light", "outline", "link"]).default("primary"),
});

export const imageSchema = z.object({
  src: z.string().max(500).regex(/^(\/|https:\/\/)/, "Image must be a site path or https URL"),
  alt: text(200).min(1, "Alt text is required"),
  frame: z.enum(["plain", "feature"]).default("plain"),
});

/** Status pill (.pill); `soon` is the muted variant. */
export const badgeSchema = z.object({
  text: text(40).min(1),
  tone: z.enum(["open", "soon"]).default("open"),
});

/** Heading row above a grid: eyebrow + heading, with a short note OR a link on the right. */
export const headSchema = z.object({
  eyebrow: text(80).optional(),
  heading: rich(200).optional(),
  aside: rich(400).optional(),
  link: ctaSchema.optional(),
});

export const styleSchema = z
  .object({
    bg: z.enum(["paper", "white", "pink", "sage", "terra"]).default("paper"),
    show: z.enum(["all", "hidden"]).default("all"),
    anchor: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,40}$/)
      .optional(),
  })
  .default({ bg: "paper", show: "all" });

export const blockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("eyebrow"), text: text(80).min(1) }),
  z.object({ kind: z.literal("heading"), text: rich(200).min(1), level: z.union([z.literal(2), z.literal(3)]).default(2) }),
  z.object({ kind: z.literal("paragraph"), text: rich(3000).min(1), tone: z.enum(["normal", "fine"]).default("normal") }),
  z.object({ kind: z.literal("list"), style: z.enum(["checklist"]).default("checklist"), items: z.array(rich(300).min(1)).min(1).max(30) }),
  z.object({ kind: z.literal("image"), image: imageSchema }),
  /** Label/value lines (.contact-lines). */
  z.object({
    kind: z.literal("facts"),
    items: z.array(z.object({ label: text(60).min(1), text: rich(300).min(1) })).min(1).max(12),
  }),
  z.object({ kind: z.literal("link"), cta: ctaSchema }),
]);

const textColumn = z.object({
  kind: z.literal("text"),
  badge: badgeSchema.optional(),
  eyebrow: text(80).optional(),
  heading: rich(200).optional(),
  paragraphs: z.array(rich(1500)).max(12).default([]),
  /** Optional checklist after the paragraphs. */
  list: z.array(rich(300).min(1)).max(20).default([]),
  /** Promo-code box with a copy button, shown above the CTAs. */
  promo: z.object({ label: text(40).min(1), code: z.string().regex(/^[A-Za-z0-9-]{1,30}$/, "Code: up to 30 letters, numbers or dashes") }).optional(),
  ctas: z.array(ctaSchema).max(3).default([]),
  /** Small print after the CTAs. */
  note: rich(600).optional(),
});

const imageColumn = z.object({
  kind: z.literal("image"),
  image: imageSchema,
  /** Framed photo with an overlay caption (.photoframe). */
  caption: z.object({ title: text(120).min(1), text: rich(300) }).optional(),
});

const cardColumn = z.object({
  kind: z.literal("card"),
  heading: rich(200),
  paragraphs: z.array(rich(1500)).max(6).default([]),
  ctas: z.array(ctaSchema).max(2).default([]),
});

/** Free-order content (checklists, small print, bare links), optionally boxed. */
const blocksColumn = z.object({
  kind: z.literal("blocks"),
  /** info = .info-box, form = white .form-box card. */
  box: z.enum(["none", "info", "form"]).default("none"),
  blocks: z.array(blockSchema).min(1).max(20),
});

/** Must match REQUESTS in components/site/EnquiryForm.tsx (a client module, so not importable here). */
export const ENQUIRY_REQUESTS = [
  "Storage enquiry",
  "Pre-opening reservation",
  "Viewing request",
  "Current offers",
  "Location updates",
  "General question",
] as const;

/** Code-owned form; only its title and preselected request type are editable. */
const formColumn = z.object({
  kind: z.literal("form"),
  form: z.enum(["enquiry"]),
  title: text(120).min(1),
  request: z.enum(ENQUIRY_REQUESTS).default("Storage enquiry"),
});

export const columnSchema = z.discriminatedUnion("kind", [textColumn, imageColumn, cardColumn, blocksColumn, formColumn]);

const base = {
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  style: styleSchema,
};

export const pageHeroSection = z.object({
  ...base,
  type: z.literal("pageHero"),
  variant: z.enum(["split", "textOnly"]).default("split"),
  props: z.object({
    /** Breadcrumbs between Home and this page (e.g. Locations). */
    parents: z.array(z.object({ href: z.string().regex(/^\/([\w-]+\/)*$/), label: text(80).min(1) })).max(3).default([]),
    crumb: text(80).min(1),
    eyebrow: text(80).optional(),
    heading: rich(200).min(1),
    paragraphs: z.array(rich(1500)).max(4).default([]),
    image: imageSchema.optional(),
  }),
});

export const splitSection = z.object({
  ...base,
  type: z.literal("split"),
  /** split = .split grid; offer = .offer-feature (homepage launch offer). */
  variant: z.enum(["split", "offer"]).default("split"),
  props: z.object({
    /** Vertical alignment of the two columns. */
    align: z.enum(["center", "start"]).default("center"),
    columns: z.tuple([columnSchema, columnSchema]),
  }),
});

export const featureCardsSection = z.object({
  ...base,
  type: z.literal("featureCards"),
  /** numbered = .principles row; info = .info-grid boxes (number optional); supplies = .supplies-grid tiles. */
  variant: z.enum(["numbered", "info", "supplies"]).default("numbered"),
  props: z.object({
    /** section = heading row above the grid; intro = narrow .intro lead-in (with paragraphs). */
    head: z.enum(["section", "intro"]).default("section"),
    eyebrow: text(80).optional(),
    heading: rich(200).optional(),
    paragraphs: z.array(rich(1500)).max(4).default([]),
    items: z
      .array(z.object({ n: text(8).optional(), title: rich(160).min(1), text: rich(800) }))
      .min(1)
      .max(12),
    /** Link on the right of the heading row (head: section). */
    headLink: ctaSchema.optional(),
    /** Small print under the grid. */
    note: rich(600).optional(),
  }),
});

export const faqSearchSection = z.object({
  ...base,
  type: z.literal("faqSearch"),
  props: z.object({
    searchLabel: text(80).default("Search questions"),
    placeholder: text(120).default(""),
    emptyText: text(300).default("No matching questions."),
    items: z
      .array(z.object({ q: text(300).min(1), a: text(3000).min(1), cat: text(60).default("") }))
      .min(1)
      .max(100),
  }),
});

/** Long-form copy column (privacy, terms, guides); intro = narrow .intro lead-in. */
export const articleSection = z.object({
  ...base,
  type: z.literal("article"),
  variant: z.enum(["article", "intro"]).default("article"),
  props: z.object({
    blocks: z.array(blockSchema).min(1).max(80),
  }),
});

/** Grid of image cards linking elsewhere (guides index). */
export const cardGridSection = z.object({
  ...base,
  type: z.literal("cardGrid"),
  props: z.object({
    head: headSchema.optional(),
    items: z
      .array(
        z.object({
          image: imageSchema.optional(),
          badge: badgeSchema.optional(),
          eyebrow: text(80).optional(),
          title: rich(160).min(1),
          text: rich(600).optional(),
          cta: ctaSchema.optional(),
        })
      )
      .min(1)
      .max(12),
  }),
});

const slideSchema = z.object({
  /** Element id; `hero-launch` carries the first slide's CSS treatment. */
  key: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  /** Screen-reader name; "1 of 3: " is added automatically. */
  label: text(120).min(1),
  image: imageSchema,
  eyebrow: text(80).min(1),
  heading: rich(200).min(1),
  text: rich(400).min(1),
  ctas: z.array(ctaSchema).max(2).default([]),
  note: text(200).optional(),
});

/** Homepage hero carousel. Autoplay/pause/swipe behaviour is code-owned; slide copy is editable. */
export const heroCarouselSection = z.object({
  ...base,
  type: z.literal("heroCarousel"),
  props: z.object({
    label: text(80).default("Discover StoreLah"),
    slides: z.array(slideSchema).min(1).max(5),
  }),
}).refine(s => new Set(s.props.slides.map(x => x.key)).size === s.props.slides.length, {
  message: "Slide keys must be unique",
  path: ["props", "slides"],
});

/** Size finder (code-owned form, reads unit data) plus a row of short facts. */
export const bookingFinderSection = z.object({
  ...base,
  type: z.literal("bookingFinder"),
  props: z.object({
    facts: z.array(z.object({ title: text(80).min(1), text: text(160) })).max(6).default([]),
  }),
});

/** Size cards (code-owned, reads unit data) under an editable heading row and CTAs. */
export const sizeShowcaseSection = z.object({
  ...base,
  type: z.literal("sizeShowcase"),
  props: z.object({
    head: headSchema.default({}),
    ctas: z.array(ctaSchema).max(3).default([]),
  }),
});

/** Homepage teaser for the size calculator, with preset example links. */
export const calculatorTeaserSection = z.object({
  ...base,
  type: z.literal("calculatorTeaser"),
  props: z.object({
    eyebrow: text(80).optional(),
    heading: rich(200).min(1),
    paragraphs: z.array(rich(800)).max(3).default([]),
    cta: ctaSchema.optional(),
    examples: z.array(z.object({ label: text(60).min(1), href: hrefSchema })).max(6).default([]),
    image: imageSchema,
    caption: text(120).optional(),
  }),
});

/** Numbered booking steps beside the code-owned booking illustration. */
export const bookingJourneySection = z.object({
  ...base,
  type: z.literal("bookingJourney"),
  props: z.object({
    head: headSchema.default({}),
    steps: z
      .array(z.object({ n: text(8).min(1), title: rich(160).min(1), text: rich(500) }))
      .min(1)
      .max(8),
    cta: ctaSchema.optional(),
  }),
});

/** Location promo: copy column with status pill, beside a photo card. */
export const locationFeatureSection = z.object({
  ...base,
  type: z.literal("locationFeature"),
  props: z.object({
    eyebrow: text(80).optional(),
    heading: rich(200).min(1),
    intro: rich(800).optional(),
    badge: badgeSchema.optional(),
    text: rich(800).optional(),
    ctas: z.array(ctaSchema).max(3).default([]),
    note: rich(600).optional(),
    card: z.object({ image: imageSchema, title: text(120).min(1), text: text(200), link: ctaSchema.optional() }),
  }),
});

/** A few FAQs beside a link to the full list. */
export const faqTeaserSection = z.object({
  ...base,
  type: z.literal("faqTeaser"),
  props: z.object({
    eyebrow: text(80).optional(),
    heading: rich(200).min(1),
    text: rich(800).optional(),
    link: ctaSchema.optional(),
    items: z
      .array(z.object({ q: text(300).min(1), a: text(3000).min(1), cat: text(60).default("") }))
      .min(1)
      .max(8),
  }),
});

/** One large image beside a stack of two. */
export const gallerySection = z.object({
  ...base,
  type: z.literal("gallery"),
  props: z.object({
    eyebrow: text(80).optional(),
    heading: rich(200).optional(),
    /** Short note on the right of the heading row. */
    aside: rich(400).optional(),
    images: z.tuple([imageSchema, imageSchema, imageSchema]),
  }),
});

/** The interactive size estimator page; only the heading copy is editable. */
export const sizeCalculatorSection = z.object({
  ...base,
  type: z.literal("sizeCalculator"),
  props: z.object({
    crumb: text(80).min(1),
    eyebrow: text(80).optional(),
    heading: rich(200).min(1),
    paragraphs: z.array(rich(800)).max(3).default([]),
  }),
});

/** Side-by-side comparison; the first column is the row label. */
export const comparisonTableSection = z.object({
  ...base,
  type: z.literal("comparisonTable"),
  props: z.object({
    heading: rich(200).optional(),
    /** Header row, including the row-label column. */
    columns: z.array(text(80).min(1)).min(2).max(5),
    rows: z
      .array(z.object({ label: rich(160).min(1), cells: z.array(rich(400)).min(1).max(4) }))
      .min(1)
      .max(20),
    note: rich(600).optional(),
  }),
}).refine(s => s.props.rows.every(r => r.cells.length === s.props.columns.length - 1), {
  message: "Each row needs one cell per non-label column",
  path: ["props", "rows"],
});

/** Code-owned interactive component; only its placement is editable. */
export const widgetSection = z.object({
  ...base,
  type: z.literal("widget"),
  props: z.object({
    /** reservationSelection = empty hidden placeholder kept from the reference site (reserve). */
    widget: z.enum(["sizeFilter", "reservationSelection"]),
  }),
});

export const ctaBandSection = z.object({
  ...base,
  type: z.literal("ctaBand"),
  props: z.object({
    title: text(160).optional(),
    text: text(400).optional(),
  }),
});

export const sectionSchema = z.discriminatedUnion("type", [
  heroCarouselSection,
  bookingFinderSection,
  sizeShowcaseSection,
  calculatorTeaserSection,
  bookingJourneySection,
  locationFeatureSection,
  faqTeaserSection,
  pageHeroSection,
  splitSection,
  featureCardsSection,
  faqSearchSection,
  articleSection,
  cardGridSection,
  comparisonTableSection,
  gallerySection,
  sizeCalculatorSection,
  widgetSection,
  ctaBandSection,
]);

export const pageDocSchema = z.object({
  seo: z.object({
    title: text(120).min(1),
    description: text(320).default(""),
    noindex: z.boolean().default(false),
  }),
  /** Header nav item to highlight; defaults to the page path (guides → "/guides/"). */
  nav: z.object({ current: z.string().regex(/^\/([\w-]+\/)*$/).optional() }).default({}),
  sections: z.array(sectionSchema).max(60),
});

export type Cta = z.infer<typeof ctaSchema>;
export type Badge = z.infer<typeof badgeSchema>;
export type SiteImage = z.infer<typeof imageSchema>;
export type Block = z.infer<typeof blockSchema>;
export type Column = z.infer<typeof columnSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type SectionType = Section["type"];
export type PageDoc = z.infer<typeof pageDocSchema>;

/** Parse one page document; returns null (never throws) when invalid. */
export function parsePageDoc(raw: unknown): PageDoc | null {
  const r = pageDocSchema.safeParse(raw);
  return r.success ? r.data : null;
}

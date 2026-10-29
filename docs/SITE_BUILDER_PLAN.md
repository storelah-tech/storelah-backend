# Site Builder ("mini Wix") — CMS ↔ landing plan

Status: **PLAN — not started.** Drafted 2026-10-29 (orchestrator). Cross-cutting:
backend (API + CMS UI), landing (renderer + build), devops (S3, CI trigger).
Contracts in §4 must be agreed by all three lanes before any code lands.

Goal: operators edit storelah.sg **content and layout** in the CMS: text,
images, section order, section variants and backgrounds, nav/footer, SEO, and
new pages. They see a live preview, publish with one click, and can roll back.
storelah.sg stays a fully static export on CloudFront (standing rule).

---

## 1. Where we are today (verified 2026-10-29)

| Piece | State |
| --- | --- |
| `SiteContent` (v1, key/value: ticker, heroSlides, testimonials) | Live on prod (`GET /api/v1/public/site-content`). Admin sidebar entry removed 2026-10-07. |
| `ContentItem` (v2, typed items + image upload, drafts) | Live on prod, editable in **Content Management** (`contentView.js`). |
| Landing consumption | **None.** The Oct-8 IA rework (`ac1fd44`) replaced the homepage. `src/components/Home.tsx` (the only `useSiteContent()` caller) is now orphaned. All 22 routes are hard-coded JSX in `src/app/**/page.tsx` plus arrays in `src/lib/site.ts` / `src/data/site.ts`. |
| Landing CI | `landing-deploy.yaml` runs on push to `main` and `workflow_dispatch`, then builds, syncs S3 and invalidates CloudFront. The build does **not** pass `NEXT_PUBLIC_API_URL`. |
| Image storage | `CONTENT_S3_BUCKET` is not provisioned, so uploads use the local fallback. **That is ephemeral on Lambda**, so prod uploads are effectively broken. |
| Styling | One hand-written design system in `globals.css` (3.5k lines). Brand tokens are `--terra/--paper/--ink/--sage/--line…`. Sections are `.section.{white,pink,sage,terra}`, `.split`, `.container`. This is a good base for a block library. |

Summary: we have two half-used content stores and a landing site that reads
neither. The plan replaces both with one page-document model. It does not
build a third store next to them.

## 2. Scope: what "mini Wix" means here

**In scope**
- Edit any text and image on any landing page.
- **Layout:** add, remove, reorder and duplicate sections from a block
  library. For each section, choose a variant (e.g. image left/right, 2/3/4
  columns, carousel/grid), a background from the brand palette, a spacing
  preset (compact/normal/roomy), alignment, and visibility (all / desktop
  only / mobile only / hidden).
- Global settings: header nav, footer, announcement ticker, contact details,
  launch/promo code, CTA band defaults.
- Pages: create, duplicate and unpublish pages; set the slug; SEO title,
  description and OG image; sitemap; redirects.
- Draft → live preview (desktop/tablet/mobile) → publish → version history →
  rollback.
- Media library with alt text (required) and automatic resizing.

**Out of scope (on purpose)**
- Free-form pixel drag/absolute positioning, custom CSS/HTML/JS, arbitrary
  fonts or colours. These break responsiveness, the brand system,
  accessibility and the static/CSP posture. "Layout" means picking from
  **designed, responsive options**. This is the Wix-ADI/Squarespace model, not
  the Wix-Editor canvas model.
- Live unit data or pricing from the DB on the landing site (standing rule).
  Prices and sizes stay editable *copy*.
- Booking app (`app.storelah.sg`) content. It mirrors the v13 reference and is
  a separate lane.

## 3. Architecture

```
 CMS (cms.storelah.sg, vanilla-JS admin)            Landing (storelah.sg, static)
 ┌──────────────────────────────────────┐          ┌───────────────────────────────┐
 │ Pages ▸ Outline ▸ Properties form    │ postMsg  │ /__preview/  (client-only,    │
 │        ┌──────────────────────┐      │ ───────► │  noindex) renders draft JSON  │
 │        │ iframe preview       │◄─────┼───────── │  with the SAME section        │
 │        └──────────────────────┘      │ select   │  components as prod pages     │
 │ [Save draft] [Publish]               │          └───────────────────────────────┘
 └──────────────┬───────────────────────┘                         ▲
                │ /api/v1/cms/site/*                              │ build-time fetch
                ▼                                                 │ GET /api/v1/public/site/bundle
 Backend (Lambda, Express + Prisma, Neon)                         │
   SitePage / SitePageVersion / SiteSettings / MediaAsset ────────┘
   publish ─► GitHub workflow_dispatch (storelah-landing) ─► build ─► S3 + CloudFront
            ◄─ deploy status (GitHub API poll / workflow callback)
```

Key choices:

1. **Page = ordered list of typed sections (JSON document).** Each section is
   `{ id, type, variant, props, style }`. The landing has a **section
   registry** that maps `type` → React component. Pages become a thin
   `<PageRenderer doc={…} />`.
2. **Static, rebuilt on publish.** Publishing marks a version live and
   triggers the existing landing workflow (`workflow_dispatch` is already
   enabled). Content is live about 2–4 minutes later. No ISR/SSR, no
   runtime fetch on public pages, no flicker, and SEO is intact.
3. **Instant preview without a rebuild.** The landing ships one extra
   client-only route `/__preview/`. The CMS loads it in an iframe and sends
   the unsaved draft JSON via `postMessage` (strict origin allow-list). The
   preview renders the same components, so preview equals prod. Clicking a
   section in the preview posts its `id` back and selects it in the editor.
4. **Never break the deploy.** If the build can't reach the backend, it uses
   `content/snapshot.json`, the last published bundle committed in the
   landing repo. CI fails loudly only if neither is available. The snapshot
   is refreshed by a step in the dispatch run (or by a dev pulling it).
5. **One source of truth for section schemas: the backend**
   (`src/core/site/sections.ts`, zod). It validates every write and is
   exposed as JSON Schema at `GET /api/v1/public/site/schema`. The CMS builds
   its property forms from it. Landing CI runs a contract test: every schema
   type has a registered component, and every fixture renders.

### Rejected alternatives
- *Runtime client fetch* (what v1 `useSiteContent` did): content flashes in,
  search engines see fallback copy, and every page view hits the backend.
- *SSR/ISR on Amplify for landing:* breaks the "static marketing"
  rule, adds a server to keep up, and the Basic-Auth/CloudFront setup would
  have to be redone.
- *Headless SaaS (Builder.io / Storyblok / Sanity):* fastest to a good editor,
  but it adds a vendor, monthly cost, a second login outside CMS RBAC, and
  content outside Neon. Worth reconsidering only if §5 Phase 3 slips badly.

## 4. Contracts (agree before coding)

### 4.1 Data model (backend, additive migration `site_builder`)

```prisma
model SitePage {
  id          String   @id @default(cuid())
  slug        String   @unique          // "/" , "about", "guides/packing"
  title       String                    // CMS label
  status      SitePageStatus            // DRAFT | PUBLISHED | ARCHIVED
  system      Boolean  @default(false)  // core routes: slug locked, can't delete
  draft       Json                      // working doc (autosaved)
  draftRev    Int      @default(0)      // optimistic lock → 409 on stale save
  liveVersionId String?
  versions    SitePageVersion[]
  updatedById String?
  updatedAt   DateTime @updatedAt
  createdAt   DateTime @default(now())
}

model SitePageVersion {               // immutable snapshots; rollback = copy into draft + publish
  id        String   @id @default(cuid())
  pageId    String
  page      SitePage @relation(fields: [pageId], references: [id])
  number    Int
  doc       Json
  note      String?
  createdById String?
  createdAt DateTime @default(now())
  @@unique([pageId, number])
}

model SiteSettings {                  // single row "global": nav, footer, ticker, contact, theme, redirects
  id        String @id                // "global"
  draft     Json
  live      Json
  draftRev  Int    @default(0)
  updatedAt DateTime @updatedAt
}

model MediaAsset {
  id        String @id @default(cuid())
  key       String @unique            // S3 key
  url       String                    // public CDN URL
  variants  Json                      // { "600": url, "1200": url, "2400": url }
  width     Int
  height    Int
  alt       String
  tags      String[]
  createdAt DateTime @default(now())
}

model SitePublish {                   // audit + deploy tracking
  id        String @id @default(cuid())
  scope     Json                      // pages/settings versions included
  status    String                    // QUEUED | BUILDING | LIVE | FAILED
  runUrl    String?
  createdById String?
  createdAt DateTime @default(now())
  finishedAt DateTime?
}
```

### 4.2 Page document shape

```jsonc
{
  "seo": { "title": "…", "description": "…", "ogImage": "media:<id>", "noindex": false },
  "sections": [
    {
      "id": "s_8f2k",              // stable, used for preview selection + analytics anchors
      "type": "splitHero",         // registry key
      "variant": "imageRight",     // enum per type
      "style": { "bg": "paper|white|pink|sage|terra", "space": "compact|normal|roomy",
                 "align": "left|center", "show": "all|desktop|mobile|hidden",
                 "anchor": "renovation" },
      "props": { "eyebrow": "ABOUT US", "heading": "Small enough to care.\nBuilt to do it properly.",
                 "body": "…", "image": { "media": "<id>", "alt": "…" },
                 "ctas": [{ "label": "Book your space", "href": "/reserve/", "style": "primary" }] }
    }
  ]
}
```

- **Rich text** = a restricted markdown subset (bold, italic, link, line
  break, bullet list), rendered by a small landing renderer. No raw HTML is
  stored, so there is no XSS surface.
- **Links**: internal slug picker, `booking:` tokens resolved at build to
  `BOOKING_URL` routes (so landing→booking links stay env-driven), and
  `https://` external links with `rel` added automatically.
- **Images**: referenced by `media:<id>`. The bundle endpoint expands them
  to `{ src, srcset, width, height, alt }`.

### 4.3 Section library v1 (derived from the current 22 routes)

| Type | Variants | Replaces |
| --- | --- | --- |
| `heroCarousel` | – (slides[]) | `HeroCarousel` |
| `pageHero` | split image L/R, text-only | page heroes on every inner page + `Breadcrumb` (auto) |
| `splitContent` | image L/R, text/text | "WHY WE'RE HERE" type blocks |
| `featureCards` | 2/3/4 cols, numbered, icon, image | `VALUES`, `USES`, pricing features |
| `stepsList` | horizontal / vertical | how-it-works |
| `faq` | accordion, 2-col | `FAQS` (+ FAQPage JSON-LD) |
| `testimonials` | grid / rail | testimonials |
| `ctaBand` | terra / sage / light | `CtaBand` |
| `richText` | narrow / wide | privacy, terms, guides |
| `imageGallery` | grid / strip | storage ideas |
| `pricingTable` | – (editable rows) | sizes-pricing table copy |
| `locationCard` | – | locations/sembawang |
| `promoCode` | – | `CopyCodeButton` launch code |
| **widgets** (props-light, code-owned behaviour) | | |
| `sizeEstimator` | – | `SizeEstimator` (1.4k lines, headings/copy only) |
| `unitFinder` | – | `FinderForm` |
| `sizeShowcase` | – | `SizeShowcase` |
| `enquiryForm` | – | `EnquiryForm` |
| `helpWidget` | global toggle | `HelpWidget` |

Adding a new section type is a **dev task**: backend schema, landing component
and fixture together. Operators only compose the existing ones.

### 4.4 API

CMS (`/api/v1/cms`, JWT; add every route to `src/lib/routePermissions.ts`):

| Route | Permission |
| --- | --- |
| `GET /site/pages`, `GET /site/pages/:id`, `GET /site/pages/:id/versions` | `site-builder:view` |
| `POST /site/pages`, `PUT /site/pages/:id/draft` (body `{ doc, rev }` → 409 if stale), `POST /site/pages/:id/duplicate`, `DELETE /site/pages/:id` (non-system) | `site-builder:edit` |
| `GET/PUT /site/settings/draft` | `site-builder:edit` |
| `POST /site/media` (upload), `PUT/DELETE /site/media/:id`, `GET /site/media` | `site-builder:edit` |
| `POST /site/publish` (`{ pageIds?, settings?, note }`), `POST /site/pages/:id/rollback/:versionId`, `GET /site/publishes` | `site-builder:publish` |
| `GET /site/schema` | `site-builder:view` |

Public (`/api/v1/public`, no auth, PII-free, cache-friendly):
- `GET /site/bundle` returns `{ settings, pages: [{ slug, doc }], media, publishedAt }`.
  It is **live versions only** and is the only thing the build reads.
- `GET /site/schema` returns JSON Schema for landing CI.

Publish is separate from edit, so the owner can let marketing draft while
only certain roles go live. The Owner role gets all three by default.

### 4.5 Env / secrets (names only; values are owner/devops-held)
- Landing CI: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_API_PREFIX` (build-time
  only now), and a `SITE_BUNDLE_URL` override.
- Backend Lambda: `LANDING_DISPATCH_TOKEN` (fine-grained GitHub token,
  `actions:write` on `storelah-landing` only), `LANDING_DISPATCH_REPO`,
  `LANDING_PREVIEW_ORIGIN`. Set with `update-function-configuration` that
  **merges** with existing env (see the drift note in CLAUDE.md). Never a
  CloudFormation deploy.
- Media: `CONTENT_S3_*` (already defined in `CONTENT_MANAGEMENT.md`) plus a
  CloudFront/OAC public base.

## 5. Phases

Each phase ends deployable. Lane in brackets.

### Phase 0: Prerequisites (≈2–3 days)

> **Status 2026-10-29: repo work done, prod steps pending.** Branch
> `feature/site-builder-phase0` in both backend and landing (cut from `main`,
> because `develop` is behind `main` in both repos). Done: `infra/media-stack.yaml`,
> runbook `backend-deploy.md` › "CMS MEDIA BUCKET + SITE-BUILDER PUBLISH
> TRIGGER", landing workflow env + `publishId` input, and the dead pre-Oct-8
> tree deleted (9 files). Pending: stack deploy + Lambda env merge (owner
> go-ahead, AWS re-login), GitHub token (owner), Q1 preview hosting.
>
1. [devops] Provision the media S3 bucket + CloudFront (OAC), grant the
   Lambda role `s3:PutObject/DeleteObject` on the prefix, and set
   `CONTENT_S3_*`. *This fixes today's broken prod uploads, so do it
   regardless of the rest of the plan.*
2. [devops] Create the GitHub dispatch token. Add `NEXT_PUBLIC_API_URL/PREFIX`
   to the landing workflow.
3. [owner decision] Preview hosting. See §7, Q1.
4. [landing] Delete orphaned `Home.tsx` + `src/lib/siteContent.ts` and the
   dead `src/data/site.ts` exports (after a grep confirms no use).

### Phase 1: Backend model, validation, API (≈1 week) [backend]
- Migration `site_builder`, zod section registry, the routes in §4.4,
  permissions + seed into the default role matrix, OpenAPI.
- Media upload: the **browser resizes** to 600/1200/2400 webp before
  upload. This keeps `sharp` out of Lambda. The server checks type, size
  and dimensions.
- `scripts/site-import.ts`: imports the *current* landing copy (from a JSON
  export the landing lane produces in Phase 2) as v1 of every page, so the
  first CMS-driven build is identical.
- Tests: validation for each section type, optimistic-lock 409, the
  publish-version rules, and a public bundle that excludes drafts.

### Phase 2: Landing renderer (≈1.5 weeks) [landing]
- `src/sections/<type>/{Component.tsx, fixture.json}`, `registry.ts`,
  `PageRenderer`, markdown-lite renderer, image component (srcset).
- `lib/bundle.ts`: build-time fetch, then `content/snapshot.json` fallback,
  with typed parse.
- Routing: keep the core route files, but each becomes
  `<PageRenderer slug="about" />`. Add `src/app/[...slug]/page.tsx` with
  `generateStaticParams()` from the bundle for operator-created pages.
  Generate `sitemap.xml` + redirects (CloudFront function map, or meta-refresh
  stubs).
- `/__preview/`: client-only, `noindex`, origin-checked `postMessage`, and a
  click-to-select overlay.
- Migrate the homepage, then about, how-it-works and faqs. **Gate: a
  Playwright screenshot diff against current prod shows ≈0 change.**
- Contract test against `/site/schema`.

### Phase 3: CMS builder UI (≈2 weeks) [backend: `src/cms/admin/siteBuilderView.js` + modules]
Layout: **Pages list | Section outline (drag to reorder) | Preview iframe
(desktop/tablet/mobile toggle) | Properties panel**.
- Properties forms are generated from the JSON Schema: text, markdown-lite,
  image picker (media library modal), link picker, enum chips for
  variant/bg/spacing, and repeatable lists (slides, cards, FAQs).
- "Add section" gallery with thumbnails, plus duplicate, hide and delete
  (with confirm via `confirmDialog`).
- Autosave the draft every few seconds or on blur, with `rev` conflict
  handling ("someone else edited, reload?"). Undo/redo in memory.
- Page settings drawer: slug, SEO, OG preview, noindex.
- Global settings editor: nav, footer, ticker, contact, promo code.
- Reuses the frozen v8 theme classes and patterns (`extrasView.js`,
  `contentView.js`).

### Phase 4: Publish pipeline + history (≈1 week) [backend + devops]
- `POST /site/publish` snapshots the versions, writes `SitePublish`, and
  calls `workflow_dispatch` (input `publishId`). The workflow's existing
  `cancel-in-progress` collapses rapid publishes. The build always takes the
  *latest* live bundle, so no publish is lost.
- Status: the backend polls the GitHub run (or the workflow POSTs a signed
  callback at the end). The CMS shows *Queued → Building → Live ✓ / Failed*
  with the run link. On failure, the old site stays up untouched.
- Version list per page with diff summary (sections added, removed, changed),
  "restore to draft" and "rollback & publish".
- Workflow step: commit the refreshed `content/snapshot.json` to a
  `content-snapshot` branch, or upload it as an artifact. See §7, Q3.

### Phase 5: Migrate the remaining 18 routes + global shell (≈1.5 weeks) [landing, then backend import]
- Header/Footer/HelpWidget read `settings`. Inner pages are converted in
  batches of about 5, each with a screenshot gate.
- `SizeEstimator`, `FinderForm` and the pricing filter stay code-owned
  widgets with editable headings and copy.
- Retire `SiteContent` + `ContentItem` routes. Their public endpoints return
  410 after one release, and their data moves into `MediaAsset` and section
  props by a one-off migration script.

### Phase 6: Nice-to-haves (backlog)
Inline text editing in the preview (contenteditable via postMessage),
scheduled publish, page templates ("Location page", "Guide"), reusable
"global sections" (e.g. one CTA band used on many pages), per-section
analytics anchors, multi-language (EN/中文), and a link checker on publish.

**Rough total: 7–9 working weeks** for Phases 0–5 with one engineer per lane.
Phases 1 and 2 can run in parallel once §4 is signed off.

## 6. Quality gates & testing
- Backend: vitest for schemas, permissions (every new route in
  `routePermissions.ts`, as the existing RBAC test enforces), the publish
  state machine, and a bundle with no drafts and no PII.
- Landing: `pnpm check`, fixture render test for every section type,
  contract test against the schema, Playwright visual diff per migrated page
  (prod baseline), Lighthouse/a11y budget (alt text required, heading order
  lint: one `h1` per page, enforced in the CMS before publish).
- Staging run of the whole loop before prod: edit → preview → publish →
  workflow → CloudFront → verify.
- Prod rollout follows the standing order: migrate Neon first, then the
  Lambda code update, then the landing deploy. Each prod step needs explicit
  owner authorization.

## 7. Open decisions for the owner
1. **Preview hosting vs the Basic-Auth gate.** `storelah.sg/__preview/`
   inside a `cms.storelah.sg` iframe will hit the landing Basic-Auth prompt
   while the gate is on. Options: (a) accept the prompt once per browser
   session; (b) a separate `preview.storelah.sg` behind the CMS gate,
   serving the same build; (c) serve the landing's preview bundle from the
   backend under `cms.storelah.sg/preview/`. *Recommendation: (b).* Gates
   stay owner-managed. Devops will not change them.
2. **Who may publish?** Default: Owner + a new "Marketing publisher" role.
   Editors can only draft.
3. **Snapshot storage:** commit it to the repo (auditable, but adds bot
   commits) or keep it as a CI artifact only. *Recommendation: a
   `content-snapshot` branch.*
4. **Is a 2–4 min publish latency acceptable?** If "instant" is required,
   the only real option is a runtime-fetched layer, which we rejected for
   SEO. A good fit for a small, rarely changing element like the ticker.
5. **Divergence from reference v12:** once operators own the content, the
   landing site no longer tracks the v12 reference copy. Confirm that
   "reference parity" ends for landing at Phase 5.

## 8. Risks
- **Visual regressions during migration.** Mitigated by screenshot gates and
  by importing the current copy as v1.
- **Operators breaking layout** with very long text or missing images.
  Mitigated by schema length caps, required alt text, list min/max counts,
  and preview at all three breakpoints before publish.
- **Lambda env drift** when adding the dispatch secret. Mitigated by a
  merge-only env update procedure in `backend-deploy.md`.
- **GitHub token compromise.** Mitigated by a fine-grained token with only
  `actions:write` on the one repo, held in Lambda env, and rotated.
- **CMS bundle size** (vanilla JS, no build step) for drag/drop + schema
  forms. Use native HTML5 drag-and-drop and keep it modular, with no
  framework.

# Content Management (landing images + texts)

Mini-WordPress for the landing website: hero banner images, testimonials, and
any landing copy — managed in the operator CMS, consumed by the landing site
at **build time**. Backend-only surface; the landing repo is never touched
from here.

## Data model

`ContentItem` (additive table, migration `20261009000000_add_content_items`):

| Column     | Type                                | Notes                                                        |
| ---------- | ----------------------------------- | ------------------------------------------------------------ |
| `id`       | cuid                                | internal row id                                              |
| `key`      | unique slug                         | operator-chosen, e.g. `hero-banner-1`; **immutable**         |
| `type`     | `HERO_IMAGE \| TESTIMONIAL \| TEXT \| IMAGE` | Prisma enum; **immutable** (delete + recreate to retype) |
| `title`    | text?                               | heading (all types), ≤ 200 chars                             |
| `body`     | text?                               | landing copy; the **quote** for `TESTIMONIAL`, ≤ 5000 chars  |
| `author`   | text?                               | testimonial author, required for `TESTIMONIAL`, ≤ 120 chars  |
| `role`     | text?                               | testimonial context, e.g. `Stored with Woodlands · 12 months` |
| `imageKey` | text?                               | S3 object key, or `local/<file>` for the local fallback      |
| `imageUrl` | text?                               | public URL (S3 public base, or `/uploads/…` path locally)    |
| `alt`      | text?                               | image alt text, ≤ 200 chars                                  |
| `sortOrder`| int                                 | ascending display order within a type                        |
| `published`| bool                                | `false` = CMS draft, hidden from every public read           |

No PII columns exist on this table by design (no emails/phones), so the
public read surface is PII-free.

## API contract

Envelope on every JSON route: success `{ data, meta? }`, errors
`{ error: { code, message, details? } }`. CMS routes need
`Authorization: Bearer <JWT>` (from `POST /api/v1/cms/login`).

CMS (`/api/v1/cms`, `requireAuth`):

- `GET /content?type=&published=` — list all ( drafts included).
  `published=1|true` / `0|false` filter; garbage → `400 VALIDATION`.
- `POST /content` — create (`{ key, type, title?, body?, author?, role?, alt?, imageUrl?, sortOrder?, published? }`).
  `TESTIMONIAL` requires `body` + `author`. `201`.
- `GET /content/:key` — single item (draft or published).
- `PUT /content/:key` — partial update (key/type immutable; changing type
  is `400` — delete + recreate instead).
- `DELETE /content/:key` — hard delete; the stored image is removed
  best-effort (never fails the delete).
- `POST /content/:key/image` — upload/replace image. JSON body
  `{ filename, contentType, dataBase64 }` (png/jpeg/webp/gif, ≤ 8 MB by
  default). Route-scoped 12 MB JSON limit; the global `express.json()`
  limit is untouched. Returns the item plus `storage: "s3" | "local"`.
- `DELETE /content/:key/image` — remove image (clears `imageKey`/`imageUrl`,
  deletes the stored object best-effort).

Public (`/api/v1/public`, no auth):

- `GET /content?type=` — **published only**, `sortOrder` ascending,
  `meta: { count }`.
- `GET /content/:key` — single **published** item (drafts 404).
- `GET /content/:key/image` — image bytes: streams the file in local mode,
  `302` to the S3 public URL in S3 mode, `404` for drafts/imageless items.

## S3 env contract (devops)

Bucket creation is **out of scope** for this change — the backend works
today via the local fallback. When devops provisions the bucket, set:

| Var                          | Default                                              |
| ---------------------------- | ---------------------------------------------------- |
| `CONTENT_S3_BUCKET`          | *(unset = local fallback)*                           |
| `CONTENT_S3_REGION`          | `ap-southeast-1`                                     |
| `CONTENT_S3_PUBLIC_BASE_URL` | `https://<bucket>.s3.<region>.amazonaws.com`         |
| `CONTENT_S3_PREFIX`          | `content`                                            |
| `CONTENT_LOCAL_DIR`          | `<cwd>/uploads/content` (local fallback only)        |
| `CONTENT_IMAGE_MAX_BYTES`    | `8388608` (8 MiB)                                    |

Bucket expectations for later devops:

- Object key layout: `<prefix>/<slug>/<timestamp>-<name>.<ext>`.
- Auth: default AWS credential chain (Lambda execution role in prod —
  no keys in code; explicit `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
  for local dev only, same as SES).
- Upload path is a direct server-side `PutObject` with `ContentType`
  (single consistent path — no presigned URLs). The role needs
  `s3:PutObject` + `s3:DeleteObject` on `<bucket>/<prefix>/*`.
- Public reads go to `<PUBLIC_BASE_URL>/<key>`, so the bucket (or a CDN
  in front of it) must serve `GET` publicly — bucket policy or
  CloudFront OAC at devops' discretion. The backend never sets ACLs.
- Lambda note: local fallback files are ephemeral on Lambda — treat S3
  as required in deployed envs; local mode is for dev only.

## Landing build-time consumption note (for the later landing change)

- At build time, fetch `GET {backend}/api/v1/public/content` (optionally
  `?type=HERO_IMAGE`), bake the snapshot into static pages. Rebuild to
  pick up newly published items; drafts never appear.
- `imageUrl` is absolute in S3 mode. In local-dev mode it is a path
  (`/uploads/content/<file>`) — prefix the backend origin. The same
  bytes are also at `GET /api/v1/public/content/:key/image`.
- Suggested slot mapping (landing-owned): `HERO_IMAGE` sorted by
  `sortOrder` → hero carousel; `TESTIMONIAL` → testimonial rail
  (`body` = quote, `author`, `role` = context line); `TEXT` by `key` →
  named copy blocks.
- This repo's legacy `SiteContent` ticker/hero/testimonial key/value
  store is untouched; Content Management is its successor for
  image-bearing slots. Do not dual-write — migrate landing slots over
  when the landing build change lands.

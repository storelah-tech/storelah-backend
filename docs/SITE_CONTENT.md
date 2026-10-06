# Site Content (landing-page CMS, minimal v1)

Admin-editable landing copy. Backend stores strings only (images stay as
landing `/images/*` paths); the landing page fetches via the public API.

## Keys and shapes

- `tickerItems`: `string[]` — one ticker line per string (max 50, 200 chars each).
- `heroSlides`: `{ id, tag, label, headline, sub, cta, img }[]` — max 50 slides;
  each field a non-empty string (id/tag/cta ≤ 80, label ≤ 120, headline ≤ 200,
  sub ≤ 500, img ≤ 500).
- `testimonials`: `{ name, context, quote, stars, img }[]` — max 50; stars is
  an integer 1–5; caps: name ≤ 120, context ≤ 200, quote ≤ 1000, img ≤ 500.

Reads merge stored rows over code defaults in `src/core/siteContent.ts`, so a
fresh DB returns usable content without any seed run. FAQ/pricing/locations
are out of scope for v1.

## Endpoint contracts (envelope `{ data, meta }` / `{ error }`)

- `GET /api/v1/public/site-content` — NO auth. Returns
  `{ tickerItems, heroSlides, testimonials }` with `meta: { updatedAt }`
  (latest row timestamp, `null` on a fresh DB). No PII.
- `GET /api/v1/cms/site-content` — Bearer JWT (`requireAuth`). Lists all three
  keys as `[{ key, value, updatedAt }]`.
- `GET /api/v1/cms/site-content/:key` — Bearer JWT. Single
  `{ key, value, updatedAt }`; 404 on unknown key.
- `PUT /api/v1/cms/site-content/:key` — Bearer JWT. Body `{ value: array }`
  (max 50 items); per-key shape validation in core. 400 `VALIDATION` on bad
  input, 404 on unknown key. Landing consumes via `NEXT_PUBLIC_API_URL` +
  prefix `/api/v1/public` (same env name as booking web).

## Admin how-to

1. Open the CMS (`/admin`) → **Site Content** in the sidebar.
2. Ticker: one item per line → **Save ticker**.
3. Hero slides / testimonials: edit the JSON array (keep the field names),
   check the preview count → **Save**. Invalid JSON or a 400 validation
   message appears in the banner and toast; nothing reloads the page.
4. Verify: reload the view (or `curl GET /api/v1/public/site-content`) to see
   the public payload reflect the save.

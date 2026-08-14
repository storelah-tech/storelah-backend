import { Request, Response, Router } from 'express';
import express from 'express';
import { getAbsoluteFSPath } from 'swagger-ui-dist';
import { openapiSpec } from '../lib/openapi';
import { AppError } from '../lib/http';
import { resolveHostKind } from '../lib/host';

// ---------------------------------------------------------------------------
// Swagger UI for the customer-facing booking API.
//
// Served on the `api` host (api.storelah.sg + any non-CMS host) at `/docs`
// (and at `/`, wired up in src/index.ts), replacing the legacy terminal
// dashboard. The CMS host (cms.storelah.sg / localhost) 404s every /docs
// route — the operator dashboard there is unchanged.
//
// The static assets come straight from the `swagger-ui-dist` dependency
// (swagger-ui-bundle.js / swagger-ui-standalone-preset.js / swagger-ui.css),
// so nothing extra needs to be copied by `pnpm build`'s src/cms step.
// ---------------------------------------------------------------------------

const SWAGGER_UI_ASSETS = getAbsoluteFSPath();

const DOCS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>StoreLah Booking API — Developer Docs</title>
  <link rel="stylesheet" href="/docs/assets/swagger-ui.css"/>
  <style>
    body { margin: 0; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/assets/swagger-ui-bundle.js"></script>
  <script src="/docs/assets/swagger-ui-standalone-preset.js"></script>
  <script>
    window.addEventListener('load', function () {
      window.ui = SwaggerUIBundle({
        url: '/docs/swagger.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        displayOperationId: true,
        defaultModelsExpandDepth: -1,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
      });
    });
  </script>
</body>
</html>
`;

function isApiHost(req: Request): boolean {
  return resolveHostKind(req) === 'api';
}

/** Host gate: the Swagger docs surface belongs to the api host only. */
function requireApiHost(req: Request): void {
  if (!isApiHost(req)) {
    throw new AppError(404, 'NOT_FOUND', 'Route not found');
  }
}

export const swaggerDocsRouter: Router = Router();

// GET /docs → the Swagger UI page (the same page is served at `/` by index.ts).
swaggerDocsRouter.get('/', (req: Request, res: Response) => {
  requireApiHost(req);
  res.type('html').send(DOCS_PAGE);
});

// GET /docs/swagger.json → the OpenAPI spec itself (validated JSON).
swaggerDocsRouter.get('/swagger.json', (req: Request, res: Response) => {
  requireApiHost(req);
  res.json(openapiSpec);
});

// GET /docs/assets/* → swagger-ui-dist static assets (bundle, preset, css).
swaggerDocsRouter.use(
  '/assets',
  (req, _res, next) => {
    requireApiHost(req);
    next();
  },
  express.static(SWAGGER_UI_ASSETS, { index: false }),
);

/** The docs page, for the `/` route on the api host. */
export function serveSwaggerDocs(req: Request, res: Response): void {
  requireApiHost(req);
  res.type('html').send(DOCS_PAGE);
}

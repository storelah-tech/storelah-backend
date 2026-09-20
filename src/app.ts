import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import cmsRoutes from './routes/cms';
import publicRoutes from './routes/public';
import customerRoutes from './routes/customer';
import { swaggerDocsRouter, serveSwaggerDocs } from './routes/swagger';
import { errorHandler } from './lib/http';
import { AppError } from './lib/http';
import { resolveHostKind } from './lib/host';

const app = express();

app.use(cors());
// Stripe webhook signature verification requires the EXACT raw bytes — this
// raw mount MUST stay BEFORE express.json (body-parser skips re-parsing once
// req._body is set, so the webhook path keeps its Buffer body while every
// other route still gets parsed JSON).
app.use('/api/v1/customer/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'storelah-cms', time: new Date().toISOString() });
});

// Canonical API mount + legacy alias.
app.use('/api/v1/cms', cmsRoutes);
app.use('/api/cms', cmsRoutes);

// Customer-facing API (public + authenticated customer).
app.use('/api/v1/public', publicRoutes);
app.use('/api/v1/customer', customerRoutes);

// Swagger UI docs for the customer-facing booking API — served on the api host
// at /docs and / (see below). The CMS host 404s /docs. The docs surface
// replaced the legacy terminal dashboard on api.storelah.sg (see / and /admin).
app.use('/docs', swaggerDocsRouter);

// CMS UI (frozen dashboard.html served statically) — CMS host only.
// NB: /admin and / must be registered BEFORE the static mount — otherwise
// express.static sees the src/cms/admin/ directory (301-redirecting /admin →
// /admin/) and the CMS host gate below would swallow the / route.
app.get('/admin', (req, res) => {
  if (resolveHostKind(req) === 'api') {
    throw new AppError(404, 'NOT_FOUND', 'Route not found');
  }
  res.sendFile(path.join(__dirname, 'cms', 'admin', 'dashboard.html'));
});

app.get('/', (req, res) => {
  // cms.storelah.sg → CMS admin dashboard at the root; api.storelah.sg (and any
  // other non-CMS host) → Swagger UI docs for the booking API. The legacy
  // terminal dashboard is no longer served on the api host.
  if (resolveHostKind(req) === 'cms') {
    res.sendFile(path.join(__dirname, 'cms', 'admin', 'dashboard.html'));
    return;
  }
  serveSwaggerDocs(req, res);
});

// CMS static assets (dashboard.html, data-layer.js, admin/*) are gated to the
// CMS host so the api host cannot fetch the terminal dashboard (or its assets)
// by any path. The /docs router and both root routes above are already mounted,
// so this gate only ever sees non-docs, non-api requests on the api host.
app.use(
  (req, _res, next) => {
    if (resolveHostKind(req) === 'api') {
      throw new AppError(404, 'NOT_FOUND', 'Route not found');
    }
    next();
  },
  express.static(path.join(__dirname, 'cms')),
);

app.use((_req, _res) => {
  throw new AppError(404, 'NOT_FOUND', 'Route not found');
});

app.use(errorHandler);

export default app;

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import cmsRoutes from './routes/cms';
import publicRoutes from './routes/public';
import customerRoutes from './routes/customer';
import { errorHandler } from './lib/http';
import { AppError } from './lib/http';
import { config } from './lib/config';
import serverless from 'serverless-http';

const app = express();

app.use(cors());
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

// CMS UI (frozen dashboard.html served statically)
// NB: the /admin route must be registered BEFORE the static mount — otherwise
// express.static sees the src/cms/admin/ directory and 301-redirects /admin → /admin/.
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'cms', 'admin', 'dashboard.html'));
});
app.use(express.static(path.join(__dirname, 'cms')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'cms', 'dashboard.html'));
});

app.use((_req, _res) => {
  throw new AppError(404, 'NOT_FOUND', 'Route not found');
});

app.use(errorHandler);

export const handler = serverless(app);

// Local dev only — Lambda does not bind a port (the handler is the entry).
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(config.port, () => {
    console.log(`StoreLah CMS listening on http://localhost:${config.port}`);
  });
}
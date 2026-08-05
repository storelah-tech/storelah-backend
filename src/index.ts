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
app.use(express.static(path.join(__dirname, 'cms')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'cms', 'dashboard.html'));
});

app.use((_req, _res) => {
  throw new AppError(404, 'NOT_FOUND', 'Route not found');
});

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`StoreLah CMS listening on http://localhost:${config.port}`);
});
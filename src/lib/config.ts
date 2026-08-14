import dotenv from 'dotenv';

dotenv.config();

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * `API_HOST_SERVES_UI` (formerly the cms.storelah.sg cutover gate) has been
 * retired: the api.storelah.sg host no longer serves any CMS UI. It serves
 * the Swagger UI docs for the booking API at `/` and `/docs` unconditionally,
 * and 404s the dashboard and `/admin`. The CMS host (cms.storelah.sg /
 * localhost) always serves its dashboard. The deprecated env var, if still
 * set in a deployed function, is now ignored by design.
 */
export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  isProd: process.env.NODE_ENV === 'production',
} as const;

import dotenv from 'dotenv';

dotenv.config();

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  isProd: process.env.NODE_ENV === 'production',
  /**
   * Migration gate for the cms.storelah.sg cutover (2026-08). While truthy the
   * api.storelah.sg host keeps serving the CMS UI at /admin and / exactly as
   * before. Flip to 0/false after the cutover to 404 the UI on the API host; the
   * CMS host always serves its dashboard and /api/** routes are never affected.
   */
  apiHostServesUi: process.env.API_HOST_SERVES_UI !== '0' && process.env.API_HOST_SERVES_UI !== 'false',
} as const;
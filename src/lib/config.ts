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

// Stripe Checkout return origin (see src/core/checkout.ts): BOOKING_APP_URL is
// the booking-app origin baked into Checkout success_url/cancel_url. Dev
// default is http://localhost:3001 (see .env.example); in production it MUST
// be the public https booking origin (https://app.storelah.sg) — Stripe
// redirects the customer's browser there after payment, so a localhost value
// in prod breaks post-payment return (mobile browsers can never reach the
// server's localhost). Warn loudly but never crash: a misconfigured prod
// still boots so the misconfig shows up in logs instead of crash-looping
// cold starts. Runs at import time (index.ts imports this module on boot,
// including the Lambda cold start).
const bookingAppUrlRaw = process.env.BOOKING_APP_URL ?? '';
if (
  config.isProd &&
  (bookingAppUrlRaw === '' ||
    /localhost|127\.0\.0\.1|\[::1\]/i.test(bookingAppUrlRaw) ||
    !/^https:\/\//i.test(bookingAppUrlRaw))
) {
  console.warn(
    '[storelah] ⚠ MISCONFIG: BOOKING_APP_URL must be the public https booking origin ' +
      'in production (e.g. https://app.storelah.sg); got ' +
      `${bookingAppUrlRaw === '' ? '(unset)' : JSON.stringify(bookingAppUrlRaw)}. ` +
      'Stripe Checkout success_url/cancel_url will point at the wrong origin and ' +
      'post-payment redirects will fail.',
  );
}

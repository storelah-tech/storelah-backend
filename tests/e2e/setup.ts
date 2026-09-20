// Per-worker setup: runs BEFORE any test file imports `src/*`, so pointing
// DATABASE_URL at the isolated test DB here guarantees the shared Prisma
// client (src/lib/prisma.ts, constructed at first import) connects to the
// test DB — never to dev. dotenv (via src/lib/config.ts) never overrides an
// already-set variable, so this assignment wins over `.env`.

import { assertSafeTestDb, testDatabaseUrl } from './test-db';

const testUrl = testDatabaseUrl();
assertSafeTestDb(testUrl);
process.env.DATABASE_URL = testUrl;
// Customer/guest auth paths need a secret; the value is test-only.
process.env.JWT_SECRET ??= 'e2e-test-secret';
process.env.STORELAH_GUEST_DEFAULT_PASSWORD ??= 'e2e-guest-default';

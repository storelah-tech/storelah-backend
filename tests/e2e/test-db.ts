// Shared test-DB resolution for the backend move-in E2E suite.
//
// The suite NEVER touches the dev database: every entry point (global-setup,
// per-worker setup, fixture helpers) resolves the database URL through
// testDatabaseUrl() and must call assertSafeTestDb() before migrating or
// truncating. The guard refuses any database whose path does not end in
// `_test`, so a misconfigured env can never wipe `storelah` (dev).

const FALLBACK_TEST_URL =
  'postgresql://storelah:storelah@localhost:5433/storelah_test?schema=public';

export function testDatabaseUrl(): string {
  return process.env.DATABASE_URL_TEST ?? FALLBACK_TEST_URL;
}

function dbNameOf(url: string): string {
  const withoutQuery = url.split('?')[0];
  const lastSlash = withoutQuery.lastIndexOf('/');
  return lastSlash >= 0 ? withoutQuery.slice(lastSlash + 1) : withoutQuery;
}

export function assertSafeTestDb(url: string): void {
  const name = dbNameOf(url).toLowerCase();
  if (!name || !name.endsWith('_test')) {
    throw new Error(
      `[e2e] REFUSING to run: test database "${name || '(unparseable)'}" does not end in "_test". ` +
        `Set DATABASE_URL_TEST to an isolated database (e.g. storelah_test).`,
    );
  }
}

// Vitest globalSetup: runs ONCE in a dedicated process before any test file.
// Creates the isolated test database (if missing) and applies every Prisma
// migration to it. Never touches DATABASE_URL (dev) — only DATABASE_URL_TEST.

import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { assertSafeTestDb, testDatabaseUrl } from './test-db';

function maintenanceUrl(testUrl: string): string {
  // Connect to the `postgres` maintenance DB on the same server/credentials.
  return testUrl.replace(/\/[^/?]*(\?|$)/, '/postgres$1');
}

async function ensureDatabaseExists(testUrl: string): Promise<void> {
  const dbName = testUrl.split('?')[0].split('/').pop() as string;
  const admin = new PrismaClient({ datasourceUrl: maintenanceUrl(testUrl) });
  try {
    const existing = (await admin.$queryRawUnsafe(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      dbName,
    )) as unknown[];
    if (existing.length === 0) {
      // Identifier cannot be parameterised — quote it safely instead.
      const quoted = `"${dbName.replace(/"/g, '""')}"`;
      await admin.$executeRawUnsafe(`CREATE DATABASE ${quoted}`);
      console.log(`[e2e] created test database ${dbName}`);
    }
  } finally {
    await admin.$disconnect();
  }
}

export default async function globalSetup(): Promise<void> {
  const testUrl = testDatabaseUrl();
  assertSafeTestDb(testUrl);
  await ensureDatabaseExists(testUrl);
  execFileSync('pnpm', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'inherit',
  });
  console.log('[e2e] test database migrated');
}

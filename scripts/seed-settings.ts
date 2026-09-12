// Seed Global Settings defaults (NOT db:seed — additive and idempotent).
// Inserts only keys that have no row yet; existing rows are never touched.
// Usage: pnpm db:seed-settings
import { prisma } from '../src/lib/prisma';
import { SETTING_DEFS } from '../src/core/settings';

async function main() {
  const existing = await prisma.setting.findMany({ select: { key: true } });
  const have = new Set(existing.map((r) => r.key));
  const missing = SETTING_DEFS.filter((d) => !have.has(d.key));
  if (!missing.length) {
    console.log(`settings: all ${SETTING_DEFS.length} default(s) already present — nothing to do`);
    return;
  }
  await prisma.setting.createMany({
    data: missing.map((d) => ({ key: d.key, value: d.default as string | number | boolean })),
  });
  console.log(`settings: seeded ${missing.length} default(s) (total ${have.size + missing.length})`);
}

main()
  .catch((e) => {
    console.error('settings seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

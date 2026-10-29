// Import the landing site's content/snapshot.json into the site builder as
// version 1 of every page (site-builder plan §5 Phase 1). Additive: slugs that
// already exist are skipped, nothing is overwritten, no landing rebuild is
// triggered. Dry run by default.
// Usage: pnpm db:site-import <path/to/snapshot.json> [--apply]
import { readFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma';
import { importSiteSnapshot } from '../src/core/sitePages';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('Pass the snapshot path, e.g. ../storelah-landing/content/snapshot.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const r = await importSiteSnapshot(raw, { apply });
  console.log(`site-import (${apply ? 'APPLY' : 'dry run'}): ${r.created.length} to create, ${r.skipped.length} already present`);
  if (r.created.length) console.log(`  create: ${r.created.join(', ')}`);
  if (r.skipped.length) console.log(`  skip:   ${r.skipped.join(', ')}`);
  if (apply && r.publishId) console.log(`  published as ${r.publishId} (rebuild trigger skipped)`);
  if (!apply && r.created.length) console.log('Re-run with --apply to write.');
}

main()
  .catch((e) => {
    console.error('site import failed:', e instanceof Error ? e.message : e, (e as { details?: unknown })?.details ?? '');
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

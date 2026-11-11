/**
 * Finance size mix → size catalogue (2026-11-11). DRY RUN by default; `--apply`
 * writes. Data-only companion of migration 20261111000000_unit_size_ranges
 * (run AFTER it). A TS script rather than SQL because FinancialModel.inputHash
 * must be recomputed with the projection engine's hashInput().
 *
 * Rewrites FinancialModel.inputs.sizeMix of every non-ARCHIVED model (working
 * models + library drafts) via upgradeSizeMix() (src/core/finance/sizeMixCatalogue.ts):
 * rows that meant the old LOCKER/XS bucket become "XS" with values unchanged,
 * labels/ranges follow the catalogue (Locker 8–15 · XS 10–19 · S 20–39 ·
 * M 40–69 · L 70–99 · XL 100–150), and an empty Locker row is added.
 *
 * NOT touched (history): FinancialModelVersion snapshots (restoring one
 * upgrades it on the way in — library.restoreVersion), FinancialModelCalculation
 * results, FinanceAuditEvent, ARCHIVED models, published report snapshots.
 * Model `version` is NOT bumped, so stored calculations stay attached.
 *
 * Safety: for each model the projection is run before and after; the script
 * refuses to write (exit 1) if ANY monthly figure or KPI differs. Run-once:
 * models already on the catalogue (have Locker + XS rows) are skipped.
 *
 *   pnpm db:finance-size-mix            # dry run: what would change + figure check
 *   pnpm db:finance-size-mix --apply    # write (owner-approved runs only)
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { hashInput, project, stableStringify, type ProjectionInput } from '../src/core/finance/projection';
import { isCatalogueSizeMix, upgradeSizeMix } from '../src/core/finance/sizeMixCatalogue';

const prisma = new PrismaClient();

function figures(inputs: ProjectionInput) {
  const r = project(inputs);
  return { months: r.months, kpis: r.kpis, leasePayableByYear: r.leasePayableByYear ?? null };
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'Finance size mix → catalogue — APPLYING.' : 'Finance size mix → catalogue — DRY RUN, nothing is written.');
  const models = await prisma.financialModel.findMany({ where: { status: { not: 'ARCHIVED' } }, orderBy: { createdAt: 'asc' } });
  let changed = 0;
  let skipped = 0;
  const writes: Array<{ id: string; inputs: ProjectionInput; hash: string; before: string[]; after: string[] }> = [];
  for (const m of models) {
    const inputs = m.inputs as unknown as ProjectionInput;
    const mix = Array.isArray(inputs?.sizeMix) ? inputs.sizeMix : [];
    if (!mix.length || isCatalogueSizeMix(mix)) { skipped++; continue; }
    const next: ProjectionInput = { ...inputs, sizeMix: upgradeSizeMix(mix) };
    const a = stableStringify(figures(inputs));
    const b = stableStringify(figures(next));
    if (a !== b) throw new Error(`Model ${m.id} "${m.name}": projection figures would change — refusing.`);
    const k = project(inputs).kpis;
    const y1 = k.years?.[0] as { revenue?: number } | undefined;
    console.log(
      `  ${m.status.padEnd(8)} ${m.name} — ${mix.map((c) => c.name).join('/')} → ${next.sizeMix.map((c) => c.name).join('/')}` +
        ` · weighted PSF ${k.weightedStartPsf} · Y1 revenue ${y1?.revenue ?? '—'} · IRR ${k.irrAnnualised ?? 'n/a'} · figures identical ✓`,
    );
    writes.push({ id: m.id, inputs: next, hash: hashInput(next), before: mix.map((c) => c.name), after: next.sizeMix.map((c) => c.name) });
    changed++;
  }
  console.log(`Models checked: ${models.length} (non-archived); to rewrite: ${changed}; already on catalogue / empty: ${skipped}`);
  if (apply && writes.length) {
    const correlationId = randomUUID();
    await prisma.$transaction(async (tx) => {
      for (const w of writes) {
        const m = await tx.financialModel.update({
          where: { id: w.id },
          data: { inputs: w.inputs as unknown as Prisma.InputJsonValue, inputHash: w.hash },
        });
        await tx.financeAuditEvent.create({
          data: {
            branchId: m.branchId, actor: 'finance-size-mix-catalogue script', action: 'MODEL_SIZE_MIX_CATALOGUE',
            entityType: 'financial-model', entityId: m.id,
            before: { sizeMix: w.before } as Prisma.InputJsonValue, after: { sizeMix: w.after, inputHash: w.hash } as Prisma.InputJsonValue,
            reason: 'Size catalogue 2026-11-11: Locker/XS split, no figure changes', source: 'script',
            correlationId,
          },
        });
      }
    }, { timeout: 120_000 });
    console.log(`Applied: ${writes.length} model(s) rewritten.`);
  }
}

main()
  .catch((e) => {
    console.error('finance size-mix catalogue failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

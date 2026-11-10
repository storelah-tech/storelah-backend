// Lease-horizon shadow report (P2 — READ-ONLY, writes nothing).
//
// Compares the v1 engine against the v2 bucket engine for one model and
// prints month rows side by side, plus KPI deltas. Used for the P2 rollout
// check (handoff §14 step 3): first-of-month models must match exactly;
// mid-month models show the investigated stub differences.
//
// Usage:
//   pnpm tsx scripts/lease-horizon-shadow.ts <modelId | path/to/model.json>
//
// - A model id is read from the database with a single findUnique (NO writes,
//   no recalculation, no audit events). A JSON file may hold a ProjectionInput
//   snapshot directly, or { "inputs": {...} } / { "input": {...} } wrappers
//   (the golden fixture uses { "input": {...} }).
// - For v1 inputs the v2 side is built with upcastInputs() (read-path only);
//   for inputs already carrying the v2 lease block, the v1 side strips it back
//   to { monthlyByYear, rentFreeMonths, ufaSqft } using legacyRentFreeMonths.
// - Prints NO secrets: only model identity, row money figures and KPI names.
//   Never echo DATABASE_URL or any credential.
//
// SAFETY: run only against local/throwaway DBs (DATABASE_URL_TEST or a local
// dev database). NEVER point this at prod — pass a JSON file instead when in
// doubt.

import { readFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma';
import { projectV1, projectV2, hasV2LeaseBlock, type ProjectionInput } from '../src/core/finance/projection';
import { upcastInputs } from '../src/core/finance/leaseTerm';

function usage(): never {
  console.error('Usage: pnpm tsx scripts/lease-horizon-shadow.ts <modelId | path/to/model.json>');
  process.exit(1);
}

function asInputs(parsed: unknown): ProjectionInput {
  if (!parsed || typeof parsed !== 'object') throw new Error('JSON must be an object.');
  const o = parsed as Record<string, unknown>;
  if (o.inputs && typeof o.inputs === 'object') return o.inputs as ProjectionInput;
  if (o.input && typeof o.input === 'object') return o.input as ProjectionInput;
  return parsed as ProjectionInput;
}

function stripToV1(v2input: ProjectionInput): ProjectionInput {
  const l = v2input.lease as unknown as Record<string, unknown>;
  const monthlyByYear = Array.isArray(l.monthlyByYear) ? [...(l.monthlyByYear as number[])] : [];
  const legacy = typeof l.legacyRentFreeMonths === 'number' ? (l.legacyRentFreeMonths as number) : undefined;
  const free = typeof l.rentFreeMonths === 'number' ? (l.rentFreeMonths as number) : 0;
  const lease: Record<string, unknown> = { monthlyByYear, rentFreeMonths: legacy ?? free };
  if (typeof l.ufaSqft === 'number') lease.ufaSqft = l.ufaSqft as number;
  return { ...(v2input as object), lease } as unknown as ProjectionInput;
}

const money = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : String(n));

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) usage();
  let label: string;
  let inputs: ProjectionInput;
  if (arg.endsWith('.json') || arg.startsWith('{')) {
    const raw = arg.startsWith('{') ? arg : readFileSync(arg, 'utf8');
    inputs = asInputs(JSON.parse(raw));
    label = arg.startsWith('{') ? 'inline-json' : arg;
  } else {
    const m = await prisma.financialModel.findUnique({ where: { id: arg } });
    if (!m) throw new Error(`Financial model ${arg} not found.`);
    inputs = m.inputs as unknown as ProjectionInput;
    label = `${m.name} [${m.status} v${m.version} engine=${m.engineVersion}]`;
  }

  const isV2 = hasV2LeaseBlock(inputs);
  const v1base = isV2 ? stripToV1(inputs) : inputs;
  const v1 = projectV1(v1base);
  const v2input = isV2 ? inputs : upcastInputs(v1base as unknown as Parameters<typeof upcastInputs>[0]);
  const v2 = projectV2(v2input as ProjectionInput);

  console.log(`shadow: ${label}`);
  console.log(`shadow: v1 engine=${v1.engineVersion} rows=${v1.months.length} | v2 engine=${v2.engineVersion} rows=${v2.months.length}`);
  console.log('t | month | v1_revenue | v2_revenue | v1_lease | v2_lease | v1_noi | v2_noi | v1_cash | v2_cash');
  const n = Math.max(v1.months.length, v2.months.length);
  for (let i = 0; i < n; i++) {
    const a = v1.months[i];
    const b = v2.months[i];
    console.log(
      `${String(i + 1).padStart(3)} | ${b?.month ?? a?.month ?? '--'} | ` +
        `${a ? money(a.revenue) : '--'} | ${b ? money(b.revenue) : '--'} | ` +
        `${a ? money(a.opexLease) : '--'} | ${b ? money(b.opexLease) : '--'} | ` +
        `${a ? money(a.noi) : '--'} | ${b ? money(b.noi) : '--'} | ` +
        `${a ? money(a.cash) : '--'} | ${b ? money(b.cash) : '--'}`,
    );
  }
  const sum = (xs: number[]): number => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;
  console.log(
    `totals: revenue v1=${sum(v1.months.map((m) => m.revenue))} v2=${sum(v2.months.map((m) => m.revenue))} | ` +
      `lease v1=${sum(v1.months.map((m) => m.opexLease))} v2=${sum(v2.months.map((m) => m.opexLease))} | ` +
      `cash-end v1=${money(v1.months[v1.months.length - 1]?.cash ?? NaN)} v2=${money(v2.months[v2.months.length - 1]?.cash ?? NaN)}`,
  );
  console.log(
    `kpis: payback v1=${v1.kpis.paybackMonth} v2=${v2.kpis.paybackMonth} | ` +
      `irr v1=${v1.kpis.irrAnnualised} v2=${v2.kpis.irrAnnualised} | ` +
      `years v1=${v1.kpis.years.length} v2=${v2.kpis.years.length}`,
  );
  const bad = Object.entries(v2.checks)
    .filter(([, c]) => !c.pass)
    .map(([k]) => k);
  console.log(`v2 checks: ${bad.length ? `FAILING: ${bad.join(', ')}` : 'all pass'}`);
}

main()
  .catch((e) => {
    console.error(`shadow failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

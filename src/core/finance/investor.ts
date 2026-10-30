// Investor Summary — masked approved-only view (spec §15.4, owner Q10 FINAL).
//
// Read-only aggregates over APPROVED data only:
//   - modelling + returns from the CURRENT financial model (never drafts;
//     404 when no CURRENT baseline exists);
//   - posted actuals from CLOSED months only (open months are excluded);
//   - issued/paid invoice aggregates (counts + rounded sums, never line items).
//
// Privacy contract (hard): the payload carries NO customer names, emails,
// phones, tenant ids, invoice refs, transaction detail, internal notes or
// draft/open-month data. Amounts are rounded to whole dollars (Q10 MAY
// round); PSF rates are ALWAYS 2dp numbers; percents are 1dp (spec §7.4).
// Every output is labelled as a masked summary (watermark string).

import { prisma } from '../../lib/prisma';
import { toNum } from '../../lib/format';
import { AppError } from '../../lib/http';
import { project } from './projection';
import { getReturns } from './returns';
import { ACTUAL_METRICS } from './monthClose';

export const INVESTOR_WATERMARK = 'MASKED SUMMARY — APPROVED DATA ONLY';

const RECEIVABLE_OR_PAID = ['ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID', 'PAID'] as const;

/** Q10: amounts MAY round — whole dollars. */
function roundWhole(n: number): number {
  return Math.round(n);
}

/** Q10: psf ALWAYS 2dp. */
function psf2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Spec §7.4: occupancy and margin to one decimal place. */
function pct1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface InvestorSummaryOpts {
  branchId?: string;
}

/** Masked modelling + returns + closed-month + ledger-aggregate summary. */
export async function getInvestorSummary(opts: InvestorSummaryOpts = {}) {
  const { branchId } = opts;

  // CURRENT baseline only — drafts are never investor-visible.
  const model = await prisma.financialModel.findFirst({
    where: { ...(branchId ? { branchId } : {}), status: 'CURRENT' },
    orderBy: { updatedAt: 'desc' },
  });
  if (!model) {
    throw new AppError(
      404,
      'NOT_FOUND',
      'No CURRENT model baseline — the investor summary shows approved models only.',
    );
  }
  const inputs = model.inputs as unknown as Parameters<typeof project>[0];
  const result = project(inputs);
  const returns = await getReturns({ modelId: model.id, horizonYears: 5 });

  const branchFilter = branchId ? { branchId } : {};
  const invoiceScope = branchId ? { unit: { branchId } } : {};

  // --- Live occupancy (aggregate counts only — no tenant rows leave this function).
  const [totalUnits, occupiedUnits] = await Promise.all([
    prisma.unit.count({ where: { ...branchFilter, deletedAt: null } }),
    prisma.tenant.count({
      where: { ...branchFilter, unitId: { not: null }, status: { in: ['ACTIVE', 'DUE_SOON', 'OVERDUE', 'NOTICE'] } },
    }),
  ]);
  const occupancyRatePct = totalUnits > 0 ? pct1((occupiedUnits / totalUnits) * 100) : null;

  // --- Tenure + average customer value (averages over tenant aggregates only).
  const tenantAgg = await prisma.tenant.aggregate({
    where: { ...branchFilter, unitId: { not: null } },
    _count: { id: true },
    _avg: { monthlyRate: true },
  });
  const activeTenants = tenantAgg._count.id;
  const avgCustomerValue = tenantAgg._avg.monthlyRate != null ? roundWhole(toNum(tenantAgg._avg.monthlyRate)) : null;
  let avgTenureMonths: number | null = null;
  if (activeTenants > 0) {
    const tenureRows = await prisma.tenant.findMany({
      where: { ...branchFilter, unitId: { not: null }, moveInDate: { not: null } },
      select: { moveInDate: true },
    });
    if (tenureRows.length > 0) {
      const now = Date.now();
      const months = tenureRows.map((t) =>
        Math.max(0, (now - new Date(t.moveInDate as unknown as Date).getTime()) / (30.44 * 24 * 3600 * 1000)),
      );
      avgTenureMonths = pct1(months.reduce((s, m) => s + m, 0) / months.length);
    }
  }

  // --- Ledger aggregates (issued/paid sums + counts — never line items).
  const issuedRows = await prisma.invoice.findMany({
    where: { ...invoiceScope, status: { in: [...RECEIVABLE_OR_PAID] } },
    select: { amount: true, amountPaid: true, status: true },
  });
  const issuedTotal = roundWhole(issuedRows.reduce((s, r) => s + toNum(r.amount), 0));
  const paidRows = issuedRows.filter((r) => r.status === 'PAID');
  const collectedTotal = roundWhole(
    paidRows.reduce((s, r) => s + (r.amountPaid != null ? toNum(r.amountPaid) : toNum(r.amount)), 0),
  );
  const openBalance = roundWhole(
    issuedRows
      .filter((r) => r.status !== 'PAID')
      .reduce((s, r) => s + Math.max(0, toNum(r.amount) - (r.amountPaid != null ? toNum(r.amountPaid) : 0)), 0),
  );

  // --- Closed months only (MonthClose CLOSED + their ActualMetric rows).
  const closedMonths = await prisma.monthClose.findMany({
    where: { ...branchFilter, status: 'CLOSED' },
    orderBy: { fiscalMonth: 'asc' },
  });
  const closedActuals: Array<{ fiscalMonth: string; metrics: Record<string, number | null> }> = [];
  for (const m of closedMonths) {
    const rows = await prisma.actualMetric.findMany({
      where: { branchId: m.branchId, fiscalMonth: m.fiscalMonth },
    });
    const metrics: Record<string, number | null> = {};
    for (const k of ACTUAL_METRICS) {
      const row = rows.find((r) => r.metric === k);
      metrics[k] = row ? roundWhole(toNum(row.value)) : null;
    }
    closedActuals.push({ fiscalMonth: m.fiscalMonth, metrics });
  }

  // --- Modelling headline numbers (Q10 content list).
  const plannedUnits = inputs.sizeMix.reduce((s, c) => s + (c.units ?? 0), 0);
  const rampUpSqft = Math.round(result.kpis.year1NetMoveInSqft);
  const lifetimeRevenue = roundWhole(result.months.reduce((s, m) => s + m.revenue, 0));

  const branch = branchId ? await prisma.branch.findUnique({ where: { id: branchId } }) : null;

  return {
    watermark: INVESTOR_WATERMARK,
    label: 'Masked summary — approved data only. Customer names, transaction detail and draft data are never included.',
    generatedAt: new Date(),
    branch: branch ? { id: branch.id, code: branch.code, name: branch.name } : null,
    modelling: {
      source: {
        modelName: model.name,
        modelStatus: model.status,
        engineVersion: model.engineVersion,
        inputHash: model.inputHash,
        asOf: model.updatedAt,
      },
      occupancyRatePct,
      occupancyNote:
        'Measured occupancy at generation time (occupied units ÷ live units). Model stabilisation target: ' +
        `${pct1(inputs.occupancy.targetPct)}% by month ${result.kpis.stabilisedMonth ?? '—'}.`,
      earnedPsf: psf2(result.kpis.weightedStartPsf),
      earnedPsfNote: 'Average monthly customer rental rate per occupied square foot (model weighted start PSF, 2dp).',
      rampUpSqft,
      rampUpNote: `Model year-1 net move-in sqft (${inputs.occupancy.rampFirst6}/mo months 1–6, ${inputs.occupancy.rampFrom7}/mo thereafter).`,
      signUpsUnits: plannedUnits,
      signUpsNote: 'Planned unit count from the approved size mix (not customer records).',
      moveOutRatePctMonth: pct1(inputs.occupancy.moveOutRatePct),
      moveOutNote: `Model move-out assumption from month ${inputs.occupancy.churnStartMonth} (percent of occupied sqft per month).`,
      avgTenureMonths,
      tenureNote:
        avgTenureMonths === null
          ? 'No tenant move-in records in scope — shown as blank, never estimated.'
          : 'Average months since move-in across in-scope occupied tenants (aggregate only).',
      avgCustomerValue,
      avgCustomerValueNote:
        avgCustomerValue === null
          ? 'No tenant rate records in scope — shown as blank, never estimated.'
          : 'Average contracted monthly rate across in-scope occupied tenants, rounded to whole dollars.',
      totalRevenueModel: lifetimeRevenue,
      totalRevenueNote: 'Model lifetime revenue over the approved horizon, rounded to whole dollars.',
    },
    returns: {
      horizonYears: returns.horizon.years,
      initialInvestment: roundWhole(returns.initialInvestment),
      paybackMonth: returns.paybackMonth,
      paybackWithinHorizon: returns.paybackWithinHorizon,
      stabilisationMonth: returns.stabilisationMonth,
      noiPositiveMonth: returns.noiPositiveMonth,
      annualNoiMarginPct: returns.annualNoiMarginPct,
      cashThroughSelectedYear: roundWhole(returns.cashThroughSelectedYear),
      irrAnnualisedPct:
        returns.irrAnnualised === null || returns.irrAnnualised === undefined
          ? null
          : pct1(returns.irrAnnualised * 100),
      irrNote: returns.irrNote,
      npv: roundWhole(returns.npv.value),
      npvDiscountRatePct: returns.npv.discountRatePct,
      noTerminalValueDisclosure:
        'No terminal value / property sale is included (lease renewal unsecured). IRR is operating cash-flow only.',
    },
    actuals: {
      closedMonths: closedActuals,
      note:
        closedActuals.length === 0
          ? 'No closed months in scope — future actuals show as blank, never zero.'
          : 'Posted actuals for CLOSED months only. Open months are excluded from this summary.',
    },
    aggregates: {
      issuedInvoices: issuedRows.length,
      issuedTotal,
      paidInvoices: paidRows.length,
      collectedTotal,
      accountsReceivable: openBalance,
      note: 'Ledger aggregates (counts + rounded sums) across issued and paid invoices. Draft, approved-unissued, void and written-off rows are excluded.',
    },
    definitions: [
      'Occupancy rate: occupied units ÷ live units, one decimal place.',
      'Earned PSF: model weighted start PSF, always two decimal places.',
      'Ramp-up sqft: model year-1 net move-in square feet, whole number.',
      'Sign-ups: planned unit count from the approved size mix.',
      'Move-outs: model monthly move-out rate assumption (percent of occupied sqft).',
      'Tenure: average months since move-in (tenant aggregates, no customer records).',
      'Average customer value: average contracted monthly rate, rounded.',
      'Total revenue: model lifetime revenue, rounded; collected total is paid receipts, rounded.',
    ],
  };
}

/** Audited CSV export rows for GET /finance/investor/summary.csv (masked). */
export function investorSummaryCsv(s: Awaited<ReturnType<typeof getInvestorSummary>>): string {
  const esc = (v: string | number | null): string => {
    const s2 = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s2) ? `"${s2.replace(/"/g, '""')}"` : s2;
  };
  const rows: Array<[string, string | number | null]> = [
    ['watermark', s.watermark],
    ['model', s.modelling.source.modelName],
    ['model status', s.modelling.source.modelStatus],
    ['as of', new Date(s.modelling.source.asOf).toISOString()],
    ['occupancy rate %', s.modelling.occupancyRatePct],
    ['earned psf', s.modelling.earnedPsf === null || s.modelling.earnedPsf === undefined ? '' : s.modelling.earnedPsf.toFixed(2)],
    ['ramp-up sqft', s.modelling.rampUpSqft],
    ['sign-ups (units)', s.modelling.signUpsUnits],
    ['move-out rate %/mo', s.modelling.moveOutRatePctMonth],
    ['avg tenure months', s.modelling.avgTenureMonths],
    ['avg customer value', s.modelling.avgCustomerValue],
    ['total revenue (model)', s.modelling.totalRevenueModel],
    ['payback month', s.returns.paybackMonth],
    ['IRR annualised %', s.returns.irrAnnualisedPct],
    ['NPV', s.returns.npv],
    ['issued invoices', s.aggregates.issuedInvoices],
    ['issued total', s.aggregates.issuedTotal],
    ['paid invoices', s.aggregates.paidInvoices],
    ['collected total', s.aggregates.collectedTotal],
    ['accounts receivable', s.aggregates.accountsReceivable],
  ];
  for (const c of s.actuals.closedMonths) {
    for (const k of ACTUAL_METRICS) rows.push([`actual ${c.fiscalMonth} ${k}`, c.metrics[k]]);
  }
  return ['metric,value', ...rows.map(([k, v]) => `${esc(k)},${esc(v)}`)].join('\n') + '\n';
}

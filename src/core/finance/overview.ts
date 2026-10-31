// Read-only Finance Overview (FINANCE_MODULE_SPEC §9).
//
// Built ONLY from real committed source data: Invoice ledger, Tenant rows
// (agreement proxy until the StorageAgreement sign-off), Booking rows
// (move-in proxy), and move-out Notices. Sourceless KPIs return null with a
// `not-connected` flag — NEVER a fabricated zero. Unposted actuals do not
// exist on this screen (Forecast vs Actuals is Phase 4); where a value is a
// valid measured zero (no activity in period) the KPI carries value 0 plus a
// "no activity" note.
//
// Accounting basis (§7.2): accrual = recognised/billed revenue from issued
// invoices for the service period (Invoice.dueDate); cash = successfully
// received payments for the receipt period (Invoice.paidAt). AR stays an
// invoice-ledger balance under both bases.

import { prisma } from '../../lib/prisma';
import { toNum } from '../../lib/format';

export type OverviewBasis = 'accrual' | 'cash';

export interface OverviewOpts {
  branchId?: string;
  from?: Date;
  to?: Date;
  basis?: OverviewBasis;
}

export interface KpiLineage {
  definition: string;
  source: string;
  refresh: string;
}

export interface OverviewKpi {
  key: string;
  label: string;
  /** Null = not connected to a source yet (UI shows "Not yet connected"). */
  value: number | null;
  connected: boolean;
  format: 'money' | 'count' | 'percent';
  note?: string;
  lineage: KpiLineage;
  drill?: string;
}

const NOT_CONNECTED = 'Not yet connected — no source system feeds this KPI yet.';

function inRange(field: string, from?: Date, to?: Date): Record<string, unknown> | undefined {
  if (!from && !to) return undefined;
  return { [field]: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } };
}

export async function getFinanceOverview(opts: OverviewOpts = {}) {
  const { branchId, from, to, basis = 'accrual' } = opts;
  const branchFilter = branchId ? { branchId } : {};
  const invoiceScope = branchId ? { unit: { branchId } } : {};

  // Billed revenue (accrual): issued invoice amounts for the service period.
  // Phase 3 lifecycle: only real receivables count (ISSUED/DUE/OVERDUE/
  // PARTIALLY_PAID) plus PAID — DRAFT/APPROVED/VOID/WRITTEN_OFF rows are
  // pre-receivable or terminal and never revenue.
  const RECEIVABLE_OR_PAID = ['ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID', 'PAID'] as const;
  const billedRows = await prisma.invoice.findMany({
    where: { ...invoiceScope, status: { in: [...RECEIVABLE_OR_PAID] }, ...inRange('dueDate', from, to) },
    select: { amount: true },
  });
  const revenueBilled = billedRows.reduce((s, r) => s + toNum(r.amount), 0);

  // Cash collected: successfully received + allocated payments in period.
  const paidRows = await prisma.invoice.findMany({
    where: {
      ...invoiceScope,
      status: 'PAID',
      ...(from || to ? { paidAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    select: { amount: true, amountPaid: true },
  });
  const cashCollected = paidRows.reduce((s, r) => s + (r.amountPaid != null ? toNum(r.amountPaid) : toNum(r.amount)), 0);

  // AR: open invoice balance at period end (ledger less payments). Phase 3:
  // every receivable state counts (ISSUED/DUE/OVERDUE/PARTIALLY_PAID);
  // PARTIALLY_PAID contributes its remainder via amount − amountPaid.
  // Overdue here keeps STORED status semantics — the billing run never flips
  // statuses and Phase 3 posts no late fees (grace derivation is portal
  // display-only; enforcement is Phase 4).
  const openRows = await prisma.invoice.findMany({
    where: { ...invoiceScope, status: { in: ['ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID'] } },
    select: { amount: true, amountPaid: true, status: true },
  });
  const openBalance = (r: { amount: unknown; amountPaid: unknown; status: string }): number => {
    if (r.status === 'PAID') return 0;
    return Math.max(0, toNum(r.amount as never) - (r.amountPaid != null ? toNum(r.amountPaid as never) : 0));
  };
  const accountsReceivable = openRows.reduce((s, r) => s + openBalance(r), 0);
  const overdueBalance = openRows.filter((r) => r.status === 'OVERDUE').reduce((s, r) => s + openBalance(r), 0);
  const overdueCount = openRows.filter((r) => r.status === 'OVERDUE').length;

  // Customer activity from real tenant/booking/notice rows.
  const signups = await prisma.tenant.count({
    where: { ...branchFilter, ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) },
  });
  const occupiedUnits = await prisma.tenant.count({
    where: { ...branchFilter, unitId: { not: null }, status: { in: ['ACTIVE', 'DUE_SOON', 'OVERDUE', 'NOTICE'] } },
  });
  const moveIns = await prisma.booking.count({
    where: {
      ...(branchId ? { unit: { branchId } } : {}),
      status: { in: ['CONFIRMED', 'ACTIVE'] },
      ...(from || to ? { moveInDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
  });
  const moveOuts = await prisma.notice.count({
    where: {
      ...(branchId ? { unit: { branchId } } : {}),
      ...(from || to ? { lastDay: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
  });

  // Six-month collection-rate trend (billed by dueDate, collected by paidAt).
  const trend: Array<{ month: string; billed: number; collected: number; rate: number | null }> = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 0, 23, 59, 59, 999));
    const [b, c] = await Promise.all([
      prisma.invoice.aggregate({
        _sum: { amount: true },
        where: { ...invoiceScope, status: { in: [...RECEIVABLE_OR_PAID] }, dueDate: { gte: start, lte: end } },
      }),
      prisma.invoice.aggregate({
        _sum: { amountPaid: true, amount: true },
        where: { ...invoiceScope, status: 'PAID', paidAt: { gte: start, lte: end } },
      }),
    ]);
    const billed = toNum(b._sum.amount);
    // amountPaid is stamped by the webhook; fall back to amount when missing.
    const paidAgg = await prisma.invoice.findMany({
      where: { ...invoiceScope, status: 'PAID', paidAt: { gte: start, lte: end } },
      select: { amount: true, amountPaid: true },
    });
    const collected = paidAgg.reduce((s, r) => s + (r.amountPaid != null ? toNum(r.amountPaid) : toNum(r.amount)), 0);
    void c;
    trend.push({
      month: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
      billed,
      collected,
      rate: billed > 0 ? Math.round((collected / billed) * 1000) / 10 : null,
    });
  }

  // F-7: failed payments come from the Phase 3 instruction register
  // (FAILED attempts in the selected period, facility-scoped through the
  // invoice's unit — never fabricated, zero is a measured zero).
  const failedRows = await prisma.paymentInstruction.findMany({
    where: {
      status: 'FAILED',
      ...(branchId ? { invoice: { unit: { branchId } } } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    select: { amount: true },
  });
  const failedTotal = failedRows.reduce((s, r) => s + toNum(r.amount), 0);

  // F-7: credits & refunds come from the Phase 4 ledgers: live wallet
  // balances plus pending (REQUESTED/APPROVED) refunds in scope.
  const [walletRows, refundRows] = await Promise.all([
    prisma.creditWallet.findMany({
      where: { ...(branchId ? { branchId } : {}) },
      select: { balance: true },
    }),
    prisma.refund.findMany({
      where: {
        status: { in: ['REQUESTED', 'APPROVED'] },
        ...(branchId ? { branchId } : {}),
      },
      select: { amount: true },
    }),
  ]);
  const creditBalance = walletRows.reduce((s, r) => s + toNum(r.balance), 0);
  const refundsPending = refundRows.reduce((s, r) => s + toNum(r.amount), 0);
  const creditsRefundsTotal = Math.round((creditBalance + refundsPending) * 100) / 100;

  // (basis is retained for the toggle + export contract; both KPIs always render).
  const generatedAt = new Date();
  const kpis: OverviewKpi[] = [
    // F-7: Revenue billed and Cash collected are separate KPIs (the old
    // single switching tile is gone). Both are live; zero carries a note.
    {
      key: 'revenueBilled', label: 'Revenue billed',
      value: revenueBilled, connected: true, format: 'money',
      ...(revenueBilled === 0 ? { note: 'No receivables billed in the selected period.' } : {}),
      lineage: {
        definition: 'Issued invoice amounts for the service period.',
        source: 'Invoice ledger (receivable + paid statuses, by dueDate; drafts/voids excluded)',
        refresh: 'Live on every read.',
      },
      drill: 'bill-invoices',
    },
    {
      key: 'cashCollected', label: 'Cash collected',
      value: cashCollected, connected: true, format: 'money',
      ...(cashCollected === 0 ? { note: 'No receipts collected in the selected period.' } : {}),
      lineage: {
        definition: 'Successfully received payments allocated to invoices in the receipt period.',
        source: 'Invoice ledger (status PAID, by paidAt)',
        refresh: 'Live on every read.',
      },
      drill: 'bill-transactions',
    },
    {
      key: 'accountsReceivable', label: 'Accounts receivable', value: accountsReceivable, connected: true, format: 'money',
      lineage: {
        definition: 'Open invoice balance at period end (ledger less payments and credits).',
        source: 'Invoice ledger (ISSUED + DUE + OVERDUE + PARTIALLY_PAID balances; drafts/voids excluded)',
        refresh: 'Live on every read.',
      },
      drill: 'bill-invoices',
    },
    {
      key: 'overdueBalance', label: 'Overdue balance', value: overdueBalance, connected: true, format: 'money',
      note: `${overdueCount} overdue invoice${overdueCount === 1 ? '' : 's'}.`,
      lineage: {
        definition: 'Open balance past the due date (grace policy: finance.graceDays, no enforcement in Phase 1).',
        source: 'Invoice ledger (status OVERDUE)',
        refresh: 'Live on every read.',
      },
      drill: 'bill-arrears',
    },
    {
      key: 'failedPayments', label: 'Failed payments', value: failedTotal, connected: true, format: 'money',
      ...(failedTotal === 0 ? { note: 'No failed attempts in the selected period.' } : { note: `${failedRows.length} failed attempt${failedRows.length === 1 ? '' : 's'} in the selected period.` }),
      lineage: {
        definition: 'Processor/bank attempts in a failed state.',
        source: 'Payment instructions (status FAILED, by createdAt)',
        refresh: 'Live on every read.',
      },
      drill: 'bill-transactions',
    },
    {
      key: 'creditsRefunds', label: 'Credits & refunds', value: creditsRefundsTotal, connected: true, format: 'money',
      note: `Wallet $${creditBalance.toLocaleString('en-SG', { maximumFractionDigits: 2 })} + pending refunds $${refundsPending.toLocaleString('en-SG', { maximumFractionDigits: 2 })}.`,
      lineage: {
        definition: 'Unused credit-wallet balance plus pending refunds.',
        source: 'Credit wallets (live balance) + refunds (REQUESTED/APPROVED)',
        refresh: 'Live on every read.',
      },
      drill: 'bill-credits',
    },
    {
      key: 'newSignups', label: 'New sign-ups', value: signups, connected: true, format: 'count',
      lineage: {
        definition: 'Tenant records created in the period (agreement proxy until the StorageAgreement sign-off).',
        source: 'Tenant rows (by createdAt)',
        refresh: 'Live on every read.',
      },
    },
    {
      key: 'occupiedUnits', label: 'Occupied units', value: occupiedUnits, connected: true, format: 'count',
      lineage: {
        definition: 'Units with an active tenant at period end.',
        source: 'Tenant rows with a unit (ACTIVE / DUE_SOON / OVERDUE / NOTICE)',
        refresh: 'Live on every read.',
      },
    },
    {
      key: 'moveIns', label: 'Move-ins', value: moveIns, connected: true, format: 'count',
      lineage: {
        definition: 'Bookings with a move-in date in the period (handover proxy until move-in events land).',
        source: 'Booking rows (CONFIRMED / ACTIVE, by moveInDate)',
        refresh: 'Live on every read.',
      },
    },
    {
      key: 'moveOuts', label: 'Move-outs', value: moveOuts, connected: true, format: 'count',
      lineage: {
        definition: 'Move-out notices past their last day in the period (release proxy).',
        source: 'Move-out notices (by lastDay)',
        refresh: 'Live on every read.',
      },
    },
  ];

  return {
    period: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
    branchId: branchId ?? null,
    basis,
    generatedAt,
    kpis,
    collectionTrend: trend,
    snapshot: {
      unallocatedReceipts: { value: null as number | null, connected: false, note: NOT_CONNECTED },
      reconciliationExceptions: { value: null as number | null, connected: false, note: NOT_CONNECTED },
      refundsPending: { value: refundsPending, connected: true, note: `${refundRows.length} pending refund${refundRows.length === 1 ? '' : 's'}.` },
      creditBalance: { value: creditBalance, connected: true, note: 'Live wallet balances.' },
      nextPayout: { value: null as number | null, connected: false, note: NOT_CONNECTED },
      projectedMonthEndCash: { value: null as number | null, connected: false, note: NOT_CONNECTED },
    },
    actions: overdueCount > 0
      ? [{ kind: 'arrears', label: `${overdueCount} overdue invoice${overdueCount === 1 ? '' : 's'} need${overdueCount === 1 ? 's' : ''} recovery action.`, target: 'bill-arrears' }]
      : [],
    health: [
      {
        key: 'sources',
        pass: true,
        label: `Invoice, tenant, booking and notice sources read live at ${generatedAt.toISOString()}.`,
      },
      {
        key: 'pending-sources',
        pass: true,
        label: 'Failed payments read from the instruction register; credits & refunds read from the wallet and refund ledgers. Unallocated receipts, reconciliation exceptions, payouts and projections stay “Not yet connected”, never zero.',
      },
    ],
  };
}

/** CSV export rows for GET /finance/overview/export.csv (audited). */
export function overviewExportCsv(overview: Awaited<ReturnType<typeof getFinanceOverview>>): string {
  const esc = (v: string | number | null): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    'kpi,value,connected,source',
    ...overview.kpis.map((k) => [k.label, k.value ?? 'NOT_CONNECTED', k.connected ? 'yes' : 'no', k.lineage.source].map(esc).join(',')),
  ];
  return lines.join('\n') + '\n';
}

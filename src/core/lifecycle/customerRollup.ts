// Customer roll-up read model (Track A, phase A6, handoff §§7/11.12/13).
//
// One additive read across every rental in the identity group — current
// units AND previous units (RentalUnitHistory written by move-out completion
// and transfer posting) — so multi-unit mixes roll up correctly: two
// concurrent units, a unit changed mid-cycle via transfer, and ended rentals
// with no future deduction. Money goes through toNum; dates are YYYY-MM-DD.
// This module never writes and never changes existing response shapes —
// getCustomerProfile() spreads these keys additively.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { toNum } from '../../lib/format';
import { currentBranchScope } from '../../lib/facilityScope';
import { normalizeEmail } from '../customers';
import {
  RENTAL_EDITOR_STATUS_LABELS,
  deriveCustomerStatus,
  displayRentalStatus,
} from './rentalStatus';

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

const ROLLUP_UNIT_INCLUDE = { unit: { include: { size: true, branch: true, floor: true } }, branch: true } as const;
type RollupTenant = Prisma.TenantGetPayload<{ include: typeof ROLLUP_UNIT_INCLUDE }>;

/** Identity group: every Tenant row sharing the primary's normalised email. */
async function identityGroup(tenantId: string): Promise<RollupTenant[]> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, include: ROLLUP_UNIT_INCLUDE });
  if (!t) throw new AppError(404, 'NOT_FOUND', `Customer ${tenantId} not found`);
  const scope = currentBranchScope();
  if (scope) {
    const branchId = t.unit?.branchId ?? t.branchId;
    if (branchId && !scope.includes(branchId)) throw new AppError(404, 'NOT_FOUND', `Customer ${tenantId} not found`);
  }
  const email = t.email ? normalizeEmail(t.email) : null;
  if (!email) return [t];
  const rows = await prisma.tenant.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    include: ROLLUP_UNIT_INCLUDE,
    orderBy: { createdAt: 'asc' },
  });
  return [t, ...rows.filter((r) => r.id !== t.id)];
}

/** Open settlement statuses (new lifecycle + legacy PENDING). */
const OPEN_SETTLEMENT_STATUSES = ['PENDING', 'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED', 'PROCESSING'];

export interface RollupCurrentRental {
  tenantId: string;
  unitId: string;
  unitCode: string;
  unitName: string;
  facility: string | null;
  status: string;
  displayStatus: keyof typeof RENTAL_EDITOR_STATUS_LABELS;
  displayStatusLabel: string;
  accessRestricted: boolean;
  version: number;
  moveIn: string | null;
  nextPayment: string | null;
  netRent: number;
  grossRent: number;
  protectionMonthly: number | null;
  deposit: number;
  monthlyTotal: number;
  openSettlements: Array<{ ref: string; docType: string; amount: number; status: string }>;
}

export interface RollupPreviousRental {
  tenantId: string;
  unitId: string;
  unitCode: string;
  unitName: string | null;
  facility: string | null;
  status: 'FORMER_CUSTOMER';
  statusLabel: string;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string;
  replacementUnitCode: string | null;
  pricingSnapshot: unknown;
  billedTotals: unknown;
  transferCredit: number | null;
  sourceRef: string | null;
}

export interface CustomerRollup {
  customerId: string;
  derivedStatus: keyof typeof RENTAL_EDITOR_STATUS_LABELS;
  derivedStatusLabel: string;
  rentals: RollupCurrentRental[];
  previousRentals: RollupPreviousRental[];
  transferHistory: Array<{
    id: string; ref: string; docType: string; tenantId: string;
    fromUnitCode: string | null; toUnitCode: string | null;
    effectiveDate: string | null; amount: number; status: string;
  }>;
  ledgerLines: Array<{
    id: string; entryType: string; label: string;
    debit: number | null; credit: number | null; currency: string;
    status: string; postedAt: Date; processorRef: string | null;
    settlementRef: string | null; invoiceRef: string | null; unitCode: string | null;
  }>;
  documents: Array<{
    id: string; ref: string; docType: string; kind: string;
    date: string | null; amount: number; amountPaid: number | null; status: string;
  }>;
  openSettlements: Array<{ ref: string; docType: string; amount: number; status: string }>;
  totals: {
    currency: 'SGD';
    activeRent: number;
    protectionMonthly: number;
    monthlyRecurring: number;
    depositsHeld: number;
    openSettlementBalance: number;
    openSettlementCount: number;
    ledgerDebits: number;
    ledgerCredits: number;
    outstandingInvoices: number;
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function getCustomerRollup(tenantId: string): Promise<CustomerRollup> {
  const group = await identityGroup(tenantId);
  const primary = group[0];
  const tenantIds = group.map((g) => g.id);

  const [settlements, histories, ledgerEntries, invoices, leads] = await Promise.all([
    prisma.customerSettlement.findMany({ where: { tenantId: { in: tenantIds } }, orderBy: { createdAt: 'desc' } }),
    prisma.rentalUnitHistory.findMany({
      where: { tenantId: { in: tenantIds } },
      include: {
        unit: { select: { unitCode: true, name: true, branch: { select: { name: true } } } },
        sourceSettlement: { select: { ref: true } },
      },
      orderBy: { endedAt: 'desc' },
    }),
    prisma.customerLedgerEntry.findMany({
      where: { tenantId: { in: tenantIds } },
      include: {
        unit: { select: { unitCode: true } },
        settlement: { select: { ref: true } },
        invoice: { select: { invoiceNo: true } },
      },
      orderBy: { postedAt: 'desc' },
    }),
    prisma.invoice.findMany({
      where: { tenantId: { in: tenantIds }, voidedAt: null },
      select: { id: true, invoiceNo: true, billedMonth: true, amount: true, amountPaid: true, status: true },
      orderBy: { billedMonth: 'desc' },
      take: 120,
    }),
    primary.email
      ? prisma.lead.findMany({
          where: { emailNorm: normalizeEmail(primary.email), protectionCost: { not: null } },
          orderBy: { updatedAt: 'desc' },
          select: { unitCode: true, protectionCost: true },
        })
      : [],
  ]);
  const protectionByUnit = new Map<string, number>();
  for (const l of leads) {
    if (l.unitCode && l.protectionCost != null && !protectionByUnit.has(l.unitCode)) {
      protectionByUnit.set(l.unitCode, toNum(l.protectionCost));
    }
  }

  const rentals: RollupCurrentRental[] = group
    .filter((g) => g.unitId && g.unit)
    .map((g) => {
      const display = displayRentalStatus(g.status, g.accessRestricted);
      const prot = protectionByUnit.get(g.unit!.unitCode) ?? null;
      return {
        tenantId: g.id,
        unitId: g.unitId!,
        unitCode: g.unit!.unitCode,
        unitName: g.unit!.name ?? g.unit!.unitCode,
        facility: g.unit!.branch?.name ?? g.branch?.name ?? null,
        status: g.status,
        displayStatus: display,
        displayStatusLabel: RENTAL_EDITOR_STATUS_LABELS[display],
        accessRestricted: g.accessRestricted,
        version: g.version,
        moveIn: ymd(g.moveInDate),
        nextPayment: ymd(g.nextPayment),
        netRent: toNum(g.monthlyRate),
        grossRent: toNum(g.unit!.monthlyRate),
        protectionMonthly: prot,
        deposit: 0, // launch policy: security deposits $0
        monthlyTotal: r2(toNum(g.monthlyRate) + (prot ?? 0)),
        openSettlements: settlements
          .filter((s) => s.tenantId === g.id && OPEN_SETTLEMENT_STATUSES.includes(s.status))
          .map((s) => ({ ref: s.ref, docType: s.docType, amount: toNum(s.amount), status: s.status })),
      };
    });

  const replacementIds = [...new Set(histories.map((h) => h.replacementUnitId).filter(Boolean))] as string[];
  const replacementUnits = replacementIds.length
    ? await prisma.unit.findMany({ where: { id: { in: replacementIds } }, select: { id: true, unitCode: true } })
    : [];
  const replacementCode = new Map(replacementUnits.map((u) => [u.id, u.unitCode]));
  const previousRentals: RollupPreviousRental[] = histories.map((h) => ({
    tenantId: h.tenantId,
    unitId: h.unitId,
    unitCode: h.unit.unitCode,
    unitName: h.unit.name ?? h.unit.unitCode,
    facility: h.unit.branch?.name ?? null,
    status: 'FORMER_CUSTOMER' as const,
    statusLabel: 'Former customer',
    startedAt: ymd(h.startedAt),
    endedAt: ymd(h.endedAt),
    endReason: h.endReason,
    replacementUnitCode: h.replacementUnitId ? (replacementCode.get(h.replacementUnitId) ?? null) : null,
    pricingSnapshot: h.pricingSnapshot,
    billedTotals: h.billedTotals,
    transferCredit: h.transferCredit != null ? toNum(h.transferCredit) : null,
    sourceRef: h.sourceSettlement?.ref ?? null,
  }));

  // Transfer history: posted/executed transfers plus every TRANSFER approval
  // record — the same transfer ID links the pending reference and the posted
  // outcome, with the previous-unit history row as the immutable segment.
  const transferSettlements = settlements.filter((s) => s.kind === 'TRANSFER');
  const transferUnitCodes = new Map<string, string>();
  if (transferSettlements.length) {
    const unitIds = [...new Set(transferSettlements.flatMap((s) => [s.unitId, s.toUnitId]).filter(Boolean))] as string[];
    if (unitIds.length) {
      const units = await prisma.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, unitCode: true } });
      for (const u of units) transferUnitCodes.set(u.id, u.unitCode);
    }
  }
  const transferHistory = transferSettlements.map((s) => ({
    id: s.id,
    ref: s.ref,
    docType: s.docType,
    tenantId: s.tenantId,
    fromUnitCode: transferUnitCodes.get(s.unitId) ?? null,
    toUnitCode: s.toUnitId ? (transferUnitCodes.get(s.toUnitId) ?? null) : null,
    effectiveDate: ymd(s.effectiveDate),
    amount: toNum(s.amount),
    status: s.status,
  }));

  const ledgerLines = ledgerEntries.map((l) => ({
    id: l.id,
    entryType: l.entryType,
    label: l.label,
    debit: l.debit != null ? toNum(l.debit) : null,
    credit: l.credit != null ? toNum(l.credit) : null,
    currency: l.currency,
    status: l.status,
    postedAt: l.postedAt,
    processorRef: l.processorRef,
    settlementRef: l.settlement?.ref ?? null,
    invoiceRef: l.invoice?.invoiceNo ?? null,
    unitCode: l.unit?.unitCode ?? null,
  }));

  const documents = [
    ...settlements.map((s) => ({
      id: s.id, ref: s.ref, docType: s.docType, kind: 'settlement' as const,
      date: ymd(s.createdAt), amount: toNum(s.amount), amountPaid: null as number | null, status: s.status,
    })),
    ...invoices.map((i) => ({
      id: i.id, ref: i.invoiceNo, docType: 'Invoice', kind: 'invoice' as const,
      date: ymd(i.billedMonth), amount: toNum(i.amount),
      amountPaid: i.amountPaid != null ? toNum(i.amountPaid) : null, status: i.status,
    })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const openSettlements = settlements
    .filter((s) => OPEN_SETTLEMENT_STATUSES.includes(s.status))
    .map((s) => ({ ref: s.ref, docType: s.docType, amount: toNum(s.amount), status: s.status }));

  const activeRent = r2(rentals.reduce((n, r) => n + r.netRent, 0));
  const protectionMonthly = r2(rentals.reduce((n, r) => n + (r.protectionMonthly ?? 0), 0));
  const totals = {
    currency: 'SGD' as const,
    activeRent,
    protectionMonthly,
    monthlyRecurring: r2(activeRent + protectionMonthly),
    depositsHeld: 0,
    openSettlementBalance: r2(openSettlements.reduce((n, s) => n + s.amount, 0)),
    openSettlementCount: openSettlements.length,
    ledgerDebits: r2(ledgerLines.reduce((n, l) => n + (l.debit ?? 0), 0)),
    ledgerCredits: r2(ledgerLines.reduce((n, l) => n + (l.credit ?? 0), 0)),
    outstandingInvoices: r2(
      invoices
        .filter((i) => i.status === 'DUE' || i.status === 'OVERDUE')
        .reduce((n, i) => n + (toNum(i.amount) - (i.amountPaid != null ? toNum(i.amountPaid) : 0)), 0),
    ),
  };

  const derivedStatus = deriveCustomerStatus(group.map((g) => ({ status: g.status, accessRestricted: g.accessRestricted })));

  return {
    customerId: primary.id,
    derivedStatus,
    derivedStatusLabel: RENTAL_EDITOR_STATUS_LABELS[derivedStatus],
    rentals,
    previousRentals,
    transferHistory,
    ledgerLines,
    documents,
    openSettlements,
    totals,
  };
}

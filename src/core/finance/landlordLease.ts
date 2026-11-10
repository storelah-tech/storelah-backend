// Landlord lease — governed committed-term write path (lease horizon P4).
//
// Thin-route contract: routes parse/validate envelopes and call these
// functions; every business rule lives here. Owned by the FINANCE aggregate.
//
// Update flow (§5): permission (route table: bill-lease:update) + facility
// scope (Prisma extension scopes every FinancialModel read — out-of-scope
// behaves as NOT_FOUND) → rollout gate (finance.leaseHorizon.rollout) →
// DRAFT check (D4A: CURRENT/PENDING are never mutated — the first edit
// auto-creates an identifiable child draft, routes into it and reports
// `Editing draft based on approved version {v}`) → version CAS via a
// conditional write (409 with the handoff conflict copy) → idempotency replay
// by (modelId, idempotencyKey) returning the FIRST result without
// re-projecting → validate 422 VALIDATION + per-field details (§12.1) →
// derive schedule + project() (failure = 422, no write) → MonthClose-block
// check (shortening before the latest posted actuals → 409, no rebase in v1)
// → single $transaction (inputs with v2 lease block + mirrored horizonMonths,
// version bump, calculationStatus=PENDING, audit MODEL_LEASE_HORIZON_UPDATED,
// event financial_model.lease_horizon.updated, calculation row) → AFTER
// COMMIT run valuation try/catch → conditional write on modelVersion (stale
// discarded) → return revision + calculationStatus. A valuation-step failure
// keeps the saved lease and returns calculationStatus FAILED with the handoff
// "lease was saved, but…" message.
//
// Valuation-step failures can also be forced deterministically: saving a
// valuation methodology whose inputs are incomplete (e.g. WACC without all
// five financing inputs) stores fine but fails the compute step — the
// supported LH17 fixture path (save now, complete later).
//
// OpenAPI: NO entries — the booking-only spec (src/lib/openapi.ts) carries no
// CMS finance routes by precedent; the decision is recorded there + in-report.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { writeAuditEvent } from './audit';
import { publishFinanceEvent } from './events';
import { nextVersion, newCorrelationId } from './idempotency';
import { getFinancePolicies } from './policies';
import { latestClosedFiscalMonth } from './monthClose';
import {
  addMonthsForLeaseEnd,
  committedEndDate,
  daysInMonth,
  parseISODate,
  upcastInputs,
  validateRentFree,
  type ProrationMethod,
  type UpcastSource,
} from './leaseTerm';
import {
  ENGINE_VERSION_V2,
  hasV2LeaseBlock,
  project,
  type ProjectionInput,
  type ProjectionResult,
  type V2LeaseScheduleRow,
} from './projection';
import {
  DEFAULT_VALUATION_ASSUMPTIONS,
  analyse,
  buildCashFlowSeries,
  dcfRows,
  effectiveAnnualRate,
  methodologyInputsOf,
  seriesInputsOf,
  solveIrr,
  type ValuationAssumptions,
} from './valuation';
import { duplicateModel } from './library';

const CONFLICT_COPY = 'This model was changed by another user. Reload the latest version before updating.';
const RANGE_COPY = 'Committed lease term must be between 12 and 120 months.';
const INCOMPLETE_SCHEDULE_COPY =
  'Lease schedule is incomplete for the extended term. Review the estimated lease-year amounts before updating.';
const RECALC_FAILURE_COPY =
  'The lease was saved, but investment returns could not be recalculated. Retry calculation or contact Finance support.';
const STALE_RETURNS_COPY =
  'Returns are out of date — investment returns have not been recalculated for the latest lease term.';

function fieldError(field: string, message: string, extra?: Record<string, unknown>): AppError {
  return new AppError(422, 'VALIDATION', message, { fieldErrors: { [field]: [message] }, field, ...(extra ?? {}) });
}

function isP2002(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

function isP2025(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2025';
}

function p2002Targets(e: unknown): string[] {
  const t = (e as { meta?: { target?: unknown } }).meta?.target;
  return Array.isArray(t) ? t.map(String) : [];
}

/** Rollout gate for the whole lease-horizon write path (owner D11A). */
export async function requireLeaseWriteRollout(isOwner: boolean): Promise<void> {
  const { leaseHorizonRollout } = await getFinancePolicies();
  if (leaseHorizonRollout === 'off') {
    throw new AppError(
      409,
      'BLOCKED',
      'Lease-horizon editing is not enabled yet (finance.leaseHorizon.rollout is off).',
      { policy: 'finance.leaseHorizon.rollout' },
    );
  }
  if (leaseHorizonRollout === 'admins' && !isOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Lease-horizon editing is limited to Owners while the rollout is admins-only.');
  }
}

// ---------- stored-shape helpers ----------

interface StoredLease {
  monthlyByYear: number[];
  rentFreeMonths: number;
  ufaSqft?: number;
  startDate?: string;
  committedTermMonths?: number;
  committedEndDate?: string;
  rentFreeStartDate?: string | null;
  rentFreeEndDate?: string | null;
  prorationMethod?: ProrationMethod;
  currency?: string;
  schedule?: V2LeaseScheduleRow[];
  legacyRentFreeMonths?: number;
  [k: string]: unknown;
}

function toProjectionInput(raw: unknown): ProjectionInput {
  if (!raw || typeof raw !== 'object') throw new AppError(400, 'VALIDATION', 'Model inputs snapshot is missing or corrupt.');
  return raw as ProjectionInput;
}

function storedLeaseOf(inputs: ProjectionInput): StoredLease {
  const lease = (inputs as unknown as { lease?: StoredLease }).lease;
  if (!lease || typeof lease !== 'object') throw new AppError(400, 'VALIDATION', 'Model inputs snapshot is missing its lease block.');
  return lease;
}

function readValuation(inputs: ProjectionInput): ValuationAssumptions {
  const v = (inputs as unknown as { valuation?: ValuationAssumptions }).valuation;
  if (!v || typeof v !== 'object') return { ...DEFAULT_VALUATION_ASSUMPTIONS };
  return v;
}

/** Clone the stored inputs as the editable base: v2 blocks are used as-is,
 * v1 snapshots are upcast on READ (never written back as history). */
function editableBase(stored: ProjectionInput): ProjectionInput {
  if (hasV2LeaseBlock(stored)) return JSON.parse(JSON.stringify(stored)) as ProjectionInput;
  return upcastInputs(stored as unknown as UpcastSource) as unknown as ProjectionInput;
}

/** Last day (inclusive) of a YYYY-MM fiscal month. */
function fiscalMonthEndDay(fiscalMonth: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(fiscalMonth);
  if (!m) throw new AppError(400, 'VALIDATION', `fiscalMonth must be YYYY-MM, got ${fiscalMonth}.`);
  const y = Number(m[1]);
  const m1 = Number(m[2]);
  return `${m[1]}-${m[2]}-${String(daysInMonth(y, m1)).padStart(2, '0')}`;
}

// ---------- request shapes (routes pass the raw body through) ----------

export interface LeaseScheduleInputRow {
  leaseYear?: unknown;
  monthlyRent?: unknown;
  source?: unknown;
  confirmed?: unknown;
}

export interface LandlordLeaseUpdateBody {
  version?: unknown;
  leaseStartDate?: unknown;
  committedTermMonths?: unknown;
  rentFreeStartDate?: unknown;
  rentFreeEndDate?: unknown;
  prorationMethod?: unknown;
  currency?: unknown;
  ufaSqft?: unknown;
  schedule?: unknown;
  draftName?: unknown;
  note?: unknown;
  /** Accepted and IGNORED: the server always derives the end date (D1B). */
  committedEndDate?: unknown;
  /** Accepted and IGNORED: the legacy whole-month value is retained in the
   * audit record only (owner D3A), never edited here. */
  rentFreeMonths?: unknown;
}

export interface ValuationUpdateBody {
  version?: unknown;
  methodology?: unknown;
  manualAnnualRate?: unknown;
  baseReturn?: unknown;
  businessRisk?: unknown;
  leaseRisk?: unknown;
  executionRisk?: unknown;
  costEquity?: unknown;
  costDebt?: unknown;
  equityWeight?: unknown;
  debtWeight?: unknown;
  taxRate?: unknown;
  renewalEnabled?: unknown;
  renewalMonths?: unknown;
  includeTerminalCashFlows?: unknown;
  refundableDeposit?: unknown;
  reinstatementCost?: unknown;
  otherTerminalCashFlow?: unknown;
  note?: unknown;
}

// ---------- validated commands ----------

interface ValidLeaseCommand {
  expectedVersion: number;
  leaseStartDate: string;
  committedTermMonths: number;
  rentFreeStartDate: string | null;
  rentFreeEndDate: string | null;
  prorationMethod: ProrationMethod;
  currency: string;
  ufaSqft: number | undefined;
  schedule: V2LeaseScheduleRow[];
  draftName: string | undefined;
  note: string | undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

function requireVersion(body: { version?: unknown }): number {
  if (!Number.isInteger(body.version)) {
    throw fieldError('version', 'rowVersion (version) is required and must be an integer — reload the model and retry.');
  }
  return body.version as number;
}

function parseDateField(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw fieldError(field, `${label} is required (YYYY-MM-DD).`);
  try {
    parseISODate(value.trim(), label);
  } catch (e) {
    const message = e instanceof AppError ? e.message : `${label} must be YYYY-MM-DD.`;
    throw fieldError(field, message);
  }
  return value.trim();
}

function parseOptionalDate(value: unknown, field: string, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw fieldError(field, `${label} must be YYYY-MM-DD or empty.`);
  return parseDateField(value, field, label);
}

function assertCentsInput(n: number, field: string, label: string, allowNegative: boolean): void {
  if (!Number.isFinite(n)) throw fieldError(field, `${label} must be a finite number.`);
  if (!allowNegative && n < 0) throw fieldError(field, `${label} cannot be negative.`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw fieldError(field, `${label} must have at most two decimal places (SGD cents), got ${n}.`);
  }
}

function validateScheduleRows(raw: unknown): LeaseScheduleInputRow[] {
  if (!Array.isArray(raw)) throw fieldError('schedule', 'schedule must be an array with one row per committed lease year.');
  const problems: Record<string, string[]> = {};
  const rows = raw as LeaseScheduleInputRow[];
  rows.forEach((r, i) => {
    const key = `schedule[${i}]`;
    if (!r || typeof r !== 'object') {
      (problems[key] ??= []).push('Each schedule row must be an object.');
      return;
    }
    if (!Number.isInteger(r.leaseYear) || (r.leaseYear as number) < 1) {
      (problems[key] ??= []).push('leaseYear must be a whole number starting at 1.');
    }
    if (typeof r.monthlyRent !== 'number' || !Number.isFinite(r.monthlyRent)) {
      (problems[key] ??= []).push('monthlyRent must be a finite number.');
    } else {
      if ((r.monthlyRent as number) < 0) (problems[key] ??= []).push('monthlyRent cannot be negative.');
      if (Math.abs((r.monthlyRent as number) * 100 - Math.round((r.monthlyRent as number) * 100)) > 1e-6) {
        (problems[key] ??= []).push(`monthlyRent must have at most two decimal places (SGD cents), got ${r.monthlyRent}.`);
      }
    }
    if (r.source !== 'contract' && r.source !== 'user_entered' && r.source !== 'estimated') {
      (problems[key] ??= []).push('source must be contract, user_entered or estimated.');
    }
    if (typeof r.confirmed !== 'boolean') (problems[key] ??= []).push('confirmed must be true or false.');
  });
  const years = rows.map((r) => r.leaseYear);
  const dupes = years.filter((y, i) => years.indexOf(y) !== i);
  if (dupes.length) (problems['schedule'] ??= []).push(`Duplicate schedule lease years: ${[...new Set(dupes)].join(', ')}.`);
  if (Object.keys(problems).length) {
    throw new AppError(422, 'VALIDATION', 'Lease schedule rows are invalid.', { fieldErrors: problems, field: 'schedule' });
  }
  return rows;
}

async function validateLeaseCommand(body: LandlordLeaseUpdateBody): Promise<ValidLeaseCommand> {
  const expectedVersion = requireVersion(body);
  const leaseStartDate = parseDateField(body.leaseStartDate, 'leaseStartDate', 'Lease commencement date');

  const { leaseHorizonMinTermMonths: minTerm, leaseHorizonMaxTermMonths: maxTerm } = await getFinancePolicies();
  const termRaw = body.committedTermMonths;
  if (typeof termRaw !== 'number' || !Number.isFinite(termRaw)) {
    throw fieldError('committedTermMonths', 'Committed lease term is required and must be a whole number of months.');
  }
  if (!Number.isInteger(termRaw)) {
    throw fieldError(
      'committedTermMonths',
      `Committed lease term must be a whole number of months — decimals such as ${termRaw} are rejected so the contractual duration is never silently changed.`,
    );
  }
  if (termRaw < minTerm || termRaw > maxTerm) {
    const copy = minTerm === 12 && maxTerm === 120 ? RANGE_COPY : `Committed lease term must be between ${minTerm} and ${maxTerm} months.`;
    throw fieldError('committedTermMonths', copy);
  }
  const committedTermMonths = termRaw;

  const methodRaw = body.prorationMethod === undefined ? 'actual_days' : body.prorationMethod;
  if (methodRaw !== 'actual_days' && methodRaw !== '30_day' && methodRaw !== 'full_month') {
    throw fieldError('prorationMethod', 'prorationMethod must be actual_days, 30_day or full_month.');
  }
  const currency = body.currency === undefined ? 'SGD' : body.currency;
  if (currency !== 'SGD') throw fieldError('currency', 'currency must be SGD.');

  let ufaSqft: number | undefined;
  if (body.ufaSqft !== undefined) {
    if (typeof body.ufaSqft !== 'number' || !Number.isFinite(body.ufaSqft) || body.ufaSqft < 0) {
      throw fieldError('ufaSqft', 'Usable floor area must be a non-negative number of sq ft.');
    }
    ufaSqft = body.ufaSqft;
  }

  const rentFreeStartDate = parseOptionalDate(body.rentFreeStartDate, 'rentFreeStartDate', 'Rent-free start date');
  const rentFreeEndDate = parseOptionalDate(body.rentFreeEndDate, 'rentFreeEndDate', 'Rent-free end date');
  if ((rentFreeStartDate === null) !== (rentFreeEndDate === null)) {
    throw fieldError('rentFreeEndDate', 'Rent-free start and end dates must both be set or both be empty.');
  }

  const rows = validateScheduleRows(body.schedule);
  const byYear = new Map<number, LeaseScheduleInputRow>();
  for (const r of rows) byYear.set(r.leaseYear as number, r);

  const committedEnd = committedEndDate(leaseStartDate, committedTermMonths);
  const rfProblems = validateRentFree(
    rentFreeStartDate && rentFreeEndDate ? { startDate: rentFreeStartDate, endDate: rentFreeEndDate } : null,
    leaseStartDate,
    committedEnd,
  );
  if (rfProblems.length) throw fieldError('rentFreeEndDate', rfProblems.join(' '));

  // Server-derived schedule: periods always come from start + term (client
  // dates are never trusted). Missing years are prefilled from the last
  // entered rent as unconfirmed estimated rows — the LH07 gate below then
  // blocks Update until each is confirmed. Years beyond the term are kept as
  // excluded rows so re-extension stays possible.
  const needYears = Math.ceil(committedTermMonths / 12);
  const serverRows: V2LeaseScheduleRow[] = [];
  let lastRent: number | null = null;
  for (let k = 1; k <= needYears; k++) {
    const row = byYear.get(k);
    const periodStart = addMonthsForLeaseEnd(leaseStartDate, (k - 1) * 12);
    const periodEnd = k * 12 >= committedTermMonths ? committedEnd : committedEndDate(leaseStartDate, k * 12);
    if (row) {
      lastRent = row.monthlyRent as number;
      serverRows.push({
        leaseYear: k,
        periodStart,
        periodEnd,
        monthlyRent: row.monthlyRent as number,
        source: row.source as V2LeaseScheduleRow['source'],
        confirmed: row.confirmed as boolean,
      });
    } else if (lastRent !== null) {
      serverRows.push({ leaseYear: k, periodStart, periodEnd, monthlyRent: lastRent, source: 'estimated', confirmed: false });
    } else {
      throw fieldError(
        'schedule',
        `Lease year ${k} of ${needYears} has no rent row and no earlier rent to carry forward — provide at least the year-1 monthly rent.`,
        { leaseYear: k, needYears },
      );
    }
  }
  for (const [year, row] of byYear) {
    if (year > needYears) {
      serverRows.push({
        leaseYear: year,
        periodStart: addMonthsForLeaseEnd(leaseStartDate, (year - 1) * 12),
        periodEnd: committedEndDate(leaseStartDate, year * 12),
        monthlyRent: row.monthlyRent as number,
        source: row.source as V2LeaseScheduleRow['source'],
        confirmed: row.confirmed as boolean,
        excluded: true,
      });
    }
  }
  serverRows.sort((a, b) => a.leaseYear - b.leaseYear);

  // LH07 estimated gate: every committed year needs a contract, user-entered
  // or CONFIRMED-estimated row — an inferred rent never counts as contractual.
  const unconfirmed = serverRows.filter(
    (r) => !r.excluded && !(r.source === 'contract' || r.source === 'user_entered' || (r.source === 'estimated' && r.confirmed)),
  );
  if (unconfirmed.length) {
    throw new AppError(422, 'VALIDATION', INCOMPLETE_SCHEDULE_COPY, {
      code: 'LEASE_SCHEDULE_UNCONFIRMED',
      field: 'schedule',
      fieldErrors: {
        schedule: [INCOMPLETE_SCHEDULE_COPY],
        ...Object.fromEntries(unconfirmed.map((r) => [`schedule[${r.leaseYear - 1}]`, ['Confirm this estimated rent before updating.'] as string[]])),
      },
      leaseYear: unconfirmed[0].leaseYear,
      schedule: serverRows,
    });
  }

  const draftName = body.draftName === undefined ? undefined : String(body.draftName).trim() || undefined;
  if (draftName !== undefined && draftName.length > 120) throw fieldError('draftName', 'Draft name must be at most 120 characters.');
  const note = body.note === undefined ? undefined : String(body.note);
  if (note !== undefined && note.length > 500) throw fieldError('note', 'Change note must be at most 500 characters.');

  return {
    expectedVersion,
    leaseStartDate,
    committedTermMonths,
    rentFreeStartDate,
    rentFreeEndDate,
    prorationMethod: methodRaw,
    currency,
    ufaSqft,
    schedule: serverRows,
    draftName,
    note,
  };
}

// ---------- valuation command ----------

const VALUATION_ALLOWED_KEYS = new Set([
  'version', 'methodology', 'manualAnnualRate',
  'baseReturn', 'businessRisk', 'leaseRisk', 'executionRisk',
  'costEquity', 'costDebt', 'equityWeight', 'debtWeight', 'taxRate',
  'renewalEnabled', 'renewalMonths',
  'includeTerminalCashFlows', 'refundableDeposit', 'reinstatementCost', 'otherTerminalCashFlow',
  'note',
]);

function requireRate(value: unknown, field: string, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) {
    throw fieldError(field, `${label} must be a finite decimal rate between 0 and 10 (0.15 = 15%).`);
  }
  return value;
}

function optionalRate(value: unknown, field: string, label: string): number | null {
  if (value === undefined || value === null) return null;
  return requireRate(value, field, label);
}

function validateValuationCommand(body: ValuationUpdateBody): { expectedVersion: number; assumptions: ValuationAssumptions; note: string | undefined } {
  const raw = asRecord(body);
  const unknownKeys = Object.keys(raw).filter((k) => !VALUATION_ALLOWED_KEYS.has(k));
  if (unknownKeys.length) {
    throw new AppError(422, 'VALIDATION', `Unknown valuation fields: ${unknownKeys.join(', ')}.`, {
      fieldErrors: Object.fromEntries(unknownKeys.map((k) => [k, ['Unknown field.'] as string[]])),
    });
  }
  const expectedVersion = requireVersion(body);
  const methodology = body.methodology;
  if (methodology !== 'manual' && methodology !== 'risk' && methodology !== 'wacc') {
    throw fieldError('methodology', 'methodology must be manual, risk or wacc.');
  }
  const assumptions: ValuationAssumptions = { ...DEFAULT_VALUATION_ASSUMPTIONS, methodology };
  if (methodology === 'manual') {
    if (body.manualAnnualRate === undefined) throw fieldError('manualAnnualRate', 'manualAnnualRate is required for the manual methodology.');
    assumptions.manualAnnualRate = requireRate(body.manualAnnualRate, 'manualAnnualRate', 'manualAnnualRate');
  } else if (methodology === 'risk') {
    for (const [field, label] of [
      ['baseReturn', 'baseReturn'],
      ['businessRisk', 'businessRisk'],
      ['leaseRisk', 'leaseRisk'],
      ['executionRisk', 'executionRisk'],
    ] as const) {
      if (body[field] === undefined) throw fieldError(field, `${label} is required for the risk-adjusted methodology.`);
      (assumptions[field] as number) = requireRate(body[field], field, label);
    }
  } else {
    assumptions.costEquity = optionalRate(body.costEquity, 'costEquity', 'costEquity');
    assumptions.costDebt = optionalRate(body.costDebt, 'costDebt', 'costDebt');
    assumptions.equityWeight = optionalRate(body.equityWeight, 'equityWeight', 'equityWeight');
    assumptions.debtWeight = optionalRate(body.debtWeight, 'debtWeight', 'debtWeight');
    assumptions.taxRate = optionalRate(body.taxRate, 'taxRate', 'taxRate');
    // Partial WACC saves fine (complete it later) — the compute step, not the
    // save step, enforces completeness (named WACC_INPUTS_INCOMPLETE error).
    const weights = [assumptions.equityWeight, assumptions.debtWeight];
    if (weights.every((w) => w !== null)) {
      const sum = (weights[0] as number) + (weights[1] as number);
      if (Math.abs(sum - 1) > 1e-9) throw fieldError('equityWeight', `WACC equity and debt weights must sum to 1, got ${sum}.`);
    }
  }
  if (typeof body.renewalEnabled !== 'boolean') throw fieldError('renewalEnabled', 'renewalEnabled must be true or false.');
  assumptions.renewalEnabled = body.renewalEnabled;
  if (body.renewalEnabled) {
    if (!Number.isInteger(body.renewalMonths) || (body.renewalMonths as number) < 1 || (body.renewalMonths as number) > 120) {
      throw fieldError('renewalMonths', 'renewalMonths must be a whole number of months 1–120 when the renewal scenario is enabled.');
    }
    assumptions.renewalMonths = body.renewalMonths as number;
  } else {
    assumptions.renewalMonths = 0;
  }
  if (typeof body.includeTerminalCashFlows !== 'boolean') {
    throw fieldError('includeTerminalCashFlows', 'includeTerminalCashFlows must be true or false.');
  }
  assumptions.includeTerminalCashFlows = body.includeTerminalCashFlows;
  const deposit = body.refundableDeposit === undefined ? 0 : body.refundableDeposit;
  const reinstatement = body.reinstatementCost === undefined ? 0 : body.reinstatementCost;
  const other = body.otherTerminalCashFlow === undefined ? 0 : body.otherTerminalCashFlow;
  if (typeof deposit !== 'number') throw fieldError('refundableDeposit', 'refundableDeposit must be a number.');
  if (typeof reinstatement !== 'number') throw fieldError('reinstatementCost', 'reinstatementCost must be a number.');
  if (typeof other !== 'number') throw fieldError('otherTerminalCashFlow', 'otherTerminalCashFlow must be a number.');
  assertCentsInput(deposit, 'refundableDeposit', 'refundableDeposit', false);
  assertCentsInput(reinstatement, 'reinstatementCost', 'reinstatementCost', false);
  assertCentsInput(other, 'otherTerminalCashFlow', 'otherTerminalCashFlow', true);
  assumptions.refundableDeposit = deposit;
  assumptions.reinstatementCost = reinstatement;
  assumptions.otherTerminalCashFlow = other;
  const note = body.note === undefined ? undefined : String(body.note);
  if (note !== undefined && note.length > 500) throw fieldError('note', 'Change note must be at most 500 characters.');
  return { expectedVersion, assumptions, note };
}

// ---------- section views ----------

export interface LandlordLeaseSection {
  modelId: string;
  facilityId: string | null;
  leaseStartDate: string;
  committedTermMonths: number;
  committedEndDate: string;
  rentFreeMonths: number;
  legacyRentFreeMonths: number;
  rentFreeStartDate: string | null;
  rentFreeEndDate: string | null;
  prorationMethod: ProrationMethod;
  currency: string;
  ufaSqft: number | null;
  leaseSchedule: V2LeaseScheduleRow[];
  rowVersion: number;
  calculationStatus: string;
  valuation: ValuationAssumptions & { effectiveAnnualRate: number | null };
}

export async function getLandlordLease(modelId: string): Promise<LandlordLeaseSection> {
  const stored = await prisma.financialModel.findUnique({ where: { id: modelId } });
  if (!stored) throw new AppError(404, 'NOT_FOUND', `Financial model ${modelId} not found.`);
  const inputs = toProjectionInput(stored.inputs);
  const base = editableBase(inputs);
  const lease = storedLeaseOf(base);
  const valuation = readValuation(base);
  let effectiveRate: number | null = null;
  try {
    effectiveRate = effectiveAnnualRate(methodologyInputsOf(valuation));
  } catch {
    effectiveRate = null;
  }
  return {
    modelId: stored.id,
    facilityId: stored.branchId,
    leaseStartDate: lease.startDate ?? base.startDate,
    committedTermMonths: lease.committedTermMonths ?? base.horizonMonths,
    committedEndDate: lease.committedEndDate ?? committedEndDate(lease.startDate ?? base.startDate, lease.committedTermMonths ?? base.horizonMonths),
    rentFreeMonths: lease.rentFreeMonths,
    legacyRentFreeMonths: lease.legacyRentFreeMonths ?? lease.rentFreeMonths,
    rentFreeStartDate: lease.rentFreeStartDate ?? null,
    rentFreeEndDate: lease.rentFreeEndDate ?? null,
    prorationMethod: lease.prorationMethod ?? 'actual_days',
    currency: lease.currency ?? 'SGD',
    ufaSqft: lease.ufaSqft ?? null,
    leaseSchedule: (lease.schedule ?? []) as V2LeaseScheduleRow[],
    rowVersion: stored.version,
    calculationStatus: stored.calculationStatus,
    valuation: { ...valuation, effectiveAnnualRate: effectiveRate },
  };
}

// ---------- merged-input build (pure, pre-transaction) ----------

interface ScheduleDiff {
  added: number[];
  changed: Array<{ leaseYear: number; before: number; after: number }>;
  excluded: number[];
  confirmed: number[];
}

function diffSchedules(before: V2LeaseScheduleRow[], after: V2LeaseScheduleRow[]): ScheduleDiff {
  const b = new Map(before.filter((r) => !r.excluded).map((r) => [r.leaseYear, r]));
  const a = new Map(after.filter((r) => !r.excluded).map((r) => [r.leaseYear, r]));
  const added: number[] = [];
  const changed: Array<{ leaseYear: number; before: number; after: number }> = [];
  const confirmed: number[] = [];
  for (const [year, row] of a) {
    const prev = b.get(year);
    if (!prev) {
      added.push(year);
      continue;
    }
    if (prev.monthlyRent !== row.monthlyRent || prev.source !== row.source) {
      changed.push({ leaseYear: year, before: prev.monthlyRent, after: row.monthlyRent });
    }
    if (!prev.confirmed && row.confirmed) confirmed.push(year);
  }
  const excluded = [...b.keys()].filter((year) => {
    const next = a.get(year);
    return !next || (after.find((r) => r.leaseYear === year)?.excluded ?? false);
  });
  return { added, changed, excluded, confirmed };
}

function buildMergedInputs(stored: ProjectionInput, cmd: ValidLeaseCommand): { merged: ProjectionInput; oldTerm: number; oldEnd: string } {
  const base = editableBase(stored);
  const prior = storedLeaseOf(base);
  const oldTerm = prior.committedTermMonths ?? base.horizonMonths;
  const oldEnd = prior.committedEndDate ?? committedEndDate(prior.startDate ?? base.startDate, oldTerm);
  const committedEnd = committedEndDate(cmd.leaseStartDate, cmd.committedTermMonths);

  const lease = storedLeaseOf(base);
  lease.startDate = cmd.leaseStartDate;
  lease.committedTermMonths = cmd.committedTermMonths;
  lease.committedEndDate = committedEnd;
  lease.rentFreeStartDate = cmd.rentFreeStartDate;
  lease.rentFreeEndDate = cmd.rentFreeEndDate;
  lease.prorationMethod = cmd.prorationMethod;
  lease.currency = cmd.currency;
  if (cmd.ufaSqft !== undefined) lease.ufaSqft = cmd.ufaSqft;
  // Carry stored excluded rows beyond the new term that the client did not
  // mention (re-extension stays possible); years within the term are
  // authoritative from the client schedule + server prefill.
  const mentioned = new Set(cmd.schedule.map((r) => r.leaseYear));
  const needYears = Math.ceil(cmd.committedTermMonths / 12);
  const carried = (prior.schedule ?? []).filter((r) => r.leaseYear > needYears && !mentioned.has(r.leaseYear));
  lease.schedule = [...cmd.schedule, ...carried.map((r) => ({ ...r, excluded: true }))].sort((x, y) => x.leaseYear - y.leaseYear) as V2LeaseScheduleRow[];
  // Server mirrors (P4): horizon + per-year rents stay in lock-step until P5.
  (base as ProjectionInput).horizonMonths = cmd.committedTermMonths;
  lease.monthlyByYear = cmd.schedule.filter((r) => !r.excluded).map((r) => r.monthlyRent);
  // D3A: the legacy whole-month value is retained untouched for the audit.
  // A pre-P4 model without valuation assumptions adopts the current new-model
  // default on this revision (recorded in the audit event, never silent).
  const withValuation = base as ProjectionInput & { valuation?: ValuationAssumptions };
  let valuationAdoptedDefault = false;
  if (withValuation.valuation === undefined) {
    withValuation.valuation = { ...DEFAULT_VALUATION_ASSUMPTIONS };
    valuationAdoptedDefault = true;
  }
  (withValuation as unknown as Record<string, unknown>).__valuationAdoptedDefault = valuationAdoptedDefault;
  return { merged: base, oldTerm, oldEnd };
}

/** Engine failures on the lease path surface as 422 (never a silent write). */
function mapEngineError(e: unknown): never {
  if (e instanceof AppError && e.code === 'VALIDATION') {
    const code = (e.details as { code?: string } | undefined)?.code;
    if (code === 'LEASE_SCHEDULE_UNCONFIRMED') {
      throw new AppError(422, 'VALIDATION', INCOMPLETE_SCHEDULE_COPY, e.details);
    }
    if (code === 'CHURN_BEYOND_TERM') {
      throw new AppError(422, 'VALIDATION', e.message, { code, field: 'churnStartMonth', fieldErrors: { churnStartMonth: [e.message] } });
    }
    throw new AppError(422, 'VALIDATION', e.message, e.details);
  }
  throw e;
}

// ---------- after-commit valuation ----------

export interface CalculationOutcome {
  calculationId: string;
  modelVersion: number;
  status: 'CURRENT' | 'FAILED';
  result: Record<string, unknown> | null;
  error: string | null;
  staleDiscarded: boolean;
}

async function finalizeCalculation(opts: {
  modelId: string;
  modelVersion: number;
  inputs: ProjectionInput;
  preview: ProjectionResult;
  actor: string;
}): Promise<CalculationOutcome> {
  const calc = await prisma.financialModelCalculation.findUnique({
    where: { modelId_modelVersion: { modelId: opts.modelId, modelVersion: opts.modelVersion } },
  });
  if (!calc) {
    return { calculationId: '', modelVersion: opts.modelVersion, status: 'FAILED', result: null, error: 'Calculation row is missing.', staleDiscarded: true };
  }
  const fail = async (message: string): Promise<CalculationOutcome> => {
    await prisma.financialModelCalculation.updateMany({
      where: { modelId: opts.modelId, modelVersion: opts.modelVersion },
      data: { status: 'FAILED', error: message, completedAt: new Date() },
    });
    // Conditional on the version: a newer revision owns its own flag — a
    // stale failure must never mark the current revision FAILED.
    await prisma.financialModel.updateMany({
      where: { id: opts.modelId, version: opts.modelVersion },
      data: { calculationStatus: 'FAILED' },
    });
    return { calculationId: calc.id, modelVersion: opts.modelVersion, status: 'FAILED', result: null, error: message, staleDiscarded: false };
  };
  try {
    const assumptions = readValuation(opts.inputs);
    const annualRate = effectiveAnnualRate(methodologyInputsOf(assumptions));
    const series = buildCashFlowSeries(opts.preview, seriesInputsOf(opts.inputs.capitalTotal, assumptions));
    const analysis = analyse(series, annualRate);
    const irr = solveIrr(series);
    const result = {
      annualRate,
      annualRateSource: assumptions.methodology,
      monthlyRate: analysis.monthlyRate,
      npv: analysis.npv,
      cumulativeFreeCashFlow: analysis.cumulativeFreeCashFlow,
      profitabilityIndex: analysis.profitabilityIndex,
      simplePayback: analysis.simplePayback,
      discountedPayback: analysis.discountedPayback,
      paybackMonth: analysis.paybackMonth,
      discountedPaybackMonth: analysis.discountedPaybackMonth,
      irr: { status: irr.status, monthlyRate: irr.monthlyRate, annualRate: irr.annualRate, display: irr.display },
      dcf: dcfRows(series, annualRate),
      seriesMeta: series.metadata,
      inputHash: opts.preview.inputHash,
      engineVersion: opts.preview.engineVersion,
    };
    // Conditional writes on modelVersion: a result that finishes after a
    // newer revision exists is STALE — discarded, never applied.
    const wrote = await prisma.financialModelCalculation.updateMany({
      where: { modelId: opts.modelId, modelVersion: opts.modelVersion },
      data: { status: 'CURRENT', result: result as unknown as Prisma.InputJsonValue, error: null, completedAt: new Date() },
    });
    if (wrote.count === 0) {
      console.warn(`[lease-horizon] stale valuation discarded for ${opts.modelId} v${opts.modelVersion}`);
      return { calculationId: calc.id, modelVersion: opts.modelVersion, status: 'FAILED', result: null, error: 'Stale result discarded.', staleDiscarded: true };
    }
    await prisma.financialModel.updateMany({
      where: { id: opts.modelId, version: opts.modelVersion },
      data: { calculationStatus: 'CURRENT' },
    });
    return { calculationId: calc.id, modelVersion: opts.modelVersion, status: 'CURRENT', result, error: null, staleDiscarded: false };
  } catch (e) {
    const message = e instanceof AppError ? e.message : e instanceof Error ? e.message : 'Valuation failed.';
    return fail(message);
  }
}

// ---------- idempotent replay ----------

interface ReplayHit {
  calc: {
    id: string;
    modelVersion: number;
    status: string;
    result: unknown;
    error: string | null;
    inputHash: string;
  };
  model: { id: string; name: string; version: number; branchId: string | null; status: string; calculationStatus: string };
}

async function findReplay(modelId: string, idempotencyKey: string | null): Promise<ReplayHit | null> {
  if (!idempotencyKey) return null;
  const calc = await prisma.financialModelCalculation.findUnique({
    where: { modelId_idempotencyKey: { modelId, idempotencyKey } },
  });
  if (!calc) return null;
  const model = await prisma.financialModel.findUnique({ where: { id: modelId } });
  if (!model) return null;
  return {
    calc: { id: calc.id, modelVersion: calc.modelVersion, status: calc.status, result: calc.result, error: calc.error, inputHash: calc.inputHash },
    model: { id: model.id, name: model.name, version: model.version, branchId: model.branchId, status: model.status, calculationStatus: model.calculationStatus },
  };
}

// ---------- D4A auto-draft ----------

interface ForkInfo {
  id: string;
  name: string;
  basedOnVersion: number;
  basedOnStatus: string;
  message: string;
}

async function forkDraftIfLocked(
  stored: { id: string; name: string; status: string; version: number },
  actor: string,
  draftName: string | undefined,
): Promise<{ targetId: string; fork: ForkInfo | null }> {
  if (stored.status === 'DRAFT') return { targetId: stored.id, fork: null };
  if (stored.status === 'ARCHIVED') {
    throw new AppError(403, 'LOCKED', `Model "${stored.name}" is ARCHIVED — restore a version to a new draft to continue.`);
  }
  // D4A: CURRENT/PENDING are never mutated. First edit forks an identifiable
  // child draft (prompt-or-default name), routes into it and reports which
  // approved version it was based on. Who/when is recorded by the duplicate
  // audit event (actor + timestamp).
  const siblings = await prisma.financialModel.findMany({
    where: { name: { startsWith: `${stored.name} — Draft` } },
    select: { name: true },
  });
  let next = 1;
  for (const s of siblings) {
    const m = / — Draft (\d+)$/.exec(s.name);
    if (m) next = Math.max(next, Number(m[1]) + 1);
  }
  const name = draftName ?? `${stored.name} — Draft ${next}`;
  const dup = await duplicateModel({
    modelId: stored.id,
    name,
    reason: `Lease edit forked from ${stored.status} version ${stored.version} — Landlord lease update by ${actor}.`,
    actor,
  });
  return {
    targetId: dup.id,
    fork: {
      id: dup.id,
      name: dup.name,
      basedOnVersion: stored.version,
      basedOnStatus: stored.status,
      message: `Editing draft based on approved version ${stored.version}.`,
    },
  };
}

// ---------- PUT landlord-lease ----------

export interface LeaseUpdateResult {
  model: { id: string; name: string; version: number; status: string; branchId: string | null; calculationStatus: string };
  lease: LandlordLeaseSection;
  calculation: { id: string; modelVersion: number; status: string; error: string | null };
  fork: ForkInfo | null;
  replayed: boolean;
  message: string;
  warning: string | null;
}

export async function updateLandlordLease(opts: {
  modelId: string;
  body: LandlordLeaseUpdateBody;
  actor: string;
  actorIsOwner: boolean;
  idempotencyKey: string | null;
}): Promise<LeaseUpdateResult> {
  await requireLeaseWriteRollout(opts.actorIsOwner);
  const cmd = await validateLeaseCommand(opts.body);

  const original = await prisma.financialModel.findUnique({ where: { id: opts.modelId } });
  if (!original) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.modelId} not found.`);

  // Idempotent replay on the ORIGINAL row first (before any version check —
  // a retry resends the SAME rowVersion, and must get the FIRST result, not
  // a 409). This also avoids a double fork when the first attempt already
  // forked + completed on a draft — the draft id is returned so the client
  // retries THERE on subsequent attempts.
  const preReplay = await findReplay(original.id, opts.idempotencyKey);
  if (preReplay) return await replayResult(preReplay, null);

  const { targetId, fork } = await forkDraftIfLocked(original, opts.actor, cmd.draftName);
  const stored = await prisma.financialModel.findUnique({ where: { id: targetId } });
  if (!stored) throw new AppError(404, 'NOT_FOUND', `Financial model ${targetId} not found.`);

  const draftReplay = targetId !== original.id ? null : await findReplay(targetId, opts.idempotencyKey);
  if (draftReplay) return await replayResult(draftReplay, fork);

  // The caller's rowVersion names the revision they read — on CURRENT/PENDING
  // that is the APPROVED revision the fork is based on; on DRAFT it is the
  // revision being edited. Either way a moved version 409s with the handoff
  // conflict copy instead of silently overwriting.
  const readVersion = fork ? original.version : stored.version;
  if (readVersion !== cmd.expectedVersion) {
    throw new AppError(409, 'STALE', CONFLICT_COPY, { entity: 'FinancialModel', expected: cmd.expectedVersion, current: readVersion });
  }

  const inputs = toProjectionInput(stored.inputs);
  const { merged, oldTerm, oldEnd } = buildMergedInputs(inputs, cmd);

  // Failure = 422, no write. Engine-level named errors map to the LH07 /
  // churn copies; anything else keeps its message with a 422 status.
  let preview: ProjectionResult;
  try {
    preview = project(merged);
  } catch (e) {
    mapEngineError(e);
  }

  // Shortening before the latest posted actuals is BLOCKED (no rebase in v1).
  const newEnd = committedEndDate(cmd.leaseStartDate, cmd.committedTermMonths);
  if (stored.branchId && newEnd < oldEnd) {
    const latestClosed = await latestClosedFiscalMonth(stored.branchId);
    if (latestClosed && newEnd < fiscalMonthEndDay(latestClosed)) {
      throw new AppError(
        409,
        'BLOCKED',
        `Cannot shorten the committed term to end ${newEnd} — actuals are already posted through ${latestClosed}. Rebase the model to a new baseline instead (automatic rebase is not available in v1).`,
        { latestClosedFiscalMonth: latestClosed, newCommittedEndDate: newEnd },
      );
    }
  }

  const prior = storedLeaseOf(editableBase(inputs));
  const diff = diffSchedules(prior.schedule ?? [], cmd.schedule);
  const correlationId = newCorrelationId();
  // CAS base is the TARGET revision (the fresh fork is version 0 — the
  // caller's version named the approved revision it was forked from).
  const next = nextVersion(stored.version);
  const legacyRentFreeMonths = prior.legacyRentFreeMonths ?? prior.rentFreeMonths;
  const valuationAdoptedDefault = (merged as unknown as Record<string, unknown>).__valuationAdoptedDefault === true;
  delete (merged as unknown as Record<string, unknown>).__valuationAdoptedDefault;

  let updated: { id: string; name: string; version: number; status: string; branchId: string | null };
  let calcId: string;
  try {
    const committed = await prisma.$transaction(async (tx) => {
      let m: { id: string; name: string; version: number; status: string; branchId: string | null };
      try {
        m = await tx.financialModel.update({
          where: { id: stored.id, version: stored.version },
          data: {
            inputs: merged as unknown as Prisma.InputJsonValue,
            inputHash: preview.inputHash,
            engineVersion: ENGINE_VERSION_V2,
            updatedBy: opts.actor,
            version: next,
            calculationStatus: 'PENDING',
          },
          select: { id: true, name: true, version: true, status: true, branchId: true },
        });
      } catch (e) {
        if (isP2025(e)) {
          const current = await tx.financialModel.findUnique({ where: { id: stored.id }, select: { version: true } });
          throw new AppError(409, 'STALE', CONFLICT_COPY, { entity: 'FinancialModel', expected: stored.version, current: current?.version ?? null });
        }
        throw e;
      }
      await writeAuditEvent(tx, {
        branchId: m.branchId,
        actor: opts.actor,
        action: 'MODEL_LEASE_HORIZON_UPDATED',
        entityType: 'financial-model',
        entityId: m.id,
        before: { version: stored.version, inputHash: stored.inputHash, committedTermMonths: oldTerm, committedEndDate: oldEnd, status: stored.status },
        after: {
          section: 'landlord-lease',
          version: m.version,
          inputHash: preview.inputHash,
          oldCommittedTermMonths: oldTerm,
          newCommittedTermMonths: cmd.committedTermMonths,
          oldCommittedEndDate: oldEnd,
          newCommittedEndDate: newEnd,
          leaseStartDate: cmd.leaseStartDate,
          scheduleChanges: diff,
          legacyRentFreeMonths,
          valuationAdoptedDefault,
          calculationStatus: 'PENDING',
          ...(fork ? { forkedFrom: { modelId: original.id, version: original.version, status: original.status, draftId: fork.id } } : {}),
        },
        reason: cmd.note ?? 'Landlord lease updated',
        source: 'cms',
        correlationId,
      });
      await publishFinanceEvent(tx, {
        type: 'financial_model.lease_horizon.updated',
        payload: {
          modelId: m.id,
          modelVersion: m.version,
          facilityId: m.branchId,
          oldCommittedTermMonths: oldTerm,
          newCommittedTermMonths: cmd.committedTermMonths,
          leaseStartDate: cmd.leaseStartDate,
          oldCommittedEndDate: oldEnd,
          newCommittedEndDate: newEnd,
          actorId: opts.actor,
          occurredAt: new Date().toISOString(),
        },
        branchId: m.branchId,
        correlationId,
      });
      let calc: { id: string };
      try {
        calc = await tx.financialModelCalculation.create({
          data: {
            modelId: m.id,
            modelVersion: m.version,
            engineVersion: ENGINE_VERSION_V2,
            inputHash: preview.inputHash,
            status: 'PENDING',
            idempotencyKey: opts.idempotencyKey,
            actor: opts.actor,
          },
          select: { id: true },
        });
      } catch (e) {
        if (isP2002(e) && opts.idempotencyKey && p2002Targets(e).includes('idempotencyKey')) {
          // Lost the same-key race: the winner owns the FIRST result — replay
          // it instead of writing a second audit event (whole txn rolls back).
          const existing = await tx.financialModelCalculation.findUnique({
            where: { modelId_idempotencyKey: { modelId: m.id, idempotencyKey: opts.idempotencyKey } },
          });
          if (existing) throw new ReplaySignal(existing.id);
        }
        if (isP2002(e)) {
          throw new AppError(409, 'STALE', CONFLICT_COPY, { entity: 'FinancialModel', expected: stored.version });
        }
        throw e;
      }
      return { m, calc };
    });
    updated = committed.m;
    calcId = committed.calc.id;
  } catch (e) {
    if (e instanceof ReplaySignal) {
      const hit = await findReplay(stored.id, opts.idempotencyKey);
      if (hit) return await replayResult(hit, fork);
    }
    throw e;
  }

  // AFTER COMMIT: run the valuation; a stale result (newer revision exists)
  // is discarded, never applied. A valuation failure keeps the saved lease
  // and flips the revision to FAILED with the handoff warning copy.
  const outcome = await finalizeCalculation({ modelId: updated.id, modelVersion: next, inputs: merged, preview, actor: opts.actor });
  const status = outcome.staleDiscarded ? 'PENDING' : outcome.status;
  const warning = outcome.status === 'FAILED' && !outcome.staleDiscarded ? RECALC_FAILURE_COPY : null;
  const lease = await getLandlordLease(updated.id);
  return {
    model: { ...updated, calculationStatus: status },
    lease,
    calculation: { id: outcome.calculationId || calcId, modelVersion: next, status, error: outcome.error },
    fork,
    replayed: false,
    message: `Landlord lease updated to ${cmd.committedTermMonths} months. Forecast horizon, NPV, IRR, payback, monthly lease and budgets are synced.`,
    warning,
  };
}

class ReplaySignal extends Error {
  constructor(readonly calculationId: string) {
    super('idempotent replay');
  }
}

async function replayResult(hit: ReplayHit, fork: ForkInfo | null): Promise<LeaseUpdateResult> {
  // Replay is read-only: reload the CURRENT section view without projecting.
  const lease = await getLandlordLease(hit.model.id);
  return {
    model: { id: hit.model.id, name: hit.model.name, version: hit.model.version, status: hit.model.status, branchId: hit.model.branchId, calculationStatus: hit.model.calculationStatus },
    lease,
    calculation: { id: hit.calc.id, modelVersion: hit.calc.modelVersion, status: hit.calc.status, error: hit.calc.error },
    fork,
    replayed: true,
    message: 'Idempotent replay — the first result is returned without re-projecting.',
    warning: hit.calc.status === 'FAILED' ? RECALC_FAILURE_COPY : null,
  };
}

// ---------- PUT valuation ----------

export interface ValuationUpdateResult {
  model: { id: string; name: string; version: number; status: string; calculationStatus: string };
  valuation: ValuationAssumptions & { effectiveAnnualRate: number | null };
  calculation: { id: string; modelVersion: number; status: string; error: string | null };
  replayed: boolean;
  warning: string | null;
}

export async function updateValuation(opts: {
  modelId: string;
  body: ValuationUpdateBody;
  actor: string;
  actorIsOwner: boolean;
  idempotencyKey: string | null;
}): Promise<ValuationUpdateResult> {
  await requireLeaseWriteRollout(opts.actorIsOwner);
  const { expectedVersion, assumptions, note } = validateValuationCommand(opts.body);

  const stored = await prisma.financialModel.findUnique({ where: { id: opts.modelId } });
  if (!stored) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.modelId} not found.`);
  if (stored.status !== 'DRAFT') {
    throw new AppError(
      403,
      'LOCKED',
      `Model "${stored.name}" is ${stored.status} — valuation assumptions apply to DRAFT models only. Fork a draft through the Landlord lease update first.`,
    );
  }

  const replay = await findReplay(stored.id, opts.idempotencyKey);
  if (replay) {
    return {
      model: { id: replay.model.id, name: replay.model.name, version: replay.model.version, status: replay.model.status, calculationStatus: replay.model.calculationStatus },
      valuation: { ...assumptions, effectiveAnnualRate: null },
      calculation: { id: replay.calc.id, modelVersion: replay.calc.modelVersion, status: replay.calc.status, error: replay.calc.error },
      replayed: true,
      warning: replay.calc.status === 'FAILED' ? RECALC_FAILURE_COPY : null,
    };
  }

  const inputs = toProjectionInput(stored.inputs);
  const merged = editableBase(inputs);
  (merged as unknown as Record<string, unknown>).valuation = { ...assumptions };
  let preview: ProjectionResult;
  try {
    preview = project(merged);
  } catch (e) {
    mapEngineError(e);
  }

  const correlationId = newCorrelationId();
  const next = nextVersion(expectedVersion);
  let updated: { id: string; name: string; version: number; status: string };
  let calcId: string;
  try {
    const committed = await prisma.$transaction(async (tx) => {
      let m: { id: string; name: string; version: number; status: string };
      try {
        m = await tx.financialModel.update({
          where: { id: stored.id, version: expectedVersion },
          data: {
            inputs: merged as unknown as Prisma.InputJsonValue,
            inputHash: preview.inputHash,
            updatedBy: opts.actor,
            version: next,
            calculationStatus: 'PENDING',
          },
          select: { id: true, name: true, version: true, status: true },
        });
      } catch (e) {
        if (isP2025(e)) {
          const current = await tx.financialModel.findUnique({ where: { id: stored.id }, select: { version: true } });
          throw new AppError(409, 'STALE', CONFLICT_COPY, { entity: 'FinancialModel', expected: expectedVersion, current: current?.version ?? null });
        }
        throw e;
      }
      await writeAuditEvent(tx, {
        branchId: stored.branchId,
        actor: opts.actor,
        action: 'MODEL_VALUATION_UPDATED',
        entityType: 'financial-model',
        entityId: m.id,
        before: { version: stored.version, inputHash: stored.inputHash },
        after: { section: 'valuation', version: m.version, inputHash: preview.inputHash, methodology: assumptions.methodology, calculationStatus: 'PENDING' },
        reason: note ?? 'Investment valuation assumptions updated',
        source: 'cms',
        correlationId,
      });
      await publishFinanceEvent(tx, {
        type: 'model.updated',
        payload: { modelId: m.id, section: 'valuation', inputHash: preview.inputHash },
        branchId: stored.branchId,
        correlationId,
      });
      let calc: { id: string };
      try {
        calc = await tx.financialModelCalculation.create({
          data: {
            modelId: m.id,
            modelVersion: m.version,
            engineVersion: preview.engineVersion,
            inputHash: preview.inputHash,
            status: 'PENDING',
            idempotencyKey: opts.idempotencyKey,
            actor: opts.actor,
          },
          select: { id: true },
        });
      } catch (e) {
        if (isP2002(e) && opts.idempotencyKey && p2002Targets(e).includes('idempotencyKey')) {
          const existing = await tx.financialModelCalculation.findUnique({
            where: { modelId_idempotencyKey: { modelId: m.id, idempotencyKey: opts.idempotencyKey } },
          });
          if (existing) throw new ReplaySignal(existing.id);
        }
        if (isP2002(e)) throw new AppError(409, 'STALE', CONFLICT_COPY, { entity: 'FinancialModel', expected: expectedVersion });
        throw e;
      }
      return { m, calc };
    });
    updated = committed.m;
    calcId = committed.calc.id;
  } catch (e) {
    if (e instanceof ReplaySignal) {
      const hit = await findReplay(stored.id, opts.idempotencyKey);
      if (hit) {
        return {
          model: { id: hit.model.id, name: hit.model.name, version: hit.model.version, status: hit.model.status, calculationStatus: hit.model.calculationStatus },
          valuation: { ...assumptions, effectiveAnnualRate: null },
          calculation: { id: hit.calc.id, modelVersion: hit.calc.modelVersion, status: hit.calc.status, error: hit.calc.error },
          replayed: true,
          warning: hit.calc.status === 'FAILED' ? RECALC_FAILURE_COPY : null,
        };
      }
    }
    throw e;
  }

  const outcome = await finalizeCalculation({ modelId: updated.id, modelVersion: next, inputs: merged, preview, actor: opts.actor });
  const status = outcome.staleDiscarded ? 'PENDING' : outcome.status;
  let effective: number | null = null;
  try {
    effective = effectiveAnnualRate(methodologyInputsOf(assumptions));
  } catch {
    effective = null;
  }
  return {
    model: { ...updated, calculationStatus: status },
    valuation: { ...assumptions, effectiveAnnualRate: effective },
    calculation: { id: outcome.calculationId || calcId, modelVersion: next, status, error: outcome.error },
    replayed: false,
    warning: outcome.status === 'FAILED' && !outcome.staleDiscarded ? RECALC_FAILURE_COPY : null,
  };
}

// ---------- POST recalculate (retry only) ----------

export interface RecalculateResult {
  model: { id: string; version: number; status: string; calculationStatus: string };
  calculation: { id: string; modelVersion: number; status: string; error: string | null };
  recalculated: boolean;
  warning: string | null;
}

export async function recalculateModel(opts: {
  modelId: string;
  actor: string;
  actorIsOwner: boolean;
  idempotencyKey: string | null;
}): Promise<RecalculateResult> {
  await requireLeaseWriteRollout(opts.actorIsOwner);
  const stored = await prisma.financialModel.findUnique({ where: { id: opts.modelId } });
  if (!stored) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.modelId} not found.`);

  const replay = await findReplay(stored.id, opts.idempotencyKey);
  if (replay) {
    if (replay.calc.status === 'FAILED') {
      throw new AppError(422, 'VALIDATION', RECALC_FAILURE_COPY, {
        code: 'CALCULATION_FAILED',
        calculationId: replay.calc.id,
        error: replay.calc.error,
      });
    }
    return {
      model: { id: stored.id, version: stored.version, status: stored.status, calculationStatus: stored.calculationStatus },
      calculation: { id: replay.calc.id, modelVersion: replay.calc.modelVersion, status: replay.calc.status, error: replay.calc.error },
      recalculated: false,
      warning: null,
    };
  }

  const existing = await prisma.financialModelCalculation.findUnique({
    where: { modelId_modelVersion: { modelId: stored.id, modelVersion: stored.version } },
  });
  if (existing && existing.status === 'CURRENT') {
    return {
      model: { id: stored.id, version: stored.version, status: stored.status, calculationStatus: stored.calculationStatus },
      calculation: { id: existing.id, modelVersion: existing.modelVersion, status: existing.status, error: existing.error },
      recalculated: false,
      warning: null,
    };
  }

  const inputs = toProjectionInput(stored.inputs);
  let preview: ProjectionResult;
  try {
    preview = project(editableBase(inputs));
  } catch (e) {
    mapEngineError(e);
  }

  if (!existing) {
    await prisma.financialModelCalculation.create({
      data: {
        modelId: stored.id,
        modelVersion: stored.version,
        engineVersion: preview.engineVersion,
        inputHash: preview.inputHash,
        status: 'PENDING',
        idempotencyKey: opts.idempotencyKey,
        actor: opts.actor,
      },
    });
  } else if (opts.idempotencyKey && !existing.idempotencyKey) {
    await prisma.financialModelCalculation.update({
      where: { id: existing.id },
      data: { idempotencyKey: opts.idempotencyKey },
    });
  }

  const outcome = await finalizeCalculation({ modelId: stored.id, modelVersion: stored.version, inputs, preview, actor: opts.actor });
  if (outcome.status === 'FAILED' && !outcome.staleDiscarded) {
    throw new AppError(422, 'VALIDATION', RECALC_FAILURE_COPY, {
      code: 'CALCULATION_FAILED',
      calculationId: outcome.calculationId,
      error: outcome.error,
    });
  }
  const refreshed = await prisma.financialModel.findUnique({ where: { id: stored.id } });
  return {
    model: {
      id: stored.id,
      version: stored.version,
      status: stored.status,
      calculationStatus: refreshed?.calculationStatus ?? stored.calculationStatus,
    },
    calculation: { id: outcome.calculationId, modelVersion: outcome.modelVersion, status: outcome.status, error: outcome.error },
    recalculated: true,
    warning: null,
  };
}

// ---------- export guard (handoff §8.5: stale figures block exports) ----------

/** Exports and approvals that require current figures call this first. */
export async function requireCurrentCalculation(modelId: string): Promise<void> {
  const m = await prisma.financialModel.findUnique({ where: { id: modelId } });
  if (!m) throw new AppError(404, 'NOT_FOUND', `Financial model ${modelId} not found.`);
  if (m.calculationStatus !== 'CURRENT') {
    throw new AppError(409, 'BLOCKED', `${STALE_RETURNS_COPY} Export is disabled until the calculation succeeds — retry the calculation first.`, {
      calculationStatus: m.calculationStatus,
    });
  }
}

import { prisma } from '../lib/prisma';
import { toNum } from '../lib/format';
import { AppError } from '../lib/http';
import { Prisma, UnitStatus } from '@prisma/client';

type UnitWithRelations = Prisma.UnitGetPayload<{
  include: { size: true; branch: true; floor: true; tenant: true };
}>;

export interface CreateUnitInput {
  branchId: string;
  floorId: string;
  sizeId: string;
  sqft: number;
  monthlyRate: number;
  status?: UnitStatus;
  climateControl?: string;
  hasAC?: boolean;
  hasPillar?: boolean;
  // Explicit import-path code: must be a free 4-digit code (e.g. "1001").
  // Omitted in the normal path — codegen mints the next 4-digit code.
  unitCode?: string;
  name?: string;
}

export interface UpdateUnitInput {
  sqft?: number;
  monthlyRate?: number;
  status?: UnitStatus;
  climateControl?: string | null;
  hasAC?: boolean;
  hasPillar?: boolean;
  name?: string | null;
}

// ---------- 4-digit unit codes ----------
//
// Unit codes are exactly 4 digits (1001..9999), globally unique (the schema
// keeps unitCode @unique). Codegen mints the next free code above the current
// MAX across ALL rows (deleted included — codes with history are never
// re-assigned), starting at 1001. FKs (UnitPlacement.unitId, Tenant.unitId,
// Booking/Invoice.unitId) all point at Unit.id, never at the code, so codes
// are cosmetic identity only; Lead.unitCode is a loose (non-FK) reference.
// Legacy BM-01-01 codes are left untouched by codegen; the opt-in rename lives
// in scripts/backfill-unit-codes-4digit.ts (dry-run first).

const FOUR_DIGIT_RE = /^\d{4}$/;
const FIRST_FOUR_DIGIT_CODE = 1001;
const LAST_FOUR_DIGIT_CODE = 9999;

export function isFourDigitCode(code: string): boolean {
  return FOUR_DIGIT_RE.test(code);
}

/** Next free 4-digit code above the max of `existing` (pure — unit-testable). */
export function nextFourDigitCode(existing: string[]): string {
  let max = FIRST_FOUR_DIGIT_CODE - 1;
  for (const c of existing) {
    if (FOUR_DIGIT_RE.test(c)) max = Math.max(max, Number(c));
  }
  const next = max + 1;
  if (next > LAST_FOUR_DIGIT_CODE) {
    throw new AppError(409, 'CONFLICT', 'Unit code space exhausted (1001–9999 all taken)');
  }
  return String(next);
}

/**
 * Legacy climateControl string → hasAC mapping (accept-but-map rule):
 * 'Ambient climate' / ambient-ish strings map to false; strings mentioning
 * climate/air-con map to true; anything else (or empty) maps to null =
 * "no signal, leave hasAC alone". Mirrors isClimateControlled() in
 * src/core/floorPlanMetricsService.ts without importing it (import direction
 * is metrics → units, never back).
 */
export function climateControlToHasAC(climateControl: string | null | undefined): boolean | null {
  if (!climateControl) return null;
  const s = climateControl.toLowerCase();
  if (/(ambient|non-climate|not climate|uncontrolled)/.test(s)) return false;
  if (/(climate|air-con|aircon|conditioned)/.test(s)) return true;
  return null;
}

/** Flexible yes/no cell parsing for the import template (pure — unit-testable). */
export function parseYesNoFlag(raw: string | null | undefined): boolean | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (['yes', 'y', 'true', '1', 'ac'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'non-ac', 'nonac'].includes(s)) return false;
  return null; // unknown token — callers report a per-row validation error
}

function serializeUnit(u: UnitWithRelations) {
  const rate = toNum(u.monthlyRate);
  return {
    id: u.id,
    code: u.unitCode,
    unitCode: u.unitCode,
    name: u.name ?? u.unitCode,
    sqft: u.sqft,
    rate,
    psf: u.sqft ? rate / u.sqft : 0,
    status: u.status,
    climateControl: u.climateControl,
    hasAC: u.hasAC,
    hasPillar: u.hasPillar,
    deletedAt: u.deletedAt,
    branchId: u.branchId,
    floorId: u.floorId,
    sizeId: u.sizeId,
    size: u.size,
    branch: u.branch,
    floor: u.floor,
    tenant: u.tenant,
  };
}

export async function listUnits(query: UnitListQuery = {}) {
  const page = Math.max(1, query.page ?? 1);
  const perPage = Math.min(200, Math.max(1, query.perPage ?? 25));
  const createdAt: { gte?: Date; lte?: Date } = {};
  if (query.from) createdAt.gte = query.from;
  if (query.to) createdAt.lte = query.to;
  const where: Prisma.UnitWhereInput = {
    deletedAt: null,
    ...(query.status ? { status: query.status as UnitStatus } : {}),
    ...(query.branch ? { branch: { code: query.branch } } : {}),
    ...(query.level != null ? { floor: { level: query.level } } : {}),
    ...(query.hasAC != null ? { hasAC: query.hasAC } : {}),
    ...(createdAt.gte || createdAt.lte ? { createdAt } : {}),
  };
  const [units, total] = await Promise.all([
    prisma.unit.findMany({
      where,
      include: { size: true, branch: true, floor: true, tenant: true },
      orderBy: { unitCode: 'asc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.unit.count({ where }),
  ]);
  return {
    rows: units.map(serializeUnit),
    meta: {
      count: units.length,
      page,
      perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      total,
    },
  };
}

export interface UnitListQuery {
  page?: number;
  perPage?: number;
  status?: string;
  branch?: string;
  level?: number;
  hasAC?: boolean;
  from?: Date;
  to?: Date;
}

export interface PublicUnitsQuery {
  branch?: string;
  level?: number;
  status?: 'AVAILABLE' | 'RESERVED';
}

const BROWSEABLE_STATUSES: UnitStatus[] = ['AVAILABLE', 'RESERVED'];

// Customer-facing unit listing: only browseable statuses, no tenant/PII anywhere.
// Floors gated by isActive: units on an inactive floor are never sent to the
// frontend (see docs/FLOORS.md).
export async function listPublicUnits(query: PublicUnitsQuery = {}) {
  const statuses = query.status ? [query.status] : BROWSEABLE_STATUSES;
  const units = await prisma.unit.findMany({
    where: {
      deletedAt: null,
      status: { in: statuses },
      ...(query.branch ? { branch: { code: query.branch } } : {}),
      floor: {
        ...(query.level != null ? { level: query.level } : {}),
        isActive: true,
      },
    },
    include: { size: true, branch: true, floor: true },
    orderBy: { unitCode: 'asc' },
  });

  const publicUnits = units.map((u) => {
    const rate = toNum(u.monthlyRate);
    return {
      id: u.id,
      code: u.unitCode,
      unitCode: u.unitCode,
      name: u.name ?? u.unitCode,
      sqft: u.sqft,
      rate,
      psf: u.sqft ? rate / u.sqft : 0,
      status: u.status,
      climateControl: u.climateControl,
      hasAC: u.hasAC,
      hasPillar: u.hasPillar,
      deletedAt: u.deletedAt,
      size: { code: u.size.code, name: u.size.name },
      branch: { code: u.branch.code, name: u.branch.name },
      floor: { level: u.floor.level },
    };
  });

  return {
    units: publicUnits,
    branches: [...new Set(publicUnits.map((u) => u.branch.code))],
  };
}

export async function createUnit(input: CreateUnitInput) {
  const [branch, floor, size] = await Promise.all([
    prisma.branch.findUnique({ where: { id: input.branchId } }),
    prisma.floor.findUnique({ where: { id: input.floorId } }),
    prisma.unitSize.findUnique({ where: { id: input.sizeId } }),
  ]);
  if (!branch) throw new AppError(400, 'VALIDATION', `Branch ${input.branchId} not found`);
  if (!floor) throw new AppError(400, 'VALIDATION', `Floor ${input.floorId} not found`);
  if (!size) throw new AppError(400, 'VALIDATION', `Unit size ${input.sizeId} not found`);
  // Units on an inactive floor would be invisible to the frontend — refuse so
  // operators activate the floor first (see docs/FLOORS.md).
  if (!floor.isActive) {
    throw new AppError(
      400,
      'VALIDATION',
      `Floor ${input.floorId} is inactive — activate it before adding units`,
    );
  }

  // 4-digit codegen: next free code above the MAX 4-digit code across ALL
  // rows (deliberately no deletedAt filter — codes of soft-deleted units are
  // never reused, keeping the sequence monotonic). Legacy BM-01-01 codes never
  // match /^\d{4}$/ so they neither collide nor disturb the sequence.
  let unitCode: string;
  if (input.unitCode !== undefined) {
    const explicit = input.unitCode.trim();
    if (!isFourDigitCode(explicit)) {
      throw new AppError(400, 'VALIDATION', `unitCode must be a 4-digit code (e.g. 1001) — got ${JSON.stringify(input.unitCode)}`);
    }
    const taken = await prisma.unit.findUnique({ where: { unitCode: explicit }, select: { id: true } });
    if (taken) throw new AppError(409, 'CONFLICT', `Unit ${explicit} already exists`);
    unitCode = explicit;
  } else {
    const existingCodes = await prisma.unit.findMany({ select: { unitCode: true } });
    unitCode = nextFourDigitCode(existingCodes.map((u) => u.unitCode));
  }

  // Legacy accept-but-map: an explicit hasAC wins; otherwise a supplied
  // climateControl string maps onto hasAC when it carries a signal.
  const mappedAC = climateControlToHasAC(input.climateControl);
  const hasAC = input.hasAC ?? mappedAC ?? false;

  const unit = await prisma.unit.create({
    data: {
      branchId: input.branchId,
      floorId: input.floorId,
      sizeId: input.sizeId,
      unitCode,
      name: input.name?.trim() || null,
      sqft: input.sqft,
      monthlyRate: input.monthlyRate,
      status: input.status ?? 'AVAILABLE',
      climateControl: input.climateControl,
      hasAC,
      hasPillar: input.hasPillar ?? false,
    },
    include: { size: true, branch: true, floor: true, tenant: true },
  });
  return serializeUnit(unit);
}

export async function updateUnit(code: string, input: UpdateUnitInput) {
  const unit = await prisma.unit.findUnique({
    where: { unitCode: code, deletedAt: null },
  });
  if (!unit) throw new AppError(404, 'NOT_FOUND', `Unit ${code} not found`);

  // name is optional display label only: undefined = not provided (leave unchanged),
  // null or empty string = explicit clear (display name falls back to unitCode).
  // climateControl is legacy accept-but-map: still stored for backwards compat,
  // and mapped onto hasAC when the caller doesn't set hasAC explicitly.
  const mappedAC = climateControlToHasAC(input.climateControl ?? undefined);
  const data: Prisma.UnitUpdateInput = {
    sqft: input.sqft,
    monthlyRate: input.monthlyRate,
    status: input.status,
    climateControl: input.climateControl,
    ...(input.hasAC !== undefined ? { hasAC: input.hasAC } : mappedAC !== null ? { hasAC: mappedAC } : {}),
    ...(input.hasPillar !== undefined ? { hasPillar: input.hasPillar } : {}),
    ...(input.name !== undefined
      ? { name: input.name === null ? null : input.name.trim() || null }
      : {}),
  };

  const updated = await prisma.unit.update({
    where: { id: unit.id },
    data,
    include: { size: true, branch: true, floor: true, tenant: true },
  });
  return serializeUnit(updated);
}

export async function softDeleteUnit(code: string) {
  const unit = await prisma.unit.findUnique({ where: { unitCode: code } });
  if (!unit) throw new AppError(404, 'NOT_FOUND', `Unit ${code} not found`);
  if (unit.deletedAt) throw new AppError(404, 'NOT_FOUND', `Unit ${code} not found`);
  // Owner rule: a unit that is OCCUPIED, RESERVED or OVERDUE holds a live
  // commercial interest and cannot be deleted (409). INACTIVE / AVAILABLE /
  // MAINTENANCE / BLOCKED stay deletable.
  if (unit.status === 'OCCUPIED' || unit.status === 'OVERDUE' || unit.status === 'RESERVED') {
    throw new AppError(409, 'CONFLICT', `Unit ${code} is ${unit.status} and cannot be deleted`);
  }
  const updated = await prisma.unit.update({
    where: { id: unit.id },
    // Soft-delete: deletedAt is the only deletion marker. status is a pure business
    // state and is never touched by deletion (INACTIVE remains a valid status).
    data: { deletedAt: new Date() },
    include: { size: true, branch: true, floor: true, tenant: true },
  });
  return serializeUnit(updated);
}

export interface UnitMapQuery {
  public?: boolean;
  // P1 item 3: map filters — size code (e.g. SMALL) and near-lift proximity.
  size?: string;
  nearLift?: boolean;
}

// Foot-distance threshold for the near-lift filter: a unit counts as near a
// lift when its placement rect centre is within this many feet of a "Lift"
// block centre on the same plan canvas (1 grid unit = 1 ft).
const NEAR_LIFT_FT = 8;

export async function getUnitMap(branchCode: string, level: number, opts?: UnitMapQuery) {
  const isPublic = opts?.public ?? false;
  const floor = await prisma.floor.findFirst({
    where: { branch: { code: branchCode }, level },
    include: {
      floorPlan: { include: { placements: true, blocks: true } },
    },
  });
  const units = await prisma.unit.findMany({
    where: {
      deletedAt: null,
      branch: { code: branchCode },
      floor: {
        level,
        // Public map never shows units on an inactive floor (admin map is
        // unfiltered so operators still see the whole floor).
        ...(isPublic ? { isActive: true } : {}),
      },
      ...(opts?.size ? { size: { code: opts.size } } : {}),
    },
    include: { size: true, tenant: true },
    orderBy: { unitCode: 'asc' },
  });

  // Near-lift proximity resolves against the floor's plan geometry: placements
  // joined by unitId, lift blocks matched by name. No plan / no lift blocks /
  // unplaced unit → not near-lift (never an error — the filter just matches
  // nothing when the operator hasn't drawn lifts yet).
  let nearLiftIds: Set<string> | null = null;
  if (opts?.nearLift) {
    nearLiftIds = new Set();
    const plan = floor?.floorPlan ?? null;
    const lifts = (plan?.blocks ?? []).filter((b) => b.name.toLowerCase().includes('lift'));
    if (plan && lifts.length) {
      const placementByUnit = new Map(plan.placements.map((p) => [p.unitId, p]));
      for (const u of units) {
        const p = placementByUnit.get(u.id);
        if (!p) continue;
        const cx = p.x + p.width / 2;
        const cy = p.y + p.height / 2;
        const near = lifts.some((b) => {
          const bx = b.x + b.width / 2;
          const by = b.y + b.height / 2;
          return Math.hypot(cx - bx, cy - by) <= NEAR_LIFT_FT;
        });
        if (near) nearLiftIds.add(u.id);
      }
    }
  }
  const visible = nearLiftIds ? units.filter((u) => nearLiftIds.has(u.id)) : units;

  const legend = {
    occupied: visible.filter((u) => u.status === 'OCCUPIED').length,
    available: visible.filter((u) => u.status === 'AVAILABLE').length,
    reserved: visible.filter((u) => u.status === 'RESERVED').length,
    overdue: visible.filter((u) => u.status === 'OVERDUE').length,
    maintenance: visible.filter((u) => u.status === 'MAINTENANCE').length,
    blocked: visible.filter((u) => u.status === 'BLOCKED').length,
  };

  // Size grouping (additive — `legend` keys above are untouched): per-size
  // totals + by-status breakdown over the SAME visible set the status legend
  // counts (post size/near-lift filter). Powers the admin size legend + the
  // size-filter counts; booking readers ignore it safely.
  const sizeGroups = new Map<
    string,
    {
      code: string;
      name: string;
      sortOrder: number;
      total: number;
      byStatus: { occupied: number; available: number; reserved: number; overdue: number; maintenance: number; blocked: number; inactive: number };
    }
  >();
  for (const u of visible) {
    let g = sizeGroups.get(u.size.code);
    if (!g) {
      g = {
        code: u.size.code,
        name: u.size.name,
        sortOrder: u.size.sortOrder,
        total: 0,
        byStatus: { occupied: 0, available: 0, reserved: 0, overdue: 0, maintenance: 0, blocked: 0, inactive: 0 },
      };
      sizeGroups.set(u.size.code, g);
    }
    g.total += 1;
    if (u.status === 'OCCUPIED') g.byStatus.occupied += 1;
    else if (u.status === 'AVAILABLE') g.byStatus.available += 1;
    else if (u.status === 'RESERVED') g.byStatus.reserved += 1;
    else if (u.status === 'OVERDUE') g.byStatus.overdue += 1;
    else if (u.status === 'MAINTENANCE') g.byStatus.maintenance += 1;
    else if (u.status === 'BLOCKED') g.byStatus.blocked += 1;
    else if (u.status === 'INACTIVE') g.byStatus.inactive += 1;
  }
  // sortOrder is a server-side ordering aid only — stripped from the payload.
  const sizes = [...sizeGroups.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
    .map(({ sortOrder: _sortOrder, ...rest }) => rest);

  return {
    branch: branchCode,
    level,
    legend,
    sizes,
    filters: {
      size: opts?.size ?? null,
      nearLift: opts?.nearLift ?? false,
    },
    units: visible.map((u) => ({
      id: u.unitCode,
      code: u.unitCode,
      // Legacy BM-01-01 codes shorten to the trailing segments; 4-digit codes
      // have no dashes and shorten to themselves.
      short: u.unitCode.includes('-') ? u.unitCode.split('-').slice(1).join('-') : u.unitCode,
      size: u.size.name,
      sizeCode: u.size.code,
      // Additive object identity for size grouping (the `size` string + `sizeCode`
      // above are kept byte-compatible for existing booking readers).
      sizeInfo: { code: u.size.code, name: u.size.name },
      psf: u.sqft ? toNum(u.monthlyRate) / u.sqft : 0,
      rate: toNum(u.monthlyRate),
      sqft: u.sqft,
      status: u.status.toLowerCase(),
      hasAC: u.hasAC,
      hasPillar: u.hasPillar,
      // Public view must never expose tenant names / PII.
      ...(isPublic ? {} : { tenant: u.tenant?.name ?? null }),
    })),
  };
}

// Reference data for the admin units UI: all UnitSize rows. widthFt/heightFt
// feed the floor-plan editor's true-size footprints (null → the documented
// aspect fallback in src/core/floorPlans.ts).
export async function listSizes() {
  const sizes = await prisma.unitSize.findMany({ orderBy: { sortOrder: 'asc' } });
  return sizes.map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    sqftFrom: s.sqftFrom,
    sqftTo: s.sqftTo,
    widthFt: s.widthFt,
    heightFt: s.heightFt,
    sortOrder: s.sortOrder,
  }));
}

export async function getUnitDetail(code: string) {
  const unit = await prisma.unit.findUnique({
    // deletedAt: null → a deleted unit is not addressable (404 below).
    where: { unitCode: code, deletedAt: null },
    include: {
      size: true,
      branch: true,
      floor: true,
      tenant: true,
      rateHistory: { orderBy: { date: 'desc' } },
    },
  });
  if (!unit) throw new AppError(404, 'NOT_FOUND', `Unit ${code} not found`);

  // P1 item 3: facility-ops sections for the unit drawer, read from the
  // in-tree P0 tables. Checklists / certificates / access events are
  // branch-scoped (those models carry branchId, not unitId); work orders and
  // incidents are unit-scoped where the FK exists. All capped for drawer use.
  const [checklists, certificates, accessEvents, workOrders, incidents] = await Promise.all([
    prisma.inspectionChecklist.findMany({
      where: { branchId: unit.branchId },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    }),
    prisma.complianceCertificate.findMany({
      where: { branchId: unit.branchId },
      orderBy: { expiryDate: 'asc' },
      take: 5,
    }),
    prisma.accessEvent.findMany({
      where: { branchId: unit.branchId },
      include: { door: { select: { code: true, name: true } }, credential: { select: { holderName: true } } },
      orderBy: { occurredAt: 'desc' },
      take: 10,
    }),
    prisma.workOrder.findMany({
      where: { unitId: unit.id },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    }),
    prisma.incident.findMany({
      where: { unitId: unit.id },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    }),
  ]);

  return {
    id: unit.unitCode,
    code: unit.unitCode,
    name: unit.name ?? unit.unitCode,
    branchId: unit.branchId,
    floorId: unit.floorId,
    sizeId: unit.sizeId,
    size: unit.size.name,
    sizeCode: unit.size.code,
    sqft: unit.sqft,
    rate: toNum(unit.monthlyRate),
    psf: unit.sqft ? toNum(unit.monthlyRate) / unit.sqft : 0,
    status: unit.status.toLowerCase(),
    branch: unit.branch.name,
    branchCode: unit.branch.code,
    level: unit.floor.level,
    climateControl: unit.climateControl,
    hasAC: unit.hasAC,
    hasPillar: unit.hasPillar,
    tenant: unit.tenant
      ? {
          name: unit.tenant.name,
          type: unit.tenant.type,
          segment: unit.tenant.segment,
          monthlyRate: toNum(unit.tenant.monthlyRate),
          psf: toNum(unit.tenant.psf),
          since: unit.tenant.moveInDate,
          nextPayment: unit.tenant.nextPayment,
          lifetimeValue: toNum(unit.tenant.lifetimeValue),
          payments: unit.tenant.paymentCount,
          missed: unit.tenant.missedPayments,
          autoDebit: unit.tenant.autoDebit,
        }
      : null,
    rateHistory: unit.rateHistory.map((r) => ({
      date: r.date,
      previous: toNum(r.previous),
      current: toNum(r.current),
      changePct: toNum(r.changePct, 1),
      reason: r.reason,
      by: r.appliedBy,
    })),
    // P1 item 3: drawer sections (branch-scoped where the P0 model has no
    // unit FK — see the query above).
    operations: {
      inspections: checklists.map((c) => ({
        id: c.id,
        title: c.title,
        frequency: c.frequency,
        status: c.status,
        percentComplete: c.percentComplete,
        dueDate: c.dueDate,
      })),
      certificates: certificates.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        expiryDate: c.expiryDate,
        status: c.status,
      })),
      accessHistory: accessEvents.map((e) => ({
        id: e.id,
        door: e.door ? { code: e.door.code, name: e.door.name } : null,
        holder: e.credential?.holderName ?? null,
        result: e.result,
        occurredAt: e.occurredAt,
        note: e.note,
      })),
      workOrders: workOrders.map((w) => ({
        id: w.id,
        title: w.title,
        status: w.status,
        priority: w.priority,
        value: toNum(w.value),
      })),
      incidents: incidents.map((i) => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        status: i.status,
      })),
    },
  };
}

// ---------- templated spreadsheet import (CSV-only) ----------
//
// Template: GET /units/import/template returns a header-only CSV; rows are
// imported via POST /units/import { csv }. XLSX is NOT accepted (no workbook
// dep in this repo — operators save-as CSV from Excel/Sheets; see
// docs/UNIT_IMPORT.md).
//
// Policy: create-new by default; an explicit `code` that already exists is
// SKIPPED (never overwritten — this is what protects OCCUPIED/RESERVED units);
// rows without a code mint the next 4-digit code via the canonical codegen.

export const UNIT_IMPORT_HEADERS = [
  'code',
  'branch',
  'level',
  'size',
  'sqft',
  'rate',
  'status',
  'hasAC',
  'hasPillar',
  'name',
] as const;

export type UnitImportStatus = 'created' | 'skipped' | 'error';

export interface UnitImportRowResult {
  row: number; // 1-based data-row number (header = row 1)
  status: UnitImportStatus;
  code: string | null; // minted/explicit code when created, existing code when skipped
  message: string;
}

export interface UnitImportReport {
  rows: UnitImportRowResult[];
  meta: { total: number; created: number; skipped: number; errors: number };
}

/** Header-only template CSV (trailing newline; LF). */
export function unitImportTemplateCsv(): string {
  return UNIT_IMPORT_HEADERS.join(',') + '\n';
}

// Minimal CSV parser: LF/CRLF rows, double-quote escaping ("" = literal "),
// preserves empty trailing cells. Pure — unit-testable without a DB.
export function parseImportCsv(text: string): { headers: string[]; records: string[][] } {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let hasCell = false;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      hasCell = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      hasCell = false;
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      hasCell = false;
    } else {
      field += ch;
      hasCell = true;
    }
  }
  if (hasCell || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-blank rows (whitespace-only cells).
  const nonBlank = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonBlank.length) return { headers: [], records: [] };
  const headers = nonBlank[0].map((h) => h.trim());
  return { headers, records: nonBlank.slice(1) };
}

const IMPORTABLE_STATUSES: UnitStatus[] = ['AVAILABLE', 'RESERVED', 'MAINTENANCE', 'INACTIVE', 'BLOCKED'];

export async function importUnits(csvText: string): Promise<UnitImportReport> {
  const rows: UnitImportRowResult[] = [];
  const fail = (row: number, message: string): UnitImportRowResult => ({ row, status: 'error', code: null, message });

  if (!csvText || !csvText.trim()) {
    return { rows: [], meta: { total: 0, created: 0, skipped: 0, errors: 0 } };
  }
  const { headers, records } = parseImportCsv(csvText);
  if (!headers.length) {
    return { rows: [], meta: { total: 0, created: 0, skipped: 0, errors: 0 } };
  }
  const idx = (name: string): number => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  for (const required of ['branch', 'size', 'sqft', 'rate']) {
    if (idx(required) < 0) {
      const msg = `Missing required column "${required}" (expected: ${UNIT_IMPORT_HEADERS.join(', ')})`;
      return {
        rows: records.map((_, i) => fail(i + 2, msg)),
        meta: { total: records.length, created: 0, skipped: 0, errors: records.length },
      };
    }
  }
  const ci = {
    code: idx('code'),
    branch: idx('branch'),
    level: idx('level'),
    size: idx('size'),
    sqft: idx('sqft'),
    rate: idx('rate'),
    status: idx('status'),
    hasAC: idx('hasAC'),
    hasPillar: idx('hasPillar'),
    name: idx('name'),
  };
  const cell = (rec: string[], i: number): string => (i < 0 ? '' : (rec[i] ?? '').trim());

  for (let r = 0; r < records.length; r++) {
    const rowNum = r + 2;
    const rec = records[r];
    try {
      const codeRaw = cell(rec, ci.code);
      const branchRaw = cell(rec, ci.branch);
      const levelRaw = cell(rec, ci.level);
      const sizeRaw = cell(rec, ci.size);
      const sqftRaw = cell(rec, ci.sqft);
      const rateRaw = cell(rec, ci.rate);
      const statusRaw = cell(rec, ci.status) || 'AVAILABLE';
      const hasACRaw = cell(rec, ci.hasAC);
      const hasPillarRaw = cell(rec, ci.hasPillar);
      const nameRaw = cell(rec, ci.name);

      if (codeRaw && !isFourDigitCode(codeRaw)) {
        rows.push(fail(rowNum, `code must be a 4-digit code or blank (got ${JSON.stringify(codeRaw)})`));
        continue;
      }
      const branchCode = branchRaw.toUpperCase();
      const branch =
        (branchCode ? await prisma.branch.findUnique({ where: { code: branchCode } }) : null) ??
        (branchRaw ? await prisma.branch.findUnique({ where: { id: branchRaw } }).catch(() => null) : null);
      if (!branch) {
        rows.push(fail(rowNum, `unknown branch ${JSON.stringify(branchRaw)} (use branch code, e.g. BM)`));
        continue;
      }
      let floor = null;
      if (levelRaw) {
        const level = Number(levelRaw);
        if (!Number.isInteger(level) || level < 1) {
          rows.push(fail(rowNum, `level must be a positive integer (got ${JSON.stringify(levelRaw)})`));
          continue;
        }
        floor = await prisma.floor.findFirst({ where: { branchId: branch.id, level } });
        if (!floor) {
          rows.push(fail(rowNum, `no level ${level} floor at branch ${branch.code}`));
          continue;
        }
      } else {
        floor = await prisma.floor.findFirst({ where: { branchId: branch.id }, orderBy: { level: 'asc' } });
        if (!floor) {
          rows.push(fail(rowNum, `branch ${branch.code} has no floors yet`));
          continue;
        }
      }
      const sizeCode = sizeRaw.toUpperCase();
      const size =
        (sizeCode ? await prisma.unitSize.findUnique({ where: { code: sizeCode } }) : null) ??
        (sizeRaw ? await prisma.unitSize.findUnique({ where: { id: sizeRaw } }).catch(() => null) : null);
      if (!size) {
        rows.push(fail(rowNum, `unknown size ${JSON.stringify(sizeRaw)} (use size code, e.g. SMALL)`));
        continue;
      }
      const sqft = Number(sqftRaw);
      if (!Number.isFinite(sqft) || sqft <= 0 || !Number.isInteger(sqft)) {
        rows.push(fail(rowNum, `sqft must be a positive integer (got ${JSON.stringify(sqftRaw)})`));
        continue;
      }
      const rate = Number(rateRaw);
      if (!Number.isFinite(rate) || rate < 0) {
        rows.push(fail(rowNum, `rate must be 0 or greater (got ${JSON.stringify(rateRaw)})`));
        continue;
      }
      const status = statusRaw.toUpperCase() as UnitStatus;
      if (!IMPORTABLE_STATUSES.includes(status)) {
        rows.push(
          fail(
            rowNum,
            `status must be one of ${IMPORTABLE_STATUSES.join(' | ')} (got ${JSON.stringify(statusRaw)}; OCCUPIED/OVERDUE cannot be imported — assign a tenant instead)`,
          ),
        );
        continue;
      }
      let hasAC: boolean | undefined;
      if (hasACRaw) {
        const parsed = parseYesNoFlag(hasACRaw);
        if (parsed === null) {
          rows.push(fail(rowNum, `hasAC must be yes/no (got ${JSON.stringify(hasACRaw)})`));
          continue;
        }
        hasAC = parsed;
      }
      let hasPillar: boolean | undefined;
      if (hasPillarRaw) {
        const parsed = parseYesNoFlag(hasPillarRaw);
        if (parsed === null) {
          rows.push(fail(rowNum, `hasPillar must be yes/no (got ${JSON.stringify(hasPillarRaw)})`));
          continue;
        }
        hasPillar = parsed;
      }

      // Skip-or-create policy: an explicit code that already exists is skipped
      // (never overwritten — OCCUPIED/RESERVED units are untouchable by import).
      if (codeRaw) {
        const existing = await prisma.unit.findUnique({ where: { unitCode: codeRaw }, select: { unitCode: true } });
        if (existing) {
          rows.push({ row: rowNum, status: 'skipped', code: codeRaw, message: `Unit ${codeRaw} already exists — skipped` });
          continue;
        }
      }

      const created = await createUnit({
        branchId: branch.id,
        floorId: floor.id,
        sizeId: size.id,
        sqft,
        monthlyRate: rate,
        status,
        hasAC,
        hasPillar,
        ...(codeRaw ? { unitCode: codeRaw } : {}),
        ...(nameRaw ? { name: nameRaw } : {}),
      });
      rows.push({ row: rowNum, status: 'created', code: created.unitCode, message: `Created ${created.unitCode}` });
    } catch (err) {
      const message = err instanceof AppError ? err.message : 'Unexpected import failure';
      rows.push(fail(rowNum, message));
    }
  }

  const meta = {
    total: rows.length,
    created: rows.filter((r) => r.status === 'created').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
    errors: rows.filter((r) => r.status === 'error').length,
  };
  return { rows, meta };
}

// ---------- unit activity feed (dashboard "Latest Unit Activity") ----------
export interface UnitActivityItem {
  type: 'unit_created' | 'unit_updated' | 'rate_change' | 'move_in' | 'booking';
  unitCode: string;
  at: Date;
  message: string;
  unit?: { code: string; size?: string; branch?: string };
  actor?: string;
}

const fmtDollars = (n: number) =>
  '$' + n.toLocaleString('en-US', { maximumFractionDigits: n % 1 === 0 ? 0 : 2 });

// Merges unit-related events (additions, non-rate updates, rate changes, move-ins,
// scheduled move-in bookings) sorted newest-first. Requires Unit.createdAt/updatedAt,
// which the add_crud_timestamps migration backfilled for pre-existing rows.
export async function getUnitActivity(limit = 20) {
  const capped = Math.min(100, Math.max(1, limit));
  const [units, rateChanges, moveIns, bookings] = await Promise.all([
    prisma.unit.findMany({
      where: { deletedAt: null },
      include: { size: true, branch: true },
      orderBy: { unitCode: 'asc' },
    }),
    prisma.rateChange.findMany({
      where: { unit: { deletedAt: null } },
      include: { unit: { include: { size: true, branch: true } } },
      orderBy: { date: 'desc' },
    }),
    prisma.tenant.findMany({
      where: { moveInDate: { not: null }, unit: { deletedAt: null } },
      include: { unit: { include: { size: true, branch: true } } },
      orderBy: { moveInDate: 'desc' },
    }),
    prisma.booking.findMany({
      where: { unit: { deletedAt: null } },
      include: { tenant: true, unit: { include: { size: true, branch: true } } },
      orderBy: { moveInDate: 'desc' },
    }),
  ]);

  const events: UnitActivityItem[] = [];

  for (const u of units) {
    const unit = { code: u.unitCode, size: u.size.name, branch: u.branch.code };
    events.push({
      type: 'unit_created',
      unitCode: u.unitCode,
      at: u.createdAt,
      message: `New unit ${u.unitCode} added`,
      unit,
    });
    // Non-rate updates only: skip backfilled rows where updatedAt == createdAt.
    if (u.updatedAt && u.createdAt && u.updatedAt.getTime() > u.createdAt.getTime()) {
      events.push({
        type: 'unit_updated',
        unitCode: u.unitCode,
        at: u.updatedAt,
        message: `Unit ${u.unitCode} updated`,
        unit,
      });
    }
  }

  for (const rc of rateChanges) {
    const u = rc.unit;
    events.push({
      type: 'rate_change',
      unitCode: u.unitCode,
      at: rc.date,
      message: `Rate for ${u.unitCode} changed ${fmtDollars(toNum(rc.previous))} → ${fmtDollars(toNum(rc.current))}`,
      actor: rc.appliedBy,
      unit: { code: u.unitCode, size: u.size.name, branch: u.branch.code },
    });
  }

  for (const t of moveIns) {
    if (!t.unit || !t.moveInDate) continue;
    events.push({
      type: 'move_in',
      unitCode: t.unit.unitCode,
      at: t.moveInDate,
      message: `Tenant ${t.name} moved into ${t.unit.unitCode}`,
      unit: { code: t.unit.unitCode, size: t.unit.size.name, branch: t.unit.branch.code },
    });
  }

  for (const b of bookings) {
    if (!b.unit) continue;
    events.push({
      type: 'booking',
      unitCode: b.unit.unitCode,
      at: b.moveInDate,
      message: `Move-in booked for ${b.tenant.name} at ${b.unit.unitCode}`,
      unit: { code: b.unit.unitCode, size: b.unit.size.name, branch: b.unit.branch.code },
    });
  }

  events.sort((a, b) => b.at.getTime() - a.at.getTime() || a.unitCode.localeCompare(b.unitCode));
  return events.slice(0, capped);
}
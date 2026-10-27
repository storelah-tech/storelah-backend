// Facility scope for CMS operators (CMS RBAC, 2026-10-27).
//
// An operator limited to some facilities (OperatorFacilityAccess rows) must
// only see and change those facilities' data. requireAuth starts each CMS
// request inside runScoped(); the Prisma query extension in lib/prisma.ts
// then adds scopeWhere(model) to every read / update / delete on
// facility-linked models and checks creates with assertCreateInScope(). So an
// out-of-scope record behaves as "not found" everywhere — lists, counts,
// dashboards, detail reads and writes — without per-route code.
//
// No scope (public / customer routes, scripts, tests, Owners, operators with
// every facility) = no filter. Rows with no facility at all (nullable
// branchId, e.g. an org-wide notice or a lead with no preferred site) stay
// visible to scoped operators.
import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './http';

interface Scope {
  branchIds: string[];
}

const store = new AsyncLocalStorage<Scope>();

/** Runs fn with the operator's facility scope (null = every facility). */
export function runScoped<T>(branchIds: string[] | null, fn: () => T): T {
  return branchIds ? store.run({ branchIds }, fn) : store.exit(fn);
}

/** Branch ids the current request is limited to, or null when unscoped. */
export function currentBranchScope(): string[] | null {
  return store.getStore()?.branchIds ?? null;
}

// Model → how it links to a facility.
const DIRECT_REQUIRED = new Set(['Unit', 'Floor', 'FloorplanMetricsSnapshot']);
const DIRECT_NULLABLE = new Set([
  'Tenant', 'AccessCredential', 'AccessDoor', 'AccessEvent', 'Asset', 'ComplianceCertificate',
  'InspectionChecklist', 'PreventiveTask', 'WorkOrder', 'Incident', 'Appointment', 'FacilityFee',
]);
const VIA_UNIT = new Set(['Booking', 'Invoice', 'Notice', 'RateChange', 'UnitAreaChange', 'UnitPlacement', 'UnitImage']);
const VIA_FLOOR = new Set(['FloorPlan', 'FloorPlanDraft']);
const VIA_LEAD = new Set(['Quotation', 'Conversation']);
// Creating these with no facility affects every site — needs all-facility access.
const CREATE_NEEDS_FACILITY = new Set(['FacilityFee']);

export function isScopedModel(model: string): boolean {
  return model === 'Branch' || model === 'Lead' || DIRECT_REQUIRED.has(model) || DIRECT_NULLABLE.has(model)
    || VIA_UNIT.has(model) || VIA_FLOOR.has(model) || VIA_LEAD.has(model);
}

/** Prisma where-fragment limiting `model` to the scope (null = no filter). */
export function scopeWhere(model: string, branchIds: string[]): Record<string, unknown> | null {
  const inScope = { in: branchIds };
  const lead = { OR: [{ preferredBranchId: inScope }, { preferredBranchId: null }] };
  if (model === 'Branch') return { id: inScope };
  if (model === 'Lead') return lead;
  if (DIRECT_REQUIRED.has(model)) return { branchId: inScope };
  if (DIRECT_NULLABLE.has(model)) return { OR: [{ branchId: inScope }, { branchId: null }] };
  if (VIA_UNIT.has(model)) return { unit: { branchId: inScope } };
  if (VIA_FLOOR.has(model)) return { floor: { branchId: inScope } };
  if (VIA_LEAD.has(model)) return { lead };
  return null;
}

/** where ∧ scope, keeping top-level unique keys (findUnique / update / delete). */
export function withScope(where: Record<string, unknown> | undefined, scope: Record<string, unknown>) {
  const w = { ...(where ?? {}) };
  const and = w.AND === undefined ? [] : Array.isArray(w.AND) ? w.AND : [w.AND];
  w.AND = [...and, scope];
  return w;
}

function refusal(): AppError {
  return new AppError(403, 'FORBIDDEN', "That facility isn't in your access. Ask an Owner to add it.");
}

function branchOfData(model: string, data: Record<string, unknown>): { present: boolean; id: string | null } {
  const key = model === 'Branch' ? null : model === 'Lead' ? 'preferredBranchId' : 'branchId';
  const rel = 'branch'; // relation field on every direct model and Lead
  if (key && key in data) return { present: true, id: (data[key] as string | null) ?? null };
  const r = data[rel] as { connect?: { id?: string }; disconnect?: boolean } | undefined;
  if (r && typeof r === 'object') {
    if (r.connect?.id) return { present: true, id: r.connect.id };
    if (r.disconnect) return { present: true, id: null };
  }
  return { present: false, id: null };
}

/** Refuses creating (or moving) a record into a facility outside the scope. */
export function assertDataInScope(model: string, data: unknown, branchIds: string[], creating: boolean): void {
  if (model === 'Branch') {
    if (creating) throw new AppError(403, 'FORBIDDEN', 'Only operators with access to every facility can add a facility.');
    return;
  }
  if (!(DIRECT_REQUIRED.has(model) || DIRECT_NULLABLE.has(model) || model === 'Lead')) return;
  for (const row of Array.isArray(data) ? data : [data]) {
    if (!row || typeof row !== 'object') continue;
    const { present, id } = branchOfData(model, row as Record<string, unknown>);
    if (!present) {
      if (creating && (DIRECT_REQUIRED.has(model) || CREATE_NEEDS_FACILITY.has(model))) throw refusal();
      continue;
    }
    if (id === null) {
      if (DIRECT_REQUIRED.has(model) || CREATE_NEEDS_FACILITY.has(model)) throw refusal();
      continue;
    }
    if (!branchIds.includes(id)) throw refusal();
  }
}

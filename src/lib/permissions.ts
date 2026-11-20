// CMS role permissions — the catalog of permission keys and the default
// matrix for the seeded roles (CMS RBAC, 2026-10-27).
//
// A permission is `<resource>:<action>`. Resources are the operator CMS
// sidebar items: one per sub-page / sub-tab, keyed by the same id the
// dashboard uses (data-side-page / data-tab), so the UI can hide exactly the
// item a role cannot view. Actions are view / create / update / delete /
// approve; each resource lists only the actions its screen actually has.
//
// Owner is a locked system role: it always holds every permission and is the
// only role that may manage users and roles (Settings › Team & access). That
// screen is therefore NOT a grantable resource here.
//
// Adding a screen = one RESOURCES entry + its routes in routePermissions.ts.
// The role matrix stored in the DB is authoritative at runtime; the defaults
// below only seed Manager / Viewer / Finance roles (migration + ensureSystemRoles()).

export const ACTIONS = ['view', 'create', 'update', 'delete', 'approve'] as const;
export type Action = (typeof ACTIONS)[number];

export interface ResourceDef {
  key: string;
  label: string;
  group: string; // sidebar page label
  actions: readonly Action[];
}

const R: readonly Action[] = ['view'];
const RU: readonly Action[] = ['view', 'update'];
const RCU: readonly Action[] = ['view', 'create', 'update'];
const RUA: readonly Action[] = ['view', 'update', 'approve'];
const RCUA: readonly Action[] = ['view', 'create', 'update', 'approve'];
const CRUD: readonly Action[] = ['view', 'create', 'update', 'delete'];
const CRUDA: readonly Action[] = ['view', 'create', 'update', 'delete', 'approve'];

export const RESOURCES: readonly ResourceDef[] = [
  { group: 'Overview', key: 'command', label: 'Command centre', actions: R },
  { group: 'Overview', key: 'portfolio', label: 'Facility portfolio', actions: R },
  { group: 'Overview', key: 'analytics', label: 'Performance dashboards', actions: R },

  { group: 'Leads', key: 'leads', label: 'Lead database', actions: CRUD },
  { group: 'Leads', key: 'pipeline', label: 'Pipeline', actions: RU },
  { group: 'Leads', key: 'quotes', label: 'Quotations', actions: CRUD },
  { group: 'Leads', key: 'inbox', label: 'Conversations', actions: RCU },
  { group: 'Leads', key: 'calendar', label: 'Appointments', actions: CRUD },
  { group: 'Leads', key: 'automation', label: 'Automation', actions: R },

  { group: 'Customers', key: 'customer-tenants', label: 'Tenants', actions: CRUD },
  { group: 'Customers', key: 'customer-bookings', label: 'Bookings', actions: R },
  { group: 'Customers', key: 'customer-moveins', label: 'Move-ins', actions: R },
  // Track A (move-out workflow): create/change/reverse case = create/update
  // (inspection sign-off = update); settlement approval = approve.
  { group: 'Customers', key: 'customer-moveouts', label: 'Move-outs', actions: RCUA },
  // Track A (unit transfers): preview/submit = create, Operations correction
  // = update. Approval-and-post rides on bill-transactions:approve (A5).
  { group: 'Customers', key: 'customer-transfers', label: 'Unit transfers', actions: RCU },

  { group: 'Facilities', key: 'facility-map', label: 'Units Information', actions: R },
  { group: 'Facilities', key: 'facility-units', label: 'Units', actions: CRUD },
  { group: 'Facilities', key: 'facility-floors', label: 'Floors', actions: CRUD },
  { group: 'Facilities', key: 'facility-floorplans', label: 'Floor Plan Designer', actions: CRUDA },
  { group: 'Facilities', key: 'facility-floorplan-library', label: 'Floor Plan Library', actions: ['view', 'update', 'delete'] },
  { group: 'Facilities', key: 'facility-maintenance', label: 'Maintenance', actions: CRUD },
  { group: 'Facilities', key: 'facility-assets', label: 'Assets & Vendors', actions: CRUD },
  { group: 'Facilities', key: 'facility-incidents', label: 'Incidents', actions: CRUD },
  { group: 'Facilities', key: 'facility-access', label: 'Access Control', actions: CRUD },
  { group: 'Facilities', key: 'facility-inspections', label: 'Inspections', actions: CRUD },
  // Master Rate Strategy (Track B, Rates and Promotions): draft edit/save +
  // set Active = create/update; batch schedule/apply = update. Applying a
  // batch additionally needs facility-units:update (checked in service code,
  // B3); Replace-manual needs the Owner role (D9, service code). No approval
  // gate: the approve action is retained only for legacy rows.
  { group: 'Rates and Promotions', key: 'facility-rate-strategy', label: 'Master Rate Strategy', actions: RCUA },

  { group: 'Protection & Addons', key: 'extras-plans', label: 'Protection plans', actions: CRUD },
  { group: 'Protection & Addons', key: 'extras-addons', label: 'Addons', actions: CRUD },

  { group: 'Rates and Promotions', key: 'promo-overview', label: 'Dashboard', actions: R },
  { group: 'Rates and Promotions', key: 'promo-discount-matrix', label: 'Discount plan builder', actions: RCU },
  { group: 'Rates and Promotions', key: 'promo-free-months', label: 'Free months', actions: RCU },
  { group: 'Rates and Promotions', key: 'promo-code-builder', label: 'Promo code builder', actions: CRUD },
  { group: 'Rates and Promotions', key: 'promo-library', label: 'Promotions library', actions: CRUDA },
  { group: 'Rates and Promotions', key: 'promo-history', label: 'History', actions: R },
  { group: 'Rates and Promotions', key: 'promo-safeguards', label: 'Safeguards', actions: CRUD },
  { group: 'Rates and Promotions', key: 'promo-performance', label: 'Performance', actions: R },

  { group: 'Finance', key: 'bill-overview', label: 'Overview', actions: R },
  // Finance Phase 1 (FINANCE_MODULE_SPEC §§3–4): one resource per submodule.
  // Invoices: approve = APPROVED step; no delete — lifecycle uses VOID.
  { group: 'Finance', key: 'bill-invoices', label: 'Invoices', actions: RCUA },
  { group: 'Finance', key: 'bill-arrears', label: 'Arrears', actions: RUA },
  // Transactions: approve = per-charge approval; bulk approval NEVER (spec §4.1).
  { group: 'Finance', key: 'bill-transactions', label: 'Transactions, documents & approvals', actions: ['view', 'create', 'update', 'approve'] },
  // Models: drafts deletable; CURRENT/ARCHIVED not deletable (service code).
  { group: 'Finance', key: 'bill-models', label: 'Financial Models', actions: CRUDA },
  // Landlord lease (lease horizon P4, owner D9B): the governed lease-term
  // write path. Manager holds view+update by default; Finance Operator views
  // only (no lease edits); Viewer hidden by default but grantable.
  { group: 'Finance', key: 'bill-lease', label: 'Landlord Lease', actions: RU },
  // Performance: update = variance notes, approve = month close.
  { group: 'Finance', key: 'bill-performance', label: 'Forecast vs Actuals', actions: RUA },
  // Budgets: lease line protected — update denied in code unless protected override.
  { group: 'Finance', key: 'bill-budgets', label: 'Budgets & Expenses', actions: RCUA },
  // Pricing: update = manual override + audit.
  { group: 'Finance', key: 'bill-pricing', label: 'Size Mix & Pricing', actions: RUA },
  { group: 'Finance', key: 'bill-returns', label: 'Investment Returns', actions: R },
  // Library: no delete — versions are immutable history (archive instead).
  { group: 'Finance', key: 'bill-library', label: 'Model Library', actions: RUA },
  // Credits: second approval = approve + threshold in code (Phase 4).
  { group: 'Finance', key: 'bill-credits', label: 'Credits ledger (WIP)', actions: RCUA },
  // Reconciliation: import/match = create/update; close = approve.
  { group: 'Finance', key: 'bill-reconciliation', label: 'Reconciliation', actions: RCUA },
  // Investor: masked approved-only summary (Phase 5, spec §15.4). View only —
  // no mutation action exists for this resource by design.
  { group: 'Finance', key: 'bill-investor', label: 'Investor Summary', actions: R },

  { group: 'Content', key: 'content-list', label: 'All content', actions: CRUD },
  // Landing site builder: approve = publish to storelah.sg (site-builder plan §4.4).
  { group: 'Content', key: 'site-builder', label: 'Site builder', actions: CRUDA },

  { group: 'Global Settings', key: 'settings-general', label: 'General', actions: RU },
  { group: 'Global Settings', key: 'settings-booking', label: 'Booking & billing', actions: RU },
  { group: 'Global Settings', key: 'settings-lead-sla', label: 'Lead & response SLA', actions: RU },
  { group: 'Global Settings', key: 'settings-fees', label: 'Fees & deposits', actions: CRUD },
  { group: 'Global Settings', key: 'settings-facilities', label: 'Facilities', actions: CRUD },
  // Track A (handoff §14): Global Settings › Move-outs & refunds — the
  // moveout.* policy surface. View = read policy; update = save policy.
  { group: 'Global Settings', key: 'settings-moveouts', label: 'Move-outs & refunds', actions: RU },
];

const RESOURCE_BY_KEY = new Map(RESOURCES.map((r) => [r.key, r]));

export function permissionKey(resource: string, action: Action): string {
  return `${resource}:${action}`;
}

/** Every grantable permission key, in catalog order. */
export const ALL_PERMISSIONS: readonly string[] = RESOURCES.flatMap((r) =>
  r.actions.map((a) => permissionKey(r.key, a)),
);

const ALL_PERMISSION_SET = new Set(ALL_PERMISSIONS);

export function isKnownPermission(p: string): boolean {
  return ALL_PERMISSION_SET.has(p);
}

export function resourceOf(p: string): ResourceDef | undefined {
  return RESOURCE_BY_KEY.get(p.split(':')[0]);
}

// ---------- seeded roles ----------

export const OWNER_ROLE_KEY = 'OWNER';

// Manager: everything except settings edits, approvals and destructive
// deletes on leads / tenants. Viewer: read-only, no Finance.
const MANAGER_DENY: Record<string, readonly Action[]> = {
  'settings-general': ['update'],
  'settings-booking': ['update'],
  'settings-fees': ['create', 'update', 'delete'],
  'settings-facilities': ['create', 'update', 'delete'],
  // Track A: Manager keeps the pre-existing move-outs view/update but gets
  // none of the new grants (no case creation, no settlement approval, no
  // transfers surface, no move-out policy edits).
  'customer-moveouts': ['create', 'approve'],
  'customer-transfers': ['view', 'create', 'update'],
  'settings-moveouts': ['view', 'update'],
  'promo-library': ['approve'],
  'facility-floorplans': ['approve'],
  'site-builder': ['approve'],
  'customer-tenants': ['delete'],
  leads: ['delete'],
  // Prototype 2026-11-04: deleting a draft quote is Administrator-only.
  quotes: ['delete'],
  'settings-lead-sla': ['update'],
  // Finance: Manager keeps read-only access to Overview / Invoices / Arrears
  // (pre-existing billing keys). The 9 Phase-1 finance resources are never
  // auto-granted — every action is denied here so the derived matrix stays put.
  'bill-invoices': ['create', 'update', 'delete', 'approve'],
  'bill-arrears': ['create', 'update', 'delete', 'approve'],
  'bill-transactions': ['view', 'create', 'update', 'delete', 'approve'],
  'bill-models': ['view', 'create', 'update', 'delete', 'approve'],
  'bill-performance': ['view', 'update', 'approve'],
  'bill-budgets': ['view', 'create', 'update', 'delete', 'approve'],
  'bill-pricing': ['view', 'update', 'approve'],
  'bill-returns': ['view'],
  // Lease horizon P4 (owner D9B): Manager submits via the library (submit =
  // bill-library:update); approval stays explicitly granted only.
  // bill-models stays denied — Manager edits leases through the governed
  // Landlord Lease path (bill-lease:update), never the legacy section writes.
  'bill-library': ['approve'],
  'bill-credits': ['view', 'create', 'update', 'delete', 'approve'],
  'bill-reconciliation': ['view', 'create', 'update', 'delete', 'approve'],
  // Investor Summary is a separate masked surface — operators keep their
  // existing finance screens; investors see only the summary.
  'bill-investor': ['view'],
};
const VIEWER_HIDDEN = new Set([
  'bill-overview', 'bill-invoices', 'bill-arrears', 'bill-transactions', 'bill-models', 'bill-lease', 'bill-performance',
  'bill-budgets', 'bill-pricing', 'bill-returns', 'bill-library', 'bill-credits', 'bill-reconciliation',
  'bill-investor',
  // Track A: transfers + move-out policy are hidden from Viewer by default
  // (grantable). Move-outs keeps its pre-existing view grant.
  'customer-transfers', 'settings-moveouts',
  // Master Rate Strategy levers are not viewer-surface by default (grantable).
  'facility-rate-strategy',
]);

// Finance role permission sets (FINANCE_MODULE_SPEC §§3–4, IMPLEMENTATION_PLAN §2c).
// Spec §4 wins where the plan is silent: the Approver can approve financial
// models, and Operator/Approver can enter variance/actual notes.
const FINANCE_VIEW_ALL = [
  'bill-overview:view', 'bill-invoices:view', 'bill-arrears:view', 'bill-transactions:view', 'bill-models:view',
  'bill-lease:view',
  'bill-performance:view', 'bill-budgets:view', 'bill-pricing:view', 'bill-returns:view', 'bill-library:view',
  'bill-credits:view', 'bill-reconciliation:view', 'bill-investor:view',
  // Master Rate Strategy: Finance Operator/Approver/Auditor see the target
  // reconciliation surface read-only (Operator/Approver inherit via their
  // spreads below; Auditor holds exactly this list).
  'facility-rate-strategy:view',
] as const;
const FINANCE_OPERATOR_PERMS = [
  ...FINANCE_VIEW_ALL,
  'bill-invoices:create', 'bill-invoices:update',
  'bill-arrears:update',
  // Phase 3: operators raise AND cancel instructions (mistake recovery,
  // customer-paid-at-counter); charging stays approver-only.
  'bill-transactions:create', 'bill-transactions:update',
  'bill-models:create', 'bill-models:update',
  // Lease horizon P4 (owner D9B): Finance Operator keeps model reads and the
  // legacy section writes, but has NO landlord-lease edits — view only (the
  // bill-lease:view grant rides in FINANCE_VIEW_ALL above).
  'bill-performance:update',
  'bill-budgets:create', 'bill-budgets:update',
  'bill-pricing:update',
  // Library update = submit / duplicate / restore / archive / save-version
  // (spec §16.3; approve/reject/set-current stay approver-only). Draft
  // deletion stays Owner-only (least privilege — operators archive instead).
  'bill-library:update',
  'bill-credits:create', 'bill-credits:update',
  'bill-reconciliation:create', 'bill-reconciliation:update',
  // Track A (move-out / refund / transfer): operators run the workflow —
  // move-out cases (view/update), transfers (preview/submit/correct), policy
  // reads. Approval (moveouts:approve, bill-transactions:approve) stays
  // approver-only; policy edits stay approver-only.
  'customer-moveouts:view', 'customer-moveouts:update',
  'customer-transfers:view', 'customer-transfers:create', 'customer-transfers:update',
  'settings-moveouts:view',
] as const;
const FINANCE_APPROVER_PERMS = [
  ...FINANCE_OPERATOR_PERMS,
  'bill-invoices:approve',
  'bill-arrears:approve',
  'bill-transactions:approve',
  'bill-models:approve',
  // Lease horizon P4 (owner D9B): the Finance Approver (≈ Finance Admin) holds
  // the full lease path alongside the model approve grant.
  'bill-lease:update',
  'bill-budgets:approve',
  'bill-performance:approve',
  'bill-credits:approve',
  'bill-library:approve',
  'bill-reconciliation:approve',
  // Track A: approvers hold the settlement-approval grant plus move-out
  // policy edits (handoff §14; ties to D1/D2 — policy edits never rewrite
  // open cases, enforced via R7 snapshots in A3).
  'customer-moveouts:approve',
  'settings-moveouts:update',
] as const;

export const SYSTEM_ROLES: ReadonlyArray<{ key: string; name: string; description: string; locked: boolean; permissions: readonly string[] }> = [
  {
    key: OWNER_ROLE_KEY,
    name: 'Owner',
    description: 'Full access, including users and roles. Cannot be edited.',
    locked: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'MANAGER',
    name: 'Manager',
    description: 'Day-to-day operations. No settings edits, approvals or lead/tenant deletes. Views, edits and submits financial models via the governed Landlord Lease path (approval only if granted).',
    locked: false,
    permissions: RESOURCES.flatMap((r) =>
      r.actions.filter((a) => !(MANAGER_DENY[r.key] || []).includes(a)).map((a) => permissionKey(r.key, a)),
    ),
  },
  {
    key: 'VIEWER',
    name: 'Viewer',
    description: 'Read-only access. Finance is hidden.',
    locked: false,
    permissions: RESOURCES.filter((r) => !VIEWER_HIDDEN.has(r.key)).map((r) => permissionKey(r.key, 'view')),
  },
  // Finance Phase 1: seeded with ZERO members — the Owner assigns operators in
  // Global Settings › Team & access (owner decision Q11). Auditor is read-only
  // on all 12 finance resources; export rides on bill-overview:view (audited).
  {
    key: 'FINANCE_OPERATOR',
    name: 'Finance Operator',
    description: 'Day-to-day finance work. Landlord Lease is view-only (no lease edits). Cannot approve anything or touch the protected lease line.',
    locked: false,
    permissions: [...FINANCE_OPERATOR_PERMS],
  },
  {
    key: 'FINANCE_APPROVER',
    name: 'Finance Approver',
    description: 'Everything the Finance Operator has, plus approvals. Maker-checker enforced in service code.',
    locked: false,
    permissions: [...FINANCE_APPROVER_PERMS],
  },
  {
    key: 'FINANCE_AUDITOR',
    name: 'Finance Auditor',
    description: 'Read-only view of all finance areas. No mutations.',
    locked: false,
    permissions: [...FINANCE_VIEW_ALL],
  },
  // Finance Phase 5 (spec §15.4, owner Q10 FINAL): masked approved-only
  // summary. Exactly one permission — the summary routes carry no customer
  // names, emails, transaction detail or draft/open-month data. The Owner
  // assigns operators to this role in Global Settings › Team & access.
  {
    key: 'INVESTOR',
    name: 'Investor',
    description: 'Masked approved-only summary (modelling + returns + closed months). No mutations, no customer data.',
    locked: false,
    permissions: ['bill-investor:view'],
  },
];

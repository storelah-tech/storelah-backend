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
// below only seed Manager / Viewer (migration + ensureSystemRoles()).

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
const RC: readonly Action[] = ['view', 'create'];
const RCU: readonly Action[] = ['view', 'create', 'update'];
const CRUD: readonly Action[] = ['view', 'create', 'update', 'delete'];
const CRUDA: readonly Action[] = ['view', 'create', 'update', 'delete', 'approve'];

export const RESOURCES: readonly ResourceDef[] = [
  { group: 'Overview', key: 'command', label: 'Command centre', actions: R },
  { group: 'Overview', key: 'portfolio', label: 'Facility portfolio', actions: R },
  { group: 'Overview', key: 'analytics', label: 'Performance dashboards', actions: R },

  { group: 'Leads', key: 'leads', label: 'Lead database', actions: CRUD },
  { group: 'Leads', key: 'pipeline', label: 'Pipeline', actions: RU },
  { group: 'Leads', key: 'quotes', label: 'Quotations', actions: RC },
  { group: 'Leads', key: 'inbox', label: 'Conversations', actions: RCU },
  { group: 'Leads', key: 'calendar', label: 'Appointments', actions: CRUD },
  { group: 'Leads', key: 'automation', label: 'Automation', actions: R },

  { group: 'Customers', key: 'customer-tenants', label: 'Tenants', actions: CRUD },
  { group: 'Customers', key: 'customer-bookings', label: 'Bookings', actions: R },
  { group: 'Customers', key: 'customer-moveins', label: 'Move-ins', actions: R },
  { group: 'Customers', key: 'customer-moveouts', label: 'Move-outs', actions: RU },

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

  { group: 'Protection & Addons', key: 'extras-plans', label: 'Protection plans', actions: CRUD },
  { group: 'Protection & Addons', key: 'extras-addons', label: 'Addons', actions: CRUD },

  { group: 'Discount & Promotion', key: 'promo-overview', label: 'Dashboard', actions: R },
  { group: 'Discount & Promotion', key: 'promo-discount-matrix', label: 'Discount plan builder', actions: RCU },
  { group: 'Discount & Promotion', key: 'promo-free-months', label: 'Free months', actions: RCU },
  { group: 'Discount & Promotion', key: 'promo-code-builder', label: 'Promo code builder', actions: CRUD },
  { group: 'Discount & Promotion', key: 'promo-library', label: 'Promotions library', actions: CRUDA },
  { group: 'Discount & Promotion', key: 'promo-history', label: 'History', actions: R },
  { group: 'Discount & Promotion', key: 'promo-safeguards', label: 'Safeguards', actions: CRUD },
  { group: 'Discount & Promotion', key: 'promo-performance', label: 'Performance', actions: R },

  { group: 'Finance', key: 'bill-overview', label: 'Overview', actions: R },
  { group: 'Finance', key: 'bill-invoices', label: 'Invoices', actions: R },
  { group: 'Finance', key: 'bill-arrears', label: 'Arrears', actions: R },

  { group: 'Content', key: 'content-list', label: 'All content', actions: CRUD },
  // Landing site builder: approve = publish to storelah.sg (site-builder plan §4.4).
  { group: 'Content', key: 'site-builder', label: 'Site builder', actions: CRUDA },

  { group: 'Global Settings', key: 'settings-general', label: 'General', actions: RU },
  { group: 'Global Settings', key: 'settings-booking', label: 'Booking & billing', actions: RU },
  { group: 'Global Settings', key: 'settings-fees', label: 'Fees & deposits', actions: CRUD },
  { group: 'Global Settings', key: 'settings-facilities', label: 'Facilities', actions: CRUD },
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
  'promo-library': ['approve'],
  'facility-floorplans': ['approve'],
  'site-builder': ['approve'],
  'customer-tenants': ['delete'],
  leads: ['delete'],
};
const VIEWER_HIDDEN = new Set(['bill-overview', 'bill-invoices', 'bill-arrears']);

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
    description: 'Day-to-day operations. No settings edits, approvals or lead/tenant deletes.',
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
];

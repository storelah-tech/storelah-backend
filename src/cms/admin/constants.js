// StoreLah CMS admin UI — shared constants: status/tone maps, labels, formatters.
// Extracted from admin.js (phase-1 layering refactor; nodebestpractices #1).
// Pure data and pure functions only — no DOM access, no fetching, no state.

export const STATUS_TONE = {
  OCCUPIED: 'occ',
  AVAILABLE: 'avail',
  RESERVED: 'res',
  OVERDUE: 'over',
  MAINTENANCE: 'neutral',
  INACTIVE: 'neutral',
  BLOCKED: 'neutral',
};

export const STATUS_LABEL = {
  OCCUPIED: 'Occupied',
  AVAILABLE: 'Available',
  RESERVED: 'Reserved',
  OVERDUE: 'Overdue',
  MAINTENANCE: 'Maintenance',
  INACTIVE: 'Inactive',
  BLOCKED: 'Blocked',
};

export const MAP_TONE = {
  OCCUPIED: 'occupied',
  AVAILABLE: 'available',
  RESERVED: 'reserved',
  OVERDUE: 'overdue',
  MAINTENANCE: 'maintenance',
  INACTIVE: 'maintenance',
  BLOCKED: 'blocked',
};

// Unit-map size categorization (see docs/FLOORS.md "Map size legend"):
// cell fill + corner dot = status (MAP_TONE, unchanged); top ribbon + size
// chip = size. Colours mirror the psf-chart size series in dashboardView.js
// (Locker terracotta, Small green, Medium dark green, Large gold).
export const SIZE_COLOR = {
  LOCKER: '#c97952',
  SMALL: '#526557',
  MEDIUM: '#334437',
  LARGE: '#e5a84b',
};

export const SIZE_CLASS = {
  LOCKER: 'size-LOCKER',
  SMALL: 'size-SMALL',
  MEDIUM: 'size-MEDIUM',
  LARGE: 'size-LARGE',
};

export const TENANT_STATUS_TONE = {
  ACTIVE: 'occ',
  DUE_SOON: 'res',
  OVERDUE: 'over',
  NOTICE: 'amber',
  INACTIVE: 'neutral',
};

export const TENANT_STATUS_LABEL = {
  ACTIVE: 'Active',
  DUE_SOON: 'Due Soon',
  OVERDUE: 'Overdue',
  NOTICE: 'Notice',
  INACTIVE: 'Inactive',
};

// Bookings/move-ins tables (rows come from GET /bookings and GET /move-ins).
export const BOOKING_TONE = { PENDING_PAYMENT: 'res', CONFIRMED: 'occ', ACTIVE: 'occ', CANCELLED: 'over' };
export const INVOICE_TONE = { PAID: 'occ', DUE: 'res', OVERDUE: 'over' };

// Unit-detail tabs + tenant-history timeline (operator UX redesign). Tones
// reuse the floor-plan palette classes above (avail/res/occ/over + amber for
// NOTICE + neutral fallback); labels reuse STATUS_LABEL/TENANT_STATUS_LABEL.
export const UNIT_DETAIL_TABS = ['overview', 'history', 'bookings', 'invoices', 'activity'];

export const UNIT_TAB_LABEL = {
  overview: 'Overview',
  history: 'Tenant history',
  bookings: 'Bookings',
  invoices: 'Invoices',
  activity: 'Activity',
};

export const HISTORY_EMPTY_TEXT = 'No prior tenants';

// Stay-stage → badge tone. Tenant stages first; booking/invoice statuses fall
// back to BOOKING_TONE/INVOICE_TONE so linked refs share one colour language.
export const HIST_STAGE_TONE = {
  ACTIVE: 'occ',
  DUE: 'res',
  DUE_SOON: 'res',
  OVERDUE: 'over',
  NOTICE: 'amber',
  INACTIVE: 'neutral',
  PENDING_PAYMENT: 'res',
  CONFIRMED: 'occ',
  CANCELLED: 'over',
  PAID: 'occ',
};

export const HIST_STAGE_LABEL = {
  ACTIVE: 'Active',
  DUE: 'Due',
  DUE_SOON: 'Due Soon',
  OVERDUE: 'Overdue',
  NOTICE: 'Notice',
  INACTIVE: 'Inactive',
};

// Sidebar facility filter sentinel: 'ALL' shows every facility's data; a branch
// code scopes units/tenants/bookings/move-ins to that one facility.
export const ALL_FACILITIES = 'ALL';

// ---------- pure formatters ----------

export const fmtMoney = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

export function fmtDay(iso) {
  return iso ? new Date(iso).toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-SG', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

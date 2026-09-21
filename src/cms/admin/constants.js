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

// Sidebar facility filter sentinel: 'ALL' shows every facility's data; a branch
// code scopes units/tenants/bookings/move-ins to that one facility.
export const ALL_FACILITIES = 'ALL';

// ---------- pure formatters ----------

export const fmtMoney = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

export function fmtDay(iso) {
  return iso ? new Date(iso).toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

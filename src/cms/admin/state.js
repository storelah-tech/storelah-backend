// StoreLah CMS admin UI — shared application state + facility/domain selectors.
// Extracted from admin.js (phase-2 layering refactor; nodebestpractices #1).
// `state` is a single const object mutated in place everywhere; ES module live
// bindings mean every importing module sees the same instance, so existing
// `state.x` references keep working unchanged. Nothing here imports views or
// api/dom (one-way dependencies: views → state/constants).

import { ALL_FACILITIES } from './constants.js';

export const state = {
  units: [], // normalized units (current page only)
  branches: [],
  floors: [],
  sizes: [],
  // tenants-view state
  tenants: [], // normalized tenants (full list; filtered/paged client-side)
  tenantPage: 1,
  tenantPerPage: 10,
  tenantTotal: 0,
  tenantTotalPages: 1,
  tenantQuery: '',
  tenantStatusFilter: '',
  tenantUnits: [], // assignable units for the tenant unit dropdown
  // bookings-view state
  bookings: [], // full enriched list from GET /bookings
  // units-section view state
  view: 'dashboard', // 'dashboard' | 'units' | 'tenants'
  page: 1,
  perPage: 10,
  total: 0,
  totalPages: 1,
  branchCode: 'BM', // drives map + table filter (sidebar branch switcher)
  level: 1, // drives map + table filter (floor tabs)
  statusFilter: '',
  selectedCode: null,
  // floor-plan editor state (facility setup view)
  fp: {
    branchCode: 'BM',
    floorId: null, // selected floor row id
    plan: null, // plan object (or null when none exists)
    branchName: '',
    floorName: '',
    structure: null,
    placements: [], // normalized placed units
    blocks: [], // normalized decoration blocks (name+rect rectangles)
    unplaced: [], // normalized unplaced units (palette)
    scale: 1, // zoom scale factor (grid units → px)
    selected: null, // selected placement unitId
    selectedBlock: null, // selected block id
    canvasDefaults: { width: 20, height: 20 },
    liveDims: null, // live-typed canvas size from the W/H inputs (local, unsaved); null = use plan/server size
  },
};

export function branchByCode(code) {
  return state.branches.find((b) => b.code === code);
}

// Sidebar facility filter: 'ALL' shows every facility's data; a branch code
// scopes units/tenants/bookings/move-ins to that one facility.
export const isAllFacilities = () => state.branchCode === ALL_FACILITIES;
// Display name of the currently selected facility ('' when All).
export const selectedFacilityName = () => (isAllFacilities() ? '' : branchByCode(state.branchCode)?.name || state.branchCode);

export function branchFloors(code) {
  const b = branchByCode(code);
  return state.floors.filter((f) => f.branchId === b?.id).sort((a, c) => a.level - c.level);
}

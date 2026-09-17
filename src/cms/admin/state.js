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
  // leads-view state (lead database table: filters + client-side pager)
  leadStatusFilter: '',
  leadSourceFilter: '',
  leadPage: 1,
  leadPerPage: 10,
  leadsCache: [], // flat leads from the last GET /leads (filters/pager/export read this)
  // date-range filter state per data table ({ from, to } as YYYY-MM-DD or null;
  // server-side via ?from=&to=; pager resets to page 1 on range change)
  leadDate: { from: null, to: null },
  tenantDate: { from: null, to: null },
  bookingDate: { from: null, to: null },
  moveinDate: { from: null, to: null },
  invoiceDate: { from: null, to: null },
  apptDate: { from: null, to: null },
  unitDate: { from: null, to: null },
  promoLibDate: { from: null, to: null },
  promoHistDate: { from: null, to: null },
  // pipeline-view state
  pipelineFilter: '', // '' = all pipelines, otherwise a branch code
  // inbox-view state (real conversation threads from GET /conversations)
  threads: [],
  activeConversationId: null,
  // calendar-view state
  appointmentsCache: [], // rows from the last GET /appointments
  // units-section view state
  view: 'dashboard', // 'dashboard' | 'units' | 'tenants'
  page: 1,
  perPage: 10,
  total: 0,
  totalPages: 1,
  branchCode: 'BM', // drives map + table filter (sidebar branch switcher)
  level: 1, // drives map + table filter (floor tabs)
  statusFilter: '',
  // P1 item 3: unit-map read-path filters (size code + near-lift proximity).
  mapSize: '',
  mapNearLift: false,
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
    scale: 1, // zoom scale factor (feet → px)
    selected: null, // selected placement unitId
    selectedBlock: null, // selected block id
    canvasDefaults: { width: 20, height: 20 },
    liveDims: null, // live-typed canvas size from the W/H inputs (local, unsaved); null = use plan/server size
    lockSqft: true, // resize snaps to the nearest rect preserving area≈sqft (ops can toggle off; server still enforces ±15%)
    ghostRotated: false, // palette drag ghost orientation toggle (swaps W/H for rectangular footprints)
  },
  // Area-metrics panel state (facility setup view; read-only live reads of
  // the Phase-2 endpoints for the editor's selected floor).
  metrics: {
    floorId: null, // floor the panel last rendered (follows state.fp.floorId)
    report: null, // last GET /floor-plans/:floorId/metrics payload
    snapshots: [], // last GET .../metrics/snapshots rows
    loading: false,
    error: '', // last load failure message ('' when healthy)
    seq: 0, // response sequence guard: stale out-of-order responses are dropped
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

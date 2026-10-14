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
  // per-email group mode (Phase 4): 'stage' (default, compat) | 'email'.
  // Group rows come from GET /leads/groups (server-paged); the expanded
  // timeline comes from GET /leads/groups/:key and merges into leadsCache
  // so the detail drawer keeps working for timeline rows.
  leadViewMode: 'stage',
  leadGroupSearch: '', // debounced email/name search sent as ?search=
  leadGroupPage: 1,
  leadGroupPerPage: 10, // client pager stays 10/page (mirrors leadPerPage)
  leadGroups: [], // current page of group summaries from GET /leads/groups
  leadGroupTotal: 0, // meta.total for the group pager
  leadGroupExpanded: null, // groupKey currently expanded (one at a time)
  leadGroupTimelines: {}, // groupKey -> timeline rows (cached per group)
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
  // Units-toolbar explicit filters (override the sidebar scope while set).
  unitBranchFilter: '', // branch code or '' = follow sidebar
  unitLevelFilter: '', // level number as string or '' = all/follow sidebar
  unitAcFilter: '', // '' | 'ac' | 'nonac' (unit type filter)
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
    canvasDefaults: { width: 70, height: 80 },
    liveDims: null, // live-typed canvas size from the W/H inputs (local, unsaved); null = use plan/server size
    lockSqft: false, // ON = resize keeps area ≈ sqft; OFF (default) = resize changes the unit's size on publish (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md). Contracted units are always locked.
    penKind: 'BOUNDARY', // new lines are always BOUNDARY (shown as "Wall" in the UI)
    wallThickness: 0.5, // default thickness (ft) for new WALL lines (follows the last thickness typed)
    objSnap: true, // snap to line endpoints/midpoints/edges and unit/block corners (toolbar #fpObjSnap)
    measureMode: false, // 📏 measure tool active (two clicks → temporary dimension; Esc clears)
    newUnitMode: false, // ＋ New Unit tool active (drag a rectangle → create a DRAFT unit; N toggles, Esc cancels)
    draftSpecs: {}, // unitId → { monthlyRate, sqft } typed in the new-unit form (replayed when undo re-creates a discarded draft)
    multi: [], // multi-selection [{ type: 'placement'|'block'|'marker', id }] (Shift-click / marquee / Cmd+A); 0–1 items = single selection
    layers: null, // { units|blocks|lines|markers: { hidden, locked } } — Layers menu, remembered per browser
    arrayOpen: false, // ⇶ Array form open in the selection strip
    underlay: null, // CMS-only tracing image metadata (GET /floor-plans/:floorId → underlay); bytes via /underlay/image
    underlayMode: null, // null | 'calibrate' (two clicks + real distance) | 'move' (drag the image)
    selectedVertex: null, // index of the selected vertex on the selected line (inspector X/Y, Delete removes)
    snapStep: 0.1, // decimal-ft snap step for drags/resizes/lines/nudges (toolbar #fpSnapStep, remembered per browser; Alt = 0.01 ft)
    ghostRotated: false, // palette drag ghost orientation toggle (swaps W/H for rectangular footprints)
    boundaries: [], // normalized boundary line items (grid-ft polylines; kind 'PENCIL' = pencil-drawn lines)
    drawMode: false, // ✎ line tool active — canvas press-drag draws a line, placement/block drags gated off
    selectedBoundary: null, // selected boundary line-item id (info strip shows Remove line)
    markers: [], // normalized safety/facility point icons (extinguisher, do-not-enter, ...)
    selectedMarker: null, // selected marker id (info strip shows rename/remove)
    armedMarker: null, // marker kind armed from the Markers/Safety toolbar group — next canvas click places it (Esc cancels)
    blockColor: null, // pending fill colour for the next block created via the block form (null = default tone)
    gfa: null, // operator-entered plan GFA in sqft (mirrors FloorPlan.gfaSqft; null = unset, metrics fall back to canvas rect)
    tool: 'select', // Studio ribbon sticky tool: 'select' | 'add' | 'draw' | 'block' (placement modes drawMode/armedMarker win for the MODE badge)
    showGrid: true, // Studio 1-ft grid overlay on the editor canvas (view-only; preview keeps its grid)
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
  // Level-selector source of truth: ACTIVE floors only (isActive !== false).
  // Inactive (hidden) floors never appear as selectable levels — not in the
  // unit-map tabs, the unit-form floor dropdown, or the floor-plan editor.
  // They stay visible solely in the Floors management list (floorsView reads
  // state.floors directly) so they can be reactivated. Rows predating the
  // isActive flag (missing field) count as active.
  return state.floors
    .filter((f) => f.branchId === b?.id && f.isActive !== false)
    .sort((a, c) => a.level - c.level);
}

// Clamp state.level to an active level for the branch: keeps the current
// level when still active, otherwise falls back to the first active level
// (L1). Returns the level, or null when the branch has no active floor
// (selectors render an empty state instead of broken tabs).
export function ensureActiveLevel(code) {
  const floors = branchFloors(code ?? state.branchCode);
  if (!floors.length) return null;
  if (!floors.some((f) => f.level === state.level)) state.level = floors[0].level;
  return state.level;
}

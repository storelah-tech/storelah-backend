// StoreLah CMS admin UI — Master Rate Strategy workspace (Track B, B4).
//
// Rates and Promotions › Master rate strategy (`#promotions` + panel
// `facility-rate-strategy`; legacy `#facilities` deep links redirect here).
// Calls ONLY the B3 CMS routes — no new endpoints:
//   GET /rate-strategy/library, POST /facilities/:branchId/rate-strategy,
//   GET/PATCH /rate-strategy/:id, GET /rate-strategy/:id/preview,
//   POST /rate-strategy/:id/{validate,activate,duplicate},
//   POST /rate-strategy/:id/batches, GET /rate-batches, GET /rate-batches/:id,
//   POST /rate-batches/:id/{apply,retry-failed,cancel},
//   POST /units/rate-batches/apply-due,
// plus the shared reads GET /finance/audit (activity feed),
// GET /business-rules + PUT /business-rules (settings) and
// GET /finance/models (CURRENT target readout).
//
// Flow (no approval gate): Save draft → Set Active → Apply rates to Units.
// Apply is enabled only for a saved Active version with no unsaved changes.
//
// Body self-mounts into #rateStrategyRoot (like extrasView.js); the tab and
// panel shell live in dashboard.html. Permission gating follows access.js:
// the panel requires `facility-rate-strategy:view`; every action button
// carries an explicit data-perm so the sweep hides what the role lacks.

import { get, post, patch, put, request, describeError, can } from './api.js';
import { $, $$, escapeHtml, showBanner } from './dom.js';
import { state } from './state.js';
import { canView } from './access.js';
import { confirmDialog } from './confirmDialog.js';

const PANEL = 'facility-rate-strategy';
const DURATIONS = [1, 3, 6, 12];
const CATEGORIES = ['LOCKER', 'XS', 'S', 'M', 'L', 'XL'];
const CONFLICT_RULES = ['PRESERVE_MANUAL', 'REPLACE_MANUAL', 'CANCEL_IF_MANUAL'];

// Last panel root that rendered the show view — duration-card clicks that hit
// the preview cache re-render without a fresh root, so they fall back to this.
let rsRoot = null;

const DEFAULT_LEVERS_UI = {
  referenceSize: 10, startingRate: 90, method: 'SMOOTH', curveStrength: 0.2,
  stepEvery: 5, stepPsf: 0.2, psfFloor: 4.2, minMonthly: 45,
  lockerAdj: -25, groundFloorAdj: 10, restrictedAdj: -10, facilityAdj: 0,
  rounding: 1,
  categoryFloors: { LOCKER: 7.0, XS: 7.0, S: 6.5, M: 5.8, L: 5.0, XL: 4.2 },
};

const view = {
  tab: 'list', // list | scheduler | settings
  branchFilter: '',
  statusFilter: '',
  batchBranchFilter: '',
  batchStatusFilter: '',
  versionId: null,
  version: null,
  duration: 12,
  kpiDuration: 12,
  matrix: 'Standard',
  range: 'stocked', // stocked | all (§15.11)
  rangeFrom: 8,
  rangeTo: 150,
  planIds: null, // null = stored selection; otherwise explicit preview plan set
  plans: null,
  previews: {}, // durationMonths -> preview payload (B3 preview route)
  preview: null,
  previewError: null,
  liveDirty: false, // B-4: inline levers differ from the saved draft
  validation: null,
  history: null,
  activity: null,
  batches: null,
  batchDetail: null,
  settings: null,
  models: null,
};

function todaySg() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // YYYY-MM-DD
}

function statusPill(s) {
  const cls = s === 'APPROVED' || s === 'ACTIVE' || s === 'APPLIED' ? 'green'
    : s === 'REJECTED' || s === 'FAILED' ? 'red'
    : s === 'CANCELLED' || s === 'SUPERSEDED' ? 'grey' : s === 'SCHEDULED' || s === 'PENDING_APPROVAL' ? 'blue' : 'amber';
  return '<span class="pill ' + cls + '">' + escapeHtml(String(s).replace(/_/g, ' ')) + '</span>';
}

function outcomePill(o) {
  const cls = o === 'APPLIED' ? 'green' : o === 'FAILED' ? 'red' : o === 'PENDING' ? 'amber' : '';
  return '<span class="pill ' + cls + '">' + escapeHtml(String(o).replace(/_/g, ' ')) + '</span>';
}

function fmtMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return 'S$' + Number(n).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPsf(n) {
  // PSF is display-only at 2 decimals everywhere in this module (S$6.83,
  // S$3.96, S$3.30). The engine keeps 4dp internally; never show it here.
  if (n == null || Number.isNaN(Number(n))) return '—';
  return 'S$' + Number(n).toFixed(2);
}

function fmtDay(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: 'numeric' });
}

function branchOptions(selected) {
  return '<option value="">All facilities</option>' + (state.branches || []).map((b) =>
    '<option value="' + escapeHtml(b.id) + '"' + (selected === b.id ? ' selected' : '') + '>' +
    escapeHtml(b.code + ' · ' + b.name) + '</option>').join('');
}

function branchLabel(row) {
  return escapeHtml(row.branchCode || row.branchId || '—');
}

function permNote(perm) {
  return '<div class="section-empty">You need the <b>' + escapeHtml(perm) + '</b> permission for this action.</div>';
}

// ============================== entry ==============================

export async function bindRateStrategyPanel() {
  const root = $('#rateStrategyRoot');
  if (!root) return;
  if (!canView(PANEL)) {
    root.innerHTML = '<div class="section-empty">Master rate strategy needs the <b>facility-rate-strategy:view</b> permission.</div>';
    return;
  }
  renderShell(root);
  await showRoot(root);
}

export async function refreshRateStrategy() {
  const root = $('#rateStrategyRoot');
  if (!root) return;
  await bindRateStrategyPanel();
}

function renderShell(root) {
  ensureRsWorkbenchStyles();
  // B-2: no Strategies / Scheduler / Settings tabs — the workspace reads as
  // one scrolling page (§15.3). The library, batches and defaults stack on
  // the landing view; the open strategy renders every section in §15.3 order.
  root.innerHTML =
    '<div class="tbl-toolbar"><div><span class="t-type">Library, batches and defaults on one page — open a strategy for the single-page workspace.</span></div>' +
    '<span style="flex:1"></span>' +
    (can('facility-rate-strategy:create') ? '<button class="tb-btn primary" data-rs-new data-perm="facility-rate-strategy:create">＋ New strategy</button>' : '') +
    '</div>' +
    '<div class="modal-alert" id="rsBanner" hidden></div>' +
    '<div id="rsBody"></div>';
  const nw = root.querySelector('[data-rs-new]');
  if (nw) nw.addEventListener('click', () => openCreateModal(root));
}

function rsError(root, e) {
  const banner = root.querySelector('#rsBanner') || $('#rsBanner');
  if (banner) {
    banner.hidden = false;
    banner.textContent = describeError(e);
  } else {
    showBanner('Rate strategy: ' + describeError(e));
  }
}

async function showRoot(root) {
  const body = root.querySelector('#rsBody');
  if (view.versionId) await renderShow(body, root);
  else await renderLibraryPage(body, root);
}

// B-2: the landing view is one scrolling page — library, then the live
// scheduler content, then the live settings content (§15.3: no tab split).
async function renderLibraryPage(body, root) {
  body.innerHTML =
    '<div class="sec-hdr"><div><div class="sec-title">Strategy library</div>' +
    '<div class="sec-sub">Filter by facility or status, then open a version for the single-page workspace.</div></div></div>' +
    '<div id="rsLibSec"></div>' +
    '<div class="sec-hdr" style="margin-top:16px;"><div><div class="sec-title">Rate batches</div>' +
    '<div class="sec-sub">Future-dated batches stay Scheduled until due — Apply due batches is idempotent and safe to repeat. Batch detail actions (apply, retry failed, cancel) live on each batch.</div></div></div>' +
    '<div id="rsSchedSec"></div>' +
    '<div style="margin-top:16px;" id="rsSetSec"></div>';
  await renderList($('#rsLibSec'), root);
  await renderScheduler($('#rsSchedSec'), root);
  await renderSettings($('#rsSetSec'), root);
}

// ============================== list ==============================

async function renderList(body, root) {
  body.innerHTML =
    '<div class="tbl-toolbar"><select id="rsBranchFilter" class="tbl-select">' + branchOptions(view.branchFilter) + '</select>' +
    '<select id="rsStatusFilter" class="tbl-select"><option value="">All statuses</option>' +
    ['DRAFT', 'ACTIVE'].map((s) =>
      '<option value="' + s + '"' + (view.statusFilter === s ? ' selected' : '') + '>' + s.replace(/_/g, ' ') + '</option>').join('') +
    '</select><span style="flex:1"></span><button class="tb-btn ghost" id="rsReload">Reload</button></div>' +
    '<div id="rsListState"><div class="section-empty">Loading strategies…</div></div>';
  $('#rsBranchFilter').addEventListener('change', (e) => { view.branchFilter = e.target.value; loadList(root); });
  $('#rsStatusFilter').addEventListener('change', (e) => { view.statusFilter = e.target.value; loadList(root); });
  $('#rsReload').addEventListener('click', () => loadList(root));
  await loadList(root);
}

async function loadList(root) {
  const host = $('#rsListState');
  try {
    const q = new URLSearchParams();
    if (view.branchFilter) q.set('branchId', view.branchFilter);
    if (view.statusFilter) q.set('status', view.statusFilter);
    const rows = await get('/rate-strategy/library' + (q.toString() ? '?' + q.toString() : ''));
    if (!rows || !rows.length) {
      host.innerHTML = '<div class="section-empty">No strategies match these filters.</div>';
      return;
    }
    host.innerHTML = '<div class="rs-table-scroll"><table class="data-tbl"><thead><tr><th>Strategy</th><th>Version</th><th>Status</th><th>Facility</th><th>Effective from</th><th>Owner</th><th>Updated</th><th></th></tr></thead><tbody>' +
      rows.map((r) =>
        '<tr><td><b>' + escapeHtml(r.strategyName) + '</b>' + (r.currentVersion ? '<div class="t-type">current</div>' : '') + '</td>' +
        '<td>v' + r.versionNo + '</td><td>' + statusPill(r.status) + '</td>' +
        '<td>' + branchLabel(r) + '</td><td>' + escapeHtml(r.effectiveFrom || '—') + '</td>' +
        '<td>' + escapeHtml(r.owner || '—') + '</td><td>' + escapeHtml(fmtDay(r.updatedAt)) + '</td>' +
        '<td><button class="tb-btn ghost" data-rs-open="' + escapeHtml(r.versionId) + '" data-perm="facility-rate-strategy:view">Open</button></td></tr>').join('') +
      '</tbody></table></div>';
    host.querySelectorAll('[data-rs-open]').forEach((b) => b.addEventListener('click', async () => {
      view.versionId = b.dataset.rsOpen;
      view.version = null; view.preview = null; view.previewError = null; view.liveDirty = false; view.validation = null; view.history = null; view.activity = null;
      view.previews = {}; view.planIds = null; view.plans = null;
      await renderShow($('#rsBody'), root);
    }));
  } catch (e) {
    host.innerHTML = '<div class="section-empty">Strategies failed to load: ' + escapeHtml(describeError(e)) + '</div>';
  }
}

// ============================== show ==============================

async function renderShow(body, root) {
  rsRoot = root;
  view.liveDirty = false;
  body.innerHTML = '<div class="section-empty">Loading strategy…</div>';
  try {
    const v = await get('/rate-strategy/' + encodeURIComponent(view.versionId));
    view.version = v;
  } catch (e) {
    body.innerHTML = '<div class="section-empty">Strategy failed to load: ' + escapeHtml(describeError(e)) + '</div>';
    return;
  }
  const v = view.version;
  const isDraft = v.status === 'DRAFT';
  const isActive = v.status === 'ACTIVE' || v.status === 'APPROVED';

  // Apply rates to Units is enabled only for a saved Active version with no
  // unsaved changes (setLiveDirty re-evaluates the disabled state live).
  const canApply = isActive;

  // B-2: one scrolling page in §15.3 order — header action bar (§15.4:
  // Strategy library, Undo, Save draft, Set Active, Duplicate for facility,
  // Validate strategy, Apply rates to Units + status chip), target decision
  // banner, context row, then KPIs, workbench (levers beside live chart),
  // duration cards, categories, promotion library, unit-rate table,
  // validation, history, activity, batches, settings. Every action renders
  // whenever its permission is held and is disabled (not hidden) when the
  // version state disallows it, so the header always reads the same.
  body.innerHTML =
    '<div class="sec-hdr"><div><div class="sec-title">' + escapeHtml(v.strategyName) + ' <span class="t-type">v' + v.versionNo + '</span></div>' +
    '<div class="sec-sub">' + branchLabel(v) + ' · effective ' + escapeHtml(v.effectiveFrom || '—') +
    (v.originVersionId ? ' · duplicated from ' + escapeHtml(v.originVersionId) : '') +
    ' · <span class="t-type">id ' + escapeHtml(v.id) + ' · optimistic-lock v' + v.version + '</span></div></div>' +
    '<div>' + statusPill(v.status) + ' <span class="t-type" id="rsUnsaved" hidden>· Unsaved changes</span></div></div>' +
    '<div class="tbl-toolbar" id="rsActions">' +
    (can('facility-rate-strategy:view') ? '<button class="tb-btn ghost" data-rs-back data-perm="facility-rate-strategy:view">Strategy library</button>' : '') +
    (can('facility-rate-strategy:update') ? '<button class="tb-btn ghost" data-rs-undo data-perm="facility-rate-strategy:update" disabled title="Undo — restores last saved state; disabled with no unsaved changes.">Undo</button>' : '') +
    (can('facility-rate-strategy:update') ? '<button class="tb-btn" data-rs-edit data-perm="facility-rate-strategy:update"' + (isDraft ? '' : ' disabled title="Only a Draft can be saved."') + '>Save draft</button>' : '') +
    (can('facility-rate-strategy:update') ? '<button class="tb-btn primary" data-rs-activate data-perm="facility-rate-strategy:update" data-rs-gate="activate"' + (isDraft ? '' : ' disabled title="Only a Draft can be set Active."') + '>Set Active</button>' : '') +
    (can('facility-rate-strategy:create') ? '<button class="tb-btn" data-rs-duplicate data-perm="facility-rate-strategy:create">Duplicate for facility</button>' : '') +
    (can('facility-rate-strategy:view') ? '<button class="tb-btn" data-rs-validate data-perm="facility-rate-strategy:view">Validate strategy</button>' : '') +
    (can('facility-rate-strategy:update') ? '<button class="tb-btn primary" data-rs-schedule data-perm="facility-rate-strategy:update" data-rs-gate="apply"' + (canApply ? '' : ' disabled title="Only Active versions with no unsaved changes can apply rates to Units."') + '>Apply rates to Units</button>' : '') +
    '</div>' +
    '<div id="rsTargetBanner"></div>' +
    '<div class="tbl-card" id="rsContextCard"><div class="sec-hdr"><div><div class="sec-title">Strategy context</div><div class="sec-sub">Facility · name · effective date · inventory source · target source (§15.5).</div></div></div><div id="rsContext"><div class="section-empty">Loading context…</div></div></div>' +
    '<div class="tbl-card" id="rsKpiCard"><div class="sec-hdr"><div><div class="sec-title">Rate KPIs</div><div class="sec-sub">Base rack-rate KPIs never change with promotion/duration; promotion KPIs follow the selected 1/3/6/12 duration (§15.6–15.7).</div></div></div>' +
    '<div class="tbl-toolbar" id="rsKpiDurBar"><span class="t-type">Duration</span>' + DURATIONS.map((d) =>
      '<button class="tb-btn' + (view.kpiDuration === d ? ' primary' : ' ghost') + '" data-rs-kpi-dur="' + d + '" data-perm="facility-rate-strategy:view" aria-pressed="' + (view.kpiDuration === d) + '">' + d + ' mo</button>').join('') + '</div>' +
    '<div id="rsKpis"><div class="section-empty">Run preview to fill KPIs.</div></div></div>' +
    '<div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">Pricing workbench</div><div class="sec-sub">Controls and live chart side by side (§15.5). Every change recalculates chart, categories, duration cards, unit table, totals and validation.</div></div></div>' +
    '<div class="tbl-toolbar" id="rsDurBar"><span class="t-type">Duration</span>' + DURATIONS.map((d) =>
      '<button class="tb-btn' + (view.duration === d ? ' primary' : ' ghost') + '" data-rs-dur="' + d + '" data-perm="facility-rate-strategy:view">' + d + ' mo</button>').join('') +
    '<select id="rsMatrix" class="tbl-select"><option' + (view.matrix === 'Standard' ? ' selected' : '') + '>Standard</option><option' + (view.matrix === 'Ground floor' ? ' selected' : '') + '>Ground floor</option></select></div>' +
    '<div class="rs-workgrid"><div class="rs-workcol">' +
    '<div class="sec-hdr"><div><div class="sec-title">Levers</div><div class="sec-sub">' +     (isDraft ? 'Draft — edit beside the chart; Save draft persists, Undo restores. Recommended: smooth curve.' : 'Frozen once Active — duplicate for the next iteration.') + '</div></div></div>' +
    '<div id="rsLevers">' + (isDraft ? leverEditHtml(v.levers) : leverSummaryHtml(v.levers)) + '</div></div>' +
    '<div class="rs-workcol"><div class="sec-hdr"><div><div class="sec-title">Live chart</div><div class="sec-sub">Rack · Effective · Blended (only when free months apply) · approved Financial Model target.</div></div></div>' +
    '<div id="rsChart"><div class="section-empty">Calculating preview…</div></div>' +
    (isDraft ? '<div class="tbl-toolbar"><button class="tb-btn ghost" id="rsLiveRefresh" data-perm="facility-rate-strategy:view">Refresh preview</button><span class="t-type">Lever edits recalculate live — refresh is only a fallback.</span></div>' : '') + '</div></div>' +
    '<div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">PSF by customer storage duration</div><div class="sec-sub">One card per 1/3/6/12-month commitment — select a card to synchronise chart, categories and unit table (§15.12).</div></div></div>' +
    '<div id="rsDurCards"><div class="section-empty">Calculating preview…</div></div></div>' +
    '<div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">Size categories and live rate outcomes</div><div class="sec-sub">Net/Effective PSF ranges by category, synchronised with the workbench duration filter (§15.12).</div></div></div>' +
    '<div id="rsCats"><div class="section-empty">Run Preview to fill the category table.</div></div></div>' +
    '<div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">Discount &amp; Promotion library</div><div class="sec-sub">Read-only preview — selecting a plan never activates it. Draft plans are preview-only (§15.13).</div></div></div>' +
    '<div id="rsPromos"><div class="section-empty">Loading promotion library…</div></div></div>' +
    '<div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">Unit-rate breakdown</div><div class="sec-sub">Read-only sample from live Units inventory, CURRENT Financial Model target and the promotion library.</div></div></div>' +
    '<div class="tbl-toolbar" id="rsUnitBar"><span class="t-type">Duration</span>' + DURATIONS.map((d) =>
      '<button class="tb-btn' + (view.duration === d ? ' primary' : ' ghost') + '" data-rs-dur="' + d + '" data-perm="facility-rate-strategy:view">' + d + ' mo</button>').join('') +
    '<select id="rsRange" class="tbl-select"><option value="stocked"' + (view.range === 'stocked' ? ' selected' : '') + '>Facility sizes only</option><option value="all"' + (view.range === 'all' ? ' selected' : '') + '>Every 1 sq ft</option></select>' +
    '<input id="rsFrom" type="number" class="set-input" style="width:76px" min="8" max="150" value="' + view.rangeFrom + '" title="From size">' +
    '<input id="rsTo" type="number" class="set-input" style="width:76px" min="8" max="150" value="' + view.rangeTo + '" title="To size">' +
    '<span class="t-type">Live — changes recalculate immediately.</span></div>' +
    '<div id="rsPreview"><div class="section-empty">Calculating preview…</div></div></div>' +
    '<div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">Validation</div><div class="sec-sub">Warnings are display-only. Only red blockers prevent Set Active or Apply.</div></div></div>' +
    '<div id="rsValidation"><div class="section-empty">Run Validate strategy to check blockers and warnings.</div></div></div>' +
    '<div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">Version history</div><div class="sec-sub">Every version is immutable once Active.</div></div></div>' +
    '<div id="rsHistory"><div class="section-empty">Loading history…</div></div></div>' +
    '<div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">Activity</div><div class="sec-sub">Rate-strategy and batch audit trail for this version.</div></div></div>' +
    '<div id="rsActivity"><div class="section-empty">Loading activity…</div></div></div>' +
    '<div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">Rate batches — this version</div><div class="sec-sub">Future-dated batches stay Scheduled until due — Apply due batches is idempotent and safe to repeat. Batch detail actions (apply, retry failed, cancel) live on each batch. Occupied-customer rent is never touched.</div></div><div>' +
    (can('facility-rate-strategy:update') ? '<button class="tb-btn primary" id="rsVersionApplyDue" data-perm="facility-rate-strategy:update">Apply due batches</button>' : '') + '</div></div>' +
    '<div id="rsVersionBatches"><div class="section-empty">Loading batches…</div></div><div id="rsBatchDetail"></div></div>' +
    '<div style="margin-top:16px;" id="rsDetailSettings"></div>';

  const back = body.querySelector('[data-rs-back]');
  if (back) back.addEventListener('click', async () => { view.versionId = null; view.previews = {}; view.planIds = null; view.plans = null; await showRoot(root); });
  body.querySelectorAll('[data-rs-dur]').forEach((b) => b.addEventListener('click', () => {
    setDuration(Number(b.dataset.rsDur), body, root);
  }));
  body.querySelectorAll('[data-rs-kpi-dur]').forEach((b) => b.addEventListener('click', () => {
    setKpiDuration(Number(b.dataset.rsKpiDur));
  }));
  const edit = body.querySelector('[data-rs-edit]');
  if (edit) edit.addEventListener('click', () => saveInlineDraft(root));
  const valBtn = body.querySelector('[data-rs-validate]');
  if (valBtn) valBtn.addEventListener('click', () => runValidation(root));
  const act = body.querySelector('[data-rs-activate]');
  if (act) act.addEventListener('click', () => activateStrategy(root, v));
  const dup = body.querySelector('[data-rs-duplicate]');
  if (dup) dup.addEventListener('click', () => openDuplicateModal(root, v));
  const sch = body.querySelector('[data-rs-schedule]');
  if (sch) sch.addEventListener('click', () => openBatchModal(root, v));
  const undoBtn = body.querySelector('[data-rs-undo]');
  if (undoBtn) undoBtn.addEventListener('click', () => undoLiveEdits(root));
  // B-4: workbench edits live beside the chart — matrix/range/duration
  // recalculate immediately; inline levers recalculate live (debounced
  // unsaved preview). Save persists the draft; Undo restores it.
  const matrixSel = $('#rsMatrix');
  if (matrixSel) matrixSel.addEventListener('change', () => {
    view.matrix = matrixSel.value;
    view.previews = {};
    if (isDraft && hasLeverInputs()) scheduleLivePreview(root, true);
    else refreshWorkbench(root);
  });
  const rangeSel = $('#rsRange');
  if (rangeSel) rangeSel.addEventListener('change', (e) => {
    view.range = e.target.value === 'all' ? 'all' : 'stocked';
    if (view.previews[view.duration]) renderPreviewTables(root);
    else refreshWorkbench(root);
  });
  const fromEl = $('#rsFrom');
  const toEl = $('#rsTo');
  if (fromEl && toEl) {
    const applyRange = () => {
      view.range = rangeSel ? rangeSel.value === 'all' ? 'all' : 'stocked' : view.range;
      view.rangeFrom = Math.max(8, Number(fromEl.value) || 8);
      view.rangeTo = Math.min(150, Number(toEl.value) || 150);
      if (view.previews[view.duration]) renderPreviewTables(root);
      else refreshWorkbench(root);
    };
    fromEl.addEventListener('change', applyRange);
    toEl.addEventListener('change', applyRange);
  }
  bindLeverInputs(root);
  const inlineSave = $('#rsInlineSave');
  if (inlineSave) inlineSave.addEventListener('click', () => saveInlineDraft(root));
  const allLevers = $('#rsAllLevers');
  if (allLevers) allLevers.addEventListener('click', () => openLeverModal(root, view.version || v, null));
  const liveRefresh = $('#rsLiveRefresh');
  if (liveRefresh) liveRefresh.addEventListener('click', () => scheduleLivePreview(root, true));

  loadPromos(root);
  loadHistory(root);
  loadActivity(root);
  loadVersionBatches(root);
  renderSettings($('#rsDetailSettings'), root);
  // B-4: live chart on open — no Preview click needed.
  refreshWorkbench(root);
}

function readInlineLevers() {
  const num = (id) => {
    const el = document.querySelector('[data-rs-lever="' + id + '"]');
    if (!el) return undefined;
    const raw = String(el.value || '').trim();
    if (raw === '') return undefined;
    return Number(raw);
  };
  const pct = (id) => {
    const n = num(id);
    return n === undefined ? undefined : n / 100;
  };
  const methodEl = document.querySelector('[data-rs-lever="method"]');
  const rounding = num('rounding');
  return {
    referenceSize: num('referenceSize'),
    startingRate: num('startingRate'),
    method: methodEl ? methodEl.value : undefined,
    curveStrength: num('curveStrength'),
    stepEvery: num('stepEvery'),
    stepPsf: num('stepPsf'),
    psfFloor: num('psfFloor'),
    minMonthly: num('minMonthly'),
    lockerAdj: pct('lockerAdj'),
    groundFloorAdj: pct('groundFloorAdj'),
    restrictedAdj: pct('restrictedAdj'),
    facilityAdj: pct('facilityAdj'),
    rounding: rounding === 5 || rounding === 10 ? rounding : rounding === 1 ? 1 : undefined,
  };
}

function hasLeverInputs() {
  return !!document.querySelector('[data-rs-lever="referenceSize"]');
}

/** Parse the inline workbench into server-shaped levers, or null while the
 *  operator is mid-typing (empty / non-numeric field) — the last chart
 *  stays until the input is valid again. Never sends client totals: the
 *  server recalculates everything from these inputs. */
function readLiveLevers() {
  if (!hasLeverInputs()) return null;
  const levers = readInlineLevers();
  const scalars = ['referenceSize', 'startingRate', 'curveStrength', 'stepEvery', 'stepPsf',
    'psfFloor', 'minMonthly', 'lockerAdj', 'groundFloorAdj', 'restrictedAdj', 'facilityAdj'];
  for (const k of scalars) {
    const n = levers[k];
    if (n === undefined || !Number.isFinite(n)) return null;
  }
  if (levers.method !== 'SMOOTH' && levers.method !== 'STEP') return null;
  return levers;
}

/** B-4 live recalculation: POST the unsaved levers to the read-only
 *  preview route (no draft write, no version bump) and repaint. */
async function fetchPreviewLive(durationMonths) {
  const levers = readLiveLevers();
  if (!levers) return null;
  const body = { levers, durationMonths, matrix: view.matrix };
  if (Array.isArray(view.planIds) && view.planIds.length) body.planIds = view.planIds;
  return post('/rate-strategy/' + encodeURIComponent(view.versionId) + '/preview', body);
}

let rsLiveTimer = null;
let rsLiveSeq = 0;

function scheduleLivePreview(root, immediate) {
  if (!view.version || view.version.status !== 'DRAFT' || !hasLeverInputs()) return;
  if (rsLiveTimer) clearTimeout(rsLiveTimer);
  const run = () => {
    rsLiveTimer = null;
    refreshWorkbenchLive(root).catch((e) => {
      const banner = $('#rsBanner');
      if (banner && !view.previewError) {
        banner.hidden = false;
        banner.textContent = 'Live preview failed: ' + describeError(e) + ' — last calculated chart kept. Refresh preview retries.';
      }
    });
  };
  if (immediate) run();
  else rsLiveTimer = setTimeout(run, 450);
}

/** Live path: all four durations with the unsaved levers, then the same
 *  render tail as the saved path (chart, categories, cards, unit table,
 *  KPIs, context, target banner, no-target state). */
async function refreshWorkbenchLive(root) {
  const seq = ++rsLiveSeq;
  for (const id of ['#rsChart', '#rsCats', '#rsDurCards', '#rsPreview']) {
    const host = $(id);
    if (host && !view.previews[view.duration]) host.innerHTML = '<div class="section-empty">Recalculating…</div>';
  }
  const all = await Promise.all(DURATIONS.map((d) => fetchPreviewLive(d)));
  if (seq !== rsLiveSeq) return; // a newer keystroke already superseded this run
  if (all.some((d) => d === null)) return; // mid-typing — keep last chart
  view.previews = {};
  DURATIONS.forEach((d, i) => { view.previews[d] = all[i]; });
  view.preview = view.previews[view.duration];
  view.previewError = null;
  view.noTarget = !!(view.preview && (view.preview.noTarget || view.preview.targetUnavailable || !view.preview.target));
  setLiveDirty(true);
  renderWorkbenchViews(root);
  paintPromoSelection();
  paintNoTargetBanner(null);
}

/** Shared no-target readout (B-6): the rack schedule still previews with
 *  the target marked unavailable; submit still blocks server-side. */
function paintNoTargetBanner(errorMsg) {
  const banner = $('#rsBanner');
  if (!banner) return;
  if (view.noTarget) {
    banner.hidden = false;
    banner.textContent = 'Financial Model target unavailable: no CURRENT (approved) model is linked for this facility — target and promotion outcomes are marked unavailable below, rack rates still preview. Ask Finance to approve a model; Rate Strategy never falls back to a sample target.';
  } else if (errorMsg) {
    banner.hidden = false;
    banner.textContent = errorMsg;
  } else if (!view.previewError) {
    banner.hidden = true;
  }
}

function setLiveDirty(dirty) {
  view.liveDirty = dirty;
  const flag = $('#rsUnsaved');
  if (flag) flag.hidden = !dirty;
  const undoBtn = document.querySelector('[data-rs-undo]');
  if (undoBtn) {
    undoBtn.disabled = !dirty;
    undoBtn.title = dirty
      ? 'Undo — restores last saved state.'
      : 'Undo — restores last saved state; disabled with no unsaved changes.';
  }
  // Apply rates to Units and Set Active both require a saved version with no
  // unsaved changes — re-evaluate their disabled state live.
  const applyBtn = document.querySelector('[data-rs-schedule]');
  if (applyBtn && applyBtn.dataset.rsGate === 'apply') {
    const ok = view.version && (view.version.status === 'ACTIVE' || view.version.status === 'APPROVED') && !dirty;
    applyBtn.disabled = !ok;
    applyBtn.title = ok ? '' : 'Only Active versions with no unsaved changes can apply rates to Units.';
  }
  const activeBtn = document.querySelector('[data-rs-activate]');
  if (activeBtn && view.version) {
    const ok = view.version.status === 'DRAFT' && !dirty;
    activeBtn.disabled = !ok;
    activeBtn.title = ok ? '' : (view.version.status !== 'DRAFT'
      ? 'Only a Draft can be set Active.'
      : 'Save the draft first — unsaved changes must be saved or undone before Set Active.');
  }
}

/** Persist the inline levers (PATCH draft) and repaint from saved state. */
async function saveInlineDraft(root) {
  const v = view.version;
  if (!v || v.status !== 'DRAFT') return;
  const btn = $('#rsInlineSave') || document.querySelector('[data-rs-edit]');
  if (btn) btn.disabled = true;
  try {
    const levers = readInlineLevers();
    await patch('/rate-strategy/' + encodeURIComponent(v.id), { version: v.version, levers });
    showBanner('Draft saved — chart, categories, cards and unit table recalculated.', true);
    setLiveDirty(false);
    await refreshShow(root);
  } catch (e) {
    rsError(root, e);
    if (btn) btn.disabled = false;
  }
}

/** Undo — restores the inline inputs to the last saved draft and
 *  recalculates from saved state (handoff §15.4). */
async function undoLiveEdits(root) {
  if (!view.liveDirty) {
    showBanner('No unsaved changes — workbench matches the saved draft.');
    return;
  }
  const host = $('#rsLevers');
  if (host && view.version) {
    host.innerHTML = leverEditHtml(view.version.levers);
    bindLeverInputs(root);
  }
  setLiveDirty(false);
  view.previews = {};
  await refreshWorkbench(root);
}

/** Wire every inline lever: typing/dragging recalculates live; the curve
 *  slider and its number box stay in sync; the method toggle swaps the
 *  handoff helper copy. */
function bindLeverInputs(root) {
  const host = $('#rsLevers');
  if (!host || !hasLeverInputs()) return;
  host.querySelectorAll('[data-rs-lever]').forEach((el) => {
    if (el.dataset.rsLiveBound) return;
    el.dataset.rsLiveBound = '1';
    el.addEventListener('input', () => {
      if (el.dataset.rsLever === 'curveStrength') {
        const peer = $('#rsl-curveStrengthNum');
        const lbl = $('#rsl-curveVal');
        if (peer && peer.value !== el.value) peer.value = el.value;
        if (lbl) lbl.textContent = el.value;
      }
      scheduleLivePreview(root, false);
    });
    el.addEventListener('change', () => scheduleLivePreview(root, false));
  });
  const curveNum = $('#rsl-curveStrengthNum');
  if (curveNum && !curveNum.dataset.rsLiveBound) {
    curveNum.dataset.rsLiveBound = '1';
    const syncNum = () => {
      const slider = $('#rsl-curveStrength');
      const lbl = $('#rsl-curveVal');
      if (slider) slider.value = curveNum.value;
      if (lbl) lbl.textContent = curveNum.value;
      scheduleLivePreview(root, false);
    };
    curveNum.addEventListener('input', syncNum);
    curveNum.addEventListener('change', syncNum);
  }
  host.querySelectorAll('[data-rs-method]').forEach((b) => {
    if (b.dataset.rsLiveBound) return;
    b.dataset.rsLiveBound = '1';
    b.addEventListener('click', () => {
      const hidden = document.querySelector('[data-rs-lever="method"]');
      if (hidden) hidden.value = b.dataset.rsMethod;
      host.querySelectorAll('[data-rs-method]').forEach((x) => {
        const on = x === b;
        x.classList.toggle('primary', on);
        x.classList.toggle('ghost', !on);
        x.setAttribute('aria-pressed', String(on));
      });
      const help = $('#rsl-methodHelp');
      if (help) help.textContent = RS_METHOD_HELP[b.dataset.rsMethod] || '';
      scheduleLivePreview(root, false);
    });
  });
}

/** Synchronised 1/3/6/12 filter — every duration toolbar (workbench +
 *  unit-rate table) and the duration cards follow one value (§15.12). */
function setDuration(d, body, root) {
  view.duration = d;
  body.querySelectorAll('[data-rs-dur]').forEach((x) => {
    const on = Number(x.dataset.rsDur) === d;
    x.classList.toggle('primary', on);
    x.classList.toggle('ghost', !on);
  });
  if (view.previews[d]) {
    view.preview = view.previews[d];
    renderWorkbenchViews(root || rsRoot);
  } else if (view.liveDirty && hasLeverInputs()) {
    scheduleLivePreview(root || rsRoot, true);
  } else {
    refreshWorkbench(root || rsRoot);
  }
}

function leverSummaryHtml(l) {
  if (!l) return '<div class="section-empty">No levers stored.</div>';
  const pct = (x) => (x == null ? '—' : (Number(x) * 100).toFixed(1).replace(/\.0$/, '') + '%');
  const row = (k, val) => '<div class="ud-stat"><div class="ud-stat-lbl">' + k + '</div><div class="ud-stat-val" style="font-size:14px;">' + val + '</div></div>';
  return '<div class="ud-stats">' +
    row('Reference size', escapeHtml(String(l.referenceSize)) + ' sq ft') +
    row('Starting rack', fmtMoney(l.startingRate) + '/mo') +
    row('Method', escapeHtml(l.method === 'STEP' ? 'Step-down table' : 'Smooth size curve')) +
    (l.method === 'STEP'
      ? row('Step', '−' + fmtMoney(l.stepPsf) + ' PSF every ' + escapeHtml(String(l.stepEvery)) + ' sq ft')
      : row('Curve strength', escapeHtml(String(l.curveStrength)))) +
    row('Rack PSF floor', fmtPsf(l.psfFloor) + '/sq ft') +
    row('Minimum rent', fmtMoney(l.minMonthly) + '/mo') +
    row('Locker', pct(l.lockerAdj)) + row('Ground floor', pct(l.groundFloorAdj)) +
    row('Restricted', pct(l.restrictedAdj)) + row('Facility-wide', pct(l.facilityAdj)) +
    row('Rounding', 'S$' + escapeHtml(String(l.rounding))) +
    row('Category floors', CATEGORIES.map((c) => c + ' ' + fmtPsf(l.categoryFloors && l.categoryFloors[c])).join(' · ')) +
    row('Size overrides', (l.sizeOverrides && l.sizeOverrides.length ? l.sizeOverrides.map((o) => o.size + ' sq ft → ' + fmtMoney(o.monthlyRate)).join('; ') : 'none')) +
    '</div>';
}

// B-4: editable workbench beside the live chart (v55 §15.8, handoff §15.9).
// Draft only. Every lever carries a ? tooltip with the handoff §15.8 Meaning
// copy; the method helper paragraphs are the handoff §15.9 product copy
// verbatim. Every keystroke/drag recalculates live (debounced unsaved
// preview) — no modal, no Preview click. Save draft persists via PATCH.
const RS_METHOD_HELP = {
  SMOOTH: 'PSF falls gradually as size increases, giving every square foot a continuous rate. Best for a clean, consistent pricing curve.',
  STEP: 'PSF drops by a fixed amount after each size interval. Best when you want to mirror a traditional rate table.',
};

function leverEditHtml(l) {
  const v = l || {};
  const pct = (x) => (x == null ? '' : Math.round(Number(x) * 1000) / 10);
  const cf = v.categoryFloors || {};
  const method = v.method === 'STEP' ? 'STEP' : 'SMOOTH';
  const curve = v.curveStrength ?? 0.2;
  const num = (id, label, val, attrs, tip) =>
    '<div class="field"><label for="rsl-' + id + '">' + escapeHtml(label) + ' <span class="rs-tip" title="' + escapeHtml(tip || '') + '" tabindex="0" aria-label="' + escapeHtml(tip || '') + '">?</span></label>' +
    '<input id="rsl-' + id + '" data-rs-lever="' + id + '" value="' + escapeHtml(String(val ?? '')) + '"' + (attrs || '') + '></div>';
  return '<div class="form-grid">' +
    num('referenceSize', 'Reference size (sq ft)', v.referenceSize, ' type="number" min="1" step="1"', 'Anchor size used for starting rate.') +
    num('startingRate', 'Starting monthly rack (S$)', v.startingRate, ' type="number" min="1" step="0.01"', 'Pre-promotion monthly rate at reference size.') +
    '</div>' +
    '<div class="field"><label>Pricing method <span class="rs-tip" title="Smooth size curve or step-down table." tabindex="0" aria-label="Smooth size curve or step-down table.">?</span></label>' +
    '<div class="rs-seg" role="group" aria-label="Pricing method">' +
    '<button type="button" class="tb-btn' + (method === 'SMOOTH' ? ' primary' : ' ghost') + '" data-rs-method="SMOOTH" aria-pressed="' + (method === 'SMOOTH') + '">Smooth size curve</button>' +
    '<button type="button" class="tb-btn' + (method === 'STEP' ? ' primary' : ' ghost') + '" data-rs-method="STEP" aria-pressed="' + (method === 'STEP') + '">Step-down table</button>' +
    '</div>' +
    '<input type="hidden" data-rs-lever="method" value="' + method + '">' +
    '<div class="t-type" id="rsl-methodHelp" style="margin-top:4px;">' + escapeHtml(RS_METHOD_HELP[method]) + '</div>' +
    '<div class="t-type" style="margin-top:2px;">Recommended: smooth curve</div></div>' +
    '<div class="field"><label for="rsl-curveStrength">Curve strength 0–0.60 (smooth) <span class="rs-tip" title="How quickly PSF falls as size increases. Smooth only." tabindex="0" aria-label="How quickly PSF falls as size increases. Smooth only.">?</span></label>' +
    '<div style="display:flex;gap:8px;align-items:center;">' +
    '<input id="rsl-curveStrength" data-rs-lever="curveStrength" type="range" min="0" max="0.6" step="0.01" value="' + escapeHtml(String(curve)) + '" style="flex:1;" aria-label="Curve strength slider">' +
    '<input id="rsl-curveStrengthNum" type="number" min="0" max="0.6" step="0.01" value="' + escapeHtml(String(curve)) + '" style="width:76px;" class="set-input" aria-label="Curve strength value"></div>' +
    '<div class="t-type">Value: <b id="rsl-curveVal">' + escapeHtml(String(curve)) + '</b></div></div>' +
    '<div class="form-grid">' +
    num('stepEvery', 'Reduce PSF every N sq ft (step)', v.stepEvery, ' type="number" min="1" step="1"', 'Step interval. Step-down only.') +
    num('stepPsf', 'PSF reduction per step (S$)', v.stepPsf, ' type="number" min="0" step="0.01"', 'Fixed PSF decrease each interval. Step-down only.') +
    num('psfFloor', 'Rack PSF floor (S$)', v.psfFloor, ' type="number" min="0" step="0.01"', 'Overall pre-promotion floor.') +
    num('minMonthly', 'Minimum monthly (S$)', v.minMonthly, ' type="number" min="0" step="0.01"', 'Final monthly minimum before rounding.') +
    num('lockerAdj', 'Locker %', pct(v.lockerAdj), ' type="number" min="-95" max="100" step="0.5"', 'Signed half-height locker factor.') +
    num('groundFloorAdj', 'Ground-floor %', pct(v.groundFloorAdj), ' type="number" min="-95" max="100" step="0.5"', 'Signed factor for tagged ground-floor/premium-access units.') +
    num('restrictedAdj', 'Restricted %', pct(v.restrictedAdj), ' type="number" min="-95" max="100" step="0.5"', 'Signed factor for tagged access limitations.') +
    num('facilityAdj', 'Facility-wide %', pct(v.facilityAdj), ' type="number" min="-50" max="100" step="0.5"', 'Facility positioning uplift/discount.') +
    '</div>' +
    '<div class="field"><label for="rsl-rounding">Round monthly rate to nearest <span class="rs-tip" title="Rounding increment for the final monthly rate: S$1, S$5 or S$10." tabindex="0" aria-label="Rounding increment for the final monthly rate: S$1, S$5 or S$10.">?</span></label>' +
    '<select id="rsl-rounding" data-rs-lever="rounding">' +
    [1, 5, 10].map((r) => '<option value="' + r + '"' + (Number(v.rounding) === r ? ' selected' : '') + '>S$' + r + '</option>').join('') + '</select></div>' +
    '<div class="t-type" style="margin:6px 0;">Category floors (minimum rack PSF): ' + CATEGORIES.map((c) => c + ' ' + escapeHtml(String(cf[c] ?? ''))).join(' · ') + ' — edit via All levers.</div>' +
    '<div class="tbl-toolbar"><button class="tb-btn primary" id="rsInlineSave" data-perm="facility-rate-strategy:update">Save draft</button>' +
    '<button class="tb-btn ghost" id="rsAllLevers" data-perm="facility-rate-strategy:update">All levers…</button>' +
    '<span class="t-type">Typing or dragging recalculates live — saving persists the draft.</span></div>';
}

function renderRsContext() {
  const host = $('#rsContext');
  if (!host || !view.version) return;
  const v = view.version;
  const inv = view.preview && view.preview.inventory;
  const tgt = view.preview && view.preview.target;
  host.innerHTML = '<div class="ud-stats">' +
    '<div class="ud-stat"><div class="ud-stat-lbl">Facility</div><div class="ud-stat-val" style="font-size:14px;">' + branchLabel(v) + '</div></div>' +
    '<div class="ud-stat"><div class="ud-stat-lbl">Strategy name</div><div class="ud-stat-val" style="font-size:14px;">' + escapeHtml(v.strategyName) + ' v' + v.versionNo + '</div></div>' +
    '<div class="ud-stat"><div class="ud-stat-lbl">Effective from</div><div class="ud-stat-val" style="font-size:14px;">' + escapeHtml(v.effectiveFrom || '—') + '</div></div>' +
    '<div class="ud-stat"><div class="ud-stat-lbl">Inventory source</div><div class="ud-stat-val" style="font-size:14px;">' + (inv ? Number(inv.unitCount || 0) + ' units · ' + Number(inv.stockedSizeCount || 0) + ' sizes' : 'Facilities · Units') + '</div></div>' +
    '<div class="ud-stat"><div class="ud-stat-lbl">Target source</div><div class="ud-stat-val" style="font-size:14px;">' + (tgt && tgt.targetPsf != null ? 'Approved Financial Model · S$' + Number(tgt.targetPsf).toFixed(2) : 'Unavailable — no CURRENT model') + '</div></div>' +
    '</div>';
}

/** B-3 KPI cards (v55 §15.6–15.7): the Base rack-rate card is
 *  duration-independent (rack schedule never moves with promotion or
 *  duration); the Promotion preview card follows its OWN 1/3/6/12 toggle
 *  (view.kpiDuration), independent of the workbench duration below. Both
 *  repaint on every lever change via renderWorkbenchViews. No-target (B-6)
 *  renders Effective vs target as unavailable — never S$0, never a crash. */
function kpiPromoDuration() {
  return DURATIONS.includes(view.kpiDuration) ? view.kpiDuration : 12;
}

function renderRsKpis() {
  const host = $('#rsKpis');
  if (!host) return;
  const kd = kpiPromoDuration();
  // Base card: fixed 12-month reference so the promo toggle never moves it
  // (rack figures are identical across durations; 12 mo is the anchor).
  const basePayload = (view.previews && view.previews[12]) || view.preview;
  const promoPayload = (view.previews && view.previews[kd]) || view.preview;
  const base = basePayload && basePayload.preview && basePayload.preview.summary;
  const promo = promoPayload && promoPayload.preview && promoPayload.preview.summary;
  if (!base || !promo) {
    host.innerHTML = '<div class="section-empty">Run preview to fill KPIs.</div>';
    return;
  }
  const gap = promo.gapVsTarget;
  const vsTarget = (view.noTarget || gap == null)
    ? '<span class="t-type">target unavailable</span>'
    : ((Number(gap) >= 0 ? '+' : '') + fmtPsf(gap));
  host.innerHTML = '<div class="rs-kpi-grid">' +
    '<div class="tbl-card"><div class="sec-sub"><b>Base rack-rate</b> <span class="t-type">· never changes with promotion/duration</span></div>' +
    '<div class="ud-stats">' +
    '<div class="ud-stat"><div class="ud-stat-lbl">Facility sizes</div><div class="ud-stat-val" style="font-size:16px;">' + Number(base.stockedSizeCount || 0) + '</div></div>' +
    '<div class="ud-stat"><div class="ud-stat-lbl">Rack rent potential</div><div class="ud-stat-val" style="font-size:16px;">' + fmtMoney(base.rackPotential) + '/mo</div></div>' +
    '<div class="ud-stat"><div class="ud-stat-lbl">Weighted rack PSF</div><div class="ud-stat-val" style="font-size:16px;">' + fmtPsf(base.weightedRackPsf) + '</div></div>' +
    '</div></div>' +
    '<div class="tbl-card"><div class="sec-sub"><b>Promotion preview</b> <span class="t-type">· ' + kd + ' mo · ' + escapeHtml(view.matrix) + '</span></div>' +
    '<div class="ud-stats">' +
    '<div class="ud-stat"><div class="ud-stat-lbl">Effective PSF</div><div class="ud-stat-val" style="font-size:16px;">' + fmtPsf(promo.weightedEffectivePsf) + '</div></div>' +
    '<div class="ud-stat"><div class="ud-stat-lbl">Blended PSF</div><div class="ud-stat-val" style="font-size:16px;">' + (promo.weightedBlendedPsf != null ? fmtPsf(promo.weightedBlendedPsf) : '<span class="t-type">n/a — no free months</span>') + '</div></div>' +
    '<div class="ud-stat"><div class="ud-stat-lbl">Effective PSF vs target</div><div class="ud-stat-val" style="font-size:16px;">' + vsTarget + '</div></div>' +
    '</div></div></div>';
}

/** Promotion-preview toggle only: switches Effective/Blended/vs-target
 *  without touching the workbench duration, chart, categories or unit
 *  table. Uses the cached all-duration previews — no extra fetch. */
function setKpiDuration(d) {
  if (!DURATIONS.includes(d)) return;
  view.kpiDuration = d;
  document.querySelectorAll('[data-rs-kpi-dur]').forEach((x) => {
    const on = Number(x.dataset.rsKpiDur) === d;
    x.classList.toggle('primary', on);
    x.classList.toggle('ghost', !on);
    x.setAttribute('aria-pressed', String(on));
  });
  if (view.previews[d] || view.preview) renderRsKpis();
}

function renderRsTargetBanner() {
  const host = $('#rsTargetBanner');
  if (!host) return;
  const twelve = view.previews && view.previews[12];
  const sum = twelve && twelve.preview && twelve.preview.summary;
  const tgt = twelve && twelve.target;
  if (!sum || !tgt || tgt.targetPsf == null || sum.weightedEffectivePsf == null) {
    host.innerHTML = '';
    return;
  }
  const gap = Number(sum.gapVsTarget || 0);
  if (gap >= 0) {
    host.innerHTML = '<div class="modal-alert olive">12-month Effective PSF ' + fmtPsf(sum.weightedEffectivePsf) + ' meets the approved target ' + fmtPsf(tgt.targetPsf) + '.</div>';
    return;
  }
  const v = view.version || {};
  const refSize = Number(v.levers && v.levers.referenceSize) || 10;
  const startRate = Number(v.levers && v.levers.startingRate) || 0;
  const anchor = startRate + Math.abs(gap) * refSize;
  host.innerHTML = '<div class="modal-alert">12-month Effective PSF ' + fmtPsf(sum.weightedEffectivePsf) + ' is below the approved target ' + fmtPsf(tgt.targetPsf) + ' — raise anchor to about ' + fmtMoney(anchor) + '.</div>';
}

async function fetchPreview(durationMonths) {
  const q = new URLSearchParams({ durationMonths: String(durationMonths), matrix: view.matrix });
  if (Array.isArray(view.planIds) && view.planIds.length) {
    q.set('planIds', view.planIds.join(','));
  }
  return get('/rate-strategy/' + encodeURIComponent(view.versionId) + '/preview?' + q.toString());
}

function selectedPlanRefs() {
  if (Array.isArray(view.planIds)) return view.planIds;
  const fromCache = view.preview && view.preview.previewSelection && view.preview.previewSelection.planRefs;
  if (Array.isArray(fromCache) && fromCache.length) return fromCache.map((r) => r.planId);
  const stored = (view.version && view.version.previewSelection && view.version.previewSelection.planRefs) || [];
  return stored.map((r) => r.planId);
}

/** Preview every 1/3/6/12 duration so chart, categories, duration cards
 *  and the unit table stay synchronised on one filter (§15.12, scenario E). */
async function refreshWorkbench(root) {
  for (const id of ['#rsChart', '#rsCats', '#rsDurCards', '#rsPreview']) {
    const host = $(id);
    if (host) host.innerHTML = '<div class="section-empty">Calculating preview…</div>';
  }
  try {
    const all = await Promise.all(DURATIONS.map((d) => fetchPreview(d)));
    view.previews = {};
    DURATIONS.forEach((d, i) => { view.previews[d] = all[i]; });
    view.preview = view.previews[view.duration];
    view.previewError = null;
    // B-6: no CURRENT model no longer 409s the whole preview — the API
    // returns the rack schedule with target/promo marked unavailable.
    view.noTarget = !!(view.preview && (view.preview.noTarget || view.preview.targetUnavailable || !view.preview.target));
    setLiveDirty(false);
    renderWorkbenchViews(root);
    paintPromoSelection();
    paintNoTargetBanner(null);
  } catch (e) {
    const code = e && e.code;
    const msg = code === 'NO_CURRENT_MODEL'
      ? 'Financial Model target unavailable: no CURRENT (approved) model is linked for this facility — target and promotion outcomes are unavailable below, rack-rate editing stays available. Ask Finance to approve a model; Rate Strategy never falls back to a sample target.'
      : 'Preview failed: ' + escapeHtml(describeError(e));
    for (const id of ['#rsChart', '#rsCats', '#rsDurCards', '#rsPreview']) {
      const host = $(id);
      if (host) host.innerHTML = '<div class="section-empty">' + msg + '</div>';
    }
  }
}

function renderWorkbenchViews(root) {
  renderRsChart();
  renderRsCats();
  renderRsDurCards(root || rsRoot);
  renderPreviewTables(root || rsRoot);
  renderRsKpis();
  renderRsContext();
  renderRsTargetBanner();
}

// ---- live chart (same inline-SVG approach as the finance screens:
// fm-chart/fm-legend/fm-chart-tooltip classes, no new dependency) ----
const RS_SERIES = [
  { key: 'rack', label: 'Rack PSF', color: '#526557', get: (r) => r.rackPsf },
  { key: 'eff', label: 'Effective PSF', color: '#2a9d8f', get: (r) => r.effectivePsf },
  { key: 'blend', label: 'Blended PSF', color: '#c97952', get: (r) => (r.hasBlended ? r.blendedPsf : null) },
];

function rsChartSvg(plotted, targetPsf, hasBlended, large) {
  const width = large ? 920 : 480, height = large ? 340 : 220, p = { l: large ? 64 : 56, r: 14, t: large ? 20 : 16, b: 30 };
  const vals = [];
  plotted.forEach((r) => { vals.push(r.rackPsf, r.effectivePsf); if (hasBlended && r.hasBlended) vals.push(r.blendedPsf); });
  if (targetPsf != null) vals.push(targetPsf);
  const finite = vals.filter(Number.isFinite);
  let rawMax = Math.max.apply(null, finite.concat([1])) * 1.06;
  let rawMin = Math.min.apply(null, finite.concat([0]));
  if (!(rawMax > rawMin)) { rawMax = rawMin + 1; }
  // B-5: Y ticks every S$0.50 across the chart range — snap the domain to
  // the half-dollar grid so the lines sit on round values (v55 §15.19).
  const tickMin = Math.floor(rawMin * 2) / 2;
  let tickMax = Math.ceil(rawMax * 2) / 2;
  if (!(tickMax > tickMin)) { tickMax = tickMin + 0.5; }
  const max = tickMax, min = tickMin;
  const xs = plotted.map((r) => r.size);
  const xMin = 8;
  const xMax = Math.max.apply(null, xs.concat([150]));
  const x = (s) => p.l + ((s - xMin) / Math.max(xMax - xMin, 1)) * (width - p.l - p.r);
  const y = (v) => p.t + (max - v) * (height - p.t - p.b) / (max - min || 1);
  const line = (fn) => {
    let started = false;
    return plotted.map((r) => {
      const v = fn(r);
      if (!Number.isFinite(v)) { started = false; return ''; }
      const cmd = started ? 'L' : 'M';
      started = true;
      return cmd + x(r.size).toFixed(1) + ',' + y(v).toFixed(1);
    }).join(' ');
  };
  const grids = [];
  const tickCount = Math.round((max - min) * 2);
  for (let i = 0; i <= tickCount; i++) {
    const val = Math.round((min + i * 0.5) * 100) / 100;
    const yy = p.t + (max - val) * (height - p.t - p.b) / (max - min || 1);
    grids.push('<line class="gridline" x1="' + p.l + '" y1="' + yy.toFixed(1) + '" x2="' + (width - p.r) + '" y2="' + yy.toFixed(1) + '"/>' +
      '<text class="axis-label" x="3" y="' + (yy + 3).toFixed(1) + '">S$' + val.toFixed(2) + '</text>');
  }
  const gridsHtml = grids.join('');
  const every = Math.max(1, Math.ceil(plotted.length / 6));
  const labels = plotted.map((r, i) => (i % every === 0 || i === plotted.length - 1)
    ? '<text class="axis-label" x="' + x(r.size) + '" y="' + (height - 8) + '" text-anchor="middle">' + r.size + '</text>' : '').join('');
  const dots = plotted.filter((r) => r.stocked).map((r) => {
    const tip = r.size + ' sq ft · Rack ' + fmtMoney(r.rackMonthly) + ' · Eff ' + fmtMoney(r.effectiveMonthly) +
      (r.hasBlended ? ' · Blend ' + fmtMoney(r.blendedMonthly) : '');
    return '<circle cx="' + x(r.size).toFixed(1) + '" cy="' + y(r.effectivePsf).toFixed(1) + '" r="3" fill="#2a9d8f"><title>' +
      escapeHtml(tip) + '</title></circle>';
  }).join('');
  const payload = encodeURIComponent(JSON.stringify({
    labels: plotted.map((r) => r.size + ' sq ft'),
    series: RS_SERIES.filter((s) => s.key !== 'blend' || hasBlended).map((s) => ({
      label: s.label, values: plotted.map((r) => { const v = s.get(r); return Number.isFinite(v) ? 'S$' + Number(v).toFixed(2) : '—'; }),
    })),
  }));
  const targetLine = targetPsf != null
    ? '<line x1="' + p.l + '" y1="' + y(targetPsf).toFixed(1) + '" x2="' + (width - p.r) + '" y2="' + y(targetPsf).toFixed(1) + '" stroke="#8a6d3b" stroke-width="1.5" stroke-dasharray="6 4"/>' +
      '<text class="axis-label" x="' + (width - p.r) + '" y="' + targetLabelY(targetPsf) + '" text-anchor="end" fill="#8a6d3b">Target S$' + Number(targetPsf).toFixed(2) + '</text>' : '';
  function targetLabelY(v) {
    const yy = y(v);
    // Keep the label inside the plot: above the line, or below it when the
    // line rides near the top edge.
    return (yy - 6 < p.t + 8 ? yy + 13 : yy - 5).toFixed(1);
  }
  return '<div class="fm-chart-wrap" data-chart-wrap style="position:relative;">' +
    '<svg class="fm-chart fm-mini-chart fm-interactive-chart" data-chart-payload="' + payload + '" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" style="width:100%;height:' + height + 'px;display:block;" role="img" aria-label="PSF by size chart">' +
    gridsHtml + labels +
    '<path fill="none" stroke="#526557" stroke-width="2.5" d="' + line((r) => r.rackPsf) + '"/>' +
    '<path fill="none" stroke="#2a9d8f" stroke-width="2.5" d="' + line((r) => r.effectivePsf) + '"/>' +
    (hasBlended ? '<path fill="none" stroke="#c97952" stroke-width="2.5" d="' + line((r) => (r.hasBlended ? r.blendedPsf : null)) + '"/>' : '') +
    targetLine +
    '<line class="fm-crosshair" x1="' + p.l + '" y1="' + p.t + '" x2="' + p.l + '" y2="' + (height - p.b) + '"/>' +
    dots + '</svg><div class="fm-chart-tooltip"></div>' +
    '<div class="fm-legend"><span><i style="background:#526557"></i>Rack PSF</span>' +
    '<span><i style="background:#2a9d8f"></i>Effective PSF</span>' +
    '<span' + (hasBlended ? '' : ' class="t-type" title="No free-months plan in preview"') + '><i style="background:' + (hasBlended ? '#c97952' : 'transparent;border:1px dashed #c97952') + '"></i>Blended PSF' + (hasBlended ? '' : ' (n/a)') + '</span>' +
    (targetPsf != null ? '<span><i style="background:#8a6d3b"></i>Model target S$' + Number(targetPsf).toFixed(2) + '</span>' : '') + '</div></div>';
}

function rsBindChartHover() {
  // Inline + expanded (overlay) chart share the hover binder; the guard
  // keeps finance-screen charts untouched (they bind their own handler).
  document.querySelectorAll('#rsChart .fm-interactive-chart, #rsOverlay .fm-interactive-chart').forEach((svg) => {
    if (svg.dataset.bound) return;
    svg.dataset.bound = '1';
    const wrap = svg.closest('[data-chart-wrap]');
    const tipBox = wrap && wrap.querySelector('.fm-chart-tooltip');
    const cross = svg.querySelector('.fm-crosshair');
    let payload = null;
    try { payload = JSON.parse(decodeURIComponent(svg.dataset.chartPayload)); } catch (e) { return; }
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const index = Math.round(ratio * (payload.labels.length - 1));
      if (!tipBox || !payload.labels[index]) return;
      tipBox.innerHTML = '<b>' + escapeHtml(payload.labels[index]) + '</b>' +
        payload.series.map((s) => '<span>' + escapeHtml(s.label) + '<strong>' + escapeHtml(s.values[index]) + '</strong></span>').join('');
      tipBox.style.display = 'grid';
      tipBox.style.left = Math.min(rect.width - 150, Math.max(8, e.clientX - rect.left + 10)) + 'px';
      tipBox.style.top = '8px';
      if (cross) {
        const vb = svg.viewBox.baseVal;
        const xx = vb.x + ratio * vb.width;
        cross.setAttribute('x1', xx);
        cross.setAttribute('x2', xx);
        cross.style.opacity = '1';
      }
    });
    svg.addEventListener('mouseleave', () => {
      if (tipBox) tipBox.style.display = 'none';
      if (cross) cross.style.opacity = '0';
    });
  });
}

function renderRsChart() {
  const host = $('#rsChart');
  if (!host || !view.preview) return;
  const data = view.preview;
  const all = (data.preview.rows || []).slice().sort((a, b) => a.size - b.size);
  const plotted = view.range === 'all' ? all : all.filter((r) => r.stocked);
  if (!plotted.length) {
    host.innerHTML = '<div class="section-empty">No sizes to chart for this range.</div>';
    return;
  }
  const anyBlended = plotted.some((r) => r.hasBlended);
  const targetPsf = data.target && data.target.targetPsf;
  host.innerHTML = '<div class="rs-chart-head"><span class="t-type">' + view.duration + ' mo · ' + escapeHtml(view.matrix) +
    ' · ' + plotted.length + ' sizes · X 8–150 sq ft (full commercial axis kept) · Y PSF</span>' +
    '<span style="flex:1"></span>' +
    '<button class="tb-btn ghost" id="rsChartExpand" data-perm="facility-rate-strategy:view">Expand</button></div>' +
    rsChartSvg(plotted, targetPsf, anyBlended, false);
  const expand = $('#rsChartExpand');
  if (expand) expand.addEventListener('click', () => openRsChartExpand());
  rsBindChartHover();
}

/** B-5 Expand: the same inline-SVG chart at finance-screen large size in
 *  the workspace overlay (B-1 scroll guard), closed by Close/X/backdrop —
 *  the inline chart underneath is untouched so state restores as-is. */
function openRsChartExpand() {
  if (!view.preview) return;
  const data = view.preview;
  const all = (data.preview.rows || []).slice().sort((a, b) => a.size - b.size);
  const plotted = view.range === 'all' ? all : all.filter((r) => r.stocked);
  if (!plotted.length) return;
  const anyBlended = plotted.some((r) => r.hasBlended);
  const targetPsf = data.target && data.target.targetPsf;
  overlay(rsRoot || document.body, view.duration + '-month PSF by size — expanded',
    '<p class="t-type">' + view.duration + ' mo · ' + escapeHtml(view.matrix) + ' · ' + plotted.length +
    ' sizes · hover anywhere for values · Y ticks every S$0.50</p>' +
    rsChartSvg(plotted, targetPsf, anyBlended, true),
    'Close',
    async () => {});
  rsBindChartHover();
}

// ---- category table + totals (§15.12) ----
const RS_CAT_ORDER = ['LOCKER', 'XS', 'S', 'M', 'L', 'XL'];
const RS_CAT_RANGE = { LOCKER: '8–15', XS: '10–19', S: '20–39', M: '40–69', L: '70–99', XL: '100–150' };

function psfRange(rows, get) {
  const vs = rows.map(get).filter(Number.isFinite);
  if (!vs.length) return '—';
  const lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
  return lo === hi ? 'S$' + lo.toFixed(2) : 'S$' + lo.toFixed(2) + '–S$' + hi.toFixed(2);
}

function renderRsCats() {
  const host = $('#rsCats');
  if (!host || !view.preview) return;
  const rows = (view.preview.preview.rows || []).filter((r) => r.stocked);
  const anyBlended = rows.some((r) => r.hasBlended);
  if (!rows.length) {
    host.innerHTML = '<div class="section-empty">No facility sizes are stocked yet.</div>';
    return;
  }
  const byCat = {};
  rows.forEach((r) => { (byCat[r.category] = byCat[r.category] || []).push(r); });
  const body = RS_CAT_ORDER.map((c) => {
    const list = (byCat[c] || []).slice().sort((a, b) => a.size - b.size);
    if (!list.length) {
      return '<tr><td>' + c + '</td><td class="t-type">' + RS_CAT_RANGE[c] + ' sq ft</td><td colspan="' +
        (anyBlended ? 7 : 6) + '" class="t-type">Not stocked — Rate only in the unit table; excluded from totals.</td></tr>';
    }
    const nla = list.reduce((s, r) => s + r.size * r.unitCount, 0);
    const units = list.reduce((s, r) => s + r.unitCount, 0);
    const rack = list.reduce((s, r) => s + r.rackMonthly * r.unitCount, 0);
    const net = list.reduce((s, r) => s + r.effectiveMonthly * r.unitCount, 0);
    return '<tr><td><b>' + c + '</b></td><td class="t-type">' + RS_CAT_RANGE[c] + ' sq ft</td>' +
      '<td>' + nla.toLocaleString('en-SG') + '</td><td>' + units + '</td>' +
      '<td>' + psfRange(list, (r) => r.rackPsf) + '</td><td>' + psfRange(list, (r) => r.effectivePsf) + '</td>' +
      (anyBlended ? '<td>' + (list.some((r) => r.hasBlended) ? psfRange(list.filter((r) => r.hasBlended), (r) => r.blendedPsf) : '<span class="t-type">n/a</span>') + '</td>' : '') +
      '<td>' + fmtMoney(rack) + '</td><td>' + fmtMoney(net) + '</td></tr>';
  }).join('');
  const s = view.preview.preview.summary || {};
  host.innerHTML =
    '<div class="t-type" style="margin-bottom:6px;">' + view.duration + ' mo · ' + escapeHtml(view.matrix) + ' · Effective PSF ranges drive the target comparison — never Blended.</div>' +
    '<div style="overflow-x:auto;"><table class="data-tbl"><thead><tr><th>Category</th><th>Size range</th><th>Facility NLA</th><th>Units</th>' +
    '<th>Rack PSF range</th><th>Net PSF range</th>' + (anyBlended ? '<th>Blended PSF range</th>' : '') +
    '<th>Monthly Rack Potential</th><th>Monthly Net Rent Potential</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
    '<div class="t-type" style="margin-top:6px;">Totals — NLA ' + Number(s.totalNla || 0).toLocaleString('en-SG') + ' sq ft · ' + (s.totalUnits || 0) + ' units · ' +
    'weighted rack ' + fmtPsf(s.weightedRackPsf) + ' · weighted net/effective ' + fmtPsf(s.weightedEffectivePsf) +
    (s.weightedBlendedPsf != null ? ' · weighted blended ' + fmtPsf(s.weightedBlendedPsf) : '') +
    ' · rack potential ' + fmtMoney(s.rackPotential) + '/mo · net potential ' + fmtMoney(s.netPotential) + '/mo</div>';
}

// ---- duration cards (§15.9: one card per 1/3/6/12 month commitment) ----
function renderRsDurCards(root) {
  const host = $('#rsDurCards');
  if (!host) return;
  const cards = DURATIONS.map((d) => {
    const p = view.previews[d];
    const sum = p && p.preview.summary;
    const active = d === view.duration;
    const inner = !sum
      ? '<div class="t-type">Not loaded</div>'
      : '<div class="ud-stat-val" style="font-size:14px;">' + fmtPsf(sum.weightedEffectivePsf) + ' <span class="t-type">eff PSF</span></div>' +
        '<div class="t-type">gap ' + (sum.gapVsTarget == null ? '—' : (Number(sum.gapVsTarget) >= 0 ? '+' : '') + fmtPsf(sum.gapVsTarget)) +
        ' · net ' + fmtMoney(sum.netPotential) + '/mo' +
        (sum.weightedBlendedPsf != null ? ' · blend ' + fmtPsf(sum.weightedBlendedPsf) : '') + '</div>';
    return '<button class="tbl-card" data-rs-durcard="' + d + '" style="flex:1 1 140px;min-width:140px;text-align:left;cursor:pointer;' +
      (active ? 'border:2px solid var(--olive2,#526557);' : '') + '" data-perm="facility-rate-strategy:view">' +
      '<div class="t-type"><b>' + d + ' month' + (d === 1 ? '' : 's') + '</b>' + (active ? ' · selected' : '') + '</div>' + inner + '</button>';
  }).join('');
  host.innerHTML = '<div class="t-type" style="margin-bottom:4px;">PSF by customer storage duration — select a card to synchronise chart, categories and unit table.</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:12px;">' + cards + '</div>';
  host.querySelectorAll('[data-rs-durcard]').forEach((b) => b.addEventListener('click', () => {
    setDuration(Number(b.dataset.rsDurcard), $('#rsBody'), root);
  }));
}

// ---- promotion library preview panel (§15.13, read-only) ----
async function loadPromos(root) {
  const host = $('#rsPromos');
  if (!host) return;
  if (view.plans) { renderRsPromos(root); return; }
  try {
    const rows = await get('/promotion-plans');
    view.plans = rows || [];
  } catch (e) {
    host.innerHTML = '<div class="section-empty">Promotion library needs promotion read access (' + escapeHtml(describeError(e)) + ').</div>';
    return;
  }
  renderRsPromos(root);
}

function planKindLabel(p) {
  if (p.kind === 'DISCOUNT_MATRIX') return 'Percentage matrix';
  if (p.kind === 'FREE_MONTHS') return 'Free months' + (p.freeMonthCount ? ' (' + p.freeMonthCount + ' mo' + (p.commitmentMonths ? ' / ' + p.commitmentMonths + ' mo commit' : '') + ')' : '');
  return String(p.kind || '—');
}

function renderRsPromos(root) {
  const host = $('#rsPromos');
  if (!host || !view.plans) return;
  const sel = selectedPlanRefs();
  if (!view.plans.length) {
    host.innerHTML = '<div class="section-empty">No promotion plans exist yet.</div>';
    return;
  }
  const recurring = (view.plans || []).filter((p) => p.kind === 'DISCOUNT_MATRIX' || p.kind === 'FREE_MONTHS');
  const others = (view.plans || []).filter((p) => p.kind !== 'DISCOUNT_MATRIX' && p.kind !== 'FREE_MONTHS');
  const row = (p) => {
    const previewable = (p.status === 'ACTIVE' || p.status === 'DRAFT') && (p.kind === 'DISCOUNT_MATRIX' || p.kind === 'FREE_MONTHS');
    const checked = previewable && sel.includes(p.id);
    return '<tr><td>' + (previewable
      ? '<input type="checkbox" data-rs-promo="' + escapeHtml(p.id) + '"' + (checked ? ' checked' : '') + ' aria-label="Include ' + escapeHtml(p.name || p.id) + ' in preview">'
      : '<span class="t-type" title="Conditional offer — visible only, excluded from unit-rate analysis">—</span>') + '</td>' +
      '<td><b>' + escapeHtml(p.name || p.id) + '</b>' + (p.status === 'DRAFT' ? ' <i class="t-type">preview only</i>' : '') + '</td>' +
      '<td>' + escapeHtml(planKindLabel(p)) + '</td>' +
      '<td><span class="pill ' + (p.status === 'ACTIVE' ? 'green' : p.status === 'DRAFT' ? 'amber' : '') + '">' + escapeHtml(p.status || '—') + '</span></td>' +
      '<td class="t-type">' + escapeHtml(Array.isArray(p.facilityScope) ? p.facilityScope.join(', ') : String(p.facilityScope || '—')) + '</td></tr>';
  };
  host.innerHTML = '<div class="t-type" style="margin-bottom:6px;">Selecting a plan never activates it. Draft plans resolve preview-only; conditional offers stay visible-only.</div>' +
    '<div style="overflow-x:auto;"><table class="data-tbl"><thead><tr><th title="Include in preview">In preview</th><th>Plan</th><th>Kind</th><th>Status</th><th>Facility scope</th></tr></thead><tbody>' +
    recurring.map(row).join('') +
    (others.length ? '<tr><td colspan="5" class="t-type">Conditional offers — visible only, excluded from recurring unit-rate analysis:</td></tr>' + others.map(row).join('') : '') +
    '</tbody></table></div>';
  host.querySelectorAll('[data-rs-promo]').forEach((c) => c.addEventListener('change', () => {
    const ids = Array.from(host.querySelectorAll('[data-rs-promo]:checked')).map((el) => el.dataset.rsPromo);
    // Unchecking everything reverts to the stored selection: the preview
    // route treats an absent planIds param as “stored/default”, so an
    // explicit empty list would silently preview the defaults instead.
    view.planIds = ids.length ? ids : null;
    view.previews = {};
    refreshWorkbench(root);
  }));
}

function paintPromoSelection() {
  const host = $('#rsPromos');
  if (!host || !view.plans) return;
  const sel = selectedPlanRefs();
  host.querySelectorAll('[data-rs-promo]').forEach((c) => { c.checked = sel.includes(c.dataset.rsPromo); });
}

// ---- unit-rate breakdown (§15.20): duration filter, range view, overrides ----
function promoCell(r) {
  const parts = [];
  if (r.combinedDiscount > 0) parts.push((Number(r.combinedDiscount) * 100).toFixed(1) + '%');
  if (r.freeMonths) parts.push(r.freeMonths + ' mo free');
  return parts.length ? escapeHtml(parts.join(' + ')) : '<span class="t-type">—</span>';
}

function renderPreviewTables(root) {
  const host = $('#rsPreview');
  if (!host || !view.preview) return;
  const data = view.preview;
  const all = (data.preview.rows || []).slice().sort((a, b) => a.size - b.size);
  const inRange = view.range === 'all'
    ? all.filter((r) => r.size >= view.rangeFrom && r.size <= view.rangeTo)
    : all.filter((r) => r.stocked);
  const anyBlended = all.some((r) => r.hasBlended);
  const s = data.preview.summary || {};
  const canOverride = view.version && view.version.status === 'DRAFT' && can('facility-rate-strategy:update');
  if (!inRange.length) {
    host.innerHTML = '<div class="section-empty">No sizes in this range. Widen From/To or pick “Facility sizes only”.</div>';
    return;
  }
  const cap = inRange.slice(0, 200);
  host.innerHTML =
    '<div class="t-type" style="margin-bottom:6px;">Showing ' + cap.length + ' of ' + inRange.length +
    (view.range === 'all' ? ' sizes (' + view.rangeFrom + '–' + view.rangeTo + ' sq ft; unstocked rows are Rate only and never affect totals)' : ' stocked sizes') +
    ' · ' + escapeHtml(String(s.totalUnits ?? '—')) + ' units · ' + escapeHtml(String(s.totalNla ?? '—')) + ' sq ft NLA' +
    (data.target && data.target.targetPsf != null ? ' · target ' + fmtPsf(data.target.targetPsf) + '/sq ft (' + escapeHtml(data.target.modelName || data.target.modelId || 'model') + ')' : '') + '</div>' +
    '<div style="overflow-x:auto;"><table class="data-tbl"><thead><tr><th>Facility availability</th><th>Unit size</th><th>Category</th><th>Promotion(s) applied</th>' +
    '<th>Rack rent</th><th>Rack PSF</th><th>Approved discount</th><th>Effective monthly rent</th><th>Effective PSF</th>' +
    (anyBlended ? '<th>Approved free months</th><th>Blended monthly rent</th><th>Blended PSF</th>' : '') +
    '<th>Model target PSF</th><th>Effective PSF vs target</th><th>Override</th></tr></thead><tbody>' +
    cap.map((r) =>
      '<tr><td>' + (r.stocked ? r.unitCount + ' unit' + (r.unitCount === 1 ? '' : 's') : '<span class="t-type">Not stocked</span>') + '</td>' +
      '<td>' + escapeHtml(r.category) + '</td><td>' + r.size + ' sq ft</td><td>' + promoCell(r) + '</td>' +
      '<td>' + fmtMoney(r.rackMonthly) + '</td><td>' + fmtPsf(r.rackPsf) + '</td>' +
      '<td>' + (r.combinedDiscount > 0 ? (Number(r.combinedDiscount) * 100).toFixed(1) + '%' : '—') + '</td>' +
      '<td>' + fmtMoney(r.effectiveMonthly) + '</td><td>' + fmtPsf(r.effectivePsf) + '</td>' +
      (anyBlended ? '<td>' + (r.freeMonths ? r.freeMonths + ' mo' : '—') + '</td><td>' + fmtMoney(r.blendedMonthly) + '</td><td>' + fmtPsf(r.blendedPsf) + '</td>' : '') +
      '<td>' + fmtPsf(r.targetPsf) + '</td>' +
      '<td>' + (r.gapVsTarget == null ? '—' : (Number(r.gapVsTarget) >= 0 ? '+' : '') + fmtPsf(r.gapVsTarget)) + '</td>' +
      '<td>' + (r.overridden ? '<span class="pill amber">override</span> ' : '') +
      (canOverride ? '<button class="tb-btn ghost" data-rs-override="' + r.size + '" data-perm="facility-rate-strategy:update">Override</button>' : '') + '</td></tr>').join('') +
    '</tbody></table></div>' +
    (inRange.length > cap.length ? '<div class="t-type">Showing 200 of ' + inRange.length + ' rows.</div>' : '') +
    '<div class="t-type" style="margin-top:6px;">Rack potential ' + fmtMoney(s.rackPotential) + '/mo · net potential ' + fmtMoney(s.netPotential) +
    '/mo · weighted rack ' + fmtPsf(s.weightedRackPsf) + ' · weighted effective ' + fmtPsf(s.weightedEffectivePsf) +
    (s.weightedBlendedPsf != null ? ' · weighted blended ' + fmtPsf(s.weightedBlendedPsf) : '') + '</div>';
  if (canOverride) {
    host.querySelectorAll('[data-rs-override]').forEach((b) => b.addEventListener('click', () => {
      openOverrideModal(root, Number(b.dataset.rsOverride));
    }));
  }
}

/** Per-row manual rate override (§15.21): monthly rate + mandatory reason;
 *  “Use generated rate” removes the override. Draft-only, audited server-side. */
function openOverrideModal(root, size) {
  const v = view.version;
  if (!v || v.status !== 'DRAFT') return;
  const existing = ((v.levers && v.levers.sizeOverrides) || []).find((o) => Number(o.size) === size);
  const currentRack = view.preview && (view.preview.preview.rows || []).find((r) => r.size === size);
  overlay(root, 'Override ' + size + ' sq ft — ' + v.strategyName + ' v' + v.versionNo,
    '<p class="t-type">Generated rack ' + fmtMoney(currentRack && currentRack.rackMonthly) + '/mo. The override stays visible and auditable; a below-floor rate is a blocker.</p>' +
    '<div class="form-grid"><div class="field"><label for="rsov-rate">Monthly rack-rate override (S$)</label>' +
    '<input id="rsov-rate" type="number" min="0.01" step="0.01" value="' + escapeHtml(String((existing && existing.monthlyRate) ?? (currentRack && currentRack.rackMonthly) ?? '')) + '"></div>' +
    '<div class="field"><label for="rsov-reason">Reason (required)</label>' +
    '<input id="rsov-reason" maxlength="200" value="' + escapeHtml(String((existing && existing.reason) || '')) + '" placeholder="e.g. Locker premium for level 1"></div></div>' +
    (existing ? '<p class="t-type">“Use generated rate” below removes this override.</p>' : ''),
    'Apply override',
    async () => {
      const rate = Number($('#rsov-rate').value);
      const reason = $('#rsov-reason').value.trim();
      if (!(rate > 0)) throw new Error('A positive monthly rack rate is required.');
      if (!reason) throw new Error('A reason is required for an override.');
      const rest = ((v.levers && v.levers.sizeOverrides) || []).filter((o) => Number(o.size) !== size);
      rest.push({ size, monthlyRate: Math.round(rate * 100) / 100, reason });
      await patch('/rate-strategy/' + encodeURIComponent(v.id), { version: v.version, levers: { sizeOverrides: rest } });
      showBanner('Override saved for ' + size + ' sq ft', true);
      view.previews = {};
      await refreshShow(root);
      await refreshWorkbench(root);
    });
  if (existing) {
    const foot = $('#rsOverlay .modal-foot');
    if (foot) {
      const rm = document.createElement('button');
      rm.className = 'act-btn';
      rm.type = 'button';
      rm.textContent = 'Use generated rate';
      rm.setAttribute('data-perm', 'facility-rate-strategy:update');
      rm.addEventListener('click', async () => {
        rm.disabled = true;
        try {
          const rest = ((view.version.levers && view.version.levers.sizeOverrides) || []).filter((o) => Number(o.size) !== size);
          await patch('/rate-strategy/' + encodeURIComponent(view.version.id), { version: view.version.version, levers: { sizeOverrides: rest } });
          showBanner('Override removed for ' + size + ' sq ft', true);
          closeOverlay();
          view.previews = {};
          await refreshShow(root);
          await refreshWorkbench(root);
        } catch (e) {
          const err = $('#rsOverlayErr');
          if (err) { err.hidden = false; err.textContent = describeError(e); }
          rm.disabled = false;
        }
      });
      foot.prepend(rm);
    }
  }
}

async function runValidation(root) {
  const host = $('#rsValidation');
  host.innerHTML = '<div class="section-empty">Validating…</div>';
  try {
    const data = await post('/rate-strategy/' + encodeURIComponent(view.versionId) + '/validate', {});
    view.validation = data;
    const issue = (i, cls) => '<div class="alert-item"><div class="alert-icon ' + cls + '">!</div><div class="alert-body"><div class="alert-title">' +
      escapeHtml(i.code) + '</div><div class="alert-desc">' + escapeHtml(i.message) +
      (i.reason ? '<br><i>' + escapeHtml(i.reason) + '</i>' : '') + '</div></div></div>';
    const html =
      (data.blockers && data.blockers.length ? '<div class="modal-alert">This version has blockers — Set Active and Apply stay disabled until they clear.</div>' + data.blockers.map((i) => issue(i, 'red')).join('') : '') +
      (data.warnings && data.warnings.length ? '<div class="modal-alert olive">Warnings are display-only — they never block Set Active or Apply.</div>' + data.warnings.map((i) => issue(i, 'amber')).join('') : '') +
      (!((data.blockers || []).length + (data.warnings || []).length) ? '<div class="section-empty">Passed — no blockers or warnings.</div>' : '') +
      ((data.passed || []).length ? '<div class="t-type">Passed: ' + escapeHtml(data.passed.map((p) => (p && typeof p === 'object' ? (p.message || p.code) : p)).join(' · ')) + '</div>' : '');
    host.innerHTML = html;
    // Validation modal (§15.23): same result, exact rule text, Close only —
    // blockers gate Set Active / Apply; warnings are display-only.
    overlay(root, 'Validation — ' + (view.version ? view.version.strategyName + ' v' + view.version.versionNo : view.versionId),
      '<p class="t-type">Warnings are display-only. Only red blockers prevent Set Active or Apply.</p>' + html,
      'Close',
      async () => {});
  } catch (e) {
    host.innerHTML = '<div class="section-empty">Validation failed: ' + escapeHtml(describeError(e)) + '</div>';
  }
}

async function loadHistory(root) {
  const host = $('#rsHistory');
  if (!host) return;
  try {
    const rows = (await get('/rate-strategy/library')) || [];
    const mine = rows.filter((r) => r.strategyId === view.version.strategyId).sort((a, b) => b.versionNo - a.versionNo);
    view.history = mine;
    if (!mine.length) { host.innerHTML = '<div class="section-empty">No versions found.</div>'; return; }
    host.innerHTML = '<div class="rs-table-scroll"><table class="data-tbl"><thead><tr><th>Version</th><th>Status</th><th>Effective</th><th>Saved by</th><th>Set Active by</th><th>Updated</th><th></th></tr></thead><tbody>' +
      mine.map((r) =>
        '<tr><td><b>v' + r.versionNo + '</b>' + (r.currentVersion ? '<div class="t-type">current</div>' : '') + '</td><td>' + statusPill(r.status) + '</td>' +
        '<td>' + escapeHtml(r.effectiveFrom || '—') + '</td><td>' + escapeHtml(r.submittedBy || '—') + '</td>' +
        '<td>' + escapeHtml(r.approvedBy || r.rejectedBy || '—') + '</td><td>' + escapeHtml(fmtDay(r.updatedAt)) + '</td>' +
        '<td>' + (r.versionId === view.versionId ? '<span class="t-type">open</span>' : '<button class="tb-btn ghost" data-rs-hist="' + escapeHtml(r.versionId) + '">Open</button>') + '</td></tr>').join('') +
      '</tbody></table></div>';
    host.querySelectorAll('[data-rs-hist]').forEach((b) => b.addEventListener('click', async () => {
      view.versionId = b.dataset.rsHist;
      view.version = null; view.preview = null; view.previewError = null; view.liveDirty = false; view.validation = null; view.history = null; view.activity = null;
      view.previews = {}; view.planIds = null; view.plans = null;
      await renderShow($('#rsBody'), root);
    }));
  } catch (e) {
    host.innerHTML = '<div class="section-empty">History failed to load: ' + escapeHtml(describeError(e)) + '</div>';
  }
}

async function loadActivity(root) {
  const host = $('#rsActivity');
  if (!host) return;
  const items = [];
  try {
    const mine = await get('/finance/audit?entityType=rate-strategy&entityId=' + encodeURIComponent(view.versionId) + '&limit=100');
    (mine || []).forEach((r) => items.push(r));
  } catch (e) {
    host.innerHTML = '<div class="section-empty">Activity needs Finance audit access (' + escapeHtml(describeError(e)) + ').</div>';
    return;
  }
  try {
    const batches = await get('/rate-batches?versionId=' + encodeURIComponent(view.versionId) + '&limit=50');
    view.batches = batches;
    const per = await Promise.all((batches || []).map((b) =>
      get('/finance/audit?entityType=rate-batch&entityId=' + encodeURIComponent(b.id) + '&limit=50').catch(() => [])));
    per.forEach((rows) => (rows || []).forEach((r) => items.push(r)));
  } catch (e) { /* batches unreadable — version events still render */ }
  items.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  view.activity = items;
  if (!items.length) { host.innerHTML = '<div class="section-empty">No activity recorded for this version yet.</div>'; return; }
  host.innerHTML = '<ol class="ud-timeline">' + items.slice(0, 60).map((r) =>
    '<li><div class="ud-tcard-top"><b>' + escapeHtml(actionLabel(r.action)) + '</b><span class="t-type">' + escapeHtml(fmtDay(r.occurredAt)) + '</span></div>' +
    '<div class="t-type">' + escapeHtml([r.actor, r.entityType, r.reason].filter(Boolean).join(' · ')) + '</div></li>').join('') + '</ol>';
}

function actionLabel(a) {
  return String(a || '').replace(/^RATE_STRATEGY_/, '').replace(/^RATE_BATCH_/, '').replace(/_/g, ' ').toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

// B-2: version-scoped batch section at the bottom of the single scrolling
// detail page — reuses openBatchDetail (and its apply / retry / cancel
// flows) via the shared #rsBatchDetail host.
async function loadVersionBatches(root) {
  const host = $('#rsVersionBatches');
  if (!host || !view.version) return;
  try {
    const rows = await get('/rate-batches?versionId=' + encodeURIComponent(view.versionId) + '&limit=50');
    if (!rows || !rows.length) {
      host.innerHTML = '<div class="section-empty">No batches for this version yet. Apply rates to Units schedules the first batch.</div>';
    } else {
      host.innerHTML = '<div class="rs-table-scroll"><table class="data-tbl"><thead><tr><th>Batch</th><th>Effective</th><th>Rule</th><th>Status</th><th>Lines</th><th>By</th><th></th></tr></thead><tbody>' +
        rows.map((r) => {
          const s = r.summary || {};
          return '<tr><td><b>' + escapeHtml(r.ref) + '</b></td><td>' + escapeHtml(r.effectiveDate) + '</td>' +
            '<td class="t-type">' + escapeHtml(String(r.conflictRule).replace(/_/g, ' ')) + '</td>' +
            '<td>' + statusPill(r.status) + '</td>' +
            '<td class="t-type">' + r.unitCount + ' units · ✓' + (s.applied || 0) + ' ✋' + (s.preservedManual || 0) + ' ⏭' + (s.skippedOccupied || 0) + ' ✗' + (s.failed || 0) + '</td>' +
            '<td class="t-type">' + escapeHtml(r.appliedBy || r.createdBy || '—') + '</td>' +
            '<td><button class="tb-btn ghost" data-rs-batch="' + escapeHtml(r.id) + '" data-perm="facility-rate-strategy:view">Open</button></td></tr>';
        }).join('') + '</tbody></table></div>';
      host.querySelectorAll('[data-rs-batch]').forEach((b) => b.addEventListener('click', () => openBatchDetail(root, b.dataset.rsBatch)));
    }
  } catch (e) {
    host.innerHTML = '<div class="section-empty">Batches failed to load: ' + escapeHtml(describeError(e)) + '</div>';
  }
  const due = $('#rsVersionApplyDue');
  if (due && !due.dataset.bound) {
    due.dataset.bound = '1';
    due.addEventListener('click', async () => {
      due.disabled = true;
      try {
        const out = await post('/units/rate-batches/apply-due', {});
        const parts = (out.results || []).map((r) => r.ref + ': ' + r.status + (r.skipped ? ' (' + r.skipped + ')' : ''));
        showBanner(parts.length ? 'Apply due: ' + parts.join(' · ') : 'Apply due: nothing scheduled', true);
        await loadVersionBatches(root);
      } catch (e) { rsError(root, e); }
      due.disabled = false;
    });
  }
}

// ============================== actions ==============================

async function refreshShow(root) {
  const body = $('#rsBody');
  if (body) await renderShow(body, root);
}

// Set Active (no approval gate): Draft → Active. Blockers and a missing
// CURRENT Financial Model target prevent activation; warnings are
// display-only. Requires a saved draft — unsaved workbench edits block it.
async function activateStrategy(root, v) {
  if (!v || v.status !== 'DRAFT') {
    rsError(root, new Error('Only a Draft can be set Active.'));
    return;
  }
  if (view.liveDirty) {
    rsError(root, new Error('Save the draft first — unsaved workbench changes must be saved or undone before Set Active.'));
    return;
  }
  const okConfirm = await confirmDialog({
    title: 'Set version ' + v.versionNo + ' Active?',
    message: 'Activation freezes this snapshot and supersedes other Active versions. Rates still reach Units only through Apply rates to Units.',
    confirmLabel: 'Set Active',
    danger: false,
  });
  if (!okConfirm) return;
  try {
    await post('/rate-strategy/' + encodeURIComponent(v.id) + '/activate', { version: v.version });
    showBanner('Version ' + v.versionNo + ' is now Active', true);
  } catch (e) { rsError(root, e); return; }
  await refreshShow(root);
}

function openDuplicateModal(root, v) {
  const branches = (state.branches || []);
  overlay(root, 'Duplicate version ' + v.versionNo + ' for facility',
    '<p class="t-type">Copies pricing logic, not inventory — the destination facility re-links to its own Units. Resets to version 1, Draft.</p>' +
    '<label class="t-type" for="rsDupBranch">Destination facility</label>' +
    '<select id="rsDupBranch" class="tbl-select" style="width:100%">' + branches.map((b) =>
      '<option value="' + escapeHtml(b.id) + '"' + (b.id === v.branchId ? ' selected' : '') + '>' + escapeHtml(b.code + ' · ' + b.name) + '</option>').join('') + '</select>' +
    '<label class="t-type" for="rsDupName" style="margin-top:8px;display:block;">New strategy name</label>' +
    '<input id="rsDupName" class="set-input" style="width:100%" maxlength="120" value="' + escapeHtml(v.strategyName + ' (copy)') + '">' +
    '<label class="t-type" for="rsDupUplift" style="margin-top:8px;display:block;">Rate uplift % (default +5 — applied to anchor, floors, minimum, category floors and overrides)</label>' +
    '<input id="rsDupUplift" type="number" class="set-input" value="5" min="-50" max="100" step="0.5" style="width:120px">',
    'Duplicate',
    async () => {
      const data = await post('/rate-strategy/' + encodeURIComponent(v.id) + '/duplicate', {
        destinationBranchId: $('#rsDupBranch').value,
        name: $('#rsDupName').value.trim(),
        upliftPct: Number($('#rsDupUplift').value),
      }).then((b) => b);
      showBanner('Duplicated as ' + data.strategyName + ' v1 Draft', true);
      view.versionId = data.id;
      view.version = null; view.preview = null; view.previewError = null; view.liveDirty = false; view.validation = null; view.history = null; view.activity = null;
      await refreshShow(root);
    });
}

function openBatchModal(root, v) {
  if (v.status !== 'ACTIVE' && v.status !== 'APPROVED') {
    rsError(root, new Error('Only Active versions can apply rates to Units. Save the draft, set it Active, then apply with no unsaved changes.'));
    return;
  }
  if (view.liveDirty) {
    rsError(root, new Error('Save the draft first — unsaved workbench changes must be saved or undone before applying rates.'));
    return;
  }
  const rule = currentDefaultRule();
  overlay(root, 'Schedule Units rate batch — ' + v.strategyName + ' v' + v.versionNo,
    '<p class="t-type">Batch updates vacant-unit rack rates, future quotes and new reservations on/after the effective date. It never touches occupied-customer rent, promotion definitions, Protection Plans or signed agreements. ' +
    'Confirmation is enabled only for Active versions with no unsaved changes.</p>' +
    '<label class="t-type" for="rsBatchDate">Rates take effect</label>' +
    '<input id="rsBatchDate" type="date" class="set-input" value="' + escapeHtml(v.effectiveFrom || todaySg()) + '">' +
    '<label class="t-type" for="rsBatchRule" style="margin-top:8px;display:block;">Existing manual unit rates</label>' +
    '<select id="rsBatchRule" class="tbl-select" style="width:100%">' + CONFLICT_RULES.map((r) =>
      '<option value="' + r + '"' + (rule === r ? ' selected' : '') + '>' + r.replace(/_/g, ' ').toLowerCase() +
      (r === 'PRESERVE_MANUAL' ? ' — recommended' : r === 'REPLACE_MANUAL' ? ' — Owner only' : '') + '</option>').join('') + '</select>',
    'Schedule batch',
    async () => {
      const key = 'rs-' + v.id.slice(0, 8) + '-' + Date.now().toString(36);
      const body = await request('/rate-strategy/' + encodeURIComponent(v.id) + '/batches', {
        method: 'POST',
        body: JSON.stringify({ effectiveDate: $('#rsBatchDate').value, conflictRule: $('#rsBatchRule').value }),
        headers: { 'Idempotency-Key': key },
      });
        showBanner('Batch ' + body.data.ref + ' scheduled' + (body.meta && body.meta.replayed ? ' (replayed)' : ''), true);
        await loadVersionBatches(root);
        await loadActivity(root);
        const sec = $('#rsVersionBatches');
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
}

// Scoped styles for the B-4 live workbench (runtime-injected, same
// convention as the modal scroll guard — no dashboard.html change):
// chart sits beside the levers at desktop width and stacks below 700px;
// method toggle + ? tips reuse the existing CMS tokens and §5 colours.
// B-8 mobile: .tb-btn is white-space:nowrap and .tbl-toolbar never wraps,
// so the 7-button #rsActions header forced a ~941px page at 375px. Wrap
// every toolbar in this workspace (scoped to #rateStrategyRoot — the shared
// dashboard CSS is frozen) and keep wide tables in their own horizontal
// scroll containers. No-op at 1440px: everything still fits on one row.
function ensureRsWorkbenchStyles() {
  if (document.querySelector('style[data-rs-workbench]')) return;
  const st = document.createElement('style');
  st.setAttribute('data-rs-workbench', '1');
  st.textContent =
    '#rateStrategyRoot .tbl-toolbar{flex-wrap:wrap;row-gap:8px}' +
    '#rateStrategyRoot .tbl-toolbar .tbl-select,#rateStrategyRoot .tbl-toolbar .set-input{max-width:100%}' +
    '#rateStrategyRoot .rs-table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}' +
    '.rs-workgrid{display:flex;flex-wrap:wrap;gap:12px}' +
    '.rs-workgrid>.rs-workcol{flex:1 1 340px;min-width:280px;min-width:0}' +
    '@media (max-width:700px){.rs-workgrid>.rs-workcol{flex-basis:100%}}' +
    '.rs-kpi-grid{display:flex;flex-wrap:wrap;gap:12px}' +
    '.rs-kpi-grid>.tbl-card{flex:1 1 300px;min-width:260px;min-width:0}' +
    '@media (max-width:700px){.rs-kpi-grid>.tbl-card{flex-basis:100%}}' +
    '#rsKpiDurBar{flex-wrap:wrap;row-gap:8px}' +
    '.rs-seg{display:flex;gap:8px;flex-wrap:wrap}' +
    '.rs-chart-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}' +
    '.rs-tip{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;' +
    'border:1px solid var(--olive2,#526557);color:var(--olive2,#526557);font-size:11px;line-height:1;cursor:help}' +
    '.rs-tip:focus{outline:2px solid var(--olive2,#526557);outline-offset:1px}' +
    '#rsLevers input[type=range]{accent-color:var(--olive2,#526557)}';
  document.head.appendChild(st);
}

// Scoped scroll guard for every rate-strategy modal (B-1): the shared
// dashboard.html `.modal-overlay` has no overflow, so a tall window (e.g. the
// 1337px New-strategy form) clips its footer below the fold on a 900px-high
// screen. Constrain this workspace's window to the viewport and scroll the
// body internally, leaving the header/footer pinned. Injected once at runtime
// (same convention as confirmDialog's check row) — no dashboard.html change, existing
// CMS tokens and v55 look untouched. All overlay() callers (new, edit levers,
// override, validate, duplicate, schedule batch) share id #rsOverlay,
// so this one rule audits/fixes them all; Set Active goes through the short
// confirmDialog shell and never overflows.
function ensureRsOverlayStyles() {
  if (document.querySelector('style[data-rs-overlay]')) return;
  const st = document.createElement('style');
  st.setAttribute('data-rs-overlay', '1');
  st.textContent =
    '#rsOverlay{overflow-y:auto}' +
    '#rsOverlay .modal-win{max-height:min(90vh,1100px);display:flex;flex-direction:column;overflow:hidden}' +
    '#rsOverlay .modal-hdr{flex:none}' +
    '#rsOverlay .modal-body{overflow-y:auto;min-height:0;flex:1 1 auto;overscroll-behavior:contain}' +
    '#rsOverlay .modal-foot{flex:none}';
  document.head.appendChild(st);
}

/** Tiny runtime modal — no dashboard.html change (same convention as confirmDialog's check row). */
function overlay(root, title, bodyHtml, confirmLabel, onConfirm) {
  ensureRsOverlayStyles();
  closeOverlay();
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay';
  wrap.id = 'rsOverlay';
  wrap.innerHTML = '<div class="modal-win" role="dialog" aria-label="' + escapeHtml(title) + '">' +
    '<div class="modal-hdr"><div class="modal-title">' + escapeHtml(title) + '</div>' +
    '<button class="modal-x" id="rsOverlayX" type="button">✕</button></div>' +
    '<div class="modal-body">' + bodyHtml + '<div class="modal-alert" id="rsOverlayErr" hidden></div></div>' +
    '<div class="modal-foot"><button class="act-btn" id="rsOverlayCancel" type="button">Cancel</button>' +
    '<button class="act-btn primary" id="rsOverlayOk" type="button">' + escapeHtml(confirmLabel) + '</button></div></div>';
  document.body.appendChild(wrap);
  const close = () => closeOverlay();
  $('#rsOverlayX').addEventListener('click', close);
  $('#rsOverlayCancel').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  $('#rsOverlayOk').addEventListener('click', async () => {
    const btn = $('#rsOverlayOk');
    btn.disabled = true;
    try { await onConfirm(); close(); }
    catch (e) {
      const err = $('#rsOverlayErr');
      if (err) { err.hidden = false; err.textContent = describeError(e); }
      btn.disabled = false;
    }
  });
}

function closeOverlay() {
  const el = $('#rsOverlay');
  if (el) el.remove();
}

// ============================== create / edit levers ==============================

function leverField(name, label, value, attrs) {
  return '<div class="field"><label for="rsf-' + name + '">' + escapeHtml(label) + '</label>' +
    '<input id="rsf-' + name + '" name="' + name + '" value="' + escapeHtml(String(value ?? '')) + '"' + (attrs || '') + '>' +
    '<div class="field-err" id="rse-' + name + '"></div></div>';
}

function leverFormHtml(l, plans) {
  return '<div class="form-grid">' +
    leverField('referenceSize', 'Reference size (sq ft)', l.referenceSize, ' type="number" min="1" step="1"') +
    leverField('startingRate', 'Starting monthly rack rate (S$)', l.startingRate, ' type="number" min="1" step="0.01"') +
    '<div class="field"><label for="rsf-method">Pricing method</label><select id="rsf-method" name="method">' +
    '<option value="SMOOTH"' + (l.method !== 'STEP' ? ' selected' : '') + '>Smooth size curve</option>' +
    '<option value="STEP"' + (l.method === 'STEP' ? ' selected' : '') + '>Step-down table</option></select></div>' +
    leverField('curveStrength', 'Curve strength 0–0.60 (smooth)', l.curveStrength, ' type="number" min="0" max="1" step="0.01"') +
    leverField('stepEvery', 'Reduce PSF every N sq ft (step)', l.stepEvery, ' type="number" min="1" step="1"') +
    leverField('stepPsf', 'PSF reduction per step (S$)', l.stepPsf, ' type="number" min="0" step="0.01"') +
    leverField('psfFloor', 'Rack PSF floor (S$)', l.psfFloor, ' type="number" min="0" step="0.01"') +
    leverField('minMonthly', 'Minimum monthly rent (S$)', l.minMonthly, ' type="number" min="0" step="0.01"') +
    leverField('lockerAdj', 'Locker adjustment %', l.lockerAdj, ' type="number" min="-95" max="100" step="0.5"') +
    leverField('groundFloorAdj', 'Ground-floor adjustment %', l.groundFloorAdj, ' type="number" min="-95" max="100" step="0.5"') +
    leverField('restrictedAdj', 'Restricted-access adjustment %', l.restrictedAdj, ' type="number" min="-95" max="100" step="0.5"') +
    leverField('facilityAdj', 'Facility-wide adjustment %', l.facilityAdj, ' type="number" min="-50" max="100" step="0.5"') +
    '<div class="field"><label for="rsf-rounding">Round monthly rate to nearest</label><select id="rsf-rounding" name="rounding">' +
    [1, 5, 10].map((r) => '<option value="' + r + '"' + (Number(l.rounding) === r ? ' selected' : '') + '>S$' + r + '</option>').join('') + '</select></div>' +
    '</div>' +
    '<div class="t-type" style="margin:8px 0 4px;">Category floors (minimum rack PSF, S$0.05 steps)</div>' +
    '<div class="form-grid">' + CATEGORIES.map((c) =>
      leverField('cf-' + c, c, (l.categoryFloors && l.categoryFloors[c]) ?? '', ' type="number" min="0" step="0.05"')).join('') + '</div>' +
    '<div class="t-type" style="margin:8px 0 4px;">Size overrides — one per line: <i>size,rate,reason</i> (e.g. 12,95,Locker premium)</div>' +
    '<textarea id="rsf-overrides" class="set-input" rows="2" style="width:100%">' +
    escapeHtml((l.sizeOverrides || []).map((o) => o.size + ',' + o.monthlyRate + ',' + o.reason).join('\n')) + '</textarea>' +
    '<div class="t-type" style="margin:8px 0 4px;">Promotion preview (read-only analysis — selecting a plan never activates it)</div>' +
    '<div class="form-grid">' +
    '<div class="field"><label for="rsf-duration">Duration</label><select id="rsf-duration" name="duration">' +
    DURATIONS.map((d) => '<option value="' + d + '"' + (Number(l.previewDuration) === d ? ' selected' : '') + '>' + d + ' months</option>').join('') + '</select></div>' +
    '<div class="field"><label for="rsf-matrix">Percentage matrix</label><select id="rsf-matrix" name="matrix">' +
    ['Standard', 'Ground floor'].map((m) => '<option' + (l.previewMatrix === m ? ' selected' : '') + '>' + m + '</option>').join('') + '</select></div>' +
    '</div>' +
    '<div id="rsf-plans">' + (plans || []).map((p) =>
      '<label class="t-type" style="display:block;margin:2px 0;"><input type="checkbox" data-rs-plan="' + escapeHtml(p.id) + '"' +
      ((l.planIds || []).includes(p.id) ? ' checked' : '') + '> ' + escapeHtml(p.name) +
      ' <span class="pill ' + (p.status === 'ACTIVE' ? 'green' : 'amber') + '">' + escapeHtml(p.status) + '</span>' +
      (p.status !== 'ACTIVE' ? ' <i>preview only</i>' : '') + '</label>').join('') + '</div>';
}

function readLeversForm() {
  const num = (id) => { const v = $('#' + id).value.trim(); return v === '' ? undefined : Number(v); };
  const cf = {};
  CATEGORIES.forEach((c) => { const v = num('rsf-cf-' + c); if (v !== undefined) cf[c] = v; });
  const overrides = $('#rsf-overrides').value.split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
    const parts = line.split(',');
    return { size: Number(parts[0]), monthlyRate: Number(parts[1]), reason: parts.slice(2).join(',').trim() };
  });
  const pct = (id) => { const v = num(id); return v === undefined ? undefined : v / 100; };
  return {
    levers: {
      referenceSize: num('rsf-referenceSize'), startingRate: num('rsf-startingRate'), method: $('#rsf-method').value,
      curveStrength: num('rsf-curveStrength'), stepEvery: num('rsf-stepEvery'), stepPsf: num('rsf-stepPsf'),
      psfFloor: num('rsf-psfFloor'), minMonthly: num('rsf-minMonthly'),
      lockerAdj: pct('rsf-lockerAdj'), groundFloorAdj: pct('rsf-groundFloorAdj'),
      restrictedAdj: pct('rsf-restrictedAdj'), facilityAdj: pct('rsf-facilityAdj'),
      rounding: Number($('#rsf-rounding').value),
      categoryFloors: cf, sizeOverrides: overrides,
    },
    preview: {
      durationMonths: Number($('#rsf-duration').value),
      matrix: $('#rsf-matrix').value,
      planIds: $$('#rsf-plans [data-rs-plan]:checked').map((el) => el.dataset.rsPlan),
    },
  };
}

async function loadPromoPlans() {
  try {
    const rows = await get('/promotion-plans');
    return (rows || []).filter((p) => p.status === 'ACTIVE' || p.status === 'DRAFT')
      .map((p) => ({ id: p.id, name: p.name, status: p.status }));
  } catch (e) { return []; }
}

function openCreateModal(root) {
  loadPromoPlans().then((plans) => {
    const l = { ...DEFAULT_LEVERS_UI, rounding: currentDefaultRounding(), previewDuration: 12, previewMatrix: 'Standard', planIds: [] };
    overlay(root, 'New rate strategy',
      '<label class="t-type" for="rsf-branch">Facility</label>' +
      '<select id="rsf-branch" class="tbl-select" style="width:100%">' + (state.branches || []).map((b) =>
        '<option value="' + escapeHtml(b.id) + '"' + (view.branchFilter === b.id ? ' selected' : '') + '>' + escapeHtml(b.code + ' · ' + b.name) + '</option>').join('') + '</select>' +
      '<div class="form-grid" style="margin-top:8px;"><div class="field"><label for="rsf-name">Strategy name</label><input id="rsf-name" maxlength="120" placeholder="e.g. Sembawang launch rates"></div>' +
      '<div class="field"><label for="rsf-owner">Owner (optional)</label><input id="rsf-owner" maxlength="120"></div>' +
      leverField('effectiveFrom', 'Effective from', todaySg(), ' type="date"') + '</div>' +
      leverFormHtml(l, plans),
      'Create draft',
      async () => {
        if (!$('#rsf-name').value.trim()) throw new Error('A strategy name is required.');
        const { levers, preview } = readLeversForm();
        const data = await post('/facilities/' + encodeURIComponent($('#rsf-branch').value) + '/rate-strategy', {
          name: $('#rsf-name').value.trim(),
          owner: $('#rsf-owner').value.trim() || undefined,
          effectiveFrom: $('#rsf-effectiveFrom').value || undefined,
          levers, promotionPreview: preview,
        }).then((b) => b);
        showBanner('Draft ' + data.strategyName + ' v1 created', true);
        view.versionId = data.id;
        await showRoot(root);
      });
  }).catch((e) => rsError(root, e));
}

function openLeverModal(root, v, _unused) {
  loadPromoPlans().then((plans) => {
    const l = v.levers || {};
    const toPct = (x) => (x == null ? '' : Math.round(Number(x) * 1000) / 10);
    const ui = {
      ...l,
      lockerAdj: toPct(l.lockerAdj), groundFloorAdj: toPct(l.groundFloorAdj),
      restrictedAdj: toPct(l.restrictedAdj), facilityAdj: toPct(l.facilityAdj),
      previewDuration: (v.previewSelection && v.previewSelection.durationMonths) || 12,
      previewMatrix: (v.previewSelection && v.previewSelection.matrix) || 'Standard',
      planIds: ((v.previewSelection && v.previewSelection.planRefs) || []).map((r) => r.planId),
    };
    overlay(root, 'Edit levers — ' + v.strategyName + ' v' + v.versionNo + ' (Draft)',
      '<p class="t-type">Saving replaces the draft levers and clears the last validation.</p>' + leverFormHtml(ui, plans),
      'Save draft',
      async () => {
        const { levers, preview } = readLeversForm();
        await patch('/rate-strategy/' + encodeURIComponent(v.id), { version: v.version, levers, promotionPreview: preview });
        showBanner('Draft saved', true);
        await refreshShow(root);
        await refreshWorkbench(root);
      });
  }).catch((e) => rsError(root, e));
}

// ============================== scheduler ==============================

async function renderScheduler(body, root) {
  body.innerHTML =
    '<div class="tbl-toolbar"><select id="rsBatchBranch" class="tbl-select">' + branchOptions(view.batchBranchFilter) + '</select>' +
    '<select id="rsBatchStatus" class="tbl-select"><option value="">All statuses</option>' +
    ['SCHEDULED', 'APPLYING', 'APPLIED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED'].map((s) =>
      '<option value="' + s + '"' + (view.batchStatusFilter === s ? ' selected' : '') + '>' + s.replace(/_/g, ' ') + '</option>').join('') + '</select>' +
    '<span style="flex:1"></span>' +
    (can('facility-rate-strategy:update') ? '<button class="tb-btn primary" id="rsApplyDue">Apply due batches</button>' : '') +
    '<button class="tb-btn ghost" id="rsBatchReload">Reload</button></div>' +
    '<div id="rsBatchList"><div class="section-empty">Loading batches…</div></div>' +
    '<div id="rsBatchDetail"></div>';
  $('#rsBatchBranch').addEventListener('change', (e) => { view.batchBranchFilter = e.target.value; loadBatches(root); });
  $('#rsBatchStatus').addEventListener('change', (e) => { view.batchStatusFilter = e.target.value; loadBatches(root); });
  $('#rsBatchReload').addEventListener('click', () => loadBatches(root));
  const due = $('#rsApplyDue');
  if (due) due.addEventListener('click', async () => {
    due.disabled = true;
    try {
      const out = await post('/units/rate-batches/apply-due', {});
      const parts = (out.results || []).map((r) => r.ref + ': ' + r.status + (r.skipped ? ' (' + r.skipped + ')' : ''));
      showBanner(parts.length ? 'Apply due: ' + parts.join(' · ') : 'Apply due: nothing scheduled', true);
      await loadBatches(root);
    } catch (e) { rsError(root, e); }
    due.disabled = false;
  });
  await loadBatches(root);
}

async function loadBatches(root) {
  const host = $('#rsBatchList');
  try {
    const q = new URLSearchParams();
    if (view.batchBranchFilter) q.set('branchId', view.batchBranchFilter);
    if (view.batchStatusFilter) q.set('status', view.batchStatusFilter);
    const rows = await get('/rate-batches' + (q.toString() ? '?' + q.toString() : ''));
    view.batchRows = rows;
    if (!rows || !rows.length) {
      host.innerHTML = '<div class="section-empty">No records match these filters.</div>';
      return;
    }
    const today = todaySg();
    const group = (r) => r.status === 'SCHEDULED' && r.effectiveDate > today ? 'Scheduled' : r.effectiveDate <= today && r.status === 'SCHEDULED' ? 'Due now' : 'Past';
    const groups = {};
    rows.forEach((r) => { const g = group(r); (groups[g] = groups[g] || []).push(r); });
    host.innerHTML = ['Due now', 'Scheduled', 'Past'].filter((g) => groups[g]).map((g) =>
      '<div class="sec-hdr"><div><div class="sec-title">' + g + ' (' + groups[g].length + ')</div>' +
      '<div class="sec-sub">' + (g === 'Due now' ? 'Effective today or earlier — Apply due batches picks these up.' : g === 'Scheduled' ? 'Future-dated — applied when due.' : 'Terminal or in-flight batches with per-unit results.') + '</div></div></div>' +
      '<div class="rs-table-scroll"><table class="data-tbl"><thead><tr><th>Batch</th><th>Strategy</th><th>Facility</th><th>Effective</th><th>Rule</th><th>Status</th><th>Lines</th><th>By</th><th></th></tr></thead><tbody>' +
      groups[g].map((r) => {
        const s = r.summary || {};
        return '<tr><td><b>' + escapeHtml(r.ref) + '</b></td><td>' + escapeHtml(r.strategyName) + ' v' + r.versionNo + '</td>' +
          '<td>' + branchLabel(r) + '</td><td>' + escapeHtml(r.effectiveDate) + '</td><td class="t-type">' + escapeHtml(String(r.conflictRule).replace(/_/g, ' ')) + '</td>' +
          '<td>' + statusPill(r.status) + '</td>' +
          '<td class="t-type">' + r.unitCount + ' units · ✓' + (s.applied || 0) + ' ✋' + (s.preservedManual || 0) + ' ⏭' + (s.skippedOccupied || 0) + ' ✗' + (s.failed || 0) + '</td>' +
          '<td class="t-type">' + escapeHtml(r.appliedBy || r.createdBy || '—') + '</td>' +
          '<td><button class="tb-btn ghost" data-rs-batch="' + escapeHtml(r.id) + '" data-perm="facility-rate-strategy:view">Open</button></td></tr>';
      }).join('') + '</tbody></table></div>').join('');
    host.querySelectorAll('[data-rs-batch]').forEach((b) => b.addEventListener('click', () => openBatchDetail(root, b.dataset.rsBatch)));
  } catch (e) {
    host.innerHTML = '<div class="section-empty">Batches failed to load: ' + escapeHtml(describeError(e)) + '</div>';
  }
}

async function openBatchDetail(root, batchId) {
  const host = $('#rsBatchDetail');
  host.innerHTML = '<div class="section-empty">Loading batch…</div>';
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const b = await get('/rate-batches/' + encodeURIComponent(batchId));
    view.batchDetail = b;
    const s = b.summary || {};
    host.innerHTML =
      '<div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">Batch ' + escapeHtml(b.ref) + '</div>' +
      '<div class="sec-sub">' + escapeHtml(b.strategyName || '') + ' · effective ' + escapeHtml(b.effectiveDate) + ' · ' +
      escapeHtml(String(b.conflictRule).replace(/_/g, ' ')) + ' · ' + b.unitCount + ' units / ' + b.sizeCount + ' sizes</div></div><div>' + statusPill(b.status) + '</div></div>' +
      '<div class="t-type" style="margin-bottom:6px;">Applied ' + (s.applied || 0) + ' · preserved manual ' + (s.preservedManual || 0) +
      ' · skipped occupied ' + (s.skippedOccupied || 0) + ' · failed ' + (s.failed || 0) + ' · pending ' + (s.pending || 0) +
      (b.legacyUnits ? ' · ' + b.legacyUnits.length + ' LEGACY unit(s) listed separately' : '') + '</div>' +
      '<div class="tbl-toolbar">' +
      ((b.status === 'SCHEDULED' && b.effectiveDate <= todaySg() && can('facility-rate-strategy:update')) ? '<button class="tb-btn primary" data-rs-bapply data-perm="facility-rate-strategy:update">Apply now</button>' : '') +
      ((b.status === 'PARTIALLY_FAILED' || b.status === 'FAILED') && can('facility-rate-strategy:update') ? '<button class="tb-btn" data-rs-bretry data-perm="facility-rate-strategy:update">Retry failed</button>' : '') +
      (b.status === 'SCHEDULED' && can('facility-rate-strategy:update') ? '<button class="tb-btn" data-rs-bcancel data-perm="facility-rate-strategy:update">Cancel batch</button>' : '') +
      '</div>' +
      batchLinesHtml(b) + '</div>';
    const apply = host.querySelector('[data-rs-bapply]');
    if (apply) apply.addEventListener('click', async () => {
      const okConfirm = await confirmDialog({ title: 'Apply batch ' + b.ref + '?', message: 'Writes vacant-unit rack rates now. Occupied-customer rent is never touched.', confirmLabel: 'Apply batch' });
      if (!okConfirm) return;
      try {
        const out = await post('/rate-batches/' + encodeURIComponent(b.id) + '/apply', {});
        showBanner('Batch ' + out.ref + ': ' + out.status, true);
        await openBatchDetail(root, b.id);
        await loadBatches(root);
      } catch (e) { rsError(root, e); }
    });
    const retry = host.querySelector('[data-rs-bretry]');
    if (retry) retry.addEventListener('click', async () => {
      try {
        const out = await post('/rate-batches/' + encodeURIComponent(b.id) + '/retry-failed', {});
        showBanner('Batch ' + out.ref + ': ' + out.status, true);
        await openBatchDetail(root, b.id);
        await loadBatches(root);
      } catch (e) { rsError(root, e); }
    });
    const cancel = host.querySelector('[data-rs-bcancel]');
    if (cancel) cancel.addEventListener('click', () => {
      const reason = window.prompt('Cancel batch ' + b.ref + ' — a reason is required:');
      if (reason == null) return;
      if (!reason.trim()) { rsError(root, new Error('Cancelling a batch requires a reason.')); return; }
      post('/rate-batches/' + encodeURIComponent(b.id) + '/cancel', { reason: reason.trim() })
        .then((out) => { showBanner('Batch ' + out.ref + ' cancelled', true); openBatchDetail(root, b.id); loadBatches(root); })
        .catch((e) => rsError(root, e));
    });
  } catch (e) {
    host.innerHTML = '<div class="section-empty">Batch failed to load: ' + escapeHtml(describeError(e)) + '</div>';
  }
}

function batchLinesHtml(b) {
  const lines = b.lines || [];
  if (!lines.length) return '<div class="section-empty">No per-unit lines.</div>';
  const cap = lines.slice(0, 200);
  return '<div class="rs-table-scroll"><table class="data-tbl"><thead><tr><th>Unit</th><th>Size</th><th>Previous</th><th>Proposed</th><th>Outcome</th><th>Note</th></tr></thead><tbody>' +
    cap.map((l) => '<tr><td>' + escapeHtml(l.unitCode || l.unitId) + '</td><td>' + l.sizePoint + ' sq ft</td>' +
      '<td>' + fmtMoney(l.previousRack) + '</td><td>' + fmtMoney(l.proposedRack) + '</td>' +
      '<td>' + outcomePill(l.outcome) + '</td><td class="t-type">' + escapeHtml(l.conflictReason || '—') + '</td></tr>').join('') +
    '</tbody></table></div>' +
    (lines.length > cap.length ? '<div class="t-type">Showing 200 of ' + lines.length + ' lines.</div>' : '');
}

// ============================== settings ==============================

function currentDefaultRounding() {
  const r = view.settings && view.settings['ratestrategy.defaultRounding'];
  return r === 5 || r === 10 ? r : 1;
}

function currentDefaultRule() {
  const r = view.settings && view.settings['ratestrategy.defaultConflictRule'];
  return CONFLICT_RULES.includes(r) ? r : 'PRESERVE_MANUAL';
}

async function renderSettings(body, root) {
  body.innerHTML = '<div class="section-empty">Loading settings…</div>';
  try {
    const [rules, models] = await Promise.all([
      get('/business-rules'),
      get('/finance/models?status=CURRENT').catch(() => []),
    ]);
    const rs = (rules || []).filter((r) => r.key.startsWith('ratestrategy.'));
    view.settings = Object.fromEntries((rules || []).map((r) => [r.key, r.value]));
    view.models = models;
    const byBranch = {};
    (models || []).forEach((m) => { (byBranch[m.branchId] = byBranch[m.branchId] || []).push(m); });
    const canEdit = can('settings-booking:update');
    body.innerHTML =
      '<div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">Rate strategy defaults</div>' +
      '<div class="sec-sub">Preselected for new drafts and batch forms in this workspace. ' +
      (canEdit ? 'Saved via Global Settings › Business rules (settings-booking:update).' : 'Read-only — saving needs the settings-booking:update permission.') + '</div></div>' +
      (canEdit ? '<button class="tb-btn primary" id="rsSettingsSave">Save defaults</button>' : '') + '</div>' +
      (rs.length ? rs.map((r) =>
        '<div class="set-row"><div><b>' + escapeHtml(r.label) + '</b><small>' + escapeHtml(r.description) + (r.customized ? '' : ' · default') + '</small></div>' +
        '<div class="set-ctl">' + (r.key === 'ratestrategy.defaultConflictRule'
          ? '<select id="rs-set-' + escapeHtml(r.key) + '" class="tbl-select"' + (canEdit ? '' : ' disabled') + '>' +
            CONFLICT_RULES.map((c) => '<option value="' + c + '"' + (view.settings[r.key] === c ? ' selected' : '') + '>' + c.replace(/_/g, ' ') + '</option>').join('') + '</select>'
          : '<select id="rs-set-' + escapeHtml(r.key) + '" class="tbl-select"' + (canEdit ? '' : ' disabled') + '>' +
            [1, 5, 10].map((n) => '<option value="' + n + '"' + (Number(view.settings[r.key]) === n ? ' selected' : '') + '>S$' + n + '</option>').join('') + '</select>') +
        '</div></div>').join('') : '<div class="section-empty">No rate-strategy settings registered.</div>') + '</div>' +
      '<div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">Financial Model targets (read-only)</div>' +
      '<div class="sec-sub">Approved CURRENT model per facility — the benchmark previews compare against. Rate Strategy never writes back.</div></div></div>' +
      '<div id="rsModels">' + ((state.branches || []).map((b) => {
        const ms = byBranch[b.id] || [];
        return '<div class="set-row"><div><b>' + escapeHtml(b.code + ' · ' + b.name) + '</b><small>' +
          (ms.length ? escapeHtml(ms.map((m) => m.name + ' (v' + m.version + ')').join(', ')) : 'No CURRENT model — previews return the rack schedule with the target unavailable; Set Active blocks with NO_CURRENT_MODEL') +
          '</small></div></div>';
      }).join('') || '<div class="section-empty">No facilities loaded.</div>') + '</div></div>';
    const save = $('#rsSettingsSave');
    if (save) save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const payload = {};
        rs.forEach((r) => {
          const el = $('#rs-set-' + r.key);
          payload[r.key] = r.key === 'ratestrategy.defaultConflictRule' ? el.value : Number(el.value);
        });
        const saved = await put('/business-rules', payload);
        view.settings = Object.fromEntries((saved || []).map((r) => [r.key, r.value]));
        showBanner('Rate strategy defaults saved', true);
      } catch (e) { rsError(root, e); }
      save.disabled = false;
    });
  } catch (e) {
    body.innerHTML = '<div class="section-empty">Settings failed to load: ' + escapeHtml(describeError(e)) + '</div>';
  }
}

// ============================== units entry points ==============================

  /** Facilities · Units header buttons (handoff §15.26 + R17/D10): Open rate
 * strategy + Apply due batches. Injected from JS so dashboard.html keeps
 * only the strategy tab + panel; permission-gated like every other action.
 * The workspace lives under Rates and Promotions — jumps target #promotions.
 *
 * B-10: wireEvents() runs before sign-in (can() is false until /me
 * resolves), so this must run AFTER auth (admin.js boot) and on every Units
 * tab open — never only in wireEvents. refreshUnitsRateEntry() is the
 * post-auth/tab entry; mountUnitsRateEntry() stays as the idempotent
 * button-only step for backward compatibility. Buttons are hidden — never
 * merely disabled — when the role lacks the grant. */
export function mountUnitsRateEntry() {
  // Hide — never merely disable — when the role lacks the view grant.
  if (!can('facility-rate-strategy:view')) {
    $('#unitsRateStrategyBtn')?.remove();
    $('#unitsApplyDueBtn')?.remove();
    return false;
  }
  const host = document.querySelector('#facility-units .sec-hdr div:last-child');
  if (!host) return false;
  if (!$('#unitsRateStrategyBtn')) {
    const open = document.createElement('button');
    open.className = 'tb-btn';
    open.id = 'unitsRateStrategyBtn';
    open.type = 'button';
    open.setAttribute('data-perm', 'facility-rate-strategy:view');
    open.textContent = 'Open rate strategy';
    open.addEventListener('click', () => {
      location.hash = '#promotions';
      const tab = document.querySelector('[data-tab="facility-rate-strategy"]');
      if (tab) tab.click();
    });
    host.prepend(open);
  }
  // Apply needs BOTH update and facility-units:update (the server enforces
  // the pair; the route table carries only the first). Hide without both.
  const mayApply = can('facility-rate-strategy:update') && can('facility-units:update');
  const due = $('#unitsApplyDueBtn');
  if (mayApply && !due) {
    const btn = document.createElement('button');
    btn.className = 'tb-btn';
    btn.id = 'unitsApplyDueBtn';
    btn.type = 'button';
    btn.setAttribute('data-perm', 'facility-rate-strategy:update');
    btn.textContent = 'Apply due batches';
    btn.title = 'Apply every due scheduled rate batch (idempotent, safe to repeat)';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const out = await post('/units/rate-batches/apply-due', {});
        const parts = (out.results || []).map((r) => r.ref + ': ' + r.status + (r.skipped ? ' (' + r.skipped + ')' : ''));
        showBanner(parts.length ? 'Apply due batches: ' + parts.join(' · ') : 'Apply due batches: nothing scheduled', true);
        refreshUnitsBatchBanner().catch(() => {});
      } catch (e) { showBanner('Apply due batches: ' + describeError(e)); }
      btn.disabled = false;
    });
    host.prepend(btn);
  } else if (!mayApply && due) {
    due.remove();
  }
  return true;
}

/** §15.26 Units batch-status banner: batch ref, status, effective date and a
 * link back to the strategy. Injected beside #unitsBanner so dashboard.html
 * stays untouched; hidden when the role lacks the view grant or when no
 * batch exists yet. */
export async function refreshUnitsBatchBanner() {
  const anchor = $('#unitsBanner');
  if (!canView(PANEL)) {
    $('#unitsRateBatchBanner')?.remove();
    return;
  }
  if (!anchor || !anchor.parentElement) return;
  let host = $('#unitsRateBatchBanner');
  if (!host) {
    host = document.createElement('div');
    host.id = 'unitsRateBatchBanner';
    host.className = 'modal-alert';
    host.setAttribute('data-perm', 'facility-rate-strategy:view');
    host.hidden = true;
    anchor.insertAdjacentElement('afterend', host);
  }
  let rows = null;
  try {
    rows = await get('/rate-batches?limit=50');
  } catch (e) {
    host.hidden = true; // 403/offline: stay silent on the Units page
    return;
  }
  if (!rows || !rows.length) { host.hidden = true; host.innerHTML = ''; return; }
  const today = todaySg();
  const due = rows.find((r) => r.status === 'SCHEDULED' && r.effectiveDate <= today)
    || rows.find((r) => r.status === 'SCHEDULED')
    || rows[0];
  const tone = due.status === 'APPLIED' ? 'olive'
    : due.status === 'SCHEDULED' ? (due.effectiveDate <= today ? 'amber' : '') : '';
  host.className = 'modal-alert' + (tone ? ' ' + tone : '');
  host.innerHTML =
    'Rate batch <b>' + escapeHtml(due.ref) + '</b> · ' + statusPill(due.status) +
    ' · effective ' + escapeHtml(due.effectiveDate) +
    ' · ' + escapeHtml(due.branchCode || '') + (due.unitCount != null ? ' · ' + due.unitCount + ' units' : '') +
    ' <button class="tb-btn ghost" id="unitsRateBannerOpen" data-perm="facility-rate-strategy:view" type="button">Open rate strategy</button>';
  host.hidden = false;
  host.querySelector('#unitsRateBannerOpen')?.addEventListener('click', () => openRateStrategyVersion(due.versionId));
}

/** Jump from the Units banner/buttons back to the strategy workspace. */
export function openRateStrategyVersion(versionId) {
  if (versionId) {
    view.versionId = versionId;
    view.version = null; view.preview = null; view.previewError = null; view.liveDirty = false;
    view.validation = null; view.history = null; view.activity = null;
    view.previews = {}; view.planIds = null; view.plans = null;
  }
  try { location.hash = '#promotions'; } catch (e) { /* noop */ }
  const tab = document.querySelector('[data-tab="facility-rate-strategy"]');
  if (tab) tab.click();
  else refreshRateStrategy().catch(() => {});
}

/** Post-auth + tab-open entry (B-10): idempotent buttons + banner. */
export async function refreshUnitsRateEntry() {
  mountUnitsRateEntry();
  await refreshUnitsBatchBanner().catch(() => {});
}

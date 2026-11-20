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
  libraryOpen: false, // true after the Strategy library button
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
  // Reference parity (storelah-crm-leads v55 rate-strategy.js): the panel IS
  // the workspace — rs-head, decision banner, context row, KPI groups,
  // builder grid, duration cards, unit-rate table, history. The strategy
  // library is a secondary view reached from the "Strategy library" button.
  root.innerHTML = '<div id="rsBody"></div>';
  if (!root.dataset.rsDelegated) {
    root.dataset.rsDelegated = '1';
    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-rs-tip]');
      if (t && root.contains(t)) {
        e.preventDefault();
        e.stopPropagation();
        rsDefinition(t.dataset.rsTip);
        return;
      }
      const d = e.target.closest('[data-rs-duration]');
      if (d && root.contains(d)) {
        e.preventDefault();
        setDuration(Number(d.dataset.rsDuration), $('#rsBody'), root);
      }
    });
    root.addEventListener('keydown', (e) => {
      const d = e.target.closest && e.target.closest('.rs-duration-card[data-rs-duration]');
      if (d && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        setDuration(Number(d.dataset.rsDuration), $('#rsBody'), root);
      }
    });
  }
}

/** ? definition popup (reference: showModal("Definition", text)). */
function rsDefinition(text) {
  overlay(rsRoot || document.body, 'Definition', '<p style="margin:0">' + escapeHtml(text) + '</p>', '', async () => {}, { noConfirm: true });
}

function rsTip(label, text) {
  return label + ' <button class="rs-tip" type="button" aria-label="' + escapeHtml(text) + '" data-rs-tip="' + escapeHtml(text) + '">?</button>';
}

function rsMoney(n, d) {
  const dp = d == null ? 0 : d;
  return 'S$' + new Intl.NumberFormat('en-SG', { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(Number(n) || 0);
}

function rsNum(n) {
  return new Intl.NumberFormat('en-SG', { maximumFractionDigits: 0 }).format(Number(n) || 0);
}

function rsSigned(gap) {
  return (Number(gap) >= 0 ? '+' : '−') + 'S$' + Math.abs(Number(gap)).toFixed(2);
}

function rsDurationFilter(label, longLabels) {
  return '<div class="rs-duration-filter"><span>' + escapeHtml(label) + '</span><div>' + DURATIONS.map((t) =>
    '<button type="button" class="' + (view.duration === t ? 'active' : '') + '" data-rs-duration="' + t + '">' +
    t + (longLabels ? ' month' + (t === 1 ? '' : 's') : ' mo') + '</button>').join('') + '</div></div>';
}

function rsStatusMeta(status, dirty) {
  if (dirty) return { cls: 'amber', label: 'Unsaved changes' };
  if (status === 'ACTIVE' || status === 'APPROVED') return { cls: 'green', label: 'Active' };
  if (status === 'DRAFT') return { cls: 'grey', label: 'Draft' };
  if (status === 'SUPERSEDED') return { cls: 'grey', label: 'Superseded' };
  return { cls: 'grey', label: String(status || '—').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) };
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
  if (!view.versionId && !view.libraryOpen) {
    // Reference parity: the module opens straight into the workspace. Pick
    // the most recently updated Draft/Active strategy; fall back to the
    // library (with New strategy) when none exist yet.
    try {
      const rows = (await get('/rate-strategy/library')) || [];
      const live = rows.filter((r) => r.status === 'DRAFT' || r.status === 'ACTIVE' || r.status === 'APPROVED')
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      if (live.length) view.versionId = live[0].versionId;
    } catch (e) { /* library unreadable — the library page shows the error */ }
  }
  if (view.versionId) await renderShow(body, root);
  else await renderLibraryPage(body, root);
}

// B-2: the landing view is one scrolling page — library, then the live
// scheduler content, then the live settings content (§15.3: no tab split).
async function renderLibraryPage(body, root) {
  body.innerHTML =
    '<div class="rs-head"><div><div class="rs-eyebrow">Rates and Promotions · Pricing</div><h2>Strategy library</h2>' +
    '<p>Every rate strategy by facility and status. Open a version to edit it in the Master rate strategy workspace.</p></div>' +
    '<div class="rs-actions"><span class="pill blue">Administrator only</span>' +
    (can('facility-rate-strategy:create') ? '<button class="primary" type="button" data-rs-new data-perm="facility-rate-strategy:create">＋ New strategy</button>' : '') +
    '</div></div>' +
    '<div class="modal-alert" id="rsBanner" hidden></div>' +
    '<section class="card" style="margin-bottom:16px"><div class="card-head"><div><h3>Strategies</h3><small>Filter by facility or status, then open a version.</small></div></div><div class="card-body" id="rsLibSec"></div></section>' +
    '<section class="card" style="margin-bottom:16px"><div class="card-head"><div><h3>Rate batches</h3><small>Future-dated batches stay Scheduled until due — Apply due batches is idempotent and safe to repeat.</small></div></div><div class="card-body" id="rsSchedSec"></div></section>' +
    '<section class="card"><div class="card-body" id="rsSetSec"></div></section>';
  const nw = body.querySelector('[data-rs-new]');
  if (nw) nw.addEventListener('click', () => openCreateModal(root));
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
  view.libraryOpen = false;
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
  const st = rsStatusMeta(v.status, false);
  const btn = (perm, action, label, cls, disabled, title) => (can(perm)
    ? '<button class="' + (cls || 'btn') + '" type="button" data-rs-action="' + action + '" data-perm="' + perm + '"' +
      (disabled ? ' disabled' : '') + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + label + '</button>'
    : '');

  // Reference rs-head action order: Strategy library · Undo · Save draft ·
  // Duplicate for facility · Validate strategy · Apply rates to Units ·
  // primary. The reference's "Send for approval" primary is replaced by
  // "Set Active" (client 2026-11-20: no approval process).
  body.innerHTML =
    '<div class="rs-head"><div><div class="rs-eyebrow">Rates and Promotions · Pricing</div><h2>Master rate strategy</h2>' +
    '<p>Generate rack rates by size and unit attributes, then preview approved promotions by customer storage duration.</p></div>' +
    '<div class="rs-actions" id="rsActions"><span class="pill blue">Administrator only</span>' +
    '<span class="pill ' + st.cls + '" id="rsStatusPill">' + escapeHtml(st.label) + '</span>' +
    btn('facility-rate-strategy:view', 'library', 'Strategy library') +
    btn('facility-rate-strategy:update', 'undo', 'Undo', 'btn', true) +
    btn('facility-rate-strategy:update', 'save', 'Save draft', 'btn', !isDraft, isDraft ? '' : 'Only a Draft can be saved — duplicate this version to make changes.') +
    btn('facility-rate-strategy:create', 'duplicate', 'Duplicate for facility') +
    btn('facility-rate-strategy:view', 'validate', 'Validate strategy') +
    btn('facility-rate-strategy:update', 'sync-units', 'Apply rates to Units', 'btn', !isActive, isActive ? '' : 'Save the draft and set it Active first.') +
    btn('facility-rate-strategy:update', 'activate', isActive ? 'Active' : 'Set Active', 'primary', !isDraft, isDraft ? '' : 'This version is already ' + st.label + '.') +
    '</div></div>' +
    '<div class="modal-alert" id="rsBanner" hidden></div>' +
    '<div id="rsTargetBanner"></div>' +
    '<div class="rs-context" id="rsContext"></div>' +
    '<div class="rs-kpi-sections" id="rsKpis"><div class="section-empty">Calculating preview…</div></div>' +
    '<div class="rs-builder-grid">' +
    '<section class="card"><div class="card-head"><div><h3>1. Pricing workbench</h3><small>Adjust the levers and see the live rate curve, category impact and unit rates together.</small></div><span class="pill green">Recommended: smooth curve</span></div><div class="card-body">' +
    '<div class="rs-workbench-grid"><div class="rs-workbench-controls" id="rsLevers">' + leverEditHtml(v.levers, !isDraft) + '</div>' +
    '<div class="rs-live-chart" id="rsChart"><div class="section-empty">Calculating preview…</div></div></div>' +
    '<div id="rsCats"></div>' +
    guardrailsHtml(v.levers, !isDraft) +
    '</div></section>' +
    '<section class="card rs-promo-library"><div class="card-head"><div><h3>2. Discount &amp; Promotion library</h3><small>Every library record is shown. Active plans and Draft test plans can be selected for analysis; selecting a Draft does not approve or activate it.</small></div>' +
    '<div class="rs-plan-actions"><span class="pill green" id="rsPromoCount">Loading…</span><button class="btn" type="button" data-rs-action="promotions">Open promotion library</button></div></div><div class="card-body">' +
    '<div class="rs-promo-toolbar"><label><span>Percentage matrix to preview</span><select id="rsMatrix">' +
    '<option value="Standard"' + (view.matrix === 'Standard' ? ' selected' : '') + '>Standard unit</option>' +
    '<option value="Ground floor"' + (view.matrix === 'Ground floor' ? ' selected' : '') + '>Premium access / ground floor</option></select>' +
    '<small>This chooses the approved discount-matrix column; it does not change the rack-rate ground-floor factor above.</small></label></div>' +
    '<div class="rs-plan-grid" id="rsPromos"><div class="section-empty">Loading promotion library…</div></div></div></section>' +
    '</div>' +
    '<section class="card rs-duration-section"><div class="card-head"><div><h3>3. PSF by customer storage duration</h3><small>Select 1, 3, 6 or 12 months to update the chart and unit table.</small></div>' +
    '<div class="rs-psf-definitions"><span><b>Effective PSF:</b> recurring PSF after any percentage discount, once free months end.</span><span><b>Blended PSF:</b> shown only when free months apply.</span></div></div>' +
    '<div class="card-body rs-duration-grid" id="rsDurCards"><div class="section-empty">Calculating preview…</div></div></section>' +
    '<section class="card rs-table-card" id="rsPreview"><div class="section-empty">Calculating preview…</div></section>' +
    '<details class="rs-details"><summary><span><b>Version and change history</b><small>Drafts and activations remain auditable by facility and effective date</small></span><span id="rsHistCount">…</span></summary>' +
    '<div class="table-wrap" id="rsHistory"><div class="section-empty">Loading history…</div></div></details>' +
    '<details class="rs-details" id="rsValidationWrap"><summary><span><b>Validation</b><small>Warnings are display-only. Only red blockers prevent Set Active or Apply.</small></span><span>Expand</span></summary>' +
    '<div class="rs-details-body" id="rsValidation"><div class="section-empty">Run Validate strategy to check blockers and warnings.</div></div></details>' +
    '<details class="rs-details"><summary><span><b>Rate batches — this version</b><small>Apply rates to Units schedules a batch; occupied-customer rent is never touched</small></span><span>Expand</span></summary>' +
    '<div class="rs-details-body">' + (can('facility-rate-strategy:update') ? '<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn" type="button" id="rsVersionApplyDue" data-perm="facility-rate-strategy:update">Apply due batches</button></div>' : '') +
    '<div id="rsVersionBatches"><div class="section-empty">Loading batches…</div></div><div id="rsBatchDetail"></div></div></details>' +
    '<details class="rs-details"><summary><span><b>Activity</b><small>Rate-strategy and batch audit trail for this version</small></span><span>Expand</span></summary>' +
    '<div class="rs-details-body" id="rsActivity"><div class="section-empty">Loading activity…</div></div></details>' +
    '<details class="rs-details"><summary><span><b>Rate strategy defaults</b><small>Default rounding and manual-rate rule for new batches</small></span><span>Expand</span></summary>' +
    '<div class="rs-details-body" id="rsDetailSettings"></div></details>';

  body.querySelectorAll('[data-rs-action]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    rsAction(b.dataset.rsAction, root, b);
  }));
  const matrixSel = $('#rsMatrix');
  if (matrixSel) matrixSel.addEventListener('change', () => {
    view.matrix = matrixSel.value;
    view.previews = {};
    if (isDraft && view.liveDirty && hasLeverInputs()) scheduleLivePreview(root, true);
    else refreshWorkbench(root);
  });
  bindLeverInputs(root);

  loadPromos(root);
  loadHistory(root);
  loadActivity(root);
  loadVersionBatches(root);
  renderSettings($('#rsDetailSettings'), root);
  // Live chart on open — no Preview click needed.
  refreshWorkbench(root);
}

/** One dispatcher for every data-rs-action button (reference action()). */
function rsAction(name, root, el) {
  const v = view.version;
  if (name === 'library') openStrategyLibraryModal(root);
  else if (name === 'undo') undoLiveEdits(root);
  else if (name === 'save') saveInlineDraft(root);
  else if (name === 'duplicate') openDuplicateModal(root, v);
  else if (name === 'validate') runValidation(root);
  else if (name === 'sync-units') openBatchModal(root, v);
  else if (name === 'activate') activateStrategy(root, v);
  else if (name === 'zoom') openRsChartExpand();
  else if (name === 'promotions') {
    const tab = document.querySelector('#promotions [data-tab="promo-library"]');
    if (tab) { tab.click(); window.scrollTo(0, 0); }
  } else if (name === 'model') {
    const nav = document.querySelector('[data-side-page="billing"][data-side-panel="bill-pricing"]') ||
      document.querySelector('[data-side-page="billing"]');
    if (nav) nav.click();
  }
  return el;
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
  const categoryFloors = {};
  document.querySelectorAll('[data-rs-cf]').forEach((el) => {
    const raw = String(el.value || '').trim();
    if (raw !== '' && Number.isFinite(Number(raw))) categoryFloors[el.dataset.rsCf] = Number(raw);
  });
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
    ...(Object.keys(categoryFloors).length ? { categoryFloors } : {}),
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
    // The rs-decision banner already explains a missing target (and that
    // nothing is blocked) — no second banner.
    banner.hidden = true;
  } else if (errorMsg) {
    banner.hidden = false;
    banner.textContent = errorMsg;
  } else if (!view.previewError) {
    banner.hidden = true;
  }
}

function setLiveDirty(dirty) {
  view.liveDirty = dirty;
  const pill = $('#rsStatusPill');
  if (pill && view.version) {
    const st = rsStatusMeta(view.version.status, dirty);
    pill.className = 'pill ' + st.cls;
    pill.textContent = st.label;
  }
  const undoBtn = document.querySelector('[data-rs-action="undo"]');
  if (undoBtn) undoBtn.disabled = !dirty;
  // Apply rates to Units needs a saved Active version with no unsaved
  // changes; Set Active needs a saved Draft. Re-evaluated live.
  const isActive = view.version && (view.version.status === 'ACTIVE' || view.version.status === 'APPROVED');
  document.querySelectorAll('[data-rs-action="sync-units"]').forEach((b) => {
    const ok = isActive && !dirty;
    b.disabled = !ok;
    b.title = ok ? '' : (isActive ? 'Save or undo unsaved changes first.' : 'Save the draft and set it Active first.');
  });
  const activeBtn = document.querySelector('[data-rs-action="activate"]');
  if (activeBtn && view.version) {
    const ok = view.version.status === 'DRAFT' && !dirty;
    activeBtn.disabled = !ok;
    activeBtn.title = ok ? '' : (view.version.status !== 'DRAFT'
      ? 'This version is already ' + rsStatusMeta(view.version.status, false).label + '.'
      : 'Save the draft first — unsaved changes must be saved or undone before Set Active.');
  }
}

/** Persist the inline levers (PATCH draft) and repaint from saved state. */
async function saveInlineDraft(root) {
  const v = view.version;
  if (!v || v.status !== 'DRAFT') return;
  const btn = document.querySelector('[data-rs-action="save"]');
  if (btn) btn.disabled = true;
  try {
    const levers = readInlineLevers();
    await patch('/rate-strategy/' + encodeURIComponent(v.id), { version: v.version, levers });
    showBanner('Draft saved — you can now Set Active.', true);
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
    host.innerHTML = leverEditHtml(view.version.levers, view.version.status !== 'DRAFT');
  }
  const guard = document.querySelector('.rs-workbench-guardrails');
  if (guard && view.version) guard.outerHTML = guardrailsHtml(view.version.levers, view.version.status !== 'DRAFT');
  bindLeverInputs(root);
  setLiveDirty(false);
  view.previews = {};
  await refreshWorkbench(root);
}

/** Wire every inline lever: typing/dragging recalculates live; the curve
 *  slider and its number box stay in sync; the method toggle swaps the
 *  handoff helper copy. */
function bindLeverInputs(root) {
  const scope = $('#rsBody');
  if (!scope || !hasLeverInputs()) return;
  scope.querySelectorAll('[data-rs-lever], [data-rs-cf]').forEach((el) => {
    if (el.dataset.rsLiveBound) return;
    el.dataset.rsLiveBound = '1';
    el.addEventListener('input', () => {
      if (el.dataset.rsLever === 'curveStrength') {
        const lbl = $('#rsl-curveVal');
        if (lbl) lbl.textContent = Number(el.value).toFixed(2);
      }
      scheduleLivePreview(root, false);
    });
    el.addEventListener('change', () => {
      if (el.dataset.rsLever === 'method') {
        const m = el.value === 'STEP' ? 'STEP' : 'SMOOTH';
        scope.querySelectorAll('[data-rs-method-only]').forEach((x) => { x.hidden = x.dataset.rsMethodOnly !== m; });
        const help = $('#rsl-methodHelp');
        if (help) help.innerHTML = RS_METHOD_HELP[m];
      }
      scheduleLivePreview(root, false);
    });
  });
}

/** Synchronised 1/3/6/12 filter — every duration toolbar (workbench +
 *  unit-rate table) and the duration cards follow one value (§15.12). */
function setDuration(d, body, root) {
  if (!DURATIONS.includes(d)) return;
  view.duration = d;
  view.kpiDuration = d;
  document.querySelectorAll('#rateStrategyRoot [data-rs-duration]').forEach((x) => {
    x.classList.toggle('active', Number(x.dataset.rsDuration) === d);
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
  return leverEditHtml(l, true);
}

// B-4: editable workbench beside the live chart (v55 §15.8, handoff §15.9).
// Draft only. Every lever carries a ? tooltip with the handoff §15.8 Meaning
// copy; the method helper paragraphs are the handoff §15.9 product copy
// verbatim. Every keystroke/drag recalculates live (debounced unsaved
// preview) — no modal, no Preview click. Save draft persists via PATCH.
const RS_METHOD_HELP = {
  SMOOTH: '<b>Smooth size curve:</b> PSF falls gradually as size increases, giving every square foot a continuous rate. Best for a clean, consistent pricing curve.',
  STEP: '<b>Excel-style step-down:</b> PSF drops by a fixed amount after each size interval. Best when you want to mirror a traditional rate table.',
};

function leverEditHtml(l, locked) {
  const v = l || {};
  const pct = (x) => (x == null ? '' : Math.round(Number(x) * 1000) / 10);
  const method = v.method === 'STEP' ? 'STEP' : 'SMOOTH';
  const curve = Number(v.curveStrength ?? 0.2);
  const dis = locked ? ' disabled' : '';
  const field = (id, label, val, unit, attrs, extra, only) =>
    '<label' + (only ? ' data-rs-method-only="' + only + '"' + (only !== method ? ' hidden' : '') : '') + '><span>' + label + '</span>' +
    '<div class="rs-suffix"><input type="number" data-rs-lever="' + id + '" value="' + escapeHtml(String(val ?? '')) + '"' + attrs + dis + '><em>' + unit + '</em></div>' +
    (extra || '') + '</label>';
  return '<div class="rs-form-grid">' +
    field('referenceSize', rsTip('Reference size', 'The anchor unit used to set the first monthly rack rate. Other sizes are calculated from this point.'), v.referenceSize, 'sq ft', ' min="1" step="1"') +
    field('startingRate', rsTip('Starting monthly rack rate', 'The pre-promotion monthly rate for the reference size. For example, S$90 for 10 sq ft means a starting rack PSF of S$9.00.'), v.startingRate, 'SGD', ' min="1" step="1"') +
    '<label><span>' + rsTip('Pricing method', 'Smooth curve gradually reduces PSF for every size. Excel-style step-down lowers PSF by a fixed amount at each chosen size interval.') + '</span>' +
    '<select data-rs-lever="method"' + dis + '><option value="SMOOTH"' + (method === 'SMOOTH' ? ' selected' : '') + '>Smooth size curve · recommended</option>' +
    '<option value="STEP"' + (method === 'STEP' ? ' selected' : '') + '>Excel-style step-down</option></select>' +
    '<small class="rs-method-help" id="rsl-methodHelp">' + RS_METHOD_HELP[method] + '</small></label>' +
    '<label data-rs-method-only="SMOOTH"' + (method !== 'SMOOTH' ? ' hidden' : '') + '><span>' + rsTip('Curve strength', 'Controls how quickly PSF falls as unit size increases. 0 keeps one PSF; a higher value gives larger units a lower PSF.') + '</span>' +
    '<div class="rs-range"><input type="range" min="0" max="0.6" step="0.01" data-rs-lever="curveStrength" value="' + escapeHtml(String(curve)) + '"' + dis + '><b id="rsl-curveVal">' + curve.toFixed(2) + '</b></div></label>' +
    field('stepEvery', 'Reduce PSF every', v.stepEvery, 'sq ft', ' min="1" step="1"', '', 'STEP') +
    field('stepPsf', 'PSF reduction per step', v.stepPsf, 'SGD', ' min="0" step="0.05"', '', 'STEP') +
    field('psfFloor', rsTip('Rack PSF floor', 'The curve may not generate a rack PSF below this amount. Promotion effects are checked separately.'), v.psfFloor, 'SGD', ' min="0" step="0.05"') +
    field('minMonthly', 'Minimum monthly rack rent', v.minMonthly, 'SGD', ' min="0" step="1"') +
    field('lockerAdj', rsTip('Locker unit adjustment', 'Signed factor applied to half-height locker units. Use a negative value for a discount or positive value for a premium.'), pct(v.lockerAdj), '%', ' min="-95" max="100" step="0.5"', '<small>Example: −25% discounts a locker; +10% adds a premium.</small>') +
    field('groundFloorAdj', rsTip('Ground-floor adjustment', 'Signed factor for units flagged as ground floor or premium access in Facilities · Units.'), pct(v.groundFloorAdj), '%', ' min="-95" max="100" step="0.5"') +
    field('restrictedAdj', rsTip('Restricted-access adjustment', 'Signed factor for units with an access limitation such as an obstruction or awkward approach.'), pct(v.restrictedAdj), '%', ' min="-95" max="100" step="0.5"') +
    field('facilityAdj', rsTip('Facility-wide rate adjustment', 'Optional uplift or discount for a facility’s location, access or positioning. Use size overrides for exceptions that apply to only one size.'), pct(v.facilityAdj), '%', ' min="-50" max="100" step="0.5"') +
    '<label><span>Round monthly rate to nearest</span><select data-rs-lever="rounding"' + dis + '>' +
    [1, 5, 10].map((r) => '<option value="' + r + '"' + (Number(v.rounding) === r ? ' selected' : '') + '>S$' + r + '</option>').join('') + '</select></label>' +
    '</div>';
}

const RS_CAT_DEFS = [
  { key: 'LOCKER', label: 'Locker', range: '8–15 sq ft · half-height', min: 8, max: 15 },
  { key: 'XS', label: 'XS', range: '10–19 sq ft', min: 10, max: 19 },
  { key: 'S', label: 'S', range: '20–39 sq ft', min: 20, max: 39 },
  { key: 'M', label: 'M', range: '40–69 sq ft', min: 40, max: 69 },
  { key: 'L', label: 'L', range: '70–99 sq ft', min: 70, max: 99 },
  { key: 'XL', label: 'XL', range: '100–150 sq ft', min: 100, max: 150 },
];

/** Reference guardrailsMarkup(): category floors are editable here (Draft). */
function guardrailsHtml(l, locked) {
  const v = l || {};
  const cf = v.categoryFloors || {};
  const dis = locked ? ' disabled' : '';
  return '<details class="rs-details rs-workbench-guardrails"><summary><span><b>Advanced guardrails</b><small>Category floors, total-rate progression and activation controls</small></span><span>Expand</span></summary>' +
    '<div class="rs-details-body"><div class="rs-floor-panel"><div><b>Minimum rack PSF by size category</b><span>The higher of the overall floor and category floor is applied before rounding.</span></div>' +
    '<div class="rs-floor-grid">' + RS_CAT_DEFS.map((d) =>
      '<label><span>' + escapeHtml(d.label + ' · ' + d.range) + '</span><div class="rs-suffix"><input type="number" min="0" step="0.05" data-rs-cf="' + d.key + '" value="' +
      (cf[d.key] == null ? '' : Number(cf[d.key]).toFixed(2)) + '"' + dis + '><em>SGD</em></div></label>').join('') + '</div></div>' +
    '<div class="rs-guard-grid">' +
    '<div class="rs-guard"><i>✓</i><div><b>Overall rack PSF floor</b><span>' + fmtPsf(v.psfFloor) + ' before promotions. Below-floor overrides are blocked.</span></div></div>' +
    '<div class="rs-guard"><i>✓</i><div><b>Total-rate progression</b><span>Larger units are checked so total monthly rent does not accidentally fall below a smaller unit.</span></div></div>' +
    '<div class="rs-guard"><i>✓</i><div><b>Financial Model is benchmark-only</b><span>The Financial Model Effective PSF target is read here but is never overwritten.</span></div></div>' +
    '<div class="rs-guard"><i>✓</i><div><b>Promotions remain separately controlled</b><span>Rules are edited in Rates and Promotions; this page only previews eligible Active plans.</span></div></div>' +
    '</div></div></details>';
}

function renderRsContext() {
  const host = $('#rsContext');
  if (!host || !view.version) return;
  const v = view.version;
  const sum = view.preview && view.preview.preview && view.preview.preview.summary;
  const tgt = view.preview && view.preview.target;
  const isDraft = v.status === 'DRAFT';
  const lastBatch = (view.batches || [])[0];
  host.innerHTML =
    '<label><span>Facility</span><select id="rsCtxFacility">' + (state.branches || []).map((b) =>
      '<option value="' + escapeHtml(b.id) + '"' + (b.id === v.branchId ? ' selected' : '') + '>' + escapeHtml(b.name || b.code) + '</option>').join('') + '</select></label>' +
    '<label><span>Strategy name</span><input id="rsCtxName" value="' + escapeHtml(v.strategyName) + '" readonly title="Set when the strategy is created"></label>' +
    '<label><span>Effective from</span><input type="date" id="rsCtxDate" value="' + escapeHtml(v.effectiveFrom || '') + '"' + (isDraft ? '' : ' disabled') + '></label>' +
    '<div><span>Inventory source</span><b>Facilities · Units</b><small>' + (sum ? rsNum(sum.totalUnits) + ' units · ' + rsNum(sum.totalNla) + ' sq ft NLA · ' : '') +
    (lastBatch ? 'rates ' + escapeHtml(String(lastBatch.status).replace(/_/g, ' ').toLowerCase()) : 'rates not applied') + '</small></div>' +
    '<div><span>Target source</span>' + (tgt && tgt.targetPsf != null
      ? '<b>' + fmtPsf(tgt.targetPsf) + ' approved PSF</b><small>' + escapeHtml((tgt.modelName || 'Financial Model') + (tgt.modelVersion != null ? ' · v' + tgt.modelVersion : '')) + '</small>'
      : '<b>Unavailable</b><small>No CURRENT Financial Model linked</small>') + '</div>';
  const fac = $('#rsCtxFacility');
  if (fac) fac.addEventListener('change', () => switchFacility(fac.value));
  const date = $('#rsCtxDate');
  if (date && isDraft) date.addEventListener('change', async () => {
    try {
      await patch('/rate-strategy/' + encodeURIComponent(v.id), { version: v.version, effectiveFrom: date.value });
      showBanner('Effective date saved', true);
      await refreshShow(rsRoot);
    } catch (e) { rsError(rsRoot, e); }
  });
}

/** Facility select: open that facility's latest Draft/Active strategy, or
 *  start a new one for it when none exists yet. */
async function switchFacility(branchId) {
  const root = rsRoot;
  try {
    const rows = (await get('/rate-strategy/library?branchId=' + encodeURIComponent(branchId))) || [];
    const live = rows.filter((r) => r.status === 'DRAFT' || r.status === 'ACTIVE' || r.status === 'APPROVED')
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    if (live.length) {
      view.versionId = live[0].versionId;
      view.previews = {}; view.planIds = null; view.plans = null;
      await renderShow($('#rsBody'), root);
    } else {
      view.branchFilter = branchId;
      openCreateModal(root);
      renderRsContext();
    }
  } catch (e) { rsError(root, e); }
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
  const d = view.duration;
  const basePayload = (view.previews && view.previews[12]) || view.preview;
  const promoPayload = (view.previews && view.previews[d]) || view.preview;
  const base = basePayload && basePayload.preview && basePayload.preview.summary;
  const promo = promoPayload && promoPayload.preview && promoPayload.preview.summary;
  if (!base || !promo) {
    host.innerHTML = '<div class="section-empty">Calculating preview…</div>';
    return;
  }
  const rows = (basePayload.preview.rows || []);
  const hasFree = !!promo.hasBlended && promo.weightedBlendedPsf != null;
  const noTarget = view.noTarget || promo.gapVsTarget == null;
  const gapClass = noTarget ? 'warn' : (Number(promo.gapVsTarget) >= -0.005 ? 'good' : 'warn');
  host.innerHTML =
    '<section class="rs-kpi-group fixed"><header><b>Base rack-rate strategy</b><span>These values do not change when you preview another promotion.</span></header><div class="rs-kpis">' +
    '<div><small>Facility sizes</small><strong>' + rsNum(base.stockedSizeCount) + '</strong><span>' + rsNum(rows.length) + ' one-sq-ft rate points available</span></div>' +
    '<div><small>' + rsTip('Rack rent potential', 'Monthly rent at 100% occupancy before any promotion, using every available unit.') + '</small><strong>' + rsMoney(base.rackPotential) + '</strong><span>per month · 100% occupied</span></div>' +
    '<div><small>' + rsTip('Weighted rack PSF', 'Total monthly rack rent divided by total available unit square feet.') + '</small><strong>' + fmtPsf(base.weightedRackPsf) + '</strong><span>before promotion</span></div>' +
    '</div></section>' +
    '<section class="rs-kpi-group scenario"><header><div><b>' + d + '-month promotion preview</b><span>Rack rates stay fixed; these values reflect only the selected library plans.</span></div>' +
    rsDurationFilter('Preview duration', false) + '</header><div class="rs-kpis ' + (hasFree ? '' : 'two') + '">' +
    '<div><small>' + rsTip('Effective PSF after free period', 'The recurring PSF after any percentage discount. Once the free-month period ends, this is the monthly PSF that resumes.') + '</small><strong>' + fmtPsf(promo.weightedEffectivePsf) + '</strong><span>ongoing monthly rate</span></div>' +
    (hasFree ? '<div><small>' + rsTip('Blended PSF', 'Total rent payable over the commitment divided evenly across its months. Free months reduce this figure during the offer term.') + '</small><strong>' + fmtPsf(promo.weightedBlendedPsf) + '</strong><span>includes applicable free months</span></div>' : '') +
    '<div class="' + gapClass + '"><small>' + rsTip('Effective PSF vs target', 'Recurring Effective PSF after the approved percentage discount, minus the Financial Model PSF target. Free months do not change this comparison.') + '</small><strong>' +
    (noTarget ? '—' : rsSigned(promo.gapVsTarget)) + '</strong><span>' + (noTarget ? 'Target unavailable' : gapClass === 'good' ? 'Meets target' : 'Below target') + '</span></div>' +
    '</div></section>';
}

/** Promotion-preview toggle only: switches Effective/Blended/vs-target
 *  without touching the workbench duration, chart, categories or unit
 *  table. Uses the cached all-duration previews — no extra fetch. */
function setKpiDuration(d) {
  setDuration(d, $('#rsBody'), rsRoot);
}

function renderRsTargetBanner() {
  const host = $('#rsTargetBanner');
  if (!host) return;
  const d = view.duration;
  const p = view.previews && view.previews[d];
  const sum = p && p.preview && p.preview.summary;
  const tgt = p && p.target;
  if (!sum) { host.innerHTML = ''; return; }
  if (!tgt || tgt.targetPsf == null || sum.gapVsTarget == null) {
    host.innerHTML = '<div class="rs-decision warn"><div><b>Financial Model target unavailable</b><span>No CURRENT Financial Model is linked for this facility — rack rates still preview and target comparisons show as unavailable. Save draft, Set Active and Apply rates to Units are not blocked.</span></div>' +
      '<button class="btn" type="button" data-rs-action="model">Open Financial Model pricing</button></div>';
  } else {
    const gap = Number(sum.gapVsTarget);
    const meets = gap >= -0.005;
    const v = view.version || {};
    const refSize = Number(v.levers && v.levers.referenceSize) || 10;
    const startRate = Number(v.levers && v.levers.startingRate) || 0;
    const required = startRate + Math.max(0, -gap) * refSize;
    const uplift = startRate ? (required / startRate - 1) * 100 : 0;
    const detail = meets
      ? 'Recurring Effective PSF is ' + fmtPsf(sum.weightedEffectivePsf) + (Math.abs(gap) < 0.005 ? ', exactly matching the target' : ', S$' + Math.abs(gap).toFixed(2) + ' above target') + '. ' +
        (sum.hasBlended ? 'Blended PSF is shown separately to reveal the cost of free months.' : 'No free-month benefit applies at this duration, so Blended PSF is not shown.')
      : 'Recurring Effective PSF is ' + fmtPsf(sum.weightedEffectivePsf) + '. Raise the ' + refSize + ' sq ft anchor from ' + rsMoney(startRate) + ' to about ' + rsMoney(required) + ' (' + uplift.toFixed(1) + '%), or review the approved percentage discount.';
    host.innerHTML = '<div class="rs-decision ' + (meets ? 'good' : 'warn') + '"><div><b>' + d + '-month Effective PSF ' + (meets ? 'meets the approved target' : 'is below the approved target') + '</b><span>' + escapeHtml(detail) + '</span></div>' +
      '<button class="btn" type="button" data-rs-action="model">Open Financial Model pricing</button></div>';
  }
  const b = host.querySelector('[data-rs-action]');
  if (b) b.addEventListener('click', (e) => { e.preventDefault(); rsAction('model', rsRoot, b); });
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
      ? 'Financial Model target unavailable for this facility — rack rates still preview; Save draft, Set Active and Apply rates to Units are not blocked.'
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
  paintPromoCount();
}

// ---- live chart (same inline-SVG approach as the finance screens:
// fm-chart/fm-legend/fm-chart-tooltip classes, no new dependency) ----
const RS_SERIES = [
  { key: 'rack', label: 'Rack PSF', color: '#526557', get: (r) => r.rackPsf },
  { key: 'eff', label: 'Effective PSF', color: '#2a9d8f', get: (r) => r.effectivePsf },
  { key: 'blend', label: 'Blended PSF', color: '#c97952', get: (r) => (r.hasBlended ? r.blendedPsf : null) },
];

function rsChartSvg(plotted, targetPsf, hasBlended) {
  // Reference chart(): 820×430 viewBox, fixed 8–150 sq ft X axis, S$0.50 Y
  // grid, rack/effective(/blended) polylines + points, dashed target line.
  const width = 820, height = 430, left = 68, right = 22, top = 24, bottom = 44;
  const minX = 8, maxX = 150;
  const values = [];
  plotted.forEach((r) => { values.push(r.rackPsf, r.effectivePsf); if (hasBlended) values.push(r.blendedPsf); });
  if (targetPsf != null) values.push(Number(targetPsf));
  const finite = values.filter(Number.isFinite);
  const minY = Math.max(0, Math.floor((Math.min.apply(null, finite) - 0.5) * 2) / 2);
  const maxY = Math.ceil((Math.max.apply(null, finite) + 0.5) * 2) / 2;
  const x = (val) => left + ((val - minX) / Math.max(1, maxX - minX)) * (width - left - right);
  const y = (val) => top + ((maxY - val) / Math.max(0.1, maxY - minY)) * (height - top - bottom);
  const pts = (get) => plotted.map((r) => x(r.size).toFixed(1) + ',' + y(get(r)).toFixed(1)).join(' ');
  const ticks = [];
  for (let i = 0; i <= Math.round((maxY - minY) / 0.5); i++) ticks.push(minY + i * 0.5);
  const grid = ticks.map((val) => '<g><line x1="' + left + '" y1="' + y(val) + '" x2="' + (width - right) + '" y2="' + y(val) + '"/><text x="' + (left - 10) + '" y="' + (y(val) + 4) + '" text-anchor="end">S$' + val.toFixed(2) + '</text></g>').join('');
  const pointRows = plotted.filter((r) => r.stocked);
  const points = (get, monthly, cls, label) => pointRows.map((r) =>
    '<circle class="' + cls + '" cx="' + x(r.size).toFixed(1) + '" cy="' + y(get(r)).toFixed(1) + '" r="4.5" tabindex="0"><title>' +
    r.size + ' sq ft · ' + label + ' S$' + Number(get(r)).toFixed(2) + ' · ' + rsMoney(monthly(r), 2) + '/month</title></circle>').join('');
  const target = targetPsf != null
    ? '<line class="rs-target" x1="' + left + '" y1="' + y(targetPsf) + '" x2="' + (width - right) + '" y2="' + y(targetPsf) + '"/>' +
      '<text class="rs-target-label" x="' + (width - right) + '" y="' + (y(targetPsf) - 8) + '" text-anchor="end">Financial Model target S$' + Number(targetPsf).toFixed(2) + '</text>'
    : '';
  return '<div class="rs-chart-wrap"><svg class="rs-chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Rack and effective PSF' + (hasBlended ? ', plus blended PSF after free months' : '') + ' by unit size">' +
    '<g class="rs-grid">' + grid + '</g>' + target +
    '<polyline class="rs-rack-line" points="' + pts((r) => r.rackPsf) + '"/>' +
    '<polyline class="rs-net-line" points="' + pts((r) => r.effectivePsf) + '"/>' +
    (hasBlended ? '<polyline class="rs-effective-line" points="' + pts((r) => r.blendedPsf) + '"/>' : '') +
    points((r) => r.rackPsf, (r) => r.rackMonthly, 'rs-rack-point', 'Rack PSF') +
    points((r) => r.effectivePsf, (r) => r.effectiveMonthly, 'rs-net-point', 'Effective PSF') +
    (hasBlended ? points((r) => r.blendedPsf, (r) => r.blendedMonthly, 'rs-effective-point', 'Blended PSF') : '') +
    '<text x="' + left + '" y="' + (height - 12) + '">' + minX + ' sq ft</text><text x="' + (width - right) + '" y="' + (height - 12) + '" text-anchor="end">' + maxX + ' sq ft</text></svg></div>' +
    '<div class="rs-legend"><span><i class="rack"></i>Rack PSF</span><span><i class="net"></i>Effective PSF</span>' +
    (hasBlended ? '<span><i class="effective"></i>' + view.duration + '-month Blended PSF</span>' : '') +
    (targetPsf != null ? '<span><i class="target"></i>Financial Model target</span>' : '') + '</div>';
}

function rsChartRows() {
  const all = ((view.preview && view.preview.preview.rows) || []).slice().sort((a, b) => a.size - b.size);
  return view.range === 'all'
    ? all.filter((r) => r.size >= view.rangeFrom && r.size <= view.rangeTo)
    : all.filter((r) => r.stocked);
}

function rsBindChartHover() {
  // Reference chart uses native <title> tooltips on each point — nothing to bind.
}

function renderRsChart() {
  const host = $('#rsChart');
  if (!host || !view.preview) return;
  const plotted = rsChartRows();
  const hasBlended = plotted.some((r) => r.hasBlended);
  const targetPsf = view.preview.target && view.preview.target.targetPsf;
  const d = view.duration;
  host.innerHTML = '<div class="rs-live-chart-head"><div><b>Live rate curve · ' + d + ' month' + (d === 1 ? '' : 's') + '</b><small>' +
    (hasBlended ? 'Rack, Effective and Blended PSF' : 'Rack and Effective PSF') + ' across the commercial 8–150 sq ft range</small></div>' +
    '<button class="btn rs-small" type="button" id="rsChartExpand">Expand</button></div>' +
    (plotted.length ? rsChartSvg(plotted, targetPsf, hasBlended) : '<div class="rs-empty">No facility sizes are linked yet.</div>');
  const expand = $('#rsChartExpand');
  if (expand) expand.addEventListener('click', () => openRsChartExpand());
}

/** B-5 Expand: the same inline-SVG chart at finance-screen large size in
 *  the workspace overlay (B-1 scroll guard), closed by Close/X/backdrop —
 *  the inline chart underneath is untouched so state restores as-is. */
function openRsChartExpand() {
  if (!view.preview) return;
  const plotted = rsChartRows();
  if (!plotted.length) return;
  const hasBlended = plotted.some((r) => r.hasBlended);
  const targetPsf = view.preview.target && view.preview.target.targetPsf;
  overlay(rsRoot || document.body, 'Live rate curve · ' + view.duration + ' month' + (view.duration === 1 ? '' : 's'),
    '<div class="rs-live-chart">' + rsChartSvg(plotted, targetPsf, hasBlended) + '</div>',
    '', async () => {}, { size: 'wide', noConfirm: true,
      subtitle: (hasBlended ? 'Rack, Effective and Blended PSF' : 'Rack and Effective PSF') + ' across the commercial 8–150 sq ft range' });
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
  const all = view.preview.preview.rows || [];
  const s = view.preview.preview.summary || {};
  const stockedSizes = all.filter((r) => r.stocked).length;
  const hasBlended = all.some((r) => r.stocked && r.hasBlended);
  const range = (list, get) => {
    const vs = list.map(get).filter(Number.isFinite);
    return vs.length ? 'S$' + Math.min.apply(null, vs).toFixed(2) + '–S$' + Math.max.apply(null, vs).toFixed(2) : '—';
  };
  const cats = RS_CAT_DEFS.map((d) => {
    const inCat = all.filter((r) => r.category === d.key);
    const stocked = inCat.filter((r) => r.stocked);
    return {
      ...d,
      units: stocked.reduce((a, r) => a + r.unitCount, 0),
      area: stocked.reduce((a, r) => a + r.size * r.unitCount, 0),
      rack: stocked.reduce((a, r) => a + r.rackMonthly * r.unitCount, 0),
      net: stocked.reduce((a, r) => a + r.effectiveMonthly * r.unitCount, 0),
      rackRange: range(inCat, (r) => r.rackPsf),
      netRange: range(inCat, (r) => r.effectivePsf),
    };
  });
  const lv = (view.version && view.version.levers) || {};
  const refSize = Math.max(1, Number(lv.referenceSize) || 10);
  const refRow = all.find((r) => r.size === refSize);
  const rounding = Number(lv.rounding) || 1;
  const adj = (factor) => {
    if (!refRow) return null;
    const monthly = Math.max(Number(lv.minMonthly) || 0, Math.round((refRow.rackMonthly * (1 + factor)) / rounding) * rounding);
    return { monthly, psf: monthly / refSize };
  };
  const pctNote = (f) => (Number(f) >= 0 ? '+' : '') + (Number(f || 0) * 100).toFixed(1) + '%';
  const examples = [
    { label: 'Standard', note: 'No unit factor', row: adj(0) },
    { label: 'Locker', note: pctNote(lv.lockerAdj), row: adj(Number(lv.lockerAdj) || 0) },
    { label: 'Ground floor', note: pctNote(lv.groundFloorAdj), row: adj(Number(lv.groundFloorAdj) || 0) },
    { label: 'Restricted access', note: pctNote(lv.restrictedAdj), row: adj(Number(lv.restrictedAdj) || 0) },
  ];
  host.innerHTML =
    '<div class="rs-subsection-head"><div><h4>Size categories and live rate outcomes</h4><p>Facility availability comes from Facilities · Units. Net PSF ranges and rent potential recalculate for the selected storage duration.</p></div>' +
    '<div class="rs-subsection-actions"><div class="rs-duration-filter rs-category-duration"><span>Storage duration</span><div>' + DURATIONS.map((t) =>
      '<button type="button" class="' + (view.duration === t ? 'active' : '') + '" data-rs-duration="' + t + '">' + t + ' mo</button>').join('') + '</div></div>' +
    '<span class="pill blue">' + stockedSizes + ' available sizes</span></div></div>' +
    '<div class="table-wrap"><table class="rs-category-table"><thead><tr><th>Category</th><th>Size range</th><th>Facility NLA</th><th>Units</th><th>Rack PSF range</th>' +
    '<th>' + rsTip('Net PSF range', 'The recurring Effective PSF range after the selected percentage promotions. Free months are excluded because rent returns to this rate after the free period.') + '</th>' +
    '<th>Monthly rack potential</th><th>' + rsTip('Monthly Net Rent Potential', 'Recurring monthly rent from all stocked units after selected percentage promotions, at 100% occupancy. Free-month spreading is not deducted.') + '</th></tr></thead><tbody>' +
    cats.map((c) => '<tr><td><b>' + escapeHtml(c.label) + '</b></td><td>' + escapeHtml(c.range) + '</td><td>' + (c.area ? rsNum(c.area) + ' sq ft' : '—') + '</td><td>' + (c.units || '—') + '</td>' +
      '<td><b>' + c.rackRange + '</b></td><td><b>' + c.netRange + '</b></td><td>' + (c.units ? rsMoney(c.rack) : 'Not stocked') + '</td><td>' + (c.units ? rsMoney(c.net) : 'Not stocked') + '</td></tr>').join('') +
    '</tbody></table></div>' +
    '<div class="rs-category-totals">' +
    '<div><small>Total facility NLA</small><b>' + rsNum(s.totalNla) + ' sq ft</b></div>' +
    '<div><small>Total units</small><b>' + rsNum(s.totalUnits) + '</b></div>' +
    '<div><small>' + rsTip('Weighted-average Rack PSF', 'Total monthly rack rent divided by total stocked facility square feet.') + '</small><b>' + fmtPsf(s.weightedRackPsf) + '</b></div>' +
    '<div><small>' + rsTip('Weighted-average Net PSF', 'Total recurring Effective/Net rent after percentage promotions divided by total stocked facility square feet.') + '</small><b>' + fmtPsf(s.weightedEffectivePsf) + '</b></div>' +
    (hasBlended && s.weightedBlendedPsf != null ? '<div><small>' + rsTip('Weighted-average Blended PSF', 'Total rent across the selected commitment, including free months, divided by months and stocked facility square feet.') + '</small><b>' + fmtPsf(s.weightedBlendedPsf) + '</b></div>' : '') +
    '<div><small>Total monthly Rack Rent Potential</small><b>' + rsMoney(s.rackPotential) + '</b></div>' +
    '<div><small>Total monthly Net Rent Potential</small><b>' + rsMoney(s.netPotential) + '</b></div>' +
    '</div>' +
    '<div class="rs-subsection-head compact"><div><h4>Attribute-adjusted example at ' + refSize + ' sq ft</h4><p>These examples isolate each factor. Actual unit rates change only when that attribute is tagged in Facilities · Units.</p></div></div>' +
    '<div class="rs-adjustment-examples">' + examples.map((e) => '<div><span>' + escapeHtml(e.label) + '</span><strong>' + (e.row ? rsMoney(e.row.monthly, 2) : '—') + '</strong><b>' +
      (e.row ? 'S$' + e.row.psf.toFixed(2) + ' PSF' : '—') + '</b><small>' + escapeHtml(e.note) + '</small></div>').join('') + '</div>';
}

// ---- duration cards (§15.9: one card per 1/3/6/12 month commitment) ----
function renderRsDurCards(root) {
  const host = $('#rsDurCards');
  if (!host) return;
  host.innerHTML = DURATIONS.map((d) => {
    const p = view.previews[d];
    const sum = p && p.preview.summary;
    const sel = d === view.duration;
    const hasFree = !!(sum && sum.hasBlended && sum.weightedBlendedPsf != null);
    const noTarget = !sum || sum.gapVsTarget == null;
    const freeRow = hasFree && (p.preview.rows || []).find((r) => r.stocked && r.freeMonths > 0);
    return '<div role="button" tabindex="0" class="rs-duration-card ' + (sel ? 'active' : '') + '" data-rs-duration="' + d + '">' +
      '<div><span>' + d + ' month' + (d === 1 ? '' : 's') + '</span>' + (sel ? '<b class="pill blue">Detailed view</b>' : '') + '</div>' +
      (!sum ? '<small>Not loaded</small>' :
        '<dl><div><dt>Rack PSF</dt><dd>' + fmtPsf(sum.weightedRackPsf) + '</dd></div>' +
        '<div><dt>' + rsTip('Effective PSF', 'Recurring PSF after percentage discounts. This is the value compared with the Financial Model target.') + '</dt><dd>' + fmtPsf(sum.weightedEffectivePsf) + '</dd></div>' +
        (hasFree ? '<div><dt>' + rsTip('Blended PSF', 'Total rent payable over this commitment divided evenly across every month. Free months reduce this value.') + '</dt><dd>' + fmtPsf(sum.weightedBlendedPsf) + '</dd></div>' : '') +
        '<div><dt>Effective vs target</dt><dd class="' + (noTarget ? '' : Number(sum.gapVsTarget) >= -0.005 ? 'good-text' : 'warn-text') + '">' + (noTarget ? '—' : rsSigned(sum.gapVsTarget)) + '</dd></div></dl>' +
        '<small>' + (hasFree
          ? 'Includes ' + (freeRow ? freeRow.freeMonths : '') + ' free month' + (freeRow && freeRow.freeMonths === 1 ? '' : 's') + ' for eligible sizes; target comparison still uses recurring Effective PSF.'
          : Number(sum.weightedEffectivePsf) >= Number(sum.weightedRackPsf) - 0.005 ? 'No active ' + d + '-month percentage rule; rack rate applies.' : 'No free-month benefit applies at this duration, so Blended PSF is not shown.') + '</small>') +
      '</div>';
  }).join('');
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
    host.innerHTML = '<div class="rs-empty" style="grid-column:1/-1">No promotion plans exist yet — create one in Rates and Promotions › Discount plan builder or Free months.</div>';
    paintPromoCount();
    return;
  }
  const order = (p) => (p.kind === 'DISCOUNT_MATRIX' ? 0 : p.kind === 'FREE_MONTHS' ? 1 : 2);
  const plans = view.plans.slice().sort((a, b) => order(a) - order(b));
  host.innerHTML = plans.map((p) => {
    const recurring = p.kind === 'DISCOUNT_MATRIX' || p.kind === 'FREE_MONTHS';
    const selectable = recurring && (p.status === 'ACTIVE' || p.status === 'DRAFT');
    const selected = selectable && sel.includes(p.id);
    const statusLabel = String(p.status || '—').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
    const statusClass = p.status === 'ACTIVE' ? 'green' : p.status === 'DRAFT' ? 'amber' : 'grey';
    const desc = p.description || (p.kind === 'DISCOUNT_MATRIX'
      ? 'Approved 3, 6 and 12-month matrix by size and access.'
      : p.kind === 'FREE_MONTHS'
        ? (p.commitmentMonths ? p.commitmentMonths + ' months only · ' : '') + (p.freeMonthCount || 0) + ' free month' + (p.freeMonthCount === 1 ? '' : 's') + '.'
        : planKindLabel(p) + ' — conditional offer.');
    const eff = (p.effectiveFrom ? 'Effective ' + fmtDay(p.effectiveFrom) : '') + (p.effectiveTo ? ' – ' + fmtDay(p.effectiveTo) : '');
    const note = p.status === 'DRAFT' && selectable ? ' · Preview-only selection; it remains Draft'
      : selectable ? ' · Included only when selected' : ' · Visible only; not applied automatically';
    return '<label class="rs-plan-row ' + (selected ? 'selected' : '') + ' ' + (selectable ? '' : 'readonly') + '">' +
      (selectable ? '<input type="checkbox" data-rs-plan="' + escapeHtml(p.id) + '"' + (selected ? ' checked' : '') + '>' : '<span class="rs-plan-lock">i</span>') +
      '<span class="rs-plan-check">✓</span><div><div><b>' + escapeHtml((p.name || p.id) + ' · v' + (p.version || 1)) + '</b><span class="pill ' + statusClass + '">' + escapeHtml(statusLabel) + '</span></div>' +
      '<p>' + escapeHtml(desc) + '</p><small>' + escapeHtml(eff + note) + '</small></div></label>';
  }).join('');
  host.querySelectorAll('[data-rs-plan]').forEach((c) => c.addEventListener('change', () => {
    const ids = Array.from(host.querySelectorAll('[data-rs-plan]:checked')).map((el) => el.dataset.rsPlan);
    // Unchecking everything reverts to the stored selection: the preview
    // route treats an absent planIds param as “stored/default”.
    view.planIds = ids.length ? ids : null;
    view.previews = {};
    paintPromoSelection();
    if (view.liveDirty && hasLeverInputs()) scheduleLivePreview(root, true);
    else refreshWorkbench(root);
  }));
  paintPromoCount();
}

function paintPromoCount() {
  const el = $('#rsPromoCount');
  if (!el || !view.plans) return;
  const selectable = view.plans.filter((p) => (p.kind === 'DISCOUNT_MATRIX' || p.kind === 'FREE_MONTHS') && (p.status === 'ACTIVE' || p.status === 'DRAFT'));
  const sel = selectedPlanRefs();
  el.textContent = selectable.filter((p) => sel.includes(p.id)).length + ' of ' + selectable.length + ' testable plans selected';
}

function paintPromoSelection() {
  const host = $('#rsPromos');
  if (!host || !view.plans) return;
  const sel = selectedPlanRefs();
  host.querySelectorAll('[data-rs-plan]').forEach((c) => {
    c.checked = sel.includes(c.dataset.rsPlan);
    const row = c.closest('.rs-plan-row');
    if (row) row.classList.toggle('selected', c.checked);
  });
  paintPromoCount();
}

// ---- unit-rate breakdown (§15.20): duration filter, range view, overrides ----
function rsSelectedPlanNames(kind) {
  const sel = selectedPlanRefs();
  return (view.plans || []).filter((p) => p.kind === kind && sel.includes(p.id)).map((p) => p.name);
}

function promoCell(r) {
  // Reference appliedBenefits: "<plan> · 45%" + " + " + "<plan> · 2 free".
  const parts = [];
  if (r.combinedDiscount > 0) {
    const names = rsSelectedPlanNames('DISCOUNT_MATRIX');
    parts.push((names.length ? names.join(' + ') : 'Approved percentage plan') + ' · ' + rsPct(r.combinedDiscount));
  }
  if (r.freeMonths) {
    const names = rsSelectedPlanNames('FREE_MONTHS');
    parts.push((names.length ? names.join(' + ') : 'Approved free-month plan') + ' · ' + r.freeMonths + ' free');
  }
  return parts.length ? parts.join(' + ') : 'No promotion';
}

function rsPct(x) {
  return (Number(x) * 100).toFixed(1).replace(/\.0$/, '') + '%';
}

function renderPreviewTables(root) {
  const host = $('#rsPreview');
  if (!host || !view.preview) return;
  const data = view.preview;
  const all = (data.preview.rows || []).slice().sort((a, b) => a.size - b.size);
  const rows = view.range === 'all'
    ? all.filter((r) => r.size >= view.rangeFrom && r.size <= view.rangeTo)
    : all.filter((r) => r.stocked);
  const hasFree = all.some((r) => r.stocked && r.hasBlended);
  const targetPsf = data.target && data.target.targetPsf;
  const d = view.duration;
  const canOverride = view.version && view.version.status === 'DRAFT' && can('facility-rate-strategy:update');
  const isActive = view.version && (view.version.status === 'ACTIVE' || view.version.status === 'APPROVED');
  const pctNames = rsSelectedPlanNames('DISCOUNT_MATRIX');
  const freeNames = rsSelectedPlanNames('FREE_MONTHS');
  const anyPct = all.some((r) => r.stocked && r.combinedDiscount > 0);
  const anyFree = all.some((r) => r.stocked && r.freeMonths > 0);
  const promoNames = [].concat(anyPct ? pctNames : [], anyFree ? freeNames : []);
  const promoName = (promoNames.length ? promoNames.join(' + ') : 'No applicable promotion') + ' · ' + d + ' month' + (d === 1 ? '' : 's');
  const applyBtn = can('facility-rate-strategy:update')
    ? '<button class="primary rs-sync-button" type="button" data-rs-action="sync-units" data-perm="facility-rate-strategy:update"' +
      (isActive && !view.liveDirty ? '' : ' disabled title="Save the draft and set it Active first."') + '>Apply rates to Units</button>'
    : '';
  host.innerHTML =
    '<div class="card-head"><div><h3>Unit-rate breakdown</h3><small>Compare discount, free-month and PSF outcomes for each duration. Only stocked sizes affect facility totals.</small></div>' +
    '<div class="rs-rate-tools">' + rsDurationFilter('Customer storage duration', true) +
    '<label><span>Unit sizes</span><select id="rsRange"><option value="stocked"' + (view.range !== 'all' ? ' selected' : '') + '>Facility sizes only</option>' +
    '<option value="all"' + (view.range === 'all' ? ' selected' : '') + '>Every 1 sq ft</option></select></label>' +
    (view.range === 'all'
      ? '<label><span>From</span><input type="number" min="8" max="150" step="1" id="rsFrom" value="' + view.rangeFrom + '"></label>' +
        '<label><span>To</span><input type="number" min="8" max="150" step="1" id="rsTo" value="' + view.rangeTo + '"></label>'
      : '') +
    '<b>' + rows.length + ' rate' + (rows.length === 1 ? '' : 's') + '</b>' + applyBtn + '</div></div>' +
    '<div class="rs-table-context"><b>' + d + '-month view</b><span>' + escapeHtml(promoName) + '</span><span>Model target: <b>' +
    (targetPsf != null ? fmtPsf(targetPsf) + ' PSF' : 'unavailable') + '</b></span></div>' +
    '<div class="table-wrap rs-rate-scroll"><table class="rs-table ' + (hasFree ? '' : 'no-blended') + '"><thead><tr>' +
    '<th>Facility availability</th><th>Category</th><th>Unit size</th><th>Promotion(s) applied</th><th>Rack rent</th><th>Rack PSF</th><th>Approved discount</th>' +
    '<th>' + rsTip('Effective monthly rent', 'Recurring customer rent after the approved percentage discount. This resumes after any free-month benefit ends.') + '</th>' +
    '<th>' + rsTip('Effective PSF', 'Effective monthly rent divided by unit size; this excludes free-month spreading.') + '</th>' +
    (hasFree ? '<th>Approved free months</th><th>' + rsTip('Blended monthly rent', 'Total commitment rent divided evenly across all commitment months, including free months.') + '</th><th>' + rsTip('Blended PSF', 'Blended monthly rent divided by unit size.') + '</th>' : '') +
    '<th>' + rsTip('Model target PSF', 'The Financial Model recurring PSF target for this facility.') + '</th>' +
    '<th>' + rsTip('Effective PSF vs target', 'Effective PSF minus the Financial Model target. Free months affect Blended PSF but not this comparison.') + '</th>' +
    '<th>Override</th></tr></thead><tbody>' +
    (rows.length ? rows.map((r) => {
      const gap = targetPsf != null ? r.effectivePsf - Number(targetPsf) : null;
      return '<tr class="' + (r.stocked ? '' : 'unavailable') + '">' +
        '<td>' + (r.stocked ? '<span class="pill green">Available · ' + r.unitCount + ' unit' + (r.unitCount === 1 ? '' : 's') + '</span>' : '<span class="pill grey">Rate only</span>') + '</td>' +
        '<td>' + escapeHtml(r.category === 'LOCKER' ? 'Locker' : r.category) + '</td>' +
        '<td><b>' + r.size + ' sq ft</b>' + (r.category === 'LOCKER' ? '<small>Half-height locker</small>' : '') + '</td>' +
        '<td><span class="rs-applied-benefit">' + escapeHtml(promoCell(r)) + '</span></td>' +
        '<td><b>' + rsMoney(r.rackMonthly, 2) + '</b>' + (r.overridden ? '<small class="rs-override">Manual override</small>' : '') + '</td>' +
        '<td>' + fmtPsf(r.rackPsf) + '</td>' +
        '<td>' + (r.combinedDiscount > 0 ? rsPct(r.combinedDiscount) : '0%') + '</td>' +
        '<td><b>' + rsMoney(r.effectiveMonthly, 2) + '</b></td><td><b>' + fmtPsf(r.effectivePsf) + '</b></td>' +
        (hasFree ? '<td>' + (r.freeMonths || 0) + ' of ' + (r.commitmentMonths || d) + '</td><td>' + rsMoney(r.blendedMonthly, 2) + '</td><td><b>' + fmtPsf(r.blendedPsf) + '</b></td>' : '') +
        '<td><b>' + (targetPsf != null ? fmtPsf(targetPsf) : '—') + '</b></td>' +
        '<td>' + (r.stocked && gap != null ? '<span class="pill ' + (gap >= -0.005 ? 'green' : 'grey') + '">' + rsSigned(gap) + '</span>' : '—') + '</td>' +
        '<td>' + (canOverride ? '<button class="btn rs-small" type="button" data-rs-override="' + r.size + '">' + (r.overridden ? 'Edit' : 'Set') + '</button>' : (r.overridden ? 'Manual' : '—')) + '</td></tr>';
    }).join('') : '<tr><td colspan="15"><div class="rs-empty">No sizes in this range. Widen From/To or pick “Facility sizes only”.</div></td></tr>') +
    '</tbody></table></div>';
  const rangeSel = $('#rsRange');
  if (rangeSel) rangeSel.addEventListener('change', () => {
    view.range = rangeSel.value === 'all' ? 'all' : 'stocked';
    renderPreviewTables(root);
    renderRsChart();
  });
  const fromEl = $('#rsFrom');
  const toEl = $('#rsTo');
  const applyRange = () => {
    view.rangeFrom = Math.max(8, Math.min(150, Number(fromEl && fromEl.value) || 8));
    view.rangeTo = Math.max(view.rangeFrom, Math.min(150, Number(toEl && toEl.value) || 150));
    renderPreviewTables(root);
    renderRsChart();
  };
  if (fromEl) fromEl.addEventListener('change', applyRange);
  if (toEl) toEl.addEventListener('change', applyRange);
  const sync = host.querySelector('[data-rs-action="sync-units"]');
  if (sync) sync.addEventListener('click', (e) => { e.preventDefault(); openBatchModal(root, view.version); });
  if (canOverride) {
    host.querySelectorAll('[data-rs-override]').forEach((b) => b.addEventListener('click', () => {
      openOverrideModal(root, Number(b.dataset.rsOverride));
    }));
  }
}

/** Per-row manual rate override: monthly rate + mandatory reason;
 *  “Use generated rate” removes the override. Draft-only, audited. */
function openOverrideModal(root, size) {
  const v = view.version;
  if (!v || v.status !== 'DRAFT') return;
  const existing = ((v.levers && v.levers.sizeOverrides) || []).find((o) => Number(o.size) === size);
  const row = view.preview && (view.preview.preview.rows || []).find((r) => r.size === size);
  const current = (existing && existing.monthlyRate) ?? (row && row.rackMonthly) ?? '';
  const saveOverrides = async (list, msg) => {
    await patch('/rate-strategy/' + encodeURIComponent(v.id), { version: v.version, levers: { sizeOverrides: list } });
    showBanner(msg, true);
    view.previews = {};
    setTimeout(async () => { await refreshShow(root); }, 0);
  };
  overlay(root, 'Override ' + size + ' sq ft rack rate',
    '<div class="rs-modal-note"><b>' + size + ' sq ft · ' + escapeHtml(row ? (row.category === 'LOCKER' ? 'Locker' : row.category) : '') + '</b><span>The generated rate is ' +
    rsMoney(row && row.rackMonthly, 2) + '. A manual override remains visible and auditable.</span></div>' +
    '<label class="rs-modal-field"><span>Monthly rack-rate override</span><div class="rs-suffix"><input id="rsov-rate" type="number" min="1" step="1" value="' + escapeHtml(String(current)) + '"><em>SGD</em></div></label>' +
    '<label class="rs-modal-field"><span>Reason</span><textarea id="rsov-reason" maxlength="200" placeholder="Required for audit, e.g. unusual column or restricted access">' + escapeHtml(String((existing && existing.reason) || '')) + '</textarea></label>',
    'Apply override',
    async () => {
      const rate = Number($('#rsov-rate').value);
      const reason = $('#rsov-reason').value.trim();
      if (!(rate > 0)) throw new Error('A positive monthly rack rate is required.');
      if (!reason) throw new Error('A reason is required for an override.');
      const rest = ((v.levers && v.levers.sizeOverrides) || []).filter((o) => Number(o.size) !== size);
      rest.push({ size, monthlyRate: Math.round(rate * 100) / 100, reason });
      await saveOverrides(rest, 'Override saved for ' + size + ' sq ft');
    },
    { footerStart: existing ? '<button class="btn" type="button" id="rsOverrideRemove" style="margin-right:auto">Use generated rate</button>' : '' });
  const rm = $('#rsOverrideRemove');
  if (rm) rm.addEventListener('click', async () => {
    rm.disabled = true;
    try {
      const rest = ((v.levers && v.levers.sizeOverrides) || []).filter((o) => Number(o.size) !== size);
      await saveOverrides(rest, 'Override removed for ' + size + ' sq ft');
      closeOverlay();
    } catch (e) { showRsError(describeError(e)); rm.disabled = false; }
  });
}

async function runValidation(root) {
  const host = $('#rsValidation');
  if (host) host.innerHTML = '<div class="rs-empty">Validating…</div>';
  try {
    const data = await post('/rate-strategy/' + encodeURIComponent(view.versionId) + '/validate', {});
    view.validation = data;
    const html = rsValidationHtml(data);
    if (host) host.innerHTML = html;
    const wrap = $('#rsValidationWrap');
    if (wrap) wrap.open = true;
    overlay(root, 'Rate strategy validation', html, '', async () => {},
      { noConfirm: true, cancelLabel: 'Return to strategy',
        subtitle: view.version ? view.version.strategyName + ' · v' + view.version.versionNo : '' });
  } catch (e) {
    if (host) host.innerHTML = '<div class="rs-empty">Validation failed: ' + escapeHtml(describeError(e)) + '</div>';
    rsError(root, e);
  }
}

/** Reference openValidation() body: summary tiles, checks, guidance. */
function rsValidationHtml(data) {
  const blockers = data.blockers || [];
  const warnings = data.warnings || [];
  const passed = data.passed || [];
  const text = (i) => (i && typeof i === 'object' ? (i.message || i.code) + (i.reason && i.reason !== i.message ? ' — ' + i.reason : '') : String(i));
  const list = (items, kind) => items.map((i) =>
    '<div class="rs-check ' + kind + '"><i>' + (kind === 'pass' ? '✓' : kind === 'block' ? '×' : '!') + '</i><span>' + escapeHtml(text(i)) + '</span></div>').join('');
  return '<div class="rs-validation-summary"><div><small>Passed</small><b>' + passed.length + '</b></div>' +
    '<div><small>Warnings</small><b>' + warnings.length + '</b></div><div><small>Blockers</small><b>' + blockers.length + '</b></div></div>' +
    '<div class="rs-checks">' + list(blockers, 'block') + list(warnings, 'warn') + list(passed, 'pass') + '</div>' +
    '<div class="rs-formula"><b>Warnings do not block Set Active</b><span>Only red blockers prevent Set Active or Apply rates to Units.</span></div>';
}

async function loadHistory(root) {
  const host = $('#rsHistory');
  if (!host) return;
  try {
    const rows = (await get('/rate-strategy/library')) || [];
    const mine = rows.filter((r) => r.strategyId === view.version.strategyId).sort((a, b) => b.versionNo - a.versionNo);
    view.history = mine;
    const count = $('#rsHistCount');
    if (count) count.textContent = mine.length + ' version' + (mine.length === 1 ? '' : 's');
    if (!mine.length) { host.innerHTML = '<div class="rs-empty">No versions found.</div>'; return; }
    const change = (r) => (r.status === 'ACTIVE' || r.status === 'APPROVED' ? 'Set Active' : r.status === 'SUPERSEDED' ? 'Superseded by a newer Active version' : r.status === 'DRAFT' ? 'Draft saved' : String(r.status).replace(/_/g, ' ').toLowerCase());
    host.innerHTML = '<table class="rs-history"><thead><tr><th>Version</th><th>Date</th><th>Changed by</th><th>Change</th><th>Status</th><th></th></tr></thead><tbody>' +
      mine.map((r) => {
        const stm = rsStatusMeta(r.status, false);
        return '<tr><td>v' + r.versionNo + '</td><td>' + escapeHtml(fmtDay(r.updatedAt)) + '</td><td>' + escapeHtml(r.approvedBy || r.submittedBy || r.owner || '—') + '</td>' +
          '<td>' + escapeHtml(change(r)) + '</td><td><span class="pill ' + stm.cls + '">' + escapeHtml(stm.label) + '</span></td>' +
          '<td>' + (r.versionId === view.versionId ? '<span class="pill blue">Open</span>' : '<button class="btn rs-small" type="button" data-rs-hist="' + escapeHtml(r.versionId) + '">Open</button>') + '</td></tr>';
      }).join('') + '</tbody></table>';
    host.querySelectorAll('[data-rs-hist]').forEach((b) => b.addEventListener('click', async () => {
      view.versionId = b.dataset.rsHist;
      view.version = null; view.preview = null; view.previewError = null; view.liveDirty = false; view.validation = null; view.history = null; view.activity = null;
      view.previews = {}; view.planIds = null; view.plans = null;
      await renderShow($('#rsBody'), root);
    }));
  } catch (e) {
    host.innerHTML = '<div class="rs-empty">History failed to load: ' + escapeHtml(describeError(e)) + '</div>';
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
    view.batches = rows || [];
    renderRsContext();
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

// Set Active (no approval gate): Draft → Active. Only red validation
// blockers prevent activation; a missing Financial Model target and
// warnings are display-only. Requires a saved draft.
async function activateStrategy(root, v) {
  if (!v || v.status !== 'DRAFT') {
    rsError(root, new Error('Only a Draft can be set Active.'));
    return;
  }
  if (view.liveDirty) {
    rsError(root, new Error('Save the draft first — unsaved workbench changes must be saved or undone before Set Active.'));
    return;
  }
  let result;
  try {
    result = await post('/rate-strategy/' + encodeURIComponent(v.id) + '/validate', {});
  } catch (e) { rsError(root, e); return; }
  if ((result.blockers || []).length) {
    overlay(root, 'Rate strategy validation', '<div class="rs-warning"><b>Resolve blockers before Set Active</b><span>Red blockers must be fixed in the workbench; warnings never block.</span></div>' + rsValidationHtml(result),
      '', async () => {}, { noConfirm: true, cancelLabel: 'Return to strategy' });
    return;
  }
  const p = view.previews && view.previews[12];
  const sum = p && p.preview && p.preview.summary;
  const tgt = p && p.target;
  const warnings = result.warnings || [];
  const branch = (state.branches || []).find((b) => b.id === v.branchId);
  const body =
    '<div class="rs-modal-note"><b>Set Active creates a dated facility rate version</b><span>The snapshot is frozen and any other Active version of this strategy is superseded. Rates reach Units only when you click Apply rates to Units.</span></div>' +
    '<div class="rs-approval-summary"><div><small>Facility</small><b>' + escapeHtml(branch ? branch.name : (v.branchCode || '—')) + '</b></div>' +
    '<div><small>Effective from</small><b>' + escapeHtml(fmtDay(v.effectiveFrom)) + '</b></div>' +
    '<div><small>Weighted Effective PSF</small><b>' + (sum ? fmtPsf(sum.weightedEffectivePsf) : '—') + '</b></div>' +
    '<div><small>Financial target</small><b>' + (tgt && tgt.targetPsf != null ? fmtPsf(tgt.targetPsf) : 'Unavailable') + '</b></div></div>' +
    (warnings.length
      ? '<div class="rs-approval-warnings"><b>' + warnings.length + ' advisory warning' + (warnings.length === 1 ? '' : 's') + '</b>' +
        warnings.map((w) => '<span>! ' + escapeHtml(w.message || w.code) + '</span>').join('') +
        '<small>Warnings are display-only — they do not prevent Set Active.</small></div>'
      : '<div class="rs-modal-note"><b>No warnings</b><span>The strategy passed all automated checks.</span></div>');
  overlay(root, 'Set version ' + v.versionNo + ' Active', body, 'Set Active', async () => {
    await post('/rate-strategy/' + encodeURIComponent(v.id) + '/activate', { version: v.version });
    showBanner('Version ' + v.versionNo + ' is now Active — you can Apply rates to Units', true);
    setTimeout(() => refreshShow(root), 0);
  }, { subtitle: v.strategyName });
}

function openDuplicateModal(root, v) {
  const all = state.branches || [];
  const others = all.filter((b) => b.id !== v.branchId);
  const opts = (others.length ? others : all);
  overlay(root, 'Duplicate rate strategy',
    '<div class="rs-modal-note"><b>Copy the pricing logic, not another facility’s inventory</b><span>The target facility will use its own Units inventory. The uplift is applied to the starting rate, PSF floor, minimum monthly rent, category floors and any size overrides.</span></div>' +
    '<div class="rs-modal-grid"><label class="rs-modal-field"><span>Destination facility</span><select id="rsDupBranch">' +
    opts.map((b) => '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(b.name || b.code) + '</option>').join('') + '</select></label>' +
    '<label class="rs-modal-field"><span>Rate uplift</span><div class="rs-suffix"><input id="rsDupUplift" type="number" step="0.5" min="-50" max="100" value="5"><em>%</em></div></label>' +
    '<label class="rs-modal-field full"><span>New strategy name</span><input id="rsDupName" maxlength="120" value="' + escapeHtml('Copy of ' + v.strategyName) + '"></label></div>',
    'Create facility draft',
    async () => {
      const data = await post('/rate-strategy/' + encodeURIComponent(v.id) + '/duplicate', {
        destinationBranchId: $('#rsDupBranch').value,
        name: $('#rsDupName').value.trim(),
        upliftPct: Number($('#rsDupUplift').value),
      });
      showBanner('Duplicated as ' + data.strategyName + ' v1 Draft', true);
      view.versionId = data.id;
      view.version = null; view.preview = null; view.previewError = null; view.liveDirty = false; view.validation = null; view.history = null; view.activity = null;
      view.previews = {}; view.planIds = null; view.plans = null;
      setTimeout(() => refreshShow(root), 0);
    });
}

function openBatchModal(root, v) {
  const isActive = v && (v.status === 'ACTIVE' || v.status === 'APPROVED');
  const ready = isActive && !view.liveDirty;
  const p = view.previews && (view.previews[12] || view.previews[view.duration]);
  const rows = ((p && p.preview.rows) || []).filter((r) => r.stocked).sort((a, b) => a.size - b.size);
  const sum = p && p.preview.summary;
  const branch = (state.branches || []).find((b) => b.id === v.branchId);
  const rule = currentDefaultRule();
  const ruleLabel = {
    PRESERVE_MANUAL: 'Preserve existing manual rates (recommended)',
    REPLACE_MANUAL: 'Replace manual rates with this strategy (Owner only)',
    CANCEL_IF_MANUAL: 'Cancel if any manual rate exists',
  };
  const body =
    (ready
      ? '<div class="rs-modal-note"><b>Ready to schedule the Active rack rates</b><span>This creates one versioned rate batch for Facilities · Units. It does not apply percentage discounts or free months to the unit master.</span></div>'
      : '<div class="rs-warning"><b>Set this strategy Active first</b><span>Save the draft, click Set Active, then Apply rates to Units with no unsaved changes.</span></div>') +
    '<div class="rs-sync-summary"><div><small>Facility</small><b>' + escapeHtml(branch ? branch.name : (v.branchCode || '—')) + '</b></div>' +
    '<div><small>Strategy</small><b>' + escapeHtml(v.strategyName + ' · v' + v.versionNo) + '</b></div>' +
    '<div><small>Unit records</small><b>' + (sum ? rsNum(sum.totalUnits) : '—') + '</b></div>' +
    '<div><small>Size rates</small><b>' + rows.length + '</b></div></div>' +
    '<div class="rs-modal-grid"><label class="rs-modal-field"><span>Rates take effect</span><input id="rsBatchDate" type="date" value="' + escapeHtml(v.effectiveFrom && v.effectiveFrom > todaySg() ? v.effectiveFrom : todaySg()) + '"></label>' +
    '<label class="rs-modal-field"><span>' + rsTip('Existing manual unit rates', 'Some units may already have a manually set rate because they are unusual. Choose whether to preserve or replace those exceptions when this strategy is applied.') + '</span>' +
    '<select id="rsBatchRule">' + CONFLICT_RULES.map((r) => '<option value="' + r + '"' + (rule === r ? ' selected' : '') + '>' + escapeHtml(ruleLabel[r] || r) + '</option>').join('') + '</select>' +
    '<small>A manual unit rate is an intentional exception saved against one specific unit.</small></label></div>' +
    '<div class="rs-sync-scope"><div><i>✓</i><span><b>Updated:</b> vacant-unit rack rates, future quotes and new reservations from the effective date.</span></div>' +
    '<div><i>—</i><span><b>Not changed:</b> occupied-customer rent, promotions, protection plans or existing signed agreements.</span></div></div>' +
    '<div class="table-wrap"><table class="rs-sync-preview"><thead><tr><th>Size</th><th>Units</th><th>Rack rent</th><th>Rack PSF</th><th>Unit master action</th></tr></thead><tbody>' +
    (rows.length ? rows.map((r) => '<tr><td>' + r.size + ' sq ft</td><td>' + r.unitCount + '</td><td><b>' + rsMoney(r.rackMonthly, 2) + '</b></td><td>' + fmtPsf(r.rackPsf) + '</td><td>Schedule rack-rate update</td></tr>').join('')
      : '<tr><td colspan="5"><div class="rs-empty">No stocked sizes for this facility.</div></td></tr>') +
    '</tbody></table></div>';
  overlay(root, 'Apply rack rates to Facilities · Units', body, ready ? 'Schedule Units rate update' : 'Set Active first',
    async () => {
      const key = 'rs-' + v.id.slice(0, 8) + '-' + Date.now().toString(36);
      const res = await request('/rate-strategy/' + encodeURIComponent(v.id) + '/batches', {
        method: 'POST',
        body: JSON.stringify({ effectiveDate: $('#rsBatchDate').value, conflictRule: $('#rsBatchRule').value }),
        headers: { 'Idempotency-Key': key },
      });
      const b = res.data || {};
      showBanner('Batch ' + b.ref + ' ' + String(b.status || 'scheduled').toLowerCase() + (res.meta && res.meta.replayed ? ' (replayed)' : ''), true);
      setTimeout(async () => {
        await loadVersionBatches(root);
        await loadActivity(root);
        renderRsContext();
        const s = b.summary || {};
        overlay(root, 'Units rate batch ' + (b.status === 'APPLIED' ? 'applied' : 'scheduled'),
          '<div class="rs-modal-note"><b>' + escapeHtml(b.ref || 'Batch') + ' · ' + escapeHtml(String(b.status || '').replace(/_/g, ' ').toLowerCase()) + '</b><span>' +
          (b.status === 'APPLIED'
            ? (s.applied || 0) + ' vacant unit records updated; ' + (s.skippedOccupied || 0) + ' occupied units skipped; ' + (s.preservedManual || 0) + ' manual rates preserved.'
            : 'Unit records update on ' + escapeHtml(fmtDay(b.effectiveDate)) + '.') + ' Existing customer rent remains unchanged.</span></div>' +
          '<div class="rs-sync-scope"><div><i>✓</i><span>The batch is recorded in this strategy’s history and linked to Facilities · Units.</span></div>' +
          '<div><i>✓</i><span>New quotes and reservations use the new rack rates from the effective date.</span></div></div>',
          '', async () => {}, { noConfirm: true });
      }, 0);
    }, { size: 'wide', confirmDisabled: !ready });
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
  // Layout/typography come from proto-rate-strategy.css (verbatim copy of
  // the reference rate-strategy.css). Only glue for CMS widgets reused here.
  if (document.querySelector('style[data-rs-workbench]')) return;
  const st = document.createElement('style');
  st.setAttribute('data-rs-workbench', '1');
  st.textContent =
    '#rateStrategyRoot .tbl-toolbar{flex-wrap:wrap;row-gap:8px}' +
    '#rateStrategyRoot .tbl-toolbar .tbl-select,#rateStrategyRoot .tbl-toolbar .set-input{max-width:100%}' +
    '#rateStrategyRoot .rs-table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}' +
    '#rateStrategyRoot > #rsBody > .modal-alert{margin-bottom:14px}' +
    '#rateStrategyRoot [hidden]{display:none!important}' +
    // Reference hides the module tab row on this page (sidebar sub-items
    // carry the same navigation).
    '#promotions:has(#facility-rate-strategy.active) > .subtabs{display:none}';
  document.head.appendChild(st);
}

function ensureRsOverlayStyles() {
  // The modal shell (.modal/.overlay/.modal-card) and every rs-* body class
  // come from the CMS base + proto-rate-strategy.css. Our CMS base differs
  // from the reference in three values — pin the reference ones here.
  if (document.querySelector('style[data-rs-overlay]')) return;
  const st = document.createElement('style');
  st.setAttribute('data-rs-overlay', '1');
  st.textContent =
    '#rsOverlay .modal-card header h2{font-size:19px}' +
    '#rsOverlay .modal-card header small{color:inherit}' +
    '#rsOverlay .modal-card footer{padding:14px 20px}' +
    '#rsOverlay .modal-card{z-index:1}' +
    '#rsOverlay{z-index:120}' +
    '#rsOverlayErr{margin-top:12px}' +
    '#rsOverlay [hidden]{display:none!important}';
  document.head.appendChild(st);
}

/** Reference showModal(): `.modal.rs-modal` + `.overlay` + `.modal-card`
 *  (header h2/small + × iconbtn, section body, footer buttons). opts:
 *  { size: 'wide'|'normal', subtitle, cancelLabel, footerStart (html),
 *    noConfirm, confirmDisabled }. Ids #rsOverlay/#rsOverlayOk/
 *  #rsOverlayCancel/#rsOverlayErr are stable for callers. */
function overlay(root, title, bodyHtml, confirmLabel, onConfirm, opts) {
  const o = opts || {};
  ensureRsOverlayStyles();
  closeOverlay();
  const wrap = document.createElement('div');
  wrap.className = 'modal rs-modal';
  wrap.id = 'rsOverlay';
  wrap.innerHTML = '<div class="overlay" data-rs-close></div>' +
    '<div class="modal-card' + (o.size === 'wide' ? ' rs-wide' : '') + '" role="dialog" aria-modal="true" aria-label="' + escapeHtml(title) + '">' +
    '<header><div><h2>' + escapeHtml(title) + '</h2><small>' + escapeHtml(o.subtitle || '') + '</small></div>' +
    '<button class="iconbtn" type="button" id="rsOverlayX" data-rs-close aria-label="Close">×</button></header>' +
    '<section>' + bodyHtml + '<div class="rs-warning" id="rsOverlayErr" hidden></div></section>' +
    '<footer>' + (o.footerStart || '') +
    '<button class="btn" type="button" id="rsOverlayCancel" data-rs-close>' + escapeHtml(o.cancelLabel || (o.noConfirm ? 'Close' : 'Cancel')) + '</button>' +
    (o.noConfirm ? '' : '<button class="primary" type="button" id="rsOverlayOk"' + (o.confirmDisabled ? ' disabled' : '') + '>' + escapeHtml(confirmLabel) + '</button>') +
    '</footer></div>';
  document.body.appendChild(wrap);
  // Same stopPropagation guard as the reference: keep modal clicks away
  // from the app-wide fallback button handler.
  wrap.addEventListener('click', (e) => {
    e.stopPropagation();
    const tip = e.target.closest('[data-rs-tip]');
    if (tip) { e.preventDefault(); showRsError(tip.dataset.rsTip, true); return; }
    if (e.target.closest('[data-rs-close]')) { e.preventDefault(); closeOverlay(); }
  });
  const onKey = (e) => { if (e.key === 'Escape') closeOverlay(); };
  document.addEventListener('keydown', onKey);
  wrap._rsKey = onKey;
  requestAnimationFrame(() => wrap.classList.add('open'));
  const ok = $('#rsOverlayOk');
  if (ok) ok.addEventListener('click', async () => {
    ok.disabled = true;
    try { await onConfirm(); closeOverlay(); }
    catch (e) {
      showRsError(describeError(e));
      ok.disabled = false;
    }
  });
}

/** Inline message inside the open dialog (errors, or a ? definition). */
function showRsError(text, info) {
  const err = $('#rsOverlayErr');
  if (!err) return;
  err.hidden = false;
  err.className = info ? 'rs-modal-note' : 'rs-warning';
  err.innerHTML = '<b>' + (info ? 'Definition' : 'Could not complete this action') + '</b><span>' + escapeHtml(text) + '</span>';
}

function closeOverlay() {
  const el = $('#rsOverlay');
  if (!el) return;
  if (el._rsKey) document.removeEventListener('keydown', el._rsKey);
  el.remove();
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
  const branches = state.branches || [];
  overlay(root, 'New rate strategy',
    '<div class="rs-modal-note"><b>Start a facility draft</b><span>The draft opens in the workbench with the recommended smooth-curve defaults. Adjust the levers there, Save draft, then Set Active.</span></div>' +
    '<div class="rs-modal-grid"><label class="rs-modal-field"><span>Facility</span><select id="rsf-branch">' + branches.map((b) =>
      '<option value="' + escapeHtml(b.id) + '"' + (view.branchFilter === b.id ? ' selected' : '') + '>' + escapeHtml(b.name || b.code) + '</option>').join('') + '</select></label>' +
    '<label class="rs-modal-field"><span>Effective from</span><input id="rsf-effectiveFrom" type="date" value="' + todaySg() + '"></label>' +
    '<label class="rs-modal-field full"><span>Strategy name</span><input id="rsf-name" maxlength="120" placeholder="e.g. Sembawang Master Rate Strategy"></label>' +
    '<label class="rs-modal-field full"><span>Owner (optional)</span><input id="rsf-owner" maxlength="120"></label></div>',
    'Create draft',
    async () => {
      const name = $('#rsf-name').value.trim();
      if (!name) throw new Error('A strategy name is required.');
      const data = await post('/facilities/' + encodeURIComponent($('#rsf-branch').value) + '/rate-strategy', {
        name,
        owner: $('#rsf-owner').value.trim() || undefined,
        effectiveFrom: $('#rsf-effectiveFrom').value || undefined,
      });
      showBanner('Draft ' + data.strategyName + ' v1 created', true);
      view.versionId = data.id;
      view.libraryOpen = false;
      view.previews = {}; view.planIds = null; view.plans = null;
      setTimeout(() => showRoot(root), 0);
    });
}

/** Reference openStrategyLibrary(): wide modal with facility/status
 *  filters and a Load button per version. */
async function openStrategyLibraryModal(root) {
  let rows = [];
  try { rows = (await get('/rate-strategy/library')) || []; } catch (e) { rsError(root, e); return; }
  const branches = state.branches || [];
  const nameOf = (r) => { const b = branches.find((x) => x.id === r.branchId); return b ? b.name : (r.branchCode || '—'); };
  overlay(root, 'Rate strategy library',
    '<div class="rs-modal-note"><b>One library for every facility strategy</b><span>Load an existing version, compare its status and effective date, or start a new facility draft. Only Active strategies can be applied to Facilities · Units.</span></div>' +
    '<div class="rs-library-filters"><label><span>Facility</span><select id="rsLibFacility"><option value="all">All facilities</option>' +
    branches.map((b) => '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(b.name || b.code) + '</option>').join('') + '</select></label>' +
    '<label><span>Status</span><select id="rsLibStatus"><option value="all">All statuses</option><option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="SUPERSEDED">Superseded</option></select></label></div>' +
    '<div class="table-wrap"><table class="rs-library-table"><thead><tr><th>Strategy</th><th>Facility</th><th>Version</th><th>Effective from</th><th>Status</th><th>Updated / owner</th><th></th></tr></thead><tbody id="rsLibRows"></tbody></table></div>',
    '＋ New strategy',
    async () => { setTimeout(() => openCreateModal(root), 0); },
    { size: 'wide', cancelLabel: 'Close library',
      footerStart: '<button class="btn" type="button" id="rsLibAllBatches" style="margin-right:auto">All rate batches &amp; defaults</button>' });
  const paint = () => {
    const f = $('#rsLibFacility').value;
    const s = $('#rsLibStatus').value;
    const list = rows.filter((r) => (f === 'all' || r.branchId === f) &&
      (s === 'all' || r.status === s || (s === 'ACTIVE' && r.status === 'APPROVED')));
    $('#rsLibRows').innerHTML = list.length ? list.map((r) => {
      const st = rsStatusMeta(r.status, false);
      const loaded = r.versionId === view.versionId;
      return '<tr><td><b>' + escapeHtml(r.strategyName) + '</b>' + (loaded ? '<small>Current working copy</small>' : '') + '</td>' +
        '<td>' + escapeHtml(nameOf(r)) + '</td><td>v' + r.versionNo + '</td><td>' + escapeHtml(fmtDay(r.effectiveFrom)) + '</td>' +
        '<td><span class="pill ' + st.cls + '">' + escapeHtml(st.label) + '</span></td>' +
        '<td>' + escapeHtml(fmtDay(r.updatedAt)) + '<small>' + escapeHtml(r.owner || '—') + '</small></td>' +
        '<td>' + (loaded ? '<span class="pill blue">Loaded</span>' : '<button class="btn rs-small" type="button" data-rs-load="' + escapeHtml(r.versionId) + '">Load</button>') + '</td></tr>';
    }).join('') : '<tr><td colspan="7"><div class="rs-empty">No strategies match these filters.</div></td></tr>';
    $('#rsLibRows').querySelectorAll('[data-rs-load]').forEach((b) => b.addEventListener('click', () => {
      closeOverlay();
      view.versionId = b.dataset.rsLoad;
      view.version = null; view.preview = null; view.previewError = null; view.liveDirty = false; view.validation = null; view.history = null; view.activity = null;
      view.previews = {}; view.planIds = null; view.plans = null;
      renderShow($('#rsBody'), root);
    }));
  };
  $('#rsLibFacility').addEventListener('change', paint);
  $('#rsLibStatus').addEventListener('change', paint);
  const all = $('#rsLibAllBatches');
  if (all) all.addEventListener('click', () => {
    closeOverlay();
    view.versionId = null; view.libraryOpen = true; view.previews = {}; view.planIds = null; view.plans = null;
    showRoot(root);
  });
  paint();
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

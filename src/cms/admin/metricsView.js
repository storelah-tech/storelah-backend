// StoreLah CMS admin UI — floor-plan area metrics panel (save-draft →
// approve → publish, promotions mirror). Lives inside #facility-floorplans
// under the editor (#metricsCard). Follows the existing *View.js + DI
// pattern: this module owns all #metrics* DOM wiring, imports only
// dom/api/state/confirmDialog (never the admin.js entry), and is attached
// once via wireMetricsPanel() from the entry's wireEvents().
//
// Data comes ONLY from the metrics endpoints for the editor's selected floor
// (state.fp.floorId): GET /floor-plans/:floorId/metrics (live compute —
// client preview, advisory), GET/POST .../metrics/snapshots (draft history)
// and PATCH /floor-plans/metrics/snapshots/:id/status (the DRAFT → VALIDATED
// → SCHEDULED → ACTIVE walk; ACTIVE is immutable, corrections are new draft
// rows). Floor switches and canvas edits schedule a debounced (~400ms)
// refresh of the affected floor only; out-of-order responses are dropped via
// a sequence guard. All customer strings are escaped; step confirmations
// reuse confirmDialog (no window.confirm).

import { $, escapeHtml } from './dom.js';
import { get, post, patch, describeError, ApiError } from './api.js';
import { confirmDialog } from './confirmDialog.js';
import { state } from './state.js';

let metricsTimer = null;
let wired = false;

const fmtSqft = (n) => Number(n || 0).toLocaleString('en-SG', { maximumFractionDigits: 1 });
const todayIso = () => new Date().toISOString().slice(0, 10);

function metricsBanner(msg, ok) {
  const b = $('#metricsBanner');
  if (!b) return;
  if (!msg) {
    b.hidden = true;
    b.textContent = '';
    return;
  }
  b.hidden = false;
  b.textContent = msg;
  b.className = 'modal-alert' + (ok ? ' olive' : '');
}

function currentFloorLabel() {
  const f = (state.floors || []).find((x) => x.id === state.fp.floorId);
  const b = (state.branches || []).find((x) => x.code === state.fp.branchCode);
  if (!f) return '';
  return (b ? b.code + ' · ' : '') + 'Level ' + f.level;
}

function setSub() {
  const sub = $('#metricsSub');
  if (!sub) return;
  const where = currentFloorLabel();
  const r = state.metrics.report;
  sub.textContent = where
    ? where + (r ? ' · live compute — the ACTIVE snapshot is authoritative' : ' · live compute from the current canvas')
    : 'Pick a floor in the editor above — metrics follow the editor selection';
  const title = $('#metricsTitle');
  if (title) title.textContent = 'Area metrics' + (where ? ' — ' + where : '');
}

function statCard(label, value, sub) {
  return '<div class="stat"><div class="label">' + escapeHtml(label) + '</div><div class="val">' +
    escapeHtml(value) + '</div>' + (sub ? '<div class="trend">' + escapeHtml(sub) + '</div>' : '') + '</div>';
}

// Owner-confirmed final KPI set — exactly 14 cards, display-only (all values
// come from the live GET /floor-plans/:floorId/metrics report, never computed
// client-side). Missing/non-numeric fields render '—', never NaN/throw.
// Removed (never render): split net-lettable cards, GLA excl/incl variants,
// legacy NLA/GFA efficiency, load/circulation/volumetric cards,
// placed-units-only, or any other KPI outside the 14 below.
function renderKpis(r) {
  const el = $('#metricsKpis');
  if (!el) return;
  if (!r) {
    el.innerHTML = '';
    return;
  }
  const g = r.geometry || {};
  const sqft = (a) => (a && a.sqft != null && Number.isFinite(Number(a.sqft)) ? fmtSqft(a.sqft) : '—');
  // Total Corridor Area = UFA − NLA: prefer the additive corridorArea alias,
  // fall back to the identical geometry.common remainder on older payloads.
  const corridor = g.corridorArea && g.corridorArea.sqft != null ? g.corridorArea : g.common;
  // Efficiencies arrive as 1dp numbers from the service — append %.
  const pct = (v) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n.toFixed(1) + '%' : '—';
  };
  // 1. GFA basis: operator-entered (USER) vs canvas-rect fallback.
  const gfaSub = g.gfaSource === 'USER' ? 'operator-entered' : 'canvas fallback — enter GFA per plan';
  // 2. UFA is line-only (marked-area). Show the empty-state sub when there is
  // no measured area (0/missing) or the boundary loop is not closed.
  const ufaSqftNum = g.ufa && g.ufa.sqft != null ? Number(g.ufa.sqft) : NaN;
  const boundaryClosed = r.boundaryMetrics ? r.boundaryMetrics.boundaryClosed : undefined;
  const hasMarkedArea = Number.isFinite(ufaSqftNum) && ufaSqftNum > 0 && boundaryClosed !== false;
  const ufaSub = hasMarkedArea ? 'usable floor area · line-only' : 'no marked area — draw lines to measure';
  // unitGroups.groups is an array keyed by `key` (locker/xs/m/l/xl); tolerate
  // a keyed-object shape just in case.
  const ug = r.unitGroups || {};
  const groups = Array.isArray(ug.groups)
    ? ug.groups
    : (ug.groups && typeof ug.groups === 'object' ? Object.values(ug.groups) : []);
  const groupByKey = (key) => groups.find((x) => x && x.key === key) || null;
  const groupVal = (grp) => {
    if (!grp) return '—';
    const n = typeof grp.units === 'number' ? grp.units : Number(grp.units);
    const a = typeof grp.areaSqft === 'number' ? grp.areaSqft : Number(grp.areaSqft);
    if (!Number.isFinite(n) || !Number.isFinite(a)) return '—';
    return n + ' units · ' + fmtSqft(a) + ' sqft';
  };
  const coverage = r.coverage || {};
  const unplacedRaw = coverage.unplacedUnits;
  const unplacedNum = unplacedRaw != null ? Number(unplacedRaw) : NaN;
  const unplacedVal = Number.isFinite(unplacedNum) ? unplacedNum + ' units unplaced' : '—';
  // Occupied follows the revenue convention (OCCUPIED + OVERDUE, RESERVED
  // excluded) via occupancy.physical.occupiedUnits.
  const occupancy = r.occupancy || {};
  const physical = occupancy.physical || {};
  const occupiedRaw = physical.occupiedUnits;
  const occupiedNum = occupiedRaw != null ? Number(occupiedRaw) : NaN;
  const occupiedVal = Number.isFinite(occupiedNum) ? occupiedNum + ' units occupied' : '—';
  el.innerHTML = [
    statCard('GFA (GROSS FLOOR AREA)', sqft(g.gfa), gfaSub),
    statCard('UFA (USABLE FLOOR AREA)', sqft(g.ufa), ufaSub),
    statCard('NLA (NET LETTABLE AREA)', sqft(g.nlaTotal), 'billable, enclosed + outdoor'),
    statCard('Total Corridor Area (= UFA − NLA)', sqft(corridor), 'UFA − NLA'),
    statCard('GFA to UFA Efficiency (%)', pct(g.gfaToUfaEfficiencyPct), 'UFA / GFA'),
    statCard('UFA to NLA Efficiency (%)', pct(g.ufaToNlaEfficiencyPct), 'NLA / UFA'),
    statCard('Overall Units', groupVal(ug.overall), 'all sizes · nominal sqft'),
    statCard('Locker Units', groupVal(groupByKey('locker')), 'LOCKER'),
    statCard('XS units', groupVal(groupByKey('xs')), 'SMALL'),
    statCard('M Units', groupVal(groupByKey('m')), 'MEDIUM'),
    statCard('L Units', groupVal(groupByKey('l')), 'LARGE'),
    // XL (Extra Large) has no UnitSize code in the DB — the service reports
    // 0/0 flagged in unitGroups.notes; surface the zero with that note.
    statCard('XL Units', groupVal(groupByKey('xl')), 'no Extra Large code in DB'),
    statCard('Unplaced units', unplacedVal, 'no placement on canvas'),
    statCard('Occupied units', occupiedVal, 'OCCUPIED + OVERDUE per revenue convention'),
  ].join('');
}

// Status pill tone mirrors the promotions admin flow (admin.js): ACTIVE /
// VALIDATED green, SCHEDULED amber, DRAFT grey.
function snapshotPill(status) {
  const s = String(status || 'DRAFT');
  const tone = s === 'ACTIVE' || s === 'VALIDATED' ? 'green' : s === 'SCHEDULED' ? 'amber' : 'grey';
  return '<span class="pill ' + tone + '">' + escapeHtml(s) + '</span>';
}

// Per-row workflow actions mirror the promotions publish flow (Save draft →
// Validate → SCHEDULED → ACTIVE, rollback-to-draft for rework). ACTIVE rows
// are immutable — no buttons, only the pill.
function snapshotActions(s) {
  const id = escapeHtml(s.id || '');
  const st = String(s.status || 'DRAFT');
  if (st === 'DRAFT') {
    return '<button class="tb-btn ghost" data-snap-act="VALIDATED" data-snap-id="' + id + '">Validate</button>';
  }
  if (st === 'VALIDATED') {
    return '<button class="tb-btn ghost" data-snap-act="SCHEDULED" data-snap-id="' + id + '">Approve</button> ' +
      '<button class="tb-btn ghost" data-snap-act="DRAFT" data-snap-id="' + id + '">Back to draft</button>';
  }
  if (st === 'SCHEDULED') {
    return '<button class="tb-btn primary" data-snap-act="ACTIVE" data-snap-id="' + id + '">Publish</button> ' +
      '<button class="tb-btn ghost" data-snap-act="DRAFT" data-snap-id="' + id + '">Back to draft</button>';
  }
  return '<small style="color:var(--muted)">immutable</small>';
}

function renderSnapshots(rows) {
  const tb = $('#metricsSnapshotsBody');
  const sub = $('#metricsSnapshotsSub');
  if (!tb) return;
  if (sub) sub.textContent = rows.length
    ? rows.length + ' snapshot(s) · newest effective date first · ACTIVE is authoritative'
    : 'No snapshots for this floor yet';
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="6"><div class="section-empty">No snapshots yet — save a draft for an effective date.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows.map((s) =>
    '<tr><td><b>' + escapeHtml(s.effectiveDate) + '</b></td>' +
    '<td>' + snapshotPill(s.status) + '</td>' +
    '<td><span class="pill">v' + escapeHtml(String(s.schemaVersion)) + '</span></td>' +
    '<td title="' + escapeHtml(s.geometryHash || '') + '">' + escapeHtml(String(s.geometryHash || '').slice(0, 12)) + '…</td>' +
    '<td><small>' + escapeHtml(s.publishedAt ? new Date(s.publishedAt).toLocaleString('en-SG') : (s.createdAt ? new Date(s.createdAt).toLocaleString('en-SG') : '—')) + '</small></td>' +
    '<td style="white-space:nowrap;">' + snapshotActions(s) + '</td></tr>'
  ).join('');
}

function renderEmpty(msg) {
  state.metrics.report = null;
  state.metrics.snapshots = [];
  renderKpis(null);
  renderSnapshots([]);
  metricsBanner(msg || '');
  setSub();
}

async function loadSnapshots(floorId) {
  try {
    state.metrics.snapshots = await get('/floor-plans/' + encodeURIComponent(floorId) + '/metrics/snapshots');
  } catch (e) {
    state.metrics.snapshots = [];
    throw e;
  }
  renderSnapshots(state.metrics.snapshots);
}

export async function refreshMetricsView() {
  const floorId = state.fp.floorId;
  if (!floorId) {
    renderEmpty('');
    return;
  }
  const seq = ++state.metrics.seq;
  state.metrics.floorId = floorId;
  state.metrics.loading = true;
  metricsBanner('');
  setSub();
  try {
    const report = await get('/floor-plans/' + encodeURIComponent(floorId) + '/metrics');
    if (seq !== state.metrics.seq) return; // stale — a newer refresh won
    state.metrics.report = report;
    state.metrics.error = '';
    renderKpis(report);
    setSub();
    await loadSnapshots(floorId);
    if (seq !== state.metrics.seq) return;
  } catch (e) {
    if (seq !== state.metrics.seq) return;
    state.metrics.error = describeError(e);
    if (e instanceof ApiError && e.status === 404) {
      renderEmpty('No floor plan on this floor yet — save a canvas in the Floor Plan Designer above first.');
    } else {
      renderEmpty('Metrics: ' + describeError(e));
    }
    return;
  } finally {
    if (seq === state.metrics.seq) state.metrics.loading = false;
  }
}

// Debounced refresh for floor switches and canvas edits (~400ms): captures
// nothing — the timer reads the CURRENT editor floor when it fires, so rapid
// floor switches recompute the latest floor only, never a stale one.
export function scheduleMetricsRefresh() {
  clearTimeout(metricsTimer);
  metricsTimer = setTimeout(() => {
    refreshMetricsView().catch(() => {});
  }, 400);
}

// Called by the floor-plan editor after every persisted geometry change
// (placements, blocks, canvas saves, door toggles) and after plan loads.
export function notifyMetricsFloorChanged() {
  scheduleMetricsRefresh();
}

// Save draft = POST a DRAFT row (never blocked: validation warnings AND
// errors persist as draft-blocked state in payload.validation). Mirrors the
// promotions Save-draft step — no confirm, just persist + reload.
async function saveDraftSnapshot(btn) {
  const floorId = state.fp.floorId;
  if (!floorId) {
    metricsBanner('Pick a floor in the editor above first.');
    return;
  }
  const dateEl = $('#metricsPublishDate');
  const date = dateEl && dateEl.value ? dateEl.value : todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    metricsBanner('Effective date must be YYYY-MM-DD.');
    return;
  }
  if (btn) btn.disabled = true;
  try {
    await post('/floor-plans/' + encodeURIComponent(floorId) + '/metrics/snapshots', { effective_date: date });
    const r = state.metrics.report;
    const errors = r && r.validation ? r.validation.filter((v) => v.severity === 'error') : [];
    metricsBanner(
      errors.length
        ? 'Draft saved for ' + date + ' with ' + errors.length + ' blocking error(s) — resolve them before Validate.'
        : 'Draft saved for ' + date + ' (DRAFT).',
      true,
    );
    await loadSnapshots(floorId);
  } catch (e) {
    metricsBanner('Save draft: ' + describeError(e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

const SNAPSHOT_STEP_COPY = {
  VALIDATED: { title: 'Validate snapshot?', message: 'Moves DRAFT → VALIDATED. The server recomputes live metrics — zero blocking ERRORs required.', confirmLabel: 'Validate' },
  SCHEDULED: { title: 'Approve snapshot?', message: 'Moves VALIDATED → SCHEDULED (approved, pending publish). Requires the promotions.approve permission when your operator holds permission rows.', confirmLabel: 'Approve' },
  ACTIVE: { title: 'Publish snapshot?', message: 'Moves SCHEDULED → ACTIVE. The payload refreshes to fresh canvas truth and the row becomes immutable — corrections need a new draft.', confirmLabel: 'Publish' },
  DRAFT: { title: 'Send back to draft?', message: 'Rolls the snapshot back to DRAFT for rework. No data is lost.', confirmLabel: 'Back to draft' },
};

// One workflow step: confirmDialog → PATCH :id/status → banner + reload.
// Mirrors the promotions admin.js publish flow (confirm, walk one edge,
// surface blockers / permission errors, debounced refresh left intact).
async function transitionSnapshot(id, to) {
  const floorId = state.fp.floorId;
  const copy = SNAPSHOT_STEP_COPY[to] || { title: 'Change snapshot status?', message: '', confirmLabel: 'Confirm' };
  const stepOk = await confirmDialog({ title: copy.title, message: copy.message, confirmLabel: copy.confirmLabel });
  if (!stepOk) return;
  try {
    await patch('/floor-plans/metrics/snapshots/' + encodeURIComponent(id) + '/status', { status: to });
    const done = to === 'ACTIVE' ? 'published (ACTIVE, immutable)' : to === 'DRAFT' ? 'back to draft' : to;
    metricsBanner('Snapshot ' + done + '.', true);
    if (floorId) await loadSnapshots(floorId);
  } catch (e) {
    if (e instanceof ApiError && e.status === 400 && e.code === 'VALIDATION_FAILED') {
      const blockers = (e.details && e.details.blockers) || [];
      const codes = blockers.map((v) => (v && v.code ? v.code : 'ERROR') + ': ' + ((v && v.message) || 'blocked')).join(' · ');
      metricsBanner('Blocked: ' + blockers.length + ' validation blocker(s)' + (codes ? ' — ' + codes : '.'), false);
    } else if (e instanceof ApiError && e.status === 403) {
      metricsBanner('Approve: ' + describeError(e) + ' (ask an approver, or save rework as a new draft).');
    } else {
      metricsBanner('Status: ' + describeError(e));
    }
  }
}

export function wireMetricsPanel() {
  if (wired) return;
  wired = true;
  const dateEl = $('#metricsPublishDate');
  if (dateEl && !dateEl.value) dateEl.value = todayIso();
  $('#metricsRefreshBtn')?.addEventListener('click', () => {
    refreshMetricsView().catch(() => {});
  });
  $('#metricsSaveDraftBtn')?.addEventListener('click', (ev) => {
    saveDraftSnapshot(ev.currentTarget).catch((e) => metricsBanner('Save draft: ' + describeError(e)));
  });
  // Delegated per-row workflow buttons (tbody persists across re-renders).
  $('#metricsSnapshotsBody')?.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-snap-act]') : null;
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    transitionSnapshot(btn.getAttribute('data-snap-id'), btn.getAttribute('data-snap-act'))
      .catch((e) => metricsBanner('Status: ' + describeError(e)))
      .finally(() => { btn.disabled = false; });
  });
}

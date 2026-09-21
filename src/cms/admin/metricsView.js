// StoreLah CMS admin UI — floor-plan area metrics panel (Phase 3, read-only).
// Lives inside #facility-floorplans under the editor (#metricsCard). Follows
// the existing *View.js + DI pattern: this module owns all #metrics* DOM
// wiring, imports only dom/api/state/confirmDialog (never the admin.js entry),
// and is attached once via wireMetricsPanel() from the entry's wireEvents().
//
// Data comes ONLY from the Phase-2 endpoints for the editor's selected floor
// (state.fp.floorId): GET /floor-plans/:floorId/metrics (live compute —
// client preview, advisory) and GET/POST .../metrics/snapshots (server
// snapshot, authoritative). Floor switches and canvas edits schedule a
// debounced (~400ms) refresh of the affected floor only; out-of-order
// responses are dropped via a sequence guard. All customer strings are
// escaped; destructive confirms reuse confirmDialog (no window.confirm).

import { $, escapeHtml } from './dom.js';
import { get, post, describeError, ApiError } from './api.js';
import { confirmDialog } from './confirmDialog.js';
import { state } from './state.js';

let metricsTimer = null;
let wired = false;

const fmtSqft = (n) => Number(n || 0).toLocaleString('en-SG', { maximumFractionDigits: 1 });
const fmtPct = (n) => (Number(n || 0) * 100).toFixed(2) + '%';
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
    ? where + (r ? ' · live compute — the published snapshot is authoritative' : ' · live compute from the current canvas')
    : 'Pick a floor in the editor above — metrics follow the editor selection';
  const title = $('#metricsTitle');
  if (title) title.textContent = 'Area metrics' + (where ? ' — ' + where : '');
}

function statCard(label, value, sub) {
  return '<div class="stat"><div class="label">' + escapeHtml(label) + '</div><div class="val">' +
    escapeHtml(value) + '</div>' + (sub ? '<div class="trend">' + escapeHtml(sub) + '</div>' : '') + '</div>';
}

function renderKpis(r) {
  const el = $('#metricsKpis');
  if (!el) return;
  if (!r) {
    el.innerHTML = '';
    return;
  }
  const g = r.geometry || {};
  const sqft = (a) => (a && a.sqft != null ? fmtSqft(a.sqft) : '—');
  // UFA is LINE-ONLY (marked-area, never the whole canvas): prefer the
  // authoritative boundaryMetrics.ufa; with no contributing marked line
  // (boundaryClosed false) the KPI is 0 with an explicit "no marked area"
  // empty state. GFA is untouched (operator-entered vs canvas fallback).
  const bm = r.boundaryMetrics || null;
  const ufaSqft = bm ? bm.ufa : (g.ufa && g.ufa.sqft);
  const ufaSub = !bm ? 'usable floor area' : (bm.boundaryClosed ? 'usable floor area · line-only' : 'no marked area — draw lines to measure');
  const circRatio = g.gfa && g.gfa.sqft > 0 && g.derivedCirculation ? g.derivedCirculation.sqft / g.gfa.sqft : 0;
  el.innerHTML = [
    statCard('GFA', sqft(g.gfa), 'gross floor area'),
    statCard('UFA', ufaSqft != null ? fmtSqft(ufaSqft) : '—', ufaSub),
    statCard('NLA enclosed', sqft(g.nlaEnclosed), 'billable, enclosed'),
    statCard('NLA outdoor', sqft(g.nlaOutdoor), 'billable, outdoor'),
    statCard('NLA total', sqft(g.nlaTotal), 'enclosed + outdoor'),
    statCard('GLA exclusive', sqft(g.glaExclusive && g.glaExclusive.area), '= NLA · exclusive'),
    statCard('GLA inclusive', sqft(g.glaInclusive && g.glaInclusive.area), '= NLA + COMMON · inclusive'),
    statCard('Efficiency', fmtPct(g.efficiency), 'NLA enclosed / GFA'),
    statCard('Load factor', Number(g.loadFactor || 0).toFixed(4) + '×', 'GLA inclusive / NLA'),
    statCard('Circulation ratio', fmtPct(circRatio), 'derived circulation / GFA'),
    statCard('Units', String((r.coverage && r.coverage.placedUnits) || 0), ((r.coverage && r.coverage.unplacedUnits) || 0) + ' unplaced'),
    statCard('Cubic capacity', fmtSqft(r.volumetric && r.volumetric.totalCubicFt), 'clear area × ceiling'),
  ].join('');
}

function renderSnapshots(rows) {
  const tb = $('#metricsSnapshotsBody');
  const sub = $('#metricsSnapshotsSub');
  if (!tb) return;
  if (sub) sub.textContent = rows.length
    ? rows.length + ' snapshot(s) · append-only · newest effective date first'
    : 'No snapshots published for this floor yet';
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="4"><div class="section-empty">No snapshots yet — publish one for an effective date.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows.map((s) =>
    '<tr><td><b>' + escapeHtml(s.effectiveDate) + '</b></td>' +
    '<td><span class="pill">v' + escapeHtml(String(s.schemaVersion)) + '</span></td>' +
    '<td title="' + escapeHtml(s.geometryHash || '') + '">' + escapeHtml(String(s.geometryHash || '').slice(0, 12)) + '…</td>' +
    '<td><small>' + escapeHtml(s.createdAt ? new Date(s.createdAt).toLocaleString('en-SG') : '—') + '</small></td></tr>'
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
      renderEmpty('No floor plan on this floor yet — save a canvas in the editor above first.');
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

async function publishSnapshot() {
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
  const r = state.metrics.report;
  const errors = r && r.validation ? r.validation.filter((v) => v.severity === 'error') : [];
  const publishOk = await confirmDialog({
    title: 'Publish snapshot for ' + date + '?',
    message: errors.length
      ? errors.length + ' blocking ERROR(s) exist — the server will reject this publish (422). Publish anyway to confirm?'
      : 'Appends an immutable snapshot row for this floor. The server recomputes live metrics at publish time; invalid geometry is never persisted.',
    confirmLabel: 'Publish',
  });
  if (!publishOk) return;
  try {
    await post('/floor-plans/' + encodeURIComponent(floorId) + '/metrics/snapshots', { effective_date: date });
    metricsBanner('Snapshot published for ' + date + '.', true);
    await loadSnapshots(floorId);
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) {
      const details = (e.details && e.details.validation) || [];
      const codes = details.map((v) => (v && v.code ? v.code : 'ERROR') + ': ' + ((v && v.message) || 'blocked')).join(' · ');
      metricsBanner('Publish blocked (422): ' + details.length + ' blocking error(s)' + (codes ? ' — ' + codes : '.'), false);
    } else {
      metricsBanner('Publish: ' + describeError(e));
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
  $('#metricsPublishBtn')?.addEventListener('click', () => {
    publishSnapshot().catch((e) => metricsBanner('Publish: ' + describeError(e)));
  });
}

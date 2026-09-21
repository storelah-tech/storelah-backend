// StoreLah CMS admin UI — dashboard view: KPI strip, Chart.js bindings, unit map.
// Extracted from admin.js (phase-3 layering refactor; nodebestpractices #1).
// Presentation only: reads shared state via the selectors in state.js, fetches
// through api.js, renders into the frozen markup. `Chart` is the global set up
// by the dashboard's chart.umd <script> tag — deliberately not imported.

import { MAP_TONE, SIZE_COLOR, SIZE_CLASS, fmtMoney } from './constants.js';
import { $, $$, escapeHtml, showBanner } from './dom.js';
import { get, describeError } from './api.js';
import { state, branchByCode, branchFloors, ensureActiveLevel, isAllFacilities } from './state.js';

// ---------- dashboard bindings (mirror frozen data-layer.js) ----------
const kpiVal = (i) => $$('.kpi-strip .kpi')[i]?.querySelector('.kpi-val');
const kpiDelta = (i) => $$('.kpi-strip .kpi')[i]?.querySelector('.kpi-delta');

export function bindKpis(s) {
  if (!s || !s.kpis) return;
  const k = s.kpis;
  const setK = (i, val, unit) => {
    const el = kpiVal(i);
    if (!el) return;
    el.innerHTML = val + (unit ? `<span class="unit">${unit}</span>` : '');
  };
  setK(0, k.occupancyPct, '%');
  setK(1, k.totalUnits, '');
  if (kpiDelta(1)) kpiDelta(1).textContent = `${k.occupiedUnits} occ · ${k.totalUnits - k.occupiedUnits} avail`;
  setK(2, k.overdueUnits, ' units');
  setK(3, fmtMoney(k.mrr));
  setK(4, k.avgPsf);
}

export function bindCharts(s) {
  if (!s) return;
  if (s.monthlyRevenue) {
    const rc = Chart.getChart && Chart.getChart('revenueChart');
    if (rc) {
      rc.data.labels = s.monthlyRevenue.labels;
      rc.data.datasets[0].data = s.monthlyRevenue.actual;
      rc.data.datasets[1].data = s.monthlyRevenue.target;
      rc.update();
    }
  }
  if (s.occupancyByBranch) {
    const bc = Chart.getChart && Chart.getChart('branchChart');
    if (bc) {
      bc.data.labels = s.occupancyByBranch.map((b) => b.name);
      bc.data.datasets[0].data = s.occupancyByBranch.map((b) => b.occupancyPct);
      bc.update();
    }
  }
}

// ---------- unit map (data-driven; the 25-cell shell is the no-JS fallback) ----------
export function renderFloorTabs() {
  const tabs = $('#floorTabs');
  if (!tabs) return;
  if (isAllFacilities()) return; // tabs hidden — no single facility's floors to show
  // branchFloors() is active-only: inactive (hidden) levels never render as
  // selectable tabs. A stale state.level (e.g. just deactivated) falls back
  // to the first active level so the map + table never query a hidden floor.
  if (ensureActiveLevel(state.branchCode) == null) {
    // Edge: branch with no active floor — empty-state text, not broken tabs.
    tabs.innerHTML = '<div class="t-type" style="padding:8px 4px;">No active floors for this facility — reactivate one in Floors.</div>';
    return;
  }
  const floors = branchFloors(state.branchCode);
  tabs.innerHTML = floors
    .map(
      (f) =>
        `<button class="floor-tab ${f.level === state.level ? 'active' : ''}" data-level="${f.level}">Level ${f.level}</button>`,
    )
    .join('');
}

// Grouped unit map: one column per size in canonical order. Buckets derive
// from map.units (the visible set — branch/level/?size=/nearLift already
// applied server-side), so branch/level switching re-groups for free and
// ?size= composes by narrowing within columns. Size display names prefer
// map.sizes (same visible set), then the unit payload, then the labels below.
const MAP_SIZE_ORDER = ['LOCKER', 'SMALL', 'MEDIUM', 'LARGE'];
const MAP_SIZE_NAME = { LOCKER: 'Locker', SMALL: 'Small', MEDIUM: 'Medium', LARGE: 'Large' };

// Single-unit cell markup (unchanged visuals + wiring: status fill/dot via
// MAP_TONE, size ribbon/chip via SIZE_CLASS, tooltip, inline selectUnit() so
// the detail-panel click binding keeps working inside columns).
function unitCellHtml(u) {
  const tone = MAP_TONE[u.status.toUpperCase()] || 'available';
  const sizeCode = String((u.sizeInfo && u.sizeInfo.code) || u.sizeCode || '').toUpperCase();
  const sizeCls = SIZE_CLASS[sizeCode] || 'size-OTHER';
  const psf = u.psf ? '$' + Number(u.psf).toFixed(2) : 'Maint.';
  const sizeName = (u.sizeInfo && u.sizeInfo.name) || u.size || sizeCode;
  const tip = `${u.code} · ${sizeName} (${sizeCode}) · ${u.sqft} sq ft · ${u.status}`;
  return `<div class="u-cell ${tone} ${sizeCls}" title="${escapeHtml(tip)}" onclick="selectUnit(this,'${escapeHtml(u.code)}')"><div class="u-dot"></div><div class="u-id">${escapeHtml(u.short)}</div><div class="u-size">${escapeHtml(sizeName)}</div><div class="u-psf">${psf}</div></div>`;
}

function renderUnitMap(map) {
  const title = $('#unitMapTitle');
  const legend = $('#mapLegend');
  const grid = $('#unitGrid');
  const b = branchByCode(state.branchCode);
  if (title) title.textContent = `Unit Map — ${b ? b.name : state.branchCode} · Level ${state.level}`;
  if (legend && map && map.legend) {
    const L = map.legend;
    const items = [
      ['Occupied', L.occupied, 'var(--teal)'],
      ['Available', L.available, 'var(--olive)'],
      ['Reserved', L.reserved, 'var(--amber)'],
      ['Overdue', L.overdue, 'var(--red)'],
      ['Maintenance', L.maintenance, 'var(--light)'],
      // P1 item 3: BLOCKED legend parity with the UnitStatus enum.
      ['Blocked', L.blocked || 0, '#8a8478'],
    ];
    legend.innerHTML = items
      .map(
        ([label, count, color]) =>
          `<div class="u-leg"><div class="u-leg-dot" style="background:${color};"></div>${label} (${count})</div>`,
      )
      .join('');
    // Size legend (additive — the status legend above is untouched). Counts come
    // from map.sizes (same visible set as the status legend); payloads without
    // it fall back to counting map.units client-side. Convention (see
    // docs/FLOORS.md "Map size legend"): cell fill + corner dot = status, top
    // ribbon + size chip = size.
    const sizeGroups = map.sizes && map.sizes.length ? map.sizes : countSizesLocal(map.units || []);
    if (sizeGroups.length) {
      legend.innerHTML += '<div class="u-leg u-leg-hdr">Sizes:</div>' + sizeGroups
        .map((g) => {
          const code = String(g.code || '').toUpperCase();
          const color = SIZE_COLOR[code] || '#8a8478';
          const b = g.byStatus || {};
          const tip = `${g.name}: ${g.total} total · avail ${b.available || 0} · occ ${b.occupied || 0} · res ${b.reserved || 0} · over ${b.overdue || 0}`;
          return `<div class="u-leg" title="${escapeHtml(tip)}"><div class="u-leg-dot" style="background:${color};"></div>${escapeHtml(g.name)} (${g.total})</div>`;
        })
        .join('');
    }
  }
  renderFloorTabs();
  if (!grid || !map || !map.units) return;
  // Grouped columns: empty groups keep header + count 0 + empty-state text
  // (the column is never collapsed). With ?size= active the server already
  // narrows map.units, so off-filter columns render empty + dimmed while the
  // matching column stays full. Column counts equal the size-legend counts
  // for present sizes (both derive from the same visible set).
  grid.classList.add('map-grouped');
  const sizeMeta = map.sizes && map.sizes.length ? map.sizes : countSizesLocal(map.units || []);
  const metaByCode = new Map(sizeMeta.map((g) => [String(g.code || '').toUpperCase(), g]));
  const buckets = new Map(MAP_SIZE_ORDER.map((c) => [c, []]));
  const extraBuckets = new Map(); // unknown size codes (not in seed data): trailing columns, never dropped
  for (const u of map.units) {
    const code = String((u.sizeInfo && u.sizeInfo.code) || u.sizeCode || '').toUpperCase();
    if (buckets.has(code)) buckets.get(code).push(u);
    else {
      if (!extraBuckets.has(code)) extraBuckets.set(code, []);
      extraBuckets.get(code).push(u);
    }
  }
  const activeSize = String(state.mapSize || '').toUpperCase();
  const columnHtml = (code, units) => {
    const meta = metaByCode.get(code);
    const name = (meta && meta.name)
      || (units[0] && ((units[0].sizeInfo && units[0].sizeInfo.name) || units[0].size))
      || MAP_SIZE_NAME[code] || code;
    const color = SIZE_COLOR[code] || '#8a8478';
    const dimmed = activeSize && code !== activeSize ? ' is-dimmed' : '';
    const body = units.length
      ? units.map(unitCellHtml).join('')
      : `<div class="map-col-empty">No ${escapeHtml(name)} units on this floor.</div>`;
    return `<div class="map-col${dimmed}" data-size="${escapeHtml(code)}"><div class="map-col-hdr"><div class="u-leg-dot" style="background:${color};"></div>${escapeHtml(name)}<span class="map-col-count">${units.length}</span></div><div class="map-col-body">${body}</div></div>`;
  };
  grid.innerHTML = MAP_SIZE_ORDER.map((code) => columnHtml(code, buckets.get(code))).join('') +
    [...extraBuckets.entries()].map(([code, units]) => columnHtml(code, units)).join('');
  paintMapSizeCounts(map);
}

// Client-side fallback for the size legend + filter counts when a map payload
// predates the `sizes` grouping (same visible set as the status legend).
function countSizesLocal(units) {
  const groups = new Map();
  for (const u of units || []) {
    const code = String((u.sizeInfo && u.sizeInfo.code) || u.sizeCode || '?').toUpperCase();
    const name = (u.sizeInfo && u.sizeInfo.name) || u.size || code;
    let g = groups.get(code);
    if (!g) {
      g = { code, name, total: 0, byStatus: {} };
      groups.set(code, g);
    }
    g.total += 1;
    const st = String(u.status || '').toLowerCase();
    g.byStatus[st] = (g.byStatus[st] || 0) + 1;
  }
  return [...groups.values()];
}

// Paint per-size counts into the existing size-filter options ("Small (24)")
// from the map's size grouping; the selected value is preserved. Labels are
// rebuilt from a cached base each fetch so counts never stack.
function paintMapSizeCounts(map) {
  const sel = $('#mapSizeFilter');
  if (!sel) return;
  const groups = map.sizes && map.sizes.length ? map.sizes : countSizesLocal(map.units || []);
  const byCode = new Map(groups.map((g) => [String(g.code).toUpperCase(), g.total]));
  const total = groups.reduce((n, g) => n + (g.total || 0), 0);
  [...sel.options].forEach((o) => {
    if (o.dataset.base == null) o.dataset.base = o.textContent.replace(/\s*\(\d+\)\s*$/, '');
    const n = o.value ? (byCode.get(o.value.toUpperCase()) ?? 0) : total;
    o.textContent = `${o.dataset.base} (${n})`;
  });
}

export async function fetchUnitMap() {
  if (isAllFacilities()) return; // syncFacilityDashboard renders the ALL placeholder instead
  // Clamp a stale level (e.g. just deactivated) to the first active level so
  // branch+level switching never queries a hidden floor. No active floor →
  // empty-state text, not a fetch against a hidden level.
  if (ensureActiveLevel(state.branchCode) == null) {
    renderFloorTabs();
    const grid = $('#unitGrid');
    if (grid) { grid.classList.remove('map-grouped'); grid.innerHTML = '<div class="t-type" style="padding:18px 4px;">No active floors for this facility — reactivate one in Floors.</div>'; }
    const title = $('#unitMapTitle');
    if (title) { const b = branchByCode(state.branchCode); title.textContent = `Unit Map — ${b ? b.name : state.branchCode}`; }
    return;
  }
  // P1 item 3: Near-lift + Size filters ride the map read path.
  const qs = new URLSearchParams({ branch: state.branchCode, level: String(state.level) });
  if (state.mapSize) qs.set('size', state.mapSize);
  if (state.mapNearLift) qs.set('nearLift', '1');
  const map = await get(`/units/map?${qs}`);
  renderUnitMap(map);
}

// P1 item 3: populate the map Size filter from /sizes (once per boot).
let mapSizesLoaded = false;
export async function ensureMapSizeFilter() {
  const sel = $('#mapSizeFilter');
  if (!sel || mapSizesLoaded) return;
  try {
    const sizes = await get('/sizes');
    sel.innerHTML = '<option value="">All sizes</option>' +
      (sizes || []).map((s) => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.name)}</option>`).join('');
    mapSizesLoaded = true;
  } catch (e) { /* filter stays size-less; map still loads */ }
}

// Dashboard unit-map card under the facility filter: ALL shows a placeholder
// (a floor map is inherently per-facility); a concrete branch renders normally.
export function syncFacilityDashboard() {
  const tabs = $('#floorTabs');
  const grid = $('#unitGrid');
  const title = $('#unitMapTitle');
  if (isAllFacilities()) {
    if (tabs) tabs.style.display = 'none';
    if (title) title.textContent = 'Unit Map — All Facilities';
    // Placeholder is flat text, not size columns — drop the grouped class so
    // the 4/2-col grid doesn't apply; renderUnitMap re-adds it per fetch.
    if (grid) { grid.classList.remove('map-grouped'); grid.innerHTML = '<div class="t-type" style="padding:18px 4px;">Select a facility above to view its floor map.</div>'; }
  } else {
    if (tabs) tabs.style.display = '';
    renderFloorTabs();
    fetchUnitMap().catch((err) => showBanner('Map: ' + describeError(err)));
  }
}

// ---------- charts (frozen configs) ----------
export function initCharts() {
  const rCtx = $('#revenueChart')?.getContext('2d');
  if (rCtx && !Chart.getChart('revenueChart')) {
    new Chart(rCtx, {
      type: 'bar',
      data: {
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
        datasets: [
          { label: 'Actual', data: [36200, 37800, 38500, 39200, 40100, 41600, 42860], backgroundColor: (ctx) => (ctx.dataIndex === 6 ? '#c97952' : '#e6e0d7'), borderRadius: 5, borderSkipped: false },
          { label: 'Target', data: [38000, 38000, 39000, 39000, 40000, 41000, 42000], type: 'line', borderColor: '#526557', borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, fill: false, tension: 0.3 },
        ],
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#6f746d' } }, y: { grid: { color: '#ede8e2' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#6f746d', callback: (v) => '$' + (v / 1000).toFixed(0) + 'k' } } } },
    });
  }
  const bCtx = $('#branchChart')?.getContext('2d');
  if (bCtx && !Chart.getChart('branchChart')) {
    new Chart(bCtx, {
      type: 'bar',
      data: { labels: ['Bukit Merah', 'Woodlands', 'Ubi'], datasets: [{ data: [87.5, 91.2, 82.0], backgroundColor: ['#c97952', '#526557', '#547b8d'], borderRadius: 7, borderSkipped: false }] },
      options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: '#ede8e2' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#6f746d', callback: (v) => v + '%' }, max: 100 }, y: { grid: { display: false }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#20241f' } } } },
    });
  }
  const pCtx = $('#psfChart')?.getContext('2d');
  if (pCtx && !Chart.getChart('psfChart')) {
    new Chart(pCtx, {
      type: 'scatter',
      data: {
        datasets: [
          { label: 'Locker', data: [{ x: 12, y: 5.2 }, { x: 15, y: 5.1 }, { x: 18, y: 5.3 }, { x: 10, y: 5.4 }, { x: 20, y: 5.0 }], backgroundColor: '#c97952', pointRadius: 5 },
          { label: 'Small', data: [{ x: 30, y: 4.8 }, { x: 35, y: 4.7 }, { x: 28, y: 4.9 }, { x: 40, y: 4.6 }, { x: 32, y: 4.8 }], backgroundColor: '#526557', pointRadius: 5 },
          { label: 'Medium', data: [{ x: 60, y: 4.4 }, { x: 65, y: 4.3 }, { x: 70, y: 4.5 }, { x: 55, y: 4.45 }], backgroundColor: '#334437', pointRadius: 5 },
          { label: 'Large', data: [{ x: 120, y: 3.8 }, { x: 130, y: 3.7 }, { x: 110, y: 3.9 }], backgroundColor: '#e5a84b', pointRadius: 5 },
          { label: 'XL Biz', data: [{ x: 200, y: 3.2 }, { x: 220, y: 3.1 }, { x: 180, y: 3.3 }], backgroundColor: '#547b8d', pointRadius: 5 },
        ],
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: '#ede8e2' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#6f746d', callback: (v) => v + ' sqft' } }, y: { grid: { color: '#ede8e2' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#6f746d', callback: (v) => '$' + v } } } },
    });
  }
}

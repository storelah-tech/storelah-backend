// StoreLah CMS admin UI — dashboard view: KPI strip, Chart.js bindings, unit map.
// Extracted from admin.js (phase-3 layering refactor; nodebestpractices #1).
// Presentation only: reads shared state via the selectors in state.js, fetches
// through api.js, renders into the frozen markup. `Chart` is the global set up
// by the dashboard's chart.umd <script> tag — deliberately not imported.

import { MAP_TONE, fmtMoney } from './constants.js';
import { $, $$, escapeHtml, showBanner } from './dom.js';
import { get, describeError } from './api.js';
import { state, branchByCode, branchFloors, isAllFacilities } from './state.js';

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
  const floors = branchFloors(state.branchCode);
  if (!floors.length) return;
  tabs.innerHTML = floors
    .map(
      (f) =>
        `<button class="floor-tab ${f.level === state.level ? 'active' : ''}" data-level="${f.level}">Level ${f.level}</button>`,
    )
    .join('');
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
    ];
    legend.innerHTML = items
      .map(
        ([label, count, color]) =>
          `<div class="u-leg"><div class="u-leg-dot" style="background:${color};"></div>${label} (${count})</div>`,
      )
      .join('');
  }
  renderFloorTabs();
  if (!grid || !map || !map.units) return;
  grid.innerHTML = map.units
    .map((u) => {
      const tone = MAP_TONE[u.status.toUpperCase()] || 'available';
      const psf = u.psf ? '$' + Number(u.psf).toFixed(2) : 'Maint.';
      return `<div class="u-cell ${tone}" onclick="selectUnit(this,'${escapeHtml(u.code)}')"><div class="u-dot"></div><div class="u-id">${escapeHtml(u.short)}</div><div class="u-size">${escapeHtml(u.size)}</div><div class="u-psf">${psf}</div></div>`;
    })
    .join('');
}

export async function fetchUnitMap() {
  if (isAllFacilities()) return; // syncFacilityDashboard renders the ALL placeholder instead
  const map = await get(`/units/map?branch=${encodeURIComponent(state.branchCode)}&level=${state.level}`);
  renderUnitMap(map);
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
    if (grid) grid.innerHTML = '<div class="t-type" style="padding:18px 4px;">Select a facility above to view its floor map.</div>';
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
          { label: 'Actual', data: [36200, 37800, 38500, 39200, 40100, 41600, 42860], backgroundColor: (ctx) => (ctx.dataIndex === 6 ? '#B86A4A' : '#E9E1D0'), borderRadius: 5, borderSkipped: false },
          { label: 'Target', data: [38000, 38000, 39000, 39000, 40000, 41000, 42000], type: 'line', borderColor: '#5A7A60', borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, fill: false, tension: 0.3 },
        ],
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#9C948D' } }, y: { grid: { color: '#F3EEE6' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#9C948D', callback: (v) => '$' + (v / 1000).toFixed(0) + 'k' } } } },
    });
  }
  const bCtx = $('#branchChart')?.getContext('2d');
  if (bCtx && !Chart.getChart('branchChart')) {
    new Chart(bCtx, {
      type: 'bar',
      data: { labels: ['Bukit Merah', 'Woodlands', 'Ubi'], datasets: [{ data: [87.5, 91.2, 82.0], backgroundColor: ['#B86A4A', '#5A7A60', '#0B4F5E'], borderRadius: 7, borderSkipped: false }] },
      options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: '#F3EEE6' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#9C948D', callback: (v) => v + '%' }, max: 100 }, y: { grid: { display: false }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#6B6560' } } } },
    });
  }
  const pCtx = $('#psfChart')?.getContext('2d');
  if (pCtx && !Chart.getChart('psfChart')) {
    new Chart(pCtx, {
      type: 'scatter',
      data: {
        datasets: [
          { label: 'Locker', data: [{ x: 12, y: 5.2 }, { x: 15, y: 5.1 }, { x: 18, y: 5.3 }, { x: 10, y: 5.4 }, { x: 20, y: 5.0 }], backgroundColor: '#B86A4A', pointRadius: 5 },
          { label: 'Small', data: [{ x: 30, y: 4.8 }, { x: 35, y: 4.7 }, { x: 28, y: 4.9 }, { x: 40, y: 4.6 }, { x: 32, y: 4.8 }], backgroundColor: '#5A7A60', pointRadius: 5 },
          { label: 'Medium', data: [{ x: 60, y: 4.4 }, { x: 65, y: 4.3 }, { x: 70, y: 4.5 }, { x: 55, y: 4.45 }], backgroundColor: '#0B4F5E', pointRadius: 5 },
          { label: 'Large', data: [{ x: 120, y: 3.8 }, { x: 130, y: 3.7 }, { x: 110, y: 3.9 }], backgroundColor: '#D4860A', pointRadius: 5 },
          { label: 'XL Biz', data: [{ x: 200, y: 3.2 }, { x: 220, y: 3.1 }, { x: 180, y: 3.3 }], backgroundColor: '#9C948D', pointRadius: 5 },
        ],
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: '#F3EEE6' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#9C948D', callback: (v) => v + ' sqft' } }, y: { grid: { color: '#F3EEE6' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#9C948D', callback: (v) => '$' + v } } } },
    });
  }
}

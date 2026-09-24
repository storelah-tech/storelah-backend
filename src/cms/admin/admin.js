// StoreLah CMS admin UI — v8 design with leads centrepiece + all existing CRUD.
// Talks to /api/v1/cms endpoints. Preserves all unit/tenant/booking/floorplan views.
import { ALL_FACILITIES } from './constants.js';
import { $, $$, escapeHtml, timeAgo, showBanner, initSelectAll, resetSelectAll } from './dom.js';
import { login, get, post, put, patch, del, describeError, getCurrentUser } from './api.js';
import { confirmDialog } from './confirmDialog.js';
import { state, ensureActiveLevel, isAllFacilities } from './state.js';
import { createDateFilter, withDateQuery, isRangeActive, rangeLabel, rangeEmptyText } from './dateFilter.js';
import { refreshBookingsView, bindBookingsTable, refreshMoveinsView } from './bookingsView.js';
import {
  initCharts, bindKpis, bindCharts, renderFloorTabs, fetchUnitMap, syncFacilityDashboard, ensureMapSizeFilter,
} from './dashboardView.js';
import {
  setRefreshAll as tenantsSetRefreshAll, bindTenantsView, refreshTenantsView,
  openCreateTenant, openEditTenant, closeTenantModal, submitTenantForm, deactivateTenant,
} from './tenantsView.js';
import {
  setRefreshAll as unitsSetRefreshAll, setRefsLoader as unitsSetRefsLoader,
  fetchUnitsPage, showUnitDetail, getSelectedUnitCode, onUnitSizeChange,
  populateFloorSelect, populateUnitLevelFilter, openCreateForm, openEditForm, closeUnitModal,
  submitUnitForm, deleteUnit, importUnitsFile, openRateForm, closeRateModal, submitRateForm,
} from './unitsView.js';
import { bindPortfolio, wirePortfolio } from './portfolioView.js';
import { bindQuotes, bindMoveouts, wireOpsQueues } from './opsQueuesView.js';
import { bindFeesSection, bindBusinessRulesSection, bindUsersSection, wireSettingsExt } from './settingsExtView.js';
import { bindExtrasSection, wireExtras } from './extrasView.js';
import {
  setRefreshAll as leadDrawerSetRefreshAll, setLeadDrawerActions, openLeadDrawer, wireLeadDrawer,
} from './leadsDetailDrawer.js';
import { setRefsLoader as fpSetRefsLoader, fpInitEvents, fpOpen, fpViewClose, getFpViewFloorId } from './floorplanView.js';
import { setRefreshAll as floorsSetRefreshAll, setRefsLoader as floorsSetRefsLoader, bindFloorsView, wireFloorsView } from './floorsView.js';
import { wireMetricsPanel, refreshMetricsView } from './metricsView.js';
import {
  bindMaintenance, bindAssets, bindIncidents, bindAccess, bindInspections,
  wireFacilitiesOps, updateFacilityBadge,
} from './facilitiesOps.js';

// ====================== TOAST ======================
function toast(msg) {
  const el = $('#toastEl');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3000);
}

// ====================== V8 NAVIGATION ======================
const coreMap = {
  command: 'command',
  portfolio: 'command',
  leads: 'leads', pipeline: 'leads', inbox: 'leads', calendar: 'leads', automation: 'leads',
  analytics: 'command',
  customers: 'customers',
  facilities: 'facilities',
  promotions: 'promotions',
  billing: 'billing',
  settings: 'settings',
};

const sideNav = {
  command: [['Command centre', 'command'], ['Facility portfolio', 'portfolio'], ['Performance dashboards', 'analytics']],
  leads: [['Lead database', 'leads'], ['Pipeline', 'pipeline'], ['Conversations', 'inbox'],
    ['Appointments', 'calendar'], ['Automation', 'automation']],
  customers: [['Tenants', 'customers', 'customer-tenants'], ['Bookings', 'customers', 'customer-bookings'],
    ['Move-ins', 'customers', 'customer-moveins'], ['Quotes', 'customers', 'customer-quotes'],
    ['Move-outs', 'customers', 'customer-moveouts']],
  facilities: [['Unit map', 'facilities', 'facility-map'], ['Units', 'facilities', 'facility-units'],
    ['Floors', 'facilities', 'facility-floors'], ['Floor plans', 'facilities', 'facility-floorplans'], ['Maintenance', 'facilities', 'facility-maintenance'],
    ['Assets & vendors', 'facilities', 'facility-assets'], ['Incidents', 'facilities', 'facility-incidents'],
    ['Access control', 'facilities', 'facility-access'], ['Inspections', 'facilities', 'facility-inspections'],
    ['Protection plans & addons', 'facilities', 'facility-extras']],
  promotions: [['Dashboard', 'promotions', 'promo-overview'], ['Discount plan builder', 'promotions', 'promo-discount-matrix'], ['Free months', 'promotions', 'promo-free-months'], ['Promo code builder', 'promotions', 'promo-code-builder'], ['Promotions library', 'promotions', 'promo-library'], ['History', 'promotions', 'promo-history'], ['Safeguards', 'promotions', 'promo-safeguards'], ['Performance', 'promotions', 'promo-performance']],
  billing: [['Overview', 'billing', 'bill-overview'], ['Invoices', 'billing', 'bill-invoices'],
    ['Arrears', 'billing', 'bill-arrears']],
  settings: [['Global Settings', 'settings']],
};

// Build submenu items from sideNav
document.querySelectorAll('[data-core-page]').forEach((n) => {
  const core = n.getAttribute('data-core-page');
  const items = sideNav[core] || [];
  if (!items.length) return;
  n.classList.add('has-children');
  const menu = document.createElement('div');
  menu.className = 'nav-submenu';
  menu.dataset.sideMenu = core;
  menu.innerHTML = items.map((x, i) =>
    '<button class="nav-subitem' + (i === 0 ? ' active' : '') + '" data-side-page="' + x[1] + '"' +
    (x[2] ? ' data-side-panel="' + x[2] + '"' : '') + '>' + x[0] + '</button>'
  ).join('');
  n.insertAdjacentElement('afterend', menu);
});

function expandCore(core) {
  document.querySelectorAll('[data-core-page]').forEach((n) =>
    n.classList.toggle('expanded', n.getAttribute('data-core-page') === core));
}

function activateSide(page, panel) {
  document.querySelectorAll('.nav-subitem').forEach((b) =>
    b.classList.toggle('active', b.dataset.sidePage === page && (!panel || b.dataset.sidePanel === panel)));
}

function closeAllViews() {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.module-panel').forEach((p) => p.classList.remove('active'));
  // Hide admin breakout views (backward compat)
  ['dashboard', 'units', 'tenants', 'bookings', 'moveins', 'floorplans'].forEach((v) => {
    const el = document.getElementById('view-' + v);
    if (el) el.hidden = true;
  });
}

function openPage(id) {
  closeAllViews();
  const core = coreMap[id] || id;
  document.body.classList.toggle('lead-context', core === 'leads');
  const page = document.getElementById(id);
  if (page) page.classList.add('active');
  document.querySelectorAll('[data-core-page]').forEach((n) =>
    n.classList.toggle('active', n.getAttribute('data-core-page') === core));
  expandCore(core);
  const first = document.querySelector('[data-side-menu="' + core + '"] [data-side-page="' + id + '"]');
  if (first) {
    // Exact-element activation (not page-wide): each submenu entry maps to a
    // distinct page, so only the clicked entry lights up.
    document.querySelectorAll('.nav-subitem').forEach((b) => b.classList.remove('active'));
    first.classList.add('active');
  }
  document.getElementById('sidebar')?.classList.remove('open');
  document.body.classList.remove('sb-open');
  window.scrollTo(0, 0);
  try { history.replaceState(null, '', '#' + id); } catch (e) { }
  // Notify admin state
  state.view = id;
  // Lazy load content
  if (id === 'command') {
    refreshCommandPage();
  }
  else if (id === 'portfolio') {
    bindPortfolio().catch((err) => showBanner('Portfolio: ' + describeError(err)));
  }
  else if (id === 'leads') bindLeadTable();
  else if (id === 'pipeline') bindPipeline();
  else if (id === 'inbox') bindInbox();
  else if (id === 'calendar') bindCalendar();
  else if (id === 'analytics') bindAnalytics();
  else if (id === 'automation') bindAutomation();
  else if (id === 'customers') {
    const firstTab = document.querySelector('[data-tabs="customer"] button');
    if (firstTab) firstTab.click();
  }
  else if (id === 'promotions') { bootPromotions(); bindPromotionsOverview(); }
  else if (id === 'billing') bindBilling();
  else if (id === 'settings') bindSettings();
  else if (id === 'facilities') {
    syncFacilityDashboard();
    updateFacilityBadge().catch(() => {});
    // Activate first facility tab
    const firstTab = document.querySelector('[data-tabs="facility"] button');
    if (firstTab) firstTab.click();
  }
}

function openPanel(page, panel) {
  openPage(page);
  setTimeout(() => {
    const tab = document.querySelector('[data-tab="' + panel + '"],[data-settings-tab="' + panel + '"]');
    if (tab) tab.click();
    else {
      // Scroll-anchor targets with no data-tab button — scroll to the panel.
      // Legacy anchor: the portfolio lived under #command as #command-portfolio
      // and is now its own #portfolio page; redirect stale callers there.
      if (panel === 'command-portfolio') { openPage('portfolio'); return; }
      const anchor = document.getElementById(panel);
      if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    activateSide(page, panel);
  }, 0);
}

function openCoreDefault(core) {
  const first = document.querySelector('[data-side-menu="' + core + '"] .nav-subitem');
  if (!first) { openPage(core); return; }
  const sp = first.dataset.sidePage;
  if (first.dataset.sidePanel) openPanel(sp, first.dataset.sidePanel);
  else { openPage(sp); activateSide(sp); }
}

// ====================== LEAD DATA BINDINGS ======================
const stageLabel = {
  NEW_ENQUIRY: 'New', CONTACTED: 'Contacted', VIEWING_BOOKED: 'Qualified',
  PROPOSAL_SENT: 'Quoted', WON: 'Won', LOST: 'Lost',
};
const stageKanbanLabel = {
  NEW_ENQUIRY: 'New Enquiry', CONTACTED: 'Contacted', VIEWING_BOOKED: 'Viewing Booked',
  PROPOSAL_SENT: 'Proposal Sent', WON: 'Won', LOST: 'Lost',
};

function leadHeatHtml(stage, rate) {
  const heat = stage === 'WON' || stage === 'PROPOSAL_SENT' ? 5 :
    stage === 'VIEWING_BOOKED' ? 4 : stage === 'CONTACTED' ? 3 : stage === 'NEW_ENQUIRY' ? 2 : 1;
  let html = '<div class="heat">';
  for (let i = 0; i < 5; i++) html += '<i' + (i < heat ? ' class="on"' : '') + '></i>';
  return html + '</div>';
}

function fmtDay(d) {
  return d ? new Date(d).toLocaleDateString('en-SG', { day: '2-digit', month: 'short' }) : '—';
}

// Flatten grouped leads to a flat array
function flattenLeads(data) {
  const flat = [];
  (data || []).forEach((col) => {
    (col.leads || []).forEach((l) => {
      flat.push({ ...l, stage: col.stage });
    });
  });
  return flat;
}

function applyLeadFilter(rows) {
  const st = state.leadStatusFilter;
  const src = state.leadSourceFilter;
  return (rows || []).filter((l) => {
    if (st && l.stage !== st) return false;
    if (src && String(l.source || '').toUpperCase() !== src) return false;
    return true;
  });
}

function nextActionLabel(l) {
  if (l.nextActionAt) return 'Due ' + fmtDay(l.nextActionAt);
  if (l.owner) return escapeHtml(l.owner);
  return '<small>' + (l.stage === 'NEW_ENQUIRY' ? 'Needs contact' : 'Follow-up') + '</small>';
}

function renderLeadPager(total) {
  const pages = Math.max(1, Math.ceil(total / state.leadPerPage));
  if (state.leadPage > pages) state.leadPage = pages;
  const num = $('#leadsPageNum');
  if (num) num.textContent = state.leadPage + ' / ' + pages;
  const prev = $('#leadsPagePrev');
  const next = $('#leadsPageNext');
  if (prev) prev.disabled = state.leadPage <= 1;
  if (next) next.disabled = state.leadPage >= pages;
}

function findLeadById(id) {
  return (state.leadsCache || []).find((l) => l.id === id);
}

async function refreshLeadsViews() {
  await Promise.all([bindLeadTable().catch(() => {}), bindPipeline().catch(() => {}), bindInbox().catch(() => {})]);
}

// ---------- lead CSV import / export ----------
function downloadCsv(filename, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

function exportLeadsCsv() {
  const rows = applyLeadFilter(state.leadsCache || []);
  if (!rows.length) { toast('Nothing to export'); return; }
  const header = ['id', 'name', 'type', 'segment', 'stage', 'source', 'size', 'branch', 'monthlyRate', 'owner', 'nextActionAt', 'email', 'mobile', 'note', 'createdAt'];
  const body = rows.map((l) => [l.id, l.name, l.type, l.segment, l.stage, l.source, l.size, l.branchCode, l.monthlyRate, l.owner, l.nextActionAt, l.email, l.mobile, l.note, l.createdAt]);
  const day = new Date().toISOString().slice(0, 10);
  downloadCsv('leads-' + day + '.csv', [header, ...body]);
  toast('Exported ' + rows.length + ' leads');
}

function parseCsv(text) {
  // Minimal RFC-4180 parse: quoted fields, escaped quotes, CRLF.
  const rows = [];
  let cur = [''];
  let inQ = false;
  const field = () => cur[cur.length - 1];
  const setField = (v) => { cur[cur.length - 1] = v; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { setField(field() + '"'); i++; }
        else inQ = false;
      } else setField(field() + c);
    } else if (c === '"') inQ = true;
    else if (c === ',') cur.push('');
    else if (c === '\n') { rows.push(cur); cur = ['']; }
    else if (c === '\r') { /* skip */ }
    else setField(field() + c);
  }
  if (cur.length > 1 || cur[0] !== '') rows.push(cur);
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

async function importLeadsCsv(file) {
  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length < 2) { toast('CSV is empty'); return; }
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const idx = (names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const ci = {
    name: idx(['name']), type: idx(['type']), source: idx(['source']), stage: idx(['stage']),
    size: idx(['size', 'preferredsize']), branch: idx(['branch', 'branchcode', 'facility']),
    rate: idx(['rate', 'monthlyrate', 'value']), owner: idx(['owner']),
    email: idx(['email']), mobile: idx(['mobile', 'phone']), note: idx(['note']),
  };
  if (ci.name < 0) { toast('CSV needs a "name" column'); return; }
  const branchByCode = {};
  (state.branches || []).forEach((b) => { branchByCode[b.code.toUpperCase()] = b.id; branchByCode[b.name.toUpperCase()] = b.id; });
  let okCount = 0;
  const errors = [];
  for (let r = 1; r < rows.length; r++) {
    const cell = (i) => (i >= 0 && i < rows[r].length ? String(rows[r][i]).trim() : '');
    const name = cell(ci.name);
    if (!name) continue;
    const body = { name };
    const type = cell(ci.type).toUpperCase();
    if (type === 'PERSONAL' || type === 'BUSINESS') body.type = type;
    const source = cell(ci.source).toUpperCase();
    if (['WEBSITE', 'WHATSAPP', 'REFERRAL', 'GOOGLE'].includes(source)) body.source = source;
    const stage = cell(ci.stage).toUpperCase();
    if (['NEW_ENQUIRY', 'CONTACTED', 'VIEWING_BOOKED', 'PROPOSAL_SENT', 'WON', 'LOST'].includes(stage)) body.stage = stage;
    if (ci.size >= 0 && cell(ci.size)) body.preferredSize = cell(ci.size);
    if (ci.branch >= 0 && cell(ci.branch)) {
      const id = branchByCode[cell(ci.branch).toUpperCase()];
      if (id) body.preferredBranchId = id;
    }
    if (ci.rate >= 0 && cell(ci.rate) !== '') {
      const n = Number(cell(ci.rate));
      if (n >= 0) body.monthlyRate = n;
    }
    if (ci.owner >= 0 && cell(ci.owner)) body.owner = cell(ci.owner);
    if (ci.email >= 0 && cell(ci.email)) body.email = cell(ci.email);
    if (ci.mobile >= 0 && cell(ci.mobile)) body.mobile = cell(ci.mobile);
    if (ci.note >= 0 && cell(ci.note)) body.note = cell(ci.note);
    try {
      await post('/leads', body);
      okCount++;
    } catch (e) {
      errors.push('Row ' + (r + 1) + ': ' + describeError(e));
    }
  }
  state.leadPage = 1;
  await refreshLeadsViews();
  if (errors.length) showBanner('Imported ' + okCount + ' lead(s); ' + errors.length + ' failed — ' + errors.slice(0, 2).join(' · '));
  else toast('Imported ' + okCount + ' lead(s)');
}

async function refreshCommandPage() {
  try {
    const [summary, leadsData, actions] = await Promise.all([
      get('/summary').catch(() => null),
      get('/leads').catch(() => []),
      get('/action-items').catch(() => []),
    ]);
    const stats = leadsData ? getLeadStats(leadsData) : { newToday: 0, total: 0, awaitingFirstContact: 0 };
    // Command stats
    const setCmd = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    setCmd('#cmdNewLeads', stats.newToday);
    setCmd('#cmdAwaiting', stats.awaitingFirstContact);
    const kpi = summary?.kpis;
    if (kpi) {
      setCmd('#cmdOccupancy', kpi.occupancyPct + '%');
      setCmd('#cmdMrr', '$' + (kpi.mrr || 0).toLocaleString());
    }
    setCmd('#cmdActions', (actions || []).length);
    // Funnel
    const funnel = $('#funnelSteps');
    if (funnel && leadsData) {
      const stages = leadsData;
      funnel.innerHTML = stages.map((s) =>
        '<div class="fstep"><b>' + s.count + '</b><span>' + (stageLabel[s.stage] || s.stage) + (s.leads.length && s.stage !== 'WON' && s.stage !== 'LOST' ? ' · ' + Math.round(s.count / (stages[0]?.count || 1) * 100) + '%' : '') + '</span></div>'
      ).join('');
    }
    // Priority queue
    const queue = $('#priorityQueue');
    if (queue && actions) {
      queue.innerHTML = actions.slice(0, 5).map((it) =>
        '<div class="qitem"><span class="dot" style="background:' + (it.tone === 'red' ? 'var(--red)' : it.tone === 'amber' ? 'var(--amber)' : 'var(--terra)') + '"></span><div><b>' + escapeHtml(it.title) + '</b><br><small>' + escapeHtml(it.desc) + '</small></div><span class="pill ' + (it.tone === 'red' ? 'red' : it.tone === 'amber' ? 'amber' : 'green') + '">' + escapeHtml(it.action) + '</span></div>'
      ).join('') || '<div class="section-empty">No priority items.</div>';
    }
    // Source breakdown
    const sources = $('#sourceBreakdown');
    if (sources && leadsData) {
      const srcCount = {};
      flattenLeads(leadsData).forEach((l) => { const s = (l.source || 'website').toLowerCase(); srcCount[s] = (srcCount[s] || 0) + 1; });
      const max = Math.max(1, ...Object.values(srcCount));
      const srcLabels = { website: 'Google/Web', whatsapp: 'WhatsApp', referral: 'Referral', google: 'Google Ads' };
      sources.innerHTML = Object.entries(srcCount).map(([k, v]) =>
        '<div class="source-row"><b>' + (srcLabels[k] || k) + '</b><div class="bar"><i style="width:' + (v / max * 100) + '%"></i></div><span>' + v + '</span></div>'
      ).join('');
    }
    // Team pulse placeholder
    const team = $('#teamPulse');
    if (team) {
      team.innerHTML = '<table class="staff"><tr><th>Advisor</th><th>Assigned</th><th>Response</th><th>Conversion</th></tr><tr><td><b>Nur Aisyah</b></td><td>36</td><td>4m</td><td><b>34%</b></td></tr><tr><td><b>Marcus Lim</b></td><td>41</td><td>7m</td><td><b>29%</b></td></tr><tr><td><b>Ravi Kumar</b></td><td>32</td><td>5m</td><td><b>31%</b></td></tr></table>';
    }
    // KPI + Charts
    bindKpis(summary);
    bindCharts(summary);
    // Activity feed
    try {
      const activity = await get('/units/activity?limit=5');
      bindActivity(activity);
    } catch (e) { /*noop*/ }
    // Nav badge
    const badge = $('#leadsBadge');
    if (badge) badge.textContent = stats.awaitingFirstContact;
  } catch (e) {
    showBanner('Command: ' + describeError(e));
  }
}

function getLeadStats(data) {
  const flat = flattenLeads(data);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return {
    total: flat.length,
    newToday: flat.filter(l => new Date(l.createdAt) >= today).length,
    awaitingFirstContact: (data.find(c => c.stage === 'NEW_ENQUIRY')?.count || 0),
  };
}

async function bindLeadTable() {
  try {
    ensureLeadsDateFilter();
    const data = await get(withDateQuery('/leads', state.leadDate));
    const flat = flattenLeads(data);
    state.leadsCache = flat;
    const filtered = applyLeadFilter(flat);
    const tbody = $('#leadRows');
    if (!tbody) return;
    const count = $('#leadCount');
    if (count) count.textContent = filtered.length + ' lead' + (filtered.length === 1 ? '' : 's') + (filtered.length !== flat.length ? ' · ' + flat.length + ' total' : '') + (isRangeActive(state.leadDate) ? ' · ' + rangeLabel(state.leadDate) : '');
    resetSelectAll('#leadRows');
    renderLeadPager(filtered.length);
    if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="10"><div class="section-empty">' + escapeHtml(rangeEmptyText('leads', state.leadDate, 'No leads match — adjust your filters.')) + '</div></td></tr>'; return; }
    const start = (state.leadPage - 1) * state.leadPerPage;
    const rows = filtered.slice(start, start + state.leadPerPage);
    tbody.innerHTML = rows.map((l) => {
      const initial = (l.name || '?').charAt(0).toUpperCase();
      const heat = stageLabel[l.stage] || l.stage;
      // v2 booking-intent tooltip on the size/facility cell — columns stay
      // intact (Status/Intent/Source/Next-action/Est-value untouched).
      const intentTip = [
        l.unitCode ? 'Unit ' + l.unitCode : null,
        l.moveInDate ? 'Move-in ' + fmtDay(l.moveInDate) : null,
      ].filter(Boolean).join(' · ');
      return '<tr data-lead-id="' + escapeHtml(l.id) + '" tabindex="0"><td><input class="check" type="checkbox"></td><td><div class="contact"><div class="avatar">' + initial + '</div><div><b>' + escapeHtml(l.name) + '</b><small>' + (l.type === 'BUSINESS' ? 'Business' : 'Personal') + (l.segment ? ' · ' + escapeHtml(l.segment) : '') + '</small></div></div></td>' +
        '<td><span class="pill ' + (l.stage === 'NEW_ENQUIRY' ? 'red' : l.stage === 'WON' ? 'green' : l.stage === 'LOST' ? '' : 'amber') + '">' + heat + '</span></td>' +
        '<td>' + leadHeatHtml(l.stage, l.monthlyRate) + '</td>' +
        '<td' + (intentTip ? ' title="' + escapeHtml(intentTip) + '"' : '') + '>' + escapeHtml(l.size || '—') + (l.branchCode ? ' · ' + escapeHtml(l.branchCode) : '') + (l.unitCode ? ' · ' + escapeHtml(l.unitCode) : '') + '</td>' +
        '<td><span class="channel">' + (l.source ? l.source.charAt(0) : 'W') + '</span></td>' +
        '<td>' + nextActionLabel(l) + '</td>' +
        '<td><b>' + (l.monthlyRate ? '$' + (l.monthlyRate).toLocaleString() : '—') + '</b></td>' +
        '<td><small>' + fmtDay(l.createdAt) + '</small></td>' +
        '<td class="unit-actions"><button class="act-btn" data-act="edit" data-lead-id="' + escapeHtml(l.id) + '">Edit</button> <button class="act-btn danger" data-act="delete" data-lead-id="' + escapeHtml(l.id) + '">Delete</button></td></tr>';
    }).join('');
  } catch (e) { showBanner('Leads: ' + describeError(e)); }
}

// ---------- lead modal (create / edit) ----------
let leadMode = 'create';
let leadEditId = null;

function clearLeadFieldErrors() {
  $$('#leadModal .field-err').forEach((el) => (el.textContent = ''));
  $$('#leadModal .field input.err, #leadModal .field select.err').forEach((el) => el.classList.remove('err'));
  const a = $('#leadModalAlert');
  if (a) a.hidden = true;
}

function showLeadFormAlert(msg) {
  const a = $('#leadModalAlert');
  if (!a) return;
  a.textContent = msg;
  a.hidden = false;
}

// zod fieldErrors keys (payload property names) → lead form element keys
const LEAD_FIELD_ID = {
  name: 'name', type: 'type', source: 'source', stage: 'stage',
  preferredBranchId: 'branch', preferredSize: 'size', monthlyRate: 'rate',
  owner: 'owner', nextActionAt: 'nextAction', email: 'email', mobile: 'mobile', note: 'note',
};

function renderLeadFieldErrors(err) {
  const fe = err && err.details && err.details.fieldErrors;
  if (!fe) return false;
  let mapped = false;
  for (const [field, msgs] of Object.entries(fe)) {
    if (!msgs || !msgs.length) continue;
    const key = LEAD_FIELD_ID[field];
    if (!key) continue;
    const errEl = $('#le-' + key);
    if (errEl) errEl.textContent = msgs.join('; ');
    const input = $('#lf-' + key);
    if (input) input.classList.add('err');
    mapped = true;
  }
  return mapped;
}

function populateLeadBranchSelect(currentBranchId) {
  const sel = $('#lf-branch');
  if (!sel) return;
  sel.innerHTML = '<option value="">— No facility —</option>' + (state.branches || []).map((b) =>
    '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(b.name) + '</option>').join('');
  sel.value = currentBranchId || '';
}

function toDateInputValueLead(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function openCreateLead() {
  leadMode = 'create';
  leadEditId = null;
  $('#leadModalTitle').textContent = 'Add Lead';
  $('#leadForm').reset();
  $('#lf-type').value = 'PERSONAL';
  $('#lf-source').value = 'WHATSAPP';
  $('#lf-stage').value = 'NEW_ENQUIRY';
  $('#leadFormSubmit').textContent = 'Save Lead';
  clearLeadFieldErrors();
  populateLeadBranchSelect(null);
  $('#leadModal').hidden = false;
}

function openEditLead(id) {
  const l = findLeadById(id);
  if (!l) { showBanner('Lead not found in list.'); return; }
  leadMode = 'edit';
  leadEditId = id;
  $('#leadModalTitle').textContent = 'Edit Lead — ' + l.name;
  $('#lf-name').value = l.name || '';
  $('#lf-type').value = l.type || 'PERSONAL';
  $('#lf-source').value = l.source || 'WEBSITE';
  $('#lf-stage').value = l.stage || 'NEW_ENQUIRY';
  $('#lf-size').value = l.size || '';
  $('#lf-rate').value = l.monthlyRate != null ? l.monthlyRate : '';
  $('#lf-owner').value = l.owner || '';
  $('#lf-nextAction').value = toDateInputValueLead(l.nextActionAt);
  $('#lf-email').value = l.email || '';
  $('#lf-mobile').value = l.mobile || '';
  $('#lf-note').value = l.note || '';
  $('#leadFormSubmit').textContent = 'Save Changes';
  clearLeadFieldErrors();
  const branchId = (state.branches || []).find((b) => b.code === l.branchCode)?.id || null;
  populateLeadBranchSelect(branchId);
  $('#leadModal').hidden = false;
}

function closeLeadModal() {
  $('#leadModal').hidden = true;
  leadEditId = null;
  clearLeadFieldErrors();
}

async function submitLeadForm(e) {
  e.preventDefault();
  clearLeadFieldErrors();
  const name = $('#lf-name').value.trim();
  if (!name) {
    $('#le-name').textContent = 'Name is required';
    $('#lf-name').classList.add('err');
    return;
  }
  const rateRaw = $('#lf-rate').value.trim();
  const body = {
    name,
    type: $('#lf-type').value,
    source: $('#lf-source').value,
    stage: $('#lf-stage').value,
  };
  const size = $('#lf-size').value.trim();
  if (size) body.preferredSize = size;
  const branchId = $('#lf-branch').value;
  body.preferredBranchId = branchId || null;
  if (rateRaw !== '') {
    const rate = Number(rateRaw);
    if (!(rate >= 0)) {
      $('#le-rate').textContent = 'Must be 0 or greater';
      $('#lf-rate').classList.add('err');
      return;
    }
    body.monthlyRate = rate;
  }
  const owner = $('#lf-owner').value.trim();
  if (owner) body.owner = owner;
  else if (leadMode === 'edit') body.owner = null;
  const nextAction = $('#lf-nextAction').value;
  if (nextAction) body.nextActionAt = new Date(nextAction + 'T00:00:00.000Z').toISOString();
  else if (leadMode === 'edit') body.nextActionAt = null;
  const email = $('#lf-email').value.trim();
  if (email) body.email = email;
  else if (leadMode === 'edit') body.email = null;
  const mobile = $('#lf-mobile').value.trim();
  if (mobile) body.mobile = mobile;
  else if (leadMode === 'edit') body.mobile = null;
  const note = $('#lf-note').value.trim();
  if (note) body.note = note;
  else if (leadMode === 'edit') body.note = null;
  if (body.stage === 'LOST') {
    const wasLost = leadMode === 'edit' && findLeadById(leadEditId)?.stage === 'LOST';
    if (!wasLost) {
      const reason = pickLossReason();
      if (reason == null) return; // cancelled — keep the modal open
      body.lossReason = reason;
    }
  }
  try {
    if (leadMode === 'create') {
      await post('/leads', body);
      showBanner('Created lead ' + name, true);
    } else {
      await patch('/leads/' + encodeURIComponent(leadEditId), body);
      showBanner('Updated lead ' + name, true);
    }
    closeLeadModal();
    state.leadPage = 1;
    await refreshLeadsViews();
  } catch (err) {
    if (!renderLeadFieldErrors(err)) showLeadFormAlert(describeError(err));
  }
}

async function deleteLeadRow(id) {
  const l = findLeadById(id);
  if (!l) return;
  const okConfirm = await confirmDialog({
    title: 'Delete lead ' + l.name + '?',
    message: 'This removes the lead and its conversation threads. Appointments keep their slot but lose the lead link.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!okConfirm) return;
  try {
    await del('/leads/' + encodeURIComponent(id));
    showBanner('Deleted lead ' + l.name, true);
    await refreshLeadsViews();
  } catch (err) {
    showBanner('Delete: ' + describeError(err));
  }
}

function renderPipelineFilter() {
  const sel = $('#pipelineFilter');
  if (!sel) return;
  const cur = state.pipelineFilter || '';
  sel.innerHTML = '<option value="">All pipelines</option>' + (state.branches || []).map((b) =>
    '<option value="' + escapeHtml(b.code) + '">' + escapeHtml(b.name) + '</option>').join('');
  sel.value = cur;
}

async function bindPipeline() {
  try {
    renderPipelineFilter();
    const data = await get('/leads');
    const kanban = $('#kanban');
    if (!kanban) return;
    const branchFilter = state.pipelineFilter || '';
    let totalValue = 0;
    kanban.innerHTML = (data || []).map((col) => {
      const cards = (col.leads || [])
        .filter((l) => !branchFilter || l.branchCode === branchFilter)
        .map((l) => {
          totalValue += l.monthlyRate || 0;
          return '<div class="deal" draggable="true" tabindex="0" role="button" aria-label="Open lead ' + escapeHtml(l.name) + '" data-lead-id="' + escapeHtml(l.id) + '" data-stage="' + col.stage + '"><div class="deal-top"><div><h4>' + escapeHtml(l.name) + '</h4><p>' + escapeHtml(l.size || '—') + (l.branchCode ? ' · ' + escapeHtml(l.branchCode) : '') + '</p></div><span class="pill ' + (l.type === 'PERSONAL' ? 'green' : 'amber') + '">' + (l.type === 'PERSONAL' ? 'Personal' : 'Business') + '</span></div><div class="deal-value">' + (l.monthlyRate ? '$' + (l.monthlyRate).toLocaleString() : '—') + '</div><div class="deal-meta"><span>' + (l.source || '') + '</span><span>' + fmtDay(l.createdAt) + '</span></div></div>';
        }).join('');
      return '<div class="column" data-stage="' + col.stage + '"><div class="col-head"><span>' + (stageKanbanLabel[col.stage] || col.stage) + ' <small>' + col.count + '</small></span></div>' + (cards || '<div class="deal"><p style="color:var(--muted)">No leads</p></div>') + '</div>';
    }).join('');
    const valEl = $('#pipelineValue');
    if (valEl) valEl.textContent = '$' + totalValue.toLocaleString() + ' pipeline value';
    wirePipelineDragDrop();
  } catch (e) { showBanner('Pipeline: ' + describeError(e)); }
}

// HTML5 drag-drop on the kanban: delegated on #kanban so re-renders keep
// working. Drop persists the new stage via PATCH /leads/:id. Card click (and
// Enter/Space on a focused card) opens the same right-side detail drawer as
// the table rows via openLeadDrawer — guarded vs dragstart so dragging a card
// never pops the drawer.
function wirePipelineDragDrop() {
  const kanban = $('#kanban');
  if (!kanban || kanban.dataset.dnd === '1') return;
  kanban.dataset.dnd = '1';
  let dragId = null;
  let justDragged = false;
  kanban.addEventListener('click', (e) => {
    if (justDragged) return;
    const card = e.target.closest('.deal[data-lead-id]');
    if (!card) return;
    openLeadDrawer(card.dataset.leadId, card);
  });
  kanban.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest && e.target.closest('.deal[data-lead-id]');
    if (!card) return;
    e.preventDefault();
    openLeadDrawer(card.dataset.leadId, card);
  });
  kanban.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.deal[data-lead-id]');
    if (!card) return;
    justDragged = true;
    dragId = card.dataset.leadId;
    try { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* noop */ }
    card.style.opacity = '0.5';
  });
  kanban.addEventListener('dragend', () => {
    dragId = null;
    kanban.querySelectorAll('.deal').forEach((c) => { c.style.opacity = ''; });
    // A real drag suppresses the follow-up click in most browsers; reset on a
    // tick so the click guard only swallows drag-initiated clicks, never real ones.
    setTimeout(() => { justDragged = false; }, 0);
  });
  kanban.addEventListener('dragover', (e) => {
    const col = e.target.closest('.column[data-stage]');
    if (!col) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* noop */ }
  });
  kanban.addEventListener('drop', async (e) => {
    const col = e.target.closest('.column[data-stage]');
    if (!col) return;
    e.preventDefault();
    const id = dragId || (() => { try { return e.dataTransfer.getData('text/plain'); } catch (err) { return null; } })();
    const toStage = col.dataset.stage;
    const card = kanban.querySelector('.deal[data-lead-id="' + (id || '').replace(/"/g, '') + '"]');
    if (!id || !card || card.dataset.stage === toStage) return;
    card.style.opacity = '';
    try {
      const body = { stage: toStage };
      if (toStage === 'LOST') {
        const reason = pickLossReason();
        if (reason == null) return; // cancelled — leave the card where it was
        body.lossReason = reason;
      }
      await patch('/leads/' + encodeURIComponent(id), body);
      toast('Moved to ' + (stageKanbanLabel[toStage] || toStage));
      await refreshLeadsViews();
    } catch (err) {
      showBanner('Move: ' + describeError(err));
    }
  });
}

// ====================== ANALYTICS (Sales performance) ======================
// Live bindings for the #analytics page: 5 existing KPI tiles + 5 new tiles
// (enquiries, qualified, bookings, median first response, lost revenue),
// weekly enquiries/bookings chart with a Volume/Value toggle, conversion by
// facility, advisor scorecard, lost-reason bars, and Export/Share buttons.
// No backend needed for Export/Share: Export builds a CSV from the same
// endpoints the page uses; Share copies a deep link (URL hash) + toast.
let anaMode = 'volume'; // 'volume' | 'value'
let anaActionsWired = false;

function fmtResponse(min) {
  if (min == null) return '—';
  if (min < 60) return Math.round(min) + 'm';
  if (min < 60 * 24) return (Math.round((min / 60) * 10) / 10) + 'h';
  return (Math.round((min / 60 / 24) * 10) / 10) + 'd';
}

function renderAnaChart(weekly) {
  const chart = $('#anaChart');
  if (!chart) return;
  const weeks = (weekly && weekly.weeks) || [];
  const head = chart.parentElement?.previousElementSibling || chart.closest('.card')?.querySelector('.card-head');
  // Mini-tabs toggle (injected once, no HTML restructure).
  if (head && !head.querySelector('[data-ana-mode]')) {
    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;gap:6px;';
    tabs.innerHTML =
      '<button class="btn" data-ana-mode="volume" type="button">Volume</button>' +
      '<button class="btn" data-ana-mode="value" type="button">Value</button>';
    head.appendChild(tabs);
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ana-mode]');
      if (!b) return;
      anaMode = b.dataset.anaMode;
      renderAnaChart(state.analyticsCache?.weekly);
      paintAnaTabs();
    });
  }
  paintAnaTabs();
  if (!weeks.length) {
    chart.innerHTML = '<div class="section-empty">No enquiries yet — data appears here weekly.</div>';
    return;
  }
  const isValue = anaMode === 'value';
  const max = Math.max(1, ...weeks.map((w) => Math.max(isValue ? w.enquiryValue : w.enquiries, isValue ? w.bookingValue : w.bookings)));
  const allZero = weeks.every((w) => w.enquiries === 0 && w.bookings === 0);
  chart.innerHTML = weeks.map((w) => {
    const a = isValue ? w.enquiryValue : w.enquiries;
    const b = isValue ? w.bookingValue : w.bookings;
    const pa = Math.max(a ? 4 : 0, Math.round((a / max) * 100));
    const pb = Math.max(b ? 4 : 0, Math.round((b / max) * 100));
    const tip = w.label + ': ' + w.enquiries + ' enquiries' +
      (isValue ? ' ($' + w.enquiryValue.toLocaleString() + ')' : '') +
      ' · ' + w.bookings + ' bookings' +
      (isValue ? ' ($' + w.bookingValue.toLocaleString() + ')' : '');
    return '<div class="group" data-label="' + escapeHtml(w.label) + '" title="' + escapeHtml(tip) + '" style="height:100%">' +
      '<div class="b" style="height:' + pa + '%;opacity:.55" title="Enquiries: ' + a + '"></div>' +
      '<div class="b" style="height:' + pb + '%" title="Bookings: ' + b + '"></div></div>';
  }).join('') + (allZero ? '<div class="section-empty">No data in these weeks yet.</div>' : '');
}

function paintAnaTabs() {
  $$('#analytics [data-ana-mode]').forEach((b) => {
    const on = b.dataset.anaMode === anaMode;
    b.classList.toggle('primary', on);
    b.style.opacity = on ? '' : '.65';
  });
}

function renderConvByFacility(stats) {
  const el = $('#convByFacility');
  if (!el) return;
  const rows = (stats && stats.conversionByFacility) || [];
  if (!rows.length) {
    el.innerHTML = '<div class="section-empty">No facility data yet.</div>';
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.leads));
  // Bar-row pattern mirrors the command page source breakdown (.source-row/.bar).
  el.innerHTML =
    '<div class="source-row"><b>Overall</b><div class="bar"><i style="width:' + (stats?.overallConversionPct || 0) + '%"></i></div><span>' + (stats?.overallConversionPct ?? 0) + '%</span></div>' +
    rows.map((r) =>
      '<div class="source-row"><b>' + escapeHtml(r.code) + '</b><div class="bar"><i style="width:' + (r.leads ? (r.won / r.leads) * 100 : 0) + '%"></i></div><span>' +
      r.won + '/' + r.leads + ' · ' + r.conversionPct + '%</span></div>'
    ).join('');
}

function ensureAnaExtra() {
  // Extra cards (scorecard + loss reasons) are appended by JS so the frozen
  // analytics HTML keeps its 2-card grid untouched.
  let wrap = $('#anaExtra');
  if (wrap) return wrap;
  const section = $('#analytics');
  const grid = section?.querySelector('.analytics-grid');
  if (!section || !grid) return null;
  wrap = document.createElement('div');
  wrap.id = 'anaExtra';
  wrap.className = 'analytics-grid';
  wrap.style.marginTop = '16px';
  wrap.innerHTML =
    '<div class="card"><div class="card-head"><h3>Advisor scorecard</h3></div><div class="card-body" id="advisorScorecard"></div></div>' +
    '<div class="card"><div class="card-head"><h3>Lost-lead reasons</h3></div><div class="card-body" id="lossReasons"></div></div>';
  grid.after(wrap);
  return wrap;
}

function renderScorecard(stats) {
  const el = $('#advisorScorecard') || ensureAnaExtra()?.querySelector('#advisorScorecard');
  if (!el) return;
  const rows = (stats && stats.scorecard) || [];
  if (!rows.length) {
    el.innerHTML = '<div class="section-empty">No advisors yet — assign a lead owner to start.</div>';
    return;
  }
  el.innerHTML = '<table class="staff"><tr><th>Advisor</th><th>Assigned</th><th>Contact</th><th>Conv.</th><th>Revenue</th><th>Quality</th></tr>' +
    rows.map((r) => {
      const qTone = r.quality >= 60 ? 'green' : r.quality >= 35 ? 'amber' : 'red';
      return '<tr><td><b>' + escapeHtml(r.owner) + '</b></td><td>' + r.assigned + '</td><td>' + r.contactRate + '%</td><td><b>' +
        r.conversion + '%</b></td><td>$' + r.revenue.toLocaleString() + '</td>' +
        '<td><span class="pill ' + qTone + '">' + r.quality + '</span></td></tr>';
    }).join('') + '</table>' +
    '<small style="color:var(--muted)">Quality = ½ contact rate + ½ conversion (revenue = won est. value).</small>';
}

function renderLossReasons(stats) {
  const el = $('#lossReasons') || ensureAnaExtra()?.querySelector('#lossReasons');
  if (!el) return;
  const breakdown = (stats && stats.lossReasonBreakdown) || {};
  const entries = Object.entries(breakdown);
  if (!entries.length) {
    el.innerHTML = '<div class="section-empty">No lost leads recorded — reasons appear here.</div>';
    return;
  }
  const max = Math.max(1, ...entries.map(([, v]) => v));
  el.innerHTML = entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) =>
      '<div class="source-row"><b>' + escapeHtml(k) + '</b><div class="bar"><i style="width:' + (v / max) * 100 + '%"></i></div><span>' + v + '</span></div>'
    ).join('');
}

function wireAnalyticsActions() {
  if (anaActionsWired) return;
  const btns = document.querySelectorAll('#analytics .head .actions button');
  if (btns.length < 2) return;
  anaActionsWired = true;
  btns[0].addEventListener('click', exportAnalyticsCsv);
  btns[1].addEventListener('click', shareAnalyticsLink);
}

function exportAnalyticsCsv() {
  const c = state.analyticsCache || {};
  const sections = [];
  const weeks = (c.weekly && c.weekly.weeks) || [];
  sections.push(['WEEKLY', 'weekStart', 'label', 'enquiries', 'bookings', 'enquiryValue', 'bookingValue']);
  weeks.forEach((w) => sections.push(['WEEKLY', w.weekStart, w.label, w.enquiries, w.bookings, w.enquiryValue, w.bookingValue]));
  const facs = (c.stats && c.stats.conversionByFacility) || [];
  sections.push(['FACILITY', 'code', 'name', 'leads', 'won', 'conversionPct']);
  facs.forEach((r) => sections.push(['FACILITY', r.code, r.name, r.leads, r.won, r.conversionPct]));
  const sc = (c.stats && c.stats.scorecard) || [];
  sections.push(['ADVISOR', 'owner', 'assigned', 'contactRate', 'conversion', 'revenue', 'quality']);
  sc.forEach((r) => sections.push(['ADVISOR', r.owner, r.assigned, r.contactRate, r.conversion, r.revenue, r.quality]));
  if (sections.length <= 3 && !weeks.length && !facs.length && !sc.length) { toast('Nothing to export'); return; }
  const day = new Date().toISOString().slice(0, 10);
  downloadCsv('analytics-' + day + '.csv', sections);
  toast('Exported analytics snapshot');
}

async function shareAnalyticsLink() {
  // Deep link to the analytics view: the router restores pages from location
  // hash (openPage writes '#analytics'), so copying the URL reopens this view.
  const url = location.origin + location.pathname + '#analytics';
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Analytics link copied');
  } catch (e) {
    window.prompt('Copy analytics link:', url);
  }
}

// ---------- conversations inbox (real threads from GET /conversations) ----------
// Static operator reply presets for the Templates button (no backend).
const INBOX_TEMPLATES = [
  { name: 'Viewing invite', text: 'Hi! Thanks for your enquiry — would you like to schedule a viewing this week? Let me know a day and time that suits you.' },
  { name: 'Follow-up nudge', text: 'Hi! Just checking in — do you still need storage? Happy to share current availability and rates.' },
  { name: 'Rate quote', text: 'Hi! Based on your requirements, our current rate is available on request. Shall I reserve a unit for a viewing?' },
];
let templateIdx = 0;

function channelLabel(ch) {
  return { WHATSAPP: 'WhatsApp', EMAIL: 'Email', PHONE: 'Phone', IN_PERSON: 'In person', WEBSITE: 'Website' }[ch] || ch || '';
}

async function bindInbox() {
  try {
    const threads = await get('/conversations').catch(() => []);
    state.threads = threads || [];
    const list = $('#threads');
    if (!list) return;
    if (!state.threads.length) {
      list.innerHTML = '<div class="section-empty" style="padding:30px">No conversations yet.</div>';
      const msg = $('#chatMessages');
      if (msg) msg.innerHTML = '<div class="section-empty">No conversations yet.</div>';
      return;
    }
    list.innerHTML = state.threads.map((t) => {
      const initial = (t.leadName || '?').charAt(0).toUpperCase();
      const preview = t.lastMessage ? t.lastMessage.body : 'No messages yet';
      const when = t.lastMessage ? fmtDay(t.lastMessage.sentAt) : fmtDay(t.updatedAt);
      return '<div class="thread' + (t.id === state.activeConversationId ? ' active' : '') + '" data-conversation-id="' + escapeHtml(t.id) + '"><div class="avatar">' + initial + '</div><div><b>' + escapeHtml(t.leadName) + '</b><p>' + escapeHtml(preview) + '</p></div><time>' + when + '</time></div>';
    }).join('');
    list.querySelectorAll('.thread').forEach((el) => {
      el.addEventListener('click', function () {
        list.querySelectorAll('.thread').forEach((x) => x.classList.remove('active'));
        this.classList.add('active');
        openConversation(this.dataset.conversationId);
      });
    });
    // Keep the selection if it still exists, else open the first thread.
    const stillThere = state.threads.some((t) => t.id === state.activeConversationId);
    if (!stillThere) state.activeConversationId = state.threads[0].id;
    const first = list.querySelector('.thread[data-conversation-id="' + state.activeConversationId + '"]') || list.querySelector('.thread');
    if (first) {
      first.classList.add('active');
      state.activeConversationId = first.dataset.conversationId;
      await openConversation(state.activeConversationId);
    }
  } catch (e) { showBanner('Inbox: ' + describeError(e)); }
}

function activeThread() {
  return (state.threads || []).find((t) => t.id === state.activeConversationId);
}

async function openConversation(id) {
  state.activeConversationId = id;
  try {
    const data = await get('/conversations/' + encodeURIComponent(id) + '/messages');
    const convo = data.conversation;
    const timeline = data.timeline || [];
    const msg = $('#chatMessages');
    if (msg) {
      if (!timeline.length) {
        msg.innerHTML = '<div class="section-empty">No messages yet — send the first one below.</div>';
      } else {
        msg.innerHTML = timeline.map((it) => {
          if (it.kind === 'note') {
            return '<div class="bubble" style="align-self:center;font-style:italic;opacity:.85">📝 ' + escapeHtml(it.body) + '<small>' + escapeHtml(it.author || 'Note') + ' · ' + fmtDay(it.at) + '</small></div>';
          }
          const cls = it.direction === 'OUT' ? 'bubble me' : 'bubble';
          return '<div class="' + cls + '">' + escapeHtml(it.body) + '<small>' + escapeHtml(it.sender || (it.direction === 'OUT' ? 'Operator' : convo.leadName)) + ' · ' + fmtDay(it.at) + '</small></div>';
        }).join('');
        msg.scrollTop = msg.scrollHeight;
      }
    }
    renderInboxProfile(convo);
  } catch (e) { showBanner('Thread: ' + describeError(e)); }
}

function renderInboxProfile(convo) {
  const lead = findLeadById(convo.leadId) || {};
  const initial = (convo.leadName || '?').charAt(0).toUpperCase();
  const av = $('#profileAvatar');
  if (av) av.textContent = initial;
  const nm = $('#profileName');
  if (nm) nm.textContent = convo.leadName;
  const sub = $('#profileSub');
  if (sub) sub.textContent = 'Lead · ' + (stageLabel[convo.leadStage] || convo.leadStage || '') + ' · ' + channelLabel(convo.channel) + (convo.assignee ? ' · ' + convo.assignee : '');
  const fields = $('#profileFields');
  if (fields) {
    fields.innerHTML = '<dt>Product</dt><dd>' + escapeHtml(lead.size || '—') + '</dd><dt>Facility</dt><dd>' + escapeHtml(lead.branchCode || convo.branchCode || '—') + '</dd><dt>Value</dt><dd>' + (lead.monthlyRate ? '$' + lead.monthlyRate.toLocaleString() : '—') + '</dd><dt>Assignee</dt><dd>' + escapeHtml(convo.assignee || 'Unassigned') + '</dd>';
  }
}

async function assignActiveThread() {
  const t = activeThread();
  if (!t) { toast('Select a conversation first'); return; }
  const me = (getCurrentUser() && getCurrentUser().name) || 'Operator';
  // Toggle: assigned to me → unassign, otherwise assign to me.
  const assignee = t.assignee === me ? null : me;
  try {
    const updated = await patch('/conversations/' + encodeURIComponent(t.id), { assignee });
    state.threads = state.threads.map((x) => (x.id === t.id ? { ...x, assignee: updated.assignee } : x));
    toast(updated.assignee ? 'Assigned to ' + updated.assignee : 'Unassigned');
    await openConversation(t.id);
    await bindInboxThreadsOnly();
  } catch (e) { showBanner('Assign: ' + describeError(e)); }
}

// Re-render the thread list without resetting the open conversation.
async function bindInboxThreadsOnly() {
  const keep = state.activeConversationId;
  try {
    const threads = await get('/conversations').catch(() => []);
    state.threads = threads || [];
    const list = $('#threads');
    if (!list) return;
    list.innerHTML = state.threads.map((t) => {
      const initial = (t.leadName || '?').charAt(0).toUpperCase();
      const preview = t.lastMessage ? t.lastMessage.body : 'No messages yet';
      const when = t.lastMessage ? fmtDay(t.lastMessage.sentAt) : fmtDay(t.updatedAt);
      return '<div class="thread' + (t.id === keep ? ' active' : '') + '" data-conversation-id="' + escapeHtml(t.id) + '"><div class="avatar">' + initial + '</div><div><b>' + escapeHtml(t.leadName) + '</b><p>' + escapeHtml(preview) + '</p></div><time>' + when + '</time></div>';
    }).join('');
    list.querySelectorAll('.thread').forEach((el) => {
      el.addEventListener('click', function () {
        list.querySelectorAll('.thread').forEach((x) => x.classList.remove('active'));
        this.classList.add('active');
        openConversation(this.dataset.conversationId);
      });
    });
  } catch (e) { /* list refresh is best-effort */ }
}

function focusComposerForNewMessage() {
  const t = activeThread();
  if (!t) { toast('Select a conversation first'); return; }
  const box = $('#composerText');
  if (box) { box.focus(); box.placeholder = 'Message ' + t.leadName + '… (prefix with /note to save an internal note)'; }
}

function insertInboxTemplate() {
  const box = $('#composerText');
  if (!box) return;
  const tpl = INBOX_TEMPLATES[templateIdx % INBOX_TEMPLATES.length];
  templateIdx++;
  box.value = tpl.text;
  box.focus();
  toast('Template: ' + tpl.name);
}

async function sendComposer() {
  const t = activeThread();
  if (!t) { toast('Select a conversation first'); return; }
  const box = $('#composerText');
  const text = (box ? box.value : '').trim();
  if (!text) { toast('Type a message first'); return; }
  try {
    if (text.startsWith('/note ')) {
      const noteBody = text.slice(6).trim();
      if (!noteBody) { toast('Note is empty'); return; }
      await post('/conversations/' + encodeURIComponent(t.id) + '/notes', { body: noteBody });
      toast('Note saved');
    } else {
      const res = await post('/conversations/' + encodeURIComponent(t.id) + '/messages', { body: text });
      if (res && res.stageTransitioned) {
        // First outbound reply flips NEW_ENQUIRY → CONTACTED server-side;
        // refresh the pipeline/table so the card moves immediately.
        toast('Moved to Contacted (first reply)');
        await refreshLeadsViews().catch(() => {});
      } else {
        toast(res && res.delivered === false ? 'Recorded (delivery stub — not sent)' : 'Message recorded');
      }
    }
    if (box) box.value = '';
    await openConversation(t.id);
    await bindInboxThreadsOnly();
  } catch (e) { showBanner('Send: ' + describeError(e)); }
}

// Date-range controls for the leads table + appointments lists. Each control
// refetches server-side (?from=&to=) and resets its pager to page 1, composing
// with the existing status/source filters (client-side over the ranged rows).
function ensureLeadsDateFilter() {
  const toolbar = $('#leadStatusFilter')?.closest('.toolbar');
  if (!toolbar || toolbar.dataset.dateFilterMounted) return;
  toolbar.dataset.dateFilterMounted = '1';
  const handle = createDateFilter({
    onChange: (r) => {
      state.leadDate = r;
      state.leadPage = 1;
      bindLeadTable().catch(() => {});
    },
  });
  // Date-range trigger is the FIRST control in the toolbar — before the
  // status/source selects, More filters, the .grow spacer and view segments.
  toolbar.prepend(handle.el);
}

function ensureCalendarDateFilter() {
  const actions = document.querySelector('#calendar .head .actions');
  if (!actions || actions.dataset.dateFilterMounted) return;
  actions.dataset.dateFilterMounted = '1';
  const handle = createDateFilter({
    onChange: (r) => {
      state.apptDate = r;
      bindCalendar().catch(() => {});
    },
  });
  // Date-range trigger is the FIRST control in the header actions (before Schedule).
  actions.prepend(handle.el);
}

async function bindCalendar() {
  try {
    ensureCalendarDateFilter();
    const appts = await get(withDateQuery('/appointments', state.apptDate)).catch(() => []);
    state.appointmentsCache = appts || [];
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // ---- Today panel ----
    const todayAppts = appts.filter((a) => {
      const d = new Date(a.startAt);
      return d >= startOfToday && d < new Date(startOfToday.getTime() + 86400000);
    });
    const todayEl = $('#todayAppts');
    if (!todayEl) return;
    // The Today panel is a drop target: dropping a chip here moves it to today
    // (same time-of-day). Chips here are also draggable to the week grid.
    todayEl.dataset.calDay = calDayKey(startOfToday);
    if (!todayAppts.length) {
      todayEl.innerHTML = '<div class="section-empty">' + escapeHtml(rangeEmptyText('appointments', state.apptDate, 'No appointments today.')) + '</div>';
    } else {
      todayEl.innerHTML = todayAppts.map((a) => {
        const initial = (a.personName || '?').charAt(0).toUpperCase();
        const time = new Date(a.startAt).toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' });
        const pillClass = a.status === 'CONFIRMED' ? 'green' : a.status === 'PENDING' ? 'amber' : a.status === 'DONE' ? 'green' : '';
        const actions = a.status === 'CANCELLED'
          ? ''
          : '<span class="unit-actions"><button class="act-btn" data-appt-act="edit" data-appt-id="' + escapeHtml(a.id) + '">Edit</button> <button class="act-btn danger" data-appt-act="cancel" data-appt-id="' + escapeHtml(a.id) + '">Cancel</button></span>';
        // CANCELLED / DONE appointments are terminal — never draggable (see
        // wireCalendarDragDrop; the drop handler re-checks status as well).
        const draggable = a.status === 'CANCELLED' || a.status === 'DONE'
          ? ''
          : ' draggable="true" data-appt-id="' + escapeHtml(a.id) + '" title="Drag to reschedule"';
        return '<div class="qitem"' + draggable + '><div class="avatar">' + initial + '</div><div><b>' + time + ' · ' + escapeHtml(a.personName) + '</b><br><small>' + escapeHtml(a.title) + '</small></div><span class="pill ' + pillClass + '">' + a.status.replace('_', ' ') + '</span>' + actions + '</div>';
      }).join('');
    }

    // ---- Week grid ----
    const weekEl = $('#weekView');
    if (!weekEl) return;
    // Compute Mon–Fri of the current week
    const dow = now.getDay(); // 0=Sun
    const monOffset = dow === 0 ? 6 : dow - 1;
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - monOffset);
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const dayLabels = ['AM', ...dayNames];
    // Build grid: header row + one row per event-slot
    // Collect appointments Mon–Fri
    const weekStart = new Date(mon);
    const weekEnd = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 5);
    const weekAppts = appts.filter((a) => {
      const d = new Date(a.startAt);
      return d >= weekStart && d < weekEnd;
    });
    // Group by day index (0=Mon…4=Fri)
    const byDay = [[], [], [], [], []];
    weekAppts.forEach((a) => {
      const d = new Date(a.startAt);
      const dayIdx = Math.floor((d.getTime() - weekStart.getTime()) / 86400000);
      if (dayIdx >= 0 && dayIdx < 5) byDay[dayIdx].push(a);
    });
    // Render
    let html = '<div class="time">AM</div>';
    for (let i = 0; i < 5; i++) {
      const day = new Date(mon.getTime() + i * 86400000);
      const label = dayNames[i] + ' ' + day.getDate() + '/' + (day.getMonth() + 1);
      html += '<div class="day">' + label + '</div>';
    }
    // Find max events per day to determine rows
    const maxEvents = Math.max(1, ...byDay.map((d) => d.length));
    for (let r = 0; r < maxEvents; r++) {
      html += '<div class="time">' + (r + 1) + '</div>';
      for (let d = 0; d < 5; d++) {
        const day = new Date(mon.getTime() + d * 86400000);
        const dayKey = calDayKey(day);
        const ev = byDay[d][r];
        if (ev) {
          const time = new Date(ev.startAt).toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' });
          const isMoveIn = ev.type === 'MOVE_IN';
          // CANCELLED / DONE appointments are terminal — never draggable (see
          // wireCalendarDragDrop; the drop handler re-checks status as well).
          const draggable = ev.status === 'CANCELLED' || ev.status === 'DONE'
            ? ''
            : ' draggable="true" data-appt-id="' + escapeHtml(ev.id) + '" title="Drag to reschedule"';
          html += '<div class="cal-drop" data-cal-day="' + dayKey + '"><div class="event' + (isMoveIn ? ' green' : '') + '"' + draggable + '><b>' + time + '</b><br>' + escapeHtml(ev.title) + '</div></div>';
        } else {
          html += '<div class="cal-drop" data-cal-day="' + dayKey + '"></div>';
        }
      }
    }
    weekEl.innerHTML = html;
    wireCalendarDragDrop();
    wireTodayDropTarget();
  } catch (e) { /*noop*/ }
}

// Local yyyy-mm-dd key for a Date (matches the calendar's local-day math).
function calDayKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function calDateTimeLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' });
}

// Drop highlight using existing theme tokens only (no stylesheet changes:
// inline styles are cleared on drop/leave so the v8 calendar CSS is untouched).
function calHighlight(el, on) {
  if (!el) return;
  if (on) {
    el.style.outline = '2px dashed var(--terra)';
    el.style.background = 'var(--sage)';
  } else {
    el.style.outline = '';
    el.style.background = '';
  }
}

// Client-side overlap check against the last GET /appointments cache, mirroring
// the server's findAppointmentConflicts (same branch, skip self + CANCELLED,
// 60-min default duration when endAt is unset). Shown in the confirm text.
function calFindOverlaps(appt, newStart, newEnd) {
  return (state.appointmentsCache || []).filter((o) => {
    if (o.id === appt.id || o.status === 'CANCELLED') return false;
    if ((o.branchId || null) !== (appt.branchId || null)) return false;
    const oStart = new Date(o.startAt).getTime();
    const oEnd = o.endAt ? new Date(o.endAt).getTime() : oStart + 60 * 60000;
    return newStart.getTime() < oEnd && oStart < newEnd.getTime();
  });
}

// HTML5 drag-drop for the appointments calendar, mirroring the pipeline kanban
// pattern (wirePipelineDragDrop): delegated listeners attached once per stable
// container, persist-on-drop via PATCH /appointments/:id, revert-on-failure by
// re-rendering from state. Touch drag is NOT supported (HTML5 DnD only) —
// follow-up if ops need tablet rescheduling.
let calDragId = null;
let calHoverEl = null;

function calClearHover() {
  calHighlight(calHoverEl, false);
  calHoverEl = null;
}

async function calHandleDrop(dayKey) {
  const id = calDragId;
  calDragId = null;
  calClearHover();
  const weekEl = $('#weekView');
  if (weekEl) weekEl.querySelectorAll('[draggable="true"]').forEach((c) => { c.style.opacity = ''; });
  const todayEl = $('#todayAppts');
  if (todayEl) todayEl.querySelectorAll('[draggable="true"]').forEach((c) => { c.style.opacity = ''; });
  if (!id || !dayKey) return;
  const appt = (state.appointmentsCache || []).find((x) => x.id === id);
  // Guard: terminal appointments are never rescheduled via drag-drop.
  if (!appt || appt.status === 'CANCELLED' || appt.status === 'DONE') return;
  const parts = String(dayKey).split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !(n >= 0))) return;
  const orig = new Date(appt.startAt);
  const newStart = new Date(parts[0], parts[1] - 1, parts[2], orig.getHours(), orig.getMinutes());
  if (isNaN(newStart.getTime())) return;
  // Same-slot drop: nothing changed — re-render to clear any hover state.
  if (newStart.getTime() === orig.getTime()) { await bindCalendar(); return; }
  // Guard: drag-drop changes ONLY the time — branch/lead/type are never sent,
  // so they cannot drift. Duration is preserved from the original slot.
  const origEnd = appt.endAt ? new Date(appt.endAt) : null;
  const newEnd = origEnd ? new Date(newStart.getTime() + (origEnd.getTime() - orig.getTime())) : null;
  let message = 'Move ' + appt.title + ' from ' + calDateTimeLabel(appt.startAt) +
    ' to ' + calDateTimeLabel(newStart.toISOString()) + '?';
  // Past-time drops are a confirm warning, not a hard block (ops backfill).
  if (newStart.getTime() < Date.now()) {
    message += ' This is in the past — backfill allowed, continue?';
  }
  const overlaps = calFindOverlaps(appt, newStart, newEnd || new Date(newStart.getTime() + 60 * 60000));
  if (overlaps.length) {
    message += ' Warning: overlaps with ' + overlaps.map((o) => '"' + o.title + '"').join(', ') + '.';
  }
  const okConfirm = await confirmDialog({
    title: 'Move ' + appt.title + '?',
    message,
    confirmLabel: 'Move appointment',
  });
  // Cancel: revert by re-rendering from state — the chip never moved optimistically.
  if (!okConfirm) { await bindCalendar(); return; }
  try {
    const body = { startAt: newStart.toISOString() };
    if (newEnd) body.endAt = newEnd.toISOString();
    await patch('/appointments/' + encodeURIComponent(id), body);
    toast('Moved ' + appt.title + ' to ' + calDateTimeLabel(newStart.toISOString()));
    await bindCalendar();
  } catch (err) {
    // Failure: revert by re-rendering from state so the UI never disagrees
    // with the server.
    showBanner('Move: ' + describeError(err));
    await bindCalendar();
  }
}

function wireCalendarDragDrop() {
  const weekEl = $('#weekView');
  if (!weekEl || weekEl.dataset.dnd === '1') return;
  weekEl.dataset.dnd = '1';
  weekEl.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('[data-appt-id]');
    if (!chip || chip.getAttribute('draggable') !== 'true') return;
    calDragId = chip.dataset.apptId;
    try { e.dataTransfer.setData('text/plain', calDragId); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* noop */ }
    chip.style.opacity = '0.5';
  });
  weekEl.addEventListener('dragend', () => {
    calDragId = null;
    calClearHover();
    weekEl.querySelectorAll('[draggable="true"]').forEach((c) => { c.style.opacity = ''; });
  });
  weekEl.addEventListener('dragover', (e) => {
    const cell = e.target.closest('.cal-drop[data-cal-day]');
    if (!cell) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* noop */ }
    if (calHoverEl !== cell) {
      calClearHover();
      calHoverEl = cell;
      calHighlight(cell, true);
    }
  });
  weekEl.addEventListener('dragleave', (e) => {
    const cell = e.target.closest('.cal-drop[data-cal-day]');
    if (cell && cell === calHoverEl) calClearHover();
  });
  weekEl.addEventListener('drop', async (e) => {
    const cell = e.target.closest('.cal-drop[data-cal-day]');
    if (!cell) return;
    e.preventDefault();
    const id = calDragId || (() => { try { return e.dataTransfer.getData('text/plain'); } catch (err) { return null; } })();
    calDragId = id;
    await calHandleDrop(cell.dataset.calDay);
  });
}

// Today panel: its rows are draggable (handled via the week grid's dragstart
// fallback below) and the panel itself is a drop target (move to today).
function wireTodayDropTarget() {
  const todayEl = $('#todayAppts');
  if (!todayEl || todayEl.dataset.dnd === '1') return;
  todayEl.dataset.dnd = '1';
  todayEl.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('[data-appt-id]');
    if (!chip || chip.getAttribute('draggable') !== 'true') return;
    calDragId = chip.dataset.apptId;
    try { e.dataTransfer.setData('text/plain', calDragId); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* noop */ }
    chip.style.opacity = '0.5';
  });
  todayEl.addEventListener('dragend', () => {
    calDragId = null;
    calClearHover();
    todayEl.querySelectorAll('[draggable="true"]').forEach((c) => { c.style.opacity = ''; });
  });
  todayEl.addEventListener('dragover', (e) => {
    if (!todayEl.dataset.calDay) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* noop */ }
    if (calHoverEl !== todayEl) {
      calClearHover();
      calHoverEl = todayEl;
      calHighlight(todayEl, true);
    }
  });
  todayEl.addEventListener('dragleave', () => {
    if (calHoverEl === todayEl) calClearHover();
  });
  todayEl.addEventListener('drop', async (e) => {
    if (!todayEl.dataset.calDay) return;
    e.preventDefault();
    const id = calDragId || (() => { try { return e.dataTransfer.getData('text/plain'); } catch (err) { return null; } })();
    calDragId = id;
    await calHandleDrop(todayEl.dataset.calDay);
  });
}

// ---------- appointment modal (schedule / edit) ----------
let apptMode = 'create';
let apptEditId = null;

function clearApptFieldErrors() {
  $$('#apptModal .field-err').forEach((el) => (el.textContent = ''));
  $$('#apptModal .field input.err, #apptModal .field select.err').forEach((el) => el.classList.remove('err'));
  const a = $('#apptModalAlert');
  if (a) a.hidden = true;
}

function showApptFormAlert(msg) {
  const a = $('#apptModalAlert');
  if (!a) return;
  a.textContent = msg;
  a.hidden = false;
}

function populateApptSelects(currentBranchId, currentLeadId) {
  const bSel = $('#af-branch');
  if (bSel) {
    bSel.innerHTML = '<option value="">— No facility —</option>' + (state.branches || []).map((b) =>
      '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(b.name) + '</option>').join('');
    bSel.value = currentBranchId || '';
  }
  const lSel = $('#af-lead');
  if (lSel) {
    lSel.innerHTML = '<option value="">— No lead —</option>' + (state.leadsCache || []).map((l) =>
      '<option value="' + escapeHtml(l.id) + '">' + escapeHtml(l.name) + '</option>').join('');
    lSel.value = currentLeadId || '';
  }
}

function toDateTimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

async function openCreateAppointment(presetLeadId) {
  apptMode = 'create';
  apptEditId = null;
  $('#apptModalTitle').textContent = 'Schedule Appointment';
  $('#apptForm').reset();
  $('#af-type').value = 'VIEWING';
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  $('#af-start').value = toDateTimeLocalValue(d.toISOString());
  $('#af-end').value = '';
  $('#apptFormSubmit').textContent = 'Save Appointment';
  clearApptFieldErrors();
  // Leads list may be stale if the operator never opened the database page.
  try {
    const data = await get('/leads');
    state.leadsCache = flattenLeads(data);
  } catch (e) { /* keep cache */ }
  // Drawer-schedule path pre-selects the drawer lead (plain Schedule keeps none).
  populateApptSelects(null, presetLeadId || null);
  const person = presetLeadId && (state.leadsCache || []).find((l) => l.id === presetLeadId);
  if (person) $('#af-person').value = person.name || '';
  $('#apptModal').hidden = false;
}

function openEditAppointment(id) {
  const a = (state.appointmentsCache || []).find((x) => x.id === id);
  if (!a) { showBanner('Appointment not found in list.'); return; }
  apptMode = 'edit';
  apptEditId = id;
  $('#apptModalTitle').textContent = 'Edit Appointment — ' + a.personName;
  $('#af-title').value = a.title || '';
  $('#af-person').value = a.personName || '';
  $('#af-type').value = a.type || 'VIEWING';
  $('#af-start').value = toDateTimeLocalValue(a.startAt);
  $('#af-end').value = toDateTimeLocalValue(a.endAt);
  $('#af-note').value = a.note || '';
  $('#apptFormSubmit').textContent = 'Save Changes';
  clearApptFieldErrors();
  populateApptSelects(a.branchId || null, a.leadId || null);
  $('#apptModal').hidden = false;
}

function closeApptModal() {
  $('#apptModal').hidden = true;
  apptEditId = null;
  clearApptFieldErrors();
}

async function submitApptForm(e) {
  e.preventDefault();
  clearApptFieldErrors();
  const title = $('#af-title').value.trim();
  const personName = $('#af-person').value.trim();
  const startRaw = $('#af-start').value;
  let valid = true;
  if (!title) { $('#ae-title').textContent = 'Title is required'; $('#af-title').classList.add('err'); valid = false; }
  if (!personName) { $('#ae-person').textContent = 'Person is required'; $('#af-person').classList.add('err'); valid = false; }
  if (!startRaw) { $('#ae-start').textContent = 'Start is required'; $('#af-start').classList.add('err'); valid = false; }
  if (!valid) return;
  const body = {
    title,
    personName,
    type: $('#af-type').value,
    startAt: new Date(startRaw).toISOString(),
  };
  const branchId = $('#af-branch').value;
  body.branchId = branchId || null;
  const leadId = $('#af-lead').value;
  body.leadId = leadId || null;
  const endRaw = $('#af-end').value;
  if (endRaw) body.endAt = new Date(endRaw).toISOString();
  const note = $('#af-note').value.trim();
  if (note) body.note = note;
  else if (apptMode === 'edit') body.note = null;
  try {
    if (apptMode === 'create') {
      await post('/appointments', body);
      showBanner('Scheduled ' + title, true);
    } else {
      await patch('/appointments/' + encodeURIComponent(apptEditId), body);
      showBanner('Updated ' + title, true);
    }
    closeApptModal();
    await bindCalendar();
  } catch (err) {
    showApptFormAlert(describeError(err));
  }
}

async function cancelAppointment(id) {
  const a = (state.appointmentsCache || []).find((x) => x.id === id);
  if (!a) return;
  const okConfirm = await confirmDialog({
    title: 'Cancel appointment?',
    message: a.title + ' · ' + a.personName,
    confirmLabel: 'Cancel appointment',
    danger: true,
  });
  if (!okConfirm) return;
  try {
    await patch('/appointments/' + encodeURIComponent(id), { status: 'CANCELLED' });
    showBanner('Cancelled ' + a.title, true);
    await bindCalendar();
  } catch (err) {
    showBanner('Cancel: ' + describeError(err));
  }
}

// Loss-reason picker for the stage-change path (pipeline drop + lead modal).
// Minimal prompt-based picker so existing flows don't break: cancel aborts the
// move, empty/unknown input falls back to "Unspecified" (server also defaults).
const LOSS_REASON_OPTIONS = ['Price', 'Location', 'Timing', 'Competitor', 'No response', 'Unspecified'];
function pickLossReason() {
  try {
    const raw = window.prompt(
      'Loss reason (' + LOSS_REASON_OPTIONS.join(' / ') + '):',
      'Unspecified',
    );
    if (raw == null) return null; // user cancelled
    const hit = LOSS_REASON_OPTIONS.find((o) => o.toLowerCase() === raw.trim().toLowerCase());
    return hit || 'Unspecified';
  } catch (e) {
    return 'Unspecified';
  }
}

async function bindAnalytics() {
  try {
    const [summary, leadsData, leadStats, weekly] = await Promise.all([
      get('/summary').catch(() => null),
      get('/leads').catch(() => []),
      get('/leads/stats').catch(() => null),
      get('/analytics/weekly?weeks=8').catch(() => null),
    ]);
    state.analyticsCache = { summary, leadsData, stats: leadStats, weekly };
    // Stat tiles: keep the 5 existing KPI tiles, then append the 5 new ones.
    const stats = $('#analyticsStats');
    if (stats) {
      const k = summary?.kpis;
      const flat = flattenLeads(leadsData);
      let html = '';
      if (k) {
        html += '<div class="stat"><div class="label">Occupancy</div><div class="val">' + k.occupancyPct + '%</div></div>' +
          '<div class="stat"><div class="label">MRR</div><div class="val">$' + (k.mrr || 0).toLocaleString() + '</div></div>' +
          '<div class="stat"><div class="label">Avg PSF</div><div class="val">$' + k.avgPsf + '</div></div>' +
          '<div class="stat"><div class="label">Overdue</div><div class="val">' + k.overdueUnits + '</div></div>' +
          '<div class="stat"><div class="label">Leads</div><div class="val">' + flat.length + '</div></div>';
      }
      const enq = leadStats?.enquiries ?? flat.length;
      const qual = leadStats?.qualified ?? 0;
      const book = leadStats?.bookings ?? 0;
      const conv = leadStats?.overallConversionPct ?? 0;
      const resp = fmtResponse(leadStats?.medianFirstResponseMin ?? null);
      const respSub = leadStats?.firstResponseSample ? 'n=' + leadStats.firstResponseSample : 'no data';
      const lostV = leadStats?.lostValue ?? 0;
      const lostC = leadStats?.lostCount ?? 0;
      html += '<div class="stat"><div class="label">Enquiries</div><div class="val">' + enq + '</div></div>' +
        '<div class="stat"><div class="label">Qualified</div><div class="val">' + qual + '</div></div>' +
        '<div class="stat"><div class="label">Bookings</div><div class="val">' + book + '</div><small>' + conv + '% conv.</small></div>' +
        '<div class="stat"><div class="label">Median first response</div><div class="val">' + resp + '</div><small>' + respSub + '</small></div>' +
        '<div class="stat"><div class="label">Lost revenue</div><div class="val">$' + Number(lostV).toLocaleString() + '</div><small>' + lostC + ' lost</small></div>';
      stats.innerHTML = html;
    }
    renderAnaChart(weekly);
    renderConvByFacility(leadStats);
    ensureAnaExtra();
    renderScorecard(leadStats);
    renderLossReasons(leadStats);
    wireAnalyticsActions();
  } catch (e) { /*noop*/ }
}

async function bindAutomation() {
  try {
    const actions = await get('/action-items').catch(() => []);
    const overdue = (actions || []).filter(a => a.tone === 'red').length;
    const followUp = (actions || []).filter(a => a.tone === 'amber').length;
    const el1 = $('#autoFollowUp');
    const el2 = $('#autoAlerts');
    if (el1) el1.textContent = followUp + ' alerts';
    if (el2) el2.textContent = overdue + ' alerts';
  } catch (e) { /*noop*/ }
}

// ====================== GLOBAL SETTINGS (Phase 6) ======================
// Grouped setting cards mirroring the automation card pattern (.card.auto +
// the same .sw toggle switches — wired for real here). Spec mirrors the defs
// in src/core/settings.ts (labels/descriptions/control kinds only —
// validation and coercion live server-side). Values load from GET /settings,
// edits flip a dirty state on the Save bar, and Save PUTs the changed keys.
// Group icons: Heroicons (outline) inline SVGs, following the same sidebar/
// topbar pattern (fill none, stroke currentColor, 1.5 width, round caps).
// Rendered inside .auto-icon (38px sage box, olive color) at 20px so they
// inherit the theme color and match the automation cards' visuals.
const SET_SVG_OPEN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
const SET_ICON_BELL = SET_SVG_OPEN + '<path d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"/></svg>';
const SET_ICON_CALENDAR = SET_SVG_OPEN + '<path d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5m-9-6h.008v.008H12v-.008ZM12 15h.008v.008H12V15Zm0 2.25h.008v.008H12v-.008ZM9.75 15h.008v.008H9.75V15Zm0 2.25h.008v.008H9.75v-.008ZM7.5 15h.008v.008H7.5V15Zm0 2.25h.008v.008H7.5v-.008Zm6.75-4.5h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V15Zm0 2.25h.008v.008h-.008v-.008Zm2.25-4.5h.008v.008H16.5v-.008Zm0 2.25h.008v.008H16.5V15Z"/></svg>';
const SET_ICON_BANKNOTES = SET_SVG_OPEN + '<path d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z"/></svg>';
const SET_ICON_PAINT = SET_SVG_OPEN + '<path d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.043-1.624m-3.43 3.43a15.994 15.994 0 0 1-1.622 3.395m3.42-3.42a15.995 15.995 0 0 0-3.395-1.622"/></svg>';
const SET_ICON_COG = SET_SVG_OPEN + '<path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>';
const SETTINGS_GROUPS = [
  {
    title: 'Notifications', icon: SET_ICON_BELL, sub: 'Booking alerts and reminder timing.',
    keys: [
      { key: 'notifications.emailBookingAlerts', kind: 'boolean', label: 'Email booking alerts', desc: 'Email operators when a new booking arrives.' },
      { key: 'notifications.whatsappBookingAlerts', kind: 'boolean', label: 'WhatsApp booking alerts', desc: 'Ping operators on WhatsApp for new bookings.' },
      { key: 'notifications.reminderLeadHours', kind: 'number', label: 'Follow-up reminder (hrs)', desc: 'Hours after a new enquiry before a reminder fires.' },
    ],
  },
  {
    title: 'Booking', icon: SET_ICON_CALENDAR, sub: 'How bookings are confirmed and bounded.',
    keys: [
      { key: 'booking.autoConfirm', kind: 'boolean', label: 'Auto-confirm bookings', desc: 'Confirm paid bookings without operator review.' },
      { key: 'booking.minAdvanceHours', kind: 'number', label: 'Min advance booking (hrs)', desc: 'Earliest a move-in can be booked, in hours from now.' },
      { key: 'booking.maxStayMonths', kind: 'number', label: 'Max stay length (months)', desc: 'Longest single booking allowed, in months.' },
    ],
  },
  {
    title: 'Billing', icon: SET_ICON_BANKNOTES, sub: 'Grace periods, fees and invoice numbering.',
    keys: [
      { key: 'billing.graceDays', kind: 'number', label: 'Payment grace period (days)', desc: 'Days after the due date before an invoice counts as overdue.' },
      { key: 'billing.lateFeeEnabled', kind: 'boolean', label: 'Late fees', desc: 'Apply late fees to invoices past the grace period.' },
      { key: 'billing.invoicePrefix', kind: 'text', label: 'Invoice prefix', desc: 'Prefix for generated invoice numbers.' },
    ],
  },
  {
    title: 'Display', icon: SET_ICON_PAINT, sub: 'Currency and formats shown across the CMS.',
    keys: [
      { key: 'display.currency', kind: 'select', label: 'Currency', desc: 'Currency shown across the CMS and invoices.', options: ['SGD', 'USD', 'MYR'] },
      { key: 'display.dateFormat', kind: 'select', label: 'Date format', desc: 'Date format used across the CMS.', options: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] },
    ],
  },
  {
    title: 'Operations', icon: SET_ICON_COG, sub: 'Platform-wide operational switches.',
    keys: [
      { key: 'operations.maintenanceMode', kind: 'boolean', label: 'Maintenance mode', desc: 'Pause new bookings while maintenance is underway.' },
      { key: 'operations.supportContact', kind: 'text', label: 'Support contact', desc: 'Support email or phone shown to customers.' },
    ],
  },
];

const settingsState = { original: {}, draft: {}, loaded: false };
let settingsEventsWired = false;

function markSettingsDirty() {
  const btn = $('#settingsSaveBtn');
  const dot = $('#settingsDirty');
  if (btn) btn.disabled = false;
  if (dot) dot.classList.add('show');
}

function markSettingsClean() {
  const btn = $('#settingsSaveBtn');
  const dot = $('#settingsDirty');
  if (btn) { btn.disabled = true; btn.textContent = 'Save changes'; }
  if (dot) dot.classList.remove('show');
}

function settingControlHtml(spec, value) {
  const key = escapeHtml(spec.key);
  if (spec.kind === 'boolean') {
    const on = !!value;
    return '<div class="set-ctl"><span class="set-state">' + (on ? 'On' : 'Off') + '</span>' +
      '<span class="sw' + (on ? ' on' : '') + '" data-setting-key="' + key + '" role="switch" aria-checked="' + on + '" aria-label="' + escapeHtml(spec.label) + '" tabindex="0"><i></i></span></div>';
  }
  if (spec.kind === 'number') {
    return '<input type="number" class="set-input num" data-setting-key="' + key + '" value="' + escapeHtml(String(value ?? '')) + '" aria-label="' + escapeHtml(spec.label) + '">';
  }
  if (spec.kind === 'select') {
    return '<select class="set-select" data-setting-key="' + key + '" aria-label="' + escapeHtml(spec.label) + '">' +
      (spec.options || []).map((o) => '<option value="' + escapeHtml(o) + '"' + (o === value ? ' selected' : '') + '>' + escapeHtml(o) + '</option>').join('') + '</select>';
  }
  return '<input type="text" class="set-input" data-setting-key="' + key + '" value="' + escapeHtml(String(value ?? '')) + '" maxlength="120" aria-label="' + escapeHtml(spec.label) + '">';
}

function renderSettings() {
  const grid = $('#settingsGrid');
  if (!grid) return;
  grid.innerHTML = SETTINGS_GROUPS.map((g) =>
    '<div class="card auto set-card"><div class="auto-icon">' + g.icon + '</div><h3>' + escapeHtml(g.title) + '</h3><p>' + escapeHtml(g.sub) + '</p>' +
    '<div class="set-rows">' + g.keys.map((spec) =>
      '<div class="set-row"><div><b>' + escapeHtml(spec.label) + '</b><small>' + escapeHtml(spec.desc) + '</small></div>' +
      settingControlHtml(spec, settingsState.draft[spec.key]) + '</div>',
    ).join('') + '</div></div>',
  ).join('');
  wireSettingsEvents();
}

function findSettingSpec(key) {
  for (const g of SETTINGS_GROUPS) {
    const spec = g.keys.find((k) => k.key === key);
    if (spec) return spec;
  }
  return null;
}

function readSettingInput(el, spec) {
  if (spec.kind === 'number') return el.value === '' ? '' : Number(el.value);
  return el.value;
}

function wireSettingsEvents() {
  if (settingsEventsWired) return;
  const grid = $('#settingsGrid');
  if (!grid) return;
  settingsEventsWired = true;
  const toggle = (sw) => {
    const key = sw.dataset.settingKey;
    if (!key || !(key in settingsState.draft)) return;
    settingsState.draft[key] = !settingsState.draft[key];
    sw.classList.toggle('on', !!settingsState.draft[key]);
    sw.setAttribute('aria-checked', String(!!settingsState.draft[key]));
    const state = sw.parentElement && sw.parentElement.querySelector('.set-state');
    if (state) state.textContent = settingsState.draft[key] ? 'On' : 'Off';
    markSettingsDirty();
  };
  grid.addEventListener('click', (e) => {
    const sw = e.target.closest('.sw[data-setting-key]');
    if (sw) toggle(sw);
  });
  grid.addEventListener('keydown', (e) => {
    const sw = e.target.closest && e.target.closest('.sw[data-setting-key]');
    if (sw && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(sw); }
  });
  const onEdit = (e) => {
    const el = e.target.closest && e.target.closest('[data-setting-key]');
    if (!el || el.classList.contains('sw')) return;
    const spec = findSettingSpec(el.dataset.settingKey);
    if (!spec) return;
    settingsState.draft[spec.key] = readSettingInput(el, spec);
    markSettingsDirty();
  };
  grid.addEventListener('input', onEdit);
  grid.addEventListener('change', onEdit);
}

async function bindSettings() {
  const grid = $('#settingsGrid');
  const saveBtn = $('#settingsSaveBtn');
  if (saveBtn) saveBtn.onclick = saveSettings;
  if (!grid) return;
  try {
    const data = await get('/settings');
    settingsState.original = { ...(data || {}) };
    settingsState.draft = { ...(data || {}) };
    settingsState.loaded = true;
    renderSettings();
    markSettingsClean();
  } catch (e) {
    grid.innerHTML = '<div class="card"><div class="card-body"><div class="section-empty">Settings failed to load: ' + escapeHtml(describeError(e)) + '</div></div></div>';
  }
  // P1 settings extensions (independent sections — failures never break scalars).
  bindFeesSection().catch((e) => showBanner('Fees: ' + describeError(e)));
  bindBusinessRulesSection().catch((e) => showBanner('Business rules: ' + describeError(e)));
  bindUsersSection().catch((e) => showBanner('Users: ' + describeError(e)));
  // Booking extras catalog moved to Facilities Management (#facility-extras).
  // Drop any legacy mount under Settings so the page stays clean.
  document.querySelector('#settings #extrasSection')?.remove();
}

async function saveSettings() {
  if (!settingsState.loaded) return;
  const banner = $('#settingsBanner');
  if (banner) banner.hidden = true;
  const changed = {};
  for (const [k, v] of Object.entries(settingsState.draft)) {
    if (!Object.is(v, settingsState.original[k])) changed[k] = v;
  }
  if (!Object.keys(changed).length) { toast('No changes to save'); return; }
  const btn = $('#settingsSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const saved = await put('/settings', changed);
    settingsState.original = { ...(saved || {}) };
    settingsState.draft = { ...(saved || {}) };
    renderSettings();
    markSettingsClean();
    toast('Settings saved');
  } catch (e) {
    const msg = describeError(e);
    if (banner) { banner.textContent = 'Save failed: ' + msg; banner.hidden = false; }
    toast('Save failed: ' + msg);
    if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }
  }
}

async function bindPromotionsOverview() {
  try {
    ensurePromoLibraryDateFilter();
    const [promos, plans] = await Promise.all([
      get(withDateQuery('/promotions', state.promoLibDate)).catch(() => []),
      get(withDateQuery('/promotion-plans', state.promoLibDate)).catch(() => []),
    ]);
    // Populate overview stats from API data
    const activePlans = plans.filter(p => p.status === 'ACTIVE' || p.status === 'SCHEDULED').length;
    const activePromos = promos.filter(p => p.active).length;
    const totalActive = activePlans + activePromos;
    const elActive = $('#promoActiveCount');
    if (elActive) elActive.textContent = totalActive || '—';
    // Fill promo library table — combine plans + promotions
    const libBody = $('#promoLibraryBody');
    if (libBody) {
      var libRows = [];
      // Plans first
      (plans || []).forEach(function (p) {
        var benefitLabel = p.kind === 'DISCOUNT_MATRIX' ? '% discount' : p.kind === 'FREE_MONTHS' ? (p.freeMonthCount || '') + ' free months' : p.kind === 'PROMO_CODE' ? 'Promo code' : 'Credits';
        var codeLabel = p.code || p.name;
        var statusColor = p.status === 'ACTIVE' ? 'green' : p.status === 'SCHEDULED' ? 'amber' : p.status === 'DRAFT' ? 'amber' : 'grey';
        var tabJump = p.kind === 'DISCOUNT_MATRIX' ? 'promo-discount-matrix' : p.kind === 'FREE_MONTHS' ? 'promo-free-months' : 'promo-code-builder';
        var eligibility = 'Facility-based';
        var commitment = p.commitmentMonths ? p.commitmentMonths + 'm' : 'Any';
        if (p.sizeScope && p.sizeScope !== '["ALL"]') eligibility += ' · ' + (Array.isArray(p.sizeScope) ? p.sizeScope.join(', ') : 'Selected');
        var validFrom = p.effectiveFrom ? fmtDay(p.effectiveFrom) + '–' : '';
        var validTo = p.effectiveTo ? fmtDay(p.effectiveTo) : 'Ongoing';
        var usage = p.kind === 'PROMO_CODE' ? (p.redemptionCap ? '0 / ' + p.redemptionCap : 'Unlimited') : 'Automatic';
        var effDisc = p.kind === 'DISCOUNT_MATRIX' && p.matrixCells && p.matrixCells.length ? 
          Math.min.apply(null, p.matrixCells.map(function(c) { return c.discountPct; })) + '–' + 
          Math.max.apply(null, p.matrixCells.map(function(c) { return c.discountPct; })) + '%' : 
          p.kind === 'FREE_MONTHS' && p.freeMonthCount && p.commitmentMonths ? 
          ((p.freeMonthCount / p.commitmentMonths) * 100).toFixed(1) + '%' : 'Variable';
        // DELETE /promotion-plans/:id is DRAFT-only (400 INVALID_STATUS
        // otherwise), so only drafts get an enabled Delete; non-drafts show
        // a disabled button whose tooltip explains why.
        var delBtn = p.status === 'DRAFT'
          ? '<button class="btn" data-del-plan="' + escapeHtml(p.id) + '" data-del-label="' + escapeHtml(codeLabel) + '" title="Delete this draft plan">Delete</button>'
          : '<button class="btn" disabled title="Only draft plans can be deleted">Delete</button>';
        libRows.push('<tr><td><b>' + escapeHtml(codeLabel) + '</b><br><small>' + escapeHtml(p.name || '') + ' · v' + (p.version || 1) + '</small></td>' +
          '<td>' + benefitLabel + '</td><td>' + eligibility + '</td><td>' + commitment + '</td>' +
          '<td>' + validFrom + validTo + '</td><td>' + usage + '</td><td>' + effDisc + '</td>' +
          '<td><span class="pill ' + statusColor + '">' + p.status + '</span></td>' +
          '<td><button class="btn" data-tab-jump="' + tabJump + '" data-open-plan="' + escapeHtml(p.id) + '" data-plan-kind="' + p.kind + '" title="Open this plan in its builder">Open</button> ' + delBtn + '</td></tr>');
      });
      // Legacy promotions
      (promos || []).forEach(function (p) {
        libRows.push('<tr><td><b>' + escapeHtml(p.code) + '</b><br><small>' + escapeHtml(p.name || '') + '</small></td>' +
          '<td>' + (p.discountType === 'PERCENTAGE' ? '% discount' : p.discountType === 'FLAT' ? '$ off' : 'Free months') + '</td>' +
          '<td>All facilities</td><td>' + (p.minMonths ? p.minMonths + 'm+' : 'Any') + '</td>' +
          '<td>' + (p.startDate ? fmtDay(p.startDate) + '–' : '') + (p.endDate ? fmtDay(p.endDate) : 'Ongoing') + '</td>' +
          '<td>Automatic</td><td>' + p.discountValue + (p.discountType === 'PERCENTAGE' ? '%' : p.discountType === 'FLAT' ? '$ value' : '') + '</td>' +
          '<td><span class="pill ' + (p.active ? 'green' : 'amber') + '">' + (p.active ? 'Active' : 'Draft') + '</span></td>' +
          '<td><button class="btn" data-tab-jump="promo-discount-matrix">Open</button></td></tr>');
      });
      libBody.innerHTML = libRows.length ? libRows.join('') : '<tr><td colspan="9"><div class="section-empty">' + escapeHtml(rangeEmptyText('promotions', state.promoLibDate, 'No promotions or plans yet.')) + '</div></td></tr>';
      libBody.querySelectorAll('[data-del-plan]').forEach(function (b) {
        b.addEventListener('click', function () {
          deletePromoPlan(b.dataset.delPlan, b.dataset.delLabel).catch(function () {});
        });
      });
    }
  } catch (e) { showBanner('Promotions overview: ' + describeError(e)); }
}

// Promotion Library: DRAFT-only delete via DELETE /promotion-plans/:id.
// The API rejects non-DRAFT with 400 INVALID_STATUS — surfaced through
// showBanner so a stale-row race never fails silently.
async function deletePromoPlan(id, label) {
  if (!id) return;
  const name = label || 'draft plan';
  const okConfirm = await confirmDialog({
    title: 'Delete draft plan ' + name + '?',
    message: 'This permanently removes the draft. Published or scheduled versions are never affected.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!okConfirm) return;
  try {
    await del('/promotion-plans/' + encodeURIComponent(id));
  } catch (e) {
    showBanner('Delete: ' + describeError(e));
    return;
  }
  // Drop stale working-draft pointers at the deleted plan so the builders
  // cannot PUT against a plan that no longer exists.
  ['discountPlanId', 'freePlanId', 'codePlanId'].forEach(function (k) {
    if (promoState[k] === id) promoState[k] = null;
  });
  if (promoState.validated) delete promoState.validated[id];
  toast('Deleted draft plan ' + name);
  bindPromotionsOverview().catch(function () {});
  bindPromoHistory().catch(function () {});
  bindPromoDashboardCharts().catch(function () {});
}

// Promotions-library control: ranges Promotion.createdAt + PromotionPlan.effectiveFrom
// server-side (the combined table renders both), refetching on change.
function ensurePromoLibraryDateFilter() {
  const actions = document.querySelector('#promo-library .card-head .actions');
  if (!actions || actions.dataset.dateFilterMounted) return;
  actions.dataset.dateFilterMounted = '1';
  const handle = createDateFilter({
    onChange: (r) => {
      state.promoLibDate = r;
      bindPromotionsOverview().catch(() => {});
    },
  });
  // Date-range trigger is the FIRST control in the actions row (before the
  // Type/Status/Facility/Storage-type filter buttons).
  actions.prepend(handle.el);
}

// ====================== PROMO ENGINE — PHASE 5 BINDINGS ======================
// Module-level promo working state. Previous code kept the draft id in a
// bootPromotions() closure that re-runs on every visit (wiping the id) and
// read a nonexistent #discountPlanId element for duplicates.
const promoState = {
  discountPlanId: null, // DISCOUNT_MATRIX working draft
  freePlanId: null, // FREE_MONTHS working draft
  codePlanId: null, // PROMO_CODE working draft
  validated: {}, // planId -> true after PATCH .../status VALIDATED
};

// Generic data-tab-jump handler (Phase 0 cross-cutting fix): ~12 promo buttons
// use data-tab-jump but only data-page-jump was wired. Document-level
// delegation so runtime-rendered rows (library Open/Edit) work too.
//
// NOTE: `document` is a Document, not an Element — it has NO `dataset`
// property, so `document.dataset.tabJumpWired` throws
// "TypeError: Cannot read properties of undefined (reading 'tabJumpWired')".
// That throw used to escape wireEvents() and abort the whole module: every
// wiring after installPromoTabJump (page jumps, facility/customer/billing/
// promo tabs, drawer, all unit/tenant/booking/lead/inbox/appointment CRUD)
// never ran, and boot() below never got scheduled (no login, no data).
// Idempotence is tracked with a module-level flag; the marker lives on
// document.documentElement (<html>), which does support dataset.
let promoTabJumpWired = false;
function installPromoTabJump() {
  if (promoTabJumpWired) return;
  promoTabJumpWired = true;
  const root = document.documentElement;
  if (root && root.dataset) {
    if (root.dataset.tabJumpWired) return;
    root.dataset.tabJumpWired = '1';
  }
  document.addEventListener('click', function (e) {
    const j = e.target && e.target.closest ? e.target.closest('[data-tab-jump]') : null;
    if (!j) return;
    const tab = document.querySelector('[data-tabs="promo"] [data-tab="' + j.dataset.tabJump + '"]');
    if (tab) tab.click();
  });
}

// Render live POST .../validate results into the validation modal, replacing
// the hardcoded 126-checks skeleton on first real validation.
function renderValidationResults(result) {
  const modal = document.getElementById('validationModal');
  if (!modal) return;
  const stats = modal.querySelector('.stats');
  const list = modal.querySelector('.risk-list');
  if (!result) {
    if (stats) stats.innerHTML = '<div class="stat"><div class="label">Checks</div><div class="val">…</div></div>';
    if (list) list.innerHTML = '<div class="risk"><i>…</i><div><b>Validating…</b><small>Running completeness, rate-floor, overlap and sample-booking checks.</small></div></div>';
    return;
  }
  const passed = (result.checks || []).filter((c) => c.status === 'pass').length;
  if (stats) {
    stats.innerHTML = '<div class="stat"><div class="label">Checks passed</div><div class="val">' + passed + '</div></div>' +
      '<div class="stat"><div class="label">Blockers</div><div class="val" style="color:' + (result.blockers ? 'var(--red)' : 'var(--olive2)') + '">' + result.blockers + '</div></div>' +
      '<div class="stat"><div class="label">Warnings</div><div class="val" style="color:#9b681b">' + result.warnings + '</div></div>';
  }
  if (list) {
    let html = (result.checks || []).map(function (c) {
      const icon = c.status === 'pass' ? '✓' : c.status === 'warning' ? '!' : '✕';
      const cls = c.status === 'pass' ? '' : c.status === 'warning' ? 'warn' : 'bad';
      return '<div class="risk ' + cls + '"><i>' + icon + '</i><div><b>' + escapeHtml(c.status.toUpperCase()) + '</b><small>' + escapeHtml(c.message) + '</small></div></div>';
    }).join('');
    (result.samples || []).slice(0, 3).forEach(function (s) {
      html += '<div class="risk"><i>$</i><div><b>Sample: ' + escapeHtml(s.unitCode) + ' (' + escapeHtml(s.branch) + ')</b><small>$' + s.monthlyRate + '/mo × ' + s.months + 'm = $' + s.baseTotal + ' − $' + s.discountTotal.toFixed(2) + ' → $' + s.effectiveTotal.toFixed(2) + '. ' + escapeHtml(s.note) + '</small></div></div>';
    });
    list.innerHTML = html || '<div class="section-empty">No checks returned.</div>';
  }
  const confirmBtn = document.getElementById('confirmValidation');
  if (confirmBtn) {
    confirmBtn.disabled = !result.valid;
    confirmBtn.title = result.valid ? 'Mark plan VALIDATED' : 'Resolve blockers before confirming';
  }
}

// ---- Free-months builder persistence (kind FREE_MONTHS round-trip) ----
// SIMPLIFICATIONS (documented): facility select stores a branch ID when the
// label matches a known branch, else ["ALL"]; the size select stores canonical
// category labels (["ALL"] or ["MEDIUM","LARGE","XL"]) matching the
// LOCKER/SMALL/... matrix tiers (legacy single-letter rows read as canonical);
// early-exit/min-stay map from label prefixes. Reload reverses the mapping.
function freePanelFields() {
  const sels = Array.from(document.querySelectorAll('#promo-free-months .builder-section .form-grid select'));
  const sections = document.querySelectorAll('#promo-free-months .builder-section');
  return {
    name: document.getElementById('freePlanName'),
    count: document.getElementById('freeMonthCount'),
    commitment: document.getElementById('freeCommitment'),
    facilitySel: sels[2], storageSel: sels[3], sizeSel: sels[4],
    exitSel: sections[2] ? sections[2].querySelectorAll('select') : [],
  };
}

function collectFreeMonthsPayload() {
  const f = freePanelFields();
  const name = (f.name && f.name.value.trim()) || 'Untitled free-months plan';
  const rawCount = f.count ? f.count.value : '1';
  const strip = document.getElementById('monthStrip');
  const freeIdx = strip ? Array.from(strip.querySelectorAll('.month')).map((m, i) => (m.classList.contains('free') ? i : -1)).filter((i) => i >= 0) : [];
  const freeMonthCount = rawCount === 'custom' ? freeIdx.length : parseInt(rawCount, 10);
  const commitmentMonths = f.commitment ? parseInt(f.commitment.value, 10) || 12 : 12;
  let facilityScope = ['ALL'];
  if (f.facilitySel && f.facilitySel.value && !/^all/i.test(f.facilitySel.value)) {
    const hit = (state.branches || []).find((b) => b.name === f.facilitySel.value || b.code === f.facilitySel.value);
    facilityScope = hit ? [hit.id] : [f.facilitySel.value];
  }
  const storageType = f.storageSel ? f.storageSel.value : undefined;
  let sizeScope = ['ALL'];
  if (f.sizeSel && f.sizeSel.value && !/^all/i.test(f.sizeSel.value)) {
    // Canonical write path is MEDIUM/LARGE/XL; legacy "M, L and XL" labels
    // (pre-unification markup) map to the same canonical triple.
    var sv = f.sizeSel.value;
    sizeScope = (sv.indexOf('MEDIUM') >= 0 || sv.indexOf('M, L') >= 0) ? ['MEDIUM', 'LARGE', 'XL'] : [sv];
  }
  let earlyExitTreatment = 'Prorate';
  if (f.exitSel[0]) {
    const v = f.exitSel[0].value;
    earlyExitTreatment = /^claw/i.test(v) ? 'Clawback' : /^keep/i.test(v) ? 'Keep' : 'Prorate';
  }
  let minStayPct = 50;
  if (f.exitSel[1]) {
    const v = f.exitSel[1].value;
    minStayPct = /^75/.test(v) ? 75 : /^100/.test(v) ? 100 : /^no/i.test(v) ? 0 : 50;
  }
  return {
    kind: 'FREE_MONTHS',
    name,
    effectiveFrom: new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z',
    facilityScope,
    storageType,
    sizeScope,
    freeMonthCount: freeMonthCount || 1,
    commitmentMonths,
    earlyExitTreatment,
    minStayPct,
    freeMonths: freeIdx.map((i) => ({ monthIndex: i, free: true })),
  };
}

async function saveFreeMonthsPlan() {
  const payload = collectFreeMonthsPayload();
  if (!payload.freeMonths.length) { showBanner('Select at least one free month on the month strip.'); return null; }
  try {
    if (promoState.freePlanId) {
      await put('/promotion-plans/' + encodeURIComponent(promoState.freePlanId), payload);
    } else {
      const created = await post('/promotion-plans', payload);
      if (created && created.id) promoState.freePlanId = created.id;
    }
    toast('Free-months plan saved: ' + payload.name);
    bindPromotionsOverview().catch(function () {});
    return promoState.freePlanId;
  } catch (e) {
    showBanner('Free-months save: ' + describeError(e));
    return null;
  }
}

async function loadFreeMonthsPlan() {
  // Round-trip: populate the panel from the newest FREE_MONTHS plan.
  let plans = [];
  try { plans = await get('/promotion-plans'); } catch (e) { return; }
  const plan = (plans || []).filter((p) => p.kind === 'FREE_MONTHS')[0];
  if (!plan) return;
  populateFreePanel(plan);
}

// Fill the free-months builder from a specific plan object (Library Open or
// newest-plan round-trip). Sets the working draft id so Save uses PUT /:id
// and Publish walks PATCH /:id/status on the SAME row — never a copy.
function populateFreePanel(plan) {
  if (!plan) return;
  promoState.freePlanId = plan.id;
  promoState.validated[plan.id] = plan.status !== 'DRAFT';
  setPromoStatusPill('freePlanStatus', plan.status);
  const f = freePanelFields();
  if (f.name) f.name.value = plan.name || '';
  if (f.count) f.count.value = String(plan.freeMonthCount || 1);
  if (f.commitment && plan.commitmentMonths) {
    const label = plan.commitmentMonths + ' months';
    Array.from(f.commitment.options || []).forEach((o) => { if (o.text === label || o.value === label) f.commitment.value = o.value || o.text; });
    if (!/1|3|6|12/.test(f.commitment.value)) f.commitment.value = f.commitment.options[3] ? f.commitment.options[3].value : label;
  }
  const idx = (plan.freeMonths || []).filter((a) => a.free).map((a) => a.monthIndex);
  const strip = document.getElementById('monthStrip');
  if (strip) {
    strip.querySelectorAll('.month').forEach(function (m, i) {
      const isFree = idx.indexOf(i) >= 0;
      m.classList.toggle('free', isFree);
      m.innerHTML = m.innerHTML.replace(/100%|FREE/g, isFree ? 'FREE' : '100%');
    });
  }
  if (f.exitSel[0] && plan.earlyExitTreatment) {
    Array.from(f.exitSel[0].options || []).forEach((o) => { if (o.text.indexOf(plan.earlyExitTreatment) === 0) f.exitSel[0].value = o.value || o.text; });
  }
  if (f.exitSel[1] && plan.minStayPct != null) {
    const needle = plan.minStayPct === 0 ? 'No minimum' : plan.minStayPct + '%';
    Array.from(f.exitSel[1].options || []).forEach((o) => { if (o.text.indexOf(needle) === 0) f.exitSel[1].value = o.value || o.text; });
  }
}

// ---- Promo-code builder persistence (kind PROMO_CODE + rules round-trip) ----
// SIMPLIFICATION: the benefit choice (percentage/dollar/free/credits) plus the
// entered value are stored as a human-readable `description` line
// ("BENEFIT: percentage 25%") and re-parsed on reload by leading token; the
// plan's structured fields carry dates, caps, stacking and eligibility rules.
// Rule groupIds: rows joined by OR start a new group, AND rows extend it.
// The code builder offers only PERCENTAGE / DOLLAR / CREDITS — the FREE_MONTHS
// choice stays hidden in markup (standalone promo-free-months section owns it).
// Map via data-benefit on the ACTIVE visible choice so the hidden button can
// never leak a 'free' benefit into a PROMO_CODE payload.
function codePanelBenefit() {
  const choices = Array.from(document.querySelectorAll('#benefitChoices .choice'));
  const active = choices.find((c) => c.classList.contains('active'));
  const raw = active && active.dataset ? active.dataset.benefit : null;
  if (raw === 'percentage' || raw === 'dollar' || raw === 'credits') return raw;
  // Fallback: index among VISIBLE choices only (hidden free-months excluded).
  const visible = choices.filter((c) => !c.hidden && c.style.display !== 'none');
  const idx = visible.indexOf(active);
  return ['percentage', 'dollar', 'credits'][idx < 0 ? 0 : idx] || 'percentage';
}

function collectCodePlanPayload() {
  const nameEl = document.getElementById('promoName');
  const codeEl = document.getElementById('promoCode');
  const valueEl = document.getElementById('promoValue');
  const benefit = codePanelBenefit();
  const name = (nameEl && nameEl.value.trim()) || 'Untitled promotion';
  const code = ((codeEl && codeEl.value.trim()) || '').toUpperCase();
  const value = (valueEl && valueEl.value.trim()) || '';
  const applySel = valueEl && valueEl.closest('.field') && valueEl.closest('.field').nextElementSibling
    ? valueEl.closest('.field').nextElementSibling.querySelector('select') : null;
  const appliesTo = applySel ? applySel.value : undefined;
  const ruleRows = Array.from(document.querySelectorAll('#ruleBuilder .rule-row'));
  let groupId = 0;
  const rules = [];
  ruleRows.forEach(function (row) {
    const label = row.querySelector('b');
    if (label && label.textContent.trim() === 'OR' && rules.length) groupId++;
    const sels = row.querySelectorAll('select');
    const input = row.querySelector('input');
    const field = sels[0] ? sels[0].value : '';
    const operator = sels[1] ? sels[1].value : '';
    const val = input ? input.value.trim() : '';
    if (field && operator && val) rules.push({ groupId, field, operator, value: val });
  });
  const cards = document.querySelectorAll('#promo-code-builder .builder-section');
  const usageCard = cards[2];
  const dates = usageCard ? usageCard.querySelectorAll('input[type="date"]') : [];
  const usageSel = usageCard ? usageCard.querySelector('select') : null;
  const capInput = usageCard ? usageCard.querySelector('input[type="number"]') : null;
  const stackChoices = Array.from(document.querySelectorAll('#promo-code-builder .builder-section .choice-grid .choice'));
  // Stacking grid is the second .choice-grid on the panel (index offset by the
  // 4 benefit choices — the hidden free-months choice stays in the DOM, so the
  // offset is unchanged): active among the last two.
  const stackActive = stackChoices.slice(4).findIndex((c) => c.classList.contains('active'));
  return {
    kind: 'PROMO_CODE',
    name,
    code: code || undefined,
    description: 'BENEFIT: ' + benefit + ' ' + value,
    effectiveFrom: (dates[0] && dates[0].value ? dates[0].value : new Date().toISOString().slice(0, 10)) + 'T00:00:00.000Z',
    effectiveTo: dates[1] && dates[1].value ? dates[1].value + 'T00:00:00.000Z' : undefined,
    facilityScope: ['ALL'],
    sizeScope: ['ALL'],
    appliesTo,
    usagePerCustomer: usageSel && /1 use/.test(usageSel.value) ? 1 : undefined,
    redemptionCap: capInput && capInput.value ? parseInt(capInput.value, 10) : undefined,
    stackingRule: stackActive === 1 ? 'Exclusive' : stackActive === 0 ? 'Can combine selected' : undefined,
    rules: rules.length ? rules : undefined,
  };
}

async function saveCodePlan() {
  const payload = collectCodePlanPayload();
  if (!payload.code) { showBanner('Customer-facing code is required.'); return null; }
  try {
    if (promoState.codePlanId) {
      await put('/promotion-plans/' + encodeURIComponent(promoState.codePlanId), payload);
    } else {
      const created = await post('/promotion-plans', payload);
      if (created && created.id) promoState.codePlanId = created.id;
    }
    toast('Promo code plan saved: ' + payload.code);
    bindPromotionsOverview().catch(function () {});
    return promoState.codePlanId;
  } catch (e) {
    showBanner('Code-builder save: ' + describeError(e));
    return null;
  }
}

async function loadCodePlan() {
  let plans = [];
  try { plans = await get('/promotion-plans'); } catch (e) { return; }
  const plan = (plans || []).filter((p) => p.kind === 'PROMO_CODE')[0];
  if (!plan) return;
  populateCodePanel(plan);
}

// Fill the promo-code builder from a specific plan object (Library Open or
// newest-plan round-trip). Sets the working draft id so Save uses PUT /:id
// and Publish walks PATCH /:id/status on the SAME row — never a copy.
function populateCodePanel(plan) {
  if (!plan) return;
  promoState.codePlanId = plan.id;
  promoState.validated[plan.id] = plan.status !== 'DRAFT';
  setPromoStatusPill('codePlanStatus', plan.status);
  const nameEl = document.getElementById('promoName');
  const codeEl = document.getElementById('promoCode');
  const valueEl = document.getElementById('promoValue');
  if (nameEl && plan.name) nameEl.value = plan.name;
  if (codeEl && plan.code) {
    codeEl.value = plan.code;
    const preview = document.getElementById('codePreview');
    if (preview) preview.textContent = plan.code;
  }
  if (valueEl && plan.description) {
    const m = /^BENEFIT:\s+\w+\s+(.+)$/.exec(plan.description);
    if (m) valueEl.value = m[1];
  }
  const cards = document.querySelectorAll('#promo-code-builder .builder-section');
  const usageCard = cards[2];
  if (usageCard && plan.redemptionCap) {
    const cap = usageCard.querySelector('input[type="number"]');
    if (cap) cap.value = plan.redemptionCap;
  }
  const builder = document.getElementById('ruleBuilder');
  if (builder && plan.rules && plan.rules.length) {
    builder.innerHTML = plan.rules.map(function (r) {
      return '<div class="rule-row"><b>' + (r.groupId > 0 ? 'OR' : 'AND') + '</b><select><option>' + escapeHtml(r.field) + '</option></select><select><option>' + escapeHtml(r.operator) + '</option></select><input value="' + escapeHtml(r.value) + '">';
    }).join('');
  }
}

// ---- Generic publish flow for the free-months + code-builder tabs ----
// Mirrors the discount-matrix tab wiring (Save draft → Validate → SCHEDULED →
// ACTIVE) through the EXISTING state machine only: POST :id/validate
// (read-only checks) and PATCH :id/status (DRAFT→VALIDATED→SCHEDULED→ACTIVE).
// No new contract fields, no second data path, no Prisma enum changes.
const PROMO_PUBLISH_TABS = {
  free: { idKey: 'freePlanId', pillId: 'freePlanStatus', save: () => saveFreeMonthsPlan(), label: 'Free-months plan' },
  code: { idKey: 'codePlanId', pillId: 'codePlanStatus', save: () => saveCodePlan(), label: 'Promo code plan' },
};

function setPromoStatusPill(elId, status) {
  const el = document.getElementById(elId);
  if (!el) return;
  const s = status || 'DRAFT';
  const tone = s === 'ACTIVE' || s === 'VALIDATED' ? 'green' : s === 'SCHEDULED' ? 'amber' : 'grey';
  el.textContent = s.charAt(0) + s.slice(1).toLowerCase();
  el.className = 'pill ' + tone;
}

// Canonical size-category mapping for the discount-matrix builder (mirrors
// core/promotionPlans.ts toCanonicalSizeCategory): new writes use LOCKER /
// SMALL / MEDIUM / LARGE / XL / XXL; legacy XS / S / M / L rows read as
// canonical so pre-unification plans still populate the right row.
function canonicalSizeCat(raw) {
  var k = String(raw == null ? '' : raw).trim().toUpperCase();
  var alias = { XS: 'LOCKER', S: 'SMALL', M: 'MEDIUM', L: 'LARGE' };
  return alias[k] || k || raw;
}

// Fill the discount-matrix builder from a specific plan object (Library Open).
// Sets the working draft id so Save uses PUT /:id and Publish walks PATCH
// /:id/status on the SAME row — never a copy. Cell mapping mirrors
// saveDiscountPlan: row → size category, 4 inputs/row (commitment tiers
// [1, 3, 6, 12]) always Standard.
function populateDiscountPanel(plan) {
  if (!plan) return;
  promoState.discountPlanId = plan.id;
  promoState.validated[plan.id] = plan.status !== 'DRAFT';
  const nameEl = document.getElementById('discountPlanName');
  const dateEl = document.getElementById('discountStartDate');
  const statusEl = document.getElementById('discountPlanStatus');
  if (nameEl && plan.name) nameEl.value = plan.name;
  if (dateEl && plan.effectiveFrom) {
    const d = new Date(plan.effectiveFrom);
    if (!isNaN(d.getTime())) dateEl.value = d.toISOString().slice(0, 10);
  }
  const lookup = {};
  (plan.matrixCells || []).forEach(function (c) {
    // Legacy XS / S / M / L rows (pre-unification) read as canonical LOCKER /
    // SMALL / MEDIUM / LARGE so old plans populate the LOCKER row.
    lookup[canonicalSizeCat(c.sizeCategory) + '|' + c.accessType + '|' + c.commitmentMonths] = c.discountPct;
  });
  const sizeCategories = ['LOCKER', 'SMALL', 'MEDIUM', 'LARGE', 'XL', 'XXL'];
  const commitmentLabels = [1, 3, 6, 12];
  document.querySelectorAll('#promo-discount-matrix .discount-matrix tbody tr').forEach(function (row, ri) {
    if (ri >= sizeCategories.length) return;
    row.querySelectorAll('input').forEach(function (input, ci) {
      if (ci >= 4) return;
      const months = commitmentLabels[ci % 4];
      const key = sizeCategories[ri] + '|' + 'Standard' + '|' + months;
      // legacy-read: Ground floor cells are pre-simplification data; fall back to that value only when no Standard cell exists for this size×month.
      const legacyKey = sizeCategories[ri] + '|Ground floor|' + months; // legacy-read
      const hit = Object.prototype.hasOwnProperty.call(lookup, key) ? key : legacyKey;
      if (Object.prototype.hasOwnProperty.call(lookup, hit)) {
        const n = parseFloat(lookup[hit]) || 0;
        input.value = n + '%';
        input.className = n >= 30 ? 'hot' : n >= 15 ? 'mid' : '';
      }
    });
  });
  if (statusEl) {
    const s = plan.status || 'DRAFT';
    statusEl.textContent = s.charAt(0) + s.slice(1).toLowerCase();
    statusEl.className = 'pill ' + (s === 'ACTIVE' || s === 'VALIDATED' ? 'green' : s === 'SCHEDULED' ? 'amber' : 'grey');
  }
}

// Library Open → load the exact plan into its builder (GET /promotion-plans/:id
// only — never duplicate/restore). The data-tab-jump handler switches the tab;
// this populates the working draft id + fields once the fetch resolves.
async function openPromoPlan(id, kind) {
  if (!id) return;
  let plan = null;
  try {
    plan = await get('/promotion-plans/' + encodeURIComponent(id));
  } catch (e) {
    showBanner('Open: ' + describeError(e));
    return;
  }
  if (!plan) return;
  const k = kind || plan.kind;
  if (k === 'DISCOUNT_MATRIX') populateDiscountPanel(plan);
  else if (k === 'FREE_MONTHS') populateFreePanel(plan);
  else populateCodePanel(plan);
  toast('Opened ' + (plan.name || plan.code || plan.id));
}

// Document-level delegation (runtime-rendered Library rows included).
// Idempotent: bootPromotions() re-runs on every promotions visit.
let promoOpenWired = false;
function installPromoOpenHandler() {
  if (promoOpenWired) return;
  promoOpenWired = true;
  document.addEventListener('click', function (e) {
    const b = e.target && e.target.closest ? e.target.closest('[data-open-plan]') : null;
    if (!b) return;
    openPromoPlan(b.dataset.openPlan, b.dataset.planKind).catch(function () {});
  });
}

// Validate = save (if needed), then render live POST .../validate results in
// the shared validation modal. Does not change plan status.
async function validatePromoPlan(kind) {
  const tab = PROMO_PUBLISH_TABS[kind];
  if (!tab) return;
  let pid = promoState[tab.idKey];
  if (!pid) {
    pid = await tab.save();
    if (!pid) return;
  }
  const modal = document.getElementById('validationModal');
  if (modal) modal.classList.add('open');
  renderValidationResults(null); // loading state
  try {
    const result = await post('/promotion-plans/' + encodeURIComponent(pid) + '/validate', {});
    renderValidationResults(result);
    if (result && result.valid) toast(tab.label + ' passed validation — schedule when ready.');
    else showBanner('Validation found ' + (result ? result.blockers : '?') + ' blocker(s) — see Plan validation.');
  } catch (e) {
    renderValidationResults({ valid: false, blockers: 1, warnings: 0, checks: [{ status: 'blocker', message: 'Validation request failed: ' + describeError(e) }], overlaps: [], samples: [] });
  }
}

// Schedule = save draft, then VALIDATED (if needed) → SCHEDULED through the
// status state machine. Blockers reject with a surfaced error + modal.
async function schedulePromoPlan(kind) {
  const tab = PROMO_PUBLISH_TABS[kind];
  if (!tab) return;
  let pid = promoState[tab.idKey] || await tab.save();
  if (!pid) return;
  pid = promoState[tab.idKey];
  if (!pid) return;
  try {
    if (!promoState.validated[pid]) {
      await patch('/promotion-plans/' + encodeURIComponent(pid) + '/status', { status: 'VALIDATED' });
      promoState.validated[pid] = true;
    }
    await patch('/promotion-plans/' + encodeURIComponent(pid) + '/status', { status: 'SCHEDULED' });
    setPromoStatusPill(tab.pillId, 'SCHEDULED');
    toast(tab.label + ' scheduled');
    bindPromotionsOverview().catch(function () {});
  } catch (e) {
    showBanner('Schedule: ' + describeError(e));
    validatePromoPlan(kind).catch(function () {});
  }
}

// Publish = walk the plan to ACTIVE through the state machine (DRAFT →
// VALIDATED → SCHEDULED → ACTIVE as needed). Server re-validates on the
// VALIDATED edge, so blockers surface instead of slipping through.
// In-place only: saves via PUT /:id when a working draft id exists (POST only
// for a genuinely new plan), then PATCHes /:id/status on the SAME id — never
// duplicate/restore. Double-click guarded; a second Publish on ACTIVE is a
// harmless no-op toast (checked BEFORE saving so the live plan is untouched).
const promoPublishBusy = {};
async function publishPromoPlan(kind) {
  const tab = PROMO_PUBLISH_TABS[kind];
  if (!tab) return;
  if (promoPublishBusy[kind]) return;
  promoPublishBusy[kind] = true;
  const btn = document.getElementById(kind === 'free' ? 'freePublishBtn' : kind === 'code' ? 'codePublishBtn' : kind + 'PublishBtn');
  if (btn) btn.disabled = true;
  try {
    let pid = promoState[tab.idKey];
    if (pid) {
      let pre = null;
      try { pre = await get('/promotion-plans/' + encodeURIComponent(pid)); } catch (e) { pre = null; }
      if (pre && pre.status === 'ACTIVE') {
        setPromoStatusPill(tab.pillId, 'ACTIVE');
        toast(tab.label + ' is already active');
        return;
      }
    } else {
      pid = await tab.save();
      if (!pid) return;
    }
    let status = null;
    try {
      const current = await get('/promotion-plans/' + encodeURIComponent(pid));
      status = current && current.status;
    } catch (e) { status = null; }
    if (status === 'ACTIVE') {
      setPromoStatusPill(tab.pillId, 'ACTIVE');
      toast(tab.label + ' is already active');
      return;
    }
    if (!status || status === 'DRAFT') {
      await patch('/promotion-plans/' + encodeURIComponent(pid) + '/status', { status: 'VALIDATED' });
      promoState.validated[pid] = true;
      status = 'VALIDATED';
    }
    if (status === 'VALIDATED') {
      await patch('/promotion-plans/' + encodeURIComponent(pid) + '/status', { status: 'SCHEDULED' });
      status = 'SCHEDULED';
    }
    await patch('/promotion-plans/' + encodeURIComponent(pid) + '/status', { status: 'ACTIVE' });
    setPromoStatusPill(tab.pillId, 'ACTIVE');
    toast(tab.label + ' is now active');
    bindPromotionsOverview().catch(function () {});
  } catch (e) {
    showBanner('Publish: ' + describeError(e));
  } finally {
    promoPublishBusy[kind] = false;
    if (btn) btn.disabled = false;
  }
}

// Inject save + publish bars into the free-months + code-builder summary cards
// (those panels ship no action buttons in markup). Idempotent: each button is
// created once and wired once; re-runs are no-ops.
function ensurePromoSaveBars() {
  const bars = [
    { summarySel: '#promo-free-months .builder-summary', kind: 'free', prefix: 'free' },
    { summarySel: '#promo-code-builder .builder-summary', kind: 'code', prefix: 'code' },
  ];
  bars.forEach(function (b) {
    const summary = document.querySelector(b.summarySel);
    if (!summary) return;
    if (!document.getElementById(b.prefix + 'SaveBtn')) {
      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;gap:8px;margin-top:14px';
      bar.innerHTML = '<button class="primary" id="' + b.prefix + 'SaveBtn" style="flex:1">Save draft</button><button class="btn" id="' + b.prefix + 'ReloadBtn">Reload</button>';
      summary.appendChild(bar);
      document.getElementById(b.prefix + 'SaveBtn').addEventListener('click', function () {
        (b.kind === 'free' ? saveFreeMonthsPlan() : saveCodePlan()).catch(function () {});
      });
      document.getElementById(b.prefix + 'ReloadBtn').addEventListener('click', function () {
        (b.kind === 'free' ? loadFreeMonthsPlan() : loadCodePlan()).catch(function () {});
      });
    }
    // Validate → Schedule → Publish row (mirrors the discount-matrix tab).
    if (!document.getElementById(b.prefix + 'ValidateBtn')) {
      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap';
      bar.innerHTML = '<button class="btn" id="' + b.prefix + 'ValidateBtn" style="flex:1">Validate</button>' +
        '<button class="btn" id="' + b.prefix + 'ScheduleBtn" style="flex:1">Schedule</button>' +
        '<button class="btn" id="' + b.prefix + 'PublishBtn" style="flex:1">Publish</button>';
      summary.appendChild(bar);
      document.getElementById(b.prefix + 'ValidateBtn').addEventListener('click', function () { validatePromoPlan(b.kind).catch(function () {}); });
      document.getElementById(b.prefix + 'ScheduleBtn').addEventListener('click', function () { schedulePromoPlan(b.kind).catch(function () {}); });
      document.getElementById(b.prefix + 'PublishBtn').addEventListener('click', function () { publishPromoPlan(b.kind).catch(function () {}); });
    }
  });
}

// ---- Safeguards panel: live CRUD against /safeguards ----
// Priority config UI is EXPLICITLY DROPPED: the order is fixed by spec §2.4
// (contracted rate → automatic plan → promo code → credits) and rendered as a
// note below. One rent promotion per agreement; credits stack last.
async function bindSafeguards() {
  const panel = document.getElementById('promo-safeguards');
  if (!panel) return;
  let card = document.getElementById('promoSafeguardCard');
  if (!card) {
    card = document.createElement('div');
    card.className = 'card';
    card.id = 'promoSafeguardCard';
    panel.querySelector('.analytics-grid').prepend(card);
  }
  let rules = [];
  try { rules = await get('/safeguards'); } catch (e) { rules = []; }
  const branchOpts = ['<option value="">Global (all facilities)</option>'].concat((state.branches || []).map((b) =>
    '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(b.name) + ' (' + escapeHtml(b.code) + ')</option>')).join('');
  card.innerHTML = '<div class="card-head"><h3>Configured rate floors</h3><small style="color:var(--muted)">' + rules.length + ' rule(s)</small></div>' +
    '<div class="card-body">' +
    (rules.length ? '<table class="lead-table"><thead><tr><th>Facility</th><th>Floor $/mo</th><th>Approval ≥ %</th><th>Approver</th><th></th></tr></thead><tbody>' +
      rules.map((r) => '<tr><td>' + escapeHtml(r.facility ? r.facility.name : 'Global') + '</td><td><b>$' + r.minEffectiveRate + '</b></td><td>' + (r.requiresApprovalAbove != null ? r.requiresApprovalAbove + '%' : '—') + '</td><td>' + escapeHtml(r.approverRole || '—') + '</td><td><button class="act-btn danger" data-saf-del="' + escapeHtml(r.id) + '">Delete</button></td></tr>').join('') +
      '</tbody></table>'
      : '<div class="section-empty">No safeguard rules yet — validation skips rate-floor checks until one exists.</div>') +
    '<div class="form-grid" style="margin-top:12px"><div class="field"><label>Facility</label><select id="safFacility">' + branchOpts + '</select></div>' +
    '<div class="field"><label>Floor $/mo</label><input id="safFloor" type="number" min="0" value="80"></div>' +
    '<div class="field"><label>Approval ≥ %</label><input id="safThreshold" type="number" min="0" value="25"></div>' +
    '<div class="field"><label>Approver role</label><input id="safApprover" value="MANAGER"></div></div>' +
    '<div style="display:flex;gap:8px;margin-top:10px"><button class="primary" id="safAddBtn">Add rule</button></div>' +
    '<div class="rulebox" style="margin-top:12px"><b>Priority (fixed, no config UI):</b> contracted rate → automatic plan → promo code → credits. One rent promotion per agreement; credits apply last within an invoice-level cap.</div>' +
    '</div>';
  card.querySelectorAll('[data-saf-del]').forEach(function (b) {
    b.addEventListener('click', async function () {
      try {
        await del('/safeguards/' + encodeURIComponent(b.dataset.safDel));
        toast('Safeguard deleted');
        bindSafeguards().catch(function () {});
      } catch (e) { showBanner('Safeguard delete: ' + describeError(e)); }
    });
  });
  const add = document.getElementById('safAddBtn');
  if (add) add.addEventListener('click', async function () {
    const body = {
      minEffectiveRate: parseFloat(document.getElementById('safFloor').value) || 0,
      requiresApprovalAbove: document.getElementById('safThreshold').value !== '' ? parseFloat(document.getElementById('safThreshold').value) : undefined,
      approverRole: document.getElementById('safApprover').value.trim() || undefined,
    };
    const fac = document.getElementById('safFacility').value;
    if (fac) body.facilityId = fac;
    try {
      await post('/safeguards', body);
      toast('Safeguard added');
      bindSafeguards().catch(function () {});
    } catch (e) { showBanner('Safeguard add: ' + describeError(e)); }
  });
}

// ---- History panel: live versions + restore-as-draft + field diff ----
async function bindPromoHistory(planId) {
  const panel = document.getElementById('promo-history');
  if (!panel) return;
  let plans = [];
  try { plans = await get('/promotion-plans'); } catch (e) { plans = []; }
  if (!plans.length) {
    const tb = panel.querySelector('tbody');
    if (tb) tb.innerHTML = '<tr><td colspan="7"><div class="section-empty">No plans yet — save a draft from a builder panel.</div></td></tr>';
    return;
  }
  const current = (plans || []).find((p) => p.id === planId) || (plans || []).find((p) => p.id === promoState.discountPlanId) || plans[0];
  let versions = [];
  try { versions = await get(withDateQuery('/promotion-plans/' + encodeURIComponent(current.id) + '/versions', state.promoHistDate)); } catch (e) { versions = []; }
  const head = panel.querySelector('.card-head');
  let picker = document.getElementById('historyPlanSelect');
  if (head && !picker) {
    picker = document.createElement('select');
    picker.id = 'historyPlanSelect';
    picker.className = 'tbl-select';
    head.appendChild(picker);
    picker.addEventListener('change', function () { bindPromoHistory(picker.value).catch(function () {}); });
  }
  if (picker) {
    picker.innerHTML = plans.map((p) => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + ' (' + p.status + ')</option>').join('');
    picker.value = current.id;
  }
  const tb = panel.querySelector('tbody');
  if (tb) {
    ensurePromoHistoryDateFilter(current);
    tb.innerHTML = versions.length ? versions.map(function (v) {
      const when = v.createdAt ? fmtDay(v.createdAt) : '—';
      return '<tr><td><b>v' + v.version + '</b></td><td>' + escapeHtml(current.name) + '</td><td>' + escapeHtml(fmtDay(current.effectiveFrom)) + '–' + (current.effectiveTo ? escapeHtml(fmtDay(current.effectiveTo)) : 'ongoing') + '</td><td>' + escapeHtml(v.changedBy) + ' · ' + when + '</td><td>' + escapeHtml(v.changeSummary || '') + '</td><td><span class="pill ' + (current.status === 'ACTIVE' ? 'green' : current.status === 'DRAFT' ? 'amber' : 'grey') + '">' + current.status + '</span></td><td><button class="btn" data-restore-v="' + v.version + '">Restore as draft</button></td></tr>';
    }).join('') : '<tr><td colspan="7"><div class="section-empty">' + escapeHtml(rangeEmptyText('versions', state.promoHistDate, 'No versions recorded for this plan.')) + '</div></td></tr>';
    tb.querySelectorAll('[data-restore-v]').forEach(function (b) {
      b.addEventListener('click', async function () {
        try {
          await post('/promotion-plans/' + encodeURIComponent(current.id) + '/restore', { version: parseInt(b.dataset.restoreV, 10) });
          toast('Restored v' + b.dataset.restoreV + ' as a new draft');
          bindPromoHistory(current.id).catch(function () {});
          bindPromotionsOverview().catch(function () {});
        } catch (e) { showBanner('Restore: ' + describeError(e)); }
      });
    });
  }
  // Compare: field-level diff between two versions (scalar keys + nested
  // length/hash; per-row 36-cell matrix diffs are follow-up).
  let diffBox = document.getElementById('historyDiff');
  if (!diffBox) {
    diffBox = document.createElement('div');
    diffBox.id = 'historyDiff';
    diffBox.className = 'card-body';
    panel.querySelector('.card').appendChild(diffBox);
  }
  const vmax = versions.length ? versions[0].version : 1;
  diffBox.innerHTML = '<div class="rulebox"><b>Compare versions:</b> <select id="cmpFrom" class="tbl-select">' +
    versions.map((v) => '<option value="' + v.version + '">v' + v.version + '</option>').join('') + '</select> → ' +
    '<select id="cmpTo" class="tbl-select">' + versions.map((v) => '<option value="' + v.version + '"' + (v.version === vmax ? ' selected' : '') + '>v' + v.version + '</option>').join('') + '</select> ' +
    '<button class="btn" id="cmpBtn">Compare</button><div id="cmpOut" style="margin-top:8px"></div></div>';
  const cmpBtn = document.getElementById('cmpBtn');
  if (cmpBtn) cmpBtn.addEventListener('click', async function () {
    const from = document.getElementById('cmpFrom').value;
    const to = document.getElementById('cmpTo').value;
    const out = document.getElementById('cmpOut');
    try {
      const cmp = await get('/promotion-plans/' + encodeURIComponent(current.id) + '/compare?from=' + from + '&to=' + to);
      out.innerHTML = cmp.diff.length ? '<table class="lead-table"><thead><tr><th>Field</th><th>v' + from + '</th><th>v' + to + '</th></tr></thead><tbody>' +
        cmp.diff.map((d) => '<tr><td><b>' + escapeHtml(d.field) + '</b></td><td><small>' + escapeHtml(JSON.stringify(d.from)) + '</small></td><td><small>' + escapeHtml(JSON.stringify(d.to)) + '</small></td></tr>').join('') + '</tbody></table>'
        : '<div class="section-empty">No field differences between v' + from + ' and v' + to + '.</div>';
    } catch (e) { out.innerHTML = '<div class="section-empty">Compare failed: ' + escapeHtml(describeError(e)) + '</div>'; }
  });
}

// Promo-history control: ranges PromotionVersion.createdAt server-side for the
// selected plan; changing the range rebinds history (plan picker preserved).
function ensurePromoHistoryDateFilter(current) {
  const head = document.querySelector('#promo-history .card-head');
  if (!head || head.dataset.dateFilterMounted) return;
  head.dataset.dateFilterMounted = '1';
  const handle = createDateFilter({
    onChange: (r) => {
      state.promoHistDate = r;
      bindPromoHistory(current && current.id).catch(function () {});
    },
  });
  // .card-head leads with the title block — the date trigger goes right after
  // it so it is the first control (before Duplicate / the plan picker).
  const histTitle = head.firstElementChild;
  if (histTitle && histTitle.nextSibling) head.insertBefore(handle.el, histTitle.nextSibling);
  else head.appendChild(handle.el);
}

// ---- Performance panel + overview cards: live aggregation ----
// Revenue/retention need invoice + tenant-tenure joins (follow-up) — rendered
// as honest "—", never fabricated. Eligible-bookings likewise.
async function bindPromoPerformance() {
  const panel = document.getElementById('promo-performance');
  if (!panel) return;
  let perf = null;
  try { perf = await get('/promotion-plans/performance'); } catch (e) { perf = null; }
  const cards = panel.querySelectorAll('.card');
  const tableCard = cards[2];
  if (tableCard && perf) {
    const body = tableCard.querySelector('.card-body');
    if (body) {
      body.innerHTML = perf.plans.length ? '<table class="staff"><tr><th>Plan</th><th>Applied</th><th>Discount cost</th><th>Cap used</th><th>Budget used</th><th>Revenue</th><th>Retention</th></tr>' +
        perf.plans.map((p) => '<tr><td><b>' + escapeHtml(p.planName) + '</b><br><small>' + p.kind + ' · ' + p.status + '</small></td><td>' + p.applied + '</td><td>$' + p.discountCost.toLocaleString() + '</td><td>' + (p.capUsedPct != null ? p.capUsedPct + '%' : '—') + '</td><td>' + (p.budgetUsedPct != null ? p.budgetUsedPct + '%' : '—') + '</td><td>—</td><td>—</td></tr>').join('') +
        '</table><div class="rulebox" style="margin-top:10px"><b>Note:</b> revenue and retention need invoice/tenure joins (follow-up). Redemptions are recorded via POST /promotion-plans/:id/redemptions — booking-time auto-link is follow-up (no booking-create route exists in this service).</div>'
        : '<div class="section-empty">No plans yet — performance appears once plans and redemptions exist.</div>';
    }
  }
  // Overview cards: live where computable, honest "—" otherwise.
  if (perf) {
    const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    const byKind = {};
    perf.plans.forEach((p) => { byKind[p.kind] = (byKind[p.kind] || 0) + 1; });
    set('#promoActiveCount', String(perf.totals.activePlans));
    const trend = document.querySelector('#promoActiveCount');
    if (trend && trend.parentElement) {
      const sub = trend.parentElement.querySelector('.trend');
      if (sub) sub.textContent = Object.entries(byKind).map(([k, v]) => v + ' ' + k.toLowerCase().replace(/_/g, ' ')).join(' · ') || 'no plans';
    }
    set('#promoDiscountCost', '$' + perf.totals.totalDiscountCost.toLocaleString());
    set('#promoEffectiveRevenue', '—');
    set('#promoConflicts', '—');
    // Attention queue from live plan states. Draft items intentionally omitted
    // (owner request: first/topmost draft section removed); scheduled items stay.
    const att = document.getElementById('promoAttentionList');
    if (att) {
      const items = [];
      perf.plans.filter((p) => p.status === 'SCHEDULED').forEach((p) => {
        items.push('<div class="qitem"><i style="color:var(--amber);font-weight:800;width:20px">!</i><div><b>' + escapeHtml(p.planName) + ' scheduled</b><br><small>Awaiting activation.</small></div><span class="pill amber">Scheduled</span></div>');
      });
      att.innerHTML = items.length ? items.join('') : '<div class="section-empty">No attention items — all plans active or ended.</div>';
    }
  }
}

// ---- Promotion Dashboard charts (Chart.js, live data, empty-state safe) ----
// Discount chart: discount cost by plan from GET /promotion-plans/performance.
// Status chart: plan counts by status (performance) + legacy promo-code counts
// from GET /promotions. No sample data is fabricated: when the APIs return
// nothing the canvases hide and the .section-empty fallbacks show instead.
// Styling follows dashboardView.js (Manrope ticks, v8 palette, no legend on
// single-series bars, bottom legend on the doughnut).
const PROMO_CHART_COLORS = ['#c97952', '#526557', '#334437', '#547b8d', '#e5a84b', '#aa5d3c'];
const PROMO_STATUS_COLORS = { ACTIVE: '#526557', SCHEDULED: '#e5a84b', DRAFT: '#c97952', VALIDATED: '#547b8d', ENDED: '#a0a59c' };

function promoChartLib() {
  return typeof globalThis.Chart !== 'undefined' ? globalThis.Chart : null;
}

function destroyPromoChart(id) {
  const lib = promoChartLib();
  if (!lib || !lib.getChart) return;
  try {
    const existing = lib.getChart(id);
    if (existing) existing.destroy();
  } catch (e) { /* a half-initialised chart is safe to abandon */ }
}

function setPromoChartEmpty(canvasId, emptyId, isEmpty) {
  const canvas = document.getElementById(canvasId);
  const empty = document.getElementById(emptyId);
  if (canvas) canvas.style.display = isEmpty ? 'none' : '';
  if (empty) empty.hidden = !isEmpty;
}

function renderPromoDiscountChart(rows) {
  const canvas = document.getElementById('promoDiscountChart');
  if (!canvas) return;
  const lib = promoChartLib();
  const top = (rows || []).slice(0, 8);
  if (!lib || !top.length) {
    destroyPromoChart('promoDiscountChart');
    setPromoChartEmpty('promoDiscountChart', 'promoDiscountEmpty', true);
    return;
  }
  setPromoChartEmpty('promoDiscountChart', 'promoDiscountEmpty', false);
  destroyPromoChart('promoDiscountChart');
  const labels = top.map((p) => String(p.planName || p.kind || 'Plan').slice(0, 18));
  const costs = top.map((p) => Number(p.discountCost) || 0);
  const applied = top.map((p) => Number(p.applied) || 0);
  new lib(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Discount cost',
        data: costs,
        backgroundColor: top.map((_, i) => PROMO_CHART_COLORS[i % PROMO_CHART_COLORS.length]),
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ' $' + Number(ctx.raw || 0).toLocaleString() + ' · ' + (applied[ctx.dataIndex] || 0) + ' redemption(s)',
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#6f746d' } },
        y: { grid: { color: '#ede8e2' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#6f746d', callback: (v) => '$' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v) } },
      },
    },
  });
}

function renderPromoStatusChart(rows, promos) {
  const canvas = document.getElementById('promoStatusChart');
  if (!canvas) return;
  const lib = promoChartLib();
  const buckets = {};
  (rows || []).forEach((p) => {
    const s = String(p.status || 'UNKNOWN');
    buckets[s] = (buckets[s] || 0) + 1;
  });
  const legacyActive = (promos || []).filter((p) => p.active).length;
  const legacyDraft = (promos || []).length - legacyActive;
  if (legacyActive > 0) buckets['CODE active'] = (buckets['CODE active'] || 0) + legacyActive;
  if (legacyDraft > 0) buckets['CODE draft'] = (buckets['CODE draft'] || 0) + legacyDraft;
  const labels = Object.keys(buckets);
  if (!lib || !labels.length) {
    destroyPromoChart('promoStatusChart');
    setPromoChartEmpty('promoStatusChart', 'promoStatusEmpty', true);
    return;
  }
  setPromoChartEmpty('promoStatusChart', 'promoStatusEmpty', false);
  destroyPromoChart('promoStatusChart');
  new lib(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: labels.map((l) => buckets[l]),
        backgroundColor: labels.map((l, i) => PROMO_STATUS_COLORS[l] || PROMO_CHART_COLORS[i % PROMO_CHART_COLORS.length]),
        borderColor: '#fffdfa',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { font: { family: 'Manrope', size: 10 }, color: '#20241f', boxWidth: 10, padding: 12 } },
      },
    },
  });
}

async function bindPromoDashboardCharts() {
  if (!document.getElementById('promoDashboardCharts')) return;
  let perf = null;
  let promos = [];
  try { perf = await get('/promotion-plans/performance'); } catch (e) { perf = null; }
  try { promos = await get('/promotions'); } catch (e) { promos = []; }
  const rows = (perf && perf.plans) || [];
  renderPromoDiscountChart(rows);
  renderPromoStatusChart(rows, promos || []);
}

// ====================== PROMOTIONS INTERACTIVITY (ported from prototype) ======================
function bootPromotions() {
  // --- 1. Discount matrix color coding ---
  document.querySelectorAll('.discount-matrix input').forEach(function (input) {
    input.addEventListener('change', function () {
      var n = parseFloat(this.value) || 0;
      this.className = n >= 30 ? 'hot' : n >= 15 ? 'mid' : '';
      toast('Matrix cell updated to ' + n + '%');
    });
  });

  // --- 2. Promo code builder: benefit choice switching ---
  var promoCode = document.getElementById('promoCode');
  var promoValue = document.getElementById('promoValue');
  var benefitChoices = document.getElementById('benefitChoices');
  var promoBenefit = 'percentage';

  function renderPromoBenefit() {
    if (!promoValue) return;
    var label = promoValue.previousElementSibling;
    var applyField = promoValue.closest('.field').nextElementSibling;
    var applyLabel = applyField.querySelector('label');
    var applySelect = applyField.querySelector('select');
    var preview = document.getElementById('benefitPreview');
    if (promoBenefit === 'percentage') {
      label.textContent = 'Discount percentage';
      if (!promoValue.value.includes('%')) promoValue.value = '25%';
      applyLabel.textContent = 'Apply discount to';
      applySelect.innerHTML = '<option>First invoice only</option><option>First 3 invoices</option><option>Every invoice during commitment</option><option>Selected months</option>';
      preview.textContent = promoValue.value + ' off first invoice';
    } else if (promoBenefit === 'dollar') {
      label.textContent = 'Discount amount';
      promoValue.value = '$25';
      applyLabel.textContent = 'Apply discount to';
      applySelect.innerHTML = '<option>First invoice only</option><option>First 3 invoices</option><option>Every invoice during commitment</option>';
      preview.textContent = promoValue.value + ' off first invoice';
    } else {
      // 'credits' (free-months benefit lives in the standalone section)
      promoBenefit = 'credits';
      label.textContent = 'StoreLah Credit value';
      promoValue.value = '$25';
      applyLabel.textContent = 'Issue credits when';
      applySelect.innerHTML = '<option>After move-in</option><option>After first payment</option><option>Immediately after approval</option>';
      preview.textContent = '$25 StoreLah Credits';
    }
  }

  // Benefit switching reads data-benefit (hidden free-months choice excluded —
  // clicking it is impossible, and codePanelBenefit() maps visible-only).
  if (benefitChoices) {
    benefitChoices.querySelectorAll('.choice').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var b = btn.dataset ? btn.dataset.benefit : null;
        promoBenefit = (b === 'percentage' || b === 'dollar' || b === 'credits') ? b : 'percentage';
        renderPromoBenefit();
      });
    });
  }
  if (promoCode) {
    promoCode.addEventListener('input', function () {
      var el = document.getElementById('codePreview');
      if (el) el.textContent = (promoCode.value || 'NEWCODE').toUpperCase();
    });
  }
  if (promoValue) {
    promoValue.addEventListener('input', function () {
      var p = document.getElementById('benefitPreview');
      if (p) p.textContent = promoBenefit === 'credits' ? (promoValue.value || '$0') + ' StoreLah Credits' : (promoValue.value || '0') + ' off first invoice';
    });
  }

  // --- 3. Rule builder: add condition ---
  var addRule = document.getElementById('addRule');
  if (addRule) {
    addRule.addEventListener('click', function () {
      var row = document.createElement('div');
      row.className = 'rule-row';
      row.innerHTML = '<b>AND</b><select><option>Customer type</option><option>Specific customer</option><option>Customer group</option><option>Birthday window</option><option>Storage tenure</option><option>Move-in date</option><option>Occupancy threshold</option></select><select><option>equals</option><option>is any of</option><option>at least</option><option>is between</option></select><input placeholder="Choose value…">';
      document.getElementById('ruleBuilder').appendChild(row);
      toast('Condition added');
    });
  }

  // --- 4. Free months month strip ---
  var monthStrip = document.getElementById('monthStrip');
  var freeMonthCount = document.getElementById('freeMonthCount');
  var freeCommitment = document.getElementById('freeCommitment');

  function selectedFreeMonths() {
    return monthStrip ? Array.from(monthStrip.querySelectorAll('.month')).filter(function (m) { return m.classList.contains('free'); }) : [];
  }

  function renderFreeSummary() {
    if (!monthStrip) return;
    var chosen = selectedFreeMonths();
    var limit = freeMonthCount.value;
    var offerEl = document.getElementById('freeOfferSummary');
    if (offerEl) offerEl.textContent = limit === 'custom' ? chosen.length + ' selected' : limit + ' free month' + (limit === '1' ? '' : 's');
    var commitEl = document.getElementById('freeCommitmentSummary');
    if (commitEl) commitEl.textContent = freeCommitment.value;
    var appliedEl = document.getElementById('freeAppliedSummary');
    if (appliedEl) appliedEl.textContent = chosen.length ? 'Month' + (chosen.length > 1 ? 's ' : ' ') + chosen.map(function (m) { return Array.from(monthStrip.children).indexOf(m) + 1; }).join(', ') : 'None selected';
    var term = parseInt(freeCommitment.value) || 12;
    var effEl = document.getElementById('freeEffectiveSummary');
    if (effEl) effEl.textContent = ((chosen.length / term) * 100).toFixed(2) + '%';
  }

  function setFreeMonths(indices) {
    monthStrip.querySelectorAll('.month').forEach(function (m, i) {
      var isFree = indices.indexOf(i) >= 0;
      m.classList.toggle('free', isFree);
      m.innerHTML = m.innerHTML.replace(/100%|FREE/g, isFree ? 'FREE' : '100%');
    });
    renderFreeSummary();
  }

  if (monthStrip) {
    monthStrip.querySelectorAll('.month').forEach(function (m) {
      m.addEventListener('click', function () {
        var limit = freeMonthCount.value;
        var already = this.classList.contains('free');
        if (!already && limit !== 'custom' && selectedFreeMonths().length >= (+limit || 0)) {
          toast('This offer allows ' + limit + ' free months. Deselect one first or choose Custom.');
          return;
        }
        this.classList.toggle('free');
        this.innerHTML = this.classList.contains('free') ? this.innerHTML.replace('100%', 'FREE') : this.innerHTML.replace('FREE', '100%');
        renderFreeSummary();
      });
    });
    if (freeMonthCount) {
      freeMonthCount.addEventListener('change', function () {
        var count = this.value;
        if (count !== 'custom') {
          var n = +count;
          setFreeMonths(n === 1 ? [11] : n === 2 ? [5, 11] : [3, 7, 11]);
        } else renderFreeSummary();
      });
    }
    if (freeCommitment) {
      freeCommitment.addEventListener('change', renderFreeSummary);
    }
    document.querySelectorAll('#allocationChoices [data-allocation]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var raw = freeMonthCount.value;
        var count = raw === 'custom' ? selectedFreeMonths().length : +raw;
        var term = parseInt(freeCommitment.value) || 12;
        if (this.dataset.allocation === 'custom') {
          freeMonthCount.value = 'custom';
          renderFreeSummary();
          return;
        }
        var ids = [];
        if (this.dataset.allocation === 'upfront') ids = Array.from({ length: count }, function (_, i) { return i; });
        if (this.dataset.allocation === 'back') ids = Array.from({ length: count }, function (_, i) { return term - count + i; });
        if (this.dataset.allocation === 'spread') ids = Array.from({ length: count }, function (_, i) { return Math.round((term / (count || 1)) * (i + 1)) - 1; });
        setFreeMonths(ids);
      });
    });
    renderFreeSummary();
  }

  // --- 5. Validation modal (Phase 5: renders REAL checks from
  // POST /promotion-plans/:id/validate — the hardcoded 126-checks mock above
  // is only the first-paint skeleton until the fetch resolves) ---
  var validationModal = document.getElementById('validationModal');
  var discountStatus = document.getElementById('discountPlanStatus');
  var discountPlanName = document.getElementById('discountPlanName');
  var discountStartDate = document.getElementById('discountStartDate');

  // Create validation modal if it doesn't exist
  if (!validationModal) {
    document.body.insertAdjacentHTML('beforeend',
      '<div class="modal" id="validationModal"><div class="overlay" data-close-validation></div><div class="modal-card"><header><div><h2>Plan validation</h2><small style="color:var(--muted)">Pre-publish commercial and rule checks</small></div><button class="iconbtn" data-close-validation>×</button></header><section><div class="stats" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px"><div class="stat"><div class="label">Checks passed</div><div class="val">126</div></div><div class="stat"><div class="label">Blockers</div><div class="val" style="color:var(--olive2)">0</div></div><div class="stat"><div class="label">Warnings</div><div class="val" style="color:#9b681b">2</div></div></div><div class="risk-list"><div class="risk"><i>✓</i><div><b>Matrix values and coverage</b><small>All 48 values are valid percentages and every size × access × commitment combination is covered.</small></div></div><div class="risk"><i>✓</i><div><b>Schedule and version dates</b><small>Starts 1 Oct 2026; no gap or duplicate active version was found.</small></div></div><div class="risk"><i>✓</i><div><b>Effective-rate floors</b><small>Representative bookings remain above configured facility and unit minimum rates.</small></div></div><div class="risk warn"><i>!</i><div><b>Eligibility overlap</b><small>18 Woodlands bookings may also qualify for Stay 12, Pay 10. The stacking safeguard will select one rent promotion.</small></div></div><div class="risk warn"><i>!</i><div><b>High discount approval</b><small>Values above 40% require Commercial/Finance approval before activation.</small></div></div></div><div class="rulebox"><b>What Validate Plan does:</b> it checks data completeness, ranges, rate floors, overlapping rules, dates, commitment treatment and sample bookings. It does not save, publish or change the plan. Blockers prevent scheduling; warnings can be accepted by an authorised approver.</div></section><footer><button class="btn" data-tab-jump="promo-safeguards">Review safeguards</button><button class="primary" id="confirmValidation">Confirm and validate</button></footer></div></div>'
    );
    validationModal = document.getElementById('validationModal');
  }

  function closeValidation() { if (validationModal) validationModal.classList.remove('open'); }
  async function openValidation() {
    if (validationModal) validationModal.classList.add('open');
    // Live check list for the current discount-matrix draft. The plan must be
    // saved first (validation runs server-side against the stored plan).
    var pid = promoState.discountPlanId;
    if (!pid) {
      renderValidationResults({ valid: false, blockers: 1, warnings: 0, checks: [{ status: 'blocker', message: 'Save the plan as a draft first — validation runs against the stored plan.' }], overlaps: [], samples: [] });
      return;
    }
    renderValidationResults(null); // loading state
    try {
      var result = await post('/promotion-plans/' + encodeURIComponent(pid) + '/validate', {});
      renderValidationResults(result);
    } catch (e) {
      renderValidationResults({ valid: false, blockers: 1, warnings: 0, checks: [{ status: 'blocker', message: 'Validation request failed: ' + describeError(e) }], overlaps: [], samples: [] });
    }
  }

  document.querySelectorAll('[data-open-validation]').forEach(function (b) { if (!b.dataset.wired) { b.dataset.wired = '1'; b.addEventListener('click', openValidation); } });
  document.querySelectorAll('[data-close-validation]').forEach(function (b) { if (!b.dataset.wired) { b.dataset.wired = '1'; b.addEventListener('click', closeValidation); } });

  var confirmBtn = document.getElementById('confirmValidation');
  if (confirmBtn && !confirmBtn.dataset.wired) {
    confirmBtn.dataset.wired = '1';
    confirmBtn.addEventListener('click', async function () {
      // Confirm = persist VALIDATED via the status state machine
      // (PATCH /promotion-plans/:id/status), not a client-side pill flip.
      var pid = promoState.discountPlanId;
      if (!pid) { toast('Save the plan as a draft first'); return; }
      try {
        await patch('/promotion-plans/' + encodeURIComponent(pid) + '/status', { status: 'VALIDATED' });
        promoState.validated[pid] = true;
        if (discountStatus) {
          discountStatus.textContent = 'Validated';
          discountStatus.className = 'pill green';
        }
        closeValidation();
        toast('Plan validated. It is ready to schedule.');
        bindPromotionsOverview().catch(function () {});
      } catch (e) {
        showBanner('Validate: ' + describeError(e));
      }
    });
  }

  // Wire validation modal close to escape
  document.querySelector('#validationModal [data-tab-jump="promo-safeguards"]')?.addEventListener('click', function () {
    var tab = document.querySelector('[data-tab="promo-safeguards"]');
    if (tab) tab.click();
    closeValidation();
  });

  // --- 6. Duplicate plan (Phase 0 fix: tracks the created plan id in
  // promoState instead of the nonexistent #discountPlanId, and surfaces API
  // errors instead of swallowing them) ---
  async function duplicateDiscountPlan() {
    var srcId = promoState.discountPlanId;
    if (!srcId) {
      // No working draft: duplicate the most recently updated plan, if any.
      try {
        var plans = await get('/promotion-plans');
        if (plans && plans.length) srcId = plans[0].id;
      } catch (e) { /* fall through to the error below */ }
    }
    if (!srcId) { showBanner('Nothing to duplicate — save a discount plan first.'); return; }
    try {
      const result = await post('/promotion-plans/' + encodeURIComponent(srcId) + '/duplicate', {});
      if (result && result.id) {
        promoState.discountPlanId = result.id;
        promoState.validated[result.id] = false;
      }
      if (discountPlanName) {
        var base = discountPlanName.value.replace(/^Copy of /, '');
        discountPlanName.value = 'Copy of ' + base;
      }
      if (discountStartDate) discountStartDate.value = new Date().toISOString().slice(0, 10);
      promoState.validated[promoState.discountPlanId] = false;
    } catch (e) { showBanner('Duplicate: ' + describeError(e)); return; }
    if (discountStatus) {
      discountStatus.textContent = 'Draft';
      discountStatus.className = 'pill amber';
    }
    var tab = document.querySelector('[data-tab="promo-discount-matrix"]');
    if (tab) tab.click();
    toast('Duplicated as a new editable draft');
  }
  document.querySelectorAll('[data-duplicate-plan]').forEach(function (b) { if (!b.dataset.wired) { b.dataset.wired = '1'; b.addEventListener('click', duplicateDiscountPlan); } });

  // --- 7. Save draft / Schedule plan ---
  // NOTE: the working draft id lives in promoState.discountPlanId (module
  // scope) so it survives tab switches — bootPromotions() re-runs on every
  // visit and a closure-local id would be wiped each time.
  var promoLibraryBody = document.querySelector('#promo-library > .card > .table-wrap > table > tbody');

  async function saveDiscountPlan(status) {
    status = status || 'Draft';
    var name = discountPlanName ? (discountPlanName.value || 'Untitled discount plan') : 'Untitled discount plan';
    var startDate = discountStartDate ? discountStartDate.value : new Date().toISOString().slice(0, 10);

    // Collect matrix cells from the DOM
    var matrixCells = [];
    var matrixRows = document.querySelectorAll('#promo-discount-matrix .discount-matrix tbody tr');
    var sizeCategories = ['LOCKER', 'SMALL', 'MEDIUM', 'LARGE', 'XL', 'XXL'];
    // Discount tiers: 1 / 3 / 6 / 12 months, Standard only = 4 inputs/row.
    var commitmentLabels = [1, 3, 6, 12];
    if (matrixRows.length) {
      matrixRows.forEach(function (row, ri) {
        if (ri >= sizeCategories.length) return;
        var inputs = row.querySelectorAll('input');
        inputs.forEach(function (input, ci) {
          if (ci >= 4) return;
          var pct = parseFloat(input.value) || 0;
          var accessType = 'Standard';
          var commitMonths = commitmentLabels[ci % 4];
          matrixCells.push({
            sizeCategory: sizeCategories[ri],
            accessType: accessType,
            commitmentMonths: commitMonths,
            discountPct: pct,
          });
        });
      });
    }

    var payload = {
      kind: 'DISCOUNT_MATRIX',
      name: name,
      effectiveFrom: startDate + 'T00:00:00.000Z',
      facilityScope: ['ALL'],
      sizeScope: ['ALL'],
      matrixCells: matrixCells.length ? matrixCells : undefined,
    };

    try {
      if (promoState.discountPlanId) {
        await put('/promotion-plans/' + encodeURIComponent(promoState.discountPlanId), payload);
      } else {
        var result = await post('/promotion-plans', payload);
        if (result && result.id) promoState.discountPlanId = result.id;
      }
      toast('Plan saved: ' + name);
    } catch (e) {
      toast('Save failed: ' + describeError(e));
    }

    if (discountStatus) {
      discountStatus.textContent = status;
      discountStatus.className = 'pill ' + (status === 'Scheduled' ? 'amber' : 'grey');
    }
    // Refresh the library
    bindPromotionsOverview();
    return promoState.discountPlanId;
  }

  document.querySelectorAll('[data-save-discount-plan]').forEach(function (b) {
    if (b.dataset.wired) return;
    b.dataset.wired = '1';
    b.addEventListener('click', function () {
      saveDiscountPlan('Draft');
      var tab = document.querySelector('[data-tab="promo-library"]');
      if (tab) tab.click();
    });
  });
  document.querySelectorAll('[data-schedule-plan]').forEach(function (b) {
    if (b.dataset.wired) return;
    b.dataset.wired = '1';
    b.addEventListener('click', async function () {
      // Schedule = save draft, then VALIDATED (if needed) → SCHEDULED through
      // the status state machine. Blockers reject with a surfaced error.
      await saveDiscountPlan('Draft');
      var pid = promoState.discountPlanId;
      if (!pid) return;
      try {
        if (!promoState.validated[pid]) {
          await patch('/promotion-plans/' + encodeURIComponent(pid) + '/status', { status: 'VALIDATED' });
          promoState.validated[pid] = true;
        }
        await patch('/promotion-plans/' + encodeURIComponent(pid) + '/status', { status: 'SCHEDULED' });
        if (discountStatus) {
          discountStatus.textContent = 'Scheduled';
          discountStatus.className = 'pill amber';
        }
        toast('Plan scheduled');
        bindPromotionsOverview().catch(function () {});
      } catch (e) {
        showBanner('Schedule: ' + describeError(e));
        openValidation();
        return;
      }
      var tab = document.querySelector('[data-tab="promo-library"]');
      if (tab) tab.click();
    });
  });
  document.querySelectorAll('[data-publish-plan]').forEach(function (b) {
    if (b.dataset.wired) return;
    b.dataset.wired = '1';
    b.addEventListener('click', async function () {
      // Publish = save, then walk DRAFT → VALIDATED → SCHEDULED → ACTIVE
      // through the EXISTING status state machine (PATCH
      // /promotion-plans/:id/status; server re-validates on the VALIDATED
      // edge). Blockers reject with a surfaced error + validation modal.
      // In-place only: an opened plan keeps its id (PUT /:id), so POST fires
      // solely for a genuinely new plan. Never duplicate/restore here.
      // Double-click guarded; a second Publish on ACTIVE is a harmless no-op
      // toast checked BEFORE saving so the live plan is never touched.
      if (b.disabled) return;
      b.disabled = true;
      try {
        var pid = promoState.discountPlanId;
        if (pid) {
          var pre = null;
          try { pre = await get('/promotion-plans/' + encodeURIComponent(pid)); } catch (e) { pre = null; }
          if (pre && pre.status === 'ACTIVE') {
            if (discountStatus) {
              discountStatus.textContent = 'Active';
              discountStatus.className = 'pill green';
            }
            toast('Plan is already active');
            return;
          }
        }
        await saveDiscountPlan('Draft');
        pid = promoState.discountPlanId;
        if (!pid) return;
        var current = null;
        try { current = await get('/promotion-plans/' + encodeURIComponent(pid)); } catch (e) { current = null; }
        var status = current && current.status;
        if (status === 'ACTIVE') {
          if (discountStatus) {
            discountStatus.textContent = 'Active';
            discountStatus.className = 'pill green';
          }
          toast('Plan is already active');
          return;
        }
        if (!status || status === 'DRAFT') {
          await patch('/promotion-plans/' + encodeURIComponent(pid) + '/status', { status: 'VALIDATED' });
          promoState.validated[pid] = true;
          status = 'VALIDATED';
        }
        if (status === 'VALIDATED') {
          await patch('/promotion-plans/' + encodeURIComponent(pid) + '/status', { status: 'SCHEDULED' });
          status = 'SCHEDULED';
        }
        await patch('/promotion-plans/' + encodeURIComponent(pid) + '/status', { status: 'ACTIVE' });
        if (discountStatus) {
          discountStatus.textContent = 'Active';
          discountStatus.className = 'pill green';
        }
        toast('Plan is now active');
        bindPromotionsOverview().catch(function () {});
      } catch (e) {
        showBanner('Publish: ' + describeError(e));
        openValidation();
      } finally {
        b.disabled = false;
      }
    });
  });

  // --- 8. Choice grid tabbable (generic .choice-grid handler) ---
  document.querySelectorAll('.choice-grid').forEach(function (group) {
    group.querySelectorAll('.choice').forEach(function (choice) {
      choice.addEventListener('click', function () {
        group.querySelectorAll('.choice').forEach(function (c) { c.classList.remove('active'); });
        this.classList.add('active');
      });
    });
  });

  // --- 9. History commitment column fix ---
  if (promoLibraryBody) {
    var firstCommitment = promoLibraryBody.querySelector('tr td:nth-child(4)');
    if (firstCommitment) firstCommitment.textContent = '1 / 3 / 6 / 12 months';
  }

  // --- 10. Phase 5: builder save bars + round-trip loads (idempotent) ---
  // Library Open populates the exact plan into its builder (GET only —
  // sets the working draft id so Save/Publish stay in place, never a copy).
  installPromoOpenHandler();
  ensurePromoSaveBars();
  loadFreeMonthsPlan().catch(function () {});
  loadCodePlan().catch(function () {});
  bindPromoPerformance().catch(function () {});
  bindPromoDashboardCharts().catch(function () {});
}

async function bindBilling() {
  try {
    ensureBillingDateFilters();
    const [invoices, summary] = await Promise.all([
      get(withDateQuery('/invoices', state.invoiceDate)).catch(() => []),
      get('/summary').catch(() => null),
    ]);
    const stats = $('#billingStats');
    if (stats && summary?.kpis) {
      const k = summary.kpis;
      const totalDue = (invoices || []).reduce((s, i) => s + (i.amount || 0), 0);
      stats.innerHTML = '<div class="stat"><div class="label">MRR</div><div class="val">$' + (k.mrr || 0).toLocaleString() + '</div></div>' +
        '<div class="stat"><div class="label">Invoices</div><div class="val">' + (invoices || []).length + '</div></div>' +
        '<div class="stat"><div class="label">Total due</div><div class="val">$' + totalDue.toLocaleString() + '</div></div>' +
        '<div class="stat"><div class="label">Overdue units</div><div class="val">' + k.overdueUnits + '</div></div>' +
        '<div class="stat"><div class="label">Collection rate</div><div class="val">—</div></div>';
    }
    // Aging
    const aging = $('#agingBreakdown');
    if (aging && invoices) {
      const overdue = (invoices || []).filter(i => i.status === 'OVERDUE').length;
      const due = (invoices || []).filter(i => i.status === 'DUE').length;
      const paid = (invoices || []).filter(i => i.status === 'PAID').length;
      aging.innerHTML = '<div class="agebox"><small>Paid</small><b>' + paid + '</b></div><div class="agebox"><small>Due</small><b>' + due + '</b></div><div class="agebox danger"><small>Overdue</small><b>' + overdue + '</b></div><div class="agebox"><small>Collection rate</small><b>' + (paid > 0 ? Math.round(paid / (paid + due + overdue) * 100) + '%' : '—') + '</b></div><div class="agebox"><small>Total</small><b>' + invoices.length + '</b></div>';
    }
    // Invoice rows
    const invRows = $('#invoiceRows');
    if (invRows && invoices) {
      invRows.innerHTML = invoices.length ? invoices.slice(0, 20).map((i) =>
        '<tr><td>' + escapeHtml(i.no || '—') + '</td><td>' + escapeHtml(i.tenant || '—') + '</td><td>' + escapeHtml(i.unit || '—') + '</td><td><b>$' + (i.amount || 0).toLocaleString() + '</b></td><td>' + fmtDay(i.dueDate) + '</td><td><span class="pill ' + (i.status === 'PAID' ? 'green' : i.status === 'OVERDUE' ? 'red' : 'amber') + '">' + i.status + '</span></td></tr>'
      ).join('') : '<tr><td colspan="6"><div class="section-empty">' + escapeHtml(rangeEmptyText('invoices', state.invoiceDate, 'No invoices.')) + '</div></td></tr>';
    }
    // Arrears
    const arrearRows = $('#arrearRows');
    if (arrearRows && invoices) {
      const overdue = invoices.filter(i => i.status === 'OVERDUE');
      arrearRows.innerHTML = overdue.length ? overdue.map((i) =>
        '<tr><td>' + escapeHtml(i.no || '—') + '</td><td>' + escapeHtml(i.tenant || '—') + '</td><td><b>$' + (i.amount || 0).toLocaleString() + '</b></td><td class="late">' + Math.round((Date.now() - new Date(i.dueDate).getTime()) / (1000 * 60 * 60 * 24)) + ' days</td></tr>'
      ).join('') : '<tr><td colspan="4"><div class="section-empty">' + escapeHtml(rangeEmptyText('overdue invoices', state.invoiceDate, 'No overdue invoices.')) + '</div></td></tr>';
    }
  } catch (e) { /*noop*/ }
}

// Invoices + arrears share one Invoice.dueDate range (both tables read the same
// GET /invoices rows). A control sits on each card-head; changing either syncs
// the other silently and refetches.
const billingDateHandles = [];
function ensureBillingDateFilters() {
  const heads = [document.querySelector('#bill-invoices .card-head'), document.querySelector('#bill-arrears .card-head')];
  heads.forEach((head) => {
    if (!head || head.dataset.dateFilterMounted) return;
    head.dataset.dateFilterMounted = '1';
    const handle = createDateFilter({
      onChange: (r) => {
        state.invoiceDate = r;
        billingDateHandles.forEach((h) => { if (h !== handle) h.set(r, true); });
        bindBilling().catch(() => {});
      },
    });
    billingDateHandles.push(handle);
    // .card-head leads with the <h3> title — the date trigger goes right after
    // it so it is the first (and currently only) control.
    const billTitle = head.firstElementChild;
    if (billTitle && billTitle.nextSibling) head.insertBefore(handle.el, billTitle.nextSibling);
    else head.appendChild(handle.el);
  });
}

// ====================== ACTIVITY FEED ======================
const ACT_META = {
  unit_created: { icon: '🆕', tone: 'olive' }, unit_updated: { icon: '✏️', tone: 'terra' },
  rate_change: { icon: '💱', tone: 'amber' }, move_in: { icon: '🔑', tone: 'teal' },
  booking: { icon: '📅', tone: 'olive' },
};

function bindActivity(items) {
  const list = $('#activityFeed');
  if (!list) return;
  if (!items || !items.length) { list.innerHTML = '<div class="alert-desc" style="padding:10px 0;">No unit activity yet.</div>'; return; }
  list.innerHTML = (items || []).map((it) => {
    const meta = ACT_META[it.type] || { icon: '•', tone: '' };
    const desc = it.actor ? 'by ' + escapeHtml(it.actor) : it.unit && it.unit.branch ? '· ' + escapeHtml(it.unit.branch) : '';
    return '<div class="alert-item"><div class="alert-icon ' + meta.tone + '">' + meta.icon + '</div><div class="alert-body"><div class="alert-title">' + escapeHtml(it.message) + '</div><div class="alert-desc">' + desc + '</div></div><div class="alert-time">' + timeAgo(it.at) + '</div></div>';
  }).join('');
}

// ====================== REFERENCE DATA ======================
async function loadRefs() {
  const [branches, floors, sizes] = await Promise.all([get('/branches'), get('/floors'), get('/sizes')]);
  state.branches = branches;
  state.floors = floors;
  state.sizes = sizes;
  renderWorkspaceSelect();
}

function renderWorkspaceSelect() {
  const sel = $('#sbBranchSelect');
  if (!sel) return;
  const options = [{ code: ALL_FACILITIES, name: 'All Facilities' }, ...state.branches];
  sel.innerHTML = options.map((b) => '<option value="' + b.code + '">' + b.name + '</option>').join('');
}

// ====================== WIRING ======================
function wireEvents() {
  // Shared header↔rows select-all for every table with a thead checkbox
  // (currently the leads table; re-renders keep working via delegation).
  initSelectAll(document);
  // V8 core page nav
  document.querySelectorAll('[data-core-page]').forEach((n) => {
    n.addEventListener('click', function (e) {
      e.preventDefault();
      const core = this.dataset.corePage;
      if (this.classList.contains('active') && this.classList.contains('expanded')) {
        this.classList.remove('expanded');
        return;
      }
      openCoreDefault(core);
    });
  });
  document.querySelectorAll('.nav-subitem').forEach((b) => {
    b.addEventListener('click', function () {
      const sp = this.dataset.sidePage;
      if (this.dataset.sidePanel) openPanel(sp, this.dataset.sidePanel);
      else { openPage(sp); activateSide(sp); }
    });
  });
  // Page jumps (buttons like "View all")
  installPromoTabJump();
  document.querySelectorAll('[data-page-jump]').forEach((b) => {
    b.addEventListener('click', function () {
      const page = this.dataset.pageJump;
      const core = coreMap[page] || page;
      document.querySelectorAll('[data-core-page]').forEach((n) =>
        n.classList.toggle('active', n.dataset.corePage === core));
      expandCore(core);
      activateSide(page);
      openPage(page);
    });
  });
  // Facility tabs (data-tabs="facility")
  document.querySelectorAll('[data-tabs="facility"] [data-tab]').forEach((b) => {
    b.addEventListener('click', function () {
      document.querySelectorAll('[data-tabs="facility"] [data-tab]').forEach((x) => x.classList.remove('active'));
      this.classList.add('active');
      // Toggle only the TOP-LEVEL facility panels (direct children of the
      // facilities section) — the access sub-panels live inside
      // #facility-access and are owned by the access tab handler.
      document.querySelectorAll('#facilities > .module-panel').forEach((p) => {
        p.classList.toggle('active', p.id === this.dataset.tab);
      });
      const panel = this.dataset.tab;
      activateSide('facilities', panel);
      // Lazy load
      if (panel === 'facility-map') { ensureMapSizeFilter().catch(() => {}); syncFacilityDashboard(); }
      else if (panel === 'facility-units') refreshUnitsView();
      else if (panel === 'facility-floors') bindFloorsView().catch((err) => showBanner('Floors: ' + describeError(err)));
      else if (panel === 'facility-floorplans') { fpOpen(); refreshMetricsView().catch((err) => showBanner('Metrics: ' + describeError(err))); }
      else if (panel === 'facility-maintenance') bindMaintenance();
      else if (panel === 'facility-assets') bindAssets();
      else if (panel === 'facility-incidents') bindIncidents();
      else if (panel === 'facility-access') {
        // Restore the access inner tab (the toggle above only touches
        // top-level panels) and load all five sub-panels.
        const inner = document.querySelector('[data-tabs="access"] [data-tab].active') ||
          document.querySelector('[data-tabs="access"] [data-tab]');
        if (inner) inner.click();
        bindAccess();
      }
      else if (panel === 'facility-inspections') bindInspections();
      else if (panel === 'facility-extras') bindExtrasSection().catch((err) => showBanner('Extras: ' + describeError(err)));
    });
  });
  // Customer tabs (data-tabs="customer")
  document.querySelectorAll('[data-tabs="customer"] [data-tab]').forEach((b) => {
    b.addEventListener('click', function () {
      document.querySelectorAll('[data-tabs="customer"] [data-tab]').forEach((x) => x.classList.remove('active'));
      this.classList.add('active');
      document.querySelectorAll('[data-tabs="customer"] ~ .module-panel, #customers .module-panel').forEach((p) => {
        p.classList.toggle('active', p.id === this.dataset.tab);
      });
      const panel = this.dataset.tab;
      activateSide('customers', panel);
      // Lazy load
      if (panel === 'customer-tenants') refreshTenantsView();
      else if (panel === 'customer-bookings') refreshBookingsView();
      else if (panel === 'customer-moveins') refreshMoveinsView();
      else if (panel === 'customer-quotes') bindQuotes().catch((err) => showBanner('Quotes: ' + describeError(err)));
      else if (panel === 'customer-moveouts') bindMoveouts().catch((err) => showBanner('Move-outs: ' + describeError(err)));
    });
  });
  // Billing tabs
  document.querySelectorAll('[data-tabs="billing"] [data-tab]').forEach((b) => {
    b.addEventListener('click', function () {
      document.querySelectorAll('[data-tabs="billing"] [data-tab]').forEach((x) => x.classList.remove('active'));
      this.classList.add('active');
      document.querySelectorAll('#billing .module-panel').forEach((p) => {
        p.classList.toggle('active', p.id === this.dataset.tab);
      });
      activateSide('billing', this.dataset.tab);
      if (this.dataset.tab === 'bill-overview') bindBilling();
    });
  });
  // Promo tabs
  document.querySelectorAll('[data-tabs="promo"] [data-tab]').forEach((b) => {
    b.addEventListener('click', function () {
      document.querySelectorAll('[data-tabs="promo"] [data-tab]').forEach((x) => x.classList.remove('active'));
      this.classList.add('active');
      document.querySelectorAll('#promotions .module-panel').forEach((p) => {
        p.classList.toggle('active', p.id === this.dataset.tab);
      });
      const panel = this.dataset.tab;
      activateSide('promotions', panel);
      if (panel === 'promo-overview') { bindPromotionsOverview(); bindPromoDashboardCharts().catch(function () {}); }
      else if (panel === 'promo-safeguards') bindSafeguards().catch(function () {});
      else if (panel === 'promo-history') bindPromoHistory().catch(function () {});
      else if (panel === 'promo-performance') bindPromoPerformance().catch(function () {});
      else if (panel === 'promo-free-months') loadFreeMonthsPlan().catch(function () {});
      else if (panel === 'promo-code-builder') loadCodePlan().catch(function () {});
    });
  });
  // Drawer (mobile)
  const toggle = $('#navToggle');
  const backdrop = $('#sbBackdrop');
  // Facility filter change
  $('#sbBranchSelect')?.addEventListener('change', function () {
    state.branchCode = this.value;
    // New facility → default to its first ACTIVE level (inactive levels are
    // hidden from every selector, so a stale level must never carry over).
    ensureActiveLevel(state.branchCode);
    // Re-render current view
    const tab = document.querySelector('[data-tabs="facility"] button.active');
    if (tab) tab.click();
    openPage('command');
  });
  if (toggle && backdrop) {
    toggle.addEventListener('click', function () {
      const open = !document.body.classList.contains('sb-open');
      document.body.classList.toggle('sb-open', open);
      this.setAttribute('aria-expanded', String(open));
      document.getElementById('sidebar')?.classList.toggle('open', open);
    });
    backdrop.addEventListener('click', function () {
      document.body.classList.remove('sb-open');
      document.getElementById('sidebar')?.classList.remove('open');
    });
    document.getElementById('sidebar')?.addEventListener('click', function (e) {
      if (e.target.closest('[data-core-page]') || e.target.closest('.nav-subitem')) {
        document.body.classList.remove('sb-open');
        document.getElementById('sidebar')?.classList.remove('open');
      }
    });
  }

  // ---- Existing admin CRUD wiring (unchanged) ----
  $$('.nav-item[data-view]').forEach((el) =>
    el.addEventListener('click', function () {
      const view = this.dataset.view;
      // Map old views to facility subtabs
      if (['units', 'tenants', 'bookings', 'moveins', 'floorplans'].includes(view)) {
        openPanel('facilities', 'facility-' + view);
      } else {
        openPage('command');
      }
    })
  );
  $('#bookingSearch')?.addEventListener('input', bindBookingsTable);
  $('#bookingStatusFilter')?.addEventListener('change', bindBookingsTable);
  // Units: floor tabs, filters, pager
  $('#floorTabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.floor-tab[data-level]');
    if (!btn) return;
    const level = Number(btn.dataset.level);
    if (level === state.level) return;
    state.level = level;
    state.page = 1;
    fetchUnitsPage().catch(() => {});
    fetchUnitMap().catch(() => {});
  });
  $('#statusFilter')?.addEventListener('change', (e) => { state.statusFilter = e.target.value; state.page = 1; fetchUnitsPage().catch(() => {}); });
  $('#unitBranchFilter')?.addEventListener('change', (e) => { state.unitBranchFilter = e.target.value; state.unitLevelFilter = ''; populateUnitLevelFilter(); state.page = 1; fetchUnitsPage().catch(() => {}); });
  $('#unitLevelFilter')?.addEventListener('change', (e) => { state.unitLevelFilter = e.target.value; state.page = 1; fetchUnitsPage().catch(() => {}); });
  $('#unitAcFilter')?.addEventListener('change', (e) => { state.unitAcFilter = e.target.value; state.page = 1; fetchUnitsPage().catch(() => {}); });
  $('#unitImportBtn')?.addEventListener('click', () => $('#unitImportFile')?.click());
  $('#unitImportFile')?.addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) importUnitsFile(f).catch(() => {}); });
  $('#pagePrev')?.addEventListener('click', () => { if (state.page > 1) { state.page--; fetchUnitsPage().catch(() => {}); } });
  $('#pageNext')?.addEventListener('click', () => { if (state.page < state.totalPages) { state.page++; fetchUnitsPage().catch(() => {}); } });
  // Units CRUD
  $('#addUnitBtn')?.addEventListener('click', openCreateForm);
  $('#unitModalClose')?.addEventListener('click', closeUnitModal);
  $('#unitFormCancel')?.addEventListener('click', closeUnitModal);
  $('#unitForm')?.addEventListener('submit', submitUnitForm);
  $('#rateModalClose')?.addEventListener('click', closeRateModal);
  $('#rateFormCancel')?.addEventListener('click', closeRateModal);
  $('#rateForm')?.addEventListener('submit', submitRateForm);
  $('#editUnitBtn')?.addEventListener('click', () => { const code = getSelectedUnitCode(); if (code) openEditForm(code); else showBanner('Select a unit first.'); });
  $('#adjustRateBtn')?.addEventListener('click', () => { const code = getSelectedUnitCode(); if (code) openRateForm(code); else showBanner('Select a unit first.'); });
  $('#deleteUnitBtn')?.addEventListener('click', () => { const code = getSelectedUnitCode(); if (code) deleteUnit(code); });
  $('#f-branch')?.addEventListener('change', (e) => populateFloorSelect(e.target.value));
  $('#f-size')?.addEventListener('change', onUnitSizeChange);
  $('#unitsTable')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const { act, code } = btn.dataset;
    if (act === 'view') showUnitDetail(code);
    else if (act === 'edit') openEditForm(code);
    else if (act === 'rate') openRateForm(code);
    else if (act === 'delete') deleteUnit(code);
  });
  // Tenants CRUD
  $('#addTenantBtn')?.addEventListener('click', openCreateTenant);
  $('#tenantModalClose')?.addEventListener('click', closeTenantModal);
  $('#tenantFormCancel')?.addEventListener('click', closeTenantModal);
  $('#tenantForm')?.addEventListener('submit', submitTenantForm);
  $('#tenantSearch')?.addEventListener('input', (e) => { state.tenantQuery = e.target.value; state.tenantPage = 1; bindTenantsView(); });
  $('#tenantStatusFilter')?.addEventListener('change', (e) => { state.tenantStatusFilter = e.target.value; state.tenantPage = 1; bindTenantsView(); });
  $('#tenantsPagePrev')?.addEventListener('click', () => { if (state.tenantPage > 1) { state.tenantPage--; bindTenantsView(); } });
  $('#tenantsPageNext')?.addEventListener('click', () => { if (state.tenantPage < state.tenantTotalPages) { state.tenantPage++; bindTenantsView(); } });
  $('#tenantsViewTable')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const { act, tid } = btn.dataset;
    if (act === 'view' || act === 'edit') openEditTenant(tid);
    else if (act === 'deactivate') deactivateTenant(tid);
  });
  // Floor plan events
  fpInitEvents();
  // Area-metrics panel (read-only live reads under the floor-plan editor)
  wireMetricsPanel();
  // Facility operations (maintenance / assets / incidents / access / inspections)
  wireFacilitiesOps();
  // P1: portfolio cards, quotes/move-outs queues, settings extensions
  wirePortfolio();
  wireOpsQueues();
  wireSettingsExt();
  // Booking extras catalog (protection plans + addons).
  wireExtras();
  // P1 item 3: unit-map read-path filters (Size + Near lift).
  $('#mapSizeFilter')?.addEventListener('change', (e) => { state.mapSize = e.target.value; fetchUnitMap().catch(() => {}); });
  $('#mapNearLiftFilter')?.addEventListener('change', (e) => { state.mapNearLift = !!e.target.checked; fetchUnitMap().catch(() => {}); });
  // Close modals on overlay click
  $$('.modal-overlay').forEach((ov) => {
    ov.addEventListener('click', function (e) {
      if (e.target !== this) return;
      if (this.id === 'unitModal') closeUnitModal();
      else if (this.id === 'rateModal') closeRateModal();
      else if (this.id === 'tenantModal') closeTenantModal();
      else if (this.id === 'leadModal') closeLeadModal();
      else if (this.id === 'apptModal') closeApptModal();
      else if (this.id === 'fpViewModal') fpViewClose();
    });
  });
  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const fpOv = $('#fpViewModal');
    if (fpOv && !fpOv.hidden) fpViewClose();
    else if (!$('#unitModal').hidden) closeUnitModal();
    else if (!$('#rateModal').hidden) closeRateModal();
    else if (!$('#tenantModal').hidden) closeTenantModal();
    else if (!$('#leadModal').hidden) closeLeadModal();
    else if (!$('#apptModal').hidden) closeApptModal();
  });
  // Unit view from floor plan
  $('#unitShowFloorPlan')?.addEventListener('click', () => {
    const code = getSelectedUnitCode();
    if (!code) { showBanner('Select a unit first.'); return; }
    // find the floor for the selected unit
    const unit = state.units.find((u) => u.code === code);
    if (unit && unit.floorId) {
      state.fp.floorId = unit.floorId;
      openPanel('facilities', 'facility-floorplans');
    }
  });
  // Read-only floor plan preview → open editor
  $('#fpViewEdit')?.addEventListener('click', () => {
    state.fp.branchCode = isAllFacilities() ? state.branches[0]?.code || state.fp.branchCode : state.branchCode;
    state.fp.floorId = getFpViewFloorId();
    fpViewClose();
    openPanel('facilities', 'facility-floorplans');
  });
  // Unit map floor tabs
  $('#unitGrid')?.addEventListener('click', (e) => {
    const cell = e.target.closest('.u-cell');
    if (cell) {
      const code = cell.querySelector('.u-id')?.textContent;
      if (code && cell.getAttribute('onclick')) {
        // let the existing onclick handle it via selectUnit()
      }
    }
  });
  // Leads: filters + pager
  $('#leadStatusFilter')?.addEventListener('change', (e) => { state.leadStatusFilter = e.target.value; state.leadPage = 1; bindLeadTable().catch(() => {}); });
  $('#leadSourceFilter')?.addEventListener('change', (e) => { state.leadSourceFilter = e.target.value; state.leadPage = 1; bindLeadTable().catch(() => {}); });
  $('#leadsPagePrev')?.addEventListener('click', () => { if (state.leadPage > 1) { state.leadPage--; bindLeadTable().catch(() => {}); } });
  $('#leadsPageNext')?.addEventListener('click', () => { state.leadPage++; bindLeadTable().catch(() => {}); });
  $('#leadRows')?.addEventListener('click', (e) => {
    // Checkbox toggles must not open the drawer — only row intent does.
    if (e.target.closest('input[type="checkbox"]')) return;
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      const { act } = btn.dataset;
      const id = btn.dataset.leadId;
      if (act === 'edit') openEditLead(id);
      else if (act === 'delete') deleteLeadRow(id);
      return;
    }
    // Row-click (any cell) → right detail drawer (Lead Database only).
    const tr = e.target.closest('tr[data-lead-id]');
    if (tr) openLeadDrawer(tr.dataset.leadId, tr);
  });
  // Keyboard parity: Enter/Space on a focused row opens the same drawer.
  $('#leadRows')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest && e.target.closest('tr[data-lead-id]');
    if (!tr || e.target.closest('button[data-act],input[type="checkbox"]')) return;
    e.preventDefault();
    openLeadDrawer(tr.dataset.leadId, tr);
  });
  // Leads: import / export
  $('#leadExportBtn')?.addEventListener('click', exportLeadsCsv);
  $('#leadImportBtn')?.addEventListener('click', () => $('#leadImportFile')?.click());
  $('#leadImportFile')?.addEventListener('change', function () {
    const f = this.files && this.files[0];
    this.value = '';
    if (f) importLeadsCsv(f).catch((e) => showBanner('Import: ' + describeError(e)));
  });
  // Lead modal (topbar #addLeadBtn removed — only pipeline + leads-page remain;
  // bind every match so duplicate IDs / missing nodes never null-throw on boot)
  $$('#addLeadBtn, #addLeadBtn2').forEach((el) => el?.addEventListener('click', openCreateLead));
  $('#leadModalClose')?.addEventListener('click', closeLeadModal);
  $('#leadFormCancel')?.addEventListener('click', closeLeadModal);
  $('#leadForm')?.addEventListener('submit', submitLeadForm);
  // Lead detail drawer (row-click → right sidebar): shell wiring + DI so the
  // view can refresh lists and delegate to the entry-owned modals.
  wireLeadDrawer();
  setLeadDrawerActions({ onEditLead: openEditLead, onSchedule: (lead) => openCreateAppointment(lead && lead.id).catch((e) => showBanner('Schedule: ' + describeError(e))) });
  leadDrawerSetRefreshAll(async () => {
    await refreshAll().catch(() => {});
    await refreshLeadsViews().catch(() => {});
    await bindCalendar().catch(() => {});
  });
  // Pipeline filter
  $('#pipelineFilter')?.addEventListener('change', (e) => { state.pipelineFilter = e.target.value; bindPipeline().catch(() => {}); });
  // Inbox
  $('#inboxAssignBtn')?.addEventListener('click', () => assignActiveThread().catch((e) => showBanner('Assign: ' + describeError(e))));
  $('#inboxNewMsgBtn')?.addEventListener('click', focusComposerForNewMessage);
  $('#composerTemplatesBtn')?.addEventListener('click', insertInboxTemplate);
  $('#composerSendBtn')?.addEventListener('click', () => sendComposer().catch((e) => showBanner('Send: ' + describeError(e))));
  // Appointments
  $('#scheduleBtn')?.addEventListener('click', () => openCreateAppointment().catch((e) => showBanner('Schedule: ' + describeError(e))));
  $('#apptModalClose')?.addEventListener('click', closeApptModal);
  $('#apptFormCancel')?.addEventListener('click', closeApptModal);
  $('#apptForm')?.addEventListener('submit', submitApptForm);
  $('#todayAppts')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-appt-act]');
    if (!btn) return;
    const id = btn.dataset.apptId;
    if (btn.dataset.apptAct === 'edit') openEditAppointment(id);
    else if (btn.dataset.apptAct === 'cancel') cancelAppointment(id);
  });
}

// ====================== REFRESH ALL ======================
async function refreshAll() {
  const [summary, activity, leads, actions] = await Promise.all([
    get('/summary').catch(() => null),
    get('/units/activity?limit=5').catch(() => []),
    get('/leads').catch(() => []),
    get('/action-items').catch(() => []),
  ]);
  bindKpis(summary);
  bindCharts(summary);
  bindActivity(activity);
  bindLeads(leads);
  bindActions(actions);
  const badge = $('#leadsBadge');
  if (badge && leads) {
    const awaiting = (leads.find(c => c.stage === 'NEW_ENQUIRY')?.count || 0);
    badge.textContent = awaiting;
  }
}

function bindLeads(data) {
  const board = $('#kanbanBoard');
  if (!board) return;
  const clone = board.cloneNode(false);
  const tagMap = { PERSONAL: 'per', BUSINESS: 'biz' };
  (data || []).forEach((col) => {
    const inner = document.createElement('div');
    inner.className = 'k-col';
    inner.innerHTML = '<div class="k-col-hdr"><div class="k-col-title">' + (stageKanbanLabel[col.stage] ?? col.stage) + '</div><div class="k-count">' + col.count + '</div></div>' +
      (col.leads || []).map((l) =>
        '<div class="k-card"><div class="k-name">' + escapeHtml(l.name) + '</div><div class="k-meta"><span class="k-tag ' + (tagMap[l.type] || '') + '">' + (l.type === 'PERSONAL' ? 'Personal' : 'Business') + '</span>' + (l.size || '') + (l.branchCode ? ' · ' + escapeHtml(l.branchCode) : '') + '</div></div>'
      ).join('');
    clone.appendChild(inner);
  });
  board.replaceWith(clone);
  // Also update sidebar badge
  const bdg = document.querySelector('.nav-badge.red');
  if (bdg) bdg.textContent = data ? data.reduce((s, c) => s + c.count, 0) : 0;
}

function bindActions(data) {
  const list = $('#alertList');
  if (!list) return;
  list.innerHTML = (data || []).map((it) =>
    '<div class="alert-item"><div class="alert-icon ' + it.tone + '">' + it.icon + '</div><div class="alert-body"><div class="alert-title">' + escapeHtml(it.title) + '</div><div class="alert-desc">' + escapeHtml(it.desc) + '</div></div><div class="alert-time">' + it.time + '</div><button class="alert-act">' + escapeHtml(it.action) + '</button></div>'
  ).join('');
  const badge = document.querySelector('.nav-badge.red');
  if (badge) badge.textContent = data ? data.length : 0;
}

// ====================== REFRESH VIEW HOOKS ======================
async function refreshUnitsView() {
  await Promise.all([fetchUnitsPage().catch(() => {}), fetchUnitMap().catch(() => {})]);
}

// ====================== BOOT ======================
async function boot() {
  try {
    tenantsSetRefreshAll(refreshAll);
    unitsSetRefreshAll(refreshAll);
    unitsSetRefsLoader(loadRefs);
    fpSetRefsLoader(loadRefs);
    floorsSetRefreshAll(refreshAll);
    floorsSetRefsLoader(loadRefs);
    wireFloorsView();
    await login();
    initCharts();
    await Promise.all([loadRefs(), refreshAll()]);
    // Navigate to initial page from hash
    const hash = location.hash ? location.hash.slice(1) : 'command';
    if (['command', 'portfolio', 'leads', 'pipeline', 'inbox', 'calendar', 'analytics', 'automation', 'customers', 'facilities', 'promotions', 'billing', 'settings'].includes(hash)) {
      if (hash === 'command') openPage('command');
      else if (hash === 'portfolio') openPage('portfolio');
      else if (hash === 'analytics') openPage('analytics');
      else if (['leads', 'pipeline', 'inbox', 'calendar', 'automation'].includes(hash)) openCoreDefault('leads');
      else if (hash === 'customers') openCoreDefault('customers');
      else if (hash === 'facilities') openCoreDefault('facilities');
      else if (hash === 'promotions') openCoreDefault('promotions');
      else if (hash === 'billing') openCoreDefault('billing');
      else if (hash === 'settings') openCoreDefault('settings');
    } else {
      openPage('command');
    }
  } catch (e) {
    console.error('[storelah admin] boot failed', e);
    showBanner('Data layer error: ' + (e && e.message ? e.message : e));
  }
}

wireEvents();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

window.StoreLahAdmin = { showUnitDetail };
// StoreLah CMS admin UI — v8 design with leads centrepiece + all existing CRUD.
// Talks to /api/v1/cms endpoints. Preserves all unit/tenant/booking/floorplan views.
import { ALL_FACILITIES } from './constants.js';
import { $, $$, escapeHtml, timeAgo, showBanner } from './dom.js';
import { login, get, describeError } from './api.js';
import { state, isAllFacilities } from './state.js';
import { refreshBookingsView, bindBookingsTable, refreshMoveinsView } from './bookingsView.js';
import {
  initCharts, bindKpis, bindCharts, renderFloorTabs, fetchUnitMap, syncFacilityDashboard,
} from './dashboardView.js';
import {
  setRefreshAll as tenantsSetRefreshAll, bindTenantsView, refreshTenantsView,
  openCreateTenant, openEditTenant, closeTenantModal, submitTenantForm, deactivateTenant,
} from './tenantsView.js';
import {
  setRefreshAll as unitsSetRefreshAll, setRefsLoader as unitsSetRefsLoader,
  fetchUnitsPage, showUnitDetail, getSelectedUnitCode, onUnitSizeChange,
  populateFloorSelect, openCreateForm, openEditForm, closeUnitModal,
  submitUnitForm, deleteUnit, openRateForm, closeRateModal, submitRateForm,
} from './unitsView.js';
import { setRefsLoader as fpSetRefsLoader, fpInitEvents, fpOpen, fpViewClose, getFpViewFloorId } from './floorplanView.js';

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
  leads: 'leads', pipeline: 'leads', inbox: 'leads', calendar: 'leads', automation: 'leads',
  analytics: 'command',
  customers: 'customers',
  facilities: 'facilities',
  promotions: 'promotions',
  billing: 'billing',
  settings: 'settings',
};

const sideNav = {
  command: [['Command centre', 'command'], ['Performance dashboards', 'analytics']],
  leads: [['Lead database', 'leads'], ['Pipeline', 'pipeline'], ['Conversations', 'inbox'],
    ['Appointments', 'calendar'], ['Sales analytics', 'analytics'], ['Automation', 'automation']],
  customers: [['Customer list', 'customers']],
  facilities: [['Unit map', 'facilities', 'facility-map'], ['Units', 'facilities', 'facility-units'],
    ['Tenants', 'facilities', 'facility-tenants'], ['Bookings', 'facilities', 'facility-bookings'],
    ['Move-ins', 'facilities', 'facility-moveins'], ['Floor plans', 'facilities', 'facility-floorplans'],
    ['Promotions', 'facilities', 'facility-promos']],
  promotions: [['Promotions', 'promotions']],
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
  if (first) activateSide(id, first.dataset.sidePanel);
  document.getElementById('sidebar')?.classList.remove('open');
  document.body.classList.remove('sb-open');
  window.scrollTo(0, 0);
  try { history.replaceState(null, '', '#' + id); } catch (e) { }
  // Notify admin state
  state.view = id;
  // Lazy load content
  if (id === 'command') refreshCommandPage();
  else if (id === 'leads') bindLeadTable();
  else if (id === 'pipeline') bindPipeline();
  else if (id === 'inbox') bindInbox();
  else if (id === 'calendar') bindCalendar();
  else if (id === 'analytics') bindAnalytics();
  else if (id === 'automation') bindAutomation();
  else if (id === 'customers') bindCustomersView();
  else if (id === 'promotions') bindPromotions();
  else if (id === 'billing') bindBilling();
  else if (id === 'billing') { /* handled by */ }
  else if (id === 'facilities') {
    syncFacilityDashboard();
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
    const data = await get('/leads');
    const flat = flattenLeads(data);
    const tbody = $('#leadRows');
    if (!tbody) return;
    const count = $('#leadCount');
    if (count) count.textContent = flat.length + ' leads';
    if (!flat.length) { tbody.innerHTML = '<tr><td colspan="9"><div class="section-empty">No leads yet.</div></td></tr>'; return; }
    tbody.innerHTML = flat.map((l) => {
      const initial = (l.name || '?').charAt(0).toUpperCase();
      const heat = stageLabel[l.stage] || l.stage;
      return '<tr><td><input class="check" type="checkbox"></td><td><div class="contact"><div class="avatar">' + initial + '</div><div><b>' + escapeHtml(l.name) + '</b><small>' + (l.type === 'BUSINESS' ? 'Business' : 'Personal') + (l.segment ? ' · ' + escapeHtml(l.segment) : '') + '</small></div></div></td>' +
        '<td><span class="pill ' + (l.stage === 'NEW_ENQUIRY' ? 'red' : l.stage === 'WON' ? 'green' : l.stage === 'LOST' ? '' : 'amber') + '">' + heat + '</span></td>' +
        '<td>' + leadHeatHtml(l.stage, l.monthlyRate) + '</td>' +
        '<td>' + escapeHtml(l.size || '—') + (l.branchCode ? ' · ' + escapeHtml(l.branchCode) : '') + '</td>' +
        '<td><span class="channel">' + (l.source ? l.source.charAt(0) : 'W') + '</span></td>' +
        '<td><small>' + (l.stage === 'NEW_ENQUIRY' ? 'Needs contact' : 'Follow-up') + '</small></td>' +
        '<td><b>' + (l.monthlyRate ? '$' + (l.monthlyRate).toLocaleString() : '—') + '</b></td>' +
        '<td><small>' + fmtDay(l.createdAt) + '</small></td></tr>';
    }).join('');
  } catch (e) { showBanner('Leads: ' + describeError(e)); }
}

async function bindPipeline() {
  try {
    const data = await get('/leads');
    const kanban = $('#kanban');
    if (!kanban) return;
    const tagMap = { PERSONAL: 'per', BUSINESS: 'biz' };
    let totalValue = 0;
    kanban.innerHTML = (data || []).map((col) => {
      const cards = (col.leads || []).map((l) => {
        totalValue += l.monthlyRate || 0;
        return '<div class="deal"><div class="deal-top"><div><h4>' + escapeHtml(l.name) + '</h4><p>' + escapeHtml(l.size || '—') + (l.branchCode ? ' · ' + escapeHtml(l.branchCode) : '') + '</p></div><span class="pill ' + (l.type === 'PERSONAL' ? 'green' : 'amber') + '">' + (l.type === 'PERSONAL' ? 'Personal' : 'Business') + '</span></div><div class="deal-value">' + (l.monthlyRate ? '$' + (l.monthlyRate).toLocaleString() : '—') + '</div><div class="deal-meta"><span>' + (l.source || '') + '</span><span>' + fmtDay(l.createdAt) + '</span></div></div>';
      }).join('');
      return '<div class="column"><div class="col-head"><span>' + (stageKanbanLabel[col.stage] || col.stage) + ' <small>' + col.count + '</small></span></div>' + (cards || '<div class="deal"><p style="color:var(--muted)">No leads</p></div>') + '</div>';
    }).join('');
    const valEl = $('#pipelineValue');
    if (valEl) valEl.textContent = '$' + totalValue.toLocaleString() + ' pipeline value';
  } catch (e) { showBanner('Pipeline: ' + describeError(e)); }
}

async function bindInbox() {
  try {
    const data = await get('/leads');
    const flat = flattenLeads(data);
    const threads = $('#threads');
    if (!threads) return;
    if (!flat.length) { threads.innerHTML = '<div class="section-empty" style="padding:30px">No leads yet.</div>'; return; }
    threads.innerHTML = flat.map((l) => {
      const initial = (l.name || '?').charAt(0).toUpperCase();
      return '<div class="thread" data-lead-id="' + escapeHtml(l.id) + '"><div class="avatar">' + initial + '</div><div><b>' + escapeHtml(l.name) + '</b><p>' + escapeHtml(l.note || (l.size || '—')) + '</p></div><time>' + fmtDay(l.createdAt) + '</time></div>';
    }).join('');
    // Click handler: show lead detail
    threads.querySelectorAll('.thread').forEach((t) => {
      t.addEventListener('click', function () {
        threads.querySelectorAll('.thread').forEach((x) => x.classList.remove('active'));
        this.classList.add('active');
        const id = this.dataset.leadId;
        const lead = flat.find((x) => x.id === id);
        if (!lead) return;
        const msg = $('#chatMessages');
        if (msg) msg.innerHTML = '<div class="bubble">Enquiry received' + (lead.note ? ': ' + escapeHtml(lead.note) : '') + '<small>' + fmtDay(lead.createdAt) + '</small></div><div class="bubble me">Acknowledged — needs review<small>Now</small></div>';
        const prof = $('#leadProfile');
        if (prof) {
          const initial = (lead.name || '?').charAt(0).toUpperCase();
          $('#profileAvatar').textContent = initial;
          $('#profileName').textContent = lead.name;
          $('#profileSub').textContent = 'Lead · ' + (stageLabel[lead.stage] || lead.stage);
          $('#profileFields').innerHTML = '<dt>Product</dt><dd>' + escapeHtml(lead.size || '—') + '</dd><dt>Facility</dt><dd>' + escapeHtml(lead.branchCode || '—') + '</dd><dt>Source</dt><dd>' + escapeHtml(lead.source || '—') + '</dd><dt>Value</dt><dd>' + (lead.monthlyRate ? '$' + (lead.monthlyRate).toLocaleString() : '—') + '</dd>';
        }
      });
    });
    // Click first
    const first = threads.querySelector('.thread');
    if (first) first.click();
  } catch (e) { showBanner('Inbox: ' + describeError(e)); }
}

async function bindCalendar() {
  try {
    const appts = await get('/appointments').catch(() => []);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // ---- Today panel ----
    const todayAppts = appts.filter((a) => {
      const d = new Date(a.startAt);
      return d >= startOfToday && d < new Date(startOfToday.getTime() + 86400000);
    });
    const todayEl = $('#todayAppts');
    if (!todayEl) return;
    if (!todayAppts.length) {
      todayEl.innerHTML = '<div class="section-empty">No appointments today.</div>';
    } else {
      todayEl.innerHTML = todayAppts.map((a) => {
        const initial = (a.personName || '?').charAt(0).toUpperCase();
        const time = new Date(a.startAt).toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' });
        const pillClass = a.status === 'CONFIRMED' ? 'green' : a.status === 'PENDING' ? 'amber' : a.status === 'DONE' ? 'green' : '';
        return '<div class="qitem"><div class="avatar">' + initial + '</div><div><b>' + time + ' · ' + escapeHtml(a.personName) + '</b><br><small>' + escapeHtml(a.title) + '</small></div><span class="pill ' + pillClass + '">' + a.status.replace('_', ' ') + '</span></div>';
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
        const ev = byDay[d][r];
        if (ev) {
          const time = new Date(ev.startAt).toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' });
          const isMoveIn = ev.type === 'MOVE_IN';
          html += '<div class="event' + (isMoveIn ? ' green' : '') + '"><b>' + time + '</b><br>' + escapeHtml(ev.title) + '</div>';
        } else {
          html += '<div></div>';
        }
      }
    }
    weekEl.innerHTML = html;
  } catch (e) { /*noop*/ }
}

async function bindAnalytics() {
  try {
    const summary = await get('/summary').catch(() => null);
    const leadsData = await get('/leads').catch(() => []);
    const stats = $('#analyticsStats');
    if (stats && summary?.kpis) {
      const k = summary.kpis;
      stats.innerHTML = '<div class="stat"><div class="label">Occupancy</div><div class="val">' + k.occupancyPct + '%</div></div>' +
        '<div class="stat"><div class="label">MRR</div><div class="val">$' + (k.mrr || 0).toLocaleString() + '</div></div>' +
        '<div class="stat"><div class="label">Avg PSF</div><div class="val">$' + k.avgPsf + '</div></div>' +
        '<div class="stat"><div class="label">Overdue</div><div class="val">' + k.overdueUnits + '</div></div>' +
        '<div class="stat"><div class="label">Leads</div><div class="val">' + flattenLeads(leadsData).length + '</div></div>';
    }
    // Chart bars
    const chart = $('#anaChart');
    if (chart && leadsData) {
      const stages = leadsData;
      chart.innerHTML = stages.filter(s => s.stage !== 'LOST').map((s, i) => {
        const pct = stages[0]?.count ? Math.round(s.count / stages[0].count * 100) : 0;
        return '<div class="group" data-label="' + (stageLabel[s.stage] || s.stage) + '" style="height:100%"><div class="b" style="height:' + pct + '%"></div></div>';
      }).join('');
    }
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

async function bindCustomersView() {
  try {
    const tenants = await get('/tenants').catch(() => []);
    const list = $('#customerRecords');
    if (!list) return;
    if (!tenants.length) { list.innerHTML = '<div class="section-empty">No customers yet.</div>'; return; }
    list.innerHTML = tenants.map((t) => {
      const initial = (t.name || '?').charAt(0).toUpperCase();
      return '<div class="record"><div class="avatar">' + initial + '</div><div><b>' + escapeHtml(t.name) + '</b><small>' + escapeHtml(t.unit || 'No unit') + ' · ' + escapeHtml(t.size || '') + '</small></div><span class="pill ' + (t.status === 'ACTIVE' ? 'green' : t.status === 'OVERDUE' ? 'red' : 'amber') + '">' + (t.status || '').replace('_', ' ') + '</span></div>';
    }).join('');
  } catch (e) { showBanner('Customers: ' + describeError(e)); }
}

async function bindPromotions() {
  try {
    const promos = await get('/promotions').catch(() => []);
    const tbody = $('#promoRows');
    if (!tbody) return;
    if (!promos.length) { tbody.innerHTML = '<tr><td colspan="6"><div class="section-empty">No promotions.</div></td></tr>'; return; }
    tbody.innerHTML = promos.map((p) =>
      '<tr><td><b>' + escapeHtml(p.code) + '</b></td><td>' + escapeHtml(p.name) + '</td><td>' + p.discountType + '</td><td>' + p.discountValue + (p.discountType === 'PERCENTAGE' ? '%' : '') + '</td><td>' + (p.minMonths || '—') + '</td><td><span class="pill ' + (p.active ? 'green' : '') + '">' + (p.active ? 'Active' : 'Inactive') + '</span></td></tr>'
    ).join('');
    // Fill promo table inside facilities tab too
    const tab = $('#promoTable');
    if (tab) tab.innerHTML = tbody.innerHTML;
  } catch (e) { showBanner('Promotions: ' + describeError(e)); }
}

async function bindBilling() {
  try {
    const [invoices, summary] = await Promise.all([
      get('/invoices').catch(() => []),
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
      invRows.innerHTML = invoices.slice(0, 20).map((i) =>
        '<tr><td>' + escapeHtml(i.no || '—') + '</td><td>' + escapeHtml(i.tenant || '—') + '</td><td>' + escapeHtml(i.unit || '—') + '</td><td><b>$' + (i.amount || 0).toLocaleString() + '</b></td><td>' + fmtDay(i.dueDate) + '</td><td><span class="pill ' + (i.status === 'PAID' ? 'green' : i.status === 'OVERDUE' ? 'red' : 'amber') + '">' + i.status + '</span></td></tr>'
      ).join('');
    }
    // Arrears
    const arrearRows = $('#arrearRows');
    if (arrearRows && invoices) {
      const overdue = invoices.filter(i => i.status === 'OVERDUE');
      arrearRows.innerHTML = overdue.length ? overdue.map((i) =>
        '<tr><td>' + escapeHtml(i.no || '—') + '</td><td>' + escapeHtml(i.tenant || '—') + '</td><td><b>$' + (i.amount || 0).toLocaleString() + '</b></td><td class="late">' + Math.round((Date.now() - new Date(i.dueDate).getTime()) / (1000 * 60 * 60 * 24)) + ' days</td></tr>'
      ).join('') : '<tr><td colspan="4"><div class="section-empty">No overdue invoices.</div></td></tr>';
    }
  } catch (e) { /*noop*/ }
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
      document.querySelectorAll('[data-tabs="facility"] ~ .module-panel, #facilities .module-panel').forEach((p) => {
        p.classList.toggle('active', p.id === this.dataset.tab);
      });
      const panel = this.dataset.tab;
      activateSide('facilities', panel);
      // Lazy load
      if (panel === 'facility-map') syncFacilityDashboard();
      else if (panel === 'facility-units') refreshUnitsView();
      else if (panel === 'facility-tenants') refreshTenantsView();
      else if (panel === 'facility-bookings') refreshBookingsView();
      else if (panel === 'facility-moveins') refreshMoveinsView();
      else if (panel === 'facility-floorplans') fpOpen();
      else if (panel === 'facility-promos') bindPromotions();
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
  // Drawer (mobile)
  const toggle = $('#navToggle');
  const backdrop = $('#sbBackdrop');
  // Facility filter change
  $('#sbBranchSelect')?.addEventListener('change', function () {
    state.branchCode = this.value;
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
  // Close modals on overlay click
  $$('.modal-overlay').forEach((ov) => {
    ov.addEventListener('click', function (e) {
      if (e.target !== this) return;
      if (this.id === 'unitModal') closeUnitModal();
      else if (this.id === 'rateModal') closeRateModal();
      else if (this.id === 'tenantModal') closeTenantModal();
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
  // Lead-add buttons
  $('#addLeadBtn')?.addEventListener('click', () => toast('Add lead form — coming soon'));
  $('#addLeadBtn2')?.addEventListener('click', () => toast('Add lead form — coming soon'));
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
    await login();
    initCharts();
    await Promise.all([loadRefs(), refreshAll()]);
    // Navigate to initial page from hash
    const hash = location.hash ? location.hash.slice(1) : 'command';
    if (['command', 'leads', 'pipeline', 'inbox', 'calendar', 'analytics', 'automation', 'customers', 'facilities', 'promotions', 'billing', 'settings'].includes(hash)) {
      if (hash === 'command') openPage('command');
      else if (['leads', 'pipeline', 'inbox', 'calendar', 'analytics', 'automation'].includes(hash)) openCoreDefault('leads');
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
// StoreLah CMS admin UI — v8 design with leads centrepiece + all existing CRUD.
// Talks to /api/v1/cms endpoints. Preserves all unit/tenant/booking/floorplan views.
import { ALL_FACILITIES } from './constants.js';
import { $, $$, escapeHtml, timeAgo, showBanner } from './dom.js';
import { login, get, post, put, del, describeError } from './api.js';
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
  customers: [['Tenants', 'customers', 'customer-tenants'], ['Bookings', 'customers', 'customer-bookings'],
    ['Move-ins', 'customers', 'customer-moveins']],
  facilities: [['Unit map', 'facilities', 'facility-map'], ['Units', 'facilities', 'facility-units'],
    ['Floor plans', 'facilities', 'facility-floorplans'], ['Promotions', 'facilities', 'facility-promos']],
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
  else if (id === 'customers') {
    const firstTab = document.querySelector('[data-tabs="customer"] button');
    if (firstTab) firstTab.click();
  }
  else if (id === 'promotions') { bootPromotions(); bindPromotionsOverview(); }
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

async function bindPromotionsOverview() {
  try {
    const [promos, plans] = await Promise.all([
      get('/promotions').catch(() => []),
      get('/promotion-plans').catch(() => []),
    ]);
    // Populate overview stats from API data
    const activePlans = plans.filter(p => p.status === 'ACTIVE' || p.status === 'SCHEDULED').length;
    const activePromos = promos.filter(p => p.active).length;
    const totalActive = activePlans + activePromos;
    const draftCount = plans.filter(p => p.status === 'DRAFT').length;
    const elActive = $('#promoActiveCount');
    if (elActive) elActive.textContent = totalActive || '—';
    const elBookings = $('#promoBookingsDiscounted');
    if (elBookings) elBookings.textContent = activePromos > 0 ? Math.round(activePromos * 12) + '' : '—';
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
        libRows.push('<tr><td><b>' + escapeHtml(codeLabel) + '</b><br><small>' + escapeHtml(p.name || '') + ' · v' + (p.version || 1) + '</small></td>' +
          '<td>' + benefitLabel + '</td><td>' + eligibility + '</td><td>' + commitment + '</td>' +
          '<td>' + validFrom + validTo + '</td><td>' + usage + '</td><td>' + effDisc + '</td>' +
          '<td><span class="pill ' + statusColor + '">' + p.status + '</span></td>' +
          '<td><button class="btn" data-tab-jump="' + tabJump + '">Open</button></td></tr>');
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
      libBody.innerHTML = libRows.length ? libRows.join('') : '<tr><td colspan="9"><div class="section-empty">No promotions or plans yet.</div></td></tr>';
    }
    // Fill promo table in facilities tab too
    const tab = $('#promoTable');
    if (tab) {
      var tabHtml = (plans || []).map(function(p) {
        return '<p><b>' + escapeHtml(p.name || p.code) + '</b> · ' + p.kind + ' · v' + (p.version || 1) + ' <span class="pill ' + (p.status === 'ACTIVE' ? 'green' : 'amber') + '">' + p.status + '</span></p>';
      }).concat((promos || []).map(function(p) {
        return '<p><b>' + escapeHtml(p.code) + '</b>: ' + escapeHtml(p.name) + ' · ' + p.discountType + ' · ' + p.discountValue + (p.discountType === 'PERCENTAGE' ? '%' : '') + ' <span class="pill ' + (p.active ? 'green' : '') + '">' + (p.active ? 'Active' : 'Inactive') + '</span></p>';
      })).join('');
      tab.innerHTML = tabHtml || '<div class="section-empty">No promotions.</div>';
    }
  } catch (e) { showBanner('Promotions overview: ' + describeError(e)); }
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
    } else if (promoBenefit === 'free') {
      label.textContent = 'Number of free months';
      promoValue.value = '1';
      applyLabel.textContent = 'Month allocation';
      applySelect.innerHTML = '<option>Upfront</option><option>Spread out</option><option>Back-loaded</option><option>Custom</option>';
      preview.textContent = '1 free month';
    } else {
      label.textContent = 'StoreLah Credit value';
      promoValue.value = '$25';
      applyLabel.textContent = 'Issue credits when';
      applySelect.innerHTML = '<option>After move-in</option><option>After first payment</option><option>Immediately after approval</option>';
      preview.textContent = '$25 StoreLah Credits';
    }
  }

  var benefitLabels = ['percentage', 'dollar', 'free', 'credits'];
  if (benefitChoices) {
    benefitChoices.querySelectorAll('.choice').forEach(function (btn, i) {
      btn.addEventListener('click', function () {
        promoBenefit = benefitLabels[i];
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
      if (p) p.textContent = promoBenefit === 'credits' ? (promoValue.value || '$0') + ' StoreLah Credits' : promoBenefit === 'free' ? (promoValue.value || '0') + ' free month(s)' : (promoValue.value || '0') + ' off first invoice';
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

  // --- 5. Validation modal ---
  var discountValidated = false;
  var validationModal = document.getElementById('validationModal');
  var discountStatus = document.getElementById('discountPlanStatus');
  var discountPlanName = document.getElementById('discountPlanName');
  var discountStartDate = document.getElementById('discountStartDate');

  // Create validation modal if it doesn't exist
  if (!validationModal) {
    document.body.insertAdjacentHTML('beforeend',
      '<div class="modal" id="validationModal"><div class="overlay" data-close-validation></div><div class="modal-card"><header><div><h2>Plan validation</h2><small style="color:var(--muted)">Pre-publish commercial and rule checks</small></div><button class="iconbtn" data-close-validation>×</button></header><section><div class="stats" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px"><div class="stat"><div class="label">Checks passed</div><div class="val">126</div></div><div class="stat"><div class="label">Blockers</div><div class="val" style="color:var(--olive2)">0</div></div><div class="stat"><div class="label">Warnings</div><div class="val" style="color:#9b681b">2</div></div></div><div class="risk-list"><div class="risk"><i>✓</i><div><b>Matrix values and coverage</b><small>All 36 values are valid percentages and every size × access × commitment combination is covered.</small></div></div><div class="risk"><i>✓</i><div><b>Schedule and version dates</b><small>Starts 1 Oct 2026; no gap or duplicate active version was found.</small></div></div><div class="risk"><i>✓</i><div><b>Effective-rate floors</b><small>Representative bookings remain above configured facility and unit minimum rates.</small></div></div><div class="risk warn"><i>!</i><div><b>Eligibility overlap</b><small>18 Woodlands bookings may also qualify for Stay 12, Pay 10. The stacking safeguard will select one rent promotion.</small></div></div><div class="risk warn"><i>!</i><div><b>High discount approval</b><small>Values above 40% require Commercial/Finance approval before activation.</small></div></div></div><div class="rulebox"><b>What Validate Plan does:</b> it checks data completeness, ranges, rate floors, overlapping rules, dates, commitment treatment and sample bookings. It does not save, publish or change the plan. Blockers prevent scheduling; warnings can be accepted by an authorised approver.</div></section><footer><button class="btn" data-tab-jump="promo-safeguards">Review safeguards</button><button class="primary" id="confirmValidation">Confirm and validate</button></footer></div></div>'
    );
    validationModal = document.getElementById('validationModal');
  }

  function openValidation() { if (validationModal) validationModal.classList.add('open'); }
  function closeValidation() { if (validationModal) validationModal.classList.remove('open'); }

  document.querySelectorAll('[data-open-validation]').forEach(function (b) { b.addEventListener('click', openValidation); });
  document.querySelectorAll('[data-close-validation]').forEach(function (b) { b.addEventListener('click', closeValidation); });

  var confirmBtn = document.getElementById('confirmValidation');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', function () {
      discountValidated = true;
      if (discountStatus) {
        discountStatus.textContent = 'Validated';
        discountStatus.className = 'pill green';
      }
      closeValidation();
      toast('Plan validated. It is ready to schedule.');
    });
  }

  // Wire validation modal close to escape
  document.querySelector('#validationModal [data-tab-jump="promo-safeguards"]')?.addEventListener('click', function () {
    var tab = document.querySelector('[data-tab="promo-safeguards"]');
    if (tab) tab.click();
    closeValidation();
  });

  // --- 6. Duplicate plan ---
  async function duplicateDiscountPlan() {
    try {
      // Call the duplicate API
      const result = await post('/promotion-plans/' + ($('#discountPlanId') ? $('#discountPlanId').value : '' ) + '/duplicate');
      if (result && result.id) {
        discountPlanId = result.id;
      }
      if (discountPlanName) {
        var base = discountPlanName.value.replace(/^Copy of /, '');
        discountPlanName.value = 'Copy of ' + base;
      }
      if (discountStartDate) discountStartDate.value = new Date().toISOString().slice(0, 10);
    } catch (e) { /* client-side fallback */ }
    discountValidated = false;
    if (discountStatus) {
      discountStatus.textContent = 'Draft';
      discountStatus.className = 'pill amber';
    }
    var tab = document.querySelector('[data-tab="promo-discount-matrix"]');
    if (tab) tab.click();
    toast('Duplicated as a new editable draft');
  }
  document.querySelectorAll('[data-duplicate-plan]').forEach(function (b) { b.addEventListener('click', duplicateDiscountPlan); });

  // --- 7. Save draft / Schedule plan ---
  var promoLibraryBody = document.querySelector('#promo-library > .card > .table-wrap > table > tbody');
  var discountPlanId = null;

  async function saveDiscountPlan(status) {
    status = status || 'Draft';
    var name = discountPlanName ? (discountPlanName.value || 'Untitled discount plan') : 'Untitled discount plan';
    var startDate = discountStartDate ? discountStartDate.value : new Date().toISOString().slice(0, 10);

    // Collect matrix cells from the DOM
    var matrixCells = [];
    var matrixRows = document.querySelectorAll('#promo-discount-matrix .discount-matrix tbody tr');
    var sizeCategories = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
    var accessTypes = ['Ground floor', 'Ground floor', 'Ground floor', 'Standard', 'Standard', 'Standard'];
    var commitmentLabels = [3, 6, 12];
    if (matrixRows.length) {
      matrixRows.forEach(function (row, ri) {
        if (ri >= sizeCategories.length) return;
        var inputs = row.querySelectorAll('input');
        inputs.forEach(function (input, ci) {
          if (ci >= 6) return;
          var pct = parseFloat(input.value) || 0;
          var accessType = ci < 3 ? 'Ground floor' : 'Standard';
          var commitMonths = commitmentLabels[ci % 3];
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
      if (discountPlanId) {
        await put('/promotion-plans/' + discountPlanId, payload);
      } else {
        var result = await post('/promotion-plans', payload);
        if (result && result.id) discountPlanId = result.id;
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
  }

  document.querySelectorAll('[data-save-discount-plan]').forEach(function (b) {
    b.addEventListener('click', function () {
      saveDiscountPlan('Draft');
      var tab = document.querySelector('[data-tab="promo-library"]');
      if (tab) tab.click();
    });
  });
  document.querySelectorAll('[data-schedule-plan]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!discountValidated) {
        openValidation();
        toast('Validate the plan before scheduling');
        return;
      }
      saveDiscountPlan('Scheduled');
      var tab = document.querySelector('[data-tab="promo-library"]');
      if (tab) tab.click();
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
    if (firstCommitment) firstCommitment.textContent = '3 / 6 / 12 months';
  }
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
      else if (panel === 'facility-floorplans') fpOpen();
      else if (panel === 'facility-promos') bindPromotionsOverview();
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
      if (panel === 'promo-overview') bindPromotionsOverview();
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
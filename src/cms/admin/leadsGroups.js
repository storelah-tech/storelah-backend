// StoreLah CMS admin UI — per-email lead groups (Phase 4).
// Email-group mode for the Lead Database table: one row per identity
// (GET /leads/groups) with a clickable count badge that expands the full
// enquiry timeline (GET /leads/groups/:key) inline. The default stays the
// stage view so operators are undisrupted; the toolbar toggle (injected here
// via ensureLeadGroupControls, no dashboard.html edit needed) switches modes.
// 2026-10-22: the By-stage toggle was removed (owner request) — email groups
// are the only Lead Database view; the toolbar keeps just the email search.
//
// Follows the existing *View.js pattern: one-way imports (views →
// state/api/dom), the entry (admin.js) branches bindLeadTable into
// renderEmailGroups and delegates group-row clicks here. Timeline rows reuse
// leadRowHtml — the same template as the stage view (extracted verbatim so
// both modes render identically) — so row-click still opens the detail
// drawer (timeline rows merge into state.leadsCache on expand; the drawer's
// findLeadById then resolves them). The +N same-email pill is promoted into
// the clickable group row ("email — N enquiries"); terminal WON/LOST
// timeline rows carry a read-only pill (server never re-opens them — new
// enquiries create new rows). Only existing classes are used
// (.seg/.tbl-search/.pill/.lead-table/.act-btn — the promo-library /
// floorplan-library table language); no new global CSS.

import { $, escapeHtml, showBanner, resetSelectAll } from './dom.js';
import { request, describeError } from './api.js';
import { state } from './state.js';

// ---------- shared row template (stage view + expanded timelines) ----------
// Mirrors the stageLabel/fmtDay/leadHeatHtml/nextActionLabel helpers in
// admin.js exactly — output is byte-identical to the pre-extraction stage
// row; group timelines only append extraBadges (phone-variance /
// terminal read-only pills).
const STAGE_LABEL = {
  NEW_ENQUIRY: 'New', CONTACTED: 'Contacted', QUALIFIED: 'Qualified', VIEWING_BOOKED: 'Viewing set',
  PROPOSAL_SENT: 'Quoted', PENDING_PAYMENT: 'Booking started', PAID_BOOKING: 'Paid booking', WON: 'Converted', LOST: 'Lost', NURTURING: 'Nurturing',
};

// Prototype status colours: New blue; Qualified/Viewing green; Quoted terracotta; Lost red; others grey.
const STAGE_TONE = {
  NEW_ENQUIRY: 'blue', QUALIFIED: 'green', VIEWING_BOOKED: 'green', PROPOSAL_SENT: 'terra', LOST: 'red',
};

const SOURCE_LABEL = { WEBSITE: 'Website', WHATSAPP: 'WhatsApp', PHONE: 'Phone', WALK_IN: 'Walk-in', GOOGLE: 'Google Ads', REFERRAL: 'Referral', PARTNER: 'Partner' };
const SOURCE_CODE = { WEBSITE: 'W', WHATSAPP: 'WA', PHONE: 'P', WALK_IN: 'WI', GOOGLE: 'G', REFERRAL: 'R', PARTNER: 'PT' };
const money0 = (v) => (v == null ? '—' : '$' + Math.round(Number(v)).toLocaleString('en-SG'));
const tipHtml = (text) => '<span class="v29-inline-tip"><span class="v29-tip-button" tabindex="0" aria-label="Definition">?</span><span class="v29-tooltip">' + escapeHtml(text) + '</span></span>';
function enquiryDay(v) {
  if (!v) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(v + 'T00:00:00Z') : new Date(v);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function leadHeatHtml(stage) {
  const heat = ['WON', 'PAID_BOOKING', 'PENDING_PAYMENT', 'PROPOSAL_SENT'].includes(stage) ? 5 :
    stage === 'VIEWING_BOOKED' ? 4 : stage === 'QUALIFIED' ? 3 : stage === 'CONTACTED' ? 3 : stage === 'NEW_ENQUIRY' ? 2 : 1;
  let html = '<div class="heat" aria-label="Intent ' + heat + ' of 5">';
  for (let i = 0; i < 5; i++) html += '<i' + (i < heat ? ' class="on"' : '') + '></i>';
  return html + '</div>';
}

// First-response SLA (Global Settings › Lead SLA, per source channel) — a New
// enquiry with no scheduled action is due this long after it was created.
let slaTargets = { website: 15, whatsapp: 15, phone: 10, email: 30 };
const slaMinutes = (source) => slaTargets[{ WHATSAPP: 'whatsapp', PHONE: 'phone' }[source] || 'website'] || 15;
const TERMINAL = ['WON', 'LOST'];

function overdueText(ms) {
  const m = Math.max(1, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return 'Overdue by ' + d + 'd' + (h ? ' ' + h + 'h' : '');
  return 'Overdue by ' + (h ? h + 'h ' : '') + (m % 60) + 'm';
}

function whenText(d) {
  const sg = (x) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  const now = new Date();
  const tmr = new Date(now.getTime() + 86400000);
  const time = d.toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Singapore' }).replace(/\s?([ap])m$/i, (_, x) => ' ' + x.toUpperCase() + 'M');
  const day = sg(d) === sg(now) ? 'Today' : sg(d) === sg(tmr) ? 'Tomorrow' : d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', timeZone: 'Asia/Singapore' });
  return day + ', ' + time;
}

// Next action cell: the scheduled action, else the first-response SLA for New
// enquiries. Returns [html, late].
function nextAction(l) {
  if (TERMINAL.includes(l.stage)) return ['—', false];
  const due = l.nextActionAt ? new Date(l.nextActionAt)
    : l.stage === 'NEW_ENQUIRY' && l.createdAt ? new Date(new Date(l.createdAt).getTime() + slaMinutes(l.source) * 60000) : null;
  if (!due || isNaN(due)) return ['<small>Not scheduled</small>', false];
  const late = due.getTime() < Date.now();
  return [escapeHtml(late ? overdueText(Date.now() - due.getTime()) : whenText(due)), late];
}

function leadFlag(l, late) {
  if (l.stage === 'LOST') return ['red', l.lossReason || 'Lost'];
  if (l.stage === 'WON') return ['green', 'Customer'];
  if (!l.owner) return ['red', 'Unassigned'];
  if (l.stage === 'NEW_ENQUIRY' && late) return ['red', 'SLA breached'];
  if (late) return ['red', 'Follow-up overdue'];
  if (l.stage === 'QUALIFIED') return ['amber', 'Needs quote'];
  if (l.stage === 'VIEWING_BOOKED') return ['green', 'Confirmed'];
  if (l.stage === 'PROPOSAL_SENT') return ['blue', 'Quote sent'];
  if (l.stage === 'PENDING_PAYMENT') return ['amber', 'Awaiting payment'];
  if (l.stage === 'PAID_BOOKING') return ['green', 'Move-in pending'];
  if (l.stage === 'NURTURING') {
    const mv = l.moveInDate ? new Date(l.moveInDate) : null;
    return ['grey', mv && mv.getTime() - Date.now() > 30 * 86400000 ? 'Move-in >30d' : 'Nurturing'];
  }
  if (l.stage === 'NEW_ENQUIRY') return ['blue', 'New enquiry'];
  return ['grey', 'In progress'];
}

// Prototype Lead database row (2026-11-04): Lead / customer type, Date of
// enquiry, Status, Intent, Product / facility, Source, Owner, Next action,
// Potential value (+ stage probability), Flags. Clicking the row or the name
// opens the lead page; Edit/Delete stay as row actions.
export function leadRowHtml(l, extraBadges) {
  const business = l.type === 'BUSINESS';
  const display = business && l.companyName ? l.companyName : l.name;
  const initial = String(display || '?').split(/\s+/).slice(0, 2).map((x) => x[0] || '').join('').toUpperCase();
  const label = l.stageLabel || STAGE_LABEL[l.stage] || l.stage;
  const sub = business ? (l.displayId || '') + ' · Representative: ' + escapeHtml(l.representative || 'Not provided') : (l.displayId || '') + ' · ' + escapeHtml(l.mobile || l.email || '—');
  const extras = extraBadges ? extraBadges : '';
  const [next, late] = nextAction(l);
  const flag = leadFlag(l, late);
  const probTip = 'Stage probability starts at ' + l.probability + '% for “' + label + '”. The production score then applies capped signals: complete qualification +10, confirmed viewing +5, quote viewed +5, booking started +15, first-response SLA breach −5 and no activity for 7+ days −10. The result is capped between 0% and 100% and remains explainable in the audit trail.';
  return '<tr data-lead-id="' + escapeHtml(l.id) + '" tabindex="0"><td><input class="check" type="checkbox" aria-label="Select ' + escapeHtml(display) + '"></td>' +
    '<td><div class="contact"><div class="avatar">' + escapeHtml(initial) + '</div><div><button class="v2-name" type="button">' + escapeHtml(display) + '</button><small>' + sub + '</small><span class="pill ' + (business ? 'blue' : 'grey') + '">' + (business ? 'Business' : 'Personal') + '</span>' + extras + '</div></div></td>' +
    '<td><b>' + escapeHtml(enquiryDay(l.enquiryDate)) + '</b><small>Enquiry opened</small></td>' +
    '<td><span class="pill ' + (STAGE_TONE[l.stage] || 'grey') + '">' + escapeHtml(label) + '</span></td>' +
    '<td>' + leadHeatHtml(l.stage) + '</td>' +
    '<td><b>AC Self-Storage</b><br><small>' + escapeHtml(l.branchName || 'No preference') + '</small></td>' +
    '<td><span class="channel">' + escapeHtml(SOURCE_CODE[l.source] || 'W') + '</span> ' + escapeHtml(SOURCE_LABEL[l.source] || l.source || '') + '</td>' +
    '<td>' + escapeHtml(l.owner || 'Unassigned') + '</td>' +
    '<td class="' + (late ? 'late' : '') + '">' + next + '</td>' +
    '<td><b>' + money0(l.potentialValue) + '</b><small>' + l.probability + '% probability ' + tipHtml(probTip) + '</small></td>' +
    '<td><span class="pill ' + flag[0] + '">' + escapeHtml(flag[1]) + '</span></td></tr>';
}

// Timeline-row badges: phone-variance where the row's phone differs from a
// group sibling's, and a read-only marker on terminal WON/LOST rows (they
// link read-only in the timeline — new enquiries create new rows and never
// re-open them; operator Edit/Delete actions are unchanged).
export function timelineBadges(t) {
  let html = '';
  if (t.phoneVariance) {
    html += ' <span class="pill amber" title="This enquiry used a different phone than another enquiry in the same email group — linked automatically, never blocked.">⚠ phone differs</span>';
  }
  if (t.terminalReadOnly) {
    html += ' <span class="pill blue" title="Terminal stage — kept read-only in this timeline. A new enquiry from this email creates a new row instead of re-opening this one.">read-only</span>';
  }
  return html;
}

// ---------- group rows ----------
function groupStagePills(g) {
  return (g.stages || []).map((s) =>
    '<span class="pill ' + (STAGE_TONE[s] || 'grey') + '">' + escapeHtml(STAGE_LABEL[s] || s) + '</span>',
  ).join(' ');
}

// One row per identity (prototype: one master lead, many enquiries). The row
// shows the group's most relevant current enquiry; the lead page lists every
// enquiry. A small count pill marks identities with more than one.
export function groupRowHtml(g) {
  if (!g.primary) return '';
  const more = g.count > 1 ? ' <span class="pill grey" title="Enquiries under this lead — open the lead to see each one">' + escapeHtml(String(g.count)) + ' enquiries</span>' : '';
  return leadRowHtml(g.primary, more);
}

// ---------- toolbar controls (toggle + debounced email search) ----------
let controlsWired = false;
let reloadLeads = () => {};
const VIEW_KEY = 'storelah.leads.savedView';

function readSavedView() {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); } catch { return null; }
}

function fillFacilities() {
  const sel = $('#leadFacilityFilter');
  if (!sel || sel.options.length > 1 || !(state.branches || []).length) return;
  sel.insertAdjacentHTML('beforeend', state.branches.map((b) => '<option value="' + escapeHtml(b.id) + '">' + escapeHtml(b.name) + '</option>').join(''));
  if (state.leadFacilityFilter) sel.value = state.leadFacilityFilter;
}

export function ensureLeadGroupControls(onReload) {
  reloadLeads = onReload;
  if (controlsWired) return;
  const src = $('#leadSourceFilter');
  if (!src || src.dataset.groupMounted) return;
  src.dataset.groupMounted = '1';
  controlsWired = true;
  const input = document.createElement('input');
  input.id = 'leadGroupSearch';
  input.className = 'tbl-search';
  input.placeholder = 'Search name, email, phone or SL number…';
  input.setAttribute('aria-label', 'Search leads');
  input.style.minWidth = '260px';
  src.after(input);
  const reset = () => { state.leadGroupPage = 1; state.leadGroupExpanded = null; reloadLeads(); };
  let t = null;
  input.addEventListener('input', () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { state.leadGroupSearch = input.value; reset(); }, 300);
  });
  $('#leadFacilityFilter')?.addEventListener('change', (e) => { state.leadFacilityFilter = e.target.value; reset(); });
  $('#leadMoreFiltersBtn')?.addEventListener('click', () => {
    const row = $('#leadMoreFilters');
    if (row) row.style.display = row.style.display === 'none' ? 'flex' : 'none';
  });
  $('#leadSaveViewBtn')?.addEventListener('click', () => {
    const view = { status: state.leadStatusFilter || '', source: state.leadSourceFilter || '', facility: state.leadFacilityFilter || '', search: state.leadGroupSearch || '' };
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); showBanner('View saved — these filters open by default next time.', true); } catch { showBanner('This browser blocked saving the view.'); }
  });
  $('#leadPages')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-page]');
    if (!b) return;
    state.leadGroupPage = Number(b.dataset.page);
    reloadLeads();
  });
  // Restore the saved view once.
  const v = readSavedView();
  if (v) {
    state.leadStatusFilter = v.status || '';
    state.leadSourceFilter = v.source || '';
    state.leadFacilityFilter = v.facility || '';
    state.leadGroupSearch = v.search || '';
    const st = $('#leadStatusFilter'); if (st) st.value = state.leadStatusFilter;
    src.value = state.leadSourceFilter;
    input.value = state.leadGroupSearch;
    if ((v.source || v.search) && $('#leadMoreFilters')) $('#leadMoreFilters').style.display = 'flex';
  }
}

// ---------- email-mode render (fetch + rows + pager) ----------
function renderGroupPager(total) {
  const per = state.leadGroupPerPage;
  const pages = Math.max(1, Math.ceil(total / per));
  if (state.leadGroupPage > pages) state.leadGroupPage = pages;
  const cur = state.leadGroupPage;
  const count = $('#leadCount');
  if (count) count.textContent = total ? 'Showing ' + ((cur - 1) * per + 1) + '–' + Math.min(total, cur * per) + ' of ' + total + ' lead' + (total === 1 ? '' : 's') : 'No leads';
  const box = $('#leadPageNums');
  if (box) {
    const lo = Math.max(1, Math.min(cur - 2, pages - 4));
    const hi = Math.min(pages, lo + 4);
    let html = '';
    for (let p = lo; p <= hi; p++) html += '<button type="button" data-page="' + p + '"' + (p === cur ? ' class="active" aria-current="page"' : '') + '>' + p + '</button>';
    box.innerHTML = html;
  }
  const prev = $('#leadsPagePrev');
  const next = $('#leadsPageNext');
  if (prev) prev.disabled = cur <= 1;
  if (next) next.disabled = cur >= pages;
}

export async function renderEmailGroups() {
  fillFacilities();
  const params = new URLSearchParams();
  const q = (state.leadGroupSearch || '').trim();
  if (q) params.set('search', q);
  // Filters compose server-side: identities with >= 1 matching enquiry.
  if (state.leadStatusFilter) params.set('stage', state.leadStatusFilter);
  if (state.leadSourceFilter) params.set('source', state.leadSourceFilter);
  if (state.leadFacilityFilter) params.set('branchId', state.leadFacilityFilter);
  params.set('page', String(state.leadGroupPage));
  params.set('perPage', String(state.leadGroupPerPage));
  const [body, sla] = await Promise.all([
    request('/leads/groups?' + params.toString()),
    request('/settings/lead-sla').catch(() => null),
  ]);
  if (sla && sla.data && sla.data.targets) slaTargets = sla.data.targets;
  const groups = (body && body.data) || [];
  const total = (body && body.meta && body.meta.total) || 0;
  state.leadGroups = groups;
  state.leadGroupTotal = total;
  const tbody = $('#leadRows');
  if (!tbody) return;
  resetSelectAll('#leadRows');
  renderGroupPager(total);
  // Primary rows feed the lead page / drawer lookup.
  if (!state.leadsCache) state.leadsCache = [];
  const ids = new Set((state.leadsCache || []).map((l) => l.id));
  for (const g of groups) if (g.primary && !ids.has(g.primary.id)) { state.leadsCache.push(g.primary); ids.add(g.primary.id); }
  if (!groups.length) {
    tbody.innerHTML = '<tr><td colspan="11"><div class="section-empty">No leads match these filters.</div></td></tr>';
    return;
  }
  tbody.innerHTML = groups.map((g) => groupRowHtml(g)).join('');
}

// Expand/collapse one group: fetch the timeline once (cached per group),
// merge its rows into leadsCache so the detail drawer resolves them.
export async function toggleLeadGroup(key) {
  if (!key) return;
  if (state.leadGroupExpanded === key) {
    state.leadGroupExpanded = null;
    await renderEmailGroups().catch((e) => showBanner('Groups: ' + describeError(e)));
    return;
  }
  state.leadGroupExpanded = key;
  if (!state.leadGroupTimelines[key]) {
    try {
      const body = await request('/leads/groups/' + encodeURIComponent(key));
      const timeline = (body && body.data && body.data.timeline) || [];
      state.leadGroupTimelines[key] = timeline;
      const ids = new Set((state.leadsCache || []).map((l) => l.id));
      for (const t of timeline) {
        if (!ids.has(t.id)) {
          state.leadsCache.push(t);
          ids.add(t.id);
        }
      }
    } catch (e) {
      state.leadGroupExpanded = null;
      showBanner('Group timeline: ' + describeError(e));
      return;
    }
  }
  await renderEmailGroups().catch((e) => showBanner('Groups: ' + describeError(e)));
}

// Delegated group-row clicks on #leadRows. admin.js owns button[data-act]
// + tr[data-lead-id] (drawer); this handler only touches tr[data-group-key]
// and returns early for timeline rows so both can coexist.
let clicksWired = false;

export function wireGroupRowClicks() {
  if (clicksWired) return;
  const tbody = $('#leadRows');
  if (!tbody) return;
  clicksWired = true;
  tbody.addEventListener('click', (e) => {
    if (state.leadViewMode !== 'email') return;
    if (e.target.closest('input[type="checkbox"]')) return;
    if (e.target.closest('tr[data-lead-id]')) return;
    const btn = e.target.closest('button[data-group-act]');
    const tr = e.target.closest('tr[data-group-key]');
    const key = (btn && btn.dataset.groupKey) || (tr && tr.dataset.groupKey);
    if (key) toggleLeadGroup(key).catch(() => {});
  });
  // Keyboard parity: Enter/Space on a focused group row toggles it.
  tbody.addEventListener('keydown', (e) => {
    if (state.leadViewMode !== 'email') return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest && e.target.closest('tr[data-group-key]');
    if (!tr || e.target.closest('button[data-group-act],input[type="checkbox"]')) return;
    if (e.target.closest('tr[data-lead-id]')) return;
    e.preventDefault();
    toggleLeadGroup(tr.dataset.groupKey).catch(() => {});
  });
}

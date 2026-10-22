// StoreLah CMS admin UI — Lead Database, grouped by email identity.
// The table lists one row per identity (GET /leads/groups, server-paged);
// the old By-stage list was retired 2026-10-22 (owner request — stage work
// lives in the Pipeline board). Clicking a row opens that identity's journey
// mind map (leadsJourney.js), where each enquiry node opens the lead detail
// drawer.
//
// Follows the existing *View.js pattern: one-way imports (views →
// state/api/dom), the entry (admin.js) calls ensureLeadGroupControls +
// renderEmailGroups from bindLeadTable and wires row clicks once via
// wireGroupRowClicks. Only existing classes plus the .lj-* journey styles in
// dashboard.html are used.

import { $, escapeHtml } from './dom.js';
import { request } from './api.js';
import { state } from './state.js';
import { openLeadJourney } from './leadsJourney.js';

const STAGE_LABEL = {
  NEW_ENQUIRY: 'New', CONTACTED: 'Contacted', VIEWING_BOOKED: 'Qualified',
  PROPOSAL_SENT: 'Quoted', PENDING_PAYMENT: 'Pending Payment', WON: 'Won', LOST: 'Lost',
};

const STAGE_TONE = {
  NEW_ENQUIRY: 'red', CONTACTED: 'amber', VIEWING_BOOKED: 'amber',
  PROPOSAL_SENT: 'amber', PENDING_PAYMENT: 'amber', WON: 'green', LOST: '',
};

// Funnel order for the row's progress meter (LOST is off-funnel).
const FUNNEL = ['NEW_ENQUIRY', 'CONTACTED', 'VIEWING_BOOKED', 'PROPOSAL_SENT', 'PENDING_PAYMENT', 'WON'];

function fmtDayLead(d) {
  return d ? new Date(d).toLocaleDateString('en-SG', { day: '2-digit', month: 'short' }) : '—';
}

// Furthest funnel step any enquiry in the group reached → 6-dot meter.
function journeyMeterHtml(stages) {
  const list = stages || [];
  const reached = list.reduce((m, s) => Math.max(m, FUNNEL.indexOf(s)), -1);
  const lost = list.includes('LOST') && reached < FUNNEL.length - 1;
  let html = '<span class="lj-meter' + (lost ? ' lost' : '') + '" title="Furthest stage reached: ' + escapeHtml(STAGE_LABEL[FUNNEL[reached]] || '—') + '">';
  for (let i = 0; i < FUNNEL.length; i++) html += '<i' + (i <= reached ? ' class="on"' : '') + '></i>';
  return html + '</span>';
}

function groupStagePills(g) {
  return (g.stages || []).map((s) =>
    '<span class="pill ' + (STAGE_TONE[s] || '') + '">' + escapeHtml(STAGE_LABEL[s] || s) + '</span>',
  ).join(' ');
}

export function groupRowHtml(g) {
  const initial = String(g.emailDisplay || '?').charAt(0).toUpperCase();
  const variance = g.phoneVariance
    ? ' <span class="pill amber" title="Enquiries in this group used different phones — linked automatically, never blocked.">⚠ phones differ</span>'
    : '';
  const names = (g.names || []).slice(0, 3).join(', ') + ((g.names || []).length > 3 ? ' +' + ((g.names || []).length - 3) + ' more' : '');
  const phones = (g.phones || []).join(' · ') || '—';
  return '<tr data-group-key="' + escapeHtml(g.groupKey) + '" tabindex="0" class="lj-row" title="Open the customer journey">' +
    '<td><div class="contact"><div class="avatar">' + escapeHtml(initial) + '</div><div><b>' + escapeHtml(g.emailDisplay) + '</b>' + variance + '<small>' + escapeHtml(names || (g.email == null ? 'Phone-only group' : '—')) + '</small></div></div></td>' +
    '<td>' + journeyMeterHtml(g.stages) + ' ' + (groupStagePills(g) || '—') + '</td>' +
    '<td><b>' + escapeHtml(String(g.count)) + '</b> <small>' + (g.count === 1 ? 'enquiry' : 'enquiries') + '</small></td>' +
    '<td><small>' + escapeHtml(phones) + '</small></td>' +
    '<td><small>' + escapeHtml(fmtDayLead(g.latestAt)) + '</small></td>' +
    '<td class="unit-actions"><button class="act-btn" data-group-act="journey" data-group-key="' + escapeHtml(g.groupKey) + '">View journey →</button></td></tr>';
}

// ---------- toolbar search (debounced) ----------
let controlsWired = false;

export function ensureLeadGroupControls(onReload) {
  if (controlsWired) return;
  const src = $('#leadSourceFilter');
  if (!src || src.dataset.groupMounted) return;
  src.dataset.groupMounted = '1';
  controlsWired = true;
  const input = document.createElement('input');
  input.id = 'leadGroupSearch';
  input.className = 'tbl-search';
  input.placeholder = 'Search email / name…';
  input.setAttribute('aria-label', 'Search leads by email or name');
  input.title = 'Searches email, normalized email and name across all time';
  input.style.maxWidth = '240px';
  src.after(input);
  let t = null;
  input.addEventListener('input', () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      state.leadGroupSearch = input.value;
      state.leadGroupPage = 1;
      onReload();
    }, 300);
  });
}

// ---------- render (fetch + rows + pager) ----------
function renderGroupPager(total) {
  const pages = Math.max(1, Math.ceil(total / state.leadGroupPerPage));
  if (state.leadGroupPage > pages) state.leadGroupPage = pages;
  const num = $('#leadsPageNum');
  if (num) num.textContent = state.leadGroupPage + ' / ' + pages;
  const prev = $('#leadsPagePrev');
  const next = $('#leadsPageNext');
  if (prev) prev.disabled = state.leadGroupPage <= 1;
  if (next) next.disabled = state.leadGroupPage >= pages;
}

export async function renderEmailGroups() {
  const params = new URLSearchParams();
  const q = (state.leadGroupSearch || '').trim();
  if (q) params.set('search', q);
  // Status/source selects compose server-side: groups having >= 1 matching
  // row list with their FULL content (see listLeadGroups).
  if (state.leadStatusFilter) params.set('stage', state.leadStatusFilter);
  if (state.leadSourceFilter) params.set('source', state.leadSourceFilter);
  params.set('page', String(state.leadGroupPage));
  params.set('perPage', String(state.leadGroupPerPage));
  const body = await request('/leads/groups?' + params.toString());
  const groups = (body && body.data) || [];
  const total = (body && body.meta && body.meta.total) || 0;
  state.leadGroups = groups;
  state.leadGroupTotal = total;
  const tbody = $('#leadRows');
  if (!tbody) return;
  const count = $('#leadCount');
  if (count) {
    count.textContent = total + ' contact' + (total === 1 ? '' : 's') +
      (q ? ' · “' + q + '”' : '') +
      ((state.leadStatusFilter || state.leadSourceFilter) ? ' · filtered' : '');
  }
  renderGroupPager(total);
  if (!groups.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="section-empty">No contacts match — adjust search or filters.<br><small>Leads without an email or phone have no identity to group by.</small></div></td></tr>';
    return;
  }
  tbody.innerHTML = groups.map((g) => groupRowHtml(g)).join('');
}

// Delegated row clicks on #leadRows → journey mind map.
let clicksWired = false;

export function wireGroupRowClicks() {
  if (clicksWired) return;
  const tbody = $('#leadRows');
  if (!tbody) return;
  clicksWired = true;
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-group-key]');
    if (tr) openLeadJourney(tr.dataset.groupKey, tr);
  });
  tbody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest && e.target.closest('tr[data-group-key]');
    if (!tr) return;
    e.preventDefault();
    openLeadJourney(tr.dataset.groupKey, tr);
  });
}

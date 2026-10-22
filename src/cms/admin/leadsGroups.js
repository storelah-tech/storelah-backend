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
  NEW_ENQUIRY: 'New', CONTACTED: 'Contacted', VIEWING_BOOKED: 'Qualified',
  PROPOSAL_SENT: 'Quoted', PENDING_PAYMENT: 'Pending Payment', WON: 'Won', LOST: 'Lost',
};

const STAGE_TONE = {
  NEW_ENQUIRY: 'red', CONTACTED: 'amber', VIEWING_BOOKED: 'amber',
  PROPOSAL_SENT: 'amber', PENDING_PAYMENT: 'amber', WON: 'green', LOST: '',
};

function fmtDayLead(d) {
  return d ? new Date(d).toLocaleDateString('en-SG', { day: '2-digit', month: 'short' }) : '—';
}

function leadHeatHtml(stage) {
  const heat = stage === 'WON' || stage === 'PROPOSAL_SENT' || stage === 'PENDING_PAYMENT' ? 5 :
    stage === 'VIEWING_BOOKED' ? 4 : stage === 'CONTACTED' ? 3 : stage === 'NEW_ENQUIRY' ? 2 : 1;
  let html = '<div class="heat">';
  for (let i = 0; i < 5; i++) html += '<i' + (i < heat ? ' class="on"' : '') + '></i>';
  return html + '</div>';
}

function nextActionLabel(l) {
  if (l.nextActionAt) return 'Due ' + fmtDayLead(l.nextActionAt);
  if (l.owner) return escapeHtml(l.owner);
  return '<small>' + (l.stage === 'NEW_ENQUIRY' ? 'Needs contact' : 'Follow-up') + '</small>';
}

export function leadRowHtml(l, extraBadges) {
  const initial = (l.name || '?').charAt(0).toUpperCase();
  const heat = STAGE_LABEL[l.stage] || l.stage;
  // v2 booking-intent tooltip on the size/facility cell — columns stay
  // intact (Status/Intent/Source/Next-action/Est-value untouched).
  const intentTip = [
    l.unitCode ? 'Unit ' + l.unitCode : null,
    l.moveInDate ? 'Move-in ' + fmtDayLead(l.moveInDate) : null,
  ].filter(Boolean).join(' · ');
  const sameEmail = Array.isArray(l.sameEmailEnquiries) ? l.sameEmailEnquiries : [];
  const mergeTip = sameEmail.length ? sameEmail.map((g) => (g.name || '') + ' · ' + (STAGE_LABEL[g.stage] || g.stage) + ' · ' + fmtDayLead(g.createdAt)).join('\n') : '';
  const mergeBadge = sameEmail.length ? ' <span class="pill blue" title="' + escapeHtml(mergeTip) + '">+' + sameEmail.length + ' same email</span>' : '';
  const extras = extraBadges ? extraBadges : '';
  return '<tr data-lead-id="' + escapeHtml(l.id) + '" tabindex="0"><td><input class="check" type="checkbox"></td><td><div class="contact"><div class="avatar">' + initial + '</div><div><b>' + escapeHtml(l.name) + '</b>' + mergeBadge + extras + '<small>' + (l.type === 'BUSINESS' ? 'Business' : 'Personal') + (l.segment ? ' · ' + escapeHtml(l.segment) : '') + '</small></div></div></td>' +
    '<td><span class="pill ' + (l.stage === 'NEW_ENQUIRY' ? 'red' : l.stage === 'WON' ? 'green' : l.stage === 'LOST' ? '' : 'amber') + '">' + heat + '</span></td>' +
    '<td>' + leadHeatHtml(l.stage, l.monthlyRate) + '</td>' +
    '<td' + (intentTip ? ' title="' + escapeHtml(intentTip) + '"' : '') + '>' + escapeHtml(l.size || '—') + (l.branchCode ? ' · ' + escapeHtml(l.branchCode) : '') + (l.unitCode ? ' · ' + escapeHtml(l.unitCode) : '') + '</td>' +
    '<td><span class="channel">' + (l.source ? l.source.charAt(0) : 'W') + '</span></td>' +
    '<td>' + nextActionLabel(l) + '</td>' +
    '<td><b>' + (l.monthlyRate ? '$' + (l.monthlyRate).toLocaleString() : '—') + '</b></td>' +
    '<td><small>' + fmtDayLead(l.createdAt) + '</small></td>' +
    '<td class="unit-actions"><button class="act-btn" data-act="edit" data-lead-id="' + escapeHtml(l.id) + '">Edit</button> <button class="act-btn danger" data-act="delete" data-lead-id="' + escapeHtml(l.id) + '">Delete</button></td></tr>';
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
    '<span class="pill ' + (STAGE_TONE[s] || '') + '">' + escapeHtml(STAGE_LABEL[s] || s) + '</span>',
  ).join(' ');
}

export function groupRowHtml(g, expanded) {
  const initial = String(g.emailDisplay || '?').charAt(0).toUpperCase();
  const countBadge = ' <span class="pill blue" title="Click to expand the enquiry timeline">' +
    escapeHtml(String(g.count)) + ' ' + (g.count === 1 ? 'enquiry' : 'enquiries') + '</span>';
  const variance = g.phoneVariance
    ? ' <span class="pill amber" title="Enquiries in this group used different phones — linked automatically, never blocked. Expand to see which rows differ.">⚠ phones differ</span>'
    : '';
  const names = (g.names || []).slice(0, 3).join(', ') + ((g.names || []).length > 3 ? ' +' + ((g.names || []).length - 3) + ' more' : '');
  const phones = (g.phones || []).join(' · ') || '—';
  return '<tr data-group-key="' + escapeHtml(g.groupKey) + '" tabindex="0" title="Click to ' + (expanded ? 'collapse' : 'expand') + ' the enquiry timeline">' +
    '<td><b>' + (expanded ? '▾' : '›') + '</b></td>' +
    '<td><div class="contact"><div class="avatar">' + escapeHtml(initial) + '</div><div><b>' + escapeHtml(g.emailDisplay) + '</b>' + countBadge + variance + '<small>' + escapeHtml(names || (g.email == null ? 'Phone-only group' : '—')) + '</small></div></div></td>' +
    '<td>' + (groupStagePills(g) || '—') + '</td>' +
    '<td>—</td>' +
    '<td><small>' + escapeHtml(phones) + '</small></td>' +
    '<td>—</td>' +
    '<td>—</td>' +
    '<td>—</td>' +
    '<td><small>' + escapeHtml(fmtDayLead(g.latestAt)) + '</small></td>' +
    '<td class="unit-actions"><button class="act-btn" data-group-act="toggle" data-group-key="' + escapeHtml(g.groupKey) + '">' + (expanded ? 'Collapse' : 'Expand') + '</button></td></tr>';
}

// ---------- toolbar controls (toggle + debounced email search) ----------
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
  input.setAttribute('aria-label', 'Search lead email groups');
  input.title = 'Searches email, normalized email and name across all time';
  input.style.maxWidth = '220px';
  src.after(input);
  let t = null;
  input.addEventListener('input', () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      state.leadGroupSearch = input.value;
      state.leadGroupPage = 1;
      state.leadGroupExpanded = null;
      onReload();
    }, 300);
  });
}

// ---------- email-mode render (fetch + rows + pager) ----------
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
  // The existing status/source selects compose server-side: groups having
  // >= 1 matching row list with their FULL content (see listLeadGroups).
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
    count.textContent = total + ' group' + (total === 1 ? '' : 's') +
      (q ? ' · “' + q + '”' : '') +
      ((state.leadStatusFilter || state.leadSourceFilter) ? ' · filtered' : '');
  }
  resetSelectAll('#leadRows');
  renderGroupPager(total);
  if (!groups.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="section-empty">No email groups match — adjust search or filters.<br><small>Contact-less rows (no email/phone) stay in the By-stage view.</small></div></td></tr>';
    return;
  }
  const html = [];
  for (const g of groups) {
    const expanded = state.leadGroupExpanded === g.groupKey;
    html.push(groupRowHtml(g, expanded));
    if (expanded) {
      const timeline = state.leadGroupTimelines[g.groupKey] || [];
      for (const t of timeline) html.push(leadRowHtml(t, timelineBadges(t)));
    }
  }
  tbody.innerHTML = html.join('');
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

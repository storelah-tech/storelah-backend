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
const money = (v) => (v == null ? '—' : '$' + Number(v).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const tipHtml = (text) => '<span class="v29-inline-tip"><span class="v29-tip-button" tabindex="0" aria-label="Definition">?</span><span class="v29-tooltip">' + escapeHtml(text) + '</span></span>';
function enquiryDay(v) {
  if (!v) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(v + 'T00:00:00Z') : new Date(v);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function fmtDayLead(d) {
  return d ? new Date(d).toLocaleDateString('en-SG', { day: '2-digit', month: 'short' }) : '—';
}

function leadHeatHtml(stage) {
  const heat = ['WON', 'PAID_BOOKING', 'PENDING_PAYMENT', 'PROPOSAL_SENT'].includes(stage) ? 5 :
    stage === 'VIEWING_BOOKED' ? 4 : stage === 'QUALIFIED' ? 3 : stage === 'CONTACTED' ? 3 : stage === 'NEW_ENQUIRY' ? 2 : 1;
  let html = '<div class="heat" aria-label="Intent ' + heat + ' of 5">';
  for (let i = 0; i < 5; i++) html += '<i' + (i < heat ? ' class="on"' : '') + '></i>';
  return html + '</div>';
}

function nextActionLabel(l) {
  if (l.nextActionAt) return 'Due ' + fmtDayLead(l.nextActionAt);
  if (l.owner) return escapeHtml(l.owner);
  return '<small>' + (l.stage === 'NEW_ENQUIRY' ? 'Needs contact' : 'Follow-up') + '</small>';
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
  const flag = l.stage === 'NEW_ENQUIRY' ? ['blue', 'New enquiry'] : l.stage === 'LOST' ? ['red', escapeHtml(l.lossReason || 'Lost')] : l.stage === 'WON' ? ['green', 'Customer'] : l.nextActionAt && new Date(l.nextActionAt) < new Date() ? ['red', 'Follow-up overdue'] : ['grey', 'In progress'];
  const probTip = 'Stage probability starts at ' + l.probability + '% for ‘' + label + '’. The production score then applies capped signals: complete qualification +10, confirmed viewing +5, quote viewed +5, booking started +15, first-response SLA breach −5 and no activity for 7+ days −10. The result is capped between 0% and 100% and remains explainable in the audit trail.';
  return '<tr data-lead-id="' + escapeHtml(l.id) + '" tabindex="0"><td><input class="check" type="checkbox" aria-label="Select ' + escapeHtml(display) + '"></td>' +
    '<td><div class="contact"><div class="avatar">' + escapeHtml(initial) + '</div><div><button class="v2-name" type="button">' + escapeHtml(display) + '</button>' + extras + '<small>' + sub + '</small><span class="pill ' + (business ? 'blue' : 'grey') + '">' + (business ? 'Business' : 'Personal') + '</span></div></div></td>' +
    '<td><b>' + escapeHtml(enquiryDay(l.enquiryDate)) + '</b><small>Enquiry opened</small></td>' +
    '<td><span class="pill ' + (STAGE_TONE[l.stage] || 'grey') + '">' + escapeHtml(label) + '</span></td>' +
    '<td>' + leadHeatHtml(l.stage) + '</td>' +
    '<td><b>AC Self-Storage</b><br><small>' + escapeHtml(l.branchName ? 'StoreLah ' + l.branchName : 'No preference') + (l.size ? ' · ' + escapeHtml(l.size) : '') + '</small></td>' +
    '<td><span class="channel">' + escapeHtml(SOURCE_CODE[l.source] || 'W') + '</span> ' + escapeHtml(SOURCE_LABEL[l.source] || l.source || '') + '</td>' +
    '<td>' + escapeHtml(l.owner || 'Unassigned') + '</td>' +
    '<td>' + nextActionLabel(l) + '</td>' +
    '<td><b>' + money(l.potentialValue) + '</b><small>' + l.probability + '% probability ' + tipHtml(probTip) + '</small></td>' +
    '<td><span class="pill ' + flag[0] + '">' + flag[1] + '</span></td>' +
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
    '<span class="pill ' + (STAGE_TONE[s] || 'grey') + '">' + escapeHtml(STAGE_LABEL[s] || s) + '</span>',
  ).join(' ');
}

export function groupRowHtml(g, expanded) {
  const initial = String((g.names || [])[0] || g.emailDisplay || '?').split(/\s+/).slice(0, 2).map((x) => x[0] || '').join('').toUpperCase();
  const countBadge = ' <span class="pill blue" title="Click to expand the enquiry timeline">' +
    escapeHtml(String(g.count)) + ' ' + (g.count === 1 ? 'enquiry' : 'enquiries') + '</span>';
  const variance = g.phoneVariance
    ? ' <span class="pill amber" title="Enquiries in this group used different phones — linked automatically, never blocked. Expand to see which rows differ.">⚠ phones differ</span>'
    : '';
  const names = (g.names || []).slice(0, 3).join(', ') + ((g.names || []).length > 3 ? ' +' + ((g.names || []).length - 3) + ' more' : '');
  const phones = (g.phones || []).join(' · ') || '—';
  return '<tr data-group-key="' + escapeHtml(g.groupKey) + '" tabindex="0" title="Click to ' + (expanded ? 'collapse' : 'expand') + ' the enquiry timeline">' +
    '<td><b>' + (expanded ? '▾' : '›') + '</b></td>' +
    '<td><div class="contact"><div class="avatar">' + escapeHtml(initial) + '</div><div><b>' + escapeHtml(names || g.emailDisplay) + '</b>' + countBadge + variance + '<small>' + escapeHtml(g.email == null ? 'Phone-only identity' : g.emailDisplay) + ' · ' + escapeHtml(phones) + '</small></div></div></td>' +
    '<td><b>' + escapeHtml(fmtDayLead(g.latestAt)) + '</b><small>Latest enquiry</small></td>' +
    '<td>' + (groupStagePills(g) || '—') + '</td>' +
    '<td>—</td><td><b>AC Self-Storage</b></td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>' +
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
    tbody.innerHTML = '<tr><td colspan="12"><div class="section-empty">No email groups match — adjust search or filters.<br><small>Contact-less rows (no email/phone) stay in the By-stage view.</small></div></td></tr>';
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

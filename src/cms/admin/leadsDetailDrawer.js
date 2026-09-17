// StoreLah CMS admin UI — lead detail drawer: row-click → right sidebar with
// live lead detail (contact, source, stage/status, branch/facility, value,
// dates, notes/conversations, appointments, actions).
//
// Lead Database only; other tables are out of scope. Follows the existing
// *View.js pattern: one-way imports (views → state/api/dom/constants), the
// entry injects cross-cutting behaviour via setRefreshAll() and
// setLeadDrawerActions() because views must never import the entry module.
//
// Data sources (all existing reads, no new backend API):
// - Row itself: state.leadsCache (flat leads from the last GET /leads).
// - Conversations/notes: GET /conversations (+ row match on leadId), then
//   GET /conversations/:id/messages (timeline of messages + notes).
//   POST /conversations/:id/messages and .../notes for send/note; if the lead
//   has no thread yet, POST /conversations { leadId } creates one first.
// - Appointments: state.appointmentsCache when populated, else
//   GET /appointments, filtered client-side on leadId.
//
// Actions: stage change (PATCH /leads/:id, inline loss-reason select for
// LOST so no prompt() is needed), Edit (delegated to the entry's lead modal),
// Schedule (delegated to the entry's appointment modal), Convert (no backend
// convert endpoint exists — flagged gap, navigates to Customers), Delete
// (confirmDialog + DELETE /leads/:id, then refresh + close).

import { fmtDay, fmtMoney } from './constants.js';
import { $, escapeHtml, showBanner } from './dom.js';
import { get, post, patch, del, describeError, getCurrentUser } from './api.js';
import { confirmDialog } from './confirmDialog.js';
import { state } from './state.js';

// Post-mutation refresh hook — the entry hands down a wrapper that refreshes
// the leads table + pipeline + inbox (+ calendar for appointment changes).
let refreshAll = null;
export function setRefreshAll(fn) {
  refreshAll = fn;
}

// Entry-owned UI the drawer must not import (would cycle entry → view):
// onEditLead(id) opens the lead modal, onSchedule(lead) opens the appointment
// modal. Convert/Delete are owned here (navigate + confirmDialog + DELETE).
const entryActions = { onEditLead: null, onSchedule: null };
export function setLeadDrawerActions(actions) {
  if (actions && typeof actions.onEditLead === 'function') entryActions.onEditLead = actions.onEditLead;
  if (actions && typeof actions.onSchedule === 'function') entryActions.onSchedule = actions.onSchedule;
}

const STAGE_LABEL = {
  NEW_ENQUIRY: 'New',
  CONTACTED: 'Contacted',
  VIEWING_BOOKED: 'Qualified',
  PROPOSAL_SENT: 'Quoted',
  WON: 'Won',
  LOST: 'Lost',
};

const STAGE_TONE = {
  NEW_ENQUIRY: 'red',
  CONTACTED: 'amber',
  VIEWING_BOOKED: 'amber',
  PROPOSAL_SENT: 'amber',
  WON: 'green',
  LOST: '',
};

const STAGES = ['NEW_ENQUIRY', 'CONTACTED', 'VIEWING_BOOKED', 'PROPOSAL_SENT', 'WON', 'LOST'];

// Loss reasons mirror src/core/leads.ts LOSS_REASONS (server also defaults to
// "Unspecified", so this select only makes the choice explicit up-front).
const LOSS_REASONS = ['Price', 'Location', 'Timing', 'Competitor', 'No response', 'Unspecified'];

let openId = null;
let invoker = null;
let activeTab = 'details';
let wired = false;
let threadCache = { leadId: null, threadId: null, timeline: [], thread: null };
let apptsCache = { leadId: null, rows: [] };

function shell() {
  return {
    root: document.getElementById('leadDrawer'),
    overlay: document.getElementById('leadDrawerOverlay'),
    panel: document.getElementById('leadDrawerPanel'),
    close: document.getElementById('leadDrawerClose'),
    avatar: document.getElementById('leadDrawerAvatar'),
    title: document.getElementById('leadDrawerTitle'),
    sub: document.getElementById('leadDrawerSub'),
    body: document.getElementById('leadDrawerBody'),
  };
}

export function isLeadDrawerOpen() {
  const { root } = shell();
  return !!root && !root.hidden;
}

function findLeadById(id) {
  return (state.leadsCache || []).find((l) => l.id === id) || null;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-SG', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function contactLine(l) {
  const bits = [];
  if (l.email) bits.push(escapeHtml(l.email));
  if (l.mobile) bits.push(escapeHtml(l.mobile));
  return bits.length ? bits.join(' · ') : '—';
}

function infoRow(label, valueHtml) {
  return '<div class="info"><small>' + escapeHtml(label) + '</small><div>' + valueHtml + '</div></div>';
}

function detailsHtml(l) {
  const stagePill = '<span class="pill ' + (STAGE_TONE[l.stage] || '') + '">' + escapeHtml(STAGE_LABEL[l.stage] || l.stage) + '</span>';
  const value = l.monthlyRate != null ? '<b>' + escapeHtml(fmtMoney(l.monthlyRate)) + '</b>' : '—';
  const branch = escapeHtml(l.branchName || l.branchCode || '—') + (l.branchCode && l.branchName ? ' <small>(' + escapeHtml(l.branchCode) + ')</small>' : '');
  const lossRow = l.stage === 'LOST'
    ? infoRow('Loss reason', escapeHtml(l.lossReason || 'Unspecified') + (l.lossValue != null ? ' · ' + escapeHtml(fmtMoney(l.lossValue)) : ''))
    : '';
  return (
    '<div class="info-grid">' +
    infoRow('Contact', escapeHtml(l.name || '—') + '<br><small>' + contactLine(l) + '</small>') +
    infoRow('Type / segment', escapeHtml(l.type === 'BUSINESS' ? 'Business' : 'Personal') + (l.segment ? ' · ' + escapeHtml(l.segment) : '')) +
    infoRow('Source', escapeHtml(l.source || '—')) +
    infoRow('Stage / status', stagePill) +
    infoRow('Branch / facility', branch) +
    infoRow('Est. value', value) +
    infoRow('Preferred size', escapeHtml(l.size || '—')) +
    infoRow('Owner', escapeHtml(l.owner || 'Unassigned')) +
    infoRow('Next action', escapeHtml(l.nextActionAt ? fmtDateTime(l.nextActionAt) : 'Follow-up')) +
    infoRow('Created', escapeHtml(fmtDay(l.createdAt))) +
    lossRow +
    '</div>' +
    (l.note ? '<div class="rulebox" style="margin-top:12px"><b>Note:</b> ' + escapeHtml(l.note) + '</div>' : '') +
    '<div class="sec-hdr" style="margin-top:16px"><div><div class="sec-title">Stage</div><div class="sec-sub">Moves persist via PATCH /leads/:id</div></div></div>' +
    '<div class="form-grid"><div class="field"><label for="leadDrawerStage">Stage</label><select id="leadDrawerStage">' +
    STAGES.map((s) => '<option value="' + s + '"' + (s === l.stage ? ' selected' : '') + '>' + escapeHtml(STAGE_LABEL[s] || s) + '</option>').join('') +
    '</select></div>' +
    '<div class="field" id="leadDrawerLossWrap"' + (l.stage === 'LOST' ? '' : ' hidden') + '><label for="leadDrawerLoss">Loss reason</label><select id="leadDrawerLoss">' +
    LOSS_REASONS.map((r) => '<option value="' + escapeHtml(r) + '"' + (r === (l.lossReason || 'Unspecified') ? ' selected' : '') + '>' + escapeHtml(r) + '</option>').join('') +
    '</select></div></div>' +
    '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
    '<button class="act-btn primary" id="leadDrawerApplyStage" type="button">Apply stage</button>' +
    '</div>' +
    '<div class="sec-hdr" style="margin-top:16px"><div><div class="sec-title">Actions</div><div class="sec-sub">Edit, schedule, convert or delete this lead</div></div></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="act-btn" id="leadDrawerEdit" type="button">Edit</button>' +
    '<button class="act-btn" id="leadDrawerSchedule" type="button">Schedule</button>' +
    '<button class="act-btn" id="leadDrawerConvert" type="button">Convert</button>' +
    '<button class="act-btn danger" id="leadDrawerDelete" type="button">Delete</button>' +
    '</div>'
  );
}

function timelineHtml() {
  const items = threadCache.timeline || [];
  if (!items.length) return '<div class="section-empty">No messages or notes yet — send the first one below.</div>';
  return '<div class="timeline">' + items.map((it) => {
    if (it.kind === 'note') {
      return '<div class="timeitem"><b>📝 ' + escapeHtml(it.author || 'Note') + ' · ' + escapeHtml(fmtDateTime(it.at)) + '</b><p>' + escapeHtml(it.body) + '</p></div>';
    }
    const who = escapeHtml(it.sender || (it.direction === 'OUT' ? 'Operator' : 'Lead'));
    return '<div class="timeitem"><b>' + (it.direction === 'OUT' ? '↗ ' : '↙ ') + who + ' · ' + escapeHtml(fmtDateTime(it.at)) + '</b><p>' + escapeHtml(it.body) + '</p></div>';
  }).join('') + '</div>';
}

function conversationsHtml(l) {
  const t = threadCache.thread;
  const meta = t
    ? '<div class="rulebox"><b>Thread:</b> ' + escapeHtml(t.channel || '—') + (t.assignee ? ' · ' + escapeHtml(t.assignee) : ' · Unassigned') + ' · ' + escapeHtml(t.status || 'OPEN') + '</div>'
    : '<div class="rulebox"><b>No thread yet</b> — sending a message or note below creates one for this lead.</div>';
  void l;
  return (
    meta +
    '<div id="leadDrawerTimeline">' + timelineHtml() + '</div>' +
    '<div class="composer" style="border:1px solid var(--line);border-radius:11px;margin-top:12px"><textarea id="leadDrawerComposer" placeholder="Message ' + 'this lead… (prefix with /note for an internal note)"></textarea>' +
    '<div class="composer-foot"><small style="color:var(--muted)">Delivery is a recorded stub (see Conversations).</small><span style="display:flex;gap:8px"><button class="act-btn" id="leadDrawerSendNote" type="button">Save note</button><button class="act-btn primary" id="leadDrawerSendMsg" type="button">Send</button></span></div></div>'
  );
}

function appointmentsHtml() {
  const rows = apptsCache.rows || [];
  if (!rows.length) {
    return '<div class="section-empty">No appointments linked to this lead yet.</div>' +
      '<div style="display:flex;gap:8px"><button class="act-btn primary" id="leadDrawerSchedule2" type="button">＋ Schedule</button></div>';
  }
  return (
    '<div class="queue">' + rows.map((a) => {
      const when = fmtDateTime(a.startAt);
      const tone = a.status === 'CONFIRMED' || a.status === 'DONE' ? 'green' : a.status === 'PENDING' ? 'amber' : a.status === 'CANCELLED' ? 'red' : '';
      return '<div class="qitem"><div class="avatar">' + escapeHtml((a.personName || '?').charAt(0).toUpperCase()) + '</div><div><b>' +
        escapeHtml(a.title) + '</b><br><small>' + escapeHtml(when) + (a.branchCode ? ' · ' + escapeHtml(a.branchCode) : '') + (a.note ? ' · ' + escapeHtml(a.note) : '') +
        '</small></div><span class="pill ' + tone + '">' + escapeHtml(String(a.status || '').replace('_', ' ')) + '</span></div>';
    }).join('') + '</div>' +
    '<div style="display:flex;gap:8px;margin-top:12px"><button class="act-btn primary" id="leadDrawerSchedule2" type="button">＋ Schedule</button></div>'
  );
}

function paintTabs() {
  const root = shell().root;
  if (!root) return;
  root.querySelectorAll('[data-lead-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.leadTab === activeTab);
  });
}

function paintBody() {
  const { avatar, title, sub, body } = shell();
  const l = openId ? findLeadById(openId) : null;
  if (!l || !body) return;
  if (avatar) avatar.textContent = (l.name || '?').charAt(0).toUpperCase();
  if (title) title.textContent = l.name || 'Lead';
  if (sub) {
    sub.textContent = (STAGE_LABEL[l.stage] || l.stage) + ' · ' + (l.source || '') +
      (l.branchCode ? ' · ' + l.branchCode : '') +
      (l.monthlyRate ? ' · ' + fmtMoney(l.monthlyRate) : '');
  }
  if (activeTab === 'conversations') body.innerHTML = conversationsHtml(l);
  else if (activeTab === 'appointments') body.innerHTML = appointmentsHtml();
  else body.innerHTML = detailsHtml(l);
  paintTabs();
  wireBodyActions();
}

function setTab(tab) {
  activeTab = tab;
  paintBody();
}

async function ensureThread(leadId) {
  if (threadCache.leadId === leadId && threadCache.threadId) return threadCache.threadId;
  const threads = await get('/conversations').catch(() => []);
  const hit = (threads || []).filter((t) => t.leadId === leadId).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] || null;
  if (!hit) {
    threadCache = { leadId, threadId: null, timeline: [], thread: null };
    return null;
  }
  const data = await get('/conversations/' + encodeURIComponent(hit.id) + '/messages').catch(() => null);
  threadCache = {
    leadId,
    threadId: hit.id,
    thread: (data && data.conversation) || hit,
    timeline: (data && data.timeline) || [],
  };
  state.threads = threads || state.threads;
  return hit.id;
}

async function ensureAppointments(leadId) {
  if (apptsCache.leadId === leadId) return apptsCache.rows;
  let rows = state.appointmentsCache;
  if (!rows || !rows.length) {
    try {
      rows = await get('/appointments');
      state.appointmentsCache = rows || [];
    } catch (e) {
      rows = [];
    }
  }
  apptsCache = { leadId, rows: (rows || []).filter((a) => a.leadId === leadId) };
  return apptsCache.rows;
}

async function refreshDrawerData() {
  if (!openId) return;
  await Promise.all([ensureThread(openId).catch(() => null), ensureAppointments(openId).catch(() => [])]);
  if (isLeadDrawerOpen()) paintBody();
}

export async function openLeadDrawer(id, invokerEl) {
  const l = findLeadById(id);
  if (!l) {
    showBanner('Lead not found in list.');
    return;
  }
  // Only one drawer instance at a time: a single shell is re-populated.
  openId = id;
  invoker = invokerEl && document.contains(invokerEl) ? invokerEl : null;
  if (activeTab !== 'details' && activeTab !== 'conversations' && activeTab !== 'appointments') activeTab = 'details';
  const { root, close } = shell();
  if (!root) return;
  root.hidden = false;
  // Force reflow so the .open transition runs even on rapid re-opens.
  void root.offsetWidth;
  root.classList.add('open');
  document.body.classList.add('lead-drawer-open');
  paintBody();
  try {
    if (close) close.focus({ preventScroll: true });
  } catch (e) {
    try {
      if (close) close.focus();
    } catch (e2) { /* noop */ }
  }
  await refreshDrawerData();
}

export function closeLeadDrawer() {
  const { root } = shell();
  if (!root || root.hidden) {
    openId = null;
    return;
  }
  root.classList.remove('open');
  root.hidden = true;
  document.body.classList.remove('lead-drawer-open');
  openId = null;
  threadCache = { leadId: null, threadId: null, timeline: [], thread: null };
  apptsCache = { leadId: null, rows: [] };
  if (invoker && document.contains(invoker)) {
    try {
      invoker.focus({ preventScroll: true });
    } catch (e) {
      try {
        invoker.focus();
      } catch (e2) { /* noop */ }
    }
  }
  invoker = null;
}

async function applyStage() {
  const l = openId ? findLeadById(openId) : null;
  if (!l) return;
  const stageSel = document.getElementById('leadDrawerStage');
  const lossSel = document.getElementById('leadDrawerLoss');
  if (!stageSel) return;
  const stage = stageSel.value;
  if (!STAGES.includes(stage)) return;
  const body = { stage };
  if (stage === 'LOST') body.lossReason = (lossSel && lossSel.value) || l.lossReason || 'Unspecified';
  try {
    await patch('/leads/' + encodeURIComponent(l.id), body);
    try {
      if (refreshAll) await refreshAll();
    } catch (e) { /* refresh is best-effort */ }
    paintBody();
    await refreshDrawerData();
  } catch (err) {
    showBanner('Stage: ' + describeError(err));
  }
}

async function deleteCurrentLead() {
  const l = openId ? findLeadById(openId) : null;
  if (!l) return;
  const okConfirm = await confirmDialog({
    title: 'Delete lead ' + l.name + '?',
    message: 'This removes the lead and its conversation threads. Appointments keep their slot but lose the lead link.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!okConfirm) return;
  try {
    await del('/leads/' + encodeURIComponent(l.id));
    closeLeadDrawer();
    try {
      if (refreshAll) await refreshAll();
    } catch (e) { /* noop */ }
  } catch (err) {
    showBanner('Delete: ' + describeError(err));
  }
}

function convertCurrentLead() {
  const l = openId ? findLeadById(openId) : null;
  // Gap (live API truth): no POST /leads/:id/convert endpoint exists, so
  // conversion stays a manual operator step (create tenant/booking). Route
  // there instead of inventing schema.
  showBanner(l ? 'Convert is manual: create the tenant/booking for ' + l.name + ' under Customers.' : 'Convert is manual: create the tenant/booking under Customers.', true);
  closeLeadDrawer();
  try {
    const tab = document.querySelector('[data-tabs="customer"] [data-tab="customer-tenants"]');
    if (tab) tab.click();
    else if (window.location) window.location.hash = 'customers';
  } catch (e) { /* noop */ }
}

async function sendDrawerText(asNote) {
  const box = document.getElementById('leadDrawerComposer');
  const raw = box ? box.value.trim() : '';
  if (!raw) {
    showBanner('Type a message first.');
    return;
  }
  const l = openId ? findLeadById(openId) : null;
  if (!l) return;
  const isNote = asNote || raw.startsWith('/note ');
  const bodyText = isNote ? raw.replace(/^\/note\s+/, '').trim() : raw;
  if (!bodyText) {
    showBanner('Note is empty.');
    return;
  }
  try {
    let threadId = threadCache.threadId || (await ensureThread(l.id).catch(() => null));
    if (!threadId) {
      const created = await post('/conversations', { leadId: l.id });
      threadId = created && created.id;
    }
    if (!threadId) {
      showBanner('Could not open a thread for this lead.');
      return;
    }
    if (isNote) {
      await post('/conversations/' + encodeURIComponent(threadId) + '/notes', { body: bodyText });
    } else {
      await post('/conversations/' + encodeURIComponent(threadId) + '/messages', { body: bodyText });
    }
    if (box) box.value = '';
    threadCache.leadId = null; // force refetch of the timeline
    await ensureThread(l.id);
    try {
      if (refreshAll) await refreshAll();
    } catch (e) { /* noop */ }
    paintBody();
  } catch (err) {
    showBanner('Send: ' + describeError(err));
  }
}

function wireBodyActions() {
  const stageSel = document.getElementById('leadDrawerStage');
  if (stageSel) {
    stageSel.addEventListener('change', () => {
      const wrap = document.getElementById('leadDrawerLossWrap');
      if (wrap) wrap.hidden = stageSel.value !== 'LOST';
    });
  }
  document.getElementById('leadDrawerApplyStage')?.addEventListener('click', () => { applyStage().catch(() => {}); });
  document.getElementById('leadDrawerEdit')?.addEventListener('click', () => {
    const l = openId ? findLeadById(openId) : null;
    if (!l) return;
    if (entryActions.onEditLead) entryActions.onEditLead(l.id);
    else showBanner('Edit is unavailable here — use the table Edit button.');
  });
  const schedule = () => {
    const l = openId ? findLeadById(openId) : null;
    if (entryActions.onSchedule) entryActions.onSchedule(l);
    else showBanner('Schedule is unavailable here — use the Appointments page.');
  };
  document.getElementById('leadDrawerSchedule')?.addEventListener('click', schedule);
  document.getElementById('leadDrawerSchedule2')?.addEventListener('click', schedule);
  document.getElementById('leadDrawerConvert')?.addEventListener('click', convertCurrentLead);
  document.getElementById('leadDrawerDelete')?.addEventListener('click', () => { deleteCurrentLead().catch(() => {}); });
  document.getElementById('leadDrawerSendMsg')?.addEventListener('click', () => { sendDrawerText(false).catch(() => {}); });
  document.getElementById('leadDrawerSendNote')?.addEventListener('click', () => { sendDrawerText(true).catch(() => {}); });
}

export function wireLeadDrawer() {
  if (wired) return;
  wired = true;
  const { root, overlay, close } = shell();
  if (!root) return;
  root.querySelectorAll('[data-lead-tab]').forEach((b) => {
    b.addEventListener('click', () => setTab(b.dataset.leadTab));
  });
  if (close) close.addEventListener('click', closeLeadDrawer);
  // Backdrop click closes (X + backdrop + Escape are the three close paths).
  if (overlay) overlay.addEventListener('click', closeLeadDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isLeadDrawerOpen()) return;
    // The confirm dialog owns Escape while it is up (it halts the event in
    // the capture phase, so this bubble listener never fires for it).
    const confirm = document.getElementById('confirmModal');
    if (confirm && !confirm.hidden) return;
    e.stopPropagation();
    closeLeadDrawer();
  });
  void getCurrentUser;
}

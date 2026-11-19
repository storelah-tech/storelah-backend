// StoreLah CMS admin UI — Track A A7: move-outs, refunds & unit transfers.
//
// Canonical UI over the A3–A6 CMS routes (move-out cases, transfers,
// settlement finance, roll-up, rental status editor). UI calls ONLY those
// routes; every mutation is server-calculated and Finance-approved — the page
// never keys money directly.
//
// Entry points (handoff §8.1): customer profile → Move-out & transfers →
// Record move-out request; profile → More actions → Record move-out notice;
// Move-out notices → Record move-out request; Move-ins & move-outs queue.
// Button copy is handoff-verbatim (handoff wins on copy).
//
// States per §19: every panel renders loading → table, empty (handoff copy),
// error (message + Retry) and permission-denied; mutating buttons carry
// explicit data-perm so the access sweep hides what the role lacks.

import { escapeHtml as esc, showBanner } from './dom.js';
import { get, post, patch, put, can, describeError } from './api.js';
import { openModal, closeModal } from './leadsWorkspace.js';
import { confirmDialog } from './confirmDialog.js';
import { state } from './state.js';

const money = (v) => new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' }).format(Number(v) || 0);
const humanDate = (v) => {
  if (!v) return '—';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? v + 'T00:00:00Z' : v);
  return Number.isNaN(d) ? '—' : new Intl.DateTimeFormat('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
};
// A-8 timeline: every entry carries a real timestamp (date + time, SG). Never
// returns '—' — callers fall back to the case createdAt first.
const humanDateTime = (v) => {
  if (!v) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? v + 'T00:00:00Z' : v);
  if (Number.isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-SG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Singapore' }).format(d);
};
const notify = (m) => { if (typeof window.cmsToast === 'function') window.cmsToast(m); else showBanner(m); };
const goPage = (id) => window.StoreLahAdmin?.openPage?.(id);
const val = (id) => document.getElementById(id)?.value ?? '';
const sgToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Handoff §5 status contract.
const humanMoStatus = (s) => String(s ?? '').trim().replace(/_/g, ' ').toLowerCase().replace(/^\w/, (m) => m.toUpperCase()) || '—';
const CASE_PILL = {
  PENDING_MOVE_OUT: ['amber', 'Pending move-out'],
  AWAITING_INSPECTION: ['terra', 'Awaiting inspection'],
  SETTLEMENT_REVIEW: ['blue', 'Settlement review'],
  REFUND_PROCESSING: ['blue', 'Refund processing'],
  CHARGE_PROCESSING: ['blue', 'Charge processing'],
  COMPLETED: ['green', 'Completed'],
  REVERSED: ['grey', 'Reversed'],
};
const CASE_STATUSES = Object.keys(CASE_PILL);
export const casePill = (s) => { const p = CASE_PILL[s] || ['grey', humanMoStatus(s)]; return `<span class="pill ${p[0]}">${esc(p[1])}</span>`; };
export const humanMoStatusLabel = humanMoStatus;
/** Terracotta .pill.terra (dashboard.html ships no .pill.terra rule, so the
 * Awaiting-inspection pill would render unstyled without this; dashboard.html
 * stays frozen so the rule is injected here once, reusing its --terra vars). */
export function ensureMoPillStyle() {
  if (document.getElementById('moPillStyle')) return;
  const st = document.createElement('style');
  st.id = 'moPillStyle';
  st.textContent = '.pill.terra{background:var(--terra-light);color:var(--terra2)}';
  document.head.appendChild(st);
}

/** A-18: CMS toasts (.toast + .toast-v8 #toastEl) ship at z-index 100 in
 * dashboard.html, so validation toasts fired from inside a modal (every
 * move-out/refund/transfer/status/request dialog rides .v29-overlay at
 * z-index 500 via leadsWorkspace openModal) rendered UNDER the overlay and
 * failed submits showed nothing. dashboard.html stays frozen so the override
 * is injected here once, same pattern as ensureMoPillStyle — z-index 2500
 * clears every overlay in the shell (v29 500, v2 350, confirm 300,
 * modal-overlay/sl-overlay 200, drp-popup 250, fp menus/tips ≤2000) while
 * both toast rules keep pointer-events:none, so no floating element is
 * blocked or sits incorrectly under toasts. */
export function ensureMoToastStyle() {
  if (document.getElementById('moToastStyle')) return;
  const st = document.createElement('style');
  st.id = 'moToastStyle';
  st.textContent = '.toast,.toast-v8{z-index:2500!important}';
  document.head.appendChild(st);
}

const SETTLE_PILL = {
  PENDING: ['amber', 'Pending approval'],
  PENDING_APPROVAL: ['amber', 'Pending approval'],
  CHANGES_REQUESTED: ['red', 'Changes requested'],
  APPROVED: ['green', 'Approved'],
  PROCESSING: ['blue', 'Processing'],
  REFUNDED: ['green', 'Refunded'],
  POSTED: ['green', 'Posted'],
  FAILED: ['red', 'Failed'],
  CANCELLED: ['grey', 'Cancelled'],
  REJECTED: ['red', 'Rejected'],
};
export const settlePill = (s) => { const p = SETTLE_PILL[s] || ['grey', humanMoStatus(s)]; return `<span class="pill ${p[0]}">${esc(p[1])}</span>`; };

// Handoff §7 editable rental statuses.
const RENTAL_STATUSES = [
  ['ACTIVE', 'Active'],
  ['PENDING_MOVE_OUT', 'Pending move-out'],
  ['PAYMENT_ATTENTION', 'Payment attention'],
  ['ACCESS_RESTRICTED', 'Access restricted'],
  ['SUSPENDED', 'Suspended'],
  ['FORMER_CUSTOMER', 'Former customer'],
];
const RENTAL_STATUS_LABEL = Object.fromEntries(RENTAL_STATUSES);
/** A-6: canonical §5 human labels for every move-out/settlement state — text
 * copy must use this, never the humanized SNAKE fallback (which renders
 * "Pending move out" lower-case). Unknown values still humanize. */
const MO_TEXT = {
  ...RENTAL_STATUS_LABEL,
  ...Object.fromEntries(Object.entries(CASE_PILL).map(([k, v]) => [k, v[1]])),
  ...Object.fromEntries(Object.entries(SETTLE_PILL).map(([k, v]) => [k, v[1]])),
};
export const moStatusText = (s) => MO_TEXT[String(s ?? '').trim()] ?? humanMoStatus(s);

// Handoff §8.5 status meanings, one line each (A-5 register disclosure).
const CASE_DEFINITIONS = [
  ['Pending move-out', 'Request accepted and the final day is still ahead — the rental and access stay active until then.'],
  ['Awaiting inspection', 'The final day has arrived or passed — the unit cannot take a new customer until it is inspected.'],
  ['Settlement review', 'Inspection produced a refund or charge that Finance has not approved yet — no money has moved.'],
  ['Refund processing', 'Finance approved the refund and the processor has not confirmed it yet — the rental stays open until posting.'],
  ['Charge processing', 'Finance approved an additional charge and posting or payment is still pending — the rental stays open until posting.'],
  ['Completed', 'Access, inspection, settlement and unit release are all done — the rental is former with no future deduction.'],
  ['Reversed', 'The customer withdrew or the request was entered in error — the rental is Active again and the case stays in history.'],
];
const OPEN_CASE_STATUSES = ['PENDING_MOVE_OUT', 'AWAITING_INSPECTION', 'SETTLEMENT_REVIEW', 'REFUND_PROCESSING', 'CHARGE_PROCESSING'];

const MOVEOUT_CHANNELS = ['Customer portal', 'WhatsApp', 'Phone', 'Email', 'Onsite'];
const MOVEOUT_REASONS = ['No longer needs storage', 'Price', 'Relocation completed', 'Transferred to another provider', 'Service issue', 'Other'];
const RELEASE_STATUSES = [['READY', 'Ready for rental'], ['CLEANING_REQUIRED', 'Cleaning required'], ['MAINTENANCE_REQUIRED', 'Maintenance required'], ['BLOCKED', 'Blocked for investigation']];
const TRANSFER_CHANGE_CATEGORIES = ['Unit or transfer date', 'Pricing or promotion', 'Proration calculation', 'Security deposit', 'Protection Plan', 'Customer authorisation', 'Other'];
const MANUAL_REFUND_REASONS = [['duplicate-payment', 'Duplicate payment'], ['overcharge', 'Overcharge'], ['incorrect-deduction', 'Incorrect deduction'], ['billing-correction', 'Billing correction'], ['service-recovery', 'Service recovery'], ['other', 'Other documented exception']];
const RETURN_METHODS = [['ORIGINAL', 'Original payment method'], ['BANK', 'Bank transfer'], ['WALLET', 'Customer account credit']];

// Handoff §8.1 entry-point channels that staff can file under (portal is
// system-filed).
const STAFF_CHANNELS = ['WhatsApp', 'Phone', 'Email', 'Onsite'];

const COPY = {
  noCases: 'No move-out cases match these filters.',
  noRecords: 'No records match these filters.',
  noTransfers: 'No transfers match these filters.',
  approved: 'Approved; awaiting processor submission.',
  dateReason: 'A reason is required to change the move-out date.',
  inspectChecks: 'Complete all four release checks before submitting.',
  inspectNotes: 'Inspection notes or evidence are required.',
  refundAmount: 'Enter a refund amount greater than zero.',
  refundNotes: 'Notes and the refund basis are required.',
  refundSource: 'Link the source transaction or invoice for this billing refund.',
  statusSafeguard: 'Use the move-out workflow to schedule dates and settlement. A status change alone never creates a refund, ends access or releases a unit.',
  policyRule: 'Payments run on the first of each month. After move-out, unused storage rent is calculated using actual calendar days. Protection Plan paid for the month is always retained and never prorated.',
  denied: 'You can view this screen, but your role cannot use it. Ask an Owner or approver.',
};

const deniedHtml = (what) => `<div class="card"><div class="card-body"><div class="section-empty"><b>No access</b><span>${esc(what || COPY.denied)}</span></div></div></div>`;
const loadingHtml = (what) => `<div class="card"><div class="card-body"><div class="section-empty">${esc(what || 'Loading…')}</div></div></div>`;
const errorHtml = (message, retry) => `<div class="card"><div class="card-body"><div class="section-empty"><b>Couldn’t load.</b><span>${esc(message)}</span>${retry ? `<span style="margin-top:10px"><button class="btn" data-mo="retry">Retry</button></span>` : ''}</div></div></div>`;

/** Jump to the Finance register with a record pre-opened in the review drawer. */
export function openFinanceRecord(key) {
  try { sessionStorage.setItem('storelah.openRegister', key); } catch (e) { /* private mode */ }
  goPage('billing');
  setTimeout(() => document.querySelector('[data-tabs="billing"] [data-tab="bill-transactions"]')?.click(), 30);
}
export function openFinanceApprovalForSettlement(id) { openFinanceRecord(`settlement:${id}`); }
export function openMoveoutPolicy() {
  goPage('settings');
  setTimeout(() => document.querySelector('[data-tabs="settings"] [data-tab="settings-moveouts"]')?.click(), 30);
}

// ---------------------------------------------------------------------------
// Move-out notices register (NEW sidebar item, handoff §3 #moveout-notices)
// ---------------------------------------------------------------------------

const noticesState = { status: '', branchId: '', search: '' };
let noticesTimer = null;

function ensureMoveoutNoticesPage() {
  let page = document.getElementById('moveout-notices');
  if (!page) {
    page = document.createElement('section');
    page.id = 'moveout-notices';
    page.className = 'page';
    document.querySelector('.content')?.appendChild(page);
  }
  return page;
}

/** Canonical move-out cases register. Permission-gated on customer-moveouts:view. */
export async function bindMoveoutNoticesPage() {
  ensureMoPillStyle();
  const page = ensureMoveoutNoticesPage();
  // openPage() runs its lazy branch after the getElementById check, so the
  // first visit must activate the freshly created page itself.
  page.classList.add('active');
  if (!can('customer-moveouts:view')) { page.innerHTML = `<div class="head"><div><h1>Move-out notices</h1></div></div>` + deniedHtml(); return; }
  const branches = state.branches || [];
  page.innerHTML = `<div class="head"><div><h1>Move-out notices</h1><p>Every move-out request in one place — notice, inspection and Finance-approved settlement.</p></div><div class="actions"><button class="btn" data-mo="policy" type="button">Move-out policy</button><button class="primary" data-mo="record" data-perm="customer-moveouts:create" type="button">Record move-out request</button></div></div>
  <div class="modal-alert" id="moNoticesBanner" hidden></div>
  <details class="fm-details"><summary><b>What each move-out status means · Show definitions</b></summary><div class="fm-note" style="margin-top:10px">${CASE_DEFINITIONS.map(([s, d]) => `<div><b>${esc(s)}</b> — ${esc(d)}</div>`).join('')}</div></details>
  <div class="fm-kpis" id="moNoticesKpis"><div class="fm-kpi"><small>Open move-outs</small><strong>…</strong><span>Pending, awaiting inspection or in Finance review</span></div><div class="fm-kpi"><small>Awaiting inspection</small><strong>…</strong><span>Final day reached, unit held for inspection</span></div><div class="fm-kpi"><small>Finance review</small><strong>…</strong><span>Settlements awaiting Finance approval</span></div><div class="fm-kpi"><small>Notice policy</small><strong>…</strong><span>Minimum advance notice required</span></div><div class="fm-kpi"><small>Protection refund</small><strong>S$0.00</strong><span>Protection Plan is never prorated or refunded</span></div></div>
  <div class="tbl-card"><div class="sec-hdr"><div><div class="sec-title">Move-out cases</div><div class="sec-sub" id="moNoticesSub">Loading…</div></div></div>
  <div class="tbl-toolbar" style="flex-wrap:wrap"><input type="text" id="moNoticesSearch" class="tbl-search" placeholder="Search case, customer, unit…" value="${esc(noticesState.search)}" aria-label="Search move-out cases"><select id="moNoticesStatus" class="tbl-select" aria-label="Case status"><option value="">All statuses</option>${CASE_STATUSES.map((s) => `<option value="${s}" ${noticesState.status === s ? 'selected' : ''}>${CASE_PILL[s][1]}</option>`).join('')}</select><select id="moNoticesBranch" class="tbl-select" aria-label="Facility"><option value="">All facilities</option>${branches.map((b) => `<option value="${esc(b.id)}" ${noticesState.branchId === b.id ? 'selected' : ''}>StoreLah ${esc(b.name)}</option>`).join('')}</select></div>
  <div id="moNoticesTable"><div class="section-empty">Loading move-out cases…</div></div></div>`;
  page.querySelector('#moNoticesSearch')?.addEventListener('input', (e) => {
    clearTimeout(noticesTimer);
    noticesTimer = setTimeout(() => { noticesState.search = e.target.value.trim(); renderNoticesTable(); }, 300);
  });
  page.querySelector('#moNoticesStatus')?.addEventListener('change', (e) => { noticesState.status = e.target.value; renderNoticesTable(); });
  page.querySelector('#moNoticesBranch')?.addEventListener('change', (e) => { noticesState.branchId = e.target.value; renderNoticesTable(); });
  renderNoticesKpis();
  await renderNoticesTable();
}

/** A-5 KPI row: counts come from the unfiltered register (existing list
 * endpoint, no new route); the notice value comes from the moveout policy
 * (booking.moveOutNoticeDays) with a register-row fallback when the role
 * cannot read business rules. Protection refund is always S$0.00 (R9). */
async function renderNoticesKpis() {
  const host = document.getElementById('moNoticesKpis');
  if (!host) return;
  const kpi = (label, value, note) => `<div class="fm-kpi"><small>${esc(label)}</small><strong>${value}</strong><span>${esc(note)}</span></div>`;
  try {
    const [all, rules] = await Promise.all([
      get('/move-out-cases'),
      get('/business-rules').catch(() => null),
    ]);
    const rows = Array.isArray(all) ? all : all.rows || [];
    const open = rows.filter((c) => OPEN_CASE_STATUSES.includes(c.status)).length;
    const awaiting = rows.filter((c) => c.status === 'AWAITING_INSPECTION').length;
    const review = rows.filter((c) => c.status === 'SETTLEMENT_REVIEW').length;
    const ruleDays = Array.isArray(rules) ? rules.find((r) => r.key === 'booking.moveOutNoticeDays')?.value : null;
    const noticeDays = Number.isInteger(ruleDays) ? ruleDays : rows[0]?.noticeRequiredDays;
    host.innerHTML =
      kpi('Open move-outs', String(open), 'Pending, awaiting inspection or in Finance review') +
      kpi('Awaiting inspection', String(awaiting), 'Final day reached, unit held for inspection') +
      kpi('Finance review', String(review), 'Settlements awaiting Finance approval') +
      kpi('Notice policy', Number.isInteger(noticeDays) ? `${noticeDays} days` : '—', 'Minimum advance notice required') +
      kpi('Protection refund', 'S$0.00', 'Protection Plan is never prorated or refunded');
  } catch (e) {
    host.innerHTML =
      kpi('Open move-outs', '—', 'Pending, awaiting inspection or in Finance review') +
      kpi('Awaiting inspection', '—', 'Final day reached, unit held for inspection') +
      kpi('Finance review', '—', 'Settlements awaiting Finance approval') +
      kpi('Notice policy', '—', 'Minimum advance notice required') +
      kpi('Protection refund', 'S$0.00', 'Protection Plan is never prorated or refunded');
  }
}

async function renderNoticesTable() {
  const host = document.getElementById('moNoticesTable');
  const sub = document.getElementById('moNoticesSub');
  if (!host) return;
  host.innerHTML = '<div class="section-empty">Loading move-out cases…</div>';
  try {
    const q = new URLSearchParams();
    if (noticesState.status) q.set('status', noticesState.status);
    if (noticesState.branchId) q.set('branchId', noticesState.branchId);
    if (noticesState.search) q.set('search', noticesState.search);
    // List endpoints answer the envelope { data: rows } — a bare array.
    const data = await get('/move-out-cases' + (q.toString() ? '?' + q : ''));
    const rows = Array.isArray(data) ? data : data.rows || [];
    if (sub) sub.textContent = `${rows.length} case${rows.length === 1 ? '' : 's'}${noticesState.status || noticesState.search ? ' · filtered' : ''}`;
    if (!rows.length) { host.innerHTML = `<div class="section-empty">${esc(COPY.noCases)}</div>`; return; }
    // A-15: the notices table scrolls horizontally inside the card (same
    // .table-wrap pattern as the fixed Finance register) so the toolbar +
    // table fit a 375px viewport and action buttons never run past the card.
    host.innerHTML = `<div class="table-wrap"><table class="data-tbl" style="min-width:940px"><thead><tr><th>Case</th><th>Customer</th><th>Unit</th><th>Final access</th><th>Notice</th><th>Est. rent refund</th><th>Inspection</th><th>Settlement</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((c) => {
      const u = c.unit || {};
      // A-5 inspection cell: completed state, or the Complete-inspection
      // action once the final day arrives — otherwise the pending state.
      const insp = c.inspection;
      const inspCell = insp
        ? `<span class="pill green">Completed</span><div class="t-type">${esc(insp.releaseLabel || humanMoStatus(insp.releaseStatus))}</div>`
        : c.status === 'AWAITING_INSPECTION'
          ? `<button class="act-btn primary" data-mo="inspect" data-id="${esc(c.id)}" data-case="${esc(c.caseNumber)}" data-perm="customer-moveouts:update">Complete inspection</button>`
          : (c.status === 'REVERSED' || c.status === 'COMPLETED' ? '<span class="t-type">—</span>' : '<span class="t-type">Pending final day</span>');
      return `<tr><td><b style="white-space:nowrap">${esc(c.caseNumber)}</b><div class="t-type">${esc(c.requestChannel || '')} · ${esc(humanDate(c.requestReceivedAt))}</div></td>` +
        `<td>${c.tenant?.id ? `<button class="v2-name" data-cust-open="${esc(c.tenant.id)}">${esc(c.tenant.name || '—')}</button>` : esc(c.tenant?.name || '—')}</td>` +
        `<td>${esc(u.unitName || u.unitCode || '—')}<div class="t-type">${esc(u.branchName || u.branchCode || '')}</div></td>` +
        `<td>${esc(humanDate(c.finalAccessDate))}<div class="t-type">access ends 11:59 PM</div></td>` +
        `<td>${c.noticeCompliant ? '<span class="pill green">Compliant</span>' : '<span class="pill amber">Short notice</span>'}<div class="t-type">${c.noticeDays ?? '—'} / ${c.noticeRequiredDays ?? '—'} days</div></td>` +
        `<td><b>${money(c.estimatedRentRefund ?? 0)}</b><div class="t-type">unused rent only</div></td>` +
        `<td>${inspCell}</td>` +
        `<td>${c.settlement ? `${esc(c.settlement.ref)}<div class="t-type">${settlePill(c.settlement.status)}</div>` : '<span class="t-type">—</span>'}</td>` +
        `<td>${casePill(c.status)}</td>` +
        `<td class="unit-actions"><button class="act-btn primary" data-mo-case="${esc(c.id)}" data-perm="customer-moveouts:view">Open case</button>` +
        (c.settlement ? ` <button class="act-btn" data-mo-approval="${esc(c.settlement.id)}" data-perm="bill-transactions:view">Open Finance approval</button>` : '') + `</td></tr>`;
    }).join('')}</tbody></table></div>`;
  } catch (e) {
    host.innerHTML = `<div class="section-empty"><b>Move-out cases failed to load.</b><span>${esc(describeError(e))}</span><span style="margin-top:10px"><button class="btn" data-mo="retry-notices">Retry</button></span></div>`;
  }
}

// ---------------------------------------------------------------------------
// Move-out case workspace (handoff §8.6)
// ---------------------------------------------------------------------------

function ensureMoveoutCasePage() {
  let page = document.getElementById('moveout-case');
  if (!page) {
    page = document.createElement('section');
    page.id = 'moveout-case';
    page.className = 'page';
    document.querySelector('.content')?.appendChild(page);
  }
  return page;
}

/** Full case workspace: status, dates, inspection, settlement, audit timeline. */
export async function openMoveOutCase(id) {
  ensureMoPillStyle();
  const page = ensureMoveoutCasePage();
  page.innerHTML = `<div class="head"><div><h1>Move-out case</h1></div></div>` + loadingHtml('Loading the case…');
  goPage('moveout-case');
  try {
    const c = await get(`/move-out-cases/${encodeURIComponent(id)}`);
    // A-8 defect 1: the pre-inspection workspace shows the same live server
    // preview as A-7 (GET /:id/preview — same engine, zero charges before
    // inspection). Viewers hold the view grant, so this never 403s for a
    // readable case; a failed preview falls back to the no-record copy.
    let preview = null;
    if (!c.settlement) {
      try { preview = await get(`/move-out-cases/${encodeURIComponent(id)}/preview`); } catch (e) { preview = null; }
    }
    page.innerHTML = casePageHtml(c, preview);
  } catch (e) {
    page.innerHTML = `<div class="head"><div><h1>Move-out case</h1></div><div class="actions"><button class="btn" data-mo="back-notices" type="button">← Move-out notices</button></div></div>` + errorHtml(describeError(e), true);
  }
}

function casePageHtml(c, preview) {
  const u = c.unit || {};
  const t = c.tenant || {};
  const s = c.settlement;
  const insp = c.inspection;
  const editable = can('customer-moveouts:update') && (c.status === 'PENDING_MOVE_OUT' || c.status === 'AWAITING_INSPECTION');
  const canInspect = can('customer-moveouts:update') && c.status === 'AWAITING_INSPECTION';
  return `<div class="head"><div><button class="v2-name" data-mo="back-notices">← Move-out notices</button><h1>${esc(c.caseNumber)}</h1><p>${esc(t.name || '')} · ${esc(u.unitName || u.unitCode || '')}${u.branchName ? ' · StoreLah ' + esc(u.branchName) : ''}</p></div><div class="actions">${casePill(c.status)}${s ? `<button class="primary" data-mo-approval="${esc(s.id)}" data-perm="bill-transactions:view" type="button">Open Finance approval</button>` : ''}</div></div>
  <div class="v2-profile-grid equal"><div class="v2-card"><div class="v2-card-head"><div><h3>Request</h3><p>Staff-entered or portal-filed move-out request.</p></div></div><div class="v2-card-body"><div class="v2-info"><div><small>Customer</small><b>${t.id ? `<button class="v2-name" data-cust-open="${esc(t.id)}">${esc(t.name || '—')}</button>` : esc(t.name || '—')}</b></div><div><small>Unit</small><b>${esc(u.unitName || u.unitCode || '—')}</b></div><div><small>Request received</small><b>${esc(humanDate(c.requestReceivedAt))}</b></div><div><small>Request channel</small><b>${esc(c.requestChannel || '—')}</b></div><div><small>Reason</small><b>${esc(c.reasonCode || '—')}</b></div>${c.requestNotes ? `<div><small>Customer message / staff note</small><b>${esc(c.requestNotes)}</b></div>` : ''}</div></div></div>
  <div class="v2-card"><div class="v2-card-head"><div><h3>Final access &amp; notice</h3><p>Access stays valid through 11:59 PM on the final day.</p></div>${editable ? `<button class="btn" data-mo="date-change" data-id="${esc(c.id)}" data-perm="customer-moveouts:update" type="button">Change move-out date</button>` : ''}</div><div class="v2-card-body"><div class="v2-info"><div><small>Final access day</small><b>${esc(humanDate(c.finalAccessDate))}</b></div><div><small>Access cut-off</small><b>${esc(c.accessCutoff || 'Access ends 11:59 PM')}</b></div><div><small>Notice days</small><b>${c.noticeDays ?? '—'} / required ${c.noticeRequiredDays ?? '—'}</b></div><div><small>Compliance</small><b>${c.noticeCompliant ? 'Compliant' : 'Short notice'}</b></div>${c.commitmentEnd ? `<div><small>Commitment ends</small><b>${esc(humanDate(c.commitmentEnd))}</b></div>` : ''}<div><small>Deposit held</small><b>${money(0)}</b></div></div>${editable ? '' : '<p class="v29-help">Date changes close once inspection is complete.</p>'}</div></div></div>
  <div class="v2-card" style="margin-top:14px"><div class="v2-card-head"><div><h3>Inspection &amp; release</h3><p>All four release checks plus notes/evidence are mandatory before settlement.</p></div>${canInspect ? `<button class="primary" data-mo="inspect" data-id="${esc(c.id)}" data-perm="customer-moveouts:update" type="button">Complete inspection</button>` : ''}${editable ? `<button class="btn" data-mo="reverse" data-id="${esc(c.id)}" data-perm="customer-moveouts:update" type="button">Reverse request</button>` : ''}</div><div class="v2-card-body">${inspectionPanelHtml(c, insp, canInspect)}</div></div>
  ${settlementCardHtml(c, preview)}
  ${timelineHtml(c)}`;
}

// A-8 defect 3: the "available on or after the final access day" guidance is
// a pre-final-day state only (SG calendar date, R3 derived-read logic: the
// final day has arrived when finalAccessDate <= SG today). On/after the final
// day the inspection action is the primary path — no stale blocking copy.
function inspectionPanelHtml(c, insp, canInspect) {
  if (insp) return inspectionHtml(insp);
  const finalYmd = String(c.finalAccessDate || '').slice(0, 10);
  if (finalYmd && finalYmd > sgToday()) {
    return '<div class="section-empty">Awaiting inspection — available on or after the final access day.</div>';
  }
  const cta = canInspect
    ? `<div style="margin-top:10px"><button class="primary" data-mo="inspect" data-id="${esc(c.id)}" data-perm="customer-moveouts:update" type="button">Complete inspection</button></div>`
    : '';
  return `<div class="v29-callout"><i>i</i><div><b>Final day reached — complete the inspection to calculate the settlement.</b>Unused rent, charges and credits are calculated at inspection and approved by Finance.</div></div>${cta || '<div class="section-empty" style="margin-top:10px">Awaiting inspection.</div>'}`;
}

function inspectionHtml(i) {
  const checks = [['unitEmpty', 'Unit is empty'], ['doorLockWallsFloorChecked', 'Door, lock, walls and floor checked'], ['accessRevoked', 'Access has been revoked'], ['releaseConfirmed', 'Unit release status confirmed']];
  return `<div class="v2-info">${checks.map(([k, l]) => `<div><small>${esc(l)}</small><b>${i[k] ? '✓ Done' : '—'}</b></div>`).join('')}<div><small>Release status</small><b>${esc(Object.fromEntries(RELEASE_STATUSES)[i.releaseStatus] || humanMoStatus(i.releaseStatus))}</b></div><div><small>Inspected by</small><b>${esc(i.inspector || i.createdBy || '—')}</b></div></div>
  <div class="v29-facts" style="margin-top:10px"><div><small>Damage</small><b>${money(i.damageCharge)}</b></div><div><small>Cleaning</small><b>${money(i.cleaningCharge)}</b></div><div><small>Disposal</small><b>${money(i.disposalCharge)}</b></div><div><small>Other</small><b>${money(i.otherCharge)}</b></div><div><small>Arrears</small><b>${money(i.arrearsAmount)}</b></div><div><small>Special credit</small><b>${money(i.specialCredit)}</b></div></div>
  ${i.notes ? `<p class="v29-help" style="margin-top:10px"><b>Evidence/notes:</b> ${esc(i.notes)}</p>` : ''}`;
}

function settlementCardHtml(c, preview) {
  const s = c.settlement;
  if (s) {
    const refund = Number(s.amount) <= 0;
    return `<div class="v2-card" style="margin-top:14px"><div class="v2-card-head"><div><h3>Settlement · ${esc(s.ref)}</h3><p>System-calculated from the inspected case — never keyed by hand.</p></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">${settlePill(s.status)} <button class="primary" data-mo-approval="${esc(s.id)}" data-perm="bill-transactions:view" type="button">Open Finance approval</button></div></div><div class="v2-card-body">${settlementLinesHtml(s)}<div class="v30-outcome ${refund ? 'refund' : 'charge'}"><span>${refund ? 'Refund to customer' : 'Additional charge'}</span><b>${money(Math.abs(Number(s.amount)))}</b><small>${refund ? 'Credit/refund is not processed until Finance approval.' : 'The charge is not created or collected until Finance approval.'}</small></div></div></div>`;
  }
  // A-8 defect 1: pre-inspection estimate — the same live server preview as
  // A-7 (GET /:id/preview, zero charges before inspection). Shown only while
  // the case is open and uninspected; a zero-close COMPLETED case or a failed
  // preview falls back to the no-record copy below.
  const calc = preview?.calc;
  if (calc && !c.inspection && OPEN_CASE_STATUSES.includes(c.status)) {
    const net = Number(calc.netSettlement ?? 0);
    const outcome = net >= 0
      ? `<div class="v30-outcome refund"><span>Estimated refund</span><b>${money(net)}</b><small>Unused rent only — the settlement is calculated at inspection and approved by Finance.</small></div>`
      : `<div class="v30-outcome charge"><span>Estimated additional charge</span><b>${money(-net)}</b><small>Unused rent only — the settlement is calculated at inspection and approved by Finance.</small></div>`;
    return `<div class="v2-card" style="margin-top:14px"><div class="v2-card-head"><div><h3>Settlement estimate</h3><p>Live server preview — the settlement is calculated at inspection and approved by Finance.</p></div></div><div class="v2-card-body">${settlementLinesHtml({ lines: calc.lines || [] })}${outcome}</div></div>`;
  }
  return `<div class="v2-card" style="margin-top:14px"><div class="v2-card-head"><div><h3>Settlement</h3><p>No Finance record yet — complete the inspection to calculate one.</p></div></div></div>`;
}

export function settlementLinesHtml(s) {
  if (!s.lines?.length) return '';
  return `<div class="v30-settlement"><table><thead><tr><th>System-calculated component</th><th>Basis</th><th>Amount</th></tr></thead><tbody>${s.lines.map((l) => `<tr><td>${esc(l.label)}</td><td>${esc(l.detail || '')}</td><td class="${Number(l.amount) < 0 ? 'negative' : ''}">${Number(l.amount) < 0 ? '−' : ''}${money(Math.abs(Number(l.amount)))}</td></tr>`).join('')}</tbody></table></div>`;
}

function timelineHtml(c) {
  // A-8 defect 2: newest first, every entry with a real timestamp + actor.
  // Inspection/settlement rows previously read createdAt/requestedBy fields
  // the detail payload never carried (→ '—'); the payload now carries them
  // and each row still falls back to the case createdBy/createdAt — a legacy
  // event with neither renders 'System', never '—'. Sorting is numeric
  // (Date-string lexical compare mis-ordered the old list).
  const atOf = (v, fb) => {
    const t = new Date(v ?? fb ?? c.createdAt).getTime();
    return Number.isNaN(t) ? new Date(c.createdAt).getTime() : t;
  };
  const byOf = (v) => {
    const s = String(v ?? c.createdBy ?? '').trim();
    return s || 'System';
  };
  const events = [];
  events.push({ at: atOf(c.createdAt, c.createdAt), by: byOf(c.createdBy), text: `Move-out request recorded · final access ${humanDate(c.finalAccessDate)}` });
  for (const d of (c.dateChanges || [])) events.push({ at: atOf(d.createdAt, c.createdAt), by: byOf(d.actor), text: `Date changed ${humanDate(d.previousDate)} → ${humanDate(d.newDate)} · ${d.reason || ''}` });
  if (c.inspection) events.push({ at: atOf(c.inspection.completedAt || c.inspection.createdAt, c.createdAt), by: byOf(c.inspection.inspector), text: 'Inspection completed — settlement calculated' });
  if (c.settlement) events.push({ at: atOf(c.settlement.createdAt, c.createdAt), by: byOf(c.settlement.requestedBy), text: `Settlement ${c.settlement.ref} submitted for Finance approval` });
  if (c.reversedAt) events.push({ at: atOf(c.reversedAt, c.createdAt), by: byOf(c.reversedBy), text: `Request reversed · ${c.reversalReason || ''}` });
  events.sort((a, b) => b.at - a.at);
  return `<div class="v2-card" style="margin-top:14px"><div class="v2-card-head"><div><h3>Case timeline</h3><p>Newest first · every change is audit-logged with actor and time.</p></div></div><div class="v2-card-body"><div class="v2-timeline">${events.map((e) => `<div class="v2-event"><b>${esc(e.text)}</b><p>${esc(humanDateTime(new Date(e.at)))} · ${esc(e.by)}</p></div>`).join('') || '<div class="v2-event"><b>No events yet</b></div>'}</div></div></div>`;
}

// ---------------------------------------------------------------------------
// Record move-out request (handoff §8.1–§8.2, canonical POST /move-out-cases)
// ---------------------------------------------------------------------------
// A-7 request modal: separate Customer select (identity group by email) +
// Unit/rental select (ACTIVE rentals holding a unit only — unit-less tenants
// never appear). Final access defaults to request + notice days; a live
// notice banner + server-computed settlement preview (POST
// /move-out-cases/request-preview — the modal never keys or totals money)
// refresh on every input change.

const normEmail = (t) => String(t.email || '').trim().toLowerCase();

export async function openRecordRequest(prefill = {}) {
  let tenants = [];
  try { tenants = (await get('/tenants')) || []; } catch (e) { tenants = []; }
  const rows = Array.isArray(tenants) ? tenants : (tenants.items || []);
  // A-7: ACTIVE rentals holding a unit only. Unit-less tenants (former,
  // portal-only, never-moved-in) are excluded — recording against them 409s.
  const active = rows.filter((t) => t.status === 'ACTIVE' && (t.unit || t.unitName));
  const groups = new Map();
  for (const t of active) {
    const key = normEmail(t) || `id:${t.id}`;
    if (!groups.has(key)) groups.set(key, { key, name: t.name, email: t.email, rentals: [] });
    groups.get(key).rentals.push(t);
  }
  const customers = [...groups.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const preTenant = active.find((t) => t.id === prefill.tenantId) || null;
  const preKey = preTenant ? (normEmail(preTenant) || `id:${preTenant.id}`) : (customers[0]?.key || '');
  openModal({
    title: 'Record move-out request', kicker: 'CANONICAL MOVE-OUT FLOW · INSPECTION-GATED',
    body: `<div class="v29-callout"><i>i</i><div><b>Request first, settlement later</b>Recording the request moves the rental to Pending move-out (or Awaiting inspection once the final day arrives). The refund is calculated from the inspection — never keyed here.</div></div>
    <div class="v29-grid three"><label class="v29-field"><span>Customer *</span><select id="moCustomer">${customers.map((c) => `<option value="${esc(c.key)}" ${c.key === preKey ? 'selected' : ''}>${esc(c.name)}${c.email ? ' · ' + esc(c.email) : ''} · ${c.rentals.length} rental${c.rentals.length === 1 ? '' : 's'}</option>`).join('') || '<option value="">No active rentals</option>'}</select></label>
    <label class="v29-field"><span>Unit / rental *</span><select id="moTenant"></select></label>
    <label class="v29-field"><span>Request received *</span><input id="moReceived" type="date" value="${esc(prefill.requestReceivedAt || sgToday())}"></label>
    <label class="v29-field"><span>Customer’s final access day *</span><input id="moFinal" type="date" value="${esc(prefill.finalAccessDate || '')}"></label>
    <label class="v29-field"><span>Request channel *</span><select id="moChannel">${STAFF_CHANNELS.map((ch) => `<option>${ch}</option>`).join('')}</select></label>
    <label class="v29-field"><span>Reason *</span><select id="moReason">${MOVEOUT_REASONS.map((r) => `<option>${r}</option>`).join('')}</select></label>
    <label class="v29-field full"><span>Customer message / staff note</span><textarea id="moNotes" placeholder="Optional at request; retained in the case audit…"></textarea></label></div>
    <div id="moReqBanner" style="margin-top:12px"></div>
    <div id="moReqPreview" style="margin-top:12px"></div>
    <div id="moRecordError"></div>`,
    footer: '<button class="btn" data-lw="close">Cancel</button><button class="primary" data-mo="record-submit" data-perm="customer-moveouts:create">Record move-out request</button>',
    wide: true,
  });
  window.__moCustomers = customers;
  window.__moFinalTouched = !!prefill.finalAccessDate;
  window.__moPrefillTenant = preTenant ? preTenant.id : '';
  syncMoCustomerRentals();
  document.getElementById('moCustomer')?.addEventListener('change', () => { window.__moPrefillTenant = ''; syncMoCustomerRentals(); });
  document.getElementById('moTenant')?.addEventListener('change', () => refreshRequestPreview(false));
  let reqTimer = null;
  ['moReceived', 'moFinal'].forEach((id) => document.getElementById(id)?.addEventListener('change', (e) => {
    if (id === 'moFinal' && e.target.value) window.__moFinalTouched = true;
    clearTimeout(reqTimer);
    reqTimer = setTimeout(() => refreshRequestPreview(false), 250);
  }));
  // First paint: fill the default final day (request + notice days) unless a
  // portal/prefill date was supplied, then render banner + preview.
  refreshRequestPreview(true);
}

/** Repopulate the Unit/rental select for the chosen customer identity. */
function syncMoCustomerRentals() {
  const host = document.getElementById('moTenant');
  if (!host) return;
  const customers = window.__moCustomers || [];
  const group = customers.find((c) => String(c.key) === val('moCustomer')) || customers[0];
  const rentals = group?.rentals || [];
  const pre = window.__moPrefillTenant;
  const sel = rentals.find((t) => t.id === pre) || rentals[0];
  host.innerHTML = rentals.map((t) => `<option value="${esc(t.id)}" ${sel && t.id === sel.id ? 'selected' : ''}>${esc(t.unitName || t.unit || '')}${t.branchName ? ' · StoreLah ' + esc(t.branchName) : ''} · ${money(t.rate)}</option>`).join('') || '<option value="">No active rentals</option>';
  refreshRequestPreview(false);
}

/** Live banner + settlement preview, always server-computed (request-preview
 * endpoint). The modal never totals money itself. */
export async function refreshRequestPreview(applyDefault) {
  const banner = document.getElementById('moReqBanner');
  const host = document.getElementById('moReqPreview');
  if (!banner || !host) return;
  const tenantId = val('moTenant');
  if (!tenantId) { banner.innerHTML = ''; host.innerHTML = ''; return; }
  host.innerHTML = '<div class="section-empty">Calculating preview…</div>';
  try {
    const payload = { tenantId, requestReceivedAt: val('moReceived') || undefined };
    const finalV = val('moFinal');
    if (finalV) payload.finalAccessDate = finalV;
    const p = await post('/move-out-cases/request-preview', payload);
    if (applyDefault && !window.__moFinalTouched && p.defaultFinalAccessDate) {
      const fin = document.getElementById('moFinal');
      if (fin && !fin.value) fin.value = p.defaultFinalAccessDate;
    }
    const n = p.noticeDays ?? 0;
    const req2 = p.requiredNoticeDays ?? 0;
    banner.innerHTML = p.noticeCompliant
      ? `<div class="v29-callout"><i>i</i><div><b>Notice compliant — ${n} of ${req2} required days.</b>Recording moves the rental to Pending move-out.</div></div>`
      : `<div class="v29-callout warn"><i>!</i><div><b>Short notice — ${n} of ${req2} required days.</b>Unused rent is unaffected; only the deposit path is affected (S$0 held).</div></div>`;
    const calc = p.calc || {};
    const net = Number(calc.netSettlement ?? 0);
    const outcome = net >= 0
      ? `<div class="v30-outcome refund"><span>Estimated refund</span><b>${money(net)}</b><small>Unused rent only — the settlement is calculated at inspection and approved by Finance.</small></div>`
      : `<div class="v30-outcome charge"><span>Estimated additional charge</span><b>${money(-net)}</b><small>Unused rent only — the settlement is calculated at inspection and approved by Finance.</small></div>`;
    host.innerHTML = `${settlementLinesHtml({ lines: calc.lines || [] })}${outcome}` +
      (p.openCaseNumber ? `<div class="v29-callout warn" style="margin-top:12px"><i>!</i><div><b>${esc(p.openCaseNumber)} is already open for this rental.</b>Recording again will be rejected.</div></div>` : '');
  } catch (e) {
    banner.innerHTML = '';
    host.innerHTML = `<div class="v29-callout warn"><i>!</i><div><b>Check the inputs</b>${esc(describeError(e))}</div></div>`;
  }
}

async function submitRecordRequest(btn) {
  if (btn?.disabled) return;
  btn.disabled = true;
  try {
    const body = { tenantId: val('moTenant'), requestReceivedAt: val('moReceived'), finalAccessDate: val('moFinal'), requestChannel: val('moChannel'), reasonCode: val('moReason'), requestNotes: val('moNotes').trim() || null };
    if (!body.tenantId || !body.finalAccessDate) { notify('Choose the rental and the final access day.'); return; }
    const c = await post('/move-out-cases', body);
    closeModal();
    notify(`${c.caseNumber} recorded — rental is now ${c.status === 'AWAITING_INSPECTION' ? 'awaiting inspection' : 'pending move-out'}.`);
    openMoveOutCase(c.id);
  } catch (e) { notify(describeError(e)); } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// Change move-out date (handoff §8.7) — before/after preview, reason required
// ---------------------------------------------------------------------------

export async function openDateChange(caseId) {
  // A-12: the "Current" fields read the case's live values — the plain
  // preview first, the case detail as fallback — and every before/after
  // compare refreshes them from its `before` side (same server engine).
  let preview = null;
  try { preview = await get(`/move-out-cases/${encodeURIComponent(caseId)}/preview`); } catch (e) { notify(describeError(e)); return; }
  let detail = null;
  try { detail = await get(`/move-out-cases/${encodeURIComponent(caseId)}`); } catch (e) { detail = null; }
  const curDate = preview?.finalAccessDate ?? detail?.finalAccessDate;
  const curNet = preview?.calc?.netSettlement;
  // Preview is flat: { caseId, caseNumber, status, finalAccessDate, calc, … }.
  const settleNow = (net) => (net == null ? '—' : net > 0 ? `${money(net)} refund` : net < 0 ? `${money(-net)} additional charge` : 'S$0.00 — no settlement');
  openModal({
    title: `Change move-out date · ${preview.caseNumber}`, kicker: 'RECALCULATES NOTICE + SETTLEMENT ESTIMATE',
    body: `<div class="v29-grid"><label class="v29-field"><span>Current final access day</span><input id="moCurDate" value="${esc(humanDate(curDate))}" readonly></label><label class="v29-field"><span>Current estimated settlement</span><input id="moCurSettle" value="${esc(settleNow(curNet))}" readonly></label><label class="v29-field"><span>New final access day *</span><input id="moNewDate" type="date" value="${esc(String(curDate || '').slice(0, 10))}"></label><label class="v29-field full"><span>Reason for date change *</span><textarea id="moDateReason" placeholder="Required — kept in the case audit…"></textarea></label></div><div id="moDateCompare" style="margin-top:12px" aria-live="polite"></div><div class="v29-callout" style="margin-top:12px"><i>i</i><div><b>Changing the date recalculates notice + settlement.</b>The table above is calculated on the server for the picked date — notice days, compliance and the unused-rent estimate before vs after. Saving writes the change with its before/after calculation to the case history; the case keeps the policy it was requested under.</div></div>`,
    footer: '<button class="btn" data-lw="close">Cancel</button><button class="primary" data-mo="date-submit" data-id="' + esc(caseId) + '" data-perm="customer-moveouts:update">Change move-out date</button>',
    wide: true,
  });
  // Live server before/after compare as the new date is picked (debounced —
  // the modal never totals money client-side).
  const cmpEl = () => document.getElementById('moDateCompare');
  const renderCompare = (d) => {
    const el = cmpEl();
    if (!el) return;
    const row = (label, b, a, suffix = '') => `<tr><td>${label}</td><td>${b}</td><td>→</td><td><b>${a}${suffix}</b></td></tr>`;
    // A-6: the outcome reads as a §5 label, never the raw REFUND/CHARGE enum.
    const settle = (s) => (s.netSettlement > 0 ? `${money(s.netSettlement)} refund` : s.netSettlement < 0 ? `${money(-s.netSettlement)} additional charge` : 'S$0.00 — no settlement');
    const settleOutcome = (o) => (o === 'CHARGE' ? 'additional charge' : o === 'ZERO' ? 'zero settlement' : 'refund');
    // A-12: the compare's `before` side is the case's current values.
    const curDateEl = document.getElementById('moCurDate');
    if (curDateEl) curDateEl.value = humanDate(d.before.finalAccessDate);
    const curSetEl = document.getElementById('moCurSettle');
    if (curSetEl) curSetEl.value = settle(d.before);
    const flag = d.dateChangeAllowed ? '' : `<p class="v29-help">Date changes are currently disabled by policy — saving will be rejected.</p>`;
    el.innerHTML = `<div class="table-wrap"><table class="fm-table"><caption style="text-align:left;padding:6px 0"><b>Before / after · ${esc(humanDate(d.before.finalAccessDate))} → ${esc(humanDate(d.after.finalAccessDate))}</b></caption><thead><tr><th></th><th>Before</th><th></th><th>After</th></tr></thead><tbody>`
      + row('Notice days', `${d.before.noticeDays} / required ${d.before.noticeRequiredDays}`, `${d.after.noticeDays} / required ${d.after.noticeRequiredDays}`)
      + row('Compliance', d.before.noticeCompliant ? 'Compliant' : 'Short notice', d.after.noticeCompliant ? 'Compliant' : 'Short notice')
      + row('Unused rent estimate', money(d.before.unusedRentRefund), money(d.after.unusedRentRefund))
      + row('Settlement estimate', settle(d.before), `${settle(d.after)} (${settleOutcome(d.after.outcome)})`)
      + `</tbody></table></div>${flag}`;
  };
  const renderCompareError = (msg) => {
    const el = cmpEl();
    if (el) el.innerHTML = `<p class="v29-help">${esc(msg)}</p>`;
  };
  let dateTimer = null;
  let dateSeq = 0;
  const schedDatePreview = () => {
    clearTimeout(dateTimer);
    dateTimer = setTimeout(async () => {
      const picked = val('moNewDate').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(picked)) { renderCompareError('Pick a new final access day to see the before/after compare.'); return; }
      const at = ++dateSeq;
      try {
        const d = await get(`/move-out-cases/${encodeURIComponent(caseId)}/preview?finalAccessDate=${encodeURIComponent(picked)}`);
        if (at === dateSeq) renderCompare(d);
      } catch (e) { if (at === dateSeq) renderCompareError(describeError(e)); }
    }, 300);
  };
  document.getElementById('moNewDate')?.addEventListener('input', schedDatePreview);
  schedDatePreview();
}

async function submitDateChange(btn, caseId) {
  const reason = val('moDateReason').trim();
  if (!reason) { notify(COPY.dateReason); return; }
  if (btn?.disabled) return;
  btn.disabled = true;
  try {
    const { case: c, before, after } = await patch(`/move-out-cases/${encodeURIComponent(caseId)}/date`, { finalAccessDate: val('moNewDate'), reason });
    closeModal();
    notify(`Date changed ${humanDate(before?.finalAccessDate)} → ${humanDate(after?.finalAccessDate)}. Notice is now ${after?.noticeCompliant ? 'compliant' : 'short'}.`);
    openMoveOutCase(c.id);
  } catch (e) { notify(describeError(e)); } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// Reverse a move-out request (handoff §8.8) — reason required, case retained
// ---------------------------------------------------------------------------

export async function reverseCase(caseId, caseNumber) {
  const ok = await confirmDialog({ title: `Reverse ${caseNumber || 'this move-out request'}?`, message: 'The rental returns to Active. The case and its dates stay in audit history — nothing is deleted.', confirmLabel: 'Reverse request' });
  if (!ok) return;
  openModal({
    title: `Reverse request · ${caseNumber || ''}`, kicker: 'REASON IS MANDATORY',
    body: `<label class="v29-field full"><span>Reason for reversal *</span><textarea id="moReverseReason" placeholder="Customer withdrew, entered in error…"></textarea></label>`,
    footer: '<button class="btn" data-lw="close">Cancel</button><button class="primary" data-mo="reverse-submit" data-id="' + esc(caseId) + '" data-perm="customer-moveouts:update">Reverse request</button>',
  });
}

// ---------------------------------------------------------------------------
// Physical inspection (handoff §8.9) — four checks + notes, then settlement
// ---------------------------------------------------------------------------

export function openInspection(caseId, caseNumber) {
  ensureMoInspectionStyle();
  openModal({
    title: `Complete inspection · ${caseNumber || ''}`, kicker: 'MANDATORY BEFORE SETTLEMENT',
    body: `<div class="v29-callout"><i>i</i><div><b>Submitting the inspection calculates the settlement.</b>A refund, an additional charge, or a zero close. It creates exactly one Finance record unless the result is zero — the table below is a live server preview, never a hand total.</div></div>
    <div class="mo-insp-card"><input type="checkbox" id="moCheckEmpty"><div><b>Unit is empty</b><small>No goods, waste or customer locks remain in the unit.</small></div></div>
    <div class="mo-insp-card"><input type="checkbox" id="moCheckDoor"><div><b>Door, lock, walls and floor checked</b><small>Walk every surface; reference evidence in the notes for any charge below.</small></div></div>
    <div class="mo-insp-card"><input type="checkbox" id="moCheckAccess"><div><b>Access has been revoked</b><small>Customer and authorised-user credentials end with this case.</small></div></div>
    <div class="mo-insp-card"><input type="checkbox" id="moCheckRelease" aria-label="Unit release status confirmed"><div><b>Unit release status confirmed</b><small>Choose how the unit re-enters the letting pool — cleaning or maintenance opens a work order.</small><label class="v29-field" style="margin-top:8px"><span>Release status *</span><select id="moRelease">${RELEASE_STATUSES.map(([v2, l]) => `<option value="${v2}">${l}</option>`).join('')}</select></label></div></div>
    <div class="mo-insp-card"><div style="flex:1"><b>Inspection charges (SGD)</b><small>Typed amounts only change the live preview below — the settlement is calculated server-side at submit.</small><div class="mo-insp-charges"><label class="v29-field"><span>Early termination</span><input id="moEarlyTerm" type="number" min="0" step="0.01" value="0"></label><label class="v29-field"><span>Damage charge</span><input id="moDamage" type="number" min="0" step="0.01" value="0"></label><label class="v29-field"><span>Cleaning charge</span><input id="moCleaning" type="number" min="0" step="0.01" value="0"></label><label class="v29-field"><span>Disposal charge</span><input id="moDisposal" type="number" min="0" step="0.01" value="0"></label><label class="v29-field"><span>Outstanding balance / arrears</span><input id="moArrears" type="number" min="0" step="0.01" value="0"></label><label class="v29-field"><span>Other charge</span><input id="moOther" type="number" min="0" step="0.01" value="0"></label><label class="v29-field"><span>Approved special credit</span><input id="moCredit" type="number" min="0" step="0.01" value="0"></label></div></div></div>
    <div class="mo-insp-card"><div style="flex:1"><b>Inspection notes / evidence *</b><small>Required — reference evidence for any charge.</small><label class="v29-field" style="margin-top:8px"><span class="sr-only">Inspection notes</span><textarea id="moInspNotes" placeholder="Required — reference evidence for any charge…"></textarea></label></div></div>
    <div id="moInspPreview" style="margin-top:12px"></div>
    <div id="moInspError"></div>`,
    footer: '<button class="btn" data-lw="close">Cancel</button><button class="primary" data-mo="inspect-submit" data-id="' + esc(caseId) + '" data-perm="customer-moveouts:update">Complete inspection &amp; submit Finance</button>',
    wide: true,
  });
  // Live server preview, debounced while charges are typed (never a client total).
  let inspTimer = null;
  const schedPreview = () => {
    clearTimeout(inspTimer);
    inspTimer = setTimeout(() => refreshInspectionPreview(caseId), 300);
  };
  ['moEarlyTerm', 'moDamage', 'moCleaning', 'moDisposal', 'moArrears', 'moOther', 'moCredit'].forEach((id) => document.getElementById(id)?.addEventListener('input', schedPreview));
  refreshInspectionPreview(caseId);
}

/** Scoped modal styles (dashboard.html stays frozen — same inject-once
 * pattern as ensureMoPillStyle). Cards stack full-width; the charge grid
 * auto-fits so 375px viewports wrap to one column. */
export function ensureMoInspectionStyle() {
  if (document.getElementById('moInspStyle')) return;
  const st = document.createElement('style');
  st.id = 'moInspStyle';
  st.textContent = '.mo-insp-card{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line,#e5e0d8);border-radius:10px;padding:12px;margin-top:10px;background:var(--card,#fff)}'
    + '.mo-insp-card>input[type=checkbox]{width:18px;height:18px;margin-top:2px;flex:none}'
    + '.mo-insp-card b{display:block}.mo-insp-card small{display:block;color:var(--muted,#6b6259);margin-top:2px}'
    + '.mo-insp-card .v29-field{margin-top:0}.mo-insp-charges{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:10px}';
  document.head.appendChild(st);
}

/** Live settlement table for the inspection modal — always server-computed
 * (POST /:id/inspection-preview). Last-write-wins: a slow earlier response
 * never overwrites a newer one. */
export async function refreshInspectionPreview(caseId) {
  const host = document.getElementById('moInspPreview');
  if (!host) return;
  const seq = (window.__moInspSeq = (window.__moInspSeq || 0) + 1);
  host.innerHTML = '<div class="section-empty">Calculating preview…</div>';
  try {
    const num = (id) => Math.max(0, Number(val(id)) || 0);
    const p = await post(`/move-out-cases/${encodeURIComponent(caseId)}/inspection-preview`, {
      earlyTerminationCharge: num('moEarlyTerm'), damageCharge: num('moDamage'),
      cleaningCharge: num('moCleaning'), disposalCharge: num('moDisposal'), arrearsAmount: num('moArrears'),
      otherCharge: num('moOther'), specialCredit: num('moCredit'),
    });
    if (seq !== window.__moInspSeq || !document.getElementById('moInspPreview')) return;
    const calc = p.calc || {};
    const net = Number(calc.netSettlement ?? 0);
    const outcome = net >= 0
      ? `<div class="v30-outcome refund"><span>Estimated refund</span><b>${money(net)}</b><small>Live server preview — submitting the inspection calculates the settlement and sends it to Finance.</small></div>`
      : `<div class="v30-outcome charge"><span>Estimated additional charge</span><b>${money(-net)}</b><small>Live server preview — submitting the inspection calculates the settlement and sends it to Finance.</small></div>`;
    host.innerHTML = `${settlementLinesHtml({ lines: calc.lines || [] })}${outcome}`;
  } catch (e) {
    if (seq !== window.__moInspSeq || !document.getElementById('moInspPreview')) return;
    host.innerHTML = `<div class="v29-callout warn"><i>!</i><div><b>Preview unavailable — </b>${esc(describeError(e))}</div></div>`;
  }
}

async function submitInspection(btn, caseId) {
  const checks = ['moCheckEmpty', 'moCheckDoor', 'moCheckAccess', 'moCheckRelease'].map((id) => document.getElementById(id)?.checked);
  if (checks.some((c) => !c)) { notify(COPY.inspectChecks); return; }
  const notes = val('moInspNotes').trim();
  if (!notes) { notify(COPY.inspectNotes); return; }
  if (btn?.disabled) return;
  btn.disabled = true;
  try {
    const num = (id) => Math.max(0, Number(val(id)) || 0);
    const out = await post(`/move-out-cases/${encodeURIComponent(caseId)}/inspection`, {
      unitEmpty: true, doorLockWallsFloorChecked: true, accessRevoked: true, releaseConfirmed: true,
      releaseStatus: val('moRelease'), earlyTerminationCharge: num('moEarlyTerm'), damageCharge: num('moDamage'),
      cleaningCharge: num('moCleaning'), disposalCharge: num('moDisposal'), arrearsAmount: num('moArrears'),
      otherCharge: num('moOther'), specialCredit: num('moCredit'), notes,
    });
    closeModal();
    notify(out?.settlementRef ? `Inspection complete — ${out.settlementRef} is awaiting Finance approval.` : 'Inspection complete — zero settlement, rental closed.');
    openMoveOutCase(out?.case?.id || caseId);
  } catch (e) { notify(describeError(e)); } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// Moves queue for the customers Move-outs tab (§27: NO complete/cancel here —
// the D14-retired PATCH has no UI trigger; rows jump to the canonical case)
// ---------------------------------------------------------------------------

/** Reworked customers → Move-outs tab: canonical cases queue + record entry. */
export async function bindMovesQueue() {
  ensureMoPillStyle();
  const tb = document.getElementById('moveoutsBody');
  const sub = document.getElementById('moveoutsSub');
  if (!tb) return;
  if (!can('customer-moveouts:view')) { tb.innerHTML = '<tr><td colspan="7"><div class="section-empty">You can’t view move-outs with this role.</div></td></tr>'; return; }
  tb.innerHTML = '<tr><td colspan="7"><div class="section-empty">Loading move-out cases…</div></td></tr>';
  try {
    const data = await get('/move-out-cases');
    const rows = Array.isArray(data) ? data : data.rows || [];
    if (sub) sub.textContent = `${rows.length} canonical case${rows.length === 1 ? '' : 's'} · inspection-gated · Finance-approved settlement`;
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="7"><div class="section-empty">${esc(COPY.noCases)}</div></td></tr>`; return; }
    tb.innerHTML = rows.map((c) => {
      const u = c.unit || {};
      return `<tr><td><b>${esc(c.caseNumber)}</b><div class="t-type">${c.tenant ? esc(c.tenant.name || '') : ''}</div></td>` +
        `<td>${u.unitName || u.unitCode ? esc(u.unitName || u.unitCode) : '—'}<div class="t-type">${esc(u.branchName || u.branchCode || '')}</div></td>` +
        `<td><b>${esc(humanDate(c.finalAccessDate))}</b></td>` +
        `<td>${c.noticeCompliant ? '<span class="pill green">Compliant</span>' : '<span class="pill amber">Short</span>'}</td>` +
        `<td>${casePill(c.status)}</td>` +
        `<td class="unit-actions"><button class="act-btn primary" data-mo-case="${esc(c.id)}" data-perm="customer-moveouts:view">Open case</button>` +
        (c.settlement ? ` <button class="act-btn" data-mo-approval="${esc(c.settlement.id)}" data-perm="bill-transactions:view">Open Finance approval</button>` : '') +
        (!c.settlement && can('customer-moveouts:create') ? ` <button class="act-btn" data-mo="record">Record move-out request</button>` : '') + `</td></tr>`;
    }).join('');
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="7"><div class="section-empty">Move-outs failed to load: ${esc(describeError(e))} <button class="btn" data-mo="retry-queue" style="margin-top:8px">Retry</button></div></td></tr>`;
  }
}

// ---------------------------------------------------------------------------
// Change status (handoff §7) — per-rental editor, reason mandatory, guarded
// ---------------------------------------------------------------------------

export async function openChangeStatus(tenantId, rentals, currentStatus) {
  const options = (rentals || []).map((r) => `<option value="${esc(r.tenantId)}">${esc(r.unitCode || r.unitName || '')} · ${esc(RENTAL_STATUS_LABEL[r.status] || humanMoStatus(r.status))}</option>`).join('');
  openModal({
    title: 'Change status', kicker: 'PER-RENTAL · REASON MANDATORY',
    body: `<div class="v29-callout warn"><i>!</i><div><b>${esc(COPY.statusSafeguard)}</b></div></div>
    <div class="v29-grid"><label class="v29-field"><span>Rental / unit *</span><select id="csRental">${options || `<option value="${esc(tenantId)}">This rental</option>`}</select></label>
    <label class="v29-field"><span>New status *</span><select id="csStatus">${RENTAL_STATUSES.map(([v2, l]) => `<option value="${v2}">${l}</option>`).join('')}</select></label>
    <label class="v29-field full"><span>Reason for status change *</span><textarea id="csReason" placeholder="Saved in immutable audit history with actor and time…"></textarea></label></div>
    <div class="hint">Pending move-out and Former customer come only from the move-out workflow while the rental still holds a unit.</div>`,
    footer: '<button class="btn" data-lw="close">Cancel</button><button class="primary" data-mo="status-submit" data-perm="customer-tenants:update">Change status</button>',
  });
}

async function submitChangeStatus(btn) {
  const reason = val('csReason').trim();
  if (!reason) { notify('A reason is required to change the rental status.'); return; }
  if (btn?.disabled) return;
  btn.disabled = true;
  try {
    const out = await post(`/tenants/${encodeURIComponent(val('csRental'))}/status`, { status: val('csStatus'), reason });
    closeModal();
    notify(`Status is now ${RENTAL_STATUS_LABEL[out?.status] || humanMoStatus(out?.status || val('csStatus'))}. No refund, access change or release was made.`);
    document.dispatchEvent(new CustomEvent('storelah:profile-refresh'));
  // A-20: the server rejects workflow-only states (Pending move-out / Former
  // customer) while the rental holds a unit with a 409 carrying the §7
  // safeguard copy — surface it and keep the modal open so the operator sees it.
  } catch (e) { notify(describeError(e)); } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// Manual refund (handoff §10.2–§10.4, canonical POST /finance/settlements)
// ---------------------------------------------------------------------------

export async function openManualRefund(prefill = {}) {
  // A-22: customer select (identity group, name/email) scopes a rental/unit
  // select covering ACTIVE + FORMER rentals with unit codes — former
  // customers need refunds too. Selections map to the existing tenantId/unit
  // payload (handoff §10.3 validation + copy unchanged in submitManualRefund
  // and server-side).
  let tenants = [];
  try { tenants = (await get('/tenants')) || []; } catch (e) { tenants = []; }
  const rows = Array.isArray(tenants) ? tenants : (tenants.items || []);
  const groups = new Map();
  for (const t of rows) {
    const key = normEmail(t) || `id:${t.id}`;
    if (!groups.has(key)) groups.set(key, { key, name: t.name || '—', email: t.email || '', tenantIds: [], repId: t.id });
    const g = groups.get(key);
    g.tenantIds.push(t.id);
    if (!g.name || g.name === '—') g.name = t.name || g.name;
    if (!g.email) g.email = t.email || '';
  }
  const customers = [...groups.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const preGroup = customers.find((c) => c.tenantIds.includes(prefill.tenantId)) || null;
  const preKey = preGroup ? preGroup.key : (customers[0]?.key || '');
  openModal({
    title: 'Manual refund', kicker: 'BILLING EXCEPTIONS ONLY · APPROVAL REQUIRED',
    body: `<div class="v29-callout"><i>i</i><div><b>Move-out rent is not a manual-refund reason.</b>Use for duplicate payments, overcharges, incorrect deductions, billing corrections, service recovery and documented exceptions.</div></div>
    <div class="v29-grid"><label class="v29-field"><span>Customer *</span><select id="mrCustomer">${customers.map((c) => `<option value="${esc(c.key)}" ${c.key === preKey ? 'selected' : ''}>${esc(c.name)}${c.email ? ' · ' + esc(c.email) : ''} · ${c.tenantIds.length} rental${c.tenantIds.length === 1 ? '' : 's'}</option>`).join('') || '<option value="">No customers</option>'}</select></label>
    <label class="v29-field"><span>Rental / unit *</span><select id="mrRental"><option value="">Loading rentals…</option></select></label>
    <label class="v29-field"><span>Refund amount (SGD) *</span><input id="mrAmount" type="number" min="0.01" step="0.01" placeholder="0.00"></label>
    <label class="v29-field"><span>Refund reason *</span><select id="mrReason">${MANUAL_REFUND_REASONS.map(([v2, l]) => `<option value="${v2}">${l}</option>`).join('')}</select></label>
    <label class="v29-field"><span>Source transaction / invoice</span><input id="mrSource" placeholder="Required for duplicate/overcharge/correction"></label>
    <label class="v29-field"><span>Return method *</span><select id="mrMethod">${RETURN_METHODS.map(([v2, l]) => `<option value="${v2}">${l}</option>`).join('')}</select></label>
    <label class="v29-field full"><span>Reason, evidence and internal notes *</span><textarea id="mrNotes" placeholder="Cause, amount basis and evidence…"></textarea></label></div>`,
    footer: '<button class="btn" data-lw="close">Cancel</button><button class="primary" data-mo="refund-submit" data-perm="bill-transactions:create">Submit for approval</button>',
    wide: true,
  });
  window.__mrCustomers = customers;
  window.__mrPrefill = { tenantId: prefill.tenantId || '', unitId: prefill.unitId || '' };
  syncMrRentals();
  document.getElementById('mrCustomer')?.addEventListener('change', () => { window.__mrPrefill = null; syncMrRentals(); });
}

/** Repopulate the rental/unit select for the chosen customer identity from
 * the roll-up read model: active rentals + former rentals (unit codes). The
 * option value encodes tenantId|unitId — the exact §10.3 payload fields. */
async function syncMrRentals() {
  const host = document.getElementById('mrRental');
  if (!host) return;
  const customers = window.__mrCustomers || [];
  const group = customers.find((c) => String(c.key) === val('mrCustomer')) || customers[0];
  if (!group) { host.innerHTML = '<option value="">No customers</option>'; return; }
  host.innerHTML = '<option value="">Loading rentals…</option>';
  try {
    const rollup = await get(`/tenants/${encodeURIComponent(group.repId)}/rollup`);
    const act = rollup?.rentals || [];
    const prev = rollup?.previousRentals || [];
    const opts = [];
    for (const r of act) opts.push({ value: `${r.tenantId}|${r.unitId}`, label: `${r.unitCode} · Active${r.facility ? ' · ' + r.facility : ''}`, tenantId: r.tenantId, unitId: r.unitId });
    for (const p of prev) opts.push({ value: `${p.tenantId}|${p.unitId}`, label: `${p.unitCode} · Former customer${p.endedAt ? ' · ended ' + humanDate(p.endedAt) : ''}`, tenantId: p.tenantId, unitId: p.unitId });
    if (!opts.length) opts.push({ value: `${group.repId}|`, label: 'Customer account (no specific unit)' });
    const pre = window.__mrPrefill || {};
    let sel = opts[0];
    if (pre.tenantId || pre.unitId) {
      sel = opts.find((o) => (pre.tenantId ? o.tenantId === pre.tenantId : true) && (pre.unitId ? o.unitId === pre.unitId : true))
        || (pre.unitId ? opts.find((o) => o.unitId === pre.unitId) : null)
        || (pre.tenantId ? opts.find((o) => o.tenantId === pre.tenantId) : null)
        || opts[0];
    }
    host.innerHTML = opts.map((o) => `<option value="${esc(o.value)}" ${o === sel ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
  } catch (e) {
    host.innerHTML = '<option value="">Rentals failed to load</option>';
  } finally {
    window.__mrPrefill = null;
  }
}

async function submitManualRefund(btn) {
  const amount = Number(val('mrAmount'));
  if (!(amount > 0)) { notify(COPY.refundAmount); return; }
  const notes = val('mrNotes').trim();
  if (!notes) { notify(COPY.refundNotes); return; }
  const reasonCode = val('mrReason');
  const sourceRef = val('mrSource').trim() || null;
  if (['duplicate-payment', 'overcharge', 'incorrect-deduction', 'billing-correction'].includes(reasonCode) && !sourceRef) { notify(COPY.refundSource); return; }
  const rental = val('mrRental');
  const [selTenantId, selUnitId] = String(rental || '').split('|');
  if (btn?.disabled) return;
  btn.disabled = true;
  try {
    const out = await post('/finance/settlements', { tenantId: (selTenantId || '').trim(), unitId: (selUnitId || '').trim() || null, amount, reasonCode, sourceRef, returnMethod: val('mrMethod'), notes });
    closeModal();
    const s = out.settlement;
    notify(`${s.ref} submitted for approval. No money has been sent.`);
    openFinanceApprovalForSettlement(s.id);
  } catch (e) { notify(describeError(e)); } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// Transfer: preview → submit (handoff §11) — server-calculated, approval-gated
// ---------------------------------------------------------------------------

// A-23: a transfer source is never a rental that is already moving out.
// The modal lists only eligible rentals; a preselected pending-move-out
// rental falls back to the first eligible one. Pure (no DOM) so the
// API/e2e gate can pin the fallback without a browser.
const PENDING_SOURCE_STATUSES = new Set(['NOTICE', 'PENDING_MOVE_OUT']);
export function isTransferSourceEligible(u) {
  if (!u) return false;
  const s = String(u.status ?? '').trim().toUpperCase();
  const d = String(u.displayStatus ?? '').trim().toUpperCase();
  return !PENDING_SOURCE_STATUSES.has(s) && d !== 'PENDING_MOVE_OUT';
}
export function pickEligibleTransferSource(rentals, preferredUnitId) {
  const eligible = (rentals || []).filter(isTransferSourceEligible);
  if (!eligible.length) return { eligible, selectedIndex: -1, selected: null };
  const pref = String(preferredUnitId ?? '');
  let idx = pref ? eligible.findIndex((u) => String(u.unitId ?? u.id ?? '') === pref) : -1;
  if (idx < 0) idx = 0;
  return { eligible, selectedIndex: idx, selected: eligible[idx] };
}

export async function openTransferPreview(prefill = {}) {
  const allRentals = prefill.units?.length ? prefill.units : (prefill.unitId ? [prefill] : []);
  // (c) The source list excludes rentals pending move-out; a preselected
  // pending rental falls back to the first eligible rental.
  const picked = pickEligibleTransferSource(allRentals, prefill.unitId);
  const rentals = picked.eligible;
  const first = picked.selected || {};
  let units = [];
  try { units = (await get('/units?status=AVAILABLE&perPage=200')) || []; } catch (e) { units = []; }
  const list = Array.isArray(units) ? units : (units.items || []);
  const branchOf = (d) => d.branch?.name ?? d.branch?.code ?? d.facility ?? '';
  const facilities = [...new Map(list.filter((d) => d.branchId || branchOf(d)).map((d) => [String(d.branchId ?? branchOf(d)), branchOf(d) || 'Facility'])).entries()]
    .map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  const destOption = (d) => `<option value="${esc(d.id)}" data-branch="${esc(String(d.branchId ?? ''))}" data-gross="${Number(d.rate ?? d.monthlyRate) || 0}">${esc(d.name ?? d.unitCode)} · ${d.sqft} sq ft · ${money(d.rate ?? d.monthlyRate)}</option>`;
  openModal({
    title: 'Preview transfer', kicker: 'SOURCE STAYS ACTIVE UNTIL FINANCE POSTS',
    body: `<div class="v29-callout"><i>i</i><div><b>The transfer date drives the proration</b>The system credits unused source-unit rent and charges destination-unit rent for the same remaining days. Destination pricing and promotions take precedence. Protection Plan is never prorated.</div></div>
    ${rentals.length ? '' : '<div class="v29-callout warn"><i>!</i><div><b>No eligible rental</b>Every rental on this customer is pending move-out — finish or reverse the move-out before transferring.</div></div>'}
    <div class="v29-grid three"><label class="v29-field"><span>Current unit *</span><select id="trSource" ${rentals.length ? '' : 'disabled'}>${rentals.map((u, i) => `<option value="${i}" ${i === picked.selectedIndex ? 'selected' : ''}>${esc(u.unitName ?? u.unitCode)} · ${money(u.netRent)}</option>`).join('') || '<option value="">No eligible rental</option>'}</select></label>
    <label class="v29-field"><span>Current net monthly rent</span><input id="trSourceRent" value="${money(first.netRent)}" readonly></label>
    <label class="v29-field"><span>Transfer effective date *</span><input id="trDate" type="date" value="${esc(sgToday())}"></label>
    <label class="v29-field"><span>Destination facility *</span><select id="trFacility"><option value="">All facilities</option>${facilities.map((f) => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join('')}</select></label>
    <label class="v29-field"><span>Destination unit *</span><select id="trUnit"><option value="">Select destination unit…</option>${list.map(destOption).join('')}</select></label>
    <label class="v29-field"><span>Destination gross monthly rent</span><input id="trGross" readonly placeholder="Select a destination unit…"></label>
    <label class="v29-field"><span>Destination promotion (derived)</span><input id="trPromoInfo" readonly value="Select a destination unit…"></label>
    <label class="v29-field"><span>Destination Protection Plan</span><input id="trProt" type="number" min="0" step="0.5" value="${first.protectionMonthly ?? 12.5}"></label>
    <label class="v29-field"><span>Destination deposit</span><input id="trDeposit" type="number" min="0" step="0.01" value="0"></label>
    <label class="v29-field full"><span>Transfer reason</span><textarea id="trReason" placeholder="Upgrade, downsize, customer preference, operational move…"></textarea></label></div>
    <div class="v29-help">The promotion is read-only — it comes from the destination unit's active plan and recalculates when the destination changes. The server recomputes it on preview and posting.</div>
    <div id="trSummary"></div>`,
    footer: '<span class="hint">Nothing posts until Finance approves the transfer.</span><button class="btn" data-lw="close">Cancel</button><button class="btn" data-mo="transfer-calc">Recalculate</button><button class="primary" data-mo="transfer-submit" data-perm="customer-transfers:create">Submit to Finance</button>',
    wide: true,
  });
  const rentalsJson = rentals;
  const unitsJson = list;
  const syncSource = () => {
    const u = rentalsJson[Number(val('trSource')) || 0] || {};
    const rent = document.getElementById('trSourceRent');
    if (rent) rent.value = new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' }).format(Number(u.netRent) || 0);
    const prot = document.getElementById('trProt');
    if (prot && u.protectionMonthly != null) prot.value = u.protectionMonthly;
  };
  const syncDest = () => {
    const id = val('trUnit');
    const d = unitsJson.find((x) => String(x.id) === String(id));
    const gross = document.getElementById('trGross');
    if (gross) gross.value = d ? new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' }).format(Number(d.rate ?? d.monthlyRate) || 0) : '';
    const info = document.getElementById('trPromoInfo');
    if (info && !info.dataset.preview) info.value = d ? 'Calculating…' : 'Select a destination unit…';
    const fac = document.getElementById('trFacility');
    if (fac && d && fac.value && String(d.branchId ?? '') !== String(fac.value)) {
      // Destination picked outside the facility filter (e.g. pre-set) — keep
      // the unit; the filter only narrows future picks.
    }
  };
  const applyFacilityFilter = () => {
    const fac = val('trFacility');
    const host = document.getElementById('trUnit');
    if (!host) return;
    const prev = val('trUnit');
    const scoped = fac ? unitsJson.filter((d) => String(d.branchId ?? '') === String(fac)) : unitsJson;
    host.innerHTML = `<option value="">Select destination unit…</option>${scoped.map(destOption).join('')}`;
    if (prev && scoped.some((d) => String(d.id) === String(prev))) host.value = prev;
    syncDest();
    transferCalc(sourceTenantId());
  };
  document.getElementById('trSource')?.addEventListener('change', () => { syncSource(); transferCalc(sourceTenantId()); });
  document.getElementById('trFacility')?.addEventListener('change', applyFacilityFilter);
  ['trDate', 'trUnit'].forEach((id) => document.getElementById(id)?.addEventListener('change', () => { if (id === 'trUnit') syncDest(); transferCalc(sourceTenantId()); }));
  window.__moRentals = rentalsJson;
  syncDest();
}

function sourceTenantId() {
  const rentals = window.__moRentals || [];
  const u = rentals[Number(val('trSource')) || 0] || {};
  return u.tenantId || '';
}

function transferPayload(tenantId) {
  const rentals = window.__moRentals || [];
  const src = rentals[Number(val('trSource')) || 0] || {};
  // (a) The promotion is derived server-side from the destination unit — the
  // modal never sends a client promo/total.
  return {
    tenantId: tenantId || src.tenantId,
    toUnitId: val('trUnit'),
    effectiveDate: val('trDate'),
    destProtection: Number(val('trProt')) || 0,
    destDeposit: Number(val('trDeposit')) || 0,
    reason: val('trReason').trim() || null,
  };
}

export async function transferCalc(tenantId) {
  tenantId = tenantId || sourceTenantId();
  const host = document.getElementById('trSummary');
  if (!host) return;
  if (!val('trUnit') || !val('trDate')) {
    host.innerHTML = '';
    const info = document.getElementById('trPromoInfo');
    if (info) { info.dataset.preview = ''; info.value = val('trUnit') ? info.value : 'Select a destination unit…'; }
    return;
  }
  host.innerHTML = '<div class="section-empty">Calculating…</div>';
  try {
    const p = await post('/transfers/preview', transferPayload(tenantId));
    // (a/b) Gross (pre-promotion) + derived promotion (plan name + %) refresh
    // on every destination change, straight from the server preview.
    const gross = document.getElementById('trGross');
    if (gross && p.destRackGrossMonthly != null) gross.value = money(p.destRackGrossMonthly);
    const info = document.getElementById('trPromoInfo');
    if (info) {
      const pct = Number(p.destPromoPct) || 0;
      info.dataset.preview = '1';
      info.value = pct > 0 ? `${pct}%${p.destPromoPlan ? ` · ${p.destPromoPlan}` : ''}` : 'No active promotion — rack rate applies';
    }
    const net = Number(p?.netAdjustment ?? p?.amount ?? 0);
    host.innerHTML = `${settlementLinesHtml({ lines: p.lines || [] })}<div class="v30-outcome ${net <= 0 ? 'refund' : 'charge'}"><span>${net <= 0 ? 'Customer account credit' : 'Customer pays'}</span><b>${money(Math.abs(net))}</b><small>Source remains active — nothing posts until Finance approval.</small></div>`;
  } catch (e) {
    const info = document.getElementById('trPromoInfo');
    if (info) { info.dataset.preview = ''; info.value = 'Select a destination unit…'; }
    host.innerHTML = `<div class="v29-callout warn" style="margin-top:14px"><i>!</i><div><b>Check the inputs</b>${esc(describeError(e))}</div></div>`;
  }
}

async function submitTransfer(btn, tenantId) {
  if (!(window.__moRentals || []).length) { notify('No eligible rental — every rental is pending move-out.'); return; }
  if (!val('trUnit')) { notify('Choose the destination unit.'); return; }
  if (btn?.disabled) return;
  btn.disabled = true;
  try {
    const out = await post('/transfers', transferPayload(tenantId));
    closeModal();
    const s = out.settlement;
    openModal({
      title: `${s.ref} submitted for approval`, kicker: 'SOURCE REMAINS ACTIVE UNTIL APPROVAL',
      body: `<div class="v29-callout"><i>i</i><div><b>${esc(s.ref)} submitted for approval.</b> Source unit, access and billing stay unchanged until Finance posts the transfer.</div></div>`,
      footer: '<button class="btn" data-lw="close">Return to customer</button><button class="primary" data-mo="goto-approval" data-id="' + esc(s.id) + '" data-perm="bill-transactions:view">Open Finance approval</button>',
    });
  } catch (e) { notify(describeError(e)); } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// Finance change-requests queue card (rendered inside bill-transactions;
// pure HTML so financeWorkspace stays the only finance renderer)
// ---------------------------------------------------------------------------

/** Rows with status "Changes requested" from the live register, with jumps. */
export function changeRequestsCard(rows) {
  const items = (rows || []).filter((r) => r.status === 'Changes requested');
  if (!items.length) return '';
  return `<div class="card" style="margin-bottom:14px"><div class="card-head"><div><h3>Finance change requests</h3><small style="color:var(--muted)">Returned to Operations — correct and resubmit; nothing posts while listed here.</small></div><span class="pill red">${items.length} open</span></div><div class="table-wrap"><table class="fm-table"><thead><tr><th>Record</th><th>Customer / unit</th><th>Document</th><th>Amount</th><th>Requested by</th><th></th></tr></thead><tbody>${items.map((r) => `<tr><td><b>${esc(r.recordId)}</b></td><td>${r.tenantId ? `<button class="v2-name" data-cust-open="${esc(r.tenantId)}">${esc(r.customer)}</button>` : esc(r.customer)}<small style="display:block">${esc(r.unitName || r.unit || '—')}</small></td><td>${esc(r.docType)}</td><td><b>${r.amount < 0 ? '−' : ''}${money(Math.abs(r.amount))}</b></td><td>${esc(r.approver || '—')}</td><td><button class="${can('bill-transactions:approve') || can('bill-transactions:update') ? 'primary' : 'btn'}" data-fm-action="register-open" data-reg-key="${esc(r.key)}">Review</button></td></tr>`).join('')}</tbody></table></div></div>`;
}

// ---------------------------------------------------------------------------
// A-21: Finance change requests in the Operations queue (Customer › Move-ins
// & move-outs). The same returns Finance lists in its register are an
// Operations work item — this card surfaces every open return (transfers,
// move-out settlements, manual refunds) above the case queue so Operations
// sees it without opening Finance. Best-effort and permission-aware: each
// source is skipped silently when the role cannot read it (the assignee's
// notification queue and the Finance register still carry the item). Review
// reuses the existing data-mo-approval jump into the Finance review drawer.
// ---------------------------------------------------------------------------

/** Normalised open change-request row from the transfers / settlements lists. */
function opsChangeRequestRow(s) {
  const list = Array.isArray(s.changeRequests) ? s.changeRequests : [];
  const cr = list.find((c) => c.status === 'OPEN') || list[0] || {};
  return {
    id: s.id,
    ref: s.ref ?? '—',
    tenantId: s.tenantId ?? s.tenant?.id ?? null,
    customer: s.tenant?.name ?? s.customer ?? '—',
    unit: s.destUnit?.unitName ?? s.destUnit?.unitCode ?? s.unit?.unitName ?? s.unit?.unitCode ?? s.unitCode ?? '—',
    docType: s.docType ?? (s.kind === 'TRANSFER' ? 'Transfer approval' : 'Settlement'),
    category: cr.category ?? '—',
    reason: cr.reason ?? '',
    dueDate: cr.dueDate ? String(cr.dueDate).slice(0, 10) : null,
    assignee: cr.assigneeId ?? cr.assignTeam ?? null,
    requestedBy: cr.requestedBy ?? s.requestedBy ?? '—',
    requestedAt: cr.requestedAt ?? s.updatedAt ?? s.createdAt ?? '',
  };
}

function opsChangeRequestsCard(items) {
  if (!items.length) return '';
  return `<div class="card" style="margin-bottom:14px"><div class="card-head"><div><h3>Finance change requests</h3><small style="color:var(--muted)">Returned to Operations — correct and resubmit; nothing posts while listed here.</small></div><span class="pill red">${items.length} open</span></div><div class="table-wrap"><table class="fm-table"><thead><tr><th>Record</th><th>Customer / unit</th><th>What Operations must correct</th><th>Due</th><th>Requested by</th><th></th></tr></thead><tbody>${items.map((r) => `<tr><td><b>${esc(r.ref)}</b><small style="display:block">${esc(r.docType)}</small></td><td>${r.tenantId ? `<button class="v2-name" data-cust-open="${esc(r.tenantId)}">${esc(r.customer)}</button>` : esc(r.customer)}<small style="display:block">${esc(r.unit)}</small></td><td>${esc(r.category)}${r.reason ? ` — ${esc(String(r.reason).slice(0, 120))}` : ''}${r.assignee ? `<small style="display:block">Assigned: ${esc(String(r.assignee))}</small>` : ''}</td><td>${r.dueDate ? esc(humanDate(r.dueDate)) : '—'}</td><td>${esc(r.requestedBy)}</td><td><button class="act-btn primary" data-mo-approval="${esc(r.id)}" data-perm="bill-transactions:view">Review</button></td></tr>`).join('')}</tbody></table></div></div>`;
}

/** Loads open change requests into the Move-ins & move-outs queue (see above). */
export async function bindOpsChangeRequests() {
  const table = document.getElementById('moveoutsTable');
  if (!table || !can('customer-moveouts:view')) return;
  let host = document.getElementById('opsChangeRequests');
  if (!host) {
    host = document.createElement('div');
    host.id = 'opsChangeRequests';
    table.parentNode?.insertBefore(host, table);
  }
  // Transfers ride on customer-transfers:view (Operations-readable);
  // settlements ride on bill-transactions:view (Finance-readable). TRANSFER
  // rows are deduped out of the settlements response — /transfers is their
  // canonical Operations source.
  const settled = await Promise.allSettled([
    get('/transfers?status=CHANGES_REQUESTED'),
    get('/finance/settlements?status=CHANGES_REQUESTED'),
  ]);
  const rows = [];
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const list = Array.isArray(r.value) ? r.value : [];
    for (const s of list) {
      // TRANSFER rows are deduped out of the settlements response (i > 0) —
      // /transfers is their canonical Operations source.
      if (i > 0 && s.kind === 'TRANSFER') continue;
      rows.push(opsChangeRequestRow(s));
    }
  });
  // Dedupe by settlement id (both lists cover transfers for Finance roles).
  const seen = new Set();
  const unique = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  unique.sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')));
  host.innerHTML = opsChangeRequestsCard(unique);
}

// ---------------------------------------------------------------------------
// Settings › Move-outs & refunds (handoff §14 — the moveout.* rules surface)
// ---------------------------------------------------------------------------

const MOVEOUT_RULE_COPY = {
  'booking.moveOutNoticeDays': ['Required advance notice', 'Calendar days of notice a tenant must give before the last day. Used by every facility.'],
  'moveout.allowDateChange': ['Allow requested move-out date changes', 'Staff may change the final access date. Every change still requires a reason and recalculation.'],
  'moveout.shortNoticeForfeitDeposit': ['Short notice may forfeit deposit', 'A non-compliant notice forfeits the deposit. Affects the deposit only — never unused storage rent.'],
  'moveout.depositCollectionEnabled': ['Security deposit collection', 'Whether deposits are collected at all. Off at launch (S$0 everywhere); authoritative source is Fees & deposits.'],
  'moveout.inspectionRequired': ['Physical inspection required', 'Inspection is required before a settlement can be submitted and a unit released. Locked on.'],
  'moveout.approvalRole': ['Approval role', 'Who may approve refunds and charges: Administrator or Finance (any holder of Transactions approve) or Administrator only.'],
};
const MOVEOUT_RULE_ORDER = ['booking.moveOutNoticeDays', 'moveout.allowDateChange', 'moveout.shortNoticeForfeitDeposit', 'moveout.depositCollectionEnabled', 'moveout.inspectionRequired', 'moveout.approvalRole'];

let moveoutRulesDraft = {};
let moveoutRulesLoaded = false;

/** Inject the settings subtab + panel (dashboard.html stays frozen).
 * Injected unconditionally at wire time (pre-auth): visibility is owned by
 * the access sweep (data-perm + ALL_RESOURCES membership) and content is
 * re-gated at every bind, so a mid-session role still resolves correctly. */
export function injectMoveoutSettingsTab() {
  if (document.getElementById('settings-moveouts')) return;
  const tabs = document.querySelector('[data-tabs="settings"]');
  const btn = document.createElement('button');
  btn.dataset.tab = 'settings-moveouts';
  btn.setAttribute('data-perm', 'settings-moveouts:view');
  btn.textContent = 'Move-outs & refunds';
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-tabs="settings"] [data-tab]').forEach((x) => x.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('#settings > .module-panel').forEach((p) => p.classList.toggle('active', p.id === 'settings-moveouts'));
    bindMoveoutSettings().catch((e) => showBanner('Move-outs & refunds: ' + describeError(e)));
  });
  tabs?.appendChild(btn);
  const section = document.getElementById('settings');
  if (section && !document.getElementById('settings-moveouts')) {
    const panel = document.createElement('div');
    panel.className = 'module-panel';
    panel.id = 'settings-moveouts';
    panel.innerHTML = '<div class="sec-hdr"><div><div class="sec-title">Move-outs &amp; refunds</div><div class="sec-sub">Global notice, date-change, deposit and approval policy — snapshots at request time, never rewrites open cases</div></div><div class="sec-actions"><button class="tb-btn primary" id="moveoutRulesSaveBtn" data-perm="settings-moveouts:update" disabled>Save move-out policy</button></div></div><div class="fm-note" style="margin-bottom:12px"><b>Rule:</b> Payments run on the first of each month. After move-out, unused storage rent is calculated using actual calendar days. Protection Plan paid for the month is always retained and never prorated.</div><div id="moveoutRulesBody"><div class="section-empty">Loading move-out policy…</div></div>';
    section.appendChild(panel);
  }
  document.getElementById('moveoutRulesSaveBtn')?.addEventListener('click', () => saveMoveoutRules().catch(() => {}));
  document.getElementById('settings-moveouts')?.addEventListener('input', (e) => {
    const el = e.target.closest('[data-rule-key]');
    if (!el || el.classList.contains('sw')) return;
    moveoutRulesDraft[el.dataset.ruleKey] = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    const btn2 = document.getElementById('moveoutRulesSaveBtn');
    if (btn2) btn2.disabled = false;
  });
  // A-19: selects (approval role) fire `change` rather than `input` in some
  // browsers — without this the save button stays disabled after only a
  // select change and a second save is impossible.
  document.getElementById('settings-moveouts')?.addEventListener('change', (e) => {
    const el = e.target.closest('[data-rule-key]');
    if (!el || el.classList.contains('sw')) return;
    moveoutRulesDraft[el.dataset.ruleKey] = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    const btn2 = document.getElementById('moveoutRulesSaveBtn');
    if (btn2) btn2.disabled = false;
  });
  document.getElementById('settings-moveouts')?.addEventListener('click', (e) => {
    const sw = e.target.closest('.sw[data-rule-key]');
    if (!sw) return;
    const key = sw.dataset.ruleKey;
    if (key === 'moveout.inspectionRequired') { notify('Physical inspection is locked on — it cannot be disabled.'); return; }
    moveoutRulesDraft[key] = !moveoutRulesDraft[key];
    sw.classList.toggle('on', !!moveoutRulesDraft[key]);
    const btn2 = document.getElementById('moveoutRulesSaveBtn');
    if (btn2) btn2.disabled = false;
  });
}

export async function bindMoveoutSettings() {
  const body = document.getElementById('moveoutRulesBody');
  if (!body) return;
  if (!can('settings-moveouts:view')) { body.innerHTML = '<div class="section-empty">You can’t view move-out policy with this role.</div>'; return; }
  try {
    const rows = (await get('/business-rules')) || [];
    moveoutRulesDraft = {};
    for (const r of rows) if (MOVEOUT_RULE_ORDER.includes(r.key)) moveoutRulesDraft[r.key] = r.value;
    moveoutRulesLoaded = true;
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    body.innerHTML = MOVEOUT_RULE_ORDER.map((key) => {
      const [label, desc] = MOVEOUT_RULE_COPY[key];
      const r = byKey[key];
      const v2 = moveoutRulesDraft[key];
      const ctl = key === 'moveout.approvalRole'
        ? `<select class="tbl-select" data-rule-key="${esc(key)}" aria-label="${esc(label)}" ${can('settings-moveouts:update') ? '' : 'disabled'}><option value="ADMIN_OR_FINANCE" ${v2 === 'ADMIN_OR_FINANCE' ? 'selected' : ''}>Administrator or Finance</option><option value="ADMIN_ONLY" ${v2 === 'ADMIN_ONLY' ? 'selected' : ''}>Administrator only</option></select>`
        : typeof v2 === 'boolean'
          ? `<span class="sw${v2 ? ' on' : ''}" data-rule-key="${esc(key)}" role="switch" aria-checked="${!!v2}" aria-label="${esc(label)}" tabindex="0"><i></i></span>`
          : `<input type="number" class="set-input num" data-rule-key="${esc(key)}" aria-label="${esc(label)}" value="${esc(String(v2 ?? ''))}" ${can('settings-moveouts:update') ? '' : 'disabled'}>`;
      return `<div class="set-row"><div><b>${esc(label)}</b><small>${esc(desc)}${r?.customized ? '' : ' · default'}</small></div><div class="set-ctl">${ctl}</div></div>`;
    }).join('');
    const btn = document.getElementById('moveoutRulesSaveBtn');
    if (btn) btn.disabled = true;
  } catch (e) {
    body.innerHTML = '<div class="section-empty">Move-out policy failed to load: ' + esc(describeError(e)) + '</div>';
  }
}

// A-19: save-button state machine. The button is disabled with a "Saving…"
// label for the whole save, and the label is ALWAYS restored in `finally` —
// on success, on validation early-returns and on thrown errors (from the PUT
// or from the re-bind) — so a second save never needs a reload.
async function saveMoveoutRules() {
  const btn = document.getElementById('moveoutRulesSaveBtn');
  if (!moveoutRulesLoaded) {
    if (btn) btn.textContent = 'Save move-out policy';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  let savedOk = false;
  try {
    // Client-side guard mirroring the server rule (whole days, zero or more).
    // Runs inside try so the early return still hits `finally` below.
    const notice = moveoutRulesDraft['booking.moveOutNoticeDays'];
    if (notice !== undefined && (notice === '' || !Number.isInteger(Number(notice)) || Number(notice) < 0)) {
      notify('Required advance notice must be a whole number of days, zero or more.');
      return;
    }
    await put('/business-rules', moveoutRulesDraft);
    notify('Move-out policy saved — open cases keep the snapshot from request time.');
    await bindMoveoutSettings();
    savedOk = true;
  } catch (e) {
    notify(describeError(e));
  } finally {
    const b = document.getElementById('moveoutRulesSaveBtn') || btn;
    if (b) {
      b.textContent = 'Save move-out policy';
      // Success → clean draft, stay disabled until the next edit.
      // Failure (or a re-bind that threw) → re-enable for retry.
      b.disabled = savedOk ? true : false;
    }
  }
}

// ---------------------------------------------------------------------------
// Delegated events (wired once from admin.js wireEvents)
// ---------------------------------------------------------------------------

let wired = false;
export function wireMoveoutWorkspace() {
  if (wired) return;
  wired = true;
  // A-18: toast override is global (injected once at boot so every modal —
  // move-out/refund/transfer or otherwise — shows validation toasts).
  ensureMoToastStyle();
  document.addEventListener('click', (e) => {
    const approval = e.target.closest('[data-mo-approval]');
    if (approval) { e.preventDefault(); openFinanceApprovalForSettlement(approval.dataset.moApproval); return; }
    const kase = e.target.closest('[data-mo-case]');
    if (kase) { e.preventDefault(); openMoveOutCase(kase.dataset.moCase).catch((err) => notify(describeError(err))); return; }
    const el = e.target.closest('[data-mo]');
    if (!el || el.disabled) return;
    const a = el.dataset.mo;
    const H = {
      'record': () => openRecordRequest({}).catch((err) => notify(describeError(err))),
      'record-submit': () => submitRecordRequest(el),
      'policy': () => openMoveoutPolicy(),
      'back-notices': () => goPage('moveout-notices'),
      'open-register': () => goPage('moveout-notices'),
      'retry-notices': () => renderNoticesTable(),
      'retry-queue': () => bindMovesQueue(),
      'date-change': () => openDateChange(el.dataset.id).catch((err) => notify(describeError(err))),
      'date-submit': () => submitDateChange(el, el.dataset.id),
      'reverse': () => reverseCase(el.dataset.id, el.closest('.page')?.querySelector('h1')?.textContent).catch((err) => notify(describeError(err))),
      'reverse-submit': async () => {
        const reason = val('moReverseReason').trim();
        if (!reason) { notify('A reason is required to reverse the request.'); return; }
        el.disabled = true;
        try {
          await post(`/move-out-cases/${encodeURIComponent(el.dataset.id)}/reverse`, { reason });
          closeModal();
          notify('Request reversed — rental is Active again. The case stays in history.');
          openMoveOutCase(el.dataset.id);
        } catch (err) { notify(describeError(err)); } finally { el.disabled = false; }
      },
      'inspect': () => openInspection(el.dataset.id, el.dataset.case || el.closest('.page')?.querySelector('h1')?.textContent),
      'inspect-submit': () => submitInspection(el, el.dataset.id),
      'transfer-submit': () => submitTransfer(el),
      'transfer-calc': () => transferCalc(),
      'refund-submit': () => submitManualRefund(el),
      'status-submit': () => submitChangeStatus(el),
      'goto-approval': () => { closeModal(); openFinanceApprovalForSettlement(el.dataset.id); },
    };
    if (H[a]) { e.preventDefault(); Promise.resolve(H[a]()).catch((err) => notify(describeError(err))); }
  });
  // Customer-profile refresh hook (status editor + case actions re-render it).
  document.addEventListener('storelah:profile-refresh', () => {
    const id = document.getElementById('customer-profile')?.dataset?.tenantId;
    if (id) window.StoreLahCustomer?.openProfile?.(id, true);
  });
}

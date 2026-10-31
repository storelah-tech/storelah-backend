// StoreLah CMS admin UI — Arrears (spec §18). Phase 4 full content.
//
// The live overdue table bound by the legacy billing binding (bindBilling in
// admin.js) is left intact — this workspace prepends above it and never wipes
// it. Cases + the policy-gated recovery workflow (timings from Global
// Settings), late-fee waivers (approver-gated), and the termination stub
// (UNDECIDED — always reports the missing decision).

import {
  escapeHtml, finState, money, fmtDay, facilityOptions,
  renderLoading, renderDenied, renderError, canViewFin,
  journeyNavHtml, wireJourneyNav, getFinMount,
} from './financeShared.js';
import { get, post, describeError, can } from './api.js';

const PANEL = 'bill-arrears';
const STAGES = ['', 'OPEN', 'REMINDER', 'FORMAL_NOTICE', 'LATE_FEE_POSTED', 'RESTRICTED', 'RESOLVED'];

const viewState = { stage: '', cases: [], candidates: [], waivers: [] };

export async function bindFinanceArrearsView() {
  const host = getFinMount(PANEL);
  if (!host) return;
  if (!canViewFin(PANEL)) {
    renderDenied(host, PANEL);
    return;
  }
  renderLoading(host);
  try {
    await reload(host);
  } catch (e) {
    renderError(host, e);
    const retry = host.querySelector('[data-fin-retry]');
    if (retry) retry.addEventListener('click', () => bindFinanceArrearsView());
  }
}

async function reload(host) {
  const q = new URLSearchParams();
  if (finState.branchId) q.set('branchId', finState.branchId);
  if (viewState.stage) q.set('stage', viewState.stage);
  const qs = q.toString();
  const cq = new URLSearchParams();
  if (finState.branchId) cq.set('branchId', finState.branchId);
  const cqs = cq.toString();
  const wq = new URLSearchParams();
  if (finState.branchId) wq.set('branchId', finState.branchId);
  const wqs = wq.toString();
  const [cases, candidates, waivers] = await Promise.all([
    get(`/finance/arrears${qs ? `?${qs}` : ''}`),
    get(`/finance/arrears/candidates${cqs ? `?${cqs}` : ''}`),
    get(`/finance/arrears/waivers${wqs ? `?${wqs}` : ''}`),
  ]);
  viewState.cases = cases;
  viewState.candidates = candidates;
  viewState.waivers = waivers;
  renderArrears(host);
}

function stagePill(s) {
  const tone = s === 'RESOLVED' ? 'green' : (s === 'RESTRICTED' ? 'red' : 'amber');
  return `<span class="pill ${tone}">${escapeHtml(s)}</span>`;
}

function renderArrears(host) {
  const cases = viewState.cases || [];
  const cands = (viewState.candidates || []).filter((c) => !c.hasOpenCase);
  const waivers = viewState.waivers || [];
  host.innerHTML = journeyNavHtml(PANEL) +
    `<div class="card"><div class="card-head"><h3>Arrears &amp; recovery</h3>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">` +
    `<select class="tbl-select" id="finBranch" aria-label="Facility">${facilityOptions(finState.branchId)}</select>` +
    `<select class="tbl-select" id="finStage" aria-label="Stage">${STAGES.map((s) => `<option value="${s}"${viewState.stage === s ? ' selected' : ''}>${s || 'All stages'}</option>`).join('')}</select>` +
    `<button class="tb-btn" id="finRefresh">Refresh</button>` +
    `</div></div>` +
    `<div class="card-body"><div class="sec-sub">Recovery is policy-gated by Global Settings timings (overdue next day; late fees from +7d; restriction at +14d). Late fees need a configured FacilityFee amount; termination steps are undecided and stay blocked. Physical-gate integration is out of scope — restriction here is the account state.</div></div></div>` +
    // Candidates
    `<div class="card"><div class="card-head"><h3>Overdue candidates (${cands.length})</h3></div><div class="card-body">` +
    (cands.length
      ? `<div class="table-wrap"><table class="lead-table" aria-label="Overdue invoice candidates"><thead><tr><th scope="col">Customer · unit</th><th scope="col">Invoice</th><th scope="col">Balance</th><th scope="col">Overdue</th><th scope="col">Action</th></tr></thead><tbody>` +
        cands.slice(0, 50).map((c) =>
          `<tr><td>${escapeHtml(c.tenant || '')}<br /><span class="sec-sub">${escapeHtml(c.unit || '')} · ${escapeHtml(c.branch || '')}${c.accessRestricted ? ' · <b>restricted</b>' : ''}</span></td>` +
          `<td>${escapeHtml(c.invoiceNo || '')}<br /><span class="sec-sub">${escapeHtml(c.invoiceStatus || '')}</span></td>` +
          `<td><b>${money(c.balanceDue)}</b></td>` +
          `<td>${c.daysOverdue}d<br /><span class="sec-sub">due ${fmtDay(c.dueDate)}</span></td>` +
          `<td>${can('bill-arrears:update') ? `<button class="tb-btn" data-fin-open="${escapeHtml(c.tenantId)}" data-fin-inv="${escapeHtml(c.invoiceId || '')}">Open case</button>` : '<span class="sec-sub">—</span>'}</td></tr>`,
        ).join('') +
        `</tbody></table></div>`
      : `<div class="section-empty">No overdue receivables without an open case.</div>`) +
    `</div></div>` +
    // Cases
    `<div class="card"><div class="card-head"><h3>Cases (${cases.length})</h3></div><div class="card-body">` +
    (cases.length
      ? `<div class="table-wrap"><table class="lead-table" aria-label="Arrears recovery cases"><thead><tr><th scope="col">Case</th><th scope="col">Customer</th><th scope="col">Balance</th><th scope="col">Stage</th><th scope="col">Assignee</th><th scope="col">Action</th></tr></thead><tbody>` +
        cases.map((c) =>
          `<tr><td>${escapeHtml(c.id.slice(-8))}<br /><span class="sec-sub">opened ${fmtDay(c.openedAt)} · ${c.daysOverdue}d overdue</span></td>` +
          `<td>${escapeHtml(c.tenant || '')}<br /><span class="sec-sub">${escapeHtml(c.invoiceNo || 'no invoice')}${c.accessRestricted ? ' · <b>restricted</b>' : ''}</span></td>` +
          `<td><b>${c.balanceDue === null || c.balanceDue === undefined ? '—' : money(c.balanceDue)}</b></td>` +
          `<td>${stagePill(c.stage)}${c.closeReason ? `<br /><span class="sec-sub">${escapeHtml(c.closeReason)}</span>` : ''}</td>` +
          `<td>${escapeHtml(c.assignee || '—')}</td>` +
          `<td>${caseActions(c)}</td></tr>`,
        ).join('') +
        `</tbody></table></div>`
      : `<div class="section-empty">No arrears cases match these filters.</div>`) +
    `</div></div>` +
    // Waivers
    `<div class="card"><div class="card-head"><h3>Late-fee waivers (${waivers.length})</h3><span class="sec-sub">approver-gated; approval appends a credit line</span></div><div class="card-body">` +
    (waivers.length
      ? `<div class="table-wrap"><table class="lead-table" aria-label="Late-fee waivers"><thead><tr><th scope="col">Waiver</th><th scope="col">Customer</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody>` +
        waivers.map((x) =>
          `<tr><td>${escapeHtml(x.id.slice(-8))}<br /><span class="sec-sub">${escapeHtml(x.reason || '')}</span></td>` +
          `<td>${escapeHtml(x.tenant || '')}</td>` +
          `<td><b>${money(x.amount)}</b></td>` +
          `<td>${stagePill(x.status)}</td>` +
          `<td>${x.status === 'REQUESTED' && can('bill-arrears:approve')
            ? `<button class="tb-btn" data-fin-wok="${escapeHtml(x.id)}" data-fin-ver="${x.version}">Approve</button> <button class="tb-btn" data-fin-wno="${escapeHtml(x.id)}" data-fin-ver="${x.version}">Reject</button>`
            : '<span class="sec-sub">—</span>'}</td></tr>`,
        ).join('') +
        `</tbody></table></div>`
      : `<div class="section-empty">No waivers requested.</div>`) +
    (can('bill-arrears:update')
      ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">` +
        `<input class="tbl-select" id="finWTenant" placeholder="Tenant ID" aria-label="Tenant ID" />` +
        `<input class="tbl-select" id="finWInvoice" placeholder="Invoice ID" aria-label="Invoice ID" />` +
        `<input class="tbl-select" id="finWAmount" type="number" min="0" step="0.01" placeholder="Amount" aria-label="Amount" />` +
        `<input class="tbl-select" id="finWReason" placeholder="Reason (required)" aria-label="Reason" />` +
        `<button class="tb-btn primary" id="finWGo">Request waiver</button></div>`
      : '') +
    `</div></div>`;

  wireJourneyNav(host);
  const br = host.querySelector('#finBranch');
  if (br) br.addEventListener('change', () => { finState.branchId = br.value; reload(host).catch((e) => window.alert(describeError(e))); });
  const st = host.querySelector('#finStage');
  if (st) st.addEventListener('change', () => { viewState.stage = st.value; reload(host).catch((e) => window.alert(describeError(e))); });
  const rf = host.querySelector('#finRefresh');
  if (rf) rf.addEventListener('click', () => reload(host).catch((e) => window.alert(describeError(e))));

  host.querySelectorAll('[data-fin-open]').forEach((b) => b.addEventListener('click', async () => {
    const tenantId = b.dataset.finOpen;
    const invoiceId = b.dataset.finInv || undefined;
    try {
      await post('/finance/arrears', { tenantId, invoiceId });
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  }));
  host.querySelectorAll('[data-fin-advance]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await post(`/finance/arrears/${encodeURIComponent(b.dataset.finAdvance)}/advance`, { version: Number(b.dataset.finVer) });
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); reload(host).catch(() => {}); }
  }));
  host.querySelectorAll('[data-fin-close]').forEach((b) => b.addEventListener('click', async () => {
    const reason = window.prompt('Close reason: payment, write-off or other?', 'payment');
    if (!reason) return;
    try {
      await post(`/finance/arrears/${encodeURIComponent(b.dataset.finClose)}/close`, { version: Number(b.dataset.finVer), reason });
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  }));
  host.querySelectorAll('[data-fin-term]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await post(`/finance/arrears/${encodeURIComponent(b.dataset.finTerm)}/terminate`, {});
    } catch (e) { window.alert(describeError(e)); }
  }));
  const wg = host.querySelector('#finWGo');
  if (wg) wg.addEventListener('click', async () => {
    const tenantId = host.querySelector('#finWTenant').value.trim();
    const invoiceId = host.querySelector('#finWInvoice').value.trim();
    const amount = Number(host.querySelector('#finWAmount').value);
    const reason = host.querySelector('#finWReason').value.trim();
    if (!tenantId || !invoiceId || !(amount > 0) || !reason) { window.alert('Tenant, invoice, amount and reason are all required.'); return; }
    try {
      await post('/finance/arrears/waivers', { tenantId, invoiceId, amount, reason });
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  });
  host.querySelectorAll('[data-fin-wok]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await post(`/finance/arrears/waivers/${encodeURIComponent(b.dataset.finWok)}/decide`, { approve: true, version: Number(b.dataset.finVer) });
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  }));
  host.querySelectorAll('[data-fin-wno]').forEach((b) => b.addEventListener('click', async () => {
    const reason = window.prompt('Rejection reason (required):');
    if (!reason) return;
    try {
      await post(`/finance/arrears/waivers/${encodeURIComponent(b.dataset.finWno)}/decide`, { approve: false, version: Number(b.dataset.finVer), reason });
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  }));
}

function caseActions(c) {
  const out = [];
  const terminal = c.stage === 'RESOLVED';
  if (!terminal && can('bill-arrears:update')) {
    if (c.stage !== 'RESTRICTED') out.push(`<button class="tb-btn" data-fin-advance="${escapeHtml(c.id)}" data-fin-ver="${c.version}">Advance</button>`);
    out.push(`<button class="tb-btn" data-fin-close="${escapeHtml(c.id)}" data-fin-ver="${c.version}">Resolve</button>`);
    out.push(`<button class="tb-btn" data-fin-term="${escapeHtml(c.id)}">Terminate</button>`);
  }
  return out.join(' ') || '<span class="sec-sub">—</span>';
}

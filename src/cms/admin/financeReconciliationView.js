// StoreLah CMS admin UI — Reconciliation (spec §20). Phase 4 full content.
//
// Stripe settlement import (idempotent per batchRef), the matching engine's
// queues (unmatched / partial / matched / suspense) with same-amount
// candidate suggestions, manual match + suspense actions, and the
// batch close checklist + sign-off. Closed batches are immutable; reopening
// needs an Owner.

import {
  $, escapeHtml, finState, money, fmtDay, facilityOptions,
  renderLoading, renderDenied, renderError, canViewFin,
  journeyNavHtml, wireJourneyNav, getFinMount,
} from './financeShared.js';
import { get, post, request, describeError, can } from './api.js';

const PANEL = 'bill-reconciliation';

const viewState = { month: currentMonth(), data: null, createKey: '', lineSeq: 1 };

function currentMonth() {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}`;
}

function newIdemKey() {
  try {
    return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  } catch (e) {
    return `idem-${Date.now()}`;
  }
}

export async function bindFinanceReconciliationView() {
  const host = getFinMount(PANEL);
  if (!host) return;
  if (!canViewFin(PANEL)) {
    renderDenied(host, PANEL);
    return;
  }
  renderLoading(host);
  if (!viewState.createKey) viewState.createKey = newIdemKey();
  try {
    await reload(host);
  } catch (e) {
    renderError(host, e);
    const retry = host.querySelector('[data-fin-retry]');
    if (retry) retry.addEventListener('click', () => bindFinanceReconciliationView());
  }
}

async function reload(host) {
  const q = new URLSearchParams();
  if (finState.branchId) q.set('branchId', finState.branchId);
  if (viewState.month) q.set('fiscalMonth', viewState.month);
  const qs = q.toString();
  viewState.data = await get(`/finance/reconciliation${qs ? `?${qs}` : ''}`);
  renderRecon(host);
}

function checkRow(c) {
  return `<div>• ${c.pass ? '<b style="color:var(--ok,#1a7f37);">PASS</b>' : '<b style="color:var(--bad,#b42318);">FAIL</b>'} <b>${escapeHtml(c.label)}</b> — ${escapeHtml(c.detail || '')}</div>`;
}

function lineRow(l, kind) {
  const matchCell = (kind === 'unmatched' || kind === 'partial' || kind === 'suspense') && can('bill-reconciliation:update')
    ? `<input class="tbl-select" data-fin-m-inv="${escapeHtml(l.id)}" placeholder="Invoice ID" aria-label="Invoice ID" style="max-width:140px;" />` +
      `<input class="tbl-select" data-fin-m-amt="${escapeHtml(l.id)}" type="number" min="0" step="0.01" placeholder="Amount (optional)" aria-label="Amount" style="max-width:110px;" />` +
      `<button class="tb-btn" data-fin-match="${escapeHtml(l.id)}">Match</button>`
    : '<span class="sec-sub">—</span>';
  const susCell = kind !== 'matched' && kind !== 'suspense' && can('bill-reconciliation:update')
    ? ` <button class="tb-btn" data-fin-sus="${escapeHtml(l.id)}">Suspense</button>`
    : '';
  return `<tr><td>${escapeHtml(l.externalRef || l.sourceRef || '')}<br /><span class="sec-sub">${fmtDay(l.receivedAt || l.createdAt)}</span></td>` +
    `<td><b>${money(l.amount)}</b>${l.matchedAmount ? `<br /><span class="sec-sub">allocated ${money(l.matchedAmount)}</span>` : ''}</td>` +
    `<td>${l.matchedInvoiceNo ? escapeHtml(l.matchedInvoiceNo) : '<span class="sec-sub">—</span>'}${l.suggestion ? `<br /><span class="sec-sub">suggestion: ${escapeHtml(l.suggestion.invoiceNo)} (${money(l.suggestion.balanceDue)})</span>` : ''}${l.suspenseReason ? `<br /><span class="sec-sub">suspense: ${escapeHtml(l.suspenseReason)}</span>` : ''}</td>` +
    `<td><div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">${matchCell}${susCell}</div></td></tr>`;
}

function queueCard(title, rows, kind) {
  return `<div class="card"><div class="card-head"><h3>${escapeHtml(title)} (${rows.length})</h3></div><div class="card-body">` +
    (rows.length
      ? `<div class="table-wrap"><table class="lead-table" aria-label="Settlement items awaiting match"><thead><tr><th scope="col">Reference</th><th scope="col">Amount</th><th scope="col">Invoice</th><th scope="col">Action</th></tr></thead><tbody>` +
        rows.map((l) => lineRow(l, kind)).join('') + `</tbody></table></div>`
      : `<div class="section-empty">Nothing here.</div>`) +
    `</div></div>`;
}

function renderRecon(host) {
  const d = viewState.data || {};
  const batch = d.batch;
  host.innerHTML = journeyNavHtml(PANEL) +
    `<div class="card"><div class="card-head"><h3>Reconciliation</h3>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">` +
    `<select class="tbl-select" id="finBranch" aria-label="Facility">${facilityOptions(finState.branchId)}</select>` +
    `<input class="tbl-select" id="finMonth" placeholder="YYYY-MM" aria-label="Fiscal month" value="${escapeHtml(viewState.month)}" />` +
    `<button class="tb-btn" id="finRefresh">Refresh</button>` +
    `</div></div>` +
    `<div class="card-body"><div class="sec-sub">Gateway/bank money in, invoices out. Settled <b>${money(d.settled)}</b> · allocated <b>${money(d.allocated)}</b> · variance <b>${money(d.variance)}</b> · unmatched <b>${d.unmatchedCount || 0}</b> · suspense <b>${d.suspenseCount || 0}</b> · refunds paid <b>${money(d.refundsPaid)}</b>.</div></div></div>` +
    (can('bill-reconciliation:create')
      ? `<div class="card"><div class="card-head"><h3>Settlement import</h3><span class="sec-sub">idempotent per batch ref</span></div><div class="card-body">` +
        `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">` +
        `<input class="tbl-select" id="finIBatch" placeholder="Batch ref (e.g. stripe-2026-10-30)" aria-label="Batch ref" />` +
        `<button class="tb-btn" id="finIAdd">Add line</button>` +
        `<button class="tb-btn primary" id="finIGo">Import</button></div>` +
        `<div class="table-wrap"><table class="lead-table" aria-label="Manual settlement match"><thead><tr><th scope="col">External ref</th><th scope="col">Amount</th><th scope="col">Invoice ref (optional)</th><th scope="col">Received (optional)</th><th scope="col"></th></tr></thead>` +
        `<tbody id="finILines"></tbody></table></div>` +
        `</div></div>`
      : '') +
    queueCard('Unmatched', (d.queues && d.queues.unmatched) || [], 'unmatched') +
    queueCard('Partially matched', (d.queues && d.queues.partial) || [], 'partial') +
    queueCard('Suspense', (d.queues && d.queues.suspense) || [], 'suspense') +
    queueCard('Matched', (d.queues && d.queues.matched) || [], 'matched') +
    `<div class="card"><div class="card-head"><h3>Close checklist</h3>` +
    (batch ? `<span class="sec-sub">batch ${escapeHtml(batch.status)}${batch.closedBy ? ` by ${escapeHtml(batch.closedBy)}` : ''}</span>` : `<span class="sec-sub">no batch yet</span>`) +
    `</div><div class="card-body">` +
    ((d.checklist || []).map(checkRow).join('') || `<div class="section-empty">No checks reported.</div>`) +
    `<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">` +
    (can('bill-reconciliation:approve') && (!batch || batch.status !== 'CLOSED') ? `<button class="tb-btn primary" id="finClose">Close batch</button>` : '') +
    ((!batch || batch.status !== 'CLOSED') ? '' : `<span class="sec-sub">Closed batches are immutable.</span>`) +
    `</div></div></div>`;

  wireJourneyNav(host);
  const br = host.querySelector('#finBranch');
  if (br) br.addEventListener('change', () => { finState.branchId = br.value; reload(host).catch((e) => window.alert(describeError(e))); });
  const mo = host.querySelector('#finMonth');
  if (mo) mo.addEventListener('change', () => { viewState.month = mo.value.trim(); reload(host).catch((e) => window.alert(describeError(e))); });
  const rf = host.querySelector('#finRefresh');
  if (rf) rf.addEventListener('click', () => reload(host).catch((e) => window.alert(describeError(e))));

  const linesBody = host.querySelector('#finILines');
  const addLine = () => {
    if (!linesBody) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input class="tbl-select" data-il="ref" placeholder="STL-…" aria-label="External ref" /></td>` +
      `<td><input class="tbl-select" data-il="amt" type="number" min="0" step="0.01" placeholder="0.00" aria-label="Amount" /></td>` +
      `<td><input class="tbl-select" data-il="inv" placeholder="INV-… (optional)" aria-label="Invoice ref" /></td>` +
      `<td><input class="tbl-select" data-il="rec" placeholder="YYYY-MM-DD (optional)" aria-label="Received" /></td>` +
      `<td><button class="tb-btn" data-il-del>Remove</button></td>`;
    tr.querySelector('[data-il-del]').addEventListener('click', () => tr.remove());
    linesBody.appendChild(tr);
  };
  if (linesBody) {
    addLine();
    const add = host.querySelector('#finIAdd');
    if (add) add.addEventListener('click', addLine);
    const go = host.querySelector('#finIGo');
    if (go) go.addEventListener('click', async () => {
      const batchRef = host.querySelector('#finIBatch').value.trim();
      if (!batchRef) { window.alert('A batch ref is required.'); return; }
      const lines = [...linesBody.querySelectorAll('tr')].map((tr) => ({
        externalRef: tr.querySelector('[data-il="ref"]').value.trim(),
        amount: Number(tr.querySelector('[data-il="amt"]').value),
        invoiceRef: tr.querySelector('[data-il="inv"]').value.trim() || undefined,
        receivedAt: tr.querySelector('[data-il="rec"]').value.trim() || undefined,
      })).filter((l) => l.externalRef);
      if (!lines.length) { window.alert('Add at least one line.'); return; }
      try {
        const body = { batchRef, lines };
        if (finState.branchId) body.branchId = finState.branchId;
        const out = await request('/finance/reconciliation/import', { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': viewState.createKey } });
        viewState.createKey = newIdemKey();
        if (out && out.deduplicated) window.alert(`Batch already imported (${out.reused} existing row(s)).`);
        reload(host).catch((e) => window.alert(describeError(e)));
      } catch (e) { window.alert(describeError(e)); }
    });
  }

  host.querySelectorAll('[data-fin-match]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.finMatch;
    const invEl = host.querySelector(`[data-fin-m-inv="${CSS.escape(id)}"]`);
    const amtEl = host.querySelector(`[data-fin-m-amt="${CSS.escape(id)}"]`);
    const invoiceId = invEl ? invEl.value.trim() : '';
    if (!invoiceId) { window.alert('An invoice ID is required.'); return; }
    const body = { invoiceId };
    if (amtEl && amtEl.value !== '') body.amount = Number(amtEl.value);
    try {
      await post(`/finance/reconciliation/${encodeURIComponent(id)}/match`, body);
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); reload(host).catch(() => {}); }
  }));
  host.querySelectorAll('[data-fin-sus]').forEach((b) => b.addEventListener('click', async () => {
    const reason = window.prompt('Suspense reason (required):');
    if (!reason) return;
    try {
      await post(`/finance/reconciliation/${encodeURIComponent(b.dataset.finSus)}/suspense`, { reason });
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  }));
  const close = host.querySelector('#finClose');
  if (close) close.addEventListener('click', async () => {
    if (!viewState.month) { window.alert('A fiscal month (YYYY-MM) is required.'); return; }
    if (!window.confirm(`Close the reconciliation batch for ${viewState.month}? Closed batches are immutable.`)) return;
    try {
      await post('/finance/reconciliation/close', { branchId: finState.branchId, fiscalMonth: viewState.month });
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); reload(host).catch(() => {}); }
  });
}

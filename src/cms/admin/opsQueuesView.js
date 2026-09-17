// StoreLah CMS admin UI — quotes + move-outs ops queues (P1 item 4).
// Quotes: PROPOSAL_SENT leads with live inventory (GET /quotes); stage moves
// stay in Leads (PATCH /leads/:id). Move-outs: NOTICE tenants with their
// latest Notice row (GET /move-outs); explicit complete/cancel via
// PATCH /move-outs/:tenantId — nothing auto-flips tenant status.

import { $, escapeHtml, showBanner } from './dom.js';
import { get, patch, describeError } from './api.js';
import { confirmDialog } from './confirmDialog.js';

const fmtMoney = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-SG', { maximumFractionDigits: 2 });
const fmtDay = (d) => d ? new Date(d).toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

// ---------- quotes ----------

export async function bindQuotes() {
  const tb = $('#quotesBody');
  if (!tb) return;
  try {
    const rows = (await get('/quotes')) || [];
    renderQuotes(rows);
    const sub = $('#quotesSub');
    if (sub) sub.textContent = `${rows.length} quoted lead(s) · stages move in Leads`;
  } catch (e) {
    tb.innerHTML = '<tr><td colspan="7"><div class="section-empty">Quotes failed to load: ' + escapeHtml(describeError(e)) + '</div></td></tr>';
  }
}

function renderQuotes(rows) {
  const tb = $('#quotesBody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7"><div class="section-empty">No quoted leads (PROPOSAL_SENT) right now.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows.map((q) =>
    `<tr><td><b>${escapeHtml(q.name)}</b><div class="t-type">${escapeHtml(q.type || '')}${q.segment ? ' · ' + escapeHtml(q.segment) : ''}</div></td>` +
    `<td><span class="pill amber">Quoted</span></td>` +
    `<td>${escapeHtml(q.branchCode || '—')}${q.preferredSize ? ' · ' + escapeHtml(q.preferredSize) : ''}</td>` +
    `<td><b>${fmtMoney(q.monthlyRate)}</b></td>` +
    `<td>${q.matchingAvailable} available</td>` +
    `<td>${q.owner ? escapeHtml(q.owner) : '—'}</td>` +
    `<td class="unit-actions"><button class="act-btn" data-q-act="view" data-q-id="${escapeHtml(q.id)}">Units</button></td></tr>`,
  ).join('');
}

async function showQuoteUnits(id) {
  const detail = $('#quoteDetail');
  try {
    const q = await get(`/quotes/${encodeURIComponent(id)}`);
    const opts = q.options || [];
    if (detail) {
      detail.innerHTML = `<div class="t-type" style="margin:8px 2px;">Live options for <b>${escapeHtml(q.quote?.name || '')}</b> — ${opts.length} unit(s): ` +
        (opts.length ? opts.map((u) => `${escapeHtml(u.code)} (${escapeHtml(u.sizeCode)} · ${u.sqft} sqft · $${u.rate}/mo)`).join(' · ') : 'none match right now') + `</div>`;
    }
  } catch (e) {
    showBanner('Quote: ' + describeError(e));
  }
}

// ---------- move-outs ----------

export async function bindMoveouts() {
  const tb = $('#moveoutsBody');
  if (!tb) return;
  try {
    const rows = await get('/move-outs');
    renderMoveouts(rows || []);
    const sub = $('#moveoutsSub');
    if (sub) sub.textContent = `${(rows || []).length} tenant(s) on notice · explicit complete/cancel only`;
  } catch (e) {
    tb.innerHTML = '<tr><td colspan="7"><div class="section-empty">Move-outs failed to load: ' + escapeHtml(describeError(e)) + '</div></td></tr>';
  }
}

function renderMoveouts(rows) {
  const tb = $('#moveoutsBody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7"><div class="section-empty">No tenants on notice.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows.map((m) =>
    `<tr><td><b>${escapeHtml(m.name)}</b><div class="t-type">${escapeHtml(m.email || m.mobile || '')}</div></td>` +
    `<td>${m.unitCode ? escapeHtml(m.unitCode) : '—'}<div class="t-type">${escapeHtml(m.branchCode || '')}</div></td>` +
    `<td><b>${fmtMoney(m.monthlyRate)}</b></td>` +
    `<td>${fmtDay(m.lastDay)}<div class="t-type">filed ${fmtDay(m.submittedAt)}${m.noticeCount > 1 ? ` · ${m.noticeCount} notices` : ''}</div></td>` +
    `<td><span class="pill amber">Notice</span></td>` +
    `<td class="unit-actions"><button class="act-btn primary" data-mo-act="complete" data-mo-id="${escapeHtml(m.tenantId)}">Complete</button> ` +
    `<button class="act-btn" data-mo-act="cancel" data-mo-id="${escapeHtml(m.tenantId)}">Withdraw</button></td></tr>`,
  ).join('');
}

async function transitionMoveOut(id, action) {
  const verb = action === 'complete' ? 'Complete this move-out (tenant → INACTIVE, unit released)?' : 'Withdraw this notice (tenant back to ACTIVE)?';
  const okConfirm = await confirmDialog({ title: action === 'complete' ? 'Complete move-out?' : 'Withdraw notice?', message: verb, confirmLabel: action === 'complete' ? 'Complete' : 'Withdraw', danger: action === 'complete' });
  if (!okConfirm) return;
  try {
    const res = await patch(`/move-outs/${encodeURIComponent(id)}`, { action });
    showBanner(`Move-out ${action}d — tenant now ${res.status}`, true);
    await bindMoveouts();
  } catch (e) {
    showBanner('Move-out: ' + describeError(e));
  }
}

let queuesWired = false;
export function wireOpsQueues() {
  if (queuesWired) return;
  queuesWired = true;
  $('#quotesBody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-q-act]');
    if (!btn) return;
    if (btn.dataset.qAct === 'view') showQuoteUnits(btn.dataset.qId).catch(() => {});
  });
  $('#moveoutsBody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mo-act]');
    if (!btn) return;
    transitionMoveOut(btn.dataset.moId, btn.dataset.moAct).catch(() => {});
  });
}

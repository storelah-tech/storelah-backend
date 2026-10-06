// StoreLah CMS admin UI — quotes + move-outs ops queues (P1 item 4).
// Quotes: PROPOSAL_SENT leads with live inventory (GET /quotes); stage moves
// stay in Leads (PATCH /leads/:id). Move-outs: NOTICE tenants with their
// latest Notice row (GET /move-outs); explicit complete/cancel via
// PATCH /move-outs/:tenantId — nothing auto-flips tenant status.

import { $, $$, escapeHtml, showBanner } from './dom.js';
import { ApiError, get, post, describeError } from './api.js';
import { state } from './state.js';
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
  $('#addQuoteBtn')?.addEventListener('click', () => { openQuoteModal().catch((e) => showBanner('Quotes: ' + describeError(e))); });
  $('#quoteModalClose')?.addEventListener('click', closeQuoteModal);
  $('#quoteFormCancel')?.addEventListener('click', closeQuoteModal);
  $('#quoteForm')?.addEventListener('submit', submitQuoteForm);
}

// ---------- new quotation (POST /quotes) ----------

// zod fieldErrors keys → quote form element keys.
const QUOTE_FIELD_ID = {
  leadId: 'lead', name: 'name', type: 'type', preferredBranchId: 'branch',
  mobile: 'mobile', email: 'email', preferredSize: 'size', monthlyRate: 'rate',
  moveInDate: 'moveIn', durationMonths: 'duration', unitCode: 'unit', note: 'note',
};

function clearQuoteFieldErrors() {
  $$('#quoteModal .field-err').forEach((el) => { el.textContent = ''; });
  $$('#quoteModal .field input.err, #quoteModal .field select.err').forEach((el) => el.classList.remove('err'));
  const a = $('#quoteModalAlert');
  if (a) a.hidden = true;
}

function showQuoteFormAlert(msg) {
  const a = $('#quoteModalAlert');
  if (!a) return;
  a.textContent = msg;
  a.hidden = false;
}

function renderQuoteFieldErrors(err) {
  if (!(err instanceof ApiError) || !err.details || !err.details.fieldErrors) return false;
  let mapped = false;
  for (const [field, msgs] of Object.entries(err.details.fieldErrors)) {
    if (!msgs || !msgs.length) continue;
    const key = QUOTE_FIELD_ID[field];
    if (!key) continue;
    const errEl = $('#qe-' + key);
    if (errEl) errEl.textContent = msgs.join('; ');
    const input = $('#qf-' + key);
    if (input) input.classList.add('err');
    mapped = true;
  }
  return mapped;
}

function quoteBranchOptions() {
  return '<option value="">— No facility —</option>' + (state.branches || [])
    .map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.code)} · ${escapeHtml(b.name)}</option>`)
    .join('');
}

async function ensureQuoteBranches() {
  if ((state.branches || []).length) return;
  try {
    state.branches = (await get('/branches')) || [];
  } catch {
    // Branch dropdown stays "No facility" — submit still works (field optional).
  }
}

async function loadQuoteLeadOptions() {
  const sel = $('#qf-lead');
  if (!sel) return;
  sel.innerHTML = '<option value="">— New lead (enter name below) —</option>';
  try {
    const leads = (await get('/leads')) || [];
    const rows = Array.isArray(leads) ? leads : (leads.rows || []);
    sel.innerHTML += rows.slice(0, 200).map((l) =>
      `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name || l.id)}${l.stage ? ' · ' + escapeHtml(l.stage) : ''}</option>`,
    ).join('');
  } catch {
    // Lead select stays new-lead-only — name input covers creation.
  }
}

export async function openQuoteModal() {
  await ensureQuoteBranches();
  const branchSel = $('#qf-branch');
  if (branchSel) branchSel.innerHTML = quoteBranchOptions();
  await loadQuoteLeadOptions();
  const form = $('#quoteForm');
  if (form) form.reset();
  clearQuoteFieldErrors();
  const modal = $('#quoteModal');
  if (modal) modal.hidden = false;
}

export function closeQuoteModal() {
  const modal = $('#quoteModal');
  if (modal) modal.hidden = true;
  clearQuoteFieldErrors();
}

function quoteFieldError(key, msg) {
  const errEl = $('#qe-' + key);
  if (errEl) errEl.textContent = msg;
  const input = $('#qf-' + key);
  if (input) input.classList.add('err');
}

export async function submitQuoteForm(e) {
  e.preventDefault();
  clearQuoteFieldErrors();
  const leadId = $('#qf-lead')?.value || '';
  const name = $('#qf-name')?.value.trim() || '';
  // Client-side mirror of the createQuoteSchema superRefine (cms.ts):
  // either leadId (existing-lead mode) or name (new-lead mode) is required.
  if (!leadId && !name) {
    quoteFieldError('lead', 'Pick a lead or enter a name');
    quoteFieldError('name', 'Name is required when no lead is selected');
    return;
  }
  const email = $('#qf-email')?.value.trim() || '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    quoteFieldError('email', 'Enter a valid email');
    return;
  }
  const rateRaw = $('#qf-rate')?.value.trim() || '';
  const rate = rateRaw === '' ? undefined : Number(rateRaw);
  if (rate !== undefined && !(rate >= 0)) {
    quoteFieldError('rate', 'Rate must be 0 or more');
    return;
  }
  const durRaw = $('#qf-duration')?.value.trim() || '';
  const durationMonths = durRaw === '' ? undefined : Number(durRaw);
  if (durationMonths !== undefined && (!Number.isInteger(durationMonths) || durationMonths < 1)) {
    quoteFieldError('duration', 'Duration must be a whole month ≥ 1');
    return;
  }
  const moveInRaw = $('#qf-moveIn')?.value || '';
  if (moveInRaw && Number.isNaN(Date.parse(moveInRaw))) {
    quoteFieldError('moveIn', 'Move-in date must be a valid date');
    return;
  }
  const body = {};
  if (leadId) body.leadId = leadId;
  if (name) body.name = name;
  const type = $('#qf-type')?.value || '';
  if (type) body.type = type;
  const mobile = $('#qf-mobile')?.value.trim() || '';
  if (mobile) body.mobile = mobile;
  if (email) body.email = email;
  const branchId = $('#qf-branch')?.value || '';
  if (branchId) body.preferredBranchId = branchId;
  const size = $('#qf-size')?.value.trim() || '';
  if (size) body.preferredSize = size;
  if (rate !== undefined) body.monthlyRate = rate;
  if (moveInRaw) body.moveInDate = moveInRaw;
  if (durationMonths !== undefined) body.durationMonths = durationMonths;
  const unitCode = $('#qf-unit')?.value.trim() || '';
  if (unitCode) body.unitCode = unitCode;
  const note = $('#qf-note')?.value.trim() || '';
  if (note) body.note = note;
  try {
    await post('/quotes', body);
    closeQuoteModal();
    showBanner('Quotation created', true);
    await bindQuotes();
  } catch (err) {
    // Surface server errors honestly: 400 VALIDATION (incl. per-field map),
    // 404 unknown lead/branch/unit, 409 CONFLICT|DUPLICATE, 401 auth.
    if (!renderQuoteFieldErrors(err)) showQuoteFormAlert(describeError(err));
  }
}

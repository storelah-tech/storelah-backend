// StoreLah CMS admin UI — quotes + move-outs ops queues (P1 item 4).
// Quotes: PROPOSAL_SENT leads with live inventory (GET /quotes); stage moves
// stay in Leads (PATCH /leads/:id). Move-outs: NOTICE tenants with their
// latest Notice row (GET /move-outs); explicit complete/cancel via
// PATCH /move-outs/:tenantId — nothing auto-flips tenant status.

import { $, $$, escapeHtml, showBanner } from './dom.js';
import { ApiError, get, post, patch, downloadFile, describeError } from './api.js';
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
    tb.innerHTML = '<tr><td colspan="10"><div class="section-empty">Quotes failed to load: ' + escapeHtml(describeError(e)) + '</div></td></tr>';
  }
}

function quoteEmailPill(q) {
  const st = q.quotation?.emailStatus || 'NONE';
  if (st === 'SENT') return '<span class="pill green">Emailed</span>';
  if (st === 'SKIPPED') return `<span class="pill amber" title="${escapeHtml(q.quotation?.emailReason || 'skipped')}">Not emailed</span>`;
  if (st === 'FAILED') return '<span class="pill red">Email failed</span>';
  return '<span class="t-type">—</span>';
}

function renderQuotes(rows) {
  const tb = $('#quotesBody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="10"><div class="section-empty">No quoted leads (PROPOSAL_SENT) right now.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows.map((q) => {
    const qn = q.quotation;
    const pdfCell = qn
      ? `<button class="act-btn" data-q-act="pdf" data-q-id="${escapeHtml(q.id)}" title="Download ${escapeHtml(qn.quoteNo)}">PDF</button>`
      : '<span class="t-type">—</span>';
    return `<tr><td><b>${escapeHtml(q.name)}</b><div class="t-type">${escapeHtml(q.type || '')}${q.segment ? ' · ' + escapeHtml(q.segment) : ''}</div></td>` +
    `<td><span class="pill amber">Quoted</span></td>` +
    `<td>${escapeHtml(q.branchCode || '—')}${q.preferredSize ? ' · ' + escapeHtml(q.preferredSize) : ''}</td>` +
    `<td><b>${fmtMoney(q.monthlyRate)}</b></td>` +
    `<td>${q.matchingAvailable} available</td>` +
    `<td>${q.owner ? escapeHtml(q.owner) : '—'}</td>` +
    `<td>${qn ? `<b>${escapeHtml(qn.quoteNo)}</b>` : '<span class="t-type">—</span>'}</td>` +
    `<td>${pdfCell}</td>` +
    `<td>${quoteEmailPill(q)}</td>` +
    `<td class="unit-actions"><button class="act-btn" data-q-act="view" data-q-id="${escapeHtml(q.id)}">Units</button></td></tr>`;
  }).join('');
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
    if (btn.dataset.qAct === 'pdf') downloadQuotePdf(btn.dataset.qId).catch((err) => showBanner('Quotation PDF: ' + describeError(err)));
  });
  $('#moveoutsBody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mo-act]');
    if (!btn) return;
    transitionMoveOut(btn.dataset.moId, btn.dataset.moAct).catch(() => {});
  });
  // Customer Management header entry point — the single quotation
  // modal/route (replaces the dead "+ New customer" header button).
  $('#addQuoteHeaderBtn')?.addEventListener('click', () => { openQuoteModal().catch((e) => showBanner('Quotes: ' + describeError(e))); });
  $('#quoteModalClose')?.addEventListener('click', closeQuoteModal);
  $('#quoteFormCancel')?.addEventListener('click', closeQuoteModal);
  $('#quoteForm')?.addEventListener('submit', submitQuoteForm);
  // Sectioned-form live behaviour: lead auto-fill, unit narrowing, unit →
  // rate and plan → protection-cost fill, add-on rows, live summary.
  $('#quoteForm')?.addEventListener('change', (e) => {
    const id = e.target && e.target.id;
    if (id === 'qf-lead') autofillLeadFields(e.target.value || '');
    if (id === 'qf-branch' || id === 'qf-size') refreshQuoteUnitOptions().catch(() => {});
    if (id === 'qf-unit') fillRateFromUnit(e.target.value);
    if (id === 'qf-protectionTier') fillProtectionCost(e.target.value);
    if (e.target.closest && e.target.closest('.qm-addon')) onAddonRowEdit(e.target);
    refreshQuoteTotalPreview();
  });
  $('#quoteForm')?.addEventListener('input', (e) => {
    const id = e.target && e.target.id;
    const inAddon = !!(e.target.closest && e.target.closest('.qm-addon'));
    if (inAddon) onAddonRowEdit(e.target);
    if (inAddon || ['qf-rate', 'qf-duration', 'qf-protectionCost', 'qf-promoDiscount', 'qf-promoCode', 'qf-total', 'qf-name'].includes(id)) refreshQuoteTotalPreview();
  });
  $('#qfAddonAdd')?.addEventListener('click', () => { addAddonRow(); refreshQuoteTotalPreview(); });
  $('#qfAddonRows')?.addEventListener('click', (e) => {
    const del = e.target.closest('.qm-del');
    if (!del) return;
    del.closest('.qm-addon').remove();
    syncAddonsJson();
    refreshQuoteTotalPreview();
  });
  // View quotation: on-screen replica of the issued PDF (no server round-trip).
  ['#qfViewQuote', '#qfViewQuoteFoot'].forEach((sel) => $(sel)?.addEventListener('click', () => {
    openQuoteView().catch((e) => showBanner('Quotation preview: ' + describeError(e)));
  }));
  $('#quoteViewBack')?.addEventListener('click', closeQuoteView);
  $('#quoteViewClose')?.addEventListener('click', closeQuoteView);
  $('#quoteViewModal')?.addEventListener('click', (e) => { if (e.target.id === 'quoteViewModal') closeQuoteView(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#quoteViewModal') && !$('#quoteViewModal').hidden) { e.stopPropagation(); closeQuoteView(); }
  }, true);
  $('#qfUseEstimate')?.addEventListener('click', () => {
    refreshQuoteTotalPreview(); // never fill from a stale estimate
    const t = $('#qf-total');
    if (t && quoteEstimate != null) t.value = quoteEstimate.toFixed(2);
    refreshQuoteTotalPreview();
  });
}

async function downloadQuotePdf(id) {
  // Filename comes from the row's quotation metadata when loaded; the
  // server Content-Disposition is the fallback.
  let filename = `quotation-${id}.pdf`;
  try {
    const q = await get(`/quotes/${encodeURIComponent(id)}`);
    const qn = q?.quote?.quotation;
    if (qn?.quoteNo) filename = `StoreLah-quotation-${qn.quoteNo}.pdf`;
  } catch {
    // Fall through with the generic filename — the download still works.
  }
  await downloadFile(`/quotes/${encodeURIComponent(id)}/pdf`, filename);
}

// ---------- new quotation (POST /quotes) ----------

// zod fieldErrors keys → quote form element keys. The createQuoteSchema
// contract (cms.ts) is unchanged — this map only routes server per-field
// errors onto the sectioned form inputs.
const QUOTE_FIELD_ID = {
  leadId: 'lead', name: 'name', type: 'type', segment: 'segment', source: 'source',
  preferredBranchId: 'branch', mobile: 'mobile', email: 'email', preferredSize: 'size',
  monthlyRate: 'rate', moveInDate: 'moveIn', durationMonths: 'duration', unitCode: 'unit',
  note: 'note', owner: 'owner', nextActionAt: 'nextAction', protectionTier: 'protectionTier',
  protectionCost: 'protectionCost', addons: 'addons', promoCode: 'promoCode',
  promoDiscountAmt: 'promoDiscount', movingService: 'movingService', totalDueToday: 'total',
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

// Stages that can never be quoted (mirrors NON_QUOTABLE_STAGES in
// core/quotes.ts): already-quoted PROPOSAL_SENT + terminal WON/LOST. Used
// only for the client-side fallback filter — the 409 server guards stay
// authoritative.
const NON_QUOTABLE_STAGES = new Set(['PROPOSAL_SENT', 'WON', 'LOST']);

// Full quotable-lead rows for auto-fill (keyed by lead id).
let quotableLeadCache = new Map();

async function loadQuoteLeadOptions() {
  const sel = $('#qf-lead');
  if (!sel) return;
  sel.innerHTML = '<option value="">— New lead (enter name below) —</option>';
  quotableLeadCache = new Map();
  const paint = (rows) => {
    quotableLeadCache = new Map((rows || []).map((l) => [l.id, l]));
    sel.innerHTML += (rows || []).slice(0, 200).map((l) =>
      `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name || l.id)} · ${escapeHtml(l.stageLabel || l.stage || '')}</option>`,
    ).join('');
  };
  try {
    // Preferred: server-side quotable list (excludes WON/PROPOSAL_SENT/LOST,
    // carries stage labels for the picker).
    const rows = await get('/quotes/quotable-leads');
    paint(Array.isArray(rows) ? rows : []);
  } catch {
    try {
      // Fallback: filter the full lead list client-side.
      const leads = (await get('/leads')) || [];
      const rows = (Array.isArray(leads) ? leads : (leads.rows || []))
        .filter((l) => !NON_QUOTABLE_STAGES.has(l.stage));
      paint(rows);
    } catch {
      // Lead select stays new-lead-only — name input covers creation.
    }
  }
}

// (a) Lead section: picking an existing lead auto-fills name/email/mobile
// (overrides still editable before submit).
function autofillLeadFields(leadId) {
  const l = quotableLeadCache.get(leadId);
  if (!l) return;
  if (l.name && $('#qf-name')) $('#qf-name').value = l.name;
  if (l.email !== undefined && $('#qf-email')) $('#qf-email').value = l.email || '';
  if (l.mobile !== undefined && $('#qf-mobile')) $('#qf-mobile').value = l.mobile || '';
  if (l.preferredBranchId && $('#qf-branch')) $('#qf-branch').value = l.preferredBranchId;
  if (l.preferredSize !== undefined && $('#qf-size')) {
    if (l.preferredSize) ensureOption($('#qf-size'), String(l.preferredSize).toUpperCase());
    else $('#qf-size').value = '';
  }
  refreshQuoteUnitOptions().catch(() => {});
  refreshQuoteTotalPreview();
}

// (b) Unit information: specific-unit dropdown of live AVAILABLE units,
// narrowed by the chosen facility (branch) + preferred size text.
let quoteUnitsCache = [];

async function loadQuoteUnitsCache() {
  try {
    const rows = await get('/units?status=AVAILABLE&perPage=200');
    quoteUnitsCache = Array.isArray(rows) ? rows : [];
  } catch {
    quoteUnitsCache = [];
  }
}

async function refreshQuoteUnitOptions() {
  const sel = $('#qf-unit');
  if (!sel) return;
  const keep = sel.value;
  const branchId = $('#qf-branch')?.value || '';
  const sizeText = ($('#qf-size')?.value || '').trim().toUpperCase();
  const matches = quoteUnitsCache.filter((u) =>
    (!branchId || u.branchId === branchId) &&
    (!sizeText || (u.size && String(u.size.code || '').toUpperCase() === sizeText)),
  ).slice(0, 100);
  sel.innerHTML = '<option value="">— No specific unit —</option>' + matches.map((u) => {
    const sizeCode = u.size ? escapeHtml(u.size.code || '') : '';
    return `<option value="${escapeHtml(u.code)}">${escapeHtml(u.code)} · ${sizeCode} · ${u.sqft} sqft · $${u.rate}/mo</option>`;
  }).join('');
  if (keep && matches.some((u) => u.code === keep)) sel.value = keep;
}

// Catalogues for the redesigned form (2026-10-22): size tiers (state.sizes),
// protection plans (GET /protection-plans) and add-ons (GET /addons). All
// best-effort — an empty catalogue just leaves the dropdown at its default.
let quotePlans = [];
let quoteAddonCatalog = [];

async function loadQuoteCatalogs() {
  const [plans, addons] = await Promise.all([
    get('/protection-plans').catch(() => []),
    get('/addons').catch(() => []),
  ]);
  quotePlans = (Array.isArray(plans) ? plans : []).filter((x) => x.active !== false);
  quoteAddonCatalog = (Array.isArray(addons) ? addons : []).filter((x) => x.active !== false);
  const sizeSel = $('#qf-size');
  if (sizeSel) {
    sizeSel.innerHTML = '<option value="">— Any size —</option>' + (state.sizes || [])
      .map((z) => `<option value="${escapeHtml(z.code)}">${escapeHtml(z.name)} · ${z.sqftFrom === z.sqftTo ? z.sqftFrom : z.sqftFrom + '–' + z.sqftTo} sqft</option>`)
      .join('');
  }
  const planSel = $('#qf-protectionTier');
  if (planSel) {
    planSel.innerHTML = '<option value="">— None —</option>' + quotePlans
      .map((pl) => `<option value="${escapeHtml(pl.id)}">${escapeHtml(pl.name)} · $${Number(pl.price).toFixed(2)}/mo</option>`)
      .join('');
  }
}

// A select only keeps values it has options for: auto-fill from a lead
// whose stored value is not in the catalogue adds it as an extra option.
function ensureOption(sel, value) {
  if (!sel || !value) return;
  if (![...sel.options].some((o) => o.value === value)) sel.add(new Option(value, value));
  sel.value = value;
}

function fillRateFromUnit(code) {
  const u = quoteUnitsCache.find((x) => x.code === code);
  if (u && u.rate != null && $('#qf-rate')) $('#qf-rate').value = Number(u.rate).toFixed(2);
}

function fillProtectionCost(planId) {
  const pl = quotePlans.find((x) => x.id === planId);
  const el = $('#qf-protectionCost');
  if (!el) return;
  el.value = pl ? Number(pl.price).toFixed(2) : '';
}

// ---------- add-on rows → hidden #qf-addons JSON ----------
function addAddonRow(item) {
  const box = $('#qfAddonRows');
  if (!box) return;
  if (!box.querySelector('.qm-addon-hdr')) {
    box.innerHTML = '<div class="qm-addon qm-addon-hdr"><span>Item</span><span>Qty</span><span>Unit price</span><span style="text-align:right">Line</span><span></span></div>';
  }
  const row = document.createElement('div');
  row.className = 'qm-addon';
  const opts = '<option value="">Custom item…</option>' + quoteAddonCatalog
    .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} · $${Number(a.price).toFixed(2)}</option>`).join('');
  row.innerHTML =
    `<div style="display:flex;gap:6px;min-width:0"><select data-a="pick" aria-label="Catalogue item">${opts}</select><input data-a="name" placeholder="Item name" maxlength="80" aria-label="Item name"></div>` +
    '<input data-a="qty" type="number" min="1" step="1" value="1" aria-label="Quantity">' +
    '<input data-a="price" type="number" min="0" step="0.01" placeholder="0.00" aria-label="Unit price">' +
    '<span class="qm-line">$0.00</span>' +
    '<button type="button" class="qm-del" aria-label="Remove item">✕</button>';
  box.appendChild(row);
  if (item) {
    const cat = quoteAddonCatalog.find((a) => a.id === item.id || a.name === item.name);
    if (cat) row.querySelector('[data-a="pick"]').value = cat.id;
    row.querySelector('[data-a="name"]').value = item.name || '';
    row.querySelector('[data-a="qty"]').value = item.qty || 1;
    row.querySelector('[data-a="price"]').value = item.price != null ? item.price : '';
  }
  syncAddonsJson();
}

function onAddonRowEdit(target) {
  const row = target.closest('.qm-addon');
  if (target.dataset.a === 'pick') {
    const cat = quoteAddonCatalog.find((a) => a.id === target.value);
    if (cat) {
      row.querySelector('[data-a="name"]').value = cat.name;
      row.querySelector('[data-a="price"]').value = Number(cat.price).toFixed(2);
    }
  }
  syncAddonsJson();
}

function syncAddonsJson() {
  const rows = [...document.querySelectorAll('#qfAddonRows .qm-addon:not(.qm-addon-hdr)')];
  const list = [];
  for (const row of rows) {
    const name = row.querySelector('[data-a="name"]').value.trim();
    const qty = Number(row.querySelector('[data-a="qty"]').value);
    const price = Number(row.querySelector('[data-a="price"]').value);
    const line = Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0;
    row.querySelector('.qm-line').textContent = '$' + line.toFixed(2);
    if (!name) continue;
    const pick = row.querySelector('[data-a="pick"]').value;
    list.push({ ...(pick ? { id: pick } : {}), name, qty: Number.isFinite(qty) ? qty : 0, price: Number.isFinite(price) ? price : 0 });
  }
  const hidden = $('#qf-addons');
  if (hidden) hidden.value = list.length ? JSON.stringify(list) : '';
  const box = $('#qfAddonRows');
  if (box && !rows.length) box.innerHTML = '<div class="qm-empty">No add-ons — use “＋ Add item” for boxes, locks or supplies.</div>';
  const add = $('#qfAddonAdd');
  if (add) add.disabled = rows.length >= 20; // server caps addons at 20
}

// ---------- live summary (right column) ----------
// Preview only — the Total due today input is what gets saved. quoteEstimate
// feeds the "Use estimate" button.
let quoteEstimate = null;
const money = (n) => '$' + Number(n).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function refreshQuoteTotalPreview() {
  const el = $('#qf-quoteTotalPreview');
  if (!el) return;
  const num = (id) => {
    const raw = $(id)?.value.trim() || '';
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  };
  const rate = num('#qf-rate');
  const monthsRaw = $('#qf-duration')?.value.trim() || '';
  const months = monthsRaw === '' ? 1 : Number(monthsRaw);
  const protection = num('#qf-protectionCost');
  const discount = num('#qf-promoDiscount');
  let addonsTotal = 0;
  const addonsRaw = $('#qf-addons')?.value.trim() || '';
  if (addonsRaw) {
    try {
      const parsed = JSON.parse(addonsRaw);
      const list = Array.isArray(parsed) ? parsed : [];
      addonsTotal = list.reduce((s, a) => s + (Number(a?.qty) || 0) * (Number(a?.price) || 0), 0);
    } catch { addonsTotal = NaN; }
  }
  // Header of the summary: who + which unit.
  const who = $('#qfSumWho');
  if (who) who.textContent = ($('#qf-name')?.value.trim()) || 'New customer';
  const unitEl = $('#qfSumUnit');
  if (unitEl) {
    const code = $('#qf-unit')?.value || '';
    const u = quoteUnitsCache.find((x) => x.code === code);
    const branchSel = $('#qf-branch');
    const branch = branchSel && branchSel.value ? branchSel.selectedOptions[0].textContent : '';
    const size = $('#qf-size')?.value || '';
    unitEl.textContent = u
      ? `Unit ${u.code} · ${u.size ? u.size.name || u.size.code : ''} · ${u.sqft} sqft`
      : [branch, size].filter(Boolean).join(' · ') || 'No unit selected';
  }
  const linesEl = $('#qfSumLines');
  const totalEl = $('#qfSumTotal');
  if ([rate, protection, discount, addonsTotal].some((n) => Number.isNaN(n)) || !Number.isInteger(months) || months < 1) {
    el.textContent = 'Check the highlighted pricing fields.';
    if (linesEl) linesEl.innerHTML = '';
    if (totalEl) totalEl.textContent = '—';
    quoteEstimate = null;
    return;
  }
  const estimate = Math.max(0, (rate + protection) * months + addonsTotal - discount);
  quoteEstimate = estimate;
  const m = months === 1 ? '1 month' : months + ' months';
  const lines = [
    ['Storage ' + money(rate) + ' × ' + m, rate * months],
    protection ? ['Protection ' + money(protection) + ' × ' + m, protection * months] : null,
    addonsTotal ? ['Add-ons', addonsTotal] : null,
    discount ? ['Promo' + ($('#qf-promoCode')?.value.trim() ? ' ' + $('#qf-promoCode').value.trim() : ''), -discount] : null,
  ].filter(Boolean);
  if (linesEl) {
    linesEl.innerHTML = lines.map(([k, v]) =>
      `<div${v < 0 ? ' class="neg"' : ''}><span>${escapeHtml(k)}</span><b>${v < 0 ? '−' + money(-v) : money(v)}</b></div>`).join('');
  }
  if (totalEl) totalEl.textContent = money(estimate);
  const saved = $('#qf-total')?.value.trim() || '';
  el.textContent = saved
    ? `Saving ${money(Number(saved))} as total due today.`
    : 'Estimate only — set Total due today to save a figure.';
}

// ---------- View quotation (document preview) ----------
// Mirrors src/core/quotationPdf.ts row-for-row (same labels, order, money /
// date formats and "To be confirmed" fallbacks) so operators see what the
// customer receives. Unsaved form values win; blanks fall back to the picked
// lead's stored values, like the server does on create. Keep in step with
// quotationPdf.ts when that layout changes.
let quoteSupportContact = null;

async function loadSupportContact() {
  if (quoteSupportContact) return quoteSupportContact;
  try {
    const s = await get('/settings');
    const v = s && s['operations.supportContact'];
    quoteSupportContact = typeof v === 'string' && v.trim() ? v.trim() : 'ops@storelah.sg';
  } catch {
    quoteSupportContact = 'ops@storelah.sg';
  }
  return quoteSupportContact;
}

const pdfSgd = (n) => new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD', minimumFractionDigits: 2 }).format(n);
const pdfMoney = (n) => (n == null ? 'To be confirmed' : pdfSgd(n));
const pdfDay = (d) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
const pdfDateTime = (d) => pdfDay(d) + ', ' + new Intl.DateTimeFormat('en-SG', { hour: 'numeric', minute: '2-digit', hour12: true }).format(d);

function quoteViewData() {
  const v = (id) => ($(id)?.value || '').trim();
  const num = (id) => {
    const raw = v(id);
    if (!raw) return null;
    const x = Number(raw);
    return Number.isFinite(x) && x >= 0 ? x : null;
  };
  const lead = quotableLeadCache.get(v('#qf-lead')) || {};
  const or = (val, fb) => (val !== '' && val != null ? val : fb ?? null);
  const branchId = or(v('#qf-branch'), lead.preferredBranchId);
  const branch = (state.branches || []).find((b) => b.id === branchId) || null;
  const unitCode = or(v('#qf-unit'), lead.unitCode);
  const unit = quoteUnitsCache.find((u) => u.code === unitCode) || null;
  let addons = [];
  try { addons = v('#qf-addons') ? JSON.parse(v('#qf-addons')) : []; } catch { addons = []; }
  const moveRaw = v('#qf-moveIn');
  const moving = v('#qf-movingService');
  return {
    leadName: or(v('#qf-name'), lead.name) || 'Customer',
    leadEmail: or(v('#qf-email'), lead.email),
    leadMobile: or(v('#qf-mobile'), lead.mobile),
    leadType: or(v('#qf-type'), lead.type),
    unitCode,
    unitDisplayName: unit && unit.name && unit.name !== unit.code ? unit.name : unitCode,
    unitSqft: unit ? unit.sqft : null,
    branchName: branch ? branch.name : null,
    branchAddress: branch && branch.address && branch.address.trim() ? branch.address : null,
    preferredSize: or(v('#qf-size'), lead.preferredSize),
    monthlyRate: or(num('#qf-rate'), lead.monthlyRate),
    durationMonths: Number.isInteger(num('#qf-duration')) && num('#qf-duration') >= 1 ? num('#qf-duration') : null,
    moveInDate: /^\d{4}-\d{2}-\d{2}$/.test(moveRaw) ? new Date(moveRaw + 'T00:00:00') : null,
    protectionTier: v('#qf-protectionTier') || null,
    protectionCost: num('#qf-protectionCost'),
    addons: (Array.isArray(addons) ? addons : []).filter((a) => a && a.name).slice(0, 20),
    promoCode: v('#qf-promoCode') || null,
    promoDiscountAmt: num('#qf-promoDiscount'),
    movingService: moving ? moving === 'yes' : null,
    totalDueToday: num('#qf-total'),
    note: v('#qf-note') || null,
    owner: or(v('#qf-owner'), lead.owner),
  };
}

function quoteViewHtml(d, supportContact) {
  const e = escapeHtml;
  const row = (k, val, tbc) => `<div class="qv-row"><span class="k">${e(k)}</span><span class="v${tbc ? ' tbc' : ''}">${e(val)}</span></div>`;
  const moneyRow = (k, n) => row(k, pdfMoney(n), n == null);
  const sec = (t, body) => `<section class="qv-sec"><div class="qv-sec-t">${e(t)}</div>${body}</section>`;
  const quoteNo = 'Assigned on create';
  let unitVal;
  if (d.unitCode) {
    const bit = d.unitDisplayName && d.unitDisplayName !== d.unitCode ? `${d.unitCode} (${d.unitDisplayName})` : d.unitCode;
    unitVal = row('Unit', d.unitSqft ? `${bit} - ${d.unitSqft} sqft` : bit);
  } else {
    unitVal = row('Unit', 'To be confirmed at viewing', true);
  }
  const pay = [
    moneyRow('Monthly rate', d.monthlyRate),
    d.protectionTier ? row('Protection plan', d.protectionCost != null ? `${d.protectionTier} (${pdfSgd(d.protectionCost)}/mo)` : d.protectionTier) : '',
    ...d.addons.map((a) => `<div class="qv-line"><span>${e(`${a.name} x ${a.qty}`)}</span><span>${e(pdfSgd((Number(a.price) || 0) * (Number(a.qty) || 0)))}</span></div>`),
    d.promoCode ? row('Promotion', d.promoDiscountAmt != null ? `${d.promoCode} (-${pdfSgd(d.promoDiscountAmt)})` : d.promoCode) : '',
    d.movingService ? row('Moving service', 'Requested (charged separately)') : '',
    `<div class="qv-total"><span>Total due today</span><span>${e(d.totalDueToday != null ? pdfSgd(d.totalDueToday) : 'To be confirmed')}</span></div>`,
  ].join('');
  return (
    '<header class="qv-band"><div class="qv-brand">StoreLah</div><div class="qv-tag">Self-storage, sorted.</div><div class="qv-kind">STORAGE QUOTATION</div></header>' +
    '<div class="qv-body">' +
    '<div class="qv-h1">Quotation</div>' +
    row('Quotation no.', quoteNo, true) +
    row('Issued', pdfDateTime(new Date())) +
    (d.owner ? row('Prepared by', d.owner) : '') +
    sec('Lead information',
      row('Name', d.leadName) +
      (d.leadType ? row('Account type', d.leadType) : '') +
      row('Email', d.leadEmail || '—') +
      row('Mobile', d.leadMobile || '—')) +
    sec('Unit information',
      (d.branchName ? row('Facility', d.branchName) : row('Facility', 'To be confirmed', true)) +
      (d.branchAddress ? row('Facility address', d.branchAddress) : '') +
      (d.preferredSize ? row('Preferred size', d.preferredSize) : '') +
      unitVal +
      moneyRow('Monthly rate', d.monthlyRate) +
      (d.durationMonths ? row('Duration', `${d.durationMonths} month(s)`) : '') +
      (d.moveInDate ? row('Move-in date', pdfDay(d.moveInDate)) : '')) +
    sec('Payment information', pay) +
    (d.note ? sec('Note', `<div class="qv-note">${e(d.note.slice(0, 500))}</div>`) : '') +
    '</div>' +
    '<footer class="qv-foot">' +
    'StoreLah Pte. Ltd.  |  UEN: <span class="ph">____ (to be confirmed by owner)</span><br>' +
    'Registered address: <span class="ph">____ (to be confirmed by owner)</span><br>' +
    `Questions? Contact ${e(supportContact)} and quote your quotation number.<br>` +
    'This quotation is an estimate only and is valid subject to unit availability.' +
    '</footer>'
  );
}

export async function openQuoteView() {
  const paper = $('#quoteViewPaper');
  const modal = $('#quoteViewModal');
  if (!paper || !modal) return;
  syncAddonsJson();
  const contact = await loadSupportContact();
  paper.innerHTML = quoteViewHtml(quoteViewData(), contact);
  modal.hidden = false;
  const scroller = modal.querySelector('.qv-scroll');
  if (scroller) scroller.scrollTop = 0;
  try { $('#quoteViewBack').focus({ preventScroll: true }); } catch { /* noop */ }
}

export function closeQuoteView() {
  const modal = $('#quoteViewModal');
  if (modal) modal.hidden = true;
  try { $('#qfViewQuote')?.focus({ preventScroll: true }); } catch { /* noop */ }
}

export async function openQuoteModal() {
  await ensureQuoteBranches();
  const branchSel = $('#qf-branch');
  if (branchSel) branchSel.innerHTML = quoteBranchOptions();
  await loadQuoteLeadOptions();
  await loadQuoteUnitsCache();
  await loadQuoteCatalogs();
  const form = $('#quoteForm');
  if (form) form.reset();
  const rows = $('#qfAddonRows');
  if (rows) rows.innerHTML = '';
  syncAddonsJson();
  clearQuoteFieldErrors();
  await refreshQuoteUnitOptions();
  refreshQuoteTotalPreview();
  const modal = $('#quoteModal');
  if (modal) modal.hidden = false;
}

export function closeQuoteModal() {
  const modal = $('#quoteModal');
  if (modal) modal.hidden = true;
  const view = $('#quoteViewModal');
  if (view) view.hidden = true;
  clearQuoteFieldErrors();
}

function quoteFieldError(key, msg) {
  const errEl = $('#qe-' + key);
  if (errEl) errEl.textContent = msg;
  const input = $('#qf-' + key);
  if (input) input.classList.add('err');
}

function quoteNum(id, { integer = false, min = 0 } = {}) {
  const raw = $(id)?.value.trim() || '';
  if (raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) return NaN;
  return n;
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
  const rate = quoteNum('#qf-rate');
  if (Number.isNaN(rate)) {
    quoteFieldError('rate', 'Rate must be 0 or more');
    return;
  }
  const durationMonths = quoteNum('#qf-duration', { integer: true, min: 1 });
  if (Number.isNaN(durationMonths)) {
    quoteFieldError('duration', 'Duration must be a whole month ≥ 1');
    return;
  }
  const moveInRaw = $('#qf-moveIn')?.value || '';
  if (moveInRaw && Number.isNaN(Date.parse(moveInRaw))) {
    quoteFieldError('moveIn', 'Move-in date must be a valid date');
    return;
  }
  const protectionCost = quoteNum('#qf-protectionCost');
  if (Number.isNaN(protectionCost)) {
    quoteFieldError('protectionCost', 'Protection cost must be 0 or more');
    return;
  }
  const promoDiscountAmt = quoteNum('#qf-promoDiscount');
  if (Number.isNaN(promoDiscountAmt)) {
    quoteFieldError('promoDiscount', 'Discount must be 0 or more');
    return;
  }
  const totalDueToday = quoteNum('#qf-total');
  if (Number.isNaN(totalDueToday)) {
    quoteFieldError('total', 'Total must be 0 or more');
    return;
  }
  const addonsRaw = $('#qf-addons')?.value.trim() || '';
  let addons;
  if (addonsRaw) {
    try {
      const parsed = JSON.parse(addonsRaw);
      if (!Array.isArray(parsed) || parsed.length > 20) throw new Error('bad-shape');
      addons = parsed;
    } catch {
      quoteFieldError('addons', 'Addons must be a JSON array (max 20): [{"name","qty","price"}]');
      return;
    }
  }
  const nextActionRaw = $('#qf-nextAction')?.value || '';
  if (nextActionRaw && Number.isNaN(Date.parse(nextActionRaw))) {
    quoteFieldError('nextAction', 'Next action must be a valid date');
    return;
  }
  const body = {};
  if (leadId) body.leadId = leadId;
  if (name) body.name = name;
  const type = $('#qf-type')?.value || '';
  if (type) body.type = type;
  const segment = $('#qf-segment')?.value.trim() || '';
  if (segment) body.segment = segment;
  const source = $('#qf-source')?.value || '';
  if (source) body.source = source;
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
  const unitCode = $('#qf-unit')?.value || '';
  if (unitCode) body.unitCode = unitCode;
  const protectionTier = $('#qf-protectionTier')?.value.trim() || '';
  if (protectionTier) body.protectionTier = protectionTier;
  if (protectionCost !== undefined) body.protectionCost = protectionCost;
  if (addons !== undefined) body.addons = addons;
  const promoCode = $('#qf-promoCode')?.value.trim() || '';
  if (promoCode) body.promoCode = promoCode;
  if (promoDiscountAmt !== undefined) body.promoDiscountAmt = promoDiscountAmt;
  const movingRaw = $('#qf-movingService')?.value || '';
  if (movingRaw === 'yes') body.movingService = true;
  if (movingRaw === 'no') body.movingService = false;
  if (totalDueToday !== undefined) body.totalDueToday = totalDueToday;
  const owner = $('#qf-owner')?.value.trim() || '';
  if (owner) body.owner = owner;
  // createQuoteSchema.nextActionAt is z.string().datetime() — convert the
  // date input to ISO midnight UTC (same as the lead form in admin.js).
  if (nextActionRaw) body.nextActionAt = new Date(nextActionRaw + 'T00:00:00.000Z').toISOString();
  const note = $('#qf-note')?.value.trim() || '';
  if (note) body.note = note;
  try {
    const created = await post('/quotes', body);
    closeQuoteModal();
    showBanner(quotationBanner(created), true);
    await bindQuotes();
  } catch (err) {
    // Surface server errors honestly: 400 VALIDATION (incl. per-field map),
    // 404 unknown lead/branch/unit, 409 CONFLICT|DUPLICATE, 401 auth.
    if (!renderQuoteFieldErrors(err)) showQuoteFormAlert(describeError(err));
  }
}

// Post-create banner: quoteNo + honest PDF/email outcome. The quotation
// creation itself succeeded — the suffix only reports the best-effort
// document/email step (saved + emailed, saved but skipped with reason, or
// no PDF when even persistence failed).
function quotationBanner(created) {
  const qn = created && created.quotation;
  if (!qn || !qn.quoteNo) return 'Quotation created (PDF could not be generated — see Quotes tab)';
  const emailed = qn.emailStatus === 'SENT';
  const skipped = qn.emailStatus === 'SKIPPED' && qn.emailReason ? ` (email skipped: ${qn.emailReason})` : '';
  const failed = qn.emailStatus === 'FAILED' ? ' (email failed — PDF still saved in the Quotes tab)' : '';
  return `Quotation ${qn.quoteNo} created — PDF saved${emailed ? ' + emailed' : ''}${skipped}${failed}`;
}

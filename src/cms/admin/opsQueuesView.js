// StoreLah CMS admin UI — quotes + move-outs ops queues (P1 item 4).
// Quotes: PROPOSAL_SENT leads with live inventory (GET /quotes); stage moves
// stay in Leads (PATCH /leads/:id). Move-outs: NOTICE tenants with their
// latest Notice row (GET /move-outs); explicit complete/cancel via
// PATCH /move-outs/:tenantId — nothing auto-flips tenant status.

import { $, $$, escapeHtml, showBanner } from './dom.js';
import { ApiError, get, post, downloadFile, describeError } from './api.js';
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
  // Sectioned-form live behaviour: lead auto-fill, unit narrowing, total preview.
  $('#quoteForm')?.addEventListener('change', (e) => {
    const id = e.target && e.target.id;
    if (id === 'qf-lead') autofillLeadFields(e.target.value || '');
    if (id === 'qf-branch' || id === 'qf-size') refreshQuoteUnitOptions().catch(() => {});
    refreshQuoteTotalPreview();
  });
  $('#quoteForm')?.addEventListener('input', (e) => {
    const id = e.target && e.target.id;
    if (id === 'qf-size') refreshQuoteUnitOptions().catch(() => {});
    if (['qf-rate', 'qf-duration', 'qf-protectionCost', 'qf-promoDiscount', 'qf-addons', 'qf-total'].includes(id)) refreshQuoteTotalPreview();
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
  if (l.preferredSize !== undefined && $('#qf-size')) $('#qf-size').value = l.preferredSize || '';
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

// (c) Payment information: live total preview from the component fields.
// Preview only — the Total due today input is what gets saved.
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
  if ([rate, protection, discount, addonsTotal].some((n) => Number.isNaN(n)) || !Number.isInteger(months) || months < 1) {
    el.textContent = 'Estimated total: — (check payment fields)';
    return;
  }
  const estimate = (rate + protection) * months + addonsTotal - discount;
  const saved = $('#qf-total')?.value.trim() || '';
  el.textContent = `Estimated total: $${Math.max(0, estimate).toLocaleString('en-SG', { maximumFractionDigits: 2 })}` +
    (saved ? ` · Total due today field: $${Number(saved).toLocaleString('en-SG', { maximumFractionDigits: 2 })} (saved)` : ' · fill Total due today to save this figure');
}

export async function openQuoteModal() {
  await ensureQuoteBranches();
  const branchSel = $('#qf-branch');
  if (branchSel) branchSel.innerHTML = quoteBranchOptions();
  await loadQuoteLeadOptions();
  await loadQuoteUnitsCache();
  const form = $('#quoteForm');
  if (form) form.reset();
  clearQuoteFieldErrors();
  await refreshQuoteUnitOptions();
  refreshQuoteTotalPreview();
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

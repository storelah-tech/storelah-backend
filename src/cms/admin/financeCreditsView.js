// StoreLah CMS admin UI — Credits & Refunds (spec §19). Phase 4 full content.
//
// Wallet ledger (grant/apply) per tenant, the refund calculator (spec §19.2
// formula — the server is authoritative, the UI only displays its result),
// refund requests with the maker-checker lifecycle (REQUESTED →
// APPROVED/REJECTED → PAID), explicit bank verification, and the
// negative-computation → charge path. Every refund needs a distinct
// requestor + approver; only a Super Admin single-steps (audited).

import {
  $, escapeHtml, finState, money, fmtDay, facilityOptions,
  renderLoading, renderDenied, renderError, canViewFin,
  journeyNavHtml, wireJourneyNav, getFinMount,
} from './financeShared.js';
import { get, post, request, describeError, can } from './api.js';

const PANEL = 'bill-credits';
const RSTATUSES = ['', 'REQUESTED', 'APPROVED', 'REJECTED', 'PAID'];

const viewState = { tenantId: '', wallet: null, refunds: [], rStatus: '', calc: null, createKey: '' };

function newIdemKey() {
  try {
    return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  } catch (e) {
    return `idem-${Date.now()}`;
  }
}

export async function bindFinanceCreditsView() {
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
    if (retry) retry.addEventListener('click', () => bindFinanceCreditsView());
  }
}

async function reload(host) {
  const q = new URLSearchParams();
  if (finState.branchId) q.set('branchId', finState.branchId);
  if (viewState.rStatus) q.set('status', viewState.rStatus);
  if (viewState.tenantId) q.set('tenantId', viewState.tenantId);
  const qs = q.toString();
  viewState.refunds = await get(`/finance/refunds${qs ? `?${qs}` : ''}`);
  if (viewState.tenantId) {
    try {
      viewState.wallet = await get(`/finance/credits?tenantId=${encodeURIComponent(viewState.tenantId)}`);
    } catch (e) {
      if (e && (e.status === 404 || /not found/i.test(describeError(e)))) viewState.wallet = null;
      else throw e;
    }
  } else {
    viewState.wallet = null;
  }
  renderCredits(host);
}

function rPill(s) {
  const tone = s === 'PAID' ? 'green' : (s === 'REJECTED' ? 'red' : 'amber');
  return `<span class="pill ${tone}">${escapeHtml(s)}</span>`;
}

function renderCredits(host) {
  const w = viewState.wallet;
  const rows = viewState.refunds || [];
  const calc = viewState.calc;
  host.innerHTML = journeyNavHtml(PANEL) +
    `<div class="card"><div class="card-head"><h3>Credits &amp; refunds</h3>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">` +
    `<select class="tbl-select" id="finBranch" aria-label="Facility">${facilityOptions(finState.branchId)}</select>` +
    `<input class="tbl-select" id="finTenant" placeholder="Tenant ID" aria-label="Tenant ID" value="${escapeHtml(viewState.tenantId)}" />` +
    `<select class="tbl-select" id="finRStatus" aria-label="Refund status">${RSTATUSES.map((s) => `<option value="${s}"${viewState.rStatus === s ? ' selected' : ''}>${s || 'All refund states'}</option>`).join('')}</select>` +
    `<button class="tb-btn" id="finRefresh">Refresh</button>` +
    `</div></div>` +
    `<div class="card-body"><div class="sec-sub">StoreLah Credits: $1 = $1, non-transferable, no cash value. Refunds need a distinct requestor + approver (Owner single-step is audited); bank verification is required before PAID; a negative computation becomes a charge, never a negative payment.</div></div></div>` +
    // Wallet
    `<div class="card"><div class="card-head"><h3>Credit wallet${w ? ` — ${escapeHtml(w.tenant)}` : ''}</h3>` +
    (w ? `<span class="sec-sub">Balance <b>${money(w.balance)}</b></span>` : '') +
    `</div><div class="card-body">` +
    (w
      ? `<div class="table-wrap"><table class="lead-table" aria-label="Credit wallet ledger"><thead><tr><th scope="col">Date</th><th scope="col">Kind</th><th scope="col">Amount</th><th scope="col">Actor</th><th scope="col">Note</th></tr></thead><tbody>` +
        (w.entries.length ? w.entries.map((e) =>
          `<tr><td>${fmtDay(e.createdAt)}</td><td>${escapeHtml(e.kind)}</td><td><b>${money(e.amount)}</b></td><td>${escapeHtml(e.actor || '—')}</td><td>${escapeHtml(e.note || e.refId || '—')}</td></tr>`,
        ).join('') : `<tr><td colspan="5"><div class="section-empty">No ledger entries yet.</div></td></tr>`) +
        `</tbody></table></div>` +
        (can('bill-credits:create')
          ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">` +
            `<input class="tbl-select" id="finGAmount" type="number" min="0" step="0.01" placeholder="Grant amount" aria-label="Grant amount" />` +
            `<input class="tbl-select" id="finGNote" placeholder="Note / source (optional)" aria-label="Grant note" />` +
            `<button class="tb-btn primary" id="finGGrant">Grant credits</button>` +
            `<input class="tbl-select" id="finAInvoice" placeholder="Invoice ID" aria-label="Invoice ID" />` +
            `<input class="tbl-select" id="finAAmount" type="number" min="0" step="0.01" placeholder="Amount (optional = open balance)" aria-label="Apply amount" />` +
            `<button class="tb-btn primary" id="finAApply">Apply to invoice</button></div>`
          : '')
      : `<div class="section-empty">Enter a tenant ID above to load their wallet.${can('bill-credits:create') ? ' Use Grant to open one.' : ''}</div>` +
        (can('bill-credits:create') && viewState.tenantId
          ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;"><input class="tbl-select" id="finGAmount" type="number" min="0" step="0.01" placeholder="Grant amount" aria-label="Grant amount" /><button class="tb-btn primary" id="finGGrant">Grant credits</button></div>`
          : '')) +
    `</div></div>` +
    // Calculator + request
    (can('bill-credits:create')
      ? `<div class="card"><div class="card-head"><h3>Refund calculator</h3></div><div class="card-body">` +
        `<div style="display:flex;gap:8px;flex-wrap:wrap;">` +
        `<input class="tbl-select" id="finCMonthly" type="number" min="0" step="0.01" placeholder="Monthly rent" aria-label="Monthly rent" />` +
        `<input class="tbl-select" id="finCDays" type="number" min="28" max="31" step="1" placeholder="Days in month" aria-label="Days in month" />` +
        `<input class="tbl-select" id="finCUnused" type="number" min="0" step="1" placeholder="Unused days" aria-label="Unused days" />` +
        `<input class="tbl-select" id="finCCredit" type="number" min="0" step="0.01" placeholder="Refundable credit" aria-label="Refundable credit" />` +
        `<input class="tbl-select" id="finCFee" type="number" min="0" step="0.01" placeholder="Early-termination fee" aria-label="Early-termination fee" />` +
        `<input class="tbl-select" id="finCDamage" type="number" min="0" step="0.01" placeholder="Damage charge" aria-label="Damage charge" />` +
        `<input class="tbl-select" id="finCOverride" type="number" step="0.01" placeholder="Override (optional)" aria-label="Override" />` +
        `<input class="tbl-select" id="finCReason" placeholder="Reason (required with deductions/override)" aria-label="Reason" style="min-width:220px;" />` +
        `</div><div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">` +
        `<button class="tb-btn" id="finCCalc">Calculate</button>` +
        `<button class="tb-btn primary" id="finCRequest">Request refund</button>` +
        `</div>` +
        (calc
          ? `<div class="sec-sub" style="margin-top:8px;">Prorated <b>${money(calc.prorated)}</b> · calculated <b>${money(calc.calculated)}</b> · final <b>${money(calc.final)}</b>` +
            (calc.negative ? ` — <b style="color:var(--bad,#b42318);">negative: requesting creates a charge, not a refund.</b>` : '') + `</div>`
          : `<div class="sec-sub" style="margin-top:8px;">prorated = rent ÷ days × unused; final = prorated + credit − fees − damage (or override).</div>`) +
        `</div></div>`
      : '') +
    // Register
    `<div class="card"><div class="card-head"><h3>Refunds (${rows.length})</h3></div><div class="card-body">` +
    (rows.length
      ? `<div class="table-wrap"><table class="lead-table" aria-label="Refund requests"><thead><tr><th scope="col">Refund</th><th scope="col">Customer</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Requested by</th><th scope="col">Bank verified</th><th scope="col">Action</th></tr></thead><tbody>` +
        rows.map((r) =>
          `<tr><td>${escapeHtml(r.id.slice(-8))}<br /><span class="sec-sub">${fmtDay(r.createdAt)}</span></td>` +
          `<td>${escapeHtml(r.tenant || '')}<br /><span class="sec-sub">${escapeHtml(r.reason || '')}</span></td>` +
          `<td><b>${money(r.amount)}</b>${r.bypassed ? '<br /><span class="sec-sub">owner single-step</span>' : ''}</td>` +
          `<td>${rPill(r.status)}</td>` +
          `<td>${escapeHtml(r.requestedBy || '—')}</td>` +
          `<td>${r.bankVerified ? 'Yes' : 'No'}</td>` +
          `<td>${refundActions(r)}</td></tr>`,
        ).join('') +
        `</tbody></table></div>`
      : `<div class="section-empty">No refunds match these filters.</div>`) +
    `</div></div>`;

  wireJourneyNav(host);
  const br = host.querySelector('#finBranch');
  if (br) br.addEventListener('change', () => { finState.branchId = br.value; reload(host).catch((e) => window.alert(describeError(e))); });
  const tn = host.querySelector('#finTenant');
  if (tn) tn.addEventListener('change', () => { viewState.tenantId = tn.value.trim(); reload(host).catch((e) => window.alert(describeError(e))); });
  const st = host.querySelector('#finRStatus');
  if (st) st.addEventListener('change', () => { viewState.rStatus = st.value; reload(host).catch((e) => window.alert(describeError(e))); });
  const rf = host.querySelector('#finRefresh');
  if (rf) rf.addEventListener('click', () => reload(host).catch((e) => window.alert(describeError(e))));

  const gg = host.querySelector('#finGGrant');
  if (gg) gg.addEventListener('click', async () => {
    const amount = Number(host.querySelector('#finGAmount').value);
    const note = host.querySelector('#finGNote') ? host.querySelector('#finGNote').value : '';
    if (!(amount > 0)) { window.alert('A positive grant amount is required.'); return; }
    if (!viewState.tenantId) { window.alert('A tenant ID is required.'); return; }
    try {
      await request('/finance/credits/grant', { method: 'POST', body: JSON.stringify({ tenantId: viewState.tenantId, amount, note: note.trim() || undefined }), headers: { 'Idempotency-Key': viewState.createKey } });
      viewState.createKey = newIdemKey();
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  });
  const ga = host.querySelector('#finAApply');
  if (ga) ga.addEventListener('click', async () => {
    const invoiceId = host.querySelector('#finAInvoice').value.trim();
    const raw = host.querySelector('#finAAmount').value;
    if (!invoiceId) { window.alert('An invoice ID is required.'); return; }
    try {
      const body = { tenantId: viewState.tenantId, invoiceId };
      if (raw !== '') body.amount = Number(raw);
      await request('/finance/credits/apply', { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': viewState.createKey } });
      viewState.createKey = newIdemKey();
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  });

  const cc = host.querySelector('#finCCalc');
  if (cc) cc.addEventListener('click', async () => {
    try {
      viewState.calc = await post('/finance/refunds/calculate', calcBody(host, false));
      renderCredits(host);
    } catch (e) { window.alert(describeError(e)); }
  });
  const cr = host.querySelector('#finCRequest');
  if (cr) cr.addEventListener('click', async () => {
    if (!viewState.tenantId) { window.alert('A tenant ID is required.'); return; }
    const body = calcBody(host, true);
    try {
      const out = await request('/finance/refunds', { method: 'POST', body: JSON.stringify({ tenantId: viewState.tenantId, ...body }), headers: { 'Idempotency-Key': viewState.createKey } });
      viewState.createKey = newIdemKey();
      viewState.calc = null;
      if (out && out.status === 'DRAFT') window.alert(`Negative computation — created charge ${out.no || out.id} (DRAFT, needs invoice approval).`);
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  });

  host.querySelectorAll('[data-fin-approve]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await post(`/finance/refunds/${encodeURIComponent(b.dataset.finApprove)}/approve`, { version: Number(b.dataset.finVer) });
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  }));
  host.querySelectorAll('[data-fin-reject]').forEach((b) => b.addEventListener('click', async () => {
    const reason = window.prompt('Rejection reason (required):');
    if (!reason) return;
    try {
      await post(`/finance/refunds/${encodeURIComponent(b.dataset.finReject)}/reject`, { version: Number(b.dataset.finVer), reason });
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  }));
  host.querySelectorAll('[data-fin-verify]').forEach((b) => b.addEventListener('click', async () => {
    const bankRef = window.prompt('Verified bank details (bank reference, required):');
    if (!bankRef) return;
    try {
      await post(`/finance/refunds/${encodeURIComponent(b.dataset.finVerify)}/bank-verify`, { bankRef });
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  }));
  host.querySelectorAll('[data-fin-pay]').forEach((b) => b.addEventListener('click', async () => {
    if (!window.confirm('Mark this refund PAID? Bank verification must already be recorded.')) return;
    try {
      await post(`/finance/refunds/${encodeURIComponent(b.dataset.finPay)}/pay`, { version: Number(b.dataset.finVer) });
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); reload(host).catch(() => {}); }
  }));
}

function calcBody(host, withReason) {
  const num = (id) => {
    const raw = host.querySelector(id).value;
    return raw === '' ? undefined : Number(raw);
  };
  const body = {
    monthlyRent: num('#finCMonthly'),
    daysInMonth: num('#finCDays'),
    unusedDays: num('#finCUnused'),
    refundableCredit: num('#finCCredit'),
    earlyTerminationFee: num('#finCFee'),
    damageCharge: num('#finCDamage'),
    override: num('#finCOverride'),
  };
  if (withReason || (host.querySelector('#finCReason').value || '').trim()) body.reason = host.querySelector('#finCReason').value.trim();
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
  return body;
}

function refundActions(r) {
  const out = [];
  if (r.status === 'REQUESTED' && can('bill-credits:approve')) {
    out.push(`<button class="tb-btn" data-fin-approve="${escapeHtml(r.id)}" data-fin-ver="${r.version}">Approve</button>`);
    out.push(`<button class="tb-btn" data-fin-reject="${escapeHtml(r.id)}" data-fin-ver="${r.version}">Reject</button>`);
  }
  if ((r.status === 'REQUESTED' || r.status === 'APPROVED') && !r.bankVerified && can('bill-credits:update')) {
    out.push(`<button class="tb-btn" data-fin-verify="${escapeHtml(r.id)}">Verify bank</button>`);
  }
  if (r.status === 'APPROVED' && can('bill-credits:approve')) {
    out.push(`<button class="tb-btn primary" data-fin-pay="${escapeHtml(r.id)}" data-fin-ver="${r.version}">Pay</button>`);
  }
  return out.join(' ') || '<span class="sec-sub">—</span>';
}

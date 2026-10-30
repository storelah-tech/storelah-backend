// StoreLah CMS admin UI — Invoices (spec §17). Phase 3 full content.
//
// Invoice register (all lifecycle states) + Create invoice (lines, tax hook
// at issue) + monthly billing run (DRAFTs only) + approve / issue / void
// actions with optimistic-lock versions. The legacy top-20 receivables table
// below (bindBilling in admin.js) is left intact — this workspace prepends
// above it and never wipes it.

import {
  escapeHtml, finState, money, fmtDay, facilityOptions,
  renderLoading, renderDenied, renderError, renderEmpty, canViewFin,
  journeyNavHtml, wireJourneyNav, getFinMount,
} from './financeShared.js';
import { get, post, request, describeError, can } from './api.js';

const PANEL = 'bill-invoices';
const STATUSES = ['', 'DRAFT', 'APPROVED', 'ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID', 'PAID', 'VOID', 'WRITTEN_OFF'];

const viewState = { status: '', data: null, showCreate: false, showRun: false, createKey: '' };

function newIdemKey() {
  try {
    return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  } catch (e) {
    return `idem-${Date.now()}`;
  }
}

export async function bindFinanceInvoicesView() {
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
    if (retry) retry.addEventListener('click', () => bindFinanceInvoicesView());
  }
}

async function reload(host) {
  const q = new URLSearchParams();
  if (finState.branchId) q.set('branchId', finState.branchId);
  if (viewState.status) q.set('status', viewState.status);
  const qs = q.toString();
  viewState.data = await get(`/finance/invoices${qs ? `?${qs}` : ''}`);
  renderInvoices(host);
}

function statusPill(s) {
  const tone = s === 'PAID' ? 'green' : (s === 'OVERDUE' || s === 'VOID' ? 'red' : 'amber');
  return `<span class="pill ${tone}">${escapeHtml(s)}</span>`;
}

function actionsFor(inv) {
  const out = [];
  if (inv.status === 'DRAFT' && can('bill-invoices:approve')) {
    out.push(`<button class="tb-btn" data-fin-approve="${escapeHtml(inv.id)}" data-fin-ver="${inv.version}">Approve</button>`);
  }
  if (inv.status === 'APPROVED' && can('bill-invoices:approve')) {
    out.push(`<button class="tb-btn primary" data-fin-issue="${escapeHtml(inv.id)}" data-fin-ver="${inv.version}">Issue</button>`);
  }
  if (['DRAFT', 'APPROVED', 'ISSUED', 'DUE', 'OVERDUE', 'PARTIALLY_PAID'].includes(inv.status) && can('bill-invoices:approve')) {
    out.push(`<button class="tb-btn" data-fin-void="${escapeHtml(inv.id)}" data-fin-ver="${inv.version}">Void</button>`);
  }
  return out.join(' ') || '<span class="sec-sub">—</span>';
}

function renderInvoices(host) {
  const rows = viewState.data || [];
  host.innerHTML = journeyNavHtml(PANEL) +
    `<div class="card"><div class="card-head"><h3>Invoices — billing workspace</h3>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">` +
    `<select class="tbl-select" id="finBranch" aria-label="Facility">${facilityOptions(finState.branchId)}</select>` +
    `<select class="tbl-select" id="finStatus" aria-label="Status">${STATUSES.map((s) => `<option value="${s}"${viewState.status === s ? ' selected' : ''}>${s || 'All statuses'}</option>`).join('')}</select>` +
    `<button class="tb-btn" id="finRefresh">Refresh</button>` +
    (can('bill-invoices:create') ? `<button class="tb-btn primary" id="finNewToggle">New invoice</button><button class="tb-btn" id="finRunToggle">Billing run</button>` : '') +
    `</div></div>` +
    `<div class="card-body"><div class="sec-sub">Approval required before issue — drafts and billing-run output stay DRAFT until an approver issues them. Tax is computed at issue from the GST policy (0 while GST is off).</div>` +
    `<div id="finCreateWrap"></div><div id="finRunWrap"></div></div></div>` +
    `<div class="card"><div class="card-head"><h3>Register (${rows.length})</h3></div><div class="card-body">` +
    (rows.length
      ? `<div class="table-wrap"><table class="lead-table" aria-label="Customer invoices"><thead><tr><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">Unit</th><th scope="col">Due</th><th scope="col">Total</th><th scope="col">Paid</th><th scope="col">Balance</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody>` +
        rows.map((inv) =>
          `<tr><td>${escapeHtml(inv.no)}</td><td>${escapeHtml(inv.tenant || '—')}</td><td>${escapeHtml(inv.unit || '—')}</td>` +
          `<td>${fmtDay(inv.dueDate)}</td><td><b>${money(inv.amount)}</b></td><td>${money(inv.amountPaid)}</td><td><b>${money(inv.balanceDue)}</b></td>` +
          `<td>${statusPill(inv.status)}</td><td>${actionsFor(inv)}</td></tr>`,
        ).join('') +
        `</tbody></table></div>`
      : `<div class="section-empty">No invoices match these filters.</div>`) +
    `</div></div>`;

  wireJourneyNav(host);
  const br = host.querySelector('#finBranch');
  if (br) br.addEventListener('change', () => { finState.branchId = br.value; reload(host).catch((e) => window.alert(describeError(e))); });
  const st = host.querySelector('#finStatus');
  if (st) st.addEventListener('change', () => { viewState.status = st.value; reload(host).catch((e) => window.alert(describeError(e))); });
  const rf = host.querySelector('#finRefresh');
  if (rf) rf.addEventListener('click', () => reload(host).catch((e) => window.alert(describeError(e))));

  const nt = host.querySelector('#finNewToggle');
  if (nt) nt.addEventListener('click', () => { viewState.showCreate = !viewState.showCreate; renderCreateForm(host); });
  const rt = host.querySelector('#finRunToggle');
  if (rt) rt.addEventListener('click', () => { viewState.showRun = !viewState.showRun; renderRunForm(host); });
  renderCreateForm(host);
  renderRunForm(host);

  host.querySelectorAll('[data-fin-approve]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!window.confirm('Approve this draft? It becomes APPROVED (issuable), not yet receivable.')) return;
      try {
        await post(`/finance/invoices/${b.dataset.finApprove}/approve`, { version: Number(b.dataset.finVer) });
        reload(host).catch((e) => window.alert(describeError(e)));
      } catch (e) { window.alert(describeError(e)); reload(host).catch(() => {}); }
    });
  });
  host.querySelectorAll('[data-fin-issue]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!window.confirm('Issue this invoice? Tax is computed now from the GST policy, and a payment instruction is queued (no charge).')) return;
      try {
        await post(`/finance/invoices/${b.dataset.finIssue}/issue`, { version: Number(b.dataset.finVer) });
        reload(host).catch((e) => window.alert(describeError(e)));
      } catch (e) { window.alert(describeError(e)); reload(host).catch(() => {}); }
    });
  });
  host.querySelectorAll('[data-fin-void]').forEach((b) => {
    b.addEventListener('click', async () => {
      const reason = window.prompt('Void reason (required, recorded in the audit trail):');
      if (reason === null) return;
      if (!reason.trim()) { window.alert('A void reason is required.'); return; }
      try {
        await post(`/finance/invoices/${b.dataset.finVoid}/void`, { version: Number(b.dataset.finVer), reason: reason.trim() });
        reload(host).catch((e) => window.alert(describeError(e)));
      } catch (e) { window.alert(describeError(e)); reload(host).catch(() => {}); }
    });
  });
}

function renderCreateForm(host) {
  const wrap = host.querySelector('#finCreateWrap');
  if (!wrap) return;
  if (!viewState.showCreate) { wrap.innerHTML = ''; return; }
  wrap.innerHTML =
    `<div class="card"><div class="card-head"><h3>New invoice (DRAFT)</h3></div><div class="card-body">` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;">` +
    `<input class="tbl-select" id="finCTenant" placeholder="Tenant ID" aria-label="Tenant ID" />` +
    `<input class="tbl-select" id="finCUnit" placeholder="Unit ID (optional — tenant default)" aria-label="Unit ID" />` +
    `<input class="tbl-select" id="finCDue" type="date" aria-label="Due date" />` +
    `<input class="tbl-select" id="finCStart" type="date" aria-label="Service start (optional)" />` +
    `<input class="tbl-select" id="finCEnd" type="date" aria-label="Service end (optional)" />` +
    `</div>` +
    `<div class="sec-sub" style="margin:8px 0;">Lines — one per row: <code>RENT|FEE|ADJUSTMENT · label · amount</code> (e.g. <code>RENT · Storage rent — September · 200</code>). Tax is computed at issue, never entered.</div>` +
    `<textarea class="tbl-select" id="finCLines" rows="3" style="width:100%;" placeholder="RENT · Storage rent · 200"></textarea>` +
    `<div style="display:flex;gap:8px;margin-top:8px;"><button class="tb-btn primary" id="finCCreate">Create draft</button></div>` +
    `</div></div>`;
  const go = wrap.querySelector('#finCCreate');
  if (go) go.addEventListener('click', async () => {
    const lineRows = String(wrap.querySelector('#finCLines').value || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const lines = [];
    for (const row of lineRows) {
      const parts = row.split(/[·|]/).map((s) => s.trim());
      if (parts.length < 3) { window.alert(`Bad line (need kind · label · amount): ${row}`); return; }
      const amount = Number(parts[2]);
      if (!Number.isFinite(amount)) { window.alert(`Bad amount: ${parts[2]}`); return; }
      lines.push({ kind: parts[0].toUpperCase(), label: parts[1], amount });
    }
    const due = wrap.querySelector('#finCDue').value;
    if (!wrap.querySelector('#finCTenant').value.trim() || !due || !lines.length) {
      window.alert('Tenant, due date and at least one line are required.');
      return;
    }
    const body = {
      tenantId: wrap.querySelector('#finCTenant').value.trim(),
      dueDate: new Date(`${due}T00:00:00Z`).toISOString(),
      lines,
    };
    const unit = wrap.querySelector('#finCUnit').value.trim();
    if (unit) body.unitId = unit;
    const start = wrap.querySelector('#finCStart').value;
    if (start) body.serviceStart = new Date(`${start}T00:00:00Z`).toISOString();
    const end = wrap.querySelector('#finCEnd').value;
    if (end) body.serviceEnd = new Date(`${end}T00:00:00Z`).toISOString();
    try {
      // Idempotency-Key: double-clicks / retries of the same form converge on
      // one draft; a fresh key is minted for the next form.
      await request('/finance/invoices', { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': viewState.createKey } });
      viewState.createKey = newIdemKey();
      viewState.showCreate = false;
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) { window.alert(describeError(e)); }
  });
}

function renderRunForm(host) {
  const wrap = host.querySelector('#finRunWrap');
  if (!wrap) return;
  if (!viewState.showRun) { wrap.innerHTML = ''; return; }
  const now = new Date();
  const defMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  wrap.innerHTML =
    `<div class="card"><div class="card-head"><h3>Monthly billing run</h3></div><div class="card-body">` +
    `<div class="sec-sub">Creates one DRAFT per active billable tenant for the month — run twice, get one draft set (idempotent). Drafts need approval before issue. No late fees, no charges.</div>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">` +
    `<select class="tbl-select" id="finRBranch" aria-label="Facility">${facilityOptions(finState.branchId)}</select>` +
    `<input class="tbl-select" id="finRMonth" type="month" value="${defMonth}" aria-label="Billing month" />` +
    `<input class="tbl-select" id="finRDue" type="date" aria-label="Due date (optional, defaults to month end)" />` +
    `<button class="tb-btn primary" id="finRGo">Run billing</button></div>` +
    `<div id="finROut" style="margin-top:8px;"></div>` +
    `</div></div>`;
  const go = wrap.querySelector('#finRGo');
  if (go) go.addEventListener('click', async () => {
    const branchId = wrap.querySelector('#finRBranch').value || finState.branchId;
    const billingMonth = wrap.querySelector('#finRMonth').value;
    const dueRaw = wrap.querySelector('#finRDue').value;
    if (!branchId || !billingMonth) { window.alert('Facility and billing month are required.'); return; }
    if (!window.confirm(`Run billing for ${billingMonth}? This creates DRAFT invoices only.`)) return;
    const out = wrap.querySelector('#finROut');
    try {
      const body = { branchId, billingMonth };
      if (dueRaw) body.dueDate = new Date(`${dueRaw}T00:00:00Z`).toISOString();
      const res = await post('/finance/billing-run', body);
      if (out) out.innerHTML = `<div class="sec-sub">Run complete — created <b>${res.created}</b>, reused <b>${res.reused}</b>, skipped <b>${res.skipped.length}</b>.${res.skipped.length ? ` Skipped: ${res.skipped.map((s) => `${escapeHtml(s.tenant)} (${escapeHtml(s.reason)})`).join('; ')}` : ''}</div>`;
      reload(host).catch((e) => window.alert(describeError(e)));
    } catch (e) {
      if (out) out.innerHTML = `<div class="section-empty">Run failed: ${escapeHtml(describeError(e))}</div>`;
      else window.alert(describeError(e));
    }
  });
}

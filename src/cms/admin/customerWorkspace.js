// StoreLah CMS admin UI — Customer profile (owner prototype 2026-11-04,
// docs/prototype-updates/storelah-prototype-updates-2026-11-04.md).
//
// Prototype parity: the Customer 360 page, Agreement/Services cards and ledger
// are adapted from the owner's prototype (crm-ux-v2.js customerProfileHtml +
// v29-request.js). Track A A7: every move-out / transfer / refund action runs
// the canonical A3–A6 CMS routes (move-out cases, transfers, settlement
// finance, roll-up) via src/cms/admin/moveoutWorkspace.js — the pre-A3
// direct-settlement dialogs are retired, and every amount is server-calculated
// with Finance approval before anything posts.

import { escapeHtml as esc, showBanner } from './dom.js';
import { get, post, can, describeError } from './api.js';
import { openModal, closeModal, notesHtml, saveNote } from './leadsWorkspace.js';
import { openRecordRequest, openTransferPreview, openManualRefund, openChangeStatus, openFinanceRecord, casePill, settlePill, moStatusText, ensureMoPillStyle } from './moveoutWorkspace.js';

const money = (v) => new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' }).format(Number(v) || 0);
const sgYmd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
function humanDate(v) {
  if (!v) return '—';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? v + 'T00:00:00Z' : v);
  return isNaN(d) ? '—' : new Intl.DateTimeFormat('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}
const initials = (s) => String(s || '?').split(/\s+/).slice(0, 2).map((x) => x[0] || '').join('').toUpperCase();
const notify = (m) => window.cmsToast?.(m);
const val = (id) => document.getElementById(id)?.value ?? '';
const goPage = (id) => window.StoreLahAdmin?.openPage?.(id);
const STATUS_LABEL = { ACTIVE: 'Active', DUE_SOON: 'Payment due soon', OVERDUE: 'Payment attention', NOTICE: 'Move-out notice', INACTIVE: 'Inactive', PENDING_MOVE_OUT: 'Pending move-out', PAYMENT_ATTENTION: 'Payment attention', ACCESS_RESTRICTED: 'Access restricted', SUSPENDED: 'Suspended', FORMER_CUSTOMER: 'Former customer' };
const STATUS_TONE = { ACTIVE: 'green', DUE_SOON: 'amber', OVERDUE: 'red', NOTICE: 'amber', INACTIVE: 'grey', PENDING_MOVE_OUT: 'amber', PAYMENT_ATTENTION: 'red', ACCESS_RESTRICTED: 'amber', SUSPENDED: 'red', FORMER_CUSTOMER: 'grey' };
// Settlement/transfer/ledger/doc states share the §5 finance pill language:
// canonical labels + tone, never a raw SNAKE enum. Unknown values humanize.
const cwStatusLabel = (s) => moStatusText(s);
const cwLedgerPill = (s) => {
  const k = String(s ?? '').toUpperCase();
  const tone = /REFUNDED|POSTED|TRANSFERRED|PAID|ALLOCATED|APPROVED/.test(k) ? 'green' : /REJECTED|OVERDUE|FAILED/.test(k) ? 'red' : /REVERSED|CANCELLED/.test(k) ? 'grey' : /ACTIVE|PROCESSING|REVIEW/.test(k) ? 'blue' : 'amber';
  return `<span class="pill ${tone}">${esc(cwStatusLabel(s))}</span>`;
};

let current = null; // last loaded profile
let tab = 'overview';

async function busy(btn, fn) {
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try { await fn(); } catch (err) { notify(describeError(err)); } finally { if (btn) btn.disabled = false; }
}

function ensurePage() {
  let page = document.getElementById('customer-profile');
  if (!page) {
    page = document.createElement('section');
    page.id = 'customer-profile';
    page.className = 'page';
    document.querySelector('.content')?.appendChild(page);
  }
  return page;
}

export async function openCustomerProfile(tenantId, keepTab) {
  try {
    ensureMoPillStyle();
    const [c, notes, rollup] = await Promise.all([
      get(`/tenants/${encodeURIComponent(tenantId)}/profile`),
      get(`/tenants/${encodeURIComponent(tenantId)}/notes`),
      // Track A A6 read model: previous units, transfer history, posted
      // ledger lines, documents. Failure degrades to empty sections (§19) —
      // never blocks the profile.
      get(`/tenants/${encodeURIComponent(tenantId)}/rollup`).catch(() => null),
    ]);
    current = c;
    try { sessionStorage.setItem('storelah.lastCustomerId', c.id); } catch { /* noop */ }
    if (!keepTab) tab = 'overview';
    const page = ensurePage();
    page.innerHTML = profileHtml(c, notes, rollup);
    page.dataset.tenantId = c.id;
    goPage('customer-profile');
    if (tab === 'movement') loadMovementCases();
  } catch (err) { showBanner('Customer: ' + describeError(err)); }
}

// Refresh handle for Track A actions (status editor, case workspace).
window.StoreLahCustomer = { openProfile: (id, keep) => openCustomerProfile(id, keep) };

function unitFacts(u) {
  return `<div class="v29-facts"><div><small>Agreement signed</small><b>${esc(humanDate(u.agreementSigned))}</b></div><div><small>Move-in date</small><b>${esc(humanDate(u.moveIn))}</b></div><div><small>Committed duration</small><b>${esc(u.commitment || 'Monthly · no fixed term')}</b></div><div><small>Commitment ends</small><b>${esc(humanDate(u.commitmentEnd))}</b></div><div><small>Time remaining</small><b>${esc(u.remaining || '—')}</b></div><div><small>Protection Plan</small><b>${u.protectionMonthly != null ? money(u.protectionMonthly) + ' / month' : 'Not recorded'}</b></div></div>`;
}

function profileHtml(c, notes, rollup) {
  const u0 = c.units[0];
  const editable = can('customer-tenants:update');
  const canStatus = can('customer-tenants:update');
  const OPEN_SETTLE = new Set(['PENDING', 'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED', 'PROCESSING']);
  const tabs = [['overview', 'Overview'], ['rental', 'Rental & pricing'], ['billing', 'Billing & payments'], ['documents', 'Documents'], ['access', 'Access'], ['movement', 'Move-out & transfers'], ['notes', 'Notes & activity']];
  const pending = c.settlements.filter((s) => OPEN_SETTLE.has(s.status));
  const facilityCount = new Set((c.units || []).map((u) => u.facility)).size;
  const settleTone = (s) => s === 'APPROVED' || s === 'POSTED' || s === 'REFUNDED' ? 'green' : s === 'REJECTED' || s === 'FAILED' || s === 'CHANGES_REQUESTED' ? 'red' : s === 'CANCELLED' ? 'grey' : s === 'PROCESSING' || s === 'SETTLEMENT_REVIEW' ? 'blue' : 'amber';
  const settleLabel = (s) => ({ PENDING: 'Pending approval', PENDING_APPROVAL: 'Pending approval', CHANGES_REQUESTED: 'Changes requested', APPROVED: 'Approved', PROCESSING: 'Processing', REFUNDED: 'Refunded', POSTED: 'Posted', FAILED: 'Failed', CANCELLED: 'Cancelled', REJECTED: 'Rejected' }[s] || cwStatusLabel(s));
  return `<div class="v2-customer-hero"><div class="v2-person"><div class="avatar">${esc(initials(c.name))}</div><div><button class="v2-name" data-cw="back">← Customer list</button><h1>${esc(c.name)}</h1><p>${c.type === 'BUSINESS' ? 'Business' : 'Personal'} customer${c.uen ? ' · UEN ' + esc(c.uen) : ''}</p><div class="v2-contactline">${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.mobile ? `<a href="tel:${esc(c.mobile)}">${esc(c.mobile)}</a>` : ''}</div><div class="v2-tags"><span class="pill ${STATUS_TONE[c.status] || 'grey'}">${esc(STATUS_LABEL[c.status] || cwStatusLabel(c.status))}</span>${rollup?.derivedStatusLabel && rollup.derivedStatusLabel !== (STATUS_LABEL[c.status] || cwStatusLabel(c.status)) ? `<span class="pill blue">${esc(rollup.derivedStatusLabel)}</span>` : ''}<span class="sync-badge">Customer record synced</span></div></div></div><div class="v2-hero-actions">${editable && u0 ? `<button class="btn" data-cw="transfer">Preview transfer</button><button class="btn" data-cw="moveout">Record move-out request</button>` : ''}${canStatus ? `<button class="btn" data-cw="status" data-perm="customer-tenants:update">Change status</button>` : ''}<button class="primary" data-cw="tab" data-tab="notes">＋ Note</button></div></div>
  <div class="v2-profile-kpis"><div class="v2-profile-kpi"><small>Customer since</small><b>${esc(humanDate(c.since))}</b><span>First move-in</span></div><div class="v2-profile-kpi"><small>Revenue to date</small><b>${money(c.revenueToDate)}</b><span>Payments allocated</span></div><div class="v2-profile-kpi"><small>Active units</small><b>${c.units.length}</b><span>${facilityCount} facilit${facilityCount === 1 ? 'y' : 'ies'}</span></div><div class="v2-profile-kpi"><small>Monthly unit deductions</small><b>${money(c.monthlyDeductions)}</b><span>Rent + protection by unit</span></div><div class="v2-profile-kpi"><small>Security deposits held</small><b>${money(c.depositsHeld)}</b><span>Configured as $0 at launch</span></div></div>
  ${pending.length ? `<div class="v2-alerts"><div class="v2-alert"><i>$</i><div><b>${pending.length} settlement${pending.length === 1 ? '' : 's'} awaiting Finance approval</b><small>${pending.map((s) => esc(s.ref)).join(', ')} · the unit and billing schedule are unchanged until approval.</small></div></div></div>` : ''}
  <div class="v2-tabs" role="tablist">${tabs.map(([k, l]) => `<button class="${k === tab ? 'active' : ''}" data-cw="tab" data-tab="${k}">${l}</button>`).join('')}</div>
  <div class="v2-panel ${tab === 'overview' ? 'active' : ''}" data-cw-panel="overview"><div class="v2-card"><div class="v2-card-head"><div><h3>Identity and contact</h3><p>Email and mobile remain editable from the customer list.</p></div></div><div class="v2-card-body"><div class="v2-info"><div><small>${c.type === 'BUSINESS' ? 'Company name' : 'Name'}</small><b>${esc(c.name)}</b></div>${c.uen ? `<div><small>UEN</small><b>${esc(c.uen)}</b></div>` : ''}<div><small>Email</small><b>${esc(c.email || '—')}</b></div><div><small>Mobile</small><b>${esc(c.mobile || '—')}</b></div></div></div></div>
    <div class="v29-customer-section"><div class="v29-customer-grid">${c.units.map((u) => `<div class="v29-customer-card"><header><div><h3>Agreement and move-in · ${esc(u.unitName ?? u.unitCode)}</h3><p>Key customer lifecycle dates</p></div><span class="pill ${STATUS_TONE[u.status] || 'grey'}">${esc(STATUS_LABEL[u.status] || cwStatusLabel(u.status))}</span></header><div class="body">${unitFacts(u)}</div></div>`).join('')}<div class="v29-customer-card"><header><div><h3>Services and add-ons</h3><p>Requests outside monthly storage rent</p></div>${editable ? '<button class="btn" data-cw="service">＋ Add request</button>' : ''}</header><div class="body"><div class="v29-facts"><div><small>Moving service</small><b>${u0?.movingService ? 'Requested at booking' : 'Not requested'}</b></div><div><small>Protection Plan</small><b>${u0?.protectionMonthly != null ? money(u0.protectionMonthly) + ' / month' + (u0.protectionTier ? ' · ' + esc(u0.protectionTier) : '') : 'Not recorded'}</b></div><div><small>Ledger treatment</small><b>Separate line items</b></div></div></div></div></div></div></div>
  <div class="v2-panel ${tab === 'rental' ? 'active' : ''}" data-cw-panel="rental">${c.units.map((u) => `<div class="v29-customer-card v29-rental-lifecycle" style="margin-bottom:14px"><header><div><h3>Rental commitment and recurring charges · ${esc(u.unitName ?? u.unitCode)}</h3><p>Commitment controls early-exit treatment; rent is still billed monthly.</p></div><span class="pill ${u.withinCommitment ? 'amber' : 'green'}">${u.withinCommitment ? 'Within commitment' : 'Commitment completed'}</span></header><div class="body"><div class="v29-facts"><div><small>Agreement signed</small><b>${esc(humanDate(u.agreementSigned))}</b></div><div><small>Move-in</small><b>${esc(humanDate(u.moveIn))}</b></div><div><small>Initial commitment</small><b>${esc(u.commitment || 'Monthly')}</b></div><div><small>Commitment end</small><b>${esc(humanDate(u.commitmentEnd))}</b></div><div><small>Remaining</small><b>${esc(u.remaining || '—')}</b></div><div><small>Rack rate</small><b>${money(u.rackRate ?? u.grossRent)}</b></div><div><small>Promotion</small><b>${esc(u.promotionLabel || 'None')}${u.promotionDetail ? ` · ${esc(u.promotionDetail)}` : ''}</b></div><div><small>Net monthly rent</small><b>${money(u.netRent)}</b></div><div><small>Protection Plan monthly</small><b>${u.protectionMonthly != null ? money(u.protectionMonthly) : '—'}</b></div><div><small>Billing frequency</small><b>${esc(u.billingFrequency)}</b></div></div></div></div>`).join('') || '<div class="v29-empty"><b>No active unit</b><span>This customer has no unit assigned.</span></div>'}
    <div class="v2-card"><div class="v2-card-head"><div><h3>Units, commitment and pricing</h3><p>Each unit retains its own rent, promotion, protection plan, deposit and billing schedule.</p></div><span class="pill blue">${c.units.length} unit${c.units.length === 1 ? '' : 's'}</span></div><div class="v2-card-body"><div class="v2-unit-list">${c.units.map((u) => `<div class="v2-unit"><div><b>${esc(u.unitName ?? u.unitCode)}</b><small>${esc(u.facility || '')}${u.level != null ? ' · Level ' + u.level : ''} · ${esc(u.size || '')} · ${u.sqft} sq ft</small></div><div><small>Commitment position</small><b>${esc(u.remaining || 'Monthly')}</b><small>Rent is still collected monthly</small></div><div><small>Pricing</small><b>${money(u.netRent)} rent</b><small>Rack rate ${money(u.rackRate ?? u.grossRent)}</small></div><div><small>Promotion</small><b>${esc(u.promotionLabel || 'None')}</b><small>${esc(u.promotionDetail || (u.promotionLabel ? 'Applied to term' : 'Standard rack rate'))}</small></div><div><small>Security deposit</small><b>${money(u.deposit)}</b><small>Launch policy: waived</small></div></div>`).join('')}</div></div></div>
    <div class="v2-card" style="margin-top:14px"><div class="v2-card-head"><div><h3>Previous units · transfer history</h3><p>Ended rentals stay visible with tenure, billing and the transfer record.</p></div>${rollup ? `<span class="pill grey">${rollup.previousRentals.length} former</span>` : ''}</div><div class="v2-card-body">${previousUnitsHtml(rollup)}</div></div></div>
  <div class="v2-panel ${tab === 'billing' ? 'active' : ''}" data-cw-panel="billing"><div class="v2-card"><div class="v2-card-head"><div><h3>Next deductions by unit</h3><p>Even multi-unit customers are charged and reconciled at unit level.</p></div><span class="sync-badge">Finance synced</span></div><div class="v2-card-body"><div class="v2-unit-list">${c.units.map((u) => `<div class="v2-unit"><div><b>${esc(u.unitName ?? u.unitCode)}</b><small>Next payment ${esc(humanDate(u.nextPayment))}</small></div><div><small>Rent</small><b>${money(u.netRent)}</b></div><div><small>Protection plan</small><b>${money(u.protectionMonthly || 0)}</b></div><div><small>Total deduction</small><b class="amount">${money(u.netRent + (u.protectionMonthly || 0))}</b></div></div>`).join('')}</div><div class="v2-page-note" style="margin:12px 0 0"><i>i</i><div><b>Monthly payment basis</b>A commitment controls eligibility and early-exit treatment; it does not mean StoreLah collects the whole committed term upfront.</div></div></div></div>
    <div class="v29-customer-card v29-ledger" style="margin-top:14px"><header><div><h3>Customer ledger</h3><p>Every billed, credited, paid or refunded line—storage, Protection Plan, merchandise and services.</p></div><button class="btn" data-cw="ledger-export">Export ledger</button></header><div class="body"><div class="table-wrap"><table class="v29-ledger-table"><thead><tr><th>Date</th><th>Document</th><th>Unit</th><th>Line item</th><th>Status</th><th>Debit</th><th>Credit / payment</th></tr></thead><tbody>${c.ledger.map((l) => `<tr><td>${esc(humanDate(l.date))}</td><td>${esc(l.document)}</td><td>${esc(l.unit)}</td><td>${esc(l.lineItem)}</td><td><span class="pill ${/Paid|Allocated|Approved/.test(l.status) ? 'green' : /Overdue|Rejected/.test(l.status) ? 'red' : 'amber'}">${esc(cwStatusLabel(l.status))}</span></td><td>${l.debit == null ? '—' : money(l.debit)}</td><td>${l.credit == null ? '—' : money(l.credit)}</td></tr>`).join('') || '<tr><td colspan="7" style="text-align:center;padding:20px">No billed lines yet.</td></tr>'}</tbody></table></div><div class="v29-callout" style="margin:14px 0 0"><i>↔</i><div><b>Clean refund route</b>Start a refund from this customer context or a move-out preview. Review, approve and process it in Finance → Transactions, documents &amp; approvals. There is no competing standalone refund module.</div>${editable && u0 ? '<button class="btn" data-cw="refund" data-perm="bill-transactions:create">Start refund request</button>' : ''}</div></div></div>
    <div class="v29-customer-card v29-ledger" style="margin-top:14px"><header><div><h3>Settlement &amp; transfer postings</h3><p>Processed refunds, posted charges and posted transfers; pending requests stay visible but move no money.</p></div></div><div class="body">${ledgerPostingsHtml(rollup)}</div></div></div>
  <div class="v2-panel ${tab === 'documents' ? 'active' : ''}" data-cw-panel="documents"><div class="v2-card"><div class="v2-card-head"><div><h3>Customer documents</h3><p>Agreement, invoice and receipt records remain linked—not duplicated.</p></div><button class="btn" data-cw="documents">Open financial documents</button></div><div class="v2-card-body doc-list">${c.units.map((u) => `<div class="doc-row"><div class="doc-icon">AGR</div><div><b>Storage agreement · ${esc(u.unitName ?? u.unitCode)}</b><small>${u.bookingRef ? 'Booking ' + esc(u.bookingRef) + ' · signed ' + esc(humanDate(u.agreementSigned)) : 'No booking on file'}</small></div></div>`).join('')}<div class="doc-row"><div class="doc-icon">INV</div><div><b>Invoices and receipts</b><small>Open from the combined Transactions &amp; Documents register</small></div><button class="btn" data-cw="documents">View all</button></div>${rollupDocumentsHtml(rollup)}</div></div></div>
  <div class="v2-panel ${tab === 'access' ? 'active' : ''}" data-cw-panel="access"><div class="v2-card"><div class="v2-card-head"><div><h3>Access</h3><p>Credentials are scoped to facility and agreement.</p></div></div><div class="v2-card-body"><div class="v2-info">${c.units.map((u) => `<div><small>${esc(u.unitName ?? u.unitCode)}</small><b>${esc(STATUS_LABEL[u.status] || cwStatusLabel(u.status))}</b></div>`).join('')}</div><p class="v29-help" style="margin-top:10px">PINs and access activity are managed in Facilities › Access Control.</p></div></div></div>
  <div class="v2-panel ${tab === 'movement' ? 'active' : ''}" data-cw-panel="movement"><div class="v29-callout v29-movement-note"><i>i</i><div><b>Staff-assisted workflows are supported</b>Record a customer move-out request received by WhatsApp, phone, email or onsite, or preview a unit transfer. Both show a server-calculated financial preview, and nothing posts until Finance approval.</div></div><div class="v29-callout"><i>···</i><div><b>More actions</b><span>Every move-out, transfer and refund entry point lives here.</span></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${editable && u0 ? '<button class="btn" data-cw="moveout">Record move-out notice</button><button class="btn" data-cw="transfer">Transfer unit</button>' : ''}<button class="btn" data-cw="documents">Transactions &amp; documents</button></div></div><div class="v2-profile-grid equal"><div class="v2-card"><div class="v2-card-head"><div><h3>Move-out notices</h3><p>Customer-level history; financial impact is calculated per unit.</p></div>${editable && u0 ? '<button class="primary" data-cw="moveout" data-perm="customer-moveouts:create">Record move-out request</button>' : ''}</div><div class="v2-card-body"><div class="v2-timeline" id="cwMoveoutCases"><div class="v2-event"><b>Loading move-out requests…</b></div></div></div></div><div class="v2-card"><div class="v2-card-head"><div><h3>Unit transfers</h3><p>Pricing and promotions on the destination unit take precedence.</p></div>${editable && u0 ? '<button class="primary" data-cw="transfer" data-perm="customer-transfers:create">Preview transfer</button>' : ''}</div><div class="v2-card-body"><div class="v2-page-note" style="margin:0"><i>$</i><div><b>Finance approval required</b>The preview shows source-unit credits, destination rent, security deposit and non-prorated protection-plan treatment before submission.</div></div></div></div></div>
    <div id="cwCasesWrap" style="margin-top:14px"><div class="section-empty">Loading move-out cases &amp; transfers…</div></div>
    <div class="v2-card" style="margin-top:14px"><div class="v2-card-head"><h3>Settlements</h3></div><div class="table-wrap"><table class="v2-table"><thead><tr><th>Record</th><th>Type</th><th>Date</th><th>Amount</th><th>Status</th><th>Requested / decided</th></tr></thead><tbody>${c.settlements.map((s) => `<tr><td><b>${esc(s.ref)}</b></td><td>${esc(s.docType)}</td><td>${esc(humanDate(s.effectiveDate))}</td><td>${s.amount < 0 ? 'Refund ' + money(-s.amount) : 'Customer pays ' + money(s.amount)}</td><td><span class="pill ${settleTone(s.status)}">${esc(settleLabel(s.status))}</span></td><td>${esc(s.requestedBy)}${s.decidedBy ? `<small>${esc(s.decidedBy)}${s.decisionNote ? ' · ' + esc(s.decisionNote) : ''}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:20px">No transfers or move-out settlements yet.</td></tr>'}</tbody></table></div></div></div>
  <div class="v2-panel ${tab === 'notes' ? 'active' : ''}" data-cw-panel="notes"><div class="note-composer"><textarea id="lwCustNoteBody" data-mention="1" placeholder="Add an internal note; use @Name to notify a colleague…"></textarea><div class="note-composer-foot"><span class="mention-hint">Mentioned users receive an overview notification</span><button class="primary" data-lw="note-save" data-entity="tenant" data-id="${esc(c.id)}">Add note</button></div></div><div id="lwCustNotes">${notesHtml(notes)}</div></div>`;
}

// ---------------------------------------------------------------------------
// Track A roll-up sections (A6 read model — previous units, postings, docs)
// ---------------------------------------------------------------------------
function previousUnitsHtml(rollup) {
  if (!rollup) return '<div class="section-empty">Previous-unit history failed to load — the current rentals above are unaffected. Reopen the profile to retry.</div>';
  const prev = rollup.previousRentals || [];
  const hist = rollup.transferHistory || [];
  if (!prev.length && !hist.length) return '<div class="section-empty">No previous units yet. Ended rentals and posted transfers stay here with tenure, billing and the transfer record.</div>';
  return `${prev.map((p) => `<div class="v2-unit"><div><b>${esc(p.unitName || p.unitCode || '')}</b><small>${esc(p.facility || '')} · ${esc(p.statusLabel || 'Former rental')}</small></div><div><small>Rental period</small><b>${esc(humanDate(p.startedAt))} → ${esc(humanDate(p.endedAt))}</b><small>${esc(p.endReason || '')}</small></div><div><small>Storage rent billed</small><b>${money((p.billedTotals && p.billedTotals.storageRent) || 0)}</b>${p.transferCredit != null ? `<small>Transfer credit −${money(Math.abs(p.transferCredit))}</small>` : ''}</div><div><small>Transfer</small>${p.sourceRef ? `<button class="btn" data-cw="open-transfer" data-id="${esc(p.sourceRef)}" data-perm="bill-transactions:view">Open transfer record</button>` : '<b>—</b>'}<small><button class="v2-name" data-cw="tab" data-tab="billing">View historical ledger</button></small></div></div>`).join('')}
  ${hist.length ? `<div class="v29-help" style="margin-top:10px"><b>Transfer history</b></div><div class="table-wrap"><table class="v2-table"><thead><tr><th>Record</th><th>From → to</th><th>Effective</th><th>Net</th><th>Status</th><th></th></tr></thead><tbody>${hist.map((t) => `<tr><td><b>${esc(t.ref)}</b></td><td>${esc(t.fromUnitName || t.fromUnitCode || '—')} → ${esc(t.toUnitName || t.toUnitCode || '—')}</td><td>${esc(humanDate(t.effectiveDate))}</td><td>${Number(t.amount) < 0 ? 'Credit ' + money(-Number(t.amount)) : money(Number(t.amount))}</td><td>${settlePill(t.status)}</td><td><button class="btn" data-cw="open-transfer" data-id="${esc(t.id)}" data-perm="bill-transactions:view">Open transfer record</button></td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

function ledgerPostingsHtml(rollup) {
  if (!rollup) return '<div class="section-empty">Settlement postings failed to load — reopen the profile to retry.</div>';
  const lines = rollup.ledgerLines || [];
  const open = rollup.openSettlements || [];
  if (!lines.length && !open.length) return '<div class="section-empty">No processed refunds, posted charges or posted transfers yet. Pending requests appear here once Finance receives them.</div>';
  return `<div class="table-wrap"><table class="v29-ledger-table"><thead><tr><th>Date</th><th>Document</th><th>Unit</th><th>Line item</th><th>Status</th><th>Debit</th><th>Credit / payment</th></tr></thead><tbody>${lines.map((l) => `<tr><td>${esc(humanDate(l.postedAt))}</td><td>${esc(l.settlementRef || l.invoiceRef || '—')}</td><td>${esc(l.unitName || l.unitCode || '—')}</td><td>${esc(l.label)}</td><td>${cwLedgerPill(l.status)}</td><td>${l.debit == null ? '—' : money(l.debit)}</td><td>${l.credit == null ? '—' : money(l.credit)}</td></tr>`).join('')}${open.map((s) => `<tr><td>—</td><td>${esc(s.ref)}</td><td>—</td><td>Pending Finance decision — no money moved</td><td>${settlePill(s.status)}</td><td>—</td><td>—</td></tr>`).join('')}</tbody></table></div>`;
}

function rollupDocumentsHtml(rollup) {
  if (!rollup || !(rollup.documents || []).length) return '';
  return (rollup.documents || []).map((d) => `<div class="doc-row"><div class="doc-icon">${esc((d.docType || 'DOC').slice(0, 3).toUpperCase())}</div><div><b>${esc(d.docType)} · ${esc(d.ref)}</b><small>${esc(humanDate(d.date))} · ${money(d.amount)}</small> ${cwLedgerPill(d.status)}</div></div>`).join('');
}

// Movement workspace loader: canonical cases + transfers for the identity
// group (extra reads — the profile itself never waits for them, §19 loading
// states live in #cwMoveoutCases and #cwCasesWrap).
//
// A-10: the Move-out notices card reads MoveOutCase (open case + history for
// this rental/customer), never the portal Notice table as its source. Any
// portal notice already on the profile payload stays visible only as a
// secondary line — no new Notice plumbing is added here.
const CW_OPEN_CASE = new Set(['PENDING_MOVE_OUT', 'AWAITING_INSPECTION', 'SETTLEMENT_REVIEW', 'REFUND_PROCESSING', 'CHARGE_PROCESSING']);

// Top-card timeline: open MoveOutCase rows first, then history; the portal
// notice (already on the profile payload) renders only as a secondary line.
// The `No active move-out request` empty state shows only when no open case
// exists.
function moveoutCasesCardHtml(myCases, portalUnits) {
  const open = myCases.filter((c2) => CW_OPEN_CASE.has(c2.status));
  const history = myCases.filter((c2) => !CW_OPEN_CASE.has(c2.status));
  const caseLine = (c2) => `<div class="v2-event"><b>${esc(c2.caseNumber)} · ${esc(c2.unit?.unitName || c2.unit?.unitCode || '')}</b><p>Final access ${esc(humanDate(c2.finalAccessDate))} · ${c2.noticeCompliant ? 'notice compliant' : 'short notice'} · ${esc(moStatusText(c2.status))}</p><p style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">${casePill(c2.status)}<button class="btn" data-mo-case="${esc(c2.id)}" data-perm="customer-moveouts:view">Open case</button></p></div>`;
  const portalLines = (portalUnits || []).map((u) => `<div class="v2-event"><b>Portal notice · ${esc(u.unitName ?? u.unitCode)}</b><p>Last day of access ${esc(humanDate(u.portalMoveOut))} (portal record — the case above is canonical).</p></div>`).join('');
  if (!open.length) {
    return `<div class="v2-event"><b>No active move-out request</b><p>Record a request above — it appears here once filed.</p></div>`
      + history.map(caseLine).join('')
      + portalLines;
  }
  return open.map(caseLine).join('')
    + (history.length ? `<div class="v2-event"><b>History</b></div>` + history.map(caseLine).join('') : '')
    + portalLines;
}

async function loadMovementCases() {
  const host = document.getElementById('cwCasesWrap');
  const card = document.getElementById('cwMoveoutCases');
  if ((!host && !card) || !current) return;
  const email = (current.email || '').trim();
  try {
    const [casesData, transfersData] = await Promise.all([
      get('/move-out-cases' + (email ? '?search=' + encodeURIComponent(email) : '')).catch(() => []),
      get('/transfers' + (email ? '?search=' + encodeURIComponent(email) : '')).catch(() => []),
    ]);
    const cases = Array.isArray(casesData) ? casesData : casesData.rows || [];
    const transfers = Array.isArray(transfersData) ? transfersData : transfersData.rows || [];
    const tenantIds = new Set((current.units || []).map((u) => u.tenantId).filter(Boolean));
    tenantIds.add(current.id);
    const mine = (t) => !email || String(t?.email || '').toLowerCase() === email.toLowerCase() || (t?.id && tenantIds.has(t.id));
    const myCases = cases.filter((c2) => mine(c2.tenant));
    if (card) card.innerHTML = moveoutCasesCardHtml(myCases, (current.units || []).filter((u) => u.portalMoveOut));
    if (!host) return;
    // A-24: match on display-unit codes from every row shape (sourceUnit /
    // destUnit display objects, legacy from/to codes) — never the raw id.
    const transferCodes = (t) => [t?.sourceUnit?.unitCode, t?.destUnit?.unitCode, t?.unit?.unitCode, t?.fromUnitCode, t?.toUnitCode].filter(Boolean);
    const myTransfers = transfers.filter((t) => mine({ email: t?.tenant?.email }) || (current.units || []).some((u) => u.unitCode && transferCodes(t).includes(u.unitCode)));
    if (!myCases.length && !myTransfers.length) {
      host.innerHTML = '<div class="section-empty">No move-out cases or transfers for this customer yet. Record a request or preview a transfer above.</div>';
      return;
    }
    host.innerHTML = `<div class="v2-card"><div class="v2-card-head"><div><h3>Move-out &amp; transfers workspace</h3><p>Request, progress and case detail — every row jumps to its canonical record.</p></div></div><div class="v2-card-body">
      ${myCases.map((c2) => `<div class="v2-unit"><div><b style="white-space:nowrap">${esc(c2.caseNumber)}</b><small>Final access ${esc(humanDate(c2.finalAccessDate))} · ${c2.noticeCompliant ? 'notice compliant' : 'short notice'}</small></div><div><small>Status</small>${casePill(c2.status)}</div><div><small>Settlement</small>${c2.settlement ? `<b>${esc(c2.settlement.ref)}</b> ${settlePill(c2.settlement.status)}` : '<b>—</b>'}</div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-mo-case="${esc(c2.id)}" data-perm="customer-moveouts:view">Open case</button>${c2.settlement ? `<button class="btn" data-mo-approval="${esc(c2.settlement.id)}" data-perm="bill-transactions:view">Open Finance approval</button>` : ''}</div></div>`).join('')}
      ${myTransfers.map((t) => { const from = t.sourceUnit?.unitName || t.sourceUnit?.unitCode || t.unit?.unitName || t.unit?.unitCode || t.fromUnitCode || '—'; const to = t.destUnit?.unitName || t.destUnit?.unitCode || t.toUnitCode || '—'; return `<div class="v2-unit"><div><b>${esc(t.ref)}</b><small>${esc(from)} → ${esc(to)} · effective ${esc(humanDate(t.effectiveDate))}</small></div><div><small>Net adjustment</small><b>${Number(t.amount) < 0 ? 'Credit ' + money(-Number(t.amount)) : money(Number(t.amount))}</b></div><div><small>Status</small>${settlePill(t.status)}</div><div><button class="btn" data-cw="open-transfer" data-id="${esc(t.id)}" data-perm="bill-transactions:view">Open transfer record</button></div></div>`; }).join('')}
    </div></div>`;
  } catch (e) {
    if (card) card.innerHTML = `<div class="v2-event"><b>Move-out requests failed to load.</b><p>${esc(describeError(e))}</p></div>`;
    if (host) host.innerHTML = `<div class="section-empty"><b>Cases failed to load.</b><span>${esc(describeError(e))}</span></div>`;
  }
}

// ---- Service request ----
function openServiceRequest() {
  openModal({
    title: 'Add service request', kicker: 'CUSTOMER TIMELINE', body: `<div class="v29-grid"><label class="v29-field"><span>Request type</span><select id="cwSrType"><option>Moving service</option><option>Merchandise</option><option>Protection Plan change</option><option>Other service</option></select></label><label class="v29-field"><span>Preferred date</span><input id="cwSrDate" type="date" value="${sgYmd()}"></label><label class="v29-field full"><span>Details</span><textarea id="cwSrDetails"></textarea></label></div>`,
    footer: '<button class="btn" data-lw="close">Cancel</button><button class="primary" data-cw="service-save">Save request</button>',
  });
}

function exportLedger() {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [['Date', 'Document', 'Unit', 'Line item', 'Status', 'Debit', 'Credit'].map(cell).join(',')].concat(current.ledger.map((l) => [l.date, l.document, l.unit, l.lineItem, l.status, l.debit ?? '', l.credit ?? ''].map(cell).join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `StoreLah_Ledger_${current.name.replace(/[^A-Za-z0-9]+/g, '_')}_${sgYmd()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-cust-open]');
  if (open) { e.preventDefault(); e.stopPropagation(); openCustomerProfile(open.dataset.custOpen); return; }
  const el = e.target.closest('[data-cw]');
  if (!el) return;
  const a = el.dataset.cw;
  const H = {
    back: () => goPage('customers'),
    tab: () => {
      tab = el.dataset.tab;
      const page = document.getElementById('customer-profile');
      page.querySelectorAll('.v2-tabs [data-cw="tab"]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      page.querySelectorAll('[data-cw-panel]').forEach((p) => p.classList.toggle('active', p.dataset.cwPanel === tab));
      if (tab === 'movement') loadMovementCases();
    },
    // Track A canonical flows (A3–A5): server-calculated, Finance-approved.
    // The pre-A3 direct-settlement dialogs are retired — no competing tool.
    transfer: () => {
      openTransferPreview({ units: current.units || [], tenantId: current.id }).catch((err) => notify(describeError(err)));
    },
    moveout: () => {
      const u = (current.units || [])[0] || {};
      openRecordRequest({ tenantId: u.tenantId || current.id, finalAccessDate: u.portalMoveOut || '' }).catch((err) => notify(describeError(err)));
    },
    refund: () => {
      const u = (current.units || [])[0] || {};
      openManualRefund({ tenantId: current.id, unitId: u.unitId || u.id || '' }).catch((err) => notify(describeError(err)));
    },
    status: () => {
      const rentals = (current.units || []).map((u) => ({ tenantId: u.tenantId || current.id, unitCode: u.unitName ?? u.unitCode, status: u.status }));
      openChangeStatus(current.id, rentals).catch((err) => notify(describeError(err)));
    },
    'open-transfer': () => openFinanceRecord(`settlement:${el.dataset.id}`),
    service: openServiceRequest,
    'service-save': () => busy(el, async () => { await post(`/tenants/${encodeURIComponent(current.id)}/service-requests`, { type: val('cwSrType'), preferredDate: val('cwSrDate') || null, details: val('cwSrDetails').trim() || undefined }); closeModal(); notify('Service request saved to the customer timeline.'); tab = 'notes'; await openCustomerProfile(current.id, true); }),
    'ledger-export': exportLedger,
    documents: () => { goPage('billing'); document.querySelector('[data-side-panel="bill-transactions"]')?.click(); },
  };
  if (H[a]) { e.preventDefault(); Promise.resolve(H[a]()).catch((err) => notify(describeError(err))); }
});

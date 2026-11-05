// StoreLah CMS admin UI — Customer profile (owner prototype 2026-11-04,
// docs/prototype-updates/storelah-prototype-updates-2026-11-04.md §Customers).
//
// Prototype parity: the Customer 360 page, Agreement/Services cards, ledger,
// Transfer unit, Move-out and Refund dialogs are adapted from the owner's
// prototype (crm-ux-v2.js customerProfileHtml + v29-request.js). The
// prototype's customerMeta demo object is replaced by GET /tenants/:id/profile
// and every settlement is calculated by the server (POST …/settlements/preview)
// — the page only displays the result — then submitted for Finance approval.

import { escapeHtml as esc, showBanner } from './dom.js';
import { get, post, can, describeError } from './api.js';
import { openModal, closeModal, notesHtml, saveNote } from './leadsWorkspace.js';

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
const STATUS_LABEL = { ACTIVE: 'Active', DUE_SOON: 'Payment due soon', OVERDUE: 'Payment attention', NOTICE: 'Move-out notice', INACTIVE: 'Inactive' };
const STATUS_TONE = { ACTIVE: 'green', DUE_SOON: 'amber', OVERDUE: 'red', NOTICE: 'amber', INACTIVE: 'grey' };

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
    const [c, notes] = await Promise.all([get(`/tenants/${encodeURIComponent(tenantId)}/profile`), get(`/tenants/${encodeURIComponent(tenantId)}/notes`)]);
    current = c;
    if (!keepTab) tab = 'overview';
    ensurePage().innerHTML = profileHtml(c, notes);
    goPage('customer-profile');
  } catch (err) { showBanner('Customer: ' + describeError(err)); }
}

function unitFacts(u) {
  return `<div class="v29-facts"><div><small>Agreement signed</small><b>${esc(humanDate(u.agreementSigned))}</b></div><div><small>Move-in date</small><b>${esc(humanDate(u.moveIn))}</b></div><div><small>Committed duration</small><b>${esc(u.commitment || 'Monthly · no fixed term')}</b></div><div><small>Commitment ends</small><b>${esc(humanDate(u.commitmentEnd))}</b></div><div><small>Time remaining</small><b>${esc(u.remaining || '—')}</b></div><div><small>Protection Plan</small><b>${u.protectionMonthly != null ? money(u.protectionMonthly) + ' / month' : 'Not recorded'}</b></div></div>`;
}

function profileHtml(c, notes) {
  const u0 = c.units[0];
  const editable = can('customer-tenants:update');
  const tabs = [['overview', 'Overview'], ['rental', 'Rental & pricing'], ['billing', 'Billing & payments'], ['documents', 'Documents'], ['access', 'Access'], ['movement', 'Move-out & transfers'], ['notes', 'Notes & activity']];
  const pending = c.settlements.filter((s) => s.status === 'PENDING');
  return `<div class="v2-customer-hero"><div class="v2-person"><div class="avatar">${esc(initials(c.name))}</div><div><button class="v2-name" data-cw="back">← Customer list</button><h1>${esc(c.name)}</h1><p>${c.type === 'BUSINESS' ? 'Business' : 'Personal'} customer${c.uen ? ' · UEN ' + esc(c.uen) : ''}</p><div class="v2-contactline">${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.mobile ? `<a href="tel:${esc(c.mobile)}">${esc(c.mobile)}</a>` : ''}</div><div class="v2-tags"><span class="pill ${STATUS_TONE[c.status] || 'grey'}">${esc(STATUS_LABEL[c.status] || c.status)}</span><span class="sync-badge">Customer record synced</span></div></div></div><div class="v2-hero-actions">${editable && u0 ? `<button class="btn" data-cw="transfer">Transfer unit</button><button class="btn" data-cw="moveout">Record move-out</button>` : ''}<button class="primary" data-cw="tab" data-tab="notes">＋ Note</button></div></div>
  <div class="v2-profile-kpis"><div class="v2-profile-kpi"><small>Customer since</small><b>${esc(humanDate(c.since))}</b><span>First move-in</span></div><div class="v2-profile-kpi"><small>Revenue to date</small><b>${money(c.revenueToDate)}</b><span>Payments allocated</span></div><div class="v2-profile-kpi"><small>Active units</small><b>${c.units.length}</b><span>${new Set(c.units.map((u) => u.facility)).size} facility</span></div><div class="v2-profile-kpi"><small>Monthly unit deductions</small><b>${money(c.monthlyDeductions)}</b><span>Rent + protection by unit</span></div><div class="v2-profile-kpi"><small>Security deposits held</small><b>${money(c.depositsHeld)}</b><span>Configured as $0 at launch</span></div></div>
  ${pending.length ? `<div class="v2-alerts"><div class="v2-alert"><i>$</i><div><b>${pending.length} settlement${pending.length === 1 ? '' : 's'} awaiting Finance approval</b><small>${pending.map((s) => esc(s.ref)).join(', ')} · the unit and billing schedule are unchanged until approval.</small></div></div></div>` : ''}
  <div class="v2-tabs" role="tablist">${tabs.map(([k, l]) => `<button class="${k === tab ? 'active' : ''}" data-cw="tab" data-tab="${k}">${l}</button>`).join('')}</div>
  <div class="v2-panel ${tab === 'overview' ? 'active' : ''}" data-cw-panel="overview"><div class="v2-card"><div class="v2-card-head"><div><h3>Identity and contact</h3><p>Email and mobile remain editable from the customer list.</p></div></div><div class="v2-card-body"><div class="v2-info"><div><small>${c.type === 'BUSINESS' ? 'Company name' : 'Name'}</small><b>${esc(c.name)}</b></div>${c.uen ? `<div><small>UEN</small><b>${esc(c.uen)}</b></div>` : ''}<div><small>Email</small><b>${esc(c.email || '—')}</b></div><div><small>Mobile</small><b>${esc(c.mobile || '—')}</b></div></div></div></div>
    <div class="v29-customer-section"><div class="v29-customer-grid">${c.units.map((u) => `<div class="v29-customer-card"><header><div><h3>Agreement and move-in · ${esc(u.unitCode)}</h3><p>Key customer lifecycle dates</p></div><span class="pill ${STATUS_TONE[u.status] || 'grey'}">${esc(STATUS_LABEL[u.status] || u.status)}</span></header><div class="body">${unitFacts(u)}</div></div>`).join('')}<div class="v29-customer-card"><header><div><h3>Services and add-ons</h3><p>Requests outside monthly storage rent</p></div>${editable ? '<button class="btn" data-cw="service">＋ Add request</button>' : ''}</header><div class="body"><div class="v29-facts"><div><small>Moving service</small><b>${u0?.movingService ? 'Requested at booking' : 'Not requested'}</b></div><div><small>Protection Plan</small><b>${u0?.protectionMonthly != null ? money(u0.protectionMonthly) + ' / month' + (u0.protectionTier ? ' · ' + esc(u0.protectionTier) : '') : 'Not recorded'}</b></div><div><small>Ledger treatment</small><b>Separate line items</b></div></div></div></div></div></div></div>
  <div class="v2-panel ${tab === 'rental' ? 'active' : ''}" data-cw-panel="rental">${c.units.map((u) => `<div class="v29-customer-card v29-rental-lifecycle" style="margin-bottom:14px"><header><div><h3>Rental commitment and recurring charges · ${esc(u.unitCode)}</h3><p>Commitment controls early-exit treatment; rent is still billed monthly.</p></div><span class="pill ${u.withinCommitment ? 'amber' : 'green'}">${u.withinCommitment ? 'Within commitment' : 'Commitment completed'}</span></header><div class="body"><div class="v29-facts"><div><small>Agreement signed</small><b>${esc(humanDate(u.agreementSigned))}</b></div><div><small>Move-in</small><b>${esc(humanDate(u.moveIn))}</b></div><div><small>Initial commitment</small><b>${esc(u.commitment || 'Monthly')}</b></div><div><small>Commitment end</small><b>${esc(humanDate(u.commitmentEnd))}</b></div><div><small>Remaining</small><b>${esc(u.remaining || '—')}</b></div><div><small>Net monthly rent</small><b>${money(u.netRent)}</b></div><div><small>Protection Plan monthly</small><b>${u.protectionMonthly != null ? money(u.protectionMonthly) : '—'}</b></div><div><small>Billing frequency</small><b>${esc(u.billingFrequency)}</b></div></div></div></div>`).join('') || '<div class="v29-empty"><b>No active unit</b><span>This customer has no unit assigned.</span></div>'}
    <div class="v2-card"><div class="v2-card-head"><div><h3>Units, commitment and pricing</h3><p>Each unit retains its own rent, promotion, protection plan, deposit and billing schedule.</p></div><span class="pill blue">${c.units.length} unit${c.units.length === 1 ? '' : 's'}</span></div><div class="v2-card-body"><div class="v2-unit-list">${c.units.map((u) => `<div class="v2-unit"><div><b>${esc(u.unitCode)}</b><small>${esc(u.facility || '')}${u.level != null ? ' · Level ' + u.level : ''} · ${esc(u.size || '')} · ${u.sqft} sq ft</small></div><div><small>Commitment position</small><b>${esc(u.remaining || 'Monthly')}</b><small>Rent is still collected monthly</small></div><div><small>Pricing</small><b>${money(u.netRent)} rent</b><small>Gross ${money(u.grossRent)}</small></div><div><small>Security deposit</small><b>${money(u.deposit)}</b><small>Launch policy: waived</small></div></div>`).join('')}</div></div></div></div>
  <div class="v2-panel ${tab === 'billing' ? 'active' : ''}" data-cw-panel="billing"><div class="v2-card"><div class="v2-card-head"><div><h3>Next deductions by unit</h3><p>Even multi-unit customers are charged and reconciled at unit level.</p></div><span class="sync-badge">Finance synced</span></div><div class="v2-card-body"><div class="v2-unit-list">${c.units.map((u) => `<div class="v2-unit"><div><b>${esc(u.unitCode)}</b><small>Next payment ${esc(humanDate(u.nextPayment))}</small></div><div><small>Rent</small><b>${money(u.netRent)}</b></div><div><small>Protection plan</small><b>${money(u.protectionMonthly || 0)}</b></div><div><small>Total deduction</small><b class="amount">${money(u.netRent + (u.protectionMonthly || 0))}</b></div></div>`).join('')}</div><div class="v2-page-note" style="margin:12px 0 0"><i>i</i><div><b>Monthly payment basis</b>A commitment controls eligibility and early-exit treatment; it does not mean StoreLah collects the whole committed term upfront.</div></div></div></div>
    <div class="v29-customer-card v29-ledger" style="margin-top:14px"><header><div><h3>Customer ledger</h3><p>Every billed, credited, paid or refunded line—storage, Protection Plan, merchandise and services.</p></div><button class="btn" data-cw="ledger-export">Export ledger</button></header><div class="body"><div class="table-wrap"><table class="v29-ledger-table"><thead><tr><th>Date</th><th>Document</th><th>Unit</th><th>Line item</th><th>Status</th><th>Debit</th><th>Credit / payment</th></tr></thead><tbody>${c.ledger.map((l) => `<tr><td>${esc(humanDate(l.date))}</td><td>${esc(l.document)}</td><td>${esc(l.unit)}</td><td>${esc(l.lineItem)}</td><td><span class="pill ${/Paid|Allocated|Approved/.test(l.status) ? 'green' : /Overdue|Rejected/.test(l.status) ? 'red' : 'amber'}">${esc(l.status)}</span></td><td>${l.debit == null ? '—' : money(l.debit)}</td><td>${l.credit == null ? '—' : money(l.credit)}</td></tr>`).join('') || '<tr><td colspan="7" style="text-align:center;padding:20px">No billed lines yet.</td></tr>'}</tbody></table></div><div class="v29-callout" style="margin:14px 0 0"><i>↔</i><div><b>Clean refund route</b>Start a refund from this customer context or a move-out preview. Review, approve and process it in Finance → Transactions, documents &amp; approvals. There is no competing standalone refund module.</div>${editable && u0 ? '<button class="btn" data-cw="refund">Start refund request</button>' : ''}</div></div></div></div>
  <div class="v2-panel ${tab === 'documents' ? 'active' : ''}" data-cw-panel="documents"><div class="v2-card"><div class="v2-card-head"><div><h3>Customer documents</h3><p>Agreement, invoice and receipt records remain linked—not duplicated.</p></div><button class="btn" data-cw="documents">Open financial documents</button></div><div class="v2-card-body doc-list">${c.units.map((u) => `<div class="doc-row"><div class="doc-icon">AGR</div><div><b>Storage agreement · ${esc(u.unitCode)}</b><small>${u.bookingRef ? 'Booking ' + esc(u.bookingRef) + ' · signed ' + esc(humanDate(u.agreementSigned)) : 'No booking on file'}</small></div></div>`).join('')}<div class="doc-row"><div class="doc-icon">INV</div><div><b>Invoices and receipts</b><small>Open from the combined Transactions &amp; Documents register</small></div><button class="btn" data-cw="documents">View all</button></div></div></div></div>
  <div class="v2-panel ${tab === 'access' ? 'active' : ''}" data-cw-panel="access"><div class="v2-card"><div class="v2-card-head"><div><h3>Access</h3><p>Credentials are scoped to facility and agreement.</p></div></div><div class="v2-card-body"><div class="v2-info">${c.units.map((u) => `<div><small>${esc(u.unitCode)}</small><b>${esc(STATUS_LABEL[u.status] || u.status)}</b></div>`).join('')}</div><p class="v29-help" style="margin-top:10px">PINs and access activity are managed in Facilities › Access Control.</p></div></div></div>
  <div class="v2-panel ${tab === 'movement' ? 'active' : ''}" data-cw-panel="movement"><div class="v29-callout v29-movement-note"><i>i</i><div><b>Staff-assisted workflows are supported</b>Select the destination unit and transfer date, or record a customer move-out request received by WhatsApp, phone, email or onsite. Both show a financial preview before Finance approval.</div></div><div class="v2-profile-grid equal"><div class="v2-card"><div class="v2-card-head"><div><h3>Move-out notices</h3><p>Customer-level history; financial impact is calculated per unit.</p></div>${editable && u0 ? '<button class="primary" data-cw="moveout">Record move-out</button>' : ''}</div><div class="v2-card-body"><div class="v2-timeline">${c.units.filter((u) => u.portalMoveOut).map((u) => `<div class="v2-event"><b>Portal notice · ${esc(u.unitCode)}</b><p>Last day of access ${esc(humanDate(u.portalMoveOut))}.</p></div>`).join('') || '<div class="v2-event"><b>No active notice</b><p>No move-out request has been received from the customer portal.</p></div>'}</div></div></div><div class="v2-card"><div class="v2-card-head"><div><h3>Unit transfers</h3><p>Pricing and promotions on the destination unit take precedence.</p></div>${editable && u0 ? '<button class="primary" data-cw="transfer">Transfer unit</button>' : ''}</div><div class="v2-card-body"><div class="v2-page-note" style="margin:0"><i>$</i><div><b>Finance approval required</b>The preview shows source-unit credits, destination rent, security deposit and non-prorated protection-plan treatment before submission.</div></div></div></div></div>
    <div class="v2-card" style="margin-top:14px"><div class="v2-card-head"><h3>Settlements</h3></div><div class="table-wrap"><table class="v2-table"><thead><tr><th>Record</th><th>Type</th><th>Date</th><th>Amount</th><th>Status</th><th>Requested / decided</th></tr></thead><tbody>${c.settlements.map((s) => `<tr><td><b>${esc(s.ref)}</b></td><td>${esc(s.docType)}</td><td>${esc(humanDate(s.effectiveDate))}</td><td>${s.amount < 0 ? 'Refund ' + money(-s.amount) : 'Customer pays ' + money(s.amount)}</td><td><span class="pill ${s.status === 'APPROVED' ? 'green' : s.status === 'REJECTED' ? 'red' : 'amber'}">${s.status === 'PENDING' ? 'Pending approval' : esc(s.status.charAt(0) + s.status.slice(1).toLowerCase())}</span></td><td>${esc(s.requestedBy)}${s.decidedBy ? `<small>${esc(s.decidedBy)}${s.decisionNote ? ' · ' + esc(s.decisionNote) : ''}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:20px">No transfers or move-out settlements yet.</td></tr>'}</tbody></table></div></div></div>
  <div class="v2-panel ${tab === 'notes' ? 'active' : ''}" data-cw-panel="notes"><div class="note-composer"><textarea id="lwCustNoteBody" data-mention="1" placeholder="Add an internal note; use @Name to notify a colleague…"></textarea><div class="note-composer-foot"><span class="mention-hint">Mentioned users receive an overview notification</span><button class="primary" data-lw="note-save" data-entity="tenant" data-id="${esc(c.id)}">Add note</button></div></div><div id="lwCustNotes">${notesHtml(notes)}</div></div>`;
}

// ---------------------------------------------------------------------------
// Settlement dialogs — inputs here, numbers from the server.
// ---------------------------------------------------------------------------
function adjustmentFields(prefix) {
  const cats = current.adjustmentCategories || [];
  return `<div class="v30-special-adjustment"><div class="v30-special-head"><div><b>Special refund or charge</b><span>Optional. A reason is mandatory and Finance must approve it.</span></div><span class="pill grey">Exception</span></div><div class="v29-grid three"><label class="v29-field"><span>Adjustment</span><select id="${prefix}AdjType"><option value="">No special adjustment</option><option value="CREDIT">Additional refund / customer credit</option><option value="CHARGE">Additional charge / fee</option></select></label><label class="v29-field"><span>Category</span><select id="${prefix}AdjCategory">${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label><label class="v29-field"><span>Amount</span><input id="${prefix}AdjAmount" type="number" min="0" step="0.01" value="0"></label><label class="v29-field full"><span>Reason / evidence</span><textarea id="${prefix}AdjReason" placeholder="Required when a special refund or charge is added…"></textarea></label></div></div>`;
}
function adjustmentOf(prefix) {
  const type = val(prefix + 'AdjType');
  const amount = Math.max(0, Number(val(prefix + 'AdjAmount')) || 0);
  return type && amount > 0 ? { type, category: val(prefix + 'AdjCategory'), amount, reason: val(prefix + 'AdjReason').trim() } : null;
}
function settlementTable(lines) {
  return `<div class="v30-settlement"><table><thead><tr><th>System-calculated component</th><th>Basis</th><th>Amount</th></tr></thead><tbody>${lines.map((l) => `<tr><td>${esc(l.label)}</td><td>${esc(l.detail || '')}</td><td class="${l.amount < 0 ? 'negative' : ''}">${l.amount < 0 ? '−' : ''}${money(Math.abs(l.amount))}</td></tr>`).join('')}</tbody></table></div>`;
}
function outcomeCard(amount, labels) {
  const refund = amount <= 0;
  return `<div class="v30-outcome ${refund ? 'refund' : 'charge'}"><span>${refund ? labels[0] : labels[1]}</span><b>${money(Math.abs(amount))}</b><small>${refund ? 'Credit/refund is not processed until Finance approval.' : 'The charge is not created or collected until Finance approval.'}</small></div>`;
}

let previewSeq = 0;
async function runPreview(body, targetId, render) {
  const target = document.getElementById(targetId);
  if (!target) return null;
  const seq = ++previewSeq;
  try {
    const p = await post(`/tenants/${encodeURIComponent(current.id)}/settlements/preview`, body);
    if (seq === previewSeq) target.innerHTML = render(p);
    return p;
  } catch (err) {
    if (seq === previewSeq) target.innerHTML = `<div class="v29-callout warn" style="margin-top:14px"><i>!</i><div><b>${/last day/i.test(describeError(err)) ? 'Move-out date required' : 'Check the inputs'}</b>${esc(describeError(err))}</div></div>`;
    return null;
  }
}

// ---- Transfer ----
let destUnits = [];
async function openTransfer() {
  const u = current.units[0];
  destUnits = (await get('/units?status=AVAILABLE&perPage=200').catch(() => [])) || [];
  openModal({
    title: `Transfer unit · ${current.name}`, kicker: 'SYSTEM-CALCULATED TRANSFER SETTLEMENT', wide: true,
    body: `<div class="v29-callout"><i>i</i><div><b>The transfer date drives the proration</b>The system credits the unused current-unit rent and charges destination-unit rent for the same remaining days. Destination pricing and promotions take precedence. Protection Plan is never prorated.</div></div><div class="v29-grid three"><label class="v29-field"><span>Current unit</span><input value="${esc(u.unitCode)}" readonly></label><label class="v29-field"><span>Current net monthly rent</span><input value="${money(u.netRent)}" readonly></label><label class="v29-field"><span>Transfer date *</span><input id="cwTrDate" type="date" value="${sgYmd()}"></label><label class="v29-field"><span>New unit *</span><select id="cwTrUnit"><option value="">Select destination unit…</option>${destUnits.map((d) => `<option value="${esc(d.id)}">${esc(d.unitCode)} · ${d.sqft} sq ft · ${money(d.rate ?? d.monthlyRate)} gross${d.branch?.name ? ' · ' + esc(d.branch.name) : ''}</option>`).join('')}</select></label><label class="v29-field"><span>Destination promotion %</span><input id="cwTrPromo" type="number" min="0" max="100" step="0.5" value="0"></label><label class="v29-field"><span>Destination Protection Plan</span><input id="cwTrProt" type="number" min="0" step="0.5" value="${u.protectionMonthly ?? 12.5}"><small class="v29-help">Starts next billing cycle; no mid-month proration.</small></label><label class="v29-field"><span>Current security deposit</span><input value="${money(u.deposit)}" readonly></label><label class="v29-field"><span>Destination security deposit</span><input id="cwTrDeposit" type="number" min="0" step="0.01" value="0"><small class="v29-help">Currently $0 under StoreLah launch policy.</small></label><label class="v29-field full"><span>Transfer reason</span><textarea id="cwTrReason" placeholder="Upgrade, downsize, customer preference or operational move…"></textarea></label></div>${adjustmentFields('cwTr')}<div id="cwTrSummary"></div>`,
    footer: '<span class="hint">Nothing posts until Finance approves the transfer settlement.</span><button class="btn" data-lw="close">Cancel</button><button class="btn" data-cw="transfer-calc">Recalculate</button><button class="primary" data-cw="transfer-submit">Submit to Finance</button>',
  });
  ['cwTrDate', 'cwTrUnit', 'cwTrPromo', 'cwTrProt', 'cwTrDeposit', 'cwTrAdjType', 'cwTrAdjCategory', 'cwTrAdjAmount'].forEach((id) => document.getElementById(id)?.addEventListener(id.endsWith('Amount') || id.endsWith('Promo') ? 'input' : 'change', transferCalc));
}
function transferBody() {
  return { kind: 'TRANSFER', date: val('cwTrDate'), toUnitId: val('cwTrUnit'), destPromoPct: Number(val('cwTrPromo')) || 0, destProtection: Number(val('cwTrProt')) || 0, destDeposit: Number(val('cwTrDeposit')) || 0, reason: val('cwTrReason').trim() || null, adjustment: adjustmentOf('cwTr') };
}
function transferCalc() {
  if (!val('cwTrUnit') || !val('cwTrDate')) { document.getElementById('cwTrSummary').innerHTML = ''; return null; }
  return runPreview(transferBody(), 'cwTrSummary', (p) => `${settlementTable(p.lines)}${outcomeCard(p.amount, ['Customer account credit', 'Customer pays'])}<div class="v29-callout" style="margin-top:12px"><i>→</i><div><b>Next full monthly deduction: ${money(p.nextFullDeduction)}</b>${esc(p.to)} · ${p.toSqft} sq ft · net rent ${money(p.destNet)} + Protection Plan ${money(Number(val('cwTrProt')) || 0)}.</div></div>`);
}
async function submitTransfer(btn) {
  if (!val('cwTrUnit')) { notify('Choose the destination unit.'); return; }
  const adj = adjustmentOf('cwTr');
  if (adj && !adj.reason) { notify('Add a reason for the special refund or charge.'); return; }
  await busy(btn, async () => {
    const s = await post(`/tenants/${encodeURIComponent(current.id)}/settlements`, transferBody());
    closeModal();
    notify(`${s.ref} submitted to Finance. The unit and billing schedule remain unchanged until approval.`);
    tab = 'movement';
    await openCustomerProfile(current.id, true);
  });
}

// ---- Move-out / refund ----
function openClosing(kind) {
  const u = current.units[0];
  const portal = !!u.portalMoveOut;
  const isMove = kind === 'MOVE_OUT';
  openModal({
    title: isMove ? `Record move-out request · ${current.name}` : `Refund or closing charge · ${current.name}`,
    kicker: isMove ? 'SYSTEM-CALCULATED CLOSING SETTLEMENT' : 'CALCULATE HERE · APPROVE IN FINANCE', wide: true,
    body: `<div class="v29-callout"><i>${portal ? '✓' : 'i'}</i><div><b>${portal ? 'Portal move-out date received' : isMove ? 'No portal move-out request found' : 'The outcome is calculated, not manually keyed'}</b>${portal ? 'The customer-selected date is prefilled and locked. Staff can add operational notes and exceptions.' : isMove ? 'Enter the date supplied by the customer via WhatsApp, phone, email or onsite. The customer’s last access day drives the proration.' : 'Unused net rent and the security deposit come from the customer’s unit ledger. Protection Plan is not prorated. Approved special credits or charges are shown separately and may turn a refund into an amount due.'}</div></div><div class="v29-grid three"><label class="v29-field"><span>Unit *</span><input value="${esc(u.unitCode)}" readonly></label><label class="v29-field"><span>Customer’s last access day *</span><input id="cwMoDate" type="date" value="${esc(u.portalMoveOut || '')}" ${portal ? 'readonly' : ''}>${portal ? '<small class="v29-help">Received from customer portal.</small>' : ''}</label>${isMove ? `<label class="v29-field"><span>Request channel</span><select id="cwMoChannel" ${portal ? 'disabled' : ''}>${(portal ? ['Customer portal'] : ['WhatsApp', 'Phone', 'Email', 'Onsite']).map((c) => `<option>${c}</option>`).join('')}</select></label><label class="v29-field"><span>Reason</span><select id="cwMoReason"><option>No longer needs storage</option><option>Price</option><option>Relocation completed</option><option>Transferred to another provider</option><option>Service issue</option><option>Other</option></select></label><label class="v29-field"><span>Commitment status</span><input value="${esc(u.remaining || 'Monthly')}" readonly></label>` : ''}<label class="v29-field"><span>Net monthly rent</span><input value="${money(u.netRent)}" readonly></label><label class="v29-field"><span>Security deposit held</span><input value="${money(u.deposit)}" readonly></label><label class="v29-field"><span>Protection Plan</span><input value="${u.protectionMonthly != null ? money(u.protectionMonthly) + ' / month' : 'Not recorded'} · non-proratable" readonly></label>${isMove ? '<label class="v29-field full"><span>Customer message / staff note</span><textarea id="cwMoNote"></textarea></label>' : ''}</div>${adjustmentFields('cwMo')}<div id="cwMoSummary"></div>`,
    footer: `<button class="btn" data-lw="close">Cancel</button><button class="btn" data-cw="closing-calc">Recalculate</button><button class="primary" data-cw="closing-submit" data-kind="${kind}">${isMove ? 'Record notice &amp; submit Finance review' : 'Submit to Finance'}</button>`,
  });
  ['cwMoDate', 'cwMoAdjType', 'cwMoAdjCategory', 'cwMoAdjAmount'].forEach((id) => document.getElementById(id)?.addEventListener(id.endsWith('Amount') ? 'input' : 'change', () => closingCalc(kind)));
  closingCalc(kind);
}
function closingBody(kind) {
  return { kind, lastDay: val('cwMoDate') || null, channel: document.getElementById('cwMoChannel') ? val('cwMoChannel') : null, reason: document.getElementById('cwMoReason') ? val('cwMoReason') : null, note: val('cwMoNote').trim() || null, adjustment: adjustmentOf('cwMo') };
}
function closingCalc(kind) {
  return runPreview(closingBody(kind), 'cwMoSummary', (p) => `${settlementTable(p.lines)}${outcomeCard(p.amount, ['Refund to customer', 'Charge customer'])}<p class="v29-help" style="margin-top:10px">Calculated from the customer’s current unit ledger. Finance can approve or reject the request; it cannot silently change the amount.</p>`);
}
async function submitClosing(btn, kind) {
  const adj = adjustmentOf('cwMo');
  if (adj && !adj.reason) { notify('Add a reason for the special refund or charge.'); return; }
  await busy(btn, async () => {
    const s = await post(`/tenants/${encodeURIComponent(current.id)}/settlements`, closingBody(kind));
    closeModal();
    notify(kind === 'MOVE_OUT' ? `Move-out recorded for ${humanDate(s.effectiveDate)}. ${s.ref} is awaiting Finance approval.` : `${s.ref} created in Finance → Transactions, documents & approvals.`);
    tab = 'movement';
    await openCustomerProfile(current.id, true);
  });
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
    },
    transfer: openTransfer,
    'transfer-calc': transferCalc,
    'transfer-submit': () => submitTransfer(el),
    moveout: () => openClosing('MOVE_OUT'),
    refund: () => openClosing('REFUND'),
    'closing-calc': () => closingCalc(document.querySelector('[data-cw="closing-submit"]')?.dataset.kind || 'MOVE_OUT'),
    'closing-submit': () => submitClosing(el, el.dataset.kind),
    service: openServiceRequest,
    'service-save': () => busy(el, async () => { await post(`/tenants/${encodeURIComponent(current.id)}/service-requests`, { type: val('cwSrType'), preferredDate: val('cwSrDate') || null, details: val('cwSrDetails').trim() || undefined }); closeModal(); notify('Service request saved to the customer timeline.'); tab = 'notes'; await openCustomerProfile(current.id, true); }),
    'ledger-export': exportLedger,
    documents: () => { goPage('billing'); document.querySelector('[data-side-panel="bill-transactions"]')?.click(); },
  };
  if (H[a]) { e.preventDefault(); Promise.resolve(H[a]()).catch((err) => notify(describeError(err))); }
});

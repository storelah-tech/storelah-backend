// StoreLah CMS admin UI — Leads workspace (owner prototype 2026-11-04,
// docs/prototype-updates/storelah-prototype-updates-2026-11-04.md §Leads).
//
// Prototype parity: the dialog, lead page, calendar and quotation-register
// templates below are adapted from the owner's reference prototype
// (storelah-crm-leads, v29-request.js) and styled by proto-v29.css /
// proto-ux-v2.css. Its seed arrays and localStorage are replaced by the CMS
// API: leads + enquiries (/leads), notes + @mentions (/leads/:id/notes,
// /notifications), pipeline + SLA settings, appointments and the quotation
// register (/quotations). Nothing here is demo data.

import { escapeHtml as esc, showBanner } from './dom.js';
import { get, post, put, patch, del, can, describeError, downloadFile } from './api.js';
import { confirmDialog } from './confirmDialog.js';
import { state } from './state.js';
import { sizeRangeLabel } from './constants.js';
import { normalizeWaDigits, buildQuoteWaMessage } from './opsQueuesView.js';

const PRODUCT = 'AC Self-Storage';
const SOURCES = [['WEBSITE', 'Website'], ['WHATSAPP', 'WhatsApp'], ['PHONE', 'Phone'], ['WALK_IN', 'Walk-in'], ['GOOGLE', 'Google Ads'], ['REFERRAL', 'Referral'], ['PARTNER', 'Partner']];
const SOURCE_LABEL = Object.fromEntries(SOURCES);
const SOURCE_CODE = { WEBSITE: 'W', WHATSAPP: 'WA', PHONE: 'P', WALK_IN: 'WI', GOOGLE: 'G', REFERRAL: 'R', PARTNER: 'PT' };
// Estimated / required size: the live size categories (GET /sizes) — value =
// size code (what booking sends and the quote form expects), label = the
// shared "Name · from–to sq ft" range. Older free-text values stay selectable.
const SIZE_NOT_SURE = 'Not sure';
function sizeChoices(current) {
  const rows = [[SIZE_NOT_SURE, SIZE_NOT_SURE], ...(state.sizes || []).map((z) => [z.code, sizeRangeLabel(z)])];
  if (current && !rows.some(([v]) => v === current)) rows.splice(1, 0, [current, current]);
  return rows;
}
function sizeOptions(selected) {
  return sizeChoices(selected).map(([v, t]) => option(v, t, selected || SIZE_NOT_SURE)).join('');
}
// Display a stored size (code → range label; legacy text as-is).
function sizeText(v) {
  const z = v && (state.sizes || []).find((x) => x.code === String(v).toUpperCase());
  return z ? sizeRangeLabel(z) : v || SIZE_NOT_SURE;
}
const ACCESS = ['Not sure', 'Daily', '2–3 times weekly', 'Weekly', '2–3 times monthly', 'Monthly', 'Rarely / archive storage'];
const APPT_TYPE = [['VIEWING', 'Facility viewing', 'viewing'], ['CALLBACK', 'Call', 'call'], ['VIDEO_CONSULT', 'Video consultation', 'video'], ['MOVE_IN', 'Move-in handover', 'movein']];
const APPT_STATUS = [['PENDING', 'Proposed'], ['CONFIRMED', 'Confirmed'], ['AWAITING_REPLY', 'Awaiting reply'], ['READY', 'Ready'], ['DONE', 'Completed']];
const QUOTE_STATUS_LABEL = { DRAFT: 'Draft', SENT: 'Sent', VIEWED: 'Viewed', ACCEPTED: 'Accepted', EXPIRED: 'Expired', VOIDED: 'Voided' };

const sgYmd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const money = (v) => new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' }).format(Number(v) || 0);
function humanDate(v) {
  if (!v) return '—';
  const raw = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(raw + 'T00:00:00Z') : new Date(raw);
  return isNaN(d) ? '—' : new Intl.DateTimeFormat('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: /^\d{4}-\d{2}-\d{2}$/.test(raw) ? 'UTC' : 'Asia/Singapore' }).format(d);
}
const initials = (s) => String(s || '?').split(/\s+/).slice(0, 2).map((x) => x[0] || '').join('').toUpperCase();
function notify(msg) { if (window.cmsToast) window.cmsToast(msg); }
function goPage(id) { window.StoreLahAdmin?.openPage ? window.StoreLahAdmin.openPage(id) : null; }

export const potentialText = 'Potential value = expected net monthly rent × expected billed months. When duration is ‘Not sure’ or ongoing, the planning default is 6 months until staff confirms it. It is an opportunity estimate, not recognised revenue.';
export function probabilityText(stageLabel, pct) {
  return `Stage probability starts at ${pct}% for ‘${stageLabel}’. The production score then applies capped signals: complete qualification +10, confirmed viewing +5, quote viewed +5, booking started +15, first-response SLA breach −5 and no activity for 7+ days −10. The result is capped between 0% and 100% and remains explainable in the audit trail.`;
}
export function tip(text) {
  return `<span class="v29-inline-tip"><span class="v29-tip-button" tabindex="0" aria-label="Definition">?</span><span class="v29-tooltip">${esc(text)}</span></span>`;
}
export function leadStatusColour(label) {
  return label === 'New' ? 'blue' : /Qualified|Viewing/.test(label) ? 'green' : label === 'Quoted' ? 'terra' : /Lost|breach/i.test(label) ? 'red' : 'grey';
}
export function leadDisplayName(l) { return l.type === 'BUSINESS' && l.companyName ? l.companyName : l.name; }
export { SOURCE_LABEL, SOURCE_CODE };

// ---------------------------------------------------------------------------
// Dialog (prototype v29 overlay)
// ---------------------------------------------------------------------------
function ensureOverlay() {
  let o = document.getElementById('v29Overlay');
  if (!o) {
    o = document.createElement('div');
    o.id = 'v29Overlay';
    o.className = 'v29-overlay';
    o.innerHTML = '<div class="v29-dialog" role="dialog" aria-modal="true" aria-labelledby="v29Title"><div class="v29-dialog-head"><div><p class="eyebrow" id="v29Kicker"></p><h2 id="v29Title"></h2></div><button class="v29-close" data-lw="close" aria-label="Close">×</button></div><div class="v29-dialog-body" id="v29Body"></div><div class="v29-dialog-foot" id="v29Foot"></div></div>';
    document.body.appendChild(o);
    o.addEventListener('click', (e) => { if (e.target === o) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && o.classList.contains('open')) closeModal(); });
  }
  return o;
}
export function openModal({ title, kicker = '', body = '', footer = '', wide = false }) {
  const o = ensureOverlay();
  o.querySelector('.v29-dialog').classList.toggle('wide', wide);
  o.querySelector('#v29Title').textContent = title;
  o.querySelector('#v29Kicker').textContent = kicker;
  o.querySelector('#v29Body').innerHTML = body;
  o.querySelector('#v29Foot').innerHTML = footer || '<button class="primary" data-lw="close">Done</button>';
  o.classList.add('open');
  setTimeout(() => o.querySelector('input:not([readonly]):not([type=hidden]),select,textarea')?.focus(), 30);
}
export function closeModal() { ensureOverlay().classList.remove('open'); }
const val = (id) => document.getElementById(id)?.value ?? '';
const option = (value, label, sel) => `<option value="${esc(value)}"${String(value) === String(sel) ? ' selected' : ''}>${esc(label)}</option>`;
const branchOptions = (sel, blank = 'No preference') => option('', blank, sel ?? '') + (state.branches || []).map((b) => option(b.id, 'StoreLah ' + b.name, sel)).join('');

// Busy-guard a primary action so a double click never double-submits.
async function busy(btn, fn) {
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try { await fn(); } catch (err) { notify(describeError(err)); } finally { if (btn) btn.disabled = false; }
}

// ---------------------------------------------------------------------------
// Shared data
// ---------------------------------------------------------------------------
let usersCache = null;
async function mentionableUsers() {
  if (!usersCache) usersCache = await get('/mentionable-users').catch(() => []);
  return usersCache;
}
async function leadsFlat() {
  const cols = await get('/leads');
  return (cols || []).flatMap((c) => c.leads || []);
}

// ---------------------------------------------------------------------------
// Add lead (master identity + first enquiry)
// ---------------------------------------------------------------------------
export async function openLeadForm() {
  const users = await mentionableUsers();
  openModal({
    title: 'Add a new lead', kicker: 'MASTER IDENTITY + FIRST ENQUIRY', wide: true,
    body: `<div class="v29-callout"><i>↔</i><div><b>One identity, many enquiries</b>Email, mobile and UEN are checked before save. A matching person or company receives another enquiry instead of a duplicate lead.</div></div>
    <div class="v29-grid three">
      <label class="v29-field"><span>Customer type *</span><select id="lwType"><option value="PERSONAL">Personal</option><option value="BUSINESS">Business</option></select></label>
      <label class="v29-field lw-personal"><span>Full name *</span><input id="lwName" placeholder="e.g. Sarah Tan"></label>
      <label class="v29-field lw-business" hidden><span>Company name *</span><input id="lwCompany" placeholder="Registered company name"></label>
      <label class="v29-field lw-business" hidden><span>UEN *</span><input id="lwUen" placeholder="e.g. 202612345A"></label>
      <label class="v29-field lw-business" hidden><span>Representative name *</span><input id="lwRep" placeholder="Main contact person"></label>
      <label class="v29-field"><span>Email</span><input id="lwEmail" type="email" placeholder="name@email.com"></label>
      <label class="v29-field"><span>Mobile</span><input id="lwMobile" placeholder="+65"></label>
      <label class="v29-field"><span>Date of enquiry *</span><input id="lwDate" type="date" value="${sgYmd()}"></label>
      <label class="v29-field"><span>Source *</span><select id="lwSource">${SOURCES.map(([v, l]) => option(v, l)).join('')}</select></label>
      <label class="v29-field"><span>Product</span><input value="${PRODUCT}" readonly></label>
      <label class="v29-field"><span>Preferred facility</span><select id="lwBranch">${branchOptions(state.branches?.[0]?.id)}</select></label>
      <label class="v29-field"><span>Estimated size</span><select id="lwSize">${sizeOptions('')}</select></label>
      <label class="v29-field"><span>Expected move-in</span><input id="lwMove" type="date" value="${sgYmd()}"></label>
      <label class="v29-field"><span>Expected duration</span><select id="lwDuration"><option value="">Not sure · use 6-month planning assumption</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">12 months</option><option value="">Ongoing · use 6-month planning assumption</option></select></label>
      <label class="v29-field"><span>Access frequency</span><select id="lwAccess">${ACCESS.map((s) => option(s, s)).join('')}</select></label>
      <label class="v29-field"><span>Expected net monthly rent</span><input id="lwRent" type="number" min="0" value="320"><small class="v29-help">Used only to estimate potential value.</small></label>
      <label class="v29-field"><span>Assigned salesperson</span><select id="lwOwner"><option value="">Auto-assign</option>${users.map((u) => option(u.name, u.name)).join('')}</select></label>
      <label class="v29-field full"><span>Storage requirement / notes</span><textarea id="lwNotes" placeholder="What are they storing, constraints, access needs and decision timing?"></textarea></label>
    </div>`,
    footer: '<span class="hint">Date of enquiry defaults to today and may be changed.</span><button class="btn" data-lw="close">Cancel</button><button class="btn" data-lw="identity-check">Check for existing lead</button><button class="primary" data-lw="lead-save">Create lead &amp; enquiry</button>',
  });
  document.getElementById('lwType')?.addEventListener('change', () => {
    const business = val('lwType') === 'BUSINESS';
    document.querySelectorAll('.lw-business').forEach((el) => { el.hidden = !business; });
    document.querySelectorAll('.lw-personal').forEach((el) => { el.hidden = business; });
  });
}

async function identityCheck() {
  const email = val('lwEmail').trim().toLowerCase();
  const mobile = val('lwMobile').replace(/\D/g, '');
  const uen = val('lwUen').trim().toUpperCase();
  if (!email && !mobile && !uen) { notify('Enter an email, mobile or UEN to check.'); return; }
  const leads = await leadsFlat();
  const hit = leads.find((l) => (email && (l.email || '').toLowerCase() === email) || (mobile.length >= 7 && (l.mobile || '').replace(/\D/g, '').endsWith(mobile.slice(-8))) || (uen && (l.uen || '').toUpperCase() === uen));
  if (!hit) { notify('Identity check complete. No exact email, mobile or UEN match found.'); return; }
  openModal({
    title: 'Existing lead found', kicker: 'ONE IDENTITY, MANY ENQUIRIES',
    body: `<div class="v29-callout"><i>↔</i><div><b>${esc(hit.displayId)} · ${esc(leadDisplayName(hit))}</b>This person or company already has a lead. Add another enquiry under it instead of creating a duplicate.</div></div>`,
    footer: `<button class="btn" data-lw="close">Cancel</button><button class="primary" data-lw="enquiry-new" data-lead="${esc(hit.id)}">Add enquiry to ${esc(hit.displayId)}</button>`,
  });
}

async function saveLead(btn) {
  const type = val('lwType');
  const company = val('lwCompany').trim();
  const person = val('lwName').trim();
  const rep = val('lwRep').trim();
  const name = type === 'BUSINESS' ? company : person;
  const email = val('lwEmail').trim();
  const mobile = val('lwMobile').trim();
  const date = val('lwDate');
  if (!name || (!email && !mobile) || !date || (type === 'BUSINESS' && (!rep || !val('lwUen').trim()))) {
    notify('Complete the required identity fields and provide an email or mobile number.');
    return;
  }
  await busy(btn, async () => {
    const lead = await post('/leads', {
      name, type, email: email || null, mobile: mobile || null,
      companyName: type === 'BUSINESS' ? company : null, uen: type === 'BUSINESS' ? val('lwUen').trim() : null, representative: type === 'BUSINESS' ? rep : null,
      enquiryDate: date, source: val('lwSource'), preferredBranchId: val('lwBranch') || null, preferredSize: val('lwSize'),
      moveInDate: val('lwMove') || null, durationMonths: val('lwDuration') ? Number(val('lwDuration')) : null,
      accessFrequency: val('lwAccess'), monthlyRate: Number(val('lwRent')) || null,
      owner: val('lwOwner') || (await mentionableUsers())[0]?.name || null, note: val('lwNotes').trim() || null,
    });
    closeModal();
    notify(`${lead.displayId} created and captured in the Lead database.`);
    goPage('leads');
  });
}

// ---------------------------------------------------------------------------
// Lead page (Overview / Enquiries / Notes & tasks)
// ---------------------------------------------------------------------------
let currentLead = null;

function ensureLeadPage() {
  let page = document.getElementById('lead-profile');
  if (!page) {
    page = document.createElement('section');
    page.id = 'lead-profile';
    page.className = 'page';
    document.querySelector('.content')?.appendChild(page);
  }
  return page;
}

export async function openLeadPage(id) {
  try {
    const [lead, enquiries, notes, sla] = await Promise.all([
      get('/leads/' + encodeURIComponent(id)),
      get('/leads/' + encodeURIComponent(id) + '/enquiries'),
      get('/leads/' + encodeURIComponent(id) + '/notes'),
      get('/settings/lead-sla').catch(() => null),
    ]);
    currentLead = lead;
    const page = ensureLeadPage();
    const name = leadDisplayName(lead);
    const months = lead.durationMonths || 6;
    const slaTarget = sla ? (sla.targets[{ WHATSAPP: 'whatsapp', PHONE: 'phone' }[lead.source] || 'website'] || 15) : 15;
    const slaChannel = { WHATSAPP: 'WhatsApp', PHONE: 'Phone / missed call' }[lead.source] || 'Website';
    page.innerHTML = `<div class="v2-lead-hero"><div class="v2-person"><div class="avatar">${esc(initials(name))}</div><div><button class="v2-name" data-lw="lead-back">← Lead database</button><h1>${esc(name)}</h1><p>${esc(lead.displayId)} · ${lead.type === 'BUSINESS' ? 'Business' : 'Personal'}${lead.representative ? ' · Representative ' + esc(lead.representative) : ''}</p><div class="v2-contactline">${lead.email ? `<a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a>` : ''}${lead.mobile ? `<a href="tel:${esc(lead.mobile)}">${esc(lead.mobile)}</a>` : ''}${lead.uen ? `<span>UEN ${esc(lead.uen)}</span>` : ''}</div><div class="v2-tags"><span class="pill ${leadStatusColour(lead.stageLabel)}">${esc(lead.stageLabel)}</span><span class="pill grey">${PRODUCT}</span></div></div></div><div class="v2-hero-actions"><button class="btn" data-lw="enquiry-new" data-lead="${esc(lead.id)}">＋ Add enquiry</button><button class="btn" data-lw="requirement" data-lead="${esc(lead.id)}">Edit requirement</button><button class="btn" data-lw="appointment-new" data-lead="${esc(lead.id)}">Schedule</button>${can('leads:delete') ? `<button class="btn" data-lw="lead-delete" data-lead="${esc(lead.id)}" data-name="${esc(name)}">Delete</button>` : ''}${can('quotes:create') ? `<button class="primary" data-lw="quote-new" data-lead="${esc(lead.id)}">＋ Create quote</button>` : ''}</div></div>
    <div class="v2-profile-kpis"><div class="v2-profile-kpi"><small>Total enquiries</small><b>${enquiries.length}</b><span>Same identity retained</span></div><div class="v2-profile-kpi"><small>Potential value ${tip(potentialText)}</small><b>${lead.potentialValue == null ? '—' : money(lead.potentialValue)}</b><span>${lead.monthlyRate == null ? 'Add the expected rent' : `${money(lead.monthlyRate)}/month × ${months} months`}</span></div><div class="v2-profile-kpi"><small>Probability ${tip(probabilityText(lead.stageLabel, lead.probability))}</small><b>${lead.probability}%</b><span>Explainable stage probability</span></div><div class="v2-profile-kpi"><small>Date of enquiry</small><b>${esc(humanDate(lead.enquiryDate))}</b><span>Editable source date</span></div><div class="v2-profile-kpi"><small>Assigned salesperson</small><b>${esc(lead.owner || 'Unassigned')}</b><span>First response SLA active</span></div></div>
    <div class="v2-tabs" role="tablist"><button class="active" data-lw-tab="overview">Overview</button><button data-lw-tab="enquiries">Enquiries</button><button data-lw-tab="notes">Notes &amp; tasks</button></div>
    <div class="v2-panel active" data-lw-panel="overview"><div class="v29-customer-grid"><div class="v29-customer-card"><header><div><h3>Current requirement</h3><p>${PRODUCT} enquiry</p></div></header><div class="body"><div class="v29-facts"><div><small>Size</small><b>${esc(sizeText(lead.size))}</b></div><div><small>Access</small><b>${esc(lead.accessFrequency || 'Not sure')}</b></div><div><small>Move-in</small><b>${esc(humanDate(lead.moveInDate))}</b></div><div><small>Customer type</small><b>${lead.type === 'BUSINESS' ? 'Business' : 'Personal'}</b></div><div><small>Facility</small><b>${esc(lead.branchName ? 'StoreLah ' + lead.branchName : 'No preference')}</b></div><div><small>Source</small><b>${esc(SOURCE_LABEL[lead.source] || lead.source)}</b></div></div></div></div><div class="v29-customer-card"><header><div><h3>First response SLA</h3><p>Controlled in Global Settings</p></div></header><div class="body"><b>${esc(slaChannel)}: ${slaTarget} minutes</b><p class="v29-help">Starts when the enquiry is created and stops at the first human response. Business-hours and escalation rules apply.</p></div></div></div></div>
    <div class="v2-panel" data-lw-panel="enquiries"><div class="v2-card"><div class="v2-card-head"><h3>Enquiry history</h3><button class="primary" data-lw="enquiry-new" data-lead="${esc(lead.id)}">＋ Add enquiry</button></div><div class="table-wrap"><table class="v2-table"><thead><tr><th>Enquiry</th><th>Date</th><th>Product</th><th>Source</th><th>Size / access</th><th>Status</th></tr></thead><tbody>${enquiries.map((e) => `<tr><td><b>${esc(e.displayId)}</b></td><td>${esc(humanDate(e.enquiryDate))}</td><td>${PRODUCT}<small>${esc(e.branchName ? 'StoreLah ' + e.branchName : 'No preference')}</small></td><td>${esc(SOURCE_LABEL[e.source] || e.source)}</td><td>${esc(sizeText(e.size))}<small>${esc(e.accessFrequency || 'Not sure')}</small></td><td><span class="pill ${leadStatusColour(e.stageLabel)}">${esc(e.stageLabel)}</span></td></tr>`).join('')}</tbody></table></div></div></div>
    <div class="v2-panel" data-lw-panel="notes"><div class="note-composer"><textarea id="lwNoteBody" data-mention="1" placeholder="Add an internal note. Type @ to mention a colleague…"></textarea><div class="note-composer-foot"><span class="mention-hint">Mentioned users receive an overview notification</span><button class="primary" data-lw="note-save" data-entity="lead" data-id="${esc(lead.id)}">Add note</button></div></div><div id="lwNotes">${notesHtml(notes)}</div></div>`;
    goPage('lead-profile');
    document.body.classList.add('lead-context');
  } catch (err) {
    showBanner('Lead: ' + describeError(err));
  }
}

export function notesHtml(notes) {
  if (!notes.length) return '<div class="v3-empty"><b>No internal notes yet</b><span>Add context, decisions and the next action without changing the customer-facing conversation.</span></div>';
  return `<div class="v3-note-list">${notes.map((n) => `<article class="v3-note-card"><div><b>${esc(n.author)}</b><time>${esc(new Date(n.createdAt).toLocaleString('en-SG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</time></div><p>${esc(n.body)}</p><footer><span>Internal</span>${Array.isArray(n.mentions) && n.mentions.length ? `<strong>${n.mentions.map((m) => '@' + esc(m.name)).join(', ')}</strong>` : ''}</footer></article>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Enquiry + requirement
// ---------------------------------------------------------------------------
async function openEnquiryForm(leadId) {
  const l = leadId ? await get('/leads/' + encodeURIComponent(leadId)) : currentLead;
  if (!l) { notify('Open a lead first.'); return; }
  const business = l.type === 'BUSINESS';
  openModal({
    title: `Add enquiry · ${leadDisplayName(l)}`, kicker: 'EXISTING MASTER LEAD', wide: true,
    body: `<div class="v29-callout"><i>🔒</i><div><b>Identity is prefilled and locked</b>This creates another enquiry under ${esc(l.displayId)}. Change master contact details from the lead identity screen, not here.</div></div><input id="lwEnqLead" type="hidden" value="${esc(l.id)}"><div class="v29-grid three">${business ? `<label class="v29-field"><span>Company name</span><input value="${esc(l.companyName || l.name)}" readonly></label><label class="v29-field"><span>UEN</span><input value="${esc(l.uen || '')}" readonly></label><label class="v29-field"><span>Representative</span><input value="${esc(l.representative || '')}" readonly></label>` : `<label class="v29-field"><span>Full name</span><input value="${esc(l.name)}" readonly></label>`}<label class="v29-field"><span>Email</span><input value="${esc(l.email || '')}" readonly></label><label class="v29-field"><span>Mobile</span><input value="${esc(l.mobile || '')}" readonly></label><label class="v29-field"><span>Date of enquiry *</span><input id="lwEnqDate" type="date" value="${sgYmd()}"></label><label class="v29-field"><span>Source</span><select id="lwEnqSource">${SOURCES.map(([v, t]) => option(v, t, l.source)).join('')}</select></label><label class="v29-field"><span>Product</span><input value="${PRODUCT}" readonly></label><label class="v29-field"><span>Facility</span><select id="lwEnqBranch">${branchOptions('')}</select></label><label class="v29-field"><span>Estimated size</span><select id="lwEnqSize">${sizeOptions('')}</select></label><label class="v29-field"><span>Access frequency</span><select id="lwEnqAccess">${ACCESS.map((s) => option(s, s)).join('')}</select></label><label class="v29-field"><span>Expected duration</span><select id="lwEnqDuration"><option value="">Not sure</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">12 months</option><option value="">Ongoing</option></select></label><label class="v29-field"><span>Expected move-in</span><input id="lwEnqMove" type="date" value="${sgYmd()}"></label><label class="v29-field full"><span>Requirement / notes</span><textarea id="lwEnqNotes"></textarea></label></div>`,
    footer: '<button class="btn" data-lw="close">Cancel</button><button class="primary" data-lw="enquiry-save">Save enquiry</button>',
  });
}

async function saveEnquiry(btn) {
  const leadId = val('lwEnqLead');
  if (!val('lwEnqDate')) { notify('Enter the date of enquiry.'); return; }
  await busy(btn, async () => {
    const e = await post(`/leads/${encodeURIComponent(leadId)}/enquiries`, {
      enquiryDate: val('lwEnqDate'), source: val('lwEnqSource'), preferredBranchId: val('lwEnqBranch') || null,
      preferredSize: val('lwEnqSize'), accessFrequency: val('lwEnqAccess'), durationMonths: val('lwEnqDuration') ? Number(val('lwEnqDuration')) : null,
      moveInDate: val('lwEnqMove') || null, note: val('lwEnqNotes').trim() || null,
    });
    closeModal();
    notify(`${e.displayId} saved under ${leadDisplayName(e)}.`);
    await openLeadPage(leadId);
  });
}

function openRequirement() {
  const l = currentLead;
  if (!l) { notify('Open a lead first.'); return; }
  openModal({
    title: 'Edit lead requirement', kicker: 'CURRENT AC SELF-STORAGE ENQUIRY', wide: true,
    body: `<div class="v29-callout"><i>i</i><div><b>Updates the active opportunity</b>These fields drive unit recommendations, quotation inputs and the lead summary. They do not alter older enquiries.</div></div><div class="v29-grid three"><label class="v29-field"><span>Product</span><input value="${PRODUCT}" readonly></label><label class="v29-field"><span>Preferred facility</span><select id="lwReqBranch">${branchOptions((state.branches || []).find((b) => b.code === l.branchCode)?.id || '')}</select></label><label class="v29-field"><span>Required size</span><select id="lwReqSize">${sizeOptions(l.size || '')}</select></label><label class="v29-field"><span>Monthly budget</span><input id="lwReqBudget" type="number" min="0" value="${esc(l.monthlyRate ?? '')}"></label><label class="v29-field"><span>Expected duration</span><select id="lwReqDuration">${[['', 'Not sure'], ['3', '3 months'], ['6', '6 months'], ['12', '12 months']].map(([v, t]) => option(v, t, l.durationMonths ?? '')).join('')}</select></label><label class="v29-field"><span>Expected move-in</span><input id="lwReqMove" type="date" value="${esc(l.moveInDate ? String(l.moveInDate).slice(0, 10) : '')}"></label><label class="v29-field"><span>Access frequency</span><select id="lwReqAccess">${ACCESS.map((s) => option(s, s, l.accessFrequency || 'Not sure')).join('')}</select></label><label class="v29-field"><span>Date of enquiry</span><input id="lwReqDate" type="date" value="${esc(l.enquiryDate || '')}"></label><label class="v29-field full"><span>Requirement note</span><textarea id="lwReqNote" placeholder="Special access, shelving, unit location or decision constraints…">${esc(l.note || '')}</textarea></label></div>`,
    footer: '<button class="btn" data-lw="close">Cancel</button><button class="primary" data-lw="requirement-save">Update requirement</button>',
  });
}

async function saveRequirement(btn) {
  const l = currentLead;
  await busy(btn, async () => {
    await patch('/leads/' + encodeURIComponent(l.id), {
      preferredBranchId: val('lwReqBranch') || null, preferredSize: val('lwReqSize'), monthlyRate: val('lwReqBudget') === '' ? null : Number(val('lwReqBudget')),
      durationMonths: val('lwReqDuration') ? Number(val('lwReqDuration')) : null, moveInDate: val('lwReqMove') || null,
      accessFrequency: val('lwReqAccess'), enquiryDate: val('lwReqDate') || null, note: val('lwReqNote').trim() || null,
    });
    closeModal();
    notify('Lead requirement updated across the active opportunity and quote inputs.');
    await openLeadPage(l.id);
  });
}

// ---------------------------------------------------------------------------
// Notes + @mentions + notifications
// ---------------------------------------------------------------------------
const mentionPicks = new WeakMap(); // textarea → Map(name → userId)

function installMentionMenu() {
  if (document.getElementById('v29MentionMenu')) return;
  const menu = document.createElement('div');
  menu.id = 'v29MentionMenu';
  menu.className = 'v29-mention-menu';
  menu.setAttribute('role', 'listbox');
  document.body.appendChild(menu);
  let target = null;
  document.addEventListener('input', async (e) => {
    const el = e.target;
    if (!el.matches || !el.matches('textarea[data-mention]')) return;
    const m = el.value.slice(0, el.selectionStart).match(/@([\w .'-]*)$/);
    if (!m) { menu.classList.remove('open'); return; }
    target = el;
    const users = (await mentionableUsers()).filter((u) => u.name.toLowerCase().includes(m[1].toLowerCase())).slice(0, 7);
    if (!users.length) { menu.classList.remove('open'); return; }
    const r = el.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 290) + 'px';
    menu.style.top = Math.min(r.bottom + 5, window.innerHeight - 280) + 'px';
    menu.innerHTML = users.map((u) => `<button type="button" role="option" data-mention-id="${esc(u.id)}" data-mention-name="${esc(u.name)}"><b>@${esc(u.name)}</b><span>${esc(u.email)}</span></button>`).join('');
    menu.classList.add('open');
  }, true);
  window.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mention-id]');
    if (b && target) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const pos = target.selectionStart;
      const before = target.value.slice(0, pos).replace(/@([\w .'-]*)$/, '@' + b.dataset.mentionName + ' ');
      target.value = before + target.value.slice(pos);
      target.focus();
      target.selectionStart = target.selectionEnd = before.length;
      if (!mentionPicks.has(target)) mentionPicks.set(target, new Map());
      mentionPicks.get(target).set(b.dataset.mentionName, b.dataset.mentionId);
      menu.classList.remove('open');
    } else if (!e.target.closest('#v29MentionMenu')) menu.classList.remove('open');
  }, true);
}

export async function saveNote(btn, entity, id, textareaId, listId) {
  const ta = document.getElementById(textareaId);
  const body = (ta?.value || '').trim();
  if (!body) { notify('Write a note first.'); return; }
  const picks = mentionPicks.get(ta) || new Map();
  const mentions = [...picks.entries()].filter(([name]) => body.includes('@' + name)).map(([, uid]) => uid);
  await busy(btn, async () => {
    const note = await post(`/${entity === 'lead' ? 'leads' : 'tenants'}/${encodeURIComponent(id)}/notes`, { body, mentions });
    ta.value = '';
    picks.clear();
    notify(note.notified?.length ? `Mention notification sent to ${note.notified.join(', ')}.` : 'Note saved.');
    const list = document.getElementById(listId);
    if (list) list.innerHTML = notesHtml(await get(`/${entity === 'lead' ? 'leads' : 'tenants'}/${encodeURIComponent(id)}/notes`));
    refreshNotificationBadge();
  });
}

async function refreshNotificationBadge() {
  const btn = document.querySelector('.top-actions .iconbtn[title="Notifications"]');
  if (!btn) return;
  btn.dataset.lw = 'notifications';
  let badge = btn.querySelector('.v29-notification-dot');
  if (!badge) { badge = document.createElement('span'); badge.className = 'v29-notification-dot'; btn.appendChild(badge); }
  try {
    const { unread } = await get('/notifications');
    badge.textContent = unread;
    badge.style.display = unread ? '' : 'none'; // the prototype dot style overrides [hidden]
    btn.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
  } catch { badge.style.display = 'none'; }
}

async function openNotifications() {
  const { rows } = await get('/notifications');
  openModal({
    title: 'Team mention activity', kicker: 'OVERVIEW NOTIFICATIONS', wide: true,
    body: `<div class="v29-callout"><i>@</i><div><b>Mentions are routed to the named user</b>When that user signs in, the item appears in their Overview notification queue until acknowledged. The sender and linked lead/customer/task are retained.</div></div><div class="v29-agenda">${rows.length ? rows.map((n) => `<button class="v29-agenda-item" ${n.entityType === 'lead' ? `data-lw="open-lead" data-id="${esc(n.entityId)}"` : ''}><b>${esc(n.title)}</b><span>${esc(n.body || '')}</span><small>${esc(new Date(n.createdAt).toLocaleString('en-SG'))} · ${n.readAt ? 'Acknowledged' : 'Pending acknowledgement'}</small></button>`).join('') : '<div class="v29-empty"><b>No mention activity yet</b><span>Type @ in a lead note, customer note or task instructions.</span></div>'}</div>`,
    footer: '<button class="primary" data-lw="close">Done</button>',
  });
  if (rows.some((n) => !n.readAt)) { await post('/notifications/read', {}).catch(() => {}); refreshNotificationBadge(); }
}

// ---------------------------------------------------------------------------
// Pipeline settings
// ---------------------------------------------------------------------------
const AGEING = [[15, '15 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [720, '12 hours'], [1440, '24 hours'], [4320, '3 days'], [null, 'No limit']];

async function openPipelineSettings() {
  const s = await get('/leads/pipeline-settings');
  const labels = { NEW_ENQUIRY: 'New', CONTACTED: 'Contacted', QUALIFIED: 'Qualified', VIEWING_BOOKED: 'Viewing set', PROPOSAL_SENT: 'Quoted', PENDING_PAYMENT: 'Booking started', PAID_BOOKING: 'Paid booking', WON: 'Converted', LOST: 'Lost', NURTURING: 'Nurturing' };
  const colours = ['#547b8d', '#6c8490', '#5d6e52', '#c98a58', '#a96245', '#8b6743', '#55775f', '#3e6648', '#9b5a54', '#7d7f86'];
  const editable = can('pipeline:update');
  const ageOpts = (v) => (AGEING.some(([m]) => m === v) ? AGEING : [[v, `${v} minutes`], ...AGEING]).map(([m, t]) => option(m ?? '', t, v ?? '')).join('');
  openModal({
    title: 'Pipeline settings', kicker: 'AC SELF-STORAGE SALES LIFECYCLE', wide: true,
    body: `<div class="v29-callout"><i>i</i><div><b>This controls more than stage names</b>Stage probability feeds weighted pipeline reporting. Entry requirements, ageing limits and automation determine what staff must do before an enquiry can move forward.</div></div><input type="hidden" id="lwPipeVersion" value="${s.version}"><div class="table-wrap" style="margin-top:16px"><table class="v29-stage-table"><thead><tr><th>Stage</th><th>Probability</th><th>Maximum ageing</th><th>Required before entry</th><th>Automation</th></tr></thead><tbody>${s.stages.map((st, i) => `<tr data-stage="${esc(st.stage)}"><td><span class="v29-stage-dot" style="background:${colours[i] || '#7d7f86'}"></span><b>${esc(labels[st.stage] || st.stage)}</b></td><td><input type="number" min="0" max="100" value="${st.probability}" data-k="probability" aria-label="${esc(labels[st.stage])} probability" ${editable ? '' : 'disabled'}>%</td><td><select data-k="maxAgeMinutes" ${editable ? '' : 'disabled'}>${ageOpts(st.maxAgeMinutes)}</select></td><td><input value="${esc(st.requiredBeforeEntry)}" data-k="requiredBeforeEntry" ${editable ? '' : 'disabled'}></td><td><input value="${esc(st.automation)}" data-k="automation" ${editable ? '' : 'disabled'}></td></tr>`).join('')}</tbody></table></div><div class="v29-grid" style="margin-top:16px"><label class="v29-field"><span>Assignment rule</span><select id="lwPipeAssign" ${editable ? '' : 'disabled'}>${['Facility + workload round robin', 'Round robin across available sales staff', 'Manual assignment', 'Source owner'].concat(s.assignmentRule).filter((v, i, a) => a.indexOf(v) === i).map((v) => option(v, v, s.assignmentRule)).join('')}</select></label><label class="v29-field"><span>Lost reasons</span><input id="lwPipeLost" value="${esc(s.lostReasons.join(', '))}" ${editable ? '' : 'disabled'}></label><label class="v29-field"><span>Required next action</span><select id="lwPipeNext" ${editable ? '' : 'disabled'}>${option('1', 'Required on every open stage', s.requireNextAction ? '1' : '0')}${option('0', 'Required after qualification', s.requireNextAction ? '1' : '0')}</select></label><label class="v29-field"><span>First-response SLA</span><button class="btn" data-lw="open-sla">Configure in Global Settings</button></label></div>`,
    footer: `<span class="hint">${s.version ? `Version ${s.version} · saved by ${esc(s.savedBy || '—')}` : 'Changes create a versioned pipeline configuration.'}</span><button class="btn" data-lw="close">Cancel</button>${editable ? '<button class="primary" data-lw="pipeline-save">Save pipeline settings</button>' : ''}`,
  });
}

async function savePipelineSettings(btn) {
  const stages = [...document.querySelectorAll('.v29-stage-table tbody tr')].map((tr) => {
    const get_ = (k) => tr.querySelector(`[data-k="${k}"]`).value;
    return { stage: tr.dataset.stage, probability: Math.max(0, Math.min(100, Math.round(Number(get_('probability')) || 0))), maxAgeMinutes: get_('maxAgeMinutes') === '' ? null : Number(get_('maxAgeMinutes')), requiredBeforeEntry: get_('requiredBeforeEntry').trim(), automation: get_('automation').trim() };
  });
  await busy(btn, async () => {
    const saved = await put('/leads/pipeline-settings', {
      version: Number(val('lwPipeVersion')), stages, assignmentRule: val('lwPipeAssign'),
      lostReasons: val('lwPipeLost').split(',').map((x) => x.trim()).filter(Boolean), requireNextAction: val('lwPipeNext') === '1',
    });
    closeModal();
    notify(`Pipeline settings saved as version ${saved.version}.`);
  });
}

// ---------------------------------------------------------------------------
// Appointments (calendar-first)
// ---------------------------------------------------------------------------
const cal = { preset: 'week', start: '', end: '', type: '', staff: '', status: '', view: 'calendar', rows: [] };
const addDays = (v, n) => { const d = new Date(v + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function weekStart(v) { const d = new Date(v + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; return addDays(v, -dow); }
function setPeriod(preset) {
  const today = sgYmd();
  cal.preset = preset;
  if (preset === 'week') { cal.start = weekStart(today); cal.end = addDays(cal.start, 6); }
  else if (preset === 'today') { cal.start = today; cal.end = today; }
  else if (preset === 'next7') { cal.start = today; cal.end = addDays(today, 6); }
  else if (preset === 'month') { cal.start = today.slice(0, 8) + '01'; const d = new Date(cal.start + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); cal.end = d.toISOString().slice(0, 10); }
}
const sgParts = (iso) => { const d = new Date(iso); return { date: sgYmd(d), time: new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false }).format(d) }; };
const apptType = (t) => APPT_TYPE.find((x) => x[0] === t) || APPT_TYPE[1];
const apptStatus = (s) => (APPT_STATUS.find((x) => x[0] === s) || [s, s === 'CANCELLED' ? 'Cancelled' : s])[1];
const dayLabel = (v) => new Intl.DateTimeFormat('en-SG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(v + 'T00:00:00Z'));

export async function renderAppointments() {
  const page = document.getElementById('calendar');
  if (!page) return;
  if (!cal.start) setPeriod('week');
  try {
    cal.rows = await get(`/appointments?from=${cal.start}&to=${cal.end}`);
  } catch (err) { showBanner('Appointments: ' + describeError(err)); cal.rows = []; }
  const users = await mentionableUsers();
  const rows = cal.rows.map((a) => ({ ...a, ...sgParts(a.startAt) })).filter((a) => a.date >= cal.start && a.date <= cal.end && (!cal.type || a.type === cal.type) && (!cal.staff || a.staff === cal.staff) && (!cal.status || a.status === cal.status));
  const days = []; for (let d = cal.start; d <= cal.end && days.length < 31; d = addDays(d, 1)) days.push(d);
  const hours = ['09', '10', '11', '12', '13', '14', '15', '16', '17'];
  let cells = '<div class="v29-day">Time</div>' + days.map((d) => `<div class="v29-day">${esc(dayLabel(d))}</div>`).join('');
  hours.forEach((h) => {
    cells += `<div class="v29-time">${h}:00</div>`;
    days.forEach((d) => {
      const evs = rows.filter((a) => a.date === d && (a.time.slice(0, 2) === h || (h === '09' && a.time.slice(0, 2) < '09') || (h === '17' && a.time.slice(0, 2) > '17')));
      cells += `<div>${evs.map((a) => `<button class="v29-calendar-event v29-event-${apptType(a.type)[2]}" data-lw="appointment-open" data-id="${esc(a.id)}"><b>${esc(a.time)} · ${esc(apptType(a.type)[1])}</b><small>${esc(a.personName)}</small></button>`).join('')}</div>`;
    });
  });
  const agenda = rows.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map((a) => `<button class="v29-agenda-item" data-lw="appointment-open" data-id="${esc(a.id)}"><b>${esc(humanDate(a.date))} · ${esc(a.time)}</b><span>${esc(a.personName)} · ${esc(apptType(a.type)[1])}</span><small>${esc(a.staff || 'Unassigned')} · ${esc(apptStatus(a.status))}</small></button>`).join('') || '<div class="v29-empty"><b>No appointments match</b><span>Change the date range or clear one of the filters.</span></div>';
  const custom = cal.preset === 'custom' ? `<div class="v29-custom-range"><label><span>From</span><input id="lwCalStart" type="date" value="${cal.start}"></label><label><span>To</span><input id="lwCalEnd" type="date" value="${cal.end}"></label><button class="btn" data-lw="calendar-apply-custom">Apply date range</button></div>` : '';
  page.innerHTML = `<div class="head"><div><h1>Appointments</h1><p>Calendar-first view of viewings, calls, video consultations and move-in handovers.</p></div><div class="actions"><button class="btn" data-lw="calendar-sync">Calendar sync</button>${can('calendar:create') ? '<button class="primary" data-lw="appointment-new">＋ Schedule appointment</button>' : ''}</div></div>
  <div class="v2-tools"><select class="filter" id="lwCalPeriod" aria-label="Period">${[['week', `Week of ${humanDate(weekStart(sgYmd()))}`], ['today', 'Today'], ['next7', 'Next 7 days'], ['month', 'This month'], ['custom', 'Custom range…']].map(([v, t]) => option(v, t, cal.preset)).join('')}</select><select class="filter" id="lwCalType" aria-label="Appointment type"><option value="">All appointment types</option>${APPT_TYPE.map(([v, t]) => option(v, t, cal.type)).join('')}</select><select class="filter" id="lwCalStaff" aria-label="Staff"><option value="">All staff</option>${users.map((u) => option(u.name, u.name, cal.staff)).join('')}</select><select class="filter" id="lwCalStatus" aria-label="Status"><option value="">All statuses</option>${APPT_STATUS.map(([v, t]) => option(v, t, cal.status)).join('')}</select><span class="grow"></span><div class="seg"><button class="${cal.view === 'calendar' ? 'active' : ''}" data-lw="calendar-view" data-view="calendar">Calendar</button><button class="${cal.view === 'agenda' ? 'active' : ''}" data-lw="calendar-view" data-view="agenda">Agenda</button></div></div>${custom}
  <div class="v29-filter-summary"><b>${rows.length} appointment${rows.length === 1 ? '' : 's'}</b><span>${humanDate(cal.start)} – ${humanDate(cal.end)}${cal.type ? ' · ' + esc(apptType(cal.type)[1]) : ''}${cal.staff ? ' · ' + esc(cal.staff) : ''}${cal.status ? ' · ' + esc(apptStatus(cal.status)) : ''}</span></div>
  <div class="v29-legend"><span><i style="background:#c97952"></i>Facility viewing</span><span><i style="background:#547b8d"></i>Call</span><span><i style="background:#8060a2"></i>Video consultation</span><span><i style="background:#5d6e52"></i>Move-in handover</span></div>
  ${cal.view === 'calendar' ? `<div class="v29-calendar-shell" style="margin-top:12px"><div class="v29-calendar"><div class="v29-calendar-grid" style="grid-template-columns:76px repeat(${days.length},minmax(135px,1fr));min-width:${Math.max(480, 76 + days.length * 135)}px">${cells}</div></div><div class="v2-card"><div class="v2-card-head"><div><h3>Filtered agenda</h3><p>${rows.length} appointments in this view</p></div></div><div class="v2-card-body"><div class="v29-agenda">${agenda}</div></div></div></div>` : `<div class="v2-card v29-agenda-only"><div class="v2-card-head"><div><h3>Appointment agenda</h3><p>Sorted by date and time</p></div></div><div class="v2-card-body"><div class="v29-agenda">${agenda}</div></div></div>`}`;
  page.querySelector('#lwCalPeriod')?.addEventListener('change', (e) => { setPeriod(e.target.value); if (e.target.value !== 'custom') renderAppointments(); else renderAppointments(); });
  page.querySelector('#lwCalType')?.addEventListener('change', (e) => { cal.type = e.target.value; renderAppointments(); });
  page.querySelector('#lwCalStaff')?.addEventListener('change', (e) => { cal.staff = e.target.value; renderAppointments(); });
  page.querySelector('#lwCalStatus')?.addEventListener('change', (e) => { cal.status = e.target.value; renderAppointments(); });
}

async function openAppointmentForm(leadId) {
  const context = leadId ? await get('/leads/' + encodeURIComponent(leadId)) : null;
  const users = await mentionableUsers();
  const leadOptions = context ? '' : (await leadsFlat()).filter((l) => !['WON', 'LOST'].includes(l.stage)).map((l) => option(l.id, `${l.displayId} · ${leadDisplayName(l)}`)).join('');
  const enquiries = context ? await get(`/leads/${encodeURIComponent(context.id)}/enquiries`) : [];
  openModal({
    title: 'Schedule appointment', kicker: 'LEAD-LINKED CALENDAR EVENT', wide: true,
    body: `<div class="v29-callout"><i>↔</i><div><b>${context ? 'Lead identity is locked' : 'Select the lead first'}</b>${context ? 'Because this appointment started inside the lead profile, another lead cannot be substituted.' : 'The appointment will be written to the selected lead, enquiry and central calendar.'}</div></div><div class="v29-grid three"><label class="v29-field"><span>Lead *</span>${context ? `<input value="${esc(context.displayId)} · ${esc(leadDisplayName(context))}" readonly><input id="lwApptLead" type="hidden" value="${esc(context.id)}">` : `<select id="lwApptLead"><option value="">Select lead…</option>${leadOptions}</select>`}</label><label class="v29-field"><span>Enquiry *</span><select id="lwApptEnquiry">${context ? enquiries.map((e) => option(e.id, `${e.displayId} · ${humanDate(e.enquiryDate)}`, context.id)).join('') : '<option value="">Current enquiry</option>'}</select></label><label class="v29-field"><span>Appointment type *</span><select id="lwApptType">${APPT_TYPE.map(([v, t]) => option(v, t)).join('')}</select></label><label class="v29-field"><span>Facility / method</span><select id="lwApptBranch">${branchOptions(state.branches?.[0]?.id, 'Phone call / video link')}</select></label><label class="v29-field"><span>Date *</span><input id="lwApptDate" type="date" value="${sgYmd()}"></label><label class="v29-field"><span>Start time *</span><input id="lwApptTime" type="time" value="10:00"></label><label class="v29-field"><span>Duration</span><select id="lwApptDuration"><option value="30">30 minutes</option><option value="45" selected>45 minutes</option><option value="60">60 minutes</option></select></label><label class="v29-field"><span>Assigned staff</span><select id="lwApptStaff">${users.map((u) => option(u.name, u.name, context?.owner || '')).join('')}</select></label><label class="v29-field"><span>Status</span><select id="lwApptStatus">${APPT_STATUS.slice(0, 3).map(([v, t]) => option(v, t)).join('')}</select></label><label class="v29-field full"><span>Purpose and preparation notes</span><textarea id="lwApptNotes" placeholder="Unit options, decision makers, access needs and preparation…"></textarea></label></div>`,
    footer: '<span class="hint">Saving updates both the lead and central Appointments calendar.</span><button class="btn" data-lw="close">Cancel</button><button class="primary" data-lw="appointment-save">Schedule &amp; send confirmation</button>',
  });
}

async function saveAppointment(btn) {
  const enquiryId = val('lwApptEnquiry') || val('lwApptLead');
  if (!val('lwApptLead')) { notify('Select a lead.'); return; }
  if (!val('lwApptDate') || !val('lwApptTime')) { notify('Choose the date and start time.'); return; }
  await busy(btn, async () => {
    const lead = await get('/leads/' + encodeURIComponent(enquiryId));
    const start = new Date(`${val('lwApptDate')}T${val('lwApptTime')}:00+08:00`);
    const end = new Date(start.getTime() + Number(val('lwApptDuration')) * 60000);
    const type = val('lwApptType');
    await post('/appointments', {
      title: `${apptType(type)[1]} · ${lead.displayId}`, personName: leadDisplayName(lead), type, leadId: lead.id,
      branchId: val('lwApptBranch') || null, startAt: start.toISOString(), endAt: end.toISOString(), staff: val('lwApptStaff') || null,
      note: val('lwApptNotes').trim() || null, status: val('lwApptStatus'),
    });
    closeModal();
    cal.start = ''; setPeriod('week');
    if (start.toISOString().slice(0, 10) > cal.end || start.toISOString().slice(0, 10) < cal.start) { cal.preset = 'custom'; cal.start = sgYmd(start); cal.end = addDays(cal.start, 6); }
    goPage('calendar');
    notify(`${apptType(type)[1]} saved to the lead and Appointments calendar.`);
  });
}

function appointmentDetail(id) {
  const a = cal.rows.find((x) => x.id === id);
  if (!a) return;
  const p = sgParts(a.startAt);
  const mins = a.endAt ? Math.round((new Date(a.endAt) - new Date(a.startAt)) / 60000) : null;
  openModal({
    title: `${a.personName} · ${apptType(a.type)[1]}`, kicker: 'APPOINTMENT', wide: true,
    body: `<div class="v29-facts"><div><small>Lead</small><b>${esc(a.title)}</b></div><div><small>When</small><b>${esc(humanDate(p.date))} · ${esc(p.time)}${mins ? ' · ' + mins + ' min' : ''}</b></div><div><small>Facility / method</small><b>${esc(a.branchName ? 'StoreLah ' + a.branchName : 'Phone call / video link')}</b></div><div><small>Assigned</small><b>${esc(a.staff || 'Unassigned')}</b></div><div><small>Status</small><b>${esc(apptStatus(a.status))}</b></div><div><small>Preparation</small><b>${esc(a.note || 'No notes')}</b></div></div>${can('calendar:update') ? `<label class="v29-field" style="margin-top:14px"><span>Update status</span><select id="lwApptNewStatus">${APPT_STATUS.concat([['CANCELLED', 'Cancelled']]).map(([v, t]) => option(v, t, a.status)).join('')}</select></label>` : ''}`,
    footer: `<button class="btn" data-lw="close">Close</button>${a.leadId ? `<button class="btn" data-lw="open-lead" data-id="${esc(a.leadId)}">Open lead</button>` : ''}${can('calendar:update') ? `<button class="primary" data-lw="appointment-status" data-id="${esc(a.id)}">Record outcome</button>` : ''}`,
  });
}

// ---------------------------------------------------------------------------
// Quotation register
// ---------------------------------------------------------------------------
const quoteState = { search: '', status: '', facility: '', data: null };

// Share-via-WhatsApp state for the live Create builder: the customer mobile
// is only known after GET /leads/:id, so the footer button stays disabled
// with a tooltip until a lead with a mobile is picked (or locked via context).
const quoteBuilderWa = { leadId: '', mobile: '', checked: false };

function paintQuoteBuilderWa() {
  const btn = document.getElementById('lwQuoteWa');
  if (!btn) return;
  const leadId = val('lwQuoteLead');
  if (!leadId) {
    quoteBuilderWa.leadId = '';
    btn.disabled = true;
    btn.title = 'Select a lead first';
    return;
  }
  if (!quoteBuilderWa.checked || quoteBuilderWa.leadId !== leadId) {
    btn.disabled = true;
    btn.title = 'Checking customer mobile…';
    return;
  }
  const digits = normalizeWaDigits(quoteBuilderWa.mobile);
  btn.disabled = !digits;
  btn.title = digits ? 'Share this quotation via WhatsApp' : 'Add customer mobile to share via WhatsApp';
}

export async function renderQuotes() {
  const page = document.getElementById('quotes');
  if (!page) return;
  const qs = new URLSearchParams();
  if (quoteState.search) qs.set('search', quoteState.search);
  if (quoteState.status) qs.set('status', quoteState.status);
  if (quoteState.facility) qs.set('facility', quoteState.facility);
  let data;
  try { data = await get('/quotations' + (qs.toString() ? '?' + qs : '')); } catch (err) { showBanner('Quotations: ' + describeError(err)); return; }
  quoteState.data = data;
  const s = data.summary;
  const facilities = (state.branches || []).map((b) => option(b.code, 'StoreLah ' + b.name, quoteState.facility)).join('');
  if (!page.querySelector('#lwQuoteTable')) {
    page.innerHTML = `<div class="head"><div><h1>Quotations</h1><p>A single serialised register for every lead-linked quotation, preview, delivery and outcome.</p></div><div class="actions"><button class="btn" data-lw="quote-export">Export register</button>${can('quotes:create') ? '<button class="primary" data-lw="quote-new">＋ Create quotation</button>' : ''}</div></div><div class="v29-callout"><i>i</i><div><b>Every quotation is serialised and lead-linked</b>Every saved quote receives the next serial number, remains linked to one lead and enquiry, and keeps its issued snapshot. Only an Administrator may delete a draft; issued/sent quotes are voided instead of deleted.</div></div><div class="v29-quote-summary" id="lwQuoteSummary"></div><div class="v2-tools"><div class="v2-search"><input id="lwQuoteSearch" placeholder="Search quotation number, lead, enquiry, unit or owner…" aria-label="Search quotations"></div><select id="lwQuoteStatus" class="filter" aria-label="Status"><option value="">All statuses</option>${Object.entries(QUOTE_STATUS_LABEL).map(([v, t]) => option(v, t)).join('')}</select><select id="lwQuoteFacility" class="filter" aria-label="Facility"><option value="">All facilities</option>${facilities}</select><span class="grow"></span><span class="pill green">Serial control active</span></div><div class="card"><div class="table-wrap"><table class="v2-table" id="lwQuoteTable"><thead><tr><th>Quotation</th><th>Lead / enquiry</th><th>Storage option</th><th>Gross / net monthly</th><th>Created / expiry</th><th>Delivery</th><th>Status</th><th>Owner</th><th>Clear actions</th></tr></thead><tbody></tbody></table></div></div>`;
    let t;
    page.querySelector('#lwQuoteSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { quoteState.search = e.target.value.trim(); renderQuotes(); }, 250); });
    page.querySelector('#lwQuoteStatus').addEventListener('change', (e) => { quoteState.status = e.target.value; renderQuotes(); });
    page.querySelector('#lwQuoteFacility').addEventListener('change', (e) => { quoteState.facility = e.target.value; renderQuotes(); });
  }
  page.querySelector('#lwQuoteSummary').innerHTML = `<div><small>Total quotations</small><b>${s.total}</b><span>All statuses</span></div><div><small>Awaiting follow-up</small><b>${s.awaitingFollowUp}</b><span>Sent or viewed</span></div><div><small>Accepted</small><b>${s.accepted}</b><span>Conversion retained</span></div><div><small>Drafts</small><b>${s.drafts}</b><span>Not customer-facing</span></div>`;
  page.querySelector('#lwQuoteTable tbody').innerHTML = data.rows.map((x) => `<tr><td><b>${esc(x.number)}</b><small>${x.status === 'DRAFT' ? 'Draft · number assigned on send' : 'Serialised quotation'}</small></td><td><button class="v2-name" data-lw="open-lead" data-id="${esc(x.leadId)}">${esc(x.leadName)}</button><small>${esc(x.leadDisplayId)} · ${esc(x.enquiry)}</small></td><td>${esc(x.unit || 'Size recommendation only')}<small>${esc(x.facility ? 'StoreLah ' + x.facility : '')}</small></td><td><b>${x.gross == null ? '—' : money(x.gross)}</b><small>Net ${x.net == null ? '—' : money(x.net)} + protection ${money(x.protection || 0)}</small></td><td>${esc(humanDate(x.createdAt))}<small>Expires ${esc(humanDate(x.expiresAt))}</small></td><td>${esc(x.delivery)}</td><td><span class="pill ${x.status === 'ACCEPTED' ? 'green' : x.status === 'DRAFT' ? 'grey' : /EXPIRED|VOIDED/.test(x.status) ? 'red' : 'blue'}">${esc(QUOTE_STATUS_LABEL[x.status] || x.status)}</span></td><td>${esc(x.owner || '—')}</td><td><div class="v29-actions"><button class="btn" data-lw="quote-preview" data-id="${esc(x.id)}">Preview</button>${x.status === 'VOIDED' ? '' : `<button class="btn" data-lw="quote-send" data-id="${esc(x.id)}">${x.status === 'DRAFT' ? 'Send' : 'Resend'}</button>`}<button class="btn" data-lw="quote-more" data-id="${esc(x.id)}">More ▾</button></div></td></tr>`).join('') || '<tr><td colspan="9" style="text-align:center;padding:28px">No quotations match.</td></tr>';
}

async function openQuoteBuilder(leadId) {
  const context = leadId ? await get('/leads/' + encodeURIComponent(leadId)) : null;
  const leads = context ? [] : (await leadsFlat()).filter((l) => !['WON', 'LOST'].includes(l.stage));
  openModal({
    title: 'Create quotation', kicker: 'SERIALISED + LEAD-LINKED', wide: true,
    body: `<div class="v29-callout"><i>i</i><div><b>Lead and enquiry are mandatory</b>${context ? 'This quotation started from a lead profile, so the lead is locked.' : 'Search by lead ID, company/person name, email, mobile or UEN.'} The quotation number is assigned sequentially only when saved.</div></div><div class="v29-grid three"><label class="v29-field full"><span>Lead *</span>${context ? `<input value="${esc(context.displayId)} · ${esc(leadDisplayName(context))}" readonly><input id="lwQuoteLead" type="hidden" value="${esc(context.id)}">` : `<input id="lwQuoteLeadSearch" autocomplete="off" placeholder="Search lead ID, name, email, mobile or UEN…"><input id="lwQuoteLead" type="hidden" value=""><div id="lwQuoteLeadResults" class="v29-lead-results" role="listbox"></div>`}</label><label class="v29-field"><span>Enquiry *</span><input id="lwQuoteEnquiry" value="${esc(context?.displayId || 'Select a lead first')}" readonly></label><label class="v29-field"><span>Product</span><input value="${PRODUCT}" readonly></label><label class="v29-field"><span>Facility</span><input id="lwQbFacility" value="${esc(context?.branchName ? 'StoreLah ' + context.branchName : '—')}" readonly></label><label class="v29-field"><span>Unit / size *</span><select id="lwQuoteUnit"><option value="">Size recommendation only</option></select></label><label class="v29-field"><span>Gross monthly rent</span><input id="lwQuoteGross" type="number" min="0" step="0.01" value="${esc(context?.monthlyRate ?? '')}"></label><label class="v29-field"><span>Promotion (from library)</span><select id="lwQuotePromoSel" aria-label="Promotion attached from the promotion library"><option value="">No promotion</option></select><small id="lwQuotePromoHint" class="v29-hint"></small></label><label class="v29-field"><span>Promo code (override)</span><input id="lwQuotePromoCode" autocomplete="off" placeholder="Type a code to override"></label><label class="v29-field"><span>Promotion %</span><input id="lwQuotePromo" type="number" min="0" max="100" step="0.5" value="0"></label><label class="v29-field"><span>Net monthly rent</span><input id="lwQuoteNet" readonly></label><label class="v29-field"><span>Protection Plan (monthly)</span><input id="lwQuoteProtection" type="number" min="0" step="0.5" value="${esc(context?.protectionCost ?? 12.5)}"></label><label class="v29-field"><span>Commitment</span><select id="lwQuoteCommitment">${[3, 6, 12].map((m) => option(m, m + ' months', context?.durationMonths || 6)).join('')}</select></label><label class="v29-field"><span>Valid until</span><input id="lwQuoteExpiry" type="date" value="${addDays(sgYmd(), 14)}"></label></div>`,
    footer: '<span class="hint">Preview does not consume a quotation number.</span><button class="btn" data-lw="quote-builder-preview">Preview quotation</button><button class="btn" data-lw="quote-builder-wa" id="lwQuoteWa" disabled title="Select a lead first">Share via WhatsApp</button><button class="btn" data-lw="close">Cancel</button><button class="primary" data-lw="quote-create">Create &amp; send</button>',
  });
  quoteBuilderWa.leadId = context?.id || '';
  quoteBuilderWa.mobile = context?.mobile || '';
  quoteBuilderWa.checked = !!context;
  quotePromo.options = []; quotePromo.code = ''; quotePromo.touched = false; quotePromo.extra = null;
  const calc = () => { applyQuotePromo(); const g = Number(val('lwQuoteGross')) || 0; const p = Number(val('lwQuotePromo')) || 0; document.getElementById('lwQuoteNet').value = money(g * (1 - p / 100)); paintQuoteBuilderWa(); };
  quotePromo.calc = calc;
  document.getElementById('lwQuoteGross').addEventListener('input', () => { calc(); refreshQuotePromos(); });
  document.getElementById('lwQuotePromo').addEventListener('input', calc);
  document.getElementById('lwQuoteCommitment').addEventListener('change', () => refreshQuotePromos());
  document.getElementById('lwQuotePromoSel').addEventListener('change', (e) => { quotePromo.touched = true; quotePromo.code = e.target.value; if (!quotePromo.code) document.getElementById('lwQuotePromo').value = 0; calc(); });
  document.getElementById('lwQuotePromoCode').addEventListener('change', () => validateQuotePromoCode());
  document.getElementById('lwQuotePromoCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); validateQuotePromoCode(); } });
  calc();
  refreshQuotePromos();
  paintQuoteBuilderWa();
  if (context) loadQuoteUnits(context);
  else {
    const search = document.getElementById('lwQuoteLeadSearch');
    const results = document.getElementById('lwQuoteLeadResults');
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase().trim();
      const matches = q ? leads.filter((l) => [l.displayId, l.name, l.companyName, l.email, l.mobile, l.uen].filter(Boolean).join(' ').toLowerCase().includes(q)).slice(0, 8) : [];
      results.innerHTML = matches.map((l) => `<button type="button" role="option" data-lw="quote-lead-select" data-id="${esc(l.id)}"><b>${esc(leadDisplayName(l))}</b><span>${esc(l.displayId)} · ${esc(l.email || l.mobile || '')}</span></button>`).join('');
      results.classList.toggle('open', matches.length > 0);
    });
  }
}

// ----- Promotion from the library (GET /quotes/promo-options) -----
// Options are scored server-side against this quote's gross rent, commitment
// and unit; the best valid one is pre-selected until the operator picks one.
// A typed override code is checked via POST /quotes/promo-validate. The chosen
// code fills Promotion % (read-only while a code is attached) and is sent as
// promoCode on POST /quotations, where it is re-validated.
const quotePromo = { options: [], code: '', touched: false, extra: null, seq: 0, calc: null };

function quotePromoCtx() {
  return { rate: Number(val('lwQuoteGross')) || 0, months: Number(val('lwQuoteCommitment')) || 1, unitCode: val('lwQuoteUnit') || '' };
}

function quotePromoList() {
  const list = quotePromo.options.slice();
  if (quotePromo.extra && !list.some((o) => o.code === quotePromo.extra.code)) list.unshift(quotePromo.extra);
  return list;
}

function paintQuotePromos() {
  const sel = document.getElementById('lwQuotePromoSel');
  if (!sel) return;
  const list = quotePromoList();
  sel.innerHTML = '<option value="">No promotion</option>' + list.map((o) => `<option value="${esc(o.code)}"${o.valid ? '' : ' disabled'}${o.code === quotePromo.code ? ' selected' : ''}>${esc(o.code)} · ${esc(o.name || 'Promotion')}${o.valid ? ' · −' + money(o.discountAmt) + '/mo' : ' · not applicable'}</option>`).join('');
  sel.value = quotePromo.code || '';
}

function applyQuotePromo() {
  const pct = document.getElementById('lwQuotePromo');
  const hint = document.getElementById('lwQuotePromoHint');
  if (!pct) return;
  const gross = Number(val('lwQuoteGross')) || 0;
  const o = quotePromoList().find((x) => x.code === quotePromo.code && x.valid);
  if (o) {
    pct.value = gross > 0 ? Math.round((o.discountAmt / gross) * 10000) / 100 : 0;
    pct.readOnly = true;
    if (hint) hint.textContent = `${o.code}: −${money(o.discountAmt)} per month (re-checked when the quotation is created).`;
  } else {
    pct.readOnly = false;
    if (hint) hint.textContent = quotePromo.options.length && !quotePromo.options.some((x) => x.valid) ? 'No library promotion applies to this rent, term or unit.' : '';
  }
}

async function refreshQuotePromos() {
  const seq = ++quotePromo.seq;
  const { rate, months, unitCode } = quotePromoCtx();
  const qs = new URLSearchParams({ rate: String(rate), months: String(months) });
  if (unitCode) qs.set('unitCode', unitCode);
  let options = [];
  try { options = (await get('/quotes/promo-options?' + qs)) || []; } catch { options = []; }
  if (seq !== quotePromo.seq || !document.getElementById('lwQuotePromoSel')) return;
  quotePromo.options = options;
  if (quotePromo.extra) {
    try {
      const v = await post('/quotes/promo-validate', { code: quotePromo.extra.code, rate, months, ...(unitCode ? { unitCode } : {}) });
      quotePromo.extra = { ...quotePromo.extra, valid: !!v.valid, discountAmt: v.discountAmt || 0 };
    } catch { /* keep the last result */ }
  }
  const current = quotePromoList().find((o) => o.code === quotePromo.code);
  if (!quotePromo.touched) quotePromo.code = (options.find((o) => o.valid) || {}).code || '';
  else if (quotePromo.code && !(current && current.valid)) quotePromo.code = '';
  if (!quotePromo.code) document.getElementById('lwQuotePromo').value = document.getElementById('lwQuotePromo').readOnly ? 0 : document.getElementById('lwQuotePromo').value;
  paintQuotePromos();
  quotePromo.calc?.();
}

async function validateQuotePromoCode() {
  const input = document.getElementById('lwQuotePromoCode');
  const hint = document.getElementById('lwQuotePromoHint');
  const code = (input?.value || '').trim().toUpperCase();
  if (!code) return;
  const { rate, months, unitCode } = quotePromoCtx();
  try {
    const v = await post('/quotes/promo-validate', { code, rate, months, ...(unitCode ? { unitCode } : {}) });
    if (!v.valid) { if (hint) hint.textContent = `Promo code ${code} does not apply to this rent, term or unit.`; return; }
    const known = quotePromo.options.find((o) => o.code === code);
    quotePromo.extra = known ? null : { code, name: 'Override code', valid: true, discountAmt: v.discountAmt || 0 };
    quotePromo.code = code;
    quotePromo.touched = true;
    input.value = '';
    paintQuotePromos();
    quotePromo.calc?.();
  } catch (e) {
    if (hint) hint.textContent = 'Promo code check failed: ' + describeError(e);
  }
}

async function loadQuoteUnits(lead) {
  const sel = document.getElementById('lwQuoteUnit');
  if (!sel) return;
  try {
    const qs = new URLSearchParams({ status: 'AVAILABLE', perPage: '200' });
    if (lead.branchCode) qs.set('branch', lead.branchCode);
    const units = await get('/units?' + qs);
    sel.innerHTML = '<option value="">Size recommendation only</option>' + (units || []).slice(0, 200).map((u) => option(u.unitCode, `${u.unitCode} · ${u.sqft} sq ft${u.rate ? ' · ' + money(u.rate) : ''}`, lead.unitCode || '')).join('');
    sel.onchange = () => { const u = (units || []).find((x) => x.unitCode === sel.value); if (u?.rate) { document.getElementById('lwQuoteGross').value = u.rate; document.getElementById('lwQuoteGross').dispatchEvent(new Event('input')); } else refreshQuotePromos(); };
  } catch { /* unit list is optional — a size recommendation can still be quoted */ }
  paintQuoteBuilderWa();
}

async function selectQuoteLead(id) {
  const l = await get('/leads/' + encodeURIComponent(id));
  document.getElementById('lwQuoteLead').value = id;
  document.getElementById('lwQuoteLeadSearch').value = `${l.displayId} · ${leadDisplayName(l)}`;
  document.getElementById('lwQuoteEnquiry').value = l.displayId;
  document.getElementById('lwQbFacility').value = l.branchName ? 'StoreLah ' + l.branchName : '—';
  if (l.monthlyRate != null && !val('lwQuoteGross')) { document.getElementById('lwQuoteGross').value = l.monthlyRate; document.getElementById('lwQuoteGross').dispatchEvent(new Event('input')); }
  document.getElementById('lwQuoteLeadResults').classList.remove('open');
  document.getElementById('lwQuoteLeadResults').dataset.name = leadDisplayName(l);
  quoteBuilderWa.leadId = id;
  quoteBuilderWa.mobile = l.mobile || '';
  quoteBuilderWa.checked = true;
  paintQuoteBuilderWa();
  loadQuoteUnits(l);
}

function quoteDraft() {
  const gross = Number(val('lwQuoteGross')) || 0;
  const promo = Number(val('lwQuotePromo')) || 0;
  return {
    leadId: val('lwQuoteLead'), enquiry: val('lwQuoteEnquiry'), unit: val('lwQuoteUnit'), facility: val('lwQbFacility'),
    leadName: (document.getElementById('lwQuoteLeadSearch')?.value || document.querySelector('#v29Body input[readonly]')?.value || '').split(' · ').slice(1).join(' · '),
    gross, promo, promoCode: quotePromoList().some((o) => o.code === quotePromo.code && o.valid) ? quotePromo.code : '', net: Math.round(gross * (1 - promo / 100) * 100) / 100, protection: Number(val('lwQuoteProtection')) || 0,
    commitment: Number(val('lwQuoteCommitment')), expiry: val('lwQuoteExpiry'),
  };
}

// Share-via-WhatsApp for the live Create builder: reads the unsaved draft via
// quoteDraft(), enriches it with the freshest lead row (GET /leads/:id carries
// the mobile — the builder form has no mobile field), and opens wa.me with the
// shared message builder. Pre-issue there is no quoteNo, so shareQuoteViaWhatsApp
// (which guards on quoteNo) is not used — this mirrors shareQuoteForm in
// opsQueuesView.js and passes quoteNo: null, which buildQuoteWaMessage renders
// as "Your quotation … is ready".
async function shareQuoteBuilderForm(btn) {
  const d = quoteDraft();
  if (!d.leadId) { notify('Search and select a lead before sharing.'); return; }
  await busy(btn, async () => {
    let lead = null;
    try { lead = await get('/leads/' + encodeURIComponent(d.leadId)); } catch { lead = null; }
    if (lead) {
      quoteBuilderWa.leadId = d.leadId;
      quoteBuilderWa.mobile = lead.mobile || '';
      quoteBuilderWa.checked = true;
    }
    paintQuoteBuilderWa();
    const mobile = (lead && lead.mobile) || quoteBuilderWa.mobile || '';
    if (!normalizeWaDigits(mobile)) { notify('Add customer mobile to share via WhatsApp.'); return; }
    const name = (d.leadName || (lead && leadDisplayName(lead)) || '').trim() || 'there';
    // buildQuoteWaMessage speaks monthlyRate/totalDueToday; the builder carries
    // gross/net/promoPct/protection — map net → monthlyRate and net + protection
    // (the paper's estimated monthly payment) → totalDueToday.
    const monthlyRate = d.net;
    const totalDueToday = Math.round((d.net + d.protection) * 100) / 100;
    const branch = (d.facility || '').replace(/^StoreLah\s+/, '');
    window.open(`https://wa.me/${normalizeWaDigits(mobile)}?text=${encodeURIComponent(buildQuoteWaMessage({
      quoteNo: null, name, mobile,
      unitCode: d.unit || null,
      branch: branch === '—' ? '' : branch,
      monthlyRate, totalDueToday,
      moveInDate: (lead && lead.moveInDate) || null,
    }))}`, '_blank', 'noopener');
  });
  // busy() re-enables the button in its finally — restore the painted state.
  paintQuoteBuilderWa();
}

function quotePaper(d, number) {
  const total = d.net + d.protection;
  return `<div class="v29-quote-paper"><header><div><h3>STORELAH</h3><span>AC SELF-STORAGE · SPACE MADE SIMPLE</span></div><div><b>QUOTATION</b><small>${esc(number)}</small></div></header><div class="v29-grid"><div><small>PREPARED FOR</small><h3>${esc(d.leadName)}</h3><span>${esc(d.enquiry)}</span></div><div><small>STORAGE OPTION</small><h3>${esc(d.facility || 'StoreLah')}</h3><span>${esc(d.unit || 'Size recommendation only')}</span></div></div><table><tr><th>Description</th><th>Monthly</th></tr><tr><td>Gross monthly rent</td><td>${money(d.gross)}</td></tr><tr><td>${d.promoCode ? 'Promotion ' + esc(d.promoCode) : 'Promotion / negotiated reduction'}</td><td>−${money(d.gross - d.net)}</td></tr><tr><td>Net monthly rent</td><td>${money(d.net)}</td></tr><tr><td>Protection Plan</td><td>${money(d.protection)}</td></tr><tr class="total"><td>Estimated monthly payment</td><td>${money(total)}</td></tr></table><p><b>Commercial terms:</b> ${esc(d.commitment)} months commitment, billed monthly. Security deposit: $0 under the current launch policy. Valid until ${esc(humanDate(d.expiry))}.</p></div>`;
}

function previewDraft() {
  const d = quoteDraft();
  if (!d.leadId) { notify('Search and select a lead before previewing.'); return; }
  openModal({
    title: 'Quotation preview · Assigned on save', kicker: d.enquiry, wide: true, body: quotePaper(d, 'Assigned on save'),
    footer: '<button class="btn" data-lw="close">Close</button><button class="primary" data-lw="quote-preview-confirm">Create &amp; send with next serial number</button>',
  });
  ensureOverlay().dataset.quoteDraft = JSON.stringify(d);
}

async function createQuote(btn, draft) {
  const d = draft || quoteDraft();
  if (!d.leadId) { notify('Select a lead.'); return; }
  if (!(d.gross > 0)) { notify('Enter the gross monthly rent.'); return; }
  await busy(btn, async () => {
    const q = await post('/quotations', {
      leadId: d.leadId, unitCode: d.unit || null, grossRate: d.gross, promoPct: d.promo || null, promoCode: d.promoCode || null,
      protectionMonthly: d.protection, commitmentMonths: d.commitment, expiresAt: d.expiry || null,
    });
    closeModal();
    goPage('quotes');
    notify(`${q.quoteNo} serialised, sent and added to the quotation register.`);
  });
}

function registerRow(id) { return quoteState.data?.rows.find((r) => r.id === id); }

async function previewIssued(id) {
  const x = registerRow(id);
  if (!x) return;
  const d = { leadName: x.leadName, enquiry: `${x.leadDisplayId} · ${x.enquiry}`, facility: x.facility ? 'StoreLah ' + x.facility : 'StoreLah', unit: x.unit, gross: x.gross || 0, net: x.net || 0, protection: x.protection || 0, commitment: x.commitmentMonths || '—', expiry: x.expiresAt };
  openModal({
    title: `Quotation preview · ${x.number}`, kicker: `${x.leadDisplayId} · ${x.enquiry}`, wide: true, body: quotePaper(d, x.number),
    footer: `<button class="btn" data-lw="close">Close</button>${x.hasPdf ? `<button class="btn" data-lw="quote-pdf" data-id="${esc(x.id)}">Export PDF</button>` : ''}${x.status === 'VOIDED' ? '' : `<button class="primary" data-lw="quote-send" data-id="${esc(x.id)}">${x.status === 'DRAFT' ? 'Send' : 'Send / resend'}</button>`}`,
  });
}

function quoteSendDialog(id) {
  const x = registerRow(id);
  if (!x) return;
  if (x.status === 'DRAFT') {
    openModal({ title: `Send draft · ${x.number}`, kicker: 'ASSIGNS THE NEXT SERIAL NUMBER', body: '<div class="v29-callout"><i>i</i><div><b>Sending issues a numbered quotation</b>The draft is replaced by the next QT number, a PDF is generated and the customer copy is emailed.</div></div>', footer: `<button class="btn" data-lw="close">Cancel</button><button class="primary" data-lw="quote-send-draft" data-id="${esc(id)}">Send quotation</button>` });
    return;
  }
  openModal({ title: `Send / resend · ${x.number}`, kicker: 'CHANNEL DELIVERY', body: '<div class="v2-check-row"><label><input type="checkbox" id="lwSendEmail" checked> Email</label><label><input type="checkbox" id="lwSendWa"> WhatsApp</label></div>', footer: `<button class="btn" data-lw="close">Cancel</button><button class="primary" data-lw="quote-resend" data-id="${esc(id)}">Queue delivery</button>` });
}

async function quoteMore(id) {
  const x = registerRow(id);
  if (!x) return;
  openModal({
    title: `Quotation actions · ${x.number}`, kicker: `${(QUOTE_STATUS_LABEL[x.status] || x.status).toUpperCase()} · CLEAR ACTIONS`,
    body: `<div class="v29-callout"><i>i</i><div><b>What the actions mean</b>Preview opens the customer copy. Send/resend opens channel delivery. Duplicate creates a new draft and number only when saved. Void preserves the issued record. Delete is restricted to Administrators and draft records.</div></div><div class="v29-actions"><button class="btn" data-lw="quote-preview" data-id="${esc(id)}">Preview customer copy</button>${can('quotes:create') ? `<button class="btn" data-lw="quote-duplicate" data-id="${esc(id)}">Duplicate as draft</button>` : ''}${can('quotes:update') && !['DRAFT', 'VOIDED'].includes(x.status) ? `<button class="btn" data-lw="quote-void" data-id="${esc(id)}">Void quote</button>` : ''}${can('quotes:delete') ? `<button class="btn" data-lw="quote-delete" data-id="${esc(id)}">Delete draft · Admin only</button>` : ''}</div>${x.voidReason ? `<p class="v29-help">Voided: ${esc(x.voidReason)}</p>` : ''}`,
    footer: '<button class="primary" data-lw="close">Done</button>',
  });
}

function quoteVoidDialog(id) {
  const x = registerRow(id);
  openModal({ title: `Void ${x.number}`, kicker: 'THE SERIALISED RECORD REMAINS IN HISTORY', body: '<label class="v29-field full"><span>Reason *</span><textarea id="lwVoidReason" placeholder="Why is this quotation no longer valid?"></textarea></label>', footer: `<button class="btn" data-lw="close">Cancel</button><button class="primary" data-lw="quote-void-confirm" data-id="${esc(id)}">Void quote</button>` });
}

// ---------------------------------------------------------------------------
// Global Settings › Lead & response SLA
// ---------------------------------------------------------------------------
const SLA_LABEL = (m) => (m >= 60 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`);

function installSlaPanel() {
  const tabs = document.querySelector('[data-tabs="settings"]');
  const settings = document.getElementById('settings');
  if (!tabs || !settings || document.getElementById('settings-lead-sla')) return;
  tabs.firstElementChild.insertAdjacentHTML('afterend', '<button data-tab="settings-lead-sla">Lead &amp; response SLA</button>');
  const anchor = settings.querySelector('.module-panel:last-of-type') || settings.lastElementChild;
  anchor.insertAdjacentHTML('afterend', '<div class="module-panel" id="settings-lead-sla"><div class="section-empty">Loading…</div></div>');
  tabs.querySelector('[data-tab="settings-lead-sla"]').addEventListener('click', () => renderSlaPanel());
}

export async function renderSlaPanel() {
  const panel = document.getElementById('settings-lead-sla');
  if (!panel) return;
  let s;
  try { s = await get('/settings/lead-sla'); } catch (err) { panel.innerHTML = `<div class="section-empty" role="alert">Couldn’t load SLA settings: ${esc(describeError(err))}</div>`; return; }
  const edit = can('settings-lead-sla:update');
  const card = (key, title, sub) => `<div class="v29-sla-card"><b>${title}</b><small>${sub}</small><select data-sla="${key}" ${edit ? '' : 'disabled'} aria-label="${title} target">${s.options[key].map((m) => option(m, SLA_LABEL(m), s.targets[key])).join('')}</select></div>`;
  panel.innerHTML = `<div class="head"><div><h2>Lead response SLA</h2><p>Defines how first response is measured, paused and escalated across enquiry channels.</p></div>${edit ? '<button class="primary" data-lw="sla-save">Save SLA settings</button>' : ''}</div><input type="hidden" id="lwSlaVersion" value="${s.version}"><div class="v29-callout"><i>i</i><div><b>First response definition</b>The clock starts when a new enquiry is created and stops at the first meaningful human response. Automated acknowledgements do not stop it. Business-hours, public holidays, channel rules and assignment delays are configurable here.</div></div><div class="v29-sla-grid">${card('website', 'Website', 'Form and web chat')}${card('whatsapp', 'WhatsApp', 'Inbound message')}${card('phone', 'Phone / missed call', 'Callback target')}${card('email', 'Email', 'Inbound email')}</div><div class="v29-customer-grid" style="margin-top:14px"><div class="v29-customer-card"><header><div><h3>Clock rules</h3><p>When the SLA is active</p></div></header><div class="body"><label class="checkline"><input type="checkbox" id="lwSlaBiz" ${s.businessHoursOnly ? 'checked' : ''} ${edit ? '' : 'disabled'}><span>Count only configured business hours</span></label><label class="checkline"><input type="checkbox" id="lwSlaHol" ${s.pauseOnPublicHolidays ? 'checked' : ''} ${edit ? '' : 'disabled'}><span>Pause on Singapore public holidays</span></label><label class="checkline"><input type="checkbox" id="lwSlaWa" ${s.whatsapp247 ? 'checked' : ''} ${edit ? '' : 'disabled'}><span>Run 24/7 for WhatsApp</span></label></div></div><div class="v29-customer-card"><header><div><h3>Escalation</h3><p>What happens before and after breach</p></div></header><div class="body"><label class="v29-field"><span>Warning</span><select id="lwSlaWarn" ${edit ? '' : 'disabled'}>${option(80, 'At 80% of target', s.warningPct)}${option(50, 'At 50% of target', s.warningPct)}</select></label><label class="v29-field" style="margin-top:10px"><span>Escalate breach to</span><select id="lwSlaEsc" ${edit ? '' : 'disabled'}>${option('both', 'Sales Manager + assigned salesperson', s.escalateTo.length > 1 ? 'both' : 'mgr')}${option('mgr', 'Sales Manager only', s.escalateTo.length > 1 ? 'both' : 'mgr')}</select></label></div></div></div>${s.version ? `<p class="v29-help" style="margin-top:12px">Version ${s.version} · saved ${esc(new Date(s.savedAt).toLocaleString('en-SG'))} by ${esc(s.savedBy || '—')}</p>` : ''}`;
}

async function saveSla(btn) {
  const panel = document.getElementById('settings-lead-sla');
  const target = (k) => Number(panel.querySelector(`[data-sla="${k}"]`).value);
  await busy(btn, async () => {
    const saved = await put('/settings/lead-sla', {
      version: Number(val('lwSlaVersion')),
      targets: { website: target('website'), whatsapp: target('whatsapp'), phone: target('phone'), email: target('email') },
      businessHoursOnly: document.getElementById('lwSlaBiz').checked, pauseOnPublicHolidays: document.getElementById('lwSlaHol').checked,
      whatsapp247: document.getElementById('lwSlaWa').checked, warningPct: Number(val('lwSlaWarn')),
      escalateTo: val('lwSlaEsc') === 'both' ? ['Sales Manager', 'Assigned salesperson'] : ['Sales Manager'],
    });
    notify(`First-response SLA settings saved and audited (version ${saved.version}).`);
    renderSlaPanel();
  });
}

// ---------------------------------------------------------------------------
// One delegated click handler for every [data-lw] action.
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-lw-tab]');
  if (tab) {
    const page = tab.closest('.page');
    page.querySelectorAll('[data-lw-tab]').forEach((b) => b.classList.toggle('active', b === tab));
    page.querySelectorAll('[data-lw-panel]').forEach((p) => p.classList.toggle('active', p.dataset.lwPanel === tab.dataset.lwTab));
    return;
  }
  const el = e.target.closest('[data-lw]');
  if (!el) return;
  const a = el.dataset.lw;
  const id = el.dataset.id;
  const H = {
    close: closeModal,
    'lead-new': openLeadForm,
    'identity-check': () => identityCheck(),
    'lead-save': () => saveLead(el),
    'lead-back': () => goPage('leads'),
    'lead-delete': async () => {
      const ok = await confirmDialog({ title: `Delete lead ${el.dataset.name || ''}?`, message: 'This removes this enquiry and its conversation threads. Appointments keep their slot but lose the lead link. Other enquiries under the same identity are kept.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      await del('/leads/' + encodeURIComponent(el.dataset.lead));
      notify('Lead deleted.');
      goPage('leads');
    },
    'open-lead': () => { closeModal(); openLeadPage(id); },
    'enquiry-new': () => openEnquiryForm(el.dataset.lead),
    'enquiry-save': () => saveEnquiry(el),
    requirement: openRequirement,
    'requirement-save': () => saveRequirement(el),
    'note-save': () => saveNote(el, el.dataset.entity, id, el.dataset.entity === 'lead' ? 'lwNoteBody' : 'lwCustNoteBody', el.dataset.entity === 'lead' ? 'lwNotes' : 'lwCustNotes'),
    notifications: () => openNotifications(),
    'pipeline-settings': () => openPipelineSettings(),
    'pipeline-save': () => savePipelineSettings(el),
    'open-sla': () => { closeModal(); goPage('settings'); document.querySelector('[data-tabs="settings"] [data-tab="settings-lead-sla"]')?.click(); },
    'sla-save': () => saveSla(el),
    'appointment-new': () => openAppointmentForm(el.dataset.lead),
    'appointment-save': () => saveAppointment(el),
    'appointment-open': () => appointmentDetail(id),
    'appointment-status': () => busy(el, async () => { await patch('/appointments/' + encodeURIComponent(id), { status: val('lwApptNewStatus') }); closeModal(); notify('Appointment outcome recorded.'); renderAppointments(); }),
    'calendar-view': () => { cal.view = el.dataset.view; renderAppointments(); },
    'calendar-apply-custom': () => { const s = val('lwCalStart'); const en = val('lwCalEnd'); if (!s || !en) { notify('Choose both the start and end date.'); return; } if (en < s) { notify('The end date must be on or after the start date.'); return; } cal.start = s; cal.end = en; renderAppointments(); },
    'calendar-sync': () => notify('Calendar sync with Google or Microsoft calendars is not connected yet.'),
    'quote-new': () => openQuoteBuilder(el.dataset.lead),
    'quote-lead-select': () => selectQuoteLead(id),
    'quote-builder-preview': previewDraft,
    'quote-builder-wa': () => shareQuoteBuilderForm(el),
    'quote-create': () => createQuote(el),
    'quote-preview-confirm': () => createQuote(el, JSON.parse(ensureOverlay().dataset.quoteDraft || '{}')),
    'quote-preview': () => previewIssued(id),
    'quote-send': () => quoteSendDialog(id),
    'quote-send-draft': () => busy(el, async () => { const q = await post(`/quotations/${encodeURIComponent(id)}/send`, {}); closeModal(); notify(`${q.quoteNo} serialised, sent and added to the quotation register.`); renderQuotes(); }),
    'quote-resend': () => busy(el, async () => { const ch = [document.getElementById('lwSendEmail')?.checked && 'Email', document.getElementById('lwSendWa')?.checked && 'WhatsApp'].filter(Boolean); if (!ch.length) { notify('Choose email and/or WhatsApp.'); return; } const q = await post(`/quotations/${encodeURIComponent(id)}/resend`, { channels: ch }); closeModal(); notify(`${q.number} delivery queued by ${ch.join(' / ').toLowerCase()} and logged.`); renderQuotes(); }),
    'quote-more': () => quoteMore(id),
    'quote-duplicate': () => busy(el, async () => { await post(`/quotations/${encodeURIComponent(id)}/duplicate`, {}); closeModal(); notify('Draft created. A number is assigned when it is sent.'); renderQuotes(); }),
    'quote-void': () => quoteVoidDialog(id),
    'quote-void-confirm': () => busy(el, async () => { const reason = val('lwVoidReason').trim(); if (!reason) { notify('A reason is required to void a quotation.'); return; } const q = await post(`/quotations/${encodeURIComponent(id)}/void`, { reason }); closeModal(); notify(`${q.number} marked void; the serialised record remains in history.`); renderQuotes(); }),
    'quote-delete': () => busy(el, async () => { const x = registerRow(id); if (!can('quotes:delete')) { notify('Only Administrators may delete draft quotes.'); return; } if (x?.status !== 'DRAFT') { notify('Issued, sent or accepted quotations cannot be deleted. Void them to retain the audit trail.'); return; } await del(`/quotations/${encodeURIComponent(id)}`); closeModal(); notify(`${x.number} draft deleted by Administrator.`); renderQuotes(); }),
    'quote-pdf': () => { const x = registerRow(id); downloadFile(`/quotations/${encodeURIComponent(id)}/pdf`, `StoreLah-quotation-${x?.number || 'quote'}.pdf`).catch((err) => notify(describeError(err))); },
    'quote-export': () => exportRegister(),
  };
  if (H[a]) { e.preventDefault(); Promise.resolve(H[a]()).catch((err) => notify(describeError(err))); }
});

function exportRegister() {
  const rows = quoteState.data?.rows || [];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [['Quotation', 'Lead', 'Lead ID', 'Unit', 'Gross', 'Promotion %', 'Net', 'Protection', 'Created', 'Expiry', 'Delivery', 'Status', 'Owner'].map(cell).join(',')]
    .concat(rows.map((r) => [r.number, r.leadName, r.leadDisplayId, r.unit, r.gross, r.promotionPct, r.net, r.protection, String(r.createdAt).slice(0, 10), String(r.expiresAt || '').slice(0, 10), r.delivery, QUOTE_STATUS_LABEL[r.status] || r.status, r.owner].map(cell).join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `StoreLah_Quotations_${sgYmd()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  notify('Quotation register CSV downloaded.');
}

// Install once at module load (the dashboard markup is already parsed).
installMentionMenu();
installSlaPanel();
refreshNotificationBadge();
setInterval(refreshNotificationBadge, 60_000);

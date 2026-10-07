// StoreLah CMS admin UI — tenants view: table, filters/paging, create/edit/
// deactivate modal with server field-error mapping.
// Extracted from admin.js (phase-3 layering refactor; nodebestpractices #1).
// Owns its private form `mode` ('create' | 'edit'); the entry registers the
// cross-cutting refresh via setRefreshAll() because views must never import
// the entry module.

import { TENANT_STATUS_TONE, TENANT_STATUS_LABEL, BOOKING_TONE, INVOICE_TONE, HIST_STAGE_TONE, fmtMoney, fmtDay } from './constants.js';
import { $, $$, escapeHtml, showBanner } from './dom.js';
import { createDateFilter, withDateQuery, isRangeActive, rangeLabel, rangeEmptyText } from './dateFilter.js';
import { confirmDialog } from './confirmDialog.js';
import { ApiError, request, get, patch, describeError } from './api.js';
import { state, isAllFacilities } from './state.js';

// Post-mutation full-refresh hook — the entry hands its refreshAll() down here
// (dependency inversion keeps imports one-way: views → state/api/dom/constants).
let refreshAll = null;
export function setRefreshAll(fn) {
  refreshAll = fn;
}

// GET /tenants rows are flat: { id, name, type, segment, unit, size, sqft, rate, psf, since, nextPayment, status, ...,
// latestVerification { id, status, reviewStatus, idType, verifiedAt, bookingRef } | null }.
function normalizeTenant(t) {
  const lv = t.latestVerification || null;
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    segment: t.segment,
    email: t.email,
    mobile: t.mobile,
    unit: t.unit, // unitCode or null
    size: t.size,
    sqft: t.sqft,
    branchCode: t.branchCode, // facility attribution for the sidebar filter
    branchName: t.branchName,
    rate: t.rate,
    psf: t.psf,
    since: t.since,
    nextPayment: t.nextPayment,
    status: String(t.status || 'ACTIVE'),
    autoDebit: !!t.autoDebit,
    // Latest mock ID-verification (null when none). reviewStatus defaults to
    // PENDING_VALIDATION for every mock row until staff VALIDATEs/REJECTs it.
    latestVerification: lv
      ? {
        id: lv.id || null,
        status: String(lv.status || ''),
        reviewStatus: String(lv.reviewStatus || 'PENDING_VALIDATION'),
        idType: lv.idType || null,
        verifiedAt: lv.verifiedAt || null,
        bookingRef: lv.bookingRef || null,
      }
      : null,
  };
}

// ---------- tenants view (sidebar, mirrors Units) ----------
// Mock ID-verification pills for a tenant row: provider result (VERIFIED /
// FAILED, as recorded by the mock) plus the staff-validation flag. Every
// mock row reads PENDING_VALIDATION until an operator VALIDATEs/REJECTs it,
// so staff always sees the "Pending validation" pill on unreviewed rows.
function verificationPills(lv) {
  if (!lv) return '';
  const vtone = lv.status === 'VERIFIED' ? 'occ' : lv.status === 'FAILED' ? 'over' : 'neutral';
  const vlabel = lv.status === 'VERIFIED' ? 'Verified' : lv.status === 'FAILED' ? 'Failed' : lv.status || '—';
  const tip = ['Mock ID check', lv.idType, lv.bookingRef].filter(Boolean).join(' · ');
  let html = `<span class="badge ${vtone}" title="${escapeHtml(tip)}">${escapeHtml(vlabel)}</span>`;
  const rs = String(lv.reviewStatus || 'PENDING_VALIDATION');
  if (rs === 'PENDING_VALIDATION') html += ' <span class="badge amber">Pending validation</span>';
  else if (rs === 'VALIDATED') html += ' <span class="badge occ">Validated</span>';
  else if (rs === 'REJECTED') html += ' <span class="badge over">Rejected</span>';
  return html;
}

function renderTenantRow(t) {
  const size = t.size ? escapeHtml(t.size) + (t.sqft ? ` · ${t.sqft} sqft` : '') : '—';
  const since = t.since ? new Date(t.since).toLocaleString('en-SG', { month: 'short', year: 'numeric' }) : '—';
  const next = t.nextPayment ? new Date(t.nextPayment).toLocaleDateString('en-SG', { day: '2-digit', month: 'short' }) : '—';
  const rate = t.rate != null ? fmtMoney(t.rate) : '—';
  const psf = t.psf != null ? '$' + Number(t.psf).toFixed(2) + '/sf' : '—';
  const tone = TENANT_STATUS_TONE[t.status] || 'neutral';
  const label = TENANT_STATUS_LABEL[t.status] || t.status;
  const typeLbl = t.type === 'BUSINESS' ? 'Business' : 'Personal';
  const verif = verificationPills(t.latestVerification);
  return `<tr data-tid="${escapeHtml(t.id)}">
    <td><div class="t-name">${escapeHtml(t.name)}</div></td>
    <td><div class="t-type">${typeLbl}${t.segment ? ' · ' + escapeHtml(t.segment) : ''}</div></td>
    <td><strong>${escapeHtml(t.unit || '—')}</strong></td>
    <td>${size}</td>
    <td><strong>${rate}</strong><div class="t-type">${psf}</div></td>
    <td><span class="badge ${tone}">${label}</span>${verif ? `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;">${verif}</div>` : ''}</td>
    <td>${next}</td>
    <td class="unit-actions">
      <button class="act-btn" data-act="view" data-tid="${escapeHtml(t.id)}">View</button>
      <button class="act-btn" data-act="edit" data-tid="${escapeHtml(t.id)}">Edit</button>
      <button class="act-btn danger" data-act="deactivate" data-tid="${escapeHtml(t.id)}" ${t.status === 'INACTIVE' ? 'disabled' : ''}>Deactivate</button>
    </td>
  </tr>`;
}

function applyTenantFilter(rows) {
  const q = (state.tenantQuery || '').toLowerCase().trim();
  const st = state.tenantStatusFilter;
  return (rows || []).filter((t) => {
    // Facility filter: under a specific facility keep only its tenants
    // (null branchCode = belongs to no facility → hidden when scoped).
    if (!isAllFacilities() && t.branchCode !== state.branchCode) return false;
    if (st && t.status !== st) return false;
    if (!q) return true;
    const lv = t.latestVerification;
    const hay = [t.name, t.segment, t.unit, t.size, t.status, TENANT_STATUS_LABEL[t.status], t.branchName,
      lv ? lv.status : null, lv ? lv.reviewStatus : null, lv ? lv.idType : null, lv ? lv.bookingRef : null,
      // Staff search words: "pending" finds every unreviewed mock row.
      lv ? 'verification id check' : null,
      lv && String(lv.reviewStatus || 'PENDING_VALIDATION') === 'PENDING_VALIDATION' ? 'pending validation' : null,
      lv && String(lv.reviewStatus || '') === 'VALIDATED' ? 'validated' : null,
      lv && String(lv.reviewStatus || '') === 'REJECTED' ? 'rejected' : null]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

export function bindTenantsView() {
  const tbody = $('#tenantsViewBody');
  if (!tbody) return;
  const filtered = applyTenantFilter(state.tenants);
  state.tenantTotal = filtered.length;
  state.tenantTotalPages = Math.max(1, Math.ceil(filtered.length / state.tenantPerPage));
  if (state.tenantPage > state.tenantTotalPages) state.tenantPage = state.tenantTotalPages;
  const start = (state.tenantPage - 1) * state.tenantPerPage;
  const rows = filtered.slice(start, start + state.tenantPerPage);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--light);padding:26px;">${escapeHtml(
      isRangeActive(state.tenantDate)
        ? rangeEmptyText('tenants', state.tenantDate)
        : state.tenants.length
          ? 'No tenants match — adjust your search or filters.'
          : 'No tenants yet — create your first tenant.',
    )}</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(renderTenantRow).join('');
  }
  const sub = $('#tenantsViewSub');
  if (sub) {
    sub.textContent = `${state.tenantTotal} tenant${state.tenantTotal === 1 ? '' : 's'}${filtered.length !== state.tenants.length ? ' · ' + filtered.length + ' shown' : ''}` +
      (isRangeActive(state.tenantDate) ? ' · ' + rangeLabel(state.tenantDate) : '');
  }
  renderTenantPager();
}

function renderTenantPager() {
  const info = $('#tenantsPageInfo');
  const prev = $('#tenantsPagePrev');
  const next = $('#tenantsPageNext');
  if (info) info.textContent = `Page ${state.tenantPage} of ${state.tenantTotalPages} · ${state.tenantTotal} tenants`;
  if (prev) prev.disabled = state.tenantPage <= 1;
  if (next) next.disabled = state.tenantPage >= state.tenantTotalPages;
}

export async function refreshTenantsView() {
  ensureTenantsDateFilter();
  try {
    const rows = await get(withDateQuery('/tenants', state.tenantDate));
    state.tenants = (rows || []).map(normalizeTenant);
    state.tenantPage = 1;
    bindTenantsView();
  } catch (err) {
    showBanner('Tenants: ' + describeError(err));
  }
}

// Date-range control lives in the tenants toolbar; changing the range refetches
// server-side (createdAt) and resets to page 1, composing with search/status.
function ensureTenantsDateFilter() {
  const bar = document.querySelector('#customer-tenants .tbl-toolbar');
  if (!bar || bar.dataset.dateFilterMounted) return;
  bar.dataset.dateFilterMounted = '1';
  const handle = createDateFilter({
    onChange: (r) => {
      state.tenantDate = r;
      state.tenantPage = 1;
      refreshTenantsView();
    },
  });
  // Date-range trigger is the FIRST control in the toolbar (before search + status select).
  bar.prepend(handle.el);
}

// ---------- tenant form (create / edit) ----------
let mode = 'create'; // 'create' | 'edit'
let currentEditTenantId = null;

function clearTenantFieldErrors() {
  $$('#tenantModal .field-err').forEach((el) => (el.textContent = ''));
  $$('#tenantModal .field input.err, #tenantModal .field select.err').forEach((el) => el.classList.remove('err'));
  const a = $('#tenantModalAlert');
  if (a) a.hidden = true;
}

function showTenantFormAlert(msg) {
  const a = $('#tenantModalAlert');
  a.textContent = msg;
  a.hidden = false;
}

// zod fieldErrors keys (payload property names) → tenant form element keys
const TENANT_FIELD_ID = {
  name: 'name',
  type: 'type',
  segment: 'segment',
  email: 'email',
  mobile: 'mobile',
  unitId: 'unit',
  moveInDate: 'moveInDate',
  monthlyRate: 'rate',
  status: 'status',
  autoDebit: 'autoDebit',
};

function renderTenantFieldErrors(err) {
  if (!(err instanceof ApiError) || !err.details || !err.details.fieldErrors) return;
  const fe = err.details.fieldErrors;
  for (const [field, msgs] of Object.entries(fe)) {
    if (!msgs || !msgs.length) continue;
    const key = TENANT_FIELD_ID[field];
    if (!key) continue;
    const errEl = $(`#te-${key}`);
    if (errEl) errEl.textContent = msgs.join('; ');
    const input = $(`#tf-${key}`);
    if (input) input.classList.add('err');
  }
}

function toDateInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

// Assignable units for the dropdown: AVAILABLE list (perPage 200) + the tenant's
// current unit (may be OCCUPIED by them / non-AVAILABLE). Shows unitCode.
async function populateTenantUnitSelect(currentUnitCode) {
  const body = await request('/units?status=AVAILABLE&perPage=200');
  let units = (body.data || []).map((u) => ({
    id: u.id,
    code: u.code || u.unitCode,
    sqft: u.sqft,
    size: u.size && u.size.name,
  }));
  if (currentUnitCode && !units.some((u) => u.code === currentUnitCode)) {
    try {
      const cur = await get(`/units/${encodeURIComponent(currentUnitCode)}`);
      units.unshift({ id: cur.id, code: cur.code, sqft: cur.sqft, size: cur.size });
    } catch (e) {
      /* current unit may be deleted — leave it out */
    }
  }
  state.tenantUnits = units;
  const sel = $('#tf-unit');
  const currentId = units.find((u) => u.code === currentUnitCode)?.id || '';
  sel.innerHTML =
    '<option value="">— No unit —</option>' +
    units
      .map(
        (u) =>
          `<option value="${escapeHtml(u.id)}">${escapeHtml(u.code)}${u.size ? ' · ' + escapeHtml(u.size) + (u.sqft ? ' (' + u.sqft + ' sqft)' : '') : ''}</option>`,
      )
      .join('');
  sel.value = currentId;
}

export async function openCreateTenant() {
  mode = 'create';
  currentEditTenantId = null;
  $('#tenantModalTitle').textContent = 'Add Tenant';
  $('#tenantModalHint').hidden = true;
  const verifSec = $('#tenantVerifSection');
  if (verifSec) verifSec.hidden = true;
  $('#tenantForm').reset();
  $('#tf-type').value = 'PERSONAL';
  $('#tf-status').value = 'ACTIVE';
  $('#tf-autoDebit').value = 'false';
  $('#tf-moveInDate').value = '';
  $('#tenantFormSubmit').textContent = 'Save Tenant';
  clearTenantFieldErrors();
  try {
    await populateTenantUnitSelect(null);
  } catch (err) {
    showTenantFormAlert(describeError(err));
  }
  $('#tenantModal').hidden = false;
}

export async function openEditTenant(id) {
  const t = state.tenants.find((x) => x.id === id);
  if (!t) {
    showBanner('Tenant not found in list.');
    return;
  }
  mode = 'edit';
  currentEditTenantId = id;
  $('#tenantModalTitle').textContent = `Edit Tenant — ${t.name}`;
  $('#tenantModalHint').hidden = false;
  $('#tf-name').value = t.name;
  $('#tf-type').value = t.type || 'PERSONAL';
  $('#tf-segment').value = t.segment || '';
  $('#tf-email').value = t.email || '';
  $('#tf-mobile').value = t.mobile || '';
  $('#tf-rate').value = t.rate != null ? t.rate : '';
  $('#tf-status').value = t.status;
  $('#tf-autoDebit').value = t.autoDebit ? 'true' : 'false';
  $('#tf-moveInDate').value = toDateInputValue(t.since);
  $('#tenantFormSubmit').textContent = 'Save Changes';
  clearTenantFieldErrors();
  renderTenantVerifSection(t, null);
  try {
    await populateTenantUnitSelect(t.unit || null);
  } catch (err) {
    showTenantFormAlert(describeError(err));
  }
  $('#tenantModal').hidden = false;
  // Best-effort enrichment: the full CMS row adds capturedAt + reviewer
  // labels. Guarded on currentEditTenantId so a slow fetch never paints a
  // stale tenant's data into a reopened modal.
  enrichTenantVerifDetail(t).then((detail) => {
    if (detail && currentEditTenantId === id) renderTenantVerifSection(t, detail);
  });
}

export function closeTenantModal() {
  $('#tenantModal').hidden = true;
  currentEditTenantId = null;
  clearTenantFieldErrors();
}

// ---------- tenant identity-verification section (View/Edit modal) ----------
// Shows the row's latestVerification (idType, provider status, verified time,
// review flag) with Validate/Reject buttons that PATCH /verifications/:id.
// The modal stays open and form inputs are untouched — only this section and
// the table row refresh, so there is no reload loss.
function fmtVerifDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-SG', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function clearTenantVerifError() {
  const el = $('#te-verif');
  if (el) el.textContent = '';
}

function renderTenantVerifSection(t, detail) {
  const sec = $('#tenantVerifSection');
  const body = $('#tenantVerifBody');
  const actions = $('#tenantVerifActions');
  if (!sec || !body) return;
  const lv = t.latestVerification;
  clearTenantVerifError();
  if (!lv) {
    sec.hidden = true;
    body.innerHTML = '';
    return;
  }
  sec.hidden = false;
  const rs = String(lv.reviewStatus || 'PENDING_VALIDATION');
  const vtone = lv.status === 'VERIFIED' ? 'occ' : lv.status === 'FAILED' ? 'over' : 'neutral';
  const vlabel = lv.status === 'VERIFIED' ? 'Verified' : lv.status === 'FAILED' ? 'Failed' : (lv.status || '—');
  const reviewLabel = rs === 'PENDING_VALIDATION' ? 'Pending validation' : rs === 'VALIDATED' ? 'Validated' : 'Rejected';
  const reviewTone = rs === 'PENDING_VALIDATION' ? 'amber' : rs === 'VALIDATED' ? 'occ' : 'over';
  const captured = detail && detail.capturedAt ? fmtVerifDate(detail.capturedAt) : null;
  const reviewedBy = (detail && detail.reviewedBy) || null;
  const reviewedAt = detail && detail.reviewedAt ? fmtVerifDate(detail.reviewedAt) : null;
  body.innerHTML =
    `<div><span class="badge ${vtone}">${escapeHtml(vlabel)}</span> <span class="badge ${reviewTone}">${escapeHtml(reviewLabel)}</span></div>` +
    `<div>ID type: <strong>${escapeHtml(lv.idType || '—')}</strong>${lv.bookingRef ? ` · Booking <strong>${escapeHtml(lv.bookingRef)}</strong>` : ''}</div>` +
    `<div>Verified: ${escapeHtml(fmtVerifDate(lv.verifiedAt))}${captured ? ` · Captured: ${escapeHtml(captured)}` : ''}</div>` +
    (reviewedBy || reviewedAt ? `<div>Reviewed by ${escapeHtml(reviewedBy || '—')}${reviewedAt ? ` · ${escapeHtml(reviewedAt)}` : ''}</div>` : '');
  if (actions) actions.style.display = rs === 'PENDING_VALIDATION' ? '' : 'none';
  const okBtn = $('#tenantVerifValidate');
  const noBtn = $('#tenantVerifReject');
  if (okBtn) okBtn.onclick = () => reviewTenantVerification(t.id, 'VALIDATED');
  if (noBtn) noBtn.onclick = () => reviewTenantVerification(t.id, 'REJECTED');
}

// Enrich the row's latestVerification with the full CMS row (capturedAt,
// reviewedBy/At) for the modal. Best-effort: failures keep the row data.
async function enrichTenantVerifDetail(t) {
  const lv = t.latestVerification;
  if (!lv || !lv.id || !lv.bookingRef) return null;
  try {
    const rows = await get(`/verifications?bookingRef=${encodeURIComponent(lv.bookingRef)}&take=50`);
    return (rows || []).find((r) => r.id === lv.id) || null;
  } catch (e) {
    return null;
  }
}

async function reviewTenantVerification(tenantId, reviewStatus) {
  const t = state.tenants.find((x) => x.id === tenantId);
  const lv = t && t.latestVerification;
  if (!lv || !lv.id) return;
  try {
    const updated = await patch(`/verifications/${encodeURIComponent(lv.id)}`, { reviewStatus });
    t.latestVerification = {
      ...lv,
      status: updated.status || lv.status,
      reviewStatus: updated.reviewStatus || reviewStatus,
    };
    renderTenantVerifSection(t, updated);
    bindTenantsView();
    showBanner(`Verification ${reviewStatus === 'VALIDATED' ? 'validated' : 'rejected'} for ${t.name}`, true);
  } catch (err) {
    const el = $('#te-verif');
    if (el) el.textContent = describeError(err);
    else showBanner('Verification review: ' + describeError(err));
  }
}

export async function submitTenantForm(e) {
  e.preventDefault();
  clearTenantFieldErrors();
  const name = $('#tf-name').value.trim();
  const monthlyRate = Number($('#tf-rate').value);
  const body = {
    name,
    type: $('#tf-type').value,
    monthlyRate,
    status: $('#tf-status').value,
    autoDebit: $('#tf-autoDebit').value === 'true',
  };
  const segment = $('#tf-segment').value.trim();
  if (segment) body.segment = segment;
  const email = $('#tf-email').value.trim();
  if (email) body.email = email;
  const mobile = $('#tf-mobile').value.trim();
  if (mobile) body.mobile = mobile;
  const unitId = $('#tf-unit').value;
  if (unitId) body.unitId = unitId;
  else if (mode === 'edit') body.unitId = null; // cleared → release the current unit
  const moveIn = $('#tf-moveInDate').value;
  if (moveIn) body.moveInDate = new Date(moveIn + 'T00:00:00.000Z').toISOString();

  if (!name) {
    const el = $('#te-name');
    if (el) el.textContent = 'Name is required';
    $('#tf-name').classList.add('err');
    return;
  }
  if (!(monthlyRate >= 0)) {
    const el = $('#te-rate');
    if (el) el.textContent = 'Must be 0 or greater';
    $('#tf-rate').classList.add('err');
    return;
  }

  try {
    if (mode === 'create') {
      await request('/tenants', { method: 'POST', body: JSON.stringify(body) });
      showBanner(`Created ${name}`, true);
    } else {
      await request(`/tenants/${encodeURIComponent(currentEditTenantId)}`, { method: 'PUT', body: JSON.stringify(body) });
      showBanner(`Updated ${name}`, true);
    }
    closeTenantModal();
    await refreshAll();
  } catch (err) {
    renderTenantFieldErrors(err);
    if (!(err instanceof ApiError && err.details && err.details.fieldErrors)) {
      showTenantFormAlert(describeError(err));
    }
  }
}

export async function deactivateTenant(id) {
  const t = state.tenants.find((x) => x.id === id);
  if (!t) return;
  const ok = await confirmDialog({
    title: `Deactivate ${t.name}?`,
    message: t.unit ? `Their unit (${t.unit}) is released back to AVAILABLE.` : 'This tenant will be deactivated.',
    confirmLabel: 'Deactivate',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await request(`/tenants/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showBanner(`Deactivated ${t.name}${res.data && res.data.unitReleased ? ` — unit ${t.unit} released` : ''}`, true);
    await refreshAll();
  } catch (err) {
    showBanner('Deactivate: ' + describeError(err));
  }
}

// ---------- tenant stay-history drawer (read-only timeline) ----------
// Tenants-table "View" opens this; "Edit" still opens the form modal. The
// table's search/status/date-range filters are untouched — this drawer only
// reads them indirectly via state.tenants. Timeline is newest-first with
// status pills; every customer string goes through escapeHtml.
let thLastFocus = null;

function thTone(stage) {
  return TENANT_STATUS_TONE[stage] || HIST_STAGE_TONE[stage] || BOOKING_TONE[stage] || INVOICE_TONE[stage] || 'neutral';
}

function thLabel(stage) {
  return TENANT_STATUS_LABEL[stage] || (stage ? String(stage).replace(/_/g, ' ') : '—');
}

function thRowMatches(r, t) {
  const name = String(r.tenant || r.name || '').trim().toLowerCase();
  if (name && name === String(t.name || '').trim().toLowerCase()) return true;
  if (t.email && r.tenantEmail && String(r.tenantEmail).toLowerCase() === String(t.email).toLowerCase()) return true;
  if (t.mobile && r.tenantMobile && String(r.tenantMobile).replace(/\s/g, '') === String(t.mobile).replace(/\s/g, '')) return true;
  return false;
}

function setThState(msg, isErr) {
  const el = $('#thState');
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('err');
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
}

export async function openTenantHistory(id) {
  const t = state.tenants.find((x) => x.id === id);
  if (!t) {
    showBanner('Tenant not found in list.');
    return;
  }
  thLastFocus = document.activeElement;
  const tone = thTone(t.status);
  $('#thTitle').textContent = t.name;
  const sub = $('#thSub');
  if (sub) {
    sub.innerHTML =
      `<span class="badge ${tone}">${escapeHtml(thLabel(t.status))}</span> ` +
      escapeHtml([t.type === 'BUSINESS' ? 'Business' : 'Personal', t.segment, t.email, t.mobile].filter(Boolean).join(' · '));
  }
  const modal = $('#tenantHistoryModal');
  if (!modal) return;
  modal.hidden = false;
  setThState('Loading stay history…', false);
  const tl = $('#thTimeline');
  if (tl) {
    tl.innerHTML = '';
    tl.setAttribute('aria-busy', 'true');
  }
  const empty = $('#thEmpty');
  if (empty) empty.hidden = true;
  $('#tenantHistoryClose')?.focus();
  try {
    const [bookings, moveins] = await Promise.all([get('/bookings'), get('/move-ins')]);
    if (modal.hidden) return; // closed while loading — drop the stale render
    const items = [];
    if (t.unit || t.since) {
      items.push({
        kindLabel: 'Current stay',
        name: t.unit || 'No unit assigned',
        contact: [t.size ? `${t.size}${t.sqft ? ' · ' + t.sqft + ' sqft' : ''}` : '', t.rate != null ? fmtMoney(t.rate) + '/mo' : ''].filter(Boolean).join(' · '),
        stage: t.status || 'ACTIVE',
        moveIn: t.since || null,
        moveOut: null,
        ref: null,
        invoice: null,
        pay: t.nextPayment ? 'Next payment ' + fmtDay(t.nextPayment) : '',
        at: t.since || null,
      });
    }
    for (const [rows, kind] of [[bookings, 'Booking'], [moveins, 'Move-in']]) {
      (rows || []).forEach((r) => {
        if (!thRowMatches(r, t)) return;
        // The current stay already covers the occupant row — a booking for the
        // same unit without a ref adds no linkable history, so skip it.
        if (!r.ref && (r.unit || r.unitCode) === t.unit) return;
        items.push({
          kindLabel: kind,
          name: `${r.ref || kind} · ${r.unit || r.unitCode || '—'}`,
          contact: [r.tenantType, r.tenantEmail, r.tenantMobile].filter(Boolean).join(' · '),
          stage: r.status || (r.invoiceStatus === 'OVERDUE' ? 'OVERDUE' : 'ACTIVE'),
          moveIn: r.moveInDate || null,
          moveOut: r.moveOutDate || r.endDate || null,
          ref: r.ref || null,
          invoice: r.invoiceStatus || null,
          pay: `${fmtMoney(r.paidAmount || 0)} paid${r.amountDue ? ' · ' + fmtMoney(r.amountDue) + ' due' : ''}${r.method ? ' · ' + r.method : ''}`,
          at: r.moveInDate || r.createdAt || null,
        });
      });
    }
    items.sort((a, b) => {
      const ta = a.at ? new Date(a.at).getTime() : -1;
      const tb = b.at ? new Date(b.at).getTime() : -1;
      return tb - ta;
    });
    if (tl) tl.removeAttribute('aria-busy');
    if (!items.length) {
      setThState('', false);
      if (tl) tl.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No stay history yet for this tenant.';
      }
      return;
    }
    setThState('', false);
    if (empty) empty.hidden = true;
    if (sub) {
      const pill = sub.innerHTML;
      sub.innerHTML = pill + ` <span>· ${items.length} stay${items.length === 1 ? '' : 's'} · newest first</span>`;
    }
    if (tl) {
      tl.innerHTML = items.map((it) => {
        const tn = thTone(it.stage);
        return `<li class="ud-titem tone-${tn}"><div class="ud-tcard">` +
          `<div class="ud-tcard-top"><b>${escapeHtml(it.name)}</b><span class="badge ${tn}">${escapeHtml(thLabel(it.stage))}</span></div>` +
          (it.contact ? `<div class="ud-tcard-contact">${escapeHtml(it.contact)}</div>` : '') +
          `<div class="ud-tcard-meta">` +
          (it.moveIn ? `<span>Moved in <b>${escapeHtml(fmtDay(it.moveIn))}</b></span>` : '') +
          (it.moveOut ? `<span>Moved out <b>${escapeHtml(fmtDay(it.moveOut))}</b></span>` : '') +
          (it.pay ? `<span>${escapeHtml(it.pay)}</span>` : '') +
          `</div>` +
          (it.ref || it.invoice
            ? `<div class="ud-tcard-refs">` +
              (it.ref ? `<span class="ud-ref">${escapeHtml(it.kindLabel)} <b>${escapeHtml(it.ref)}</b></span>` : '') +
              (it.invoice ? `<span class="badge ${INVOICE_TONE[it.invoice] || 'res'}">${escapeHtml(it.invoice)}</span>` : '') +
              `</div>`
            : '') +
          `</div></li>`;
      }).join('');
    }
  } catch (err) {
    if (tl) tl.removeAttribute('aria-busy');
    setThState('Couldn’t load stay history — ' + describeError(err), true);
  }
}

export function closeTenantHistory() {
  const modal = $('#tenantHistoryModal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  setThState('', false);
  if (thLastFocus && thLastFocus.focus) thLastFocus.focus();
  thLastFocus = null;
}

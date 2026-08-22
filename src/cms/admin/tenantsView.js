// StoreLah CMS admin UI — tenants view: table, filters/paging, create/edit/
// deactivate modal with server field-error mapping.
// Extracted from admin.js (phase-3 layering refactor; nodebestpractices #1).
// Owns its private form `mode` ('create' | 'edit'); the entry registers the
// cross-cutting refresh via setRefreshAll() because views must never import
// the entry module.

import { TENANT_STATUS_TONE, TENANT_STATUS_LABEL, fmtMoney } from './constants.js';
import { $, $$, escapeHtml, showBanner } from './dom.js';
import { ApiError, request, get, describeError } from './api.js';
import { state, isAllFacilities } from './state.js';

// Post-mutation full-refresh hook — the entry hands its refreshAll() down here
// (dependency inversion keeps imports one-way: views → state/api/dom/constants).
let refreshAll = null;
export function setRefreshAll(fn) {
  refreshAll = fn;
}

// GET /tenants rows are flat: { id, name, type, segment, unit, size, sqft, rate, psf, since, nextPayment, status, ... }.
function normalizeTenant(t) {
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
  };
}

// Legacy dashboard "Tenants" board lister (kept verbatim; still fed by refreshAll).
export function bindTenants(rows) {
  const tbody = $('#tenantsBody');
  if (!tbody) return;
  const statusClass = { ACTIVE: 'occ', DUE_SOON: 'res', OVERDUE: 'over', NOTICE: 'amber' };
  tbody.innerHTML = (rows || [])
    .map((t) => {
      const since = t.since ? new Date(t.since).toLocaleString('en-SG', { month: 'short', year: 'numeric' }) : '—';
      const next = t.nextPayment ? new Date(t.nextPayment).toLocaleDateString('en-SG', { day: '2-digit', month: 'short' }) : '—';
      return `<tr>
        <td><div class="t-name">${t.name}</div><div class="t-type">${(t.type || '').toLowerCase()}${t.segment ? ' · ' + t.segment : ''}</div></td>
        <td><strong>${t.unit || '—'}</strong></td><td>${t.size || '—'}${t.sqft ? ' · ' + t.sqft + ' sqft' : ''}</td>
        <td><strong>${fmtMoney(t.rate)}</strong></td><td><span class="psf-val">$${Number(t.psf).toFixed(2)}</span></td>
        <td>${since}</td><td>${next}</td>
        <td><span class="badge ${statusClass[t.status] || 'occ'}">${String(t.status || '').replace('_', ' ')}</span></td>
        <td><button class="act-btn" style="font-size:10px;padding:3px 8px;">Manage</button></td>
      </tr>`;
    })
    .join('');
}

// ---------- tenants view (sidebar, mirrors Units) ----------
function renderTenantRow(t) {
  const size = t.size ? escapeHtml(t.size) + (t.sqft ? ` · ${t.sqft} sqft` : '') : '—';
  const since = t.since ? new Date(t.since).toLocaleString('en-SG', { month: 'short', year: 'numeric' }) : '—';
  const next = t.nextPayment ? new Date(t.nextPayment).toLocaleDateString('en-SG', { day: '2-digit', month: 'short' }) : '—';
  const rate = t.rate != null ? fmtMoney(t.rate) : '—';
  const psf = t.psf != null ? '$' + Number(t.psf).toFixed(2) + '/sf' : '—';
  const tone = TENANT_STATUS_TONE[t.status] || 'neutral';
  const label = TENANT_STATUS_LABEL[t.status] || t.status;
  const typeLbl = t.type === 'BUSINESS' ? 'Business' : 'Personal';
  return `<tr data-tid="${escapeHtml(t.id)}">
    <td><div class="t-name">${escapeHtml(t.name)}</div></td>
    <td><div class="t-type">${typeLbl}${t.segment ? ' · ' + escapeHtml(t.segment) : ''}</div></td>
    <td><strong>${escapeHtml(t.unit || '—')}</strong></td>
    <td>${size}</td>
    <td><strong>${rate}</strong><div class="t-type">${psf}</div></td>
    <td><span class="badge ${tone}">${label}</span></td>
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
    const hay = [t.name, t.segment, t.unit, t.size, t.status, TENANT_STATUS_LABEL[t.status], t.branchName]
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
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--light);padding:26px;">${
      state.tenants.length ? 'No tenants match — adjust your search or filters.' : 'No tenants yet — create your first tenant.'
    }</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(renderTenantRow).join('');
  }
  const sub = $('#tenantsViewSub');
  if (sub) {
    sub.textContent = `${state.tenantTotal} tenant${state.tenantTotal === 1 ? '' : 's'}${filtered.length !== state.tenants.length ? ' · ' + filtered.length + ' shown' : ''}`;
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
  try {
    const rows = await get('/tenants');
    state.tenants = (rows || []).map(normalizeTenant);
    state.tenantPage = 1;
    bindTenantsView();
  } catch (err) {
    showBanner('Tenants: ' + describeError(err));
  }
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
  try {
    await populateTenantUnitSelect(t.unit || null);
  } catch (err) {
    showTenantFormAlert(describeError(err));
  }
  $('#tenantModal').hidden = false;
}

export function closeTenantModal() {
  $('#tenantModal').hidden = true;
  currentEditTenantId = null;
  clearTenantFieldErrors();
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
  if (!window.confirm(`Deactivate ${t.name}?${t.unit ? ` Their unit (${t.unit}) is released back to AVAILABLE.` : ''}`)) return;
  try {
    const res = await request(`/tenants/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showBanner(`Deactivated ${t.name}${res.data && res.data.unitReleased ? ` — unit ${t.unit} released` : ''}`, true);
    await refreshAll();
  } catch (err) {
    showBanner('Deactivate: ' + describeError(err));
  }
}

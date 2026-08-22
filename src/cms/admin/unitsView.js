// StoreLah CMS admin UI — units view: table + server-side pagination, unit
// detail panel, unit/rate CRUD modals with server field-error mapping.
// Extracted from admin.js (phase-3 layering refactor; nodebestpractices #1).
// Owns its private form `mode`, the selected-unit code and the rate-modal
// target; the entry registers refreshAll()/loadRefs() via the setters below
// because views must never import the entry module.

import { STATUS_TONE, STATUS_LABEL, fmtMoney } from './constants.js';
import { $, $$, escapeHtml, showBanner } from './dom.js';
import { ApiError, request, get, describeError } from './api.js';
import { state, isAllFacilities } from './state.js';

// Post-mutation full-refresh hook — the entry hands its refreshAll() down here
// (dependency inversion keeps imports one-way: views → state/api/dom/constants).
let refreshAll = null;
export function setRefreshAll(fn) {
  refreshAll = fn;
}

// Ref-data retry hook — the entry hands its loadRefs() down here so the lazy
// guard in the form openers keeps working without importing the entry.
let loadRefs = null;
export function setRefsLoader(fn) {
  loadRefs = fn;
}

// ---------- unit/rate form state (create vs edit) ----------
let mode = 'create'; // 'create' | 'edit'
let currentEditCode = null;
let rateTargetCode = null;

// ---------- normalization (list vs detail collapse) ----------
// GET /units returns: status UPPERCASE, size/branch/floor as nested objects.
// GET /units/:code returns: status lowercase, size/branch flattened strings + level.
function normalizeUnit(u) {
  const listLike = u.size && typeof u.size === 'object' && !Array.isArray(u.size);
  const status = String(u.status || '').toUpperCase();
  const tenant = u.tenant
    ? typeof u.tenant === 'object'
      ? u.tenant
      : { name: u.tenant }
    : null;
  return {
    id: u.id,
    code: u.code || u.unitCode,
    name: u.name ?? (u.code || u.unitCode),
    sqft: u.sqft,
    rate: u.rate,
    psf: u.psf,
    status,
    sizeName: listLike ? u.size.name : u.size,
    sizeCode: listLike ? u.size.code : u.sizeCode,
    branchId: u.branchId,
    floorId: u.floorId,
    sizeId: u.sizeId,
    branchCode: listLike ? u.branch?.code : u.branchCode,
    branchName: listLike ? u.branch?.name : u.branch,
    level: listLike ? u.floor?.level : u.level,
    climateControl: u.climateControl,
    tenant,
    rateHistory: u.rateHistory || [],
  };
}

// ---------- units table ----------
function renderUnitsTable() {
  const tbody = $('#unitsTable tbody');
  if (!tbody) return;
  tbody.innerHTML = state.units
    .map((u) => {
      const blocked = u.status === 'INACTIVE';
      const guarded = u.status === 'OCCUPIED' || u.status === 'OVERDUE';
      return `<tr data-code="${u.code}" class="${blocked ? 'row-blocked' : ''}">
        <td><strong>${u.code}</strong></td>
        <td>${escapeHtml(u.name)}</td>
        <td>${u.sizeName || '—'}${u.sizeCode ? `<div class="t-type">${u.sizeCode}</div>` : ''}</td>
        <td>${u.branchCode || '—'}</td>
        <td>${u.level ? 'Level ' + u.level : '—'}</td>
        <td>${u.sqft != null ? u.sqft : '—'}</td>
        <td>${u.rate != null ? fmtMoney(u.rate) : '—'}</td>
        <td><span class="psf-val">${u.psf != null ? '$' + Number(u.psf).toFixed(2) : '—'}</span></td>
        <td><span class="badge ${STATUS_TONE[u.status] || 'neutral'}">${STATUS_LABEL[u.status] || u.status}</span></td>
        <td>${u.tenant && u.tenant.name ? u.tenant.name : '—'}</td>
        <td class="unit-actions">
          <button class="act-btn" data-act="view" data-code="${u.code}">View</button>
          <button class="act-btn" data-act="edit" data-code="${u.code}">Edit</button>
          <button class="act-btn primary" data-act="rate" data-code="${u.code}">Rate</button>
          <button class="act-btn danger" data-act="delete" data-code="${u.code}" ${guarded ? 'title="Occupied/overdue units cannot be deactivated"' : ''}>Delete</button>
        </td>
      </tr>`;
    })
    .join('');
  const sub = $('#unitsSub');
  if (sub) {
    const start = state.total === 0 ? 0 : (state.page - 1) * state.perPage + 1;
    const end = Math.min(state.page * state.perPage, state.total);
    sub.textContent = `${state.total} unit${state.total === 1 ? '' : 's'} · showing ${start}–${end}`;
  }
}

// ---------- server-side pagination ----------
export async function fetchUnitsPage() {
  const qs = new URLSearchParams({ page: String(state.page), perPage: String(state.perPage) });
  if (state.statusFilter) qs.set('status', state.statusFilter);
  // All Facilities → omit branch/level so the backend returns every unit.
  if (!isAllFacilities()) {
    if (state.branchCode) qs.set('branch', state.branchCode);
    if (state.level) qs.set('level', String(state.level));
  }
  const body = await request(`/units?${qs}`);
  state.units = (body.data || []).map(normalizeUnit);
  const m = body.meta || {};
  state.total = m.total != null ? m.total : state.units.length;
  state.totalPages = m.totalPages != null ? m.totalPages : 1;
  // Last row deleted off the final page -> clamp to the real last page.
  if (state.units.length === 0 && state.page > 1 && state.total > 0 && state.page > state.totalPages) {
    state.page = state.totalPages;
    return fetchUnitsPage();
  }
  renderUnitsTable();
  renderPager();
}

function renderPager() {
  const info = $('#pageInfo');
  const prev = $('#pagePrev');
  const next = $('#pageNext');
  if (info) info.textContent = `Page ${state.page} of ${state.totalPages} · ${state.total} units`;
  if (prev) prev.disabled = state.page <= 1;
  if (next) next.disabled = state.page >= state.totalPages;
}

function setUnitsBanner(msg, tone) {
  const b = $('#unitsBanner');
  if (!b) return;
  if (!msg) {
    b.hidden = true;
    b.textContent = '';
    return;
  }
  b.hidden = false;
  b.textContent = msg;
  b.className = 'modal-alert ' + (tone || '');
}

function bluntRow(code) {
  const row = $(`#unitsTable tr[data-code="${code}"]`);
  if (!row) return;
  row.classList.add('row-blocked');
  const btn = row.querySelector('[data-act="delete"]');
  if (btn) btn.disabled = true;
}

// ---------- detail panel ----------
export async function showUnitDetail(code) {
  try {
    const d = await get(`/units/${encodeURIComponent(code)}`);
    const u = normalizeUnit(d);
    const id = $('#udId');
    if (id) id.textContent = `${u.name}${u.sizeName ? ' · ' + u.sizeName + ' Unit' : ''}`;
    const badges = $('#udBadges');
    if (badges) {
      badges.innerHTML = `
        <span class="badge ${STATUS_TONE[u.status] || 'neutral'}">● ${STATUS_LABEL[u.status] || u.status}</span>
        ${u.name !== u.code ? `<span class="badge neutral">${escapeHtml(u.code)}</span>` : ''}
        ${u.sqft ? `<span class="badge terra">${u.sqft} sq ft</span>` : ''}
        ${u.branchName && u.level ? `<span class="badge neutral">Level ${u.level} · ${u.branchName}</span>` : ''}
        ${u.climateControl ? `<span class="badge neutral">${u.climateControl}</span>` : ''}`;
    }
    const setVal = (sel, v) => {
      const el = $(sel);
      if (el) el.textContent = v ?? '—';
    };
    setVal('#udTenant', u.tenant && u.tenant.name ? u.tenant.name : '—');
    setVal('#udTenantSub', u.tenant ? `${(u.tenant.type || '').toLowerCase()}${u.tenant.segment ? ' · ' + u.tenant.segment : ''}`.trim() : 'No current tenant');
    setVal('#udRate', u.rate != null ? fmtMoney(u.rate) : '—');
    setVal('#udRateSub', u.psf != null ? '$' + Number(u.psf).toFixed(2) + '/sq ft' : '—');
    setVal('#udStatus', STATUS_LABEL[u.status] || u.status);
    setVal('#udStatusSub', u.climateControl || '—');
    setVal('#udBranch', u.branchName || '—');
    setVal('#udLevel', u.level ? 'Level ' + u.level : '—');
    setVal('#udSize', u.sizeName || '—');
    setVal('#udSizeSub', u.sizeCode ? u.sizeCode + (u.sqft ? ' · ' + u.sqft + ' sq ft' : '') : '—');
    setVal('#udPsf', u.psf != null ? '$' + Number(u.psf).toFixed(2) : '—');
    setVal('#udPsfSub', u.sqft ? u.sqft + ' sq ft' : '—');
    setVal('#udRateHistCount', u.rateHistory.length);
    setVal('#udRateHistSub', u.rateHistory.length === 1 ? 'entry' : 'entries');
    const last = u.rateHistory[0];
    setVal('#udLastChange', last ? (last.changePct >= 0 ? '+' : '') + last.changePct + '%' : '—');
    setVal('#udLastChangeSub', last ? new Date(last.date).toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: 'numeric' }) + ' · ' + (last.reason || '') : '—');
    currentEditCode = u.code;
    state.selectedCode = u.code;
    setUnitsBanner('');
  } catch (err) {
    showBanner('Detail: ' + describeError(err));
  }
}

// Read-only accessor for the unit shown in the detail panel; the entry's
// toolbar wiring (edit/rate/delete buttons) decides what to do with it.
export function getSelectedUnitCode() {
  return currentEditCode;
}

// ---------- reference data ----------
function populateBranchSelect(selected) {
  const sel = $('#f-branch');
  sel.innerHTML = state.branches
    .map((b) => `<option value="${b.id}">${b.code} · ${b.name}</option>`)
    .join('');
  if (selected) sel.value = selected;
}

export function populateFloorSelect(branchId, selected) {
  const sel = $('#f-floor');
  const floors = state.floors.filter((f) => f.branchId === branchId);
  sel.innerHTML = floors.map((f) => `<option value="${f.id}">Level ${f.level} (${f.branch.code})</option>`).join('');
  if (selected && floors.some((f) => f.id === selected)) sel.value = selected;
}

function populateSizeSelect(selected) {
  const sel = $('#f-size');
  sel.innerHTML = state.sizes
    .map((s) => `<option value="${s.id}">${s.name} (${s.code}) · ${s.sqftFrom}–${s.sqftTo} sqft</option>`)
    .join('');
  if (selected) sel.value = selected;
}

function populateStatusSelect(mode, selected) {
  const sel = $('#f-status');
  const createOnly = ['AVAILABLE', 'RESERVED', 'MAINTENANCE'];
  const all = ['OCCUPIED', 'AVAILABLE', 'RESERVED', 'OVERDUE', 'MAINTENANCE', 'INACTIVE'];
  const list = mode === 'create' ? createOnly : all;
  sel.innerHTML = list.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join('');
  if (selected && list.includes(selected)) sel.value = selected;
}

// #f-size change handler (bound by the entry): in create mode auto-fill sqft
// from the selected size's sqftFrom.
export function onUnitSizeChange(e) {
  // In create mode, auto-fill sqft from the selected size's sqftFrom.
  if (mode === 'create') {
    const size = state.sizes.find((s) => s.id === e.target.value);
    if (size) $('#f-sqft').value = size.sqftFrom;
  }
}

// ---------- unit form (create / edit) ----------
function clearFieldErrors() {
  $$('.field-err').forEach((el) => (el.textContent = ''));
  $$('.field input.err, .field select.err').forEach((el) => el.classList.remove('err'));
  $('#unitModalAlert').hidden = true;
}

function showFormAlert(msg) {
  const a = $('#unitModalAlert');
  a.textContent = msg;
  a.hidden = false;
}

// zod fieldErrors keys (payload property names) → form element keys
const FIELD_ID = {
  branchId: 'branch',
  floorId: 'floor',
  sizeId: 'size',
  sqft: 'sqft',
  monthlyRate: 'monthlyRate',
  status: 'status',
  climateControl: 'climateControl',
  newRate: 'newRate',
  reason: 'reason',
};

function renderFieldErrors(err) {
  if (!(err instanceof ApiError) || !err.details || !err.details.fieldErrors) return;
  const fe = err.details.fieldErrors;
  for (const [field, msgs] of Object.entries(fe)) {
    if (!msgs || !msgs.length) continue;
    const key = FIELD_ID[field];
    if (!key) continue;
    const errEl = $(`#e-${key}`);
    if (errEl) errEl.textContent = msgs.join('; ');
    const input = $(`#f-${key}`);
    if (input) input.classList.add('err');
  }
}

export async function openCreateForm() {
  if (!state.branches.length || !state.floors.length || !state.sizes.length) await loadRefs();
  mode = 'create';
  currentEditCode = null;
  $('#unitModalTitle').textContent = 'Add Unit';
  $('#unitModalHint').hidden = true;
  populateBranchSelect();
  populateFloorSelect(state.branches[0]?.id);
  populateSizeSelect();
  populateStatusSelect('create');
  $('#f-sqft').value = '';
  $('#f-monthlyRate').value = '';
  $('#f-climateControl').value = 'Ambient climate';
  $('#f-name').value = '';
  $('#unitFormSubmit').textContent = 'Save Unit';
  clearFieldErrors();
  $('#unitModal').hidden = false;
}

export async function openEditForm(code) {
  if (!state.branches.length || !state.floors.length || !state.sizes.length) await loadRefs();
  try {
    const d = await get(`/units/${encodeURIComponent(code)}`);
    const u = normalizeUnit(d);
    mode = 'edit';
    currentEditCode = u.code;
    $('#unitModalTitle').textContent = `Edit Unit — ${u.code}`;
    $('#unitModalHint').hidden = false;
    populateBranchSelect(u.branchId);
    populateFloorSelect(u.branchId, u.floorId);
    populateSizeSelect(u.sizeId);
    populateStatusSelect('edit', u.status);
    $('#f-sqft').value = u.sqft ?? '';
    $('#f-monthlyRate').value = u.rate ?? '';
    $('#f-climateControl').value = u.climateControl ?? '';
    $('#f-name').value = u.name && u.name !== u.code ? u.name : '';
    $('#f-branch').disabled = true;
    $('#f-floor').disabled = true;
    $('#f-size').disabled = true;
    $('#unitFormSubmit').textContent = 'Save Changes';
    clearFieldErrors();
    $('#unitModal').hidden = false;
  } catch (err) {
    showBanner('Edit: ' + describeError(err));
  }
}

export function closeUnitModal() {
  $('#unitModal').hidden = true;
  $('#f-branch').disabled = false;
  $('#f-floor').disabled = false;
  $('#f-size').disabled = false;
  clearFieldErrors();
}

export async function submitUnitForm(e) {
  e.preventDefault();
  clearFieldErrors();
  const body = {
    branchId: $('#f-branch').value,
    floorId: $('#f-floor').value,
    sizeId: $('#f-size').value,
    sqft: Number($('#f-sqft').value),
    monthlyRate: Number($('#f-monthlyRate').value),
    status: $('#f-status').value,
  };
  const cc = $('#f-climateControl').value.trim();
  if (cc) body.climateControl = cc;
  const nm = $('#f-name').value.trim();
  if (nm) body.name = nm;

  // client-side pre-checks (mirror zod)
  if (!body.branchId || !body.floorId || !body.sizeId) {
    showFormAlert('Branch, floor and size are required.');
    return;
  }
  if (!(body.sqft > 0)) {
    const el = $('#e-sqft');
    if (el) el.textContent = 'Must be greater than 0';
    $('#f-sqft').classList.add('err');
    return;
  }
  if (!(body.monthlyRate >= 0)) {
    const el = $('#e-monthlyRate');
    if (el) el.textContent = 'Must be 0 or greater';
    $('#f-monthlyRate').classList.add('err');
    return;
  }

  try {
    if (mode === 'create') {
      const res = await request('/units', { method: 'POST', body: JSON.stringify(body) });
      showBanner(`Created ${res.data.code}`, true);
    } else {
      // PUT /units/:code accepts sqft / monthlyRate / status / climateControl / name.
      // Name: non-empty → set it; empty → name: null (clears back to the unit code).
      const patch = {
        sqft: body.sqft,
        monthlyRate: body.monthlyRate,
        status: body.status,
        climateControl: body.climateControl,
        name: nm ? nm : null,
      };
      await request(`/units/${encodeURIComponent(currentEditCode)}`, { method: 'PUT', body: JSON.stringify(patch) });
      showBanner(`Updated ${currentEditCode}`, true);
    }
    closeUnitModal();
    await refreshAll();
  } catch (err) {
    renderFieldErrors(err);
    if (!(err instanceof ApiError && err.details && err.details.fieldErrors)) {
      showFormAlert(describeError(err));
    }
  }
}

export async function deleteUnit(code) {
  const unit = state.units.find((u) => u.code === code);
  if (unit && (unit.status === 'OCCUPIED' || unit.status === 'OVERDUE')) {
    // Known-guarded: hit the API so the 409 guard message surfaces, then blunt the row.
    try {
      await request(`/units/${encodeURIComponent(code)}`, { method: 'DELETE' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setUnitsBanner(err.message, '');
        bluntRow(code);
        showBanner(err.message);
        return;
      }
      showBanner(describeError(err));
      return;
    }
    return;
  }
  if (!window.confirm(`Delete unit ${code}? This soft-deletes it (removes it from the map and lists).`)) return;
  try {
    await request(`/units/${encodeURIComponent(code)}`, { method: 'DELETE' });
    showBanner(`Deleted ${code}`, true);
    setUnitsBanner('');
    await refreshAll();
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      setUnitsBanner(err.message, '');
      bluntRow(code);
      showBanner(err.message);
      return;
    }
    showBanner(describeError(err));
  }
}

// ---------- rate adjustment ----------
export function openRateForm(code) {
  const unit = state.units.find((u) => u.code === code);
  rateTargetCode = code;
  $('#rateModalTitle').textContent = `Adjust Rate — ${code}`;
  $('#f-newRate').value = unit && unit.rate != null ? unit.rate : '';
  $('#f-reason').value = '';
  $('#rateModalAlert').hidden = true;
  $('#e-newRate').textContent = '';
  $('#e-reason').textContent = '';
  $('#rateModal').hidden = false;
}

export function closeRateModal() {
  $('#rateModal').hidden = true;
  rateTargetCode = null;
}

export async function submitRateForm(e) {
  e.preventDefault();
  $('#rateModalAlert').hidden = true;
  $('#e-newRate').textContent = '';
  $('#e-reason').textContent = '';
  const newRate = Number($('#f-newRate').value);
  if (!(newRate > 0)) {
    $('#e-newRate').textContent = 'Must be greater than 0';
    return;
  }
  const body = { newRate };
  const reason = $('#f-reason').value.trim();
  if (reason) body.reason = reason;
  try {
    const res = await request(`/units/${encodeURIComponent(rateTargetCode)}/rate`, { method: 'POST', body: JSON.stringify(body) });
    showBanner(`Rate ${rateTargetCode}: ${fmtMoney(res.data.previous)} → ${fmtMoney(res.data.current)} (${res.data.changePct}%)`, true);
    closeRateModal();
    await refreshAll();
    if (state.selectedCode) showUnitDetail(state.selectedCode);
  } catch (err) {
    if (err instanceof ApiError && err.details && err.details.fieldErrors) {
      const fe = err.details.fieldErrors;
      if (fe.newRate) $('#e-newRate').textContent = fe.newRate.join('; ');
      if (fe.reason) $('#e-reason').textContent = fe.reason.join('; ');
    }
    $('#rateModalAlert').textContent = describeError(err);
    $('#rateModalAlert').hidden = false;
  }
}

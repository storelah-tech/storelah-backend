// StoreLah CMS admin UI — branch (facility) management inside Global Settings:
// list, create, edit, activate/deactivate and guarded delete (409 surfaced).
// Mirrors the floors-view patterns (modal + field-error mapping +
// confirmDialog) and the frozen theme classes (.tbl-card, .data-tbl, .badge,
// .act-btn, .modal-overlay). Extracted as its own view module (views →
// state/api/dom only); the entry wires it via the setters below and the
// settings lazy-load branch.
//
// Branch.code is IMMUTABLE after create (embedded in Unit.unitCode and
// door/asset codes): the create form takes it once (uppercased + validated
// server-side, 409 on dup) and the edit form never sends it. Retirement path
// is status INACTIVE (hides the branch from every public read); DELETE hard-
// deletes and is blocked while any Floor/Unit/Tenant/Lead/Appointment rows
// reference the branch.

import { $, $$, escapeHtml, showBanner } from './dom.js';
import { ApiError, get, post, put, del, describeError } from './api.js';
import { confirmDialog } from './confirmDialog.js';
import { state } from './state.js';

// Post-mutation hooks from the entry (refreshAll repaints map/tables; loadRefs
// refreshes state.branches/floors/sizes + the sidebar facility selector so a
// new/renamed branch follows everywhere).
let refreshAll = null;
export function setRefreshAll(fn) {
  refreshAll = fn;
}
let loadRefs = null;
export function setRefsLoader(fn) {
  loadRefs = fn;
}

let branchMode = 'create'; // 'create' | 'edit'
let branchEditId = null;

async function reloadBranches() {
  if (loadRefs) await loadRefs();
  else state.branches = await get('/branches');
}

function floorCountFor(branchId) {
  return (state.floors || []).filter((f) => f.branchId === branchId).length;
}

function renderBranchesTable() {
  const tbody = $('#branchesBody');
  if (!tbody) return;
  const rows = [...(state.branches || [])].sort((a, b) =>
    String(a.code || '').localeCompare(String(b.code || '')),
  );
  const sub = $('#branchesSub');
  if (sub) {
    const inactive = rows.filter((b) => b.status !== 'ACTIVE').length;
    sub.textContent = `${rows.length} facilit${rows.length === 1 ? 'y' : 'ies'}` +
      (inactive ? ` · ${inactive} inactive (hidden from booking)` : ' · all active');
  }
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="section-empty">No facilities yet — add the first one.</div></td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((b) => {
    const floors = floorCountFor(b.id);
    const units = b.unitCount ?? b.totalUnits ?? 0;
    const active = b.status !== 'INACTIVE';
    return `<tr data-branch-id="${escapeHtml(b.id)}" class="${active ? '' : 'row-blocked'}">
      <td><strong>${escapeHtml(b.code || '—')}</strong><div class="t-type">${escapeHtml(b.name || '')}</div></td>
      <td>${escapeHtml(b.address || '')}<div class="t-type">${escapeHtml(b.operatingHours || '')}</div></td>
      <td>${floors} floor${floors === 1 ? '' : 's'} · ${units} unit${units === 1 ? '' : 's'}</td>
      <td><span class="badge ${active ? 'avail' : 'neutral'}">${active ? 'Active' : 'Inactive'}</span></td>
      <td class="unit-actions">
        <button class="act-btn" data-bact="floors" data-branch-id="${escapeHtml(b.id)}">Floors</button>
        <button class="act-btn" data-bact="edit" data-branch-id="${escapeHtml(b.id)}">Edit</button>
        <button class="act-btn ${active ? '' : 'primary'}" data-bact="toggle" data-branch-id="${escapeHtml(b.id)}">${active ? 'Deactivate' : 'Activate'}</button>
        <button class="act-btn danger" data-bact="delete" data-branch-id="${escapeHtml(b.id)}">Delete</button>
      </td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('button[data-bact]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.branchId;
      const act = btn.dataset.bact;
      if (act === 'edit') openEditBranch(id);
      else if (act === 'toggle') toggleBranchActive(id);
      else if (act === 'delete') deleteBranchRow(id);
      else if (act === 'floors') jumpToFloors(id);
    });
  });
}

// Jump to the (unhidden) Floors tab filtered to this branch — the single
// floors path. Floors stay managed there, not duplicated here.
function jumpToFloors(branchId) {
  // Route through the sidebar entry (openPanel → openPage + subtab click) so
  // the Facilities page itself is shown: clicking the subtab button alone
  // only toggles panels inside #facilities, which stays hidden when called
  // from Global Settings (looked like "clicking Floors does nothing").
  const side = document.querySelector('[data-side-menu="facilities"] [data-side-panel="facility-floors"]');
  const tab = side
    || document.querySelector('[data-tabs="facility"] [data-tab="facility-floors"]');
  if (tab) tab.click();
  else return;
  // Pre-select the branch in the floors filter once the view binds.
  const apply = () => {
    const sel = $('#floorBranchFilter');
    if (sel && [...sel.options].some((o) => o.value === branchId)) {
      sel.value = branchId;
      sel.dispatchEvent(new Event('change'));
      return true;
    }
    return false;
  };
  if (!apply()) setTimeout(apply, 400);
}

export async function bindBranchesSection() {
  try {
    await reloadBranches();
    renderBranchesTable();
  } catch (err) {
    const tbody = $('#branchesBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6"><div class="section-empty">Facilities failed to load: ' + escapeHtml(describeError(err)) + '</div></td></tr>';
  }
}

// ---------- create / edit modal ----------

function clearBranchFieldErrors() {
  $$('#branchModal .field-err').forEach((el) => { el.textContent = ''; });
  $$('#branchModal .field input.err, #branchModal .field select.err, #branchModal .field textarea.err').forEach((el) => el.classList.remove('err'));
  const a = $('#branchModalAlert');
  if (a) a.hidden = true;
}

function showBranchFormAlert(msg) {
  const a = $('#branchModalAlert');
  if (!a) return;
  a.textContent = msg;
  a.hidden = false;
}

// zod fieldErrors keys → branch form element keys.
const BRANCH_FIELD_ID = { code: 'code', name: 'name', address: 'address', operatingHours: 'hours', description: 'desc', status: 'active' };

function renderBranchFieldErrors(err) {
  if (!(err instanceof ApiError) || !err.details || !err.details.fieldErrors) return false;
  let mapped = false;
  for (const [field, msgs] of Object.entries(err.details.fieldErrors)) {
    if (!msgs || !msgs.length) continue;
    const key = BRANCH_FIELD_ID[field];
    if (!key) continue;
    const errEl = $('#be-' + key);
    if (errEl) errEl.textContent = msgs.join('; ');
    const input = $('#bf-' + key);
    if (input) input.classList.add('err');
    mapped = true;
  }
  return mapped;
}

export async function openCreateBranch() {
  branchMode = 'create';
  branchEditId = null;
  $('#branchModalTitle').textContent = 'Add Facility';
  $('#branchModalHint').hidden = true;
  $('#bf-code').value = '';
  $('#bf-code').disabled = false;
  $('#bf-name').value = '';
  $('#bf-address').value = '';
  $('#bf-hours').value = '';
  $('#bf-desc').value = '';
  $('#bf-active').checked = true;
  $('#branchFormSubmit').textContent = 'Save Facility';
  clearBranchFieldErrors();
  $('#branchModal').hidden = false;
}

export async function openEditBranch(id) {
  const b = (state.branches || []).find((x) => x.id === id);
  if (!b) { showBanner('Facility not found in list.'); return; }
  branchMode = 'edit';
  branchEditId = id;
  $('#branchModalTitle').textContent = `Edit Facility — ${b.code || ''}`;
  // Code immutability notice (code is embedded in unit/door/asset codes).
  const hint = $('#branchModalHint');
  hint.textContent = `Code ${b.code || ''} is immutable (embedded in unit/door/asset codes) — only name, address, hours, description and status can change.`;
  hint.hidden = false;
  $('#bf-code').value = b.code || '';
  $('#bf-code').disabled = true;
  $('#bf-name').value = b.name || '';
  $('#bf-address').value = b.address || '';
  $('#bf-hours').value = b.operatingHours || '';
  $('#bf-desc').value = b.description || '';
  $('#bf-active').checked = b.status !== 'INACTIVE';
  $('#branchFormSubmit').textContent = 'Save Changes';
  clearBranchFieldErrors();
  $('#branchModal').hidden = false;
}

export function closeBranchModal() {
  $('#branchModal').hidden = true;
  branchEditId = null;
  clearBranchFieldErrors();
}

export async function submitBranchForm(e) {
  e.preventDefault();
  clearBranchFieldErrors();
  try {
    if (branchMode === 'create') {
      const code = $('#bf-code').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{2,8}$/.test(code)) {
        $('#be-code').textContent = 'Code must be 2..8 uppercase letters/digits (e.g. BM)';
        $('#bf-code').classList.add('err');
        return;
      }
      const body = {
        code,
        name: $('#bf-name').value.trim(),
        address: $('#bf-address').value.trim(),
        operatingHours: $('#bf-hours').value.trim(),
        status: $('#bf-active').checked ? 'ACTIVE' : 'INACTIVE',
      };
      const desc = $('#bf-desc').value.trim();
      if (desc) body.description = desc;
      await post('/branches', body);
      showBanner('Facility created', true);
    } else {
      const body = {
        name: $('#bf-name').value.trim(),
        address: $('#bf-address').value.trim(),
        operatingHours: $('#bf-hours').value.trim(),
        description: $('#bf-desc').value.trim() || null,
        status: $('#bf-active').checked ? 'ACTIVE' : 'INACTIVE',
      };
      await put('/branches/' + encodeURIComponent(branchEditId), body);
      showBanner('Facility updated', true);
    }
    closeBranchModal();
    await reloadBranches();
    renderBranchesTable();
    if (refreshAll) await refreshAll().catch(() => {});
  } catch (err) {
    if (!renderBranchFieldErrors(err)) showBranchFormAlert(describeError(err));
  }
}

// ---------- activate / deactivate toggle ----------

export async function toggleBranchActive(id) {
  const b = (state.branches || []).find((x) => x.id === id);
  if (!b) return;
  const toActive = b.status === 'INACTIVE';
  const verb = toActive ? 'Activate' : 'Deactivate';
  const extra = toActive
    ? 'It will reappear in the booking frontend (active floors only).'
    : 'It will disappear from the booking frontend entirely (reversible).';
  const okConfirm = await confirmDialog({
    title: `${verb} facility ${b.code || ''}?`,
    message: `${b.name || ''} — ${floorCountFor(b.id)} floor(s). ${extra}`,
    confirmLabel: verb,
    danger: !toActive,
  });
  if (!okConfirm) return;
  try {
    await put('/branches/' + encodeURIComponent(id), { status: toActive ? 'ACTIVE' : 'INACTIVE' });
    showBanner(`Facility ${toActive ? 'activated' : 'deactivated'}`, true);
    await reloadBranches();
    renderBranchesTable();
    if (refreshAll) await refreshAll().catch(() => {});
  } catch (err) {
    showBanner('Facility: ' + describeError(err));
  }
}

// ---------- guarded delete ----------

export async function deleteBranchRow(id) {
  const b = (state.branches || []).find((x) => x.id === id);
  if (!b) return;
  const floors = floorCountFor(b.id);
  const units = b.unitCount ?? b.totalUnits ?? 0;
  const okConfirm = await confirmDialog({
    title: `Delete facility ${b.code || ''}?`,
    message: (floors > 0 || units > 0)
      ? `This facility still has ${floors} floor(s) and ${units} unit(s) — deletion is blocked. Deactivate it instead to hide it from booking.`
      : 'Empty facilities are removed permanently. Deactivate instead to keep the row.',
    confirmLabel: (floors > 0 || units > 0) ? 'Deactivate instead' : 'Delete',
    danger: true,
  });
  if (!okConfirm) return;
  try {
    if (floors > 0 || units > 0) {
      // Guard path: the server 409s a hard delete while floors/units exist,
      // so go straight to the reversible deactivation.
      await put('/branches/' + encodeURIComponent(id), { status: 'INACTIVE' });
      showBanner('Facility deactivated (delete blocked — floors/units still attached)', true);
    } else {
      await del('/branches/' + encodeURIComponent(id));
      showBanner('Facility deleted', true);
    }
    await reloadBranches();
    renderBranchesTable();
    if (refreshAll) await refreshAll().catch(() => {});
  } catch (err) {
    showBanner('Delete: ' + describeError(err));
  }
}

// ---------- wiring (called once by the entry) ----------

export function wireBranchesView() {
  $('#addBranchBtn')?.addEventListener('click', () => { openCreateBranch().catch((e) => showBanner('Facilities: ' + describeError(e))); });
  $('#branchModalClose')?.addEventListener('click', closeBranchModal);
  $('#branchFormCancel')?.addEventListener('click', closeBranchModal);
  $('#branchForm')?.addEventListener('submit', submitBranchForm);
}

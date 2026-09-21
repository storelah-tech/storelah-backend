// StoreLah CMS admin UI — facility floors view: per-branch floor list with
// active/inactive badges, create/edit modal, activate/deactivate toggle and
// guarded delete (409 surfaced). Mirrors the units-view patterns (modal +
// field-error mapping + confirmDialog) and the frozen theme classes
// (.tbl-card, .data-tbl, .badge, .act-btn, .modal-overlay).
// Extracted as its own view module (views → state/api/dom only); the entry
// wires it via the setters below and the facility-tabs lazy-load branch.

import { $, $$, escapeHtml, showBanner } from './dom.js';
import { ApiError, get, post, put, del, describeError } from './api.js';
import { confirmDialog } from './confirmDialog.js';
import { state } from './state.js';

// Post-mutation hooks from the entry (refreshAll repaints map/tables; loadRefs
// refreshes state.branches/floors/sizes so the unit form + floor tabs follow).
let refreshAll = null;
export function setRefreshAll(fn) {
  refreshAll = fn;
}
let loadRefs = null;
export function setRefsLoader(fn) {
  loadRefs = fn;
}

let floorMode = 'create'; // 'create' | 'edit'
let floorEditId = null;
let floorBranchFilter = ''; // '' = all facilities, otherwise a branch id

async function reloadFloors() {
  if (loadRefs) await loadRefs();
  else state.floors = await get('/floors');
}

function branchOptions() {
  return (state.branches || []).map(
    (b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.code)} · ${escapeHtml(b.name)}</option>`,
  ).join('');
}

function renderBranchFilter() {
  const sel = $('#floorBranchFilter');
  if (!sel) return;
  const cur = floorBranchFilter || '';
  sel.innerHTML = '<option value="">All facilities</option>' + branchOptions();
  sel.value = cur;
}

function filteredFloors() {
  const rows = state.floors || [];
  const sorted = [...rows].sort((a, b) =>
    String(a.branch?.code || '').localeCompare(String(b.branch?.code || '')) || a.level - b.level,
  );
  return floorBranchFilter ? sorted.filter((f) => f.branchId === floorBranchFilter) : sorted;
}

function renderFloorsTable() {
  const tbody = $('#floorsBody');
  if (!tbody) return;
  const rows = filteredFloors();
  const sub = $('#floorsSub');
  if (sub) {
    const inactive = rows.filter((f) => !f.isActive).length;
    sub.textContent = `${rows.length} floor${rows.length === 1 ? '' : 's'}` +
      (inactive ? ` · ${inactive} inactive (hidden from booking)` : ' · all active');
  }
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="section-empty">No floors yet — add the first one.</div></td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((f) => {
    const live = f.liveUnitCount ?? f.unitCount ?? 0;
    const total = f.unitCount ?? 0;
    return `<tr data-floor-id="${escapeHtml(f.id)}" class="${f.isActive ? '' : 'row-blocked'}">
      <td><strong>${escapeHtml(f.branch?.code || '—')}</strong><div class="t-type">${escapeHtml(f.branch?.name || '')}</div></td>
      <td>Level ${f.level}</td>
      <td>${escapeHtml(f.name || '')}</td>
      <td>${live} live${total !== live ? ` · ${total} total` : ''}</td>
      <td><span class="badge ${f.isActive ? 'avail' : 'neutral'}">${f.isActive ? 'Active' : 'Inactive'}</span></td>
      <td class="unit-actions">
        <button class="act-btn" data-fact="edit" data-floor-id="${escapeHtml(f.id)}">Edit</button>
        <button class="act-btn ${f.isActive ? '' : 'primary'}" data-fact="toggle" data-floor-id="${escapeHtml(f.id)}">${f.isActive ? 'Deactivate' : 'Activate'}</button>
        <button class="act-btn danger" data-fact="delete" data-floor-id="${escapeHtml(f.id)}">Delete</button>
      </td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('button[data-fact]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.floorId;
      const act = b.dataset.fact;
      if (act === 'edit') openEditFloor(id);
      else if (act === 'toggle') toggleFloorActive(id);
      else if (act === 'delete') deleteFloorRow(id);
    });
  });
}

export async function bindFloorsView() {
  try {
    renderBranchFilter();
    await reloadFloors();
    renderBranchFilter();
    renderFloorsTable();
  } catch (err) {
    showBanner('Floors: ' + describeError(err));
  }
}

// ---------- create / edit modal ----------

function clearFloorFieldErrors() {
  $$('#floorModal .field-err').forEach((el) => { el.textContent = ''; });
  $$('#floorModal .field input.err, #floorModal .field select.err').forEach((el) => el.classList.remove('err'));
  const a = $('#floorModalAlert');
  if (a) a.hidden = true;
}

function showFloorFormAlert(msg) {
  const a = $('#floorModalAlert');
  if (!a) return;
  a.textContent = msg;
  a.hidden = false;
}

// zod fieldErrors keys → floor form element keys.
const FLOOR_FIELD_ID = { branchId: 'branch', level: 'level', name: 'name', isActive: 'active' };

function renderFloorFieldErrors(err) {
  if (!(err instanceof ApiError) || !err.details || !err.details.fieldErrors) return false;
  let mapped = false;
  for (const [field, msgs] of Object.entries(err.details.fieldErrors)) {
    if (!msgs || !msgs.length) continue;
    const key = FLOOR_FIELD_ID[field];
    if (!key) continue;
    const errEl = $('#fe-' + key);
    if (errEl) errEl.textContent = msgs.join('; ');
    const input = $('#ff-' + key);
    if (input) input.classList.add('err');
    mapped = true;
  }
  return mapped;
}

export async function openCreateFloor() {
  if (!state.branches.length) await reloadFloors();
  floorMode = 'create';
  floorEditId = null;
  $('#floorModalTitle').textContent = 'Add Floor';
  $('#floorModalHint').hidden = true;
  $('#ff-branch').innerHTML = branchOptions();
  if (floorBranchFilter) $('#ff-branch').value = floorBranchFilter;
  $('#ff-branch').disabled = false;
  $('#ff-level').value = '';
  $('#ff-name').value = '';
  $('#ff-active').checked = true;
  $('#floorFormSubmit').textContent = 'Save Floor';
  clearFloorFieldErrors();
  $('#floorModal').hidden = false;
}

export async function openEditFloor(id) {
  const f = (state.floors || []).find((x) => x.id === id);
  if (!f) { showBanner('Floor not found in list.'); return; }
  floorMode = 'edit';
  floorEditId = id;
  $('#floorModalTitle').textContent = `Edit Floor — ${f.branch?.code || ''} Level ${f.level}`;
  $('#floorModalHint').hidden = false;
  $('#ff-branch').innerHTML = branchOptions();
  $('#ff-branch').value = f.branchId;
  $('#ff-branch').disabled = true;
  $('#ff-level').value = f.level;
  $('#ff-name').value = f.name || '';
  $('#ff-active').checked = f.isActive !== false;
  $('#floorFormSubmit').textContent = 'Save Changes';
  clearFloorFieldErrors();
  $('#floorModal').hidden = false;
}

export function closeFloorModal() {
  $('#floorModal').hidden = true;
  floorEditId = null;
  clearFloorFieldErrors();
}

export async function submitFloorForm(e) {
  e.preventDefault();
  clearFloorFieldErrors();
  try {
    if (floorMode === 'create') {
      const level = Number($('#ff-level').value);
      if (!Number.isInteger(level) || level < 1 || level > 99) {
        $('#fe-level').textContent = 'Level must be an integer 1..99';
        $('#ff-level').classList.add('err');
        return;
      }
      const body = { branchId: $('#ff-branch').value, level };
      const name = $('#ff-name').value.trim();
      if (name) body.name = name;
      // New floors default active server-side; honour an unchecked box with
      // an immediate deactivation (the POST response carries the new id).
      const makeInactive = !$('#ff-active').checked;
      const created = await post('/floors', body);
      if (makeInactive && created && created.id) {
        await put('/floors/' + encodeURIComponent(created.id), { isActive: false });
      }
      showBanner('Floor created', true);
    } else {
      const body = {};
      const levelRaw = $('#ff-level').value.trim();
      if (levelRaw !== '') {
        const level = Number(levelRaw);
        if (!Number.isInteger(level) || level < 1 || level > 99) {
          $('#fe-level').textContent = 'Level must be an integer 1..99';
          $('#ff-level').classList.add('err');
          return;
        }
        body.level = level;
      }
      const name = $('#ff-name').value.trim();
      const current = (state.floors || []).find((x) => x.id === floorEditId);
      if (!current || name !== (current.name || '')) body.name = name;
      body.isActive = $('#ff-active').checked;
      await put('/floors/' + encodeURIComponent(floorEditId), body);
      showBanner('Floor updated', true);
    }
    closeFloorModal();
    await reloadFloors();
    renderBranchFilter();
    renderFloorsTable();
    if (refreshAll) await refreshAll().catch(() => {});
  } catch (err) {
    if (!renderFloorFieldErrors(err)) showFloorFormAlert(describeError(err));
  }
}

// ---------- activate / deactivate toggle ----------

export async function toggleFloorActive(id) {
  const f = (state.floors || []).find((x) => x.id === id);
  if (!f) return;
  const to = !(f.isActive !== false);
  const verb = to ? 'Activate' : 'Deactivate';
  const extra = to
    ? 'Its units will reappear in the booking frontend.'
    : 'Its units will disappear from the booking frontend (reversible).';
  const okConfirm = await confirmDialog({
    title: `${verb} ${f.branch?.code || ''} Level ${f.level}?`,
    message: `${f.liveUnitCount ?? f.unitCount ?? 0} live unit(s) on this floor. ${extra}`,
    confirmLabel: verb,
    danger: !to,
  });
  if (!okConfirm) return;
  try {
    await put('/floors/' + encodeURIComponent(id), { isActive: to });
    showBanner(`Floor ${to ? 'activated' : 'deactivated'}`, true);
    await reloadFloors();
    renderFloorsTable();
    if (refreshAll) await refreshAll().catch(() => {});
  } catch (err) {
    showBanner('Floor: ' + describeError(err));
  }
}

// ---------- guarded delete ----------

export async function deleteFloorRow(id) {
  const f = (state.floors || []).find((x) => x.id === id);
  if (!f) return;
  const live = f.liveUnitCount ?? f.unitCount ?? 0;
  const okConfirm = await confirmDialog({
    title: `Delete ${f.branch?.code || ''} Level ${f.level}?`,
    message: live > 0
      ? `This floor still has ${live} live unit(s) — deletion is blocked. Deactivate it instead to hide it from booking.`
      : 'Empty floors are removed permanently (plan + placements go with it). Deactivate instead to keep the row.',
    confirmLabel: live > 0 ? 'Deactivate instead' : 'Delete',
    danger: true,
  });
  if (!okConfirm) return;
  try {
    if (live > 0) {
      // Guard path: the server 409s a hard delete while units exist, so go
      // straight to the reversible deactivation.
      await put('/floors/' + encodeURIComponent(id), { isActive: false });
      showBanner('Floor deactivated (delete blocked — units still attached)', true);
    } else {
      await del('/floors/' + encodeURIComponent(id));
      showBanner('Floor deleted', true);
    }
    await reloadFloors();
    renderFloorsTable();
    if (refreshAll) await refreshAll().catch(() => {});
  } catch (err) {
    showBanner('Delete: ' + describeError(err));
  }
}

// ---------- wiring (called once by the entry) ----------

export function wireFloorsView() {
  $('#floorBranchFilter')?.addEventListener('change', (e) => {
    floorBranchFilter = e.target.value;
    renderFloorsTable();
  });
  $('#addFloorBtn')?.addEventListener('click', () => { openCreateFloor().catch((e) => showBanner('Floors: ' + describeError(e))); });
  $('#floorModalClose')?.addEventListener('click', closeFloorModal);
  $('#floorFormCancel')?.addEventListener('click', closeFloorModal);
  $('#floorForm')?.addEventListener('submit', submitFloorForm);
}

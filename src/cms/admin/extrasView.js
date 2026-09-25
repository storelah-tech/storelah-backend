// StoreLah CMS admin UI — Booking extras catalog (protection plans + addons).
// CMS-editable catalog for the booking flow: GET/POST/PATCH/DELETE
// /protection-plans + /addons. Self-mounting: the section is built dynamically
// inside the Facilities Management panel #facility-extras (no dashboard.html
// restructure needed beyond the panel host), reusing
// the frozen v8 theme classes (.tbl-card, .data-tbl, .tb-btn, .act-btn, .sw,
// .modal-overlay/.modal-win) plus the shared confirmDialog.
//
// Row actions mirror the contract: Edit (modal), Deactivate/Activate (PATCH
// active toggle — preferred, keeps history), Delete (hard delete w/ confirm).

import { $, escapeHtml, showBanner } from './dom.js';
import { get, post, patch, del, describeError } from './api.js';
import { confirmDialog } from './confirmDialog.js';

const fmtMoney = (n) => '$' + Number(n || 0).toLocaleString('en-SG', { maximumFractionDigits: 2 });

// ---------- section mount (new DOM only — never touches existing markup) ----------

function ensureSection() {
  // Facilities Management host panel (declared in admin dashboard.html).
  const host = $('#facility-extras');
  if (!host) return $('#extrasSection');
  let el = $('#extrasSection');
  if (el && el.parentElement === host) return el;
  // Stale mount (e.g. legacy Settings location) — drop it so Settings stays
  // clean and there is exactly one extras section under Facilities.
  if (el) el.remove();
  el = document.createElement('div');
  el.className = 'tbl-card';
  el.id = 'extrasSection';
  el.style.marginTop = '16px';
  el.innerHTML =
    '<div class="sec-hdr"><div><div class="sec-title">Protection plans &amp; addons</div>' +
    '<div class="sec-sub">Booking checkout catalog · deactivation preferred over delete — bookings snapshot catalog values</div></div>' +
    '<div style="display:flex;gap:7px;"><button class="tb-btn primary" id="xp-plan-add">+ Add plan</button>' +
    '<button class="tb-btn primary" id="xp-addon-add">+ Add addon</button></div></div>' +
    '<div class="t-type" style="margin:6px 2px;text-transform:uppercase;">Protection plans · monthly recurring</div>' +
    '<table class="data-tbl"><thead><tr><th>Plan</th><th>Price / mo</th><th>Coverage</th><th>Order</th><th>Active</th><th></th></tr></thead>' +
    '<tbody id="xpPlansBody"></tbody></table>' +
    '<div class="t-type" style="margin:12px 2px 6px;text-transform:uppercase;">Packing-supply addons · one-off</div>' +
    '<table class="data-tbl"><thead><tr><th>Addon</th><th>Price</th><th>Unit</th><th>Order</th><th>Active</th><th></th></tr></thead>' +
    '<tbody id="xpAddonsBody"></tbody></table>';
  host.appendChild(el);
  return el;
}

// ---------- lists ----------

function thumb(url) {
  return url
    ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" style="width:40px;height:40px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:8px;" onerror="this.remove()">`
    : '';
}

function planRow(p) {
  return (
    `<tr><td><b>${thumb(p.imageUrl)}${escapeHtml(p.name)}</b><div class="t-type">${escapeHtml(p.id)}</div></td>` +
    `<td><b>${fmtMoney(p.price)}</b><div class="t-type">/ month</div></td>` +
    `<td>${p.coverage ? escapeHtml(p.coverage) : '<span class="t-type">—</span>'}</td>` +
    `<td>${escapeHtml(String(p.sortOrder))}</td>` +
    `<td><span class="sw${p.active ? ' on' : ''}" data-xp-toggle="plan" data-xp-id="${escapeHtml(p.id)}" role="switch" tabindex="0"><i></i></span></td>` +
    `<td class="unit-actions"><button class="act-btn" data-xp-edit="plan" data-xp-id="${escapeHtml(p.id)}">Edit</button> ` +
    `<button class="act-btn" data-xp-toggle="plan" data-xp-id="${escapeHtml(p.id)}">${p.active ? 'Deactivate' : 'Activate'}</button> ` +
    `<button class="act-btn danger" data-xp-del="plan" data-xp-id="${escapeHtml(p.id)}">Delete</button></td></tr>`
  );
}

function addonRow(a) {
  return (
    `<tr><td><b>${thumb(a.imageUrl)}${escapeHtml(a.name)}</b><div class="t-type">${escapeHtml(a.id)}</div></td>` +
    `<td><b>${fmtMoney(a.price)}</b><div class="t-type">one-off</div></td>` +
    `<td>${a.unit ? escapeHtml(a.unit) : '<span class="t-type">—</span>'}</td>` +
    `<td>${escapeHtml(String(a.sortOrder))}</td>` +
    `<td><span class="sw${a.active ? ' on' : ''}" data-xp-toggle="addon" data-xp-id="${escapeHtml(a.id)}" role="switch" tabindex="0"><i></i></span></td>` +
    `<td class="unit-actions"><button class="act-btn" data-xp-edit="addon" data-xp-id="${escapeHtml(a.id)}">Edit</button> ` +
    `<button class="act-btn" data-xp-toggle="addon" data-xp-id="${escapeHtml(a.id)}">${a.active ? 'Deactivate' : 'Activate'}</button> ` +
    `<button class="act-btn danger" data-xp-del="addon" data-xp-id="${escapeHtml(a.id)}">Delete</button></td></tr>`
  );
}

export async function bindExtrasSection() {
  if (!ensureSection()) return;
  const plansBody = $('#xpPlansBody');
  const addonsBody = $('#xpAddonsBody');
  try {
    const plans = (await get('/protection-plans')) || [];
    if (plansBody) {
      plansBody.innerHTML = plans.length
        ? plans.map(planRow).join('')
        : '<tr><td colspan="6"><div class="section-empty">No protection plans.</div></td></tr>';
    }
  } catch (e) {
    if (plansBody) plansBody.innerHTML = '<tr><td colspan="6"><div class="section-empty">Plans failed to load: ' + escapeHtml(describeError(e)) + '</div></td></tr>';
  }
  try {
    const addons = (await get('/addons')) || [];
    if (addonsBody) {
      addonsBody.innerHTML = addons.length
        ? addons.map(addonRow).join('')
        : '<tr><td colspan="6"><div class="section-empty">No addons.</div></td></tr>';
    }
  } catch (e) {
    if (addonsBody) addonsBody.innerHTML = '<tr><td colspan="6"><div class="section-empty">Addons failed to load: ' + escapeHtml(describeError(e)) + '</div></td></tr>';
  }
}

// ---------- create/edit modal (dynamic overlay, themed) ----------

function closeExtraModal() {
  const ov = $('#xpModal');
  if (ov) ov.hidden = true;
}

function openExtraModal(kind, row) {
  const isPlan = kind === 'plan';
  const editing = !!row;
  let ov = $('#xpModal');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.id = 'xpModal';
    ov.hidden = true;
    ov.innerHTML =
      '<div class="modal-win"><div class="modal-hdr"><div class="modal-title" id="xpModalTitle"></div>' +
      '<button class="modal-x" id="xpModalClose" type="button">✕</button></div>' +
      '<div class="modal-alert" id="xpModalAlert" hidden></div>' +
      '<div class="modal-hint" id="xpModalHint"></div>' +
      '<form id="xpForm" novalidate><div class="form-grid">' +
      '<div class="field"><label for="xp-id">ID (slug)</label><input id="xp-id" maxlength="80"><div class="field-err" id="xp-e-id"></div></div>' +
      '<div class="field"><label for="xp-name">Name</label><input id="xp-name" maxlength="120"><div class="field-err" id="xp-e-name"></div></div>' +
      '<div class="field"><label for="xp-price">Price (SGD)</label><input id="xp-price" type="number" min="0" step="0.01"><div class="field-err" id="xp-e-price"></div></div>' +
      '<div class="field"><label for="xp-sort">Sort order</label><input id="xp-sort" type="number" min="0" step="1"><div class="field-err" id="xp-e-sort"></div></div>' +
      '<div class="field full"><label for="xp-extra" id="xp-extra-label">Coverage</label><input id="xp-extra" maxlength="500"><div class="field-err" id="xp-e-extra"></div></div>' +
      '<div class="field full"><label for="xp-image">Image URL (https, optional)</label><input id="xp-image" maxlength="2048" placeholder="https://…"><div class="field-err" id="xp-e-image"></div></div>' +
      '</div></form>' +
      '<div class="modal-foot"><button class="tb-btn ghost" id="xpModalCancel" type="button">Cancel</button>' +
      '<button class="tb-btn primary" id="xpModalSave" type="button">Save</button></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => {
      if (e.target === ov) closeExtraModal();
    });
    $('#xpModalClose').addEventListener('click', closeExtraModal);
    $('#xpModalCancel').addEventListener('click', closeExtraModal);
    $('#xpModalSave').addEventListener('click', () => submitExtraModal().catch(() => {}));
  }
  ov.dataset.kind = kind;
  ov.dataset.editId = editing ? row.id : '';
  $('#xpModalTitle').textContent = (editing ? 'Edit ' : 'Add ') + (isPlan ? 'protection plan' : 'addon');
  $('#xpModalHint').textContent = isPlan
    ? 'Price is monthly recurring. Deactivation hides the tier from checkout; bookings keep their snapshot.'
    : 'Price is one-off. Deactivation hides the addon from checkout; bookings keep their snapshot.';
  $('#xp-extra-label').textContent = isPlan ? 'Coverage (optional)' : 'Unit (optional — e.g. box, each)';
  const idInput = $('#xp-id');
  idInput.value = editing ? row.id : '';
  idInput.disabled = editing;
  $('#xp-name').value = editing ? (row.name || '') : '';
  $('#xp-price').value = editing ? String(row.price ?? '') : '';
  $('#xp-sort').value = editing ? String(row.sortOrder ?? 0) : '';
  $('#xp-extra').value = editing ? (isPlan ? (row.coverage || '') : (row.unit || '')) : '';
  $('#xp-image').value = editing ? (row.imageUrl || '') : '';
  const alert = $('#xpModalAlert');
  alert.hidden = true;
  alert.textContent = '';
  ov.hidden = false;
}

function modalFail(msg) {
  const alert = $('#xpModalAlert');
  if (alert) {
    alert.textContent = msg;
    alert.hidden = false;
  } else {
    showBanner(msg);
  }
}

async function submitExtraModal() {
  const ov = $('#xpModal');
  if (!ov) return;
  const kind = ov.dataset.kind;
  const editId = ov.dataset.editId || '';
  const isPlan = kind === 'plan';
  const id = $('#xp-id')?.value.trim() || '';
  const name = $('#xp-name')?.value.trim() || '';
  const priceRaw = $('#xp-price')?.value.trim() || '';
  const sortRaw = $('#xp-sort')?.value.trim() || '';
  const extra = $('#xp-extra')?.value.trim() || '';
  const imageUrl = $('#xp-image')?.value.trim() || '';
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
    modalFail('Image URL must start with https:// (or leave it empty for no image).');
    return;
  }
  if (!editId && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    modalFail('ID must be a URL-safe slug (lowercase, numbers, hyphens).');
    return;
  }
  if (!name) {
    modalFail('Name is required.');
    return;
  }
  const price = Number(priceRaw);
  if (priceRaw === '' || !Number.isFinite(price) || price < 0) {
    modalFail('Price must be 0 or greater.');
    return;
  }
  const path = isPlan ? '/protection-plans' : '/addons';
  try {
    if (editId) {
      const body = { name, price };
      if (sortRaw !== '') body.sortOrder = Math.max(0, Math.floor(Number(sortRaw)));
      body[isPlan ? 'coverage' : 'unit'] = extra || null;
      body.imageUrl = imageUrl || null;
      await patch(`${path}/${encodeURIComponent(editId)}`, body);
      showBanner(`${isPlan ? 'Plan' : 'Addon'} ${editId} saved`, true);
    } else {
      const body = { id, name, price };
      if (sortRaw !== '') body.sortOrder = Math.max(0, Math.floor(Number(sortRaw)));
      if (extra) body[isPlan ? 'coverage' : 'unit'] = extra;
      if (imageUrl) body.imageUrl = imageUrl;
      await post(path, body);
      showBanner(`${isPlan ? 'Plan' : 'Addon'} ${id} created`, true);
    }
    closeExtraModal();
    await bindExtrasSection();
  } catch (e) {
    modalFail(describeError(e));
  }
}

// ---------- row actions ----------

async function toggleActive(kind, id) {
  const path = kind === 'plan' ? '/protection-plans' : '/addons';
  try {
    const rows = (await get(path)) || [];
    const row = rows.find((r) => r.id === id);
    if (!row) {
      showBanner(`${kind === 'plan' ? 'Plan' : 'Addon'} ${id} not found`);
      return;
    }
    if (row.active) {
      const okConfirm = await confirmDialog({
        title: `Deactivate ${row.name}?`,
        message: 'It will be hidden from booking checkout. Prefer deactivation over delete — past bookings keep their snapshot.',
        confirmLabel: 'Deactivate',
      });
      if (!okConfirm) return;
    }
    await patch(`${path}/${encodeURIComponent(id)}`, { active: !row.active });
    showBanner(`${row.name} ${row.active ? 'deactivated' : 'activated'}`, true);
    await bindExtrasSection();
  } catch (e) {
    showBanner(describeError(e));
  }
}

async function deleteRow(kind, id) {
  const path = kind === 'plan' ? '/protection-plans' : '/addons';
  const label = kind === 'plan' ? 'protection plan' : 'addon';
  const okConfirm = await confirmDialog({
    title: `Delete ${label} ${id}?`,
    message: 'Hard delete is permanent. Prefer Deactivate to hide it from checkout instead.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!okConfirm) return;
  try {
    await del(`${path}/${encodeURIComponent(id)}`);
    showBanner(`${label} ${id} deleted`, true);
    await bindExtrasSection();
  } catch (e) {
    showBanner(describeError(e));
  }
}

async function editRow(kind, id) {
  const path = kind === 'plan' ? '/protection-plans' : '/addons';
  try {
    const rows = (await get(path)) || [];
    const row = rows.find((r) => r.id === id);
    if (!row) {
      showBanner(`${kind === 'plan' ? 'Plan' : 'Addon'} ${id} not found`);
      return;
    }
    openExtraModal(kind, row);
  } catch (e) {
    showBanner(describeError(e));
  }
}

let extrasWired = false;
export function wireExtras() {
  if (extrasWired) return;
  extrasWired = true;
  $('#xp-plan-add')?.addEventListener('click', () => {
    if (!ensureSection()) return;
    openExtraModal('plan', null);
  });
  $('#xp-addon-add')?.addEventListener('click', () => {
    if (!ensureSection()) return;
    openExtraModal('addon', null);
  });
  // Delegated (section is dynamic): re-resolve anchors per click so the
  // pre-mount wiring above never goes stale.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('#xp-plan-add')) {
      if (!ensureSection()) return;
      openExtraModal('plan', null);
      return;
    }
    if (t.closest('#xp-addon-add')) {
      if (!ensureSection()) return;
      openExtraModal('addon', null);
      return;
    }
    const edit = t.closest('[data-xp-edit]');
    if (edit) {
      editRow(edit.dataset.xpEdit, edit.dataset.xpId).catch(() => {});
      return;
    }
    const toggle = t.closest('[data-xp-toggle]');
    if (toggle) {
      toggleActive(toggle.dataset.xpToggle, toggle.dataset.xpId).catch(() => {});
      return;
    }
    const delBtn = t.closest('[data-xp-del]');
    if (delBtn) deleteRow(delBtn.dataset.xpDel, delBtn.dataset.xpId).catch(() => {});
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const ov = $('#xpModal');
    if (ov && !ov.hidden) closeExtraModal();
  });
}

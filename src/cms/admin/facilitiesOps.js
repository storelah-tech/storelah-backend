// StoreLah CMS admin UI — facility operations views (sidebar modules 2–6).
// Maintenance (work orders + preventive tasks), Assets & vendors, Incidents,
// Access control (5 sub-panels) and Inspections & compliance. Talks to the
// /api/v1/cms facility endpoints via api.js; reuses dom.js (escapeHtml,
// showBanner), confirmDialog.js and the state.js branch list. No stylesheet or
// dashboard.html structural changes — all panels/modals reuse the v8 theme
// tokens (.tbl-card, .data-tbl, .modal-overlay/.modal-win, .pill, .badge).

import { $, $$, escapeHtml, showBanner } from './dom.js';
import { get, post, patch, del, describeError } from './api.js';
import { confirmDialog } from './confirmDialog.js';
import { state } from './state.js';

// ====================== helpers ======================

function fmtDay(d) {
  if (!d) return '—';
  const t = new Date(d);
  if (isNaN(t.getTime())) return '—';
  return t.toLocaleDateString('en-SG', { day: '2-digit', month: 'short' });
}

function fmtMoney(n) {
  if (n == null || isNaN(Number(n))) return '—';
  return '$' + Number(n).toLocaleString('en-SG', { maximumFractionDigits: 2 });
}

function pillFor(status, map) {
  return map[status] || '';
}

const WO_PILL = { OPEN: 'red', IN_PROGRESS: 'amber', DONE: 'green' };
const INC_SEV_PILL = { LOW: '', MEDIUM: 'amber', HIGH: 'red', CRITICAL: 'red' };
const INC_STATUS_PILL = { OPEN: 'red', IN_PROGRESS: 'amber', RESOLVED: 'green', CLOSED: '' };
const CERT_PILL = { VALID: 'green', EXPIRING: 'amber', EXPIRED: 'red' };

function branchOptions(currentId) {
  return (
    '<option value="">— No facility —</option>' +
    (state.branches || [])
      .map(
        (b) =>
          '<option value="' +
          escapeHtml(b.id) +
          '"' +
          (b.id === currentId ? ' selected' : '') +
          '>' +
          escapeHtml(b.name) +
          ' (' +
          escapeHtml(b.code) +
          ')</option>',
      )
      .join('')
  );
}

let unitsCache = null;
async function loadUnitsCache() {
  if (unitsCache) return unitsCache;
  try {
    const data = await get('/units?perPage=200');
    const rows = Array.isArray(data) ? data : data.rows || [];
    unitsCache = rows;
  } catch (e) {
    unitsCache = [];
  }
  return unitsCache;
}

function unitOptions(units, currentId, branchId) {
  const rows = (units || []).filter((u) => !branchId || u.branchId === branchId);
  return (
    '<option value="">— No unit —</option>' +
    rows
      .map(
        (u) =>
          '<option value="' +
          escapeHtml(u.id || u.unitId || '') +
          '"' +
          ((u.id || u.unitId) === currentId ? ' selected' : '') +
          '>' +
          escapeHtml(u.code || u.unitCode || '') +
          '</option>',
      )
      .join('')
  );
}

// ====================== generic ops modal ======================
// Runtime-built CRUD modal reusing .modal-overlay/.modal-win v8 styles.
// fields: [{ key, label, type, options?, required?, placeholder?, full? }]
// types: text | number | select | date | textarea | steps
// steps = textarea, one step per line, merged with existing by label.

function ensureOpsModal() {
  let ov = $('#opsModal');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'opsModal';
  ov.hidden = true;
  ov.innerHTML =
    '<div class="modal-win"><div class="modal-hdr"><div class="modal-title" id="opsModalTitle"></div>' +
    '<button class="modal-x" id="opsModalClose" type="button">✕</button></div>' +
    '<div class="modal-alert" id="opsModalAlert" hidden></div>' +
    '<form id="opsForm" novalidate><div class="form-grid" id="opsFormGrid"></div>' +
    '<div class="modal-foot"><button class="act-btn" type="button" id="opsFormCancel">Cancel</button>' +
    '<button class="act-btn primary" type="submit" id="opsFormSubmit">Save</button></div></form></div>';
  document.body.appendChild(ov);
  const close = () => {
    ov.hidden = true;
  };
  ov.addEventListener('click', (e) => {
    if (e.target === ov) close();
  });
  ov.querySelector('#opsModalClose').addEventListener('click', close);
  ov.querySelector('#opsFormCancel').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ov.hidden) close();
  });
  return ov;
}

function fieldHtml(f, value) {
  const id = 'opsf-' + f.key;
  const req = f.required ? ' required' : '';
  const wrap = '<div class="field' + (f.full ? ' full' : '') + '"><label for="' + id + '">' + escapeHtml(f.label) + '</label>';
  const v = value == null ? '' : value;
  if (f.type === 'select') {
    return (
      wrap +
      '<select id="' +
      id +
      '" data-ops-key="' +
      escapeHtml(f.key) +
      '">' +
      (f.optionsHtml || '') +
      '</select></div>'
    );
  }
  if (f.type === 'textarea' || f.type === 'steps') {
    return (
      wrap +
      '<input type="text" id="' +
      id +
      '" data-ops-key="' +
      escapeHtml(f.key) +
      '" value="' +
      escapeHtml(v) +
      '" placeholder="' +
      escapeHtml(f.placeholder || '') +
      '"' +
      req +
      '></div>'
    );
  }
  if (f.type === 'date') {
    return (
      wrap +
      '<input type="date" id="' +
      id +
      '" data-ops-key="' +
      escapeHtml(f.key) +
      '" value="' +
      escapeHtml(v) +
      '"></div>'
    );
  }
  if (f.type === 'number') {
    return (
      wrap +
      '<input type="number" id="' +
      id +
      '" data-ops-key="' +
      escapeHtml(f.key) +
      '" value="' +
      escapeHtml(v) +
      '" min="0" step="0.01" placeholder="' +
      escapeHtml(f.placeholder || '') +
      '"' +
      req +
      '></div>'
    );
  }
  return (
    wrap +
    '<input type="text" id="' +
    id +
    '" data-ops-key="' +
    escapeHtml(f.key) +
    '" value="' +
    escapeHtml(v) +
    '" maxlength="160" placeholder="' +
    escapeHtml(f.placeholder || '') +
    '"' +
    req +
    '></div>'
  );
}

function toDateInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function openOpsModal({ title, fields, initial, submitLabel, onSubmit }) {
  const ov = ensureOpsModal();
  ov.querySelector('#opsModalTitle').textContent = title;
  const alert = ov.querySelector('#opsModalAlert');
  alert.hidden = true;
  alert.textContent = '';
  const grid = ov.querySelector('#opsFormGrid');
  grid.innerHTML = fields.map((f) => fieldHtml(f, initial ? initial[f.key] : '')).join('');
  ov.querySelector('#opsFormSubmit').textContent = submitLabel || 'Save';
  const form = ov.querySelector('#opsForm');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {};
    for (const f of fields) {
      const el = grid.querySelector('[data-ops-key="' + f.key + '"]');
      if (!el) continue;
      const raw = el.value;
      if (f.type === 'number') {
        if (raw.trim() !== '') body[f.key] = Number(raw);
        else if (f.sendNullWhenEmpty) body[f.key] = null;
      } else if (f.type === 'date') {
        body[f.key] = raw ? new Date(raw + 'T00:00:00.000Z').toISOString() : null;
      } else if (f.type === 'steps') {
        const lines = raw
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        const prev = new Map(
          ((initial && initial._steps) || []).map((s) => [String(s.label || ''), !!s.done]),
        );
        body[f.key] = lines.map((label) => ({ label, done: prev.get(label) || false }));
      } else if (f.type === 'select') {
        body[f.key] = raw === '' ? null : raw;
      } else {
        const t = raw.trim();
        body[f.key] = t === '' ? null : t;
      }
    }
    try {
      await onSubmit(body);
      ov.hidden = true;
    } catch (err) {
      alert.textContent = describeError(err);
      alert.hidden = false;
    }
  };
  ov.hidden = false;
  const first = grid.querySelector('input, select');
  if (first) first.focus();
}

function setBanner(id, msg, isOk) {
  const el = $(id);
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.textContent = msg;
  el.hidden = false;
  if (isOk) el.classList.add('olive');
  else el.classList.remove('olive');
}

// ====================== facility badge ======================

export async function refreshFacilitiesOps() {
  await Promise.all([
    bindMaintenance().catch(() => {}),
    bindIncidents().catch(() => {}),
    bindInspections().catch(() => {}),
  ]);
  await updateFacilityBadge().catch(() => {});
}

export async function updateFacilityBadge() {
  try {
    const [orders, incidents, certs] = await Promise.all([
      get('/work-orders').catch(() => []),
      get('/incidents').catch(() => []),
      get('/inspections/certificates?expiring=1').catch(() => []),
    ]);
    const open = (orders || []).filter((w) => w.status !== 'DONE').length;
    const active = (incidents || []).filter((i) => i.status === 'OPEN' || i.status === 'IN_PROGRESS').length;
    const expiring = (certs || []).length;
    const badge = $('#facilityBadge');
    if (badge) badge.textContent = open + active + expiring;
  } catch (e) {
    /* badge is best-effort */
  }
}

// ====================== MAINTENANCE ======================

const WO_NEXT = { OPEN: 'IN_PROGRESS', IN_PROGRESS: 'DONE' };

export async function bindMaintenance() {
  const statusFilter = $('#workOrderStatusFilter') ? $('#workOrderStatusFilter').value : '';
  try {
    const [orders, tasks, progress] = await Promise.all([
      get('/work-orders' + (statusFilter ? '?status=' + encodeURIComponent(statusFilter) : '')),
      get('/preventive-tasks'),
      get('/preventive-tasks/progress'),
    ]);
    renderWorkOrders(orders || []);
    renderPreventive(tasks || [], progress || []);
    const sub = $('#workOrdersSub');
    if (sub) sub.textContent = (orders || []).length + ' work order(s)' + (statusFilter ? ' · ' + statusFilter : '');
  } catch (e) {
    setBanner('#workOrdersBanner', 'Work orders: ' + describeError(e));
  }
}

function renderWorkOrders(rows) {
  lastWorkOrders = rows;
  const stats = $('#maintStats');
  if (stats) {
    const open = rows.filter((w) => w.status === 'OPEN').length;
    const prog = rows.filter((w) => w.status === 'IN_PROGRESS').length;
    const done = rows.filter((w) => w.status === 'DONE').length;
    const value = rows
      .filter((w) => w.status !== 'DONE')
      .reduce((s, w) => s + (Number(w.value) || 0), 0);
    stats.innerHTML =
      '<div class="stat"><div class="label">Open</div><div class="val">' + open + '</div></div>' +
      '<div class="stat"><div class="label">In progress</div><div class="val">' + prog + '</div></div>' +
      '<div class="stat"><div class="label">Done</div><div class="val">' + done + '</div></div>' +
      '<div class="stat"><div class="label">Open job value</div><div class="val">' + fmtMoney(value) + '</div></div>' +
      '<div class="stat"><div class="label">Total orders</div><div class="val">' + rows.length + '</div></div>';
  }
  const tb = $('#workOrdersBody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="8"><div class="section-empty">No work orders yet.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows
    .map((w) => {
      const next = WO_NEXT[w.status];
      return (
        '<tr><td><b>' +
        escapeHtml(w.title) +
        '</b></td><td>' +
        escapeHtml(w.branchCode || '—') +
        (w.unitCode ? ' · ' + escapeHtml(w.unitCode) : '') +
        '</td><td><span class="pill ' +
        pillFor(w.status, WO_PILL) +
        '">' +
        escapeHtml(w.status.replace('_', ' ')) +
        '</span></td><td>' +
        escapeHtml(w.priority || '—') +
        '</td><td><b>' +
        fmtMoney(w.value) +
        '</b></td><td>' +
        escapeHtml(w.assignee || '—') +
        '</td><td>' +
        fmtDay(w.dueDate) +
        '</td><td class="unit-actions">' +
        (next ? '<button class="act-btn primary" data-wo-act="advance" data-wo-id="' + escapeHtml(w.id) + '">→ ' + escapeHtml(next.replace('_', ' ')) + '</button> ' : '') +
        '<button class="act-btn" data-wo-act="edit" data-wo-id="' + escapeHtml(w.id) + '">Edit</button> ' +
        '<button class="act-btn danger" data-wo-act="delete" data-wo-id="' + escapeHtml(w.id) + '">Delete</button></td></tr>'
      );
    })
    .join('');
}

function renderPreventive(tasks, progress) {
  const wrap = $('#preventiveProgress');
  if (wrap) {
    wrap.innerHTML = (progress || [])
      .map(
        (p) =>
          '<div class="source-row"><b>' +
          escapeHtml(p.category) +
          '</b><div class="bar"><i style="width:' +
          (p.percentComplete || 0) +
          '%"></i></div><span>' +
          (p.percentComplete || 0) +
          '% · ' +
          p.tasks +
          '</span></div>',
      )
      .join('') || '<div class="section-empty">No preventive tasks yet.</div>';
  }
  const tb = $('#preventiveBody');
  if (!tb) return;
  if (!tasks.length) {
    tb.innerHTML = '<tr><td colspan="6"><div class="section-empty">No preventive tasks yet.</div></td></tr>';
    return;
  }
  tb.innerHTML = tasks
    .map(
      (t) =>
        '<tr><td><b>' +
        escapeHtml(t.title) +
        '</b></td><td><span class="pill blue">' +
        escapeHtml(t.category) +
        '</span></td><td>' +
        escapeHtml(t.branchCode || '—') +
        '</td><td><b>' +
        (t.percentComplete || 0) +
        '%</b></td><td>' +
        fmtDay(t.dueDate) +
        '</td><td class="unit-actions"><button class="act-btn" data-pv-act="edit" data-pv-id="' +
        escapeHtml(t.id) +
        '">Edit</button> <button class="act-btn danger" data-pv-act="delete" data-pv-id="' +
        escapeHtml(t.id) +
        '">Delete</button></td></tr>',
    )
    .join('');
}

async function openWorkOrderForm(existing, preset) {
  const units = await loadUnitsCache();
  const branchId = existing ? existing.branchId : preset?.branchId ?? null;
  const branchOpts = branchOptions(branchId);
  openOpsModal({
    title: existing ? 'Edit Work Order — ' + existing.title : 'New Work Order',
    submitLabel: existing ? 'Save Changes' : 'Create Order',
    initial: existing
      ? {
          title: existing.title,
          description: existing.description || '',
          priority: existing.priority || '',
          value: existing.value != null ? String(existing.value) : '',
          assignee: existing.assignee || '',
          dueDate: toDateInputValue(existing.dueDate),
        }
      : { title: '', description: '', value: '' },
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, full: true },
      { key: 'description', label: 'Description', type: 'text', full: true },
      { key: 'branchId', label: 'Facility', type: 'select', optionsHtml: branchOpts },
      { key: 'unitId', label: 'Unit', type: 'select', optionsHtml: unitOptions(units, existing ? existing.unitId : null, branchId) },
      { key: 'status', label: 'Status', type: 'select', optionsHtml: ['OPEN', 'IN_PROGRESS', 'DONE'].map((s) => '<option value="' + s + '"' + (existing && existing.status === s ? ' selected' : '') + '>' + s.replace('_', ' ') + '</option>').join('') },
      { key: 'priority', label: 'Priority', type: 'select', optionsHtml: ['<option value="">—</option>', 'Low', 'Medium', 'High'].map((p) => (p.startsWith('<') ? p : '<option value="' + p + '"' + (existing && existing.priority === p ? ' selected' : '') + '>' + p + '</option>')).join('') },
      { key: 'value', label: 'Value ($)', type: 'number' },
      { key: 'assignee', label: 'Assignee', type: 'text' },
      { key: 'dueDate', label: 'Due Date', type: 'date' },
    ],
    onSubmit: async (body) => {
      if (!body.title) throw new Error('Title is required');
      if (body.value !== undefined && body.value !== null && !(body.value >= 0)) throw new Error('Value must be 0 or greater');
      if (existing) {
        await patch('/work-orders/' + encodeURIComponent(existing.id), body);
        setBanner('#workOrdersBanner', 'Updated ' + body.title, true);
      } else {
        await post('/work-orders', body);
        setBanner('#workOrdersBanner', 'Created ' + body.title, true);
      }
      await bindMaintenance();
      await updateFacilityBadge();
    },
  });
}

async function openPreventiveForm(existing) {
  openOpsModal({
    title: existing ? 'Edit Task — ' + existing.title : 'New Preventive Task',
    submitLabel: existing ? 'Save Changes' : 'Create Task',
    initial: existing
      ? { title: existing.title, dueDate: toDateInputValue(existing.dueDate), percentComplete: String(existing.percentComplete || 0) }
      : { title: '', percentComplete: '0' },
    fields: [
      { key: 'title', label: 'Task', type: 'text', required: true, full: true },
      { key: 'category', label: 'Category', type: 'select', optionsHtml: ['HVAC', 'FIRE', 'DOORS', 'CCTV'].map((c) => '<option value="' + c + '"' + (existing && existing.category === c ? ' selected' : '') + '>' + c + '</option>').join('') },
      { key: 'branchId', label: 'Facility', type: 'select', optionsHtml: branchOptions(existing ? existing.branchId : null) },
      { key: 'percentComplete', label: '% Complete', type: 'number' },
      { key: 'dueDate', label: 'Due Date', type: 'date' },
    ],
    onSubmit: async (body) => {
      if (!body.title) throw new Error('Task title is required');
      const pct = body.percentComplete == null ? 0 : Number(body.percentComplete);
      if (!(pct >= 0 && pct <= 100)) throw new Error('% Complete must be 0..100');
      body.percentComplete = pct;
      if (existing) await patch('/preventive-tasks/' + encodeURIComponent(existing.id), body);
      else await post('/preventive-tasks', body);
      await bindMaintenance();
    },
  });
}

// ====================== ASSETS & VENDORS ======================

export async function bindAssets() {
  try {
    const [assets, vendors] = await Promise.all([get('/assets'), get('/vendors')]);
    renderAssets(assets || []);
    renderVendors(vendors || []);
    const sub = $('#assetsSub');
    if (sub) sub.textContent = (assets || []).length + ' asset(s) · ' + (vendors || []).length + ' vendor(s)';
  } catch (e) {
    setBanner('#assetsBanner', 'Assets: ' + describeError(e));
  }
}

function renderAssets(rows) {
  const tb = $('#assetsBody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7"><div class="section-empty">No assets registered yet.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows
    .map(
      (a) =>
        '<tr><td><b>' +
        escapeHtml(a.code) +
        '</b></td><td>' +
        escapeHtml(a.name) +
        '</td><td>' +
        escapeHtml(a.category) +
        '</td><td>' +
        escapeHtml(a.branchCode || '—') +
        '</td><td><span class="pill ' +
        (a.status === 'ACTIVE' ? 'green' : a.status === 'RETIRED' ? '' : 'amber') +
        '">' +
        escapeHtml(a.status.replace('_', ' ')) +
        '</span></td><td><b>' +
        (a.value == null ? '—' : fmtMoney(a.value)) +
        '</b></td><td class="unit-actions"><button class="act-btn" data-asset-act="edit" data-asset-id="' +
        escapeHtml(a.id) +
        '">Edit</button> <button class="act-btn danger" data-asset-act="delete" data-asset-id="' +
        escapeHtml(a.id) +
        '">Delete</button></td></tr>',
    )
    .join('');
}

function renderVendors(rows) {
  const tb = $('#vendorsBody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="6"><div class="section-empty">No vendors registered yet.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows
    .map(
      (v) =>
        '<tr><td><b>' +
        escapeHtml(v.name) +
        '</b></td><td>' +
        escapeHtml(v.service || '—') +
        '</td><td>' +
        escapeHtml(v.sla || '—') +
        '</td><td><b>' +
        fmtMoney(v.ytdSpend) +
        '</b></td><td><span class="pill ' +
        (v.status === 'ACTIVE' ? 'green' : '') +
        '">' +
        escapeHtml(v.status) +
        '</span></td><td class="unit-actions"><button class="act-btn" data-vendor-act="edit" data-vendor-id="' +
        escapeHtml(v.id) +
        '">Edit</button> <button class="act-btn danger" data-vendor-act="delete" data-vendor-id="' +
        escapeHtml(v.id) +
        '">Delete</button></td></tr>',
    )
    .join('');
}

function openAssetForm(existing) {
  openOpsModal({
    title: existing ? 'Edit Asset — ' + existing.code : 'New Asset',
    submitLabel: existing ? 'Save Changes' : 'Create Asset',
    initial: existing
      ? { code: existing.code, name: existing.name, category: existing.category, value: existing.value != null ? String(existing.value) : '' }
      : { code: '', name: '', category: 'HVAC', value: '' },
    fields: [
      { key: 'code', label: 'Asset Code (e.g. AST-WDL-HVAC-04)', type: 'text', required: true },
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'category', label: 'Category', type: 'text', required: true },
      { key: 'branchId', label: 'Facility', type: 'select', optionsHtml: branchOptions(existing ? existing.branchId : null) },
      { key: 'status', label: 'Status', type: 'select', optionsHtml: ['ACTIVE', 'IN_SERVICE', 'RETIRED'].map((s) => '<option value="' + s + '"' + (existing && existing.status === s ? ' selected' : '') + '>' + s.replace('_', ' ') + '</option>').join('') },
      { key: 'value', label: 'Value ($)', type: 'number', sendNullWhenEmpty: true },
    ],
    onSubmit: async (body) => {
      if (!body.code || !body.name || !body.category) throw new Error('Code, name and category are required');
      if (existing) {
        const { code, ...rest } = body;
        await patch('/assets/' + encodeURIComponent(existing.id), rest);
      } else {
        await post('/assets', body);
      }
      await bindAssets();
    },
  });
}

function openVendorForm(existing) {
  openOpsModal({
    title: existing ? 'Edit Vendor — ' + existing.name : 'New Vendor',
    submitLabel: existing ? 'Save Changes' : 'Create Vendor',
    initial: existing
      ? { name: existing.name, service: existing.service || '', sla: existing.sla || '', ytdSpend: String(existing.ytdSpend || 0), contact: existing.contact || '' }
      : { name: '', service: '', sla: '', ytdSpend: '0', contact: '' },
    fields: [
      { key: 'name', label: 'Vendor', type: 'text', required: true, full: true },
      { key: 'service', label: 'Service', type: 'text' },
      { key: 'sla', label: 'SLA (e.g. 4h response)', type: 'text' },
      { key: 'ytdSpend', label: 'YTD Spend ($)', type: 'number' },
      { key: 'status', label: 'Status', type: 'select', optionsHtml: ['ACTIVE', 'INACTIVE'].map((s) => '<option value="' + s + '"' + (existing && existing.status === s ? ' selected' : '') + '>' + s + '</option>').join('') },
      { key: 'contact', label: 'Contact', type: 'text' },
    ],
    onSubmit: async (body) => {
      if (!body.name) throw new Error('Vendor name is required');
      if (body.ytdSpend != null && !(body.ytdSpend >= 0)) throw new Error('YTD spend must be 0 or greater');
      if (existing) await patch('/vendors/' + encodeURIComponent(existing.id), body);
      else await post('/vendors', body);
      await bindAssets();
    },
  });
}

// ====================== INCIDENTS ======================

const INC_NEXT = { OPEN: 'IN_PROGRESS', IN_PROGRESS: 'RESOLVED', RESOLVED: 'CLOSED' };

export async function bindIncidents() {
  const sev = $('#incidentSeverityFilter') ? $('#incidentSeverityFilter').value : '';
  const st = $('#incidentStatusFilter') ? $('#incidentStatusFilter').value : '';
  try {
    const q = [];
    if (sev) q.push('severity=' + encodeURIComponent(sev));
    if (st) q.push('status=' + encodeURIComponent(st));
    const rows = await get('/incidents' + (q.length ? '?' + q.join('&') : ''));
    renderIncidents(rows || []);
    const sub = $('#incidentsSub');
    if (sub) sub.textContent = (rows || []).length + ' incident(s)';
  } catch (e) {
    setBanner('#incidentsBanner', 'Incidents: ' + describeError(e));
  }
}

function renderIncidents(rows) {
  const stats = $('#incidentStats');
  if (stats) {
    const open = rows.filter((i) => i.status === 'OPEN').length;
    const crit = rows.filter((i) => i.severity === 'CRITICAL' && i.status !== 'CLOSED').length;
    const prog = rows.filter((i) => i.status === 'IN_PROGRESS').length;
    const resolved = rows.filter((i) => i.status === 'RESOLVED' || i.status === 'CLOSED').length;
    stats.innerHTML =
      '<div class="stat"><div class="label">Open</div><div class="val">' + open + '</div></div>' +
      '<div class="stat"><div class="label">Critical (active)</div><div class="val">' + crit + '</div></div>' +
      '<div class="stat"><div class="label">In progress</div><div class="val">' + prog + '</div></div>' +
      '<div class="stat"><div class="label">Resolved / closed</div><div class="val">' + resolved + '</div></div>' +
      '<div class="stat"><div class="label">Total</div><div class="val">' + rows.length + '</div></div>';
  }
  const tb = $('#incidentsBody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7"><div class="section-empty">No incidents reported.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows
    .map((i) => {
      const next = INC_NEXT[i.status];
      const steps = Array.isArray(i.checklist) ? i.checklist : [];
      return (
        '<tr><td><b>' +
        escapeHtml(i.title) +
        '</b></td><td><span class="pill ' +
        pillFor(i.severity, INC_SEV_PILL) +
        '">' +
        escapeHtml(i.severity) +
        '</span></td><td><span class="pill ' +
        pillFor(i.status, INC_STATUS_PILL) +
        '">' +
        escapeHtml(i.status.replace('_', ' ')) +
        '</span></td><td>' +
        escapeHtml(i.branchCode || '—') +
        (i.unitCode ? ' · ' + escapeHtml(i.unitCode) : '') +
        '</td><td>' +
        (steps.length ? '<b>' + (i.checklistProgress || 0) + '%</b> <small>(' + steps.filter((s) => s.done).length + '/' + steps.length + ')</small>' : '—') +
        '</td><td><small>' +
        escapeHtml(i.reportedBy || '—') +
        ' · ' +
        fmtDay(i.createdAt) +
        '</small></td><td class="unit-actions">' +
        (next ? '<button class="act-btn primary" data-inc-act="advance" data-inc-id="' + escapeHtml(i.id) + '">→ ' + escapeHtml(next.replace('_', ' ')) + '</button> ' : '') +
        '<button class="act-btn" data-inc-act="edit" data-inc-id="' + escapeHtml(i.id) + '">Edit</button> ' +
        '<button class="act-btn danger" data-inc-act="delete" data-inc-id="' + escapeHtml(i.id) + '">Delete</button></td></tr>'
      );
    })
    .join('');
}

function stepsToText(checklist) {
  if (!Array.isArray(checklist)) return '';
  return checklist.map((s) => (s.done ? '[x] ' : '') + (s.label || '')).join('\n');
}

function textToSteps(raw, prev) {
  const prevMap = new Map(((prev && Array.isArray(prev) ? prev : [])).map((s) => [String(s.label || ''), !!s.done]));
  return String(raw || '')
    .split('\n')
    .map((s) => s.trim().replace(/^\[x\]\s*/i, ''))
    .filter(Boolean)
    .map((label) => ({ label, done: prevMap.get(label) || false }));
}

async function openIncidentForm(existing) {
  const units = await loadUnitsCache();
  openOpsModal({
    title: existing ? 'Edit Incident — ' + existing.title : 'New Incident',
    submitLabel: existing ? 'Save Changes' : 'Report Incident',
    initial: existing
      ? { title: existing.title, description: existing.description || '', reportedBy: existing.reportedBy || '', checklist: stepsToText(existing.checklist), _steps: existing.checklist }
      : { title: '', description: '', reportedBy: '', checklist: '' },
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, full: true },
      { key: 'description', label: 'Description', type: 'text', full: true },
      { key: 'severity', label: 'Severity', type: 'select', optionsHtml: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s) => '<option value="' + s + '"' + (existing && existing.severity === s ? ' selected' : '') + '>' + s + '</option>').join('') },
      { key: 'status', label: 'Status', type: 'select', optionsHtml: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].map((s) => '<option value="' + s + '"' + (existing && existing.status === s ? ' selected' : '') + '>' + s.replace('_', ' ') + '</option>').join('') },
      { key: 'branchId', label: 'Facility', type: 'select', optionsHtml: branchOptions(existing ? existing.branchId : null) },
      { key: 'unitId', label: 'Unit', type: 'select', optionsHtml: unitOptions(units, existing ? existing.unitId : null, existing ? existing.branchId : null) },
      { key: 'reportedBy', label: 'Reported By', type: 'text' },
      { key: 'checklist', label: 'Checklist Steps (one per line)', type: 'steps', full: true, placeholder: 'Isolate area\nNotify manager\nLog photos' },
    ],
    onSubmit: async (body) => {
      if (!body.title) throw new Error('Title is required');
      const { _steps, ...rest } = body;
      rest.checklist = textToSteps(body.checklist, existing ? existing.checklist : []);
      delete rest.checklist_raw;
      if (existing) await patch('/incidents/' + encodeURIComponent(existing.id), rest);
      else await post('/incidents', rest);
      await bindIncidents();
      await updateFacilityBadge();
    },
  });
}

// ====================== ACCESS CONTROL ======================

export async function bindAccess() {
  try {
    const [stats, live, creds, temp, denied, policies, doors] = await Promise.all([
      get('/access/stats'),
      get('/access/events?limit=30'),
      get('/access/credentials'),
      get('/access/credentials?temporary=1'),
      get('/access/events?result=DENIED&limit=30'),
      get('/access/policies'),
      get('/access/doors'),
    ]);
    const set = (id, v) => {
      const el = $(id);
      if (el) el.textContent = v;
    };
    if (stats) {
      set('#accessStatEntries', stats.entries);
      set('#accessStatCreds', stats.credentials);
      set('#accessStatDoors', stats.doors);
      set('#accessStatDenied', stats.denied);
      set('#accessStatTemp', stats.temporary);
    }
    renderAccessEvents(live || [], '#accessEventsBody', 5);
    renderCredentials(creds || [], '#credentialsBody', true);
    renderCredentials(temp || [], '#temporaryBody', true);
    renderAccessEvents(denied || [], '#exceptionsBody', 5, true);
    renderPolicies(policies || []);
    renderDoors(doors || []);
  } catch (e) {
    setBanner('#accessEventsBanner', 'Access: ' + describeError(e));
  }
}

function renderAccessEvents(rows, sel, cols, withNote) {
  const tb = $(sel);
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="' + cols + '"><div class="section-empty">No events logged.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows
    .map(
      (e) =>
        '<tr><td><small>' +
        fmtDay(e.occurredAt) +
        '</small></td><td><b>' +
        escapeHtml(e.doorCode || e.doorName || '—') +
        '</b></td><td>' +
        (withNote ? escapeHtml(e.holderName || 'Unknown') : escapeHtml(e.holderName || '—')) +
        '</td>' +
        (withNote
          ? '<td>' + escapeHtml(e.branchCode || '—') + '</td><td>' + escapeHtml(e.note || '—') + '</td>'
          : '<td><span class="pill ' +
            (e.result === 'DENIED' ? 'red' : 'green') +
            '">' +
            escapeHtml(e.result) +
            '</span></td><td>' +
            escapeHtml(e.branchCode || '—') +
            '</td>') +
        '</tr>',
    )
    .join('');
}

function renderCredentials(rows, sel, withActions) {
  const tb = $(sel);
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="6"><div class="section-empty">No credentials yet.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows
    .map(
      (c) =>
        '<tr><td><b>' +
        escapeHtml(c.holderName) +
        '</b></td><td>' +
        escapeHtml(c.type) +
        '</td><td><span class="pill ' +
        (c.status === 'ACTIVE' ? 'green' : c.status === 'REVOKED' ? 'red' : 'amber') +
        '">' +
        escapeHtml(c.status) +
        '</span></td><td>' +
        fmtDay(c.validTo) +
        '</td>' +
        (sel === '#temporaryBody'
          ? '<td>' + (c.expired ? '<span class="pill red">Expired</span>' : '<span class="pill green">Valid</span>') + '</td>'
          : '<td>' + escapeHtml(c.branchCode || '—') + '</td>') +
        (withActions
          ? '<td class="unit-actions"><button class="act-btn" data-cred-act="edit" data-cred-id="' +
            escapeHtml(c.id) +
            '">Edit</button> <button class="act-btn danger" data-cred-act="revoke" data-cred-id="' +
            escapeHtml(c.id) +
            '">Revoke</button></td>'
          : '') +
        '</tr>',
    )
    .join('');
}

function renderPolicies(rows) {
  const tb = $('#policiesBody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="4"><div class="section-empty">No policies yet.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows
    .map(
      (p) =>
        '<tr><td><b>' +
        escapeHtml(p.name) +
        '</b><div class="t-type">' +
        escapeHtml(p.description || '') +
        '</div></td><td>' +
        escapeHtml(p.scope || '—') +
        '</td><td>' +
        (p.active ? '<span class="pill green">Active</span>' : '<span class="pill">Off</span>') +
        '</td><td class="unit-actions"><button class="act-btn" data-pol-act="edit" data-pol-id="' +
        escapeHtml(p.id) +
        '">Edit</button> <button class="act-btn danger" data-pol-act="delete" data-pol-id="' +
        escapeHtml(p.id) +
        '">Delete</button></td></tr>',
    )
    .join('');
}

function renderDoors(rows) {
  const tb = $('#doorsBody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="5"><div class="section-empty">No doors yet.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows
    .map(
      (d) =>
        '<tr><td><b>' +
        escapeHtml(d.code) +
        '</b></td><td>' +
        escapeHtml(d.name) +
        '</td><td>' +
        escapeHtml(d.branchCode || '—') +
        '</td><td><span class="pill ' +
        (d.status === 'ACTIVE' ? 'green' : '') +
        '">' +
        escapeHtml(d.status) +
        '</span></td><td class="unit-actions"><button class="act-btn" data-door-act="edit" data-door-id="' +
        escapeHtml(d.id) +
        '">Edit</button> <button class="act-btn danger" data-door-act="delete" data-door-id="' +
        escapeHtml(d.id) +
        '">Delete</button></td></tr>',
    )
    .join('');
}

function openCredentialForm(existing) {
  openOpsModal({
    title: existing ? 'Edit Credential — ' + existing.holderName : 'New Credential',
    submitLabel: existing ? 'Save Changes' : 'Create Credential',
    initial: existing
      ? { holderName: existing.holderName, validFrom: toDateInputValue(existing.validFrom), validTo: toDateInputValue(existing.validTo) }
      : { holderName: '', validFrom: '', validTo: '' },
    fields: [
      { key: 'holderName', label: 'Holder Name', type: 'text', required: true, full: true },
      { key: 'type', label: 'Type', type: 'select', optionsHtml: ['PERMANENT', 'TEMPORARY', 'VISITOR'].map((t) => '<option value="' + t + '"' + (existing && existing.type === t ? ' selected' : '') + '>' + t + '</option>').join('') },
      { key: 'status', label: 'Status', type: 'select', optionsHtml: ['ACTIVE', 'REVOKED', 'EXPIRED'].map((s) => '<option value="' + s + '"' + (existing && existing.status === s ? ' selected' : '') + '>' + s + '</option>').join('') },
      { key: 'branchId', label: 'Facility', type: 'select', optionsHtml: branchOptions(existing ? existing.branchId : null) },
      { key: 'validFrom', label: 'Valid From', type: 'date' },
      { key: 'validTo', label: 'Valid To (temporary)', type: 'date' },
    ],
    onSubmit: async (body) => {
      if (!body.holderName) throw new Error('Holder name is required');
      if (existing) await patch('/access/credentials/' + encodeURIComponent(existing.id), body);
      else await post('/access/credentials', body);
      await bindAccess();
    },
  });
}

function openPolicyForm(existing) {
  openOpsModal({
    title: existing ? 'Edit Policy — ' + existing.name : 'New Policy',
    submitLabel: existing ? 'Save Changes' : 'Create Policy',
    initial: existing ? { name: existing.name, description: existing.description || '', scope: existing.scope || '' } : { name: '', description: '', scope: '' },
    fields: [
      { key: 'name', label: 'Policy Name', type: 'text', required: true, full: true },
      { key: 'description', label: 'Description', type: 'text', full: true },
      { key: 'scope', label: 'Scope (e.g. WD · all doors)', type: 'text', full: true },
      { key: 'active', label: 'Active', type: 'select', optionsHtml: '<option value="yes"' + (!existing || existing.active ? ' selected' : '') + '>Yes</option><option value="no"' + (existing && !existing.active ? ' selected' : '') + '>No</option>' },
    ],
    onSubmit: async (body) => {
      if (!body.name) throw new Error('Policy name is required');
      body.active = body.active !== 'no';
      if (existing) await patch('/access/policies/' + encodeURIComponent(existing.id), body);
      else await post('/access/policies', body);
      await bindAccess();
    },
  });
}

function openDoorForm(existing) {
  openOpsModal({
    title: existing ? 'Edit Door — ' + existing.code : 'New Door',
    submitLabel: existing ? 'Save Changes' : 'Create Door',
    initial: existing ? { code: existing.code, name: existing.name, location: existing.location || '' } : { code: '', name: '', location: '' },
    fields: [
      { key: 'code', label: 'Door Code (e.g. WDL-GATE-01)', type: 'text', required: true },
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'branchId', label: 'Facility', type: 'select', optionsHtml: branchOptions(existing ? existing.branchId : null) },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'status', label: 'Status', type: 'select', optionsHtml: ['ACTIVE', 'INACTIVE'].map((s) => '<option value="' + s + '"' + (existing && existing.status === s ? ' selected' : '') + '>' + s + '</option>').join('') },
    ],
    onSubmit: async (body) => {
      if (!body.code || !body.name) throw new Error('Code and name are required');
      if (existing) {
        const { code, ...rest } = body;
        await patch('/access/doors/' + encodeURIComponent(existing.id), rest);
      } else {
        await post('/access/doors', body);
      }
      await bindAccess();
    },
  });
}

async function openAccessEventForm() {
  let doors = [];
  let creds = [];
  try {
    doors = (await get('/access/doors')) || [];
    creds = (await get('/access/credentials')) || [];
  } catch (e) {
    /* selects fall back to empty */
  }
  openOpsModal({
    title: 'Log Access Event',
    submitLabel: 'Log Event',
    initial: { note: '' },
    fields: [
      { key: 'doorId', label: 'Door', type: 'select', optionsHtml: '<option value="">—</option>' + doors.map((d) => '<option value="' + escapeHtml(d.id) + '">' + escapeHtml(d.code) + ' · ' + escapeHtml(d.name) + '</option>').join('') },
      { key: 'credentialId', label: 'Credential', type: 'select', optionsHtml: '<option value="">—</option>' + creds.map((c) => '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.holderName) + ' (' + escapeHtml(c.type) + ')</option>').join('') },
      { key: 'result', label: 'Result', type: 'select', optionsHtml: '<option value="GRANTED">GRANTED</option><option value="DENIED">DENIED</option>' },
      { key: 'note', label: 'Note', type: 'text', full: true },
    ],
    onSubmit: async (body) => {
      await post('/access/events', body);
      await bindAccess();
    },
  });
}

// ====================== INSPECTIONS ======================

export async function bindInspections() {
  const freq = $('#checklistFreqFilter') ? $('#checklistFreqFilter').value : '';
  try {
    const [lists, certs] = await Promise.all([
      get('/inspections/checklists' + (freq ? '?frequency=' + encodeURIComponent(freq) : '')),
      get('/inspections/certificates'),
    ]);
    renderChecklists(lists || []);
    renderCertificates(certs || []);
    const sub = $('#checklistsSub');
    if (sub) sub.textContent = (lists || []).length + ' checklist(s) · ' + (certs || []).length + ' certificate(s)';
  } catch (e) {
    setBanner('#checklistsBanner', 'Inspections: ' + describeError(e));
  }
}

function renderChecklists(rows) {
  const stats = $('#inspectionStats');
  if (stats) {
    const open = rows.filter((c) => c.status !== 'DONE').length;
    stats.innerHTML =
      '<div class="stat"><div class="label">Open checklists</div><div class="val">' + open + '</div></div>' +
      '<div class="stat"><div class="label">Done</div><div class="val">' + (rows.length - open) + '</div></div>' +
      '<div class="stat"><div class="label">Total</div><div class="val">' + rows.length + '</div></div>' +
      '<div class="stat"><div class="label">Certificates expiring</div><div class="val" id="inspExpiringStat">—</div></div>' +
      '<div class="stat"><div class="label">Certificates expired</div><div class="val" id="inspExpiredStat">—</div></div>';
  }
  const tb = $('#checklistsBody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7"><div class="section-empty">No checklists yet.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows
    .map(
      (c) =>
        '<tr><td><b>' +
        escapeHtml(c.title) +
        '</b></td><td><span class="pill blue">' +
        escapeHtml(c.frequency) +
        '</span></td><td>' +
        escapeHtml(c.branchCode || '—') +
        '</td><td>' +
        (c.steps || 0) +
        '</td><td><b>' +
        (c.percentComplete || 0) +
        '%</b></td><td><span class="pill ' +
        (c.status === 'DONE' ? 'green' : c.status === 'IN_PROGRESS' ? 'amber' : '') +
        '">' +
        escapeHtml(c.status.replace('_', ' ')) +
        '</span></td><td class="unit-actions"><button class="act-btn" data-chk-act="edit" data-chk-id="' +
        escapeHtml(c.id) +
        '">Edit</button> <button class="act-btn danger" data-chk-act="delete" data-chk-id="' +
        escapeHtml(c.id) +
        '">Delete</button></td></tr>',
    )
    .join('');
}

function renderCertificates(rows) {
  const expiring = rows.filter((c) => c.derivedStatus === 'EXPIRING').length;
  const expired = rows.filter((c) => c.derivedStatus === 'EXPIRED').length;
  const set = (id, v) => {
    const el = $(id);
    if (el) el.textContent = v;
  };
  set('#inspExpiringStat', expiring);
  set('#inspExpiredStat', expired);
  const tb = $('#certificatesBody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="6"><div class="section-empty">No certificates tracked yet.</div></td></tr>';
    return;
  }
  tb.innerHTML = rows
    .map(
      (c) =>
        '<tr><td><b>' +
        escapeHtml(c.name) +
        '</b></td><td>' +
        escapeHtml(c.type) +
        '</td><td>' +
        escapeHtml(c.branchCode || '—') +
        '</td><td>' +
        fmtDay(c.expiryDate) +
        ' <small>(' +
        (c.daysUntilExpiry >= 0 ? c.daysUntilExpiry + 'd left' : Math.abs(c.daysUntilExpiry) + 'd overdue') +
        ')</small></td><td><span class="pill ' +
        pillFor(c.derivedStatus, CERT_PILL) +
        '">' +
        escapeHtml(c.derivedStatus) +
        '</span></td><td class="unit-actions"><button class="act-btn" data-cert-act="edit" data-cert-id="' +
        escapeHtml(c.id) +
        '">Edit</button> <button class="act-btn danger" data-cert-act="delete" data-cert-id="' +
        escapeHtml(c.id) +
        '">Delete</button></td></tr>',
    )
    .join('');
}

function openChecklistForm(existing, preset) {
  openOpsModal({
    title: existing ? 'Edit Checklist — ' + existing.title : 'New Checklist',
    submitLabel: existing ? 'Save Changes' : 'Create Checklist',
    initial: existing
      ? { title: existing.title, checklist: stepsToText(existing.items), _steps: existing.items, percentComplete: String(existing.percentComplete || 0) }
      : { title: '', checklist: '', percentComplete: '0' },
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, full: true },
      { key: 'frequency', label: 'Frequency', type: 'select', optionsHtml: ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL'].map((f) => '<option value="' + f + '"' + (existing && existing.frequency === f ? ' selected' : '') + '>' + f + '</option>').join('') },
      { key: 'branchId', label: 'Facility', type: 'select', optionsHtml: branchOptions(existing ? existing.branchId : preset?.branchId ?? null) },
      { key: 'percentComplete', label: '% Complete', type: 'number' },
      { key: 'status', label: 'Status', type: 'select', optionsHtml: ['OPEN', 'IN_PROGRESS', 'DONE'].map((s) => '<option value="' + s + '"' + (existing && existing.status === s ? ' selected' : '') + '>' + s.replace('_', ' ') + '</option>').join('') },
      { key: 'checklist', label: 'Steps (one per line)', type: 'steps', full: true },
    ],
    onSubmit: async (body) => {
      if (!body.title) throw new Error('Title is required');
      const { _steps, ...rest } = body;
      rest.items = textToSteps(body.checklist, existing ? existing.items : []);
      delete rest.checklist;
      const pct = rest.percentComplete == null ? 0 : Number(rest.percentComplete);
      if (!(pct >= 0 && pct <= 100)) throw new Error('% Complete must be 0..100');
      rest.percentComplete = pct;
      if (existing) await patch('/inspections/checklists/' + encodeURIComponent(existing.id), rest);
      else await post('/inspections/checklists', rest);
      await bindInspections();
    },
  });
}

function openCertificateForm(existing) {
  openOpsModal({
    title: existing ? 'Edit Certificate — ' + existing.name : 'New Certificate',
    submitLabel: existing ? 'Save Changes' : 'Create Certificate',
    initial: existing
      ? { name: existing.name, type: existing.type, issuer: existing.issuer || '', expiryDate: toDateInputValue(existing.expiryDate) }
      : { name: '', type: 'Fire Safety', issuer: '', expiryDate: '' },
    fields: [
      { key: 'name', label: 'Certificate Name', type: 'text', required: true, full: true },
      { key: 'type', label: 'Type', type: 'select', optionsHtml: ['Fire Safety', 'Lift', 'Public Liability', 'Other'].map((t) => '<option value="' + t + '"' + (existing && existing.type === t ? ' selected' : '') + '>' + t + '</option>').join('') },
      { key: 'branchId', label: 'Facility', type: 'select', optionsHtml: branchOptions(existing ? existing.branchId : null) },
      { key: 'issuer', label: 'Issuer', type: 'text' },
      { key: 'expiryDate', label: 'Expiry Date', type: 'date' },
    ],
    onSubmit: async (body) => {
      if (!body.name || !body.type) throw new Error('Name and type are required');
      if (!body.expiryDate) throw new Error('Expiry date is required');
      if (existing) await patch('/inspections/certificates/' + encodeURIComponent(existing.id), body);
      else await post('/inspections/certificates', body);
      await bindInspections();
      await updateFacilityBadge();
    },
  });
}

// P1 item 1: portfolio-card actions — open the existing P0 create forms with
// the card's facility preselected (branchId is the Branch row id).
export function openWorkOrderForBranch(branchId) {
  return openWorkOrderForm(null, { branchId });
}

export function openChecklistForBranch(branchId) {
  return openChecklistForm(null, { branchId });
}

// ====================== lookups for row actions ======================

let lastWorkOrders = [];
let lastPreventive = [];
let lastAssets = [];
let lastVendors = [];
let lastIncidents = [];
let lastCreds = [];
let lastPolicies = [];
let lastDoors = [];
let lastChecklists = [];
let lastCerts = [];

// ====================== wiring ======================
// Idempotent: safe to call on every facilities visit (re-renders keep working
// via delegation on stable table bodies).

let opsWired = false;

export function wireFacilitiesOps() {
  if (opsWired) return;
  opsWired = true;

  // Row-action delegation (stable tbody ids survive innerHTML re-renders).
  $('#workOrdersBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-wo-act]');
    if (!btn) return;
    const row = lastWorkOrders.find((w) => w.id === btn.dataset.woId);
    if (!row) return;
    if (btn.dataset.woAct === 'advance' && WO_NEXT[row.status]) {
      try {
        await patch('/work-orders/' + encodeURIComponent(row.id), { status: WO_NEXT[row.status] });
        await bindMaintenance();
        await updateFacilityBadge();
      } catch (err) {
        setBanner('#workOrdersBanner', 'Status: ' + describeError(err));
      }
    } else if (btn.dataset.woAct === 'edit') openWorkOrderForm(row);
    else if (btn.dataset.woAct === 'delete') {
      const okConfirm = await confirmDialog({ title: 'Delete work order?', message: row.title, confirmLabel: 'Delete', danger: true });
      if (!okConfirm) return;
      try {
        await del('/work-orders/' + encodeURIComponent(row.id));
        await bindMaintenance();
        await updateFacilityBadge();
      } catch (err) {
        setBanner('#workOrdersBanner', 'Delete: ' + describeError(err));
      }
    }
  });

  $('#preventiveBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-pv-act]');
    if (!btn) return;
    const rows = await get('/preventive-tasks').catch(() => []);
    lastPreventive = rows || [];
    const row = lastPreventive.find((t) => t.id === btn.dataset.pvId);
    if (!row) return;
    if (btn.dataset.pvAct === 'edit') openPreventiveForm(row);
    else if (btn.dataset.pvAct === 'delete') {
      const okConfirm = await confirmDialog({ title: 'Delete task?', message: row.title, confirmLabel: 'Delete', danger: true });
      if (!okConfirm) return;
      try {
        await del('/preventive-tasks/' + encodeURIComponent(row.id));
        await bindMaintenance();
      } catch (err) {
        setBanner('#preventiveBanner', 'Delete: ' + describeError(err));
      }
    }
  });

  $('#assetsBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-asset-act]');
    if (!btn) return;
    const rows = await get('/assets').catch(() => []);
    lastAssets = rows || [];
    const row = lastAssets.find((a) => a.id === btn.dataset.assetId);
    if (!row) return;
    if (btn.dataset.assetAct === 'edit') openAssetForm(row);
    else if (btn.dataset.assetAct === 'delete') {
      const okConfirm = await confirmDialog({ title: 'Delete asset ' + row.code + '?', message: row.name, confirmLabel: 'Delete', danger: true });
      if (!okConfirm) return;
      try {
        await del('/assets/' + encodeURIComponent(row.id));
        await bindAssets();
      } catch (err) {
        setBanner('#assetsBanner', 'Delete: ' + describeError(err));
      }
    }
  });

  $('#vendorsBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-vendor-act]');
    if (!btn) return;
    const rows = await get('/vendors').catch(() => []);
    lastVendors = rows || [];
    const row = lastVendors.find((v) => v.id === btn.dataset.vendorId);
    if (!row) return;
    if (btn.dataset.vendorAct === 'edit') openVendorForm(row);
    else if (btn.dataset.vendorAct === 'delete') {
      const okConfirm = await confirmDialog({ title: 'Delete vendor ' + row.name + '?', message: '', confirmLabel: 'Delete', danger: true });
      if (!okConfirm) return;
      try {
        await del('/vendors/' + encodeURIComponent(row.id));
        await bindAssets();
      } catch (err) {
        setBanner('#vendorsBanner', 'Delete: ' + describeError(err));
      }
    }
  });

  $('#incidentsBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-inc-act]');
    if (!btn) return;
    const sev = $('#incidentSeverityFilter') ? $('#incidentSeverityFilter').value : '';
    const st = $('#incidentStatusFilter') ? $('#incidentStatusFilter').value : '';
    const q = [];
    if (sev) q.push('severity=' + encodeURIComponent(sev));
    if (st) q.push('status=' + encodeURIComponent(st));
    const rows = await get('/incidents' + (q.length ? '?' + q.join('&') : '')).catch(() => []);
    lastIncidents = rows || [];
    const row = lastIncidents.find((i) => i.id === btn.dataset.incId);
    if (!row) return;
    if (btn.dataset.incAct === 'advance' && INC_NEXT[row.status]) {
      try {
        await patch('/incidents/' + encodeURIComponent(row.id), { status: INC_NEXT[row.status] });
        await bindIncidents();
        await updateFacilityBadge();
      } catch (err) {
        setBanner('#incidentsBanner', 'Status: ' + describeError(err));
      }
    } else if (btn.dataset.incAct === 'edit') openIncidentForm(row);
    else if (btn.dataset.incAct === 'delete') {
      const okConfirm = await confirmDialog({ title: 'Delete incident?', message: row.title, confirmLabel: 'Delete', danger: true });
      if (!okConfirm) return;
      try {
        await del('/incidents/' + encodeURIComponent(row.id));
        await bindIncidents();
        await updateFacilityBadge();
      } catch (err) {
        setBanner('#incidentsBanner', 'Delete: ' + describeError(err));
      }
    }
  });

  const credHandler = async (e) => {
    const btn = e.target.closest('button[data-cred-act]');
    if (!btn) return;
    const rows = await get('/access/credentials').catch(() => []);
    lastCreds = rows || [];
    const row = lastCreds.find((c) => c.id === btn.dataset.credId);
    if (!row) return;
    if (btn.dataset.credAct === 'edit') openCredentialForm(row);
    else if (btn.dataset.credAct === 'revoke') {
      const okConfirm = await confirmDialog({ title: 'Revoke credential?', message: row.holderName, confirmLabel: 'Revoke', danger: true });
      if (!okConfirm) return;
      try {
        await patch('/access/credentials/' + encodeURIComponent(row.id), { status: 'REVOKED' });
        await bindAccess();
      } catch (err) {
        setBanner('#credentialsBanner', 'Revoke: ' + describeError(err));
      }
    }
  };
  $('#credentialsBody')?.addEventListener('click', credHandler);
  $('#temporaryBody')?.addEventListener('click', credHandler);

  $('#policiesBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-pol-act]');
    if (!btn) return;
    const rows = await get('/access/policies').catch(() => []);
    lastPolicies = rows || [];
    const row = lastPolicies.find((p) => p.id === btn.dataset.polId);
    if (!row) return;
    if (btn.dataset.polAct === 'edit') openPolicyForm(row);
    else if (btn.dataset.polAct === 'delete') {
      const okConfirm = await confirmDialog({ title: 'Delete policy ' + row.name + '?', message: '', confirmLabel: 'Delete', danger: true });
      if (!okConfirm) return;
      try {
        await del('/access/policies/' + encodeURIComponent(row.id));
        await bindAccess();
      } catch (err) {
        setBanner('#policiesBanner', 'Delete: ' + describeError(err));
      }
    }
  });

  $('#doorsBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-door-act]');
    if (!btn) return;
    const rows = await get('/access/doors').catch(() => []);
    lastDoors = rows || [];
    const row = lastDoors.find((d) => d.id === btn.dataset.doorId);
    if (!row) return;
    if (btn.dataset.doorAct === 'edit') openDoorForm(row);
    else if (btn.dataset.doorAct === 'delete') {
      const okConfirm = await confirmDialog({ title: 'Delete door ' + row.code + '?', message: row.name, confirmLabel: 'Delete', danger: true });
      if (!okConfirm) return;
      try {
        await del('/access/doors/' + encodeURIComponent(row.id));
        await bindAccess();
      } catch (err) {
        setBanner('#doorsBanner', 'Delete: ' + describeError(err));
      }
    }
  });

  $('#checklistsBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-chk-act]');
    if (!btn) return;
    const rows = await get('/inspections/checklists').catch(() => []);
    lastChecklists = rows || [];
    const row = lastChecklists.find((c) => c.id === btn.dataset.chkId);
    if (!row) return;
    if (btn.dataset.chkAct === 'edit') openChecklistForm(row);
    else if (btn.dataset.chkAct === 'delete') {
      const okConfirm = await confirmDialog({ title: 'Delete checklist?', message: row.title, confirmLabel: 'Delete', danger: true });
      if (!okConfirm) return;
      try {
        await del('/inspections/checklists/' + encodeURIComponent(row.id));
        await bindInspections();
      } catch (err) {
        setBanner('#checklistsBanner', 'Delete: ' + describeError(err));
      }
    }
  });

  $('#certificatesBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-cert-act]');
    if (!btn) return;
    const rows = await get('/inspections/certificates').catch(() => []);
    lastCerts = rows || [];
    const row = lastCerts.find((c) => c.id === btn.dataset.certId);
    if (!row) return;
    if (btn.dataset.certAct === 'edit') openCertificateForm(row);
    else if (btn.dataset.certAct === 'delete') {
      const okConfirm = await confirmDialog({ title: 'Delete certificate ' + row.name + '?', message: '', confirmLabel: 'Delete', danger: true });
      if (!okConfirm) return;
      try {
        await del('/inspections/certificates/' + encodeURIComponent(row.id));
        await bindInspections();
        await updateFacilityBadge();
      } catch (err) {
        setBanner('#certificatesBanner', 'Delete: ' + describeError(err));
      }
    }
  });

  // Create buttons.
  $('#addWorkOrderBtn')?.addEventListener('click', () => openWorkOrderForm(null));
  $('#addPreventiveBtn')?.addEventListener('click', () => openPreventiveForm(null));
  $('#addAssetBtn')?.addEventListener('click', () => openAssetForm(null));
  $('#addVendorBtn')?.addEventListener('click', () => openVendorForm(null));
  $('#addIncidentBtn')?.addEventListener('click', () => openIncidentForm(null));
  $('#addCredentialBtn')?.addEventListener('click', () => openCredentialForm(null));
  $('#addPolicyBtn')?.addEventListener('click', () => openPolicyForm(null));
  $('#addDoorBtn')?.addEventListener('click', () => openDoorForm(null));
  $('#addAccessEventBtn')?.addEventListener('click', () => openAccessEventForm());
  $('#addChecklistBtn')?.addEventListener('click', () => openChecklistForm(null));
  $('#addCertificateBtn')?.addEventListener('click', () => openCertificateForm(null));

  // Filters.
  $('#workOrderStatusFilter')?.addEventListener('change', () => bindMaintenance().catch(() => {}));
  $('#incidentSeverityFilter')?.addEventListener('change', () => bindIncidents().catch(() => {}));
  $('#incidentStatusFilter')?.addEventListener('change', () => bindIncidents().catch(() => {}));
  $('#checklistFreqFilter')?.addEventListener('change', () => bindInspections().catch(() => {}));

  // Access sub-tabs (data-tabs="access"): scoped to the access module panels
  // only — the facility-level handler must not hide these.
  $$('[data-tabs="access"] [data-tab]').forEach((b) => {
    b.addEventListener('click', function () {
      $$('[data-tabs="access"] [data-tab]').forEach((x) => x.classList.remove('active'));
      this.classList.add('active');
      $$('#facility-access .module-panel').forEach((p) => {
        p.classList.toggle('active', p.id === this.dataset.tab);
      });
    });
  });
}

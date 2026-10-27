// StoreLah CMS admin UI — Settings extensions (P1 items 5, 6, 7).
// Fees & deposits with per-facility override (GET/POST/DELETE /fees +
// /fees/resolve preview), business-rules section (GET/PUT /business-rules),
// Team & access (Owner only): operators, editable roles, permission audit.
// The 14 scalar settings in #settingsGrid are untouched.

import { $, escapeHtml, showBanner } from './dom.js';
import { get, post, put, patch, del, describeError, getMe } from './api.js';
import { confirmDialog } from './confirmDialog.js';
import { state } from './state.js';

const fmtMoney = (n) => '$' + Number(n || 0).toLocaleString('en-SG', { maximumFractionDigits: 2 });

// ---------- fees & deposits (P1 item 5) ----------

function feeTarget(f) {
  if (f.scope === 'GLOBAL') return 'Global';
  if (f.scope === 'FACILITY') return f.branch ? `${f.branch.name} (${f.branch.code})` : 'Facility?';
  if (f.scope === 'PRODUCT') return (f.size ? `${f.size.name} (${f.size.code})` : 'Size?') + (f.branch ? ` · ${f.branch.code}` : '');
  return f.tenant ? f.tenant.name : 'Tenant?';
}

let tenantsCache = null;
async function getTenantsCache() {
  if (tenantsCache) return tenantsCache;
  try {
    tenantsCache = (await get('/tenants')) || [];
  } catch (e) {
    tenantsCache = [];
  }
  return tenantsCache;
}

function fillSelect(sel, rows, label) {
  if (!sel) return;
  sel.innerHTML = '<option value="">—</option>' + (rows || []).map((r) =>
    `<option value="${escapeHtml(r.id)}">${escapeHtml(label(r))}</option>`).join('');
}

export async function bindFeesSection() {
  const body = $('#feesBody');
  if (!body) return;
  fillSelect($('#ff-branch'), state.branches, (b) => `${b.name} (${b.code})`);
  fillSelect($('#ff-size'), state.sizes, (s) => `${s.name} (${s.code})`);
  fillSelect($('#fr-branch'), state.branches, (b) => `${b.name} (${b.code})`);
  fillSelect($('#fr-size'), state.sizes, (s) => `${s.name} (${s.code})`);
  fillSelect($('#ff-tenant'), await getTenantsCache(), (t) => `${t.name}${t.unit ? ' · ' + t.unit : ''}`);
  try {
    const rows = (await get('/fees')) || [];
    body.innerHTML = rows.length ? rows.map((f) =>
      `<tr><td><b>${escapeHtml(f.key)}</b><div class="t-type">${escapeHtml(f.kind)}</div></td>` +
      `<td><span class="pill ${f.scope === 'GLOBAL' ? 'green' : f.scope === 'EXCEPTION' ? 'red' : 'amber'}">${escapeHtml(f.scope)}</span></td>` +
      `<td>${escapeHtml(feeTarget(f))}</td>` +
      `<td><b>${f.amountKind === 'FLAT' ? fmtMoney(f.amount) : `${f.amount}${f.amountKind === 'PCT' ? '%' : ' ×mo'}`}</b><div class="t-type">${escapeHtml(f.amountKind)}</div></td>` +
      `<td>${f.active ? 'On' : 'Off'}</td>` +
      `<td class="unit-actions"><button class="act-btn danger" data-fee-del="${escapeHtml(f.id)}">Delete</button></td></tr>`,
    ).join('') : '<tr><td colspan="6"><div class="section-empty">No fee rules yet — add a GLOBAL default first.</div></td></tr>';
  } catch (e) {
    body.innerHTML = '<tr><td colspan="6"><div class="section-empty">Fees failed to load: ' + escapeHtml(describeError(e)) + '</div></td></tr>';
  }
}

async function submitFeeForm() {
  const val = (id) => $(id)?.value.trim() || '';
  const body = {
    kind: $('#ff-kind')?.value || 'FEE',
    key: val('#ff-key'),
    scope: $('#ff-scope')?.value || 'GLOBAL',
    amount: Number($('#ff-amount')?.value),
    amountKind: $('#ff-amountKind')?.value || 'FLAT',
  };
  if (!body.key) { showBanner('Fee key is required'); return; }
  if (!(body.amount >= 0)) { showBanner('Amount must be 0 or greater'); return; }
  const branch = val('#ff-branch'); const size = val('#ff-size'); const tenant = val('#ff-tenant');
  if (branch) body.branchId = branch;
  if (size) body.sizeId = size;
  if (tenant) body.tenantId = tenant;
  const note = val('#ff-note');
  if (note) body.note = note;
  try {
    await post('/fees', body);
    showBanner(`Fee rule ${body.key} (${body.scope}) saved`, true);
    await bindFeesSection();
  } catch (e) {
    showBanner('Fee: ' + describeError(e));
  }
}

async function resolvePreview() {
  const out = $('#fr-result');
  const key = $('#fr-key')?.value.trim() || '';
  if (!key) { if (out) out.textContent = 'Enter a fee key to resolve.'; return; }
  const qs = new URLSearchParams({ kind: $('#fr-kind')?.value || 'FEE', key });
  const b = $('#fr-branch')?.value; const s = $('#fr-size')?.value;
  if (b) qs.set('branchId', b);
  if (s) {
    const size = (state.sizes || []).find((x) => x.id === s);
    if (size) qs.set('sizeId', size.id);
  }
  try {
    const r = await get(`/fees/resolve?${qs}`);
    if (out) out.textContent = r ? `Effective: ${r.amountKind === 'FLAT' ? fmtMoney(r.amount) : r.amount + ' ' + r.amountKind} via ${r.matchedScope} rule` : 'No rule covers this key (caller default applies).';
  } catch (e) {
    if (out) out.textContent = 'Resolve: ' + describeError(e);
  }
}

// ---------- business rules (P1 item 7) ----------

// Phase 0 label disambiguation (display-only, keys untouched): the booking.*
// rules read like duplicates of the booking.* checkout scalars, so the visible
// labels/subs spell out the policy-vs-checkout split. Server defs in
// src/core/businessRules.ts are intentionally unchanged (no contract change).
const RULE_DISPLAY = {
  'booking.minStayDays': {
    label: 'Minimum stay (days · policy floor)',
    description: 'Shortest bookable stay, in days. Policy floor — the Max stay cap checkout setting bounds the other end.',
  },
  'booking.holdHours': {
    label: 'Quote hold window (hrs · lead hold)',
    description: 'Hours a quoted unit is held for the lead before release. Lead-hold policy — separate from Min advance notice.',
  },
  'booking.maxUnitsPerCustomer': {
    label: 'Max units per customer (policy cap)',
    description: 'Most active units one customer may hold at once.',
  },
  'booking.requireIDVerification': {
    label: 'Require ID verification (move-in gate)',
    description: 'Block move-in until the tenant identity is verified. Identity gate — separate from Auto-confirm paid bookings.',
  },
  'booking.moveOutNoticeDays': {
    label: 'Move-out notice period (days)',
    description: 'Days of notice a tenant must give before the last day.',
  },
};
const RULE_CAT_TITLES = { booking: 'Booking rules', org: 'Policy' };
const RULE_CAT_SUBS = {
  booking: 'Stay, hold, identity and move-out policy — saved via Save rules',
  org: 'Organisation-wide policy — saved via Save rules',
};

let rulesDraft = {};
let rulesLoaded = false;

function markRulesDirty() {
  const btn = $('#businessRulesSaveBtn');
  const dot = $('#businessRulesDirty');
  if (btn) btn.disabled = false;
  if (dot) dot.classList.add('show');
}

function markRulesClean() {
  const btn = $('#businessRulesSaveBtn');
  const dot = $('#businessRulesDirty');
  if (btn) { btn.disabled = true; btn.textContent = 'Save rules'; }
  if (dot) dot.classList.remove('show');
}

function toggleRuleSwitch(sw) {
  const key = sw.dataset.ruleKey;
  if (!key || !(key in rulesDraft)) return;
  rulesDraft[key] = !rulesDraft[key];
  sw.classList.toggle('on', !!rulesDraft[key]);
  sw.setAttribute('aria-checked', String(!!rulesDraft[key]));
  markRulesDirty();
}

export async function bindBusinessRulesSection() {
  const wrap = $('#businessRulesBody');
  if (!wrap) return;
  try {
    const rows = (await get('/business-rules')) || [];
    rulesDraft = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    rulesLoaded = true;
    const cats = {};
    for (const r of rows) (cats[r.category] = cats[r.category] || []).push(r);
    const order = Object.keys(cats).sort((a, b) =>
      (a === 'booking' ? -1 : b === 'booking' ? 1 : a.localeCompare(b)));
    wrap.innerHTML = order.map((cat) => {
      const list = cats[cat];
      const title = RULE_CAT_TITLES[cat] || cat;
      const sub = RULE_CAT_SUBS[cat] ? ' — ' + RULE_CAT_SUBS[cat] : '';
      return `<div class="rules-cat t-type">${escapeHtml(title)}${escapeHtml(sub)}</div>` +
        list.map((r) => {
          const disp = RULE_DISPLAY[r.key] || {};
          const label = disp.label || r.label;
          const desc = disp.description || r.description;
          const ctl = r.kind === 'boolean'
            ? `<span class="sw${rulesDraft[r.key] ? ' on' : ''}" data-rule-key="${escapeHtml(r.key)}" role="switch" aria-checked="${!!rulesDraft[r.key]}" aria-label="${escapeHtml(label)}" tabindex="0"><i></i></span>`
            : r.kind === 'number'
              ? `<input type="number" class="set-input num" data-rule-key="${escapeHtml(r.key)}" aria-label="${escapeHtml(label)}" value="${escapeHtml(String(rulesDraft[r.key] ?? ''))}">`
              : `<input type="text" class="set-input" data-rule-key="${escapeHtml(r.key)}" aria-label="${escapeHtml(label)}" value="${escapeHtml(String(rulesDraft[r.key] ?? ''))}" maxlength="120">`;
          return `<div class="set-row"><div><b>${escapeHtml(label)}</b><small>${escapeHtml(desc)}${r.customized ? '' : ' · default'}</small></div><div class="set-ctl">${ctl}</div></div>`;
        }).join('');
    }).join('');
    markRulesClean();
  } catch (e) {
    wrap.innerHTML = '<div class="section-empty">Business rules failed to load: ' + escapeHtml(describeError(e)) + '</div>';
  }
}

async function saveBusinessRules() {
  if (!rulesLoaded) return;
  const btn = $('#businessRulesSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const saved = await put('/business-rules', rulesDraft);
    rulesDraft = Object.fromEntries((saved || []).map((r) => [r.key, r.value]));
    showBanner('Business rules saved', true);
    await bindBusinessRulesSection();
  } catch (e) {
    showBanner('Business rules: ' + describeError(e));
    if (btn) btn.textContent = 'Save rules';
    markRulesDirty();
  }
}

// ---------- team & access: operators, roles, audit (CMS RBAC; Owner only) ----------

const ACTION_COLS = [['view', 'View'], ['create', 'Create'], ['edit', 'Edit'], ['delete', 'Delete'], ['approve', 'Approve']];
const actionKey = (a) => (a === 'edit' ? 'update' : a);
let usersCache = [];
let rolesCache = [];
let catalog = null; // { resources: [{ key, label, group, actions }] }
let selectedRoleId = null; // null + creatingRole = new role draft
let creatingRole = false;

export async function bindUsersSection() {
  if (!getMe()?.isOwner) return; // Team & access is Owner-only (tab hidden too)
  const body = $('#usersBody');
  if (!body) return;
  try {
    [usersCache, rolesCache, catalog] = await Promise.all([get('/users'), get('/roles'), get('/roles/catalog')]);
    renderUsers();
    renderRoleSelect();
    renderRoles();
  } catch (e) {
    body.innerHTML = '<tr><td colspan="4"><div class="section-empty">Team failed to load: ' + escapeHtml(describeError(e)) + '</div></td></tr>';
  }
  bindAudit().catch(() => {});
}

async function reloadTeam() {
  [usersCache, rolesCache] = await Promise.all([get('/users'), get('/roles')]);
  renderUsers();
  renderRoleSelect();
  renderRoles();
  bindAudit().catch(() => {});
}

function roleOptions(selectedId) {
  return rolesCache.map((r) => `<option value="${escapeHtml(r.id)}" ${r.id === selectedId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
}

function renderRoleSelect() {
  const sel = $('#uf-role');
  if (!sel) return;
  const keep = sel.value;
  const manager = rolesCache.find((r) => r.key === 'MANAGER');
  sel.innerHTML = roleOptions(keep || manager?.id);
}

function renderUsers() {
  const body = $('#usersBody');
  if (!body) return;
  const myId = getMe()?.user.id;
  body.innerHTML = usersCache.length ? usersCache.map((u) => {
    const self = u.id === myId;
    const facilities = u.scoped
      ? u.facilityAccess.map((a) => escapeHtml(a.branchCode || '?')).join(', ')
      : '<span class="t-type">All facilities</span>';
    const locked = u.lockedUntil ? ' <span class="pill red">Locked</span>' : '';
    return `<tr><td><b>${escapeHtml(u.name)}</b>${self ? ' <span class="pill green">You</span>' : ''}${locked}<div class="t-type">${escapeHtml(u.email)}</div></td>` +
      `<td><select class="tbl-select" data-u-role="${escapeHtml(u.id)}" aria-label="Role for ${escapeHtml(u.email)}" ${self ? 'disabled title="You cannot change your own role"' : ''}>${roleOptions(u.role.id)}</select></td>` +
      `<td>${facilities}</td>` +
      `<td class="unit-actions"><button class="act-btn" type="button" data-u-act="access" data-u-id="${escapeHtml(u.id)}">Facilities</button> ` +
      `<button class="act-btn" type="button" data-u-act="password" data-u-id="${escapeHtml(u.id)}">Reset password</button> ` +
      (u.lockedUntil ? `<button class="act-btn" type="button" data-u-act="unlock" data-u-id="${escapeHtml(u.id)}">Unlock</button> ` : '') +
      (self ? '' : `<button class="act-btn danger" type="button" data-u-act="delete" data-u-id="${escapeHtml(u.id)}">Remove</button>`) + '</td></tr>' +
      `<tr data-u-editor="${escapeHtml(u.id)}" hidden><td colspan="4"><div class="t-type" data-u-editor-body>…</div></td></tr>`;
  }).join('') : '<tr><td colspan="4"><div class="section-empty">No operators.</div></td></tr>';
}

function editorRow(id) {
  return document.querySelector(`tr[data-u-editor="${CSS.escape(id)}"]`);
}

function toggleAccessEditor(id) {
  const row = editorRow(id);
  if (!row) return;
  if (!row.hidden && row.dataset.mode === 'access') { row.hidden = true; return; }
  const u = usersCache.find((x) => x.id === id);
  const current = new Set((u?.facilityAccess || []).map((a) => a.scope === 'ALL' ? 'ALL' : a.branchId));
  const all = !u?.scoped;
  row.dataset.mode = 'access';
  row.querySelector('[data-u-editor-body]').innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
    <label><input type="checkbox" data-acc="ALL" ${all || current.has('ALL') ? 'checked' : ''}> All facilities</label>` +
    (state.branches || []).map((b) => `<label><input type="checkbox" data-acc="${escapeHtml(b.id)}" ${!all && current.has(b.id) ? 'checked' : ''}> ${escapeHtml(b.name)} (${escapeHtml(b.code)})</label>`).join('') +
    ` <button class="act-btn primary" type="button" data-u-save-access="${escapeHtml(id)}">Save facilities</button></div>`;
  row.hidden = false;
}

function togglePasswordEditor(id) {
  const row = editorRow(id);
  if (!row) return;
  if (!row.hidden && row.dataset.mode === 'password') { row.hidden = true; return; }
  row.dataset.mode = 'password';
  row.querySelector('[data-u-editor-body]').innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
    <input type="password" class="tbl-search" data-u-newpw placeholder="New temporary password (8+ characters)" aria-label="New temporary password" autocomplete="new-password" style="max-width:280px;">
    <button class="act-btn primary" type="button" data-u-save-password="${escapeHtml(id)}">Set password</button>
    <span class="t-type">They are signed out everywhere and should change it after signing in.</span></div>`;
  row.hidden = false;
  row.querySelector('[data-u-newpw]').focus();
}

async function saveAccess(id) {
  const row = editorRow(id);
  const boxes = row ? [...row.querySelectorAll('input[data-acc]:checked')].map((c) => c.dataset.acc) : [];
  const access = boxes.includes('ALL') || !boxes.length ? [] : boxes.map((branchId) => ({ branchId }));
  try {
    await put(`/users/${encodeURIComponent(id)}/access`, { access });
    showBanner('Facility access saved', true);
    await reloadTeam();
  } catch (e) {
    showBanner('Facilities: ' + describeError(e));
  }
}

async function patchUser(id, body, okMsg) {
  try {
    await patch(`/users/${encodeURIComponent(id)}`, body);
    showBanner(okMsg, true);
    await reloadTeam();
  } catch (e) {
    showBanner('Operator: ' + describeError(e));
    renderUsers(); // put a refused role select back
  }
}

async function submitUserForm() {
  const body = {
    email: $('#uf-email')?.value.trim() || '',
    name: $('#uf-name')?.value.trim() || '',
    password: $('#uf-password')?.value || '',
    roleId: $('#uf-role')?.value || '',
  };
  if (!body.email || !body.name || body.password.length < 8 || !body.roleId) {
    showBanner('Enter an email, a name, a role and a temporary password of 8+ characters');
    return;
  }
  try {
    await post('/users', body);
    showBanner(`${body.email} added. Share the temporary password with them directly.`, true);
    ['#uf-email', '#uf-name', '#uf-password'].forEach((sel) => { if ($(sel)) $(sel).value = ''; });
    await reloadTeam();
  } catch (e) {
    showBanner('Operator: ' + describeError(e));
  }
}

// ---- roles ----

function renderRoles() {
  const tabs = $('#roleTabs');
  if (!tabs || !catalog) return;
  if (!creatingRole && !rolesCache.some((r) => r.id === selectedRoleId)) {
    selectedRoleId = (rolesCache.find((r) => r.key === 'MANAGER') || rolesCache[0] || {}).id || null;
  }
  tabs.innerHTML = rolesCache.map((r) =>
    `<button type="button" role="tab" data-role-id="${escapeHtml(r.id)}" aria-selected="${!creatingRole && r.id === selectedRoleId}">${escapeHtml(r.name)}<small>${r.userCount}</small></button>`,
  ).join('') + (creatingRole ? '<button type="button" role="tab" aria-selected="true">New role</button>' : '');
  renderRoleEditor();
}

function renderRoleEditor() {
  const el = $('#roleEditor');
  if (!el) return;
  const role = creatingRole ? { id: null, name: '', description: '', locked: false, isOwner: false, permissions: [], userCount: 0 } : rolesCache.find((r) => r.id === selectedRoleId);
  if (!role) { el.innerHTML = ''; return; }
  const has = new Set(role.permissions);
  const ro = role.locked;
  let group = '';
  const rows = catalog.resources.map((res) => {
    let head = '';
    if (res.group !== group) {
      group = res.group;
      head = `<tr class="grp"><td colspan="${ACTION_COLS.length + 1}">${escapeHtml(group)}</td></tr>`;
    }
    const cells = ACTION_COLS.map(([a]) => {
      const key = actionKey(a);
      if (!res.actions.includes(key)) return '<td class="c na" aria-label="Not applicable">—</td>';
      const perm = `${res.key}:${key}`;
      return `<td class="c"><input type="checkbox" data-role-perm="${escapeHtml(perm)}" aria-label="${escapeHtml(res.label)}: ${a}" ${has.has(perm) ? 'checked' : ''} ${ro ? 'disabled' : ''}></td>`;
    }).join('');
    return head + `<tr><td>${escapeHtml(res.label)}</td>${cells}</tr>`;
  }).join('') + `<tr class="grp"><td colspan="${ACTION_COLS.length + 1}">Global Settings › Team &amp; access — Owner only</td></tr>`;
  el.innerHTML =
    (ro ? '<p class="role-note">The Owner role always has full access and cannot be edited.</p>' : '') +
    `<div class="role-meta">
      <div class="field"><label for="roleName">Role name</label><input id="roleName" value="${escapeHtml(role.name)}" ${ro ? 'disabled' : ''} maxlength="60"></div>
      <div class="field"><label for="roleDesc">Description</label><input id="roleDesc" value="${escapeHtml(role.description || '')}" ${ro ? 'disabled' : ''} maxlength="200"></div>
    </div>
    <div class="role-grid-wrap"><table class="role-grid"><thead><tr><th>Screen</th>${ACTION_COLS.map(([, l]) => `<th class="c">${l}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` +
    (ro ? '' : `<div class="role-actions">
      ${creatingRole ? '<button class="tb-btn" type="button" id="roleCancelBtn">Cancel</button>' : `<button class="tb-btn danger" type="button" id="roleDeleteBtn" ${role.userCount ? `disabled title="Move its ${role.userCount} operator(s) to another role first"` : ''}>Delete role</button>`}
      <button class="tb-btn primary" type="button" id="roleSaveBtn">${creatingRole ? 'Create role' : 'Save role'}</button></div>`);
}

function onRoleGridChange(e) {
  const box = e.target.closest && e.target.closest('input[data-role-perm]');
  if (!box) return;
  const [res, action] = box.dataset.rolePerm.split(':');
  const grid = $('#roleEditor');
  const viewBox = grid.querySelector(`input[data-role-perm="${CSS.escape(res + ':view')}"]`);
  // Any write needs View; removing View removes the writes too.
  if (action !== 'view' && box.checked && viewBox) viewBox.checked = true;
  if (action === 'view' && !box.checked) {
    grid.querySelectorAll(`input[data-role-perm^="${CSS.escape(res + ':')}"]`).forEach((b) => { b.checked = false; });
  }
}

async function saveRole() {
  const name = $('#roleName')?.value.trim() || '';
  if (!name) { showBanner('Give the role a name'); return; }
  const permissions = [...document.querySelectorAll('#roleEditor input[data-role-perm]:checked')].map((b) => b.dataset.rolePerm);
  const body = { name, description: $('#roleDesc')?.value.trim() || null, permissions };
  try {
    if (creatingRole) {
      const r = await post('/roles', body);
      creatingRole = false;
      selectedRoleId = r.id;
      showBanner(`Role ${r.name} created`, true);
    } else {
      await patch(`/roles/${encodeURIComponent(selectedRoleId)}`, body);
      showBanner('Role saved. Operators on it see the change on their next action.', true);
    }
    await reloadTeam();
  } catch (e) {
    showBanner('Role: ' + describeError(e));
  }
}

async function deleteSelectedRole() {
  const role = rolesCache.find((r) => r.id === selectedRoleId);
  if (!role) return;
  const okConfirm = await confirmDialog({ title: `Delete the ${role.name} role?`, message: 'This cannot be undone.', confirmLabel: 'Delete role', danger: true });
  if (!okConfirm) return;
  try {
    await del(`/roles/${encodeURIComponent(role.id)}`);
    selectedRoleId = null;
    showBanner(`Role ${role.name} deleted`, true);
    await reloadTeam();
  } catch (e) {
    showBanner('Role: ' + describeError(e));
  }
}

// ---- audit ----

const AUDIT_LABEL = {
  ROLE_CREATE: 'created role', ROLE_UPDATE: 'edited role', ROLE_DELETE: 'deleted role',
  USER_CREATE: 'added operator', USER_UPDATE: 'updated operator', USER_DELETE: 'removed operator', USER_ACCESS: 'changed facilities for',
};

function auditTarget(a) {
  const pick = (o) => (o && (o.name || o.email)) || '';
  if (a.targetType === 'ROLE') return pick(a.after) || pick(a.before);
  const u = usersCache.find((x) => x.id === a.targetId);
  return (u && u.email) || pick(a.after) || pick(a.before) || 'an operator';
}

function auditDetail(a) {
  const b = a.before || {};
  const n = a.after || {};
  if (a.action === 'USER_UPDATE' && b.role !== n.role) return `role ${b.role} → ${n.role}`;
  if (a.action === 'USER_UPDATE' && n.passwordReset) return 'password reset';
  if (a.action === 'USER_UPDATE' && n.unlocked) return 'unlocked';
  if (a.action === 'USER_ACCESS') return `${(b.facilities || []).join(', ') || 'all'} → ${(n.facilities || []).join(', ') || 'all'}`;
  if (a.action === 'ROLE_UPDATE') {
    const was = new Set(b.permissions || []);
    const now = new Set(n.permissions || []);
    const added = [...now].filter((p) => !was.has(p)).length;
    const removed = [...was].filter((p) => !now.has(p)).length;
    return added || removed ? `+${added} / −${removed} permissions` : 'name or description';
  }
  return '';
}

async function bindAudit() {
  const body = $('#auditBody');
  if (!body) return;
  const rows = (await get('/permission-audit?limit=20')) || [];
  body.innerHTML = rows.length ? rows.map((a) => {
    const when = new Date(a.createdAt).toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short' });
    const detail = auditDetail(a);
    return `<tr><td class="t-type">${escapeHtml(when)}</td><td>${escapeHtml(a.actorEmail || 'system')}</td>` +
      `<td>${escapeHtml(AUDIT_LABEL[a.action] || a.action)} <b>${escapeHtml(auditTarget(a))}</b>${detail ? ` <span class="t-type">· ${escapeHtml(detail)}</span>` : ''}</td></tr>`;
  }).join('') : '<tr><td colspan="3"><div class="section-empty">No permission changes yet.</div></td></tr>';
}

let settingsExtWired = false;
export function wireSettingsExt() {
  if (settingsExtWired) return;
  settingsExtWired = true;
  $('#feesBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-fee-del]');
    if (!btn) return;
    const okConfirm = await confirmDialog({ title: 'Delete fee rule?', message: 'The next-most-specific rule (or caller default) takes over.', confirmLabel: 'Delete', danger: true });
    if (!okConfirm) return;
    try {
      await del('/fees/' + encodeURIComponent(btn.dataset.feeDel));
      await bindFeesSection();
    } catch (err) {
      showBanner('Fee: ' + describeError(err));
    }
  });
  $('#ff-add')?.addEventListener('click', () => submitFeeForm().catch(() => {}));
  $('#fr-resolveBtn')?.addEventListener('click', () => resolvePreview().catch(() => {}));
  // Business-rules controls: delegate on the section container (re-rendered).
  // Mirrors the scalar markSettingsDirty pattern: any edit lights the rules
  // dirty-dot and enables Save rules; switches keep keyboard/aria parity
  // with the scalar .sw controls (aria-checked + Enter/Space).
  $('#businessRulesSection')?.addEventListener('click', (e) => {
    const sw = e.target.closest('.sw[data-rule-key]');
    if (sw) toggleRuleSwitch(sw);
  });
  $('#businessRulesSection')?.addEventListener('keydown', (e) => {
    const sw = e.target.closest && e.target.closest('.sw[data-rule-key]');
    if (sw && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleRuleSwitch(sw); }
  });
  $('#businessRulesSection')?.addEventListener('input', (e) => {
    const el = e.target.closest && e.target.closest('[data-rule-key]');
    if (!el || el.classList.contains('sw')) return;
    const key = el.dataset.ruleKey;
    rulesDraft[key] = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    markRulesDirty();
  });
  $('#businessRulesSaveBtn')?.addEventListener('click', () => saveBusinessRules().catch(() => {}));
  // Team & access (Owner only).
  $('#uf-add')?.addEventListener('click', () => submitUserForm().catch(() => {}));
  $('#usersBody')?.addEventListener('change', (e) => {
    const sel = e.target.closest && e.target.closest('select[data-u-role]');
    if (!sel) return;
    const role = rolesCache.find((r) => r.id === sel.value);
    patchUser(sel.dataset.uRole, { roleId: sel.value }, `Role changed to ${role ? role.name : 'the new role'}`).catch(() => {});
  });
  $('#usersBody')?.addEventListener('click', async (e) => {
    const act = e.target.closest('button[data-u-act]');
    if (act) {
      const id = act.dataset.uId;
      const u = usersCache.find((x) => x.id === id);
      if (act.dataset.uAct === 'access') toggleAccessEditor(id);
      else if (act.dataset.uAct === 'password') togglePasswordEditor(id);
      else if (act.dataset.uAct === 'unlock') patchUser(id, { unlock: true }, `${u ? u.email : 'Operator'} unlocked`).catch(() => {});
      else if (act.dataset.uAct === 'delete') {
        const okConfirm = await confirmDialog({ title: `Remove ${u ? u.email : 'this operator'}?`, message: 'They are signed out and can no longer sign in.', confirmLabel: 'Remove', danger: true });
        if (!okConfirm) return;
        try {
          await del('/users/' + encodeURIComponent(id));
          showBanner('Operator removed', true);
          await reloadTeam();
        } catch (err) {
          showBanner('Operator: ' + describeError(err));
        }
      }
      return;
    }
    const saveAcc = e.target.closest('button[data-u-save-access]');
    if (saveAcc) { saveAccess(saveAcc.dataset.uSaveAccess).catch(() => {}); return; }
    const savePw = e.target.closest('button[data-u-save-password]');
    if (savePw) {
      const pw = editorRow(savePw.dataset.uSavePassword)?.querySelector('[data-u-newpw]')?.value || '';
      if (pw.length < 8) { showBanner('Use at least 8 characters'); return; }
      patchUser(savePw.dataset.uSavePassword, { password: pw }, 'Password set. They have been signed out.').catch(() => {});
    }
  });
  $('#roleTabs')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-role-id]');
    if (!b) return;
    creatingRole = false;
    selectedRoleId = b.dataset.roleId;
    renderRoles();
  });
  $('#roleNewBtn')?.addEventListener('click', () => { creatingRole = true; renderRoles(); $('#roleName')?.focus(); });
  $('#roleEditor')?.addEventListener('change', onRoleGridChange);
  $('#roleEditor')?.addEventListener('click', (e) => {
    if (e.target.closest('#roleSaveBtn')) saveRole().catch(() => {});
    else if (e.target.closest('#roleDeleteBtn')) deleteSelectedRole().catch(() => {});
    else if (e.target.closest('#roleCancelBtn')) { creatingRole = false; renderRoles(); }
  });
}

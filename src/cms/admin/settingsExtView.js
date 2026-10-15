// StoreLah CMS admin UI — Settings extensions (P1 items 5, 6, 7).
// Fees & deposits with per-facility override (GET/POST/DELETE /fees +
// /fees/resolve preview), business-rules section (GET/PUT /business-rules),
// Users section (GET/POST/PATCH/DELETE /users + access + permissions).
// The 14 scalar settings in #settingsGrid are untouched.

import { $, escapeHtml, showBanner } from './dom.js';
import { get, post, put, del, describeError } from './api.js';
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

// ---------- users & roles (P1 item 6) ----------

let permCatalog = [];
let usersCache = [];

export async function bindUsersSection() {
  const body = $('#usersBody');
  if (!body) return;
  try {
    permCatalog = (await get('/users/permissions')) || [];
  } catch (e) { permCatalog = []; }
  try {
    usersCache = (await get('/users')) || [];
    renderUsers();
  } catch (e) {
    body.innerHTML = '<tr><td colspan="5"><div class="section-empty">Users failed to load: ' + escapeHtml(describeError(e)) + '</div></td></tr>';
  }
}

function renderUsers() {
  const body = $('#usersBody');
  if (!body) return;
  body.innerHTML = usersCache.length ? usersCache.map((u) =>
    `<tr><td><b>${escapeHtml(u.email)}</b><div class="t-type">${escapeHtml(u.name)} · ${escapeHtml(u.role)}</div></td>` +
    `<td>${u.scoped ? u.facilityAccess.map((a) => a.scope === 'ALL' ? 'ALL' : escapeHtml(a.branchCode || '?')).join(', ') : '<span class="t-type">All facilities (legacy)</span>'}</td>` +
    `<td>${u.permissions.length ? u.permissions.map((p) => `<span class="pill green">${escapeHtml(p)}</span>`).join(' ') : '<span class="t-type">legacy role</span>'}</td>` +
    `<td class="unit-actions"><button class="act-btn" data-u-act="access" data-u-id="${escapeHtml(u.id)}">Access</button> ` +
    `<button class="act-btn" data-u-act="perms" data-u-id="${escapeHtml(u.id)}">Permissions</button> ` +
    `<button class="act-btn danger" data-u-act="delete" data-u-id="${escapeHtml(u.id)}">Delete</button></td></tr>` +
    `<tr data-u-editor="${escapeHtml(u.id)}" hidden><td colspan="4"><div class="t-type" data-u-editor-body>…</div></td></tr>`,
  ).join('') : '<tr><td colspan="5"><div class="section-empty">No operators.</div></td></tr>';
}

function editorRow(id) {
  return document.querySelector(`tr[data-u-editor="${CSS.escape(id)}"]`);
}

async function toggleAccessEditor(id) {
  const row = editorRow(id);
  if (!row) return;
  if (!row.hidden) { row.hidden = true; return; }
  const u = usersCache.find((x) => x.id === id);
  const bodyEl = row.querySelector('[data-u-editor-body]');
  const current = new Set((u?.facilityAccess || []).map((a) => a.scope === 'ALL' ? 'ALL' : a.branchId));
  bodyEl.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
    <label><input type="checkbox" data-acc="ALL" ${current.has('ALL') ? 'checked' : ''}> All facilities</label>` +
    (state.branches || []).map((b) => `<label><input type="checkbox" data-acc="${escapeHtml(b.id)}" ${current.has(b.id) ? 'checked' : ''}> ${escapeHtml(b.code)}</label>`).join('') +
    ` <button class="act-btn primary" data-u-save-access="${escapeHtml(id)}">Save access</button></div>`;
  row.hidden = false;
}

async function togglePermsEditor(id) {
  const row = editorRow(id);
  if (!row) return;
  if (!row.hidden) { row.hidden = true; return; }
  const u = usersCache.find((x) => x.id === id);
  const has = new Set(u?.permissions || []);
  const bodyEl = row.querySelector('[data-u-editor-body]');
  bodyEl.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
    <span class="t-type">Verified grants (empty = legacy role behavior):</span>` +
    permCatalog.map((p) => `<label><input type="checkbox" data-perm="${escapeHtml(p)}" ${has.has(p) ? 'checked' : ''}> ${escapeHtml(p)}</label>`).join('') +
    ` <button class="act-btn primary" data-u-save-perms="${escapeHtml(id)}">Save grants</button></div>`;
  row.hidden = false;
}

async function saveAccess(id) {
  const row = editorRow(id);
  const boxes = row ? [...row.querySelectorAll('input[data-acc]:checked')].map((c) => c.dataset.acc) : [];
  const access = boxes.includes('ALL') ? [{ scope: 'ALL' }] : boxes.map((branchId) => ({ branchId }));
  try {
    await put(`/users/${encodeURIComponent(id)}/access`, { access });
    showBanner('Facility access saved', true);
    usersCache = (await get('/users')) || [];
    renderUsers();
  } catch (e) {
    showBanner('Access: ' + describeError(e));
  }
}

async function savePerms(id) {
  const row = editorRow(id);
  const u = usersCache.find((x) => x.id === id);
  const want = new Set(row ? [...row.querySelectorAll('input[data-perm]:checked')].map((c) => c.dataset.perm) : []);
  const have = new Set(u?.permissions || []);
  try {
    for (const p of want) if (!have.has(p)) await post(`/users/${encodeURIComponent(id)}/permissions`, { permission: p });
    for (const p of have) {
      if (!want.has(p)) await del(`/users/${encodeURIComponent(id)}/permissions/${encodeURIComponent(p)}`);
    }
    showBanner('Permissions saved', true);
    usersCache = (await get('/users')) || [];
    renderUsers();
  } catch (e) {
    showBanner('Permissions: ' + describeError(e));
  }
}

async function submitUserForm() {
  const body = {
    email: $('#uf-email')?.value.trim() || '',
    name: $('#uf-name')?.value.trim() || '',
    password: $('#uf-password')?.value || '',
    role: $('#uf-role')?.value || 'MANAGER',
  };
  if (!body.email || !body.name || body.password.length < 8) {
    showBanner('Email, name and a password of 8+ characters are required');
    return;
  }
  try {
    await post('/users', body);
    showBanner(`Operator ${body.email} created`, true);
    if ($('#uf-email')) $('#uf-email').value = '';
    if ($('#uf-name')) $('#uf-name').value = '';
    if ($('#uf-password')) $('#uf-password').value = '';
    usersCache = (await get('/users')) || [];
    renderUsers();
  } catch (e) {
    showBanner('User: ' + describeError(e));
  }
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
  // Users section.
  $('#uf-add')?.addEventListener('click', () => submitUserForm().catch(() => {}));
  $('#usersBody')?.addEventListener('click', async (e) => {
    const act = e.target.closest('button[data-u-act]');
    if (act) {
      if (act.dataset.uAct === 'access') toggleAccessEditor(act.dataset.uId).catch(() => {});
      else if (act.dataset.uAct === 'perms') togglePermsEditor(act.dataset.uId).catch(() => {});
      else if (act.dataset.uAct === 'delete') {
        const okConfirm = await confirmDialog({ title: 'Delete operator?', message: 'Their access and grants are removed.', confirmLabel: 'Delete', danger: true });
        if (!okConfirm) return;
        try {
          await del('/users/' + encodeURIComponent(act.dataset.uId));
          usersCache = (await get('/users')) || [];
          renderUsers();
        } catch (err) {
          showBanner('User: ' + describeError(err));
        }
      }
      return;
    }
    const saveAcc = e.target.closest('button[data-u-save-access]');
    if (saveAcc) { saveAccess(saveAcc.dataset.uSaveAccess).catch(() => {}); return; }
    const savePerms = e.target.closest('button[data-u-save-perms]');
    if (savePerms) savePerms(savePerms.dataset.uSavePerms).catch(() => {});
  });
}

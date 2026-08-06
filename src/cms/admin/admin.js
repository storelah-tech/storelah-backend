// StoreLah CMS admin UI — data layer + units CRUD for /admin.
// Served at /admin; talks to the same /api/v1/cms endpoints the frozen dashboard uses,
// plus the reference endpoints (/floors, /sizes) and full units CRUD.
(function () {
  'use strict';

  const API = '/api/v1/cms';
  let token = null;

  let mode = 'create'; // 'create' | 'edit'
  let currentEditCode = null;
  let rateTargetCode = null;

  const state = {
    units: [], // normalized units (list shape)
    branches: [],
    floors: [],
    sizes: [],
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // ---------- auth (mirrors frozen data-layer.js; never prints credentials) ----------
  async function getCreds() {
    const res = await fetch(`${API}/config`);
    if (!res.ok) throw new Error('admin credentials not configured (set STORELAH_ADMIN_*)');
    return res.json();
  }

  async function login() {
    const CREDS = await getCreds();
    const res = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CREDS),
    });
    if (!res.ok) throw new Error('login failed');
    const body = await res.json();
    token = body.data.token;
  }

  // ---------- http ----------
  class ApiError extends Error {
    constructor(status, code, message, details) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  async function request(path, opts = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    if (opts.body) headers['Content-Type'] = 'application/json';
    Object.assign(headers, opts.headers);
    let res;
    try {
      res = await fetch(`${API}${path}`, { ...opts, headers });
    } catch (e) {
      throw new ApiError(0, 'NETWORK', 'Network error — is the backend up?');
    }
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      /* non-JSON body */
    }
    if (!res.ok) {
      const e = body && body.error;
      // Envelope shape: { error: { code, message, details? } }
      if (e && typeof e === 'object' && e.message) {
        throw new ApiError(res.status, e.code || 'ERROR', e.message, e.details);
      }
      // Plain shape (requireAuth 401): { error: "Unauthorized" }
      if (e && typeof e === 'string') {
        throw new ApiError(res.status, 'UNAUTHORIZED', e);
      }
      throw new ApiError(res.status, 'HTTP', `Request failed (${res.status})`);
    }
    return body;
  }

  const get = (p) => request(p).then((b) => b.data);

  // ---------- error banner (themed; tolerates both error shapes) ----------
  function showBanner(msg, ok) {
    const el = $('#errorBanner');
    if (!el) return;
    el.textContent = msg;
    el.style.color = ok ? 'var(--olive)' : 'var(--red)';
    if (msg) {
      clearTimeout(showBanner._t);
      showBanner._t = setTimeout(() => {
        el.textContent = '';
      }, 8000);
    }
  }

  function describeError(err) {
    if (err instanceof ApiError) {
      if (err.details && err.details.fieldErrors) {
        const msgs = [];
        for (const [field, list] of Object.entries(err.details.fieldErrors)) {
          if (list && list.length) msgs.push(`${field}: ${list.join('; ')}`);
        }
        if (msgs.length) return msgs.join(' · ');
      }
      return err.message || `Request failed (${err.status})`;
    }
    return err && err.message ? err.message : String(err);
  }

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

  // ---------- status tones (frozen badge tones) ----------
  const STATUS_TONE = {
    OCCUPIED: 'occ',
    AVAILABLE: 'avail',
    RESERVED: 'res',
    OVERDUE: 'over',
    MAINTENANCE: 'neutral',
    INACTIVE: 'neutral',
  };
  const STATUS_LABEL = {
    OCCUPIED: 'Occupied',
    AVAILABLE: 'Available',
    RESERVED: 'Reserved',
    OVERDUE: 'Overdue',
    MAINTENANCE: 'Maintenance',
    INACTIVE: 'Inactive',
  };
  const MAP_TONE = {
    OCCUPIED: 'occupied',
    AVAILABLE: 'available',
    RESERVED: 'reserved',
    OVERDUE: 'overdue',
    MAINTENANCE: 'maintenance',
    INACTIVE: 'maintenance',
  };
  const fmtMoney = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

  // ---------- dashboard bindings (mirror frozen data-layer.js) ----------
  const kpiVal = (i) => $$('.kpi-strip .kpi')[i]?.querySelector('.kpi-val');
  const kpiDelta = (i) => $$('.kpi-strip .kpi')[i]?.querySelector('.kpi-delta');

  function bindKpis(s) {
    if (!s || !s.kpis) return;
    const k = s.kpis;
    const setK = (i, val, unit) => {
      const el = kpiVal(i);
      if (!el) return;
      el.innerHTML = val + (unit ? `<span class="unit">${unit}</span>` : '');
    };
    setK(0, k.occupancyPct, '%');
    setK(1, k.totalUnits, '');
    if (kpiDelta(1)) kpiDelta(1).textContent = `${k.occupiedUnits} occ · ${k.totalUnits - k.occupiedUnits} avail`;
    setK(2, k.overdueUnits, ' units');
    setK(3, fmtMoney(k.mrr));
    setK(4, k.avgPsf);
  }

  function bindCharts(s) {
    if (!s) return;
    if (s.monthlyRevenue) {
      const rc = Chart.getChart && Chart.getChart('revenueChart');
      if (rc) {
        rc.data.labels = s.monthlyRevenue.labels;
        rc.data.datasets[0].data = s.monthlyRevenue.actual;
        rc.data.datasets[1].data = s.monthlyRevenue.target;
        rc.update();
      }
    }
    if (s.occupancyByBranch) {
      const bc = Chart.getChart && Chart.getChart('branchChart');
      if (bc) {
        bc.data.labels = s.occupancyByBranch.map((b) => b.name);
        bc.data.datasets[0].data = s.occupancyByBranch.map((b) => b.occupancyPct);
        bc.update();
      }
    }
  }

  function bindUnitMap(map) {
    if (!map || !map.units || !document.querySelector('.u-cell')) return;
    const byShort = new Map(map.units.map((u) => [u.short, u]));
    document.querySelectorAll('.u-cell').forEach((el) => {
      const short = el.querySelector('.u-id')?.textContent;
      const data = byShort.get(short);
      if (!data) return;
      el.className = 'u-cell ' + (MAP_TONE[data.status.toUpperCase()] || 'available');
      const size = el.querySelector('.u-size');
      const psf = el.querySelector('.u-psf');
      if (size) size.textContent = data.size;
      if (psf) {
        psf.textContent = data.psf ? '$' + data.psf.toFixed(2) : 'Maint.';
        psf.removeAttribute('style');
      }
      el.onclick = () => selectUnit(el, data.code);
    });
  }

  function bindTenants(rows) {
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

  function bindLeads(data) {
    const board = $('#kanbanBoard');
    if (!board) return;
    const clone = board.cloneNode(false);
    const tagMap = { PERSONAL: 'per', BUSINESS: 'biz' };
    const stageLabel = {
      NEW_ENQUIRY: 'New Enquiry',
      CONTACTED: 'Contacted',
      VIEWING_BOOKED: 'Viewing Booked',
      PROPOSAL_SENT: 'Proposal Sent',
      WON: 'Won 🎉',
      LOST: 'Lost',
    };
    (data || []).forEach((col) => {
      const inner = document.createElement('div');
      inner.className = 'k-col';
      inner.innerHTML = `
        <div class="k-col-hdr"><div class="k-col-title">${stageLabel[col.stage] ?? col.stage}</div><div class="k-count">${col.count}</div></div>
        ${(col.leads || [])
          .map(
            (l) => `<div class="k-card">
              <div class="k-name">${l.name}</div>
              <div class="k-meta"><span class="k-tag ${tagMap[l.type]}">${l.type === 'PERSONAL' ? 'Personal' : 'Business'}</span>${l.size || ''}${l.branch ? ' · ' + l.branch : ''}</div>
            </div>`,
          )
          .join('')}`;
      clone.appendChild(inner);
    });
    board.replaceWith(clone);
  }

  function bindActions(data) {
    const list = $('#alertList');
    if (!list) return;
    list.innerHTML = (data || [])
      .map(
        (it) => `<div class="alert-item">
          <div class="alert-icon ${it.tone}">${it.icon}</div>
          <div class="alert-body"><div class="alert-title">${it.title}</div><div class="alert-desc">${it.desc}</div></div>
          <div class="alert-time">${it.time}</div>
          <button class="alert-act">${it.action}</button>
        </div>`,
      )
      .join('');
    const badge = document.querySelector('.nav-badge.red');
    if (badge) badge.textContent = data ? data.length : 0;
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
      sub.textContent = `${state.units.length} units · ${state.units.filter((u) => u.status === 'AVAILABLE').length} available`;
    }
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
  async function showUnitDetail(code) {
    try {
      const d = await get(`/units/${encodeURIComponent(code)}`);
      const u = normalizeUnit(d);
      const id = $('#udId');
      if (id) id.textContent = `${u.code}${u.sizeName ? ' · ' + u.sizeName + ' Unit' : ''}`;
      const badges = $('#udBadges');
      if (badges) {
        badges.innerHTML = `
          <span class="badge ${STATUS_TONE[u.status] || 'neutral'}">● ${STATUS_LABEL[u.status] || u.status}</span>
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
      setUnitsBanner('');
    } catch (err) {
      showBanner('Detail: ' + describeError(err));
    }
  }

  // ---------- reference data ----------
  async function loadRefs() {
    const [branches, floors, sizes] = await Promise.all([get('/branches'), get('/floors'), get('/sizes')]);
    state.branches = branches;
    state.floors = floors;
    state.sizes = sizes;
  }

  function populateBranchSelect(selected) {
    const sel = $('#f-branch');
    sel.innerHTML = state.branches
      .map((b) => `<option value="${b.id}">${b.code} · ${b.name}</option>`)
      .join('');
    if (selected) sel.value = selected;
  }

  function populateFloorSelect(branchId, selected) {
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

  async function openCreateForm() {
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
    $('#unitFormSubmit').textContent = 'Save Unit';
    clearFieldErrors();
    $('#unitModal').hidden = false;
  }

  async function openEditForm(code) {
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

  function closeUnitModal() {
    $('#unitModal').hidden = true;
    $('#f-branch').disabled = false;
    $('#f-floor').disabled = false;
    $('#f-size').disabled = false;
    clearFieldErrors();
  }

  async function submitUnitForm(e) {
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
        // PUT /units/:code only accepts sqft / monthlyRate / status / climateControl
        const patch = {
          sqft: body.sqft,
          monthlyRate: body.monthlyRate,
          status: body.status,
          climateControl: body.climateControl,
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

  async function deleteUnit(code) {
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
    if (!window.confirm(`Delete unit ${code}? This soft-deactivates it (status → INACTIVE).`)) return;
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
  function openRateForm(code) {
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

  function closeRateModal() {
    $('#rateModal').hidden = true;
    rateTargetCode = null;
  }

  async function submitRateForm(e) {
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

  // ---------- refresh ----------
  async function refreshAll() {
    const [units, summary, map, tenants, leads, actions] = await Promise.all([
      get('/units').catch(() => []),
      get('/summary').catch(() => null),
      get('/units/map?branch=BM&level=1').catch(() => null),
      get('/tenants').catch(() => []),
      get('/leads').catch(() => []),
      get('/action-items').catch(() => []),
    ]);
    state.units = units.map(normalizeUnit);
    renderUnitsTable();
    bindKpis(summary);
    bindCharts(summary);
    bindUnitMap(map);
    bindTenants(tenants);
    bindLeads(leads);
    bindActions(actions);
  }

  // ---------- charts (frozen configs) ----------
  function initCharts() {
    const rCtx = $('#revenueChart')?.getContext('2d');
    if (rCtx && !Chart.getChart('revenueChart')) {
      new Chart(rCtx, {
        type: 'bar',
        data: {
          labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
          datasets: [
            { label: 'Actual', data: [36200, 37800, 38500, 39200, 40100, 41600, 42860], backgroundColor: (ctx) => (ctx.dataIndex === 6 ? '#B86A4A' : '#E9E1D0'), borderRadius: 5, borderSkipped: false },
            { label: 'Target', data: [38000, 38000, 39000, 39000, 40000, 41000, 42000], type: 'line', borderColor: '#5A7A60', borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, fill: false, tension: 0.3 },
          ],
        },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#9C948D' } }, y: { grid: { color: '#F3EEE6' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#9C948D', callback: (v) => '$' + (v / 1000).toFixed(0) + 'k' } } } },
      });
    }
    const bCtx = $('#branchChart')?.getContext('2d');
    if (bCtx && !Chart.getChart('branchChart')) {
      new Chart(bCtx, {
        type: 'bar',
        data: { labels: ['Bukit Merah', 'Woodlands', 'Ubi'], datasets: [{ data: [87.5, 91.2, 82.0], backgroundColor: ['#B86A4A', '#5A7A60', '#0B4F5E'], borderRadius: 7, borderSkipped: false }] },
        options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: '#F3EEE6' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#9C948D', callback: (v) => v + '%' }, max: 100 }, y: { grid: { display: false }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#6B6560' } } } },
      });
    }
    const pCtx = $('#psfChart')?.getContext('2d');
    if (pCtx && !Chart.getChart('psfChart')) {
      new Chart(pCtx, {
        type: 'scatter',
        data: {
          datasets: [
            { label: 'Locker', data: [{ x: 12, y: 5.2 }, { x: 15, y: 5.1 }, { x: 18, y: 5.3 }, { x: 10, y: 5.4 }, { x: 20, y: 5.0 }], backgroundColor: '#B86A4A', pointRadius: 5 },
            { label: 'Small', data: [{ x: 30, y: 4.8 }, { x: 35, y: 4.7 }, { x: 28, y: 4.9 }, { x: 40, y: 4.6 }, { x: 32, y: 4.8 }], backgroundColor: '#5A7A60', pointRadius: 5 },
            { label: 'Medium', data: [{ x: 60, y: 4.4 }, { x: 65, y: 4.3 }, { x: 70, y: 4.5 }, { x: 55, y: 4.45 }], backgroundColor: '#0B4F5E', pointRadius: 5 },
            { label: 'Large', data: [{ x: 120, y: 3.8 }, { x: 130, y: 3.7 }, { x: 110, y: 3.9 }], backgroundColor: '#D4860A', pointRadius: 5 },
            { label: 'XL Biz', data: [{ x: 200, y: 3.2 }, { x: 220, y: 3.1 }, { x: 180, y: 3.3 }], backgroundColor: '#9C948D', pointRadius: 5 },
          ],
        },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: '#F3EEE6' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#9C948D', callback: (v) => v + ' sqft' } }, y: { grid: { color: '#F3EEE6' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#9C948D', callback: (v) => '$' + v } } } },
      });
    }
  }

  // ---------- events ----------
  function wireEvents() {
    $('#addUnitBtn').addEventListener('click', openCreateForm);
    $('#unitModalClose').addEventListener('click', closeUnitModal);
    $('#unitFormCancel').addEventListener('click', closeUnitModal);
    $('#unitForm').addEventListener('submit', submitUnitForm);
    $('#rateModalClose').addEventListener('click', closeRateModal);
    $('#rateFormCancel').addEventListener('click', closeRateModal);
    $('#rateForm').addEventListener('submit', submitRateForm);
    $('#editUnitBtn').addEventListener('click', () => {
      if (currentEditCode) openEditForm(currentEditCode);
      else showBanner('Select a unit first (click a cell or a View button).');
    });
    $('#adjustRateBtn').addEventListener('click', () => {
      if (currentEditCode) openRateForm(currentEditCode);
      else showBanner('Select a unit first (click a cell or a View button).');
    });
    $('#deleteUnitBtn').addEventListener('click', () => {
      if (currentEditCode) deleteUnit(currentEditCode);
    });
    $('#f-branch').addEventListener('change', (e) => populateFloorSelect(e.target.value));
    $('#f-size').addEventListener('change', (e) => {
      // In create mode, auto-fill sqft from the selected size's sqftFrom.
      if (mode === 'create') {
        const size = state.sizes.find((s) => s.id === e.target.value);
        if (size) $('#f-sqft').value = size.sqftFrom;
      }
    });
    // row action delegation
    $('#unitsTable').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const { act, code } = btn.dataset;
      if (act === 'view') showUnitDetail(code);
      else if (act === 'edit') openEditForm(code);
      else if (act === 'rate') openRateForm(code);
      else if (act === 'delete') deleteUnit(code);
    });
    // close modals on overlay click
    $$('.modal-overlay').forEach((ov) => {
      ov.addEventListener('click', (e) => {
        if (e.target === ov) {
          if (ov.id === 'unitModal') closeUnitModal();
          else if (ov.id === 'rateModal') closeRateModal();
        }
      });
    });
  }

  // ---------- boot ----------
  async function boot() {
    try {
      await login();
      initCharts();
      await Promise.all([loadRefs(), refreshAll()]);
    } catch (e) {
      console.error('[storelah admin] data layer failed', e);
      showBanner('Data layer error: ' + (e && e.message ? e.message : e));
    }
  }

  wireEvents();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // expose for the inline selectUnit() helper in the HTML
  window.StoreLahAdmin = { showUnitDetail };
})();

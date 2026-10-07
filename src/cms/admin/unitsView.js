// StoreLah CMS admin UI — units view: table + server-side pagination, unit
// detail panel, unit/rate CRUD modals with server field-error mapping.
// Extracted from admin.js (phase-3 layering refactor; nodebestpractices #1).
// Owns its private form `mode`, the selected-unit code and the rate-modal
// target; the entry registers refreshAll()/loadRefs() via the setters below
// because views must never import the entry module.

import { STATUS_TONE, STATUS_LABEL, fmtMoney, fmtDay, fmtDateTime, BOOKING_TONE, INVOICE_TONE, HIST_STAGE_TONE, HIST_STAGE_LABEL, HISTORY_EMPTY_TEXT } from './constants.js';
import { $, $$, escapeHtml, timeAgo, showBanner } from './dom.js';
import { confirmDialog } from './confirmDialog.js';
import { ApiError, request, get, describeError } from './api.js';
import { state, ensureActiveLevel, isAllFacilities } from './state.js';

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
    hasAC: u.hasAC === true,
    hasPillar: u.hasPillar === true,
    tenant,
    rateHistory: u.rateHistory || [],
    operations: u.operations || null,
  };
}

// ---------- units table ----------
function renderUnitsTable() {
  const tbody = $('#unitsTable tbody');
  if (!tbody) return;
  tbody.innerHTML = state.units
    .map((u) => {
      const blocked = u.status === 'INACTIVE';
      const guarded = u.status === 'OCCUPIED' || u.status === 'OVERDUE' || u.status === 'RESERVED';
      return `<tr data-code="${u.code}" class="${blocked ? 'row-blocked' : ''}">
        <td><strong>${u.code}</strong></td>
        <td>${escapeHtml(u.name)}</td>
        <td>${u.sizeName || '—'}${u.sizeCode ? `<div class="t-type">${u.sizeCode}</div>` : ''}</td>
        <td>${u.branchCode || '—'}</td>
        <td>${u.level ? 'Level ' + u.level : '—'}</td>
        <td>${u.hasAC ? 'AC' : 'Non-AC'}${u.hasPillar ? `<div class="t-type">Pillar</div>` : ''}</td>
        <td>${u.sqft != null ? u.sqft : '—'}</td>
        <td>${u.rate != null ? fmtMoney(u.rate) : '—'}</td>
        <td><span class="psf-val">${u.psf != null ? '$' + Number(u.psf).toFixed(2) : '—'}</span></td>
        <td><span class="badge ${STATUS_TONE[u.status] || 'neutral'}">${STATUS_LABEL[u.status] || u.status}</span></td>
        <td>${u.tenant && u.tenant.name ? u.tenant.name : '—'}</td>
        <td class="unit-actions">
          <button class="act-btn" data-act="view" data-code="${u.code}">View</button>
          <button class="act-btn" data-act="edit" data-code="${u.code}">Edit</button>
          <button class="act-btn primary" data-act="rate" data-code="${u.code}">Rate</button>
          <button class="act-btn danger" data-act="delete" data-code="${u.code}" ${guarded ? 'title="Occupied/reserved/overdue units cannot be deleted"' : ''}>Delete</button>
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

// Units toolbar filter selects (facility / level / AC type). The date-range
// control was intentionally removed from this view only — other tables keep
// theirs (see dateFilter.js usages in bookingsView/tenantsView/admin.js).
function populateUnitBranchFilter() {
  const sel = $('#unitBranchFilter');
  if (!sel) return;
  const current = state.unitBranchFilter || '';
  sel.innerHTML = '<option value="">All facilities</option>' +
    state.branches.map((b) => `<option value="${b.code}">${b.code} · ${b.name}</option>`).join('');
  sel.value = [...sel.options].some((o) => o.value === current) ? current : '';
  state.unitBranchFilter = sel.value;
}

export function populateUnitLevelFilter() {
  const sel = $('#unitLevelFilter');
  if (!sel) return;
  const floors = state.unitBranchFilter
    ? state.floors.filter((f) => f.branchId === (state.branches.find((b) => b.code === state.unitBranchFilter) || {}).id)
    : state.floors;
  const levels = [...new Set(floors.map((f) => f.level))].sort((a, b) => a - b);
  const current = state.unitLevelFilter || '';
  sel.innerHTML = '<option value="">All levels</option>' +
    levels.map((l) => `<option value="${l}">Level ${l}</option>`).join('');
  sel.value = levels.some((l) => String(l) === current) ? current : '';
  state.unitLevelFilter = sel.value;
}

// ---------- server-side pagination ----------
export async function fetchUnitsPage() {
  populateUnitBranchFilter();
  populateUnitLevelFilter();
  // Clamp a stale level (e.g. just deactivated) to the first active level so
  // the table never filters on a hidden floor. ALL mode omits level anyway.
  if (!isAllFacilities()) ensureActiveLevel(state.branchCode);
  const qs = new URLSearchParams({ page: String(state.page), perPage: String(state.perPage) });
  if (state.statusFilter) qs.set('status', state.statusFilter);
  // Explicit toolbar facility/level overrides win; otherwise the sidebar
  // facility scope applies (All Facilities → omit branch/level entirely).
  if (state.unitBranchFilter) {
    qs.set('branch', state.unitBranchFilter);
    if (state.unitLevelFilter) qs.set('level', state.unitLevelFilter);
  } else if (!isAllFacilities()) {
    if (state.branchCode) qs.set('branch', state.branchCode);
    if (state.level) qs.set('level', String(state.level));
  }
  if (state.unitAcFilter === 'ac') qs.set('hasAC', 'true');
  else if (state.unitAcFilter === 'nonac') qs.set('hasAC', 'false');
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
  initUnitTabs();
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
        <span class="badge neutral">${u.hasAC ? 'AC' : 'Non-AC'}</span>
        ${u.hasPillar ? `<span class="badge neutral">Pillar</span>` : ''}`;
    }
    const setVal = (sel, v) => {
      const el = $(sel);
      if (el) el.textContent = v ?? '—';
    };
    // Free-unit rule (UI backstop to the API suppression in core/units.ts): an
    // AVAILABLE unit never renders a linked occupant — even when a dangling
    // unit.tenant payload is present. OCCUPIED/OVERDUE units keep showing
    // their current tenant unchanged.
    const isFree = u.status === 'AVAILABLE';
    setVal('#udTenant', isFree ? 'No current tenant' : (u.tenant && u.tenant.name ? u.tenant.name : '—'));
    setVal('#udTenantSub', isFree ? 'Free — no current occupant' : (u.tenant ? `${(u.tenant.type || '').toLowerCase()}${u.tenant.segment ? ' · ' + u.tenant.segment : ''}`.trim() : 'No current tenant'));
    setVal('#udRate', u.rate != null ? fmtMoney(u.rate) : '—');
    setVal('#udRateSub', u.psf != null ? '$' + Number(u.psf).toFixed(2) + '/sq ft' : '—');
    setVal('#udStatus', STATUS_LABEL[u.status] || u.status);
    setVal('#udStatusSub', `${u.hasAC ? 'AC' : 'Non-AC'}${u.hasPillar ? ' · Pillar' : ''}`);
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
    renderUnitOps(u.operations);
    currentEditCode = u.code;
    state.selectedCode = u.code;
    setUnitsBanner('');
    // Enriched tab panels (tenant-history timeline, bookings, invoices,
    // activity) load best-effort from the existing read endpoints; the header
    // card + ops above already painted, so a slow/failed fetch never blanks
    // the detail. Sequence-guarded so rapid unit-hopping keeps the last unit.
    paintUdLoading(u.code);
    enrichUnitDetail(u.code, u);
  } catch (err) {
    showBanner('Detail: ' + describeError(err));
  }
}

// ---------- unit-detail tabs (Overview / Tenant history / Bookings / Invoices / Activity) ----------
// Tablist keyboard follows the ARIA tabs pattern: Left/Right/Home/End move +
// activate, Escape returns focus to the panel. Panels keep their existing IDs
// so every prior data binding keeps working.
const UD_TABS = ['overview', 'history', 'bookings', 'invoices', 'activity'];

export function activateUdTab(name, opts = {}) {
  if (!UD_TABS.includes(name)) return;
  $$('.ud-tab[data-ud-tab]').forEach((tab) => {
    const on = tab.dataset.udTab === name;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    const panel = document.getElementById('udPanel-' + tab.dataset.udTab);
    if (panel) {
      panel.classList.toggle('active', on);
      if (on) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    }
    if (on && opts.focus) tab.focus();
  });
}

function initUnitTabs() {
  if (document.body.dataset.udTabs === '1') return;
  document.body.dataset.udTabs = '1';
  const list = $('.ud-tabs[role="tablist"]');
  if (list) {
    list.addEventListener('click', (e) => {
      const tab = e.target.closest('.ud-tab[data-ud-tab]');
      if (tab) activateUdTab(tab.dataset.udTab);
    });
    list.addEventListener('keydown', (e) => {
      const tab = e.target.closest('.ud-tab[data-ud-tab]');
      if (!tab) return;
      const i = UD_TABS.indexOf(tab.dataset.udTab);
      let next = null;
      if (e.key === 'ArrowRight') next = UD_TABS[(i + 1) % UD_TABS.length];
      else if (e.key === 'ArrowLeft') next = UD_TABS[(i - 1 + UD_TABS.length) % UD_TABS.length];
      else if (e.key === 'Home') next = UD_TABS[0];
      else if (e.key === 'End') next = UD_TABS[UD_TABS.length - 1];
      else return;
      e.preventDefault();
      activateUdTab(next, { focus: true });
    });
  }
  $('#udHistFilter')?.addEventListener('change', (e) => {
    udEnrich.histFilter = e.target.value || '';
    if (udEnrich.code) renderUdHistory();
  });
}

// "📋 History" toolbar button: jumps to the tenant-history tab (keeps the
// operator in context instead of opening anything new).
export function gotoUnitHistory() {
  const code = getSelectedUnitCode();
  if (!code) {
    showBanner('Select a unit first.');
    return;
  }
  initUnitTabs();
  activateUdTab('history', { focus: true });
  $('#unitDetail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- enriched panels (best-effort reads, never fatal) ----------
const udEnrich = {
  code: null,
  seq: 0,
  histFilter: '',
  unit: null,
  tenants: [],
  bookings: [],
  moveins: [],
  activity: [],
};

function setUdState(sel, msg, isErr) {
  const el = $(sel);
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('err');
    return;
  }
  el.hidden = false;
  el.textContent = '';
  el.classList.toggle('err', !!isErr);
  el.textContent = msg;
}

function paintUdLoading(code) {
  udEnrich.code = code;
  setUdState('#udHistState', 'Loading history…', false);
  setUdState('#udBookingsState', 'Loading bookings…', false);
  setUdState('#udInvoicesState', 'Loading invoices…', false);
  setUdState('#udActivityState', 'Loading activity…', false);
  const tl = $('#udTenantTimeline');
  if (tl) {
    tl.innerHTML = '';
    tl.setAttribute('aria-busy', 'true');
  }
  const empty = $('#tenantHistoryEmpty');
  if (empty) empty.hidden = true;
  for (const sel of ['#udBookings', '#udInvoices', '#udUnitActivity']) {
    const el = $(sel);
    if (el) el.innerHTML = '';
  }
  const count = $('#udHistCount');
  if (count) count.hidden = true;
}

function rowUnitCode(r) {
  return r.unitCode || r.unit || r.code || null;
}

function tenantContact(t) {
  return [t.email, t.mobile].filter(Boolean).join(' · ');
}

function histTone(stage) {
  return HIST_STAGE_TONE[stage] || BOOKING_TONE[stage] || INVOICE_TONE[stage] || 'neutral';
}

function histLabel(stage) {
  return HIST_STAGE_LABEL[stage] || STATUS_LABEL[stage] || (stage ? String(stage).replace(/_/g, ' ') : '—');
}

// Stay-stage filter (history tab select): DUE covers DUE_SOON rows and ACTIVE
// covers CONFIRMED bookings, so operators find stays without learning the raw
// enum split between tenants / bookings / move-ins.
function histStageMatch(stage, f) {
  if (!f) return true;
  if (stage === f) return true;
  if (f === 'DUE' && stage === 'DUE_SOON') return true;
  if (f === 'ACTIVE' && (stage === 'CONFIRMED' || stage === 'PAID')) return true;
  return false;
}

// Merge the current occupant + every linked booking/move-in for the unit into
// one newest-first timeline. All customer strings are escaped at render.
// Free-unit rule: an AVAILABLE unit has no current occupant, so occupant rows
// render as past stays (never "Current stay" / "Current occupant"); genuine
// past records (bookings / move-ins) render unchanged, and a unit with no
// records at all falls through to the "No prior tenants" empty state.
function buildUnitHistory(code, u, tenants, bookings, moveins) {
  const items = [];
  const isFree = String((u && u.status) || '').toUpperCase() === 'AVAILABLE';
  const occupant = (tenants || []).find((t) => t.unit === code && t.status !== 'INACTIVE')
    || ((tenants || []).find((t) => t.unit === code) || null);
  if (occupant) {
    items.push({
      kind: 'stay',
      kindLabel: isFree ? 'Past stay' : 'Current stay',
      current: !isFree,
      name: occupant.name,
      contact: tenantContact(occupant),
      stage: occupant.status || 'ACTIVE',
      moveIn: occupant.since || null,
      moveOut: null,
      ref: null,
      invoice: null,
      paid: null,
      due: null,
      at: occupant.since || null,
    });
  } else if (u.tenant && u.tenant.name && !isFree) {
    items.push({
      kind: 'stay',
      kindLabel: 'Current stay',
      current: true,
      name: u.tenant.name,
      contact: [u.tenant.email, u.tenant.mobile].filter(Boolean).join(' · '),
      stage: 'ACTIVE',
      moveIn: null,
      moveOut: null,
      ref: null,
      invoice: null,
      paid: null,
      due: null,
      at: null,
    });
  }
  const pushBookingRow = (r, kind, kindLabel) => {
    if (rowUnitCode(r) !== code) return;
    // Skip the occupant's own current-stay duplicate when the names match and
    // there is no booking ref to link (keeps the timeline to real records).
    items.push({
      kind,
      kindLabel,
      name: r.tenant || r.name || '—',
      contact: [r.tenantType, r.tenantEmail, r.tenantMobile].filter(Boolean).join(' · '),
      stage: r.status || (r.invoiceStatus === 'OVERDUE' ? 'OVERDUE' : 'ACTIVE'),
      moveIn: r.moveInDate || null,
      moveOut: r.moveOutDate || r.endDate || null,
      ref: r.ref || null,
      invoice: r.invoiceStatus || null,
      paid: r.paidAmount,
      due: r.amountDue,
      amount: r.amount,
      at: r.moveInDate || r.createdAt || null,
    });
  };
  (bookings || []).forEach((r) => pushBookingRow(r, 'booking', 'Booking'));
  (moveins || []).forEach((r) => {
    // A move-in whose ref already appears as a booking enriches that booking's
    // dates instead of doubling the timeline — but only when the ref matches
    // exactly; otherwise it renders as its own move-in card.
    const dup = r.ref && items.some((it) => it.kind === 'booking' && it.ref === r.ref);
    if (dup) return;
    pushBookingRow(r, 'move-in', 'Move-in');
  });
  items.sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : -1;
    const tb = b.at ? new Date(b.at).getTime() : -1;
    return tb - ta;
  });
  return items;
}

function renderUdHistory() {
  const tl = $('#udTenantTimeline');
  const empty = $('#tenantHistoryEmpty');
  const sub = $('#udHistSub');
  const count = $('#udHistCount');
  if (!tl) return;
  tl.removeAttribute('aria-busy');
  const f = udEnrich.histFilter || '';
  const all = buildUnitHistory(udEnrich.code, udEnrich.unit || {}, udEnrich.tenants, udEnrich.bookings, udEnrich.moveins);
  const rows = all.filter((it) => histStageMatch(it.stage, f));
  if (count) {
    count.hidden = all.length === 0;
    count.textContent = String(all.length);
  }
  if (sub) sub.textContent = all.length ? `${all.length} stay${all.length === 1 ? '' : 's'} · newest first${f ? ' · ' + histLabel(f) : ''}` : 'Newest first';
  if (!rows.length) {
    tl.innerHTML = '';
    if (empty) {
      empty.hidden = false;
      empty.textContent = all.length
        ? 'No stays match this stage — clear the filter to see the full history.'
        : HISTORY_EMPTY_TEXT + ' — stays for this unit will appear here newest-first.';
    }
    return;
  }
  if (empty) empty.hidden = true;
  tl.innerHTML = rows.map((it) => {
    const tone = histTone(it.stage);
    const refs = [
      it.ref ? `<span class="ud-ref">${escapeHtml(it.kindLabel)} <b>${escapeHtml(it.ref)}</b></span>` : '',
      it.invoice ? `<span class="badge ${INVOICE_TONE[it.invoice] || 'res'}">${escapeHtml(it.invoice)}</span>` : '',
      it.paid != null || it.due != null
        ? `<span class="ud-ref">${fmtMoney(it.paid || 0)} paid${it.due ? ' · ' + fmtMoney(it.due) + ' due' : ''}</span>`
        : '',
    ].filter(Boolean).join('');
    const dates = [
      it.moveIn ? `<span>Moved in <b>${escapeHtml(fmtDay(it.moveIn))}</b></span>` : '',
      it.moveOut ? `<span>Moved out <b>${escapeHtml(fmtDay(it.moveOut))}</b></span>` : '',
      it.kind === 'stay' && !it.moveOut ? (it.current ? '<span>Current occupant</span>' : '<span>Past stay</span>') : '',
    ].filter(Boolean).join('');
    return `<li class="ud-titem tone-${tone}"><div class="ud-tcard">` +
      `<div class="ud-tcard-top"><b>${escapeHtml(it.name)}</b><span class="badge ${tone}">${escapeHtml(histLabel(it.stage))}</span></div>` +
      (it.contact ? `<div class="ud-tcard-contact">${escapeHtml(it.contact)}</div>` : '') +
      (dates ? `<div class="ud-tcard-meta">${dates}</div>` : '') +
      (refs ? `<div class="ud-tcard-refs">${refs}</div>` : '') +
      `</div></li>`;
  }).join('');
}

function bookingCardHtml(r) {
  const tone = BOOKING_TONE[r.status] || 'res';
  const inv = r.invoiceStatus ? `<span class="badge ${INVOICE_TONE[r.invoiceStatus] || 'res'}">${escapeHtml(r.invoiceStatus)}</span>` : '';
  const pay = `${fmtMoney(r.paidAmount || 0)} paid${r.amountDue ? ' · ' + fmtMoney(r.amountDue) + ' due' : ''}${r.method ? ' · ' + escapeHtml(r.method) : ''}`;
  return `<div class="alert-item"><div class="alert-body">` +
    `<div class="alert-title">${escapeHtml(r.ref || 'Booking')} · ${escapeHtml(r.tenant || '—')}</div>` +
    `<div class="alert-desc">${escapeHtml(fmtDay(r.moveInDate))} · ${escapeHtml(r.duration || '')} · ${fmtMoney(r.amount || 0)}${r.tenantEmail ? ' · ' + escapeHtml(r.tenantEmail) : ''}</div>` +
    `<div class="alert-desc">${escapeHtml(pay)}</div>` +
    `</div><div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;"><span class="badge ${tone}">${escapeHtml(String(r.status || '').replace(/_/g, ' '))}</span>${inv}</div></div>`;
}

function renderUdBookings() {
  const el = $('#udBookings');
  if (!el) return;
  const rows = (udEnrich.bookings || []).filter((r) => rowUnitCode(r) === udEnrich.code);
  const sub = $('#udBookingsSub');
  if (sub) sub.textContent = rows.length ? `${rows.length} booking${rows.length === 1 ? '' : 's'} linked to this unit` : 'Linked reservations for this unit';
  el.innerHTML = rows.length
    ? rows.map(bookingCardHtml).join('')
    : '<div class="ud-history-empty">No bookings for this unit yet.</div>';
}

function renderUdInvoices() {
  const el = $('#udInvoices');
  if (!el) return;
  const rows = (udEnrich.bookings || [])
    .filter((r) => rowUnitCode(r) === udEnrich.code && (r.invoiceStatus || r.amountDue || r.paidAmount));
  const sub = $('#udInvoicesSub');
  if (sub) sub.textContent = rows.length ? `${rows.length} invoice${rows.length === 1 ? '' : 's'} · from recorded bookings` : 'Derived from recorded bookings';
  el.innerHTML = rows.length
    ? rows.map((r) => {
      const tone = INVOICE_TONE[r.invoiceStatus] || 'res';
      return `<div class="alert-item"><div class="alert-body">` +
        `<div class="alert-title">${escapeHtml(r.ref || 'Invoice')} · ${escapeHtml(r.tenant || '—')}</div>` +
        `<div class="alert-desc">${fmtMoney(r.paidAmount || 0)} paid${r.amountDue ? ' · ' + fmtMoney(r.amountDue) + ' due' : ''}${r.method ? ' · ' + escapeHtml(r.method) : ''}</div>` +
        `</div><span class="badge ${tone}">${escapeHtml(r.invoiceStatus || 'DUE')}</span></div>`;
    }).join('')
    : '<div class="ud-history-empty">No invoices for this unit yet.</div>';
}

function renderUdActivity() {
  const el = $('#udUnitActivity');
  if (!el) return;
  const rows = (udEnrich.activity || []).filter((a) => (a.unitCode || (a.unit && a.unit.code)) === udEnrich.code);
  el.innerHTML = rows.length
    ? rows.map((a) => `<div class="alert-item"><div class="alert-body"><div class="alert-title">${escapeHtml(a.message || a.type || 'Event')}</div>` +
      `<div class="alert-desc">${escapeHtml(fmtDateTime(a.at))} · ${escapeHtml(timeAgo(a.at))}</div></div></div>`).join('')
    : '<div class="ud-history-empty">No recent activity for this unit.</div>';
}

async function enrichUnitDetail(code, u) {
  const seq = ++udEnrich.seq;
  udEnrich.unit = u;
  const settled = await Promise.allSettled([
    get('/tenants'),
    get('/bookings'),
    get('/move-ins'),
    get('/units/activity?limit=100'),
  ]);
  if (seq !== udEnrich.seq || udEnrich.code !== code) return; // stale: a newer unit won
  const [tenants, bookings, moveins, activity] = settled;
  const failures = [];
  udEnrich.tenants = tenants.status === 'fulfilled' ? tenants.value || [] : (failures.push('tenants'), []);
  udEnrich.bookings = bookings.status === 'fulfilled' ? bookings.value || [] : (failures.push('bookings'), []);
  udEnrich.moveins = moveins.status === 'fulfilled' ? moveins.value || [] : (failures.push('move-ins'), []);
  udEnrich.activity = activity.status === 'fulfilled' ? activity.value || [] : (failures.push('activity'), []);
  if (failures.length === 4) {
    setUdState('#udHistState', 'Couldn’t load history — check your connection and retry.', true);
    const tl = $('#udTenantTimeline');
    if (tl) {
      tl.innerHTML = `<li class="ud-titem tone-neutral"><div class="ud-tcard"><div class="ud-tcard-top"><b>History unavailable</b></div>` +
        `<div class="ud-tcard-contact">The tenants, bookings, move-ins and activity reads all failed.</div>` +
        `<div class="ud-tcard-refs"><button class="act-btn" data-act="ud-retry" type="button">Retry</button></div></div></li>`;
      tl.querySelector('[data-act="ud-retry"]')?.addEventListener('click', () => {
        if (udEnrich.code) { paintUdLoading(udEnrich.code); enrichUnitDetail(udEnrich.code, udEnrich.unit || {}); }
      });
    }
    setUdState('#udBookingsState', '', false);
    setUdState('#udInvoicesState', '', false);
    setUdState('#udActivityState', '', false);
    renderUdBookings();
    renderUdInvoices();
    renderUdActivity();
    return;
  }
  if (failures.length) {
    setUdState('#udHistState', `History is partial — ${failures.join(', ')} unavailable.`, true);
  } else {
    setUdState('#udHistState', '', false);
  }
  setUdState('#udBookingsState', '', false);
  setUdState('#udInvoicesState', '', false);
  setUdState('#udActivityState', '', false);
  renderUdHistory();
  renderUdBookings();
  renderUdInvoices();
  renderUdActivity();
}

// P1 item 3: unit-drawer facility-ops sections (read from the in-tree P0
// tables via GET /units/:code → data.operations). Branch-scoped where the P0
// model carries no unit FK (inspections / certificates / access history);
// unit-scoped work orders + incidents where the FK exists.
function renderUnitOps(ops) {
  const insp = $('#udInspections');
  if (insp) {
    const rows = (ops && ops.inspections) || [];
    insp.innerHTML = rows.length
      ? rows.map((c) => `<div class="alert-item"><div class="alert-body"><div class="alert-title">${escapeHtml(c.title)}</div><div class="alert-desc">${escapeHtml(c.frequency || '')} · ${escapeHtml(c.status || '')} · ${c.percentComplete || 0}%</div></div></div>`).join('')
      : '<div class="ud-history-empty">No inspections for this facility yet.</div>';
  }
  const cert = $('#udCertificates');
  if (cert) {
    const rows = (ops && ops.certificates) || [];
    cert.innerHTML = rows.length
      ? rows.map((c) => `<div class="alert-item"><div class="alert-body"><div class="alert-title">${escapeHtml(c.name)}</div><div class="alert-desc">${escapeHtml(c.type || '')} · expires ${c.expiryDate ? new Date(c.expiryDate).toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'} · ${escapeHtml(c.status || '')}</div></div></div>`).join('')
      : '<div class="ud-history-empty">No compliance certificates for this facility yet.</div>';
  }
  const acc = $('#udAccess');
  if (acc) {
    const rows = (ops && ops.accessHistory) || [];
    acc.innerHTML = rows.length
      ? rows.map((e) => `<div class="alert-item"><div class="alert-body"><div class="alert-title">${escapeHtml(e.holder || e.door?.code || 'Event')} · ${escapeHtml(e.result || '')}</div><div class="alert-desc">${e.occurredAt ? new Date(e.occurredAt).toLocaleString('en-SG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}${e.door?.name ? ' · ' + escapeHtml(e.door.name) : ''}</div></div></div>`).join('')
      : '<div class="ud-history-empty">No access history for this facility yet.</div>';
  }
  const wo = $('#udWorkOrders');
  if (wo) {
    const rows = (ops && ops.workOrders) || [];
    wo.innerHTML = rows.length
      ? rows.map((w) => `<div class="alert-item"><div class="alert-body"><div class="alert-title">${escapeHtml(w.title)}</div><div class="alert-desc">${escapeHtml(w.status || '')}${w.priority ? ' · ' + escapeHtml(w.priority) : ''}</div></div></div>`).join('')
      : '<div class="ud-history-empty">No work orders for this unit yet.</div>';
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
  if (!sel) return;
  // Level selectors show ACTIVE floors only: inactive (hidden) floors are not
  // selectable here (POST /units refuses them) and are reactivated via the
  // Floors management list, which keeps showing all rows.
  const floors = state.floors
    .filter((f) => f.branchId === branchId && f.isActive !== false)
    .sort((a, c) => a.level - c.level);
  // Edit mode: the unit's own floor stays selectable (labelled) even if it
  // was deactivated after the unit was created — the form never strands an
  // existing unit. Create mode (no `selected`) lists active floors only.
  const current = selected ? state.floors.find((f) => f.id === selected) : null;
  const rows = current && current.isActive === false && !floors.some((f) => f.id === current.id)
    ? [...floors, current].sort((a, c) => a.level - c.level)
    : floors;
  sel.innerHTML = rows.length
    ? rows.map((f) => `<option value="${f.id}">Level ${f.level} (${f.branch.code})${f.isActive === false ? ' — inactive' : ''}</option>`).join('')
    : '<option value="">No active floors — reactivate one in Floors</option>';
  if (selected && rows.some((f) => f.id === selected)) sel.value = selected;
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
  const createOnly = ['AVAILABLE', 'RESERVED', 'MAINTENANCE', 'BLOCKED'];
  const all = ['OCCUPIED', 'AVAILABLE', 'RESERVED', 'OVERDUE', 'MAINTENANCE', 'INACTIVE', 'BLOCKED'];
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
  hasAC: 'hasAC',
  hasPillar: 'hasPillar',
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
  $('#f-hasAC').value = 'no';
  $('#f-hasPillar').value = 'no';
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
    $('#f-hasAC').value = u.hasAC ? 'yes' : 'no';
    $('#f-hasPillar').value = u.hasPillar ? 'yes' : 'no';
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
    hasAC: $('#f-hasAC').value === 'yes',
    hasPillar: $('#f-hasPillar').value === 'yes',
  };
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
      // PUT /units/:code accepts sqft / monthlyRate / status / hasAC / hasPillar / name.
      // Name: non-empty → set it; empty → name: null (clears back to the unit code).
      const patch = {
        sqft: body.sqft,
        monthlyRate: body.monthlyRate,
        status: body.status,
        hasAC: body.hasAC,
        hasPillar: body.hasPillar,
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
  if (unit && (unit.status === 'OCCUPIED' || unit.status === 'OVERDUE' || unit.status === 'RESERVED')) {
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
  const ok = await confirmDialog({
    title: `Delete unit ${code}?`,
    message: 'This soft-deletes it (removes it from the map and lists).',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
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

// ---------- templated CSV import (Import button + file picker) ----------
// Reads the picked .csv as text and POSTs { csv } to /units/import. The result
// summary (created / skipped / errors) toasts via the banner; per-row errors
// surface in the units banner (first 8) with the full list in the console.
export async function importUnitsFile(file) {
  setUnitsBanner('');
  try {
    const text = await file.text();
    const body = await request('/units/import', { method: 'POST', body: JSON.stringify({ csv: text }) });
    const m = body.meta || { total: 0, created: 0, skipped: 0, errors: 0 };
    const failed = (body.data || []).filter((r) => r.status === 'error');
    if (failed.length) {
      // eslint-disable-next-line no-console
      console.warn('[units import] row errors:', body.data);
      setUnitsBanner(
        `Import: ${m.created} created · ${m.skipped} skipped · ${m.errors} errors — ` +
        failed.slice(0, 8).map((r) => `row ${r.row}: ${r.message}`).join(' · ') +
        (failed.length > 8 ? ` · …+${failed.length - 8} more (see console)` : ''),
        '',
      );
    }
    showBanner(`Import: ${m.created} created · ${m.skipped} skipped · ${m.errors} errors`, failed.length === 0);
    await refreshAll();
  } catch (err) {
    showBanner('Import: ' + describeError(err));
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

// StoreLah CMS admin UI — data layer + units CRUD for /admin.
// Served at /admin; talks to the same /api/v1/cms endpoints the frozen dashboard uses,
// plus the reference endpoints (/floors, /sizes) and full units CRUD.
//
// Phase-1 layering refactor (nodebestpractices #1): foundation layers were
// extracted to ES modules — api.js (auth/transport), dom.js (queries, escaping,
// banner), constants.js (tone maps, labels, formatters). This file remains the
// entry module: view renderers and event wiring. Phase-2 moved shared state +
// facility selectors into state.js and the bookings/move-ins views into
// bookingsView.js; dependencies stay one-way (views → state/api/dom/constants).
import { ALL_FACILITIES } from './constants.js';
import { $, $$, escapeHtml, timeAgo, showBanner } from './dom.js';
import { login, get, describeError } from './api.js';
import { state, isAllFacilities } from './state.js';
import { refreshBookingsView, bindBookingsTable, refreshMoveinsView } from './bookingsView.js';
import {
  initCharts,
  bindKpis,
  bindCharts,
  renderFloorTabs,
  fetchUnitMap,
  syncFacilityDashboard,
} from './dashboardView.js';
import {
  setRefreshAll as tenantsSetRefreshAll,
  bindTenants,
  bindTenantsView,
  refreshTenantsView,
  openCreateTenant,
  openEditTenant,
  closeTenantModal,
  submitTenantForm,
  deactivateTenant,
} from './tenantsView.js';
import {
  setRefreshAll as unitsSetRefreshAll,
  setRefsLoader as unitsSetRefsLoader,
  fetchUnitsPage,
  showUnitDetail,
  getSelectedUnitCode,
  onUnitSizeChange,
  populateFloorSelect,
  openCreateForm,
  openEditForm,
  closeUnitModal,
  submitUnitForm,
  deleteUnit,
  openRateForm,
  closeRateModal,
  submitRateForm,
} from './unitsView.js';
import { setRefsLoader as fpSetRefsLoader, fpInitEvents, fpOpen, fpViewClose, getFpViewFloorId } from './floorplanView.js';

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

  // ---------- latest unit activity feed ----------
  const ACT_META = {
    unit_created: { icon: '🆕', tone: 'olive' },
    unit_updated: { icon: '✏️', tone: 'terra' },
    rate_change: { icon: '💱', tone: 'amber' },
    move_in: { icon: '🔑', tone: 'teal' },
    booking: { icon: '📅', tone: 'olive' },
  };

  function bindActivity(items) {
    const list = $('#activityFeed');
    if (!list) return;
    if (!items || !items.length) {
      list.innerHTML = '<div class="alert-desc" style="padding:10px 0;">No unit activity yet.</div>';
      return;
    }
    list.innerHTML = (items || [])
      .map((it) => {
        const meta = ACT_META[it.type] || { icon: '•', tone: '' };
        const desc = it.actor
          ? `by ${escapeHtml(it.actor)}`
          : it.unit && it.unit.branch
            ? `· ${escapeHtml(it.unit.branch)}`
            : '';
        return `<div class="alert-item">
          <div class="alert-icon ${meta.tone}">${meta.icon}</div>
          <div class="alert-body"><div class="alert-title">${escapeHtml(it.message)}</div><div class="alert-desc">${desc}</div></div>
          <div class="alert-time">${timeAgo(it.at)}</div>
        </div>`;
      })
      .join('');
  }

  // ---------- reference data ----------
  async function loadRefs() {
    const [branches, floors, sizes] = await Promise.all([get('/branches'), get('/floors'), get('/sizes')]);
    state.branches = branches;
    state.floors = floors;
    state.sizes = sizes;
    // Populate the sidebar facility select (All Facilities + branches).
    renderFacilitySelect();
  }

  // ---------- refresh ----------
  async function refreshUnitsView() {
    await Promise.all([
      fetchUnitsPage().catch(() => {}),
      fetchUnitMap().catch(() => {}),
    ]);
  }

  async function refreshAll() {
    const [summary, activity, tenants, leads, actions] = await Promise.all([
      get('/summary').catch(() => null),
      get('/units/activity?limit=20').catch(() => []),
      get('/tenants').catch(() => []),
      get('/leads').catch(() => []),
      get('/action-items').catch(() => []),
    ]);
    bindKpis(summary);
    bindCharts(summary);
    bindActivity(activity);
    bindTenants(tenants);
    bindLeads(leads);
    bindActions(actions);
    if (state.view === 'units') await refreshUnitsView();
    else if (state.view === 'tenants') await refreshTenantsView();
    else if (state.view === 'floorplans') await fpOpen();
  }

  // ---------- reactive canvas sizing (live W/H edits) ----------
  // Editing the Canvas Width/Height inputs re-sizes the visible canvas in real
  // time (debounced while typing, committed on change/blur) instead of waiting
  // for Save Canvas. This update is LOCAL and unsaved — fpSaveCanvas remains
  // the only commit that persists width/height/structure to the server.

  // ---------- decoration blocks (name+rect rectangles; see FloorPlanBlock) ----------
  // A block is a plain name+rect primitive with no behaviour beyond display. The
  // drag/resize machinery mirrors the placed-unit machinery (including the
  // offset-capture-before-render fix); persistence goes to
  // PUT /floor-plans/:floorId/blocks/:blockId.

  // Hand the same branch + level to the Floor Plans editor and navigate there.
  function fpViewEdit() {
    // Under All Facilities there is no single branch to edit — fall back to the
    // first concrete facility so the editor never receives the 'ALL' sentinel.
    state.fp.branchCode = isAllFacilities() ? state.branches[0]?.code || state.fp.branchCode : state.branchCode;
    state.fp.floorId = getFpViewFloorId();
    fpViewClose();
    switchView('floorplans');
  }

  // ---------- sidebar navigation ----------
  function switchView(view) {
    state.view = view;
    ['dashboard', 'units', 'tenants', 'bookings', 'moveins', 'floorplans'].forEach((v) => {
      const el = $(`#view-${v}`);
      if (el) el.hidden = view !== v;
    });
    $$('.nav-item[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    try {
      history.replaceState(null, '', view === 'dashboard' ? '#' : `#${view}`);
    } catch (e) {
      /* file:// or sandboxed contexts may reject replaceState */
    }
    if (view === 'units') refreshUnitsView();
    else if (view === 'tenants') refreshTenantsView();
    else if (view === 'bookings') refreshBookingsView();
    else if (view === 'moveins') refreshMoveinsView();
    else if (view === 'floorplans') fpOpen();
  }

  // Populate the sidebar facility <select> (All Facilities + one per branch).
  function renderFacilitySelect() {
    const sel = $('#sbBranchSelect');
    if (!sel) return;
    const options = [{ code: ALL_FACILITIES, name: 'All Facilities' }, ...state.branches];
    sel.innerHTML = options
      .map((b) => `<option value="${b.code}">${b.name}</option>`)
      .join('');
    if (!options.some((b) => b.code === state.branchCode)) state.branchCode = ALL_FACILITIES;
    sel.value = state.branchCode;
  }

  // Re-render whatever the current view shows under the active facility filter.
  function refreshForFacility() {
    if (state.view === 'units') {
      renderFloorTabs();
      state.page = 1;
      fetchUnitsPage().catch((err) => showBanner('Units: ' + describeError(err)));
    } else if (state.view === 'dashboard') {
      syncFacilityDashboard();
    } else if (state.view === 'tenants') {
      state.tenantPage = 1;
      bindTenantsView();
    } else if (state.view === 'bookings') {
      bindBookingsTable();
    } else if (state.view === 'moveins') {
      refreshMoveinsView();
    }
  }

  function onFacilityChange() {
    const sel = $('#sbBranchSelect');
    if (!sel || !sel.value) return;
    state.branchCode = sel.value;
    syncFacilityDashboard();
    refreshForFacility();
  }

  // ---------- events ----------
  function wireEvents() {
    // sidebar navigation
    $$('.nav-item[data-view]').forEach((el) =>
      el.addEventListener('click', () => switchView(el.dataset.view)),
    );
    // bookings view: search + status filter (client-side, mirrors tenants)
    $('#bookingSearch')?.addEventListener('input', bindBookingsTable);
    $('#bookingStatusFilter')?.addEventListener('change', bindBookingsTable);
    $('#sbBranchSelect').addEventListener('change', onFacilityChange);
    // units section: floor tabs, filters, pager
    $('#floorTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.floor-tab[data-level]');
      if (!btn) return;
      const level = Number(btn.dataset.level);
      if (level === state.level) return;
      state.level = level;
      state.page = 1;
      refreshUnitsView();
    });
    $('#statusFilter').addEventListener('change', (e) => {
      state.statusFilter = e.target.value;
      state.page = 1;
      fetchUnitsPage().catch(() => {});
    });
    $('#pagePrev').addEventListener('click', () => {
      if (state.page <= 1) return;
      state.page -= 1;
      fetchUnitsPage().catch(() => {});
    });
    $('#pageNext').addEventListener('click', () => {
      if (state.page >= state.totalPages) return;
      state.page += 1;
      fetchUnitsPage().catch(() => {});
    });
    // units CRUD
    $('#addUnitBtn').addEventListener('click', openCreateForm);
    $('#unitModalClose').addEventListener('click', closeUnitModal);
    $('#unitFormCancel').addEventListener('click', closeUnitModal);
    $('#unitForm').addEventListener('submit', submitUnitForm);
    $('#rateModalClose').addEventListener('click', closeRateModal);
    $('#rateFormCancel').addEventListener('click', closeRateModal);
    $('#rateForm').addEventListener('submit', submitRateForm);
    $('#editUnitBtn').addEventListener('click', () => {
      const code = getSelectedUnitCode();
      if (code) openEditForm(code);
      else showBanner('Select a unit first (click a cell or a View button).');
    });
    $('#adjustRateBtn').addEventListener('click', () => {
      const code = getSelectedUnitCode();
      if (code) openRateForm(code);
      else showBanner('Select a unit first (click a cell or a View button).');
    });
    $('#deleteUnitBtn').addEventListener('click', () => {
      const code = getSelectedUnitCode();
      if (code) deleteUnit(code);
    });
    $('#f-branch').addEventListener('change', (e) => populateFloorSelect(e.target.value));
    $('#f-size').addEventListener('change', onUnitSizeChange);
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
    // tenants CRUD
    $('#addTenantBtn').addEventListener('click', openCreateTenant);
    $('#tenantModalClose').addEventListener('click', closeTenantModal);
    $('#tenantFormCancel').addEventListener('click', closeTenantModal);
    $('#tenantForm').addEventListener('submit', submitTenantForm);
    $('#tenantSearch').addEventListener('input', (e) => {
      state.tenantQuery = e.target.value;
      state.tenantPage = 1;
      bindTenantsView();
    });
    $('#tenantStatusFilter').addEventListener('change', (e) => {
      state.tenantStatusFilter = e.target.value;
      state.tenantPage = 1;
      bindTenantsView();
    });
    $('#tenantsPagePrev').addEventListener('click', () => {
      if (state.tenantPage <= 1) return;
      state.tenantPage -= 1;
      bindTenantsView();
    });
    $('#tenantsPageNext').addEventListener('click', () => {
      if (state.tenantPage >= state.tenantTotalPages) return;
      state.tenantPage += 1;
      bindTenantsView();
    });
    $('#tenantsViewTable').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const { act, tid } = btn.dataset;
      if (act === 'view' || act === 'edit') openEditTenant(tid);
      else if (act === 'deactivate') deactivateTenant(tid);
    });
    fpInitEvents();
    // close modals on overlay click
    $$('.modal-overlay').forEach((ov) => {
      ov.addEventListener('click', (e) => {
        if (e.target === ov) {
          if (ov.id === 'unitModal') closeUnitModal();
          else if (ov.id === 'rateModal') closeRateModal();
          else if (ov.id === 'tenantModal') closeTenantModal();
          else if (ov.id === 'fpViewModal') fpViewClose();
        }
      });
    });
    // Escape dismisses whichever modal is open (read-only preview included).
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const fpViewOv = $('#fpViewModal');
      if (fpViewOv && !fpViewOv.hidden) fpViewClose();
      else if (!$('#unitModal').hidden) closeUnitModal();
      else if (!$('#rateModal').hidden) closeRateModal();
      else if (!$('#tenantModal').hidden) closeTenantModal();
    });
  }

  // ---------- boot ----------
  async function boot() {
    try {
      // Dependency inversion: views call back into the entry's refresh/load
      // hooks instead of importing this module (one-way dependency rule).
      tenantsSetRefreshAll(refreshAll);
      unitsSetRefreshAll(refreshAll);
      unitsSetRefsLoader(loadRefs);
      fpSetRefsLoader(loadRefs);
      await login();
      initCharts();
      await Promise.all([loadRefs(), refreshAll()]);
      if (location.hash === '#units') switchView('units');
      else if (location.hash === '#tenants') switchView('tenants');
      else if (location.hash === '#bookings') switchView('bookings');
      else if (location.hash === '#moveins') switchView('moveins');
      else if (location.hash === '#floorplans') switchView('floorplans');
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

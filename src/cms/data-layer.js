// StoreLah CMS data layer — binds live API data into the frozen dashboard UI.
// The dashboard HTML/CSS layout is treated as immutable; only data bindings run here.

(function () {
  const API = '/api/cms';
  let token = null;

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

  async function get(path) {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()).data;
  }

  const $ = (s) => document.querySelector(s);
  const kpiVal = (i) => document.querySelectorAll('.kpi-strip .kpi')[i]?.querySelector('.kpi-val');
  const kpiDelta = (i) => document.querySelectorAll('.kpi-strip .kpi')[i]?.querySelector('.kpi-delta');
  const fmtMoney = (n) => '$' + n.toLocaleString('en-US');

  function bindKpis(s) {
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
    const rc = Chart.getChart && Chart.getChart('revenueChart');
    if (rc) {
      rc.data.labels = s.monthlyRevenue.labels;
      rc.data.datasets[0].data = s.monthlyRevenue.actual;
      rc.data.datasets[1].data = s.monthlyRevenue.target;
      rc.update();
    }
    const bc = Chart.getChart && Chart.getChart('branchChart');
    if (bc) {
      bc.data.labels = s.occupancyByBranch.map((b) => b.name);
      bc.data.datasets[0].data = s.occupancyByBranch.map((b) => b.occupancyPct);
      bc.update();
    }
  }

  const STATUS_TONE = {
    occupied: 'occupied',
    available: 'available',
    reserved: 'reserved',
    overdue: 'overdue',
    maintenance: 'maintenance',
  };

  async function bindUnitMap() {
    if (!document.querySelector('.u-cell')) return;

    const map = await get(`/units/map?branch=BM&level=1`);
    const byShort = new Map(map.units.map((u) => [u.short, u]));

    // Re-sync each existing cell from live data (layout preserved via same classes).
    document.querySelectorAll('.u-cell').forEach((el) => {
      const short = el.querySelector('.u-id')?.textContent;
      const data = byShort.get(short);
      if (!data) return;
      el.className = 'u-cell ' + (STATUS_TONE[data.status] || 'available');
      const size = el.querySelector('.u-size');
      const psf = el.querySelector('.u-psf');
      if (size) size.textContent = data.size;
      if (psf) {
        psf.textContent = data.psf ? '$' + data.psf.toFixed(2) : 'Maint.';
        psf.removeAttribute('style');
      }
      // normalise the inline onclick id so the sidebar opens the right unit
      el.onclick = () => selectUnit(el, data.code);
    });
  }

  async function bindTenants() {
    const rows = await get('/tenants');
    const card = [...document.querySelectorAll('.tbl-card')].find(
      (c) => c.querySelector('.sec-title')?.textContent === 'All Tenants',
    );
    if (!card) return;
    const tbody = card.querySelector('tbody');
    if (!tbody) return;
    const statusClass = { ACTIVE: 'occ', DUE_SOON: 'res', OVERDUE: 'over', NOTICE: 'amber' };
    tbody.innerHTML = rows
      .map((t) => {
        const since = t.since ? new Date(t.since).toLocaleString('en-SG', { month: 'short', year: 'numeric' }) : '—';
        const next = t.nextPayment ? new Date(t.nextPayment).toLocaleDateString('en-SG', { day: '2-digit', month: 'short' }) : '—';
        return `<tr>
          <td><div class="t-name">${t.name}</div><div class="t-type">${t.type.toLowerCase()}${t.segment ? ' · ' + t.segment : ''}</div></td>
          <td><strong>${t.unit || '—'}</strong></td><td>${t.size || '—'}${t.sqft ? ' · ' + t.sqft + ' sqft' : ''}</td>
          <td><strong>${fmtMoney(t.rate)}</strong></td><td><span class="psf-val">$${t.psf.toFixed(2)}</span></td>
          <td>${since}</td><td>${next}</td>
          <td><span class="badge ${statusClass[t.status] || 'occ'}">${t.status.replace('_', ' ')}</span></td>
          <td><button class="act-btn" style="font-size:10px;padding:3px 8px;">Manage</button></td>
        </tr>`;
      })
      .join('');
  }

  async function bindLeads() {
    const data = await get('/leads');
    const board = document.querySelector('.kanban-board');
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
    data.forEach((col) => {
      const inner = document.createElement('div');
      inner.className = 'k-col';
      inner.innerHTML = `
        <div class="k-col-hdr"><div class="k-col-title">${stageLabel[col.stage] ?? col.stage}</div><div class="k-count">${col.count}</div></div>
        ${col.leads
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

  async function bindActions() {
    const data = await get('/action-items');
    const card = [...document.querySelectorAll('.tbl-card')].find(
      (c) => c.querySelector('.sec-title')?.textContent === 'Action Required',
    );
    if (!card) return;
    const list = card.querySelector('.alert-list');
    if (!list) return;
    list.innerHTML = data
      .map(
        (it) => `<div class="alert-item">
          <div class="alert-icon ${it.tone}">${it.icon}</div>
          <div class="alert-body"><div class="alert-title">${it.title}</div><div class="alert-desc">${it.desc}</div></div>
          <div class="alert-time">${it.time}</div>
          <button class="alert-act">${it.action}</button>
        </div>`,
      )
      .join('');
    // sync sidebar badge
    const badge = document.querySelector('.nav-badge.red');
    if (badge) badge.textContent = data.length;
  }

  async function boot() {
    try {
      await login();
      const summary = await get('/summary');
      bindKpis(summary);
      bindCharts(summary);
      await Promise.all([bindUnitMap(), bindTenants(), bindLeads(), bindActions()]);
    } catch (e) {
      console.error('[storelah] data layer failed', e);
      // hint the operator to configure admin credentials
      const top = document.querySelector('.topbar');
      if (top) {
        top.innerHTML += `<div style="color:var(--red);font-size:11px;margin-left:12px;">Data layer error: ${e.message}</div>`;
      }
    }
  }

  function getSummary() {
    return get('/summary');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
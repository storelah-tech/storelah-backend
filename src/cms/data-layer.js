// StoreLah CMS data layer — v8 themed, binds live data into dashboard.html.
// Auth: GET /api/cms/config → login → Bearer JWT.

(function () {
  const API = '/api/cms';
  let token = null;

  async function getCreds() {
    const res = await fetch(API + '/config');
    if (!res.ok) throw new Error('admin credentials not configured (set STORELAH_ADMIN_*)');
    return res.json();
  }

  async function login() {
    const CREDS = await getCreds();
    const res = await fetch(API + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CREDS),
    });
    if (!res.ok) throw new Error('login failed');
    const body = await res.json();
    token = body.data.token;
  }

  async function get(path) {
    const res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error(path + ' -> ' + res.status);
    return (await res.json()).data;
  }

  const esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var $ = function (s) { return document.querySelector(s); };

  function fmtDay(d) {
    return d ? new Date(d).toLocaleDateString('en-SG', { day: '2-digit', month: 'short' }) : '—';
  }

  // ============= COMMAND CENTRE =============
  function bindCommandStats(s, leadsData, actions) {
    var flat = [];
    (leadsData || []).forEach(function (col) {
      (col.leads || []).forEach(function (l) { flat.push(l); });
    });
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var newToday = flat.filter(function (l) { return new Date(l.createdAt) >= today; }).length;
    var awaiting = 0;
    (leadsData || []).forEach(function (col) {
      if (col.stage === 'NEW_ENQUIRY') awaiting = col.count;
    });
    var stats = $('#cmdStats');
    if (!stats) return;
    var k = s && s.kpis;
    stats.innerHTML =
      '<div class="stat"><div class="label">New leads today</div><div class="val">' + newToday + '</div></div>' +
      '<div class="stat"><div class="label">Awaiting response</div><div class="val">' + awaiting + '</div></div>' +
      '<div class="stat"><div class="label">Occupancy</div><div class="val">' + (k ? k.occupancyPct : '—') + '%</div></div>' +
      '<div class="stat"><div class="label">MRR</div><div class="val">' + (k ? '$' + (k.mrr || 0).toLocaleString() : '—') + '</div></div>' +
      '<div class="stat"><div class="label">Actions</div><div class="val">' + (actions ? actions.length : 0) + '</div></div>';
    // Badge
    var badge = $('#leadsBadge');
    if (badge) badge.textContent = awaiting;
  }

  function bindFunnel(leadsData) {
    var funnel = $('#commandFunnel');
    if (!funnel || !leadsData) return;
    var stageLabel = { NEW_ENQUIRY: 'New', CONTACTED: 'Contacted', VIEWING_BOOKED: 'Qualified', PROPOSAL_SENT: 'Quoted', WON: 'Booked', LOST: 'Lost' };
    funnel.innerHTML = leadsData.map(function (s) {
      return '<div class="fstep"><b>' + s.count + '</b><span>' + (stageLabel[s.stage] || s.stage) + '</span></div>';
    }).join('');
  }

  function bindQueue(actions) {
    var q = $('#cmdQueue');
    if (!q) return;
    if (!actions || !actions.length) { q.innerHTML = '<div class="section-empty">No priority items.</div>'; return; }
    q.innerHTML = actions.slice(0, 5).map(function (it) {
      var color = it.tone === 'red' ? 'var(--red)' : it.tone === 'amber' ? 'var(--amber)' : 'var(--terra)';
      return '<div class="qitem"><span class="dot" style="background:' + color + '"></span><div><b>' + esc(it.title) + '</b><br><small>' + esc(it.desc) + '</small></div><span class="pill ' + (it.tone === 'red' ? 'red' : it.tone === 'amber' ? 'amber' : 'green') + '">' + esc(it.action) + '</span></div>';
    }).join('');
  }

  function bindSources(leadsData) {
    var el = $('#cmdSources');
    if (!el || !leadsData) return;
    var counts = {};
    (leadsData || []).forEach(function (col) {
      (col.leads || []).forEach(function (l) {
        var key = (l.source || 'website').toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
      });
    });
    var max = Math.max(1, Object.values(counts).reduce(function (a, b) { return Math.max(a, b); }, 1));
    var labels = { website: 'Google/Web', whatsapp: 'WhatsApp', referral: 'Referral', google: 'Google Ads' };
    el.innerHTML = Object.entries(counts).map(function (e) {
      return '<div class="source-row"><b>' + (labels[e[0]] || e[0]) + '</b><div class="bar"><i style="width:' + (e[1] / max * 100) + '%"></i></div><span>' + e[1] + '</span></div>';
    }).join('');
  }

  function bindCharts(s) {
    if (!s) return;
    var rc = Chart.getChart && Chart.getChart('revenueChart');
    if (rc && s.monthlyRevenue) {
      rc.data.labels = s.monthlyRevenue.labels;
      rc.data.datasets[0].data = s.monthlyRevenue.actual;
      rc.data.datasets[1].data = s.monthlyRevenue.target;
      rc.update();
    }
    var bc = Chart.getChart && Chart.getChart('branchChart');
    if (bc && s.occupancyByBranch) {
      bc.data.labels = s.occupancyByBranch.map(function (b) { return b.name; });
      bc.data.datasets[0].data = s.occupancyByBranch.map(function (b) { return b.occupancyPct; });
      bc.update();
    }
  }

  // ============= UNIT SNAPSHOT =============
  function bindUnitSnapshot(data) {
    var grid = $('#unitSnapshot');
    if (!grid || !data) return;
    var tones = { OCCUPIED: 'occ', AVAILABLE: 'avail', RESERVED: 'res', OVERDUE: 'over', MAINTENANCE: 'occ' };
    var count = data.units ? data.units.length : 0;
    grid.innerHTML = (data.units || []).slice(0, 25).map(function (u) {
      return '<div class="u ' + (tones[u.status.toUpperCase()] || 'occ') + '" title="' + esc(u.code) + '">' + esc(u.short) + '</div>';
    }).join('');
  }

  // ============= ACTIONS =============
  function bindActions(data) {
    var list = $('#actionList');
    if (!list) return;
    if (!data || !data.length) { list.innerHTML = '<div class="alert-desc" style="padding:10px 0;">All clear — no action items.</div>'; return; }
    list.innerHTML = data.map(function (it) {
      return '<div class="alert-item"><div class="alert-icon ' + it.tone + '">' + it.icon + '</div><div class="alert-body"><div class="alert-title">' + esc(it.title) + '</div><div class="alert-desc">' + esc(it.desc) + '</div></div><div class="alert-time">' + it.time + '</div><button class="alert-act">' + esc(it.action) + '</button></div>';
    }).join('');
  }

  // ============= LEADS TABLE =============
  function bindLeadTable(leadsData) {
    var tbody = $('#leadRows');
    var count = $('#leadCount');
    if (!tbody) return;
    var flat = [];
    (leadsData || []).forEach(function (col) {
      (col.leads || []).forEach(function (l) { flat.push({ stage: col.stage, stageLabel: col.stage, count: col.count, leads: [], id: l.id, name: l.name, type: l.type, segment: l.segment, size: l.size, branchCode: l.branchCode, source: l.source, monthlyRate: l.monthlyRate, createdAt: l.createdAt }); });
    });
    if (count) count.textContent = flat.length + ' leads';
    if (!flat.length) { tbody.innerHTML = '<tr><td colspan="7"><div class="section-empty">No leads yet.</div></td></tr>'; return; }
    tbody.innerHTML = flat.map(function (l) {
      var initial = (l.name || '?').charAt(0).toUpperCase();
      var heat = '<div class="heat">';
      var h = l.stage === 'WON' || l.stage === 'PROPOSAL_SENT' ? 5 : l.stage === 'VIEWING_BOOKED' ? 4 : l.stage === 'CONTACTED' ? 3 : 2;
      for (var i = 0; i < 5; i++) heat += '<i' + (i < h ? ' class="on"' : '') + '></i>';
      heat += '</div>';
      return '<tr><td><div class="contact"><div class="avatar">' + initial + '</div><div><b>' + esc(l.name) + '</b><small>' + (l.type === 'BUSINESS' ? 'Business' : 'Personal') + (l.segment ? ' · ' + esc(l.segment) : '') + '</small></div></div></td><td><span class="pill ' + (l.stage === 'NEW_ENQUIRY' ? 'red' : l.stage === 'WON' ? 'green' : l.stage === 'LOST' ? '' : 'amber') + '">' + (l.stageLabel || l.stage).replace(/_/g, ' ') + '</span></td><td>' + heat + '</td><td>' + esc(l.size || '—') + (l.branchCode ? ' · ' + esc(l.branchCode) : '') + '</td><td><span class="channel">' + ((l.source || 'W').charAt(0).toUpperCase()) + '</span></td><td>' + (l.monthlyRate ? '$' + Number(l.monthlyRate).toLocaleString() : '—') + '</td><td>' + fmtDay(l.createdAt) + '</td></tr>';
    }).join('');
  }

  // ============= CUSTOMERS =============
  function bindCustomers(data) {
    var tbody = $('#customerRows');
    if (!tbody) return;
    if (!data || !data.length) { tbody.innerHTML = '<tr><td colspan="4"><div class="section-empty">No customers.</div></td></tr>'; return; }
    tbody.innerHTML = data.map(function (t) {
      return '<tr><td><b>' + esc(t.name) + '</b></td><td>' + esc(t.unit || '—') + '<div class="t-type">' + esc(t.size || '') + '</div></td><td><b>' + (t.rate != null ? '$' + Number(t.rate).toLocaleString() : '—') + '</b></td><td><span class="pill ' + (t.status === 'ACTIVE' ? 'green' : t.status === 'OVERDUE' ? 'red' : 'amber') + '">' + (t.status || '').replace(/_/g, ' ') + '</span></td></tr>';
    }).join('');
  }

  // ============= FACILITIES =============
  function bindFacilities(brs, unitsMap) {
    var el = $('#facilityContent');
    if (!el) return;
    var html = '<div class="sec-hdr"><div class="sec-title">Branches</div></div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">';
    (brs || []).forEach(function (b) {
      html += '<div class="card" style="padding:14px"><h3>' + esc(b.name) + '</h3><div class="t-type">' + b.unitCount + ' units · ' + b.tenantCount + ' tenants · ' + b.leadCount + ' leads</div></div>';
    });
    html += '</div>';
    if (unitsMap && unitsMap.units) {
      var counts = { occupied: 0, available: 0, reserved: 0, overdue: 0, maintenance: 0 };
      unitsMap.units.forEach(function (u) { counts[u.status] = (counts[u.status] || 0) + 1; });
      html += '<div class="sec-hdr"><div class="sec-title">Units · ' + esc(unitsMap.branch) + ' Level ' + unitsMap.level + '</div></div><div class="unit-grid-mock">';
      unitsMap.units.slice(0, 25).forEach(function (u) {
        html += '<div class="u ' + (u.status === 'occupied' ? 'occ' : u.status === 'available' ? 'avail' : u.status === 'reserved' ? 'res' : 'occ') + '">' + esc(u.short) + '</div>';
      });
      html += '</div>';
    }
    el.innerHTML = html;
  }

  // ============= MOBILE DRAWER (hamburger + backdrop) =============
  function wireMobileDrawer() {
    var toggle = $('#navToggle');
    var backdrop = $('#sbBackdrop');
    if (!toggle || !backdrop) return;
    toggle.addEventListener('click', function () {
      var open = !document.body.classList.contains('sb-open');
      document.body.classList.toggle('sb-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      var side = document.querySelector('.side');
      if (side) side.classList.toggle('open', open);
    });
    backdrop.addEventListener('click', function () {
      document.body.classList.remove('sb-open');
      var side = document.querySelector('.side');
      if (side) side.classList.remove('open');
    });
    document.querySelector('.side')?.addEventListener('click', function (e) {
      if (e.target.closest('.nav')) {
        document.body.classList.remove('sb-open');
        var side = document.querySelector('.side');
        if (side) side.classList.remove('open');
      }
    });
  }

  // ============= BOOT =============
  async function boot() {
    try {
      await login();
      var [summary, leadsData, actions, tenants, branches, unitsMap] = await Promise.all([
        get('/summary').catch(function () { return null; }),
        get('/leads').catch(function () { return []; }),
        get('/action-items').catch(function () { return []; }),
        get('/tenants').catch(function () { return []; }),
        get('/branches').catch(function () { return []; }),
        get('/units/map?branch=BM&level=1').catch(function () { return null; }),
      ]);
      bindCommandStats(summary, leadsData, actions);
      bindFunnel(leadsData);
      bindQueue(actions);
      bindSources(leadsData);
      bindCharts(summary);
      bindUnitSnapshot(unitsMap);
      bindActions(actions);
      bindLeadTable(leadsData);
      bindCustomers(tenants);
      bindFacilities(branches, unitsMap);
    } catch (e) {
      console.error('[storelah] data layer failed', e);
      var top = document.querySelector('.top');
      if (top) top.innerHTML += '<div style="color:var(--red);font-size:11px;margin-left:12px;">' + (e.message || e) + '</div>';
    }
  }

  wireMobileDrawer();
  // Init charts
  var rCtx = document.getElementById('revenueChart');
  if (rCtx) {
    new Chart(rCtx.getContext('2d'), {
      type: 'bar',
      data: { labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul'], datasets: [
        { label: 'Actual', data: [36200,37800,38500,39200,40100,41600,42860], backgroundColor: function (ctx) { return ctx.dataIndex === 6 ? '#c97952' : '#e6e0d7'; }, borderRadius: 5, borderSkipped: false },
        { label: 'Target', data: [38000,38000,39000,39000,40000,41000,42000], type: 'line', borderColor: '#526557', borderWidth: 1.5, borderDash: [4,3], pointRadius: 0, fill: false, tension: 0.3 }
      ]},
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#6f746d' } }, y: { grid: { color: '#ede8e2' }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#6f746d', callback: function (v) { return '$' + (v / 1000).toFixed(0) + 'k'; } } } } }
    });
  }
  var bCtx = document.getElementById('branchChart');
  if (bCtx) {
    new Chart(bCtx.getContext('2d'), {
      type: 'bar',
      data: { labels: ['Bukit Merah', 'Woodlands', 'Ubi'], datasets: [{ data: [87.5,91.2,82.0], backgroundColor: ['#c97952','#526557','#547b8d'], borderRadius: 7, borderSkipped: false }] },
      options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: '#ede8e2' }, max: 100, ticks: { font: { family: 'Manrope', size: 10 }, color: '#6f746d', callback: function (v) { return v + '%'; } } }, y: { grid: { display: false }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#20241f' } } } }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
// StoreLah CMS admin UI — portfolio overview (P1 item 1) + net-rate panel
// (P1 item 2). Reads GET /portfolio and GET /rates/net-psf (both computed
// from live Unit rows), renders per-facility cards with sqft totals, a
// portfolio rollup, a report binding, and card actions that open the existing
// P0 create forms with the card's facility preselected.

import { $, escapeHtml, showBanner } from './dom.js';
import { get, describeError } from './api.js';
import { state } from './state.js';
import { openWorkOrderForBranch, openChecklistForBranch } from './facilitiesOps.js';

const fmtMoney = (n) => '$' + Number(n || 0).toLocaleString('en-SG', { maximumFractionDigits: 0 });
const fmtInt = (n) => Number(n || 0).toLocaleString('en-SG');
const fmtSqft = (n) => Number(n || 0).toLocaleString('en-SG', { maximumFractionDigits: 1 });

function cardHtml(f) {
  return `<div class="card facility-card" data-branch="${escapeHtml(f.code)}" data-branch-id="${escapeHtml(f.id)}">
    <div class="facility-top"><div><h3>${escapeHtml(f.name)}</h3><div class="t-type">${escapeHtml(f.code)} · ${escapeHtml(f.address || '')}</div></div>
    <span class="pill green">${f.occupancyPct}% occ</span></div>
    <div class="facility-metrics">
      <div><small>Units</small><b>${f.leasedUnits}/${f.totalUnits}</b></div>
      <div><small>Sqft leased</small><b>${fmtInt(f.leasedSqft)} / ${fmtInt(f.totalSqft)}</b></div>
      <div><small>Sqft occ</small><b>${f.sqftOccupancyPct}%</b></div>
      <div><small>MRR</small><b>${fmtMoney(f.mrr)}</b></div>
      <div><small>Net PSF</small><b>$${Number(f.netPsf || 0).toFixed(2)}</b></div>
      <div><small>Blocked</small><b>${f.blockedUnits || 0}</b></div>
    </div>
    <div class="pf-area" data-pf-area="${escapeHtml(f.code)}"><div class="t-type" style="margin-top:10px;">Loading area figures…</div></div>
    <div class="unit-actions" style="margin-top:10px;display:flex;gap:6px;">
      <button class="act-btn" data-pf-act="inspect" data-branch-id="${escapeHtml(f.id)}">+ Inspection</button>
      <button class="act-btn" data-pf-act="workorder" data-branch-id="${escapeHtml(f.id)}">+ Work order</button>
    </div>
  </div>`;
}

function totalsHtml(t) {
  return `<div class="stats">
    <div class="stat"><div class="label">Facilities</div><div class="val">${t.facilities}</div></div>
    <div class="stat"><div class="label">Units leased</div><div class="val">${t.leasedUnits}/${t.totalUnits} · ${t.occupancyPct}%</div></div>
    <div class="stat"><div class="label">Sqft leased</div><div class="val">${fmtInt(t.leasedSqft)} / ${fmtInt(t.totalSqft)} · ${t.sqftOccupancyPct}%</div></div>
    <div class="stat"><div class="label">Portfolio MRR</div><div class="val">${fmtMoney(t.mrr)}</div></div>
  </div>`;
}

export async function bindPortfolio() {
  const cards = $('#portfolioCards');
  try {
    const [portfolio, net] = await Promise.all([get('/portfolio'), get('/rates/net-psf').catch(() => null)]);
    if (cards) {
      cards.innerHTML = totalsHtml(portfolio.totals) +
        `<div class="facility-cards" style="margin-top:12px;">` +
        (portfolio.facilities || []).map(cardHtml).join('') + `</div>`;
    }
    const sub = $('#portfolioSub');
    if (sub) sub.textContent = `${portfolio.totals.facilities} facilit${portfolio.totals.facilities === 1 ? 'y' : 'ies'} · ${fmtInt(portfolio.totals.totalSqft)} sqft · computed from live units`;
    renderNetRate(net);
    // Recent NLA + UFA per facility (non-blocking; failures render per-card).
    bindPortfolioArea(portfolio.facilities || []).catch(() => {});
  } catch (e) {
    if (cards) cards.innerHTML = '<div class="section-empty">Portfolio failed to load: ' + escapeHtml(describeError(e)) + '</div>';
  }
}

// ---------- Recent NLA + UFA per facility ----------
// Per floor, the source is the authoritative (latest ACTIVE) metrics
// snapshot — drafts never resolve there — falling back to the live-compute
// metrics endpoint when a floor has no ACTIVE snapshot. Figures are summed across the facility's floors. Every
// card carries an explicit freshness tag — "as of <date>" for snapshot-backed
// figures, "live" when any floor fell back to live compute — and a labeled
// empty state when neither source yields data (never fake numbers).
// NOTE: the request wrote "ULA"; interpreted as UFA (Usable Floor Area — the
// metrics payload exposes geometry.ufa and no ULA concept exists in the
// codebase; metricsView.js labels the same field "usable floor area").
function geomFigures(g) {
  if (!g) return null;
  const num = (v) => (v && Number.isFinite(Number(v.sqft)) ? Number(v.sqft) : null);
  const figs = {
    nlaEnclosed: num(g.nlaEnclosed),
    nlaOutdoor: num(g.nlaOutdoor),
    nlaTotal: num(g.nlaTotal),
    ufa: num(g.ufa),
  };
  if (figs.nlaEnclosed == null && figs.nlaOutdoor == null && figs.nlaTotal == null && figs.ufa == null) return null;
  return figs;
}

// UFA/NLA are LINE-ONLY (marked-area, never the whole canvas): prefer the
// authoritative report.boundaryMetrics ({ ufa, nla, boundaryClosed }) when
// present — with no contributing marked line the floor contributes 0 — and
// fall back to the legacy geometry mapping only for snapshots published
// before boundaryMetrics existed.
function reportFigures(report) {
  if (!report) return null;
  const bm = report.boundaryMetrics;
  if (bm && typeof bm === 'object') {
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const figs = {
      nlaEnclosed: num(bm.nla),
      nlaOutdoor: 0,
      nlaTotal: num(bm.nla),
      ufa: num(bm.ufa),
    };
    if (figs.nlaEnclosed == null && figs.nlaTotal == null && figs.ufa == null) return null;
    return figs;
  }
  return geomFigures(report.geometry);
}

function areaSlotFor(code) {
  const card = Array.from(document.querySelectorAll('.facility-card'))
    .find((c) => c.getAttribute('data-branch') === code);
  return card ? card.querySelector('[data-pf-area]') : null;
}

function paintAreaEmpty(code, reason) {
  const slot = areaSlotFor(code);
  if (slot && slot.isConnected) {
    slot.innerHTML = '<div class="t-type" style="margin-top:10px;">No area data — ' + escapeHtml(reason) + '</div>';
  }
}

function paintAreaFigures(code, sum, tags) {
  const slot = areaSlotFor(code);
  if (!slot || !slot.isConnected) return;
  const cell = (label, v) => '<div><small>' + escapeHtml(label) + '</small><b>' +
    (v == null ? '—' : escapeHtml(fmtSqft(v)) + ' sqft') + '</b></div>';
  slot.innerHTML =
    '<div class="facility-metrics" style="margin-top:10px;">' +
    cell('NLA enclosed', sum.nlaEnclosed) + cell('NLA outdoor', sum.nlaOutdoor) +
    cell('NLA total', sum.nlaTotal) + cell('UFA', sum.ufa) + '</div>' +
    '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">' + tags + '</div>';
}

async function floorArea(floorId) {
  // Authoritative source is the latest ACTIVE snapshot (drafts never resolve
  // there); fall through to live compute when no ACTIVE snapshot exists.
  try {
    const snap = await get('/floor-plans/' + encodeURIComponent(floorId) + '/metrics/snapshots/authoritative');
    const figs = reportFigures(snap && snap.payload);
    if (figs) return { figs, effectiveDate: snap.effectiveDate || '', live: false };
  } catch (e) { /* fall through to live compute */ }
  try {
    const report = await get('/floor-plans/' + encodeURIComponent(floorId) + '/metrics');
    const figs = reportFigures(report);
    if (figs) return { figs, effectiveDate: '', live: true };
  } catch (e) { /* no data for this floor */ }
  return null;
}

export async function bindPortfolioArea(facilities) {
  if (!facilities.length) return;
  try {
    if (!state.branches.length || !state.floors.length) {
      const [branches, floors] = await Promise.all([get('/branches'), get('/floors')]);
      state.branches = branches || [];
      state.floors = floors || [];
    }
  } catch (e) {
    facilities.forEach((f) => paintAreaEmpty(f.code, 'reference data unavailable.'));
    return;
  }
  await Promise.all((facilities || []).map(async (f) => {
    const floors = (state.floors || []).filter((fl) => fl.branchId === f.id);
    if (!floors.length) {
      paintAreaEmpty(f.code, 'no floors registered for this facility.');
      return;
    }
    const results = await Promise.all(floors.map((fl) => floorArea(fl.id)));
    const ok = results.filter(Boolean);
    if (!ok.length) {
      paintAreaEmpty(f.code, 'no snapshot published and live compute unavailable.');
      return;
    }
    const sum = { nlaEnclosed: 0, nlaOutdoor: 0, nlaTotal: 0, ufa: 0 };
    const hasAny = { nlaEnclosed: false, nlaOutdoor: false, nlaTotal: false, ufa: false };
    ok.forEach((r) => {
      (Object.keys(sum)).forEach((k) => {
        if (r.figs[k] != null) { sum[k] += r.figs[k]; hasAny[k] = true; }
      });
    });
    (Object.keys(sum)).forEach((k) => { if (!hasAny[k]) sum[k] = null; });
    const dates = ok.map((r) => r.effectiveDate).filter(Boolean).sort();
    const latest = dates.length ? dates[dates.length - 1] : '';
    const liveUsed = ok.some((r) => r.live);
    let tags = '';
    if (latest) tags += '<span class="pill green">as of ' + escapeHtml(latest) + '</span>';
    if (liveUsed) tags += '<span class="pill amber">live</span>';
    paintAreaFigures(f.code, sum, tags);
  }));
}

function renderNetRate(net) {
  const tb = $('#netRateBody');
  if (!tb || !net) return;
  tb.innerHTML = (net.facilities || []).map((f) =>
    `<tr><td><b>${escapeHtml(f.name)}</b><div class="t-type">${escapeHtml(f.branch)}</div></td>` +
    `<td>${f.units}/${f.totalUnits}</td><td>${fmtInt(f.totalSqft)}</td><td><b>${fmtMoney(f.mrr)}</b></td>` +
    `<td><b>$${Number(f.netPsf || 0).toFixed(2)}</b></td></tr>`,
  ).join('');
  const ref = $('#netRateRef');
  if (ref) {
    const sizes = (net.bySize || []).map((s) => `${s.code}: actual $${s.actualPsf}${s.marketPsf != null ? ` vs market $${s.marketPsf}` : ''}`).join(' · ');
    ref.textContent = `Portfolio net PSF $${Number(net.portfolioNetPsf || 0).toFixed(2)} (occupied + overdue units)` + (sizes ? ` · ${sizes}` : '');
  }
}

// Report action binding: renders a snapshot table into #portfolioReport.
export async function renderPortfolioReport() {
  const wrap = $('#portfolioReport');
  if (!wrap) return;
  try {
    const [portfolio, net] = await Promise.all([get('/portfolio'), get('/rates/net-psf').catch(() => null)]);
    const t = portfolio.totals;
    const netByBranch = new Map(((net && net.facilities) || []).map((f) => [f.branch, f.netPsf]));
    wrap.innerHTML = `<div class="tbl-card" style="margin-top:12px;"><div class="sec-hdr"><div><div class="sec-title">Portfolio report — ${new Date().toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: 'numeric' })}</div>` +
      `<div class="sec-sub">${t.leasedUnits}/${t.totalUnits} units (${t.occupancyPct}%) · ${fmtInt(t.leasedSqft)}/${fmtInt(t.totalSqft)} sqft (${t.sqftOccupancyPct}%) · MRR ${fmtMoney(t.mrr)}</div></div></div>` +
      `<table class="data-tbl"><thead><tr><th>Facility</th><th>Units</th><th>Sqft leased</th><th>MRR</th><th>Net PSF</th></tr></thead><tbody>` +
      (portfolio.facilities || []).map((f) =>
        `<tr><td><b>${escapeHtml(f.name)}</b> (${escapeHtml(f.code)})</td><td>${f.leasedUnits}/${f.totalUnits} · ${f.occupancyPct}%</td>` +
        `<td>${fmtInt(f.leasedSqft)}/${fmtInt(f.totalSqft)} · ${f.sqftOccupancyPct}%</td><td>${fmtMoney(f.mrr)}</td>` +
        `<td>$${Number(netByBranch.get(f.code) ?? f.netPsf ?? 0).toFixed(2)}</td></tr>`,
      ).join('') + `</tbody></table></div>`;
    showBanner('Portfolio report generated', true);
  } catch (e) {
    showBanner('Report: ' + describeError(e));
  }
}

// Card-action delegation (stable container id survives innerHTML re-renders).
let portfolioWired = false;
export function wirePortfolio() {
  if (portfolioWired) return;
  portfolioWired = true;
  $('#portfolioCards')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-pf-act]');
    if (!btn) return;
    const branchId = btn.dataset.branchId;
    try {
      if (btn.dataset.pfAct === 'inspect') await openChecklistForBranch(branchId);
      else if (btn.dataset.pfAct === 'workorder') await openWorkOrderForBranch(branchId);
    } catch (err) {
      showBanner('Action: ' + describeError(err));
    }
  });
  $('#portfolioReportBtn')?.addEventListener('click', () => renderPortfolioReport().catch(() => {}));
}

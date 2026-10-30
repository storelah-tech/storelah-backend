// StoreLah CMS admin UI — Investor Summary (spec §15.4, owner Q10 FINAL).
// Phase 5 masked read-only surface: modelling + returns from the CURRENT
// model, posted actuals from CLOSED months only, issued/paid aggregates.
// Never drafts, never PII, never customer names, never transaction detail.
// Every render carries the masked-summary watermark; amounts round to whole
// dollars (Q10 MAY round), PSF is ALWAYS 2dp, percents 1dp (spec §7.4).
// Print button renders the same server data through a print stylesheet;
// Export CSV downloads the masked summary (audited server-side).

import {
  escapeHtml, finState, money, fmtDay, facilityOptions,
  renderDenied, renderError, canViewFin, getFinMount,
  journeyNavHtml, wireJourneyNav,
} from './financeShared.js';
import { get, downloadFile, describeError, can } from './api.js';

const PANEL = 'bill-investor';

const viewState = { data: null };

function stat(label, val, sub) {
  return `<div class="stat"><div class="label">${escapeHtml(label)}</div><div class="val">${val}</div>${sub ? `<div class="sec-sub">${escapeHtml(sub)}</div>` : ''}</div>`;
}

function psf(v) {
  return v === null || v === undefined ? '—' : `$${Number(v).toFixed(2)}`;
}

function num(v) {
  return v === null || v === undefined ? '—' : escapeHtml(String(v));
}

export async function bindFinanceInvestorView() {
  const host = getFinMount(PANEL);
  if (!host) return;
  if (!canViewFin(PANEL)) {
    renderDenied(host, PANEL);
    return;
  }
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.innerHTML = `<div class="section-empty">Loading masked summary…</div>`;
  try {
    const qs = finState.branchId ? `?branchId=${encodeURIComponent(finState.branchId)}` : '';
    viewState.data = await get(`/finance/investor/summary${qs}`);
    renderInvestor(host);
  } catch (e) {
    if (e && e.status === 404) {
      // F-8: designed empty state (never plain text). Authorised users get a
      // direct link into the Model Library to approve a CURRENT baseline.
      const libLink = can('bill-library:view')
        ? ` <button class="tb-btn primary" data-fin-lib>Open Model Library</button>`
        : '';
      host.innerHTML = journeyNavHtml(PANEL) +
        `<div class="card"><div class="card-head"><h3>Investor Summary</h3></div>` +
        `<div class="card-body"><div class="section-empty">No CURRENT model baseline — the investor summary shows approved models only. Approve a model as CURRENT to publish this summary.${libLink}</div></div></div>`;
      wireJourneyNav(host);
      const lib = host.querySelector('[data-fin-lib]');
      if (lib) lib.addEventListener('click', () => {
        document.querySelectorAll('[data-tabs="billing"] [data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'bill-library'));
        document.querySelectorAll('#billing .module-panel').forEach((p) => p.classList.toggle('active', p.id === 'bill-library'));
        try { history.replaceState(null, '', '#bill-library'); } catch (err) { /* noop */ }
      });
      return;
    }
    renderError(host, e);
    const retry = host.querySelector('[data-fin-retry]');
    if (retry) retry.addEventListener('click', () => bindFinanceInvestorView());
  }
}

function renderInvestor(host) {
  const d = viewState.data;
  const m = d.modelling;
  const r = d.returns;
  const actualRows = (d.actuals.closedMonths || []).map((c) => {
    const cells = ['REVENUE', 'CASH', 'OPEX', 'LEASE', 'NOI', 'OCCUPIED_SQFT']
      .map((k) => `<td>${c.metrics[k] === null || c.metrics[k] === undefined ? '—' : `<b>${money(c.metrics[k])}</b>`}</td>`).join('');
    return `<tr><td>${escapeHtml(c.fiscalMonth)}</td>${cells}</tr>`;
  }).join('');
  const irr = r.irrAnnualisedPct === null || r.irrAnnualisedPct === undefined
    ? `<b>Not available</b><div class="sec-sub">${escapeHtml(r.irrNote)}</div>`
    : `<b>${escapeHtml(String(r.irrAnnualisedPct))}%</b><div class="sec-sub">${escapeHtml(r.irrNote)}</div>`;

  host.innerHTML =
    `<div class="card inv-watermark"><div class="card-body"><b>${escapeHtml(d.watermark)}</b>` +
    `<div class="sec-sub">${escapeHtml(d.label)}</div></div></div>` +
    `<div class="card"><div class="card-head"><h3>Investor Summary</h3>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">` +
    `<select class="tbl-select" id="finBranch" aria-label="Facility">${facilityOptions(finState.branchId)}</select>` +
    `<button class="tb-btn" id="finRefresh">Refresh</button>` +
    `<button class="tb-btn" id="finPrint">Print summary</button>` +
    `<button class="tb-btn primary" id="finExport">Export CSV</button>` +
    `</div></div>` +
    `<div class="card-body"><div class="sec-sub">Source: ${escapeHtml(m.source.modelName)} (${escapeHtml(m.source.modelStatus)}) · ` +
    `engine ${escapeHtml(m.source.engineVersion)} · input ${escapeHtml((m.source.inputHash || '').slice(0, 12))} · ` +
    `as at ${escapeHtml(fmtDay(m.source.asOf))} · generated ${escapeHtml(fmtDay(d.generatedAt))}</div></div></div>` +
    `<div class="card"><div class="card-head"><h3>Modelling &amp; returns</h3></div><div class="card-body"><div class="stats">` +
    stat('Occupancy rate', m.occupancyRatePct === null ? '—' : `${m.occupancyRatePct}%`, m.occupancyNote) +
    stat('Earned PSF', psf(m.earnedPsf), m.earnedPsfNote) +
    stat('Ramp-up sqft', num(m.rampUpSqft), m.rampUpNote) +
    stat('Sign-ups (units)', num(m.signUpsUnits), m.signUpsNote) +
    stat('Move-outs', m.moveOutRatePctMonth === null ? '—' : `${m.moveOutRatePctMonth}%/mo`, m.moveOutNote) +
    stat('Avg tenure', m.avgTenureMonths === null ? '—' : `${m.avgTenureMonths} mo`, m.tenureNote) +
    stat('Avg customer value', m.avgCustomerValue === null ? '—' : money(m.avgCustomerValue), m.avgCustomerValueNote) +
    stat('Total revenue (model)', money(m.totalRevenueModel), m.totalRevenueNote) +
    `</div><div class="stats">` +
    stat('Initial investment', money(r.initialInvestment)) +
    stat('Payback month', r.paybackMonth === null ? '— (never in horizon)' : `Month ${r.paybackMonth}`) +
    stat('Stabilisation month', num(r.stabilisationMonth)) +
    stat('NOI-positive month', num(r.noiPositiveMonth)) +
    stat('Annual NOI margin', r.annualNoiMarginPct === null ? '—' : `${r.annualNoiMarginPct}%`) +
    stat('Cash through Year 5', money(r.cashThroughSelectedYear)) +
    `</div><div class="stats"><div class="stat"><div class="label">Annualised operating cash-flow IRR</div><div class="val">${irr}</div></div>` +
    `<div class="stat"><div class="label">NPV @ ${escapeHtml(String(r.npvDiscountRatePct))}%</div><div class="val"><b>${money(r.npv)}</b></div></div></div>` +
    `<div class="sec-sub"><b>No terminal value:</b> ${escapeHtml(r.noTerminalValueDisclosure)}</div>` +
    `</div></div>` +
    `<div class="card"><div class="card-head"><h3>Posted actuals — closed months only</h3></div><div class="card-body">` +
    (actualRows
      ? `<div class="table-wrap"><table class="lead-table" aria-label="Posted actuals for closed months"><thead><tr><th scope="col">Month</th><th scope="col">Revenue</th><th scope="col">Cash</th><th scope="col">Opex</th><th scope="col">Lease</th><th scope="col">NOI</th><th scope="col">Occupied sqft</th></tr></thead><tbody>${actualRows}</tbody></table></div>`
      : `<div class="section-empty">${escapeHtml(d.actuals.note)}</div>`) +
    `</div></div>` +
    `<div class="card"><div class="card-head"><h3>Ledger aggregates</h3></div><div class="card-body"><div class="stats">` +
    stat('Issued invoices', num(d.aggregates.issuedInvoices), `${money(d.aggregates.issuedTotal)} issued`) +
    stat('Paid invoices', num(d.aggregates.paidInvoices), `${money(d.aggregates.collectedTotal)} collected`) +
    stat('Accounts receivable', money(d.aggregates.accountsReceivable), d.aggregates.note) +
    `</div></div></div>` +
    `<div class="card"><div class="card-head"><h3>Definitions</h3></div><div class="card-body">` +
    (d.definitions || []).map((x) => `<div>• ${escapeHtml(x)}</div>`).join('') + `</div></div>`;

  const br = host.querySelector('#finBranch');
  if (br) br.addEventListener('change', () => { finState.branchId = br.value; bindFinanceInvestorView(); });
  const rf = host.querySelector('#finRefresh');
  if (rf) rf.addEventListener('click', () => bindFinanceInvestorView());
  const pr = host.querySelector('#finPrint');
  if (pr) pr.addEventListener('click', () => {
    document.body.classList.add('printing-investor');
    const done = () => {
      document.body.classList.remove('printing-investor');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  });
  const ex = host.querySelector('#finExport');
  if (ex) ex.addEventListener('click', async () => {
    ex.disabled = true;
    try {
      const qs = finState.branchId ? `?branchId=${encodeURIComponent(finState.branchId)}` : '';
      await downloadFile(`/finance/investor/summary.csv${qs}`, 'finance-investor-summary.csv');
    } catch (e) { window.alert ? window.alert(describeError(e)) : null; }
    finally { ex.disabled = false; }
  });
}

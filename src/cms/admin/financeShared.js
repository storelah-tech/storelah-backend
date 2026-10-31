// StoreLah CMS admin UI — Finance module shared helpers (Phase 1 shell).
//
// One view module per submodule (finance*View.js) renders into its own
// `#bill-*` panel. Every view implements the same four states — loading,
// empty, error, permission-denied — through the helpers here, and money
// arrives from the API as JSON numbers (server-side toNum), formatted here.
//
// Phase 1: full content only for Overview. The other eleven submodules are
// permission-gated placeholders that name their Phase 2–4 content; they
// fetch nothing and fabricate nothing.

import { $, escapeHtml } from './dom.js';
import { get, downloadFile, describeError, can } from './api.js';
import { state } from './state.js';
import { FINANCE_JOURNEY } from './financeIndex.js';

export const FINANCE_PHASE = {  'bill-overview': 1,
  'bill-transactions': 3,
  'bill-models': 2,
  'bill-performance': 4,
  'bill-budgets': 2,
  'bill-pricing': 2,
  'bill-returns': 2,
  'bill-library': 2,
  'bill-invoices': 3,
  'bill-arrears': 4,
  'bill-credits': 4,
  'bill-reconciliation': 4,
  'bill-investor': 5,
};

export const FINANCE_LABEL = {
  'bill-overview': 'Finance Overview',
  'bill-transactions': 'Transactions & Approvals',
  'bill-models': 'Financial Models',
  'bill-performance': 'Forecast vs Actuals',
  'bill-budgets': 'Budgets & Expenses',
  'bill-pricing': 'Size Mix & Pricing',
  'bill-returns': 'Investment Returns',
  'bill-library': 'Model Library',
  'bill-invoices': 'Invoices',
  'bill-arrears': 'Arrears',
  'bill-credits': 'Credits & Refunds',
  'bill-reconciliation': 'Reconciliation',
  'bill-investor': 'Investor Summary',
};

export const FINANCE_BLURB = {
  'bill-transactions': 'Payment instruction approval, payment status and recovery. Individual approval only — no bulk (spec §4.1).',
  'bill-models': 'Facility planning workspace: assumptions, monthly roadmap and calculation engine.',
  'bill-performance': 'Approved budget vs current forecast vs posted actuals. Future actuals show as an em dash — never fabricated.',
  'bill-budgets': 'Monthly non-lease Opex budgets and individual expenditure. The landlord lease line stays read-only here.',
  'bill-pricing': 'Facility unit mix, net PSF and rent potential from live Unit inventory.',
  'bill-returns': 'Operating cash returns, IRR, payback and scenarios. Read-only; inputs come from the current model.',
  'bill-library': 'Model versions, approvals, duplication and audit.',
  'bill-invoices': 'Customer invoice register and creation. Approval required before issue.',
  'bill-arrears': 'Delinquency cases and recovery workflow. Policy-gated actions only.',
  'bill-credits': 'StoreLah Credits wallet ledger and the refund lifecycle with maker-checker.',
  'bill-reconciliation': 'Gateway/bank/invoice matching and period sign-off.',
  'bill-investor': 'Masked approved-only summary for investors: modelling + returns + closed months. No customer data.',
};

export const finState = {
  branchId: '',
  basis: 'accrual',
  period: 'last-6m',
  from: null,
  to: null,
  data: null,
  error: null,
  loading: false,
};

/** F-7: eight reporting-period presets driving Overview API + export (YYYY-MM-DD). */
export { REPORTING_PERIODS, reportingRange } from './financePeriods.js';

export function money(n) {
  if (n === null || n === undefined) return '—';
  return '$' + Number(n).toLocaleString('en-SG', { maximumFractionDigits: 2 });
}

export function fmtDay(d) {
  if (!d) return '—';
  const t = new Date(d);
  return isNaN(t) ? '—' : t.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Lineage info-tip: definition, source, refresh (spec §§3.1/9.3). */
export function lineageTip(kpi) {
  const l = kpi.lineage || {};
  const text = `${kpi.label}. ${l.definition || ''} Source: ${l.source || '—'}. Refresh: ${l.refresh || '—'}.`;
  return `<span class="fin-info" title="${escapeHtml(text)}" aria-label="${escapeHtml(text)}">ⓘ</span>`;
}

function box(html, live) {
  // Async-state announcements (WCAG 2.2 AA 4.1.3): every finance view renders
  // loading / empty / error / permission-denied through this helper, so one
  // live region here covers all twelve submodules + the investor summary.
  // Loading and error are polite (frequent, non-critical); denial is
  // assertive-rare — kept polite too so screen readers finish the tab label.
  const role = live === 'alert' ? ' role="alert"' : ' role="status"';
  return `<div class="section-empty"${role} aria-live="polite">${html}</div>`;
}

export function renderLoading(el) {
  if (el) el.innerHTML = box('Loading…');
}

export function renderDenied(el, resource) {
  if (el) el.innerHTML = box(`Permission denied — your role cannot view this screen (${escapeHtml(resource)}:view required).`);
}

export function renderError(el, err) {
  if (el) el.innerHTML = box(`Couldn’t load this screen: ${escapeHtml(describeError(err))} <button class="tb-btn" data-fin-retry>Retry</button>`, 'alert');
}

export function renderEmpty(el, text) {
  if (el) el.innerHTML = box(escapeHtml(text));
}

/** Placeholder shell for submodules whose content lands in a later phase. */
export function renderPhasePlaceholder(panelId) {
  const el = document.getElementById(panelId);
  if (!el) return;
  const mount = el.querySelector('[data-fin-mount]') || el;
  if (!canViewFin(panelId)) {
    renderDenied(mount, panelId);
    return;
  }
  const phase = FINANCE_PHASE[panelId] || '?';
  renderLoading(mount);
  setTimeout(() => {
    mount.innerHTML =
      `<div class="card"><div class="card-head"><h3>${escapeHtml(FINANCE_LABEL[panelId] || panelId)}</h3></div>` +
      `<div class="card-body">${box(`${FINANCE_BLURB[panelId] || ''} Full content ships in Phase ${phase} — this shell proves loading, empty, error and permission-denied states with no fabricated data.`)}</div></div>`;
  }, 60);
}

export function canViewFin(resource) {
  return can(`${resource}:view`);
}

/** F-1: single mount contract for all 13 finance views.
 * Every finance panel must contain `<div data-fin-mount>`. Returns the mount
 * element, or null after logging an error (never silent — F-1 shipped blank
 * screens because five binders returned early without a word).
 * Accepts the panel id and queries `#<panel> [data-fin-mount]`. */
export function getFinMount(panelId) {
  const mount = document.querySelector(`#${panelId} [data-fin-mount]`);
  if (!mount) {
    // eslint-disable-next-line no-console
    console.error(`[finance] missing host: #${panelId} has no [data-fin-mount] (dashboard.html contract)`);
    return null;
  }
  // Operations panels (invoices, arrears, credits, reconciliation) show the
  // prototype layout on top and keep their working tools in [data-fin-ops].
  return mount.querySelector(':scope > details > [data-fin-ops]') || mount;
}

/** The panel's own mount (never the operations-tools child). */
export function getPanelMount(panelId) {
  return document.querySelector(`#${panelId} [data-fin-mount]`);
}

/** F-4: facility guard — returns the selected branchId, defaulting to the
 * first facility (Sembawang/SW first when present, matching the prototype).
 * Returns '' when no facilities exist (caller renders a "choose" state). */
export function ensureFacility(defaultable = true) {
  if (finState.branchId) return finState.branchId;
  const rows = (typeof window !== 'undefined' && window.__branches) || [];
  const list = Array.isArray(rows) && rows.length ? rows : (typeof state !== 'undefined' && Array.isArray(state.branches) ? state.branches : []);
  if (!list.length || !defaultable) return '';
  const sw = list.find((b) => (b.code || '').toUpperCase() === 'SW' || /sembawang/i.test(b.name || ''));
  const pick = sw || list[0];
  const id = pick.id || pick.branchId || '';
  if (id) finState.branchId = id;
  return finState.branchId || '';
}

/** Top journey navigation (spec §3, prototype-identical): the same seven
 * journey items on every finance screen for journey-nav parity. */
export function journeyNavHtml(activeTab) {
  const items = (FINANCE_JOURNEY || []).map(([label, tab]) =>
    `<button class="tb-btn${tab === activeTab ? ' primary' : ''}" data-fin-jump="${escapeHtml(tab)}">${escapeHtml(label)}</button>`,
  ).join('');
  return `<div class="card"><div class="card-body" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;"><span class="sec-sub">Journey:</span>${items}</div></div>`;
}

/** Wire journey-nav jumps inside a freshly rendered host (hash parity). */
export function wireJourneyNav(host, onJump) {
  host.querySelectorAll('[data-fin-jump]').forEach((b) => {
    b.addEventListener('click', () => {
      const tab = b.dataset.finJump;
      try { history.replaceState(null, '', '#' + tab); } catch (e) { /* noop */ }
      if (onJump) onJump(tab);
      else {
        document.querySelectorAll('[data-tabs="billing"] [data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
        document.querySelectorAll('#billing .module-panel').forEach((p) => p.classList.toggle('active', p.id === tab));
      }
    });
  });
}

/** Calculation-checks panel (§11.9): pass/warn/fail rows from engine checks. */
export function checksPanelHtml(checks) {
  const rows = Object.entries(checks || {});
  if (!rows.length) return `<div class="card"><div class="card-head"><h3>Calculation checks</h3></div><div class="card-body"><div class="section-empty">No checks reported for this model.</div></div></div>`;
  const items = rows.map(([key, c]) => {
    const badge = c.pass ? '<b style="color:var(--ok,#1a7f37);">PASS</b>' : '<b style="color:var(--bad,#b42318);">FAIL</b>';
    return `<div>• ${badge} <b>${escapeHtml(key)}</b> — ${escapeHtml(c.detail || '')}</div>`;
  }).join('');
  const allPass = rows.every(([, c]) => c.pass);
  return `<div class="card"><div class="card-head"><h3>Calculation checks</h3><span class="sec-sub">${allPass ? 'All checks pass' : 'Failures need review before approval'}</span></div><div class="card-body">${items}</div></div>`;
}

/** Status badge for models/library (Draft / Pending / Current / Archived). */
export function modelStatusBadge(status) {
  return `<span class="tb-btn" style="pointer-events:none;">${escapeHtml(status || 'DRAFT')}</span>`;
}

/** Number with em dash for null (never a fabricated zero). */
export function emDash(v, fmt) {
  if (v === null || v === undefined) return '—';
  return fmt === 'money' ? money(v) : escapeHtml(String(v));
}

export function facilityOptions(selected) {
  const all = `<option value="">All facilities</option>`;
  const rows = (state.branches || []).map((b) => {
    const id = b.id || b.branchId || '';
    const label = b.code ? `${b.code} · ${b.name || ''}` : (b.name || id);
    return `<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  });
  return all + rows.join('');
}

export async function fetchOverview() {
  const q = new URLSearchParams();
  if (finState.branchId) q.set('branchId', finState.branchId);
  if (finState.basis) q.set('basis', finState.basis);
  if (finState.from) q.set('from', finState.from);
  if (finState.to) q.set('to', finState.to);
  const qs = q.toString();
  return get(`/finance/overview${qs ? `?${qs}` : ''}`);
}

export async function exportOverviewCsv() {
  const q = new URLSearchParams();
  if (finState.branchId) q.set('branchId', finState.branchId);
  if (finState.basis) q.set('basis', finState.basis);
  if (finState.from) q.set('from', finState.from);
  if (finState.to) q.set('to', finState.to);
  const qs = q.toString();
  await downloadFile(`/finance/overview/export.csv${qs ? `?${qs}` : ''}`, 'finance-overview-summary.csv');
}

export { $, escapeHtml };

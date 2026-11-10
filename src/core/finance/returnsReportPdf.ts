// Investment returns report (PDF) — data + rendering.
//
// One report per financial model, exported from Finance › Investment returns.
// It prints the SAME committed project valuation the screen shows (the ONE
// dated cash-flow series at the model's stored rate — `getReturns().committed`):
// NPV interpretation, headline metrics, NPV breakeven rate, discount-rate
// sensitivity (chart + table), occupancy scenarios, optional renewal, the
// monthly discounted cash flow and the method/limitations. Nothing is
// re-derived here except the sensitivity NPVs, which re-discount the same
// committed series at each tested rate (as the screen does).
//
// Calculations only: no actuals, no customer data. Models without a committed
// valuation (rollout off / no stored rate / failed calculation) cannot export
// — the route returns 409 rather than printing uncommitted figures.
// Same Lambda-safe pdf-lib layout as the other finance PDFs.

import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/http';
import { getReturns, isCommittedValued, type CommittedValuationOk } from './returns';
import { Writer, drawWordmark, W, H, M, OLIVE, LINE, MUTED, RED, INK, TERRA, SHADE, ascii, sgd, day } from './reportPdf';

export const SENSITIVITY_RATES = [0.1, 0.12, 0.15, 0.18, 0.2];

export interface ReturnsReport {
  meta: {
    generatedAt: string;
    generatedBy: string;
    modelId: string;
    modelName: string;
    status: string;
    approved: boolean;
    version: number;
    facility: string;
    updatedAt: string;
    updatedBy: string;
    inputHash: string;
  };
  committed: CommittedValuationOk;
  /** NPV of the committed series at each tested annual rate (stored rate included). */
  sensitivity: Array<{ rate: number; npv: number; stored: boolean }>;
}

/** NPV of the committed series at an annual rate: Σ CF × (1+r)^(−period/12). */
export function npvOfSeries(rows: CommittedValuationOk['dcf'], annualRate: number): number {
  let s = 0;
  for (const r of rows) s += Number(r.netCashFlow) * Math.pow(1 + annualRate, -Number(r.period) / 12);
  return Math.round(s * 100) / 100;
}

export async function buildReturnsReport(opts: { modelId: string; generatedBy: string; now?: Date }): Promise<ReturnsReport> {
  const now = opts.now ?? new Date();
  const model = await prisma.financialModel.findUnique({ where: { id: opts.modelId } });
  if (!model) throw new AppError(404, 'NOT_FOUND', `Financial model ${opts.modelId} not found.`);
  const r = await getReturns({ modelId: model.id });
  const committed = r.committed ?? null;
  if (!isCommittedValued(committed)) {
    const why = committed && 'valuationError' in committed
      ? `Returns are out of date — ${committed.valuationError} Retry the calculation first.`
      : 'Committed valuation is unavailable for this model — the returns report needs the finance.leaseHorizon.returns rollout on and valuation assumptions saved on the model.';
    throw new AppError(409, 'BLOCKED', why);
  }
  const branch = model.branchId ? await prisma.branch.findUnique({ where: { id: model.branchId }, select: { name: true } }) : null;
  const rates = [...new Set([...SENSITIVITY_RATES, committed.annualRate])].sort((a, b) => a - b);
  return {
    meta: {
      generatedAt: now.toISOString(),
      generatedBy: opts.generatedBy,
      modelId: model.id,
      modelName: model.name,
      status: model.status,
      approved: model.status === 'CURRENT',
      version: model.version,
      facility: branch ? branch.name : 'Portfolio model',
      updatedAt: model.updatedAt.toISOString(),
      updatedBy: model.updatedBy ?? model.createdBy,
      inputHash: model.inputHash,
    },
    committed,
    sensitivity: rates.map((rate) => ({ rate, npv: npvOfSeries(committed.dcf, rate), stored: Math.abs(rate - committed.annualRate) < 1e-12 })),
  };
}

const STATUS_LABEL: Record<string, string> = {
  CURRENT: 'Approved (current baseline)',
  PENDING: 'Pending approval - not approved',
  DRAFT: 'Draft - not approved',
  ARCHIVED: 'Archived - superseded',
};
const METHOD_LABEL: Record<string, string> = { manual: 'Manual rate', risk: 'Risk-adjusted build-up', wacc: 'WACC' };
const SCENARIO_LABEL: Record<string, string> = { downside: 'Downside', base: 'Base (saved plan)', upside: 'Upside' };
const rate = (a: number | null | undefined, dp = 1) => (a == null ? 'n.a.' : `${(a * 100).toFixed(dp)}%`);
const irrText = (irr: { status: string; annualRate: number | null; display: string }) => (irr.status === 'valid' ? rate(irr.annualRate) : irr.display);
const shortDay = (iso: string) => `${Number(iso.slice(8, 10))} ${new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-SG', { month: 'short', timeZone: 'UTC' })} ${iso.slice(2, 4)}`;
/** DCF month cell: server strings only ("2026-12", "2026-12-01", "a→b" stubs). */
const dcfMonth = (m: string) => {
  if (m.includes('→')) { const [a, b] = m.split('→'); return `${shortDay(a)}-${shortDay(b)}`; }
  if (/^\d{4}-\d{2}$/.test(m)) return new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-SG', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (/^\d{4}-\d{2}-\d{2}$/.test(m)) return day(m);
  return m;
};

export async function buildReturnsReportPdf(r: ReturnsReport): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`StoreLah investment returns - ${r.meta.modelName}`);
  doc.setAuthor('StoreLah CMS');
  doc.setCreator('StoreLah CMS');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c = r.committed;
  const draftTag = r.meta.approved ? '' : '  |  DRAFT - NOT APPROVED';
  const w = new Writer(doc, regular, bold, `StoreLah investment returns  |  ${r.meta.modelName}  |  ${r.meta.facility}  |  v${r.meta.version}${draftTag}`);
  const storedRate = rate(c.annualRate, 2);
  const t0 = c.dcf[0];
  const capex0 = Math.abs(Number(t0?.capex) || 0);
  const deposit0 = Math.abs(Number(t0?.otherCashFlow) || 0);
  const initialInvestment = Math.abs(Number(t0?.netCashFlow) || 0);
  const monthlyRate = Math.pow(1 + c.annualRate, 1 / 12) - 1;

  // ---- Cover band ----
  w.page = doc.addPage([W, H]);
  w.pages.push(w.page);
  w.page.drawRectangle({ x: 0, y: H - 150, width: W, height: 150, color: OLIVE });
  drawWordmark(w.page, bold, M, H - 50);
  w.text('INVESTMENT RETURNS', M, H - 86, 11, bold, rgb(0.93, 0.85, 0.78));
  w.text(w.fit(r.meta.modelName, W - 2 * M, 14, regular), M, H - 106, 14, regular, rgb(1, 1, 1));
  w.text(`${r.meta.facility}  |  ${c.committedMonths}-month committed term from ${day(c.leaseStartDate)}  |  ${storedRate} required return`, M, H - 126, 10, regular, rgb(0.9, 0.9, 0.88));
  w.y = H - 178;
  if (!r.meta.approved) {
    w.page.drawRectangle({ x: M, y: w.y - 8, width: W - 2 * M, height: 24, color: rgb(0.97, 0.88, 0.86) });
    w.text('DRAFT - NOT APPROVED. Figures may change before the model is approved.', M + 8, w.y, 9, bold, RED);
    w.y -= 30;
  }
  const metaRow = (key: string, v: string) => { w.text(key, M, w.y, 9, regular, MUTED); w.text(w.fit(v, W - 2 * M - 120, 9, regular), M + 120, w.y, 9); w.y -= 14; };
  metaRow('Model', `${r.meta.modelName}  (version ${r.meta.version})`);
  metaRow('Facility', r.meta.facility);
  metaRow('Status', STATUS_LABEL[r.meta.status] ?? r.meta.status);
  metaRow('Committed term', `${day(c.leaseStartDate)} - ${day(c.committedEndDate)}  (${c.committedMonths} months)`);
  metaRow('Discount rate', `${storedRate} a year (${METHOD_LABEL[c.annualRateSource] ?? c.annualRateSource}), ${rate(monthlyRate, 3)} a month`);
  metaRow('Last updated', `${day(r.meta.updatedAt)} by ${r.meta.updatedBy}`);
  metaRow('Generated', new Date(r.meta.generatedAt).toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' }) + ` SGT by ${r.meta.generatedBy}`);
  w.y -= 6;
  w.para('Projection only. Every figure is calculated from the saved model assumptions and the committed lease - it is not a record of actual results, not an audited statement and not guaranteed profit.', 8.5, MUTED);
  w.y -= 4;

  // ---- 1. Interpretation + headline ----
  const tone = c.npv > 1 ? 'positive' : c.npv < -1 ? 'negative' : 'neutral';
  const interp = tone === 'positive'
    ? { title: 'Forecast value exceeds the required return', copy: `A positive NPV means the modelled project cash flows are worth ${sgd(c.npv, 0)} more than the initial investment after discounting at ${rate(c.annualRate)}. It is not guaranteed profit.` }
    : tone === 'negative'
      ? { title: 'Forecast value is below the required return', copy: `A negative NPV means the current forecast does not meet the ${rate(c.annualRate)} required return. Review the cash-flow assumptions; it is not a booked loss.` }
      : { title: 'Forecast is approximately at the required return', copy: 'NPV is close to zero, so the forecast approximately earns the selected required return.' };
  w.section('Committed project valuation', `The full ${c.committedMonths}-month committed lease term at the stored ${storedRate} annual rate. Project NPV, IRR, both paybacks, cumulative free cash flow and profitability index all read the same dated cash-flow series.`);
  {
    const lines = w.wrap(interp.copy, W - 2 * M - 150, 8.5);
    const h = 34 + lines.length * 12;
    w.need(h + 8);
    const fill = tone === 'positive' ? rgb(0.91, 0.95, 0.9) : tone === 'negative' ? rgb(0.97, 0.89, 0.87) : SHADE;
    const accent = tone === 'positive' ? rgb(0.15, 0.45, 0.25) : tone === 'negative' ? RED : MUTED;
    w.page.drawRectangle({ x: M, y: w.y - h + 12, width: W - 2 * M, height: h, color: fill });
    w.page.drawRectangle({ x: M, y: w.y - h + 12, width: 3, height: h, color: accent });
    w.text('PROJECT NPV INTERPRETATION', M + 12, w.y, 7, bold, MUTED);
    w.text(interp.title, M + 12, w.y - 14, 10.5, bold, INK);
    lines.forEach((l, n) => w.text(l, M + 12, w.y - 28 - n * 12, 8.5, regular, INK));
    const big = sgd(c.npv, 0);
    w.text(big, W - M - 12 - bold.widthOfTextAtSize(ascii(big), 18), w.y - 18, 18, bold, accent);
    w.y -= h + 6;
  }
  w.kpiGrid([
    { label: 'Project NPV', value: sgd(c.npv, 0), note: 'Committed lease case' },
    { label: 'Annual discount rate', value: rate(c.annualRate), note: `${METHOD_LABEL[c.annualRateSource] ?? c.annualRateSource}, ${rate(monthlyRate, 3)} monthly` },
    { label: 'Project IRR', value: irrText(c.irr), note: c.irr.status === 'valid' ? 'Same project cash-flow series' : 'Use Project NPV for this model' },
    { label: 'Simple payback', value: c.simplePayback.label, note: 'Undiscounted recovery' },
    { label: 'Discounted payback', value: c.discountedPayback.label, note: c.discountedPayback.month == null ? 'Not recovered in lease term' : `Time-value adjusted at ${rate(c.annualRate)}` },
    { label: 'Cumulative free cash flow', value: sgd(c.cumulativeFreeCashFlow, 0), note: `Undiscounted through month ${c.committedMonths}` },
    { label: 'Initial investment', value: sgd(initialInvestment, 0), note: `${sgd(capex0, 0)} CapEx + ${sgd(deposit0, 0)} deposit` },
    { label: 'Profitability index', value: c.profitabilityIndex == null ? 'n.a.' : `${c.profitabilityIndex.toFixed(2)}x`, note: c.profitabilityIndex == null ? '' : c.profitabilityIndex >= 1 ? 'Above required return' : 'Below required return' },
    { label: 'Renewal scenario NPV', value: c.renewal ? sgd(c.renewal.npv, 0) : 'Off', note: c.renewal ? `Separate run, +${c.renewal.renewalMonths} months` : 'Excluded from committed case' },
  ]);
  w.para('Equity NPV is not calculated: the model has no financing drawdowns, interest, principal repayments or lender fees, so these are project (unlevered) cash flows.', 8, MUTED);

  // ---- 2. Breakeven ----
  w.section('NPV breakeven rate', 'The theoretical required return at which Project NPV becomes S$0 - the same as Project IRR. It is not occupancy, rental yield, profit margin or guaranteed profit.');
  if (c.irr.status === 'valid') {
    w.table(
      [{ label: 'Required return', width: 0.4 }, { label: 'Project NPV', width: 0.6 }],
      [[`Below ${rate(c.irr.annualRate)}`, 'Positive'], [`Above ${rate(c.irr.annualRate)}`, 'Negative']],
    );
    if ((c.irr.annualRate ?? 0) > 1) w.para(`Review this unusually high result: ${rate(c.irr.annualRate)} can be mathematically valid but usually means the initial investment is small relative to the monthly cash flows. Verify CapEx, opening working capital, monthly NOI and lease duration before relying on it.`, 8.5, RED);
  } else {
    w.para(c.irr.status === 'multiple' ? 'Multiple solutions - more than one discount rate zeroes the NPV. Use Project NPV for this model.' : 'No valid solution - the series has only one sign, so Project NPV is the decision metric.', 8.5);
  }
  w.para(`Current decision check: at the stored ${rate(c.annualRate)} required return, Project NPV is ${sgd(c.npv, 0)} and is ${c.npv >= 0 ? 'positive' : 'negative'}.`, 9);

  // ---- 3. Sensitivity (chart + table) ----
  w.section('Discount-rate sensitivity', 'Project NPV recomputed from the same committed cash-flow series at each tested required return. The horizon, lease expense and cash flows do not change - only the rate.');
  drawSensitivityChart(w, r.sensitivity, regular, bold);
  w.table(
    [{ label: 'Tested annual rate', width: 0.4 }, { label: 'Project NPV', width: 0.35, align: 'right' }, { label: '', width: 0.25, align: 'right' }],
    r.sensitivity.map((s) => [rate(s.rate, 2), sgd(s.npv, 0), s.stored ? 'Stored rate' : '']),
  );

  // ---- 4. Scenarios ----
  w.section('Scenario comparison', 'Occupancy-only comparison on the same committed lease, operating costs, capital, operational start and valuation rate. The Base column is the committed valuation above.');
  const order = ['downside', 'base', 'upside'];
  const sc = c.scenarios.slice().sort((a, b) => order.indexOf(a.scenario) - order.indexOf(b.scenario));
  const row = (label: string, f: (s: (typeof sc)[number]) => string) => [label, ...sc.map(f)];
  w.table(
    [{ label: 'Metric', width: 0.31 }, ...sc.map((s) => ({ label: SCENARIO_LABEL[s.scenario] ?? s.scenario, width: 0.23, align: 'right' as const }))],
    [
      row('Project NPV', (s) => sgd(s.npv, 0)),
      row('Project IRR', (s) => irrText(s.irr)),
      row('Simple payback', (s) => s.simplePayback.label),
      row('Discounted payback', (s) => s.discountedPayback.label),
      row('Cumulative free cash flow', (s) => sgd(s.cumulativeFreeCashFlow, 0)),
      row('Initial investment', (s) => sgd(s.initialInvestment, 0)),
      row('Annual discount rate', (s) => rate(s.annualRate)),
    ],
  );
  for (const s of sc) if (s.scenario !== 'base') w.para(`${SCENARIO_LABEL[s.scenario]}: ${s.note}`, 8, MUTED);

  // ---- 5. Renewal ----
  w.section('Optional renewal', 'A separate comparison run - never included in, and never replacing, the committed case.');
  if (c.renewal) {
    const x = c.renewal;
    w.table(
      [{ label: 'Measure', width: 0.4 }, { label: 'Committed case', width: 0.3, align: 'right' }, { label: 'With renewal', width: 0.3, align: 'right' }],
      [
        ['Term', `${c.committedMonths} months to ${day(c.committedEndDate)}`, `+${x.renewalMonths} months to ${day(x.renewalEndDate)}`],
        ['Project NPV', sgd(c.npv, 0), sgd(x.npv, 0)],
        ['Project IRR', irrText(c.irr), irrText(x.irr)],
        ['Simple payback', c.simplePayback.label, x.simplePayback.label],
        ['Discounted payback', c.discountedPayback.label, x.discountedPayback.label],
        ['Cumulative free cash flow', sgd(c.cumulativeFreeCashFlow, 0), sgd(x.cumulativeFreeCashFlow, 0)],
      ],
    );
    w.para(`Renewal is valued at the same stored ${storedRate} rate. Renewal-year rents missing from the lease are carried forward from the last committed rent as scenario assumptions.`, 8, MUTED);
  } else {
    w.para('Optional renewal is off for this model. The committed case excludes any renewal.', 8.5);
  }

  // ---- 6. Monthly DCF ----
  w.section('Monthly discounted cash flow', `The exact series behind Project NPV and IRR: ${c.dcf.length - 1} monthly rows plus the commencement outflow. Period = contractual months from commencement. Amounts in S$, rounded to whole dollars (the DCF CSV export carries cents); negative amounts are cash out.`);
  const n0 = (v: number) => { const x = Math.round(v); return x === 0 ? '0' : (x < 0 ? '-' : '') + Math.abs(x).toLocaleString('en-SG'); };
  w.table(
    [
      { label: 'Month', width: 0.15 }, { label: 'Period', width: 0.07, align: 'right' }, { label: 'Revenue', width: 0.1, align: 'right' },
      { label: 'Op. CF', width: 0.1, align: 'right' }, { label: 'CapEx', width: 0.09, align: 'right' }, { label: 'Other', width: 0.08, align: 'right' },
      { label: 'Net FCF', width: 0.1, align: 'right' }, { label: 'DF', width: 0.09, align: 'right' }, { label: 'DCF', width: 0.1, align: 'right' },
      { label: 'Cum. DCF', width: 0.12, align: 'right' },
    ],
    c.dcf.map((d) => [
      d.index === 0 ? `${dcfMonth(d.month)} (t0)` : dcfMonth(d.month), d.periodLabel, n0(d.revenue), n0(d.operatingCashFlow), n0(d.capex), n0(d.otherCashFlow),
      n0(d.netCashFlow), Number(d.discountFactor).toFixed(5), n0(d.display.discountedCashFlow), n0(d.display.cumulativeDiscountedCashFlow),
    ]),
    { totals: ['Total', '', n0(c.dcf.reduce((s, d) => s + d.revenue, 0)), n0(c.dcf.reduce((s, d) => s + d.operatingCashFlow, 0)), n0(c.dcf.reduce((s, d) => s + d.capex, 0)), n0(c.dcf.reduce((s, d) => s + d.otherCashFlow, 0)), n0(c.cumulativeFreeCashFlow), '', n0(c.npv), ''] },
  );

  // ---- 7. Method ----
  w.section('How the returns are calculated');
  for (const line of [
    'One dated cash-flow series: t0 is the commencement outflow (capital investment plus any refundable deposit); each following row is that month\'s operating cash flow (revenue less lease and other operating costs). Opening and closing stub months are prorated to their exact dates.',
    `Each row is discounted at the stored ${storedRate} annual rate: discount factor = (1 + annual rate) ^ -(period / 12). Project NPV is the sum of discounted cash flows.`,
    'Project IRR is the annual rate at which the same series has an NPV of zero. Simple payback is when cumulative undiscounted cash returns to zero; discounted payback uses the discounted cash flows.',
    'Profitability index = present value of future cash flows / initial investment.',
    'Scenarios change occupancy only (move-in pace, churn, stabilisation target); lease, operating costs, capital, operational start and rate are unchanged.',
    c.limitation,
  ]) w.para(`- ${line}`, 8.5);

  // ---- Footer on every page ----
  const total = w.pages.length;
  w.pages.forEach((p, n) => {
    p.drawLine({ start: { x: M, y: 40 }, end: { x: W - M, y: 40 }, color: LINE, thickness: 0.6 });
    p.drawText(ascii(`StoreLah Pte. Ltd.  |  Investment returns - projection, not actual results${r.meta.approved ? '' : '  |  DRAFT - NOT APPROVED'}`), { x: M, y: 28, size: 7, font: r.meta.approved ? regular : bold, color: r.meta.approved ? MUTED : RED });
    const label = `Page ${n + 1} of ${total}`;
    p.drawText(label, { x: W - M - regular.widthOfTextAtSize(label, 7), y: 28, size: 7, font: regular, color: MUTED });
  });

  return Buffer.from(await doc.save());
}

/** Line chart of NPV vs tested rate; the stored rate is ringed. */
function drawSensitivityChart(w: Writer, pts: ReturnsReport['sensitivity'], regular: PDFFont, bold: PDFFont) {
  const h = 180;
  w.need(h + 10);
  const p = w.page;
  const left = M + 62, right = W - M - 10, top = w.y, bottom = w.y - h + 40;
  const xs = pts.map((x) => x.rate), ys = pts.map((x) => x.npv);
  const x0 = Math.min(...xs, 0.08) - 0.005, x1 = Math.max(...xs, 0.22) + 0.005;
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = (y1 - y0) * 0.15 || 1; y0 -= pad; y1 += pad;
  const X = (r: number) => left + ((r - x0) / (x1 - x0)) * (right - left);
  const Y = (v: number) => bottom + ((v - y0) / (y1 - y0)) * (top - bottom);
  // grid + y labels
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4;
    p.drawLine({ start: { x: left, y: Y(v) }, end: { x: right, y: Y(v) }, color: LINE, thickness: 0.5 });
    const lbl = ascii(sgd(v, 0));
    p.drawText(lbl, { x: left - 6 - regular.widthOfTextAtSize(lbl, 7), y: Y(v) - 2.5, size: 7, font: regular, color: MUTED });
  }
  if (y0 < 0 && y1 > 0) p.drawLine({ start: { x: left, y: Y(0) }, end: { x: right, y: Y(0) }, color: MUTED, thickness: 0.8 });
  // x ticks
  for (const r of SENSITIVITY_RATES) {
    const lbl = `${Math.round(r * 100)}%`;
    p.drawLine({ start: { x: X(r), y: bottom }, end: { x: X(r), y: bottom - 4 }, color: MUTED, thickness: 0.6 });
    p.drawText(lbl, { x: X(r) - regular.widthOfTextAtSize(lbl, 7) / 2, y: bottom - 13, size: 7, font: regular, color: MUTED });
  }
  const axis = 'ANNUAL DISCOUNT RATE (REQUIRED RETURN)';
  p.drawText(axis, { x: (left + right) / 2 - regular.widthOfTextAtSize(axis, 6.5) / 2, y: bottom - 25, size: 6.5, font: regular, color: MUTED });
  // line + points
  for (let i = 1; i < pts.length; i++) {
    p.drawLine({ start: { x: X(pts[i - 1].rate), y: Y(pts[i - 1].npv) }, end: { x: X(pts[i].rate), y: Y(pts[i].npv) }, color: INK, thickness: 1.6 });
  }
  for (const pt of pts) {
    if (pt.stored) {
      p.drawCircle({ x: X(pt.rate), y: Y(pt.npv), size: 6, borderColor: TERRA, borderWidth: 1.4 });
      const lbl = ascii(`Stored ${(pt.rate * 100).toFixed(1)}%: ${sgd(pt.npv, 0)}`);
      const lx = Math.min(right - bold.widthOfTextAtSize(lbl, 7.5), X(pt.rate) + 9);
      p.drawText(lbl, { x: lx, y: Y(pt.npv) + 8, size: 7.5, font: bold, color: TERRA });
    }
    p.drawCircle({ x: X(pt.rate), y: Y(pt.npv), size: 3, color: pt.stored ? TERRA : INK });
  }
  w.y -= h + 6;
}

/** StoreLah_Investment_Returns_<facility>_<model>_v<version>.pdf */
export function returnsReportFileName(r: ReturnsReport): string {
  const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'Model';
  return `StoreLah_Investment_Returns_${slug(r.meta.facility)}_${slug(r.meta.modelName).slice(0, 60)}_v${r.meta.version}${r.meta.approved ? '' : '_DRAFT'}.pdf`;
}

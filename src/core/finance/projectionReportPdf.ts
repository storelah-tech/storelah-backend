// Model projection report (PDF) — rendering.
//
// Same Lambda-safe pdf-lib layout as the Financial Report (shared Writer,
// Helvetica / WinAnsi text, A4 portrait, header line + "Page x of y" on every
// page). A model that is not the approved (CURRENT) baseline is stamped
// "DRAFT - NOT APPROVED" on the cover and in every page header.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { ProjectionReport } from './projectionReport';
import { Writer, W, H, M, OLIVE, LINE, MUTED, RED, ascii, sgd, num, pct, day, modelMonth } from './reportPdf';
import { effectiveNla } from './projection';

const STATUS_LABEL: Record<string, string> = {
  CURRENT: 'Approved (current baseline)',
  PENDING: 'Pending approval - not approved',
  DRAFT: 'Draft - not approved',
  ARCHIVED: 'Archived - superseded',
};
const SCENARIO_LABEL = { downside: 'Downside', base: 'Base (saved plan)', upside: 'Upside' } as const;

const shortMonth = (ym: string) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-SG', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const yearSpan = (a: string, b: string) => (a === b ? shortMonth(a) : `${shortMonth(a)} - ${shortMonth(b)}`);
const shortDay = (iso: string) => `${Number(iso.slice(8))} ${new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-SG', { month: 'short', timeZone: 'UTC' })}`;
/** Stub rows show their exact date range (handoff §8.3); full months the label. */
const monthCell = (m: { month: string; periodStart?: string; periodEnd?: string; isStub?: boolean }) =>
  m.isStub && m.periodStart && m.periodEnd
    ? `${shortDay(m.periodStart)}-${shortDay(m.periodEnd)} ${m.periodEnd.slice(0, 4)}`
    : shortMonth(m.month);
/** "Dec 26" — compact month for table cells. */
const tinyMonth = (ym: string) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-SG', { month: 'short', timeZone: 'UTC' }).slice(0, 3) + ' ' + ym.slice(2, 4);

export async function buildProjectionReportPdf(r: ProjectionReport): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`StoreLah financial projection - ${r.meta.modelName}`);
  doc.setAuthor('StoreLah CMS');
  doc.setCreator('StoreLah CMS');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const i = r.inputs;
  const k = r.kpis;
  const draftTag = r.meta.approved ? '' : '  |  DRAFT - NOT APPROVED';
  const w = new Writer(doc, regular, bold, `StoreLah financial projection  |  ${r.meta.modelName}  |  ${r.meta.facility}  |  v${r.meta.version}${draftTag}`);

  // ---- Cover band ----
  w.page = doc.addPage([W, H]);
  w.pages.push(w.page);
  w.page.drawRectangle({ x: 0, y: H - 150, width: W, height: 150, color: OLIVE });
  w.text('StoreLah', M, H - 58, 24, bold, rgb(1, 1, 1));
  w.text('FINANCIAL PROJECTION', M, H - 82, 11, bold, rgb(0.93, 0.85, 0.78));
  w.text(w.fit(r.meta.modelName, W - 2 * M, 14, regular), M, H - 106, 14, regular, rgb(1, 1, 1));
  w.text(`${r.meta.facility}  |  Opening ${day(i.startDate)}  |  ${i.horizonMonths}-month model`, M, H - 126, 10, regular, rgb(0.9, 0.9, 0.88));
  w.y = H - 178;
  if (!r.meta.approved) {
    w.page.drawRectangle({ x: M, y: w.y - 8, width: W - 2 * M, height: 24, color: rgb(0.97, 0.88, 0.86) });
    w.text(`DRAFT - NOT APPROVED (${(STATUS_LABEL[r.meta.status] ?? r.meta.status).split(' - ')[0].toLowerCase()}). Figures may change before the model is approved.`, M + 8, w.y, 9, bold, RED);
    w.y -= 30;
  }
  const metaRow = (key: string, v: string) => { w.text(key, M, w.y, 9, regular, MUTED); w.text(w.fit(v, W - 2 * M - 120, 9, regular), M + 120, w.y, 9); w.y -= 14; };
  metaRow('Model', `${r.meta.modelName}  (version ${r.meta.version})`);
  metaRow('Facility', r.meta.facility);
  metaRow('Status', STATUS_LABEL[r.meta.status] ?? r.meta.status);
  metaRow('Last updated', `${day(r.meta.updatedAt)} by ${r.meta.updatedBy}`);
  metaRow('Generated', new Date(r.meta.generatedAt).toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' }) + ` SGT by ${r.meta.generatedBy}`);
  metaRow('Calculation', `${r.meta.engineVersion}  |  input ${r.meta.inputHash.slice(0, 12)}`);
  w.y -= 6;
  w.para('Projection only. Every figure in this report is calculated from the model assumptions listed below - it is not a record of actual results and is not an audited statement. If the assumptions change, the projection changes.', 8.5, MUTED);
  w.y -= 6;

  // ---- 1. Headline ----
  // P5 corrected labels (§8.4): the year-window IRR/NPV are supplementary
  // views, never the Project IRR/NPV — the committed valuation below is the
  // full-term Project figure at the stored rate (rate identified, D7A).
  w.section('Headline projection', `Base case from the saved model. Returns are measured over the first ${r.returns.horizonYears} model year${r.returns.horizonYears === 1 ? '' : 's'} from the opening date.`);
  w.kpiGrid([
    { label: 'Capital investment', value: sgd(i.capitalTotal, 0) },
    { label: 'Weighted start rent', value: `S$${k.weightedStartPsf.toFixed(2)}`, note: 'per sq ft per month' },
    { label: 'Target occupancy', value: pct(i.occupancy.targetPct), note: `${num(effectiveNla(i))} sq ft lettable` },
    { label: 'NOI positive', value: modelMonth(i.startDate, k.noiPositiveMonth) },
    { label: 'Stabilised occupancy', value: modelMonth(i.startDate, k.stabilisedMonth) },
    { label: 'Payback', value: modelMonth(i.startDate, k.paybackMonth), note: 'Cumulative cash back to zero' },
    { label: `IRR (${r.returns.horizonYears}-year view, annualised)`, value: r.returns.irrAnnualised == null ? 'Not available' : pct(r.returns.irrAnnualised * 100), note: 'Supplementary view, not the committed Project IRR' },
    { label: `NPV through Year ${r.returns.horizonYears} at ${r.returns.discountRatePct}%`, value: sgd(r.returns.npv, 0), note: `Supplementary (${r.returns.discountRateSource})` },
    { label: `Cash after ${r.returns.horizonYears} year${r.returns.horizonYears === 1 ? '' : 's'}`, value: sgd(r.returns.cashThroughHorizon, 0), note: 'Cumulative, after capital' },
  ]);

  // ---- 1b. Committed project valuation (P5) ----
  const committed = r.committed && !('valuationError' in r.committed) ? r.committed : null;
  if (committed) {
    w.section(
      'Committed project valuation',
      `Full ${committed.committedMonths}-month committed term (${day(committed.leaseStartDate)} to ${day(committed.committedEndDate)}) at the stored ${(committed.annualRate * 100).toFixed(2)}% annual rate (${committed.annualRateSource}). ${committed.limitation}`,
    );
    w.kpiGrid([
      { label: 'Project NPV', value: sgd(committed.npv, 0), note: `At ${(committed.annualRate * 100).toFixed(2)}% (${committed.annualRateSource})` },
      { label: 'Project IRR', value: committed.irr.display, note: 'Same cash-flow series as NPV' },
      { label: 'Simple payback', value: committed.simplePayback.label, note: 'Undiscounted' },
      { label: 'Discounted payback', value: committed.discountedPayback.label, note: `At ${(committed.annualRate * 100).toFixed(2)}%` },
      { label: 'Cumulative free cash flow', value: sgd(committed.cumulativeFreeCashFlow, 0), note: 'Through committed end' },
      { label: 'Profitability index', value: committed.profitabilityIndex == null ? '-' : committed.profitabilityIndex.toFixed(2), note: 'PV of future flows / investment' },
    ]);
  }

  // ---- 2. Yearly ----
  w.section('Projected results by year', 'Model years run 12 months from the opening date; each row shows the calendar months it covers. Other cost = operating costs other than the lease. NOI = revenue less lease and other cost. Occupancy is at year end. Cash is cumulative and starts at minus the capital investment.');
  const tot = r.years.reduce((a, y) => ({ revenue: a.revenue + y.revenue, lease: a.lease + y.lease, other: a.other + y.otherCosts, noi: a.noi + y.noi }), { revenue: 0, lease: 0, other: 0, noi: 0 });
  w.table(
    [{ label: 'Year', width: 0.24 }, { label: 'Revenue', width: 0.12, align: 'right' }, { label: 'Lease', width: 0.1, align: 'right' }, { label: 'Other cost', width: 0.11, align: 'right' }, { label: 'NOI', width: 0.11, align: 'right' }, { label: 'Margin', width: 0.08, align: 'right' }, { label: 'Occ. %', width: 0.09, align: 'right' }, { label: 'Cash', width: 0.15, align: 'right' }],
    r.years.map((y) => [
      `Year ${y.year}  ${tinyMonth(y.firstMonth)} - ${tinyMonth(y.lastMonth)}`, sgd(y.revenue, 0), sgd(y.lease, 0), sgd(y.otherCosts, 0), sgd(y.noi, 0),
      pct(y.noiMarginPct), pct(y.closingOccupancyPct), sgd(y.cashAtYearEnd, 0),
    ]),
    { totals: r.years.length ? [`Total ${r.years.length} year${r.years.length === 1 ? '' : 's'}`, sgd(tot.revenue, 0), sgd(tot.lease, 0), sgd(tot.other, 0), sgd(tot.noi, 0), '', '', ''] : undefined, empty: 'No projection years.' },
  );
  if (r.years.some((y) => y.months < 12)) w.para('A final year shorter than 12 months is the end of the model horizon.', 8, MUTED);

  // ---- 3. Monthly ----
  w.section('Monthly projection', `The first ${r.months.length} months from the opening date. Sq ft = occupied area and Occ. % = occupancy, both at month end; rent psf is the monthly rate per sq ft.`);
  const byYear = new Map<number, typeof r.months>();
  for (const m of r.months) {
    // P5: committed engine rows group by lease year (same as the Year-N
    // table); legacy rows keep the t-index grouping (unchanged output).
    const y = m.leaseYear ?? Math.floor((m.t - 1) / 12) + 1;
    byYear.set(y, [...(byYear.get(y) ?? []), m]);
  }
  for (const [y, list] of byYear) {
    w.sub(`Year ${y}`, yearSpan(list[0].month, list[list.length - 1].month));
    w.table(
      [{ label: 'Month', width: 0.12 }, { label: 'Sq ft', width: 0.1, align: 'right' }, { label: 'Occ. %', width: 0.09, align: 'right' }, { label: 'Rent psf', width: 0.1, align: 'right' }, { label: 'Revenue', width: 0.12, align: 'right' }, { label: 'Lease', width: 0.1, align: 'right' }, { label: 'Other cost', width: 0.11, align: 'right' }, { label: 'NOI', width: 0.11, align: 'right' }, { label: 'Cash', width: 0.15, align: 'right' }],
      list.map((m) => [
        monthCell(m), num(Math.round(m.closingSqft)), pct(m.occupancyPct), `S$${m.psf.toFixed(2)}`,
        sgd(m.revenue, 0), sgd(m.opexLease, 0), sgd(m.opexNonLease, 0), sgd(m.noi, 0), sgd(m.cash, 0),
      ]),
    );
  }
  if (r.months.some((m) => m.periodFactor < 1)) w.para('The opening month is prorated for a mid-month opening date.', 8, MUTED);
  if (r.months.length && r.months[r.months.length - 1].isStub) {
    w.para('The final month is a closing stub ending on the committed end date — revenue, costs and move-ins are scaled by its partial period.', 8, MUTED);
  }

  // ---- 4. Scenarios ----
  w.section('Scenarios', 'Downside and upside change occupancy only (move-in pace, move-out rate and the stabilisation target). Rent, lease, operating costs and capital stay as in the saved plan.');
  const sc = r.scenarios;
  const scRow = (label: string, f: (s: (typeof sc)[number]) => string) => [label, ...sc.map(f)];
  const yearsShown = Math.max(0, ...sc.map((s) => s.years.length));
  const rows: string[][] = [
    scRow('Move-in, months 1-6 (sq ft/month)', (s) => num(s.occupancy.rampFirst6)),
    scRow('Move-in, month 7+ (sq ft/month)', (s) => num(s.occupancy.rampFrom7)),
    scRow('Move-out rate (per month)', (s) => pct(s.occupancy.moveOutRatePct)),
    scRow('Stabilisation target', (s) => pct(s.occupancy.targetPct)),
  ];
  for (let y = 1; y <= yearsShown; y++) {
    rows.push(scRow(`Year ${y} revenue`, (s) => sgd(s.years[y - 1]?.revenue, 0)));
    rows.push(scRow(`Year ${y} NOI`, (s) => sgd(s.years[y - 1]?.noi, 0)));
  }
  rows.push(scRow('Stabilised', (s) => (s.stabilisedMonth == null ? 'Not reached' : `Month ${s.stabilisedMonth}`)));
  rows.push(scRow('Payback', (s) => (s.paybackMonth == null ? 'Not in horizon' : `Month ${s.paybackMonth}`)));
  rows.push(scRow('IRR (annualised, full horizon)', (s) => (s.irrAnnualised == null ? 'Not available' : pct(s.irrAnnualised * 100))));
  w.table(
    [{ label: 'Measure', width: 0.37 }, ...sc.map((s) => ({ label: SCENARIO_LABEL[s.scenario], width: 0.21, align: 'right' as const }))],
    rows,
  );
  for (const s of sc) if (s.scenario !== 'base') w.para(`${SCENARIO_LABEL[s.scenario]}: ${s.note}`, 8, MUTED);

  // ---- 5. Assumptions ----
  w.section('Model assumptions', 'The inputs the projection is calculated from.');
  w.table(
    [{ label: 'Assumption', width: 0.36 }, { label: 'Value', width: 0.64 }],
    [
      ['Opening date / horizon', `${day(i.startDate)}  |  ${i.horizonMonths} months`],
      ['Net lettable area (NLA)', `${num(effectiveNla(i))} sq ft${i.lease.ufaSqft ? `  (lease area ${num(i.lease.ufaSqft)} sq ft)` : ''}`],
      ['Move-in pace (gross)', `${num(i.occupancy.rampFirst6)} sq ft/month (months 1-6), ${num(i.occupancy.rampFrom7)} sq ft/month (month 7+)`],
      ['Move-out rate', `${pct(i.occupancy.moveOutRatePct)} of occupied area per month, from month ${i.occupancy.churnStartMonth}`],
      ['Stabilisation target', `${pct(i.occupancy.targetPct)} occupancy`],
      ['Rent increase', `${pct(i.pricing.annualIncreasePct)} a year, from each model-year anniversary`],
      ['Rent-free lease months', num(i.lease.rentFreeMonths)],
      ['Other operating costs', `${sgd(i.opex.baseMonthly, 0)}/month, growing ${pct(i.opex.annualGrowthPct)} a year`],
      ['Capital investment', sgd(i.capitalTotal, 0)],
    ],
  );
  if (i.sizeMix.length) {
    w.sub('Unit mix and rents');
    const units = i.sizeMix.reduce((t, x) => t + x.units, 0);
    const nla = i.sizeMix.reduce((t, x) => t + x.nlaSqft, 0);
    w.table(
      [{ label: 'Size', width: 0.3 }, { label: 'Range', width: 0.22 }, { label: 'Units', width: 0.14, align: 'right' }, { label: 'Area (sq ft)', width: 0.17, align: 'right' }, { label: 'Rent psf / month', width: 0.17, align: 'right' }],
      i.sizeMix.map((x) => [x.name, x.range ?? '-', num(x.units), num(x.nlaSqft), `S$${x.psf.toFixed(2)}`]),
      { totals: ['Total / weighted', '', num(units), num(nla), `S$${k.weightedStartPsf.toFixed(2)}`] },
    );
  }
  if (r.leaseSchedule?.length) {
    // P5: the Year-N lease table reflects the committed schedule (period
    // dates + source per lease year) for v2 models.
    w.sub('Lease schedule', '(committed landlord rent, period-dated)');
    w.table(
      [{ label: 'Lease year', width: 0.24 }, { label: 'Period', width: 0.36 }, { label: 'Monthly', width: 0.2, align: 'right' }, { label: 'Source', width: 0.2, align: 'right' }],
      r.leaseSchedule.map((x) => [`Year ${x.leaseYear}`, `${day(x.periodStart)} - ${day(x.periodEnd)}`, sgd(x.monthlyRent, 0), x.source]),
    );
  } else if (i.lease.monthlyByYear.length) {
    w.sub('Lease schedule', '(landlord rent)');
    w.table(
      [{ label: 'Lease year', width: 0.4 }, { label: 'Monthly', width: 0.3, align: 'right' }, { label: 'Annual', width: 0.3, align: 'right' }],
      i.lease.monthlyByYear.map((v, n) => [`Year ${n + 1}`, sgd(v, 0), sgd(v * 12, 0)]),
    );
  }
  const cats = (i.opex.categories ?? []).filter((c) => c.budget);
  if (cats.length) {
    w.sub('Other operating costs', '(monthly budget, before growth)');
    w.table(
      [{ label: 'Category', width: 0.4 }, { label: 'Monthly', width: 0.3, align: 'right' }, { label: 'Annual', width: 0.3, align: 'right' }],
      cats.map((c) => [c.name, sgd(c.budget, 0), sgd(c.budget * 12, 0)]),
      { totals: ['Total', sgd(i.opex.baseMonthly, 0), sgd(i.opex.baseMonthly * 12, 0)] },
    );
  }
  if (i.capitalItems?.length) {
    w.sub('Capital investment');
    w.table(
      [{ label: 'Item', width: 0.7 }, { label: 'Amount', width: 0.3, align: 'right' }],
      i.capitalItems.map((x) => [x.name, sgd(x.amount, 0)]),
      { totals: ['Total', sgd(i.capitalTotal, 0)] },
    );
  }

  // ---- 6. Method ----
  w.section('How the projection is calculated');
  for (const line of [
    'Occupied area grows each month by the move-in pace, less move-outs (the move-out rate applied to occupied area), and is capped at the stabilisation target.',
    'Revenue = occupied area x rent per sq ft. Rent starts at the weighted rate of the unit mix and rises by the annual increase at each model-year anniversary.',
    'Operating costs = landlord lease (per the lease schedule, after any rent-free months) + other operating costs. NOI = revenue - operating costs.',
    'Cash starts at minus the capital investment and adds each month\'s NOI. Payback is the first month cumulative cash reaches zero.',
    `IRR uses the capital investment and monthly NOI only (no sale or terminal value, financing, tax or depreciation). NPV through Year ${r.returns.horizonYears} discounts the same cash flows at ${r.returns.discountRatePct}% a year (${r.returns.discountRateSource}). ${r.returns.irrNote}`,
    'Lease renewal beyond the schedule is not secured; the last scheduled rent is carried forward.',
  ]) w.para(`- ${line}`, 8.5);
  if (committed) {
    w.para(`- Committed project valuation: the full ${committed.committedMonths}-month term at the stored ${(committed.annualRate * 100).toFixed(2)}% annual rate (${committed.annualRateSource}). NPV, IRR, both paybacks, cumulative free cash flow and PI are read from that one series.`, 8.5);
  }
  if (r.failedChecks.length) w.para(`Model checks not passing: ${r.failedChecks.join('; ')}`, 8, RED);

  // ---- Footer on every page ----
  const total = w.pages.length;
  w.pages.forEach((p, n) => {
    p.drawLine({ start: { x: M, y: 40 }, end: { x: W - M, y: 40 }, color: LINE, thickness: 0.6 });
    p.drawText(ascii(`StoreLah Pte. Ltd.  |  Financial projection - not actual results${r.meta.approved ? '' : '  |  DRAFT - NOT APPROVED'}`), { x: M, y: 28, size: 7, font: r.meta.approved ? regular : bold, color: r.meta.approved ? MUTED : RED });
    const label = `Page ${n + 1} of ${total}`;
    p.drawText(label, { x: W - M - regular.widthOfTextAtSize(label, 7), y: 28, size: 7, font: regular, color: MUTED });
  });

  return Buffer.from(await doc.save());
}

/** StoreLah_Financial_Projection_<facility>_<model>_v<version>.pdf */
export function projectionReportFileName(r: ProjectionReport): string {
  const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'Model';
  return `StoreLah_Financial_Projection_${slug(r.meta.facility)}_${slug(r.meta.modelName).slice(0, 60)}_v${r.meta.version}${r.meta.approved ? '' : '_DRAFT'}.pdf`;
}


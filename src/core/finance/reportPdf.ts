// Financial report (PDF) — rendering.
//
// Lambda-safe like the receipt and quotation PDFs: pdf-lib with the standard
// Helvetica fonts (WinAnsi text only — see ascii()), generated in memory per
// request and never stored. A4 portrait; every page carries the report
// header line and "Page x of y".

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { FinanceReport } from './report';
import { effectiveNla } from './projection';

export const INK = rgb(0.157, 0.169, 0.153);
export const MUTED = rgb(0.455, 0.435, 0.4);
export const TERRA = rgb(0.741, 0.42, 0.314);
export const OLIVE = rgb(0.2, 0.27, 0.2);
export const LINE = rgb(0.882, 0.847, 0.796);
export const SHADE = rgb(0.965, 0.953, 0.937);
export const RED = rgb(0.65, 0.2, 0.17);

export const W = 595;
export const H = 842;
export const M = 40;
const BOTTOM = 56;

export function ascii(s: string): string {
  return String(s)
    .replace(/[—–−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[•·]/g, '-')
    .replace(/→/g, '->')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/✓|✔/g, 'v')
    .replace(/[^\x20-\x7E\n]/g, '?');
}

export const sgd = (n: number | null | undefined, dp = 2) =>
  n == null ? '-' : (n < 0 ? '-' : '') + 'S$' + Math.abs(n).toLocaleString('en-SG', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const num = (n: number | null | undefined) => (n == null ? '-' : n.toLocaleString('en-SG'));
export const pct = (n: number | null | undefined) => (n == null ? '-' : `${n.toFixed(1)}%`);
export const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const monthLabel = (fm: string) => new Date(`${fm}-01T00:00:00Z`).toLocaleDateString('en-SG', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** Model month t (1-based) -> "Month 18 (Apr 2027)" from the model start date. */
export const modelMonth = (start: string, t: number | null) => {
  if (t == null) return 'Not in horizon';
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7)) - 1 + (t - 1);
  const d = new Date(Date.UTC(y + Math.floor(m / 12), m % 12, 1));
  return `Month ${t} (${d.toLocaleDateString('en-SG', { month: 'short', year: 'numeric', timeZone: 'UTC' })})`;
};
const STAGE_LABEL: Record<string, string> = { OPEN: 'Open', REMINDER: 'Reminder', FORMAL_NOTICE: 'Formal notice', LATE_FEE_POSTED: 'Late fee posted', RESTRICTED: 'Access restricted', RESOLVED: 'Resolved' };

export interface Col {
  label: string;
  width: number; // fraction of the content width
  align?: 'left' | 'right';
}

export class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  constructor(private doc: PDFDocument, private regular: PDFFont, private bold: PDFFont, private headerLine: string) {}

  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.pages.push(this.page);
    this.text(this.headerLine, M, H - 28, 8, this.regular, MUTED);
    this.page.drawLine({ start: { x: M, y: H - 36 }, end: { x: W - M, y: H - 36 }, color: LINE, thickness: 0.8 });
    this.y = H - 58;
  }

  need(h: number) {
    if (this.y - h < BOTTOM) this.newPage();
  }

  text(s: string, x: number, y: number, size = 9, font = this.regular, color = INK) {
    this.page.drawText(ascii(s), { x, y, size, font, color });
  }

  fit(s: string, width: number, size: number, font: PDFFont): string {
    let t = ascii(s);
    if (font.widthOfTextAtSize(t, size) <= width) return t;
    while (t.length > 1 && font.widthOfTextAtSize(t + '...', size) > width) t = t.slice(0, -1);
    return t + '...';
  }

  wrap(s: string, width: number, size: number, font = this.regular): string[] {
    const words = ascii(s).split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const next = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  section(title: string, intro?: string) {
    this.need(70);
    this.y -= 8;
    this.page.drawRectangle({ x: M, y: this.y - 4, width: 3, height: 16, color: TERRA });
    this.text(title, M + 10, this.y, 13, this.bold);
    this.y -= 18;
    if (intro) this.para(intro, 8.5, MUTED);
    this.y -= 4;
  }

  sub(title: string, note?: string, noteColor = MUTED) {
    this.need(50);
    this.text(title, M, this.y, 10, this.bold);
    if (note) {
      const w = this.bold.widthOfTextAtSize(ascii(title), 10);
      this.text(note, M + w + 8, this.y, 8.5, this.regular, noteColor);
    }
    this.y -= 14;
  }

  para(s: string, size = 9, color = INK) {
    for (const line of this.wrap(s, W - 2 * M, size)) {
      this.need(size + 4);
      this.text(line, M, this.y, size, this.regular, color);
      this.y -= size + 4;
    }
  }

  table(cols: Col[], rows: string[][], opts: { totals?: string[]; empty?: string } = {}) {
    const cw = W - 2 * M;
    const xs: number[] = [];
    let x = M;
    for (const c of cols) { xs.push(x); x += c.width * cw; }
    const rowH = 15;
    const drawHead = () => {
      this.page.drawRectangle({ x: M, y: this.y - 4, width: cw, height: rowH, color: SHADE });
      cols.forEach((c, i) => this.cell(c.label.toUpperCase(), xs[i], c.width * cw, c.align, 7, this.bold, MUTED));
      this.y -= rowH;
    };
    this.need(rowH * 2 + 4);
    drawHead();
    if (!rows.length) {
      this.cell(opts.empty ?? 'No records in this period.', M, cw, 'left', 8.5, this.regular, MUTED);
      this.y -= rowH;
    }
    for (const r of rows) {
      if (this.y - rowH < BOTTOM) { this.newPage(); drawHead(); }
      r.forEach((v, i) => this.cell(v, xs[i], cols[i].width * cw, cols[i].align, 8.5, this.regular, INK));
      this.page.drawLine({ start: { x: M, y: this.y - 5 }, end: { x: W - M, y: this.y - 5 }, color: LINE, thickness: 0.5 });
      this.y -= rowH;
    }
    if (opts.totals) {
      this.need(rowH);
      opts.totals.forEach((v, i) => this.cell(v, xs[i], cols[i].width * cw, cols[i].align, 8.5, this.bold, INK));
      this.y -= rowH;
    }
    this.y -= 8;
  }

  cell(v: string, x: number, w: number, align: 'left' | 'right' = 'left', size: number, font: PDFFont, color: ReturnType<typeof rgb>) {
    const pad = 4;
    const t = this.fit(v, w - 2 * pad, size, font);
    const tx = align === 'right' ? x + w - pad - font.widthOfTextAtSize(t, size) : x + pad;
    this.page.drawText(t, { x: tx, y: this.y, size, font, color });
  }

  kpiGrid(items: Array<{ label: string; value: string; note?: string }>) {
    const cols = 3;
    const gap = 8;
    const cw = (W - 2 * M - gap * (cols - 1)) / cols;
    const h = 50;
    for (let i = 0; i < items.length; i += cols) {
      this.need(h + gap);
      items.slice(i, i + cols).forEach((k, j) => {
        const x = M + j * (cw + gap);
        this.page.drawRectangle({ x, y: this.y - h + 10, width: cw, height: h, borderColor: LINE, borderWidth: 0.8, color: rgb(1, 1, 1) });
        this.text(this.fit(k.label, cw - 16, 8, this.regular), x + 8, this.y - 4, 8, this.regular, MUTED);
        this.text(this.fit(k.value, cw - 16, 14, this.bold), x + 8, this.y - 22, 14, this.bold, INK);
        if (k.note) this.text(this.fit(k.note, cw - 16, 7, this.regular), x + 8, this.y - 34, 7, this.regular, MUTED);
      });
      this.y -= h + gap;
    }
    this.y -= 4;
  }
}

export async function buildFinanceReportPdf(r: FinanceReport): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`StoreLah financial report ${r.meta.from} to ${r.meta.to}`);
  doc.setAuthor('StoreLah CMS');
  doc.setCreator('StoreLah CMS');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const period = `${day(r.meta.from)} - ${day(r.meta.to)}`;
  const basisLabel = r.meta.basis === 'cash' ? 'Cash basis' : 'Accrual basis';
  const w = new Writer(doc, regular, bold, `StoreLah financial report  |  ${period}  |  ${r.meta.facility}  |  ${basisLabel}`);

  // ---- Cover band ----
  w.page = doc.addPage([W, H]);
  w.pages.push(w.page);
  w.page.drawRectangle({ x: 0, y: H - 150, width: W, height: 150, color: OLIVE });
  w.text('StoreLah', M, H - 58, 24, bold, rgb(1, 1, 1));
  w.text('FINANCIAL REPORT', M, H - 82, 11, bold, rgb(0.93, 0.85, 0.78));
  w.text(period, M, H - 106, 14, regular, rgb(1, 1, 1));
  w.text(`${r.meta.facility}  |  ${basisLabel}`, M, H - 126, 10, regular, rgb(0.9, 0.9, 0.88));
  w.y = H - 178;
  const metaRow = (k: string, v: string) => { w.text(k, M, w.y, 9, regular, MUTED); w.text(v, M + 120, w.y, 9); w.y -= 14; };
  metaRow('Generated', new Date(r.meta.generatedAt).toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' }) + ' SGT');
  metaRow('Generated by', r.meta.generatedBy);
  metaRow('Facilities', r.meta.facilities.join(', ') || '-');
  metaRow('Classification', 'Internal - management use. Not an audited statement.');
  w.y -= 6;
  w.para(
    r.meta.basis === 'cash'
      ? 'Cash basis: revenue is the payments received in the period. Receivables are the open invoice balance under both bases.'
      : 'Accrual basis: revenue is the issued invoices for the service period. Receivables are the open invoice balance under both bases.',
    8.5, MUTED,
  );
  if (r.meta.monthsTruncated) w.para(`Monthly sections cover the latest ${r.meta.months.length} months of the period.`, 8.5, MUTED);
  w.y -= 6;

  // ---- 1. Summary ----
  if (r.summary) {
    const s = r.summary;
    w.section('Summary', 'Live figures from the invoice, payment, refund, tenant, booking and notice records for the period.');
    w.kpiGrid(s.kpis.map((k) => ({
      label: k.label,
      value: !k.connected || k.value == null ? 'Not connected' : k.format === 'money' ? sgd(k.value, 0) : k.format === 'percent' ? pct(k.value) : num(k.value),
      note: k.note,
    })));
    w.sub('Collection trend', '(last six months)');
    w.table(
      [{ label: 'Month', width: 0.34 }, { label: 'Billed', width: 0.22, align: 'right' }, { label: 'Collected', width: 0.22, align: 'right' }, { label: 'Collection rate', width: 0.22, align: 'right' }],
      s.collectionTrend.map((t) => [monthLabel(t.month.slice(0, 7)), sgd(t.billed), sgd(t.collected), pct(t.rate == null ? null : t.rate)]),
    );
    const snap = s.snapshot;
    w.sub('Cash and control');
    w.table(
      [{ label: 'Item', width: 0.5 }, { label: 'Value', width: 0.5, align: 'right' }],
      [
        ['Refunds pending', sgd(snap.refundsPending.value)],
        ['Customer credit balance', sgd(snap.creditBalance.value)],
        ['Unallocated receipts', snap.unallocatedReceipts.connected ? sgd(snap.unallocatedReceipts.value) : 'Not connected'],
        ['Reconciliation exceptions', snap.reconciliationExceptions.connected ? num(snap.reconciliationExceptions.value) : 'Not connected'],
      ],
    );
  }

  // ---- 2. Forecast vs actuals ----
  if (r.performance) {
    w.section('Forecast vs actuals', 'One table per facility, one row per month. Forecast comes from the current financial model. Costs = operating expenses + lease; NOI = net operating income. Closed months show posted actuals; open months show provisional actuals computed from live records.');
    const byBranch = new Map<string, typeof r.performance>();
    for (const p of r.performance) byBranch.set(p.branch, [...(byBranch.get(p.branch) ?? []), p]);
    for (const [branch, list] of byBranch) {
      w.sub(branch);
      const v = (p: (typeof list)[number], m: string, k: 'actual' | 'forecast') => p.rows.find((x) => x.metric === m)?.[k] ?? null;
      w.table(
        [{ label: 'Month', width: 0.15 }, { label: 'Status', width: 0.12 }, { label: 'Revenue', width: 0.11, align: 'right' }, { label: 'Forecast', width: 0.11, align: 'right' }, { label: 'Cash', width: 0.1, align: 'right' }, { label: 'Costs', width: 0.1, align: 'right' }, { label: 'NOI', width: 0.1, align: 'right' }, { label: 'NOI fcst', width: 0.11, align: 'right' }, { label: 'NOI var.', width: 0.1, align: 'right' }],
        list.map((p) => {
          const opex = v(p, 'OPEX', 'actual');
          const lease = v(p, 'LEASE', 'actual');
          const noi = v(p, 'NOI', 'actual');
          const noiF = v(p, 'NOI', 'forecast');
          return [
            monthLabel(p.fiscalMonth), p.closed ? 'Closed' : 'Provisional',
            sgd(v(p, 'REVENUE', 'actual'), 0), sgd(v(p, 'REVENUE', 'forecast'), 0), sgd(v(p, 'CASH', 'actual'), 0),
            opex == null && lease == null ? '-' : sgd((opex ?? 0) + (lease ?? 0), 0), sgd(noi, 0), sgd(noiF, 0),
            noi != null && noiF != null ? sgd(noi - noiF, 0) : '-',
          ];
        }),
      );
    }
    if (r.performance.some((p) => !p.closed)) w.para('Provisional: the month is not closed, so actuals may still change.', 8, RED);
  }

  // ---- 3. Budgets & expenses ----
  if (r.budgets) {
    w.section('Budgets and expenses', 'Operating budget lines with recorded expenses. The lease line comes from the current financial model. Months without budget lines are omitted.');
    const byBranch = new Map<string, typeof r.budgets>();
    for (const b of r.budgets) byBranch.set(b.branch, [...(byBranch.get(b.branch) ?? []), b]);
    for (const [branch, list] of byBranch) {
      const rows: string[][] = [];
      let tb = 0;
      let ta = 0;
      for (const b of list) {
        if (b.lease != null && b.lease !== 0) rows.push([monthLabel(b.fiscalMonth), 'Lease (from model)', sgd(b.lease), '-', '-']);
        for (const l of b.lines) rows.push([monthLabel(b.fiscalMonth), l.category, sgd(l.budget), sgd(l.actual), sgd(l.variance)]);
        if (b.lines.length || (b.lease ?? 0) !== 0) { tb += b.totalBudget; ta += b.totalActual; }
      }
      w.sub(branch);
      w.table(
        [{ label: 'Month', width: 0.2 }, { label: 'Category', width: 0.32 }, { label: 'Budget', width: 0.16, align: 'right' }, { label: 'Actual', width: 0.16, align: 'right' }, { label: 'Variance', width: 0.16, align: 'right' }],
        rows,
        { totals: rows.length ? ['Total', '', sgd(tb), sgd(ta), ''] : undefined, empty: 'No budget lines in this period.' },
      );
    }
  }

  // ---- 4. Arrears ----
  if (r.arrears) {
    const a = r.arrears;
    w.section('Arrears', `Open recovery cases as at the report date: ${a.openCount} case${a.openCount === 1 ? '' : 's'}, ${sgd(a.openBalance)} outstanding.`);
    w.table(
      [{ label: 'Stage', width: 0.5 }, { label: 'Cases', width: 0.2, align: 'right' }, { label: 'Balance', width: 0.3, align: 'right' }],
      a.byStage.map((s) => [STAGE_LABEL[s.stage] ?? s.stage, num(s.count), sgd(s.balance)]),
      { empty: 'No open arrears cases.' },
    );
    if (a.cases.length) {
      w.sub('Open cases', '(most overdue first)');
      w.table(
        [{ label: 'Customer', width: 0.28 }, { label: 'Facility', width: 0.17 }, { label: 'Invoice', width: 0.17 }, { label: 'Balance', width: 0.14, align: 'right' }, { label: 'Days', width: 0.08, align: 'right' }, { label: 'Stage', width: 0.16 }],
        a.cases.map((c) => [c.tenant, c.branch ?? '-', c.invoiceNo ?? '-', sgd(c.balance), num(c.daysOverdue), STAGE_LABEL[c.stage] ?? c.stage]),
      );
    }
  }

  // ---- 5. Transactions ----
  if (r.transactions) {
    const t = r.transactions;
    w.section('Transactions and approvals', `${t.total} records dated in the period; ${t.pending} awaiting approval, ${t.failed} failed. Negative amounts are refunds or credits to customers.`);
    w.table(
      [{ label: 'Document type', width: 0.5 }, { label: 'Records', width: 0.2, align: 'right' }, { label: 'Net amount', width: 0.3, align: 'right' }],
      t.byType.map((x) => [x.docType, num(x.count), sgd(x.amount)]),
    );
    if (t.pendingRows.length) {
      w.sub('Awaiting approval');
      w.table(
        [{ label: 'Date', width: 0.13 }, { label: 'Record', width: 0.16 }, { label: 'Customer', width: 0.22 }, { label: 'Type', width: 0.16 }, { label: 'Amount', width: 0.13, align: 'right' }, { label: 'Status', width: 0.2 }],
        t.pendingRows.map((x) => [day(x.date), x.recordId, x.customer, x.docType, sgd(x.amount), x.status]),
      );
    }
  }

  // ---- 6. Reconciliation ----
  if (r.reconciliation) {
    w.section('Reconciliation', 'Processor settlements against invoices posted, per facility and month.');
    w.table(
      [{ label: 'Facility', width: 0.16 }, { label: 'Month', width: 0.16 }, { label: 'Settled', width: 0.13, align: 'right' }, { label: 'Allocated', width: 0.13, align: 'right' }, { label: 'Variance', width: 0.11, align: 'right' }, { label: 'Open items', width: 0.12, align: 'right' }, { label: 'Status', width: 0.19 }],
      r.reconciliation.map((x) => [x.branch, monthLabel(x.fiscalMonth), sgd(x.settled), sgd(x.allocated), sgd(x.variance), num(x.unmatched + x.suspense), x.status]),
    );
  }

  // ---- 7. Financial model ----
  if (r.model) {
    w.section('Financial model', 'Each facility\u2019s current approved financial model (Finance > Financial models): the assumptions it is built on and the projection they produce. Projections, not results; the forecast columns in Forecast vs actuals come from the same model.');
    for (const fm of r.model) {
      if (!fm.model) {
        w.sub(fm.branch);
        w.para('No current approved model for this facility.', 8.5, MUTED);
        w.y -= 6;
        continue;
      }
      const { inputs: i, kpis: k } = fm.model;
      w.sub(fm.branch, `${fm.model.name}  |  v${fm.model.version}  |  approved, updated ${day(fm.model.updatedAt)} by ${fm.model.updatedBy}`);
      w.kpiGrid([
        { label: 'Weighted start PSF', value: `S$${k.weightedStartPsf.toFixed(2)}`, note: 'per sq ft per month' },
        { label: 'Capital investment', value: sgd(i.capitalTotal, 0) },
        { label: 'NOI positive', value: modelMonth(i.startDate, k.noiPositiveMonth) },
        { label: 'Stabilised occupancy', value: modelMonth(i.startDate, k.stabilisedMonth), note: `Target ${pct(i.occupancy.targetPct)}` },
        { label: 'Payback', value: modelMonth(i.startDate, k.paybackMonth), note: 'Cumulative cash back to zero' },
        { label: 'IRR (annualised)', value: k.irrAnnualised == null ? 'Not available' : pct(k.irrAnnualised * 100), note: 'Operating cash flows, no sale value' },
      ]);
      // Runs of equal years collapse: "S$5,000/month (years 1-5), S$5,500/month (years 6-10)".
      const leaseRuns: Array<{ v: number; a: number; b: number }> = [];
      i.lease.monthlyByYear.forEach((v, n) => {
        const last = leaseRuns[leaseRuns.length - 1];
        if (last && last.v === v) last.b = n + 1;
        else leaseRuns.push({ v, a: n + 1, b: n + 1 });
      });
      const leaseYears = leaseRuns.map((x) => `${sgd(x.v, 0)}/month (${x.a === x.b ? `year ${x.a}` : `years ${x.a}-${x.b}`})`).join(', ');
      w.sub('Key assumptions');
      w.table(
        [{ label: 'Assumption', width: 0.36 }, { label: 'Value', width: 0.64 }],
        [
          ['Opening date / horizon', `${day(i.startDate)}  |  ${i.horizonMonths} months`],
          ['Net lettable area (NLA)', `${num(effectiveNla(i))} sq ft`],
          ['Move-in ramp (gross)', `${num(i.occupancy.rampFirst6)} sq ft/month (months 1-6), ${num(i.occupancy.rampFrom7)} sq ft/month (month 7+)`],
          ['Move-out rate', `${pct(i.occupancy.moveOutRatePct)} per month from month ${i.occupancy.churnStartMonth}`],
          ['Target occupancy', pct(i.occupancy.targetPct)],
          ['Annual rent increase', pct(i.pricing.annualIncreasePct)],
          ['Lease (monthly, by model year)', leaseYears || '-'],
          ['Rent-free months', num(i.lease.rentFreeMonths)],
          ['Non-lease operating costs', `${sgd(i.opex.baseMonthly, 0)}/month, growing ${pct(i.opex.annualGrowthPct)} a year`],
        ],
      );
      if (i.sizeMix.length) {
        w.sub('Size mix');
        const units = i.sizeMix.reduce((t, x) => t + x.units, 0);
        const nla = i.sizeMix.reduce((t, x) => t + x.nlaSqft, 0);
        w.table(
          [{ label: 'Size', width: 0.3 }, { label: 'Range', width: 0.22 }, { label: 'Units', width: 0.14, align: 'right' }, { label: 'NLA (sq ft)', width: 0.17, align: 'right' }, { label: 'PSF / month', width: 0.17, align: 'right' }],
          i.sizeMix.map((x) => [x.name, x.range ?? '-', num(x.units), num(x.nlaSqft), `S$${x.psf.toFixed(2)}`]),
          { totals: ['Total', '', num(units), num(nla), `S$${k.weightedStartPsf.toFixed(2)}`] },
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
      w.sub('Projection by model year');
      w.table(
        [{ label: 'Year', width: 0.1 }, { label: 'Revenue', width: 0.16, align: 'right' }, { label: 'Operating cost', width: 0.16, align: 'right' }, { label: 'NOI', width: 0.15, align: 'right' }, { label: 'NOI margin', width: 0.12, align: 'right' }, { label: 'Cash at year end', width: 0.17, align: 'right' }, { label: 'Occupied sq ft', width: 0.14, align: 'right' }],
        k.years.map((y) => [`Year ${y.year}`, sgd(y.revenue, 0), sgd(y.operatingCost, 0), sgd(y.noi, 0), pct(y.noiMarginPct), sgd(y.cashAtYearEnd, 0), num(Math.round(y.closingSqft))]),
        { empty: 'No projection years.' },
      );
      if (fm.model.failedChecks.length) w.para(`Model checks not passing: ${fm.model.failedChecks.join('; ')}`, 8, RED);
    }
  }

  // ---- 8. Investment returns ----
  if (r.returns) {
    w.section('Investment returns', 'Five-year view from each facility’s current approved financial model. Projections, not results.');
    w.table(
      [{ label: 'Facility', width: 0.18 }, { label: 'Model', width: 0.22 }, { label: 'Investment', width: 0.16, align: 'right' }, { label: 'Payback', width: 0.12, align: 'right' }, { label: 'IRR', width: 0.1, align: 'right' }, { label: 'NPV', width: 0.12, align: 'right' }, { label: 'NOI margin', width: 0.1, align: 'right' }],
      r.returns.map((x) => [x.branch, x.model, sgd(x.initialInvestment, 0), x.paybackMonth == null ? 'Beyond 5y' : `Month ${x.paybackMonth}`, x.irr == null ? 'Not available' : pct(x.irr * 100), sgd(x.npv, 0), pct(x.noiMarginPct)]),
      { empty: 'No facility has a current approved model.' },
    );
  }

  // ---- Footer on every page ----
  const total = w.pages.length;
  w.pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 40 }, end: { x: W - M, y: 40 }, color: LINE, thickness: 0.6 });
    p.drawText(ascii('StoreLah Pte. Ltd.  |  UEN: ____ (to be confirmed by owner)  |  Internal - management use'), { x: M, y: 28, size: 7, font: regular, color: MUTED });
    const label = `Page ${i + 1} of ${total}`;
    p.drawText(label, { x: W - M - regular.widthOfTextAtSize(label, 7), y: 28, size: 7, font: regular, color: MUTED });
  });

  return Buffer.from(await doc.save());
}

/** File name: StoreLah_Financial_Report_<from>_<to>_<facility>_<basis>.pdf */
export function financeReportFileName(r: FinanceReport): string {
  const fac = r.meta.facility.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'All';
  return `StoreLah_Financial_Report_${r.meta.from}_${r.meta.to}_${fac}_${r.meta.basis}.pdf`;
}

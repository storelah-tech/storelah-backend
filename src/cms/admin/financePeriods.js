// StoreLah CMS admin UI — Finance reporting-period presets.
//
// Pure (no DOM, no API imports) so the e2e suite can feed the exact query
// values the Overview view sends straight into the API. The CMS date-range
// contract (src/lib/dateRange.ts) takes calendar days as YYYY-MM-DD with
// inclusive UTC bounds — never ISO timestamps.

export const REPORTING_PERIODS = [
  ['all', 'All time'],
  ['this-m', 'This month'],
  ['last-m', 'Last month'],
  ['last-3m', 'Last 3 months'],
  ['last-6m', 'Last 6 months'],
  ['last-12m', 'Last 12 months'],
  ['ytd', 'Year to date'],
  ['this-y', 'This year'],
];

const ymd = (d) => d.toISOString().slice(0, 10);

/** Resolve the selected preset into { from, to } as YYYY-MM-DD (UTC months). */
export function reportingRange(period, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const startOf = (yy, mm) => ymd(new Date(Date.UTC(yy, mm, 1)));
  const endOf = (yy, mm) => ymd(new Date(Date.UTC(yy, mm + 1, 0)));
  switch (period) {
    case 'this-m': return { from: startOf(y, m), to: endOf(y, m) };
    case 'last-m': return { from: startOf(y, m - 1), to: endOf(y, m - 1) };
    case 'last-3m': return { from: startOf(y, m - 2), to: endOf(y, m) };
    case 'last-6m': return { from: startOf(y, m - 5), to: endOf(y, m) };
    case 'last-12m': return { from: startOf(y, m - 11), to: endOf(y, m) };
    case 'ytd': return { from: startOf(y, 0), to: endOf(y, m) };
    case 'this-y': return { from: startOf(y, 0), to: endOf(y, 11) };
    case 'all':
    default: return { from: null, to: null };
  }
}

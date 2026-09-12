// StoreLah CMS admin UI — shared date-range filter control.
//
// Daterangepicker-style UX (cf. daterangepicker.com): each table toolbar gets a
// SINGLE trigger button (calendar icon + range label, "All dates" when
// unfiltered). Clicking it opens a popup with a preset-ranges list on the left
// (Today, Yesterday, Last 7 Days, Last 30 Days, This Month, Last Month, Custom
// Range), two linked sequential month calendars, and an Apply / Cancel footer
// (+ Clear). Preset clicks apply immediately and close; Custom Range (or any
// manual day pick) stages a draft — click a start day, click an end day,
// in-range days highlight — committed only on Apply. Cancel / outside-click /
// ESC discards the draft. Clear (footer button, or the × joined to the trigger
// while a range is active) resets to unfiltered.
//
// Vanilla JS only (no jQuery/moment, no new dependencies). Styling reuses the
// v8 tokens + existing `.filter` / `.btn` button classes; the extra `.drp-*`
// rules are injected once (single shared <style>, however many instances).
// Emits { from, to } (YYYY-MM-DD strings, or null when open-ended/unfiltered)
// via onChange on preset-apply / Apply / Clear. Flip-above: the fixed popup
// opens below its trigger but flips above when it would overflow the viewport
// bottom (simple bounding-rect check in reposition()).

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// Inline calendar glyph (SVG, no emoji anywhere in this control).
const CAL_SVG =
  '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="2" y="3.5" width="14" height="12" rx="2"/>' +
  '<path d="M2 7.5h14M6 2v3M12 2v3"/></svg>';

export function blankRange() {
  return { from: null, to: null };
}

export function isRangeActive(r) {
  return !!(r && (r.from || r.to));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Local-day key YYYY-MM-DD (matches the calendar's local-day math).
export function dayKey(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
}

function parseKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(key, n) {
  const x = parseKey(key);
  x.setDate(x.getDate() + n);
  return dayKey(x);
}

function monthKey(y, m) {
  return y + '-' + pad(m + 1);
}

function shiftMonth(y, m, n) {
  const d = new Date(y, m + n, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
}

function presetRange(name) {
  const t = dayKey(new Date());
  switch (name) {
    case 'today': return { from: t, to: t };
    case 'yesterday': { const y = addDays(t, -1); return { from: y, to: y }; }
    case 'last7': return { from: addDays(t, -6), to: t };
    case 'last30': return { from: addDays(t, -29), to: t };
    case 'thisMonth': return { from: t.slice(0, 7) + '-01', to: t };
    case 'lastMonth': {
      const now = new Date();
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const start = dayKey(prev);
      const end = dayKey(new Date(now.getFullYear(), now.getMonth(), 0));
      return { from: start, to: end };
    }
    default: return blankRange();
  }
}

function fmtDay(key) {
  const d = parseKey(key);
  return MON[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

// Trigger + empty-state label. Default "All dates"; e.g. "Sep 1 – Sep 8, 2026".
// Open-ended shapes are kept for server-compat (withDateQuery passes either end
// through) even though the popup always commits both ends.
export function rangeLabel(r) {
  if (!isRangeActive(r)) return 'All dates';
  if (r.from && r.to) {
    if (r.from === r.to) return fmtDay(r.from);
    const a = parseKey(r.from);
    const b = parseKey(r.to);
    if (a.getFullYear() === b.getFullYear()) {
      return MON[a.getMonth()] + ' ' + a.getDate() + ' – ' + MON[b.getMonth()] + ' ' + b.getDate() + ', ' + a.getFullYear();
    }
    return fmtDay(r.from) + ' – ' + fmtDay(r.to);
  }
  if (r.from) return 'from ' + fmtDay(r.from);
  return 'until ' + fmtDay(r.to);
}

// Appends ?from=&to= to a GET path (handles paths that already carry a query).
export function withDateQuery(path, r) {
  if (!isRangeActive(r)) return path;
  const parts = [];
  if (r.from) parts.push('from=' + encodeURIComponent(r.from));
  if (r.to) parts.push('to=' + encodeURIComponent(r.to));
  return path + (path.includes('?') ? '&' : '?') + parts.join('&');
}

// Range-aware empty-state copy: "No leads in Sep 1 – Sep 8, 2026 — clear the
// date filter" when a range is active, otherwise the table's default text.
export function rangeEmptyText(noun, r, fallback) {
  if (!isRangeActive(r)) return fallback;
  return 'No ' + noun + ' in ' + rangeLabel(r) + ' — clear the date filter.';
}

const PRESETS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['last7', 'Last 7 Days'],
  ['last30', 'Last 30 Days'],
  ['thisMonth', 'This Month'],
  ['lastMonth', 'Last Month'],
  ['custom', 'Custom Range'],
];

// ---------- shared popup CSS (injected once no matter how many instances) ----------

function ensureDrpStyles() {
  if (document.querySelector('style[data-drp]')) return;
  const st = document.createElement('style');
  st.setAttribute('data-drp', '1');
  st.textContent =
    '.drp{display:inline-flex;align-items:stretch}' +
    '.drp-trigger{display:inline-flex!important;align-items:center;gap:7px;font-weight:700!important}' +
    '.drp-trigger svg{width:15px;height:15px;flex:none;color:var(--olive2, #526557)}' +
    '.drp-trigger[data-has-range="1"]{border-color:var(--olive, #334437);background:var(--sage, #dfe7dd);color:var(--olive, #334437)}' +
    '.drp-x{margin-left:-4px;border-top-left-radius:0!important;border-bottom-left-radius:0!important;font-weight:800}' +
    '.drp-trigger[data-has-range="1"]{border-top-right-radius:0;border-bottom-right-radius:0}' +
    '.drp-popup{position:fixed;z-index:250;display:flex;gap:0;background:var(--paper, #fffdfa);' +
    'border:1px solid var(--line, #e6e0d7);border-radius:14px;box-shadow:0 18px 50px rgba(46,47,40,.18);' +
    'padding:14px;font:13px/1.45 Manrope,system-ui,sans-serif;color:var(--ink, #20241f);max-width:calc(100vw - 16px)}' +
    '.drp-ranges{list-style:none;display:flex;flex-direction:column;gap:2px;min-width:132px;padding-right:12px;' +
    'border-right:1px solid var(--line, #e6e0d7);margin-right:12px}' +
    '.drp-ranges button{border:0;background:transparent;text-align:left;padding:7px 10px;border-radius:8px;' +
    'font:inherit;font-weight:600;color:var(--ink, #20241f);cursor:pointer;white-space:nowrap}' +
    '.drp-ranges button:hover{background:var(--cream, #f7f3ec)}' +
    '.drp-ranges button.active{background:var(--olive, #334437);color:#fff}' +
    '.drp-cals{display:flex;gap:14px;flex-wrap:wrap}' +
    '.drp-cal{width:212px;outline:none}' +
    '.drp-cal-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}' +
    '.drp-title{font-weight:800;font-size:12.5px}' +
    '.drp-nav{border:1px solid var(--line, #e6e0d7);background:#fff;border-radius:7px;width:26px;height:26px;' +
    'display:grid;place-items:center;cursor:pointer;color:var(--olive, #334437);font-size:14px;line-height:1}' +
    '.drp-nav:hover{background:var(--cream, #f7f3ec)}' +
    '.drp-nav.hidden{visibility:hidden}' +
    '.drp-dow,.drp-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:1px;text-align:center}' +
    '.drp-dow{color:var(--muted, #6f746d);font-size:10px;font-weight:700;margin-bottom:3px}' +
    '.drp-day{border:0;background:transparent;border-radius:7px;min-width:0;height:28px;font:inherit;font-size:12px;' +
    'cursor:pointer;color:var(--ink, #20241f)}' +
    '.drp-day:hover{background:#eee8df}' +
    '.drp-day.is-today{box-shadow:inset 0 0 0 1.5px var(--terra, #c97952)}' +
    '.drp-day.is-inrange{background:var(--sage, #dfe7dd);border-radius:0}' +
    '.drp-day.is-hover{background:#edf1eb;border-radius:0}' +
    '.drp-day.is-start,.drp-day.is-end{background:var(--olive, #334437)!important;color:#fff!important;font-weight:800}' +
    '.drp-day.is-start{border-radius:7px 0 0 7px}.drp-day.is-end{border-radius:0 7px 7px 0}' +
    '.drp-day.is-start.is-end{border-radius:7px}' +
    '.drp-blank{min-height:28px}' +
    '.drp-foot{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:10px;' +
    'border-top:1px solid var(--line, #e6e0d7);grid-column:1/-1}' +
    '.drp-hint{flex:1;font-size:11.5px;font-weight:700;color:var(--muted, #6f746d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.drp-clear{border:0;background:transparent;color:var(--terra2, #aa5d3c);font:inherit;font-weight:800;cursor:pointer;padding:8px 6px}' +
    '.drp-clear:hover{text-decoration:underline}' +
    '@media(max-width:640px){.drp-popup{flex-direction:column;max-height:calc(100vh - 32px);overflow:auto}' +
    '.drp-ranges{flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line, #e6e0d7);' +
    'padding:0 0 10px;margin:0 0 10px;min-width:0}}';
  document.head.appendChild(st);
}

// ---------- one-open-popup-at-a-time plumbing (module-global) ----------

let openCtl = null;
let globalBound = false;

function ensureGlobal() {
  if (globalBound) return;
  globalBound = true;
  // Outside click (capture so it runs before the trigger's own toggle).
  document.addEventListener('pointerdown', (e) => {
    if (!openCtl || !openCtl._popup) return;
    const t = e.target;
    if (openCtl._popup.contains(t)) return;
    if (openCtl._anchor && openCtl._anchor.contains(t)) return;
    openCtl.close();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openCtl) openCtl.close();
  });
  window.addEventListener('resize', () => { if (openCtl) openCtl.reposition(); });
  window.addEventListener('scroll', () => { if (openCtl) openCtl.reposition(); }, true);
}

// Creates the control; the caller inserts handle.el where it belongs.
// onChange(range) fires on preset-apply, footer Apply, and Clear.
// handle.set(range, silent?) replaces the committed range (silent skips emit,
// for paired controls sharing state); handle.get() reads it.
export function createDateFilter({ onChange } = {}) {
  ensureDrpStyles();
  ensureGlobal();

  const el = document.createElement('span');
  el.className = 'datefilter drp';
  el.dataset.active = '0';
  el.innerHTML =
    '<button type="button" class="filter drp-trigger" aria-haspopup="dialog" aria-expanded="false">' +
    CAL_SVG + '<span data-label>All dates</span></button>' +
    '<button type="button" class="filter drp-x" title="Clear date filter" aria-label="Clear date filter" hidden>&times;</button>';

  const trigger = el.querySelector('.drp-trigger');
  const labelEl = el.querySelector('[data-label]');
  const xBtn = el.querySelector('.drp-x');

  let committed = blankRange();

  const api = {
    el,
    _popup: null,
    _anchor: el,
    get: () => ({ ...committed }),
    set,
    paint,
    open,
    close,
    reposition,
  };

  function emit() {
    if (onChange) onChange({ ...committed });
  }

  function paint() {
    const active = isRangeActive(committed);
    el.dataset.active = active ? '1' : '0';
    labelEl.textContent = rangeLabel(committed);
    trigger.dataset.hasRange = active ? '1' : '0';
    xBtn.hidden = !active;
  }

  function set(r, silent) {
    committed = { from: (r && r.from) || null, to: (r && r.to) || null };
    paint();
    if (api._popup) renderPopup();
    if (!silent) emit();
  }

  function clearAll() {
    committed = blankRange();
    paint();
    close();
    emit();
  }

  // ----- popup -----

  // Staged selection while the popup is open (nulls = nothing picked yet).
  let draft = blankRange();
  let baseY = 0;
  let baseM = 0;
  let hoverKey = null;

  function open() {
    if (api._popup) { close(); return; }
    if (openCtl && openCtl !== api) openCtl.close();
    draft = { ...committed };
    const anchor = draft.from ? parseKey(draft.from) : new Date();
    baseY = anchor.getFullYear();
    baseM = anchor.getMonth();
    hoverKey = null;

    const pop = document.createElement('div');
    pop.className = 'drp-popup';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose date range');
    pop.innerHTML =
      '<ul class="drp-ranges">' +
      PRESETS.map(([v, label]) => '<li><button type="button" data-preset="' + v + '">' + label + '</button></li>').join('') +
      '</ul>' +
      '<div><div class="drp-cals">' +
      '<div class="drp-cal" data-cal="0" tabindex="-1"></div>' +
      '<div class="drp-cal" data-cal="1"></div>' +
      '</div><div class="drp-foot"><span class="drp-hint" data-hint></span>' +
      '<button type="button" class="drp-clear" data-clear>Clear</button>' +
      '<button type="button" class="btn" data-cancel>Cancel</button>' +
      '<button type="button" class="btn olive" data-apply>Apply</button>' +
      '</div></div>';
    document.body.appendChild(pop);
    api._popup = pop;
    openCtl = api;
    trigger.setAttribute('aria-expanded', 'true');

    pop.addEventListener('click', onPopupClick);
    pop.addEventListener('mouseover', onPopupHover);
    renderPopup();
    reposition();
  }

  function close() {
    if (api._popup) {
      api._popup.removeEventListener('click', onPopupClick);
      api._popup.removeEventListener('mouseover', onPopupHover);
      api._popup.remove();
      api._popup = null;
    }
    if (openCtl === api) openCtl = null;
    trigger.setAttribute('aria-expanded', 'false');
  }

  function reposition() {
    const pop = api._popup;
    if (!pop) return;
    const r = trigger.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
    if (!Number.isFinite(left)) left = 8;
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) {
      const above = r.top - ph - 6;
      if (above >= 8) top = above;
    }
    pop.style.left = left + 'px';
    pop.style.top = Math.max(8, top) + 'px';
  }

  function activePreset() {
    for (const [v] of PRESETS) {
      if (v === 'custom') continue;
      const p = presetRange(v);
      if (p.from === draft.from && p.to === draft.to) return v;
    }
    return isRangeActive(draft) ? 'custom' : '';
  }

  function hintText() {
    if (draft.from && draft.to) return rangeLabel(draft);
    if (draft.from) return fmtDay(draft.from) + ' – pick an end date';
    return 'Pick a start date';
  }

  function renderPopup() {
    const pop = api._popup;
    if (!pop) return;
    const mark = activePreset();
    pop.querySelectorAll('[data-preset]').forEach((b) => {
      b.classList.toggle('active', b.dataset.preset === mark);
    });
    renderCal(pop.querySelector('[data-cal="0"]'), baseY, baseM, false);
    const n2 = shiftMonth(baseY, baseM, 1);
    renderCal(pop.querySelector('[data-cal="1"]'), n2.y, n2.m, true);
    pop.querySelector('[data-hint]').textContent = hintText();
    pop.querySelector('[data-apply]').disabled = !draft.from;
  }

  function renderCal(box, y, m, isRight) {
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const today = dayKey(new Date());
    const lo = draft.from && draft.to
      ? (draft.from <= draft.to ? draft.from : draft.to)
      : null;
    const hi = lo ? (draft.from <= draft.to ? draft.to : draft.from) : null;
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<span class="drp-blank"></span>';
    for (let d = 1; d <= days; d++) {
      const key = monthKey(y, m) + '-' + pad(d);
      const cls = ['drp-day'];
      if (key === today) cls.push('is-today');
      if (draft.from && !draft.to && key === draft.from) cls.push('is-start', 'is-end');
      if (lo && hi && key >= lo && key <= hi) {
        if (key === lo) cls.push('is-start');
        else if (key === hi) cls.push('is-end');
        else cls.push('is-inrange');
      }
      cells += '<button type="button" class="' + cls.join(' ') + '" data-day="' + key + '">' + d + '</button>';
    }
    box.innerHTML =
      '<div class="drp-cal-hdr">' +
      (isRight
        ? '<span class="drp-title">' + MON[m] + ' ' + y + '</span>'
        : '<button type="button" class="drp-nav" data-nav="-1" aria-label="Previous month">&lsaquo;</button>' +
          '<span class="drp-title">' + MON[m] + ' ' + y + '</span>') +
      (isRight
        ? '<button type="button" class="drp-nav" data-nav="1" aria-label="Next month">&rsaquo;</button>'
        : '<span class="drp-nav hidden" aria-hidden="true">&lsaquo;</span>') +
      '</div>' +
      '<div class="drp-dow">' + DOW.map((d) => '<span>' + d + '</span>').join('') + '</div>' +
      '<div class="drp-grid">' + cells + '</div>';
  }

  function onPopupClick(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const nav = t.closest('[data-nav]');
    if (nav) {
      const n = shiftMonth(baseY, baseM, Number(nav.dataset.nav));
      baseY = n.y;
      baseM = n.m;
      renderPopup();
      return;
    }
    const presetBtn = t.closest('[data-preset]');
    if (presetBtn) {
      choosePreset(presetBtn.dataset.preset);
      return;
    }
    if (t.closest('[data-cancel]')) { close(); return; }
    if (t.closest('[data-clear]')) { clearAll(); return; }
    if (t.closest('[data-apply]')) { applyDraft(); return; }
    const day = t.closest('[data-day]');
    if (day) pickDay(day.dataset.day);
  }

  function onPopupHover(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const day = t.closest('[data-day]');
    const key = day ? day.dataset.day : null;
    if (key === hoverKey) return;
    hoverKey = key;
    paintHover();
  }

  // Live end-date preview: while a start is staged but no end yet, shade the
  // span from the start to the hovered day.
  function paintHover() {
    const pop = api._popup;
    if (!pop || !draft.from || draft.to) return;
    pop.querySelectorAll('[data-day]').forEach((b) => {
      const k = b.dataset.day;
      b.classList.remove('is-hover', 'is-inrange');
      if (!hoverKey || k === draft.from) return;
      const a = draft.from < hoverKey ? draft.from : hoverKey;
      const z = draft.from < hoverKey ? hoverKey : draft.from;
      if (k > a && k < z) b.classList.add('is-hover');
      else if (k === hoverKey) b.classList.add('is-hover');
    });
  }

  function choosePreset(name) {
    if (name === 'custom') {
      // Focus the calendars for a manual pick, keeping any staged selection.
      draft = { ...draft };
      if (draft.from) {
        const a = parseKey(draft.from);
        baseY = a.getFullYear();
        baseM = a.getMonth();
      }
      renderPopup();
      const first = api._popup && api._popup.querySelector('[data-cal="0"]');
      if (first) first.focus({ preventScroll: true });
      return;
    }
    committed = presetRange(name);
    paint();
    close();
    emit();
  }

  function pickDay(key) {
    if (!draft.from || (draft.from && draft.to)) {
      draft = { from: key, to: null };
    } else if (key < draft.from) {
      draft = { from: key, to: draft.from };
    } else {
      draft = { from: draft.from, to: key };
    }
    hoverKey = null;
    renderPopup();
  }

  function applyDraft() {
    if (!draft.from) return;
    committed = { from: draft.from, to: draft.to || draft.from };
    paint();
    close();
    emit();
  }

  trigger.addEventListener('click', () => open());
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  xBtn.addEventListener('click', () => clearAll());

  paint();
  return api;
}

// Mounts the control into a toolbar element (idempotent per toolbar).
export function mountDateFilter(toolbar, opts = {}) {
  if (!toolbar || toolbar.dataset.dateFilterMounted) return null;
  toolbar.dataset.dateFilterMounted = '1';
  const handle = createDateFilter(opts);
  if (opts.before && opts.before.parentElement === toolbar) toolbar.insertBefore(handle.el, opts.before);
  else toolbar.appendChild(handle.el);
  return handle;
}

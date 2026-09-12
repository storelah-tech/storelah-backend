// StoreLah CMS admin UI — DOM helpers: query shorthands, escaping, banner.
// Extracted from admin.js (phase-1 layering refactor; nodebestpractices #1).
// No fetching here (see api.js); no business state (lives in the entry module).

export const $ = (s) => document.querySelector(s);
export const $$ = (s) => Array.from(document.querySelectorAll(s));

// Escape customer/operator-entered strings before any template-literal HTML.
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

export function timeAgo(d) {
  const diff = Date.now() - new Date(d).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const days = Math.floor(h / 24);
  if (days < 7) return days + 'd ago';
  if (days < 30) return Math.floor(days / 7) + 'w ago';
  const mo = Math.floor(days / 30);
  if (mo < 12) return mo + 'mo ago';
  return Math.floor(mo / 12) + 'y ago';
}

// ---------- table select-all (shared) ----------
// Any <table> whose <thead> holds a checkbox gets header↔rows sync for free:
// a header change checks/unchecks every <tbody> checkbox, and row changes
// update the header's checked/indeterminate state. Listeners are delegated on
// the table itself so <tbody> re-renders via innerHTML keep working. Call
// resetSelectAll(table) after re-rendering a body's rows to clear stale
// header state (no rows checked anymore).
export function bindSelectAll(table) {
  if (!table || table.dataset.selectAllBound) return;
  const header = table.querySelector('thead input[type="checkbox"]');
  if (!header) return;
  table.dataset.selectAllBound = '1';

  const syncHeader = () => {
    const boxes = Array.from(table.querySelectorAll('tbody input[type="checkbox"]'));
    const checked = boxes.filter((b) => b.checked);
    header.checked = boxes.length > 0 && checked.length === boxes.length;
    header.indeterminate = checked.length > 0 && checked.length < boxes.length;
  };

  header.addEventListener('change', () => {
    table.querySelectorAll('tbody input[type="checkbox"]').forEach((b) => {
      b.checked = header.checked;
    });
    header.indeterminate = false;
  });
  table.addEventListener('change', (e) => {
    if (e.target && e.target !== header && e.target.matches('tbody input[type="checkbox"]')) syncHeader();
  });
}

export function initSelectAll(root) {
  (root || document).querySelectorAll('table').forEach(bindSelectAll);
}

export function resetSelectAll(table) {
  let el = typeof table === 'string' ? document.querySelector(table) : table;
  if (!el) return;
  // Accept a tbody id (e.g. '#leadRows') as well as the table itself.
  if (el.tagName !== 'TABLE') el = el.closest('table');
  if (!el) return;
  const header = el.querySelector('thead input[type="checkbox"]');
  if (!header) return;
  header.checked = false;
  header.indeterminate = false;
}

// ---------- themed error/success banner (tolerates both error shapes) ----------

export function showBanner(msg, ok) {
  const el = $('#errorBanner');
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok ? 'var(--olive)' : 'var(--red)';
  if (msg) {
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => {
      el.textContent = '';
    }, 8000);
  }
}

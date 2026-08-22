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

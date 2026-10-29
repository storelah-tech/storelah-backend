// StoreLah CMS admin UI — role permissions in the UI (CMS RBAC, 2026-10-27).
// The server is the source of truth (every /api/v1/cms route checks the
// operator's role); this module only hides what the signed-in operator cannot
// use, so they never meet a dead end:
//   - sidebar pages / sub-items and sub-tabs without `view`
//   - buttons for actions the role lacks, inside that screen's container:
//     explicit `data-perm="resource:action"` first, then a conservative verb
//     match on the button label (New/Add/Edit/Save/Delete/Publish …)
// A resource key is the sidebar id: the page id (#leads) or tab panel id
// (#customer-tenants), so the container is always document.getElementById(key).

import { can, getMe } from './api.js';
import { escapeHtml } from './dom.js';

// Core sidebar page → the resources under it, in sidebar order.
const CORE_CHILDREN = {
  command: ['command', 'portfolio', 'analytics'],
  leads: ['leads', 'pipeline', 'quotes', 'inbox', 'calendar', 'automation'],
  customers: ['customer-tenants', 'customer-bookings', 'customer-moveins', 'customer-moveouts'],
  facilities: ['facility-map', 'facility-units', 'facility-floors', 'facility-floorplans', 'facility-floorplan-library',
    'facility-maintenance', 'facility-assets', 'facility-incidents', 'facility-access', 'facility-inspections'],
  extras: ['extras-plans', 'extras-addons'],
  promotions: ['promo-overview', 'promo-discount-matrix', 'promo-free-months', 'promo-code-builder', 'promo-library',
    'promo-history', 'promo-safeguards', 'promo-performance'],
  billing: ['bill-overview', 'bill-invoices', 'bill-arrears'],
  content: ['content-list', 'site-builder'],
  settings: ['settings-general', 'settings-booking', 'settings-fees', 'settings-team', 'settings-facilities'],
};
// Cores whose children are separate pages (the rest are one page with tabs).
const PAGE_CORES = new Set(['command', 'leads']);
const ALL_RESOURCES = Object.values(CORE_CHILDREN).flat();

function isOwner() {
  const me = getMe();
  return !!(me && me.isOwner);
}

/** Can the operator open this sidebar item / tab? (Team & access = Owner only.) */
export function canView(key) {
  if (key === 'settings-team') return isOwner();
  return can(key + ':view');
}

/** Is a page id (as passed to openPage) reachable for this operator? */
export function pageAllowed(id) {
  if (CORE_CHILDREN[id] && !PAGE_CORES.has(id)) return CORE_CHILDREN[id].some(canView);
  if (ALL_RESOURCES.includes(id)) return canView(id);
  return true; // retired / helper views: not a permission boundary
}

/** First page the operator may open, in sidebar order (null = none). */
export function firstAllowedPage() {
  for (const [core, kids] of Object.entries(CORE_CHILDREN)) {
    if (PAGE_CORES.has(core)) {
      const page = kids.find(canView);
      if (page) return page;
    } else if (kids.some(canView)) {
      return core;
    }
  }
  return null;
}

function toggle(el, hidden) {
  if (el) el.classList.toggle('perm-hidden', !!hidden);
}

/** Hide sidebar pages, sub-items and sub-tabs the operator cannot view. */
export function applySidebar() {
  document.querySelectorAll('[data-core-page]').forEach((n) => {
    const kids = CORE_CHILDREN[n.getAttribute('data-core-page')];
    toggle(n, kids && !kids.some(canView));
  });
  document.querySelectorAll('.nav-subitem').forEach((b) => {
    const key = b.dataset.sidePanel || b.dataset.sidePage;
    toggle(b, CORE_CHILDREN[key] && !PAGE_CORES.has(key) ? !pageAllowed(key) : !canView(key));
  });
  document.querySelectorAll('[data-tab]').forEach((b) => {
    const key = b.dataset.tab;
    if (ALL_RESOURCES.includes(key)) toggle(b, !canView(key));
  });
}

/** Sidebar footer: who is signed in, and their role. */
export function applyUser() {
  const me = getMe();
  if (!me) return;
  const name = me.user.name || me.user.email;
  const initials = name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  set('userName', escapeHtml(name));
  set('userRole', escapeHtml(me.role.name));
  set('userAvatar', escapeHtml(initials || '?'));
}

// ---- action buttons ----

// Label verbs per action. Conservative on purpose: navigation, filters,
// export, cancel/close are never matched. Server 403s cover anything missed.
const VERBS = {
  create: /^([+＋]|new\b|add\b|create\b|import\b|upload\b|duplicate\b|log (an? )?\w+|book\b|send\b|compose\b|issue\b|generate\b)/i,
  update: /^(edit\b|save\b|update\b|assign\b|mark\b|reschedule\b|rename\b|restore\b|revert\b|end\b|disable\b|enable\b|archive\b|unarchive\b|reopen\b|close (incident|work order|ticket)\b|move\b|apply\b|adjust\b|change\b|set\b|load\b|reconcile\b|confirm\b|complete\b|start\b|approve move|complete move)/i,
  delete: /^(delete\b|remove\b|🗑)/i,
  approve: /^(publish\b|schedule\b|activate\b|go live\b|approve\b|validate\b)/i,
};
const SKIP = '[data-tab],[data-tabs] button,[data-close],[data-close-pw],.iconbtn,.nav,.nav-subitem,.pager button,[data-page],[data-tab-jump]';

function missingActions(key) {
  return ['create', 'update', 'delete', 'approve'].filter((a) => !can(key + ':' + a));
}

function sweepActions() {
  if (isOwner()) return;
  // Explicit tags anywhere on the page.
  document.querySelectorAll('[data-perm]').forEach((el) => toggle(el, !can(el.getAttribute('data-perm'))));
  for (const key of ALL_RESOURCES) {
    if (key === 'settings-team') continue;
    const root = document.getElementById(key);
    if (!root || !canView(key)) continue;
    const missing = missingActions(key);
    if (!missing.length) continue;
    root.querySelectorAll('button, a.btn, a.primary').forEach((b) => {
      if (b.hasAttribute('data-perm') || b.matches(SKIP)) return;
      const label = (b.textContent || b.getAttribute('aria-label') || b.title || '').trim();
      if (!label || /filter|export|cancel|close|clear/i.test(label)) return;
      const hit = missing.some((a) => VERBS[a].test(label) && !(a === 'update' && can(key + ':approve') && VERBS.approve.test(label)));
      if (hit) b.classList.add('perm-hidden');
    });
  }
}

let sweepQueued = false;
let observer = null;

/** Hide action buttons now and whenever a view re-renders. */
export function watchActions() {
  sweepActions();
  if (observer || isOwner()) return;
  observer = new MutationObserver(() => {
    if (sweepQueued) return;
    sweepQueued = true;
    requestAnimationFrame(() => { sweepQueued = false; sweepActions(); });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/** Block programmatic or stale clicks on hidden tabs / items (deep links,
 * "Open" jump buttons) — capture phase, before the view's own handler. */
export function guardHiddenClicks(onBlocked) {
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('.perm-hidden') : null;
    if (!t) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (onBlocked) onBlocked();
  }, true);
}

// StoreLah CMS admin UI — customer journey mind map (Leads → click an email).
// One identity (GET /leads/groups/:key) drawn as a mind map: the contact in
// the centre, each enquiry as a branch (#1 = oldest, numbered clockwise:
// right side top→bottom, then left side top→bottom), and each enquiry's
// details (stage path, interest, move-in, value, source, outcome) as leaves.
// A date ribbon under the header shows the same enquiries on a time axis.
//
// Pure client-side layout: absolutely positioned HTML nodes over one SVG of
// bezier links, animated in with CSS (links draw, nodes pop in branch by
// branch; prefers-reduced-motion shows everything at once). Styles are the
// .lj-* block in dashboard.html. Clicking an enquiry (node or ribbon dot)
// opens the existing lead detail drawer, which stacks above this overlay
// (drawer z-index 50 > journey 45). The entry injects the drawer opener via
// setJourneyLeadOpener — views never import the entry.

import { escapeHtml, showBanner, timeAgo } from './dom.js';
import { request, describeError } from './api.js';
import { state } from './state.js';

let openLead = null;
export function setJourneyLeadOpener(fn) {
  openLead = fn;
}

const STAGE_LABEL = {
  NEW_ENQUIRY: 'New', CONTACTED: 'Contacted', VIEWING_BOOKED: 'Qualified',
  PROPOSAL_SENT: 'Quoted', PENDING_PAYMENT: 'Pending payment', WON: 'Won', LOST: 'Lost',
};
const FUNNEL = ['NEW_ENQUIRY', 'CONTACTED', 'VIEWING_BOOKED', 'PROPOSAL_SENT', 'PENDING_PAYMENT', 'WON'];
const SOURCE_LABEL = { WEBSITE: 'Website', WHATSAPP: 'WhatsApp', REFERRAL: 'Referral', GOOGLE: 'Google' };

// Stage → branch tone (CSS custom property values from the v8 palette).
function stageTone(stage) {
  if (stage === 'WON') return 'var(--olive2)';
  if (stage === 'LOST') return '#a0a59c';
  if (stage === 'NEW_ENQUIRY') return 'var(--red)';
  if (stage === 'CONTACTED' || stage === 'VIEWING_BOOKED') return 'var(--amber)';
  return 'var(--terra)';
}

// ---------- layout constants (px, unscaled canvas space) ----------
const ROOT_W = 236;
const ROOT_H = 96;
const ENQ_W = 232;
const ENQ_H = 84;
const LEAF_W = 222;
const LEAF_H = 40;
const LEAF_GAP = 10;
const BLOCK_GAP = 34;
const GAP_ROOT_ENQ = 96;
const GAP_ENQ_LEAF = 64;
const PAD = 36;

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtShort = (d) => (d ? new Date(d).toLocaleDateString('en-SG', { day: '2-digit', month: 'short' }) : '—');
const money = (n) => '$' + Number(n).toLocaleString('en-SG', { maximumFractionDigits: 2 });

// Leaves for one enquiry, in display order. Each: { k: label, v: html }.
function leavesFor(t) {
  const out = [];
  // Stage path: funnel steps up to the current stage (LOST shows as an
  // off-ramp after New — the drop-off step is not recorded per row).
  const idx = FUNNEL.indexOf(t.stage);
  const steps = t.stage === 'LOST' ? ['NEW_ENQUIRY', 'LOST'] : FUNNEL.slice(0, Math.max(idx, 0) + 1);
  out.push({
    k: 'Stage path',
    v: '<span class="lj-steps">' + steps.map((s, i) =>
      '<span class="lj-step' + (i === steps.length - 1 ? ' cur' : '') + (s === 'LOST' ? ' lost' : '') + '">' + escapeHtml(STAGE_LABEL[s] || s) + '</span>',
    ).join('<span class="lj-arrow">›</span>') + '</span>',
  });
  const interest = [t.size, t.branchName || t.branchCode, t.unitCode ? 'Unit ' + t.unitCode : null].filter(Boolean);
  if (interest.length) out.push({ k: 'Interest', v: escapeHtml(interest.join(' · ')) });
  if (t.moveInDate) {
    out.push({ k: 'Move-in', v: escapeHtml(fmtDate(t.moveInDate) + (t.durationMonths ? ' · ' + t.durationMonths + ' mo' : '')) });
  }
  const val = [];
  if (t.monthlyRate) val.push(money(t.monthlyRate) + '/mo');
  if (t.totalDueToday) val.push(money(t.totalDueToday) + ' due today');
  if (t.promoCode) val.push('promo ' + t.promoCode);
  if (val.length) out.push({ k: 'Value', v: escapeHtml(val.join(' · ')) });
  const src = [SOURCE_LABEL[t.source] || t.source, t.owner ? 'owner ' + t.owner : null].filter(Boolean);
  if (src.length) out.push({ k: 'Source', v: escapeHtml(src.join(' · ')) });
  if (t.stage === 'LOST') {
    out.push({ k: 'Outcome', v: escapeHtml('Lost' + (t.lossReason ? ' — ' + t.lossReason : '')), tone: 'lost' });
  } else if (t.stage === 'WON') {
    out.push({ k: 'Outcome', v: 'Booked ✓', tone: 'won' });
  } else if (t.nextActionAt) {
    out.push({ k: 'Next step', v: escapeHtml('Due ' + fmtDate(t.nextActionAt)) });
  }
  return out;
}

function blockHeight(leaves) {
  return Math.max(ENQ_H, leaves.length * (LEAF_H + LEAF_GAP) - LEAF_GAP);
}

// Cubic link between two points, horizontal tangents (mind-map style).
function linkPath(x1, y1, x2, y2) {
  const mx = (x1 + x2) / 2;
  return `M${x1.toFixed(1)},${y1.toFixed(1)} C${mx.toFixed(1)},${y1.toFixed(1)} ${mx.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

function layout(group, enquiries) {
  const n = enquiries.length;
  const rightCount = n === 1 ? 1 : Math.ceil(n / 2);
  const sides = [enquiries.slice(0, rightCount), enquiries.slice(rightCount)];
  const blocks = enquiries.map((t) => {
    const leaves = leavesFor(t);
    return { t, leaves, h: blockHeight(leaves) };
  });
  const sideH = sides.map((list, si) => {
    const off = si === 0 ? 0 : rightCount;
    return list.reduce((sum, _t, i) => sum + blocks[off + i].h, 0) + Math.max(0, list.length - 1) * BLOCK_GAP;
  });
  const armW = GAP_ROOT_ENQ + ENQ_W + GAP_ENQ_LEAF + LEAF_W;
  const hasLeft = sides[1].length > 0;
  const W = PAD * 2 + ROOT_W + armW * (hasLeft ? 2 : 1);
  const H = PAD * 2 + Math.max(ROOT_H, sideH[0], sideH[1]);
  const rootX = PAD + (hasLeft ? armW : 0); // root card left edge
  const rootY = H / 2;
  const nodes = [];
  const links = [];
  nodes.push({ kind: 'root', x: rootX, y: rootY - ROOT_H / 2, w: ROOT_W, h: ROOT_H, delay: 0 });
  let order = 0;
  sides.forEach((list, si) => {
    const dir = si === 0 ? 1 : -1;
    const off = si === 0 ? 0 : rightCount;
    let y = rootY - sideH[si] / 2;
    list.forEach((_t, i) => {
      const b = blocks[off + i];
      const idx = off + i;
      const cy = y + b.h / 2;
      const delay = 160 + order * 170;
      order++;
      const ex = dir > 0 ? rootX + ROOT_W + GAP_ROOT_ENQ : rootX - GAP_ROOT_ENQ - ENQ_W;
      const tone = stageTone(b.t.stage);
      nodes.push({ kind: 'enq', idx, t: b.t, x: ex, y: cy - ENQ_H / 2, w: ENQ_W, h: ENQ_H, delay: delay + 220, tone });
      links.push({
        idx, tone, delay, w: 3,
        d: dir > 0 ? linkPath(rootX + ROOT_W, rootY, ex, cy) : linkPath(rootX, rootY, ex + ENQ_W, cy),
      });
      const lx = dir > 0 ? ex + ENQ_W + GAP_ENQ_LEAF : ex - GAP_ENQ_LEAF - LEAF_W;
      let ly = cy - (b.leaves.length * (LEAF_H + LEAF_GAP) - LEAF_GAP) / 2;
      b.leaves.forEach((leaf, li) => {
        const lcy = ly + LEAF_H / 2;
        const ld = delay + 420 + li * 70;
        links.push({
          idx, tone, delay: ld - 120, w: 1.6,
          d: dir > 0 ? linkPath(ex + ENQ_W, cy, lx, lcy) : linkPath(ex, cy, lx + LEAF_W, lcy),
        });
        nodes.push({ kind: 'leaf', idx, leaf, x: lx, y: ly, w: LEAF_W, h: LEAF_H, delay: ld, tone, side: dir });
        ly += LEAF_H + LEAF_GAP;
      });
      y += b.h + BLOCK_GAP;
    });
  });
  return { W, H, nodes, links };
}

function nodeHtml(n, group) {
  const pos = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;--d:${n.delay}ms;--tone:${n.tone || 'var(--terra)'}`;
  if (n.kind === 'root') {
    const initial = String(group.emailDisplay || '?').charAt(0).toUpperCase();
    const names = (group.names || []).slice(0, 2).join(', ');
    return `<div class="lj-node lj-root" style="${pos}"><div class="lj-root-av">${escapeHtml(initial)}</div>` +
      `<div class="lj-root-txt"><b title="${escapeHtml(group.emailDisplay || '')}">${escapeHtml(group.emailDisplay || 'Phone-only contact')}</b>` +
      `<small>${escapeHtml(names || '—')}</small><small>${escapeHtml(String(group.count))} ${group.count === 1 ? 'enquiry' : 'enquiries'}</small></div></div>`;
  }
  if (n.kind === 'enq') {
    const t = n.t;
    return `<button type="button" class="lj-node lj-enq" data-branch="${n.idx}" data-lead-id="${escapeHtml(t.id)}" style="${pos}" title="Open enquiry details">` +
      `<span class="lj-enq-top"><span class="lj-num">#${n.idx + 1}</span><span class="lj-date">${escapeHtml(fmtDate(t.createdAt))}</span></span>` +
      `<b>${escapeHtml(t.name || '—')}</b>` +
      `<span class="lj-enq-foot"><span class="lj-stage">${escapeHtml(STAGE_LABEL[t.stage] || t.stage)}</span>` +
      (t.phoneVariance ? '<span class="lj-flag" title="This enquiry used a different phone">⚠ phone</span>' : '') +
      `<span class="lj-cta">Details ›</span></span></button>`;
  }
  return `<div class="lj-node lj-leaf${n.leaf.tone ? ' ' + n.leaf.tone : ''}${n.side < 0 ? ' left' : ''}" data-branch="${n.idx}" style="${pos}">` +
    `<span class="lj-k">${escapeHtml(n.leaf.k)}</span><span class="lj-v">${n.leaf.v}</span></div>`;
}

// Time ribbon: one dot per enquiry in date order, positioned by createdAt
// but never closer than a minimum gap (bursts of same-week enquiries would
// otherwise stack on top of each other).
function ribbonPositions(times) {
  const n = times.length;
  if (n === 1) return [50];
  const min = times[0];
  const span = times[n - 1] - min;
  const raw = times.map((t, i) => (span > 0 ? ((t - min) / span) * 100 : (i / (n - 1)) * 100));
  const gap = Math.min(100 / (n - 1), 7);
  const out = raw.slice();
  for (let i = 1; i < n; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  // Pull back from the right edge, keeping the gap.
  out[n - 1] = Math.min(out[n - 1], 100);
  for (let i = n - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap);
  return out;
}

function ribbonHtml(enquiries) {
  const times = enquiries.map((t) => new Date(t.createdAt).getTime());
  const min = Math.min(...times);
  const max = Math.max(...times);
  const pos = ribbonPositions(times);
  const dots = enquiries.map((t, i) => {
    const pct = pos[i];
    return `<button type="button" class="lj-dot" data-branch="${i}" data-lead-id="${escapeHtml(t.id)}" style="left:${pct.toFixed(2)}%;--tone:${stageTone(t.stage)};--d:${200 + i * 110}ms" title="#${i + 1} · ${escapeHtml(fmtDate(t.createdAt))} · ${escapeHtml(STAGE_LABEL[t.stage] || t.stage)}">` +
      `<span>#${i + 1}</span><small>${escapeHtml(fmtShort(t.createdAt))}</small></button>`;
  }).join('');
  return `<div class="lj-ribbon"><span class="lj-ribbon-end">${escapeHtml(fmtDate(min))}</span>` +
    `<div class="lj-track"><div class="lj-track-line"></div>${dots}</div>` +
    `<span class="lj-ribbon-end">${escapeHtml(fmtDate(max))}</span></div>`;
}

function statsHtml(group, enquiries) {
  const reached = enquiries.reduce((m, t) => Math.max(m, FUNNEL.indexOf(t.stage)), -1);
  const won = enquiries.filter((t) => t.stage === 'WON').length;
  const lost = enquiries.filter((t) => t.stage === 'LOST').length;
  const open = enquiries.length - won - lost;
  const first = enquiries[0] && enquiries[0].createdAt;
  const chips = [
    ['First seen', first ? timeAgo(first) : '—'],
    ['Furthest stage', STAGE_LABEL[FUNNEL[reached]] || (lost ? 'Lost' : '—')],
    ['Open / won / lost', `${open} / ${won} / ${lost}`],
    ['Phones', (group.phones || []).join(' · ') || '—'],
  ];
  return chips.map(([k, v]) => `<div class="lj-stat"><small>${escapeHtml(k)}</small><b>${escapeHtml(String(v))}</b></div>`).join('');
}

// ---------- overlay shell ----------
let root = null;
let invoker = null;
let currentKey = null;
let zoom = 1;
let fitZoom = 1;
let dims = { W: 0, H: 0 };

function ensureShell() {
  if (root) return root;
  root = document.createElement('div');
  root.className = 'lj';
  root.id = 'leadJourney';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'ljTitle');
  root.innerHTML =
    '<div class="lj-backdrop" data-lj-close></div>' +
    '<section class="lj-panel">' +
    '<header class="lj-head"><div><div class="lj-eyebrow">Customer journey</div><h2 id="ljTitle">—</h2><p id="ljSub"></p></div>' +
    '<div class="lj-tools"><button type="button" class="iconbtn" data-lj-zoom="-1" aria-label="Zoom out">−</button>' +
    '<button type="button" class="btn lj-zoomlbl" data-lj-zoom="0" title="Fit to screen">100%</button>' +
    '<button type="button" class="iconbtn" data-lj-zoom="1" aria-label="Zoom in">＋</button>' +
    '<button type="button" class="iconbtn" data-lj-close aria-label="Close journey" id="ljClose">✕</button></div></header>' +
    '<div class="lj-stats" id="ljStats"></div>' +
    '<div id="ljRibbon"></div>' +
    '<div class="lj-wrap" id="ljWrap"><div class="lj-sizer" id="ljSizer"><div class="lj-canvas" id="ljCanvas"></div></div></div>' +
    '<footer class="lj-foot"><span><i style="background:var(--red)"></i>New</span><span><i style="background:var(--amber)"></i>Contacted / qualified</span>' +
    '<span><i style="background:var(--terra)"></i>Quoted / pending</span><span><i style="background:var(--olive2)"></i>Won</span><span><i style="background:#a0a59c"></i>Lost</span>' +
    '<em>Click an enquiry to open its details · drag to pan · Ctrl/⌘ + scroll to zoom</em></footer>' +
    '</section>';
  document.body.appendChild(root);

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-lj-close]')) { closeLeadJourney(); return; }
    const z = e.target.closest('[data-lj-zoom]');
    if (z) { setZoom(Number(z.dataset.ljZoom)); return; }
    const hit = e.target.closest('[data-lead-id]');
    if (hit && openLead && !panMoved) openLead(hit.dataset.leadId, hit);
  });
  // Branch focus: hovering an enquiry / leaf / ribbon dot lights its branch.
  const focus = (e) => {
    const el = e.target.closest && e.target.closest('[data-branch]');
    setFocus(el ? el.dataset.branch : null);
  };
  root.addEventListener('mouseover', focus);
  root.addEventListener('focusin', focus);
  root.addEventListener('mouseleave', () => setFocus(null));
  // Escape closes the journey unless the lead drawer (stacked above) is open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || root.hidden) return;
    const drawer = document.getElementById('leadDrawer');
    if (drawer && !drawer.hidden) return;
    closeLeadJourney();
  });
  wirePanZoom();
  return root;
}

function setFocus(branch) {
  const canvas = document.getElementById('ljCanvas');
  if (!root || !canvas) return;
  root.classList.toggle('lj-focusing', branch != null);
  root.querySelectorAll('[data-branch]').forEach((el) => el.classList.toggle('hot', branch != null && el.dataset.branch === String(branch)));
}

function applyZoom() {
  const canvas = document.getElementById('ljCanvas');
  const sizer = document.getElementById('ljSizer');
  const lbl = root && root.querySelector('.lj-zoomlbl');
  if (!canvas || !sizer) return;
  canvas.style.transform = `scale(${zoom})`;
  sizer.style.width = Math.ceil(dims.W * zoom) + 'px';
  sizer.style.height = Math.ceil(dims.H * zoom) + 'px';
  if (lbl) lbl.textContent = Math.round(zoom * 100) + '%';
}

function setZoom(dir) {
  if (dir === 0) zoom = fitZoom;
  else zoom = Math.min(1.6, Math.max(0.35, dir > 0 ? zoom * 1.2 : zoom / 1.2));
  applyZoom();
}

// Drag-to-pan on the map background (nodes stay clickable: a drag of more
// than 4px swallows the click that follows it).
let panMoved = false;
function wirePanZoom() {
  const wrap = root.querySelector('#ljWrap');
  let start = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
    panMoved = false;
  });
  window.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!panMoved && Math.hypot(dx, dy) < 4) return;
    panMoved = true;
    wrap.classList.add('panning');
    wrap.scrollLeft = start.sl - dx;
    wrap.scrollTop = start.st - dy;
  });
  window.addEventListener('pointerup', () => {
    start = null;
    wrap.classList.remove('panning');
    setTimeout(() => { panMoved = false; }, 0);
  });
  wrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
}

function render(group, enquiries) {
  const { W, H, nodes, links } = layout(group, enquiries);
  dims = { W, H };
  document.getElementById('ljTitle').textContent = group.emailDisplay || 'Phone-only contact';
  document.getElementById('ljSub').textContent =
    (group.names || []).join(', ') + ' · ' + enquiries.length + (enquiries.length === 1 ? ' enquiry' : ' enquiries') +
    ' · ' + fmtDate(enquiries[0].createdAt) + ' → ' + fmtDate(enquiries[enquiries.length - 1].createdAt);
  document.getElementById('ljStats').innerHTML = statsHtml(group, enquiries);
  document.getElementById('ljRibbon').innerHTML = ribbonHtml(enquiries);
  const canvas = document.getElementById('ljCanvas');
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  const svg = `<svg class="lj-links" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">` +
    links.map((l) => `<path d="${l.d}" pathLength="1" data-branch="${l.idx}" style="--d:${l.delay}ms;stroke:${l.tone};stroke-width:${l.w}"/>`).join('') +
    '</svg>';
  canvas.innerHTML = svg + nodes.map((n) => nodeHtml(n, group)).join('');
  // Fit: scale the map down to the visible width (never up past 100%).
  const wrap = document.getElementById('ljWrap');
  const avail = Math.max(320, (wrap.clientWidth || 1000) - 8);
  fitZoom = Math.max(0.35, Math.min(1, avail / W));
  zoom = fitZoom;
  applyZoom();
  // Open centred on the contact node.
  wrap.scrollTop = Math.max(0, (wrap.scrollHeight - wrap.clientHeight) / 2);
  wrap.scrollLeft = Math.max(0, (wrap.scrollWidth - wrap.clientWidth) / 2);
}

export async function openLeadJourney(groupKey, invokerEl, opts) {
  if (!groupKey) return;
  const quiet = !!(opts && opts.refresh);
  ensureShell();
  if (!quiet) invoker = invokerEl && document.contains(invokerEl) ? invokerEl : null;
  let body;
  try {
    body = await request('/leads/groups/' + encodeURIComponent(groupKey));
  } catch (e) {
    // A refresh after the last enquiry was deleted → the group is gone.
    if (quiet) closeLeadJourney();
    else showBanner('Journey: ' + describeError(e));
    return;
  }
  const data = (body && body.data) || {};
  const group = data.group || (state.leadGroups || []).find((g) => g.groupKey === groupKey) || { emailDisplay: groupKey, names: [], phones: [], count: 0 };
  // API timeline is newest-first; the journey reads oldest → newest.
  const enquiries = ((data.timeline) || []).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!enquiries.length) {
    if (quiet) closeLeadJourney();
    else showBanner('Journey: no enquiries in this group.');
    return;
  }
  currentKey = groupKey;
  // Merge rows into leadsCache so the detail drawer's lookup resolves them.
  const cache = state.leadsCache || (state.leadsCache = []);
  for (const t of enquiries) {
    const i = cache.findIndex((l) => l.id === t.id);
    if (i >= 0) cache[i] = { ...cache[i], ...t };
    else cache.push(t);
  }
  // A refresh re-draws in place without replaying the entrance animation.
  root.classList.toggle('lj-static', quiet);
  if (!quiet) {
    root.hidden = false;
    root.classList.remove('open');
    void root.offsetWidth;
    root.classList.add('open');
    document.body.classList.add('lj-open');
  }
  render(group, enquiries);
  if (!quiet) {
    try { document.getElementById('ljClose').focus({ preventScroll: true }); } catch (e) { /* noop */ }
  }
}

// Re-draw the open journey (after a drawer edit/delete refreshed the leads).
export async function refreshOpenJourney() {
  if (!root || root.hidden || !currentKey) return;
  await openLeadJourney(currentKey, null, { refresh: true });
}

export function closeLeadJourney() {
  if (!root || root.hidden) return;
  root.classList.remove('open');
  root.hidden = true;
  currentKey = null;
  document.body.classList.remove('lj-open');
  setFocus(null);
  if (invoker && document.contains(invoker)) {
    try { invoker.focus({ preventScroll: true }); } catch (e) { /* noop */ }
  }
  invoker = null;
}

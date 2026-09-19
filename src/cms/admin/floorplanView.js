// StoreLah CMS admin UI — floor-plan editor + read-only plan preview.
// Extracted from admin.js (phase-3 layering refactor; nodebestpractices #1).
// Owns all #fp* / #fpView* DOM wiring (attached once via fpInitEvents() from
// the entry's boot). Navigation glue (fpViewEdit → switchView) stays in the
// entry because views must never import the entry module.

import { escapeHtml, $ } from './dom.js';
import { confirmDialog } from './confirmDialog.js';
import { get, request, describeError } from './api.js';
import { state, branchByCode, branchFloors, selectedFacilityName } from './state.js';
import { notifyMetricsFloorChanged } from './metricsView.js';

// Ref-data retry hook — the entry hands its loadRefs() down here so fpOpen()'s
// lazy guard keeps working without importing the entry.
let loadRefs = null;
export function setRefsLoader(fn) {
  loadRefs = fn;
}

// ---------- floor-plan constants & private module state ----------
const FP_BASE = 24; // px per foot at zoom 1 (BLUEPRINT SCALE: 1 grid unit = 1 ft)
let fpDimsTimer = null;
// In-flight pencil draft (line tool ON): { x1, y1, x2, y2 } in grid-ft units.
// Transient drag state only — persisted lines live in state.fp.boundaries.
let fpDraftLine = null;

// ---------- blueprint footprints (P1): 1 grid unit = 1 ft ----------
// Canonical dims mirror the UnitSize.widthFt/heightFt catalogue backfill (see
// docs/FLOOR_PLAN_MODEL.md + migration `add_unit_size_footprint`): LOCKER
// 12 sqft → 3×4 ft, SMALL 30 → 5×6, MEDIUM 60 → 6×10, LARGE 120 → 10×12.
// Resolution order for a unit: live /sizes dims (widthFt/heightFt) → these
// constants → the per-size aspect fallback below. NOTE: the old XLBIZ key was
// dead (no such size exists in the DB or seed) and has been dropped — unknown
// size codes fall through to the aspect formula instead of a hardcoded guess.
const FP_SIZE_DIMS = {
  LOCKER: { w: 3, h: 4 },
  SMALL: { w: 5, h: 6 },
  MEDIUM: { w: 6, h: 10 },
  LARGE: { w: 10, h: 12 },
};
// Per-size width/height aspects (w/h) for the fallback; chosen to reproduce
// the catalogue footprints exactly. Mirrors SIZE_ASPECT in src/core/floorPlans.ts.
const FP_SIZE_ASPECT = { LOCKER: 3 / 4, SMALL: 5 / 6, MEDIUM: 6 / 10, LARGE: 10 / 12 };
const FP_DEFAULT_ASPECT = 3 / 4;

// Documented fallback: w = round(sqrt(sqft·aspect)), h = ceil(sqft/w).
// Mirrors sqftFootprint() in src/core/floorPlans.ts — keep the two in sync.
function sqftFootprint(sqft, sizeCode) {
  const aspect = FP_SIZE_ASPECT[String(sizeCode || '').toUpperCase()] || FP_DEFAULT_ASPECT;
  const safe = Math.max(1, Number(sqft) || 1);
  const w = Math.max(1, Math.round(Math.sqrt(safe * aspect)));
  return { w, h: Math.max(1, Math.ceil(safe / w)) };
}

function sizeFootprint(sizeCode, sqft) {
  const code = String(sizeCode || '').toUpperCase();
  const live = (state.sizes || []).find((s) => String(s.code || '').toUpperCase() === code);
  if (live && Number.isInteger(live.widthFt) && live.widthFt > 0 && Number.isInteger(live.heightFt) && live.heightFt > 0) {
    return { w: live.widthFt, h: live.heightFt };
  }
  const d = FP_SIZE_DIMS[code];
  if (d) return { w: d.w, h: d.h };
  return sqftFootprint(sqft, code);
}

function unitFootprint(u) {
  const fp = sizeFootprint(u.sizeCode, u.sqft);
  // Palette orientation toggle for rectangular footprints (placement-time only).
  return state.fp.ghostRotated ? { w: fp.h, h: fp.w } : fp;
}

// Overlap policy: REJECT. Client pre-check mirroring the server's 409
// PLACEMENT_OVERLAP (unit-vs-unit only — decoration blocks may underlay).
// Touching edges are fine; only shared interior area collides.
//
// STACKING exemption (mirrors src/core/floorPlans.ts): two placements sharing
// the EXACT same rect with differing tiers (0 + 1 locker pair) do NOT collide.
// `tier` is the incoming write's tier; `ignore` is one unitId (string), several
// (array, for paired stack moves), or null.
function fpOverlapAt(x, y, w, h, ignore, tier) {
  const t = tier === 1 ? 1 : 0;
  const ignored = new Set(Array.isArray(ignore) ? ignore : ignore ? [ignore] : []);
  return (
    state.fp.placements.find((o) => {
      if (ignored.has(o.unitId)) return false;
      if (!(x < o.x + o.width && o.x < x + w && y < o.y + o.height && o.y < y + h)) return false;
      const sameRect = x === o.x && y === o.y && w === o.width && h === o.height;
      if (sameRect && (o.stackTier || 0) !== t) return false; // stacked pair shares one rect
      return true;
    }) || null
  );
}

// Stacking helpers: a stacked pair = two placements on the EXACT same rect
// with tiers 0 (lower/ground) + 1 (upper). Rendered as ONE block split by a
// middle divider line (upper code above, lower code below).
function fpSameRect(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function fpIsLockerPlacement(p) {
  return String(p.sizeCode || '').toUpperCase() === 'LOCKER';
}

// The other tier on the same rect, if any (a rect holds at most one pair).
function fpStackMate(pl) {
  return state.fp.placements.find((o) => o.unitId !== pl.unitId && fpSameRect(o, pl)) || null;
}

// Locker stack-drop guard: a lone ground-tier locker moved EXACTLY onto a
// lone ground-tier locker's rect may stack as the upper tier (tiers 0 + 1)
// instead of reverting. Mirrors the server's same-rect rules in
// src/core/floorPlans.ts (lockers-only, max 2-high, exact same rect) — the
// PUT tier-1 write is still re-validated server-side, which stays the final
// arbiter. `pairIds` is the moving unit(s); the mover already sits on the
// target rect in local state, so the whole moving pair is excluded from the
// third-placement check.
function fpStackDropAllowed(pl, hit, pairIds) {
  if (!pl || !hit) return false;
  if (!Array.isArray(pairIds) || pairIds.length !== 1) return false; // singles only — pairs move as one block
  if ((pl.stackTier || 0) !== 0 || (hit.stackTier || 0) !== 0) return false;
  if (!fpIsLockerPlacement(pl) || !fpIsLockerPlacement(hit)) return false;
  if (!fpSameRect(pl, hit)) return false;
  return !state.fp.placements.some(
    (o) => !pairIds.includes(o.unitId) && o.unitId !== hit.unitId && fpSameRect(o, hit),
  );
}

// Stack a moved lone locker onto the lone locker it was dropped on: confirm,
// then persist the moved unit as the upper tier (stackTier 1) on the shared
// rect. Cancel (or a server rejection) restores the pre-drag position; a
// server rejection surfaces the server's 400/409 message.
async function fpStackMovedOn(pl, hit, orig) {
  const restore = () => {
    for (const o of orig) {
      o.p.x = o.x;
      o.p.y = o.y;
    }
    fpRenderCanvas();
  };
  const stackOk = await confirmDialog({
    title: `Stack ${pl.unitCode} on ${hit.unitCode}?`,
    message: `${pl.unitCode} becomes the UPPER tier and ${hit.unitCode} stays the LOWER tier — one block split by a divider line.`,
    confirmLabel: 'Stack',
  });
  if (!stackOk) {
    restore();
    return;
  }
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(pl.unitId)}`, {
      method: 'PUT',
      body: JSON.stringify({ x: hit.x, y: hit.y, width: hit.width, height: hit.height, stackTier: 1 }),
    });
    pl.x = hit.x;
    pl.y = hit.y;
    pl.width = hit.width;
    pl.height = hit.height;
    pl.stackTier = 1;
    fpToast(`Stacked ${pl.unitCode} (upper) over ${hit.unitCode} (lower)`, true);
    fpRender();
    notifyMetricsFloorChanged();
  } catch (err) {
    restore();
    fpToast(`Stack ${pl.unitCode}: ${describeError(err)}`, false);
    await fpFetch(); // revert local state to what the server has
  }
}

// Group a placement list by exact rect so stacked pairs render as one block.
// Returns [{ rect, members }] with members sorted ground-tier-first.
function fpGroupByRect(list) {
  const groups = new Map();
  for (const pl of list || []) {
    const k = `${pl.x},${pl.y},${pl.width},${pl.height}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(pl);
  }
  return [...groups.values()].map((members) => ({
    rect: members[0],
    members: members.slice().sort((a, b) => (a.stackTier || 0) - (b.stackTier || 0)),
  }));
}

function fpPx() {
  return Math.max(8, Math.round(FP_BASE * state.fp.scale));
}

function fpNormalizeUnit(u) {
  return {
    id: u.id,
    unitCode: u.unitCode,
    name: u.name,
    sizeCode: u.size && u.size.code,
    sizeName: u.size && u.size.name,
    sqft: u.sqft,
    status: String(u.status || '').toUpperCase(),
  };
}

function fpNormalizePlacements(plan) {
  return (plan && plan.placements ? plan.placements : []).map((p) => ({
    id: p.id,
    unitId: p.unit.id,
    unitCode: p.unit.unitCode,
    name: p.unit.name,
    sizeCode: p.unit.size.code,
    sizeName: p.unit.size.name,
    sqft: p.unit.sqft,
    status: String(p.unit.status || '').toUpperCase(),
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    // Stacking tier: 0 = ground/sole tier, 1 = upper tier of a same-rect pair.
    stackTier: p.stackTier === 1 ? 1 : 0,
    // Authored door compass edges (editor N/S/E/W toggles); null = unauthored
    // (metrics falls back to AUTO_ALL_EDGES for this unit).
    doorEdges: Array.isArray(p.doorEdges) && p.doorEdges.length ? p.doorEdges.slice() : null,
  }));
}

function fpNormalizeBlocks(plan) {
  return (plan && plan.blocks ? plan.blocks : []).map((b) => ({
    id: b.id,
    name: b.name,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    color: b.color || null,
    doorEdges: Array.isArray(b.doorEdges) && b.doorEdges.length ? b.doorEdges.slice() : null,
  }));
}

// Boundary vertices as [x, y] integer pairs in grid-ft units — mirrors
// boundaryPointsOf() in src/core/floorPlans.ts (keep the two in sync). Rows
// that fail validation normalise to [] so a malformed row can never break a read.
function fpBoundaryPoints(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    out.push([x, y]);
  }
  return out;
}

function fpNormalizeBoundaries(plan) {
  return (plan && plan.boundaries ? plan.boundaries : []).map((b) => ({
    id: b.id,
    label: b.label,
    kind: b.kind,
    points: fpBoundaryPoints(b.points),
    closed: !!b.closed,
    sortOrder: b.sortOrder || 0,
  }));
}

function fpCanvasDims() {
  // A live-typed size (unsaved W/H input edits) wins while the operator is
  // editing; "Save Canvas" is the explicit commit that persists it.
  const live = state.fp.liveDims;
  if (live && live.w > 0 && live.h > 0) return { w: live.w, h: live.h };
  const p = state.fp.plan;
  if (p && p.width > 0 && p.height > 0) return { w: p.width, h: p.height };
  return { w: state.fp.canvasDefaults.width, h: state.fp.canvasDefaults.height };
}

function fpParseDim(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : null;
}

function fpReadInputDims() {
  const wEl = $('#fpWidth');
  const hEl = $('#fpHeight');
  if (!wEl || !hEl) return null;
  const w = fpParseDim(wEl.value);
  const h = fpParseDim(hEl.value);
  if (w === null || h === null) return null;
  return { w, h };
}

function fpSyncDimInputs(d) {
  const wEl = $('#fpWidth');
  const hEl = $('#fpHeight');
  if (!wEl || !hEl) return;
  if (document.activeElement === wEl || document.activeElement === hEl) return;
  wEl.value = d.w;
  hEl.value = d.h;
}

function fpClampCanvasContent(w, h) {
  const clampItem = (item) => {
    item.width = Math.max(1, Math.min(item.width, w));
    item.height = Math.max(1, Math.min(item.height, h));
    item.x = Math.min(Math.max(0, item.x), Math.max(0, w - item.width));
    item.y = Math.min(Math.max(0, item.y), Math.max(0, h - item.height));
  };
  state.fp.placements.forEach(clampItem);
  state.fp.blocks.forEach(clampItem);
  // Boundary vertices clamp edge-INCLUSIVE (0..w / 0..h — the same contract as
  // checkBoundaryPoints in src/core/floorPlans.ts) so drawn lines never render
  // off-grid after a canvas shrink.
  (state.fp.boundaries || []).forEach((b) => {
    b.points = fpBoundaryPoints(b.points).map(([x, y]) => [
      Math.min(Math.max(0, x), w),
      Math.min(Math.max(0, y), h),
    ]);
  });
}

function fpApplyLiveDims() {
  const { w, h } = fpCanvasDims();
  fpClampCanvasContent(w, h);
  fpRender();
}

function fpOnDimInput() {
  const dims = fpReadInputDims();
  // Track the typed size synchronously so any concurrent re-render races
  // with it instead of snapping the canvas back to the server value, and so
  // the debounced apply always works on the newest value.
  state.fp.liveDims = dims ? { w: dims.w, h: dims.h } : state.fp.liveDims;
  clearTimeout(fpDimsTimer);
  if (dims) fpDimsTimer = setTimeout(fpApplyLiveDims, 200);
}

function fpOnDimCommit() {
  clearTimeout(fpDimsTimer);
  const wEl = $('#fpWidth');
  const hEl = $('#fpHeight');
  const dims = fpReadInputDims();
  if (dims) {
    state.fp.liveDims = { w: dims.w, h: dims.h };
    fpApplyLiveDims();
    if (wEl) wEl.value = dims.w;
    if (hEl) hEl.value = dims.h;
    return;
  }
  state.fp.liveDims = null;
  const { w, h } = fpCanvasDims();
  fpApplyLiveDims();
  if (wEl) wEl.value = w;
  if (hEl) hEl.value = h;
  fpToast('Canvas size must be a whole number between 1 and 500 feet.', false);
}

function fpOnDimEnter(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    fpOnDimCommit();
    e.target.blur();
  }
}

function fpToast(msg, ok) {
  const b = $('#fpBanner');
  if (!b) return;
  if (!msg) {
    b.hidden = true;
    b.textContent = '';
    return;
  }
  b.hidden = false;
  b.textContent = msg;
  b.className = 'modal-alert ' + (ok ? ' olive' : '');
  clearTimeout(fpToast._t);
  fpToast._t = setTimeout(() => {
    b.hidden = true;
    b.textContent = '';
  }, 6000);
}

function fpZoomLabel() {
  const el = $('#fpZoomLbl');
  if (el) el.textContent = Math.round(state.fp.scale * 100) + '%';
}

// Shared zoom step: the ± buttons and canvas wheel-zoom converge here so the
// clamp (0.4–3x), the ×1.25 step factor, and the label + re-render path stay
// identical. `dir` is +1 (zoom in) or -1 (zoom out). Only mutates
// state.fp.scale — the state shape itself is untouched.
function fpZoomStep(dir) {
  if (dir > 0) state.fp.scale = Math.min(3, state.fp.scale * 1.25);
  else state.fp.scale = Math.max(0.4, state.fp.scale / 1.25);
  fpRenderCanvas(); // re-renders the canvas and refreshes the zoom label
}

function fpPopulateFloorSelect() {
  const b = branchByCode(state.fp.branchCode);
  const floors = state.floors.filter((f) => f.branchId === b?.id).sort((a, c) => a.level - c.level);
  const sel = $('#fpFloor');
  if (!sel) return;
  sel.innerHTML = floors
    .map((f) => `<option value="${escapeHtml(f.id)}">Level ${f.level} — ${escapeHtml(f.name)}</option>`)
    .join('');
  if (state.fp.floorId && floors.some((f) => f.id === state.fp.floorId)) sel.value = state.fp.floorId;
  else if (floors.length) {
    sel.value = floors[0].id;
    state.fp.floorId = floors[0].id;
  } else {
    state.fp.floorId = null;
  }
}

function fpPopulateSelects() {
  const bsel = $('#fpBranch');
  if (!bsel) return;
  bsel.innerHTML = state.branches
    .map((b) => `<option value="${escapeHtml(b.code)}">${b.code} · ${escapeHtml(b.name)}</option>`)
    .join('');
  if (state.branches.some((b) => b.code === state.fp.branchCode)) bsel.value = state.fp.branchCode;
  else if (state.branches.length) {
    state.fp.branchCode = state.branches[0].code;
    bsel.value = state.fp.branchCode;
  }
  fpPopulateFloorSelect();
}

async function fpFetch() {
  if (!state.fp.floorId) {
    fpRender();
    return;
  }
  try {
    const body = await get(`/floor-plans/${encodeURIComponent(state.fp.floorId)}`);
    state.fp.plan = body.plan;
    state.fp.canvasDefaults = body.canvasDefaults || { width: 70, height: 80 };
    state.fp.structure = body.plan ? body.plan.structure : null;
    state.fp.placements = fpNormalizePlacements(body.plan);
    state.fp.blocks = fpNormalizeBlocks(body.plan);
    state.fp.boundaries = fpNormalizeBoundaries(body.plan);
    state.fp.unplaced = (body.unplacedUnits || []).map(fpNormalizeUnit);
    state.fp.branchName = body.branch && body.branch.name;
    state.fp.floorName = body.floor ? `Level ${body.floor.level}` : '';
    state.fp.selected = null;
    state.fp.selectedBlock = null;
    state.fp.selectedBoundary = null;
    state.fp.scale = 1;
    // A (re)load resets the live-typed canvas size back to server state, and
    // shrink-fits any placements/blocks the server may hold beyond a (possibly
    // just-saved, smaller) canvas so nothing renders off-grid.
    state.fp.liveDims = null;
    const d = fpCanvasDims();
    fpClampCanvasContent(d.w, d.h);
    fpRender();
    fpSetPaletteCollapsed(false);
    notifyMetricsFloorChanged();
  } catch (err) {
    fpToast('Load floor plan: ' + describeError(err), false);
  }
}

export async function fpOpen() {
  if (!state.branches.length || !state.floors.length) await loadRefs();
  if (!state.fp.floorId) {
    const floors = branchFloors(state.fp.branchCode);
    state.fp.floorId = floors[0]?.id || null;
    if (!state.fp.floorId) {
      fpToast('No floors found for this branch.', false);
      fpRender();
      return;
    }
  }
  fpPopulateSelects();
  await fpFetch();
}

function fpRenderPalette() {
  const list = $('#fpPalette');
  const sub = $('#fpPaletteSub');
  if (!list) return;
  if (sub) {
    const total = state.fp.placements.length + state.fp.unplaced.length;
    sub.textContent = state.fp.unplaced.length
      ? `${state.fp.unplaced.length} unplaced of ${total} · drag onto the canvas`
      : total
        ? 'All units on this floor are placed — click a unit to move/resize/remove'
        : 'No units on this floor yet.';
  }
  list.innerHTML = state.fp.unplaced.length
    ? state.fp.unplaced
        .map((u) => {
          const fp = unitFootprint(u);
          return `<div class="fp-unit-chip" data-unit-id="${escapeHtml(u.id)}" title="${escapeHtml(u.unitCode)} · ${u.sqft} sqft — drag onto the canvas">${escapeHtml(u.unitCode)}<div class="t-type">${escapeHtml(u.sizeName)} · ${u.sqft} sqft · ${fp.w}×${fp.h} ft</div></div>`;
        })
        .join('')
    : '<div class="fp-hint">No unplaced units on this floor.</div>';
}

function fpSetPaletteCollapsed(collapsed) {
  const layout = document.querySelector('#facility-floorplans .fp-layout');
  const toggle = $('#fpPaletteToggle');
  const reopen = $('#fpPaletteReopen');
  if (layout) layout.classList.toggle('collapsed', collapsed);
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.textContent = collapsed ? '›' : '‹';
    toggle.title = collapsed ? 'Show the units palette to drag more units' : 'Collapse the units palette to give the canvas more space';
  }
  if (reopen) reopen.hidden = !collapsed;
}

function fpPaletteCollapsed() {
  return document.querySelector('#facility-floorplans .fp-layout')?.classList.contains('collapsed') === true;
}

function fpRenderStructure(canvas, u, structure) {
  const s = structure === undefined ? state.fp.structure : structure;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return;
  const add = (cls, style, label) => {
    const el = document.createElement('div');
    el.className = cls;
    Object.assign(el.style, style);
    if (label) el.textContent = label;
    canvas.appendChild(el);
  };
  (Array.isArray(s.walls) ? s.walls : []).forEach((w) => {
    if (!w || typeof w !== 'object') return;
    if (w.x1 === w.x2) {
      add('fp-wall', {
        left: w.x1 * u + 'px',
        top: Math.min(w.y1, w.y2) * u + 'px',
        width: Math.max(2, u * 0.15) + 'px',
        height: Math.max(1, Math.abs(w.y2 - w.y1)) * u + 'px',
      });
    } else {
      add('fp-wall', {
        top: w.y1 * u + 'px',
        left: Math.min(w.x1, w.x2) * u + 'px',
        width: Math.max(1, Math.abs(w.x2 - w.x1)) * u + 'px',
        height: Math.max(2, u * 0.15) + 'px',
      });
    }
  });
  (Array.isArray(s.corridors) ? s.corridors : []).forEach((c) => {
    const pts = c && Array.isArray(c.pts) ? c.pts : [];
    if (pts.length < 2) return;
    const a = pts[0];
    const bb = pts[pts.length - 1];
    const wpx = Math.max(3, (c.w || 3) * u);
    if (a.x === bb.x) {
      add('fp-corridor', {
        left: a.x * u - wpx / 2 + 'px',
        top: Math.min(a.y, bb.y) * u + 'px',
        width: wpx + 'px',
        height: Math.max(1, Math.abs(bb.y - a.y)) * u + 'px',
      });
    } else {
      add('fp-corridor', {
        top: a.y * u - wpx / 2 + 'px',
        left: Math.min(a.x, bb.x) * u + 'px',
        width: Math.max(1, Math.abs(bb.x - a.x)) * u + 'px',
        height: wpx + 'px',
      });
    }
  });
  [['entrance', 'Entrance'], ['lift', 'Lift'], ['stairs', 'Stairs'], ['fireExit', 'Fire Exit']].forEach(
    ([key, label]) => {
      const d = s[key];
      if (!d || typeof d !== 'object') return;
      add('fp-struct', {
        left: (d.x || 0) * u + 'px',
        top: (d.y || 0) * u + 'px',
        width: Math.max(2, (d.w || 2)) * u + 'px',
        height: Math.max(2, (d.h || 2)) * u + 'px',
      }, label);
    },
  );
}

// Facility-boundary line items as an SVG overlay under the blocks/units (the
// .fp-boundary-layer CSS is pointer-events:none z-index 1, so canvas pointer
// interactions are untouched). Closed loops render as filled <polygon>s, open
// polylines as dashed <polyline>s, the in-flight pencil draft as a dashed
// preview. Reused by the editor canvas AND the read-only fpView canvas.
// Pencil lines (kind 'PENCIL') only show their label while selected.
function fpRenderBoundaryLayer(canvas, u, dims, boundaries, draft, selectedId) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'fp-boundary-layer');
  svg.setAttribute('width', String(dims.w * u));
  svg.setAttribute('height', String(dims.h * u));
  svg.setAttribute('viewBox', `0 0 ${dims.w * u} ${dims.h * u}`);
  const addShape = (points, closed, cls) => {
    const el = document.createElementNS(SVG_NS, closed ? 'polygon' : 'polyline');
    el.setAttribute('points', points.map(([x, y]) => `${x * u},${y * u}`).join(' '));
    el.setAttribute('class', cls);
    svg.appendChild(el);
  };
  for (const b of boundaries || []) {
    const pts = fpBoundaryPoints(b.points);
    if (pts.length < 2) continue;
    addShape(pts, b.closed, 'fp-boundary' + (b.closed ? '' : ' open') + (b.id && b.id === selectedId ? ' selected' : ''));
    if (String(b.kind || '').toUpperCase() !== 'PENCIL' || b.id === selectedId) {
      const [lx, ly] = pts[0];
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'fp-boundary-label');
      label.setAttribute('x', String(lx * u + 4));
      label.setAttribute('y', String(ly * u - 4));
      label.textContent = b.label || 'Line';
      svg.appendChild(label);
    }
  }
  if (draft && (draft.x1 !== draft.x2 || draft.y1 !== draft.y2)) {
    addShape([[draft.x1, draft.y1], [draft.x2, draft.y2]], false, 'fp-boundary draft');
  }
  canvas.appendChild(svg);
}

function fpRenderCanvas() {
  const canvas = $('#fpCanvas');
  if (!canvas) return;
  const { w, h } = fpCanvasDims();
  const u = fpPx();
  canvas.style.width = w * u + 'px';
  canvas.style.height = h * u + 'px';
  canvas.style.backgroundSize = `${u}px ${u}px`;
  canvas.innerHTML = '';
  fpRenderStructure(canvas, u);
  fpRenderBoundaryLayer(canvas, u, fpCanvasDims(), state.fp.boundaries || [], fpDraftLine, state.fp.selectedBoundary);
  // Decoration blocks — BELOW units in z-order (blocks z-index 1, units 2).
  for (const blk of state.fp.blocks) {
    const el = document.createElement('div');
    el.className = 'fp-block' + (state.fp.selectedBlock === blk.id ? ' selected' : '');
    el.dataset.blockId = blk.id;
    el.style.left = blk.x * u + 'px';
    el.style.top = blk.y * u + 'px';
    el.style.width = blk.width * u + 'px';
    el.style.height = blk.height * u + 'px';
    if (blk.color) el.style.background = blk.color;
    const name = document.createElement('span');
    name.className = 'fp-block-name';
    name.textContent = blk.name || 'Block';
    el.appendChild(name);
    const rs = document.createElement('div');
    rs.className = 'fp-resize';
    rs.title = 'Drag to resize';
    el.appendChild(rs);
    canvas.appendChild(el);
  }
  const statusDot = { OCCUPIED: '#0B4F5E', AVAILABLE: '#5A7A60', RESERVED: '#D4860A', OVERDUE: '#C0392B', MAINTENANCE: '#9C948D', INACTIVE: '#9C948D', BLOCKED: '#8a8478' };
  // Stacked pairs (same rect, tiers 0 + 1) render as ONE block split by a
  // middle divider line: upper unit code above, lower code below.
  for (const group of fpGroupByRect(state.fp.placements)) {
    const r = group.rect;
    if (group.members.length >= 2) {
      const lower = group.members[0];
      const upper = group.members[1];
      const el = document.createElement('div');
      const selected = state.fp.selected === lower.unitId || state.fp.selected === upper.unitId;
      el.className = 'fp-placed fp-stacked' + (selected ? ' selected' : '');
      el.dataset.unitId = lower.unitId;
      el.dataset.stackMateId = upper.unitId;
      el.style.left = r.x * u + 'px';
      el.style.top = r.y * u + 'px';
      el.style.width = r.width * u + 'px';
      el.style.height = r.height * u + 'px';
      el.title = `Stacked pair — upper ${upper.unitCode} (${upper.status}) / lower ${lower.unitCode} (${lower.status})`;
      el.innerHTML =
        `<div class="fp-status" style="background:${statusDot[lower.status] || '#9C948D'};"></div>` +
        `<div class="fp-code fp-stack-upper">${escapeHtml(upper.unitCode)}</div>` +
        `<div class="fp-stack-divider"></div>` +
        `<div class="fp-code fp-stack-lower">${escapeHtml(lower.unitCode)}</div>` +
        `<div class="fp-resize" title="Drag to resize"></div>`;
      canvas.appendChild(el);
      continue;
    }
    const pl = group.members[0];
    const el = document.createElement('div');
    el.className = 'fp-placed' + (state.fp.selected === pl.unitId ? ' selected' : '');
    el.dataset.unitId = pl.unitId;
    el.dataset.stackTier = String(pl.stackTier || 0);
    el.style.left = pl.x * u + 'px';
    el.style.top = pl.y * u + 'px';
    el.style.width = pl.width * u + 'px';
    el.style.height = pl.height * u + 'px';
    el.innerHTML =
      `<div class="fp-status" style="background:${statusDot[pl.status] || '#9C948D'};"></div>` +
      `<div class="fp-code">${escapeHtml(pl.unitCode)}</div>` +
      (pl.height * u > 34 ? `<div class="fp-size">${escapeHtml(pl.sizeName)}</div>` : '') +
      `<div class="fp-resize" title="Drag to resize"></div>`;
    canvas.appendChild(el);
  }
  // Line-tool affordance: crosshair while draw mode is armed (mode-gated —
  // placement/block drags only run when the tool is toggled off).
  canvas.style.cursor = state.fp.drawMode ? 'crosshair' : '';
  fpZoomLabel();
}

function fpRenderSelInfo() {
  const info = $('#fpSelInfo');
  if (!info) return;
  // A selected decoration block takes priority over any selected unit.
  const blk = state.fp.blocks.find((b) => b.id === state.fp.selectedBlock);
  if (blk) {
    info.innerHTML =
      `<span class="t-type">Block · ${escapeHtml(blk.name)} · ${blk.x},${blk.y} · ${blk.width}×${blk.height}</span>` +
      `<span class="fp-rename-wrap"><label class="fp-sr" for="fpBlockRename">Block name</label>` +
      `<svg class="fp-name-icon" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2.5 2.5H10l5.5 5.5-7.5 7.5-5.5-5.5V2.5z"/><circle cx="6.6" cy="6.6" r="1.3"/></svg>` +
      `<input type="text" id="fpBlockRename" class="tbl-search fp-name-input" maxlength="80" value="${escapeHtml(blk.name)}" placeholder="Rename block" aria-label="Rename block" autocomplete="off" spellcheck="false"></span>` +
      `<button class="act-btn" id="fpBlockRenameBtn" style="padding:2px 9px;font-size:10px;">Rename</button>` +
      `<button class="act-btn danger" id="fpBlockRemoveBtn" style="padding:2px 9px;font-size:10px;">Remove block</button>`;
    return;
  }
  // A selected boundary line item (incl. pencil-drawn lines) renders like the
  // block branch: a short descriptor plus the remove action.
  const bnd = (state.fp.boundaries || []).find((b) => b.id === state.fp.selectedBoundary);
  if (bnd) {
    const pts = fpBoundaryPoints(bnd.points);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const isPencil = String(bnd.kind || '').toUpperCase() === 'PENCIL';
    const meta = [
      `${pts.length} vertex${pts.length === 1 ? '' : 'es'}`,
      len ? `${Math.round(len)} ft` : null,
      bnd.closed ? 'closed loop (feeds GLA/UFA)' : 'open polyline — decoration, no metrics impact',
    ]
      .filter(Boolean)
      .join(' · ');
    info.innerHTML =
      `<span class="t-type">${isPencil ? '✎ Line' : '⌒ Boundary'} · ${escapeHtml(bnd.label || 'Line')} · ${meta}</span>` +
      `<button class="act-btn danger" id="fpBoundaryRemoveBtn" style="padding:2px 9px;font-size:10px;">Remove line</button>`;
    return;
  }
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  if (!pl) {
    info.innerHTML = '';
    return;
  }
  const lockNote = state.fp.lockSqft ? ' · 🔒 sqft' : '';
  const mate = fpStackMate(pl);
  if (mate) {
    // One block, two tiers: unstack removes the UPPER tier (the ground tier
    // stays as a single); drag/resize moves both tiers together.
    const upper = (pl.stackTier || 0) === 1 ? pl : mate;
    const lower = upper === pl ? mate : pl;
    info.innerHTML =
      `<span class="t-type">⧉ Stacked pair · ${escapeHtml(upper.unitCode)} (upper) over ${escapeHtml(lower.unitCode)} (lower) · ${pl.x},${pl.y} · ${pl.width}×${pl.height} ft${lockNote}</span>` +
      `<button class="act-btn" id="fpRotateBtn" style="padding:2px 9px;font-size:10px;" title="Swap width/height (90° rotation) for both tiers">⟳ Rotate</button>` +
      `<button class="act-btn" id="fpUnstackBtn" style="padding:2px 9px;font-size:10px;" title="Remove the upper tier — the lower tier stays as a single">Unstack</button>` +
      `<button class="act-btn danger" id="fpRemoveBtn" style="padding:2px 9px;font-size:10px;">Remove from floor</button>`;
    return;
  }
  // Lone locker placements offer Stack when exactly one same-rect partner is
  // possible (one unplaced locker with a matching footprint).
  const stackable = (pl.stackTier || 0) === 0 && fpIsLockerPlacement(pl) ? fpStackCandidates(pl) : [];
  // Door authoring (Phase 3): N/S/E/W toggles persisted per placement via the
  // existing PUT units endpoint (additive doorEdges). Null = unauthored (AUTO
  // all edges in metrics); toggling one edge off authors the rest.
  const authored = Array.isArray(pl.doorEdges) ? pl.doorEdges : null;
  const effDoors = authored && authored.length ? authored : ['N', 'S', 'E', 'W'];
  const doorBtns = ['N', 'S', 'E', 'W']
    .map((e) => `<button class="act-btn${effDoors.includes(e) ? ' primary' : ''}" data-door="${e}" style="padding:2px 8px;font-size:10px;" title="Toggle ${e} door edge">${e}</button>`)
    .join('');
  info.innerHTML =
    `<span class="t-type">${escapeHtml(pl.unitCode)} · ${pl.x},${pl.y} · ${pl.width}×${pl.height} ft · ${pl.sqft} sqft${lockNote}</span>` +
    `<button class="act-btn" id="fpRotateBtn" style="padding:2px 9px;font-size:10px;" title="Swap width/height (90° rotation)">⟳ Rotate</button>` +
    (stackable.length === 1
      ? `<button class="act-btn" id="fpStackBtn" style="padding:2px 9px;font-size:10px;" title="Stack ${escapeHtml(stackable[0].unitCode)} (upper) onto this block">⧉ Stack ${escapeHtml(stackable[0].unitCode)}</button>`
      : '') +
    `<span class="t-type">Doors${authored ? '' : ' (auto)'}:</span>` + doorBtns +
    (authored ? `<button class="act-btn" id="fpDoorsAutoBtn" style="padding:2px 9px;font-size:10px;" title="Clear authored doors — fall back to all edges">Auto</button>` : '') +
    `<button class="act-btn danger" id="fpRemoveBtn" style="padding:2px 9px;font-size:10px;">Remove from floor</button>`;
}

// Persist one placement's authored door edges (null clears back to AUTO).
// Stacked pairs share one rect and keep AUTO (their server-side door union is
// already all edges), so toggles are singles-only.
async function fpSaveDoors(pl, edges) {
  try {
    const res = await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(pl.unitId)}`, {
      method: 'PUT',
      body: JSON.stringify({ x: pl.x, y: pl.y, width: pl.width, height: pl.height, stackTier: pl.stackTier || 0, doorEdges: edges }),
    });
    pl.doorEdges = res && res.data ? res.data.doorEdges : edges;
    fpRenderSelInfo();
    notifyMetricsFloorChanged();
    fpToast(
      pl.doorEdges ? `Doors ${pl.unitCode} → ${pl.doorEdges.join('')} (authored)` : `Doors ${pl.unitCode} → auto (all edges)`,
      true,
    );
  } catch (err) {
    fpToast(`Doors ${pl.unitCode}: ${describeError(err)}`, false);
  }
}

async function fpToggleDoor(edge) {
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  if (!pl || fpStackMate(pl)) return;
  const authored = Array.isArray(pl.doorEdges) ? pl.doorEdges.slice() : null;
  let next;
  if (!authored) {
    next = ['N', 'S', 'E', 'W'].filter((e) => e !== edge); // turning one edge off authors the rest
  } else if (authored.includes(edge)) {
    next = authored.filter((e) => e !== edge);
    if (!next.length) {
      fpToast('A unit needs at least one door — use Auto to restore all edges.', false);
      return;
    }
  } else {
    next = authored.concat(edge);
  }
  await fpSaveDoors(pl, next);
}

async function fpResetDoors() {
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  if (!pl || fpStackMate(pl)) return;
  await fpSaveDoors(pl, null);
}

// Unplaced lockers whose footprint (either orientation) exactly matches the
// selected block's rect — i.e. units that could stack onto it as upper tier.
function fpStackCandidates(pl) {
  return state.fp.unplaced.filter((u) => {
    if (String(u.sizeCode || '').toUpperCase() !== 'LOCKER') return false;
    const fp = sizeFootprint(u.sizeCode, u.sqft);
    return (fp.w === pl.width && fp.h === pl.height) || (fp.w === pl.height && fp.h === pl.width);
  });
}

// Stack the single matching unplaced locker onto the selected block as the
// upper tier (the selected placement stays the lower tier).
async function fpStackSelected() {
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  if (!pl || fpStackMate(pl) || (pl.stackTier || 0) !== 0 || !fpIsLockerPlacement(pl)) return;
  const cands = fpStackCandidates(pl);
  if (cands.length !== 1) {
    fpToast(
      cands.length
        ? 'Several lockers match this footprint — drag one from the palette onto this block to stack.'
        : 'No unplaced locker matches this footprint — stacking needs a locker of the same size.',
      false,
    );
    return;
  }
  const cand = cands[0];
  const stackOk = await confirmDialog({
    title: `Stack ${cand.unitCode} on ${pl.unitCode}?`,
    message: `${cand.unitCode} becomes the UPPER tier and ${pl.unitCode} stays the LOWER tier — one block split by a divider line.`,
    confirmLabel: 'Stack',
  });
  if (!stackOk) return;
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(cand.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ x: pl.x, y: pl.y, width: pl.width, height: pl.height, stackTier: 1 }),
    });
    state.fp.unplaced = state.fp.unplaced.filter((u) => u.id !== cand.id);
    state.fp.placements.push({
      id: '',
      unitId: cand.id,
      unitCode: cand.unitCode,
      name: cand.name,
      sizeCode: cand.sizeCode,
      sizeName: cand.sizeName,
      sqft: cand.sqft,
      status: cand.status,
      x: pl.x,
      y: pl.y,
      width: pl.width,
      height: pl.height,
      stackTier: 1,
    });
    fpToast(`Stacked ${cand.unitCode} (upper) over ${pl.unitCode} (lower)`, true);
    fpRender();
    notifyMetricsFloorChanged();
  } catch (err) {
    fpToast(`Stack ${cand.unitCode}: ${describeError(err)}`, false);
  }
}

// Unstack a stacked pair: removes the UPPER tier's placement (geometry only —
// the unit itself is unaffected) so the lower tier stays as a single.
async function fpUnstackSelected() {
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  if (!pl) return;
  const mate = fpStackMate(pl);
  if (!mate) return;
  const upper = (pl.stackTier || 0) === 1 ? pl : mate;
  const lower = upper === pl ? mate : pl;
  const unstackOk = await confirmDialog({
    title: `Unstack ${upper.unitCode}?`,
    message: `${upper.unitCode} is removed from the stack — ${lower.unitCode} remains as a single. The unit itself is unaffected.`,
    confirmLabel: 'Unstack',
    danger: true,
  });
  if (!unstackOk) return;
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(upper.unitId)}`, {
      method: 'DELETE',
    });
    fpToast(`${upper.unitCode} unstacked — ${lower.unitCode} is now a single.`, true);
    await fpFetch();
  } catch (err) {
    fpToast('Unstack: ' + describeError(err), false);
  }
}

function fpRender() {
  const d = fpCanvasDims();
  const title = $('#fpTitle');
  if (title) {
    const where = [state.fp.branchName, state.fp.floorName].filter(Boolean).join(' · ');
    title.textContent = 'Floor Plan Editor' + (where ? ' — ' + where : '');
  }
  const sub = $('#fpSub');
  if (sub) {
    const unitLabel = `${state.fp.placements.length} unit${state.fp.placements.length === 1 ? '' : 's'}`;
    const blockLabel = `${state.fp.blocks.length} block${state.fp.blocks.length === 1 ? '' : 's'}`;
    sub.textContent = state.fp.plan
      ? `${unitLabel} placed · ${blockLabel} on a ${d.w}×${d.h} ft canvas — drag to move, corner handle to resize`
      : "No plan yet — set a canvas size and click Save Canvas, then drag this floor's units from the palette.";
  }
  fpSyncDimInputs(d);
  const st = $('#fpStructure');
  if (st) st.value = state.fp.structure ? JSON.stringify(state.fp.structure, null, 2) : '';
  const legacy = $('#fpLegacyNote');
  if (legacy) {
    legacy.hidden = !state.fp.structure;
  }
  fpRenderPalette();
  fpRenderCanvas();
  fpRenderSelInfo();
}

function fpCanvasCellAt(clientX, clientY) {
  const canvas = $('#fpCanvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const u = fpPx();
  const gx = Math.floor((clientX - rect.left) / u);
  const gy = Math.floor((clientY - rect.top) / u);
  const { w: cw, h: ch } = fpCanvasDims();
  if (gx < 0 || gy < 0 || gx >= cw || gy >= ch) return null;
  return { gx, gy };
}

// Nearest integer grid-ft point for a pointer position, clamped into the
// canvas with edges INCLUSIVE (0..w / 0..h — boundary vertices may sit on the
// canvas edge, same contract as checkBoundaryPoints in src/core/floorPlans.ts).
function fpCanvasPointAt(clientX, clientY) {
  const canvas = $('#fpCanvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const u = fpPx();
  const { w: cw, h: ch } = fpCanvasDims();
  return {
    x: Math.min(Math.max(0, Math.round((clientX - rect.left) / u)), cw),
    y: Math.min(Math.max(0, Math.round((clientY - rect.top) / u)), ch),
  };
}

// Pencil draw interaction (line tool ON): mousedown arms the draft at the
// snapped grid point, pointermove previews the straight segment, mouseup
// persists it; Escape cancels mid-draft. Same document-listener drag pattern
// as fpStartMove/fpBlockStartMove — no new interaction paradigm.
function fpDrawStart(e) {
  if (e.button !== 0) return;
  const start = fpCanvasPointAt(e.clientX, e.clientY);
  if (!start) return;
  e.preventDefault();
  state.fp.selected = null;
  state.fp.selectedBlock = null;
  state.fp.selectedBoundary = null;
  fpDraftLine = { x1: start.x, y1: start.y, x2: start.x, y2: start.y };
  fpRenderCanvas();
  fpRenderSelInfo();
  const move = (ev) => {
    const p = fpCanvasPointAt(ev.clientX, ev.clientY);
    if (!p || !fpDraftLine) return;
    fpDraftLine.x2 = p.x;
    fpDraftLine.y2 = p.y;
    fpRenderCanvas();
  };
  const cleanup = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    fpDraftLine = null;
    cleanup();
    fpRenderCanvas();
  };
  const up = () => {
    cleanup();
    const d = fpDraftLine;
    fpDraftLine = null;
    if (!d) return;
    // A zero-length click draws nothing — a 2-vertex polyline must be meaningful.
    if (d.x1 === d.x2 && d.y1 === d.y2) {
      fpRenderCanvas();
      return;
    }
    fpPersistLine(d.x1, d.y1, d.x2, d.y2);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('keydown', onKey);
}

// Persist a drawn line as an OPEN boundary polyline (kind 'PENCIL') via the
// existing boundary endpoints — ZERO contract change (label/kind/points/closed
// are long-standing fields). Open polylines never feed boundaryMetrics, so
// drawn lines are display-only and the public payload schema is untouched.
async function fpPersistLine(x1, y1, x2, y2) {
  try {
    const res = await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/boundaries`, {
      method: 'POST',
      body: JSON.stringify({ label: 'Line', kind: 'PENCIL', points: [[x1, y1], [x2, y2]], closed: false }),
    });
    const b = res.data;
    // The plan is lazily created server-side when a floor has none yet (same
    // lazy adoption as fpAddBlock) — give the new line a local surface.
    if (!state.fp.plan) {
      state.fp.plan = { width: state.fp.canvasDefaults.width, height: state.fp.canvasDefaults.height };
    }
    state.fp.boundaries.push({ id: b.id, label: b.label, kind: b.kind, points: fpBoundaryPoints(b.points), closed: !!b.closed, sortOrder: b.sortOrder || 0 });
    state.fp.selectedBoundary = b.id;
    state.fp.selected = null;
    state.fp.selectedBlock = null;
    fpRender();
    notifyMetricsFloorChanged();
    fpToast(`Line added — ${Math.round(Math.hypot(x2 - x1, y2 - y1))} ft at ${x1},${y1} → ${x2},${y2}. Click it to select/remove.`, true);
  } catch (err) {
    fpRenderCanvas();
    fpToast('Draw line: ' + describeError(err), false);
  }
}

// Nearest persisted boundary line to a pointer position within ~8px — powers
// click-to-select (mirror of how blocks select on click). The SVG layer is
// pointer-events:none, so the segment hit-test runs here against grid-ft
// points scaled by the live px-per-foot.
function fpBoundaryHitAt(clientX, clientY) {
  const canvas = $('#fpCanvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const u = fpPx();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const THRESHOLD = 8;
  let best = null;
  let bestDist = Infinity;
  for (const b of state.fp.boundaries || []) {
    const pts = fpBoundaryPoints(b.points);
    for (let i = 1; i < pts.length; i++) {
      const x1 = pts[i - 1][0] * u;
      const y1 = pts[i - 1][1] * u;
      const x2 = pts[i][0] * u;
      const y2 = pts[i][1] * u;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq ? Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lenSq)) : 0;
      const dist = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      if (dist < bestDist) {
        bestDist = dist;
        best = b.id;
      }
    }
  }
  return bestDist <= THRESHOLD ? best : null;
}

async function fpPersist(pl, verb) {
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(pl.unitId)}`, {
      method: 'PUT',
      body: JSON.stringify({ x: pl.x, y: pl.y, width: pl.width, height: pl.height, stackTier: pl.stackTier || 0 }),
    });
    fpToast(`${verb} ${pl.unitCode} → ${pl.x},${pl.y} · ${pl.width}×${pl.height} ft`, true);
    notifyMetricsFloorChanged();
  } catch (err) {
    fpToast(`${verb} ${pl.unitCode}: ${describeError(err)}`, false);
    await fpFetch(); // revert local state to what the server has
  }
}

// Persist a stacked pair's shared rect. The ground tier goes first, then the
// upper tier onto the same rect — the server's partner rule requires the
// tier-0 placement to be present when the tier-1 write lands.
async function fpPersistPair(lower, upper, verb) {
  try {
    for (const p of [lower, upper]) {
      await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(p.unitId)}`, {
        method: 'PUT',
        body: JSON.stringify({ x: p.x, y: p.y, width: p.width, height: p.height, stackTier: p.stackTier || 0 }),
      });
    }
    fpToast(`${verb} stack ${upper.unitCode}/${lower.unitCode} → ${lower.x},${lower.y} · ${lower.width}×${lower.height} ft`, true);
    notifyMetricsFloorChanged();
  } catch (err) {
    fpToast(`${verb} stack ${upper.unitCode}/${lower.unitCode}: ${describeError(err)}`, false);
    await fpFetch(); // revert local state to what the server has
  }
}

async function fpPlaceUnit(unit, footprint, gx, gy) {
  const { w: cw, h: ch } = fpCanvasDims();
  if (footprint.w > cw || footprint.h > ch) {
    fpToast(`${unit.unitCode} (${footprint.w}×${footprint.h} ft) is too large for the ${cw}×${ch} ft canvas — enlarge the canvas first`, false);
    return;
  }
  let x = Math.min(Math.max(0, gx), cw - footprint.w);
  let y = Math.min(Math.max(0, gy), ch - footprint.h);
  const unitIsLocker = String(unit.sizeCode || '').toUpperCase() === 'LOCKER';
  // Snap-to-stack: a dropped locker overlapping a lone ground locker of the
  // identical footprint snaps onto its exact rect so the Stack offer is precise.
  if (unitIsLocker) {
    const snap = state.fp.placements.find(
      (o) =>
        (o.stackTier || 0) === 0 &&
        !fpStackMate(o) &&
        fpIsLockerPlacement(o) &&
        o.width === footprint.w &&
        o.height === footprint.h &&
        x < o.x + o.width &&
        o.x < x + footprint.w &&
        y < o.y + o.height &&
        o.y < y + footprint.h,
    );
    if (snap) {
      x = snap.x;
      y = snap.y;
    }
  }
  // Exact-rect drop: offer Stack for lone-locker-on-locker, explain otherwise.
  const exact = state.fp.placements.find(
    (o) => o.x === x && o.y === y && o.width === footprint.w && o.height === footprint.h,
  );
  if (exact) {
    if (fpStackMate(exact)) {
      fpToast(`${exact.unitCode} is already a stacked pair — lockers stack at most 2 high. Drop ${unit.unitCode} on a free spot.`, false);
      return;
    }
    if (!unitIsLocker || !fpIsLockerPlacement(exact) || (exact.stackTier || 0) !== 0) {
      fpToast(`Cannot stack ${unit.unitCode} onto ${exact.unitCode} — stacking is lockers-only (both units must be LOCKER size sharing one rect).`, false);
      return;
    }
    const stackOk = await confirmDialog({
      title: `Stack ${unit.unitCode} on ${exact.unitCode}?`,
      message: `${unit.unitCode} becomes the UPPER tier and ${exact.unitCode} stays the LOWER tier — one block split by a divider line.`,
      confirmLabel: 'Stack',
    });
    if (!stackOk) return;
    try {
      await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(unit.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ x, y, width: footprint.w, height: footprint.h, stackTier: 1 }),
      });
      state.fp.unplaced = state.fp.unplaced.filter((u) => u.id !== unit.id);
      state.fp.placements.push({
        id: '',
        unitId: unit.id,
        unitCode: unit.unitCode,
        name: unit.name,
        sizeCode: unit.sizeCode,
        sizeName: unit.sizeName,
        sqft: unit.sqft,
        status: unit.status,
        x,
        y,
        width: footprint.w,
        height: footprint.h,
        stackTier: 1,
      });
      fpToast(`Stacked ${unit.unitCode} (upper) over ${exact.unitCode} (lower)`, true);
      fpRender();
      fpSetPaletteCollapsed(true);
      notifyMetricsFloorChanged();
    } catch (err) {
      fpToast(`Stack ${unit.unitCode}: ${describeError(err)}`, false);
    }
    return;
  }
  const hit = fpOverlapAt(x, y, footprint.w, footprint.h, null, 0);
  if (hit) {
    fpToast(`Cannot place ${unit.unitCode} at ${x},${y} — overlaps ${hit.unitCode} (${hit.x},${hit.y} · ${hit.width}×${hit.height} ft). Drop it on a free spot.`, false);
    return;
  }
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(unit.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ x, y, width: footprint.w, height: footprint.h, stackTier: 0 }),
    });
    state.fp.unplaced = state.fp.unplaced.filter((u) => u.id !== unit.id);
    state.fp.placements.push({
      id: '',
      unitId: unit.id,
      unitCode: unit.unitCode,
      name: unit.name,
      sizeCode: unit.sizeCode,
      sizeName: unit.sizeName,
      sqft: unit.sqft,
      status: unit.status,
      x,
      y,
      width: footprint.w,
      height: footprint.h,
      stackTier: 0,
    });
    fpToast(`Placed ${unit.unitCode} → ${x},${y} · ${footprint.w}×${footprint.h} ft`, true);
    fpRender();
    fpSetPaletteCollapsed(true);
    notifyMetricsFloorChanged();
  } catch (err) {
    fpToast(`Place ${unit.unitCode}: ${describeError(err)}`, false);
  }
}

function fpStartPaletteDrag(e, chip) {
  if (e.button !== 0) return;
  const unit = state.fp.unplaced.find((x) => x.id === chip.dataset.unitId);
  if (!unit) return;
  const fp = unitFootprint(unit);
  const u = fpPx();
  e.preventDefault();
  const ghost = document.createElement('div');
  ghost.className = 'fp-ghost';
  ghost.style.width = fp.w * u + 'px';
  ghost.style.height = fp.h * u + 'px';
  ghost.style.left = e.clientX + 'px';
  ghost.style.top = e.clientY + 'px';
  ghost.textContent = unit.unitCode;
  document.body.appendChild(ghost);
  const move = (ev) => {
    ghost.style.left = ev.clientX + 'px';
    ghost.style.top = ev.clientY + 'px';
  };
  const up = (ev) => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    const rect = ghost.getBoundingClientRect();
    ghost.remove();
    const cell = fpCanvasCellAt(rect.left, rect.top);
    if (cell) fpPlaceUnit(unit, fp, cell.gx, cell.gy);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function fpStartMove(e, el) {
  const uid = el.dataset.unitId;
  const pl = state.fp.placements.find((p) => p.unitId === uid);
  if (!pl) return;
  if (e.target.classList.contains('fp-resize')) {
    fpStartResize(e, pl);
    return;
  }
  e.preventDefault();
  // Capture the grab offset from the LIVE element BEFORE any re-render. The
  // fpRenderCanvas() call below rebuilds canvas.innerHTML, which detaches `el`;
  // reading its geometry afterwards would return all-zeros and break dragging.
  const startRect = el.getBoundingClientRect();
  const offsetX = e.clientX - startRect.left;
  const offsetY = e.clientY - startRect.top;
  state.fp.selected = uid;
  // A unit interaction supersedes any block selection — otherwise the info
  // strip would keep showing the stale block while the operator is acting on
  // the unit (fpRenderSelInfo gives a selected block priority over a unit).
  state.fp.selectedBlock = null;
  state.fp.selectedBoundary = null;
  fpRenderCanvas();
  fpRenderSelInfo();
  // Drag/resize moves both tiers of a stacked pair together (same-rect
  // invariant): the pair shares one rect, so every pointer move writes both.
  const mate = fpStackMate(pl);
  const pair = mate ? [pl, mate].slice().sort((a, b) => (a.stackTier || 0) - (b.stackTier || 0)) : [pl];
  const pairIds = pair.map((p) => p.unitId);
  const { w: cw, h: ch } = fpCanvasDims();
  const orig = pair.map((p) => ({ p, x: p.x, y: p.y }));
  const move = (ev) => {
    const cell = fpCanvasCellAt(ev.clientX - offsetX, ev.clientY - offsetY);
    if (!cell) return;
    const nx = Math.min(Math.max(0, cell.gx), Math.max(0, cw - pl.width));
    const ny = Math.min(Math.max(0, cell.gy), Math.max(0, ch - pl.height));
    for (const p of pair) {
      p.x = nx;
      p.y = ny;
    }
    fpRenderCanvas();
  };
  const up = async () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    const hit = fpOverlapAt(pl.x, pl.y, pl.width, pl.height, pairIds, 0);
    if (hit) {
      // Locker stack-drop: a lone locker moved EXACTLY onto a lone locker's
      // rect stacks as the upper tier instead of reverting (lockers-only,
      // max 2-high, same footprint — mirrors src/core/floorPlans.ts). Every
      // other overlap keeps the revert below.
      if (fpStackDropAllowed(pl, hit, pairIds)) {
        await fpStackMovedOn(pl, hit, orig);
        return;
      }
      // Capture exact-rect state BEFORE restoring: after the revert the mover
      // no longer shares the target rect, so same-rect checks must run first.
      const droppedExact = fpSameRect(pl, hit);
      const targetPaired =
        droppedExact &&
        state.fp.placements.some(
          (o) => !pairIds.includes(o.unitId) && o.unitId !== hit.unitId && fpSameRect(o, hit),
        );
      const moverLocker = fpIsLockerPlacement(pl);
      const hitLocker = fpIsLockerPlacement(hit);
      for (const o of orig) {
        o.p.x = o.x;
        o.p.y = o.y;
      }
      fpRenderCanvas();
      if (droppedExact && targetPaired) {
        fpToast(`${hit.unitCode} is already a stacked pair — lockers stack at most 2 high. Move ${pl.unitCode} to a free spot.`, false);
        return;
      }
      if (droppedExact && (!moverLocker || !hitLocker)) {
        fpToast(`Cannot stack ${pl.unitCode} onto ${hit.unitCode} — stacking is lockers-only (both units must be LOCKER size sharing one rect).`, false);
        return;
      }
      fpToast(`Cannot move ${pl.unitCode} to ${pl.x},${pl.y} — overlaps ${hit.unitCode}. Reverted.`, false);
      return;
    }
    if (!mate) fpPersist(pl, 'Moved');
    else fpPersistPair(pair[0], pair[1], 'Moved');
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// Lock-to-sqft resize snapping: given the free-dragged size (w0×h0), return
// the nearest integer rect that preserves area≈sqft while staying on-canvas.
// Keeps the dragged width, derives h=round(sqft/w); if that overflows the
// canvas height, pins h and re-derives w the other way round.
function fpSnapToSqft(w0, h0, sqft, cw, ch, ox, oy) {
  void h0;
  const maxW = Math.max(1, cw - ox);
  const maxH = Math.max(1, ch - oy);
  let w = Math.max(1, Math.min(Math.round(w0) || 1, maxW));
  let h = Math.max(1, Math.min(Math.round(sqft / w), maxH));
  if (Math.round(sqft / w) > maxH) {
    h = maxH;
    w = Math.max(1, Math.min(Math.round(sqft / h), maxW));
  }
  return { w, h };
}

function fpStartResize(e, pl) {
  e.preventDefault();
  e.stopPropagation();
  if (state.fp.selected !== pl.unitId) {
    state.fp.selected = pl.unitId;
    state.fp.selectedBlock = null;
    state.fp.selectedBoundary = null;
    fpRenderCanvas();
    fpRenderSelInfo();
  }
  const u = fpPx();
  const startX = e.clientX;
  const startY = e.clientY;
  const origX = pl.x;
  const origY = pl.y;
  const origW = pl.width;
  const origH = pl.height;
  const { w: cw, h: ch } = fpCanvasDims();
  // A stacked pair resizes as one block (same-rect invariant) — the snap uses
  // the ground tier's sqft and every pointer move writes both tiers.
  const mate = fpStackMate(pl);
  const pair = mate ? [pl, mate].slice().sort((a, b) => (a.stackTier || 0) - (b.stackTier || 0)) : [pl];
  const pairIds = pair.map((p) => p.unitId);
  const move = (ev) => {
    const dx = Math.round((ev.clientX - startX) / u);
    const dy = Math.round((ev.clientY - startY) / u);
    const freeW = Math.max(1, Math.min(origW + dx, cw - origX));
    const freeH = Math.max(1, Math.min(origH + dy, ch - origY));
    let w;
    let h;
    if (state.fp.lockSqft && pl.sqft > 0) {
      const snapped = fpSnapToSqft(freeW, freeH, pair[0].sqft || pl.sqft, cw, ch, origX, origY);
      w = snapped.w;
      h = snapped.h;
    } else {
      w = freeW;
      h = freeH;
    }
    for (const p of pair) {
      p.width = w;
      p.height = h;
    }
    fpRenderCanvas();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    const hit = fpOverlapAt(pl.x, pl.y, pl.width, pl.height, pairIds, 0);
    if (hit) {
      for (const p of pair) {
        p.width = origW;
        p.height = origH;
      }
      fpRenderCanvas();
      fpToast(`Cannot resize ${pl.unitCode} to ${pl.width}×${pl.height} ft — overlaps ${hit.unitCode}. Reverted.`, false);
      return;
    }
    if (!mate) fpPersist(pl, 'Resized');
    else fpPersistPair(pair[0], pair[1], 'Resized');
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// 90° rotation for rectangular placements: swaps W/H, clamps into the canvas,
// rejects on overlap, persists. A stacked pair rotates as one block (both
// tiers share the new rect). No Unit row writes.
async function fpRotatePlacement() {
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  if (!pl) return;
  const mate = fpStackMate(pl);
  const pair = mate ? [pl, mate].slice().sort((a, b) => (a.stackTier || 0) - (b.stackTier || 0)) : [pl];
  const pairIds = pair.map((p) => p.unitId);
  const { w: cw, h: ch } = fpCanvasDims();
  const w = pl.height;
  const h = pl.width;
  if (w > cw || h > ch) {
    fpToast(`Cannot rotate ${pl.unitCode} — ${w}×${h} ft does not fit the ${cw}×${ch} ft canvas.`, false);
    return;
  }
  const prev = pair.map((p) => ({ p, x: p.x, y: p.y, w: p.width, h: p.height }));
  const nx = Math.min(pl.x, Math.max(0, cw - w));
  const ny = Math.min(pl.y, Math.max(0, ch - h));
  for (const p of pair) {
    p.width = w;
    p.height = h;
    p.x = nx;
    p.y = ny;
  }
  const hit = fpOverlapAt(pl.x, pl.y, pl.width, pl.height, pairIds, 0);
  if (hit) {
    for (const o of prev) Object.assign(o.p, { x: o.x, y: o.y, width: o.w, height: o.h });
    fpRenderCanvas();
    fpToast(`Cannot rotate ${pl.unitCode} — ${w}×${h} ft overlaps ${hit.unitCode}.`, false);
    return;
  }
  fpRender();
  if (!mate) await fpPersist(pl, 'Rotated');
  else await fpPersistPair(pair[0], pair[1], 'Rotated');
}

function fpToggleBlockForm(show) {
  const form = $('#fpBlockForm');
  if (!form) return;
  if (show) fpSetPaletteCollapsed(false);
  form.hidden = !show;
  if (show) {
    const input = $('#fpBlockName');
    if (input) {
      input.value = '';
      input.focus();
    }
  }
}

function fpFirstFreeSpot(size) {
  const { w: cw, h: ch } = fpCanvasDims();
  const occupied = state.fp.blocks.concat(state.fp.placements);
  const collides = (x, y) =>
    occupied.some((o) => x < o.x + o.width && o.x < x + size && y < o.y + o.height && o.y < y + size);
  for (let y = 0; y + size <= ch; y++) {
    for (let x = 0; x + size <= cw; x++) {
      if (!collides(x, y)) return { x, y };
    }
  }
  const last = occupied[occupied.length - 1];
  if (last) {
    return {
      x: Math.min(Math.max(0, last.x), Math.max(0, cw - size)),
      y: Math.min(last.y + last.height + 1, Math.max(0, ch - size)),
    };
  }
  return { x: 0, y: 0 };
}

// Rectangular first-free-spot scan for auto-place (same repack approach as the
// opt-in scripts/backfill-placement-footprints.ts): top-left → bottom-right
// over integer foot cells against the live `taken` rect list. Returns {x,y} or
// null — never a fallback spot: canvas dims are blueprint feet and auto-place
// must NOT auto-resize the canvas.
function fpFirstFreeRect(w, h, taken) {
  const { w: cw, h: ch } = fpCanvasDims();
  if (w > cw || h > ch) return null;
  const collides = (x, y) =>
    taken.some((o) => x < o.x + o.width && o.x < x + w && y < o.y + o.height && o.y < y + h);
  for (let y = 0; y + h <= ch; y++) {
    for (let x = 0; x + w <= cw; x++) {
      if (!collides(x, y)) return { x, y };
    }
  }
  return null;
}

// Solid legacy-structure footprints (structure JSON): corridors as their
// bounding box expanded by half-width, plus entrance/lift/stairs/fireExit
// rects. Thin wall lines stay non-blocking — the editor overlap policy is
// unit-vs-unit (+ blocks for auto-place). Occupied rects for auto-place only.
function fpStructureRects() {
  const s = state.fp.structure;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return [];
  const rects = [];
  (Array.isArray(s.corridors) ? s.corridors : []).forEach((c) => {
    const pts = c && Array.isArray(c.pts) ? c.pts : [];
    if (pts.length < 2) return;
    const half = (c.w || 3) / 2;
    const x0 = Math.floor(Math.min(...pts.map((p) => p.x)) - half);
    const y0 = Math.floor(Math.min(...pts.map((p) => p.y)) - half);
    const x1 = Math.ceil(Math.max(...pts.map((p) => p.x)) + half);
    const y1 = Math.ceil(Math.max(...pts.map((p) => p.y)) + half);
    rects.push({ x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) });
  });
  ['entrance', 'lift', 'stairs', 'fireExit'].forEach((key) => {
    const d = s[key];
    if (!d || typeof d !== 'object') return;
    rects.push({
      x: Math.floor(d.x || 0),
      y: Math.floor(d.y || 0),
      width: Math.max(1, Math.ceil(d.w || 2)),
      height: Math.max(1, Math.ceil(d.h || 2)),
    });
  });
  return rects;
}

// Auto-place: renders ALL unplaced units of the current floor onto the canvas.
// One PUT per unit via the existing placement endpoint; footprints come from
// unitFootprint() (true-size sqftFootprint, ghost-rotated orientation first,
// swapped orientation as fallback) so the server's 15% area tolerance holds.
// Units that don't fit — or fail to persist — are collected and reported;
// already-placed units are kept, never reverted as a batch. Canvas dims are
// blueprint feet and are never auto-resized.
async function fpAutoPlaceAll() {
  const btn = $('#fpAutoPlace');
  if (!state.fp.floorId) {
    fpToast('Pick a floor first — auto-place needs a target plan.', false);
    return;
  }
  const queue = state.fp.unplaced.slice();
  if (!queue.length) {
    fpToast('All units on this floor are already placed.', true);
    return;
  }
  const placeOk = await confirmDialog({
    title: `Place ${queue.length} unplaced unit${queue.length === 1 ? '' : 's'}?`,
    message: 'Units are placed into the first free space on the canvas. Already-placed units are kept.',
    confirmLabel: 'Place units',
  });
  if (!placeOk) return;
  if (btn) btn.disabled = true;
  const { w: cw, h: ch } = fpCanvasDims();
  // Placements + blocks + solid structure rects count as occupied for the scan.
  const taken = state.fp.placements
    .map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height }))
    .concat(
      state.fp.blocks.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })),
      fpStructureRects(),
    );
  const placed = [];
  const unfit = [];
  const failed = [];
  try {
    for (const unit of queue) {
      const fp = unitFootprint(unit);
      const orientations = [{ w: fp.w, h: fp.h }];
      if (fp.w !== fp.h) orientations.push({ w: fp.h, h: fp.w });
      let spot = null;
      let geom = null;
      for (const o of orientations) {
        const s = fpFirstFreeRect(o.w, o.h, taken);
        if (s) {
          spot = s;
          geom = o;
          break;
        }
      }
      if (!spot) {
        unfit.push(unit.unitCode);
        continue;
      }
      try {
        await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(unit.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ x: spot.x, y: spot.y, width: geom.w, height: geom.h, stackTier: 0 }),
        });
        state.fp.unplaced = state.fp.unplaced.filter((u) => u.id !== unit.id);
        state.fp.placements.push({
          id: '',
          unitId: unit.id,
          unitCode: unit.unitCode,
          name: unit.name,
          sizeCode: unit.sizeCode,
          sizeName: unit.sizeName,
          sqft: unit.sqft,
          status: unit.status,
          x: spot.x,
          y: spot.y,
          width: geom.w,
          height: geom.h,
          stackTier: 0,
        });
        taken.push({ x: spot.x, y: spot.y, width: geom.w, height: geom.h });
        placed.push(unit.unitCode);
      } catch (err) {
        failed.push(`${unit.unitCode} (${describeError(err)})`);
      }
    }
  } finally {
    if (btn) btn.disabled = false;
  }
  fpRender();
  if (placed.length) fpSetPaletteCollapsed(true);
  notifyMetricsFloorChanged();
  if (!placed.length) {
    fpToast(
      `Auto-place: nothing fits on the ${cw}×${ch} ft canvas — enlarge the canvas first.` +
        (unfit.length ? ` Did not fit: ${unfit.join(', ')}.` : '') +
        (failed.length ? ` Errors: ${failed.join('; ')}.` : ''),
      false,
    );
    return;
  }
  let msg = `Placed ${placed.length} unit${placed.length === 1 ? '' : 's'}`;
  if (unfit.length) msg += `, ${unfit.length} did not fit: ${unfit.join(', ')}`;
  if (failed.length) msg += `, ${failed.length} failed: ${failed.join('; ')}`;
  fpToast(msg + '.', !unfit.length && !failed.length);
}

async function fpAddBlock() {
  const input = $('#fpBlockName');
  if (!input) return;
  const name = input.value.trim();
  if (!name) {
    fpToast('Give the block a name — e.g. "Lift", "Stair", "Walking area", "Exit".', false);
    input.focus();
    return;
  }
  const { w: cw, h: ch } = fpCanvasDims();
  const size = Math.min(6, cw, ch);
  const { x, y } = fpFirstFreeSpot(size);
  try {
    const res = await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/blocks`, {
      method: 'POST',
      body: JSON.stringify({ name, x, y, width: size, height: size }),
    });
    const b = res.data;
    // The plan is lazily created server-side when a floor has none yet; adopt
    // it locally with the default canvas so the new block has a surface.
    if (!state.fp.plan) {
      state.fp.plan = { width: state.fp.canvasDefaults.width, height: state.fp.canvasDefaults.height };
    }
    state.fp.blocks.push({ id: b.id, name: b.name, x: b.x, y: b.y, width: b.width, height: b.height, color: b.color || null });
    state.fp.selectedBlock = b.id;
    state.fp.selected = null;
    fpToggleBlockForm(false);
    fpRender();
    notifyMetricsFloorChanged();
    fpToast(`Added block "${name}" (${size}×${size}) at ${x},${y} — drag it into place or resize from the corner.`, true);
  } catch (err) {
    fpToast('Add block: ' + describeError(err), false);
  }
}

async function fpPersistBlock(blk, verb) {
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/blocks/${encodeURIComponent(blk.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: blk.name, x: blk.x, y: blk.y, width: blk.width, height: blk.height, color: blk.color || null }),
    });
    fpToast(`${verb} block "${blk.name}" → ${blk.x},${blk.y} · ${blk.width}×${blk.height}`, true);
    notifyMetricsFloorChanged();
  } catch (err) {
    fpToast(`${verb} block: ${describeError(err)}`, false);
    await fpFetch(); // revert local state to what the server has
  }
}

function fpBlockStartMove(e, el) {
  const bid = el.dataset.blockId;
  const blk = state.fp.blocks.find((b) => b.id === bid);
  if (!blk) return;
  if (e.target.classList.contains('fp-resize')) {
    fpBlockStartResize(e, blk);
    return;
  }
  e.preventDefault();
  // Capture the grab offset from the LIVE element BEFORE any re-render (same
  // offset-capture-before-render fix as units).
  const startRect = el.getBoundingClientRect();
  const offsetX = e.clientX - startRect.left;
  const offsetY = e.clientY - startRect.top;
  state.fp.selectedBlock = bid;
  state.fp.selected = null;
  state.fp.selectedBoundary = null;
  fpRenderCanvas();
  fpRenderSelInfo();
  const { w: cw, h: ch } = fpCanvasDims();
  const move = (ev) => {
    const cell = fpCanvasCellAt(ev.clientX - offsetX, ev.clientY - offsetY);
    if (!cell) return;
    blk.x = Math.min(Math.max(0, cell.gx), Math.max(0, cw - blk.width));
    blk.y = Math.min(Math.max(0, cell.gy), Math.max(0, ch - blk.height));
    fpRenderCanvas();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    fpPersistBlock(blk, 'Moved');
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function fpBlockStartResize(e, blk) {
  e.preventDefault();
  e.stopPropagation();
  if (state.fp.selectedBlock !== blk.id) {
    state.fp.selectedBlock = blk.id;
    state.fp.selected = null;
    state.fp.selectedBoundary = null;
    fpRenderCanvas();
    fpRenderSelInfo();
  }
  const u = fpPx();
  const startX = e.clientX;
  const startY = e.clientY;
  const origX = blk.x;
  const origY = blk.y;
  const origW = blk.width;
  const origH = blk.height;
  const { w: cw, h: ch } = fpCanvasDims();
  const move = (ev) => {
    const dx = Math.round((ev.clientX - startX) / u);
    const dy = Math.round((ev.clientY - startY) / u);
    blk.width = Math.max(1, Math.min(origW + dx, cw - origX));
    blk.height = Math.max(1, Math.min(origH + dy, ch - origY));
    fpRenderCanvas();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    fpPersistBlock(blk, 'Resized');
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

async function fpRenameBlock() {
  const blk = state.fp.blocks.find((b) => b.id === state.fp.selectedBlock);
  if (!blk) return;
  const input = $('#fpBlockRename');
  const name = input ? input.value.trim() : '';
  if (!name) {
    fpToast('Block name cannot be empty.', false);
    return;
  }
  if (name === blk.name) return;
  const prev = blk.name;
  blk.name = name;
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/blocks/${encodeURIComponent(blk.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name, x: blk.x, y: blk.y, width: blk.width, height: blk.height, color: blk.color || null }),
    });
    fpToast(`Renamed block to "${name}".`, true);
    fpRenderCanvas();
    fpRenderSelInfo();
    notifyMetricsFloorChanged();
  } catch (err) {
    blk.name = prev;
    fpToast('Rename block: ' + describeError(err), false);
  }
}

async function fpRemoveBlock() {
  const blk = state.fp.blocks.find((b) => b.id === state.fp.selectedBlock);
  if (!blk) return;
  const blockOk = await confirmDialog({
    title: `Remove block "${blk.name}" from the plan?`,
    message: 'The block is removed from the canvas. Units are unaffected.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!blockOk) return;
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/blocks/${encodeURIComponent(blk.id)}`, {
      method: 'DELETE',
    });
    fpToast(`Block "${blk.name}" removed.`, true);
    await fpFetch();
  } catch (err) {
    fpToast('Remove block: ' + describeError(err), false);
  }
}

// Remove a drawn/selected boundary line item (same select → confirm → DELETE
// flow as blocks; scoped server-side to this floor's plan).
async function fpRemoveBoundary() {
  const bnd = (state.fp.boundaries || []).find((b) => b.id === state.fp.selectedBoundary);
  if (!bnd) return;
  const removeOk = await confirmDialog({
    title: `Remove line "${bnd.label || 'Line'}" from the plan?`,
    message: 'The line is removed from the canvas. Units, blocks and metrics are unaffected.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!removeOk) return;
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/boundaries/${encodeURIComponent(bnd.id)}`, {
      method: 'DELETE',
    });
    fpToast(`Line "${bnd.label || 'Line'}" removed.`, true);
    await fpFetch();
  } catch (err) {
    fpToast('Remove line: ' + describeError(err), false);
  }
}

async function fpSaveCanvas() {
  if (!state.fp.floorId) return;
  const w = Number($('#fpWidth').value);
  const h = Number($('#fpHeight').value);
  if (!Number.isInteger(w) || w < 1 || w > 500 || !Number.isInteger(h) || h < 1 || h > 500) {
    fpToast('Canvas size must be a whole number between 1 and 500 feet.', false);
    return;
  }
  let structure = null;
  const raw = $('#fpStructure').value.trim();
  if (raw) {
    try {
      structure = JSON.parse(raw);
    } catch (err) {
      fpToast('Structure JSON is invalid — fix the syntax or clear the field.', false);
      return;
    }
  }
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}`, {
      method: 'POST',
      body: JSON.stringify({ width: w, height: h, structure }),
    });
    fpToast(`Canvas saved (${w}×${h} ft).`, true);
    await fpFetch();
  } catch (err) {
    fpToast('Save canvas: ' + describeError(err), false);
  }
}

async function fpDeletePlan() {
  if (!state.fp.plan) {
    fpToast('No plan to delete — set a canvas size and save first.', false);
    return;
  }
  const planOk = await confirmDialog({
    title: 'Delete this floor plan?',
    message: 'ALL unit placements on it will be removed. Units themselves are not affected.',
    confirmLabel: 'Delete plan',
    danger: true,
  });
  if (!planOk) return;
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}`, { method: 'DELETE' });
    fpToast('Floor plan deleted.', true);
    await fpFetch();
  } catch (err) {
    fpToast('Delete plan: ' + describeError(err), false);
  }
}

async function fpRemovePlacement() {
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  if (!pl) return;
  const plOk = await confirmDialog({
    title: `Remove ${pl.unitCode} from the floor plan?`,
    message: 'The unit itself is unaffected.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!plOk) return;
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(pl.unitId)}`, {
      method: 'DELETE',
    });
    fpToast(`${pl.unitCode} removed from the floor plan.`, true);
    await fpFetch();
  } catch (err) {
    fpToast('Remove: ' + describeError(err), false);
  }
}

const fpView = {
  plan: null,
  structure: null,
  placements: [], // normalized placed units
  blocks: [], // normalized decoration blocks
  boundaries: [], // normalized boundary line items (incl. pencil-drawn lines)
  dims: { w: 70, h: 80 }, // plan grid size (plan dims, else canvas defaults)
  floorId: null, // floor whose level === state.level (for the current branch)
};

function fpViewFloor() {
  return branchFloors(state.branchCode).find((f) => f.level === state.level) || null;
}

function fpViewSetMessage(msg) {
  const empty = $('#fpViewEmpty');
  const wrap = $('#fpViewCanvasWrap');
  const canvas = $('#fpViewCanvas');
  if (empty) {
    empty.textContent = msg || '';
    empty.hidden = !msg;
  }
  if (wrap) wrap.hidden = true;
  if (canvas) canvas.innerHTML = '';
}

export function fpViewOpen() {
  const b = branchByCode(state.branchCode);
  const title = $('#fpViewTitle');
  if (title) title.textContent = `Floor Plan — ${b ? b.name : selectedFacilityName() || 'All Facilities'} · Level ${state.level}`;
  const floor = fpViewFloor();
  fpView.floorId = floor ? floor.id : null;
  const overlay = $('#fpViewModal');
  if (!overlay) return;
  overlay.hidden = false;
  if (!floor) {
    fpViewSetMessage('No floor on this level for this branch — pick a level from the floor tabs.');
    return;
  }
  fpViewSetMessage('Loading floor plan…');
  fpViewFetch(floor.id).catch((err) => {
    fpViewSetMessage('Could not load the floor plan: ' + describeError(err));
  });
}

async function fpViewFetch(floorId) {
  const body = await get(`/floor-plans/${encodeURIComponent(floorId)}`);
  fpView.plan = body.plan;
  fpView.structure = body.plan ? body.plan.structure : null;
  fpView.placements = fpNormalizePlacements(body.plan);
  fpView.blocks = fpNormalizeBlocks(body.plan);
  fpView.boundaries = fpNormalizeBoundaries(body.plan);
  const defs = body.canvasDefaults || { width: 70, height: 80 };
  fpView.dims = {
    w: body.plan && body.plan.width > 0 ? body.plan.width : defs.width,
    h: body.plan && body.plan.height > 0 ? body.plan.height : defs.height,
  };
  if (!body.plan) {
    fpViewSetMessage('No floor plan authored yet — click Edit to create one.');
    return;
  }
  const empty = $('#fpViewEmpty');
  if (empty) empty.hidden = true;
  const wrap = $('#fpViewCanvasWrap');
  if (wrap) wrap.hidden = false;
  fpViewRender();
}

function fpViewUnit() {
  const { w, h } = fpView.dims;
  const wrap = $('#fpViewCanvasWrap');
  const availW = Math.max(160, (wrap && wrap.clientWidth ? wrap.clientWidth : 800) - 26);
  const availH = 480;
  const fit = Math.floor(Math.min(availW / w, availH / h));
  return Math.min(Math.max(fit, 8), 64);
}

function fpViewRender() {
  const canvas = $('#fpViewCanvas');
  if (!canvas) return;
  const { w, h } = fpView.dims;
  const u = fpViewUnit();
  canvas.style.width = w * u + 'px';
  canvas.style.height = h * u + 'px';
  canvas.style.backgroundSize = `${u}px ${u}px`;
  canvas.innerHTML = '';
  fpRenderStructure(canvas, u, fpView.structure);
  fpRenderBoundaryLayer(canvas, u, fpView.dims, fpView.boundaries || [], null, null);
  for (const blk of fpView.blocks) {
    const el = document.createElement('div');
    el.className = 'fp-block';
    el.dataset.blockId = blk.id;
    el.style.left = blk.x * u + 'px';
    el.style.top = blk.y * u + 'px';
    el.style.width = blk.width * u + 'px';
    el.style.height = blk.height * u + 'px';
    if (blk.color) el.style.background = blk.color;
    const name = document.createElement('span');
    name.className = 'fp-block-name';
    name.textContent = blk.name || 'Block';
    el.appendChild(name);
    canvas.appendChild(el);
  }
  const statusDot = { OCCUPIED: '#0B4F5E', AVAILABLE: '#5A7A60', RESERVED: '#D4860A', OVERDUE: '#C0392B', MAINTENANCE: '#9C948D', INACTIVE: '#9C948D', BLOCKED: '#8a8478' };
  // Read-only mirror of the editor canvas: stacked pairs (same rect, tiers
  // 0 + 1) render as ONE block split by a middle divider line so booking-side
  // consumers see the stack identically (upper code above, lower code below).
  for (const group of fpGroupByRect(fpView.placements)) {
    const r = group.rect;
    if (group.members.length >= 2) {
      const lower = group.members[0];
      const upper = group.members[1];
      const el = document.createElement('div');
      el.className = 'fp-placed fp-stacked';
      el.dataset.unitId = lower.unitId;
      el.dataset.stackMateId = upper.unitId;
      el.style.left = r.x * u + 'px';
      el.style.top = r.y * u + 'px';
      el.style.width = r.width * u + 'px';
      el.style.height = r.height * u + 'px';
      el.title = `Stacked pair — upper ${upper.unitCode} (${upper.status}) / lower ${lower.unitCode} (${lower.status})`;
      el.innerHTML =
        `<div class="fp-status" style="background:${statusDot[lower.status] || '#9C948D'};"></div>` +
        `<div class="fp-code fp-stack-upper">${escapeHtml(upper.unitCode)}</div>` +
        `<div class="fp-stack-divider"></div>` +
        `<div class="fp-code fp-stack-lower">${escapeHtml(lower.unitCode)}</div>`;
      canvas.appendChild(el);
      continue;
    }
    const pl = group.members[0];
    const el = document.createElement('div');
    el.className = 'fp-placed';
    el.dataset.unitId = pl.unitId;
    el.style.left = pl.x * u + 'px';
    el.style.top = pl.y * u + 'px';
    el.style.width = pl.width * u + 'px';
    el.style.height = pl.height * u + 'px';
    el.innerHTML =
      `<div class="fp-status" style="background:${statusDot[pl.status] || '#9C948D'};"></div>` +
      `<div class="fp-code">${escapeHtml(pl.unitCode)}</div>` +
      (pl.height * u > 34 ? `<div class="fp-size">${escapeHtml(pl.sizeName)}</div>` : '') +
      `<div class="fp-resize" title="Drag to resize"></div>`;
    canvas.appendChild(el);
  }
}

export function fpViewClose() {
  const overlay = $('#fpViewModal');
  if (overlay) overlay.hidden = true;
}

// Read-only accessor for the preview's current floor — the entry's "Edit in
// editor" glue hands it to the editor view without reaching into fpView state.
export function getFpViewFloorId() {
  return fpView.floorId || null;
}

// Canvas wheel zoom: ONLY Ctrl/Cmd+scroll zooms (trackpad pinch reports as
// ctrl+wheel in browsers, so pinch-to-zoom works through the same branch).
// Plain wheel is deliberately NOT hijacked — #fpCanvasWrap is a scrollable
// (overflow:auto) panning surface, so plain scroll keeps panning natively and
// the page scrolls normally elsewhere. Registered on the wrap (never on
// document/window) with { passive: false } so preventDefault() stops the
// browser's page/pinch zoom only while modifier-scrolling over the canvas.
// Pinch/drag pointer flows are untouched (touch-action:none lives on the
// drag handles, not the wrap).
function fpOnCanvasWheel(e) {
  if (!e.ctrlKey && !e.metaKey) return; // plain scroll → native pan
  if (!e.deltaY) return;
  e.preventDefault();
  fpZoomStep(e.deltaY < 0 ? 1 : -1);
}

// Editor Delete/Backspace shortcut: removes the current selection through the
// existing select → confirmDialog → DELETE → refresh flows. Registered ONCE in
// fpInitEvents() (never per-render); the transient drag Escape handlers
// (fpDrawStart) live on document too but only react to Escape, so there is no
// conflict. Guards: typing (inputs/selects/contenteditable — covers the
// block-name, canvas-dims and structure-JSON fields), the read-only
// #fpViewModal preview (editor-only shortcut), and an open #confirmModal (a
// re-press must not supersede the pending confirm). Priority mirrors
// fpRenderSelInfo: boundary line, then decoration block, then unit placement.
// fpDeletePlan (whole-plan delete) is NEVER bound here.
function fpOnDeleteKey(e) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (e.defaultPrevented) return;
  const t = e.target;
  // Typing guard — never hijack text entry.
  if (t && typeof t.closest === 'function') {
    if (t.closest('input, textarea, select, [contenteditable]')) return;
  } else if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) {
    return;
  }
  const viewModal = $('#fpViewModal');
  if (viewModal && !viewModal.hidden) return;
  const confirmModal = $('#confirmModal');
  if (confirmModal && !confirmModal.hidden) return;
  if (state.fp.selectedBoundary) {
    e.preventDefault();
    fpRemoveBoundary();
  } else if (state.fp.selectedBlock) {
    e.preventDefault();
    fpRemoveBlock();
  } else if (state.fp.selected) {
    e.preventDefault();
    fpRemovePlacement();
  }
  // else: nothing selected → no-op
}

export function fpInitEvents() {
  $('#fpBranch').addEventListener('change', (e) => {
    state.fp.branchCode = e.target.value;
    state.fp.floorId = null;
    fpPopulateFloorSelect();
    if (state.fp.floorId) fpFetch().catch(() => {});
  });
  $('#fpFloor').addEventListener('change', (e) => {
    state.fp.floorId = e.target.value;
    fpFetch().catch(() => {});
  });
  $('#fpSaveCanvas').addEventListener('click', fpSaveCanvas);
  $('#fpDeletePlan').addEventListener('click', fpDeletePlan);
  // Orientation toggle for rectangular palette ghosts (placement-time only).
  const rotBtn = $('#fpRotateGhost');
  const syncRotBtn = () => {
    if (!rotBtn) return;
    rotBtn.classList.toggle('on', state.fp.ghostRotated);
    rotBtn.setAttribute('aria-pressed', String(state.fp.ghostRotated));
  };
  if (rotBtn) {
    syncRotBtn();
    rotBtn.addEventListener('click', () => {
      state.fp.ghostRotated = !state.fp.ghostRotated;
      syncRotBtn();
      fpRenderPalette();
      fpToast(state.fp.ghostRotated ? 'Ghost rotated — palette units place swapped (H×W).' : 'Ghost orientation reset (W×H).', true);
    });
  }
  // Lock-to-sqft resize (default ON). OFF is the ops override: free resize,
  // with a warning that the server rejects writes deviating >15% from sqft.
  const lockBtn = $('#fpLockSqft');
  const syncLockBtn = () => {
    if (!lockBtn) return;
    lockBtn.classList.toggle('on', state.fp.lockSqft);
    lockBtn.setAttribute('aria-pressed', String(state.fp.lockSqft));
    lockBtn.textContent = state.fp.lockSqft ? '🔒 sqft' : '🔓 sqft';
  };
  if (lockBtn) {
    syncLockBtn();
    lockBtn.addEventListener('click', () => {
      state.fp.lockSqft = !state.fp.lockSqft;
      syncLockBtn();
      fpRenderSelInfo();
      if (!state.fp.lockSqft) {
        fpToast('Sqft lock OFF — free resize enabled, but the server rejects placements deviating more than 15% from the unit sqft.', false);
      } else {
        fpToast('Sqft lock ON — resize snaps to the nearest rect preserving area ≈ sqft.', true);
      }
    });
  }
  // Pencil (line) tool: toggles draw mode like the other ghost toggles. While
  // ON, canvas press-drag draws a straight grid-ft line persisted as an OPEN
  // boundary polyline (kind 'PENCIL') via POST /floor-plans/:id/boundaries —
  // display-only: open polylines never feed GLA/UFA/NLA (those need closed
  // loops), so the metrics panel and the public payload stay untouched.
  const pencilBtn = $('#fpBoundaryTool');
  const syncPencilBtn = () => {
    if (!pencilBtn) return;
    pencilBtn.classList.toggle('on', state.fp.drawMode);
    pencilBtn.setAttribute('aria-pressed', String(state.fp.drawMode));
  };
  if (pencilBtn) {
    syncPencilBtn();
    pencilBtn.addEventListener('click', () => {
      state.fp.drawMode = !state.fp.drawMode;
      fpDraftLine = null;
      syncPencilBtn();
      fpRenderCanvas();
      fpToast(
        state.fp.drawMode
          ? 'Line tool ON — press and drag on the canvas to draw a line, release to save. Click a drawn line to select it.'
          : 'Line tool OFF — unit and block interactions restored.',
        true,
      );
    });
  }
  // Live canvas resizing: W/H edits re-render the canvas immediately (debounced
  // while typing); change/blur commits the typed value or reverts an invalid one.
  $('#fpWidth').addEventListener('input', fpOnDimInput);
  $('#fpHeight').addEventListener('input', fpOnDimInput);
  $('#fpWidth').addEventListener('change', fpOnDimCommit);
  $('#fpHeight').addEventListener('change', fpOnDimCommit);
  $('#fpWidth').addEventListener('keydown', fpOnDimEnter);
  $('#fpHeight').addEventListener('keydown', fpOnDimEnter);
  $('#fpZoomIn').addEventListener('click', () => fpZoomStep(1));
  $('#fpZoomOut').addEventListener('click', () => fpZoomStep(-1));
  // Modifier-gated canvas zoom (see fpOnCanvasWheel) + editor Delete shortcut
  // (see fpOnDeleteKey) — both attached once here, never per-render.
  $('#fpCanvasWrap').addEventListener('wheel', fpOnCanvasWheel, { passive: false });
  document.addEventListener('keydown', fpOnDeleteKey);
  $('#fpPalette').addEventListener('pointerdown', (e) => {
    const chip = e.target.closest('.fp-unit-chip');
    if (!chip) return;
    fpStartPaletteDrag(e, chip);
  });
  $('#fpPaletteToggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    fpSetPaletteCollapsed(!fpPaletteCollapsed());
  });
  $('#fpPaletteReopen')?.addEventListener('click', () => fpSetPaletteCollapsed(false));
  $('#fpAddBlock').addEventListener('click', () => fpToggleBlockForm(true));
  const fpAutoBtn = $('#fpAutoPlace');
  if (fpAutoBtn) fpAutoBtn.addEventListener('click', fpAutoPlaceAll);
  $('#fpBlockAdd').addEventListener('click', fpAddBlock);
  $('#fpBlockCancel').addEventListener('click', () => fpToggleBlockForm(false));
  $('#fpBlockName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fpAddBlock();
    } else if (e.key === 'Escape') {
      fpToggleBlockForm(false);
    }
  });
  $('#fpCanvasWrap').addEventListener('pointerdown', (e) => {
    // Line tool active: canvas press-drag draws a straight line and the
    // placement/block interactions below are mode-gated off until the tool
    // toggles off. Only canvas surfaces start a line (wrap padding is inert).
    if (state.fp.drawMode) {
      const canvas = $('#fpCanvas');
      if (canvas && canvas.contains(e.target)) fpDrawStart(e);
      return;
    }
    const placed = e.target.closest('.fp-placed');
    if (placed) {
      fpStartMove(e, placed);
      return;
    }
    const blk = e.target.closest('.fp-block');
    if (blk) {
      fpBlockStartMove(e, blk);
      return;
    }
    // click near a drawn boundary line → select it (the SVG layer is
    // pointer-events:none, so the segment hit-test runs here)
    const bndHit = fpBoundaryHitAt(e.clientX, e.clientY);
    if (bndHit) {
      state.fp.selectedBoundary = bndHit;
      state.fp.selected = null;
      state.fp.selectedBlock = null;
      fpRenderCanvas();
      fpRenderSelInfo();
      return;
    }
    // click on empty canvas → deselect
    state.fp.selected = null;
    state.fp.selectedBlock = null;
    state.fp.selectedBoundary = null;
    fpRenderCanvas();
    fpRenderSelInfo();
  });
  $('#fpSelInfo').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'fpRemoveBtn') fpRemovePlacement();
    else if (e.target && e.target.id === 'fpRotateBtn') fpRotatePlacement();
    else if (e.target && e.target.id === 'fpStackBtn') fpStackSelected();
    else if (e.target && e.target.id === 'fpUnstackBtn') fpUnstackSelected();
    else if (e.target && e.target.id === 'fpBlockRemoveBtn') fpRemoveBlock();
    else if (e.target && e.target.id === 'fpBoundaryRemoveBtn') fpRemoveBoundary();
    else if (e.target && e.target.id === 'fpBlockRenameBtn') fpRenameBlock();
    else if (e.target && e.target.id === 'fpDoorsAutoBtn') fpResetDoors();
    else if (e.target && e.target.dataset && e.target.dataset.door) fpToggleDoor(e.target.dataset.door);
  });
  $('#fpSelInfo').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.id === 'fpBlockRename') {
      e.preventDefault();
      fpRenameBlock();
    }
  });
  // read-only preview (opened from the Units view detail panel)
  $('#unitShowFloorPlan').addEventListener('click', fpViewOpen);
  $('#fpViewClose').addEventListener('click', fpViewClose);
  $('#fpViewCloseBtn').addEventListener('click', fpViewClose);
}

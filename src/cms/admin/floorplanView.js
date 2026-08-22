// StoreLah CMS admin UI — floor-plan editor + read-only plan preview.
// Extracted from admin.js (phase-3 layering refactor; nodebestpractices #1).
// Owns all #fp* / #fpView* DOM wiring (attached once via fpInitEvents() from
// the entry's boot). Navigation glue (fpViewEdit → switchView) stays in the
// entry because views must never import the entry module.

import { escapeHtml, $ } from './dom.js';
import { get, request, describeError } from './api.js';
import { state, branchByCode, branchFloors, selectedFacilityName } from './state.js';

// Ref-data retry hook — the entry hands its loadRefs() down here so fpOpen()'s
// lazy guard keeps working without importing the entry.
let loadRefs = null;
export function setRefsLoader(fn) {
  loadRefs = fn;
}

// ---------- floor-plan constants & private module state ----------
const FP_BASE = 24; // px per grid unit at zoom 1
const FP_FOOTPRINT = {
  LOCKER: { w: 2, h: 2 },
  SMALL: { w: 3, h: 2 },
  MEDIUM: { w: 4, h: 3 },
  LARGE: { w: 5, h: 4 },
  XLBIZ: { w: 6, h: 5 },
};
let fpDimsTimer = null;

function fpPx() {
  return Math.max(8, Math.round(FP_BASE * state.fp.scale));
}

function unitFootprint(u) {
  const f = FP_FOOTPRINT[String(u.sizeCode || '').toUpperCase()];
  return f || { w: 3, h: 2 };
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
  fpToast('Canvas size must be a whole number between 1 and 500 grid units.', false);
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
    state.fp.canvasDefaults = body.canvasDefaults || { width: 20, height: 20 };
    state.fp.structure = body.plan ? body.plan.structure : null;
    state.fp.placements = fpNormalizePlacements(body.plan);
    state.fp.blocks = fpNormalizeBlocks(body.plan);
    state.fp.unplaced = (body.unplacedUnits || []).map(fpNormalizeUnit);
    state.fp.branchName = body.branch && body.branch.name;
    state.fp.floorName = body.floor ? `Level ${body.floor.level}` : '';
    state.fp.selected = null;
    state.fp.selectedBlock = null;
    state.fp.scale = 1;
    // A (re)load resets the live-typed canvas size back to server state, and
    // shrink-fits any placements/blocks the server may hold beyond a (possibly
    // just-saved, smaller) canvas so nothing renders off-grid.
    state.fp.liveDims = null;
    const d = fpCanvasDims();
    fpClampCanvasContent(d.w, d.h);
    fpRender();
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
          return `<div class="fp-unit-chip" data-unit-id="${escapeHtml(u.id)}" title="${escapeHtml(u.unitCode)} · ${u.sqft} sqft — drag onto the canvas">${escapeHtml(u.unitCode)}<div class="t-type">${escapeHtml(u.sizeName)} · ${u.sqft} sqft · ${fp.w}×${fp.h}</div></div>`;
        })
        .join('')
    : '<div class="fp-hint">No unplaced units on this floor.</div>';
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
  const statusDot = { OCCUPIED: '#0B4F5E', AVAILABLE: '#5A7A60', RESERVED: '#D4860A', OVERDUE: '#C0392B', MAINTENANCE: '#9C948D', INACTIVE: '#9C948D' };
  for (const pl of state.fp.placements) {
    const el = document.createElement('div');
    el.className = 'fp-placed' + (state.fp.selected === pl.unitId ? ' selected' : '');
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
      `<input type="text" id="fpBlockRename" class="tbl-search" maxlength="80" value="${escapeHtml(blk.name)}" style="width:150px;padding:3px 8px;font-size:10px;" placeholder="Rename block">` +
      `<button class="act-btn" id="fpBlockRenameBtn" style="padding:2px 9px;font-size:10px;">Rename</button>` +
      `<button class="act-btn danger" id="fpBlockRemoveBtn" style="padding:2px 9px;font-size:10px;">Remove block</button>`;
    return;
  }
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  if (!pl) {
    info.innerHTML = '';
    return;
  }
  info.innerHTML =
    `<span class="t-type">${escapeHtml(pl.unitCode)} · ${pl.x},${pl.y} · ${pl.width}×${pl.height}</span>` +
    `<button class="act-btn danger" id="fpRemoveBtn" style="padding:2px 9px;font-size:10px;">Remove from floor</button>`;
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
      ? `${unitLabel} placed · ${blockLabel} on a ${d.w}×${d.h} grid — drag to move, corner handle to resize`
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

async function fpPersist(pl, verb) {
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(pl.unitId)}`, {
      method: 'PUT',
      body: JSON.stringify({ x: pl.x, y: pl.y, width: pl.width, height: pl.height }),
    });
    fpToast(`${verb} ${pl.unitCode} → ${pl.x},${pl.y} · ${pl.width}×${pl.height}`, true);
  } catch (err) {
    fpToast(`${verb} ${pl.unitCode}: ${describeError(err)}`, false);
    await fpFetch(); // revert local state to what the server has
  }
}

async function fpPlaceUnit(unit, footprint, gx, gy) {
  const { w: cw, h: ch } = fpCanvasDims();
  if (footprint.w > cw || footprint.h > ch) {
    fpToast(`${unit.unitCode} (${footprint.w}×${footprint.h}) is too large for the ${cw}×${ch} canvas — enlarge the canvas first`, false);
    return;
  }
  const x = Math.min(Math.max(0, gx), cw - footprint.w);
  const y = Math.min(Math.max(0, gy), ch - footprint.h);
  try {
    await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(unit.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ x, y, width: footprint.w, height: footprint.h }),
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
    });
    fpToast(`Placed ${unit.unitCode} → ${x},${y} · ${footprint.w}×${footprint.h}`, true);
    fpRender();
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
  fpRenderCanvas();
  fpRenderSelInfo();
  const { w: cw, h: ch } = fpCanvasDims();
  const move = (ev) => {
    const cell = fpCanvasCellAt(ev.clientX - offsetX, ev.clientY - offsetY);
    if (!cell) return;
    pl.x = Math.min(Math.max(0, cell.gx), Math.max(0, cw - pl.width));
    pl.y = Math.min(Math.max(0, cell.gy), Math.max(0, ch - pl.height));
    fpRenderCanvas();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    fpPersist(pl, 'Moved');
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function fpStartResize(e, pl) {
  e.preventDefault();
  e.stopPropagation();
  if (state.fp.selected !== pl.unitId) {
    state.fp.selected = pl.unitId;
    state.fp.selectedBlock = null;
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
  const move = (ev) => {
    const dx = Math.round((ev.clientX - startX) / u);
    const dy = Math.round((ev.clientY - startY) / u);
    pl.width = Math.max(1, Math.min(origW + dx, cw - origX));
    pl.height = Math.max(1, Math.min(origH + dy, ch - origY));
    fpRenderCanvas();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    fpPersist(pl, 'Resized');
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function fpToggleBlockForm(show) {
  const form = $('#fpBlockForm');
  if (!form) return;
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
  } catch (err) {
    blk.name = prev;
    fpToast('Rename block: ' + describeError(err), false);
  }
}

async function fpRemoveBlock() {
  const blk = state.fp.blocks.find((b) => b.id === state.fp.selectedBlock);
  if (!blk) return;
  if (!window.confirm(`Remove block "${blk.name}" from the plan?`)) return;
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

async function fpSaveCanvas() {
  if (!state.fp.floorId) return;
  const w = Number($('#fpWidth').value);
  const h = Number($('#fpHeight').value);
  if (!Number.isInteger(w) || w < 1 || w > 500 || !Number.isInteger(h) || h < 1 || h > 500) {
    fpToast('Canvas size must be a whole number between 1 and 500 grid units.', false);
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
    fpToast(`Canvas saved (${w}×${h}).`, true);
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
  if (!window.confirm('Delete this floor plan and ALL unit placements on it? Units themselves are not affected.')) return;
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
  if (!window.confirm(`Remove ${pl.unitCode} from the floor plan? (The unit itself is unaffected.)`)) return;
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
  dims: { w: 20, h: 20 }, // plan grid size (plan dims, else canvas defaults)
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
  const defs = body.canvasDefaults || { width: 20, height: 20 };
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
  const statusDot = { OCCUPIED: '#0B4F5E', AVAILABLE: '#5A7A60', RESERVED: '#D4860A', OVERDUE: '#C0392B', MAINTENANCE: '#9C948D', INACTIVE: '#9C948D' };
  for (const pl of fpView.placements) {
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
  // Live canvas resizing: W/H edits re-render the canvas immediately (debounced
  // while typing); change/blur commits the typed value or reverts an invalid one.
  $('#fpWidth').addEventListener('input', fpOnDimInput);
  $('#fpHeight').addEventListener('input', fpOnDimInput);
  $('#fpWidth').addEventListener('change', fpOnDimCommit);
  $('#fpHeight').addEventListener('change', fpOnDimCommit);
  $('#fpWidth').addEventListener('keydown', fpOnDimEnter);
  $('#fpHeight').addEventListener('keydown', fpOnDimEnter);
  $('#fpZoomIn').addEventListener('click', () => {
    state.fp.scale = Math.min(3, state.fp.scale * 1.25);
    fpRenderCanvas();
  });
  $('#fpZoomOut').addEventListener('click', () => {
    state.fp.scale = Math.max(0.4, state.fp.scale / 1.25);
    fpRenderCanvas();
  });
  $('#fpPalette').addEventListener('pointerdown', (e) => {
    const chip = e.target.closest('.fp-unit-chip');
    if (!chip) return;
    fpStartPaletteDrag(e, chip);
  });
  $('#fpAddBlock').addEventListener('click', () => fpToggleBlockForm(true));
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
    // click on empty canvas → deselect
    state.fp.selected = null;
    state.fp.selectedBlock = null;
    fpRenderCanvas();
    fpRenderSelInfo();
  });
  $('#fpSelInfo').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'fpRemoveBtn') fpRemovePlacement();
    else if (e.target && e.target.id === 'fpBlockRemoveBtn') fpRemoveBlock();
    else if (e.target && e.target.id === 'fpBlockRenameBtn') fpRenameBlock();
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

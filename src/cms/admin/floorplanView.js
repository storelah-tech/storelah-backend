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
// Shared decimal-feet geometry (generated from src/core/planGeometry.ts — the
// API runs the same code; regenerate with `pnpm build:admin-geometry`).
import {
  AREA_TOLERANCE,
  DEFAULT_SNAP_FT,
  DEFAULT_WALL_THICKNESS_FT,
  LINE_KINDS,
  MAX_WALL_THICKNESS_FT,
  MIN_WALL_THICKNESS_FT,
  angleDeg,
  calibrateUnderlay,
  lineFeedsArea,
  nearestOnSegment,
  pointAtAngle,
  polylineLengthFt,
  segmentLengthFt,
  FINE_SNAP_FT,
  MIN_RECT_SIDE_FT,
  SNAP_STEPS_FT,
  areaDeviation,
  clampFt,
  fitSqftFootprint,
  formatFt,
  ftEquals,
  quantizeFt,
  rectAreaSqft,
  rectsOverlapExact,
  sameRect,
  snapFt,
  toMilli,
} from './planGeometry.js';

// Ref-data retry hook — the entry hands its loadRefs() down here so fpOpen()'s
// lazy guard keeps working without importing the entry.
let loadRefs = null;
export function setRefsLoader(fn) {
  loadRefs = fn;
}

// ---------- floor-plan constants & private module state ----------
const FP_BASE = 24; // px per foot at zoom 1 (BLUEPRINT SCALE: 1 grid unit = 1 ft)
let fpDimsTimer = null;

// ---------- toolbar groups (canonical order + audit) ----------
// The toolbar markup (#fpToolbar in dashboard.html) groups tools as
// units → mode → markers → canvas → plan → view → info. This registry is the single
// source of truth for that order (operator mental model: Units = unit
// placement (palette toggle adjacent to the palette, auto-place, rotate,
// sqft lock); Select/Draw = draw; Blocks = decoration blocks;
// Markers/Safety = markers; Labels/readouts = info; canvas + plan + view are
// the canvas-size, GFA and zoom chrome around them; save/delete plan actions
// live in the header with delete last).
// fpAuditToolbar() runs once at boot: every registered tool must exist, and
// every button inside #fpToolbar must be registered — an unregistered button
// is a future dead tool, so it warns instead of silently lingering. Audit is
// console-only and never blocks the editor.
const FP_TOOLBAR_GROUPS = [
  { id: 'units', label: 'Units', tools: ['fpPaletteReopen', 'fpAutoPlace', 'fpAutoDoors', 'fpUndoBtn', 'fpRedoBtn', 'fpRotateGhost', 'fpLockSqft', 'fpSizesBtn'] },
  // Studio ribbon: the Select/Add-Unit/Draw-Wall/Add-Block segmented control.
  // fpBoundaryTool (line tool) + fpAddBlock (block form) are the Draw/Block
  // segments — no duplicate buttons, one handler each.
  { id: 'mode', label: 'Mode', tools: ['fpModeSelect', 'fpModeAddUnit', 'fpNewUnitTool', 'fpBoundaryTool', 'fpMeasureTool', 'fpAddBlock'] },
  { id: 'markers', label: 'Markers/Safety', tools: ['fpMarkersBtn', 'fpMarkerTools'] },
  { id: 'canvas', label: 'Canvas', tools: ['fpWidth', 'fpHeight'] },
  { id: 'plan', label: 'Plan', tools: ['fpGfa', 'fpBoundaryMetrics'] },
  { id: 'view', label: 'View', tools: ['fpZoomOut', 'fpZoomIn', 'fpZoomPreset', 'fpGridToggle', 'fpSnapStep', 'fpObjSnap', 'fpLayersBtn', 'fpUnderlayBtn', 'fpUnderlayCalib', 'fpUnderlayMove', 'fpUnderlayRot', 'fpUnderlayRemove', 'fpExportBtn', 'fpExportGo', 'fpShortcutsBtn'] },
  { id: 'info', label: 'Labels', tools: ['fpSelInfo'] },
];

function fpAuditToolbar() {
  try {
    const bar = document.getElementById('fpToolbar');
    if (!bar) return;
    const known = new Set(FP_TOOLBAR_GROUPS.flatMap((g) => g.tools));
    for (const g of FP_TOOLBAR_GROUPS) {
      for (const id of g.tools) {
        if (!document.getElementById(id)) console.warn(`[floorplan] toolbar group "${g.id}" lists missing #${id}`);
      }
      const wrap = bar.querySelector(`[data-fp-group="${g.id}"]`);
      if (!wrap) console.warn(`[floorplan] toolbar markup is missing the "${g.id}" (${g.label}) group wrapper`);
    }
    for (const btn of bar.querySelectorAll('button[id]')) {
      if (!known.has(btn.id)) console.warn(`[floorplan] unregistered toolbar button #${btn.id} — register it in FP_TOOLBAR_GROUPS or remove it`);
    }
  } catch (err) {
    console.warn('[floorplan] toolbar audit failed', err);
  }
}

// ---------- safety/facility map markers (point icons) ----------
// Single source of truth for the Markers/Safety toolbar group: kind (persisted
// verbatim — must match FP_MARKER_KINDS in src/core/floorPlans.ts), operator
// label, toolbar/canvas icon, and badge ring tone. Distinct icon + label +
// tone per kind so markers are distinguishable at a glance.
const FP_MARKER_KINDS = [
  { kind: 'FIRE_EXTINGUISHER', label: 'Fire extinguisher', icon: '🧯', tone: '#C0392B' },
  { kind: 'DO_NOT_ENTER', label: 'Do not enter', icon: '⛔', tone: '#C0392B' },
  { kind: 'EXIT_SIGN', label: 'Exit sign', icon: '🚪', tone: '#1E8449' },
  { kind: 'FIRE_HOSE', label: 'Fire hose reel', icon: '💧', tone: '#2471A3' },
  { kind: 'FIRST_AID', label: 'First aid', icon: '⛑', tone: '#0E6655' },
  { kind: 'KEEP_CLEAR', label: 'Keep clear', icon: '🚫', tone: '#B7950B' },
];

function fpMarkerDef(kind) {
  return FP_MARKER_KINDS.find((m) => m.kind === kind) || { kind, label: String(kind), icon: '📍', tone: '#8a8478' };
}

function fpMarkerLabel(m) {
  const def = fpMarkerDef(m.kind);
  return m.label || def.label;
}

// ---------- block fill colours ----------
// Default palette offered in the block form + the selection strip, plus the
// fallback tone when a block has no persisted colour (== var(--line), the
// .fp-block CSS default, so unset blocks render exactly as before).
const FP_DEFAULT_BLOCK_COLOR = '#E6E0D7';
const FP_BLOCK_PALETTE = ['#E6E0D7', '#F7E2D7', '#DCE7DC', '#D7E3F0', '#F5E6B8', '#EFC9C0', '#D9CFBF', '#CBD5CB'];

function fpBlockFill(blk) {
  return (blk && blk.color) || FP_DEFAULT_BLOCK_COLOR;
}

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

// Decimal-foot footprint for a unit (fitSqftFootprint, shared with the API's
// sqftFootprint): live /sizes dims (widthFt/heightFt) → FP_SIZE_DIMS → the
// per-size aspect, scaled to the unit's exact sqft when the catalogue dims'
// area is off by more than AREA_TOLERANCE.
function sizeFootprint(sizeCode, sqft) {
  const code = String(sizeCode || '').toUpperCase();
  const live = (state.sizes || []).find((s) => String(s.code || '').toUpperCase() === code);
  // Size dims are decimal feet since the precision migration (src/core/planGeometry.ts).
  const dims =
    live && Number.isFinite(live.widthFt) && live.widthFt > 0 && Number.isFinite(live.heightFt) && live.heightFt > 0
      ? { w: live.widthFt, h: live.heightFt }
      : FP_SIZE_DIMS[code] || null;
  return fitSqftFootprint(Number(sqft) || 0, {
    widthFt: dims ? dims.w : null,
    heightFt: dims ? dims.h : null,
    fallbackAspect: FP_SIZE_ASPECT[code] || FP_DEFAULT_ASPECT,
  });
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
      const r = { x, y, width: w, height: h };
      if (!rectsOverlapExact(r, o)) return false; // integer-exact (milli-ft): touching decimal edges never collide
      if (sameRect(r, o) && (o.stackTier || 0) !== t) return false; // stacked pair shares one rect
      return true;
    }) || null
  );
}

// Stacking helpers: a stacked pair = two placements on the EXACT same rect
// with tiers 0 (lower/ground) + 1 (upper). Rendered as ONE block split by a
// middle divider line (upper code above, lower code below).
function fpSameRect(a, b) {
  return sameRect(a, b);
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
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(pl.unitId)}`, {
      method: 'PUT',
      body: JSON.stringify({ x: hit.x, y: hit.y, width: hit.width, height: hit.height, stackTier: 1 }),
    });
    pl.x = hit.x;
    pl.y = hit.y;
    pl.width = hit.width;
    pl.height = hit.height;
    pl.stackTier = 1;
    fpPushUndo({ kind: 'placement', unitId: pl.unitId, prev: null }); // undo = DELETE the stacked upper tier
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
    const k = [pl.x, pl.y, pl.width, pl.height].map(toMilli).join(',');
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

// ---------- decimal-feet snapping (precision Phase 2) ----------
// Every pointer→feet mapping snaps to the operator's snap step (toolbar
// #fpSnapStep, default 0.1 ft, remembered per browser). Holding Alt during a
// drag snaps to the fine 0.01 ft step instead. Values stay quantized to
// 0.001 ft (src/core/planGeometry.ts), so equality/overlap checks are exact.
const FP_SNAP_STORAGE_KEY = 'storelah.fp.snapStep';

function fpSnapStep(ev) {
  if (ev && ev.altKey) return FINE_SNAP_FT;
  const s = Number(state.fp.snapStep);
  return SNAP_STEPS_FT.includes(s) ? s : DEFAULT_SNAP_FT;
}

// Smallest side a resize may produce: the snap step, never below 0.1 ft.
function fpMinSide(ev) {
  return Math.max(MIN_RECT_SIDE_FT, fpSnapStep(ev));
}

function fpLoadSnapStep() {
  try {
    const v = Number(window.localStorage.getItem(FP_SNAP_STORAGE_KEY));
    if (SNAP_STEPS_FT.includes(v)) state.fp.snapStep = v;
  } catch (_) {
    // Storage blocked (private window) — keep the default step.
  }
}

function fpSetSnapStep(v) {
  const n = Number(v);
  state.fp.snapStep = SNAP_STEPS_FT.includes(n) ? n : DEFAULT_SNAP_FT;
  try {
    window.localStorage.setItem(FP_SNAP_STORAGE_KEY, String(state.fp.snapStep));
  } catch (_) {
    // Storage blocked — the choice still applies for this session.
  }
  const sel = $('#fpSnapStep');
  if (sel) sel.value = String(state.fp.snapStep);
  fpRenderCanvas(); // the minor grid follows the snap step
}

// Shift-constrained line end: 0°, 45° or 90° from the start point.
function fpConstrainLine(x1, y1, x2, y2, step) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > 2 * ay) return { x: x2, y: y1 };
  if (ay > 2 * ax) return { x: x1, y: y2 };
  const d = snapFt((ax + ay) / 2, step);
  return { x: quantizeFt(x1 + Math.sign(dx) * d), y: quantizeFt(y1 + Math.sign(dy) * d) };
}

// Square feet for display: at most 2 decimals, no float noise.
function fpFmtArea(sqft) {
  return (Math.round(Number(sqft || 0) * 100) / 100).toLocaleString('en-SG', { maximumFractionDigits: 2 });
}

// Decimal unit sizes — mirrors sqftForRect / sameSqft in src/core/unitSizing.ts:
// a drawn unit's sqft is its exact area to 0.01, and sizes within 0.05 sqft
// count as unchanged (absorbs the 0.001-ft geometry quantization).
const FP_SQFT_EPSILON = 0.05;
function fpSqftForRect(r) {
  return Math.round(rectAreaSqft(r) * 100) / 100;
}
function fpSameSqft(a, b) {
  return Math.abs(Number(a) - Number(b)) < FP_SQFT_EPSILON;
}

// ---------- drawn units (floor-plan unit sync Phase 4) ----------
// Mirrors of the server rules so the new-unit form can preview what the API
// will create: MARKET_PSF (src/core/market.ts), defaultRateFor and the
// nearest-tier rule resolveSizeTier (src/core/unitSizing.ts).
const FP_MARKET_PSF = { LOCKER: 5.2, SMALL: 4.8, MEDIUM: 4.4, LARGE: 3.8 };
function fpDefaultRate(sizeCode, sqft) {
  const psf = FP_MARKET_PSF[String(sizeCode || '').toUpperCase()] ?? Math.min(...Object.values(FP_MARKET_PSF));
  return Math.round(psf * sqft * 100) / 100;
}
function fpNearestTier(sqft, currentId) {
  const dist = (s) => (sqft < s.sqftFrom ? s.sqftFrom - sqft : sqft > s.sqftTo ? sqft - s.sqftTo : 0);
  const ranked = (state.sizes || [])
    .slice()
    .sort((a, b) => dist(a) - dist(b) || Number(b.id === currentId) - Number(a.id === currentId) || (a.sortOrder || 0) - (b.sortOrder || 0));
  return ranked.length ? { size: ranked[0], inBand: dist(ranked[0]) === 0 } : null;
}
function fpSizeIdByCode(code) {
  const s = (state.sizes || []).find((x) => String(x.code || '').toUpperCase() === String(code || '').toUpperCase());
  return s ? s.id : undefined;
}
// Creation spec of a DRAFT unit (what undo needs to re-create it after a
// discard). Specs typed in the new-unit form are kept per unit id; the rate
// is only replayed while the drawn size still matches the one it was typed for.
function fpDraftSpec(pl) {
  const kept = (state.fp.draftSpecs || {})[pl.unitId];
  const spec = {
    sizeId: fpSizeIdByCode(pl.sizeCode),
    name: pl.name && pl.name !== pl.unitCode ? pl.name : null,
    hasAC: !!pl.hasAC,
    hasPillar: !!pl.hasPillar,
  };
  if (kept && kept.monthlyRate != null && fpSameSqft(kept.sqft, pl.sqft)) {
    spec.monthlyRate = kept.monthlyRate;
  }
  return spec;
}
function fpIsDraftUnit(pl) {
  return String((pl && pl.status) || '').toUpperCase() === 'DRAFT';
}

// Live status readout at the right of the selection strip: cursor position
// while hovering, live position / size / length while dragging or drawing.
function fpSetReadout(text) {
  const el = $('#fpReadout');
  if (el) el.textContent = text || '';
}

// Hover readout: snapped cursor position + the active snap step.
function fpOnCanvasHover(e) {
  const canvas = $('#fpCanvas');
  if (!canvas || !canvas.contains(e.target)) return;
  if (state.fp.drawMode || state.fp.measureMode) {
    fpPenHover(e); // rubber band / measure / snap indicator own the readout
    return;
  }
  const p = fpCanvasPointAt(e.clientX, e.clientY, e);
  if (!p) return;
  fpSetReadout(`x ${formatFt(p.x)} · y ${formatFt(p.y)} ft · snap ${formatFt(fpSnapStep(e))} ft`);
}

// Door-edge markers (UI-visibility for authored doorEdges). Effective-edges
// rule (same as the selection strip + metrics bridge): the authored array when
// present, else all four edges as auto. Compass semantics: N = min-y edge
// (top), S = max-y (bottom), W = min-x (left), E = max-x (right) — a rotated
// (w/h swapped) rect keeps the same mapping since only the rect extents move.
// Returns a purely visual HTML string (pointer-events:none via .fp-door CSS)
// so drag/resize/hit-testing is untouched; tick thickness scales with px/ft
// `u`, lengths are % of the rect so they track zoom automatically.
function fpEffectiveDoors(pl) {
  const authored = Array.isArray(pl.doorEdges) && pl.doorEdges.length ? pl.doorEdges : null;
  return { edges: authored ? authored.slice() : ['N', 'S', 'E', 'W'], authored: !!authored };
}
function fpDoorMarkersHTML(pl, u) {
  const { edges, authored } = fpEffectiveDoors(pl);
  const t = Math.max(3, Math.round(u * 0.2));
  const tone = authored ? 'authored' : 'auto';
  const bits = [];
  if (edges.includes('N')) bits.push(`<div class="fp-door fp-door-n ${tone}" style="height:${t}px" aria-hidden="true"></div>`);
  if (edges.includes('S')) bits.push(`<div class="fp-door fp-door-s ${tone}" style="height:${t}px" aria-hidden="true"></div>`);
  if (edges.includes('W')) bits.push(`<div class="fp-door fp-door-w ${tone}" style="width:${t}px" aria-hidden="true"></div>`);
  if (edges.includes('E')) bits.push(`<div class="fp-door fp-door-e ${tone}" style="width:${t}px" aria-hidden="true"></div>`);
  return bits.join('');
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
    hasAC: u.hasAC === true,
    hasPillar: u.hasPillar === true,
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
    hasAC: p.unit.hasAC === true,
    hasPillar: p.unit.hasPillar === true,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    // Stacking tier: 0 = ground/sole tier, 1 = upper tier of a same-rect pair.
    stackTier: p.stackTier === 1 ? 1 : 0,
    // Authored door compass edges (editor N/S/E/W toggles); null = unauthored
    // (metrics falls back to AUTO_ALL_EDGES for this unit).
    doorEdges: Array.isArray(p.doorEdges) && p.doorEdges.length ? p.doorEdges.slice() : null,
    // Unit sync: drawn area ≠ unit sqft — the unit's size updates on publish.
    areaDirty: p.areaDirty === true,
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

// Safety/facility point icons as { id, kind, label|null, x, y } — mirrors
// serializeMarker() in src/core/floorPlans.ts (keep the two in sync).
function fpNormalizeMarkers(plan) {
  return (plan && plan.markers ? plan.markers : []).map((m) => ({
    id: m.id,
    kind: m.kind,
    label: m.label || null,
    x: m.x,
    y: m.y,
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
    // Decimal-ft vertices are valid (0.001 ft precision) — never drop them on read.
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([x, y]);
  }
  return out;
}

function fpNormalizeBoundaries(plan) {
  return (plan && plan.boundaries ? plan.boundaries : []).map(fpNormalizeBoundary);
}

// ---------- marked-area metrics parity (client mirror of computeBoundaryMetrics) ----------
// MARKED-AREA RULE (keep in sync with src/core/floorPlans.ts): every polyline
// with >= 3 vertices and nonzero shoelace area contributes its chord-closed
// area (closed loops and open >= 3-vertex polylines alike), plus stitched
// rings chained from endpoint-connected leftover strokes (so a loop drawn as
// separate 2-vertex sides counts); a lone open 2-vertex segment encloses no
// area and contributes 0 — never fabricated. UFA = marked
// gross minus block + solid-structure rects; NLA = placement footprints
// clipped to the marked loops minus the loop-clipped blocked area (same
// blocked total as UFA, once per loop so stacked tiers don't subtract twice),
// floored at 0 per loop; blockAreaSqft = loop-clipped BLOCK rects only
// (solid structure excluded); clamps ≥ 0,
// NLA ≤ UFA, 1dp. No contributing line → all-zero + boundaryClosed: false.
function fpPolygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

// Exact rect∩polygon area: clip the polygon to the rect (Sutherland–Hodgman)
// then shoelace. Mirrors rectPolygonArea() in src/core/floorPlans.ts.
function fpRectPolygonArea(rect, polygon) {
  let pts = polygon.map(([x, y]) => [x, y]);
  if (pts.length < 3) return 0;
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.width;
  const y1 = rect.y + rect.height;
  const clip = (input, inside, cross) => {
    const out = [];
    if (!input.length) return out;
    let s = input[input.length - 1];
    for (const e of input) {
      const eIn = inside(e);
      const sIn = inside(s);
      if (eIn) {
        if (!sIn) out.push(cross(s, e));
        out.push(e);
      } else if (sIn) {
        out.push(cross(s, e));
      }
      s = e;
    }
    return out;
  };
  pts = clip(pts, (p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0] || 1e-9)]);
  pts = clip(pts, (p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0] || 1e-9)]);
  pts = clip(pts, (p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1] || 1e-9), y0]);
  pts = clip(pts, (p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1] || 1e-9), y1]);
  return fpPolygonArea(pts);
}

const fpRound1 = (v) => Math.round(v * 10) / 10;

// Stitch endpoint-connected boundary polylines into longer chains. Mirrors
// chainBoundarySegments() in src/core/floorPlans.ts — keep the two in sync
// (see its doc comment for the full contract: shared exact integer endpoints
// join in either orientation until fixpoint, closed chains are final,
// zero-length polylines skipped, deterministic input order).
function fpChainBoundarySegments(segments) {
  const key = (p) => `${p[0]},${p[1]}`;
  const chains = [];
  for (const seg of segments || []) {
    const pts = seg.map(([x, y]) => [x, y]);
    if (pts.length < 2) continue;
    if (!pts.some(([x, y]) => x !== pts[0][0] || y !== pts[0][1])) continue;
    chains.push(pts);
  }
  const isClosed = (c) => c.length >= 2 && key(c[0]) === key(c[c.length - 1]);
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < chains.length && !merged; i++) {
      if (isClosed(chains[i])) continue;
      for (let j = 0; j < chains.length && !merged; j++) {
        if (i === j || isClosed(chains[j])) continue;
        const a = chains[i];
        const b = chains[j];
        let joined = null;
        if (key(a[a.length - 1]) === key(b[0])) joined = [...a, ...b.slice(1)];
        else if (key(a[a.length - 1]) === key(b[b.length - 1])) joined = [...a, ...b.slice(0, -1).reverse()];
        else if (key(a[0]) === key(b[b.length - 1])) joined = [...b, ...a.slice(1)];
        else if (key(a[0]) === key(b[0])) joined = [...b.slice(0, -1).reverse(), ...a];
        if (joined) {
          chains[i] = joined;
          chains.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return chains;
}

function fpBoundaryMetricsLocal() {
  const validated = (state.fp.boundaries || [])
    .filter((b) => lineFeedsArea(b.kind)) // WALL / PARTITION / GUIDE never mark area
    .map((b) => fpBoundaryPoints(b.points))
    .filter((pts) => pts.length >= 2 && pts.some(([x, y]) => x !== pts[0][0] || y !== pts[0][1]));
  const direct = validated.filter((pts) => pts.length >= 3 && fpPolygonArea(pts) > 0);
  const leftover = validated.filter((pts) => !(pts.length >= 3 && fpPolygonArea(pts) > 0));
  const stitched = fpChainBoundarySegments(leftover).filter((pts) => pts.length >= 3 && fpPolygonArea(pts) > 0);
  const loops = [...direct, ...stitched];
  const gfa = state.fp.gfa;
  const gfaSource = gfa != null ? 'USER' : 'CANVAS';
  if (!loops.length) {
    return { gla: 0, ufa: 0, nla: 0, unit: 'sqft', boundaryClosed: false, facilityAreaSqft: 0, blockAreaSqft: 0, gfaSqft: gfa, gfaSource };
  }
  const obstacles = (state.fp.blocks || []).concat(fpStructureRects());
  let gla = 0;
  let ufa = 0;
  let nla = 0;
  let blockArea = 0;
  for (const loop of loops) {
    const gross = fpPolygonArea(loop);
    gla += gross;
    const blocked = obstacles.reduce((sum, r) => sum + fpRectPolygonArea(r, loop), 0);
    ufa += Math.max(0, gross - blocked);
    // NLA subtracts the FULL loop-clipped blocked total once per loop (same
    // `blocked` as UFA — blocks + solid structure), so stacked locker tiers
    // don't subtract twice. Pillars subtract additionally (NLA only):
    // loop-clipped hasPillar-unit footprints (Pillar blocks already ride in
    // `blocked` via state.fp.blocks) — mirrors the `pillarRects` input to
    // computeBoundaryMetrics in src/core/floorPlans.ts.
    const placementsInLoop = (state.fp.placements || []).reduce((sum, r) => sum + fpRectPolygonArea(r, loop), 0);
    const pillarBlocked = (state.fp.placements || [])
      .filter((r) => r.hasPillar === true)
      .reduce((sum, r) => sum + fpRectPolygonArea(r, loop), 0);
    nla += Math.max(0, placementsInLoop - blocked - pillarBlocked);
    // Loop-clipped BLOCK rects only (solid structure excluded); SUM may
    // double-count overlapping blocks (non-overlapping assumption, no dedupe).
    blockArea += (state.fp.blocks || []).reduce((sum, r) => sum + fpRectPolygonArea(r, loop), 0);
  }
  const ufaClamped = Math.max(0, ufa);
  const glaRounded = fpRound1(Math.max(0, gla));
  return {
    gla: glaRounded,
    ufa: fpRound1(ufaClamped),
    nla: fpRound1(Math.min(Math.max(0, nla), ufaClamped)),
    unit: 'sqft',
    boundaryClosed: true,
    facilityAreaSqft: glaRounded,
    blockAreaSqft: fpRound1(Math.max(0, blockArea)),
    gfaSqft: gfa,
    gfaSource,
  };
}

const fpFmt1 = (n) => Number(n || 0).toLocaleString('en-SG', { maximumFractionDigits: 1 });

// Toolbar strip showing the live marked-area UFA/NLA (parity preview of the
// server boundaryMetrics on plan reads). Explicit "no marked area" state —
// never fabricated.
function fpRenderBoundaryMetrics() {
  const el = $('#fpBoundaryMetrics');
  if (!el) return;
  const mm = fpBoundaryMetricsLocal();
  el.textContent = mm.boundaryClosed
    ? `Marked ${fpFmt1(mm.facilityAreaSqft)} sqft · Blocks ${fpFmt1(mm.blockAreaSqft)} · UFA ${fpFmt1(mm.ufa)} · NLA ${fpFmt1(mm.nla)}`
    : 'No marked area — draw a line (3+ vertices, then close the loop) to measure UFA/NLA';
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

// Canvas dims are decimal feet in [1, 500], quantized to 0.001 ft (same
// contract as checkCanvasDim in src/core/floorPlans.ts).
function fpParseDim(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const q = quantizeFt(n);
  return q >= 1 && q <= 500 ? q : null;
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

// Operator-entered GFA field: server state wins except while the operator is
// typing (focused) — "Save Canvas" is the explicit commit that persists it.
// Empty = unset (metrics fall back to the canvas rect).
function fpSyncGfaInput() {
  const el = $('#fpGfa');
  if (!el) return;
  if (document.activeElement === el) return;
  el.value = state.fp.gfa != null ? String(state.fp.gfa) : '';
}

function fpParseGfa(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return { ok: true, value: null }; // empty clears back to unset
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > 10000000) return { ok: false, value: null };
  return { ok: true, value: Math.round(n * 10) / 10 };
}

function fpClampCanvasContent(w, h) {
  const clampItem = (item) => {
    item.width = clampFt(item.width, MIN_RECT_SIDE_FT, w);
    item.height = clampFt(item.height, MIN_RECT_SIDE_FT, h);
    item.x = clampFt(item.x, 0, w - item.width);
    item.y = clampFt(item.y, 0, h - item.height);
  };
  state.fp.placements.forEach(clampItem);
  state.fp.blocks.forEach(clampItem);
  // Marker points clamp edge-INCLUSIVE (0..w / 0..h — the same contract as
  // checkMarkerPoint in src/core/floorPlans.ts).
  (state.fp.markers || []).forEach((m) => {
    m.x = clampFt(m.x, 0, w);
    m.y = clampFt(m.y, 0, h);
  });
  // Boundary vertices clamp edge-INCLUSIVE (0..w / 0..h — the same contract as
  // checkBoundaryPoints in src/core/floorPlans.ts) so drawn lines never render
  // off-grid after a canvas shrink.
  (state.fp.boundaries || []).forEach((b) => {
    b.points = fpBoundaryPoints(b.points).map(([x, y]) => [clampFt(x, 0, w), clampFt(y, 0, h)]);
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
  fpToast('Canvas size must be a number between 1 and 500 feet (decimals allowed).', false);
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
  fpStudioToast(msg, ok);
  clearTimeout(fpToast._t);
  fpToast._t = setTimeout(() => {
    b.hidden = true;
    b.textContent = '';
  }, 6000);
}

function fpZoomLabel() {
  const el = $('#fpZoomLbl');
  if (el) el.textContent = Math.round(state.fp.scale * 100) + '%';
  // Keep the Studio zoom-preset dropdown truthful: show the matching preset,
  // otherwise fall back to the neutral "Zoom" placeholder.
  const preset = $('#fpZoomPreset');
  if (preset) {
    const cur = String(state.fp.scale);
    preset.value = ['0.5', '0.75', '1', '1.5'].includes(cur) ? cur : 'custom';
  }
}

// Fit Canvas preset: scale the board to the visible stage, honouring the
// shared 0.4–3x clamp so zoom behaviour stays identical everywhere.
function fpZoomFit() {
  const wrap = $('#fpCanvasWrap');
  const stage = $('#fpStage');
  const d = fpCanvasDims();
  if (!wrap || !(d.w > 0) || !(d.h > 0)) return;
  // Measure the stage viewport — the wrap shrink-wraps its content, so fitting
  // against the wrap's own size is circular. Subtract the real chrome: stage
  // padding (26px vertical / 18px horizontal) + wrap padding/border (12px +
  // 1px per side) + a breathing margin, so the fitted board never hides its
  // first/last row/column under padding or scrollbars.
  const vw = (stage && stage.clientWidth) || wrap.clientWidth || 800;
  const vh = (stage && stage.clientHeight) || wrap.clientHeight || 480;
  const availW = Math.max(160, vw - 80);
  const availH = Math.max(160, vh - 120);
  state.fp.scale = Math.min(3, Math.max(0.4, Math.min(availW / (d.w * FP_BASE), availH / (d.h * FP_BASE))));
  fpRenderCanvas(); // re-renders the canvas and refreshes the zoom label
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
  // Level selectors show ACTIVE floors only (inactive = hidden from booking;
  // reactivate via the Floors management list). The in-flight selection is
  // preserved (labelled) so deactivating mid-edit never strands the editor.
  const floors = state.floors
    .filter((f) => f.branchId === b?.id && f.isActive !== false)
    .sort((a, c) => a.level - c.level);
  const sel = $('#fpFloor');
  if (!sel) return;
  const current = state.fp.floorId ? state.floors.find((f) => f.id === state.fp.floorId) : null;
  const rows = current && current.branchId === b?.id && current.isActive === false && !floors.some((f) => f.id === current.id)
    ? [...floors, current].sort((a, c) => a.level - c.level)
    : floors;
  sel.innerHTML = rows
    .map((f) => `<option value="${escapeHtml(f.id)}">Level ${f.level} — ${escapeHtml(f.name)}${f.isActive === false ? ' (inactive)' : ''}</option>`)
    .join('');
  if (state.fp.floorId && rows.some((f) => f.id === state.fp.floorId)) sel.value = state.fp.floorId;
  else if (rows.length) {
    sel.value = rows[0].id;
    state.fp.floorId = rows[0].id;
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
    fpFetchDrafts().catch(() => {});
    return;
  }
  try {
    const body = await get(`/floor-plans/${encodeURIComponent(state.fp.floorId)}`);
    fpApplyPlanPayload(body, false); // full reload: selection, zoom and undo reset
    // A (re)load shows the live plan — no draft version is loaded anymore and
    // the canvas matches the server (unsaved-changes guard resets).
    fpSetLoadedDraft(null);
    fpCanvasDirty = false;
    // A (re)load resets the live-typed canvas size back to server state, and
    // shrink-fits any placements/blocks the server may hold beyond a (possibly
    // just-saved, smaller) canvas so nothing renders off-grid.
    state.fp.liveDims = null;
    const d = fpCanvasDims();
    fpClampCanvasContent(d.w, d.h);
    fpRender();
    fpRenderMarkerTools();
    fpSetPaletteCollapsed(false);
    notifyMetricsFloorChanged();
    fpFetchDrafts().catch(() => {});
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

// Floor Plan Library tab (facility-floorplan-library): drafts-only view over the
// same GET /floor-plans/:floorId/drafts summaries the Designer used — no new
// endpoint, no canvas/live-plan fetch. Reuses the Designer facility/floor
// selector state (no duplicate selectors); Save-as-draft/Publish/live-plan
// flows stay on the Designer tab. Lazy-load entry called from the admin.js
// facility-tab handler on every visit (promo-library pattern).
export async function fpOpenLibrary() {
  if (!state.branches.length || !state.floors.length) await loadRefs();
  if (!state.fp.floorId) {
    const floors = branchFloors(state.fp.branchCode);
    state.fp.floorId = floors[0]?.id || null;
  }
  fpPopulateSelects();
  await fpFetchDrafts();
}

function fpRenderPalette() {
  const list = $('#fpPalette');
  const sub = $('#fpPaletteSub');
  if (!list) return;
  // Designer palette AC filter (All / AC / Non-AC): client-side narrowing of
  // the unplaced list; mirrors ?hasAC= on GET /units and /units/map.
  const visible = (state.fp.unplaced || []).filter((u) => {
    if (fpAcFilter === 'ac') return u.hasAC === true;
    if (fpAcFilter === 'nonac') return u.hasAC !== true;
    return true;
  });
  const acSel = $('#fpAcFilter');
  if (acSel && acSel.value !== fpAcFilter) acSel.value = fpAcFilter;
  if (sub) {
    const total = state.fp.placements.length + state.fp.unplaced.length;
    const acNote = fpAcFilter === 'ac' ? ' · AC only' : fpAcFilter === 'nonac' ? ' · Non-AC only' : '';
    sub.textContent = state.fp.unplaced.length
      ? `${visible.length} of ${state.fp.unplaced.length} unplaced${acNote} · drag onto the canvas`
      : total
        ? 'All units on this floor are placed — click a unit to move/resize/remove'
        : 'No units on this floor yet.';
  }
  list.innerHTML = state.fp.unplaced.length
    ? (visible.length
      ? visible
        .map((u) => {
          const fp = unitFootprint(u);
          return `<div class="fp-unit-chip" data-unit-id="${escapeHtml(u.id)}" title="${escapeHtml(u.unitCode)} · ${u.sqft} sqft — drag onto the canvas">${escapeHtml(u.unitCode)}<div class="t-type">${escapeHtml(u.sizeName)} · ${u.sqft} sqft · ${fp.w}×${fp.h} ft</div></div>`;
        })
        .join('')
      : '<div class="fp-hint">No unplaced units match this AC filter.</div>')
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

// Palette auto-collapse policy: the unplaced-units palette collapses ONLY on
// an explicit toggle (fpPaletteToggle / fpPaletteReopen) or a successful
// palette drop (place, stack-drop, auto-place-all). Selecting, moving,
// resizing or removing a PLACED unit must never collapse it — those paths
// deliberately never call fpSetPaletteCollapsed. Drop-success sites collapse
// via fpCollapsePaletteAfterDrop() so the audit stays greppable.
function fpCollapsePaletteAfterDrop() {
  fpSetPaletteCollapsed(true);
}

// ---------- undo stack (drawn objects: lines/blocks/markers + placements) ----------
// LIFO inverse ops (cap 50, cleared on floor switch/reload). Undo replays via
// the existing DELETE/PUT APIs (never raw state surgery): a null `prev`
// means "this write created the row" → undo DELETEs it; otherwise the stored
// snapshot is PUT back. Remove already works through the same endpoints.
const fpUndoStack = [];
function fpPushUndo(entry) {
  if (!entry || !entry.kind) return;
  fpUndoStack.push(entry);
  if (fpUndoStack.length > FP_UNDO_LIMIT) fpUndoStack.shift();
  fpRedoStack.length = 0; // a new action invalidates the redo branch
  fpSyncUndoButtons();
}
function fpClearUndo() {
  fpUndoStack.length = 0;
  fpRedoStack.length = 0;
  fpSyncUndoButtons();
}
function fpUndoDepth() {
  return fpUndoStack.length;
}
// ---------- occupied edit lock (live plans) ----------
// Mirrors assertPlacementEditable() in src/core/floorPlans.ts: when the plan
// is ACTIVE, OCCUPIED/OVERDUE placements are uneditable (no drag/resize/
// rename/delete). Callers show the "Occupied — uneditable when live" tooltip
// and toast instead of attempting the write (the server still 409s).
function fpIsOccupiedLocked(pl) {
  if (!pl) return false;
  const live = state.fp.plan && String(state.fp.plan.status || '').toUpperCase() === 'ACTIVE';
  if (!live) return false;
  const st = String(pl.status || '').toUpperCase();
  return st === 'OCCUPIED' || st === 'OVERDUE';
}
function fpLockedTooltip(pl) {
  return `${pl.unitCode} · ${pl.status} — Occupied — uneditable when live`;
}
function fpGuardLocked(pl) {
  if (fpIsOccupiedLocked(pl)) {
    fpToast(`${pl.unitCode}: Occupied — uneditable when live.`, false);
    return true;
  }
  return false;
}

// ---------- unit-tile status colour (floor-plan palette) ----------
// Status dots use the booking floor-plan edge tones so the editor matches
// the live plan: AVAILABLE #2E6B46, RESERVED #F57F17, OCCUPIED/OVERDUE/
// MAINTENANCE/INACTIVE/BLOCKED collapse to unavailable #332B24.
// Unknown/blank statuses fall back to AVAILABLE green — never grey.
const FP_STATUS_COLORS = {
  OCCUPIED: '#332B24',
  AVAILABLE: '#2E6B46',
  RESERVED: '#F57F17',
  OVERDUE: '#332B24',
  MAINTENANCE: '#332B24',
  INACTIVE: '#332B24',
  BLOCKED: '#332B24',
  DRAFT: '#9A4A33', // drawn, not published — never "available" green
};
function fpStatusColor(status) {
  return FP_STATUS_COLORS[String(status || '').toUpperCase()] || FP_STATUS_COLORS.AVAILABLE;
}

// ---------- corridor → door inference (auto-doors mirror) ----------
// Mirrors inferDoorEdges()/isCorridorLikeBlock() in src/core/floorPlans.ts:
// any placement edge adjacent (within 1 grid unit) to a block named
// Corridor/Aisle (case-insensitive) or derived circulation (walkway/passage/
// lobby/entrance/exit) gets that door edge. Manual N/S/E/W toggles always win
// — fpAutoDoors() only authors unauthored placements.
const FP_CORRIDOR_LIKE_RE = /(corridor|aisle|walkway|passage|lobby|entrance|exit)/i;
function fpIsCorridorLike(name) {
  return FP_CORRIDOR_LIKE_RE.test(String(name || '').trim());
}
function fpInferDoorEdges(rect, blocks) {
  const corridors = (blocks || []).filter((b) => fpIsCorridorLike(b && b.name));
  if (!corridors.length) return [];
  const spansOverlap = (a0, a1, b0, b1, tol) => a0 - tol < b1 && b0 - tol < a1;
  const north = rect.y;
  const south = rect.y + rect.height;
  const west = rect.x;
  const east = rect.x + rect.width;
  const adjacent = (edge) =>
    corridors.some((b) => {
      const bN = b.y;
      const bS = b.y + b.height;
      const bW = b.x;
      const bE = b.x + b.width;
      if (edge === 'N') return Math.abs(north - bS) <= 1 && spansOverlap(west, east, bW, bE, 1);
      if (edge === 'S') return Math.abs(south - bN) <= 1 && spansOverlap(west, east, bW, bE, 1);
      if (edge === 'W') return Math.abs(west - bE) <= 1 && spansOverlap(north, south, bN, bS, 1);
      return Math.abs(east - bW) <= 1 && spansOverlap(north, south, bN, bS, 1);
    });
  return ['N', 'S', 'E', 'W'].filter(adjacent);
}

// Auto-doors: infer corridor-adjacent edges for every unauthored placement
// and persist via the existing placement PUT (doorEdges). Authored placements
// (manual N/S/E/W toggles) are never overwritten; occupied-locked placements
// are skipped (the server would 409).
async function fpAutoDoors() {
  if (!state.fp.floorId) return;
  const authored = (state.fp.placements || []).filter((p) => Array.isArray(p.doorEdges) && p.doorEdges.length);
  let applied = 0;
  let skippedAuthored = authored.length;
  let skippedLocked = 0;
  let noCorridor = 0;
  for (const pl of state.fp.placements || []) {
    if (Array.isArray(pl.doorEdges) && pl.doorEdges.length) continue;
    if (fpIsOccupiedLocked(pl)) {
      skippedLocked += 1;
      continue;
    }
    const inferred = fpInferDoorEdges(pl, state.fp.blocks || []);
    if (!inferred.length) {
      noCorridor += 1;
      continue;
    }
    try {
      const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(pl.unitId)}`, {
        method: 'PUT',
        body: JSON.stringify({ x: pl.x, y: pl.y, width: pl.width, height: pl.height, stackTier: pl.stackTier || 0, doorEdges: inferred }),
      });
      pl.doorEdges = res && res.data ? res.data.doorEdges : inferred;
      fpPushUndo({ kind: 'placement', unitId: pl.unitId, prev: { x: pl.x, y: pl.y, width: pl.width, height: pl.height, stackTier: pl.stackTier || 0, doorEdges: null } });
      applied += 1;
    } catch (err) {
      fpToast(`Auto-doors ${pl.unitCode}: ${describeError(err)}`, false);
    }
  }
  fpRender();
  notifyMetricsFloorChanged();
  const bits = [`${applied} unit${applied === 1 ? '' : 's'} auto-doored`];
  if (skippedAuthored) bits.push(`${skippedAuthored} manual kept`);
  if (skippedLocked) bits.push(`${skippedLocked} occupied locked`);
  if (noCorridor) bits.push(`${noCorridor} no corridor adjacent`);
  fpToast(`Auto-doors: ${bits.join(' · ')}.`, applied > 0);
}

// Designer palette AC filter (All / AC / Non-AC): client-side narrowing of
// the unplaced-units palette; mirrors ?hasAC= on GET /units and /units/map.
let fpAcFilter = '';
function fpSetAcFilter(v) {
  fpAcFilter = v === 'ac' ? 'ac' : v === 'nonac' ? 'nonac' : '';
  fpRenderPalette();
  fpRender();
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
// polylines as SOLID <polyline>s (persisted lines are never dashed — only the
// in-flight pencil draft previews dashed). Reused by the editor canvas AND the
// read-only fpView canvas.
// Pencil lines (kind 'PENCIL') only show their label while selected.
//
// Usable-area preview (auto-place interior): the_fpUsablePlaceArea_ interior
// derived from these same rows renders FIRST (under the strokes) — stitched
// loop interiors as a translucent wash, or the open-lines fallback box as a
// dashed amber rect. The operator therefore SEES what "inside the boundary
// lines" means before pressing auto-place: units will only ever land in the
// washed region, and the amber box says "close the loop for exact interior
// placement" without a toast round-trip.
function fpRenderBoundaryLayer(canvas, u, dims, boundaries, withOverlay, selectedId) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'fp-boundary-layer');
  svg.setAttribute('width', String(dims.w * u));
  svg.setAttribute('height', String(dims.h * u));
  svg.setAttribute('viewBox', `0 0 ${dims.w * u} ${dims.h * u}`);
  const usable = fpUsablePlaceArea(boundaries || []);
  if (usable) {
    if (usable.kind === 'loops') {
      for (const poly of usable.polys) {
        const el = document.createElementNS(SVG_NS, 'polygon');
        el.setAttribute('points', poly.map(([x, y]) => `${x * u},${y * u}`).join(' '));
        el.setAttribute('class', 'fp-usable-fill');
        svg.appendChild(el);
      }
    } else {
      const { x0, y0, x1, y1 } = usable.bbox;
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', String(x0 * u));
      el.setAttribute('y', String(y0 * u));
      el.setAttribute('width', String(Math.max(0, x1 - x0) * u));
      el.setAttribute('height', String(Math.max(0, y1 - y0) * u));
      el.setAttribute('class', 'fp-usable-bbox');
      svg.appendChild(el);
    }
  }
  const addShape = (points, closed, cls) => {
    const el = document.createElementNS(SVG_NS, closed ? 'polygon' : 'polyline');
    el.setAttribute('points', points.map(([x, y]) => `${x * u},${y * u}`).join(' '));
    el.setAttribute('class', cls);
    svg.appendChild(el);
  };
  for (const b of boundaries || []) {
    const pts = fpBoundaryPoints(b.points);
    if (pts.length < 2) continue;
    // Line kinds: BOUNDARY/PENCIL = wall marking area; PARTITION = interior
    // wall (same line, lighter, no area wash); legacy WALL = band of
    // `thickness` ft; legacy GUIDE = dotted construction line.
    const kind = String(b.kind || '').toUpperCase();
    const kindCls = kind === 'WALL' ? ' wall' : kind === 'PARTITION' ? ' partition' : kind === 'GUIDE' ? ' guide' : '';
    addShape(pts, b.closed, 'fp-boundary' + kindCls + (b.closed && !kindCls ? '' : ' open') + (b.id && b.id === selectedId ? ' selected' : ''));
    if (kind === 'WALL') svg.lastChild.style.strokeWidth = Math.max(2, (b.thickness || DEFAULT_WALL_THICKNESS_FT) * u) + 'px';
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
  if (withOverlay) {
    fpRenderPenOverlay(svg, u);
    fpRenderCalibOverlay(svg, u);
  }
  canvas.appendChild(svg);
}

// Corner tags on unit tiles: NEW = DRAFT unit (drawn, not yet published);
// Δ = drawn size differs from the unit's sqft and updates on publish.
function fpUnitTagsHTML(...units) {
  const draft = units.some(fpIsDraftUnit);
  const dirty = units.filter((x) => x && x.areaDirty);
  let html = '';
  if (draft) html += '<div class="fp-tag fp-tag-new" title="New unit — not published yet; publish the plan to make it available">NEW</div>';
  if (dirty.length) {
    const d = dirty[0];
    html += `<div class="fp-tag fp-tag-dirty" title="${escapeHtml(d.unitCode)}: drawn ${fpFmtArea(fpSqftForRect(d))} sqft, unit ${fpFmtArea(d.sqft)} sqft — updates on publish">Δ</div>`;
  }
  return html;
}

function fpRenderCanvas() {
  const canvas = $('#fpCanvas');
  if (!canvas) return;
  const { w, h } = fpCanvasDims();
  const u = fpPx();
  canvas.style.width = w * u + 'px';
  canvas.style.height = h * u + 'px';
  // Adaptive grid (decimal-feet Phase 2): 1-ft lines (the original grid),
  // darker 10-ft majors, and faint snap-step minors once they are >= 6px apart
  // so sub-foot snapping is visible when zoomed in. Studio grid toggle off
  // removes every layer (state.fp.showGrid, default true).
  if (state.fp.showGrid === false) {
    canvas.style.backgroundImage = 'none';
  } else {
    const layers = [];
    const sizes = [];
    const line = (color, px) => {
      layers.push(`linear-gradient(${color} 1px,transparent 1px)`, `linear-gradient(90deg,${color} 1px,transparent 1px)`);
      sizes.push(`${px}px ${px}px`, `${px}px ${px}px`);
    };
    line('rgba(51,43,36,0.22)', u * 10);
    line('var(--line)', u);
    const minor = fpSnapStep() * u;
    if (fpSnapStep() < 1 && minor >= 6) line('rgba(51,43,36,0.06)', minor);
    canvas.style.backgroundImage = layers.join(',');
    canvas.style.backgroundSize = sizes.join(',');
  }
  canvas.innerHTML = '';
  fpRenderUnderlay(canvas, u); // tracing image sits under everything (first child)
  fpRenderStructure(canvas, u);
  fpRenderBoundaryLayer(canvas, u, fpCanvasDims(), fpLayerHidden('lines') ? [] : state.fp.boundaries || [], true, state.fp.selectedBoundary);
  // Decoration blocks — BELOW units in z-order (blocks z-index 1, units 2).
  // Fill falls back to FP_DEFAULT_BLOCK_COLOR (== the .fp-block CSS tone) when
  // the block has no persisted colour, so unset blocks render exactly as before.
  for (const blk of fpLayerHidden('blocks') ? [] : state.fp.blocks) {
    const el = document.createElement('div');
    el.className = 'fp-block' + (state.fp.selectedBlock === blk.id || fpInMulti('block', blk.id) ? ' selected' : '');
    el.dataset.blockId = blk.id;
    el.style.left = blk.x * u + 'px';
    el.style.top = blk.y * u + 'px';
    el.style.width = blk.width * u + 'px';
    el.style.height = blk.height * u + 'px';
    el.style.background = fpBlockFill(blk);
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
  const statusDot = null; // retired: tile colours come from fpStatusColor() (no grey unknown fallback)
  // Stacked pairs (same rect, tiers 0 + 1) render as ONE block split by a
  // middle divider line: upper unit code above, lower code below.
  for (const group of fpGroupByRect(fpLayerHidden('units') ? [] : state.fp.placements)) {
    const r = group.rect;
    if (group.members.length >= 2) {
      const lower = group.members[0];
      const upper = group.members[1];
      const el = document.createElement('div');
      const selected = state.fp.selected === lower.unitId || state.fp.selected === upper.unitId || fpInMulti('placement', lower.unitId) || fpInMulti('placement', upper.unitId);
      el.className = 'fp-placed fp-stacked' + (selected ? ' selected' : '') + (fpIsDraftUnit(lower) || fpIsDraftUnit(upper) ? ' fp-draft' : '');
      el.dataset.unitId = lower.unitId;
      el.dataset.stackMateId = upper.unitId;
      el.style.left = r.x * u + 'px';
      el.style.top = r.y * u + 'px';
      el.style.width = r.width * u + 'px';
      el.style.height = r.height * u + 'px';
      el.title = (fpIsOccupiedLocked(lower) || fpIsOccupiedLocked(upper))
        ? `Stacked pair — upper ${upper.unitCode} (${upper.status}) / lower ${lower.unitCode} (${lower.status}) — Occupied — uneditable when live`
        : `Stacked pair — upper ${upper.unitCode} (${upper.status}) / lower ${lower.unitCode} (${lower.status}) · doors auto (stacked pairs stay AUTO)`;
      el.innerHTML =
        `<div class="fp-status" style="background:${fpStatusColor(lower.status)};"></div>` +
        `<div class="fp-code fp-stack-upper">${escapeHtml(upper.unitCode)}</div>` +
        `<div class="fp-stack-divider"></div>` +
        `<div class="fp-code fp-stack-lower">${escapeHtml(lower.unitCode)}</div>` +
        fpUnitTagsHTML(lower, upper) +
        fpDoorMarkersHTML({ doorEdges: null }, u) +
        ((fpIsOccupiedLocked(lower) || fpIsOccupiedLocked(upper)) ? '' : `<div class="fp-resize" title="Drag to resize"></div>`);
      canvas.appendChild(el);
      continue;
    }
    const pl = group.members[0];
    const el = document.createElement('div');
    el.className = 'fp-placed' + (state.fp.selected === pl.unitId || fpInMulti('placement', pl.unitId) ? ' selected' : '') + (fpIsDraftUnit(pl) ? ' fp-draft' : '');
    el.dataset.unitId = pl.unitId;
    el.dataset.stackTier = String(pl.stackTier || 0);
    el.style.left = pl.x * u + 'px';
    el.style.top = pl.y * u + 'px';
    el.style.width = pl.width * u + 'px';
    el.style.height = pl.height * u + 'px';
    if (fpIsOccupiedLocked(pl)) el.title = fpLockedTooltip(pl);
    el.innerHTML =
      `<div class="fp-status" style="background:${fpStatusColor(pl.status)};"></div>` +
      `<div class="fp-code">${escapeHtml(pl.unitCode)}</div>` +
      (pl.height * u > 34 ? `<div class="fp-size">${escapeHtml(pl.sizeName)}</div>` : '') +
      fpUnitTagsHTML(pl) +
      fpDoorMarkersHTML(pl, u) +
      (fpIsOccupiedLocked(pl) ? '' : `<div class="fp-resize" title="Drag to resize"></div>`);
    canvas.appendChild(el);
  }
  // Line-tool affordance: crosshair while draw mode is armed (mode-gated —
  // placement/block drags only run when the tool is toggled off). An armed
  // marker (Markers/Safety group) behaves the same — the next canvas click
  // places it, so the crosshair applies there too.
  canvas.style.cursor = state.fp.underlayMode === 'move' ? 'move' : state.fp.drawMode || state.fp.armedMarker || state.fp.measureMode || state.fp.underlayMode || state.fp.newUnitMode ? 'crosshair' : '';
  if (fpNewDraft) fpRenderNewUnitGhost(canvas, u);
  // Safety/facility point icons render LAST (top of the z-order) so a marker
  // never hides under a placement.
  fpRenderMarkerLayer(canvas, u, fpLayerHidden('markers') ? [] : state.fp.markers || [], true, state.fp.selectedMarker);
  fpZoomLabel();
}

// Safety/facility point icons as circular badges (distinct icon + ring tone per
// kind, see FP_MARKER_KINDS). Inline styles only — no dashboard CSS changes.
// Interactive badges (editor) drag to move and click to select; the read-only
// preview renders them statically (pointer-events none).
function fpRenderMarkerLayer(canvas, u, markers, interactive, selectedId) {
  for (const m of markers || []) {
    const def = fpMarkerDef(m.kind);
    const size = Math.max(22, Math.round(u * 1.1));
    const el = document.createElement('div');
    const isSel = !!m.id && (m.id === selectedId || (interactive && fpInMulti('marker', m.id)));
    el.className = 'fp-marker' + (isSel ? ' selected' : '');
    el.dataset.markerId = m.id;
    el.title = `${fpMarkerLabel(m)} · ${m.x},${m.y} ft${interactive ? ' — drag to move, click to select' : ''}`;
    el.style.position = 'absolute';
    el.style.left = m.x * u - size / 2 + 'px';
    el.style.top = m.y * u - size / 2 + 'px';
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    el.style.borderRadius = '50%';
    el.style.background = '#fff';
    el.style.border = `2px solid ${def.tone}`;
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.fontSize = Math.round(size * 0.55) + 'px';
    el.style.lineHeight = '1';
    el.style.cursor = interactive ? 'grab' : 'default';
    el.style.boxSizing = 'border-box';
    el.style.zIndex = '3';
    if (!interactive) el.style.pointerEvents = 'none';
    if (isSel) el.style.boxShadow = `0 0 0 2px ${def.tone}`;
    el.textContent = def.icon;
    canvas.appendChild(el);
  }
}

// ---------- tracing underlay + export (precision Phase 5) ----------
// Underlay: one CMS-only image per plan (the architect's drawing) under the
// canvas. PNG / JPEG / WebP upload as-is (downsized to ≤ 4000 px and ≤ 3.5 MB);
// PDFs are rasterised client-side from page 1 with pdf.js (lazy-loaded from
// cdnjs, like chart.js). Calibrate = click two features of known distance and
// type it; Move = drag the image; rotation / offset / opacity / show / lock in
// the 🗺 panel. Bytes are served only by the authenticated image route.
// Export: SVG (vector, mm-sized at the chosen scale), PNG (raster of that
// SVG) or PDF (jsPDF, lazy-loaded; page = the drawing's exact mm size so a
// 100% print is to scale) with title block, scale bar, north arrow, legend.

const FP_PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const FP_PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const FP_JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const FP_UNDERLAY_MAX_PX = 4000;
const FP_UNDERLAY_MAX_BYTES = 3.5 * 1024 * 1024;
let fpUnderlayImg = null; // { key, url } — object URL of the loaded image
let fpCalib = null; // { a: [x,y], b: [x,y]|null } while calibrating
const fpScriptCache = new Map();

function fpLoadScript(url) {
  if (fpScriptCache.has(url)) return fpScriptCache.get(url);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Could not load ${url} — check the network connection.`));
    document.head.appendChild(s);
  });
  fpScriptCache.set(url, p);
  p.catch(() => fpScriptCache.delete(url));
  return p;
}

// Load (or reuse) the underlay image for the current plan; re-renders when ready.
async function fpEnsureUnderlayImage() {
  const u = state.fp.underlay;
  if (!u) {
    if (fpUnderlayImg) URL.revokeObjectURL(fpUnderlayImg.url);
    fpUnderlayImg = null;
    return;
  }
  // Settings-only updates (calibration, opacity) keep the same bytes, so the
  // cache keys on image identity; a replace clears the cache explicitly.
  const key = `${state.fp.floorId}:${u.id}:${u.widthPx}x${u.heightPx}:${u.mime}`;
  if (fpUnderlayImg && fpUnderlayImg.key === key) return;
  try {
    const img = await get(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/underlay/image`);
    const bin = atob(img.dataBase64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    if (fpUnderlayImg) URL.revokeObjectURL(fpUnderlayImg.url);
    fpUnderlayImg = { key, url: URL.createObjectURL(new Blob([buf], { type: img.mime })) };
    fpRenderCanvas();
  } catch (err) {
    fpToast('Underlay image: ' + describeError(err), false);
  }
}

function fpRenderUnderlay(canvas, u) {
  const ul = state.fp.underlay;
  if (!ul || !ul.visible || !fpUnderlayImg) return;
  const img = document.createElement('img');
  img.className = 'fp-underlay';
  img.src = fpUnderlayImg.url;
  img.alt = '';
  img.draggable = false;
  img.style.left = ul.offsetX * u + 'px';
  img.style.top = ul.offsetY * u + 'px';
  img.style.width = ul.widthPx * ul.ftPerPx * u + 'px';
  img.style.height = ul.heightPx * ul.ftPerPx * u + 'px';
  img.style.opacity = String(ul.opacity);
  img.style.transform = `rotate(${ul.rotation}deg)`;
  canvas.appendChild(img);
}

// ---- upload ----
function fpCanvasToBlob(c, type, quality) {
  return new Promise((resolve) => c.toBlob((b) => resolve(b), type, quality));
}

function fpBlobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// File → canvas (PDF page 1 via pdf.js; images via createImageBitmap), ≤ 4000 px.
async function fpFileToCanvas(file) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
    await fpLoadScript(FP_PDFJS_URL);
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error('pdf.js did not load');
    pdfjs.GlobalWorkerOptions.workerSrc = FP_PDFJS_WORKER_URL;
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(6, FP_UNDERLAY_MAX_PX / Math.max(vp1.width, vp1.height)) });
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { canvas: c, pages: doc.numPages };
  }
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, FP_UNDERLAY_MAX_PX / Math.max(bmp.width, bmp.height));
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return { canvas: c, pages: 1 };
}

// PNG when it fits the cap (crisp line work), else JPEG, downscaling until it fits.
async function fpEncodeUnderlay(canvas) {
  let c = canvas;
  for (let attempt = 0; attempt < 6; attempt++) {
    const png = await fpCanvasToBlob(c, 'image/png');
    if (png && png.size <= FP_UNDERLAY_MAX_BYTES) return { blob: png, mime: 'image/png', w: c.width, h: c.height };
    for (const q of [0.88, 0.75]) {
      const jpg = await fpCanvasToBlob(c, 'image/jpeg', q);
      if (jpg && jpg.size <= FP_UNDERLAY_MAX_BYTES) return { blob: jpg, mime: 'image/jpeg', w: c.width, h: c.height };
    }
    const next = document.createElement('canvas');
    next.width = Math.max(1, Math.round(c.width * 0.8));
    next.height = Math.max(1, Math.round(c.height * 0.8));
    next.getContext('2d').drawImage(c, 0, 0, next.width, next.height);
    c = next;
  }
  throw new Error('The drawing is too detailed to fit 3.5 MB — export a smaller image or a simpler PDF page.');
}

async function fpUploadUnderlay(file) {
  if (!file || !state.fp.floorId) return;
  try {
    fpToast(`Preparing "${file.name}"…`, true);
    const { canvas, pages } = await fpFileToCanvas(file);
    const enc = await fpEncodeUnderlay(canvas);
    const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/underlay`, {
      method: 'POST',
      body: JSON.stringify({ name: file.name, contentType: enc.mime, dataBase64: await fpBlobToBase64(enc.blob), widthPx: enc.w, heightPx: enc.h }),
    });
    state.fp.underlay = res.data;
    fpUnderlayImg = null;
    await fpEnsureUnderlayImage();
    fpRenderUnderlayMenu();
    fpRenderCanvas();
    fpToast(
      `Underlay "${file.name}" uploaded (${enc.w}×${enc.h} px${pages > 1 ? `, page 1 of ${pages}` : ''}) — now 📐 Calibrate it: click two points of a known distance.`,
      true,
    );
  } catch (err) {
    fpToast('Underlay upload: ' + describeError(err), false);
  }
}

async function fpPatchUnderlay(patch, verb) {
  try {
    const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/underlay`, { method: 'PUT', body: JSON.stringify(patch) });
    state.fp.underlay = res.data;
    fpRenderUnderlayMenu();
    fpRenderCanvas();
    if (verb) fpToast(verb, true);
    return true;
  } catch (err) {
    fpToast('Underlay: ' + describeError(err), false);
    return false;
  }
}

async function fpRemoveUnderlay() {
  const ok = await confirmDialog({ title: 'Remove the underlay image?', message: 'The tracing image is deleted. Drawn units, blocks and lines are not affected.', confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  try {
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/underlay`, { method: 'DELETE' });
    state.fp.underlay = null;
    await fpEnsureUnderlayImage();
    fpSetUnderlayMode(null);
    fpRenderUnderlayMenu();
    fpRenderCanvas();
    fpToast('Underlay removed.', true);
  } catch (err) {
    fpToast('Remove underlay: ' + describeError(err), false);
  }
}

// ---- calibrate / move modes ----
// state.fp.underlayMode: null | 'calibrate' | 'move'
function fpSetUnderlayMode(mode) {
  state.fp.underlayMode = mode;
  fpCalib = null;
  if (mode) {
    state.fp.drawMode = false;
    fpResetPen();
    if (state.fp.measureMode) fpSetMeasureMode(false);
    state.fp.armedMarker = null;
    fpClearSingles();
    state.fp.multi = [];
  }
  fpRenderUnderlayMenu();
  fpRenderCanvas();
  fpRenderSelInfo();
  fpSyncModeUI();
  fpSetReadout(
    mode === 'calibrate'
      ? 'Calibrate · click the first point of a known dimension on the drawing (Esc cancels)'
      : mode === 'move'
        ? 'Move underlay · drag the drawing into place (Esc ends)'
        : '',
  );
}

function fpCalibRaw(e) {
  const raw = fpCanvasRawAt(e.clientX, e.clientY);
  return raw ? [quantizeFt(raw[0]), quantizeFt(raw[1])] : null;
}

function fpUnderlayPointerDown(e) {
  if (e.button !== 0) return;
  const ul = state.fp.underlay;
  if (!ul) return;
  e.preventDefault();
  if (state.fp.underlayMode === 'calibrate') {
    const p = fpCalibRaw(e);
    if (!p) return;
    if (!fpCalib || fpCalib.b) fpCalib = { a: p, b: null };
    else fpCalib.b = p;
    fpRenderCanvas();
    fpRenderSelInfo();
    if (fpCalib.b) {
      const len = segmentLengthFt(fpCalib.a, fpCalib.b);
      fpSetReadout(`Calibrate · currently ${formatFt(Math.round(len * 100) / 100)} ft on the plan — type the REAL distance below`);
      $('#fpSelInfo [data-fp-calib="dist"]')?.focus();
    } else fpSetReadout('Calibrate · now click the second point');
    return;
  }
  // Move: drag the image by the pointer delta (raw, unsnapped).
  const raw0 = fpCanvasRawAt(e.clientX, e.clientY);
  const ox = ul.offsetX;
  const oy = ul.offsetY;
  let moved = false;
  const move = (ev) => {
    const raw = fpCanvasRawAt(ev.clientX, ev.clientY);
    if (!raw || !raw0) return;
    moved = true;
    ul.offsetX = quantizeFt(ox + raw[0] - raw0[0]);
    ul.offsetY = quantizeFt(oy + raw[1] - raw0[1]);
    fpRenderCanvas();
    fpSetReadout(`Underlay offset ${formatFt(ul.offsetX)}, ${formatFt(ul.offsetY)} ft`);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (moved) fpPatchUnderlay({ offsetX: ul.offsetX, offsetY: ul.offsetY }, 'Underlay moved.');
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

async function fpApplyCalibration() {
  const ul = state.fp.underlay;
  if (!ul || !fpCalib || !fpCalib.b) return;
  const real = fpParseLen(($('#fpSelInfo [data-fp-calib="dist"]') || {}).value);
  if (real === null || real <= 0) {
    fpToast('Type the real distance between the two points in feet (e.g. 75 or 24.5).', false);
    return;
  }
  const t = calibrateUnderlay(ul, fpCalib.a, fpCalib.b, real);
  const before = ul.ftPerPx;
  const ok = await fpPatchUnderlay({ ftPerPx: t.ftPerPx, offsetX: quantizeFt(t.offsetX), offsetY: quantizeFt(t.offsetY) });
  if (ok) {
    const ulNow = state.fp.underlay;
    fpToast(`Calibrated — the drawing is now ${formatFt(ulNow.widthFt)} × ${formatFt(ulNow.heightFt)} ft (scale ×${Math.round((t.ftPerPx / before) * 1000) / 1000}). Check a second known dimension with 📏 Measure.`, true);
    fpSetUnderlayMode(null);
  }
}

function fpCalibInfoHTML() {
  if (!fpCalib || !fpCalib.b) return `<span class="t-type">📐 Calibrate underlay — click ${fpCalib ? 'the second' : 'the first'} point of a known dimension · Esc cancels</span>`;
  const len = segmentLengthFt(fpCalib.a, fpCalib.b);
  return (
    `<span class="t-type">📐 Plan distance ${formatFt(Math.round(len * 1000) / 1000)} ft · real distance</span>` +
    `<input type="text" inputmode="decimal" class="tbl-search fp-num" data-fp-calib="dist" aria-label="Real distance in feet" placeholder="ft" autocomplete="off">` +
    `<span class="t-type">ft</span><button class="act-btn primary" id="fpCalibApply" style="padding:2px 9px;font-size:10px;">Apply</button>` +
    `<button class="act-btn" id="fpCalibCancel" style="padding:2px 9px;font-size:10px;">Cancel</button>`
  );
}

function fpRenderCalibOverlay(svg, u) {
  if (state.fp.underlayMode !== 'calibrate' || !fpCalib) return;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    svg.appendChild(n);
  };
  const { a, b } = fpCalib;
  if (b) mk('line', { x1: a[0] * u, y1: a[1] * u, x2: b[0] * u, y2: b[1] * u, class: 'fp-measure-line' });
  [a, b].filter(Boolean).forEach((p) => {
    mk('circle', { cx: p[0] * u, cy: p[1] * u, r: 6, class: 'fp-calib-mark' });
    mk('path', { d: `M${p[0] * u - 9},${p[1] * u}H${p[0] * u + 9}M${p[0] * u},${p[1] * u - 9}V${p[1] * u + 9}`, class: 'fp-calib-cross' });
  });
}

// ---- 🗺 panel ----
function fpRenderUnderlayMenu() {
  const el = $('#fpUnderlayPanel');
  if (!el) return;
  const ul = state.fp.underlay;
  const btn = $('#fpUnderlayBtn');
  if (btn) btn.classList.toggle('on', !!ul && ul.visible);
  const file = `<label class="act-btn" style="padding:3px 9px;font-size:11px;cursor:pointer;">${ul ? 'Replace…' : '⤒ Upload drawing…'}<input type="file" id="fpUnderlayFile" accept="image/png,image/jpeg,image/webp,application/pdf,.pdf" hidden></label>`;
  if (!ul) {
    el.innerHTML = `<div class="t-type" style="max-width:260px;white-space:normal;margin-bottom:6px;">Trace over the architect's plan: upload a PNG / JPEG / WebP or a PDF (page 1). It stays CMS-only — never shown to customers.</div>${file}`;
    return;
  }
  const row = (inner) => `<div style="display:flex;gap:6px;align-items:center;margin:4px 0;white-space:nowrap;">${inner}</div>`;
  const num = (key, label, v, title) => `<span class="fp-num-lbl">${label}</span><input type="text" inputmode="decimal" class="tbl-search fp-num" data-fp-ul="${key}" value="${escapeHtml(formatFt(v))}" title="${title}" aria-label="${title}" autocomplete="off">`;
  el.innerHTML =
    row(`<span class="t-type" style="font-weight:700;max-width:220px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(ul.name || 'Underlay')}</span>`) +
    row(`<span class="t-type">${formatFt(ul.widthFt)} × ${formatFt(ul.heightFt)} ft · ${ul.widthPx}×${ul.heightPx} px · 1 px = ${Math.round(ul.ftPerPx * 100000) / 100000} ft</span>`) +
    row(
      `<label class="t-type"><input type="checkbox" data-fp-ul="visible"${ul.visible ? ' checked' : ''}> show</label>` +
        `<label class="t-type"><input type="checkbox" data-fp-ul="locked"${ul.locked ? ' checked' : ''}> lock</label>` +
        `<span class="fp-num-lbl">opacity</span><input type="range" min="5" max="100" step="5" data-fp-ul="opacity" value="${Math.round(ul.opacity * 100)}" aria-label="Underlay opacity" style="width:90px;">`,
    ) +
    row(
      `<button class="act-btn${state.fp.underlayMode === 'calibrate' ? ' primary' : ''}" id="fpUnderlayCalib" style="padding:2px 9px;font-size:11px;"${ul.locked ? ' disabled' : ''} title="Click two features of a known distance on the drawing, then type that distance">📐 Calibrate</button>` +
        `<button class="act-btn${state.fp.underlayMode === 'move' ? ' primary' : ''}" id="fpUnderlayMove" style="padding:2px 9px;font-size:11px;"${ul.locked ? ' disabled' : ''} title="Drag the drawing into place">✥ Move</button>` +
        `<button class="act-btn" id="fpUnderlayRot" style="padding:2px 9px;font-size:11px;"${ul.locked ? ' disabled' : ''} title="Rotate 90° clockwise">↻ 90°</button>`,
    ) +
    row(num('offsetX', 'X', ul.offsetX, 'Underlay left edge, feet') + num('offsetY', 'Y', ul.offsetY, 'Underlay top edge, feet') + num('rotation', '∠', ul.rotation, 'Rotation in degrees (clockwise)')) +
    row(file + `<button class="act-btn danger" id="fpUnderlayRemove" style="padding:2px 9px;font-size:11px;">Remove</button>`);
}

function fpWireUnderlayPanel() {
  const panel = $('#fpUnderlayPanel');
  if (!panel) return;
  panel.addEventListener('change', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id === 'fpUnderlayFile') {
      const f = t.files && t.files[0];
      if (f) fpUploadUnderlay(f);
      t.value = '';
      return;
    }
    const key = t.dataset && t.dataset.fpUl;
    if (!key || !state.fp.underlay) return;
    if (key === 'visible' || key === 'locked') {
      fpPatchUnderlay({ [key]: t.checked });
      if (key === 'locked' && t.checked) fpSetUnderlayMode(null);
    } else if (key === 'opacity') fpPatchUnderlay({ opacity: Math.max(0.05, Math.min(1, Number(t.value) / 100)) });
    else {
      const v = key === 'rotation' ? Number(t.value) : fpParseLen(t.value);
      if (v === null || !Number.isFinite(v)) {
        fpToast('Enter a number.', false);
        fpRenderUnderlayMenu();
        return;
      }
      fpPatchUnderlay({ [key]: key === 'rotation' ? v : quantizeFt(v) });
    }
  });
  panel.addEventListener('input', (e) => {
    const t = e.target;
    if (t && t.dataset && t.dataset.fpUl === 'opacity' && state.fp.underlay) {
      state.fp.underlay.opacity = Number(t.value) / 100; // live preview; `change` persists
      fpRenderCanvas();
    }
  });
  panel.addEventListener('click', (e) => {
    const id = e.target && e.target.id;
    if (id === 'fpUnderlayCalib') fpSetUnderlayMode(state.fp.underlayMode === 'calibrate' ? null : 'calibrate');
    else if (id === 'fpUnderlayMove') fpSetUnderlayMode(state.fp.underlayMode === 'move' ? null : 'move');
    else if (id === 'fpUnderlayRot' && state.fp.underlay) fpPatchUnderlay({ rotation: (state.fp.underlay.rotation + 90) % 360 }, 'Underlay rotated 90°.');
    else if (id === 'fpUnderlayRemove') fpRemoveUnderlay();
  });
}

// ---- export ----
const FP_EXPORT_SCALES = [20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1250, 1500, 2000];
const FP_PAPER = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
const FP_EXPORT_FILL = { AVAILABLE: ['#DCEAD9', '#2E6B46'], RESERVED: ['#FFF8E1', '#F57F17'], OCCUPIED: ['#ECEFF1', '#332B24'] };
const FP_EXPORT_MARGIN = 12;
const FP_EXPORT_TITLE_H = 30;

function fpExportFill(status) {
  const s = String(status || '').toUpperCase();
  return FP_EXPORT_FILL[s] || (s === 'AVAILABLE' ? FP_EXPORT_FILL.AVAILABLE : FP_EXPORT_FILL.OCCUPIED);
}

function fpXml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Resolve the sheet: fixed 1:n (sheet sized to the drawing) or "fit A3/A4…"
// (largest standard scale whose drawing fits the paper, landscape or portrait).
function fpExportLayout(scaleOpt) {
  const { w, h } = fpCanvasDims();
  const ftMm = 304.8;
  const fit = /^fit-(A\d)$/.exec(scaleOpt || '');
  if (fit) {
    const [pw, ph] = FP_PAPER[fit[1]];
    let best = null;
    for (const [sw, sh] of [[pw, ph], [ph, pw]]) {
      const availW = sw - 2 * FP_EXPORT_MARGIN;
      const availH = sh - 2 * FP_EXPORT_MARGIN - FP_EXPORT_TITLE_H;
      const n = FP_EXPORT_SCALES.find((k) => (w * ftMm) / k <= availW && (h * ftMm) / k <= availH);
      if (n && (!best || n < best.n)) best = { n, sheetW: sw, sheetH: sh, paper: fit[1] };
    }
    if (!best) best = { n: FP_EXPORT_SCALES[FP_EXPORT_SCALES.length - 1], sheetW: pw, sheetH: ph, paper: fit[1] };
    return { ...best, mmPerFt: ftMm / best.n, drawW: (w * ftMm) / best.n, drawH: (h * ftMm) / best.n };
  }
  const n = Number(String(scaleOpt || '100').replace(/^1:/, '')) || 100;
  const drawW = (w * ftMm) / n;
  const drawH = (h * ftMm) / n;
  return { n, mmPerFt: ftMm / n, drawW, drawH, sheetW: Math.max(drawW + 2 * FP_EXPORT_MARGIN, 160), sheetH: drawH + 2 * FP_EXPORT_MARGIN + FP_EXPORT_TITLE_H, paper: 'custom' };
}

// A "nice" scale-bar length in feet (~1/4 of the drawing width).
function fpScaleBarFt(planW) {
  const target = planW / 4;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
  return steps.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), steps[0]);
}

/** Standalone SVG of the plan at a real print scale (all coordinates in mm). */
function fpBuildExportSVG(opts) {
  const L = fpExportLayout(opts.scale);
  const k = L.mmPerFt;
  const { w: cw, h: ch } = fpCanvasDims();
  const ox = (L.sheetW - L.drawW) / 2;
  const oy = FP_EXPORT_MARGIN;
  const X = (ft) => (ox + ft * k).toFixed(3);
  const Y = (ft) => (oy + ft * k).toFixed(3);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${L.sheetW.toFixed(2)}mm" height="${L.sheetH.toFixed(2)}mm" viewBox="0 0 ${L.sheetW.toFixed(3)} ${L.sheetH.toFixed(3)}" font-family="Helvetica, Arial, sans-serif">`);
  out.push(`<rect x="0" y="0" width="${L.sheetW}" height="${L.sheetH}" fill="#ffffff"/>`);
  // Optional underlay (embedded data URL) — off by default.
  const ul = state.fp.underlay;
  if (opts.underlay && ul && ul.visible && opts.underlayDataUrl) {
    out.push(`<image href="${opts.underlayDataUrl}" x="${X(ul.offsetX)}" y="${Y(ul.offsetY)}" width="${(ul.widthPx * ul.ftPerPx * k).toFixed(3)}" height="${(ul.heightPx * ul.ftPerPx * k).toFixed(3)}" opacity="${ul.opacity}" transform="rotate(${ul.rotation} ${X(ul.offsetX)} ${Y(ul.offsetY)})" preserveAspectRatio="none"/>`);
  }
  out.push(`<rect x="${X(0)}" y="${Y(0)}" width="${(cw * k).toFixed(3)}" height="${(ch * k).toFixed(3)}" fill="none" stroke="#B8B0A4" stroke-width="0.25"/>`);
  if (opts.grid) {
    const g = [];
    for (let x = 1; x < cw; x++) g.push(`M${X(x)},${Y(0)}V${Y(ch)}`);
    for (let y = 1; y < ch; y++) g.push(`M${X(0)},${Y(y)}H${X(cw)}`);
    out.push(`<path d="${g.join('')}" stroke="#ECE6DC" stroke-width="0.12" fill="none"/>`);
  }
  // Lines by kind (GUIDE lines never print).
  for (const b of fpLayerHidden('lines') ? [] : state.fp.boundaries || []) {
    const kind = String(b.kind || '').toUpperCase();
    if (kind === 'GUIDE') continue;
    const pts = fpBoundaryPoints(b.points);
    if (pts.length < 2) continue;
    const d = 'M' + pts.map(([x, y]) => `${X(x)},${Y(y)}`).join('L') + (b.closed ? 'Z' : '');
    if (kind === 'WALL') out.push(`<path d="${d}" fill="none" stroke="#3A322B" stroke-width="${((b.thickness || DEFAULT_WALL_THICKNESS_FT) * k).toFixed(3)}" stroke-linejoin="miter" stroke-linecap="square"/>`);
    else if (kind === 'PARTITION') out.push(`<path d="${d}" fill="none" stroke="#0B4F5E" stroke-width="0.5" stroke-linejoin="round"/>`); // interior wall
    else out.push(`<path d="${d}" fill="${b.closed || pts.length >= 3 ? 'rgba(11,79,94,0.05)' : 'none'}" stroke="#0B4F5E" stroke-width="0.5" stroke-linejoin="round"/>`);
  }
  // Blocks.
  for (const blk of fpLayerHidden('blocks') ? [] : state.fp.blocks) {
    out.push(`<rect x="${X(blk.x)}" y="${Y(blk.y)}" width="${(blk.width * k).toFixed(3)}" height="${(blk.height * k).toFixed(3)}" fill="${fpXml(fpBlockFill(blk))}" stroke="#9C9284" stroke-width="0.2"/>`);
    const fs = Math.min(blk.height * k * 0.35, (blk.width * k) / Math.max(4, String(blk.name || '').length * 0.62), 3.2);
    if (fs >= 0.9) out.push(`<text x="${X(blk.x + blk.width / 2)}" y="${Y(blk.y + blk.height / 2)}" font-size="${fs.toFixed(2)}" text-anchor="middle" dominant-baseline="central" fill="#5A5048">${fpXml(blk.name)}</text>`);
  }
  // Units (stacked pairs print once with both codes).
  for (const group of fpLayerHidden('units') ? [] : fpGroupByRect(state.fp.placements)) {
    const r = group.rect;
    const lower = group.members[0];
    const [fill, ink] = fpExportFill(lower.status);
    out.push(`<rect x="${X(r.x)}" y="${Y(r.y)}" width="${(r.width * k).toFixed(3)}" height="${(r.height * k).toFixed(3)}" fill="${fill}" stroke="${ink}" stroke-width="0.25"/>`);
    if (opts.labels !== false) {
      const code = group.members.map((m) => m.unitCode).join(' / ');
      const sq = group.members.map((m) => `${m.sqft}`).join('/') + ' sqft';
      const wmm = r.width * k;
      const hmm = r.height * k;
      const fs = Math.min(hmm * 0.3, wmm / Math.max(3, code.length * 0.62), 3.4);
      if (fs >= 0.8) {
        out.push(`<text x="${X(r.x + r.width / 2)}" y="${(oy + (r.y + r.height / 2) * k - fs * 0.15).toFixed(3)}" font-size="${fs.toFixed(2)}" font-weight="700" text-anchor="middle" fill="${ink}">${fpXml(code)}</text>`);
        if (hmm > fs * 2.6) out.push(`<text x="${X(r.x + r.width / 2)}" y="${(oy + (r.y + r.height / 2) * k + fs * 1.05).toFixed(3)}" font-size="${(fs * 0.75).toFixed(2)}" text-anchor="middle" fill="${ink}">${fpXml(sq)}</text>`);
      }
    }
  }
  // Markers.
  for (const m of fpLayerHidden('markers') ? [] : state.fp.markers || []) {
    const def = fpMarkerDef(m.kind);
    const rr = Math.max(1.2, Math.min(2.4, 1.2 * k));
    out.push(`<circle cx="${X(m.x)}" cy="${Y(m.y)}" r="${rr.toFixed(2)}" fill="#fff" stroke="${def.tone}" stroke-width="0.35"/>`);
    out.push(`<text x="${X(m.x)}" y="${Y(m.y)}" font-size="${(rr * 1.1).toFixed(2)}" text-anchor="middle" dominant-baseline="central">${fpXml(def.icon)}</text>`);
  }
  // North arrow (plan up = north) at the drawing's top-right.
  const nx = ox + L.drawW - 6;
  const ny = oy + 8;
  out.push(`<g><path d="M${nx},${ny - 6}L${nx + 2.6},${ny + 2}L${nx},${ny}L${nx - 2.6},${ny + 2}Z" fill="#332B24"/><text x="${nx}" y="${ny + 6}" font-size="3" font-weight="700" text-anchor="middle" fill="#332B24">N</text></g>`);
  // Title block.
  const ty = L.sheetH - FP_EXPORT_MARGIN - FP_EXPORT_TITLE_H + 4;
  const tx = FP_EXPORT_MARGIN;
  const tw = L.sheetW - 2 * FP_EXPORT_MARGIN;
  out.push(`<rect x="${tx}" y="${ty}" width="${tw}" height="${FP_EXPORT_TITLE_H - 4}" fill="none" stroke="#332B24" stroke-width="0.3"/>`);
  const m = fpBoundaryMetricsLocal();
  const title = `StoreLah — ${state.fp.branchName || ''} · ${state.fp.floorName || ''}`;
  const dateStr = new Date().toLocaleDateString('en-SG', { year: 'numeric', month: 'short', day: 'numeric' });
  out.push(`<text x="${tx + 4}" y="${ty + 7}" font-size="4" font-weight="700" fill="#332B24">${fpXml(title)}</text>`);
  out.push(`<text x="${tx + 4}" y="${ty + 13}" font-size="2.6" fill="#5A5048">Floor plan · ${fpXml(formatFt(cw))} × ${fpXml(formatFt(ch))} ft canvas · ${state.fp.placements.length} units placed${m.boundaryClosed ? ` · UFA ${fpFmtArea(m.ufa)} sqft · NLA ${fpFmtArea(m.nla)} sqft` : ''}</text>`);
  out.push(`<text x="${tx + 4}" y="${ty + 19}" font-size="2.6" fill="#5A5048">Printed ${fpXml(dateStr)} · status ${fpXml(String(state.fp.plan && state.fp.plan.status || 'DRAFT'))}</text>`);
  // Scale bar.
  const barFt = fpScaleBarFt(cw);
  const barMm = barFt * k;
  const bx = tx + tw / 2 - barMm / 2;
  const by = ty + 9;
  for (let i = 0; i < 4; i++) out.push(`<rect x="${(bx + (i * barMm) / 4).toFixed(3)}" y="${by}" width="${(barMm / 4).toFixed(3)}" height="1.6" fill="${i % 2 ? '#fff' : '#332B24'}" stroke="#332B24" stroke-width="0.2"/>`);
  out.push(`<text x="${bx.toFixed(3)}" y="${by + 5}" font-size="2.4" text-anchor="middle" fill="#332B24">0</text><text x="${(bx + barMm).toFixed(3)}" y="${by + 5}" font-size="2.4" text-anchor="middle" fill="#332B24">${barFt} ft</text>`);
  out.push(`<text x="${(bx + barMm / 2).toFixed(3)}" y="${by + 11}" font-size="3" font-weight="700" text-anchor="middle" fill="#332B24">Scale 1:${L.n}${L.paper !== 'custom' ? ` @ ${L.paper}` : ''} · sheet ${Math.round(L.sheetW)}×${Math.round(L.sheetH)} mm</text>`);
  // Legend.
  const lx = tx + tw - 58;
  [['Available', 'AVAILABLE'], ['Reserved', 'RESERVED'], ['Occupied / other', 'OCCUPIED']].forEach(([label, s], i) => {
    const [fill, ink] = fpExportFill(s);
    out.push(`<rect x="${lx}" y="${ty + 4 + i * 6}" width="5" height="3.6" fill="${fill}" stroke="${ink}" stroke-width="0.25"/><text x="${lx + 7}" y="${ty + 6.9 + i * 6}" font-size="2.6" fill="#332B24">${label}</text>`);
  });
  out.push('</svg>');
  return { svg: out.join(''), layout: L };
}

function fpDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function fpSvgToPngBlob(svg, layout, dpiWanted) {
  const maxPx = 9000;
  const dpi = Math.max(72, Math.min(dpiWanted, (maxPx * 25.4) / Math.max(layout.sheetW, layout.sheetH)));
  const wpx = Math.round((layout.sheetW / 25.4) * dpi);
  const hpx = Math.round((layout.sheetH / 25.4) * dpi);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Could not rasterise the plan'));
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = wpx;
    c.height = hpx;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, wpx, hpx);
    ctx.drawImage(img, 0, 0, wpx, hpx);
    return { blob: await fpCanvasToBlob(c, 'image/png'), dpi: Math.round(dpi), wpx, hpx };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function fpExport() {
  const fmt = (($('#fpExportFormat') || {}).value || 'pdf').toLowerCase();
  const scale = ($('#fpExportScale') || {}).value || 'fit-A3';
  const grid = !!($('#fpExportGrid') || {}).checked;
  const withUnderlay = !!($('#fpExportUnderlay') || {}).checked;
  try {
    let underlayDataUrl = null;
    if (withUnderlay && state.fp.underlay && fpUnderlayImg) {
      const blob = await (await fetch(fpUnderlayImg.url)).blob();
      underlayDataUrl = `data:${blob.type};base64,${await fpBlobToBase64(blob)}`;
    }
    const { svg, layout } = fpBuildExportSVG({ scale, grid, underlay: withUnderlay, underlayDataUrl, labels: true });
    const base = `StoreLah-${String(state.fp.branchName || 'plan').replace(/[^A-Za-z0-9]+/g, '-')}-${String(state.fp.floorName || '').replace(/[^A-Za-z0-9]+/g, '')}-1to${layout.n}`;
    if (fmt === 'svg') {
      fpDownload(new Blob([svg], { type: 'image/svg+xml' }), `${base}.svg`);
    } else if (fmt === 'png') {
      const png = await fpSvgToPngBlob(svg, layout, 200);
      fpDownload(png.blob, `${base}.png`);
    } else {
      await fpLoadScript(FP_JSPDF_URL);
      const jsPDF = window.jspdf && window.jspdf.jsPDF;
      if (!jsPDF) throw new Error('jsPDF did not load');
      const png = await fpSvgToPngBlob(svg, layout, 220);
      const dataUrl = `data:image/png;base64,${await fpBlobToBase64(png.blob)}`;
      const landscape = layout.sheetW > layout.sheetH;
      const doc = new jsPDF({ unit: 'mm', format: [layout.sheetW, layout.sheetH], orientation: landscape ? 'landscape' : 'portrait', compress: true });
      doc.addImage(dataUrl, 'PNG', 0, 0, layout.sheetW, layout.sheetH, undefined, 'FAST');
      doc.setProperties({ title: `${base} (scale 1:${layout.n})`, creator: 'StoreLah CMS' });
      fpDownload(doc.output('blob'), `${base}.pdf`);
    }
    fpToast(`Exported ${fmt.toUpperCase()} at 1:${layout.n} — sheet ${Math.round(layout.sheetW)} × ${Math.round(layout.sheetH)} mm${fmt === 'pdf' ? '. Print at 100% / "Actual size" to keep the scale.' : '.'}`, true);
    const menu = $('#fpExportMenu');
    if (menu) menu.hidden = true;
  } catch (err) {
    fpToast('Export: ' + describeError(err), false);
  }
}

// ---------- productivity (precision Phase 4) ----------
// Multi-element edits go through POST /floor-plans/:floorId/batch, which
// validates the FINAL layout and applies it atomically, then returns the full
// plan read. Built on it: generic undo / REDO (every entry is a list of
// {type, id, before, after} element states — legacy single-element entries are
// converted on the fly), multi-select (Shift-click, marquee, Cmd/Ctrl+A) with
// group drag / nudge / delete, align & distribute, copy / paste / duplicate
// (blocks, markers, lines — units are real inventory), unit arrays (place the
// next N unplaced units of the same size in a row), layers (show / lock) and
// a keyboard-shortcut sheet. A save-status chip tracks in-flight writes and a
// beforeunload guard protects pending ones.

const fpRedoStack = [];
let fpClipboard = null; // { items: [{ type, state }], pastes: number }
let fpSaving = 0;
let fpSaveFailed = false;
let fpLastSavedAt = null;
let fpGroupNudge = null; // { before, timer }
const FP_UNDO_LIMIT = 100;
const FP_LAYERS = [['units', 'Units'], ['blocks', 'Blocks'], ['lines', 'Lines'], ['markers', 'Markers']];
const FP_LAYERS_STORAGE_KEY = 'storelah.fp.layers';
const FP_BATCH_KEYS = { placement: 'placements', block: 'blocks', marker: 'markers', boundary: 'boundaries' };

// ---- save status ----
function fpRenderSaveStatus() {
  const el = $('#fpSaveStatus');
  if (!el) return;
  if (fpSaving > 0) el.textContent = 'Saving…';
  else if (fpSaveFailed) el.textContent = '⚠ Last save failed';
  else if (fpLastSavedAt) el.textContent = `✓ Saved ${fpLastSavedAt.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' })}`;
  else el.textContent = '';
  // Pending publish work (floor-plan unit sync): drafts + resized units.
  const drafts = (state.fp.placements || []).filter(fpIsDraftUnit).length;
  const resized = (state.fp.placements || []).filter((p) => p.areaDirty).length;
  const bits = [];
  if (drafts) bits.push(`${drafts} new unit${drafts === 1 ? '' : 's'}`);
  if (resized) bits.push(`${resized} size change${resized === 1 ? '' : 's'}`);
  if (bits.length && !fpSaving && !fpSaveFailed) el.textContent += `${el.textContent ? ' · ' : ''}${bits.join(', ')} pending publish`;
  el.style.color = fpSaveFailed && !fpSaving ? 'var(--terra,#C1664C)' : '';
}

function fpHasPendingWrites() {
  return fpSaving > 0 || !!fpNudgePending || !!fpGroupNudge;
}

// ---- layers ----
function fpLoadLayers() {
  const base = Object.fromEntries(FP_LAYERS.map(([k]) => [k, { hidden: false, locked: false }]));
  try {
    const saved = JSON.parse(window.localStorage.getItem(FP_LAYERS_STORAGE_KEY) || '{}');
    for (const [k] of FP_LAYERS) if (saved && saved[k]) base[k] = { hidden: !!saved[k].hidden, locked: !!saved[k].locked };
  } catch (_) {
    // Storage blocked or corrupt — every layer visible + unlocked.
  }
  state.fp.layers = base;
}

function fpLayerHidden(layer) {
  return !!(state.fp.layers && state.fp.layers[layer] && state.fp.layers[layer].hidden);
}

// Hidden layers are also non-interactive.
function fpLayerLocked(layer) {
  return fpLayerHidden(layer) || !!(state.fp.layers && state.fp.layers[layer] && state.fp.layers[layer].locked);
}

function fpRenderLayersMenu() {
  const menu = $('#fpLayersList');
  if (!menu) return;
  menu.innerHTML = FP_LAYERS.map(
    ([k, label]) =>
      `<label class="t-type" style="display:flex;gap:8px;align-items:center;padding:3px 2px;white-space:nowrap;">` +
      `<span style="min-width:62px;font-weight:700;">${label}</span>` +
      `<span><input type="checkbox" data-fp-layer="${k}" data-fp-layer-prop="hidden"${fpLayerHidden(k) ? '' : ' checked'}> show</span>` +
      `<span><input type="checkbox" data-fp-layer="${k}" data-fp-layer-prop="locked"${state.fp.layers[k].locked ? ' checked' : ''}> lock</span></label>`,
  ).join('');
}

function fpSetLayerProp(layer, prop, on) {
  if (!state.fp.layers || !state.fp.layers[layer]) return;
  state.fp.layers[layer][prop] = on;
  try {
    window.localStorage.setItem(FP_LAYERS_STORAGE_KEY, JSON.stringify(state.fp.layers));
  } catch (_) {
    // Storage blocked — applies for this session only.
  }
  // Drop selections that just became hidden / locked.
  const layerOfType = { placement: 'units', block: 'blocks', marker: 'markers' };
  state.fp.multi = (state.fp.multi || []).filter((m) => !fpLayerLocked(layerOfType[m.type]));
  if (fpLayerLocked('units')) state.fp.selected = null;
  if (fpLayerLocked('blocks')) state.fp.selectedBlock = null;
  if (fpLayerLocked('markers')) state.fp.selectedMarker = null;
  if (fpLayerLocked('lines')) {
    state.fp.selectedBoundary = null;
    state.fp.selectedVertex = null;
  }
  fpRenderLayersMenu();
  fpRenderCanvas();
  fpRenderSelInfo();
}

// ---- element states (the unit of undo / redo / batch) ----
function fpElemState(type, id) {
  if (type === 'placement') {
    const p = state.fp.placements.find((x) => x.unitId === id);
    return p ? { unitId: p.unitId, x: p.x, y: p.y, width: p.width, height: p.height, stackTier: p.stackTier || 0, doorEdges: p.doorEdges || null } : null;
  }
  if (type === 'block') {
    const b = state.fp.blocks.find((x) => x.id === id);
    return b ? { id: b.id, name: b.name, x: b.x, y: b.y, width: b.width, height: b.height, color: b.color || null, doorEdges: b.doorEdges || null } : null;
  }
  if (type === 'marker') {
    const m = (state.fp.markers || []).find((x) => x.id === id);
    return m ? { id: m.id, kind: m.kind, label: m.label || null, x: m.x, y: m.y } : null;
  }
  if (type === 'boundary') {
    const b = (state.fp.boundaries || []).find((x) => x.id === id);
    return b
      ? { id: b.id, label: b.label || 'Wall', kind: b.kind || 'BOUNDARY', points: fpBoundaryPoints(b.points), closed: !!b.closed, sortOrder: b.sortOrder || 0, thickness: b.thickness ?? null }
      : null;
  }
  return null;
}

function fpUnitExists(unitId) {
  return state.fp.placements.some((p) => p.unitId === unitId) || (state.fp.unplaced || []).some((u) => u.id === unitId);
}

function fpBatchBody(items) {
  const body = { upsert: {}, delete: {} };
  for (const it of items) {
    const k = FP_BATCH_KEYS[it.type];
    if (!k) continue;
    // A placement for a unit that does not exist (new drawn unit, or a draft
    // discarded earlier and now restored by undo/redo) is CREATED: the item
    // id becomes the batch tempId and the server mints the real id + code.
    if (it.type === 'placement' && it.state && it.createSpec && !fpUnitExists(it.id)) {
      const { x, y, width, height, stackTier, doorEdges } = it.state;
      if (!body.create) body.create = { units: [] };
      body.create.units.push({ x, y, width, height, stackTier: stackTier || 0, doorEdges: doorEdges || null, ...it.createSpec, tempId: it.id });
      continue;
    }
    if (it.state) (body.upsert[k] = body.upsert[k] || []).push(it.state);
    else (body.delete[k] = body.delete[k] || []).push(it.id);
  }
  return body;
}

// Swap a temp / discarded unit id for the id the server minted, everywhere
// undo/redo and selection may still reference it.
function fpRemapUnitId(oldId, newId) {
  if (!oldId || oldId === newId) return;
  const fix = (it) => {
    if (it.id === oldId) it.id = newId;
    if (it.before && it.before.unitId === oldId) it.before.unitId = newId;
    if (it.after && it.after.unitId === oldId) it.after.unitId = newId;
  };
  for (const entry of [...fpUndoStack, ...fpRedoStack]) {
    if (entry.kind === 'batch') entry.items.forEach(fix);
    else if (entry.unitId === oldId) entry.unitId = newId;
  }
  const specs = state.fp.draftSpecs || {};
  if (specs[oldId]) {
    specs[newId] = specs[oldId];
    delete specs[oldId];
  }
  if (state.fp.selected === oldId) state.fp.selected = newId;
  state.fp.multi = (state.fp.multi || []).map((m) => (m.type === 'placement' && m.id === oldId ? { ...m, id: newId } : m));
}

// Adopt a plan payload (GET /floor-plans/:floorId shape). `keep` preserves
// selection, zoom and undo history (batch responses); otherwise it is a full
// reload (fpFetch).
function fpApplyPlanPayload(body, keep) {
  state.fp.plan = body.plan;
  state.fp.underlay = body.underlay || null; // CMS-only tracing image metadata
  fpEnsureUnderlayImage().catch(() => {});
  state.fp.canvasDefaults = body.canvasDefaults || { width: 70, height: 80 };
  state.fp.structure = body.plan ? body.plan.structure : null;
  state.fp.placements = fpNormalizePlacements(body.plan);
  state.fp.blocks = fpNormalizeBlocks(body.plan);
  state.fp.boundaries = fpNormalizeBoundaries(body.plan);
  state.fp.markers = fpNormalizeMarkers(body.plan);
  state.fp.gfa = body.plan && body.plan.gfaSqft != null && Number.isFinite(body.plan.gfaSqft) ? body.plan.gfaSqft : null;
  state.fp.unplaced = (body.unplacedUnits || []).map(fpNormalizeUnit);
  state.fp.branchName = body.branch && body.branch.name;
  state.fp.floorName = body.floor ? `Level ${body.floor.level}` : '';
  if (keep) {
    // Keep only selections whose element still exists.
    if (state.fp.selected && !fpElemState('placement', state.fp.selected)) state.fp.selected = null;
    if (state.fp.selectedBlock && !fpElemState('block', state.fp.selectedBlock)) state.fp.selectedBlock = null;
    if (state.fp.selectedMarker && !fpElemState('marker', state.fp.selectedMarker)) state.fp.selectedMarker = null;
    if (state.fp.selectedBoundary && !fpElemState('boundary', state.fp.selectedBoundary)) state.fp.selectedBoundary = null;
    state.fp.multi = (state.fp.multi || []).filter((m) => fpElemState(m.type, m.id));
    fpRender();
    return;
  }
  state.fp.selected = null;
  state.fp.selectedBlock = null;
  state.fp.selectedBoundary = null;
  state.fp.selectedMarker = null;
  state.fp.selectedVertex = null;
  state.fp.multi = [];
  state.fp.armedMarker = null;
  state.fp.scale = 1;
  fpClearUndo(); // floor (re)load invalidates inverse ops from the previous floor
}

// Returns the server's `created` map ({ [tempId]: { id, unitCode } }) after
// remapping temp ids to the minted ones.
async function fpSendBatch(items) {
  const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/batch`, {
    method: 'POST',
    body: JSON.stringify(fpBatchBody(items)),
  });
  const created = (res.data && res.data.created) || {};
  for (const [tempId, ref] of Object.entries(created)) fpRemapUnitId(tempId, ref.id);
  fpApplyPlanPayload(res.data, true);
  notifyMetricsFloorChanged();
  return created;
}

let fpLastCreated = {}; // created map of the last fpCommitBatch (tempId → { id, unitCode })

/**
 * Persist target element states in one batch and record ONE undo step.
 * `before` (optional) = the states to restore on undo, when the caller has
 * already mutated local state (drags / nudges); else captured now.
 */
async function fpCommitBatch(targets, verb, before, opts = {}) {
  // Draft units carry a creation spec so undoing their discard re-creates them.
  const specFor = (t) => {
    if (t.createSpec) return t.createSpec;
    if (t.type !== 'placement') return undefined;
    const pl = state.fp.placements.find((x) => x.unitId === t.id);
    return pl && fpIsDraftUnit(pl) ? fpDraftSpec(pl) : undefined;
  };
  const prior = (before || targets.map((t) => ({ type: t.type, id: t.id, state: fpElemState(t.type, t.id) }))).map((p) => {
    const t = targets.find((x) => x.type === p.type && x.id === p.id) || p;
    return { ...p, createSpec: p.createSpec || specFor(t) };
  });
  try {
    const created = await fpSendBatch(targets);
    fpLastCreated = created;
    const idOf = (id) => (created[id] ? created[id].id : id);
    fpPushUndo({
      kind: 'batch',
      items: prior.map((p) => {
        const id = idOf(p.id);
        return { type: p.type, id, before: p.state, after: fpElemState(p.type, id), ...(p.createSpec ? { createSpec: p.createSpec } : {}) };
      }),
    });
    if (!opts.silent) fpToast(verb, true);
    return true;
  } catch (err) {
    fpToast(`${verb.replace(/\.$/, '')}: ${describeError(err)}`, false);
    await fpFetch();
    return false;
  }
}

// ---- undo / redo ----
// Legacy single-element entries ({kind, <id>, prev, deleted?}) become one
// {type, id, before, after} item; partial `prev` payloads merge over the
// element's current state.
function fpUndoItems(entry) {
  if (entry.kind === 'batch') return entry.items;
  const type = entry.kind;
  const id = entry.unitId || entry.blockId || entry.markerId || entry.boundaryId;
  const current = fpElemState(type, id);
  let before = null;
  if (entry.prev) {
    before = { ...(current || {}), ...entry.prev };
    if (type === 'placement') before.unitId = id;
    else before.id = id;
    if (type === 'boundary') before.points = fpBoundaryPoints(before.points);
  }
  return [{ type, id, before, after: current }];
}

async function fpUndo() {
  fpFlushNudge();
  fpFlushGroupNudge();
  const entry = fpUndoStack.pop();
  if (!entry) {
    fpToast('Nothing to undo.', false);
    return;
  }
  const items = fpUndoItems(entry);
  try {
    // Re-creating a discarded draft mints a new id; fpSendBatch remaps the
    // items (already on the redo stack) to it.
    fpRedoStack.push({ kind: 'batch', items });
    try {
      await fpSendBatch(items.map((i) => ({ type: i.type, id: i.id, state: i.before, createSpec: i.createSpec })));
    } catch (e) {
      fpRedoStack.pop();
      throw e;
    }
    fpToast(`Undone (${fpUndoStack.length} more · ${fpRedoStack.length} to redo).`, true);
  } catch (err) {
    fpToast('Undo: ' + describeError(err), false);
    await fpFetch();
  }
  fpSyncUndoButtons();
}

async function fpRedo() {
  const entry = fpRedoStack.pop();
  if (!entry) {
    fpToast('Nothing to redo.', false);
    return;
  }
  try {
    fpUndoStack.push(entry);
    try {
      await fpSendBatch(entry.items.map((i) => ({ type: i.type, id: i.id, state: i.after, createSpec: i.createSpec })));
    } catch (e) {
      fpUndoStack.pop();
      throw e;
    }
    fpToast(`Redone (${fpRedoStack.length} more to redo).`, true);
  } catch (err) {
    fpToast('Redo: ' + describeError(err), false);
    await fpFetch();
  }
  fpSyncUndoButtons();
}

function fpSyncUndoButtons() {
  const u = $('#fpUndoBtn');
  const r = $('#fpRedoBtn');
  if (u) u.disabled = fpUndoStack.length === 0;
  if (r) r.disabled = fpRedoStack.length === 0;
}

// ---- multi-select ----
function fpInMulti(type, id) {
  return (state.fp.multi || []).some((m) => m.type === type && m.id === id);
}

function fpSingleAsMulti() {
  if (state.fp.selected) return [{ type: 'placement', id: state.fp.selected }];
  if (state.fp.selectedBlock) return [{ type: 'block', id: state.fp.selectedBlock }];
  if (state.fp.selectedMarker) return [{ type: 'marker', id: state.fp.selectedMarker }];
  return [];
}

function fpClearSingles() {
  state.fp.selected = null;
  state.fp.selectedBlock = null;
  state.fp.selectedMarker = null;
  state.fp.selectedBoundary = null;
  state.fp.selectedVertex = null;
}

// Replace the selection with `list`; one item collapses to a single selection.
function fpSetSelection(list) {
  fpClearSingles();
  if (list.length === 1) {
    const [m] = list;
    if (m.type === 'placement') state.fp.selected = m.id;
    else if (m.type === 'block') state.fp.selectedBlock = m.id;
    else if (m.type === 'marker') state.fp.selectedMarker = m.id;
    state.fp.multi = [];
  } else {
    state.fp.multi = list;
  }
  fpRenderCanvas();
  fpRenderSelInfo();
}

function fpToggleMulti(type, id) {
  const cur = state.fp.multi && state.fp.multi.length ? state.fp.multi.slice() : fpSingleAsMulti();
  const i = cur.findIndex((m) => m.type === type && m.id === id);
  if (i >= 0) cur.splice(i, 1);
  else cur.push({ type, id });
  fpSetSelection(cur);
}

function fpLiveItem(type, id) {
  if (type === 'placement') return state.fp.placements.find((p) => p.unitId === id) || null;
  if (type === 'block') return state.fp.blocks.find((b) => b.id === id) || null;
  if (type === 'marker') return (state.fp.markers || []).find((m) => m.id === id) || null;
  return null;
}

// Selected items with live refs; placements expand to include stack mates.
function fpMultiItems() {
  const out = [];
  const seen = new Set();
  for (const m of state.fp.multi || []) {
    const it = fpLiveItem(m.type, m.id);
    if (!it || seen.has(m.type + m.id)) continue;
    seen.add(m.type + m.id);
    out.push({ type: m.type, id: m.id, it });
    if (m.type === 'placement') {
      const mate = fpStackMate(it);
      if (mate && !seen.has('placement' + mate.unitId)) {
        seen.add('placement' + mate.unitId);
        out.push({ type: 'placement', id: mate.unitId, it: mate, mateOf: m.id });
      }
    }
  }
  return out;
}

function fpItemRect(m) {
  return m.type === 'marker' ? { x: m.it.x, y: m.it.y, width: 0, height: 0 } : { x: m.it.x, y: m.it.y, width: m.it.width, height: m.it.height };
}

function fpBBox(items) {
  const rs = items.map(fpItemRect);
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => quantizeFt(r.x + r.width)));
  const y1 = Math.max(...rs.map((r) => quantizeFt(r.y + r.height)));
  return { x0, y0, x1, y1 };
}

// After local positions changed: first moved placement that overlaps a unit
// (other moved units are already at their final spots), else null.
function fpGroupOverlap(items) {
  for (const m of items) {
    if (m.type !== 'placement') continue;
    const mate = fpStackMate(m.it);
    const ignore = [m.it.unitId].concat(mate ? [mate.unitId] : []);
    const hit = fpOverlapAt(m.it.x, m.it.y, m.it.width, m.it.height, ignore, m.it.stackTier || 0);
    if (hit) return { m, hit };
  }
  return null;
}

function fpGroupLocked(items) {
  return items.find((m) => m.type === 'placement' && fpIsOccupiedLocked(m.it)) || null;
}

const fpStatesOf = (items) => items.map((m) => ({ type: m.type, id: m.id, state: fpElemState(m.type, m.id) }));

// Translate the group by (dx, dy), clamped so the bbox stays on canvas.
function fpShiftGroup(items, orig, dx, dy) {
  const { w: cw, h: ch } = fpCanvasDims();
  const bb = fpBBox(orig.map((o) => ({ type: o.type, it: o })));
  const cdx = clampFt(dx, -bb.x0, quantizeFt(cw - bb.x1));
  const cdy = clampFt(dy, -bb.y0, quantizeFt(ch - bb.y1));
  items.forEach((m, i) => {
    m.it.x = quantizeFt(orig[i].x + cdx);
    m.it.y = quantizeFt(orig[i].y + cdy);
  });
  return { dx: cdx, dy: cdy };
}

function fpGroupStartMove(e) {
  const items = fpMultiItems();
  const locked = fpGroupLocked(items);
  if (locked) {
    fpToast(`${locked.it.unitCode} is occupied on a live plan — the group can't move. Unpublish to draft first.`, false);
    return;
  }
  e.preventDefault();
  const raw0 = fpCanvasRawAt(e.clientX, e.clientY);
  const orig = items.map((m) => ({ type: m.type, x: m.it.x, y: m.it.y, width: m.it.width || 0, height: m.it.height || 0 }));
  const before = fpStatesOf(items);
  let moved = false;
  const move = (ev) => {
    const raw = fpCanvasRawAt(ev.clientX, ev.clientY);
    if (!raw || !raw0) return;
    const step = fpSnapStep(ev);
    let dx = snapFt(raw[0] - raw0[0], step);
    let dy = snapFt(raw[1] - raw0[1], step);
    if (ev.shiftKey) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    if (!dx && !dy && !moved) return;
    moved = true;
    const d = fpShiftGroup(items, orig, dx, dy);
    fpRenderCanvas();
    fpSetReadout(`${items.length} items Δ ${formatFt(d.dx)}, ${formatFt(d.dy)} ft`);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (!moved) return;
    const clash = fpGroupOverlap(items);
    if (clash) {
      items.forEach((m, i) => {
        m.it.x = orig[i].x;
        m.it.y = orig[i].y;
      });
      fpRenderCanvas();
      fpToast(`Cannot move the group — ${clash.m.it.unitCode} would overlap ${clash.hit.unitCode}. Reverted.`, false);
      return;
    }
    fpCommitBatch(fpStatesOf(items), `Moved ${items.length} items.`, before);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function fpFlushGroupNudge() {
  if (!fpGroupNudge) return;
  clearTimeout(fpGroupNudge.timer);
  const { before, items } = fpGroupNudge;
  fpGroupNudge = null;
  fpCommitBatch(fpStatesOf(items), `Nudged ${items.length} items.`, before);
}

// Arrow-key nudge for a multi-selection (one batch + undo step per burst).
function fpNudgeGroup(dx, dy) {
  const items = fpMultiItems();
  if (!items.length) return;
  const locked = fpGroupLocked(items);
  if (locked) {
    fpToast(`${locked.it.unitCode} is occupied on a live plan — the group can't move.`, false);
    return;
  }
  const orig = items.map((m) => ({ type: m.type, x: m.it.x, y: m.it.y, width: m.it.width || 0, height: m.it.height || 0 }));
  fpShiftGroup(items, orig, dx, dy);
  const clash = fpGroupOverlap(items);
  if (clash) {
    items.forEach((m, i) => {
      m.it.x = orig[i].x;
      m.it.y = orig[i].y;
    });
    fpToast(`Cannot nudge — ${clash.m.it.unitCode} would overlap ${clash.hit.unitCode}.`, false);
    return;
  }
  if (!fpGroupNudge) {
    const before = items.map((m, i) => {
      const s = fpElemState(m.type, m.id);
      return { type: m.type, id: m.id, state: s ? { ...s, x: orig[i].x, y: orig[i].y } : s };
    });
    fpGroupNudge = { before, items, timer: null };
  }
  clearTimeout(fpGroupNudge.timer);
  fpGroupNudge.timer = setTimeout(fpFlushGroupNudge, 450);
  fpRenderCanvas();
  fpRenderSelInfo();
}

// Marquee selection from an empty-canvas press; a plain click deselects.
function fpMarqueeStart(e) {
  const raw0 = fpCanvasRawAt(e.clientX, e.clientY);
  const additive = e.shiftKey;
  const base = additive ? (state.fp.multi && state.fp.multi.length ? state.fp.multi.slice() : fpSingleAsMulti()) : [];
  let box = null;
  const canvas = $('#fpCanvas');
  const move = (ev) => {
    const raw = fpCanvasRawAt(ev.clientX, ev.clientY);
    if (!raw || !raw0) return;
    const u = fpPx();
    if (!box && Math.hypot((raw[0] - raw0[0]) * u, (raw[1] - raw0[1]) * u) < 4) return;
    box = { x0: Math.min(raw0[0], raw[0]), y0: Math.min(raw0[1], raw[1]), x1: Math.max(raw0[0], raw[0]), y1: Math.max(raw0[1], raw[1]) };
    let el = canvas && canvas.querySelector('.fp-marquee');
    if (!el && canvas) {
      el = document.createElement('div');
      el.className = 'fp-marquee';
      canvas.appendChild(el);
    }
    if (el) {
      el.style.left = box.x0 * u + 'px';
      el.style.top = box.y0 * u + 'px';
      el.style.width = (box.x1 - box.x0) * u + 'px';
      el.style.height = (box.y1 - box.y0) * u + 'px';
    }
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (!box) {
      if (!additive) fpSetSelection([]);
      return;
    }
    const hits = [];
    const touches = (r) => r.x <= box.x1 && quantizeFt(r.x + r.width) >= box.x0 && r.y <= box.y1 && quantizeFt(r.y + r.height) >= box.y0;
    if (!fpLayerLocked('units')) for (const p of state.fp.placements) if ((p.stackTier || 0) === 0 && touches(p)) hits.push({ type: 'placement', id: p.unitId });
    if (!fpLayerLocked('blocks')) for (const b of state.fp.blocks) if (touches(b)) hits.push({ type: 'block', id: b.id });
    if (!fpLayerLocked('markers')) for (const m of state.fp.markers || []) if (touches({ x: m.x, y: m.y, width: 0, height: 0 })) hits.push({ type: 'marker', id: m.id });
    const merged = base.slice();
    for (const h of hits) if (!merged.some((m) => m.type === h.type && m.id === h.id)) merged.push(h);
    fpSetSelection(merged);
    fpSetReadout(`${merged.length} selected`);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function fpSelectAll() {
  const all = [];
  if (!fpLayerLocked('units')) for (const p of state.fp.placements) if ((p.stackTier || 0) === 0) all.push({ type: 'placement', id: p.unitId });
  if (!fpLayerLocked('blocks')) for (const b of state.fp.blocks) all.push({ type: 'block', id: b.id });
  if (!fpLayerLocked('markers')) for (const m of state.fp.markers || []) all.push({ type: 'marker', id: m.id });
  fpSetSelection(all);
  fpToast(`Selected ${all.length} items.`, true);
}

async function fpDeleteMulti() {
  const items = fpMultiItems();
  if (!items.length) return;
  const locked = fpGroupLocked(items);
  if (locked) {
    fpToast(`${locked.it.unitCode} is occupied on a live plan — remove it from the selection first.`, false);
    return;
  }
  const units = items.filter((m) => m.type === 'placement').length;
  const drafts = items.filter((m) => m.type === 'placement' && fpIsDraftUnit(state.fp.placements.find((p) => p.unitId === m.id))).length;
  const ok = await confirmDialog({
    title: `Remove ${items.length} selected item${items.length === 1 ? '' : 's'}?`,
    message:
      (units - drafts ? `${units - drafts} unit${units - drafts === 1 ? ' goes' : 's go'} back to the palette (unit records are untouched). ` : '') +
      (drafts ? `${drafts} new unpublished unit${drafts === 1 ? ' is' : 's are'} discarded. ` : '') +
      (items.length > units ? 'Blocks and markers are deleted. ' : '') +
      'Undo restores everything.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  const targets = items.map((m) => ({ type: m.type, id: m.id, state: null }));
  state.fp.multi = [];
  fpCommitBatch(targets, `Removed ${items.length} items.`);
}

// Align (left / center / right / top / middle / bottom) or distribute (h / v).
function fpAlignMulti(mode) {
  const items = fpMultiItems().filter((m) => !m.mateOf);
  if (items.length < 2 || (mode.startsWith('dist') && items.length < 3)) {
    fpToast(mode.startsWith('dist') ? 'Distribute needs at least 3 items.' : 'Align needs at least 2 items.', false);
    return;
  }
  const locked = fpGroupLocked(fpMultiItems());
  if (locked) {
    fpToast(`${locked.it.unitCode} is occupied on a live plan — it can't be moved.`, false);
    return;
  }
  const all = fpMultiItems();
  const before = fpStatesOf(all);
  const orig = all.map((m) => ({ x: m.it.x, y: m.it.y }));
  const bb = fpBBox(items);
  const w = (m) => m.it.width || 0;
  const h = (m) => m.it.height || 0;
  const place = (m, x, y) => {
    m.it.x = quantizeFt(x);
    m.it.y = quantizeFt(y);
    const mate = all.find((o) => o.mateOf === m.id);
    if (mate) {
      mate.it.x = m.it.x;
      mate.it.y = m.it.y;
    }
  };
  if (mode === 'left') items.forEach((m) => place(m, bb.x0, m.it.y));
  else if (mode === 'right') items.forEach((m) => place(m, bb.x1 - w(m), m.it.y));
  else if (mode === 'center') items.forEach((m) => place(m, (bb.x0 + bb.x1) / 2 - w(m) / 2, m.it.y));
  else if (mode === 'top') items.forEach((m) => place(m, m.it.x, bb.y0));
  else if (mode === 'bottom') items.forEach((m) => place(m, m.it.x, bb.y1 - h(m)));
  else if (mode === 'middle') items.forEach((m) => place(m, m.it.x, (bb.y0 + bb.y1) / 2 - h(m) / 2));
  else if (mode === 'dist-h' || mode === 'dist-v') {
    const horiz = mode === 'dist-h';
    const sorted = items.slice().sort((a, b) => (horiz ? a.it.x - b.it.x : a.it.y - b.it.y));
    const span = horiz ? bb.x1 - bb.x0 : bb.y1 - bb.y0;
    const sizes = sorted.reduce((s, m) => s + (horiz ? w(m) : h(m)), 0);
    const gap = (span - sizes) / (sorted.length - 1);
    let pos = horiz ? bb.x0 : bb.y0;
    for (const m of sorted) {
      if (horiz) place(m, pos, m.it.y);
      else place(m, m.it.x, pos);
      pos += (horiz ? w(m) : h(m)) + gap;
    }
  }
  const clash = fpGroupOverlap(all);
  if (clash) {
    all.forEach((m, i) => {
      m.it.x = orig[i].x;
      m.it.y = orig[i].y;
    });
    fpRenderCanvas();
    fpToast(`Cannot ${mode.startsWith('dist') ? 'distribute' : 'align'} — ${clash.m.it.unitCode} would overlap ${clash.hit.unitCode}.`, false);
    return;
  }
  fpRenderCanvas();
  const label = { left: 'Aligned left', center: 'Aligned centres', right: 'Aligned right', top: 'Aligned top', middle: 'Aligned middles', bottom: 'Aligned bottom', 'dist-h': 'Distributed horizontally', 'dist-v': 'Distributed vertically' }[mode];
  fpCommitBatch(fpStatesOf(all), `${label} — ${items.length} items.`, before);
}

// ---- copy / paste / duplicate (blocks, markers, lines) ----
function fpNewId(prefix) {
  const rnd = window.crypto && typeof window.crypto.randomUUID === 'function' ? window.crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${rnd}`.slice(0, 64);
}

function fpCopySelection() {
  const picked = [];
  let skippedUnits = 0;
  const list = state.fp.multi && state.fp.multi.length ? state.fp.multi : fpSingleAsMulti();
  for (const m of list) {
    if (m.type === 'placement') skippedUnits++;
    else {
      const s = fpElemState(m.type, m.id);
      if (s) picked.push({ type: m.type, state: s });
    }
  }
  if (state.fp.selectedBoundary) {
    const s = fpElemState('boundary', state.fp.selectedBoundary);
    if (s) picked.push({ type: 'boundary', state: s });
  }
  if (!picked.length) {
    fpToast(skippedUnits ? 'Units are real inventory and can’t be copied — use ⇶ Array to lay out more units.' : 'Select blocks, markers or a line to copy.', false);
    return false;
  }
  fpClipboard = { items: picked, pastes: 0 };
  fpToast(`Copied ${picked.length} item${picked.length === 1 ? '' : 's'}${skippedUnits ? ` (${skippedUnits} unit${skippedUnits === 1 ? '' : 's'} skipped — use ⇶ Array)` : ''}.`, true);
  return true;
}

async function fpPasteClipboard() {
  if (!fpClipboard || !fpClipboard.items.length) {
    fpToast('Nothing to paste — copy blocks, markers or a line first (Cmd/Ctrl+C).', false);
    return;
  }
  fpClipboard.pastes += 1;
  const off = quantizeFt(Math.max(1, fpSnapStep() * 10) * fpClipboard.pastes);
  const { w: cw, h: ch } = fpCanvasDims();
  const targets = fpClipboard.items.map(({ type, state: s }) => {
    const id = fpNewId(type === 'block' ? 'blk' : type === 'marker' ? 'mk' : 'bd');
    if (type === 'boundary') {
      const xs = s.points.map((p) => p[0]);
      const ys = s.points.map((p) => p[1]);
      const dx = clampFt(off, -Math.min(...xs), cw - Math.max(...xs));
      const dy = clampFt(off, -Math.min(...ys), ch - Math.max(...ys));
      return { type, id, state: { ...s, id, points: s.points.map(([x, y]) => [quantizeFt(x + dx), quantizeFt(y + dy)]) } };
    }
    const w = s.width || 0;
    const h = s.height || 0;
    return { type, id, state: { ...s, id, x: clampFt(s.x + off, 0, cw - w), y: clampFt(s.y + off, 0, ch - h) } };
  });
  const ok = await fpCommitBatch(targets, `Pasted ${targets.length} item${targets.length === 1 ? '' : 's'}.`);
  if (ok) {
    const sel = targets.filter((t) => t.type !== 'boundary').map((t) => ({ type: t.type, id: t.id }));
    if (sel.length) fpSetSelection(sel);
    else {
      fpClearSingles();
      state.fp.selectedBoundary = targets[0].id;
      fpRenderCanvas();
      fpRenderSelInfo();
    }
  }
}

// Duplicate = copy + paste without disturbing the clipboard.
async function fpDuplicateSelection() {
  const onlyUnit = !(state.fp.multi && state.fp.multi.length > 1) && state.fp.selected ? state.fp.placements.find((p) => p.unitId === state.fp.selected) : null;
  if (onlyUnit) {
    await fpDuplicateUnit(onlyUnit);
    return;
  }
  const saved = fpClipboard;
  if (!fpCopySelection()) {
    fpClipboard = saved;
    return;
  }
  await fpPasteClipboard();
  fpClipboard = saved;
}

// ---- arrays ----
// Units: place the next N unplaced units of the selected unit's size (whose
// sqft fits its W×H within tolerance) in a row from the selected unit.
// Blocks: N copies. Direction → ↓ ← ↑; gap in ft. Stops at the canvas edge
// or at the first overlap.
async function fpApplyArray() {
  const count = Math.max(1, Math.min(99, parseInt(($('#fpSelInfo [data-fp-arr="count"]') || {}).value, 10) || 0));
  const dir = (($('#fpSelInfo [data-fp-arr="dir"]') || {}).value || 'right');
  const gap = Math.max(0, fpParseLen(($('#fpSelInfo [data-fp-arr="gap"]') || {}).value) || 0);
  const { w: cw, h: ch } = fpCanvasDims();
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  const blk = state.fp.blocks.find((b) => b.id === state.fp.selectedBlock);
  const src = pl || blk;
  if (!src) return;
  const vec = { right: [1, 0], down: [0, 1], left: [-1, 0], up: [0, -1] }[dir] || [1, 0];
  const stepX = quantizeFt(vec[0] * (src.width + gap));
  const stepY = quantizeFt(vec[1] * (src.height + gap));
  const spots = [];
  for (let i = 1; spots.length < count && i <= count; i++) {
    const x = quantizeFt(src.x + stepX * i);
    const y = quantizeFt(src.y + stepY * i);
    if (x < 0 || y < 0 || toMilli(x) + toMilli(src.width) > toMilli(cw) || toMilli(y) + toMilli(src.height) > toMilli(ch)) break;
    if (pl && fpOverlapAt(x, y, src.width, src.height, null, 0)) break;
    spots.push({ x, y });
  }
  if (!spots.length) {
    fpToast('No room for an array in that direction — the canvas edge or another unit is in the way.', false);
    return;
  }
  let targets;
  if (pl) {
    const pool = state.fp.unplaced
      .filter((u) => String(u.sizeCode || '').toUpperCase() === String(pl.sizeCode || '').toUpperCase() && u.sqft > 0 && areaDeviation(pl, u.sqft) <= AREA_TOLERANCE)
      .sort((a, b) => String(a.unitCode).localeCompare(String(b.unitCode)));
    targets = spots.slice(0, pool.length).map((s, i) => ({ type: 'placement', id: pool[i].id, state: { unitId: pool[i].id, x: s.x, y: s.y, width: pl.width, height: pl.height, stackTier: 0 } }));
    const extra = spots.slice(pool.length);
    if (extra.length) {
      const makeNew = await confirmDialog({
        title: `Create ${extra.length} new unit${extra.length === 1 ? '' : 's'}?`,
        message: `${pool.length ? `Only ${pool.length} unplaced ${pl.sizeName || pl.sizeCode} unit${pool.length === 1 ? '' : 's'} fit${pool.length === 1 ? 's' : ''} ${formatFt(pl.width)}×${formatFt(pl.height)} ft. ` : `No unplaced ${pl.sizeName || pl.sizeCode} units fit ${formatFt(pl.width)}×${formatFt(pl.height)} ft. `}${pool.length ? `Create ${extra.length} new draft unit${extra.length === 1 ? '' : 's'} for the rest?` : `Create ${extra.length} new draft unit${extra.length === 1 ? '' : 's'} instead?`} They become available when you publish.`,
        confirmLabel: 'Create units',
      });
      if (!makeNew && !targets.length) return;
      if (makeNew) {
        const spec = fpDraftSpec(pl);
        delete spec.monthlyRate;
        spec.name = null;
        for (const sp of extra) {
          const id = fpNewId('new');
          targets.push({ type: 'placement', id, state: { unitId: id, x: sp.x, y: sp.y, width: pl.width, height: pl.height, stackTier: 0, doorEdges: null }, createSpec: spec });
        }
      }
    }
  } else {
    targets = spots.map((s) => {
      const id = fpNewId('blk');
      return { type: 'block', id, state: { ...fpElemState('block', blk.id), id, x: s.x, y: s.y } };
    });
  }
  state.fp.arrayOpen = false;
  const ok = await fpCommitBatch(targets, `Arrayed ${targets.length} ${pl ? 'unit' : 'block'}${targets.length === 1 ? '' : 's'} ${dir}${spots.length < count || (pl && targets.length < count) ? ` (${count - targets.length} short — ${pl && targets.length < spots.length ? 'ran out of matching units' : 'hit the canvas edge or a unit'})` : ''}.`);
  if (ok) fpSetSelection([{ type: pl ? 'placement' : 'block', id: pl ? pl.unitId : blk.id }, ...targets.map((t) => ({ type: t.type, id: fpLastCreated[t.id] ? fpLastCreated[t.id].id : t.id }))]);
}

function fpArrayFormHTML() {
  return (
    `<span class="fp-num-lbl">Array</span>` +
    `<input type="text" inputmode="numeric" class="tbl-search fp-num" data-fp-arr="count" value="10" aria-label="Number of copies" title="How many to add (1–99)" style="width:48px;">` +
    `<select class="fp-zoompreset" data-fp-arr="dir" aria-label="Array direction"><option value="right">→ right</option><option value="down">↓ down</option><option value="left">← left</option><option value="up">↑ up</option></select>` +
    `<span class="fp-num-lbl">gap</span><input type="text" inputmode="decimal" class="tbl-search fp-num" data-fp-arr="gap" value="0" aria-label="Gap in feet" style="width:48px;"><span class="t-type">ft</span>` +
    `<button class="act-btn primary" id="fpArrayApply" style="padding:2px 9px;font-size:10px;">Place</button>` +
    `<button class="act-btn" id="fpArrayCancel" style="padding:2px 9px;font-size:10px;">Cancel</button>`
  );
}

// Multi-selection strip: count + align / distribute / duplicate / remove.
function fpRenderMultiInfo(info) {
  const items = fpMultiItems().filter((m) => !m.mateOf);
  const n = { placement: 0, block: 0, marker: 0 };
  items.forEach((m) => n[m.type]++);
  const bb = items.length ? fpBBox(items) : null;
  const btn = (act, label, title) => `<button class="act-btn" data-fp-align="${act}" style="padding:2px 7px;font-size:10px;" title="${title}">${label}</button>`;
  info.innerHTML =
    `<span class="t-type">⧉ ${items.length} selected · ${[n.placement && `${n.placement} unit${n.placement === 1 ? '' : 's'}`, n.block && `${n.block} block${n.block === 1 ? '' : 's'}`, n.marker && `${n.marker} marker${n.marker === 1 ? '' : 's'}`].filter(Boolean).join(', ')}` +
    (bb ? ` · ${formatFt(Math.round((bb.x1 - bb.x0) * 100) / 100)}×${formatFt(Math.round((bb.y1 - bb.y0) * 100) / 100)} ft` : '') +
    `</span>` +
    btn('left', '⇤', 'Align left edges') + btn('center', '↔', 'Align horizontal centres') + btn('right', '⇥', 'Align right edges') +
    btn('top', '⤒', 'Align top edges') + btn('middle', '↕', 'Align vertical middles') + btn('bottom', '⤓', 'Align bottom edges') +
    btn('dist-h', '⋯', 'Distribute horizontally (equal gaps, 3+ items)') + btn('dist-v', '⋮', 'Distribute vertically (equal gaps, 3+ items)') +
    (n.block || n.marker ? `<button class="act-btn" id="fpDupBtn" style="padding:2px 9px;font-size:10px;" title="Duplicate the selected blocks / markers (Cmd/Ctrl+D)">⎘ Duplicate</button>` : '') +
    `<button class="act-btn danger" id="fpMultiRemoveBtn" style="padding:2px 9px;font-size:10px;" title="Remove the selection (Delete) — units return to the palette">Remove</button>` +
    `<span class="t-type">drag any to move · arrows nudge · Esc clears</span>`;
}

// ---- keyboard shortcut sheet ----
const FP_SHORTCUTS = [
  ['Selection', [['Click / Shift+click', 'select / add or remove from the selection'], ['Drag on empty canvas', 'marquee select (Shift adds)'], ['Cmd/Ctrl+A', 'select all units, blocks and markers'], ['Esc', 'clear selection / cancel the current tool'], ['Delete', 'remove the selection (or the selected line vertex)']]],
  ['Move & edit', [['Arrows', 'nudge by the snap step (Shift ×10, Alt 0.01 ft)'], ['Shift while dragging', 'lock to one axis'], ['Alt while dragging', 'fine 0.01 ft snap'], ['Cmd/Ctrl+C · V · D', 'copy · paste · duplicate (blocks, markers, lines; D on a unit makes a new draft unit)'], ['Cmd/Ctrl+Z · Shift+Z (or Y)', 'undo · redo']]],
  ['Units', [['N', 'new-unit tool: drag a rectangle, then confirm tier / rate'], ['Enter · Esc (in the form)', 'create · cancel'], ['Delete on a NEW unit', 'discard it (undo brings it back)']]],
  ['Lines & measure', [['L', 'line tool on / off'], ['Click · double-click / Enter', 'add vertex · finish'], ['Click first vertex / C', 'close the loop'], ['Type a number (+ Tab angle) · Enter', 'exact segment length / angle'], ['Backspace', 'remove the last vertex'], ['M', 'measure tool (two clicks)']]],
  ['Help', [['?', 'this sheet']]],
];

function fpToggleShortcutSheet(force) {
  let el = document.getElementById('fpShortcutSheet');
  const open = force !== undefined ? force : !el;
  if (!open) {
    if (el) el.remove();
    return;
  }
  if (el) return;
  el = document.createElement('div');
  el.id = 'fpShortcutSheet';
  el.className = 'fp-shortcuts';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Floor plan keyboard shortcuts');
  el.innerHTML =
    `<div class="fp-shortcuts-card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span class="chart-title">Floor plan shortcuts</span><button class="act-btn" id="fpShortcutClose" type="button">Close</button></div>` +
    FP_SHORTCUTS.map(([group, rows]) =>
      `<div class="fp-num-lbl" style="margin:10px 0 4px;">${group}</div>` +
      rows.map(([k, d]) => `<div style="display:flex;gap:12px;font-size:12px;padding:2px 0;"><span style="min-width:190px;font-weight:700;">${escapeHtml(k)}</span><span>${escapeHtml(d)}</span></div>`).join(''),
    ).join('') +
    `</div>`;
  el.addEventListener('click', (e) => {
    if (e.target === el || (e.target && e.target.id === 'fpShortcutClose')) fpToggleShortcutSheet(false);
  });
  document.body.appendChild(el);
}

// Editing shortcuts with modifiers (Cmd/Ctrl + A / C / V / D / Y / Shift+Z) plus ?.
function fpOnEditKey(e) {
  const t = e.target;
  if (t && typeof t.closest === 'function' && t.closest('input, textarea, select, [contenteditable]')) return;
  const designer = document.querySelector('#facility-floorplans');
  if (!designer || designer.offsetParent === null) return;
  const viewModal = $('#fpViewModal');
  if (viewModal && !viewModal.hidden) return;
  const confirmModal = $('#confirmModal');
  if (confirmModal && !confirmModal.hidden) return;
  const k = String(e.key).toLowerCase();
  if (e.key === '?' || (e.shiftKey && k === '/')) {
    e.preventDefault();
    fpToggleShortcutSheet();
    return;
  }
  if (e.key === 'Escape' && document.getElementById('fpShortcutSheet')) {
    e.preventDefault();
    fpToggleShortcutSheet(false);
    return;
  }
  if (e.key === 'Escape' && state.fp.multi && state.fp.multi.length) {
    e.preventDefault();
    fpSetSelection([]);
    return;
  }
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  if ((k === 'z' && e.shiftKey) || k === 'y') {
    e.preventDefault();
    fpRedo().catch(() => {});
  } else if (k === 'a') {
    e.preventDefault();
    fpSelectAll();
  } else if (k === 'c' && !e.shiftKey) {
    e.preventDefault();
    fpCopySelection();
  } else if (k === 'v' && !e.shiftKey) {
    e.preventDefault();
    fpPasteClipboard();
  } else if (k === 'd') {
    e.preventDefault();
    fpDuplicateSelection();
  }
}

// ---------- numeric inspector + arrow-key nudge (precision Phase 2) ----------
// The selection strip carries editable X / Y / W / H fields (decimal feet) for
// the selected unit, stacked pair or block, and X / Y for a marker. Typed
// values and arrow-key nudges both funnel through fpApplySelectionGeom, which
// runs the same guards as a drag (occupied lock, canvas fit, unit overlap,
// 2% area tolerance) and persists through the existing fpPersist* paths, so
// undo and server validation are unchanged.

// Parse a typed length: "4.73", "4.73 ft", "4.73'", or one simple operation
// ("12/2", "3.5*2", "10+0.25", "10-0.5"). Returns quantized feet or null.
function fpParseLen(raw) {
  const t = String(raw == null ? '' : raw).trim().replace(/\s*(ft|feet|')$/i, '');
  if (!t) return null;
  const m = /^(-?\d*\.?\d+)\s*([+\-*/])\s*(-?\d*\.?\d+)$/.exec(t);
  let n;
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    n = m[2] === '+' ? a + b : m[2] === '-' ? a - b : m[2] === '*' ? a * b : b !== 0 ? a / b : NaN;
  } else {
    n = /^-?\d*\.?\d+$/.test(t) ? Number(t) : NaN;
  }
  return Number.isFinite(n) ? quantizeFt(n) : null;
}

// Editable decimal-ft fields for the selection strip. `vals` = { x, y, width?, height? }.
function fpNumFieldsHTML(vals) {
  const field = (key, label, v) =>
    `<span class="fp-num-lbl">${label}</span><input type="text" inputmode="decimal" class="tbl-search fp-num" data-fp-num="${key}" value="${escapeHtml(formatFt(v))}" aria-label="${label} in feet" title="${label} in feet — Enter applies, Esc reverts, ↑/↓ steps by the snap step (Shift ×10)" autocomplete="off" spellcheck="false">`;
  return (
    field('x', 'X', vals.x) +
    field('y', 'Y', vals.y) +
    (vals.width !== undefined ? field('width', 'W', vals.width) + field('height', 'H', vals.height) : '') +
    '<span class="t-type">ft</span>'
  );
}

// Floor-plan unit sync (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md): the plan owns a
// placed unit's size — resizing changes the unit's sqft on publish — except
// for contracted units (rented / reserved), which keep the ±AREA_TOLERANCE
// rule. The server also locks units with a tenant or a pending booking.
const FP_CONTRACTED_STATUSES = ['OCCUPIED', 'OVERDUE', 'RESERVED'];
function fpIsContracted(it) {
  return FP_CONTRACTED_STATUSES.includes(String((it && it.status) || '').toUpperCase());
}

// Area readout for a unit rect vs its sqft. Contracted: "29.99 sqft · −0.03%"
// (flags > tolerance). Otherwise: "47.25 sqft · unit 40 → 47.25 on publish".
function fpAreaNoteHTML(rect, sqft, it) {
  const area = rectAreaSqft(rect);
  if (!(sqft > 0)) return `<span class="t-type">${fpFmtArea(area)} sqft</span>`;
  if (!fpIsContracted(it)) {
    const next = fpSqftForRect(rect);
    const changes = !fpSameSqft(next, sqft);
    return `<span class="t-type" style="${changes ? 'color:var(--terra,#C1664C);font-weight:700;' : ''}" title="The floor plan sets this unit's size: its sqft becomes the drawn area (to 0.01 sqft) when the plan is published">${fpFmtArea(area)} sqft${changes ? ` · unit ${fpFmtArea(sqft)} → ${fpFmtArea(next)} on publish` : ''}</span>`;
  }
  const dev = (area - sqft) / sqft;
  const pct = (Math.round(dev * 10000) / 100).toLocaleString('en-SG', { maximumFractionDigits: 2, signDisplay: 'exceptZero' });
  const bad = Math.abs(dev) > AREA_TOLERANCE + 1e-9;
  return `<span class="t-type" style="${bad ? 'color:var(--terra,#C1664C);font-weight:700;' : ''}" title="Rented/reserved unit — its ${sqft} sqft is contracted; reshape within ${Math.round(AREA_TOLERANCE * 100)}% only">${fpFmtArea(area)} sqft · ${pct}%</span>`;
}

// What the selection strip is editing right now: { kind, item, pair? }.
function fpSelectionTarget() {
  const blk = state.fp.blocks.find((b) => b.id === state.fp.selectedBlock);
  if (blk) return { kind: 'block', item: blk };
  const mk = (state.fp.markers || []).find((m) => m.id === state.fp.selectedMarker);
  if (mk) return { kind: 'marker', item: mk };
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  if (pl) {
    const mate = fpStackMate(pl);
    const pair = mate ? [pl, mate].slice().sort((a, b) => (a.stackTier || 0) - (b.stackTier || 0)) : [pl];
    return { kind: 'unit', item: pl, pair };
  }
  return null;
}

let fpNudgeTimer = null;
let fpNudgePending = null; // { target, verb } awaiting a debounced persist

function fpFlushNudge() {
  clearTimeout(fpNudgeTimer);
  fpNudgeTimer = null;
  const pending = fpNudgePending;
  fpNudgePending = null;
  if (pending) fpPersistTarget(pending.target, pending.verb);
}

function fpPersistTarget(target, verb) {
  if (target.kind === 'block') return fpPersistBlock(target.item, verb);
  if (target.kind === 'marker') return fpPersistMarker(target.item, verb);
  if (target.pair.length > 1) return fpPersistPair(target.pair[0], target.pair[1], verb);
  return fpPersist(target.item, verb);
}

/**
 * Apply a geometry patch ({x?, y?, width?, height?} in feet) to the current
 * selection. `opts.clamp` keeps the result on-canvas (nudges) instead of
 * rejecting it (typed values); `opts.debounce` coalesces a burst of nudges
 * into one persist + one undo step. Returns true when the change applied.
 */
function fpApplySelectionGeom(patch, verb, opts = {}) {
  const target = fpSelectionTarget();
  if (!target) return false;
  if (fpNudgePending && fpNudgePending.target.item !== target.item) fpFlushNudge();
  const { w: cw, h: ch } = fpCanvasDims();
  const it = target.item;
  if (target.kind === 'marker') {
    let x = patch.x !== undefined ? patch.x : it.x;
    let y = patch.y !== undefined ? patch.y : it.y;
    if (opts.clamp) {
      x = clampFt(x, 0, cw);
      y = clampFt(y, 0, ch);
    } else if (x < 0 || y < 0 || x > cw || y > ch) {
      fpToast(`Marker point ${formatFt(x)}, ${formatFt(y)} is outside the ${formatFt(cw)}×${formatFt(ch)} ft canvas.`, false);
      return false;
    }
    if (ftEquals(x, it.x) && ftEquals(y, it.y)) return false;
    if (!it._undoPrev) it._undoPrev = { kind: it.kind, label: it.label || null, x: it.x, y: it.y };
    it.x = quantizeFt(x);
    it.y = quantizeFt(y);
  } else {
    if (target.kind === 'unit' && fpGuardLocked(it)) return false;
    let width = patch.width !== undefined ? patch.width : it.width;
    let height = patch.height !== undefined ? patch.height : it.height;
    // Sqft lock: typing one side derives the other so area stays = sqft.
    if (target.kind === 'unit' && (state.fp.lockSqft || fpIsContracted(it)) && it.sqft > 0) {
      if (patch.width !== undefined && patch.height === undefined) height = quantizeFt(it.sqft / width);
      else if (patch.height !== undefined && patch.width === undefined) width = quantizeFt(it.sqft / height);
    }
    if (!(width >= MIN_RECT_SIDE_FT) || !(height >= MIN_RECT_SIDE_FT)) {
      fpToast(`Width and height must be at least ${MIN_RECT_SIDE_FT} ft.`, false);
      return false;
    }
    let x = patch.x !== undefined ? patch.x : it.x;
    let y = patch.y !== undefined ? patch.y : it.y;
    if (opts.clamp) {
      x = clampFt(x, 0, cw - width);
      y = clampFt(y, 0, ch - height);
    }
    const next = { x: quantizeFt(x), y: quantizeFt(y), width: quantizeFt(width), height: quantizeFt(height) };
    if (next.x < 0 || next.y < 0 || toMilli(next.x) + toMilli(next.width) > toMilli(cw) || toMilli(next.y) + toMilli(next.height) > toMilli(ch)) {
      fpToast(`${formatFt(next.x)}, ${formatFt(next.y)} · ${formatFt(next.width)}×${formatFt(next.height)} ft does not fit the ${formatFt(cw)}×${formatFt(ch)} ft canvas.`, false);
      return false;
    }
    if (sameRect(next, it)) return false;
    if (target.kind === 'unit') {
      const ids = target.pair.map((p) => p.unitId);
      const hit = fpOverlapAt(next.x, next.y, next.width, next.height, ids, 0);
      if (hit) {
        const action = { Moved: 'move', Resized: 'resize', Nudged: 'nudge' }[verb] || 'change';
        fpToast(`Cannot ${action} ${it.unitCode} — ${formatFt(next.width)}×${formatFt(next.height)} ft at ${formatFt(next.x)}, ${formatFt(next.y)} overlaps ${hit.unitCode}.`, false);
        return false;
      }
      const areaChanged = rectAreaSqft(next) !== rectAreaSqft(it);
      if (areaChanged && fpIsContracted(it) && it.sqft > 0 && areaDeviation(next, it.sqft) > AREA_TOLERANCE) {
        fpToast(`${it.unitCode} is ${it.status.toLowerCase()} — its ${it.sqft} sqft can't change; ${formatFt(next.width)}×${formatFt(next.height)} ft = ${fpFmtArea(rectAreaSqft(next))} sqft is more than ${Math.round(AREA_TOLERANCE * 100)}% off.`, false);
        return false;
      }
      for (const p of target.pair) {
        if (!p._undoPrev) p._undoPrev = { x: p.x, y: p.y, width: p.width, height: p.height, stackTier: p.stackTier || 0 };
        Object.assign(p, next);
      }
    } else {
      if (!it._undoPrev) it._undoPrev = { name: it.name, x: it.x, y: it.y, width: it.width, height: it.height, color: it.color || null, doorEdges: it.doorEdges || null };
      Object.assign(it, next);
    }
  }
  fpRenderCanvas();
  fpRenderSelInfo();
  if (opts.debounce) {
    fpNudgePending = { target, verb };
    clearTimeout(fpNudgeTimer);
    fpNudgeTimer = setTimeout(fpFlushNudge, 450);
  } else {
    fpPersistTarget(target, verb);
  }
  return true;
}

// Commit one inspector field (Enter / change).
function fpCommitNumField(input) {
  const key = input.dataset.fpNum;
  const target = fpSelectionTarget();
  if (!target) return;
  const v = fpParseLen(input.value);
  if (v === null) {
    fpToast(`"${input.value}" is not a length in feet — try 4.73, 12/2 or 3.5*2.`, false);
    input.value = formatFt(target.item[key]);
    return;
  }
  if (ftEquals(v, target.item[key])) {
    input.value = formatFt(v);
    return;
  }
  const verb = key === 'width' || key === 'height' ? 'Resized' : 'Moved';
  if (!fpApplySelectionGeom({ [key]: v }, verb)) input.value = formatFt(target.item[key]);
}

// Arrow keys nudge the selection by the snap step (Shift ×10, Alt = 0.01 ft).
// One debounced persist + undo step per burst. Ignored while typing, while a
// modal is open, or when the designer is not on screen.
function fpOnArrowKey(e) {
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!dir || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
  const t = e.target;
  if (t && typeof t.closest === 'function' && t.closest('input, textarea, select, [contenteditable]')) return;
  const designer = document.querySelector('#facility-floorplans');
  if (!designer || designer.offsetParent === null) return;
  const viewModal = $('#fpViewModal');
  if (viewModal && !viewModal.hidden) return;
  const confirmModal = $('#confirmModal');
  if (confirmModal && !confirmModal.hidden) return;
  if (state.fp.multi && state.fp.multi.length > 1) {
    e.preventDefault();
    const st = fpSnapStep(e) * (e.shiftKey ? 10 : 1);
    fpNudgeGroup(quantizeFt(dir[0] * st), quantizeFt(dir[1] * st));
    return;
  }
  const target = fpSelectionTarget();
  if (!target) return;
  e.preventDefault();
  const step = fpSnapStep(e) * (e.shiftKey ? 10 : 1);
  fpApplySelectionGeom(
    { x: quantizeFt(target.item.x + dir[0] * step), y: quantizeFt(target.item.y + dir[1] * step) },
    'Nudged',
    { clamp: true, debounce: true },
  );
}

// The inspector is rebuilt (innerHTML) whenever the selection's geometry
// changes — including when a typed field commits on Tab/blur. Keep keyboard
// focus (and the text selection) on the same field across the rebuild so
// Tab from W to H keeps typing into H instead of losing focus.
function fpRenderSelInfo() {
  const info = $('#fpSelInfo');
  const a = document.activeElement;
  let key = null;
  if (info && a && info.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) {
    const d = a.dataset || {};
    key = d.fpNum ? `[data-fp-num="${d.fpNum}"]` : d.fpArr ? `[data-fp-arr="${d.fpArr}"]` : a.id ? `#${CSS.escape(a.id)}` : null;
  }
  const sel = key && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
  fpRenderSelInfoInner();
  if (!key || !info) return;
  const next = info.querySelector(key);
  if (!next || next === a) return;
  try {
    next.focus({ preventScroll: true });
    if (sel && typeof next.setSelectionRange === 'function') next.setSelectionRange(0, next.value.length);
  } catch (e) { /* noop */ }
}

function fpRenderSelInfoInner() {
  const info = $('#fpSelInfo');
  if (!info) return;
  if (state.fp.underlayMode === 'calibrate') {
    info.innerHTML = fpCalibInfoHTML();
    return;
  }
  if (state.fp.multi && state.fp.multi.length > 1) {
    fpRenderMultiInfo(info);
    return;
  }
  // A selected decoration block takes priority over any selected unit.
  const blk = state.fp.blocks.find((b) => b.id === state.fp.selectedBlock);
  if (blk) {
    const swatches = FP_BLOCK_PALETTE.map(
      (c) =>
        `<button class="act-btn${(blk.color || '').toUpperCase() === c ? ' primary' : ''}" data-block-color="${c}" style="padding:0;width:18px;height:18px;min-width:18px;border-radius:50%;background:${c};border:1px solid var(--line);" title="Fill ${c}" aria-label="Fill block ${c}"></button>`,
    ).join('');
    info.innerHTML =
      `<span class="t-type">Block · ${escapeHtml(blk.name)}</span>` +
      fpNumFieldsHTML(blk) +
      `<span class="t-type">${fpFmtArea(rectAreaSqft(blk))} sqft</span>` +
      `<span class="fp-rename-wrap"><label class="fp-sr" for="fpBlockRename">Block name</label>` +
      `<svg class="fp-name-icon" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2.5 2.5H10l5.5 5.5-7.5 7.5-5.5-5.5V2.5z"/><circle cx="6.6" cy="6.6" r="1.3"/></svg>` +
      `<input type="text" id="fpBlockRename" class="tbl-search fp-name-input" maxlength="80" value="${escapeHtml(blk.name)}" placeholder="Rename block" aria-label="Rename block" autocomplete="off" spellcheck="false"></span>` +
      `<button class="act-btn" id="fpBlockRenameBtn" style="padding:2px 9px;font-size:10px;">Rename</button>` +
      `<span class="t-type">Fill${blk.color ? '' : ' (default)'}:</span>` + swatches +
      `<input type="color" id="fpBlockColorPick" value="${escapeHtml(fpBlockFill(blk))}" title="Custom fill colour" aria-label="Custom fill colour" style="width:30px;height:20px;padding:0;border:1px solid var(--line);border-radius:6px;background:#fff;">` +
      (blk.color ? `<button class="act-btn" id="fpBlockColorDefault" style="padding:2px 9px;font-size:10px;" title="Clear the fill back to the default block tone">Default</button>` : '') +
      (state.fp.arrayOpen
        ? fpArrayFormHTML()
        : `<button class="act-btn" id="fpArrayBtn" style="padding:2px 9px;font-size:10px;" title="Array — add N copies of this block in a row">⇶ Array</button>` +
          `<button class="act-btn" id="fpDupBtn" style="padding:2px 9px;font-size:10px;" title="Duplicate (Cmd/Ctrl+D)">⎘ Duplicate</button>`) +
      `<button class="act-btn danger" id="fpBlockRemoveBtn" style="padding:2px 9px;font-size:10px;">Remove block</button>`;
    return;
  }
  // A selected boundary line item (incl. pencil-drawn lines) renders like the
  // block branch: a short descriptor plus close/remove actions. Marked-area
  // rule: >= 3-vertex polylines (open or closed) feed UFA/NLA; a 2-vertex open
  // segment renders solid but contributes 0 until extended/closed.
  const bnd = (state.fp.boundaries || []).find((b) => b.id === state.fp.selectedBoundary);
  if (bnd) {
    // Line inspector (Phase 3): label, kind, wall thickness, totals, and the
    // selected vertex's X / Y. Handles on the canvas: ● vertex (drag / click to
    // select, Delete removes), ■ midpoint (drag or click to insert a vertex).
    const pts = fpBoundaryPoints(bnd.points);
    const kind = String(bnd.kind || '').toUpperCase();
    const shownKind = kind === 'PENCIL' ? 'BOUNDARY' : kind;
    const feeds = lineFeedsArea(kind);
    const len = polylineLengthFt(pts, !!bnd.closed);
    const contributing = feeds && pts.length >= 3 && fpPolygonArea(pts) > 0;
    const distinct = new Set(pts.map(([x, y]) => `${toMilli(x)},${toMilli(y)}`)).size;
    // "Counts toward floor area": on = BOUNDARY (marks UFA/NLA), off =
    // PARTITION (interior wall). Legacy WALL / GUIDE rows show it off.
    const kindSel =
      `<label class="t-type" style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap;" title="On for outer walls that enclose the facility area (UFA/NLA). Turn off for interior walls so they don't add area.">` +
      `<input type="checkbox" data-fp-line="counts"${shownKind === 'BOUNDARY' || feeds ? ' checked' : ''}> Counts toward floor area</label>`;
    const lineNum = (key, label, v, title) =>
      `<span class="fp-num-lbl">${label}</span><input type="text" inputmode="decimal" class="tbl-search fp-num" data-fp-line="${key}" value="${escapeHtml(formatFt(v))}" aria-label="${title}" title="${title} — Enter applies, Esc reverts" autocomplete="off" spellcheck="false">`;
    const vi = state.fp.selectedVertex;
    const meta = [
      `${pts.length} vertices`,
      `${formatFt(Math.round(len * 100) / 100)} ft`,
      contributing
        ? `${fpFmtArea(fpPolygonArea(pts))} sqft marked — feeds UFA/NLA`
        : feeds
          ? 'open — needs a 3rd vertex (or close the loop) to feed UFA/NLA'
          : kind === 'PARTITION'
            ? 'interior wall — not counted in UFA/NLA'
            : `${fpLineKindLabel(kind).toLowerCase()} — not counted in UFA/NLA`,
    ].join(' · ');
    info.innerHTML =
      `<span class="t-type">✎</span>` +
      `<input type="text" class="tbl-search fp-name-input" data-fp-line="label" maxlength="80" value="${escapeHtml(bnd.label || '')}" aria-label="Line name" title="Line name — Enter applies" autocomplete="off" spellcheck="false" style="width:120px;">` +
      kindSel +
      (kind === 'WALL' ? lineNum('thickness', 'T', bnd.thickness || DEFAULT_WALL_THICKNESS_FT, 'Wall thickness in feet') + '<span class="t-type">ft</span>' : '') +
      `<span class="t-type">${meta}</span>` +
      (vi != null && pts[vi]
        ? `<span class="t-type">· vertex ${vi + 1}</span>` + lineNum('vx', 'X', pts[vi][0], 'Vertex X in feet') + lineNum('vy', 'Y', pts[vi][1], 'Vertex Y in feet') + '<span class="t-type">ft</span>'
        : `<span class="t-type" title="Drag a ● vertex to move it, click it to edit X/Y or press Delete to remove it; drag or click a ■ midpoint to insert a vertex.">● move · ■ insert</span>`) +
      (!bnd.closed && distinct >= 3
        ? `<button class="act-btn primary" id="fpBoundaryCloseBtn" style="padding:2px 9px;font-size:10px;" title="Close the loop${feeds ? ' — the marked area starts feeding UFA/NLA' : ''}">Close loop</button>`
        : '') +
      `<button class="act-btn danger" id="fpBoundaryRemoveBtn" style="padding:2px 9px;font-size:10px;">Remove line</button>`;
    return;
  }
  // A selected safety/facility marker renders like the block branch: a short
  // descriptor plus an optional label override, move/delete actions. Markers
  // are points (no area), so no resize/rotate/door controls apply.
  const mk = (state.fp.markers || []).find((m) => m.id === state.fp.selectedMarker);
  if (mk) {
    const def = fpMarkerDef(mk.kind);
    info.innerHTML =
      `<span class="t-type">${escapeHtml(def.icon)} ${escapeHtml(def.label)}</span>` +
      fpNumFieldsHTML({ x: mk.x, y: mk.y }) +
      `<span class="fp-rename-wrap"><label class="fp-sr" for="fpMarkerRename">Marker label</label>` +
      `<input type="text" id="fpMarkerRename" class="tbl-search fp-name-input" maxlength="80" value="${escapeHtml(mk.label || '')}" placeholder="${escapeHtml(def.label)} (optional)" aria-label="Marker label override" autocomplete="off" spellcheck="false"></span>` +
      `<button class="act-btn" id="fpMarkerRenameBtn" style="padding:2px 9px;font-size:10px;">Set label</button>` +
      `<button class="act-btn danger" id="fpMarkerRemoveBtn" style="padding:2px 9px;font-size:10px;">Remove marker</button>`;
    return;
  }
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  if (!pl) {
    info.innerHTML = '';
    return;
  }
  // Occupied edit lock: a live (ACTIVE) plan's OCCUPIED/OVERDUE placements
  // render no drag/resize/rename/delete handles — descriptor + tooltip only.
  if (fpIsOccupiedLocked(pl)) {
    const lockMate = fpStackMate(pl);
    const who = lockMate ? `⧉ Stacked pair · ${escapeHtml(pl.unitCode)} / ${escapeHtml(lockMate.unitCode)}` : escapeHtml(pl.unitCode);
    info.innerHTML =
      `<span class="t-type" title="Occupied — uneditable when live">${who} · ${formatFt(pl.x)}, ${formatFt(pl.y)} · ${formatFt(pl.width)}×${formatFt(pl.height)} ft · ${pl.sqft} sqft · Occupied — uneditable when live</span>`;
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
      `<span class="t-type">⧉ Stacked pair · ${escapeHtml(upper.unitCode)} (upper) over ${escapeHtml(lower.unitCode)} (lower)${lockNote}</span>` +
      fpNumFieldsHTML(pl) +
      fpAreaNoteHTML(pl, lower.sqft, lower) +
      `<span class="t-type">doors auto (ghost ticks = all edges)</span>` +
      `<button class="act-btn" id="fpRotateBtn" style="padding:2px 9px;font-size:10px;" title="Swap width/height (90° rotation) for both tiers">⟳ Rotate</button>` +
      `<button class="act-btn" id="fpUnstackBtn" style="padding:2px 9px;font-size:10px;" title="Remove the upper tier — the lower tier stays as a single">Unstack</button>` +
      `<button class="act-btn danger" id="fpRemoveBtn" style="padding:2px 9px;font-size:10px;">${fpIsDraftUnit(pl) ? 'Discard new unit' : 'Remove from floor'}</button>`;
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
    `<span class="t-type">${escapeHtml(pl.unitCode)} · ${pl.sqft} sqft${lockNote}</span>` +
    fpNumFieldsHTML(pl) +
    fpAreaNoteHTML(pl, pl.sqft, pl) +
    `<button class="act-btn" id="fpRotateBtn" style="padding:2px 9px;font-size:10px;" title="Swap width/height (90° rotation)">⟳ Rotate</button>` +
    (stackable.length === 1
      ? `<button class="act-btn" id="fpStackBtn" style="padding:2px 9px;font-size:10px;" title="Stack ${escapeHtml(stackable[0].unitCode)} (upper) onto this block">⧉ Stack ${escapeHtml(stackable[0].unitCode)}</button>`
      : fpIsLockerPlacement(pl) && !stackable.length
        ? `<button class="act-btn" id="fpStackNewBtn" style="padding:2px 9px;font-size:10px;" title="Create a new locker unit stacked on top of this one (draft until you publish)">⧉ Stack new locker</button>`
        : '') +
    `<span class="t-type">Doors${authored ? ' · terra ticks = authored' : ' (auto · ghost ticks = all edges)'}:</span>` + doorBtns +
    (authored ? `<button class="act-btn" id="fpDoorsAutoBtn" style="padding:2px 9px;font-size:10px;" title="Clear authored doors — fall back to all edges">Auto</button>` : '') +
    (state.fp.arrayOpen
      ? fpArrayFormHTML()
      : `<button class="act-btn" id="fpArrayBtn" style="padding:2px 9px;font-size:10px;" title="Array — place the next unplaced units of this size in a row from here">⇶ Array</button>`) +
    `<button class="act-btn danger" id="fpRemoveBtn" style="padding:2px 9px;font-size:10px;">${fpIsDraftUnit(pl) ? 'Discard new unit' : 'Remove from floor'}</button>`;
}

// Persist one placement's authored door edges (null clears back to AUTO).
// Stacked pairs share one rect and keep AUTO (their server-side door union is
// already all edges), so toggles are singles-only.
async function fpSaveDoors(pl, edges) {
  const doorsPrev = Array.isArray(pl.doorEdges) ? pl.doorEdges.slice() : null;
  try {
    const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(pl.unitId)}`, {
      method: 'PUT',
      body: JSON.stringify({ x: pl.x, y: pl.y, width: pl.width, height: pl.height, stackTier: pl.stackTier || 0, doorEdges: edges }),
    });
    pl.doorEdges = res && res.data ? res.data.doorEdges : edges;
    fpPushUndo({ kind: 'placement', unitId: pl.unitId, prev: { x: pl.x, y: pl.y, width: pl.width, height: pl.height, stackTier: pl.stackTier || 0, doorEdges: doorsPrev } });
    fpRenderSelInfo();
    fpRenderCanvas();
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
  if (fpGuardLocked(pl)) return; // live occupied placement: doors frozen
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
  if (fpGuardLocked(pl)) return; // live occupied placement: doors frozen
  await fpSaveDoors(pl, null);
}

// Unplaced lockers whose footprint (either orientation) exactly matches the
// selected block's rect — i.e. units that could stack onto it as upper tier.
function fpStackCandidates(pl) {
  return state.fp.unplaced.filter((u) => {
    if (String(u.sizeCode || '').toUpperCase() !== 'LOCKER') return false;
    const fp = sizeFootprint(u.sizeCode, u.sqft);
    return (ftEquals(fp.w, pl.width) && ftEquals(fp.h, pl.height)) || (ftEquals(fp.w, pl.height) && ftEquals(fp.h, pl.width));
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
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(cand.id)}`, {
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
      hasPillar: cand.hasPillar === true,
    });
    fpPushUndo({ kind: 'placement', unitId: cand.id, prev: null }); // undo = DELETE the stacked upper tier
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
  const upperPrev = { x: upper.x, y: upper.y, width: upper.width, height: upper.height, stackTier: 1, doorEdges: upper.doorEdges || null };
  try {
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(upper.unitId)}`, {
      method: 'DELETE',
    });
    fpPushUndo({ kind: 'placement', unitId: upper.unitId, prev: upperPrev }); // undo = re-PUT the upper tier
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
    title.textContent = 'Floor Plan Designer' + (where ? ' — ' + where : '');
  }
  const sub = $('#fpSub');
  if (sub) {
    const unitLabel = `${state.fp.placements.length} unit${state.fp.placements.length === 1 ? '' : 's'}`;
    const blockLabel = `${state.fp.blocks.length} block${state.fp.blocks.length === 1 ? '' : 's'}`;
    const markerLabel = `${(state.fp.markers || []).length} marker${(state.fp.markers || []).length === 1 ? '' : 's'}`;
    sub.textContent = state.fp.plan
      ? `${unitLabel} placed · ${blockLabel} · ${markerLabel} on a ${d.w}×${d.h} ft canvas — drag to move, corner handle to resize`
      : "No plan yet — set a canvas size and click Save Canvas, then drag this floor's units from the palette.";
  }
  fpSyncDimInputs(d);
  fpSyncGfaInput();
  fpRenderBoundaryMetrics();
  const st = $('#fpStructure');
  if (st) st.value = state.fp.structure ? JSON.stringify(state.fp.structure, null, 2) : '';
  const legacy = $('#fpLegacyNote');
  if (legacy) {
    legacy.hidden = !state.fp.structure;
  }
  fpRenderPalette();
  fpRenderCanvas();
  fpRenderSelInfo();
  fpRenderPlanStatus();
  fpRenderSaveStatus(); // pending-publish counts follow the plan
  fpSyncModeUI();
}

// Snapped decimal-ft canvas position for a pointer (top-left anchor of a
// dragged rect). `ev` (optional) supplies the Alt fine-snap modifier.
function fpCanvasCellAt(clientX, clientY, ev) {
  const canvas = $('#fpCanvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const u = fpPx();
  const rawX = (clientX - rect.left) / u;
  const rawY = (clientY - rect.top) / u;
  const { w: cw, h: ch } = fpCanvasDims();
  if (rawX < -0.5 || rawY < -0.5 || rawX >= cw || rawY >= ch) return null;
  const step = fpSnapStep(ev);
  return { gx: Math.max(0, snapFt(rawX, step)), gy: Math.max(0, snapFt(rawY, step)) };
}

// Nearest snapped decimal-ft point for a pointer position, clamped into the
// canvas with edges INCLUSIVE (0..w / 0..h — boundary vertices may sit on the
// canvas edge, same contract as checkBoundaryPoints in src/core/floorPlans.ts).
function fpCanvasPointAt(clientX, clientY, ev) {
  const canvas = $('#fpCanvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const u = fpPx();
  const { w: cw, h: ch } = fpCanvasDims();
  const step = fpSnapStep(ev);
  return {
    x: clampFt(snapFt((clientX - rect.left) / u, step), 0, cw),
    y: clampFt(snapFt((clientY - rect.top) / u, step), 0, ch),
  };
}

// ---------- pro line tool (precision Phase 3) ----------
// Pen: click to add vertices (rubber band with live length / angle), double-
// click or Enter to finish open, click the first vertex or press C to close,
// Backspace removes the last vertex, Esc cancels. Typing a number while
// drawing sets the next segment's LENGTH (Tab switches to ANGLE, CAD
// convention 0° = east, 90° = north) and Enter places it. Press-and-drag still
// draws a single straight segment (the original gesture). Shift = 0/45/90°.
// Every point snaps to objects (line endpoints / midpoints / edges, unit and
// block corners / edge midpoints / edges) within ~10 px, else to the grid.
// New lines are always BOUNDARY (labelled "Wall" in the UI). Selected lines show vertex handles (drag to move, drag a midpoint
// to insert, Delete removes the selected vertex). The measure tool (M) shows
// a temporary dimension between two snapped points.

let fpPen = null; // { points: [[x,y]...], cursor: [x,y]|null, len: '', ang: '', field: 'len'|'ang' }
let fpSnapHint = null; // { x, y, type } — current object-snap indicator
let fpMeasure = null; // { a: [x,y], b: [x,y], done: boolean }
const FP_SNAP_RADIUS_PX = 10;
// The draw tool only makes walls. A wall that counts toward floor area is
// stored as BOUNDARY; an interior wall ("Counts toward floor area" off in the
// inspector) is stored as PARTITION, which never feeds UFA/NLA. WALL / GUIDE
// are legacy kinds kept for display of existing rows.
const FP_LINE_KIND_LABELS = { BOUNDARY: 'Wall', PARTITION: 'Wall', WALL: 'Thick wall', GUIDE: 'Guide' };

function fpResetPen() {
  fpPen = null;
  fpSnapHint = null;
}

function fpPenKind() {
  return 'BOUNDARY'; // new lines are always walls (marked-area lines)
}

function fpLineKindLabel(kind) {
  const k = String(kind || '').toUpperCase();
  return FP_LINE_KIND_LABELS[k] || (k === 'PENCIL' ? 'Wall' : 'Line');
}

// Unsnapped pointer position in feet, clamped onto the canvas.
function fpCanvasRawAt(clientX, clientY) {
  const canvas = $('#fpCanvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const u = fpPx();
  const { w: cw, h: ch } = fpCanvasDims();
  return [
    Math.min(Math.max(0, (clientX - rect.left) / u), cw),
    Math.min(Math.max(0, (clientY - rect.top) / u), ch),
  ];
}

/**
 * Snap a raw feet position: nearest object snap within FP_SNAP_RADIUS_PX
 * (priority endpoint > corner > midpoint > on-edge, then distance), else the
 * snap-step grid. `opts.skip` = { boundaryId, index } excludes one vertex (the
 * one being dragged); `opts.extra` = extra endpoint candidates (pen vertices).
 */
function fpObjectSnap(raw, ev, opts = {}) {
  const { w: cw, h: ch } = fpCanvasDims();
  const radius = FP_SNAP_RADIUS_PX / fpPx();
  let best = null;
  const consider = (x, y, type, prio) => {
    const d = Math.hypot(raw[0] - x, raw[1] - y);
    if (d > radius) return;
    if (!best || prio < best.prio || (prio === best.prio && d < best.d)) best = { x, y, type, prio, d };
  };
  if (state.fp.objSnap !== false) {
    for (const [x, y] of opts.extra || []) consider(x, y, 'endpoint', 0);
    for (const b of fpLayerHidden('lines') ? [] : state.fp.boundaries || []) {
      const pts = fpBoundaryPoints(b.points);
      const segs = [];
      for (let i = 0; i < pts.length; i++) {
        const skipped = opts.skip && opts.skip.boundaryId === b.id && opts.skip.index === i;
        if (!skipped) consider(pts[i][0], pts[i][1], 'endpoint', 0);
        if (i > 0) segs.push([i - 1, i]);
      }
      if (b.closed && pts.length > 2) segs.push([pts.length - 1, 0]);
      for (const [i, j] of segs) {
        if (opts.skip && opts.skip.boundaryId === b.id && (opts.skip.index === i || opts.skip.index === j)) continue;
        const a = pts[i];
        const c = pts[j];
        consider((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, 'midpoint', 2);
        const n = nearestOnSegment(raw, a, c);
        consider(n.x, n.y, 'edge', 3);
      }
    }
    for (const r of (fpLayerHidden('units') ? [] : state.fp.placements).concat(fpLayerHidden('blocks') ? [] : state.fp.blocks)) {
      const x0 = r.x;
      const y0 = r.y;
      const x1 = quantizeFt(r.x + r.width);
      const y1 = quantizeFt(r.y + r.height);
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      corners.forEach(([x, y]) => consider(x, y, 'corner', 1));
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const c = corners[(i + 1) % 4];
        consider((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, 'midpoint', 2);
        const n = nearestOnSegment(raw, a, c);
        consider(n.x, n.y, 'edge', 3);
      }
    }
  }
  if (best) return { x: clampFt(best.x, 0, cw), y: clampFt(best.y, 0, ch), type: best.type };
  const step = fpSnapStep(ev);
  return { x: clampFt(snapFt(raw[0], step), 0, cw), y: clampFt(snapFt(raw[1], step), 0, ch), type: 'grid' };
}

// Snapped point for a pen / measure / vertex interaction. Shift constrains to
// 0/45/90° from `anchor` (grid-snapped length, no object snap).
function fpSnapPointer(ev, anchor, opts) {
  const raw = fpCanvasRawAt(ev.clientX, ev.clientY);
  if (!raw) return null;
  if (ev.shiftKey && anchor) {
    const { w: cw, h: ch } = fpCanvasDims();
    const step = fpSnapStep(ev);
    const c = fpConstrainLine(anchor[0], anchor[1], snapFt(raw[0], step), snapFt(raw[1], step), step);
    return { x: clampFt(c.x, 0, cw), y: clampFt(c.y, 0, ch), type: 'ortho' };
  }
  return fpObjectSnap(raw, ev, opts);
}

const fpSamePt = (a, b) => !!a && !!b && ftEquals(a[0], b[0]) && ftEquals(a[1], b[1]);

// Where the next vertex would land: typed length (+ optional typed angle)
// from the last vertex, else the snapped cursor.
function fpPenPreviewPoint() {
  if (!fpPen || !fpPen.points.length) return null;
  const last = fpPen.points[fpPen.points.length - 1];
  const len = fpParseLen(fpPen.len);
  if (len !== null && len > 0) {
    const typedAng = fpPen.ang.trim() === '' ? null : Number(fpPen.ang);
    const dir = typedAng !== null && Number.isFinite(typedAng)
      ? typedAng
      : fpPen.cursor && !fpSamePt(fpPen.cursor, last) ? angleDeg(last, fpPen.cursor) : 0;
    const { w: cw, h: ch } = fpCanvasDims();
    const p = pointAtAngle(last, len, dir);
    const q = [clampFt(p[0], 0, cw), clampFt(p[1], 0, ch)];
    fpPen.clamped = !fpSamePt(p, q); // typed segment ran past the canvas edge
    return q;
  }
  fpPen.clamped = false;
  return fpPen.cursor;
}

// Place the typed-length vertex; warn when the canvas edge cut it short.
function fpPenPlaceTyped() {
  const pt = fpPenPreviewPoint();
  const clamped = fpPen.clamped;
  fpPenAdd(pt);
  if (clamped) {
    const { w: cw, h: ch } = fpCanvasDims();
    fpToast(`That segment ran past the ${formatFt(cw)}×${formatFt(ch)} ft canvas — the vertex was stopped at the edge (${formatFt(pt[0])}, ${formatFt(pt[1])}). Enlarge the canvas for the full length.`, false);
  }
}

function fpPenReadout() {
  if (!fpPen) return;
  const last = fpPen.points[fpPen.points.length - 1];
  const next = fpPenPreviewPoint();
  const seg = last && next ? segmentLengthFt(last, next) : 0;
  const ang = last && next && !fpSamePt(last, next) ? angleDeg(last, next) : null;
  const total = polylineLengthFt(fpPen.points) + seg;
  const field = (name, key, unit) => {
    const val = fpPen[key];
    return `${name} ${fpPen.field === key ? '[' + (val || '…') + '▌]' : val ? '[' + val + ']' : '—'}${unit}`;
  };
  fpSetReadout(
    `${fpLineKindLabel(fpPenKind())} · ${fpPen.points.length} pt · seg ${formatFt(Math.round(seg * 100) / 100)} ft` +
      (ang !== null ? ` ∠ ${Math.round(ang * 10) / 10}°` : '') +
      ` · total ${formatFt(Math.round(total * 100) / 100)} ft · ` +
      field('Length', 'len', ' ft') + ' ' + field('Angle', 'ang', '°') +
      (fpSnapHint && fpSnapHint.type !== 'grid' ? ` · snap ${fpSnapHint.type}` : ''),
  );
}

// Add a vertex to the pen (ignores a repeat of the last vertex).
function fpPenAdd(p) {
  if (!fpPen) fpPen = { points: [], cursor: p, len: '', ang: '', field: 'len' };
  const last = fpPen.points[fpPen.points.length - 1];
  if (fpSamePt(last, p)) return;
  fpPen.points.push([p[0], p[1]]);
  fpPen.len = '';
  fpPen.ang = '';
  fpPen.field = 'len';
}

// Finish the pen: persist as a new line item (closed loop when requested).
async function fpFinishPen(closed) {
  const pen = fpPen;
  fpResetPen();
  if (!pen) return;
  const pts = [];
  for (const p of pen.points) if (!fpSamePt(pts[pts.length - 1], p)) pts.push(p);
  if (closed && pts.length > 1 && fpSamePt(pts[0], pts[pts.length - 1])) pts.pop();
  const distinct = new Set(pts.map(([x, y]) => `${toMilli(x)},${toMilli(y)}`)).size;
  if (pts.length < 2) {
    fpRenderCanvas();
    fpSetReadout('');
    return;
  }
  const close = closed && distinct >= 3;
  const kind = fpPenKind();
  const body = { label: fpLineKindLabel(kind), kind, points: pts, closed: close };
  if (kind === 'WALL') body.thickness = Number(state.fp.wallThickness) || DEFAULT_WALL_THICKNESS_FT;
  try {
    const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/boundaries`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const b = res.data;
    // The plan is lazily created server-side when a floor has none yet (same
    // lazy adoption as fpAddBlock) — give the new line a local surface.
    if (!state.fp.plan) {
      state.fp.plan = { width: state.fp.canvasDefaults.width, height: state.fp.canvasDefaults.height };
    }
    fpPushUndo({ kind: 'boundary', boundaryId: b.id, prev: null }); // undo = DELETE the drawn line
    state.fp.boundaries.push(fpNormalizeBoundary(b));
    state.fp.selectedBoundary = b.id;
    state.fp.selectedVertex = null;
    state.fp.selected = null;
    state.fp.selectedBlock = null;
    fpRender();
    if (lineFeedsArea(kind)) notifyMetricsFloorChanged();
    const len = polylineLengthFt(pts, close);
    fpToast(
      `${fpLineKindLabel(kind)} added — ${pts.length} vertices, ${formatFt(Math.round(len * 100) / 100)} ft${close ? ', closed loop' : ''}.` +
        (lineFeedsArea(kind) && !close && pts.length < 3 ? ' Add a 3rd vertex or close the loop so it feeds UFA/NLA.' : ''),
      true,
    );
  } catch (err) {
    fpRenderCanvas();
    fpToast('Draw line: ' + describeError(err), false);
  }
  fpSetReadout('');
}

// Canvas pointerdown while the line tool is on.
function fpPenPointerDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const anchor = fpPen && fpPen.points.length ? fpPen.points[fpPen.points.length - 1] : null;
  const s = fpSnapPointer(e, anchor, { extra: fpPen ? fpPen.points : [] });
  if (!s) return;
  const p = [s.x, s.y];
  state.fp.selected = null;
  state.fp.selectedBlock = null;
  state.fp.selectedMarker = null;
  state.fp.selectedBoundary = null;
  state.fp.selectedVertex = null;
  if (fpPen && fpPen.points.length) {
    // Typed length pending: a click places the typed point instead.
    const typed = fpParseLen(fpPen.len);
    if (typed !== null && typed > 0) {
      fpPenPlaceTyped();
    } else if (fpPen.points.length >= 3 && fpSamePt(p, fpPen.points[0])) {
      fpFinishPen(true);
      return;
    } else if (fpSamePt(p, fpPen.points[fpPen.points.length - 1])) {
      if (e.detail >= 2 && fpPen.points.length >= 2) fpFinishPen(false); // double-click finishes open
      return;
    } else {
      fpPenAdd(p);
    }
    fpRenderCanvas();
    fpPenReadout();
    return;
  }
  // First vertex. A press-and-drag (> 5 px) instead draws one straight segment.
  fpPenAdd(p);
  const downX = e.clientX;
  const downY = e.clientY;
  const up = (ev) => {
    document.removeEventListener('pointerup', up);
    if (!fpPen || fpPen.points.length !== 1) return;
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) <= 5) return; // a click: keep drawing
    const end = fpSnapPointer(ev, fpPen.points[0], { extra: fpPen.points });
    if (end && !fpSamePt([end.x, end.y], fpPen.points[0])) {
      fpPen.points.push([end.x, end.y]);
      fpFinishPen(false);
    }
  };
  document.addEventListener('pointerup', up);
  fpRenderCanvas();
  fpPenReadout();
}

// Hover while the line / measure tool is on: rubber band + snap indicator.
function fpPenHover(e) {
  if (state.fp.measureMode) {
    const s = fpSnapPointer(e, fpMeasure && !fpMeasure.done ? fpMeasure.a : null);
    if (!s) return;
    fpSnapHint = s;
    if (fpMeasure && !fpMeasure.done) fpMeasure.b = [s.x, s.y];
    fpRenderCanvas();
    fpMeasureReadout(s);
    return;
  }
  if (!state.fp.drawMode) return;
  const anchor = fpPen && fpPen.points.length ? fpPen.points[fpPen.points.length - 1] : null;
  const s = fpSnapPointer(e, anchor, { extra: fpPen ? fpPen.points : [] });
  if (!s) return;
  fpSnapHint = s;
  if (fpPen) {
    fpPen.cursor = [s.x, s.y];
    fpRenderCanvas();
    fpPenReadout();
  } else {
    fpRenderCanvas();
    fpSetReadout(`x ${formatFt(s.x)} · y ${formatFt(s.y)} ft${s.type !== 'grid' ? ` · snap ${s.type}` : ''} · click to start a ${fpLineKindLabel(fpPenKind()).toLowerCase()}`);
  }
}

// Keyboard while the pen is active (registered once in fpInitEvents).
function fpPenKey(e) {
  if (!fpPen || !state.fp.drawMode || e.metaKey || e.ctrlKey) return;
  const t = e.target;
  if (t && typeof t.closest === 'function' && t.closest('input, textarea, select, [contenteditable]')) return;
  const k = e.key;
  const buf = fpPen.field === 'ang' ? 'ang' : 'len';
  if (/^[0-9.]$/.test(k) || (k === '-' && buf === 'ang' && !fpPen.ang)) {
    fpPen[buf] += k;
  } else if (k === 'Tab') {
    fpPen.field = fpPen.field === 'len' ? 'ang' : 'len';
  } else if (k === 'Backspace') {
    if (fpPen[buf]) fpPen[buf] = fpPen[buf].slice(0, -1);
    else if (fpPen.len || fpPen.ang) fpPen[buf === 'len' ? 'ang' : 'len'] = '';
    else if (fpPen.points.length > 1) fpPen.points.pop();
    else fpResetPen();
  } else if (k === 'Enter') {
    const typed = fpParseLen(fpPen.len);
    if (typed !== null && typed > 0) fpPenPlaceTyped();
    else if (fpPen.points.length >= 2) {
      e.preventDefault();
      e.stopImmediatePropagation();
      fpFinishPen(false);
      return;
    }
  } else if (k === 'Escape') {
    if (fpPen.len || fpPen.ang) {
      fpPen.len = '';
      fpPen.ang = '';
    } else fpResetPen();
  } else if ((k === 'c' || k === 'C') && fpPen.points.length >= 3) {
    e.preventDefault();
    e.stopImmediatePropagation();
    fpFinishPen(true);
    return;
  } else {
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation(); // keep Delete / arrow / tool shortcuts away from the pen
  fpRenderCanvas();
  if (fpPen) fpPenReadout();
  else fpSetReadout('Line cancelled.');
}

// ---------- measure tool ----------

function fpMeasureReadout(s) {
  if (!fpMeasure) {
    fpSetReadout(`Measure · click the first point${s && s.type !== 'grid' ? ` · snap ${s.type}` : ''}`);
    return;
  }
  const { a, b } = fpMeasure;
  const len = segmentLengthFt(a, b);
  const ang = fpSamePt(a, b) ? 0 : angleDeg(a, b);
  fpSetReadout(
    `Measure ${formatFt(Math.round(len * 100) / 100)} ft ∠ ${Math.round(ang * 10) / 10}° · Δx ${formatFt(Math.round(Math.abs(b[0] - a[0]) * 100) / 100)} · Δy ${formatFt(Math.round(Math.abs(b[1] - a[1]) * 100) / 100)} ft` +
      (fpMeasure.done ? ' · click to measure again, Esc clears' : ''),
  );
}

function fpMeasurePointerDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const s = fpSnapPointer(e, fpMeasure && !fpMeasure.done ? fpMeasure.a : null);
  if (!s) return;
  const p = [s.x, s.y];
  if (!fpMeasure || fpMeasure.done) fpMeasure = { a: p, b: p, done: false };
  else fpMeasure = { a: fpMeasure.a, b: p, done: true };
  fpRenderCanvas();
  fpMeasureReadout(s);
}

function fpSetMeasureMode(on) {
  state.fp.measureMode = !!on;
  fpMeasure = null;
  fpSnapHint = null;
  if (on) {
    state.fp.drawMode = false;
    fpResetPen();
    state.fp.armedMarker = null;
    fpRenderMarkerTools();
    const pencil = $('#fpBoundaryTool');
    if (pencil) {
      pencil.classList.remove('on');
      pencil.setAttribute('aria-pressed', 'false');
    }
  }
  const btn = $('#fpMeasureTool');
  if (btn) {
    btn.classList.toggle('on', !!on);
    btn.setAttribute('aria-pressed', String(!!on));
  }
  state.fp.tool = on ? 'measure' : state.fp.tool === 'measure' ? 'select' : state.fp.tool;
  fpRenderCanvas();
  fpSyncModeUI();
  fpSetReadout(on ? 'Measure · click the first point' : '');
}

// ---------- vertex editing (selected line) ----------

function fpSelectedBoundary() {
  return (state.fp.boundaries || []).find((b) => b.id === state.fp.selectedBoundary) || null;
}

// Vertex / midpoint handle under the pointer for the selected line, or null.
function fpVertexHitAt(clientX, clientY) {
  const bnd = fpSelectedBoundary();
  if (!bnd) return null;
  const raw = fpCanvasRawAt(clientX, clientY);
  if (!raw) return null;
  const tol = 8 / fpPx();
  const pts = fpBoundaryPoints(bnd.points);
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(raw[0] - pts[i][0], raw[1] - pts[i][1]) <= tol) return { bnd, type: 'vertex', index: i };
  }
  const segs = pts.length > 1 ? pts.slice(1).map((p, i) => [i, i + 1]) : [];
  if (bnd.closed && pts.length > 2) segs.push([pts.length - 1, 0]);
  for (const [i, j] of segs) {
    const mx = (pts[i][0] + pts[j][0]) / 2;
    const my = (pts[i][1] + pts[j][1]) / 2;
    if (Math.hypot(raw[0] - mx, raw[1] - my) <= tol) return { bnd, type: 'mid', index: i, insertAt: j === 0 ? pts.length : j };
  }
  return null;
}

// PUT a line patch, adopt the server's row, record undo and re-render.
async function fpPersistBoundary(bnd, patch, prev, verb) {
  try {
    const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/boundaries/${encodeURIComponent(bnd.id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    Object.assign(bnd, fpNormalizeBoundary(res.data));
    if (prev) fpPushUndo({ kind: 'boundary', boundaryId: bnd.id, prev });
    fpRender();
    notifyMetricsFloorChanged();
    fpToast(`${verb} ${fpLineKindLabel(bnd.kind).toLowerCase()} "${bnd.label || 'Line'}".`, true);
    return true;
  } catch (err) {
    fpToast(`${verb} line: ${describeError(err)}`, false);
    await fpFetch();
    return false;
  }
}

function fpBoundaryUndoPrev(bnd) {
  return { points: fpBoundaryPoints(bnd.points), closed: !!bnd.closed, kind: bnd.kind, label: bnd.label, thickness: bnd.thickness ?? null };
}

// Drag a vertex (or a midpoint, which inserts a vertex first) of the selected line.
function fpVertexStartDrag(e, hit) {
  e.preventDefault();
  const bnd = hit.bnd;
  const prev = fpBoundaryUndoPrev(bnd);
  let pts = fpBoundaryPoints(bnd.points);
  let index = hit.index;
  if (hit.type === 'mid') {
    const a = pts[hit.index];
    const b = pts[hit.insertAt % pts.length];
    pts.splice(hit.insertAt, 0, [quantizeFt((a[0] + b[0]) / 2), quantizeFt((a[1] + b[1]) / 2)]);
    index = hit.insertAt;
  }
  bnd.points = pts;
  state.fp.selectedVertex = index;
  const downX = e.clientX;
  const downY = e.clientY;
  let moved = hit.type === 'mid';
  const neighbour = () => (index > 0 ? pts[index - 1] : bnd.closed ? pts[pts.length - 1] : pts[index + 1]);
  fpRenderCanvas();
  fpRenderSelInfo();
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - downX, ev.clientY - downY) <= 3) return;
    moved = true;
    const s = fpSnapPointer(ev, neighbour(), { skip: { boundaryId: bnd.id, index } });
    if (!s) return;
    fpSnapHint = s;
    pts[index] = [s.x, s.y];
    bnd.points = pts;
    fpRenderCanvas();
    fpSetReadout(`Vertex ${index + 1} → ${formatFt(s.x)}, ${formatFt(s.y)} ft${s.type !== 'grid' ? ` · snap ${s.type}` : ''}`);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    fpSnapHint = null;
    if (!moved) {
      fpRenderCanvas();
      fpRenderSelInfo(); // a click just selects the vertex
      return;
    }
    fpPersistBoundary(bnd, { points: pts, closed: !!bnd.closed }, prev, hit.type === 'mid' ? 'Added a vertex to' : 'Moved a vertex of');
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// Delete the selected vertex (keeps >= 2 vertices; a closed loop that would
// drop below 3 distinct vertices re-opens).
function fpDeleteSelectedVertex() {
  const bnd = fpSelectedBoundary();
  const i = state.fp.selectedVertex;
  if (!bnd || i == null) return false;
  const pts = fpBoundaryPoints(bnd.points);
  if (pts.length <= 2) {
    fpToast('A line needs at least 2 vertices — remove the whole line instead.', false);
    return true;
  }
  const prev = fpBoundaryUndoPrev(bnd);
  pts.splice(i, 1);
  const closed = !!bnd.closed && pts.length >= 3;
  state.fp.selectedVertex = null;
  fpPersistBoundary(bnd, { points: pts, closed }, prev, 'Removed a vertex from');
  return true;
}

// Inspector edits for the selected line (label / kind / thickness / vertex X·Y).
function fpCommitLineField(input) {
  const bnd = fpSelectedBoundary();
  if (!bnd) return;
  const prev = fpBoundaryUndoPrev(bnd);
  const field = input.dataset.fpLine;
  if (field === 'label') {
    const label = input.value.trim();
    if (!label || label === bnd.label) {
      input.value = bnd.label || '';
      return;
    }
    fpPersistBoundary(bnd, { label: label.slice(0, 80) }, prev, 'Renamed');
  } else if (field === 'counts') {
    const kind = input.checked ? 'BOUNDARY' : 'PARTITION';
    if (kind === String(bnd.kind || '').toUpperCase() || (input.checked && lineFeedsArea(bnd.kind))) return;
    fpPersistBoundary(bnd, { kind }, prev, input.checked ? 'Counted the area of' : 'Stopped counting the area of');
  } else if (field === 'kind') {
    const kind = String(input.value || 'BOUNDARY').toUpperCase();
    if (kind === String(bnd.kind || '').toUpperCase()) return;
    const patch = { kind };
    if (kind === 'WALL') patch.thickness = bnd.thickness || Number(state.fp.wallThickness) || DEFAULT_WALL_THICKNESS_FT;
    fpPersistBoundary(bnd, patch, prev, 'Changed');
  } else if (field === 'thickness') {
    const v = fpParseLen(input.value);
    if (v === null || v < MIN_WALL_THICKNESS_FT || v > MAX_WALL_THICKNESS_FT) {
      fpToast(`Wall thickness must be ${MIN_WALL_THICKNESS_FT}–${MAX_WALL_THICKNESS_FT} ft.`, false);
      input.value = formatFt(bnd.thickness || DEFAULT_WALL_THICKNESS_FT);
      return;
    }
    if (ftEquals(v, bnd.thickness || 0)) return;
    state.fp.wallThickness = v; // next walls default to the last thickness used
    fpPersistBoundary(bnd, { thickness: v }, prev, 'Re-thickened');
  } else if (field === 'vx' || field === 'vy') {
    const i = state.fp.selectedVertex;
    const pts = fpBoundaryPoints(bnd.points);
    if (i == null || !pts[i]) return;
    const v = fpParseLen(input.value);
    const { w: cw, h: ch } = fpCanvasDims();
    const max = field === 'vx' ? cw : ch;
    if (v === null || v < 0 || v > max) {
      fpToast(`Vertex ${field === 'vx' ? 'X' : 'Y'} must be between 0 and ${formatFt(max)} ft.`, false);
      input.value = formatFt(pts[i][field === 'vx' ? 0 : 1]);
      return;
    }
    if (ftEquals(v, pts[i][field === 'vx' ? 0 : 1])) return;
    pts[i] = field === 'vx' ? [v, pts[i][1]] : [pts[i][0], v];
    fpPersistBoundary(bnd, { points: pts, closed: !!bnd.closed }, prev, 'Moved a vertex of');
  }
}

// Shared row normaliser for boundary payloads (list + POST/PUT responses).
function fpNormalizeBoundary(b) {
  return {
    id: b.id,
    label: b.label === 'Boundary' ? 'Wall' : b.label, // old default name, now "Wall"
    kind: b.kind,
    points: fpBoundaryPoints(b.points),
    closed: !!b.closed,
    sortOrder: b.sortOrder || 0,
    thickness: b.thickness ?? null,
  };
}

// Overlay drawn on top of the boundary layer: pen rubber band, snap
// indicator, measure dimension, selected-line handles.
function fpRenderPenOverlay(svg, u) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = text;
    svg.appendChild(n);
    return n;
  };
  const P = ([x, y]) => `${x * u},${y * u}`;
  const label = (x, y, text) => el('text', { x: x * u + 6, y: y * u - 6, class: 'fp-dim-label' }, text);
  // Selected line: vertex + midpoint handles.
  const bnd = fpSelectedBoundary();
  if (bnd && !state.fp.drawMode && !state.fp.measureMode) {
    const pts = fpBoundaryPoints(bnd.points);
    const segs = pts.length > 1 ? pts.slice(1).map((p, i) => [i, i + 1]) : [];
    if (bnd.closed && pts.length > 2) segs.push([pts.length - 1, 0]);
    for (const [i, j] of segs) {
      const mx = (pts[i][0] + pts[j][0]) / 2;
      const my = (pts[i][1] + pts[j][1]) / 2;
      el('rect', { x: mx * u - 3.5, y: my * u - 3.5, width: 7, height: 7, class: 'fp-mid-handle' });
      const len = segmentLengthFt(pts[i], pts[j]);
      if (len * u > 40) el('text', { x: mx * u, y: my * u - 8, class: 'fp-dim-label', 'text-anchor': 'middle' }, `${formatFt(Math.round(len * 100) / 100)}′`);
    }
    pts.forEach((p, i) => el('circle', { cx: p[0] * u, cy: p[1] * u, r: i === state.fp.selectedVertex ? 6 : 4.5, class: 'fp-vertex-handle' + (i === state.fp.selectedVertex ? ' on' : '') }));
  }
  // Pen rubber band.
  if (fpPen && fpPen.points.length) {
    const pts = fpPen.points;
    // Live area preview: an area-feeding in-progress line (BOUNDARY / legacy
    // PENCIL / unknown kinds) with >= 3 vertices and nonzero chord-closed
    // area shows its green interior as-you-draw (the same wash class as
    // persisted loop interiors, under the pen stroke). WALL / PARTITION /
    // GUIDE never mark area so they get no fill; a 2-vertex stroke encloses
    // nothing so it shows none (0-area rule). Points stay decimal feet —
    // fpPolygonArea runs on the raw values, no rounding.
    if (pts.length >= 3 && lineFeedsArea(fpPenKind()) && fpPolygonArea(pts) > 0) {
      el('polygon', { points: pts.map(P).join(' '), class: 'fp-usable-fill' });
    }
    if (pts.length > 1) el('polyline', { points: pts.map(P).join(' '), class: 'fp-pen-line' });
    const next = fpPenPreviewPoint();
    const last = pts[pts.length - 1];
    if (next && !fpSamePt(next, last)) {
      el('line', { x1: last[0] * u, y1: last[1] * u, x2: next[0] * u, y2: next[1] * u, class: 'fp-pen-rubber' });
      const len = segmentLengthFt(last, next);
      label((last[0] + next[0]) / 2, (last[1] + next[1]) / 2, `${formatFt(Math.round(len * 100) / 100)} ft ∠ ${Math.round(angleDeg(last, next) * 10) / 10}°`);
    }
    pts.forEach((p, i) => el('circle', { cx: p[0] * u, cy: p[1] * u, r: i === 0 && pts.length >= 3 ? 6 : 3.5, class: 'fp-pen-vertex' + (i === 0 && pts.length >= 3 ? ' close' : '') }));
  }
  // Measure dimension.
  if (fpMeasure) {
    const { a, b } = fpMeasure;
    el('line', { x1: a[0] * u, y1: a[1] * u, x2: b[0] * u, y2: b[1] * u, class: 'fp-measure-line' });
    [a, b].forEach((p) => el('circle', { cx: p[0] * u, cy: p[1] * u, r: 3, class: 'fp-measure-end' }));
    if (!fpSamePt(a, b)) label((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, `${formatFt(Math.round(segmentLengthFt(a, b) * 100) / 100)} ft`);
  }
  // Snap indicator: square = endpoint/corner, triangle = midpoint, × = on edge.
  if (fpSnapHint && (state.fp.drawMode || state.fp.measureMode || fpSnapHint.type !== 'grid')) {
    const x = fpSnapHint.x * u;
    const y = fpSnapHint.y * u;
    const t = fpSnapHint.type;
    if (t === 'endpoint' || t === 'corner') el('rect', { x: x - 5, y: y - 5, width: 10, height: 10, class: 'fp-snap-mark' });
    else if (t === 'midpoint') el('polygon', { points: `${x},${y - 6} ${x + 6},${y + 5} ${x - 6},${y + 5}`, class: 'fp-snap-mark' });
    else if (t === 'edge') el('path', { d: `M${x - 5},${y - 5}L${x + 5},${y + 5}M${x + 5},${y - 5}L${x - 5},${y + 5}`, class: 'fp-snap-mark' });
    else el('circle', { cx: x, cy: y, r: 3, class: 'fp-snap-mark grid' });
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
    // A closed loop's closing edge (last → first vertex) is clickable too.
    const ring = b.closed && pts.length > 2 ? pts.concat([pts[0]]) : pts;
    for (let i = 1; i < ring.length; i++) {
      const x1 = ring[i - 1][0] * u;
      const y1 = ring[i - 1][1] * u;
      const x2 = ring[i][0] * u;
      const y2 = ring[i][1] * u;
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

// Adopt the server's view of a saved placement (PUT /floor-plans/:floorId/
// units/:unitId returns the serialized placement): the pending-size flag and,
// for DRAFT units, the sqft / tier the server just derived from the drawing.
// Without this the Δ tag, the save chip and the inspector kept showing the
// pre-resize state, and committing the stale W/H fields wrote the old size back.
function fpAdoptPlacement(pl, data) {
  if (!pl || !data) return;
  pl.areaDirty = data.areaDirty === true;
  if (data.unit) {
    pl.sqft = data.unit.sqft;
    pl.status = String(data.unit.status || pl.status || '').toUpperCase();
    if (data.unit.size) {
      pl.sizeCode = data.unit.size.code;
      pl.sizeName = data.unit.size.name;
    }
  }
}

function fpRefreshAfterSave() {
  fpRenderCanvas();
  // Never rebuild the inspector under a field the operator is typing in.
  const info = $('#fpSelInfo');
  if (!(info && info.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName))) fpRenderSelInfo();
  fpRenderSaveStatus();
}

async function fpPersist(pl, verb) {
  const undoPrev = pl._undoPrev || null;
  pl._undoPrev = null;
  try {
    const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(pl.unitId)}`, {
      method: 'PUT',
      body: JSON.stringify({ x: pl.x, y: pl.y, width: pl.width, height: pl.height, stackTier: pl.stackTier || 0 }),
    });
    fpAdoptPlacement(pl, res && res.data);
    fpRefreshAfterSave();
    if (undoPrev) fpPushUndo({ kind: 'placement', unitId: pl.unitId, prev: { ...undoPrev, doorEdges: pl.doorEdges || null } });
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
  const undoPrevs = new Map([lower, upper].map((p) => [p.unitId, p._undoPrev || null]));
  lower._undoPrev = null;
  upper._undoPrev = null;
  try {
    for (const p of [lower, upper]) {
      const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(p.unitId)}`, {
        method: 'PUT',
        body: JSON.stringify({ x: p.x, y: p.y, width: p.width, height: p.height, stackTier: p.stackTier || 0 }),
      });
      fpAdoptPlacement(p, res && res.data);
    }
    fpRefreshAfterSave();
    for (const p of [lower, upper]) {
      const prev = undoPrevs.get(p.unitId);
      if (prev) fpPushUndo({ kind: 'placement', unitId: p.unitId, prev: { ...prev, doorEdges: p.doorEdges || null } });
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
  let x = clampFt(gx, 0, cw - footprint.w);
  let y = clampFt(gy, 0, ch - footprint.h);
  const unitIsLocker = String(unit.sizeCode || '').toUpperCase() === 'LOCKER';
  // Snap-to-stack: a dropped locker overlapping a lone ground locker of the
  // identical footprint snaps onto its exact rect so the Stack offer is precise.
  if (unitIsLocker) {
    const snap = state.fp.placements.find(
      (o) =>
        (o.stackTier || 0) === 0 &&
        !fpStackMate(o) &&
        fpIsLockerPlacement(o) &&
        ftEquals(o.width, footprint.w) &&
        ftEquals(o.height, footprint.h) &&
        rectsOverlapExact({ x, y, width: footprint.w, height: footprint.h }, o),
    );
    if (snap) {
      x = snap.x;
      y = snap.y;
    }
  }
  // Exact-rect drop: offer Stack for lone-locker-on-locker, explain otherwise.
  const exact = state.fp.placements.find(
    (o) => sameRect(o, { x, y, width: footprint.w, height: footprint.h }),
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
      await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(unit.id)}`, {
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
      fpCollapsePaletteAfterDrop(); // successful palette drop — the only auto-collapse besides the explicit toggle
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
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(unit.id)}`, {
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
      hasPillar: unit.hasPillar === true,
      x,
      y,
      width: footprint.w,
      height: footprint.h,
      stackTier: 0,
    });
    fpPushUndo({ kind: 'placement', unitId: unit.id, prev: null }); // undo = DELETE the dropped placement
    fpToast(`Placed ${unit.unitCode} → ${x},${y} · ${footprint.w}×${footprint.h} ft`, true);
    fpRender();
    fpCollapsePaletteAfterDrop(); // successful palette drop — the only auto-collapse besides the explicit toggle
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
    const cell = fpCanvasCellAt(rect.left, rect.top, ev);
    if (cell) fpPlaceUnit(unit, fp, cell.gx, cell.gy);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function fpStartMove(e, el) {
  const uid = el.dataset.unitId;
  const pl = state.fp.placements.find((p) => p.unitId === uid);
  if (!pl) return;
  if (fpGuardLocked(pl)) return; // live occupied placement: no drag
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
  pl._undoPrev = { x: pl.x, y: pl.y, width: pl.width, height: pl.height, stackTier: pl.stackTier || 0 };
  // A unit interaction supersedes any block/marker selection — otherwise the
  // info strip would keep showing the stale block while the operator is acting
  // on the unit (fpRenderSelInfo gives a selected block priority over a unit).
  state.fp.selectedBlock = null;
  state.fp.selectedMarker = null;
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
    const cell = fpCanvasCellAt(ev.clientX - offsetX, ev.clientY - offsetY, ev);
    if (!cell) return;
    let nx = clampFt(cell.gx, 0, cw - pl.width);
    let ny = clampFt(cell.gy, 0, ch - pl.height);
    // Shift = axis lock: keep the move on the dominant axis from the grab point.
    if (ev.shiftKey) {
      if (Math.abs(nx - orig[0].x) >= Math.abs(ny - orig[0].y)) ny = orig[0].y;
      else nx = orig[0].x;
    }
    for (const p of pair) {
      p.x = nx;
      p.y = ny;
    }
    fpRenderCanvas();
    fpSetReadout(`${pl.unitCode} → ${formatFt(nx)}, ${formatFt(ny)} ft`);
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
// the decimal rect that preserves area = sqft while staying on-canvas. Keeps
// the dragged width (snapped to `step`) and derives h = sqft / w at 0.001 ft;
// if that overflows the canvas height, pins h and re-derives w instead.
function fpSnapToSqft(w0, h0, sqft, cw, ch, ox, oy, step) {
  void h0;
  const maxW = Math.max(MIN_RECT_SIDE_FT, quantizeFt(cw - ox));
  const maxH = Math.max(MIN_RECT_SIDE_FT, quantizeFt(ch - oy));
  let w = clampFt(snapFt(w0, step), MIN_RECT_SIDE_FT, maxW);
  let h = Math.max(MIN_RECT_SIDE_FT, quantizeFt(sqft / w));
  if (h > maxH) {
    h = maxH;
    w = clampFt(quantizeFt(sqft / h), MIN_RECT_SIDE_FT, maxW);
  }
  return { w, h };
}

function fpStartResize(e, pl) {
  e.preventDefault();
  e.stopPropagation();
  if (fpGuardLocked(pl)) return; // live occupied placement: no resize
  if (state.fp.selected !== pl.unitId) {
    state.fp.selected = pl.unitId;
    state.fp.selectedBlock = null;
    state.fp.selectedMarker = null;
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
  pl._undoPrev = { x: origX, y: origY, width: origW, height: origH, stackTier: pl.stackTier || 0 };
  const { w: cw, h: ch } = fpCanvasDims();
  // A stacked pair resizes as one block (same-rect invariant) — the snap uses
  // the ground tier's sqft and every pointer move writes both tiers.
  const mate = fpStackMate(pl);
  const pair = mate ? [pl, mate].slice().sort((a, b) => (a.stackTier || 0) - (b.stackTier || 0)) : [pl];
  const pairIds = pair.map((p) => p.unitId);
  const move = (ev) => {
    const step = fpSnapStep(ev);
    const freeW = clampFt(snapFt(origW + (ev.clientX - startX) / u, step), fpMinSide(ev), cw - origX);
    const freeH = clampFt(snapFt(origH + (ev.clientY - startY) / u, step), fpMinSide(ev), ch - origY);
    let w;
    let h;
    if ((state.fp.lockSqft || pair.some(fpIsContracted)) && pl.sqft > 0) {
      const snapped = fpSnapToSqft(freeW, freeH, pair[0].sqft || pl.sqft, cw, ch, origX, origY, step);
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
    const nextSqft = fpSqftForRect({ width: w, height: h });
    const sizeNote = !fpSameSqft(nextSqft, pl.sqft) && !pair.some(fpIsContracted) ? ` → unit ${fpFmtArea(pl.sqft)} → ${fpFmtArea(nextSqft)} sqft on publish` : ` (unit ${fpFmtArea(pl.sqft)})`;
    fpSetReadout(`${pl.unitCode} ${formatFt(w)} × ${formatFt(h)} ft = ${fpFmtArea(rectAreaSqft({ width: w, height: h }))} sqft${sizeNote}`);
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
  if (fpGuardLocked(pl)) return; // live occupied placement: no rotate
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
  const nx = clampFt(pl.x, 0, cw - w);
  const ny = clampFt(pl.y, 0, ch - h);
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
  for (const p of pair) {
    p._undoPrev = { x: prev.find((o) => o.p === p).x, y: prev.find((o) => o.p === p).y, width: prev.find((o) => o.p === p).w, height: prev.find((o) => o.p === p).h, stackTier: p.stackTier || 0 };
  }
  if (!mate) await fpPersist(pl, 'Rotated');
  else await fpPersistPair(pair[0], pair[1], 'Rotated');
}

function fpToggleBlockForm(show) {
  const form = $('#fpBlockForm');
  if (!form) return;
  if (show) fpSetPaletteCollapsed(false);
  form.hidden = !show;
  if (show) {
    // A fresh form starts at the default tone; swatches re-render from the
    // staged state.fp.blockColor (null = default).
    state.fp.blockColor = null;
    fpRenderBlockFormSwatches();
    const input = $('#fpBlockName');
    if (input) {
      input.value = '';
      input.focus();
    }
  }
}

function fpFirstFreeSpot(size) {
  const { w: cw, h: ch } = fpCanvasDims();
  // Markers occupy a single grid-ft point each — count them as 1×1 obstacles so
  // a new block never spawns on top of a marker badge.
  const occupied = state.fp.blocks
    .concat(state.fp.placements)
    .concat((state.fp.markers || []).map((m) => ({ x: m.x, y: m.y, width: 1, height: 1 })));
  const collides = (x, y) => occupied.some((o) => rectsOverlapExact({ x, y, width: size, height: size }, o));
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

// Point-in-polygon (ray cast), edge-inclusive: a point on an edge or vertex
// counts as inside so auto-placed units may abut boundary walls.
function fpPointOnSeg(px, py, ax, ay, bx, by) {
  // Collinearity with a tiny tolerance: decimal-ft vertices make the exact
  // cross product of an on-edge point a float like 1e-15, not 0.
  if (Math.abs((bx - ax) * (py - ay) - (by - ay) * (px - ax)) > 1e-9) return false;
  return Math.min(ax, bx) <= px && px <= Math.max(ax, bx) && Math.min(ay, by) <= py && py <= Math.max(ay, by);
}

function fpPointInPolygon(px, py, poly) {
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    if (fpPointOnSeg(px, py, ax, ay, bx, by)) return true;
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function fpOrient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// True only when two segments cross through each other's interiors (strict
// sign change on both orientation pairs). Endpoint touches and collinear
// overlaps are NOT crossings, so a rect abutting a wall is allowed while a
// rect straddling a wall is rejected.
function fpSegsProperCross(a, b, c, d) {
  const d1 = fpOrient(c[0], c[1], d[0], d[1], a[0], a[1]);
  const d2 = fpOrient(c[0], c[1], d[0], d[1], b[0], b[1]);
  const d3 = fpOrient(a[0], a[1], b[0], b[1], c[0], c[1]);
  const d4 = fpOrient(a[0], a[1], b[0], b[1], d[0], d[1]);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function fpRectStraddlesPolygon(x, y, w, h, poly) {
  const corners = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  for (let e = 0; e < 4; e++) {
    const p = corners[e];
    const q = corners[(e + 1) % 4];
    for (let i = 0; i < poly.length; i++) {
      if (fpSegsProperCross(p, q, poly[i], poly[(i + 1) % poly.length])) return true;
    }
  }
  return false;
}

// True when a candidate rect is fully contained in a polygon loop: all four
// corners inside (walls inclusive) and no rect edge crossing a loop edge, so
// rects that straddle walls are rejected even when their corners test inside.
function fpRectInPolygon(x, y, w, h, poly) {
  const corners = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  if (!corners.every(([cx, cy]) => fpPointInPolygon(cx, cy, poly))) return false;
  return !fpRectStraddlesPolygon(x, y, w, h, poly);
}

function fpPolyBBox(pts) {
  const xs = pts.map(([x]) => x);
  const ys = pts.map(([, y]) => y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// Usable auto-place area derived from the boundary lines (rect-in-polygon
// clipping for fpFirstFreeRect). Closed loops (closed:true, >=3 distinct
// vertices, nonzero area) and open >=3-vertex polylines (chord-closed under
// the marked-area rule) define the interior directly; leftover strokes are
// STITCHED endpoint-to-endpoint (fpChainBoundarySegments — the same rule as
// fpBoundaryMetricsLocal, so a perimeter drawn as separate Line strokes that
// join into a closed ring counts as its true polygonal interior, notch and
// all). Only when nothing forms a loop (e.g. lone open 2-vertex segments)
// the fallback is the union bbox of all line vertices — an over-approx-
// imation for non-rectangular marks, surfaced as "line area" in the confirm
// and toast copy plus the dashed preview box until the loop is closed.
// `input` defaults to the editor's boundaries so fpAutoPlaceAll keeps its
// call shape; the canvas preview passes its own rows (shared with read-only
// fpView, where editor state may be stale).
function fpUsablePlaceArea(input) {
  const rows = (input !== undefined ? input : state.fp.boundaries || [])
    .filter((b) => lineFeedsArea(b.kind)) // only area-marking lines bound placement
    .map((b) => ({ pts: fpBoundaryPoints(b.points), closed: !!b.closed }))
    .filter((b) => b.pts.length >= 2 && b.pts.some(([x, y]) => x !== b.pts[0][0] || y !== b.pts[0][1]));
  if (!rows.length) return null;
  const distinct = (pts) => new Set(pts.map(([x, y]) => `${x},${y}`)).size;
  const hasArea = (pts) => pts.length >= 3 && fpPolygonArea(pts) > 0;
  // Direct loops: closed rows with >=3 distinct vertices, plus open
  // >=3-vertex rows (chord-closed under the marked-area rule).
  const direct = rows
    .filter((b) => (b.closed ? distinct(b.pts) >= 3 : true) && hasArea(b.pts))
    .map((b) => b.pts);
  // Stitched loops: endpoint-connected leftover strokes forming rings (or
  // chord-closed chains) with area — e.g. a perimeter drawn as single Line
  // strokes. Same rule as the metrics bridge; without this the placer would
  // fall back to the union bbox (a "square") for exactly the perimeters the
  // metrics already report as closed loops.
  const directSet = new Set(direct);
  const leftover = rows.filter((b) => !directSet.has(b.pts)).map((b) => b.pts);
  const stitched = fpChainBoundarySegments(leftover).filter((pts) => hasArea(pts));
  const loops = [...direct, ...stitched];
  if (loops.length) return { kind: 'loops', polys: loops, bbox: fpPolyBBox(loops.flat()) };
  return { kind: 'bbox', polys: [], bbox: fpPolyBBox(rows.flatMap((b) => b.pts)) };
}

// True when a candidate rect sits inside the usable boundary area: within the
// area bbox, and (for loop interiors) fully contained in at least one loop.
function fpRectInUsable(x, y, w, h, usable) {
  if (!usable) return false;
  const { x0, y0, x1, y1 } = usable.bbox;
  if (x < x0 || y < y0 || quantizeFt(x + w) > x1 || quantizeFt(y + h) > y1) return false;
  if (usable.kind === 'bbox') return true;
  return usable.polys.some((poly) => fpRectInPolygon(x, y, w, h, poly));
}

// Rectangular first-free-spot scan for auto-place: top-left → bottom-right
// against the live `taken` rect list. Candidate coordinates are every whole
// foot PLUS every taken rect's far edge (x + width / y + height), so decimal
// footprints pack flush against their neighbours instead of leaving sub-foot
// gaps. Comparisons are integer-exact (milli-ft). Returns {x,y} or null —
// never a fallback spot: canvas dims are blueprint feet and auto-place must
// NOT auto-resize the canvas.
function fpFirstFreeRect(w, h, taken, usable) {
  const { w: cw, h: ch } = fpCanvasDims();
  if (toMilli(w) > toMilli(cw) || toMilli(h) > toMilli(ch)) return null;
  const collides = (x, y) => taken.some((o) => rectsOverlapExact({ x, y, width: w, height: h }, o));
  // Clamp the scan to the usable boundary area (when known) so candidates
  // outside the Line-tool area are never tried; every surviving candidate is
  // then rect-in-polygon checked (corners inside + no edge straddling walls).
  // Without a usable area the whole canvas scans (callers guard this path).
  let xFrom = 0;
  let yFrom = 0;
  let xTo = cw;
  let yTo = ch;
  if (usable) {
    xFrom = Math.max(0, usable.bbox.x0);
    yFrom = Math.max(0, usable.bbox.y0);
    xTo = Math.min(cw, usable.bbox.x1);
    yTo = Math.min(ch, usable.bbox.y1);
  }
  const candidates = (from, to, size, edges) => {
    const set = new Set([toMilli(from)]);
    for (let v = Math.ceil(from); v <= to; v++) set.add(toMilli(v));
    for (const e of edges) if (e >= from) set.add(toMilli(e));
    return [...set]
      .filter((m) => m + toMilli(size) <= toMilli(to))
      .sort((a, b) => a - b)
      .map((m) => m / 1000);
  };
  const ys = candidates(yFrom, yTo, h, taken.map((o) => quantizeFt(o.y + o.height)));
  const xs = candidates(xFrom, xTo, w, taken.map((o) => quantizeFt(o.x + o.width)));
  for (const y of ys) {
    for (const x of xs) {
      if (collides(x, y)) continue;
      if (usable && !fpRectInUsable(x, y, w, h, usable)) continue;
      return { x, y };
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

// Auto-place guard: a boundary/line must exist before units can be placed.
// Missing = no rows, or every row normalises to < 2 vertices / zero length
// (all vertices identical). Normalised rows store points as [x, y] pairs, and
// fpBoundaryPoints() is idempotent over that shape, so it is reused here.
function fpHasUsableBoundary() {
  const list = state.fp.boundaries;
  if (!Array.isArray(list) || !list.length) return false;
  return list.some((b) => {
    const pts = fpBoundaryPoints(b && b.points);
    if (pts.length < 2) return false;
    return pts.some(([x, y]) => x !== pts[0][0] || y !== pts[0][1]);
  });
}

// Auto-place: renders ALL unplaced units of the current floor onto the canvas.
// One PUT per unit via the existing placement endpoint; footprints come from
// unitFootprint() (true-size sqftFootprint, ghost-rotated orientation first,
// swapped orientation as fallback) so the server's 2% area tolerance holds.
// Every candidate spot is rect-in-polygon clipped to the usable boundary area
// (fpUsablePlaceArea: closed-loop interior, else the open-lines box), so no
// write ever lands outside the Line-tool area. Units that don't fit — or fail
// to persist — are collected and reported; already-placed units are kept,
// never reverted as a batch. Canvas dims are blueprint feet and are never
// auto-resized.
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
  if (!fpHasUsableBoundary()) {
    fpToast('Cannot place units — there are no walls. Draw walls with the Draw tool first.', false);
    return;
  }
  // Rect-in-polygon clipping: every auto-placed rect must sit fully inside the
  // usable boundary area (closed-loop interior when loops exist, otherwise the
  // open-lines fallback box). Defensive — the guard above already ensures
  // fpUsablePlaceArea() is non-null.
  const usable = fpUsablePlaceArea();
  if (!usable) {
    fpToast('Cannot place units — there is no usable area inside the walls. Draw walls with the Draw tool first.', false);
    return;
  }
  const usableSqft = usable.kind === 'loops'
    ? Math.round(usable.polys.reduce((sum, poly) => sum + fpPolygonArea(poly), 0))
    : 0;
  const placeOk = await confirmDialog({
    title: `Place ${queue.length} unplaced unit${queue.length === 1 ? '' : 's'}?`,
    message:
      'Units are placed into the first free space inside the walls. Already-placed units are kept.' +
      (usable.kind === 'bbox'
        ? ' The walls are open lines, so placement is bounded by the walls\u2019 overall box — close the loop for exact interior placement.'
        : ` The area inside the closed walls covers ~${usableSqft.toLocaleString('en-SG')} sqft across ${usable.polys.length} loop${usable.polys.length === 1 ? '' : 's'} (shaded on the canvas).`),
    confirmLabel: 'Place units',
  });
  if (!placeOk) return;
  if (btn) btn.disabled = true;
  const { w: cw, h: ch } = fpCanvasDims();
  // Placements + blocks + markers (as 1×1 points) + solid structure rects count
  // as occupied for the scan.
  const taken = state.fp.placements
    .map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height }))
    .concat(
      state.fp.blocks.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })),
      (state.fp.markers || []).map((m) => ({ x: m.x, y: m.y, width: 1, height: 1 })),
      fpStructureRects(),
    );
  const placed = [];
  const unfit = [];
  const failed = [];
  try {
    for (const unit of queue) {
      const fp = unitFootprint(unit);
      const orientations = [{ w: fp.w, h: fp.h }];
      if (!ftEquals(fp.w, fp.h)) orientations.push({ w: fp.h, h: fp.w });
      let spot = null;
      let geom = null;
      for (const o of orientations) {
        const s = fpFirstFreeRect(o.w, o.h, taken, usable);
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
        await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(unit.id)}`, {
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
          hasPillar: unit.hasPillar === true,
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
  if (placed.length) fpCollapsePaletteAfterDrop(); // successful palette drop — the only auto-collapse besides the explicit toggle
  notifyMetricsFloorChanged();
  if (!placed.length) {
    fpToast(
      `Auto-place: nothing fits inside the walls on the ${cw}×${ch} ft canvas — enlarge the canvas or extend the walls first.` +
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
  // The staged fill from the form palette/custom picker (null = default tone).
  const color = state.fp.blockColor || null;
  try {
    const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/blocks`, {
      method: 'POST',
      body: JSON.stringify({ name, x, y, width: size, height: size, color }),
    });
    const b = res.data;
    // The plan is lazily created server-side when a floor has none yet; adopt
    // it locally with the default canvas so the new block has a surface.
    if (!state.fp.plan) {
      state.fp.plan = { width: state.fp.canvasDefaults.width, height: state.fp.canvasDefaults.height };
    }
    state.fp.blocks.push({ id: b.id, name: b.name, x: b.x, y: b.y, width: b.width, height: b.height, color: b.color || null });
    fpPushUndo({ kind: 'block', blockId: b.id, prev: null }); // undo = DELETE the drawn block
    state.fp.selectedBlock = b.id;
    state.fp.selected = null;
    state.fp.blockColor = null;
    fpToggleBlockForm(false);
    state.fp.tool = 'select';
    fpRender();
    notifyMetricsFloorChanged();
    fpToast(`Added block "${name}" (${size}×${size}) at ${x},${y} — drag it into place or resize from the corner.`, true);
  } catch (err) {
    fpToast('Add block: ' + describeError(err), false);
  }
}

async function fpPersistBlock(blk, verb) {
  const undoPrev = blk._undoPrev || null;
  blk._undoPrev = null;
  try {
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/blocks/${encodeURIComponent(blk.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: blk.name, x: blk.x, y: blk.y, width: blk.width, height: blk.height, color: blk.color || null }),
    });
    if (undoPrev) fpPushUndo({ kind: 'block', blockId: blk.id, prev: undoPrev });
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
  state.fp.selectedMarker = null;
  state.fp.selectedBoundary = null;
  blk._undoPrev = { name: blk.name, x: blk.x, y: blk.y, width: blk.width, height: blk.height, color: blk.color || null, doorEdges: blk.doorEdges || null };
  const origBX = blk.x;
  const origBY = blk.y;
  fpRenderCanvas();
  fpRenderSelInfo();
  const { w: cw, h: ch } = fpCanvasDims();
  const move = (ev) => {
    const cell = fpCanvasCellAt(ev.clientX - offsetX, ev.clientY - offsetY, ev);
    if (!cell) return;
    blk.x = clampFt(cell.gx, 0, cw - blk.width);
    blk.y = clampFt(cell.gy, 0, ch - blk.height);
    if (ev.shiftKey) {
      if (Math.abs(blk.x - origBX) >= Math.abs(blk.y - origBY)) blk.y = origBY;
      else blk.x = origBX;
    }
    fpRenderCanvas();
    fpSetReadout(`${blk.name || 'Block'} → ${formatFt(blk.x)}, ${formatFt(blk.y)} ft`);
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
    state.fp.selectedMarker = null;
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
    const step = fpSnapStep(ev);
    blk.width = clampFt(snapFt(origW + (ev.clientX - startX) / u, step), fpMinSide(ev), cw - origX);
    blk.height = clampFt(snapFt(origH + (ev.clientY - startY) / u, step), fpMinSide(ev), ch - origY);
    fpRenderCanvas();
    fpSetReadout(`${blk.name || 'Block'} ${formatFt(blk.width)} × ${formatFt(blk.height)} ft = ${fpFmtArea(rectAreaSqft(blk))} sqft`);
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
  fpPushUndo({ kind: 'block', blockId: blk.id, prev: { name: blk.name, x: blk.x, y: blk.y, width: blk.width, height: blk.height, color: blk.color || null, doorEdges: blk.doorEdges || null } });
  blk.name = name;
  try {
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/blocks/${encodeURIComponent(blk.id)}`, {
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
  const removedBlock = { name: blk.name, x: blk.x, y: blk.y, width: blk.width, height: blk.height, color: blk.color || null, doorEdges: blk.doorEdges || null };
  try {
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/blocks/${encodeURIComponent(blk.id)}`, {
      method: 'DELETE',
    });
    fpPushUndo({ kind: 'block', blockId: blk.id, prev: removedBlock }); // undo = re-PUT the removed block
    fpToast(`Block "${blk.name}" removed.`, true);
    await fpFetch();
  } catch (err) {
    fpToast('Remove block: ' + describeError(err), false);
  }
}

// Remove a drawn/selected boundary line item (same select → confirm → DELETE
// flow as blocks; scoped server-side to this floor's plan). Units and blocks
// are unaffected; the marked-area UFA/NLA strip recomputes on refetch.
async function fpRemoveBoundary() {
  const bnd = (state.fp.boundaries || []).find((b) => b.id === state.fp.selectedBoundary);
  if (!bnd) return;
  const removeOk = await confirmDialog({
    title: `Remove line "${bnd.label || 'Line'}" from the plan?`,
    message: 'The line is removed from the canvas. Units and blocks are unaffected; marked-area UFA/NLA recompute.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!removeOk) return;
  const removedLine = { label: bnd.label || 'Wall', kind: bnd.kind || 'BOUNDARY', points: fpBoundaryPoints(bnd.points), closed: !!bnd.closed, sortOrder: bnd.sortOrder || 0 };
  try {
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/boundaries/${encodeURIComponent(bnd.id)}`, {
      method: 'DELETE',
    });
    fpPushUndo({ kind: 'boundary', boundaryId: bnd.id, prev: removedLine, deleted: true }); // undo = re-POST the line
    fpToast(`Line "${bnd.label || 'Line'}" removed.`, true);
    await fpFetch();
  } catch (err) {
    fpToast('Remove line: ' + describeError(err), false);
  }
}

// Close an open >= 3-distinct-vertex line into a loop (PUT closed:true,
// scoped server-side to this floor's plan). Closing is what promotes a drawn
// line into the marked facility area that feeds UFA/NLA; the server still
// re-validates (3+ distinct vertices required, 400 otherwise).
async function fpCloseBoundary() {
  const bnd = (state.fp.boundaries || []).find((b) => b.id === state.fp.selectedBoundary);
  if (!bnd || bnd.closed) return;
  fpPushUndo({ kind: 'boundary', boundaryId: bnd.id, prev: { closed: false } }); // undo = re-open the loop
  try {
    const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/boundaries/${encodeURIComponent(bnd.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ closed: true }),
    });
    const b = res.data;
    bnd.closed = !!b.closed;
    bnd.points = fpBoundaryPoints(b.points);
    fpToast(`Loop closed — "${bnd.label || 'Line'}" now marks facility area feeding UFA/NLA.`, true);
    fpRender();
    notifyMetricsFloorChanged();
  } catch (err) {
    fpToast('Close loop: ' + describeError(err), false);
  }
}

// ---------- safety/facility markers (Markers/Safety toolbar group) ----------
// Toolbar buttons (rendered by fpRenderMarkerTools from FP_MARKER_KINDS) arm a
// kind; the next canvas click places it (same mode-gated pattern as the ✎ line
// tool — Esc cancels). Badges drag to move and persist via the marker
// endpoints; the read-only preview renders them statically.

// Render the Markers/Safety toolbar buttons from FP_MARKER_KINDS (single
// source of truth — no per-kind HTML to drift). Armed kinds read `.on`, like
// the line-tool toggle.
function fpRenderMarkerTools() {
  const wrap = $('#fpMarkerTools');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const def of FP_MARKER_KINDS) {
    const armed = state.fp.armedMarker === def.kind;
    const b = document.createElement('button');
    b.className = 'tb-btn ghost' + (armed ? ' on' : '');
    b.type = 'button';
    b.dataset.markerKind = def.kind;
    b.title = `${def.label} — arm placement, then click the canvas to place (Esc cancels)`;
    b.setAttribute('aria-pressed', String(armed));
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = def.icon;
    b.appendChild(icon);
    b.appendChild(document.createTextNode(` ${def.label}`));
    wrap.appendChild(b);
  }
  // Studio markers dropdown: the count badge tracks placed markers (it
  // increments on every fpPlaceMarker via fpRender/fpRenderMarkerTools), and
  // the dropdown button mirrors the armed state like the line-tool toggle.
  const cnt = $('#fpMarkersCount');
  if (cnt) cnt.textContent = String((state.fp.markers || []).length);
  const mbtn = $('#fpMarkersBtn');
  if (mbtn) {
    const armed = !!state.fp.armedMarker;
    mbtn.classList.toggle('on', armed);
    mbtn.setAttribute('aria-pressed', String(armed));
  }
}

function fpToggleArmedMarker(kind) {
  state.fp.armedMarker = state.fp.armedMarker === kind ? null : kind;
  if (state.fp.armedMarker) {
    // Arming a marker disarms the line tool (one placement mode at a time).
    state.fp.drawMode = false;
    fpResetPen();
    const pencilBtn = $('#fpBoundaryTool');
    if (pencilBtn) {
      pencilBtn.classList.remove('on');
      pencilBtn.setAttribute('aria-pressed', 'false');
    }
    fpToast(`${fpMarkerDef(kind).label} armed — click the canvas to place (Esc cancels).`, true);
  }
  // Studio: placing from the dropdown closes the menu so the canvas is visible.
  const menu = $('#fpMarkersMenu');
  if (menu && state.fp.armedMarker) {
    menu.hidden = true;
    $('#fpMarkersBtn')?.setAttribute('aria-expanded', 'false');
  }
  fpRenderMarkerTools();
  fpRenderCanvas();
  fpSyncModeUI();
}

// Escape cancels an armed marker placement (module-level so it coexists with
// the line tool's own transient Escape handler, which only fires mid-draft).
function fpOnEscapeTool(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (!state.fp.armedMarker) return;
  e.preventDefault();
  state.fp.armedMarker = null;
  fpRenderMarkerTools();
  fpRenderCanvas();
  fpToast('Marker placement cancelled.', true);
  fpSyncModeUI();
}

async function fpPlaceMarker(kind, gx, gy) {
  const def = fpMarkerDef(kind);
  const { w: cw, h: ch } = fpCanvasDims();
  const x = Math.min(Math.max(0, gx), cw);
  const y = Math.min(Math.max(0, gy), ch);
  try {
    const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/markers`, {
      method: 'POST',
      body: JSON.stringify({ kind, x, y }),
    });
    const b = res.data;
    // The plan is lazily created server-side when a floor has none yet (same
    // lazy adoption as fpAddBlock) — give the new marker a local surface.
    if (!state.fp.plan) {
      state.fp.plan = { width: state.fp.canvasDefaults.width, height: state.fp.canvasDefaults.height };
    }
    fpPushUndo({ kind: 'marker', markerId: b.id, prev: null }); // undo = DELETE the placed marker
    state.fp.markers.push({ id: b.id, kind: b.kind, label: b.label || null, x: b.x, y: b.y });
    state.fp.selectedMarker = b.id;
    state.fp.selected = null;
    state.fp.selectedBlock = null;
    state.fp.selectedBoundary = null;
    state.fp.armedMarker = null;
    state.fp.tool = 'select';
    fpRender();
    fpRenderMarkerTools();
    // Points carry no area, so the metrics panel is untouched (unlike blocks,
    // which subtract from UFA) — no notifyMetricsFloorChanged() here.
    fpToast(`${def.label} placed at ${x},${y} ft — drag to move.`, true);
  } catch (err) {
    fpToast('Place marker: ' + describeError(err), false);
  }
}

async function fpPersistMarker(m, verb) {
  const undoPrev = m._undoPrev || null;
  m._undoPrev = null;
  try {
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/markers/${encodeURIComponent(m.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ x: m.x, y: m.y }),
    });
    if (undoPrev) fpPushUndo({ kind: 'marker', markerId: m.id, prev: undoPrev });
    fpToast(`${verb} ${fpMarkerLabel(m)} → ${m.x},${m.y} ft`, true);
  } catch (err) {
    fpToast(`${verb} marker: ${describeError(err)}`, false);
    await fpFetch(); // revert local state to what the server has
  }
}

// Marker drag: badges are small, so the pointer snaps straight to the grid-ft
// point (no grab offset — unlike rect drags). Points clamp edge-INCLUSIVE
// (0..w / 0..h), the same contract as checkMarkerPoint server-side.
function fpMarkerStartMove(e, el) {
  if (e.button !== 0) return;
  const m = (state.fp.markers || []).find((x) => x.id === el.dataset.markerId);
  if (!m) return;
  e.preventDefault();
  state.fp.selectedMarker = m.id;
  state.fp.selected = null;
  state.fp.selectedBlock = null;
  state.fp.selectedBoundary = null;
  m._undoPrev = { kind: m.kind, label: m.label || null, x: m.x, y: m.y };
  fpRenderCanvas();
  fpRenderSelInfo();
  const { w: cw, h: ch } = fpCanvasDims();
  const move = (ev) => {
    const p = fpCanvasPointAt(ev.clientX, ev.clientY, ev);
    if (!p) return;
    m.x = clampFt(p.x, 0, cw);
    m.y = clampFt(p.y, 0, ch);
    fpRenderCanvas();
    fpSetReadout(`${fpMarkerLabel(m)} → ${formatFt(m.x)}, ${formatFt(m.y)} ft`);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    fpPersistMarker(m, 'Moved');
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// Persist an operator label override for the selected marker (empty clears
// back to the kind's display label — the server stores null).
async function fpRenameMarker() {
  const m = (state.fp.markers || []).find((x) => x.id === state.fp.selectedMarker);
  if (!m) return;
  const input = $('#fpMarkerRename');
  const raw = input ? input.value.trim() : '';
  if (raw.length > 80) {
    fpToast('Marker label must be at most 80 characters.', false);
    return;
  }
  const next = raw || null;
  if (next === m.label) return;
  const prev = m.label;
  fpPushUndo({ kind: 'marker', markerId: m.id, prev: { label: prev } });
  m.label = next;
  try {
    const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/markers/${encodeURIComponent(m.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ label: next }),
    });
    m.label = res && res.data ? res.data.label || null : next;
    fpToast(next ? `Marker labelled "${next}".` : `Marker label cleared — back to "${fpMarkerDef(m.kind).label}".`, true);
    fpRenderCanvas();
    fpRenderSelInfo();
  } catch (err) {
    m.label = prev;
    fpToast('Label marker: ' + describeError(err), false);
  }
}

// Remove the selected marker (same select → confirm → DELETE → refresh flow as
// blocks; scoped server-side to this floor's plan). Units and blocks are
// unaffected; points carry no area, so metrics never recompute.
async function fpRemoveMarker() {
  const m = (state.fp.markers || []).find((x) => x.id === state.fp.selectedMarker);
  if (!m) return;
  const removeOk = await confirmDialog({
    title: `Remove ${fpMarkerLabel(m)} marker from the plan?`,
    message: 'The marker is removed from the canvas. Units and blocks are unaffected.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!removeOk) return;
  const removedMarker = { kind: m.kind, label: m.label || null, x: m.x, y: m.y };
  try {
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/markers/${encodeURIComponent(m.id)}`, {
      method: 'DELETE',
    });
    fpPushUndo({ kind: 'marker', markerId: m.id, prev: removedMarker, deleted: true }); // undo = re-POST the marker

    fpToast(`${fpMarkerLabel(m)} marker removed.`, true);
    await fpFetch();
  } catch (err) {
    fpToast('Remove marker: ' + describeError(err), false);
  }
}

// ---------- block fill colour ----------
// Persist a block's fill: hex (#RGB/#RRGGBB, stored uppercased) or null for the
// default tone. Geometry/name ride along unchanged (the block PUT is a full
// replace). A fill change never moves geometry, so metrics stay untouched.
async function fpSetBlockColor(blk, color) {
  const next = color ? String(color).trim().toUpperCase() : null;
  if (next && !/^#(?:[0-9A-F]{3}|[0-9A-F]{6})$/.test(next)) {
    fpToast(`Block colour must be a hex colour (#RGB or #RRGGBB) — got ${JSON.stringify(color)}`, false);
    fpRenderSelInfo();
    return;
  }
  if ((blk.color || null) === next) {
    fpRenderCanvas();
    fpRenderSelInfo();
    return;
  }
  const prev = blk.color || null;
  blk.color = next;
  try {
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/blocks/${encodeURIComponent(blk.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: blk.name, x: blk.x, y: blk.y, width: blk.width, height: blk.height, color: next }),
    });
    fpToast(next ? `Block "${blk.name}" fill → ${next}.` : `Block "${blk.name}" fill → default.`, true);
    fpRenderCanvas();
    fpRenderSelInfo();
  } catch (err) {
    blk.color = prev;
    fpToast('Block colour: ' + describeError(err), false);
  }
}

// Palette swatches for the "New block" form, rendered from FP_BLOCK_PALETTE
// (single source of truth — shared with the selection strip). Clicking a
// swatch stages state.fp.blockColor for the next fpAddBlock; the native colour
// input stages a custom hex; Default clears back to the default tone.
function fpRenderBlockFormSwatches() {
  const wrap = $('#fpBlockSwatches');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const c of FP_BLOCK_PALETTE) {
    const b = document.createElement('button');
    const active = (state.fp.blockColor || '').toUpperCase() === c;
    b.className = 'act-btn' + (active ? ' primary' : '');
    b.type = 'button';
    b.dataset.blockColor = c;
    b.title = c === FP_DEFAULT_BLOCK_COLOR ? `Default block tone (${c})` : `Fill ${c}`;
    b.setAttribute('aria-label', `Block fill ${c}`);
    b.style.padding = '0';
    b.style.width = '22px';
    b.style.height = '22px';
    b.style.minWidth = '22px';
    b.style.borderRadius = '50%';
    b.style.background = c;
    b.style.border = '1px solid var(--line)';
    wrap.appendChild(b);
  }
  const custom = $('#fpBlockColor');
  if (custom && document.activeElement !== custom) custom.value = state.fp.blockColor || FP_DEFAULT_BLOCK_COLOR.toLowerCase();
}

// Draft/publish pill (header, next to Save Canvas): Save Canvas and every
// other designer write persist as DRAFT (CMS-only, invisible to booking);
// only Publish exposes the plan publicly. textContent-only (escaped by
// nature); no layout/CSS changes — reuses the existing .t-type tone.
function fpRenderPlanStatus() {
  const el = $('#fpPlanStatus');
  if (!el) return;
  // Studio Tier-1 status badge: textContent-only copy (escaped by nature) plus
  // tone classes on the existing node — the header keeps working if the badge
  // CSS is ever absent.
  el.classList.add('fp-status-badge');
  if (!state.fp.plan) {
    el.textContent = 'No plan yet';
    el.classList.remove('is-draft', 'is-live');
    return;
  }
  const st = String(state.fp.plan.status || 'DRAFT').toUpperCase();
  const live = st === 'ACTIVE';
  el.textContent = live ? '● Published · Visible' : '○ Draft — Not visible';
  el.classList.toggle('is-live', live);
  el.classList.toggle('is-draft', !live);
}

// All designer writes funnel through fpMutate (never raw request()): the
// server persists every write as DRAFT, so the local plan status is flipped
// optimistically and the pill re-renders without a refetch after every
// drag/resize/drop. Reads keep using get(); Publish uses request() directly
// (the server sets ACTIVE, then fpFetch reloads).
async function fpMutate(url, opts) {
  fpSaving += 1;
  fpRenderSaveStatus();
  let res;
  try {
    res = await request(url, opts);
    fpSaveFailed = false;
    fpLastSavedAt = new Date();
  } catch (err) {
    fpSaveFailed = true;
    throw err;
  } finally {
    fpSaving -= 1;
    fpRenderSaveStatus();
  }
  if (state.fp.plan) state.fp.plan.status = 'DRAFT';
  fpCanvasDirty = true; // every designer write funnels through here — the
  // canvas now differs from the last load/save (Load guards on this)
  fpRenderPlanStatus();
  return res;
}

async function fpSaveCanvas() {
  if (!state.fp.floorId) return;
  const w = fpParseDim($('#fpWidth').value);
  const h = fpParseDim($('#fpHeight').value);
  if (w === null || h === null) {
    fpToast('Canvas size must be a number between 1 and 500 feet (decimals allowed).', false);
    return;
  }
  // Operator-entered GFA (sqft): empty clears back to unset (metrics fall back
  // to the canvas rect); garbage is rejected with a toast, never persisted.
  const gfaEl = $('#fpGfa');
  const gfaParsed = fpParseGfa(gfaEl ? gfaEl.value : '');
  if (!gfaParsed.ok) {
    fpToast('GFA must be a positive number of sqft (up to 10,000,000) — or empty to unset.', false);
    if (gfaEl) gfaEl.focus();
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
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}`, {
      method: 'POST',
      body: JSON.stringify({ width: w, height: h, structure, gfaSqft: gfaParsed.value }),
    });
    state.fp.gfa = gfaParsed.value;
    fpToast(`Canvas saved as draft (${w}×${h} ft${gfaParsed.value != null ? `, GFA ${fpFmt1(gfaParsed.value)} sqft` : ', GFA unset — metrics use the canvas rect'}). Publish to expose it to booking.`, true);
    await fpFetch();
  } catch (err) {
    fpToast('Save canvas: ' + describeError(err), false);
  }
}

// Publish with floor-plan unit sync (docs/FLOOR_PLAN_UNIT_SYNC_PLAN.md D2/D5):
// fetch the publish preview; with no unit changes it is the plain confirm,
// otherwise a review dialog lists every resized unit (sqft, tier, rate policy)
// plus DRAFT units to promote and blockers. Publish sends the preview token
// (stale → re-review) and the per-unit choices.
async function fpPublishPlan() {
  if (!state.fp.floorId || !state.fp.plan) {
    fpToast('No plan to publish — set a canvas size and save first.', false);
    return;
  }
  if (String(state.fp.plan.status || '').toUpperCase() === 'ACTIVE') {
    fpToast('Plan is already published.', true);
    return;
  }
  const floorId = state.fp.floorId;
  let preview;
  try {
    preview = await get(`/floor-plans/${encodeURIComponent(floorId)}/publish-preview`);
  } catch (err) {
    fpToast('Publish plan: ' + describeError(err), false);
    return;
  }
  const hasUnitWork = preview.changes.length || preview.newUnits.length || preview.blockers.length;
  if (!hasUnitWork) {
    // Unit-count line (never publish silently): the plain confirm names how
    // many units go live. An empty plan escalates to a danger confirm with an
    // explicit acknowledgement checkbox (→ confirmEmpty:true) — customers
    // would see an empty floor.
    const liveUnits = Number(preview.placementCount || 0);
    const unitLine = `${liveUnits} unit${liveUnits === 1 ? '' : 's'} will go live to booking.`;
    const isEmpty = preview.emptyPlan === true || liveUnits === 0;
    const pubOk = await confirmDialog({
      title: isEmpty ? 'Publish an EMPTY floor plan?' : 'Publish this floor plan?',
      message: isEmpty
        ? `0 units will go live — customers will see an empty floor. ${unitLine} Further edits return it to draft until re-published.`
        : `${unitLine} The current draft becomes visible to the booking frontend. Further edits return it to draft until re-published.`,
      confirmLabel: isEmpty ? 'Publish empty plan' : 'Publish',
      danger: isEmpty,
      requireCheck: isEmpty ? 'I understand customers will see an empty floor' : undefined,
    });
    if (!pubOk) return;
    await fpSendPublish(floorId, isEmpty ? { token: preview.token, confirmEmpty: true } : { token: preview.token });
    return;
  }
  fpOpenPublishReview(floorId, preview);
}

async function fpSendPublish(floorId, body) {
  try {
    const res = await request(`/floor-plans/${encodeURIComponent(floorId)}/publish`, { method: 'POST', body: JSON.stringify(body) });
    const sync = (res && res.meta && res.meta.sizeSync) || { changed: [], promoted: [] };
    const bits = [];
    if (sync.changed.length) bits.push(`${sync.changed.length} unit size${sync.changed.length === 1 ? '' : 's'} updated`);
    if (sync.promoted.length) bits.push(`${sync.promoted.length} new unit${sync.promoted.length === 1 ? '' : 's'} available`);
    fpToast(`Plan published — now visible to booking${bits.length ? ' · ' + bits.join(' · ') : ''}.`, true);
    await fpFetch();
    return true;
  } catch (err) {
    fpToast('Publish plan: ' + describeError(err), false);
    return err;
  }
}

const FP_RATE_POLICY_LABELS = { KEEP_PSF: 'Keep $/sqft', KEEP_RATE: 'Keep rate', SET: 'Set rate' };
const fpMoney = (n) => 'S$' + (Math.round(Number(n) * 100) / 100).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fpOpenPublishReview(floorId, preview) {
  const modal = $('#fpPublishModal');
  const body = $('#fpPublishBody');
  const alertEl = $('#fpPublishAlert');
  const go = $('#fpPublishGo');
  if (!modal || !body || !go) return;
  const blockedBy = new Map(preview.blockers.map((b) => [b.unitId, b]));
  const contractedBlock = preview.blockers.filter((b) => b.code === 'UNIT_CONTRACTED');
  const sizeOpts = (sel) =>
    '<option value="">Pick tier…</option>' +
    (preview.sizes || []).map((s) => `<option value="${escapeHtml(s.id)}"${s.id === sel ? ' selected' : ''}>${escapeHtml(s.name)} (${s.sqftFrom}–${s.sqftTo})</option>`).join('');
  const rows = preview.changes.map((c) => {
    const blk = blockedBy.get(c.unitId);
    // Tier: pre-selected from the server (nearest band when none covers the
    // new sqft — flagged so the operator confirms it); always overridable.
    const tierCell =
      `<select class="tbl-select" data-pub-tier="${escapeHtml(c.unitId)}" aria-label="Size tier for ${escapeHtml(c.unitCode)}">${sizeOpts(c.newSize ? c.newSize.id : '')}</select>` +
      `<div class="fp-pub-note">was ${escapeHtml(c.oldSize.name)}${c.newSize && !c.tierInBand ? ' · nearest tier — no tier range covers ' + c.newSqft + ' sqft' : ''}</div>`;
    const policy = `<select class="tbl-select" data-pub-policy="${escapeHtml(c.unitId)}" aria-label="Rate for ${escapeHtml(c.unitCode)}">` +
      Object.entries(FP_RATE_POLICY_LABELS).map(([k, v]) => `<option value="${k}"${k === c.defaultPolicy ? ' selected' : ''}>${v}</option>`).join('') +
      '</select>';
    return `<tr data-pub-row="${escapeHtml(c.unitId)}"${blk && blk.code === 'UNIT_CONTRACTED' ? ' style="background:var(--red-light)"' : ''}>` +
      `<td><b>${escapeHtml(c.unitCode)}</b><div class="fp-pub-note">${formatFt(c.widthFt)}×${formatFt(c.heightFt)} ft</div></td>` +
      `<td>${c.oldSqft}<span class="fp-pub-arrow">→</span><span class="fp-pub-up">${c.newSqft}</span></td>` +
      `<td>${tierCell}</td>` +
      `<td>${policy}</td>` +
      `<td><input type="number" class="tbl-search fp-pub-rate" min="0" step="0.01" data-pub-rate="${escapeHtml(c.unitId)}" aria-label="New monthly rate for ${escapeHtml(c.unitCode)}" disabled></td>` +
      `<td class="fp-pub-note" data-pub-psf="${escapeHtml(c.unitId)}"></td>` +
      '</tr>';
  });
  body.innerHTML =
    (preview.changes.length
      ? `<p class="fp-pub-note">Publishing updates ${preview.changes.length} unit${preview.changes.length === 1 ? '' : 's'} to match the drawing (size, tier and monthly rate). Booking sees the new values immediately.</p>` +
        '<div class="fp-publish-scroll"><table class="data-tbl"><thead><tr><th>Unit</th><th>Sqft</th><th>Tier</th><th>Rate rule</th><th>New rate</th><th>$/sqft</th></tr></thead><tbody>' +
        rows.join('') +
        '</tbody></table></div>'
      : '') +
    (preview.newUnits.length
      ? `<p class="fp-pub-note">${preview.newUnits.length} new unit${preview.newUnits.length === 1 ? '' : 's'} become${preview.newUnits.length === 1 ? 's' : ''} available: ${preview.newUnits.map((n) => `<b>${escapeHtml(n.unitCode)}</b> (${n.sqft} sqft, ${fpMoney(n.rate)})`).join(', ')}.</p>`
      : '') +
    '<p class="fp-pub-note">The plan also becomes visible to the booking frontend. Further edits return it to draft until re-published.</p>';

  const changeBy = new Map(preview.changes.map((c) => [c.unitId, c]));
  const refreshRow = (unitId) => {
    const c = changeBy.get(unitId);
    const pol = body.querySelector(`[data-pub-policy="${CSS.escape(unitId)}"]`).value;
    const rateIn = body.querySelector(`[data-pub-rate="${CSS.escape(unitId)}"]`);
    rateIn.disabled = pol !== 'SET';
    if (pol !== 'SET') rateIn.value = (pol === 'KEEP_RATE' ? c.ratePreview.KEEP_RATE : c.ratePreview.KEEP_PSF).toFixed(2);
    const rate = Number(rateIn.value);
    body.querySelector(`[data-pub-psf="${CSS.escape(unitId)}"]`).textContent =
      Number.isFinite(rate) && c.newSqft > 0 ? `${fpMoney(rate / c.newSqft)} (was ${fpMoney(c.oldSqft ? c.oldRate / c.oldSqft : 0)})` : '—';
  };
  const validate = () => {
    const missingTier = [...body.querySelectorAll('[data-pub-tier]')].some((s) => !s.value);
    const badRate = [...body.querySelectorAll('[data-pub-rate]')].some((i) => !i.disabled && !(Number(i.value) >= 0 && i.value !== ''));
    const msgs = contractedBlock.map((b) => b.message);
    if (missingTier) msgs.push('Pick a size tier for every resized unit.');
    alertEl.hidden = !msgs.length;
    alertEl.textContent = msgs.join(' ');
    go.disabled = !!contractedBlock.length || missingTier || badRate;
  };
  for (const c of preview.changes) refreshRow(c.unitId);
  body.oninput = body.onchange = (e) => {
    const id = e.target && (e.target.dataset.pubPolicy || e.target.dataset.pubRate);
    if (id && e.target.dataset.pubPolicy) refreshRow(id);
    else if (id) {
      const c = changeBy.get(id);
      const rate = Number(e.target.value);
      body.querySelector(`[data-pub-psf="${CSS.escape(id)}"]`).textContent = Number.isFinite(rate) && c.newSqft > 0 ? fpMoney(rate / c.newSqft) : '—';
    }
    validate();
  };
  validate();

  const close = () => {
    modal.hidden = true;
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  $('#fpPublishClose').onclick = close;
  $('#fpPublishCancel').onclick = close;
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };
  go.onclick = async () => {
    const choices = preview.changes.map((c) => {
      const pol = body.querySelector(`[data-pub-policy="${CSS.escape(c.unitId)}"]`).value;
      const tierSel = body.querySelector(`[data-pub-tier="${CSS.escape(c.unitId)}"]`);
      const ch = { unitId: c.unitId, ratePolicy: pol };
      if (pol === 'SET') ch.rate = Number(body.querySelector(`[data-pub-rate="${CSS.escape(c.unitId)}"]`).value);
      if (tierSel && tierSel.value && (!c.newSize || tierSel.value !== c.newSize.id)) ch.sizeId = tierSel.value;
      return ch;
    });
    go.disabled = true;
    const result = await fpSendPublish(floorId, { token: preview.token, choices });
    if (result === true) {
      close();
      return;
    }
    if (result && result.code === 'STALE_PREVIEW') {
      close();
      fpToast('The plan changed since this review — reopening it with the latest changes.', false);
      await fpPublishPlan();
      return;
    }
    alertEl.hidden = false;
    alertEl.textContent = describeError(result);
    go.disabled = false;
  };
  modal.hidden = false;
  // Start on the first per-unit decision (or Cancel) — never on Publish, so a
  // stray Enter can't apply price changes unreviewed.
  const first = body.querySelector('select, input:not([disabled])') || $('#fpPublishCancel');
  try {
    first.focus({ preventScroll: true });
  } catch (e) { /* noop */ }
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
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}`, { method: 'DELETE' });
    fpToast('Floor plan deleted.', true);
    await fpFetch();
  } catch (err) {
    fpToast('Delete plan: ' + describeError(err), false);
  }
}

// ---------- floor-plan draft versions (versioned design snapshots) ----------
// "Save as draft" freezes the canvas as version N (max+1 per floor); each row
// offers Publish (per-draft confirm popup via the read-only publish preview —
// counts, the version going back to draft, skipped placements — then POST
// /drafts/:id/publish), Load (populate the editable canvas from the snapshot
// so the operator can keep designing from it), View (read-only preview in the
// existing #fpViewModal) and Delete (confirmDialog). Publishing a version
// demotes the previously-published version back to DRAFT server-side, so
// exactly one version stays published.
// Loading never writes the live
// plan — it only replaces local editor state; the next Save-as-draft freezes
// the edited canvas as a NEW version (never overwrites the loaded one).
// Reuses the existing .data-tbl/.tb-btn/.t-type/.pill theme only — no new
// CSS. Drafts are CMS-only: the public booking read resolves the ACTIVE live
// plan and never touches them.
let fpDrafts = []; // last GET /floor-plans/:floorId/drafts rows (summaries)
// Loaded-version tracking for "Load into designer": which draft snapshot the
// editable canvas was last populated from (null = live plan). Set ONLY by
// fpLoadDraft/fpSaveDraft, cleared by fpFetch (any live reload).
let fpLoadedDraftId = null;
let fpLoadedDraftVersion = null;
// Unsaved-changes guard for Load: set by fpMutate (every designer write
// funnels through it), cleared on fpFetch / after a load / after a draft save
// (the edits are then frozen as a version). Load confirms via confirmDialog
// while this is true. Declared here (after fpMutate/fpFetch textually) but
// only assigned at runtime, post module-evaluation — never in TDZ.
let fpCanvasDirty = false;

async function fpFetchDrafts() {
  if (!state.fp.floorId) {
    fpDrafts = [];
    fpRenderDrafts();
    return;
  }
  try {
    fpDrafts = await get(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/drafts`);
    fpRenderDrafts();
  } catch (err) {
    fpDrafts = [];
    fpRenderDrafts();
    fpToast('Load drafts: ' + describeError(err), false);
  }
}

// Floor Plan Library panel (#facility-floorplan-library) scope line: which
// Designer facility/floor selector the drafts table is filtered by. The Library
// owns no selectors of its own — it reuses state.fp.floorId, refreshed on every
// tab visit via fpOpenLibrary(). textContent-only, no new CSS.
function fpRenderLibraryScope() {
  const el = document.getElementById('fpLibraryScope');
  if (!el) return;
  if (!state.fp.floorId) {
    el.textContent = 'Pick a facility and floor in the Designer to list drafts.';
    return;
  }
  const b = branchByCode(state.fp.branchCode);
  const fl = (state.floors || []).find((f) => f.id === state.fp.floorId);
  el.textContent = `${b ? b.name : state.fp.branchCode || '—'} · ${fl ? `Level ${fl.level} — ${fl.name}` : 'current floor'} — filtered by the Designer facility/floor selector`;
}

// Cross-panel switch Library → Designer without a live refetch: toggling the
// subtab/panel classes directly (clicking the Designer subtab would run the
// admin.js facility-tab handler → fpOpen() → fpFetch() and wipe a just-loaded
// snapshot). Mirrors that handler's toggle + activateSide('facilities', …).
function fpShowDesignerPanel() {
  document.querySelectorAll('[data-tabs="facility"] [data-tab]').forEach((x) =>
    x.classList.toggle('active', x.dataset.tab === 'facility-floorplans'));
  document.querySelectorAll('#facilities > .module-panel').forEach((p) =>
    p.classList.toggle('active', p.id === 'facility-floorplans'));
  document.querySelectorAll('.nav-subitem').forEach((b) =>
    b.classList.toggle('active', b.dataset.sidePage === 'facilities' && b.dataset.sidePanel === 'facility-floorplans'));
}

function fpRenderDrafts() {
  const tb = $('#fpDraftsBody');
  const sub = $('#fpDraftsSub');
  if (!tb) return;
  fpRenderLibraryScope();
  if (sub) {
    sub.textContent = fpDrafts.length
      ? `${fpDrafts.length} saved version${fpDrafts.length === 1 ? '' : 's'} — view, load into the editor, publish, or delete`
      : 'No saved versions yet — Save as draft freezes the current canvas as v1';
  }
  if (!fpDrafts.length) {
    tb.innerHTML = '<tr><td colspan="6" class="t-type">No draft versions saved for this floor yet.</td></tr>';
    return;
  }
  tb.innerHTML = fpDrafts
    .map((d) => {
      const live = String(d.status || '').toUpperCase() === 'ACTIVE';
      const c = d.counts || {};
      const when = d.createdAt ? new Date(d.createdAt).toLocaleString() : '—';
      return (
        '<tr>' +
        `<td><strong>v${escapeHtml(d.version)}</strong>${d.id && d.id === fpLoadedDraftId ? ' <span class="pill amber">editing</span>' : ''}</td>` +
        `<td><span class="t-type">${live ? '● Published' : '○ Draft'}</span></td>` +
        `<td>${escapeHtml(d.width)}×${escapeHtml(d.height)} ft</td>` +
        `<td class="t-type">${escapeHtml(c.placements || 0)} units · ${escapeHtml(c.blocks || 0)} blocks · ` +
        `${escapeHtml(c.boundaries || 0)} lines · ${escapeHtml(c.markers || 0)} markers</td>` +
        `<td class="t-type">${escapeHtml(when)}${d.createdBy ? ' · ' + escapeHtml(d.createdBy) : ''}</td>` +
        '<td style="white-space:nowrap">' +
        `<button class="tb-btn ghost" data-fp-draft-act="publish" data-fp-draft-id="${escapeHtml(d.id)}" title="Publish this version — a confirm shows what goes live, what goes back to draft, and what will be skipped">Publish</button> ` +
        `<button class="tb-btn ghost" data-fp-draft-act="load" data-fp-draft-id="${escapeHtml(d.id)}" title="Load this version into the editable canvas (live plan unchanged)">Load</button> ` +
        `<button class="tb-btn ghost" data-fp-draft-act="view" data-fp-draft-id="${escapeHtml(d.id)}">View</button> ` +
        `<button class="tb-btn danger" data-fp-draft-act="delete" data-fp-draft-id="${escapeHtml(d.id)}">Delete</button>` +
        '</td></tr>'
      );
    })
    .join('');
}

// Loaded-version indicator (#fpLoadedDraft pill in the drafts card header):
// textContent-only (escaped by nature), hidden unless a draft is loaded.
function fpRenderLoadedDraft() {
  const el = document.getElementById('fpLoadedDraft');
  if (!el) return;
  if (fpLoadedDraftVersion == null) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = `Editing from draft v${fpLoadedDraftVersion} — live plan unchanged`;
}

function fpSetLoadedDraft(d) {
  fpLoadedDraftId = d ? d.id : null;
  fpLoadedDraftVersion = d ? d.version : null;
  fpRenderLoadedDraft();
  fpRenderDrafts(); // refresh the per-row "editing" tag
}

// Load a draft version INTO the editable designer: fetches the full snapshot
// via the existing GET /drafts/:id view payload (no new endpoint) and
// populates state.fp.* (canvas dims, placements, blocks, boundaries, markers,
// structure, gfaSqft), then re-renders. Local state only — the live plan is
// never written. The operator then edits and either saves a NEW draft version
// (max+1, never overwrites the loaded one), or publishes a saved version via
// its per-draft Publish action. Unsaved canvas edits guard via
// fpResolveUnsaved (Save as Draft, Discard, or Cancel).
async function fpLoadDraft(draftId) {
  if (fpCanvasDirty || fpHasPendingWrites()) {
    // Save as Draft, Discard, or Cancel — staying keeps the current screen.
    if ((await fpResolveUnsaved('and load the draft')) !== 'proceed') return;
  }
  try {
    const res = await request(`/drafts/${encodeURIComponent(draftId)}`);
    const d = res.data;
    // Re-partition the units palette around the snapshot: every unit the
    // snapshot places leaves the unplaced pool; every other known unit
    // stays (or returns) in it. Known = current placements + current unplaced
    // (rebuilt in the fpNormalizeUnit input shape so the round-trip is exact).
    // Snapshot placements carry their own full unit metadata, so units created
    // after the last fetch still render on the canvas.
    const snapPlacements = Array.isArray(d.placements) ? d.placements : [];
    const placedIds = new Set(snapPlacements.map((p) => p.unitId));
    const pool = new Map();
    for (const p of state.fp.placements || []) {
      pool.set(p.unitId, {
        id: p.unitId, unitCode: p.unitCode, name: p.name,
        size: { code: p.sizeCode, name: p.sizeName }, sqft: p.sqft, status: p.status,
        hasAC: p.hasAC === true, hasPillar: p.hasPillar === true,
      });
    }
    for (const u of state.fp.unplaced || []) {
      pool.set(u.id, {
        id: u.id, unitCode: u.unitCode, name: u.name,
        size: { code: u.sizeCode, name: u.sizeName }, sqft: u.sqft, status: u.status,
        hasAC: u.hasAC === true, hasPillar: u.hasPillar === true,
      });
    }
    state.fp.placements = snapPlacements.map((p) => ({
      id: p.id || '',
      unitId: p.unitId,
      unitCode: p.unitCode,
      name: p.name ?? null,
      sizeCode: p.sizeCode,
      sizeName: p.sizeName,
      sqft: p.sqft,
      status: p.status,
      hasAC: p.hasAC === true,
      hasPillar: p.hasPillar === true,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      stackTier: p.stackTier === 1 ? 1 : 0,
      doorEdges: Array.isArray(p.doorEdges) && p.doorEdges.length ? p.doorEdges.slice() : null,
    }));
    state.fp.unplaced = [...pool.values()].filter((u) => !placedIds.has(u.id)).map(fpNormalizeUnit);
    state.fp.blocks = (Array.isArray(d.blocks) ? d.blocks : []).map((b) => ({
      id: b.id || '',
      name: b.name,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      color: b.color || null,
      doorEdges: Array.isArray(b.doorEdges) && b.doorEdges.length ? b.doorEdges.slice() : null,
    }));
    state.fp.boundaries = (Array.isArray(d.boundaries) ? d.boundaries : []).map((b) => ({
      id: b.id || '',
      label: b.label,
      kind: b.kind,
      points: fpBoundaryPoints(b.points),
      closed: !!b.closed,
      sortOrder: b.sortOrder || 0,
    }));
    state.fp.markers = (Array.isArray(d.markers) ? d.markers : []).map((m) => ({
      id: m.id || '',
      kind: m.kind,
      label: m.label || null,
      x: m.x,
      y: m.y,
    }));
    // Canvas dims + GFA + structure come from the snapshot. The live plan row
    // is untouched (no POST/PUT here); the shell (when no live plan exists
    // yet) only feeds fpCanvasDims/fpRenderPlanStatus until Save Canvas runs.
    const w = Number(d.width) > 0 ? Number(d.width) : state.fp.canvasDefaults.width;
    const h = Number(d.height) > 0 ? Number(d.height) : state.fp.canvasDefaults.height;
    state.fp.plan = state.fp.plan ? { ...state.fp.plan, width: w, height: h } : { width: w, height: h, status: 'DRAFT' };
    state.fp.liveDims = null;
    state.fp.structure = d.structure ?? null;
    state.fp.gfa = d.gfaSqft != null && Number.isFinite(Number(d.gfaSqft)) ? Number(d.gfaSqft) : null;
    state.fp.selected = null;
    state.fp.selectedBlock = null;
    state.fp.selectedBoundary = null;
    state.fp.selectedMarker = null;
    state.fp.armedMarker = null;
    fpResetPen();
    fpClearUndo(); // inverse ops captured against the live rows no longer apply
    fpCanvasDirty = false;
    fpSetLoadedDraft({ id: d.id, version: d.version });
    fpRender();
    fpRenderMarkerTools();
    // Loading from the Library lands on the Designer canvas: switch panels
    // without a live refetch (fpShowDesignerPanel never calls fpOpen/fpFetch,
    // so the just-loaded snapshot survives). Idempotent when already there.
    fpShowDesignerPanel();
    // Metrics KPIs read the live server plan, so no notifyMetricsFloorChanged
    // here — the toolbar UFA/NLA strip already re-renders from canvas state.
    fpToast(`Draft v${d.version} loaded into the editor — live plan unchanged. Edit, then Save Canvas + Publish to expose it to booking, or Save as draft for a new version.`, true);
  } catch (err) {
    fpToast('Load draft: ' + describeError(err), false);
  }
}

// Unsaved-changes guard for user-initiated navigation (branch/floor switch,
// publishing or loading another draft version): "Save as Draft, Discard, or
// Cancel" via two sequential confirms (confirmDialog is a 2-button modal).
// Returns 'proceed' | 'stay'. 'proceed' covers the clean case, a successful
// Save as Draft, and an explicit Discard.
async function fpResolveUnsaved(discardVerb) {
  if (!fpCanvasDirty && !fpHasPendingWrites()) return 'proceed';
  const saveOk = await confirmDialog({
    title: 'Unsaved floor-plan changes?',
    message: `You have unsaved changes — Save as Draft, Discard, or Cancel. Save as Draft freezes the full canvas on screen as a new draft version; Discard ${discardVerb || 'continues'} and loses the edits; Cancel stays here.`,
    confirmLabel: 'Save as Draft',
    cancelLabel: 'Not now',
  });
  if (saveOk) {
    const saved = await fpSaveDraft();
    return saved ? 'proceed' : 'stay'; // a failed save keeps the operator on screen
  }
  const discardOk = await confirmDialog({
    title: `Discard unsaved changes${discardVerb ? ` ${discardVerb}` : ''}?`,
    message: 'The canvas on screen reverts and your unsaved edits are lost. The live plan is unchanged either way.',
    confirmLabel: 'Discard',
    danger: true,
  });
  return discardOk ? 'proceed' : 'stay';
}

// Publish a version straight from the drafts Library list: unsaved screen
// edits guard first (Save as Draft freezes them as a new version, Discard
// drops them, Cancel stays), then the chosen SAVED version publishes by id —
// the screen is never shipped, so this path is stale-proof by construction.
async function fpPublishDraftFromLibrary(draftId) {
  if (fpCanvasDirty || fpHasPendingWrites()) {
    // Save as Draft, Discard, or Cancel — staying keeps the current screen.
    if ((await fpResolveUnsaved('and publish the draft')) !== 'proceed') return;
  }
  await fpConfirmPublishDraft(draftId);
}

// Shared per-draft Publish with the owner-required CONFIRM POPUP. Fetches the
// read-only publish preview BEFORE confirming, so the popup names what will
// go live (counts), what goes back to draft (the currently-published version,
// if any), and the exact skipped placements (deleted/inactive/moved units) —
// Confirm = Publish, Cancel stays. Exactly one version stays published: the
// server demotes the previous one back to DRAFT in the same transaction.
// Returns true when the publish landed.
async function fpConfirmPublishDraft(draftId) {
  let preview;
  try {
    const res = await request(`/drafts/${encodeURIComponent(draftId)}/publish-preview`);
    preview = res.data;
  } catch (err) {
    fpToast('Publish preview: ' + describeError(err), false);
    return false;
  }
  const c = (preview && preview.counts) || {};
  const units = c.placements || 0;
  const blocks = c.blocks || 0;
  const lines = c.boundaries || 0;
  const markers = c.markers || 0;
  const pub = preview && preview.published;
  const selfPublished = pub && pub.id === draftId;
  const unitWord = `${units} unit${units === 1 ? '' : 's'}`;
  const extra = blocks || lines || markers ? ` (+ ${blocks} blocks, ${lines} lines, ${markers} markers)` : '';
  const demoteLine = !pub
    ? 'No version is currently published.'
    : selfPublished
      ? `v${pub.version} is already published — republishing refreshes the live copy with this version.`
      : `v${pub.version} is currently published and will go back to draft.`;
  const skipped = (preview && preview.skippedPlacements) || [];
  const skipLine = skipped.length
    ? ` Skipped (${skipped.length}): ${skipped.join(', ')} — deleted, moved floors, or deactivated since the save; they will not go live.`
    : '';
  // Would-be contracted-unit blockers, listed BEFORE confirm (same semantics as
  // the publish preflight — a blocked draft shows these instead of failing
  // only after confirm; the 409 itself is unchanged).
  const blockers = (preview && preview.blockers) || [];
  const blockerLine = blockers.length
    ? ` Blocked (${blockers.length}): ${blockers.map((b) => `${b.unitCode} (${b.from}→${b.to} sqft)`).join(', ')} — contracted, so this version cannot publish until the drawing is resized back.`
    : '';
  // Empty-plan escalation: a 0-unit publish goes danger-styled with an explicit
  // acknowledgement checkbox (→ confirmEmpty:true) — it can never again publish
  // emptiness silently. The copy states customers will see an empty floor.
  const isEmpty = preview.emptyPlan === true || units === 0;
  const pubOk = await confirmDialog({
    title: isEmpty ? `Publish v${preview.version}? 0 units will go live` : `Publish v${preview.version}? ${units} unit${units === 1 ? '' : 's'} will go live`,
    message: isEmpty
      ? `0 units will go live to booking${extra} — customers will see an empty floor. ${demoteLine}${skipLine}${blockerLine}`
      : `${unitWord} will go live to booking${extra}. ${demoteLine}${skipLine}${blockerLine}`,
    confirmLabel: isEmpty ? 'Publish empty plan' : 'Publish',
    danger: isEmpty,
    requireCheck: isEmpty ? 'I understand customers will see an empty floor' : undefined,
  });
  if (!pubOk) return false;
  try {
    const res = await request(`/drafts/${encodeURIComponent(draftId)}/publish`, {
      method: 'POST',
      body: JSON.stringify(isEmpty ? { confirmEmpty: true } : {}),
    });
    const skippedAfter = (res && res.meta && res.meta.skippedPlacements) || [];
    fpToast(
      `Draft v${preview.version} published — ${unitWord} live.` +
        (skippedAfter.length ? ` Skipped (${skippedAfter.length}): ${skippedAfter.join(', ')}.` : ''),
      !skippedAfter.length,
    );
    await fpFetch(); // reloads live state + clears the loaded-draft mode (screen == live)
    await fpFetchDrafts().catch(() => {});
    return true;
  } catch (err) {
    fpToast('Publish draft: ' + describeError(err), false);
    return false;
  }
}

async function fpSaveDraft() {
  if (!state.fp.floorId) {
    fpToast('Pick a facility and floor first.', false);
    return null;
  }
  const w = fpParseDim($('#fpWidth').value);
  const h = fpParseDim($('#fpHeight').value);
  if (w === null || h === null) {
    fpToast('Canvas size must be a number between 1 and 500 feet (decimals allowed).', false);
    return null;
  }
  const gfaEl = $('#fpGfa');
  const gfaParsed = fpParseGfa(gfaEl ? gfaEl.value : '');
  if (!gfaParsed.ok) {
    fpToast('GFA must be a positive number of sqft (up to 10,000,000) — or empty to unset.', false);
    if (gfaEl) gfaEl.focus();
    return null;
  }
  let structure = null;
  const raw = $('#fpStructure').value.trim();
  if (raw) {
    try {
      structure = JSON.parse(raw);
    } catch (err) {
      fpToast('Structure JSON is invalid — fix the syntax or clear the field.', false);
      return null;
    }
  }
  // Snapshot the CURRENT editor state (which may hold unsaved drag/resize
  // work): the normalized shapes already match the draft snapshot contract,
  // and the server falls back to the live plan for anything omitted.
  const body = {
    width: w,
    height: h,
    structure,
    gfaSqft: gfaParsed.value,
    placements: (state.fp.placements || []).map((p) => ({
      unitId: p.unitId,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      stackTier: p.stackTier || 0,
      doorEdges: p.doorEdges || null,
    })),
    blocks: state.fp.blocks || [],
    boundaries: state.fp.boundaries || [],
    markers: state.fp.markers || [],
  };
  try {
    const saved = await request(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/drafts`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    fpToast(`Draft v${saved.data.version} saved — the live plan is unchanged; the screen now matches v${saved.data.version}.`, true);
    // The canvas now matches the freshly frozen version — point the
    // loaded-version indicator at it and reset the unsaved-changes guard.
    fpCanvasDirty = false;
    fpSetLoadedDraft({ id: saved.data.id, version: saved.data.version });
    await fpFetchDrafts();
    return saved.data;
  } catch (err) {
    fpToast('Save as draft: ' + describeError(err), false);
    return null;
  }
}

async function fpViewDraft(draftId) {
  try {
    const res = await request(`/drafts/${encodeURIComponent(draftId)}`);
    const d = res.data;
    fpView.floorId = d.floor ? d.floor.id : state.fp.floorId;
    fpView.plan = {
      id: d.id,
      status: d.status,
      width: d.width,
      height: d.height,
      structure: d.structure ?? null,
      gfaSqft: d.gfaSqft ?? null,
    };
    fpView.structure = d.structure ?? null;
    // Snapshot arrays already carry the editor normalized shapes — the
    // read-only renderer consumes them directly (no translation).
    fpView.placements = Array.isArray(d.placements) ? d.placements : [];
    fpView.blocks = Array.isArray(d.blocks) ? d.blocks : [];
    fpView.boundaries = Array.isArray(d.boundaries) ? d.boundaries : [];
    fpView.markers = Array.isArray(d.markers) ? d.markers : [];
    fpView.dims = { w: d.width > 0 ? d.width : 70, h: d.height > 0 ? d.height : 80 };
    const title = $('#fpViewTitle');
    if (title) {
      title.textContent = `Draft v${d.version} — ${d.branch ? d.branch.name : ''} · Level ${d.floor ? d.floor.level : ''} (read-only preview)`;
    }
    const overlay = $('#fpViewModal');
    if (overlay) overlay.hidden = false;
    const empty = $('#fpViewEmpty');
    if (empty) empty.hidden = true;
    const wrap = $('#fpViewCanvasWrap');
    if (wrap) wrap.hidden = false;
    fpViewRender();
  } catch (err) {
    fpToast('View draft: ' + describeError(err), false);
  }
}

async function fpDeleteDraft(draftId) {
  const d = fpDrafts.find((r) => r.id === draftId);
  const delOk = await confirmDialog({
    title: `Delete draft v${d ? d.version : ''}?`,
    message: 'The snapshot is removed permanently. The live canvas is unaffected.',
    confirmLabel: 'Delete draft',
    danger: true,
  });
  if (!delOk) return;
  try {
    await request(`/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
    fpToast(`Draft v${d ? d.version : ''} deleted.`, true);
    await fpFetchDrafts();
  } catch (err) {
    fpToast('Delete draft: ' + describeError(err), false);
  }
}

// ---------- new-unit tool (floor-plan unit sync Phase 4) ----------
// N or "＋ New Unit": drag a rectangle on the canvas (snaps to the grid and to
// unit / block / wall corners, so units sit flush), then confirm tier, name,
// AC, pillar and rate in the form. The unit is created DRAFT through the batch
// endpoint (one undo step) and becomes available when the plan is published.
let fpNewDraft = null; // { x, y, width, height, bad } while dragging / in the form

function fpSetNewUnitMode(on, quiet) {
  const next = !!on;
  if (next) {
    if (state.fp.measureMode) fpSetMeasureMode(false);
    state.fp.drawMode = false;
    fpResetPen();
    state.fp.armedMarker = null;
    state.fp.tool = 'select';
    fpRenderMarkerTools();
  }
  if (!next && fpNewDraft) fpCancelNewUnit(true);
  state.fp.newUnitMode = next;
  fpRenderCanvas();
  fpSyncModeUI();
  if (!quiet) {
    fpToast(
      next
        ? 'New unit — drag a rectangle on the canvas. It snaps to corners and edges; Esc cancels.'
        : 'New-unit tool off.',
      true,
    );
  }
}

function fpNewUnitRectFrom(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x: quantizeFt(x), y: quantizeFt(y), width: quantizeFt(Math.abs(b.x - a.x)), height: quantizeFt(Math.abs(b.y - a.y)) };
}

function fpNewUnitProblem(r) {
  if (!(r.width >= MIN_RECT_SIDE_FT) || !(r.height >= MIN_RECT_SIDE_FT)) return 'too small';
  if (fpSqftForRect(r) < 1) return 'under 1 sqft';
  const hit = fpOverlapAt(r.x, r.y, r.width, r.height, null, 0);
  if (hit) return `overlaps ${hit.unitCode}`;
  return null;
}

function fpNewUnitReadout(r) {
  const sqft = fpSqftForRect(r);
  const tier = fpNearestTier(sqft);
  const problem = fpNewUnitProblem(r);
  fpSetReadout(
    `New unit ${formatFt(r.width)} × ${formatFt(r.height)} ft = ${fpFmtArea(sqft)} sqft` +
      (tier ? ` · ${tier.size.name}${tier.inBand ? '' : ' (nearest)'}` : '') +
      (problem ? ` — ${problem}` : ''),
  );
}

function fpRenderNewUnitGhost(canvas, u) {
  const r = fpNewDraft;
  if (!r || !(r.width > 0) || !(r.height > 0)) return;
  const el = document.createElement('div');
  el.className = 'fp-new-ghost' + (r.bad ? ' bad' : '');
  el.style.left = r.x * u + 'px';
  el.style.top = r.y * u + 'px';
  el.style.width = r.width * u + 'px';
  el.style.height = r.height * u + 'px';
  el.textContent = `${fpFmtArea(fpSqftForRect(r))} sqft`;
  canvas.appendChild(el);
}

function fpNewUnitPointerDown(e) {
  e.preventDefault();
  const start = fpSnapPointer(e);
  if (!start) return;
  const a = { x: start.x, y: start.y };
  fpNewDraft = { ...fpNewUnitRectFrom(a, a), bad: true };
  const move = (ev) => {
    const cur = fpSnapPointer(ev);
    if (!cur) return;
    const r = fpNewUnitRectFrom(a, cur);
    fpNewDraft = { ...r, bad: !!fpNewUnitProblem(r) };
    fpRenderCanvas();
    fpNewUnitReadout(r);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    const r = fpNewDraft;
    const problem = r && fpNewUnitProblem(r);
    if (!r || problem) {
      fpNewDraft = null;
      fpRenderCanvas();
      if (r && r.width * fpPx() < 4 && r.height * fpPx() < 4) fpToast('Drag a rectangle to draw a unit (a click alone does nothing).', false);
      else if (problem) fpToast(`Can't draw a unit here — ${problem}.`, false);
      return;
    }
    fpOpenNewUnitForm(r);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function fpCancelNewUnit(quiet) {
  fpNewDraft = null;
  const pop = $('#fpNewUnitPop');
  const hadFocus = pop && pop.contains(document.activeElement);
  if (pop) pop.remove();
  if (hadFocus) {
    try {
      $('#fpNewUnitTool')?.focus({ preventScroll: true });
    } catch (e) { /* noop */ }
  }
  fpRenderCanvas();
  if (!quiet) fpSetReadout('');
}

function fpOpenNewUnitForm(r) {
  const stage = $('#fpStage');
  if (!stage) return;
  const old = $('#fpNewUnitPop');
  if (old) old.remove();
  const sqft = fpSqftForRect(r);
  const tier = fpNearestTier(sqft);
  if (!tier) {
    fpCancelNewUnit(true);
    fpToast('No unit size tiers exist — add size tiers before drawing units.', false);
    return;
  }
  const opts = (state.sizes || [])
    .slice()
    .sort((x, y) => (x.sortOrder || 0) - (y.sortOrder || 0))
    .map((sz) => `<option value="${escapeHtml(sz.id)}"${sz.id === tier.size.id ? ' selected' : ''}>${escapeHtml(sz.name)} (${sz.sqftFrom === sz.sqftTo ? sz.sqftFrom : `${sz.sqftFrom}–${sz.sqftTo}`} sqft)</option>`)
    .join('');
  const pop = document.createElement('form');
  pop.id = 'fpNewUnitPop';
  pop.className = 'fp-newunit-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'New unit');
  pop.innerHTML =
    `<div class="fp-newunit-hdr">New unit <span class="t-type">${formatFt(r.width)} × ${formatFt(r.height)} ft · ${fpFmtArea(sqft)} sqft</span></div>` +
    `<label class="fp-newunit-row"><span>Size tier</span><select class="tbl-select" name="sizeId">${opts}</select></label>` +
    `<div class="fp-pub-note" data-nu-tiernote>${tier.inBand ? '' : `Nearest tier — no tier range covers ${fpFmtArea(sqft)} sqft.`}</div>` +
    `<label class="fp-newunit-row"><span>Name <em class="t-type">(optional)</em></span><input class="tbl-search" name="name" maxlength="80" autocomplete="off" placeholder="Shown instead of the unit code"></label>` +
    `<label class="fp-newunit-row"><span>Monthly rate (S$)</span><input class="tbl-search" name="rate" type="number" min="0" step="0.01" required></label>` +
    `<div class="fp-pub-note" data-nu-psf></div>` +
    `<div class="fp-newunit-checks"><label><input type="checkbox" name="hasAC"> Air-conditioned</label><label><input type="checkbox" name="hasPillar"> Has a pillar</label></div>` +
    `<div class="fp-pub-note">Created as a <b>draft</b> with the next unit code; it becomes available when you publish the plan.</div>` +
    `<div class="fp-newunit-actions"><button type="button" class="act-btn" data-nu-cancel>Cancel</button><button type="submit" class="act-btn primary">Create unit</button></div>`;
  stage.appendChild(pop);
  // Anchor beside the drawn rectangle in the stage's SCROLLED content
  // coordinates (the stage is the scroll container), right of it when there
  // is room, else left; then bring it into view. A fixed top/right offset
  // would land off-screen whenever the plan is scrolled or zoomed.
  const ghostEl = $('#fpCanvas .fp-new-ghost');
  if (ghostEl) {
    const sr = stage.getBoundingClientRect();
    const gr = ghostEl.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const gap = 10;
    const contentW = Math.max(stage.scrollWidth, stage.clientWidth);
    let left = gr.right - sr.left + stage.scrollLeft + gap;
    if (left + pw > contentW - 4) left = gr.left - sr.left + stage.scrollLeft - pw - gap;
    left = Math.max(stage.scrollLeft + 4, left);
    const top = Math.max(4, gr.top - sr.top + stage.scrollTop);
    pop.style.left = left + 'px';
    pop.style.top = Math.min(top, Math.max(4, stage.scrollHeight - ph - 4)) + 'px';
    pop.style.right = 'auto';
  }
  try {
    pop.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } catch (e) { /* noop */ }
  const sizeSel = pop.elements.sizeId;
  const rateIn = pop.elements.rate;
  let rateTouched = false;
  const sync = () => {
    const sz = (state.sizes || []).find((x) => x.id === sizeSel.value);
    if (!rateTouched && sz) rateIn.value = fpDefaultRate(sz.code, sqft).toFixed(2);
    const rate = Number(rateIn.value);
    pop.querySelector('[data-nu-psf]').textContent = Number.isFinite(rate) && rate >= 0 ? `S$${(rate / sqft).toFixed(2)}/sqft · default is the ${sz ? sz.name : ''} market rate × sqft` : '';
    pop.querySelector('[data-nu-tiernote]').textContent = sz && sz.id === tier.size.id && !tier.inBand ? `Nearest tier — no tier range covers ${fpFmtArea(sqft)} sqft.` : '';
  };
  sizeSel.addEventListener('change', sync);
  rateIn.addEventListener('input', () => {
    rateTouched = true;
    sync();
  });
  sync();
  pop.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      fpCancelNewUnit();
    }
  });
  pop.querySelector('[data-nu-cancel]').addEventListener('click', () => fpCancelNewUnit());
  pop.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const rate = Number(rateIn.value);
    if (!(Number.isFinite(rate) && rate >= 0)) {
      rateIn.focus();
      return;
    }
    const spec = {
      sizeId: sizeSel.value,
      name: pop.elements.name.value.trim() || null,
      hasAC: pop.elements.hasAC.checked,
      hasPillar: pop.elements.hasPillar.checked,
      monthlyRate: Math.round(rate * 100) / 100,
    };
    pop.querySelector('button[type="submit"]').disabled = true;
    const ok = await fpCreateUnits([{ rect: r, spec }]);
    if (ok) fpCancelNewUnit(true);
    else pop.querySelector('button[type="submit"]').disabled = false;
  });
  try {
    sizeSel.focus({ preventScroll: true });
  } catch (e) { /* noop */ }
}

// Create DRAFT units in one batch (one undo step). items: [{ rect, spec }].
async function fpCreateUnits(items, verbOverride) {
  const targets = items.map(({ rect, spec }) => {
    const id = fpNewId('new');
    return {
      type: 'placement',
      id,
      state: { unitId: id, x: rect.x, y: rect.y, width: rect.width, height: rect.height, stackTier: rect.stackTier || 0, doorEdges: null },
      createSpec: spec,
    };
  });
  const prior = targets.map((t) => ({ type: 'placement', id: t.id, state: null, createSpec: t.createSpec }));
  const ok = await fpCommitBatch(targets, verbOverride || 'Create unit', prior, { silent: !verbOverride });
  if (!ok) return false;
  const codes = [];
  const ids = [];
  for (const t of targets) {
    const ref = fpLastCreated[t.id];
    if (!ref) continue;
    codes.push(ref.unitCode);
    ids.push(ref.id);
    if (t.createSpec.monthlyRate != null) {
      state.fp.draftSpecs = state.fp.draftSpecs || {};
      state.fp.draftSpecs[ref.id] = { monthlyRate: t.createSpec.monthlyRate, sqft: fpSqftForRect(t.state) };
    }
  }
  if (ids.length === 1) {
    fpClearSingles();
    state.fp.selected = ids[0];
    fpRenderCanvas();
    fpRenderSelInfo();
  } else if (ids.length) fpSetSelection(ids.map((id) => ({ type: 'placement', id })));
  if (!verbOverride) fpToast(`Created ${codes.join(', ')} as a draft — publish the plan to make ${codes.length === 1 ? 'it' : 'them'} available.`, true);
  return true;
}

// Duplicate a unit: a new DRAFT unit with the same footprint and settings in
// the first free spot right of / below / left of / above it.
async function fpDuplicateUnit(pl) {
  const { w: cw, h: ch } = fpCanvasDims();
  const tries = [
    [pl.x + pl.width, pl.y],
    [pl.x, pl.y + pl.height],
    [pl.x - pl.width, pl.y],
    [pl.x, pl.y - pl.height],
  ];
  const spot = tries
    .map(([x, y]) => ({ x: quantizeFt(x), y: quantizeFt(y), width: pl.width, height: pl.height }))
    .find((r) => r.x >= 0 && r.y >= 0 && toMilli(r.x) + toMilli(r.width) <= toMilli(cw) && toMilli(r.y) + toMilli(r.height) <= toMilli(ch) && !fpOverlapAt(r.x, r.y, r.width, r.height, null, 0));
  if (!spot) {
    fpToast(`No free spot next to ${pl.unitCode} for a copy — make room or draw one with ＋ New Unit.`, false);
    return;
  }
  const spec = fpDraftSpec(pl);
  delete spec.monthlyRate; // the copy gets the default rate for its tier
  spec.name = null;
  await fpCreateUnits([{ rect: spot, spec }]);
}

// ---------- reconcile sizes (floor-plan unit sync Phase 4) ----------
// Placed units whose drawing and unit size disagree from before the floor
// plan owned sizes (old 15% / 2% bands). Per unit: "Use drawing" flags it so
// the next publish sets the unit's sqft from the drawing; "Fit drawing"
// resizes the drawing to the unit's sqft. Never automatic.
async function fpOpenReconcile() {
  if (!state.fp.floorId || !state.fp.plan) {
    fpToast('Open a floor with a plan first.', false);
    return;
  }
  let rows;
  try {
    rows = await get(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/size-mismatches`);
  } catch (err) {
    fpToast('Sizes: ' + describeError(err), false);
    return;
  }
  const modal = $('#fpReconcileModal');
  const body = $('#fpReconcileBody');
  if (!modal || !body) return;
  const render = (list) => {
    if (!list.length) {
      body.innerHTML = '<p class="fp-pub-note">Every placed unit’s drawing matches its size (within 0.05 sqft). Nothing to reconcile.</p>';
      return;
    }
    body.innerHTML =
      `<p class="fp-pub-note">${list.length} unit${list.length === 1 ? '' : 's'} drawn at a different size than ${list.length === 1 ? 'its' : 'their'} unit record (drawn before the floor plan set unit sizes). Pick one fix per unit — nothing changes automatically.</p>` +
      '<div class="fp-publish-scroll"><table class="data-tbl"><thead><tr><th>Unit</th><th>Unit sqft</th><th>Drawn</th><th></th></tr></thead><tbody>' +
      list
        .map(
          (m) =>
            `<tr><td><b>${escapeHtml(m.unitCode)}</b><div class="fp-pub-note">${escapeHtml(String(m.status).toLowerCase())}</div></td>` +
            `<td>${fpFmtArea(m.sqft)}</td>` +
            `<td>${fpFmtArea(m.drawnSqft)}<div class="fp-pub-note">${formatFt(m.widthFt)}×${formatFt(m.heightFt)} ft</div></td>` +
            `<td style="white-space:nowrap">` +
            `<button class="act-btn" type="button" data-rc="MARK_FOR_SYNC" data-rc-unit="${escapeHtml(m.unitId)}"${m.contracted ? ` disabled title="${escapeHtml(m.unitCode)} is ${escapeHtml(String(m.contracted).toLowerCase())} — its size can't change"` : ` title="On the next publish, set the unit to ${fpFmtArea(m.drawnSqft)} sqft (rate and tier per the publish review)"`}>Use drawing</button> ` +
            `<button class="act-btn" type="button" data-rc="FIT_DRAWING" data-rc-unit="${escapeHtml(m.unitId)}" title="Resize the drawing to ${fpFmtArea(m.sqft)} sqft from the same corner">Fit drawing</button>` +
            `</td></tr>`,
        )
        .join('') +
      '</tbody></table></div>';
  };
  render(rows);
  body.onclick = async (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-rc]') : null;
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    if (btn.dataset.rc === 'FIT_DRAWING') {
      // Through the editor's batch path so it is one undo step like any resize.
      const pl = state.fp.placements.find((x) => x.unitId === btn.dataset.rcUnit);
      if (!pl) return;
      const fp = sizeFootprint(pl.sizeCode, pl.sqft);
      const landscape = pl.width >= pl.height;
      const [w, h] = landscape === fp.w >= fp.h ? [fp.w, fp.h] : [fp.h, fp.w];
      const ok = await fpCommitBatch([{ type: 'placement', id: pl.unitId, state: { ...fpElemState('placement', pl.unitId), width: w, height: h } }], `Fitted ${pl.unitCode}'s drawing to ${fpFmtArea(pl.sqft)} sqft.`);
      if (!ok) {
        btn.disabled = false;
        return;
      }
      render(await get(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/size-mismatches`));
      return;
    }
    try {
      const res = await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({ items: [{ unitId: btn.dataset.rcUnit, action: btn.dataset.rc }] }),
      });
      render(res.data.mismatches);
      const plan = await get(`/floor-plans/${encodeURIComponent(state.fp.floorId)}`);
      fpApplyPlanPayload(plan, true);
      fpToast('Unit will take the drawn size when you publish (review it in Publish).', true);
    } catch (err) {
      btn.disabled = false;
      fpToast('Sizes: ' + describeError(err), false);
    }
  };
  const close = () => {
    modal.hidden = true;
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  $('#fpReconcileClose').onclick = close;
  $('#fpReconcileDone').onclick = close;
  modal.onclick = (ev) => {
    if (ev.target === modal) close();
  };
  modal.hidden = false;
  try {
    $('#fpReconcileDone').focus({ preventScroll: true });
  } catch (e) { /* noop */ }
}

// A new DRAFT locker as the upper tier of the selected single locker.
async function fpStackNewLocker() {
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  if (!pl || !fpIsLockerPlacement(pl) || fpStackMate(pl)) return;
  const spec = fpDraftSpec(pl);
  delete spec.monthlyRate;
  spec.name = null;
  await fpCreateUnits([{ rect: { x: pl.x, y: pl.y, width: pl.width, height: pl.height, stackTier: 1 }, spec }]);
}

async function fpRemovePlacement() {
  const pl = state.fp.placements.find((p) => p.unitId === state.fp.selected);
  if (!pl) return;
  if (fpGuardLocked(pl)) return; // live occupied placement: no delete
  if (fpIsDraftUnit(pl)) {
    const discardOk = await confirmDialog({
      title: `Discard new unit ${pl.unitCode}?`,
      message: 'It was never published, so the unit is deleted along with its drawing. Undo brings it back.',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!discardOk) return;
    await fpCommitBatch([{ type: 'placement', id: pl.unitId, state: null }], `Discarded new unit ${pl.unitCode}.`);
    return;
  }
  const plOk = await confirmDialog({
    title: `Remove ${pl.unitCode} from the floor plan?`,
    message: 'The unit itself is unaffected.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!plOk) return;
  const removedPrev = { x: pl.x, y: pl.y, width: pl.width, height: pl.height, stackTier: pl.stackTier || 0, doorEdges: pl.doorEdges || null };
  try {
    await fpMutate(`/floor-plans/${encodeURIComponent(state.fp.floorId)}/units/${encodeURIComponent(pl.unitId)}`, {
      method: 'DELETE',
    });
    fpPushUndo({ kind: 'placement', unitId: pl.unitId, prev: removedPrev }); // undo = re-PUT the removed placement
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
  markers: [], // normalized safety/facility point icons
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
  fpView.markers = fpNormalizeMarkers(body.plan);
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
  fpRenderBoundaryLayer(canvas, u, fpView.dims, fpView.boundaries || [], false, null);
  for (const blk of fpView.blocks) {
    const el = document.createElement('div');
    el.className = 'fp-block';
    el.dataset.blockId = blk.id;
    el.style.left = blk.x * u + 'px';
    el.style.top = blk.y * u + 'px';
    el.style.width = blk.width * u + 'px';
    el.style.height = blk.height * u + 'px';
    el.style.background = fpBlockFill(blk);
    const name = document.createElement('span');
    name.className = 'fp-block-name';
    name.textContent = blk.name || 'Block';
    el.appendChild(name);
    canvas.appendChild(el);
  }
  const statusDot = null; // retired: tile colours come from fpStatusColor() (no grey unknown fallback)
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
      el.title = (fpIsOccupiedLocked(lower) || fpIsOccupiedLocked(upper))
        ? `Stacked pair — upper ${upper.unitCode} (${upper.status}) / lower ${lower.unitCode} (${lower.status}) — Occupied — uneditable when live`
        : `Stacked pair — upper ${upper.unitCode} (${upper.status}) / lower ${lower.unitCode} (${lower.status}) · doors auto (stacked pairs stay AUTO)`;
      el.innerHTML =
        `<div class="fp-status" style="background:${fpStatusColor(lower.status)};"></div>` +
        `<div class="fp-code fp-stack-upper">${escapeHtml(upper.unitCode)}</div>` +
        `<div class="fp-stack-divider"></div>` +
        `<div class="fp-code fp-stack-lower">${escapeHtml(lower.unitCode)}</div>` +
        fpDoorMarkersHTML({ doorEdges: null }, u);
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
    if (fpIsOccupiedLocked(pl)) el.title = fpLockedTooltip(pl);
    el.innerHTML =
      `<div class="fp-status" style="background:${fpStatusColor(pl.status)};"></div>` +
      `<div class="fp-code">${escapeHtml(pl.unitCode)}</div>` +
      (pl.height * u > 34 ? `<div class="fp-size">${escapeHtml(pl.sizeName)}</div>` : '') +
      fpUnitTagsHTML(pl) +
      fpDoorMarkersHTML(pl, u) +
      (fpIsOccupiedLocked(pl) ? '' : `<div class="fp-resize" title="Drag to resize"></div>`);
    canvas.appendChild(el);
  }
  // Safety/facility point icons, static in the read-only preview.
  fpRenderMarkerLayer(canvas, u, fpView.markers || [], false, null);
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
// (pen / vertex drags) live on document too but only react to Escape, so there is no
// conflict. Guards: typing (inputs/selects/contenteditable — covers the
// block-name, marker-label, canvas-dims and structure-JSON fields), the read-only
// #fpViewModal preview (editor-only shortcut), and an open #confirmModal (a
// re-press must not supersede the pending confirm). Priority mirrors
// fpRenderSelInfo: boundary line, then marker, then decoration block, then
// unit placement.
// fpDeletePlan (whole-plan delete) is NEVER bound here.
// Tool shortcuts: L toggles the line tool, M the measure tool; Esc clears a
// measurement (then leaves the measure tool). Same guards as Delete.
function fpOnToolKey(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && typeof t.closest === 'function' && t.closest('input, textarea, select, [contenteditable]')) return;
  const designer = document.querySelector('#facility-floorplans');
  if (!designer || designer.offsetParent === null) return;
  const viewModal = $('#fpViewModal');
  if (viewModal && !viewModal.hidden) return;
  const confirmModal = $('#confirmModal');
  if (confirmModal && !confirmModal.hidden) return;
  if (e.key === 'Escape' && state.fp.underlayMode) {
    e.preventDefault();
    fpSetUnderlayMode(null);
    return;
  }
  if (e.key === 'Escape' && state.fp.measureMode) {
    e.preventDefault();
    if (fpMeasure) {
      fpMeasure = null;
      fpRenderCanvas();
      fpMeasureReadout(null);
    } else fpSetMeasureMode(false);
  } else if (e.key === 'l' || e.key === 'L') {
    e.preventDefault();
    $('#fpBoundaryTool')?.click();
  } else if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    fpSetMeasureMode(!state.fp.measureMode);
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    fpSetNewUnitMode(!state.fp.newUnitMode);
  } else if (e.key === 'Escape' && (fpNewDraft || state.fp.newUnitMode)) {
    e.preventDefault();
    if (fpNewDraft) fpCancelNewUnit();
    else fpSetNewUnitMode(false);
  }
}

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
  if (state.fp.multi && state.fp.multi.length > 1) {
    e.preventDefault();
    fpDeleteMulti();
  } else if (state.fp.selectedBoundary && state.fp.selectedVertex != null) {
    e.preventDefault();
    fpDeleteSelectedVertex();
  } else if (state.fp.selectedBoundary) {
    e.preventDefault();
    fpRemoveBoundary();
  } else if (state.fp.selectedMarker) {
    e.preventDefault();
    fpRemoveMarker();
  } else if (state.fp.selectedBlock) {
    e.preventDefault();
    fpRemoveBlock();
  } else if (state.fp.selected) {
    e.preventDefault();
    fpRemovePlacement();
  }
  // else: nothing selected → no-op
}

// ---------- Studio ribbon helpers (additive; existing flows untouched) ----------
// Bottom-right toast stack. fpToast() keeps driving the legacy #fpBanner (all
// existing callers rely on it) and mirrors every message here.
function fpStudioToast(msg, ok) {
  try {
    const stack = $('#fpToasts');
    if (!stack || !msg) return;
    const el = document.createElement('div');
    el.className = 'fp-toast' + (ok === false ? ' err' : ok === true ? ' ok' : '');
    el.textContent = msg;
    stack.appendChild(el);
    while (stack.children.length > 4) stack.firstChild.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 250);
    }, 4200);
  } catch (_) {
    // Toasts are cosmetic — never break the editor.
  }
}

// Effective Studio mode for the segmented control + MODE badge. Placement
// modes (armed marker, line tool) win over the sticky tool so the badge is
// always truthful; block mode sticks while its form is open.
function fpEffectiveMode() {
  if (state.fp.underlayMode === 'calibrate') return 'calibrate';
  if (state.fp.underlayMode === 'move') return 'underlay';
  if (state.fp.armedMarker) return 'marker';
  if (state.fp.drawMode) return 'draw';
  if (state.fp.measureMode) return 'measure';
  if (state.fp.newUnitMode) return 'newunit';
  if (state.fp.tool === 'add') return 'add';
  if (state.fp.tool === 'block') return 'block';
  return 'select';
}

// Highlight the active Mode segment, sync aria-pressed, and paint the
// workspace MODE: badge. Null-safe so it can run on every fpRender().
function fpSyncModeUI() {
  const mode = fpEffectiveMode();
  const badge = $('#fpModeIndicator');
  if (badge) {
    badge.textContent =
      mode === 'calibrate'
        ? 'MODE: CALIBRATE UNDERLAY'
        : mode === 'underlay'
          ? 'MODE: MOVE UNDERLAY'
          : mode === 'marker'
        ? 'MODE: MARKER'
        : mode === 'measure'
          ? 'MODE: MEASURE'
          : mode === 'draw'
          ? `MODE: DRAW ${fpLineKindLabel(fpPenKind()).toUpperCase()}`
          : mode === 'newunit'
            ? 'MODE: NEW UNIT — DRAG A RECTANGLE'
          : mode === 'add'
            ? 'MODE: ADD UNIT'
            : mode === 'block'
              ? 'MODE: BLOCK'
              : 'MODE: SELECT';
  }
  const set = (id, on) => {
    const b = $(id);
    if (!b) return;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  };
  set('#fpModeSelect', mode === 'select');
  set('#fpModeAddUnit', mode === 'add');
  set('#fpNewUnitTool', mode === 'newunit');
  // fpBoundaryTool/fpAddBlock keep their own .on sync (pencil toggle / block
  // form); mirror the effective mode here so the segmented control reads as one.
  const pencil = $('#fpBoundaryTool');
  if (pencil) {
    pencil.classList.toggle('on', mode === 'draw');
    pencil.setAttribute('aria-pressed', String(mode === 'draw'));
  }
  const blk = $('#fpAddBlock');
  if (blk) {
    blk.classList.toggle('on', mode === 'block');
    blk.setAttribute('aria-pressed', String(mode === 'block'));
  }
}

function fpSetMarkersMenu(open) {
  const menu = $('#fpMarkersMenu');
  if (!menu) return;
  menu.hidden = !open;
  $('#fpMarkersBtn')?.setAttribute('aria-expanded', String(!!open));
}

export function fpInitEvents() {
  // Wiring follows the toolbar groups in canonical order (see
  // FP_TOOLBAR_GROUPS): units → mode → markers → canvas → plan → view → info.
  // --- Group: header (branch/floor scope + save/delete plan actions, delete last) ---
  $('#fpBranch').addEventListener('change', async (e) => {
    const next = e.target.value;
    e.target.value = state.fp.branchCode; // hold until the unsaved guard resolves
    if ((await fpResolveUnsaved('and switch facilities')) !== 'proceed') return;
    fpFlushNudge(); // a pending nudge persists against the floor it was made on
    state.fp.branchCode = next;
    state.fp.floorId = null;
    fpPopulateFloorSelect();
    if (state.fp.floorId) fpFetch().catch(() => {});
  });
  $('#fpFloor').addEventListener('change', async (e) => {
    const next = e.target.value;
    e.target.value = state.fp.floorId; // hold until the unsaved guard resolves
    if ((await fpResolveUnsaved('and switch floors')) !== 'proceed') return;
    fpFlushNudge(); // a pending nudge persists against the floor it was made on
    state.fp.floorId = next;
    fpFetch().catch(() => {});
  });
  $('#fpSaveCanvas').addEventListener('click', fpSaveCanvas);
  $('#fpSaveDraft').addEventListener('click', fpSaveDraft);
  $('#fpPublishPlan').addEventListener('click', fpPublishPlan);
  $('#fpDeletePlan').addEventListener('click', fpDeletePlan);
  // --- Group: units (Units) — palette ghost orientation + sqft lock ---
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
  // Lock-to-sqft resize (default OFF since the floor-plan unit sync: a resize
  // changes the unit's size on publish). ON reshapes while keeping area ≈ sqft;
  // contracted units are always locked regardless.
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
        fpToast('Sqft lock OFF — resizing changes the unit\'s size (synced on publish). Rented/reserved units stay locked to their sqft.', true);
      } else {
        fpToast('Sqft lock ON — resize reshapes the unit while keeping its area ≈ sqft.', true);
      }
    });
  }
  // --- Group: draw (Select/Draw) — pencil (line) tool ---
  // Pencil (line) tool: toggles draw mode like the other ghost toggles. While
  // ON, canvas press-drag draws a straight grid-ft line persisted as an OPEN
  // boundary polyline (kind 'PENCIL') via POST /floor-plans/:id/boundaries.
  // Persisted lines render SOLID. Marked-area rule: >= 3-vertex polylines feed
  // UFA/NLA (chord-closed); a 2-vertex segment contributes 0 until it is
  // extended/closed via the selection strip's Close-loop action.
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
      fpResetPen();
      if (state.fp.drawMode && state.fp.measureMode) fpSetMeasureMode(false);
      if (state.fp.drawMode && state.fp.armedMarker) {
        // One placement mode at a time — arming the line tool disarms markers.
        state.fp.armedMarker = null;
        fpRenderMarkerTools();
      }
      syncPencilBtn();
      fpRenderCanvas();
      // Studio Mode segment follows the line tool.
      state.fp.tool = state.fp.drawMode ? 'draw' : 'select';
      fpSyncModeUI();
      fpToast(
        state.fp.drawMode
          ? `Draw tool ON (${fpLineKindLabel(fpPenKind())}) — click to add vertices, double-click or Enter to finish, click the first vertex or C to close. Type a length (Tab = angle) + Enter for exact segments; Shift = 0/45/90°; Esc cancels.`
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
  // Enter in the GFA field commits the whole canvas form (dims + GFA) via the
  // same Save-Canvas path; an empty field unsets the GFA (canvas fallback).
  $('#fpGfa')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fpSaveCanvas().catch(() => {});
      e.target.blur();
    }
  });
  // --- Group: view (zoom) ---
  $('#fpZoomIn').addEventListener('click', () => fpZoomStep(1));
  $('#fpZoomOut').addEventListener('click', () => fpZoomStep(-1));
  // Modifier-gated canvas zoom (see fpOnCanvasWheel) + editor Delete shortcut
  // (see fpOnDeleteKey) — both attached once here, never per-render.
  $('#fpCanvasWrap').addEventListener('wheel', fpOnCanvasWheel, { passive: false });
  // Pen + tool shortcuts first: fpPenKey stops propagation for the keys it
  // consumes (Backspace / Enter / Esc / digits) so Delete / arrows never fire.
  document.addEventListener('keydown', fpPenKey);
  document.addEventListener('keydown', fpOnToolKey);
  document.addEventListener('keydown', fpOnEditKey);
  // Never lose a pending write (debounced nudge, in-flight save) on unload.
  window.addEventListener('beforeunload', (e) => {
    if (!fpHasPendingWrites()) return;
    fpFlushNudge();
    fpFlushGroupNudge();
    e.preventDefault();
    e.returnValue = '';
  });
  document.addEventListener('keydown', fpOnDeleteKey);
  document.addEventListener('keydown', fpOnArrowKey);
  // Escape cancels an armed marker (the line tool owns its own mid-draft Escape).
  document.addEventListener('keydown', fpOnEscapeTool);
  // --- Group: units (palette drag, palette toggle, auto-place) + blocks (block form) ---
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
  $('#fpAddBlock').addEventListener('click', () => {
    fpToggleBlockForm(true);
    // Studio Mode segment follows the block form.
    state.fp.tool = 'block';
    fpSyncModeUI();
  });
  const fpAutoBtn = $('#fpAutoPlace');
  if (fpAutoBtn) fpAutoBtn.addEventListener('click', fpAutoPlaceAll);
  // Auto-doors: corridor→door inference persisted via the existing placement
  // PUT (manual N/S/E/W toggles untouched). Registered in FP_TOOLBAR_GROUPS.
  const fpDoorsBtn = $('#fpAutoDoors');
  if (fpDoorsBtn) fpDoorsBtn.addEventListener('click', () => fpAutoDoors().catch(() => {}));
  // Undo: replays the last draw/move/delete inverse op via DELETE/PUT.
  const fpUndoBtn = $('#fpUndoBtn');
  if (fpUndoBtn) fpUndoBtn.addEventListener('click', () => fpUndo().catch(() => {}));
  $('#fpRedoBtn')?.addEventListener('click', () => fpRedo().catch(() => {}));
  fpSyncUndoButtons();
  // Layers menu (show / lock per layer, remembered per browser) + shortcut sheet.
  fpLoadLayers();
  fpRenderLayersMenu();
  $('#fpLayersBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#fpLayersMenu');
    if (!menu) return;
    menu.hidden = !menu.hidden;
    $('#fpLayersBtn').setAttribute('aria-expanded', String(!menu.hidden));
  });
  $('#fpLayersMenu')?.addEventListener('click', (e) => e.stopPropagation());
  $('#fpLayersMenu')?.addEventListener('change', (e) => {
    const box = e.target;
    if (!box || !box.dataset || !box.dataset.fpLayer) return;
    const prop = box.dataset.fpLayerProp;
    fpSetLayerProp(box.dataset.fpLayer, prop, prop === 'hidden' ? !box.checked : box.checked);
  });
  document.addEventListener('pointerdown', () => {
    const menu = $('#fpLayersMenu');
    if (menu && !menu.hidden) {
      menu.hidden = true;
      $('#fpLayersBtn')?.setAttribute('aria-expanded', 'false');
    }
  });
  $('#fpShortcutsBtn')?.addEventListener('click', () => fpToggleShortcutSheet());
  // 🗺 Underlay + ⤓ Export dropdowns (same open/close pattern as Layers).
  fpWireUnderlayPanel();
  fpRenderUnderlayMenu();
  for (const [btnId, menuId] of [['#fpUnderlayBtn', '#fpUnderlayMenu'], ['#fpExportBtn', '#fpExportMenu']]) {
    $(btnId)?.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $(menuId);
      if (!menu) return;
      menu.hidden = !menu.hidden;
      $(btnId).setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden && menuId === '#fpUnderlayMenu') fpRenderUnderlayMenu();
    });
    $(menuId)?.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.addEventListener('pointerdown', () => {
      const menu = $(menuId);
      if (menu && !menu.hidden) {
        menu.hidden = true;
        $(btnId)?.setAttribute('aria-expanded', 'false');
      }
    });
  }
  $('#fpExportGo')?.addEventListener('click', () => fpExport());
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+Z undoes the last designer draw/move/delete (not while typing
    // in an input, and not when the block-name field owns Enter/Escape).
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === 'z') {
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (typing) return;
      if (!document.querySelector('#facility-floorplans.active-view, #facility-floorplans')) return;
      const designerVisible = document.querySelector('#facility-floorplans');
      if (!designerVisible || designerVisible.offsetParent === null) return;
      e.preventDefault();
      fpUndo().catch(() => {});
    }
  });
  // Designer palette AC filter (All / AC / Non-AC).
  $('#fpAcFilter')?.addEventListener('change', (e) => fpSetAcFilter(e.target.value));
  $('#fpBlockAdd').addEventListener('click', fpAddBlock);
  $('#fpBlockCancel').addEventListener('click', () => {
    fpToggleBlockForm(false);
    if (state.fp.tool === 'block') state.fp.tool = 'select';
    fpSyncModeUI();
  });
  $('#fpBlockName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fpAddBlock();
    } else if (e.key === 'Escape') {
      fpToggleBlockForm(false);
    }
  });
  // Block-form fill controls: palette swatches stage state.fp.blockColor, the
  // native input stages a custom hex, Default clears back to the default tone.
  $('#fpBlockSwatches')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-block-color]');
    if (!btn) return;
    state.fp.blockColor = String(btn.dataset.blockColor || '').toUpperCase() || null;
    fpRenderBlockFormSwatches();
  });
  $('#fpBlockColor')?.addEventListener('input', (e) => {
    state.fp.blockColor = String(e.target.value || '').toUpperCase() || null;
    fpRenderBlockFormSwatches();
  });
  $('#fpBlockColorClear')?.addEventListener('click', () => {
    state.fp.blockColor = null;
    fpRenderBlockFormSwatches();
  });
  // --- Group: markers (Markers/Safety) — arm-a-kind buttons render from
  // FP_MARKER_KINDS via fpRenderMarkerTools(); clicks delegate by data-kind.
  $('#fpMarkerTools')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-marker-kind]');
    if (!btn) return;
    fpToggleArmedMarker(btn.dataset.markerKind);
  });
  // --- Group: info (Labels) — canvas selection/drag dispatch + selection strip ---
  $('#fpCanvasWrap').addEventListener('pointerdown', (e) => {
    fpFlushNudge(); // land any debounced nudge before a new drag captures undo state
    // Armed marker (Markers/Safety group): the next canvas click places the
    // armed kind and disarms — same mode-gated pattern as the line tool below
    // (placement/block/line interactions stay off until placed or cancelled).
    if (state.fp.armedMarker) {
      const canvas = $('#fpCanvas');
      if (canvas && canvas.contains(e.target)) {
        const p = fpCanvasPointAt(e.clientX, e.clientY, e);
        if (p) fpPlaceMarker(state.fp.armedMarker, p.x, p.y);
      }
      return;
    }
    // Underlay calibrate / move modes own the canvas while active.
    if (state.fp.underlayMode) {
      const canvas = $('#fpCanvas');
      if (canvas && canvas.contains(e.target)) fpUnderlayPointerDown(e);
      return;
    }
    // Line tool active: canvas press-drag draws a straight line and the
    // placement/block interactions below are mode-gated off until the tool
    // toggles off. Only canvas surfaces start a line (wrap padding is inert).
    if (state.fp.drawMode) {
      const canvas = $('#fpCanvas');
      if (canvas && canvas.contains(e.target)) fpPenPointerDown(e);
      return;
    }
    // Measure tool: two snapped clicks show a temporary dimension.
    if (state.fp.measureMode) {
      const canvas = $('#fpCanvas');
      if (canvas && canvas.contains(e.target)) fpMeasurePointerDown(e);
      return;
    }
    // New-unit tool: drag a rectangle (object-snapped) to draw a unit.
    if (state.fp.newUnitMode) {
      const canvas = $('#fpCanvas');
      if (canvas && canvas.contains(e.target) && e.button === 0 && !fpNewDraft) fpNewUnitPointerDown(e);
      return;
    }
    // Selected line: its vertex / midpoint handles win over everything below
    // (handles can sit on top of units and blocks).
    const vHit = fpLayerLocked('lines') ? null : fpVertexHitAt(e.clientX, e.clientY);
    if (vHit) {
      fpVertexStartDrag(e, vHit);
      return;
    }
    state.fp.selectedVertex = null;
    state.fp.arrayOpen = false;
    // Locked / hidden layers (Layers menu) ignore pointer input.
    const placed = fpLayerLocked('units') ? null : e.target.closest('.fp-placed');
    const marker = fpLayerLocked('markers') ? null : e.target.closest('.fp-marker');
    const blk = fpLayerLocked('blocks') ? null : e.target.closest('.fp-block');
    // Marker badges render topmost, so they hit-test before blocks.
    const hitRef = placed
      ? { type: 'placement', id: placed.dataset.unitId }
      : marker
        ? { type: 'marker', id: marker.dataset.markerId }
        : blk
          ? { type: 'block', id: blk.dataset.blockId }
          : null;
    // Shift-click toggles multi-selection; dragging a member moves the group.
    if (hitRef && e.shiftKey) {
      e.preventDefault();
      fpToggleMulti(hitRef.type, hitRef.id);
      return;
    }
    if (hitRef && state.fp.multi && state.fp.multi.length > 1 && fpInMulti(hitRef.type, hitRef.id) && !e.target.classList.contains('fp-resize')) {
      fpGroupStartMove(e);
      return;
    }
    if (hitRef) state.fp.multi = [];
    if (placed) {
      fpStartMove(e, placed);
      return;
    }
    if (marker) {
      fpMarkerStartMove(e, marker);
      return;
    }
    if (blk) {
      fpBlockStartMove(e, blk);
      return;
    }
    // click near a drawn boundary line → select it (the SVG layer is
    // pointer-events:none, so the segment hit-test runs here)
    const bndHit = fpLayerLocked('lines') ? null : fpBoundaryHitAt(e.clientX, e.clientY);
    if (bndHit) {
      state.fp.multi = [];
      state.fp.selectedBoundary = bndHit;
      state.fp.selected = null;
      state.fp.selectedBlock = null;
      state.fp.selectedMarker = null;
      fpRenderCanvas();
      fpRenderSelInfo();
      return;
    }
    // Empty canvas: drag = marquee select (Shift adds); a plain click deselects.
    if (e.button === 0) fpMarqueeStart(e);
  });
  $('#fpSelInfo').addEventListener('click', (e) => {
    const alignBtn = e.target && e.target.closest ? e.target.closest('[data-fp-align]') : null;
    if (alignBtn) {
      fpAlignMulti(alignBtn.dataset.fpAlign);
      return;
    }
    const id = e.target && e.target.id;
    if (id === 'fpMultiRemoveBtn') return void fpDeleteMulti();
    if (id === 'fpDupBtn') return void fpDuplicateSelection();
    if (id === 'fpArrayBtn' || id === 'fpArrayCancel') {
      state.fp.arrayOpen = id === 'fpArrayBtn';
      fpRenderSelInfo();
      if (state.fp.arrayOpen) $('#fpSelInfo [data-fp-arr="count"]')?.select();
      return;
    }
    if (id === 'fpArrayApply') return void fpApplyArray();
    if (id === 'fpCalibApply') return void fpApplyCalibration();
    if (id === 'fpCalibCancel') return void fpSetUnderlayMode(null);
    if (e.target && e.target.id === 'fpRemoveBtn') fpRemovePlacement();
    else if (e.target && e.target.id === 'fpRotateBtn') fpRotatePlacement();
    else if (e.target && e.target.id === 'fpStackBtn') fpStackSelected();
    else if (e.target && e.target.id === 'fpStackNewBtn') fpStackNewLocker();
    else if (e.target && e.target.id === 'fpUnstackBtn') fpUnstackSelected();
    else if (e.target && e.target.id === 'fpBlockRemoveBtn') fpRemoveBlock();
    else if (e.target && e.target.id === 'fpBoundaryRemoveBtn') fpRemoveBoundary();
    else if (e.target && e.target.id === 'fpBoundaryCloseBtn') fpCloseBoundary();
    else if (e.target && e.target.id === 'fpBlockRenameBtn') fpRenameBlock();
    else if (e.target && e.target.id === 'fpMarkerRenameBtn') fpRenameMarker();
    else if (e.target && e.target.id === 'fpMarkerRemoveBtn') fpRemoveMarker();
    else if (e.target && e.target.id === 'fpBlockColorDefault') {
      const cblk = state.fp.blocks.find((b) => b.id === state.fp.selectedBlock);
      if (cblk) fpSetBlockColor(cblk, null);
    } else if (e.target && e.target.dataset && e.target.dataset.blockColor) {
      const cblk = state.fp.blocks.find((b) => b.id === state.fp.selectedBlock);
      if (cblk) fpSetBlockColor(cblk, e.target.dataset.blockColor);
    } else if (e.target && e.target.id === 'fpDoorsAutoBtn') fpResetDoors();
    else if (e.target && e.target.dataset && e.target.dataset.door) fpToggleDoor(e.target.dataset.door);
  });
  $('#fpSelInfo').addEventListener('keydown', (e) => {
    // Numeric inspector: Enter applies, Esc reverts, ↑/↓ step by the snap step.
    const num = e.target && e.target.dataset ? e.target.dataset.fpNum : null;
    if (num) {
      const target = fpSelectionTarget();
      // Tab / Shift+Tab: commit, then move to the neighbouring field ourselves.
      // Committing rebuilds the inspector, so the browser's own Tab move would
      // land on a removed field and drop focus to the page (typed H was lost).
      if (e.key === 'Tab') {
        const order = [...$('#fpSelInfo').querySelectorAll('[data-fp-num]')].map((x) => x.dataset.fpNum);
        const nextKey = order[order.indexOf(num) + (e.shiftKey ? -1 : 1)];
        if (nextKey) {
          e.preventDefault();
          fpCommitNumField(e.target);
          const next = $('#fpSelInfo').querySelector(`[data-fp-num="${nextKey}"]`);
          if (next) {
            next.focus({ preventScroll: true });
            if (typeof next.select === 'function') next.select();
          }
          return;
        }
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        fpCommitNumField(e.target);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (target) e.target.value = formatFt(target.item[num]);
        e.target.blur();
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && target) {
        e.preventDefault();
        const cur = fpParseLen(e.target.value);
        const base = cur === null ? target.item[num] : cur;
        const step = fpSnapStep(e) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        const v = quantizeFt(base + step);
        const verb = num === 'width' || num === 'height' ? 'Resized' : 'Moved';
        if (fpApplySelectionGeom({ [num]: v }, verb, { debounce: true })) {
          const again = document.querySelector(`#fpSelInfo [data-fp-num="${num}"]`);
          if (again) {
            again.focus();
            again.select();
          }
        }
      }
      return;
    }
    if (e.target && e.target.dataset && e.target.dataset.fpCalib) {
      if (e.key === 'Enter') {
        e.preventDefault();
        fpApplyCalibration();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        fpSetUnderlayMode(null);
      }
      return;
    }
    if (e.target && e.target.dataset && e.target.dataset.fpArr) {
      if (e.key === 'Enter') {
        e.preventDefault();
        fpApplyArray();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        state.fp.arrayOpen = false;
        fpRenderSelInfo();
      }
      return;
    }
    const lineField = e.target && e.target.dataset ? e.target.dataset.fpLine : null;
    if (lineField) {
      if (e.key === 'Enter') {
        e.preventDefault();
        fpCommitLineField(e.target);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        fpRenderSelInfo();
      }
      return;
    }
    if (e.key === 'Enter' && e.target && e.target.id === 'fpBlockRename') {
      e.preventDefault();
      fpRenameBlock();
    } else if (e.key === 'Enter' && e.target && e.target.id === 'fpMarkerRename') {
      e.preventDefault();
      fpRenameMarker();
    }
  });
  // Native colour pickers commit via `change` (not click), so the selection
  // strip's custom fill input is wired here rather than in the click delegate.
  $('#fpSelInfo').addEventListener('change', (e) => {
    if (e.target && e.target.dataset && e.target.dataset.fpNum) {
      fpCommitNumField(e.target);
      return;
    }
    if (e.target && e.target.dataset && e.target.dataset.fpLine) {
      fpCommitLineField(e.target);
      return;
    }
    if (e.target && e.target.id === 'fpBlockColorPick') {
      const cblk = state.fp.blocks.find((b) => b.id === state.fp.selectedBlock);
      if (cblk) fpSetBlockColor(cblk, e.target.value);
    }
  });
  // read-only preview (opened from the Units view detail panel)
  $('#unitShowFloorPlan').addEventListener('click', fpViewOpen);
  $('#fpViewClose').addEventListener('click', fpViewClose);
  $('#fpViewCloseBtn').addEventListener('click', fpViewClose);
  // Draft versions table (Publish / Load / View / Delete per saved version).
  $('#fpDraftsBody')?.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-fp-draft-act]') : null;
    if (!btn) return;
    const id = btn.dataset.fpDraftId;
    const act = btn.dataset.fpDraftAct;
    if (act === 'load') fpLoadDraft(id);
    else if (act === 'view') fpViewDraft(id);
    else if (act === 'publish') fpPublishDraftFromLibrary(id);
    else if (act === 'delete') fpDeleteDraft(id);
  });
  // Floor Plan Library → Designer cross-link: plain subtab navigation (the
  // Designer handler lazy-loads via fpOpen, same as clicking the subtab).
  $('#fpLibraryOpenDesigner')?.addEventListener('click', () => {
    document.querySelector('[data-tabs="facility"] [data-tab="facility-floorplans"]')?.click();
  });
  // --- Studio ribbon: Mode segments (Select / Add Unit) ---
  // Draw Wall + Add Block reuse #fpBoundaryTool / #fpAddBlock above, so the
  // segmented control has one handler per tool and the audit stays green.
  $('#fpModeSelect')?.addEventListener('click', () => {
    if (state.fp.measureMode) fpSetMeasureMode(false);
    state.fp.tool = 'select';
    state.fp.drawMode = false;
    fpResetPen();
    state.fp.armedMarker = null;
    const pencilBtn = $('#fpBoundaryTool');
    if (pencilBtn) {
      pencilBtn.classList.remove('on');
      pencilBtn.setAttribute('aria-pressed', 'false');
    }
    fpSetMarkersMenu(false);
    fpRenderMarkerTools();
    fpRenderCanvas();
    fpSyncModeUI();
  });
  $('#fpNewUnitTool')?.addEventListener('click', () => fpSetNewUnitMode(!state.fp.newUnitMode));
  $('#fpSizesBtn')?.addEventListener('click', () => fpOpenReconcile());
  $('#fpModeAddUnit')?.addEventListener('click', () => {
    fpSetNewUnitMode(false, true);
    state.fp.tool = 'add';
    state.fp.drawMode = false;
    fpResetPen();
    state.fp.armedMarker = null;
    fpSetPaletteCollapsed(false);
    fpRenderMarkerTools();
    fpRenderCanvas();
    fpSyncModeUI();
    fpToast('Add-unit mode — drag a unit chip from the palette onto the canvas.', true);
  });
  // --- Studio ribbon: Markers dropdown (outside-click closes) ---
  $('#fpMarkersBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    fpSetMarkersMenu($('#fpMarkersMenu')?.hidden !== false);
  });
  document.addEventListener('pointerdown', (e) => {
    const menu = $('#fpMarkersMenu');
    if (menu && !menu.hidden && !e.target?.closest?.('#fpMarkersMenu, #fpMarkersBtn')) {
      fpSetMarkersMenu(false);
    }
  });
  // --- Studio ribbon: Zoom presets + grid toggle ---
  $('#fpZoomPreset')?.addEventListener('change', (e) => {
    const v = String(e.target.value);
    if (v === 'fit') fpZoomFit();
    else {
      const n = Number(v);
      if (Number.isFinite(n)) {
        state.fp.scale = Math.min(3, Math.max(0.4, n));
        fpRenderCanvas();
      }
    }
  });
  // Snap step selector (View group) + live cursor readout.
  fpLoadSnapStep();
  if ($('#fpSnapStep')) $('#fpSnapStep').value = String(fpSnapStep());
  $('#fpSnapStep')?.addEventListener('change', (e) => fpSetSnapStep(e.target.value));
  // Measure tool, object-snap toggle (Phase 3).
  $('#fpMeasureTool')?.addEventListener('click', () => fpSetMeasureMode(!state.fp.measureMode));
  $('#fpObjSnap')?.addEventListener('click', () => {
    state.fp.objSnap = state.fp.objSnap === false;
    const b = $('#fpObjSnap');
    if (b) {
      b.classList.toggle('on', state.fp.objSnap !== false);
      b.setAttribute('aria-pressed', String(state.fp.objSnap !== false));
    }
    fpSnapHint = null;
    fpRenderCanvas();
  });
  $('#fpCanvasWrap')?.addEventListener('pointermove', fpOnCanvasHover);
  $('#fpCanvasWrap')?.addEventListener('pointerleave', () => fpSetReadout(''));
  $('#fpGridToggle')?.addEventListener('click', () => {
    const btn = $('#fpGridToggle');
    state.fp.showGrid = state.fp.showGrid === false;
    if (btn) {
      btn.classList.toggle('on', state.fp.showGrid !== false);
      btn.setAttribute('aria-pressed', String(state.fp.showGrid !== false));
    }
    fpRenderCanvas();
  });
  // First paint for toolbar-driven state + a boot-time audit that warns about
  // missing or unregistered (dead) toolbar tools — see FP_TOOLBAR_GROUPS.
  fpRenderMarkerTools();
  fpRenderBlockFormSwatches();
  fpSyncModeUI();
  fpAuditToolbar();
}

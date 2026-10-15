# Floor Plan Designer — toolbar redesign (implementation brief)

Status: approved design, not yet implemented (2026-10-15).
Lane: **backend-agent** (`storelah-backend/` only). No API, schema, migration or booking/landing change.
Reference mockup: `docs/floorplan-toolbar-mockup.html` (open in a browser; the proposed toolbar is clickable). Owner copy: https://claude.ai/artifact/4aoXM4wojQHz34kGsiWmKt

## Goal

Make the CMS Floor Plan Designer toolbar look and read like a professional editor
(Figma / AutoCAD Web style) **without changing what any tool does**. This is a
markup + CSS + light wiring change. Every existing handler, element id, keyboard
shortcut and persisted behaviour must keep working.

## Files

| File | What changes |
| --- | --- |
| `src/cms/admin/dashboard.html` | Header buttons (`#fpSaveCanvas`, `#fpSaveDraft`, `#fpPublishPlan`, `#fpDeletePlan`), the `#fpToolbar` ribbon markup, `.fp-selstrip`, `#fpModeIndicator`, and the `#facility-floorplans .fp-*` CSS block (~lines 1160–1210) + `.tb-btn` rules (~316). |
| `src/cms/admin/floorplanView.js` | `FP_TOOLBAR_GROUPS` registry + `fpAuditToolbar()` (top of file), `fpSyncModeUI()` (mode badge text), size-mismatch count, new shortcut keys, popover open/close for Snap / Plan settings / More. |

Find code by id/function name — line numbers drift.

## Target layout

```
HEADER   [S StoreLah Studio] [Site ▾] [Level ▾] ● Published · Visible   ……   [↩][↪]  ✓ Saved 3:58 pm  [⤓ Export] [⋯] [Publish]
TOOLBAR  [▥] │ [Select][New unit][Walls][Block][Marker][Measure] │ <tool options> …… [Auto-place][Auto-doors][⚠ N size mismatches] │ [Layers][Underlay][Grid][Snap|0.1 ft ▾] │ [− 100% ▾ +] [⌨]
CANVAS
STATUS   <#fpSelInfo>  │ Marked 3,392 sqft · UFA · NLA · Blocks · Markers   ……   x 12.8 · y 1.2 ft │ [⚙ Plan 70 × 80 ft · GFA not set]
```

One toolbar row. If it does not fit, it scrolls horizontally inside itself
(`overflow-x:auto`) — it never wraps to three rows and never makes the page scroll.

## Element-by-element mapping (keep every id)

### Header
| Mockup | Existing element | Change |
| --- | --- | --- |
| Undo / Redo | `#fpUndoBtn`, `#fpRedoBtn` | Move from toolbar into header, icon-only. |
| "✓ Saved 3:58 pm" | `#fpSaveStatus` | Move from `.fp-selstrip` into header. Text unchanged. |
| Export | `#fpExportBtn` + `#fpExportMenu` | Move into header; menu contents unchanged. |
| ⋯ menu | `#fpSaveDraft`, `#fpDeletePlan` | New `fp-dd` dropdown holding "Save as draft" and "Delete plan" (delete last, red text). |
| Publish | `#fpPublishPlan` | Stays the only filled terracotta button. |
| Save Canvas | `#fpSaveCanvas` | Moves into the Plan settings popover (see Status bar). |

### Toolbar
| Mockup | Existing element | Change |
| --- | --- | --- |
| Units panel toggle | `#fpPaletteReopen` | Always visible (currently `hidden` when palette is open). Make it a toggle: `aria-pressed` = palette open; click calls `fpSetPaletteCollapsed(!collapsed)`. |
| Select | `#fpModeSelect` | Icon button, tooltip "Select  V". |
| New unit | `#fpNewUnitTool` | Icon button, tooltip "New unit  N". |
| Walls | `#fpBoundaryTool` | Icon button, tooltip "Draw walls  L". |
| Block | `#fpAddBlock` | Icon button, tooltip "Block  B". Behaviour unchanged: opens the existing block form in the palette (`#fpBlockForm`). Do **not** add drag-to-draw in this task. |
| Marker | `#fpMarkersBtn` + `#fpMarkersMenu` | Icon button that opens the existing kinds menu. Remove the separate "Markers" segment and its count badge from the toolbar (count moves to status bar). |
| Measure | `#fpMeasureTool` | Icon button, tooltip "Measure  M". |
| Add Unit | `#fpModeAddUnit` | **Remove the visible button.** Verify first whether dragging a palette chip onto the canvas requires `state.fp.tool === 'add'`. If it does, make the Units panel toggle (when opening the palette) run the same code as the current `#fpModeAddUnit` click handler, and keep `#fpModeAddUnit` as a hidden element so ids/audit stay valid. Remove its id from `FP_TOOLBAR_GROUPS` only if the element is deleted. |
| Tool options strip | `#fpRotateGhost`, `#fpLockSqft` + mode text | New `<div id="fpToolOptions">` right after the tools. Contents depend on `fpEffectiveMode()`: **select** → Lock area (`#fpLockSqft`, label "Lock area" with lock icon, keep `aria-pressed`); **add / newunit** → Rotate (`#fpRotateGhost`) + hint "Drag a rectangle to draw it"; **draw** → hint "Click to add points · Enter finish · C close · type a length"; **block** → hint "Name it in the panel, then Add block"; **marker** → armed kind name; **measure** → "Click two points · Esc clears"; **calibrate / underlay** → the current badge text. Move the buttons (don't clone) so handlers stay attached; hide those not relevant to the mode. |
| Auto-place | `#fpAutoPlace` | Text + icon "Auto-place". |
| Auto-doors | `#fpAutoDoors` | Text + icon "Auto-doors". |
| Size mismatches | `#fpSizesBtn` | Amber warning chip "⚠ N size mismatches". `hidden` when N = 0. N comes from `GET /floor-plans/:floorId/size-mismatches` (already used by `fpOpenReconcile()`); fetch once on floor load and again after the reconcile modal closes / after publish. Click still calls `fpOpenReconcile()`. |
| Layers | `#fpLayersBtn` + menu | Icon-only. |
| Underlay | `#fpUnderlayBtn` + menu | Icon-only. |
| Grid | `#fpGridToggle` | Icon-only toggle. |
| Snap | `#fpObjSnap` + `#fpSnapStep` | Split control: left = `#fpObjSnap` (icon toggle), right = button showing the current step ("0.1 ft ▾"). The `<select id="fpSnapStep">` can stay as the real control inside a small popover, or become a menu that sets `#fpSnapStep.value` and dispatches `change` — either way existing listeners on `#fpSnapStep` must still fire. |
| Zoom | `#fpZoomOut`, `#fpZoomLbl`, `#fpZoomPreset`, `#fpZoomIn` | One bordered pill: `−` · percentage · `+`. The percentage *is* the preset picker — remove the duplicate "100%" text. Keep `#fpZoomLbl` updated (it is written in `floorplanView.js`), e.g. make `#fpZoomPreset`'s visible label read from it, or style the select to show the live percentage. |
| Shortcuts | `#fpShortcutsBtn` | Replace the `⌨` glyph (renders as "▬") with an SVG keyboard icon. |

### Status bar (replaces `.fp-selstrip` row above the canvas → goes **below** the canvas)
| Mockup | Existing element | Change |
| --- | --- | --- |
| Selection info | `#fpSelInfo` | Keep as-is. It hosts interactive sub-panels (underlay calibration, array tool: `data-fp-calib`, `data-fp-arr`, `data-fp-num`) — make sure they still fit and remain keyboard-usable. If they don't fit in a single-line bar, let the status bar wrap. |
| Metrics | `#fpBoundaryMetrics` | Move from the toolbar into the status bar as plain text (not a badge/pill — it isn't clickable). Append "Markers N" (from the old `#fpMarkersCount`; keep that id on the new span so existing code updates it). |
| Cursor readout | `#fpReadout` | Move into the status bar, right side. |
| Plan settings | `#fpWidth`, `#fpHeight`, `#fpGfa`, `#fpSaveCanvas` | New button "⚙ Plan 70 × 80 ft · GFA 5,600" (or "GFA not set") that opens a popover containing the three inputs and the Save Canvas button (rename visible label to "Save plan size"). Keep the live-resize behaviour on W/H input. Update the button label after save and on floor load. |

### Remove
- The `MODE` / `QUICK` / `CANVAS` / `ZOOM` / `MARKERS` segment labels (`.fp-seg-label`).
- `#fpModeIndicator` on the canvas — **only after** its text has moved into `#fpToolOptions`. Simplest: keep `fpSyncModeUI()` computing the same strings and write them to `#fpToolOptions .fp-mode-text` instead of the badge. Keep the element id if anything else references it; otherwise remove it from markup and code together.

## Visual spec

Use the existing CMS tokens (`--olive`, `--sage`, `--terra`, `--line`, `--ink`, `--muted`, `--amber-light`) and Manrope. Scope all new CSS under `#facility-floorplans`.

- **Icons:** one inline-SVG line set (Lucide-style: 24×24 viewBox, `stroke-width:1.75`, round caps, `fill:none`, `stroke:currentColor`), rendered at 16px. Put them in one hidden `<svg><symbol id="fpi-…">` sprite in `dashboard.html` and reference with `<use href="#fpi-…">`. No emoji anywhere in the toolbar. The mockup's sprite can be copied as a starting point.
- **Toolbar buttons:** 32px tall, 32px wide when icon-only, 7px radius, **no border and transparent background at rest**, `background:#f1ece4` on hover, visible `:focus-visible` outline (2px `--terra`).
- **Active tool** (Select/New unit/Walls/Block/Marker/Measure): solid `--olive` background, white icon. This is the only dark-filled thing in the bar.
- **On toggles** (Grid, Snap, Lock area, Units panel): `--sage` background, `--olive` icon.
- **Group dividers:** 1px × 22px `--line`, 6px side margin.
- **Size-mismatch chip:** `--amber-light` background, dark amber text, bold.
- **Toolbar container:** single row, white, bottom border `--line`, `padding:6px 10px`, `gap:6px`, `overflow-x:auto`.
- **Tooltips:** every icon-only button gets `aria-label` + `title` (or a CSS tooltip) in the form "Name  Shortcut". Keep the existing long `title` help texts as they are where they exist — just put the shortcut first.
- **Status bar:** white, top border, 11.5px muted text, values in `--ink` bold, `font-variant-numeric:tabular-nums`.

## Keyboard shortcuts

Existing: N (new unit), L (walls), M (measure), ? (shortcuts), Esc, Cmd/Ctrl+Z/Y/C/V/D/A.
Add (only when focus is not in an input/select/textarea and no Cmd/Ctrl/Alt modifier):
- **V** → Select (same as clicking `#fpModeSelect`). Must not interfere with Cmd/Ctrl+V paste.
- **B** → Block (same as clicking `#fpAddBlock`).
- **K** → open the Markers menu.
- **Shift+1** → Zoom to fit (`fpZoomFit()`).
Add all four to the shortcuts sheet opened by `#fpShortcutsBtn`.

## Registry / audit

Update `FP_TOOLBAR_GROUPS` and its comment to the new grouping (e.g. `panel`, `tools`, `options`, `actions`, `view`, `zoom`, plus header/status ids where they still live inside `#fpToolbar`). After the change, `fpAuditToolbar()` must log **zero** warnings in the browser console on page load. Buttons moved to the header or status bar are outside `#fpToolbar`, so drop them from the registry or widen the audit root — be consistent.

## Out of scope

- No backend routes, Prisma, migrations, booking or landing changes.
- No drag-to-draw for blocks; no new tools.
- Don't touch canvas rendering, snapping maths, save/publish logic or the publish review modal.
- Don't commit, push or deploy unless the owner asks. Backend deploys are manual Lambda updates (see `docs/backend-deploy.md`).

## Acceptance checks

Run locally (`pnpm dev` in `storelah-backend/`, open the CMS → Facilities → Floor plans, pick SW · Level 1):

1. Toolbar is one row at ≥1280px wide; at 1024px it scrolls inside itself, the page does not scroll sideways.
2. No emoji/glyph icons left in header, toolbar or status bar; `⌨` renders as an icon.
3. Every tool still works exactly as before: Select, New unit (N), Walls (L, incl. typed lengths, close with C), Block form → Add block, Markers (pick kind, place), Measure (M), Auto-place (confirmation still shown), Auto-doors, Rotate, Lock area, Undo/Redo + shortcuts, Sizes modal, Layers, Underlay (incl. calibration in `#fpSelInfo`), Grid, Snap step + object snap, zoom −/+/presets/fit, Ctrl/Cmd+scroll zoom, Export (PDF/PNG/SVG), shortcuts sheet, Save as draft, Delete plan, Publish review.
4. Exactly one tool shows as active, and it follows mode changes made by keyboard and by Esc.
5. Plan settings popover: change W/H → canvas resizes live; Save → persisted after reload; status-bar label updates; empty GFA shows "GFA not set".
6. Size-mismatch chip is hidden on a floor with 0 mismatches, shows the right count otherwise, and updates after fixing one.
7. V / B / K / Shift+1 work; none fire while typing in an input; Cmd/Ctrl+V still pastes.
8. `fpAuditToolbar()` logs no warnings; no new console errors.
9. Keyboard: Tab reaches every toolbar control in visual order with a visible focus ring; dropdowns close on Esc and outside click.
10. Compare side-by-side with the reference mockup; spacing/colours match within reason.

Then append a `backend-agent` entry to `.opencode/decisions.md` (orchestration root) per `CLAUDE.md`.

# Floor Plan Designer — odd-shaped units (plan)

Status: **ready to build — client answered all 4 questions (§9)** ·
Branch `feature/49-odd-shaped-units` (backend; booking uses the same slug) · Written 2026-11-17,
updated 2026-11-17 with the client's answers

Client example: a notched rectangle (an L shape). The full-width bottom part is taller than the
step at the top, and the top-left corner is cut away. The client says shapes follow the shape of
the property, and **angled walls do occur**.

## 1. Request

The client wants to draw units that are not rectangles in the Floor Plan Designer, for example
L-shaped units, units with a corner notched out around a column or riser, or U/T shapes that wrap a
structure. Today every unit is a rectangle, so the operator either over-draws it (wrong sqft, NLA
and price) or under-draws it (wrong picture on the booking map).

## 2. What assumes a rectangle today

| Area | Where | Rectangle assumption |
| --- | --- | --- |
| Data | `prisma/schema.prisma` `UnitPlacement` | `x / y / width / height` only |
| Unit sqft | `src/core/unitSizing.ts` `sqftForRect`, `checkPlacementArea`; `planGeometry.ts` `rectAreaSqft`, `areaDeviation` | area = width × height; `areaDirty` and publish sync use it |
| Size sync on publish | `src/core/unitSizeSync.ts` | sqft, size tier and rate come from the drawn rect |
| Unit L×W | `src/core/units.ts` `areaFromDims`; `unitsView.js` | sqft derived from lengthFt × widthFt |
| Overlap guard | `planGeometry.ts` `rectsOverlapExact`; `floorPlans.ts` `rectsOverlap`, `setUnitPlacement` | rect against rect, returns 409 |
| NLA / metrics | `floorPlans.ts` `computeBoundaryMetrics` (`rectPolygonArea`, `rectIntersection`); `floorPlanMetricsService.ts` | placement footprint = rect |
| Doors | `floorPlans.ts` `normalizeDoorEdges`, `normalizeDoorOffsets`, `inferDoorEdges` | four compass edges N/S/E/W, offset 0..1 along each |
| Stacked lockers | `unitSizing.ts` `assertStackedLockerTier`; `floorplanView.js` `fpStackMate` and related | a pair shares the same rect |
| Drafts and snapshots | `floorPlanDrafts.ts`; published snapshot `placements` JSON | snapshot shape carries x/y/width/height |
| Designer | `src/cms/admin/floorplanView.js` (~8.8k lines): `fpOverlapAt`, `fpSqftForRect`, `fpBoundaryMetricsLocal`, `fpInferDoorEdges`, `fpDoorMarkersHTML`, `fpRenderCanvas`, `fpBuildExportSVG`; mirror helpers in `cms/admin/planGeometry.js` | tiles are absolutely positioned `div`s with one corner resize handle |
| Finance PDF | `src/core/finance/reportPdf.ts` | draws rects |
| Booking map | `storelah-booking` `web/src/lib/floor-plan.ts` (`FloorPlanPlacement`), `components/booking/UnitFloorPlan.tsx` | SVG `<rect>` per unit, doors from N/S/E/W |

## 3. Decisions proposed

- **D1. Representation.** Add a nullable `outline Json?` to `UnitPlacement`: polygon vertices
  `[[x,y],...]` in absolute decimal feet (same space and 0.001 ft quantisation as boundaries).
  - `NULL` means a plain rectangle, so every existing row is unchanged (additive migration, no
    backfill).
  - When an outline is set, `x/y/width/height` still store its **bounding box**, kept in sync
    server-side. Drag, canvas fit, zoom-to-unit, sorting and every other bbox consumer keep working.
  - A rectangle is never stored as an outline: a 4-vertex outline that fills its bbox is normalised
    to `NULL`.
- **D2. v1 = any simple polygon with straight edges, angled walls included** (client: "There may
  be angled walls"). Validation: 3–24 vertices; simple (no self-intersection, no holes);
  clockwise-normalised; minimum edge length = snap step (≥ 0.1 ft); no zero-area spikes; area
  within `MIN_UNIT_SQFT..MAX_UNIT_SQFT`. Curved walls stay out (§8).
  Because shapes can be concave and angled, the maths cannot rely on splitting into rectangles. It
  uses a general polygon-clipping routine (intersection/union of two simple polygons). Proposed
  dependency: the MIT `polygon-clipping` package, pinned. The server imports it, and the designer
  gets the same build vendored as a static file under `src/cms/admin/vendor/` (the CMS has no
  bundler). The existing `rectPolygonArea` (rect clip of any polygon) still handles the many
  rect-only cases cheaply.
- **D3. Area.** A shaped unit's sqft is `polygonArea(outline)`, rounded with `wholeSqft` like rects.
  The `areaDirty` → publish sync flow is unchanged: it just reads the shape-aware area.
  Contracted units (OCCUPIED/OVERDUE/RESERVED) cannot change shape, the same as today's resize lock.
- **D4. Unit L×W.** For a shaped unit, `lengthFt/widthFt` are set to `NULL` and the Units form
  shows "Custom shape — edit in Floor Plan Designer" (L×W locked, sqft read-only).
- **D5. Doors can go anywhere on the outline** (client: "Door can go anywhere"). A shaped unit's
  door is a position on its outline: edge index + centre fraction along that edge + the existing
  door width. Stored in the existing columns: `doorEdges` = `"e0,e3"`, `doorOffsets` =
  `{ "e3": 0.5, "w": 3 }`, so no extra column. Angled edges are supported; the door marker is
  drawn rotated along its edge.
  - The operator places a door by clicking any wall of the selected unit, and moves it by dragging
    it along the outline. It can cross onto the next wall around a corner, but must keep at least
    half its width from the corner.
  - Auto doors: when none is authored, place one at the centre of the outline edge closest to a
    corridor block; otherwise use the longest edge.
  - When the outline is edited, a door on a removed edge moves to the nearest remaining edge. The
    inspector shows a toast first.
  - Rect units keep N/S/E/W unchanged.
- **D6. Stacking.** Not allowed for shaped units in v1. Stacking a shaped unit returns 409, and
  outlining a stacked unit is blocked.
- **D7. Public API.** `serializePlacement` adds `outline: [[x,y],...] | null` to the public
  placement shape. For rect units the field is omitted, not `null`, so booking output is
  byte-identical (same approach as `doorOffsets`). Shaped-unit doors are sent publicly in the new
  edge form (`doorEdges: ["e0"]`); booking must understand them before any shaped unit is published.

## 4. Backend work

1. **Migration** `<ts>_unit_placement_outline`: `ALTER TABLE "UnitPlacement" ADD COLUMN "outline" JSONB`.
   Additive. The prod order is unchanged: migrate first (direct Neon URL), then the Lambda code update.
2. **`planGeometry.ts`** (plus the `cms/admin/planGeometry.js` mirror):
   - `normalizeOutline` (quantise, drop collinear/duplicate vertices, clockwise),
     `isSimplePolygon`, `outlineBBox`, `outlineArea` (shoelace), `placementPolygon(p)` (outline, or
     the rect as 4 points).
   - `polygonIntersectionArea(a, b)` through the clipping library.
   - Shape-aware `placementsOverlap(a, b)`: bbox reject first, then intersection area >
     0.01 sq ft. Edge-touching is not an overlap; an angled neighbour pressed against an angled
     wall is fine.
3. **`floorPlans.ts`**:
   - `setUnitPlacement` accepts `outline` (zod in `routes/cms.ts`), validates it (D2), derives the
     bbox, and checks canvas fit plus the shape-aware overlap guard.
   - `serializePlacement` (D7).
   - `computeBoundaryMetrics`: for shaped placements, `placementsInLoop` = polygon ∩ loop
     (library); `onUnits` = `rectPolygonArea(block, unitPolygon)` clipped to the loop; the
     pillar deduction is the same with the unit polygon. Rect placements keep today's code path,
     so existing plans report the same numbers.
   - Door normalisers accept edge-index keys for shaped units (D5).
4. **`unitSizing.ts` / `unitSizeSync.ts`:**
   - `sqftForPlacement(p)` (outline area, else w×h) replaces `sqftForRect` at placement call sites.
   - `checkPlacementArea` compares shape-aware areas.
   - Contracted-unit tolerance uses the outline area.
5. **`units.ts`** (D4): null L×W when an outline is set; reject L×W edits on shaped units.
6. **Drafts and snapshots** (`floorPlanDrafts.ts`, published snapshot): include `outline` in the
   placement JSON. Old snapshots without it read as rectangles.
7. **Metrics service and finance PDF:** read through the shape-aware helpers; the PDF draws a
   polygon when an outline is set.
8. **openapi.ts:** bump the minor version; document `outline` and the edge-index door form.
9. **Route permissions:** no new route (the existing placement PUT carries `outline`), so
   `routePermissions.ts` is unchanged.

## 5. Designer work (`floorplanView.js`, `dashboard.html`)

- **Render:** shaped tiles keep their bbox `div`, plus `clip-path: polygon(...)` in % of the bbox.
  An SVG overlay draws the outline stroke and selection ring, since a clipped div's border would be
  cut. Labels go at the polygon's pole of inaccessibility (the point inside furthest from every
  wall), not the bbox centre, so an L-shape's label sits in its body.
- **Hit-testing:** clicks inside the bbox but outside the polygon pass through to whatever is
  underneath (point-in-polygon check in the tile's pointer handler).
- **Editing tools** (inspector, on a selected non-contracted unit):
  - **Notch corner:** pick a corner and enter the notch W × H in ft. One click turns a rect into
    the client's example L.
  - **Draw outline:** click corner points like the existing boundary/wall tool. It reuses the
    length + angle entry (`pointAtAngle`), 15° angle snapping (Shift = free), snap to grid and to
    nearby unit/wall vertices, and the tracing underlay. Close the loop to finish. This is how
    angled walls are traced from the architect's drawing.
  - **Edit outline:** a vertex handle on every corner and a midpoint handle on every edge.
    Dragging a vertex moves just that corner; dragging a midpoint adds a vertex; double-clicking a
    vertex removes it.
  - **Reset to rectangle:** clears the outline (bbox kept).
- **Resize handle on shaped units: hidden** (client chose option A, §9 Q4). The `.fp-resize`
  corner handle renders only on rect tiles; the inspector shows "Edit outline to resize" in its
  place. Rect units keep the handle unchanged. Keyboard nudge still moves a shaped unit; it never
  resizes it.
- **Mirrors:** `fpOverlapAt`, `fpSqftForRect` → `fpSqftForPlacement`, `fpBoundaryMetricsLocal`,
  `fpInferDoorEdges`, `fpDoorMarkersHTML` and the door-move tool all become shape-aware, using the
  same vendored clipping build as the server so CMS and server numbers match.
- **Undo/redo:** an outline edit is one undo step (same batch path as moves).
- **Export and viewer:** `fpBuildExportSVG` and the read-only viewer draw `<polygon>`.
- **Publish review:** shaped units with `areaDirty` appear in the existing "size changes" list.

## 6. Booking work (`storelah-booking`, separate lane, same slug)

- `lib/floor-plan.ts`: `outline?: [number, number][] | null` on `FloorPlanPlacement`, plus
  edge-index door parsing.
Client confirmed customers must see the true shape.

- `UnitFloorPlan.tsx`: draw `<path>`. The gap between neighbouring units, which rects get by
  deflating GAP/2 per side, comes from clipping the polygon to itself and drawing a GAP-wide
  stroke in the map background colour, so angled edges get the same gap without polygon-offset
  maths. Status fills, hatch overlays and selection ring follow the path. Doors are drawn rotated
  on their edge. The label and focus point use the same pole-of-inaccessibility point as the CMS
  (sent by the API as `labelAt: [x, y]`, so booking needs no extra geometry code).
- List, grid and modal need no change (sqft already comes from the unit).
- Tests: `lib/__tests__/floor-plan-outline.test.ts` plus render tests.

## 7. Rollout and ordering

1. Backend migration + API + designer behind the existing draft/publish flow. Shaped units are
   visible only in the CMS until a plan is published.
2. Booking ships **before or with** the first publish of a plan that contains a shaped unit.
   Without it, booking draws the bbox, which overstates the unit, and cannot read the edge-index
   doors. Safety net until booking is live: a server flag hides shaped units from the public map
   (they still appear in the booking list, where sqft comes from the unit). The flag is removed
   once booking ships.
3. Verify on a cloned local DB (worktree convention, dedicated ports in `.claude/launch.json`).
   Then the backend prod migration and Lambda update, and the booking `main` merge, each only on
   the owner's go-ahead.

## 8. Out of scope / v2

- Curved walls and arcs (an arc can be traced as short straight segments within the 24-vertex
  limit if needed).
- Units with holes (a unit wrapped fully round a column: draw the column as a block instead, and
  the existing NLA rule deducts it).
- Stacking shaped units.
- Resizing a shaped unit by dragging a whole wall (option C in §9 Q4; not chosen for v1).
- Shaped blocks (corridors, lifts) — `FloorPlanBlock` stays rectangular.
- Tracing outlines automatically from the underlay drawing.

## 9. Client questions

1. **Which shapes?** Answered: shapes follow the property; example is a notched rectangle (L);
   angled walls occur. → D2 is any straight-edged simple polygon.
2. **Doors?** Answered: "Door can go anywhere." → D5 is a free position on any wall.
3. **True shape for customers?** Answered: yes. → §6.
4. **Corner resize handle on shaped units?** Answered: **option A — hide it.** A shaped unit
   changes size only through Edit outline (move, add or remove corners), Draw outline (redraw)
   or Reset to rectangle. Rejected: B (scale proportionally: notch grows, angles change, corners
   leave the grid) and C (drag a wall; possible later addition). Contracted units
   (OCCUPIED/OVERDUE/RESERVED) stay locked, and the new sqft follows the normal resize → publish
   sync.

## 10. Test plan

- **Unit tests (geometry):** validation rejects self-intersecting, spike, too-small and
  too-many-vertex outlines; shoelace area for L and angled shapes; overlap cases (a neighbour
  sitting in an L-shape's notch is **not** an overlap; edge-touching is not; two angled walls
  pressed together are not; a 0.1 ft intrusion is); server and vendored CMS clipping give the
  same areas on a fixture set.
- **e2e (`tests/e2e/floor-plan-*.test.ts`):**
  - PUT a placement with an outline: bbox derived, sqft = polygon area, `areaDirty` set, publish
    syncs sqft, size and rate.
  - Contracted unit outline change returns 409.
  - Stacking a shaped unit returns 409.
  - NLA for a plan with an L-shaped unit and a column inside its notch.
  - Public read omits `outline` for rects (byte-identical) and includes it for shapes.
  - Draft save/restore round-trips the outline.
- **Browser (designer on a worktree port):** notch corner, vertex drag, reset, undo/redo, no
  resize handle on shaped tiles (still present on rect tiles),
  overlap rejection, door on an indexed edge, export SVG, no console errors.
- **Booking:** polygon tile renders and is selectable at 1280 and 390 px; hatch and status fills
  follow the shape; no horizontal scroll.

## 11. Rough effort

| Piece | Size |
| --- | --- |
| Backend geometry (general polygons) + API + metrics + migration + tests | M–L |
| Designer outline tools (notch, draw, edit, door anywhere), rendering, mirrors, undo | L (most of the work) |
| Booking renderer + tests | S–M |

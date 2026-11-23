// pcb-tools/board-items.ts — DRAWING_TOOL::PlacePoint (POINT_PLACER) and DRAWING_TOOL::PlaceSubGrid: a PCB_POINT
// dropped at each click on the active layer, and a PCB_GRID_ITEM whose centre is the first click and whose size and
// angle follow the cursor until the second.
import type { PcbCtx, Pt } from "./types";
import { addedChange } from "./changes";
import { fmtAngle } from "./ellipse";
import { applySelection } from "./groups";
import { sizesOf } from "./app-state";
import { S } from "./state";
import { norm360, r6, rotator } from "./util";

/** PCB_POINT's constructor: DEFAULT_PT_SIZE_MM (1 mm); PCB_IO_KICAD_SEXPR::format( PCB_POINT ) writes (point (at) (size) (layer) (uuid)). */
export function pointNode(at: Pt, layer: string): SNode { return ["point", ["at", r6(at[0]), r6(at[1])], ["size", 1], ["layer", layer]]; }
/**
 * POINT_PLACER through doInteractiveItemPlacement( IPO_REPEAT | IPO_SINGLE_CLICK ): each click puts a point on the
 * active layer (made visible, ensureVisibility) and commits "Place point"; the tool stays for the next one and the new
 * point is not selected.
 */
export function placePointAt(ctx: PcbCtx, at: Pt) {
  if (ctx.viewOnly) return;
  const layer = sizesOf(ctx).activeLayer || S.layer;
  if (ctx.showLayer) ctx.showLayer(layer);
  ctx.commit([addedChange(ctx.doc, pointNode(at, layer))], "Place point"); ctx.requestRender();
}

/** The sub-grid being placed: its centre, and the size and orientation the cursor gives it (sizeToCursor). */
export interface SubGridDraft { center: Pt; len: number; angle: number }
/** sizeToCursor: the extent is the cursor's distance (both axes), the orientation -EDA_ANGLE( cursor - centre ) normalised to [0, 360). */
export function subGridSize(center: Pt, cursor: Pt): { len: number; angle: number } {
  const vx = Math.round((cursor[0] - center[0]) * 1e6), vy = Math.round((cursor[1] - center[1]) * 1e6);
  return { len: Math.round(Math.hypot(vx, vy)) / 1e6, angle: norm360(-(Math.atan2(vy, vx) * 180 / Math.PI)) };
}
/**
 * PCB_GRID_ITEM as the constructor makes it (cartesian, 1 mm spacing, priority 1, affecting the cursor, routing and
 * placement) with the drafted centre, extent and angle; PCB_IO_KICAD_SEXPR::format( PCB_GRID_ITEM ) writes
 * (grid_item xy (at) (extent) (spacing) [(angle)] (priority) (affects …) (uuid)).
 */
export function subGridNode(d: SubGridDraft): SNode {
  const n: SNode = ["grid_item", "xy", ["at", r6(d.center[0]), r6(d.center[1])], ["extent", r6(d.len), r6(d.len)], ["spacing", 1, 1]];
  const a = fmtAngle(d.angle); if (a) n.push(["angle", a]);
  n.push(["priority", 1], ["affects", ["cursor", "yes"], ["routing", "yes"], ["placement", "yes"]]);
  return n;
}
/** The tool starts: the selection is cleared and the Grids object layer (LAYER_SUBGRIDS) is turned on (SetObjectVisible). */
export function subGridActivate(ctx: PcbCtx) {
  applySelection(ctx, []);
  if (ctx.showObject) ctx.showObject("subgrids");
}
/** SET_CENTER then SET_EXTENT: the second click commits "Place Sub-grid" and the tool waits for the next centre. */
export function subGridClick(ctx: PcbCtx, at: Pt) {
  const d = S.subGrid;
  if (!d) { S.subGrid = { center: at.slice(), len: 0, angle: 0 }; ctx.requestRender(); return; }
  Object.assign(d, subGridSize(d.center, at)); S.subGrid = null;
  if (!ctx.viewOnly) ctx.commit([addedChange(ctx.doc, subGridNode(d))], "Place Sub-grid");
  ctx.requestRender();
}
export function subGridMove(at: Pt) { const d = S.subGrid; if (d) Object.assign(d, subGridSize(d.center, at)); }
/** The square the drafted grid covers (its extent either side of the centre, turned by its orientation). */
export function subGridOutline(d: SubGridDraft): Pt[] {
  const R = rotator(d.angle), L = d.len;
  return [[-L, -L], [L, -L], [L, L], [-L, L]].map(([x, y]) => { const [rx, ry] = R(x, y); return [d.center[0] + rx, d.center[1] + ry] as Pt; });
}

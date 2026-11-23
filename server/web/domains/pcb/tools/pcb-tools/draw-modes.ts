// pcb-tools/draw-modes.ts — the drawing tools' angle snap modes, polygon leaders and stroke width.
import type { DrawState, PcbCtx, Pt } from "./types";
import { root } from "../root";
import { deleteChanges } from "./changes";
import { DIM_TYPE, snap45, snap90, snapVec45 } from "./dimensions";
import { dimTrack } from "./draw-tools";
import { gfxWidth } from "./nodes";
import { lsGet, lsSet } from "./router-settings";
import { S } from "./state";
import { footprintEditorDefaults, r6, samePt, vadd, vsub } from "./util";

// S.draw = { shape, start, cur, pts, … }: line/rect/circle take two clicks, an arc its start, end and
// then a point on the arc, a bezier its start, two control points and end, a polygon / zone / rule area
// any number of corners until the first corner is clicked again (or the last one twice, or Enter), a
// text box or table two corners and then a prompt, a dimension two points and (aligned, orthogonal,
// radial) a third for the offset or the text.
export const POLY_TOOLS = new Set(["gpoly", "zone", "thievingzone", "rulearea", "viastitch"]);
export const gfxTool = (t: string | null | undefined) => /^g/.test(t || "") || t === "table" || t === "image" || !!DIM_TYPE[t!];   // draws on the chip's graphics layer
export const RULE_AREA_LAYERS = ["F.Cu", "B.Cu"];
// ---- PCB_TOOL_BASE::GetAngleSnapMode (PCBNEW_SETTINGS m_AngleSnapMode, DIRECT by default in the board editor):
// the Line Modes radio on the left toolbar and Shift+Space (lineModeNext) choose it; it is kept per viewer.
export const ANGLE_SNAP_KEY = "kc.pcbnew.angleSnapMode", ANGLE_SNAP_MODES = ["free", "90", "45"];
/** PCB_VIEWER_TOOLS::NextLineMode: DIRECT -> DEG45 -> DEG90 -> DIRECT. */
export function nextLineMode(m: string | null | undefined) { return m === "free" ? "45" : m === "45" ? "90" : "free"; }
export const ANGLE_SNAP_MSG: Record<string, string> = { free: "", "90": "Constrain to H, V", "45": "Constrain to H, V, 45" };   // DRAWING_TOOL::UpdateStatusBar
/** EDIT_TOOL::doMoveSelection displayConstraintsMessage: the constraint field while a move runs (it stays afterwards). */
export const MOVE_SNAP_MSG: Record<string, string> = { free: "", "90": "Angle snap lines: 90\u00b0", "45": "Angle snap lines: 45\u00b0" };
/** The DRAWING_TOOL actions: activating one runs DRAWING_TOOL::Reset( RUN ), which calls UpdateStatusBar. */
export const DRAWING_TOOL_IDS = new Set(["via", "gline", "grect", "gcircle", "gtext", "barcode", "garc", "gpoly", "gcurve", "gellipse", "gellipsearc", "gtextbox", "table", "image", "zone", "thievingzone", "viastitch", "rulearea", "dimaligned", "dimortho", "dimcenter", "dimradial", "leader", "anchor"]);
/** EDA_DRAW_FRAME::DisplayConstraintsMsg: status field 7 (the app keeps the last text written, as wxStatusBar does). */
export function displayConstraintsMsg(msg: string) {
  try { if (typeof root.dispatchEvent === "function" && typeof CustomEvent === "function") root.dispatchEvent(new CustomEvent("kc:constraint-msg", { detail: { msg: msg || "" } })); } catch (e) { /* no DOM */ }
}
/**
 * Each frame keeps its own line mode: PCBNEW_SETTINGS pcb_angle_snap_mode (LEADER_MODE::DIRECT, Free) and
 * FOOTPRINT_EDITOR_SETTINGS' (LEADER_MODE::DEG45, footprint_editor_settings.cpp:57).
 */
export const FP_ANGLE_SNAP_KEY = "kc.fpedit.angleSnapMode";
const snapKey = () => (footprintEditorDefaults() ? FP_ANGLE_SNAP_KEY : ANGLE_SNAP_KEY);
export function angleSnapMode() {
  if (!S.angleSnap) { const v = lsGet(snapKey()); S.angleSnap = ANGLE_SNAP_MODES.includes(v!) ? v! : footprintEditorDefaults() ? "45" : "free"; }
  return S.angleSnap;
}
/** BOARD_EDITOR_CONTROL::ChangeLineMode: the new mode applies to the shape being drawn at once (refreshPreview). */
export function setAngleSnap(ctx: PcbCtx, mode: string) {
  if (!ANGLE_SNAP_MODES.includes(mode)) return angleSnapMode();
  S.angleSnap = mode; lsSet(snapKey(), mode);
  if (ctx && S.draw && S.drawRaw) { drawTrack(S.draw, S.drawRaw, S.drawCtrl!); }
  if (S.move) displayConstraintsMsg(MOVE_SNAP_MSG[mode]!);   // doMoveSelection on angleSnapModeChanged
  if (ctx) ctx.requestRender();
  // angleSnapModeChanged: the toolbar's Line Modes radio follows (panes.ts listens)
  try { if (typeof root.dispatchEvent === "function" && typeof CustomEvent === "function") root.dispatchEvent(new CustomEvent("kc:pcb-linemode", { detail: { mode, msg: ANGLE_SNAP_MSG[mode] } })); } catch (e) { /* no DOM */ }
  return mode;
}
export const LINE_LIKE = (shape: string) => shape === "gline" || POLY_TOOLS.has(shape);
/**
 * The angle constraint the drawing tools put on the cursor: lines, polygons, zones and rule areas follow the mode
 * unless Ctrl is held (DrawShape / DrawZone: MD_CTRL → DIRECT); rectangles and circles are free unless Ctrl is held,
 * which constrains them to 45° (a rectangle to a square: GetVectorSnapped45( v, only45 )); a dimension's end snaps to
 * 45° whenever any mode is on, and a centre mark always.
 */
export function drawSnapMode(d: DrawState, ctrl: boolean) {
  const t = d.shape;
  if (t === "grect" || t === "gcircle" || t === "gellipse") return ctrl ? "45" : "free";
  if (LINE_LIKE(t)) return ctrl ? "free" : angleSnapMode();
  if (DIM_TYPE[t] && !d.end) return DIM_TYPE[t] === "center" || (!ctrl && angleSnapMode() !== "free") ? "45" : "free";
  return "free";
}
export function constrainDraw(d: DrawState, p: Pt, ctrl: boolean) {
  const mode = drawSnapMode(d, ctrl); if (mode === "free" || POLY_TOOLS.has(d.shape)) return p;   // polygons bend a leader instead
  const v = vsub(p, d.start);
  return vadd(d.start, mode === "90" ? snap90(v) : snapVec45(v, d.shape === "grect" || d.shape === "gellipse"));
}
// ---- POLYGON_GEOM_MANAGER: in the 45 and 90 modes a polygon, zone or rule area reaches the cursor through a leader
// that bends once (build45DegLeader / build90DegLeader), and a loop line of the same kind runs back to the first corner.
export const normDeg180 = (a: number) => { while (a <= -180) a += 360; while (a > 180) a -= 360; return a; };
export const normDeg90 = (a: number) => { while (a < -90) a += 180; while (a > 90) a -= 180; return a; };
export const vecDeg = (v: Pt) => Math.atan2(v[1], v[0]) * 180 / Math.PI;
export function build45Leader(end: Pt, pts: Pt[]) {
  const last = pts[pts.length - 1], v = vsub(end, last);
  if (pts.length < 2) return [last, vadd(last, snap45(v))];
  const lineA = vecDeg(v), prevA = vecDeg(snap45(vsub(last, pts[pts.length - 2])));
  const vertical = Math.abs(v[1]) > Math.abs(v[0]), horizontal = Math.abs(v[1]) < Math.abs(v[0]);
  const angDiff = Math.abs(normDeg180(lineA - prevA));
  let bendEnd = angDiff < 45 || (angDiff > 90 && angDiff < 135);
  if (Math.abs(Math.abs(normDeg90(prevA)) - 45) < 1e-9) bendEnd = !bendEnd;
  let mid = end;
  if (bendEnd) {
    if (vertical) mid = [last[0], v[1] > 0 ? end[1] - Math.abs(v[0]) : end[1] + Math.abs(v[0])];
    else if (horizontal) mid = [v[0] > 0 ? end[0] - Math.abs(v[1]) : end[0] + Math.abs(v[1]), last[1]];
  } else {
    if (vertical) mid = [end[0], v[1] > 0 ? last[1] + Math.abs(v[0]) : last[1] - Math.abs(v[0])];
    else if (horizontal) mid = [v[0] > 0 ? last[0] + Math.abs(v[1]) : last[0] - Math.abs(v[1]), end[1]];
  }
  return [last, mid, end];
}
export function build90Leader(end: Pt, pts: Pt[]) {
  const last = pts[pts.length - 1];
  if (last[0] === end[0] || last[1] === end[1]) return [last, end];
  return [last, [end[0], last[1]], end];
}
/** updateTemporaryLines: { leader, loop } for the cursor at `end`. */
export function polyLeader(d: Pick<DrawState, "pts">, end: Pt, mode: string) {
  if (mode === "45") return { leader: build45Leader(end, d.pts), loop: build45Leader(end, d.pts.slice().reverse()).reverse() };
  if (mode === "90") return { leader: build90Leader(end, d.pts), loop: build90Leader(end, d.pts.slice().reverse()).reverse() };
  return { leader: [d.pts[d.pts.length - 1], end], loop: [] };
}
export const pushPt = (arr: Pt[], p: Pt) => { if (!arr.length || !samePt(arr[arr.length - 1], p)) arr.push(p); };
/** The cursor of the shape being drawn: the grid-resolved point, constrained. */
export function drawTrack(d: DrawState, raw: Pt, ctrl: boolean) {
  d.cur = constrainDraw(d, raw, ctrl);
  if (POLY_TOOLS.has(d.shape)) { d.mode = drawSnapMode(d, ctrl); Object.assign(d, polyLeader(d, d.cur, d.mode)); }
  if (DIM_TYPE[d.shape] && d.end) dimTrack(d, d.cur);
  else if (d.shape === "dimortho") d.orientation = Math.abs(d.cur[0] - d.start[0]) < Math.abs(d.cur[1] - d.start[1]) ? "v" : "h";   // measure the longer side
}
/** DRAWING_TOOL::WIDTH_STEP (0.1 mm): Ctrl++ / Ctrl+- while a shape is being drawn (incWidth / decWidth). */
export const WIDTH_STEP = 0.1;
export function drawWidth(layer: string) { return S.strokeW != null ? S.strokeW : gfxWidth(layer); }
/** The tools whose loop takes incWidth / decWidth before the first click too (drawShape, drawManagedShape: m_stroke). */
export const WIDTH_TOOLS = new Set(["gline", "grect", "gcircle", "gellipse", "garc", "gcurve", "gellipsearc"]);
export function stepDrawWidth(ctx: PcbCtx, dir: number) {
  const d = S.draw, t = d ? d.shape : S.modTool;
  if (!t || t === "gtextbox" || t === "table") return false;
  if (POLY_TOOLS.has(t)) return !!d;   // DrawZone has no incWidth / decWidth branch: the key does nothing there
  if (!d && !WIDTH_TOOLS.has(t)) return false;
  const w = drawWidth(S.gfxLayer);
  if (dir > 0) S.strokeW = +(w + WIDTH_STEP).toFixed(6);
  else if (w > WIDTH_STEP) S.strokeW = +(w - WIDTH_STEP).toFixed(6);
  ctx.requestRender(); return true;
}
/**
 * DRAWING_TOOL::Reset( RUN ) (the tool starting) and layerChanged / drawShape's `if( m_layer != GetActiveLayer() )`:
 * the stroke (m_stroke) goes back to the layer's default line thickness and LINE_STYLE::DEFAULT; on the same layer
 * the stroke it has is kept (a width stepped with +/-, or the one SetStroke took from the Shape Properties dialog).
 */
export function strokeForLayer(layer: string) {
  if (S.strokeLayer === layer) return;
  S.strokeLayer = layer; S.strokeW = null; S.strokeStyle = null;
}
/** DRAWING_TOOL::SetStroke( stroke, layer ): the stroke the next shapes on `layer` are drawn with. */
export function setDrawStroke(width: number | null, style: string | null, layer: string) {
  S.strokeLayer = layer; S.strokeW = width != null && isFinite(width) ? width : null; S.strokeStyle = style && style !== "default" ? style : null;
}
/** A new graphic as drawn: the session's stroke (incWidth / decWidth, SetStroke) over the layer default. */
export function withStroke(node: SNode) {
  if (!Array.isArray(node)) return node;
  const st = node.find((c) => Array.isArray(c) && c[0] === "stroke") as SNode | undefined;
  if (st && S.strokeStyle) { const ty = st.find((c) => Array.isArray(c) && c[0] === "type") as SNode | undefined; if (ty) ty[1] = S.strokeStyle; else st.push(["type", S.strokeStyle]); }
  if (S.strokeW == null) return node;
  const w = r6(S.strokeW);
  if (st) { const wi = st.find((c) => Array.isArray(c) && c[0] === "width"); if (wi) (wi as SNode)[1] = w; }
  const style = node.find((c) => Array.isArray(c) && c[0] === "style") as SNode | undefined;   // a dimension's line thickness
  if (style) { const th = style.find((c) => Array.isArray(c) && c[0] === "thickness") as SNode | undefined; if (th) th[1] = w; }
  return node;
}
/**
 * deleteLastPoint (Backspace) / doDelete while a line chain is drawn: the last committed segment is taken back (its
 * undo entry popped, PutDataInPreviousState) and its start becomes the start of the line being drawn again.
 */
export function undoChainSegment(ctx: PcbCtx) {
  const d = S.draw; if (!d || d.shape !== "gline" || !d.chain || !d.chain.length) return false;
  const last = d.chain.pop();
  if (ctx.doc.items.has(last!.id)) ctx.commit(deleteChanges(ctx.doc, [last!.id]), "line", { amend: true, discard: true });
  d.start = last!.start; d.pts = [last!.start]; d.cur = last!.end.slice();
  ctx.requestRender(); return true;
}
/**
 * BEZIER_GEOM_MANAGER: start, control 1, end, then control 2 as the cursor mirrored through the end (GetControlC2:
 * m_end - ( m_controlC2 - m_end )).  The four points of the curve for the clicks locked so far and the cursor; each
 * set point seeds the ones after it (setStart, setControlC1, setEnd), so an unfinished curve is still whole.
 */
export function curveGeom(pts: Pt[], cur: Pt): Pt[] {
  const s = pts[0], n = pts.length;
  if (n <= 1) return [s, cur, cur, cur];
  if (n === 2) return [s, pts[1], cur, cur];
  const e = pts[2], h = n > 3 ? pts[3] : cur;
  return [s, pts[1], e, [r6(2 * e[0] - h[0]), r6(2 * e[1] - h[1])]];
}
/** TestSegmentHit( p, a, b, 1 nm ) as SHAPE_LINE_CHAIN::Simplify asks it. */
const onSeg = (p: Pt, a: Pt, b: Pt) => {
  const T = 1e-6, x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  if (y0 - p[1] > T || p[1] - y1 > T || x0 - p[0] > T || p[0] - x1 > T) return false;
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const k = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + k * dx), p[1] - (a[1] + k * dy)) < 2 * T;
};
/**
 * ZONE_CREATE_HELPER::OnComplete on the closed outline: SHAPE_LINE_CHAIN::Simplify( 1 ) drops duplicate and collinear
 * corners, then the start point goes when it lies on the line between its neighbours (Simplify does not handle that).
 */
export function simplifyOutline(pts: Pt[]): Pt[] {
  const n = pts.length; let out: Pt[] = [];
  if (n < 3) out = pts.slice();
  else {
    for (let s = 0; s < n;) {
      out.push(pts[s]);
      let e = (s + 2) % n, can = true;
      while (can && e !== s) {
        for (let t = (s + 1) % n; t !== e; t = (t + 1) % n) if (!onSeg(pts[t], pts[s], pts[e])) { can = false; break; }
        if (can) e = (e + 1) % n;
      }
      if (e === (s + 2) % n) s++;
      else { const ns = (e + n - 1) % n; if (ns <= s) break; s = ns; }
    }
    if (out.length === 1) out.push(pts[n - 1]);
  }
  if (out.length >= 3) {   // SEG( last, pts[1] ).LineDistance( pts[0] ) <= 1
    const a = out[out.length - 1], b = out[1], p = out[0], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    const dist = l ? Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l : Math.hypot(p[0] - a[0], p[1] - a[1]);
    if (dist <= 1e-6) out.shift();
  }
  return out;
}

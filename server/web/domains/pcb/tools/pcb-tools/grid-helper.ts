// pcb-tools/grid-helper.ts — select-tool drags and PCB_GRID_HELPER's drag origin and magnetic snapping.
import type { BoardDoc, Mods, PcbCtx, Pt, SelectMove, SnapAnchor, SnapType } from "./types";
import { LOCKED_WARNING, overrideLocks } from "./actions";
import { isLocked } from "./groups";
import { padCovers, padsOf } from "./route-geom";
import { itemOnLayer, snapAllLayers } from "./snap-pairs";
import { K, S } from "./state";
import { anchorOf } from "./transforms";
import { MOVE_SNAP_MSG, angleSnapMode, displayConstraintsMsg } from "./draw-modes";
import { clone, corners, isList, pt, r6, rotator, samePt } from "./util";
import { dimKnee, dimRead, dimUpdate, kiRotate, type DimModel } from "./dimensions";
import { appGlobal, editorState } from "./app-state";
import { root } from "../root";
import { cancelConstructionProposal, clearConstruction, constructionBatchFor, constructionBatches, imageConstruction, isReferenceOnly, itemShapes, proposeConstructionItems, setConstructionChangeCallback, setReferenceOnlyPoints, shapeConstruction, shapeHit, snapLineClear, snapLineConfigure, snapLineConstruction, snapLineSetEnd, snapLineSetOrigin, snapLineSetSnappedAnchor, snapLineState, type CDrawable } from "./construction";

// ---------------------------------------------------------------- select-tool drags (PCB_SELECTION_TOOL → EDIT_TOOL::doMoveSelection / drag45)
// KiCad: a left-drag on a track slides the segment (attached ends follow), a via or graphic moves
// freely with the tracks ending on it stretching along.  app.js calls onSelectDown when its own
// footprint hit-test found nothing on the footprint's geometry; the capture-phase stage listeners
// below then drive the drag while app.js's select tool stays passive.
export function beginSelectDrag(ctx: PcbCtx, it: KItem, mm: Pt) {
  if (isLocked(it.node) && !overrideLocks()) { ctx.toast(LOCKED_WARNING, 3500); return false; }
  const m: SelectMove = { ids: [it.id], start: snapCursor(ctx, mm, new Set([it.id]), {}).p, orig: new Map(), ends: [], last: [0, 0], moved: false };   // a held-button drag: no warp, the cursor is the reference
  m.aux = m.start.slice(); snapLineClear(); clearConstruction();   // SetAuxAxes( true, dragOrigin ); a new grid helper
  m.orig.set(it.id, clone(it.node));
  if (it.kind === "via") {                                        // tracks ending on the via stretch with it
    const at = pt(it.node, "at");
    for (const sg of ctx.doc.items.values()) { if (sg.kind !== "segment" && sg.kind !== "arc") continue; for (const key of ["start", "end"]) { const q = pt(sg.node, key); if (q && at && samePt(q, at)) { m.ends.push({ id: sg.id, key }); if (!m.orig.has(sg.id)) m.orig.set(sg.id, clone(sg.node)); } } }
  }
  S.move = m; S.sel = new Set([it.id]); displayConstraintsMsg(MOVE_SNAP_MSG[angleSnapMode()]!); return true;
}
// ---------------------------------------------------------------- PCB_GRID_HELPER: drag origin and magnetic snapping
export const SNAP_SCREEN_RADIUS = 25;   // libs/snap snap_resolver.h: the magnetic range in screen pixels
export const SNAP_HYSTERESIS_PX = 5;    // ADVANCED_CFG::m_SnapHysteresis: snap in at range - 5 px, out at range + 5 px
/** PCB_GRID_HELPER::ANCHOR_FLAGS. */
export const ANCHOR_CORNER = 1, ANCHOR_OUTLINE = 2, ANCHOR_SNAPPABLE = 4, ANCHOR_ORIGIN = 8, ANCHOR_CONSTRUCTED = 64;
/** MAGNETIC_SETTINGS (pcbnew_settings.cpp): pads and tracks capture the cursor in the track tool only, graphics always. */
export type MagneticOption = "never" | "trackTool" | "always";
export interface MagneticSettings { pads: MagneticOption; tracks: MagneticOption; graphics: boolean }
export const MAGNETIC_DEFAULTS: MagneticSettings = { pads: "trackTool", tracks: "trackTool", graphics: true };
export const magneticSettings = (): MagneticSettings => Object.assign({}, MAGNETIC_DEFAULTS, S.magnetic || {});
/** SNAP_INFERENCE_SETTINGS (snap_settings.h): object geometry and construction extensions on by default (Preferences > Snapping). */
export interface SnapInferenceSettings { objectGeometry: boolean; constructionExtensions: boolean }
export const snapInferenceSettings = (): SnapInferenceSettings => Object.assign({ objectGeometry: true, constructionExtensions: true }, S.snapInference || {});
/** computeAnchors' options: the Selection Filter (drag origins only), the reference position, hidden layers. */
export interface AnchorOpts { filter?: Record<string, boolean | undefined> | null; hidden?: Set<string> | null; magnetic?: MagneticSettings | null; /** GetGrid().y when the grid is not square (gridPitch is its x) */ gridY?: number }
const C = ANCHOR_CORNER, O = ANCHOR_OUTLINE, SN = ANCHOR_SNAPPABLE, OR = ANCHOR_ORIGIN, CO = ANCHOR_CONSTRUCTED;
/** SHAPE_LINE_CHAIN::NearestPoint on a closed chain. */
function nearestOnChain(pts: Pt[], ref: Pt): Pt | null {
  let best: Pt | null = null, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]; const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 ? ((ref[0] - a[0]) * dx + (ref[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const q: Pt = [a[0] + t * dx, a[1] + t * dy], d = Math.hypot(q[0] - ref[0], q[1] - ref[1]); if (d < bd) { bd = d; best = q; }
  }
  return best;
}
const xyPts = (P: SNode | null | undefined): Pt[] => { const out: Pt[] = []; if (P) for (const xy of P.slice(1)) if (isList(xy) && xy[0] === "xy") out.push([K.num(xy[1]), K.num(xy[2])]); return out; };
/**
 * The snap points an item offers (PCB_GRID_HELPER::computeAnchors), each with its ANCHOR_FLAGS (`f`) and POINT_TYPE
 * (`t`).  aFrom (the items being moved; the Selection Filter decides which kinds give a drag origin): a footprint's
 * position and the middle of its box, the centre of a pad the mouse is inside; a track's ends and its middle (origin
 * only); an arc's ends and mid point; shapes by their ends, corners, centres, middles and quadrants.  Otherwise (the
 * items snapped to): pads and tracks only as the magnetic settings say (always / in the track tool / never), graphics
 * when "snap to graphics" is on, with a pad's outline points and hole.  Text gives its position as an origin only.
 * `mouse` is aRefPos: the pad test and the nearest point on a polygon or zone outline use it.
 */
export function itemAnchors(it: KItem, from: boolean, mouse: Pt | null, gridPitch: number, opts?: AnchorOpts | null): SnapAnchor[] {
  const out: SnapAnchor[] = []; const n = it.node, k = it.kind;
  const f = (opts && opts.filter) || null, mag = (opts && opts.magnetic) || magneticSettings();
  const off = (key: string) => from && !!f && f[key] === false;
  // the anchor is on a graphic shape (GetSnapped() is a PCB_SHAPE: lines, rectangles, circles, arcs, polygons, beziers, text boxes)
  const isShape = /^gr_(line|rect|circle|arc|poly|curve|text_box)$/.test(it.kind);
  const add = (p: Pt | null | undefined, flags: number, t?: SnapType) => { if (p) { const a = [p[0], p[1]] as SnapAnchor; a.t = t || "none"; a.f = flags; a.id = it.id; if (isShape) a.shape = true; out.push(a); } };
  const rectPoints = (x0: number, y0: number, x1: number, y1: number) => {   // addRectPoints: the centre, the corners, the middle of each side
    const fl = C | SN; add([(x0 + x1) / 2, (y0 + y1) / 2], fl, "center");
    for (const p of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) add(p, fl, "corner"); for (const p of [[(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0, (y0 + y1) / 2]]) add(p, fl, "mid");
  };
  const shape = (kind: string) => {   // handleShape
    const a = pt(n, "start"), b = pt(n, "end");
    if (kind === "gr_circle") {
      const c = pt(n, "center"); if (!c || !b) return; const r = Math.hypot(b[0] - c[0], b[1] - c[1]);
      add(c, OR | SN, "center"); for (const [dx, dy] of [[-r, 0], [r, 0], [0, -r], [0, r]]) add([c[0] + dx, c[1] + dy], O | SN, "quadrant");
    } else if (kind === "gr_arc") {
      const m = pt(n, "mid"); add(a, C | SN, "end"); add(b, C | SN, "end"); add(m, C | SN, "mid");
      const arc = a && m && b ? K.arcFrom3(a, m, b) : null; if (arc) add([arc.x, arc.y], OR | SN, "center");
    } else if (kind === "gr_rect" || kind === "gr_text_box") {
      if (a && b) { const [x0, y0, x1, y1] = corners(a, b); rectPoints(x0, y0, x1, y1); }
      else { const P = xyPts(K.kid(n, "pts")); for (const p of P) add(p, C | SN, "corner"); if (P.length && mouse) add(nearestOnChain(P, mouse), O); }   // a turned text box is a polygon
    } else if (kind === "gr_line") {
      add(a, C | SN, "end"); add(b, C | SN, "end"); if (a && b) add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], C | SN, "mid");
    } else if (kind === "gr_poly") {
      const P = xyPts(K.kid(n, "pts")); for (const p of P) add(p, C | SN, "corner");
      if (P.length) add(nearestOnChain(P, mouse || P[0]), O);
    } else if (kind === "gr_curve") {
      const P = xyPts(K.kid(n, "pts")); if (P.length) { add(P[0], C | SN, "end"); add(P[P.length - 1], C | SN, "end"); add(P[0], OR | SN); }
    }
  };
  if (k === "footprint") {
    // the pads: only one the reference position is inside; a drag origin gets its centre, a snap target its outline too
    if (mouse && (from ? !off("pads") : mag.pads === "always")) for (const p of padsOf(it)) {
      if (!padCovers(p, mouse[0], mouse[1])) continue;
      add([p.x, p.y], OR | SN, "center"); if (from) continue;
      const R = rotator(p.rot), at = (lx: number, ly: number): Pt => { const [x, y] = R(lx + p.off[0], ly + p.off[1]); return [p.x + x, p.y + y]; };
      const hw = p.w / 2, hh = p.h / 2;
      if (p.shape === "circle") { for (const [dx, dy] of [[0, -hw], [hw, 0], [0, hw], [-hw, 0]]) add([p.x + p.off[0] + dx, p.y + p.off[1] + dy], O | SN, "quadrant"); }
      else if (p.shape === "oval") { add(at(0, 0), O | SN, "center"); for (const q of [[-hw, 0], [hw, 0], [0, -hh], [0, hh]]) add(at(q[0], q[1]), O | SN, "quadrant"); }
      else { const cs: Pt[] = [at(-hw, hh), at(hw, hh), at(hw, -hh), at(-hw, -hh)]; for (let i = 0; i < 4; i++) { const a = cs[i], b = cs[(i + 1) % 4]; add(a, O | SN, "corner"); add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], O | SN, "mid"); } }
      const dr = K.kid(p.node, "drill"); const dv = dr ? dr.slice(1).filter((v) => typeof v === "number" || (typeof v === "string" && isFinite(Number(v)))) : [];
      if (dv.length) { const r = K.num(dv[0]) / 2; add([p.x, p.y], O | SN, "center"); for (const [dx, dy] of [[0, -r], [r, 0], [0, r], [-r, 0]]) add([p.x + dx, p.y + dy], O | SN, "quadrant"); }
    }
    if (off("footprints")) return out;
    const pos = anchorOf(it); add(pos, OR | SN, "center");
    if (it.bbox) { const c = [(it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2]; const g = gridPitch || 0, gy = opts && opts.gridY && opts.gridY > 0 ? opts.gridY : g; if (Math.hypot(c[0] - pos[0], c[1] - pos[1]) > Math.hypot(g, gy)) add(c, OR | SN, "center"); }   // |grid|: GetGrid() as a vector
    return out;
  }
  if (k === "segment" || k === "arc") {
    if (from ? off("tracks") : mag.tracks !== "always") return out;
    const a = pt(n, "start"), b = pt(n, "end"); add(a, C | SN, "end"); add(b, C | SN, "end");
    if (k === "arc") {   // GetArcAnchors: the stored mid point; the derived centre only for other items
      const m = pt(n, "mid"); add(m, C | SN, "mid");
      if (!from) { const arc = a && m && b ? K.arcFrom3(a, m, b) : null; if (arc) add([arc.x, arc.y], OR, "center"); }
    } else if (a && b) add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], OR, "mid");
    return out;
  }
  if (k === "via") { if (from ? off("vias") : mag.tracks !== "always") return out; add(K.atOf(n).slice(0, 2), OR | C | SN, "center"); return out; }
  if (k === "target") { add(K.atOf(n).slice(0, 2), OR | C | SN, "center"); return out; }
  if (k === "point") { if (!off("points")) add(K.atOf(n).slice(0, 2), OR | SN, "center"); return out; }
  if (k === "gr_line" || k === "gr_arc" || k === "gr_circle" || k === "gr_rect" || k === "gr_poly" || k === "gr_curve") { if (from ? off("graphics") : !mag.graphics) return out; shape(k); return out; }
  if (k === "gr_text_box") { if (from ? off("text") : !mag.graphics) return out; shape(k); return out; }
  if (k === "table") {
    if (from ? off("text") : !mag.graphics) return out; const b = it.bbox; if (!b) return out;
    add([b[0], b[1]], C | SN, "end"); add([b[0], b[3]], C | SN, "end"); add([b[2], b[1]], C | SN, "end"); add([b[2], b[3]], C | SN, "end"); add([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], OR, "mid");
    return out;
  }
  if (k === "zone") {
    if (off("zones")) return out;
    const P: Pt[] = []; for (const poly of K.kids(n, "polygon")) for (const p of xyPts(K.kid(poly, "pts"))) P.push(p);   // CIterateWithHoles: the outline and its holes
    for (const p of P) add(p, C | SN, "corner");
    if (P.length) add(nearestOnChain(P, mouse || P[0]), O);
    return out;
  }
  if (k === "dimension") {
    if (off("dimensions")) return out;
    const m = dimRead(n) as DimModel; try { dimUpdate(m); } catch (e) { /* a dimension the model cannot update: its feature points still count */ }
    const mm = (p: Pt | null | undefined): Pt | null => (p ? [p[0] / 1e6, p[1] / 1e6] : null), ty = m.type;
    if (ty === "aligned" || ty === "orthogonal") { add(mm(m.crossbarStart), C | SN); add(mm(m.crossbarEnd), C | SN); add(mm(m.start), C | SN); add(mm(m.end), C | SN); }
    else if (ty === "center") { add(mm(m.start), C | SN); add(mm(m.end), C | SN); let r: Pt = [m.end[0] - m.start[0], m.end[1] - m.start[1]]; for (let i = 0; i < 2; i++) { r = kiRotate(r, -90); add(mm([m.start[0] + r[0], m.start[1] + r[1]]), C | SN); } }
    else if (ty === "radial") { add(mm(m.start), C | SN); add(mm(m.end), C | SN); add(mm(dimKnee(m)), C | SN); add(mm(m.textPos), C | SN); }
    else if (ty === "leader") { add(mm(m.start), C | SN); add(mm(m.end), C | SN); add(mm(m.textPos), C | SN); }
    return out;
  }
  if (k === "gr_text" || k === "property" || k === "fp_text") { if (!off("text")) add(K.atOf(n).slice(0, 2), OR); return out; }
  if (k === "image") { if (off("graphics")) return out; const b = it.bbox; if (b) rectPoints(b[0], b[1], b[2], b[3]); return out; }
  if (k === "barcode") { if (off("other")) return out; add(K.atOf(n).slice(0, 2), OR, "center"); const b = it.bbox; if (b) rectPoints(b[0], b[1], b[2], b[3]); return out; }
  return out;
}
/** nearestAnchor( aPos, aFlags ): the nearest anchor that carries every flag asked for. */
export function nearestAnchor(anchors: SnapAnchor[], pos: Pt, flags: number): SnapAnchor | null {
  let best: SnapAnchor | null = null, bd = Infinity;
  for (const a of anchors) { if (((a.f || 0) & flags) !== flags) continue; const d = (a[0] - pos[0]) ** 2 + (a[1] - pos[1]) ** 2; if (d < bd) { bd = d; best = a; } }
  return best;
}
/**
 * PCB_GRID_HELPER::BestDragOrigin: of the moved items' anchors (aFrom, under the Selection Filter; a group gives its
 * members'), the nearest origin or corner; an outline anchor (a circle's quadrant, the nearest point on a polygon or
 * zone outline) wins only when that origin / corner is more than 50 px away and the outline point is nearer.  The
 * mouse itself when they offer none.  `mmPerPx` turns the 50 px into board units (0: the outline never wins).
 */
export function bestDragOrigin(doc: BoardDoc, ids: Iterable<string>, mouse: Pt, gridPitch: number, opts?: (AnchorOpts & { mmPerPx?: number }) | null) {
  const all: SnapAnchor[] = [], seen = new Set<string>();
  const take = (id: string, f: AnchorOpts | null | undefined, depth: number) => {
    const it = doc.items.get(id); if (!it || seen.has(id) || depth > 32) return; seen.add(id);
    if (it.kind === "group" || it.kind === "generated") { const m = K.kid(it.node, "members"); for (const mid of m ? m.slice(1).map(K.str) : []) take(mid, { hidden: f ? f.hidden : null, magnetic: f ? f.magnetic : null, gridY: f ? f.gridY : undefined }, depth + 1); return; }   // PCB_GROUP_T: its items, without the filter
    for (const p of itemAnchors(it, true, mouse, gridPitch, f)) all.push(p);
  };
  for (const id of ids) take(id, opts, 0);
  const dist = (a: SnapAnchor) => Math.hypot(a[0] - mouse[0], a[1] - mouse[1]);
  const outline = nearestAnchor(all, mouse, O), corner = nearestAnchor(all, mouse, C), origin = nearestAnchor(all, mouse, OR);
  let best: SnapAnchor | null = null, min = Infinity;
  if (origin) { min = dist(origin); best = origin; }
  if (corner) { const d = dist(corner); if (d < min) { min = d; best = corner; } }
  if (outline) { const d = dist(outline), far = 50 * ((opts && opts.mmPerPx) || 0); if (far > 0 && min > far && d < min) best = outline; }
  return best ? [r6(best[0]), r6(best[1])] : mouse.slice();
}
const FP_SHAPES: Record<string, string> = { fp_line: "gr_line", fp_rect: "gr_rect", fp_circle: "gr_circle", fp_arc: "gr_arc", fp_poly: "gr_poly", fp_curve: "gr_curve" };
/**
 * The anchors an item offers to snap TO (aFrom false) under the layer filter (computeAnchors' itemIsSnappable:
 * aMatchLayers & aItem.GetLayerSet() per view item).  queryVisible returns a footprint's children as their own view
 * items, so the footprint's origin / middle follow the footprint's layer and each footprint graphic its own layer
 * (PCB_SHAPE_T: magnetic graphics).  `only` empty = every layer (MAGNETIC_SETTINGS::allLayers).  `ref` is the cursor
 * (aRefPos): a pad gives its anchors only while the cursor is inside it.
 */
export function snapAnchors(it: KItem, only: string, gridPitch: number, ref?: Pt | null, opts?: AnchorOpts | null): SnapAnchor[] {
  if (it.kind !== "footprint") return !only || itemOnLayer(it, only) ? itemAnchors(it, false, ref || null, gridPitch, opts) : [];
  const out: SnapAnchor[] = !only || it.layer === only ? itemAnchors(it, false, ref || null, gridPitch, opts) : [];
  const mag = (opts && opts.magnetic) || magneticSettings(); if (!mag.graphics) return out;
  const hidden = opts && opts.hidden;
  const [fx, fy, fa] = K.atOf(it.node); const R = rotator(fa);
  for (const c of it.node) {
    if (!isList(c)) continue; const kind = FP_SHAPES[String(c[0])]; if (!kind) continue;
    const l = K.kid(c as SNode, "layer"); const layer = l ? K.str(l[1]) : "";
    if ((only && layer !== only) || (hidden && hidden.has(layer))) continue;
    const local: Pt | null = ref ? (() => { const [x, y] = rotator(-fa)(ref[0] - fx, ref[1] - fy); return [x, y] as Pt; })() : null;
    for (const p of itemAnchors({ id: it.id, kind, node: c as SNode, layer, geom: [] } as unknown as KItem, false, local, gridPitch, opts)) { const [x, y] = R(p[0], p[1]); const q = [fx + x, fy + y] as SnapAnchor; q.t = p.t; q.f = p.f; q.id = it.id; if (p.shape) q.shape = true; out.push(q); }
  }
  return out;
}
/** GRID_HELPER::computeSnapRanges (mm): the capture range, where a new anchor snaps in and where the held one lets go. */
export function snapRanges(pxPerMm: number, gridOn: boolean, gridPitch: number) {
  const scale = SNAP_SCREEN_RADIUS / Math.max(1e-6, pxPerMm || 4), hyst = SNAP_HYSTERESIS_PX / Math.max(1e-6, pxPerMm || 4);
  const range = gridOn && gridPitch ? Math.min(scale, gridPitch) : scale;
  return { scale, range, in: Math.max(0, range - hyst), out: range + hyst, rankingHysteresis: SNAP_HYSTERESIS_PX / SNAP_SCREEN_RADIUS };
}
/** Hidden layers and object classes of the editor (PCB_GRID_HELPER::queryVisible: only what is shown can be snapped to). */
function snapVisibility(ctx: PcbCtx): { hidden: Set<string> | null; hiddenItem: (it: KItem) => boolean } {
  const hidden = appGlobal(() => editorState()!.hiddenLayers as Set<string> | null, null) || null;
  const allowed = root.CollabEditor && (root.CollabEditor as { objectHidden?: (it: KItem) => boolean }).objectHidden;
  return { hidden, hiddenItem: (it) => (!!hidden && hidden.size > 0 && !K.itemVisible(it, hidden)) || (!!allowed && allowed(it)) };
}
/**
 * PCB_GRID_HELPER::BestSnapAnchor / ResolveSnap: the cursor pulled onto a snappable anchor of a visible item that is
 * not moving.  A new anchor captures within the snap-in range (SNAP_SCREEN_RADIUS less the hysteresis; no further
 * than one grid step when the grid is on); the anchor held from the last call (m_snapItem) stays until the cursor
 * leaves the snap-out range, and gives way only to an anchor nearer by more than the ranking hysteresis.  With the
 * grid off, the nearest point on a visible graphic or track within range is taken when no anchor is (point on
 * element); two such elements crossing within range give their intersection.  Else the grid.  Shift held turns
 * object snapping off (grid.SetSnap( !MD_SHIFT )), Ctrl the grid (TOOL_EVENT::DisableGridSnapping is MD_CTRL).
 * Returns { p, anchor } where anchor is the snapped-to point or null.
 */
export function snapCursor(ctx: PcbCtx, mm: Pt, skip: Set<string> | null, mods?: Mods | null, line?: SnapLines | null): { p: Pt; anchor: SnapAnchor | null; guide?: [Pt, Pt] | null } {
  mods = mods || {};
  const gridOn = !!(ctx.snapOn && ctx.snap) && !(mods.ctrlKey || mods.metaKey);
  let g = gridOn ? ctx.snap(mm.slice()) : mm.slice();
  // GRID_HELPER::Align: an auxiliary axis (SetAuxAxes: the drag origin of a move) wins on each axis it is nearer than the grid
  if (gridOn && line && line.aux) g = alignAux(g, mm, line.aux);
  // configureAngleSnap: the move's snap line directions and origin (ClearSnapLine when the mode has none)
  if (line) { if (line.dirs.length) snapLineConfigure(line.origin, line.dirs); else snapLineClear(); }
  const useLines = !!line && line.dirs.length > 0;
  // a grid helper's construction geometry lives as long as the tool that owns it
  const owner = line ? "move" : "cursor"; if (owner !== consOwner) { clearConstruction(); consOwner = owner; }
  // m_enableSnap off: no anchors, snap lines or construction geometry (constructionEnabled needs m_enableSnap)
  if (mods.shiftKey || !ctx.doc) { S.snapItem = null; clearConstruction(); snapLineSetEnd(null); return { p: g, anchor: null }; }
  setConstructionChangeCallback(() => { if (ctx.requestRender) ctx.requestRender(); });
  // SNAP_INFERENCE_SETTINGS (Preferences > Snapping > Snap Inference): constructionEnabled needs construction
  // extensions; the items' own geometry (intersections, points on elements) needs object geometry
  const inf = snapInferenceSettings(), consOn = inf.constructionExtensions;
  if (!consOn) clearConstruction();
  const R = snapRanges(ctx.pxPerMm || 4, gridOn, ctx.gridPitch || 0), range = R.range;
  // MAGNETIC_SETTINGS::allLayers off: only what is on the active layer (ResolveSnap's LSET{ GetActiveLayer() })
  const only = snapAllLayers(ctx) ? "" : (K.pcbSizes.state.activeLayer || S.gfxLayer || S.layer || "");
  const vis = snapVisibility(ctx), opts: AnchorOpts = { hidden: vis.hidden, gridY: ctx.gridPitchY };
  let nearest: SnapAnchor | null = null, nd = Infinity; const near: KItem[] = [];
  for (const it of ctx.doc.items.values()) {
    if (skip && skip.has(it.id)) continue; const b = it.bbox;
    if (b && (mm[0] < b[0] - R.out || mm[0] > b[2] + R.out || mm[1] < b[1] - R.out || mm[1] > b[3] + R.out)) continue;
    if (vis.hiddenItem(it)) continue;
    near.push(it);
    for (const p of snapAnchors(it, only, ctx.gridPitch, mm, opts)) { if (!((p.f || 0) & SN)) continue; const d = Math.hypot(p[0] - mm[0], p[1] - mm[1]); if (d < nd) { nd = d; nearest = p; } }
  }
  // computeAnchors over GetConstructionItems: the construction geometry's free points are snappable, constructed anchors
  const batches = (consOn ? constructionBatches() : []).concat(useLines ? [snapLineConstruction()] : []);
  for (const bt of batches) for (const ci of bt) for (const e of ci.drawables) {
    if (e.d.t !== "pt") continue; const q = e.d.p, d = Math.hypot(q[0] - mm[0], q[1] - mm[1]);
    if (d < nd) { nd = d; nearest = [q[0], q[1]] as SnapAnchor; nearest.t = "none"; nearest.f = SN | CO; if (ci.item) nearest.id = ci.item.split("#")[0]; }
  }
  // the held anchor (while its item is still there and not moving) and the nearest one compete: the held one's
  // residual is eased by the ranking hysteresis
  const held = S.snapItem && (!S.snapItem.id || (ctx.doc.items.has(S.snapItem.id) && !(skip && skip.has(S.snapItem.id)))) ? S.snapItem : null;
  const hd = held ? Math.hypot(held[0] - mm[0], held[1] - mm[1]) : Infinity;
  // a reference-only point (SetReferenceOnlyPoints) is never snapped to: within range it only moves the snap line origin
  const nearestRef = !!nearest && isReferenceOnly([nearest[0], nearest[1]]);
  const nearestCaptured = !!nearest && nd <= R.in;
  if (nearestCaptured && nearestRef) snapLineSetOrigin([nearest![0], nearest![1]]);
  // the snap lines: GetNearestSnapLinePoint (only while no anchor is within range: snapDist is the nearer of the
  // nearest and the held anchor), else SnapToConstructionLines, where the active direction reaches 1.5 x as far
  let lineSnap: Pt | null = null;
  const sl = useLines ? snapLineState() : null;
  if (sl && sl.origin) {
    const pitch = ctx.gridPitch || 0, gridAt = (q: Pt) => (ctx.snap ? ctx.snap(q.slice()) : q);
    lineSnap = nearestSnapLinePoint(sl.origin, sl.dirs, mm, g, range, pitch > 0 ? pitch : 0, gridAt, Math.min(nd, hd));
    if (!lineSnap) lineSnap = snapToConstructionLines(sl.origin, sl.dirs, sl.active, mm, g, range, gridOn && pitch > 0 ? pitch : 0, gridAt);
  }
  let best: SnapAnchor | null = null;
  const heldOk = !!held && hd <= R.out && !isReferenceOnly([held[0], held[1]]), nearOk = nearestCaptured && !nearestRef;
  if (heldOk && nearOk) best = Math.max(0, hd / R.scale - R.rankingHysteresis) <= nd / R.scale ? held : nearest;
  else if (heldOk) best = held; else if (nearOk) best = nearest;
  let res: { p: Pt; anchor: SnapAnchor | null; guide?: [Pt, Pt] | null } | null = null, presented = false;
  S.snapItem = best;
  snapLineSetEnd(null);
  if (best) {
    // an anchor: the snap line's end when it lies on one of the lines, else the snap line's new origin; a new
    // intrinsic anchor proposes its item's construction geometry
    presented = true; snapLineSetSnappedAnchor([best[0], best[1]]);
    if (consOn && best !== held && !((best.f || 0) & CO) && best.id) proposeFor(ctx, anchorItemKeys(ctx, best));
    res = { p: [r6(best[0]), r6(best[1])], anchor: best };
  } else {
    // no anchor captured: where two elements within range cross (construction geometry included), then (grid off)
    // the nearest point on an element
    const elem = inf.objectGeometry || consOn ? elementSnap(inf.objectGeometry ? near : [], mm, range, only, vis.hidden, !gridOn, batches) : null;
    // ResolveSnapFrame's subtype ranks: an intersection and a snap line point (CONSTRUCTED_POINT) both rank 1, the
    // nearer one winning; a point on an element (FINITE_MANIFOLD, 4) only after them
    const guideOk = !!lineSnap && !nearestCaptured && !isReferenceOnly(lineSnap), isX = !!elem && elem.t === "intersection";
    const dist = (q: Pt) => Math.hypot(q[0] - mm[0], q[1] - mm[1]);
    if (elem && isX && !(guideOk && dist(lineSnap!) < dist(elem))) { presented = true; snapLineSetSnappedAnchor([elem[0], elem[1]]); res = { p: [r6(elem[0]), r6(elem[1])], anchor: elem }; }
    else if (guideOk) { presented = true; const q: Pt = [r6(lineSnap![0]), r6(lineSnap![1])]; snapLineSetEnd(q); res = { p: q, anchor: null }; }
    else if (elem) res = { p: [r6(elem[0]), r6(elem[1])], anchor: elem };
  }
  // ExtensionSnapActivateOnHover: with no anchor captured, the graphic under the cursor proposes its construction
  // geometry; with nothing presented or proposed the pending proposal is cancelled
  let keep = presented || (nearestCaptured && nearestRef);
  if (consOn && !nearestCaptured && !presented) {
    const hit = hoveredShape(near, mm, only, vis.hidden);
    if (hit) { proposeFor(ctx, [hit]); keep = true; }
  }
  if (!keep) cancelConstructionProposal();
  const st = useLines ? snapLineState() : null;
  const guide: [Pt, Pt] | null = st && st.origin && st.end ? [st.origin.slice(), st.end.slice()] : null;
  if (res) return Object.assign(res, { guide });
  return { p: g, anchor: null, guide };
}
let consOwner = "";
/**
 * PCB_POINT_EDITOR's drag start: a clone of the item (unfilled) as persistent construction geometry,
 * AddConstructionItems( { clone }, aExtensionOnly = false, aIsPersistent = true ): a segment's whole line and its ends
 * (reference only), an arc's circle, centre and ends (reference only), a circle's or rectangle's centre.  The point
 * editor's grid helper owns it.
 */
export function proposePersistentConstruction(it: KItem) {
  if (consOwner !== "cursor") { clearConstruction(); consOwner = "cursor"; }
  if (!snapInferenceSettings().constructionExtensions) return;
  const refOnly: Pt[] = [];
  const keys = it.kind === "image" ? [{ key: it.id, drawables: imageConstruction(it) }]
    : itemShapes(it).map((s) => { if (s.shape.kind === "line" || s.shape.kind === "arc") refOnly.push(s.shape.start, s.shape.end); return { key: s.key, drawables: shapeConstruction(Object.assign({}, s.shape, { filled: false }), false, true) }; });
  if (refOnly.length) setReferenceOnlyPoints(refOnly);
  proposeConstructionItems(constructionBatchFor(keys), true);
}
/** GRID_HELPER::Align's auxiliary axis: x or y taken from the axis origin where that is nearer the cursor than the grid point. */
export function alignAux(nearest: Pt, at: Pt, aux: Pt): Pt {
  const out: Pt = [nearest[0], nearest[1]];
  if (Math.abs(aux[0] - at[0]) < Math.abs(nearest[0] - at[0])) out[0] = aux[0];
  if (Math.abs(aux[1] - at[1]) < Math.abs(nearest[1] - at[1])) out[1] = aux[1];
  return out;
}
type ConsKey = { key: string; drawables: CDrawable[] };
/** proposeConstructionForItems: AddConstructionItems( items, aExtensionOnly = true, aIsPersistent = false ). */
function proposeFor(ctx: PcbCtx, keys: ConsKey[]) { void ctx; if (keys.length) proposeConstructionItems(constructionBatchFor(keys), false); }
/** The graphics an anchor belongs to (its board graphic, or the footprint graphic it is a point of; else the item with nothing to draw). */
function anchorItemKeys(ctx: PcbCtx, a: SnapAnchor): ConsKey[] {
  const it = a.id ? ctx.doc.items.get(a.id) : null; if (!it) return [];
  if (it.kind === "image") return [{ key: it.id, drawables: imageConstruction(it) }];
  const shapes = itemShapes(it);
  if (it.kind === "footprint") {
    if (!a.shape) return [{ key: it.id, drawables: [] }];
    const on = (p: Pt | undefined) => !!p && Math.abs(p[0] - a[0]) < 1e-6 && Math.abs(p[1] - a[1]) < 1e-6;
    const s = shapes.find((x) => on(x.shape.start) || on(x.shape.end) || on(x.shape.center) || on(x.shape.mid) || on(x.shape.start && x.shape.end ? [(x.shape.start[0] + x.shape.end[0]) / 2, (x.shape.start[1] + x.shape.end[1]) / 2] : undefined));
    return s ? [{ key: s.key, drawables: shapeConstruction(s.shape, true, false) }] : [];
  }
  return shapes.length ? shapes.map((s) => ({ key: s.key, drawables: shapeConstruction(s.shape, true, false) })) : [{ key: it.id, drawables: [] }];
}
/** The first visible graphic whose HitTest( aOrigin, 0 ) holds (a board graphic, a footprint graphic or a reference image). */
function hoveredShape(near: KItem[], mm: Pt, only: string, hidden: Set<string> | null): ConsKey | null {
  for (const it of near) {
    if (it.kind === "image") { const b = it.bbox; if (b && mm[0] >= b[0] && mm[0] <= b[2] && mm[1] >= b[1] && mm[1] <= b[3]) return { key: it.id, drawables: imageConstruction(it) }; continue; }
    for (const s of itemShapes(it)) {
      if ((only && s.layer !== only) || (hidden && hidden.has(s.layer))) continue;
      if (shapeHit(s.shape, mm)) return { key: s.key, drawables: shapeConstruction(s.shape, true, false) };
    }
  }
  return null;
}
/** The straight pieces and arcs of the visible graphics and tracks near the cursor (m_pointOnLineCandidates). */
type SnapElem = { seg?: [Pt, Pt]; arc?: { c: Pt; r: number; a0?: number; a1?: number; anticlockwise?: boolean }; id: string; /** LINE (both ways) or HALF_LINE (from seg[0]) construction geometry */ ext?: "line" | "half"; cons?: boolean };
function snapElements(items: KItem[], only: string, hidden: Set<string> | null): SnapElem[] {
  const mag = magneticSettings(), out: SnapElem[] = [];
  for (const it of items) {
    const track = it.kind === "segment" || it.kind === "arc";
    if (track ? mag.tracks !== "always" : !mag.graphics) continue;
    if (!track && !/^gr_(line|rect|circle|arc|poly)$/.test(it.kind) && it.kind !== "footprint") continue;
    for (const g of (it.geom || []) as unknown as (GeomLike)[]) {
      if (!g.layer || (hidden && hidden.has(g.layer)) || (only && g.layer !== only)) continue;
      if (g.pad || g.padIndex !== undefined || g.padText || g.padNum || g.noBox || g.zoneFill) continue;
      if (g.t === "line") out.push({ seg: [[g.x1, g.y1], [g.x2, g.y2]], id: it.id });
      else if (g.t === "poly" && g.pts) { const n = g.pts.length; for (let i = 0; i < (g.close || g.fill ? n : n - 1); i++) out.push({ seg: [g.pts[i], g.pts[(i + 1) % n]], id: it.id }); }
      else if (g.t === "rect") { const P: Pt[] = [[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]]; for (let i = 0; i < 4; i++) out.push({ seg: [P[i], P[(i + 1) % 4]], id: it.id }); }
      else if (g.t === "circle" && !g.fill) out.push({ arc: { c: [g.x, g.y], r: g.r }, id: it.id });
      else if (g.t === "arc") out.push({ arc: { c: [g.x, g.y], r: g.r, a0: g.a0, a1: g.a1, anticlockwise: g.anticlockwise }, id: it.id });
    }
  }
  return out;
}
type GeomLike = { t: string; layer?: string; x1: number; y1: number; x2: number; y2: number; x: number; y: number; w: number; h: number; r: number; a0?: number; a1?: number; anticlockwise?: boolean; pts?: Pt[]; close?: boolean; fill?: unknown; pad?: unknown; padIndex?: unknown; padText?: unknown; padNum?: unknown; noBox?: unknown; zoneFill?: unknown };
const onArc = (a: NonNullable<SnapElem["arc"]>, p: Pt): boolean => {
  if (a.a0 === undefined || a.a1 === undefined) return true;
  const TWO = Math.PI * 2, nrm = (v: number) => ((v % TWO) + TWO) % TWO, from = a.anticlockwise ? a.a1 : a.a0, sweep = nrm((a.anticlockwise ? a.a0 : a.a1) - from) || TWO;
  return nrm(Math.atan2(p[1] - a.c[1], p[0] - a.c[0]) - from) <= sweep + 1e-9;
};
function nearestOnElem(e: SnapElem, p: Pt): Pt | null {
  if (e.seg && e.ext) {
    const [a, b] = e.seg, d = [b[0] - a[0], b[1] - a[1]], L = d[0] * d[0] + d[1] * d[1]; if (!L) return null;
    let t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L; if (e.ext === "half" && t < 0) t = 0;
    return [a[0] + t * d[0], a[1] + t * d[1]];
  }
  if (e.seg) return nearestOnChain([e.seg[0], e.seg[1]], p);
  const a = e.arc!, d = Math.hypot(p[0] - a.c[0], p[1] - a.c[1]); if (!d) return null;
  const q: Pt = [a.c[0] + ((p[0] - a.c[0]) * a.r) / d, a.c[1] + ((p[1] - a.c[1]) * a.r) / d];
  return onArc(a, q) ? q : null;
}
/** Whether parameter t (0 at seg[0], 1 at seg[1]) lies on the element: a segment's span, a ray's forward half, a whole line. */
const onParam = (e: SnapElem, t: number) => e.ext === "line" || (t >= -1e-9 && (e.ext === "half" || t <= 1 + 1e-9));
/** A construction drawable as a snap element (points are anchors instead). */
function consElem(d: CDrawable, id: string): SnapElem | null {
  if (d.t === "line" || d.t === "half") return { seg: [d.a, d.b], ext: d.t, id, cons: true };
  if (d.t === "seg") return { seg: [d.a, d.b], id, cons: true };
  if (d.t === "circle") return { arc: { c: d.c, r: d.r }, id, cons: true };
  if (d.t === "arc") return { arc: { c: d.c, r: d.r, a0: d.a0, a1: d.a1, anticlockwise: d.anticlockwise }, id, cons: true };
  return null;
}
/** The points where two elements cross (segment / segment, segment / circle or arc, circle / circle). */
function elemIntersections(a: SnapElem, b: SnapElem): Pt[] {
  const out: Pt[] = [];
  if (a.seg && b.seg) {
    const [p, p2] = a.seg, [q, q2] = b.seg, r = [p2[0] - p[0], p2[1] - p[1]], s = [q2[0] - q[0], q2[1] - q[1]], den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-12) return out;
    const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / den, u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / den;
    if (onParam(a, t) && onParam(b, u)) out.push([p[0] + t * r[0], p[1] + t * r[1]]);
    return out;
  }
  if (a.seg && b.arc) {
    const [p, p2] = a.seg, c = b.arc.c, d = [p2[0] - p[0], p2[1] - p[1]], fx = p[0] - c[0], fy = p[1] - c[1];
    const A = d[0] * d[0] + d[1] * d[1], B = 2 * (fx * d[0] + fy * d[1]), Cc = fx * fx + fy * fy - b.arc.r * b.arc.r, disc = B * B - 4 * A * Cc;
    if (A < 1e-18 || disc < 0) return out;
    for (const sg of [-1, 1]) { const t = (-B + sg * Math.sqrt(disc)) / (2 * A); if (!onParam(a, t)) continue; const q: Pt = [p[0] + t * d[0], p[1] + t * d[1]]; if (onArc(b.arc, q)) out.push(q); }
    return out;
  }
  if (a.arc && b.seg) return elemIntersections(b, a);
  if (a.arc && b.arc) {
    const dx = b.arc.c[0] - a.arc.c[0], dy = b.arc.c[1] - a.arc.c[1], d = Math.hypot(dx, dy), r0 = a.arc.r, r1 = b.arc.r;
    if (d < 1e-9 || d > r0 + r1 || d < Math.abs(r0 - r1)) return out;
    const k = (r0 * r0 - r1 * r1 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, r0 * r0 - k * k)), mx = a.arc.c[0] + (k * dx) / d, my = a.arc.c[1] + (k * dy) / d;
    for (const sg of [-1, 1]) { const q: Pt = [mx + (sg * h * dy) / d, my - (sg * h * dx) / d]; if (onArc(a.arc, q) && onArc(b.arc, q)) out.push(q); }
  }
  return out;
}
/**
 * PCB_GRID_HELPER's intersection anchors (computeAnchors over the items near the cursor: every pair of nearby
 * graphics / tracks that cross gives a snappable PT_INTERSECTION point) and, with the grid off, GetNearestPoint on
 * the elements themselves (PT_ON_ELEMENT), each within the snap range.
 */
function elementSnap(items: KItem[], mm: Pt, range: number, only: string, hidden: Set<string> | null, pointOnElement: boolean, batches?: { item: string | null; drawables: { d: CDrawable }[] }[][]): SnapAnchor | null {
  const all = snapElements(items, only, hidden);
  // GetConstructionItems: the construction lines, rays, circles and arcs intersect too (an item's own extension is
  // not intersected with the item; the snap lines, which have no item, not with each other)
  for (const bt of batches || []) for (const ci of bt) for (const e of ci.drawables) { const el = consElem(e.d, ci.item === null ? "" : ci.item.split("#")[0]); if (el) all.push(el); }
  const E = all.filter((e) => { const q = nearestOnElem(e, mm); return !!q && Math.hypot(q[0] - mm[0], q[1] - mm[1]) <= range * 2; });
  let best: SnapAnchor | null = null, bd = range;
  for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
    if (E[i].id === E[j].id && ((E[i].seg && E[j].seg) || E[i].cons || E[j].cons)) continue;   // a shape's own consecutive sides meet at its corners, which are anchors already
    for (const q of elemIntersections(E[i], E[j])) { const d = Math.hypot(q[0] - mm[0], q[1] - mm[1]); if (d <= bd) { bd = d; best = [q[0], q[1]] as SnapAnchor; best.t = "intersection"; best.f = SN | CO; } }
  }
  if (best || !pointOnElement) return best;
  for (const e of E) { const q = nearestOnElem(e, mm); if (!q) continue; const d = Math.hypot(q[0] - mm[0], q[1] - mm[1]); if (d <= bd) { bd = d; best = [q[0], q[1]] as SnapAnchor; best.t = "onElement"; best.f = SN; best.id = e.id; } }
  return best;
}
/** The snap lines a move offers (EDIT_TOOL::doMoveSelection configureAngleSnap): their origin and directions. */
export interface SnapLines { origin: Pt; dirs: Pt[]; /** GRID_HELPER::SetAuxAxes( true, origin ): the move's drag origin */ aux?: Pt | null }
/** configureAngleSnap: DEG45 offers H, V and both diagonals, DEG90 H and V, DIRECT none. */
export function angleSnapDirections(mode: string): Pt[] {
  return mode === "45" ? [[1, 0], [0, 1], [1, 1], [1, -1]] : mode === "90" ? [[1, 0], [0, 1]] : [];
}
/**
 * SNAP_LINE_MANAGER::GetNearestSnapLinePoint (common/tool/construction_manager.cpp): of the lines through `origin`
 * along `dirs` that pass within `range` of the cursor, the nearest one; the point on it is the grid point that keeps
 * it on the line — the origin's X or Y with the nearest grid's other coordinate for a vertical or horizontal line,
 * and for a diagonal the one of the 3x3 grid points around the projection that scores best on (distance from the
 * line + 0.1 x distance from the cursor).  `nearestGrid` is the cursor on the grid; `gridAt` puts a point on it.
 * `distToNearest` is the distance to the nearest anchor (aDistToNearest): within the range, no snap line point.
 */
export function nearestSnapLinePoint(origin: Pt, dirs: Pt[], cursor: Pt, nearestGrid: Pt, range: number, pitch: number, gridAt: (p: Pt) => Pt, distToNearest = Infinity): Pt | null {
  if (!(distToNearest > range)) return null;   // gridBetterThanNearest
  const delta = [cursor[0] - origin[0], cursor[1] - origin[1]];
  let bestPerp = Infinity, best: Pt | null = null;
  for (const dir of dirs) {
    const len = Math.hypot(dir[0], dir[1]); if (!len) continue;
    const u = [dir[0] / len, dir[1] / len];
    const along = delta[0] * u[0] + delta[1] * u[1];
    const proj: Pt = [origin[0] + u[0] * along, origin[1] + u[1] * along];
    const perp = Math.hypot(delta[0] - u[0] * along, delta[1] - u[1] * along);
    if (perp > range) continue;   // (the long-range escape needs perp >= 2 x range, so it never applies here)
    let sp: Pt = proj;
    if (pitch > 0) {
      if (dir[0] === 0 && dir[1] !== 0) sp = [origin[0], nearestGrid[1]];
      else if (dir[1] === 0 && dir[0] !== 0) sp = [nearestGrid[0], origin[1]];
      else {
        const g0 = gridAt(proj.slice()); let bs = Infinity, bp: Pt = proj;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const gp: Pt = [g0[0] + dx * pitch, g0[1] + dy * pitch];
          const gd = [gp[0] - origin[0], gp[1] - origin[1]]; const ga = gd[0] * u[0] + gd[1] * u[1];
          const score = Math.hypot(gd[0] - u[0] * ga, gd[1] - u[1] * ga) + Math.hypot(gp[0] - cursor[0], gp[1] - cursor[1]) * 0.1;
          if (score < bs) { bs = score; bp = gp; }
        }
        sp = bp;
      }
    }
    if (perp < bestPerp) { bestPerp = perp; best = sp; }
  }
  return best;
}
/**
 * GRID_HELPER::SnapToConstructionLines: the same lines through the snap line origin, tried when GetNearestSnapLinePoint
 * found none, with the active direction's range 1.5 x as wide (so a held line lets go later than it caught) and the
 * grid only when grid snapping is on (`pitch` 0 otherwise); the nearest line wins, then the point nearer the cursor.
 */
export function snapToConstructionLines(origin: Pt, dirs: Pt[], active: number | null, cursor: Pt, nearestGrid: Pt, range: number, pitch: number, gridAt: (p: Pt) => Pt): Pt | null {
  const delta = [cursor[0] - origin[0], cursor[1] - origin[1]];
  let bestPerp = Infinity, bestDist = Infinity, best: Pt | null = null;
  dirs.forEach((dir, ii) => {
    const len = Math.hypot(dir[0], dir[1]); if (!len) return;
    const u = [dir[0] / len, dir[1] / len];
    const along = delta[0] * u[0] + delta[1] * u[1];
    const proj: Pt = [origin[0] + u[0] * along, origin[1] + u[1] * along];
    const perp = Math.hypot(delta[0] - u[0] * along, delta[1] - u[1] * along);
    const threshold = active === ii ? range * 1.5 : range;
    if (perp > threshold) return;
    let sp: Pt = proj;
    if (pitch > 0) {
      if (dir[0] === 0 && dir[1] !== 0) sp = [origin[0], nearestGrid[1]];
      else if (dir[1] === 0 && dir[0] !== 0) sp = [nearestGrid[0], origin[1]];
      else {
        const g0 = gridAt(proj.slice()); let bs = Infinity, bp: Pt = proj;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const gp: Pt = [g0[0] + dx * pitch, g0[1] + dy * pitch];
          const gd = [gp[0] - origin[0], gp[1] - origin[1]]; const ga = gd[0] * u[0] + gd[1] * u[1];
          const score = Math.hypot(gd[0] - u[0] * ga, gd[1] - u[1] * ga) + Math.hypot(gp[0] - cursor[0], gp[1] - cursor[1]) * 0.1;
          if (score < bs) { bs = score; bp = gp; }
        }
        sp = bp;
      }
    }
    const cd = Math.hypot(sp[0] - cursor[0], sp[1] - cursor[1]);
    if (perp < bestPerp || (Math.abs(perp - bestPerp) < 1e-9 && cd < bestDist)) { bestPerp = perp; bestDist = cd; best = sp; }
  });
  return best;
}

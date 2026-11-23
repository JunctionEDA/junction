// pcb-tools/point-editor.ts — the point editor (PCB_POINT_EDITOR): edit points, arcs, corners.
import type { BoardDoc, PcbCtx, Pt } from "./types";

/** A handle of the point editor: its key, where it sits, round or square, and the indicator lines it draws. */
export interface EditPoint { key: string; p: Pt; circle?: boolean; lines?: Pt[] }
import { appTool, isBoardLikeDoc, liveDoc } from "./app-state";
import { crossZ } from "./arcs";
import { addedChange, replacedChange } from "./changes";
import { dimEditNode, dimEditPoints, snap45, snap90 } from "./dimensions";
import { angleSnapMode } from "./draw-modes";
import { groupMembers, isLocked, selectionIds } from "./groups";
import { line } from "./overlay";
import { lsGet, lsSet } from "./router-settings";
import { K, S, lastCtx } from "./state";
import { clone, norm360, pt, r6, rotator, samePt, vadd, vmul, vsub } from "./util";
import { mapNodePoints, rotateNode } from "./transforms";
import { isTuningPattern } from "./tuning-patterns";
import { proposePersistentConstruction, snapCursor } from "./grid-helper";
import { clearConstruction, setReferenceOnlyPoints } from "./construction";
import { EDIT_BORDER_PX, EDIT_HOVER_PX, EDIT_POINT_PX, editPointColors } from "../edit-point-style";
import { auxItemsColor } from "./assistants";
import { ELLIPSE_KINDS, ellipseEditNode, ellipseEditPoints } from "./ellipse";
import { genCancelEdit, genFinishEdit, genStartEdit, genUpdateEdit, selectedTuningPattern, tuningEditNode, tuningEditPoints } from "./tuning-edit";
import type { GenEdit } from "./tuning-edit";
import { blockAnchorEditingEnabled, blockClick, blockPickedKeys } from "./block-drag";

// ---------------------------------------------------------------- point editor (PCB_POINT_EDITOR)
// A single selected zone, rule area, polygon, line, rectangle, circle, arc or dimension carries KiCad's edit handles: squares on
// the corners / ends (EDIT_POINT), circles on the edge midpoints (EDIT_LINE centre points).  Dragging a handle reshapes
// the item; a zone or polygon edge midpoint drags the whole edge; Ins (Create Corner) adds a corner on the edge under
// the cursor, Remove Corner takes the corner under it out.  Only the edited coordinates are rewritten.
export const PE_KINDS = new Set(["zone", "gr_poly", "gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_curve", "gr_ellipse", "gr_ellipse_arc", "gr_text_box", "barcode", "dimension", "image", "group", "pad"]);
/** What a handle drag carries besides the cursor: Ctrl held, the grid pitch (0: off) and the line mode's angle limit. */
export interface EditOpts { ctrl?: boolean; gridPitch?: number; /** GetGridSize().y (gridPitch is its x) */ gridPitchY?: number; angle?: string }
/** Every contour of a zone outline or polygon as its (pts) list: the main outline first, then the holes ((polygon …) children of a zone). */
export function peContours(node: SNode): SNode[] {
  if (node[0] !== "zone") { const p = K.kid(node, "pts"); return p ? [p] : []; }
  return K.kids(node, "polygon").map((pg) => K.kid(pg, "pts")).filter(Boolean) as SNode[];
}
const ptsOfList = (pn: SNode): Pt[] => K.kids(pn, "xy").map((x) => [K.num(x[1]), K.num(x[2])]);
/** A flat corner index (SHAPE_POLY_SET's global vertex index, holes included) as { contour, index, pts, node }. */
export function peLocate(node: SNode, g: number) {
  let base = 0, ci = 0;
  for (const pn of peContours(node)) { const pts = ptsOfList(pn); if (g < base + pts.length) return { contour: ci, index: g - base, base, pts, node: pn }; base += pts.length; ci++; }
  return null;
}
/** RECT_MIN_SIZE: PinEditedCorner keeps the corners one mil apart (EDA_UNIT_UTILS::Mils2IU( 1 )). */
export const RECT_MIN = 0.0254;
/** The rectangle of a gr_rect, an upright gr_text_box or a barcode at a cardinal angle as [left, top, right, bottom], or null. */
export function peRect(n: SNode, kind: string): [number, number, number, number] | null {
  if (kind === "barcode") {
    const at = K.kid(n, "at"), sz = K.kid(n, "size"); if (!at || !sz) return null;
    const ang = ((K.num(at[3], 0) % 360) + 360) % 360; if (ang % 90) return null;   // BARCODE_POINT_EDIT_BEHAVIOR: cardinal angles only
    let w = K.num(sz[1]), h = K.num(sz[2]); if (ang % 180) [w, h] = [h, w];
    return [K.num(at[1]) - w / 2, K.num(at[2]) - h / 2, K.num(at[1]) + w / 2, K.num(at[2]) + h / 2];
  }
  const a = pt(n, "start"), b = pt(n, "end"); if (!a || !b) return null;   // a rotated text box is a polygon: not editable
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}
/** EDA_SHAPE::GetCornerRadius of a gr_rect: its (radius …), 0 without one. */
export const rectRadius = (n: SNode) => { const r = n[0] === "gr_rect" ? K.kid(n, "radius") : null; return r ? K.num(r[1], 0) : 0; };
/** The (pts) list a polygon edit works on: the zone's first outline, the polygon's own points. */
export function pePtsNode(node: SNode) { const host = node[0] === "zone" ? K.kid(node, "polygon") : node; return host ? K.kid(host, "pts") : null; }
export function pePolyPts(node: SNode) { const p = pePtsNode(node); return p ? K.kids(p, "xy").map((x) => [K.num(x[1]), K.num(x[2])]) : []; }
// ---- REFERENCE_IMAGE_POINT_EDIT_BEHAVIOR (common/tool/point_editor_behavior.cpp): the four corners of the image's
// bounding box (scale about the transform origin), the transform origin and the rotation handle above it.  The
// transform origin is REFERENCE_IMAGE::m_transformOriginOffset, which the file does not keep: it lives for the session,
// per image (by uuid).
const IMG_MIN = 1;                                        // pcbIUScale.mmToIU( 1.0 ): the smallest width and height
const imgOrigins = new Map<string, Pt>();
const imgBase = new Map<string, Pt>();                    // the unrotated size at scale 1 (BITMAP_BASE::GetSize / scale)
const imgUuid = (n: SNode) => { const u = K.kid(n, "uuid"); return u ? String(u[1]) : ""; };
const imgScale = (n: SNode) => { const s = K.kid(n, "scale"); const v = s ? K.num(s[1], 1) : 1; return v > 0 && isFinite(v) ? v : 1; };
const imgAngle = (n: SNode) => { const r = K.kid(n, "rotate"); return r ? K.num(r[1], 0) : 0; };
/** REFERENCE_IMAGE::GetTransformOriginOffset of an image node. */
export function imageOriginOffset(n: SNode): Pt { const o = imgOrigins.get(imgUuid(n)); return o ? [o[0], o[1]] : [0, 0]; }
export function setImageOriginOffset(n: SNode, off: Pt) { const u = imgUuid(n); if (!u) return; if (off[0] || off[1]) imgOrigins.set(u, off); else imgOrigins.delete(u); }
/** GetSize (unrotated) and boundingSize (the extent at the image's orientation), in mm; null before the canvas measured it. */
function imageSizes(n: SNode): { size: Pt; box: Pt } | null {
  const b = imgBase.get(imgUuid(n)); if (!b) return null;
  const sc = imgScale(n), size: Pt = [b[0] * sc, b[1] * sc], a = norm360(imgAngle(n));
  if (a % 180 === 0) return { size, box: size };
  if (a % 90 === 0) return { size, box: [size[1], size[0]] };
  const c = Math.abs(Math.cos(a * Math.PI / 180)), sn = Math.abs(Math.sin(a * Math.PI / 180));
  return { size, box: [size[0] * c + size[1] * sn, size[0] * sn + size[1] * c] };
}
function imageEditPoints(it: KItem): EditPoint[] {
  const n = it.node, ext = it as KItem & { w?: number; h?: number };
  if (ext.w && ext.h) { const sc = imgScale(n); imgBase.set(imgUuid(n), [ext.w / sc, ext.h / sc]); }
  const sz = imageSizes(n); if (!sz) return [];
  const pos = K.atOf(n) as Pt, off = imageOriginOffset(n), ang = imgAngle(n);
  const tl: Pt = [pos[0] - sz.box[0] / 2, pos[1] - sz.box[1] / 2], br: Pt = [pos[0] + sz.box[0] / 2, pos[1] + sz.box[1] / 2];
  const tr: Pt = [br[0], tl[1]], bl: Pt = [tl[0], br[1]], origin = vadd(pos, off);
  // the rotation handle reaches 70 % of the image's height above the transform origin, along its orientation
  const local = rotator(-ang)(off[0], off[1]), len = local[1] + sz.size[1] * 0.7;
  const toRot = rotator(ang)(0, -len), rot: Pt = [origin[0] + toRot[0], origin[1] + toRot[1]];
  return [{ key: "i0", p: tl, lines: [tr] }, { key: "i1", p: tr, lines: [br] }, { key: "i2", p: br, lines: [bl] }, { key: "i3", p: bl, lines: [tl] },
    { key: "io", p: origin, lines: [rot] }, { key: "ir", p: rot }];
}
/** REFERENCE_IMAGE_POINT_EDIT_BEHAVIOR::UpdateItem on an image node; `off0` is the transform origin as the drag began. */
function imageEditNode(orig: SNode, key: string, p: Pt, off0: Pt): SNode {
  const node = clone(orig), pos = K.atOf(orig) as Pt, origin = vadd(pos, off0);
  if (key === "io") { setImageOriginOffset(node, vsub(p, pos)); return node; }   // the other points did not move
  if (key === "ir") {
    // the handle points along the image's up direction: the target angle is the cursor's less a quarter turn
    const v = vsub(p, origin), target = Math.atan2(-v[1], v[0]) * 180 / Math.PI - 90;
    const delta = target - imgAngle(orig);
    rotateNode(node, origin[0], origin[1], delta);                 // REFERENCE_IMAGE::Rotate( origin, delta )
    const o = rotator(delta)(off0[0], off0[1]); setImageOriginOffset(node, [o[0], o[1]]);
    return node;
  }
  const sz = imageSizes(orig); if (!sz) return node;
  const i = +key.slice(1), hx = sz.box[0] / 2, hy = sz.box[1] / 2;
  const oldCorner: Pt = [pos[0] + (i === 1 || i === 2 ? hx : -hx), pos[1] + (i >= 2 ? hy : -hy)];
  let nc = vsub(p, origin); const oc = vsub(oldCorner, origin);
  if (Math.sign(nc[0]) !== Math.sign(oc[0]) || Math.sign(nc[1]) !== Math.sign(oc[1])) nc = [0, 0];   // the corner may not cross the origin
  const oldLen = Math.hypot(oc[0], oc[1]);
  let ratio = oldLen > 0 ? Math.hypot(nc[0], nc[1]) / oldLen : 1;
  const nw = Math.max(sz.box[0] * ratio, IMG_MIN), nh = Math.max(sz.box[1] * ratio, IMG_MIN);
  ratio = Math.min(nw / sz.box[0], nh / sz.box[1]);
  // SetImageScale -> scaleBy: the transform origin stays put, the centre and the offset scale about it
  const off = vmul(off0, ratio) as Pt, centre = vsub(origin, off);
  const at = K.kid(node, "at")!; at[1] = r6(centre[0]); at[2] = r6(centre[1]);
  setImageOriginOffset(node, off);
  const scale = Number((imgScale(orig) * ratio).toPrecision(6)), sn = K.kid(node, "scale");   // (scale {:g})
  if (scale === 1) { if (sn) node.splice(node.indexOf(sn), 1); }
  else if (sn) sn[1] = scale;
  else { const after = K.kid(node, "rotate") || K.kid(node, "layer") || at; node.splice(node.indexOf(after) + 1, 0, ["scale", scale]); }
  return node;
}
// ---- SHAPE_GROUP_POINT_EDIT_BEHAVIOR (pcb_point_editor.cpp): a group holding only graphic shapes gets the corners and
// the centre of its shapes' bounding box (PCB_SHAPE::GetBoundingBox).  The centre moves the group; a corner, held one
// mil inside the opposite one (PinEditedCorner), scales every shape about the old centre by the mean of the width and
// height ratios (at least 0.01), the line widths with them.  Any other member rejects the group (no handles).
const GROUP_SHAPES = new Set(["gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_curve"]);
/** The group's shapes, or null when it holds anything else (aRejected). */
export function groupShapeItems(doc: BoardDoc | null | undefined, group: KItem): KItem[] | null {
  if (!doc) return null;
  const items = groupMembers(group.node).map((id) => doc.items.get(id));
  return items.length && items.every((m) => !!m && GROUP_SHAPES.has(m.kind)) ? items as KItem[] : null;
}
/** The merged GetBoundingBox of the shapes as [left, top, right, bottom] in mm. */
export function groupShapesBox(items: KItem[]): [number, number, number, number] | null {
  let b: [number, number, number, number] | null = null;
  for (const m of items) {
    const r = K.boardItemBox ? K.boardItemBox(m, 1e6) : null; if (!r) continue;
    const q: [number, number, number, number] = [r[0] / 1e6, r[1] / 1e6, (r[0] + r[2]) / 1e6, (r[1] + r[3]) / 1e6];
    b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q;
  }
  return b;
}
/** PCB_POINT_EDITOR::bboxHandleInflation: with block anchor editing on, about 10 screen pixels keep the box's handles
 * clear of the shapes' own handles next to it. */
export const bboxHandleInflation = () => (blockAnchorEditingEnabled() ? 10 * (S.mmPerPx || 0.05) : 0);
function groupEditPoints(it: KItem): EditPoint[] {
  const doc = [liveDoc(), lastCtx && lastCtx.doc].find((d) => d && d.items.get(it.id) === it) || liveDoc();
  const shapes = groupShapeItems(doc, it); const b0 = shapes && groupShapesBox(shapes); if (!b0) return [];
  const inf = bboxHandleInflation(), b = [b0[0] - inf, b0[1] - inf, b0[2] + inf, b0[3] + inf];   // bbox.Inflate( m_inflation )
  const tl: Pt = [b[0], b[1]], tr: Pt = [b[2], b[1]], br: Pt = [b[2], b[3]], bl: Pt = [b[0], b[3]];
  return [{ key: "g0", p: tl, lines: [tr] }, { key: "g1", p: tr, lines: [br] }, { key: "g2", p: br, lines: [bl] }, { key: "g3", p: bl, lines: [tl] }, { key: "gc", p: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] }];
}
/** SHAPE_GROUP_POINT_EDIT_BEHAVIOR::UpdateItem: the shapes' new nodes, from their nodes and box as the drag began. */
export function groupEditNodes(origs: Map<string, SNode>, box: [number, number, number, number], key: string, p: Pt, inflation = 0): Map<string, SNode> {
  const out = new Map<string, SNode>(), oc: Pt = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  // the gap taken back out before pinning, so a corner the user did not touch scales by exactly one
  if (inflation) p = ({ g0: [p[0] + inflation, p[1] + inflation], g1: [p[0] - inflation, p[1] + inflation], g2: [p[0] - inflation, p[1] - inflation], g3: [p[0] + inflation, p[1] - inflation] } as Record<string, Pt>)[key] || p;
  if (key === "gc") {
    const dx = p[0] - oc[0], dy = p[1] - oc[1];
    for (const [id, n] of origs) { const m = clone(n); mapNodePoints(m, (x, y) => [x + dx, y + dy]); out.set(id, m); }
    return out;
  }
  let [L, T, R, B] = box;
  ({ g0: () => { L = Math.min(p[0], R - RECT_MIN); T = Math.min(p[1], B - RECT_MIN); }, g1: () => { R = Math.max(p[0], L + RECT_MIN); T = Math.min(p[1], B - RECT_MIN); },
    g2: () => { R = Math.max(p[0], L + RECT_MIN); B = Math.max(p[1], T + RECT_MIN); }, g3: () => { L = Math.min(p[0], R - RECT_MIN); B = Math.max(p[1], T + RECT_MIN); } } as Record<string, () => void>)[key]?.();
  const sx = (R - L) / (box[2] - box[0]), sy = (B - T) / (box[3] - box[1]);
  const scale = Math.max((sx + sy) / 2, 0.01);   // MIN_SCALE
  for (const [id, n] of origs) {
    const m = clone(n);
    mapNodePoints(m, (x, y) => [oc[0] + (x - oc[0]) * scale, oc[1] + (y - oc[1]) * scale]);   // Move( -origin ), Scale, Move( origin )
    const st = K.kid(m, "stroke"), w = st ? K.kid(st, "width") : K.kid(m, "width");
    if (w) w[1] = r6(K.num(w[1], 0) * scale);                                                  // SetWidth( KiROUND( width * scale ) )
    out.set(id, m);
  }
  return out;
}
// ---- PAD_POINT_EDIT_BEHAVIOR (pcb_point_editor.cpp), footprint editor only: on the active copper layer (a technical
// layer stands for the front or back copper) a round pad has a radius handle, an oval, rectangle, rounded / chamfered
// rectangle or trapezoid at a cardinal orientation its four corners.  A pad with a hole or a shape offset keeps the hole
// where it is and resizes / offsets the shape around it; otherwise the pad stays centred in its shape.
const MIL = 0.0254;
/** PADSTACK's copper layer the point editor works on: the active layer, or F.Cu / B.Cu for a technical one. */
function padEditLayer(): string {
  const l = String((lastCtx && lastCtx.activeLayer) || S.layer || "F.Cu");
  return /\.Cu$/.test(l) ? l : /^F\./.test(l) ? "F.Cu" : "B.Cu";
}
/** The pad's shape, size and offset on that layer: the pad's own (F.Cu, or every layer), else its (padstack (layer …)). */
function padLayerView(n: SNode, layer: string) {
  const ps = K.kid(n, "padstack"), mode = ps ? K.str((K.kid(ps, "mode") || [])[1] || "normal") : "normal";
  let L: SNode | null = null;
  if (ps && mode === "front_inner_back" && layer !== "F.Cu") L = K.kids(ps, "layer").find((x) => K.str(x[1]) === (layer === "B.Cu" ? "B.Cu" : "Inner")) || null;
  else if (ps && mode === "custom" && layer !== "F.Cu") L = K.kids(ps, "layer").find((x) => K.str(x[1]) === layer) || null;
  if (L) {
    const sh = K.kid(L, "shape"), sz = K.kid(L, "size"), off = K.kid(L, "offset");
    return { shape: sh ? K.str(sh[1]) : K.str(n[3]), size: sz, offset: (off ? [K.num(off[1]), K.num(off[2])] : [0, 0]) as Pt,
      setOffset: (o: Pt) => { const c = K.kid(L!, "offset"); if (c) { c[1] = r6(o[0]); c[2] = r6(o[1]); } else L!.splice(L!.indexOf(K.kid(L!, "size")!) + 1, 0, ["offset", r6(o[0]), r6(o[1])]); } };
  }
  const dr = K.kid(n, "drill"), off = dr ? K.kid(dr, "offset") : null;
  return { shape: K.str(n[3]), size: K.kid(n, "size"), offset: (off ? [K.num(off[1]), K.num(off[2])] : [0, 0]) as Pt,
    setOffset: (o: Pt) => {
      let d = K.kid(n, "drill"); if (!d) { d = ["drill"]; const sz = K.kid(n, "size"); n.splice(sz ? n.indexOf(sz) + 1 : n.length, 0, d); }
      const c = K.kid(d, "offset"); if (c) { c[1] = r6(o[0]); c[2] = r6(o[1]); } else d.push(["offset", r6(o[0]), r6(o[1])]);
    } };
}
const padDrill = (n: SNode): Pt => {
  const d = K.kid(n, "drill"); if (!d) return [0, 0];
  const v = d.slice(1).filter((x) => typeof x === "number" || (typeof x === "string" && /^[-\d.]/.test(x))).map(Number);
  return d.includes("oval") ? [v[0] || 0, v[1] ?? v[0] ?? 0] : [v[0] || 0, v[0] || 0];
};
const RECTISH = new Set(["oval", "trapezoid", "rect", "roundrect", "chamfered_rect"]);
function padEditPoints(it: KItem): EditPoint[] {
  const doc = [liveDoc(), lastCtx && lastCtx.doc].find((d) => d && d.items.get(it.id) === it) || liveDoc();
  if (!doc || !(doc as BoardDoc & { fpEditor?: boolean }).fpEditor || isLocked(it.node)) return [];
  return padHandles(it.node);
}
function padHandles(n: SNode): EditPoint[] {
  const v = padLayerView(n, padEditLayer()); if (!v.size) return [];
  const [x, y, a = 0] = K.atOf(n) as number[], o = rotator(a)(v.offset[0], v.offset[1]), sp: Pt = [x + o[0], y + o[1]];
  let hx = K.num(v.size[1]) / 2, hy = K.num(v.size[2]) / 2;
  if (v.shape === "circle") return [{ key: "p0", p: [sp[0] + hx, sp[1]] }];
  const ang = norm360(a); if (!RECTISH.has(v.shape) || ang % 90) return [];
  if (ang % 180) [hx, hy] = [hy, hx];
  return [{ key: "p0", p: [sp[0] - hx, sp[1] - hy] }, { key: "p1", p: [sp[0] + hx, sp[1] - hy] }, { key: "p2", p: [sp[0] + hx, sp[1] + hy] }, { key: "p3", p: [sp[0] - hx, sp[1] + hy] }];
}
/** PAD_POINT_EDIT_BEHAVIOR::UpdateItem. */
function padEditNode(orig: SNode, key: string, p: Pt): SNode {
  const node = clone(orig), v = padLayerView(node, padEditLayer()); if (!v.size) return node;
  const [x, y, a = 0] = K.atOf(orig) as number[];
  if (v.shape === "circle") { const d = r6(2 * Math.hypot(p[0] - x, p[1] - y)); v.size[1] = d; v.size[2] = d; return node; }
  const pts = padHandles(orig);
  const cur = (k: string) => (pts.find((h) => h.key === k) || { p: [0, 0] as Pt }).p;
  let tl = cur("p0"), tr = cur("p1"), br = cur("p2"), bl = cur("p3");
  const drill = padDrill(orig), hole: Pt = [x, y];
  // RECTANGLE_POINT_EDIT_BEHAVIOR::PinEditedCorner with the hole: the edited corner stays clear of the hole (or one
  // mil inside the opposite corner) and drags its two neighbours' edges
  if (key === "p0") { tl = drill[0] ? [Math.min(p[0], hole[0] - drill[0] / 2 - MIL), Math.min(p[1], hole[1] - drill[1] / 2 - MIL)] : [Math.min(p[0], br[0] - MIL), Math.min(p[1], br[1] - MIL)]; tr = [tr[0], tl[1]]; bl = [tl[0], bl[1]]; }
  else if (key === "p1") { tr = drill[0] ? [Math.max(p[0], hole[0] + drill[0] / 2 + MIL), Math.min(p[1], hole[1] - drill[1] / 2 - MIL)] : [Math.max(p[0], bl[0] + MIL), Math.min(p[1], bl[1] - MIL)]; tl = [tl[0], tr[1]]; br = [tr[0], br[1]]; }
  else if (key === "p3") { bl = drill[0] ? [Math.min(p[0], hole[0] - drill[0] / 2 - MIL), Math.max(p[1], hole[1] + drill[1] / 2 + MIL)] : [Math.min(p[0], tr[0] - MIL), Math.max(p[1], tr[1] + MIL)]; tl = [bl[0], tl[1]]; br = [br[0], bl[1]]; }
  else if (key === "p2") { br = drill[0] ? [Math.max(p[0], hole[0] + drill[0] / 2 + MIL), Math.max(p[1], hole[1] + drill[1] / 2 + MIL)] : [Math.max(p[0], tl[0] + MIL), Math.max(p[1], tl[1] + MIL)]; tr = [br[0], tr[1]]; bl = [bl[0], br[1]]; }
  const vertical = norm360(a) % 180 !== 0, tlbr = key === "p0" || key === "p2";
  if (v.offset[0] || v.offset[1] || (drill[0] && drill[1])) {
    // the hole stays: the shape is sized and offset around it
    const d = tlbr ? [x - tl[0], y - tl[1], br[0] - x, br[1] - y] : [x - bl[0], y - tr[1], tr[0] - x, bl[1] - y];
    let size: Pt = [d[0] + d[2], d[1] + d[3]]; const delta = rotator(-a)(size[0] / 2 - d[2], size[1] / 2 - d[3]);
    if (vertical) size = [size[1], size[0]];
    v.size[1] = r6(size[0]); v.size[2] = r6(size[1]);
    v.setOffset([-delta[0], -delta[1]]);
  } else {
    // the pad stays centred in its shape
    const [L, T, R, B] = tlbr ? [tl[0], tl[1], br[0], br[1]] : [bl[0], tr[1], tr[0], bl[1]];
    let size: Pt = [Math.abs(R - L), Math.abs(B - T)]; if (vertical) size = [size[1], size[0]];
    v.size[1] = r6(size[0]); v.size[2] = r6(size[1]);
    const at = K.kid(node, "at")!; at[1] = r6((L + R) / 2); at[2] = r6((T + B) / 2);
  }
  return node;
}
/** EDIT_POINTS of an item: [{ key, p, circle }] in drawing order. */
export function editPoints(it: KItem): EditPoint[] {
  if (it && it.kind === "generated") return isTuningPattern(it) ? tuningEditPoints(it) : [];   // PCB_TUNING_PATTERN::MakeEditPoints
  if (!it || !PE_KINDS.has(it.kind)) return [];
  const n = it.node, out: EditPoint[] = [];
  if (it.kind === "dimension") return dimEditPoints(n);
  if (ELLIPSE_KINDS.has(it.kind)) return ellipseEditPoints(n);   // EDA_ELLIPSE_POINT_EDIT_BEHAVIOR::MakePoints
  if (it.kind === "image") return imageEditPoints(it);
  if (it.kind === "group") return groupEditPoints(it);
  if (it.kind === "pad") return padEditPoints(it);
  if (it.kind === "zone" || it.kind === "gr_poly") {
    // BuildForPolyOutline: every contour (the main outline and the holes) has its corners and its edge lines
    let base = 0; const mids: EditPoint[] = [];
    for (const pn of peContours(n)) {
      const pts = ptsOfList(pn);
      pts.forEach((p, i) => out.push({ key: "c" + (base + i), p }));
      if (pts.length > 1) pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; mids.push({ key: "m" + (base + i), p: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], circle: true }); });
      base += pts.length;
    }
    out.push(...mids);
  } else if (it.kind === "gr_line") { for (const k of ["start", "end"]) { const p = pt(n, k); if (p) out.push({ key: k, p }); } }
  else if (it.kind === "gr_curve") {   // EDA_BEZIER_POINT_EDIT_BEHAVIOR: start, control 1, control 2, end, with indicator lines to the controls
    const ps = K.ptsOf(n); if (ps.length !== 4) return out;
    out.push({ key: "b0", p: ps[0] }, { key: "b1", p: ps[1], lines: [ps[0]] }, { key: "b2", p: ps[2], lines: [ps[3]] }, { key: "b3", p: ps[3] });
  }
  else if (it.kind === "gr_rect" || it.kind === "gr_text_box" || it.kind === "barcode") {
    // RECTANGLE_POINT_EDIT_BEHAVIOR::MakePoints: the corners (top left, top right, bottom right, bottom left), the
    // centre, the corner-radius handle (drawn round) and the four edge lines
    const r = peRect(n, it.kind); if (!r) return out; const [x0, y0, x1, y1] = r;
    const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    c.forEach((p, i) => out.push({ key: "r" + i, p }));
    out.push({ key: "rc", p: [(x0 + x1) / 2, (y0 + y1) / 2] });
    if (it.kind === "gr_rect") out.push({ key: "rr", p: [x1 - rectRadius(n), y0], circle: true });
    c.forEach((p, i) => { const q = c[(i + 1) % 4]; out.push({ key: "e" + i, p: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], circle: true }); });
  } else if (it.kind === "gr_circle") { const c = pt(n, "center"), e = pt(n, "end"); if (c) out.push({ key: "center", p: c }); if (e) out.push({ key: "end", p: e }); }
  else if (it.kind === "gr_arc") {   // ARC_START, ARC_MID, ARC_END, ARC_CENTER, with indicator lines from the centre to the ends
    for (const k of ["start", "mid", "end"]) { const p = pt(n, k); if (p) out.push({ key: k, p }); }
    const s = pt(n, "start"), m = pt(n, "mid"), e = pt(n, "end"), a = s && m && e ? K.arcFrom3(s, m, e) : null;
    if (a) { const c = [a.x, a.y]; out.push({ key: "center", p: c, lines: [s!, e!] }); }
  }
  return out;
}
// ---- EDA_ARC_POINT_EDIT_BEHAVIOR (common/tool/point_editor_behavior.cpp): an arc's start, mid, end and centre handles,
// and what dragging one does in each ARC_EDIT_MODE (Preferences > PCB Editor > Editing Options > Arc editing mode,
// the Arc toolbar group's menu, Cycle Arc Editing Mode Ctrl+Space).  0 keeps the centre and adjusts the radius, 1 keeps
// the endpoints (or the direction at the other end), 2 keeps the centre and the radius.
export const ARC_KEEP_CENTER = 0, ARC_KEEP_ENDPOINTS = 1, ARC_KEEP_RADIUS = 2;
export const ARC_EDIT_KEY = "kc.pcb.arcEditMode";
export const ARC_EDIT_ACTIONS = ["pointEditorArcKeepCenter", "pointEditorArcKeepEndpoint", "pointEditorArcKeepRadius"];
export function arcEditMode() {
  if (S.arcEditMode == null) { const v = lsGet(ARC_EDIT_KEY); S.arcEditMode = v !== null && /^[0-2]$/.test(v) ? +v : ARC_KEEP_CENTER; }
  return S.arcEditMode;
}
export function setArcEditMode(m: number) { S.arcEditMode = m; lsSet(ARC_EDIT_KEY, String(m)); }
/** IncrementArcEditMode: keep center -> keep center and radius -> keep endpoints -> keep center. */
export const nextArcEditMode = (m: number) => (m === ARC_KEEP_CENTER ? ARC_KEEP_RADIUS : m === ARC_KEEP_RADIUS ? ARC_KEEP_ENDPOINTS : ARC_KEEP_CENTER);
export const ARC_MIN_RADIUS = 0.0254;   // EDA_UNIT_UTILS::Mils2IU( 1 )
export const resized = (v: Pt, len: number) => { const l = Math.hypot(v[0], v[1]); return l ? [v[0] * len / l, v[1] * len / l] : [0, 0]; };
/** EDA_SHAPE with the board's winding: from start to end the polar angle grows; the mid is halfway (GetArcMid). */
export function arcFromCenter(c: Pt, s: Pt, e: Pt) {
  const r = Math.hypot(s[0] - c[0], s[1] - c[1]); const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
  let sw = Math.atan2(e[1] - c[1], e[0] - c[0]) - a0; while (sw <= 0) sw += 2 * Math.PI;
  return { start: s, mid: [c[0] + r * Math.cos(a0 + sw / 2), c[1] + r * Math.sin(a0 + sw / 2)], end: e };
}
/** The arc of `orig` with handle `key` dragged: `p` is the snapped cursor, `raw` the cursor itself (the mid handle uses it). */
export function arcEditGeometry(orig: SNode, key: string, p: Pt, raw: Pt, mode: number) {
  let s = pt(orig, "start")!, e = pt(orig, "end")!; const m = pt(orig, "mid")!; const a = s && m && e ? K.arcFrom3(s, m, e) : null; if (!a) return null;   // a missing point leaves no arc
  // the arc as pcbnew holds it (start to end with the polar angle growing); the handle stays the one under the cursor
  if (crossZ(m![0] - s![0], m![1] - s![1], e![0] - m![0], e![1] - m![1]) < 0) { [s, e] = [e, s]; if (key === "start" || key === "end") key = key === "start" ? "end" : "start"; }
  const c = [a.x, a.y];
  if (key === "center") {
    if (mode === ARC_KEEP_ENDPOINTS) {   // editArcCenterKeepEndpoints: the centre slides along the chord's bisector
      const mid = [(s![0] + e![0]) / 2, (s![1] + e![1]) / 2], n = resized([-(e![1] - s![1]), e![0] - s![0]], 1);
      const t = (p[0] - mid[0]) * n[0] + (p[1] - mid[1]) * n[1]; const nc = [mid[0] + n[0] * t, mid[1] + n[1] * t];
      return arcFromCenter(nc, s, e);
    }
    const d = [p[0] - c[0], p[1] - c[1]];   // both other modes move the arc
    return { start: vadd(s, d), mid: vadd(m, d), end: vadd(e, d) };
  }
  if (key === "mid") {
    if (mode === ARC_KEEP_ENDPOINTS) {   // editArcMidKeepEndpoints: on a ray from just off the chord's middle, out past the mid
      const ch = [(s![0] + e![0]) / 2, (s![1] + e![1]) / 2], v = vsub(m, ch), justOff = Math.hypot(s![0] - e![0], s![1] - e![1]) / 100;
      const A = vadd(ch, resized(v, justOff)), u = resized(v, 1); const t = Math.max(0, (raw[0] - A[0]) * u[0] + (raw[1] - A[1]) * u[1]);
      const nm = vadd(A, vmul(u, t)); if (Math.abs(crossZ(nm[0] - s![0], nm[1] - s![1], e![0] - s![0], e![1] - s![1])) < 1e-12) return null;
      return { start: s, mid: nm, end: e };
    }
    // KI_ARC_EDIT::EditArcMidKeepCenter: the radius follows the cursor, the ends stay on their rays
    const r = Math.max(ARC_MIN_RADIUS, Math.hypot(raw[0] - c[0], raw[1] - c[1]));
    return arcFromCenter(c, vadd(c, resized(vsub(s, c), r)), vadd(c, resized(vsub(e, c), r)));
  }
  if (key !== "start" && key !== "end") return null;
  const movingStart = key === "start";
  if (mode === ARC_KEEP_CENTER) {   // KI_ARC_EDIT::EditArcEndpointKeepCenter: the other end follows onto the new radius
    let p1 = vsub(p, c); const p2 = vsub(movingStart ? e : s, c);
    if (!p1[0] && !p1[1]) p1 = vsub(movingStart ? s : e, c);
    const r = Math.max(ARC_MIN_RADIUS, Math.hypot(p1[0], p1[1]));
    const n1 = vadd(c, resized(p1, r)), n2 = vadd(c, (p2[0] || p2[1]) ? resized(p2, r) : [r, 0]);
    return movingStart ? arcFromCenter(c, n1, n2) : arcFromCenter(c, n2, n1);
  }
  if (mode === ARC_KEEP_RADIUS) {   // editArcEndpointKeepCenterAndRadius: the end slides round the circle
    const n1 = vadd(c, resized(vsub(p, c), a.r));
    return movingStart ? arcFromCenter(c, n1, e) : arcFromCenter(c, s, n1);
  }
  // editArcEndpointKeepTangent: the other end and the tangent there stay; the centre moves along that end's radius
  const p1 = movingStart ? e : s, p2 = p, p3 = m;
  let v1 = vsub(p1, c), v2 = vsub(p2, c); const v3 = vsub(p3, c);
  if (!Math.hypot(v1[0], v1[1]) || !Math.hypot(v2[0], v2[1])) return null;
  const u1 = resized(v1, 1); let u2 = vsub(v3, vmul(u1, u1[0] * v3[0] + u1[1] * v3[1])); u2 = resized(u2, 1);
  const det = u1[0] * u2[1] - u2[0] * u1[1]; if (!det) return null;
  v1 = [(v1[0] * u2[1] - v1[1] * u2[0]) / det, (-v1[0] * u1[1] + v1[1] * u1[0]) / det];
  v2 = [(v2[0] * u2[1] - v2[1] * u2[0]) / det, (-v2[0] * u1[1] + v2[1] * u1[0]) / det];
  const R = Math.hypot(v1[0], v1[1]); if (v2[0] === R) return null;   // a straight line: nothing changes
  let flip = false; if (v2[0] > R) { flip = true; v2[0] = 2 * R - v2[0]; }
  const delta = (R * R - v2[0] * v2[0] - v2[1] * v2[1]) / (2 * v2[0] - 2 * R);
  if (Math.abs(v2[1] / (R - v2[0])) > 50 || !isFinite(delta)) return null;   // ADVANCED_CFG m_DrawArcCenterMaxAngle
  const v4 = flip ? [2 * R + delta, 0] : [-delta, 0];
  const nc = vadd(c, [v4[0] * u1[0] + v4[1] * u2[0], v4[0] * u1[1] + v4[1] * u2[1]]);
  return movingStart ? arcFromCenter(nc, p, e) : arcFromCenter(nc, s, p);
}
export const setXY = (node: SNode, key: string, p: Pt) => { const k = K.kid(node, key); if (k) { k[1] = r6(p[0]); k[2] = r6(p[1]); } };
/** The node with handle `key` moved to `p` (from the original node `orig`). */
/** The intersection of the lines through (a, a + u) and (b, b + v), or null when they are parallel (SEG::IntersectLines). */
export function lineX(a: Pt, u: Pt, b: Pt, v: Pt): Pt | null {
  const den = u[0] * v[1] - u[1] * v[0]; if (Math.abs(den) < 1e-12) return null;
  const t = ((b[0] - a[0]) * v[1] - (b[1] - a[1]) * v[0]) / den; return [a[0] + u[0] * t, a[1] + u[1] * t];
}
/** SEG::Intersect: where two segments cross (their ends included), or null. */
export function segX(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const u = vsub(b, a), v = vsub(d, c), den = u[0] * v[1] - u[1] * v[0]; if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * v[1] - (c[1] - a[1]) * v[0]) / den, k = ((c[0] - a[0]) * u[1] - (c[1] - a[1]) * u[0]) / den;
  return t >= -1e-9 && t <= 1 + 1e-9 && k >= -1e-9 && k <= 1 + 1e-9 ? [a[0] + u[0] * t, a[1] + u[1] * t] : null;
}
/** SEG::Angle: the acute angle between two segments' lines, in degrees (0..90). */
const lineAngle = (u: Pt, v: Pt) => { const a = Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180 / Math.PI; return a > 90 ? 180 - a : a; };
/**
 * POLYGON_EDGE_DRAG_POLICY: the dragged edge of a polygon or zone outline moves perpendicular to itself.  CONVERGING
 * (the default) keeps the two neighbouring edges on their lines, so the edge's corners slide along them (and meet at
 * most where those lines cross); FIXED_LENGTH (Ctrl) keeps the edge's length.  With the grid on the perpendicular
 * displacement is quantized to it (pcb_point_editor.cpp: "Quantize the perpendicular displacement directly").
 * Returns the new positions of the edge's two corners.
 */
export function polyEdgeDrag(pts: Pt[], i: number, pos: Pt, fixedLength: boolean, gridPitch: number, gridPitchY?: number): [Pt, Pt] {
  const n = pts.length, j = (i + 1) % n, origin = pts[i], end = pts[j], prev = pts[(i - 1 + n) % n], next = pts[(j + 1) % n];
  const originDir = vsub(origin, prev), endDir = vsub(end, next), dragged = vsub(end, origin);
  const center: Pt = [(origin[0] + end[0]) / 2, (origin[1] + end[1]) / 2], perp: Pt = [-dragged[1], dragged[0]];
  const len = Math.hypot(dragged[0], dragged[1]), triangle = n === 3;
  if (!len) return [origin.slice(), end.slice()];
  const originCollinear = lineAngle(dragged, originDir) < 10, endCollinear = lineAngle(dragged, endDir) < 10;
  const convergence = lineX(origin, originDir, end, endDir) || center;
  if (gridPitch > 0) {
    const u: Pt = [perp[0] / len, perp[1] / len], gy = gridPitchY && gridPitchY > 0 ? gridPitchY : gridPitch, step = Math.hypot(gridPitch * u[0], gy * u[1]);   // gridSize.x * perpUnit.x, gridSize.y * perpUnit.y
    if (step > 0) { const off = Math.round(((pos[0] - center[0]) * u[0] + (pos[1] - center[1]) * u[1]) / step) * step; pos = [center[0] + u[0] * off, center[1] + u[1] * off]; }
  }
  let nc = lineX(center, perp, pos, dragged) || pos;
  if (!fixedLength && !triangle) {
    const den = (convergence[0] - center[0]) * perp[0] + (convergence[1] - center[1]) * perp[1];
    if (Math.abs(den) > 1e-12 && ((nc[0] - center[0]) * perp[0] + (nc[1] - center[1]) * perp[1]) / den > 1) nc = convergence;
  }
  if (fixedLength) { const h: Pt = [dragged[0] / 2, dragged[1] / 2]; return [vsub(nc, h), vadd(nc, h)]; }
  if (originCollinear && endCollinear) {   // both neighbours run along the edge: the corners stay on that line
    const l = Math.hypot(originDir[0], originDir[1]) || 1, d: Pt = [originDir[0] / l, originDir[1] / l];
    const proj = (q: Pt): Pt => { const t = (q[0] - prev[0]) * d[0] + (q[1] - prev[1]) * d[1]; return [prev[0] + d[0] * t, prev[1] + d[1] * t]; };
    return [proj(origin), proj(end)];
  }
  let o = lineX(nc, dragged, prev, originDir) || origin.slice(), e = lineX(nc, dragged, next, endDir) || end.slice();
  if (!triangle) { const x = segX(e, next, o, prev); if (x) { o = x; e = x.slice(); } }
  return [o, e];
}
/**
 * The 45 / 90 degree limit of the line mode on a dragged handle (setAltConstraint: EDIT_RELATION::Angle45 / Angle90 on
 * get45DegConstrainer): a line's end is held to the other end, a circle's or an arc's handle to the centre, anything
 * else to where the handle was.
 */
export function constrainHandle(orig: SNode, kind: string, key: string, p: Pt, angle: string | undefined): Pt {
  if (angle !== "45" && angle !== "90") return p;
  if (kind === "dimension" || kind === "generated" || ELLIPSE_KINDS.has(kind) || kind === "image" || kind === "group" || kind === "pad" || /^[em]/.test(key) || key === "rr") return p;   // edge lines (an ellipse has no 45-degree constrainer) and the radius handle move on their own lines
  let ref: Pt | null = null;
  if (kind === "gr_line") ref = pt(orig, key === "start" ? "end" : "start");
  else if (kind === "gr_circle") ref = key === "center" ? null : pt(orig, "center");
  else if (kind === "gr_arc") { const s = pt(orig, "start"), m = pt(orig, "mid"), e = pt(orig, "end"), a = s && m && e ? K.arcFrom3(s, m, e) : null; ref = a && key !== "center" ? [a.x, a.y] : null; }
  if (!ref) { const h = editPoints({ kind, node: orig } as unknown as KItem).find((x) => x.key === key); ref = h ? h.p : null; }
  if (!ref) return p;
  const v = vsub(p, ref), sn = angle === "45" ? snap45(v) : snap90(v);
  return [r6(ref[0] + sn[0]), r6(ref[1] + sn[1])];
}
/** ZONE::UnFill on a zone node: the filled areas go and the fill is no longer marked done (ZONE_POINT_EDIT_BEHAVIOR::UpdateItem). */
export function unfillZoneNode(node: SNode) {
  for (let i = node.length - 1; i > 0; i--) if (Array.isArray(node[i]) && (node[i] as SNode)[0] === "filled_polygon") node.splice(i, 1);
  const fill = K.kid(node, "fill"); if (fill && fill[1] === "yes") fill.splice(1, 1);
  return node;
}
export function editPointNode(orig: SNode, kind: string, key: string, p: Pt, raw: Pt | null | undefined, grid: ((p: Pt) => Pt) | null | undefined, opts?: EditOpts) {
  if (kind === "dimension") return dimEditNode(orig, key, p, raw || p, (grid || null));
  if (ELLIPSE_KINDS.has(kind)) return ellipseEditNode(clone(orig), key, p);   // EDA_ELLIPSE_POINT_EDIT_BEHAVIOR::UpdateItem
  if (kind === "pad") return padEditNode(orig, key, p);
  if (kind === "image") { const pe = S.pedit; return imageEditNode(orig, key, p, pe && pe.imgOff0 && pe.kind === "image" ? pe.imgOff0 as Pt : imageOriginOffset(orig)); }
  p = constrainHandle(orig, kind, key, p, opts && !opts.ctrl ? opts.angle : undefined);
  if (kind === "gr_arc") {
    const g = arcEditGeometry(orig, key, p, raw || p, arcEditMode()); if (!g) return clone(orig);
    const node = clone(orig), cw = crossZ(g.mid[0] - g.start[0], g.mid[1] - g.start[1], g.end[0] - g.mid[0], g.end[1] - g.mid[1]) >= 0;
    setXY(node, "start", cw ? g.start : g.end); setXY(node, "mid", g.mid); setXY(node, "end", cw ? g.end : g.start);
    return node;
  }
  const node = clone(orig);
  if (kind === "zone" || kind === "gr_poly") {
    const loc = peLocate(node, +key.slice(1)); if (!loc) return node;
    const xs = K.kids(loc.node, "xy"), nn = xs.length, i = loc.index;
    if (kind === "zone") unfillZoneNode(node);   // m_zone.UnFill()
    if (key[0] === "c") { xs[i][1] = r6(p[0]); xs[i][2] = r6(p[1]); }
    else {   // an edge line: POLYGON_EDGE_DRAG_POLICY (converging, Ctrl: fixed length) from the cursor itself
      const j = (i + 1) % nn;
      const [a, b] = polyEdgeDrag(loc.pts, i, raw || p, !!(opts && opts.ctrl), grid && opts && opts.gridPitch ? opts.gridPitch : 0, grid && opts && opts.gridPitchY ? opts.gridPitchY : 0);
      xs[i][1] = r6(a[0]); xs[i][2] = r6(a[1]); xs[j][1] = r6(b[0]); xs[j][2] = r6(b[1]);
    }
  } else if (kind === "gr_line") setXY(node, key, p);
  else if (kind === "gr_curve") {   // EDA_BEZIER_POINT_EDIT_BEHAVIOR::UpdateItem: the dragged point alone
    const pn = K.kid(node, "pts"), xs = pn ? K.kids(pn, "xy") : [], i = +key.slice(1);
    if (xs[i]) { xs[i][1] = r6(p[0]); xs[i][2] = r6(p[1]); }
  }
  else if (kind === "gr_rect" || kind === "gr_text_box" || kind === "barcode") {
    // RECTANGLE_POINT_EDIT_BEHAVIOR::UpdateItem after PinEditedCorner: a corner or an edge never crosses the
    // opposite one (one mil stays between them), the centre moves the rectangle, the radius handle rounds it
    const r0 = peRect(orig, kind); if (!r0) return node;
    let [L, T, R, B] = r0; let radius = rectRadius(orig);
    ({ r0: () => { L = Math.min(p[0], R - RECT_MIN); T = Math.min(p[1], B - RECT_MIN); }, r1: () => { R = Math.max(p[0], L + RECT_MIN); T = Math.min(p[1], B - RECT_MIN); },
      r2: () => { R = Math.max(p[0], L + RECT_MIN); B = Math.max(p[1], T + RECT_MIN); }, r3: () => { L = Math.min(p[0], R - RECT_MIN); B = Math.max(p[1], T + RECT_MIN); },
      e0: () => { T = Math.min(p[1], B - RECT_MIN); }, e1: () => { R = Math.max(p[0], L + RECT_MIN); }, e2: () => { B = Math.max(p[1], T + RECT_MIN); }, e3: () => { L = Math.min(p[0], R - RECT_MIN); },
      rc: () => { const dx = p[0] - (L + R) / 2, dy = p[1] - (T + B) / 2; L += dx; R += dx; T += dy; B += dy; },
      rr: () => { const maxR = Math.min(R - L, B - T) / 2; radius = R - Math.max(R - maxR, Math.min(R, p[0])); } } as Record<string, () => void>)[key]?.();
    if (kind === "barcode") {   // BARCODE_POINT_EDIT_BEHAVIOR: the centre and the size (turned back by the barcode's angle)
      const at = K.kid(node, "at")!, sz = K.kid(node, "size")!, ang = ((K.num(at[3], 0) % 360) + 360) % 360;
      at[1] = r6((L + R) / 2); at[2] = r6((T + B) / 2);
      const w = R - L, h = B - T; sz[1] = r6(ang % 180 ? h : w); sz[2] = r6(ang % 180 ? w : h);
      return node;
    }
    // setLeft / setRight / setTop / setBottom under SwapX / SwapY: the start and the end keep their sides
    const a = pt(orig, "start")!, b = pt(orig, "end")!, sx = a[0] > b[0], sy = a[1] > b[1];
    setXY(node, "start", [sx ? R : L, sy ? B : T]); setXY(node, "end", [sx ? L : R, sy ? T : B]);
    if (key === "rr") {
      const rn = K.kid(node, "radius");
      if (radius > 0) { if (rn) rn[1] = r6(radius); else node.splice(node.indexOf(K.kid(node, "end")!) + 1, 0, ["radius", r6(radius)]); }
      else if (rn) node.splice(node.indexOf(rn), 1);
    }
  } else if (kind === "gr_circle") {
    if (key === "center") { const c = pt(orig, "center"), e = pt(orig, "end"); setXY(node, "center", p); setXY(node, "end", [e![0] + p[0] - c![0], e![1] + p[1] - c![1]]); }
    else setXY(node, "end", p);
  }
  return node;
}
/** The one selected item's id (the module's own selection or the app's), or null. */
export function peSingleId(ctx?: PcbCtx) {
  const c = ctx || lastCtx; const ids = c && c.doc ? selectionIds(c) : S.sel;
  if (c && c.doc && ids.size > 1) { const gen = selectedTuningPattern(c, ids); if (gen) return gen.id; }   // a selected pattern is one generator
  return ids.size === 1 ? ids.values().next().value : null;
}
/** The handle of the single selected editable item within `tol` mm of (x, y), or null. */
export function editHandleAt(doc: BoardDoc, x: number, y: number, tol: number) {
  const id = peSingleId(); const it = id ? doc.items.get(id) : null; if (!it || isLocked(it.node)) return null;
  const best = findEditHandle(editPoints(it), x, y, tol);
  return best ? { it, h: best } : null;
}
/** An edge line's handle (EDIT_LINE, at the edge's middle): a polygon's "m<i>", a rectangle's "e<i>". */
const isEditLine = (key: string) => /^[em]\d+$/.test(key);
/**
 * EDIT_POINTS::FindPoint (edit_points.cpp 33-70): the first point whose POINT_SIZE square holds the cursor
 * (EDIT_POINT::WithinPoint, strictly inside on each axis), and only then the first edge line.
 */
export function findEditHandle(pts: EditPoint[], x: number, y: number, size: number): EditPoint | null {
  const within = (h: EditPoint) => Math.abs(h.p[0] - x) < size && Math.abs(h.p[1] - y) < size;
  return pts.find((h) => !isEditLine(h.key) && within(h)) || pts.find((h) => isEditLine(h.key) && within(h)) || null;
}
/**
 * PCB_POINT_EDITOR::addCorner: a corner on the zone / polygon side nearest the cursor (holes included; at the side's
 * middle when the nearest point is one of its ends), or a line or an arc split there.
 */
export function addCornerChanges(doc: BoardDoc, id: string, at: Pt) {
  const it = doc.items.get(id); if (!it) return [];
  if (it.kind === "zone" || it.kind === "gr_poly") {
    const node = clone(it.node);
    let best: { pn: SNode; i: number; a: Pt; b: Pt } | null = null, bd = Infinity;
    for (const pn of peContours(node)) {
      const pts = ptsOfList(pn); if (pts.length < 2) continue;
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; const q = closestOnSeg(at, a, b); const d = Math.hypot(q[0] - at[0], q[1] - at[1]); if (d < bd) { bd = d; best = { pn, i, a, b }; } }
    }
    if (!best) return [];
    let q = closestOnSeg(at, best.a, best.b).map(r6);
    if (samePt(q, best.a) || samePt(q, best.b)) q = [r6((best.a[0] + best.b[0]) / 2), r6((best.a[1] + best.b[1]) / 2)];   // never a duplicate of a corner
    const xs = K.kids(best.pn, "xy");
    best.pn.splice(best.pn.indexOf(xs[best.i]) + 1, 0, ["xy", q[0], q[1]]);
    return [replacedChange(it, node)];
  }
  if (it.kind === "gr_line") {   // the segment splits in two at the cursor's projection
    const a = pt(it.node, "start")!, b = pt(it.node, "end")!; const q = closestOnSeg(at, a, b); if (samePt(q, a) || samePt(q, b)) return [];
    const first = clone(it.node); setXY(first, "end", q);
    const second = clone(it.node); setXY(second, "start", q); const u = K.kid(second, "uuid"); if (u) u[1] = K.newUuid ? K.newUuid() : u[1] + "-1";
    return [replacedChange(it, first), addedChange(doc, second)];
  }
  if (it.kind === "gr_arc") {   // "Split Arc": the arc ends at the nearest point on it and a second arc runs on to the old end
    const s = pt(it.node, "start"), m = pt(it.node, "mid"), e = pt(it.node, "end"), a = s && m && e ? K.arcFrom3(s, m, e) : null; if (!a) return [];
    const c: Pt = [a.x, a.y], ang = (q: Pt) => Math.atan2(q[1] - c[1], q[0] - c[0]);
    // the sweep from the start through the mid to the end, signed
    const norm = (x: number) => { while (x <= -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; };
    const d1 = norm(ang(m!) - ang(s!)), d2 = norm(ang(e!) - ang(m!)), sweep = d1 + d2, a0 = ang(s!);
    let t = norm(ang(at) - a0); if (sweep > 0 && t < 0) t += 2 * Math.PI; if (sweep < 0 && t > 0) t -= 2 * Math.PI;
    if (Math.abs(t) >= Math.abs(sweep)) {   // off the arc: SHAPE_ARC::NearestPoint is the nearer end
      t = Math.hypot(at[0] - s![0], at[1] - s![1]) <= Math.hypot(at[0] - e![0], at[1] - e![1]) ? 0 : sweep;
    }
    if (Math.abs(t) < 1e-9 || Math.abs(t - sweep) < 1e-9) return [];
    const on = (x: number): Pt => [r6(c[0] + a.r * Math.cos(a0 + x)), r6(c[1] + a.r * Math.sin(a0 + x))];
    const q = on(t), first = clone(it.node), second = clone(it.node);
    setXY(first, "start", s!); setXY(first, "mid", on(t / 2)); setXY(first, "end", q);
    setXY(second, "start", q); setXY(second, "mid", on((t + sweep) / 2)); setXY(second, "end", e!);
    const u = K.kid(second, "uuid"); if (u) u[1] = K.newUuid ? K.newUuid() : u[1] + "-1";
    return [replacedChange(it, first), addedChange(doc, second)];
  }
  return [];
}
/** The commit label of addCorner: "Add Zone Corner" for outlines, "Split Segment" / "Split Arc" for a line or an arc. */
export const addCornerLabel = (it: KItem | undefined) => (it && it.kind === "gr_line" ? "Split Segment" : it && it.kind === "gr_arc" ? "Split Arc" : "Add Zone Corner");
/** PCB_POINT_EDITOR::CanAddCorner: zones, polygons, plain lines and arcs. */
export function canAddCorner(it: KItem) { return !!it && (it.kind === "zone" || it.kind === "gr_poly" || it.kind === "gr_line" || it.kind === "gr_arc"); }
/** The corner of a zone / polygon (any contour) within tol of a point, as its flat index, or -1. */
export function cornerAt(node: SNode, at: Pt, tol: number) {
  let bi = -1, bd = tol, g = 0;
  for (const pn of peContours(node)) for (const p of ptsOfList(pn)) { const d = Math.max(Math.abs(p[0] - at[0]), Math.abs(p[1] - at[1])); if (d <= bd) { bd = d; bi = g; } g++; }
  return bi;
}
/**
 * PCB_POINT_EDITOR::CanRemoveCorner: a corner of a zone or polygon under the cursor; the main outline must keep
 * three, a hole may lose them all (it is removed with its last corners).
 */
export function canRemoveCorner(doc: BoardDoc, id: string, at: Pt) {
  const it = doc.items.get(id); if (!it || (it.kind !== "zone" && it.kind !== "gr_poly")) return false;
  if (!at) return pePolyPts(it.node).length > 3 || peContours(it.node).length > 1;
  return removeCornerChanges(doc, id, at, handleTol()).length > 0;
}
export function closestOnSeg(p: Pt, a: Pt, b: Pt) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; if (!L) return a.slice(); const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)); return [a[0] + t * dx, a[1] + t * dy]; }
/**
 * PCB_POINT_EDITOR::removeCorner: the zone / polygon corner under the cursor goes while its contour keeps three;
 * a hole down to three corners is removed whole (RemoveContour).
 */
export function removeCornerChanges(doc: BoardDoc, id: string, at: Pt, tol: number) {
  const it = doc.items.get(id); if (!it || (it.kind !== "zone" && it.kind !== "gr_poly")) return [];
  const g = cornerAt(it.node, at, tol); if (g < 0) return [];
  const node = clone(it.node), loc = peLocate(node, g)!;
  if (loc.pts.length > 3) loc.node.splice(loc.node.indexOf(K.kids(loc.node, "xy")[loc.index]), 1);
  else if (loc.contour > 0) { const pg = K.kids(node, "polygon")[loc.contour]; node.splice(node.indexOf(pg), 1); }
  else return [];
  return [replacedChange(it, node)];
}
/** The commit label of removeCorner / chamferCorner by item. */
export const removeCornerLabel = (it: KItem | undefined) => (it && it.kind === "zone" ? "Remove Zone Corner" : "Remove Polygon Corner");
export const chamferCornerLabel = (it: KItem | undefined) => (it && it.kind === "zone" ? "Break Zone Corner" : "Break Polygon Corner");
/**
 * PCB_POINT_EDITOR::chamferCorner: the corner nearest the cursor (holes included) is replaced by two, set back along
 * its two sides by min( 5 mm, a quarter of each side ) (ComputeChamferPoints with equal setbacks, in nm as there).
 */
export function chamferCornerChanges(doc: BoardDoc, id: string, at: Pt) {
  const it = doc.items.get(id); if (!it || (it.kind !== "zone" && it.kind !== "gr_poly")) return [];
  const node = clone(it.node);
  let g = -1, bd = Infinity, k = 0;
  for (const pn of peContours(node)) for (const p of ptsOfList(pn)) { const d = Math.hypot(p[0] - at[0], p[1] - at[1]); if (d < bd) { bd = d; g = k; } k++; }
  const loc = g < 0 ? null : peLocate(node, g); if (!loc || loc.pts.length < 3) return [];
  const n = loc.pts.length, c = loc.pts[loc.index], prev = loc.pts[(loc.index - 1 + n) % n], next = loc.pts[(loc.index + 1) % n];
  const la = Math.hypot(prev[0] - c[0], prev[1] - c[1]), lb = Math.hypot(next[0] - c[0], next[1] - c[1]);
  const setback = Math.min(5e6, Math.trunc(la * 1e6 * 0.25), Math.trunc(lb * 1e6 * 0.25)) / 1e6;
  if (!(setback > 0)) return [];   // "No chamfer to do"
  const along = (to: Pt, l: number): Pt => [r6(c[0] + (to[0] - c[0]) * setback / l), r6(c[1] + (to[1] - c[1]) * setback / l)];
  const pa = along(prev, la), pb = along(next, lb);
  if (samePt(pa, prev) || samePt(pb, next)) return [];   // m_updated_seg_a / _b missing: nothing is done
  const xs = K.kids(loc.node, "xy"), at0 = loc.node.indexOf(xs[loc.index]);
  loc.node.splice(at0, 1, ["xy", pa[0], pa[1]], ["xy", pb[0], pb[1]]);
  if (it.kind === "zone") unfillZoneNode(node);   // SetNeedRefill
  return [replacedChange(it, node)];
}
/** The handle a "Move Corner to Location" would move: the one under the cursor, a corner or an edge line's midpoint. */
export function movePointTitle(key: string) { return /^[em]\d/.test(key) ? { title: "Move Midpoint to Location", label: "Move Midpoint" } : { title: "Move Corner to Location", label: "Move Corner" }; }
/** PCB_POINT_EDITOR::movePoint after the dialog: the handle set to the entered position, the item updated (no grid, no angle limit). */
export function movePointChanges(doc: BoardDoc, id: string, key: string, to: Pt) {
  const it = doc.items.get(id); if (!it || !PE_KINDS.has(it.kind)) return [];
  if (it.kind === "group") {
    const shapes = groupShapeItems(doc, it), box = shapes && groupShapesBox(shapes); if (!shapes || !box) return [];
    const nodes = groupEditNodes(new Map(shapes.map((m) => [m.id, m.node])), box, key, to);
    return shapes.filter((m) => K.serialize(nodes.get(m.id)!) !== K.serialize(m.node)).map((m) => replacedChange(m, nodes.get(m.id)!));
  }
  const node = editPointNode(it.node, it.kind, key, to, to, null);
  return K.serialize(node) === K.serialize(it.node) ? [] : [replacedChange(it, node)];
}
export const handleTol = () => EDIT_POINT_PX * (S.mmPerPx || 0.05);   // EDIT_POINT::POINT_SIZE, in mm at this zoom
/**
 * snapCorner: the point on the circle through `prev` and `next` on which the corner angle is `angleDeg` (inscribed
 * angle theorem), of the two such circles the one nearer the guess.
 */
export function snapCorner(prev: Pt, next: Pt, guess: Pt, angleDeg: number): Pt {
  const a = angleDeg * Math.PI / 180, chord = Math.hypot(next[0] - prev[0], next[1] - prev[1]), sinA = Math.sin(a);
  if (chord === 0 || Math.abs(sinA) < 1e-9) return guess;
  const radius = chord / (2 * sinA), mid: Pt = [(prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2], dir = [next[0] - prev[0], next[1] - prev[1]];
  const nl = Math.hypot(dir[0], dir[1]), normal = [-dir[1] / nl, dir[0] / nl];
  const hsq = radius * radius - chord * chord / 4, hh = hsq > 0 ? Math.sqrt(hsq) : 0;
  const project = (c: Pt): Pt => {
    let v = [guess[0] - c[0], guess[1] - c[1]]; if (Math.hypot(v[0], v[1]) === 0) v = [prev[0] - c[0], prev[1] - c[1]];
    const L = Math.hypot(v[0], v[1]) || 1; return [r6(c[0] + v[0] / L * radius), r6(c[1] + v[1] / L * radius)];
  };
  const p1 = project([mid[0] + normal[0] * hh, mid[1] + normal[1] * hh]), p2 = project([mid[0] - normal[0] * hh, mid[1] - normal[1] * hh]);
  return Math.hypot(guess[0] - p1[0], guess[1] - p1[1]) < Math.hypot(guess[0] - p2[0], guess[1] - p2[1]) ? p1 : p2;
}
/** SEG::Angle( aOther ): the absolute angle between the two segments' directions (A - B), in degrees, 0 to 180. */
export function segAngleDeg(a0: Pt, a1: Pt, b0: Pt, b1: Pt): number {
  const n180 = (d: number) => { while (d <= -180) d += 360; while (d > 180) d -= 360; return d; };
  const t = n180(Math.atan2(a0[1] - a1[1], a0[0] - a1[0]) * 180 / Math.PI), o = n180(Math.atan2(b0[1] - b1[1], b0[0] - b1[0]) * 180 / Math.PI);
  return Math.abs(n180(t - o));
}
/**
 * PCB_POINT_EDITOR's sticky angle snap (m_angleSnapActive / m_angleSnapPos): dragging a corner of a polygon or zone
 * (more than two corners, Shift not held) to within 2 degrees of a multiple of 45 between its neighbours puts it where
 * the angle is exact (snapCorner; through the grid when that keeps the angle within 2 degrees), and keeps it there
 * until the cursor moves 5 px away or Shift is pressed.  The neighbours are the previous and next corners in the
 * point list (contours one after the other).  Returns the held corner, or null to snap as usual.
 */
export function stickyCornerSnap(ctx: PcbCtx, pe: NonNullable<typeof S.pedit>, mm: Pt, mods: { ctrlKey: boolean; shiftKey: boolean }): Pt | null {
  const as = pe.angleSnap as Pt | null | undefined;
  if (as) {
    const limit = 5 * (S.mmPerPx || 1 / Math.max(1e-6, ctx.pxPerMm || 4));
    if (Math.hypot(mm[0] - as[0], mm[1] - as[1]) > limit || mods.shiftKey) pe.angleSnap = null; else return as;
  }
  if ((pe.kind !== "zone" && pe.kind !== "gr_poly") || mods.shiftKey) return null;
  const m = /^c(\d+)$/.exec(pe.key); if (!m) return null;
  const corners: Pt[] = []; for (const pn of peContours(pe.orig)) corners.push(...ptsOfList(pn));
  const n = corners.length, idx = +m[1]; if (n <= 2 || idx >= n) return null;
  const prev = corners[(idx + n - 1) % n], next = corners[(idx + 1) % n], pos = mm;
  const ang = segAngleDeg(pos, prev, pos, next), snapAng = 45 * Math.round(ang / 45);
  if (Math.abs(ang - snapAng) >= 2) return null;
  let snapped = snapCorner(prev, next, pos, snapAng);
  // SNAP_TO_GRID and grid.GetSnap(): through ResolveSnap, kept only when that holds the angle
  const gridded = snapCursor(ctx, snapped, new Set([pe.id]), mods, null).p;
  snapped = Math.abs(segAngleDeg(gridded, prev, gridded, next) - snapAng) < 2 ? gridded : pos;
  if (Math.abs(snapped[0] - pos[0]) < 1e-6 && Math.abs(snapped[1] - pos[1]) < 1e-6) return null;
  pe.angleSnap = [snapped[0], snapped[1]];
  return pe.angleSnap as Pt;
}
export function onHandlePointerDown(ev: PointerEvent) {
  const ctx = lastCtx; if (!ctx || !isBoardLikeDoc() || ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey || appTool() !== "select") return;
  if (S.route || S.draw || S.drag || S.move || S.pedit || ctx.viewOnly) return;
  const stage = ctx.stage; if (!stage || !(ev.target instanceof Element) || !stage.contains(ev.target) || ev.target.closest("#cmtPanel")) return;
  const doc = liveDoc(); if (!doc) return; const mm = ctx.worldMm(ev);
  const hit = editHandleAt(doc, mm[0], mm[1], handleTol()); if (!hit) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  startHandleEdit(ctx, doc, hit, mm);
  try { stage.setPointerCapture(ev.pointerId!); } catch (e) { /* synthetic event */ }
}
/** The point editor's drag of one handle, from the press at mm (a Shift press the block gesture handed back too). */
export function startHandleEdit(ctx: PcbCtx, doc: BoardDoc, hit: { it: KItem; h: EditPoint }, mm: Pt) {
  S.peditCtrl = false;
  S.pedit = { id: hit.it.id, kind: hit.it.kind, key: hit.h.key, orig: clone(hit.it.node), start: mm, moved: false, ignoreGrid: !!(hit.h as { ignoreGrid?: boolean }).ignoreGrid };
  if (hit.it.kind === "image") S.pedit.imgOff0 = imageOriginOffset(hit.it.node);   // the transform origin as the drag begins
  if (hit.it.kind === "group") {   // the shapes and their box as the drag begins
    const shapes = groupShapeItems(doc, hit.it)!; S.pedit.groupOrigs = new Map(shapes.map((m) => [m.id, clone(m.node)])); S.pedit.groupBox = groupShapesBox(shapes); S.pedit.groupInfl = bboxHandleInflation();
  }
  if (isTuningPattern(hit.it)) genStartEdit(ctx, hit.it);   // PCB_POINT_EDITOR: genStartEdit
}
export function editHandleMove(ctx: PcbCtx, mm: Pt, ev?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } | null) {
  if (ev) { S.peditCtrl = !!(ev.ctrlKey || ev.metaKey); S.peditShift = !!ev.shiftKey; }
  const pe = S.pedit; if (!pe) return; const it = ctx.doc.items.get(pe.id); if (!it) { S.pedit = null; return; }
  if (!pe.moved && Math.hypot(mm[0] - pe.start[0], mm[1] - pe.start[1]) < 1e-3) return;
  // the drag starts: a clone of the item as it was is the persistent construction geometry (pcb_point_editor.cpp)
  if (!pe.moved && !pe.ignoreGrid && pe.kind !== "generated") proposePersistentConstruction(Object.assign({}, it, { node: clone(pe.orig) }) as KItem);
  const mods = { ctrlKey: !!S.peditCtrl, shiftKey: !!S.peditShift };
  let p: Pt;
  if (pe.ignoreGrid) { p = mm; pe.snapAt = null; }   // the amplitude and spacing handles ignore the grid
  else {
    // the sticky 45 degree corner of a polygon or zone: held while the cursor stays within 5 px of it, else found again
    const st = stickyCornerSnap(ctx, pe, mm, mods);
    if (st) { p = st; pe.snapAt = null; }
    else { const sn = snapCursor(ctx, [mm[0], mm[1]], new Set([pe.id]), mods, null); p = sn.p; pe.snapAt = sn.anchor; }   // grid.ResolveSnap( pos, snapLayers, grid, { item } )
  }
  if (pe.kind === "generated") { pe.moved = true; pe.node = tuningEditNode(pe.orig, pe.key, p); genUpdateEdit(ctx, pe.node); return; }   // genUpdateEdit: re-tuned live
  if (pe.kind === "group") {   // the shapes follow live
    pe.moved = true; const nodes = groupEditNodes(pe.groupOrigs as Map<string, SNode>, pe.groupBox as [number, number, number, number], pe.key, p, (pe.groupInfl as number) || 0); pe.groupNodes = nodes;
    for (const [id, n] of nodes) { const m = ctx.doc.items.get(id); if (m) { m.node.length = 0; m.node.push(...clone(n)); K.replaceChange(ctx.doc, m); } }
    ctx.requestRender(); return;
  }
  // the line mode's 45 / 90 limit unless Ctrl is held; Ctrl on a polygon edge keeps its length
  pe.moved = true; pe.node = editPointNode(pe.orig, pe.kind, pe.key, p, mm, ctx.snapOn && ctx.snap ? ctx.snap : null, { ctrl: !!S.peditCtrl, gridPitch: ctx.snapOn ? ctx.gridPitch || 0 : 0, gridPitchY: ctx.snapOn ? ctx.gridPitchY || ctx.gridPitch || 0 : 0, angle: angleSnapMode() });
  it.node.length = 0; it.node.push(...clone(pe.node!)); K.replaceChange(ctx.doc, it); ctx.requestRender();
}
export function editHandleUp(ctx: PcbCtx, commit: boolean) {
  const pe = S.pedit; S.pedit = null; if (!pe) return;
  if (commit && !pe.moved) blockClick(ctx, pe.start, false);   // IsClick on a handle: pickHandleAt (a click on nothing pickable drops the picks)
  clearConstruction(); setReferenceOnlyPoints([]); S.snapItem = null;   // the drag's grid helper and its construction geometry end with it
  const it = ctx.doc.items.get(pe.id); if (!it) { genCancelEdit(ctx); return; }
  if (pe.kind === "generated") { if (commit && pe.moved) genFinishEdit(ctx); else genCancelEdit(ctx); return; }   // genFinishEdit: "Edit Tuning Pattern"
  if (pe.kind === "group") {   // the originals back first, then one "Move Point" over the changed shapes
    const origs = pe.groupOrigs as Map<string, SNode>, nodes = pe.groupNodes as Map<string, SNode> | undefined, changes = [];
    for (const [id, n] of origs) { const m = ctx.doc.items.get(id); if (m) { m.node.length = 0; m.node.push(...clone(n)); K.replaceChange(ctx.doc, m); } }
    if (commit && pe.moved && nodes) for (const [id, n] of nodes) { const m = ctx.doc.items.get(id); if (m && K.serialize(n) !== K.serialize(m.node)) changes.push(replacedChange(m, n)); }
    if (changes.length) ctx.commit(changes, "Move Point");
    ctx.requestRender(); return;
  }
  it.node.length = 0; it.node.push(...clone(pe.orig)); K.replaceChange(ctx.doc, it);   // the original back first: commit records the inverse
  if (pe.kind === "image" && pe.imgOff0 && !(commit && pe.moved)) setImageOriginOffset(pe.orig, pe.imgOff0 as Pt);   // a cancelled drag keeps the old origin
  if (commit && pe.moved && pe.node && K.serialize(pe.node) !== K.serialize(pe.orig)) ctx.commit([replacedChange(it, pe.node)], "Move Point");
  ctx.requestRender();
}
export function drawEditPoints(c: CanvasRenderingContext2D, ctx: PcbCtx, px: number) {
  if (S.route || S.draw || S.drag || S.move || S.modTool) return;
  const id = peSingleId(ctx); const ge = S.genEdit as GenEdit | null | undefined;
  const it = id ? (ge && ge.id === id && ge.fin && ge.fin.items.get(id)) || ctx.doc.items.get(id) : null; if (!it || isLocked(it.node)) return; const hs = editPoints(it); if (!hs.length) return;
  const cur = ctx.cursor || null; const size = EDIT_POINT_PX / 2 * px;   // POINT_SIZE / 2
  // EDIT_POINTS::ViewDraw: LAYER_AUX_ITEMS (inverted when too close to the background), its border and highlight shades;
  // the hovered or active point stroked HOVER_SIZE in the highlight shade, a picked one filled with it too; an edge
  // line's centre handle shows a state only with block anchor editing on (m_lineStateVisible)
  const { fill, border, highlight } = editPointColors(auxItemsColor(), K.PCB_BG || "#001023");
  const hotKey = S.pedit ? S.pedit.key : (cur ? ((editHandleAt(ctx.doc, cur[0], cur[1], handleTol()) || {}).h || {}).key : null);
  // block anchor editing: picked handles drawn selected, and an edge line's centre shows its state (SetLineStateVisible)
  const picked = blockPickedKeys(it.id), lineState = blockAnchorEditingEnabled();
  c.save(); c.globalAlpha = 1; c.setLineDash([]);
  for (const h of hs) if (h.lines) { c.lineWidth = EDIT_BORDER_PX / 4 * px; c.strokeStyle = border; for (const q of h.lines) line(c, h.p, q); }   // EDIT_POINTS' indicator lines
  for (const h of hs) {
    const showState = lineState || !isEditLine(h.key), sel = showState && picked.has(h.key), on = showState && h.key === hotKey;
    c.lineWidth = (sel || on ? EDIT_HOVER_PX : EDIT_BORDER_PX) * px; c.strokeStyle = sel || on ? highlight : border; c.fillStyle = sel ? highlight : fill;
    c.beginPath(); if (h.circle) c.arc(h.p[0], h.p[1], size, 0, Math.PI * 2); else c.rect(h.p[0] - size, h.p[1] - size, 2 * size, 2 * size);
    c.fill(); c.stroke();
  }
  c.restore();
}

// pcb-tools/pcb-constraint.ts — geometric constraints (pcbnew/constraints/pcb_constraint.cpp and constraint_builder.cpp):
// the PCB_CONSTRAINT model and its (constraint …) node as PCB_IO_KICAD_SEXPR writes and parses it, the board as the
// constraint code sees it (shapes, dimensions and pads by uuid, in IU), and the builder: BuildConstraintFromItems,
// the selection hints, the anchors of an item, the nearest anchor / outline, the endpoint bindings of a drawn dimension
// or shape, the draw-time automatic constraints and the dimension value modes (driving dimensions).
import type { BoardDoc, Pt } from "./types";
import { K } from "./state";
import { isLocked } from "./groups";
import { rotator } from "./util";

export type ConstraintType = "coincident" | "horizontal" | "vertical" | "parallel" | "perpendicular" | "collinear" | "symmetric" | "equal_length" | "equal_radius"
  | "point_on_line" | "midpoint" | "fixed_position" | "fixed_length" | "concentric" | "fixed_radius" | "angular_dimension" | "tangent" | "arc_angle" | "undefined";
export type ConstraintAnchor = "whole" | "start" | "end" | "mid" | "center" | "radius" | "vertex";
/** CONSTRAINT_MEMBER: an item, the anchor on it, and a vertex ordinal (-1 for every other anchor). */
export interface CMember { item: string; anchor: ConstraintAnchor; index: number }
/** PCB_CONSTRAINT: lengths in IU (written in mm), angles in degrees; driving true unless (driving no). */
export interface PcbConstraint { id: string; type: ConstraintType; members: CMember[]; value: number | null; driving: boolean; node: SNode | null }

/** PCB_CONSTRAINT_TYPE in enum order (ConstraintTypeFromToken walks it). */
export const CONSTRAINT_TYPES: ConstraintType[] = ["undefined", "coincident", "horizontal", "vertical", "parallel", "perpendicular", "collinear", "symmetric", "equal_length", "equal_radius",
  "point_on_line", "midpoint", "fixed_position", "fixed_length", "concentric", "fixed_radius", "angular_dimension", "tangent", "arc_angle"];
const ANCHORS: ConstraintAnchor[] = ["whole", "start", "end", "mid", "center", "radius", "vertex"];
export const IU_PER_MM = 1e6;

export const constraintTypeFromToken = (t: string): ConstraintType => (CONSTRAINT_TYPES.includes(t as ConstraintType) ? t as ConstraintType : "undefined");
export const constraintAnchorFromToken = (t: string): ConstraintAnchor => (ANCHORS.includes(t as ConstraintAnchor) ? t as ConstraintAnchor : "whole");
/** ConstraintValueIsLength: the value is a length (IU) rather than an angle. */
export const constraintValueIsLength = (t: ConstraintType): boolean => t === "fixed_length" || t === "fixed_radius";
export const CONSTRAINT_GLYPHS: Record<ConstraintType, string> = { coincident: "●", horizontal: "↔", vertical: "↕", parallel: "∥", perpendicular: "⊥", collinear: "─", symmetric: "⧓",
  equal_length: "=", equal_radius: "⊜", point_on_line: "∈", midpoint: "½", fixed_position: "⌖", fixed_length: "⟷", concentric: "◎", fixed_radius: "r", angular_dimension: "∠",
  tangent: "T", arc_angle: "α", undefined: "" };
export const CONSTRAINT_LABELS: Record<ConstraintType, string> = { coincident: "Coincident", horizontal: "Horizontal", vertical: "Vertical", parallel: "Parallel", perpendicular: "Perpendicular",
  collinear: "Collinear", symmetric: "Symmetric", equal_length: "Equal length", equal_radius: "Equal radius", point_on_line: "Point on line", midpoint: "Midpoint",
  fixed_position: "Fixed position", fixed_length: "Fixed length", concentric: "Concentric", fixed_radius: "Fixed radius", angular_dimension: "Angular dimension", tangent: "Tangent",
  arc_angle: "Arc angle", undefined: "Undefined" };
/** ConstraintAnchorLabel. */
export const anchorLabel = (a: ConstraintAnchor): string => (a === "whole" ? "" : a);
export const sameMember = (a: CMember, b: CMember): boolean => a.item === b.item && a.anchor === b.anchor && a.index === b.index;
export const member = (item: string, anchor: ConstraintAnchor, index = -1): CMember => ({ item, anchor, index });

/** FormatDouble2Str. */
export function formatDouble2(v: number): number {
  if (v !== 0 && Math.abs(v) <= 0.0001) return Number(v.toFixed(16));
  const r = Number(v.toPrecision(10)); return r === 0 ? 0 : r;
}

/** PCB_IO_KICAD_SEXPR_PARSER::parseCONSTRAINT. */
export function parseConstraint(node: SNode): PcbConstraint {
  const c: PcbConstraint = { id: K.uuidOf(node) || "", type: "undefined", members: [], value: null, driving: true, node };
  let raw: number | null = null;
  for (const ch of node.slice(1)) {
    if (!Array.isArray(ch)) continue;
    const k = K.str(ch[0]);
    if (k === "type") c.type = constraintTypeFromToken(K.str(ch[1]));
    else if (k === "members") for (const m of ch.slice(1)) {
      if (!Array.isArray(m) || m[0] !== "member") continue;
      const anchor = constraintAnchorFromToken(K.str(m[2]));
      // only a vertex may carry an ordinal, and even then it is optional
      const index = anchor === "vertex" && m.length > 3 ? Math.trunc(K.num(m[3], -1)) : -1;
      c.members.push({ item: K.str(m[1]), anchor, index });
    }
    else if (k === "value") raw = K.num(ch[1], 0);
    else if (k === "driving") c.driving = ch.length < 2 || K.str(ch[1]) !== "no";
  }
  // written in mm for the length types: back to IU now that the type is known
  if (raw !== null) c.value = constraintValueIsLength(c.type) ? raw * IU_PER_MM : raw;
  return c;
}
/** PCB_IO_KICAD_SEXPR::format( PCB_CONSTRAINT ): (constraint (type) (uuid) (members …) [(value)] [(driving no)] custom properties). */
export function constraintNode(c: PcbConstraint): SNode {
  const n: SNode = ["constraint", ["type", c.type]];
  if (c.id) n.push(["uuid", c.id]);
  const ms: SNode = ["members"];
  for (const m of c.members) ms.push(m.anchor === "vertex" ? ["member", m.item, m.anchor, m.index] : ["member", m.item, m.anchor]);
  n.push(ms);
  if (c.value !== null) n.push(["value", formatDouble2(constraintValueIsLength(c.type) ? c.value / IU_PER_MM : c.value)]);
  if (!c.driving) n.push(["driving", "no"]);
  if (c.node) for (const ch of c.node) if (Array.isArray(ch) && ch[0] === "custom_property") n.push(K.cloneNode(ch));
  return n;
}
/** A new constraint (no id yet: K.createItem gives it one). */
export const newConstraint = (type: ConstraintType, members: CMember[] = [], value: number | null = null, driving = true): PcbConstraint => ({ id: "", type, members, value, driving, node: null });

/** ConstraintsAreDuplicate: the same type over the same members as a multiset. */
export function constraintsAreDuplicate(a: PcbConstraint, b: PcbConstraint): boolean {
  if (a.type !== b.type || !a.members.length || a.members.length !== b.members.length) return false;
  const left = b.members.slice();
  for (const m of a.members) { const i = left.findIndex((x) => sameMember(x, m)); if (i < 0) return false; left.splice(i, 1); }
  return true;
}

// ---------------------------------------------------------------- the board as the constraint code sees it
export type ShapeKind = "segment" | "rect" | "poly" | "bezier" | "circle" | "arc" | "ellipse" | "ellipse_arc" | "other";
/** An ellipse in IU (centre, radii) and degrees (rotation, parametric start / end). */
export interface EllipseIU { cx: number; cy: number; major: number; minor: number; rotation: number; start: number; end: number }
/**
 * A constrainable BOARD_ITEM: a PCB_SHAPE, a dimension or a pad, its geometry in IU.  A footprint's child on a board
 * carries the footprint (`fp`): it moves only with it.  `top` is the document item that owns the node.
 */
export interface CItem {
  id: string; cls: "shape" | "dim" | "pad"; shape: ShapeKind; top: string; fp: string | null; node: SNode; layer: string; layers: string[]; locked: boolean;
  start: Pt; end: Pt; center: Pt; mid: Pt; radius: number; pts: Pt[]; c1: Pt; c2: Pt; ell: EllipseIU | null; dimType: string; horizontal: boolean;
}
const iu = (v: number): number => Math.round(v * IU_PER_MM);
const SHAPE_OF: Record<string, ShapeKind> = { line: "segment", rect: "rect", poly: "poly", curve: "bezier", circle: "circle", arc: "arc", ellipse: "ellipse", ellipse_arc: "ellipse_arc" };
/** CalcArcCenter of three points, rounded to IU. */
export function arcCenterIU(a: Pt, m: Pt, b: Pt): Pt {
  const ax = a[0], ay = a[1], bx = m[0], by = m[1], cx = b[0], cy = b[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (d === 0) return [Math.round((ax + cx) / 2), Math.round((ay + cy) / 2)];
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  return [Math.round((a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d), Math.round((a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d)];
}
/** ELLIPSE::GetPointAtAngle in IU. */
export function ellipsePointIU(e: EllipseIU, deg: number): Pt {
  const t = deg * Math.PI / 180, ex = e.major * Math.cos(t), ey = e.minor * Math.sin(t), c = Math.cos(e.rotation * Math.PI / 180), s = Math.sin(e.rotation * Math.PI / 180);
  return [e.cx + Math.round(ex * c - ey * s), e.cy + Math.round(ex * s + ey * c)];
}
const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The geometry of a shape node (board or footprint child) in IU, `xf` taking a local point to the board. */
function readShape(it: CItem, n: SNode, xf: (p: Pt) => Pt): void {
  const p = (k: string): Pt => { const c = K.kid(n, k); return xf(c ? [K.num(c[1]), K.num(c[2])] : [0, 0]); };
  const kind = String(n[0]).replace(/^(gr|fp)_/, "");
  it.shape = SHAPE_OF[kind] || "other";
  if (it.shape === "segment" || it.shape === "rect") { it.start = p("start"); it.end = p("end"); }
  else if (it.shape === "circle") { it.center = p("center"); it.start = it.center; it.end = p("end"); it.radius = Math.max(1, Math.round(dist(it.center, it.end))); }
  else if (it.shape === "arc") { it.start = p("start"); it.mid = p("mid"); it.end = p("end"); it.center = arcCenterIU(it.start, it.mid, it.end); it.radius = Math.max(1, Math.round(dist(it.center, it.start))); }
  else if (it.shape === "bezier") { const pts = (K.ptsOf(n) as Pt[]).map((q) => xf(q)); if (pts.length === 4) { it.start = pts[0]; it.c1 = pts[1]; it.c2 = pts[2]; it.end = pts[3]; } else it.shape = "other"; }
  else if (it.shape === "poly") {
    const pl = K.kid(n, "pts"); const xy = pl ? pl.slice(1) : [];
    // ConstraintPolygonIsModelable: one outline, no holes, no arcs
    if (xy.some((c) => Array.isArray(c) && c[0] === "arc")) it.pts = [];
    else it.pts = xy.filter((c) => Array.isArray(c) && c[0] === "xy").map((c) => xf([K.num((c as SNode)[1]), K.num((c as SNode)[2])]));
  } else if (it.shape === "ellipse" || it.shape === "ellipse_arc") {
    const v = (k: string, d = 0): number => { const x = K.kid(n, k); return x ? K.num(x[1], d) : d; };
    const c = p("center");
    it.ell = { cx: c[0], cy: c[1], major: iu(v("major_radius")), minor: iu(v("minor_radius")), rotation: v("rotation_angle"), start: it.shape === "ellipse_arc" ? v("start_angle") : 0, end: it.shape === "ellipse_arc" ? v("end_angle", 360) : 360 };
    it.center = c; it.start = ellipsePointIU(it.ell, it.ell.start); it.end = ellipsePointIU(it.ell, it.ell.end);
  }
}
const blank = (id: string, top: string, node: SNode): CItem => ({ id, cls: "shape", shape: "other", top, fp: null, node, layer: "", layers: [], locked: false,
  start: [0, 0], end: [0, 0], center: [0, 0], mid: [0, 0], radius: 0, pts: [], c1: [0, 0], c2: [0, 0], ell: null, dimType: "", horizontal: true });
const GFX = /^(gr|fp)_(line|rect|poly|curve|circle|arc|ellipse|ellipse_arc)$/;

/**
 * The board the constraint code works on: the document's items read through the edits of the operation in flight
 * (an Apply writes into `edits`, which later reads see).  `fpEditor`: BOARD::IsFootprintHolder.
 */
export class CBoard {
  doc: BoardDoc; fpEditor: boolean; edits = new Map<string, SNode>(); added: SNode[] = []; removed = new Set<string>();
  private cache: Map<string, CItem> | null = null;
  constructor(doc: BoardDoc, fpEditor?: boolean) { this.doc = doc; this.fpEditor = !!(fpEditor || (doc as { fpEditor?: boolean }).fpEditor); }
  nodeOf(top: string): SNode | null { const e = this.edits.get(top); if (e) return e; const it = this.doc.items.get(top); return it ? it.node : null; }
  /** BOARD_COMMIT::Modify: the working copy of a top-level item. */
  modify(top: string): SNode { let n = this.edits.get(top); if (!n) { n = K.cloneNode(this.nodeOf(top)!); this.edits.set(top, n); } this.cache = null; return n; }
  invalidate(): void { this.cache = null; }
  /** Every constrainable item by uuid (CollectMemberCandidateIds resolved). */
  items(): Map<string, CItem> {
    if (this.cache) return this.cache;
    const out = new Map<string, CItem>();
    for (const it of this.doc.items.values()) {
      if (this.removed.has(it.id)) continue;
      const n = this.nodeOf(it.id)!; const k = K.str(n[0]);
      if (GFX.test(k)) { const c = blank(it.id, it.id, n); readShape(c, n, (q) => [iu(q[0]), iu(q[1])]); c.layer = K.str((K.kid(n, "layer") || [])[1]); c.layers = [c.layer]; c.locked = isLocked(n); out.set(it.id, c); }
      else if (k === "dimension") {
        const c = blank(it.id, it.id, n); c.cls = "dim"; c.dimType = K.str((K.kid(n, "type") || [])[1]) || "aligned";
        const xs = K.kids(K.kid(n, "pts") || [], "xy"); c.start = xs[0] ? [iu(K.num(xs[0][1])), iu(K.num(xs[0][2]))] : [0, 0]; c.end = xs[1] ? [iu(K.num(xs[1][1])), iu(K.num(xs[1][2]))] : c.start;
        c.horizontal = !K.num((K.kid(n, "orientation") || [])[1], 0); c.layer = K.str((K.kid(n, "layer") || [])[1]); c.layers = [c.layer]; c.locked = isLocked(n); out.set(it.id, c);
      } else if (k === "pad" && this.fpEditor) {
        const c = blank(it.id, it.id, n); c.cls = "pad"; const at = K.kid(n, "at"); c.start = c.center = c.end = at ? [iu(K.num(at[1])), iu(K.num(at[2]))] : [0, 0];
        const ls = K.kid(n, "layers"); c.layers = ls ? ls.slice(1).map(K.str) : []; c.layer = c.layers[0] || ""; c.locked = isLocked(n); out.set(it.id, c);
      } else if (k === "footprint" && !this.fpEditor) {
        const [fx, fy, frot] = K.atOf(n); const R = rotator(frot); const fpLocked = isLocked(n);
        const xf = (q: Pt): Pt => { const r = R(q[0], q[1]); return [iu(fx + r[0]), iu(fy + r[1])]; };
        for (const ch of n) {
          if (!Array.isArray(ch)) continue; const ck = K.str(ch[0]); const cid = K.uuidOf(ch); if (!cid) continue;
          if (GFX.test(ck)) {
            const c = blank(cid, it.id, ch); c.fp = it.id; readShape(c, ch, xf);
            // a turned footprint's rectangle, polygon, Bezier or ellipse is not modelled in board coordinates here
            if (c.shape !== "segment" && c.shape !== "circle" && c.shape !== "arc" && (frot % 360 !== 0 || c.shape === "ellipse" || c.shape === "ellipse_arc")) c.shape = "other";
            c.layer = K.str((K.kid(ch, "layer") || [])[1]); c.layers = [c.layer]; c.locked = fpLocked || isLocked(ch); out.set(cid, c);
          } else if (ck === "pad") {
            const c = blank(cid, it.id, ch); c.cls = "pad"; c.fp = it.id; const at = K.kid(ch, "at"); c.start = c.center = c.end = xf(at ? [K.num(at[1]), K.num(at[2])] : [0, 0]);
            const ls = K.kid(ch, "layers"); c.layers = ls ? ls.slice(1).map(K.str) : []; c.layer = c.layers[0] || ""; c.locked = fpLocked || isLocked(ch); out.set(cid, c);
          }
        }
      }
    }
    return (this.cache = out);
  }
  resolve(id: string): CItem | null { return this.items().get(id) || null; }
  /** CollectResolvedConstraints: the board's (in the Footprint Editor, the footprint's) constraints. */
  constraints(): PcbConstraint[] {
    const out: PcbConstraint[] = [];
    for (const it of this.doc.items.values()) { if (it.kind !== "constraint" || this.removed.has(it.id)) continue; const c = parseConstraint(this.nodeOf(it.id)!); c.id = it.id; out.push(c); }
    for (const n of this.added) out.push(parseConstraint(n));
    return out;
  }
  /** Write a constraint's new value / driving flag into its working node. */
  writeConstraint(c: PcbConstraint): void {
    if (this.doc.items.has(c.id)) { const n = this.modify(c.id); const fresh = constraintNode({ ...c, node: n }); n.length = 0; n.push(...fresh); return; }
    const i = this.added.findIndex((n) => K.uuidOf(n) === c.id); if (i >= 0) this.added[i] = constraintNode({ ...c, node: this.added[i] });
  }
}

/**
 * RemapPolygonVertexMembers: after a vertex was inserted (delta > 0) or removed (delta < 0) at `changedIndex` of the
 * polygon `poly`, the vertex members at or past it shift by delta; a constraint bound to the removed vertex retires
 * whole (no fixed-arity form survives losing a member).  Staged on `board` (Modify / Remove).
 */
export function remapPolygonVertexMembers(board: CBoard, poly: string, changedIndex: number, delta: number): void {
  if (!delta) return;
  for (const c of board.constraints()) {
    let shifts = false, doomed = false;
    for (const m of c.members) {
      if (m.item !== poly || m.anchor !== "vertex") continue;
      if (delta < 0 && m.index === changedIndex) doomed = true; else if (m.index >= changedIndex) shifts = true;
    }
    if (doomed) { if (board.doc.items.has(c.id)) board.removed.add(c.id); else board.added = board.added.filter((n) => K.uuidOf(n) !== c.id); board.invalidate(); continue; }
    if (!shifts) continue;
    for (const m of c.members) if (m.item === poly && m.anchor === "vertex" && m.index >= changedIndex) m.index += delta;
    if (board.doc.items.has(c.id)) { const n = board.modify(c.id); const fresh = constraintNode({ ...c, node: n }); n.length = 0; n.push(...fresh); }
  }
}
/** ConstraintItemIsLocked. */
export const constraintItemIsLocked = (it: CItem | null): boolean => !!it && it.locked;
/** IsConstrainableItem. */
export const isConstrainable = (it: CItem | null): boolean => !!it;
const isSegment = (it: CItem): boolean => it.cls === "shape" && it.shape === "segment";
const isCircleOrArc = (it: CItem): boolean => it.cls === "shape" && (it.shape === "circle" || it.shape === "arc");
const isArc = (it: CItem): boolean => it.cls === "shape" && it.shape === "arc";
const isEllipseKind = (it: CItem): boolean => it.cls === "shape" && (it.shape === "ellipse" || it.shape === "ellipse_arc");

/** EDA_SHAPE::GetArcAngle in degrees (0, 360]. */
export function arcAngleDeg(it: CItem): number {
  const a = (p: Pt): number => { let d = Math.atan2(p[1] - it.center[1], p[0] - it.center[0]) * 180 / Math.PI; if (d < 0) d += 360; return d; };
  const sa = a(it.start); let ea = a(it.end); if (ea <= sa) ea += 360; return ea - sa;
}
/** SEG::Angle of two directions, [0, 180]. */
function segAngle(a0: Pt, a1: Pt, b0: Pt, b1: Pt): number {
  const ang = (p: Pt, q: Pt): number => Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI;
  let d = Math.abs(ang(a0, a1) - ang(b0, b1)) % 360; if (d > 180) d = 360 - d; return d;
}
/** MeasureCornerAngle: the corner between two segments at their nearest pair of ends. */
export function measureCornerAngle(a: [Pt, Pt], b: [Pt, Pt]): number {
  let vA = 0, vB = 0, best = (a[0][0] - b[0][0]) ** 2 + (a[0][1] - b[0][1]) ** 2;
  for (let i = 0; i < 2; ++i) for (let j = 0; j < 2; ++j) { const d = (a[i][0] - b[j][0]) ** 2 + (a[i][1] - b[j][1]) ** 2; if (d < best) { best = d; vA = i; vB = j; } }
  return segAngle(a[vA], a[1 - vA], b[vB], b[1 - vB]);
}

/** BuildConstraintFromItems: a constraint over whole items, or null when the items do not fit the type. */
export function buildConstraintFromItems(type: ConstraintType, items: CItem[]): PcbConstraint | null {
  const whole = (value: number | null = null) => newConstraint(type, items.map((it) => member(it.id, "whole")), value);
  switch (type) {
    case "parallel": case "perpendicular": case "equal_length": case "collinear":
      return items.length === 2 && items.every(isSegment) ? whole() : null;
    case "horizontal": case "vertical":
      return items.length === 1 && isSegment(items[0]) ? whole() : null;
    case "fixed_length":
      return items.length === 1 && isSegment(items[0]) ? whole(dist(items[0].end, items[0].start)) : null;
    case "concentric":
      return items.length === 2 && items.every((it) => isCircleOrArc(it) || isEllipseKind(it)) ? whole() : null;
    case "equal_radius":
      return items.length === 2 && items.every(isCircleOrArc) ? whole() : null;
    case "angular_dimension": {
      if (items.length !== 2 || !items.every(isSegment)) return null;
      const [a, b] = items; if ((a.start[0] === a.end[0] && a.start[1] === a.end[1]) || (b.start[0] === b.end[0] && b.start[1] === b.end[1])) return null;
      return whole(measureCornerAngle([a.start, a.end], [b.start, b.end]));
    }
    case "fixed_radius": return items.length === 1 && isCircleOrArc(items[0]) ? whole(items[0].radius) : null;
    case "arc_angle": return items.length === 1 && isArc(items[0]) ? whole(arcAngleDeg(items[0])) : null;
    case "tangent": {
      if (items.length !== 2) return null;
      const [a, b] = items, curve = (it: CItem) => isCircleOrArc(it) || isEllipseKind(it);
      const lineCurve = (isSegment(a) && curve(b)) || (isSegment(b) && curve(a)), curveCurve = isCircleOrArc(a) && isCircleOrArc(b);
      return lineCurve || curveCurve ? whole() : null;
    }
    default: return null;
  }
}
/** ConstraintSelectionHint. */
export function constraintSelectionHint(type: ConstraintType): string {
  const f: Partial<Record<ConstraintType, string>> = {
    parallel: "%s needs two line segments.  Click them to constrain.", perpendicular: "%s needs two line segments.  Click them to constrain.",
    equal_length: "%s needs two line segments.  Click them to constrain.", collinear: "%s needs two line segments.  Click them to constrain.",
    angular_dimension: "%s needs two line segments of nonzero length.  Click them to constrain.",
    horizontal: "%s needs one line segment, or two anchor points.  Click them to constrain.", vertical: "%s needs one line segment, or two anchor points.  Click them to constrain.",
    fixed_length: "%s needs one line segment.  Click it to constrain.", concentric: "%s needs two arcs, circles or ellipses.  Click them to constrain.",
    equal_radius: "%s needs two arcs or circles.  Click them to constrain.", fixed_radius: "%s needs one arc or circle.  Click it to constrain.",
    arc_angle: "%s needs one arc.  Click it to constrain.", tangent: "%s needs a line and a curve, or two arcs or circles.  Click them to constrain." };
  return f[type] ? f[type]!.replace("%s", CONSTRAINT_LABELS[type]) : "";
}

/** CONSTRAINT_ANCHOR_POINT. */
export interface AnchorPoint { anchor: ConstraintAnchor; pos: Pt; index: number }
/** ConstraintPolygonIsModelable. */
export const polygonIsModelable = (it: CItem): boolean => it.shape === "poly" && it.pts.length > 0;
/** ConstraintShapeAnchors / ConstraintItemAnchors. */
export function itemAnchors(it: CItem | null): AnchorPoint[] {
  if (!it) return [];
  const a = (anchor: ConstraintAnchor, pos: Pt, index = -1): AnchorPoint => ({ anchor, pos, index });
  if (it.cls === "pad") return [a("center", it.center)];
  if (it.cls === "dim") return it.dimType === "aligned" || it.dimType === "orthogonal" || it.dimType === "radial" ? [a("start", it.start), a("end", it.end)] : [a("start", it.start)];
  switch (it.shape) {
    case "segment": case "bezier": return [a("start", it.start), a("end", it.end)];
    case "arc": case "ellipse_arc": return [a("start", it.start), a("end", it.end), a("center", it.center)];
    case "circle": case "ellipse": return [a("center", it.center)];
    case "rect": {
      const s = it.start, e = it.end, tl: Pt = [Math.min(s[0], e[0]), Math.min(s[1], e[1])], br: Pt = [Math.max(s[0], e[0]), Math.max(s[1], e[1])];
      return [a("vertex", tl, 0), a("vertex", [br[0], tl[1]], 1), a("vertex", br, 2), a("vertex", [tl[0], br[1]], 3)];
    }
    case "poly": return polygonIsModelable(it) ? it.pts.map((p, i) => a("vertex", p, i)) : [];
    default: return [];
  }
}
/** ConstraintAnchorPosition. */
export function anchorPosition(board: CBoard, m: CMember): Pt | null {
  for (const a of itemAnchors(board.resolve(m.item))) if (a.anchor === m.anchor && (a.anchor !== "vertex" || a.index === m.index)) return a.pos;
  return null;
}
/** CollectConstrainableItems (aLayer "" for any): the shapes, dimensions and pads, on visible layers. */
export function constrainableItems(board: CBoard, layer = "", visible?: (layer: string) => boolean): CItem[] {
  const out: CItem[] = [];
  for (const it of board.items().values()) {
    if (it.cls === "pad") { if ((!visible || it.layers.some((l) => visible(l) || /^\*\./.test(l))) && (!layer || it.layers.some((l) => l === layer || (/^\*\./.test(l) && l.slice(2) === layer.split(".")[1])))) out.push(it); continue; }
    if ((!visible || visible(it.layer)) && (!layer || it.layer === layer)) out.push(it);
  }
  return out;
}
/** CollectConstraintShapes: the shapes only. */
export const constraintShapes = (board: CBoard, layer = "", visible?: (layer: string) => boolean): CItem[] => constrainableItems(board, layer, visible).filter((it) => it.cls === "shape");
/** NearestConstraintAnchor: the anchor within maxDist (IU) of pos, nearest last-wins on ties. */
export function nearestConstraintAnchor(board: CBoard, pos: Pt, maxDist: number, exclude: CMember[] = [], layer = "", visible?: (l: string) => boolean): CMember | null {
  let best = maxDist, result: CMember | null = null;
  for (const it of constrainableItems(board, layer, visible)) for (const a of itemAnchors(it)) {
    const cand = member(it.id, a.anchor, a.index); if (exclude.some((x) => sameMember(x, cand))) continue;
    const d = dist(a.pos, pos); if (d <= best) { best = d; result = cand; }
  }
  return result;
}
/** SEG::Distance. */
export function segDistance(a: Pt, b: Pt, p: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; if (!l2) return dist(a, p);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)); return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}
/** NearestOutlineShape: a segment (and with allowCircle a circle, arc or ellipse) whose outline passes within maxDist. */
export function nearestOutlineShape(board: CBoard, pos: Pt, maxDist: number, allowCircle: boolean, layer = "", visible?: (l: string) => boolean): string | null {
  let best = maxDist, result: string | null = null;
  for (const s of constraintShapes(board, layer, visible)) {
    let d: number;
    if (s.shape === "segment") d = segDistance(s.start, s.end, pos);
    else if (allowCircle && (s.shape === "circle" || s.shape === "arc")) d = Math.abs(dist(pos, s.center) - s.radius);
    else if (allowCircle && s.ell) {
      const a = s.ell.major, b = s.ell.minor, phi = s.ell.rotation * Math.PI / 180, dx = pos[0] - s.ell.cx, dy = pos[1] - s.ell.cy;
      const lx = dx * Math.cos(phi) + dy * Math.sin(phi), ly = -dx * Math.sin(phi) + dy * Math.cos(phi), r = Math.hypot(lx, ly);
      if (a <= 0 || b <= 0) continue;
      const th = Math.atan2(ly, lx); d = Math.abs(r - a * b / Math.hypot(b * Math.cos(th), a * Math.sin(th)));
    } else continue;
    if (d <= best) { best = d; result = s.id; }
  }
  return result;
}
/** ENDPOINT_BINDING. */
export interface EndpointBinding { sourceAnchor: ConstraintAnchor; target: CMember }
/** SelectEndpointBindings: a drawn item's start (and end) bound to anchors, a single item taking both ends first. */
export function selectEndpointBindings(board: CBoard, itemId: string, start: Pt, end: Pt | null, maxDist: number, layer = ""): EndpointBinding[] {
  const out: EndpointBinding[] = [];
  const bestPairOn = (cand: CItem): { pair: [CMember, CMember]; sum: number } | null => {
    const anchors = itemAnchors(cand), none = anchors.length; let bestEnd = none, secondEnd = none; const dEnd: number[] = anchors.map(() => 0);
    for (let j = 0; j < anchors.length; ++j) {
      dEnd[j] = dist(anchors[j].pos, end!); if (dEnd[j] > maxDist) continue;
      if (bestEnd === none || dEnd[j] < dEnd[bestEnd]) { secondEnd = bestEnd; bestEnd = j; } else if (secondEnd === none || dEnd[j] < dEnd[secondEnd]) secondEnd = j;
    }
    if (bestEnd === none) return null;
    let best: { pair: [CMember, CMember]; sum: number } | null = null;
    for (let i = 0; i < anchors.length; ++i) {
      const dStart = dist(anchors[i].pos, start); if (dStart > maxDist) continue;
      const j = i === bestEnd ? secondEnd : bestEnd; if (j === none) continue;
      const sum = dStart + dEnd[j];
      if (!best || sum < best.sum) best = { pair: [member(cand.id, anchors[i].anchor, anchors[i].index), member(cand.id, anchors[j].anchor, anchors[j].index)], sum };
    }
    return best;
  };
  if (end) {
    let bestPair: [CMember, CMember] | null = null, bestSum = 0;
    for (const it of constrainableItems(board, layer)) { if (it.id === itemId) continue; const p = bestPairOn(it); if (!p) continue; if (!bestPair || p.sum < bestSum) { bestSum = p.sum; bestPair = p.pair; } }
    if (bestPair) return [{ sourceAnchor: "start", target: bestPair[0] }, { sourceAnchor: "end", target: bestPair[1] }];
  }
  const exclude: CMember[] = [member(itemId, "start"), member(itemId, "end")];
  const s = nearestConstraintAnchor(board, start, maxDist, exclude, layer);
  if (s) { out.push({ sourceAnchor: "start", target: s }); exclude.push(s); }
  if (end) { const e = nearestConstraintAnchor(board, end, maxDist, exclude, layer); if (e) out.push({ sourceAnchor: "end", target: e }); }
  return out;
}
/** EDA_SHAPE::HitTest of an arc's outline near p (the angular range check). */
function arcHit(it: CItem, p: Pt, tol: number): boolean {
  if (Math.abs(dist(p, it.center) - it.radius) > tol) return false;
  const a = (q: Pt): number => { let d = Math.atan2(q[1] - it.center[1], q[0] - it.center[0]) * 180 / Math.PI; if (d < 0) d += 360; return d; };
  const sa = a(it.start); let pa = a(p); if (pa < sa) pa += 360;
  return pa - sa <= arcAngleDeg(it) || dist(p, it.start) <= tol || dist(p, it.end) <= tol;
}
/** SelectRadialDimensionTarget: the circle or arc a radial dimension's centre and rim both sit on. */
export function selectRadialDimensionTarget(board: CBoard, dimId: string, center: Pt, rim: Pt, maxDist: number): string | null {
  let best: string | null = null, bestErr = 0;
  for (const s of constraintShapes(board)) {
    if (s.id === dimId || !isCircleOrArc(s)) continue;
    const centerErr = dist(s.center, center); if (centerErr > maxDist) continue;
    const rimErr = Math.abs(dist(rim, s.center) - s.radius); if (rimErr > maxDist) continue;
    if (s.shape === "arc" && !arcHit(s, rim, Math.round(maxDist))) continue;
    const err = centerErr + rimErr; if (best === null || err < bestErr) { bestErr = err; best = s.id; }
  }
  return best;
}
/** ConstraintIsDuplicateOnBoard. */
export const constraintIsDuplicateOnBoard = (board: CBoard, c: PcbConstraint): boolean => board.constraints().some((x) => constraintsAreDuplicate(x, c));

// ---------------------------------------------------------------- driving dimensions
/** DimensionHasValueMode: aligned, orthogonal and radial dimensions measure a length that can drive. */
export const dimensionHasValueMode = (it: CItem | null): boolean => !!it && it.cls === "dim" && (it.dimType === "aligned" || it.dimType === "orthogonal" || it.dimType === "radial");
/** DimensionEndpointsBound: both feature points bound coincident (a radial: centre on a circle / arc centre, rim on it). */
export function dimensionEndpointsBound(board: CBoard, dimId: string): boolean {
  const dim = board.resolve(dimId); if (!dim) return false;
  const startM = member(dimId, "start"), endM = member(dimId, "end"); const all = board.constraints();
  if (dim.dimType === "radial") {
    const rimOnItem = (item: string) => all.some((c) => c.type === "point_on_line" && c.members.length === 2 && sameMember(c.members[0], endM) && sameMember(c.members[1], member(item, "whole")));
    return all.some((c) => {
      if (c.type !== "coincident" || c.members.length !== 2) return false;
      const target = sameMember(c.members[0], startM) ? c.members[1] : sameMember(c.members[1], startM) ? c.members[0] : null;
      if (!target || target.anchor !== "center") return false;
      const it = board.resolve(target.item); return !!it && isCircleOrArc(it) && rimOnItem(target.item);
    });
  }
  const hasCoincident = (m: CMember) => all.some((c) => {
    if (c.type !== "coincident" || c.members.length !== 2 || c.members[0].item === c.members[1].item) return false;
    if (sameMember(c.members[0], m)) return !!anchorPosition(board, c.members[1]);
    return sameMember(c.members[1], m) && !!anchorPosition(board, c.members[0]);
  });
  return hasCoincident(startM) && hasCoincident(endM);
}
/** FindDimensionLengthConstraint: the FIXED_LENGTH over the dimension's START and END, in either order. */
export function findDimensionLengthConstraint(board: CBoard, dimId: string): PcbConstraint | null {
  const s = member(dimId, "start"), e = member(dimId, "end");
  return board.constraints().find((c) => c.type === "fixed_length" && c.members.length === 2
    && ((sameMember(c.members[0], s) && sameMember(c.members[1], e)) || (sameMember(c.members[0], e) && sameMember(c.members[1], s)))) || null;
}
/** DimensionCanDrive. */
export function dimensionCanDrive(board: CBoard, dimId: string): boolean {
  if (!dimensionHasValueMode(board.resolve(dimId))) return false;
  if (dimensionEndpointsBound(board, dimId)) return true;
  const c = findDimensionLengthConstraint(board, dimId); return !!c && c.driving;
}
export type DimValueMode = "driven" | "driving" | "arbitrary";
/** DimensionValueMode. */
export function dimensionValueMode(board: CBoard, dimId: string): DimValueMode {
  const c = findDimensionLengthConstraint(board, dimId); if (c && c.driving) return "driving";
  const n = board.nodeOf(dimId); const fmt = n && K.kid(n, "format");
  return fmt && K.kid(fmt, "override_value") ? "arbitrary" : "driven";
}

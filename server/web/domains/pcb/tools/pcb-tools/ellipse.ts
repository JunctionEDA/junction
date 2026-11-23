// pcb-tools/ellipse.ts — board ellipses and elliptical arcs (PCB_SHAPE with SHAPE_T::ELLIPSE / ELLIPSE_ARC): the
// drawing tools' geometry (DRAWING_TOOL::DrawEllipse through drawShape and updateSegmentFromGeometryMgr,
// DrawEllipseArc through ELLIPSE_ARC_DRAW_BEHAVIOR / ELLIPSE_GEOM_MANAGER), the file node
// (PCB_IO_KICAD_SEXPR::format( PCB_SHAPE )), the transforms (EDA_SHAPE::rotate / flip / mirror( SEG )), the point
// editor's handles (EDA_ELLIPSE_POINT_EDIT_BEHAVIOR) and the hit test (EDA_SHAPE::hitTest via SHAPE_ELLIPSE).
// Everything is done in internal units (nanometres, Y down) where KiCad uses integers.
import type { Pt } from "./types";
import { strokeNode, gfxWidth } from "./nodes";
import { K } from "./state";
import { norm360, r6 } from "./util";

export const ELLIPSE_KINDS = new Set(["gr_ellipse", "gr_ellipse_arc"]);
const IU = 1e6;
const iu = (mm: number): number => Math.round(mm * IU);
const tdiv = (a: number, b: number): number => Math.trunc(a / b);
const RAD = Math.PI / 180;
/** EDA_UNIT_UTILS::FormatAngle: "{:.10g}". */
export const fmtAngle = (deg: number): number => { const v = Number((+deg).toPrecision(10)); return v === 0 ? 0 : v; };

/** ELLIPSE<int>: the centre and radii in mm, the angles in degrees (KiCad's internal Y-down convention). */
export interface EllipseGeom { cx: number; cy: number; major: number; minor: number; rotation: number; start: number; end: number }

/**
 * updateSegmentFromGeometryMgr for ELLIPSE / ELLIPSE_ARC (and ELLIPSE_GEOM_MANAGER::setBboxCorner2): the ellipse
 * inscribed in the box from `a` to `b`, the centre the integer middle, the major axis along the longer side (rotation
 * 0 when the box is at least as wide as it is high, else 90), both radii at least one nanometre.
 */
export function ellipseFromBox(a: Pt, b: Pt): EllipseGeom {
  const x1 = iu(a[0]), y1 = iu(a[1]), x2 = iu(b[0]), y2 = iu(b[1]);
  const cx = tdiv(x1 + x2, 2), cy = tdiv(y1 + y2, 2);
  const halfW = tdiv(Math.abs(x2 - x1), 2), halfH = tdiv(Math.abs(y2 - y1), 2);
  const wide = halfW >= halfH;
  return { cx: cx / IU, cy: cy / IU, major: Math.max(wide ? halfW : halfH, 1) / IU, minor: Math.max(wide ? halfH : halfW, 1) / IU, rotation: wide ? 0 : 90, start: 0, end: 360 };
}
/** ELLIPSE::GetPointAtAngle (integer result: KiROUND of the offset). */
export function ellipsePointAt(e: EllipseGeom, deg: number): Pt {
  const t = deg * RAD, ex = e.major * IU * Math.cos(t), ey = e.minor * IU * Math.sin(t);
  const c = Math.cos(e.rotation * RAD), s = Math.sin(e.rotation * RAD);
  return [(iu(e.cx) + Math.round(ex * c - ey * s)) / IU, (iu(e.cy) + Math.round(ex * s + ey * c)) / IU];
}
/** ELLIPSE::GetAngleAtPoint / evalEllipsePoint: the parametric angle of a point, in degrees (-180, 180]. */
export function ellipseAngleAt(e: EllipseGeom, p: Pt): number {
  const a = Math.max(1, e.major * IU), b = Math.max(1, e.minor * IU);
  const dx = iu(p[0]) - iu(e.cx), dy = iu(p[1]) - iu(e.cy);
  const c = Math.cos(e.rotation * RAD), s = Math.sin(e.rotation * RAD);
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  return Math.atan2(ly / b, lx / a) / RAD;
}
/** ELLIPSE_GEOM_MANAGER::setStartAngle / setEndAngle: the end always after the start, wrapped by whole turns. */
export function ellipseArcAngles(e: EllipseGeom, startPt: Pt, endPt?: Pt | null): { start: number; end: number } {
  const start = ellipseAngleAt(e, startPt);
  if (!endPt) return { start, end: start + 360 };
  let end = ellipseAngleAt(e, endPt);
  while (end <= start) end += 360;
  return { start, end };
}
/** evalEllipsePoint: the cursor taken onto the ellipse along its parametric angle (the arc's start / end marker). */
export function ellipseMarker(e: EllipseGeom, p: Pt): Pt { return ellipsePointAt(e, ellipseAngleAt(e, p)); }

const num = (n: SNode, k: string, d = 0): number => { const c = K.kid(n, k); return c ? K.num(c[1], d) : d; };
/** An ellipse node's geometry, or null without a centre. */
export function ellipseOf(n: SNode): EllipseGeom | null {
  const c = K.kid(n, "center"); if (!c) return null;
  return { cx: K.num(c[1]), cy: K.num(c[2]), major: num(n, "major_radius"), minor: num(n, "minor_radius"), rotation: num(n, "rotation_angle"), start: num(n, "start_angle"), end: num(n, "end_angle", 360) };
}
const setKid = (n: SNode, k: string, v: number): void => { const c = K.kid(n, k); if (c) c[1] = v; };
/** Write a geometry into an ellipse node in place (the file's centre, radii and angles). */
export function setEllipse(n: SNode, e: EllipseGeom): void {
  const c = K.kid(n, "center"); if (c) { c[1] = r6(e.cx); c[2] = r6(e.cy); }
  setKid(n, "major_radius", r6(e.major)); setKid(n, "minor_radius", r6(e.minor)); setKid(n, "rotation_angle", fmtAngle(e.rotation));
  if (/ellipse_arc$/.test(String(n[0]))) { setKid(n, "start_angle", fmtAngle(e.start)); setKid(n, "end_angle", fmtAngle(e.end)); }
}
/**
 * PCB_IO_KICAD_SEXPR::format( PCB_SHAPE ) for an ellipse: (gr_ellipse (center) (major_radius) (minor_radius)
 * (rotation_angle) (stroke) (fill) (layer)); an elliptical arc adds (start_angle) (end_angle) and has no fill.  A new
 * shape is unfilled (runSimpleShapeDraw / DrawEllipseArc: SetFilled( false )) with the layer class's line width.
 */
export function ellipseNode(e: EllipseGeom, arc: boolean, layer: string): SNode {
  const n: SNode = [arc ? "gr_ellipse_arc" : "gr_ellipse", ["center", r6(e.cx), r6(e.cy)], ["major_radius", r6(e.major)], ["minor_radius", r6(e.minor)], ["rotation_angle", fmtAngle(e.rotation)]];
  if (arc) n.push(["start_angle", fmtAngle(e.start)], ["end_angle", fmtAngle(e.end)]);
  n.push(strokeNode(gfxWidth(layer)));
  if (!arc) n.push(["fill", "no"]);
  n.push(["layer", layer]);
  return n;
}
/** EDA_SHAPE::rotate: the centre turns about (cx, cy) (RotatePoint, KiCad's positive = counter-clockwise on screen), Rotation -= angle. */
export function rotateEllipseNode(n: SNode, cx: number, cy: number, deg: number): SNode {
  const e = ellipseOf(n); if (!e) return n;
  const r = deg * RAD, c = Math.cos(r), s = Math.sin(r), dx = e.cx - cx, dy = e.cy - cy;
  e.cx = cx + dx * c + dy * s; e.cy = cy - dx * s + dy * c; e.rotation -= deg;
  setEllipse(n, e); return n;
}
/** ELLIPSE::Mirror (EDA_SHAPE::flip): the centre mirrored, Rotation = -Rotation; left / right [s, e] -> [180 - e, 180 - s], top / bottom [s, e] -> [-e, -s]. */
export function flipEllipseNode(n: SNode, cx: number, cy: number, leftRight: boolean): SNode {
  const e = ellipseOf(n); if (!e) return n;
  if (leftRight) e.cx = 2 * cx - e.cx; else e.cy = 2 * cy - e.cy;
  e.rotation = -e.rotation;
  const s0 = e.start, e0 = e.end;
  if (leftRight) { e.start = 180 - e0; e.end = 180 - s0; } else { e.start = -e0; e.end = -s0; }
  setEllipse(n, e); return n;
}
/** EDA_SHAPE::mirror( SEG ): the centre reflected, Rotation = Rotation.Reflect( EDA_ANGLE( B - A ) ).Normalize(), the angles [s, e] -> [-e, -s]. */
export function mirrorEllipseAxis(n: SNode, A: Pt, B: Pt): SNode {
  const e = ellipseOf(n); if (!e) return n;
  const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy; if (!L2) return n;
  const t = ((e.cx - A[0]) * dx + (e.cy - A[1]) * dy) / L2;
  e.cx = 2 * (A[0] + t * dx) - e.cx; e.cy = 2 * (A[1] + t * dy) - e.cy;
  e.rotation = norm360(2 * (Math.atan2(iu(dy), iu(dx)) / RAD) - e.rotation);
  const s0 = e.start; e.start = -e.end; e.end = -s0;
  setEllipse(n, e); return n;
}

// ---- EDA_ELLIPSE_POINT_EDIT_BEHAVIOR
/** MakePoints: the centre (it drives the whole shape), the major-axis end (angle 0), the minor-axis end (angle 90) and, for an arc, its ends with indicator lines from the centre. */
export function ellipseEditPoints(n: SNode): { key: string; p: Pt; lines?: Pt[] }[] {
  const e = ellipseOf(n); if (!e) return [];
  const c: Pt = [e.cx, e.cy];
  const out: { key: string; p: Pt; lines?: Pt[] }[] = [{ key: "center", p: c }, { key: "major", p: ellipsePointAt(e, 0) }, { key: "minor", p: ellipsePointAt(e, 90) }];
  if (/ellipse_arc$/.test(String(n[0]))) {
    const s = ellipsePointAt(e, e.start), t = ellipsePointAt(e, e.end);
    out.push({ key: "estart", p: s }, { key: "eend", p: t });
    out[0] = { key: "center", p: c, lines: [s, t] };
  }
  return out;
}
/** UpdateItem: the node with handle `key` dragged to `p`. */
export function ellipseEditNode(n: SNode, key: string, p: Pt): SNode {
  const e = ellipseOf(n); if (!e) return n;
  if (key === "center") { e.cx = p[0]; e.cy = p[1]; }
  else if (key === "major") {
    const vx = iu(p[0]) - iu(e.cx), vy = iu(p[1]) - iu(e.cy);
    e.major = Math.max(1, Math.round(Math.sqrt(vx * vx + vy * vy))) / IU; e.rotation = Math.atan2(vy, vx) / RAD;
  } else if (key === "minor") {
    const vx = iu(p[0]) - iu(e.cx), vy = iu(p[1]) - iu(e.cy), r = e.rotation * RAD;
    e.minor = Math.max(1, Math.round(Math.abs(-vx * Math.sin(r) + vy * Math.cos(r)))) / IU;
  } else if (key === "estart") {
    let raw = ellipseAngleAt(e, p); const prev = e.start, sweep = e.end - prev;
    while (raw - prev > 180) raw -= 360;
    while (prev - raw > 180) raw += 360;
    e.start = raw; e.end = raw + sweep;
  } else if (key === "eend") {
    let raw = ellipseAngleAt(e, p); const prev = e.end;
    while (raw - prev > 180) raw -= 360;
    while (prev - raw > 180) raw += 360;
    e.end = raw;
  }
  setEllipse(n, e); return n;
}

// ---- hit testing (EDA_SHAPE::hitTest: SHAPE_ELLIPSE::SquaredDistance)
/** The ellipse's (or arc's) outline as a fine polyline, in mm. */
export function ellipseOutline(e: EllipseGeom, arc: boolean, segs = 256): Pt[] {
  let t0 = 0, t1 = 360;
  if (arc) { t0 = e.start; t1 = e.end; if (t1 - t0 >= 360 || t1 - t0 <= -360) t1 = t0 + 360; else if (t1 < t0) t1 += 360; }
  const n = Math.max(16, Math.ceil(segs * (t1 - t0) / 360)), out: Pt[] = [];
  const c = Math.cos(e.rotation * RAD), s = Math.sin(e.rotation * RAD);
  for (let i = 0; i <= n; i++) {
    if (!arc && i === n) break;
    const t = (t0 + (t1 - t0) * i / n) * RAD, lx = e.major * Math.cos(t), ly = e.minor * Math.sin(t);
    out.push([e.cx + lx * c - ly * s, e.cy + lx * s + ly * c]);
  }
  return out;
}
/**
 * EDA_SHAPE::hitTest( aPosition, aAccuracy ) for an ellipse: the distance from the point to the outline (a filled closed
 * ellipse counts its inside, SquaredDistance( p, false )), less half the line width; a hatched fill's lines also count.
 */
export function ellipseHitDistance(n: SNode, x: number, y: number): number {
  const e = ellipseOf(n); if (!e) return Infinity;
  const arc = /ellipse_arc$/.test(String(n[0]));
  const st = K.kid(n, "stroke"), w = st ? num(st, "width") : num(n, "width");
  const f = K.kid(n, "fill"), fv = f ? K.str(f[1]) : "";
  const filled = !arc && (fv === "yes" || fv === "solid");
  if (filled) {
    const c = Math.cos(e.rotation * RAD), s = Math.sin(e.rotation * RAD), dx = x - e.cx, dy = y - e.cy;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    if (e.major > 0 && e.minor > 0 && (lx * lx) / (e.major * e.major) + (ly * ly) / (e.minor * e.minor) <= 1) return 0;
  }
  const pts = ellipseOutline(e, arc);
  let d = Infinity;
  for (let i = 0; i < (arc ? pts.length - 1 : pts.length); i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy;
    let t = l2 > 0 ? ((x - a[0]) * vx + (y - a[1]) * vy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    d = Math.min(d, Math.hypot(x - (a[0] + t * vx), y - (a[1] + t * vy)));
  }
  return Math.max(0, d - w / 2);
}

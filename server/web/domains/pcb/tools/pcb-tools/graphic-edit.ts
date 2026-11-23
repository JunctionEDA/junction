// pcb-tools/graphic-edit.ts — GRAPHIC_EDIT_TOOL (pcbnew/tools/graphic_edit_tool.cpp, graphic_edit.cpp,
// graphic_extend.cpp, graphic_trim.cpp and the INTERSECTION_VISITOR of libs/kimath geometry/intersection.cpp):
// Edit > Extend Line or Arc and Edit > Trim Shape.  Both are hover pickers: the graphical shape under the pointer is
// planned against the other shapes on its layer (footprint graphics included), the result is previewed, and a click
// commits it ("Extend Line or Arc" / "Trim Shape") and keeps the tool running.  The geometry works in KiCad's
// internal units (nm, integers) so the rounding of the intersection points is KiCad's.
import type { BoardDoc, PcbChange, PcbCtx, Pt } from "./types";
import { root } from "../root";
import { appGlobal, editorState } from "./app-state";
import { addedChange, removedChange, upsertChange } from "./changes";
import { clearConstruction, itemShapes } from "./construction";
import { groupMembersChanges, groupOf, isLocked } from "./groups";
import { K, S } from "./state";
import { r6 } from "./util";

type V = [number, number];
const IU = 1e6;
const toIU = (p: Pt): V => [Math.round(p[0] * IU), Math.round(p[1] * IU)];
const toMm = (v: V): Pt => [r6(v[0] / IU), r6(v[1] / IU)];

/** MAX_GRAPHIC_EDIT_ARC_RADIUS: larger arcs overflow the boundary search box. */
const MAX_ARC_RADIUS = Math.floor(2147483647 / 2);
/** GRAPHIC_EDIT_ANGLE_EPSILON (degrees). */
const ANGLE_EPS = 1e-6;
/** OVERLAP_EPSILON (intersection.cpp) and PARAM_EPSILON (graphic_trim.cpp). */
const OVERLAP_EPS = 1e-7, PARAM_EPS = 1e-7;
/** SHAPE::MIN_PRECISION_IU. */
const MIN_PRECISION_IU = 4;

export type GeSeg = { t: "seg"; a: V; b: V };
export type GeHalf = { t: "half"; a: V; b: V };
export type GeCircle = { t: "circle"; c: V; r: number };
export type GeArc = { t: "arc"; p0: V; mid: V; p1: V; c: [number, number]; r: number };
export type GeBox = { t: "box"; a: V; b: V };
export type GeGeom = GeSeg | GeHalf | GeCircle | GeArc | GeBox;

// ---------------------------------------------------------------- VECTOR2I / SEG helpers (exact where KiCad is)
const big = (v: number) => BigInt(Math.round(v));
const crossB = (a: V, b: V) => big(a[0]) * big(b[1]) - big(a[1]) * big(b[0]);
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const eq = (a: V, b: V) => a[0] === b[0] && a[1] === b[1];
const dist = (a: V | [number, number], b: V | [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** EDA_ANGLE( vector ) in degrees. */
const angleOf = (v: [number, number]) => Math.atan2(v[1], v[0]) * 180 / Math.PI;
const norm360 = (a: number) => { a %= 360; if (a < 0) a += 360; return a; };
/** rescale( a, b, c ): a * b / c rounded to the nearest integer, in 128-bit-ish BigInt. */
function rescale(a: bigint, b: bigint, c: bigint): number {
  const n = a * b; const neg = (n < 0n) !== (c < 0n); const an = n < 0n ? -n : n, ac = c < 0n ? -c : c;
  const q = (an + ac / 2n) / ac; return Number(neg ? -q : q);
}
/** SEG::SquaredDistance( point ). */
function segSqDist(a: V, b: V, p: V) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  if (!l2) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2; t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx, y = a[1] + t * dy; return (p[0] - x) ** 2 + (p[1] - y) ** 2;
}
/** SEG::Contains( point ) with KiCad's default squared threshold of 3. */
const segContains = (a: V, b: V, p: V) => segSqDist(a, b, p) <= 3;
/** SEG::LineDistance. */
function lineDist(a: V, b: V, p: V) { const d = sub(b, a), L = Math.hypot(d[0], d[1]); return L ? Math.abs(Number(crossB(d, sub(p, a)))) / L : dist(a, p); }
/** VectorsInSameQuadrant (half_line.cpp). */
const sameQuadrant = (a: V, b: V) => (a[0] >= 0) === (b[0] >= 0) && (a[1] >= 0) === (b[1] >= 0);
/** HALF_LINE::Contains. */
const halfContains = (h: GeHalf, p: V) => sameQuadrant(sub(h.b, h.a), sub(p, h.a)) && lineDist(h.a, h.b, p) <= 1;
/** SEG::LineProject. */
function lineProject(a: V, b: V, p: V): V {
  const d = sub(b, a), l2 = big(d[0]) * big(d[0]) + big(d[1]) * big(d[1]); if (l2 === 0n) return a;
  const t = big(d[0]) * big(p[0] - a[0]) + big(d[1]) * big(p[1] - a[1]);
  return [a[0] + rescale(t, big(d[0]), l2), a[1] + rescale(t, big(d[1]), l2)];
}
/** SEG::intersects( aSeg, false, aLines ): the crossing point, rounded as KiCad rounds it, or null. */
function segIntersect(A: V, B: V, C: V, D: V, lines: boolean): V | null {
  if (!lines && (Math.max(A[0], B[0]) < Math.min(C[0], D[0]) || Math.max(C[0], D[0]) < Math.min(A[0], B[0])
    || Math.max(A[1], B[1]) < Math.min(C[1], D[1]) || Math.max(C[1], D[1]) < Math.min(A[1], B[1]))) return null;
  const dir1 = sub(B, A), dir2 = sub(D, C), off = sub(C, A);
  const det = crossB(dir2, dir1);
  if (det === 0n) {
    if (crossB(dir1, off) !== 0n) return null;
    if (lines) return eq(C, D) ? C : eq(A, B) ? A : [Math.trunc((A[0] + C[0]) / 2), Math.trunc((A[1] + C[1]) / 2)];
    // collinear segments: SEG::checkCollinearOverlap gives the start of the shared run
    const ax = Math.abs(dir1[0]) >= Math.abs(dir1[1]) ? 0 : 1;
    const lo1 = Math.min(A[ax], B[ax]), hi1 = Math.max(A[ax], B[ax]), lo2 = Math.min(C[ax], D[ax]), hi2 = Math.max(C[ax], D[ax]);
    if (hi1 < lo2 || hi2 < lo1) return null;
    const s = Math.max(lo1, lo2); for (const p of [A, B, C, D]) if (p[ax] === s) return p;
    return null;
  }
  const p2 = crossB(dir2, off), p1 = crossB(dir1, off);
  if (!lines) {
    if (det > 0n) { if (p1 < 0n || p1 > det || p2 < 0n || p2 > det) return null; }
    else if (p1 > 0n || p1 < det || p2 > 0n || p2 < det) return null;
  }
  return [C[0] + rescale(p1, big(dir2[0]), det), C[1] + rescale(p1, big(dir2[1]), det)];
}
/** SEG::Collinear: both ends of the other within 1 of this one's canonical line. */
function collinear(A: V, B: V, C: V, D: V) {
  const qa = big(A[1] - B[1]), qb = big(B[0] - A[0]), qc = -qa * big(A[0]) - qb * big(A[1]);
  const d = (p: V) => { const v = big(p[0]) * qa + big(p[1]) * qb + qc; return v < 0n ? -v : v; };
  return d(C) <= 1n && d(D) <= 1n;
}
/** KIGEOM::ParameterAlong. */
function paramAlong(a: V, b: V, p: V) { const d = sub(b, a), l2 = d[0] * d[0] + d[1] * d[1]; return l2 ? ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2 : 0; }

// ---------------------------------------------------------------- SHAPE_ARC
/** CalcArcCenter of three points (doubles). */
function arcCenter(s: V, m: V, e: V): [number, number] {
  const ax = s[0], ay = s[1], bx = m[0], by = m[1], cx = e[0], cy = e[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (!d) return [(ax + cx) / 2, (ay + cy) / 2];
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  return [(a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d];
}
export function makeArc(p0: V, mid: V, p1: V): GeArc { const c = arcCenter(p0, mid, p1); return { t: "arc", p0, mid, p1, c, r: dist(p0, c) }; }
/** SHAPE_ARC::IsCCW (in the y-down board frame: the polar angle grows from start to end). */
const arcCCW = (a: GeArc) => crossB(sub(a.p1, a.mid), sub(a.p0, a.mid)) > 0n;
/** SHAPE_ARC::IsEffectiveLine. */
function arcIsLine(a: GeArc) {
  const v1 = sub(a.mid, a.p0), v2 = sub(a.p1, a.mid);
  const L1 = Math.hypot(v1[0], v1[1]), L2 = Math.hypot(v2[0], v2[1]); if (!L1 || !L2) return true;
  return Math.abs(Number(crossB(v1, v2))) / Math.max(L1, L2) <= 1 && v1[0] * v2[0] + v1[1] * v2[1] > 0;
}
/** SHAPE_ARC::GetCentralAngle (degrees). */
export function arcCentral(a: GeArc) {
  if (eq(a.p0, a.p1)) return 360;
  if (arcIsLine(a)) return 0;
  let ang = angleOf(sub(a.p1, a.c as V) as [number, number]) - angleOf(sub(a.p0, a.c as V) as [number, number]);
  if (arcCCW(a)) { if (ang < 0) ang += 360; } else if (ang > 0) ang -= 360;
  return ang;
}
const arcStartAngle = (a: GeArc) => angleOf([a.p0[0] - a.c[0], a.p0[1] - a.c[1]]);
/** RotatePoint( point, centre, angle ) on integers (trigo.cpp). */
function rotateAbout(p: V, c: [number, number], deg: number): V {
  const a = norm360(deg) * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a), x = p[0] - c[0], y = p[1] - c[1];
  return [Math.round(x * cs + y * sn + c[0]), Math.round(y * cs - x * sn + c[1])];
}
/** SHAPE_ARC::ConstructFromStartEndCenter. */
export function arcFromStartEndCenter(s: V, e: V, c: [number, number], clockwise: boolean): GeArc {
  const sa = norm360(angleOf([s[0] - c[0], s[1] - c[1]])), ea = norm360(angleOf([e[0] - c[0], e[1] - c[1]]));
  let ang = norm360(ea - sa); if (clockwise) ang -= 360;
  const mid = rotateAbout(s, c, -ang / 2);
  return makeArc(s, mid, e);
}
/** SHAPE_ARC::sliceContainsPoint. */
function sliceContains(a: GeArc, p: V) {
  const sa = norm360(arcStartAngle(a)), ca = arcCentral(a), ea = sa + ca;
  let phi = norm360(angleOf([p[0] - a.c[0], p[1] - a.c[1]]));
  if (ca >= 0) { while (phi < sa) phi += 360; return phi >= sa && phi <= ea; }
  while (phi > sa) phi -= 360; return phi <= sa && phi >= ea;
}
/** SHAPE_ARC::Collide( point ): on the arc's circle (rounded) and within its sweep. */
const arcCollide = (a: GeArc, p: V) => Math.round(Math.abs(dist(p, a.c) - a.r)) <= 0 && sliceContains(a, p);
/** SHAPE_ARC::GetArcMid. */
const arcMidOf = (a: GeArc) => a.mid;
/** SHAPE_ARC::NearestPoint. */
function arcNearest(a: GeArc, p: V): V {
  const d = dist(p, a.c); const n: V = d ? [Math.round(a.c[0] + (p[0] - a.c[0]) * a.r / d), Math.round(a.c[1] + (p[1] - a.c[1]) * a.r / d)] : a.p0;
  if (sliceContains(a, n)) return n;
  return dist(p, a.p0) ** 2 <= dist(p, a.p1) ** 2 ? a.p0 : a.p1;
}
/** IsGraphicEditArcUsable. */
function arcUsable(a: GeArc) { const sw = Math.abs(arcCentral(a)); return a.r > 0 && a.r <= MAX_ARC_RADIUS && sw >= ANGLE_EPS && sw < 360 - ANGLE_EPS; }
/** GraphicEditCoincident: points built by different routes land a rounding step apart. */
const coincident = (a: V, b: V) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 <= 2;

// ---------------------------------------------------------------- CIRCLE
const arcCircle = (a: GeArc): GeCircle => ({ t: "circle", c: [Math.round(a.c[0]), Math.round(a.c[1])], r: Math.round(a.r) });
/** CIRCLE::IntersectLine. */
function circleLine(c: GeCircle, a: V, b: V): V[] {
  if (eq(a, b)) return [];
  const m = lineProject(a, b, c.c), om = Math.round(dist(m, c.c));
  if (om > c.r + MIN_PRECISION_IU) return [];
  if (om >= c.r - MIN_PRECISION_IU) return [m];
  const h = Math.trunc(Math.sqrt(c.r * c.r - om * om)); const d = sub(b, a), L = Math.hypot(d[0], d[1]);
  const v: V = [Math.round(d[0] * h / L), Math.round(d[1] * h / L)];
  return [[m[0] + v[0], m[1] + v[1]], [m[0] - v[0], m[1] - v[1]]];
}
/** CIRCLE::Intersect( CIRCLE ). */
function circleCircle(A: GeCircle, B: GeCircle): V[] {
  const v = sub(B.c, A.c), d = Math.trunc(Math.hypot(v[0], v[1])), r1 = A.r, r2 = B.r;
  if (d > r1 + r2 || d < Math.abs(r1 - r2) || d === 0) return [];
  const x = Math.trunc((d * d + r1 * r1 - r2 * r2) / (2 * d)), q = r1 * r1 - x * x; if (q < 0) return [];
  const y = Math.round(Math.sqrt(q)), rot = angleOf(v as [number, number]);
  const out: V[] = []; const put = (yy: number) => { const p = rotateAbout([x, yy], [0, 0], -rot); out.push([p[0] + A.c[0], p[1] + A.c[1]]); };
  put(y); if (y !== 0) put(-y); return out;
}

// ---------------------------------------------------------------- INTERSECTION_VISITOR
interface Contact { overlapping: boolean }
const boxSegs = (b: GeBox): [V, V][] => { const [x0, y0] = b.a, [x1, y1] = b.b; return [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]]; };
const isLineLike = (g: GeGeom): g is GeSeg | GeHalf => g.t === "seg" || g.t === "half";
/** extentAlong of a line-like geometry on the reference segment. */
function extentAlong(g: GeSeg | GeHalf, ra: V, rb: V): [number, number] {
  if (g.t === "seg") { const a = paramAlong(ra, rb, g.a), b = paramAlong(ra, rb, g.b); return [Math.min(a, b), Math.max(a, b)]; }
  const s = paramAlong(ra, rb, g.a); return paramAlong(ra, rb, g.b) > s ? [s, Infinity] : [-Infinity, s];
}
function checkCollinearOverlap(A: GeSeg | GeHalf, B: GeSeg | GeHalf, ct: Contact) {
  if (ct.overlapping || !collinear(A.a, A.b, B.a, B.b)) return;
  const [al, ah] = extentAlong(A, A.a, A.b), [bl, bh] = extentAlong(B, A.a, A.b);
  if (Math.min(ah, bh) - Math.max(al, bl) > OVERLAP_EPS) ct.overlapping = true;
}
function checkCircularContact(A: GeCircle | GeArc, B: GeCircle | GeArc, ct: Contact) {
  const ca = A.t === "arc" ? arcCircle(A) : A, cb = B.t === "arc" ? arcCircle(B) : B;
  if (eq(ca.c, cb.c) && ca.r === cb.r) {
    const shares = A.t === "arc" && B.t === "arc" ? arcCollide(A, arcMidOf(B)) || arcCollide(B, arcMidOf(A)) : true;
    if (!ct.overlapping && shares) ct.overlapping = true;
  }
}
/** The intersections of two primitives (findIntersections), the overlap noted in ct. */
function pair(A: GeGeom, B: GeGeom, out: V[], ct: Contact): void {
  if (A.t === "box") { for (const [a, b] of boxSegs(A)) pair({ t: "seg", a, b }, B, out, ct); return; }
  if (B.t === "box") { for (const [a, b] of boxSegs(B)) pair(A, { t: "seg", a, b }, out, ct); return; }
  if (isLineLike(A) && isLineLike(B)) {
    checkCollinearOverlap(A, B, ct);
    if (A.t === "seg" && B.t === "seg") { const p = segIntersect(A.a, A.b, B.a, B.b, false); if (p) out.push(p); return; }
    const h = (A.t === "half" ? A : B) as GeHalf, o = (A.t === "half" ? B : A);
    if (o.t === "seg") {   // HALF_LINE::Intersect( SEG )
      const p = segIntersect(o.a, o.b, h.a, h.b, true); if (p && sameQuadrant(sub(h.b, h.a), sub(p, h.a)) && segContains(o.a, o.b, p)) out.push(p); return;
    }
    const p = segIntersect(h.a, h.b, o.a, o.b, true);   // HALF_LINE::Intersect( HALF_LINE )
    if (p && sameQuadrant(sub(h.b, h.a), sub(p, h.a)) && sameQuadrant(sub(o.b, o.a), sub(p, o.a))) out.push(p); return;
  }
  if (isLineLike(A) || isLineLike(B)) {
    const L = (isLineLike(A) ? A : B) as GeSeg | GeHalf, C = (isLineLike(A) ? B : A) as GeCircle | GeArc;
    const pts = circleLine(C.t === "arc" ? { t: "circle", c: [Math.round(C.c[0]), Math.round(C.c[1])], r: Math.trunc(C.r) } : C, L.a, L.b);
    for (const p of pts) {
      if (C.t === "arc" && !sliceContains(C, p)) continue;
      if (L.t === "seg" ? !segContains(L.a, L.b, p) : !halfContains(L, p)) continue;
      out.push(p);
    }
    return;
  }
  const X = A as GeCircle | GeArc, Y = B as GeCircle | GeArc;
  checkCircularContact(X, Y, ct);
  const cx = X.t === "arc" ? { t: "circle", c: [Math.round(X.c[0]), Math.round(X.c[1])], r: Math.trunc(X.r) } as GeCircle : X;
  const cy = Y.t === "arc" ? { t: "circle", c: [Math.round(Y.c[0]), Math.round(Y.c[1])], r: Math.trunc(Y.r) } as GeCircle : Y;
  for (const p of circleCircle(cx, cy)) if ((X.t !== "arc" || sliceContains(X, p)) && (Y.t !== "arc" || sliceContains(Y, p))) out.push(p);
}

// ---------------------------------------------------------------- the shapes
/** A graphical shape the planners work on: the kind, its points in IU, its item and whether it is locked. */
export interface GeShape { kind: "line" | "arc" | "circle" | "rect"; start: V; end: V; mid?: V; center?: V; id: string; layer: string; locked: boolean }
const SHAPE_KIND: Record<string, GeShape["kind"]> = { gr_line: "line", gr_arc: "arc", gr_circle: "circle", gr_rect: "rect" };
/** GraphicEditShape: a board segment, arc, circle or rectangle (mm in the file, IU here), or null. */
export function graphicEditShape(it: KItem | null | undefined): GeShape | null {
  if (!it || !SHAPE_KIND[it.kind]) return null;
  const n = it.node, p = (k: string): V | null => { const c = K.kid(n, k); return c ? toIU([K.num(c[1]), K.num(c[2])]) : null; };
  const kind = SHAPE_KIND[it.kind], l = K.kid(n, "layer"), layer = l ? String(K.str(l[1])) : it.layer || "";
  if (kind === "circle") { const c = p("center"), e = p("end"); return c && e ? { kind, start: c, end: e, center: c, id: it.id, layer, locked: isLocked(n) } : null; }
  const s = p("start"), e = p("end"); if (!s || !e) return null;
  return { kind, start: s, end: e, mid: kind === "arc" ? p("mid") || undefined : undefined, id: it.id, layer, locked: isLocked(n) };
}
const shapeArc = (s: GeShape) => makeArc(s.start, s.mid!, s.end);
const shapeRadius = (s: GeShape) => Math.round(dist(s.end, s.center!));
/** PCB_SHAPE::GetRectCorners of an unrotated rectangle. */
const rectCorners = (s: GeShape): V[] => [[s.start[0], s.start[1]], [s.end[0], s.start[1]], [s.end[0], s.end[1]], [s.start[0], s.end[1]]];
/** BoardItemIntersectable for a graphic shape. */
function intersectable(s: GeShape): GeGeom {
  if (s.kind === "line") return { t: "seg", a: s.start, b: s.end };
  if (s.kind === "circle") return { t: "circle", c: s.center!, r: shapeRadius(s) };
  if (s.kind === "arc") return shapeArc(s);
  return { t: "box", a: [Math.min(s.start[0], s.end[0]), Math.min(s.start[1], s.end[1])], b: [Math.max(s.start[0], s.end[0]), Math.max(s.start[1], s.end[1])] };
}
/** The outline-only proximity the hover picker ranks candidates by (outlineProximity). */
export function outlineProximity(s: GeShape, p: V) {
  if (s.kind === "line") return Math.sqrt(segSqDist(s.start, s.end, p));
  if (s.kind === "circle") return Math.abs(dist(s.center!, p) - shapeRadius(s));
  if (s.kind === "arc") return dist(arcNearest(shapeArc(s), p), p);
  const c = rectCorners(s); let best = Infinity; for (let i = 0; i < 4; i++) best = Math.min(best, Math.sqrt(segSqDist(c[i], c[(i + 1) % 4], p))); return best;
}

// ---------------------------------------------------------------- the planners
export type Refusal = "none" | "unsupported" | "locked" | "nointersection" | "ambiguous" | "degenerate";
/** GRAPHIC_EDIT_GEOMETRY: a circle carries its centre in start and a point on the rim in end. */
export interface GeResultGeom { shape: "line" | "arc" | "circle"; start: V; mid?: V; end: V }
export interface GeResult { refusal: Refusal; geometry: GeResultGeom[]; preview: GeResultGeom[]; boundaries: string[] }
/** A boundary: a shape on the source's layer (a footprint graphic's key is "footprintId#childIndex"). */
export interface GeBoundary { key: string; geom: GeGeom }
const emptyResult = (refusal: Refusal = "nointersection"): GeResult => ({ refusal, geometry: [], preview: [], boundaries: [] });
const isExtendSource = (s: GeShape) => s.kind === "line" || s.kind === "arc";
/** GraphicEditSource: the shape to edit, or the refusal. */
function editSource(s: GeShape, accepts: (s: GeShape) => boolean, r: GeResult): GeShape | null {
  if (!accepts(s)) { r.refusal = "unsupported"; return null; }
  if (s.locked) { r.refusal = "locked"; return null; }
  return s;
}

/** GRAPHIC_EXTEND_PLANNER::NearestEndpoint: true for the start. */
const nearestIsStart = (s: GeShape, p: V) => dist(s.start, p) < dist(s.end, p);

/** GRAPHIC_EXTEND_PLANNER::Plan: grow the end nearest the pointer to the nearest crossing (a line along its ray, an arc round its circle). */
export function planExtend(src: GeShape, pointer: V, boundaries: GeBoundary[]): GeResult {
  const r = emptyResult(); const s = editSource(src, isExtendSource, r); if (!s) return r;
  const atStart = nearestIsStart(s, pointer), segment = s.kind === "line";
  const selected = atStart ? s.start : s.end, fixed = atStart ? s.end : s.start;
  let bestD = Infinity, bestP: V | null = null, bestB: string | null = null;
  let sweep = 0, center: [number, number] = [0, 0], radius = 0, clockwise = false, geom: GeGeom;
  if (segment) {
    if (eq(fixed, selected)) return emptyResult("degenerate");
    geom = { t: "half", a: fixed, b: selected };
  } else {
    const arc = shapeArc(s); if (!arcUsable(arc)) return emptyResult("degenerate");
    sweep = arcCentral(arc); clockwise = !arcCCW(arc); center = arc.c; radius = arc.r;
    geom = { t: "circle", c: [Math.round(center[0]), Math.round(center[1])], r: Math.round(radius) };
  }
  for (const b of boundaries) {
    const pts: V[] = [], ct: Contact = { overlapping: false };
    pair(geom, b.geom, pts, ct);
    if (ct.overlapping) continue;   // a shared run gives nothing to stop at
    for (const p of pts) {
      if (coincident(p, selected)) continue;
      let d: number;
      if (segment) { if (dist(fixed, p) <= dist(fixed, selected)) continue; d = dist(selected, p); }
      else {
        const ext = atStart ? arcFromStartEndCenter(p, selected, center, clockwise) : arcFromStartEndCenter(selected, p, center, clockwise);
        d = Math.abs(arcCentral(ext));
        if (d <= ANGLE_EPS || Math.abs(sweep) + d >= 360 - ANGLE_EPS) continue;   // growing back over the source closes the circle
      }
      if (d < bestD) { bestD = d; bestP = p; bestB = b.key; }
    }
  }
  if (!bestB || !bestP) {
    if (segment) return r;
    // an arc that reaches nothing keeps going, all the way round
    const c: V = [Math.round(center[0]), Math.round(center[1])];
    return { refusal: "none", geometry: [{ shape: "circle", start: c, end: [c[0] + Math.round(radius), c[1]] }], preview: [], boundaries: [] };
  }
  const start = atStart ? bestP : s.start, end = atStart ? s.end : bestP;
  let g: GeResultGeom;
  if (segment) g = { shape: "line", start, end };
  else { const a = arcFromStartEndCenter(start, end, center, clockwise); g = { shape: "arc", start: a.p0, mid: a.mid, end: a.p1 }; }
  return { refusal: "none", geometry: [g], preview: [], boundaries: [bestB] };
}

/** GRAPHIC_EXTEND_PLANNER::QueryBounds: the box the boundaries are looked for in (IU), or null. */
export function extendQueryBounds(s: GeShape, pointer: V, world: [V, V]): [V, V] | null {
  if (!isExtendSource(s)) return null;
  if (s.kind === "arc") {
    const a = shapeArc(s); if (!arcUsable(a)) return null; const R = Math.round(a.r), c = [Math.round(a.c[0]), Math.round(a.c[1])];
    const lo: V = [Math.max(c[0] - R, world[0][0]), Math.max(c[1] - R, world[0][1])], hi: V = [Math.min(c[0] + R, world[1][0]), Math.min(c[1] + R, world[1][1])];
    return lo[0] <= hi[0] && lo[1] <= hi[1] ? [lo, hi] : null;
  }
  const atStart = nearestIsStart(s, pointer), from = atStart ? s.end : s.start, thru = atStart ? s.start : s.end;
  // ClipHalfLineToBox: where the ray leaves the world box
  const d = sub(thru, from); let tmax = Infinity;
  for (const ax of [0, 1]) {
    if (d[ax] > 0) tmax = Math.min(tmax, (world[1][ax] - from[ax]) / d[ax]);
    else if (d[ax] < 0) tmax = Math.min(tmax, (world[0][ax] - from[ax]) / d[ax]);
  }
  if (!isFinite(tmax) || tmax < 0) return null;
  const exit: V = [Math.round(from[0] + d[0] * tmax), Math.round(from[1] + d[1] * tmax)];
  return [[Math.min(thru[0], exit[0]), Math.min(thru[1], exit[1])], [Math.max(thru[0], exit[0]), Math.max(thru[1], exit[1])]];
}

interface TrimCut { param: number; point: V; key: string }
/** TRIM_CARRIER: the one curve the pointer is trimming (a rectangle offers the side nearest the pointer). */
interface Carrier { kind: "line" | "arc" | "circle"; a: V; b: V; arc?: GeArc; circle?: GeCircle; geom: GeGeom; untouched: [V, V][] }
function carrierParam(c: Carrier, p: V): number {
  if (c.kind === "arc") {
    const arc = c.arc!; if (coincident(p, arc.p0)) return 0; if (coincident(p, arc.p1)) return 1;
    const part = arcFromStartEndCenter(arc.p0, p, arc.c, !arcCCW(arc)); return Math.abs(arcCentral(part) / arcCentral(arc));
  }
  if (c.kind === "circle") { let t = Math.atan2(p[1] - c.circle!.c[1], p[0] - c.circle!.c[0]); if (t < 0) t += 2 * Math.PI; return t / (2 * Math.PI); }
  return paramAlong(c.a, c.b, p);
}
function pointerParam(c: Carrier, p: V) {
  if (c.kind === "arc") return carrierParam(c, arcNearest(c.arc!, p));
  if (c.kind === "circle") return carrierParam(c, p);
  return Math.max(0, Math.min(1, carrierParam(c, p)));
}
function carrierSpan(c: Carrier, from: V, to: V, fromP: number, toP: number): GeResultGeom {
  if (c.kind === "line") return { shape: "line", start: from, end: to };
  if (c.kind === "arc") { const a = arcFromStartEndCenter(from, to, c.arc!.c, !arcCCW(c.arc!)); return { shape: "arc", start: from, mid: a.mid, end: to }; }
  let sw = toP - fromP; if (sw <= 0) sw += 1;
  const m = (fromP + sw / 2) * 2 * Math.PI, C = c.circle!;
  return { shape: "arc", start: from, mid: [C.c[0] + Math.round(C.r * Math.cos(m)), C.c[1] + Math.round(C.r * Math.sin(m))], end: to };
}
function buildCarrier(s: GeShape, pointer: V): Carrier | Refusal {
  if (s.kind === "line") { if (eq(s.start, s.end)) return "degenerate"; return { kind: "line", a: s.start, b: s.end, geom: { t: "seg", a: s.start, b: s.end }, untouched: [] }; }
  if (s.kind === "rect") {
    if (s.start[0] === s.end[0] || s.start[1] === s.end[1]) return "degenerate";
    const c = rectCorners(s), sides: [V, V][] = c.map((p, i) => [p, c[(i + 1) % 4]] as [V, V]);
    let ni = 0; for (let i = 1; i < 4; i++) if (segSqDist(sides[i][0], sides[i][1], pointer) < segSqDist(sides[ni][0], sides[ni][1], pointer)) ni = i;
    const [a, b] = sides[ni]; if (eq(a, b)) return "degenerate";
    return { kind: "line", a, b, geom: { t: "seg", a, b }, untouched: sides.filter((_, i) => i !== ni) };
  }
  if (s.kind === "arc") { const arc = shapeArc(s); if (!arcUsable(arc)) return "degenerate"; return { kind: "arc", a: arc.p0, b: arc.p1, arc, geom: arc, untouched: [] }; }
  const circle: GeCircle = { t: "circle", c: s.center!, r: shapeRadius(s) };
  if (circle.r <= 0 || circle.r > MAX_ARC_RADIUS) return "degenerate";
  return { kind: "circle", a: s.start, b: s.start, circle, geom: circle, untouched: [] };
}
/** GRAPHIC_TRIM_PLANNER::Plan: remove the span of the shape the pointer is in, between the nearest crossings. */
export function planTrim(src: GeShape, pointer: V, boundaries: GeBoundary[]): GeResult {
  const r = emptyResult(); const s = editSource(src, () => true, r); if (!s) return r;
  const cr = buildCarrier(s, pointer); if (typeof cr === "string") return emptyResult(cr);
  const closed = cr.kind === "circle";
  const cuts: TrimCut[] = []; let touched = false, overlapped = false;
  for (const b of boundaries) {
    const pts: V[] = [], ct: Contact = { overlapping: false };
    pair(cr.geom, b.geom, pts, ct);
    if (ct.overlapping) { overlapped = true; continue; }
    for (const p of pts) {
      touched = true;
      const t = carrierParam(cr, p);
      if (!closed && (t <= PARAM_EPS || t >= 1 - PARAM_EPS)) continue;   // an end is already a partition point
      if (!cuts.some((c) => coincident(c.point, p))) cuts.push({ param: t, point: p, key: b.key });
    }
  }
  if (!touched) return emptyResult(overlapped ? "ambiguous" : "nointersection");
  if (closed && cuts.length < 2) return emptyResult("nointersection");
  cuts.sort((a, b) => a.param - b.param);
  const pp = pointerParam(cr, pointer);
  if (cuts.some((c) => Math.abs(c.param - pp) <= PARAM_EPS)) return emptyResult("ambiguous");
  let before: TrimCut | null = null, after: TrimCut | null = null;
  if (closed) {
    const ni = cuts.findIndex((c) => c.param > pp);
    after = ni < 0 ? cuts[0] : cuts[ni];
    before = ni <= 0 ? cuts[cuts.length - 1] : cuts[ni - 1];
  } else for (const c of cuts) { if (c.param < pp) before = c; else if (!after) after = c; }
  const from = before ? before.point : cr.a, to = after ? after.point : cr.b, fromP = before ? before.param : 0, toP = after ? after.param : 1;
  const out: GeResult = { refusal: "none", geometry: [], preview: [carrierSpan(cr, from, to, fromP, toP)], boundaries: [] };
  if (closed) out.geometry.push(carrierSpan(cr, to, from, toP, fromP));
  else {
    if (before) out.geometry.push(carrierSpan(cr, cr.a, before.point, 0, before.param));
    if (after) out.geometry.push(carrierSpan(cr, after.point, cr.b, after.param, 1));
  }
  for (const [a, b] of cr.untouched) out.geometry.push({ shape: "line", start: a, end: b });
  if (before) out.boundaries.push(before.key);
  if (after && (!before || after.key !== before.key)) out.boundaries.push(after.key);
  return out;
}

// ---------------------------------------------------------------- the tool
/** refusalMessage: the infobar text for a refusal (the operation supplies the no-result wording). */
export function refusalMessage(r: Refusal, noResult: string) {
  return r === "ambiguous" ? "More than one shape meets this one here." : r === "degenerate" ? "That shape is too small or too near a full circle to work with."
    : r === "locked" ? "That shape is locked." : noResult;
}
export interface GeOperation { tool: "extendgraphic" | "trimgraphic"; noResult: string; commit: string; accepts(s: GeShape): boolean; previewColor: string }
export const GE_OPS: Record<string, GeOperation> = {
  extendgraphic: { tool: "extendgraphic", noResult: "There is nothing to reach in that direction.", commit: "Extend Line or Arc", accepts: isExtendSource, previewColor: "#FFFFFF" },   // LAYER_AUX_ITEMS
  trimgraphic: { tool: "trimgraphic", noResult: "Nothing crosses the shape here.", commit: "Trim Shape", accepts: () => true, previewColor: "rgba(215, 91, 107, 0.8)" },   // LAYER_DRC_ERROR
};
/** What the hover planned: the source, the result, what is lit. */
export interface GeHover { source: string | null; result: GeResult | null; lit: string[] }

/** The layers the editor hides (view()->IsVisible): their shapes are not boundaries. */
const hiddenLayers = () => appGlobal(() => editorState()!.hiddenLayers as Set<string> | null, null);
/** The board's bounding box in IU (BOARD::GetBoundingBox). */
function worldBox(doc: BoardDoc): [V, V] {
  let b: number[] | null = null;
  for (const it of doc.items.values()) { const x = it.bbox; if (!x) continue; b = b ? [Math.min(b[0], x[0]), Math.min(b[1], x[1]), Math.max(b[2], x[2]), Math.max(b[3], x[3])] : x.slice(); }
  return b ? [toIU([b[0], b[1]]), toIU([b[2], b[3]])] : [[0, 0], [0, 0]];
}
/** collectBoundaries: every shown graphic shape on the source's layer (footprint graphics too) but the source. */
function boundariesFor(doc: BoardDoc, src: GeShape, box: [V, V] | null): GeBoundary[] {
  const hidden = hiddenLayers(), out: GeBoundary[] = [];
  if (hidden && hidden.has(src.layer)) return out;
  const hiddenObj = root.CollabEditor && (root.CollabEditor as { objectHidden?: (it: KItem) => boolean }).objectHidden;
  for (const it of doc.items.values()) {
    if (it.id === src.id || (hiddenObj && hiddenObj(it))) continue;
    if (box && it.bbox) { const b = toIU([it.bbox[0], it.bbox[1]]), e = toIU([it.bbox[2], it.bbox[3]]); if (e[0] < box[0][0] || b[0] > box[1][0] || e[1] < box[0][1] || b[1] > box[1][1]) continue; }
    for (const sh of itemShapes(it)) {
      const l = sh.layer || (() => { const k = K.kid(it.node, "layer"); return k ? String(K.str(k[1])) : ""; })();
      if (l !== src.layer) continue;
      const s = sh.shape, kind = s.kind;
      const g: GeShape = { kind, start: toIU(s.start), end: toIU(s.end), mid: s.mid ? toIU(s.mid) : undefined, center: s.center ? toIU(s.center) : undefined, id: sh.key, layer: l, locked: false };
      if (kind === "rect") g.center = undefined;
      out.push({ key: sh.key, geom: intersectable(g) });
    }
  }
  return out;
}
/** The shape under the pointer the operation accepts (HOVER_PICKER::Pick with outlineProximity), locked ones included. */
export function hoveredSource(doc: BoardDoc, mm: Pt, slop: number, op: GeOperation): GeShape | null {
  const p = toIU(mm), tol = slop * IU; let best: GeShape | null = null, bd = Infinity;
  const hidden = hiddenLayers();
  const allowed = root.CollabEditor && root.CollabEditor.pickAllowed;
  for (const it of doc.items.values()) {
    const s = graphicEditShape(it); if (!s || !op.accepts(s) || (hidden && hidden.has(s.layer))) continue;
    if (allowed && !allowed(it)) continue;
    const w = (() => { const st = K.kid(it.node, "stroke"), sw = st && K.kid(st as SNode, "width"); return sw ? K.num(sw[1]) * IU / 2 : 0; })();
    const f = K.kid(it.node, "fill"), filled = !!f && /^(yes|solid)$/.test(String(K.str(f[1])));
    const prox = outlineProximity(s, p);
    const inside = filled && (s.kind === "circle" ? dist(s.center!, p) <= shapeRadius(s) : s.kind === "rect" ? p[0] >= Math.min(s.start[0], s.end[0]) && p[0] <= Math.max(s.start[0], s.end[0]) && p[1] >= Math.min(s.start[1], s.end[1]) && p[1] <= Math.max(s.start[1], s.end[1]) : false);
    if (prox > tol + w && !inside) continue;   // CollectPoint: not under the pointer
    if (prox < bd) { bd = prox; best = s; }
  }
  return best;
}
/** updatePreview: plan against what is under the pointer. */
export function geHover(doc: BoardDoc, mm: Pt, slop: number, op: GeOperation): GeHover {
  const src = hoveredSource(doc, mm, slop, op); if (!src) return { source: null, result: null, lit: [] };
  const p = toIU(mm);
  let box: [V, V] | null = null;
  if (op.tool === "extendgraphic") {
    const w = worldBox(doc); const sb = graphicBox(src); const ray: [V, V] = [[Math.min(w[0][0], sb[0][0]), Math.min(w[0][1], sb[0][1])], [Math.max(w[1][0], sb[1][0]), Math.max(w[1][1], sb[1][1])]];
    box = extendQueryBounds(src, p, ray);
    if (!box) return { source: src.id, result: emptyResult(src.locked ? "locked" : "degenerate"), lit: [src.id] };
  } else box = graphicBox(src);
  const bounds = boundariesFor(doc, src, box);
  const result = op.tool === "extendgraphic" ? planExtend(src, p, bounds) : planTrim(src, p, bounds);
  const lit = [src.id]; if (result.refusal === "none") for (const k of result.boundaries) { const id = k.split("#")[0]; if (!lit.includes(id)) lit.push(id); }
  return { source: src.id, result, lit };
}
function graphicBox(s: GeShape): [V, V] {
  if (s.kind === "circle") { const r = shapeRadius(s), c = s.center!; return [[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]]; }
  const pts = [s.start, s.end].concat(s.kind === "arc" ? [s.mid!] : []);
  if (s.kind === "arc") { const a = shapeArc(s); for (const deg of [0, 90, 180, 270]) { const q: V = [Math.round(a.c[0] + a.r * Math.cos(deg * Math.PI / 180)), Math.round(a.c[1] + a.r * Math.sin(deg * Math.PI / 180))]; if (sliceContains(a, q)) pts.push(q); } }
  return [[Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1]))], [Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))]];
}

const GEOM_KEYS = new Set(["start", "mid", "end", "center", "fill"]);
/** applyGeometry: the source node with its shape (and kind) replaced; a shape that changes kind loses its fill. */
export function applyGeometryNode(node: SNode, g: GeResultGeom): SNode {
  const head = g.shape === "line" ? "gr_line" : g.shape === "arc" ? "gr_arc" : "gr_circle";
  const kindChanged = node[0] !== head;
  const fillKid = K.kid(node, "fill");
  const rest = node.slice(1).filter((c) => !(Array.isArray(c) && GEOM_KEYS.has(String(c[0]))));
  let geo: SNode[];
  if (g.shape === "arc") {
    // EDA_SHAPE::SetArcGeometry keeps one winding (the polar angle grows from start to end), as nodes.ts arcNode stores it
    let a = g.start, b = g.end; const m = g.mid!;
    if ((m[0] - a[0]) * (b[1] - m[1]) - (m[1] - a[1]) * (b[0] - m[0]) < 0) [a, b] = [b, a];
    geo = [["start", ...toMm(a)], ["mid", ...toMm(m)], ["end", ...toMm(b)]];
  } else if (g.shape === "circle") geo = [["center", ...toMm(g.start)], ["end", ...toMm(g.end)]];
  else geo = [["start", ...toMm(g.start)], ["end", ...toMm(g.end)]];
  const out: SNode = [head, ...geo];
  // the file writes (fill) for closed shapes only: a circle keeps one (none when it was opened up or changed kind)
  for (const c of rest) {
    if (Array.isArray(c) && c[0] === "layer" && g.shape === "circle") out.push(["fill", kindChanged || !fillKid ? "no" : fillKid[1]]);
    out.push(c);
  }
  return out;
}
/** The click: the source changed to the first piece, the other pieces added beside it (in its group), or the source removed. */
export function geCommitChanges(doc: BoardDoc, sourceId: string, res: GeResult): PcbChange[] {
  const it = doc.items.get(sourceId); if (!it) return [];
  if (!res.geometry.length) return [removedChange(it)];
  const changes: PcbChange[] = [], added: string[] = [];
  for (let i = 1; i < res.geometry.length; i++) {
    const n = applyGeometryNode(K.cloneNode(it.node), res.geometry[i]);
    const u = K.kid(n, "uuid"); if (u) u[1] = K.newUuid();
    const c = addedChange(doc, n); changes.push(c); added.push(c.id);
  }
  const first = applyGeometryNode(K.cloneNode(it.node), res.geometry[0]);
  changes.unshift(upsertChange({ id: it.id, kind: String(first[0]), node: first }, "MODIFIED"));
  const g = groupOf(doc, it.id); if (g && added.length) changes.push(...groupMembersChanges(doc, g, added, null));
  return changes;
}

/** The pointer moved: plan and keep the preview (S.gedit). */
export function geMove(ctx: PcbCtx, mm: Pt) {
  const op = GE_OPS[S.modTool || ""]; if (!op || !ctx.doc) { S.gedit = null; return; }
  const slop = 0.2 + 2 / Math.max(1, ctx.pxPerMm || 1);
  clearConstruction();   // picker->SetConstructionGeometry( false ): nothing here follows an extension
  S.gedit = geHover(ctx.doc, mm, slop, op);
}
/** The click: refuse with the infobar's message, or commit and plan again where the pointer is. */
export function geClick(ctx: PcbCtx, mm: Pt) {
  const op = GE_OPS[S.modTool || ""]; if (!op || !ctx.doc) return;
  geMove(ctx, mm); const h = S.gedit; if (!h || !h.source || !h.result) return;
  if (h.result.refusal !== "none") { ctx.toast(refusalMessage(h.result.refusal, op.noResult), 5000); return; }
  if (ctx.viewOnly) { ctx.toast("View-only access"); return; }
  const ch = geCommitChanges(ctx.doc, h.source, h.result);
  S.gedit = null;
  if (ch.length) ctx.commit(ch, op.commit);
  geMove(ctx, mm); ctx.requestRender();
}
/** What the preview draws: the result's pieces (trim: the span to remove), in mm. */
export function gePreviewShapes(): { color: string; shapes: { shape: string; start: Pt; mid?: Pt; end: Pt }[] } | null {
  const op = GE_OPS[S.modTool || ""], h = S.gedit; if (!op || !h || !h.result || h.result.refusal !== "none") return null;
  const shown = h.result.preview.length ? h.result.preview : h.result.geometry;
  return { color: op.previewColor, shapes: shown.map((g) => ({ shape: g.shape, start: toMm(g.start), mid: g.mid ? toMm(g.mid) : undefined, end: toMm(g.end) })) };
}
/** The items brightened while hovering (HOVER_PICKER::BrightenOnly): the source and the boundaries it meets. */
export const geLitIds = () => (S.gedit && GE_OPS[S.modTool || ""] ? S.gedit.lit.slice() : []);

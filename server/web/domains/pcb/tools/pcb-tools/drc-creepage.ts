// pcb-tools/drc-creepage.ts — DRC_TEST_PROVIDER_CREEPAGE (drc_test_provider_creepage.cpp, the batch path KiCad runs:
// RealtimeCreepage and EnableCreepageSlot are off by default, so the minimum groove width is 0) over the creepage graph
// of drc_creepage_utils.cpp (CREEPAGE_GRAPH):
//
//  - the board edge (Edge.Cuts drawings, Bézier curves flattened, NPTH holes as circles or slots) becomes board edge
//    shapes: points (segment ends, rectangle and polygon corners), circles and arcs; paths between them that stay on
//    the board (SegmentIntersectsBoard, the midpoint inside the board outline less the NPTH holes) are generated once;
//  - for each pair of nets and each copper layer whose net boxes come within the target: both nets' copper (pad,
//    track, via, zone and connected drawing shapes) joins a virtual node per net, tangent and nearest-point paths are
//    generated between copper and edge shapes (not across a track on the layer), nodes on one edge circle or arc are
//    joined along it, and Dijkstra finds the shortest path from one net to the other;
//  - a path shorter than the creepage constraint (the rule for the two nets, or for the two items at the path's ends
//    when a rule has a condition) is a "Creepage violation" with the path as the marker's error legend.
//
// Geometry is in nanometres (KiCad's internal units) as doubles; node positions are rounded as VECTOR2I.
import type { BoardDoc, Conductor, DesignSettings, DrcMarker, Pt } from "./types";
import { chainLoops, edgeShapes, marker, mmPair, ruled, withKiids } from "./drc";
import { unflashedLayers } from "./drc-flash";
import { evalRuleConstraint } from "./dru";
import type { DruRule } from "./dru";
import type { RuleItem } from "./dru-eval";
import { netlist } from "./netlist";
import { padShapePolygon } from "./pad-outline";
import { K } from "./state";
import { isList, layerOf, pt, rotator } from "./util";

type V = [number, number];
const IU = 1e6;
const toIU = (p: Pt | number[]): V => [Math.round(p[0] * IU), Math.round(p[1] * IU)];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k];
const norm = (a: V) => Math.hypot(a[0], a[1]);
const sq = (a: V) => a[0] * a[0] + a[1] * a[1];
const cross = (a: V, b: V) => a[0] * b[1] - a[1] * b[0];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1];
const perp = (a: V): V => [-a[1], a[0]];   // VECTOR2::Perpendicular
const resize = (a: V, len: number): V => { const l = norm(a); return l ? [a[0] * len / l, a[1] * len / l] : [0, 0]; };
const rI = (a: V): V => [Math.round(a[0]), Math.round(a[1])];   // a VECTOR2D taken as a VECTOR2I
const eq = (a: V, b: V) => a[0] === b[0] && a[1] === b[1];
/** EDA_ANGLE( VECTOR2D ) in degrees, with its exact cases. */
function angleOf(v: V): number {
  const [x, y] = v;
  if (x === 0 && y === 0) return 0;
  if (y === 0) return x >= 0 ? 0 : -180;
  if (x === 0) return y >= 0 ? 90 : -90;
  if (x === y) return x >= 0 ? 45 : -135;
  if (x === -y) return x >= 0 ? -45 : 135;
  return Math.atan2(y, x) * 180 / Math.PI;
}
const RAD = Math.PI / 180;

// ---------------------------------------------------------------- creep shapes
const enum T { UNDEFINED = 0, POINT = 1, CIRCLE = 2, ARC = 3 }
type Cls = "BEP" | "BEC" | "BEA" | "CUS" | "CUC" | "CUA";
/** A board item a creep shape stands for (PCB_SHAPE on Edge.Cuts, pad, track, via, zone, copper drawing). */
interface Parent { key: number; id: string; kiid: string; ri: RuleItem | null; box: number[] }
interface Shape {
  cls: Cls; type: T; conductive: boolean; parent: Parent | null; pos: V; radius: number;
  start: V; end: V; width: number; sa: number; ea: number; sp: V; ep: V;
}
const mk = (cls: Cls, o: Partial<Shape>): Shape => Object.assign({ cls, type: cls === "BEP" ? T.POINT : cls === "BEC" ? T.CIRCLE : cls === "BEA" || cls === "CUA" ? T.ARC : T.UNDEFINED,
  conductive: cls[0] === "C", parent: null, pos: [0, 0] as V, radius: 0, start: [0, 0] as V, end: [0, 0] as V, width: 0, sa: 0, ea: 0, sp: [0, 0] as V, ep: [0, 0] as V }, o);
const bePoint = (p: V) => mk("BEP", { pos: p });
const beCircle = (c: V, r: number) => mk("BEC", { pos: c, radius: Math.trunc(r) });
const beArc = (c: V, r: number, sa: number, ea: number, sp: V, ep: V) => mk("BEA", { pos: c, radius: Math.trunc(r), sa, ea, sp: rI(sp), ep: rI(ep) });
const cuSeg = (a: V, b: V, w = 0) => mk("CUS", { start: a, end: b, width: w, pos: [Math.trunc((a[0] + b[0]) / 2), Math.trunc((a[1] + b[1]) / 2)] });
const cuCircle = (c: V, r = 0) => mk("CUC", { pos: c, radius: r });
const cuArc = (c: V, r: number, sa: number, ea: number, sp: V, ep: V) => mk("CUA", { pos: c, radius: r, sa, ea, sp: rI(sp), ep: rI(ep) });
/** CREEP_SHAPE::GetRadius */
function radiusOf(s: Shape): number {
  if (s.cls === "CUS") return Math.trunc(norm(sub(s.start, s.end)) / 2) + Math.trunc(s.width / 2);
  return Math.trunc(s.radius);
}
/** AngleBetweenStartAndEnd: the point's angle brought into [start, end + 360]. */
function angleIn(s: Shape, p: V): number {
  let a = angleOf(sub(p, s.pos));
  while (a < s.sa) a += 360;
  while (a > s.ea + 360) a -= 360;
  return a;
}
interface PC { a1: V; a2: V; weight: number; show: boolean }
const pc = (a1: V, a2: V, weight: number): PC => ({ a1, a2, weight, show: true });
const reverse = (v: PC[]) => v.map((p) => pc(p.a2, p.a1, p.weight));

// ---------------------------------------------------------------- intersections (INTERSECTION_VISITOR)
function segSeg(p1: V, q1: V, p2: V, q2: V): V | null {
  const r = sub(q1, p1), s = sub(q2, p2), d = cross(r, s);
  if (d === 0) return null;
  const t = cross(sub(p2, p1), s) / d, u = cross(sub(p2, p1), r) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return rI(add(p1, mul(r, t)));
}
/** SEG::LineProject: the point projected onto the line (rescale rounds). */
function lineProject(A: V, B: V, P: V): V {
  const d = sub(B, A), l2 = dot(d, d); if (!l2) return A;
  const t = dot(d, sub(P, A)); return [A[0] + Math.round(t * d[0] / l2), A[1] + Math.round(t * d[1] / l2)];
}
/** SEG::Contains: within a squared distance of 3. */
function segContains(A: V, B: V, P: V): boolean {
  const d = sub(B, A), l2 = dot(d, d); let q = A;
  if (l2) { const t = dot(d, sub(P, A)); q = t < 0 ? A : t > l2 ? B : [A[0] + Math.round(t * d[0] / l2), A[1] + Math.round(t * d[1] / l2)]; }
  return sq(sub(P, q)) <= 3;
}
/** CIRCLE::IntersectLine (radius an int; a line within MIN_PRECISION_IU (4) of the radius is a tangent at the projection). */
function circleLine(A: V, B: V, c: V, radius: number): V[] {
  const R = Math.trunc(radius), m = lineProject(A, B, c), om = Math.trunc(norm(sub(m, c)));
  if (om > R + 4) return [];
  if (om >= R - 4) return [m];
  const d = Math.trunc(Math.sqrt(R * R - om * om)), v = rI(resize(sub(B, A), d));
  return [add(m, v), sub(m, v)];
}
/** CIRCLE::Intersect( SEG ) */
const segCircle = (p1: V, p2: V, c: V, r: number): V[] => circleLine(p1, p2, c, r).filter((ip) => segContains(p1, p2, ip));
/** SHAPE_ARC::sliceContainsPoint */
function sliceContains(c: V, start: V, sweep: number, p: V): boolean {
  let sa = angleOf(sub(start, c)); sa = ((sa % 360) + 360) % 360; const ea = sa + sweep;
  let phi = angleOf(sub(p, c)); phi = ((phi % 360) + 360) % 360;
  if (sweep >= 0) { while (phi < sa) phi += 360; return phi >= sa && phi <= ea; }
  while (phi > sa) phi -= 360; return phi <= sa && phi >= ea;
}
const TOL2 = 50 * 50;
const coincident = (a: V, b: V) => sq(sub(a, b)) <= TOL2;
/** segments_intersect: an intersection of two segments that share no end point. */
function segmentsIntersect(p1: V, q1: V, p2: V, q2: V, pts: V[]): boolean {
  if (eq(p1, p2) || eq(p1, q2) || eq(q1, p2) || eq(q1, q2)) return false;
  const x = segSeg(p1, q1, p2, q2); if (!x) return false; pts.push(x); return true;
}
/** segmentIntersectsCircle: crossings away from the segment's ends (a path may end on the circle). */
function segmentIntersectsCircle(p1: V, p2: V, c: V, r: number, pts?: V[]): boolean {
  const f = segCircle(p1, p2, c, r).filter((ip) => !coincident(ip, p1) && !coincident(ip, p2));
  if (pts) pts.push(...f); return f.length > 0;
}
/** segmentIntersectsArc: the arc of SHAPE_ARC( center, center + r·(cos sa, sin sa), ea - sa ) (SHAPE_ARC::IntersectLine within the segment). */
function segmentIntersectsArc(p1: V, p2: V, c: V, r: number, sa: number, ea: number, pts?: V[]): boolean {
  if (eq(p1, p2)) return false;
  const start = add(c, [Math.trunc(r * Math.cos(sa * RAD)), Math.trunc(r * Math.sin(sa * RAD))]), sweep = ea - sa;
  const f = circleLine(p1, p2, c, norm(sub(start, c))).filter((ip) => sliceContains(c, start, sweep, ip) && segContains(p1, p2, ip) && !coincident(ip, p1) && !coincident(ip, p2));
  if (pts) pts.push(...f); return f.length > 0;
}

// ---------------------------------------------------------------- Paths()
function bpp(a: Shape, b: Shape, _mw: number, mw2: number): PC[] {
  const w = sq(sub(a.pos, b.pos)); if (w > mw2) return [];
  return [pc(a.pos, b.pos, Math.sqrt(w))];
}
function bpc(a: Shape, b: Shape, _mw: number, mw2: number): PC[] {
  const radius = radiusOf(b), p = a.pos, c = b.pos; if (radius <= 0) return [];
  const d2 = sq(sub(p, c)), w2 = d2 - Math.fround(radius) * Math.fround(radius);
  if (w2 > mw2) return [];
  const d1 = resize(sub(p, c), 1), d2v = perp(d1), r2 = radius * radius, dist = Math.sqrt(d2), v1 = r2 / dist, v2 = Math.sqrt(r2 - v1 * v1);
  const t = (v: V): V => [Math.trunc(v[0]), Math.trunc(v[1])];
  return [pc(p, t(add(add(mul(d1, v1), mul(d2v, v2)), c)), Math.sqrt(w2)), pc(p, t(add(sub(mul(d1, v1), mul(d2v, v2)), c)), Math.sqrt(w2))];
}
/** BE_SHAPE_ARC::IsThereATangentPassingThroughPoint */
function tangentThrough(arc: Shape, point: V): [boolean, boolean] {
  const R = arc.radius, np = sub(point, arc.pos);
  if (sq(np) <= R * R) return [false, false];
  const pa = angleIn(arc, point) * RAD, s = arc.sa * RAD, e = arc.ea * RAD, gt180 = arc.ea - arc.sa > 180;
  const cs = Math.cos(s) * np[0] + Math.sin(s) * np[1], ce = Math.cos(e) * np[0] + Math.sin(e) * np[1];
  let toEnd = cs >= R; if (gt180) toEnd = toEnd && ce <= R; toEnd = toEnd || (ce <= R && (pa >= e || pa <= s));
  const first = !toEnd;
  toEnd = ce >= R; if (gt180) toEnd = toEnd && cs <= R; toEnd = toEnd || (cs <= R && (pa >= e || pa <= s));
  return [first, !toEnd];
}
function bpa(a: Shape, b: Shape, mw: number, mw2: number): PC[] {
  const [f, s] = tangentThrough(b, a.pos), csc = beCircle(b.pos, b.radius);
  if (f && s) return bpc(a, csc, mw, mw2);
  const out: PC[] = [];
  if (f) { const ps = bpc(a, csc, mw, mw2); if (ps.length > 1) out.push(ps[1]); }
  else out.push(...bpp(a, bePoint(b.sp), mw, mw2));
  if (s) { const ps = bpc(a, csc, mw, mw2); if (ps.length > 1) out.push(ps[0]); }
  else out.push(...bpp(a, bePoint(b.ep), mw, mw2));
  return out;
}
function bca(a: Shape, b: Shape, mw: number, mw2: number): PC[] {
  const out: PC[] = [];
  if (norm(sub(a.pos, b.pos)) + b.radius < a.radius) return out;
  for (const p of bcc(a, beCircle(b.pos, b.radius), mw, mw2)) if (angleIn(b, p.a2) <= b.ea) out.push(p);
  if (out.length === 4) return out;
  for (const q of [bePoint(b.sp), bePoint(b.ep)]) for (const p of paths(a, q, mw, mw2)) if (!segmentIntersectsArc(p.a1, p.a2, b.pos, b.radius, b.sa, b.ea)) out.push(p);
  return out;
}
function baa(a: Shape, b: Shape, mw: number, mw2: number): PC[] {
  const out: PC[] = [];
  if (norm(sub(a.pos, b.pos)) + b.radius < a.radius) return out;
  for (const p of paths(a, beCircle(b.pos, b.radius), mw, mw2)) if (angleIn(b, p.a2) <= b.ea) out.push(p);
  for (const p of bca(beCircle(a.pos, a.radius), b, mw, mw2)) if (angleIn(a, p.a1) <= a.ea) out.push(p);
  return out;
}
function bcc(a: Shape, b: Shape, _mw: number, mw2: number): PC[] {
  const out: PC[] = [], p1 = a.pos, p2 = b.pos, w2 = sq(sub(p2, p1)), R1 = a.radius, R2 = b.radius;
  const Rd = Math.abs(R1 - R2), Rs = R1 + R2, w21 = w2 - Rd * Rd, w22 = w2 - Rs * Rs;
  const d1 = resize(sub(p2, p1), 1), d2 = perp(d1), D = Math.sqrt(w2);
  if (w21 <= mw2) {
    const r1 = (R1 - R2) / D, r2 = Math.sqrt(1 - r1 * r1), w = Math.sqrt(w21);
    out.push(pc(add(add(p1, mul(d1, R1 * r1)), mul(d2, R1 * r2)), add(add(p2, mul(d1, R2 * r1)), mul(d2, R2 * r2)), w));
    out.push(pc(sub(add(p1, mul(d1, R1 * r1)), mul(d2, R1 * r2)), sub(add(p2, mul(d1, R2 * r1)), mul(d2, R2 * r2)), w));
  }
  if (w22 <= mw2) {
    const r1 = (R1 + R2) / D, r2 = Math.sqrt(1 - r1 * r1), w = Math.sqrt(w22);
    out.push(pc(add(add(p1, mul(d1, R1 * r1)), mul(d2, R1 * r2)), sub(sub(p2, mul(d1, R2 * r1)), mul(d2, R2 * r2)), w));
    out.push(pc(sub(add(p1, mul(d1, R1 * r1)), mul(d2, R1 * r2)), add(sub(p2, mul(d1, R2 * r1)), mul(d2, R2 * r2)), w));
  }
  return out;
}
function csp(a: Shape, b: Shape, _mw: number, mw2: number): PC[] {
  const s = a.start, e = a.end, hw = a.width / 2, ta = angleOf(sub(e, s)) * RAD, p = b.pos, len = norm(sub(s, e));
  const proj = Math.cos(ta) * (p[0] - s[0]) + Math.sin(ta) * (p[1] - s[1]);
  let np: V;
  if (proj <= 0) np = rI(add(s, resize(sub(p, s), hw)));
  else if (proj >= len) np = rI(add(e, resize(sub(p, e), hw)));
  else {
    let pos = sq(sub(s, p)) - sq(sub(e, p)); pos = pos / (2 * len) + len / 2;
    np = rI(add(s, resize(sub(e, s), pos))); np = rI(add(np, resize(sub(p, np), hw)));
  }
  const w2 = sq(sub(p, np)); if (w2 > mw2) return [];
  return [pc(np, p, Math.sqrt(w2))];
}
function cscBe(a: Shape, b: Shape, mw: number, mw2: number): PC[] {
  const out: PC[] = [], s = a.start, e = a.end, hw = a.width / 2, cr = b.radius, cc = b.pos, len = norm(sub(s, e)), ta = angleOf(sub(e, s)) * RAD;
  let p1 = Math.cos(ta) * (cc[0] - s[0]) + Math.sin(ta) * (cc[1] - s[1]); const p2 = p1 + cr; p1 = p1 - cr;
  const side = cross(sub(e, s), sub(cc, s)) > 0 ? 1 : -1, dir = sub(e, s), off = rI(mul(rI(resize(perp(dir), hw)), side));
  const onTrack = (pos: number): V => add(add(s, rI(resize(dir, pos))), off);
  if (p1 < 0 && p2 < 0) out.push(...ccbc(cuCircle(s, hw), b, mw, mw2));
  else if (p1 > len && p2 > len) out.push(...ccbc(cuCircle(e, hw), b, mw, mw2));
  else if (p1 >= 0 && p1 <= len && p2 >= 0 && p2 <= len) {
    let pt1 = onTrack(p1), pc1 = sub(cc, rI(resize(dir, cr))); const w2 = sq(sub(pc1, pt1));
    if (w2 < mw2) {
      out.push(pc(pt1, pc1, Math.sqrt(w2)));
      pt1 = onTrack(p2); pc1 = add(cc, rI(resize(dir, cr)));
      out.push(pc(pt1, pc1, Math.sqrt(w2)));
    }
  } else if (p1 >= 0 && p1 <= len && (p2 > len || p2 < 0)) {
    const ps = ccbc(cuCircle(e, hw), b, mw, mw2); if (ps.length < 2) return out;
    out.push(ps[side === 1 ? 1 : 0]);
    const pt1 = onTrack(p1), pc1 = sub(cc, rI(resize(dir, cr))), w2 = sq(sub(pc1, pt1));
    if (w2 < mw2) out.push(pc(pt1, pc1, Math.sqrt(w2)));
  } else if (p2 >= 0 && p2 <= len && (p1 > len || p1 < 0)) {
    const ps = ccbc(cuCircle(s, hw), b, mw, mw2); if (ps.length < 2) return out;
    out.push(ps[side === 1 ? 0 : 1]);
    const pt1 = onTrack(p2), pc1 = add(cc, rI(resize(dir, cr))), w2 = sq(sub(pc1, pt1));
    if (w2 < mw2) out.push(pc(pt1, pc1, Math.sqrt(w2)));
  } else if (p1 < 0 && p2 > len) {
    const sp = ccbc(cuCircle(s, hw), b, mw, mw2); if (sp.length >= 2) out.push(sp[side === 1 ? 0 : 1]);
    const ep = ccbc(cuCircle(e, hw), b, mw, mw2); if (ep.length >= 2) out.push(ep[side === 1 ? 1 : 0]);
  }
  return out;
}
/** CU_SHAPE_* to a board edge arc: the paths to its circle that land on the arc, else to its ends unless they cross it. */
function toBeArc(a: Shape, b: Shape, mw: number, mw2: number, viaCircle: (c: Shape) => PC[]): PC[] {
  const out: PC[] = [];
  for (const p of viaCircle(beCircle(b.pos, b.radius))) if (angleIn(b, p.a2) < b.ea) out.push(p);
  if (out.length < 2) for (const q of [bePoint(b.sp), bePoint(b.ep)]) for (const p of paths(a, q, mw, mw2)) if (!segmentIntersectsArc(p.a1, p.a2, b.pos, b.radius, b.sa, b.ea)) out.push(p);
  return out;
}
const csaBe = (a: Shape, b: Shape, mw: number, mw2: number) => toBeArc(a, b, mw, mw2, (c) => cscBe(a, c, mw, mw2));
const ccba = (a: Shape, b: Shape, mw: number, mw2: number) => toBeArc(a, b, mw, mw2, (c) => ccbc(a, c, mw, mw2));
const caba = (a: Shape, b: Shape, mw: number, mw2: number) => toBeArc(a, b, mw, mw2, (c) => cabc(a, c, mw, mw2));
function cabc(a: Shape, _b: Shape, mw: number, mw2: number): PC[] {
  // CU_SHAPE_ARC::Paths( BE_SHAPE_CIRCLE ) measures against the arc's own outer circle, as KiCad does
  const out: PC[] = [], csc = cuCircle(a.pos, radiusOf(a) + a.width / 2);
  for (const p of paths(a, csc, mw, mw2)) if (angleIn(a, p.a2) < a.ea) out.push(p);
  if (out.length < 2) { for (const p of paths(a, cuCircle(a.sp, a.width / 2), mw, mw2)) out.push(p); for (const p of paths(a, cuCircle(a.ep, a.width / 2), mw, mw2)) out.push(p); }
  return out;
}
function ccbp(a: Shape, b: Shape, mw: number): PC[] {
  const R = radiusOf(a), c = a.pos, p = b.pos, w = norm(sub(c, p)) - R;
  if (w > mw) return [];
  return [pc(add(c, rI(resize(sub(p, c), R))), p, Math.max(w, 0))];
}
function cccc(a: Shape, b: Shape, mw: number): PC[] {
  const R1 = radiusOf(a), R2 = radiusOf(b), C1 = a.pos, C2 = b.pos;
  if (sq(sub(C1, C2)) < (R1 - R2) * (R1 - R2)) return [];
  const w = norm(sub(C1, C2)) - R1 - R2; if (w > mw || w < 0) return [];
  return [pc(add(rI(resize(sub(C2, C1), R1)), C1), add(rI(resize(sub(C1, C2), R2)), C2), Math.max(w, 0))];
}
function cscc(a: Shape, b: Shape, mw: number, mw2: number): PC[] {
  const s = a.start, e = a.end, hw = a.width / 2, ta = angleOf(sub(e, s)) * RAD, p = b.pos, len = norm(sub(s, e));
  const proj = Math.cos(ta) * (p[0] - s[0]) + Math.sin(ta) * (p[1] - s[1]);
  if (proj <= 0 || eq(s, e)) return cccc(cuCircle(s, hw), b, mw);
  if (proj >= len) return cccc(cuCircle(e, hw), b, mw);
  const r = radiusOf(b), side = cross(sub(e, s), sub(p, s)) > 0 ? 1 : -1;
  const a1 = add(add(s, rI(resize(sub(e, s), proj))), rI(mul(rI(resize(perp(sub(e, s)), hw)), side)));
  const a2 = add(rI(resize(sub(a1, p), r)), p);
  const w2 = sq(sub(a2, a1)); return w2 <= mw2 ? [pc(a1, a2, Math.sqrt(w2))] : [];
}
function ccca(a: Shape, b: Shape, mw: number, mw2: number): PC[] {
  const cp = a.pos, ap = b.pos, cr = radiusOf(a), ar = radiusOf(b);
  if (norm(sub(cp, ap)) > ar + cr) {
    const ps = cccc(a, cuCircle(ap, ar + b.width / 2), mw);
    if (ps.length === 1 && angleIn(b, ps[0].a2) < b.ea) return [ps[0]];
  }
  let best: PC | null = null;
  const consider = (p: PC) => { if (!best || (best.weight > p.weight && p.weight > 0)) best = p; };
  for (const p of paths(a, cuCircle(b.sp, b.width / 2), mw, mw2)) consider(p);
  for (const p of paths(a, cuCircle(b.ep, b.width / 2), mw, mw2)) consider(p);
  if (sq(sub(cp, ap)) < ar * ar && !eq(cp, ap) && angleIn(b, cp) < b.ea) {
    consider(pc(add(cp, rI(resize(sub(cp, ap), cr))), add(ap, rI(resize(sub(cp, ap), ar - b.width / 2))), Math.max(ar - norm(sub(cp, ap)) - cr, 0)));
  }
  const bb = best as PC | null;
  return bb && bb.weight > 0 ? [bb] : [];
}
function csca(a: Shape, b: Shape, mw: number, mw2: number): PC[] {
  const hw1 = a.width / 2, hw2 = b.width / 2;
  const ps = cscc(a, cuCircle(b.pos, radiusOf(b) + hw2), mw, mw2);
  if (ps.length < 1) return [];
  if (angleIn(b, ps[0].a1) < b.ea) return [ps[0]];
  let best: PC | null = null; const consider = (p: PC) => { if (!best || best.weight > p.weight) best = p; };
  for (const p of cscc(a, cuCircle(b.sp, hw2), mw, mw2)) consider(p);
  for (const p of cscc(a, cuCircle(b.ep, hw2), mw, mw2)) consider(p);
  for (const p of ccca(cuCircle(a.start, hw1), b, mw, mw2)) consider(p);
  for (const p of ccca(cuCircle(a.end, hw1), b, mw, mw2)) consider(p);
  return best ? [best] : [];
}
/** closestPointOnSegment */
function closest(A: V, B: V, P: V): V {
  if (eq(A, B) || eq(A, P)) return A;
  const AB = sub(B, A), AP = sub(P, A); let t = Math.fround(dot(AB, AP)) / Math.fround(sq(AB)); t = Math.max(0, Math.min(1, t));
  return rI(add(A, mul(AB, t)));
}
function csss(a: Shape, b: Shape, mw: number): PC[] {
  const A = a.start, B = a.end, C = b.start, D = b.end, hw1 = a.width / 2, hw2 = b.width / 2;
  const P1 = closest(A, B, C), P2 = closest(A, B, D), P3 = closest(C, D, A), P4 = closest(C, D, B);
  const d = [sq(sub(P1, C)), sq(sub(P2, D)), sq(sub(P3, A)), sq(sub(P4, B))];
  let min = d[0], c1 = P1, c2 = C;
  if (d[1] < min) { min = d[1]; c1 = P2; c2 = D; }
  if (d[2] < min) { min = d[2]; c1 = A; c2 = P3; }
  if (d[3] < min) { min = d[3]; c1 = B; c2 = P4; }
  const p = pc(add(c1, rI(resize(sub(c2, c1), hw1))), add(c2, rI(resize(sub(c1, c2), hw2))), Math.max(Math.sqrt(min) - hw1 - hw2, 0));
  return p.weight <= mw ? [p] : [];
}
function ccbc(a: Shape, b: Shape, mw: number, _mw2?: number): PC[] {
  const R1 = radiusOf(a), R2 = radiusOf(b), c1 = a.pos, c2 = b.pos, dist = norm(sub(c1, c2)), reach = mw + R1;
  if (dist === 0 || dist * dist > reach * reach + R2 * R2) return [];
  const ca = angleOf(sub(c2, c1)) * RAD;
  if (dist <= R2) {
    const w = Math.max(R2 - dist - R1, 0); if (w > mw) return [];
    const ra = ca + Math.PI, cx = Math.cos(ra), cy = Math.sin(ra);
    const p = pc(add(c1, [Math.trunc(R1 * cx), Math.trunc(R1 * cy)]), add(c2, [Math.trunc(R2 * cx), Math.trunc(R2 * cy)]), w);
    return [p, p];
  }
  const w = Math.sqrt(dist * dist - R2 * R2) - R1, th = Math.asin(R2 / dist), psi = Math.acos(R2 / dist);
  if (w > mw) return [];
  const T = (v: number) => Math.trunc(v);
  return [
    pc(add([T(R1 * Math.cos(th + ca)), T(R1 * Math.sin(th + ca))], c1), add([T(-R2 * Math.cos(psi - ca)), T(R2 * Math.sin(psi - ca))], c2), Math.max(w, 0)),
    pc(add([T(R1 * Math.cos(-th + ca)), T(R1 * Math.sin(-th + ca))], c1), add([T(-R2 * Math.cos(-psi - ca)), T(R2 * Math.sin(-psi - ca))], c2), Math.max(w, 0)),
  ];
}
function cabp(a: Shape, b: Shape, mw: number): PC[] {
  const p = b.pos, c = a.pos, r = radiusOf(a), w = a.width;
  if (angleIn(a, p) < a.ea) {
    if (sq(sub(p, c)) > r * r) return ccbp(cuCircle(c, r + w / 2), b, mw);
    const weight = Math.max((r - w / 2) - norm(sub(p, c)), 0);
    return weight > 0 && weight < mw ? [pc(add(rI(resize(sub(p, c), r - w / 2)), c), p, weight)] : [];
  }
  const near = sq(sub(p, a.sp)) > sq(sub(p, a.ep)) ? a.ep : a.sp;
  return ccbp(cuCircle(near, w / 2), b, mw);
}
function caca(a: Shape, b: Shape, mw: number, mw2: number): PC[] {
  let best: PC = pc([0, 0], [0, 0], Infinity);
  const c1 = cuCircle(a.pos, radiusOf(a) + a.width / 2), c2 = cuCircle(b.pos, radiusOf(b) + b.width / 2);
  for (const ps of [cccc(c1, c2, mw), paths(a, c2, mw, mw2), ccca(c1, b, mw, mw2)])
    for (const p of ps) if (angleIn(a, p.a1) < a.ea && angleIn(b, p.a2) < b.ea && best.weight > p.weight) best = p;
  const c3 = cuCircle(a.sp, a.width / 2), c4 = cuCircle(a.ep, a.width / 2), c5 = cuCircle(b.sp, b.width / 2), c6 = cuCircle(b.ep, b.width / 2);
  for (const ps of [paths(a, c5, mw, mw2), paths(a, c6, mw, mw2), ccca(c3, b, mw, mw2), ccca(c4, b, mw, mw2)]) for (const p of ps) if (best.weight > p.weight) best = p;
  return best.weight !== Infinity ? [best] : [];
}
/** a.Paths( b ) with the overload of b's class and the override of a's (CREEP_SHAPE's virtual table). */
function paths(a: Shape, b: Shape, mw: number, mw2: number): PC[] {
  switch (a.cls) {
    case "BEP": return b.cls === "BEP" ? bpp(a, b, mw, mw2) : b.cls === "BEC" ? bpc(a, b, mw, mw2) : b.cls === "BEA" ? bpa(a, b, mw, mw2) : reverse(paths(b, a, mw, mw2));
    case "BEC": return b.cls === "BEP" ? reverse(bpc(b, a, mw, mw2)) : b.cls === "BEC" ? bcc(a, b, mw, mw2) : b.cls === "BEA" ? bca(a, b, mw, mw2) : b.cls === "CUA" ? [] : reverse(paths(b, a, mw, mw2));
    case "BEA": return b.cls === "BEA" ? baa(a, b, mw, mw2) : reverse(paths(b, a, mw, mw2));
    case "CUS": return b.cls === "BEP" ? csp(a, b, mw, mw2) : b.cls === "BEC" ? cscBe(a, b, mw, mw2) : b.cls === "BEA" ? csaBe(a, b, mw, mw2) : b.cls === "CUS" ? csss(a, b, mw) : b.cls === "CUC" ? cscc(a, b, mw, mw2) : csca(a, b, mw, mw2);
    case "CUC": return b.cls === "BEP" ? ccbp(a, b, mw) : b.cls === "BEC" ? ccbc(a, b, mw) : b.cls === "BEA" ? ccba(a, b, mw, mw2) : b.cls === "CUS" ? reverse(cscc(b, a, mw, mw2)) : b.cls === "CUC" ? cccc(a, b, mw) : ccca(a, b, mw, mw2);
    case "CUA": return b.cls === "BEP" ? cabp(a, b, mw) : b.cls === "BEC" ? cabc(a, b, mw, mw2) : b.cls === "BEA" ? caba(a, b, mw, mw2) : b.cls === "CUS" ? reverse(csca(b, a, mw, mw2)) : b.cls === "CUC" ? reverse(ccca(b, a, mw, mw2)) : caca(a, b, mw, mw2);
  }
}

// ---------------------------------------------------------------- board edges (BuildCreepageBoardEdges)
/** An Edge.Cuts PCB_SHAPE (or an NPTH hole's transient shape) in nm. */
interface EdgeItem { parent: Parent; shape: "segment" | "rect" | "poly" | "circle" | "arc"; start: V; end: V; center: V; mid: V; radius: number; cornerRadius: number; pts: V[]; sa: number; ea: number; /** the pad of an NPTH hole's transient shape */ hole?: string }
/** EDA_SHAPE::SetArcGeometry + CalcArcAngles: the ends ordered so the angle grows from start to end through mid. */
function arcGeom(a: V, m: V, b: V): { center: V; radius: number; start: V; end: V; sa: number; ea: number } | null {
  const arc = K.arcFrom3([a[0] / IU, a[1] / IU], [m[0] / IU, m[1] / IU], [b[0] / IU, b[1] / IU]); if (!arc) return null;
  const c: V = [Math.round(arc.x * IU), Math.round(arc.y * IU)];
  let start = a, end = b, sa = angleOf(sub(start, c)), ea = angleOf(sub(end, c));
  const sweep = (x: number, y: number) => { let d = y - x; while (d < 0) d += 360; return d; };
  if (sweep(sa, angleOf(sub(m, c))) > sweep(sa, ea)) { [start, end] = [end, start]; [sa, ea] = [ea, sa]; }   // the mid lies on the other side: swap
  if (ea === sa) ea = sa + 360;
  while (ea < sa) ea += 360;
  return { center: c, radius: norm(sub(start, c)), start, end, sa, ea };
}
function edgeItems(doc: BoardDoc, newParent: (id: string, kiid: string, box: number[]) => Parent): EdgeItem[] {
  const out: EdgeItem[] = [];
  const blank = (): Omit<EdgeItem, "parent" | "shape"> => ({ start: [0, 0], end: [0, 0], center: [0, 0], mid: [0, 0], radius: 0, cornerRadius: 0, pts: [], sa: 0, ea: 0 });
  const take = (id: string, kind: string, node: SNode, tf: (p: number[]) => V, frot: number) => {
    if (layerOf(node, "") !== "Edge.Cuts") return;
    const st = K.kid(node, "stroke"), w = st ? K.num((K.kid(st, "width") || [0, 0])[1], 0) : K.num((K.kid(node, "width") || [0, 0])[1], 0);
    const P = (k: string) => { const p = pt(node, k); return p ? tf(p) : null; };
    const items: EdgeItem[] = [];
    const push = (e: Omit<EdgeItem, "parent">) => items.push(e as EdgeItem);
    if (kind === "line") { const a = P("start"), b = P("end"); if (a && b) push({ ...blank(), shape: "segment", start: a, end: b }); }
    else if (kind === "rect") {
      const a = pt(node, "start"), b = pt(node, "end"); if (!a || !b) return;
      const cr = K.kid(node, "radius"), rr = cr ? Math.round(K.num(cr[1], 0) * IU) : 0;
      const corners = [tf(a), tf([b[0], a[1]]), tf(b), tf([a[0], b[1]])];
      if (((frot % 90) + 90) % 90 === 0) push({ ...blank(), shape: "rect", start: corners[0], end: corners[2], cornerRadius: rr });
      else push({ ...blank(), shape: "poly", pts: corners });   // a rectangle turned off the axes is a polygon
    }
    else if (kind === "poly") { const pts = K.ptsOf(node).map((p) => tf(p)); if (pts.length) push({ ...blank(), shape: "poly", pts }); }
    else if (kind === "circle") { const c = P("center"), e = P("end"); if (c && e) push({ ...blank(), shape: "circle", center: c, end: e, radius: norm(sub(e, c)) }); }
    else if (kind === "arc") { const a = P("start"), m = P("mid"), b = P("end"); if (a && m && b) { const g = arcGeom(a, m, b); if (g) push({ ...blank(), shape: "arc", start: g.start, end: g.end, mid: m, center: g.center, radius: g.radius, sa: g.sa, ea: g.ea }); } }
    else if (kind === "curve") {
      // RebuildBezierToSegmentsPointsList: the curve as segments, each its own owned shape
      const pts = K.bezierPts(K.ptsOf(node).map((p) => { const q = tf(p); return [q[0] / IU, q[1] / IU]; })).map((p: number[]) => toIU(p));
      for (let i = 1; i < pts.length; i++) if (!eq(pts[i - 1], pts[i])) out.push(Object.assign({ ...blank(), shape: "segment" as const, start: pts[i - 1], end: pts[i] }, { parent: newParent("", "", boxOfPts([pts[i - 1], pts[i]], 0)) }));
      return;
    }
    if (!items.length) return;
    const e = items[0], box = e.shape === "circle" ? [e.center[0] - e.radius, e.center[1] - e.radius, e.center[0] + e.radius, e.center[1] + e.radius]
      : e.shape === "arc" ? [e.center[0] - e.radius, e.center[1] - e.radius, e.center[0] + e.radius, e.center[1] + e.radius]
      : boxOfPts(e.shape === "poly" ? e.pts : [e.start, e.end], 0);
    e.parent = newParent(id, K.uuidOf(node) || "", inflateBox(box, Math.round(w * IU) / 2));
    out.push(e);
  };
  for (const it of doc.items.values()) {
    if (/^gr_(line|rect|circle|arc|poly|curve)$/.test(it.kind)) take(it.id, it.kind.slice(3), it.node, (p) => toIU(p), 0);
  }
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    const [fx, fy, frot] = K.atOf(it.node); const R = rotator(frot);
    for (const g of it.node) if (isList(g) && /^fp_(line|rect|circle|arc|poly|curve)$/.test(g[0] as string)) take(it.id, (g[0] as string).slice(3), g as SNode, (p) => { const [dx, dy] = R(p[0], p[1]); return toIU([fx + dx, fy + dy]); }, frot);
  }
  // NPTH holes: a circle, or a slot as two sides and two half-circle caps (each a transient shape of its own)
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    const [fx, fy, frot] = K.atOf(it.node); const R = rotator(frot);
    for (const pad of K.kids(it.node, "pad")) {
      if (K.str(pad[2]) !== "np_thru_hole") continue;
      const [px, py, prot] = K.atOf(pad); const [rx, ry] = R(px, py); const pos = toIU([fx + rx, fy + ry]);
      const dr = K.kid(pad, "drill"); if (!dr) continue;
      const oval = dr[1] === "oval"; const dx = Math.round(K.num(oval ? dr[2] : dr[1], 0) * IU), dy = oval ? Math.round(K.num(dr[3], K.num(dr[2], 0)) * IU) : dx;
      const hs: V = [Math.trunc(dx / 2), Math.trunc(dy / 2)]; let hw: number, hl: V = [0, 0];
      if (!oval) hw = hs[0]; else { hw = Math.min(hs[0], hs[1]); hl = [hs[0] - hw, hs[1] - hw]; }
      const t = rotator(prot)(hl[0], hl[1]); hl = [Math.round(t[0]), Math.round(t[1])];
      const A = sub(pos, hl), B = add(pos, hl), radius = hw;
      const kiid = K.uuidOf(pad) || "";
      if (eq(A, B)) { out.push({ ...blank(), shape: "circle", center: A, end: add(A, [radius, 0]), radius, hole: "c", parent: newParent(it.id, kiid, [A[0] - radius, A[1] - radius, A[0] + radius, A[1] + radius]) }); continue; }
      const axis = sub(B, A), pp = rI(resize(perp(axis), radius));
      const holeKey = it.id + "#" + kiid + "#" + px + "," + py;
      const own = (e: Omit<EdgeItem, "parent">, pts: V[]) => out.push(Object.assign(e, { hole: holeKey, parent: newParent(it.id, kiid, inflateBox(boxOfPts(pts, 0), 0)) }));
      own({ ...blank(), shape: "segment", start: add(A, pp), end: add(B, pp) }, [add(A, pp), add(B, pp)]);
      own({ ...blank(), shape: "segment", start: sub(A, pp), end: sub(B, pp) }, [sub(A, pp), sub(B, pp)]);
      const midA = sub(A, rI(resize(axis, radius))), midB = add(B, rI(resize(axis, radius)));
      for (const [s, m, e] of [[add(A, pp), midA, sub(A, pp)], [sub(B, pp), midB, add(B, pp)]] as [V, V, V][]) {
        const g = arcGeom(s, m, e); if (!g) continue;
        own({ ...blank(), shape: "arc", start: g.start, end: g.end, mid: m, center: g.center, radius: g.radius, sa: g.sa, ea: g.ea }, [add(g.center, [-g.radius, -g.radius]), add(g.center, [g.radius, g.radius])]);
      }
    }
  }
  return out;
}
const boxOfPts = (pts: V[], o: number) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0 - o, y0 - o, x1 + o, y1 + o]; };
const inflateBox = (b: number[], o: number) => [b[0] - o, b[1] - o, b[2] + o, b[3] + o];

/** SegmentIntersectsBoard: true when the segment crosses no board edge (the minimum groove width is 0). */
function segmentClearOfBoard(p1: V, p2: V, edges: EdgeItem[]): boolean {
  const pts: V[] = [];
  for (const d of edges) {
    if (d.shape === "segment") { if (segmentsIntersect(p1, p2, d.start, d.end, pts)) return false; }
    else if (d.shape === "rect") {
      const r = d.cornerRadius;
      if (r > 0) {
        const x1 = Math.min(d.start[0], d.end[0]), y1 = Math.min(d.start[1], d.end[1]), x2 = Math.max(d.start[0], d.end[0]), y2 = Math.max(d.start[1], d.end[1]), w = x2 - x1, h = y2 - y1;
        let hit = false;
        if (w > 2 * r) { hit = segmentsIntersect(p1, p2, [x1 + r, y1], [x2 - r, y1], pts) || hit; hit = segmentsIntersect(p1, p2, [x2 - r, y2], [x1 + r, y2], pts) || hit; }
        if (h > 2 * r) { hit = segmentsIntersect(p1, p2, [x2, y1 + r], [x2, y2 - r], pts) || hit; hit = segmentsIntersect(p1, p2, [x1, y2 - r], [x1, y1 + r], pts) || hit; }
        if (hit) return false;
        const arcs: [V, number, number][] = h === 2 * r ? [[[x1 + r, y1 + r], 90, 270], [[x2 - r, y1 + r], -90, 90]]
          : w === 2 * r ? [[[x1 + r, y1 + r], -180, 0], [[x1 + r, y2 - r], 0, 180]]
          : [[[x1 + r, y1 + r], -180, -90], [[x2 - r, y1 + r], -90, 0], [[x2 - r, y2 - r], 0, 90], [[x1 + r, y2 - r], 90, 180]];
        for (const [c, sa, ea] of arcs) if (segmentIntersectsArc(p1, p2, c, r, sa, ea, pts)) return false;
      } else {
        const c1 = d.start, c2: V = [d.start[0], d.end[1]], c3 = d.end, c4: V = [d.end[0], d.start[1]];
        let hit = false; for (const [a, b] of [[c1, c2], [c2, c3], [c3, c4], [c4, c1]]) hit = segmentsIntersect(p1, p2, a, b, pts) || hit;
        if (hit) return false;
      }
    }
    else if (d.shape === "poly") {
      if (d.pts.length < 2) continue;
      let prev = d.pts[d.pts.length - 1], hit = false; for (const p of d.pts) { hit = segmentsIntersect(p1, p2, prev, p, pts) || hit; prev = p; }
      if (hit) return false;
    }
    else if (d.shape === "circle") { if (segmentIntersectsCircle(p1, p2, d.center, d.radius, pts)) return false; }
    else if (d.shape === "arc") { if (segmentIntersectsArc(p1, p2, d.center, d.radius, d.sa, d.ea, pts)) return false; }
  }
  return true;
}

// ---------------------------------------------------------------- the board outline (GetBoardPolygonOutlines with the NPTH holes)
interface Outline { loops: V[][]; contains(p: V, tol: number): boolean }
function boardOutline(doc: BoardDoc, edges: EdgeItem[]): Outline | null {
  const { chains } = edgeShapes(doc); if (!chains.length) return null;
  const { loops, dangling } = chainLoops(chains); if (!loops.length || dangling) return null;
  const all: V[][] = loops.map((l) => l.map((p) => toIU(p)));
  // NPTH holes are outline holes
  for (const e of edges) {
    if (e.hole && e.shape === "circle") { const pts: V[] = []; for (let i = 0; i < 64; i++) pts.push([e.center[0] + e.radius * Math.cos(i * Math.PI / 32), e.center[1] + e.radius * Math.sin(i * Math.PI / 32)]); all.push(pts); }
  }
  const slots = new Map<string, EdgeItem[]>(); for (const e of edges) if (e.hole && (e.shape === "segment" || e.shape === "arc")) { const l = slots.get(e.hole) || []; l.push(e); slots.set(e.hole, l); }
  for (const parts of slots.values()) {
    if (parts.length !== 4) continue;
    const [s1, s2, a1, a2] = parts; const pts: V[] = [s1.start, s1.end];
    const arcPts = (a: EdgeItem) => { const o: V[] = []; for (let i = 0; i <= 16; i++) { const t = (a.sa + (a.ea - a.sa) * i / 16) * RAD; o.push([a.center[0] + a.radius * Math.cos(t), a.center[1] + a.radius * Math.sin(t)]); } return o; };
    const near = (a: EdgeItem, from: V) => { const o = arcPts(a); return sq(sub(o[0], from)) <= sq(sub(o[o.length - 1], from)) ? o : o.reverse(); };
    // the slot as one loop: a side, the cap at its end, the other side back, the other cap
    const [endCap, startCap] = sq(sub(a2.center, s1.end)) < sq(sub(a1.center, s1.end)) ? [a2, a1] : [a1, a2];
    pts.push(...near(endCap, s1.end), s2.end, s2.start, ...near(startCap, s2.start)); all.push(pts);
  }
  const onEdge = (p: V, tol: number) => { for (const l of all) for (let i = 0, j = l.length - 1; i < l.length; j = i++) { const a = l[j], b = l[i], ab = sub(b, a), L = sq(ab); let t = L ? dot(sub(p, a), ab) / L : 0; t = Math.max(0, Math.min(1, t)); if (norm(sub(p, add(a, mul(ab, t)))) <= tol) return true; } return false; };
  const inside = (p: V) => { let c = false; for (const l of all) for (let i = 0, j = l.length - 1; i < l.length; j = i++) { const a = l[i], b = l[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  return { loops: all, contains: (p, tol) => inside(p) || onEdge(p, tol) };
}

// ---------------------------------------------------------------- the graph
const enum N { POINT = 0, CIRCLE = 1, ARC = 2, SEGMENT = 3, VIRTUAL = 4 }
interface GNode { idx: number; type: N; parent: Shape | null; pos: V; conns: GConn[]; connectDirectly: boolean; net: number }
interface GConn { n1: GNode; n2: GNode; path: PC; forceStraight: boolean }
interface TrackEntry { a: V; b: V; hw: number; parent: Parent; box: number[] }

class Graph {
  nodes: GNode[] = []; conns: GConn[] = []; shapes: Shape[] = []; nodeset = new Map<string, GNode>();
  edges: EdgeItem[] = []; outline: Outline | null = null; target = -1; overlappingCutouts = false; shapeIds = new Map<Shape, number>();
  private sid(s: Shape | null) { if (!s) return -1; let v = this.shapeIds.get(s); if (v === undefined) { v = this.shapeIds.size; this.shapeIds.set(s, v); } return v; }
  private key(type: N, parent: Shape | null, pos: V) { return type + "|" + this.sid(parent) + "|" + pos[0] + "|" + pos[1]; }
  addNode(type: N, parent: Shape | null, pos: V): GNode {
    const p = rI(pos), k = this.key(type, parent, p), was = this.nodeset.get(k); if (was) return was;
    const n: GNode = { idx: this.nodes.length, type, parent, pos: p, conns: [], connectDirectly: true, net: -1 };
    this.nodes.push(n); this.nodeset.set(k, n); return n;
  }
  addVirtual(): GNode { const n: GNode = { idx: this.nodes.length, type: N.VIRTUAL, parent: null, pos: [0, 0], conns: [], connectDirectly: true, net: -1 }; this.nodes.push(n); return n; }
  connect(a: GNode | null, b: GNode | null, path?: PC): GConn | null {
    if (!a || !b) return null;
    const c: GConn = { n1: a, n2: b, path: path ? Object.assign({}, path) : pc(a.pos, b.pos, 0), forceStraight: false };
    this.conns.push(c); a.conns.push(c); if (b !== a) b.conns.push(c); return c;
  }
  truncate(nn: number, nc: number) {
    for (let i = nc; i < this.conns.length; i++) { const c = this.conns[i]; c.n1.conns = c.n1.conns.filter((x) => x !== c); c.n2.conns = c.n2.conns.filter((x) => x !== c); }
    this.conns.length = nc; this.nodes.length = nn;
    this.nodeset.clear(); for (const n of this.nodes) if (n.type !== N.VIRTUAL) this.nodeset.set(this.key(n.type, n.parent, n.pos), n);
  }
  /** TransformEdgeToCreepShapes */
  edgeToShapes() {
    const cut = this.edges.filter((e) => e.shape === "rect" || e.shape === "circle" || e.shape === "poly").map((e) => e.parent.box);
    for (let i = 0; i < cut.length && !this.overlappingCutouts; i++) for (let j = i + 1; j < cut.length; j++) {
      const a = cut[i], b = cut[j], hit = !(b[0] > a[2] || b[2] < a[0] || b[1] > a[3] || b[3] < a[1]);
      const inA = (x: number[], y: number[]) => y[0] >= x[0] && y[2] <= x[2] && y[1] >= x[1] && y[3] <= x[3];
      if (hit && !inA(a, b) && !inA(b, a)) { this.overlappingCutouts = true; break; }
    }
    for (const d of this.edges) {
      const put = (s: Shape) => { s.parent = d.parent; this.shapes.push(s); };
      if (d.shape === "segment") { put(bePoint(d.start)); put(bePoint(d.end)); }
      else if (d.shape === "rect") {
        const r = d.cornerRadius;
        if (r > 0) {
          const x1 = Math.min(d.start[0], d.end[0]), y1 = Math.min(d.start[1], d.end[1]), x2 = Math.max(d.start[0], d.end[0]), y2 = Math.max(d.start[1], d.end[1]), w = x2 - x1, h = y2 - y1;
          const arc = (c: V, s: V, e: V) => { const sa = angleOf(sub(s, c)); let ea = angleOf(sub(e, c)); while (ea < sa) ea += 360; put(beArc(c, r, sa, ea, s, e)); };
          if (h === 2 * r) { arc([x1 + r, y1 + r], [x1 + r, y2], [x1 + r, y1]); arc([x2 - r, y1 + r], [x2 - r, y1], [x2 - r, y2]); }
          else if (w === 2 * r) { arc([x1 + r, y1 + r], [x1, y1 + r], [x2, y1 + r]); arc([x1 + r, y2 - r], [x2, y2 - r], [x1, y2 - r]); }
          else { arc([x1 + r, y1 + r], [x1, y1 + r], [x1 + r, y1]); arc([x2 - r, y1 + r], [x2 - r, y1], [x2, y1 + r]); arc([x2 - r, y2 - r], [x2, y2 - r], [x2 - r, y2]); arc([x1 + r, y2 - r], [x1 + r, y2], [x1, y2 - r]); }
        } else { put(bePoint(d.start)); put(bePoint(d.end)); put(bePoint([d.end[0], d.start[1]])); put(bePoint([d.start[0], d.end[1]])); }
      }
      else if (d.shape === "poly") for (const p of d.pts) put(bePoint(p));
      else if (d.shape === "circle") put(beCircle(d.center, d.radius));
      else if (d.shape === "arc") put(beArc(d.center, d.radius, d.sa, d.ea, d.start, d.end));
    }
  }
  /** RemoveDuplicatedShapes: sorted by type, position, radius; the last of equivalent shapes kept. */
  removeDuplicates() {
    const lt = (a: Shape, b: Shape) => a.type !== b.type ? a.type < b.type : a.type === T.UNDEFINED ? true : !eq(a.pos, b.pos) ? (a.pos[0] !== b.pos[0] ? a.pos[0] < b.pos[0] : a.pos[1] < b.pos[1]) : a.type === T.CIRCLE ? a.radius < b.radius : false;
    this.shapes.sort((a, b) => (lt(a, b) ? -1 : lt(b, a) ? 1 : 0));
    const same = (a: Shape, b: Shape) => a.type === b.type && (a.type === T.POINT ? eq(a.pos, b.pos) : a.type === T.CIRCLE ? eq(a.pos, b.pos) && a.radius === b.radius : false);
    this.shapes = this.shapes.filter((s, i) => !(i + 1 < this.shapes.length && same(s, this.shapes[i + 1])));
  }
  shapesToNodes() { for (const s of this.shapes) { if (s.type === T.POINT) this.addNode(N.POINT, s, s.pos); else if (s.type === T.CIRCLE) this.addNode(N.CIRCLE, s, s.pos); else if (s.type === T.ARC) this.addNode(N.ARC, s, s.pos); } }
  /** isValid: on the board, the midpoint inside the outline, not across a track on the layer nor starting inside one. */
  valid(p: PC, layer: string, ignore: Parent[], tracks: TrackEntry[]): boolean {
    if (!this.outline) return true;
    if (!segmentClearOfBoard(p.a1, p.a2, this.edges)) return false;
    const mid: V = [Math.trunc((p.a1[0] + p.a2[0]) / 2), Math.trunc((p.a1[1] + p.a2[1]) / 2)];
    if (!this.outline.contains(mid, 100)) return false;
    if (layer !== "Edge.Cuts") {
      const box = [Math.min(p.a1[0], p.a2[0]), Math.min(p.a1[1], p.a2[1]), Math.max(p.a1[0], p.a2[0]), Math.max(p.a1[1], p.a2[1])];
      const segDist = (a: V, b: V, q: V) => { const ab = sub(b, a), L = sq(ab); let t = L ? dot(sub(q, a), ab) / L : 0; t = Math.max(0, Math.min(1, t)); return norm(sub(q, add(a, mul(ab, t)))); };
      for (const t of tracks) {
        if (t.box[0] > box[2] || t.box[2] < box[0] || t.box[1] > box[3] || t.box[3] < box[1]) continue;
        if (segSeg(p.a1, p.a2, t.a, t.b) || collinearOverlap(p.a1, p.a2, t.a, t.b)) return false;   // SEG::Intersects
        if (!ignore.includes(t.parent) && (segDist(t.a, t.b, rI(p.a1)) + 100 < t.hw || segDist(t.a, t.b, rI(p.a2)) + 100 < t.hw)) return false;
      }
    }
    return true;
  }
  generatePaths(maxWeight: number, layer: string, tracks: TrackEntry[]) {
    const nodes = this.nodes.filter((g) => g.parent && g.connectDirectly && g.type !== N.VIRTUAL);
    const groups = new Map<Parent | null, Map<number, GNode[]>>(); const keys: (Parent | null)[] = [];
    for (const g of nodes) {
      const par = g.parent!.parent; let m = groups.get(par); if (!m) { m = new Map(); groups.set(par, m); keys.push(par); }
      let l = m.get(g.net); if (!l) m.set(g.net, (l = [])); l.push(g);
    }
    const work: [GNode, GNode][] = [];
    const near = (g1: GNode, g2: GNode) => { const r1 = radiusOf(g1.parent!), r2 = radiusOf(g2.parent!), th = maxWeight + r1 + r2; return sq(sub(g1.parent!.pos, g2.parent!.pos)) <= th * th; };
    const entries = keys.filter((k): k is Parent => !!k);
    for (const p1 of entries) for (const p2 of entries) {
      if (p1.key >= p2.key) continue;
      const b1 = p1.box, b2 = p2.box;
      const dx = b2[0] > b1[2] ? b2[0] - b1[2] : b1[0] > b2[2] ? b1[0] - b2[2] : 0, dy = b2[1] > b1[3] ? b2[1] - b1[3] : b1[1] > b2[3] ? b1[1] - b2[3] : 0;
      const md = Math.trunc(maxWeight); if (dx * dx + dy * dy > md * md) continue;
      for (const [n1, l1] of groups.get(p1)!) for (const [n2, l2] of groups.get(p2)!) {
        if (n1 === n2 && l1.length && l2.length && l1[0].parent!.conductive && l2[0].parent!.conductive) continue;
        for (const g1 of l1) for (const g2 of l2) if (near(g1, g2)) work.push([g1, g2]);
      }
    }
    for (const par of keys) {
      const all: GNode[] = []; for (const l of groups.get(par)!.values()) all.push(...l);
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        const g1 = all[i], g2 = all[j]; if (g1.parent === g2.parent) continue;
        if (g1.parent!.conductive && g2.parent!.conductive && g1.net === g2.net) continue;
        if (near(g1, g2)) work.push([g1, g2]);
      }
    }
    for (const [g1, g2] of work) {
      const s1 = g1.parent!, s2 = g2.parent!;
      for (const p of paths(s1, s2, maxWeight, maxWeight * maxWeight)) {
        const ignore: Parent[] = []; if (s1.conductive && s1.parent) ignore.push(s1.parent); if (s2.conductive && s2.parent) ignore.push(s2.parent);
        if (!this.valid(p, layer, ignore, tracks)) continue;
        let c1 = g1, c2 = g2;
        if (s1.type !== T.POINT) { const t = this.addNode(N.POINT, s1, p.a1); t.connectDirectly = false; c1 = t; if (s1.conductive) { const gc = this.connect(g1, t); if (gc) gc.path.show = false; } }
        if (s2.type !== T.POINT) { const t = this.addNode(N.POINT, s2, p.a2); t.connectDirectly = false; c2 = t; if (s2.conductive) { const gc = this.connect(g2, t); if (gc) gc.path.show = false; } }
        this.connect(c1, c2, p);
      }
    }
  }
  /** CREEP_SHAPE::ConnectChildren: two points on one board edge circle or arc joined along it. */
  connectChildren(s: Shape, a1: GNode, a2: GNode) {
    if (s.cls === "BEC") {
      if (s.radius === 0) return;
      if (this.overlappingCutouts && this.outline) {
        const tol = 5000 + 1000, r1 = angleOf(sub(a1.pos, s.pos)) * RAD, r2 = angleOf(sub(a2.pos, s.pos)) * RAD; let d = r2 - r1;
        while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        for (let i = 0; i <= 8; i++) { const a = r1 + d * i / 8; if (!this.outline.contains([Math.trunc(s.pos[0] + s.radius * Math.cos(a)), Math.trunc(s.pos[1] + s.radius * Math.sin(a))], tol)) return; }
      }
      const w = s.radius * 2 * Math.asin(norm(sub(a1.pos, a2.pos)) / (2 * s.radius));
      if (w > this.target) return;
      this.connect(a1, a2, pc(a1.pos, a2.pos, Math.max(w, 0)));
    } else if (s.cls === "BEA") {
      const an1 = angleIn(s, a1.pos), an2 = angleIn(s, a2.pos);
      if (this.overlappingCutouts && this.outline) {
        const tol = 5000 + 1000;
        for (let i = 0; i <= 8; i++) { const a = (an1 + (an2 - an1) * i / 8) * RAD; if (!this.outline.contains([Math.trunc(s.pos[0] + s.radius * Math.cos(a)), Math.trunc(s.pos[1] + s.radius * Math.sin(a))], tol)) return; }
      }
      const w = Math.abs(s.radius * (an2 - an1) * RAD);
      if (w > this.target) return;
      this.connect(a1, a2, pc(a1.pos, a2.pos, w));
    }
  }
  /** Addshape: a copper SHAPE as creep shapes joined to the net's virtual node. */
  addShape(sh: KShape, to: GNode, parent: Parent) {
    let s: Shape | null = null, type: N | null = null;
    if (sh.t === "seg") { s = cuSeg(sh.a, sh.b, sh.w); type = N.SEGMENT; }
    else if (sh.t === "circle") { s = cuCircle(sh.c, sh.r); type = N.CIRCLE; }
    else if (sh.t === "arc") { const g = arcGeom(sh.a, sh.m, sh.b); if (g) { s = cuArc(g.center, g.radius, g.sa, g.ea, sh.a, sh.b); s.width = sh.w; type = N.ARC; } }
    else if (sh.t === "compound") { for (const x of sh.shapes) if (!(x.t === "rect" && sh.shapes.length === 5)) this.addShape(x, to, parent); return; }
    else if (sh.t === "segs") { for (const [a, b] of sh.segs) this.addShape({ t: "seg", a, b, w: 0 }, to, parent); return; }
    else if (sh.t === "chain") { let prev = sh.pts[sh.pts.length - 1]; for (const p of sh.pts) { this.addShape({ t: "seg", a: p, b: prev, w: 0 }, to, parent); prev = p; } return; }
    else if (sh.t === "simple") { if (sh.pts.length < 3) return; let prev = sh.pts[sh.pts.length - 1]; for (const p of sh.pts) { if (!eq(p, prev)) this.addShape({ t: "seg", a: prev, b: p, w: 0 }, to, parent); prev = p; } return; }
    else if (sh.t === "rect") { const p0 = sh.p, p1: V = [sh.p[0] + sh.w, sh.p[1]], p2: V = [sh.p[0] + sh.w, sh.p[1] + sh.h], p3: V = [sh.p[0], sh.p[1] + sh.h]; for (const [a, b] of [[p0, p1], [p1, p2], [p2, p3], [p3, p0]]) this.addShape({ t: "seg", a, b, w: 0 }, to, parent); return; }
    if (!s || type === null) return;
    s.parent = parent;
    const g = this.addNode(type, s, s.pos);
    this.shapes.push(s); g.net = to.net;
    const gc = this.connect(g, to); if (gc) gc.path.show = false;
  }
  /** Dijkstra from one net's virtual node to the other's; the path from `to` back to `from`. */
  solve(from: GNode, to: GNode): { dist: number; path: GConn[] } {
    if (from === to) return { dist: 0, path: [] };
    const dist = new Map<GNode, number>(), prev = new Map<GNode, GNode>(); for (const n of this.nodes) dist.set(n, Infinity);
    dist.set(from, 0);
    const heap: [number, GNode][] = [[0, from]];
    const push = (e: [number, GNode]) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (cmp(heap[p], heap[i]) <= 0) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && cmp(heap[l], heap[m]) < 0) m = l; if (r < heap.length && cmp(heap[r], heap[m]) < 0) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const cmp = (a: [number, GNode], b: [number, GNode]) => (a[0] !== b[0] ? a[0] - b[0] : a[1].idx - b[1].idx);
    while (heap.length) {
      const [d, cur] = pop();
      if (d > dist.get(cur)!) continue;
      if (cur === to) break;
      for (const c of cur.conns) {
        const nb = c.n1 === cur ? c.n2 : c.n1; if (c.path.weight < 0) continue;
        const alt = dist.get(cur)! + c.path.weight;
        if (alt < dist.get(nb)!) { dist.set(nb, alt); prev.set(nb, cur); push([alt, nb]); }
      }
    }
    const w = dist.get(to)!; if (w === Infinity) return { dist: Infinity, path: [] };
    const path: GConn[] = []; let step = to;
    while (step !== from) {
      const p = prev.get(step)!;
      const c = step.conns.find((x) => (x.n1 === p && x.n2 === step) || (x.n1 === step && x.n2 === p)); if (c) path.push(c);
      step = p;
    }
    return { dist: w, path };
  }
}
/** Collinear segments that overlap also intersect (SEG::Intersects). */
function collinearOverlap(a: V, b: V, c: V, d: V): boolean {
  const r = sub(b, a); if (cross(r, sub(c, a)) !== 0 || cross(r, sub(d, a)) !== 0) return false;
  const L = dot(r, r); if (!L) return false; const t0 = dot(sub(c, a), r) / L, t1 = dot(sub(d, a), r) / L;
  return Math.max(t0, t1) >= 0 && Math.min(t0, t1) <= 1;
}
/** GRAPH_CONNECTION::GetShapes: the error legend's pieces (arcs along an edge circle or arc, else straight lines). */
export type LegendShape = { t: "seg"; a: Pt; b: Pt } | { t: "arc"; c: Pt; a: Pt; b: Pt };
function legendShapes(c: GConn, out: LegendShape[]) {
  if (!c.path.show || c.n1.type === N.VIRTUAL || c.n2.type === N.VIRTUAL) return;
  const mm = (v: V): Pt => [v[0] / IU, v[1] / IU];
  const par = c.n1.parent;
  if (!c.forceStraight && par && par === c.n2.parent && (par.type === T.CIRCLE || (par.type === T.ARC && par.cls === "BEA"))) {
    const R1 = sub(c.n1.pos, par.pos), R2 = sub(c.n2.pos, par.pos);
    let a = c.n2.pos, b = c.n1.pos; if (cross(R1, R2) > 0) { a = c.n1.pos; b = c.n2.pos; }
    if (par.type === T.ARC) {
      // on the arc's side: the shape's mid point must fall within the arc
      let sa = angleOf(sub(a, par.pos)), ea = angleOf(sub(b, par.pos)); while (ea < sa) ea += 360;
      const mid = add(par.pos, [par.radius * Math.cos((sa + ea) / 2 * RAD), par.radius * Math.sin((sa + ea) / 2 * RAD)]);
      if (angleIn(par, rI(mid)) > par.ea) [a, b] = [b, a];
    }
    out.push({ t: "arc", c: mm(par.pos), a: mm(a), b: mm(b) }); return;
  }
  out.push({ t: "seg", a: mm(c.path.a1), b: mm(c.path.a2) });
}

// ---------------------------------------------------------------- copper effective shapes (GetEffectiveShape)
type KShape = { t: "seg"; a: V; b: V; w: number } | { t: "circle"; c: V; r: number } | { t: "arc"; a: V; m: V; b: V; w: number } | { t: "rect"; p: V; w: number; h: number }
  | { t: "simple"; pts: V[] } | { t: "chain"; pts: V[] } | { t: "segs"; segs: [V, V][] } | { t: "compound"; shapes: KShape[] };
/** EDA_SHAPE::makeEffectiveShapes of a drawing (or a custom pad primitive) in nm, `tf` taking its points onto the board. */
function drawingShapes(kind: string, node: SNode, tf: (p: number[]) => V): KShape[] {
  const st = K.kid(node, "stroke"), w = Math.round((st ? K.num((K.kid(st, "width") || [0, 0])[1], 0) : K.num((K.kid(node, "width") || [0, 0])[1], 0)) * IU);
  const f = K.kid(node, "fill"), solid = !!f && ["yes", "solid", "hatch", "reverse_hatch", "cross_hatch"].includes(K.str(f[1]));
  const P = (k: string) => { const p = pt(node, k); return p ? tf(p) : null; };
  const out: KShape[] = [];
  if (kind === "line") { const a = P("start"), b = P("end"); if (a && b) out.push({ t: "seg", a, b, w }); }
  else if (kind === "arc") { const a = P("start"), m = P("mid"), b = P("end"); if (a && m && b) out.push({ t: "arc", a, m, b, w }); }
  else if (kind === "circle") {
    const c = P("center"), e = P("end"); if (!c || !e) return out;
    if (solid) out.push({ t: "circle", c, r: Math.round(norm(sub(e, c))) });
    if (w > 0 || !solid) out.push({ t: "arc", a: e, m: add(c, sub(c, e)), b: e, w });   // a 360° SHAPE_ARC
  }
  else if (kind === "rect") {
    const a = pt(node, "start"), b = pt(node, "end"); if (!a || !b) return out;
    const pts = [tf(a), tf([b[0], a[1]]), tf(b), tf([a[0], b[1]])];
    if (solid) out.push({ t: "simple", pts });
    if (w > 0 || !solid) for (let i = 0; i < 4; i++) out.push({ t: "seg", a: pts[i], b: pts[(i + 1) % 4], w });
  }
  else if (kind === "poly") {
    const pts = K.ptsOf(node).map((p) => tf(p)); if (pts.length < 2) return out;
    if (solid) out.push({ t: "simple", pts });
    if (w > 0 || !solid) for (let i = 0; i < pts.length; i++) out.push({ t: "seg", a: pts[i], b: pts[(i + 1) % pts.length], w });
  }
  else if (kind === "curve") { const pts = K.bezierPts(K.ptsOf(node)).map((p: number[]) => tf(p)); for (let i = 1; i < pts.length; i++) out.push({ t: "seg", a: pts[i - 1], b: pts[i], w }); }
  return out;
}
/** PAD::buildEffectiveShape( layer ): the pad's copper as SHAPEs in nm. */
function padShapes(c: Extract<Conductor, { kind: "pad" }>): KShape {
  const p = c.pad, node = p.node, R = rotator(p.rot);
  const off = p.off && (p.off[0] || p.off[1]) ? R(p.off[0], p.off[1]) : [0, 0];
  const sp = toIU([p.x + off[0], p.y + off[1]]), size: V = [Math.round(p.w * IU), Math.round(p.h * IU)];
  const shapes: KShape[] = [];
  let shape = p.shape;
  const custom = shape === "custom";
  if (custom) { const o = K.kid(node, "options"), an = o && K.kid(o, "anchor"); shape = an && K.str(an[1]) === "rect" ? "rect" : "circle"; }
  const isChamfered = (shape === "roundrect" || shape === "rect") && !!K.kid(node, "chamfer") && !custom;
  if (shape === "circle") shapes.push({ t: "circle", c: sp, r: Math.trunc(size[0] / 2) });
  else if (shape === "oval") {
    if (size[0] === size[1]) shapes.push({ t: "circle", c: sp, r: Math.trunc(size[0] / 2) });
    else { const hs: V = [Math.trunc(size[0] / 2), Math.trunc(size[1] / 2)], hw = Math.min(hs[0], hs[1]); const t = R(hs[0] - hw, hs[1] - hw); const hl: V = [Math.round(t[0]), Math.round(t[1])]; shapes.push({ t: "seg", a: sub(sp, hl), b: add(sp, hl), w: hw * 2 }); }
  }
  else if (isChamfered) shapes.push({ t: "simple", pts: padShapePolygon(node, [p.x + off[0], p.y + off[1]]).map((q) => toIU(q)) });
  else if (shape === "rect" || shape === "trapezoid" || shape === "roundrect") {
    const rr = K.kid(node, "roundrect_rratio"), r = shape === "roundrect" ? Math.round(Math.min(size[0], size[1]) * (rr ? K.num(rr[1], 0.25) : 0.25)) : 0;
    let hs: V = [Math.trunc(size[0] / 2), Math.trunc(size[1] / 2)]; let td: V = [0, 0];
    if (r) { hs = [hs[0] - r, hs[1] - r]; if (hs[0] < 100 && hs[1] < 100) { shapes.push({ t: "circle", c: sp, r }); return { t: "compound", shapes }; } }
    else if (shape === "trapezoid") { const d = K.kid(node, "rect_delta"); if (d) td = [Math.trunc(Math.round(K.num(d[1], 0) * IU) / 2), Math.trunc(Math.round(K.num(d[2], 0) * IU) / 2)]; }
    const local: V[] = [[-hs[0] - td[1], hs[1] + td[0]], [hs[0] + td[1], hs[1] - td[0]], [hs[0] - td[1], -hs[1] + td[0]], [-hs[0] + td[1], -hs[1] - td[0]]];
    const cs = local.map((q) => { const t = R(q[0], q[1]); return add(rI(t as V), sp); });
    const isRect = (cs[0][1] === cs[1][1] && cs[1][0] === cs[2][0] && cs[2][1] === cs[3][1] && cs[3][0] === cs[0][0]) || (cs[0][0] === cs[1][0] && cs[1][1] === cs[2][1] && cs[2][0] === cs[3][0] && cs[3][1] === cs[0][1]);
    if (isRect) shapes.push({ t: "rect", p: [Math.min(cs[2][0], cs[0][0]), Math.min(cs[2][1], cs[0][1])], w: Math.abs(cs[2][0] - cs[0][0]), h: Math.abs(cs[2][1] - cs[0][1]) });
    else shapes.push({ t: "simple", pts: cs });
    if (r) for (let i = 0; i < 4; i++) shapes.push({ t: "seg", a: cs[i], b: cs[(i + 1) % 4], w: r * 2 });
  }
  if (custom) {
    const prims = K.kid(node, "primitives");
    for (const g of prims ? prims.slice(1) : []) {
      if (!isList(g)) continue; const m = /^gr_(line|arc|circle|rect|poly|curve)$/.exec(g[0] as string); if (!m) continue;
      shapes.push(...drawingShapes(m[1], g as SNode, (q) => { const t = R(q[0], q[1]); return add(rI([Math.round(t[0] * IU), Math.round(t[1] * IU)]), sp); }));
    }
  }
  return { t: "compound", shapes };
}

// ---------------------------------------------------------------- the provider
const ITEM_KIND: Record<string, string> = { segment: "segment", arc: "arc", via: "via", zone: "zone" };
export function creepageMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[]): DrcMarker[] {
  const out: DrcMarker[] = [];
  const cRules = rules.filter((r) => !r.error && r.constraints.some((c) => c.type === "creepage"));
  if (!cRules.length) return out;   // "No creepage constraints found. Tests not run."
  if ((s.severities.creepage || "error") === "ignore") return out;
  // QueryWorstConstraint: the largest creepage minimum; HasConditionalConstraint: a rule with a condition
  let maxC = 0; for (const r of cRules) for (const c of r.constraints) if (c.type === "creepage" && c.min != null && c.min > maxC) maxC = c.min;
  const maxConstraint = Math.round(maxC * IU); if (maxConstraint <= 0) return out;
  const hasConditional = cRules.some((r) => !!r.condition && r.condition.trim() !== "");
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const layers = [...copper].sort((a, b) => lid(a) - lid(b));
  // the nets by net code (NETCODES_MAP), net 0 included
  const nl = netlist(doc); const conds = nl.conductors;
  const codeOf = new Map<string, number>(); if (doc.nets) for (const [code, name] of doc.nets as Map<number, string>) codeOf.set(String(name), code);
  for (const c of conds) if (!codeOf.has(c.net)) codeOf.set(c.net, c.netObj && c.netObj.code > 0 ? c.netObj.code : c.net ? -1 : 0);
  if (!codeOf.has("")) codeOf.set("", 0);
  const nets = [...codeOf.entries()].sort((a, b) => a[1] - b[1]).map(([name, code]) => ({ name, code }));
  let pkey = 0; const parents = new Map<string, Parent>();
  const newParent = (id: string, kiid: string, box: number[]): Parent => ({ key: pkey++, id, kiid, ri: null, box });
  const g = new Graph();
  g.edges = edgeItems(doc, newParent);
  g.outline = boardOutline(doc, g.edges);
  g.target = maxConstraint;
  g.edgeToShapes(); g.removeDuplicates(); g.shapesToNodes();
  g.generatePaths(maxConstraint, "Edge.Cuts", []);
  const beNodes = g.nodes.length, beConns = g.conns.length;
  // the copper of every net, per layer
  const unfl = unflashedLayers(conds, copper);
  const parentOf = (c: Conductor, layer: string): Parent => {
    const k = c.kind === "pad" ? c.id + "#" + c.index : c.id;
    let p = parents.get(k);
    if (!p) {
      const kiid = (c.kind === "pad" ? K.uuidOf(c.pad.node) : K.uuidOf(c.item.node)) || c.id;
      p = newParent(c.id, kiid, [c.bbox[0] * IU, c.bbox[1] * IU, c.bbox[2] * IU, c.bbox[3] * IU]); parents.set(k, p);
    }
    p.ri = c.kind === "pad" ? { kind: "pad", node: c.pad.node, parent: c.item, layer } : { kind: ITEM_KIND[c.kind] || c.kind, node: c.item.node, item: c.item, layer };
    return p;
  };
  const netBox = new Map<string, number[]>();
  for (const c of conds) { const b = netBox.get(c.net); const cb = [c.bbox[0] * IU, c.bbox[1] * IU, c.bbox[2] * IU, c.bbox[3] * IU]; netBox.set(c.net, b ? [Math.min(b[0], cb[0]), Math.min(b[1], cb[1]), Math.max(b[2], cb[2]), Math.max(b[3], cb[3])] : cb); }
  const drawings = copperDrawings(doc);
  for (const d of drawings) { const b = netBox.get(d.net); netBox.set(d.net, b ? [Math.min(b[0], d.box[0]), Math.min(b[1], d.box[1]), Math.max(b[2], d.box[2]), Math.max(b[3], d.box[3])] : d.box.slice()); }
  /** AddNetElements */
  const addNet = (net: { name: string; code: number }, layer: string): GNode => {
    const v = g.addVirtual(); v.net = net.code;
    for (const c of conds) {
      if (c.kind !== "pad" || c.net !== net.name || !c.layers.has(layer)) continue;
      const u = unfl.get(c); if (u && u.has(layer)) continue;   // PAD::HasCopperRemoved
      g.addShape(padShapes(c), v, parentOf(c, layer));
    }
    for (const c of conds) {
      if ((c.kind !== "segment" && c.kind !== "arc" && c.kind !== "via") || c.net !== net.name || !c.layers.has(layer)) continue;
      if (c.kind === "via") { const u = unfl.get(c); if (u && u.has(layer)) continue; g.addShape({ t: "circle", c: toIU(pt(c.item.node, "at")!), r: Math.round(c.size * IU / 2) }, v, parentOf(c, layer)); }
      else if (c.kind === "segment") g.addShape({ t: "seg", a: toIU(pt(c.item.node, "start")!), b: toIU(pt(c.item.node, "end")!), w: Math.round(c.width * IU) }, v, parentOf(c, layer));
      else g.addShape({ t: "arc", a: toIU(pt(c.item.node, "start")!), m: toIU(pt(c.item.node, "mid")!), b: toIU(pt(c.item.node, "end")!), w: Math.round(c.width * IU) }, v, parentOf(c, layer));
    }
    // zones: the fill's outlines on the layer (SHAPE_POLY_SET segments)
    for (const c of conds) {
      if (c.kind !== "zone" || c.net !== net.name || !c.layers.has(layer) || c.shape.t !== "poly") continue;
      const pts = c.shape.pts.map((q) => toIU(q)); const segs: [V, V][] = []; for (let i = 0; i < pts.length; i++) segs.push([pts[i], pts[(i + 1) % pts.length]]);
      const key = c.id; let p = parents.get(key); if (!p) { p = newParent(c.id, K.uuidOf(c.item.node) || c.id, [c.bbox[0] * IU, c.bbox[1] * IU, c.bbox[2] * IU, c.bbox[3] * IU]); parents.set(key, p); } else { p.box = [Math.min(p.box[0], c.bbox[0] * IU), Math.min(p.box[1], c.bbox[1] * IU), Math.max(p.box[2], c.bbox[2] * IU), Math.max(p.box[3], c.bbox[3] * IU)]; }
      p.ri = { kind: "zone", node: c.item.node, item: c.item, layer };
      g.addShape({ t: "segs", segs }, v, p);
    }
    for (const d of drawings) {
      if (d.net !== net.name || d.layer !== layer) continue;
      let p = parents.get(d.key); if (!p) { p = newParent(d.id, d.kiid, d.box); parents.set(d.key, p); }
      p.ri = { kind: d.kind, node: d.node, item: doc.items.get(d.id) || null, layer };
      g.addShape({ t: "compound", shapes: d.shapes }, v, p);
    }
    return v;
  };
  // the tracks on a layer, for the path test (CREEPAGE_TRACK_ENTRY)
  const trackCache = new Map<string, TrackEntry[]>();
  const tracksOn = (layer: string) => {
    let l = trackCache.get(layer); if (l) return l; l = [];
    for (const c of conds) if (c.kind === "segment" && c.layers.has(layer)) { const a = toIU(pt(c.item.node, "start")!), b = toIU(pt(c.item.node, "end")!), hw = Math.trunc(Math.round(c.width * IU) / 2); l.push({ a, b, hw, parent: parentOf(c, layer), box: [Math.min(a[0], b[0]) - hw, Math.min(a[1], b[1]) - hw, Math.max(a[0], b[0]) + hw, Math.max(a[1], b[1]) + hw] }); }
    trackCache.set(layer, l); return l;
  };
  const placeholder = (net: { name: string; code: number }, layer: string): RuleItem => ({ kind: "segment", node: ["segment", ["layer", layer], ["net", net.code, net.name]] as unknown as SNode, layer });
  const evalC = (A: RuleItem, B: RuleItem, layer: string) => { const h = evalRuleConstraint(cRules, "creepage", doc, s, Object.assign({}, A, { layer }), Object.assign({}, B, { layer })); return h; };
  const reported = new Set<string>();
  let prevChanged = false;
  for (let i = 0; i < nets.length; i++) for (let j = i + 1; j < nets.length; j++) {
    const A = nets[i], B = nets[j]; if (A.code === B.code && A.name === B.name) continue;
    for (const layer of layers) {
      if (prevChanged) g.truncate(beNodes, beConns);
      prevChanged = testPair(A, B, layer);
    }
  }
  function testPair(A: { name: string; code: number }, B: { name: string; code: number }, layer: string): boolean {
    let net: ReturnType<typeof evalC> = null, target: number;
    if (hasConditional) target = maxConstraint;
    else { net = evalC(placeholder(A, layer), placeholder(B, layer), layer); target = net && net.min != null ? Math.round(net.min * IU) : 0; }
    g.target = target;
    if (target <= 0) return false;
    const ba = netBox.get(A.name), bb = netBox.get(B.name); if (!ba || !bb) return false;
    const dx = Math.max(0, ba[0] - bb[2], bb[0] - ba[2]), dy = Math.max(0, ba[1] - bb[3], bb[1] - ba[3]);
    if (Math.hypot(dx, dy) > target) return false;
    const vA = addNet(A, layer), vB = addNet(B, layer);
    g.generatePaths(target, layer, tracksOn(layer));
    const temp = g.nodes.filter((n) => n.parent && !n.parent.conductive && !n.connectDirectly && n.type === N.POINT);
    for (let x = 0; x < temp.length; x++) for (let y = x + 1; y < temp.length; y++) { const n1 = temp[x], n2 = temp[y]; if (n1 === n2 || n1.parent !== n2.parent) continue; g.connectChildren(n1.parent!, n1, n2); }
    const { dist, path } = g.solve(vA, vB);
    if (path.length < 4) return true;
    const gc1 = path[1], gc2 = path[path.length - 2];
    const item1 = gc1.n1 && gc1.n1.parent ? gc1.n1.parent.parent : null, item2 = gc2.n2 && gc2.n2.parent ? gc2.n2.parent.parent : null;
    let h: ReturnType<typeof evalC>;
    if (!hasConditional) h = net;
    else if (item1 && item2 && item1.ri && item2.ri) h = evalC(item1.ri, item2.ri, layer);
    else h = evalC(placeholder(A, layer), placeholder(B, layer), layer);
    if (!h || h.severity === "ignore") return true;
    const value = h.min != null ? Math.round(h.min * IU) : 0;
    if (value <= 0 || dist - value >= 0) return true;
    if (item1 && item2) { const k = item1.key + "|" + item2.key; if (reported.has(k)) return true; reported.add(k); }
    const [need, actual] = mmPair(value / IU, dist / IU);
    const at = gc1.path.a2, end = gc2.path.a2;
    const m = marker("creepage", "error", at[0] / IU, at[1] / IU, `Creepage violation (${h.name} creepage ${need}; actual ${actual})`, item1 && item2 ? [item1.id, item2.id].filter(Boolean) : []);
    if (item1 && item2) withKiids(m, [item1.kiid, item2.kiid]);
    m.layer = layer; m.rule = h.name.replace(/^rule '(.*)'$/, "$1");
    const legend: LegendShape[] = []; for (const c of path) legendShapes(c, legend);
    m.path = [[at[0] / IU, at[1] / IU], [end[0] / IU, end[1] / IU]];
    m.pathShapes = legend;
    out.push(ruled(m, h.severity));
    return true;
  }
  return out;
}
/** KiCad's copper layer id order (LSET iteration): F.Cu, B.Cu, In1.Cu … */
const lid = (l: string) => (l === "F.Cu" ? 0 : l === "B.Cu" ? 2 : /^In(\d+)\.Cu$/.test(l) ? 2 * (parseInt(l.slice(2), 10) + 1) : 1000);
/** The board's connected copper drawings (a PCB_SHAPE with a net on a copper layer). */
function copperDrawings(doc: BoardDoc) {
  const out: { key: string; id: string; kiid: string; kind: string; node: SNode; net: string; layer: string; shapes: KShape[]; box: number[] }[] = [];
  for (const it of doc.items.values()) {
    const m = /^gr_(line|rect|circle|arc|poly|curve)$/.exec(it.kind); if (!m) continue;
    const layer = layerOf(it.node, ""); if (!/\.Cu$/.test(layer)) continue;
    const nk = K.kid(it.node, "net"); if (!nk) continue;
    const net = nk[2] !== undefined ? K.str(nk[2]) : typeof nk[1] === "number" ? String((doc.nets && (doc.nets as Map<number, string>).get(nk[1] as number)) || "") : K.str(nk[1]);
    const shapes = drawingShapes(m[1], it.node, (p) => toIU(p));
    const pts: V[] = []; for (const s of shapes) { if (s.t === "seg") pts.push(s.a, s.b); else if (s.t === "circle") pts.push(sub(s.c, [s.r, s.r]), add(s.c, [s.r, s.r])); else if (s.t === "arc") { const r = norm(sub(s.a, s.m)); pts.push(sub(s.m, [r, r]), add(s.m, [r, r])); } else if (s.t === "simple") pts.push(...s.pts); }
    if (!pts.length) continue;
    out.push({ key: it.id, id: it.id, kiid: K.uuidOf(it.node) || it.id, kind: it.kind, node: it.node, net, layer, shapes, box: boxOfPts(pts, 0) });
  }
  return out;
}

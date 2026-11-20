// planar.ts — the closed regions of a sketch whose curves may cross: a planar arrangement.
//
// sketch/profiles.ts finds regions only where curves join end to end.  A sketcher with trim, construction
// geometry and overlapping shapes needs more: two circles that overlap enclose three regions, a line across a
// rectangle splits it in two, a slot drawn over a plate cuts it.  This file answers the same question with the
// same types (`Regions`, `Region`, `Loop`), so the Sketch feature and the viewport use it in place of
// `profiles.findRegions` and nothing downstream changes:
//
//   • every non-construction line, arc and circle is cut where it meets another (crossings, T-junctions,
//     tangent touches, shared end points whether by id or by position);
//   • pieces that lead nowhere (a line sticking out of an outline) are dropped and reported in `open` when the
//     whole curve leads nowhere;
//   • what is left is walked into faces.  Every bounded face of a connected group of curves is a region;
//   • a group that lies inside a face of another group is a hole in that face, and its own faces are regions
//     again only at even depth.  For outlines that do not cross this is exactly the even-odd nesting of
//     profiles.ts: a plate with holes is one region, and the ids are the same.
//
// A loop edge that is only part of its curve carries `span`: the stretch [t0, t1] in the curve's own direction
// (a line from 0 at `a` to 1 at `b`; a circle or arc by angle in radians, counter-clockwise).  An edge without
// `span` is the whole curve.  A region's id is the smallest entity id on its outer loop, with `~2`, `~3` … for
// the further regions that share it (in order of their centres, x then y).
import type { Vec2 } from "../core/geometry";
import type { SketchData } from "./format";
import { pointInPolygon, type Loop, type LoopEdge, type Region, type Regions } from "./profiles";
import { freeformPieces, isFreeform, nearestOnPiece, pieceAt, pieceCurvature, pieceTangent, samplePiece, type Piece } from "./curves";
import { arcSweep, pointAt } from "./refs";

/**
 * One curve of a loop; `span` is set when the loop uses only part of the curve.  `part` is which piece of a
 * free-form entity it is (text has one piece per stroke of a glyph's outline; sketch/curves.ts), and a free-form
 * curve's span is in its NURBS parameter.
 */
export interface SpanEdge extends LoopEdge { span?: [number, number]; part?: number }

const TOL = 1e-6;
const TAU = Math.PI * 2;

interface Curve {
  entity: string; circular: boolean; closed: boolean;
  // a free-form curve (an ellipse, a spline, a stroke of text): a NURBS piece, t its parameter in [a0, a1]
  free?: Piece; part?: number; poly?: Vec2[]; box?: [number, number, number, number];
  // a line from a to b, t in [0, 1]
  a: Vec2; b: Vec2;
  // a circle or arc about c, t the angle in [a0, a1]
  c: Vec2; r: number; a0: number; a1: number;
  cuts: number[];
}
interface Edge { curve: Curve; t0: number; t1: number; v0: number; v1: number; alive: boolean }
interface Half { edge: Edge; forward: boolean; from: number; to: number; angle: number; bend: number; next: Half | null; used: boolean }

const at = (k: Curve, t: number): Vec2 => (k.free ? pieceAt(k.free, t) : k.circular ? [k.c[0] + k.r * Math.cos(t), k.c[1] + k.r * Math.sin(t)] : [k.a[0] + (k.b[0] - k.a[0]) * t, k.a[1] + (k.b[1] - k.a[1]) * t]);

/** The period of a closed curve's parameter. */
const period = (k: Curve): number => (k.free ? k.a1 - k.a0 : TAU);

/** The parameter of a point known to lie on the curve's carrier, or null when it is off the curve's extent. */
function paramOf(k: Curve, p: Vec2): number | null {
  if (k.free) { const n = nearestOnPiece(k.free, p); return n.d <= TOL * 4 ? n.t : null; }
  if (!k.circular) {
    const dx = k.b[0] - k.a[0], dy = k.b[1] - k.a[1], l2 = dx * dx + dy * dy;
    const t = ((p[0] - k.a[0]) * dx + (p[1] - k.a[1]) * dy) / l2, slack = TOL / Math.sqrt(l2);
    return t < -slack || t > 1 + slack ? null : Math.min(1, Math.max(0, t));
  }
  const slack = TOL / k.r;
  let t = Math.atan2(p[1] - k.c[1], p[0] - k.c[0]) - k.a0;
  t = k.a0 + (((t % TAU) + TAU) % TAU);                 // in [a0, a0 + 2π)
  if (k.closed) return t;
  if (t <= k.a1 + slack) return Math.min(k.a1, t);
  return k.a0 + TAU - t < slack ? k.a0 : null;
}

/** The points where the carriers of two curves meet (the infinite line, the whole circle). */
function meet(p: Curve, q: Curve): Vec2[] {
  if (p.free || q.free) return meetFree(p, q);
  if (!p.circular && !q.circular) {
    const d1x = p.b[0] - p.a[0], d1y = p.b[1] - p.a[1], d2x = q.b[0] - q.a[0], d2y = q.b[1] - q.a[1];
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-12 * Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y)) return [];
    const t = ((q.a[0] - p.a[0]) * d2y - (q.a[1] - p.a[1]) * d2x) / den;
    return [[p.a[0] + d1x * t, p.a[1] + d1y * t]];
  }
  if (p.circular && q.circular) {
    const dx = q.c[0] - p.c[0], dy = q.c[1] - p.c[1], d = Math.hypot(dx, dy);
    if (d < TOL) return [];
    if (d > p.r + q.r + TOL || d < Math.abs(p.r - q.r) - TOL) return [];
    const a = (d * d + p.r * p.r - q.r * q.r) / (2 * d), h2 = p.r * p.r - a * a;
    const mx = p.c[0] + (dx * a) / d, my = p.c[1] + (dy * a) / d;
    if (h2 <= TOL * p.r) return [[mx, my]];
    const h = Math.sqrt(h2);
    return [[mx - (dy * h) / d, my + (dx * h) / d], [mx + (dy * h) / d, my - (dx * h) / d]];
  }
  const line = p.circular ? q : p, circ = p.circular ? p : q;
  const dx = line.b[0] - line.a[0], dy = line.b[1] - line.a[1], l = Math.hypot(dx, dy);
  const ux = dx / l, uy = dy / l;
  const s = (circ.c[0] - line.a[0]) * ux + (circ.c[1] - line.a[1]) * uy;
  const fx = line.a[0] + ux * s, fy = line.a[1] + uy * s;
  const off = Math.hypot(circ.c[0] - fx, circ.c[1] - fy);
  if (off > circ.r + TOL) return [];
  const h2 = circ.r * circ.r - off * off;
  if (h2 <= TOL * circ.r) return [[fx, fy]];
  const h = Math.sqrt(h2);
  return [[fx - ux * h, fy - uy * h], [fx + ux * h, fy + uy * h]];
}

/** The curves of a sketch that can bound a region, as the arrangement sees them. */
function curvesOf(sketch: SketchData): Curve[] {
  const out: Curve[] = [];
  for (const id of Object.keys(sketch.entities || {}).sort()) {
    const e = sketch.entities[id];
    if (!e || e.construction) continue;
    const zero: Vec2 = [0, 0];
    if (e.type === "line") {
      const a = pointAt(sketch, e.a), b = pointAt(sketch, e.b);
      if (!a || !b || Math.hypot(b[0] - a[0], b[1] - a[1]) < TOL) continue;
      out.push({ entity: id, circular: false, closed: false, a, b, c: zero, r: 0, a0: 0, a1: 1, cuts: [0, 1] });
    } else if (e.type === "circle") {
      const c = pointAt(sketch, e.center);
      if (!c || !(e.r > TOL)) continue;
      out.push({ entity: id, circular: true, closed: true, a: zero, b: zero, c, r: e.r, a0: 0, a1: TAU, cuts: [] });
    } else if (e.type === "arc") {
      const c = pointAt(sketch, e.center), s = pointAt(sketch, e.start), en = pointAt(sketch, e.end);
      if (!c || !s || !en) continue;
      const r = Math.hypot(s[0] - c[0], s[1] - c[1]); if (!(r > TOL)) continue;
      const { a0, a1 } = arcSweep(c, s, en);
      out.push({ entity: id, circular: true, closed: false, a: zero, b: zero, c, r, a0, a1, cuts: [a0, a1] });
    } else if (isFreeform(e)) {
      const pieces = freeformPieces(sketch, id);
      (pieces || []).forEach((pc, part) => {
        const poly = samplePiece(pc);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const v of poly) { x0 = Math.min(x0, v[0]); y0 = Math.min(y0, v[1]); x1 = Math.max(x1, v[0]); y1 = Math.max(y1, v[1]); }
        if (Math.max(x1 - x0, y1 - y0) < TOL) return;
        out.push({ entity: id, circular: false, closed: pc.closed, a: zero, b: zero, c: zero, r: 0, a0: pc.t0, a1: pc.t1, cuts: pc.closed ? [] : [pc.t0, pc.t1], free: pc, part: pieces!.length > 1 ? part : undefined, poly, box: [x0 - TOL, y0 - TOL, x1 + TOL, y1 + TOL] });
      });
    }
  }
  return out;
}

/** A curve as a polyline and the parameter at each of its points, for crossing tests. */
function polyOf(k: Curve): { pts: Vec2[]; ts: number[] } {
  if (k.free) { const n = k.poly!.length - 1; return { pts: k.poly!, ts: k.poly!.map((_, i) => k.a0 + ((k.a1 - k.a0) * i) / n) }; }
  if (!k.circular) return { pts: [k.a, k.b], ts: [0, 1] };
  const t1 = k.closed ? k.a0 + TAU : k.a1, n = Math.max(8, Math.ceil(((t1 - k.a0) / TAU) * 96)), ts: number[] = [];
  for (let i = 0; i <= n; i++) ts.push(k.a0 + ((t1 - k.a0) * i) / n);
  return { pts: ts.map((t) => at(k, t)), ts };
}
const tangentOf = (k: Curve, t: number): Vec2 => (k.free ? pieceTangent(k.free, t) : k.circular ? [-k.r * Math.sin(t), k.r * Math.cos(t)] : [k.b[0] - k.a[0], k.b[1] - k.a[1]]);
const boxOf = (k: Curve): [number, number, number, number] => k.box || (k.circular ? [k.c[0] - k.r - TOL, k.c[1] - k.r - TOL, k.c[0] + k.r + TOL, k.c[1] + k.r + TOL] : [Math.min(k.a[0], k.b[0]) - TOL, Math.min(k.a[1], k.b[1]) - TOL, Math.max(k.a[0], k.b[0]) + TOL, Math.max(k.a[1], k.b[1]) + TOL]);

/**
 * Where two curves cross when one is free-form: the crossings of their polylines, each then made exact by
 * Newton's method on the curves themselves.
 */
function meetFree(p: Curve, q: Curve): Vec2[] {
  const bp = boxOf(p), bq = boxOf(q);
  if (bp[0] > bq[2] || bq[0] > bp[2] || bp[1] > bq[3] || bq[1] > bp[3]) return [];
  const A = polyOf(p), B = polyOf(q), out: Vec2[] = [];
  for (let i = 0; i + 1 < A.pts.length; i++) {
    const a0 = A.pts[i], a1 = A.pts[i + 1];
    const ax0 = Math.min(a0[0], a1[0]), ax1 = Math.max(a0[0], a1[0]), ay0 = Math.min(a0[1], a1[1]), ay1 = Math.max(a0[1], a1[1]);
    if (ax0 > bq[2] || ax1 < bq[0] || ay0 > bq[3] || ay1 < bq[1]) continue;
    for (let j = 0; j + 1 < B.pts.length; j++) {
      const b0 = B.pts[j], b1 = B.pts[j + 1];
      if (Math.max(b0[0], b1[0]) < ax0 - TOL || Math.min(b0[0], b1[0]) > ax1 + TOL || Math.max(b0[1], b1[1]) < ay0 - TOL || Math.min(b0[1], b1[1]) > ay1 + TOL) continue;
      const dx = a1[0] - a0[0], dy = a1[1] - a0[1], ex = b1[0] - b0[0], ey = b1[1] - b0[1], den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-18) continue;
      const u = ((b0[0] - a0[0]) * ey - (b0[1] - a0[1]) * ex) / den, v = ((b0[0] - a0[0]) * dy - (b0[1] - a0[1]) * dx) / den;
      if (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) continue;
      let s = A.ts[i] + (A.ts[i + 1] - A.ts[i]) * u, t = B.ts[j] + (B.ts[j + 1] - B.ts[j]) * v;
      // Newton on p(s) = q(t)
      for (let it = 0; it < 12; it++) {
        const ps = at(p, s), qt = at(q, t), fx = ps[0] - qt[0], fy = ps[1] - qt[1];
        if (Math.hypot(fx, fy) < 1e-13) break;
        const dp = tangentOf(p, s), dq = tangentOf(q, t), det = -dp[0] * dq[1] + dp[1] * dq[0];
        if (Math.abs(det) < 1e-18) break;
        s -= (-dq[1] * fx + dq[0] * fy) / det; t -= (-dp[1] * fx + dp[0] * fy) / det;
      }
      const x = at(p, s);
      if (Math.hypot(x[0] - at(q, t)[0], x[1] - at(q, t)[1]) < TOL && !out.some((o) => Math.hypot(o[0] - x[0], o[1] - x[1]) < TOL * 4)) out.push(x);
    }
  }
  return out;
}

/** Points along a stretch of a curve, both ends included. */
function sample(k: Curve, t0: number, t1: number): Vec2[] {
  if (k.free) return samplePiece(k.free, t0, t1);
  if (!k.circular) return [at(k, t0), at(k, t1)];
  const n = Math.max(2, Math.ceil((Math.abs(t1 - t0) / TAU) * 64));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) out.push(at(k, t0 + ((t1 - t0) * i) / n));
  return out;
}

function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

interface Cycle { halves: Half[]; polygon: Vec2[]; area: number; component: number }

export function findRegions(sketch: SketchData): Regions {
  const curves = curvesOf(sketch);

  // ---- cut every curve where it meets another
  for (let i = 0; i < curves.length; i++) for (let j = i + 1; j < curves.length; j++) {
    const p = curves[i], q = curves[j];
    const bp = boxOf(p), bq = boxOf(q);
    if (bp[0] > bq[2] + TOL || bq[0] > bp[2] + TOL || bp[1] > bq[3] + TOL || bq[1] > bp[3] + TOL) continue;
    const pts = meet(p, q);
    // ends that touch the other curve without the carriers crossing cleanly there (a T-junction a hair short)
    for (const k of [p, q]) if (!k.closed) pts.push(at(k, k.a0), at(k, k.a1));
    for (const x of pts) {
      const tp = onCurve(p, x), tq = onCurve(q, x);
      if (tp === null || tq === null) continue;
      p.cuts.push(tp); q.cuts.push(tq);
    }
  }

  // ---- vertices: cut points that fall on the same place are one
  const vx: Vec2[] = [];
  const grid = new Map<string, number[]>();
  const cell = (v: number) => Math.round(v / (TOL * 4));
  const vertex = (p: Vec2): number => {
    const cx = cell(p[0]), cy = cell(p[1]);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of grid.get(`${cx + dx},${cy + dy}`) || []) if (Math.hypot(vx[i][0] - p[0], vx[i][1] - p[1]) <= TOL * 2) return i;
    vx.push(p);
    const key = `${cx},${cy}`; if (!grid.has(key)) grid.set(key, []); grid.get(key)!.push(vx.length - 1);
    return vx.length - 1;
  };

  const edges: Edge[] = [];
  const lone: Curve[] = [];   // whole circles nothing touches
  for (const k of curves) {
    const eps = k.free ? (k.a1 - k.a0) * 1e-9 : k.circular ? TOL / k.r : TOL / Math.hypot(k.b[0] - k.a[0], k.b[1] - k.a[1]);
    const cuts = k.cuts.slice().sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > eps);
    if (k.closed) {
      // angles wrap: a cut at 0 and one at 2π are the same place
      while (cuts.length > 1 && cuts[cuts.length - 1] - cuts[0] > period(k) - eps) cuts.pop();
      if (!cuts.length) { lone.push(k); continue; }
      for (let i = 0; i < cuts.length; i++) {
        const t0 = cuts[i], t1 = i + 1 < cuts.length ? cuts[i + 1] : cuts[0] + period(k);
        edges.push({ curve: k, t0, t1, v0: vertex(at(k, t0)), v1: vertex(at(k, t1)), alive: true });
      }
    } else for (let i = 0; i + 1 < cuts.length; i++) edges.push({ curve: k, t0: cuts[i], t1: cuts[i + 1], v0: vertex(at(k, cuts[i])), v1: vertex(at(k, cuts[i + 1])), alive: true });
  }
  // two pieces that are the same stretch of the same carrier (a line drawn twice) count once
  const seen = new Set<string>();
  for (const e of edges) {
    const m = at(e.curve, (e.t0 + e.t1) / 2);
    const key = `${Math.min(e.v0, e.v1)}:${Math.max(e.v0, e.v1)}:${cell(m[0])},${cell(m[1])}`;
    if (seen.has(key)) e.alive = false; else seen.add(key);
  }

  // ---- drop what leads nowhere
  const degree = new Array<number>(vx.length).fill(0);
  for (const e of edges) if (e.alive) { degree[e.v0]++; degree[e.v1]++; }
  for (let changed = true; changed;) {
    changed = false;
    for (const e of edges) if (e.alive && e.v0 !== e.v1 && (degree[e.v0] === 1 || degree[e.v1] === 1)) { e.alive = false; degree[e.v0]--; degree[e.v1]--; changed = true; }
  }

  // ---- half-edges, in order round each vertex
  const out: Half[][] = vx.map(() => []);
  const halves: Half[] = [];
  for (const e of edges) {
    if (!e.alive) continue;
    for (const forward of [true, false]) {
      const k = e.curve, t = forward ? e.t0 : e.t1;
      let dir: Vec2, bend = 0;
      if (k.free) { const d = tangentOf(k, t); dir = forward ? d : [-d[0], -d[1]]; bend = (forward ? 1 : -1) * pieceCurvature(k.free, t); }
      else if (k.circular) { dir = forward ? [-Math.sin(t), Math.cos(t)] : [Math.sin(t), -Math.cos(t)]; bend = (forward ? 1 : -1) / k.r; }
      else dir = forward ? [k.b[0] - k.a[0], k.b[1] - k.a[1]] : [k.a[0] - k.b[0], k.a[1] - k.b[1]];
      let angle = Math.atan2(dir[1], dir[0]);
      if (angle < -Math.PI + 1e-7) angle = Math.PI;   // -π and +π are one direction
      const h: Half = { edge: e, forward, from: forward ? e.v0 : e.v1, to: forward ? e.v1 : e.v0, angle, bend, next: null, used: false };
      halves.push(h); out[h.from].push(h);
    }
  }
  // at the same direction, the curve that bends further to the left comes later going round counter-clockwise
  for (const list of out) list.sort((p, q) => (Math.abs(p.angle - q.angle) < 1e-7 ? p.bend - q.bend : p.angle - q.angle));
  const twin = (h: Half): Half => out[h.to].find((x) => x.edge === h.edge && x.forward !== h.forward)!;
  for (const h of halves) {
    const list = out[h.to], i = list.indexOf(twin(h));
    h.next = list[(i - 1 + list.length) % list.length];
  }

  // ---- connected groups of curves
  const group = vx.map((_, i) => i);
  const find = (i: number): number => { while (group[i] !== i) { group[i] = group[group[i]]; i = group[i]; } return i; };
  for (const e of edges) if (e.alive) group[find(e.v0)] = find(e.v1);

  // ---- walk the faces
  const cycles: Cycle[] = [];
  for (const start of halves) {
    if (start.used) continue;
    const ring: Half[] = [];
    for (let h: Half | null = start; h && !h.used; h = h.next) { h.used = true; ring.push(h); }
    const polygon: Vec2[] = [];
    for (const h of ring) { const pts = sample(h.edge.curve, h.forward ? h.edge.t0 : h.edge.t1, h.forward ? h.edge.t1 : h.edge.t0); polygon.push(...pts.slice(0, -1)); }
    if (polygon.length < 3) continue;
    const area = signedArea(polygon);
    if (Math.abs(area) < TOL) continue;
    cycles.push({ halves: ring, polygon, area, component: find(ring[0].from) });
  }
  let nextGroup = vx.length;
  for (const k of lone) {
    const t0 = k.free ? k.a0 : 0, t1 = t0 + period(k);
    const polygon = sample(k, t0, t1).slice(0, -1);
    const e: Edge = { curve: k, t0, t1, v0: -1, v1: -1, alive: true };
    const component = nextGroup++;
    const mk = (forward: boolean): Half => ({ edge: e, forward, from: -1, to: -1, angle: 0, bend: 0, next: null, used: true });
    cycles.push({ halves: [mk(true)], polygon, area: signedArea(polygon), component });
    cycles.push({ halves: [mk(false)], polygon: polygon.slice().reverse(), area: -signedArea(polygon), component });
  }

  // ---- nesting: the face of another group each group lies in
  const faces = cycles.filter((c) => c.area > 0);
  const outers = new Map<number, Cycle>();
  for (const c of cycles) if (c.area < 0) { const o = outers.get(c.component); if (!o || c.area < o.area) outers.set(c.component, c); }
  const parent = new Map<number, Cycle | null>();
  for (const [component, outer] of outers) {
    const p = outer.polygon[0];
    let best: Cycle | null = null;
    for (const f of faces) if (f.component !== component && (!best || f.area < best.area) && pointInPolygon(p, f.polygon)) best = f;
    parent.set(component, best);
  }
  const depthOf = new Map<number, number>();
  const depth = (component: number, guard = 0): number => {
    if (depthOf.has(component)) return depthOf.get(component)!;
    const p = parent.get(component);
    const d = p && guard < 64 ? depth(p.component, guard + 1) + 1 : 0;
    depthOf.set(component, d);
    return d;
  };

  const loopOf = (c: Cycle, reverse: boolean): Loop => {
    let edgesOut: SpanEdge[] = c.halves.map((h) => {
      const k = h.edge.curve, tol = k.free ? (k.a1 - k.a0) * 1e-9 : 1e-7;
      const whole = k.closed ? h.edge.t1 - h.edge.t0 >= period(k) - tol && h.edge.v0 === -1 : Math.abs(h.edge.t0 - k.a0) < tol && Math.abs(h.edge.t1 - k.a1) < tol;
      const edge: SpanEdge = { entity: k.entity, reversed: !h.forward };
      if (k.part !== undefined) edge.part = k.part;
      if (!whole) edge.span = [h.edge.t0, h.edge.t1];
      return edge;
    });
    let polygon = c.polygon;
    if (reverse) { edgesOut = edgesOut.reverse().map((e) => ({ ...e, reversed: !e.reversed })); polygon = polygon.slice().reverse(); }
    return { edges: edgesOut, polygon, area: Math.abs(c.area) };
  };

  const regions: Region[] = [];
  const centre = new Map<Region, Vec2>();
  for (const f of faces) {
    if (depth(f.component) % 2) continue;
    const holes: Loop[] = [];
    for (const [component, outer] of outers) if (parent.get(component) === f) holes.push(loopOf(outer, true));
    holes.sort((a, b) => (a.edges[0].entity < b.edges[0].entity ? -1 : 1));
    const outer = loopOf(f, false);
    const region: Region = { id: outer.edges.map((e) => e.entity).sort()[0], outer, holes };
    let cx = 0, cy = 0; for (const p of outer.polygon) { cx += p[0]; cy += p[1]; }
    centre.set(region, [cx / outer.polygon.length, cy / outer.polygon.length]);
    regions.push(region);
  }
  // regions that share their smallest curve are told apart by where they are
  const byId = new Map<string, Region[]>();
  for (const r of regions) { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id)!.push(r); }
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    list.sort((a, b) => { const p = centre.get(a)!, q = centre.get(b)!; return Math.abs(p[0] - q[0]) > TOL ? p[0] - q[0] : p[1] - q[1]; });
    list.forEach((r, i) => { if (i) r.id = `${id}~${i + 1}`; });
  }
  regions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const onLoop = new Set<string>();
  for (const e of edges) if (e.alive) onLoop.add(e.curve.entity);
  for (const k of lone) onLoop.add(k.entity);
  const open = curves.map((k) => k.entity).filter((id) => !onLoop.has(id)).sort();
  return { regions, open };
}

/** The parameter of `p` on the curve when it lies on it (within tolerance), else null. */
function onCurve(k: Curve, p: Vec2): number | null {
  if (k.free) { const b = boxOf(k); if (p[0] < b[0] - TOL * 4 || p[0] > b[2] + TOL * 4 || p[1] < b[1] - TOL * 4 || p[1] > b[3] + TOL * 4) return null; return paramOf(k, p); }
  if (k.circular) { if (Math.abs(Math.hypot(p[0] - k.c[0], p[1] - k.c[1]) - k.r) > TOL * 4) return null; }
  else {
    const dx = k.b[0] - k.a[0], dy = k.b[1] - k.a[1], l = Math.hypot(dx, dy);
    if (Math.abs(dx * (p[1] - k.a[1]) - dy * (p[0] - k.a[0])) / l > TOL * 4) return null;
  }
  return paramOf(k, p);
}

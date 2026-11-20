// curve-shapes.ts — the drawing tools added for the rest of a sketch toolbar: aligned rectangle, three-point
// circle, polygons, ellipses, conics, splines and Bézier curves.  Each is a ShapeSpec for the engine in
// sketch/draw.ts, like the ones in sketch/shapes.ts; the curves themselves are sketch/curves.ts.
//
// As there, every shape is built constrained the way a person means it: a polygon is regular, an aligned
// rectangle stays a rectangle, a control-point spline's control polygon is drawn as construction lines that
// can be dimensioned and constrained.
import type { Vec2 } from "../core/geometry";
import { ellipseNurbs, interpolate, nurbsAt, samplePiece, type Nurbs } from "./curves";
import type { ShapeSpec } from "./draw";
import { pointFor, type Snap } from "./infer";
import { circumcentre } from "./shapes";
import { dist } from "./refs";

const TAU = Math.PI * 2;
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
const ring = (c: Vec2, r: number, a0 = 0, a1 = TAU): Vec2[] => {
  const n = Math.max(8, Math.ceil((Math.abs(a1 - a0) / TAU) * 72)), out: Vec2[] = [];
  for (let i = 0; i <= n; i++) { const t = a0 + ((a1 - a0) * i) / n; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
  return out;
};
const sampled = (n: Nurbs | null): Vec2[] => (n ? samplePiece({ nurbs: n, t0: n.knots[n.degree], t1: n.knots[n.poles.length], closed: false }, undefined, undefined, 16) : []);
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------- aligned rectangle
/** The four corners of the rectangle on the edge a→b, as wide as `c` is from that edge (to the side c is on). */
function aligned(a: Vec2, b: Vec2, c: Vec2): Vec2[] | null {
  const u = sub(b, a), l = len(u); if (l < 1e-9) return null;
  const n: Vec2 = [-u[1] / l, u[0] / l], h = (c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1];
  if (Math.abs(h) < 1e-9) return null;
  return [a, b, [b[0] + n[0] * h, b[1] + n[1] * h], [a[0] + n[0] * h, a[1] + n[1] * h]];
}
export const alignedRectangle: ShapeSpec = {
  id: "sketch-aligned-rectangle", clicks: 3,
  hint: (n) => (n === 0 ? "Click where one edge of the rectangle starts." : n === 1 ? "Click where that edge ends, or type its length." : "Move out to set the width and click, or type it."),
  context: (pts) => (pts.length === 1 ? { from: pts[0].p } : { relations: false }),
  fields: (pts, c) => {
    if (pts.length === 1) return [{ key: "length", label: "L", unit: "mm", value: dist(c, pts[0].p) }];
    const q = aligned(pts[0].p, pts[1].p, c);
    return [{ key: "width", label: "W", unit: "mm", value: q ? dist(q[1], q[2]) : 0 }];
  },
  constrain(pts, c, typed) {
    if (pts.length === 1 && typed.length !== undefined) { const v = sub(c, pts[0].p), l = len(v) || 1; return [pts[0].p[0] + (v[0] / l) * typed.length, pts[0].p[1] + (v[1] / l) * typed.length]; }
    if (pts.length === 2 && typed.width !== undefined) {
      const a = pts[0].p, b = pts[1].p, u = sub(b, a), l = len(u) || 1, n: Vec2 = [-u[1] / l, u[0] / l];
      const side = (c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1] < 0 ? -1 : 1;
      return [b[0] + n[0] * typed.width * side, b[1] + n[1] * typed.width * side];
    }
    return c;
  },
  preview(pts, c) {
    if (pts.length < 2) return [[pts[0].p, c.p]];
    const q = aligned(pts[0].p, pts[1].p, c.p);
    return q ? [[...q, q[0]]] : [[pts[0].p, pts[1].p]];
  },
  build(d, pts, typed) {
    const q = aligned(pts[0].p, pts[1].p, pts[2].p); if (!q) return false;
    const p0 = pointFor(d, pts[0]), p1 = pointFor(d, pts[1]);
    if (p0 === p1) return false;
    const p = [p0, p1, d.point(q[2]), d.point(q[3])];
    const l = [0, 1, 2, 3].map((i) => d.line(p[i], p[(i + 1) % 4]));
    d.constrain("perpendicular", [l[0], l[1]]); d.constrain("parallel", [l[0], l[2]]); d.constrain("parallel", [l[1], l[3]]);
    if (pts[1].horizontal) d.constrain("horizontal", [l[0]]); else if (pts[1].vertical) d.constrain("vertical", [l[0]]);
    if (typed.length !== undefined) d.constrain("distance", [l[0]], { value: typed.length });
    if (typed.width !== undefined) d.constrain("distance", [l[1]], { value: typed.width });
    return {};
  },
};

// ---------------------------------------------------------------- three-point circle
export const circle3: ShapeSpec = {
  id: "sketch-circle-3point", clicks: 3,
  hint: (n) => (n === 0 ? "Click a point on the circle." : n === 1 ? "Click a second point on it." : "Click a third point on it."),
  context: () => ({ relations: false }),
  preview(pts, c) {
    if (pts.length < 2) return [[pts[0].p, c.p]];
    const o = circumcentre(pts[0].p, pts[1].p, c.p);
    return o ? [ring(o, dist(o, c.p))] : [[pts[0].p, pts[1].p]];
  },
  build(d, pts) {
    const o = circumcentre(pts[0].p, pts[1].p, pts[2].p); if (!o) return false;
    const id = d.circle(d.point(o), round6(dist(o, pts[0].p)));
    // the three points are kept, on the circle: they are what the person placed
    for (const s of pts) d.constrain("coincident", [pointFor(d, s), id]);
    return {};
  },
};

// ---------------------------------------------------------------- polygons
let sides = 6;
/** The corners of a regular polygon about `c` with a corner at `v` (inscribed) or an edge's middle at `v`. */
function polygonCorners(c: Vec2, v: Vec2, n: number, circumscribed: boolean): Vec2[] | null {
  const r0 = dist(c, v); if (r0 < 1e-9 || n < 3) return null;
  const a0 = Math.atan2(v[1] - c[1], v[0] - c[0]) - (circumscribed ? Math.PI / n : 0), R = circumscribed ? r0 / Math.cos(Math.PI / n) : r0;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) { const t = a0 + (TAU * i) / n; out.push([c[0] + R * Math.cos(t), c[1] + R * Math.sin(t)]); }
  return out;
}
export function polygon(circumscribed: boolean): ShapeSpec {
  return {
    id: circumscribed ? "sketch-polygon-circumscribed" : "sketch-polygon", clicks: 2,
    hint: (n) => (n ? `Click ${circumscribed ? "the middle of a side" : "a corner"}, or type the ${circumscribed ? "circle's" : "circle's"} diameter or the number of sides (Tab between them).` : `Click the centre of the polygon (${sides} sides).`),
    context: () => ({ relations: false }),
    fields: (pts, c) => [{ key: "diameter", label: "Ø", unit: "mm", value: 2 * dist(c, pts[0].p) }, { key: "sides", label: "N", unit: "n", value: sides }],
    constrain(pts, c, typed) {
      if (typed.sides !== undefined) sides = Math.max(3, Math.min(64, Math.round(typed.sides)));
      if (typed.diameter === undefined) return c;
      const o = pts[0].p, v = sub(c, o), l = len(v) || 1;
      return [o[0] + (v[0] / l) * typed.diameter / 2, o[1] + (v[1] / l) * typed.diameter / 2];
    },
    preview(pts, c) {
      const q = polygonCorners(pts[0].p, c.p, sides, circumscribed);
      return q ? [[...q, q[0]], ring(pts[0].p, dist(pts[0].p, c.p))] : [];
    },
    build(d, pts, typed) {
      if (typed.sides !== undefined) sides = Math.max(3, Math.min(64, Math.round(typed.sides)));
      const q = polygonCorners(pts[0].p, pts[1].p, sides, circumscribed); if (!q) return false;
      const centre = pointFor(d, pts[0]);
      const p = q.map((v) => d.point(v)), l = p.map((_, i) => d.line(p[i], p[(i + 1) % p.length]));
      // a polygon whose sides are equal and whose corners are on a circle is regular
      const outer = d.circle(centre, round6(dist(pts[0].p, q[0])), true);
      for (const id of p) d.constrain("coincident", [id, outer]);
      for (let i = 1; i < l.length; i++) d.constrain("equal", [l[0], l[i]]);
      let sized = outer;
      if (circumscribed) { sized = d.circle(centre, round6(dist(pts[0].p, pts[1].p)), true); d.constrain("tangent", [l[l.length - 1], sized]); }
      if (typed.diameter !== undefined) d.constrain("diameter", [sized], { value: typed.diameter });
      return {};
    },
    reset() { /* the number of sides is remembered for the next polygon */ },
  };
}

// ---------------------------------------------------------------- ellipses
/** The minor radius an ellipse about c with its major axis towards m gets from a pointer at p. */
function minorOf(c: Vec2, m: Vec2, p: Vec2): number {
  const u = sub(m, c), l = len(u); if (l < 1e-12) return 0;
  return Math.abs(u[0] * (p[1] - c[1]) - u[1] * (p[0] - c[0])) / l;
}
function ellipsePoints(c: Vec2, m: Vec2, b: number, e0 = 0, e1 = TAU): Vec2[] {
  const a = dist(c, m); if (a < 1e-9 || b < 1e-9) return [];
  return sampled(ellipseNurbs(c, [(m[0] - c[0]) / a, (m[1] - c[1]) / a], a, b, e0, e1));
}
/** The eccentric angle of the point of an ellipse in the direction of p from its centre. */
function angleOn(c: Vec2, m: Vec2, b: number, p: Vec2): number {
  const a = dist(c, m), u: Vec2 = [(m[0] - c[0]) / a, (m[1] - c[1]) / a], dx = p[0] - c[0], dy = p[1] - c[1];
  return Math.atan2((-u[1] * dx + u[0] * dy) / b, (u[0] * dx + u[1] * dy) / a);
}
function onEllipse(c: Vec2, m: Vec2, b: number, t: number): Vec2 {
  const a = dist(c, m), u: Vec2 = [(m[0] - c[0]) / a, (m[1] - c[1]) / a];
  return [c[0] + a * Math.cos(t) * u[0] - b * Math.sin(t) * u[1], c[1] + a * Math.cos(t) * u[1] + b * Math.sin(t) * u[0]];
}
const ellipseFields = (pts: Snap[], c: Vec2) => (pts.length === 1 ? [{ key: "major", label: "R", unit: "mm" as const, value: dist(c, pts[0].p) }] : pts.length === 2 ? [{ key: "minor", label: "r", unit: "mm" as const, value: minorOf(pts[0].p, pts[1].p, c) }] : []);
const ellipseConstrain = (pts: Snap[], c: Vec2, typed: { [k: string]: number }): Vec2 => {
  const o = pts[0].p;
  if (pts.length === 1 && typed.major !== undefined) { const v = sub(c, o), l = len(v) || 1; return [o[0] + (v[0] / l) * typed.major, o[1] + (v[1] / l) * typed.major]; }
  if (pts.length === 2 && typed.minor !== undefined) {
    const u = sub(pts[1].p, o), l = len(u) || 1, n: Vec2 = [-u[1] / l, u[0] / l], side = (c[0] - o[0]) * n[0] + (c[1] - o[1]) * n[1] < 0 ? -1 : 1;
    return [o[0] + n[0] * typed.minor * side, o[1] + n[1] * typed.minor * side];
  }
  return c;
};

export const ellipse: ShapeSpec = {
  id: "sketch-ellipse", clicks: 3,
  hint: (n) => (n === 0 ? "Click the centre of the ellipse." : n === 1 ? "Click the end of its major axis, or type the major radius." : "Move out to set the minor radius and click, or type it."),
  context: (pts) => (pts.length === 1 ? { from: pts[0].p } : { relations: false }),
  fields: ellipseFields,
  constrain: ellipseConstrain,
  preview(pts, c) {
    if (pts.length < 2) return [[pts[0].p, c.p]];
    return [ellipsePoints(pts[0].p, pts[1].p, minorOf(pts[0].p, pts[1].p, c.p)), [pts[0].p, pts[1].p]];
  },
  build(d, pts, typed) {
    const b = minorOf(pts[0].p, pts[1].p, pts[2].p);
    if (b < 1e-7 || dist(pts[0].p, pts[1].p) < 1e-7) return false;
    const c = pointFor(d, pts[0]), m = pointFor(d, pts[1]);
    if (c === m) return false;
    const id = d.id("e");
    d.set(id, { type: "ellipse", center: c, major: m, minor: round6(Math.min(b, dist(pts[0].p, pts[1].p))), ...(d.construction ? { construction: true } : {}) });
    if (pts[1].horizontal) d.constrain("horizontal", [c, m]); else if (pts[1].vertical) d.constrain("vertical", [c, m]);
    if (typed.major !== undefined) d.constrain("distance", [c, m], { value: typed.major });
    return {};
  },
};

export function partialEllipse(): ShapeSpec {
  // which way round the pointer has gone from the start
  let swept = 0, last: number | null = null;
  const track = (t: number) => { if (last !== null) { let dt = t - last; while (dt > Math.PI) dt -= TAU; while (dt < -Math.PI) dt += TAU; swept += dt; } last = t; swept = Math.max(-TAU * 0.999, Math.min(TAU * 0.999, swept)); };
  return {
    id: "sketch-partial-ellipse", clicks: 5,
    hint: (n) => ["Click the centre of the ellipse.", "Click the end of its major axis, or type the major radius.", "Move out to set the minor radius and click, or type it.", "Click where the partial ellipse starts.", "Move round and click where it ends."][Math.min(n, 4)],
    context: (pts) => (pts.length === 1 ? { from: pts[0].p } : { relations: false }),
    fields: ellipseFields,
    constrain: ellipseConstrain,
    reset: () => { swept = 0; last = null; },
    preview(pts, c) {
      if (pts.length < 2) return [[pts[0].p, c.p]];
      const [o, m] = [pts[0].p, pts[1].p];
      if (pts.length === 2) return [ellipsePoints(o, m, minorOf(o, m, c.p)), [o, m]];
      const b = minorOf(o, m, pts[2].p);
      if (pts.length === 3) { last = null; swept = 0; return [ellipsePoints(o, m, b), [o, c.p]]; }
      const t0 = angleOn(o, m, b, pts[3].p);
      track(angleOn(o, m, b, c.p) - t0);
      return [swept >= 0 ? ellipsePoints(o, m, b, t0, t0 + swept) : ellipsePoints(o, m, b, t0 + swept, t0)];
    },
    build(d, pts) {
      const [o, m] = [pts[0].p, pts[1].p], b = Math.min(minorOf(o, m, pts[2].p), dist(o, m));
      if (b < 1e-7 || dist(o, m) < 1e-7) return false;
      const t0 = angleOn(o, m, b, pts[3].p);
      track(angleOn(o, m, b, pts[4].p) - t0);
      if (Math.abs(swept) < 1e-6) return false;
      const t1 = t0 + swept, s = onEllipse(o, m, b, Math.min(t0, t1)), e = onEllipse(o, m, b, Math.max(t0, t1));
      const c = pointFor(d, pts[0]), mj = d.point(m);   // the major-axis point is the curve's own (a click there is only a place)
      const start = d.point(s), end = d.point(e);
      const id = d.id("e");
      d.set(id, { type: "ellipticalArc", center: c, major: mj, minor: round6(b), start, end, ...(d.construction ? { construction: true } : {}) });
      return {};
    },
  };
}

// ---------------------------------------------------------------- conic
let rho = 0.5;
const conicNurbs = (s: Vec2, a: Vec2, e: Vec2, r: number): Nurbs => ({ degree: 2, poles: [s, a, e], weights: [1, r / (1 - r), 1], knots: [0, 0, 0, 1, 1, 1] });
export const conic: ShapeSpec = {
  id: "sketch-conic", clicks: 3,
  hint: (n) => (n === 0 ? "Click where the conic starts." : n === 1 ? "Click where it ends." : `Click its control point (where its end tangents meet). Rho ${rho} (Tab, then type 0.5 for a parabola, less for an ellipse, more for a hyperbola).`),
  context: (pts) => (pts.length === 1 ? { from: pts[0].p } : { relations: false }),
  fields: (pts) => (pts.length === 2 ? [{ key: "rho", label: "ρ", unit: "n", value: rho }] : []),
  constrain(_pts, c, typed) { if (typed.rho !== undefined && typed.rho > 0 && typed.rho < 1) rho = typed.rho; return c; },
  preview(pts, c) {
    if (pts.length < 2) return [[pts[0].p, c.p]];
    return [sampled(conicNurbs(pts[0].p, c.p, pts[1].p, rho)), [pts[0].p, c.p, pts[1].p]];
  },
  build(d, pts, typed) {
    if (typed.rho !== undefined && typed.rho > 0 && typed.rho < 1) rho = typed.rho;
    const [s, e, a] = [pts[0].p, pts[1].p, pts[2].p];
    if (dist(s, e) < 1e-7 || Math.abs((e[0] - s[0]) * (a[1] - s[1]) - (e[1] - s[1]) * (a[0] - s[0])) < 1e-9) return false;
    const start = pointFor(d, pts[0]), end = pointFor(d, pts[1]);
    if (start === end) return false;
    const apex = pointFor(d, pts[2]);
    // the tangents at its ends, through the control point, as construction lines (to constrain and dimension)
    d.line(start, apex, true); d.line(end, apex, true);
    const id = d.id("q");
    d.set(id, { type: "conic", start, apex, end, rho, ...(d.construction ? { construction: true } : {}) });
    return {};
  },
};

// ---------------------------------------------------------------- splines
let handles = false;
/** A spline's last click closes it when it is back on the first point (or within a whisker of it). */
function closes(pts: Snap[]): boolean {
  if (pts.length < 4) return false;
  const a = pts[0], b = pts[pts.length - 1];
  if (a.point && b.point === a.point) return true;
  let size = 0;
  for (const p of pts) size = Math.max(size, dist(p.p, a.p));
  return dist(a.p, b.p) <= size * 0.02;
}
/** The spline tool: through the points clicked; Enter ends it, a click back on the first point closes it. */
export const spline: ShapeSpec = {
  id: "sketch-spline", clicks: 200, min: 2,
  hint: (n) => (n === 0 ? `Click where the spline starts. H: ${handles ? "with" : "without"} end handles.` : n === 1 ? "Click the next point." : "Click the next point; Enter ends the spline, a click on its first point closes it."),
  context: (pts) => (pts.length ? { from: pts[pts.length - 1].p, relations: false } : {}),
  done: closes,
  key: (ev) => { if (ev.key !== "h" && ev.key !== "H") return false; handles = !handles; return true; },
  preview(pts, c) {
    const p = [...pts.map((s) => s.p), c.p].filter((v, i, a) => !i || dist(v, a[i - 1]) > 1e-9);
    return p.length >= 2 ? [sampled(interpolate(p, false, null, null))] : [];
  },
  build(d, pts) {
    const closed = closes(pts);
    let s = (closed ? pts.slice(0, -1) : pts).filter((v, i, a) => !i || dist(v.p, a[i - 1].p) > 1e-9);
    if (s.length < 2) return false;
    const ids = s.map((x) => pointFor(d, x));
    if (new Set(ids).size !== ids.length) return false;
    const id = d.id("s");
    const e: { [k: string]: unknown } = { type: "spline", points: ids };
    if (closed) e.closed = true;
    else if (handles) {
      // a handle at each end: the first control point of the end span, joined to the end by a construction line
      const n = interpolate(s.map((x) => x.p), false, null, null);
      if (n) {
        const h0 = d.point(n.poles[1]), h1 = d.point(n.poles[n.poles.length - 2]);
        d.line(ids[0], h0, true); d.line(ids[ids.length - 1], h1, true);
        e.startHandle = h0; e.endHandle = h1;
      }
    }
    if (d.construction) e.construction = true;
    d.set(id, e as never);
    return {};
  },
};

function controlSpline(id: string, bezier: boolean): ShapeSpec {
  return {
    id, clicks: bezier ? 12 : 200, min: bezier ? 3 : 2,
    hint: (n) => (n === 0 ? (bezier ? "Click the first point of the Bézier curve." : "Click the first control point.") : n < 2 ? "Click the next control point." : `Click the next control point; Enter ends the ${bezier ? "curve" : "spline"}.`),
    context: (pts) => (pts.length ? { from: pts[pts.length - 1].p, relations: false } : {}),
    preview(pts, c) {
      const p = [...pts.map((s) => s.p), c.p];
      const degree = bezier ? p.length - 1 : Math.min(3, p.length - 1);
      if (degree < 1) return [];
      const knots: number[] = [];
      for (let i = 0; i <= degree; i++) knots.push(0);
      for (let i = 1; i < p.length - degree; i++) knots.push(i);
      for (let i = 0; i <= degree; i++) knots.push(p.length - degree);
      const n: Nurbs = { degree, poles: p, weights: null, knots };
      const out: Vec2[] = [];
      for (let i = 0; i <= 96; i++) out.push(nurbsAt(n, (knots[knots.length - 1] * i) / 96));
      return [out, p];
    },
    build(d, pts) {
      const s = pts.filter((v, i, a) => !i || dist(v.p, a[i - 1].p) > 1e-9);
      if (s.length < (bezier ? 3 : 2)) return false;
      const ids = s.map((x) => pointFor(d, x));
      if (new Set(ids).size !== ids.length) return false;
      for (let i = 1; i < ids.length; i++) d.line(ids[i - 1], ids[i], true);   // the control polygon
      const degree = bezier ? ids.length - 1 : Math.min(3, ids.length - 1);
      d.set(d.id("z"), { type: "bspline", poles: ids, degree, ...(d.construction ? { construction: true } : {}) });
      return {};
    },
  };
}
export const controlPointSpline = controlSpline("sketch-control-spline", false);
export const bezier = controlSpline("sketch-bezier", true);

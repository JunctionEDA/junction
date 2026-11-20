// _sketch-edges.ts — an edge of the model as the curves a sketch can hold, in sketch-plane coordinates: what
// "Use edge" (sketch-project), "Intersection" (sketch-intersect) and "Pierce" (sketch-pierce) answer with.
//
//   { type: "point", p }                               a vertex, or an edge seen end-on
//   { type: "line", a, b }                             a straight edge (or a circle seen edge-on)
//   { type: "circle", c, r } / { type: "arc", c, s, e } a circular edge parallel to the plane (arc: counter-clockwise)
//   { type: "ellipse", c, m, minor }                   an ellipse (a tilted circle's shadow, a cylinder cut at a slant):
//   { type: "ellipticalArc", c, m, minor, s, e }        m is the end of the major semi-axis; counter-clockwise
//   { type: "spline", points, closed }                 anything else, as a spline through points along it
import { toPlane, type Frame, type GeomRef, type Vec2, type Vec3 } from "../core/geometry";
import type { Kernel } from "../kernel/occ";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type SketchCurve2 =
  | { type: "point"; p: Vec2; from: GeomRef }
  | { type: "line"; a: Vec2; b: Vec2; from: GeomRef }
  | { type: "circle"; c: Vec2; r: number; from: GeomRef }
  | { type: "arc"; c: Vec2; s: Vec2; e: Vec2; from: GeomRef }
  | { type: "ellipse"; c: Vec2; m: Vec2; minor: number; from: GeomRef }
  | { type: "ellipticalArc"; c: Vec2; m: Vec2; minor: number; s: Vec2; e: Vec2; from: GeomRef }
  | { type: "spline"; points: Vec2[]; closed: boolean; from: GeomRef };

const TAU = Math.PI * 2;
const r9 = (v: number) => Math.round(v * 1e9) / 1e9;

/**
 * The ellipse an affine image of a unit circle is: centre c, conjugate semi-diameters u and v (the images of the
 * circle's two axes), as centre, end of the major semi-axis, minor radius, and the eccentric angle the circle's
 * angle 0 lands at.
 */
export function ellipseFromConjugates(c: Vec2, u: Vec2, v: Vec2): { m: Vec2; a: number; b: number; phase: number } {
  // p(θ) = c + u cos θ + v sin θ; the axes are where |p − c| is extreme: tan 2θ = 2 u·v / (u·u − v·v)
  const uu = u[0] * u[0] + u[1] * u[1], vv = v[0] * v[0] + v[1] * v[1], uv = u[0] * v[0] + u[1] * v[1];
  const t0 = 0.5 * Math.atan2(2 * uv, uu - vv);
  const at = (t: number): Vec2 => [u[0] * Math.cos(t) + v[0] * Math.sin(t), u[1] * Math.cos(t) + v[1] * Math.sin(t)];
  const p0 = at(t0), p1 = at(t0 + Math.PI / 2), a0 = Math.hypot(p0[0], p0[1]), a1 = Math.hypot(p1[0], p1[1]);
  const major = a0 >= a1 ? t0 : t0 + Math.PI / 2, pm = at(major);
  return { m: [c[0] + pm[0], c[1] + pm[1]], a: Math.max(a0, a1), b: Math.min(a0, a1), phase: -major };
}

/** One edge, projected straight onto the sketch plane (an edge that lies in it is unchanged). */
export function edgeOnPlane(oc: any, k: Kernel, edge: any, frame: Frame, from: GeomRef): { curves: SketchCurve2[]; why?: string } {
  const n = frame.normal;
  const flat = (p: Vec3): Vec2 => { const q = toPlane(frame, p); return [r9(q[0]), r9(q[1])]; };
  const flatDir = (d: Vec3): Vec2 => [d[0] * frame.x[0] + d[1] * frame.x[1] + d[2] * frame.x[2], d[0] * frame.y[0] + d[1] * frame.y[1] + d[2] * frame.y[2]];
  const ad = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  try {
    let t0 = ad.FirstParameter(), t1 = ad.LastParameter();
    const at = (t: number): Vec3 => { const p = ad.Value(t), v = k.xyz(p); p.delete(); return v; };
    // an edge's orientation can run it backwards; the curve's parameter is what matters here
    const type = ad.GetType();
    const is = (name: string) => type === oc.GeomAbs_CurveType[name];   // this build's enums are strings
    if (is("GeomAbs_Line")) {
      const p = flat(at(t0)), q = flat(at(t1));
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-7) return { curves: [{ type: "point", p, from }] };
      return { curves: [{ type: "line", a: p, b: q, from }] };
    }
    if (is("GeomAbs_Circle") || is("GeomAbs_Ellipse")) {
      const circle = is("GeomAbs_Circle");
      const g = circle ? ad.Circle() : ad.Ellipse(), pos = g.Position(), loc = pos.Location(), xd = pos.XDirection(), yd = pos.YDirection(), zd = pos.Direction();
      const c = k.xyz(loc), X: Vec3 = [xd.X(), xd.Y(), xd.Z()], Y: Vec3 = [yd.X(), yd.Y(), yd.Z()], Z: Vec3 = [zd.X(), zd.Y(), zd.Z()];
      const ra = circle ? g.Radius() : g.MajorRadius(), rb = circle ? g.Radius() : g.MinorRadius();
      for (const o of [loc, xd, yd, zd, pos, g]) o.delete();
      const along = Z[0] * n[0] + Z[1] * n[1] + Z[2] * n[2];
      const full = Math.abs(t1 - t0) >= TAU - 1e-9;
      const C = flat(c);
      // the images of the curve's own axes on the plane: p(t) = C + U cos t + V sin t
      const U = flatDir([X[0] * ra, X[1] * ra, X[2] * ra]), V = flatDir([Y[0] * rb, Y[1] * rb, Y[2] * rb]);
      if (Math.abs(along) < 1e-9) {
        // seen edge-on: a line along the longer of the two images
        const ends: Vec2[] = [];
        if (full) { const W = Math.hypot(U[0], U[1]) >= Math.hypot(V[0], V[1]) ? U : V; ends.push([C[0] - W[0], C[1] - W[1]], [C[0] + W[0], C[1] + W[1]]); }
        else { let lo = Infinity, hi = -Infinity; const dir = Math.hypot(U[0], U[1]) >= Math.hypot(V[0], V[1]) ? U : V, l = Math.hypot(dir[0], dir[1]) || 1; for (let i = 0; i <= 64; i++) { const q = flat(at(t0 + ((t1 - t0) * i) / 64)), s = ((q[0] - C[0]) * dir[0] + (q[1] - C[1]) * dir[1]) / l; lo = Math.min(lo, s); hi = Math.max(hi, s); } ends.push([C[0] + (dir[0] / l) * lo, C[1] + (dir[1] / l) * lo], [C[0] + (dir[0] / l) * hi, C[1] + (dir[1] / l) * hi]); }
        return { curves: [{ type: "line", a: [r9(ends[0][0]), r9(ends[0][1])], b: [r9(ends[1][0]), r9(ends[1][1])], from }] };
      }
      // looking down the plane's normal, a curve whose axis points away from it runs clockwise: turn it round
      const ccw = along > 0;
      if (!ccw) { const t = t0; t0 = -t1; t1 = -t; V[0] = -V[0]; V[1] = -V[1]; }
      const round = Math.abs(Math.hypot(U[0], U[1]) - Math.hypot(V[0], V[1])) < 1e-9 && Math.abs(U[0] * V[0] + U[1] * V[1]) < 1e-9;
      if (round) {
        const r = r9(Math.hypot(U[0], U[1]));
        if (full) return { curves: [{ type: "circle", c: C, r, from }] };
        const p = (t: number): Vec2 => [r9(C[0] + U[0] * Math.cos(t) + V[0] * Math.sin(t)), r9(C[1] + U[1] * Math.cos(t) + V[1] * Math.sin(t))];
        return { curves: [{ type: "arc", c: C, s: p(t0), e: p(t1), from }] };
      }
      const el = ellipseFromConjugates(C, U, V);
      const m: Vec2 = [r9(el.m[0]), r9(el.m[1])], minor = r9(el.b);
      if (full) return { curves: [{ type: "ellipse", c: C, m, minor, from }] };
      const p = (t: number): Vec2 => [r9(C[0] + U[0] * Math.cos(t) + V[0] * Math.sin(t)), r9(C[1] + U[1] * Math.cos(t) + V[1] * Math.sin(t))];
      return { curves: [{ type: "ellipticalArc", c: C, m, minor, s: p(t0), e: p(t1), from }] };
    }
    // anything else: a spline through points along it (enough to follow it to a few microns at sketch sizes)
    const count = Math.max(8, Math.min(64, (ad.NbIntervals(oc.GeomAbs_Shape.GeomAbs_C2) || 1) * 8));
    const pts: Vec2[] = [];
    for (let i = 0; i <= count; i++) { const q = flat(at(t0 + ((t1 - t0) * i) / count)); if (!pts.length || Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]) > 1e-7) pts.push(q); }
    if (pts.length < 2) return { curves: pts.length ? [{ type: "point", p: pts[0], from }] : [], why: pts.length ? undefined : "That edge has no length on the sketch plane." };
    const closed = pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6;
    if (closed) pts.pop();
    return { curves: [{ type: "spline", points: pts, closed, from }] };
  } finally { ad.delete(); }
}

// curves.ts — what the curve features (features/{fit-spline,projected-curve,bridging-curve,composite-curve,
// intersection-curve,trim-curve,isocline,routing-curve}.ts) share: splines through points, Bézier bridges, the
// edges where two shapes cross, chaining loose edges into wires, the facts at one end of a curve, and handing
// the result to the model as reference geometry of kind "curve".
//
// A curve feature's result is one wire when its edges join end to end, else a compound of wires (an
// intersection of a plane with a holed part is several loops).  It is drawn as one polyline with the pieces
// apart: a NaN point between them (viewport/datums.ts leaves out a segment that touches one).
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "../../core/geometry";
import type { EvalContext, Shape } from "../types";
import { compound } from "./shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TOL = 1e-6;

/** A curve's own parameter range and its 3D points, from an edge or a wire. */
function adaptor(ctx: EvalContext, curve: Shape): any {
  const oc = ctx.oc as any;
  const isWire = curve.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE;
  return ctx.tmp(isWire ? new oc.BRepAdaptor_CompCurve(oc.TopoDS.Wire(curve), true) : new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(curve)));
}

/** Points along an edge or a wire, `n` + 1 of them, evenly in its parameter. */
export function samplePoints(ctx: EvalContext, curve: Shape, n = 64): Vec3[] {
  const k = ctx.k, ad = adaptor(ctx, curve);
  const u0 = ad.FirstParameter(), u1 = ad.LastParameter(), out: Vec3[] = [];
  for (let i = 0; i <= n; i++) { const p = ad.Value(u0 + ((u1 - u0) * i) / n); out.push(k.xyz(p)); p.delete(); }
  return out;
}

/** The length of an edge or a wire. */
export function curveLength(ctx: EvalContext, curve: Shape): number {
  const pts = samplePoints(ctx, curve, 256);
  let s = 0; for (let i = 1; i < pts.length; i++) s += length(sub(pts[i], pts[i - 1]));
  return s;
}

/**
 * The facts at one end of a curve: the point, the unit tangent pointing out of the curve (away from its
 * body), and the curvature vector there (towards the centre of curvature, of size 1/radius).
 */
export function curveEnd(ctx: EvalContext, curve: Shape, atEnd: boolean): { at: Vec3; out: Vec3; curvature: Vec3 } {
  const oc = ctx.oc as any, k = ctx.k, ad = adaptor(ctx, curve);
  const u = atEnd ? ad.LastParameter() : ad.FirstParameter();
  const p = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), d1 = ctx.tmp(new oc.gp_Vec(0, 0, 0)), d2 = ctx.tmp(new oc.gp_Vec(0, 0, 0));
  ad.D2(u, p, d1, d2);
  const v1 = k.xyz(d1), v2 = k.xyz(d2), s = length(v1);
  if (s < TOL) throw ctx.fail("A curve has no direction at its end.");
  const t = scale(v1, 1 / s);
  // the part of the second derivative across the curve, over the speed squared
  const curvature = scale(sub(v2, scale(t, dot(v2, t))), 1 / (s * s));
  return { at: k.xyz(p), out: atEnd ? t : scale(t, -1), curvature };
}

/** An edge through points (a periodic, closed one when `closed`), optionally with its end tangents given. */
export function splineThrough(ctx: EvalContext, points: readonly Vec3[], o: { closed?: boolean; start?: Vec3 | null; end?: Vec3 | null } = {}): Shape {
  const oc = ctx.oc as any, k = ctx.k;
  const pts = points.filter((p, i) => i === 0 || length(sub(p, points[i - 1])) > TOL);
  if (o.closed && pts.length > 2 && length(sub(pts[0], pts[pts.length - 1])) < TOL) pts.pop();
  if (pts.length < 2) throw ctx.fail("A spline needs two or more points apart from each other.");
  if (pts.length === 2 && !o.start && !o.end) return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(pts[0])), ctx.tmp(k.pnt(pts[1])))).Edge());
  const arr = ctx.tmp(new oc.NCollection_Array1_gp_Pnt(1, pts.length));
  pts.forEach((p, i) => arr.SetValue(i + 1, ctx.tmp(k.pnt(p))));
  const harr = ctx.tmp(new oc.NCollection_HArray1_gp_Pnt(arr));
  const ip = ctx.tmp(new oc.GeomAPI_Interpolate(harr, !!o.closed, TOL));
  if (o.start || o.end) {
    const span = length(sub(pts[pts.length - 1], pts[0])) || 1;
    // an end with no tangent given follows the chord there
    const t0 = o.start ? normalize(o.start) : normalize(sub(pts[1], pts[0])), t1 = o.end ? normalize(o.end) : normalize(sub(pts[pts.length - 1], pts[pts.length - 2]));
    ip.Load(ctx.tmp(k.vec(scale(t0, span))), ctx.tmp(k.vec(scale(t1, span))), true);
  }
  try { ip.Perform(); } catch (x) { throw ctx.fail(`The spline could not be built (${k.describe(x)}).`); }
  if (!ip.IsDone()) throw ctx.fail("The spline could not be built through these points.");
  const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ip.Curve()));
  if (!mk.IsDone()) throw ctx.fail("The spline could not be built.");
  return ctx.own(mk.Edge());
}

/** A Bézier edge with these poles. */
export function bezierEdge(ctx: EvalContext, poles: readonly Vec3[]): Shape {
  const oc = ctx.oc as any, k = ctx.k;
  const arr = ctx.tmp(new oc.NCollection_Array1_gp_Pnt(1, poles.length));
  poles.forEach((p, i) => arr.SetValue(i + 1, ctx.tmp(k.pnt(p))));
  const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(new oc.Geom_BezierCurve(arr)));
  if (!mk.IsDone()) throw ctx.fail("The curve could not be built.");
  return ctx.own(mk.Edge());
}

/** A straight edge. */
export function segment(ctx: EvalContext, a: Vec3, b: Vec3): Shape {
  const oc = ctx.oc as any, k = ctx.k;
  return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(a)), ctx.tmp(k.pnt(b)))).Edge());
}

/** An arc through three points. */
export function arcThrough(ctx: EvalContext, a: Vec3, m: Vec3, b: Vec3): Shape {
  const oc = ctx.oc as any, k = ctx.k;
  const arc = ctx.tmp(new oc.GC_MakeArcOfCircle(ctx.tmp(k.pnt(a)), ctx.tmp(k.pnt(m)), ctx.tmp(k.pnt(b))));
  return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(arc.Value())).Edge());
}

/** The edges where two shapes cross. */
export function sectionEdges(ctx: EvalContext, a: Shape, b: Shape): Shape[] {
  const oc = ctx.oc as any, k = ctx.k;
  const s = ctx.tmp(new oc.BRepAlgoAPI_Section(a, b, false));
  s.Approximation(true);
  try { s.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (x) { throw ctx.fail(`The intersection could not be found (${k.describe(x)}).`); }
  if (!s.IsDone()) throw ctx.fail("The intersection could not be found.");
  return k.sub(ctx.own(s.Shape()), "edge");
}

/** The two end points of an edge (equal for a closed one). */
function endsOf(ctx: EvalContext, e: Shape): [Vec3, Vec3] {
  const ad = adaptor(ctx, e), k = ctx.k;
  const a = ad.Value(ad.FirstParameter()), b = ad.Value(ad.LastParameter());
  const out: [Vec3, Vec3] = [k.xyz(a), k.xyz(b)]; a.delete(); b.delete();
  return out;
}

/** Loose edges joined end to end into as few wires as they make; `tol` is how close two ends must be. */
export function chainEdges(ctx: EvalContext, edges: readonly Shape[], tol = 1e-4): Shape[] {
  const oc = ctx.oc as any;
  const ends = edges.map((e) => endsOf(ctx, e));
  const near = (a: Vec3, b: Vec3) => length(sub(a, b)) < tol;
  const used = new Set<number>(), wires: Shape[] = [];
  for (let seed = 0; seed < edges.length; seed++) {
    if (used.has(seed)) continue;
    used.add(seed);
    const chain = [seed];
    let head = ends[seed][0], tail = ends[seed][1];
    // grow the chain at either end until nothing more joins it
    for (let grown = true; grown && !near(head, tail);) {
      grown = false;
      for (let j = 0; j < edges.length; j++) {
        if (used.has(j)) continue;
        const [a, b] = ends[j];
        if (near(a, tail) || near(b, tail)) { tail = near(a, tail) ? b : a; chain.push(j); }
        else if (near(a, head) || near(b, head)) { head = near(a, head) ? b : a; chain.unshift(j); }
        else continue;
        used.add(j); grown = true;
      }
    }
    const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
    for (const j of chain) mw.Add(oc.TopoDS.Edge(edges[j]));
    if (!mw.IsDone()) {
      // the kernel would not join them (a gap above its tolerance): keep each edge as a wire of its own
      for (const j of chain) wires.push(ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeWire(oc.TopoDS.Edge(edges[j]))).Wire()));
      continue;
    }
    wires.push(ctx.own(mw.Wire()));
  }
  return wires;
}

/** Hand curve pieces (edges or wires) to the model as this feature's reference curve. */
export function setCurve(ctx: EvalContext, pieces: readonly Shape[]): void {
  const oc = ctx.oc as any;
  const edges: Shape[] = [];
  for (const p of pieces) edges.push(...(p.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE ? [p] : ctx.k.sub(p, "edge")));
  if (!edges.length) throw ctx.fail("The curve is empty.");
  const wires = chainEdges(ctx, edges);
  const points: number[] = [];
  for (const w of wires) {
    if (points.length) points.push(NaN, NaN, NaN);
    const n = Math.min(1024, Math.max(32, 24 * ctx.k.sub(w, "edge").length));
    for (const p of samplePoints(ctx, w, n)) points.push(...p);
  }
  const shape = wires.length === 1 ? wires[0] : compound(ctx.k, wires, ctx.own);
  ctx.setDatum({ featureId: ctx.feature.id, kind: "curve", shape, points });
}

/** Unit vector square to `v` (any one). */
export function across(v: Vec3): Vec3 {
  const a: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(v, a));
}


/** The sheet a curve sweeps out moved straight along `dir`, `reach` to either side of it: what projects it. */
export function sweptSheet(ctx: EvalContext, curve: Shape, dir: Vec3, reach: number): Shape {
  const oc = ctx.oc as any, k = ctx.k;
  const d = normalize(dir);
  const t = ctx.tmp(new oc.gp_Trsf());
  t.SetTranslation(ctx.tmp(k.vec(scale(d, -reach))));
  const back = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_Transform(curve, t, true, false)).Shape());
  const mk = ctx.tmp(new oc.BRepPrimAPI_MakePrism(back, ctx.tmp(k.vec(scale(d, 2 * reach))), false, true));
  return ctx.own(mk.Shape());
}

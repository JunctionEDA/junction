// trim-curve.ts — the Trim curve feature: shorten or lengthen a curve at one end, by a distance or up to a
// bounding point, plane or face.  A negative distance trims; a positive one extends straight on along the
// curve's direction at that end (Onshape's "linear" extension).  The curve is one edge, a sketch curve or a
// reference curve made of one edge.
import { defineFeature } from "../core/feature";
import { add, isGeomRef, length, scale, sub, type Vec3 } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { curveOf, planeOf, pointOf } from "../kernel/ops/ref-geom";
import { modelSize } from "../kernel/ops/ref-datum";
import { planeFace } from "../kernel/ops/shapes";
import { curveEnd, segment, setCurve } from "../kernel/ops/curves";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TrimCurveParams { [key: string]: any; curve: RefTarget | null; end: "end" | "start"; by: "distance" | "entity"; distance: number; bound: RefTarget | null }

/** The edge's curve, the parameter range it uses, and the parameter `len` along it from one end. */
function edgeCurve(ctx: EvalContext, edge: Shape) {
  const oc = ctx.oc as any, k = ctx.k;
  const r = oc.BRep_Tool.Curve(oc.TopoDS.Edge(edge), 0, 1);
  const curve = r.returnValue, u0 = r.First, u1 = r.Last;
  const N = 512, us: number[] = [], lens = [0];
  let prev: Vec3 | null = null;
  for (let i = 0; i <= N; i++) {
    const u = u0 + ((u1 - u0) * i) / N, q = curve.Value(u), v = k.xyz(q); q.delete();
    if (prev) lens.push(lens[lens.length - 1] + length(sub(v, prev)));
    us.push(u); prev = v;
  }
  const total = lens[N];
  /** the parameter `len` along the curve from its first end */
  const at = (len: number) => {
    let i = 1; while (i < N && lens[i] < len) i++;
    const seg = lens[i] - lens[i - 1], f = seg > 1e-12 ? (len - lens[i - 1]) / seg : 0;
    return us[i - 1] + (us[i] - us[i - 1]) * Math.max(0, Math.min(1, f));
  };
  return { curve, u0, u1, total, at };
}

/** The distance along the curve from its first end to a point on it. */
function lengthTo(ctx: EvalContext, edge: Shape, point: Vec3): number {
  const oc = ctx.oc as any, k = ctx.k;
  const v = ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(ctx.tmp(k.pnt(point)))).Vertex();
  const d = ctx.tmp(new oc.BRepExtrema_DistShapeShape());
  d.LoadS1(edge); d.LoadS2(v); d.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  const u = d.ParOnEdgeS1(1, 0).t;
  const e = edgeCurve(ctx, edge);
  const sub0 = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(e.curve, e.u0, Math.max(e.u0 + 1e-12, u))).Edge();
  return e.total ? measured(ctx, sub0) : 0;
}

function measured(ctx: EvalContext, edge: Shape): number {
  const oc = ctx.oc as any;
  const props = ctx.tmp(new oc.GProp_GProps());
  oc.BRepGProp.LinearProperties(edge, props, false, false);
  return props.Mass();
}

/** Every point where a shape meets `bound` (to within a small tolerance). */
function meets(ctx: EvalContext, shape: Shape, bound: Shape): Vec3[] {
  const oc = ctx.oc as any, k = ctx.k;
  const d = ctx.tmp(new oc.BRepExtrema_DistShapeShape());
  d.LoadS1(shape); d.LoadS2(bound); d.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  if (!d.IsDone() || d.Value() > 1e-5) return [];
  const out: Vec3[] = [];
  for (let i = 1; i <= d.NbSolution(); i++) { const p = d.PointOnShape1(i); out.push(k.xyz(p)); p.delete(); }
  return out;
}

export default defineFeature<TrimCurveParams>({
  type: "trim-curve",
  title: "Trim curve",
  hint: "Shorten or lengthen a curve at one end, by a distance or up to a point, plane or face.",
  keywords: "trim extend shorten lengthen curve end cut bound",
  icon: '<path d="M3 18c4-1 7-5 9-10"/><path class="d t" d="M12 8c1-2 2-3.5 3.5-5"/><path d="M8 5l8 6"/><circle class="s" cx="12" cy="8" r="1.8"/>',
  toolbarOrder: 64.6, toolbarSection: "reference", toolbarMenu: "Curve", toolbarKeep: 55,
  defaults: () => ({ curve: null, end: "end", by: "distance", distance: -5, bound: null }),
  schema: [
    { key: "curve", label: "Curve", kind: "refs", of: ["edge"], single: true, datums: ["curve"], sketch: true },
    { key: "end", label: "End", kind: "enum", options: [{ value: "end", label: "End" }, { value: "start", label: "Start" }] },
    { key: "by", label: "To", kind: "enum", options: [{ value: "distance", label: "Distance" }, { value: "entity", label: "Up to" }] },
    { key: "distance", label: "Distance", kind: "number", unit: "mm", step: 1, hint: "Negative trims, positive extends.", visible: (p) => p.by !== "entity" },
    { key: "bound", label: "Bounding entity", kind: "refs", of: ["vertex", "face"], single: true, planes: true, datums: ["plane", "point"], sketch: true, hint: "A point, plane or face the curve is cut back to or extended up to.", visible: (p) => p.by === "entity" },
  ],

  evaluate(ctx: EvalContext, p: TrimCurveParams) {
    const oc = ctx.oc as any, k = ctx.k;
    if (!p.curve) throw ctx.fail("Pick the curve to trim or extend.");
    const shape = curveOf(ctx, p.curve, "curve");
    const edges = k.sub(shape, "edge");
    if (edges.length !== 1) throw ctx.fail("Trim curve works on a curve of one edge. Pick one edge of the chain.");
    const edge = edges[0], atEnd = p.end !== "start";
    const e = edgeCurve(ctx, edge);
    const tip = curveEnd(ctx, edge, atEnd);
    /** the curve with `d` taken off (d < 0) or added on (d > 0) at the chosen end */
    const changed = (d: number): Shape[] => {
      if (d > 0) {
        const far = add(tip.at, scale(tip.out, d));
        return atEnd ? [edge, segment(ctx, tip.at, far)] : [segment(ctx, far, tip.at), edge];
      }
      const keep = e.total + d;
      if (keep <= 1e-6) throw ctx.fail("That trims away the whole curve.");
      const ua = atEnd ? e.u0 : e.at(-d), ub = atEnd ? e.at(keep) : e.u1;
      return [ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(e.curve, ua, ub)).Edge())];
    };
    if (p.by !== "entity") {
      const d = Number(p.distance) || 0;
      if (Math.abs(d) < 1e-9) ctx.warn("A distance of zero leaves the curve as it is.");
      setCurve(ctx, Math.abs(d) < 1e-9 ? [edge] : changed(d));
      return;
    }
    if (!p.bound) throw ctx.fail("Pick the point, plane or face to trim to.");
    const b = p.bound;
    let bound: Shape;
    if (b.kind === "vertex" || (b.kind === "datum" && ctx.datum(b.feature).kind === "point") || b.kind === "sketch") bound = ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(ctx.tmp(k.pnt(pointOf(ctx, b, "bounding point"))))).Vertex();
    else if (isGeomRef(b) && b.kind === "face") bound = ctx.resolve(b).shape;
    else { const f = planeOf(ctx, b, "bounding plane"); bound = planeFace(k, f.origin, f.normal, modelSize(ctx) * 4, ctx.own); }
    // on the curve itself: cut back to the meeting nearest the chosen end
    const on = meets(ctx, edge, bound).map((q) => lengthTo(ctx, edge, q)).filter((s) => s > 1e-6 && s < e.total - 1e-6);
    if (on.length) {
      const s = atEnd ? Math.max(...on) : Math.min(...on);
      setCurve(ctx, changed(atEnd ? -(e.total - s) : -s));
      return;
    }
    // else carried on straight from the end
    const reach = modelSize(ctx) * 10 + e.total;
    const ray = segment(ctx, tip.at, add(tip.at, scale(tip.out, reach)));
    const ahead = meets(ctx, ray, bound).map((q) => length(sub(q, tip.at))).filter((s) => s > 1e-6);
    if (!ahead.length) throw ctx.fail("The curve does not reach the bounding entity, even carried on straight.");
    setCurve(ctx, changed(Math.min(...ahead)));
  },
});

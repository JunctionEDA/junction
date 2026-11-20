// sketch-curves.ts — a sketch's free-form curves (ellipses, splines, Bézier curves, conics, text: sketch/curves.ts)
// as kernel edges.  The NURBS is the one the page drew, so a stretch of its parameter (a region's `span`) is the
// same stretch here.  Used by the Sketch feature for its regions and by sweep paths for an open curve.
import type { TopoDS_Edge } from "replicad-opencascadejs";
import { toWorld, type Frame } from "../../core/geometry";
import { freeformPieces, knotsAndMults, type Piece } from "../../sketch/curves";
import type { SketchData } from "../../sketch/format";
import type { EvalContext } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A piece's NURBS as a Geom_BSplineCurve in the sketch's plane (freed with the context). */
export function nurbsCurve(ctx: EvalContext, frame: Frame, pc: Piece): any {
  const oc = ctx.oc as any, k = ctx.k, n = pc.nurbs, { knots, mults } = knotsAndMults(n);
  const poles = ctx.tmp(new oc.NCollection_Array1_gp_Pnt(1, n.poles.length));
  n.poles.forEach((p, i) => poles.SetValue(i + 1, ctx.tmp(k.pnt(toWorld(frame, p)))));
  const kv = ctx.tmp(new oc.NCollection_Array1_double(1, knots.length)), mv = ctx.tmp(new oc.NCollection_Array1_int(1, mults.length));
  knots.forEach((x, i) => kv.SetValue(i + 1, x)); mults.forEach((x, i) => mv.SetValue(i + 1, x));
  if (!n.weights) return ctx.tmp(new oc.Geom_BSplineCurve(poles, kv, mv, n.degree, false));
  const wv = ctx.tmp(new oc.NCollection_Array1_double(1, n.weights.length));
  n.weights.forEach((x, i) => wv.SetValue(i + 1, x));
  return ctx.tmp(new oc.Geom_BSplineCurve(poles, wv, kv, mv, n.degree, false, false));
}

/**
 * The edges of one piece of a free-form entity, from t0 to t1 of its parameter (the whole piece when no span is
 * given; a span of a closed piece may run across its seam), in order, reversed when asked.
 */
export function freeformEdges(ctx: EvalContext, frame: Frame, data: SketchData, entity: string, opts: { part?: number; span?: [number, number]; reversed?: boolean } = {}): TopoDS_Edge[] {
  const oc = ctx.oc as any;
  const pieces = freeformPieces(data, entity), pc = pieces && pieces[opts.part || 0];
  if (!pc) throw ctx.fail("The sketch has a curve that could not be built.");
  const curve = nurbsCurve(ctx, frame, pc), span = opts.span, period = pc.t1 - pc.t0;
  const stretches: [number, number][] = [];
  if (!span) stretches.push([pc.t0, pc.t1]);
  else if (pc.closed && span[1] > pc.t1 + 1e-12) stretches.push([span[0], pc.t1], [pc.t0, span[1] - period]);   // across the seam
  else if (pc.closed && span[0] < pc.t0 - 1e-12) stretches.push([span[0] + period, pc.t1], [pc.t0, span[1]]);
  else stretches.push([span[0], span[1]]);
  // one edge per knot span: OpenCascade integrates (volume, mass) poorly across a NURBS's inner knots, and a
  // closed curve wants two edges or more anyway
  const knots = Array.from(new Set(pc.nurbs.knots));
  const bits: [number, number][] = [];
  for (const [a, b] of stretches) {
    let x = a;
    for (const t of knots) if (t > a + 1e-9 && t < b - 1e-9) { bits.push([x, t]); x = t; }
    bits.push([x, b]);
  }
  const out = bits.filter(([a, b]) => b - a > 1e-12).map(([a, b]) => {
    let edge: any = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(curve, a, b)).Edge();
    if (opts.reversed) { const flipped = oc.TopoDS.Edge(ctx.tmp(edge.Reversed())); ctx.tmp(edge); edge = flipped; }
    return ctx.own(edge) as TopoDS_Edge;
  });
  return opts.reversed ? out.reverse() : out;
}

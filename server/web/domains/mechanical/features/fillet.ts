// fillet.ts — the Fillet feature: round edges with a constant radius.  Pick edges, or faces to round every
// edge around them.  A chain of edges that meet smoothly (tangent) is rounded as one: picking one edge of a
// rounded outline rounds the whole outline.  The size is a radius, or (Onshape's "Width" measurement) the width
// of the rounding across the edge, from one face to the other: each edge then gets the radius that gives that
// width at its middle, from the angle between its two faces.
//
// Names: the faces the body had keep their names; each rounding face is `<id>:from(<the edge's name>)`, and a
// blend at a corner where several fillets meet is `<id>:from(<the vertex's name>)`.
import { defineFeature } from "../core/feature";
import { dot, type GeomRef } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { edgesByBody } from "../kernel/ops/edges";
import { normalAt } from "../kernel/ops/cells";
import { facesOfEdge } from "../kernel/ops/shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FilletParams { [key: string]: any; edges: GeomRef[]; measure?: "radius" | "width"; radius: number; width?: number }

export default defineFeature<FilletParams>({
  type: "fillet",
  title: "Fillet",
  icon: '<path class="f" d="M4 20v-8a8 8 0 0 1 8-8h8v16z"/><path d="M4 20v-8a8 8 0 0 1 8-8h8M4 20h16V4"/><path class="d t" d="M4 11V4h7"/>',
  toolbarOrder: 30, toolbarSection: "modify", toolbarMenu: "Fillet", toolbarKeep: 94,
  defaults: () => ({ edges: [], measure: "radius", radius: 1, width: 1.5 }),
  schema: [
    { key: "edges", label: "Edges or faces", kind: "refs", of: ["edge", "face"], hint: "A face rounds every edge around it." },
    { key: "measure", label: "Measurement", kind: "enum", options: [{ value: "radius", label: "Radius" }, { value: "width", label: "Width" }] },
    { key: "radius", label: "Radius", kind: "number", unit: "mm", min: 0.001, step: 0.5, visible: (p) => p.measure !== "width" },
    { key: "width", label: "Width", kind: "number", unit: "mm", min: 0.001, step: 0.5, hint: "Across the rounding, from where it leaves one face to where it meets the other.", visible: (p) => p.measure === "width" },
  ],

  evaluate(ctx: EvalContext, p: FilletParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    if (!p.edges || !p.edges.length) throw ctx.fail("Pick the edges to round.");
    const byWidth = p.measure === "width";
    if (byWidth ? !(Number(p.width) > 0) : !(p.radius > 0)) throw ctx.fail(`The ${byWidth ? "width" : "radius"} must be more than zero.`);
    for (const [body, edges] of edgesByBody(ctx, p.edges)) {
      const mk = ctx.own(new oc.BRepFilletAPI_MakeFillet(body.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational));
      for (const e of edges) mk.Add(byWidth ? radiusForWidth(ctx, body.topo.faces, e.shape, Number(p.width)) : p.radius, oc.TopoDS.Edge(e.shape));
      try { mk.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (x) { throw ctx.fail(`The fillet could not be built (${k.describe(x)}). Try a smaller radius.`); }
      if (!mk.IsDone()) throw ctx.fail(`The fillet on ${body.name} could not be built. Try a smaller radius, or fewer edges at once.`);
      const shape: Shape = ctx.own(mk.Shape());
      const solids = k.solids(shape);
      if (solids.length !== 1) throw ctx.fail("The fillet left a broken solid. Try a smaller radius.");
      const names = k.carryNames(shape, mk, body.topo.faces, id, [...edges, ...body.topo.vertices]);
      ctx.replaceBody(body, solids[0], names);
    }
  },
});

/** The radius that rounds an edge `width` across: the arc turns through the angle between the faces' normals. */
function radiusForWidth(ctx: EvalContext, faces: Parameters<typeof facesOfEdge>[1], edge: Shape, width: number): number {
  const oc = ctx.oc as any, k = ctx.k;
  const around = facesOfEdge(k, faces, edge);
  if (around.length < 2) throw ctx.fail("An edge to round does not lie between two faces.");
  const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)));
  const mid = ctx.tmp(ad.Value((ad.FirstParameter() + ad.LastParameter()) / 2));
  const n = around.slice(0, 2).map((f) => {
    const surface = oc.BRep_Tool.Surface(oc.TopoDS.Face(f.shape));
    const pr = ctx.tmp(new oc.GeomAPI_ProjectPointOnSurf(mid, surface, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad));
    if (!pr.NbPoints()) throw ctx.fail("The width of a rounding could not be measured on an edge.");
    const uv = pr.LowerDistanceParameters(0, 0);
    return normalAt(ctx, f.shape, [uv.U, uv.V]);
  });
  const turn = Math.acos(Math.max(-1, Math.min(1, dot(n[0], n[1]))));
  if (turn < 1e-3) throw ctx.fail("An edge to round is between faces that meet smoothly: it has no width to measure.");
  return width / (2 * Math.sin(turn / 2));
}

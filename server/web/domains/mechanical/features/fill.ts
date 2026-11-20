// fill.ts — the Fill feature: a surface that closes a loop of edges, however many there are.  The edges may be
// edges of parts and surfaces, sketch curves or reference curves; together they must make closed loops.
//
// A flat loop is filled with a plane.  Anything else gets a smooth patch through the edges; with Tangency or
// Curvature the patch also leaves each edge in the direction of the face beside it (an edge that has no face
// beside it, a sketch curve, is only passed through).  Guide vertices and points pull the patch through them.
// Merge sews the patch to the surfaces whose edges it was made from.
//
// Faces: `<id>:fill` (`~2`, … for several loops).
import { defineFeature } from "../core/feature";
import type { EvalContext, NamedShape, Shape } from "../kernel/types";
import { pointOf } from "../kernel/ops/ref-geom";
import { chains, pickedEdges, sewNamed, sketchEntityPoints, wireOf, type PickedEdge } from "../kernel/ops/surface";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FillParams {
  [key: string]: any;
  edges: RefTarget[];
  continuity: "position" | "tangent" | "curvature";
  guides: RefTarget[];
  /** sew the patch to the surfaces its edges are on */
  merge: boolean;
}

export default defineFeature<FillParams>({
  type: "fill",
  title: "Fill",
  icon: '<path class="f" d="M4.500 8.500c3-4.500 9-5.500 14.500-2.500 1.500 4.500.5 9-3.500 12.500-5 1-9.500-.5-12-4.500z"/><path d="M4.500 8.500c3-4.500 9-5.500 14.500-2.500 1.500 4.500.5 9-3.500 12.500-5 1-9.500-.5-12-4.500z"/><path class="t" d="M8 6.500c2 4 1.500 8.500-.5 11M13.500 5c2 4.500 1.500 9.500-1.500 13.500M4 11.500c5-1.500 10.500-1 15.500.5"/>',
  toolbarOrder: 30, toolbarSection: "surface", toolbarKeep: 36,
  hint: "Close a loop of edges or curves with a surface: flat when the loop is, a smooth patch otherwise.",
  keywords: "surface patch cap close hole planar boundary n-sided",
  defaults: () => ({ edges: [], continuity: "position", guides: [], merge: false }),
  schema: [
    { key: "edges", label: "Edges", kind: "refs", of: ["edge"], sketch: true, datums: ["curve"], hint: "Edges and curves that make a closed loop. A sketch curve brings the curves joined to it." },
    { key: "continuity", label: "Continuity", kind: "enum", options: [{ value: "position", label: "Position" }, { value: "tangent", label: "Tangency" }, { value: "curvature", label: "Curvature" }], hint: "How the patch leaves the faces beside its edges." },
    { key: "guides", label: "Guides", kind: "refs", of: ["vertex"], datums: ["point"], sketch: true, hint: "Optional: vertices and points the patch must pass through." },
    { key: "merge", label: "Merge with the surfaces", kind: "boolean", hint: "Sew the patch to the surfaces whose edges it closes." },
  ],

  evaluate(ctx: EvalContext, p: FillParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const picked = pickedEdges(ctx, Array.isArray(p.edges) ? p.edges : [], true);
    if (!picked.length) throw ctx.fail("Pick the edges or curves around the opening to fill.");
    const byEdge = new Map<Shape, PickedEdge>(picked.map((e) => [e.edge, e]));
    const loops = chains(ctx, picked.map((e) => e.edge));
    if (loops.some((l) => !l.closed)) throw ctx.fail("The edges do not make a closed loop. Pick every edge around the opening.");
    const guides: [number, number, number][] = [];
    for (const g of Array.isArray(p.guides) ? p.guides : []) {
      if (g && g.kind === "sketch") guides.push(...sketchEntityPoints(ctx, g.feature, g.entity));
      else guides.push(pointOf(ctx, g, "guide"));
    }
    const order = p.continuity === "curvature" ? oc.GeomAbs_Shape.GeomAbs_G2 : p.continuity === "tangent" ? oc.GeomAbs_Shape.GeomAbs_G1 : oc.GeomAbs_Shape.GeomAbs_C0;
    const smooth = p.continuity === "tangent" || p.continuity === "curvature";

    const patches: NamedShape[] = [];
    loops.forEach((loop) => {
      let face: Shape | null = null;
      // a flat loop with nothing to bend it: a plane
      if (!guides.length && (!smooth || loop.edges.every((e) => !byEdge.get(e)!.faces.length))) {
        try {
          const mf = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Wire(wireOf(ctx, loop.edges)), true));
          if (mf.IsDone()) face = ctx.own(mf.Face());
        } catch (e) { face = null; }
      }
      if (!face) {
        const mk = ctx.own(new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9));
        for (const e of loop.edges) {
          const support = smooth ? byEdge.get(e)!.faces[0] : undefined;
          if (support) mk.Add(oc.TopoDS.Edge(e), oc.TopoDS.Face(support.shape), order, true);
          else mk.Add(oc.TopoDS.Edge(e), oc.GeomAbs_Shape.GeomAbs_C0, true);
        }
        for (const g of guides) mk.Add(ctx.tmp(k.pnt(g)));
        try { mk.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (e) { throw ctx.fail("The opening could not be filled. Try Position, or fewer guides."); }
        if (!mk.IsDone()) throw ctx.fail("The opening could not be filled. Try Position, or fewer guides.");
        face = ctx.own(mk.Shape());
      }
      for (const f of k.sub(face!, "face")) patches.push({ name: `${id}:fill`, shape: f });
    });

    // merged: the patch and the surfaces around it become one surface, which keeps the first surface's place
    const around = Array.from(new Set(picked.map((e) => e.body).filter((b) => !!b && !!b.sheet))) as NonNullable<PickedEdge["body"]>[];
    if (p.merge && around.length) {
      const all: NamedShape[] = [...around.flatMap((b) => b.topo.faces), ...patches];
      const sheets = sewNamed(ctx, all);
      ctx.replaceBody(around[0], sheets[0].shape, sheets[0].names);
      around.slice(1).forEach((b) => ctx.removeBody(b));
      sheets.slice(1).forEach((s, i) => ctx.addBody(s.shape, s.names, { suffix: `s${i + 2}` }));
      return;
    }
    if (p.merge) ctx.warn("There is no surface to merge with: the edges are not edges of a surface.");
    const sheets = sewNamed(ctx, patches);
    sheets.forEach((s, i) => ctx.addBody(s.shape, s.names, { suffix: sheets.length > 1 ? `s${i + 1}` : undefined }));
  },
});

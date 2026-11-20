// face-blend.ts — the Face blend feature: round where one set of faces meets another.  Pick the faces of each
// side; every edge between a face of the first side and a face of the second is rounded with one radius, and
// the rounding runs on along edges that continue smoothly.
//
// It blends faces that meet along an edge.  Faces that do not touch cannot be blended by this kernel.
//
// Names: each blend face is `<id>:from(<the edge's name>)`.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { Body, EvalContext, NamedShape, Shape } from "../kernel/types";
import { ShapeIndex } from "../kernel/occ";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FaceBlendParams { [key: string]: any; side1: GeomRef[]; side2: GeomRef[]; radius: number }

export default defineFeature<FaceBlendParams>({
  type: "face-blend",
  title: "Face blend",
  hint: "Round where one set of faces meets another.",
  keywords: "round blend radius faces between sides fillet",
  icon: '<path class="f" d="M3.5 20.5v-8.5a8 8 0 0 1 8-8h9v16.5z"/><path d="M3.5 20.5v-8.5a8 8 0 0 1 8-8h9"/><path class="s" d="M2.5 16.5h2v4h-2zM16 3h4.5v2h-4.5z"/>',
  toolbarOrder: 30.2, toolbarSection: "modify", toolbarMenu: "Fillet", toolbarKeep: 94,
  defaults: () => ({ side1: [], side2: [], radius: 2 }),
  schema: [
    { key: "side1", label: "Side 1", kind: "refs", of: ["face"] },
    { key: "side2", label: "Side 2", kind: "refs", of: ["face"], hint: "The faces that meet side 1 along an edge." },
    { key: "radius", label: "Radius", kind: "number", unit: "mm", min: 0.001, step: 0.5 },
  ],

  evaluate(ctx: EvalContext, p: FaceBlendParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    if (!p.side1 || !p.side1.length) throw ctx.fail("Pick the faces of the first side.");
    if (!p.side2 || !p.side2.length) throw ctx.fail("Pick the faces of the second side.");
    if (!(p.radius > 0)) throw ctx.fail("The radius must be more than zero.");
    const sides = new Map<Body, [Shape[], Shape[]]>();
    [p.side1, p.side2].forEach((refs, n) => {
      for (const ref of refs) {
        const r = ctx.resolve(ref);
        if (r.kind !== "face") throw ctx.fail("Pick faces to blend.");
        const rec = sides.get(r.body) || [[], []];
        rec[n].push(r.shape); sides.set(r.body, rec);
      }
    });
    let blended = 0;
    for (const [body, [a, b]] of sides) {
      if (!a.length || !b.length) continue;
      const onA = new ShapeIndex<true>(k);
      for (const f of a) for (const e of k.sub(f, "edge")) onA.add(e, true);
      const between = new ShapeIndex<true>(k);
      for (const f of b) for (const e of k.sub(f, "edge")) if (onA.has(e)) between.add(e, true);
      const edges: NamedShape[] = body.topo.edges.filter((e) => between.has(e.shape));
      if (!edges.length) continue;
      const mk = ctx.own(new oc.BRepFilletAPI_MakeFillet(body.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational));
      for (const e of edges) mk.Add(p.radius, oc.TopoDS.Edge(e.shape));
      try { mk.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (x) { throw ctx.fail(`The blend could not be built (${k.describe(x)}). Try a smaller radius.`); }
      if (!mk.IsDone()) throw ctx.fail("The blend could not be built. Try a smaller radius.");
      const shape: Shape = ctx.own(mk.Shape());
      const solids = k.solids(shape);
      if (solids.length !== 1) throw ctx.fail("The blend left a broken solid. Try a smaller radius.");
      ctx.replaceBody(body, solids[0], k.carryNames(shape, mk, body.topo.faces, id, [...edges, ...body.topo.vertices]));
      blended++;
    }
    if (!blended) throw ctx.fail("The two sides do not meet along an edge. Pick faces that touch (blending faces that do not touch is not supported).");
  },
});

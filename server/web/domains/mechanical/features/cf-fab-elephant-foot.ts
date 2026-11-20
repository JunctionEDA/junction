// cf-fab-elephant-foot.ts — Elephant-foot chamfer: a small chamfer all round the face that lies on the print
// bed, to take up the first layers' squash so the part's foot does not flare.
//
// Pick the face (or faces) on the bed.  Every edge of its outline is chamfered: `inset` in from the edge on the
// bed face, `height` up the walls (a different inset and height make the usual shallow chamfer over one or two
// layers).  With "Holes too" the edges of the openings in the face are chamfered as well, which widens them at
// the bed and keeps holes to size.
// Names: a chamfer face is `<id>:from(<the edge it replaced>)`; every other face keeps its name.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import { ShapeIndex } from "../kernel/occ";
import type { Body, EvalContext, NamedShape, Shape } from "../kernel/types";
import { positive } from "../kernel/ops/cf-fab";
import { PRINT } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ElephantFootParams { [key: string]: any; faces: GeomRef[]; inset: number; height: number; holes: boolean }

export default defineFeature<ElephantFootParams>({
  type: "cf-fab-elephant-foot",
  title: "Elephant-foot chamfer",
  icon: '<path class="f" d="M6 3h12v13.5L16.5 19h-9L6 16.5z"/><path d="M6 3h12v13.5L16.5 19h-9L6 16.5z"/><path class="s" d="M2 20.2h20v1.3H2z"/>',
  hint: "Chamfer the outline of the face on the print bed to compensate first-layer squash",
  keywords: "elephant foot chamfer first layer compensation bed squash 3d print bottom edge flare",
  ...PRINT, toolbarOrder: 42,
  defaults: () => ({ faces: [], inset: 0.3, height: 0.4, holes: true }),
  schema: [
    { key: "faces", label: "Bed faces", kind: "refs", of: ["face"], hint: "The flat faces that lie on the print bed." },
    { key: "inset", label: "Inset", kind: "number", unit: "mm", min: 0.01, step: 0.05, hint: "How far the outline is pulled in on the bed." },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 0.01, step: 0.05, hint: "How far up the walls the chamfer reaches: one or two layers." },
    { key: "holes", label: "Holes too", kind: "boolean", hint: "Chamfer the edges of openings in the face as well." },
  ],

  evaluate(ctx: EvalContext, p: ElephantFootParams) {
    const k = ctx.k, oc = ctx.oc as any, id = ctx.feature.id;
    const inset = positive(ctx, p.inset, "inset"), height = positive(ctx, p.height, "height");
    const refs = Array.isArray(p.faces) ? p.faces : [];
    if (!refs.length) throw ctx.fail("Pick the face that lies on the print bed.");
    const byBody = new Map<string, { body: Body; faces: Shape[] }>();
    for (const ref of refs) {
      const r = ctx.resolve(ref);
      if (r.kind !== "face" || !k.faceFrame(oc.TopoDS.Face(r.shape))) throw ctx.fail("Pick a flat face: the one that lies on the print bed.");
      const job = byBody.get(r.body.id) || { body: r.body, faces: [] };
      job.faces.push(r.shape);
      byBody.set(r.body.id, job);
    }
    for (const { body, faces } of byBody.values()) {
      const named = new ShapeIndex<NamedShape>(k);
      for (const e of body.topo.edges) named.add(e.shape, e);
      const mk = ctx.own(new oc.BRepFilletAPI_MakeChamfer(body.shape));
      const generators: NamedShape[] = [];
      const seen = new ShapeIndex<true>(k);
      for (const f of faces) {
        const face = oc.TopoDS.Face(f);
        const edges = p.holes === false ? k.sub(ctx.own(oc.BRepTools.OuterWire(face)), "edge") : k.sub(face, "edge");
        for (const e of edges) {
          if (seen.has(e)) continue;
          seen.add(e, true);
          mk.Add(inset, height, oc.TopoDS.Edge(e), face);
          const n = named.get(e);
          if (n) generators.push(n);
        }
      }
      try { mk.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (x) { throw ctx.fail(`The chamfer could not be built on ${body.name} (${k.describe(x)}). Try a smaller inset or height.`); }
      if (!mk.IsDone()) throw ctx.fail(`The chamfer could not be built on ${body.name}. Try a smaller inset or height.`);
      const shape: Shape = ctx.own(mk.Shape());
      if (k.solids(shape).length !== 1) throw ctx.fail(`The chamfer could not be built on ${body.name}. Try a smaller inset or height.`);
      ctx.replaceBody(body, shape, k.carryNames(shape, mk, body.topo.faces, id, generators));
    }
  },
});

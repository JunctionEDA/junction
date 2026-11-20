// modify-fillet.ts — the Modify fillet feature: change the radius of a rounding, or take it away, on any part,
// whatever made it (an imported one too).  Pick the rounding's faces.  The rounding is first removed by
// carrying the faces either side of it on until they meet in a sharp edge (kernel/ops/cells.ts); for a new
// radius that edge is then rounded again.
//
// Names: removed, the neighbours keep their names; rounded again, the new face is `<id>:from(<the edge's name>)`.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext, NamedShape, Shape } from "../kernel/types";
import { healFaces } from "../kernel/ops/cells";
import { distance } from "../kernel/ops/shapes";
import { facesByBody } from "./delete-face";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ModifyFilletParams { [key: string]: any; faces: GeomRef[]; mode: "radius" | "remove"; radius: number }

export default defineFeature<ModifyFilletParams>({
  type: "modify-fillet",
  title: "Modify fillet",
  hint: "Change the radius of a rounding, or remove it, whatever made it.",
  keywords: "round radius change remove fillet edit direct imported",
  icon: '<path class="f" d="M3.5 20.5v-5a11.5 11.5 0 0 1 11.5-11.5h5.5v16.5z"/><path d="M3.5 20.5v-5a11.5 11.5 0 0 1 11.5-11.5h5.5"/><path class="d t" d="M3.5 12v-3a5 5 0 0 1 5-5h4"/><path class="t" d="M9 15l-4-4M5 14v-3h3"/>',
  toolbarOrder: 50, toolbarSection: "direct", toolbarKeep: 34,
  defaults: () => ({ faces: [], mode: "radius", radius: 2 }),
  schema: [
    { key: "faces", label: "Rounded faces", kind: "refs", of: ["face"], hint: "The faces of the rounding to change." },
    { key: "mode", label: "Do", kind: "enum", options: [{ value: "radius", label: "Change radius" }, { value: "remove", label: "Remove" }] },
    { key: "radius", label: "New radius", kind: "number", unit: "mm", min: 0.001, step: 0.5, visible: (p) => p.mode !== "remove" },
  ],

  evaluate(ctx: EvalContext, p: ModifyFilletParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    if (p.mode !== "remove" && !(p.radius > 0)) throw ctx.fail("The radius must be more than zero.");
    for (const [body, faces] of facesByBody(ctx, p.faces, "of the rounding")) {
      const healed = healFaces(ctx, { shape: body.shape, faces: body.topo.faces }, faces.map((f) => f.shape));
      if (p.mode === "remove") { ctx.replaceBody(body, healed.shape, healed.names); continue; }
      // the sharp edges the healing made: edges of the healed part that are not on the part as it was
      const shell = k.sub(body.shape, "shell")[0] || body.shape;
      const named = k.namedFaces(healed.shape, healed.names, id);
      const sharp: Shape[] = k.sub(healed.shape, "edge").filter((e) => {
        const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e)));
        const q = ad.Value((ad.FirstParameter() + ad.LastParameter()) / 2);
        const v = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(q)).Vertex()); q.delete();
        return distance(k, v, shell) > 1e-5;
      });
      if (!sharp.length) throw ctx.fail("Removing those faces leaves no edge to round again. Pick the faces of a rounding.");
      const mk = ctx.own(new oc.BRepFilletAPI_MakeFillet(healed.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational));
      for (const e of sharp) mk.Add(p.radius, oc.TopoDS.Edge(e));
      try { mk.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (x) { throw ctx.fail(`The new rounding could not be built (${k.describe(x)}). Try a smaller radius.`); }
      if (!mk.IsDone()) throw ctx.fail("The new rounding could not be built. Try a smaller radius.");
      const shape: Shape = ctx.own(mk.Shape());
      const solids = k.solids(shape);
      if (solids.length !== 1) throw ctx.fail("The new rounding left a broken solid. Try a smaller radius.");
      // name each new face after the face it replaces when one rounding was picked, so references to it hold
      const generators: NamedShape[] = sharp.map((e, i) => ({ name: faces[Math.min(i, faces.length - 1)].name, shape: e }));
      const carried = k.carryNames(shape, mk, named, id, generators);
      const names = (f: any, i: number) => { const n = carried(f, i); const m = n && n.match(/^[^:]+:from\((.*)\)$/); return m && faces.some((x) => x.name === m[1]) ? m[1] : n; };
      ctx.replaceBody(body, solids[0], names);
    }
  },
});

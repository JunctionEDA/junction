// sweep.ts — the Sweep feature: the closed regions of a sketch carried along a path (sketch curves, edges or a
// reference curve such as a helix), as a new body, added, or removed.  Picking one curve of a sketch path picks
// the curves joined to it.  Faces: `<id>:start:<region>`, `<id>:end:<region>`, and `<id>:side:<entity>` for
// the faces swept by each profile curve (`~2`, `~3` along a path of several pieces).
import { defineFeature } from "../core/feature";
import { ShapeIndex, type NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { pathWire } from "../kernel/ops/sweep-path";
import { applyOperation, operationFields, type Operation } from "../kernel/ops/sweep-apply";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SweepParams {
  [key: string]: any;
  profile: { sketch: string; regions: string[] | null } | null;
  path: RefTarget[];
  operation: Operation;
  targets: string[];
}

export default defineFeature<SweepParams>({
  type: "sweep",
  title: "Sweep",
  icon: '<circle cx="5" cy="17" r="2.5"/><path d="M7.5 17C13 17 11 6 19 6"/><path d="M19 3.5v5"/>',
  toolbarOrder: 30,
  defaults: () => ({ profile: null, path: [], operation: "new", targets: [] }),
  schema: [
    { key: "profile", label: "Profile", kind: "profile" },
    { key: "path", label: "Path", kind: "refs", of: ["edge"], datums: ["curve"], sketch: true, hint: "A sketch curve (the curves joined to it come too), edges, or a curve." },
    ...operationFields,
  ],

  evaluate(ctx: EvalContext, p: SweepParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    if (!p.profile || !p.profile.sketch) throw ctx.fail("Pick the sketch to sweep.");
    const path = Array.isArray(p.path) ? p.path : [];
    if (path.some((t) => t.kind === "sketch" && t.feature === p.profile!.sketch)) throw ctx.fail("The path must be in a different sketch from the profile.");
    const sketch = ctx.sketch(p.profile.sketch);
    const wanted = p.profile.regions;
    const regions = sketch.regions.filter((r) => !wanted || wanted.includes(r.id));
    if (!regions.length) throw ctx.fail("The profile sketch has no closed region to sweep.");
    const spine = pathWire(ctx, path);
    const tools: NamedResult[] = regions.map((r) => {
      const mk = ctx.tmp(new oc.BRepOffsetAPI_MakePipe(oc.TopoDS.Wire(spine), r.face));
      mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
      if (!mk.IsDone()) throw ctx.fail("The profile could not be swept along the path. Check that the path is smooth enough for the profile's size.");
      const shape = ctx.own(mk.Shape());
      if (k.volume(shape) <= 1e-9) throw ctx.fail("The sweep has no volume. Put the profile across the start of the path.");
      const named = new ShapeIndex<string>(k);
      named.add(ctx.own(mk.FirstShape()), `${id}:start:${r.id}`);
      named.add(ctx.own(mk.LastShape()), `${id}:end:${r.id}`);
      for (const e of r.edges) for (const side of k.list(mk.Generated(e.edge))) if (!named.has(side)) named.add(side, `${id}:side:${e.entity}`);
      return { shape, names: (f) => named.get(f) ?? null };
    });
    applyOperation(ctx, tools, p.operation, p.targets, regions.map((r) => (regions.length > 1 ? r.id : undefined)));
  },
});

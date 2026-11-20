// sweep.ts — the Sweep feature: the closed regions of a sketch carried along a path (sketch curves, edges or a
// reference curve such as a helix), as a new body, added, or removed.  Picking one curve of a sketch path picks
// the curves joined to it.  A path with sharp corners is swept with rounded or mitred corners.  Faces:
// `<id>:start:<region>`, `<id>:end:<region>`, and `<id>:side:<entity>` for the faces swept by each profile
// curve (`~2`, `~3` along a path of several pieces).  kernel/ops/sweep-pipe.ts does the sweeping.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { pathWire } from "../kernel/ops/sweep-path";
import { sweepRegion } from "../kernel/ops/sweep-pipe";
import { applyOperation, operationFields, type Operation } from "../kernel/ops/sweep-apply";
import { isSurface, sweepSurface, withSurfaceType } from "../kernel/ops/surface-sweeps";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SweepParams {
  [key: string]: any;
  /** "surface": a sheet from the sketch's curves instead of a solid from its regions (kernel/ops/surface-sweeps.ts) */
  bodyType?: "solid" | "surface";
  profile: { sketch: string; regions: string[] | null } | null;
  path: RefTarget[];
  corners: "round" | "sharp";
  operation: Operation;
  targets: string[];
}

export default defineFeature<SweepParams>({
  type: "sweep",
  title: "Sweep",
  icon: '<path class="f" d="M5 14.5c7 0 4.5-10.5 13-10.5h2v6h-2c-4.5 0-2 10.5-13 10.5z"/><path d="M5 14.5c7 0 4.5-10.5 13-10.5h2v6h-2c-4.5 0-2 10.5-13 10.5"/><ellipse cx="5" cy="17.5" rx="2" ry="3"/>',
  toolbarOrder: 24, toolbarSection: "solid", toolbarKeep: 80,
  defaults: () => ({ bodyType: "solid", profile: null, path: [], corners: "round", operation: "new", targets: [] }),
  schema: withSurfaceType([
    { key: "profile", label: "Profile", kind: "profile" },
    { key: "path", label: "Path", kind: "refs", of: ["edge"], datums: ["curve"], sketch: true, hint: "A sketch curve (the curves joined to it come too), edges, or a curve." },
    { key: "corners", label: "Corners", kind: "enum", options: [{ value: "round", label: "Round" }, { value: "sharp", label: "Sharp" }], hint: "How the profile turns where the path has a sharp corner." },
    ...operationFields,
  ], ["operation", "targets"]),

  evaluate(ctx: EvalContext, p: SweepParams) {
    if (isSurface(p)) return sweepSurface(ctx, p);
    if (!p.profile || !p.profile.sketch) throw ctx.fail("Pick the sketch to sweep.");
    const path = Array.isArray(p.path) ? p.path : [];
    if (path.some((t) => t.kind === "sketch" && t.feature === p.profile!.sketch)) throw ctx.fail("The path must be in a different sketch from the profile.");
    const sketch = ctx.sketch(p.profile.sketch);
    const wanted = p.profile.regions;
    const regions = sketch.regions.filter((r) => !wanted || wanted.includes(r.id));
    if (!regions.length) throw ctx.fail("The profile sketch has no closed region to sweep.");
    const spine = pathWire(ctx, path);
    const tools = regions.map((r) => sweepRegion(ctx, spine, r, p.corners === "sharp" ? "sharp" : "round"));
    applyOperation(ctx, tools, p.operation, p.targets, regions.map((r) => (regions.length > 1 ? r.id : undefined)));
  },
});

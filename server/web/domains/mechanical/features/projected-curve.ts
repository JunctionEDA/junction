// projected-curve.ts — the Projected curve feature, both of Onshape's ways:
//   • "Sketch to face": sketch curves or edges projected onto faces, along the sketch's normal (or a direction
//     picked);
//   • "Curve to curve": the 3D curve two sketches on different planes both are seen as, looking along each
//     sketch's normal: where the two sketches' extrusions cross.
// Either way the curves are swept straight into sheets and the sheets cut with the faces (or with each other).
import { defineFeature } from "../core/feature";
import type { EvalContext, Shape } from "../kernel/types";
import { axisOf, curveOf, shapeSize } from "../kernel/ops/ref-geom";
import { modelSize } from "../kernel/ops/ref-datum";
import { compound } from "../kernel/ops/shapes";
import { sectionEdges, setCurve, sweptSheet } from "../kernel/ops/curves";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ProjectedCurveParams { [key: string]: any; method: "face" | "curves"; curves: RefTarget[]; faces: RefTarget[]; direction: RefTarget | null; curves2: RefTarget[] }

/** The picked curves with the direction each is swept along: a sketch curve's sketch normal, else `dir`. */
function sheets(ctx: EvalContext, picks: readonly RefTarget[], dir: [number, number, number] | null, reach: number, what: string): Shape[] {
  return picks.map((t) => {
    const d = dir || (t.kind === "sketch" ? ctx.sketch(t.feature).frame.normal : null);
    if (!d) throw ctx.fail(`Pick a direction to project the ${what} along (edges have no sketch plane to say it).`);
    return sweptSheet(ctx, curveOf(ctx, t, what), d, reach);
  });
}

export default defineFeature<ProjectedCurveParams>({
  type: "projected-curve",
  title: "Projected curve",
  hint: "Project sketch curves onto faces, or find the 3D curve two sketches on different planes both show.",
  keywords: "project sketch onto face wrap curve to curve 3d two views",
  icon: '<path class="f" d="M3 15l9-4 9 4-9 4z"/><path class="t" d="M3 15l9-4 9 4-9 4z"/><path class="d t" d="M7 4v10M17 4v10"/><path d="M5 4h14"/><path d="M7 15.3c3 1.8 7 1.8 10-1.4"/>',
  toolbarOrder: 64.2, toolbarSection: "reference", toolbarMenu: "Curve", toolbarKeep: 55,
  defaults: () => ({ method: "face", curves: [], faces: [], direction: null, curves2: [] }),
  schema: [
    { key: "method", label: "Method", kind: "enum", options: [{ value: "face", label: "Sketch to face" }, { value: "curves", label: "Curve to curve" }] },
    { key: "curves", label: "Curves", kind: "refs", of: ["edge"], datums: ["curve"], sketch: true, hint: "Sketch curves (or edges and curves, with a direction)." },
    { key: "faces", label: "Faces", kind: "refs", of: ["face"], hint: "The faces to project onto.", visible: (p) => p.method !== "curves" },
    { key: "direction", label: "Direction", kind: "refs", of: ["edge", "face"], single: true, planes: true, datums: ["axis", "plane"], sketch: true, hint: "Optional for sketch curves: their sketch's normal is used.", visible: (p) => p.method !== "curves" },
    { key: "curves2", label: "Second sketch's curves", kind: "refs", of: [], sketch: true, hint: "Curves of a sketch on another plane.", visible: (p) => p.method === "curves" },
  ],

  evaluate(ctx: EvalContext, p: ProjectedCurveParams) {
    const picks = Array.isArray(p.curves) ? p.curves : [];
    if (!picks.length) throw ctx.fail("Pick the curves to project.");
    let reach = modelSize(ctx) * 4;
    if (p.method === "curves") {
      const second = Array.isArray(p.curves2) ? p.curves2 : [];
      if (!second.length) throw ctx.fail("Pick the curves of the second sketch.");
      for (const t of [...picks, ...second]) if (t.kind !== "sketch") throw ctx.fail("Curve to curve takes sketch curves only: each is seen along its own sketch's normal.");
      const a = sheets(ctx, picks, null, reach, "curve"), b = sheets(ctx, second, null, reach, "curve");
      const n1 = ctx.sketch((picks[0] as any).feature).frame.normal, n2 = ctx.sketch((second[0] as any).feature).frame.normal;
      if (Math.abs(n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) > 1 - 1e-9) throw ctx.fail("The two sketches must be on planes that are not parallel.");
      const edges = sectionEdges(ctx, compound(ctx.k, a, ctx.own), compound(ctx.k, b, ctx.own));
      if (!edges.length) throw ctx.fail("The two sketches' curves do not meet when seen along their normals.");
      setCurve(ctx, edges);
      return;
    }
    const faces = (Array.isArray(p.faces) ? p.faces : []).map((t) => { if (t.kind !== "face") throw ctx.fail("Pick faces to project onto."); return ctx.resolve(t).shape; });
    if (!faces.length) throw ctx.fail("Pick the faces to project onto.");
    for (const f of faces) reach = Math.max(reach, shapeSize(ctx, f) * 4);
    const dir = p.direction ? axisOf(ctx, p.direction, "direction").dir : null;
    const edges = sectionEdges(ctx, compound(ctx.k, sheets(ctx, picks, dir, reach, "curve"), ctx.own), compound(ctx.k, faces, ctx.own));
    if (!edges.length) throw ctx.fail("The curves miss the faces when projected. Check the direction.");
    setCurve(ctx, edges);
  },
});

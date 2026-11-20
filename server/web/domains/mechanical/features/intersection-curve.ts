// intersection-curve.ts — the Intersection curve feature: the curve where two sets of faces (or parts, or
// planes) cross.  A plane is taken as unbounded; a part as all its faces.
import { defineFeature } from "../core/feature";
import { isGeomRef } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { planeOf } from "../kernel/ops/ref-geom";
import { modelSize } from "../kernel/ops/ref-datum";
import { compound, planeFace } from "../kernel/ops/shapes";
import { sectionEdges, setCurve } from "../kernel/ops/curves";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface IntersectionCurveParams { [key: string]: any; first: RefTarget[]; second: RefTarget[] }

const SIDE = { kind: "refs" as const, of: ["face" as const], planes: true, datums: ["plane" as const] };

function shapesOf(ctx: EvalContext, picks: readonly RefTarget[], what: string): Shape {
  if (!picks.length) throw ctx.fail(`Pick the ${what}.`);
  const size = modelSize(ctx) * 4;
  const out = picks.map((t) => {
    if (isGeomRef(t) && t.kind === "face") return ctx.resolve(t).shape;
    const f = planeOf(ctx, t, what);
    return planeFace(ctx.k, f.origin, f.normal, size, ctx.own);
  });
  return out.length === 1 ? out[0] : compound(ctx.k, out, ctx.own);
}

export default defineFeature<IntersectionCurveParams>({
  type: "intersection-curve",
  title: "Intersection curve",
  hint: "The curve where two sets of faces or planes cross.",
  keywords: "intersect section cross curve faces planes meet",
  icon: '<path class="f" d="M3 8l10-4 8 4-10 4z"/><path class="t" d="M3 8l10-4 8 4-10 4z"/><path class="t" d="M12 2v18"/><path d="M8 6l4 1.8 4-1.8"/><path class="t" d="M12 20l-2-8"/>',
  toolbarOrder: 64.5, toolbarSection: "reference", toolbarMenu: "Curve", toolbarKeep: 31,
  defaults: () => ({ first: [], second: [] }),
  schema: [
    { key: "first", label: "First faces", ...SIDE, hint: "Faces or planes." },
    { key: "second", label: "Second faces", ...SIDE, hint: "The faces or planes they cross." },
  ],

  evaluate(ctx: EvalContext, p: IntersectionCurveParams) {
    const a = shapesOf(ctx, Array.isArray(p.first) ? p.first : [], "first faces");
    const b = shapesOf(ctx, Array.isArray(p.second) ? p.second : [], "second faces");
    const edges = sectionEdges(ctx, a, b);
    if (!edges.length) throw ctx.fail("The two sets of faces do not cross.");
    setCurve(ctx, edges);
  },
});

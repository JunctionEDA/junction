// variable-fillet.ts — the Variable fillet feature: round edges with a radius that changes along them, from
// one radius at the start to another at the end, through any radii given in between.  A chain of edges that
// meet smoothly is rounded as one, and the radii are spread along the whole chain.
//
// The start of a chain is its end nearest the world origin's low corner (smallest x, then y, then z), so it does
// not swap when the kernel happens to turn an edge round on a rebuild; "Swap ends" swaps it.
//
// Names: as Fillet: each rounding face is `<id>:from(<the edge's name>)`.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { edgesByBody } from "../kernel/ops/edges";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface VariableFilletParams { [key: string]: any; edges: GeomRef[]; radius: number; radius2: number; between: string; swap: boolean }

/** "50%: 4, 0.75: 2" → [[0.5, 4], [0.75, 2]], or a sentence saying what is wrong. */
export function parseBetween(text: unknown): [number, number][] | string {
  const out: [number, number][] = [];
  for (const part of String(text || "").split(/[,;\n]+/)) {
    if (!part.trim()) continue;
    const m = part.trim().match(/^([0-9.]+)\s*(%?)\s*[:=@]\s*([0-9.]+)$/);
    if (!m) return `“${part.trim()}” is not a place and a radius. Write them as “50%: 4”.`;
    const at = Number(m[1]) / (m[2] ? 100 : 1), r = Number(m[3]);
    if (!(at > 0 && at < 1)) return "A place between the ends is more than 0% and less than 100%.";
    if (!(r >= 0)) return "A radius cannot be negative.";
    out.push([at, r]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export default defineFeature<VariableFilletParams>({
  type: "variable-fillet",
  title: "Variable fillet",
  hint: "Round edges with a radius that changes along them.",
  keywords: "round blend radius varying taper changing edge",
  icon: '<path class="f" d="M3.5 20.5v-5.5c0-6 3-11 11-11h6v16.5z"/><path d="M3.5 20.5v-5.5c0-6 3-11 11-11h6M3.5 20.5h17v-16.5"/><path class="t" d="M20.5 9.5c-6 0-11.5 2.5-11.5 11"/>',
  toolbarOrder: 30.1, toolbarSection: "modify", toolbarMenu: "Fillet", toolbarKeep: 94,
  defaults: () => ({ edges: [], radius: 1, radius2: 3, between: "", swap: false }),
  schema: [
    { key: "edges", label: "Edges", kind: "refs", of: ["edge"], hint: "Edges that meet smoothly are rounded as one chain." },
    { key: "radius", label: "Radius at the start", kind: "number", unit: "mm", min: 0, step: 0.5 },
    { key: "radius2", label: "Radius at the end", kind: "number", unit: "mm", min: 0, step: 0.5 },
    { key: "between", label: "Radii in between", kind: "text", hint: "Places along the edge and the radius there, as “50%: 4, 75%: 2”. Empty: a smooth change from start to end." },
    { key: "swap", label: "Swap ends", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: VariableFilletParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    if (!p.edges || !p.edges.length) throw ctx.fail("Pick the edges to round.");
    const r1 = Number(p.radius), r2 = Number(p.radius2);
    if (!(r1 >= 0) || !(r2 >= 0) || !(r1 + r2 > 0)) throw ctx.fail("The radii must be zero or more, and not both zero.");
    const mid = parseBetween(p.between);
    if (typeof mid === "string") throw ctx.fail(mid);
    // the kernel cannot end a rounding on nothing: a zero radius is made very small instead
    const tiny = Math.max(r1, r2, ...mid.map((m) => m[1])) * 1e-3;
    const law: [number, number][] = [[0, Math.max(r1, tiny)], ...mid.map(([u, r]) => [u, Math.max(r, tiny)] as [number, number]), [1, Math.max(r2, tiny)]];
    for (const [body, edges] of edgesByBody(ctx, p.edges)) {
      const mk = ctx.own(new oc.BRepFilletAPI_MakeFillet(body.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational));
      const done = new Set<number>();
      for (const e of edges) {
        const edge = oc.TopoDS.Edge(e.shape);
        if (mk.Contour(edge) > 0) continue;   // already in a chain started from another picked edge
        mk.Add(edge);
        const ic = mk.Contour(edge);
        if (!(ic > 0) || done.has(ic)) continue;
        done.add(ic);
        const a = k.vertexPoint(ctx.tmp(mk.FirstVertex(ic))), b = k.vertexPoint(ctx.tmp(mk.LastVertex(ic)));
        const firstIsStart = (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) <= 0;
        const forward = firstIsStart !== !!p.swap;
        const pts = forward ? law : law.map(([u, r]) => [1 - u, r] as [number, number]).reverse();
        const arr = ctx.tmp(new oc.NCollection_Array1_gp_Pnt2d(1, pts.length));
        pts.forEach(([u, r], i) => arr.SetValue(i + 1, ctx.tmp(new oc.gp_Pnt2d(u, r))));
        mk.SetRadius(arr, ic, 1);
      }
      try { mk.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (x) { throw ctx.fail(`The fillet could not be built (${k.describe(x)}). Try smaller radii.`); }
      if (!mk.IsDone()) throw ctx.fail(`The fillet on ${body.name} could not be built. Try smaller radii, or fewer edges at once.`);
      const shape: Shape = ctx.own(mk.Shape());
      const solids = k.solids(shape);
      if (solids.length !== 1) throw ctx.fail("The fillet left a broken solid. Try smaller radii.");
      ctx.replaceBody(body, solids[0], k.carryNames(shape, mk, body.topo.faces, id, [...edges, ...body.topo.vertices]));
    }
  },
});

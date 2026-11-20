// sketch-project.ts — what an edge or a vertex of the model looks like on a sketch plane, for the sketcher's
// "Use edge" tool: `await kernel.call("sketch-project", { refs: [GeomRef, …], frame })`.
//
// The answer is in sketch-plane coordinates, as the curves a sketch can hold (services/_sketch-edges.ts): a
// point, a line, a circle or an arc, an ellipse or a partial ellipse (a circle seen at a slant), or a spline
// through points along anything else.  What cannot be projected is reported in `skipped` with the reason.
import type { Frame, GeomRef, Vec2 } from "../core/geometry";
import { toPlane } from "../core/geometry";
import { resolveRef } from "../kernel/regen";
import { defineService } from "../kernel/service";
import { edgeOnPlane, type SketchCurve2 } from "./_sketch-edges";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Projected = SketchCurve2;

export default defineService({
  name: "sketch-project",
  run(ctx, args) {
    const a = args as unknown as { refs?: GeomRef[]; frame?: Frame } | null;
    if (!a || !Array.isArray(a.refs) || !a.frame) throw ctx.fail("Nothing to project.");
    const oc = ctx.oc as any, k = ctx.k, frame = a.frame;
    const flat = (p: [number, number, number]): Vec2 => { const q = toPlane(frame, p); return [Math.round(q[0] * 1e9) / 1e9, Math.round(q[1] * 1e9) / 1e9]; };
    const curves: Projected[] = [], skipped: { ref: GeomRef; why: string }[] = [];
    for (const ref of a.refs) {
      let found;
      try { found = resolveRef(ctx.state, ref); } catch (e) { skipped.push({ ref, why: k.describe(e) }); continue; }
      if (found.kind === "vertex") { curves.push({ type: "point", p: flat(k.vertexPoint(found.shape)), from: ref }); continue; }
      if (found.kind !== "edge") { skipped.push({ ref, why: "Pick an edge or a vertex." }); continue; }
      const r = edgeOnPlane(oc, k, found.shape, frame, ref);
      curves.push(...r.curves);
      if (r.why) skipped.push({ ref, why: r.why });
    }
    return { curves, skipped } as any;
  },
});

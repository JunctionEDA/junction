// sketch-pierce.ts — where an edge of the model (a curve that leaves the sketch plane: a sweep's path, an edge
// of a part) passes through the sketch plane, for the sketcher's "Pierce" constraint:
// `await kernel.call("sketch-pierce", { ref: GeomRef, frame })` → `{ points: [[x, y], …] }` in sketch-plane
// coordinates, or `why` when it does not cross the plane.
import { toPlane, type Frame, type GeomRef, type Vec2 } from "../core/geometry";
import { resolveRef } from "../kernel/regen";
import { defineService } from "../kernel/service";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default defineService({
  name: "sketch-pierce",
  run(ctx, args) {
    const a = args as unknown as { ref?: GeomRef; frame?: Frame } | null;
    if (!a || !a.ref || !a.frame) throw ctx.fail("Nothing to pierce the sketch with.");
    const oc = ctx.oc as any, k = ctx.k, frame = a.frame;
    const found = resolveRef(ctx.state, a.ref);
    if (found.kind !== "edge") return { points: [], why: "Pick an edge of the model." } as any;
    const plane = new oc.gp_Pln(k.pnt(frame.origin), k.dir(frame.normal));
    const sec = new oc.BRepAlgoAPI_Section(found.shape, plane, false);
    const points: Vec2[] = [];
    try {
      sec.Build(new oc.Message_ProgressRange());
      if (sec.IsDone()) {
        for (const v of k.sub(sec.Shape(), "vertex")) {
          const q = toPlane(frame, k.vertexPoint(v)), p: Vec2 = [Math.round(q[0] * 1e9) / 1e9, Math.round(q[1] * 1e9) / 1e9];
          if (!points.some((o) => Math.hypot(o[0] - p[0], o[1] - p[1]) < 1e-7)) points.push(p);
        }
      }
    } finally { sec.delete(); plane.delete(); }
    // an edge that lies in the plane crosses it nowhere in particular
    return (points.length ? { points } : { points, why: "That edge does not pass through the sketch plane." }) as any;
  },
});

// sketch-intersect.ts — where the sketch plane cuts the model, for the sketcher's "Intersection" tool:
// `await kernel.call("sketch-intersect", { refs: [GeomRef (faces) …], bodies: [body id …], frame })`.
//
// Each face, or each whole body, is cut by the sketch's plane; the curves of the cut come back in sketch-plane
// coordinates as the curves a sketch can hold (services/_sketch-edges.ts), each with the face or body it came
// from.  A face the plane misses is reported in `skipped`.
import type { Frame, GeomRef } from "../core/geometry";
import { resolveRef } from "../kernel/regen";
import { defineService } from "../kernel/service";
import { edgeOnPlane, type SketchCurve2 } from "./_sketch-edges";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default defineService({
  name: "sketch-intersect",
  run(ctx, args) {
    const a = args as unknown as { refs?: GeomRef[]; bodies?: string[]; frame?: Frame } | null;
    if (!a || !a.frame || (!Array.isArray(a.refs) && !Array.isArray(a.bodies))) throw ctx.fail("Nothing to intersect.");
    const oc = ctx.oc as any, k = ctx.k, frame = a.frame;
    const plane = new oc.gp_Pln(k.pnt(frame.origin), k.dir(frame.normal));
    const curves: SketchCurve2[] = [], skipped: { ref: GeomRef | string; why: string }[] = [];
    const cut = (shape: any, from: GeomRef, ref: GeomRef | string) => {
      const sec = new oc.BRepAlgoAPI_Section(shape, plane, false);
      try {
        sec.Approximation(true);
        sec.Build(new oc.Message_ProgressRange());
        if (!sec.IsDone()) { skipped.push({ ref, why: "The plane could not be cut through that." }); return; }
        const edges = k.sub(sec.Shape(), "edge");
        if (!edges.length) { skipped.push({ ref, why: "The sketch plane does not cut that." }); return; }
        for (const e of edges) curves.push(...edgeOnPlane(oc, k, e, frame, from).curves);
      } finally { sec.delete(); }
    };
    try {
      for (const ref of a.refs || []) {
        let found;
        try { found = resolveRef(ctx.state, ref); } catch (e) { skipped.push({ ref, why: k.describe(e) }); continue; }
        if (found.kind !== "face") { skipped.push({ ref, why: "Pick a face or a part." }); continue; }
        cut(found.shape, ref, ref);
      }
      for (const id of a.bodies || []) {
        const body = ctx.state.bodies.find((b) => b.id === id);
        if (!body) { skipped.push({ ref: id, why: "That part no longer exists." }); continue; }
        cut(body.shape, { kind: "face", body: id, name: "" }, id);
      }
    } finally { plane.delete(); }
    return { curves, skipped } as any;
  },
});

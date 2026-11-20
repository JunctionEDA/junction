// cf-geo-convex-hull.ts — the Convex hull: the smallest body with no dents that holds the picked bodies, as
// shrink-wrap pulled tight round them (a packaging envelope, a keep-out volume, a blank to cast).  A body with
// flat faces only gets its exact hull.  Round faces are followed by flat facets no further than the accuracy
// from them, since a hull's faces are flat or follow the body, and this one is made of flat ones only.
//
// Names: `<id>:h<n>`, the facets counted in a fixed geometric order (by their middle: x, then y, then z).
import { defineFeature } from "../core/feature";
import { toPlane, type Vec3 } from "../core/geometry";
import type { Body, EvalContext, Shape } from "../kernel/types";
import { faceOfWires, polygonWire, surfacePoints, tightBox } from "../kernel/ops/cf-geo";
import { frameFromNormal } from "../kernel/ops/ref-geom";
import { solidFromFaces } from "../kernel/ops/thicken";
import { convexHull, distinct } from "./_cf-geo-hull";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ConvexHullParams { [key: string]: any; bodies: string[]; accuracy: number; keep: boolean }

export default defineFeature<ConvexHullParams>({
  type: "cf-geo-convex-hull",
  title: "Convex hull",
  hint: "The smallest body without dents that holds the picked bodies.",
  keywords: "convex hull shrink wrap envelope wrap bodies packaging keep out volume simplify",
  icon: '<path class="d" d="M5 6l8-3 7 5-1 9-7 4-8-4z"/><rect class="f" x="7" y="8" width="5" height="5" rx=".5"/><rect x="7" y="8" width="5" height="5" rx=".5"/><circle class="f" cx="14.500" cy="14" r="3"/><circle cx="14.500" cy="14" r="3"/>',
  toolbarOrder: 333, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ bodies: [], accuracy: 0.2, keep: true }),
  schema: [
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Leave empty for every body." },
    { key: "accuracy", label: "Accuracy", kind: "number", unit: "mm", min: 0.005, step: 0.1, hint: "How closely flat facets follow round faces. Smaller makes more facets and takes longer." },
    { key: "keep", label: "Keep the bodies", kind: "boolean", hint: "Off: the hull replaces them." },
  ],

  evaluate(ctx: EvalContext, p: ConvexHullParams) {
    const k = ctx.k, id = ctx.feature.id;
    if (!(p.accuracy >= 0.005)) throw ctx.fail("The accuracy must be 0.005 mm or more.");
    const ids = Array.isArray(p.bodies) ? p.bodies : [];
    const bodies: Body[] = ids.length ? ids.map((b) => ctx.body(b)).filter((b): b is Body => !!b) : ctx.bodies().slice();
    if (!bodies.length) throw ctx.fail(ids.length ? "The bodies to wrap no longer exist. Pick them again." : "There is no body to wrap.");
    const box = tightBox(ctx, bodies.map((b) => b.shape));
    if (!box) throw ctx.fail("The bodies have no size.");
    const size = Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
    // the mesh's points are single precision: nothing nearer than that is told apart
    const eps = Math.max(size * 4e-7, 1e-7);
    const pts = distinct(bodies.flatMap((b) => surfacePoints(ctx, b.shape, p.accuracy, 0.35)), eps * 4);
    if (pts.length > 60000) throw ctx.fail("That is too fine for bodies this round: use a larger accuracy.");
    const hull = convexHull(pts, eps);
    if (!hull) throw ctx.fail("The bodies are flat: they have no hull with volume.");
    if (hull.length > 4000) throw ctx.fail(`The hull would have ${hull.length} facets. Use a larger accuracy.`);
    const faces: Shape[] = [];
    for (const loop of hull) {
      const q = loop.map((i) => pts[i]);
      // the facet's own plane (Newell's normal), its corners laid exactly on it
      let n: Vec3 = [0, 0, 0];
      for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; n = [n[0] + (a[1] - b[1]) * (a[2] + b[2]), n[1] + (a[2] - b[2]) * (a[0] + b[0]), n[2] + (a[0] - b[0]) * (a[1] + b[1])]; }
      if (Math.hypot(n[0], n[1], n[2]) < 1e-14) continue;
      const frame = frameFromNormal(q[0], n);
      try { faces.push(faceOfWires(ctx, frame, polygonWire(ctx, frame, q.map((v) => toPlane(frame, v))))); } catch (e) { /* a sliver: sewing closes over it */ }
    }
    const solid = solidFromFaces(ctx, faces, Math.max(1e-4, eps * 40));
    if (!solid) throw ctx.fail("The hull's facets did not close into a body. Try another accuracy.");
    const named = k.sub(solid, "face"), names: (string | null)[] = named.map(() => `${id}:h`);
    // every facet "the same name": settled into h, h~2, h~3… in geometric order, then written as h1, h2, h3
    k.settleNames(named, names, `${id}:h`, "face");
    const final = names.map((nm) => { const m = /~(\d+)$/.exec(nm || ""); return `${id}:h${m ? m[1] : 1}`; });
    if (!p.keep) for (const b of bodies) ctx.removeBody(b);
    ctx.addBody(solid, (f) => { const i = named.findIndex((x) => x.IsSame(f)); return i >= 0 ? final[i] : null; }, { name: "Hull" });
  },
});

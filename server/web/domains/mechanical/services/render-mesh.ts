// render-mesh.ts — the "render-mesh" service: bodies tessellated finely, for a rendered picture.
//
// The viewport's mesh is as coarse as still looks right while modelling (kernel/tessellate.ts qualityFor): a
// small hole is a dozen flat pieces.  Shaded with the surface's own normals that reads as round, but a path
// tracer shows the outline and the shadow of the dozen pieces.  So Render mode asks for the same bodies again at a
// chord error of a ten-thousandth of the body's size and a few degrees between neighbouring facets:
//
//   await kernel.call("render-mesh", { bodies: ["<body id>", …], linear?: 0.0001, angularDeg?: 4 })
//   → { bodies: [{ id, rev, positions, normals, indices, faces: { names, start, count } }], ms }
//
// The normals are the B-rep surface's at each vertex (the mesher evaluates the surface, it does not average
// facets), and the face ranges are the same names in the same form as the viewport's mesh.  `linear` is a fraction
// of the body's diagonal.  A body the page asks for that is no longer there is left out.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { defineService } from "../kernel/service";
import { tessellate } from "../kernel/tessellate";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default defineService({
  name: "render-mesh",
  run(ctx, raw) {
    const a = (raw || {}) as { bodies?: unknown; linear?: unknown; angularDeg?: unknown };
    const want = Array.isArray(a.bodies) ? a.bodies.filter((x): x is string => typeof x === "string") : null;
    const relative = typeof a.linear === "number" && a.linear > 0 ? Math.min(0.01, Math.max(1e-5, a.linear)) : 1e-4;
    const angular = ((typeof a.angularDeg === "number" && a.angularDeg > 0 ? Math.min(30, Math.max(1, a.angularDeg)) : 4) * Math.PI) / 180;
    const t0 = Date.now(), oc = ctx.oc as any;
    const out: Json[] = [];
    for (const body of ctx.state.bodies) {
      if (want && !want.includes(body.id)) continue;
      let diagonal = 100;
      const box = new oc.Bnd_Box();
      try { oc.BRepBndLib.Add(body.shape, box, false); if (!box.IsVoid()) diagonal = Math.hypot(box.GetXMax() - box.GetXMin(), box.GetYMax() - box.GetYMin(), box.GetZMax() - box.GetZMin()); } catch { /* the default */ } finally { box.delete(); }
      // the triangulation already on the shape (the viewport's) is dropped first, or the mesher would keep it as
      // good enough; and this one after, so the next feature's faces are not drawn this finely (as an export does)
      oc.BRepTools.Clean(body.shape, true);
      let mesh;
      try { mesh = ctx.k.withScope(() => tessellate(ctx.k, body, { linear: Math.max(1e-4, diagonal * relative), angular })); } finally { oc.BRepTools.Clean(body.shape, true); }
      out.push({ id: body.id, rev: body.rev, positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, faces: { names: mesh.faces.names, start: mesh.faces.start, count: mesh.faces.count } } as unknown as Json);
    }
    return { bodies: out, ms: Date.now() - t0 };
  },
});

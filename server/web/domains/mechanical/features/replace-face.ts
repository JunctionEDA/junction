// replace-face.ts — the Replace face feature: put faces of a part on another surface.  The faces around them
// are carried on (or cut back) until they meet it, so the part is trimmed or grown to the new surface.
//
// The new surface is a plane (a default or reference plane, or the plane of a flat face) or the cylinder of a
// round face, optionally offset.  Other kinds of surface are not carried past their own edges by this kernel
// and are refused with a sentence.
//
// Names: a replaced face keeps its name on the new surface.
import { defineFeature } from "../core/feature";
import { add, dot, isGeomRef, scale, sub, type GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { cylinderWall, moveToWall, normalAt, planeWall, pointOn, surfaceOf, type Wall } from "../kernel/ops/cells";
import { planeOf } from "../kernel/ops/ref-geom";
import { facesByBody } from "./delete-face";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ReplaceFaceParams { [key: string]: any; faces: GeomRef[]; target: RefTarget | null; offset: number; flip: boolean }

export default defineFeature<ReplaceFaceParams>({
  type: "replace-face",
  title: "Replace face",
  hint: "Put faces on another surface; the part is trimmed or grown to it.",
  keywords: "swap surface trim extend face to plane direct edit",
  icon: '<path class="f" d="M4 20.5v-9h16v9z"/><path d="M4 11.5v9h16v-9"/><path class="d t" d="M4 11.5h16"/><path d="M2.5 8.5c4-5 8 2 11.5-1.5s5-2.5 7.5-1.5"/><path class="t" d="M8 10.5v-2.5M16 10.5v-4"/>',
  toolbarOrder: 53, toolbarSection: "direct", toolbarKeep: 33,
  defaults: () => ({ faces: [], target: null, offset: 0, flip: false }),
  schema: [
    { key: "faces", label: "Faces to replace", kind: "refs", of: ["face"] },
    { key: "target", label: "Replace with", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"], hint: "A plane, a flat face, or a cylindrical face." },
    { key: "offset", label: "Offset", kind: "number", unit: "mm", step: 1, hint: "How far from that surface, towards the outside of the part." },
    { key: "flip", label: "Other side", kind: "boolean", hint: "Keep the material on the other side of the surface." },
  ],

  evaluate(ctx: EvalContext, p: ReplaceFaceParams) {
    if (!p.target) throw ctx.fail("Pick the surface to replace the faces with.");
    const offset = Number(p.offset) || 0;
    const t = p.target;
    const round = isGeomRef(t) && t.kind === "face" ? (() => { const r = ctx.resolve(t); const s = surfaceOf(ctx, r.shape); return s.kind === "cylinder" ? s : s.kind === "plane" ? null : "other"; })() : null;
    if (round === "other") throw ctx.fail("Replace with a plane, a flat face or a cylindrical face. Other surfaces cannot be carried past their own edges.");
    const plane = round ? null : planeOf(ctx, t, "surface to replace with");
    for (const [start, faces] of facesByBody(ctx, p.faces, "to replace")) {
      let body = start;
      for (const picked of faces) {
        const face = body.topo.faces.find((f) => f.name === picked.name);
        if (!face) throw ctx.fail("A face to replace was used up by replacing the ones before it. Replace them in separate features.");
        const n = normalAt(ctx, face.shape), c = pointOn(ctx, face.shape);
        let wall: Wall;
        if (plane) {
          // the new face looks the way the old one did, unless flipped
          let normal = dot(plane.normal, n) < 0 ? scale(plane.normal, -1) : plane.normal;
          if (p.flip) normal = scale(normal, -1);
          wall = planeWall(ctx, add(plane.origin, scale(normal, offset)), normal, [body.shape]);
        } else {
          const s = round as Extract<ReturnType<typeof surfaceOf>, { kind: "cylinder" }>;
          const r = sub(c, s.origin), radial = sub(r, scale(s.dir, dot(r, s.dir)));
          let outward = dot(n, radial) > 0;
          if (p.flip) outward = !outward;
          const radius = s.radius + (outward ? offset : -offset);
          if (!(radius > 1e-6)) throw ctx.fail("That offset would shrink the cylinder to nothing.");
          wall = cylinderWall(ctx, s.origin, s.dir, radius, outward, [body.shape]);
        }
        const r = moveToWall(ctx, { shape: body.shape, faces: body.topo.faces }, face, wall);
        if (r) body = ctx.replaceBody(body, r.shape, r.names);
        else ctx.warn("A face is already on that surface, or the faces around it do not reach it.");
      }
    }
  },
});

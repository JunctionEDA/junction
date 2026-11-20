// offset-surface.ts — the Offset surface feature: a new surface at a distance from faces of a part, from a
// surface, or from the regions of a sketch.  A distance of zero copies the faces where they are.
//
// The faces picked on one body are offset together, so the new surface stays joined where they were.  Positive
// is the way the faces face (out of a solid); Opposite direction goes the other way.
//
// Faces: `<id>:from(<the face it is offset from>)`; a sketch region's is `<id>:region:<region id>`.
import { defineFeature } from "../core/feature";
import { scale, type GeomRef } from "../core/geometry";
import { ShapeIndex, type NamedResult } from "../kernel/occ";
import type { Body, EvalContext, NamedShape } from "../kernel/types";
import { moveNamed } from "../kernel/ops/shapes";
import { addSheets, namedFacesOf, sewNamed } from "../kernel/ops/surface";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OffsetSurfaceParams {
  [key: string]: any;
  faces: GeomRef[];
  /** sketch regions to offset as flat surfaces (optional) */
  profile: { sketch: string; regions: string[] | null } | null;
  distance: number;
  flip: boolean;
}

export default defineFeature<OffsetSurfaceParams>({
  type: "offset-surface",
  title: "Offset surface",
  icon: '<path class="d" d="M3 19.5c4-3.5 8-3.5 11.5-1.5l6.500-5"/><path class="f" d="M3 12c4-3.5 8-3.5 11.5-1.500L21 5.500v-2.500l-6.500 5c-3.500-2-7.500-2-11.500 1.500z"/><path d="M3 12c4-3.500 8-3.500 11.500-1.500L21 5.500"/><path d="M9 17.500v-5M7 14.300l2-2 2 2"/>',
  toolbarOrder: 10, toolbarSection: "surface", toolbarKeep: 38,
  hint: "A new surface at a distance from faces, a surface or sketch regions. Zero copies them in place.",
  keywords: "surface copy face sheet parallel skin",
  defaults: () => ({ faces: [], profile: null, distance: 5, flip: false }),
  schema: [
    { key: "faces", label: "Faces and surfaces to offset", kind: "refs", of: ["face"] },
    { key: "profile", label: "Sketch regions", kind: "profile", hint: "Optional: the regions of a sketch, offset as flat surfaces." },
    { key: "distance", label: "Offset distance", kind: "number", unit: "mm", min: 0, step: 1, hint: "Zero copies the faces where they are." },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: OffsetSurfaceParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const refs = Array.isArray(p.faces) ? p.faces : [];
    const hasSketch = !!(p.profile && p.profile.sketch);
    if (!refs.length && !hasSketch) throw ctx.fail("Pick the faces, surfaces or sketch regions to offset.");
    const d = Number(p.distance) || 0;
    if (d < 0) throw ctx.fail("The offset distance cannot be negative. Use Opposite direction.");
    const signed = p.flip ? -d : d;

    // the faces picked on one body are offset together
    const byBody = new Map<string, { body: Body; faces: NamedShape[] }>();
    for (const ref of refs) {
      const r = ctx.resolve(ref);
      if (r.kind !== "face") throw ctx.fail("Offset surface takes faces.");
      const g = byBody.get(r.body.id) || { body: r.body, faces: [] };
      if (!g.faces.some((f) => f.name === r.name)) g.faces.push({ name: r.name, shape: r.shape });
      byBody.set(r.body.id, g);
    }
    const results: NamedResult[] = [];
    for (const g of byBody.values()) {
      for (const sheet of sewNamed(ctx, g.faces)) {
        const sources = namedFacesOf(ctx, sheet);
        const named = new ShapeIndex<string>(k);
        let shape: any;
        if (Math.abs(signed) < 1e-9) {
          // a copy in place
          const mk = ctx.own(new oc.BRepBuilderAPI_Transform(sheet.shape, ctx.tmp(new oc.gp_Trsf()), true, false));
          shape = ctx.own(mk.Shape());
          for (const f of sources) named.add(ctx.own(mk.ModifiedShape(f.shape)), `${id}:from(${f.name})`);
        } else {
          const mk = ctx.own(new oc.BRepOffsetAPI_MakeOffsetShape());
          // faces that meet at a corner are carried on until they meet again; failing that the corner is rounded,
          // and failing that each face is offset as it is
          const build = (join: "sharp" | "round" | null) => {
            try {
              if (join) mk.PerformByJoin(sheet.shape, signed, 1e-6, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, join === "sharp" ? oc.GeomAbs_JoinType.GeomAbs_Intersection : oc.GeomAbs_JoinType.GeomAbs_Arc, false, ctx.tmp(new oc.Message_ProgressRange()));
              else mk.PerformBySimple(sheet.shape, signed);
              return mk.IsDone() && !mk.Shape().IsNull() && k.sub(mk.Shape(), "face").length >= sources.length;
            } catch (e) { return false; }
          };
          if (!build(sources.length > 1 ? "sharp" : "round") && !build("round") && !build(null)) throw ctx.fail("The surface could not be offset. Try a smaller distance: an offset larger than a face's inside radius folds it over.");
          shape = ctx.own(mk.Shape());
          for (const f of sources) {
            let images = k.list(mk.Generated(f.shape));
            if (!images.length) images = k.list(mk.Modified(f.shape));
            for (const im of images) if (!named.has(im)) named.add(im, `${id}:from(${f.name})`);
          }
        }
        results.push(...sewNamed(ctx, k.namedFaces(shape, (f) => named.get(f) ?? null, id)));
      }
    }
    if (hasSketch) {
      const sketch = ctx.sketch(p.profile!.sketch);
      const wanted = p.profile!.regions;
      const regions = sketch.regions.filter((r) => !wanted || wanted.includes(r.id));
      if (!regions.length) throw ctx.fail("The sketch has no closed region to offset.");
      for (const r of regions) {
        const name = `${id}:region:${r.id}`;
        results.push(moveNamed(k, r.face, () => name, { translate: scale(sketch.frame.normal, signed) }, ctx.own));
      }
    }
    addSheets(ctx, results);
  },
});

// cf-geo-slice.ts — Slices: the cross-sections of bodies on a row of parallel planes, a set distance apart
// (ribs for a laser-cut model, stations of a hull, the layers of a stack).  Each slice is made as
//
//   surfaces   a flat surface per plane, the section itself.  Extrude, Revolve and Sweep take a flat face as
//              their profile, so a slice is used as a sketch region would be: pick it and extrude; or
//   curves     the outlines of all the slices as one reference curve.
//
// The first plane is the picked one moved by the offset; the rest follow along its normal.  Planes that miss
// the bodies are passed over.
//
// Names: slice n's surface is the body `<id>:s<n>`, its faces `<id>:s<n>:<k>`.
import { defineFeature } from "../core/feature";
import { add, scale } from "../core/geometry";
import type { Body, EvalContext, Shape } from "../kernel/types";
import { setCurve } from "../kernel/ops/curves";
import { planeOf } from "../kernel/ops/ref-geom";
import { compound, planeFace, reachPast } from "../kernel/ops/shapes";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SliceParams { [key: string]: any; bodies: string[]; plane: RefTarget | null; offset: number; count: number; spacing: number; output: "surfaces" | "curves" }

export default defineFeature<SliceParams>({
  type: "cf-geo-slice",
  title: "Slices",
  hint: "Cross-sections of bodies on a row of parallel planes, as flat surfaces to extrude or as curves.",
  keywords: "slice section cross-section body section to sketch profiles at intervals ribs stations contour laser cut stack slicer",
  icon: '<path class="d t" d="M5 20.500c-2-6 0-13 7-17 7 4 9 11 7 17z"/><path class="f" d="M5.200 9h13.600l.800 2.500H4.500zM4 14.500h16l.200 2.500H3.900z"/><path d="M5.200 9h13.600l.800 2.500H4.500zM4 14.500h16l.200 2.500H3.900z"/>',
  toolbarOrder: 336, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ bodies: [], plane: { kind: "plane", plane: "top" }, offset: 5, count: 4, spacing: 10, output: "surfaces" }),
  schema: [
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Leave empty for every body." },
    { key: "plane", label: "First plane", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"], hint: "A plane or a flat face. The slices are parallel to it." },
    { key: "offset", label: "Offset", kind: "number", unit: "mm", step: 1, hint: "From the picked plane to the first slice, along its normal." },
    { key: "count", label: "Slices", kind: "number", unit: "none", min: 1, max: 200, step: 1 },
    { key: "spacing", label: "Spacing", kind: "number", unit: "mm", step: 1, hint: "From one slice to the next, along the normal (negative: the other way).", visible: (p) => Number(p.count) > 1 },
    { key: "output", label: "Make", kind: "enum", options: [{ value: "surfaces", label: "Surfaces" }, { value: "curves", label: "Curves" }] },
  ],

  evaluate(ctx: EvalContext, p: SliceParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const n = Math.round(Number(p.count));
    if (!(n >= 1) || n > 200) throw ctx.fail("The number of slices is between 1 and 200.");
    if (n > 1 && !(Math.abs(p.spacing) > 1e-9)) throw ctx.fail("The spacing between slices cannot be zero.");
    const ids = Array.isArray(p.bodies) ? p.bodies : [];
    const bodies: Body[] = ids.length ? ids.map((b) => ctx.body(b)).filter((b): b is Body => !!b) : ctx.bodies().slice();
    if (!bodies.length) throw ctx.fail(ids.length ? "The bodies to slice no longer exist. Pick them again." : "There is no body to slice.");
    const f = planeOf(ctx, p.plane, "first plane");
    const all = bodies.length === 1 ? bodies[0].shape : compound(k, bodies.map((b) => b.shape), ctx.own);
    const size = reachPast(k, bodies.map((b) => b.shape), f.origin) + Math.abs(Number(p.offset) || 0) + Math.abs(p.spacing * n);
    const outlines: Shape[] = [];
    let made = 0;
    for (let i = 0; i < n; i++) {
      const at = add(f.origin, scale(f.normal, (Number(p.offset) || 0) + i * (Number(p.spacing) || 0)));
      const algo = ctx.tmp(new oc.BRepAlgoAPI_Common(planeFace(k, at, f.normal, size, ctx.own), all, ctx.tmp(new oc.Message_ProgressRange())));
      algo.Build(ctx.tmp(new oc.Message_ProgressRange()));
      if (!algo.IsDone() || algo.HasErrors()) throw ctx.fail(`Slice ${i + 1} could not be cut.`);
      const section: Shape = ctx.own(algo.Shape()), faces = k.sub(section, "face");
      if (!faces.length) continue;   // this plane misses the bodies
      made++;
      if (p.output === "curves") { outlines.push(...k.sub(section, "edge")); continue; }
      const shape = faces.length === 1 ? faces[0] : compound(k, faces, ctx.own);
      ctx.addBody(shape, (face) => { const j = faces.findIndex((x) => x.IsSame(face)); return j >= 0 ? `${id}:s${i + 1}:${j + 1}` : null; }, { suffix: n > 1 ? `s${i + 1}` : undefined, name: `Slice ${i + 1}` });
    }
    if (!made) throw ctx.fail("None of the planes cuts the bodies. Change the offset or the spacing.");
    if (made < n) ctx.warn(`${n - made} of the ${n} planes miss the bodies.`);
    if (p.output === "curves") setCurve(ctx, outlines);
  },
});

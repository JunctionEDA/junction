// cf-hw-knurl.ts — Knurl: a grip cut into the round face of a shaft, a knob or a thumb screw.  Straight: ridges
// along the axis.  Diamond: two sets of grooves crossing on opposite helices, leaving rows of small pyramids, as
// a knurling tool does.  The spacing round the part is made a whole number of teeth, and the diamonds a whole
// number of rows, nearest to what you ask for.
//
// The knurl replaces the cylinder's surface between the face's two ends (kernel/ops/cf-hw-thread.ts, "replacing
// the surface of a cylinder"); the facets are flat, which at knurl sizes is what a formed knurl is.  It never
// stands proud of the face it is cut in.
//
// Names: `<id>:tooth`, numbered.  The rest of the body keeps its names.
import { defineFeature } from "../core/feature";
import { add, cross, scale, type GeomRef, type Vec3 } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { cylinderOf } from "../kernel/ops/cf-hw";
import { boreStock, graft } from "../kernel/ops/cf-hw-thread";
import { HW_SECTION, MENU_THREADS } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface KnurlParams { [key: string]: any; face: GeomRef | null; pattern: "diamond" | "straight"; pitch: number; depth: number; angle: number }

export default defineFeature<KnurlParams>({
  type: "cf-hw-knurl",
  title: "Knurl",
  icon: '<path class="f" d="M7 3h10v18H7z"/><path d="M7 3h10v18H7z"/><path class="t" d="M7 7l5-4M7 12l10-8M7 17l10-8M7 21.5l10-8M12 21l5-4M17 7l-5-4M17 12L7 4M17 17L7 9M17 21.5l-10-8M12 21l-5-4"/>',
  hint: "Cut a diamond or straight knurl into a round face, for grip",
  keywords: "knurl knurling diamond straight grip texture thumb screw knob serration",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_THREADS, toolbarOrder: 40, toolbarKeep: 0,
  defaults: () => ({ face: null, pattern: "diamond", pitch: 2, depth: 0.5, angle: 30 }),
  schema: [
    { key: "face", label: "Cylinder", kind: "refs", of: ["face"], single: true, hint: "The round face to knurl." },
    { key: "pattern", label: "Pattern", kind: "enum", options: [{ value: "diamond", label: "Diamond" }, { value: "straight", label: "Straight" }] },
    { key: "pitch", label: "Pitch", kind: "number", unit: "mm", min: 0.2, step: 0.25, hint: "From tooth to tooth round the part." },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.02, step: 0.1 },
    { key: "angle", label: "Helix angle", kind: "number", unit: "deg", min: 10, max: 60, step: 5, hint: "How steeply the grooves cross the axis.", visible: (p) => p.pattern !== "straight" },
  ],

  evaluate(ctx: EvalContext, p: KnurlParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const cyl = cylinderOf(ctx, p.face, "the round face to knurl");
    if (cyl.hole) throw ctx.fail("A knurl goes on the outside of a part: pick a shaft's face, not a hole's.");
    const R = cyl.radius, L = cyl.hi - cyl.lo, d = Number(p.depth), pitch = Number(p.pitch);
    if (!(pitch > 0) || !(d > 0)) throw ctx.fail("The pitch and the depth must be more than zero.");
    if (!(d < R * 0.4)) throw ctx.fail("The knurl is too deep for this cylinder.");
    const N = Math.max(6, Math.round((2 * Math.PI * R) / pitch));
    const straight = p.pattern === "straight";
    const alpha = ((Math.min(60, Math.max(10, Number(p.angle) || 30))) * Math.PI) / 180;
    const M = straight ? 1 : Math.max(1, Math.round((2 * L) / (((2 * Math.PI * R) / N) / Math.tan(alpha))));
    if (4 * N * M > 12000) throw ctx.fail(`That is ${4 * N * M} facets. Use a coarser pitch.`);
    const origin = add(cyl.origin, scale(cyl.dir, cyl.lo)), y = cross(cyl.dir, cyl.x);
    const wall = (R - d) * Math.cos(Math.PI / N) - Math.max(0.05, 0.1 * d);
    const bored = boreStock(ctx, { shape: cyl.body.shape, faces: cyl.body.topo.faces }, { origin, dir: cyl.dir, x: cyl.x }, L, wall, R + Math.max(0.05, 0.02 * R), false);
    // where the face ends in the middle of a round surface (or at a chamfer), the teeth stop a hair short of it
    const near = bored.ends.map((e) => (e && e.near !== null ? e.near : Infinity));
    const Rp = Math.min(R, Math.min(...near) - Math.max(0.02, 0.05 * d)), Rv = Rp - d;
    const at = (s: number, z: number, radius: number): Vec3 => {
      const th = (Math.PI * s) / N;
      return add(add(add(origin, scale(cyl.x, radius * Math.cos(th))), scale(y, radius * Math.sin(th))), scale(cyl.dir, z));
    };
    const edge = (a: Vec3, b: Vec3): Shape => ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(a)), ctx.tmp(k.pnt(b)))).Edge());
    const facet = (pts: Vec3[]): Shape => {
      const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
      pts.forEach((q, i) => mw.Add(oc.TopoDS.Edge(edge(q, pts[(i + 1) % pts.length]))));
      const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Wire(ctx.tmp(mw.Wire())), true));
      if (!mk.IsDone()) throw ctx.fail("A facet of the knurl could not be built.");
      return ctx.own(mk.Face());
    };
    const ring = (z: number, m: number): Shape => {
      // the zigzag the teeth end in: valleys where s and the row are both even or both odd, peaks between
      const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
      const pt = (s: number) => at(s, z, (s - m) % 2 === 0 ? Rv : Rp);
      for (let s = 0; s < 2 * N; s++) mw.Add(oc.TopoDS.Edge(edge(pt(s), pt(s + 1))));
      return ctx.own(mw.Wire());
    };
    const faces: { face: Shape; role: string }[] = [];
    const role = `${id}:tooth`;
    if (straight) {
      for (let s = 0; s < 2 * N; s++) {
        const r0 = s % 2 === 0 ? Rv : Rp, r1 = s % 2 === 0 ? Rp : Rv;
        faces.push({ face: facet([at(s, 0, r0), at(s + 1, 0, r1), at(s + 1, L, r1), at(s, L, r0)]), role });
      }
    } else {
      const zOf = (m: number) => (m * L) / M;
      for (let m = 0; m <= M; m++) for (let n = 0; n < N; n++) {
        // a pyramid: its peak on row m, a corner each side on that row, one on the row above, one on the row below
        const s = 2 * n + ((m + 1) % 2);
        const peak = at(s, zOf(m), Rp), left = at(s - 1, zOf(m), Rv), right = at(s + 1, zOf(m), Rv);
        if (m < M) { const up = at(s, zOf(m + 1), Rv); faces.push({ face: facet([left, up, peak]), role }, { face: facet([up, right, peak]), role }); }
        if (m > 0) { const down = at(s, zOf(m - 1), Rv); faces.push({ face: facet([right, down, peak]), role }, { face: facet([down, left, peak]), role }); }
      }
    }
    const result = graft(ctx, bored, faces, ring(0, 0), ring(L, straight ? 0 : M), [Rp, Rp]);
    if (!result) throw ctx.fail("The knurl could not be built on this face. It needs a plain round face that ends in flat faces, chamfers or steps.");
    const solids = k.solids(result.shape);
    ctx.replaceBody(cyl.body, solids[0], result.names);
  },
});

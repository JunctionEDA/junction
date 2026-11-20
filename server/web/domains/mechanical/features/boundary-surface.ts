// boundary-surface.ts — the Boundary surface feature: a surface through sets of curves.  The U profiles are
// curves the surface passes through, in the order picked; the optional V profiles run across them.
//
//   U profiles only        one smooth surface through them, from the first to the last (two give a ruled sheet)
//   U and V profiles       a four-sided patch: the first and last U and the first and last V are its edges and
//                          must meet at their ends; any U or V between them is a curve the patch passes through
//
// A profile is an edge, a sketch curve (the curves joined to it come too) or a reference curve; picked edges
// that run end to end count as one profile.
//
// Faces: `<id>:surface` (`~2`, … when the kernel makes more than one).
import { defineFeature } from "../core/feature";
import { length, sub, type Vec3 } from "../core/geometry";
import type { EvalContext, NamedShape, Shape } from "../kernel/types";
import { addSheets, chains, pickedEdges, sewNamed, wireEnds, wireOf } from "../kernel/ops/surface";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BoundarySurfaceParams { [key: string]: any; u: RefTarget[]; v: RefTarget[] }

interface Profile { edges: Shape[]; start: Vec3; end: Vec3; closed: boolean }

/** The profiles a field holds, in the order they were picked. */
function profiles(ctx: EvalContext, targets: readonly RefTarget[]): Profile[] {
  const out: Profile[] = [];
  const edges = pickedEdges(ctx, targets, true).map((e) => e.edge);
  for (const c of chains(ctx, edges)) out.push({ edges: c.edges, start: c.start, end: c.end, closed: c.closed });
  return out;
}

export default defineFeature<BoundarySurfaceParams>({
  type: "boundary-surface",
  title: "Boundary surface",
  icon: '<path class="f" d="M3.500 8c5-3.500 10-3.500 15-1.500l2 10c-5-2-10-2-15 1.500z"/><path d="M3.500 8c5-3.500 10-3.500 15-1.500M5.500 18c5-3.500 10-3.500 15-1.500"/><path class="t" d="M3.500 8l2 10M18.500 6.500l2 10M8.500 5.700l2 10M13.500 5.300l2 10M4.500 13c5-3.500 10-3.500 15-1.500"/>',
  toolbarOrder: 20, toolbarSection: "surface", toolbarKeep: 37,
  hint: "A surface through sets of curves: the U profiles it passes through and, optionally, the V profiles across them.",
  keywords: "surface loft curves network patch blend four sided",
  defaults: () => ({ u: [], v: [] }),
  schema: [
    { key: "u", label: "U profiles", kind: "refs", of: ["edge"], sketch: true, datums: ["curve"], hint: "Two or more curves the surface passes through, in order." },
    { key: "v", label: "V profiles", kind: "refs", of: ["edge"], sketch: true, datums: ["curve"], hint: "Optional: two or more curves across the U profiles, meeting their ends." },
  ],

  evaluate(ctx: EvalContext, p: BoundarySurfaceParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const u = profiles(ctx, Array.isArray(p.u) ? p.u : []), v = profiles(ctx, Array.isArray(p.v) ? p.v : []);
    if (u.length < 2) throw ctx.fail("Pick two or more curves for the U profiles.");
    let shape: Shape;
    if (!v.length) {
      const ts = ctx.own(new oc.BRepOffsetAPI_ThruSections(false, u.length === 2, 1e-6));
      let before: [Vec3, Vec3] | null = null;
      for (const prof of u) {
        let wire = wireOf(ctx, prof.edges);
        let ends = wireEnds(ctx, wire);
        // profiles drawn in opposite directions would twist the surface: run each the way the one before runs
        if (before && !prof.closed && length(sub(ends[0], before[0])) + length(sub(ends[1], before[1])) > length(sub(ends[1], before[0])) + length(sub(ends[0], before[1])) + 1e-9) {
          wire = ctx.own(wire.Reversed()); ends = [ends[1], ends[0]];
        }
        before = ends;
        ts.AddWire(oc.TopoDS.Wire(wire));
      }
      try { ts.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (e) { throw ctx.fail("The surface could not be built through the U profiles."); }
      if (!ts.IsDone()) throw ctx.fail("The surface could not be built through the U profiles.");
      shape = ctx.own(ts.Shape());
    } else {
      if (v.length < 2) throw ctx.fail("Pick two or more V profiles: the first and the last close the sides of the surface.");
      const bounds = [u[0], u[u.length - 1], v[0], v[v.length - 1]];
      const loop = chains(ctx, bounds.flatMap((b) => b.edges));
      if (loop.length !== 1 || !loop[0].closed) throw ctx.fail("The first and last U profiles and the first and last V profiles must meet at their ends, making a closed outline.");
      const mk = ctx.own(new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9));
      for (const e of loop[0].edges) mk.Add(oc.TopoDS.Edge(e), oc.GeomAbs_Shape.GeomAbs_C0, true);
      for (const inner of [...u.slice(1, -1), ...v.slice(1, -1)]) for (const e of inner.edges) mk.Add(oc.TopoDS.Edge(e), oc.GeomAbs_Shape.GeomAbs_C0, false);
      try { mk.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (e) { throw ctx.fail("The surface could not be built from these profiles."); }
      if (!mk.IsDone()) throw ctx.fail("The surface could not be built from these profiles.");
      shape = ctx.own(mk.Shape());
    }
    const faces: NamedShape[] = k.sub(shape, "face").map((f) => ({ name: `${id}:surface`, shape: f }));
    if (!faces.length) throw ctx.fail("The profiles made no surface.");
    // several faces of one result share a name here; the engine settles them to ~2, ~3 in a fixed order
    const settled = k.namedFaces(shape, () => `${id}:surface`, id);
    addSheets(ctx, sewNamed(ctx, settled));
  },
});

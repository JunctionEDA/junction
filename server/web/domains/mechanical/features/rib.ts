// rib.ts — the Rib feature: a thin wall from an open sketch curve to the part.  The curve is given thickness
// (half to each side), then carried towards the part until the part stops it; what lies between the curve and
// the part is joined to the part.  The curve's ends may be carried on until they too meet the part.
//
// "Parallel to the sketch plane": the rib grows in the sketch plane, square to the curve, and is as thick as
// asked across the plane (the usual web between two walls, drawn from the side).  "Normal to the sketch plane":
// it grows along the plane's normal and is thick in the plane (a rib drawn from above).
//
// Names: the rib's own faces are `<id>:new#<n>`; the part's faces keep theirs.
import { defineFeature } from "../core/feature";
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext, Shape } from "../kernel/types";
import { combine, scoped, type Tool } from "../kernel/ops/combine";
import { alongCurve } from "../kernel/ops/ref-geom";
import { compound, distance, reachPast } from "../kernel/ops/shapes";
import { pathWire } from "../kernel/ops/sweep-path";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RibParams { [key: string]: any; profile: RefTarget[]; thickness: number; direction: "parallel" | "normal"; flip: boolean; extend: boolean; targets: string[] }

export default defineFeature<RibParams>({
  type: "rib",
  title: "Rib",
  hint: "A thin wall from an open sketch curve to the part.",
  keywords: "web gusset stiffener brace support wall",
  icon: '<path class="f" d="M3.5 20.5v-3h17v3z"/><path d="M3.5 20.5v-3h17v3zM5.5 17.5v-14h3v14"/><path class="f" d="M8.5 6l9 11.5h-9z"/><path d="M8.5 6l9 11.5"/>',
  toolbarOrder: 32.5, toolbarSection: "modify", toolbarKeep: 48,
  defaults: () => ({ profile: [], thickness: 2, direction: "parallel", flip: false, extend: true, targets: [] }),
  schema: [
    { key: "profile", label: "Profile", kind: "refs", of: [], sketch: true, hint: "An open sketch curve; the curves joined to it come too." },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0.001, step: 0.5 },
    { key: "direction", label: "Rib grows", kind: "enum", options: [{ value: "parallel", label: "In the sketch plane" }, { value: "normal", label: "Normal to it" }] },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
    { key: "extend", label: "Extend the profile to the part", kind: "boolean", hint: "Carry the curve's ends on until they meet the part." },
    { key: "targets", label: "Parts", kind: "bodies", hint: "Leave empty for every body." },
  ],

  evaluate(ctx: EvalContext, p: RibParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const picked = (Array.isArray(p.profile) ? p.profile : []).filter((t) => t && t.kind === "sketch");
    if (!picked.length) throw ctx.fail("Pick the sketch curve the rib follows.");
    if (!(p.thickness > 0)) throw ctx.fail("The thickness must be more than zero.");
    const sketchId = (picked[0] as any).feature as string;
    if (picked.some((t: any) => t.feature !== sketchId)) throw ctx.fail("The rib's profile must be in one sketch.");
    const frame = ctx.sketch(sketchId).frame;
    const bodies = scoped(ctx, p.targets);
    if (!bodies.length) throw ctx.fail("There is no part for the rib to reach.");
    const wire = pathWire(ctx, picked);
    const a = alongCurve(ctx, wire, 0), b = alongCurve(ctx, wire, 1);
    if (length(sub(a.at, b.at)) < 1e-6) throw ctx.fail("The rib's profile must be an open curve.");
    const n = frame.normal, chord = normalize(sub(b.at, a.at));
    const sign = p.flip ? -1 : 1;
    // which way the rib grows, and which way it is thick
    const grow: Vec3 = p.direction === "normal" ? scale(n, sign) : scale(normalize(cross(n, chord)), sign);
    const thick: Vec3 = p.direction === "normal" ? normalize(cross(n, chord)) : n;
    const reach = reachPast(k, bodies.map((x) => x.shape), a.at) + length(sub(b.at, a.at));

    const edgeOf = (from: Vec3, to: Vec3): Shape => ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(from)), ctx.tmp(k.pnt(to)))).Edge());
    const wireOf = (edges: Shape[]): Shape => { const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire()); for (const e of edges) mw.Add(oc.TopoDS.Edge(e)); if (!mw.IsDone()) throw ctx.fail("The rib's profile could not be followed."); return ctx.own(mw.Wire()); };
    const move = (s: Shape, v: Vec3): Shape => { const t = ctx.tmp(new oc.gp_Trsf()); t.SetTranslation(ctx.tmp(k.vec(v))); return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_Transform(s, t, true, false)).Shape()); };
    const prism = (s: Shape, v: Vec3): Shape => { const mk = ctx.own(new oc.BRepPrimAPI_MakePrism(s, ctx.tmp(k.vec(v)), false, true)); mk.Build(ctx.tmp(new oc.Message_ProgressRange())); if (!mk.IsDone()) throw ctx.fail("The rib could not be built."); return ctx.own(mk.Shape()); };
    /** the curve, thick, carried `reach` towards the part: one solid per piece of the curve, joined */
    const slab = (w: Shape): { solid: Shape; start: Shape } => {
      const start = prism(move(w, scale(thick, -p.thickness / 2)), scale(thick, p.thickness));   // a face (or a shell of them)
      const long = prism(start, scale(grow, reach));
      const solids = k.solids(long);
      if (!solids.length) throw ctx.fail("The rib could not be built.");
      let acc: NamedResult = { shape: solids[0], names: () => null };
      for (const s of solids.slice(1)) acc = k.boolean("fuse", { shape: acc.shape, faces: k.namedFaces(acc.shape, acc.names, id) }, { shape: s, faces: k.namedFaces(s, () => null, id) }, id, ctx.own);
      return { solid: acc.shape, start };
    };
    const own = slab(wire);
    let long = own.solid;
    if (p.extend) {
      const edges = k.sub(wire, "edge");
      long = slab(wireOf([edgeOf(sub(a.at, scale(a.tangent, reach)), a.at), ...edges, edgeOf(b.at, add(b.at, scale(b.tangent, reach)))])).solid;
    }
    // what the part leaves of the slab; the rib is the part of it that starts at the curve and ends at the part
    const other = bodies.length === 1 ? bodies[0].shape : compound(k, bodies.map((x) => x.shape), ctx.own);
    const cut = k.boolean("cut", { shape: long, faces: k.namedFaces(long, () => null, id) }, { shape: other, faces: [] }, id, ctx.own);
    const far = scale(grow, reach), size = reachPast(k, [long], a.at);
    const pieces = k.solids(cut.shape).filter((s) => {
      if (distance(k, s, own.start) > 1e-6) return false;
      // a piece that runs off to the far end of the slab was never stopped by the part
      const bb = ctx.tmp(new oc.Bnd_Box()); oc.BRepBndLib.Add(s, bb, false);
      const corners: Vec3[] = [];
      for (const x of [bb.GetXMin(), bb.GetXMax()]) for (const y of [bb.GetYMin(), bb.GetYMax()]) for (const z of [bb.GetZMin(), bb.GetZMax()]) corners.push([x, y, z]);
      const along = Math.max(...corners.map((c) => dot(sub(c, a.at), grow)));
      const side = Math.max(...corners.map((c) => Math.abs(dot(sub(c, a.at), chord))));
      return along < length(far) * 0.98 && (!p.extend || side < reach * 0.98) && size > 0;
    });
    if (!pieces.length) throw ctx.fail("The rib does not reach the part, or runs past it: nothing closes it in. Flip the direction, or draw the profile so it points at the part.");
    const tools: Tool[] = pieces.map((shape, i) => ({ shape, names: () => null, suffix: `r${i + 1}` }));
    combine(ctx, tools, "add", p.targets);
  },
});

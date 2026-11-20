// cf-geo-auto-fillet.ts — Fillet all edges: round (or bevel) every edge of a body that a filter lets through,
// in one feature, instead of picking them one by one.  The filter is which way an edge bends (outside corners,
// inside corners, or both) and how sharp it is (the angle its two faces turn through: 90° on a box, 0° where
// they run into each other smoothly); picked edges, and every edge of a picked face, are left alone.
//
// An edge is an outside corner when each face falls away behind the other's, an inside corner when it rises
// in front of it; that is read from the faces themselves at the middle of the edge.  When all the edges cannot
// take the size together, those that cannot take it even alone are left out and said so.
//
// Names: as Fillet and Chamfer: old faces keep theirs, a new face is `<id>:from(<the edge it replaced>)`.
import { defineFeature } from "../core/feature";
import { add, cross, dot, normalize, scale, type GeomRef, type Vec3 } from "../core/geometry";
import { ShapeIndex } from "../kernel/occ";
import type { Body, EvalContext, NamedShape, Shape } from "../kernel/types";
import { distanceTo, normalNear } from "../kernel/ops/surface";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AutoFilletParams { [key: string]: any; bodies: string[]; kind: "fillet" | "chamfer"; size: number; which: "convex" | "concave" | "all"; minAngle: number; maxAngle: number; exclude: GeomRef[] }

export interface EdgeKind { edge: NamedShape; convex: boolean; angle: number }

/** Every edge of a body that lies between two faces: which way it bends, and by how much (degrees). */
export function classifyEdges(ctx: EvalContext, body: Body): EdgeKind[] {
  const oc = ctx.oc as any, k = ctx.k;
  const around = new ShapeIndex<Shape[]>(k);
  for (const f of body.topo.faces) for (const e of k.sub(f.shape, "edge")) { const have = around.get(e); if (have) { if (!have.some((x) => x.IsSame(f.shape))) have.push(f.shape); } else around.add(e, [f.shape]); }
  const out: EdgeKind[] = [];
  for (const edge of body.topo.edges) {
    const faces = around.get(edge.shape);
    if (!faces || faces.length !== 2) continue;   // a seam, or the rim of a surface
    if (oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(edge.shape))) continue;
    try {
      const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge.shape)));
      const p = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), v = ctx.tmp(new oc.gp_Vec(0, 0, 0));
      ad.D1((ad.FirstParameter() + ad.LastParameter()) / 2, p, v);
      const m = k.xyz(p), t = normalize(k.xyz(v));
      const n1 = normalNear(ctx, faces[0], m), n2 = normalNear(ctx, faces[1], m);
      const angle = (Math.acos(Math.max(-1, Math.min(1, dot(n1, n2)))) * 180) / Math.PI;
      // the direction that runs into the second face from the edge: the one of ± n2 × t that stays on it
      const side = cross(n2, t), step = Math.max(1e-4, 1e-3 * Math.hypot(v.X(), v.Y(), v.Z()) * (ad.LastParameter() - ad.FirstParameter()));
      const into: Vec3 = distanceTo(ctx, add(m, scale(side, step)), faces[1]) <= distanceTo(ctx, add(m, scale(side, -step)), faces[1]) ? side : scale(side, -1);
      out.push({ edge, convex: dot(n1, into) < 0, angle });
    } catch (e) { /* an edge with no direction: left alone */ }
  }
  return out;
}

export default defineFeature<AutoFilletParams>({
  type: "cf-geo-auto-fillet",
  title: "Fillet all edges",
  hint: "Round or bevel every edge of a body that passes a filter: outside or inside corners, by sharpness.",
  keywords: "auto fillet all edges chamfer all break edges deburr round all convex concave by angle filter every edge",
  icon: '<path class="f" d="M4 20V9a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v11z"/><path d="M4 20V9a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v11z"/><path class="d t" d="M4 4h16"/><path class="t" d="M9 13l2 2 4-4.500"/>',
  toolbarOrder: 335, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ bodies: [], kind: "fillet", size: 1, which: "convex", minAngle: 10, maxAngle: 180, exclude: [] }),
  schema: [
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Leave empty for every body." },
    { key: "kind", label: "Make", kind: "enum", options: [{ value: "fillet", label: "Fillet" }, { value: "chamfer", label: "Chamfer" }] },
    { key: "size", label: "Size", kind: "number", unit: "mm", min: 0.001, step: 0.25, hint: "A fillet's radius, a chamfer's distance." },
    { key: "which", label: "Edges", kind: "enum", options: [{ value: "convex", label: "Outside" }, { value: "concave", label: "Inside" }, { value: "all", label: "Both" }], hint: "Outside corners stick out of the part; inside corners are its internal corners." },
    { key: "minAngle", label: "Sharper than", kind: "number", unit: "deg", min: 0, max: 180, step: 5, hint: "Only edges whose faces turn through more than this: 90° on a box, 0° where faces run on smoothly." },
    { key: "maxAngle", label: "Not sharper than", kind: "number", unit: "deg", min: 0, max: 180, step: 5 },
    { key: "exclude", label: "Leave alone", kind: "refs", of: ["edge", "face"], hint: "Edges to keep sharp. A face keeps every edge round it." },
  ],

  evaluate(ctx: EvalContext, p: AutoFilletParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    if (!(p.size > 0)) throw ctx.fail("The size must be more than zero.");
    if (!(p.minAngle >= 0) || !(p.maxAngle > p.minAngle) || p.maxAngle > 180) throw ctx.fail("The angles run from 0° to 180°, the first less than the second.");
    const ids = Array.isArray(p.bodies) ? p.bodies : [];
    const bodies: Body[] = ids.length ? ids.map((b) => ctx.body(b)).filter((b): b is Body => !!b) : ctx.bodies().slice();
    if (!bodies.length) throw ctx.fail(ids.length ? "The bodies no longer exist. Pick them again." : "There is no body to round the edges of.");
    const skip = new ShapeIndex<true>(k);
    for (const ref of Array.isArray(p.exclude) ? p.exclude : []) {
      const r = ctx.resolve(ref);
      for (const e of r.kind === "face" ? k.sub(r.shape, "edge") : [r.shape]) if (!skip.has(e)) skip.add(e, true);
    }
    const what = p.kind === "chamfer" ? "bevelled" : "rounded";
    let done = 0;
    const left: string[] = [];
    for (const body of bodies) {
      const wanted = classifyEdges(ctx, body).filter((e) => !skip.has(e.edge.shape) && e.angle > p.minAngle + 1e-6 && e.angle <= p.maxAngle + 1e-6 && (p.which === "all" || (p.which === "concave") === !e.convex));
      if (!wanted.length) continue;
      const attempt = (edges: readonly EdgeKind[]): { shape: Shape; mk: any } | null => {
        try {
          const mk = ctx.own(p.kind === "chamfer" ? new oc.BRepFilletAPI_MakeChamfer(body.shape) : new oc.BRepFilletAPI_MakeFillet(body.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational));
          for (const e of edges) mk.Add(p.size, oc.TopoDS.Edge(e.edge.shape));
          mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
          if (!mk.IsDone()) return null;
          const shape: Shape = ctx.own(mk.Shape());
          return k.solids(shape).length === 1 && k.volume(shape) > 1e-9 ? { shape, mk } : null;
        } catch (e) { return null; }
      };
      let use = wanted, r = attempt(use);
      if (!r) {
        // which edges can take the size at all: each tried alone, then all of those together
        if (wanted.length > 150) throw ctx.fail(`The ${wanted.length} edges of ${body.name} cannot all be ${what} at this size. Try a smaller size, or narrow the filter.`);
        use = wanted.filter((e) => attempt([e]));
        r = use.length ? attempt(use) : null;
        if (!r) throw ctx.fail(`The edges of ${body.name} cannot be ${what} together at this size${use.length < wanted.length ? ` (${wanted.length - use.length} of ${wanted.length} cannot take it even alone)` : ""}. Try a smaller size.`);
        left.push(`${wanted.length - use.length} of ${body.name}'s ${wanted.length} edges cannot take this size and were left sharp`);
      }
      const solid = k.solids(r.shape)[0];
      ctx.replaceBody(body, solid, k.carryNames(r.shape, r.mk, body.topo.faces, id, [...use.map((e) => e.edge), ...body.topo.vertices]));
      done += use.length;
    }
    if (!done) throw ctx.fail("No edge passes the filter. Widen the angles, or choose Both.");
    if (left.length) ctx.warn(`${left.join("; ")}.`);
  },
});

// move-boundary.ts — the Move boundary feature: move open edges of a surface outwards (Extend) or inwards (Trim)
// by a distance.
//
//   Extend   a strip is added along each edge, leaving in the surface's own direction, and sewn to the surface.
//            On a flat face, and along the straight lines of a cylinder, that is the surface itself carried on
//            and the strip merges into the face; on a curved face it is the tangent continuation.
//   Trim     the surface is cut along a line the distance inside each edge and the outer strip is thrown away.
//
// The surface keeps its body and its faces keep their names; a strip that stays a face of its own is
// `<id>:extend:<the edge's name>`.
import { defineFeature } from "../core/feature";
import { add, length, scale, sub, type GeomRef, type Vec3 } from "../core/geometry";
import { ShapeIndex } from "../kernel/occ";
import type { Body, EvalContext, NamedShape, Shape } from "../kernel/types";
import { curveThrough, distanceTo, outward, ribbon, ruledBetween, sampleEdge, samplesFor, sewNamed, type EdgeSample } from "../kernel/ops/surface";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MoveBoundaryParams { [key: string]: any; edges: GeomRef[]; moveType: "extend" | "trim"; distance: number }

interface Moved { edge: Shape; name: string; face: NamedShape; samples: EdgeSample[]; out: Vec3[] }

export default defineFeature<MoveBoundaryParams>({
  type: "move-boundary",
  title: "Move boundary",
  icon: '<path class="f" d="M3 7.500c3-2 6-2 9-.5v11c-3-1.500-6-1.500-9 .5z"/><path d="M12 7v11M3 7.500c3-2 6-2 9-.5M3 18.500c3-2 6-2 9-.5M3 7.500v11"/><path class="d" d="M12 7c3 1 6 1 9-.500v11c-3 1.500-6 1.500-9 .500"/><path d="M13.500 12.500h5M16.500 10.500l2 2-2 2"/>',
  toolbarOrder: 40, toolbarSection: "surface", toolbarMenu: "Surface", toolbarKeep: 60,
  hint: "Move the open edges of a surface outwards to extend it, or inwards to trim it.",
  keywords: "surface extend trim edge lengthen shorten untrim",
  defaults: () => ({ edges: [], moveType: "extend", distance: 5 }),
  schema: [
    { key: "edges", label: "Edges to move", kind: "refs", of: ["edge"], hint: "Open edges of a surface." },
    { key: "moveType", label: "Move", kind: "enum", options: [{ value: "extend", label: "Extend" }, { value: "trim", label: "Trim" }] },
    { key: "distance", label: "Distance", kind: "number", unit: "mm", min: 0.001, step: 1 },
  ],

  evaluate(ctx: EvalContext, p: MoveBoundaryParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const refs = Array.isArray(p.edges) ? p.edges : [];
    if (!refs.length) throw ctx.fail("Pick the open edges of a surface to move.");
    const dist = Number(p.distance);
    if (!(dist > 0)) throw ctx.fail("The distance must be more than zero.");

    const byBody = new Map<string, { body: Body; moved: Moved[] }>();
    for (const ref of refs) {
      const r = ctx.resolve(ref);
      if (r.kind !== "edge") throw ctx.fail("Move boundary takes edges.");
      if (!r.body.sheet) throw ctx.fail(`“${r.body.name}” is a solid part. Pick the open edges of a surface.`);
      const on = r.body.topo.faces.filter((f) => k.sub(f.shape, "edge").some((e) => e.IsSame(r.shape)));
      if (on.length !== 1) throw ctx.fail("An edge between two faces of the surface cannot be moved. Pick its open edges.");
      const flat = !!k.faceFrame(on[0].shape as any);
      const samples = sampleEdge(ctx, r.shape, on[0].shape, undefined, samplesFor(ctx, r.shape, flat));
      const g = byBody.get(r.body.id) || { body: r.body, moved: [] };
      if (!g.moved.some((m) => m.name === r.name)) g.moved.push({ edge: r.shape, name: r.name, face: on[0], samples, out: outward(ctx, on[0].shape, samples) });
      byBody.set(r.body.id, g);
    }

    for (const { body, moved } of byBody.values()) {
      if (p.moveType === "trim") { trim(ctx, body, moved, dist); continue; }
      const faces: NamedShape[] = body.topo.faces.slice();
      for (const m of moved) for (const f of k.sub(ribbon(ctx, m.edge, m.samples, m.out, dist), "face")) faces.push({ name: `${id}:extend:${m.name}`, shape: f });
      const sheets = sewNamed(ctx, faces);
      if (sheets.length !== 1) throw ctx.fail("The extension did not join the surface.");
      let shape = sheets[0].shape, names = sheets[0].names;
      // a strip that carries a flat or cylindrical face on is that same face: merge them
      try {
        const sewn = k.namedFaces(shape, names, id);
        const un = ctx.own(new oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false));
        un.Build();
        const merged: Shape = ctx.own(un.Shape());
        const after = k.sub(merged, "face");
        if (after.length && after.length < sewn.length) {
          // a merged face is named after the original face lying in it, else after the strip
          const index = new ShapeIndex<string>(k);
          const originals = sewn.filter((f) => !f.name.startsWith(`${id}:extend:`)), strips = sewn.filter((f) => f.name.startsWith(`${id}:extend:`));
          for (const f of after) {
            const inside = (s: NamedShape) => distanceTo(ctx, k.centre(s.shape, "face"), f) < 1e-6;
            const hit = originals.find(inside) || strips.find(inside);
            if (hit) index.add(f, hit.name);
          }
          shape = merged; names = (f) => index.get(f) ?? null;
        }
      } catch (e) { /* the sewn surface stands */ }
      ctx.replaceBody(body, shape, names);
    }
  },
});

/** Cut a strip `dist` wide off the surface inside each moved edge. */
function trim(ctx: EvalContext, body: Body, moved: readonly Moved[], dist: number): void {
  const oc = ctx.oc as any, k = ctx.k;
  let faces: NamedShape[] = body.topo.faces.slice();
  for (const m of moved) {
    // the cutting line: the edge moved inwards, carried a little past both ends so it crosses the whole face
    const n = m.samples.length - 1;
    const inner = m.samples.map((s, i) => add(s.at, scale(m.out[i], -dist)));
    const first = m.samples[0], last = m.samples[n];
    const reach = Math.max(dist, length(sub(last.at, first.at)) * 0.05) + 1e-3;
    const line: Vec3[] = [add(inner[0], scale(first.tangent, -reach)), ...inner, add(inner[n], scale(last.tangent, reach))];
    const normals: Vec3[] = [first.normal, ...m.samples.map((s) => s.normal), last.normal];
    // a knife through the surface along that line
    const h = Math.max(1, dist);
    const knife = ruledBetween(ctx, curveThrough(ctx, line.map((q, i) => add(q, scale(normals[i], h)))), curveThrough(ctx, line.map((q, i) => add(q, scale(normals[i], -h)))));
    const target = faces.find((f) => f.name === m.face.name);
    if (!target) throw ctx.fail("A face to trim is gone: the trims overlap. Use a smaller distance.");
    const sp = ctx.own(new oc.BRepAlgoAPI_Splitter());
    const args = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()), tools = ctx.tmp(new oc.NCollection_List_TopoDS_Shape());
    args.Append(target.shape); tools.Append(knife);
    sp.SetArguments(args); sp.SetTools(tools);
    sp.Build(ctx.tmp(new oc.Message_ProgressRange()));
    if (!sp.IsDone()) throw ctx.fail("The surface could not be trimmed.");
    const pieces = k.sub(ctx.own(sp.Shape()), "face");
    if (pieces.length < 2) throw ctx.fail("The trim does not cross the surface. Use a smaller distance.");
    // the piece that holds the edge's middle is the strip that goes
    const mid: Vec3 = n >= 2 ? m.samples[Math.floor(n / 2)].at : scale(add(first.at, last.at), 0.5);
    const keep = pieces.filter((f) => distanceTo(ctx, mid, f) > Math.min(dist * 0.5, 1e-3));
    if (!keep.length || keep.length === pieces.length) throw ctx.fail("The surface could not be trimmed. Use a smaller distance.");
    faces = faces.filter((f) => f !== target).concat(keep.map((f) => ({ name: target.name, shape: f })));
  }
  const sheets = sewNamed(ctx, faces);
  ctx.replaceBody(body, sheets[0].shape, sheets[0].names);
  sheets.slice(1).forEach((s, i) => ctx.addBody(s.shape, s.names, { suffix: `${body.id}.piece${i + 2}`, name: `${body.name} (${i + 2})` }));
}

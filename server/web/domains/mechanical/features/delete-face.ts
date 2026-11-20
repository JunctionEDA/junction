// delete-face.ts — the Delete face feature: take faces off a part and close the gap.  "Heal" carries the faces
// around them on until they meet (a hole fills, a boss or a rounding goes, a corner comes back sharp); "Cap"
// closes each opening with a flat face instead.  It works on any part, whatever made it (an imported one too).
//
// Names: healed, the neighbours keep their names (they grew); a cap is `<id>:cap`, `<id>:cap~2`, ….
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { Body, EvalContext, NamedShape, Shape } from "../kernel/types";
import { ShapeIndex } from "../kernel/occ";
import { healFaces } from "../kernel/ops/cells";
import { freeEdges, solidFromFaces } from "../kernel/ops/thicken";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DeleteFaceParams { [key: string]: any; faces: GeomRef[]; mode: "heal" | "cap" }

/** The picked faces, by the body they are on. */
export function facesByBody(ctx: EvalContext, refs: readonly GeomRef[] | undefined, what: string): Map<Body, NamedShape[]> {
  const out = new Map<Body, NamedShape[]>();
  for (const ref of refs || []) {
    const r = ctx.resolve(ref);
    if (r.kind !== "face") throw ctx.fail(`Pick faces ${what}.`);
    const list = out.get(r.body) || [];
    if (!list.some((f) => f.name === r.name)) list.push({ name: r.name, shape: r.shape });
    out.set(r.body, list);
  }
  if (!out.size) throw ctx.fail(`Pick the faces ${what}.`);
  return out;
}

/** Group edges into closed loops by the vertices they share. */
function loops(ctx: EvalContext, edges: readonly Shape[]): Shape[][] {
  const k = ctx.k;
  const at = new ShapeIndex<number[]>(k);
  edges.forEach((e, i) => { for (const v of k.sub(e, "vertex")) { const have = at.get(v); if (have) have.push(i); else at.add(v, [i]); } });
  const seen = new Set<number>(), out: Shape[][] = [];
  edges.forEach((_, start) => {
    if (seen.has(start)) return;
    const group: Shape[] = [], todo = [start];
    while (todo.length) {
      const i = todo.pop()!;
      if (seen.has(i)) continue;
      seen.add(i); group.push(edges[i]);
      for (const v of k.sub(edges[i], "vertex")) for (const j of at.get(v) || []) if (!seen.has(j)) todo.push(j);
    }
    out.push(group);
  });
  return out;
}

export default defineFeature<DeleteFaceParams>({
  type: "delete-face",
  title: "Delete face",
  hint: "Take faces off a part and close the gap: fill a hole, remove a boss or a rounding.",
  keywords: "remove face defeature heal fill hole cap direct edit",
  icon: '<path class="f" d="M3.5 8.5l8.5-4.5 8.5 4.5v8l-8.5 4.5-8.5-4.5z"/><path d="M3.5 8.5l8.5-4.5 8.5 4.5v8l-8.5 4.5-8.5-4.5zM3.5 8.5l8.5 4.5 8.5-4.5M12 13v8"/><path class="t" d="M9.5 7l5 3M14.5 7l-5 3"/>',
  toolbarOrder: 51, toolbarSection: "direct", toolbarKeep: 33,
  defaults: () => ({ faces: [], mode: "heal" }),
  schema: [
    { key: "faces", label: "Faces to delete", kind: "refs", of: ["face"] },
    { key: "mode", label: "Close the gap", kind: "enum", options: [{ value: "heal", label: "Heal" }, { value: "cap", label: "Cap" }], hint: "Heal: the faces around grow until they meet. Cap: a flat face over each opening." },
  ],

  evaluate(ctx: EvalContext, p: DeleteFaceParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    for (const [body, faces] of facesByBody(ctx, p.faces, "to delete")) {
      if (p.mode !== "cap") {
        const r = healFaces(ctx, { shape: body.shape, faces: body.topo.faces }, faces.map((f) => f.shape));
        ctx.replaceBody(body, r.shape, r.names);
        continue;
      }
      const gone = new ShapeIndex<true>(k);
      for (const f of faces) gone.add(f.shape, true);
      const kept = body.topo.faces.filter((f) => !gone.has(f.shape));
      if (!kept.length) throw ctx.fail("Those faces are the whole part.");
      const sheet = ctx.own(new oc.TopoDS_Compound());
      const builder = ctx.tmp(new oc.TopoDS_Builder());
      builder.MakeCompound(sheet);
      for (const f of kept) builder.Add(sheet, f.shape);
      const caps: Shape[] = [];
      for (const loop of loops(ctx, freeEdges(ctx, sheet))) {
        const list = ctx.tmp(new oc.NCollection_List_TopoDS_Shape());
        for (const e of loop) list.Append(e);
        const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
        mw.Add(list);
        if (!mw.IsDone()) throw ctx.fail("An opening left by the deleted faces is not one closed loop, so it cannot be capped.");
        const mf = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(mw.Wire(), true));
        if (!mf.IsDone()) throw ctx.fail("An opening left by the deleted faces is not flat, so it cannot be capped. Use Heal.");
        caps.push(ctx.own(mf.Face()));
      }
      const solid = solidFromFaces(ctx, [...kept.map((f) => f.shape), ...caps]);
      if (!solid) throw ctx.fail("The part does not close with flat caps. Use Heal.");
      // sewing keeps the faces it is given, so the kept ones are found again by where they are
      const names = byPlace(ctx, solid, kept, `${id}:cap`);
      ctx.replaceBody(body, solid, names);
    }
  },
});

/** Name the faces of `shape` after the named faces they coincide with (same centre and area); the rest `fallback`. */
export function byPlace(ctx: EvalContext, shape: Shape, named: readonly NamedShape[], fallback: string) {
  const k = ctx.k, oc = ctx.oc as any;
  const area = (f: Shape) => { const g = new oc.GProp_GProps(); oc.BRepGProp.SurfaceProperties(f, g, false, false); const a = g.Mass(); g.delete(); return a; };
  const key = (f: Shape) => [...k.centre(f, "face"), area(f)].map((v) => Math.round(v * 1e4)).join(",");
  const from = new Map<string, string>();
  for (const f of named) from.set(key(f.shape), f.name);
  const index = new ShapeIndex<string>(k);
  for (const f of k.sub(shape, "face")) index.add(f, from.get(key(f)) ?? fallback);
  return (f: any) => index.get(f) ?? null;
}

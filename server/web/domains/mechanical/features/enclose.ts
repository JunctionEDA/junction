// enclose.ts — the Enclose feature: a solid from every space that the picked faces and planes close off
// completely.  Planes count as endless; faces count as they are.  The picked faces stay where they were.
//
// Names: a face of the new solid that lies on a picked face of a body is `<id>:on(<that face's name>)`; on a
// plane, `<id>:on(<plane>)`.
import { defineFeature } from "../core/feature";
import { DEFAULT_PLANES, dot, isGeomRef, scale, sub, type Vec3 } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { ShapeIndex } from "../kernel/occ";
import { splitBox, type Source } from "../kernel/ops/cells";
import { combine, type Tool } from "../kernel/ops/combine";
import { bbox, planeFace } from "../kernel/ops/shapes";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface EncloseParams { [key: string]: any; entities: RefTarget[]; operation: "new" | "add"; targets: string[] }

export default defineFeature<EncloseParams>({
  type: "enclose",
  title: "Enclose",
  hint: "A solid from the space that the picked faces and planes close off.",
  keywords: "close volume region surfaces planes solid fill",
  icon: '<path class="f" d="M7 8h10v9H7z"/><path d="M7 3.5v17.5M17 3.5v17.5M3.5 8h17M3.5 17h17"/>',
  toolbarOrder: 27, toolbarSection: "solid", toolbarKeep: 44,
  defaults: () => ({ entities: [], operation: "new", targets: [] }),
  schema: [
    { key: "operation", label: "Result", kind: "enum", options: [{ value: "new", label: "New" }, { value: "add", label: "Add" }] },
    { key: "entities", label: "Faces and planes", kind: "refs", of: ["face"], planes: true, datums: ["plane"], hint: "Everything that bounds the space. A plane counts as endless." },
    { key: "targets", label: "Bodies to change", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.operation === "add" },
  ],

  evaluate(ctx: EvalContext, p: EncloseParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const picked = Array.isArray(p.entities) ? p.entities : [];
    if (picked.length < 2) throw ctx.fail("Pick the faces and planes that close off a space.");
    const faces: { name: string; shape: Shape }[] = [];
    const planes: { name: string; origin: Vec3; normal: Vec3 }[] = [];
    for (const t of picked) {
      if (t.kind === "plane") { const f = DEFAULT_PLANES[t.plane].frame; planes.push({ name: t.plane, origin: f.origin, normal: f.normal }); }
      else if (t.kind === "datum") { const d = ctx.datum(t.feature); if (d.kind !== "plane" || !d.frame) throw ctx.fail("Pick faces and planes."); planes.push({ name: t.feature, origin: d.frame.origin, normal: d.frame.normal }); }
      else if (isGeomRef(t) && t.kind === "face") { const r = ctx.resolve(t); faces.push({ name: r.name, shape: r.shape }); }
      else throw ctx.fail("Pick faces and planes.");
    }
    // a box round everything finite; planes are made to pass right through it
    const b = bbox(k, faces.map((f) => f.shape)) || [-50, -50, -50, 50, 50, 50];
    for (const pl of planes) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a], pl.origin[a]); b[a + 3] = Math.max(b[a + 3], pl.origin[a]); }
    const diag = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]), m = diag * 0.5 + 50;
    const box: Shape = ctx.own(ctx.tmp(new oc.BRepPrimAPI_MakeBox(ctx.tmp(new oc.gp_Pnt(b[0] - m, b[1] - m, b[2] - m)), ctx.tmp(new oc.gp_Pnt(b[3] + m, b[4] + m, b[5] + m)))).Shape());
    const centre: Vec3 = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    const sources: Source[] = [
      ...faces.map((f) => ({ shape: f.shape, tag: () => `on(${f.name})` })),
      ...planes.map((pl) => ({ shape: planeFace(k, sub(centre, scale(pl.normal, dot(sub(centre, pl.origin), pl.normal))), pl.normal, diag * 4 + 400, ctx.own), tag: () => `on(${pl.name})` })),
    ];
    const cells = splitBox(ctx, box, sources).filter((c) => c.tags.every((t) => !t.has("box")));
    if (!cells.length) throw ctx.fail("The faces and planes do not close off a space. Every side must be bounded.");
    const tools: Tool[] = cells.map((c, n) => {
      const index = new ShapeIndex<string>(k);
      c.faces.forEach((f, i) => { const tag = Array.from(c.tags[i]).find((t) => t.startsWith("on(")); if (tag) index.add(f, `${id}:${tag}`); });
      return { shape: c.shape, names: (f: any) => index.get(f) ?? null, suffix: `r${n + 1}` };
    });
    combine(ctx, tools, p.operation === "add" ? "add" : "new", p.targets);
  },
});

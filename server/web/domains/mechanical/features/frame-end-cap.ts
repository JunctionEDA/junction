// frame-end-cap.ts — End cap: close the open end of a frame member with a plate: outside, on the end face (the
// member's outline), or inside, filling the tube's bore set back from the end.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { setItems, type FrameItem } from "../kernel/ops/frame";
import { FRAME_SECTION } from "./_frame";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface EndCapParams { [key: string]: any; faces: GeomRef[]; capType: "external" | "internal"; thickness: number; inset: number }

export default defineFeature<EndCapParams>({
  type: "frame-end-cap",
  title: "End cap",
  icon: '<path class="f" d="M15 6h4v12h-4z"/><path d="M3 8h12v8H3zM15 6h4v12h-4z"/>',
  hint: "Close the open end of a frame member with a plate",
  keywords: "end cap plug plate tube frame",
  toolbarSection: FRAME_SECTION, toolbarOrder: 31, toolbarKeep: 40,
  defaults: () => ({ faces: [], capType: "external", thickness: 3, inset: 0 }),
  schema: [
    { key: "faces", label: "End faces", kind: "refs", of: ["face"], hint: "The flat end faces of members." },
    { key: "capType", label: "Cap", kind: "enum", options: [{ value: "external", label: "External" }, { value: "internal", label: "Internal" }] },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "inset", label: "Inset", kind: "number", unit: "mm", min: 0, step: 0.5, visible: (p) => p.capType === "internal" },
  ],

  evaluate(ctx: EvalContext, p: EndCapParams) {
    const k = ctx.k, oc = ctx.oc as any, id = ctx.feature.id;
    if (!p.faces || !p.faces.length) throw ctx.fail("Pick the end faces of members to cap.");
    if (!(p.thickness > 0)) throw ctx.fail("The thickness must be more than zero.");
    const items: FrameItem[] = [];
    p.faces.forEach((ref, i) => {
      const r = ctx.resolve(ref);
      const face = oc.TopoDS.Face(r.shape), fr = k.faceFrame(face);
      if (!fr) throw ctx.fail("Pick a flat end face.");
      const outer = oc.BRepTools.OuterWire(face);
      let cap: any, dir = fr.normal, from = 0;
      if (p.capType === "internal") {
        const inner = k.sub(face, "wire").filter((w) => !w.IsSame(outer));
        if (!inner.length) throw ctx.fail("That end is not open: an internal cap needs a tube.");
        cap = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Wire(inner[0].Reversed()), true)).Face();
        dir = [-fr.normal[0], -fr.normal[1], -fr.normal[2]]; from = p.inset || 0;
      } else cap = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Wire(outer), true)).Face();
      const mv = (s: any, by: number) => { const t = ctx.tmp(new oc.gp_Trsf()); t.SetTranslation(ctx.tmp(k.vec([dir[0] * by, dir[1] * by, dir[2] * by]))); return ctx.tmp(new oc.BRepBuilderAPI_Transform(s, t, true, false)).Shape(); };
      const base = from ? mv(cap, from) : cap;
      const pr = ctx.tmp(new oc.BRepPrimAPI_MakePrism(base, ctx.tmp(k.vec([dir[0] * p.thickness, dir[1] * p.thickness, dir[2] * p.thickness])), false, true));
      const shape = ctx.own(pr.Shape());
      const body = ctx.addBody(shape, (f) => { const g = k.faceFrame(f as any); return g && Math.abs(g.normal[0] * dir[0] + g.normal[1] * dir[1] + g.normal[2] * dir[2]) > 0.99 ? `${id}.c${i + 1}:${g.normal[0] * dir[0] + g.normal[1] * dir[1] + g.normal[2] * dir[2] > 0 ? "outside" : "inside"}` : null; }, { suffix: `c${i + 1}`, name: `End cap (${ctx.feature.name}, ${i + 1})` });
      items.push({ body: body.id, feature: id, kind: "end cap", label: `End cap ${p.capType === "internal" ? "internal" : "external"} t${p.thickness}`, length: p.thickness, angles: [0, 0] });
    });
    setItems(ctx, items);
  },
});

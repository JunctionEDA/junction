// cf-hw-gasket.ts — Gasket: a flat gasket cut to the outline of a face.  Pick the flat mating face of a part (a
// flange, the rim of a housing); the gasket is that face's shape, holes and all, given thickness, lying on the
// face.  It can be drawn back from the outer edge, and its holes opened up for the bolts.
//
// Names: `<id>:<face>:top`, `:bottom`, `:outer` (the outside edge's faces) and `:hole` (numbered).
import { defineFeature } from "../core/feature";
import { scale, type GeomRef } from "../core/geometry";
import { ShapeIndex } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { flatFace } from "../kernel/ops/cf-hw-thread";
import { offsetWire } from "../kernel/ops/cf-hw-wires";
import { HW_SECTION, MENU_ENCLOSURES } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GasketParams { [key: string]: any; faces: GeomRef[]; thickness: number; inset: number; holes: number }

export default defineFeature<GasketParams>({
  type: "cf-hw-gasket",
  title: "Gasket",
  icon: '<path class="f" d="M4 5h16v14H4z"/><path d="M4 5h16v14H4z"/><rect x="8" y="9" width="8" height="6" rx="1"/><circle class="s" cx="6" cy="7" r="0.9"/><circle class="s" cx="18" cy="7" r="0.9"/><circle class="s" cx="6" cy="17" r="0.9"/><circle class="s" cx="18" cy="17" r="0.9"/>',
  hint: "Make a flat gasket in the shape of a picked face, holes and all",
  keywords: "gasket seal flange face outline sheet shim from face",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 42, toolbarKeep: 0,
  defaults: () => ({ faces: [], thickness: 1, inset: 0, holes: 0 }),
  schema: [
    { key: "faces", label: "Faces", kind: "refs", of: ["face"], hint: "Flat faces; a gasket is made on each." },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0.01, step: 0.5 },
    { key: "inset", label: "Back from the edge", kind: "number", unit: "mm", step: 0.5, hint: "Draw the outside in by this much (negative: out)." },
    { key: "holes", label: "Open the holes by", kind: "number", unit: "mm", step: 0.1, hint: "Added all round each hole (negative: closes them up)." },
  ],

  evaluate(ctx: EvalContext, p: GasketParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const refs = Array.isArray(p.faces) ? p.faces : [];
    if (!refs.length) throw ctx.fail("Pick the flat face the gasket seals.");
    if (!(p.thickness > 0)) throw ctx.fail("The thickness must be more than zero.");
    for (const ref of refs) {
      const r = ctx.resolve(ref);
      const frame = r.kind === "face" ? k.faceFrame(r.shape as any) : null;
      if (!frame) throw ctx.fail("A gasket needs a flat face.");
      const outerWire = oc.BRepTools.OuterWire(oc.TopoDS.Face(r.shape));
      const wires = k.sub(r.shape, "wire");
      const outer = offsetWire(ctx, frame.origin, frame.normal, frame.x, wires.find((w) => w.IsSame(outerWire))!, -(Number(p.inset) || 0));
      if (outer.length !== 1) throw ctx.fail("Drawn back that far from the edge, the gasket has no outline left (or falls apart).");
      const holes = wires.filter((w) => !w.IsSame(outerWire)).flatMap((w) => offsetWire(ctx, frame.origin, frame.normal, frame.x, w, Number(p.holes) || 0));
      const face = flatFace(ctx, frame.origin, frame.normal, frame.x, 0, outer[0], holes);
      const prism = ctx.own(new oc.BRepPrimAPI_MakePrism(face, ctx.tmp(k.vec(scale(frame.normal, p.thickness))), false, true));
      prism.Build();
      if (!prism.IsDone()) throw ctx.fail("The gasket could not be built.");
      const shape = ctx.own(prism.Shape());
      const prefix = `${id}:${r.name}`;
      const named = new ShapeIndex<string>(k);
      named.add(ctx.own(prism.FirstShape()), `${prefix}:bottom`);
      named.add(ctx.own(prism.LastShape()), `${prefix}:top`);
      for (const e of k.sub(outer[0], "edge")) for (const side of k.list(prism.Generated(e))) if (!named.has(side)) named.add(side, `${prefix}:outer`);
      for (const h of holes) for (const e of k.sub(h, "edge")) for (const side of k.list(prism.Generated(e))) if (!named.has(side)) named.add(side, `${prefix}:hole`);
      ctx.addBody(shape, (f) => named.get(f) ?? null, { suffix: refs.length > 1 ? r.name : undefined, name: "Gasket" });
    }
  },
});

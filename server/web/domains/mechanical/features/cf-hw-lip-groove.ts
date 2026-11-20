// cf-hw-lip-groove.ts — Lip and groove: the locating joint between two halves of a housing, along their split
// line.  Pick the flat face where one half meets the other (the rim of a shell).  A lip is raised on that face,
// following its outside edge a set distance in; the matching groove, a clearance larger all round, is cut in
// the part (or parts) that sit on it.  The halves then find each other and cannot slide.
//
// Names: `<id>:lip:side`, `<id>:lip:top`, and in the other part `<id>:groove:side`, `<id>:groove:top`.
import { defineFeature } from "../core/feature";
import { scale, type GeomRef } from "../core/geometry";
import { ShapeIndex, type NamedResult } from "../kernel/occ";
import type { EvalContext, Shape } from "../kernel/types";
import { changeBody } from "../kernel/ops/cf-hw";
import { flatFace } from "../kernel/ops/cf-hw-thread";
import { offsetWire } from "../kernel/ops/cf-hw-wires";
import { HW_SECTION, MENU_ENCLOSURES } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface LipGrooveParams { [key: string]: any; face: GeomRef | null; inset: number; width: number; height: number; clearance: number; targets: string[] }

export default defineFeature<LipGrooveParams>({
  type: "cf-hw-lip-groove",
  title: "Lip and groove",
  icon: '<path class="f" d="M3 13h18v7H3z"/><path d="M3 13h18v7H3z"/><path class="f" d="M7 9h10v4H7z"/><path d="M7 13V9h10v4"/><path class="d" d="M3 9V4h18v5M6 9V7.5h12V9"/>',
  hint: "Raise a locating lip along the rim of one half of a housing and cut its groove in the other",
  keywords: "lip groove tongue rabbet rebate split line shell halves mating locating joint housing snap",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 11, toolbarKeep: 0,
  defaults: () => ({ face: null, inset: 1, width: 1, height: 1.5, clearance: 0.15, targets: [] }),
  schema: [
    { key: "face", label: "Mating face", kind: "refs", of: ["face"], single: true, hint: "The flat rim where the two halves meet. The lip is raised on its part." },
    { key: "inset", label: "In from the edge", kind: "number", unit: "mm", min: 0, step: 0.25, hint: "From the face's outside edge to the lip." },
    { key: "width", label: "Lip width", kind: "number", unit: "mm", min: 0.1, step: 0.25 },
    { key: "height", label: "Lip height", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "The gap between the lip and its groove, all round and at the top." },
    { key: "targets", label: "Parts to groove", kind: "bodies", hint: "Leave empty for every other part the lip reaches into." },
  ],

  evaluate(ctx: EvalContext, p: LipGrooveParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    if (!p.face) throw ctx.fail("Pick the flat face where the two halves meet.");
    const r = ctx.resolve(p.face);
    const frame = r.kind === "face" ? k.faceFrame(r.shape as any) : null;
    if (!frame) throw ctx.fail("The mating face must be flat.");
    const inset = Math.max(0, Number(p.inset) || 0), width = Number(p.width), height = Number(p.height), c = Math.max(0, Number(p.clearance) || 0);
    if (!(width > 0) || !(height > 0)) throw ctx.fail("The lip's width and height must be more than zero.");
    const outline = k.sub(r.shape, "wire").find((w) => w.IsSame(oc.BRepTools.OuterWire(oc.TopoDS.Face(r.shape))))!;
    // a band between the outline drawn in by `from` and by `to`, raised (or sunk) by `h`
    const band = (from: number, to: number, h: number, prefix: string): NamedResult => {
      const outer = offsetWire(ctx, frame.origin, frame.normal, frame.x, outline, -from);
      const inner = offsetWire(ctx, frame.origin, frame.normal, frame.x, outline, -to);
      if (outer.length !== 1) throw ctx.fail("The lip does not fit: it is further in from the edge than the face is wide.");
      if (inner.length > 1) throw ctx.fail("The lip's inside falls apart at this distance from the edge. Bring it nearer the edge.");
      const face = flatFace(ctx, frame.origin, frame.normal, frame.x, 0, outer[0], inner);
      const prism = ctx.own(new oc.BRepPrimAPI_MakePrism(face, ctx.tmp(k.vec(scale(frame.normal, h))), false, true));
      prism.Build();
      if (!prism.IsDone()) throw ctx.fail("The lip could not be built.");
      const shape: Shape = ctx.own(prism.Shape());
      const named = new ShapeIndex<string>(k);
      named.add(ctx.own(prism.LastShape()), `${prefix}:top`);
      for (const f of k.sub(shape, "face")) if (!named.has(f) && !f.IsSame(prism.FirstShape())) named.add(f, `${prefix}:side`);
      return { shape, names: (f) => named.get(f) ?? null };
    };
    if (inset - c < -1e-9 && c > 0) ctx.warn("The lip is nearer the edge than its clearance: the groove breaks through the outside of the other part.");
    const lip = band(inset, inset + width, height, `${id}:lip`);
    const groove = band(Math.max(0, inset - c), inset + width + c, height + c, `${id}:groove`);
    // the groove first, in the parts that are there now; then the lip on its own part
    const others = ctx.bodies().filter((b) => b.id !== r.body.id && (!p.targets || !p.targets.length || p.targets.includes(b.id)));
    let grooved = 0;
    for (const b of others) if (changeBody(ctx, b, "cut", groove)) grooved++;
    changeBody(ctx, ctx.body(r.body.id)!, "fuse", lip);
    if (!grooved) ctx.warn("The lip was raised, but no other part reaches it: no groove was cut.");
  },
});

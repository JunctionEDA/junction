// cf-fab-kerf.ts — Kerf compensation: grow the outline of flat plates by half the width the cutter removes, so
// the parts come off the laser, the plasma or the water jet at the size they were drawn.
//
// Every cut edge of a plate (its outline and the outlines of its holes) moves into the waste by half the kerf:
// the outside grows, holes shrink.  Corners stay sharp.  A negative kerf does the opposite.  The plate must be
// flat and of one thickness, with square edges; its two flat sides are left where they are.
// Names: the two flat sides and every edge face keep the names they had; a face the offset adds is
// `<id>:new#n`.
import { defineFeature } from "../core/feature";
import { scale } from "../core/geometry";
import { ShapeIndex, type NamedResult } from "../kernel/occ";
import type { EvalContext, Shape } from "../kernel/types";
import { scoped } from "../kernel/ops/combine";
import { facesOfEdge } from "../kernel/ops/shapes";
import { area, bool, offsetLoops, plateOf, together } from "../kernel/ops/cf-fab";
import { LASER } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface KerfParams { [key: string]: any; bodies: string[]; kerf: number }

export default defineFeature<KerfParams>({
  type: "cf-fab-kerf",
  title: "Kerf compensation",
  icon: '<path class="f" d="M6 6h12v12H6z"/><path d="M6 6h12v12H6z"/><path class="d t" d="M3 3h18v18H3z"/><path class="s" d="M12 1.5l1.8 2.5h-3.6zM12 22.5l1.8-2.5h-3.6zM1.5 12L4 10.2v3.6zM22.5 12L20 10.2v3.6z"/>',
  hint: "Offset the cut edges of flat plates by half the kerf, so parts come out to size",
  keywords: "kerf compensation offset laser plasma waterjet cut width outline grow tolerance",
  ...LASER, toolbarOrder: 22,
  defaults: () => ({ bodies: [], kerf: 0.2 }),
  schema: [
    { key: "bodies", label: "Plates", kind: "bodies", hint: "Leave empty for every body." },
    { key: "kerf", label: "Kerf", kind: "number", unit: "mm", step: 0.05, hint: "The width of the cut. Each edge moves by half of it." },
  ],

  evaluate(ctx: EvalContext, p: KerfParams) {
    const k = ctx.k, oc = ctx.oc as any;
    const kerf = Number(p.kerf);
    if (!Number.isFinite(kerf) || !kerf) throw ctx.fail("The kerf must be a number other than zero.");
    if (Math.abs(kerf) > 10) throw ctx.fail("The kerf must be small (at most 10 mm).");
    const plates = scoped(ctx, p.bodies);
    if (!plates.length) throw ctx.fail("There is no plate to compensate.");
    for (const body of plates) {
      const pl = plateOf(ctx, body);
      const top = oc.TopoDS.Face(pl.top.shape), topArea = area(ctx, top), vol = k.volume(body.shape);
      if (Math.abs(vol - topArea * pl.thickness) > 1e-6 * vol) throw ctx.fail(`${body.name} is not a flat plate of one thickness with square edges. Kerf compensation works on parts as they are cut from a sheet.`);
      // each loop of the outline on its own: the outside grows, a hole shrinks
      const sideName = new ShapeIndex<string>(k);
      const loops = offsetLoops(ctx, top, kerf / 2, body.name);
      for (const loop of loops) for (const e of k.sub(loop.from, "edge")) {
        // each offset edge is called what the edge face it replaces was called
        const side = facesOfEdge(k, body.topo.faces, e).find((f) => !f.shape.IsSame(top));
        if (side) for (const g of k.list(loop.history.Generated(e))) if (!sideName.has(g)) sideName.add(g, side.name);
      }
      const down = scale(pl.frame.normal, -pl.thickness);
      const solids: NamedResult[] = loops.map((loop, i) => {
        const prism = ctx.own(new oc.BRepPrimAPI_MakePrism(loop.face, ctx.tmp(k.vec(down)), false, true));
        prism.Build(ctx.tmp(new oc.Message_ProgressRange()));
        if (!prism.IsDone()) throw ctx.fail(`${body.name} could not be rebuilt at its new size.`);
        const named = new ShapeIndex<string>(k);
        if (i === 0) { named.add(ctx.own(prism.FirstShape()), pl.top.name); if (pl.bottom) named.add(ctx.own(prism.LastShape()), pl.bottom.name); }
        for (const e of k.sub(loop.wire, "edge")) { const n = sideName.get(e); if (n) for (const s of k.list(prism.Generated(e))) if (!named.has(s)) named.add(s, n); }
        return { shape: ctx.own(prism.Shape()) as Shape, names: (f: any) => named.get(f) ?? null };
      });
      const result = solids.length > 1 ? bool(ctx, "cut", solids[0], together(ctx, solids.slice(1))) : solids[0];
      const whole = k.solids(result.shape);
      if (whole.length !== 1) throw ctx.fail(`${body.name} falls apart with that kerf.`);
      ctx.replaceBody(body, whole[0], (f, i) => result.names(f, i) ?? null);
    }
  },
});

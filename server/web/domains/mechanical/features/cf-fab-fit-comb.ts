// cf-fab-fit-comb.ts — Press-fit test comb: a strip with a row of slots a step apart in width, to cut once and
// find the slot your sheet presses into, which gives the kerf of the machine and material.
//
// The slots are open on the top edge and their widths run from narrow to wide around the nominal thickness.
// The corner at the narrow end is cut off so the comb cannot be read backwards, and a small notch in the bottom
// edge marks the slot of nominal width.  The strip is as thick as the material.
// Names: `<id>:start` (the face on the plane), `<id>:end`, `<id>:slot<n>-l`, `-floor`, `-r`, `<id>:mark`,
// `<id>:land<n>`, `<id>:bottom…`.
import { defineFeature } from "../core/feature";
import type { PlaneRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { prism, positive, whole, type P2, type Seg } from "../kernel/ops/cf-fab";
import { LASER } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FitCombParams { [key: string]: any; plane: PlaneRef; thickness: number; step: number; count: number; depth: number; land: number }

/** The slot widths of a comb: `count` of them a `step` apart, centred on the nominal thickness. */
export const combWidths = (thickness: number, step: number, count: number): number[] => Array.from({ length: count }, (_, i) => Math.round((thickness + (i - (count - 1) / 2) * step) * 1e6) / 1e6);

export default defineFeature<FitCombParams>({
  type: "cf-fab-fit-comb",
  title: "Press-fit test comb",
  icon: '<path class="f" d="M2 20V7l2-2h2v8h1.5V5h3v8h2V5h3v8h2.5V5H22v15z"/><path d="M2 20V7l2-2h2v8h1.5V5h3v8h2V5h3v8h2.5V5H22v15h-9.5l-.5-1-.5 1z"/>',
  hint: "A strip of slots a step apart in width, to find the press fit and kerf for a material",
  keywords: "press fit test comb kerf test slot gauge tolerance laser calibration fit tester",
  ...LASER, toolbarOrder: 34,
  defaults: () => ({ plane: { kind: "plane", plane: "top" }, thickness: 3, step: 0.05, count: 7, depth: 10, land: 8 }),
  schema: [
    { key: "plane", label: "Lies on", kind: "plane" },
    { key: "thickness", label: "Material thickness", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "The middle slot is this wide; the strip is this thick." },
    { key: "step", label: "Step", kind: "number", unit: "mm", min: 0.005, step: 0.01, hint: "How much wider each slot is than the one before." },
    { key: "count", label: "Slots", kind: "number", unit: "none", min: 1, step: 2 },
    { key: "depth", label: "Slot depth", kind: "number", unit: "mm", min: 0.5, step: 1 },
    { key: "land", label: "Between slots", kind: "number", unit: "mm", min: 0.5, step: 1 },
  ],

  evaluate(ctx: EvalContext, p: FitCombParams) {
    const t = positive(ctx, p.thickness, "material thickness"), step = positive(ctx, p.step, "step"), depth = positive(ctx, p.depth, "slot depth"), land = positive(ctx, p.land, "space between slots");
    const count = whole(ctx, p.count, "number of slots", 1, 60);
    const widths = combWidths(t, step, count);
    if (!(widths[0] > 0)) throw ctx.fail("The narrowest slot would have no width. Use a smaller step or fewer slots.");
    const height = depth + Math.max(8, land), length = land * (count + 1) + widths.reduce((a, b) => a + b, 0);
    const chamfer = Math.min(land * 0.6, depth * 0.6), mark = Math.min(1.5, land / 3);
    const base = ctx.frameOf(p.plane);
    // round the outline from the bottom left, anticlockwise; x centred on the plane's origin
    const x0 = -length / 2;
    const start: P2 = [x0, 0];
    const segs: Seg[] = [];
    // the bottom edge, with a notch under the nominal slot (the middle one of an odd count)
    const nominal = widths.findIndex((w) => Math.abs(w - t) < 1e-9);
    let x = x0 + land;
    const centres = widths.map((w) => { const c = x + w / 2; x += w + land; return c; });
    if (nominal >= 0) segs.push({ to: [centres[nominal] - mark, 0], name: "bottom" }, { to: [centres[nominal], mark], name: "mark" }, { to: [centres[nominal] + mark, 0], name: "mark-r" });
    segs.push({ to: [x0 + length, 0], name: "bottom-r" }, { to: [x0 + length, height], name: "wide-end" });
    for (let i = count - 1; i >= 0; i--) {
      const c = centres[i], w = widths[i];
      segs.push({ to: [c + w / 2, height], name: `land${i + 2}` }, { to: [c + w / 2, height - depth], name: `slot${i + 1}-r` }, { to: [c - w / 2, height - depth], name: `slot${i + 1}-floor` }, { to: [c - w / 2, height], name: `slot${i + 1}-l` });
    }
    segs.push({ to: [x0 + chamfer, height], name: "land1" }, { to: [x0, height - chamfer], name: "narrow-corner" }, { to: [x0, 0], name: "narrow-end" });
    const r = prism(ctx, base, start, segs, 0, t, ctx.feature.id);
    ctx.addBody(r.shape, r.names, { name: "Test comb" });
  },
});

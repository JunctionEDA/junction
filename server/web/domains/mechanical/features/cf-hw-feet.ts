// cf-hw-feet.ts — Feet: four feet at the corners of a rectangle (or one at each picked point), on the underside
// of a part.  Feet are round, tapered pads that join the part, with a screw hole if wanted; or they are shallow
// recesses that seat stick-on rubber bumpers so they do not slide off.
//
// Names: `<id>:<place>:f<n>:side`, `:end`, `:edge`, `:hole`; recesses `:wall`, `:floor`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { apply, cornerPoints, flipped, frameAt, poly, prefixAt, revolved, spots, together, type Tool, type V2 } from "../kernel/ops/cf-hw";
import { cutFields, HW_SECTION, MENU_ENCLOSURES, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FeetParams {
  [key: string]: any;
  style: "feet" | "recess"; dx: number; dy: number; diameter: number; height: number; taper: number; hole: number;
  depth: number; clearance: number; targets: string[];
}

export default defineFeature<FeetParams>({
  type: "cf-hw-feet",
  title: "Feet",
  icon: '<path class="f" d="M3 5h18v9H3z"/><path d="M3 5h18v9H3z"/><path class="f" d="M5 14h4l-.6 5H5.6zM15 14h4l-.6 5h-2.8z"/><path d="M5 14l.6 5h2.8l.6-5M15 14l.6 5h2.8l.6-5"/>',
  hint: "Add four feet at the corners of a rectangle, or recesses for stick-on rubber bumpers",
  keywords: "feet foot bumper pads rubber bumpon recess stand-off corners base underside",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 62, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), style: "feet", dx: 60, dy: 40, diameter: 10, height: 3, taper: 10, hole: 0, depth: 1, clearance: 0.4, targets: [] }),
  schema: [
    ...whereFields({ angle: true, noun: "set of feet" }),
    { key: "style", label: "Make", kind: "enum", options: [{ value: "feet", label: "Feet" }, { value: "recess", label: "Bumper recesses" }] },
    { key: "dx", label: "Across", kind: "number", unit: "mm", min: 0, step: 5, hint: "Between the feet; 0 for one row." },
    { key: "dy", label: "Up", kind: "number", unit: "mm", min: 0, step: 5 },
    { key: "diameter", label: "Diameter", kind: "number", unit: "mm", min: 0.5, step: 1, hint: "Of a foot where it joins the part, or of the bumper." },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 0.1, step: 0.5, visible: (p) => p.style !== "recess" },
    { key: "taper", label: "Taper", kind: "number", unit: "deg", min: 0, max: 45, step: 5, visible: (p) => p.style !== "recess" },
    { key: "hole", label: "Screw hole Ø", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "A hole up the middle of each foot; 0 for none.", visible: (p) => p.style !== "recess" },
    { key: "depth", label: "Recess depth", kind: "number", unit: "mm", min: 0.05, step: 0.25, visible: (p) => p.style === "recess" },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, step: 0.1, hint: "Added to the bumper's diameter.", visible: (p) => p.style === "recess" },
    { ...cutFields[0], label: "Bodies" },
  ],

  evaluate(ctx: EvalContext, p: FeetParams) {
    const D = Number(p.diameter);
    if (!(D > 0)) throw ctx.fail("The diameter must be more than zero.");
    const at = cornerPoints(Number(p.dx) || 0, Number(p.dy) || 0);
    const recess = p.style === "recess";
    const tools: Tool[] = [];
    for (const s of spots(ctx, p)) {
      const prefix = prefixAt(ctx, s);
      const made = at.map((q, i) => {
        if (recess) {
          const r = (D + Math.max(0, Number(p.clearance) || 0)) / 2, depth = Number(p.depth);
          if (!(depth > 0)) throw ctx.fail("The recess's depth must be more than zero.");
          return revolved(ctx, flipped(frameAt(s.frame, q)), poly([[0, -0.01], [r, -0.01], [r, depth], [0, depth]] as V2[], [null, "wall", "floor", null]), `${prefix}:f${i + 1}`);
        }
        const H = Number(p.height), slope = Math.tan(((Number(p.taper) || 0) * Math.PI) / 180);
        if (!(H > 0)) throw ctx.fail("The height must be more than zero.");
        const r0 = D / 2, e = Math.min(0.5, H / 4), r1 = r0 - (H - e) * slope - e, rh = Math.max(0, Number(p.hole) || 0) / 2;
        if (!(r1 > rh + 0.3)) throw ctx.fail("The feet taper to nothing: make them wider, lower or less tapered.");
        // from just inside the part (so it joins) out to the rounded-off end
        const pts: V2[] = [[rh, -0.01], [r0, -0.01], [r0, 0], [r1 + e, H - e], [r1, H], [rh, H]];
        return revolved(ctx, frameAt(s.frame, q), poly(pts, [null, null, "side", "edge", "end", rh > 0 ? "hole" : null]), `${prefix}:f${i + 1}`);
      });
      if (recess) tools.push({ ...together(ctx, made), suffix: s.key });
      else made.forEach((foot, i) => tools.push({ ...foot, suffix: `${s.key}.f${i + 1}` }));
    }
    apply(ctx, tools, { operation: recess ? "remove" : "add", targets: p.targets });
  },
});

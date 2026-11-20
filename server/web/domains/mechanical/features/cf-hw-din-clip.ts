// cf-hw-din-clip.ts — DIN rail clip: a clip that snaps onto 35 mm top-hat rail (EN 60715, TS 35), to print or
// mill and screw to the back of whatever goes on the rail.  A plate with a fixed hook that goes over the rail's
// top lip and a shallower, ramped latch that springs over the bottom one.
//
// It stands on the picked plane: the plate lies on it, the hooks rise from it, the rail runs along the plane's
// second direction.  Screw holes go through the plate, countersunk from the rail's side so the heads clear it.
//
// Names: `<id>:plate` (the outline's faces, numbered), `<id>:bottom`, `<id>:top` (the two sides), `<id>:h<n>:…`.
import { defineFeature } from "../core/feature";
import { add, scale, type Frame } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { apply, copies, cut, drill, extruded, frameAt, poly, spots, together, type V2 } from "../kernel/ops/cf-hw";
import { fastenerOf, fastenerOptions, HW_SECTION, MENU_ENCLOSURES, resultFields, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DinClipParams {
  [key: string]: any;
  width: number; thickness: number; hook: number; clearance: number; holes: number; spacing: number; screw: string; countersunk: boolean;
  operation: "new" | "add"; targets: string[];
}

/** The rail: 35 mm between the tips of its lips, the lips 1 mm thick. */
const RAIL = 35, LIP = 1;

export default defineFeature<DinClipParams>({
  type: "cf-hw-din-clip",
  title: "DIN rail clip",
  icon: '<path class="f" d="M4 16h16v4H4zM4 16V8h5v2.5H6.5V16zM20 16V9.5h-4V12h1.5v4z"/><path d="M4 20h16v-4M4 20V8h5v2.5H6.5V16h11v-4H16V9.5h4V16"/><path class="d" d="M8 13.5h8"/>',
  hint: "Make a clip that snaps onto 35 mm DIN rail (TS 35), with screw holes",
  keywords: "din rail clip mount ts35 top hat 35mm bracket snap terminal cabinet",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 63, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), width: 12, thickness: 3, hook: 2, clearance: 0.2, holes: 1, spacing: 20, screw: "M3", countersunk: true, operation: "new", targets: [] }),
  schema: [
    { key: "width", label: "Width", kind: "number", unit: "mm", min: 2, step: 1, hint: "Along the rail." },
    { key: "thickness", label: "Plate thickness", kind: "number", unit: "mm", min: 1, step: 0.5 },
    { key: "hook", label: "Hook thickness", kind: "number", unit: "mm", min: 0.8, step: 0.2 },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "Round the rail's lips." },
    { key: "holes", label: "Screw holes", kind: "number", unit: "none", min: 0, max: 2, step: 1 },
    { key: "spacing", label: "Hole spacing", kind: "number", unit: "mm", min: 1, step: 1, hint: "Across the rail.", visible: (p) => Number(p.holes) >= 2 },
    { key: "screw", label: "Screw", kind: "enum", options: fastenerOptions().slice(0, 6), visible: (p) => Number(p.holes) >= 1 },
    { key: "countersunk", label: "Countersunk", kind: "boolean", visible: (p) => Number(p.holes) >= 1 },
    ...whereFields({ angle: true, noun: "clip" }),
    ...resultFields,
  ],

  evaluate(ctx: EvalContext, p: DinClipParams) {
    const W = Number(p.width), t = Number(p.thickness), ht = Number(p.hook), c = Math.max(0, Number(p.clearance) || 0);
    if (!(W > 0) || !(t > 0) || !(ht > 0)) throw ctx.fail("The clip's width and thicknesses must be more than zero.");
    const holes = Math.round(Number(p.holes) || 0);
    const screw = fastenerOf(p.screw);
    if (holes > 0 && !screw) throw ctx.fail(`The size table has no ${p.screw}.`);
    // seen from the end of the rail: across the rail, and up from the plate.  The rail's lips lie on the plate.
    const a = RAIL / 2 + c, under = t + LIP + c, over = under + ht;
    const fixed = 2.5, latch = 1.1;   // how far each hook reaches in over its lip
    const outline: V2[] = [
      [-a - ht, 0], [a + ht, 0], [a + ht, over], [a - fixed, over], [a - fixed, under], [a, under], [a, t],
      [-a, t], [-a, under], [-a + latch, under], [-a + latch, under + 0.3], [-a - ht * 0.4, over], [-a - ht, over],
    ];
    apply(ctx, copies(ctx, spots(ctx, p), (frame, prefix) => {
      // the outline stands in the plane across the rail and is given the clip's width along it
      const side: Frame = { origin: add(frame.origin, scale(frame.y, -W / 2)), x: frame.x, y: frame.normal, normal: frame.y };
      let clip = extruded(ctx, side, poly(outline, "plate"), [], 0, W, prefix);
      if (holes > 0 && screw) {
        const xs = holes === 1 ? [0] : [-Number(p.spacing) / 2, Number(p.spacing) / 2];
        if (xs.some((x) => Math.abs(x) + screw.d > a)) throw ctx.fail("The screw holes do not fit between the hooks. Bring them closer together.");
        const tools = xs.map((x, i) => drill(ctx, frameAt(frame, [x, 0], t), p.countersunk
          ? { kind: "csink", diameter: screw.clearance[1], csinkDiameter: Math.min(screw.flatD + 0.4, screw.clearance[1] + 2 * (t - 0.3)), csinkAngle: 90, depth: t + 1 }
          : { diameter: screw.clearance[1], depth: t + 1 }, `${prefix}:h${i + 1}`));
        clip = cut(ctx, clip, together(ctx, tools));
      }
      return clip;
    }), p);
  },
});

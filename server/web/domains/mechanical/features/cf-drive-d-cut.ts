// cf-drive-d-cut.ts — D-cut: a flat on a shaft (a D shaft, for a set screw or a D-bore hub), or two opposite
// flats (a double D).  Pick the shaft's cylindrical face; the flat is given by how much is left across it (the
// shaft's diameter less the flat's depth: 4.5 on a 5 mm motor shaft) or by its depth, over a length from the
// end or the whole face.
//
// Names: `<id>:flat`, `<id>:flat2` (the opposite one), `<id>:shoulder` / `<id>:shoulder2` where a flat stops.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { polyLoop, prismOf, together } from "../kernel/ops/cf-drive";
import { cutFrom, DRIVES, num, positive, roundField, roundOf, SECTION } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DCutParams { [key: string]: any; face: GeomRef | null; by: "across" | "depth"; across: number; depth: number; double: boolean; length: number; flip: boolean; angle: number }

export default defineFeature<DCutParams>({
  type: "cf-d-cut",
  title: "D-cut",
  icon: '<path class="f" d="M6.5 5.5A8.5 8.5 0 1 1 6.5 18.5z"/><path d="M6.5 5.5A8.5 8.5 0 1 1 6.5 18.5z"/><path class="d" d="M6.5 5.5A8.5 8.5 0 0 0 6.5 18.5"/>',
  hint: "A flat on a shaft (D shaft), or two opposite flats",
  keywords: "d-shaft d shaft flat cut d-cut double d flatted shaft set screw flat motor shaft",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 42, toolbarKeep: 0,
  defaults: () => ({ face: null, by: "across", across: 4.5, depth: 0.5, double: false, length: 10, flip: false, angle: 0 }),
  schema: [
    roundField,
    { key: "by", label: "Flat by", kind: "enum", options: [{ value: "across", label: "Height across" }, { value: "depth", label: "Depth" }] },
    { key: "across", label: "Across the flat", kind: "number", unit: "mm", min: 0.01, step: 0.5, hint: "What is left of the diameter: from the flat to the far side (to the other flat for a double D).", visible: (p) => p.by !== "depth" },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.01, step: 0.1, visible: (p) => p.by === "depth" },
    { key: "double", label: "Both sides", kind: "boolean", hint: "A second flat opposite the first: a double D." },
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 0, step: 1, hint: "From the end of the face; 0 for its whole length." },
    { key: "flip", label: "From the other end", kind: "boolean", visible: (p) => Number(p.length) > 0 },
    { key: "angle", label: "Turned", kind: "number", unit: "deg", step: 15 },
  ],
  evaluate(ctx: EvalContext, p: DCutParams) {
    const id = ctx.feature.id;
    const on = roundOf(ctx, p.face, p.flip, p.angle), R = on.radius;
    if (on.bore) throw ctx.fail("That is the wall of a hole. Pick the outside of a shaft.");
    let depth: number;
    if (p.by === "depth") depth = positive(ctx, p.depth, "The depth");
    else {
      const across = positive(ctx, p.across, "The height across the flat");
      depth = p.double ? (2 * R - across) / 2 : 2 * R - across;
      if (!(depth > 1e-6)) throw ctx.fail(`The shaft is ${(2 * R).toFixed(2)} mm: the height across the flat must be less.`);
    }
    if (!(depth < (p.double ? R : 2 * R) - 1e-6)) throw ctx.fail("The flat would cut the shaft away.");
    const whole = !(num(p.length) > 0), length = whole ? on.length + 2 : num(p.length), z0 = -1, h = whole ? length : length + 1;
    const flat = (side: number, n: string): NamedResult => {
      const x0 = side * (R - depth), x1 = side * (R + 1);
      const loop = polyLoop([[x0, -R - 1], [x1, -R - 1], [x1, R + 1], [x0, R + 1]], (i) => ["s1", "s2", "s3", `flat${n}`][i]);
      const tool = prismOf(ctx, on.space, loop, [], z0, h, id);
      const names = tool.names;
      tool.names = (f, i) => { const s = names(f, i); return s === `${id}:top` ? `${id}:shoulder${n}` : s; };
      return tool;
    };
    cutFrom(ctx, on.body, p.double ? together(ctx, [flat(1, ""), flat(-1, "2")]) : flat(1, ""));
  },
});

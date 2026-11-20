// cf-fab-dovetail.ts — Dovetail joint: through dovetails between two boards that overlap at a corner.
//
// Model the two boards running through each other at the corner, each to the outside of the other.  The first
// board gets the tails, the second the pins (swap changes that).  Tails are spaced evenly with a half pin at
// each end of the joint; a tail widens toward the end of its board at the given slope, and a pin is as wide at
// its narrow end as asked.  Clearance opens the sockets in the pin board.
// Names: `<id>:tail<n>:left`, `:right` (the sloped cheeks), `:base`, `:tip` on both boards.
import { defineFeature } from "../core/feature";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { solidCentre } from "../kernel/ops/shapes";
import { box, changeAll, fresh, local, polyPrism, positive, shape, whole } from "../kernel/ops/cf-fab";
import { LASER, overlapOf, twoBodies } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DovetailParams { [key: string]: any; bodies: string[]; tails: number; angle: number; pin: number; clearance: number; swap: boolean }

export default defineFeature<DovetailParams>({
  type: "cf-fab-dovetail",
  title: "Dovetail joint",
  icon: '<path class="f" d="M2 5h9l2.5 2.5L11 10l2.5 2.5L11 15l2.5 2-2.5 2H2z"/><path d="M2 5h9l2.5 2.5L11 10l2.5 2.5L11 15l2.5 2-2.5 2H2z"/><path class="t" d="M11 5h11M11 19h11M13.5 7.5v5M13.5 17v-4.5"/>',
  hint: "Through dovetails between two boards at a corner: tails on one, pins on the other",
  keywords: "dovetail joint tails pins woodworking drawer corner through dovetail joinery",
  ...LASER, toolbarOrder: 42,
  defaults: () => ({ bodies: [], tails: 3, angle: 9.5, pin: 6, clearance: 0, swap: false }),
  schema: [
    { key: "bodies", label: "Boards", kind: "bodies", hint: "The two boards, overlapping at the corner. The first gets the tails." },
    { key: "tails", label: "Tails", kind: "number", unit: "none", min: 1, step: 1 },
    { key: "angle", label: "Slope", kind: "number", unit: "deg", min: 1, max: 30, step: 0.5, hint: "9.5° is 1:6, for softwood; 7.1° is 1:8, for hardwood." },
    { key: "pin", label: "Pin width", kind: "number", unit: "mm", min: 0.5, step: 0.5, hint: "At the narrow end of a pin." },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "Room between tails and pins." },
    { key: "swap", label: "Tails on the other board", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: DovetailParams) {
    const k = ctx.k, id = ctx.feature.id;
    const n = whole(ctx, p.tails, "number of tails", 1, 100), pin = positive(ctx, p.pin, "pin width");
    const angle = Number(p.angle);
    if (!(angle >= 1 && angle <= 30)) throw ctx.fail("The slope must be between 1° and 30°.");
    const c = Math.max(0, Number(p.clearance) || 0);
    let [a, b] = twoBodies(ctx, p.bodies, "boards");
    if (p.swap) [a, b] = [b, a];
    const ov = overlapOf(ctx, a, b);
    if (!ov) throw ctx.fail("The boards do not overlap. Model each running through the other at the corner, by the other's thickness.");
    if (ov.common) throw ctx.fail("The boards must meet at a right angle for dovetails.");
    // x along the joint, y along the tail board toward (or away from) its end, normal through the tail board
    const { frame, ext } = ov;
    const [s0, s1] = ext[0], [y0, y1] = ext[1], [w0, w1] = ext[2];
    const len = s1 - s0, depth = y1 - y0, pitch = len / n;
    // the tail board ends on the side of the overlap away from the rest of it
    const endUp = local(frame, solidCentre(k, a.shape))[1] < (y0 + y1) / 2;
    const wide = (pitch - pin) / 2, narrow = wide - depth * Math.tan((angle * Math.PI) / 180);
    if (!(narrow > 0.25)) throw ctx.fail(`${n} tails at ${angle}° with ${pin} mm pins leave no neck on a tail. Use fewer tails, a smaller slope or narrower pins.`);
    const tail = (i: number, grow: number): NamedResult => {
      const sc = s0 + pitch * (i + 0.5), hw = wide + grow, hn = narrow + grow;
      const yb = endUp ? y0 : y1, ye = endUp ? y1 : y0;   // baseline, and the end of the board
      const pts: [number, number][] = endUp ? [[sc - hn, yb], [sc + hn, yb], [sc + hw, ye], [sc - hw, ye]] : [[sc - hn, yb], [sc - hw, ye], [sc + hw, ye], [sc + hn, yb]];
      return polyPrism(ctx, frame, pts, w0, w1 - w0, `${id}:tail${i + 1}`, endUp ? ["base", "right", "tip", "left"] : ["left", "tip", "right", "base"]);
    };
    const idx = Array.from({ length: n }, (_, i) => i);
    // the tail board loses the overlap but for the tails; the pin board loses the tails (and the clearance round them)
    const waste = shape(ctx, "cut", box(ctx, frame, [s0 - 1, y0, w0], [s1 + 1, y1, w1], `${id}:pins`), idx.map((i) => tail(i, 0)));
    changeAll(ctx, a, "cut", [waste]);
    changeAll(ctx, fresh(ctx, b), "cut", idx.map((i) => tail(i, c)));
  },
});

// cf-fab-box-joint.ts — Box joint: a counted row of square fingers between two boards that overlap at a corner,
// as a table saw jig or a router cuts it.  The first board keeps the two outer fingers unless swapped.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { whole } from "../kernel/ops/cf-fab";
import { fingerJoint, LASER, twoBodies } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BoxJointParams { [key: string]: any; bodies: string[]; count: number; gap: number; swap: boolean }

export default defineFeature<BoxJointParams>({
  type: "cf-fab-box-joint",
  title: "Box joint",
  icon: '<path class="f" d="M3 5h9v2.8h3v2.8h-3v2.8h3v2.8h-3V19H3z"/><path d="M3 5h9v2.8h3v2.8h-3v2.8h3v2.8h-3V19H3z"/><path class="t" d="M12 5h3v2.8M15 10.6v2.8M15 16.2V19h-3M15 5h6M15 19h6"/>',
  hint: "A counted row of square fingers between two boards at a corner",
  keywords: "box joint finger joint comb joint woodworking corner boards pins",
  ...LASER, toolbarOrder: 12,
  defaults: () => ({ bodies: [], count: 7, gap: 0.1, swap: false }),
  schema: [
    { key: "bodies", label: "Boards", kind: "bodies", hint: "The two boards, overlapping at the corner by each other's thickness." },
    { key: "count", label: "Fingers", kind: "number", unit: "none", min: 3, step: 2, hint: "How many fingers along the joint, counting both boards. An odd number leaves the same board on both ends." },
    { key: "gap", label: "Glue gap", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "Room between the fingers for glue." },
    { key: "swap", label: "Other board on the ends", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: BoxJointParams) {
    const count = whole(ctx, p.count, "number of fingers", 2, 400);
    const gap = Number(p.gap) || 0;
    if (gap < 0 || gap > 5) throw ctx.fail("The glue gap must be between 0 and 5 mm.");
    const [a, b] = twoBodies(ctx, p.bodies, "boards");
    if (!fingerJoint(ctx, a, b, { width: 1, count, allow: gap, ends: p.swap ? "b" : "a" })) throw ctx.fail("The boards do not overlap. Model each running through the other at the corner, by the other's thickness.");
  },
});

// cf-fab-laser-joint.ts — Laser joint: finger joints wherever flat plates run through each other.
//
// Model the plates overlapping at their corners (each as long as the outside of the box); every pair that
// overlaps gets interlocking fingers along the overlap, as near the asked width as an odd count allows.  A plate
// that carries on past the joint (the side a tab goes through) keeps the ends, so its slots stay closed.
// Clearance loosens the fit; kerf tightens it by what the cutter burns away.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { scoped } from "../kernel/ops/combine";
import { bbox } from "../kernel/ops/shapes";
import { positive } from "../kernel/ops/cf-fab";
import { allowance, fingerJoint, fitFields, LASER } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface LaserJointParams { [key: string]: any; bodies: string[]; fingerWidth: number; clearance: number; kerf: number }

export default defineFeature<LaserJointParams>({
  type: "cf-fab-laser-joint",
  title: "Laser joint",
  icon: '<path class="f" d="M3 4h8v3h3v4h-3v3h3v4h-3v2H3z"/><path d="M3 4h8v3h3v4h-3v3h3v4h-3v2H3z"/><path class="t" d="M11 4h10v16H11M14 7v4M14 14v4"/>',
  hint: "Cut finger joints wherever flat plates overlap, with kerf",
  keywords: "laser joint finger joint tabs box joint interlocking plates kerf plywood acrylic cnc",
  ...LASER, toolbarOrder: 10,
  defaults: () => ({ bodies: [], fingerWidth: 10, clearance: 0, kerf: 0 }),
  schema: [
    { key: "bodies", label: "Plates", kind: "bodies", hint: "Leave empty for every body. The plates must overlap where they meet." },
    { key: "fingerWidth", label: "Finger width", kind: "number", unit: "mm", min: 0.5, step: 1 },
    ...fitFields(),
  ],

  evaluate(ctx: EvalContext, p: LaserJointParams) {
    const width = positive(ctx, p.fingerWidth, "finger width");
    const allow = allowance(ctx, p);
    const plates = scoped(ctx, p.bodies);
    if (plates.length < 2) throw ctx.fail("A joint needs two plates or more.");
    if (plates.length > 24) throw ctx.fail("That is too many plates at once (at most 24). Pick the ones to join.");
    const boxes = plates.map((b) => bbox(ctx.k, [b.shape])!);
    let joints = 0;
    for (let i = 0; i < plates.length; i++) for (let j = i + 1; j < plates.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a[0] > b[3] || b[0] > a[3] || a[1] > b[4] || b[1] > a[4] || a[2] > b[5] || b[2] > a[5]) continue;
      if (fingerJoint(ctx, plates[i], plates[j], { width, allow })) joints++;
    }
    if (!joints) throw ctx.fail("No two plates overlap. Model each plate running through the one it joins, by the thickness of the material.");
  },
});

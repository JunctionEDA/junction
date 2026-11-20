// composite-curve.ts — the Composite curve feature: picked edges, sketch curves and reference curves joined end
// to end into one curve, to sweep along or pattern along as one.  Curves that do not touch are an error (as in
// Onshape, a composite curve is one connected chain); a sketch curve brings the curves chained to it.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { pathWire } from "../kernel/ops/sweep-path";
import { setCurve } from "../kernel/ops/curves";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CompositeCurveParams { [key: string]: any; curves: RefTarget[] }

export default defineFeature<CompositeCurveParams>({
  type: "composite-curve",
  title: "Composite curve",
  hint: "Join edges and curves that meet end to end into one curve.",
  keywords: "join chain edges curves path wire combine",
  icon: '<path d="M3 18l5-9"/><path d="M8 9c3-5 7-5 9 0"/><path d="M17 9l4 8"/><circle class="s" cx="8" cy="9" r="1.8"/><circle class="s" cx="17" cy="9" r="1.8"/>',
  toolbarOrder: 64.4, toolbarSection: "reference", toolbarMenu: "Curve", toolbarKeep: 55,
  defaults: () => ({ curves: [] }),
  schema: [
    { key: "curves", label: "Edges and curves", kind: "refs", of: ["edge"], datums: ["curve"], sketch: true, hint: "They must join end to end, in any order." },
  ],

  evaluate(ctx: EvalContext, p: CompositeCurveParams) {
    const picks = Array.isArray(p.curves) ? p.curves : [];
    if (!picks.length) throw ctx.fail("Pick the edges and curves to join.");
    setCurve(ctx, [pathWire(ctx, picks)]);
  },
});

// cf-drive-stepped-shaft.ts — Stepped shaft: a shaft turned from a table of steps, each a diameter and a length,
// one after another along the axis: "20 x 30, 25 x 50, 20 x 30".  The ends can be chamfered, the shoulders
// between steps rounded (a fillet in the corner, where a real shaft has one against fatigue), and a hole can
// run through the middle.  The shaft stands on the plane, its axis along the normal.
//
// Names: `<id>:step<n>` (the cylindrical surface of step n), `<id>:shoulder<n>` (the flat between steps n and
// n + 1), `<id>:fillet<n>`, `<id>:start`, `<id>:end`, `<id>:chamfer:start`, `<id>:chamfer:end`, `<id>:bore`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { Pen, revolveLoop, type P2 } from "../kernel/ops/cf-drive";
import { DRIVES, finish, makeField, num, placedDefaults, placedFields, SECTION, spaceOf, type Placed } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SteppedShaftParams extends Placed { [key: string]: any; steps: string; chamfer: number; fillet: number; bore: number; operation: string }

/** "20 x 30, 25 x 50" as (diameter, length) pairs, or a message. */
export function parseSteps(text: string): { steps: [number, number][] } | { error: string } {
  const steps: [number, number][] = [];
  for (const part of String(text || "").split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^(?:[ØøD⌀]\s*)?(\d+(?:\.\d+)?)\s*[x×*\s]\s*(\d+(?:\.\d+)?)$/i.exec(part);
    if (!m) return { error: `"${part}" is not a diameter and a length. Write steps like 20 x 30, 25 x 50.` };
    const d = Number(m[1]), l = Number(m[2]);
    if (!(d > 0 && l > 0)) return { error: `In "${part}" the diameter and the length must be more than zero.` };
    steps.push([d, l]);
  }
  if (!steps.length) return { error: "Give the steps as diameter x length, one after another: 20 x 30, 25 x 50." };
  if (steps.length > 60) return { error: "That is more than 60 steps." };
  return { steps };
}

export default defineFeature<SteppedShaftParams>({
  type: "cf-stepped-shaft",
  title: "Stepped shaft",
  icon: '<path class="f" d="M2 9.5h5V7h7V4.5h4V7h4v10h-4v2.5h-4V17H7v-2.5H2z"/><path d="M2 9.5h5V7h7V4.5h4V7h4v10h-4v2.5h-4V17H7v-2.5H2zM7 9.5v5M14 7v10M18 7v10"/><path class="d" d="M.5 12h23"/>',
  hint: "A shaft from a table of steps: diameter x length, one after another",
  keywords: "shaft stepped shaft steps shoulders axle spindle turned table diameter length journal",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 41, toolbarKeep: 0,
  defaults: () => ({ steps: "20 x 30, 25 x 50, 35 x 8, 25 x 40, 20 x 30", chamfer: 1, fillet: 0.5, bore: 0, ...placedDefaults(), operation: "new" }),
  schema: [
    { key: "steps", label: "Steps", kind: "text", hint: "Diameter x length of each step, in order along the axis, in millimetres: 20 x 30, 25 x 50, 20 x 30." },
    { key: "chamfer", label: "End chamfer", kind: "number", unit: "mm", min: 0, step: 0.5 },
    { key: "fillet", label: "Shoulder fillet", kind: "number", unit: "mm", min: 0, step: 0.25, hint: "Rounds the inside corner of each shoulder." },
    { key: "bore", label: "Hole through", kind: "number", unit: "mm", min: 0, step: 1, hint: "0 for a solid shaft." },
    ...placedFields, makeField,
  ],
  evaluate(ctx: EvalContext, p: SteppedShaftParams) {
    const id = ctx.feature.id;
    const t = parseSteps(p.steps);
    if ("error" in t) throw ctx.fail(t.error);
    const steps = t.steps, n = steps.length, rb = Math.max(0, num(p.bore)) / 2;
    const least = Math.min(...steps.map((s) => s[0] / 2));
    if (rb >= least - 0.1) throw ctx.fail(`The hole through (${2 * rb} mm) does not fit in the thinnest step (${2 * least} mm).`);
    const cham = Math.max(0, num(p.chamfer)), fil = Math.max(0, num(p.fillet));
    if (cham > 0 && (cham >= steps[0][0] / 2 - rb || cham >= steps[n - 1][0] / 2 - rb || cham >= steps[0][1] || cham >= steps[n - 1][1])) throw ctx.fail("The end chamfer is larger than an end step. Use a smaller one.");
    // the section in (radius, height), from the axis at the start, up the outside, back down the axis (or the hole)
    const pen = new Pen([rb, 0]);
    let z = 0;
    const r0 = steps[0][0] / 2;
    if (cham > 0) pen.line([r0 - cham, 0], "start").line([r0, cham], "chamfer:start"); else pen.line([r0, 0], "start");
    steps.forEach(([d, l], i) => {
      const r = d / 2, next = steps[i + 1], top = z + l;
      if (!next) {
        if (cham > 0) pen.line([r, top - cham], `step${i + 1}`).line([r - cham, top], "chamfer:end"); else pen.line([r, top], `step${i + 1}`);
        pen.line([rb, top], "end");
      } else {
        const rn = next[0] / 2, step = Math.abs(rn - r);
        // the fillet sits in the inside corner, on the thinner step's side; it may take at most the shoulder's height and a third of that step
        const q = step > 1e-9 ? Math.min(fil, step * 0.95, (rn > r ? l : next[1]) / 3) : 0;
        if (q > 1e-6 && rn > r) { const c: P2 = [r + q, top - q]; pen.line([r, top - q], `step${i + 1}`).arcAbout(c, [r + q, top], `fillet${i + 1}`).line([rn, top], `shoulder${i + 1}`); }
        else if (q > 1e-6) { const c: P2 = [rn + q, top + q]; pen.line([r, top], `step${i + 1}`).line([rn + q, top], `shoulder${i + 1}`).arcAbout(c, [rn, top + q], `fillet${i + 1}`); }
        else { pen.line([r, top], `step${i + 1}`); if (step > 1e-9) pen.line([rn, top], `shoulder${i + 1}`); }
      }
      z = top;
    });
    finish(ctx, [revolveLoop(ctx, spaceOf(ctx, p), pen.close("bore"), id)], p.operation);
  },
});

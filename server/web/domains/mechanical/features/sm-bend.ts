// sm-bend.ts — Bend: bend a flat sheet metal wall along a sketch line drawn across it.  The wall becomes two
// walls joined by a bend centred on the line; the larger side (or the side chosen) stays where it is.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { commit, minv, mpt, placements } from "../kernel/ops/sheetmetal";
import { bendAlong } from "../kernel/ops/sheetmetal-ops";
import type { RefTarget } from "./_refs";
import { bendFields, kOf, pickedLines, radiusOf, SM_SECTION, wallAtPoint } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BendParams { [key: string]: any; line: RefTarget[]; angle: number; flip: boolean; fixed: "larger" | "left" | "right"; useModelRadius: boolean; radius: number; useModelK: boolean; kFactor: number }

export default defineFeature<BendParams>({
  type: "sm-bend",
  title: "Bend",
  icon: '<path d="M3 18h9a6 6 0 0 0 6-6V4"/><path class="t" d="M12 21V15"/>',
  hint: "Bend a sheet metal wall along a sketch line",
  keywords: "bend line fold sheet metal angle",
  toolbarSection: SM_SECTION, toolbarOrder: 24, toolbarKeep: 48,
  defaults: () => ({ line: [], angle: 90, flip: false, fixed: "larger", useModelRadius: true, radius: 1, useModelK: true, kFactor: 0.45 }),
  schema: [
    { key: "line", label: "Bend line", kind: "refs", of: ["edge"], sketch: true, single: false, hint: "A sketch line across a wall, on one of its faces." },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", min: 0.5, max: 180, step: 5 },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
    { key: "fixed", label: "Fixed side", kind: "enum", options: [{ value: "larger", label: "The larger side" }, { value: "left", label: "Left of the line" }, { value: "right", label: "Right of the line" }] },
    ...bendFields,
  ],

  evaluate(ctx: EvalContext, p: BendParams) {
    const lines = pickedLines(ctx, p.line);
    if (lines.length !== 1) throw ctx.fail("Pick one sketch line across a wall.");
    const [a, b] = lines[0];
    const hit = wallAtPoint(ctx, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    const m = hit.model, W = minv(placements(m).mat.get(hit.wall.id)!);
    const u = mpt(W, a), v = mpt(W, b);
    const sign = (hit.top ? 1 : -1) * (p.flip ? -1 : 1);
    const angle = sign * Math.max(0.5, Math.min(180, p.angle || 90));
    commit(ctx, bendAlong(ctx.k, m, hit.wall.id, [u[0], u[1]], [v[0], v[1]], angle, radiusOf(m, p), kOf(m, p), p.fixed === "left" ? true : p.fixed === "right" ? false : null, ctx.feature.id, ctx.own));
  },
});

// sm-hem.ts — Hem: fold an edge of a sheet metal wall back on itself.  Straight: a 180° bend whose inside
// radius leaves `gap` between the sheets, and a wall `length` long.  Rolled: a curl of `angle` degrees with no
// wall after it.  Tear drop: a bend past 180° and a wall that leans back towards the sheet.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { commit, type SMModel } from "../kernel/ops/sheetmetal";
import { flange } from "../kernel/ops/sheetmetal-ops";
import { autoCorners, sideOfPick, SM_SECTION, wallPicks } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HemParams {
  [key: string]: any;
  edges: GeomRef[]; hemType: "straight" | "rolled" | "teardrop"; alignment: "inner" | "outer";
  length: number; gap: number; radius: number; angle: number; flip: boolean;
}

export default defineFeature<HemParams>({
  type: "sm-hem",
  title: "Hem",
  icon: '<path class="f" d="M3 17h13a3 3 0 0 0 0-6H8v2h8a1 1 0 0 1 0 2H3z"/><path d="M3 17h13a3 3 0 0 0 0-6H8v2h8a1 1 0 0 1 0 2H3"/>',
  hint: "Fold an edge of a sheet metal part back on itself: straight, rolled or tear drop",
  keywords: "hem fold back roll curl tear drop edge sheet metal",
  toolbarSection: SM_SECTION, toolbarOrder: 21, toolbarKeep: 52,
  defaults: () => ({ edges: [], hemType: "straight", alignment: "inner", length: 6, gap: 0.5, radius: 2, angle: 270, flip: false }),
  schema: [
    { key: "edges", label: "Edges", kind: "refs", of: ["edge", "face"] },
    { key: "hemType", label: "Hem type", kind: "enum", options: [{ value: "straight", label: "Straight" }, { value: "rolled", label: "Rolled" }, { value: "teardrop", label: "Tear drop" }] },
    { key: "alignment", label: "Alignment", kind: "enum", options: [{ value: "inner", label: "Inner (keep the edge)" }, { value: "outer", label: "Outer (add to the edge)" }] },
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 0.01, step: 1, visible: (p) => p.hemType !== "rolled" },
    { key: "gap", label: "Gap", kind: "number", unit: "mm", min: 0.01, step: 0.1, visible: (p) => p.hemType !== "rolled" },
    { key: "radius", label: "Radius", kind: "number", unit: "mm", min: 0.01, step: 0.5, visible: (p) => p.hemType !== "straight" },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", min: 180, max: 270, step: 5, visible: (p) => p.hemType === "rolled" },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: HemParams) {
    const { model, picks } = wallPicks(ctx, p.edges, "Pick the edges to hem.");
    let m: SMModel = model;
    const walls = new Set<string>();
    for (const pick of picks) {
      if (!pick.edge) throw ctx.fail("Pick edges of walls to hem.");
      const side = sideOfPick(ctx, m, pick);
      const sign = (pick.top ? 1 : -1) * (p.flip ? -1 : 1);
      const type = p.hemType || "straight";
      if (type !== "rolled" && !(p.gap > 0)) throw ctx.fail("The gap must be more than zero.");
      const radius = type === "straight" ? p.gap / 2 : p.radius;
      const angle = type === "straight" ? 180 : type === "rolled" ? Math.max(180, Math.min(270, p.angle || 270)) : 180 + (180 / Math.PI) * Math.atan2(Math.max(0, p.radius * 2 - p.gap), Math.max(p.length, 0.01));
      m = flange(ctx.k, m, side, {
        angle: sign * angle, radius, k: m.k, alignment: p.alignment === "outer" ? "none" : "outer",
        length: type === "rolled" ? 0 : p.length, flat: true, start: 0, end: 0, bendOnly: type === "rolled",
      }, ctx.feature.id, ctx.own);
      walls.add(side.wall);
    }
    commit(ctx, autoCorners(ctx, m, Array.from(walls)));
  },
});

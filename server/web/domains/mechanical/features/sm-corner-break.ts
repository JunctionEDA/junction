// sm-corner-break.ts — Corner break: round or bevel a corner of a sheet metal wall's outline, so the break is
// part of the definition and shows in the flat pattern.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { commit } from "../kernel/ops/sheetmetal";
import { cornerBreak } from "../kernel/ops/sheetmetal-ops";
import { SM_SECTION, wallPicks } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CornerBreakParams { [key: string]: any; corners: GeomRef[]; breakType: "fillet" | "chamfer"; size: number }

export default defineFeature<CornerBreakParams>({
  type: "sm-corner-break",
  title: "Corner break",
  icon: '<path class="f" d="M4 20V4h9a7 7 0 0 1 7 7v9z"/><path d="M4 20V4h9a7 7 0 0 1 7 7v9z"/>',
  hint: "Round or bevel a corner of a sheet metal wall",
  keywords: "corner break fillet chamfer round bevel sheet metal",
  toolbarSection: SM_SECTION, toolbarOrder: 42, toolbarMenu: "Corner", toolbarKeep: 40,
  defaults: () => ({ corners: [], breakType: "fillet", size: 5 }),
  schema: [
    { key: "corners", label: "Corners", kind: "refs", of: ["vertex", "edge"], hint: "Corners of walls, or the short edges through the thickness there." },
    { key: "breakType", label: "Type", kind: "enum", options: [{ value: "fillet", label: "Fillet" }, { value: "chamfer", label: "Chamfer" }] },
    { key: "size", label: "Size", kind: "number", unit: "mm", min: 0.01, step: 0.5 },
  ],

  evaluate(ctx: EvalContext, p: CornerBreakParams) {
    const { model, picks } = wallPicks(ctx, p.corners, "Pick the corners to break.");
    let m = model;
    for (const pick of picks) m = cornerBreak(ctx.k, m, pick.wall, pick.at, p.breakType === "chamfer" ? "chamfer" : "fillet", p.size, ctx.own);
    commit(ctx, m);
  },
});

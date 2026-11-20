// sm-corner.ts — Corner: relieve the corner of a sheet metal wall where two of its bends meet: a square or a
// round hole there, or the two flanges grown to close the corner up to the minimal gap.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { commit } from "../kernel/ops/sheetmetal";
import { corner } from "../kernel/ops/sheetmetal-ops";
import { SM_SECTION, wallPicks } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CornerParams { [key: string]: any; corners: GeomRef[]; cornerType: "rectangle" | "round" | "closed"; useModel: boolean; scale: number }

export default defineFeature<CornerParams>({
  type: "sm-corner",
  title: "Corner",
  icon: '<path class="f" d="M4 4h16v16H4z"/><path d="M4 4h16v16H4z"/><path class="t" d="M14 20v-6h6"/>',
  hint: "Change how a sheet metal corner where two flanges meet is relieved or closed",
  keywords: "corner relief closed round rectangle sheet metal",
  toolbarSection: SM_SECTION, toolbarOrder: 40, toolbarMenu: "Corner", toolbarKeep: 44,
  defaults: () => ({ corners: [], cornerType: "rectangle", useModel: false, scale: 1.5 }),
  schema: [
    { key: "corners", label: "Corners", kind: "refs", of: ["vertex", "edge"], hint: "A corner of the wall where its flanges meet." },
    { key: "cornerType", label: "Corner type", kind: "enum", options: [{ value: "rectangle", label: "Rectangle" }, { value: "round", label: "Round" }, { value: "closed", label: "Closed" }] },
    { key: "scale", label: "Relief scale", kind: "number", unit: "none", min: 0.1, step: 0.1, hint: "× (bend radius + thickness).", visible: (p) => p.cornerType !== "closed" },
  ],

  evaluate(ctx: EvalContext, p: CornerParams) {
    const { model, picks } = wallPicks(ctx, p.corners, "Pick the corners to relieve.");
    let m = model;
    for (const pick of picks) m = corner(ctx.k, m, pick.wall, pick.at, p.cornerType || "rectangle", (p.scale || 1.5) * (m.radius + m.thickness), ctx.own);
    commit(ctx, m);
  },
});

// sm-bend-relief.ts — Bend relief: the relief beside the end of a bend, where the bend stops short of the
// wall's edge: a rectangle or an obround cut, or a tear (no cut: the sheet tears there).
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { commit } from "../kernel/ops/sheetmetal";
import { reliefCut } from "../kernel/ops/sheetmetal-ops";
import { SM_SECTION, wallPicks } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BendReliefParams { [key: string]: any; ends: GeomRef[]; reliefType: "rectangle" | "obround" | "tear"; width: number; depth: number }

export default defineFeature<BendReliefParams>({
  type: "sm-bend-relief",
  title: "Bend relief",
  icon: '<path d="M3 18h18M3 14h7v-4h4v4h7"/><path class="t" d="M10 10v4M14 10v4"/>',
  hint: "Change the relief cut beside the end of a sheet metal bend",
  keywords: "bend relief obround rectangle tear sheet metal",
  toolbarSection: SM_SECTION, toolbarOrder: 41, toolbarMenu: "Corner", toolbarKeep: 40,
  defaults: () => ({ ends: [], reliefType: "obround", width: 1, depth: 1.5 }),
  schema: [
    { key: "ends", label: "Bend ends", kind: "refs", of: ["vertex", "edge"], hint: "A corner of the wall beside the end of a bend." },
    { key: "reliefType", label: "Relief type", kind: "enum", options: [{ value: "rectangle", label: "Rectangle" }, { value: "obround", label: "Obround" }, { value: "tear", label: "Tear" }] },
    { key: "width", label: "Width scale", kind: "number", unit: "none", min: 0.01, step: 0.1, hint: "× the thickness.", visible: (p) => p.reliefType !== "tear" },
    { key: "depth", label: "Depth scale", kind: "number", unit: "none", min: 0.01, step: 0.1, hint: "× the thickness, past the bend.", visible: (p) => p.reliefType !== "tear" },
  ],

  evaluate(ctx: EvalContext, p: BendReliefParams) {
    const { model, picks } = wallPicks(ctx, p.ends, "Pick a corner beside the end of a bend.");
    let m = model;
    for (const pick of picks) {
      let best: { id: string; end: 0 | 1; gap: number } | null = null;
      for (const b of m.bends) {
        if (b.a.wall !== pick.wall) continue;
        for (const end of [0, 1] as const) {
          const q = end ? b.a.p1 : b.a.p0, gap = Math.hypot(q[0] - pick.at[0], q[1] - pick.at[1]);
          if (gap < 3 * (b.radius + m.thickness) + 0.01 && (!best || gap < best.gap)) best = { id: b.id, end, gap };
        }
      }
      if (!best) throw ctx.fail("No bend ends near that corner.");
      const t = m.thickness;
      m = reliefCut(ctx.k, m, m.bends.find((b) => b.id === best!.id)!, best.end, p.reliefType || "obround", (p.width || 1) * t, (p.depth || 1.5) * t + m.bends.find((b) => b.id === best!.id)!.radius + t, ctx.own);
    }
    commit(ctx, m);
  },
});

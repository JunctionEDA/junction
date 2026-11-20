// sm-joint.ts — Make joint: join two walls of a sheet metal part that meet along an edge, with a bend or a rip.
// Pick the edges of the two walls that run beside each other (or one, and the wall beside it is found).
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { commit, straightEdges, type Side } from "../kernel/ops/sheetmetal";
import { joinBend, ripTrim, touching } from "../kernel/ops/sheetmetal-ops";
import { bendFields, kOf, radiusOf, sideOfPick, SM_SECTION, wallPicks } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface JointParams { [key: string]: any; edges: GeomRef[]; jointType: "bend" | "rip"; useModelRadius: boolean; radius: number; useModelK: boolean; kFactor: number }

export default defineFeature<JointParams>({
  type: "sm-joint",
  title: "Make joint",
  icon: '<path class="f" d="M4 19V8h3v8h10v3z"/><path d="M4 19V8h3v8M7 16h10v3H4"/><path class="t" d="M7 16a3 3 0 0 0 0 0"/>',
  hint: "Join two sheet metal walls that meet with a bend or a rip",
  keywords: "make joint bend rip join walls sheet metal",
  toolbarSection: SM_SECTION, toolbarOrder: 30, toolbarMenu: "Make joint", toolbarKeep: 46,
  defaults: () => ({ edges: [], jointType: "bend", useModelRadius: true, radius: 1, useModelK: true, kFactor: 0.45 }),
  schema: [
    { key: "edges", label: "Edges", kind: "refs", of: ["edge", "face"], hint: "The edges of the two walls where they meet." },
    { key: "jointType", label: "Joint", kind: "enum", options: [{ value: "bend", label: "Bend" }, { value: "rip", label: "Rip" }] },
    ...bendFields.map((f) => ({ ...f, visible: (p: any) => p.jointType !== "rip" && (!f.visible || f.visible(p)) })),
  ],

  evaluate(ctx: EvalContext, p: JointParams) {
    const { model, picks } = wallPicks(ctx, p.edges, "Pick the edges where two walls meet.");
    if (picks.some((x) => !x.edge)) throw ctx.fail("Pick edges of walls.");
    const sa = sideOfPick(ctx, model, picks[0]);
    let sb: Side | null = picks[1] ? sideOfPick(ctx, model, picks[1]) : null;
    if (!sb) {
      for (const w of model.walls) {
        if (w.id === sa.wall) continue;
        for (const [a, b] of straightEdges(ctx.k, w.face)) for (const s of [{ wall: w.id, p0: a, p1: b }, { wall: w.id, p0: b, p1: a }]) if (!sb && touching(ctx.k, model, sa, s)) sb = s;
      }
    }
    if (!sb) throw ctx.fail("No other wall meets that edge. Pick the edges of both walls.");
    const m = p.jointType === "rip" ? ripTrim(ctx.k, model, sa, sb, model.gap, ctx.own) : joinBend(ctx.k, model, sa, sb, radiusOf(model, p), kOf(model, p), ctx.feature.id, ctx.own);
    commit(ctx, m);
  },
});

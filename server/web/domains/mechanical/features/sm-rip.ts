// sm-rip.ts — Rip: cut a sheet metal wall in two along a sketch line drawn on it (the halves stay where they
// are, `gap` apart), or turn bends into rips (the walls are closed up to the model's minimal gap).
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { commit, minv, mpt, placements, type SMModel } from "../kernel/ops/sheetmetal";
import { modifyJoint, ripAlong } from "../kernel/ops/sheetmetal-ops";
import type { RefTarget } from "./_refs";
import { bendPicks, pickedLines, SM_SECTION, wallAtPoint } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RipParams { [key: string]: any; method: "line" | "joint"; lines: RefTarget[]; bends: GeomRef[]; gap: number; useModelGap: boolean }

export default defineFeature<RipParams>({
  type: "sm-rip",
  title: "Rip",
  icon: '<path d="M3 20V4h18v16z"/><path class="t" d="M12 4v16"/>',
  hint: "Cut a sheet metal wall apart along a sketch line, or turn a bend into a rip",
  keywords: "rip split cut tear gap sheet metal",
  toolbarSection: SM_SECTION, toolbarOrder: 32, toolbarMenu: "Make joint", toolbarKeep: 40,
  defaults: () => ({ method: "line", lines: [], bends: [], useModelGap: true, gap: 0.2 }),
  schema: [
    { key: "method", label: "Rip", kind: "enum", options: [{ value: "line", label: "Along a sketch line" }, { value: "joint", label: "A bend" }] },
    { key: "lines", label: "Lines", kind: "refs", of: ["edge"], sketch: true, hint: "Sketch lines across a wall, on one of its faces.", visible: (p) => p.method !== "joint" },
    { key: "bends", label: "Bends", kind: "refs", of: ["face"], hint: "The curved faces of bends.", visible: (p) => p.method === "joint" },
    { key: "useModelGap", label: "Use model minimal gap", kind: "boolean", visible: (p) => p.method !== "joint" },
    { key: "gap", label: "Gap", kind: "number", unit: "mm", min: 0.01, step: 0.1, visible: (p) => p.method !== "joint" && p.useModelGap === false },
  ],

  evaluate(ctx: EvalContext, p: RipParams) {
    if (p.method === "joint") {
      let { model: m, bends } = bendPicks(ctx, p.bends);
      for (const b of bends) m = modifyJoint(ctx.k, m, b.id, { type: "rip", close: true }, ctx.own);
      commit(ctx, m);
      return;
    }
    const lines = pickedLines(ctx, p.lines);
    if (!lines.length) throw ctx.fail("Pick a sketch line across a wall.");
    const changed = new Map<string, SMModel>();
    for (const [a, b] of lines) {
      const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const hit = wallAtPoint(ctx, mid, changed.size ? [...changed.values()] : undefined);
      const m = changed.get(hit.model.id) || hit.model, W = minv(placements(m).mat.get(hit.wall.id)!);
      const u = mpt(W, a), v = mpt(W, b);
      changed.set(m.id, ripAlong(ctx.k, m, hit.wall.id, [u[0], u[1]], [v[0], v[1]], p.useModelGap === false ? p.gap : m.gap, ctx.feature.id + `.r${changed.size}`, ctx.own));
    }
    for (const m of changed.values()) commit(ctx, m);
  },
});

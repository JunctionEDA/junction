// cf-fab-dowel.ts — Dowel and biscuit joint: the matching pair of holes (or slots) in the two boards that meet
// at a face.
//
// Pick the face of one board where it stands against the other.  Dowels: round holes spaced evenly along the
// face, drilled into both boards, each to its own depth.  Biscuits: the arc-bottomed slot a 100 mm plate
// joiner blade cuts, in both boards, deep enough for half a biscuit of the size picked (#0, #10 or #20: 47,
// 53 and 56 mm long, 4 mm thick) and a little glue.
// Names: `<id>:d<n>:wall`, `:start`, `:end` (dowel holes: start is the bottom in the picked board);
// `<id>:b<n>a:…` and `<id>:b<n>b:…` (a biscuit's slot in the picked board and in the other).
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { at, changeAll, cylinder, edgeFace, frameAt, fresh, positive, whole } from "../kernel/ops/cf-fab";
import { LASER, others, pickedFace } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Biscuit size → the depth of its slot in each board (half the biscuit's width and a little for glue). */
export const BISCUITS: { [size: string]: number } = { "0": 8, "10": 10, "20": 12 };
const BLADE_RADIUS = 50, BLADE_THICKNESS = 4;

export interface DowelParams { [key: string]: any; face: GeomRef | null; kind: "dowel" | "biscuit"; count: number; diameter: number; depthA: number; depthB: number; clearance: number; biscuit: string; targets: string[] }

export default defineFeature<DowelParams>({
  type: "cf-fab-dowel",
  title: "Dowel / biscuit holes",
  icon: '<path class="f" d="M2 6h9v12H2zM13 6h9v12h-9z"/><path d="M2 6h9v12H2zM13 6h9v12h-9z"/><rect class="s" x="8" y="8" width="8" height="2.2" rx="1.1"/><rect class="s" x="8" y="13.8" width="8" height="2.2" rx="1.1"/>',
  hint: "Matching dowel holes or biscuit slots in the two boards that meet at a face",
  keywords: "dowel dowels biscuit plate joiner holes pair woodworking pegs alignment joint",
  ...LASER, toolbarOrder: 44,
  defaults: () => ({ face: null, kind: "dowel", count: 2, diameter: 8, depthA: 15, depthB: 15, clearance: 0, biscuit: "20", targets: [] }),
  schema: [
    { key: "face", label: "Joint face", kind: "refs", of: ["face"], single: true, hint: "The face of one board where it stands against the other." },
    { key: "kind", label: "For", kind: "enum", options: [{ value: "dowel", label: "Dowels" }, { value: "biscuit", label: "Biscuits" }] },
    { key: "count", label: "Count", kind: "number", unit: "none", min: 1, step: 1 },
    { key: "diameter", label: "Dowel diameter", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => p.kind !== "biscuit" },
    { key: "depthA", label: "Depth in this board", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => p.kind !== "biscuit" },
    { key: "depthB", label: "Depth in the other", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => p.kind !== "biscuit" },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "Added to the hole's diameter.", visible: (p) => p.kind !== "biscuit" },
    { key: "biscuit", label: "Biscuit", kind: "enum", options: [{ value: "0", label: "#0" }, { value: "10", label: "#10" }, { value: "20", label: "#20" }], visible: (p) => p.kind === "biscuit" },
    { key: "targets", label: "Other boards", kind: "bodies", hint: "Leave empty for every other body the holes reach." },
  ],

  evaluate(ctx: EvalContext, p: DowelParams) {
    const f = pickedFace(ctx, p.face, "the face of one board where it stands against the other");
    const count = whole(ctx, p.count, "count", 1, 200);
    const ef = edgeFace(ctx, f.shape);
    const id = ctx.feature.id, pitch = ef.long / count;
    const xs = Array.from({ length: count }, (_, i) => -ef.long / 2 + pitch * (i + 0.5));
    if (p.kind === "biscuit") {
      const depth = BISCUITS[p.biscuit];
      if (!depth) throw ctx.fail(`There is no biscuit size #${p.biscuit}. Pick #0, #10 or #20.`);
      const slot = 2 * Math.sqrt(BLADE_RADIUS * BLADE_RADIUS - (BLADE_RADIUS - depth) ** 2);
      if (slot + 6 > pitch) throw ctx.fail(`${count} #${p.biscuit} biscuits need ${Math.round((slot + 6) * count)} mm of joint; this one is ${Math.round(ef.long)} mm. Use fewer or smaller biscuits.`);
      if (BLADE_THICKNESS + 4 > ef.short) throw ctx.fail("The board is too thin for a biscuit.");
      // the blade's disc lies in the board's mid-plane and plunges across the joint face
      const disc = (x: number, side: 1 | -1, key: string) => cylinder(ctx, frameAt(at(ef.frame, x, -BLADE_THICKNESS / 2, side * (BLADE_RADIUS - depth)), ef.frame.x, ef.frame.y), [0, 0], BLADE_RADIUS, 0, BLADE_THICKNESS, key);
      for (const body of others(ctx, f.body, p.targets)) changeAll(ctx, body, "cut", xs.map((x, i) => disc(x, -1, `${id}:b${i + 1}b`)));
      changeAll(ctx, fresh(ctx, f.body), "cut", xs.map((x, i) => disc(x, 1, `${id}:b${i + 1}a`)));
      return;
    }
    const d = positive(ctx, p.diameter, "dowel diameter") + Math.max(0, Number(p.clearance) || 0), da = positive(ctx, p.depthA, "depth in this board"), db = positive(ctx, p.depthB, "depth in the other board");
    if (d + 2 > ef.short) throw ctx.fail(`A ${p.diameter} mm dowel is too thick for a board ${Math.round(ef.short * 10) / 10} mm thick.`);
    if (d + 2 > pitch) throw ctx.fail("The dowels do not fit along the joint. Use fewer.");
    const holes = xs.map((x, i) => cylinder(ctx, ef.frame, [x, 0], d / 2, -da, da + db, `${id}:d${i + 1}`));
    for (const body of [f.body, ...others(ctx, f.body, p.targets)]) changeAll(ctx, fresh(ctx, body), "cut", holes);
  },
});

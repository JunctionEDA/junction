// sm-flange.ts — Flange: a bend and a new wall on edges of a sheet metal wall.  The flange's length is measured
// from the outside corner (or as the flat wall), its bend lines up with the edge on the outside, the inside or
// the middle of the sheet, and it may be kept back from the edge's ends (which are then relieved).  Where two
// flanges of one wall meet at a corner, the corner gets the model's corner relief.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { commit, type SMModel } from "../kernel/ops/sheetmetal";
import { flange } from "../kernel/ops/sheetmetal-ops";
import { autoCorners, bendFields, kOf, radiusOf, sideOfPick, SM_SECTION, wallPicks } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FlangeParams {
  [key: string]: any;
  edges: GeomRef[]; alignment: "outer" | "inner" | "middle" | "none";
  length: number; measure: "outside" | "flat"; angle: number; flip: boolean;
  offset: boolean; start: number; end: number;
  useModelRadius: boolean; radius: number; useModelK: boolean; kFactor: number;
}

export const ALIGN_OPTIONS = [
  { value: "outer", label: "Outer" }, { value: "inner", label: "Inner" }, { value: "middle", label: "Middle" }, { value: "none", label: "Bend outside" },
];

export default defineFeature<FlangeParams>({
  type: "sm-flange",
  title: "Flange",
  icon: '<path class="f" d="M3 19l5-3h11l-5 3z"/><path d="M3 19l5-3h11l-5 3zM14 19V8l5-3v11"/><path class="t" d="M14 8h-0"/>',
  hint: "Add a bend and a wall on edges of a sheet metal part",
  keywords: "flange sheet metal wall edge bend",
  toolbarSection: SM_SECTION, toolbarOrder: 20, toolbarKeep: 68,
  defaults: () => ({ edges: [], alignment: "outer", length: 20, measure: "outside", angle: 90, flip: false, offset: false, start: 0, end: 0, useModelRadius: true, radius: 1, useModelK: true, kFactor: 0.45 }),
  schema: [
    { key: "edges", label: "Edges", kind: "refs", of: ["edge", "face"], hint: "Edges of walls, or their edge faces." },
    { key: "alignment", label: "Alignment", kind: "enum", options: ALIGN_OPTIONS, hint: "Where the flange's outside lies against the picked edge." },
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 0.01, step: 1 },
    { key: "measure", label: "Measured", kind: "enum", options: [{ value: "outside", label: "To the outside corner" }, { value: "flat", label: "Flat wall only" }] },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", min: 0.5, max: 180, step: 5 },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
    { key: "offset", label: "Offset ends", kind: "boolean", hint: "Keep the flange back from the edge's ends." },
    { key: "start", label: "Start offset", kind: "number", unit: "mm", min: 0, step: 1, visible: (p) => !!p.offset },
    { key: "end", label: "End offset", kind: "number", unit: "mm", min: 0, step: 1, visible: (p) => !!p.offset },
    ...bendFields,
  ],

  evaluate(ctx: EvalContext, p: FlangeParams) {
    const { model, picks } = wallPicks(ctx, p.edges, "Pick the edges to flange.");
    let m: SMModel = model;
    const walls = new Set<string>();
    for (const pick of picks) {
      if (!pick.edge) throw ctx.fail("Pick edges of walls (or their thin edge faces), not their flat faces.");
      const side = sideOfPick(ctx, m, pick);
      // the bend goes towards the face the edge was picked on
      const sign = (pick.top ? 1 : -1) * (p.flip ? -1 : 1);
      m = flange(ctx.k, m, side, {
        angle: sign * Math.min(180, Math.max(0.5, p.angle || 90)), radius: radiusOf(m, p), k: kOf(m, p), alignment: p.alignment || "outer",
        length: p.length, flat: p.measure === "flat", start: p.offset ? p.start || 0 : 0, end: p.offset ? p.end || 0 : 0,
      }, ctx.feature.id, ctx.own);
      walls.add(side.wall);
    }
    commit(ctx, autoCorners(ctx, m, Array.from(walls)));
  },
});

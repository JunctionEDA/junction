// wrap.ts — the Wrap feature: lay the regions of a flat sketch round a cylindrical face, raised from it
// (emboss), sunk into it (deboss), or as a body of their own.  Lengths along the cylinder's axis stay as drawn;
// lengths across it become arc lengths (kernel/ops/wrap.ts).
//
// Names: the wrapped solid's faces are `<id>:new#<n>`; the body's faces keep theirs.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { surfaceOf } from "../kernel/ops/cells";
import { combine, type Tool } from "../kernel/ops/combine";
import { thickenSheet } from "../kernel/ops/thicken";
import { wrapRegion } from "../kernel/ops/wrap";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface WrapParams { [key: string]: any; profile: { sketch: string; regions: string[] | null } | null; face: GeomRef | null; result: "emboss" | "deboss" | "new"; depth: number }

export default defineFeature<WrapParams>({
  type: "wrap",
  title: "Wrap",
  hint: "Lay a flat sketch round a cylinder, raised from it or cut into it.",
  keywords: "emboss deboss engrave label cylinder roll text around",
  icon: '<ellipse cx="12" cy="5.5" rx="6.5" ry="2.5"/><path d="M5.5 5.5v13c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-13"/><path class="f" d="M5.5 10.5c2.5 1.6 5.5 1.9 9 1.2v5c-3.5.7-6.5.4-9-1.2z"/><path d="M5.5 10.5c2.5 1.6 5.5 1.9 9 1.2v5c-3.5.7-6.5.4-9-1.2"/>',
  toolbarOrder: 46, toolbarSection: "combine", toolbarKeep: 38,
  defaults: () => ({ profile: null, face: null, result: "emboss", depth: 1 }),
  schema: [
    { key: "result", label: "Result", kind: "enum", options: [{ value: "emboss", label: "Emboss" }, { value: "deboss", label: "Deboss" }, { value: "new", label: "New" }] },
    { key: "profile", label: "Sketch to wrap", kind: "profile" },
    { key: "face", label: "Cylinder", kind: "refs", of: ["face"], single: true, hint: "A cylindrical face. The sketch plane must be parallel to its axis." },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.001, step: 0.5, hint: "How far the wrapped shape stands out of the face, or sinks into it." },
  ],

  evaluate(ctx: EvalContext, p: WrapParams) {
    if (!p.profile || !p.profile.sketch) throw ctx.fail("Pick the sketch to wrap.");
    if (!p.face) throw ctx.fail("Pick the cylindrical face to wrap round.");
    if (!(p.depth > 0)) throw ctx.fail("The depth must be more than zero.");
    const target = ctx.resolve(p.face);
    const s = target.kind === "face" ? surfaceOf(ctx, target.shape) : { kind: "other" as const };
    if (s.kind !== "cylinder") throw ctx.fail("Wrap goes round a cylindrical face. Pick one.");
    const sketch = ctx.sketch(p.profile.sketch);
    const wanted = p.profile.regions;
    const regions = sketch.regions.filter((r) => !wanted || wanted.includes(r.id));
    if (!regions.length) throw ctx.fail("The sketch has no closed region to wrap.");
    if (p.result === "deboss" && p.depth >= s.radius) throw ctx.fail("The depth must be less than the cylinder's radius.");
    const cyl = { origin: s.origin, dir: s.dir, radius: s.radius };
    const tools: Tool[] = regions.map((r) => {
      const face = wrapRegion(ctx, sketch, r, cyl);
      // the wrapped face's normal points away from the axis: out is in front of it, in is behind
      const solid = p.result === "deboss" ? thickenSheet(ctx, [face], 0, p.depth) : thickenSheet(ctx, [face], p.depth, 0);
      return { shape: solid, names: () => null, suffix: r.id };
    });
    if (p.result === "new") { combine(ctx, tools, "new", []); return; }
    combine(ctx, tools, p.result === "deboss" ? "remove" : "add", [target.body.id]);
  },
});

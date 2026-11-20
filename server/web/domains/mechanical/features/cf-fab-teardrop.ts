// cf-fab-teardrop.ts — Teardrop hole: a horizontal hole that prints without support.
//
// A hole goes at every point of the sketch (loose points and circle centres), into the material from the
// sketch's plane.  Its lower part is the round hole; above the 45° tangents the roof runs straight up to a
// point (a teardrop), or is cut off flat at the height of the round hole's top (a truncated teardrop: a short
// bridge, and a bolt still fits).  "Up" is the direction the part is printed in.
// Names: `<id>:<point>:wall` (the round part), `:roof-l`, `:roof-r`, `:flat`, `:end`.
import { defineFeature } from "../core/feature";
import { cross, dot, length, normalize, scale, sub, type Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { combine, scoped, type Tool } from "../kernel/ops/combine";
import { reachPast } from "../kernel/ops/shapes";
import { at, frameAt, positive, prism, sketchPoints, type P2, type Seg } from "../kernel/ops/cf-fab";
import { PRINT } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

const UP: { [id: string]: Vec3 } = { "+z": [0, 0, 1], "-z": [0, 0, -1], "+y": [0, 1, 0], "-y": [0, -1, 0], "+x": [1, 0, 0], "-x": [-1, 0, 0] };

export interface TeardropParams { [key: string]: any; points: { sketch: string; regions: string[] | null } | null; diameter: number; truncated: boolean; up: string; endType: "through" | "blind"; depth: number; flip: boolean; targets: string[] }

export default defineFeature<TeardropParams>({
  type: "cf-fab-teardrop",
  title: "Teardrop hole",
  icon: '<path class="f" d="M3 3h18v18H3z"/><path d="M3 3h18v18H3z"/><path class="s" d="M12 5.5l3.9 4.4a5.5 5.5 0 1 1-7.8 0z"/>',
  hint: "A horizontal hole with a 45° roof that prints without support",
  keywords: "teardrop hole support free horizontal hole 3d print overhang truncated teardrop bridge",
  ...PRINT, toolbarOrder: 40,
  defaults: () => ({ points: null, diameter: 6, truncated: false, up: "+z", endType: "through", depth: 10, flip: false, targets: [] }),
  schema: [
    { key: "points", label: "Sketch with points", kind: "profile", hint: "A hole goes at each loose point and at the centre of each circle." },
    { key: "diameter", label: "Diameter", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "truncated", label: "Flat top", kind: "boolean", hint: "Cut the point off at the height of the round hole's top." },
    { key: "up", label: "Printed upward along", kind: "enum", options: Object.keys(UP).map((u) => ({ value: u, label: `${u[0] === "+" ? "+" : "−"}${u[1].toUpperCase()}` })) },
    { key: "endType", label: "End", kind: "enum", options: [{ value: "through", label: "Through all" }, { value: "blind", label: "Depth" }] },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.01, step: 1, visible: (p) => p.endType === "blind" },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
    { key: "targets", label: "Bodies", kind: "bodies", hint: "Leave empty for every body." },
  ],

  evaluate(ctx: EvalContext, p: TeardropParams) {
    const r = positive(ctx, p.diameter, "diameter") / 2;
    const up = UP[p.up] || UP["+z"];
    const through = p.endType !== "blind";
    if (!through && !(p.depth > 0)) throw ctx.fail("The depth must be more than zero.");
    const { frame, points } = sketchPoints(ctx, p.points, "holes");
    const s = p.flip ? 1 : -1;
    const dir: Vec3 = scale(frame.normal, s);
    // up, seen in the hole's cross-section
    const flatUp = sub(up, scale(dir, dot(up, dir)));
    if (length(flatUp) < 0.2) throw ctx.fail("This hole runs along the print direction: it prints as it is and needs no teardrop. Pick another direction for \"Printed upward along\".");
    const v = normalize(flatUp), u = cross(v, dir);
    const bodies = scoped(ctx, p.targets);
    if (!bodies.length) throw ctx.fail("There is no body to put the holes in.");
    const q = r * Math.SQRT1_2, apex = r * Math.SQRT2;
    const start: P2 = [q, q];
    const segs: Seg[] = [{ to: [-q, q], via: [0, -r], name: "wall" }];
    if (p.truncated) segs.push({ to: [-(apex - r), r], name: "roof-l" }, { to: [apex - r, r], name: "flat" }, { to: [q, q], name: "roof-r" });
    else segs.push({ to: [0, apex], name: "roof-l" }, { to: [q, q], name: "roof-r" });
    const id = ctx.feature.id;
    const tools: Tool[] = points.map((pt) => {
      const o = at(frame, pt.at[0], pt.at[1], 0);
      const depth = through ? reachPast(ctx.k, bodies.map((b) => b.shape), o) : p.depth;
      return { ...prism(ctx, frameAt(o, u, dir), start, segs, 0, depth, `${id}:${pt.id}`), suffix: pt.id };
    });
    combine(ctx, tools, "remove", p.targets);
  },
});

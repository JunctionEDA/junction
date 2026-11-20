// cf-geo-spiral.ts — the Spiral: the coils Helix does not make.
//
//   flat      an Archimedean spiral in a plane: the radius grows by the same amount every turn (a clock
//             spring, a hotplate, a scroll);
//   conical   a helix whose radius changes evenly from one end to the other as it climbs (a conical spring, a
//             tapered thread's path);
//   log       a logarithmic spiral in a plane: the radius grows by the same factor every turn (a snail, a
//             volute).
//
// It winds about an axis from the start radius to the end radius, and can climb along the axis as it goes
// (which the flat kinds usually do not).  The result is a curve (reference geometry, for Sweep and the rest),
// or straight away a coil of round wire.  The curve is a smooth spline through 32 points a turn: the spiral
// itself to within a few millionths of its radius.
//
// Names of a coil: `<id>:outer`, `<id>:start`, `<id>:end`.
import { defineFeature } from "../core/feature";
import { add, cross, scale, type Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { applyTools, pipeAlong } from "../kernel/ops/cf-geo";
import { setCurve, splineThrough } from "../kernel/ops/curves";
import { rotateAbout } from "../kernel/ops/ref-datum";
import { axisOf, frameFromNormal } from "../kernel/ops/ref-geom";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SpiralParams { [key: string]: any; kind: "flat" | "conical" | "log"; axis: RefTarget | null; r0: number; r1: number; turns: number; height: number; start: number; left: boolean; output: "curve" | "solid"; wire: number }

/** The radius and the height at a share s (0 … 1) of the way along a spiral. */
export function spiralAt(kind: string, r0: number, r1: number, height: number, s: number): { r: number; z: number } {
  const r = kind === "log" ? r0 * Math.pow(r1 / r0, s) : r0 + (r1 - r0) * s;
  return { r, z: height * s };
}

export default defineFeature<SpiralParams>({
  type: "cf-geo-spiral",
  title: "Spiral",
  hint: "A flat (Archimedean), conical or logarithmic spiral, as a curve or a coil of wire.",
  keywords: "spiral archimedean conical helix coil spring clock spring volute logarithmic scroll taper spring tapered helix",
  icon: '<path d="M12 12c0-1.200 1.800-1.200 1.800.300 0 2.300-3.900 2.600-4.200-.300-.400-3.700 5.700-4.600 6.600 0 .900 5.200-8.200 6.700-9.300 0-1.100-7 10.600-8.900 12.100 0"/>',
  toolbarOrder: 325, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ kind: "flat", axis: null, r0: 5, r1: 25, turns: 4, height: 0, start: 0, left: false, output: "curve", wire: 2 }),
  schema: [
    { key: "kind", label: "Spiral", kind: "enum", options: [{ value: "flat", label: "Flat" }, { value: "conical", label: "Conical" }, { value: "log", label: "Logarithmic" }] },
    { key: "axis", label: "Axis", kind: "refs", of: ["edge", "face"], single: true, planes: true, datums: ["axis", "plane"], sketch: true, hint: "An axis, a round edge or cylindrical face, or a plane (the spiral lies on it, about its normal)." },
    { key: "r0", label: "Start radius", kind: "number", unit: "mm", min: 0, step: 1 },
    { key: "r1", label: "End radius", kind: "number", unit: "mm", min: 0, step: 1 },
    { key: "turns", label: "Turns", kind: "number", unit: "none", min: 0.05, step: 1 },
    { key: "height", label: "Height", kind: "number", unit: "mm", step: 1, hint: "How far it climbs along the axis from start to end. 0 keeps it flat." },
    { key: "start", label: "Start angle", kind: "number", unit: "deg", step: 15 },
    { key: "left", label: "Left-handed", kind: "boolean" },
    { key: "output", label: "Make", kind: "enum", options: [{ value: "curve", label: "Curve" }, { value: "solid", label: "Coil" }] },
    { key: "wire", label: "Wire diameter", kind: "number", unit: "mm", min: 0.01, step: 0.5, visible: (p) => p.output === "solid" },
  ],

  evaluate(ctx: EvalContext, p: SpiralParams) {
    if (!(p.r0 >= 0) || !(p.r1 >= 0) || (p.r0 === 0 && p.r1 === 0)) throw ctx.fail("The radii cannot be less than zero, nor both zero.");
    if (p.kind === "log" && (!(p.r0 > 0) || !(p.r1 > 0))) throw ctx.fail("A logarithmic spiral needs both radii more than zero: it never reaches its centre.");
    if (!(p.turns > 0) || p.turns > 200) throw ctx.fail("The number of turns must be more than zero (and at most 200).");
    const height = Number(p.height) || 0;
    if (p.r0 === p.r1 && !height) throw ctx.fail("With equal radii and no height the spiral is a circle traced over itself. Change a radius or give it a height.");
    const axis = axisOf(ctx, p.axis, "axis"), f = frameFromNormal(axis.origin, axis.dir);
    const x = rotateAbout(f.x, f.normal, ((Number(p.start) || 0) * Math.PI) / 180), y = cross(f.normal, x);
    const n = Math.min(4000, Math.max(8, Math.ceil(p.turns * 32))), way = p.left ? -1 : 1;
    const pts: Vec3[] = [];
    for (let i = 0; i <= n; i++) {
      const s = i / n, a = way * 2 * Math.PI * p.turns * s, { r, z } = spiralAt(p.kind, p.r0, p.r1, height, s);
      pts.push(add(add(add(axis.origin, scale(x, r * Math.cos(a))), scale(y, r * Math.sin(a))), scale(f.normal, z)));
    }
    const curve = splineThrough(ctx, pts);
    if (p.output !== "solid") { setCurve(ctx, [curve]); return; }
    if (!(p.wire > 0)) throw ctx.fail("The wire's diameter must be more than zero.");
    // coils that touch: the gap between one turn and the next, across and along the axis
    const gap = Math.hypot(Math.abs(p.r1 - p.r0) / p.turns, Math.abs(height) / p.turns);
    if (p.turns > 1 && p.kind !== "log" && gap < p.wire * 0.999) throw ctx.fail(`The wire is thicker than the turns are apart (${gap.toFixed(2)} mm): the coils would run into each other. Use a thinner wire or fewer turns.`);
    const oc = ctx.oc as any;
    const wire = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeWire(oc.TopoDS.Edge(curve))).Wire());
    applyTools(ctx, [pipeAlong(ctx, wire, p.wire / 2, 0)], "new", [], "Coil");
  },
});

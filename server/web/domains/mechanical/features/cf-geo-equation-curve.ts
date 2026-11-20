// cf-geo-equation-curve.ts — the Equation curve: a 3D curve from three expressions of a parameter t, x(t), y(t)
// and z(t) (or r(t), θ(t), z(t) about the frame's normal).  The curve is a smooth spline through the points the
// expressions give at evenly spaced t, closed when it ends where it began.  It is reference geometry of kind
// "curve" (kernel/ops/curves.ts): Sweep, the curve pattern, Tube and the other curve features take it.
//
// Angles in the expressions are radians: one turn is 2*pi.  Lengths are millimetres.
import { defineFeature } from "../core/feature";
import { add, length, scale, sub, type Frame, type Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { setCurve, splineThrough } from "../kernel/ops/curves";
import { planeOf } from "../kernel/ops/ref-geom";
import { compileExpr, type Compiled } from "./_cf-geo";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface EquationCurveParams { [key: string]: any; system: "cartesian" | "cylindrical"; x: string; y: string; z: string; t0: number; t1: number; samples: number; plane: RefTarget | null }

const WORLD: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };

export default defineFeature<EquationCurveParams>({
  type: "cf-geo-equation-curve",
  title: "Equation curve",
  hint: "A 3D curve from equations x(t), y(t), z(t).",
  keywords: "equation driven curve parametric formula function expression x(t) y(t) z(t) math curve lissajous sine wave involute",
  icon: '<path class="t" d="M3 12h18M12 3v18"/><path d="M3 12c2.250-8 4.500-8 6.750 0s4.500 8 6.750 0c1.100-4 2.300-6 4.500-6"/>',
  toolbarOrder: 320, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ system: "cartesian", x: "20*cos(t)", y: "20*sin(t)", z: "5*sin(3*t)", t0: 0, t1: 6.283185307, samples: 120, plane: null }),
  schema: [
    { key: "system", label: "Coordinates", kind: "enum", options: [{ value: "cartesian", label: "x y z" }, { value: "cylindrical", label: "r θ z" }] },
    { key: "x", label: "x(t) or r(t)", kind: "text", hint: "In mm. Use t, numbers, + - * / ^, pi, and sin cos tan sqrt abs exp ln… Angles are radians." },
    { key: "y", label: "y(t) or θ(t)", kind: "text", hint: "In mm; θ in radians." },
    { key: "z", label: "z(t)", kind: "text" },
    { key: "t0", label: "t from", kind: "number", unit: "none", step: 0.5 },
    { key: "t1", label: "t to", kind: "number", unit: "none", step: 0.5 },
    { key: "samples", label: "Points", kind: "number", unit: "none", min: 2, max: 2000, step: 10, hint: "The curve passes through this many points of the equations; more follows them closer." },
    { key: "plane", label: "Frame", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"], hint: "Optional: x and y are measured in this plane from its origin, z along its normal. Empty: the model's own axes." },
  ],

  evaluate(ctx: EvalContext, p: EquationCurveParams) {
    const n = Math.round(Number(p.samples));
    if (!(n >= 2) || n > 2000) throw ctx.fail("The number of points is between 2 and 2000.");
    if (!Number.isFinite(p.t0) || !Number.isFinite(p.t1) || p.t0 === p.t1) throw ctx.fail("The curve needs a range of t: two different numbers.");
    const cyl = p.system === "cylindrical";
    let fx: Compiled, fy: Compiled, fz: Compiled;
    try {
      fx = compileExpr(p.x, ["t"], cyl ? "r(t)" : "x(t)");
      fy = compileExpr(p.y, ["t"], cyl ? "θ(t)" : "y(t)");
      fz = compileExpr(p.z, ["t"], "z(t)");
    } catch (e) { throw ctx.fail((e as Error).message); }
    const f = p.plane ? planeOf(ctx, p.plane, "frame") : WORLD;
    const pts: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const t = p.t0 + ((p.t1 - p.t0) * i) / (n - 1), s = { t };
      let a = fx(s), b = fy(s);
      const c = fz(s);
      if (![a, b, c].every(Number.isFinite)) throw ctx.fail(`The equations have no value at t = ${Number(t.toPrecision(6))} (a division by zero, the root of a negative number).`);
      if (cyl) { const r = a; a = r * Math.cos(b); b = r * Math.sin(b); }
      pts.push(add(add(add(f.origin, scale(f.x, a)), scale(f.y, b)), scale(f.normal, c)));
    }
    let span = 0;
    for (let i = 1; i < n; i++) span += length(sub(pts[i], pts[i - 1]));
    if (!(span > 1e-6)) throw ctx.fail("The equations give one point, not a curve.");
    const closed = n > 3 && length(sub(pts[0], pts[n - 1])) < 1e-7 * Math.max(1, span);
    setCurve(ctx, [splineThrough(ctx, pts, { closed })]);
  },
});

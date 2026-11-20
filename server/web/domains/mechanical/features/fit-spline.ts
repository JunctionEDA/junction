// fit-spline.ts — the Fit spline feature: a smooth 3D curve through picked points (vertices, sketch points,
// reference points, the centres of round edges), in the order picked; closed, or open with its end directions
// optionally set by edges or axes.  The result is reference geometry of kind "curve" (kernel/ops/curves.ts) that
// Sweep, the patterns and the other curve features take.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { axisOf, pointOf } from "../kernel/ops/ref-geom";
import { setCurve, splineThrough } from "../kernel/ops/curves";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FitSplineParams { [key: string]: any; points: RefTarget[]; closed: boolean; startDir: RefTarget | null; endDir: RefTarget | null; flipStart: boolean; flipEnd: boolean }

const DIR = { kind: "refs" as const, of: ["edge" as const, "face" as const], single: true, planes: true, datums: ["axis" as const, "plane" as const], sketch: true };

export default defineFeature<FitSplineParams>({
  type: "fit-spline",
  title: "Fit spline",
  hint: "A smooth 3D curve through picked points, open or closed.",
  keywords: "spline 3d curve through points interpolate path bspline",
  icon: '<path d="M3 17c3-9 6-9 9-5s6 4 9-6"/><circle class="s" cx="3" cy="17" r="2"/><circle class="s" cx="10.2" cy="10.4" r="2"/><circle class="s" cx="16" cy="14.3" r="2"/><circle class="s" cx="21" cy="6" r="2"/>',
  toolbarOrder: 64.1, toolbarSection: "reference", toolbarMenu: "Curve", toolbarKeep: 31,
  defaults: () => ({ points: [], closed: false, startDir: null, endDir: null, flipStart: false, flipEnd: false }),
  schema: [
    { key: "points", label: "Points", kind: "refs", of: ["vertex", "edge"], datums: ["point"], sketch: true, hint: "Vertices, sketch points or reference points, in the order the curve passes them (a round edge gives its centre)." },
    { key: "closed", label: "Closed", kind: "boolean", hint: "Join the last point back to the first, smoothly." },
    { key: "startDir", label: "Start direction", ...DIR, hint: "Optional: an edge, axis or plane normal the curve leaves its first point along.", visible: (p) => !p.closed },
    { key: "flipStart", label: "Flip the start direction", kind: "boolean", visible: (p) => !p.closed && !!p.startDir },
    { key: "endDir", label: "End direction", ...DIR, hint: "Optional: the direction it arrives at its last point.", visible: (p) => !p.closed },
    { key: "flipEnd", label: "Flip the end direction", kind: "boolean", visible: (p) => !p.closed && !!p.endDir },
  ],

  evaluate(ctx: EvalContext, p: FitSplineParams) {
    const picks = Array.isArray(p.points) ? p.points : [];
    if (picks.length < (p.closed ? 3 : 2)) throw ctx.fail(p.closed ? "Pick three or more points for a closed spline." : "Pick two or more points for the spline to pass through.");
    const pts = picks.map((t, i) => pointOf(ctx, t, `point ${i + 1}`));
    const dir = (t: RefTarget | null, flip: boolean) => { if (!t || p.closed) return null; const d = axisOf(ctx, t, "direction").dir; return flip ? [-d[0], -d[1], -d[2]] as [number, number, number] : d; };
    setCurve(ctx, [splineThrough(ctx, pts, { closed: !!p.closed, start: dir(p.startDir, !!p.flipStart), end: dir(p.endDir, !!p.flipEnd) })]);
  },
});

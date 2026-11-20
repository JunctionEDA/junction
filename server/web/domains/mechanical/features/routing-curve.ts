// routing-curve.ts — the Routing curve feature: a 3D path of straight runs through picked points (a pipe, a
// cable, a wire harness), with the corners rounded to a bend radius.  Onshape places the points on a plane
// with a manipulator; here they are picked (vertices, sketch points on any plane, reference points), which
// gives the same kind of multi-plane route.
import { defineFeature } from "../core/feature";
import { add, dot, length, normalize, scale, sub, type Vec3 } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { pointOf } from "../kernel/ops/ref-geom";
import { arcThrough, segment, setCurve } from "../kernel/ops/curves";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RoutingCurveParams { [key: string]: any; points: RefTarget[]; radius: number; closed: boolean }

export default defineFeature<RoutingCurveParams>({
  type: "routing-curve",
  title: "Routing curve",
  hint: "A 3D route of straight runs through points, with bends of a radius at the corners: pipes, cables.",
  keywords: "route pipe tube cable wire harness path polyline bend radius 3d",
  icon: '<path d="M3 20v-6a3 3 0 0 1 3-3h6a3 3 0 0 0 3-3V4h6"/><circle class="s" cx="3" cy="20" r="1.8"/><circle class="s" cx="21" cy="4" r="1.8"/><path class="d t" d="M3 11h3M15 4v4"/>',
  toolbarOrder: 64.8, toolbarSection: "reference", toolbarMenu: "Curve", toolbarKeep: 31,
  defaults: () => ({ points: [], radius: 0, closed: false }),
  schema: [
    { key: "points", label: "Points", kind: "refs", of: ["vertex", "edge"], datums: ["point"], sketch: true, hint: "The route's points in order: vertices, sketch points or reference points." },
    { key: "radius", label: "Bend radius", kind: "number", unit: "mm", min: 0, step: 1, hint: "0 leaves sharp corners." },
    { key: "closed", label: "Closed", kind: "boolean", hint: "Run back from the last point to the first." },
  ],

  evaluate(ctx: EvalContext, p: RoutingCurveParams) {
    const picks = Array.isArray(p.points) ? p.points : [];
    if (picks.length < 2) throw ctx.fail("Pick two or more points for the route.");
    const raw = picks.map((t, i) => pointOf(ctx, t, `point ${i + 1}`));
    const pts: Vec3[] = raw.filter((q, i) => i === 0 || length(sub(q, raw[i - 1])) > 1e-6);
    const closed = !!p.closed && pts.length > 2;
    if (closed && length(sub(pts[0], pts[pts.length - 1])) < 1e-6) pts.pop();
    if (pts.length < 2) throw ctx.fail("The route's points are all in one place.");
    const r = Math.max(0, Number(p.radius) || 0), n = pts.length;
    // each corner: where the bend starts and ends (the corner itself when sharp), and its middle
    const corner = (i: number) => {
      const P = pts[i], A = pts[(i - 1 + n) % n], B = pts[(i + 1) % n];
      const din = normalize(sub(P, A)), dout = normalize(sub(B, P));
      const turn = Math.acos(Math.max(-1, Math.min(1, dot(din, dout))));
      if (r <= 0 || turn < 1e-6) return { a: P, b: P, mid: null as Vec3 | null };
      if (Math.PI - turn < 1e-6) throw ctx.fail(`The route doubles back on itself at point ${i + 1}.`);
      const t = r * Math.tan(turn / 2);
      if (t > length(sub(P, A)) / 2 + 1e-9 || t > length(sub(B, P)) / 2 + 1e-9) throw ctx.fail(`The bend radius is too large for the runs at point ${i + 1}. Try a smaller radius.`);
      const a = sub(P, scale(din, t)), b = add(P, scale(dout, t));
      const bis = normalize(sub(dout, din));
      const centre = add(P, scale(bis, r / Math.cos(turn / 2)));
      return { a, b, mid: sub(centre, scale(bis, r)) };
    };
    const corners = pts.map((_, i) => (closed || (i > 0 && i < n - 1) ? corner(i) : { a: pts[i], b: pts[i], mid: null }));
    const edges: Shape[] = [];
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const c = corners[i], d = corners[(i + 1) % n];
      if (c.mid) edges.push(arcThrough(ctx, c.a, c.mid, c.b));
      if (length(sub(d.a, c.b)) > 1e-6) edges.push(segment(ctx, c.b, d.a));
    }
    if (!closed && corners[n - 1].mid) edges.push(arcThrough(ctx, corners[n - 1].a, corners[n - 1].mid!, corners[n - 1].b));
    setCurve(ctx, edges);
  },
});

// bridging-curve.ts — the Bridging curve feature: a curve that spans the gap between two curves (or points),
// meeting each as Onshape's "Match" asks: in position (a straight line), tangency (a cubic that leaves along
// each curve's direction) or curvature (a quintic that also takes each curve's bend).  The end of each curve
// used is the one nearer the other curve; "magnitude" stretches how far the bridge keeps to each curve's
// direction.  A point (a vertex, a sketch or reference point) can only be met in position.
import { defineFeature } from "../core/feature";
import { add, length, scale, sub, type Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { curveOf, pointOf } from "../kernel/ops/ref-geom";
import { bezierEdge, curveEnd, segment, setCurve } from "../kernel/ops/curves";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BridgingCurveParams { [key: string]: any; start: RefTarget | null; end: RefTarget | null; match: "position" | "tangency" | "curvature"; startMagnitude: number; endMagnitude: number; flipStart: boolean; flipEnd: boolean }

const SIDE = { kind: "refs" as const, of: ["edge" as const, "vertex" as const], single: true, datums: ["curve" as const, "point" as const], sketch: true };

interface Side { at: Vec3; out: Vec3 | null; curvature: Vec3 | null }

/** A picked curve's two ends (or a point, with no direction). */
function endsOf(ctx: EvalContext, t: RefTarget, what: string): Side[] {
  const isPoint = t.kind === "vertex" || (t.kind === "datum" && ctx.datum(t.feature).kind === "point")
    || (t.kind === "sketch" && (ctx.sketch(t.feature).data.entities[t.entity] as any)?.type === "point");
  if (isPoint) return [{ at: pointOf(ctx, t, what), out: null, curvature: null }];
  const c = curveOf(ctx, t, what);
  return [curveEnd(ctx, c, false), curveEnd(ctx, c, true)];
}

export default defineFeature<BridgingCurveParams>({
  type: "bridging-curve",
  title: "Bridging curve",
  hint: "A curve across the gap between two curves, meeting them in position, tangency or curvature.",
  keywords: "bridge connect join gap blend curve tangent curvature g1 g2",
  icon: '<path class="t" d="M2 18c2-1 4-2 5-5"/><path class="t" d="M22 18c-2-1-4-2-5-5"/><path d="M7 13c1.5-6 8.5-6 10 0"/><circle class="s" cx="7" cy="13" r="1.8"/><circle class="s" cx="17" cy="13" r="1.8"/>',
  toolbarOrder: 64.3, toolbarSection: "reference", toolbarMenu: "Curve", toolbarKeep: 55,
  defaults: () => ({ start: null, end: null, match: "tangency", startMagnitude: 1, endMagnitude: 1, flipStart: false, flipEnd: false }),
  schema: [
    { key: "start", label: "Start", ...SIDE, hint: "A curve (its end nearer the other side is used) or a point." },
    { key: "end", label: "End", ...SIDE },
    { key: "match", label: "Match", kind: "enum", options: [{ value: "position", label: "Position" }, { value: "tangency", label: "Tangency" }, { value: "curvature", label: "Curvature" }] },
    { key: "startMagnitude", label: "Start magnitude", kind: "number", unit: "none", min: 0.01, step: 0.1, visible: (p) => p.match !== "position" },
    { key: "endMagnitude", label: "End magnitude", kind: "number", unit: "none", min: 0.01, step: 0.1, visible: (p) => p.match !== "position" },
    { key: "flipStart", label: "Use the start curve's other end", kind: "boolean" },
    { key: "flipEnd", label: "Use the end curve's other end", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: BridgingCurveParams) {
    if (!p.start || !p.end) throw ctx.fail("Pick the two curves (or points) to bridge.");
    const A = endsOf(ctx, p.start, "start"), B = endsOf(ctx, p.end, "end");
    // the pair of ends nearest each other; a flip takes the other end of that side
    let best: [number, number] = [0, 0], d = Infinity;
    for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) { const x = length(sub(A[i].at, B[j].at)); if (x < d - 1e-9) { d = x; best = [i, j]; } }
    const a = A[p.flipStart && A.length > 1 ? 1 - best[0] : best[0]], b = B[p.flipEnd && B.length > 1 ? 1 - best[1] : best[1]];
    const L = length(sub(b.at, a.at));
    if (L < 1e-6) throw ctx.fail("The two ends already meet: there is no gap to bridge.");
    const sa = (Number(p.startMagnitude) > 0 ? Number(p.startMagnitude) : 1) * L, sb = (Number(p.endMagnitude) > 0 ? Number(p.endMagnitude) : 1) * L;
    if (p.match === "position" || (!a.out && !b.out)) { setCurve(ctx, [segment(ctx, a.at, b.at)]); return; }
    if (!a.out || !b.out) {
      // a point can only be met in position: leave the curve along its direction and run on to the point
      ctx.warn("A point can only be met in position.");
      setCurve(ctx, [bezierEdge(ctx, a.out ? [a.at, add(a.at, scale(a.out, sa / 2)), b.at] : [a.at, add(b.at, scale(b.out!, sb / 2)), b.at])]);
      return;
    }
    const match = p.match;
    if (match === "tangency") {
      setCurve(ctx, [bezierEdge(ctx, [a.at, add(a.at, scale(a.out!, sa / 3)), add(b.at, scale(b.out!, sb / 3)), b.at])]);
      return;
    }
    // curvature: a quintic whose first and second derivatives at each end are the curve's (see curves.ts curveEnd)
    const p1 = add(a.at, scale(a.out!, sa / 5)), p4 = add(b.at, scale(b.out!, sb / 5));
    const p2 = add(sub(scale(p1, 2), a.at), scale(a.curvature!, (sa * sa) / 20));
    const p3 = add(sub(scale(p4, 2), b.at), scale(b.curvature!, (sb * sb) / 20));
    setCurve(ctx, [bezierEdge(ctx, [a.at, p1, p2, p3, p4, b.at])]);
  },
});

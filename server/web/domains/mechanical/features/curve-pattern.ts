// curve-pattern.ts — the Curve pattern feature: copies of features or bodies spaced evenly along a path (sketch
// curves, edges, or a reference curve).  The first copy is the original, at the start of the path; the copies
// turn with the path unless "Keep orientation" is on.  Any copy can be skipped.  The copies are placed by
// kernel/ops/pattern-core.ts, as for the other patterns: a copy's faces are `<id>:i<n>.1:<seed face name>`.
import { defineFeature } from "../core/feature";
import { cross, dot, length, normalize, sub, type Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { rotation, skipKeys, translation, type Instance } from "../kernel/ops/pattern-core";
import { alongCurve } from "../kernel/ops/ref-geom";
import { pathWire } from "../kernel/ops/sweep-path";
import { copyDefaults, copyFields, copyInstances, countOf, type CopyParams } from "./_pattern";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CurvePatternParams extends CopyParams { [key: string]: any; path: RefTarget[]; count: number; keepOrientation: boolean; reverse: boolean; skip: string }

export default defineFeature<CurvePatternParams>({
  type: "curve-pattern",
  title: "Curve pattern",
  hint: "Repeat parts or features along a curve.",
  keywords: "array repeat copy along path curve follow",
  icon: '<path class="d t" d="M3 18c3-12 15 0 18-12"/><rect class="f" x="2.5" y="14.5" width="5.5" height="5.5" rx="1"/><rect x="2.5" y="14.5" width="5.5" height="5.5" rx="1"/><rect class="t" x="9.3" y="9.3" width="5.5" height="5.5" rx="1"/><rect class="t" x="16" y="4" width="5.5" height="5.5" rx="1"/>',
  toolbarOrder: 71.5, toolbarSection: "pattern", toolbarMenu: "Pattern", toolbarKeep: 76,
  defaults: () => ({ ...copyDefaults(), path: [], count: 4, keepOrientation: false, reverse: false, skip: "" }),
  schema: [
    ...copyFields("Copy"),
    { key: "path", label: "Path", kind: "refs", of: ["edge"], datums: ["curve"], sketch: true, hint: "A sketch curve (the curves joined to it come too), edges, or a curve. The original is at its start." },
    { key: "count", label: "Count", kind: "number", unit: "none", min: 1, step: 1, hint: "Copies spread evenly from one end of the path to the other, the original included." },
    { key: "keepOrientation", label: "Keep orientation", kind: "boolean", hint: "Do not turn the copies with the path." },
    { key: "reverse", label: "Start from the other end", kind: "boolean" },
    { key: "skip", label: "Skip", kind: "text", hint: "Copies to leave out, counting the original as 1: \"3, 5\"." },
  ],

  evaluate(ctx: EvalContext, p: CurvePatternParams) {
    const n = countOf(ctx, p.count, "count");
    const path = pathWire(ctx, Array.isArray(p.path) ? p.path : []);
    const first = alongCurve(ctx, path, 0), last = alongCurve(ctx, path, 1);
    const closed = length(sub(first.at, last.at)) < 1e-6;
    const skip = skipKeys(p.skip);
    const place = (i: number) => { const f = closed ? i / n : n > 1 ? i / (n - 1) : 0; return alongCurve(ctx, path, p.reverse ? 1 - f : f); };
    const start = place(0), t0 = p.reverse ? scaleNeg(start.tangent) : start.tangent;
    const instances: Instance[] = [];
    for (let i = 1; i < n; i++) {
      const key = `i${i + 1}.1`;
      if (skip.has(key)) continue;
      const here = place(i), t = p.reverse ? scaleNeg(here.tangent) : here.tangent;
      const move = sub(here.at, start.at);
      const axis = cross(t0, t), s = length(axis), c = dot(t0, t);
      if (p.keepOrientation || s < 1e-9) {
        // (a path that doubles back exactly keeps the copy as it is rather than guess which way to turn it over)
        instances.push({ key, trsf: translation(ctx, move) });
      } else instances.push({ key, trsf: rotation(ctx, start.at, normalize(axis), Math.atan2(s, c), move) });
    }
    if (n === 1) ctx.warn("A count of one makes no copies.");
    copyInstances(ctx, p, instances, "pattern");
  },
});

const scaleNeg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];

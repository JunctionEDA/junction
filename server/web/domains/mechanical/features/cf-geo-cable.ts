// cf-geo-cable.ts — the Cable: a wire or cable hung from point to point, sagging between its supports as a
// real one does.  Between two supports it follows the catenary (the curve of a chain under its own weight),
// worked out from the slack (how much longer the cable is than the straight distance) or from the sag (how far
// it hangs below the straight line at most), with gravity along a direction (down, −Z, unless one is picked).
// The result is the cable as a body, or only its centre line as a curve (for Sweep, Tube, a pattern).
//
// Names: `<id>:outer`, `<id>:start`, `<id>:end`.
import { defineFeature } from "../core/feature";
import { length, normalize, scale, sub, type Vec3 } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { applyTools, pipeAlong } from "../kernel/ops/cf-geo";
import { setCurve, splineThrough } from "../kernel/ops/curves";
import { axisOf, pointOf } from "../kernel/ops/ref-geom";
import { catenary, lengthForSag } from "./_cf-geo";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CableParams { [key: string]: any; points: RefTarget[]; by: "slack" | "sag"; slack: number; sag: number; down: RefTarget | null; flip: boolean; output: "solid" | "curve"; diameter: number }

export default defineFeature<CableParams>({
  type: "cf-geo-cable",
  title: "Cable",
  hint: "A wire or cable hung between points, sagging as a real one does (a catenary).",
  keywords: "cable wire routing sag slack catenary hanging rope chain harness hose droop span",
  icon: '<path class="t" d="M4 3v18M20 3v18"/><path d="M4 6c3 9 13 9 16 0"/><circle class="s" cx="4" cy="6" r="1.600"/><circle class="s" cx="20" cy="6" r="1.600"/><path class="d t" d="M4 6h16"/>',
  toolbarOrder: 324, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ points: [], by: "slack", slack: 5, sag: 10, down: null, flip: false, output: "solid", diameter: 4 }),
  schema: [
    { key: "points", label: "Supports", kind: "refs", of: ["vertex", "edge"], datums: ["point"], sketch: true, hint: "Two or more points, in the order the cable passes them: vertices, sketch points, reference points (a round edge gives its centre)." },
    { key: "by", label: "Hangs by", kind: "enum", options: [{ value: "slack", label: "Slack" }, { value: "sag", label: "Sag" }] },
    { key: "slack", label: "Slack", kind: "number", unit: "none", min: 0, step: 1, hint: "Per cent: how much longer each span's cable is than the straight distance between its supports.", visible: (p) => p.by !== "sag" },
    { key: "sag", label: "Sag", kind: "number", unit: "mm", min: 0, step: 1, hint: "How far each span hangs below the straight line between its supports, at most.", visible: (p) => p.by === "sag" },
    { key: "down", label: "Down", kind: "refs", of: ["edge", "face"], single: true, planes: true, datums: ["axis", "plane"], sketch: true, hint: "The way gravity pulls: an edge, an axis, or a plane's normal. Empty: −Z." },
    { key: "flip", label: "Flip down", kind: "boolean", visible: (p) => !!p.down },
    { key: "output", label: "Make", kind: "enum", options: [{ value: "solid", label: "Cable" }, { value: "curve", label: "Curve" }] },
    { key: "diameter", label: "Diameter", kind: "number", unit: "mm", min: 0.01, step: 0.5, visible: (p) => p.output !== "curve" },
  ],

  evaluate(ctx: EvalContext, p: CableParams) {
    const picks = Array.isArray(p.points) ? p.points : [];
    if (picks.length < 2) throw ctx.fail("Pick two or more supports for the cable to hang between.");
    if (picks.length > 200) throw ctx.fail("That is too many supports (at most 200).");
    if (p.by === "sag" ? !(p.sag >= 0) : !(p.slack >= 0) || p.slack > 400) throw ctx.fail(p.by === "sag" ? "The sag cannot be less than zero." : "The slack is between 0 and 400 per cent.");
    const at = picks.map((t, i) => pointOf(ctx, t, `support ${i + 1}`));
    let down: Vec3 = [0, 0, -1];
    if (p.down) { down = normalize(axisOf(ctx, p.down, "down direction").dir); if (!p.flip) down = scale(down, -1); }
    const spans: Shape[] = [];
    let total = 0;
    for (let i = 1; i < at.length; i++) {
      const a = at[i - 1], b = at[i], chord = length(sub(b, a));
      if (chord < 1e-6) throw ctx.fail(`Supports ${i} and ${i + 1} are at the same place.`);
      const len = p.by === "sag" ? lengthForSag(a, b, down, p.sag) : chord * (1 + p.slack / 100);
      total += len;
      spans.push(splineThrough(ctx, catenary(a, b, down, len, 24)));
    }
    if (p.output === "curve") { setCurve(ctx, spans); return; }
    if (!(p.diameter > 0)) throw ctx.fail("The diameter must be more than zero.");
    const oc = ctx.oc as any;
    const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
    for (const e of spans) { mw.Add(oc.TopoDS.Edge(e)); if (!mw.IsDone()) throw ctx.fail("The cable's spans could not be joined."); }
    const cable = pipeAlong(ctx, ctx.own(mw.Wire()), p.diameter / 2, 0);
    applyTools(ctx, [cable], "new", [], `Cable ${Math.round(total * 10) / 10} mm`);
  },
});

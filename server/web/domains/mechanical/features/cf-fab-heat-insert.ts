// cf-fab-heat-insert.ts — Heat-set insert hole: the hole a brass threaded insert is melted into, by thread size.
//
// A hole goes at every point of the sketch (loose points and circle centres), into the material from the
// sketch's plane.  The table gives, for the common knurled inserts for printed parts, the hole's diameter and
// the insert's length; the hole is made deeper by the extra depth so displaced plastic has somewhere to go, and
// gets a small lead-in chamfer that centres the insert on the soldering iron.  Makers differ by a tenth or two:
// check the insert's data sheet and use Custom when it disagrees.  "Screw hole below" carries on with a
// clearance hole for the screw, through everything.
// Names: `<id>:<point>:wall`, `:lead`, `:floor`, `:screw`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { combine, scoped, type Tool } from "../kernel/ops/combine";
import { METRIC } from "../kernel/ops/holes";
import { reachPast } from "../kernel/ops/shapes";
import { at, frameAt, positive, revolve, sketchPoints, type P2 } from "../kernel/ops/cf-fab";
import { PRINT } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Thread → [hole diameter, insert length, least wall round the hole] for common brass heat-set inserts. */
export const HEAT_INSERTS: { [size: string]: [number, number, number] } = {
  M2: [3.2, 4.0, 1.3], "M2.5": [4.0, 5.7, 1.6], M3: [4.0, 5.7, 1.6], M4: [5.6, 8.1, 2.1], M5: [6.4, 9.5, 2.6], M6: [8.0, 12.7, 3.3], M8: [9.7, 12.7, 4.5],
};

export interface HeatInsertParams { [key: string]: any; points: { sketch: string; regions: string[] | null } | null; size: string; diameter: number; length: number; extra: number; chamfer: number; screwHole: boolean; flip: boolean; targets: string[] }

const custom = (p: { [k: string]: any }) => !p.size || p.size === "custom";

export default defineFeature<HeatInsertParams>({
  type: "cf-fab-heat-insert",
  title: "Heat-set insert hole",
  icon: '<path class="f" d="M2 9h20v12H2z"/><path d="M2 9h7v9h6V9h7v12H2z"/><path class="s" d="M9.8 3h4.4v10.5H9.8z"/><path class="t" d="M9.8 5.5h4.4M9.8 8h4.4M9.8 10.5h4.4"/>',
  hint: "The hole for a brass heat-set threaded insert, sized from a table by thread",
  keywords: "heat set insert threaded insert brass knurled hole heat-set 3d print m3 boss melt",
  ...PRINT, toolbarOrder: 20,
  defaults: () => ({ points: null, size: "M3", diameter: 4, length: 5.7, extra: 1, chamfer: 0.4, screwHole: false, flip: false, targets: [] }),
  schema: [
    { key: "points", label: "Sketch with points", kind: "profile", hint: "A hole goes at each loose point and at the centre of each circle." },
    { key: "size", label: "Insert", kind: "enum", options: [{ value: "custom", label: "Custom" }, ...Object.keys(HEAT_INSERTS).map((s) => ({ value: s, label: s }))] },
    { key: "diameter", label: "Hole diameter", kind: "number", unit: "mm", min: 0.1, step: 0.1, visible: custom },
    { key: "length", label: "Insert length", kind: "number", unit: "mm", min: 0.1, step: 0.5, visible: custom },
    { key: "extra", label: "Extra depth", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "Below the insert, for the plastic it pushes out." },
    { key: "chamfer", label: "Lead-in", kind: "number", unit: "mm", min: 0, step: 0.1, hint: "A chamfer at the mouth that centres the insert." },
    { key: "screwHole", label: "Screw hole below", kind: "boolean", hint: "Carry on through with a clearance hole for the screw." },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
    { key: "targets", label: "Bodies", kind: "bodies", hint: "Leave empty for every body." },
  ],

  evaluate(ctx: EvalContext, p: HeatInsertParams) {
    let d: number, len: number;
    if (custom(p)) { d = positive(ctx, p.diameter, "hole diameter"); len = positive(ctx, p.length, "insert length"); }
    else {
      const row = HEAT_INSERTS[p.size];
      if (!row) throw ctx.fail(`The table has no insert for ${p.size}. Pick another size, or Custom.`);
      [d, len] = row;
    }
    const extra = Math.max(0, Number(p.extra) || 0), ch = Math.max(0, Number(p.chamfer) || 0), r = d / 2, depth = len + extra;
    if (ch >= depth) throw ctx.fail("The lead-in is deeper than the hole.");
    const { frame, points } = sketchPoints(ctx, p.points, "holes");
    const bodies = scoped(ctx, p.targets);
    if (!bodies.length) throw ctx.fail("There is no body to put the holes in.");
    const s = p.flip ? 1 : -1;
    const dir: [number, number, number] = [frame.normal[0] * s, frame.normal[1] * s, frame.normal[2] * s];
    // the screw the insert takes, for the hole below it
    const metric = METRIC[p.size as string];
    const screw = p.screwHole ? (metric ? metric.clearance[1] / 2 : r * 0.6) : 0;
    const id = ctx.feature.id;
    const tools: Tool[] = points.map((pt) => {
      const o = at(frame, pt.at[0], pt.at[1], 0);
      const pts: P2[] = [[0, 0], [r + ch, 0], [r, ch], [r, depth]];
      const roles: (string | null)[] = [null, "lead", "wall"];
      if (screw > 0) { const far = reachPast(ctx.k, bodies.map((b) => b.shape), o); pts.push([screw, depth], [screw, far], [0, far]); roles.push("floor", "screw", null, null); }
      else { pts.push([0, depth]); roles.push("floor", null); }
      return { ...revolve(ctx, frameAt(o, frame.x, dir), pts, roles, `${id}:${pt.id}`), suffix: pt.id };
    });
    combine(ctx, tools, "remove", p.targets);
  },
});

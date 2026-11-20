// cf-drive-bearing-seat.ts — Bearing seat: the housing bore for a ball bearing chosen by its number (608,
// 6204, 6805 …; ISO 15 boundary dimensions, _cf-drive-data.ts BEARINGS).  The bore is the bearing's outside
// diameter (plus a fit allowance) and as deep as the bearing is wide; behind it a smaller hole leaves a
// shoulder for the outer ring and lets the shaft through.  It is cut into the bodies under the plane it is put
// on, like a Hole.  "Bearing" also makes a stand-in for the bearing itself (its rings and shields, no balls), as a body in the seat.
//
// Names: `<id>:seat` (the bore's wall), `<id>:shoulder`, `<id>:through`, `<id>:floor`; the bearing's
// `<id>:bearing:outer`, `:bearing:inner` (its bore), `:bearing:outer:front`, `:bearing:shield:front`, …
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { combine, scoped } from "../kernel/ops/combine";
import { revolveOf, type P2 } from "../kernel/ops/cf-drive";
import { reachPast } from "../kernel/ops/shapes";
import { DRIVES, num, placedDefaults, placedFields, SECTION, spaceOf, type Placed } from "./_cf-drive";
import { BEARINGS } from "./_cf-drive-data";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BearingSeatParams extends Placed { [key: string]: any; bearing: string; make: "seat" | "bearing" | "both"; fit: number; extraDepth: number; through: "all" | "blind" | "none"; throughDiameter: number; throughDepth: number; flip: boolean; targets: string[] }

const sorted = Object.keys(BEARINGS).sort((a, b) => BEARINGS[a][0] - BEARINGS[b][0] || BEARINGS[a][1] - BEARINGS[b][1]);

export default defineFeature<BearingSeatParams>({
  type: "cf-bearing-seat",
  title: "Bearing seat",
  icon: '<circle class="f" cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="3.5"/><circle class="s" cx="12" cy="5.8" r="1.4"/><circle class="s" cx="12" cy="18.2" r="1.4"/><circle class="s" cx="5.8" cy="12" r="1.4"/><circle class="s" cx="18.2" cy="12" r="1.4"/>',
  hint: "A housing bore with a shoulder for a ball bearing chosen by its number, and the bearing",
  keywords: "bearing seat bearing bore housing bore ball bearing 608 6204 6001 pocket press fit bearing number",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 44, toolbarKeep: 0,
  defaults: () => ({ bearing: "608", make: "seat", fit: 0, extraDepth: 0, through: "all", throughDiameter: 0, throughDepth: 5, flip: false, targets: [], ...placedDefaults() }),
  schema: [
    { key: "bearing", label: "Bearing", kind: "enum", options: sorted.map((n) => ({ value: n, label: `${n}  (${BEARINGS[n][0]} × ${BEARINGS[n][1]} × ${BEARINGS[n][2]})` })) },
    { key: "make", label: "Make", kind: "enum", options: [{ value: "seat", label: "Seat" }, { value: "both", label: "Seat and bearing" }, { value: "bearing", label: "Bearing" }] },
    { key: "fit", label: "Fit allowance", kind: "number", unit: "mm", min: -0.5, max: 1, step: 0.01, hint: "Added to the bore's diameter: 0 for the nominal size, a little more for a printed part.", visible: (p) => p.make !== "bearing" },
    { key: "extraDepth", label: "Extra depth", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "Sinks the bearing below the surface.", visible: (p) => p.make !== "bearing" },
    { key: "through", label: "Behind the seat", kind: "enum", options: [{ value: "all", label: "Through all" }, { value: "blind", label: "To a depth" }, { value: "none", label: "Closed" }], visible: (p) => p.make !== "bearing" },
    { key: "throughDiameter", label: "Hole behind", kind: "number", unit: "mm", min: 0, step: 1, hint: "0 takes midway between the bearing's bore and outside diameter, which clears the inner ring.", visible: (p) => p.make !== "bearing" && p.through !== "none" },
    { key: "throughDepth", label: "Depth behind", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => p.make !== "bearing" && p.through === "blind" },
    ...placedFields,
    { key: "flip", label: "Opposite direction", kind: "boolean" },
    { key: "targets", label: "Bodies to cut", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.make !== "bearing" },
  ],
  evaluate(ctx: EvalContext, p: BearingSeatParams) {
    const id = ctx.feature.id;
    const size = BEARINGS[p.bearing];
    if (!size) throw ctx.fail("Pick a bearing.");
    const [d, D, B] = size;
    // like a hole, it goes into the material: against the plane's normal
    const up = spaceOf(ctx, p), sp = p.flip ? up : up.rotX(Math.PI);
    const make = p.make === "bearing" || p.make === "both" ? p.make : "seat";
    const sink = make === "bearing" ? 0 : Math.max(0, num(p.extraDepth));
    if (make !== "bearing") {
      const bodies = scoped(ctx, p.targets);
      if (!bodies.length) throw ctx.fail("There is no body to cut the seat into.");
      const R = (D + Math.min(1, Math.max(-0.5, num(p.fit)))) / 2, depth = B + sink;
      const rt = (num(p.throughDiameter) > 0 ? num(p.throughDiameter) : (d + D) / 2) / 2;
      if (p.through !== "none" && !(rt < R - 0.2)) throw ctx.fail(`The hole behind the seat must be smaller than the bearing (${D} mm), to leave a shoulder.`);
      if (p.through !== "none" && rt < d / 2) ctx.warn(`The hole behind the seat is smaller than the bearing's bore (${d} mm): the shaft will not pass.`);
      const pts: P2[] = [[0, -1], [R, -1], [R, depth]], labels = ["mouth", "seat"];
      if (p.through === "none") { pts.push([0, depth]); labels.push("floor", "axis"); }
      else {
        const more = p.through === "blind" ? Math.max(0.1, num(p.throughDepth, 5)) : reachPast(ctx.k, bodies.map((b) => b.shape), sp.o);
        pts.push([rt, depth], [rt, depth + more], [0, depth + more]); labels.push("shoulder", "through", "floor", "axis");
      }
      combine(ctx, [revolveOf(ctx, sp, pts, labels, id)], "remove", p.targets);
    }
    if (make !== "seat") {
      // one turned section: the two rings, and the shields between them set back from the faces
      const ri = d / 2, ro = D / 2, t = Math.max(0.3, (ro - ri) * 0.28), c = Math.min(0.3, t * 0.3), s = B * 0.12, z0 = sink, z1 = sink + B;
      const bearing = revolveOf(ctx, sp,
        [[ri, z0 + c], [ri + c, z0], [ri + t, z0], [ri + t, z0 + s], [ro - t, z0 + s], [ro - t, z0], [ro - c, z0], [ro, z0 + c], [ro, z1 - c], [ro - c, z1], [ro - t, z1], [ro - t, z1 - s], [ri + t, z1 - s], [ri + t, z1], [ri + c, z1], [ri, z1 - c]],
        ["inner:c1", "inner:front", "inner:step1", "shield:front", "outer:step1", "outer:front", "outer:c1", "outer", "outer:c2", "outer:back", "outer:step2", "shield:back", "inner:step2", "inner:back", "inner:c2", "inner"], `${id}:bearing`);
      ctx.addBody(bearing.shape, bearing.names, { suffix: "bearing", name: `Bearing ${p.bearing} (${ctx.feature.name})` });
    }
  },
});

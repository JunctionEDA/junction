// cf-hw-cable-gland.ts — Cable gland hole: the hole a cable gland screws into or passes through, by the gland's
// thread (PG 7 to PG 21, M12 to M40 ×1.5), at each picked point.  A clearance hole takes the gland with its
// locknut behind the wall; a tapped hole is drilled to the thread's tap size for a gland screwed straight into a
// thick wall.  A flat can be left on one side so the gland cannot turn, and a shallow seat sunk for its sealing
// washer.  Or a plain grommet hole of any diameter, with the rubber grommet as a body in it.
//
// Names: `<id>:<point>:wall`, `:flat`, `:seat:…`, and the grommet's `<id>:<point>:grommet:…`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { reachPast } from "../kernel/ops/shapes";
import { apply, circle, extruded, frameAt, poly, prefixAt, revolved, scoped, spots, type Loop, type Tool, type V2 } from "../kernel/ops/cf-hw";
import { cutFields, GLANDS_CABLE, HW_SECTION, MENU_ENCLOSURES, options, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CableGlandParams {
  [key: string]: any;
  kind: "gland" | "grommet"; size: string; hole: "clearance" | "tapped"; clearance: number; flat: boolean; seat: number;
  diameter: number; bore: number; panel: number; body: boolean; targets: string[];
}
const gland = (p: any) => p.kind !== "grommet";

export default defineFeature<CableGlandParams>({
  type: "cf-hw-cable-gland",
  title: "Cable gland hole",
  icon: '<path class="f" d="M3 9h18v6H3z"/><path d="M3 9h18v6H3z"/><path class="f" d="M8.5 4h7v5h-7zM9.5 15h5v5h-5z"/><path d="M8.5 9V4h7v5M9.5 15v5h5v-5M12 4V2M12 20v2"/>',
  hint: "Cut the hole for a cable gland (PG or metric thread) or a rubber grommet",
  keywords: "cable gland grommet hole pg7 pg9 pg11 pg13.5 m12 m16 m20 strain relief wire pass through bushing",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 61, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), kind: "gland", size: "PG9", hole: "clearance", clearance: 0.3, flat: false, seat: 0, diameter: 10, bore: 6, panel: 2, body: true, targets: [] }),
  schema: [
    ...whereFields({ angle: true, flip: "Opposite direction", noun: "hole" }),
    { key: "kind", label: "For", kind: "enum", options: [{ value: "gland", label: "Cable gland" }, { value: "grommet", label: "Grommet" }] },
    { key: "size", label: "Gland thread", kind: "enum", options: options(Object.keys(GLANDS_CABLE)), visible: gland },
    { key: "hole", label: "Hole", kind: "enum", options: [{ value: "clearance", label: "Clearance" }, { value: "tapped", label: "Tapped" }], hint: "Clearance: the gland passes through and a locknut holds it. Tapped: drilled to the tap size.", visible: gland },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, step: 0.1, hint: "Added to the thread's diameter.", visible: (p) => gland(p) && p.hole !== "tapped" },
    { key: "flat", label: "Anti-rotation flat", kind: "boolean", hint: "Leave a flat on one side of the hole (a D hole) for glands that have one.", visible: (p) => gland(p) && p.hole !== "tapped" },
    { key: "seat", label: "Seat depth", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "Sink a flat seat for the gland's hexagon and sealing washer; 0 for none.", visible: gland },
    { key: "diameter", label: "Panel hole Ø", kind: "number", unit: "mm", min: 0.5, step: 1, visible: (p) => !gland(p) },
    { key: "bore", label: "Cable Ø", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => !gland(p) },
    { key: "panel", label: "Panel thickness", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "The width of the grommet's groove.", visible: (p) => !gland(p) },
    { key: "body", label: "Make the grommet", kind: "boolean", visible: (p) => !gland(p) },
    ...cutFields,
  ],

  evaluate(ctx: EvalContext, p: CableGlandParams) {
    const bodies = scoped(ctx, p.targets);
    const cuts: Tool[] = [], made: Tool[] = [];
    const g = GLANDS_CABLE[p.size];
    if (gland(p) && !g) throw ctx.fail(`The gland table has no ${p.size}.`);
    for (const s of spots(ctx, p)) {
      const f = s.frame, prefix = prefixAt(ctx, s);
      const through = reachPast(ctx.k, bodies.map((b) => b.shape), f.origin);
      if (gland(p)) {
        const tapped = p.hole === "tapped";
        const r = (tapped ? g.d - g.pitch : g.d + Math.max(0, Number(p.clearance) || 0)) / 2;
        let outline: Loop = circle([0, 0], r, "wall");
        if (p.flat && !tapped) {
          // a D: the flat a tenth of the diameter in from the round
          const x = r * 0.8, y = Math.sqrt(r * r - x * x);
          outline = { start: [x, y], segs: [{ to: [x, -y], via: [-r, 0], role: "wall" }, { to: [x, y], role: "flat" }] };
        }
        cuts.push({ ...extruded(ctx, f, outline, [], 0.01, -through, prefix), suffix: s.key });
        const seat = Math.max(0, Number(p.seat) || 0);
        if (seat > 0) cuts.push({ ...extruded(ctx, f, circle([0, 0], (g.af / Math.cos(Math.PI / 6) + 2) / 2, "wall"), [], 0.01, -seat - 0.01, `${prefix}:seat`), suffix: `${s.key}.seat` });
      } else {
        const R = Number(p.diameter) / 2, rb = Number(p.bore) / 2, t = Number(p.panel);
        if (!(R > rb + 0.5)) throw ctx.fail("The panel hole must be at least 1 mm wider than the cable.");
        if (!(t > 0)) throw ctx.fail("The panel's thickness must be more than zero.");
        cuts.push({ ...extruded(ctx, f, circle([0, 0], R, "wall"), [], 0.01, -through, prefix), suffix: s.key });
        if (p.body) {
          // a ring with a groove for the panel: a flange each side
          const lip = Math.max(1, 0.25 * R), flange = Math.max(1, 0.6 * t), Ro = R + lip;
          const pts: V2[] = [[rb, flange], [Ro, flange], [Ro, 0], [R, 0], [R, -t], [Ro, -t], [Ro, -t - flange], [rb, -t - flange]];
          made.push({ ...revolved(ctx, frameAt(f), poly(pts, ["top", "outer", "seat", "groove", "seat", "outer", "bottom", "bore"]), `${prefix}:grommet`), suffix: `${s.key}.grommet` });
        }
      }
    }
    apply(ctx, cuts, { operation: "remove", targets: p.targets });
    for (const m of made) ctx.addBody(m.shape, m.names, { suffix: made.length > 1 ? m.suffix : "grommet", name: "Grommet" });
  },
});
